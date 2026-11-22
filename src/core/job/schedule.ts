import { dist, type Vec } from "../geometry/vec";
import type { MachineProfile } from "../machine";
import { chainTimes, makeBlock, type Block } from "./estimate";
import type { Descent, PlannedStroke, TimeEstimate } from "./types";

/**
 * Agenda do trabalho: percorre os traços na ordem final e decide o que acontece no tempo.
 * - junta os traços emendados em DESCIDAS (do M3 ao M5);
 * - controla a carga do servo com um "balde de fichas" (REGRAS_GCODE.md, regra 3);
 * - marca os checkpoints e as partes da blindagem (regras 13 e 14);
 * - calcula o tempo de tudo (mesmo modelo de aceleração da estimativa).
 *
 * Balde de fichas: entram `avgPerMin` fichas por minuto, cabem `peakPer60s − avgPerMin`, e cada
 * descida gasta uma. Faltou ficha: a caneta espera em cima. Isso garante média <= avgPerMin e
 * no máximo peakPer60s descidas em qualquer janela de 60 s.
 */
export interface Schedule {
  readonly descents: Descent[];
  readonly estimate: TimeEstimate;
  readonly strokeStartTimesS: number[];
  /** Descidas que esperaram (modo "wait") ou que estouraram o limite (outros modos) */
  readonly overloads: number;
  readonly checkpoints: number;
  readonly parts: number;
}

/** Tempos fixos dos ciclos da blindagem, como nos arquivos que já rodaram na máquina. */
export const WARMUP_SETTLE_S = 0.4;
export const WARMUP_FINAL_S = 1.0;
export const CHECKPOINT_DWELLS_S = [0.3, 0.3, 0.3, 0.4] as const;
export const HEADER_SETTLE_S = 0.3;
export const FOOTER_SETTLE_S = 0.3;

/** Grupos de traços que formam uma descida: [primeiro, último] em `strokes`. */
export function groupDescents(strokes: readonly PlannedStroke[]): [number, number][] {
  const out: [number, number][] = [];
  strokes.forEach((s, i) => {
    if (s.points.length === 0) return;
    const last = out[out.length - 1];
    if (!last || !s.joinedToPrevious || s.relift) out.push([i, i]);
    else last[1] = i;
  });
  return out;
}

