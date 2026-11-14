import { bboxOfPoints, unionBBox, type BBox } from "../geometry/path";
import type { DrawingId } from "../document";
import type { BoundsViolation, Stroke } from "./types";

const fmt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Desenho com algum ponto fora de 0..W × 0..H (com folga eps para o arredondamento)?
 * Uma violação por desenho, com quanto sai de cada lado. O soft limit do GRBL daria
 * ALARM:2 e perderia a posição, então isso bloqueia exportar/enviar.
 */
export function checkBounds(strokes: readonly Stroke[], area: { width: number; height: number }, epsMm = 0.005): BoundsViolation[] {
  const boxes = new Map<DrawingId, BBox>();
  for (const s of strokes) {
    const b = bboxOfPoints(s.points);
    const prev = boxes.get(s.drawingId);
    boxes.set(s.drawingId, prev ? unionBBox(prev, b) : b);
  }
  const out: BoundsViolation[] = [];
  for (const [drawingId, b] of boxes) {
    const parts: string[] = [];
    if (b.minX < -epsMm) parts.push(`${fmt(-b.minX)} mm à esquerda`);
    if (b.maxX > area.width + epsMm) parts.push(`${fmt(b.maxX - area.width)} mm à direita`);
    if (b.minY < -epsMm) parts.push(`${fmt(-b.minY)} mm na frente`);
    if (b.maxY > area.height + epsMm) parts.push(`${fmt(b.maxY - area.height)} mm no fundo`);
    if (parts.length) out.push({ drawingId, bbox: b, message: `sai ${parts.join(", ")}` });
  }
  return out;
}
