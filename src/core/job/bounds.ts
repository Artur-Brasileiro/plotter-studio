import { bboxOfPoints, unionBBox, type BBox } from "../geometry/path";
import type { DrawingId } from "../document";
import type { MachineProfile } from "../machine";
import type { BoundsViolation, Stroke } from "./types";

const fmt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function boxes(strokes: readonly Stroke[]): Map<DrawingId, BBox> {
  const out = new Map<DrawingId, BBox>();
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    const b = bboxOfPoints(s.points);
    const prev = out.get(s.drawingId);
    out.set(s.drawingId, prev ? unionBBox(prev, b) : b);
  }
  return out;
}

/**
 * Desenho com algum ponto fora de 0..W × 0..H (com folga eps para o arredondamento)?
 * Uma violação por desenho, com quanto sai de cada lado. O soft limit do GRBL daria
 * ALARM:2 e perderia a posição, então isso bloqueia exportar/enviar.
 */
export function checkBounds(strokes: readonly Stroke[], area: { width: number; height: number }, epsMm = 0.005): BoundsViolation[] {
  const out: BoundsViolation[] = [];
  // Coordenada que não é número (NaN, infinito) escapa de qualquer comparação: é erro por si só.
  const broken = new Set<DrawingId>();
  for (const s of strokes) {
    if (!broken.has(s.drawingId) && s.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) broken.add(s.drawingId);
  }
  for (const drawingId of broken) {
    out.push({ drawingId, bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, message: "tem uma coordenada que não é número e não pode ser desenhado: fica fora", kind: "area" });
  }
  for (const [drawingId, b] of boxes(strokes)) {
    if (broken.has(drawingId)) continue;
    const parts: string[] = [];
    if (b.minX < -epsMm) parts.push(`${fmt(-b.minX)} mm à esquerda`);
    if (b.maxX > area.width + epsMm) parts.push(`${fmt(b.maxX - area.width)} mm à direita`);
    if (b.minY < -epsMm) parts.push(`${fmt(-b.minY)} mm na frente`);
    if (b.maxY > area.height + epsMm) parts.push(`${fmt(b.maxY - area.height)} mm no fundo`);
    if (parts.length) out.push({ drawingId, bbox: b, message: `sai ${parts.join(", ")}`, kind: "area" });
  }
  return out;
}

/**
 * Desenho com algum ponto fora da zona de desenho (o papel)? docs/REGRAS_GCODE.md: nenhum traço
 * sai da zona. Quem já está fora do curso da máquina aparece só em `checkBounds`.
 */
export function checkZone(strokes: readonly Stroke[], zone: MachineProfile["drawZone"], skip: ReadonlySet<DrawingId>, epsMm = 0.005): BoundsViolation[] {
  const out: BoundsViolation[] = [];
  for (const [drawingId, b] of boxes(strokes)) {
    if (skip.has(drawingId)) continue;
    const parts: string[] = [];
    if (b.minX < zone.minX - epsMm) parts.push(`${fmt(zone.minX - b.minX)} mm à esquerda`);
    if (b.maxX > zone.maxX + epsMm) parts.push(`${fmt(b.maxX - zone.maxX)} mm à direita`);
    if (b.minY < zone.minY - epsMm) parts.push(`${fmt(zone.minY - b.minY)} mm na frente`);
    if (b.maxY > zone.maxY + epsMm) parts.push(`${fmt(b.maxY - zone.maxY)} mm no fundo`);
    if (parts.length) out.push({ drawingId, bbox: b, message: `sai ${parts.join(", ")}`, kind: "zone" });
  }
  return out;
}
