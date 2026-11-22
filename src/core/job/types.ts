import type { DrawingId } from "../document";
import type { BBox } from "../geometry/path";
import type { Vec } from "../geometry/vec";
import type { JobSettings } from "../store";

export interface Stroke {
  /** mm da MÁQUINA; 1 ponto = "ponto" (desce e sobe a caneta) */
  readonly points: readonly Vec[];
  /** closed ⇒ points[0] e points[n−1] são o mesmo ponto */
  readonly closed: boolean;
  readonly drawingId: DrawingId;
}

export interface OrderedStroke extends Stroke {
  /** Emendado ao anterior: a caneta fica embaixo e a ligação até o início deste traço é desenhada (G1) */
  readonly joinedToPrevious: boolean;
  /**
   * Corte de descida longa (REGRAS_GCODE.md, regra 5): antes de continuar, a caneta sobe e desce
   * no ponto onde o traço anterior parou. Só faz sentido com `joinedToPrevious`.
   */
  readonly relift?: boolean;
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
  /** "area" = fora do curso da máquina (ALARM:2); "zone" = fora da zona de desenho (papel) */
  readonly kind: "area" | "zone";
}

export interface TimeEstimate {
  readonly totalS: number;
  readonly drawS: number;
  readonly travelS: number;
  /** Pausas do servo (G4 depois de M3/M5), aquecimento e checkpoints */
  readonly penS: number;
  /** Descanso do servo: esperas com a caneta em cima para não passar do limite de ciclos */
  readonly waitS: number;
}

/** Uma descida da caneta: do M3 ao M5. Um ou mais traços emendados. */
export interface Descent {
  /** Índices (inclusive) em JobPlan.strokes */
  readonly first: number;
  readonly last: number;
  /** Descanso do servo antes de descer (s), com a caneta em cima */
  readonly waitS: number;
  /** Checkpoint feito logo antes desta descida (1, 2, 3...) */
  readonly checkpoint?: number;
  /** Minutos decorridos até esse checkpoint */
  readonly checkpointMin?: number;
  /** Parte do arquivo (0, 1, 2...) a que a descida pertence */
  readonly part: number;
  /** Instante do M3 (s desde o início do arquivo completo) */
  readonly tDownS: number;
  /** Tempo desenhando nesta descida (s), sem as pausas do servo */
  readonly drawS: number;
  /** Comprimento desenhado, com as ligações das emendas (mm) */
  readonly lengthMm: number;
  /** Sobe e desce no mesmo ponto (corte de descida longa): não há deslocamento antes */
  readonly relift: boolean;
  /**
   * Fichas que a agenda contava ter no balde do servo logo antes desta descida. Um arquivo que COMEÇA
   * aqui (uma parte, uma retomada) não herdou essa folga: ele descansa o que falta depois do aquecimento.
   * Ausente em planos antigos ou montados à mão: vale como "balde cheio" (o caso mais cauteloso).
   */
  readonly bucket?: number;
}

export interface JobStats {
  readonly drawMm: number;
  readonly travelMm: number;
  /** Deslocamento na ordem do documento, para mostrar a economia */
  readonly travelMmUnoptimized: number;
  /** Descidas da caneta (ciclos do servo no desenho, sem aquecimento nem checkpoints) */
  readonly penLifts: number;
  readonly segments: number;
  readonly estimate: TimeEstimate;
  /** Tempo (s) em que cada traço começa: progresso e "play" */
  readonly strokeStartTimesS: readonly number[];
  /** Tinta a mais criada pelas ligações das emendas (mm) */
  readonly joinInkMm: number;
  /** Traços curtos escondidos por outra tinta, que foram retirados */
  readonly hiddenDropped: number;
  /** Descidas que tiveram de esperar (ou que estouraram o limite, se a espera está desligada) */
  readonly overloads: number;
  readonly checkpoints: number;
  readonly parts: number;
}

/** A camada (caneta) que um plano desenha. */
export interface PlanLayer {
  readonly penId: string;
  readonly penName: string;
  readonly penWidthMm: number;
  /** Cor da caneta na tela (#rrggbb) */
  readonly color: string;
  /** Posição na ordem de plotagem (0 = a primeira) */
  readonly index: number;
  /** Quantas camadas o trabalho tem */
  readonly count: number;
  /**
   * Desvio da ponta desta caneta (mm). Os pontos do plano já estão corrigidos (ponto no papel − desvio);
   * quem confere a zona de desenho soma o desvio de volta.
   */
  readonly offset: Vec;
  /** A camada começa e termina com uma cruz de registro */
  readonly registration: boolean;
}

export interface JobPlan {
  /** Ausente em planos montados à mão (testes): uma camada só, sem correção nem cruzes */
  readonly layer?: PlanLayer;
  /**
   * O trabalho (velocidade fixa ou dinâmica, F) com que este plano foi feito. O G-code sai com ESTE
   * trabalho, e não com o que estiver na tela na hora de gerar: as esperas do servo foram calculadas para ele.
   */
  readonly job?: JobSettings;
  readonly strokes: readonly PlannedStroke[];
  readonly descents: readonly Descent[];
  /** mm da máquina */
  readonly start: Vec;
  readonly end: Vec;
  readonly violations: readonly BoundsViolation[];
  readonly stats: JobStats;
}
