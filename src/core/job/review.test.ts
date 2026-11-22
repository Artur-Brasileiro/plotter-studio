/**
 * Revisão do gerador de G-code (src/core/job) contra docs/REGRAS_GCODE.md — 22/11/2026.
 *
 * - "DEFEITO n": cada teste descreve o comportamento CERTO. Todos FALHAVAM no commit 1f5e478
 *   (22/11/2026, 01:08): é a prova do defeito. Corrigido o código, o teste passa e fica de guarda.
 *   Os "hoje: ..." nos comentários dizem o que o código daquele commit fazia.
 * - "FIRME": áreas sondadas a fundo que se seguraram. Estes testes passam.
 *
 * Esta revisão não alterou nenhum arquivo de código. Enquanto houver defeito aberto, `npm test`
 * fica vermelho por causa deste arquivo, de propósito.
 */
import { describe, expect, it } from "vitest";
import { addDrawing, createDrawing, EMPTY_DOCUMENT, machineBBox, setMachineRotation, translateMachine, type PlotDocument } from "../document";
import { distToSegment, type Vec } from "../geometry/vec";
import { DEFAULT_PROFILE, type MachineProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS, type JobSettings } from "../store";
import { auditGcode, type AuditReport } from "./audit";
import { chainTimes, makeBlock, type Block } from "./estimate";
import { generateGcode, MAX_LINE_LENGTH } from "./gcode";
import { bridgeIsHidden, buildInkMap } from "./inkmap";
import { capDescents, MIN_TAIL_MM, orderStrokes } from "./optimize";
import { planJob } from "./pipeline";
import { groupDescents } from "./schedule";
import { assignFeeds } from "./speed";
import { makePlan, stroke } from "./testPlan";
import type { JobPlan, OrderedStroke, PlannedStroke, Stroke } from "./types";

const P = DEFAULT_PROFILE;
const PEN = 0.4;
const H = P.workArea.height;
const DYNAMIC: JobSettings = { ...DEFAULT_JOB_SETTINGS, speedMode: "dynamic" };
const meta = { fileName: "x.svg", date: new Date(2026, 10, 14, 12, 0), job: DEFAULT_JOB_SETTINGS };
const V = (x: number, y: number): Vec => ({ x, y });
const line = (...pts: [number, number][]): Stroke => ({ points: pts.map(([x, y]) => V(x, y)), closed: false, drawingId: "d" });
const plen = (pts: readonly Vec[]) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
const textOf = (plan: JobPlan, profile: MachineProfile = P, m = meta, part?: number) =>
  generateGcode(plan, profile, m, part === undefined ? {} : { part }).lines.map((l) => l.text);

// ------------------------------------------------------------------------------------ auxiliares

/** Documento com polilinhas dadas em mm da MÁQUINA (a cena tem Y para baixo: y_cena = altura − y). */
function docOf(polys: [number, number][][], closed: boolean[] = []): PlotDocument {
  const subpaths = polys.map((pts, i) => ({
    start: V(pts[0][0], H - pts[0][1]),
    segments: pts.slice(1).map(([x, y]) => ({ kind: "line" as const, to: V(x, H - y) })),
    closed: closed[i] ?? false,
  }));
  return addDrawing(EMPTY_DOCUMENT, createDrawing("d1", "t.svg", { subpaths }, [1, 0, 0, 1, 0, 0]));
}

/** Gerador pseudoaleatório com semente (mulberry32): os testes são determinísticos. */
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

/**
 * Cronometra o TEXTO do G-code sem usar o plano, e devolve o instante de TODO M3 (aquecimento incluído).
 * - "aceleracao": a cinemática do GRBL (rampa de 800 mm/s², G0 a 12000 mm/min), como a máquina anda;
 * - "constante": a conta do script de blindagem do Artur (traço a F, G0 a 3000 mm/min), a da auditoria.
 */
function clockText(lines: readonly string[], profile: MachineProfile, model: "aceleracao" | "constante"): { downs: number[]; total: number } {
  let x = profile.gcode.finalPosition.x, y = profile.gcode.finalPosition.y;
  let known = model === "aceleracao";
  let t = 0, feed = profile.feed.fixed;
  const downs: number[] = [];
  let chain: Block[] = [];
  const flush = () => {
    if (chain.length) for (const dt of chainTimes(chain, profile)) t += dt;
    chain = [];
  };
  for (const raw of lines) {
    const code = raw.split(";")[0].trim();
    if (!code) continue;
    const mv = /^(G0 )?X(-?[\d.]+) Y(-?[\d.]+)(?: F([\d.]+))?$/.exec(code);
    if (mv) {
      const rapid = !!mv[1];
      if (mv[4]) feed = Number(mv[4]);
      const nx = Number(mv[2]), ny = Number(mv[3]);
      if (model === "constante") {
        const len = known ? Math.hypot(nx - x, ny - y) : 0;
        t += rapid ? len / 50 : len / (feed / 60);
      } else {
        const b = makeBlock({ x, y }, { x: nx, y: ny }, rapid ? "rapid" : feed, profile);
        if (rapid) {
          flush();
          if (b) t += chainTimes([b], profile)[0];
        } else if (b) chain.push(b);
      }
      x = nx;
      y = ny;
      known = true;
      continue;
    }
    flush();
    let m: RegExpExecArray | null;
    if ((m = /^G4 P([\d.]+)$/.exec(code))) t += Number(m[1]);
    else if ((m = /^G1 F([\d.]+)$/.exec(code))) feed = Number(m[1]);
    else if (/^M3\b/.test(code)) downs.push(t);
    else if (!/^(M5|G21|G90|M2)$/.test(code)) throw new Error(`linha inesperada: ${raw}`);
  }
  flush();
  return { downs, total: t };
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

/** n pontos (descidas sem traço) em serpentina, `pitch` mm entre vizinhos: sem saltos longos. */
function serpentineDots(n: number, cols: number, pitch: number, x0: number, y0: number): PlannedStroke[] {
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    return stroke([[x0 + (r % 2 === 0 ? c : cols - 1 - c) * pitch, y0 + r * pitch]]);
  });
}

/** Erros da auditoria que não são do orçamento do servo (um arquivo de 10 linhas sempre "estoura" a média). */
const hardErrors = (a: AuditReport) => a.problems.filter((p) => p.level === "error" && !p.message.startsWith("Servo")).map((p) => p.message);
const servoProblems = (a: AuditReport) => a.problems.filter((p) => p.message.startsWith("Servo")).map((p) => p.message);

