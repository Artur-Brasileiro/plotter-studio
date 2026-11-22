// @vitest-environment jsdom
// Testes golden: os SVGs de samples/ importados de verdade (DOMParser do jsdom).
import { describe, expect, it } from "vitest";
import curvas from "../../samples/curvas.svg?raw";
import orientacao from "../../samples/orientacao.svg?raw";
import quadradoCirculo from "../../samples/teste_quadrado_circulo.svg?raw";
import { addDrawing, createDrawing, EMPTY_DOCUMENT, importPlacement } from "../core/document";
import { auditGcode } from "../core/job/audit";
import { generateGcode, MAX_LINE_LENGTH } from "../core/job/gcode";
import { planJob } from "../core/job/pipeline";
import { DEFAULT_PROFILE } from "../core/machine";
import { DEFAULT_JOB_SETTINGS, type JobSettings } from "../core/store";
import { importSvgTree, SvgImportError } from "../core/svg/importSvg";
import { parseSvgText } from "./svgDom";

const load = (text: string) => importSvgTree(parseSvgText(text));

const P = DEFAULT_PROFILE;
const DATE = new Date(2026, 10, 14, 12, 0); // data fixa: o cabeçalho não muda a cada execução

/** Sample importado como o aplicativo faz (página no canto da zona de desenho: +30, +25) → plano → G-code. */
function golden(text: string, fileName: string, job: JobSettings) {
  const r = load(text);
  const corner = { x: P.drawZone.minX, y: P.drawZone.minY };
  const doc = addDrawing(EMPTY_DOCUMENT, createDrawing("d1", fileName, r.geometry, importPlacement(r.pageMm, P.workArea.height, corner)));
  const plan = planJob(doc, P, job);
  const program = generateGcode(plan, P, { fileName, date: DATE, job });
  return { plan, text: program.toText(), lines: program.lines.map((l) => l.text) };
}

