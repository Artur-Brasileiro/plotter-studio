import type { BBox } from "../geometry/path";
import type { Vec } from "../geometry/vec";
import type { GcodeProgram } from "../job/gcode";
import type { MachineProfile } from "../machine";
import type { Clock } from "./clock";
import { alarmText, describeAlarm, describeError, errorText } from "./codes";
import { compareSettings, edgeTarget, frameProgram, jogTo, stepTarget } from "./commands";
import { estimateCurrentLine, programTargets, type ProgramTargets } from "./progress";
import { asciiBytes, FEED_OVERRIDE_BYTES, LineSplitter, parseLine, RT, stateLabel, workPosition, type StatusReport } from "./protocol";
import { CharCountingStreamer, prepareLine, type StreamLine } from "./streamer";
import type { Transport } from "./transport";

export type LinkState = "disconnected" | "opening" | "waitingBanner" | "connected" | "lost";
export type JobState = "none" | "running" | "pausing" | "paused" | "resuming" | "stopping" | "finished" | "stopped" | "failed";
export type Health = "ok" | "slow" | "stuck";

const ACTIVE: readonly JobState[] = ["running", "pausing", "paused", "resuming", "stopping"];
export const isJobActive = (s: JobState): boolean => ACTIVE.includes(s);

export interface JobProgress {
  readonly state: JobState;
  /** linhas enviáveis (sem comentários) */
  readonly total: number;
  readonly acked: number;
  /** índice (em program.lines) da última linha com ok/error */
  readonly lastAckedLine?: number;
  /** índice (em program.lines) da linha que está executando, estimada pela posição */
  readonly currentLine?: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly pausedMs: number;
  readonly pausedAt?: number;
  readonly pauseMode?: "now" | "endOfStroke";
  /** a pausa levantou a caneta com 0x9E */
  readonly penLifted?: boolean;
  readonly error?: { readonly line: number; readonly code: number; readonly text: string };
  /** por que terminou (stopped/failed) */
  readonly message?: string;
}

export interface ControllerSnapshot {
  readonly link: LinkState;
  readonly linkMessage?: string;
  readonly transportLabel: string;
  readonly status?: StatusReport;
  readonly wpos?: Vec;
  readonly wco?: Vec;
  readonly g54?: Vec;
  readonly lastStatusAt?: number;
  /** "slow": 1 s sem relatório; "stuck": 5 s */
  readonly health: Health;
  /** só depois do ok de um $H; volta a false com qualquer alarme ou reinício da placa */
  readonly homed: boolean;
  readonly alarm?: number;
  /** depois de ALARM:1/2 o GRBL só aceita reset */
  readonly needsReset: boolean;
  readonly settings: ReadonlyMap<number, string>;
  readonly settingsWarnings: readonly string[];
  readonly job: JobProgress;
  /** ação manual em andamento (Home, contorno...) */
  readonly busy?: string;
}

export interface LogEntry {
  readonly at: number;
  readonly dir: "in" | "out" | "info" | "error";
  readonly text: string;
  /** relatório de estado (o console esconde por padrão) */
  readonly status?: boolean;
}

export type SendResult = { ok: true } | { ok: false; code: number };

export class GrblCommandError extends Error {
  constructor(
    readonly code: number,
    readonly line: string,
  ) {
    super(`${errorText(code)} em "${line}". ${describeError(code).action}`);
  }
}

export class GrblAlarmError extends Error {
  constructor(readonly code: number) {
    super(`${alarmText(code)}. ${describeAlarm(code).action}`);
  }
}

interface Waiter {
  resolve: (r: SendResult) => void;
  reject: (e: Error) => void;
  text: string;
}

interface StatusWaiter {
  pred: (r: StatusReport) => boolean;
  done: (ok: boolean) => void;
}

const NO_JOB: JobProgress = { state: "none", total: 0, acked: 0, pausedMs: 0 };

const RT_NAMES: Record<number, string> = {
  [RT.HOLD]: "! (pausa)",
  [RT.RESUME]: "~ (continuar)",
  [RT.RESET]: "Ctrl-X (reset)",
  [RT.JOG_CANCEL]: "0x85 (cancela o jog)",
  [RT.SPINDLE_STOP]: "0x9E (caneta na pausa)",
  [RT.FEED_RESET]: "0x90 (velocidade 100%)",
  [RT.FEED_PLUS_10]: "0x91 (velocidade +10%)",
  [RT.FEED_MINUS_10]: "0x92 (velocidade −10%)",
  [RT.FEED_PLUS_1]: "0x93 (velocidade +1%)",
  [RT.FEED_MINUS_1]: "0x94 (velocidade −1%)",
};

const ALLOWED_RT: ReadonlySet<number> = new Set(Object.values(RT));

const RESET_NOT_CONFIRMED =
  "O GRBL NÃO confirmou o reset (nenhum banner em 3 s). Se a máquina ainda estiver andando, desligue a fonte dos motores. Depois desconecte e conecte de novo.";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** O comando como o GRBL o enxerga: sem comentários nem espaços, em maiúsculas ("$h ; home" → "$H"). */
const commandOf = (text: string) =>
  text
    .replace(/\([^)]*\)/g, "")
    .replace(/;.*$/, "")
    .replace(/\s+/g, "")
    .toUpperCase();

/**
 * Linha do programa que o GRBL pode ter pulado (error:N) sem estragar o resto: um ponto do traço (só
 * X/Y: o modo de movimento não muda) ou uma pausa (G4). Qualquer outra muda a caneta ou o modo: sem um
 * "G1 F500", por exemplo, os pontos seguintes sairiam em G0, na velocidade máxima e com a caneta no papel.
 */
const isSkippableLine = (text: string) => /^(?:[XY]|G0*4(?![\d.]))/.test(commandOf(text));

/** $H (ou $HX/$HY/$HZ, se o firmware tiver o homing por eixo). */
const isHomingCommand = (text: string) => /^\$H[XYZ]?$/.test(commandOf(text));

/**
 * "!" ou "~" digitado no console. Com um trabalho em andamento eles têm que passar pela pausa do
 * controlador (que para de mandar linhas e cuida da caneta): mandados crus, o GRBL pausaria ou voltaria
 * a andar por baixo, e a tela continuaria dizendo outra coisa. Um "~" cru numa pausa com a caneta
 * levantada faria a máquina sair andando sem esperar o servo descer.
 */
export function consoleRealtimeAction(char: "?" | "!" | "~", job: JobState): "send" | "pause" | "resume" | "refuse" {
  if (char === "?" || !isJobActive(job)) return "send";
  if (char === "!") return job === "running" ? "pause" : "refuse";
  return job === "paused" ? "resume" : "refuse";
}

