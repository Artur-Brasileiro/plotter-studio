import type { Mat2D } from "./mat2d";
import { transformGeometry, type Geometry, type SubPath } from "./path";
import type { Vec } from "./vec";

export interface Polyline {
  readonly points: readonly Vec[];
  /** closed ⇒ points[0] e points[n−1] são exatamente o mesmo ponto */
  readonly closed: boolean;
}

const MAX_SEGMENTS_PER_CUBIC = 100_000;

/**
 * Fórmula de Wang: com n passos uniformes em t, a distância entre a cúbica e a
 * polilinha fica abaixo de tol. M é a maior "segunda diferença" dos pontos de controle.
 */
export function cubicSegmentCount(p0: Vec, c1: Vec, c2: Vec, p3: Vec, tolMm: number): number {
  const m1 = Math.hypot(p0.x - 2 * c1.x + c2.x, p0.y - 2 * c1.y + c2.y);
  const m2 = Math.hypot(c1.x - 2 * c2.x + p3.x, c1.y - 2 * c2.y + p3.y);
  const m = Math.max(m1, m2);
  if (m === 0) return 1;
  const n = Math.ceil(Math.sqrt((0.75 * m) / tolMm));
  return Math.min(Math.max(n, 1), MAX_SEGMENTS_PER_CUBIC);
}

function cubicAt(p0: Vec, c1: Vec, c2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y };
}

export function flattenSubPath(sp: SubPath, tolMm: number): Polyline {
  const points: Vec[] = [sp.start];
  let cur = sp.start;
  for (const s of sp.segments) {
    if (s.kind === "line") {
      points.push(s.to);
    } else {
      const n = cubicSegmentCount(cur, s.c1, s.c2, s.to, tolMm);
      for (let i = 1; i < n; i++) points.push(cubicAt(cur, s.c1, s.c2, s.to, i / n));
      points.push(s.to);
    }
    cur = s.to;
  }
  if (sp.closed && points.length > 1) points[points.length - 1] = points[0];
  return { points, closed: sp.closed };
}

/** Transforma ANTES de achatar: a tolerância vale no espaço de destino (mm da máquina). */
export function flattenGeometry(g: Geometry, m: Mat2D, tolMm: number): Polyline[] {
  const tg = transformGeometry(g, m);
  const out: Polyline[] = [];
  for (const sp of tg.subpaths) {
    if (sp.segments.length === 0) continue;
    out.push(flattenSubPath(sp, tolMm));
  }
  return out;
}

export { cubicAt };
