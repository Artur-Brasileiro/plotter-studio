import type { Vec } from "../geometry/vec";
import type { Stroke } from "./types";

/**
 * Caminhos pela tinta (REGRAS_GCODE.md, regra 1, "pelo caminho da tinta").
 *
 * Quando um traço acaba, em vez de subir a caneta, ela pode andar EMBAIXO por cima de linhas do próprio
 * desenho até o começo do próximo traço. Refazer uma linha que já existe (ou que vai existir: a camada
 * inteira acaba no papel) não cria marca nova. É o caso que a ligação reta não pega: a ligação que
 * contorna uma curva, ou que volta por cima da linha que a caneta acabou de fazer.
 *
 * O grafo tem um nó por vértice de cada traço e três tipos de aresta:
 *  - os trechos dos próprios traços (andar exatamente sobre o eixo da linha);
 *  - saltos entre traços que se encostam: até a largura da caneta (regra 1, não aparece) ou, mais longe,
 *    só se `hidden` confirmar que a ligação reta fica inteira sobre a tinta;
 *  - pontas de traço que caem no MEIO de um trecho de outro traço (junção em T): um nó novo no ponto
 *    exato, ligado às duas pontas daquele trecho.
 * A busca (`nearestEntry`) é um Dijkstra com limite de comprimento: acha o começo de traço livre mais
 * perto PELO CAMINHO, e devolve o caminho para a caneta seguir.
 */
export interface InkGraphOptions {
  /** Salto entre traços que não aparece nunca (a largura da caneta) */
  readonly gapMm: number;
  /** Saltos maiores que `gapMm`, até isto, valem se `hidden` confirmar */
  readonly hiddenHopMm: number;
  /** A ligação reta de a até b fica escondida pela tinta? */
  readonly hidden?: (a: Vec, b: Vec) => boolean;
}

export interface InkGraph {
  /** Primeiro nó de cada traço (os vértices dele são base[s] .. base[s] + n − 1) */
  readonly base: Int32Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Traço de cada nó de vértice; −1 = nó de junção (não é entrada de traço) */
  readonly strokeOf: Int32Array;
  readonly vertexOf: Int32Array;
  /** Lista de adjacência (CSR) */
  readonly adjStart: Int32Array;
  readonly adjTo: Int32Array;
  readonly adjW: Float64Array;
  readonly closed: Uint8Array;
  readonly lengths: Int32Array;
}

const CELL = 1; // mm, grade para achar vizinhos
/**
 * Teto de nós visitados numa busca. Num miolo de hachura quase terminado, uma busca que não acha nada
 * varreria todo o caminho de 25 mm em volta; com o teto ela desiste antes e a caneta sobe, como antes.
 */
const MAX_EXPANDED = 40_000;

class PointGrid {
  private readonly cells = new Map<number, number[]>();
  constructor(private readonly cell: number) {}
  private key(cx: number, cy: number) {
    return (cx + 100_000) * 200_003 + (cy + 100_000);
  }
  add(i: number, x: number, y: number) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push(i);
  }
  near(x: number, y: number, r: number, visit: (i: number) => void) {
    const c0x = Math.floor((x - r) / this.cell), c1x = Math.floor((x + r) / this.cell);
    const c0y = Math.floor((y - r) / this.cell), c1y = Math.floor((y + r) / this.cell);
    for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) for (const i of this.cells.get(this.key(cx, cy)) ?? []) visit(i);
  }
}

