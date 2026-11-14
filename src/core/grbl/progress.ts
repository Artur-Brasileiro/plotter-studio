import { distToSegment, type Vec } from "../geometry/vec";
import type { GcodeProgram } from "../job/gcode";

/** Para cada linha de movimento (G0/G1) do programa: de onde sai e aonde chega. */
export interface ProgramTargets {
  readonly from: readonly (Vec | undefined)[];
  readonly to: readonly (Vec | undefined)[];
}

const MOVE = /^G[01](?:\s|$).*?X(-?\d+(?:\.\d+)?)\s*Y(-?\d+(?:\.\d+)?)/;

export function programTargets(program: Pick<GcodeProgram, "lines">): ProgramTargets {
  const from: (Vec | undefined)[] = [];
  const to: (Vec | undefined)[] = [];
  let pos: Vec | undefined;
  program.lines.forEach((l, i) => {
    const m = MOVE.exec(l.text);
    if (!m) return;
    const t = { x: Number(m[1]), y: Number(m[2]) };
    from[i] = pos ?? t;
    to[i] = t;
    pos = t;
  });
  return { from, to };
}

/**
 * Linha que a máquina está executando agora. Ela está entre as últimas ~16 com "ok" (planejador de 15
 * blocos + a que está andando); dentro dessa janela, a de segmento mais próximo da WPos. Nunca volta para
 * antes de `minLine` (a estimativa anterior), e em empate fica a mais antiga: num contorno fechado o
 * ponto inicial e o final coincidem.
 */
export function estimateCurrentLine(t: ProgramTargets, lastAcked: number, wpos: Vec, minLine = 0, window = 17): number | undefined {
  let best: number | undefined;
  let bestD = Infinity;
  let n = 0;
  for (let i = lastAcked; i >= minLine && n < window; i--) {
    const a = t.from[i];
    const b = t.to[i];
    if (!a || !b) continue;
    n++;
    const d = distToSegment(wpos, a, b);
    if (d <= bestD + 0.01) {
      best = i;
      if (d < bestD) bestD = d;
    }
  }
  return best;
}