/** Regras que valem para TODO G-code gerado (docs/REGRAS_GCODE.md). */
function checkRules(text: string, lines: string[]) {
  for (let i = 0; i < text.length; i++) expect(text.charCodeAt(i), `byte ${i}`).toBeLessThan(0x80);
  for (const l of lines) {
    expect(l.length, l).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    expect(l).not.toContain("(");
    expect(l).not.toContain("$");
  }
  // todo movimento é "G0 X.. Y.." ou uma linha que começa com X (G1 modal), dentro do curso
  for (const l of lines) {
    const m = /^(?:G0 )?X(-?[\d.]+) Y(-?[\d.]+)/.exec(l);
    if (!m) {
      expect(l, "movimento fora do formato").not.toMatch(/^G1 X|^G0(?! X)|^Y/);
      continue;
    }
    const x = Number(m[1]), y = Number(m[2]);
    expect(x >= 0 && x <= P.workArea.width && y >= 0 && y <= P.workArea.height, l).toBe(true);
  }
  // a auditoria, que lê o texto como a máquina leria, não acha erro nenhum
  const a = auditGcode(text, { ...P, servo: { ...P.servo, onOverload: "warn" } });
  expect(a.problems.filter((p) => p.level === "error")).toEqual([]);
  expect(a.warmupCycles).toBe(P.shield.warmupCycles);
  expect(lines.slice(-6)).toEqual(["M5", "G4 P0.3", "M5", "G4 P0.3", "G0 X0.00 Y0.00", "M2"]);
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

// ATENÇÃO: estes goldens mudaram em 22/11/2026 para o formato de docs/REGRAS_GCODE.md (aquecimento,
// G1 modal, subida dupla, M2) e para a posição dentro da zona de desenho. Ainda NÃO rodaram na máquina.
describe("G-code golden", () => {
  it("teste_quadrado_circulo, dinâmico, sem otimização: quadrado exato, círculo com 56 pontos a 30 mm do centro", async () => {
    const { text, lines } = golden(quadradoCirculo, "teste_quadrado_circulo.svg", DYN);
    checkRules(text, lines);
    expect(lines.slice(0, 7)).toEqual([
      "; Plotter Studio - teste_quadrado_circulo.svg - 2026-11-14 12:00",
      "; modo: dinamico - reta F2000 / curva F1200 / fechada F600",
      "; caneta Preta 0,4 - 0.4 mm",
      "G21",
      "G90",
      "M5",
      "G4 P0.3",
    ]);
    const i = lines.indexOf("G0 X40.00 Y135.00");
    expect(lines.slice(i, i + 16)).toEqual([
      "G0 X40.00 Y135.00",
      "M3 S220",
      "G4 P0.6",
      "G1 F2000",
      "X140.00 Y135.00",
      "X140.00 Y35.00",
      "X40.00 Y35.00",
      "X40.00 Y135.00",
      "M5",
      "G4 P0.2",
      "M5",
      "G4 P0.2",
      "G0 X120.00 Y85.00",
      "M3 S220",
      "G4 P0.3",
      "G1 F600",
    ]);
    const circle = lines.slice(i + 16, lines.indexOf("M5", i + 16));
    expect(circle).toHaveLength(56);
    expect(Number(/Y([\d.]+)/.exec(circle[0])![1])).toBeLessThan(85); // desce, como no SVG
    for (const l of circle) {
      const [, x, y] = /^X([\d.]+) Y([\d.]+)/.exec(l)!;
      expect(Math.abs(Math.hypot(Number(x) - 90, Number(y) - 85) - 30)).toBeLessThan(0.012);
    }
    await expect(text).toMatchFileSnapshot("../../samples/golden/teste_quadrado_circulo.dinamico.gcode");
  });

  it("teste_quadrado_circulo otimizado: começa em (40,35), o círculo entra pelo ponto mais próximo, viagem menor", async () => {
    const { text, lines, plan } = golden(quadradoCirculo, "teste_quadrado_circulo.svg", { ...DYN, optimize: true });
    checkRules(text, lines);
    const g0 = lines.filter((l) => l.startsWith("G0"));
    // o 1º G0 é o do aquecimento, no ponto seguro
    expect(g0.slice(0, 3)).toEqual(["G0 X0.00 Y0.00", "G0 X40.00 Y35.00", "G0 X68.79 Y63.79"]);
    expect(plan.stats.travelMm).toBeLessThan(plan.stats.travelMmUnoptimized - 150);
    await expect(text).toMatchFileSnapshot("../../samples/golden/teste_quadrado_circulo.otimizado.gcode");
  });

  it("orientacao, fixo F1000: o F legível e a seta para cima/direita, em coordenadas da máquina", async () => {
    const job: JobSettings = { ...DEFAULT_JOB_SETTINGS, speedMode: "fixed", fixedFeed: 1000, optimize: false };
    const { text, lines } = golden(orientacao, "orientacao.svg", job);
    checkRules(text, lines);
    const coords = lines.filter((l) => /^(G0 )?X/.test(l));
    const seq = (...xs: string[]) => {
      const i = coords.indexOf(xs[0]);
      expect(i, xs[0]).toBeGreaterThanOrEqual(0);
      expect(coords.slice(i, i + xs.length)).toEqual(xs);
    };
    seq("G0 X40.00 Y35.00", "X40.00 Y95.00", "X70.00 Y95.00"); // haste sobe, barra de cima para +X
    seq("G0 X40.00 Y67.00", "X62.00 Y67.00"); // barra do meio, abaixo da de cima
    seq("G0 X85.00 Y35.00", "X120.00 Y80.00", "X102.00 Y78.00"); // seta para cima/direita (ponta unida)
    seq("G0 X120.00 Y80.00", "X117.00 Y62.00");
    expect(lines[1]).toBe("; modo: fixo F1000");
    expect(lines.filter((l) => l.startsWith("G1 "))).toEqual(expect.arrayContaining(["G1 F1000"]));
    expect(new Set(lines.filter((l) => l.startsWith("G1 ")))).toEqual(new Set(["G1 F1000"]));
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
    expect(feedsOf((pts) => pts.length === 2 && pts[0].y === 35 && pts[1].y === 35)).toEqual([2000]);
    expect(feedsOf((pts) => pts.every((p) => p.x >= 40 && p.x <= 90 && p.y >= 85 && p.y <= 135) && pts.length === 5)).toEqual([2000]);
    expect(feedsOf(onCircle(170, 45, 50))).toEqual([1200]);
    expect(feedsOf(onCircle(140, 120, 20))).toEqual([600]);
    expect(feedsOf(onCircle(190, 110, 5))).toEqual([600]);
    await expect(text).toMatchFileSnapshot("../../samples/golden/curvas.dinamico.gcode");
  });

  it("na origem da máquina (fora da zona de desenho) o G-code é recusado", () => {
    const r = load(orientacao);
    const doc = addDrawing(EMPTY_DOCUMENT, createDrawing("d1", "o.svg", r.geometry, importPlacement(r.pageMm, P.workArea.height)));
    const plan = planJob(doc, P, DYN);
    expect(plan.violations.map((v) => v.kind)).toEqual(["zone"]);
    expect(() => generateGcode(plan, P, { fileName: "o.svg", date: DATE, job: DYN })).toThrow("fora da área");
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