export function buildInkGraph(strokes: readonly Stroke[], opts: InkGraphOptions): InkGraph {
  const S = strokes.length;
  const base = new Int32Array(S + 1);
  let n = 0;
  strokes.forEach((s, i) => {
    base[i] = n;
    n += s.points.length;
  });
  base[S] = n;
  const xs: number[] = new Array(n), ys: number[] = new Array(n);
  const strokeOf: number[] = new Array(n), vertexOf: number[] = new Array(n);
  strokes.forEach((s, i) => {
    s.points.forEach((p, k) => {
      const v = base[i] + k;
      xs[v] = p.x;
      ys[v] = p.y;
      strokeOf[v] = i;
      vertexOf[v] = k;
    });
  });
  const eu: number[] = [], ev: number[] = [], ew: number[] = [];
  const edge = (u: number, v: number, w: number) => {
    eu.push(u);
    ev.push(v);
    ew.push(w);
  };
  // 1) os trechos de cada traço
  for (let i = 0; i < S; i++) {
    for (let k = base[i]; k + 1 < base[i + 1]; k++) edge(k, k + 1, Math.hypot(xs[k + 1] - xs[k], ys[k + 1] - ys[k]));
    // laço: o último vértice é o primeiro (mesmo ponto); sem esta aresta, o caminho daria a volta inteira
    if (strokes[i].closed && base[i + 1] - base[i] > 2) edge(base[i + 1] - 1, base[i], 0);
  }
  const reach = Math.max(opts.gapMm, opts.hidden ? opts.hiddenHopMm : 0);
  if (reach > 0 && n > 0) {
    // 2) saltos de vértice a vértice entre traços diferentes
    const grid = new PointGrid(Math.max(CELL, reach));
    for (let v = 0; v < n; v++) grid.add(v, xs[v], ys[v]);
    const isEnd = (v: number) => vertexOf[v] === 0 || v === base[strokeOf[v] + 1] - 1;
    for (let v = 0; v < n; v++) {
      const sv = strokeOf[v];
      grid.near(xs[v], ys[v], reach, (u) => {
        if (u <= v || strokeOf[u] === sv) return;
        const d = Math.hypot(xs[u] - xs[v], ys[u] - ys[v]);
        if (d <= opts.gapMm) edge(v, u, d);
        else if (d <= reach && (isEnd(u) || isEnd(v)) && opts.hidden!({ x: xs[v], y: ys[v] }, { x: xs[u], y: ys[u] })) edge(v, u, d);
      });
    }
    // 3) ponta de traço que encosta no meio de um trecho de outro traço (junção em T)
    const segGrid = new PointGrid(Math.max(CELL, reach));
    for (let i = 0; i < S; i++) {
      for (let k = base[i]; k + 1 < base[i + 1]; k++) {
        // o trecho entra nas células por onde passa (amostrado a cada meia célula)
        const len = Math.hypot(xs[k + 1] - xs[k], ys[k + 1] - ys[k]);
        const m = Math.max(1, Math.ceil(len / (Math.max(CELL, reach) / 2)));
        const seen = new Set<string>();
        for (let t = 0; t <= m; t++) {
          const px = xs[k] + ((xs[k + 1] - xs[k]) * t) / m, py = ys[k] + ((ys[k + 1] - ys[k]) * t) / m;
          const key = `${Math.floor(px / Math.max(CELL, reach))},${Math.floor(py / Math.max(CELL, reach))}`;
          if (seen.has(key)) continue;
          seen.add(key);
          segGrid.add(k, px, py);
        }
      }
    }
    /** Pontos de junção em cada trecho (vértice inicial do trecho → nós e parâmetros) */
    const splits = new Map<number, { node: number; t: number }[]>();
    for (let i = 0; i < S; i++) {
      const a = base[i], b = base[i + 1] - 1;
      if (b < a) continue;
      for (const v of a === b ? [a] : [a, b]) {
        let best = -1, bestD = Infinity, bestT = 0;
        const tried = new Set<number>();
        segGrid.near(xs[v], ys[v], reach, (k) => {
          if (strokeOf[k] === i || tried.has(k)) return;
          tried.add(k);
          const ax = xs[k], ay = ys[k], dx = xs[k + 1] - ax, dy = ys[k + 1] - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.min(1, Math.max(0, ((xs[v] - ax) * dx + (ys[v] - ay) * dy) / l2)) : 0;
          const d = Math.hypot(xs[v] - ax - t * dx, ys[v] - ay - t * dy);
          if (d < bestD) (best = k), (bestD = d), (bestT = t);
        });
        if (best < 0 || bestT <= 0 || bestT >= 1 || bestD > reach) continue;
        const px = xs[best] + (xs[best + 1] - xs[best]) * bestT, py = ys[best] + (ys[best + 1] - ys[best]) * bestT;
        if (bestD > opts.gapMm && !opts.hidden!({ x: xs[v], y: ys[v] }, { x: px, y: py })) continue;
        const j = xs.length;
        xs.push(px);
        ys.push(py);
        strokeOf.push(-1);
        vertexOf.push(-1);
        let list = splits.get(best);
        if (!list) splits.set(best, (list = []));
        list.push({ node: j, t: bestT });
        edge(j, v, bestD);
      }
    }
    // os pontos de junção de um mesmo trecho ficam em fila, na ordem em que aparecem nele: de um para o
    // vizinho se anda direto pelo trecho (e não pelas pontas dele, o que poderia passar do limite)
    for (const [k, list] of splits) {
      list.sort((p, q) => p.t - q.t);
      const len = Math.hypot(xs[k + 1] - xs[k], ys[k + 1] - ys[k]);
      let prevNode = k, prevT = 0;
      for (const { node, t } of list) {
        edge(prevNode, node, len * (t - prevT));
        prevNode = node;
        prevT = t;
      }
      edge(prevNode, k + 1, len * (1 - prevT));
    }
  }
  // lista de adjacência nos dois sentidos
  const N = xs.length;
  const deg = new Int32Array(N + 1);
  for (let e = 0; e < eu.length; e++) {
    deg[eu[e] + 1]++;
    deg[ev[e] + 1]++;
  }
  for (let v = 0; v < N; v++) deg[v + 1] += deg[v];
  const adjTo = new Int32Array(deg[N]), adjW = new Float64Array(deg[N]);
  const fill = deg.slice(0, N);
  for (let e = 0; e < eu.length; e++) {
    adjTo[fill[eu[e]]] = ev[e];
    adjW[fill[eu[e]]++] = ew[e];
    adjTo[fill[ev[e]]] = eu[e];
    adjW[fill[ev[e]]++] = ew[e];
  }
  return {
    base,
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    strokeOf: Int32Array.from(strokeOf),
    vertexOf: Int32Array.from(vertexOf),
    adjStart: deg,
    adjTo,
    adjW,
    closed: Uint8Array.from(strokes.map((s) => (s.closed ? 1 : 0))),
    lengths: Int32Array.from(strokes.map((s) => s.points.length)),
  };
}