/**
 * O que o Esc faz agora (regra do CLAUDE.md): parada de emergência com trabalho ativo ou a máquina
 * andando; num jog, só cancela o jog (0x85). Uma ação manual em andamento (Home, contorno, origem...)
 * também conta como "andando", mesmo que o relatório de estado ainda não mostre: o GRBL não manda
 * relatório durante o homing, e os primeiros 200 ms de qualquer movimento ainda aparecem como Idle.
 */
export function escapeAction(s: ControllerSnapshot): "estop" | "jogCancel" | "none" {
  if (s.link !== "connected") return "none";
  const st = s.status?.state;
  if (isJobActive(s.job.state) || st === "Run" || st === "Home" || st === "Hold") return "estop";
  if (st === "Jog") return "jogCancel";
  return s.busy ? "estop" : "none";
}

/**
 * Conversa com o GRBL (seção 3.7 do PLAN): conexão com espera do banner, leitura de $$/$#, relatório de
 * estado a cada 200 ms, fila com contagem de caracteres, trabalho com pausa (levantando a caneta ou no fim
 * do traço), parada que mantém a posição, parada de emergência, jog e queda do cabo.
 * Nada aqui espera uma promessa que pode nunca resolver: perda de conexão e reset rejeitam tudo o que
 * estava pendente.
 */
export class GrblController {
  private snap: ControllerSnapshot;
  private readonly listeners = new Set<(s: ControllerSnapshot) => void>();
  private readonly logListeners = new Set<(e: LogEntry) => void>();
  private readonly splitter = new LineSplitter();
  private streamer: CharCountingStreamer;
  private readonly waiters = new Map<number, Waiter>();
  private nextManualId = -1;
  private profile: MachineProfile;

  private batch = 0;
  private dirty = false;
  private statusTimer: number | undefined;
  private fastTimer: number | undefined;
  /** quando saiu o "?" mais antigo ainda sem resposta */
  private statusAskedAt: number | undefined;
  private statusWaiters: StatusWaiter[] = [];
  private bannerWaiter: ((ok: boolean) => void) | undefined;
  private expectingBanner = false;
  private settingsAcc = new Map<number, string>();
  private settingsDirty = false;
  private settingsRead = false;
  /**
   * Id (na fila) de um $H que já saiu e ainda não teve resposta. Durante o homing o GRBL não atende o "?"
   * nem o "!": só o reset (limits.c: "Only the abort realtime command can interrupt this process").
   */
  private homingId: number | undefined;
  /** Chegou um ALARM depois do qual o GRBL se reinicia: o banner seguinte não é a placa "reiniciando sozinha" */
  private alarmBanner = false;
  /** RX_BUFFER_SIZE que o próprio firmware informa no $I ([OPT:V,15,128]) */
  private firmwareRxBytes: number | undefined;
  /** Espera do banner depois de um reset de emergência: se não vier, o reset NÃO foi confirmado */
  private resetTimer: number | undefined;

  // trabalho
  private program: GcodeProgram | undefined;
  private targets: ProgramTargets | undefined;
  private jobIds: number[] = [];
  private safeStop: boolean[] = [];
  private lastSentId = -1;
  private sendBlocked = false;
  private sendLimit = Infinity;
  private idleReports = 0;
  private holdSentAt = 0;
  private pauseKind: "holdLift" | "hold" | "endOfStroke" | undefined;
  private pauseTimer: number | undefined;
  private resumeTimer: number | undefined;
  private stopping: Promise<void> | undefined;
  /** O Parar em andamento foi pedido pelo próprio controlador, por um erro que não dá para pular */
  private stopReason: string | undefined;

  // jog
  private jogTarget: Vec | undefined;
  private jogPending = 0;
  private cancelJogOnAck = false;

  constructor(
    private readonly transport: Transport,
    profile: MachineProfile,
    private readonly clock: Clock,
  ) {
    this.profile = profile;
    this.streamer = new CharCountingStreamer({ rxBufferBytes: profile.serial.rxBufferBytes });
    this.snap = {
      link: "disconnected",
      transportLabel: transport.label,
      health: "ok",
      homed: false,
      needsReset: false,
      settings: new Map(),
      settingsWarnings: [],
      job: NO_JOB,
    };
  }

  // ------------------------------------------------------------------ assinaturas
  get snapshot(): ControllerSnapshot {
    return this.snap;
  }

