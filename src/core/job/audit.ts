import type { MachineProfile } from "../machine";
import { MAX_LINE_LENGTH } from "./gcode";
import { registrationBoxes } from "./layers";
import type { JobPlan } from "./types";

/**
 * Auditoria de um G-code (REGRAS_GCODE.md, seção 10). Lê o TEXTO final, linha a linha, como a
 * máquina leria: não confia no plano que o gerou. Por isso serve também para conferir arquivos
 * feitos fora do Plotter Studio.
 *
 * Modelo de tempo: o mesmo do script de blindagem do Artur, para os números baterem com o
 * histórico dele: traço a F (comprimento ÷ F), deslocamento a 3000 mm/min, pausas pelo G4.
 * Não considera aceleração; a estimativa de tempo do plano é quem considera.
 *
 * O que ela não entende, ela ACUSA: uma linha que a auditoria não sabe ler é uma linha que ninguém
 * conferiu, e arquivo não conferido não vai para a máquina.
 */
export const AUDIT_TRAVEL_FEED = 3000;

/** Pausa mínima (s) para valer como "esperou o servo": um `G4 P0` não espera nada. */
export const MIN_SERVO_DWELL_S = 0.05;
/** REGRAS_GCODE.md, seção 2: pelo menos 0,3 s depois de descer e 0,2 s depois de subir. Menos que isso é aviso. */
export const RULE_DWELL_DOWN_S = 0.3;
export const RULE_DWELL_UP_S = 0.2;

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
  /** Mais ciclos do servo em qualquer janela de 60 s, com os do aquecimento (o servo não sabe a diferença) */
  readonly peakCyclesPer60s: number;
  /** O mesmo pico, sem o aquecimento: é o número do histórico de REGRAS_GCODE.md */
  readonly peakDrawCyclesPer60s: number;
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
  /** Linhas que a auditoria não soube ler ou com comando que ela não confere (tem que ser 0) */
  readonly unknownLines: number;
  /** Linhas com comando "$" (mexem na configuração do GRBL; tem que ser 0) */
  readonly configLines: number;
  /** Descidas com o S (a altura do servo) diferente do comando de abaixar do perfil (tem que ser 0) */
  readonly wrongServoPosition: number;
  /** Pausas do servo que existem mas são mais curtas que a regra (aviso) */
  readonly shortDwells: number;
  readonly problems: readonly AuditProblem[];
  /** Nenhum problema de nível "error" */
  readonly ok: boolean;
}

