// Worker do tempo de máquina: roda o MESMO planejador do passo Conferir sobre o traçado que ainda está
// na tela de vetorizar. Num desenho de 15 mil traços isso leva uns 2 segundos, e não pode travar a tela.
import { createDrawing, type PlotDocument } from "../core/document";
import type { Mat2D } from "../core/geometry/mat2d";
import type { Geometry } from "../core/geometry/path";
import { planLayers } from "../core/job/pipeline";
import type { MachineProfile } from "../core/machine";
import type { JobSettings } from "../core/store";

export interface PlanRequest {
  readonly id: number;
  /** Um desenho por caneta, como vão para a mesa */
  readonly drawings: readonly { readonly geometry: Geometry; readonly transform: Mat2D; readonly penId?: string }[];
  readonly profile: MachineProfile;
  readonly job: JobSettings;
}

/** O que a tela mostra de cada camada (caneta), na ordem de plotar. */
export interface LayerTime {
  readonly penId: string;
  readonly penName: string;
  /** Tempo total, com as subidas da caneta e as esperas do servo (s) */
  readonly totalS: number;
  /** Quanto do total é espera para o servo não esquentar (s) */
  readonly waitS: number;
  readonly descents: number;
  readonly drawMm: number;
}

export type PlanReply =
  | { readonly id: number; readonly type: "done"; readonly layers: readonly LayerTime[] }
  | { readonly id: number; readonly type: "error"; readonly message: string };

const ctx = self as unknown as { onmessage: ((e: MessageEvent<PlanRequest>) => void) | null; postMessage(m: PlanReply): void };

ctx.onmessage = (e) => {
  const { id, drawings, profile, job } = e.data;
  try {
    const doc: PlotDocument = { drawings: drawings.map((d, i) => createDrawing(`d${i}`, `d${i}`, d.geometry, d.transform, d.penId)) };
    const layers: LayerTime[] = planLayers(doc, profile, job).map((p) => ({
      penId: p.layer?.penId ?? "",
      penName: p.layer?.penName ?? "",
      totalS: p.stats.estimate.totalS,
      waitS: p.stats.estimate.waitS,
      descents: p.descents.length,
      drawMm: p.stats.drawMm,
    }));
    ctx.postMessage({ id, type: "done", layers });
  } catch (err) {
    ctx.postMessage({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
