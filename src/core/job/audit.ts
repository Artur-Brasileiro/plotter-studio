import type { MachineProfile } from "../machine";
import { MAX_LINE_LENGTH } from "./gcode";

/**
 * Auditoria de um G-code (REGRAS_GCODE.md, seção 10). Lê o TEXTO final, linha a linha, como a
 * máquina leria: não confia no plano que o gerou. Por isso serve também para conferir arquivos
 * feitos fora do Plotter Studio.
 *
 * Modelo de tempo: o mesmo do script de blindagem do Artur, para os números baterem com o
 * histórico dele: traço a F (comprimento ÷ F), deslocamento a 3000 mm/min, pausas pelo G4.
 * Não considera aceleração; a estimativa de tempo do plano é quem considera.
 */
export const AUDIT_TRAVEL_FEED = 3000;

export interface AuditProblem {
  readonly level: "error" | "warn";
  readonly message: string;
}

export interface AuditReport {
  readonly lines: number;
  readonly maxLineLength: number;
  readonly nonAsciiLines: number;
  /** Ciclos do servo no desenho: descidas com traço, pontos e checkpoints (sem o aquecimento) */
  readonly cycles: number;
  readonly warmupCycles: number;
  readonly checkpoints: number;
  readonly totalS: number;
  readonly drawS: number;
  readonly travelS: number;
  readonly dwellS: number;
  /** Descansos do servo: G4 de 2 s ou mais com a caneta em cima */
  readonly restS: number;
  readonly avgCyclesPerMin: number;
  readonly peakCyclesPer60s: number;
  /** % das descidas em que a caneta fica embaixo menos de 1 s (contando a pausa depois de descer) */
  readonly shortDescentPct: number;
  /** Tempo desenhando em cada descida (s), na ordem do arquivo */
  readonly descentDrawS: readonly number[];
  readonly longestDescentS: number;
  readonly longestDescentMm: number;
  /** % do tempo com a caneta embaixo */
  readonly penDownPct: number;
  readonly drawMm: number;
  readonly travelMm: number;
  /** Movimentos G0 com a caneta embaixo (tem que ser 0) */
  readonly rapidsPenDown: number;
  /** M3/M5 sem G4 logo depois (tem que ser 0) */
  readonly penCmdsWithoutDwell: number;
  /** Pontos de traço fora da zona de desenho */
  readonly outOfZone: number;
  /** Qualquer coordenada fora do curso da máquina */
  readonly outOfArea: number;
  readonly problems: readonly AuditProblem[];
  /** Nenhum problema de nível "error" */
  readonly ok: boolean;
}

const WORD = /([A-Z])\s*(-?\d*\.?\d+)/g;

