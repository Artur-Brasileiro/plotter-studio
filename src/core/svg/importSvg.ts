import { IDENTITY, multiply, translation, type Mat2D } from "../geometry/mat2d";
import { controlBBox, segmentCount, transformGeometry, type Geometry, type SubPath } from "../geometry/path";
import type { SvgNode } from "./node";
import { parsePathData } from "./pathData";
import { shapeToSubPaths, userLength } from "./shapes";
import { parseTransformList } from "./transform";
import { parseViewBox, rootMapping, viewBoxToMm } from "./units";

export type ImportWarningCode =
  | "text-ignored"
  | "image-ignored"
  | "invisible-ignored"
  | "use-missing-ref"
  | "bad-transform"
  | "bad-path"
  | "size-in-px"
  | "no-size";

export interface ImportWarning {
  readonly code: ImportWarningCode;
  readonly count: number;
  readonly message: string;
}

export interface ImportResult {
  /** mm, Y para baixo, origem no canto superior esquerdo da página */
  readonly geometry: Geometry;
  readonly pageMm: { readonly width: number; readonly height: number };
  readonly warnings: readonly ImportWarning[];
  readonly stats: { readonly elements: number; readonly subpaths: number; readonly segments: number };
}

export class SvgImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgImportError";
  }
}

const IGNORED = new Set([
  "defs", "symbol", "metadata", "title", "desc", "style", "script", "clippath", "mask", "pattern",
  "marker", "lineargradient", "radialgradient", "filter", "foreignobject", "namedview",
]);
const TEXT = new Set(["text", "tspan", "textpath", "flowroot", "flowpara", "flowregion"]);
const CONTAINERS = new Set(["g", "a"]);
const MAX_USE_DEPTH = 10;

const MESSAGES: Record<ImportWarningCode, (n: number) => string> = {
  "text-ignored": (n) => `${n} texto(s) ignorado(s): no Inkscape, use Caminho → Objeto para caminho antes de salvar.`,
  "image-ignored": (n) => `${n} imagem(ns) ignorada(s): a plotter só desenha linhas.`,
  "invisible-ignored": (n) => `${n} elemento(s) invisível(is) ignorado(s) (sem contorno e sem preenchimento).`,
  "use-missing-ref": (n) => `${n} <use> aponta(m) para um id que não existe.`,
  "bad-transform": (n) => `${n} transform inválido(s) ignorado(s).`,
  "bad-path": (n) => `${n} caminho(s) com erro: desenhado(s) até o ponto do erro.`,
  "size-in-px": () => "Tamanho em px: calculado a 96 dpi. Se o arquivo veio do Illustrator (72 dpi), aumente para 133%.",
  "no-size": () => "O SVG não diz o tamanho em mm: usei 96 dpi. Confira as medidas.",
};

interface Inherited {
  readonly fill?: string;
  readonly stroke?: string;
  readonly visibility?: string;
}

function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx > 0) out[decl.slice(0, idx).trim().toLowerCase()] = decl.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Percorre a árvore SVG e devolve a geometria em mm. Toda forma vira contorno
 * (o preenchimento é ignorado); só é pulado o que é invisível de verdade.
 */
