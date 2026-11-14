import { ActiveSelection, FabricObject, InteractiveFabricObject, util, type TMat2D } from "fabric";
import { fabricMatrixFromModel } from "../core/coords";
import type { Drawing, DrawingId } from "../core/document";
import type { Mat2D } from "../core/geometry/mat2d";
import { bboxCenter, type BBox, type Geometry } from "../core/geometry/path";

const ACCENT = "#2f6fd6";

/**
 * Padrões de todos os objetos interativos (inclusive a seleção múltipla):
 * arrastar uma alça nunca espelha (lockScalingFlip) nem distorce (skew).
 */
const SAFE_DEFAULTS = {
  lockScalingFlip: true,
  lockSkewingX: true,
  lockSkewingY: true,
  borderColor: ACCENT,
  cornerColor: ACCENT,
  cornerStrokeColor: "#fff",
  transparentCorners: false,
  cornerSize: 9,
};
InteractiveFabricObject.ownDefaults = { ...InteractiveFabricObject.ownDefaults, ...SAFE_DEFAULTS };
ActiveSelection.ownDefaults = { ...ActiveSelection.ownDefaults, ...SAFE_DEFAULTS };

/** Uma linha vertical tem largura 0; as alças do Fabric dividiriam por zero. */
const MIN_SIZE = 0.5;

const pathCache = new WeakMap<Geometry, Path2D>();

function pathFor(g: Geometry): Path2D {
  let p = pathCache.get(g);
  if (p) return p;
  p = new Path2D();
  for (const sp of g.subpaths) {
    p.moveTo(sp.start.x, sp.start.y);
    for (const s of sp.segments) {
      if (s.kind === "line") p.lineTo(s.to.x, s.to.y);
      else p.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y);
    }
    if (sp.closed) p.closePath();
  }
  pathCache.set(g, p);
  return p;
}

/**
 * A "vista" de um Drawing no Fabric. O traço é desenhado à mão em _render (strokeWidth 0
 * no objeto, porque o strokeWidth do Fabric entra no cálculo da caixa) e tem ~1,5 px
 * em qualquer zoom e escala.
 */
export class DrawingObject extends FabricObject {
  static type = "PlotterDrawing";

  readonly drawingId: DrawingId;
  readonly geometry: Geometry;
  readonly localBBox: BBox;
  /** Matriz do modelo aplicada por último (comparada por referência no sync) */
  modelTransform: Mat2D;
  outOfArea = false;

  constructor(d: Drawing) {
    const b = d.localBBox;
    super({
      width: Math.max(b.maxX - b.minX, MIN_SIZE),
      height: Math.max(b.maxY - b.minY, MIN_SIZE),
      strokeWidth: 0,
      fill: "",
      stroke: "",
      objectCaching: false,
      ...SAFE_DEFAULTS,
    });
    this.drawingId = d.id;
    this.geometry = d.geometry;
    this.localBBox = b;
    this.modelTransform = d.transform;
    this.applyModel(d.transform);
  }

  /** Posiciona o objeto pela matriz do modelo (o Fabric posiciona pelo centro: ver coords.ts). */
  applyModel(m: Mat2D): void {
    this.modelTransform = m;
    util.applyTransformToObject(this, [...fabricMatrixFromModel(m, this.localBBox)] as TMat2D);
    this.setCoords();
  }

  setOutOfArea(v: boolean): void {
    if (v === this.outOfArea) return;
    this.outOfArea = v;
    this.set("dirty", true);
  }

  _render(ctx: CanvasRenderingContext2D): void {
    const c = bboxCenter(this.localBBox);
    const m = ctx.getTransform();
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    ctx.save();
    ctx.translate(-c.x, -c.y);
    ctx.lineWidth = (1.5 * (window.devicePixelRatio || 1)) / scale;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = this.outOfArea ? "#c0392b" : "#1b1b1b";
    ctx.stroke(pathFor(this.geometry));
    ctx.restore();
  }
}
