import { mathHypot, pairwiseSum, pointsClose } from "./fit";
import type { Mask, Polyline } from "./types";

/**
 * Esqueleto → traços de linha única. Porte de `skeleton_strokes` de `lab/python/vec.py`.
 *
 * Etapas, na mesma ordem do Python (as ordens de iteração também são as mesmas, para o resultado
 * sair idêntico e não só parecido):
 *  1. grafo de pixels: vizinhança de 8, mas a diagonal não liga se um dos dois pixels ortogonais
 *     entre eles existe (senão cada degrau de escada viraria um triângulo);
 *  2. cadeias entre pixels-nó (grau ≠ 2), laços puros (só grau 2) e pontos isolados (grau 0);
 *  3. pixels de junção vizinhos viram um nó só (cadeia curta entre dois pixels de grau ≥ 3);
 *  4. poda das rebarbas (ponta solta mais curta que o raio do traço na junção + `spurPx`) e fusão
 *     das arestas que sobram em nós de grau 2;
 *  5. em cada junção, emparelha os ramos que continuam um ao outro quase em linha reta, corta os
 *     pontos de dentro da junção (onde o esqueleto entorta) e põe no lugar um ponto de junção limpo;
 *  6. monta os traços seguindo os pares; o que sobra muito curto vira ponto.
 *
 * Cada etapa é uma função pequena de propósito: além de mais fácil de ler, o V8 só otimiza bem os
 * laços longos (um por pixel do esqueleto) quando eles estão em funções curtas.
 */
export interface StrokeOptions {
  /** Folga da poda de rebarbas, em px da imagem original. Padrão 1,0. */
  spurPx?: number;
  /** Dois ramos de uma junção se continuam se o desvio da linha reta é de até estes graus. Padrão 42. */
  pairDeg?: number;
  /** Traço aberto mais curto que isto (px da imagem original) vira ponto. Padrão 0,6. */
  dotPx?: number;
  /** Corta os pontos de dentro das junções e recalcula o ponto de junção. Padrão true. */
  junctionClean?: boolean;
}

export interface StrokeResult {
  polylines: Polyline[];
  /** Pontos isolados: x0, y0, x1, y1, ... */
  dots: Float64Array;
}

