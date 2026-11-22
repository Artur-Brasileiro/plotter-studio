import type { Vec } from "../geometry/vec";
import type { Clock } from "./clock";
import { asciiBytes, RT, type MachineState } from "./protocol";
import type { Transport } from "./transport";

export interface FakeGrblOptions {
  workArea: { width: number; height: number };
  /** 128 no Uno */
  rxBufferBytes?: number;
  /** 15 no Uno */
  plannerBlocks?: number;
  /** tempo do reinício do Uno ao abrir a porta (DTR) */
  bootDelayMs?: number;
  homingMs?: number;
  /** $27: depois do Home a máquina fica afastada da chave */
  homingPulloffMm?: number;
  tickMs?: number;
  /** >1 acelera os movimentos e as pausas (simulador na interface) */
  timeScale?: number;
  maxRateMmMin?: number;
  /** false simula um fork que não levanta a caneta com 0x9E na pausa */
  spindleStopInHold?: boolean;
  /** sobrescreve valores do $$ (ex.: { 32: "1" }, { 10: "0" } para relatórios em WPos) */
  settings?: Record<number, string>;
  faults?: {
    /** a k-ésima linha de G-code recebida (1 = primeira) responde error:code */
    errorAtLine?: { line: number; code: number };
    /** o cabo "sai" logo depois de receber a k-ésima linha de G-code */
    disconnectAfterLines?: number;
    /** a placa nunca responde (nem ao 0x18) */
    noBanner?: boolean;
    /** o $H falha com este alarme (8 = não se afastou da chave, 9 = não achou a chave) */
    homingAlarm?: number;
  };
}

interface Block {
  from: Vec;
  to: Vec;
  len: number;
  done: number;
  feed: number;
  rapid: boolean;
  jog: boolean;
}

/** Uma linha de G-code já conferida (nada aqui mexe no estado: a linha pode ter que esperar). */
interface ParsedBlock {
  motion?: 0 | 1 | 80;
  dwell: boolean;
  absolute?: boolean;
  spindle?: boolean;
  coolant?: boolean;
  flow?: 0 | 1 | 2 | 30;
  f?: number;
  s?: number;
  p?: number;
  x?: number;
  y?: number;
}

const BANNER = "Grbl 1.1h ['$' for help]";
const LOCKED = "[MSG:'$H'|'$X' to unlock]";
/** LINE_BUFFER_SIZE do GRBL: 80, com o terminador (protocol.h) */
const LINE_MAX_CHARS = 79;
/** G4: o GRBL conta a pausa em passos de 50 ms, arredondando para cima (DWELL_TIME_STEP, nuts_bolts.c) */
const DWELL_STEP_MS = 50;
/** De quantos em quantos relatórios o WCO e o Ov voltam (config.h): parado e em movimento */
const WCO_REFRESH = { idle: 10, busy: 30 };
const OVR_REFRESH = { idle: 10, busy: 20 };

function defaultSettings(o: Required<Pick<FakeGrblOptions, "workArea" | "maxRateMmMin" | "homingPulloffMm">>): Record<number, string> {
  const f = (n: number) => n.toFixed(3);
  return {
    0: "10", 1: "25", 2: "0", 3: "0", 4: "0", 5: "0", 6: "0", 10: "1", 11: "0.010", 12: "0.002", 13: "0",
    20: "1", 21: "0", 22: "1", 23: "0", 24: "25.000", 25: "500.000", 26: "250", 27: f(o.homingPulloffMm),
    30: "1000", 31: "0", 32: "0", 100: "80.000", 101: "80.000", 102: "250.000",
    110: f(o.maxRateMmMin), 111: f(o.maxRateMmMin), 112: "500.000", 120: "800.000", 121: "800.000", 122: "10.000",
    130: f(o.workArea.width), 131: f(o.workArea.height), 132: "200.000",
  };
}

/**
 * GRBL 1.1h falso, determinístico (com ManualClock), que implementa o Transport.
 * Conferido com o fonte do gnea/grbl v1.1h (protocol.c, gcode.c, system.c, motion_control.c, report.c,
 * limits.c) e com o fork vankesteren/grbl-servo (spindle_control.c). Modela o que importa para o envio:
 * - buffer de recepção de 128 bytes (estouro = rxOverflow) e planejador de 15 blocos (o "ok" sai quando a
 *   linha entra nele);
 * - G-code modal: G0/G1 valem para as linhas seguintes só com X/Y; "G1 F500" sozinho só muda o modo;
 * - M3/M5 (quando mudam o estado), G4 e M2 esperam o planejador esvaziar; M2 volta para G1/G90/M5 e
 *   override de 100%, e avisa [MSG:Pgm End];
 * - comandos de tempo real (?, !, ~, 0x18, 0x85, 0x9E, overrides), $H/$X/$$/$#/$J e soft limits;
 * - os silêncios do GRBL: nenhum relatório durante o homing nem depois de um ALARM:2 (até o reset);
 * - o "ok" atrasado da linha que estava executando quando chega um reset.
 * Movimento em velocidade constante (sem aceleração): basta para a ordem e o tempo.
 * Não modelado (responde error:20): arcos, eixo Z, polegadas, G10/G28/G92, G4 junto com movimento.
 */
