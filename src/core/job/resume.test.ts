import { describe, expect, it } from "vitest";
import type { PlotDocument } from "../document";
import { DEFAULT_PROFILE } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { auditGcode, auditOptionsOf } from "./audit";
import { generateGcode } from "./gcode";
import { planJob } from "./pipeline";
import { parseWhat, planSignature, resumeDescent, sendSpan } from "./resume";
import { machineDrawing, makePlan, stroke } from "./testPlan";
import type { JobPlan } from "./types";

const P = DEFAULT_PROFILE;
const JOB = DEFAULT_JOB_SETTINGS;
const META = { fileName: "teste.svg", date: new Date(2026, 10, 22, 1, 0), job: JOB };
const doc = (...drawings: ReturnType<typeof machineDrawing>[]): PlotDocument => ({ drawings });
const text = (plan: JobPlan, opts = {}) => generateGcode(plan, P, META, opts).lines.map((l) => l.text);

/** Tracinhos soltos numa grade: cada um é uma descida. Pesado para o servo, como um céu pontilhado. */
function dashes(cols: number, rows: number, len = 2, x0 = 60, y0 = 60, step = 6): [number, number][][] {
  const out: [number, number][][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([[x0 + c * step, y0 + r * step], [x0 + c * step + len, y0 + r * step]]);
  return out;
}

/** Os blocos de descida de um G-code: o G0 que abre cada um (sem o aquecimento nem o rodapé). */
function descentStarts(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length - 3; i++) {
    if (lines[i].startsWith("G0 ") && lines[i + 1] === "M3 S220" && lines[i + 3]?.startsWith("G1 F")) out.push(lines[i]);
  }
  return out;
}

describe("parseWhat / sendSpan", () => {
  it("lê o valor do seletor", () => {
    expect(parseWhat("")).toEqual({ kind: "all" });
    expect(parseWhat("p2")).toEqual({ kind: "part", part: 2 });
    expect(parseWhat("r812")).toEqual({ kind: "resume", from: 812 });
    expect(parseWhat("qualquer coisa")).toEqual({ kind: "all" });
    expect(parseWhat("r-1")).toEqual({ kind: "all" });
  });
  it("a retomada vai do instante daquela descida até o fim", () => {
    const plan = planJob(doc(machineDrawing("a", dashes(10, 4))), P, JOB);
    const total = plan.stats.estimate.totalS;
    expect(sendSpan(plan, { kind: "all" })).toEqual({ t0: 0, t1: total });
    const s = sendSpan(plan, { kind: "resume", from: 20 });
    expect(s.t0).toBe(plan.descents[20].tDownS);
    expect(s.t1).toBe(total);
    expect(s.t0).toBeGreaterThan(0);
  });
});

describe("planSignature: a retomada só vale para o mesmo plano", () => {
  const a = () => planJob(doc(machineDrawing("a", dashes(10, 4))), P, JOB);
  it("o mesmo desenho, planejado de novo, tem a mesma assinatura", () => {
    expect(planSignature(a())).toBe(planSignature(a()));
  });
  it("mudar o desenho de lugar, de tamanho ou de caneta muda a assinatura", () => {
    const base = planSignature(a());
    expect(planSignature(planJob(doc(machineDrawing("a", dashes(10, 4, 2, 61))), P, JOB))).not.toBe(base);
    expect(planSignature(planJob(doc(machineDrawing("a", dashes(10, 5))), P, JOB))).not.toBe(base);
    expect(planSignature(planJob(doc(machineDrawing("a", dashes(10, 4), "verde")), P, JOB))).not.toBe(base);
  });
});

describe("resumeDescent", () => {
  const plan = planJob(doc(machineDrawing("a", dashes(10, 4))), P, JOB);
  it("repete a descida anterior à que estava sendo desenhada", () => {
    const d = plan.descents[17];
    expect(resumeDescent(plan, d.first)).toBe(16);
    expect(resumeDescent(plan, d.last)).toBe(16);
  });
  it("se parou antes de desenhar, ou na 1ª descida, não há o que retomar", () => {
    expect(resumeDescent(plan, -1)).toBeUndefined();
    expect(resumeDescent(plan, plan.descents[0].first)).toBeUndefined();
  });
});

