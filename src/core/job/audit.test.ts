import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, type MachineProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { auditGcode } from "./audit";
import { generateGcode } from "./gcode";
import { makePlan, stroke } from "./testPlan";

const P = DEFAULT_PROFILE;
const meta = { fileName: "x.svg", date: new Date(2026, 10, 14, 12, 0), job: DEFAULT_JOB_SETTINGS };
const head = ["G21", "G90", "M5", "G4 P0.3"];
const block = (x0: number, y0: number, pts: [number, number][]) => [
  `G0 X${x0.toFixed(2)} Y${y0.toFixed(2)}`,
  "M3 S220",
  "G4 P0.3",
  "G1 F500",
  ...pts.map(([x, y]) => `X${x.toFixed(2)} Y${y.toFixed(2)}`),
  "M5",
  "G4 P0.2",
];

describe("auditGcode", () => {
  it("o arquivo que o próprio gerador faz passa em tudo", () => {
    const plan = makePlan([stroke([[100, 100], [200, 100], [200, 200]]), stroke([[300, 100], [310, 100]]), stroke([[50, 50]])]);
    const a = auditGcode(generateGcode(plan, P, meta).toText(), P);
    expect(a.problems).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.warmupCycles).toBe(8);
    expect(a.cycles).toBe(3);
    expect(a.rapidsPenDown).toBe(0);
    expect(a.penCmdsWithoutDwell).toBe(0);
    expect(a.drawMm).toBeCloseTo(210, 5);
    expect(a.maxLineLength).toBeLessThan(70);
  });

  it("tempo no modelo do script de blindagem: traço a F, deslocamento a 3000 mm/min, pausas do G4", () => {
    const a = auditGcode([...head, ...block(100, 100, [[200, 100]])], P);
    expect(a.drawS).toBeCloseTo(100 / (500 / 60), 6); // 12 s
    expect(a.travelS).toBeCloseTo(0, 6); // posição inicial desconhecida: o 1º G0 não conta
    expect(a.dwellS).toBeCloseTo(0.3 + 0.3 + 0.2, 6);
    expect(a.longestDescentMm).toBeCloseTo(100, 6);
    expect(a.shortDescentPct).toBe(0);
  });

  it("G0 com a caneta embaixo é erro", () => {
    const a = auditGcode([...head, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G0 X150.00 Y100.00", "M5", "G4 P0.2"], P);
    expect(a.rapidsPenDown).toBe(1);
    expect(a.ok).toBe(false);
  });

  it("M3 ou M5 sem G4 logo depois é erro; a subida dupla (M5 G4 M5 G4) é aceita", () => {
    const bad = auditGcode([...head, "G0 X100.00 Y100.00", "M3 S220", "G1 F500", "X110.00 Y100.00", "M5", "G0 X0.00 Y0.00"], P);
    expect(bad.penCmdsWithoutDwell).toBe(2);
    const dbl = auditGcode([...head, ...block(100, 100, [[110, 100]]), "M5", "G4 P0.2", "G0 X0.00 Y0.00"], P);
    expect(dbl.penCmdsWithoutDwell).toBe(0);
    expect(dbl.cycles).toBe(1);
  });

  it("linha longa demais e caractere fora de ASCII são erros", () => {
    const a = auditGcode([...head, `; ${"x".repeat(80)}`, "; coração", ...block(100, 100, [[110, 100]])], P);
    expect(a.maxLineLength).toBe(82);
    expect(a.nonAsciiLines).toBe(1);
    expect(a.problems.filter((p) => p.level === "error")).toHaveLength(2);
  });

  it("traço fora da zona de desenho é erro; o aquecimento no ponto seguro não conta", () => {
    const warm = ["G0 X0.00 Y0.00", "M3 S220", "G4 P0.4", "M5", "G4 P0.4"];
    const a = auditGcode([...head, ...warm, ...block(100, 100, [[110, 100]])], P);
    expect(a.outOfZone).toBe(0);
    expect(a.warmupCycles).toBe(1);
    expect(a.cycles).toBe(1);
    const b = auditGcode([...head, ...block(100, 100, [[10, 100]])], P);
    expect(b.outOfZone).toBe(1);
    const c = auditGcode([...head, ...block(10, 10, [])], P); // ponto fora da zona
    expect(c.outOfZone).toBe(1);
    expect(auditGcode([...head, ...block(100, 100, [[900, 100]])], P).outOfArea).toBe(1);
  });

  it("ciclos por minuto, pico em 60 s e % de descidas curtas", () => {
    // 60 pontos em sequência, 0,5 s por ciclo → 30 s no total
    const dots = Array.from({ length: 60 }, (_, i) => block(100 + i, 100, [])).flat();
    const prof: MachineProfile = { ...P, servo: { ...P.servo, onOverload: "warn" } };
    const a = auditGcode([...head, ...dots], prof);
    expect(a.cycles).toBe(60);
    expect(a.peakCyclesPer60s).toBe(60);
    expect(a.avgCyclesPerMin).toBeGreaterThan(100);
    expect(a.shortDescentPct).toBe(100);
    expect(a.problems.map((p) => p.level)).toEqual(["warn", "warn"]);
    expect(a.ok).toBe(true);
    // com o limite valendo como bloqueio, vira erro
    expect(auditGcode([...head, ...dots], P).ok).toBe(false);
  });

  it("descanso do servo: G4 longo com a caneta em cima entra em restS e alivia a média", () => {
    const a = auditGcode([...head, ...block(100, 100, []), "G4 P30", ...block(101, 100, [])], P);
    expect(a.restS).toBe(30);
    expect(a.peakCyclesPer60s).toBe(2);
  });

  it("checkpoint conta como 2 ciclos do servo e é reconhecido pelo comentário", () => {
    const cp = ["; CHECKPOINT 1 (~10 min) re-sincroniza servo", "M3 S220", "G4 P0.3", "M5", "G4 P0.3", "M3 S220", "G4 P0.3", "M5", "G4 P0.4"];
    const a = auditGcode([...head, ...block(100, 100, [[110, 100]]), ...cp, ...block(120, 100, [[130, 100]])], P);
    expect(a.checkpoints).toBe(1);
    expect(a.cycles).toBe(4);
    // (4 ciclos em poucos segundos estouram a média: aqui só interessa a contagem)
    expect(a.rapidsPenDown + a.penCmdsWithoutDwell + a.outOfZone).toBe(0);
  });
});

describe("auditGcode: o que a máquina faria, e não o que o arquivo parece", () => {
  const dash = block(100, 100, [[110, 100]]);
  const errors = (lines: string[], profile: MachineProfile = P) => auditGcode(lines, profile).problems.filter((p) => p.level === "error").map((p) => p.message);

  it("altura do servo: M3 com outro S, M3 sem S nenhum e S trocado com a caneta embaixo são erro", () => {
    expect(auditGcode([...head, ...dash], P).wrongServoPosition).toBe(0);
    const other = auditGcode([...head, ...dash.map((l) => (l === "M3 S220" ? "M3 S90" : l))], P);
    expect(other.wrongServoPosition).toBe(1);
    expect(other.ok).toBe(false);
    // sem S o GRBL usa o último; depois de um reset é S0 e a caneta nem desce
    expect(auditGcode([...head, ...dash.map((l) => (l === "M3 S220" ? "M3" : l))], P).wrongServoPosition).toBe(1);
    // S solto no meio do traço move o servo na hora
    const live = [...head, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "X105.00 Y100.00", "S100", "X110.00 Y100.00", "M5", "G4 P0.2"];
    expect(auditGcode(live, P).wrongServoPosition).toBe(1);
    // o S vale enquanto não mudar: um M3 sem S depois de um M3 S220 desce certo
    expect(auditGcode([...head, ...dash, ...block(120, 100, [[130, 100]]).map((l) => (l === "M3 S220" ? "M3" : l))], P).wrongServoPosition).toBe(0);
  });

  it("pausa do servo mais curta que a regra (0,3 s descer, 0,2 s subir) é aviso; G4 P0 é erro", () => {
    const short = auditGcode([...head, ...dash.map((l) => (l === "G4 P0.3" ? "G4 P0.1" : l === "G4 P0.2" ? "G4 P0.1" : l))], P);
    expect(short.shortDwells).toBe(2);
    expect(short.penCmdsWithoutDwell).toBe(0);
    expect(short.problems.filter((p) => p.level === "warn" && /pausa/.test(p.message))).toHaveLength(1);
    expect(auditGcode([...head, ...dash], P).shortDwells).toBe(0);
    expect(auditGcode([...head, ...dash.map((l) => (l === "G4 P0.2" ? "G4 P0" : l))], P).penCmdsWithoutDwell).toBe(1);
  });

  it("aquecimento é decidido pelo arquivo: 8 batidas no mesmo lugar abrem o arquivo, com a blindagem ligada ou não", () => {
    const taps = (n: number) => Array.from({ length: n }, () => ["M3 S220", "G4 P0.4", "M5", "G4 P0.4"]).flat();
    const off: MachineProfile = { ...P, shield: { ...P.shield, enabled: false } };
    const a = auditGcode([...head, "G0 X0.00 Y0.00", ...taps(8), ...dash], off);
    expect({ warm: a.warmupCycles, cycles: a.cycles, zone: a.outOfZone }).toEqual({ warm: 8, cycles: 1, zone: 0 });
    // noutro ponto qualquer, fora do ponto seguro, também
    const b = auditGcode([...head, "G0 X5.00 Y5.00", ...taps(8), ...dash], P);
    expect({ warm: b.warmupCycles, cycles: b.cycles, zone: b.outOfZone }).toEqual({ warm: 8, cycles: 1, zone: 0 });
  });

  it("uma batida só fora do ponto seguro é um ponto do desenho (e fora da folha, é erro)", () => {
    const tap = ["M3 S220", "G4 P0.4", "M5", "G4 P0.4"];
    const a = auditGcode([...head, "G0 X5.00 Y5.00", ...tap, ...dash], P);
    expect({ warm: a.warmupCycles, cycles: a.cycles, zone: a.outOfZone }).toEqual({ warm: 0, cycles: 2, zone: 1 });
    // dentro da folha é só um ponto
    const b = auditGcode([...head, "G0 X50.00 Y50.00", ...tap, ...dash], P);
    expect({ warm: b.warmupCycles, cycles: b.cycles, zone: b.outOfZone }).toEqual({ warm: 0, cycles: 2, zone: 0 });
  });

  it("batidas no ar DEPOIS de começar a desenhar são ciclos do desenho (checkpoint), nunca aquecimento", () => {
    const tap = ["M3 S220", "G4 P0.3", "M5", "G4 P0.3"];
    const a = auditGcode([...head, ...dash, ...tap, ...tap, ...block(120, 100, [[130, 100]])], P);
    expect({ warm: a.warmupCycles, cycles: a.cycles }).toEqual({ warm: 0, cycles: 4 });
  });

  it("o pico conta o aquecimento; o pico só do desenho é informado à parte", () => {
    const taps = Array.from({ length: 8 }, () => ["M3 S220", "G4 P0.4", "M5", "G4 P0.4"]).flat();
    const dots = Array.from({ length: 5 }, (_, i) => block(100 + i, 100, [])).flat();
    const a = auditGcode([...head, "G0 X0.00 Y0.00", ...taps, ...dots], P);
    expect(a.peakCyclesPer60s).toBe(13);
    expect(a.peakDrawCyclesPer60s).toBe(5);
  });

  it("linha que ela não sabe ler, comando de configuração e arco são erro", () => {
    expect(errors([...head, ...dash, "G2 X120 Y100 I5 J0"]).join(" ")).toMatch(/não sabe ler/);
    expect(errors([...head, "$110=3000", ...dash]).join(" ")).toMatch(/configuração/);
    expect(errors([...head, ...dash, "G20"]).join(" ")).toMatch(/não sabe ler/);
    expect(errors([...head, ...dash, "bom dia"]).join(" ")).toMatch(/não sabe ler/);
    expect(auditGcode([...head, ...dash, "M2"], P).unknownLines).toBe(0);
  });

  it("M2 no fim levanta a caneta: a descida aberta é fechada e contada", () => {
    const a = auditGcode([...head, "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500", "X110.00 Y100.00", "M2"], P);
    expect(a.cycles).toBe(1);
    expect(a.drawMm).toBeCloseTo(10, 6);
  });
});
