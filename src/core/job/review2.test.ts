/**
 * Segunda revisão independente do gerador de G-code (src/core/job) — 22/11/2026, madrugada.
 * Alvo: o que foi escrito ou reescrito DEPOIS da primeira revisão (review.test.ts): camadas e cruzes,
 * partes e retomada, agenda do servo com dois relógios, auditoria reescrita, mapa de tinta conservador,
 * corte de descida com MIN_TAIL_MM e a assinatura do plano.
 *
 * - "DEFEITO n": cada teste descreve o comportamento CERTO. Todos FALHAVAM no commit 01cc863 (a prova
 *   do defeito) e passam desde as correções da mesma noite; ficam de guarda. Os "hoje: ..." dizem o que
 *   o código daquele commit fazia. Estão em ordem de perigo para o desenho/máquina.
 * - "FIRME": áreas atacadas a fundo que se seguraram.
 *
 * A revisão foi feita por um revisor independente, que não alterou nenhum arquivo de código.
 * (Depois da correção do DEFEITO 7 o gerador não escreve mais "~" no comentário do checkpoint, e o
 * sorteio FIRME deixou de abrir exceção para ele.)
 *
 * O "replay" daqui lê o TEXTO do G-code sem usar nada de audit.ts: é a segunda opinião. Onde ele e a
 * auditoria discordam, isso também é um achado.
 */
import { describe, expect, it } from "vitest";
import { createDrawing, translateMachine, type Drawing, type PlotDocument } from "../document";
import { IDENTITY } from "../geometry/mat2d";
import { polylineLength } from "../geometry/simplify";
import { distToSegment, type Vec } from "../geometry/vec";
import { DEFAULT_PROFILE, validateProfile, type MachineProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS, type JobSettings } from "../store";
import { auditGcode, auditOptionsOf, checkAgainstPlan, type AuditReport } from "./audit";
import { chainTimes, makeBlock, type Block } from "./estimate";
import { generateGcode, type GcodeLine, type GcodeOptions } from "./gcode";
import { buildInkMap, isInked } from "./inkmap";
import { capDescents, MIN_TAIL_MM } from "./optimize";
import { planJob, planLayers } from "./pipeline";
import { planSignature, resumeDescent } from "./resume";
import { documentToStrokes } from "./strokes";
import { machineDrawing, makePlan, stroke } from "./testPlan";
import type { JobPlan, OrderedStroke, Stroke } from "./types";

const P = DEFAULT_PROFILE;
const JOB = DEFAULT_JOB_SETTINGS;
const META = { fileName: "revisao2.svg", date: new Date(2026, 10, 22, 3, 0), job: JOB };
/** drawingId das cruzes de registro (layers.ts, REGISTRATION_ID), escrito aqui de propósito. */
const CROSS_ID = "@registro";
type Poly = [number, number][];

const textOf = (plan: JobPlan, profile: MachineProfile = P, opts: GcodeOptions = {}) => generateGcode(plan, profile, { ...META, job: plan.job ?? JOB }, opts).lines.map((l) => l.text);
const hardErrors = (a: AuditReport) => a.problems.filter((p) => p.level === "error" && !p.message.startsWith("Servo")).map((p) => p.message);
const servoProblems = (a: AuditReport) => a.problems.filter((p) => p.message.startsWith("Servo")).map((p) => p.message);

/** Gerador pseudoaleatório com semente (mulberry32): os sorteios são sempre os mesmos. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================ replay independente

interface PenDown {
  /** "tap" = batida no ar (aquecimento, checkpoint); "draw" = descida de desenho (tem o G1 F) */
  kind: "tap" | "draw";
  /** instante do M3 pelo relógio do script de blindagem (traço a F, G0 a 3000 mm/min) */
  readonly tS: number;
  /** instante do M3 pelo relógio da máquina (rampa de aceleração, G0 na velocidade máxima) */
  readonly tA: number;
  readonly x: number;
  readonly y: number;
  /** caminho riscado: "x,y" de cada ponto, a começar por onde a caneta desceu */
  readonly path: string[];
  /** o F em vigor ao riscar até cada ponto de `path` (o 1º não tem) */
  readonly feeds: number[];
  /** índice da linha do M3 */
  readonly line: number;
  /** a pausa que veio depois do M3 */
  downDwell: number;
}

interface Replay {
  readonly errors: string[];
  readonly downs: PenDown[];
  readonly totalS: number;
  readonly totalA: number;
  /** tempo (relógio do script) do 1º G0 do arquivo: a auditoria não o conta (posição inicial desconhecida) */
  readonly firstTravelS: number;
  readonly drawMm: number;
  readonly checkpoints: number;
  /** linhas com "?", "!" ou "~": para o GRBL são comandos em tempo real, até dentro de comentário */
  readonly realtimeLines: string[];
}

const NUM = "(-?\\d+(?:\\.\\d+)?)";
const RE_G0 = new RegExp(`^G0 X${NUM} Y${NUM}$`);
const RE_PT = new RegExp(`^X${NUM} Y${NUM}(?: F(\\d+))?$`);
const RE_G4 = /^G4 P(\d+(?:\.\d+)?)$/;
const RE_G1F = /^G1 F(\d+)$/;

/**
 * Executa o TEXTO como a máquina, no dialeto estrito de docs/REGRAS_GCODE.md, seção 2:
 * cabeçalho G21 / G90 / M5 / G4; blocos G0 → M3 → G4 → G1 F → pontos → M5 → G4; rodapé; M2.
 * Qualquer linha fora disso é erro. Confere no caminho: G0 só com a caneta em cima; todo M3/M5 seguido
 * de G4 (0,3 s / 0,2 s no mínimo, e a pausa do perfil nas descidas de desenho); nada fora do curso;
 * linhas de até 69 caracteres, só ASCII. Cronometra pelos dois relógios.
 */
function replay(lines: readonly string[], profile: MachineProfile): Replay {
  const errors: string[] = [];
  const err = (i: number, msg: string) => {
    if (errors.length < 12) errors.push(`linha ${i + 1} "${lines[i] ?? ""}": ${msg}`);
  };
  const { width: W, height: H } = profile.workArea;
  const up = profile.pen.upCmd, down = profile.pen.downCmd;
  let x = profile.gcode.finalPosition.x, y = profile.gcode.finalPosition.y;
  let firstMove = true, firstTravelS = 0;
  let pen: "up" | "down" = "up";
  /** comando de caneta à espera do G4, e se ele fechou uma descida de desenho */
  let pending: "up" | "down" | undefined;
  let liftedDraw = false;
  let modalG1 = false;
  let feed = NaN;
  let tS = 0, tA = 0;
  let chain: Block[] = [];
  const flush = () => {
    if (chain.length) for (const dt of chainTimes(chain, profile)) tA += dt;
    chain = [];
  };
  const downs: PenDown[] = [];
  let cur: PenDown | undefined;
  let drawMm = 0, checkpoints = 0;
  let sawEnd = false;
  const key = (px: number, py: number) => `${px.toFixed(2)},${py.toFixed(2)}`;
  const code: number[] = [];
  const realtimeLines: string[] = [];
  lines.forEach((l, i) => {
    if (l.length > 69) err(i, `${l.length} caracteres`);
    if (!/^[\x20-\x7e]*$/.test(l)) err(i, "caractere fora de ASCII imprimível");
    if (/[?!~]/.test(l)) realtimeLines.push(l);
    if (!l.startsWith(";")) code.push(i);
    else if (/^; CHECKPOINT /.test(l)) checkpoints++;
  });
  if (code.slice(0, 4).map((i) => lines[i]).join("|") !== `G21|G90|${up}|G4 P0.3`) err(code[0] ?? 0, "cabeçalho diferente de G21 / G90 / M5 / G4 P0.3");
  for (const i of code) {
    const l = lines[i];
    if (sawEnd) err(i, "linha depois do M2");
    if (pending && !RE_G4.test(l)) err(i, `falta o G4 depois do comando de caneta (${pending})`);
    let m: RegExpExecArray | null;
    if (l === "G21" || l === "G90") {
      flush();
    } else if (l === "M2") {
      flush();
      if (pen === "down") err(i, "M2 com a caneta embaixo");
      sawEnd = true;
    } else if (l === down) {
      flush();
      if (pen === "down") err(i, "M3 com a caneta já embaixo");
      pen = "down";
      pending = "down";
      modalG1 = false;
      cur = { kind: "tap", tS, tA, x, y, path: [key(x, y)], feeds: [NaN], line: i, downDwell: 0 };
    } else if (l === up) {
      flush();
      liftedDraw = false;
      if (pen === "down" && cur) {
        if (cur.kind === "draw" && cur.downDwell < profile.pen.settleSeconds - 1e-9) err(cur.line, "descida de desenho com pausa menor que a do perfil");
        liftedDraw = cur.kind === "draw";
        downs.push(cur);
        cur = undefined;
      }
      pen = "up";
      pending = "up";
      modalG1 = false;
    } else if ((m = RE_G4.exec(l))) {
      flush();
      const p = Number(m[1]);
      if (pending === "down" && p < 0.3 - 1e-9) err(i, "pausa depois de descer menor que 0,3 s");
      if (pending === "up" && p < 0.2 - 1e-9) err(i, "pausa depois de subir menor que 0,2 s");
      if (pending === "up" && liftedDraw && p < profile.pen.settleUpSeconds - 1e-9) err(i, "subida de um traço com pausa menor que a do perfil");
      if (pending === "down" && cur) cur.downDwell = p;
      pending = undefined;
      tS += p;
      tA += p;
    } else if ((m = RE_G1F.exec(l))) {
      flush();
      if (pen !== "down") err(i, "G1 F com a caneta em cima");
      feed = Number(m[1]);
      modalG1 = true;
      if (cur) cur.kind = "draw";
    } else if ((m = RE_G0.exec(l))) {
      flush();
      const nx = Number(m[1]), ny = Number(m[2]);
      if (pen === "down") err(i, "G0 com a caneta embaixo");
      if (nx < 0 || ny < 0 || nx > W || ny > H) err(i, "fora do curso da máquina");
      const b = makeBlock({ x, y }, { x: nx, y: ny }, "rapid", profile);
      const dS = Math.hypot(nx - x, ny - y) / 50;
      if (firstMove) firstTravelS = dS;
      firstMove = false;
      tS += dS;
      tA += b ? chainTimes([b], profile)[0] : 0;
      x = nx;
      y = ny;
      modalG1 = false;
    } else if ((m = RE_PT.exec(l))) {
      const nx = Number(m[1]), ny = Number(m[2]);
      if (!modalG1 || pen !== "down") err(i, "ponto de traço fora de um bloco M3 / G4 / G1 F");
      if (m[3]) feed = Number(m[3]);
      if (!(feed > 0)) err(i, "traço sem velocidade");
      if (nx < 0 || ny < 0 || nx > W || ny > H) err(i, "fora do curso da máquina");
      const len = Math.hypot(nx - x, ny - y);
      if (len === 0) err(i, "ponto repetido");
      const b = makeBlock({ x, y }, { x: nx, y: ny }, feed, profile);
      if (b) chain.push(b);
      tS += len / (feed / 60);
      drawMm += len;
      x = nx;
      y = ny;
      firstMove = false;
      cur?.path.push(key(x, y));
      cur?.feeds.push(feed);
    } else err(i, "linha fora do dialeto das regras");
  }
  flush();
  if (!sawEnd) err(lines.length - 1, "arquivo sem M2");
  if (pen === "down") err(lines.length - 1, "arquivo termina com a caneta embaixo");
  if (pending) err(lines.length - 1, "comando de caneta sem G4 no fim");
  return { errors, downs, totalS: tS, totalA: tA, firstTravelS, drawMm, checkpoints, realtimeLines };
}

