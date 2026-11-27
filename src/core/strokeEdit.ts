import { createDrawing, removeDrawings, type Drawing, type DrawingId, type PlotDocument } from "./document";
import { flattenSubPath } from "./geometry/flatten";
import { IDENTITY, invert, multiply, nearlyEqualMat, type Mat2D } from "./geometry/mat2d";
import { controlBBox, transformGeometry, type Geometry, type Segment, type SubPath } from "./geometry/path";
import type { Vec } from "./geometry/vec";
import { penOf, type MachineProfile } from "./machine";

/**
 * Apagar traços soltos de um desenho que já está na mesa (a tela é src/ui/strokeEditor.ts).
 *
 * Um "traço" aqui é um subcaminho do desenho: uma descida da caneta. Este arquivo é puro (sem DOM):
 *  - `sceneStrokes` entrega os traços de um desenho como estão na mesa, em mm;
 *  - `StrokeIndex` acha o traço embaixo do mouse, ou dentro de um retângulo, sem olhar um por um;
 *  - `removeSubpaths` / `removeStrokes` devolvem o documento sem os traços escolhidos.
 */

/** Um traço na mesa: de que desenho e de que subcaminho veio, por onde passa e quanto mede no papel. */
export interface EditStroke {
  readonly drawingId: DrawingId;
  /** Posição do subcaminho em `drawing.geometry.subpaths` */
  readonly subpath: number;
  /** Polilinha em mm da cena: x0, y0, x1, y1, ... */
  readonly points: Float64Array;
  readonly lengthMm: number;
}

/** Comprimento de uma polilinha escrita como x0, y0, x1, y1, ... */
export function polylineLength(points: ArrayLike<number>): number {
  let L = 0;
  for (let i = 2; i + 1 < points.length; i += 2) L += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  return L;
}

/**
 * Os traços de um desenho, já na posição e no tamanho em que estão na mesa (mm da cena, Y para baixo).
 * As curvas viram polilinhas com erro de no máximo `tolMm`. Subcaminho sem traço (só o ponto de
 * partida) não entra, mas a numeração dos outros continua a do desenho.
 */
export function sceneStrokes(d: Drawing, tolMm = 0.05): EditStroke[] {
  const out: EditStroke[] = [];
  transformGeometry(d.geometry, d.transform).subpaths.forEach((sp, subpath) => {
    if (sp.segments.length === 0) return;
    const pl = flattenSubPath(sp, tolMm).points;
    const points = new Float64Array(pl.length * 2);
    for (let i = 0; i < pl.length; i++) {
      points[2 * i] = pl[i].x;
      points[2 * i + 1] = pl[i].y;
    }
    out.push({ drawingId: d.id, subpath, points, lengthMm: polylineLength(points) });
  });
  return out;
}

/**
 * Tira de um desenho os subcaminhos indicados. O desenho continua o mesmo (id, nome, posição, caneta);
 * só a geometria e a caixa mudam. Se não sobrar traço nenhum, o desenho sai da mesa.
 * Sem nada para tirar, devolve o MESMO documento (o histórico não ganha uma entrada vazia).
 */
export function removeSubpaths(doc: PlotDocument, drawingId: DrawingId, indices: Iterable<number>): PlotDocument {
  const d = doc.drawings.find((x) => x.id === drawingId);
  if (!d) return doc;
  const drop = new Set<number>();
  for (const i of indices) if (Number.isInteger(i) && i >= 0 && i < d.geometry.subpaths.length) drop.add(i);
  if (drop.size === 0) return doc;
  const subpaths = d.geometry.subpaths.filter((_, i) => !drop.has(i));
  if (!subpaths.some((sp) => sp.segments.length > 0)) return removeDrawings(doc, [drawingId]);
  const geometry = { subpaths };
  const next: Drawing = { ...d, geometry, localBBox: controlBBox(geometry) };
  return { drawings: doc.drawings.map((x) => (x === d ? next : x)) };
}

