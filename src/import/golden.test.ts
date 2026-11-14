// @vitest-environment jsdom
// Testes golden: os SVGs de samples/ importados de verdade (DOMParser do jsdom).
import { describe, expect, it } from "vitest";
import curvas from "../../samples/curvas.svg?raw";
import orientacao from "../../samples/orientacao.svg?raw";
import quadradoCirculo from "../../samples/teste_quadrado_circulo.svg?raw";
import { addDrawing, createDrawing, EMPTY_DOCUMENT, importPlacement } from "../core/document";
import { generateGcode } from "../core/job/gcode";
import { planJob } from "../core/job/pipeline";
import { DEFAULT_PROFILE } from "../core/machine";
import { DEFAULT_JOB_SETTINGS, type JobSettings } from "../core/store";
import { importSvgTree, SvgImportError } from "../core/svg/importSvg";
import { parseSvgText } from "./svgDom";

const load = (text: string) => importSvgTree(parseSvgText(text));

const P = DEFAULT_PROFILE;
const DATE = new Date(2026, 10, 14, 12, 0); // data fixa: o cabeçalho não muda a cada execução

/** Sample importado na origem → plano → G-code. */
function golden(text: string, fileName: string, job: JobSettings) {
  const r = load(text);
  const doc = addDrawing(EMPTY_DOCUMENT, createDrawing("d1", fileName, r.geometry, importPlacement(r.pageMm, P.workArea.height)));
  const plan = planJob(doc, P, job);
  const program = generateGcode(plan, P, { fileName, date: DATE, job });
  return { plan, text: program.toText(), lines: program.lines.map((l) => l.text) };
}

/** Regras que valem para TODO G-code gerado. */
function checkRules(text: string, lines: string[]) {
  for (let i = 0; i < text.length; i++) expect(text.charCodeAt(i), `byte ${i}`).toBeLessThan(0x80);
  for (const l of lines) {
    expect(l.length, l).toBeLessThanOrEqual(70);
    expect(l).not.toContain("(");
    expect(l).not.toContain("$");
  }
  const firstG1 = lines.find((l) => l.startsWith("G1 "));
  if (firstG1) expect(firstG1).toMatch(/ F\d+$/);
  for (const l of lines) {
    const m = /^G[01] X(-?[\d.]+) Y(-?[\d.]+)/.exec(l);
    if (!m) continue;
    const x = Number(m[1]), y = Number(m[2]);
    expect(x >= 0 && x <= P.workArea.width && y >= 0 && y <= P.workArea.height, l).toBe(true);
  }
  let down = false;
  for (const l of lines) {
    if (l === P.pen.downCmd) {
      expect(down, "M3 com a caneta já abaixada").toBe(false);
      down = true;
    } else if (l === P.pen.upCmd) down = false;
    else if (l.startsWith("G0")) expect(down, `G0 com a caneta abaixada: ${l}`).toBe(false);
  }
  expect(lines.slice(-3)).toEqual(["M5", "G4 P0.3", "G0 X0.00 Y0.00"]);
}

const DYN: JobSettings = { ...DEFAULT_JOB_SETTINGS, speedMode: "dynamic", optimize: false };

describe("importação dos samples", () => {
  it("teste_quadrado_circulo: página 120 × 120 mm, 2 subpaths, sem avisos", () => {
    const r = load(quadradoCirculo);
    expect(r.pageMm).toEqual({ width: 120, height: 120 });
    expect(r.stats.subpaths).toBe(2);
    expect(r.warnings).toEqual([]);
    expect(r.geometry.subpaths[0].start).toEqual({ x: 10, y: 10 });
    expect(r.geometry.subpaths[1].start).toEqual({ x: 90, y: 60 });
  });

  it("orientacao: página 100 × 80 mm, 6 subpaths (F = 2, seta = 3, retângulo = 1), sem avisos", () => {
    const r = load(orientacao);
    expect(r.pageMm).toEqual({ width: 100, height: 80 });
    expect(r.stats.subpaths).toBe(6);
    expect(r.warnings).toEqual([]);
  });

  it("curvas: página 300 × 120 mm, 6 subpaths, sem avisos", () => {
    const r = load(curvas);
    expect(r.pageMm).toEqual({ width: 300, height: 120 });
    expect(r.stats.subpaths).toBe(6);
    expect(r.warnings).toEqual([]);
  });
});

