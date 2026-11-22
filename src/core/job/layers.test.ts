import { describe, expect, it } from "vitest";
import { createDrawing, type Drawing, type PlotDocument } from "../document";
import { IDENTITY } from "../geometry/mat2d";
import type { Geometry } from "../geometry/path";
import { DEFAULT_PROFILE, type MachineProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { auditGcode, auditOptionsOf, checkAgainstPlan } from "./audit";
import { generateGcode } from "./gcode";
import { crossStroke, layersOf, REGISTRATION_ID, registrationBoxes, usesRegistration } from "./layers";
import { planJob, planLayers } from "./pipeline";
import type { JobPlan } from "./types";

const P = DEFAULT_PROFILE;
const H = P.workArea.height;
const JOB = DEFAULT_JOB_SETTINGS;
const META = { fileName: "teste.svg", date: new Date(2026, 10, 22, 1, 0), job: JOB };

/** Desenho feito de polilinhas dadas em mm da MÁQUINA (a cena tem o Y para baixo). */
function drawing(id: string, polys: [number, number][][], penId?: string): Drawing {
  const geometry: Geometry = {
    subpaths: polys.map((pts) => ({
      start: { x: pts[0][0], y: H - pts[0][1] },
      segments: pts.slice(1).map(([x, y]) => ({ kind: "line" as const, to: { x, y: H - y } })),
      closed: false,
    })),
  };
  return createDrawing(id, `${id}.svg`, geometry, IDENTITY, penId);
}
const doc = (...drawings: Drawing[]): PlotDocument => ({ drawings });
const text = (plan: JobPlan, profile: MachineProfile = P) => generateGcode(plan, profile, META).lines.map((l) => l.text);
const pts = (plan: JobPlan, i: number) => plan.strokes[i].points.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);

const LINE_A: [number, number][] = [[100, 100], [200, 100]];
const LINE_B: [number, number][] = [[100, 150], [200, 150]];
const LINE_C: [number, number][] = [[100, 200], [200, 200]];

describe("layersOf: uma camada por caneta, na ordem do estojo", () => {
  it("desenho sem caneta vai na caneta padrão: uma camada só", () => {
    const layers = layersOf(doc(drawing("a", [LINE_A]), drawing("b", [LINE_B])), P);
    expect(layers.map((l) => [l.pen.id, l.index, l.count, l.drawings])).toEqual([["preta", 0, 1, 2]]);
  });
  it("a ordem é a do perfil (cor → fina → grossa), não a do documento", () => {
    const layers = layersOf(doc(drawing("a", [LINE_A], "preta"), drawing("b", [LINE_B], "fina"), drawing("c", [LINE_C], "verde")), P);
    expect(layers.map((l) => l.pen.id)).toEqual(["verde", "fina", "preta"]);
    expect(layers.map((l) => l.index)).toEqual([0, 1, 2]);
    expect(layers.every((l) => l.count === 3)).toBe(true);
  });
  it("caneta que não existe mais cai na padrão", () => {
    const layers = layersOf(doc(drawing("a", [LINE_A], "sumiu")), P);
    expect(layers.map((l) => l.pen.id)).toEqual(["preta"]);
  });
  it("as cruzes entram com mais de uma caneta (auto), sempre, ou nunca", () => {
    expect(usesRegistration(P, 1)).toBe(false);
    expect(usesRegistration(P, 2)).toBe(true);
    expect(usesRegistration({ ...P, registration: { ...P.registration, mode: "always" } }, 1)).toBe(true);
    expect(usesRegistration({ ...P, registration: { ...P.registration, mode: "never" } }, 3)).toBe(false);
  });
});

