import { ActiveSelection, type Canvas, type FabricObject } from "fabric";
import { machineRotationDeg, modelMatrixFromFabric, sceneToMachineMatrix } from "../core/coords";
import { expandToGroups, machineBBox, setTransforms, tableItems, type Drawing, type DrawingId, type PlotDocument } from "../core/document";
import { apply, multiply, type Mat2D } from "../core/geometry/mat2d";
import type { BBox } from "../core/geometry/path";
import type { Store } from "../core/store";
import { applyHandlePolicy, DrawingObject } from "./drawingObject";
import { handlePolicy, onRatioLockChange, proportionLocked, publishTurning, ratioLocked, shownTurn } from "./gestures";

const ACTION_LABEL: Record<string, string> = {
  drag: "Mover",
  rotate: "Girar",
  scale: "Redimensionar",
  scaleX: "Redimensionar",
  scaleY: "Redimensionar",
};

const EPS = 0.005; // mesma folga do checkBounds

/** Fora da zona de desenho (a folha)? Quem sai dela não pode ser plotado (docs/REGRAS_GCODE.md). */
function outside(b: BBox, zone: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  return b.minX < zone.minX - EPS || b.minY < zone.minY - EPS || b.maxX > zone.maxX + EPS || b.maxY > zone.maxY + EPS;
}

/**
 * Sincroniza o documento (fonte da verdade) com o Fabric (só a vista).
 * - modelo → Fabric: sync() cria, remove e reposiciona objetos, preservando a seleção.
 * - Fabric → modelo: no fim de cada gesto (object:modified), a matriz de cada objeto
 *   (calcTransformMatrix, que inclui a seleção múltipla) vira um commit no store.
 *
 * Um objeto do Fabric é um ITEM da mesa (`tableItems`): um desenho solto, ou um conjunto inteiro (as
 * camadas de uma mesma imagem). O gesto num conjunto grava a mesma matriz em todas as camadas, numa
 * entrada só do histórico. A seleção do store continua sendo uma lista de desenhos, sempre com os
 * conjuntos inteiros.
 */
export class CanvasView {
  /** O objeto de cada desenho (as camadas de um conjunto apontam para o mesmo objeto) */
  private readonly objs = new Map<DrawingId, DrawingObject>();
  private syncing = false;

