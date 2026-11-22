import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, type MachineProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { auditGcode } from "./audit";
import { formatCoord, generateGcode, MAX_LINE_LENGTH, toAsciiComment } from "./gcode";
import { makePlan, stroke } from "./testPlan";

const P = DEFAULT_PROFILE;
const NO_SHIELD: MachineProfile = { ...P, shield: { ...P.shield, enabled: false } };
const meta = { fileName: "x.svg", date: new Date(2026, 10, 14, 12, 0), job: DEFAULT_JOB_SETTINGS };
const text = (p: ReturnType<typeof makePlan>, profile = P, m = meta) => generateGcode(p, profile, m).lines.map((l) => l.text);
/** Só o miolo: sem cabeçalho/aquecimento e sem rodapé (perfil sem blindagem). */
const body = (strokes: Parameters<typeof makePlan>[0], m = meta) => text(makePlan(strokes, NO_SHIELD), NO_SHIELD, m).slice(6, -2);

describe("formatCoord", () => {
  it.each([
    [-0.004, "0.00"],
    [-0.0049, "0.00"],
    [12.345, "12.35"],
    [0, "0.00"],
    [810, "810.00"],
  ])("%d → %s", (v, s) => expect(formatCoord(v)).toBe(s));
});

describe("toAsciiComment", () => {
  it("tira acentos, troca travessão e aspas curvas, o resto vira ?", () => {
    expect(toAsciiComment("Coração — “teste” ★")).toBe('Coracao - "teste" ?');
  });
  it("parênteses viram colchetes (desenho (1).svg)", () => {
    expect(toAsciiComment("desenho (1).svg")).toBe("desenho [1].svg");
  });
  it("corta em 60 caracteres e nunca tem quebra de linha", () => {
    const s = toAsciiComment("a\nb" + "x".repeat(100));
    expect(s.length).toBe(60);
    expect(s).not.toMatch(/\n/);
  });
});

