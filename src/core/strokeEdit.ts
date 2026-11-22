import { removeDrawings, type Drawing, type DrawingId, type PlotDocument } from "./document";
import { flattenSubPath } from "./geometry/flatten";
import { controlBBox, transformGeometry } from "./geometry/path";

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
