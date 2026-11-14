import { describe, expect, it } from "vitest";
import { apply } from "../geometry/mat2d";
import { el } from "./node";
import { parseLengthMm, parseViewBox, rootMapping, viewBoxToMm } from "./units";

describe("parseLengthMm", () => {
  it.each([
    ["100mm", 100],
    ["10cm", 100],
    ["1in", 25.4],
    ["96px", 25.4],
    ["96", 25.4],
    ["72pt", 25.4],
    ["6pc", 25.4],
    [" 2.5e1mm ", 25],
  ])("%s → %d mm", (s, mm) => {
    expect(parseLengthMm(s)).toBeCloseTo(mm, 9);
  });

  it.each(["100%", "2em", "abc", ""])("%s → undefined", (s) => {
    expect(parseLengthMm(s)).toBeUndefined();
  });
});

describe("viewBox", () => {
  it("parseViewBox aceita vírgulas e rejeita tamanho zero", () => {
    expect(parseViewBox("0,0,100,50")).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(parseViewBox("0 0 0 50")).toBeUndefined();
  });

  it("viewBox 0 0 200 100 numa página de 100 × 50 mm → escala 0,5", () => {
    const m = viewBoxToMm({ x: 0, y: 0, width: 200, height: 100 }, 100, 50);
    expect(apply(m, { x: 200, y: 100 })).toEqual({ x: 100, y: 50 });
  });

  it("viewBox 0 0 100 50 numa página de 100 × 100 mm (meet) → escala 1, deslocado 25 em y", () => {
    const m = viewBoxToMm({ x: 0, y: 0, width: 100, height: 50 }, 100, 100);
    expect(apply(m, { x: 0, y: 0 })).toEqual({ x: 0, y: 25 });
    expect(apply(m, { x: 100, y: 50 })).toEqual({ x: 100, y: 75 });
  });

  it("preserveAspectRatio none estica", () => {
    const m = viewBoxToMm({ x: 0, y: 0, width: 100, height: 50 }, 100, 100, "none");
    expect(apply(m, { x: 100, y: 50 })).toEqual({ x: 100, y: 100 });
  });

  it("viewBox com origem deslocada", () => {
    const m = viewBoxToMm({ x: 10, y: 20, width: 100, height: 100 }, 100, 100);
    expect(apply(m, { x: 10, y: 20 })).toEqual({ x: 0, y: 0 });
  });
});

describe("rootMapping", () => {
  it("Inkscape moderno: 210 × 297 mm com viewBox em mm → 1:1", () => {
    const r = rootMapping(el("svg", { width: "210mm", height: "297mm", viewBox: "0 0 210 297" }));
    expect(r.pageMm).toEqual({ width: 210, height: 297 });
    expect(r.sizeSource).toBe("units");
    expect(apply(r.userToMm, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it("Inkscape 0.92: viewBox em px com tamanho em mm → escala 0,28222", () => {
    const r = rootMapping(el("svg", { width: "210mm", height: "297mm", viewBox: "0 0 744.09 1052.36" }));
    expect(r.userToMm[0]).toBeCloseTo(0.28222, 5);
  });

  it("tamanho em px → sizeSource px", () => {
    const r = rootMapping(el("svg", { width: "96px", height: "96px", viewBox: "0 0 24 24" }));
    expect(r.sizeSource).toBe("px");
    expect(r.pageMm.width).toBeCloseTo(25.4, 9);
  });

  it("só viewBox → unidades em px a 96 dpi", () => {
    const r = rootMapping(el("svg", { viewBox: "0 0 24 24" }));
    expect(r.sizeSource).toBe("viewBoxOnly");
    expect(r.pageMm.width).toBeCloseTo(6.35, 9);
  });

  it("sem nada → none", () => {
    expect(rootMapping(el("svg")).sizeSource).toBe("none");
  });
});
