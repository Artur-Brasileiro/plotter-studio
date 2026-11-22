import type { PlotDocument } from "../document";
import { polylineLength } from "../geometry/simplify";
import { dist, type Vec } from "../geometry/vec";
import { penOf, type MachineProfile, type Pen } from "../machine";
import type { JobSettings } from "../store";
import { checkBounds, checkZone } from "./bounds";
import { bridgeIsHidden, createInkMap, stampStroke, strokeCovered } from "./inkmap";
import { layersOf, registrationCrosses, usesRegistration, type Layer } from "./layers";
import { capDescents, keepOrder, orderStrokes, travelLength } from "./optimize";
import { scheduleJob } from "./schedule";
import { assignFeeds } from "./speed";
import { documentToStrokes } from "./strokes";
import type { BoundsViolation, JobPlan, OrderedStroke, PlanLayer, Stroke } from "./types";

/** REGRAS_GCODE.md, regra 4: traço com menos de 3× a largura da caneta, totalmente coberto por outro, some. */
const HIDDEN_MAX_PEN_WIDTHS = 3;

export interface PlanOptions {
  /** Onde a caneta está (padrão: a posição final do perfil, para onde a máquina volta) */
  readonly start?: Vec;
  /** A camada a planejar (id da caneta). Sem valor: a primeira na ordem de plotagem. */
  readonly penId?: string;
}

/**
 * O pipeline inteiro de UMA camada (uma caneta): documento → traços em mm da máquina → área e zona →
 * tira o que fica escondido → ordem com emendas → cruzes de registro → corte das descidas longas →
 * correção da ponta da caneta → velocidades → agenda (servo, checkpoints, partes).
 */
export function planJob(doc: PlotDocument, profile: MachineProfile, job: JobSettings, opts: PlanOptions = {}): JobPlan {
  const layers = layersOf(doc, profile);
  const layer = layers.find((l) => l.pen.id === opts.penId) ?? layers[0];
  const all = documentToStrokes(doc, profile);
  return planLayer(doc, all, violationsOf(all, profile), layer, layers.length, profile, job, opts.start);
}

/** Todas as camadas do documento, na ordem de plotagem (cor → fina → grossa). Documento vazio: nenhuma. */
export function planLayers(doc: PlotDocument, profile: MachineProfile, job: JobSettings, opts: { start?: Vec } = {}): JobPlan[] {
  const layers = layersOf(doc, profile);
  if (layers.length === 0) return [];
  const all = documentToStrokes(doc, profile);
  const violations = violationsOf(all, profile);
  return layers.map((layer) => planLayer(doc, all, violations, layer, layers.length, profile, job, opts.start));
}

/** Área e zona valem para o documento inteiro: um desenho fora da folha trava todas as camadas. */
function violationsOf(all: readonly Stroke[], profile: MachineProfile): BoundsViolation[] {
  const area = checkBounds(all, profile.workArea);
  return [...area, ...checkZone(all, profile.drawZone, new Set(area.map((v) => v.drawingId)))];
}

