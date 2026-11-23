import { describe, expect, it } from "vitest";
import { Sounds, TONES, type AudioLike } from "./sound";

/** Um Web Audio de mentira que anota o que foi pedido. */
function fakeAudio(state: "running" | "suspended" = "running") {
  const notes: { freq: number; type: string; start: number; stop: number; peak: number; reachesOut: boolean }[] = [];
  const ctx = {
    state: state as string,
    currentTime: 10,
    destination: { out: true },
    resumed: 0,
    resume() {
      ctx.resumed++;
      ctx.state = "running";
      return Promise.resolve();
    },
    createGain() {
      const g = {
        target: undefined as unknown,
        peak: 0,
        gain: {
          setValueAtTime(v: number) {
            g.peak = Math.max(g.peak, v);
          },
          linearRampToValueAtTime(v: number) {
            g.peak = Math.max(g.peak, v);
          },
          exponentialRampToValueAtTime(v: number) {
            g.peak = Math.max(g.peak, v);
          },
        },
        connect(t: unknown) {
          g.target = t;
        },
      };
      return g;
    },
    createOscillator() {
      const n = { freq: 0, type: "sine", start: -1, stop: -1, peak: 0, reachesOut: false };
      let gainNode: { target: unknown; peak: number } | undefined;
      notes.push(n);
      return {
        get type() {
          return n.type;
        },
        set type(t: string) {
          n.type = t;
        },
        frequency: {
          setValueAtTime(v: number) {
            n.freq = v;
          },
        },
        connect(t: unknown) {
          gainNode = t as { target: unknown; peak: number };
        },
        start(t: number) {
          n.start = t;
        },
        stop(t: number) {
          n.stop = t;
          n.peak = gainNode?.peak ?? 0;
          n.reachesOut = gainNode?.target === ctx.destination;
        },
      };
    },
  };
  return { ctx, notes };
}

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

const make = (state: "running" | "suspended" = "running", storage = memory()) => {
  const a = fakeAudio(state);
  let created = 0;
  const sounds = new Sounds({
    create: () => {
      created++;
      return a.ctx as unknown as AudioLike;
    },
    storage,
  });
  return { ...a, sounds, created: () => created, storage };
};

describe("som de quando o desenho termina", () => {
  it("toca as notas do aviso de concluído, uma depois da outra, subindo", () => {
    const { sounds, notes } = make();
    expect(sounds.play("done")).toBe(true);
    expect(notes.length).toBe(TONES.done.length);
    expect(notes.length).toBeGreaterThanOrEqual(3);
    const freqs = notes.map((n) => n.freq);
    expect([...freqs].sort((a, b) => a - b)).toEqual(freqs); // sobe: soa como "deu certo"
    const starts = notes.map((n) => n.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(starts[0]).toBeGreaterThanOrEqual(10); // a partir de agora, no relógio do áudio
  });

  it("cada nota começa, termina e chega no alto-falante, num volume que não assusta", () => {
    const { sounds, notes } = make();
    sounds.play("done");
    for (const n of notes) {
      expect(n.stop).toBeGreaterThan(n.start);
      expect(n.reachesOut).toBe(true);
      expect(n.peak).toBeGreaterThan(0.03);
      expect(n.peak).toBeLessThanOrEqual(0.4);
    }
  });

  it("o aviso inteiro é curto: um barulhinho, não um alarme", () => {
    const { sounds, notes } = make();
    sounds.play("done");
    expect(Math.max(...notes.map((n) => n.stop)) - 10).toBeLessThan(2.5);
  });

  it("o som de falha é outro: desce em vez de subir", () => {
    const { sounds, notes } = make();
    sounds.play("failed");
    const freqs = notes.map((n) => n.freq);
    expect(freqs.length).toBeGreaterThanOrEqual(2);
    expect([...freqs].sort((a, b) => b - a)).toEqual(freqs);
    expect(freqs).not.toEqual(TONES.done.map((t) => t.freq));
  });

  it("desligado, não toca nada", () => {
    const { sounds, notes } = make();
    sounds.setEnabled(false);
    expect(sounds.play("done")).toBe(false);
    expect(notes.length).toBe(0);
  });

  it("vem ligado, e a escolha de desligar fica guardada para a próxima vez", () => {
    const storage = memory();
    const first = make("running", storage);
    expect(first.sounds.enabled).toBe(true);
    first.sounds.setEnabled(false);
    expect(make("running", storage).sounds.enabled).toBe(false);
    first.sounds.setEnabled(true);
    expect(make("running", storage).sounds.enabled).toBe(true);
  });

  it("preparar o som num clique acorda o áudio do navegador, e tocar depois usa o mesmo", () => {
    const { sounds, ctx, created } = make("suspended");
    sounds.arm();
    expect(ctx.resumed).toBe(1);
    sounds.play("done");
    sounds.play("done");
    expect(created()).toBe(1);
  });

  it("se o áudio estiver dormindo na hora de tocar, acorda antes", () => {
    const { sounds, ctx, notes } = make("suspended");
    expect(sounds.play("done")).toBe(true);
    expect(ctx.resumed).toBe(1);
    expect(notes.length).toBe(TONES.done.length);
  });

  it("navegador sem áudio, ou que se recusa a criar: não toca e não quebra nada", () => {
    expect(new Sounds({ create: () => undefined, storage: memory() }).play("done")).toBe(false);
    const broken = new Sounds({
      create: () => {
        throw new Error("sem áudio");
      },
      storage: memory(),
    });
    expect(() => broken.arm()).not.toThrow();
    expect(broken.play("done")).toBe(false);
  });

  it("navegador que bloqueia o armazenamento: o som funciona, só não guarda a escolha", () => {
    const blocked = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
      removeItem: () => {
        throw new Error("bloqueado");
      },
    };
    const a = fakeAudio();
    const sounds = new Sounds({ create: () => a.ctx as unknown as AudioLike, storage: blocked });
    expect(sounds.enabled).toBe(true);
    expect(() => sounds.setEnabled(false)).not.toThrow();
    expect(sounds.enabled).toBe(false);
  });
});
