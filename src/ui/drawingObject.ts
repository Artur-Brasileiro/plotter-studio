import { ActiveSelection, FabricObject, InteractiveFabricObject, util, type TMat2D } from "fabric";
import { fabricMatrixFromModel } from "../core/coords";
import type { Drawing, DrawingId } from "../core/document";
import type { Mat2D } from "../core/geometry/mat2d";
import { bboxCenter, type BBox, type Geometry } from "../core/geometry/path";
import { isDark } from "../core/color";
import { paperColor } from "./paper";

const ACCENT = "#1b4fa8"; // azul de planta (--plan em style.css)

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
 * no objeto, porque o strokeWidth do Fabric entra no cálculo da caixa), com a largura real da
 * caneta na escala da mesa, e nunca menos de ~1,25 px para não sumir de longe.
 */
export class DrawingObject extends FabricObject {
  static type = "PlotterDrawing";
  /** Com a pré-visualização do caminho ligada, os desenhos ficam claros para o caminho aparecer. */
  static dimmed = false;
  /** Largura e cor da caneta de um desenho: ele aparece na mesa como vai sair no papel. */
  static penStyle: (penId: string | undefined) => { widthMm: number; color: string } = () => ({ widthMm: 0.4, color: "#10151f" });

  readonly drawingId: DrawingId;
  readonly geometry: Geometry;
  readonly localBBox: BBox;
  /** Caneta do desenho (atualizada no sync) */
  penId: string | undefined;
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
    this.penId = d.penId;
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
    const dpr = window.devicePixelRatio || 1;
    const pen = DrawingObject.penStyle(this.penId);
    const penPx = pen.widthMm * (this.canvas?.getZoom() ?? 1) * dpr;
    ctx.lineWidth = Math.max(1.25 * dpr, penPx) / scale;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // apagado (com o caminho por cima): quase da cor do papel, para o caminho aparecer
    const dim = isDark(paperColor()) ? "#4b5160" : "#c5cbd6";
    ctx.strokeStyle = this.outOfArea ? "#c0362c" : DrawingObject.dimmed ? dim : pen.color;
    ctx.stroke(pathFor(this.geometry));
    ctx.restore();
  }
}
