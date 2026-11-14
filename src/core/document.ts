import { machineRotationDeg, sceneToMachineMatrix } from "./coords";
import { flattenGeometry } from "./geometry/flatten";
import { multiply, multiplyAll, rotationDeg, scaling, translation, type Mat2D } from "./geometry/mat2d";
import { bboxCenter, bboxOfPoints, controlBBox, emptyBBox, unionBBox, type BBox, type Geometry } from "./geometry/path";
import type { Vec } from "./geometry/vec";

export type DrawingId = string;

export interface Drawing {
  readonly id: DrawingId;
  /** Nome do arquivo, para listas e cabeçalho do G-code */
  readonly name: string;
  /** Compartilhada por referência entre snapshots: NUNCA mutar */
  readonly geometry: Geometry;
  /** controlBBox(geometry), calculada uma vez */
  readonly localBBox: BBox;
  /** Local (mm) → cena (mm) */
  readonly transform: Mat2D;
}

export interface PlotDocument {
  readonly drawings: readonly Drawing[];
}

export const EMPTY_DOCUMENT: PlotDocument = { drawings: [] };

export function createDrawing(id: DrawingId, name: string, geometry: Geometry, transform: Mat2D): Drawing {
  return { id, name, geometry, localBBox: controlBBox(geometry), transform };
}

/** Coloca o canto INFERIOR esquerdo da página no (0,0) da máquina. */
export function importPlacement(pageMm: { width: number; height: number }, workHeight: number): Mat2D {
  return translation(0, workHeight - pageMm.height);
}

export function addDrawing(doc: PlotDocument, d: Drawing): PlotDocument {
  return { drawings: [...doc.drawings, d] };
}

export function removeDrawings(doc: PlotDocument, ids: readonly DrawingId[]): PlotDocument {
  if (ids.length === 0) return doc;
  const set = new Set(ids);
  const drawings = doc.drawings.filter((d) => !set.has(d.id));
  return drawings.length === doc.drawings.length ? doc : { drawings };
}

/** Translação em mm da MÁQUINA (+Y = para longe do operador) expressa na cena (−Y). */
function machineTranslationInScene(d: Vec): Mat2D {
  return translation(d.x, -d.y);
}

export function duplicateDrawings(
  doc: PlotDocument,
  ids: readonly DrawingId[],
  newId: () => DrawingId,
  offsetMachine: Vec,
  _workHeight: number,
): { doc: PlotDocument; newIds: DrawingId[] } {
  const set = new Set(ids);
  const t = machineTranslationInScene(offsetMachine);
  const copies: Drawing[] = doc.drawings
    .filter((d) => set.has(d.id))
    .map((d) => ({ ...d, id: newId(), transform: multiply(t, d.transform) }));
  if (copies.length === 0) return { doc, newIds: [] };
  return { doc: { drawings: [...doc.drawings, ...copies] }, newIds: copies.map((c) => c.id) };
}

export function setTransforms(doc: PlotDocument, updates: ReadonlyMap<DrawingId, Mat2D>): PlotDocument {
  if (updates.size === 0) return doc;
  let changed = false;
  const drawings = doc.drawings.map((d) => {
    const m = updates.get(d.id);
    if (!m) return d;
    changed = true;
    return { ...d, transform: m };
  });
  return changed ? { drawings } : doc;
}

export function translateMachine(doc: PlotDocument, ids: readonly DrawingId[], d: Vec): PlotDocument {
  if (d.x === 0 && d.y === 0) return doc;
  const t = machineTranslationInScene(d);
  const updates = new Map<DrawingId, Mat2D>();
  for (const dr of doc.drawings) if (ids.includes(dr.id)) updates.set(dr.id, multiply(t, dr.transform));
  return setTransforms(doc, updates);
}

const bboxCache = new WeakMap<Drawing, { h: number; tol: number; bbox: BBox }>();

