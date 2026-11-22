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
 *
 * Dois relógios. O tempo mostrado ao Artur (e o dos checkpoints e das partes) considera a aceleração
 * da máquina. Já o balde enche pelo MENOR entre esse tempo e o da auditoria (a conta do script de
 * blindagem: traço a F, G0 a 3000 mm/min, sem aceleração). Um dos dois sempre anda mais depressa que
 * o outro (o da auditoria nos saltos curtos, o da máquina nos longos), e o limite tem que valer pelos
 * dois: senão o arquivo sairia do gerador e seria reprovado pela própria conferência.
 */

/** Deslocamento na conta do script de blindagem e da auditoria (mm/min). Igual a AUDIT_TRAVEL_FEED. */
const SCRIPT_TRAVEL_FEED = 3000;

/**
 * O balde do servo: quantas fichas cabem e quantas entram por segundo.
 * - Cabe o que sobra entre o pico e a média, menos uma de folga; nunca menos que o maior gasto de uma vez
 *   (com checkpoints, 3: a descida e as duas batidas).
 * - Em 60 s saem, no pior caso, o balde cheio mais o que entrou: `capacity + taxa × 60 <= pico − 1`.
 *   Com o pico colado na média (20/20), quem cede é a taxa: o trabalho anda um pouco abaixo da média
 *   pedida, e o pico vale.
 */
export function servoBucket(profile: MachineProfile): { capacity: number; ratePerS: number } {
  const { servo, shield } = profile;
  const burst = shield.enabled && shield.resyncMinutes > 0 ? 1 + CHECKPOINT_DWELLS_S.length / 2 : 1;
  const capacity = Math.max(burst, servo.peakPer60s - servo.avgPerMin - 1);
  const perMin = Math.max(1, Math.min(servo.avgPerMin, servo.peakPer60s - capacity - 1));
  return { capacity, ratePerS: perMin / 60 };
}

/**
 * Pausas dos ciclos da blindagem. Os tempos fixos são os dos arquivos que já rodaram na máquina; se o
 * perfil pede mais tempo para o servo descer ou subir, vale o do perfil (senão o G0 seguinte sairia cedo).
 */
export function shieldDwells(profile: MachineProfile): { header: number; warmDown: number; warmUp: number; checkpoint: number[]; footer: number } {
  const down = profile.pen.settleSeconds, up = profile.pen.settleUpSeconds;
  return {
    header: Math.max(HEADER_SETTLE_S, up),
    warmDown: Math.max(WARMUP_SETTLE_S, down),
    warmUp: Math.max(WARMUP_SETTLE_S, up),
    checkpoint: CHECKPOINT_DWELLS_S.map((s, i) => Math.max(s, i % 2 === 0 ? down : up)),
    footer: Math.max(FOOTER_SETTLE_S, up),
  };
}

/** Fichas do balde logo depois do aquecimento, no começo de um arquivo. */
export function tokensAfterWarmup(profile: MachineProfile): number {
  const { shield } = profile;
  const { capacity } = servoBucket(profile);
  const warm = shield.enabled ? shield.warmupCycles : 0;
  // O aquecimento também são ciclos do servo. O arquivo começa com o balde no ponto em que, pagos os
  // ciclos do aquecimento, sobra uma ficha (com os 8 ciclos de sempre); com um aquecimento maior que
  // o balde, o desenho começa devendo e espera.
  return Math.min(capacity, warm + 1) - warm;
}
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

/**
 * `textFeed`: no modo de velocidade fixa, o F único que vai escrito no arquivo (o `G1 F500` de cada
 * descida). Sem ele (modo dinâmico) o arquivo traz o F de cada segmento do plano.
 */
