import type { PlotDocument } from "../document";
import type { BBox } from "../geometry/path";
import { penOf, type MachineProfile, type Pen } from "../machine";
import type { OrderedStroke } from "./types";

/** `drawingId` dos traços que o próprio aplicativo acrescenta: as cruzes de registro. */
export const REGISTRATION_ID = "@registro";

/**
 * Uma camada = tudo o que uma caneta desenha. Cada camada vira um G-code próprio, rodado sem mexer no
 * papel, com a troca da caneta entre um e outro (docs/REGRAS_GCODE.md, seção 7).
 */
export interface Layer {
  readonly pen: Pen;
  /** Posição na ordem de plotagem (0 = a primeira a ser desenhada) */
  readonly index: number;
  /** Quantas camadas o documento tem */
  readonly count: number;
  /** Quantos desenhos usam esta caneta */
  readonly drawings: number;
}

/**
 * As camadas que o documento usa, na ordem de plotagem: a ordem da lista de canetas do perfil
 * (cor → fina → grossa; a grossa por último cobre as pontas e as ligações da fina).
 * Desenho sem caneta, ou com uma caneta que não existe mais, vai na caneta padrão.
 */
export function layersOf(doc: PlotDocument, profile: MachineProfile): Layer[] {
  const used = new Map<string, number>();
  for (const d of doc.drawings) {
    const id = penOf(profile, d.penId).id;
    used.set(id, (used.get(id) ?? 0) + 1);
  }
  const pens = profile.pens.filter((p) => used.has(p.id));
  return pens.map((pen, index) => ({ pen, index, count: pens.length, drawings: used.get(pen.id)! }));
}

/** As cruzes entram quando o trabalho tem mais de uma caneta (auto), sempre, ou nunca. */
export function usesRegistration(profile: MachineProfile, layerCount: number): boolean {
  const mode = profile.registration.mode;
  return mode === "always" || (mode === "auto" && layerCount > 1);
}

/**
 * Cruz de registro em IDA E VOLTA pelo mesmo caminho, sem diagonal (regra 11): se a caneta demorar a
 * encostar na ida, a volta cobre. É o mesmo percurso dos arquivos blindados que já rodaram na máquina:
 *
 *   esquerda → direita → centro → baixo → cima → baixo → centro → direita → esquerda
 *
 * `armMm` é o tamanho total de cada braço (6 mm: serve de régua na foto).
 */
export function crossStroke(cx: number, cy: number, armMm: number): OrderedStroke {
  const h = armMm / 2;
  return {
    points: [
      { x: cx - h, y: cy },
      { x: cx + h, y: cy },
      { x: cx, y: cy },
      { x: cx, y: cy - h },
      { x: cx, y: cy + h },
      { x: cx, y: cy - h },
      { x: cx, y: cy },
      { x: cx + h, y: cy },
      { x: cx - h, y: cy },
    ],
    closed: false,
    drawingId: REGISTRATION_ID,
    joinedToPrevious: false,
  };
}

/** A cruz que abre a camada (X20 Y12) e a que fecha (X580 Y12). */
export function registrationCrosses(profile: MachineProfile): { first: OrderedStroke; last: OrderedStroke } {
  const r = profile.registration;
  return { first: crossStroke(r.x1, r.y, r.armMm), last: crossStroke(r.x2, r.y, r.armMm) };
}

/** Onde as cruzes ficam no papel: a exceção à zona de desenho (as cruzes ficam na borda, em Y12). */
export function registrationBoxes(profile: MachineProfile): BBox[] {
  const r = profile.registration;
  const h = r.armMm / 2;
  return [r.x1, r.x2].map((x) => ({ minX: x - h, minY: r.y - h, maxX: x + h, maxY: r.y + h }));
}
