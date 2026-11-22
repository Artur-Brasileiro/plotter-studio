import { describe, expect, it } from "vitest";
import type { Vec } from "../geometry/vec";
import { DEFAULT_PROFILE, type MachineProfile } from "../machine";
import { bridgeIsHidden, buildInkMap, isInked, strokeCovered } from "./inkmap";
import { capDescents, orderStrokes } from "./optimize";
import { groupDescents, scheduleJob } from "./schedule";
import { stroke } from "./testPlan";
import type { OrderedStroke, Stroke } from "./types";

const P = DEFAULT_PROFILE;
const V = (x: number, y: number): Vec => ({ x, y });
const line = (...pts: [number, number][]): Stroke => ({ points: pts.map(([x, y]) => V(x, y)), closed: false, drawingId: "d" });
const len = (s: { points: readonly Vec[] }) => s.points.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - s.points[i].x, p.y - s.points[i].y), 0);

describe("mapa de tinta", () => {
  const strokes = [line([10, 10], [30, 10]), line([20, 10], [21, 10]), line([10, 20], [30, 20])];
  const ink = buildInkMap(strokes, 0.4)!;

  it("há tinta sobre o traço e perto dele, e nunca além de meia largura da caneta", () => {
    expect(isInked(ink, V(15, 10))).toBe(true);
    expect(isInked(ink, V(15, 10.1))).toBe(true);
    // o mapa é conservador: na dúvida (a célula não cabe inteira no risco), diz que é papel
    expect(isInked(ink, V(15, 10.21))).toBe(false);
    expect(isInked(ink, V(15, 10.5))).toBe(false);
    expect(isInked(ink, V(15, 15))).toBe(false);
  });

  it("o mapa nunca vê tinta onde há papel: nenhuma célula marcada fica a mais de meia caneta de um traço", () => {
    for (let k = 0; k < 400; k++) {
      const p = V(9.5 + (k % 20) * 0.031, 9.6 + Math.floor(k / 20) * 0.041);
      const d = p.x < 10 ? Math.hypot(p.x - 10, p.y - 10) : Math.abs(p.y - 10);
      if (isInked(ink, p)) expect(d).toBeLessThanOrEqual(0.2 + 1e-9);
      if (d < 0.09) expect(isInked(ink, p)).toBe(true);
    }
  });

  it("tracinho em cima de outro traço está coberto; traço sozinho não", () => {
    // o mapa de quem FICA não tem o próprio tracinho
    const others = buildInkMap([strokes[0], strokes[2]], 0.4)!;
    expect(strokeCovered(others, strokes[1].points)).toBe(true);
    expect(strokeCovered(buildInkMap([strokes[1], strokes[2]], 0.4)!, strokes[0].points)).toBe(false);
    expect(strokeCovered(buildInkMap([strokes[0], strokes[1]], 0.4)!, strokes[2].points)).toBe(false);
  });

  it("coberto é o risco inteiro: tracinho com metade da largura para fora engrossa a linha, não está escondido", () => {
    const others = buildInkMap([strokes[0], strokes[2]], 0.4)!;
    expect(strokeCovered(others, line([20, 10.2], [21, 10.2]).points)).toBe(false);
    // passando da ponta do traço também não
    expect(strokeCovered(others, line([29.5, 10], [30.3, 10]).points)).toBe(false);
    // um ponto solto em cima da linha está coberto; ao lado dela, não
    expect(strokeCovered(others, [V(20, 10)])).toBe(true);
    expect(strokeCovered(others, [V(20, 10.25)])).toBe(false);
  });

  it("ligação por cima de um traço fica escondida; atravessando papel em branco, não", () => {
    expect(bridgeIsHidden(ink, V(12, 10), V(18, 10), 0.4)).toBe(true);
    expect(bridgeIsHidden(ink, V(15, 10), V(15, 20), 0.4)).toBe(false);
    // rente à borda da tinta não vale: metade da largura da ligação cairia no branco
    expect(bridgeIsHidden(ink, V(12, 10.19), V(18, 10.19), 0.4)).toBe(false);
  });

  it("devolve undefined quando a grade ficaria grossa demais para confiar", () => {
    expect(buildInkMap([line([0, 0], [800, 380])], 0.4, 1000)).toBeUndefined();
    expect(buildInkMap([], 0.4)).toBeUndefined();
  });
});

describe("ordem com emendas (regras 1 e 2)", () => {
  const base = { start: V(0, 0), joinGapMm: 0.4, allowReverse: true, rotateClosed: true };

  it("salto menor que a largura da caneta: emenda", () => {
    const out = orderStrokes([line([10, 10], [20, 10]), line([20.3, 10], [30, 10])], base);
    expect(out.map((s) => s.joinedToPrevious)).toEqual([false, true]);
  });

  it("salto maior que a caneta, sobre papel em branco: levanta", () => {
    const out = orderStrokes([line([10, 10], [20, 10]), line([21, 10], [30, 10])], base);
    expect(out.map((s) => s.joinedToPrevious)).toEqual([false, false]);
  });

  it("prefere o traço que dá para emendar ao que está mais perto (até 3 mm)", () => {
    // do fim de A (20,10): B começa a 1 mm em branco; C começa a 2 mm, mas a ligação corre sobre D
    const A = line([10, 10], [20, 10]);
    const B = line([20, 11], [20, 15]);
    const C = line([22, 10], [22, 5]);
    const D = line([19, 10], [23, 10]); // tinta por baixo da ligação A→C
    const strokes = [A, B, C, D];
    const ink = buildInkMap(strokes, 0.4)!;
    const out = orderStrokes(strokes, { ...base, searchMm: 3, bridgeHidden: (a, b) => bridgeIsHidden(ink, a, b, 0.4) });
    expect(out[0].points[0]).toEqual(V(10, 10));
    // depois de A vem um traço emendado (C pela ponte, ou D que toca A), nunca o B com a caneta no ar
    expect(out[1].joinedToPrevious).toBe(true);
    expect(out[1].points).not.toEqual(B.points);
  });

  it("sem mapa de tinta, só vale o salto pequeno (não inventa ponte)", () => {
    const out = orderStrokes([line([10, 10], [20, 10]), line([22, 10], [30, 10])], { ...base, searchMm: 3 });
    expect(out[1].joinedToPrevious).toBe(false);
  });
});

