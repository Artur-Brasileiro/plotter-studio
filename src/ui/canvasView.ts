import { ActiveSelection, type Canvas, type FabricObject } from "fabric";
import { modelMatrixFromFabric, sceneToMachineMatrix } from "../core/coords";
import { machineBBox, setTransforms, type DrawingId, type PlotDocument } from "../core/document";
import { apply, multiply, type Mat2D } from "../core/geometry/mat2d";
import type { BBox } from "../core/geometry/path";
import type { Store } from "../core/store";
import { DrawingObject } from "./drawingObject";

const ACTION_LABEL: Record<string, string> = {
  drag: "Mover",
  rotate: "Girar",
  scale: "Redimensionar",
  scaleX: "Redimensionar",
  scaleY: "Redimensionar",
};

const EPS = 0.005; // mesma folga do checkBounds

function outside(b: BBox, area: { width: number; height: number }): boolean {
  return b.minX < -EPS || b.minY < -EPS || b.maxX > area.width + EPS || b.maxY > area.height + EPS;
}

/**
 * Sincroniza o documento (fonte da verdade) com o Fabric (só a vista).
 * - modelo → Fabric: sync() cria, remove e reposiciona objetos, preservando a seleção.
 * - Fabric → modelo: no fim de cada gesto (object:modified), a matriz de cada objeto
 *   (calcTransformMatrix, que inclui a seleção múltipla) vira um commit no store.
 */
export class CanvasView {
  private readonly objs = new Map<DrawingId, DrawingObject>();
  private syncing = false;

  constructor(
    private readonly canvas: Canvas,
    private readonly store: Store,
    private readonly onOutOfArea: (count: number) => void = () => {},
  ) {
    canvas.on("object:modified", (e) => this.onModified(e.action));
    const push = () => this.pushSelection();
    canvas.on("selection:created", push);
    canvas.on("selection:updated", push);
    canvas.on("selection:cleared", push);
    const live = () => this.liveAreaCheck();
    canvas.on("object:moving", live);
    canvas.on("object:scaling", live);
    canvas.on("object:rotating", live);
    // durante um gesto, cada quadro redesenha tudo: com cache, desenhos grandes viram uma cópia de bitmap
    canvas.on("before:transform", () => this.setCaching(true));
    canvas.on("mouse:up", () => this.setCaching(false));
    store.subscribe((s, prev) => {
      if (s.history !== prev.history || s.selection !== prev.selection || s.profile !== prev.profile) this.sync();
    });
    this.sync();
  }

  get doc(): PlotDocument {
    return this.store.doc;
  }

  private get H(): number {
    return this.store.state.profile.workArea.height;
  }

  private activeDrawings(): DrawingObject[] {
    return this.canvas.getActiveObjects().filter((o): o is DrawingObject => o instanceof DrawingObject);
  }

  /** Reconcilia o Fabric com o documento. */
  sync(): void {
    this.syncing = true;
    try {
      const doc = this.store.doc;
      const ids = new Set(doc.drawings.map((d) => d.id));
      const active = new Set(this.activeDrawings());
      let touchesSelection = false;

      const removed: DrawingObject[] = [];
      for (const [id, o] of this.objs) {
        if (!ids.has(id)) {
          removed.push(o);
          if (active.has(o)) touchesSelection = true;
        }
      }
      const updates: [DrawingObject, Mat2D][] = [];
      const added: DrawingObject[] = [];
      for (const d of doc.drawings) {
        const o = this.objs.get(d.id);
        if (!o || o.geometry !== d.geometry) {
          if (o) {
            removed.push(o);
            if (active.has(o)) touchesSelection = true;
          }
          const n = new DrawingObject(d);
          this.objs.set(d.id, n);
          added.push(n);
        } else if (o.modelTransform !== d.transform) {
          updates.push([o, d.transform]);
          if (active.has(o)) touchesSelection = true;
        }
      }

      // Mexer num objeto que está dentro de uma ActiveSelection corrompe a posição:
      // desfaz a seleção, aplica as matrizes e recria a seleção depois.
      if (touchesSelection) this.canvas.discardActiveObject();
      for (const o of removed) {
        this.canvas.remove(o);
        if (this.objs.get(o.drawingId) === o) this.objs.delete(o.drawingId);
      }
      for (const [o, m] of updates) o.applyModel(m);
      for (const o of added) this.canvas.add(o);

      // ordem de empilhamento = ordem do documento
      doc.drawings.forEach((d, i) => {
        const o = this.objs.get(d.id)!;
        if (this.canvas.getObjects()[i] !== o) this.canvas.moveObjectTo(o, i);
      });

      this.applySelection(this.store.state.selection);
      this.updateArea();
      this.canvas.requestRenderAll();
    } finally {
      this.syncing = false;
    }
  }

