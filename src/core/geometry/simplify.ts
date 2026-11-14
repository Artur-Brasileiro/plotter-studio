import type { Polyline } from "./flatten";
import { dist, distToSegment, type Vec } from "./vec";

/**
 * Ramer–Douglas–Peucker: remove os pontos que ficam a menos de epsMm da reta entre
 * os pontos mantidos. Mantém sempre o primeiro e o último. Iterativo (sem recursão),
 * para aguentar polilinhas de centenas de milhares de pontos.
 */
export function rdp(points: readonly Vec[], epsMm: number): Vec[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let worstIdx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distToSegment(points[k], points[i], points[j]);
      if (d > worst) {
        worst = d;
        worstIdx = k;
      }
    }
    if (worstIdx !== -1 && worst > epsMm) {
      keep[worstIdx] = 1;
      stack.push([i, worstIdx], [worstIdx, j]);
    }
  }
  const out: Vec[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(points[k]);
  return out;
}

/**
 * Funde segmentos curtos: remove vértices internos a menos de minLenMm do último
 * vértice mantido. Nunca remove o primeiro nem o último ponto; se o último segmento
 * ficaria curto, quem sai é o vértice interno anterior a ele.
 */
export function dropShortSegments(points: readonly Vec[], minLenMm: number): Vec[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const out: Vec[] = [points[0]];
  for (let i = 1; i < n - 1; i++) {
    if (dist(points[i], out[out.length - 1]) >= minLenMm) out.push(points[i]);
  }
  const last = points[n - 1];
  if (out.length > 1 && dist(last, out[out.length - 1]) < minLenMm) out.pop();
  out.push(last);
  return out;
}

export function polylineLength(points: readonly Vec[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

export interface SimplifyOptions {
  /** Tolerância do RDP (padrão do perfil: 0,05 mm) */
  readonly rdpMm: number;
  /** Segmentos menores que isto são fundidos (padrão: 0,1 mm) */
  readonly minSegmentMm: number;
  /** Traço com comprimento total menor que isto vira um ponto (padrão: 0,05 mm) */
  readonly dotMm?: number;
}

/**
 * RDP + fusão de segmentos curtos. Em laço fechado, divide no ponto mais distante
 * do início e simplifica as duas metades (o RDP precisa de pontas diferentes).
 * Traço minúsculo vira um único ponto ("ponto" = desce e sobe a caneta).
 */
export function simplifyPolyline(pl: Polyline, opts: SimplifyOptions): Polyline {
  const pts = pl.points;
  if (pts.length < 2) return pl;
  const dotMm = opts.dotMm ?? 0.05;
  if (polylineLength(pts) < dotMm) return { points: [pts[0]], closed: false };

  let simplified: Vec[];
  if (pl.closed && pts.length > 3) {
    let far = 1;
    let farD = -1;
    for (let k = 1; k < pts.length - 1; k++) {
      const d = dist(pts[k], pts[0]);
      if (d > farD) {
        farD = d;
        far = k;
      }
    }
    const a = rdp(pts.slice(0, far + 1), opts.rdpMm);
    const b = rdp(pts.slice(far), opts.rdpMm);
    simplified = a.concat(b.slice(1));
  } else {
    simplified = rdp(pts, opts.rdpMm);
  }
  simplified = dropShortSegments(simplified, opts.minSegmentMm);
  if (pl.closed) simplified[simplified.length - 1] = simplified[0];
  return { points: simplified, closed: pl.closed && simplified.length > 2 };
}