/** O mesmo, para vários desenhos de uma vez (desenho → subcaminhos a tirar): vira UMA mudança no documento. */
export function removeStrokes(doc: PlotDocument, removals: ReadonlyMap<DrawingId, Iterable<number>>): PlotDocument {
  let out = doc;
  for (const [id, indices] of removals) out = removeSubpaths(out, id, indices);
  return out;
}

/**
 * O que a tela faz com cada traço: `null` = apagar; um id de caneta = passar o traço para essa caneta.
 * Desenho → (subcaminho → destino).
 */
export type StrokeEdits = ReadonlyMap<DrawingId, ReadonlyMap<number, string | null>>;

/**
 * Apaga traços e passa traços para outra caneta, numa mudança só no documento.
 *
 * Passar para outra caneta = criar subcamadas: os traços saem do desenho e entram na camada daquela
 * caneta no MESMO conjunto (`Drawing.group`). Se o conjunto ainda não tem camada dessa caneta, ela nasce
 * com a posição do desenho de origem, logo depois da última camada do conjunto. Um desenho solto que
 * ganha uma subcamada passa a ser um conjunto (as duas camadas andam juntas na mesa).
 * Os traços continuam exatamente onde estavam no papel, mesmo que a camada de destino tenha outra matriz.
 *
 * Destino igual à caneta que o desenho já usa não muda nada. Desenho que fica sem traço sai da mesa.
 * Sem nada para mudar, devolve o MESMO documento. `newId` dá as ids das camadas novas e dos conjuntos novos.
 */
export function applyStrokeEdits(doc: PlotDocument, edits: StrokeEdits, profile: MachineProfile, newId: () => string): PlotDocument {
  let drawings = doc.drawings.slice();
  let changed = false;
  for (const [id, perStroke] of edits) {
    const at = drawings.findIndex((x) => x.id === id);
    if (at < 0) continue;
    const d = drawings[at];
    const own = penOf(profile, d.penId).id;
    const drop = new Set<number>();
    const byPen = new Map<string, number[]>();
    for (const [i, to] of perStroke) {
      if (!Number.isInteger(i) || i < 0 || i >= d.geometry.subpaths.length || to === own) continue;
      if (to !== null && !profile.pens.some((p) => p.id === to)) continue; // caneta que não existe mais no perfil
      drop.add(i);
      if (to === null) continue;
      const list = byPen.get(to);
      if (list) list.push(i);
      else byPen.set(to, [i]);
    }
    if (drop.size === 0) continue;
    changed = true;
    const group = d.group ?? (byPen.size > 0 ? newId() : undefined);
    const subpaths = d.geometry.subpaths.filter((_, i) => !drop.has(i));
    if (subpaths.some((sp) => sp.segments.length > 0)) {
      const geometry = { subpaths };
      drawings[at] = { ...d, geometry, localBBox: controlBBox(geometry), ...(group ? { group } : {}) };
    } else drawings.splice(at, 1);

    for (const [pen, list] of byPen) {
      const moved = { subpaths: list.sort((a, b) => a - b).map((i) => d.geometry.subpaths[i]) };
      const ti = drawings.findIndex((x) => x.group === group && x.id !== d.id && penOf(profile, x.penId).id === pen);
      if (ti >= 0) {
        // a camada que já existe: os traços entram no fim dela, na posição em que estavam no papel
        const t = drawings[ti];
        const m = multiply(invert(t.transform), d.transform);
        const extra = nearlyEqualMat(m, IDENTITY) ? moved : transformGeometry(moved, m);
        const geometry = { subpaths: [...t.geometry.subpaths, ...extra.subpaths] };
        drawings[ti] = { ...t, geometry, localBBox: controlBBox(geometry) };
      } else {
        let last = -1;
        drawings.forEach((x, k) => x.group === group && (last = k));
        const where = last >= 0 ? last + 1 : Math.min(at, drawings.length);
        drawings = [...drawings.slice(0, where), createDrawing(newId(), d.name, moved, d.transform, pen, group), ...drawings.slice(where)];
      }
    }
  }
  return changed ? { drawings } : doc;
}

