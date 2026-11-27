import { describe, expect, it } from "vitest";
import { createDrawing, type Drawing, type PlotDocument } from "../document";
import { IDENTITY } from "../geometry/mat2d";
import type { Geometry } from "../geometry/path";
import type { Vec } from "../geometry/vec";
import { DEFAULT_PROFILE, mergeProfile, type MachineProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { auditGcode, auditOptionsOf, checkAgainstPlan } from "./audit";
import { generateGcode } from "./gcode";
import { buildInkGraph, InkSearch } from "./inkpath";
import { planJob } from "./pipeline";
import type { JobPlan, Stroke } from "./types";

const P = DEFAULT_PROFILE;
const H = P.workArea.height;
const JOB = DEFAULT_JOB_SETTINGS;
const META = { fileName: "teste.svg", date: new Date(2026, 10, 27, 1, 0), job: JOB };

/** Desenho feito de polilinhas dadas em mm da MÁQUINA. */
function drawing(id: string, polys: [number, number][][]): Drawing {
  const geometry: Geometry = {
    subpaths: polys.map((pts) => ({
      start: { x: pts[0][0], y: H - pts[0][1] },
      segments: pts.slice(1).map(([x, y]) => ({ kind: "line" as const, to: { x, y: H - y } })),
      closed: false,
    })),
  };
  return createDrawing(id, `${id}.svg`, geometry, IDENTITY);
}
const doc = (...polys: [number, number][][]): PlotDocument => ({ drawings: [drawing("d", polys)] });
const withJoin = (join: Partial<MachineProfile["join"]>): MachineProfile => ({ ...P, join: { ...P.join, ...join } });
const stroke = (pts: [number, number][], closed = false): Stroke => ({ points: pts.map(([x, y]) => ({ x, y })), closed, drawingId: "d" });

/** Distância de p até a polilinha mais perto entre as dadas. */
function distToInk(p: Vec, polys: [number, number][][]): number {
  let best = Infinity;
  for (const pl of polys) {
    for (let i = 0; i + 1 < pl.length; i++) {
      const [ax, ay] = pl[i], [bx, by] = pl[i + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.y - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy));
    }
  }
  return best;
}

function audited(plan: JobPlan, profile: MachineProfile = P) {
  return checkAgainstPlan(plan, auditGcode(generateGcode(plan, profile, META).toText(), profile, auditOptionsOf(plan)));
}

