import type { Vec } from "../geometry/vec";
import type { Stroke } from "./types";

/**
 * Mapa de tinta: uma grade fina sobre o desenho dizendo onde a caneta vai deixar tinta.
 * Serve para duas regras de docs/REGRAS_GCODE.md:
 * - regra 1: emendar dois traços quando a ligação passa inteira por cima de tinta (não aparece);
 * - regra 4: retirar tracinhos que ficam totalmente escondidos por outros.
 *
 * Cada célula guarda quem a pintou: 0 = papel, i+1 = só o traço i, negativo = dois ou mais traços.
 */
export interface InkMap {
  readonly cellMm: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  readonly owner: Int32Array;
}

/** Acima disto a grade fica grossa demais para confiar: melhor não usar o mapa. */
const MAX_CELL_MM = 0.3;

/** Carimba um disco do tamanho da ponta da caneta ao longo de cada traço. */
export function buildInkMap(strokes: readonly Stroke[], penMm: number, maxCells = 24_000_000): InkMap | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!(minX <= maxX) || !(penMm > 0)) return undefined;
  const pad = penMm;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  let cellMm = Math.min(Math.max(penMm / 4, 0.05), MAX_CELL_MM);
  const area = (maxX - minX) * (maxY - minY);
  if (area / (cellMm * cellMm) > maxCells) cellMm = Math.sqrt(area / maxCells);
  if (cellMm > MAX_CELL_MM || cellMm > penMm / 2) return undefined;
  const cols = Math.ceil((maxX - minX) / cellMm) + 1;
  const rows = Math.ceil((maxY - minY) / cellMm) + 1;
  const owner = new Int32Array(cols * rows);

  // deslocamentos das células dentro do raio da ponta
  const r = penMm / 2 / cellMm;
  const ri = Math.ceil(r);
  const offs: number[] = [];
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) if (dx * dx + dy * dy <= r * r + 0.25) offs.push(dx, dy);
  }
  const step = cellMm / 2;
  const stamp = (x: number, y: number, id: number) => {
    const cx = Math.round((x - minX) / cellMm);
    const cy = Math.round((y - minY) / cellMm);
    for (let k = 0; k < offs.length; k += 2) {
      const px = cx + offs[k];
      const py = cy + offs[k + 1];
      if (px < 0 || py < 0 || px >= cols || py >= rows) continue;
      const i = py * cols + px;
      const o = owner[i];
      if (o === 0) owner[i] = id;
      else if (o > 0 && o !== id) owner[i] = -o;
    }
  };
  strokes.forEach((s, si) => {
    const id = si + 1;
    const pts = s.points;
    if (pts.length === 0) return;
    stamp(pts[0].x, pts[0].y, id);
    for (let j = 1; j < pts.length; j++) {
      const a = pts[j - 1], b = pts[j];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, id);
      }
    }
  });
  return { cellMm, minX, minY, cols, rows, owner };
}

function ownerAt(m: InkMap, x: number, y: number): number {
  const cx = Math.round((x - m.minX) / m.cellMm);
  const cy = Math.round((y - m.minY) / m.cellMm);
  if (cx < 0 || cy < 0 || cx >= m.cols || cy >= m.rows) return 0;
  return m.owner[cy * m.cols + cx];
}

/** Há tinta neste ponto? */
export function isInked(m: InkMap, p: Vec): boolean {
  return ownerAt(m, p.x, p.y) !== 0;
}

/** O traço `strokeIndex` fica inteiro debaixo da tinta de OUTROS traços? */
export function coveredByOthers(m: InkMap, strokeIndex: number, points: readonly Vec[]): boolean {
  const id = strokeIndex + 1;
  const step = m.cellMm / 2;
  const hidden = (x: number, y: number) => {
    const o = ownerAt(m, x, y);
    return o < 0 || (o > 0 && o !== id);
  };
  if (points.length === 0) return false;
  if (!hidden(points[0].x, points[0].y)) return false;
  for (let j = 1; j < points.length; j++) {
    const a = points[j - 1], b = points[j];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (!hidden(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
  }
  return true;
}

/**
 * A ligação reta de `a` até `b`, desenhada com a caneta embaixo, ficaria escondida?
 * Exige tinta no eixo da ligação e também dos dois lados dele (a 35% da largura da caneta):
 * assim a ligação inteira, com a largura dela, cai sobre tinta, e não só o miolo.
 */
export function bridgeIsHidden(m: InkMap, a: Vec, b: Vec, penMm: number): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9) return true;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const side = 0.35 * penMm;
  const nx = -uy * side, ny = ux * side;
  const n = Math.max(2, Math.ceil(len / (m.cellMm / 2)));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (ownerAt(m, x, y) === 0 || ownerAt(m, x + nx, y + ny) === 0 || ownerAt(m, x - nx, y - ny) === 0) return false;
  }
  return true;
}