/** Uma letra por linha, para conferir a ESTRUTURA do arquivo com uma expressão regular. */
function tokens(lines: readonly string[], profile: MachineProfile): string {
  return lines
    .map((l) => {
      if (l.startsWith(";")) return "C";
      if (l === "G21") return "g";
      if (l === "G90") return "a";
      if (l === "M2") return "E";
      if (l === profile.pen.upCmd) return "U";
      if (l === profile.pen.downCmd) return "D";
      if (/^G4 P\d+(\.\d+)?$/.test(l)) return "W";
      if (/^G0 X\d+\.\d\d Y\d+\.\d\d$/.test(l)) return "R";
      if (/^G1 F\d+$/.test(l)) return "F";
      if (/^X\d+\.\d\d Y\d+\.\d\d( F\d+)?$/.test(l)) return "P";
      return "?";
    })
    .join("");
}

/**
 * O arquivo inteiro, de docs/REGRAS_GCODE.md: cabeçalho; aquecimento; e cada descida como
 * [descanso] [checkpoint] G0 → M3 → G4 → G1 F → pontos → M5 G4 (duas vezes na blindagem); rodapé; G0; M2.
 * Por construção: nenhum G0 entre M3 e M5, e todo M3/M5 seguido de G4.
 */
function grammar(profile: MachineProfile): RegExp {
  const sh = profile.shield.enabled;
  const lift = sh && profile.shield.doubleLift ? "UWUW" : "UW";
  const warm = sh && profile.shield.warmupCycles > 0 ? `CUWR(DWUW){${profile.shield.warmupCycles}}W` : "";
  return new RegExp(`^C+gaUW${warm}((CW)?(CDWUWDWUW)?C?RDWFP*${lift})*${sh ? "UWUW" : ""}RE$`);
}

/** O que a caneta risca: cada segmento com a caneta embaixo, e onde cada descida de desenho começa. */
function replay(lines: readonly string[]): { segs: string[]; starts: string[] } {
  let x = NaN, y = NaN, down = false, drawing = false;
  const segs: string[] = [];
  const starts: string[] = [];
  for (const l of lines) {
    const m = /^(G0 )?X([\d.]+) Y([\d.]+)/.exec(l);
    if (m) {
      const nx = Number(m[2]), ny = Number(m[3]);
      if (!m[1] && down) segs.push(`${x},${y}>${nx},${ny}`);
      x = nx;
      y = ny;
    } else if (/^M3/.test(l)) down = true;
    else if (/^M5/.test(l)) {
      down = false;
      drawing = false;
    } else if (/^G1 F/.test(l) && down && !drawing) {
      drawing = true;
      starts.push(`${x},${y}`);
    }
  }
  return { segs, starts };
}

/** Distância de p ao EIXO do traço mais próximo. Há tinta de verdade até meia largura da caneta. */
function distToInk(strokes: readonly { points: readonly Vec[] }[], p: Vec): number {
  let d = Infinity;
  for (const s of strokes) {
    if (s.points.length === 1) d = Math.min(d, Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y));
    for (let j = 1; j < s.points.length; j++) d = Math.min(d, distToSegment(p, s.points[j - 1], s.points[j]));
  }
  return d;
}

/** Quanto do EIXO da ligação a→b cai em papel branco: maior trecho contínuo (mm) e maior afastamento da tinta (mm). */
function whiteUnderAxis(strokes: readonly Stroke[], a: Vec, b: Vec): { run: number; clearance: number } {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / 0.002));
  let run = 0, best = 0, clearance = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const d = distToInk(strokes, V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) - PEN / 2;
    if (d > 1e-9) {
      run += len / n;
      if (d > clearance) clearance = d;
    } else run = 0;
    if (run > best) best = run;
  }
  return { run: best, clearance };
}

const HEAD = ["G21", "G90", "M5", "G4 P0.3"];

// ======================================================================================= DEFEITOS

describe("DEFEITO 1 — regra 4: traços curtos que se cobrem UM AO OUTRO somem todos (pipeline.ts + inkmap.ts)", () => {
  it("1a. dois tracinhos idênticos, um em cima do outro: pelo menos um tem que ser desenhado", () => {
    const dash: [number, number][] = [[100, 100], [101, 100]];
    const plan = planJob(docOf([dash, dash]), P, DEFAULT_JOB_SETTINGS);
    expect(plan.violations).toEqual([]);
    // hoje: 0 traços. O desenho tinha tinta ali e o papel sai em branco.
    expect(plan.strokes.length).toBeGreaterThanOrEqual(1);
  });

  it("1b. pontilhado denso (3 pontos a 0,15 mm um do outro) não pode sumir inteiro", () => {
    const dot = (x: number): [number, number][] => [[x, 100], [x + 0.02, 100]];
    const plan = planJob(docOf([dot(100), dot(100.15), dot(100.3)]), P, DEFAULT_JOB_SETTINGS);
    expect(plan.strokes.length).toBeGreaterThanOrEqual(1);
  });

  it("1c. preenchimento de 1 × 1 mm em tracinhos a cada 0,2 mm não pode sumir inteiro", () => {
    const patch = Array.from({ length: 6 }, (_, i) => [[100, 100 + i * 0.2], [101, 100 + i * 0.2]] as [number, number][]);
    const plan = planJob(docOf(patch), P, DEFAULT_JOB_SETTINGS);
    // hoje: os 6 somem (hiddenDropped = 6) e nada é desenhado
    expect(plan.stats.drawMm).toBeGreaterThan(0);
  });

  it("1d. tracinho com METADE da largura para fora da linha vizinha não está 'totalmente coberto'", () => {
    // linha longa em Y100 (tinta de 99,8 a 100,2) e tracinho de 1 mm em Y100,2 (tinta de 100,0 a 100,4)
    const plan = planJob(docOf([[[100, 100], [130, 100]], [[110, 100.2], [111, 100.2]]]), P, DEFAULT_JOB_SETTINGS);
    expect(plan.stats.hiddenDropped).toBe(0);
  });

  it("1e. a emenda não pode passar por cima da 'tinta' de traços que foram retirados", () => {
    // A termina a 0,1 mm do preenchimento do teste 1c e B começa 0,1 mm depois dele
    const patch = Array.from({ length: 6 }, (_, i) => [[100, 100 + i * 0.2], [101, 100 + i * 0.2]] as [number, number][]);
    const plan = planJob(docOf([[[80, 100.5], [99.9, 100.5]], ...patch, [[101.1, 100.5], [120, 100.5]]]), P, DEFAULT_JOB_SETTINGS);
    let prev: Vec | undefined;
    const joinsOverBlank: string[] = [];
    for (const s of plan.strokes) {
      if (s.joinedToPrevious && prev) {
        const w = whiteUnderAxis(plan.strokes, prev, s.points[0]);
        if (w.run > PEN) joinsOverBlank.push(`${w.run.toFixed(2)} mm de ligação sobre papel em branco`);
      }
      prev = s.points[s.points.length - 1];
    }
    // hoje: o preenchimento some e A é emendado a B com 1,2 mm de risco onde não sobrou tinta nenhuma
    expect(joinsOverBlank).toEqual([]);
  });
});

