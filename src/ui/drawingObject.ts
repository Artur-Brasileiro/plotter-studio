import { ActiveSelection, FabricObject, InteractiveFabricObject, util, type TMat2D } from "fabric";
import { isDark } from "../core/color";
import { fabricMatrixFromModel } from "../core/coords";
import type { Drawing, DrawingId } from "../core/document";
import type { Mat2D } from "../core/geometry/mat2d";
import { bboxCenter, emptyBBox, unionBBox, type BBox, type Geometry } from "../core/geometry/path";
import { ROTATE_SNAP, type HandlePolicy } from "./gestures";
import { paperColor } from "./paper";

const ACCENT = "#1b4fa8"; // azul de planta (--plan em style.css)

/**
 * Padrões de todos os objetos interativos (inclusive a seleção múltipla):
 * arrastar uma alça nunca espelha (lockScalingFlip) nem distorce (skew), e ao girar o objeto gruda nos
 * ângulos redondos (ROTATE_SNAP).
 */
const SAFE_DEFAULTS = {
  lockScalingFlip: true,
  lockSkewingX: true,
  lockSkewingY: true,
  snapAngle: ROTATE_SNAP.step,
  snapThreshold: ROTATE_SNAP.within,
  borderColor: ACCENT,
  cornerColor: ACCENT,
  cornerStrokeColor: "#fff",
  transparentCorners: false,
  cornerSize: 9,
};
InteractiveFabricObject.ownDefaults = { ...InteractiveFabricObject.ownDefaults, ...SAFE_DEFAULTS };
ActiveSelection.ownDefaults = { ...ActiveSelection.ownDefaults, ...SAFE_DEFAULTS };

/** Mostra ou esconde, no objeto selecionado, as alças do meio de cada lado (as que esticam numa direção só). */
export function applyHandlePolicy(target: FabricObject, policy: HandlePolicy): void {
  target.setControlsVisibility({ ml: policy.sideHandles, mr: policy.sideHandles, mt: policy.sideHandles, mb: policy.sideHandles });
}

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

/** Uma camada dentro do objeto da mesa: um desenho do documento, com a caneta dele. */
interface Part {
  readonly id: DrawingId;
  readonly geometry: Geometry;
  penId: string | undefined;
}

/** A caixa de um item da mesa: a união das caixas das camadas (todas no mesmo sistema de coordenadas). */
export function unionLocalBBox(members: readonly Drawing[]): BBox {
  let b = emptyBBox();
  for (const d of members) b = unionBBox(b, d.localBBox);
  return b;
}

/**
 * A "vista" de um item da mesa no Fabric: um desenho solto, ou um CONJUNTO (as camadas de uma mesma
 * imagem, uma por caneta), que na mesa é uma coisa só. Mover, girar ou redimensionar o objeto vale para
 * todas as camadas, e por isso elas nunca desencontram.
 *
 * O traço é desenhado à mão em _render (strokeWidth 0 no objeto, porque o strokeWidth do Fabric entra no
 * cálculo da caixa), cada camada com a cor e a largura real da caneta dela na escala da mesa, e nunca
 * menos de ~1,25 px para não sumir de longe.
 */
export class DrawingObject extends FabricObject {
  static type = "PlotterDrawing";
  /** Com a pré-visualização do caminho ligada, os desenhos ficam claros para o caminho aparecer. */
  static dimmed = false;
  /** Largura e cor da caneta de um desenho: ele aparece na mesa como vai sair no papel. */
  static penStyle: (penId: string | undefined) => { widthMm: number; color: string } = () => ({ widthMm: 0.4, color: "#10151f" });

  /** Os desenhos que este objeto mostra (um só, ou as camadas de um conjunto), na ordem do documento */
  readonly drawingIds: readonly DrawingId[];
  private readonly parts: Part[];
  /** A união das caixas das camadas, no sistema de coordenadas delas */
  readonly localBBox: BBox;
  /** Matriz do modelo aplicada por último (comparada por referência no sync) */
  modelTransform: Mat2D;
  outOfArea = false;

  constructor(members: readonly Drawing[]) {
    const b = unionLocalBBox(members);
    super({
      width: Math.max(b.maxX - b.minX, MIN_SIZE),
      height: Math.max(b.maxY - b.minY, MIN_SIZE),
      strokeWidth: 0,
      fill: "",
      stroke: "",
      objectCaching: false,
      ...SAFE_DEFAULTS,
    });
    this.drawingIds = members.map((d) => d.id);
    this.parts = members.map((d) => ({ id: d.id, geometry: d.geometry, penId: d.penId }));
    this.localBBox = b;
    this.modelTransform = members[0].transform;
    this.applyModel(members[0].transform);
  }

  /** O primeiro (ou único) desenho deste objeto. */
  get drawingId(): DrawingId {
    return this.drawingIds[0];
  }

  /** Este objeto ainda mostra exatamente estes desenhos, com estas geometrias? (senão é refeito) */
  shows(members: readonly Drawing[]): boolean {
    return members.length === this.parts.length && members.every((d, i) => this.parts[i].id === d.id && this.parts[i].geometry === d.geometry);
  }

  /** Atualiza a caneta de cada camada (trocar de caneta não refaz o objeto). */
  setPens(members: readonly Drawing[]): void {
    members.forEach((d, i) => {
      if (this.parts[i].penId === d.penId) return;
      this.parts[i].penId = d.penId;
      this.set("dirty", true);
    });
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
    const zoom = this.canvas?.getZoom() ?? 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // apagado (com o caminho por cima): quase da cor do papel, para o caminho aparecer
    const dim = isDark(paperColor()) ? "#4b5160" : "#c5cbd6";
    for (const part of this.parts) {
      const pen = DrawingObject.penStyle(part.penId);
      ctx.lineWidth = Math.max(1.25 * dpr, pen.widthMm * zoom * dpr) / scale;
      ctx.strokeStyle = this.outOfArea ? "#c0362c" : DrawingObject.dimmed ? dim : pen.color;
      ctx.stroke(pathFor(part.geometry));
    }
    ctx.restore();
  }
}
