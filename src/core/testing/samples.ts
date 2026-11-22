// Auxiliar de testes: os SVGs de samples/ montados como SvgNode (sem DOM), para os
// testes do núcleo rodarem em Node puro. Os testes golden usam os arquivos de verdade.
import { addDrawing, createDrawing, EMPTY_DOCUMENT, importPlacement, type PlotDocument } from "../document";
import { importSvgTree } from "../svg/importSvg";
import { el, type SvgNode } from "../svg/node";

const S = { fill: "none", stroke: "black", "stroke-width": "0.5" };

export const quadradoCirculoSvg: SvgNode = el("svg", { width: "120mm", height: "120mm", viewBox: "0 0 120 120" }, [
  el("rect", { x: "10", y: "10", width: "100", height: "100", ...S }),
  el("circle", { cx: "60", cy: "60", r: "30", ...S }),
]);

export const orientacaoSvg: SvgNode = el("svg", { width: "100mm", height: "80mm", viewBox: "0 0 100 80" }, [
  el("g", S, [
    el("path", { d: "M10 70 L10 10 L40 10 M10 38 L32 38" }),
    el("path", { d: "M55 70 L90 25 M90 25 L72 27 M90 25 L87 43" }),
    el("rect", { x: "2", y: "2", width: "96", height: "76" }),
  ]),
]);

export const curvasSvg: SvgNode = el("svg", { width: "300mm", height: "120mm", viewBox: "0 0 300 120" }, [
  el("g", S, [
    el("path", { d: "M10 110 L290 110" }),
    el("path", { d: "M10 10 L60 10 L60 60 L10 60 Z" }),
    el("path", { d: "M90 100 A50 50 0 0 1 190 100" }),
    el("circle", { cx: "110", cy: "25", r: "20" }),
    el("circle", { cx: "160", cy: "35", r: "5" }),
    el("path", {
      d: "M250 55 m2 0 a2 2 0 0 1 -4 0 a4 4 0 0 1 8 0 a6 6 0 0 1 -12 0 a10 10 0 0 1 20 0 a14 14 0 0 1 -28 0 a20 20 0 0 1 40 0 a26 26 0 0 1 -52 0 a32 32 0 0 1 64 0 a40 40 0 0 1 -80 0",
    }),
  ]),
]);

/** Canto da zona de desenho do perfil padrão: onde o aplicativo coloca um desenho importado. */
export const ZONE_CORNER = { x: 30, y: 25 } as const;

/**
 * Documento com o SVG importado como o aplicativo faz: canto inferior esquerdo da página no canto
 * da zona de desenho (30, 25). Com `corner = {x: 0, y: 0}` fica na origem da máquina, que está FORA
 * da zona: o plano sai com violação e o G-code é recusado.
 */
export function docFrom(svg: SvgNode, name = "sample.svg", workHeight = 385, corner: { x: number; y: number } = ZONE_CORNER): PlotDocument {
  const r = importSvgTree(svg);
  return addDrawing(EMPTY_DOCUMENT, createDrawing("d1", name, r.geometry, importPlacement(r.pageMm, workHeight, corner)));
}