describe("DEFEITO 2 — auditoria: a descida some quando o M3 divide a linha com um G4 (audit.ts)", () => {
  it("2a. 'M3 S220 G4 P0.3' na mesma linha: o G0 com a caneta embaixo tem que ser acusado", () => {
    // G-code válido para o GRBL (ele executa o M3 e depois a pausa). O G0 da 5ª linha risca o papel.
    const a = auditGcode([...HEAD, "G0 X100.00 Y100.00", "M3 S220 G4 P0.3", "G1 F500", "X110.00 Y100.00", "G0 X200.00 Y200.00", "M5 G4 P0.2"], P);
    expect({ cycles: a.cycles, drawMm: Math.round(a.drawMm), rapidsPenDown: a.rapidsPenDown }).toEqual({ cycles: 1, drawMm: 10, rapidsPenDown: 1 });
  });

  it("2b. comentário entre parênteses que cita 'G4' não vale como pausa", () => {
    // nenhum G4 de verdade no arquivo depois do cabeçalho: o M3 e o M5 ficam os dois sem pausa
    const a = auditGcode([...HEAD, "G0 X100.00 Y100.00", "M3 S220 (desce, o G4 vem depois)", "G1 F500", "X110.00 Y100.00", "M5 (sobe, sem G4)", "G0 X0.00 Y0.00"], P);
    expect({ cycles: a.cycles, penCmdsWithoutDwell: a.penCmdsWithoutDwell }).toEqual({ cycles: 1, penCmdsWithoutDwell: 2 });
  });
});

describe("DEFEITO 3 — auditoria: 'G4 P0' passa como pausa do servo (audit.ts)", () => {
  it("3a. M3 e M5 seguidos de G4 P0 (ou G4 sem P) têm que contar como 'sem G4'", () => {
    const zero = auditGcode([...HEAD, "G0 X100.00 Y100.00", "M3 S220", "G4 P0", "G1 F500", "X110.00 Y100.00", "M5", "G4 P0"], P);
    expect(zero.penCmdsWithoutDwell).toBe(2);
    const noP = auditGcode([...HEAD, "G0 X100.00 Y100.00", "M3 S220", "G4", "G1 F500", "X110.00 Y100.00", "M5", "G4"], P);
    expect(noP.penCmdsWithoutDwell).toBe(2);
  });

  it("3b. perfil com pausa de subida 0 (aceito pelas Configurações): o arquivo sai com 'G4 P0' e a auditoria tem que barrar", () => {
    const prof: MachineProfile = { ...P, pen: { ...P.pen, settleUpSeconds: 0 } };
    const lines = textOf(makePlan([stroke([[100, 100], [110, 100]]), stroke([[200, 100], [210, 100]])], prof), prof);
    expect(lines).toContain("G4 P0"); // o M5 sai e o G0 seguinte parte na hora, com a caneta ainda subindo
    expect(hardErrors(auditGcode(lines, prof))).not.toEqual([]);
  });
});

describe("DEFEITO 4 — servo: no modo 'esperar' o arquivo gerado reprova na própria auditoria (schedule.ts × audit.ts)", () => {
  it("4a. perfil e trabalho padrão, 1500 pontos a 2 mm um do outro: a auditoria não pode acusar o servo", () => {
    const lines = textOf(makePlan(serpentineDots(1500, 100, 2, 100, 100)));
    const a = auditGcode(lines, P);
    expect(a.outOfZone).toBe(0);
    // hoje: "Servo: média de 30.8 ciclos/min, acima do limite de 30." → ok = false, exportar e enviar travam
    expect(servoProblems(a)).toEqual([]);
  });

  it("4b. F500 fixo, 600 rabiscos de 4,8 mm (12 vaivéns de 0,4 mm): idem", () => {
    const scribble = (i: number): PlannedStroke => {
      const x0 = 100 + (i % 60) * 3, y0 = 100 + Math.floor(i / 60) * 4;
      const pts = Array.from({ length: 13 }, (_, k) => V(x0 + (k % 2) * 0.4, y0 + k * 0.02));
      return assignFeeds({ points: pts, closed: false, drawingId: "d", joinedToPrevious: false }, DEFAULT_JOB_SETTINGS, P);
    };
    const a = auditGcode(textOf(makePlan(Array.from({ length: 600 }, (_, i) => scribble(i)))), P);
    expect(a.outOfZone).toBe(0);
    expect(servoProblems(a)).toEqual([]); // hoje: média de 31.5
  });

  it("4c. modo dinâmico, 600 zigue-zagues de 20 mm: idem (hoje a auditoria vê média de 41,6 e pico de 46)", () => {
    const zigzag = (i: number): PlannedStroke => {
      const x0 = 100 + (i % 60) * 3, y0 = 100 + Math.floor(i / 60) * 4;
      const pts = Array.from({ length: 21 }, (_, k) => V(x0 + (k % 2), y0 + k * 0.05));
      return assignFeeds({ points: pts, closed: false, drawingId: "d", joinedToPrevious: false }, DYNAMIC, P);
    };
    const a = auditGcode(textOf(makePlan(Array.from({ length: 600 }, (_, i) => zigzag(i))), P, { ...meta, job: DYNAMIC }), P);
    expect(a.outOfZone).toBe(0);
    expect(servoProblems(a)).toEqual([]);
  });
});

