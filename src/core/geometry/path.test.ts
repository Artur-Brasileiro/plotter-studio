import { describe, expect, it } from "vitest";
import { cubicAt, flattenSubPath } from "./flatten";
import { scaling } from "./mat2d";
import { controlBBox, ellipseSubPath, quadToCubic, segmentCount, transformGeometry } from "./path";
import { dist } from "./vec";

describe("ellipseSubPath", () => {
  const circle = ellipseSubPath(60, 60, 30, 30);

  it("é um laço fechado de 8 cúbicas começando em (cx+r, cy)", () => {
    expect(circle.segments).toHaveLength(8);
    expect(circle.segments.every((s) => s.kind === "cubic")).toBe(true);
    expect(circle.start).toEqual({ x: 90, y: 60 });
    expect(circle.closed).toBe(true);
    expect(circle.segments[7].to).toBe(circle.start);
  });

  it("vai no sentido do ângulo crescente (para baixo na tela, Y↓)", () => {
    const first = circle.segments[0].to; // 45°
    expect(first.y).toBeGreaterThan(60);
    expect(first.x).toBeLessThan(90);
  });

  it("todos os pontos ficam a 30 ± 0,001 do centro", () => {
    const pl = flattenSubPath(circle, 0.01);
    for (const p of pl.points) expect(Math.abs(dist(p, { x: 60, y: 60 }) - 30)).toBeLessThan(0.001);
  });
});

describe("quadToCubic", () => {
  it("reproduz a quádrica em t = 0,5", () => {
    const p0 = { x: 0, y: 0 };
    const q = { x: 10, y: 20 };
    const p2 = { x: 20, y: 0 };
    const c = quadToCubic(p0, q, p2);
    if (c.kind !== "cubic") throw new Error("esperava cúbica");
    const mid = cubicAt(p0, c.c1, c.c2, c.to, 0.5);
    // quádrica em t=0,5: 0,25·p0 + 0,5·q + 0,25·p2 = (10, 10)
    expect(mid.x).toBeCloseTo(10, 12);
    expect(mid.y).toBeCloseTo(10, 12);
  });
});

describe("transformGeometry e controlBBox", () => {
  it("escala os pontos de controle", () => {
    const g = { subpaths: [ellipseSubPath(0, 0, 1, 1)] };
    const t = transformGeometry(g, scaling(10));
    const b = controlBBox(t);
    expect(b.maxX).toBeCloseTo(10, 9);
    expect(b.minX).toBeCloseTo(-10, 9);
    expect(segmentCount(t)).toBe(8);
  });
});
