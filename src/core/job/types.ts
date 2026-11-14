import type { DrawingId } from "../document";
import type { BBox } from "../geometry/path";
import type { Vec } from "../geometry/vec";

export interface Stroke {
  /** mm da MÁQUINA; 1 ponto = "ponto" (desce e sobe a caneta) */
  readonly points: readonly Vec[];
  /** closed ⇒ points[0] e points[n−1] são o mesmo ponto */
  readonly closed: boolean;
  readonly drawingId: DrawingId;
}

export interface OrderedStroke extends Stroke {
  /** A ponta anterior está a menos de joinGapMm: liga com G1, sem levantar a caneta */
  readonly joinedToPrevious: boolean;
}

export type FeedClass = "straight" | "curve" | "tight";

export interface PlannedStroke extends OrderedStroke {
  /** mm/min, um por segmento (points.length − 1) */
  readonly feeds: readonly number[];
  /** Para colorir a pré-visualização */
  readonly classes: readonly FeedClass[];
}

export interface BoundsViolation {
  readonly drawingId: DrawingId;
  readonly bbox: BBox;
  /** Ex.: "sai 12,3 mm à direita" */
  readonly message: string;
}

export interface TimeEstimate {
  readonly totalS: number;
  readonly drawS: number;
  readonly travelS: number;
  readonly penS: number;
}

export interface JobStats {
  readonly drawMm: number;
  readonly travelMm: number;
  /** Deslocamento na ordem do documento, para mostrar a economia */
  readonly travelMmUnoptimized: number;
  readonly penLifts: number;
  readonly segments: number;
  readonly estimate: TimeEstimate;
  /** Tempo (s) em que cada traço começa: progresso e "play" */
  readonly strokeStartTimesS: readonly number[];
}

export interface JobPlan {
  readonly strokes: readonly PlannedStroke[];
  /** mm da máquina */
  readonly start: Vec;
  readonly end: Vec;
  readonly violations: readonly BoundsViolation[];
  readonly stats: JobStats;
}
