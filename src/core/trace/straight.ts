import type { Segment } from "../geometry/path";

/**
 * "Régua": trechos retos do desenho viram retas de verdade. Porte de `lab/python/straight.py`.
 *
 * O ajuste de curvas segue o esqueleto pixel a pixel, então a reta longa de um desenho técnico sai
 * levemente ondulada. Aqui cada peça (trecho entre dois cantos) é dividida em TRECHOS RETOS e
 * TRECHOS CURVOS antes do ajuste:
 *  1. Ramer–Douglas–Peucker com tolerância `snap` acha os vértices candidatos.
 *  2. Um segmento entre dois vértices é RETO se for longo o bastante e os pontos dele oscilarem dos
 *     dois lados da corda (ruído), e não todos do mesmo lado (arco).
 *  3. Dois retos seguidos que viram pouco um para o outro são, na verdade, uma curva suave: voltam
 *     a ser curva (senão um arco aberto viraria um polígono).
 *  4. Retos saem como retas (ajustadas por mínimos quadrados); curvas passam pelo ajuste de Bézier
 *     de sempre, com tangente contínua onde encostam numa reta.
 */
export interface StraightParams {
  /** Tolerância da régua (px): quanto o traço pode fugir da reta e ainda ser reta */
  readonly snap: number;
  /** Erro máximo do ajuste das curvas (px) */
  readonly tol: number;
  readonly twArc: number;
  readonly tw: number;
  readonly lineTol: number;
  /** Tangentes já conhecidas nas pontas da peça (curva fechada sem cantos) */
  readonly t1?: readonly [number, number];
  readonly t2?: readonly [number, number];
  /** Um trecho reto tem pelo menos isto de comprimento (px). Padrão 6. */
  readonly minLen?: number;
}

/** O que a régua precisa do ajuste de curvas (passado por quem chama: evita importação circular). */
export interface StraightTools {
  schneider(Q: Float64Array, nq: number, t1: readonly [number, number], t2: readonly [number, number], err2: number, tw: number): Float64Array[];
  endTangent(Q: Float64Array, n: number, twArc: number, fromEnd: boolean): [number, number];
}

const SMALL_SAG = 0.12; // flecha menor que isto é reta, seja arco ou não (não aparece)
const ONE_SIDE = 0.5; // acima disto os desvios estão todos do mesmo lado: é arco
const GENTLE_DEG = 6; // dois retos que viram menos que isto são uma curva suave

function unit(x: number, y: number): [number, number] {
  const n = Math.hypot(x, y);
  return n < 1e-12 ? [1, 0] : [x / n, y / n];
}

/** Índices dos vértices que o Ramer–Douglas–Peucker mantém. */
export function rdpIndices(Q: Float64Array, n: number, tol: number): number[] {
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    if (b - a < 2) continue;
    const px = Q[2 * a], py = Q[2 * a + 1];
    const dx = Q[2 * b] - px, dy = Q[2 * b + 1] - py;
    const L = Math.hypot(dx, dy);
    let best = -1, bestDev = -1;
    for (let i = a + 1; i < b; i++) {
      const sx = Q[2 * i] - px, sy = Q[2 * i + 1] - py;
      const dev = L < 1e-12 ? Math.hypot(sx, sy) : Math.abs(sx * dy - sy * dx) / L;
      if (dev > bestDev) {
        bestDev = dev;
        best = i;
      }
    }
    if (bestDev > tol) {
      keep[best] = 1;
      stack.push(a, best, best, b);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return idx;
}

/** Quais segmentos entre vértices do RDP são retos. */
export function classifyRuns(Q: Float64Array, n: number, snap: number, minLen: number): { idx: number[]; straight: boolean[] } {
  const idx = rdpIndices(Q, n, snap);
  const straight: boolean[] = [];
  for (let s = 0; s + 1 < idx.length; s++) {
    const a = idx[s], b = idx[s + 1];
    const px = Q[2 * a], py = Q[2 * a + 1];
    const dx = Q[2 * b] - px, dy = Q[2 * b + 1] - py;
    const L = Math.hypot(dx, dy);
    if (L < minLen) {
      straight.push(false);
      continue;
    }
    const count = b - a - 1;
    if (count <= 0) {
      straight.push(true);
      continue;
    }
    let sum = 0, sumAbs = 0, mx = 0;
    for (let i = a + 1; i < b; i++) {
      const dev = ((Q[2 * i] - px) * dy - (Q[2 * i + 1] - py) * dx) / L;
      sum += dev;
      const ad = Math.abs(dev);
      sumAbs += ad;
      if (ad > mx) mx = ad;
    }
    if (mx <= SMALL_SAG) {
      straight.push(true);
      continue;
    }
    const rho = Math.abs(sum / count) / (sumAbs / count + 1e-12);
    straight.push(rho < ONE_SIDE);
  }
  const thr = (GENTLE_DEG * Math.PI) / 180;
  const kill = straight.map(() => false);
  for (let i = 0; i + 1 < straight.length; i++) {
    if (!straight[i] || !straight[i + 1]) continue;
    const ax = Q[2 * idx[i + 1]] - Q[2 * idx[i]], ay = Q[2 * idx[i + 1] + 1] - Q[2 * idx[i] + 1];
    const bx = Q[2 * idx[i + 2]] - Q[2 * idx[i + 1]], by = Q[2 * idx[i + 2] + 1] - Q[2 * idx[i + 1] + 1];
    const ang = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    if (ang > (0.5 * Math.PI) / 180 && ang < thr) kill[i] = kill[i + 1] = true;
  }
  return { idx, straight: straight.map((v, i) => v && !kill[i]) };
}

interface Line {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
}

/** Reta de mínimos quadrados totais pelos pontos a..b (inclusive). */
function tlsLine(Q: Float64Array, a: number, b: number): Line {
  const m = b - a + 1;
  let cx = 0, cy = 0;
  for (let i = a; i <= b; i++) {
    cx += Q[2 * i];
    cy += Q[2 * i + 1];
  }
  cx /= m;
  cy /= m;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = a; i <= b; i++) {
    const x = Q[2 * i] - cx, y = Q[2 * i + 1] - cy;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, ux: Math.cos(th), uy: Math.sin(th) };
}