/** Mais descidas em qualquer janela de 60 s. */
function peak60(times: readonly number[]): number {
  let peak = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= 60) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return peak;
}

const f2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

/**
 * As descidas que o arquivo TEM de ter, na ordem, cada uma com o caminho riscado (arredondado como no
 * arquivo): o arquivo inteiro, uma parte, ou a retomada (a 1ª cruz de novo e depois da descida pedida
 * até o fim). Numa descida de corte longo (`relift`) a caneta re-desce onde o traço anterior parou.
 */
function expectedDescents(plan: JobPlan, opts: GcodeOptions, profile: MachineProfile): { path: string[]; feeds: number[]; cross: boolean }[] {
  const job = plan.job ?? JOB;
  const dynamic = job.speedMode === "dynamic";
  const ds = plan.descents;
  let chosen = [...ds];
  if (opts.fromDescent !== undefined && ds.length) {
    const from = Math.min(Math.max(Math.trunc(opts.fromDescent), 0), ds.length - 1);
    const firstIsCross = plan.strokes[ds[0].first]?.drawingId === CROSS_ID;
    chosen = [...(from > 0 && firstIsCross ? [ds[0]] : []), ...ds.slice(from)];
  } else if (opts.part !== undefined) chosen = ds.filter((d) => d.part === opts.part);
  return chosen.map((d) => {
    const path: string[] = [];
    // o F de cada trecho: fixo, o do trabalho; dinâmico, o do segmento no plano (a ligação de uma emenda
    // vai no F do 1º segmento do traço que começa; um ponto solto emendado, no F que já estava)
    const feeds: number[] = [];
    let lastF = dynamic ? (plan.strokes[d.first].feeds[0] ?? profile.feed.straight) : job.fixedFeed;
    const add = (p: Vec, f: number) => {
      const k = `${f2(p.x)},${f2(p.y)}`;
      if (path[path.length - 1] === k) return;
      path.push(k);
      lastF = dynamic ? f : job.fixedFeed;
      feeds.push(path.length === 1 ? NaN : Math.max(1, Math.round(lastF)));
    };
    if (d.relift && d.first > 0) {
      for (let i = d.first - 1; i >= 0; i--) {
        const pts = plan.strokes[i].points;
        if (pts.length) {
          add(pts[pts.length - 1], NaN);
          break;
        }
      }
    }
    for (let si = d.first; si <= d.last; si++) {
      const s = plan.strokes[si];
      s.points.forEach((p, j) => add(p, j === 0 ? (s.feeds[0] ?? lastF) : s.feeds[j - 1]));
    }
    return { path, feeds, cross: plan.strokes[d.first].drawingId === CROSS_ID };
  });
}

interface Verdict {
  readonly errors: string[];
  /** pico em 60 s de TODAS as descidas (aquecimento, reaquecimento, checkpoints e desenho), pelos dois relógios */
  readonly peakS: number;
  readonly peakA: number;
  /** ciclos do desenho (descidas + batidas de checkpoint) por minuto de arquivo, pelo relógio do script */
  readonly avgS: number;
  readonly cycles: number;
  readonly warm: number;
  readonly rep: Replay;
}

/** Confere um arquivo (inteiro, parte ou retomada) contra as regras e contra o plano, sem a auditoria. */
function judge(lines: readonly string[], plan: JobPlan, profile: MachineProfile, opts: GcodeOptions): Verdict {
  const rep = replay(lines, profile);
  const errors = [...rep.errors];
  const exp = expectedDescents(plan, opts, profile);
  const draws = rep.downs.filter((d) => d.kind === "draw");
  const taps = rep.downs.filter((d) => d.kind === "tap");
  if (draws.length !== exp.length) errors.push(`descidas de desenho: arquivo ${draws.length}, plano ${exp.length}`);
  const off = plan.layer?.offset ?? { x: 0, y: 0 };
  const z = profile.drawZone;
  const r = profile.registration;
  const h = r.armMm / 2;
  const eps = 0.006;
  const inZone = (px: number, py: number) => px >= z.minX - eps && px <= z.maxX + eps && py >= z.minY - eps && py <= z.maxY + eps;
  const inCross = (px: number, py: number) => [r.x1, r.x2].some((cx) => Math.abs(px - cx) <= h + eps && Math.abs(py - r.y) <= h + eps);
  for (let i = 0; i < Math.min(draws.length, exp.length); i++) {
    if (draws[i].path.join(" ") !== exp[i].path.join(" ")) {
      errors.push(`descida ${i}: arquivo [${draws[i].path.slice(0, 6).join(" ")}...] plano [${exp[i].path.slice(0, 6).join(" ")}...]`);
      break;
    }
    if (draws[i].feeds.slice(1).join(" ") !== exp[i].feeds.slice(1).join(" ")) {
      errors.push(`descida ${i}: velocidades do arquivo [${draws[i].feeds.slice(1, 8).join(" ")}...] plano [${exp[i].feeds.slice(1, 8).join(" ")}...]`);
      break;
    }
    for (const k of draws[i].path) {
      const [fx, fy] = k.split(",").map(Number);
      // a tinta cai no ponto do arquivo + desvio da ponta
      const px = fx + off.x, py = fy + off.y;
      if (inZone(px, py)) continue;
      if (!(exp[i].cross && plan.layer?.registration && inCross(px, py))) {
        errors.push(`descida ${i}: o ponto ${k} risca fora da zona de desenho`);
        break;
      }
    }
  }
  // batidas no ar: antes do 1º traço só no ponto seguro (aquecimento); depois, 2 por checkpoint, no fim do traço anterior
  const firstDraw = draws[0]?.line ?? Infinity;
  const lead = taps.filter((t) => t.line < firstDraw);
  const mid = taps.filter((t) => t.line > firstDraw);
  for (const t of lead) {
    if (Math.abs(t.x - profile.shield.safeX) > 0.005 || Math.abs(t.y - profile.shield.safeY) > 0.005) errors.push(`batida de aquecimento fora do ponto seguro (${t.x}, ${t.y})`);
  }
  if (mid.length !== 2 * rep.checkpoints) errors.push(`batidas no meio do desenho: ${mid.length}, checkpoints: ${rep.checkpoints}`);
  for (const t of mid) {
    const prev = [...draws].reverse().find((d) => d.line < t.line);
    if (!prev || prev.path[prev.path.length - 1] !== `${t.x.toFixed(2)},${t.y.toFixed(2)}`) errors.push(`batida de checkpoint fora do fim do traço anterior (${t.x}, ${t.y})`);
  }
  const cycles = draws.length + mid.length;
  return {
    errors,
    peakS: peak60(rep.downs.map((d) => d.tS)),
    peakA: peak60(rep.downs.map((d) => d.tA)),
    avgS: rep.totalS > 0 ? cycles / (rep.totalS / 60) : 0,
    cycles,
    warm: lead.length,
    rep,
  };
}

// ============================================================================ documentos de teste