const WORD = /([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
/** G que a auditoria conhece e que não mudam o que ela confere */
const HARMLESS_G = new Set([17, 21, 40, 49, 54, 80, 94]);

export interface AuditOptions {
  /**
   * Desvio da ponta da caneta desta camada (mm). O arquivo traz os pontos já corrigidos; a zona de
   * desenho é conferida onde a tinta cai de verdade (ponto do arquivo + desvio).
   */
  readonly penOffset?: { x: number; y: number };
  /** O arquivo tem cruzes de registro: elas ficam fora da zona de propósito (REGRAS_GCODE.md, 2.2) */
  readonly registration?: boolean;
}

/** As cruzes do plano: o que a auditoria precisa saber de uma camada. */
export function auditOptionsOf(plan: Pick<JobPlan, "layer">): AuditOptions {
  return plan.layer ? { penOffset: plan.layer.offset, registration: plan.layer.registration } : {};
}

export function auditGcode(text: string | readonly string[], profile: MachineProfile, opts: AuditOptions = {}): AuditReport {
  const rawLines = typeof text === "string" ? text.split(/\r?\n/) : text;
  const { drawZone: z, workArea, servo, shield } = profile;
  const eps = 0.006; // meia unidade da 2ª casa decimal
  const offX = opts.penOffset?.x ?? 0;
  const offY = opts.penOffset?.y ?? 0;
  const crosses = opts.registration ? registrationBoxes(profile) : [];
  /** O ponto do arquivo risca o papel fora da zona de desenho (e não é uma cruz de registro)? */
  const offZone = (fx: number, fy: number): boolean => {
    const px = fx + offX;
    const py = fy + offY;
    if (!(px < z.minX - eps || py < z.minY - eps || px > z.maxX + eps || py > z.maxY + eps)) return false;
    return !crosses.some((b) => px >= b.minX - eps && px <= b.maxX + eps && py >= b.minY - eps && py <= b.maxY + eps);
  };

  let maxLineLength = 0;
  let nonAscii = 0;
  let nLines = 0;
  let x = NaN, y = NaN; // posição desconhecida até o 1º movimento
  let motion: 0 | 1 = 0;
  let absolute = true;
  let feed = profile.feed.fixed;
  let penDown = false;
  let t = 0;
  let drawS = 0, travelS = 0, dwellS = 0, restS = 0;
  let drawMm = 0, travelMm = 0;
  let rapidsPenDown = 0, penCmdsWithoutDwell = 0, outOfZone = 0, outOfArea = 0;
  let unknownLines = 0, configLines = 0;
  let firstUnknown = "";
  let warmupCycles = 0, checkpoints = 0;
  /** comando de caneta esperando o G4 (e qual foi) */
  let pendingPen = false;
  let pendingKind: "down" | "up" = "up";
  let shortDwells = 0, wrongServoPosition = 0;
  /** a altura do servo que o perfil manda (o S do comando de abaixar), e o S em vigor no arquivo */
  const sm = /S\s*([+-]?(?:\d+\.?\d*|\.\d+))/i.exec(profile.pen.downCmd);
  const expectedS = sm ? Number(sm[1]) : undefined;
  let curS: number | undefined;
  /** instante de TODA descida (aquecimento incluído): é o que o servo sente */
  const allDowns: number[] = [];
  const drawDowns: number[] = [];
  let cycles = 0;
  const descentDraw: number[] = [];
  const descentDown: number[] = [];
  let curDrawS = 0, curDrawMm = 0, curDownS = 0, curMoved = false, curStartOffZone = false, curT = 0, curX = NaN, curY = NaN;
  let longestS = 0, longestMm = 0, penDownS = 0;

  // Aquecimento: as batidas no ar que ABREM o arquivo, no mesmo lugar, sem riscar nada. Duas ou mais
  // valem em qualquer lugar (quem decide é o arquivo: um arquivo blindado é lido certo mesmo com a
  // blindagem desligada nas Configurações); uma batida só vale se for no ponto seguro do perfil
  // (aquecimento configurado para 1 ciclo). Fora isso, uma batida solitária é um ponto do desenho.
  let leadOpen = true;
  let leadX = NaN, leadY = NaN;
  const leading: { t: number; downS: number; offZone: boolean }[] = [];
  const same = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 0.01;
  const account = (tDown: number, drawSec: number, drawLen: number, downSec: number, startOffZone: boolean) => {
    cycles++;
    drawDowns.push(tDown);
    if (startOffZone) outOfZone++;
    descentDraw.push(drawSec);
    descentDown.push(downSec);
    if (drawSec > longestS) longestS = drawSec;
    if (drawLen > longestMm) longestMm = drawLen;
  };
  const closeLead = () => {
    if (!leadOpen) return;
    leadOpen = false;
    const atSafe = shield.enabled && Math.abs(leadX - shield.safeX) < 0.01 && Math.abs(leadY - shield.safeY) < 0.01;
    if (leading.length >= 2 || (leading.length === 1 && atSafe)) warmupCycles = leading.length;
    else for (const l of leading) account(l.t, 0, 0, l.downS, l.offZone); // uma batida só é um ponto do desenho
  };
  const endDescent = () => {
    if (leadOpen && !curMoved && (leading.length === 0 || (same(curX, leadX) && same(curY, leadY)))) {
      leadX = curX;
      leadY = curY;
      leading.push({ t: curT, downS: curDownS, offZone: curStartOffZone });
      return;
    }
    closeLead();
    account(curT, curDrawS, curDrawMm, curDownS, curStartOffZone);
  };
  const unknown = (raw: string) => {
    unknownLines++;
    if (!firstUnknown) firstUnknown = raw.trim().slice(0, 30);
  };

  for (const raw of rawLines) {
    if (raw.length === 0) continue;
    nLines++;
    if (raw.length > maxLineLength) maxLineLength = raw.length;
    if (/[^\x09\x20-\x7e]/.test(raw)) nonAscii++;
    if (/^\s*;\s*CHECKPOINT\b/i.test(raw)) checkpoints++;
    // comentários: tudo depois de ";" e o que estiver entre parênteses (um "G4" citado ali não é pausa)
    const code = raw
      .split(";")[0]
      .replace(/\([^)]*\)?/g, " ")
      .trim()
      .toUpperCase();
    if (!code) continue;
    if (code[0] === "$") {
      configLines++;
      continue;
    }
    // sobrou alguma coisa que não é "letra + número"? (ex.: "XNaN": o GRBL responderia error:2)
    if (code.replace(WORD, "").trim() !== "") {
      unknown(raw);
      continue;
    }

    let isDwell = false, dwellP = 0;
    let wx: number | undefined, wy: number | undefined;
    let penCmd: "down" | "up" | undefined;
    let ends = false, bad = false;
    let m: RegExpExecArray | null;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(code))) {
      const v = Number(m[2]);
      switch (m[1]) {
        case "G":
          if (v === 0) motion = 0;
          else if (v === 1) motion = 1;
          else if (v === 4) isDwell = true;
          else if (v === 90) absolute = true;
          else if (v === 91) absolute = false;
          else if (!HARMLESS_G.has(v)) bad = true; // arcos, polegadas, G92, G28...: nada disso é conferido aqui
          break;
        case "M":
          if (v === 3 || v === 4) penCmd = "down";
          else if (v === 5) penCmd = "up";
          else if (v === 2 || v === 30) ends = true;
          else bad = true;
          break;
        case "X":
          wx = v;
          break;
        case "Y":
          wy = v;
          break;
        case "F":
          feed = v;
          break;
        case "P":
          dwellP = v;
          break;
        case "S":
          curS = v;
          // mudar o S com a caneta embaixo move o servo na hora
          if (penDown && expectedS !== undefined && v !== expectedS) wrongServoPosition++;
          break;
        case "N":
          break;
        default:
          bad = true; // Z, I, J, T...: fora do que a máquina de caneta usa
      }
    }
    const hasMove = wx !== undefined || wy !== undefined;
    if (bad || (isDwell && hasMove)) {
      unknown(raw);
      continue;
    }
    const validDwell = isDwell && dwellP >= MIN_SERVO_DWELL_S;

    // um comando de caneta anterior ainda esperava a pausa, e o que veio foi outra coisa
    if (pendingPen && (!validDwell || penCmd !== undefined)) penCmdsWithoutDwell++;
    // a pausa desta linha serve a quem? ao comando de caneta da linha anterior, se esta linha não trouxer outro
    const servedByDwell = pendingPen && penCmd === undefined ? pendingKind : undefined;
    pendingPen = false;

    // o GRBL executa nesta ordem dentro da linha: caneta, pausa, movimento
    if (penCmd === "down") {
      if (!penDown) {
        penDown = true;
        allDowns.push(t);
        curT = t;
        curX = x;
        curY = y;
        curDrawS = 0;
        curDrawMm = 0;
        curDownS = 0;
        curMoved = false;
        // onde a caneta encosta também é traço
        curStartOffZone = !Number.isNaN(x) && offZone(x, y);
        // sem o S certo o servo vai para outra altura (com S0, depois de um reset, nem desce)
        if (expectedS !== undefined && curS !== expectedS) wrongServoPosition++;
      }
      pendingPen = true;
      pendingKind = "down";
    } else if (penCmd === "up") {
      if (penDown) {
        penDown = false;
        endDescent();
      }
      pendingPen = true;
      pendingKind = "up";
    }
    if (isDwell) {
      const served = pendingPen ? pendingKind : servedByDwell;
      if (validDwell && served && dwellP < (served === "down" ? RULE_DWELL_DOWN_S : RULE_DWELL_UP_S) - 1e-9) shortDwells++;
      if (validDwell) pendingPen = false;
      dwellS += dwellP;
      if (!penDown && dwellP >= 2) restS += dwellP;
      if (penDown) {
        penDownS += dwellP;
        curDownS += dwellP;
      }
      t += dwellP;
    }
    if (hasMove) {
      if (pendingPen) {
        // "M5 G0 X0 Y0" na mesma linha: a máquina parte sem esperar o servo
        penCmdsWithoutDwell++;
        pendingPen = false;
      }
      const nx = wx === undefined ? x : absolute ? wx : x + wx;
      const ny = wy === undefined ? y : absolute ? wy : y + wy;
      if (Number.isNaN(nx) || Number.isNaN(ny)) {
        // Sem saber de onde a máquina parte (movimento relativo, ou um eixo que o arquivo nunca deu) não
        // dá para conferir este ponto. Com a caneta em cima e em coordenadas absolutas ainda é inofensivo.
        if (!absolute || penDown) unknown(raw);
        if (!Number.isNaN(nx)) x = nx;
        if (!Number.isNaN(ny)) y = ny;
        continue;
      }
      if (nx < -eps || ny < -eps || nx > workArea.width + eps || ny > workArea.height + eps) outOfArea++;
      const len = Number.isNaN(x) || Number.isNaN(y) ? 0 : Math.hypot(nx - x, ny - y);
      if (motion === 0) {
        if (penDown && len > eps) rapidsPenDown++;
        const dt = len / (AUDIT_TRAVEL_FEED / 60);
        travelMm += len;
        travelS += dt;
        t += dt;
        if (penDown) {
          penDownS += dt;
          curDownS += dt;
          if (len > eps) curMoved = true;
        }
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
          if (offZone(nx, ny)) outOfZone++;
        } else {
          travelMm += len;
          travelS += dt;
        }
      }
      x = nx;
      y = ny;
    }
    if (ends) {
      // M2/M30: o GRBL levanta a caneta e volta para G1/G90
      if (penDown) {
        penDown = false;
        endDescent();
      }
      pendingPen = false;
      motion = 1;
      absolute = true;
    }
  }
  if (penDown) endDescent();
  closeLead();

  // pico: mais ciclos em qualquer janela de 60 s (com o aquecimento: para o servo é ciclo do mesmo jeito)
  const peakOf = (times: readonly number[]) => {
    let best = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[i] - times[j] >= 60) j++;
      if (i - j + 1 > best) best = i - j + 1;
    }
    return best;
  };
  const peak = peakOf(allDowns);
  drawDowns.sort((a, b) => a - b);
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
  if (penCmdsWithoutDwell) err(`${n(penCmdsWithoutDwell)} comando(s) de caneta sem pausa (G4) logo depois: a máquina andaria antes de o servo chegar.`);
  if (maxLineLength > MAX_LINE_LENGTH) err(`Linha com ${maxLineLength} caracteres (o máximo é ${MAX_LINE_LENGTH}).`);
  if (nonAscii) err(`${n(nonAscii)} linha(s) com caractere fora de ASCII: o GRBL lê como comando.`);
  if (outOfArea) err(`${n(outOfArea)} ponto(s) fora do curso da máquina: o GRBL daria ALARM:2.`);
  if (outOfZone) err(`${n(outOfZone)} ponto(s) de traço fora da zona de desenho.`);
  if (unknownLines) err(`${n(unknownLines)} linha(s) que a conferência não sabe ler (a 1ª: "${firstUnknown}"): não dá para garantir o que a máquina faria.`);
  if (configLines) err(`${n(configLines)} linha(s) com comando "$": mexem na configuração do GRBL e não podem estar num desenho.`);
  if (wrongServoPosition) err(`${n(wrongServoPosition)} descida(s) com a altura do servo diferente de S${expectedS}: a caneta desceria errado, ou nem desceria.`);
  if (shortDwells) warn(`${n(shortDwells)} pausa(s) do servo mais curtas que a regra (${RULE_DWELL_DOWN_S} s depois de descer, ${RULE_DWELL_UP_S} s depois de subir).`);
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
    peakDrawCyclesPer60s: peakOf(drawDowns),
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
    unknownLines,
    configLines,
    wrongServoPosition,
    shortDwells,
    problems,
    ok: !problems.some((p) => p.level === "error"),
  };
}

