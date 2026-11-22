import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../machine";
import { docFrom, quadradoCirculoSvg } from "../testing/samples";
import { checkBounds } from "./bounds";
import { keepOrder, orderStrokes, travelLength } from "./optimize";
import { documentToStrokes } from "./strokes";
import type { Stroke } from "./types";

const P = (x: number, y: number) => ({ x, y });
const open = (id: string, ...pts: [number, number][]): Stroke => ({ points: pts.map(([x, y]) => P(x, y)), closed: false, drawingId: id });
// estes testes medem a geometria com a pagina na origem da maquina (o aplicativo usa o canto da zona)
const ORIGIN = { x: 0, y: 0 };
const OPTS = { start: P(0, 0), joinGapMm: 0.1, allowReverse: true, rotateClosed: true };

describe("documentToStrokes", () => {
  it("o quadrado do teste_quadrado_circulo em (0,0) sai com os vértices certos na máquina", () => {
    const [sq, circle] = documentToStrokes(docFrom(quadradoCirculoSvg, "sample.svg", 385, ORIGIN), DEFAULT_PROFILE);
    expect(sq.points).toEqual([P(10, 110), P(110, 110), P(110, 10), P(10, 10), P(10, 110)]);
    expect(sq.closed).toBe(true);
    expect(circle.points).toHaveLength(57);
    expect(circle.points[0]).toEqual(P(90, 60));
    expect(circle.points[1].y).toBeLessThan(60); // desce na tela, como no SVG
  });
});

describe("checkBounds", () => {
  const area = { width: 810, height: 385 };
  it("folga de 0,005 mm para o arredondamento", () => {
    expect(checkBounds([open("a", [-0.004, 0], [810.004, 385])], area)).toEqual([]);
  });
  it("fora da área: uma violação por desenho, dizendo quanto sai", () => {
    const v = checkBounds([open("a", [-0.1, 10], [20, 10]), open("a", [5, 386], [6, 7]), open("b", [1, 1], [2, 2])], area);
    expect(v).toHaveLength(1);
    expect(v[0].drawingId).toBe("a");
    expect(v[0].message).toBe("sai 0,1 mm à esquerda, 1,0 mm no fundo");
  });
});

describe("orderStrokes", () => {
  it("três traços na mesma reta: A, B invertido, C; 20 mm de viagem", () => {
    const strokes = [open("A", [0, 0], [10, 0]), open("C", [40, 0], [50, 0]), open("B", [30, 0], [20, 0])];
    const o = orderStrokes(strokes, OPTS);
    expect(o.map((s) => s.drawingId)).toEqual(["A", "B", "C"]);
    expect(o[1].points).toEqual([P(20, 0), P(30, 0)]);
    expect(travelLength(o, P(0, 0))).toBeCloseTo(20, 9);
  });

  it("junção de pontas: 0,05 mm de distância → sem levantar a caneta", () => {
    const o = orderStrokes([open("a", [0, 0], [10, 0]), open("b", [10.05, 0], [20, 0])], OPTS);
    expect(o.map((s) => s.joinedToPrevious)).toEqual([false, true]);
    expect(keepOrder([open("a", [0, 0], [10, 0]), open("b", [10.05, 0], [20, 0])], 0.1)[1].joinedToPrevious).toBe(true);
  });

  it("o laço do quadrado é girado para começar em (10,10) saindo de (0,0)", () => {
    const strokes = documentToStrokes(docFrom(quadradoCirculoSvg, "sample.svg", 385, ORIGIN), DEFAULT_PROFILE);
    const [first] = orderStrokes(strokes, OPTS);
    expect(first.points[0]).toEqual(P(10, 10));
    expect(first.points[first.points.length - 1]).toEqual(P(10, 10));
    expect(first.points).toHaveLength(5);
  });

  it("teste_quadrado_circulo: viagem cai de 312,96 mm (ordem do arquivo) para 109,71 mm", () => {
    const strokes = documentToStrokes(docFrom(quadradoCirculoSvg, "sample.svg", 385, ORIGIN), DEFAULT_PROFILE);
    const home = P(0, 0);
    expect(travelLength(keepOrder(strokes, 0.1), home, home)).toBeCloseTo(312.96, 1);
    const o = orderStrokes(strokes, OPTS);
    expect(o[1].points[0].x).toBeCloseTo(38.787, 2);
    expect(travelLength(o, home, home)).toBeCloseTo(109.71, 1);
  });

  it("é determinístico", () => {
    const strokes = Array.from({ length: 300 }, (_, i) => open(`s${i}`, [(i * 37) % 800, (i * 53) % 380], [((i * 37) % 800) + 3, ((i * 53) % 380) + 2]));
    expect(orderStrokes(strokes, OPTS)).toEqual(orderStrokes(strokes, OPTS));
  });

  it("20 mil traços em menos de 1 s, sem perder nenhum", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const strokes = Array.from({ length: 20_000 }, (_, i) => {
      const x = rnd() * 800, y = rnd() * 380;
      return open(`s${i}`, [x, y], [x + rnd() * 5, y + rnd() * 5]);
    });
    const t0 = performance.now();
    const o = orderStrokes(strokes, OPTS);
    const ms = performance.now() - t0;
    expect(o).toHaveLength(20_000);
    expect(new Set(o.map((s) => s.drawingId)).size).toBe(20_000);
    expect(ms).toBeLessThan(1000);
    // e economiza muito em relação à ordem aleatória
    expect(travelLength(o, P(0, 0))).toBeLessThan(travelLength(strokes, P(0, 0)) / 10);
  });

  it("ponto (traço de 1 vértice) entra normalmente", () => {
    const o = orderStrokes([{ points: [P(5, 5)], closed: false, drawingId: "p" }], OPTS);
    expect(o[0].points).toEqual([P(5, 5)]);
  });
});
