import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { formatCoord, generateGcode, toAsciiComment } from "./gcode";
import type { JobPlan, PlannedStroke } from "./types";

const P = DEFAULT_PROFILE;
const meta = { fileName: "x.svg", date: new Date(2026, 10, 14, 12, 0), job: DEFAULT_JOB_SETTINGS };
const stroke = (pts: [number, number][], feeds: number[], joined = false): PlannedStroke => ({
  points: pts.map(([x, y]) => ({ x, y })),
  closed: false,
  drawingId: "d",
  joinedToPrevious: joined,
  feeds,
  classes: feeds.map(() => "straight" as const),
});
const plan = (strokes: PlannedStroke[]): JobPlan => ({
  strokes,
  start: { x: 0, y: 0 },
  end: { x: 0, y: 0 },
  violations: [],
  stats: { drawMm: 0, travelMm: 0, travelMmUnoptimized: 0, penLifts: 0, segments: 0, estimate: { totalS: 0, drawS: 0, travelS: 0, penS: 0 }, strokeStartTimesS: [] },
});
const body = (p: JobPlan) => generateGcode(p, P, meta).lines.map((l) => l.text).slice(7); // depois do cabeçalho

describe("formatCoord", () => {
  it.each([
    [-0.004, "0.00"],
    [-0.0049, "0.00"],
    [12.345, "12.35"],
    [0, "0.00"],
    [810, "810.00"],
  ])("%d → %s", (v, s) => expect(formatCoord(v)).toBe(s));
});

describe("toAsciiComment", () => {
  it("tira acentos, troca travessão e aspas curvas, o resto vira ?", () => {
    expect(toAsciiComment("Coração — “teste” ★")).toBe('Coracao - "teste" ?');
  });
  it("parênteses viram colchetes (desenho (1).svg)", () => {
    expect(toAsciiComment("desenho (1).svg")).toBe("desenho [1].svg");
  });
  it("corta em 60 caracteres e nunca tem quebra de linha", () => {
    const s = toAsciiComment("a\nb" + "x".repeat(100));
    expect(s.length).toBe(60);
    expect(s).not.toMatch(/\n/);
  });
});

describe("generateGcode", () => {
  it("cabeçalho do SPEC, em ASCII", () => {
    const lines = generateGcode(plan([]), P, { ...meta, fileName: "Coração.svg" }).lines.map((l) => l.text);
    expect(lines.slice(0, 7)).toEqual([
      "; Plotter Studio - Coracao.svg - 2026-11-14 12:00",
      "; modo: dinamico - reta F2000 / curva F1200 / fechada F600",
      "G21",
      "G90",
      "G17",
      "M5",
      "G4 P0.3",
    ]);
  });

  it("F só aparece quando muda, e o primeiro G1 tem F", () => {
    expect(body(plan([stroke([[1, 1], [2, 1], [3, 1], [4, 1]], [2000, 2000, 600])]))).toEqual([
      "G0 X1.00 Y1.00",
      "M3 S220",
      "G4 P0.3",
      "G1 X2.00 Y1.00 F2000",
      "G1 X3.00 Y1.00",
      "G1 X4.00 Y1.00 F600",
      "M5",
      "G4 P0.3",
      "G0 X0.00 Y0.00",
    ]);
  });

  it("traço unido ao anterior: G1 até o início, sem M5/M3 entre os dois", () => {
    const b = body(plan([stroke([[1, 1], [2, 1]], [1000]), stroke([[2.05, 1], [3, 1]], [1000], true)]));
    expect(b).toEqual(["G0 X1.00 Y1.00", "M3 S220", "G4 P0.3", "G1 X2.00 Y1.00 F1000", "G1 X2.05 Y1.00", "G1 X3.00 Y1.00", "M5", "G4 P0.3", "G0 X0.00 Y0.00"]);
  });

  it("o primeiro G0 sai sempre, mesmo se o traço começa exatamente na posição inicial do plano", () => {
    // a máquina pode estar em qualquer lugar ao rodar o arquivo (ex.: 810/385 depois do Home)
    const b = body(plan([stroke([[0, 0], [10, 0]], [1000])]));
    expect(b[0]).toBe("G0 X0.00 Y0.00");
    expect(b[1]).toBe("M3 S220");
  });

  it("ponto = desce e sobe a caneta no lugar", () => {
    expect(body(plan([stroke([[5, 5]], [])]))).toEqual(["G0 X5.00 Y5.00", "M3 S220", "G4 P0.3", "M5", "G4 P0.3", "G0 X0.00 Y0.00"]);
  });

  it("coordenada repetida depois de arredondar é omitida", () => {
    const b = body(plan([stroke([[1, 1], [1.001, 1.001], [2, 2]], [1000, 1000])]));
    expect(b.filter((l) => l.startsWith("G1"))).toEqual(["G1 X2.00 Y2.00 F1000"]);
  });

  it("coordenada um fio fora da área (dentro da folga) é presa à borda", () => {
    const b = body(plan([stroke([[809.999, 384.999], [810.004, 385.004]], [1000])]));
    expect(b).toContain("G0 X810.00 Y385.00");
    expect(b.some((l) => l.includes("810.01"))).toBe(false);
  });

  it("recusa plano com desenho fora da área", () => {
    const p = { ...plan([]), violations: [{ drawingId: "d", bbox: { minX: -1, minY: 0, maxX: 1, maxY: 1 }, message: "sai" }] };
    expect(() => generateGcode(p, P, meta)).toThrow("fora da área");
  });

  it("modo fixo no cabeçalho", () => {
    const lines = generateGcode(plan([]), P, { ...meta, job: { ...DEFAULT_JOB_SETTINGS, speedMode: "fixed", fixedFeed: 1500 } }).lines;
    expect(lines[1].text).toBe("; modo: fixo F1500");
  });

  it("strokeIndex e pointIndex para mapear linhas a traços (v2)", () => {
    const lines = generateGcode(plan([stroke([[1, 1], [2, 1]], [1000])]), P, meta).lines;
    const g1 = lines.find((l) => l.text.startsWith("G1 "))!;
    expect(g1.strokeIndex).toBe(0);
    expect(g1.pointIndex).toBe(1);
    expect(lines[0].strokeIndex).toBe(-1);
  });
});
