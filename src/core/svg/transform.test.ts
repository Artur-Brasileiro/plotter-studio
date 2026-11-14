import { describe, expect, it } from "vitest";
import { apply, IDENTITY } from "../geometry/mat2d";
import { parseTransformList } from "./transform";

const at = (s: string, x: number, y: number) => {
  const r = parseTransformList(s);
  expect(r.ok).toBe(true);
  return apply(r.m, { x, y });
};

describe("parseTransformList", () => {
  it("translate com um argumento → ty = 0", () => {
    expect(at("translate(10)", 1, 1)).toEqual({ x: 11, y: 1 });
  });

  it("rotate(90 10 10) leva (20,10) a (10,20)", () => {
    const p = at("rotate(90 10 10)", 20, 10);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(20, 9);
  });

  it("scale(2 3)", () => {
    expect(at("scale(2 3)", 1, 1)).toEqual({ x: 2, y: 3 });
  });

  it("skewX(45) leva (1,1) a (2,1)", () => {
    const p = at("skewX(45)", 1, 1);
    expect(p.x).toBeCloseTo(2, 9);
    expect(p.y).toBeCloseTo(1, 9);
  });

  it("lista: translate(10,0) scale(2) leva (1,1) a (12,2)", () => {
    expect(at("translate(10,0) scale(2)", 1, 1)).toEqual({ x: 12, y: 2 });
  });

  it("matrix e separadores variados", () => {
    expect(at("matrix(1,0,0,1,5,5)", 0, 0)).toEqual({ x: 5, y: 5 });
    expect(at("  translate( 1 , 2 ),scale(2)  ", 1, 1)).toEqual({ x: 3, y: 4 });
  });

  it("vazio = identidade válida", () => {
    expect(parseTransformList("")).toEqual({ m: IDENTITY, ok: true });
  });

  it.each(["foo(1)", "translate(1,2,3)", "rotate(1 2)", "scale()", "translate(1) lixo"])("%s → ok = false", (s) => {
    expect(parseTransformList(s)).toEqual({ m: IDENTITY, ok: false });
  });
});