export class FakeGrbl implements Transport {
  readonly label = "Simulador";
  onData: ((chunk: Uint8Array) => void) | null = null;
  onClose: ((info: { reason: "user" | "lost"; error?: unknown }) => void) | null = null;

  // --- inspeção para testes
  /** o que a caneta desenhou, em WPos (uma descida sem movimento vira um traço de 1 ponto) */
  readonly penStrokes: Vec[][] = [];
  maxRxUsed = 0;
  rxOverflow = false;
  linesExecuted = 0;
  /** linhas consumidas do buffer, na ordem */
  readonly received: string[] = [];
  /** bytes de tempo real recebidos (menos o "?"), com o estado da máquina naquele instante */
  readonly rtLog: { byte: number; at: number; state: string }[] = [];
  /** overrides de spindle (0x99–0x9D) recebidos: nunca deveriam chegar */
  readonly forbiddenBytes: number[] = [];
  /** quantos "?" chegaram e quantos relatórios saíram (o GRBL não responde a todos) */
  statusQueries = 0;
  statusReports = 0;

  private readonly o: Required<Omit<FakeGrblOptions, "settings" | "faults">> & Pick<FakeGrblOptions, "faults">;
  private readonly wco: Vec;
  private settings: Map<number, string>;

  private opened = false;
  private cut = false;
  private frozen = false;
  private booted = false;
  private rx = "";
  private planner: Block[] = [];
  private st: MachineState = "Alarm";
  private holdSub = 0;
  private holdLeftMs = 0;
  private homingLeftMs = 0;
  private dwellLeftMs = 0;
  /** a linha da frente já está "executando" (esperando vaga no planejador ou ele esvaziar) */
  private waitingLine = false;
  /** M0: em Hold até o "~"; só então sai o ok */
  private m0Wait = false;
  /** ALARM:1/2: o GRBL fica num laço morto até o reset (não responde nem ao "?") */
  private critical = false;
  /** chegou "?" durante o homing: sai um relatório só, no fim */
  private statusQueued = false;
  private spindleOn = false;
  private spindleS = 0;
  private coolantOn = false;
  /** parada do spindle (0x9E) durante o Hold: pedida / ativa */
  private stopOvr: "off" | "initiate" | "enabled" = "off";
  private absolute = true;
  private motionMode: 0 | 1 | 80 = 0;
  private feed = 0;
  private feedOv = 100;
  private curFeed = 0;
  private w: Vec;
  private wcoCounter = 0;
  private ovrCounter = 0;
  private gcodeLines = 0;
  private tickTimer: number | undefined;
  private lastTick = 0;
  private outbox: string[] = [];
  private flushTimer: number | undefined;

  constructor(
    private readonly clock: Clock,
    opts: FakeGrblOptions,
  ) {
    this.o = {
      workArea: opts.workArea,
      rxBufferBytes: opts.rxBufferBytes ?? 128,
      plannerBlocks: opts.plannerBlocks ?? 15,
      bootDelayMs: opts.bootDelayMs ?? 1500,
      homingMs: opts.homingMs ?? 2000,
      homingPulloffMm: opts.homingPulloffMm ?? 1,
      tickMs: opts.tickMs ?? 10,
      timeScale: opts.timeScale ?? 1,
      maxRateMmMin: opts.maxRateMmMin ?? 12000,
      spindleStopInHold: opts.spindleStopInHold ?? true,
      faults: opts.faults,
    };
    this.wco = { x: -opts.workArea.width, y: -opts.workArea.height };
    this.w = { x: opts.workArea.width, y: opts.workArea.height };
    this.settings = new Map(Object.entries({ ...defaultSettings(this.o), ...opts.settings }).map(([k, v]) => [Number(k), v]));
  }

  // --- estado visível nos testes
  get state(): MachineState {
    return this.st;
  }
  get stateText(): string {
    return this.st === "Hold" ? `Hold:${this.holdSub}` : this.st;
  }
  get wpos(): Vec {
    return this.w;
  }
  /** S0 também é "em cima": no fork do servo o pulso de S0 é o mesmo do M5 */
  get penDown(): boolean {
    return this.spindleOn && this.spindleS > 0 && this.stopOvr !== "enabled";
  }
  get feedOverride(): number {
    return this.feedOv;
  }
  get plannerLength(): number {
    return this.planner.length;
  }
  get cableCut(): boolean {
    return this.cut;
  }
  get gcodeLinesReceived(): number {
    return this.gcodeLines;
  }
  /** "G0" / "G1" / "G80": o modo de movimento que vale para uma linha só com X/Y */
  get modalMotion(): string {
    return `G${this.motionMode}`;
  }
  /** um G4 está contando */
  get dwelling(): boolean {
    return this.dwellLeftMs > 0;
  }

