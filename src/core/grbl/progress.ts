import { distToSegment, type Vec } from "../geometry/vec";
import type { GcodeProgram } from "../job/gcode";

/** Para cada linha de movimento (G0/G1) do programa: de onde sai e aonde chega. */
export interface ProgramTargets {
  readonly from: readonly (Vec | undefined)[];
  readonly to: readonly (Vec | undefined)[];
}

const WORD = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/g;
/** G que usam X/Y sem ser um movimento até esse ponto (pausa, offsets, home, coordenada de máquina) */
const NOT_A_MOVE = [4, 10, 28, 30, 53, 92];

/**
 * Acompanha o programa como o GRBL: o modo de movimento é modal, então depois de um "G1 F500" as linhas
 * só com "X.. Y.." (formato de docs/REGRAS_GCODE.md) também são movimentos, e "G1 F500" sozinho não é.
 * Um eixo que falta na linha fica onde estava. G91 soma ao ponto anterior.
 */
export function programTargets(program: Pick<GcodeProgram, "lines">): ProgramTargets {
  const from: (Vec | undefined)[] = [];
  const to: (Vec | undefined)[] = [];
  let pos: Vec | undefined;
  let moving = true; // G0 ao ligar; só o G80 desliga
  let absolute = true;
  program.lines.forEach((l, i) => {
    const code = l.text
      .replace(/\([^)]*\)/g, "")
      .replace(/;.*$/, "")
      .replace(/\s+/g, "")
      .toUpperCase();
    if (!code || code[0] === "$") return;
    let x: number | undefined;
    let y: number | undefined;
    let other = false;
    let end = false;
    for (const m of code.matchAll(WORD)) {
      const v = Number(m[2]);
      if (m[1] === "X") x = v;
      else if (m[1] === "Y") y = v;
      else if (m[1] === "G") {
        if (v >= 0 && v <= 3) moving = true;
        else if (v === 80) moving = false;
        else if (v === 90) absolute = true;
        else if (v === 91) absolute = false;
        else if (NOT_A_MOVE.includes(Math.trunc(v))) other = true;
      } else if (m[1] === "M" && (v === 2 || v === 30)) end = true;
    }
    if ((x !== undefined || y !== undefined) && moving && !other) {
      let t: Vec | undefined;
      if (absolute) {
        const tx = x ?? pos?.x;
        const ty = y ?? pos?.y;
        if (tx !== undefined && ty !== undefined) t = { x: tx, y: ty };
      } else if (pos) t = { x: pos.x + (x ?? 0), y: pos.y + (y ?? 0) };
      if (t) {
        from[i] = pos ?? t;
        to[i] = t;
        pos = t;
      }
    }
    if (end) {
      moving = true; // o M2/M30 deixa o GRBL em G1 e G90
      absolute = true;
    }
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