export function importSvgTree(root: SvgNode): ImportResult {
  if (root.tag !== "svg") throw new SvgImportError("O arquivo não é um SVG.");
  const mapping = rootMapping(root);
  const counts = new Map<ImportWarningCode, number>();
  const warn = (c: ImportWarningCode, n = 1): void => {
    counts.set(c, (counts.get(c) ?? 0) + n);
  };

  const ids = new Map<string, SvgNode>();
  const collect = (n: SvgNode) => {
    if (n.attrs.id && !ids.has(n.attrs.id)) ids.set(n.attrs.id, n);
    n.children.forEach(collect);
  };
  collect(root);

  const out: SubPath[] = [];
  let elements = 0;

  const own = (n: SvgNode): Mat2D => {
    if (n.attrs.transform === undefined) return IDENTITY;
    const r = parseTransformList(n.attrs.transform);
    if (!r.ok) warn("bad-transform");
    return r.m;
  };

  const walk = (n: SvgNode, parentCtm: Mat2D, inh: Inherited, useDepth: number, isRoot = false): void => {
    if (IGNORED.has(n.tag)) return;
    if (TEXT.has(n.tag)) return warn("text-ignored");
    if (n.tag === "image") return warn("image-ignored");
    const style = parseStyle(n.attrs.style);
    const display = style.display ?? n.attrs.display;
    if (display === "none") return;
    const here: Inherited = {
      fill: style.fill ?? n.attrs.fill ?? inh.fill,
      stroke: style.stroke ?? n.attrs.stroke ?? inh.stroke,
      visibility: style.visibility ?? n.attrs.visibility ?? inh.visibility,
    };
    let ctm = multiply(parentCtm, own(n));

    if (n.tag === "svg") {
      if (!isRoot) {
        ctm = multiply(ctm, translation(userLength(n.attrs.x), userLength(n.attrs.y)));
        const vb = parseViewBox(n.attrs.viewBox);
        if (vb) {
          const w = userLength(n.attrs.width, vb.width);
          const h = userLength(n.attrs.height, vb.height);
          ctm = multiply(ctm, viewBoxToMm(vb, w, h, n.attrs.preserveAspectRatio));
        }
      }
      for (const c of n.children) walk(c, ctm, here, useDepth);
      return;
    }
    if (CONTAINERS.has(n.tag)) {
      for (const c of n.children) walk(c, ctm, here, useDepth);
      return;
    }
    if (n.tag === "switch") {
      const first = n.children.find((c) => !IGNORED.has(c.tag));
      if (first) walk(first, ctm, here, useDepth);
      return;
    }
    if (n.tag === "use") {
      const href = n.attrs.href ?? n.attrs["xlink:href"] ?? "";
      const target = href.startsWith("#") ? ids.get(href.slice(1)) : undefined;
      if (!target) return warn("use-missing-ref");
      if (useDepth >= MAX_USE_DEPTH) return;
      const useCtm = multiply(ctm, translation(userLength(n.attrs.x), userLength(n.attrs.y)));
      if (target.tag === "symbol") {
        for (const c of target.children) walk(c, useCtm, here, useDepth + 1);
      } else {
        walk(target, useCtm, here, useDepth + 1);
      }
      return;
    }

    let subpaths: SubPath[] | null;
    if (n.tag === "path") {
      const r = parsePathData(n.attrs.d ?? "");
      if (r.error) warn("bad-path");
      subpaths = r.subpaths;
    } else {
      subpaths = shapeToSubPaths(n);
    }
    if (subpaths === null || subpaths.length === 0) return; // elemento desconhecido ou forma vazia

    const fill = here.fill ?? "black";
    const stroke = here.stroke ?? "none";
    const hidden = here.visibility === "hidden" || here.visibility === "collapse";
    if (hidden || (fill === "none" && stroke === "none")) return warn("invisible-ignored");

    elements++;
    out.push(...transformGeometry({ subpaths }, ctm).subpaths);
  };

  walk(root, mapping.userToMm, {}, 0, true);

  let geometry: Geometry = { subpaths: out.filter((sp) => sp.segments.length > 0) };
  if (geometry.subpaths.length === 0) throw new SvgImportError("Nenhum traço encontrado no SVG.");

  let pageMm = mapping.pageMm;
  if (mapping.sizeSource === "none") {
    const b = controlBBox(geometry);
    geometry = transformGeometry(geometry, translation(-b.minX, -b.minY));
    pageMm = { width: b.maxX - b.minX, height: b.maxY - b.minY };
  }
  if (mapping.sizeSource === "px") warn("size-in-px");
  if (mapping.sizeSource === "viewBoxOnly" || mapping.sizeSource === "none") warn("no-size");

  const warnings: ImportWarning[] = [...counts].map(([code, count]) => ({ code, count, message: MESSAGES[code](count) }));
  return {
    geometry,
    pageMm,
    warnings,
    stats: { elements, subpaths: geometry.subpaths.length, segments: segmentCount(geometry) },
  };
}