  /** Simula a placa travar: a porta continua aberta, mas nada mais é respondido. */
  freeze(): void {
    this.frozen = true;
  }

  /** Simula puxar o cabo USB. */
  unplug(): void {
    if (this.opened && !this.cut) this.cutCable();
  }

  /** Simula a placa reiniciar sozinha (queda de energia, DTR): banner de novo, Alarm, posição perdida. */
  powerGlitch(): void {
    if (!this.opened || this.cut) return;
    this.booted = false;
    this.powerUp();
    this.clock.setTimeout(() => {
      if (!this.opened || this.cut) return;
      this.booted = true;
      this.emit("", BANNER, LOCKED);
    }, this.o.bootDelayMs);
  }

  // --- Transport
  async open(): Promise<void> {
    if (this.opened) throw new Error("InvalidStateError: The port is already open.");
    this.opened = true;
    this.cut = false;
    this.frozen = false;
    this.booted = false;
    this.powerUp();
    this.lastTick = this.clock.now();
    this.tickTimer = this.clock.setInterval(() => this.tick(), this.o.tickMs);
    if (!this.o.faults?.noBanner) {
      this.clock.setTimeout(() => {
        if (!this.opened || this.cut) return;
        this.booted = true;
        this.emit("", BANNER, LOCKED);
      }, this.o.bootDelayMs);
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.opened || this.cut) throw new Error("NetworkError: The device has been lost.");
    for (const b of bytes) this.receiveByte(b);
    this.process();
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    this.stopTimers();
    if (!this.cut) this.onClose?.({ reason: "user" });
  }

  // --- interno
  private stopTimers() {
    if (this.tickTimer !== undefined) this.clock.clearInterval(this.tickTimer);
    if (this.flushTimer !== undefined) this.clock.clearTimeout(this.flushTimer);
    this.tickTimer = this.flushTimer = undefined;
    this.outbox = [];
  }

  /** Liga do zero (energia ou DTR): a RAM zera, então a posição de máquina volta a (0,0) = WPos (largura, altura do curso). */
  private powerUp() {
    this.reinit("Alarm");
    this.w = { x: this.o.workArea.width, y: this.o.workArea.height };
  }

  /**
   * O que o main() do GRBL refaz a cada reset: buffers, planejador, parser (G0, G90, F0, S0, M5),
   * overrides em 100% e contadores do relatório. A posição fica.
   */
  private reinit(state: "Alarm" | "Idle") {
    this.setPen(() => {
      this.spindleOn = false; // o reset desliga o spindle: a caneta sobe
      this.spindleS = 0;
      this.stopOvr = "off";
    });
    this.rx = "";
    this.planner = [];
    this.holdSub = 0;
    this.homingLeftMs = this.dwellLeftMs = 0;
    this.waitingLine = this.m0Wait = this.critical = this.statusQueued = this.coolantOn = false;
    this.absolute = true;
    this.motionMode = 0;
    this.feed = 0;
    this.feedOv = 100;
    this.curFeed = 0;
    this.wcoCounter = this.ovrCounter = 0;
    this.st = state;
  }

  private cutCable() {
    this.cut = true;
    this.clock.setTimeout(() => {
      this.opened = false;
      this.stopTimers();
      this.onClose?.({ reason: "lost", error: new Error("NetworkError: The device has been lost.") });
    }, 0);
  }

  private emit(...lines: string[]) {
    this.outbox.push(...lines);
    if (this.flushTimer === undefined) {
      this.flushTimer = this.clock.setTimeout(() => {
        this.flushTimer = undefined;
        const text = this.outbox.map((l) => l + "\r\n").join("");
        this.outbox = [];
        if (this.opened && !this.cut && text) this.onData?.(asciiBytes(text));
      }, 0);
    }
  }

  /** serial.c, ISR(SERIAL_RX): "?", "!", "~", 0x18 e tudo acima de 0x7F saem do fluxo, em qualquer lugar da linha. */
  private receiveByte(b: number) {
    if (!this.booted || this.frozen) return; // bootloader do Uno (ou placa travada): descarta
    if (b >= 0x80 || b === RT.STATUS || b === RT.HOLD || b === RT.RESUME || b === RT.RESET) {
      this.realtime(b);
      return;
    }
    if (this.rx.length >= this.o.rxBufferBytes) {
      this.rxOverflow = true; // o GRBL de verdade perderia este byte
      return;
    }
    this.rx += String.fromCharCode(b);
    if (this.rx.length > this.maxRxUsed) this.maxRxUsed = this.rx.length;
  }