/** Lista de inteiros que cresce (as cadeias de pixels de todos os traços ficam numa lista só). */
class IntList {
  data: Int32Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Int32Array(Math.max(capacity, 16));
  }

  push(v: number): void {
    if (this.length === this.data.length) {
      const bigger = new Int32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = v;
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Grafo de pixels
// ---------------------------------------------------------------------------------------------

interface PixelGraph {
  count: number;
  /** Coordenadas de cada pixel do esqueleto, na ordem linha a linha. */
  xs: Int32Array;
  ys: Int32Array;
  /** Vizinhos do pixel p: `nb[off[p] .. off[p+1])`, na ordem cima, baixo, esquerda, direita, diagonais. */
  off: Int32Array;
  nb: Int32Array;
}

/**
 * Posições (y·W + x) dos pixels acesos, em ordem. Onde dá, lê 4 bytes de cada vez: o esqueleto é
 * quase todo vazio, e assim a imagem inteira (dezenas de milhões de pixels) passa em poucos ms.
 */
function litPixels(data: Uint8Array, total: number): Int32Array {
  const out = new IntList(4096);
  let i = 0;
  if (data.byteOffset % 4 === 0) {
    const words = new Uint32Array(data.buffer, data.byteOffset, total >> 2);
    for (let w = 0; w < words.length; w++) {
      if (words[w] === 0) continue;
      const b = 4 * w;
      if (data[b]) out.push(b);
      if (data[b + 1]) out.push(b + 1);
      if (data[b + 2]) out.push(b + 2);
      if (data[b + 3]) out.push(b + 3);
    }
    i = 4 * words.length;
  }
  for (; i < total; i++) if (data[i]) out.push(i);
  return out.data.subarray(0, out.length);
}

/**
 * Numera os pixels do esqueleto linha a linha e lista os vizinhos de cada um. O custo e a memória
 * dependem da quantidade de pixels do esqueleto, não do tamanho da imagem: fora a varredura inicial,
 * só existem três linhas de números por vez (a de cima, a atual e a de baixo).
 */
function buildPixelGraph(skel: Mask): PixelGraph {
  const { width: W, height: H, data } = skel;
  const lit = litPixels(data, Math.min(W * H, data.length));
  const count = lit.length;
  const xs = new Int32Array(count);
  const ys = new Int32Array(count);
  const rowStart = new Int32Array(H + 2); // os pixels da linha y são rowStart[y] .. rowStart[y+1]-1
  for (let p = 0, y = 0; p < count; p++) {
    while (lit[p] >= (y + 1) * W) rowStart[++y] = p;
    ys[p] = y;
    xs[p] = lit[p] - y * W;
    if (p === count - 1) for (let r = y + 1; r < H + 2; r++) rowStart[r] = count;
  }
  const off = new Int32Array(count + 1);
  let nb = new Int32Array(2 * count + 64);
  // linhas de números com uma coluna de folga de cada lado; -1 = sem pixel
  let above = new Int32Array(W + 2).fill(-1);
  let cur = new Int32Array(W + 2).fill(-1);
  let below = new Int32Array(W + 2).fill(-1);
  /** Escreve (ou apaga) os números da linha y na linha de trabalho; só toca onde há pixel. */
  const stamp = (row: Int32Array, y: number, write: boolean): void => {
    if (y < 0 || y >= H) return;
    for (let q = rowStart[y]; q < rowStart[y + 1]; q++) row[xs[q] + 1] = write ? q : -1;
  };
  stamp(cur, 0, true);
  let m = 0;
  for (let y = 0; y < H; y++) {
    stamp(below, y + 1, true);
    for (let p = rowStart[y]; p < rowStart[y + 1]; p++) {
      if (m + 8 > nb.length) {
        const bigger = new Int32Array(nb.length * 2);
        bigger.set(nb);
        nb = bigger;
      }
      off[p] = m;
      const x = xs[p] + 1;
      const up = above[x];
      const down = below[x];
      const left = cur[x - 1];
      const right = cur[x + 1];
      if (up >= 0) nb[m++] = up;
      if (down >= 0) nb[m++] = down;
      if (left >= 0) nb[m++] = left;
      if (right >= 0) nb[m++] = right;
      if (up < 0 && left < 0 && above[x - 1] >= 0) nb[m++] = above[x - 1];
      if (up < 0 && right < 0 && above[x + 1] >= 0) nb[m++] = above[x + 1];
      if (down < 0 && left < 0 && below[x - 1] >= 0) nb[m++] = below[x - 1];
      if (down < 0 && right < 0 && below[x + 1] >= 0) nb[m++] = below[x + 1];
    }
    // a linha de cima não serve mais: é limpa e passa a ser a próxima linha de baixo
    stamp(above, y - 1, false);
    const t = above;
    above = cur;
    cur = below;
    below = t;
  }
  off[count] = m;
  return { count, xs, ys, off, nb };
}

// ---------------------------------------------------------------------------------------------
// 2. Cadeias, laços e pontos
// ---------------------------------------------------------------------------------------------

interface Chains {
  /** Pixels de todas as cadeias, uma atrás da outra; a cadeia c ocupa `pix[start[c] .. start[c+1])`. */
  pix: Int32Array;
  start: Int32Array;
  count: number;
  /** Laços puros (todos os pixels de grau 2), cada um como a lista dos seus pixels. */
  loops: Int32Array[];
}

/** Cadeias entre pixels-nó (grau ≠ 2), cada uma com os dois nós nas pontas; e os laços que sobram. */
function traceChains(g: PixelGraph): Chains {
  const { count: N, off, nb } = g;
  const pix = new IntList(N + 1024);
  const start = new IntList(1024);
  start.push(0);
  const visited = new Uint8Array(off[N]); // (p → vizinho) já percorrido, por posição em `nb`
  const seen = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    if (off[p + 1] - off[p] === 2) continue;
    seen[p] = 1;
    for (let e = off[p]; e < off[p + 1]; e++) {
      if (visited[e]) continue;
      pix.push(p);
      pix.push(nb[e]);
      let prev = p;
      let cur = nb[e];
      seen[cur] = 1;
      while (off[cur + 1] - off[cur] === 2) {
        const first = nb[off[cur]];
        const nxt = first !== prev ? first : nb[off[cur] + 1];
        pix.push(nxt);
        seen[nxt] = 1;
        prev = cur;
        cur = nxt;
      }
      visited[e] = 1;
      for (let f = off[cur]; f < off[cur + 1]; f++) {
        if (nb[f] === prev) {
          visited[f] = 1; // o mesmo caminho visto da outra ponta
          break;
        }
      }
      start.push(pix.length);
    }
  }
  // o que sobrou sem visitar só tem pixels de grau 2: laços puros
  const loops: Int32Array[] = [];
  for (let p = 0; p < N; p++) {
    if (seen[p]) continue;
    const loop = new IntList(64);
    loop.push(p);
    let prev = -1;
    let cur = p;
    for (let guard = 0; guard < N + 2; guard++) {
      const first = nb[off[cur]];
      const nxt = first !== prev ? first : nb[off[cur] + 1];
      if (nxt === p) break;
      loop.push(nxt);
      seen[nxt] = 1;
      prev = cur;
      cur = nxt;
    }
    seen[p] = 1;
    loops.push(loop.data.subarray(0, loop.length));
  }
  return { pix: pix.data, start: start.data, count: start.length - 1, loops };
}

// ---------------------------------------------------------------------------------------------
// 3. Nós e arestas
// ---------------------------------------------------------------------------------------------

interface Nodes {
  count: number;
  /** Nó de cada pixel-nó (-1 nos outros pixels). */
  of: Int32Array;
  /** Posição (x, y) de cada nó: média dos pixels que o formam. */
  pos: Float64Array;
  /** Raio do traço em cada nó: a maior distância à borda entre os pixels que o formam. */
  rad: Float64Array;
  /** Cadeias que viram aresta (as curtas entre dois pixels de junção só servem para uni-los). */
  kept: number[];
}

/** Une os pixels de junção vizinhos (union-find) e monta os nós do grafo de traços. */
function buildNodes(g: PixelGraph, chains: Chains, dist: Float32Array, W: number): Nodes {
  const { count: N, xs, ys, off } = g;
  const uf = new Int32Array(N);
  for (let p = 0; p < N; p++) uf[p] = p;
  const find = (a: number): number => {
    while (uf[a] !== a) {
      uf[a] = uf[uf[a]];
      a = uf[a];
    }
    return a;
  };
  const kept: number[] = [];
  for (let c = 0; c < chains.count; c++) {
    const a = chains.pix[chains.start[c]];
    const b = chains.pix[chains.start[c + 1] - 1];
    if (off[a + 1] - off[a] >= 3 && off[b + 1] - off[b] >= 3) {
      const steps = chains.start[c + 1] - chains.start[c] - 1;
      if (steps <= Math.max(2.0, dist[ys[a] * W + xs[a]] + dist[ys[b] * W + xs[b]])) {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) uf[ra] = rb;
        continue;
      }
    }
    kept.push(c);
  }
  // grupos na ordem em que o primeiro pixel de cada um aparece
  const members = new Map<number, number[]>();
  for (let p = 0; p < N; p++) {
    const d = off[p + 1] - off[p];
    if (d === 2 || d === 0) continue;
    const root = find(p);
    const lst = members.get(root);
    if (lst) lst.push(p);
    else members.set(root, [p]);
  }
  const count = members.size;
  const of = new Int32Array(N).fill(-1);
  const pos = new Float64Array(2 * count);
  const rad = new Float64Array(count);
  let nid = 0;
  for (const mem of members.values()) {
    let sx = 0;
    let sy = 0;
    let r = -Infinity;
    for (const p of mem) {
      of[p] = nid;
      sx += xs[p];
      sy += ys[p];
      const d = dist[ys[p] * W + xs[p]];
      if (d > r) r = d;
    }
    pos[2 * nid] = sx / mem.length;
    pos[2 * nid + 1] = sy / mem.length;
    rad[nid] = r;
    nid++;
  }
  return { count, of, pos, rad, kept };
}