  private applySelection(ids: readonly DrawingId[]): void {
    const current = this.activeDrawings().map((o) => o.drawingId);
    if (current.length === ids.length && current.every((id) => ids.includes(id))) return;
    this.canvas.discardActiveObject();
    const objs = ids.map((id) => this.objs.get(id)).filter((o): o is DrawingObject => !!o);
    if (objs.length === 1) this.canvas.setActiveObject(objs[0]);
    else if (objs.length > 1) this.canvas.setActiveObject(new ActiveSelection(objs, { canvas: this.canvas }));
  }

  private pushSelection(): void {
    if (this.syncing) return;
    this.store.setSelection(this.activeDrawings().map((o) => o.drawingId));
  }

  private onModified(action: string | undefined): void {
    const updates = new Map<DrawingId, Mat2D>();
    for (const o of this.activeDrawings()) {
      const m = modelMatrixFromFabric(o.calcTransformMatrix() as unknown as Mat2D, o.localBBox);
      // já marca como aplicada: o sync que vem do commit não precisa mexer neste objeto
      o.modelTransform = m;
      updates.set(o.drawingId, m);
    }
    if (updates.size === 0) return;
    this.store.commit(ACTION_LABEL[action ?? ""] ?? "Transformar", (doc) => setTransforms(doc, updates));
  }

  /** Verificação exata (geometria achatada) depois de cada mudança no documento. */
  private updateArea(): void {
    const { profile } = this.store.state;
    let count = 0;
    for (const d of this.store.doc.drawings) {
      const out = outside(machineBBox(d, this.H, profile.tolerance.chordMm), profile.workArea);
      this.objs.get(d.id)?.setOutOfArea(out);
      if (out) count++;
    }
    this.onOutOfArea(count);
  }

  /** Durante o arraste: aproximação pelos cantos da caixa do objeto (um pouco conservadora se girado). */
  private liveAreaCheck(): void {
    const area = this.store.state.profile.workArea;
    const F = sceneToMachineMatrix(this.H);
    for (const o of this.activeDrawings()) {
      const m = multiply(F, o.calcTransformMatrix() as unknown as Mat2D);
      const w = o.width / 2;
      const hh = o.height / 2;
      const pts = [apply(m, { x: -w, y: -hh }), apply(m, { x: w, y: -hh }), apply(m, { x: w, y: hh }), apply(m, { x: -w, y: hh })];
      const b = {
        minX: Math.min(...pts.map((p) => p.x)),
        minY: Math.min(...pts.map((p) => p.y)),
        maxX: Math.max(...pts.map((p) => p.x)),
        maxY: Math.max(...pts.map((p) => p.y)),
      };
      o.setOutOfArea(outside(b, area));
    }
  }

  /**
   * Cache de bitmap do Fabric só durante a interação (arrastar, girar, escalar, pan).
   * Ligado o tempo todo, desenhos grandes ficariam borrados no zoom (o Fabric limita o
   * tamanho do cache); desligado durante o gesto, cada quadro redesenharia todos os segmentos.
   */
  setCaching(on: boolean): void {
    let changed = false;
    for (const o of this.objs.values()) {
      if (o.objectCaching === on) continue;
      o.objectCaching = on;
      o.set("dirty", true);
      changed = true;
    }
    if (changed && !on) this.canvas.requestRenderAll();
  }

  objectFor(id: DrawingId): FabricObject | undefined {
    return this.objs.get(id);
  }
}