describe("DEFEITO 5 — servo: os ciclos do aquecimento não entram em conta nenhuma (schedule.ts, gcode.ts, audit.ts)", () => {
  // 14 traços de ~1,6 min e depois 300 pontos: a parte 2 começa exatamente no 1º ponto, com o balde cheio
  const long = Array.from({ length: 14 }, (_, i) => stroke([[40, 40 + i * 3], [440, 40 + i * 3], [40, 41 + i * 3]]));
  const PITCHES = [0.5, 1, 2, 3];
  const jobOf = (pitch: number) => [...long, ...serpentineDots(300, 100, pitch, 45, 30)];
  /** Mais descidas (TODAS: aquecimento, checkpoints e desenho) em 60 s, pelo relógio mais lento dos dois. */
  const realPeak = (lines: string[], profile: MachineProfile) =>
    Math.min(peak60(clockText(lines, profile, "aceleracao").downs), peak60(clockText(lines, profile, "constante").downs));

  it("5a. perfil padrão: nenhuma janela de 60 s de uma PARTE pode ter mais de 45 descidas da caneta", () => {
    const peaks = PITCHES.map((pitch) => {
      const plan = makePlan(jobOf(pitch));
      expect(plan.stats.parts).toBe(2);
      expect(plan.descents.find((d) => d.part === 1)!.first).toBe(14);
      return realPeak(textOf(plan, P, meta, 1), P);
    });
    // hoje: 46 pelos dois relógios (8 do aquecimento + 38 do desenho). A auditoria diz 42 e aprova.
    expect(Math.max(...peaks)).toBeLessThanOrEqual(P.servo.peakPer60s);
  });

  it("5e. o mesmo vale para a RETOMADA (fromDescent) que recomeça no 1º ponto", () => {
    const peaks = PITCHES.map((pitch) => realPeak(generateGcode(makePlan(jobOf(pitch)), P, meta, { fromDescent: 14 }).lines.map((l) => l.text), P));
    // hoje: 46 (a auditoria diz 42 e aprova)
    expect(Math.max(...peaks)).toBeLessThanOrEqual(P.servo.peakPer60s);
  });

  it("5f. com 12 ciclos de aquecimento a folga some de vez: parte e retomada continuam dentro do pico", () => {
    const prof: MachineProfile = { ...P, shield: { ...P.shield, warmupCycles: 12 } };
    const peaks = PITCHES.flatMap((pitch) => {
      const plan = makePlan(jobOf(pitch), prof);
      const first = plan.descents.findIndex((d) => d.part === 1);
      expect(plan.strokes[plan.descents[first].first].points.length).toBe(1); // a parte 2 começa num ponto
      return [realPeak(textOf(plan, prof, meta, 1), prof), realPeak(generateGcode(plan, prof, meta, { fromDescent: first }).lines.map((l) => l.text), prof)];
    });
    // hoje: 48 (12 do aquecimento + 36 do desenho); a auditoria diz 42 e aprova
    expect(Math.max(...peaks)).toBeLessThanOrEqual(prof.servo.peakPer60s);
  });

  it("5b. 30 ciclos de aquecimento (as Configurações aceitam até 50): o 1º minuto do arquivo não pode passar do pico", () => {
    const prof: MachineProfile = { ...P, shield: { ...P.shield, warmupCycles: 30 } };
    const lines = textOf(makePlan(serpentineDots(200, 100, 1, 45, 30), prof), prof);
    // hoje: 47 descidas em 60 s; a auditoria informa pico de 30 e ok
    expect(peak60(clockText(lines, prof, "aceleracao").downs)).toBeLessThanOrEqual(prof.servo.peakPer60s);
  });

  it("5c. auditoria: 200 batidas seguidas no ponto seguro não são 'aquecimento'", () => {
    const taps = Array.from({ length: 200 }, () => ["M3 S220", "G4 P0.3", "M5", "G4 P0.2"]).flat();
    const a = auditGcode([...HEAD, "G0 X0.00 Y0.00", ...taps, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "X110.00 Y100.00", "M5", "G4 P0.2"], P);
    // 200 ciclos em 100 s = 120 por minuto. Hoje: cycles = 1, pico = 1, ok = true.
    expect(a.ok).toBe(false);
  });

  it("5d. auditoria: descida que COMEÇA no ponto seguro e risca até o papel está fora da zona", () => {
    const a = auditGcode([...HEAD, "G0 X0.00 Y0.00", "M3 S220", "G4 P0.3", "G1 F500", "X100.00 Y100.00", "M5", "G4 P0.2"], P);
    expect(a.drawMm).toBeCloseTo(Math.hypot(100, 100), 6);
    expect(a.outOfZone).toBeGreaterThan(0); // hoje: 0. São 39 mm de risco na madeira antes de chegar à folha.
  });
});