/** Caixa alinhada aos eixos, em mm da MÁQUINA, da geometria achatada (exata, não a dos pontos de controle). */
export function machineBBox(d: Drawing, workHeight: number, tolMm: number): BBox {
  const hit = bboxCache.get(d);
  if (hit && hit.h === workHeight && hit.tol === tolMm) return hit.bbox;
  const m = multiply(sceneToMachineMatrix(workHeight), d.transform);
  let b = emptyBBox();
  for (const pl of flattenGeometry(d.geometry, m, tolMm)) b = unionBBox(b, bboxOfPoints(pl.points));
  bboxCache.set(d, { h: workHeight, tol: tolMm, bbox: b });
  return b;
}

export function selectionMachineBBox(doc: PlotDocument, ids: readonly DrawingId[], workHeight: number, tolMm: number): BBox {
  let b = emptyBBox();
  for (const d of doc.drawings) if (ids.includes(d.id)) b = unionBBox(b, machineBBox(d, workHeight, tolMm));
  return b;
}

/** Aplica uma transformação expressa em coordenadas da máquina a um desenho. */
function applyInMachine(d: Drawing, machineOp: Mat2D, workHeight: number): Mat2D {
  const F = sceneToMachineMatrix(workHeight);
  return multiplyAll(F, machineOp, F, d.transform);
}

/**
 * Edição pelo painel: posiciona e/ou escala pela caixa na máquina.
 * x/y = novo canto inferior esquerdo; width/height = novo tamanho da caixa.
 * keepRatio: o fator do campo informado vale para os dois eixos.
 */
export function setMachineBox(
  doc: PlotDocument,
  id: DrawingId,
  box: { x?: number; y?: number; width?: number; height?: number; keepRatio: boolean },
  workHeight: number,
  tolMm: number,
): PlotDocument {
  const d = doc.drawings.find((dr) => dr.id === id);
  if (!d) return doc;
  const b = machineBBox(d, workHeight, tolMm);
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  let sx = box.width !== undefined && bw > 1e-9 ? box.width / bw : 1;
  let sy = box.height !== undefined && bh > 1e-9 ? box.height / bh : 1;
  if (box.keepRatio) {
    const s = box.width !== undefined && bw > 1e-9 ? sx : sy;
    sx = sy = s;
  }
  if (!(sx > 0) || !(sy > 0)) return doc;
  const tx = box.x ?? b.minX;
  const ty = box.y ?? b.minY;
  const op = multiplyAll(translation(tx, ty), scaling(sx, sy), translation(-b.minX, -b.minY));
  return setTransforms(doc, new Map([[id, applyInMachine(d, op, workHeight)]]));
}

/** Gira até o ângulo pedido (como o operador vê), em torno do centro da caixa. */
export function setMachineRotation(doc: PlotDocument, id: DrawingId, deg: number, workHeight: number, tolMm: number): PlotDocument {
  const d = doc.drawings.find((dr) => dr.id === id);
  if (!d) return doc;
  const delta = deg - machineRotationDeg(d.transform);
  if (Math.abs(delta) < 1e-9) return doc;
  const c = bboxCenter(machineBBox(d, workHeight, tolMm));
  // em Y para cima, rotationDeg(+) é anti-horário
  const op = multiplyAll(translation(c.x, c.y), rotationDeg(delta), translation(-c.x, -c.y));
  return setTransforms(doc, new Map([[id, applyInMachine(d, op, workHeight)]]));
}

/** Centraliza a seleção (como um bloco) no centro de `target` (caixa em mm da máquina). */
export function alignCenter(doc: PlotDocument, ids: readonly DrawingId[], target: BBox, workHeight: number, tolMm: number): PlotDocument {
  const b = selectionMachineBBox(doc, ids, workHeight, tolMm);
  if (!(b.minX <= b.maxX)) return doc;
  const from = bboxCenter(b);
  const to = bboxCenter(target);
  return translateMachine(doc, ids, { x: to.x - from.x, y: to.y - from.y });
}
