/**
 * Desfazer/refazer por snapshots imutáveis. Como a geometria é compartilhada por
 * referência entre snapshots, cada entrada custa só um array de desenhos.
 */
export interface HistoryEntry<T> {
  readonly state: T;
  /** Rótulo da ação que levou a este estado ("Mover", "Importar"...) */
  readonly label: string;
}

export interface History<T> {
  /** Mais antigo primeiro */
  readonly past: readonly HistoryEntry<T>[];
  readonly present: HistoryEntry<T>;
  /** Próximo a refazer primeiro */
  readonly future: readonly HistoryEntry<T>[];
  readonly lastCoalesce?: { readonly key: string; readonly at: number };
}

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 800;

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: { state: initial, label: "" }, future: [] };
}

/** Mesmo coalesceKey em menos de 800 ms → substitui o present em vez de empilhar (setas, digitação). */
export function commit<T>(
  h: History<T>,
  next: T,
  label: string,
  opts: { now: number; coalesceKey?: string; limit?: number },
): History<T> {
  if (next === h.present.state) return h;
  const key = opts.coalesceKey;
  const lastCoalesce = key ? { key, at: opts.now } : undefined;
  if (key && h.lastCoalesce?.key === key && opts.now - h.lastCoalesce.at < COALESCE_MS && h.past.length > 0) {
    return { past: h.past, present: { state: next, label }, future: [], lastCoalesce };
  }
  const limit = opts.limit ?? HISTORY_LIMIT;
  const past = [...h.past, h.present];
  if (past.length > limit) past.splice(0, past.length - limit);
  return { past, present: { state: next, label }, future: [], lastCoalesce };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const prev = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest };
}

export function canUndo(h: History<unknown>): boolean {
  return h.past.length > 0;
}

export function canRedo(h: History<unknown>): boolean {
  return h.future.length > 0;
}

/** Rótulo do que seria desfeito (a ação que gerou o estado atual). */
export function undoLabel(h: History<unknown>): string | undefined {
  return h.past.length > 0 ? h.present.label : undefined;
}

export function redoLabel(h: History<unknown>): string | undefined {
  return h.future[0]?.label;
}