describe("cruz de registro", () => {
  it("ida e volta pelo mesmo caminho, sem diagonal: o percurso dos arquivos blindados que já rodaram", () => {
    // omega3_1fina_BLINDADO.gcode, cruz em X19 Y12
    expect(crossStroke(19, 12, 6).points.map((p) => [p.x, p.y])).toEqual([
      [16, 12],
      [22, 12],
      [19, 12],
      [19, 9],
      [19, 15],
      [19, 9],
      [19, 12],
      [22, 12],
      [16, 12],
    ]);
  });
  it("nenhum trecho é diagonal", () => {
    const c = crossStroke(20, 12, 6).points;
    for (let i = 1; i < c.length; i++) expect(c[i].x === c[i - 1].x || c[i].y === c[i - 1].y).toBe(true);
  });
  it("as caixas das cruzes ficam em X20 e X580, Y12, com 6 mm", () => {
    expect(registrationBoxes(P)).toEqual([
      { minX: 17, minY: 9, maxX: 23, maxY: 15 },
      { minX: 577, minY: 9, maxX: 583, maxY: 15 },
    ]);
  });
});

describe("planJob com uma caneta só: nada muda", () => {
  const plan = planJob(doc(drawing("a", [LINE_A]), drawing("b", [LINE_B])), P, JOB);
  it("sem cruzes, sem deslocamento, os dois desenhos no mesmo plano", () => {
    expect(plan.layer).toMatchObject({ penId: "preta", index: 0, count: 1, registration: false, offset: { x: 0, y: 0 } });
    expect(plan.strokes.map((s) => s.drawingId).sort()).toEqual(["a", "b"]);
  });
  it("o cabeçalho diz a caneta, sem falar em camada", () => {
    const head = text(plan).slice(0, 4);
    expect(head).toContain("; caneta Preta 0,4 - 0.4 mm");
    expect(head.join("\n")).not.toMatch(/camada|cruz/);
  });
  it("planLayers devolve o mesmo plano", () => {
    const all = planLayers(doc(drawing("a", [LINE_A]), drawing("b", [LINE_B])), P, JOB);
    expect(all).toHaveLength(1);
    expect(all[0].strokes).toEqual(plan.strokes);
  });
  it("documento vazio: nenhuma camada, e planJob ainda devolve um plano vazio", () => {
    expect(planLayers(doc(), P, JOB)).toEqual([]);
    const empty = planJob(doc(), P, JOB);
    expect(empty.strokes).toEqual([]);
    expect(empty.layer?.penId).toBe("preta");
  });
});