describe("G-code golden", () => {
  it("teste_quadrado_circulo, dinâmico, sem otimização: começo exato, círculo com 56 G1 a 30 mm do centro", async () => {
    const { text, lines } = golden(quadradoCirculo, "teste_quadrado_circulo.svg", DYN);
    checkRules(text, lines);
    expect(lines.slice(0, 19)).toEqual([
      "; Plotter Studio - teste_quadrado_circulo.svg - 2026-11-14 12:00",
      "; modo: dinamico - reta F2000 / curva F1200 / fechada F600",
      "G21",
      "G90",
      "G17",
      "M5",
      "G4 P0.3",
      "G0 X10.00 Y110.00",
      "M3 S220",
      "G4 P0.3",
      "G1 X110.00 Y110.00 F2000",
      "G1 X110.00 Y10.00",
      "G1 X10.00 Y10.00",
      "G1 X10.00 Y110.00",
      "M5",
      "G4 P0.3",
      "G0 X90.00 Y60.00",
      "M3 S220",
      "G4 P0.3",
    ]);
    const circle = lines.slice(19, lines.indexOf("M5", 19));
    expect(circle).toHaveLength(56);
    expect(circle[0]).toMatch(/ F600$/);
    expect(Number(/Y([\d.]+)/.exec(circle[0])![1])).toBeLessThan(60); // desce, como no SVG
    for (const l of circle) {
      const [, x, y] = /X([\d.]+) Y([\d.]+)/.exec(l)!;
      expect(Math.abs(Math.hypot(Number(x) - 60, Number(y) - 60) - 30)).toBeLessThan(0.012);
    }
    await expect(text).toMatchFileSnapshot("../../samples/golden/teste_quadrado_circulo.dinamico.gcode");
  });

  it("teste_quadrado_circulo otimizado: começa em (10,10), círculo entra em (38,79; 38,79), viagem 312,96 → 109,71 mm", async () => {
    const { text, lines, plan } = golden(quadradoCirculo, "teste_quadrado_circulo.svg", { ...DYN, optimize: true });
    checkRules(text, lines);
    const g0 = lines.filter((l) => l.startsWith("G0"));
    expect(g0.slice(0, 2)).toEqual(["G0 X10.00 Y10.00", "G0 X38.79 Y38.79"]);
    expect(plan.stats.travelMmUnoptimized).toBeCloseTo(312.96, 1);
    expect(plan.stats.travelMm).toBeCloseTo(109.71, 1);
    await expect(text).toMatchFileSnapshot("../../samples/golden/teste_quadrado_circulo.otimizado.gcode");
  });

  it("orientacao, fixo F1000: o F legível e a seta para cima/direita, em coordenadas da máquina", async () => {
    const job: JobSettings = { ...DEFAULT_JOB_SETTINGS, speedMode: "fixed", fixedFeed: 1000, optimize: false };
    const { text, lines } = golden(orientacao, "orientacao.svg", job);
    checkRules(text, lines);
    const coords = lines.filter((l) => /^G[01] /.test(l)).map((l) => l.replace(/ F\d+$/, ""));
    const seq = (...xs: string[]) => {
      const i = coords.indexOf(xs[0]);
      expect(i, xs[0]).toBeGreaterThanOrEqual(0);
      expect(coords.slice(i, i + xs.length)).toEqual(xs);
    };
    seq("G0 X10.00 Y10.00", "G1 X10.00 Y70.00", "G1 X40.00 Y70.00"); // haste sobe, barra de cima para +X
    seq("G0 X10.00 Y42.00", "G1 X32.00 Y42.00"); // barra do meio, abaixo da de cima
    seq("G0 X55.00 Y10.00", "G1 X90.00 Y55.00", "G1 X72.00 Y53.00"); // seta para cima/direita (ponta unida)
    seq("G0 X90.00 Y55.00", "G1 X87.00 Y37.00");
    expect(lines[1]).toBe("; modo: fixo F1000");
    await expect(text).toMatchFileSnapshot("../../samples/golden/orientacao.fixo.gcode");
  });

  it("curvas, dinâmico: reta e quadrado F2000, arco R50 F1200, círculos R20 e R5 F600", async () => {
    const { text, lines, plan } = golden(curvas, "curvas.svg", DYN);
    checkRules(text, lines);
    const feedsOf = (pred: (pts: { x: number; y: number }[]) => boolean) => {
      const s = plan.strokes.find((st) => pred(st.points as { x: number; y: number }[]));
      expect(s).toBeDefined();
      return [...new Set(s!.feeds)];
    };
    const onCircle = (cx: number, cy: number, r: number) => (pts: { x: number; y: number }[]) =>
      pts.every((p) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) < 0.1);
    expect(feedsOf((pts) => pts.length === 2 && pts[0].y === 10 && pts[1].y === 10)).toEqual([2000]);
    expect(feedsOf((pts) => pts.every((p) => p.x >= 10 && p.x <= 60 && p.y >= 60 && p.y <= 110) && pts.length === 5)).toEqual([2000]);
    expect(feedsOf(onCircle(140, 20, 50))).toEqual([1200]);
    expect(feedsOf(onCircle(110, 95, 20))).toEqual([600]);
    expect(feedsOf(onCircle(160, 85, 5))).toEqual([600]);
    await expect(text).toMatchFileSnapshot("../../samples/golden/curvas.dinamico.gcode");
  });
});

describe("parseSvgText", () => {
  it("XML mal formado → SvgImportError", () => {
    expect(() => parseSvgText("<svg><g></svg>")).toThrow(SvgImportError);
  });

  it("documento que não é SVG → SvgImportError", () => {
    expect(() => parseSvgText("<html xmlns='http://www.w3.org/1999/xhtml'/>")).toThrow(SvgImportError);
  });

  it("descarta elementos de outros namespaces (sodipodi/inkscape)", () => {
    const root = parseSvgText(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"><sodipodi:namedview/><rect width="1" height="1"/></svg>`,
    );
    expect(root.children.map((c) => c.tag)).toEqual(["rect"]);
  });
});