  private realtime(b: number) {
    if (b !== RT.STATUS) this.rtLog.push({ byte: b, at: this.clock.now(), state: this.stateText });
    if (b === RT.RESET) {
      this.softReset();
      return;
    }
    if (b === RT.STATUS) {
      this.statusQueries++;
      // limits_go_home() não chama protocol_execute_realtime(): durante o homing o GRBL não responde.
      if (this.st === "Home") this.statusQueued = true;
      else if (!this.critical) this.sendStatus();
      return;
    }
    if (this.critical) return; // laço morto do alarme crítico: só o reset sai dele
    switch (b) {
      case RT.HOLD:
        if (this.st === "Run") {
          this.st = "Hold";
          this.holdSub = 1;
          this.holdLeftMs = 100;
        } else if (this.st === "Jog") {
          this.planner = [];
          this.st = "Idle";
        } else if (this.st === "Idle") {
          this.st = "Hold"; // inclusive no meio de um G4: a pausa para de contar
          this.holdSub = 0;
        }
        break;
      case RT.RESUME:
        if (this.st === "Hold" && this.holdSub === 0) {
          // com a caneta "parada" pelo 0x9E, o GRBL religa e já sai andando (por isso o controlador
          // manda o 0x9E antes e espera o servo)
          if (this.stopOvr === "enabled") this.restoreSpindle();
          this.stopOvr = "off";
          this.st = this.planner.length ? "Run" : "Idle";
          if (this.m0Wait) {
            this.m0Wait = false;
            this.reply("ok");
          }
        }
        break;
      case RT.JOG_CANCEL:
        if (this.st === "Jog") {
          this.planner = [];
          this.st = "Idle";
        }
        break;
      case RT.SPINDLE_STOP:
        // protocol_exec_rt_system(): só em Hold; pedido uma vez, vale quando o Hold completa
        if (this.st !== "Hold") break;
        if (this.stopOvr === "off") {
          this.stopOvr = "initiate";
          if (this.holdSub === 0) this.applySpindleStop();
        } else if (this.stopOvr === "enabled") {
          this.restoreSpindle();
          this.stopOvr = "off";
        }
        break;
      case RT.FEED_RESET:
        this.setFeedOverride(100);
        break;
      case RT.FEED_PLUS_10:
      case RT.FEED_MINUS_10:
      case RT.FEED_PLUS_1:
      case RT.FEED_MINUS_1: {
        const d = { [RT.FEED_PLUS_10]: 10, [RT.FEED_MINUS_10]: -10, [RT.FEED_PLUS_1]: 1, [RT.FEED_MINUS_1]: -1 }[b] ?? 0;
        this.setFeedOverride(Math.min(200, Math.max(10, this.feedOv + d)));
        break;
      }
      default:
        if (b >= 0x99 && b <= 0x9d) this.forbiddenBytes.push(b);
    }
  }

  private setFeedOverride(v: number) {
    if (v === this.feedOv) return;
    this.feedOv = v;
    this.ovrCounter = 0; // o GRBL mostra o Ov no relatório seguinte
  }

  private sendStatus() {
    this.statusReports++;
    this.emit(this.statusReport());
  }

  /**
   * report_realtime_status(): MPos (ou WPos, se o bit 0 do $10 estiver zerado), Bf (bit 1 do $10), FS,
   * e os campos que só vêm de vez em quando: WCO a cada 10 relatórios parado / 30 em movimento, e o Ov
   * (com o A: dos acessórios) no relatório seguinte ao do WCO, a cada 10 / 20, ou quando muda.
   */
  private statusReport(): string {
    const mask = Number(this.settings.get(10) ?? "1");
    const pos = (mask & 1) === 1 ? `MPos:${(this.w.x + this.wco.x).toFixed(3)},${(this.w.y + this.wco.y).toFixed(3)},0.000` : `WPos:${this.w.x.toFixed(3)},${this.w.y.toFixed(3)},0.000`;
    const fields = [this.stateText, pos];
    if (mask & 2) fields.push(`Bf:${this.o.plannerBlocks - this.planner.length},${this.o.rxBufferBytes - this.rx.length}`);
    fields.push(`FS:${Math.round(this.curFeed)},${this.penDown ? this.spindleS : 0}`);
    const busy = this.st === "Home" || this.st === "Run" || this.st === "Hold" || this.st === "Jog" || this.st === "Door";
    if (this.wcoCounter > 0) this.wcoCounter--;
    else {
      this.wcoCounter = (busy ? WCO_REFRESH.busy : WCO_REFRESH.idle) - 1;
      if (this.ovrCounter === 0) this.ovrCounter = 1; // o Ov fica para o próximo
      fields.push(`WCO:${this.wco.x.toFixed(3)},${this.wco.y.toFixed(3)},0.000`);
    }
    if (this.ovrCounter > 0) this.ovrCounter--;
    else {
      this.ovrCounter = (busy ? OVR_REFRESH.busy : OVR_REFRESH.idle) - 1;
      // no fork do servo o PWM nunca desliga, então spindle_get_state() sempre diz "ligado": A:S fixo
      fields.push(`Ov:${this.feedOv},100,100`, "A:S");
    }
    return `<${fields.join("|")}>`;
  }