describe("InkSearch: o começo de traço mais perto andando pela tinta", () => {
  it("segue a linha, mesmo fazendo curva, até a ponta de outro traço", () => {
    const strokes = [stroke([[0, 0], [10, 0], [10, 10]]), stroke([[10, 10.1], [30, 30]])];
    const g = buildInkGraph(strokes, { gapMm: 0.4, hiddenHopMm: 0 });
    const s = new InkSearch(g);
    const used = Uint8Array.from([1, 0]);
    const r = s.nearestEntry(s.node(0, 0), 100, used)!;
    expect(r.stroke).toBe(1);
    expect(r.vertex).toBe(0);
    expect(r.lengthMm).toBeCloseTo(20.1, 6);
    expect(r.path.map((p) => [p.x, p.y])).toEqual([[10, 0], [10, 10], [10, 10.1]]);
  });

  it("chega pela junção em T: a ponta de um traço que encosta no MEIO de outro", () => {
    // o traço 1 começa em (5, 0.2), em cima do meio do traço 0
    const strokes = [stroke([[0, 0], [20, 0]]), stroke([[5, 0.2], [5, 10]])];
    const s = new InkSearch(buildInkGraph(strokes, { gapMm: 0.4, hiddenHopMm: 0 }));
    const r = s.nearestEntry(s.node(0, 1), 100, Uint8Array.from([1, 0]))!;
    expect(r.stroke).toBe(1);
    expect(r.lengthMm).toBeCloseTo(15 + 0.2, 6);
  });

  it("não passa do limite de comprimento", () => {
    const strokes = [stroke([[0, 0], [10, 0], [10, 10]]), stroke([[10, 10], [30, 30]])];
    const s = new InkSearch(buildInkGraph(strokes, { gapMm: 0.4, hiddenHopMm: 0 }));
    expect(s.nearestEntry(s.node(0, 0), 19.9, Uint8Array.from([1, 0]))).toBeUndefined();
    expect(s.nearestEntry(s.node(0, 0), 20, Uint8Array.from([1, 0]))?.stroke).toBe(1);
  });

  it("traços já usados não são entrada (mas o caminho pode passar por eles)", () => {
    const strokes = [stroke([[0, 0], [10, 0]]), stroke([[10, 0], [20, 0]]), stroke([[20, 0], [30, 0]])];
    const s = new InkSearch(buildInkGraph(strokes, { gapMm: 0.4, hiddenHopMm: 0 }));
    const r = s.nearestEntry(s.node(0, 0), 100, Uint8Array.from([1, 1, 0]))!;
    expect(r.stroke).toBe(2);
    expect(r.lengthMm).toBeCloseTo(20, 6);
  });

  it("traço aberto entra pela ponta mais perto (pelo fim = −1); laço entra por qualquer vértice", () => {
    const strokes = [stroke([[0, 0], [10, 0]]), stroke([[20, 0], [10, 0]]), stroke([[10, 0], [10, 5], [15, 5], [10, 0]], true)];
    const s = new InkSearch(buildInkGraph(strokes, { gapMm: 0.4, hiddenHopMm: 0 }));
    const a = s.nearestEntry(s.node(0, 0), 100, Uint8Array.from([1, 0, 1]))!;
    expect([a.stroke, a.vertex]).toEqual([1, -1]);
    const b = s.nearestEntry(s.node(0, 0), 100, Uint8Array.from([1, 1, 0]))!;
    expect(b.stroke).toBe(2);
    expect(b.lengthMm).toBeCloseTo(10, 6);
  });

  it("saltos maiores que a caneta só valem se a ligação ficar escondida", () => {
    const strokes = [stroke([[0, 0], [10, 0]]), stroke([[11, 0], [20, 0]])];
    const no = new InkSearch(buildInkGraph(strokes, { gapMm: 0.4, hiddenHopMm: 1.5, hidden: () => false }));
    expect(no.nearestEntry(no.node(0, 0), 100, Uint8Array.from([1, 0]))).toBeUndefined();
    const yes = new InkSearch(buildInkGraph(strokes, { gapMm: 0.4, hiddenHopMm: 1.5, hidden: () => true }));
    expect(yes.nearestEntry(yes.node(0, 0), 100, Uint8Array.from([1, 0]))?.stroke).toBe(1);
  });
});

describe("planJob: a caneta anda embaixo pela tinta em vez de subir", () => {
  // um "L" e um traço que sai do MEIO do lado de baixo do L: a ligação reta não fica escondida,
  // mas voltar por cima do L fica
  const L: [number, number][] = [[100, 100], [150, 100], [150, 140]];
  const T: [number, number][] = [[125, 100], [125, 60]];

  it("uma descida só, e o G-code passa na auditoria", () => {
    const plan = planJob(doc(L, T), P, JOB);
    expect(plan.descents).toHaveLength(1);
    expect(plan.stats.retraceMm).toBeGreaterThan(0);
    expect(audited(plan).ok).toBe(true);
  });

  it("o caminho a mais fica inteiro em cima das linhas do desenho", () => {
    const plan = planJob(doc(L, T), P, JOB);
    for (const s of plan.strokes) for (const p of s.points) expect(distToInk(p, [L, T])).toBeLessThan(1e-6);
  });

  it("desligado (0) ou com o caminho maior que o limite, a caneta sobe como antes", () => {
    expect(planJob(doc(L, T), withJoin({ retraceMm: 0 }), JOB).descents).toHaveLength(2);
    expect(planJob(doc(L, T), withJoin({ retraceMm: 10 }), JOB).descents).toHaveLength(2);
  });

  it("o comprimento a mais é só o do caminho pela tinta", () => {
    const plan = planJob(doc(L, T), P, JOB);
    const want = 50 + 40 + 40;
    const got = plan.strokes.reduce((a, s) => a + s.points.slice(1).reduce((b, p, i) => b + Math.hypot(p.x - s.points[i].x, p.y - s.points[i].y), 0), 0);
    expect(got).toBeCloseTo(want + plan.stats.retraceMm, 6);
  });
});