const doc = (...drawings: Drawing[]): PlotDocument => ({ drawings });
/** n tracinhos de `len` mm numa grade, `step` mm entre vizinhos: cada um é uma descida. */
const dashes = (x0: number, y0: number, n: number, cols = 10, step = 6, len = 2): Poly[] =>
  Array.from({ length: n }, (_, i) => [[x0 + (i % cols) * step, y0 + Math.floor(i / cols) * step], [x0 + (i % cols) * step + len, y0 + Math.floor(i / cols) * step]] as Poly);
/** Traços longos que acabam no canto de lá da folha (o balde do servo enche) e depois 260 pontos colados no canto de cá. */
function longThenDots(): Poly[] {
  const polys: Poly[] = [];
  for (let i = 0; i < 4; i++) polys.push([[40, 360 - i * 2], [565, 360 - i * 2], [40, 361 - i * 2], [565, 361 - i * 2]]);
  polys.push([[40, 300], [569, 369]]);
  for (let i = 0; i < 260; i++) polys.push([[30.5 + (i % 60) * 0.9, 25.5 + Math.floor(i / 60) * 0.9], [30.5 + (i % 60) * 0.9 + 0.01, 25.5 + Math.floor(i / 60) * 0.9]]);
  return polys;
}

// ======================================================================================= DEFEITOS

describe("DEFEITO 1 — retomada: a assinatura do plano não muda quando o desenho muda de lugar (resume.ts, planSignature)", () => {
  // A assinatura só guarda: caneta, nº de traços, nº de descidas, mm (0,1), segundos (inteiros), 1º e último
  // ponto. Com cruzes de registro o 1º e o último ponto são sempre as cruzes. O sendPanel usa a assinatura
  // para decidir se o "Retomar de onde parou" guardado (localStorage) ainda vale.
  const resumeText = (plan: JobPlan, from: number) => textOf(plan, P, { fromDescent: from }).join("\n");
  const two = doc(machineDrawing("fino", dashes(100, 100, 30), "fina"), machineDrawing("grosso", dashes(100, 250, 30), "preta"));
  const three = doc(machineDrawing("a", dashes(60, 60, 30)), machineDrawing("b", dashes(200, 150, 30)), machineDrawing("c", dashes(400, 300, 30)));

  it("1a. duas canetas (cruzes de registro): o desenho inteiro 10 mm para o lado tem de mudar a assinatura das camadas", () => {
    const [a] = planLayers(two, P, JOB);
    const [b] = planLayers(translateMachine(two, ["fino", "grosso"], { x: 10, y: 0 }), P, JOB);
    expect(resumeText(b, 10)).not.toBe(resumeText(a, 10)); // são planos diferentes: a retomada risca noutro lugar
    // hoje: "fina|32|32|1320|84|16.00,12.00|576.00,12.00" nos dois (igual até com 30 mm de deslocamento)
    expect(planSignature(b)).not.toBe(planSignature(a));
  });

  it("1b. uma caneta, três desenhos: mover só o do meio 1 mm tem de mudar a assinatura", () => {
    const [a] = planLayers(three, P, JOB);
    const [b] = planLayers(translateMachine(three, ["b"], { x: 1, y: 0.5 }), P, JOB);
    expect(resumeText(b, 40)).not.toBe(resumeText(a, 40));
    // hoje: "preta|90|90|1800|198|60.00,60.00|456.00,312.00" nos dois
    expect(planSignature(b)).not.toBe(planSignature(a));
  });

  it("1c. o que a tela faz com isso: o ponto guardado é oferecido para o plano mudado, e a retomada risca fora do que já está no papel", () => {
    const [a] = planLayers(two, P, JOB);
    const [b] = planLayers(translateMachine(two, ["fino", "grosso"], { x: 10, y: 0 }), P, JOB);
    // parou na descida 21 do plano A (sendPanel.ts, finish): guarda { sig, descent }
    const saved = { sig: planSignature(a), descent: resumeDescent(a, a.descents[20].first)! };
    expect(saved.descent).toBe(19);
    // o usuário move o desenho; a tela decide (sendPanel.ts, resumeFor) se ainda oferece "Retomar de onde parou"
    const offered = saved.sig === planSignature(b) && saved.descent < b.descents.length;
    const sameInk = resumeText(b, saved.descent) === resumeText(a, saved.descent);
    // hoje: oferece, e o arquivo retoma 10 mm ao lado dos traços que já estão no papel
    expect(offered && !sameInk).toBe(false);
  });
});

describe("DEFEITO 2 — servo, modo 'esperar': com o pico colado na média o checkpoint estoura o pico e o arquivo reprova (schedule.ts)", () => {
  // O balde cabe max(1, pico − média − 1) fichas, mas a descida com checkpoint gasta 3 de uma vez
  // (spend(3) espera até ter 3, mesmo que o balde só caiba 1). "No máximo 20 por minuto" (20/20) é uma
  // escolha natural na tela de Configurações, e validateProfile aceita.
  const job = (): Poly[] => {
    const polys: Poly[] = [];
    for (let i = 0; i < 8; i++) polys.push([[40, 40 + i * 2], [540, 40 + i * 2], [40, 41 + i * 2]]); // ~16 min de linhas longas
    polys.push(...dashes(45, 100, 400, 80, 2, 0.8)); // e uma chuva de tracinhos
    return polys;
  };
  for (const [avg, peak] of [[20, 20], [20, 21]] as const) {
    it(`2. servo ${avg}/${peak}: o arquivo inteiro não pode ter mais de ${peak} descidas em 60 s, nem reprovar na auditoria`, () => {
      const prof: MachineProfile = { ...P, servo: { ...P.servo, avgPerMin: avg, peakPer60s: peak } };
      expect(validateProfile(prof)).toEqual([]);
      const [plan] = planLayers(doc(machineDrawing("a", job())), prof, JOB);
      expect(plan.stats.checkpoints).toBeGreaterThan(0);
      const lines = textOf(plan, prof);
      const v = judge(lines, plan, prof, {});
      expect(v.errors).toEqual([]);
      // hoje: 22 pelos dois relógios (3 do checkpoint + 19 em seguida)
      expect(Math.min(v.peakS, v.peakA)).toBeLessThanOrEqual(peak);
      // hoje: "Servo: pico de 22 ciclos em 60 s, acima do limite de 20." → exportar e enviar travam
      expect(servoProblems(auditGcode(lines, prof, auditOptionsOf(plan)))).toEqual([]);
    });
  }
});

describe("DEFEITO 3 — retomada: o descanso + reaquecimento passa 1 do pico quando a média é baixa (gcode.ts, 'need + 2')", () => {
  // O arquivo de retomada descansa até o balde ter o que a agenda contava MAIS as 2 batidas do
  // reaquecimento, ou seja, até 2 fichas acima do que o balde comporta (a folga do balde é de 1 só).
  // Com a média do perfil padrão (30) e com 20 o tempo das próprias batidas compensa e o arquivo fica
  // exatamente no pico (ver o FIRME do balde). Com médias mais baixas passa 1: medido em 15/30, 5/20 e,
  // com as cruzes de registro, 10/15.
  const resumePeaks = (prof: MachineProfile) => {
    const [plan] = planLayers(doc(machineDrawing("a", longThenDots())), prof, { ...JOB, optimize: false });
    let both = 0, audit = 0;
    const rejected: number[] = [];
    for (let f = 0; f < 40; f++) {
      const lines = textOf(plan, prof, { fromDescent: f });
      const v = judge(lines, plan, prof, { fromDescent: f });
      expect(v.errors, `retomada ${f}`).toEqual([]);
      both = Math.max(both, Math.min(v.peakS, v.peakA));
      const a = auditGcode(lines, prof, auditOptionsOf(plan));
      audit = Math.max(audit, a.peakCyclesPer60s);
      if (servoProblems(a).length) rejected.push(f);
    }
    return { both, audit, rejected };
  };

  it("3a. servo 10/15 com cruzes de registro: nenhuma retomada pode ter mais de 15 descidas em 60 s (pelos dois relógios)", () => {
    const prof: MachineProfile = { ...P, servo: { ...P.servo, avgPerMin: 10, peakPer60s: 15 }, shield: { ...P.shield, resyncMinutes: 0, partMinutes: 0 }, registration: { ...P.registration, mode: "always" } };
    expect(validateProfile(prof)).toEqual([]);
    // hoje: 16 (2 do reaquecimento + a cruz + 13 do desenho), retomando do 1º ponto depois dos traços longos
    expect(resumePeaks(prof).both).toBeLessThanOrEqual(15);
  });

  it("3b. servo 15/30: nenhuma retomada pode ser reprovada pela auditoria por causa do servo", () => {
    const prof: MachineProfile = { ...P, servo: { ...P.servo, avgPerMin: 15, peakPer60s: 30 }, shield: { ...P.shield, resyncMinutes: 0, partMinutes: 0 } };
    // hoje: a retomada da descida 10 (o 1º ponto) tem 31 em 60 s pela conta da auditoria: "A conferência
    // reprovou este arquivo" e o usuário não consegue retomar dali
    expect(resumePeaks(prof).rejected).toEqual([]);
  });
});

