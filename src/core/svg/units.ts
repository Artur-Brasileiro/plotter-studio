import { scaling, type Mat2D } from "../geometry/mat2d";
import { parseNumberList, type SvgNode } from "./node";

/** mm por unidade. "px" e "sem unidade" = 96 dpi (CSS/Inkscape). */
const MM_PER_UNIT: Record<string, number> = {
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: 25.4 / 96,
  "": 25.4 / 96,
};

export const MM_PER_PX = 25.4 / 96;

const LENGTH_RE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/;

/** Unidade de um comprimento ("mm", "px", "" para sem unidade), ou undefined se inválido. */
export function lengthUnit(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = LENGTH_RE.exec(value);
  return m ? m[2].toLowerCase() : undefined;
}

/** "100mm" → 100; "1in" → 25,4; "96px" e "96" → 25,4. Porcentagem, em/ex e lixo → undefined. */
export function parseLengthMm(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = LENGTH_RE.exec(value);
  if (!m) return undefined;
  const k = MM_PER_UNIT[m[2].toLowerCase()];
  if (k === undefined) return undefined;
  return Number(m[1]) * k;
}

export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function parseViewBox(s: string | undefined): ViewBox | undefined {
  if (!s) return undefined;
  const n = parseNumberList(s);
  if (!n || n.length !== 4 || !(n[2] > 0) || !(n[3] > 0)) return undefined;
  return { x: n[0], y: n[1], width: n[2], height: n[3] };
}

/**
 * Leva as unidades do viewBox para mm de uma página widthMm × heightMm,
 * respeitando preserveAspectRatio (padrão "xMidYMid meet").
 */
export function viewBoxToMm(vb: ViewBox, widthMm: number, heightMm: number, preserveAspectRatio?: string): Mat2D {
  const sx = widthMm / vb.width;
  const sy = heightMm / vb.height;
  const parts = (preserveAspectRatio ?? "").trim().split(/\s+/).filter((p) => p && p !== "defer");
  const align = parts[0] ?? "xMidYMid";
  if (align === "none") return [sx, 0, 0, sy, -vb.x * sx, -vb.y * sy];
  const slice = parts[1] === "slice";
  const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const freeX = widthMm - vb.width * s;
  const freeY = heightMm - vb.height * s;
  const ax = align.includes("xMin") ? 0 : align.includes("xMax") ? freeX : freeX / 2;
  const ay = align.includes("YMin") ? 0 : align.includes("YMax") ? freeY : freeY / 2;
  return [s, 0, 0, s, ax - vb.x * s, ay - vb.y * s];
}

export interface RootMapping {
  /** Unidades de usuário do SVG → mm (Y para baixo, origem no canto sup. esq. da página) */
  readonly userToMm: Mat2D;
  /** Tamanho da página em mm. Com sizeSource "none" vale 0 × 0 (o importador usa a caixa do conteúdo). */
  readonly pageMm: { readonly width: number; readonly height: number };
  /** units = width/height com unidade física; px = em px ou sem unidade; viewBoxOnly = só viewBox; none = nada */
  readonly sizeSource: "units" | "px" | "viewBoxOnly" | "none";
}

const PHYSICAL = new Set(["mm", "cm", "q", "in", "pt", "pc"]);

export function rootMapping(root: SvgNode): RootMapping {
  const vb = parseViewBox(root.attrs.viewBox ?? root.attrs.viewbox);
  const par = root.attrs.preserveAspectRatio;
  let w = parseLengthMm(root.attrs.width);
  let h = parseLengthMm(root.attrs.height);
  const physical = PHYSICAL.has(lengthUnit(root.attrs.width) ?? "x") || PHYSICAL.has(lengthUnit(root.attrs.height) ?? "x");

  if (vb && (w !== undefined || h !== undefined)) {
    if (w === undefined) w = (h! * vb.width) / vb.height;
    if (h === undefined) h = (w * vb.height) / vb.width;
  }

  if (w !== undefined && h !== undefined && w > 0 && h > 0) {
    const userToMm = vb ? viewBoxToMm(vb, w, h, par) : scaling(MM_PER_PX);
    return { userToMm, pageMm: { width: w, height: h }, sizeSource: physical ? "units" : "px" };
  }
  if (vb) {
    const pw = vb.width * MM_PER_PX;
    const ph = vb.height * MM_PER_PX;
    return { userToMm: viewBoxToMm(vb, pw, ph, par), pageMm: { width: pw, height: ph }, sizeSource: "viewBoxOnly" };
  }
  return { userToMm: scaling(MM_PER_PX), pageMm: { width: 0, height: 0 }, sizeSource: "none" };
}