function planLayer(
  doc: PlotDocument,
  all: readonly Stroke[],
  docViolations: readonly BoundsViolation[],
  layer: Layer | undefined,
  layerCount: number,
  profile: MachineProfile,
  job: JobSettings,
  startOpt: Vec | undefined,
): JobPlan {
  const start = startOpt ?? profile.gcode.finalPosition;
  const end = profile.gcode.finalPosition;
  const penObj: Pen = layer?.pen ?? penOf(profile, undefined);
  const pen = penObj.widthMm;
  const offset: Vec = { x: penObj.offsetX, y: penObj.offsetY };
  const registration = layer !== undefined && usesRegistration(profile, layerCount);

  // só os traços dos desenhos desta caneta
  let mine: readonly Stroke[] = all;
  if (layerCount > 1) {
    const ids = new Set(doc.drawings.filter((d) => penOf(profile, d.penId).id === penObj.id).map((d) => d.id));
    mine = all.filter((s) => ids.has(s.drawingId));
  }

  const crosses = registration ? registrationCrosses(profile) : undefined;
  // a ordem começa de onde a 1ª cruz termina
  const orderStart = crosses ? crosses.first.points[crosses.first.points.length - 1] : start;

  const wrap = (body: readonly OrderedStroke[]): OrderedStroke[] => (crosses ? [crosses.first, ...body, crosses.last] : [...body]);
  const unoptimized = wrap(keepOrder(mine, pen));
  let strokes: readonly Stroke[] = mine;
  let hiddenDropped = 0;
  let ordered = unoptimized;
  if (job.optimize) {
    const ink = profile.join.overInk ? createInkMap(mine, pen) : undefined;
    if (ink) {
      // Regra 4, um traço de cada vez: o mapa só recebe a tinta do que FICA. Assim dois tracinhos que
      // se cobrem um ao outro não somem os dois, e nenhuma emenda passa por cima de tinta retirada.
      const lengths = mine.map((s) => polylineLength(s.points));
      const short = (i: number) => lengths[i] < HIDDEN_MAX_PEN_WIDTHS * pen;
      mine.forEach((s, i) => {
        if (!short(i)) stampStroke(ink, s.points);
      });
      // dos curtos, os maiores primeiro: o que já está coberto pelo que ficou, sai
      const dropped = new Set<number>();
      const candidates = mine.map((_, i) => i).filter(short).sort((a, b) => lengths[b] - lengths[a] || a - b);
      for (const i of candidates) {
        if (strokeCovered(ink, mine[i].points)) dropped.add(i);
        else stampStroke(ink, mine[i].points);
      }
      hiddenDropped = dropped.size;
      if (dropped.size) strokes = mine.filter((_, i) => !dropped.has(i));
    }
    ordered = wrap(
      orderStrokes(strokes, {
        start: orderStart,
        joinGapMm: pen,
        allowReverse: true,
        rotateClosed: true,
        searchMm: profile.join.searchMm,
        bridgeHidden: ink ? (a, b) => bridgeIsHidden(ink, a, b, pen) : undefined,
      }),
    );
  }
  // Correção da ponta (seção 7): a caneta risca `offset` além de onde a máquina acha que está, então a
  // camada INTEIRA (cruzes incluídas) é comandada com a correção contrária.
  const shifted = offset.x === 0 && offset.y === 0 ? (s: OrderedStroke) => s : (s: OrderedStroke) => ({ ...s, points: s.points.map((p) => ({ x: p.x - offset.x, y: p.y - offset.y })) });
  // Regra 5: "~2 min por descida". O limite em mm foi medido a F500 (o F fixo do perfil): num trabalho
  // mais lento a descida encurta na mesma proporção, para o tempo com a caneta embaixo não crescer.
  const slower = job.speedMode === "fixed" && job.fixedFeed > 0 ? Math.min(1, job.fixedFeed / profile.feed.fixed) : 1;
  const capped = capDescents(ordered, profile.servo.maxDescentMm * slower).map(shifted);
  const planned = capped.map((s) => assignFeeds(s, job, profile));
  const sched = scheduleJob(planned, start, end, profile, job.speedMode === "fixed" ? job.fixedFeed : undefined);

  // com a correção, um desenho colado na borda do curso pode passar dela
  const violations = [...docViolations];
  if (offset.x !== 0 || offset.y !== 0) {
    const known = new Set(violations.filter((v) => v.kind === "area").map((v) => v.drawingId));
    for (const v of checkBounds(capped, profile.workArea)) if (!known.has(v.drawingId)) violations.push(v);
  }

  let drawMm = 0;
  let segments = 0;
  let joinInkMm = 0;
  let prevEnd: Vec | undefined;
  for (const s of planned) {
    if (s.points.length === 0) continue;
    drawMm += polylineLength(s.points);
    segments += s.feeds.length;
    if (s.joinedToPrevious && prevEnd) joinInkMm += dist(prevEnd, s.points[0]);
    prevEnd = s.points[s.points.length - 1];
  }

  const planLayerInfo: PlanLayer = {
    penId: penObj.id,
    penName: penObj.name,
    penWidthMm: pen,
    color: penObj.color,
    index: layer?.index ?? 0,
    count: Math.max(1, layerCount),
    offset,
    registration,
  };

  return {
    strokes: planned,
    descents: sched.descents,
    start,
    end,
    violations,
    layer: planLayerInfo,
    job,
    stats: {
      drawMm: drawMm + joinInkMm,
      travelMm: travelLength(capped, start, end),
      travelMmUnoptimized: travelLength(unoptimized.map(shifted), start, end),
      penLifts: sched.descents.length,
      segments,
      estimate: sched.estimate,
      strokeStartTimesS: sched.strokeStartTimesS,
      joinInkMm,
      hiddenDropped,
      overloads: sched.overloads,
      checkpoints: sched.checkpoints,
      parts: sched.parts,
    },
  };
}
