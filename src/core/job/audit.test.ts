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
