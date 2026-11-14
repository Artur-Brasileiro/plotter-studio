import { dist, type Vec } from "../geometry/vec";
import type { OrderedStroke, Stroke } from "./types";

export interface OrderOptions {
  /** Onde a caneta está ao começar (mm da máquina) */
  readonly start: Vec;
  /** Pontas mais próximas que isto: liga sem levantar a caneta */
  readonly joinGapMm: number;
  /** Pode desenhar um traço aberto de trás para frente */
  readonly allowReverse: boolean;
  /** Um laço fechado pode começar em qualquer vértice */
  readonly rotateClosed: boolean;
}

const CELL = 10; // mm
const MAX_LOOP_ENTRIES = 64;

interface Entry {
  readonly stroke: number;
  /** Índice do vértice de entrada (laço) ou −1 = fim do traço aberto (invertido) */
  readonly vertex: number;
  readonly x: number;
  readonly y: number;
  readonly order: number;
}

/** Grade uniforme com os pontos de entrada de cada traço. */
class Grid {
  private readonly cells = new Map<number, Entry[]>();
  private minCx = Infinity;
  private minCy = Infinity;
  private maxCx = -Infinity;
  private maxCy = -Infinity;

  private key(cx: number, cy: number): number {
    return (cx + 100_000) * 200_003 + (cy + 100_000);
  }

  add(e: Entry): void {
    const cx = Math.floor(e.x / CELL);
    const cy = Math.floor(e.y / CELL);
    const k = this.key(cx, cy);
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(e);
    if (cx < this.minCx) this.minCx = cx;
    if (cy < this.minCy) this.minCy = cy;
    if (cx > this.maxCx) this.maxCx = cx;
    if (cy > this.maxCy) this.maxCy = cy;
  }

  /** Entrada mais próxima de p entre traços não usados. Empate: menor índice de traço, depois ordem de inserção. */
  nearest(p: Vec, used: Uint8Array): Entry | undefined {
    const pcx = Math.floor(p.x / CELL);
    const pcy = Math.floor(p.y / CELL);
    const maxR = Math.max(pcx - this.minCx, this.maxCx - pcx, pcy - this.minCy, this.maxCy - pcy);
    let best: Entry | undefined;
    let bestD = Infinity;
    const consider = (cx: number, cy: number) => {
      const list = this.cells.get(this.key(cx, cy));
      if (!list) return;
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (used[e.stroke]) continue; // limpeza preguiçosa
        list[w++] = e;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (
          d < bestD - 1e-9 ||
          (Math.abs(d - bestD) <= 1e-9 && best && (e.stroke < best.stroke || (e.stroke === best.stroke && e.order < best.order)))
        ) {
          best = e;
          bestD = d;
        }
      }
      list.length = w;
    };
    for (let r = 0; r <= maxR; r++) {
      if (r === 0) consider(pcx, pcy);
      else {
        for (let dx = -r; dx <= r; dx++) {
          consider(pcx + dx, pcy - r);
          consider(pcx + dx, pcy + r);
        }
        for (let dy = -r + 1; dy <= r - 1; dy++) {
          consider(pcx - r, pcy + dy);
          consider(pcx + r, pcy + dy);
        }
      }
      // tudo que está nos anéis seguintes fica a pelo menos r·CELL de p
      if (best && bestD <= r * CELL) break;
    }
    return best;
  }
}

function orient(s: Stroke, e: Entry): Stroke {
  if (e.vertex === -1) return { ...s, points: [...s.points].reverse() };
  if (e.vertex <= 0) return s;
  const pts = s.points; // fechado: pts[0] === pts[n−1]
  const k = e.vertex;
  const rotated = [...pts.slice(k, pts.length - 1), ...pts.slice(0, k), pts[k]];
  return { ...s, points: rotated };
}

/**
 * Vizinho mais próximo com inversão de traços abertos, rotação de laços e junção de pontas.
 * Grade espacial de 10 mm: ~20 mil traços em bem menos de 1 s. Saída determinística.
 */
export function orderStrokes(strokes: readonly Stroke[], opts: OrderOptions): OrderedStroke[] {
  const grid = new Grid();
  let order = 0;
  strokes.forEach((s, i) => {
    const pts = s.points;
    if (pts.length === 0) return;
    const n = pts.length;
    if (s.closed && opts.rotateClosed && n > 2) {
      const verts = n - 1;
      const step = Math.max(1, Math.ceil(verts / MAX_LOOP_ENTRIES));
      for (let v = 0; v < verts; v += step) grid.add({ stroke: i, vertex: v, x: pts[v].x, y: pts[v].y, order: order++ });
    } else {
      grid.add({ stroke: i, vertex: 0, x: pts[0].x, y: pts[0].y, order: order++ });
      if (!s.closed && opts.allowReverse && n > 1) grid.add({ stroke: i, vertex: -1, x: pts[n - 1].x, y: pts[n - 1].y, order: order++ });
    }
  });

  const used = new Uint8Array(strokes.length);
  const out: OrderedStroke[] = [];
  let cur = opts.start;
  for (let count = 0; count < strokes.length; count++) {
    const e = grid.nearest(cur, used);
    if (!e) break;
    used[e.stroke] = 1;
    const s = orient(strokes[e.stroke], e);
    const joined = out.length > 0 && dist(cur, s.points[0]) < opts.joinGapMm;
    out.push({ ...s, joinedToPrevious: joined });
    cur = s.points[s.points.length - 1];
  }
  // traços vazios (sem pontos) não entram
  return out;
}

/** Otimização desligada: ordem do documento, só marca as junções. */
export function keepOrder(strokes: readonly Stroke[], joinGapMm: number): OrderedStroke[] {
  const out: OrderedStroke[] = [];
  let prevEnd: Vec | undefined;
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    out.push({ ...s, joinedToPrevious: !!prevEnd && dist(prevEnd, s.points[0]) < joinGapMm });
    prevEnd = s.points[s.points.length - 1];
  }
  return out;
}

/** Deslocamento com a caneta levantada: do início ao 1º traço, entre traços não unidos e (se dado) até o fim. */
export function travelLength(strokes: readonly (Stroke & { joinedToPrevious?: boolean })[], start: Vec, end?: Vec): number {
  let total = 0;
  let cur = start;
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    if (!s.joinedToPrevious) total += dist(cur, s.points[0]);
    cur = s.points[s.points.length - 1];
  }
  if (end) total += dist(cur, end);
  return total;
}
