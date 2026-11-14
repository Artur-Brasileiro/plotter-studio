import { realClock } from "../../core/grbl/clock";
import { GrblController, isJobActive, type ControllerSnapshot, type LogEntry } from "../../core/grbl/controller";
import { FakeGrbl, type FakeGrblOptions } from "../../core/grbl/fakeGrbl";
import type { Store } from "../../core/store";
import { findRememberedPort, portLabel, rememberPort, serialSupported, WebSerialTransport } from "../../serial/webSerialTransport";

export interface SimSettings {
  readonly timeScale: number;
  readonly spindleStopInHold: boolean;
  readonly faults: FakeGrblOptions["faults"];
}

/**
 * `?sim=1` troca a máquina pelo simulador. Extras para ensaiar falhas:
 * `simSpeed=5` (5× mais rápido), `simNoLift=1` (0x9E não levanta a caneta),
 * `simError=30:20` (error:20 na 30ª linha), `simDisconnect=200` (cabo sai na 200ª linha).
 */
export function simSettingsFromUrl(search: string): SimSettings | undefined {
  const q = new URLSearchParams(search);
  if (q.get("sim") !== "1") return undefined;
  const num = (k: string) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const err = /^(\d+):(\d+)$/.exec(q.get("simError") ?? "");
  return {
    timeScale: num("simSpeed") ?? 1,
    spindleStopInHold: q.get("simNoLift") !== "1",
    faults: {
      errorAtLine: err ? { line: Number(err[1]), code: Number(err[2]) } : undefined,
      disconnectAfterLines: num("simDisconnect"),
    },
  };
}

const idle = (label: string): ControllerSnapshot => ({
  link: "disconnected",
  transportLabel: label,
  health: "ok",
  homed: false,
  needsReset: false,
  settings: new Map(),
  settingsWarnings: [],
  job: { state: "none", total: 0, acked: 0, pausedMs: 0 },
});

/**
 * A máquina vista pela interface: um GrblController por conexão (a porta pode mudar entre uma e outra),
 * reemitindo o estado e o log para os painéis.
 */
export class MachineSession {
  controller: GrblController | undefined;
  readonly fake: FakeGrbl | undefined;
  rememberedPort: SerialPort | undefined;
  private readonly listeners = new Set<(s: ControllerSnapshot) => void>();
  private readonly logListeners = new Set<(e: LogEntry) => void>();
  private unsub: (() => void)[] = [];
  private last: ControllerSnapshot;

  constructor(
    private readonly store: Store,
    readonly sim: SimSettings | undefined,
  ) {
    if (sim) {
      this.fake = new FakeGrbl(realClock, {
        workArea: store.state.profile.workArea,
        maxRateMmMin: store.state.profile.motion.maxRateMmMin,
        timeScale: sim.timeScale,
        spindleStopInHold: sim.spindleStopInHold,
        faults: sim.faults,
      });
    }
    this.last = idle(sim ? "Simulador" : "Arduino");
    store.subscribe((s, prev) => {
      if (s.profile !== prev.profile) this.controller?.setProfile(s.profile);
    });
    if (!sim && serialSupported()) {
      void this.refreshRememberedPort();
      navigator.serial!.addEventListener("connect", () => void this.refreshRememberedPort());
      navigator.serial!.addEventListener("disconnect", () => void this.refreshRememberedPort());
    }
  }

  /** Web Serial disponível (ou simulador). Fora do Chrome/Edge o envio direto não existe. */
  get available(): boolean {
    return !!this.sim || serialSupported();
  }

  get snapshot(): ControllerSnapshot {
    return this.last;
  }

  get connected(): boolean {
    return this.last.link === "connected";
  }

  get jobActive(): boolean {
    return isJobActive(this.last.job.state);
  }

  /** Rótulo do botão: "Conectar (Arduino Uno (2341:0043))" se a porta já é conhecida. */
  get portName(): string | undefined {
    if (this.sim) return "simulador";
    return this.rememberedPort ? portLabel(this.rememberedPort.getInfo()) : undefined;
  }

  subscribe(l: (s: ControllerSnapshot) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onLog(l: (e: LogEntry) => void): () => void {
    this.logListeners.add(l);
    return () => this.logListeners.delete(l);
  }

  private async refreshRememberedPort(): Promise<void> {
    try {
      this.rememberedPort = await findRememberedPort();
    } catch {
      this.rememberedPort = undefined;
    }
    this.emit(this.last);
  }

  private emit(s: ControllerSnapshot) {
    this.last = s;
    for (const l of [...this.listeners]) l(s);
  }

  private attach(c: GrblController) {
    for (const u of this.unsub) u();
    this.controller = c;
    this.unsub = [
      c.subscribe((s) => this.emit(s)),
      c.onLog((e) => {
        for (const l of [...this.logListeners]) l(e);
      }),
    ];
    this.emit(c.snapshot);
  }

  /**
   * Conecta. Na Web Serial, `choosePort` (ou nenhuma porta lembrada) abre o seletor do Chrome — por isso
   * tem que ser chamado direto do clique.
   */
  async connect(opts: { choosePort?: boolean } = {}): Promise<void> {
    const profile = this.store.state.profile;
    if (this.fake) {
      if (!this.controller) this.attach(new GrblController(this.fake, profile, realClock));
      await this.controller!.connect();
      return;
    }
    if (!serialSupported()) throw new Error("Este navegador não tem Web Serial: use o Chrome ou o Edge (em https ou localhost).");
    let port = opts.choosePort ? undefined : this.rememberedPort;
    if (!port) {
      try {
        port = await navigator.serial!.requestPort();
      } catch (e) {
        if (e instanceof DOMException && e.name === "NotFoundError") return; // cancelou o seletor
        throw e;
      }
    }
    rememberPort(port);
    this.rememberedPort = port;
    this.attach(new GrblController(new WebSerialTransport(port, profile.serial.baudRate), profile, realClock));
    await this.controller!.connect();
  }

  async disconnect(): Promise<void> {
    await this.controller?.disconnect();
  }

  /** Hot reload / fechar a aba: solta a porta (senão ela fica presa até recarregar o Chrome). */
  dispose(): void {
    const c = this.controller;
    if (c && c.snapshot.link !== "disconnected") void c.disconnect().catch(() => {});
  }
}