describe("DEFEITO 4 — blindagem desligada: desenho pequeno perto do canto da folha é reprovado por 'média do servo' (audit.ts × schedule.ts)", () => {
  // Um arquivo de 2 segundos com UMA descida dá "35 ciclos/min". A agenda não tem como evitar (não há
  // espera antes da 1ª descida), e o 1º G0 nem entra no relógio da auditoria (posição inicial
  // desconhecida), embora a agenda conte com ele para encher o balde.
  const off: MachineProfile = { ...P, shield: { ...P.shield, enabled: false } };
  const tiny = (k: number) => doc(machineDrawing("a", dashes(30, 25, k, 100, 1.5, 0.8)));

  it("4a. um tracinho de 0,8 mm no canto da folha (X30 Y25): a conferência tem de aprovar", () => {
    const [plan] = planLayers(tiny(1), off, JOB);
    expect(plan.descents.length).toBe(1);
    const lines = textOf(plan, off);
    expect(judge(lines, plan, off, {}).errors).toEqual([]);
    // hoje: "Servo: média de 35.5 ciclos/min, acima do limite de 30." → não baixa nem envia
    expect(checkAgainstPlan(plan, auditGcode(lines, off, auditOptionsOf(plan))).problems.filter((p) => p.level === "error")).toEqual([]);
  });

  it("4b. de 2 a 8 tracinhos no mesmo canto: idem", () => {
    const failed = [2, 3, 4, 6, 8].filter((k) => {
      const [plan] = planLayers(tiny(k), off, JOB);
      return !auditGcode(textOf(plan, off), off, auditOptionsOf(plan)).ok;
    });
    // hoje: todos reprovam (média de 35,1 / 33,0 / 32,0 / 31,1 / 30,7)
    expect(failed).toEqual([]);
  });

  it("4c. o mesmo mata a retomada perto do fim: 60 tracinhos, parou nos últimos, e nenhuma retomada pode ser reprovada", () => {
    // 60 tracinhos desenhados de longe para perto: os últimos ficam no canto da folha, a 40 mm de casa
    const d = doc(machineDrawing("a", dashes(30, 25, 60, 100, 1.5, 0.8).reverse()));
    const [plan] = planLayers(d, off, { ...JOB, optimize: false });
    expect(plan.descents.length).toBe(60);
    expect(auditGcode(textOf(plan, off), off, auditOptionsOf(plan)).ok).toBe(true); // o arquivo inteiro passa
    const rejected: string[] = [];
    for (let from = 40; from < 60; from++) {
      const a = auditGcode(textOf(plan, off, { fromDescent: from }), off, auditOptionsOf(plan));
      if (!a.ok) rejected.push(`r${from}: ${a.avgCyclesPerMin.toFixed(1)}/min`);
    }
    // hoje: as retomadas das últimas descidas reprovam ("A conferência reprovou este arquivo") e o usuário não tem como terminar o desenho por ali
    expect(rejected).toEqual([]);
  });
});

describe("DEFEITO 5 — auditoria: um ponto + o checkpoint seguinte, no começo de um arquivo sem aquecimento, viram 'aquecimento' (audit.ts)", () => {
  it("5a. retomada que começa num ponto, com checkpoint logo depois (aquecimento = 0): 3 descidas e 2 batidas de checkpoint, nenhum aquecimento", () => {
    const prof: MachineProfile = { ...P, shield: { ...P.shield, warmupCycles: 0, resyncMinutes: 1, partMinutes: 0 } };
    expect(validateProfile(prof)).toEqual([]);
    // um traço de quase 1 min, um ponto, e o checkpoint cai antes do ponto seguinte
    let plan: JobPlan | undefined;
    for (let L = 440; L <= 520 && !plan; L += 4) {
      const p = makePlan([stroke([[40, 40], [40 + L, 40]]), stroke([[100, 100]]), stroke([[110, 100]]), stroke([[120, 100], [130, 100]])], prof);
      if (p.descents[1].checkpoint === undefined && p.descents[2].checkpoint !== undefined) plan = p;
    }
    expect(plan, "plano com checkpoint na 3ª descida").toBeDefined();
    const lines = textOf(plan!, prof, { fromDescent: 1 });
    const v = judge(lines, plan!, prof, { fromDescent: 1 });
    expect(v.errors).toEqual([]);
    expect({ warm: v.warm, cycles: v.cycles }).toEqual({ warm: 0, cycles: 5 });
    const a = auditGcode(lines, prof);
    // hoje: { warm: 3, cycles: 2 }: o ponto do desenho e as 2 batidas do checkpoint (as três no mesmo
    // lugar, abrindo o arquivo) saem da conta dos ciclos, da média e da conferência da zona
    expect({ warm: a.warmupCycles, cycles: a.cycles }).toEqual({ warm: 0, cycles: 5 });
  });
});

