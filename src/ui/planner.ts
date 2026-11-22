import { auditGcode, type AuditReport } from "../core/job/audit";
import { generateGcode, type GcodeProgram } from "../core/job/gcode";
import { planJob } from "../core/job/pipeline";
import type { JobPlan } from "../core/job/types";
import type { Store } from "../core/store";

/** O plano, o G-code que sai dele e a conferência desse G-code. */
export interface Review {
  readonly plan: JobPlan;
  /** undefined quando há desenho fora da área: o gerador recusa */
  readonly program?: GcodeProgram;
  readonly audit?: AuditReport;
}

/**
 * Recalcula o plano (traços, ordem, velocidades, agenda do servo) 300 ms depois da última mudança
 * no documento, no trabalho ou no perfil, e avisa quem estiver ouvindo (painéis, pré-visualização, rodapé).
 * A conferência (gerar o G-code e auditá-lo) é feita só quando alguém pede, uma vez por plano.
 */
export class Planner {
  private current: JobPlan | undefined;
  private reviewed: Review | undefined;
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

  /** Nome dos desenhos, para o cabeçalho do G-code. */
  jobName(): string {
    return this.store.doc.drawings.map((d) => d.name).join(" + ");
  }

  /** Gera o G-code do plano atual (inteiro ou uma parte). Lança se houver desenho fora da área. */
  program(part?: number): GcodeProgram | undefined {
    const plan = this.current;
    if (!plan) return undefined;
    return generateGcode(plan, this.store.state.profile, { fileName: this.jobName(), date: new Date(), job: this.store.state.job }, { part });
  }

  /** Plano + G-code + auditoria do plano atual. */
  review(): Review | undefined {
    const plan = this.current;
    if (!plan) return undefined;
    if (this.reviewed?.plan === plan) return this.reviewed;
    let program: GcodeProgram | undefined;
    let audit: AuditReport | undefined;
    if (plan.violations.length === 0) {
      try {
        program = this.program();
        if (program) audit = auditGcode(program.lines.map((l) => l.text), this.store.state.profile);
      } catch (e) {
        console.error("conferência falhou", e);
      }
    }
    this.reviewed = { plan, program, audit };
    return this.reviewed;
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
    this.reviewed = undefined;
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
