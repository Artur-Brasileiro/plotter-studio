import type { Vec } from "../geometry/vec";
import type { Stroke } from "./types";

/**
 * Mapa de tinta: uma grade fina sobre o desenho dizendo onde a caneta vai deixar tinta.
 * Serve para duas regras de docs/REGRAS_GCODE.md:
 * - regra 1: emendar dois traços quando a ligação passa inteira por cima de tinta (não aparece);
 * - regra 4: retirar tracinhos que ficam totalmente escondidos por outros.
 *
 * O mapa é CONSERVADOR: uma célula só conta como tinta se ela inteira estiver dentro do risco da
 * caneta. Ele pode deixar de ver tinta que existe (perde-se uma emenda: um ciclo a mais do servo),
 * mas nunca vê tinta onde há papel (o que criaria um risco novo no desenho, ou sumiria com um traço).
 * Por isso também não guarda "quem pintou": os traços são carimbados um a um, só os que ficam.
 */
export interface InkMap {
  readonly cellMm: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  readonly penMm: number;
  /** Raio carimbado (mm): meia largura da caneta menos meia diagonal da célula */
  readonly stampMm: number;
  /** Um bit por célula */
  readonly bits: Uint32Array;
}

/** A célula tem que ser pequena perto da ponta: acima disto o mapa conservador não vê quase nada. */
const MAX_CELL_PER_PEN = 0.35;
const HALF_DIAGONAL = Math.SQRT1_2;

/**
 * Mapa vazio que cobre todos os `strokes` (com folga de uma largura de caneta).
 * `undefined` quando a grade teria de ser grossa demais para a caneta (desenho enorme, caneta fina):
 * sem mapa só valem as emendas por salto pequeno.
 */
export function createInkMap(strokes: readonly Stroke[], penMm: number, maxCells = 200_000_000): InkMap | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!(minX <= maxX) || !(minY <= maxY) || !(penMm > 0) || !Number.isFinite(maxX - minX) || !Number.isFinite(maxY - minY)) return undefined;
  const pad = penMm;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  let cellMm = Math.max(penMm / 8, 0.0125);
  const area = (maxX - minX) * (maxY - minY);
  if (area / (cellMm * cellMm) > maxCells) cellMm = Math.sqrt(area / maxCells);
  if (cellMm > penMm * MAX_CELL_PER_PEN) return undefined;
  const cols = Math.ceil((maxX - minX) / cellMm) + 1;
  const rows = Math.ceil((maxY - minY) / cellMm) + 1;
  return { cellMm, minX, minY, cols, rows, penMm, stampMm: penMm / 2 - cellMm * HALF_DIAGONAL, bits: new Uint32Array(Math.ceil((cols * rows) / 32)) };
}

/** Pinta no mapa o risco de um traço (um "ponto" pinta um disco). */
export function stampStroke(m: InkMap, points: readonly Vec[]): void {
  if (points.length === 0) return;
  if (points.length === 1) return stampCapsule(m, points[0].x, points[0].y, points[0].x, points[0].y);
  // pedaços curtos: a caixa de um pedaço longo na diagonal teria quase só papel
  const piece = m.cellMm * 8;
  for (let j = 1; j < points.length; j++) {
    const a = points[j - 1], b = points[j];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / piece));
    let px = a.x, py = a.y;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const qx = a.x + (b.x - a.x) * t, qy = a.y + (b.y - a.y) * t;
      stampCapsule(m, px, py, qx, qy);
      px = qx;
      py = qy;
    }
  }
}

/** Marca as células cujo CENTRO está a até `stampMm` do segmento: a célula inteira fica dentro do risco. */
function stampCapsule(m: InkMap, ax: number, ay: number, bx: number, by: number): void {
  const { cellMm: c, minX, minY, cols, rows, bits } = m;
  const r = m.stampMm;
  if (!(r > 0)) return;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - minX) / c));
  const x1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + r - minX) / c));
  const y0 = Math.max(0, Math.floor((Math.min(ay, by) - r - minY) / c));
  const y1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + r - minY) / c));
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  for (let cy = y0; cy <= y1; cy++) {
    const py = minY + (cy + 0.5) * c;
    const row = cy * cols;
    for (let cx = x0; cx <= x1; cx++) {
      const px = minX + (cx + 0.5) * c;
      let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = px - (ax + dx * t), ey = py - (ay + dy * t);
      if (ex * ex + ey * ey <= r2) {
        const i = row + cx;
        bits[i >>> 5] |= 1 << (i & 31);
      }
    }
  }
}