/** Uma entrada de traço achada pelo caminho: o traço, por qual vértice entrar e o caminho até lá (sem o ponto de partida). */
export interface InkRoute {
  readonly stroke: number;
  /** Vértice de entrada (como em `optimize.ts`: −1 = pelo fim de um traço aberto) */
  readonly vertex: number;
  readonly path: Vec[];
  readonly lengthMm: number;
}

/** Busca reaproveitável (os vetores de trabalho são alocados uma vez). */
export class InkSearch {
  private readonly distTo: Float64Array;
  private readonly prev: Int32Array;
  private readonly touched: number[] = [];
  private heap: number[] = [];
  private heapD: number[] = [];

  constructor(private readonly g: InkGraph) {
    this.distTo = new Float64Array(g.x.length).fill(Infinity);
    this.prev = new Int32Array(g.x.length).fill(-1);
  }

  /** O nó do vértice `k` do traço `s` */
  node(s: number, k: number): number {
    return this.g.base[s] + k;
  }

  private push(v: number, d: number) {
    const h = this.heap, hd = this.heapD;
    h.push(v);
    hd.push(d);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hd[p] <= hd[i]) break;
      [h[p], h[i]] = [h[i], h[p]];
      [hd[p], hd[i]] = [hd[i], hd[p]];
      i = p;
    }
  }

  private pop(): [number, number] {
    const h = this.heap, hd = this.heapD;
    const top: [number, number] = [h[0], hd[0]];
    const lv = h.pop()!, ld = hd.pop()!;
    if (h.length) {
      h[0] = lv;
      hd[0] = ld;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && hd[l] < hd[m]) m = l;
        if (r < h.length && hd[r] < hd[m]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        [hd[m], hd[i]] = [hd[i], hd[m]];
        i = m;
      }
    }
    return top;
  }

  /**
   * O começo de traço livre (`used[s] = 0`) mais perto de `from` andando pela tinta, até `maxMm`.
   * Traço aberto entra por uma das pontas; laço fechado, por qualquer vértice.
   */
  nearestEntry(from: number, maxMm: number, used: Uint8Array): InkRoute | undefined {
    const g = this.g;
    for (const v of this.touched) {
      this.distTo[v] = Infinity;
      this.prev[v] = -1;
    }
    this.touched.length = 0;
    this.heap = [];
    this.heapD = [];
    this.distTo[from] = 0;
    this.touched.push(from);
    this.push(from, 0);
    let expanded = 0;
    while (this.heap.length) {
      const [v, d] = this.pop();
      if (d > this.distTo[v]) continue;
      if (d > maxMm || ++expanded > MAX_EXPANDED) break;
      const s = g.strokeOf[v];
      if (s >= 0 && !used[s] && v !== from) {
        const k = g.vertexOf[v], n = g.lengths[s];
        let vertex: number | undefined;
        if (g.closed[s]) vertex = k === n - 1 ? 0 : k;
        else if (k === 0) vertex = 0;
        else if (k === n - 1) vertex = -1;
        if (vertex !== undefined) {
          const path: Vec[] = [];
          for (let u = v; u !== from && u >= 0; u = this.prev[u]) path.push({ x: g.x[u], y: g.y[u] });
          path.reverse();
          return { stroke: s, vertex, path, lengthMm: d };
        }
      }
      for (let a = g.adjStart[v]; a < g.adjStart[v + 1]; a++) {
        const u = g.adjTo[a];
        const nd = d + g.adjW[a];
        if (nd < this.distTo[u] && nd <= maxMm) {
          if (this.distTo[u] === Infinity) this.touched.push(u);
          this.distTo[u] = nd;
          this.prev[u] = v;
          this.push(u, nd);
        }
      }
    }
    return undefined;
  }
}