describe("DEFEITO 6 — auditoria: G-code válido que ela não entende passa em branco (audit.ts)", () => {
  it("6a. coordenada com sinal de mais (X+900.00): fora do curso tem que ser acusado", () => {
    const a = auditGcode([...HEAD, "G0 X+100.00 Y+100.00", "M3 S220", "G4 P0.3", "G1 F500", "X+900.00 Y+100.00", "M5", "G4 P0.2"], P);
    expect(a.outOfArea).toBe(1); // hoje: 0, e drawMm = 0: a linha inteira é ignorada
  });

  it("6b. G91 (coordenadas relativas): ou a auditoria acompanha, ou recusa o arquivo", () => {
    // 8 passos de (100, 100) a partir de (100, 100): a máquina iria até (900, 900), fora do curso
    const steps = Array.from({ length: 8 }, () => "X100.00 Y100.00");
    const a = auditGcode([...HEAD, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "G91", ...steps, "M5", "G4 P0.2"], P);
    expect(hardErrors(a)).not.toEqual([]);
  });

  it("6c. 'M5 G0 X0 Y0' na mesma linha: a máquina parte sem esperar o servo subir", () => {
    const a = auditGcode([...HEAD, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "X110.00 Y100.00", "M5 G0 X0.00 Y0.00", "G4 P0.2"], P);
    expect(a.penCmdsWithoutDwell).toBeGreaterThan(0);
  });

  it("6d. linha '$32=1' (modo laser: o servo para de funcionar) tem que ser erro", () => {
    const a = auditGcode([...HEAD, "$32=1", "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "X110.00 Y100.00", "M5", "G4 P0.2"], P);
    expect(hardErrors(a)).not.toEqual([]);
  });
});

describe("DEFEITO 7 — emendas: o mapa de tinta (grade de 0,1 mm) enxerga tinta até 0,1 mm além da borda (inkmap.ts)", () => {
  // um traço mais abaixo fixa a origem da grade; as duas linhas ficam a 0,59 mm: 0,19 mm de papel entre elas
  const anchor = line([50, 80], [51, 80]);
  const yA = 100.051, yB = yA + 0.59;

  it("7a. anéis concêntricos com 0,19 mm de branco entre eles: a ligação atravessa o branco", () => {
    const inner: Stroke = { points: [V(110, yA), V(130, yA), V(130, 90), V(90, 90), V(90, yA), V(110, yA)], closed: true, drawingId: "d" };
    const outer: Stroke = { points: [V(110, yB), V(130.59, yB), V(130.59, 89.41), V(89.41, 89.41), V(89.41, yB), V(110, yB)], closed: true, drawingId: "d" };
    const strokes = [inner, outer, anchor];
    const ink = buildInkMap(strokes, PEN)!;
    const out = orderStrokes(strokes, { start: V(110, yA), joinGapMm: PEN, allowReverse: true, rotateClosed: true, searchMm: 3, bridgeHidden: (a, b) => bridgeIsHidden(ink, a, b, PEN) });
    const from = out[0].points[out[0].points.length - 1], to = out[1].points[0];
    expect(whiteUnderAxis(strokes, from, to).run).toBeGreaterThan(0.18); // há mesmo papel em branco no caminho
    expect(out[1].joinedToPrevious).toBe(false);
  });

  it("7b. ligação de 2,5 mm correndo POR DENTRO de um canal branco de 0,19 mm entre duas linhas", () => {
    const y0 = (yA + yB) / 2;
    const tickIn = line([108, 97], [108, y0]);
    const tickOut = line([110.5, y0], [110.5, 104]);
    const strokes = [tickIn, tickOut, line([90, yA], [130, yA]), line([90, yB], [130, yB]), line([50, 99], [51, 99])];
    const ink = buildInkMap(strokes, PEN)!;
    const out = orderStrokes(strokes, { start: V(108, 97), joinGapMm: PEN, allowReverse: true, rotateClosed: true, searchMm: 3, bridgeHidden: (a, b) => bridgeIsHidden(ink, a, b, PEN) });
    expect(out[0].points[0]).toEqual(V(108, 97));
    expect(whiteUnderAxis(strokes, V(108.3, y0), V(110.2, y0)).run).toBeGreaterThan(1.8); // o miolo do canal é papel
    // hoje: emenda, e o filete branco entre as duas linhas é tapado por 2,5 mm
    expect(out[1].joinedToPrevious).toBe(false);
  });

  it("7c. ligação de 3 mm correndo a 0,15 mm do eixo de uma linha: 0,15 mm de tinta nova para fora da borda", () => {
    const strokes = [line([90, yA], [130, yA]), line([50, 99], [51, 99])];
    const ink = buildInkMap(strokes, PEN)!;
    // a ligação pinta de yA − 0,05 a yA + 0,35; a linha só tem tinta até yA + 0,20
    expect(bridgeIsHidden(ink, V(108, yA + 0.15), V(111, yA + 0.15), PEN)).toBe(false);
  });
});

describe("DEFEITO 8 — regra 5: sobra menor que a resolução do G-code vira uma descida vazia (optimize.ts)", () => {
  it("8a. traço de 900,004 mm: o corte não pode criar uma batida de caneta sem traço", () => {
    const plan = planJob(docOf([[[40, 40], [540, 40], [540, 340], [439.996, 340]]]), P, DEFAULT_JOB_SETTINGS);
    expect(plan.violations).toEqual([]);
    const lines = textOf(plan);
    const empty = tokens(lines, P).match(/RDWF(?=U)/g) ?? [];
    // hoje: G0 X440.00 Y340.00 / M3 S220 / G4 P0.3 / G1 F500 / M5 — um ciclo do servo para nada
    expect(empty).toEqual([]);
  });
});

describe("DEFEITO 9 — coordenada que não é número chega ao arquivo e passa na auditoria (gcode.ts, bounds.ts, audit.ts)", () => {
  const nan = makePlan([stroke([[100, 100], [NaN, 120], [130, 100]])]);

  it("9a. generateGcode tem que recusar o plano em vez de escrever 'XNaN'", () => {
    expect(() => generateGcode(nan, P, meta)).toThrow();
  });

  it("9b. a auditoria tem que acusar a linha que não entende ('XNaN Y120.00' dá error:2 no GRBL)", () => {
    const a = auditGcode([...HEAD, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "XNaN Y120.00", "X130.00 Y100.00", "M5", "G4 P0.2"], P);
    expect(hardErrors(a)).not.toEqual([]);
  });
});

describe("DEFEITO 10 — linha de 70+ caracteres no cabeçalho do modo dinâmico (gcode.ts)", () => {
  it("10a. velocidades com casas decimais (as Configurações aceitam): toda linha continua abaixo de 70", () => {
    const prof: MachineProfile = { ...P, feed: { ...P.feed, straight: 1833.3333, curve: 1166.6667, tightCurve: 583.33333 } };
    const lines = textOf(makePlan([stroke([[100, 100], [110, 100]])], prof), prof, { ...meta, job: DYNAMIC });
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(MAX_LINE_LENGTH); // hoje: 74
  });

  it("10b. duas canetas, a fina com a ponta deslocada 1,125 / 0,375 mm: a linha das cruzes continua abaixo de 70", () => {
    const prof: MachineProfile = { ...P, pens: P.pens.map((p) => (p.id === "fina" ? { ...p, offsetX: 1.125, offsetY: 0.375 } : p)) };
    const dash = (x: number) => ({ subpaths: [{ start: V(x, 200), segments: [{ kind: "line" as const, to: V(x + 50, 200) }], closed: false }] });
    let doc = addDrawing(EMPTY_DOCUMENT, createDrawing("a", "a.svg", dash(100), [1, 0, 0, 1, 0, 0], "fina"));
    doc = addDrawing(doc, createDrawing("b", "b.svg", dash(200), [1, 0, 0, 1, 0, 0], "preta"));
    const plan = planJob(doc, prof, DEFAULT_JOB_SETTINGS, { penId: "fina" });
    expect(plan.violations).toEqual([]);
    // hoje, 70: "; 1o traco: cruz em X18.875 Y11.625 - ultimo: cruz em X578.875 Y11.625"
    expect(Math.max(...textOf(plan, prof).map((l) => l.length))).toBeLessThanOrEqual(MAX_LINE_LENGTH);
  });
});

// ========================================================================================== FIRME

describe("FIRME — formato do arquivo e partes (gcode.ts)", () => {
  it("40 trabalhos sorteados: estrutura dos blocos, linhas < 70 e ASCII, nada fora do curso, e as partes somam o arquivo inteiro", () => {
    const r = rng(2026);
    let parts = 0, partsStartingOnRelift = 0, checkpoints = 0, waits = 0;
    for (let c = 0; c < 40; c++) {
      const shield = r() < 0.8;
      const profile: MachineProfile = {
        ...P,
        servo: { ...P.servo, maxDescentMm: [30, 200, 900][Math.floor(r() * 3)] },
        shield: { ...P.shield, enabled: shield, doubleLift: r() < 0.7, resyncMinutes: [0.5, 1, 10][Math.floor(r() * 3)], partMinutes: [1.5, 3, 25][Math.floor(r() * 3)], warmupCycles: r() < 0.9 ? 8 : 0 },
      };
      const job: JobSettings = r() < 0.5 ? DYNAMIC : DEFAULT_JOB_SETTINGS;
      const ordered: OrderedStroke[] = [];
      let cur = V(100, 100);
      const count = 5 + Math.floor(r() * 120);
      for (let i = 0; i < count; i++) {
        const joined = i > 0 && r() < 0.4;
        const pts = [joined ? V(cur.x + (r() - 0.5) * 0.5, cur.y + (r() - 0.5) * 0.5) : V(35 + r() * 500, 30 + r() * 330)];
        const kind = r();
        const m = kind < 0.35 ? 0 : kind < 0.9 ? 1 + Math.floor(r() * 6) : 20 + Math.floor(r() * 30);
        for (let k = 0; k < m; k++) {
          const prev = pts[pts.length - 1];
          const L = r() < 0.05 ? 0.003 : r() * (kind < 0.9 ? 8 : 40);
          const ang = r() * Math.PI * 2;
          pts.push(V(Math.min(565, Math.max(35, prev.x + Math.cos(ang) * L)), Math.min(365, Math.max(30, prev.y + Math.sin(ang) * L))));
        }
        ordered.push({ points: pts, closed: false, drawingId: "d", joinedToPrevious: joined });
        cur = pts[pts.length - 1];
      }
      const plan = makePlan(capDescents(ordered, profile.servo.maxDescentMm).map((s) => assignFeeds(s, job, profile)), profile);
      const m = { ...meta, fileName: "Ilustração — “máscara” nº (1) versão final corrigida de novo.svg", job };
      const g = grammar(profile);
      const check = (lines: string[], what: string) => {
        expect(g.test(tokens(lines, profile)), `${what}: estrutura (${tokens(lines, profile).slice(0, 120)}...)`).toBe(true);
        for (const l of lines) {
          expect(l.length, l).toBeLessThanOrEqual(MAX_LINE_LENGTH);
          expect(l, what).toMatch(/^[\x20-\x7e]*$/);
          const xy = /X(-?[\d.]+) Y(-?[\d.]+)/.exec(l.startsWith(";") ? "" : l);
          if (xy) expect(Number(xy[1]) >= 0 && Number(xy[1]) <= 810 && Number(xy[2]) >= 0 && Number(xy[2]) <= 385, l).toBe(true);
        }
        const a = auditGcode(lines, profile);
        expect({ g0: a.rapidsPenDown, semG4: a.penCmdsWithoutDwell, area: a.outOfArea, zona: a.outOfZone, ascii: a.nonAsciiLines }, what).toEqual({ g0: 0, semG4: 0, area: 0, zona: 0, ascii: 0 });
        return a;
      };
      const full = textOf(plan, profile, m);
      check(full, `trabalho ${c}`);
      waits += full.filter((l) => l === "; descanso do servo").length;

      // partes: cada uma é um arquivo completo, e juntas riscam exatamente o que o arquivo inteiro risca
      const segs: string[] = [], starts: string[] = [];
      for (let part = 0; part < plan.stats.parts; part++) {
        const pl = textOf(plan, profile, m, part);
        const a = check(pl, `trabalho ${c} parte ${part}`);
        if (shield) expect(a.warmupCycles, "aquecimento em toda parte").toBe(profile.shield.warmupCycles);
        const firstDown = pl.findIndex((l, i) => l === profile.pen.downCmd && /^G1 F/.test(pl[i + 2] ?? ""));
        if (shield) expect(pl[firstDown + 1], "1ª descida com a pausa longa").toBe(`G4 P${profile.shield.firstSettleSeconds}`);
        expect(pl.slice(0, firstDown).some((l) => /CHECKPOINT|descanso/.test(l)), "sem checkpoint nem descanso antes da 1ª descida").toBe(false);
        const rp = replay(pl);
        segs.push(...rp.segs);
        starts.push(...rp.starts);
        if (plan.descents.find((d) => d.part === part)!.relift) partsStartingOnRelift++;
      }
      const whole = replay(full);
      expect(segs, `trabalho ${c}: segmentos das partes`).toEqual(whole.segs);
      expect(starts, `trabalho ${c}: descidas das partes`).toEqual(whole.starts);
      parts += plan.stats.parts;
      checkpoints += plan.stats.checkpoints;
    }
    // o sorteio exercitou mesmo o que interessa (22/11/2026: 103 partes, 39 começando num corte de
    // descida longa, 205 checkpoints, 628 descansos do servo)
    expect(parts).toBeGreaterThan(60);
    expect(partsStartingOnRelift).toBeGreaterThan(15);
    expect(checkpoints).toBeGreaterThan(100);
    expect(waits).toBeGreaterThan(200);
  }, 120_000);
});

describe("FIRME — balde de fichas, pelo relógio da máquina (schedule.ts)", () => {
  /** Cronometrado no texto, com aceleração: pico do desenho, pico com o aquecimento junto, e média do arquivo. */
  const measure = (strokes: PlannedStroke[], profile: MachineProfile = P) => {
    const lines = textOf(makePlan(strokes, profile), profile);
    const t = clockText(lines, profile, "aceleracao");
    const warm = profile.shield.warmupCycles;
    return { peak: peak60(t.downs.slice(warm)), peakWithWarmup: peak60(t.downs), avg: (t.downs.length - warm) / (t.total / 60) };
  };
  const longStroke = (i: number) => stroke([[40, 40 + i * 3], [440, 40 + i * 3], [40, 41 + i * 3]]);

  it("arquivo inteiro com o perfil padrão: no máximo 45 descidas em 60 s (aquecimento incluído) e média <= 30", () => {
    const cases: [string, PlannedStroke[], MachineProfile?][] = [
      ["1500 pontos a 1 mm", serpentineDots(1500, 100, 1, 100, 100)],
      ["1500 pontos a 2 mm", serpentineDots(1500, 100, 2, 100, 100)],
      ["balde cheio, salto longo e 400 pontos", [longStroke(0), ...serpentineDots(400, 100, 2, 300, 200)]],
      ["checkpoint no meio de uma rajada", [...Array.from({ length: 7 }, (_, i) => longStroke(i)), ...serpentineDots(400, 100, 1, 300, 200)]],
      // uma linha de 3 m cortada a cada 10 mm: 300 descidas "no mesmo ponto"
      ["300 cortes de descida longa", capDescents([{ ...line([40, 40], [540, 40], [540, 340], [40, 340], [40, 45], [535, 45], [535, 335], [45, 335]), joinedToPrevious: false }], 10).map((s) => assignFeeds(s, DEFAULT_JOB_SETTINGS, P)), { ...P, servo: { ...P.servo, maxDescentMm: 10 } }],
    ];
    for (const [name, strokes, profile] of cases) {
      const m = measure(strokes, profile);
      expect(m.peak, name).toBeLessThanOrEqual(45);
      expect(m.peakWithWarmup, name).toBeLessThanOrEqual(45);
      expect(m.avg, name).toBeLessThanOrEqual(30);
    }
  }, 60_000);

  it("os arquivos do DEFEITO 4 respeitam o limite pelo relógio da máquina: quem discorda é só a conta da auditoria", () => {
    const zigzag = (i: number): PlannedStroke => {
      const x0 = 100 + (i % 60) * 3, y0 = 100 + Math.floor(i / 60) * 4;
      return assignFeeds({ points: Array.from({ length: 21 }, (_, k) => V(x0 + (k % 2), y0 + k * 0.05)), closed: false, drawingId: "d", joinedToPrevious: false }, DYNAMIC, P);
    };
    const lines = textOf(makePlan(Array.from({ length: 600 }, (_, i) => zigzag(i))), P, { ...meta, job: DYNAMIC });
    const t = clockText(lines, P, "aceleracao");
    expect(peak60(t.downs.slice(8))).toBeLessThanOrEqual(45);
    expect((t.downs.length - 8) / (t.total / 60)).toBeLessThanOrEqual(30);
  });
});

describe("FIRME — corte de descida longa (optimize.ts, capDescents)", () => {
  it("3000 cadeias sorteadas: nenhuma descida passa do limite, nenhum 'ponto' é criado, o comprimento não muda", () => {
    const r = rng(7);
    const drawn = (ss: readonly OrderedStroke[]) => {
      let t = 0;
      let prev: Vec | undefined;
      for (const s of ss) {
        if (s.joinedToPrevious && prev) t += Math.hypot(s.points[0].x - prev.x, s.points[0].y - prev.y);
        t += plen(s.points);
        prev = s.points[s.points.length - 1];
      }
      return t;
    };
    for (let c = 0; c < 3000; c++) {
      const max = [10, 25, 50, 100, 900][Math.floor(r() * 5)];
      const strokes: OrderedStroke[] = [];
      let cur = V(100, 100);
      const n = 1 + Math.floor(r() * 6);
      for (let i = 0; i < n; i++) {
        const joined = i > 0 && r() < 0.6;
        // emendas de até 3 mm (às vezes a própria ligação cruza o limite), pontos, segmentos de comprimento
        // zero, segmentos com exatamente o limite ou o dobro, laços fechados, limite menor que um segmento
        const pts = [joined ? V(cur.x + (r() - 0.5) * (r() < 0.2 ? 6 : 0.5), cur.y + (r() - 0.5) * 0.5) : V(50 + r() * 400, 50 + r() * 300)];
        const m = r() < 0.15 ? 0 : 1 + Math.floor(r() * 5);
        for (let k = 0; k < m; k++) {
          const L = r() < 0.1 ? 0 : r() < 0.3 ? max * (r() < 0.5 ? 1 : 2) : r() * max * 1.7;
          const ang = r() * Math.PI * 2;
          const prev = pts[pts.length - 1];
          pts.push(V(prev.x + Math.cos(ang) * L, prev.y + Math.sin(ang) * L));
        }
        const closed = m >= 3 && r() < 0.3;
        if (closed) pts.push(pts[0]);
        strokes.push({ points: pts, closed, drawingId: "d", joinedToPrevious: joined });
        cur = pts[pts.length - 1];
      }
      const out = capDescents(strokes, max);
      expect(Math.abs(drawn(out) - drawn(strokes))).toBeLessThan(1e-6);
      expect(out.filter((s) => s.points.length === 1).length).toBe(strokes.filter((s) => s.points.length === 1).length);
      expect(out.some((s) => s.relift && !s.joinedToPrevious)).toBe(false);
      const groups = groupDescents(out.map((s) => stroke(s.points.map((p) => [p.x, p.y] as [number, number]), { joined: s.joinedToPrevious, relift: s.relift })));
      for (const [first, last] of groups) {
        // o que a caneta risca nesta descida: a ligação desde o ponto de re-descida, os traços e as emendas
        let d = 0;
        let prev: Vec | undefined = out[first].relift && first > 0 ? out[first - 1].points[out[first - 1].points.length - 1] : undefined;
        for (let i = first; i <= last; i++) {
          if (prev) d += Math.hypot(out[i].points[0].x - prev.x, out[i].points[0].y - prev.y);
          d += plen(out[i].points);
          prev = out[i].points[out[i].points.length - 1];
        }
        // (pode passar até MIN_TAIL_MM: por um restinho desses não vale levantar a caneta, ver DEFEITO 8)
        expect(d).toBeLessThanOrEqual(max + MIN_TAIL_MM + 1e-6);
      }
    }
  }, 60_000);
});

describe("FIRME — área e zona de desenho (bounds.ts + pipeline.ts)", () => {
  const rect = docOf([[[100, 100], [200, 100], [200, 150], [100, 150], [100, 100]]], [true]);
  const rotated = setMachineRotation(rect, "d1", 30, H, 0.05);
  const box = machineBBox(rotated.drawings[0], H, 0.05);

  it("desenho girado com um canto 0,02 mm fora da zona: violação, e o gerador recusa", () => {
    const doc = translateMachine(rotated, ["d1"], { x: P.drawZone.maxX + 0.02 - box.maxX, y: 0 });
    const plan = planJob(doc, P, DEFAULT_JOB_SETTINGS);
    expect(plan.violations.map((v) => v.kind)).toEqual(["zone"]);
    expect(() => generateGcode(plan, P, meta)).toThrow();
  });

  it("o mesmo desenho encostado na borda por dentro: sem violação, e a auditoria não acha nada fora", () => {
    const doc = translateMachine(rotated, ["d1"], { x: P.drawZone.maxX - box.maxX, y: P.drawZone.minY - box.minY });
    const plan = planJob(doc, P, DEFAULT_JOB_SETTINGS);
    expect(plan.violations).toEqual([]);
    const a = auditGcode(generateGcode(plan, P, meta).toText(), P);
    expect({ zona: a.outOfZone, area: a.outOfArea }).toEqual({ zona: 0, area: 0 });
  });

  it("ponto solto (traço de 1 ponto) fora da zona também é violação; a folga é de 0,005 mm, a do arredondamento", () => {
    const withDot = (x: number, y: number) => planJob(docOf([[[100, 100], [110, 100]], [[x, y], [x + 0.01, y]]]), P, DEFAULT_JOB_SETTINGS);
    expect(withDot(20, 20).violations.map((v) => v.kind)).toEqual(["zone"]);
    expect(withDot(29.98, 100).violations.map((v) => v.kind)).toEqual(["zone"]);
    const edge = withDot(29.996, 24.996); // 0,004 mm para fora: sai como 30.00 / 25.00
    expect(edge.violations).toEqual([]);
    const lines = textOf(edge);
    expect(lines).toContain("G0 X30.00 Y25.00");
    expect(auditGcode(lines, P).outOfZone).toBe(0);
  });
});

describe("FIRME — emendas: o erro do mapa de tinta é limitado (inkmap.ts + optimize.ts)", () => {
  it("sem mapa de tinta só vale o salto de até uma largura de caneta", () => {
    const out = orderStrokes([line([10, 10], [20, 10]), line([20.5, 10], [30, 10]), line([30.4, 10], [40, 10])], { start: V(0, 0), joinGapMm: PEN, allowReverse: true, rotateClosed: true, searchMm: 3 });
    expect(out.map((s) => s.joinedToPrevious)).toEqual([false, false, true]);
  });

  it("600 rabiscos sorteados: nenhuma ligação aceita tem o eixo a mais de 0,1 mm da tinta de verdade", () => {
    const r = rng(12345);
    let accepted = 0, worst = 0;
    for (let c = 0; c < 600; c++) {
      const strokes: Stroke[] = [];
      const n = 2 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const pts: [number, number][] = [];
        const k = 2 + Math.floor(r() * 3);
        for (let j = 0; j < k; j++) pts.push([100 + r() * 6, 100 + r() * 6]);
        strokes.push(line(...pts));
      }
      // metade dos casos ganha um par de linhas paralelas com passo de 0,4 a 0,8 mm: o caso difícil
      if (r() < 0.5) {
        const y = 101 + r() * 3, s = 0.4 + r() * 0.4, x = 101 + r() * 3;
        strokes.push(line([100, y], [106, y]), line([100, y + s], [106, y + s]), line([x, y - 2], [x, y]), line([x + r() * 2, y + s], [x, y + s + 2]));
      }
      const ink = buildInkMap(strokes, PEN)!;
      for (let i = 0; i < strokes.length; i++) {
        for (let j = 0; j < strokes.length; j++) {
          if (i === j) continue;
          const a = strokes[i].points[strokes[i].points.length - 1], b = strokes[j].points[0];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d <= PEN || d > 3 || !bridgeIsHidden(ink, a, b, PEN)) continue;
          accepted++;
          worst = Math.max(worst, whiteUnderAxis(strokes, a, b).clearance);
        }
      }
    }
    // 22/11/2026: 1556 ligações aceitas; a pior tinha o eixo a 0,096 mm da borda da tinta
    expect(accepted).toBeGreaterThan(500);
    expect(worst).toBeLessThanOrEqual(0.1 + 1e-6);
  }, 120_000);
});

