import { sceneToMachineMatrix } from "../coords";
import type { PlotDocument } from "../document";
import { flattenGeometry } from "../geometry/flatten";
import { multiply } from "../geometry/mat2d";
import { simplifyPolyline } from "../geometry/simplify";
import type { MachineProfile } from "../machine";
import type { Stroke } from "./types";

/**
 * Documento → traços em mm da MÁQUINA, na ordem do documento.
 * A transformação vem antes do achatamento: a tolerância de corda vale no papel.
 */
export function documentToStrokes(doc: PlotDocument, profile: MachineProfile): Stroke[] {
  const F = sceneToMachineMatrix(profile.workArea.height);
  const t = profile.tolerance;
  const out: Stroke[] = [];
  for (const d of doc.drawings) {
    const m = multiply(F, d.transform);
    for (const pl of flattenGeometry(d.geometry, m, t.chordMm)) {
      const s = simplifyPolyline(pl, { rdpMm: t.simplifyMm, minSegmentMm: t.minSegmentMm });
      out.push({ points: s.points, closed: s.closed, drawingId: d.id });
    }
  }
  return out;
}