describe("G-code de retomada", () => {
  const plan = planJob(doc(machineDrawing("a", dashes(10, 4))), P, JOB);
  const full = text(plan);
  const N = plan.descents.length;

  it("um plano de tracinhos soltos: uma descida por tracinho", () => {
    expect(N).toBe(40);
    expect(descentStarts(full)).toHaveLength(40);
  });
  it("cabeçalho de retomada, aquecimento e a 1ª descida com a pausa longa", () => {
    const g = text(plan, { fromDescent: 25 });
    expect(g[0]).toBe("; RETOMADA: continua da descida 26 de 40");
    expect(g[1]).toBe("; 1o: aquecimento do servo");
    expect(g[2]).toMatch(/^; 2o: continua do traco que comeca em X\d+\.\d\d Y\d+\.\d\d$/);
    expect(g).toContain("; aquecimento do servo no ponto seguro");
    const a = auditGcode(g, P, auditOptionsOf(plan));
    expect(a.warmupCycles).toBe(P.shield.warmupCycles);
    const first = descentStarts(g)[0];
    const i = g.indexOf(first);
    expect(g.slice(i + 1, i + 3)).toEqual(["M3 S220", "G4 P0.6"]);
    expect(g.slice(-6)).toEqual(["M5", "G4 P0.3", "M5", "G4 P0.3", "G0 X0.00 Y0.00", "M2"]);
  });
  it("continua exatamente das descidas que faltavam: nenhuma perdida, nenhuma criada", () => {
    const all = descentStarts(full);
    for (const from of [1, 7, 25, 39]) {
      expect(descentStarts(text(plan, { fromDescent: from }))).toEqual(all.slice(from));
    }
  });
  it("retomar da descida 0 é o desenho inteiro", () => {
    expect(descentStarts(text(plan, { fromDescent: 0 }))).toEqual(descentStarts(full));
  });
  it("ponto além do fim vira a última descida; negativo vira a primeira", () => {
    expect(descentStarts(text(plan, { fromDescent: 999 }))).toEqual(descentStarts(full).slice(-1));
    expect(descentStarts(text(plan, { fromDescent: -5 }))).toEqual(descentStarts(full));
  });
  it("a retomada ganha de `part`: vai sempre até o fim", () => {
    const g = text(plan, { fromDescent: 30, part: 0 });
    expect(g.join("\n")).not.toMatch(/; parte /);
    expect(descentStarts(g)).toHaveLength(10);
  });
});

describe("retomada numa camada com cruzes de registro", () => {
  const d = doc(machineDrawing("fino", dashes(8, 3), "fina"), machineDrawing("grosso", dashes(8, 3, 2, 60, 200), "preta"));
  const plan = planJob(d, P, JOB, { penId: "fina" });
  const full = descentStarts(text(plan));

  it("refaz a 1ª cruz (em cima da que já está no papel) e depois continua", () => {
    const g = text(plan, { fromDescent: 10 });
    expect(g.slice(0, 3)).toEqual([
      "; RETOMADA: continua da descida 11 de 26",
      "; 1o: aquecimento do servo; 2o: cruz EM CIMA da ja feita",
      expect.stringMatching(/^; 3o: continua do traco que comeca em X/),
    ]);
    const starts = descentStarts(g);
    expect(starts[0]).toBe("G0 X16.00 Y12.00"); // a cruz da fina, em X19
    expect(starts.slice(1)).toEqual(full.slice(10));
    // a cruz do fim continua sendo a última descida
    expect(starts[starts.length - 1]).toBe("G0 X576.00 Y12.00");
  });
  it("a cruz refeita e a descida seguinte vêm logo depois do aquecimento, sem descanso no meio", () => {
    const g = text(plan, { fromDescent: 10 });
    const i = g.indexOf("; cruz de registro em ida e volta");
    const j = g.indexOf(descentStarts(g)[1]);
    expect(g.slice(i, j).join("\n")).not.toMatch(/descanso|CHECKPOINT/);
  });
  it("retomar da própria cruz não a desenha duas vezes", () => {
    const starts = descentStarts(text(plan, { fromDescent: 0 }));
    expect(starts.filter((s) => s === "G0 X16.00 Y12.00")).toHaveLength(1);
  });
  it("a auditoria aprova a retomada", () => {
    const a = auditGcode(text(plan, { fromDescent: 10 }), P, auditOptionsOf(plan));
    expect(a.problems.filter((p) => p.level === "error")).toEqual([]);
    expect(a.outOfZone).toBe(0);
  });
});