export function scheduleJob(strokes: readonly PlannedStroke[], start: Vec, end: Vec, profile: MachineProfile): Schedule {
  const { pen, servo, shield } = profile;
  const lifts = shield.enabled && shield.doubleLift ? 2 : 1;
  const startTimes = new Array<number>(strokes.length).fill(0);
  const descents: Descent[] = [];
  let penS = 0, drawS = 0, travelS = 0, waitS = 0;
  let t = 0;
  let cur = start;

  const travel = (to: Vec) => {
    const b = makeBlock(cur, to, "rapid", profile);
    if (b) {
      const dt = chainTimes([b], profile)[0];
      travelS += dt;
      t += dt;
    }
    cur = to;
  };
  const dwell = (s: number) => {
    penS += s;
    t += s;
  };

  dwell(HEADER_SETTLE_S); // cabeçalho: M5 + G4
  if (shield.enabled && shield.warmupCycles > 0) {
    dwell(HEADER_SETTLE_S);
    travel({ x: shield.safeX, y: shield.safeY });
    dwell(shield.warmupCycles * 2 * WARMUP_SETTLE_S + WARMUP_FINAL_S);
  }

  // balde de fichas
  // Uma ficha de folga no balde e esperas arredondadas para cima (0,1 s): a máquina real e a
  // auditoria não marcam o tempo exatamente como esta conta, e o limite não pode estourar por 1.
  const rate = servo.avgPerMin / 60;
  const capacity = Math.max(1, servo.peakPer60s - servo.avgPerMin - 1);
  // Começa com uma ficha só (não com o balde cheio): assim a média do trabalho INTEIRO nunca passa
  // de avgPerMin. As rajadas até o pico são pagas com a folga acumulada nos traços longos.
  let tokens = 1;
  let lastRefill = t;
  let overloads = 0;
  const spend = (n: number): number => {
    tokens = Math.min(capacity, tokens + (t - lastRefill) * rate);
    lastRefill = t;
    let wait = 0;
    if (tokens < n) {
      overloads++;
      if (servo.onOverload === "wait") {
        wait = Math.ceil(((n - tokens) / rate) * 10 - 1e-9) / 10;
        waitS += wait;
        t += wait;
        tokens = n;
        lastRefill = t;
      }
    }
    tokens -= n;
    return wait;
  };

  const resyncS = shield.enabled ? shield.resyncMinutes * 60 : 0;
  const partS = shield.enabled ? shield.partMinutes * 60 : 0;
  let lastCheckpointT = t;
  let checkpoints = 0;
  let part = 0;
  let partStartT = t;

  groupDescents(strokes).forEach(([first, last], gi) => {
    const s0 = strokes[first];
    let checkpoint: number | undefined;
    let checkpointMin: number | undefined;
    // checkpoint: com a caneta em cima, no fim do traço que acabou de ser feito.
    // Os 2 ciclos dele gastam fichas junto com a descida: a espera (se houver) vem antes de tudo.
    const hasCheckpoint = resyncS > 0 && gi > 0 && t - lastCheckpointT >= resyncS;
    const wait = spend(hasCheckpoint ? 1 + CHECKPOINT_DWELLS_S.length / 2 : 1);
    if (hasCheckpoint) {
      checkpoints++;
      checkpoint = checkpoints;
      checkpointMin = Math.round(t / 60);
      // as partes são cortadas sempre num checkpoint, no que deixar a parte mais perto do alvo
      if (partS > 0 && t - partStartT >= partS - resyncS / 2) {
        part++;
        partStartT = t;
      }
      lastCheckpointT = t;
      dwell(CHECKPOINT_DWELLS_S.reduce((a, b) => a + b, 0));
    }
    if (!s0.relift) travel(s0.points[0]);
    const tDown = t;
    dwell(gi === 0 && shield.enabled ? shield.firstSettleSeconds : pen.settleSeconds);

    // desenho: uma cadeia de blocos do M3 ao M5
    const chain: Block[] = [];
    const marks: { stroke: number; block: number }[] = [];
    let lengthMm = 0;
    for (let i = first; i <= last; i++) {
      const s = strokes[i];
      if (s.points.length === 0) continue;
      marks.push({ stroke: i, block: chain.length });
      if (i > first || s.relift) {
        // ligação da emenda (com `relift` no primeiro, a caneta re-desceu no fim do traço anterior)
        const gap = makeBlock(cur, s.points[0], s.feeds[0] ?? profile.feed.fixed, profile);
        if (gap) {
          chain.push(gap);
          lengthMm += dist(cur, s.points[0]);
        }
      }
      cur = s.points[0];
      for (let j = 0; j + 1 < s.points.length; j++) {
        const b = makeBlock(s.points[j], s.points[j + 1], s.feeds[j], profile);
        if (b) chain.push(b);
        lengthMm += dist(s.points[j], s.points[j + 1]);
      }
      cur = s.points[s.points.length - 1];
    }
    const times = chainTimes(chain, profile);
    const cum = [0];
    for (const dt of times) cum.push(cum[cum.length - 1] + dt);
    for (const m of marks) startTimes[m.stroke] = t + cum[m.block];
    const dDraw = cum[cum.length - 1];
    drawS += dDraw;
    t += dDraw;
    dwell(pen.settleUpSeconds * lifts);
    descents.push({ first, last, waitS: wait, checkpoint, checkpointMin, part, tDownS: tDown, drawS: dDraw, lengthMm, relift: !!s0.relift });
  });

  dwell(shield.enabled ? 2 * FOOTER_SETTLE_S : 0);
  travel(end);
  return {
    descents,
    estimate: { totalS: penS + drawS + travelS + waitS, drawS, travelS, penS, waitS },
    strokeStartTimesS: startTimes,
    overloads,
    checkpoints,
    parts: part + 1,
  };
}
