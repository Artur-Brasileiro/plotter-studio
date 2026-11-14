/** Tempo real × estimado de cada trabalho enviado (localStorage "plotter-studio:runs", últimos 20). */
export interface RunRecord {
  /** ISO 8601 */
  readonly at: string;
  readonly name: string;
  readonly estimatedS: number;
  readonly realS: number;
  readonly result: "finished" | "stopped" | "failed";
  readonly lines: number;
}

const KEY = "plotter-studio:runs";
const MAX = 20;

export function loadRuns(): RunRecord[] {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(d) ? d.filter((r) => r && typeof r.realS === "number" && typeof r.estimatedS === "number") : [];
  } catch {
    return [];
  }
}

export function addRun(r: RunRecord): RunRecord[] {
  const runs = [r, ...loadRuns()].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(runs));
  } catch {
    /* sem armazenamento: só não guarda */
  }
  return runs;
}