describe("DEFEITO 6 — auditoria: lê os comentários de um jeito e o GRBL de outro (audit.ts)", () => {
  // No GRBL (protocol.c), dentro de "( ... )" o ";" é só mais um caractere do comentário, e depois do ")"
  // a linha CONTINUA. A auditoria corta no 1º ";" antes de tirar os parênteses, e perde o resto.
  // (O streamer.ts do próprio aplicativo faz na ordem certa.) Só atinge arquivo de fora: o gerador não
  // escreve parênteses fora de comentário.
  const HEAD = ["G21", "G90", "M5", "G4 P0.3"];
  it("6a. '(a;) G0 X300 Y300' com a caneta embaixo: o GRBL executa o G0, a auditoria tem de acusar", () => {
    const a = auditGcode([...HEAD, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "X110.00 Y100.00", "(a;) G0 X300.00 Y300.00", "M5", "G4 P0.2"], P);
    expect(a.rapidsPenDown).toBe(1); // hoje: 0
  });
  it("6b. 'G0 X100 (a ; b) Y900': o Y900 (fora do curso, ALARM:2) tem de ser visto", () => {
    const a = auditGcode([...HEAD, "G0 X100.00 (a ; b) Y900.00", "M3 S220", "G4 P0.3", "G1 F500", "X110.00 Y100.00", "M5", "G4 P0.2"], P);
    expect(a.outOfArea).toBe(1); // hoje: 0
  });
  it("6c. '!' e '?' num comentário são pausa e pedido de relatório para o GRBL (CLAUDE.md): a auditoria tem de acusar", () => {
    const a = auditGcode([...HEAD, "; atencao! conferir a caneta?", "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "X110.00 Y100.00", "M5", "G4 P0.2"], P);
    expect(hardErrors(a)).not.toEqual([]); // hoje: nenhum erro. A auditoria só olha para caracteres fora de ASCII.
  });
});

describe("DEFEITO 7 — o gerador escreve '~' (continuar, para o GRBL) no comentário de todo checkpoint (gcode.ts)", () => {
  // CLAUDE.md: "?, ! e ~ também nunca aparecem, nem em comentário". O gerador tira os três do nome do
  // arquivo e da caneta (toAsciiComment), mas escreve "(~10 min)" por conta própria.
  // ATENÇÃO, antes de corrigir: o texto vem de docs/REGRAS_GCODE.md, regra 13, e dos arquivos blindados
  // que já rodaram pelo LaserGRBL. O envio do próprio aplicativo tira os comentários (streamer.ts), então
  // só há risco com outro programa de envio que mande comentários: um "~" que chegue com a máquina em
  // pausa (feed hold) faz ela continuar sozinha. Decidir com o Artur; a referência para retomar é o
  // "; CHECKPOINT n", que não precisa do "~".
  it("7a. nenhum arquivo gerado tem '?', '!' ou '~', nem em comentário", () => {
    const plan = makePlan([stroke([[40, 40], [540, 40], [40, 41], [540, 42], [40, 43], [540, 44]]), stroke([[100, 100], [110, 100]]), stroke([[120, 100], [130, 100]])], { ...P, shield: { ...P.shield, resyncMinutes: 1 } });
    expect(plan.stats.checkpoints).toBeGreaterThan(0);
    // hoje: ["; CHECKPOINT 1 (~5 min) re-sincroniza servo"]
    expect(replay(textOf(plan), P).realtimeLines).toEqual([]);
  });
});

describe("DEFEITO 8 — as Configurações aceitam um aquecimento maior que o pico do servo, e aí TODO arquivo reprova (machine.ts, validateProfile)", () => {
  it("8a. servo 10/15 com 20 ciclos de aquecimento: ou o perfil é recusado, ou um desenho de um traço passa na conferência", () => {
    const prof: MachineProfile = { ...P, servo: { ...P.servo, avgPerMin: 10, peakPer60s: 15 }, shield: { ...P.shield, warmupCycles: 20 } };
    const refused = validateProfile(prof).length > 0;
    const [plan] = planLayers(doc(machineDrawing("a", [[[100, 100], [200, 100]]])), prof, JOB);
    const a = auditGcode(textOf(plan, prof), prof, auditOptionsOf(plan));
    // hoje: o perfil é aceito, e qualquer desenho dá "Servo: pico de 20 ciclos em 60 s, acima do limite de 15"
    // (as 20 batidas do aquecimento saem em 16 s, sem espera no meio)
    expect(refused || a.ok).toBe(true);
  });
});

// ========================================================================================== FIRME

// ------------------------------------------------------------------ sorteio de documentos e perfis

function randomPolys(r: () => number, box: { x0: number; y0: number; x1: number; y1: number }, budget: number): Poly[] {
  const out: Poly[] = [];
  const rx = () => box.x0 + r() * (box.x1 - box.x0);
  const ry = () => box.y0 + r() * (box.y1 - box.y0);
  const cx = (v: number) => Math.min(box.x1, Math.max(box.x0, v));
  const cy = (v: number) => Math.min(box.y1, Math.max(box.y0, v));
  while (out.length < budget) {
    const kind = r();
    if (kind < 0.18) {
      // linha longa
      out.push(Array.from({ length: 2 + Math.floor(r() * 5) }, () => [rx(), ry()] as [number, number]));
    } else if (kind < 0.45) {
      // rajada de tracinhos
      const n = 5 + Math.floor(r() * 60), pitch = 0.6 + r() * 4, len = 0.3 + r() * 2.5;
      const x0 = rx(), y0 = ry(), cols = 5 + Math.floor(r() * 20);
      for (let i = 0; i < n; i++) {
        const x = cx(x0 + (i % cols) * pitch), y = cy(y0 + Math.floor(i / cols) * pitch);
        out.push([[x, y], [cx(x + len), y]]);
      }
    } else if (kind < 0.62) {
      // pontos (um tracinho de 0,01 mm vira um ponto)
      const n = 5 + Math.floor(r() * 60), pitch = 0.5 + r() * 3;
      const x0 = rx(), y0 = ry(), cols = 5 + Math.floor(r() * 20);
      for (let i = 0; i < n; i++) {
        const x = cx(x0 + (i % cols) * pitch), y = cy(y0 + Math.floor(i / cols) * pitch);
        out.push([[x, y], [x + 0.01, y]]);
      }
    } else if (kind < 0.74) {
      // rabisco
      const pts: Poly = [[rx(), ry()]];
      for (let i = 1, n = 8 + Math.floor(r() * 40); i < n; i++) {
        const a = r() * Math.PI * 2, L = r() * 6;
        pts.push([cx(pts[i - 1][0] + Math.cos(a) * L), cy(pts[i - 1][1] + Math.sin(a) * L)]);
      }
      out.push(pts);
    } else if (kind < 0.84) {
      // hachura apertada (emendas por cima da tinta)
      const n = 4 + Math.floor(r() * 20), step = 0.3 + r() * 1.5, len = 10 + r() * 60;
      const x0 = rx(), y0 = ry();
      for (let i = 0; i < n; i++) {
        const y = cy(y0 + i * step);
        out.push(i % 2 === 0 ? [[x0, y], [cx(x0 + len), y]] : [[cx(x0 + len), y], [x0, y]]);
      }
    } else if (kind < 0.9) {
      // reta, meia-volta em arco e reta: no modo dinâmico o F muda no meio do traço
      const rad = [12, 25, 60, 80, 150][Math.floor(r() * 5)], len = 40 + r() * 100;
      const x0 = rx(), y0 = ry(), n = Math.max(8, Math.round((Math.PI * rad) / 3));
      const pts: Poly = [[x0, y0], [cx(x0 + len), y0]];
      for (let k = 1; k <= n; k++) pts.push([cx(x0 + len + rad * Math.sin((Math.PI * k) / n)), cy(y0 + rad - rad * Math.cos((Math.PI * k) / n))]);
      pts.push([x0, cy(y0 + 2 * rad)]);
      out.push(pts);
    } else if (kind < 0.95) {
      // tracinhos em cima de um traço, e repetidos (regra 4)
      const x = rx(), y = ry(), len = 0.4 + r() * 1.2;
      out.push([[x, y], [cx(x + 20 + r() * 30), y]]);
      for (let i = 0; i < 3; i++) out.push([[x + 2 + i * 3, y], [x + 2 + i * 3 + len, y]]);
      out.push([[x + 15, y], [x + 15 + len, y]], [[x + 15, y], [x + 15 + len, y]]);
    } else {
      // traço muito longo (corte de descida)
      const n = 6 + Math.floor(r() * 10);
      out.push(Array.from({ length: n }, (_, i) => [i % 2 === 0 ? box.x0 + r() * 20 : box.x1 - r() * 20, cy(box.y0 + (i * (box.y1 - box.y0)) / n)] as [number, number]));
    }
  }
  return out;
}

/** Formas FECHADAS: círculos (curvas, para a velocidade dinâmica), anéis colados (emenda sobre tinta), retângulos e lacinhos minúsculos. */
function randomLoops(r: () => number, box: { x0: number; y0: number; x1: number; y1: number }, count: number): Poly[] {
  const out: Poly[] = [];
  const ring = (cx: number, cy: number, rad: number, n: number): Poly => {
    const pts: Poly = Array.from({ length: n }, (_, k) => [cx + rad * Math.cos((2 * Math.PI * k) / n), cy + rad * Math.sin((2 * Math.PI * k) / n)] as [number, number]);
    pts.push(pts[0]);
    return pts;
  };
  while (out.length < count) {
    const kind = r();
    const rad = kind < 0.3 ? 0.05 + r() * 0.12 : 2 + r() * 30;
    const cx = box.x0 + rad + r() * Math.max(1, box.x1 - box.x0 - 2 * rad - 6), cy = box.y0 + rad + r() * Math.max(1, box.y1 - box.y0 - 2 * rad - 6);
    if (cx + rad + 3 > box.x1 || cy + rad + 3 > box.y1) continue;
    if (kind < 0.3) out.push(ring(cx, cy, rad, 8)); // lacinho com menos de 3 larguras de caneta de perímetro
    else if (kind < 0.6) out.push(ring(cx, cy, rad, 24 + Math.floor(r() * 100)));
    else if (kind < 0.8) {
      const step = 0.25 + r() * 0.3;
      for (let k = 0, n = 2 + Math.floor(r() * 4); k < n; k++) out.push(ring(cx, cy, rad + k * step, 60));
    } else out.push([[cx - rad, cy - rad / 2], [cx + rad, cy - rad / 2], [cx + rad, cy + rad / 2], [cx - rad, cy + rad / 2], [cx - rad, cy - rad / 2]]);
  }
  return out;
}

/** Desenho com polilinhas abertas e laços fechados, dados em mm da MÁQUINA. */
function shapesDrawing(id: string, open: Poly[], closed: Poly[], penId: string | undefined, H: number): Drawing {
  const sub = (pts: Poly, isClosed: boolean) => ({ start: { x: pts[0][0], y: H - pts[0][1] }, segments: pts.slice(1).map(([x, y]) => ({ kind: "line" as const, to: { x, y: H - y } })), closed: isClosed });
  return createDrawing(id, `${id}.svg`, { subpaths: [...open.map((p) => sub(p, false)), ...closed.map((p) => sub(p, true))] }, IDENTITY, penId);
}

/**
 * Perfil e documento sorteados. Ficam de FORA as combinações que já são defeito contado acima
 * (pico colado na média; média abaixo de 18; aquecimento 0; arquivo minúsculo com a blindagem desligada).
 */
function randomCase(r: () => number): { doc: PlotDocument; profile: MachineProfile; job: JobSettings } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const servo = pick([[30, 45], [30, 45], [20, 25], [20, 45], [60, 90], [45, 60], [30, 40]] as const);
  const shieldOn = r() < 0.85;
  const offs = pick([[1, 0], [1, 0], [1.125, 0.375], [-2.5, 0], [0, -1], [0, 0]] as const);
  const zone = pick([P.drawZone, P.drawZone, P.drawZone, { minX: 0, minY: 0, maxX: 810, maxY: 385 }, { minX: 100, minY: 50, maxX: 500, maxY: 300 }]);
  const profile: MachineProfile = {
    ...P,
    drawZone: zone,
    pen: { ...P.pen, ...(r() < 0.2 ? { settleSeconds: 0.35, settleUpSeconds: 0.25 } : {}) },
    servo: { ...P.servo, avgPerMin: servo[0], peakPer60s: servo[1], maxDescentMm: pick([900, 900, 200, 80]), onOverload: pick(["wait", "wait", "wait", "wait", "wait", "wait", "wait", "wait", "warn", "block"] as const) },
    shield: {
      ...P.shield,
      enabled: shieldOn,
      doubleLift: r() < 0.7,
      warmupCycles: pick([8, 8, 8, 1, 2, 12]),
      resyncMinutes: pick([0.25, 0.5, 1, 2, 10, 0]),
      partMinutes: pick([0.5, 1, 2, 5, 25, 0]),
      firstSettleSeconds: pick([0.6, 0.6, 1]),
      ...pick([{ safeX: 0, safeY: 0 }, { safeX: 0, safeY: 0 }, { safeX: 0, safeY: 0 }, { safeX: 5, safeY: 5 }, { safeX: 0, safeY: 380 }]),
    },
    pens: P.pens.map((p) => (p.id === "fina" ? { ...p, offsetX: offs[0], offsetY: offs[1] } : p.id === "verde" && r() < 0.3 ? { ...p, offsetX: -0.5, offsetY: 0.25 } : p)),
    // as cruzes ficam na borda (padrão) ou DENTRO da zona de desenho
    registration: { ...P.registration, mode: pick(["auto", "auto", "always", "never"] as const), ...(r() < 0.3 ? { x1: zone.minX + 20, x2: zone.maxX - 20, y: zone.minY + 10 } : {}) },
    gcode: { finalPosition: pick([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 400, y: 200 }, { x: 810, y: 385 }]) },
  };
  const job: JobSettings = pick([JOB, JOB, { ...JOB, speedMode: "dynamic" }, { ...JOB, speedMode: "dynamic" }, { ...JOB, fixedFeed: 250 }, { ...JOB, fixedFeed: 1500 }, { ...JOB, optimize: false }] as const);
  const nPens = 1 + Math.floor(r() * 3);
  const pens = ["preta", "fina", "verde"].slice(0, nPens);
  const drawings: Drawing[] = [];
  const small = shieldOn && r() < 0.2;
  for (let i = 0, n = nPens + Math.floor(r() * 2); i < n; i++) {
    const w = zone.maxX - zone.minX, hh = zone.maxY - zone.minY;
    const box = { x0: zone.minX + 5 + r() * w * 0.2, y0: zone.minY + 5 + r() * hh * 0.25, x1: zone.maxX - 5 - r() * w * 0.3, y1: zone.maxY - 5 - r() * hh * 0.3 };
    const polys = small ? randomPolys(r, box, 1).slice(0, 1 + Math.floor(r() * 5)) : randomPolys(r, box, 20 + Math.floor(r() * 180));
    // caneta escolhida, caneta que não existe mais ("sumiu"), ou nenhuma: as duas últimas vão na padrão
    const loops = small ? [] : randomLoops(r, box, Math.floor(r() * 12));
    drawings.push(shapesDrawing(`d${i}`, polys, loops, r() < 0.85 ? pens[i % nPens] : r() < 0.5 ? "sumiu" : undefined, P.workArea.height));
  }
  return { doc: { drawings }, profile, job };
}