/** Aresta do grafo de traços: liga os nós `a` e `b`; `pts` vai de `a` até `b`, em px da máscara. */
interface Edge {
  a: number;
  b: number;
  pts: Float64Array;
  alive: boolean;
}

/** Rascunho de `polylineLength`, reaproveitado entre chamadas (ela é chamada uma vez por traço). */
let lengthScratch = new Float64Array(256);

/** `_polylen`: comprimento da polilinha (segmentos por `np.hypot`, soma em pares como o NumPy). */
function polylineLength(pts: Float64Array): number {
  const n = pts.length >> 1;
  if (n < 2) return 0;
  if (lengthScratch.length < n - 1) lengthScratch = new Float64Array(Math.max(n - 1, 2 * lengthScratch.length));
  const seg = lengthScratch;
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[2 * i + 2] - pts[2 * i];
    const dy = pts[2 * i + 3] - pts[2 * i + 1];
    seg[i] = Math.sqrt(dx * dx + dy * dy);
  }
  return pairwiseSum(seg, 0, n - 1);
}

function buildEdges(g: PixelGraph, chains: Chains, nodes: Nodes): Edge[] {
  const { xs, ys } = g;
  const edges: Edge[] = [];
  for (const c of nodes.kept) {
    const lo = chains.start[c];
    const len = chains.start[c + 1] - lo;
    const pts = new Float64Array(2 * len);
    for (let t = 0; t < len; t++) {
      const p = chains.pix[lo + t];
      pts[2 * t] = xs[p];
      pts[2 * t + 1] = ys[p];
    }
    const a = nodes.of[chains.pix[lo]];
    const b = nodes.of[chains.pix[lo + len - 1]];
    if (a === b && polylineLength(pts) < 2.5 * nodes.rad[a] + 2) continue; // lacinho colado na própria junção
    edges.push({ a, b, pts, alive: true });
  }
  return edges;
}

