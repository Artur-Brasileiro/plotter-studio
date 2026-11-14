import { describe, expect, it } from "vitest";
import { flattenSubPath } from "../geometry/flatten";
import { el } from "./node";
import { shapeToSubPaths } from "./shapes";

describe("shapeToSubPaths", () => {
  it("rect sem rx: 4 retas fechadas começando em (x,y)", () => {
    const [sp] = shapeToSubPaths(el("rect", { x: "10", y: "10", width: "100", height: "100" }))!;
    expect(sp.start).toEqual({ x: 10, y: 10 });
    expect(sp.segments.map((s) => s.to)).toEqual([
      { x: 110, y: 10 },
      { x: 110, y: 110 },
      { x: 10, y: 110 },
      { x: 10, y: 10 },
    ]);
    expect(sp.closed).toBe(true);
    expect(sp.segments[3].to).toBe(sp.start);
  });

  it("rect com só rx → ry = rx (4 retas + 4 cantos de 90°, cada canto = 2 cúbicas de 45°)", () => {
    const [sp] = shapeToSubPaths(el("rect", { width: "20", height: "10", rx: "2" }))!;
    expect(sp.segments.filter((s) => s.kind === "line")).toHaveLength(4);
    expect(sp.segments.filter((s) => s.kind === "cubic")).toHaveLength(8);
    const p = flattenSubPath(sp, 0.01).points;
    expect(Math.min(...p.map((q) => q.y))).toBeCloseTo(0, 9);
    expect(Math.max(...p.map((q) => q.y))).toBeCloseTo(10, 9);
  });

  it("rx maior que metade do lado é limitado, e retas de tamanho zero não entram", () => {
    // rx = 50 → limitado a 5 (w/2); ry = rx = 50 → limitado a 2 (h/2): as 4 retas teriam 0 mm
    const [sp] = shapeToSubPaths(el("rect", { width: "10", height: "4", rx: "50" }))!;
    expect(sp.segments.every((s) => s.kind === "cubic")).toBe(true);
    expect(sp.segments).toHaveLength(8);
    expect(sp.closed).toBe(true);
    expect(sp.segments[7].to).toBe(sp.start);
  });

  it("formas vazias", () => {
    expect(shapeToSubPaths(el("rect", { width: "0", height: "10" }))).toEqual([]);
    expect(shapeToSubPaths(el("circle", { r: "0" }))).toEqual([]);
    expect(shapeToSubPaths(el("polyline", { points: "1,1" }))).toEqual([]);
  });

  it("circle e ellipse", () => {
    const [c] = shapeToSubPaths(el("circle", { cx: "60", cy: "60", r: "30" }))!;
    expect(c.start).toEqual({ x: 90, y: 60 });
    const [e] = shapeToSubPaths(el("ellipse", { cx: "0", cy: "0", rx: "10" }))!;
    expect(e.start).toEqual({ x: 10, y: 0 }); // ry ausente = rx
  });

  it("polyline aberta e polygon fechado", () => {
    const [pl] = shapeToSubPaths(el("polyline", { points: "0,0 10,0 10,10" }))!;
    expect(pl.closed).toBe(false);
    expect(pl.segments).toHaveLength(2);
    const [pg] = shapeToSubPaths(el("polygon", { points: "0,0 10,0 10,10" }))!;
    expect(pg.closed).toBe(true);
    expect(pg.segments).toHaveLength(3);
    expect(pg.segments[2].to).toBe(pg.start);
  });

  it("line", () => {
    const [ln] = shapeToSubPaths(el("line", { x1: "1", y1: "2", x2: "3", y2: "4" }))!;
    expect(ln.start).toEqual({ x: 1, y: 2 });
    expect(ln.segments[0].to).toEqual({ x: 3, y: 4 });
  });

  it("path e desconhecidos não são formas básicas", () => {
    expect(shapeToSubPaths(el("path", { d: "M0 0" }))).toBeNull();
    expect(shapeToSubPaths(el("g"))).toBeNull();
  });
});