export function scheduleJob(strokes: readonly PlannedStroke[], start: Vec, end: Vec, profile: MachineProfile, textFeed?: number): Schedule {
  const { pen, servo, shield } = profile;
  const lifts = shield.enabled && shield.doubleLift ? 2 : 1;
  const startTimes = new Array<number>(strokes.length).fill(0);
  const descents: Descent[] = [];
  let penS = 0, drawS = 0, travelS = 0, waitS = 0;
  let t = 0;
  /** Relógio do balde: o mais apressado dos dois modelos de tempo, trecho a trecho */
  let tb = 0;
  let cur = start;

  /** O 1º deslocamento do arquivo parte de um lugar que o arquivo não diz: não conta como descanso do servo */
  let firstTravel = true;
  const travel = (to: Vec) => {
    const b = makeBlock(cur, to, "rapid", profile);
    if (b) {
      const dt = chainTimes([b], profile)[0];
      travelS += dt;
      t += dt;
      if (!firstTravel) tb += Math.min(dt, dist(cur, to) / (SCRIPT_TRAVEL_FEED / 60));
    }
    firstTravel = false;
    cur = to;
  };
  const dwell = (s: number) => {
    penS += s;
    t += s;
    tb += s;
  };

  const dw = shieldDwells(profile);
  dwell(dw.header); // cabeçalho: M5 + G4
  if (shield.enabled && shield.warmupCycles > 0) {
    dwell(dw.header);
    travel({ x: shield.safeX, y: shield.safeY });
    dwell(shield.warmupCycles * (dw.warmDown + dw.warmUp) + WARMUP_FINAL_S);
  }

  // balde de fichas
  // Uma ficha de folga no balde e esperas arredondadas para cima (0,1 s): a máquina real e a
  // auditoria não marcam o tempo exatamente como esta conta, e o limite não pode estourar por 1.
  const { capacity, ratePerS: rate } = servoBucket(profile);
  // Começa com uma ficha só (não com o balde cheio): assim a média do trabalho INTEIRO nunca passa
  // de avgPerMin. As rajadas até o pico são pagas com a folga acumulada nos traços longos.
  let tokens = tokensAfterWarmup(profile);
  let lastRefill = tb;
  let overloads = 0;
  /** Fichas no balde logo antes do último gasto (depois da espera, se houve) */
  let bucketBefore = tokens;
  const spend = (n: number): number => {
    tokens = Math.min(capacity, tokens + (tb - lastRefill) * rate);
    lastRefill = tb;
    let wait = 0;
    if (tokens < n) {
      overloads++;
      if (servo.onOverload === "wait") {
        wait = Math.ceil(((n - tokens) / rate) * 10 - 1e-9) / 10;
        waitS += wait;
        t += wait;
        tb += wait;
        tokens = n;
        lastRefill = tb;
      }
    }
    bucketBefore = tokens;
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
    let bucket0 = bucketBefore;
    if (hasCheckpoint) {
      checkpoints++;
      checkpoint = checkpoints;
      checkpointMin = Math.round(t / 60);
      // as partes são cortadas sempre num checkpoint, no que deixar a parte mais perto do alvo
      if (partS > 0 && t - partStartT >= partS - resyncS / 2) {
        part++;
        partStartT = t;
        // O arquivo desta parte começa do zero, logo depois do próprio aquecimento: daqui em diante a
        // agenda não conta com mais folga do que esse arquivo terá. (No arquivo inteiro isso custa, no
        // máximo, alguns segundos de espera a mais por parte.)
        const fresh = tokensAfterWarmup(profile);
        bucket0 = Math.min(bucket0, fresh);
        tokens = Math.min(tokens, fresh - 1);
      }
      lastCheckpointT = t;
      dwell(dw.checkpoint.reduce((a, b) => a + b, 0));
    }
    if (!s0.relift) travel(s0.points[0]);
    const tDown = t;
    dwell(gi === 0 && shield.enabled ? shield.firstSettleSeconds : pen.settleSeconds);

    // desenho: uma cadeia de blocos do M3 ao M5
    const chain: Block[] = [];
    const marks: { stroke: number; block: number }[] = [];
    let lengthMm = 0;
    // pela conta do script cada segmento leva comprimento ÷ F, com o F que vai ESCRITO no arquivo
    // (o gerador segue a mesma regra: F modal, e a ligação de uma emenda usa o F do traço que começa)
    let scriptDraw = 0;
    let lastF = textFeed ?? s0.feeds[0] ?? profile.feed.straight;
    for (let i = first; i <= last; i++) {
      const s = strokes[i];
      if (s.points.length === 0) continue;
      marks.push({ stroke: i, block: chain.length });
      if (i > first || s.relift) {
        // ligação da emenda (com `relift` no primeiro, a caneta re-desceu no fim do traço anterior)
        const f = s.feeds[0] ?? lastF;
        const gap = makeBlock(cur, s.points[0], f, profile);
        if (gap) {
          chain.push(gap);
          lengthMm += gap.len;
          lastF = textFeed ?? f;
          scriptDraw += gap.len / (lastF / 60);
        }
      }
      cur = s.points[0];
      for (let j = 0; j + 1 < s.points.length; j++) {
        const b = makeBlock(s.points[j], s.points[j + 1], s.feeds[j], profile);
        const len = dist(s.points[j], s.points[j + 1]);
        if (b) {
          chain.push(b);
          lastF = textFeed ?? s.feeds[j];
          scriptDraw += len / (lastF / 60);
        }
        lengthMm += len;
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
    tb += Math.min(dDraw, scriptDraw);
    dwell(pen.settleUpSeconds * lifts);
    descents.push({ first, last, waitS: wait, checkpoint, checkpointMin, part, tDownS: tDown, drawS: dDraw, lengthMm, relift: !!s0.relift, bucket: bucket0 });
  });

  dwell(shield.enabled ? 2 * dw.footer : 0);
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