// ---------------------------------------------------------------------------------------------
// 4. Poda das rebarbas
// ---------------------------------------------------------------------------------------------

/** Pontas de aresta em cada nó, na ordem em que aparecem; cada ponta é `2·aresta + lado` (0 = a, 1 = b). */
function incidence(edges: readonly Edge[]): Map<number, number[]> {
  const inc = new Map<number, number[]>();
  const add = (node: number, end: number): void => {
    const lst = inc.get(node);
    if (lst) lst.push(end);
    else inc.set(node, [end]);
  };
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e.alive) continue;
    add(e.a, 2 * i);
    add(e.b, 2 * i + 1);
  }
  return inc;
}

/** Funde as duas arestas de cada nó de grau 2 (repete até não sobrar nenhum). */
function dissolve(edges: Edge[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    const inc = incidence(edges);
    const busy = new Uint8Array(edges.length);
    for (const lst of inc.values()) {
      if (lst.length !== 2) continue;
      const i1 = lst[0] >> 1;
      const s1 = lst[0] & 1;
      const i2 = lst[1] >> 1;
      const s2 = lst[1] & 1;
      if (i1 === i2 || busy[i1] || busy[i2]) continue;
      const e1 = edges[i1];
      const e2 = edges[i2];
      // p1 = e1 orientada para terminar no nó; p2 = e2 orientada para começar no nó
      const n1 = e1.pts.length >> 1;
      const n2 = e2.pts.length >> 1;
      const rev1 = s1 !== 1;
      const rev2 = s2 !== 0;
      const end1 = 2 * (rev1 ? 0 : n1 - 1);
      const start2 = 2 * (rev2 ? n2 - 1 : 0);
      const skip = pointsClose(e1.pts[end1], e1.pts[end1 + 1], e2.pts[start2], e2.pts[start2 + 1]) ? 1 : 0;
      const pts = new Float64Array(2 * (n1 + n2 - skip));
      for (let t = 0; t < n1; t++) {
        const o = 2 * (rev1 ? n1 - 1 - t : t);
        pts[2 * t] = e1.pts[o];
        pts[2 * t + 1] = e1.pts[o + 1];
      }
      for (let t = skip; t < n2; t++) {
        const o = 2 * (rev2 ? n2 - 1 - t : t);
        pts[2 * (n1 + t - skip)] = e2.pts[o];
        pts[2 * (n1 + t - skip) + 1] = e2.pts[o + 1];
      }
      e1.alive = false;
      e2.alive = false;
      busy[i1] = 1;
      busy[i2] = 1;
      edges.push({ a: rev1 ? e1.b : e1.a, b: rev2 ? e2.a : e2.b, pts, alive: true });
      changed = true;
    }
  }
}

