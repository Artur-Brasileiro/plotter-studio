import { dist, type Vec } from "../geometry/vec";
import type { InkSearch } from "./inkpath";
import type { OrderedStroke, Stroke } from "./types";

export interface OrderOptions {
  /** Onde a caneta está ao começar (mm da máquina) */
  readonly start: Vec;
  /** Salto até este tamanho não aparece: liga sem levantar a caneta (largura da caneta) */
  readonly joinGapMm: number;
  /** Pode desenhar um traço aberto de trás para frente */
  readonly allowReverse: boolean;
  /** Um laço fechado pode começar em qualquer vértice */
  readonly rotateClosed: boolean;
  /** Procura um traço para emendar até esta distância (REGRAS_GCODE.md, regra 2). 0 = só `joinGapMm`. */
  readonly searchMm?: number;
  /** A ligação reta de a até b ficaria escondida (por cima de tinta)? Sem isto, só vale `joinGapMm`. */
  readonly bridgeHidden?: (a: Vec, b: Vec) => boolean;
  /**
   * Caminho pela tinta (inkpath.ts): sem emenda reta, a caneta ainda pode andar embaixo por cima das
   * linhas do desenho até o próximo traço, se o caminho tiver até `maxMm`. O grafo tem de ser o destes `strokes`.
   */
  readonly route?: { readonly search: InkSearch; readonly maxMm: number };
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

  /** Chama `visit` para cada entrada de traço não usado a até `radius` de p. */
  within(p: Vec, radius: number, used: Uint8Array, visit: (e: Entry, d: number) => void): void {
    const c0x = Math.floor((p.x - radius) / CELL), c1x = Math.floor((p.x + radius) / CELL);
    const c0y = Math.floor((p.y - radius) / CELL), c1y = Math.floor((p.y + radius) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const list = this.cells.get(this.key(cx, cy));
        if (!list) continue;
        for (const e of list) {
          if (used[e.stroke]) continue;
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          if (d <= radius) visit(e, d);
        }
      }
    }
  }
}

/** Desempate determinístico: menor distância, depois menor índice de traço, depois ordem de inserção. */
function better(e: Entry, d: number, best: Entry | undefined, bestD: number): boolean {
  if (!best) return true;
  if (d < bestD - 1e-9) return true;
  if (d > bestD + 1e-9) return false;
  return e.stroke < best.stroke || (e.stroke === best.stroke && e.order < best.order);
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
 * Ordem dos traços pensando no servo (REGRAS_GCODE.md, regras 1 e 2). A cada passo:
 *  1. procura perto um traço que dê para EMENDAR sem aparecer: salto menor que a caneta, ou
 *     ligação que passa inteira por cima de tinta (até `searchMm`);
 *  2. só se não houver, vai ao mais próximo, levantando a caneta.
 * Com inversão de traços abertos e rotação de laços. Grade espacial de 10 mm: ~20 mil traços
 * em bem menos de 1 s. Saída determinística.
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
  /** Nó do grafo da tinta onde a caneta está (−1 = fora do desenho, no começo) */
  let curNode = -1;
  const reach = Math.max(opts.joinGapMm, opts.bridgeHidden ? (opts.searchMm ?? 0) : 0);
  for (let count = 0; count < strokes.length; count++) {
    let e: Entry | undefined;
    let joined = false;
    if (out.length > 0 && reach > 0) {
      // 1) dá para emendar? Primeiro o salto que cabe na largura da caneta; depois a ponte sobre tinta.
      let near: Entry | undefined, nearD = Infinity;
      let bridge: Entry | undefined, bridgeD = Infinity;
      const from = cur;
      grid.within(from, reach, used, (c, d) => {
        if (d <= opts.joinGapMm) {
          if (better(c, d, near, nearD)) (near = c), (nearD = d);
        } else if (better(c, d, bridge, bridgeD) && opts.bridgeHidden!(from, { x: c.x, y: c.y })) {
          (bridge = c), (bridgeD = d);
        }
      });
      e = near ?? bridge;
      joined = !!e;
    }
    // 2) senão, andando embaixo pelo caminho da tinta
    let path: Vec[] | undefined;
    if (!e && opts.route && curNode >= 0) {
      const r = opts.route.search.nearestEntry(curNode, opts.route.maxMm, used);
      if (r) {
        const p = strokes[r.stroke].points;
        const at = r.vertex === -1 ? p[p.length - 1] : p[r.vertex];
        e = { stroke: r.stroke, vertex: r.vertex, x: at.x, y: at.y, order: -1 };
        joined = true;
        path = r.path.slice(0, -1); // o último ponto do caminho é a entrada do traço
      }
    }
    // 3) senão, o mais próximo, com a caneta levantada
    e ??= grid.nearest(cur, used);
    if (!e) break;
    used[e.stroke] = 1;
    const s = orient(strokes[e.stroke], e);
    // o caminho pela tinta entra no começo do traço: a caneta o percorre embaixo antes de desenhar
    if (path?.length) {
      let retraceMm = 0;
      for (let j = 0; j < path.length; j++) retraceMm += dist(path[j], j + 1 < path.length ? path[j + 1] : s.points[0]);
      out.push({ ...s, points: [...path, ...s.points], closed: false, joinedToPrevious: joined, retraceMm });
    } else out.push({ ...s, joinedToPrevious: joined });
    cur = s.points[s.points.length - 1];
    if (opts.route) {
      const n = strokes[e.stroke].points.length;
      const endVertex = strokes[e.stroke].closed ? Math.max(0, e.vertex) : e.vertex === -1 ? 0 : n - 1;
      curNode = opts.route.search.node(e.stroke, endVertex);
    }
  }
  // traços vazios (sem pontos) não entram
  return out;
}

