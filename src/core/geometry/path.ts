import { apply, type Mat2D } from "./mat2d";
import type { Vec } from "./vec";

/**
 * Geometria de um desenho: retas e Béziers cúbicas (arcos, círculos e quádricas
 * viram cúbicas na importação). Guardar curvas, e não polilinhas, faz a tolerância
 * de achatamento valer em qualquer escala: o achatamento acontece só no fim,
 * depois de aplicar a transformação final.
 */
export type Segment =
  | { readonly kind: "line"; readonly to: Vec }
  | { readonly kind: "cubic"; readonly c1: Vec; readonly c2: Vec; readonly to: Vec };

export interface SubPath {
  readonly start: Vec;
  readonly segments: readonly Segment[];
  /** true quando veio de Z/polygon/rect/circle. O último segmento termina em `start`. */
  readonly closed: boolean;
}

export interface Geometry {
  readonly subpaths: readonly SubPath[];
}

export interface BBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isEmptyBBox(b: BBox): boolean {
  return !(b.minX <= b.maxX && b.minY <= b.maxY);
}

export function unionBBox(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function bboxOfPoints(points: Iterable<Vec>): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxCenter(b: BBox): Vec {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

export function bboxSize(b: BBox): { width: number; height: number } {
  return { width: b.maxX - b.minX, height: b.maxY - b.minY };
}

function* controlPoints(g: Geometry): Generator<Vec> {
  for (const sp of g.subpaths) {
    yield sp.start;
    for (const s of sp.segments) {
      if (s.kind === "cubic") {
        yield s.c1;
        yield s.c2;
      }
      yield s.to;
    }
  }
}

/** Caixa dos pontos de controle: contém a curva, mas pode ser um pouco maior que ela. */
export function controlBBox(g: Geometry): BBox {
  return bboxOfPoints(controlPoints(g));
}

/** Aplica a matriz aos pontos de controle. É exato para qualquer transformação afim. */
export function transformGeometry(g: Geometry, m: Mat2D): Geometry {
  return {
    subpaths: g.subpaths.map((sp) => ({
      start: apply(m, sp.start),
      closed: sp.closed,
      segments: sp.segments.map((s): Segment =>
        s.kind === "line"
          ? { kind: "line", to: apply(m, s.to) }
          : { kind: "cubic", c1: apply(m, s.c1), c2: apply(m, s.c2), to: apply(m, s.to) },
      ),
    })),
  };
}

export function segmentCount(g: Geometry): number {
  let n = 0;
  for (const sp of g.subpaths) n += sp.segments.length;
  return n;
}

/** Quádrica (p0, q, p2) como cúbica equivalente (exata). */
export function quadToCubic(p0: Vec, q: Vec, p2: Vec): Segment {
  return {
    kind: "cubic",
    c1: { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
    c2: { x: p2.x + (2 / 3) * (q.x - p2.x), y: p2.y + (2 / 3) * (q.y - p2.y) },
    to: p2,
  };
}

const MAX_PIECE = Math.PI / 4; // 45°: erro ~4e-6 × raio

/**
 * Arco de elipse em forma paramétrica, P(θ) = c + R(φ)·(rx·cos θ, ry·sin θ),
 * de θ1 até θ1 + dθ, como cúbicas de no máximo 45° cada.
 * O último ponto é calculado pela fórmula; quem chama pode substituí-lo pelo ponto exato.
 */
export function ellipticArcCubics(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  phiRad: number,
  theta1: number,
  dTheta: number,
): Segment[] {
  const n = Math.max(1, Math.ceil(Math.abs(dTheta) / MAX_PIECE - 1e-9));
  const step = dTheta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const cosPhi = Math.cos(phiRad);
  const sinPhi = Math.sin(phiRad);
  const point = (t: number): Vec => {
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    return { x: cx + cosPhi * x - sinPhi * y, y: cy + sinPhi * x + cosPhi * y };
  };
  const deriv = (t: number): Vec => {
    const x = -rx * Math.sin(t);
    const y = ry * Math.cos(t);
    return { x: cosPhi * x - sinPhi * y, y: sinPhi * x + cosPhi * y };
  };
  const segs: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const t1 = theta1 + i * step;
    const t2 = t1 + step;
    const p1 = point(t1);
    const p2 = point(t2);
    const d1 = deriv(t1);
    const d2 = deriv(t2);
    segs.push({
      kind: "cubic",
      c1: { x: p1.x + k * d1.x, y: p1.y + k * d1.y },
      c2: { x: p2.x - k * d2.x, y: p2.y - k * d2.y },
      to: p2,
    });
  }
  return segs;
}

/** Elipse completa em 8 cúbicas de 45°, começando em (cx+rx, cy), ângulo crescente (horário na tela). */
export function ellipseSubPath(cx: number, cy: number, rx: number, ry: number): SubPath {
  const start = { x: cx + rx, y: cy };
  const segs = ellipticArcCubics(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
  const last = segs[segs.length - 1];
  if (last.kind === "cubic") segs[segs.length - 1] = { ...last, to: start };
  return { start, segments: segs, closed: true };
}
