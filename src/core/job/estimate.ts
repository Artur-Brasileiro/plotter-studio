import type { Vec } from "../geometry/vec";
import type { MachineProfile } from "../machine";
import type { PlannedStroke, TimeEstimate } from "./types";

/**
 * Estimativa de tempo: uma simulação simplificada do planejador do GRBL.
 * - cada G1/G0 é um bloco com perfil trapezoidal (acelera, cruzeiro, freia);
 * - velocidade máxima nas junções pela fórmula do GRBL ($11, junction deviation);
 * - M3/M5/G4 sincronizam: cada traço e cada deslocamento começa e termina parado;
 * - limites por eixo como no GRBL (na diagonal pode passar de 200 mm/s).
 * Ignora a antecipação limitada a ~15 blocos e a falta de linhas na serial (fica um pouco otimista).
 */

export interface Block {
  readonly len: number;
  readonly ux: number;
  readonly uy: number;
  /** mm/s */
  readonly vNom: number;
  /** mm/s² */
  readonly acc: number;
}

/** Como o limit_value_by_axis_maximum do GRBL (eixos X e Y com o mesmo limite). */
function limitByAxis(limit: number, ux: number, uy: number): number {
  let v = Infinity;
  if (Math.abs(ux) > 1e-9) v = Math.min(v, limit / Math.abs(ux));
  if (Math.abs(uy) > 1e-9) v = Math.min(v, limit / Math.abs(uy));
  return v;
}

export function makeBlock(a: Vec, b: Vec, feedMmMin: number | "rapid", profile: MachineProfile): Block | undefined {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return undefined;
  const ux = dx / len, uy = dy / len;
  const rapid = limitByAxis(profile.motion.maxRateMmMin / 60, ux, uy);
  const vNom = feedMmMin === "rapid" ? rapid : Math.min(feedMmMin / 60, rapid);
  return { len, ux, uy, vNom, acc: limitByAxis(profile.motion.accelMmS2, ux, uy) };
}

/** Velocidade máxima (mm/s) na junção entre dois blocos, pela fórmula do GRBL 1.1. */
export function junctionSpeed(u1: Vec, u2: Vec, profile: MachineProfile): number {
  const cosTheta = -(u1.x * u2.x + u1.y * u2.y);
  if (cosTheta > 0.999999) return 0; // meia-volta
  if (cosTheta < -0.999999) return Infinity; // reta
  const jx = u2.x - u1.x, jy = u2.y - u1.y;
  const jl = Math.hypot(jx, jy);
  const acc = jl > 0 ? limitByAxis(profile.motion.accelMmS2, jx / jl, jy / jl) : profile.motion.accelMmS2;
  const sinHalf = Math.sqrt(0.5 * (1 - cosTheta));
  return Math.sqrt((acc * profile.motion.junctionDeviationMm * sinHalf) / (1 - sinHalf));
}

/** Tempo de cada bloco de uma sequência que começa e termina parada. */
export function chainTimes(blocks: readonly Block[], profile: MachineProfile): number[] {
  const n = blocks.length;
  if (n === 0) return [];
  const entry = new Array<number>(n + 1).fill(0); // entry[n] = saída do último = 0
  const maxEntry = new Array<number>(n).fill(0);
  for (let j = 1; j < n; j++) {
    const a = blocks[j - 1], b = blocks[j];
    maxEntry[j] = Math.min(junctionSpeed({ x: a.ux, y: a.uy }, { x: b.ux, y: b.uy }, profile), a.vNom, b.vNom);
  }
  // para trás: dá para frear até a velocidade de saída?
  for (let j = n - 1; j >= 1; j--) entry[j] = Math.min(maxEntry[j], Math.sqrt(entry[j + 1] ** 2 + 2 * blocks[j].acc * blocks[j].len));
  // para frente: dá para acelerar até lá?
  for (let j = 1; j < n; j++) entry[j] = Math.min(entry[j], Math.sqrt(entry[j - 1] ** 2 + 2 * blocks[j - 1].acc * blocks[j - 1].len));
  return blocks.map((b, j) => trapezoid(b.len, entry[j], entry[j + 1], b.vNom, b.acc));
}

/** Tempo para percorrer L começando em v0, terminando em v1, com cruzeiro máx. vn e aceleração a. */
export function trapezoid(L: number, v0: number, v1: number, vn: number, a: number): number {
  const da = Math.max(0, (vn * vn - v0 * v0) / (2 * a));
  const dd = Math.max(0, (vn * vn - v1 * v1) / (2 * a));
  if (da + dd <= L) return (vn - v0) / a + (vn - v1) / a + (L - da - dd) / vn;
  const vp = Math.sqrt(Math.max(v0 * v0, v1 * v1, (2 * a * L + v0 * v0 + v1 * v1) / 2));
  return Math.max(0, (vp - v0) / a) + Math.max(0, (vp - v1) / a);
}

export function estimateTime(
  strokes: readonly PlannedStroke[],
  start: Vec,
  end: Vec,
  profile: MachineProfile,
): { estimate: TimeEstimate; strokeStartTimesS: number[] } {
  const settle = profile.pen.settleSeconds;
  let penS = settle; // cabeçalho: M5 + G4
  let drawS = 0;
  let travelS = 0;
  const startTimes = new Array<number>(strokes.length).fill(0);
  let penDown = false;
  let cur = start;

  let chain: Block[] = [];
  let marks: { stroke: number; block: number }[] = [];
  const now = () => penS + drawS + travelS;
  const flush = () => {
    const t0 = now();
    const times = chainTimes(chain, profile);
    const cum = [0];
    for (const t of times) cum.push(cum[cum.length - 1] + t);
    for (const m of marks) startTimes[m.stroke] = t0 + cum[m.block];
    drawS += cum[cum.length - 1];
    chain = [];
    marks = [];
  };
  const travel = (to: Vec) => {
    const b = makeBlock(cur, to, "rapid", profile);
    if (b) travelS += chainTimes([b], profile)[0];
    cur = to;
  };

  strokes.forEach((s, i) => {
    if (s.points.length === 0) return;
    if (!s.joinedToPrevious || !penDown) {
      flush();
      if (penDown) penS += settle; // M5 + G4
      travel(s.points[0]);
      penS += settle; // M3 + G4
      penDown = true;
      marks.push({ stroke: i, block: chain.length });
    } else {
      marks.push({ stroke: i, block: chain.length });
      const gap = makeBlock(cur, s.points[0], s.feeds[0] ?? profile.feed.straight, profile);
      if (gap) chain.push(gap);
      cur = s.points[0];
    }
    for (let j = 0; j + 1 < s.points.length; j++) {
      const b = makeBlock(s.points[j], s.points[j + 1], s.feeds[j], profile);
      if (b) chain.push(b);
    }
    cur = s.points[s.points.length - 1];
  });
  flush();
  if (penDown) penS += settle;
  travel(end);
  return { estimate: { totalS: penS + drawS + travelS, drawS, travelS, penS, waitS: 0 }, strokeStartTimesS: startTimes };
}
