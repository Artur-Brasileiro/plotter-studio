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
 * mesmos ajustes. Se qualquer coisa mudar, as descidas mudam de número ou de lugar e o ponto guardado
 * não serve. Entra TODO ponto de todo traço (em centésimos de mm, como no arquivo), a ordem, as emendas
 * e os cortes: contar traços e olhar só o primeiro e o último ponto não bastava (com cruzes de registro
 * eles são sempre os mesmos, e um desenho inteiro podia mudar de lugar sem a assinatura mudar).
 */
const signatures = new WeakMap<object, string>();
export function planSignature(plan: JobPlan): string {
  const hit = signatures.get(plan);
  if (hit) return hit;
  // dois FNV-1a de 32 bits com sementes diferentes: 64 bits no total
  let h1 = 0x811c9dc5, h2 = 0x9747b28c;
  const mix = (v: number) => {
    const n = v | 0;
    for (let k = 0; k < 4; k++) {
      const byte = (n >>> (k * 8)) & 0xff;
      h1 = Math.imul(h1 ^ byte, 0x01000193);
      h2 = Math.imul(h2 ^ byte, 0x01000197);
    }
  };
  for (const s of plan.strokes) {
    mix(s.points.length);
    mix((s.joinedToPrevious ? 1 : 0) | (s.relift ? 2 : 0));
    for (const p of s.points) {
      mix(Math.round(p.x * 100));
      mix(Math.round(p.y * 100));
    }
  }
  for (const d of plan.descents) mix(d.first);
  const job = plan.job ? `${plan.job.speedMode}:${plan.job.fixedFeed}` : "";
  const sig = [plan.layer?.penId ?? "", plan.strokes.length, plan.descents.length, (h1 >>> 0).toString(16), (h2 >>> 0).toString(16), job].join("|");
  signatures.set(plan, sig);
  return sig;
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