  /** O Hold completou com um 0x9E pedido: desliga o spindle (no fork do servo, a caneta sobe). */
  private applySpindleStop() {
    if (!this.o.spindleStopInHold || !this.spindleOn) {
      this.stopOvr = "off";
      return;
    }
    this.setPen(() => (this.stopOvr = "enabled"));
    this.ovrCounter = 0;
  }

  private restoreSpindle() {
    this.setPen(() => (this.stopOvr = "off"));
    this.ovrCounter = 0;
    this.emit("[MSG:Restoring spindle]");
  }

  /** Aplica uma mudança e registra o traço quando a caneta desce/sobe. */
  private setPen(change: () => void) {
    const before = this.penDown;
    change();
    const after = this.penDown;
    if (!before && after) this.penStrokes.push([{ ...this.w }]);
    else if (before && !after) this.appendPoint();
  }

  private appendPoint() {
    const s = this.penStrokes[this.penStrokes.length - 1];
    if (!s) return;
    const last = s[s.length - 1];
    if (Math.abs(last.x - this.w.x) > 1e-9 || Math.abs(last.y - this.w.y) > 1e-9) s.push({ ...this.w });
  }

  /**
   * 0x18 (mc_reset + main): andando → ALARM:3 (no homing, ALARM:6) e a máquina volta em Alarm; parado
   * (Idle, Hold:0, no meio de um G4) → só o banner, com a posição mantida. A linha que estava executando
   * (G4, espera do planejador, $H, M0, a do soft limit) ainda devolve o seu "ok" antes do banner.
   */
  private softReset() {
    if (!this.booted) return;
    const alarm = this.st === "Home" ? 6 : this.st === "Run" || this.st === "Jog" || (this.st === "Hold" && this.holdSub === 1) ? 3 : undefined;
    const lines: string[] = [];
    if (alarm !== undefined) lines.push(`ALARM:${alarm}`);
    if (this.dwellLeftMs > 0 || this.waitingLine || this.st === "Home" || this.m0Wait || this.critical) lines.push("ok");
    const alarmState = alarm !== undefined || this.st === "Alarm";
    this.reinit(alarmState ? "Alarm" : "Idle");
    lines.push("", BANNER);
    if (alarmState) lines.push(LOCKED);
    this.emit(...lines);
  }

  /** Alarme em que o próprio GRBL se reinicia (falha no homing): ALARM, o "ok" do $H, banner, Alarm. */
  private alarmAndReset(code: number) {
    this.reinit("Alarm");
    this.emit(`ALARM:${code}`, "ok", "", BANNER, LOCKED);
  }

  private tick() {
    const now = this.clock.now();
    const dt = (now - this.lastTick) * this.o.timeScale;
    this.lastTick = now;
    if (!this.opened || this.cut || !this.booted) return;
    if (this.st === "Hold" && this.holdSub === 1) {
      this.holdLeftMs -= dt;
      if (this.holdLeftMs <= 0) {
        this.holdSub = 0;
        if (this.stopOvr === "initiate") this.applySpindleStop();
      }
    }
    if (this.st === "Home") {
      this.homingLeftMs -= dt;
      if (this.homingLeftMs <= 0) this.finishHoming();
    }
    if (this.dwellLeftMs > 0 && this.st !== "Hold") {
      this.dwellLeftMs -= dt;
      if (this.dwellLeftMs <= 0) {
        this.dwellLeftMs = 0;
        this.reply("ok");
      }
    }
    if (this.st === "Run" || this.st === "Jog") this.move(dt);
    else this.curFeed = 0;
    this.process();
  }

  private finishHoming() {
    const fail = this.o.faults?.homingAlarm;
    if (fail !== undefined) {
      this.alarmAndReset(fail);
      return;
    }
    const p = this.o.homingPulloffMm;
    this.w = { x: this.o.workArea.width - p, y: this.o.workArea.height - p };
    // os "?" que chegaram durante o homing viram um relatório só, ainda como Home, antes do ok
    if (this.statusQueued) this.sendStatus();
    this.statusQueued = false;
    this.st = "Idle";
    this.reply("ok");
  }

  private move(dtMs: number) {
    let budget = dtMs;
    this.curFeed = 0;
    while (budget > 0 && this.planner.length) {
      const b = this.planner[0];
      const f = b.rapid ? this.o.maxRateMmMin : Math.min(this.o.maxRateMmMin, b.jog ? b.feed : (b.feed * this.feedOv) / 100);
      this.curFeed = f;
      const speed = f / 60000; // mm/ms
      const need = (b.len - b.done) / speed;
      if (need <= budget) {
        budget -= need;
        this.w = { ...b.to };
        this.planner.shift();
        if (this.penDown) this.appendPoint();
      } else {
        b.done += speed * budget;
        budget = 0;
        const t = b.done / b.len;
        this.w = { x: b.from.x + (b.to.x - b.from.x) * t, y: b.from.y + (b.to.y - b.from.y) * t };
      }
    }
    if (!this.planner.length) this.st = "Idle";
  }

