import type { JobPlan } from "./types";

/** O que vai para a máquina: a camada inteira, uma parte de ~25 min, ou a retomada a partir de uma descida. */
export type SendWhat = { kind: "all" } | { kind: "part"; part: number } | { kind: "resume"; from: number };

/** Valor de um seletor: "" = tudo, "p2" = parte 3, "r812" = retomar da descida 813. */
export function parseWhat(value: string): SendWhat {
  if (/^p\d+$/.test(value)) return { kind: "part", part: Number(value.slice(1)) };
  if (/^r\d+$/.test(value)) return { kind: "resume", from: Number(value.slice(1)) };
  return { kind: "all" };
}

/** Início e fim (s, no tempo do plano inteiro) do que vai ser enviado. */
export function sendSpan(plan: JobPlan, what: SendWhat): { t0: number; t1: number } {
  const total = plan.stats.estimate.totalS;
  if (what.kind === "all") return { t0: 0, t1: total };
  if (what.kind === "resume") return { t0: plan.descents[what.from]?.tDownS ?? 0, t1: total };
  const first = plan.descents.find((d) => d.part === what.part);
  const next = plan.descents.find((d) => d.part === what.part + 1);
  return { t0: first?.tDownS ?? 0, t1: next?.tDownS ?? total };
}

/**
 * Impressão digital de um plano: a retomada só vale para o MESMO desenho, no mesmo lugar, com os
 * mesmos ajustes. Se qualquer coisa mudar, as descidas mudam de número e o ponto guardado não serve.
 */
export function planSignature(plan: JobPlan): string {
  const s = plan.stats;
  const first = plan.strokes[0]?.points[0];
  const lastStroke = plan.strokes[plan.strokes.length - 1];
  const last = lastStroke?.points[lastStroke.points.length - 1];
  const at = (p: { x: number; y: number } | undefined) => (p ? `${p.x.toFixed(2)},${p.y.toFixed(2)}` : "");
  return [plan.layer?.penId ?? "", plan.strokes.length, plan.descents.length, Math.round(s.drawMm * 10), Math.round(s.estimate.totalS), at(first), at(last)].join("|");
}

/**
 * De qual descida retomar, sabendo o último traço em que a máquina esteve (índice em `plan.strokes`).
 * Repete a descida anterior, por segurança: o que a máquina já tinha no planejador pode não ter saído.
 * `undefined` = ainda não tinha desenhado nada que valha retomar (mande tudo de novo).
 */
export function resumeDescent(plan: JobPlan, lastStroke: number): number | undefined {
  const idx = plan.descents.findIndex((d) => lastStroke >= d.first && lastStroke <= d.last);
  return idx > 0 ? idx - 1 : undefined;
}
