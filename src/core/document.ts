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
  /** Caneta (id em MachineProfile.pens). Sem valor = a caneta padrão do perfil. */
  readonly penId?: string;
  /**
   * Conjunto: os desenhos que vieram juntos (as camadas de uma mesma imagem, uma por caneta) têm o mesmo
   * valor aqui e a MESMA posição. A mesa trata o conjunto como uma coisa só, para as camadas não desencontrarem.
   */
  readonly group?: string;
}

export interface PlotDocument {
  readonly drawings: readonly Drawing[];
}

export const EMPTY_DOCUMENT: PlotDocument = { drawings: [] };

export function createDrawing(id: DrawingId, name: string, geometry: Geometry, transform: Mat2D, penId?: string, group?: string): Drawing {
  return { id, name, geometry, localBBox: controlBBox(geometry), transform, ...(penId ? { penId } : {}), ...(group ? { group } : {}) };
}

/** Os desenhos do mesmo conjunto de `id` (ele incluído), na ordem do documento. Desenho solto: só ele. */
export function groupMembers(doc: PlotDocument, id: DrawingId): DrawingId[] {
  const d = doc.drawings.find((x) => x.id === id);
  if (!d) return [];
  if (!d.group) return [d.id];
  return doc.drawings.filter((x) => x.group === d.group).map((x) => x.id);
}

/** Os itens da mesa: cada conjunto uma vez (com todas as camadas) e cada desenho solto, na ordem do documento. */
export function groupsOf(doc: PlotDocument): DrawingId[][] {
  const out: DrawingId[][] = [];
  const at = new Map<string, DrawingId[]>();
  for (const d of doc.drawings) {
    const list = d.group ? at.get(d.group) : undefined;
    if (list) list.push(d.id);
    else {
      const item = [d.id];
      if (d.group) at.set(d.group, item);
      out.push(item);
    }
  }
  return out;
}

/** Troca a caneta dos desenhos indicados. */
export function setPen(doc: PlotDocument, ids: readonly DrawingId[], penId: string): PlotDocument {
  let changed = false;
  const drawings = doc.drawings.map((d) => {
    if (!ids.includes(d.id) || d.penId === penId) return d;
    changed = true;
    return { ...d, penId };
  });
  return changed ? { drawings } : doc;
}

/**
 * Coloca o canto INFERIOR esquerdo da página em `corner` (mm da máquina). O padrão do aplicativo é o
 * canto da zona de desenho: um desenho recém-importado já cai dentro do papel (docs/REGRAS_GCODE.md).
 */
