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
  /** sobrescreve valores do $$ (ex.: { 32: "1" }) */
  settings?: Record<number, string>;
  faults?: {
    /** a k-ésima linha de G-code recebida (1 = primeira) responde error:code */
    errorAtLine?: { line: number; code: number };
    /** o cabo "sai" logo depois de receber a k-ésima linha de G-code */
    disconnectAfterLines?: number;
    /** a placa nunca responde (nem ao 0x18) */
    noBanner?: boolean;
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

const BANNER = "Grbl 1.1h ['$' for help]";
const LOCKED = "[MSG:'$H'|'$X' to unlock]";
const SUPPORTED_G = [0, 1, 4, 17, 21, 54, 90, 91, 94];
const SUPPORTED_M = [2, 3, 5, 8, 9, 30];

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
 * Modela o que importa para o envio: buffer de recepção de 128 bytes (estouro = rxOverflow), planejador
 * de 15 blocos (o "ok" sai quando a linha entra nele), M3/M5/G4 esperando o planejador esvaziar,
 * comandos de tempo real (?, !, ~, 0x18, 0x85, 0x9E, overrides), $H/$X/$$/$#/$J e soft limits.
 * Movimento em velocidade constante (sem aceleração): basta para a ordem e o tempo.
 */
export class FakeGrbl implements Transport {
  readonly label = "Simulador";
  onData: ((chunk: Uint8Array) => void) | null = null;
  onClose: ((info: { reason: "user" | "lost"; error?: unknown }) => void) | null = null;

  // --- inspeção para testes
  /** o que a caneta desenhou, em WPos */
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

  private readonly o: Required<Omit<FakeGrblOptions, "settings" | "faults">> & Pick<FakeGrblOptions, "faults">;
  private readonly wco: Vec;
  private settings: Map<number, string>;

  private opened = false;
  private cut = false;
  private booted = false;
  private rx = "";
  private planner: Block[] = [];
  private st: MachineState = "Alarm";
  private holdSub = 0;
  private holdLeftMs = 0;
  private homingLeftMs = 0;
  private dwellLeftMs = 0;
  private dwellOkPending = false;
  private pendingSpindleStop = false;
  private spindleOn = false;
  private spindleS = 0;
  private spindleStopped = false;
  private absolute = true;
  private motionMode = 0;
  private feed: number | undefined;
  private feedOv = 100;
  private lastReportedOv = 100;
  private curFeed = 0;
  private w: Vec;
  private reportCount = 0;
  private gcodeLines = 0;
  private needsReset = false;
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
  get penDown(): boolean {
    return this.spindleOn && this.spindleS > 0 && !this.spindleStopped;
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

  /** Simula puxar o cabo USB. */
  unplug(): void {
    if (this.opened && !this.cut) this.cutCable();
  }

  /** Simula a placa reiniciar sozinha (queda de energia, DTR): banner de novo, Alarm, posição perdida. */
  powerGlitch(): void {
    if (!this.opened || this.cut) return;
    this.booted = false;
    this.setPen(() => (this.spindleOn = false));
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

  private powerUp() {
    this.rx = "";
    this.planner = [];
    this.st = "Alarm";
    this.holdSub = 0;
    this.homingLeftMs = this.dwellLeftMs = 0;
    this.dwellOkPending = this.pendingSpindleStop = false;
    this.spindleOn = this.spindleStopped = false;
    this.spindleS = 0;
    this.resetParser();
    this.feedOv = this.lastReportedOv = 100;
    this.needsReset = false;
    this.reportCount = 0;
  }

  private resetParser() {
    this.absolute = true;
    this.motionMode = 0;
    this.feed = undefined;
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

  private receiveByte(b: number) {
    if (!this.booted) return; // bootloader do Uno: descarta
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
    switch (b) {
      case RT.STATUS:
        this.emit(this.statusReport());
        break;
      case RT.HOLD:
        if (this.st === "Run") {
          this.st = "Hold";
          this.holdSub = 1;
          this.holdLeftMs = 100;
        } else if (this.st === "Jog") {
          this.planner = [];
          this.st = "Idle";
        } else if (this.st === "Idle") {
          this.st = "Hold";
          this.holdSub = 0;
        }
        break;
      case RT.RESUME:
        if (this.st === "Hold" && this.holdSub === 0) {
          // com a caneta "parada" pelo 0x9E, o GRBL religa e já sai andando (por isso o controlador
          // manda o 0x9E antes e espera o servo)
          if (this.spindleStopped) this.restoreSpindle();
          this.pendingSpindleStop = false;
          this.st = this.planner.length ? "Run" : "Idle";
        }
        break;
      case RT.RESET:
        this.softReset();
        break;
      case RT.JOG_CANCEL:
        if (this.st === "Jog") {
          this.planner = [];
          this.st = "Idle";
        }
        break;
      case RT.SPINDLE_STOP:
        if (this.st === "Hold") {
          if (this.holdSub === 0) this.toggleSpindleStop();
          else this.pendingSpindleStop = !this.pendingSpindleStop;
        }
        break;
      case RT.FEED_RESET:
        this.feedOv = 100;
        break;
      case RT.FEED_PLUS_10:
      case RT.FEED_MINUS_10:
      case RT.FEED_PLUS_1:
      case RT.FEED_MINUS_1: {
        const d = { [RT.FEED_PLUS_10]: 10, [RT.FEED_MINUS_10]: -10, [RT.FEED_PLUS_1]: 1, [RT.FEED_MINUS_1]: -1 }[b] ?? 0;
        this.feedOv = Math.min(200, Math.max(10, this.feedOv + d));
        break;
      }
      default:
        if (b >= 0x99 && b <= 0x9d) this.forbiddenBytes.push(b);
    }
  }

  /** Como o GRBL: WCO de 10 em 10 relatórios; Ov quando muda ou de tempos em tempos (nunca junto do WCO). */
  private statusReport(): string {
    const mx = this.w.x + this.wco.x;
    const my = this.w.y + this.wco.y;
    const fields = [this.stateText, `MPos:${mx.toFixed(3)},${my.toFixed(3)},0.000`, `FS:${Math.round(this.curFeed)},${this.penDown ? this.spindleS : 0}`];
    const n = this.reportCount++;
    if (n % 10 === 0) fields.push(`WCO:${this.wco.x.toFixed(3)},${this.wco.y.toFixed(3)},0.000`);
    else if (n % 10 === 5 || this.feedOv !== this.lastReportedOv) {
      fields.push(`Ov:${this.feedOv},100,100`);
      this.lastReportedOv = this.feedOv;
    }
    return `<${fields.join("|")}>`;
  }

  private toggleSpindleStop() {
    if (!this.o.spindleStopInHold) return;
    if (this.spindleStopped) this.restoreSpindle();
    else if (this.spindleOn) this.setPen(() => (this.spindleStopped = true));
  }

  private restoreSpindle() {
    this.setPen(() => (this.spindleStopped = false));
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

  private softReset() {
    if (!this.booted) return;
    const moving = this.st === "Run" || this.st === "Jog" || this.st === "Home" || (this.st === "Hold" && this.holdSub === 1);
    const wasAlarm = this.st === "Alarm";
    this.setPen(() => {
      this.spindleOn = false; // o reset executa M5: a caneta sobe
      this.spindleStopped = false;
    });
    this.planner = [];
    this.rx = "";
    this.dwellLeftMs = this.homingLeftMs = 0;
    this.dwellOkPending = this.pendingSpindleStop = false;
    this.resetParser();
    this.feedOv = 100;
    this.needsReset = false;
    this.curFeed = 0;
    const lines: string[] = [];
    if (moving) lines.push("ALARM:3");
    this.st = moving || wasAlarm ? "Alarm" : "Idle";
    lines.push("", BANNER);
    if (this.st === "Alarm") lines.push(LOCKED);
    this.emit(...lines);
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
        if (this.pendingSpindleStop) {
          this.pendingSpindleStop = false;
          this.toggleSpindleStop();
        }
      }
    }
    if (this.st === "Home") {
      this.homingLeftMs -= dt;
      if (this.homingLeftMs <= 0) {
        const p = this.o.homingPulloffMm;
        this.w = { x: this.o.workArea.width - p, y: this.o.workArea.height - p };
        this.st = "Idle";
        this.linesExecuted++;
        this.emit("ok");
      }
    }
    if (this.dwellLeftMs > 0 && this.st !== "Hold") {
      this.dwellLeftMs -= dt;
      if (this.dwellLeftMs <= 0) {
        this.dwellLeftMs = 0;
        if (this.dwellOkPending) {
          this.dwellOkPending = false;
          this.linesExecuted++;
          this.emit("ok");
        }
      }
    }
    if (this.st === "Run" || this.st === "Jog") this.move(dt);
    else this.curFeed = 0;
    this.process();
  }

  private move(dtMs: number) {
    let budget = dtMs;
    this.curFeed = 0;
    while (budget > 0 && this.planner.length) {
      const b = this.planner[0];
      const f = b.rapid ? this.o.maxRateMmMin : b.jog ? b.feed : (b.feed * this.feedOv) / 100;
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
    const e = 1e-6;
    return p.x >= -e && p.y >= -e && p.x <= this.o.workArea.width + e && p.y <= this.o.workArea.height + e;
  }

  private process() {
    if (!this.booted || this.cut) return;
    for (;;) {
      if (this.st === "Hold" || this.st === "Home" || this.dwellLeftMs > 0 || this.needsReset) return;
      const nl = this.rx.indexOf("\n");
      if (nl < 0) return;
      const line = this.rx.slice(0, nl).replace(/\r/g, "");
      if (this.execute(line) === "blocked") return;
      this.rx = this.rx.slice(nl + 1);
      this.received.push(line);
      if (this.cut) return;
    }
  }

  private reply(text: string): "done" {
    if (text === "ok") this.linesExecuted++;
    this.emit(text);
    return "done";
  }

  private execute(line: string): "blocked" | "done" {
    const t = line.trim();
    if (!t) return this.reply("ok");
    if (t.startsWith("$")) return this.system(t);
    return this.gcode(t);
  }

  private system(t: string): "blocked" | "done" {
    const u = t.toUpperCase().replace(/\s+/g, "");
    const idleOrAlarm = this.st === "Idle" || this.st === "Alarm";
    if (u === "$$") {
      if (this.st === "Run" || this.st === "Hold") return this.reply("error:8");
      const keys = [...this.settings.keys()].sort((a, b) => a - b);
      this.emit(...keys.map((k) => `$${k}=${this.settings.get(k)}`));
      return this.reply("ok");
    }
    if (u === "$#") {
      if (!idleOrAlarm) return this.reply("error:8");
      const z = "0.000,0.000,0.000";
      this.emit(
        `[G54:${this.wco.x.toFixed(3)},${this.wco.y.toFixed(3)},0.000]`,
        ...["G55", "G56", "G57", "G58", "G59", "G28", "G30", "G92"].map((g) => `[${g}:${z}]`),
        "[TLO:0.000]",
        `[PRB:${z}:0]`,
      );
      return this.reply("ok");
    }
    if (u === "$G") {
      this.emit(`[GC:G${this.motionMode} G54 G17 G21 G${this.absolute ? 90 : 91} G94 M${this.spindleOn ? 3 : 5} M9 T0 F${this.feed ?? 0} S${this.spindleS}]`);
      return this.reply("ok");
    }
    if (u === "$I") {
      this.emit("[VER:1.1h.20190825:]", "[OPT:V,15,128]");
      return this.reply("ok");
    }
    if (u === "$X") {
      if (this.st === "Alarm") {
        this.st = "Idle";
        this.emit("[MSG:Caution: Unlocked]");
      }
      return this.reply("ok");
    }
    if (u === "$H") {
      if (!idleOrAlarm) return this.reply("error:8");
      this.st = "Home";
      this.homingLeftMs = this.o.homingMs;
      return "done"; // o ok sai no fim do homing
    }
    if (u.startsWith("$J=")) {
      if (!(this.st === "Idle" || this.st === "Jog")) return this.reply("error:8");
      if (this.planner.length >= this.o.plannerBlocks) return "blocked";
      const words = parseWords(u.slice(3));
      if (!words) return this.reply("error:2");
      let abs = this.absolute;
      let x: number | undefined;
      let y: number | undefined;
      let f: number | undefined;
      for (const [k, v] of words) {
        if (k === "G" && v === 90) abs = true;
        else if (k === "G" && v === 91) abs = false;
        else if (k === "G" && (v === 21 || v === 20 || v === 53)) continue;
        else if (k === "X") x = v;
        else if (k === "Y") y = v;
        else if (k === "F") f = v;
        else return this.reply("error:16");
      }
      if (f === undefined || f <= 0) return this.reply("error:22");
      if (x === undefined && y === undefined) return this.reply("error:26");
      const from = this.planEnd();
      const to = abs ? { x: x ?? from.x, y: y ?? from.y } : { x: from.x + (x ?? 0), y: from.y + (y ?? 0) };
      if (!this.inArea(to)) return this.reply("error:15");
      this.pushBlock(from, to, f, false, true);
      if (this.planner.length) this.st = "Jog";
      return this.reply("ok");
    }
    let m = /^\$(\d+)=(.+)$/.exec(u);
    if (m) {
      if (!idleOrAlarm) return this.reply("error:8");
      this.settings.set(Number(m[1]), m[2]);
      return this.reply("ok");
    }
    m = /^\$(C|SLP|RST=.*|N\d?=?.*)$/.exec(u);
    if (m) return this.reply("ok");
    return this.reply("error:3");
  }

  private pushBlock(from: Vec, to: Vec, feed: number, rapid: boolean, jog: boolean) {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    if (len < 1e-9) return;
    this.planner.push({ from, to, len, done: 0, feed, rapid, jog });
  }

  private gcode(t: string): "blocked" | "done" {
    // comentários como o GRBL: "(" abre, ")" fecha (sem aninhar), ";" vai até o fim
    let code = "";
    let inParen = false;
    for (const ch of t) {
      if (inParen) {
        if (ch === ")") inParen = false;
        continue;
      }
      if (ch === "(") inParen = true;
      else if (ch === ";") break;
      else code += ch;
    }
    code = code.toUpperCase().replace(/\s+/g, "");
    const words = parseWords(code);
    const gs = words?.filter(([k]) => k === "G").map(([, v]) => v) ?? [];
    const ms = words?.filter(([k]) => k === "M").map(([, v]) => v) ?? [];
    const has = (k: string) => words?.some(([w]) => w === k) ?? false;
    const val = (k: string) => words?.find(([w]) => w === k)?.[1];
    const isSync = ms.some((v) => v === 3 || v === 4 || v === 5) || gs.includes(4);
    const isMotion = has("X") || has("Y");
    const alarmLike = this.st === "Alarm" || this.st === "Jog";

    // espera como o GRBL: movimento precisa de vaga no planejador; M3/M5/G4 esperam ele esvaziar
    if (words && !alarmLike) {
      if (isSync && (this.planner.length > 0 || this.st === "Run")) return "blocked";
      if (isMotion && this.planner.length >= this.o.plannerBlocks) return "blocked";
    }

    this.gcodeLines++;
    const faults = this.o.faults;
    if (faults?.disconnectAfterLines !== undefined && this.gcodeLines === faults.disconnectAfterLines) {
      this.cutCable();
      return "done";
    }
    if (faults?.errorAtLine && this.gcodeLines === faults.errorAtLine.line) return this.reply(`error:${faults.errorAtLine.code}`);
    if (alarmLike) return this.reply("error:9"); // o GRBL trava o G-code antes de interpretar a linha
    if (!words) return this.reply(`error:${parseErrorCode(code)}`);
    if (gs.some((g) => !SUPPORTED_G.includes(g))) return this.reply("error:20");
    if (ms.some((v) => !SUPPORTED_M.includes(v))) return this.reply("error:20");

    const f = val("F");
    if (f !== undefined) this.feed = f;
    const s = val("S");
    if (s !== undefined) this.spindleS = s;
    if (gs.includes(90)) this.absolute = true;
    if (gs.includes(91)) this.absolute = false;
    if (gs.includes(0)) this.motionMode = 0;
    if (gs.includes(1)) this.motionMode = 1;
    if (ms.includes(3)) this.setPen(() => (this.spindleOn = true));
    if (ms.includes(5)) this.setPen(() => (this.spindleOn = false));
    if (gs.includes(4)) {
      const p = val("P");
      if (p === undefined || p < 0) return this.reply("error:28");
      this.dwellLeftMs = p * 1000;
      this.dwellOkPending = true;
      return "done"; // o ok sai no fim da pausa
    }
    if (isMotion) {
      if (this.motionMode === 1 && this.feed === undefined) return this.reply("error:22");
      const from = this.planEnd();
      const x = val("X");
      const y = val("Y");
      const to = this.absolute ? { x: x ?? from.x, y: y ?? from.y } : { x: from.x + (x ?? 0), y: from.y + (y ?? 0) };
      if (!this.inArea(to)) {
        // soft limit: o GRBL para tudo, entra em alarme e espera um reset
        this.setPen(() => (this.spindleOn = false));
        this.planner = [];
        this.rx = "";
        this.st = "Alarm";
        this.needsReset = true;
        this.emit("ALARM:2", "[MSG:Reset to continue]");
        return "done";
      }
      this.pushBlock(from, to, this.feed ?? 0, this.motionMode === 0, false);
      if (this.st === "Idle" && this.planner.length) this.st = "Run";
    }
    return this.reply("ok");
  }
}

/** "G1X10.5Y-2F1500" → [["G",1],["X",10.5],...]; undefined se mal formado. */
function parseWords(code: string): [string, number][] | undefined {
  const r = parseWordsAt(code);
  return typeof r === "number" ? undefined : r;
}

/** Como parseWords, mas devolve a posição onde falhou. */
function parseWordsAt(code: string): [string, number][] | number {
  const out: [string, number][] = [];
  const re = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/y;
  let i = 0;
  while (i < code.length) {
    re.lastIndex = i;
    const m = re.exec(code);
    if (!m) return i;
    out.push([m[1], parseFloat(m[2])]);
    i = re.lastIndex;
  }
  return out;
}

/** error:1 se o que sobrou não começa com letra; error:2 se a letra não tem número válido. */
function parseErrorCode(code: string): number {
  const at = parseWordsAt(code);
  return typeof at === "number" && /[A-Z]/.test(code[at]) ? 2 : 1;
}