describe("planLayers com duas canetas (fina + preta)", () => {
  const d = doc(drawing("grosso", [LINE_A], "preta"), drawing("fino", [LINE_B, LINE_C], "fina"));
  const [fina, preta] = planLayers(d, P, JOB);

  it("a fina vem antes da grossa", () => {
    expect([fina.layer?.penId, preta.layer?.penId]).toEqual(["fina", "preta"]);
    expect([fina.layer?.index, preta.layer?.index]).toEqual([0, 1]);
  });
  it("cada camada só tem os traços dos desenhos da sua caneta", () => {
    const ids = (p: JobPlan) => [...new Set(p.strokes.map((s) => s.drawingId).filter((id) => id !== REGISTRATION_ID))];
    expect(ids(fina)).toEqual(["fino"]);
    expect(ids(preta)).toEqual(["grosso"]);
  });
  it("cada camada começa pela cruz em X20 e termina pela cruz em X580", () => {
    for (const p of [fina, preta]) {
      expect(p.strokes[0].drawingId).toBe(REGISTRATION_ID);
      expect(p.strokes[p.strokes.length - 1].drawingId).toBe(REGISTRATION_ID);
      // cada cruz é uma descida própria
      expect(p.strokes[0].joinedToPrevious).toBe(false);
      expect(p.strokes[1].joinedToPrevious).toBe(false);
      expect(p.strokes[p.strokes.length - 1].joinedToPrevious).toBe(false);
    }
    expect(pts(preta, 0)[0]).toEqual([17, 12]);
    expect(pts(preta, preta.strokes.length - 1)[0]).toEqual([577, 12]);
  });
  it("a camada fina sai inteira 1 mm para a esquerda (correção da ponta), cruzes incluídas", () => {
    expect(fina.layer?.offset).toEqual({ x: 1, y: 0 });
    expect(pts(fina, 0)[0]).toEqual([16, 12]); // cruz em X19, como no omega3
    expect(pts(fina, fina.strokes.length - 1)[0]).toEqual([576, 12]);
    const body = fina.strokes.filter((s) => s.drawingId === "fino").flatMap((s) => s.points.map((p) => p.x));
    expect(Math.min(...body)).toBeCloseTo(99, 6);
    expect(Math.max(...body)).toBeCloseTo(199, 6);
    // a grossa não é deslocada
    const thick = preta.strokes.filter((s) => s.drawingId === "grosso").flatMap((s) => s.points.map((p) => p.x));
    expect(Math.min(...thick)).toBeCloseTo(100, 6);
  });
  it("o G-code da fina: cabeçalho, cruz em ida e volta e a 1ª descida com a pausa longa", () => {
    const g = text(fina);
    expect(g).toContain("; camada 1 de 2 - caneta Fina 0,03 - 0.1 mm");
    expect(g).toContain("; ponta corrigida: camada deslocada -1.00 mm em X");
    expect(g).toContain("; 1o traco: cruz em X19 Y12 - ultimo: X579 Y12");
    const i = g.indexOf("; cruz de registro em ida e volta");
    expect(g.slice(i, i + 13)).toEqual([
      "; cruz de registro em ida e volta",
      "G0 X16.00 Y12.00",
      "M3 S220",
      "G4 P0.6",
      "G1 F500",
      "X22.00 Y12.00",
      "X19.00 Y12.00",
      "X19.00 Y9.00",
      "X19.00 Y15.00",
      "X19.00 Y9.00",
      "X19.00 Y12.00",
      "X22.00 Y12.00",
      "X16.00 Y12.00",
    ]);
    // a outra cruz é a última descida antes do rodapé
    expect(g.lastIndexOf("; cruz de registro em ida e volta")).toBeGreaterThan(g.lastIndexOf("G0 X99.00 Y150.00"));
  });
  it("a grossa manda rodar depois, sem mexer no papel", () => {
    const g = text(preta);
    expect(g).toContain("; camada 2 de 2 - caneta Preta 0,4 - 0.4 mm");
    expect(g).toContain("; rodar DEPOIS da camada anterior, sem mexer no papel");
    expect(g.join("\n")).not.toMatch(/ponta corrigida/);
    expect(g).toContain("G0 X17.00 Y12.00");
  });
  it("a auditoria aceita as cruzes fora da zona, mas só quando o plano diz que elas existem", () => {
    for (const p of [fina, preta]) {
      const g = text(p);
      const ok = auditGcode(g, P, auditOptionsOf(p));
      expect(ok.outOfZone).toBe(0);
      expect(ok.problems.filter((x) => x.level === "error")).toEqual([]);
      // o mesmo arquivo, conferido sem saber das cruzes: elas estão fora da folha
      expect(auditGcode(g, P).outOfZone).toBeGreaterThan(0);
    }
  });
  it("todas as linhas cabem no buffer do GRBL e são ASCII", () => {
    for (const p of [fina, preta]) {
      const a = auditGcode(text(p), P, auditOptionsOf(p));
      expect(a.maxLineLength).toBeLessThan(70);
      expect(a.nonAsciiLines).toBe(0);
    }
  });
  it("planJob escolhe a camada pela caneta; sem dizer, é a primeira a plotar", () => {
    expect(planJob(d, P, JOB, { penId: "preta" }).layer?.penId).toBe("preta");
    expect(planJob(d, P, JOB).layer?.penId).toBe("fina");
    expect(planJob(d, P, JOB, { penId: "nao-existe" }).layer?.penId).toBe("fina");
  });
});