  constructor(
    private readonly canvas: Canvas,
    private readonly store: Store,
    private readonly onOutOfArea: (count: number) => void = () => {},
  ) {
    canvas.on("object:modified", (e) => this.onModified(e.action));
    const push = () => {
      // as alças valem para o que acabou de ser selecionado (inclusive a seleção que o próprio Fabric monta ao arrastar)
      this.applyHandles();
      this.pushSelection();
    };
    canvas.on("selection:created", push);
    canvas.on("selection:updated", push);
    canvas.on("selection:cleared", push);
    const live = () => this.liveAreaCheck();
    canvas.on("object:moving", live);
    canvas.on("object:scaling", live);
    canvas.on("object:rotating", (e) => {
      live();
      this.tellAngle(e.target, e.e);
    });
    // durante um gesto, cada quadro redesenha tudo: com cache, desenhos grandes viram uma cópia de bitmap
    canvas.on("before:transform", () => {
      this.applyHandles();
      this.setCaching(true);
    });
    canvas.on("mouse:up", () => {
      this.setCaching(false);
      publishTurning(undefined);
    });
    onRatioLockChange(() => {
      this.applyHandles();
      this.canvas.requestRenderAll();
    });
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

  /** Os objetos que existem agora, sem repetir (um conjunto aparece uma vez). */
  private objects(): Set<DrawingObject> {
    return new Set(this.objs.values());
  }

  /** Reconcilia o Fabric com o documento. */
  sync(): void {
    this.syncing = true;
    try {
      const doc = this.store.doc;
      const byId = new Map(doc.drawings.map((d) => [d.id, d]));
      const active = new Set(this.activeDrawings());
      let touchesSelection = false;

      const keep = new Set<DrawingObject>();
      const order: DrawingObject[] = [];
      const added: DrawingObject[] = [];
      const updates: [DrawingObject, Mat2D][] = [];
      const next = new Map<DrawingId, DrawingObject>();
      for (const ids of tableItems(doc)) {
        const members = ids.map((id) => byId.get(id)) as Drawing[];
        let o = this.objs.get(ids[0]);
        // mudou a geometria (traços apagados) ou as camadas do conjunto: o objeto é refeito
        if (o && (keep.has(o) || !o.shows(members))) o = undefined;
        if (!o) {
          o = new DrawingObject(members);
          added.push(o);
        } else {
          if (o.modelTransform !== members[0].transform) {
            updates.push([o, members[0].transform]);
            if (active.has(o)) touchesSelection = true;
          }
          o.setPens(members);
        }
        keep.add(o);
        order.push(o);
        for (const id of ids) next.set(id, o);
      }
      const removed = [...this.objects()].filter((o) => !keep.has(o));
      if (removed.some((o) => active.has(o))) touchesSelection = true;

      // Mexer num objeto que está dentro de uma ActiveSelection corrompe a posição:
      // desfaz a seleção, aplica as matrizes e recria a seleção depois.
      if (touchesSelection) this.canvas.discardActiveObject();
      for (const o of removed) this.canvas.remove(o);
      this.objs.clear();
      for (const [id, o] of next) this.objs.set(id, o);
      for (const [o, m] of updates) o.applyModel(m);
      for (const o of added) this.canvas.add(o);

      // ordem de empilhamento = ordem do documento
      order.forEach((o, i) => {
        if (this.canvas.getObjects()[i] !== o) this.canvas.moveObjectTo(o, i);
      });

      this.applySelection(this.store.state.selection);
      this.applyHandles();
      this.updateArea();
      this.canvas.requestRenderAll();
    } finally {
      this.syncing = false;
    }
  }

  /** Os objetos dos desenhos indicados, sem repetir e na ordem da mesa. */
  private objectsOf(ids: readonly DrawingId[]): DrawingObject[] {
    const want = new Set(ids.map((id) => this.objs.get(id)).filter((o): o is DrawingObject => !!o));
    return this.canvas.getObjects().filter((o): o is DrawingObject => o instanceof DrawingObject && want.has(o));
  }

  private applySelection(ids: readonly DrawingId[]): void {
    const wanted = this.objectsOf(ids);
    const current = this.activeDrawings();
    if (current.length === wanted.length && current.every((o) => wanted.includes(o))) return;
    this.canvas.discardActiveObject();
    if (wanted.length === 1) this.canvas.setActiveObject(wanted[0]);
    else if (wanted.length > 1) this.canvas.setActiveObject(new ActiveSelection(wanted, { canvas: this.canvas }));
  }

  /**
   * Proporção travada ou solta (ver `gestures.ts`): com ela travada os cantos aumentam e diminuem o desenho
   * por igual e as alças que esticam um lado só somem. Vale para o que está selecionado agora.
   */
  private applyHandles(): void {
    const active = this.activeDrawings();
    const rot = active.length === 1 ? machineRotationDeg(active[0].modelTransform) : undefined;
    const policy = handlePolicy(proportionLocked(ratioLocked(), rot, active.length));
    this.canvas.uniformScaling = policy.uniform;
    this.canvas.uniScaleKey = policy.toggleKey;
    const target = this.canvas.getActiveObject();
    if (target) applyHandlePolicy(target, policy);
  }

  /** Durante o giro: o ângulo, como o painel mostra, para a etiqueta ao lado do mouse e o campo "Ângulo". */
  private tellAngle(target: FabricObject, ev: Event): void {
    const deg =
      target instanceof DrawingObject
        ? machineRotationDeg(modelMatrixFromFabric(target.calcTransformMatrix() as unknown as Mat2D, target.localBBox))
        : shownTurn(target.angle); // vários juntos: quanto o conjunto girou
    const p = "clientX" in ev ? (ev as MouseEvent) : (ev as TouchEvent).touches?.[0];
    publishTurning({ deg, clientX: p?.clientX ?? 0, clientY: p?.clientY ?? 0 });
  }

  private pushSelection(): void {
    if (this.syncing) return;
    // um conjunto entra sempre inteiro na seleção
    const ids = this.activeDrawings().flatMap((o) => o.drawingIds);
    this.store.setSelection(expandToGroups(this.store.doc, ids));
  }

  private onModified(action: string | undefined): void {
    const updates = new Map<DrawingId, Mat2D>();
    for (const o of this.activeDrawings()) {
      const m = modelMatrixFromFabric(o.calcTransformMatrix() as unknown as Mat2D, o.localBBox);
      // já marca como aplicada: o sync que vem do commit não precisa mexer neste objeto
      o.modelTransform = m;
      // todas as camadas do conjunto recebem a MESMA matriz: é isso que as mantém registradas
      for (const id of o.drawingIds) updates.set(id, m);
    }
    if (updates.size === 0) return;
    this.store.commit(ACTION_LABEL[action ?? ""] ?? "Transformar", (doc) => setTransforms(doc, updates));
  }

  /** Verificação exata (geometria achatada) depois de cada mudança no documento. Um conjunto está fora se qualquer camada estiver. */
  private updateArea(): void {
    const { profile } = this.store.state;
    const byId = new Map(this.store.doc.drawings.map((d) => [d.id, d]));
    let count = 0;
    for (const o of this.objects()) {
      const out = o.drawingIds.some((id) => {
        const d = byId.get(id);
        return !!d && outside(machineBBox(d, this.H, profile.tolerance.chordMm), profile.drawZone);
      });
      o.setOutOfArea(out);
      if (out) count++;
    }
    this.onOutOfArea(count);
  }

  /** Durante o arraste: aproximação pelos cantos da caixa do objeto (um pouco conservadora se girado). */
  private liveAreaCheck(): void {
    const area = this.store.state.profile.drawZone;
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
    for (const o of this.objects()) {
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