function project(x: number, y: number, l: Line): [number, number] {
  const t = (x - l.cx) * l.ux + (y - l.cy) * l.uy;
  return [l.cx + l.ux * t, l.cy + l.uy * t];
}

/**
 * Ajusta uma peça (sem cantos no meio). Devolve os segmentos, ou `undefined` se a peça não tem
 * nenhum trecho reto (quem chama faz o ajuste normal).
 */
export function fitPieceStraight(Q: Float64Array, nq: number, p: StraightParams, tools: StraightTools): Segment[] | undefined {
  if (nq < 3) return [{ kind: "line", to: { x: Q[2 * nq - 2], y: Q[2 * nq - 1] } }];
  const { idx, straight } = classifyRuns(Q, nq, p.snap, p.minLen ?? 6);
  const nseg = straight.length;
  if (!straight.some(Boolean)) return undefined;
  const lines: (Line | undefined)[] = straight.map((s, i) => (s ? tlsLine(Q, idx[i], idx[i + 1]) : undefined));

  // vértices ajustados: as pontas da peça (cantos) ficam onde estão
  const V: [number, number][] = idx.map((k) => [Q[2 * k], Q[2 * k + 1]]);
  for (let j = 1; j + 1 < idx.length; j++) {
    const left = lines[j - 1];
    const right = lines[j];
    if (left && right) {
      const cr = left.ux * right.uy - left.uy * right.ux;
      let done = false;
      if (Math.abs(cr) > 0.05) {
        const wx = right.cx - left.cx, wy = right.cy - left.cy;
        const t = (wx * right.uy - wy * right.ux) / cr;
        const X: [number, number] = [left.cx + left.ux * t, left.cy + left.uy * t];
        if (Math.hypot(X[0] - V[j][0], X[1] - V[j][1]) < 1.0) {
          V[j] = X;
          done = true;
        }
      }
      if (!done) {
        const a = project(V[j][0], V[j][1], left);
        const b = project(V[j][0], V[j][1], right);
        V[j] = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
      }
    } else if (left) V[j] = project(V[j][0], V[j][1], left);
    else if (right) V[j] = project(V[j][0], V[j][1], right);
  }

  const out: Segment[] = [];
  const err2 = p.tol * p.tol;
  let i = 0;
  while (i < nseg) {
    if (straight[i]) {
      out.push({ kind: "line", to: { x: V[i + 1][0], y: V[i + 1][1] } });
      i++;
      continue;
    }
    let j = i;
    while (j < nseg && !straight[j]) j++;
    // pontos do trecho curvo, com as pontas nos vértices ajustados e sem repetidos
    const a = idx[i], b = idx[j];
    const raw = Q.slice(2 * a, 2 * b + 2);
    raw[0] = V[i][0];
    raw[1] = V[i][1];
    raw[raw.length - 2] = V[j][0];
    raw[raw.length - 1] = V[j][1];
    const pts = new Float64Array(raw.length);
    let m = 0;
    for (let k = 0; k < raw.length; k += 2) {
      if (m > 0 && Math.abs(raw[k] - pts[2 * m - 2]) <= 1e-9 && Math.abs(raw[k + 1] - pts[2 * m - 1]) <= 1e-9) continue;
      pts[2 * m] = raw[k];
      pts[2 * m + 1] = raw[k + 1];
      m++;
    }
    if (m >= 2) {
      if (m === 2) out.push({ kind: "line", to: { x: pts[2], y: pts[3] } });
      else {
        const P = pts.subarray(0, 2 * m);
        // tangente contínua onde a curva encosta numa reta
        const t1 = i > 0 && straight[i - 1] ? unit(V[i][0] - V[i - 1][0], V[i][1] - V[i - 1][1]) : i === 0 && p.t1 ? p.t1 : tools.endTangent(P, m, p.twArc, false);
        const t2 = j < nseg && straight[j] ? unit(V[j][0] - V[j + 1][0], V[j][1] - V[j + 1][1]) : j === nseg && p.t2 ? p.t2 : tools.endTangent(P, m, p.twArc, true);
        for (const bez of tools.schneider(P, m, t1, t2, err2, p.tw)) {
          const chx = bez[6] - bez[0], chy = bez[7] - bez[1];
          const L = Math.hypot(chx, chy);
          let isLine = true;
          if (!(L < 1e-9)) {
            const nx = -chy / L, ny = chx / L;
            const d1 = Math.abs((bez[2] - bez[0]) * nx + (bez[3] - bez[1]) * ny);
            const d2 = Math.abs((bez[4] - bez[0]) * nx + (bez[5] - bez[1]) * ny);
            isLine = Math.max(d1, d2) < p.lineTol;
          }
          const to = { x: bez[6], y: bez[7] };
          out.push(isLine ? { kind: "line", to } : { kind: "cubic", c1: { x: bez[2], y: bez[3] }, c2: { x: bez[4], y: bez[5] }, to });
        }
      }
    }
    i = j;
  }
  return out;
}
