import { EMPTY_DOCUMENT, type DrawingId, type PlotDocument } from "./document";
import { commit, createHistory, redo, undo, type History } from "./history";
import { DEFAULT_PROFILE, type MachineProfile } from "./machine";

export interface JobSettings {
  readonly speedMode: "fixed" | "dynamic";
  /** mm/min */
  readonly fixedFeed: number;
  readonly optimize: boolean;
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  speedMode: "dynamic",
  fixedFeed: DEFAULT_PROFILE.feed.fixed,
  optimize: true,
};

export interface AppState {
  /** O documento é history.present.state */
  readonly history: History<PlotDocument>;
  readonly selection: readonly DrawingId[];
  readonly job: JobSettings;
  readonly profile: MachineProfile;
}

export type Listener = (state: AppState, prev: AppState) => void;

export function initialState(profile: MachineProfile = DEFAULT_PROFILE, job: JobSettings = DEFAULT_JOB_SETTINGS): AppState {
  return { history: createHistory(EMPTY_DOCUMENT), selection: [], job, profile };
}

/** Estado da aplicação + assinaturas. Puro: o relógio é injetável (para o coalesce do histórico). */
export class Store {
  private s: AppState;
  private readonly listeners = new Set<Listener>();
  private readonly clock: { now(): number };

  constructor(initial: AppState = initialState(), clock: { now(): number } = { now: () => Date.now() }) {
    this.s = initial;
    this.clock = clock;
  }

  get state(): AppState {
    return this.s;
  }

  get doc(): PlotDocument {
    return this.s.history.present.state;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private set(next: AppState) {
    if (next === this.s) return;
    const prev = this.s;
    this.s = next;
    for (const l of [...this.listeners]) l(next, prev);
  }

  /** Mantém na seleção só ids que existem no documento. */
  private withDoc(history: History<PlotDocument>): AppState {
    const ids = new Set(history.present.state.drawings.map((d) => d.id));
    const selection = this.s.selection.filter((id) => ids.has(id));
    return { ...this.s, history, selection: selection.length === this.s.selection.length ? this.s.selection : selection };
  }

  /** Aplica uma mudança no documento como uma entrada do histórico. Não faz nada se f devolver o mesmo doc. */
  commit(label: string, f: (doc: PlotDocument) => PlotDocument, opts: { coalesceKey?: string } = {}): void {
    const next = f(this.doc);
    if (next === this.doc) return;
    this.set(this.withDoc(commit(this.s.history, next, label, { now: this.clock.now(), coalesceKey: opts.coalesceKey })));
  }

  undo(): void {
    const h = undo(this.s.history);
    if (h !== this.s.history) this.set(this.withDoc(h));
  }

  redo(): void {
    const h = redo(this.s.history);
    if (h !== this.s.history) this.set(this.withDoc(h));
  }

  /** Restauração de sessão: troca o documento e zera o histórico. */
  replaceDocument(doc: PlotDocument): void {
    this.set({ ...this.s, history: createHistory(doc), selection: [] });
  }

  setSelection(ids: readonly DrawingId[]): void {
    const same = ids.length === this.s.selection.length && ids.every((id, i) => id === this.s.selection[i]);
    if (!same) this.set({ ...this.s, selection: [...ids] });
  }

  setJob(patch: Partial<JobSettings>): void {
    this.set({ ...this.s, job: { ...this.s.job, ...patch } });
  }

  setProfile(p: MachineProfile): void {
    this.set({ ...this.s, profile: p });
  }
}