describe("FIRME — sorteio: arquivo inteiro, cada parte e retomadas de várias descidas, pelo replay independente e pela auditoria", () => {
  // (22/11/2026: também rodado com as sementes 101 a 110, ~25 mil arquivos ao todo, sem nenhuma falha)
  for (const seed of [20261122, 7, 101]) {
    it(`semente ${seed}: formato, zona, traços iguais aos do plano, servo dentro do limite, e a auditoria concorda com o replay`, () => {
      const r = rng(seed);
      const stats = { plans: 0, files: 0, parts: 0, resumes: 0, checkpoints: 0, waits: 0, rests: 0, rewarm: 0, cross: 0, multi: 0, offset: 0, relift: 0, closed: 0, dynamicFeeds: 0 };
      for (let c = 0; c < 45; c++) {
        const { doc: d, profile, job } = randomCase(r);
        expect(validateProfile(profile)).toEqual([]);
        const plans = planLayers(d, profile, job);
        const tagCase = `caso ${c} [servo ${profile.servo.avgPerMin}/${profile.servo.peakPer60s} ${profile.servo.onOverload}, blindagem ${profile.shield.enabled}, aquecimento ${profile.shield.warmupCycles}, ${job.speedMode} F${job.fixedFeed}, otimizar ${job.optimize}]`;

        // E: cada desenho cai em exatamente UMA camada; a ordem das camadas é a do estojo; as cruzes abrem e fecham
        const penOfDrawing = (dr: Drawing) => (profile.pens.find((p) => p.id === dr.penId) ?? profile.pens.find((p) => p.id === profile.defaultPen)!).id;
        const order = profile.pens.map((p) => p.id).filter((id) => d.drawings.some((dr) => penOfDrawing(dr) === id));
        expect(plans.map((p) => p.layer?.penId), tagCase).toEqual(order);
        const all = documentToStrokes(d, profile);
        for (const plan of plans) {
          const mine = new Set(d.drawings.filter((dr) => penOfDrawing(dr) === plan.layer!.penId).map((dr) => dr.id));
          const body = plan.strokes.filter((s) => s.drawingId !== CROSS_ID);
          expect(body.every((s) => mine.has(s.drawingId)), `${tagCase}: traço de outra camada`).toBe(true);
          const crossAt = plan.strokes.map((s, i) => (s.drawingId === CROSS_ID ? i : -1)).filter((i) => i >= 0);
          expect(crossAt, tagCase).toEqual(plan.layer!.registration ? [0, plan.strokes.length - 1] : []);
          // nada some a não ser os tracinhos escondidos (cada um com menos de 3 larguras de caneta)
          const want = all.filter((s) => mine.has(s.drawingId)).reduce((a, s) => a + polylineLength(s.points), 0);
          const got = body.reduce((a, s) => a + polylineLength(s.points), 0);
          expect(got, `${tagCase}: comprimento da camada`).toBeLessThanOrEqual(want + 1e-6);
          expect(got, `${tagCase}: comprimento da camada`).toBeGreaterThanOrEqual(want - plan.stats.hiddenDropped * 3 * plan.layer!.penWidthMm - 1e-6);
        }

        for (const plan of plans) {
          expect(plan.violations, tagCase).toEqual([]);
          stats.plans++;
          stats.checkpoints += plan.stats.checkpoints;
          if ((plan.layer?.count ?? 1) > 1) stats.multi++;
          if (plan.layer && (plan.layer.offset.x !== 0 || plan.layer.offset.y !== 0)) stats.offset++;
          stats.relift += plan.descents.filter((x) => x.relift).length;
          stats.closed += plan.strokes.filter((x) => x.closed).length;
          const wait = profile.servo.onOverload === "wait";
          const N = plan.descents.length;
          const jobs: GcodeOptions[] = [{}];
          for (let p = 0; p < plan.stats.parts && plan.stats.parts > 1; p++) jobs.push({ part: p });
          const froms = new Set<number>([0, 1, 2, N - 1, N - 2]);
          for (let k = 0; k < 6; k++) froms.add(Math.floor(r() * N));
          plan.descents.forEach((x, i) => {
            if (x.checkpoint !== undefined && r() < 0.4) froms.add(i);
            if ((x.bucket ?? 0) > 3 && r() < 0.1) froms.add(i); // balde cheio: a retomada descansa e reaquece
          });
          for (const f of froms) if (f >= 0 && f < N) jobs.push({ fromDescent: f });
          for (const opts of jobs) {
            const tag = `${tagCase} camada ${plan.layer?.penId} ${opts.part !== undefined ? `parte ${opts.part}` : opts.fromDescent !== undefined ? `retomada ${opts.fromDescent}` : "inteiro"}`;
            const lines = generateGcode(plan, profile, { ...META, job }, opts).lines.map((l) => l.text);
            stats.files++;
            if (opts.part !== undefined) stats.parts++;
            if (opts.fromDescent !== undefined) stats.resumes++;
            if (lines.includes("; servo descansa antes de recomecar")) stats.rests++;
            if (lines.includes("; reaquece o servo")) stats.rewarm++;
            if (lines.includes("; cruz de registro em ida e volta")) stats.cross++;
            stats.waits += lines.filter((l) => l === "; descanso do servo").length;
            if (opts.part === undefined && opts.fromDescent === undefined) stats.dynamicFeeds += lines.filter((l) => /^X.* F\d+$/.test(l)).length;

            // A: o replay independente (formato, G0, G4, zona, curso, 69 caracteres, ASCII, traços = plano)
            const v = judge(lines, plan, profile, opts);
            expect(v.errors, tag).toEqual([]);
            // (o "~" do comentário do checkpoint é o DEFEITO 7; fora dele, nenhum "?", "!" ou "~")
            expect(v.rep.realtimeLines, tag).toEqual([]);

            // B: a auditoria aprova, e conta igual ao replay
            let a = auditGcode(lines, profile, auditOptionsOf(plan));
            if (opts.part === undefined && opts.fromDescent === undefined) a = checkAgainstPlan(plan, a);
            expect(hardErrors(a), tag).toEqual([]);
            expect({ ciclos: a.cycles, aquecimento: a.warmupCycles, checkpoints: a.checkpoints, pico: a.peakCyclesPer60s }, tag).toEqual({ ciclos: v.cycles, aquecimento: v.warm, checkpoints: v.rep.checkpoints, pico: v.peakS });
            expect(Math.abs(a.drawMm - v.rep.drawMm), tag).toBeLessThan(1e-6);
            expect(Math.abs(a.totalS - (v.rep.totalS - v.rep.firstTravelS)), tag).toBeLessThan(1e-6);

            // C: no modo "esperar", o servo fica dentro do limite pelos dois relógios (aquecimento e reaquecimento incluídos)
            if (wait) {
              const { avgPerMin, peakPer60s } = profile.servo;
              // (sem a blindagem não há os 8 s de aquecimento, e a MÉDIA de uma parte ou retomada curta estoura: DEFEITO 4)
              const shortNoShield = !profile.shield.enabled && (opts.part !== undefined || opts.fromDescent !== undefined);
              expect(servoProblems(a).filter((m) => !(shortNoShield && m.includes("média"))), tag).toEqual([]);
              expect(v.peakS, `${tag}: pico pelo relógio do script`).toBeLessThanOrEqual(peakPer60s);
              expect(v.peakA, `${tag}: pico pelo relógio da máquina`).toBeLessThanOrEqual(peakPer60s);
              if (!shortNoShield) expect(v.avgS, `${tag}: média`).toBeLessThanOrEqual(avgPerMin * 1.02 + 0.05);
            }
          }
        }
      }
      // o sorteio exercitou o que interessa
      expect(stats.files).toBeGreaterThan(1200);
      expect(stats.parts).toBeGreaterThan(100);
      expect(stats.resumes).toBeGreaterThan(900);
      expect(stats.checkpoints).toBeGreaterThan(300);
      expect(stats.waits).toBeGreaterThan(20000);
      expect(stats.rests).toBeGreaterThan(300);
      expect(stats.rewarm).toBeGreaterThan(150);
      expect(stats.cross).toBeGreaterThan(400);
      expect(stats.multi).toBeGreaterThan(30);
      expect(stats.offset).toBeGreaterThan(10);
      expect(stats.relift).toBeGreaterThan(100);
      expect(stats.closed).toBeGreaterThan(200);
      expect(stats.dynamicFeeds).toBeGreaterThan(40);
    }, 120_000);
  }
});

