import { planJob } from "../core/job/pipeline";
import type { JobPlan } from "../core/job/types";
import type { Store } from "../core/store";

/**
 * Recalcula o plano (traços, ordem, velocidades, tempo) 300 ms depois da última mudança
 * no documento, no trabalho ou no perfil, e avisa quem estiver ouvindo (painel, pré-visualização, rodapé).
 */
export class Planner {
  private current: JobPlan | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(plan: JobPlan | undefined) => void>();

  constructor(private readonly store: Store, delayMs = 300) {
    store.subscribe((s, prev) => {
      if (s.history.present !== prev.history.present || s.job !== prev.job || s.profile !== prev.profile) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.recompute(), delayMs);
      }
    });
    this.recompute();
  }

  get plan(): JobPlan | undefined {
    return this.current;
  }

  /** Plano atualizado na hora (para exportar sem esperar o debounce). */
  fresh(): JobPlan | undefined {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.recompute();
    }
    return this.current;
  }

  subscribe(l: (plan: JobPlan | undefined) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private recompute(): void {
    this.timer = undefined;
    const { profile, job } = this.store.state;
    const doc = this.store.doc;
    try {
      this.current = doc.drawings.length ? planJob(doc, profile, job) : undefined;
    } catch (e) {
      console.error("planJob falhou", e);
      this.current = undefined;
    }
    for (const l of [...this.listeners]) l(this.current);
  }
}

export function fmtDuration(s: number): string {
  if (s < 10) return `${(Math.round(s * 10) / 10).toLocaleString("pt-BR")} s`;
  const total = Math.round(s);
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return sec ? `${m} min ${String(sec).padStart(2, "0")} s` : `${m} min`;
}

export function fmtLength(mm: number): string {
  if (mm >= 1000) return `${(mm / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`;
  return `${Math.round(mm).toLocaleString("pt-BR")} mm`;
}
