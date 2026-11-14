import { ellipseSubPath, ellipticArcCubics, type Segment, type SubPath } from "../geometry/path";
import { nearlyEqual, type Vec } from "../geometry/vec";
import { parseNumberList, type SvgNode } from "./node";
import { lengthUnit, MM_PER_PX, parseLengthMm } from "./units";

/** Comprimento dentro do desenho, em unidades de usuário. "10mm" vira 37,8 (px a 96 dpi), como no navegador. */
export function userLength(v: string | undefined, fallback = 0): number {
  if (v === undefined || v.trim() === "") return fallback;
  const unit = lengthUnit(v);
  if (unit === undefined) return fallback;
  if (unit === "" || unit === "px") return parseLengthMm(v)! / MM_PER_PX;
  const mm = parseLengthMm(v);
  return mm === undefined ? fallback : mm / MM_PER_PX;
}

const SHAPES = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon"]);

/**
 * Forma básica → subpaths em unidades de usuário (sem o transform do elemento).
 * null = não é forma básica (path é tratado à parte); [] = forma vazia (ex.: largura 0).
 */
export function shapeToSubPaths(node: SvgNode): SubPath[] | null {
  if (!SHAPES.has(node.tag)) return null;
  const a = node.attrs;
  switch (node.tag) {
    case "rect":
      return rect(userLength(a.x), userLength(a.y), userLength(a.width), userLength(a.height), a.rx, a.ry);
    case "circle": {
      const r = userLength(a.r);
      return r > 0 ? [ellipseSubPath(userLength(a.cx), userLength(a.cy), r, r)] : [];
    }
    case "ellipse": {
      let rx = userLength(a.rx, NaN);
      let ry = userLength(a.ry, NaN);
      if (Number.isNaN(rx)) rx = ry;
      if (Number.isNaN(ry)) ry = rx;
      return rx > 0 && ry > 0 ? [ellipseSubPath(userLength(a.cx), userLength(a.cy), rx, ry)] : [];
    }
    case "line": {
      const start = { x: userLength(a.x1), y: userLength(a.y1) };
      return [{ start, segments: [{ kind: "line", to: { x: userLength(a.x2), y: userLength(a.y2) } }], closed: false }];
    }
    case "polyline":
    case "polygon": {
      const nums = parseNumberList(a.points ?? "") ?? [];
      const pts: Vec[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
      if (pts.length < 2) return [];
      const segments: Segment[] = pts.slice(1).map((to) => ({ kind: "line", to }));
      const closed = node.tag === "polygon";
      if (closed) {
        if (nearlyEqual(pts[pts.length - 1], pts[0], 1e-9)) segments[segments.length - 1] = { kind: "line", to: pts[0] };
        else segments.push({ kind: "line", to: pts[0] });
      }
      return [{ start: pts[0], segments, closed }];
    }
  }
  return null;
}

function rect(x: number, y: number, w: number, h: number, rxAttr?: string, ryAttr?: string): SubPath[] {
  if (!(w > 0) || !(h > 0)) return [];
  let rx = rxAttr !== undefined && rxAttr !== "auto" ? userLength(rxAttr, NaN) : NaN;
  let ry = ryAttr !== undefined && ryAttr !== "auto" ? userLength(ryAttr, NaN) : NaN;
  if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
  if (Number.isNaN(ry)) ry = rx;
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);

  const start = { x: x + (rx > 0 && ry > 0 ? rx : 0), y };
  if (rx <= 0 || ry <= 0) {
    return [
      {
        start,
        segments: [
          { kind: "line", to: { x: x + w, y } },
          { kind: "line", to: { x: x + w, y: y + h } },
          { kind: "line", to: { x, y: y + h } },
          { kind: "line", to: start },
        ],
        closed: true,
      },
    ];
  }
  const segs: Segment[] = [];
  const line = (to: Vec) => {
    const prev = segs.length ? segs[segs.length - 1].to : start;
    if (!nearlyEqual(prev, to, 1e-12)) segs.push({ kind: "line", to });
  };
  const corner = (cx: number, cy: number, from: number, end: Vec) => {
    const arc = ellipticArcCubics(cx, cy, rx, ry, 0, from, Math.PI / 2);
    arc[arc.length - 1] = { ...arc[arc.length - 1], to: end };
    segs.push(...arc);
  };
  const H = Math.PI / 2;
  line({ x: x + w - rx, y });
  corner(x + w - rx, y + ry, -H, { x: x + w, y: y + ry });
  line({ x: x + w, y: y + h - ry });
  corner(x + w - rx, y + h - ry, 0, { x: x + w - rx, y: y + h });
  line({ x: x + rx, y: y + h });
  corner(x + rx, y + h - ry, H, { x, y: y + h - ry });
  line({ x, y: y + ry });
  corner(x + rx, y + ry, Math.PI, start);
  return [{ start, segments: segs, closed: true }];
}