/** Limite de células por lado da grade: acima disso a memória cresce sem a busca ficar mais rápida. */
const MAX_CELLS_PER_SIDE = 512;

/**
 * Grade uniforme sobre os trechos dos traços. Cada célula guarda os trechos que passam por ela, então
 * achar o traço embaixo do mouse olha só as células em volta do ponto, e não os 20 mil traços do desenho.
 *
 * Os traços são polilinhas (x0, y0, x1, y1, ...), na unidade que for (a tela usa mm da cena).
 * `skip`, quando dado, tem 1 na posição dos traços a ignorar (os que já foram apagados).
 */
export class StrokeIndex {
  /** Quantos traços entraram */
  readonly size: number;
  private readonly xy: Float64Array;
  /** Primeiro ponto de cada traço em `xy` (em pontos, não em números); tem size + 1 posições */
  private readonly first: Int32Array;
  private readonly strokeOf: Int32Array;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  /** Carimbo por traço, para o retângulo não testar o mesmo traço duas vezes */
  private readonly stamp: Int32Array;
  private stampNow = 0;

  constructor(strokes: readonly ArrayLike<number>[], cellSize?: number) {
    this.size = strokes.length;
    this.first = new Int32Array(strokes.length + 1);
    let total = 0;
    strokes.forEach((s, i) => {
      this.first[i] = total;
      total += s.length >> 1;
    });
    this.first[strokes.length] = total;
    this.xy = new Float64Array(total * 2);
    this.strokeOf = new Int32Array(total);
    this.stamp = new Int32Array(strokes.length);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    strokes.forEach((s, i) => {
      const o = this.first[i];
      const n = s.length >> 1;
      for (let k = 0; k < n; k++) {
        const x = s[2 * k], y = s[2 * k + 1];
        this.xy[2 * (o + k)] = x;
        this.xy[2 * (o + k) + 1] = y;
        this.strokeOf[o + k] = i;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    });
    if (total === 0) minX = minY = maxX = maxY = 0;
    const w = maxX - minX, h = maxY - minY;
    const auto = Math.max(w, h) / 400;
    this.cell = Math.max(cellSize ?? auto, Math.max(w, h) / MAX_CELLS_PER_SIDE, 1e-6);
    this.minX = minX;
    this.minY = minY;
    this.nx = Math.max(1, Math.floor(w / this.cell) + 1);
    this.ny = Math.max(1, Math.floor(h / this.cell) + 1);

    // duas passadas pelo mesmo percurso: a primeira conta quantos trechos cada célula recebe, a segunda preenche
    const counts = new Int32Array(this.nx * this.ny + 1);
    this.eachSegmentCell((_, c) => counts[c + 1]++);
    for (let c = 0; c < this.nx * this.ny; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(counts[this.nx * this.ny]);
    const fill = this.cellStart.slice(0, this.nx * this.ny);
    this.eachSegmentCell((g, c) => (this.cellItems[fill[c]++] = g));
  }

  /** Fim do trecho que começa no ponto `g` (um traço de um ponto só é um trecho de comprimento zero). */
  private endOf(g: number): number {
    return g + 1 < this.first[this.strokeOf[g] + 1] ? g + 1 : g;
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cy = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    return cy * this.nx + cx;
  }

  /**
   * As células por onde cada trecho passa, amostrando de meia em meia célula. Uma célula que o trecho só
   * roça pode ficar de fora; por isso as buscas olham meia célula além do que foi pedido (`pad`).
   */
  private eachSegmentCell(visit: (g: number, cell: number) => void): void {
    for (let s = 0; s < this.size; s++) {
      const a = this.first[s], b = this.first[s + 1];
      const lastStart = Math.max(a, b - 2);
      for (let g = a; g <= lastStart && g < b; g++) {
        const e = this.endOf(g);
        const ax = this.xy[2 * g], ay = this.xy[2 * g + 1];
        const dx = this.xy[2 * e] - ax, dy = this.xy[2 * e + 1] - ay;
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (this.cell * 0.5)));
        let last = -1;
        for (let k = 0; k <= n; k++) {
          const c = this.cellOf(ax + (dx * k) / n, ay + (dy * k) / n);
          if (c !== last) visit(g, c);
          last = c;
        }
      }
    }
  }