export function auditGcode(text: string | readonly string[], profile: MachineProfile): AuditReport {
  const rawLines = typeof text === "string" ? text.split(/\r?\n/) : text;
  const { drawZone: z, workArea, shield, servo } = profile;
  const eps = 0.006; // meia unidade da 2ª casa decimal

  let maxLineLength = 0;
  let nonAscii = 0;
  let nLines = 0;
  let x = NaN, y = NaN; // posição desconhecida até o 1º movimento
  let motion: 0 | 1 = 0;
  let feed = profile.feed.fixed;
  let penDown = false;
  let t = 0;
  let drawS = 0, travelS = 0, dwellS = 0, restS = 0;
  let drawMm = 0, travelMm = 0;
  let rapidsPenDown = 0, penCmdsWithoutDwell = 0, outOfZone = 0, outOfArea = 0;
  let warmupCycles = 0, checkpoints = 0;
  /** comando de caneta esperando o G4 */
  let pendingPen = false;
  const cycleTimes: number[] = [];
  const descentDraw: number[] = [];
  const descentDown: number[] = [];
  let curDrawS = 0, curDrawMm = 0, curDownS = 0, curMoved = false, curIsWarmup = false;
  let longestS = 0, longestMm = 0, penDownS = 0;

  const atSafe = () => Math.abs(x - shield.safeX) < 0.01 && Math.abs(y - shield.safeY) < 0.01;
  const endDescent = () => {
    if (curIsWarmup && !curMoved) {
      warmupCycles++;
      cycleTimes.pop();
    } else {
      descentDraw.push(curDrawS);
      descentDown.push(curDownS);
      if (curDrawS > longestS) longestS = curDrawS;
      if (curDrawMm > longestMm) longestMm = curDrawMm;
    }
  };

  for (const raw of rawLines) {
    if (raw.length === 0) continue;
    nLines++;
    if (raw.length > maxLineLength) maxLineLength = raw.length;
    if (/[^\x09\x20-\x7e]/.test(raw)) nonAscii++;
    if (/^;\s*CHECKPOINT\b/i.test(raw)) checkpoints++;
    const code = raw.split(";")[0].trim().toUpperCase();
    if (!code) continue;

    let isDwell = false, dwellP = 0;
    let nx = x, ny = y, hasMove = false;
    let m: RegExpExecArray | null;
    let penCmd: "down" | "up" | undefined;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(code))) {
      const v = Number(m[2]);
      switch (m[1]) {
        case "G":
          if (v === 0) motion = 0;
          else if (v === 1) motion = 1;
          else if (v === 4) isDwell = true;
          break;
        case "M":
          if (v === 3 || v === 4) penCmd = "down";
          else if (v === 5) penCmd = "up";
          break;
        case "X":
          nx = v;
          hasMove = true;
          break;
        case "Y":
          ny = v;
          hasMove = true;
          break;
        case "F":
          feed = v;
          break;
        case "P":
          dwellP = v;
          break;
      }
    }

    if (pendingPen && !isDwell) penCmdsWithoutDwell++;
    pendingPen = false;

    if (isDwell) {
      dwellS += dwellP;
      if (!penDown && dwellP >= 2) restS += dwellP;
      if (penDown) {
        penDownS += dwellP;
        curDownS += dwellP;
      }
      t += dwellP;
      continue;
    }
    if (penCmd === "down") {
      if (!penDown) {
        penDown = true;
        cycleTimes.push(t);
        curDrawS = 0;
        curDrawMm = 0;
        curDownS = 0;
        curMoved = false;
        curIsWarmup = shield.enabled && atSafe();
        // onde a caneta encosta também é traço (o aquecimento, no ponto seguro, é a exceção)
        if (!curIsWarmup && !Number.isNaN(x) && (x < z.minX - eps || y < z.minY - eps || x > z.maxX + eps || y > z.maxY + eps)) outOfZone++;
      }
      pendingPen = true;
    } else if (penCmd === "up") {
      if (penDown) {
        penDown = false;
        endDescent();
      }
      pendingPen = true;
    }
    if (hasMove) {
      if (nx < -eps || ny < -eps || nx > workArea.width + eps || ny > workArea.height + eps) outOfArea++;
      const len = Number.isNaN(x) || Number.isNaN(y) ? 0 : Math.hypot(nx - x, ny - y);
      if (motion === 0) {
        if (penDown && len > eps) rapidsPenDown++;
        const dt = len / (AUDIT_TRAVEL_FEED / 60);
        travelMm += len;
        travelS += dt;
        t += dt;
        if (penDown) penDownS += dt;
      } else {
        const dt = feed > 0 ? len / (feed / 60) : 0;
        t += dt;
        if (penDown) {
          drawMm += len;
          drawS += dt;
          penDownS += dt;
          curDrawS += dt;
          curDownS += dt;
          curDrawMm += len;
          if (len > eps) curMoved = true;
          if (nx < z.minX - eps || ny < z.minY - eps || nx > z.maxX + eps || ny > z.maxY + eps) outOfZone++;
        } else {
          travelMm += len;
          travelS += dt;
        }
      }
      x = nx;
      y = ny;
    }
  }
  if (penDown) endDescent();

  // pico: mais ciclos em qualquer janela de 60 s
  let peak = 0;
  for (let i = 0, j = 0; i < cycleTimes.length; i++) {
    while (cycleTimes[i] - cycleTimes[j] >= 60) j++;
    if (i - j + 1 > peak) peak = i - j + 1;
  }
  const cycles = cycleTimes.length;
  const totalS = t;
  const avg = totalS > 0 ? cycles / (totalS / 60) : 0;
  // mesma conta do historico de REGRAS_GCODE.md: do M3 ao M5, com a pausa do servo (confere com os
  // 15% do "senna fina" e os 46% da "grossa v7")
  const short = descentDown.filter((s) => s < 1).length;

  const problems: AuditProblem[] = [];
  const err = (message: string) => problems.push({ level: "error", message });
  const warn = (message: string) => problems.push({ level: "warn", message });
  const n = (v: number) => v.toLocaleString("pt-BR");
  if (rapidsPenDown) err(`${n(rapidsPenDown)} deslocamento(s) G0 com a caneta embaixo: riscaria o papel.`);
  if (penCmdsWithoutDwell) err(`${n(penCmdsWithoutDwell)} comando(s) de caneta sem G4 logo depois: a máquina andaria antes de o servo chegar.`);
  if (maxLineLength > MAX_LINE_LENGTH) err(`Linha com ${maxLineLength} caracteres (o máximo é ${MAX_LINE_LENGTH}).`);
  if (nonAscii) err(`${n(nonAscii)} linha(s) com caractere fora de ASCII: o GRBL lê como comando.`);
  if (outOfArea) err(`${n(outOfArea)} ponto(s) fora do curso da máquina: o GRBL daria ALARM:2.`);
  if (outOfZone) err(`${n(outOfZone)} ponto(s) de traço fora da zona de desenho.`);
  const over = servo.onOverload === "warn" ? warn : err;
  if (avg > servo.avgPerMin * 1.02 + 0.05) over(`Servo: média de ${avg.toFixed(1)} ciclos/min, acima do limite de ${servo.avgPerMin}.`);
  if (peak > servo.peakPer60s) over(`Servo: pico de ${peak} ciclos em 60 s, acima do limite de ${servo.peakPer60s}.`);
  const capS = servo.maxDescentMm / (profile.feed.fixed / 60);
  if (longestMm > servo.maxDescentMm * 1.01 + 1) warn(`Descida de ${Math.round(longestMm)} mm (~${Math.round(longestS)} s): mais longa que o limite de ${servo.maxDescentMm} mm (~${Math.round(capS)} s).`);

  return {
    lines: nLines,
    maxLineLength,
    nonAsciiLines: nonAscii,
    cycles,
    warmupCycles,
    checkpoints,
    totalS,
    drawS,
    travelS,
    dwellS,
    restS,
    avgCyclesPerMin: avg,
    peakCyclesPer60s: peak,
    shortDescentPct: descentDraw.length ? (100 * short) / descentDraw.length : 0,
    descentDrawS: descentDraw,
    longestDescentS: longestS,
    longestDescentMm: longestMm,
    penDownPct: totalS > 0 ? (100 * penDownS) / totalS : 0,
    drawMm,
    travelMm,
    rapidsPenDown,
    penCmdsWithoutDwell,
    outOfZone,
    outOfArea,
    problems,
    ok: !problems.some((p) => p.level === "error"),
  };
}