/**
 * Tira as rebarbas (aresta com exatamente uma ponta solta, mais curta que o raio da junção +
 * `spurAbs`) e funde o que sobra em nós de grau 2. Até 4 rodadas, porque podar revela novas pontas.
 */
function pruneSpurs(edges: Edge[], nodes: Nodes, spurAbs: number): Edge[] {
  const degree = new Int32Array(nodes.count);
  for (let round = 0; round < 4; round++) {
    degree.fill(0);
    for (const e of edges) {
      if (!e.alive) continue;
      degree[e.a]++;
      degree[e.b]++;
    }
    let removed = false;
    for (const e of edges) {
      if (!e.alive || e.a === e.b) continue;
      const la = degree[e.a] === 1;
      const lb = degree[e.b] === 1;
      if (la === lb) continue;
      const jn = la ? e.b : e.a;
      if (degree[jn] >= 3 && polylineLength(e.pts) < nodes.rad[jn] + spurAbs) {
        e.alive = false;
        removed = true;
      }
    }
    dissolve(edges);
    if (!removed) break;
  }
  return edges.filter((e) => e.alive);
}

// ---------------------------------------------------------------------------------------------
// 5. Junções
// ---------------------------------------------------------------------------------------------

interface Junctions {
  /** Ponta de aresta → ponta que a continua do outro lado da junção (-1 = nenhuma). */
  partner: Int32Array;
  /** Ponta de aresta → quantos pontos descartar nessa ponta (os de dentro da junção). */
  cut: Int32Array;
  /** Nós que são junção (3 pontas ou mais) e o ponto de junção de cada um. */
  has: Uint8Array;
  point: Float64Array;
}