describe("zona de desenho e correção da ponta", () => {
  it("traço da fina colado na borda esquerda da folha: o arquivo traz X29, mas a tinta cai em X30", () => {
    const d = doc(drawing("fino", [[[30, 100], [80, 100]]], "fina"));
    const plan = planJob(d, P, JOB);
    expect(plan.violations).toEqual([]);
    const g = text(plan);
    expect(g).toContain("G0 X29.00 Y100.00");
    expect(auditGcode(g, P, auditOptionsOf(plan)).outOfZone).toBe(0);
    // sem saber da correção, o X29 parece fora da folha
    expect(auditGcode(g, P).outOfZone).toBeGreaterThan(0);
  });
  it("traço da fina passando da borda direita da folha continua sendo violação", () => {
    const d = doc(drawing("fino", [[[500, 100], [571, 100]]], "fina"));
    expect(planJob(d, P, JOB).violations.map((v) => v.kind)).toEqual(["zone"]);
  });
  it("desenho fora da folha numa camada trava todas", () => {
    const d = doc(drawing("grosso", [LINE_A], "preta"), drawing("fino", [[[500, 100], [575, 100]]], "fina"));
    for (const p of planLayers(d, P, JOB)) expect(p.violations.map((v) => v.drawingId)).toEqual(["fino"]);
  });
  it("correção que empurra o desenho para fora do curso da máquina é violação de área", () => {
    const wide: MachineProfile = {
      ...P,
      drawZone: { minX: 0, minY: 0, maxX: 810, maxY: 385 },
      registration: { ...P.registration, mode: "never" },
      pens: P.pens.map((p) => (p.id === "fina" ? { ...p, offsetX: 5 } : p)),
    };
    const plan = planJob(doc(drawing("fino", [[[2, 100], [80, 100]]], "fina")), wide, JOB);
    expect(plan.violations.map((v) => [v.drawingId, v.kind])).toEqual([["fino", "area"]]);
  });
});

describe("emendas usam a largura da caneta da camada", () => {
  // dois traços em sequência com um salto de 0,3 mm: invisível na 0,4, visível na fina (0,1)
  const gap: [number, number][][] = [
    [[100, 100], [150, 100]],
    [[150.3, 100], [200, 100]],
  ];
  it("na caneta de 0,4 mm os dois viram uma descida só", () => {
    const plan = planJob(doc(drawing("a", gap, "preta")), P, JOB);
    expect(plan.descents).toHaveLength(1);
  });
  it("na fina (0,1 mm) são duas descidas", () => {
    const plan = planJob(doc(drawing("a", gap, "fina")), P, JOB);
    expect(plan.descents).toHaveLength(2);
  });
});

describe("cruzes ligadas sempre", () => {
  it("com uma caneta só e o modo 'sempre', o desenho também ganha as cruzes", () => {
    const always: MachineProfile = { ...P, registration: { ...P.registration, mode: "always" } };
    const plan = planJob(doc(drawing("a", [LINE_A])), always, JOB);
    expect(plan.layer?.registration).toBe(true);
    expect(plan.strokes.filter((s) => s.drawingId === REGISTRATION_ID)).toHaveLength(2);
    const g = text(plan, always);
    expect(auditGcode(g, always, auditOptionsOf(plan)).ok).toBe(true);
  });
});

describe("o arquivo risca exatamente o que o plano mandou (seção 10 das regras)", () => {
  const d = doc(drawing("grosso", [LINE_A, LINE_B, [[300, 100], [300, 100.3]]], "preta"), drawing("fino", [LINE_C], "fina"));
  it("G-code gerado do plano: descidas e comprimento batem, em cada camada", () => {
    for (const plan of planLayers(d, P, JOB)) {
      const a = auditGcode(text(plan), P, auditOptionsOf(plan));
      expect(checkAgainstPlan(plan, a)).toBe(a); // nada a acrescentar
    }
  });
  it("bloco apagado do arquivo: a conferência acusa a descida e os milímetros que faltam", () => {
    const plan = planJob(d, P, JOB, { penId: "preta" });
    const g = text(plan);
    const i = g.indexOf("G0 X100.00 Y150.00");
    const j = g.indexOf("M5", i);
    const cut = [...g.slice(0, i), ...g.slice(j + 4)]; // tira o bloco inteiro, com a subida dupla
    const a = checkAgainstPlan(plan, auditGcode(cut, P, auditOptionsOf(plan)));
    expect(a.ok).toBe(false);
    expect(a.problems.map((p) => p.message).join(" ")).toMatch(/descidas.*perdido ou criado/);
    expect(a.problems.map((p) => p.message).join(" ")).toMatch(/não saiu inteiro/);
  });
});