describe("retomada de um desenho pesado para o servo", () => {
  // 900 tracinhos: a agenda intercala descansos para ficar em 30 descidas/min
  const plan = planJob(doc(machineDrawing("a", dashes(45, 20, 1.5, 40, 40, 5))), P, JOB);
  it("o plano tem descansos, checkpoints e mais de uma parte", () => {
    expect(plan.descents.length).toBe(900);
    expect(plan.stats.estimate.waitS).toBeGreaterThan(60);
    expect(plan.stats.checkpoints).toBeGreaterThan(1);
    expect(plan.stats.parts).toBeGreaterThan(1);
  });
  it("de qualquer ponto, a retomada passa em todas as regras (servo incluído)", () => {
    const froms = [1, 2, 50, 123, 300, 449, 450, 777, 899, ...plan.descents.map((d, i) => (d.checkpoint !== undefined ? i : -1)).filter((i) => i > 0)];
    for (const from of froms) {
      const a = auditGcode(text(plan, { fromDescent: from }), P, auditOptionsOf(plan));
      expect(a.problems.filter((p) => p.level === "error"), `retomando da descida ${from}`).toEqual([]);
      expect(a.rapidsPenDown).toBe(0);
      expect(a.penCmdsWithoutDwell).toBe(0);
      expect(a.maxLineLength).toBeLessThan(70);
    }
  });
  it("cada parte avulsa também passa", () => {
    for (let part = 0; part < plan.stats.parts; part++) {
      const a = auditGcode(text(plan, { part }), P, auditOptionsOf(plan));
      expect(a.problems.filter((p) => p.level === "error"), `parte ${part + 1}`).toEqual([]);
    }
  });
});

describe("servo no começo de uma parte ou de uma retomada", () => {
  // 14 traços longos (o balde do servo enche) e depois 300 pontos seguidos
  const long = Array.from({ length: 14 }, (_, i) => stroke([[40, 40 + i * 3], [440, 40 + i * 3], [40, 41 + i * 3]]));
  const dots = Array.from({ length: 300 }, (_, i) => stroke([[45 + (i % 100), 30 + Math.floor(i / 100)]]));
  const plan = makePlan([...long, ...dots]);
  const lines = (opts: object) => generateGcode(plan, P, META, opts).lines.map((l) => l.text);

  it("o plano corta a parte 2 exatamente onde os pontos começam", () => {
    expect(plan.stats.parts).toBe(2);
    expect(plan.descents.find((d) => d.part === 1)!.first).toBe(14);
  });
  it("uma PARTE começa a desenhar logo depois do aquecimento: a agenda já zerou a folga na fronteira", () => {
    const g = lines({ part: 1 });
    expect(g.join("\n")).not.toMatch(/servo descansa|reaquece/);
    const a = auditGcode(g, P);
    expect(a.warmupCycles).toBe(8);
    expect(a.peakCyclesPer60s).toBeLessThanOrEqual(P.servo.peakPer60s);
    expect(a.problems.filter((p) => p.level === "error")).toEqual([]);
  });
  it("uma RETOMADA no meio de uma rajada descansa o que falta e reaquece o servo antes do 1º traço", () => {
    // a descida 13 é o último traço longo: a agenda contava com o balde cheio ali
    const g = lines({ fromDescent: 13 });
    const i = g.indexOf("; servo descansa antes de recomecar");
    expect(i).toBeGreaterThan(0);
    expect(g[i + 1]).toMatch(/^G4 P\d+(\.\d)?$/);
    expect(Number(g[i + 1].slice(4))).toBeGreaterThan(3);
    expect(g.slice(i + 2, i + 11)).toEqual(["; reaquece o servo", "M3 S220", "G4 P0.4", "M5", "G4 P0.4", "M3 S220", "G4 P0.4", "M5", "G4 P0.4"]);
    // e o desenho vem em seguida, com a pausa longa da 1ª descida
    expect(g[i + 11]).toMatch(/^G0 X/);
    expect(g.slice(i + 12, i + 14)).toEqual(["M3 S220", "G4 P0.6"]);
    const a = auditGcode(g, P);
    expect(a.warmupCycles).toBe(10); // 8 do aquecimento + 2 do reaquecimento
    expect(a.peakCyclesPer60s).toBeLessThanOrEqual(P.servo.peakPer60s);
    expect(a.problems.filter((p) => p.level === "error")).toEqual([]);
  });
  it("retomada no meio de uma rajada de pontos (balde vazio: cada ponto já esperava a sua ficha) não descansa", () => {
    const busy = makePlan(dots);
    const g = generateGcode(busy, P, META, { fromDescent: 150 }).lines.map((l) => l.text);
    expect(g.join("\n")).not.toMatch(/servo descansa|reaquece/);
    expect(auditGcode(g, P).problems.filter((p) => p.level === "error")).toEqual([]);
  });
});

describe("o G-code sai com o trabalho do PLANO", () => {
  it("plano feito a F500 fixo continua F500 mesmo se a tela já estiver em velocidade dinâmica", () => {
    const d = doc(machineDrawing("a", dashes(4, 2)));
    const plan = planJob(d, P, JOB);
    expect(plan.job).toEqual(JOB);
    const g = generateGcode(plan, P, { ...META, job: { ...JOB, speedMode: "dynamic" } }).lines.map((l) => l.text);
    expect(g).toContain("; modo: fixo F500");
    expect(g.filter((l) => /^G1 F/.test(l)).every((l) => l === "G1 F500")).toBe(true);
    expect(g.some((l) => /^X.* F\d/.test(l))).toBe(false);
  });
});
