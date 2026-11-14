// @vitest-environment jsdom
// Testes golden: os SVGs de samples/ importados de verdade (DOMParser do jsdom).
import { describe, expect, it } from "vitest";
import curvas from "../../samples/curvas.svg?raw";
import orientacao from "../../samples/orientacao.svg?raw";
import quadradoCirculo from "../../samples/teste_quadrado_circulo.svg?raw";
import { importSvgTree, SvgImportError } from "../core/svg/importSvg";
import { parseSvgText } from "./svgDom";

const load = (text: string) => importSvgTree(parseSvgText(text));

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