describe("corte de descida longa (regra 5)", () => {
  const o = (s: Stroke, joined = false): OrderedStroke => ({ ...s, joinedToPrevious: joined });

  it("traço mais curto que o limite sai igual", () => {
    const out = capDescents([o(line([0, 0], [100, 0]))], 900);
    expect(out).toHaveLength(1);
    expect(out[0].relift).toBeUndefined();
  });

  it("traço longo é cortado no ponto exato do limite, no meio do segmento se preciso", () => {
    const out = capDescents([o(line([0, 0], [1000, 0], [1000, 500]))], 900);
    expect(out.map((s) => s.relift)).toEqual([undefined, true]);
    expect(out[0].points[out[0].points.length - 1]).toEqual(V(900, 0));
    expect(out[1].points[0]).toEqual(V(900, 0));
    expect(out[1].joinedToPrevious).toBe(true);
    expect(len(out[0])).toBeCloseTo(900, 9);
    expect(len(out[0]) + len(out[1])).toBeCloseTo(1500, 9);
  });

  it("cadeia de traços emendados conta junta, e o comprimento total não muda", () => {
    const chain = [o(line([0, 0], [400, 0])), o(line([400.2, 0], [800, 0]), true), o(line([800.2, 0], [1200, 0]), true)];
    const out = capDescents(chain, 900);
    const groups = groupDescents(out.map((s) => stroke(s.points.map((p) => [p.x, p.y] as [number, number]), { joined: s.joinedToPrevious, relift: s.relift })));
    expect(groups.length).toBe(2);
    expect(out.reduce((a, s) => a + len(s), 0)).toBeCloseTo(400 + 399.8 + 399.8, 6);
    for (const s of out) expect(len(s)).toBeLessThanOrEqual(900 + 1e-6);
  });

  it("traço fechado cortado deixa de ser fechado (as partes são abertas)", () => {
    const sq: OrderedStroke = { points: [V(0, 0), V(400, 0), V(400, 300), V(0, 300), V(0, 0)], closed: true, drawingId: "d", joinedToPrevious: false };
    const out = capDescents([sq], 900);
    expect(out.length).toBe(2);
    expect(out.every((s) => !s.closed)).toBe(true);
    expect(capDescents([sq], 2000)[0].closed).toBe(true);
  });
});

describe("agenda: balde de fichas do servo (regra 3)", () => {
  const dots = (n: number) => Array.from({ length: n }, (_, i) => stroke([[100 + (i % 50), 100 + Math.floor(i / 50)]]));
  const cyclesIn60 = (times: number[]) => {
    let peak = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[i] - times[j] >= 60) j++;
      peak = Math.max(peak, i - j + 1);
    }
    return peak;
  };

  it("garante o pico em qualquer janela de 60 s e a média do trabalho inteiro", () => {
    const s = scheduleJob(dots(500), V(0, 0), V(0, 0), P);
    const times = s.descents.map((d) => d.tDownS);
    expect(cyclesIn60(times)).toBeLessThanOrEqual(P.servo.peakPer60s);
    expect(s.descents.length / (s.estimate.totalS / 60)).toBeLessThanOrEqual(P.servo.avgPerMin + 0.5);
    expect(s.estimate.waitS).toBeGreaterThan(0);
    expect(s.overloads).toBeGreaterThan(0);
  });

  it("folga acumulada em traços longos permite uma rajada, sem passar do pico", () => {
    // 5 traços de ~96 s cada (800 mm a F500), depois 100 pontos
    const long = Array.from({ length: 5 }, (_, i) => stroke([[100, 100 + i], [500, 100 + i], [100, 100.5 + i]]));
    const s = scheduleJob([...long, ...dots(100)], V(0, 0), V(0, 0), P);
    const burst = s.descents.slice(5);
    // os primeiros pontos da rajada não esperam
    expect(burst.slice(0, 10).every((d) => d.waitS === 0)).toBe(true);
    expect(cyclesIn60(s.descents.map((d) => d.tDownS))).toBeLessThanOrEqual(P.servo.peakPer60s);
  });

  it("modo avisar não espera, mas conta os estouros; limites mais altos esperam menos", () => {
    const warn: MachineProfile = { ...P, servo: { ...P.servo, onOverload: "warn" } };
    const w = scheduleJob(dots(300), V(0, 0), V(0, 0), warn);
    expect(w.estimate.waitS).toBe(0);
    expect(w.overloads).toBeGreaterThan(0);
    const loose: MachineProfile = { ...P, servo: { ...P.servo, avgPerMin: 60, peakPer60s: 90 } };
    expect(scheduleJob(dots(300), V(0, 0), V(0, 0), loose).estimate.waitS).toBeLessThan(scheduleJob(dots(300), V(0, 0), V(0, 0), P).estimate.waitS);
  });

  it("o tempo total fecha: desenho + deslocamento + pausas + descanso", () => {
    const e = scheduleJob(dots(120), V(0, 0), V(0, 0), P).estimate;
    expect(e.totalS).toBeCloseTo(e.drawS + e.travelS + e.penS + e.waitS, 6);
  });
});
