/** Relógio injetável: o controlador e o simulador usam este, para os testes rodarem em tempo virtual. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
  clearInterval: (id) => globalThis.clearInterval(id),
};

interface Timer {
  id: number;
  due: number;
  seq: number;
  every?: number;
  fn: () => void;
}

/**
 * Relógio virtual para testes: o tempo só anda com `advance(ms)`, que dispara os timers na ordem
 * e deixa as promessas (microtarefas) resolverem entre um timer e outro.
 */
export class ManualClock implements Clock {
  private t = 0;
  private seq = 0;
  private nextId = 1;
  private timers = new Map<number, Timer>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.t + Math.max(0, ms), seq: this.seq++, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  setInterval(fn: () => void, ms: number): number {
    const every = Math.max(1, ms);
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.t + every, seq: this.seq++, every, fn });
    return id;
  }

  clearInterval(id: number): void {
    this.timers.delete(id);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Avança `ms` de tempo virtual. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await flushMicrotasks();
    for (;;) {
      let next: Timer | undefined;
      for (const tm of this.timers.values()) {
        if (tm.due <= target && (!next || tm.due < next.due || (tm.due === next.due && tm.seq < next.seq))) next = tm;
      }
      if (!next) break;
      this.t = next.due;
      if (next.every !== undefined) {
        next.due += next.every;
        next.seq = this.seq++;
      } else this.timers.delete(next.id);
      next.fn();
      await flushMicrotasks();
    }
    this.t = target;
    await flushMicrotasks();
  }

  /** Avança em passos até `cond()` ficar verdadeira (ou estourar `maxMs`). Devolve se conseguiu. */
  async advanceUntil(cond: () => boolean, maxMs: number, stepMs = 10): Promise<boolean> {
    const end = this.t + maxMs;
    while (!cond()) {
      if (this.t >= end) return false;
      await this.advance(Math.min(stepMs, end - this.t));
    }
    return true;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