describe("FIRME — auditoria: lê as variações comuns de escrita e o arquivo que já rodou na máquina (audit.ts)", () => {
  const canonical = [...HEAD, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "X110.00 Y100.00", "X110.00 Y120.00", "M5", "G4 P0.2", "G0 X0.00 Y0.00", "M2"];
  const key = (a: AuditReport) => ({
    cycles: a.cycles,
    drawMm: Math.round(a.drawMm * 1000),
    travelMm: Math.round(a.travelMm * 1000),
    dwellS: Math.round(a.dwellS * 1000),
    g0: a.rapidsPenDown,
    semG4: a.penCmdsWithoutDwell,
    zona: a.outOfZone,
    area: a.outOfArea,
    ascii: a.nonAsciiLines,
  });
  const expected = key(auditGcode(canonical, P));

  it("minúsculas, G00/G01/M03/M05, sem espaços, 'G4P.3', G1 em toda linha, N10, tabulação, comentário depois do código, linhas em branco, CRLF", () => {
    // 10 + 20 mm de traço; volta de (110, 120) até a origem = 162,788 mm; pausas 0,3 + 0,3 + 0,2 s
    expect(expected).toEqual({ cycles: 1, drawMm: 30000, travelMm: 162788, dwellS: 800, g0: 0, semG4: 0, zona: 0, area: 0, ascii: 0 });
    const variants: Record<string, string[] | string> = {
      minusculas: canonical.map((l) => l.toLowerCase()),
      "zeros e sem espacos": ["G21", "G90", "M05", "G4P.3", "G00X100Y100", "M03S220", "G04P0.3", "G01F500", "X110Y100", "X110Y120", "M05", "G04P0.2", "G00X0Y0", "M02"],
      "G1 em toda linha": [...HEAD, "G0 X100 Y100", "M3 S220", "G4 P0.3", "G1 X110 Y100 F500", "G1 X110 Y120", "M5", "G4 P0.2", "G0 X0 Y0", "M2"],
      "numeros de linha": canonical.map((l, i) => `N${(i + 1) * 10} ${l}`),
      "tab, espacos, comentarios, linhas em branco": canonical.flatMap((l) => [`  ${l.replace(" ", "\t")}  ; comentario com X999 Y999 G0`, "", "   "]),
      CRLF: canonical.join("\r\n") + "\r\n",
    };
    for (const [name, v] of Object.entries(variants)) expect(key(auditGcode(v, P)), name).toEqual(expected);
  });

  it("trechos do omega3_1fina_BLINDADO.gcode: 8 ciclos de aquecimento, checkpoint, subida dupla, rodapé 'G0 X0 Y0'", () => {
    const warmup = Array.from({ length: 8 }, () => ["M3 S220", "G4 P0.4", "M5", "G4 P0.4"]).flat();
    const real = [
      "; omega3 - camada 1 de 2 - caneta FINA 0.03 mm - F500",
      "; BLINDADO arquivo completo",
      ...HEAD,
      "; aquecimento do servo no ponto seguro",
      "M5",
      "G4 P0.3",
      "G0 X0.00 Y0.00",
      ...warmup,
      "G4 P1.0",
      ...["G0 X449.09 Y369.28", "M3 S220", "G4 P0.6", "G1 F500", "X449.09 Y365.68", "X449.33 Y363.52", "M5", "G4 P0.2", "M5", "G4 P0.2"],
      "; CHECKPOINT 1 (~10 min) re-sincroniza servo",
      ...["M3 S220", "G4 P0.3", "M5", "G4 P0.3", "M3 S220", "G4 P0.3", "M5", "G4 P0.4"],
      ...["G0 X337.65 Y160.19", "M3 S220", "G4 P0.3", "G1 F500", "X338.81 Y160.21", "M5", "G4 P0.2", "M5", "G4 P0.2"],
      ...["M5", "G4 P0.3", "M5", "G4 P0.3", "G0 X0 Y0", "M2"],
    ];
    const a = auditGcode(real, P);
    expect(hardErrors(a)).toEqual([]);
    expect({ warm: a.warmupCycles, cycles: a.cycles, checkpoints: a.checkpoints, g0: a.rapidsPenDown, semG4: a.penCmdsWithoutDwell }).toEqual({ warm: 8, cycles: 4, checkpoints: 1, g0: 0, semG4: 0 });
    // e o gerador escreve o mesmo aquecimento, linha por linha (só muda "G4 P1.0" para "G4 P1")
    const ours = textOf(makePlan([stroke([[449.09, 369.28], [449.09, 365.68], [449.33, 363.52]])]));
    const i = ours.indexOf("; aquecimento do servo no ponto seguro");
    expect(ours.slice(i, i + 4 + 32)).toEqual(real.slice(6, 6 + 4 + 32));
    expect(ours.slice(i + 37, i + 43)).toEqual(real.slice(43, 49));
  });
});
