import { createDrawing, type Drawing } from "../document";
import { IDENTITY } from "../geometry/mat2d";
import type { Geometry } from "../geometry/path";
import { polylineLength } from "../geometry/simplify";
import { DEFAULT_PROFILE, type MachineProfile } from "../machine";
import { scheduleJob } from "./schedule";
import type { JobPlan, PlannedStroke } from "./types";

/** Só para testes: desenho feito de polilinhas dadas em mm da MÁQUINA (a cena tem o Y para baixo). */
export function machineDrawing(id: string, polys: [number, number][][], penId?: string, workHeight = DEFAULT_PROFILE.workArea.height): Drawing {
  const geometry: Geometry = {
    subpaths: polys.map((pts) => ({
      start: { x: pts[0][0], y: workHeight - pts[0][1] },
      segments: pts.slice(1).map(([x, y]) => ({ kind: "line" as const, to: { x, y: workHeight - y } })),
      closed: false,
    })),
  };
  return createDrawing(id, `${id}.svg`, geometry, IDENTITY, penId);
}

/** Só para testes: monta traços e planos sem passar pelo documento. */
export function stroke(pts: [number, number][], o: { joined?: boolean; relift?: boolean; feeds?: number[]; closed?: boolean } = {}): PlannedStroke {
  const feeds = o.feeds ?? pts.slice(1).map(() => 500);
  return {
    points: pts.map(([x, y]) => ({ x, y })),
    closed: o.closed ?? false,
    drawingId: "d",
    joinedToPrevious: o.joined ?? false,
    relift: o.relift,
    feeds,
    classes: feeds.map(() => "straight" as const),
  };
}

export function makePlan(strokes: PlannedStroke[], profile: MachineProfile = DEFAULT_PROFILE): JobPlan {
  const start = { x: 0, y: 0 };
  const s = scheduleJob(strokes, start, start, profile);
  return {
    strokes,
    descents: s.descents,
    start,
    end: start,
    violations: [],
    stats: {
      drawMm: strokes.reduce((a, st) => a + polylineLength(st.points), 0),
      travelMm: 0,
      travelMmUnoptimized: 0,
      penLifts: s.descents.length,
      segments: strokes.reduce((a, st) => a + st.feeds.length, 0),
      estimate: s.estimate,
      strokeStartTimesS: s.strokeStartTimesS,
      joinInkMm: 0,
      retraceMm: 0,
      hiddenDropped: 0,
      overloads: s.overloads,
      checkpoints: s.checkpoints,
      parts: s.parts,
    },
  };
}