describe("planJob: casos de entrada pelo caminho", () => {
  it("entra num laço pelo MEIO: o traço sai do laço e a caneta continua dando a volta nele", () => {
    // o traço vem antes (é o mais perto da origem) e termina no MEIO do lado de baixo do quadrado; o caminho
    // segue o lado até o canto (100, 100), que é o 4º vértice do laço: o laço começa por ali
    const sq: [number, number][] = [[100, 140], [140, 140], [140, 100], [100, 100], [100, 140]];
    const tail: [number, number][] = [[90, 90], [110, 100]];
    const sqClosed = drawing("d", [sq, tail]);
    const d = { drawings: [{ ...sqClosed, geometry: { subpaths: sqClosed.geometry.subpaths.map((sp, i) => (i === 0 ? { ...sp, closed: true } : sp)) } }] };
    const plan = planJob(d, P, JOB);
    expect(plan.descents).toHaveLength(1);
    for (const s of plan.strokes) for (const p of s.points) expect(distToInk(p, [sq, tail])).toBeLessThan(1e-6);
    expect(audited(plan).ok).toBe(true);
  });

  it("vários caminhos seguidos (um pente): volta por cada dente e anda pela espinha até o próximo", () => {
    // espinha horizontal e três dentes de 5 mm que saem do meio dela, a cada 10 mm
    const spine: [number, number][] = [[100, 100], [140, 100]];
    const teeth: [number, number][][] = [[[110, 100], [110, 105]], [[120, 100], [120, 105]], [[130, 100], [130, 105]]];
    const plan = planJob(doc(spine, ...teeth), P, JOB);
    expect(plan.descents).toHaveLength(1);
    expect(plan.stats.retraceMm).toBeGreaterThan(0);
    for (const s of plan.strokes) for (const p of s.points) expect(distToInk(p, [spine, ...teeth])).toBeLessThan(1e-6);
    expect(audited(plan).ok).toBe(true);
  });
});

describe("planJob: emenda que pode aparecer (frestas entre linhas que quase se encostam)", () => {
  const gapOf = (g: number): [number, number][][] => [[[100, 100], [150, 100]], [[150 + g, 100], [200, 100]]];

  it("fresta de 0,5 mm na caneta de 0,4: com a tolerância padrão (0,3 mm), uma descida", () => {
    expect(planJob(doc(...gapOf(0.5)), P, JOB).descents).toHaveLength(1);
  });

  it("sem tolerância (0), a mesma fresta faz a caneta subir", () => {
    expect(planJob(doc(...gapOf(0.5)), withJoin({ visibleMm: 0 }), JOB).descents).toHaveLength(2);
  });

  it("fresta de 1 mm aparece demais: sobe", () => {
    expect(planJob(doc(...gapOf(1)), P, JOB).descents).toHaveLength(2);
  });

  it("o G-code com a emenda passa na auditoria", () => {
    expect(audited(planJob(doc(...gapOf(0.5)), P, JOB)).ok).toBe(true);
  });
});

describe("perfil salvo antes destas opções", () => {
  it("ganha os valores padrão do caminho pela tinta e da emenda que pode aparecer", () => {
    const old = mergeProfile({ join: { searchMm: 3, overInk: true } });
    expect(old.join.retraceMm).toBe(P.join.retraceMm);
    expect(old.join.visibleMm).toBe(P.join.visibleMm);
  });
});