  private get pad(): number {
    return this.cell * 0.5;
  }

  /** Faixa de células (colunas e linhas) que cobre a caixa, já com a folga; undefined se a caixa cai fora da grade. */
  private cellRange(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] | undefined {
    const p = this.pad;
    const cx0 = Math.floor((x0 - p - this.minX) / this.cell), cx1 = Math.floor((x1 + p - this.minX) / this.cell);
    const cy0 = Math.floor((y0 - p - this.minY) / this.cell), cy1 = Math.floor((y1 + p - this.minY) / this.cell);
    if (cx1 < 0 || cy1 < 0 || cx0 >= this.nx || cy0 >= this.ny) return undefined;
    return [Math.max(0, cx0), Math.max(0, cy0), Math.min(this.nx - 1, cx1), Math.min(this.ny - 1, cy1)];
  }

  /** O traço mais perto do ponto, se estiver a até `maxDist`. Nenhum → −1. Empate: o de número menor. */
  nearest(x: number, y: number, maxDist: number, skip?: ArrayLike<number>): number {
    if (this.size === 0 || !(maxDist >= 0)) return -1;
    const r = this.cellRange(x - maxDist, y - maxDist, x + maxDist, y + maxDist);
    if (!r) return -1;
    let best = -1;
    let bestD2 = maxDist * maxDist;
    for (let cy = r[1]; cy <= r[3]; cy++) {
      for (let cx = r[0]; cx <= r[2]; cx++) {
        const c = cy * this.nx + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const g = this.cellItems[k];
          const s = this.strokeOf[g];
          if (skip && skip[s]) continue;
          const e = this.endOf(g);
          const ax = this.xy[2 * g], ay = this.xy[2 * g + 1];
          const dx = this.xy[2 * e] - ax, dy = this.xy[2 * e + 1] - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          const qx = x - ax - t * dx, qy = y - ay - t * dy;
          const d2 = qx * qx + qy * qy;
          if (d2 < bestD2 || (d2 === bestD2 && (best < 0 || s < best))) {
            bestD2 = d2;
            best = s;
          }
        }
      }
    }
    return best;
  }

  /** Os traços que têm algum pedaço dentro do retângulo (os cantos podem vir em qualquer ordem), em ordem crescente. */
  inRect(xa: number, ya: number, xb: number, yb: number, skip?: ArrayLike<number>): number[] {
    if (this.size === 0) return [];
    const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb), y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
    const r = this.cellRange(x0, y0, x1, y1);
    if (!r) return [];
    const mark = ++this.stampNow;
    const out: number[] = [];
    for (let cy = r[1]; cy <= r[3]; cy++) {
      for (let cx = r[0]; cx <= r[2]; cx++) {
        const c = cy * this.nx + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const g = this.cellItems[k];
          const s = this.strokeOf[g];
          const seen = this.stamp[s]; // (numa variável: comparar `this.stamp[s]` direto confunde a análise de tipos do laço)
          if (seen === mark || (skip && skip[s])) continue;
          const e = this.endOf(g);
          if (segmentTouchesRect(this.xy[2 * g], this.xy[2 * g + 1], this.xy[2 * e], this.xy[2 * e + 1], x0, y0, x1, y1)) {
            this.stamp[s] = mark;
            out.push(s);
          }
        }
      }
    }
    return out.sort((a, b) => a - b);
  }
}

