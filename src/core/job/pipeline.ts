import type { PlotDocument } from "../document";
import { polylineLength } from "../geometry/simplify";
import { dist, type Vec } from "../geometry/vec";
import type { MachineProfile } from "../machine";
import type { JobSettings } from "../store";
import { checkBounds, checkZone } from "./bounds";
import { bridgeIsHidden, buildInkMap, coveredByOthers } from "./inkmap";
import { capDescents, keepOrder, orderStrokes, travelLength } from "./optimize";
import { scheduleJob } from "./schedule";
import { assignFeeds } from "./speed";
import { documentToStrokes } from "./strokes";
import type { JobPlan, Stroke } from "./types";

/** REGRAS_GCODE.md, regra 4: traço com menos de 3× a largura da caneta, totalmente coberto por outro, some. */
const HIDDEN_MAX_PEN_WIDTHS = 3;

/**
 * O pipeline inteiro: documento → traços em mm da máquina → área e zona → tira o que fica escondido
 * → ordem com emendas → corte das descidas longas → velocidades → agenda (servo, checkpoints, partes).
 * `start` é onde a caneta está (v1: a posição final do perfil, para onde a máquina volta; v2: a WPos).
 */
export function planJob(doc: PlotDocument, profile: MachineProfile, job: JobSettings, opts: { start?: Vec } = {}): JobPlan {
  const start = opts.start ?? profile.gcode.finalPosition;
  const end = profile.gcode.finalPosition;
  const all = documentToStrokes(doc, profile);
  const area = checkBounds(all, profile.workArea);
  const violations = [...area, ...checkZone(all, profile.drawZone, new Set(area.map((v) => v.drawingId)))];
  const pen = profile.pen.widthMm;

  const unoptimized = keepOrder(all, pen);
  let strokes: readonly Stroke[] = all;
  let hiddenDropped = 0;
  let ordered = unoptimized;
  if (job.optimize) {
    const ink = profile.join.overInk ? buildInkMap(all, pen) : undefined;
    if (ink) {
      // o índice no mapa é o do traço em `all`, então a decisão vem antes de filtrar
      const keep = all.filter((s, i) => !(polylineLength(s.points) < HIDDEN_MAX_PEN_WIDTHS * pen && coveredByOthers(ink, i, s.points)));
      hiddenDropped = all.length - keep.length;
      strokes = keep;
    }
    ordered = orderStrokes(strokes, {
      start,
      joinGapMm: pen,
      allowReverse: true,
      rotateClosed: true,
      searchMm: profile.join.searchMm,
      bridgeHidden: ink ? (a, b) => bridgeIsHidden(ink, a, b, pen) : undefined,
    });
  }
  const capped = capDescents(ordered, profile.servo.maxDescentMm);
  const planned = capped.map((s) => assignFeeds(s, job, profile));
  const sched = scheduleJob(planned, start, end, profile);

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

  return {
    strokes: planned,
    descents: sched.descents,
    start,
    end,
    violations,
    stats: {
      drawMm: drawMm + joinInkMm,
      travelMm: travelLength(capped, start, end),
      travelMmUnoptimized: travelLength(unoptimized, start, end),
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