  subscribe(l: (s: ControllerSnapshot) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onLog(l: (e: LogEntry) => void): () => void {
    this.logListeners.add(l);
    return () => this.logListeners.delete(l);
  }

  setProfile(p: MachineProfile): void {
    this.profile = p;
    this.applyRxLimit();
    if (this.settingsRead) this.patch({ settingsWarnings: this.warnings() });
  }

  /** Avisos de configuração: $$ e $# contra o perfil, mais o buffer de recepção que o firmware diz ter. */
  private warnings(): string[] {
    const w = compareSettings(this.snap.settings, this.snap.g54, this.profile);
    const fw = this.firmwareRxBytes;
    const mine = this.profile.serial.rxBufferBytes;
    if (fw !== undefined && fw !== mine) {
      w.push(
        fw < mine
          ? `Este GRBL tem um buffer de recepção de ${fw} bytes ($I), menor que os ${mine} do perfil: o envio passa a respeitar ${fw} (com ${mine} as linhas se perderiam). Corrija em Configurações.`
          : `Este GRBL tem um buffer de recepção de ${fw} bytes ($I), e o perfil diz ${mine}: funciona, só que mais devagar do que poderia.`,
      );
    }
    return w;
  }

  /** A contagem de caracteres nunca usa mais que o menor dos dois: o do perfil e o que o firmware informou. */
  private applyRxLimit(): void {
    this.streamer.setRxBufferBytes(Math.min(this.profile.serial.rxBufferBytes, this.firmwareRxBytes ?? Infinity));
  }

  private patch(p: Partial<ControllerSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    if (this.batch > 0) this.dirty = true;
    else this.emit();
  }

  private patchJob(p: Partial<JobProgress>): void {
    this.patch({ job: { ...this.snap.job, ...p } });
  }

  private emit(): void {
    this.dirty = false;
    for (const l of [...this.listeners]) l(this.snap);
  }

  private log(dir: LogEntry["dir"], text: string, status?: boolean): void {
    if (!this.logListeners.size) return;
    const e: LogEntry = { at: this.clock.now(), dir, text, status };
    for (const l of [...this.logListeners]) l(e);
  }

  // ------------------------------------------------------------------ conexão
  async connect(): Promise<void> {
    const link = this.snap.link;
    if (link === "connected" || link === "opening" || link === "waitingBanner") return;
    this.resetSession();
    this.patch({
      link: "opening",
      linkMessage: undefined,
      status: undefined,
      wpos: undefined,
      wco: undefined,
      g54: undefined,
      lastStatusAt: undefined,
      health: "ok",
      homed: false,
      alarm: undefined,
      needsReset: false,
      settings: new Map(),
      settingsWarnings: [],
      busy: undefined,
      job: NO_JOB,
    });
    this.transport.onData = (c) => this.onData(c);
    this.transport.onClose = (info) => this.onTransportClose(info);
    this.transport.onReadError = (e) =>
      this.log("error", `Erro de leitura na serial (${errMsg(e)}): a porta continua aberta, mas uma resposta do GRBL pode ter se perdido. Se o desenho parar de avançar, use Parar.`);
    try {
      await this.transport.open();
    } catch (e) {
      this.patch({ link: "disconnected", linkMessage: errMsg(e) });
      throw e;
    }
    this.log("info", `Porta aberta (${this.transport.label}). Esperando a placa reiniciar...`);
    this.patch({ link: "waitingBanner" });
    let got = await this.waitBanner(5000);
    if (!got && this.snap.link === "waitingBanner") {
      this.log("info", "Sem resposta em 5 s: mandando reset (Ctrl-X).");
      this.writeBytes(Uint8Array.of(RT.RESET));
      got = await this.waitBanner(3000);
    }
    if (this.snap.link !== "waitingBanner") throw new Error(this.snap.linkMessage ?? "A conexão caiu durante a abertura.");
    if (!got) {
      const msg = "A placa não respondeu (nenhum banner do GRBL em 8 s). Confira o cabo, a porta escolhida e se é mesmo o Arduino da plotter.";
      this.transport.onClose = null;
      await this.transport.close().catch(() => {});
      this.patch({ link: "disconnected", linkMessage: msg });
      throw new Error(msg);
    }
    this.statusAskedAt = undefined;
    this.patch({ link: "connected" });
    this.startStatusPolling();
    await this.readSettings();
  }

  async disconnect(): Promise<void> {
    if (isJobActive(this.snap.job.state)) throw new Error("Pare o trabalho antes de desconectar.");
    if (this.snap.link === "disconnected") return;
    this.stopStatusPolling();
    try {
      await this.transport.close();
    } catch (e) {
      this.log("error", `Erro ao fechar a porta: ${errMsg(e)}`);
    }
    this.onTransportClose({ reason: "user" });
  }

  private resetSession(): void {
    this.splitter.reset();
    this.streamer = new CharCountingStreamer({ rxBufferBytes: this.profile.serial.rxBufferBytes });
    this.waiters.clear();
    this.statusWaiters = [];
    this.expectingBanner = false;
    this.settingsAcc = new Map();
    this.settingsDirty = this.settingsRead = false;
    this.homingId = undefined;
    this.alarmBanner = false;
    this.firmwareRxBytes = undefined;
    this.cancelResetWatch();
    this.clearJobInternals();
    this.jogTarget = undefined;
    this.jogPending = 0;
    this.cancelJogOnAck = false;
  }

  private clearJobInternals(): void {
    this.sendBlocked = false;
    this.sendLimit = Infinity;
    this.pauseKind = undefined;
    this.cancelTimer("pauseTimer");
    this.cancelTimer("resumeTimer");
    this.stopFastPoll();
  }

  private cancelTimer(k: "pauseTimer" | "resumeTimer"): void {
    const id = this[k];
    if (id !== undefined) this.clock.clearTimeout(id);
    this[k] = undefined;
  }

  private onTransportClose(info: { reason: "user" | "lost"; error?: unknown }): void {
    if (this.snap.link === "disconnected" || this.snap.link === "lost") return;
    this.stopStatusPolling();
    this.clearJobInternals();
    this.bannerWaiter?.(false);
    for (const w of [...this.statusWaiters]) w.done(false);
    this.streamer.clear();
    this.homingId = undefined;
    this.cancelResetWatch();
    this.rejectWaiters(new Error("A conexão com a máquina foi fechada."));
    const job = this.snap.job;
    if (info.reason === "user") {
      this.patch({ link: "disconnected", linkMessage: undefined, busy: undefined, status: undefined, health: "ok" });
      this.log("info", "Desconectado.");
    } else {
      const msg = "A conexão com a máquina caiu (cabo solto, placa desligada ou o PC suspendeu a USB).";
      this.log("error", `${msg}${info.error ? ` (${errMsg(info.error)})` : ""}`);
      this.patch({ link: "lost", linkMessage: msg, homed: false, busy: undefined });
    }
    if (isJobActive(job.state)) {
      this.patchJob({
        state: "failed",
        endedAt: this.clock.now(),
        message:
          info.reason === "user"
            ? "Desconectado no meio do trabalho."
            : `Conexão perdida na linha ${job.acked} de ${job.total}. Se a placa continuou ligada, ela terminou os ~15 movimentos que já tinha e parou, e a caneta pode ter ficado no papel. Reconecte: a placa vai reiniciar (a caneta sobe) e pedir Home.`,
      });
    }
  }

  private waitBanner(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.bannerWaiter?.(false);
      const timer = this.clock.setTimeout(() => done(false), ms);
      const done = (ok: boolean) => {
        this.clock.clearTimeout(timer);
        if (this.bannerWaiter === done) this.bannerWaiter = undefined;
        resolve(ok);
      };
      this.bannerWaiter = done;
    });
  }

  private waitStatus(pred: (r: StatusReport) => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const w: StatusWaiter = {
        pred,
        done: (ok) => {
          this.clock.clearTimeout(timer);
          this.statusWaiters = this.statusWaiters.filter((x) => x !== w);
          resolve(ok);
        },
      };
      const timer = this.clock.setTimeout(() => w.done(false), ms);
      this.statusWaiters.push(w);
    });
  }

  /** Dois relatórios Idle seguidos (um só pode ser de antes do movimento começar). */
  private waitIdle(ms: number): Promise<boolean> {
    let n = 0;
    return this.waitStatus((r) => (r.state === "Idle" ? ++n >= 2 : ((n = 0), false)), ms);
  }

  /** Espera o movimento manual acabar; um alarme no meio vira erro (e não "terminou"). */
  private async waitMotionEnd(): Promise<void> {
    const idle = await this.waitIdle(120_000);
    if (!idle && this.snap.alarm !== undefined) throw new GrblAlarmError(this.snap.alarm);
  }

  private async readSettings(): Promise<void> {
    try {
      await this.send("$$");
      await this.send("$#");
      await this.send("$I"); // [OPT:V,15,128]: o tamanho real do buffer de recepção
    } catch (e) {
      this.log("error", `Não consegui ler a configuração: ${errMsg(e)}`);
    }
    if (this.snap.link !== "connected") return;
    this.settingsRead = true;
    const settingsWarnings = this.warnings();
    this.patch({ settingsWarnings });
    for (const w of settingsWarnings) this.log("info", `Aviso: ${w}`);
  }

  // ------------------------------------------------------------------ status
  private startStatusPolling(): void {
    this.stopStatusPolling();
    this.statusTimer = this.clock.setInterval(() => this.pollTick(), this.profile.serial.statusIntervalMs);
    this.requestStatus();
  }

  private stopStatusPolling(): void {
    if (this.statusTimer !== undefined) this.clock.clearInterval(this.statusTimer);
    this.statusTimer = undefined;
    this.stopFastPoll();
  }

  private startFastPoll(): void {
    if (this.fastTimer === undefined) this.fastTimer = this.clock.setInterval(() => this.requestStatus(), 50);
  }

  private stopFastPoll(): void {
    if (this.fastTimer !== undefined) this.clock.clearInterval(this.fastTimer);
    this.fastTimer = undefined;
  }

  /**
   * A saúde é medida pelo "?" mais antigo ainda sem resposta (e não pelo último relatório): com a aba em
   * segundo plano o Chrome segura os timers, os "?" saem raramente, e isso não é a placa travada.
   */
  private pollTick(): void {
    if (this.silent()) this.statusAskedAt = undefined;
    const age = this.statusAskedAt === undefined ? 0 : this.clock.now() - this.statusAskedAt;
    const health: Health = age > 5000 ? "stuck" : age > 1000 ? "slow" : "ok";
    if (health !== this.snap.health) {
      this.patch({ health });
      if (health === "slow") this.log("error", "A máquina não responde há mais de 1 s.");
      if (health === "stuck") this.log("error", "A placa parece travada (5 s sem resposta). A conexão continua aberta.");
    }
    this.requestStatus();
  }

  private requestStatus(): void {
    if (this.snap.link !== "connected") return;
    // o "?" sai assim mesmo (o relatório volta mais cedo quando o silêncio acabar): só não conta como falta de resposta
    if (!this.silent()) this.statusAskedAt ??= this.clock.now();
    this.writeBytes(Uint8Array.of(RT.STATUS));
  }

  /**
   * O GRBL não responde ao "?" em dois casos (wiki "Grbl v1.1 Interface"; limits.c e protocol.c): durante
   * o homing e depois de um alarme crítico (ALARM:1/2), até o reset. Nesses períodos o silêncio não é a
   * placa travada.
   */
  private silent(): boolean {
    return this.homingId !== undefined || this.snap.needsReset;
  }

  /** O $H saiu: daqui até o ok (ou o alarme) o estado é Home, e o GRBL não vai dizer isso sozinho. */
  private beginHoming(id: number): void {
    this.homingId = id;
    this.statusAskedAt = undefined;
    const st = this.snap.status;
    this.patch({ health: "ok", status: { ...(st ?? { pins: "" }), state: "Home", subState: undefined, feed: 0 } });
  }

  // ------------------------------------------------------------------ leitura
  private onData(chunk: Uint8Array): void {
    this.batch++;
    try {
      for (const line of this.splitter.push(chunk)) this.onLine(line);
    } finally {
      this.batch--;
      if (this.batch === 0 && this.dirty) this.emit();
    }
  }

  private onLine(line: string): void {
    const m = parseLine(line);
    switch (m.type) {
      case "status":
        this.log("in", line, true);
        this.onStatus(m.report);
        return;
      case "ok":
        this.onAck(undefined);
        return;
      case "error":
        this.onAck(m.code);
        return;
      case "alarm":
        this.onAlarm(m.code);
        return;
      case "banner":
        this.log("in", line);
        this.onBanner();
        return;
      case "msg":
        this.log("in", line);
        if (m.text === "Reset to continue") this.patch({ needsReset: true });
        return;
      case "feedback":
        this.log("in", line);
        if (m.tag === "G54") {
          const [x, y] = m.body.split(",").map(Number);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            this.patch({ g54: { x, y } });
            if (this.settingsRead) this.patch({ settingsWarnings: this.warnings() });
          }
        } else if (m.tag === "OPT") {
          // [OPT:<opções>,<blocos do planejador>,<RX_BUFFER_SIZE>] (report_build_info)
          const rx = Number(m.body.split(",")[2]);
          if (Number.isInteger(rx) && rx >= 16) {
            this.firmwareRxBytes = rx;
            this.applyRxLimit();
            if (this.settingsRead) this.patch({ settingsWarnings: this.warnings() });
          }
        }
        return;
      case "setting":
        this.log("in", line);
        this.settingsAcc.set(m.id, m.value);
        this.settingsDirty = true;
        return;
      default:
        this.log("in", line);
    }
  }

  private onStatus(report: StatusReport): void {
    // Durante o homing o GRBL não gera relatório: o que chegar agora saiu antes de o $H começar (um "?"
    // que cruzou com ele) e diria Alarm/Idle com a máquina já andando. O estado continua Home.
    const r: StatusReport = this.homingId !== undefined && report.state !== "Home" ? { ...report, state: "Home", subState: undefined } : report;
    const wco = r.wco ?? this.snap.wco;
    const wpos = workPosition(r, wco);
    this.statusAskedAt = undefined;
    // como o WCO, o Ov só vem de tempos em tempos: guarda o último
    const prevOv = this.snap.status?.overrides;
    this.patch({
      status: r.overrides || !prevOv ? r : { ...r, overrides: prevOv },
      wco,
      wpos,
      lastStatusAt: this.clock.now(),
      health: "ok",
      homed: r.state === "Alarm" ? false : this.snap.homed,
    });
    if (r.state === "Idle" && this.jogPending === 0) this.jogTarget = undefined;
    for (const w of [...this.statusWaiters]) if (w.pred(r)) w.done(true);
    this.updateJobFromStatus(r, wpos);
  }

  private onAck(code: number | undefined): void {
    if (this.settingsDirty) {
      this.settingsDirty = false;
      this.patch({ settings: new Map(this.settingsAcc) });
      if (this.settingsRead) this.patch({ settingsWarnings: this.warnings() });
    }
    const a = this.streamer.acknowledge();
    if (!a) {
      this.log("in", code === undefined ? "ok" : errorText(code)); // resposta atrasada de antes de um reset
      return;
    }
    if (a.id < 0) {
      const w = this.waiters.get(a.id);
      this.waiters.delete(a.id);
      if (a.id === this.homingId) {
        this.homingId = undefined;
        this.statusAskedAt = undefined;
      }
      if (code === undefined) {
        this.log("in", "ok");
        // $H/$X também valem quando digitados no console
        const cmd = w ? commandOf(w.text) : "";
        if (cmd === "$H") this.patch({ homed: true, alarm: undefined });
        else if (cmd === "$X") this.patch({ alarm: undefined });
      } else this.log("error", `${errorText(code)} em "${w?.text ?? "?"}". ${describeError(code).action}`);
      w?.resolve(code === undefined ? { ok: true } : { ok: false, code });
    } else {
      this.idleReports = 0;
      this.patchJob({ acked: this.snap.job.acked + 1, lastAckedLine: a.id });
      if (code !== undefined) {
        const text = this.program?.lines[a.id]?.text ?? "";
        this.log("error", `${errorText(code)} na linha ${a.id + 1} do programa: "${text}". ${describeError(code).action}`);
        const error = { line: a.id, code, text };
        const st = this.snap.job.state;
        if (st !== "stopping" && !isSkippableLine(text)) this.abortOnError(error);
        else if (st === "running" || (st === "pausing" && this.pauseKind === "endOfStroke")) {
          this.beginHoldPause(this.profile.pen.pauseLift === "spindleStop", error);
        } else if (!this.snap.job.error) this.patchJob({ error });
      }
    }
    this.pump();
  }

  /**
   * O GRBL recusou uma linha que não dá para pular (caneta, deslocamento, modo de movimento). "Continuar
   * mesmo assim" estragaria o desenho, então o trabalho para sozinho, do jeito que mantém a posição.
   */
  private abortOnError(error: NonNullable<JobProgress["error"]>): void {
    this.patchJob({ error: this.snap.job.error ?? error });
    this.stopReason = `${errorText(error.code)} na linha ${error.line + 1} ("${error.text}"). Essa linha muda a caneta ou o modo de movimento, e sem ela o resto sairia errado (por exemplo, um traço inteiro em G0). O trabalho foi parado: a caneta subiu e a posição foi mantida.`;
    this.log("error", "Linha recusada não pode ser pulada: parando o trabalho.");
    void this.stop();
  }

  private onAlarm(code: number): void {
    const info = describeAlarm(code);
    this.log("error", `${alarmText(code)}. ${info.action}`);
    this.streamer.clear();
    this.homingId = undefined;
    this.statusAskedAt = undefined;
    // ALARM:4/5 (sonda) deixam o GRBL rodando; nos outros ele se reinicia (ou espera o nosso reset) e manda o banner
    this.alarmBanner = code !== 4 && code !== 5;
    this.rejectWaiters(new GrblAlarmError(code));
    for (const w of [...this.statusWaiters]) w.done(false);
    // o alarme é a palavra final sobre o estado: depois de um ALARM:1/2 o GRBL nem responde mais ao "?"
    const st = this.snap.status;
    this.patch({
      homed: false,
      alarm: code,
      busy: undefined,
      needsReset: code === 1 || code === 2 ? true : this.snap.needsReset,
      status: st ? { ...st, state: "Alarm", subState: undefined, feed: 0 } : undefined,
    });
    const job = this.snap.job;
    if (isJobActive(job.state) && job.state !== "stopping") {
      this.clearJobInternals();
      this.patchJob({ state: "failed", endedAt: this.clock.now(), message: `${alarmText(code)}. ${info.action}` });
    }
  }

  private onBanner(): void {
    if (this.snap.link === "waitingBanner") {
      this.bannerWaiter?.(true);
      return;
    }
    this.homingId = undefined;
    this.statusAskedAt = undefined;
    const afterAlarm = this.alarmBanner;
    this.alarmBanner = false;
    if (this.expectingBanner) {
      this.expectingBanner = false;
      this.cancelResetWatch();
      this.streamer.clear();
      this.rejectWaiters(new Error("Comando descartado pelo reset."));
      this.patch({ needsReset: false });
      this.bannerWaiter?.(true);
      this.pump();
      return;
    }
    if (afterAlarm) this.log("info", "O GRBL se reiniciou depois do alarme (é o esperado): está em Alarm até o Home.");
    else this.log("error", "A placa reiniciou sozinha (o GRBL mandou o banner sem ninguém pedir).");
    this.streamer.clear();
    this.rejectWaiters(new Error("A placa reiniciou."));
    this.patch({ homed: false, needsReset: false, busy: undefined });
    const job = this.snap.job;
    if (isJobActive(job.state)) {
      this.clearJobInternals();
      this.patchJob({
        state: "failed",
        endedAt: this.clock.now(),
        message: "A placa reiniciou no meio do desenho (queda de energia ou mau contato na USB?). A caneta subiu e a posição foi perdida: faça o Home antes de continuar.",
      });
    }
  }

  private rejectWaiters(err: Error): void {
    const ws = [...this.waiters.values()];
    this.waiters.clear();
    for (const w of ws) w.reject(err);
  }

  // ------------------------------------------------------------------ escrita
  private writeBytes(b: Uint8Array): void {
    this.transport.write(b).catch((e) => {
      const l = this.snap.link;
      if (l === "connected" || l === "waitingBanner") this.onTransportClose({ reason: "lost", error: e });
    });
  }

  private pump(): void {
    if (this.snap.link !== "connected" || this.sendBlocked || this.expectingBanner) return;
    const lines = this.streamer.takeSendable(this.sendLimit);
    if (!lines.length) return;
    let text = "";
    for (const l of lines) {
      text += l.text + "\n";
      if (l.id < 0) {
        this.log("out", l.text);
        if (isHomingCommand(l.text)) this.beginHoming(l.id);
      } else this.lastSentId = l.id;
    }
    this.writeBytes(asciiBytes(text));
  }

  /**
   * Comando de tempo real (fura a fila). Só passam os que o aplicativo usa (lista RT). Overrides de
   * spindle (0x99–0x9D) mexem no servo; e os outros bytes que o GRBL entende também não têm o que fazer
   * aqui: 0x84 (porta de segurança) suspende a máquina num estado que a tela não trata, 0xA0/0xA1 ligam
   * os pinos de refrigeração, 0x95–0x97 mudam a velocidade do G0.
   */
  realtime(byte: number): void {
    if (byte >= 0x99 && byte <= 0x9d) throw new Error("Override de spindle muda a posição do servo da caneta: proibido.");
    if (!ALLOWED_RT.has(byte)) throw new Error(`Byte de tempo real 0x${byte.toString(16)} não é usado pelo Plotter Studio: recusado.`);
    if (this.snap.link !== "connected") return;
    this.writeBytes(Uint8Array.of(byte));
    if (byte !== RT.STATUS) this.log("out", `[tempo real] ${RT_NAMES[byte] ?? `0x${byte.toString(16)}`}`);
  }

  /** Uma linha pela fila contada. `manual`: veio do console (comentários vão como estão). */
  send(line: string, opts: { manual?: boolean } = {}): Promise<SendResult> {
    if (this.snap.link !== "connected") return Promise.reject(new Error("A máquina não está conectada."));
    if (isJobActive(this.snap.job.state)) return Promise.reject(new Error("Há um trabalho em andamento: pare ou espere terminar."));
    let text: string | null;
    try {
      text = prepareLine(line, { keepComments: opts.manual });
    } catch (e) {
      return Promise.reject(e);
    }
    if (text === null) return Promise.resolve({ ok: true });
    const t = text;
    const id = this.nextManualId--;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject, text: t });
      this.streamer.enqueue([{ text: t, id }]);
      this.pump();
    });
  }

  private async sendOk(line: string): Promise<void> {
    const r = await this.send(line);
    if (!r.ok) throw new GrblCommandError(r.code, line);
  }

  private async withBusy(label: string, fn: () => Promise<void>): Promise<void> {
    if (this.snap.link !== "connected") throw new Error("A máquina não está conectada.");
    if (this.snap.busy) throw new Error(`Espere terminar: ${this.snap.busy}.`);
    if (isJobActive(this.snap.job.state)) throw new Error("Há um trabalho em andamento.");
    this.patch({ busy: label });
    try {
      await fn();
    } finally {
      this.patch({ busy: undefined });
    }
  }

  private dwell(): string {
    return `G4 P${Math.round(this.profile.pen.settleSeconds * 1000) / 1000}`;
  }

  // ------------------------------------------------------------------ comandos manuais
  async home(): Promise<void> {
    if (this.snap.needsReset) await this.softResetAndWait();
    await this.withBusy("Home", async () => {
      await this.sendOk("$H");
      this.patch({ homed: true, alarm: undefined });
    });
  }

  async unlock(): Promise<void> {
    await this.withBusy("Desbloqueio", async () => {
      await this.sendOk("$X");
      this.patch({ alarm: undefined });
    });
  }

  async penUp(): Promise<void> {
    await this.withBusy("Caneta", async () => {
      await this.sendOk(this.profile.pen.upCmd);
      await this.sendOk(this.dwell());
    });
  }

  async penDown(): Promise<void> {
    await this.withBusy("Caneta", async () => {
      await this.sendOk(this.profile.pen.downCmd);
      await this.sendOk(this.dwell());
    });
  }

  /** Levanta a caneta e vai para (0,0) por jog (cancelável com Parar). */
  async goToOrigin(feed = 6000): Promise<void> {
    // sem Home o GRBL não sabe onde a máquina está: "ir para (0,0)" pode ser andar 810 mm contra o fim do curso
    if (!this.snap.homed) throw new Error("Faça o Home antes: sem ele a posição não é confiável.");
    await this.withBusy("Indo para a origem", async () => {
      await this.sendOk(this.profile.pen.upCmd);
      await this.sendOk(this.dwell());
      this.jogPending++;
      try {
        await this.sendOk(jogTo({ x: 0, y: 0 }, feed));
      } finally {
        this.jogDone();
      }
      await this.waitMotionEnd();
    });
  }

  /** Contorno do desenho com a caneta levantada. Exige Home (a posição tem que ser confiável). */
  async frame(bbox: BBox): Promise<void> {
    if (!this.snap.homed) throw new Error("Faça o Home antes do contorno.");
    await this.withBusy("Contorno", async () => {
      const lines = frameProgram(bbox, this.profile);
      const results = await Promise.all(lines.map((l) => this.send(l)));
      const bad = results.findIndex((r) => !r.ok);
      if (bad >= 0) {
        const r = results[bad] as { ok: false; code: number };
        throw new GrblCommandError(r.code, lines[bad]);
      }
      await this.waitMotionEnd();
    });
  }

  /** Reset (0x18). Com a máquina andando, o GRBL responde ALARM:3 e exige Home. */
  softReset(): void {
    this.emergencyStop("Reset pedido pelo usuário.");
  }

  private async softResetAndWait(): Promise<void> {
    this.softReset();
    await this.waitBanner(3000);
  }

  feedOverride(cmd: number): void {
    if (!FEED_OVERRIDE_BYTES.includes(cmd)) throw new Error("Só os overrides de velocidade (0x90–0x94) são permitidos.");
    this.realtime(cmd);
  }

  // ------------------------------------------------------------------ jog
  private jogDone(): void {
    this.jogPending--;
    if (this.jogPending === 0 && this.cancelJogOnAck) {
      this.cancelJogOnAck = false;
      this.realtime(RT.JOG_CANCEL);
    }
  }

  private checkJogAllowed(): Vec {
    if (this.snap.link !== "connected") throw new Error("A máquina não está conectada.");
    if (isJobActive(this.snap.job.state)) throw new Error("Há um trabalho em andamento.");
    const p = this.snap.wpos;
    if (!p) throw new Error("Ainda não sei a posição da máquina.");
    return p;
  }

  /** Passo de jog: destino absoluto, calculado a partir do destino anterior e limitado à área. */
  async jogStep(d: Vec, feed: number): Promise<void> {
    const pos = this.checkJogAllowed();
    const base = this.jogTarget ?? pos;
    const target = stepTarget(base, d, this.profile.workArea, 0.5);
    if (Math.abs(target.x - base.x) < 0.005 && Math.abs(target.y - base.y) < 0.005) return;
    this.jogTarget = target;
    this.jogPending++;
    try {
      const r = await this.send(jogTo(target, feed));
      if (!r.ok) {
        this.jogTarget = undefined;
        throw new GrblCommandError(r.code, jogTo(target, feed));
      }
    } finally {
      this.jogDone();
    }
  }

  /** Segurar a tecla: um só $J até a borda da área; jogStop() manda 0x85. */
  jogContinuous(dir: Vec, feed: number): void {
    if (!this.snap.homed) throw new Error("O jog contínuo vai até a borda da área: faça o Home antes (sem ele a borda pode estar em qualquer lugar).");
    const base = this.checkJogAllowed();
    const target = edgeTarget(base, dir, this.profile.workArea, 0.5);
    if (Math.abs(target.x - base.x) < 0.005 && Math.abs(target.y - base.y) < 0.005) return;
    this.jogTarget = target;
    this.jogPending++;
    this.send(jogTo(target, feed))
      .then((r) => {
        if (!r.ok) this.jogTarget = undefined;
      })
      .catch(() => (this.jogTarget = undefined))
      .finally(() => this.jogDone());
  }

  jogStop(): void {
    if (this.snap.link !== "connected") return;
    this.realtime(RT.JOG_CANCEL);
    if (this.jogPending > 0) this.cancelJogOnAck = true; // o $J ainda não tinha entrado: cancela de novo depois
    this.jogTarget = undefined;
  }

  // ------------------------------------------------------------------ trabalho
  /** O que impede começar agora (lista vazia = pode). */
  jobProblems(program?: GcodeProgram): string[] {
    const s = this.snap;
    if (s.link !== "connected") return ["Conecte a máquina."];
    const p: string[] = [];
    if (isJobActive(s.job.state)) p.push("Já há um trabalho em andamento.");
    if (s.busy) p.push(`Espere terminar: ${s.busy}.`);
    if (s.needsReset) p.push("O GRBL está travado esperando um reset: clique em Reset e depois em Home.");
    if (!s.homed) p.push("Faça o Home antes de desenhar: sem ele a posição não é confiável e o soft limit não protege.");
    const st = s.status;
    if (!st) p.push("Ainda não recebi o estado da máquina.");
    else if (st.state !== "Idle" && !(st.state === "Alarm" && !s.homed)) p.push(`A máquina está em ${stateLabel(st)}: espere ficar Idle.`);
    const wco = s.wco ?? s.g54;
    const ex = { x: -this.profile.workArea.width, y: -this.profile.workArea.height };
    if (!wco) p.push("Ainda não sei a origem de trabalho (WCO). Espere um instante.");
    else if (Math.abs(wco.x - ex.x) > 0.01 || Math.abs(wco.y - ex.y) > 0.01) {
      p.push(`A origem de trabalho está em (${wco.x}, ${wco.y}), mas o esperado é (${ex.x}, ${ex.y}). Os desenhos sairiam no lugar errado. Confira com $#.`);
    }
    if (program && program.lines.length === 0) p.push("O programa está vazio.");
    return p;
  }

  startJob(program: GcodeProgram): void {
    const problems = this.jobProblems(program);
    if (problems.length) throw new Error(problems.join("\n"));
    const items: StreamLine[] = [];
    program.lines.forEach((l, i) => {
      const t = prepareLine(l.text);
      if (t !== null) items.push({ text: t, id: i });
    });
    if (!items.length) throw new Error("O programa está vazio.");
    this.program = program;
    this.targets = programTargets(program);
    this.jobIds = items.map((it) => it.id);
    this.safeStop = this.computeSafeStops(items, program.lines.length);
    this.clearJobInternals();
    this.lastSentId = -1;
    this.idleReports = 0;
    this.streamer.enqueue(items);
    this.patch({ job: { state: "running", total: items.length, acked: 0, startedAt: this.clock.now(), pausedMs: 0 } });
    this.log("info", `Trabalho iniciado: ${items.length} linhas.`);
    this.pump();
  }

  /** safe[i]: depois da linha i a caneta está em cima e o servo já assentou (o G4 depois do M5 rodou). */
  private computeSafeStops(items: readonly StreamLine[], n: number): boolean[] {
    const up = prepareLine(this.profile.pen.upCmd);
    const down = prepareLine(this.profile.pen.downCmd);
    const safe = new Array<boolean>(n).fill(false);
    let pen: "settled" | "unsettled" | "down" = "settled";
    for (const it of items) {
      if (it.text === up) pen = "unsettled";
      else if (it.text === down) pen = "down";
      else if (/^G0*4(?![\d.])/i.test(it.text) && pen === "unsettled") pen = "settled";
      safe[it.id] = pen === "settled";
    }
    return safe;
  }

  pause(): void {
    if (this.snap.job.state !== "running") return;
    if (this.profile.pen.pauseLift === "spindleStop") this.beginHoldPause(true);
    else this.beginStrokePause();
  }

  /** "!" agora; quando chegar Hold:0, 0x9E levanta a caneta (se `lift`). */
  private beginHoldPause(lift: boolean, error?: JobProgress["error"]): void {
    this.sendBlocked = true;
    this.cancelTimer("resumeTimer");
    this.realtime(RT.HOLD);
    this.holdSentAt = this.clock.now();
    this.pauseKind = lift ? "holdLift" : "hold";
    const job = this.snap.job;
    this.patchJob({ state: "pausing", pauseMode: "now", error: error ?? job.error, pausedAt: job.pausedAt ?? this.clock.now() });
    this.startFastPoll();
    this.cancelTimer("pauseTimer");
    this.pauseTimer = this.clock.setTimeout(() => {
      this.pauseTimer = undefined;
      if (this.snap.job.state === "pausing") {
        this.log("error", "A máquina não confirmou a pausa (Hold:0) em 10 s.");
        this.finishHoldPause(false);
      }
    }, 10_000);
  }

  private finishHoldPause(sawHold0: boolean): void {
    this.cancelTimer("pauseTimer");
    this.stopFastPoll();
    let penLifted = false;
    if (this.pauseKind === "holdLift" && sawHold0) {
      this.realtime(RT.SPINDLE_STOP);
      penLifted = true;
    }
    this.patchJob({ state: "paused", penLifted });
  }

  /** Continua mandando até a caneta subir (M5 + G4) e para ali. */
  private beginStrokePause(): void {
    this.pauseKind = "endOfStroke";
    let limit: number | undefined;
    if (this.lastSentId < 0) limit = -1;
    else {
      for (const id of this.jobIds) {
        if (id >= this.lastSentId && this.safeStop[id]) {
          limit = id;
          break;
        }
      }
    }
    this.sendLimit = limit ?? Infinity;
    this.idleReports = 0;
    this.patchJob({ state: "pausing", pauseMode: "endOfStroke", pausedAt: this.clock.now() });
    this.pump();
  }

  resume(): void {
    const job = this.snap.job;
    if (job.state !== "paused") return;
    if (this.pauseKind === "endOfStroke") {
      this.sendLimit = Infinity;
      this.sendBlocked = false;
      this.patchJob({ ...this.resumedFields(), state: "running" });
      this.pump();
      return;
    }
    if (job.penLifted) {
      // com o hold ativo, o 0x9E só religa a caneta; o "~" vem depois do servo assentar
      this.realtime(RT.SPINDLE_STOP);
      this.patchJob({ state: "resuming" });
      this.resumeTimer = this.clock.setTimeout(() => {
        this.resumeTimer = undefined;
        this.doResume();
      }, (this.profile.pen.settleSeconds + 0.2) * 1000);
    } else this.doResume();
  }

  private resumedFields(): Partial<JobProgress> {
    const job = this.snap.job;
    return { pausedMs: job.pausedMs + (this.clock.now() - (job.pausedAt ?? this.clock.now())), pausedAt: undefined, error: undefined, penLifted: undefined, pauseMode: undefined };
  }

  private doResume(): void {
    if (this.snap.link !== "connected" || !isJobActive(this.snap.job.state)) return;
    this.realtime(RT.RESUME);
    this.sendBlocked = false;
    this.patchJob({ ...this.resumedFields(), state: "running" });
    this.pump();
  }

  /** Parar mantendo a posição: "!" → espera Hold:0 → reset. O reset executa M5 (a caneta sobe). */
  stop(): Promise<void> {
    if (this.snap.link !== "connected") return Promise.resolve();
    if (!this.stopping) {
      this.stopping = this.doStop().finally(() => {
        this.stopping = undefined;
        this.stopReason = undefined;
      });
    }
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    if (this.homingId !== undefined) {
      // no homing o "!" é ignorado e não há relatório para esperar: só o reset para a máquina
      this.log("info", "Home interrompido com reset (durante o homing o GRBL só aceita o reset). Vem um ALARM:6: refaça o Home.");
      this.emergencyStop();
      await this.waitBanner(3000);
      return;
    }
    const wasActive = isJobActive(this.snap.job.state);
    this.sendBlocked = true;
    this.streamer.clearQueued();
    this.cancelTimer("resumeTimer");
    this.cancelTimer("pauseTimer");
    if (wasActive) this.patchJob({ state: "stopping" });
    if (!this.inAlarm()) {
      this.realtime(RT.HOLD);
      this.holdSentAt = this.clock.now();
      this.startFastPoll();
      const stopped = await this.waitStatus(
        (r) => (r.state === "Hold" && r.subState === 0) || r.state === "Alarm" || (r.state === "Idle" && this.clock.now() - this.holdSentAt >= 100),
        10_000,
      );
      this.stopFastPoll();
      if (this.snap.link !== "connected") return;
      // um alarme no meio da espera também é "parou": segue para o reset (o GRBL já parou ou está se reiniciando)
      if (!stopped && !this.inAlarm()) {
        this.log("error", "A máquina não parou em 10 s: parada de emergência.");
        this.emergencyStop("A máquina não confirmou a parada em 10 s; foi feita uma parada de emergência. Faça o Home.");
        return;
      }
    }
    this.expectReset();
    this.realtime(RT.RESET);
    const ok = await this.waitBanner(3000);
    if (!ok) this.log("error", RESET_NOT_CONFIRMED);
    this.sendBlocked = false;
    if (wasActive && this.snap.job.state === "stopping") {
      const why = this.stopReason;
      this.patchJob({
        state: why === undefined ? "stopped" : "failed",
        endedAt: this.clock.now(),
        currentLine: undefined,
        message: !ok
          ? RESET_NOT_CONFIRMED
          : this.snap.alarm !== undefined
            ? `Parado, mas o GRBL entrou em alarme (${alarmText(this.snap.alarm)}): faça o Home antes de continuar.`
            : (why ?? "Parado. A caneta subiu e a posição foi mantida: dá para usar \"Ir para a origem\" sem refazer o Home."),
      });
    }
  }

  private inAlarm(): boolean {
    return this.snap.status?.state === "Alarm";
  }

  private expectReset(): void {
    this.expectingBanner = true;
    this.homingId = undefined;
    this.streamer.clear();
    this.rejectWaiters(new Error("Comando descartado pelo reset."));
  }

  /** Reset imediato (Esc / botão vermelho). Com a máquina andando: ALARM:3 e Home obrigatório. */
  emergencyStop(message?: string): void {
    if (this.snap.link !== "connected") return;
    this.expectReset();
    this.realtime(RT.RESET);
    this.clearJobInternals();
    this.jogTarget = undefined;
    for (const w of [...this.statusWaiters]) w.done(false);
    if (isJobActive(this.snap.job.state)) {
      this.patchJob({
        state: "stopped",
        endedAt: this.clock.now(),
        currentLine: undefined,
        message: message ?? "Parada de emergência. Se a máquina estava andando, a posição se perdeu: faça o Home.",
      });
    }
    this.watchReset();
  }

  /**
   * O GRBL sempre responde a um reset com o banner, em milissegundos. Se ele não vier, a parada de
   * emergência NÃO foi confirmada (placa travada, sem energia, cabo ruim) e isso tem que aparecer.
   */
  private watchReset(): void {
    this.cancelResetWatch();
    this.resetTimer = this.clock.setTimeout(() => {
      this.resetTimer = undefined;
      if (!this.expectingBanner || this.snap.link !== "connected") return;
      this.log("error", RESET_NOT_CONFIRMED);
      if (this.snap.job.state === "stopped") this.patchJob({ message: RESET_NOT_CONFIRMED });
    }, 3000);
  }

  private cancelResetWatch(): void {
    if (this.resetTimer !== undefined) this.clock.clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
  }

  private updateJobFromStatus(r: StatusReport, wpos: Vec | undefined): void {
    const job = this.snap.job;
    if (!isJobActive(job.state)) return;
    if (this.targets && wpos && job.lastAckedLine !== undefined) {
      const cur = estimateCurrentLine(this.targets, job.lastAckedLine, wpos, job.currentLine ?? 0);
      if (cur !== undefined && cur !== job.currentLine) this.patchJob({ currentLine: cur });
    }
    if (job.state === "pausing" && this.pauseKind !== "endOfStroke") {
      if (r.state === "Hold" && r.subState === 0) this.finishHoldPause(true);
      return;
    }
    this.idleReports = r.state === "Idle" ? this.idleReports + 1 : 0;
    const drained = this.streamer.pendingCount === 0;
    if (job.state === "pausing" && this.pauseKind === "endOfStroke" && drained && this.sendLimit !== Infinity && this.lastSentId >= this.sendLimit && this.idleReports >= 2) {
      this.patchJob({ state: "paused", penLifted: false });
      return;
    }
    if ((job.state === "running" || job.state === "pausing") && job.acked === job.total && drained && this.idleReports >= 2) {
      this.clearJobInternals();
      this.patchJob({ state: "finished", endedAt: this.clock.now(), currentLine: undefined });
      this.log("info", "Trabalho concluído.");
    }
  }
}