/** Em cada junção: emparelha as continuações suaves e calcula o ponto de junção limpo. */
function pairJunctions(edges: readonly Edge[], nodes: Nodes, pairDeg: number, junctionClean: boolean): Junctions {
  const partner = new Int32Array(2 * edges.length).fill(-1);
  const cut = new Int32Array(2 * edges.length);
  const has = new Uint8Array(nodes.count);
  const point = new Float64Array(2 * nodes.count);
  const cosThr = Math.cos(pairDeg * (Math.PI / 180));
  for (const [nd, lst] of incidence(edges)) {
    const m = lst.length;
    if (m < 3) continue;
    const px = nodes.pos[2 * nd];
    const py = nodes.pos[2 * nd + 1];
    const rho = 1.5 * nodes.rad[nd] + 1.0; // dentro deste raio o esqueleto não é confiável
    const rhoFar = rho + Math.max(4.0, 2 * nodes.rad[nd]); // onde se mede a direção do ramo
    const dirs = new Float64Array(2 * m);
    const cutPts = new Float64Array(2 * m);
    for (let j = 0; j < m; j++) {
      const i = lst[j] >> 1;
      const sd = lst[j] & 1;
      const pts = edges[i].pts;
      const cnt = pts.length >> 1;
      // anda pela aresta a partir do nó: primeiro ponto fora de rho e primeiro fora de rhoFar
      let ci = -1;
      let di = cnt - 1;
      for (let t = 0; t < cnt; t++) {
        const o = 2 * (sd === 0 ? t : cnt - 1 - t);
        const dx = pts[o] - px;
        const dy = pts[o + 1] - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (ci < 0 && d > rho) ci = t;
        if (d > rhoFar) {
          di = t;
          break;
        }
      }
      cut[lst[j]] = ci >= 0 ? ci : cnt;
      if (ci < 0) ci = cnt - 1;
      const od = 2 * (sd === 0 ? di : cnt - 1 - di);
      const vx = pts[od] - px;
      const vy = pts[od + 1] - py;
      const len = mathHypot(vx, vy);
      dirs[2 * j] = len < 1e-12 ? 1 : vx / len;
      dirs[2 * j + 1] = len < 1e-12 ? 0 : vy / len;
      const oc = 2 * (sd === 0 ? ci : cnt - 1 - ci);
      cutPts[2 * j] = pts[oc];
      cutPts[2 * j + 1] = pts[oc + 1];
    }
    // candidatos a par, do mais reto para o menos (empate: maior índice primeiro, como a tupla do Python)
    const cand: { c: number; a: number; b: number }[] = [];
    for (let a = 0; a < m; a++) {
      for (let b = a + 1; b < m; b++) {
        if (lst[a] >> 1 === lst[b] >> 1) continue; // as duas pontas da mesma aresta
        const c = -(dirs[2 * a] * dirs[2 * b] + dirs[2 * a + 1] * dirs[2 * b + 1]);
        if (c >= cosThr) cand.push({ c, a, b });
      }
    }
    cand.sort((u, v) => v.c - u.c || v.a - u.a || v.b - u.b);
    const used = new Uint8Array(m);
    const pairs: number[] = []; // a0, b0, a1, b1, ...
    for (const { a, b } of cand) {
      if (used[a] || used[b]) continue;
      used[a] = 1;
      used[b] = 1;
      partner[lst[a]] = lst[b];
      partner[lst[b]] = lst[a];
      pairs.push(a, b);
    }
    let jx = px;
    let jy = py;
    const pairCount = pairs.length >> 1;
    if (junctionClean && pairCount > 0) {
      // projeção do nó na reta que liga os dois pontos de corte de cada par
      let sumX = 0;
      let sumY = 0;
      let firstX = 0;
      let firstY = 0;
      for (let q = 0; q < pairCount; q++) {
        const a = pairs[2 * q];
        const b = pairs[2 * q + 1];
        const ax = cutPts[2 * a];
        const ay = cutPts[2 * a + 1];
        const abx = cutPts[2 * b] - ax;
        const aby = cutPts[2 * b + 1] - ay;
        const den = abx * abx + aby * aby;
        let t = 0.5;
        if (!(den < 1e-9)) {
          t = ((px - ax) * abx + (py - ay) * aby) / den;
          t = t > 0 ? t : 0;
          t = t < 1 ? t : 1;
        }
        const projX = ax + t * abx;
        const projY = ay + t * aby;
        if (q === 0) {
          firstX = projX;
          firstY = projY;
        }
        sumX += projX;
        sumY += projY;
      }
      if (pairCount >= 2) {
        // cruzamento: o ponto de junção é onde as duas primeiras retas se cortam, se cair perto do nó
        const a1x = cutPts[2 * pairs[0]];
        const a1y = cutPts[2 * pairs[0] + 1];
        const d1x = cutPts[2 * pairs[1]] - a1x;
        const d1y = cutPts[2 * pairs[1] + 1] - a1y;
        const a2x = cutPts[2 * pairs[2]];
        const a2y = cutPts[2 * pairs[2] + 1];
        const d2x = cutPts[2 * pairs[3]] - a2x;
        const d2y = cutPts[2 * pairs[3] + 1] - a2y;
        const cr = d1x * d2y - d1y * d2x;
        let crossed = false;
        if (Math.abs(cr) > 1e-6) {
          const wx = a2x - a1x;
          const wy = a2y - a1y;
          const t = (wx * d2y - wy * d2x) / cr;
          const cx = a1x + t * d1x;
          const cy = a1y + t * d1y;
          if (mathHypot(cx - px, cy - py) <= rho) {
            jx = cx;
            jy = cy;
            crossed = true;
          }
        }
        if (!crossed) {
          jx = sumX / pairCount;
          jy = sumY / pairCount;
        }
      } else {
        jx = firstX;
        jy = firstY;
      }
    }
    has[nd] = 1;
    point[2 * nd] = jx;
    point[2 * nd + 1] = jy;
  }
  return { partner, cut, has, point };
}