/** Menor resto de descida (mm) que justifica levantar e descer a caneta de novo no corte da regra 5. */
export const MIN_TAIL_MM = 0.5;

/**
 * REGRAS_GCODE.md, regra 5: uma descida não desenha mais que `maxMm` (pode passar até MIN_TAIL_MM). Ao atingir o limite a caneta
 * sobe e desce no mesmo ponto (`relift`), o que não deixa marca. Vem DEPOIS das emendas, porque
 * são elas que juntam traços em cadeias longas. Corta no meio de um segmento se for preciso.
 */
export function capDescents(strokes: readonly OrderedStroke[], maxMm: number): OrderedStroke[] {
  if (!(maxMm > 0)) return [...strokes];
  const out: OrderedStroke[] = [];
  let acc = 0; // mm desenhados desde a última descida
  let prevEnd: Vec | undefined;
  // comprimento de cada traço e do que ainda vem depois dele NA MESMA descida (emendas incluídas)
  const lens = strokes.map((s) => {
    let l = 0;
    for (let j = 1; j < s.points.length; j++) l += dist(s.points[j - 1], s.points[j]);
    return l;
  });
  const after = new Array<number>(strokes.length).fill(0);
  for (let i = strokes.length - 2; i >= 0; i--) {
    const a = strokes[i].points, nx = strokes[i + 1];
    if (a.length && nx.points.length && nx.joinedToPrevious) after[i] = dist(a[a.length - 1], nx.points[0]) + lens[i + 1] + after[i + 1];
  }
  for (let si = 0; si < strokes.length; si++) {
    const s = strokes[si];
    const pts = s.points;
    if (pts.length === 0) continue;
    let relift = false;
    /** Quanto deste traço ainda falta desenhar, a partir do ponto atual */
    let left = lens[si];
    if (!s.joinedToPrevious || !prevEnd) acc = 0;
    else {
      const gap = dist(prevEnd, pts[0]);
      // (se o que falta da descida é um restinho, não vale levantar a caneta por ele)
      if (acc > 0 && acc + gap > maxMm && gap + left + after[si] >= MIN_TAIL_MM) {
        relift = true;
        acc = gap;
      } else acc += gap;
    }
    let cur: Vec[] = [pts[0]];
    let first = true;
    const flush = (closedPiece: boolean) => {
      out.push({ ...s, points: cur, closed: closedPiece, joinedToPrevious: first ? s.joinedToPrevious : true, relift: first ? relift || undefined : true });
      first = false;
    };
    for (let j = 1; j < pts.length; j++) {
      let a = pts[j - 1];
      const b = pts[j];
      let len = dist(a, b);
      while (acc + len > maxMm + 1e-9 && len > 1e-9) {
        const room = Math.max(0, maxMm - acc);
        // Sobra menor que isto depois do corte: não corta. Um ciclo do servo para riscar meio milímetro
        // (ou 0,004 mm, que no G-code nem vira movimento) é pior que passar meio milímetro do limite.
        if (left - room + after[si] < MIN_TAIL_MM) break;
        if (room > 1e-6) {
          const t = room / len;
          a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          cur.push(a);
          len -= room;
          left -= room;
        }
        if (cur.length > 1) {
          flush(false);
          cur = [a];
        } else if (first) {
          relift = true; // o limite caiu exatamente no começo deste traço: basta re-descer aqui
        }
        acc = 0;
      }
      cur.push(b);
      acc += len;
      left -= len;
    }
    // sem corte, o traço sai inteiro (e continua fechado se era)
    flush(first ? s.closed : false);
    prevEnd = pts[pts.length - 1];
  }
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