/**
 * REGRAS_GCODE.md, seção 10: "nenhum traço perdido nem criado". Compara o que a auditoria LEU no texto
 * com o que o plano mandou desenhar: o número de descidas (com as duas batidas de cada checkpoint) tem
 * que ser exato, e o comprimento de traço tem que bater (com a folga do arredondamento em 0,01 mm).
 * Vale para o arquivo inteiro de um plano, não para uma parte nem para uma retomada.
 */
export function checkAgainstPlan(plan: Pick<JobPlan, "descents" | "stats">, report: AuditReport): AuditReport {
  const extra: AuditProblem[] = [];
  const n = (v: number) => v.toLocaleString("pt-BR");
  const cycles = plan.descents.length + 2 * plan.stats.checkpoints;
  if (report.cycles !== cycles) {
    extra.push({ level: "error", message: `O arquivo tem ${n(report.cycles)} descidas e o plano mandava ${n(cycles)}: algum traço foi perdido ou criado.` });
  }
  const tol = Math.max(1, plan.stats.drawMm * 0.005);
  if (Math.abs(report.drawMm - plan.stats.drawMm) > tol) {
    extra.push({ level: "error", message: `O arquivo risca ${n(Math.round(report.drawMm))} mm e o plano mandava ${n(Math.round(plan.stats.drawMm))} mm: o desenho não saiu inteiro no G-code.` });
  }
  return extra.length ? { ...report, problems: [...report.problems, ...extra], ok: false } : report;
}
