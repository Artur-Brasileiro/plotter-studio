import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../machine";
import { estimateTime, junctionSpeed, trapezoid } from "./estimate";
import type { PlannedStroke } from "./types";

const P = DEFAULT_PROFILE;
const O = { x: 0, y: 0 };
const planned = (pts: [number, number][], feed: number, joined = false): PlannedStroke => ({
  points: pts.map(([x, y]) => ({ x, y })),
  closed: false,
  drawingId: "d",
  joinedToPrevious: joined,
  feeds: pts.slice(1).map(() => feed),
  classes: pts.slice(1).map(() => "straight" as const),
});

describe("trapezoid", () => {
  it("100 mm a F600 (10 mm/s, 800 mm/s²) = 10,0125 s", () => {
    expect(trapezoid(100, 0, 0, 10, 800)).toBeCloseTo(10.0125, 9);
  });
  it("1 mm a F6000 não chega na velocidade: triângulo de 0,0707 s", () => {
    expect(trapezoid(1, 0, 0, 100, 800)).toBeCloseTo(2 * Math.sqrt(1 / 800), 9);
  });
});

describe("junctionSpeed (como o GRBL 1.1: aceleração limitada por eixo na direção da junção)", () => {
  it("canto de 90°: 5,23 mm/s (≈ F314)", () => {
    // junção na diagonal: aceleração efetiva 800/cos45° = 1131 mm/s²
    expect(junctionSpeed({ x: 1, y: 0 }, { x: 0, y: 1 }, P)).toBeCloseTo(5.23, 2);
  });
  it("canto de 45°: 10,25 mm/s (≈ F615, praticamente o tightCurve)", () => {
    const s = Math.SQRT1_2;
    expect(junctionSpeed({ x: 1, y: 0 }, { x: s, y: s }, P)).toBeCloseTo(10.25, 2);
  });
  it("reta: sem limite; meia-volta: zero", () => {
    expect(junctionSpeed({ x: 1, y: 0 }, { x: 1, y: 0 }, P)).toBe(Infinity);
    expect(junctionSpeed({ x: 1, y: 0 }, { x: -1, y: 0 }, P)).toBe(0);
  });
});

describe("estimateTime", () => {
  const settle = P.pen.settleSeconds;

  it("um traço de 100 mm a F600 começando no lugar: 10,0125 s + 3 pausas do servo (M5 inicial, M3, M5)", () => {
    const r = estimateTime([planned([[0, 0], [100, 0]], 600)], O, { x: 100, y: 0 }, P);
    expect(r.estimate.drawS).toBeCloseTo(10.0125, 6);
    expect(r.estimate.penS).toBeCloseTo(3 * settle, 9);
    expect(r.estimate.travelS).toBe(0);
    expect(r.estimate.totalS).toBeCloseTo(10.0125 + 0.9, 6);
    expect(r.strokeStartTimesS).toEqual([2 * settle]);
  });

  it("50 + 50 mm colineares no mesmo F levam o mesmo tempo que 100 mm", () => {
    const a = estimateTime([planned([[0, 0], [50, 0], [100, 0]], 600)], O, { x: 100, y: 0 }, P);
    expect(a.estimate.drawS).toBeCloseTo(10.0125, 6);
  });

  it("G0 de 100 mm a 200 mm/s: 25 mm acelerando, 50 mm em cruzeiro, 25 mm freando = 0,75 s", () => {
    const r = estimateTime([], O, { x: 100, y: 0 }, P);
    expect(r.estimate.travelS).toBeCloseTo(0.75, 9);
  });

  it("traço unido ao anterior: sem pausas do servo extras, e a junção reta não freia", () => {
    const sep = estimateTime([planned([[0, 0], [50, 0]], 600), planned([[50, 0], [100, 0]], 600, true)], O, { x: 100, y: 0 }, P);
    expect(sep.estimate.penS).toBeCloseTo(3 * settle, 9);
    expect(sep.estimate.drawS).toBeCloseTo(10.0125, 6);
    // o 1º bloco só acelera (0,0125 s em 0,0625 mm) e segue em cruzeiro: 5,00625 s
    expect(sep.strokeStartTimesS[1]).toBeCloseTo(2 * settle + 0.0125 + (50 - 0.0625) / 10, 9);
  });

  it("dois traços separados: levanta e abaixa a caneta entre eles (mais 2 pausas) e viaja", () => {
    const r = estimateTime([planned([[0, 0], [10, 0]], 600), planned([[20, 0], [30, 0]], 600)], O, { x: 30, y: 0 }, P);
    expect(r.estimate.penS).toBeCloseTo(5 * settle, 9);
    expect(r.estimate.travelS).toBeGreaterThan(0);
  });
});
