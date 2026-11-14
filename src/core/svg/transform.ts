import {
  IDENTITY,
  multiply,
  rotationDeg,
  scaling,
  skewXDeg,
  skewYDeg,
  translation,
  type Mat2D,
} from "../geometry/mat2d";
import { parseNumberList } from "./node";

const FN_RE = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/y;

/**
 * Atributo transform do SVG → matriz. A lista é composta da esquerda para a direita
 * ("translate(10) scale(2)" = translate ∘ scale: escala primeiro, depois translada).
 * Qualquer coisa inválida → { m: IDENTITY, ok: false } (quem chama gera o aviso).
 */
export function parseTransformList(s: string): { m: Mat2D; ok: boolean } {
  let m: Mat2D = IDENTITY;
  let i = 0;
  const src = s.trim();
  while (i < src.length) {
    FN_RE.lastIndex = i;
    const match = FN_RE.exec(src);
    if (!match) return { m: IDENTITY, ok: false };
    i = FN_RE.lastIndex;
    const args = parseNumberList(match[2]);
    if (!args) return { m: IDENTITY, ok: false };
    const t = toMatrix(match[1], args);
    if (!t) return { m: IDENTITY, ok: false };
    m = multiply(m, t);
  }
  return { m, ok: true };
}

function toMatrix(fn: string, a: number[]): Mat2D | undefined {
  switch (fn) {
    case "matrix":
      return a.length === 6 ? [a[0], a[1], a[2], a[3], a[4], a[5]] : undefined;
    case "translate":
      return a.length === 1 || a.length === 2 ? translation(a[0], a[1] ?? 0) : undefined;
    case "scale":
      return a.length === 1 || a.length === 2 ? scaling(a[0], a[1] ?? a[0]) : undefined;
    case "rotate":
      if (a.length === 1) return rotationDeg(a[0]);
      if (a.length === 3) {
        return multiply(translation(a[1], a[2]), multiply(rotationDeg(a[0]), translation(-a[1], -a[2])));
      }
      return undefined;
    case "skewX":
      return a.length === 1 ? skewXDeg(a[0]) : undefined;
    case "skewY":
      return a.length === 1 ? skewYDeg(a[0]) : undefined;
  }
  return undefined;
}
