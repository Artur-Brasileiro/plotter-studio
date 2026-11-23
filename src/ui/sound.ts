/**
 * O barulhinho de quando o desenho termina (e um outro, mais grave, se ele falhar). São notas feitas na hora
 * pelo próprio navegador (Web Audio): não há arquivo de som para carregar.
 *
 * O navegador só deixa uma página fazer som depois de um gesto de quem usa. Por isso o `arm()` é chamado no
 * clique de "Enviar desenho": o áudio acorda ali e fica pronto para o fim do trabalho, mesmo que a janela
 * esteja escondida.
 */
export type SoundKind = "done" | "failed";

export interface Tone {
  /** Hz */
  readonly freq: number;
  /** Quando começa, em segundos depois do início do aviso */
  readonly at: number;
  /** Quanto dura até sumir (s) */
  readonly dur: number;
  /** Volume no pico (0 a 1) */
  readonly gain: number;
  readonly type: "sine" | "triangle";
}

export const TONES: Record<SoundKind, readonly Tone[]> = {
  // mi maior subindo, com a última nota mais longa: "deu certo"
  done: [
    { freq: 659.25, at: 0, dur: 0.32, gain: 0.2, type: "sine" },
    { freq: 830.61, at: 0.13, dur: 0.32, gain: 0.2, type: "sine" },
    { freq: 987.77, at: 0.26, dur: 0.36, gain: 0.2, type: "sine" },
    { freq: 1318.51, at: 0.42, dur: 0.95, gain: 0.24, type: "sine" },
  ],
  // três notas descendo, mais graves: "venha ver"
  failed: [
    { freq: 493.88, at: 0, dur: 0.3, gain: 0.22, type: "triangle" },
    { freq: 392.0, at: 0.24, dur: 0.3, gain: 0.22, type: "triangle" },
    { freq: 329.63, at: 0.48, dur: 0.7, gain: 0.22, type: "triangle" },
  ],
};

/** O pedaço do Web Audio que o som usa (o teste troca por um de mentira). */
export interface AudioLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    readonly frequency: { setValueAtTime(value: number, time: number): unknown };
    connect(node: never): unknown;
    start(time: number): void;
    stop(time: number): void;
  };
  createGain(): {
    readonly gain: {
      setValueAtTime(value: number, time: number): unknown;
      linearRampToValueAtTime(value: number, time: number): unknown;
      exponentialRampToValueAtTime(value: number, time: number): unknown;
    };
    connect(node: never): unknown;
  };
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY = "plotter-studio.sound.v1";
const SILENT = 0.0001; // a rampa exponencial não aceita zero

function browserAudio(): AudioLike | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: new () => AudioLike; webkitAudioContext?: new () => AudioLike };
  const Ctx = w.AudioContext ?? w.webkitAudioContext;
  return Ctx ? new Ctx() : undefined;
}

function browserStorage(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export class Sounds {
  private readonly create: () => AudioLike | undefined;
  private readonly storage: Store | undefined;
  private ctx: AudioLike | undefined;
  private failed = false;
  private on = true;

  constructor(opts: { create?: () => AudioLike | undefined; storage?: Store } = {}) {
    this.create = opts.create ?? browserAudio;
    this.storage = opts.storage ?? browserStorage();
    try {
      this.on = this.storage?.getItem(KEY) !== "off";
    } catch {
      /* armazenamento bloqueado: fica ligado */
    }
  }

  /** O som está ligado? (vem ligado; a escolha fica guardada no navegador) */
  get enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    try {
      if (on) this.storage?.removeItem(KEY);
      else this.storage?.setItem(KEY, "off");
    } catch {
      /* armazenamento bloqueado: vale só até fechar a página */
    }
  }

  private audio(): AudioLike | undefined {
    if (this.ctx || this.failed) return this.ctx;
    try {
      this.ctx = this.create();
    } catch {
      this.ctx = undefined;
    }
    if (!this.ctx) this.failed = true;
    return this.ctx;
  }

  private wake(ctx: AudioLike): void {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  }

  /** Chamar num clique de quem usa: deixa o áudio pronto para tocar mais tarde. */
  arm(): void {
    const ctx = this.audio();
    if (ctx) this.wake(ctx);
  }

  /** Toca o aviso. Devolve false se o som está desligado ou o navegador não tem áudio. */
  play(kind: SoundKind): boolean {
    if (!this.on) return false;
    const ctx = this.audio();
    if (!ctx) return false;
    this.wake(ctx);
    const t0 = ctx.currentTime + 0.05;
    for (const tone of TONES[kind]) {
      const start = t0 + tone.at;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.freq, start);
      // sobe rápido e some devagar, como um sininho: sem isso cada nota começa e termina com um estalo
      gain.gain.setValueAtTime(SILENT, start);
      gain.gain.linearRampToValueAtTime(tone.gain, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(SILENT, start + tone.dur);
      osc.connect(gain as never);
      gain.connect(ctx.destination as never);
      osc.start(start);
      osc.stop(start + tone.dur + 0.02);
    }
    return true;
  }
}
