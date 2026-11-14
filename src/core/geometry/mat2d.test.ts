import { describe, expect, it } from "vitest";
import {
  apply,
  determinant,
  IDENTITY,
  invert,
  multiply,
  nearlyEqualMat,
  rotationDeg,
  scaling,
  skewXDeg,
  translation,
} from "./mat2d";

describe("mat2d", () => {
  it("multiply aplica a matriz da direita primeiro", () => {
    // escala 2 e depois translada 10 em X: (1,1) → (2,2) → (12,2)
    const p = apply(multiply(translation(10, 0), scaling(2)), { x: 1, y: 1 });
    expect(p.x).toBeCloseTo(12, 12);
    expect(p.y).toBeCloseTo(2, 12);
  });

  it("invert × original = identidade", () => {
    const m = multiply(translation(5, -3), multiply(rotationDeg(37), scaling(2, 0.5)));
    expect(nearlyEqualMat(multiply(invert(m), m), IDENTITY)).toBe(true);
    expect(nearlyEqualMat(multiply(m, invert(m)), IDENTITY)).toBe(true);
  });

  it("invert recusa matriz degenerada", () => {
    expect(() => invert(scaling(0, 1))).toThrow();
  });

  it("rotationDeg(90) leva (1,0) a (0,1)", () => {
    const p = apply(rotationDeg(90), { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(1, 12);
  });

  it("skewX(45) leva (1,1) a (2,1)", () => {
    const p = apply(skewXDeg(45), { x: 1, y: 1 });
    expect(p.x).toBeCloseTo(2, 12);
    expect(p.y).toBeCloseTo(1, 12);
  });

  it("determinante negativo = espelhamento", () => {
    expect(determinant(scaling(-1, 1))).toBeLessThan(0);
    expect(determinant(rotationDeg(123))).toBeCloseTo(1, 12);
  });
});
