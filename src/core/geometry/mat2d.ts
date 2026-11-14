import type { Vec } from "./vec";

/**
 * Matriz afim 2D no mesmo formato do Canvas, do SVG e do Fabric:
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
export type Mat2D = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

/** m1 ∘ m2: aplica m2 primeiro, depois m1 (igual a multiplyTransformMatrices do Fabric). */
export function multiply(m1: Mat2D, m2: Mat2D): Mat2D {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Compõe da esquerda para a direita: multiplyAll(A, B, C) = A ∘ B ∘ C (C é aplicada primeiro). */
export function multiplyAll(...ms: Mat2D[]): Mat2D {
  return ms.reduce((acc, m) => multiply(acc, m), IDENTITY);
}

export function determinant(m: Mat2D): number {
  return m[0] * m[3] - m[1] * m[2];
}

export function invert(m: Mat2D): Mat2D {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error("Matriz sem inversa (escala zero).");
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply(m: Mat2D, p: Vec): Vec {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function translation(tx: number, ty: number): Mat2D {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx: number, sy: number = sx): Mat2D {
  return [sx, 0, 0, sy, 0, 0];
}

/** Rotação no sentido do sistema em que for aplicada (em Y para baixo, positivo = horário na tela, como no SVG). */
export function rotationDeg(deg: number): Mat2D {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, 0, 0];
}

export function skewXDeg(deg: number): Mat2D {
  return [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
}

export function skewYDeg(deg: number): Mat2D {
  return [1, Math.tan((deg * Math.PI) / 180), 0, 1, 0, 0];
}

export function nearlyEqualMat(m1: Mat2D, m2: Mat2D, eps = 1e-9): boolean {
  for (let i = 0; i < 6; i++) if (Math.abs(m1[i] - m2[i]) > eps) return false;
  return true;
}

/** Fator de escala médio (raiz do |determinante|): quanto um comprimento cresce, em média. */
export function meanScale(m: Mat2D): number {
  return Math.sqrt(Math.abs(determinant(m)));
}
