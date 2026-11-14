import type { PlotDocument } from "../document";
import { polylineLength } from "../geometry/simplify";
import { dist, type Vec } from "../geometry/vec";
import type { MachineProfile } from "../machine";
import type { JobSettings } from "../store";
import { checkBounds } from "./bounds";
import { estimateTime } from "./estimate";
import { keepOrder, orderStrokes, travelLength } from "./optimize";
import { assignFeeds } from "./speed";
import { documentToStrokes } from "./strokes";
import type { JobPlan } from "./types";

/**
 * O pipeline inteiro: documento → traços em mm da máquina → área → ordem → velocidades → tempo.
 * `start` é onde a caneta está (v1: a posição final do perfil, para onde a máquina volta; v2: a WPos).
 */
export function planJob(doc: PlotDocument, profile: MachineProfile, job: JobSettings, opts: { start?: Vec } = {}): JobPlan {
  const start = opts.start ?? profile.gcode.finalPosition;
  const end = profile.gcode.finalPosition;
  const strokes = documentToStrokes(doc, profile);
  const violations = checkBounds(strokes, profile.workArea);
  const gap = profile.tolerance.joinGapMm;

  const unoptimized = keepOrder(strokes, gap);
  const ordered = job.optimize ? orderStrokes(strokes, { start, joinGapMm: gap, allowReverse: true, rotateClosed: true }) : unoptimized;
  const planned = ordered.map((s) => assignFeeds(s, job, profile));
  const { estimate, strokeStartTimesS } = estimateTime(planned, start, end, profile);

  let drawMm = 0;
  let segments = 0;
  let penLifts = 0;
  let prevEnd: Vec | undefined;
  for (const s of planned) {
    drawMm += polylineLength(s.points);
    segments += s.feeds.length;
    if (s.joinedToPrevious && prevEnd) drawMm += dist(prevEnd, s.points[0]);
    else penLifts++;
    prevEnd = s.points[s.points.length - 1];
  }

  return {
    strokes: planned,
    start,
    end,
    violations,
    stats: {
      drawMm,
      travelMm: travelLength(ordered, start, end),
      travelMmUnoptimized: travelLength(unoptimized, start, end),
      penLifts,
      segments,
      estimate,
      strokeStartTimesS,
    },
  };
}