/** Mapa com todos os traços carimbados. */
export function buildInkMap(strokes: readonly Stroke[], penMm: number, maxCells?: number): InkMap | undefined {
  const m = createInkMap(strokes, penMm, maxCells);
  if (m) for (const s of strokes) stampStroke(m, s.points);
  return m;
}

function inked(m: InkMap, x: number, y: number): boolean {
  const cx = Math.floor((x - m.minX) / m.cellMm);
  const cy = Math.floor((y - m.minY) / m.cellMm);
  if (!(cx >= 0 && cy >= 0 && cx < m.cols && cy < m.rows)) return false;
  const i = cy * m.cols + cx;
  return (m.bits[i >>> 5] & (1 << (i & 31))) !== 0;
}

/** Há tinta neste ponto, com certeza? (falso também quando o mapa não tem como garantir) */
export function isInked(m: InkMap, p: Vec): boolean {
  return inked(m, p.x, p.y);
}

/**
 * Quanto do risco pode sobrar para fora da tinta que já existe sem aparecer (mm): a mesma tolerância
 * de 0,1 mm de REGRAS_GCODE.md, limitada a 1/4 da largura da caneta (na fina, 0,025 mm).
 */
const slackOf = (penMm: number) => Math.min(0.1, penMm / 4);
/**
 * Para RETIRAR um traço a folga é menor: sumir com tinta que apareceria é pior que gastar uma descida.
 * 0,075 mm (na caneta de 0,4) é o mínimo com que o mapa conservador ainda reconhece um tracinho
 * desenhado exatamente em cima de outro traço; menos que isso, só sumiria o que está no miolo de uma
 * área pintada por vários traços.
 */
const removalSlackOf = (penMm: number) => slackOf(penMm) * 0.75;

/**
 * O risco de `a` até `b` (com a largura da caneta) cai inteiro sobre a tinta do mapa?
 * Confere o eixo e as duas bordas do risco (menos a tolerância), a cada meia célula.
 * `caps`: confere também as pontas arredondadas, além de `a` e de `b`.
 */
function bandCovered(m: InkMap, a: Vec, b: Vec, caps: boolean, slackMm: number): boolean {
  const side = Math.max(0, m.penMm / 2 - slackMm);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9) {
    if (!inked(m, a.x, a.y)) return false;
    return !caps || side === 0 || (inked(m, a.x + side, a.y) && inked(m, a.x - side, a.y) && inked(m, a.x, a.y + side) && inked(m, a.x, a.y - side));
  }
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const nx = -uy * side, ny = ux * side;
  const n = Math.max(2, Math.ceil(len / (m.cellMm / 2)));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!inked(m, x, y)) return false;
    if (side > 0 && (!inked(m, x + nx, y + ny) || !inked(m, x - nx, y - ny))) return false;
  }
  if (caps && side > 0) {
    if (!inked(m, a.x - ux * side, a.y - uy * side) || !inked(m, b.x + ux * side, b.y + uy * side)) return false;
  }
  return true;
}

/**
 * O traço fica TOTALMENTE escondido pela tinta que já está no mapa? (regra 4)
 * "Totalmente" é o risco inteiro, com a largura da caneta e as pontas, e não só o eixo: um tracinho
 * com metade da largura para fora da linha vizinha engrossa a linha, então não está escondido.
 * O mapa não pode conter o próprio traço.
 */
export function strokeCovered(m: InkMap, points: readonly Vec[]): boolean {
  if (points.length === 0) return false;
  const slack = removalSlackOf(m.penMm);
  if (points.length === 1) return bandCovered(m, points[0], points[0], true, slack);
  for (let j = 1; j < points.length; j++) {
    if (!bandCovered(m, points[j - 1], points[j], true, slack)) return false;
  }
  return true;
}

/**
 * A ligação reta de `a` até `b`, desenhada com a caneta embaixo, ficaria escondida? (regra 1)
 * Exige tinta no eixo da ligação e nas duas bordas dela (menos a tolerância de 0,1 mm): a ligação
 * inteira, com a largura dela, cai sobre tinta, e não só o miolo.
 */
export function bridgeIsHidden(m: InkMap, a: Vec, b: Vec, _penMm: number = m.penMm): boolean {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return true;
  return bandCovered(m, a, b, false, slackOf(m.penMm));
}