export function importPlacement(pageMm: { width: number; height: number }, workHeight: number, corner: Vec = { x: 0, y: 0 }): Mat2D {
  return translation(corner.x, workHeight - pageMm.height - corner.y);
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
  // a cópia de um conjunto é um conjunto novo: anda junta entre si, não com o original
  const newGroup = new Map<string, string>();
  const copies: Drawing[] = doc.drawings
    .filter((d) => set.has(d.id))
    .map((d) => {
      const copy: Drawing = { ...d, id: newId(), transform: multiply(t, d.transform) };
      if (!d.group) return copy;
      if (!newGroup.has(d.group)) newGroup.set(d.group, `${d.group}+${copy.id}`);
      return { ...copy, group: newGroup.get(d.group)! };
    });
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

/** As ids pedidas mais as outras camadas dos conjuntos delas, sem repetir, na ordem do documento. */
export function expandToGroups(doc: PlotDocument, ids: readonly DrawingId[]): DrawingId[] {
  const want = new Set(ids);
  const groups = new Set<string>();
  for (const d of doc.drawings) if (d.group && want.has(d.id)) groups.add(d.group);
  return doc.drawings.filter((d) => want.has(d.id) || (d.group !== undefined && groups.has(d.group))).map((d) => d.id);
}

/** Aplica UMA transformação, escrita em coordenadas da máquina, a todos os desenhos indicados. */
function applyToSelection(doc: PlotDocument, ids: readonly DrawingId[], machineOp: Mat2D, workHeight: number): PlotDocument {
  const updates = new Map<DrawingId, Mat2D>();
  for (const d of doc.drawings) if (ids.includes(d.id)) updates.set(d.id, applyInMachine(d, machineOp, workHeight));
  return setTransforms(doc, updates);
}

/**
 * Como `setMachineBox`, mas para a seleção inteira como UM bloco (as camadas de um conjunto, ou vários
 * desenhos): x/y = novo canto inferior esquerdo da caixa do bloco; width/height = novo tamanho dela.
 * Todos recebem a mesma operação, então continuam na mesma posição uns em relação aos outros.
 * Sem nada para mudar, devolve o mesmo documento.
 */
export function setSelectionBox(
  doc: PlotDocument,
  ids: readonly DrawingId[],
  box: { x?: number; y?: number; width?: number; height?: number; keepRatio: boolean },
  workHeight: number,
  tolMm: number,
): PlotDocument {
  const b = selectionMachineBBox(doc, ids, workHeight, tolMm);
  if (!(b.minX <= b.maxX)) return doc;
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  let sx = box.width !== undefined && bw > 1e-9 ? box.width / bw : 1;
  let sy = box.height !== undefined && bh > 1e-9 ? box.height / bh : 1;
  if (box.keepRatio) {
    const s = box.width !== undefined && bw > 1e-9 ? sx : sy;
    sx = sy = s;
  }
  if (!(sx > 0) || !(sy > 0)) return doc;
  if (box.x === undefined && box.y === undefined && sx === 1 && sy === 1) return doc;
  const tx = box.x ?? b.minX;
  const ty = box.y ?? b.minY;
  return applyToSelection(doc, ids, multiplyAll(translation(tx, ty), scaling(sx, sy), translation(-b.minX, -b.minY)), workHeight);
}

/**
 * Gira a seleção inteira, como um bloco, em torno do centro da caixa DELA, até o ângulo pedido (como o
 * operador vê). O ângulo do bloco é o do primeiro desenho dele; num conjunto, todas as camadas têm o mesmo.
 */
export function setSelectionRotation(doc: PlotDocument, ids: readonly DrawingId[], deg: number, workHeight: number, tolMm: number): PlotDocument {
  const first = doc.drawings.find((d) => ids.includes(d.id));
  if (!first) return doc;
  const delta = deg - machineRotationDeg(first.transform);
  if (Math.abs(delta) < 1e-9) return doc;
  const c = bboxCenter(selectionMachineBBox(doc, ids, workHeight, tolMm));
  return applyToSelection(doc, ids, multiplyAll(translation(c.x, c.y), rotationDeg(delta), translation(-c.x, -c.y)), workHeight);
}

/** "Encaixar na folha": o bloco fica do maior tamanho que cabe em `target`, com `marginMm` de folga de cada lado, e centralizado nela. */
export function fitSelection(doc: PlotDocument, ids: readonly DrawingId[], target: BBox, marginMm: number, workHeight: number, tolMm: number): PlotDocument {
  const b = selectionMachineBBox(doc, ids, workHeight, tolMm);
  if (!(b.minX <= b.maxX)) return doc;
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const roomW = target.maxX - target.minX - 2 * marginMm;
  const roomH = target.maxY - target.minY - 2 * marginMm;
  const k = Math.min(bw > 1e-9 ? roomW / bw : Infinity, bh > 1e-9 ? roomH / bh : Infinity);
  if (!(k > 0) || !Number.isFinite(k)) return alignCenter(doc, ids, target, workHeight, tolMm);
  const sized = setSelectionBox(doc, ids, bw > 1e-9 ? { width: bw * k, keepRatio: true } : { height: bh * k, keepRatio: true }, workHeight, tolMm);
  return alignCenter(sized, ids, target, workHeight, tolMm);
}

/** Duas posições são a mesma? (os seis números, com a folga de arredondamento de desfazer e de abrir um projeto) */
function sameTransform(a: Mat2D, b: Mat2D): boolean {
  if (a === b) return true;
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 1e-9 * Math.max(1, Math.abs(a[i]), Math.abs(b[i]))) return false;
  return true;
}

/**
 * O que a mesa mostra como UM objeto: cada desenho solto, e cada conjunto cujas camadas estão todas na
 * mesma posição. Um conjunto com camadas em posições diferentes (não deveria acontecer: a mesa só mexe
 * nelas juntas) não pode ser desenhado como um bloco, e aí cada camada é um item.
 */
export function tableItems(doc: PlotDocument): DrawingId[][] {
  const byId = new Map(doc.drawings.map((d) => [d.id, d]));
  const out: DrawingId[][] = [];
  for (const ids of groupsOf(doc)) {
    const first = byId.get(ids[0])!;
    if (ids.every((id) => sameTransform(byId.get(id)!.transform, first.transform))) out.push(ids);
    else for (const id of ids) out.push([id]);
  }
  return out;
}
