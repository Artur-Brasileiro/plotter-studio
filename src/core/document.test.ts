import { describe, expect, it } from "vitest";
import { sceneToMachineMatrix } from "./coords";
import {
  addDrawing,
  alignCenter,
  createDrawing,
  duplicateDrawings,
  EMPTY_DOCUMENT,
  importPlacement,
  machineBBox,
  removeDrawings,
  setMachineBox,
  setMachineRotation,
  translateMachine,
  type PlotDocument,
} from "./document";
import { flattenGeometry } from "./geometry/flatten";
import { determinant, multiply } from "./geometry/mat2d";
import type { Geometry } from "./geometry/path";
import { machineRotationDeg } from "./coords";
import { importSvgTree } from "./svg/importSvg";
import { el } from "./svg/node";

const H = 385;
const TOL = 0.05;

/** Quadrado 10 × 10 mm com o canto em (0,0) local */
const square: Geometry = {
  subpaths: [
    {
      start: { x: 0, y: 0 },
      segments: [
        { kind: "line", to: { x: 10, y: 0 } },
        { kind: "line", to: { x: 10, y: 10 } },
        { kind: "line", to: { x: 0, y: 10 } },
        { kind: "line", to: { x: 0, y: 0 } },
      ],
      closed: true,
    },
  ],
};

const docWithSquare = (): PlotDocument =>
  addDrawing(EMPTY_DOCUMENT, createDrawing("a", "quadrado", square, importPlacement({ width: 10, height: 10 }, H)));

const bb = (doc: PlotDocument, id = "a") => machineBBox(doc.drawings.find((d) => d.id === id)!, H, TOL);

describe("documento", () => {
  it("importPlacement de uma página 120 × 120 = T(0, 265)", () => {
    expect(importPlacement({ width: 120, height: 120 }, H)).toEqual([1, 0, 0, 1, 0, 265]);
  });

  it("o quadrado importado fica com o canto inferior esquerdo em (0,0) da máquina", () => {
    expect(bb(docWithSquare())).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  it("duplicateDrawings com offset (10, −10) na máquina", () => {
    let n = 0;
    const r = duplicateDrawings(docWithSquare(), ["a"], () => `copia${++n}`, { x: 10, y: -10 }, H);
    expect(r.newIds).toEqual(["copia1"]);
    expect(bb(r.doc, "copia1")).toEqual({ minX: 10, minY: -10, maxX: 20, maxY: 0 });
  });

  it("translateMachine: +Y na máquina = para longe do operador", () => {
    const doc = translateMachine(docWithSquare(), ["a"], { x: 0, y: 5 });
    expect(bb(doc)).toEqual({ minX: 0, minY: 5, maxX: 10, maxY: 15 });
    expect(doc.drawings[0].transform[5]).toBe(H - 10 - 5); // na cena, −Y
  });

  it("setMachineBox: x = 100, y = 50 leva o canto inferior esquerdo da caixa para (100, 50)", () => {
    const doc = setMachineBox(docWithSquare(), "a", { x: 100, y: 50, keepRatio: true }, H, TOL);
    const b = bb(doc);
    expect(b.minX).toBeCloseTo(100, 9);
    expect(b.minY).toBeCloseTo(50, 9);
  });

  it("setMachineBox: largura 20 com proporção travada dobra também a altura, mantendo o canto", () => {
    const doc = setMachineBox(docWithSquare(), "a", { width: 20, keepRatio: true }, H, TOL);
    const b = bb(doc);
    expect(b.maxX - b.minX).toBeCloseTo(20, 9);
    expect(b.maxY - b.minY).toBeCloseTo(20, 9);
    expect(b.minX).toBeCloseTo(0, 9);
    expect(b.minY).toBeCloseTo(0, 9);
  });

  it("setMachineBox: sem travar, só a largura muda", () => {
    const doc = setMachineBox(docWithSquare(), "a", { width: 30, keepRatio: false }, H, TOL);
    const b = bb(doc);
    expect(b.maxX - b.minX).toBeCloseTo(30, 9);
    expect(b.maxY - b.minY).toBeCloseTo(10, 9);
  });

  it("setMachineRotation(90) gira em torno do centro da caixa e o ângulo lido é 90", () => {
    const moved = translateMachine(docWithSquare(), ["a"], { x: 100, y: 100 });
    const doc = setMachineRotation(moved, "a", 90, H, TOL);
    const b = bb(doc);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(105, 9);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(105, 9);
    expect(machineRotationDeg(doc.drawings[0].transform)).toBeCloseTo(90, 9);
  });

  it("alignCenter no A4 centraliza a caixa", () => {
    const a4 = { minX: 0, minY: 0, maxX: 297, maxY: 210 };
    const b = bb(alignCenter(docWithSquare(), ["a"], a4, H, TOL));
    expect((b.minX + b.maxX) / 2).toBeCloseTo(148.5, 9);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(105, 9);
  });

  it("nenhuma operação espelha (determinante continua positivo)", () => {
    let doc = docWithSquare();
    doc = translateMachine(doc, ["a"], { x: 3, y: 4 });
    doc = setMachineBox(doc, "a", { width: 50, height: 7, keepRatio: false }, H, TOL);
    doc = setMachineRotation(doc, "a", -37, H, TOL);
    doc = alignCenter(doc, ["a"], { minX: 0, minY: 0, maxX: 810, maxY: 385 }, H, TOL);
    doc = duplicateDrawings(doc, ["a"], () => "b", { x: 10, y: -10 }, H).doc;
    for (const d of doc.drawings) expect(determinant(d.transform)).toBeGreaterThan(0);
  });

  it("removeDrawings e operações sem efeito devolvem o mesmo documento", () => {
    const doc = docWithSquare();
    expect(removeDrawings(doc, [])).toBe(doc);
    expect(removeDrawings(doc, ["x"])).toBe(doc);
    expect(translateMachine(doc, ["a"], { x: 0, y: 0 })).toBe(doc);
    expect(removeDrawings(doc, ["a"]).drawings).toHaveLength(0);
  });
});

describe("orientação (orientacao.svg montado à mão, sem DOM)", () => {
  it("o 'F' sai legível na máquina: barra de cima acima da do meio, as duas para +X, haste subindo", () => {
    const svg = el("svg", { width: "100mm", height: "80mm", viewBox: "0 0 100 80" }, [
      el("g", { fill: "none", stroke: "black" }, [
        el("path", { d: "M10 70 L10 10 L40 10 M10 38 L32 38" }),
        el("path", { d: "M55 70 L90 25 M90 25 L72 27 M90 25 L87 43" }),
      ]),
    ]);
    const r = importSvgTree(svg);
    const d = createDrawing("o", "orientacao", r.geometry, importPlacement(r.pageMm, H));
    const pls = flattenGeometry(d.geometry, multiply(sceneToMachineMatrix(H), d.transform), TOL);
    const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
    expect(pls[0].points.map(round)).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 70 },
      { x: 40, y: 70 },
    ]);
    expect(pls[1].points.map(round)).toEqual([
      { x: 10, y: 42 },
      { x: 32, y: 42 },
    ]);
    expect(pls[2].points.map(round)).toEqual([
      { x: 55, y: 10 },
      { x: 90, y: 55 },
    ]);
  });
});
