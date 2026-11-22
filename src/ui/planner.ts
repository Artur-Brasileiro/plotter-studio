import { auditGcode, auditOptionsOf, type AuditReport } from "../core/job/audit";
import { generateGcode, type GcodeProgram } from "../core/job/gcode";
import { planLayers } from "../core/job/pipeline";
import type { JobPlan } from "../core/job/types";
import { penOf } from "../core/machine";
import type { Store } from "../core/store";

/** O plano, o G-code que sai dele e a conferência desse G-code. */
export interface Review {
  readonly plan: JobPlan;
  /** undefined quando há desenho fora da área: o gerador recusa */
  readonly program?: GcodeProgram;
  readonly audit?: AuditReport;
}

export type LayerStatus = "ok" | "warn" | "bad";

/**
 * Recalcula os planos (traços, ordem, velocidades, agenda do servo) 300 ms depois da última mudança
 * no documento, no trabalho ou no perfil, e avisa quem estiver ouvindo (painéis, pré-visualização, rodapé).
 *
 * Um plano por CAMADA (caneta), na ordem de plotagem. Quase todo desenho tem uma camada só; quando há
 * mais, uma delas é a "ativa": é a que os painéis conferem, mostram na pré-visualização e enviam.
 * A conferência (gerar o G-code e auditá-lo) é feita só quando alguém pede, uma vez por plano.
 */
export class Planner {
  private plans: readonly JobPlan[] = [];
  private activePen: string | undefined;
  private reviews = new WeakMap<JobPlan, Review>();
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

  /** O plano da camada ativa. */
  get plan(): JobPlan | undefined {
    return this.plans.find((p) => p.layer?.penId === this.activePen) ?? this.plans[0];
  }

  /** Todos os planos, na ordem de plotagem (cor → fina → grossa). */
  get layers(): readonly JobPlan[] {
    return this.plans;
  }

  /** Escolhe a camada que os painéis mostram e enviam. */
  setLayer(penId: string): void {
    if (!this.plans.some((p) => p.layer?.penId === penId) || this.plan?.layer?.penId === penId) return;
    this.activePen = penId;
    this.notify();
  }

  /** Plano atualizado na hora (para exportar sem esperar o debounce). */
  fresh(): JobPlan | undefined {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.recompute();
    }
    return this.plan;
  }

  /** Nomes dos desenhos de uma camada (padrão: a ativa). */
  drawingNames(plan: JobPlan | undefined = this.plan): string[] {
    const { profile } = this.store.state;
    const all = this.store.doc.drawings;
    const layer = plan?.layer;
    const mine = layer && layer.count > 1 ? all.filter((d) => penOf(profile, d.penId).id === layer.penId) : all;
    return mine.map((d) => d.name);
  }

  /** Nome do trabalho, para o cabeçalho do G-code e o histórico. */
  jobName(plan: JobPlan | undefined = this.plan): string {
    return this.drawingNames(plan).join(" + ");
  }

  /** Gera o G-code de um plano (inteiro ou uma parte). Lança se houver desenho fora da área. */
  program(part?: number, plan: JobPlan | undefined = this.plan): GcodeProgram | undefined {
    if (!plan) return undefined;
    return generateGcode(plan, this.store.state.profile, { fileName: this.jobName(plan), date: new Date(), job: this.store.state.job }, { part });
  }

  /** Plano + G-code + auditoria (padrão: da camada ativa). */
  review(plan: JobPlan | undefined = this.plan): Review | undefined {
    if (!plan) return undefined;
    const hit = this.reviews.get(plan);
    if (hit) return hit;
    let program: GcodeProgram | undefined;
    let audit: AuditReport | undefined;
    if (plan.violations.length === 0) {
      try {
        program = this.program(undefined, plan);
        if (program) audit = auditGcode(program.lines.map((l) => l.text), this.store.state.profile, auditOptionsOf(plan));
      } catch (e) {
        console.error("conferência falhou", e);
      }
    }
    const review = { plan, program, audit };
    this.reviews.set(plan, review);
    return review;
  }

  /** Pode ir para a máquina? ok, com atenção, ou não. */
  status(plan: JobPlan | undefined = this.plan): LayerStatus | undefined {
    if (!plan) return undefined;
    const audit = this.review(plan)?.audit;
    if (!audit || !audit.ok) return "bad";
    return audit.problems.length ? "warn" : "ok";
  }

  subscribe(l: (plan: JobPlan | undefined) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(): void {
    const plan = this.plan;
    for (const l of [...this.listeners]) l(plan);
  }

  private recompute(): void {
    this.timer = undefined;
    const { profile, job } = this.store.state;
    const doc = this.store.doc;
    try {
      this.plans = planLayers(doc, profile, job);
    } catch (e) {
      console.error("planJob falhou", e);
      this.plans = [];
    }
    this.notify();
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