/** Pontos finais de cada aresta: ponto de junção + miolo + ponto de junção. */
function finalEdgePoints(edges: readonly Edge[], jn: Junctions, junctionClean: boolean): Float64Array[] {
  const finalPts: Float64Array[] = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const n = e.pts.length >> 1;
    const head = jn.has[e.a] === 1;
    const tail = jn.has[e.b] === 1;
    let lo: number;
    let hi: number; // miolo = pts[lo .. hi)
    if (junctionClean) {
      const c0 = head ? jn.cut[2 * i] : 0;
      const c1 = tail ? jn.cut[2 * i + 1] : 0;
      if (c0 + c1 < n) {
        lo = c0;
        hi = n - c1;
      } else {
        lo = 0;
        hi = 0;
      }
    } else {
      lo = head ? 1 : 0;
      hi = Math.max(lo, tail ? n - 1 : n);
    }
    const out = new Float64Array(2 * ((head ? 1 : 0) + (hi - lo) + (tail ? 1 : 0)));
    let o = 0;
    if (head) {
      out[o++] = jn.point[2 * e.a];
      out[o++] = jn.point[2 * e.a + 1];
    }
    out.set(e.pts.subarray(2 * lo, 2 * hi), o);
    o += 2 * (hi - lo);
    if (tail) {
      out[o++] = jn.point[2 * e.b];
      out[o++] = jn.point[2 * e.b + 1];
    }
    finalPts[i] = out;
  }
  return finalPts;
}

// ---------------------------------------------------------------------------------------------
// 6. Traços
// ---------------------------------------------------------------------------------------------

interface Stroke {
  pts: Float64Array;
  closed: boolean;
}

/** Monta os traços seguindo os pares das junções; por último entram os laços puros. Em px da máscara. */
function assembleStrokes(finalPts: readonly Float64Array[], partner: Int32Array, g: PixelGraph, loops: readonly Int32Array[]): Stroke[] {
  const edgeCount = finalPts.length;
  const usedEdge = new Uint8Array(edgeCount);
  /** Segue os pares a partir da ponta `sd` da aresta `i`; devolve os pontos emendados. */
  const walk = (i: number, sd: number): Float64Array => {
    const seq: number[] = [];
    for (;;) {
      usedEdge[i] = 1;
      seq.push(2 * i + sd);
      const nxt = partner[2 * i + (1 - sd)];
      if (nxt < 0 || usedEdge[nxt >> 1]) break;
      i = nxt >> 1;
      sd = nxt & 1;
    }
    let total = 0;
    for (let j = 0; j < seq.length; j++) {
      const cnt = finalPts[seq[j] >> 1].length >> 1;
      total += j === 0 ? cnt : Math.max(cnt - 1, 0);
    }
    const out = new Float64Array(2 * total);
    let m = 0;
    for (let j = 0; j < seq.length; j++) {
      const pts = finalPts[seq[j] >> 1];
      const cnt = pts.length >> 1;
      const rev = (seq[j] & 1) === 1;
      // da segunda aresta em diante o primeiro ponto é o ponto de junção, que já entrou
      for (let t = j === 0 ? 0 : 1; t < cnt; t++, m++) {
        const o = 2 * (rev ? cnt - 1 - t : t);
        out[2 * m] = pts[o];
        out[2 * m + 1] = pts[o + 1];
      }
    }
    return out;
  };
  const endGap = (pts: Float64Array): number => mathHypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]);

  const strokes: Stroke[] = [];
  // primeiro, quem tem ponta sem par: começa dela
  for (let i = 0; i < edgeCount; i++) {
    if (usedEdge[i]) continue;
    for (let sd = 0; sd < 2; sd++) {
      if (partner[2 * i + sd] >= 0) continue;
      const pts = walk(i, sd);
      // laço que volta ao próprio início (ex.: janela com a rebarba removida)
      if (pts.length >> 1 > 8 && endGap(pts) < 2.6 && polylineLength(pts) > 10) {
        strokes.push({ pts: pts.subarray(0, pts.length - 2), closed: true });
      } else {
        strokes.push({ pts, closed: false });
      }
      break;
    }
  }
  // o que sobrou tem par nas duas pontas de todas as arestas: ciclos
  for (let i = 0; i < edgeCount; i++) {
    if (usedEdge[i]) continue;
    const pts = walk(i, 0);
    const closed = pts.length >> 1 > 3 && endGap(pts) < 1e-6;
    strokes.push({ pts: closed ? pts.subarray(0, pts.length - 2) : pts, closed });
  }
  for (const loop of loops) {
    if (loop.length < 4) continue;
    const pts = new Float64Array(2 * loop.length);
    for (let t = 0; t < loop.length; t++) {
      pts[2 * t] = g.xs[loop[t]];
      pts[2 * t + 1] = g.ys[loop[t]];
    }
    strokes.push({ pts, closed: true });
  }
  return strokes;
}

