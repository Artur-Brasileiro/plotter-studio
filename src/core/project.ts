import { createDrawing, type PlotDocument } from "./document";
import type { Mat2D } from "./geometry/mat2d";
import type { Segment, SubPath } from "./geometry/path";

export const PROJECT_FORMAT = "plotter-studio-project";

export interface ProjectFileV1 {
  readonly format: typeof PROJECT_FORMAT;
  readonly version: 1;
  /** ISO 8601 */
  readonly savedAt: string;
  readonly drawings: readonly {
    readonly id: string;
    readonly name: string;
    /** Caneta do desenho (ausente = a padrão do perfil) */
    readonly pen?: string;
    /** Conjunto (camadas da mesma imagem); ausente = desenho solto */
    readonly group?: string;
    /** 6 números (Mat2D) */
    readonly transform: readonly number[];
    readonly subpaths: readonly {
      readonly start: readonly [number, number];
      readonly closed: boolean;
      /** [x,y] = reta; [x1,y1,x2,y2,x,y] = cúbica */
      readonly segs: readonly (readonly number[])[];
    }[];
  }[];
}

export function serializeDocument(doc: PlotDocument, now: Date): ProjectFileV1 {
  return {
    format: PROJECT_FORMAT,
    version: 1,
    savedAt: now.toISOString(),
    drawings: doc.drawings.map((d) => ({
      id: d.id,
      name: d.name,
      ...(d.penId ? { pen: d.penId } : {}),
      ...(d.group ? { group: d.group } : {}),
      transform: [...d.transform],
      subpaths: d.geometry.subpaths.map((sp) => ({
        start: [sp.start.x, sp.start.y] as const,
        closed: sp.closed,
        segs: sp.segments.map((s) => (s.kind === "line" ? [s.to.x, s.to.y] : [s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y])),
      })),
    })),
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumArray = (v: unknown, len?: number): v is number[] =>
  Array.isArray(v) && (len === undefined || v.length === len) && v.every(isNum);

/** Valida e reconstrói o documento. Lança Error com mensagem em português. */
export function deserializeDocument(data: unknown): PlotDocument {
  const fail = (msg: string): never => {
    throw new Error(`Projeto inválido: ${msg}`);
  };
  if (typeof data !== "object" || data === null) fail("não é um objeto JSON.");
  const f = data as Record<string, unknown>;
  if (f.format !== PROJECT_FORMAT) fail("não é um arquivo do Plotter Studio.");
  if (f.version !== 1) fail(`versão ${String(f.version)} não suportada (esperava 1).`);
  if (!Array.isArray(f.drawings)) fail("lista de desenhos ausente.");

  const drawings = (f.drawings as unknown[]).map((raw, i) => {
    const d = raw as Record<string, unknown>;
    const where = `desenho ${i + 1}`;
    if (typeof d.id !== "string" || !d.id) fail(`${where}: id ausente.`);
    if (typeof d.name !== "string") fail(`${where}: nome ausente.`);
    if (!isNumArray(d.transform, 6)) fail(`${where}: transform tem que ter 6 números.`);
    if (!Array.isArray(d.subpaths)) fail(`${where}: subpaths ausentes.`);
    const subpaths: SubPath[] = (d.subpaths as unknown[]).map((rawSp, j) => {
      const sp = rawSp as Record<string, unknown>;
      if (!isNumArray(sp.start, 2)) fail(`${where}, subpath ${j + 1}: início inválido.`);
      if (!Array.isArray(sp.segs)) fail(`${where}, subpath ${j + 1}: segmentos ausentes.`);
      const start = { x: (sp.start as number[])[0], y: (sp.start as number[])[1] };
      const segments: Segment[] = (sp.segs as unknown[]).map((s) => {
        if (isNumArray(s, 2)) return { kind: "line", to: { x: s[0], y: s[1] } };
        if (isNumArray(s, 6)) return { kind: "cubic", c1: { x: s[0], y: s[1] }, c2: { x: s[2], y: s[3] }, to: { x: s[4], y: s[5] } };
        return fail(`${where}, subpath ${j + 1}: segmento inválido.`);
      });
      const closed = sp.closed === true;
      if (closed && segments.length > 0) {
        const last = segments[segments.length - 1];
        if (last.to.x === start.x && last.to.y === start.y) segments[segments.length - 1] = { ...last, to: start };
      }
      return { start, segments, closed };
    });
    const t = d.transform as number[];
    const m: Mat2D = [t[0], t[1], t[2], t[3], t[4], t[5]];
    const pen = typeof d.pen === "string" && d.pen ? d.pen : undefined;
    const group = typeof d.group === "string" && d.group ? d.group : undefined;
    return createDrawing(d.id as string, d.name as string, { subpaths }, m, pen, group);
  });
  return { drawings };
}