/** O trecho (a → b) tem algum ponto dentro do retângulo? (recorte de Liang–Barsky) */
function segmentTouchesRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // paralelo a este lado: dentro ou fora de vez
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay);
}

// ------------------------------------------------------------------ cortar e mover traços

/** Um ponto de um subcaminho: trecho `seg`, parâmetro `t` (0..1) dentro dele. */
export interface PathPoint {
  readonly seg: number;
  readonly t: number;
  readonly point: Vec;
  readonly dist: number;
}

const segStart = (sp: SubPath, i: number): Vec => (i === 0 ? sp.start : sp.segments[i - 1].to);

function cubicAt(p0: Vec, c1: Vec, c2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y };
}

/** Ponto do trecho `i` no parâmetro `t`. */
export function pointOnSegment(sp: SubPath, i: number, t: number): Vec {
  const a = segStart(sp, i), s = sp.segments[i];
  if (s.kind === "line") return { x: a.x + (s.to.x - a.x) * t, y: a.y + (s.to.y - a.y) * t };
  return cubicAt(a, s.c1, s.c2, s.to, t);
}

/**
 * O ponto do subcaminho mais perto de `p` (na unidade do subcaminho). Reta: projeção exata. Curva:
 * amostra e depois refina por bisseção em volta da melhor amostra (erro bem abaixo de 0,001 mm).
 */