describe("generateGcode: formato de docs/REGRAS_GCODE.md", () => {
  it("cabeçalho e aquecimento do servo, como no arquivo blindado que já rodou na máquina", () => {
    const lines = text(makePlan([stroke([[100, 100], [110, 100]])]), P, { ...meta, fileName: "Coração.svg" });
    expect(lines.slice(0, 9)).toEqual([
      "; Plotter Studio - Coracao.svg - 2026-11-14 12:00",
      "; modo: fixo F500",
      "G21",
      "G90",
      "M5",
      "G4 P0.3",
      "; aquecimento do servo no ponto seguro",
      "M5",
      "G4 P0.3",
    ]);
    expect(lines[9]).toBe("G0 X0.00 Y0.00");
    const cycle = ["M3 S220", "G4 P0.4", "M5", "G4 P0.4"];
    expect(lines.slice(10, 10 + 8 * 4)).toEqual(Array.from({ length: 8 }, () => cycle).flat());
    expect(lines[42]).toBe("G4 P1");
  });

  it("um traço: bloco G0 / M3 / G4 / G1 F / pontos / subida dupla, e o rodapé", () => {
    const lines = text(makePlan([stroke([[100, 100], [110, 100], [110, 120]])]));
    expect(lines.slice(43)).toEqual([
      "G0 X100.00 Y100.00",
      "M3 S220",
      "G4 P0.6", // 1ª descida: pausa longa
      "G1 F500",
      "X110.00 Y100.00",
      "X110.00 Y120.00",
      "M5",
      "G4 P0.2",
      "M5",
      "G4 P0.2",
      "M5",
      "G4 P0.3",
      "M5",
      "G4 P0.3",
      "G0 X0.00 Y0.00",
      "M2",
    ]);
  });

  it("da 2ª descida em diante a pausa é a normal (0.3)", () => {
    const lines = text(makePlan([stroke([[100, 100], [110, 100]]), stroke([[200, 100], [210, 100]])]));
    const i = lines.indexOf("G0 X200.00 Y100.00");
    expect(lines.slice(i, i + 4)).toEqual(["G0 X200.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F500"]);
  });

  it("sem blindagem: sem aquecimento, subida simples e rodapé curto", () => {
    expect(text(makePlan([stroke([[100, 100], [110, 100]])], NO_SHIELD), NO_SHIELD)).toEqual([
      "; Plotter Studio - x.svg - 2026-11-14 12:00",
      "; modo: fixo F500",
      "G21",
      "G90",
      "M5",
      "G4 P0.3",
      "G0 X100.00 Y100.00",
      "M3 S220",
      "G4 P0.3",
      "G1 F500",
      "X110.00 Y100.00",
      "M5",
      "G4 P0.2",
      "G0 X0.00 Y0.00",
      "M2",
    ]);
  });

  it("traço emendado: a ligação é desenhada, sem M5/M3 entre os dois", () => {
    expect(body([stroke([[100, 100], [110, 100]]), stroke([[110.3, 100], [120, 100]], { joined: true })])).toEqual([
      "G0 X100.00 Y100.00",
      "M3 S220",
      "G4 P0.3",
      "G1 F500",
      "X110.00 Y100.00",
      "X110.30 Y100.00",
      "X120.00 Y100.00",
      "M5",
      "G4 P0.2",
    ]);
  });

  it("corte de descida longa: sobe e desce no mesmo ponto, com o bloco completo", () => {
    const b = body([stroke([[100, 100], [110, 100]]), stroke([[110, 100], [120, 100]], { joined: true, relift: true })]);
    expect(b).toEqual([
      "G0 X100.00 Y100.00",
      "M3 S220",
      "G4 P0.3",
      "G1 F500",
      "X110.00 Y100.00",
      "M5",
      "G4 P0.2",
      "G0 X110.00 Y100.00",
      "M3 S220",
      "G4 P0.3",
      "G1 F500",
      "X120.00 Y100.00",
      "M5",
      "G4 P0.2",
    ]);
  });

  it("ponto = desce e sobe a caneta no lugar", () => {
    expect(body([stroke([[50, 50]])])).toEqual(["G0 X50.00 Y50.00", "M3 S220", "G4 P0.3", "G1 F500", "M5", "G4 P0.2"]);
  });

  it("o G0 de cada descida sai sempre, mesmo se a máquina já estaria lá", () => {
    // a máquina pode estar em qualquer lugar ao rodar o arquivo (ex.: 810/385 depois do Home)
    const b = body([stroke([[0, 0], [10, 0]])]);
    expect(b[0]).toBe("G0 X0.00 Y0.00");
    expect(b[1]).toBe("M3 S220");
  });

  it("coordenada repetida depois de arredondar é omitida", () => {
    const b = body([stroke([[100, 100], [100.001, 100.001], [200, 200]])]);
    expect(b.filter((l) => l.startsWith("X"))).toEqual(["X200.00 Y200.00"]);
  });

  it("coordenada um fio fora do curso (dentro da folga) é presa à borda", () => {
    const b = body([stroke([[809.999, 384.999], [810.004, 385.004]])]);
    expect(b).toContain("G0 X810.00 Y385.00");
    expect(b.some((l) => l.includes("810.01"))).toBe(false);
  });

  it("modo dinâmico: o F vai na própria linha, só quando muda", () => {
    const job = { ...DEFAULT_JOB_SETTINGS, speedMode: "dynamic" as const };
    const b = body([stroke([[100, 100], [110, 100], [120, 100], [130, 100]], { feeds: [2000, 2000, 600] })], { ...meta, job });
    expect(b.slice(3, 7)).toEqual(["G1 F2000", "X110.00 Y100.00", "X120.00 Y100.00", "X130.00 Y100.00 F600"]);
    expect(text(makePlan([]), P, { ...meta, job })[1]).toBe("; modo: dinamico - reta F2000 / curva F1200 / fechada F600");
  });

  it("recusa plano com desenho fora da área", () => {
    const p = { ...makePlan([]), violations: [{ drawingId: "d", bbox: { minX: -1, minY: 0, maxX: 1, maxY: 1 }, message: "sai", kind: "area" as const }] };
    expect(() => generateGcode(p, P, meta)).toThrow("fora da área");
  });

  it("strokeIndex e pointIndex para mapear linhas a traços (v2)", () => {
    const lines = generateGcode(makePlan([stroke([[100, 100], [110, 100]])]), P, meta).lines;
    const move = lines.find((l) => l.text.startsWith("X110"))!;
    expect(move.strokeIndex).toBe(0);
    expect(move.pointIndex).toBe(1);
    expect(lines[0].strokeIndex).toBe(-1);
  });

  it("toda linha tem menos de 70 caracteres e só ASCII, mesmo com nome enorme e acentuado", () => {
    const name = "Ilustração — “máscara” número (1) versão final corrigida de novo.svg";
    const lines = text(makePlan([stroke([[100, 100], [110, 100]])]), P, { ...meta, fileName: name });
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
      expect(l).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});

describe("generateGcode: descanso do servo, checkpoints e partes", () => {
  // 400 pontos colados: sem descanso seriam centenas de ciclos por minuto
  const dots = Array.from({ length: 400 }, (_, i) => stroke([[100 + (i % 40) * 2, 100 + Math.floor(i / 40) * 2]]));

  it("no modo esperar, o arquivo gerado respeita a média e o pico do servo", () => {
    const plan = makePlan(dots);
    const lines = text(plan);
    expect(lines).toContain("; descanso do servo");
    const a = auditGcode(lines, P);
    expect(a.peakCyclesPer60s).toBeLessThanOrEqual(P.servo.peakPer60s);
    expect(a.avgCyclesPerMin).toBeLessThanOrEqual(P.servo.avgPerMin * 1.02 + 0.05);
    expect(a.ok).toBe(true);
    expect(plan.stats.overloads).toBeGreaterThan(0);
    expect(plan.stats.estimate.waitS).toBeGreaterThan(60);
  });

  it("no modo avisar, não há descanso e a auditoria aponta o excesso", () => {
    const prof: MachineProfile = { ...P, servo: { ...P.servo, onOverload: "warn" } };
    const lines = text(makePlan(dots, prof), prof);
    expect(lines).not.toContain("; descanso do servo");
    const a = auditGcode(lines, prof);
    expect(a.peakCyclesPer60s).toBeGreaterThan(prof.servo.peakPer60s);
    expect(a.problems.some((p) => p.level === "warn" && /pico/.test(p.message))).toBe(true);
  });

  it("checkpoint a cada ~10 min, com 2 ciclos curtos, e partes cortadas num checkpoint", () => {
    // 70 traços de 800 mm a F500 = ~1,6 min cada → ~112 min
    const long = Array.from({ length: 70 }, (_, i) => stroke([[100, 100 + i * 3], [500, 100 + i * 3], [100, 101 + i * 3]]));
    const plan = makePlan(long);
    expect(plan.stats.checkpoints).toBeGreaterThanOrEqual(9);
    expect(plan.stats.parts).toBeGreaterThanOrEqual(3);
    const lines = text(plan);
    const i = lines.findIndex((l) => l.startsWith("; CHECKPOINT 1 "));
    expect(lines[i]).toMatch(/^; CHECKPOINT 1 \(~1\d min\) re-sincroniza servo$/);
    expect(lines.slice(i + 1, i + 9)).toEqual(["M3 S220", "G4 P0.3", "M5", "G4 P0.3", "M3 S220", "G4 P0.3", "M5", "G4 P0.4"]);
    expect(lines[i + 9]).toMatch(/^G0 /);

    // cada parte é um arquivo completo: cabeçalho, aquecimento, só os traços dela, rodapé
    let moves = 0;
    for (let part = 0; part < plan.stats.parts; part++) {
      const pl = generateGcode(plan, P, meta, { part }).lines.map((l) => l.text);
      expect(pl[2]).toBe(`; parte ${part + 1} de ${plan.stats.parts}`);
      expect(pl).toContain("; aquecimento do servo no ponto seguro");
      expect(pl[pl.length - 1]).toBe("M2");
      expect(auditGcode(pl, P).ok).toBe(true);
      moves += pl.filter((l) => l.startsWith("X")).length;
    }
    // nenhum traço perdido nem criado ao dividir
    expect(moves).toBe(lines.filter((l) => l.startsWith("X")).length);
  });
});