describe("FIRME — balde do servo em partes e retomadas: dentro do pico, mas SEM folga nenhuma (schedule.ts + gcode.ts)", () => {
  it("perfil padrão (30/45) e 20/25, balde cheio, salto longo e rajada de pontos: toda retomada e toda parte ficam dentro do pico pelos dois relógios", () => {
    for (const [avg, peak] of [[30, 45], [20, 25], [20, 45]] as const) {
      for (const registration of ["never", "always"] as const) {
        const prof: MachineProfile = { ...P, servo: { ...P.servo, avgPerMin: avg, peakPer60s: peak }, registration: { ...P.registration, mode: registration } };
        const [plan] = planLayers(doc(machineDrawing("a", longThenDots())), prof, { ...JOB, optimize: false });
        let worst = 0;
        const files: GcodeOptions[] = [{}, ...Array.from({ length: plan.stats.parts }, (_, part) => ({ part })), ...Array.from({ length: 60 }, (_, fromDescent) => ({ fromDescent }))];
        for (const opts of files) {
          const lines = textOf(plan, prof, opts);
          const v = judge(lines, plan, prof, opts);
          expect(v.errors).toEqual([]);
          expect(servoProblems(auditGcode(lines, prof, auditOptionsOf(plan)))).toEqual([]);
          worst = Math.max(worst, v.peakS, v.peakA);
        }
        // 22/11/2026: o pior caso (retomar do 1º ponto depois dos traços longos: descanso + 2 batidas de
        // reaquecimento + rajada) dá exatamente o pico: 45, 25 e 45. Uma ficha a mais e reprova.
        expect(worst).toBeLessThanOrEqual(peak);
        expect(worst).toBeGreaterThanOrEqual(peak - 1);
      }
    }
  }, 120_000);
});

describe("FIRME — regra 4, tracinhos retirados: o que some está mesmo coberto pela tinta que fica (pipeline.ts + inkmap.ts)", () => {
  /** Cena pequena: tinta de base (linhas, hachura apertada, rabisco) e tracinhos curtos por cima, ao lado e nas pontas. */
  function scene(r: () => number, w: number): { id: string; pts: Poly }[] {
    const polys: { id: string; pts: Poly }[] = [];
    const x0 = 100, y0 = 100;
    for (let i = 0, nb = 1 + Math.floor(r() * 4); i < nb; i++) {
      const k = r();
      if (k < 0.5) polys.push({ id: `b${i}`, pts: [[x0 + r() * 3, y0 + r() * 6], [x0 + 5 + r() * 5, y0 + r() * 6]] });
      else if (k < 0.8) {
        const y = y0 + r() * 5, step = (0.6 + r() * 0.8) * w;
        for (let j = 0; j < 4; j++) polys.push({ id: `b${i}_${j}`, pts: [[x0 + 1, y + j * step], [x0 + 8, y + j * step]] });
      } else {
        const pts: Poly = [[x0 + r() * 8, y0 + r() * 6]];
        for (let j = 0; j < 5; j++) pts.push([x0 + r() * 8, y0 + r() * 6]);
        polys.push({ id: `b${i}`, pts });
      }
    }
    for (let i = 0, ns = 3 + Math.floor(r() * 12); i < ns; i++) {
      const base = polys[Math.floor(r() * polys.length)].pts;
      const j = 1 + Math.floor(r() * (base.length - 1));
      const t = r() * 1.1 - 0.05;
      const bx = base[j - 1][0] + (base[j][0] - base[j - 1][0]) * t, by = base[j - 1][1] + (base[j][1] - base[j - 1][1]) * t;
      const ang = r() < 0.6 ? Math.atan2(base[j][1] - base[j - 1][1], base[j][0] - base[j - 1][0]) + (r() - 0.5) * 0.3 : r() * Math.PI * 2;
      const len = r() < 0.3 ? 0.01 : 0.06 + r() * 2.8 * w;
      const ox = (r() - 0.5) * 0.75 * w, oy = (r() - 0.5) * 0.75 * w;
      polys.push({ id: `s${i}`, pts: [[bx + ox, by + oy], [bx + ox + Math.cos(ang) * len, by + oy + Math.sin(ang) * len]] });
    }
    return polys;
  }

  for (const penId of ["preta", "fina"]) {
    it(`caneta ${penId}: 300 cenas sorteadas, nenhum tracinho retirado deixa mais de 0,1 mm de risco para fora da tinta que sobrou`, () => {
      const r = rng(77);
      const w = P.pens.find((p) => p.id === penId)!.widthMm;
      let dropped = 0, worst = 0;
      for (let c = 0; c < 300; c++) {
        const polys = scene(r, w);
        const [plan] = planLayers(doc(...polys.map((p) => machineDrawing(p.id, [p.pts], penId))), P, JOB);
        expect(plan.violations).toEqual([]);
        const off = plan.layer!.offset;
        const kept = new Set(plan.strokes.map((s) => s.drawingId));
        // a tinta que o plano risca, no papel: os traços e as ligações das emendas
        const segs: [Vec, Vec][] = [];
        let prev: Vec | undefined;
        for (const s of plan.strokes) {
          const pts = s.points.map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
          if (s.joinedToPrevious && prev) segs.push([prev, pts[0]]);
          if (pts.length === 1) segs.push([pts[0], pts[0]]);
          for (let j = 1; j < pts.length; j++) segs.push([pts[j - 1], pts[j]]);
          prev = pts[pts.length - 1];
        }
        const distInk = (p: Vec) => segs.reduce((d, [a, b]) => Math.min(d, distToSegment(p, a, b)), Infinity);
        for (const p of polys) {
          if (kept.has(p.id)) continue;
          dropped++;
          const [a, b] = p.pts;
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.01));
          for (let k = 0; k <= n; k++) {
            const cx = a[0] + ((b[0] - a[0]) * k) / n, cy = a[1] + ((b[1] - a[1]) * k) / n;
            // a borda do risco do tracinho retirado: quanto dela fica para fora da tinta que sobrou
            for (let q = 0; q < 24; q++) worst = Math.max(worst, distInk({ x: cx + (Math.cos((q * Math.PI) / 12) * w) / 2, y: cy + (Math.sin((q * Math.PI) / 12) * w) / 2 }) - w / 2);
          }
        }
      }
      // 22/11/2026: preta, 943 retirados, pior sobra 0,085 mm (a folga do código é 0,075 + a grade); fina, 0,02 mm
      expect(dropped).toBeGreaterThan(100);
      expect(worst).toBeLessThanOrEqual(0.1);
    }, 120_000);
  }
});

describe("FIRME — mapa de tinta conservador: nunca vê tinta onde há papel (inkmap.ts)", () => {
  it("60 mapas sorteados (canetas de 0,1 a 0,8 mm, grade forçada mais grossa em metade): todo ponto 'com tinta' está a até meia caneta de um traço", () => {
    const r = rng(5);
    let inked = 0;
    for (let c = 0; c < 60; c++) {
      const pen = [0.1, 0.2, 0.4, 0.8][Math.floor(r() * 4)];
      const strokes: Stroke[] = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({
        points: Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({ x: 100 + r() * 4, y: 100 + r() * 4 })),
        closed: false,
        drawingId: "d",
      }));
      // com poucas células a grade engrossa até o limite (35% da caneta); acima disso não há mapa
      const m = buildInkMap(strokes, pen, r() < 0.5 ? undefined : 4000 + Math.floor(r() * 40000));
      if (!m) continue;
      for (let k = 0; k < 4000; k++) {
        const p = { x: 99.5 + r() * 5, y: 99.5 + r() * 5 };
        if (!isInked(m, p)) continue;
        inked++;
        let d = Infinity;
        for (const s of strokes) {
          if (s.points.length === 1) d = Math.min(d, Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y));
          for (let j = 1; j < s.points.length; j++) d = Math.min(d, distToSegment(p, s.points[j - 1], s.points[j]));
        }
        expect(d).toBeLessThanOrEqual(pen / 2 + 1e-9);
      }
    }
    expect(inked).toBeGreaterThan(2000);
  });
});