export function nearestOnSubpath(sp: SubPath, p: Vec): PathPoint | undefined {
  let best: PathPoint | undefined;
  sp.segments.forEach((s, i) => {
    const a = segStart(sp, i);
    let t: number;
    if (s.kind === "line") {
      const dx = s.to.x - a.x, dy = s.to.y - a.y, l2 = dx * dx + dy * dy;
      t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    } else {
      const N = 48;
      const d2 = (tt: number) => {
        const q = cubicAt(a, s.c1, s.c2, s.to, tt);
        return (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      };
      let bt = 0, bd = Infinity;
      for (let k = 0; k <= N; k++) {
        const d = d2(k / N);
        if (d < bd) (bd = d), (bt = k / N);
      }
      let lo = Math.max(0, bt - 1 / N), hi = Math.min(1, bt + 1 / N);
      for (let it = 0; it < 40; it++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (d2(m1) < d2(m2)) hi = m2;
        else lo = m1;
      }
      t = (lo + hi) / 2;
    }
    const q = pointOnSegment(sp, i, t);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (!best || d < best.dist) best = { seg: i, t, point: q, dist: d };
  });
  return best;
}

/** Divide um trecho no parâmetro t (de Casteljau, para a curva): [primeira metade, segunda metade]. */
function splitSegment(a: Vec, s: Segment, t: number): [Segment, Segment] {
  if (s.kind === "line") {
    const m = { x: a.x + (s.to.x - a.x) * t, y: a.y + (s.to.y - a.y) * t };
    return [{ kind: "line", to: m }, { kind: "line", to: s.to }];
  }
  const L = (p: Vec, q: Vec) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const p01 = L(a, s.c1), p12 = L(s.c1, s.c2), p23 = L(s.c2, s.to);
  const p012 = L(p01, p12), p123 = L(p12, p23);
  const m = L(p012, p123);
  return [
    { kind: "cubic", c1: p01, c2: p012, to: m },
    { kind: "cubic", c1: p123, c2: p23, to: s.to },
  ];
}

/** Parâmetro tão perto da ponta do trecho que cortar ali é cortar no vértice */
const T_EPS = 1e-6;

/**
 * Corta o subcaminho no ponto (trecho `seg`, parâmetro `t`). Aberto: vira dois. Fechado (laço): vira UM
 * aberto, que começa e termina no corte. Cortar exatamente na ponta de um aberto não muda nada (um).
 * A forma não muda: a curva é dividida exatamente (de Casteljau).
 */
export function cutSubpath(sp: SubPath, seg: number, t: number): SubPath[] {
  const n = sp.segments.length;
  if (n === 0 || seg < 0 || seg >= n) return [sp];
  // corte no vértice: (seg, 1) é o mesmo que (seg + 1, 0)
  let i = seg, tt = Math.min(1, Math.max(0, t));
  if (tt >= 1 - T_EPS) (i = seg + 1), (tt = 0);
  let before: Segment[], after: Segment[], cut: Vec;
  if (tt <= T_EPS) {
    cut = i === 0 ? sp.start : sp.segments[i - 1].to;
    before = sp.segments.slice(0, i);
    after = sp.segments.slice(i);
  } else {
    const [s1, s2] = splitSegment(segStart(sp, i), sp.segments[i], tt);
    cut = s1.to;
    before = [...sp.segments.slice(0, i), s1];
    after = [s2, ...sp.segments.slice(i + 1)];
  }
  if (sp.closed) {
    // o laço abre no corte: do corte até o fim e, emendado, do começo até o corte
    const segs = [...after, ...before];
    return [{ start: cut, segments: segs, closed: false }];
  }
  if (before.length === 0 || after.length === 0) return [sp];
  return [
    { start: sp.start, segments: before, closed: false },
    { start: cut, segments: after, closed: false },
  ];
}

/** O desenho com o subcaminho `index` cortado (os pedaços entram no lugar dele, na ordem). */
export function cutGeometry(g: Geometry, index: number, seg: number, t: number): Geometry {
  const sp = g.subpaths[index];
  if (!sp) return g;
  const pieces = cutSubpath(sp, seg, t);
  if (pieces.length === 1 && pieces[0] === sp) return g;
  return { subpaths: [...g.subpaths.slice(0, index), ...pieces, ...g.subpaths.slice(index + 1)] };
}

/** Os subcaminhos `indices` deslocados de `d` (na unidade do desenho). Os outros ficam como estão. */
export function translateSubpaths(g: Geometry, indices: Iterable<number>, d: Vec): Geometry {
  const set = new Set(indices);
  if (set.size === 0 || (d.x === 0 && d.y === 0)) return g;
  const mv = (p: Vec) => ({ x: p.x + d.x, y: p.y + d.y });
  return {
    subpaths: g.subpaths.map((sp, i) =>
      set.has(i)
        ? {
            start: mv(sp.start),
            closed: sp.closed,
            segments: sp.segments.map((s): Segment => (s.kind === "line" ? { kind: "line", to: mv(s.to) } : { kind: "cubic", c1: mv(s.c1), c2: mv(s.c2), to: mv(s.to) })),
          }
        : sp,
    ),
  };
}

/** Um deslocamento na cena (mm da mesa) escrito nas coordenadas do desenho (só a parte linear da matriz). */
export function sceneDeltaToLocal(m: Mat2D, d: Vec): Vec {
  const inv = invert(m);
  return { x: inv[0] * d.x + inv[2] * d.y, y: inv[1] * d.x + inv[3] * d.y };
}

/**
 * Troca a geometria dos desenhos indicados (a caixa é refeita). Desenho sem traço nenhum sai da mesa.
 * Sem nada para mudar, devolve o MESMO documento.
 */
export function withGeometries(doc: PlotDocument, geoms: ReadonlyMap<DrawingId, Geometry>): PlotDocument {
  let changed = false;
  const drawings: Drawing[] = [];
  for (const d of doc.drawings) {
    const g = geoms.get(d.id);
    if (!g || g === d.geometry) {
      drawings.push(d);
      continue;
    }
    changed = true;
    if (g.subpaths.some((sp) => sp.segments.length > 0)) drawings.push({ ...d, geometry: g, localBBox: controlBBox(g) });
  }
  return changed ? { drawings } : doc;
}