/**
 * Traços de linha única a partir do esqueleto de uma máscara ampliada `k` vezes.
 *
 * `skel`: esqueleto de 1 pixel de espessura (o `skeletonize` do scikit-image). `dist`: transformada
 * de distância euclidiana da máscara ORIGINAL (antes de afinar), linha a linha, do mesmo tamanho;
 * só é lida nos pixels do esqueleto e dá o raio do traço em cada junção. A saída sai em px da
 * imagem original: `(x_ampliado + 0,5) / k`.
 */
export function skeletonStrokes(skel: Mask, dist: Float32Array, k: number, opts: StrokeOptions = {}): StrokeResult {
  const spurPx = opts.spurPx ?? 1.0;
  const pairDeg = opts.pairDeg ?? 42.0;
  const dotPx = opts.dotPx ?? 0.6;
  const junctionClean = opts.junctionClean ?? true;

  const g = buildPixelGraph(skel);
  if (g.count === 0) return { polylines: [], dots: new Float64Array(0) };
  const chains = traceChains(g);
  const nodes = buildNodes(g, chains, dist, skel.width);
  const edges = pruneSpurs(buildEdges(g, chains, nodes), nodes, spurPx * k);
  const junctions = pairJunctions(edges, nodes, pairDeg, junctionClean);
  const strokes = assembleStrokes(finalEdgePoints(edges, junctions, junctionClean), junctions.partner, g, chains.loops);

  // pontos isolados (pixels sem vizinho), em px da máscara; os traços de 1 ponto entram depois deles
  const rawDots: number[] = [];
  for (let p = 0; p < g.count; p++) if (g.off[p + 1] === g.off[p]) rawDots.push(g.xs[p], g.ys[p]);

  // converte para px da imagem original; o que é curto demais vira ponto
  const polylines: Polyline[] = [];
  const shortDots: number[] = [];
  for (const { pts, closed } of strokes) {
    const n = pts.length >> 1;
    if (n < 2) {
      if (n === 1) rawDots.push(pts[0], pts[1]);
      continue;
    }
    const q = new Float64Array(2 * n);
    for (let t = 0; t < 2 * n; t++) q[t] = (pts[t] + 0.5) / k;
    if (!closed && polylineLength(q) < dotPx) {
      let sx = 0;
      let sy = 0;
      for (let t = 0; t < n; t++) {
        sx += q[2 * t];
        sy += q[2 * t + 1];
      }
      shortDots.push(sx / n, sy / n);
    } else {
      polylines.push({ points: q, closed });
    }
  }
  const dots = new Float64Array(rawDots.length + shortDots.length);
  for (let t = 0; t < rawDots.length; t++) dots[t] = (rawDots[t] + 0.5) / k;
  dots.set(shortDots, rawDots.length);
  return { polylines, dots };
}