  private planEnd(): Vec {
    return this.planner.length ? this.planner[this.planner.length - 1].to : this.w;
  }

  private inArea(p: Vec): boolean {
    if (Number(this.settings.get(20) ?? "1") === 0) return true; // soft limits desligados
    const e = 1e-6;
    return p.x >= -e && p.y >= -e && p.x <= this.o.workArea.width + e && p.y <= this.o.workArea.height + e;
  }

  private process() {
    if (!this.booted || this.cut) return;
    for (;;) {
      // em Hold o GRBL fica preso na rotina de suspensão; no homing, no G4 e no alarme crítico, idem
      if (this.st === "Hold" || this.st === "Home" || this.dwellLeftMs > 0 || this.critical || this.m0Wait) return;
      const eol = this.rx.search(/[\r\n]/); // os dois terminam a linha (um "\r\n" daria dois ok)
      if (eol < 0) return;
      const raw = this.rx.slice(0, eol);
      const r = this.execute(raw);
      this.waitingLine = r === "blocked";
      if (r === "blocked") return;
      this.rx = this.rx.slice(eol + 1);
      this.received.push(raw);
      if (this.cut) return;
    }
  }

  private reply(text: string): "done" {
    if (text === "ok") this.linesExecuted++;
    this.emit(text);
    return "done";
  }

  /**
   * protocol_main_loop(): tira espaços e comentários ("(" até ")" sem aninhar; ";" até o fim), passa
   * para maiúsculas e decide. Linha vazia ou só com comentário responde "ok", até em Alarm.
   */
  private execute(raw: string): "blocked" | "done" {
    let line = "";
    let inParen = false;
    let overflow = false;
    for (const ch of raw) {
      if (overflow) break;
      if (inParen) {
        if (ch === ")") inParen = false;
        continue;
      }
      if (ch <= " " || ch === "/") continue;
      if (ch === "(") inParen = true;
      else if (ch === ";") break;
      else if (line.length >= LINE_MAX_CHARS) overflow = true;
      else line += ch.toUpperCase();
    }
    if (overflow) return this.reply("error:11");
    if (!line) return this.reply("ok");
    if (line[0] === "$") return this.system(line);

    const n = this.gcodeLines + 1;
    const faults = this.o.faults;
    if (faults?.disconnectAfterLines === n) {
      this.gcodeLines = n;
      this.cutCable();
      return "done";
    }
    if (faults?.errorAtLine?.line === n) {
      this.gcodeLines = n;
      return this.reply(`error:${faults.errorAtLine.code}`);
    }
    // o GRBL trava o G-code em Alarm e durante um jog, antes de interpretar a linha
    const r = this.st === "Alarm" || this.st === "Jog" ? this.reply("error:9") : this.gcode(line);
    if (r !== "blocked") this.gcodeLines = n;
    return r;
  }

  /** system_execute_line(). `u` já vem sem espaços e em maiúsculas. */
  private system(u: string): "blocked" | "done" {
    const idleOrAlarm = this.st === "Idle" || this.st === "Alarm";
    if (u === "$") {
      this.emit("[HLP:$$ $# $G $I $N $x=val $Nx=line $J=line $SLP $C $X $H ~ ! ? ctrl-x]");
      return this.reply("ok");
    }
    if (u.startsWith("$J")) {
      if (!(this.st === "Idle" || this.st === "Jog")) return this.reply("error:8");
      if (u[2] !== "=") return this.reply("error:3");
      return this.jog(u.slice(3));
    }
    if (u === "$$") {
      if (this.st === "Run" || this.st === "Hold") return this.reply("error:8");
      const keys = [...this.settings.keys()].sort((a, b) => a - b);
      this.emit(...keys.map((k) => `$${k}=${this.settings.get(k)}`));
      return this.reply("ok");
    }
    if (u === "$G") {
      this.emit(`[GC:G${this.motionMode} G54 G17 G21 G${this.absolute ? 90 : 91} G94 M${this.spindleOn ? 3 : 5} M${this.coolantOn ? 8 : 9} T0 F${this.feed} S${this.spindleS}]`);
      return this.reply("ok");
    }
    if (u === "$X") {
      if (this.st === "Alarm") {
        this.st = "Idle";
        this.emit("[MSG:Caution: Unlocked]");
      }
      return this.reply("ok");
    }
    if (u === "$C") return this.reply("ok"); // modo de conferência: não modelado
    if (!idleOrAlarm) return this.reply("error:8");
    if (u === "$#") {
      const z = "0.000,0.000,0.000";
      this.emit(
        `[G54:${this.wco.x.toFixed(3)},${this.wco.y.toFixed(3)},0.000]`,
        ...["G55", "G56", "G57", "G58", "G59", "G28", "G30", "G92"].map((g) => `[${g}:${z}]`),
        "[TLO:0.000]",
        `[PRB:${z}:0]`,
      );
      return this.reply("ok");
    }
    if (u === "$I") {
      this.emit("[VER:1.1h.20190830:]", `[OPT:V,${this.o.plannerBlocks},${this.o.rxBufferBytes}]`);
      return this.reply("ok");
    }
    if (u === "$H") {
      if (Number(this.settings.get(22) ?? "1") === 0) return this.reply("error:5");
      this.st = "Home";
      this.homingLeftMs = this.o.homingMs;
      return "done"; // o ok sai no fim do homing
    }
    const m = /^\$(\d+)=(.+)$/.exec(u);
    if (m) {
      this.settings.set(Number(m[1]), m[2]);
      return this.reply("ok");
    }
    if (/^\$(SLP|RST=.*|N\d?=?.*)$/.test(u)) return this.reply("ok"); // não modelados
    return this.reply("error:3");
  }

