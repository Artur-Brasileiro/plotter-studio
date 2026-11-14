import { describe, expect, it } from "vitest";
import { flattenGeometry } from "../geometry/flatten";
import { IDENTITY } from "../geometry/mat2d";
import { importSvgTree, SvgImportError } from "./importSvg";
import { el, type SvgNode } from "./node";

/** SVG em mm, 1 unidade = 1 mm */
const svg = (...children: SvgNode[]) => el("svg", { width: "100mm", height: "100mm", viewBox: "0 0 100 100" }, children);
const rect = (attrs: Record<string, string> = {}) => el("rect", { x: "1", y: "1", width: "1", height: "1", ...attrs });
const warning = (r: ReturnType<typeof importSvgTree>, code: string) => r.warnings.find((w) => w.code === code);

describe("importSvgTree", () => {
  it("transforms aninhados: translate(10,0) e scale(2)", () => {
    const r = importSvgTree(svg(el("g", { transform: "translate(10,0)" }, [el("g", { transform: "scale(2)" }, [rect()])])));
    const [pl] = flattenGeometry(r.geometry, IDENTITY, 0.05);
    expect(pl.points.slice(0, 4)).toEqual([
      { x: 12, y: 2 },
      { x: 14, y: 2 },
      { x: 14, y: 4 },
      { x: 12, y: 4 },
    ]);
    expect(r.pageMm).toEqual({ width: 100, height: 100 });
    expect(r.warnings).toEqual([]);
  });

  it("display:none num g oculta os filhos (camada oculta do Inkscape)", () => {
    expect(() => importSvgTree(svg(el("g", { style: "display:none" }, [rect()])))).toThrow(SvgImportError);
    const r = importSvgTree(svg(el("g", { display: "none" }, [rect()]), rect({ x: "50" })));
    expect(r.stats.subpaths).toBe(1);
  });

  it("<use> com href e com xlink:href, somando x/y", () => {
    const defs = el("defs", {}, [rect({ id: "a" })]);
    const r = importSvgTree(svg(defs, el("use", { href: "#a", x: "10" }), el("use", { "xlink:href": "#a", y: "20" })));
    expect(r.stats.subpaths).toBe(2);
    expect(r.geometry.subpaths[0].start).toEqual({ x: 11, y: 1 });
    expect(r.geometry.subpaths[1].start).toEqual({ x: 1, y: 21 });
  });

  it("<use> para id inexistente gera aviso", () => {
    const r = importSvgTree(svg(rect(), el("use", { href: "#nada" })));
    expect(warning(r, "use-missing-ref")?.count).toBe(1);
  });

  it("texto e imagem são ignorados com aviso e contagem", () => {
    const r = importSvgTree(svg(rect(), el("text", {}, []), el("text"), el("image")));
    expect(warning(r, "text-ignored")?.count).toBe(2);
    expect(warning(r, "image-ignored")?.count).toBe(1);
  });

  it("forma só com fill entra; fill e stroke = none é pulada; stroke herdado do g conta", () => {
    const r = importSvgTree(
      svg(
        rect({ fill: "red" }),
        rect({ fill: "none", stroke: "none" }),
        el("g", { stroke: "black" }, [rect({ fill: "none" })]),
        el("g", { style: "stroke:none" }, [rect({ style: "fill:none" })]),
      ),
    );
    expect(r.stats.elements).toBe(2);
    expect(warning(r, "invisible-ignored")?.count).toBe(2);
  });

  it("metadata e defs não desenham nada", () => {
    const r = importSvgTree(svg(el("metadata", {}, [rect()]), el("defs", {}, [rect()]), rect()));
    expect(r.stats.subpaths).toBe(1);
  });

  it("path com erro desenha até o erro e avisa", () => {
    const r = importSvgTree(svg(el("path", { d: "M0 0 L10 10 L foo" })));
    expect(r.stats.segments).toBe(1);
    expect(warning(r, "bad-path")).toBeDefined();
  });

  it("transform inválido é ignorado com aviso", () => {
    const r = importSvgTree(svg(rect({ transform: "girar(10)" })));
    expect(warning(r, "bad-transform")).toBeDefined();
    expect(r.geometry.subpaths[0].start).toEqual({ x: 1, y: 1 });
  });

  it("SVG sem traço → SvgImportError", () => {
    expect(() => importSvgTree(svg())).toThrow("Nenhum traço");
    expect(() => importSvgTree(el("html"))).toThrow(SvgImportError);
  });

  it("tamanho em px gera aviso size-in-px", () => {
    const r = importSvgTree(el("svg", { width: "100", height: "100" }, [rect()]));
    expect(warning(r, "size-in-px")).toBeDefined();
    expect(r.geometry.subpaths[0].start.x).toBeCloseTo(25.4 / 96, 9);
  });

  it("sem tamanho nem viewBox: página = caixa do conteúdo, com aviso", () => {
    const r = importSvgTree(el("svg", {}, [rect({ x: "96", y: "96", width: "96", height: "96" })]));
    expect(warning(r, "no-size")).toBeDefined();
    expect(r.geometry.subpaths[0].start).toEqual({ x: 0, y: 0 });
    expect(r.pageMm.width).toBeCloseTo(25.4, 9);
  });

  it("svg aninhado com x/y e viewBox", () => {
    const inner = el("svg", { x: "10", y: "10", width: "20", height: "20", viewBox: "0 0 10 10" }, [rect()]);
    const r = importSvgTree(svg(inner));
    expect(r.geometry.subpaths[0].start).toEqual({ x: 12, y: 12 });
  });
});