describe("FIRME — corte de descida longa com MIN_TAIL_MM: o caminho não muda (optimize.ts, capDescents)", () => {
  it("3000 cadeias sorteadas: os pedaços, emendados, refazem ponto por ponto o traço original; só há 'relift' onde houve corte", () => {
    const r = rng(11);
    let cuts = 0, tails = 0;
    for (let c = 0; c < 3000; c++) {
      const max = [5, 10, 25, 100, 900][Math.floor(r() * 5)];
      const strokes: OrderedStroke[] = [];
      let cur = { x: 100, y: 100 };
      for (let i = 0, n = 1 + Math.floor(r() * 6); i < n; i++) {
        const joined = i > 0 && r() < 0.6;
        const pts: Vec[] = [joined ? { x: cur.x + (r() - 0.5) * (r() < 0.2 ? 6 : 0.5), y: cur.y + (r() - 0.5) * 0.5 } : { x: 50 + r() * 400, y: 50 + r() * 300 }];
        for (let k = 0, m = r() < 0.15 ? 0 : 1 + Math.floor(r() * 5); k < m; k++) {
          // comprimentos colados no limite: exatamente o limite, o limite + um restinho menor/maior que MIN_TAIL_MM
          const L = r() < 0.1 ? 0 : r() < 0.4 ? max * (1 + Math.floor(r() * 2)) + (r() < 0.5 ? 0 : (r() - 0.3) * 2 * MIN_TAIL_MM) : r() * max * 1.7;
          const ang = r() * Math.PI * 2, prev = pts[pts.length - 1];
          pts.push({ x: prev.x + Math.cos(ang) * Math.max(0, L), y: prev.y + Math.sin(ang) * Math.max(0, L) });
        }
        strokes.push({ points: pts, closed: false, drawingId: `s${i}`, joinedToPrevious: joined });
        cur = pts[pts.length - 1];
      }
      const out = capDescents(strokes, max);
      // cada traço original = os seus pedaços, na ordem, cada pedaço começando onde o anterior parou
      let oi = 0;
      for (const s of strokes) {
        const pieces: OrderedStroke[] = [];
        while (oi < out.length && out[oi].drawingId === s.drawingId) pieces.push(out[oi++]);
        expect(pieces.length).toBeGreaterThan(0);
        expect(pieces[0].joinedToPrevious).toBe(s.joinedToPrevious);
        if (pieces[0].relift) expect(s.joinedToPrevious).toBe(true);
        const path: Vec[] = [...pieces[0].points];
        for (let k = 1; k < pieces.length; k++) {
          cuts++;
          expect(pieces[k].relift && pieces[k].joinedToPrevious).toBe(true);
          expect(pieces[k].points[0]).toEqual(path[path.length - 1]);
          expect(pieces[k].points.length).toBeGreaterThan(1);
          path.push(...pieces[k].points.slice(1));
        }
        // o caminho dos pedaços passa por todos os pontos do original, na ordem, e os pontos a mais ficam EM CIMA dele
        let j = 0;
        for (const p of path) {
          if (j < s.points.length && Math.hypot(p.x - s.points[j].x, p.y - s.points[j].y) < 1e-9) j++;
          else expect(distToSegment(p, s.points[j - 1], s.points[Math.min(j, s.points.length - 1)])).toBeLessThan(1e-6);
        }
        expect(j).toBe(s.points.length);
        expect(Math.abs(polylineLength(path) - polylineLength(s.points))).toBeLessThan(1e-6);
        const last = pieces[pieces.length - 1];
        if (pieces.length > 1 && polylineLength(last.points) < MIN_TAIL_MM) tails++;
      }
      expect(oi).toBe(out.length);
    }
    expect(cuts).toBeGreaterThan(1500);
    // um pedaço final menor que MIN_TAIL_MM só existe quando a descida continua noutro traço emendado
    expect(tails).toBeLessThan(cuts);
  }, 60_000);
});

describe("FIRME — de onde retomar: a linha em que a máquina parou nunca faz pular uma descida (resume.ts + a conta do sendPanel)", () => {
  /** A mesma conta de sendPanel.ts (progressPoint): linha atual → traço (num deslocamento, o próximo traço). */
  const strokeAt = (lines: readonly GcodeLine[], line: number): number | undefined => {
    for (let i = line; i < lines.length; i++) if (lines[i].strokeIndex >= 0) return lines[i].strokeIndex;
    return undefined;
  };

  it("arquivo inteiro, cada parte e retomadas (com e sem cruz refeita): parando em QUALQUER linha, a retomada é a descida anterior à que estava em curso", () => {
    const prof: MachineProfile = { ...P, servo: { ...P.servo, maxDescentMm: 200 }, shield: { ...P.shield, resyncMinutes: 0.5, partMinutes: 1 } };
    const polys: Poly[] = [[[40, 40], [540, 40], [40, 60], [540, 80]], ...dashes(60, 100, 60, 12, 5, 2), [[50, 200], [500, 200], [50, 210]], ...dashes(60, 250, 40, 10, 3, 0.01)];
    const two = doc(machineDrawing("a", polys, "preta"), machineDrawing("b", dashes(300, 300, 10), "fina"));
    let checked = 0, parts = 0, crossRedone = 0;
    for (const plan of [...planLayers(two, prof, JOB), planJob(doc(machineDrawing("a", polys)), prof, JOB)]) {
      parts += plan.stats.parts;
      const N = plan.descents.length;
      const descentOf = (si: number) => plan.descents.findIndex((d) => si >= d.first && si <= d.last);
      const files: GcodeOptions[] = [{}, ...Array.from({ length: plan.stats.parts }, (_, part) => ({ part })), { fromDescent: 1 }, { fromDescent: 17 }, { fromDescent: N - 1 }];
      for (const opts of files) {
        const lines = generateGcode(plan, prof, META, opts).lines;
        if (opts.fromDescent !== undefined && lines.filter((l) => l.text === "; cruz de registro em ida e volta").length === 2) crossRedone++;
        let lastStroke = -1;
        for (let L = 0; L < lines.length; L++) {
          const si = strokeAt(lines, L);
          if (si === undefined) break; // rodapé: o desenho acabou
          if (si > lastStroke) lastStroke = si; // sendPanel.ts: job.lastStroke só anda para a frente
          const doing = descentOf(lastStroke);
          expect(doing).toBeGreaterThanOrEqual(0);
          // (na cruz refeita de uma retomada, `doing` é 0: nada novo a guardar, vale o ponto antigo)
          expect(resumeDescent(plan, lastStroke)).toBe(doing > 0 ? doing - 1 : undefined);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
    expect(parts).toBeGreaterThan(6);
    expect(crossRedone).toBeGreaterThan(2);
  });
});

describe("FIRME — camadas: casos de borda (layers.ts + pipeline.ts)", () => {
  const A: Poly = [[100, 100], [200, 100]];
  const B: Poly = [[100, 150], [200, 150]];

  it("cruzes de registro DENTRO da zona de desenho: plano sem violação, e a auditoria aprova com ou sem saber das cruzes", () => {
    const prof: MachineProfile = { ...P, registration: { ...P.registration, mode: "always", x1: 60, x2: 500, y: 40 } };
    expect(validateProfile(prof)).toEqual([]);
    const plan = planJob(doc(machineDrawing("a", [A])), prof, JOB);
    expect(plan.violations).toEqual([]);
    const lines = textOf(plan, prof);
    expect(judge(lines, plan, prof, {}).errors).toEqual([]);
    expect(auditGcode(lines, prof, auditOptionsOf(plan)).ok).toBe(true);
    expect(auditGcode(lines, prof).outOfZone).toBe(0);
  });

  it("desvio da ponta que empurra a CRUZ para fora do curso da máquina: violação com o nome da cruz, e o gerador recusa (não corta em X0)", () => {
    const prof: MachineProfile = { ...P, pens: P.pens.map((p) => (p.id === "fina" ? { ...p, offsetX: 18 } : p)) };
    expect(validateProfile(prof)).toEqual([]);
    const [fina, preta] = planLayers(doc(machineDrawing("f", [A], "fina"), machineDrawing("g", [B], "preta")), prof, JOB);
    expect(fina.violations.map((v) => [v.drawingId, v.kind])).toEqual([[CROSS_ID, "area"]]);
    expect(() => generateGcode(fina, prof, META)).toThrow();
    expect(preta.violations).toEqual([]); // a outra camada não tem culpa
  });

  it("camada sem traço nenhum (desenho vazio noutra caneta): o arquivo só tem as cruzes e passa; sem cruzes, só o aquecimento", () => {
    const empty: Drawing = { ...machineDrawing("vazio", [A], "verde"), geometry: { subpaths: [] } };
    const d = doc(empty, machineDrawing("g", [B], "preta"));
    const [verde, preta] = planLayers(d, P, JOB);
    expect([verde.layer?.penId, verde.descents.length, preta.descents.length]).toEqual(["verde", 2, 3]);
    const lines = textOf(verde);
    expect(judge(lines, verde, P, {}).errors).toEqual([]);
    expect(checkAgainstPlan(verde, auditGcode(lines, P, auditOptionsOf(verde))).ok).toBe(true);
    const never: MachineProfile = { ...P, registration: { ...P.registration, mode: "never" } };
    const [v2] = planLayers(d, never, JOB);
    expect(v2.descents.length).toBe(0);
    expect(checkAgainstPlan(v2, auditGcode(textOf(v2, never), never, auditOptionsOf(v2))).ok).toBe(true);
    // retomar um plano sem descidas não quebra
    expect(() => generateGcode(v2, never, META, { fromDescent: 3 })).not.toThrow();
  });

  it("caneta apagada do estojo, caneta nenhuma e caneta padrão: tudo numa camada só, sem cruzes e sem traço repetido", () => {
    const plans = planLayers(doc(machineDrawing("a", [A], "sumiu"), machineDrawing("b", [B]), machineDrawing("c", [[[100, 200], [200, 200]]], "preta")), P, JOB);
    expect(plans.length).toBe(1);
    expect(plans[0].strokes.map((s) => s.drawingId).sort()).toEqual(["a", "b", "c"]);
    expect(plans[0].layer).toMatchObject({ penId: "preta", count: 1, registration: false });
  });
});
