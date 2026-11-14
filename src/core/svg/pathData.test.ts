import { describe, expect, it } from "vitest";
import { flattenSubPath } from "../geometry/flatten";
import type { SubPath } from "../geometry/path";
import { arcToCubics } from "./arc";
import { parsePathData } from "./pathData";

const ok = (d: string) => {
  const r = parsePathData(d);
  expect(r.error).toBeUndefined();
  return r.subpaths;
};
const pts = (sp: SubPath) => flattenSubPath(sp, 0.01).points;

describe("parsePathData", () => {
  it("M e L absolutos", () => {
    const [sp] = ok("M10 20L30 40");
    expect(sp.start).toEqual({ x: 10, y: 20 });
    expect(sp.segments).toEqual([{ kind: "line", to: { x: 30, y: 40 } }]);
    expect(sp.closed).toBe(false);
  });

  it("pares extras depois do M viram L", () => {
    const [sp] = ok("M0 0 10 0 10 10");
    expect(sp.segments.map((s) => s.to)).toEqual([{ x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it("relativos, Z e novo subpath relativo ao início do anterior", () => {
    const sps = ok("m10 10 l5 0 l0 5 z m2 2 l1 0");
    expect(sps).toHaveLength(2);
    expect(sps[0].closed).toBe(true);
    expect(sps[0].segments.map((s) => s.to)).toEqual([{ x: 15, y: 10 }, { x: 15, y: 15 }, { x: 10, y: 10 }]);
    expect(sps[0].segments[2].to).toBe(sps[0].start);
    expect(sps[1].start).toEqual({ x: 12, y: 12 });
  });

  it("números colados: .5.5 e -1-1", () => {
    const [sp] = ok("M.5.5L-1-1");
    expect(sp.start).toEqual({ x: 0.5, y: 0.5 });
    expect(sp.segments[0].to).toEqual({ x: -1, y: -1 });
  });

  it("notação científica", () => {
    const [sp] = ok("M1e-3 0L1E2 0");
    expect(sp.start).toEqual({ x: 0.001, y: 0 });
    expect(sp.segments[0].to).toEqual({ x: 100, y: 0 });
  });

  it("flags de arco coladas: a10 10 0 1010 0 = large 1, sweep 0, até (10,0)", () => {
    const [sp] = ok("M0 0a10 10 0 1010 0");
    const p = pts(sp);
    expect(p[p.length - 1]).toEqual({ x: 10, y: 0 });
    // arco grande, sentido negativo: passa por (5, 18,66)
    expect(Math.max(...p.map((q) => q.y))).toBeCloseTo(18.66, 1);
  });

  it("H e V absolutos e relativos", () => {
    const [sp] = ok("M0 0 h10 v5 H0");
    expect(sp.segments.map((s) => s.to)).toEqual([{ x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]);
  });

  it("S depois de C reflete o controle", () => {
    const [sp] = ok("M0 0 C0 10 10 10 10 0 S20 -10 20 0");
    const s = sp.segments[1];
    expect(s.kind === "cubic" && s.c1).toEqual({ x: 10, y: -10 });
  });

  it("S depois de L usa o ponto atual como primeiro controle", () => {
    const [sp] = ok("M0 0 L10 0 S20 10 20 0");
    const s = sp.segments[1];
    expect(s.kind === "cubic" && s.c1).toEqual({ x: 10, y: 0 });
  });

  it("Q vira cúbica e T reflete o controle da quádrica", () => {
    const [sp] = ok("M0 0 Q5 10 10 0 T20 0");
    const t = sp.segments[1];
    if (t.kind !== "cubic") throw new Error("esperava cúbica");
    // controle refletido (15,−10): c1 = (10,0) + 2/3·(5,−10)
    expect(t.c1.x).toBeCloseTo(13.3333, 3);
    expect(t.c1.y).toBeCloseTo(-6.6667, 3);
  });

  it("comando de desenho depois de Z começa no início do subpath", () => {
    const sps = ok("M0 0 L10 0 L10 10 Z L5 5");
    expect(sps).toHaveLength(2);
    expect(sps[1].start).toEqual({ x: 0, y: 0 });
    expect(sps[1].segments[0].to).toEqual({ x: 5, y: 5 });
  });

  it("Z quando já está no início não acrescenta reta", () => {
    const [sp] = ok("M0 0 L10 0 L0 0 Z");
    expect(sp.segments).toHaveLength(2);
    expect(sp.closed).toBe(true);
    expect(sp.segments[1].to).toBe(sp.start);
  });

  it("M seguido de m: o subpath vazio é descartado (início da espiral de curvas.svg)", () => {
    const sps = ok("M250 55 m2 0 a2 2 0 0 1 -4 0");
    expect(sps).toHaveLength(1);
    expect(sps[0].start).toEqual({ x: 252, y: 55 });
  });

  it("erro: devolve o que leu até ali", () => {
    const r = parsePathData("M10 10 L20 20 L foo");
    expect(r.error).toBeDefined();
    expect(r.subpaths).toHaveLength(1);
    expect(r.subpaths[0].segments).toHaveLength(1);
  });

  it("erro: não começa com M", () => {
    expect(parsePathData("10 10").error).toBeDefined();
  });
});

describe("arcToCubics", () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 10, y: 0 };
  const yRange = (large: boolean, sweep: boolean, r = 10) => {
    const segs = arcToCubics(p0, r, r, 0, large, sweep, p1);
    const p = pts({ start: p0, segments: segs, closed: false });
    return { min: Math.min(...p.map((q) => q.y)), max: Math.max(...p.map((q) => q.y)), segs };
  };

  it("raio pequeno é corrigido: A1 1 de (0,0) a (10,0) vira semicírculo de raio 5, passando por (5,−5)", () => {
    const { min, segs } = yRange(false, true, 1);
    expect(min).toBeCloseTo(-5, 2);
    expect(segs).toHaveLength(4); // 180° = 4 cúbicas de 45°
    expect(segs[3].to).toBe(p1);
  });

  it("as 4 combinações de large/sweep (raio 10)", () => {
    expect(yRange(false, true).min).toBeCloseTo(-1.34, 1);
    expect(yRange(false, false).max).toBeCloseTo(1.34, 1);
    expect(yRange(true, true).min).toBeCloseTo(-18.66, 1);
    expect(yRange(true, false).max).toBeCloseTo(18.66, 1);
  });

  it("raio zero vira reta; pontas iguais não desenham nada", () => {
    expect(arcToCubics(p0, 0, 5, 0, false, true, p1)).toEqual([{ kind: "line", to: p1 }]);
    expect(arcToCubics(p0, 5, 5, 0, false, true, p0)).toEqual([]);
  });

  it("arco rotacionado de elipse termina exatamente no ponto final", () => {
    const end = { x: 7, y: 3 };
    const segs = arcToCubics(p0, 8, 3, 30, true, false, end);
    expect(segs[segs.length - 1].to).toBe(end);
  });
});