  /** $J=: só G90/G91, G20/G21, G53, X/Y, F (e N). Fora da área responde error:15, sem alarme. */
  private jog(code: string): "blocked" | "done" {
    if (this.planner.length >= this.o.plannerBlocks) return "blocked";
    const words = parseWords(code);
    if (typeof words === "number") return this.reply(`error:${words}`);
    let abs = this.absolute;
    let machine = false;
    let x: number | undefined;
    let y: number | undefined;
    let f: number | undefined;
    for (const [k, v] of words) {
      if (k === "G" && v === 90) abs = true;
      else if (k === "G" && v === 91) abs = false;
      else if (k === "G" && v === 21) continue;
      else if (k === "G" && v === 53) machine = true;
      else if (k === "X") x = v;
      else if (k === "Y") y = v;
      else if (k === "F") f = v;
      else if (k === "N") continue;
      else if (k === "G" || k === "M") return this.reply("error:16");
      else return this.reply("error:36");
    }
    if (f === undefined || f <= 0) return this.reply("error:22");
    if (x === undefined && y === undefined) return this.reply("error:26");
    const from = this.planEnd();
    let to: Vec;
    if (machine) to = { x: x === undefined ? from.x : x - this.wco.x, y: y === undefined ? from.y : y - this.wco.y };
    else if (abs) to = { x: x ?? from.x, y: y ?? from.y };
    else to = { x: from.x + (x ?? 0), y: from.y + (y ?? 0) };
    if (!this.inArea(to)) return this.reply("error:15");
    this.pushBlock(from, to, f, false, true);
    if (this.planner.length) this.st = "Jog";
    return this.reply("ok");
  }

  private pushBlock(from: Vec, to: Vec, feed: number, rapid: boolean, jog: boolean) {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    if (len < 1e-9) return;
    this.planner.push({ from, to, len, done: 0, feed, rapid, jog });
  }

  /**
   * gc_execute_line(): primeiro confere a linha inteira (um erro não muda nada do estado), depois
   * espera o que precisar e só então executa, na ordem do GRBL: F, S, M3/M5, G4, G90/G91, movimento, M2.
   */
  private gcode(line: string): "blocked" | "done" {
    const b = parseBlock(line);
    if (typeof b === "number") return this.reply(`error:${b}`);

    const axisWords = b.x !== undefined || b.y !== undefined;
    const motion = b.motion ?? this.motionMode;
    const feed = b.f ?? this.feed;
    if (b.dwell && b.p === undefined) return this.reply("error:28");
    if (!b.dwell && b.p !== undefined) return this.reply("error:36");
    if (b.dwell && (axisWords || b.flow !== undefined)) return this.reply("error:20"); // não modelado
    if (motion === 80 && axisWords) return this.reply("error:31");
    // G1 (na linha ou modal) precisa de F, mesmo sem eixos na linha
    if (motion === 1 && (axisWords || b.motion === 1) && !(feed > 0)) return this.reply("error:22");

    // espera como o GRBL: o que mexe no spindle, o G4 e o M0/M2/M30 esperam o planejador esvaziar;
    // movimento precisa de vaga. Um M5 (ou M3 S igual) repetido não muda nada e por isso não espera.
    const spindleChange = b.spindle !== undefined && b.spindle !== this.spindleOn;
    const speedChange = b.s !== undefined && b.s !== this.spindleS && this.spindleOn;
    const flowSync = b.flow === 0 || b.flow === 2 || b.flow === 30;
    const coolantChange = b.coolant !== undefined && b.coolant !== this.coolantOn;
    if ((spindleChange || speedChange || coolantChange || b.dwell || flowSync) && (this.planner.length > 0 || this.st === "Run")) return "blocked";
    if (axisWords && this.planner.length >= this.o.plannerBlocks) return "blocked";

    if (b.f !== undefined) this.feed = b.f;
    if (b.s !== undefined && b.s !== this.spindleS) {
      const s = b.s;
      this.setPen(() => (this.spindleS = s));
    }
    if (spindleChange) {
      const on = b.spindle === true;
      this.setPen(() => (this.spindleOn = on));
      this.ovrCounter = 0;
    }
    if (b.coolant !== undefined) this.coolantOn = b.coolant;
    if (b.absolute !== undefined) this.absolute = b.absolute;
    if (b.motion !== undefined) this.motionMode = b.motion;
    if (b.dwell) {
      this.dwellLeftMs = Math.ceil(((b.p ?? 0) * 1000) / DWELL_STEP_MS - 1e-9) * DWELL_STEP_MS;
      if (this.dwellLeftMs > 0) return "done"; // o ok sai no fim da pausa
    }
    if (axisWords) {
      const from = this.planEnd();
      const to = this.absolute ? { x: b.x ?? from.x, y: b.y ?? from.y } : { x: from.x + (b.x ?? 0), y: from.y + (b.y ?? 0) };
      if (!this.inArea(to)) {
        // soft limit: o GRBL para, desliga o spindle, entra em alarme e fica mudo até o reset
        this.setPen(() => (this.spindleOn = false));
        this.planner = [];
        this.st = "Alarm";
        this.critical = true;
        this.curFeed = 0;
        this.emit("ALARM:2", "[MSG:Reset to continue]");
        return "done";
      }
      this.pushBlock(from, to, feed, motion === 0, false);
      if (this.st === "Idle" && this.planner.length) this.st = "Run";
    }
    if (b.flow === 0) {
      this.st = "Hold"; // M0: pausa do programa, sai com "~"
      this.holdSub = 0;
      this.m0Wait = true;
      return "done";
    }
    if (b.flow === 2 || b.flow === 30) {
      // fim de programa: G1 (!), G17, G90, G94, G54, M5, M9 e overrides em 100%; F e S ficam
      this.motionMode = 1;
      this.absolute = true;
      this.setPen(() => (this.spindleOn = false));
      this.coolantOn = false;
      this.feedOv = 100;
      this.wcoCounter = this.ovrCounter = 0;
      this.emit("[MSG:Pgm End]");
    }
    return this.reply("ok");
  }
}

