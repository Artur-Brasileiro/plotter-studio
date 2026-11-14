import { describe, expect, it } from "vitest";
import { cubicAt, cubicSegmentCount, flattenGeometry, flattenSubPath } from "./flatten";
import { IDENTITY, scaling } from "./mat2d";
import { ellipseSubPath, type Geometry } from "./path";
import { distToSegment, type Vec } from "./vec";

describe("cubicSegmentCount (fórmula de Wang)", () => {
  it("cúbica de 45° de raio 30 com tolerância 0,05 → 7 segmentos", () => {
    const sp = ellipseSubPath(0, 0, 30, 30);
    const s = sp.segments[0];
    if (s.kind !== "cubic") throw new Error("esperava cúbica");
    expect(cubicSegmentCount(sp.start, s.c1, s.c2, s.to, 0.05)).toBe(7);
  });

  it("cúbica degenerada (reta) → 1 segmento", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    // pontos de controle igualmente espaçados: segunda diferença zero
    expect(cubicSegmentCount(a, { x: 10 / 3, y: 0 }, { x: 20 / 3, y: 0 }, b, 0.05)).toBe(1);
  });
});

describe("flattenSubPath / flattenGeometry", () => {
  it("círculo R30 vira 56 segmentos (8 cúbicas × 7) e fecha no mesmo ponto", () => {
    const pl = flattenSubPath(ellipseSubPath(60, 60, 30, 30), 0.05);
    expect(pl.points).toHaveLength(57);
    expect(pl.closed).toBe(true);
    expect(pl.points[56]).toBe(pl.points[0]);
  });

  it("reta continua sendo 1 segmento", () => {
    const g: Geometry = { subpaths: [{ start: { x: 0, y: 0 }, segments: [{ kind: "line", to: { x: 100, y: 0 } }], closed: false }] };
    const [pl] = flattenGeometry(g, IDENTITY, 0.05);
    expect(pl.points).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("a tolerância vale DEPOIS da transformação: círculo R3 ampliado 10× também dá 56 segmentos", () => {
    const g: Geometry = { subpaths: [ellipseSubPath(0, 0, 3, 3)] };
    const [pl] = flattenGeometry(g, scaling(10), 0.05);
    expect(pl.points).toHaveLength(57);
  });

  it("subpath sem segmentos é descartado", () => {
    const g: Geometry = { subpaths: [{ start: { x: 1, y: 1 }, segments: [], closed: false }] };
    expect(flattenGeometry(g, IDENTITY, 0.05)).toHaveLength(0);
  });

  it("o desvio entre a curva e a polilinha fica ≤ 0,05 mm (1000 amostras por cúbica)", () => {
    const sp = ellipseSubPath(0, 0, 47, 13); // elipse achatada: curvatura variável
    const pl = flattenSubPath(sp, 0.05);
    const pts = pl.points;
    const distToPolyline = (p: Vec) => {
      let best = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]));
      return best;
    };
    let cur = sp.start;
    let worst = 0;
    for (const s of sp.segments) {
      if (s.kind !== "cubic") continue;
      for (let i = 0; i <= 1000; i++) worst = Math.max(worst, distToPolyline(cubicAt(cur, s.c1, s.c2, s.to, i / 1000)));
      cur = s.to;
    }
    expect(worst).toBeLessThanOrEqual(0.05);
    expect(worst).toBeGreaterThan(0.005); // e não está achatando fino demais
  });
});