/**
 * "G1X10.5Y-2F1500" → [["G",1],["X",10.5],...]; ou o código do erro: 1 se o que vem não é letra,
 * 2 se a letra não tem número válido.
 */
function parseWords(code: string): [string, number][] | number {
  const out: [string, number][] = [];
  const re = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/y;
  let i = 0;
  while (i < code.length) {
    re.lastIndex = i;
    const m = re.exec(code);
    if (!m) return /[A-Z]/.test(code[i]) ? 2 : 1;
    out.push([m[1], parseFloat(m[2])]);
    i = re.lastIndex;
  }
  return out;
}

/** Palavras de uma linha → bloco conferido, ou o código do erro (como o passo 2 do gc_execute_line). */
function parseBlock(line: string): ParsedBlock | number {
  const words = parseWords(line);
  if (typeof words === "number") return words;
  const b: ParsedBlock = { dwell: false };
  const groups = new Set<string>();
  const seen = new Set<string>();
  const group = (g: string) => {
    if (groups.has(g)) return false;
    groups.add(g);
    return true;
  };
  for (const [k, v] of words) {
    if (k === "G" || k === "M") {
      const int = Math.trunc(v);
      if (Math.round(100 * (v - int)) !== 0) return k === "G" && [28, 30, 38, 43, 92].includes(int) ? 20 : 23;
      let g: string;
      if (k === "G") {
        if (int === 0 || int === 1 || int === 80) {
          g = "motion";
          b.motion = int;
        } else if (int === 4) {
          g = "nonmodal";
          b.dwell = true;
        } else if (int === 17) g = "plane";
        else if (int === 21) g = "units";
        else if (int === 40) g = "cutter";
        else if (int === 54) g = "coord";
        else if (int === 61) g = "control";
        else if (int === 90 || int === 91) {
          g = "distance";
          b.absolute = int === 90;
        } else if (int === 94) g = "feedmode";
        else return 20; // inclui o que o GRBL tem e o simulador não modela (G2/G3, G10, G20, G28, G53, G92...)
      } else if (int === 0 || int === 1 || int === 2 || int === 30) {
        g = "flow";
        b.flow = int;
      } else if (int === 3 || int === 4 || int === 5) {
        g = "spindle";
        b.spindle = int !== 5;
      } else if (int === 8 || int === 9) {
        g = "coolant";
        b.coolant = int === 8;
      } else return 20;
      if (!group(`${k}:${g}`)) return 21;
      continue;
    }
    if (!"FNPSTXY".includes(k)) return "IJKLRZ".includes(k) && k !== "Z" ? 36 : 20;
    if (seen.has(k)) return 25;
    seen.add(k);
    if ("FNPST".includes(k) && v < 0) return 4;
    if (k === "F") b.f = v;
    else if (k === "S") b.s = v;
    else if (k === "P") b.p = v;
    else if (k === "X") b.x = v;
    else if (k === "Y") b.y = v;
  }
  return b;
}
