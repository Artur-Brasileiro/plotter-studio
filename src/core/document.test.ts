import { describe, expect, it } from "vitest";
import { sceneToMachineMatrix } from "./coords";
import {
  addDrawing,
  alignCenter,
  createDrawing,
  duplicateDrawings,
  EMPTY_DOCUMENT,
  expandToGroups,
  fitSelection,
  groupMembers,
  groupsOf,
  selectionMachineBBox,
  setSelectionBox,
  setSelectionRotation,
  tableItems,
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

describe("conjuntos: as camadas de uma mesma imagem andam juntas", () => {
  const T = importPlacement({ width: 10, height: 10 }, H);
  // um quadrado solto e uma imagem em duas camadas (preta e vermelha), com a mesma posição
  const doc: PlotDocument = [
    createDrawing("solto", "quadrado", square, T),
    createDrawing("p", "cartaz", square, T, undefined, "g1"),
    createDrawing("v", "cartaz", square, T, "vermelha", "g1"),
  ].reduce(addDrawing, EMPTY_DOCUMENT);

  it("createDrawing guarda o conjunto; sem conjunto, o campo nem existe", () => {
    expect(doc.drawings[1].group).toBe("g1");
    expect("group" in doc.drawings[0]).toBe(false);
  });

  it("groupMembers: quem está num conjunto traz os irmãos; quem está solto, só ele", () => {
    expect(groupMembers(doc, "p")).toEqual(["p", "v"]);
    expect(groupMembers(doc, "v")).toEqual(["p", "v"]);
    expect(groupMembers(doc, "solto")).toEqual(["solto"]);
    expect(groupMembers(doc, "nao-existe")).toEqual([]);
  });

  it("groupsOf: os itens da mesa, na ordem do documento, cada conjunto uma vez", () => {
    expect(groupsOf(doc)).toEqual([["solto"], ["p", "v"]]);
    expect(groupsOf(EMPTY_DOCUMENT)).toEqual([]);
  });

  it("duplicar um conjunto cria um conjunto NOVO: a cópia anda junta entre si, não com o original", () => {
    let n = 0;
    const r = duplicateDrawings(doc, ["p", "v"], () => `novo${++n}`, { x: 10, y: 0 }, H);
    const copies = r.doc.drawings.filter((d) => r.newIds.includes(d.id));
    expect(copies).toHaveLength(2);
    expect(copies[0].group).toBeDefined();
    expect(copies[0].group).toBe(copies[1].group);
    expect(copies[0].group).not.toBe("g1");
    expect(copies[1].penId).toBe("vermelha");
  });

  it("duplicar um desenho solto não inventa conjunto", () => {
    const r = duplicateDrawings(doc, ["solto"], () => "x", { x: 10, y: 0 }, H);
    expect("group" in r.doc.drawings.find((d) => d.id === "x")!).toBe(false);
  });
});

describe("mexer num conjunto como UM bloco (posição, tamanho, giro, encaixe)", () => {
  // duas camadas da mesma imagem, com a MESMA posição: um quadrado 10 × 10 e um risco que vai de x = 20 a x = 40
  const line: Geometry = { subpaths: [{ start: { x: 20, y: 5 }, segments: [{ kind: "line", to: { x: 40, y: 5 } }], closed: false }] };
  const T = importPlacement({ width: 40, height: 10 }, H);
  const set = (): PlotDocument =>
    [createDrawing("p", "cartaz", square, T, undefined, "g1"), createDrawing("v", "cartaz", line, T, "vermelha", "g1"), createDrawing("solto", "outro", square, T)].reduce(addDrawing, EMPTY_DOCUMENT);
  const ids = ["p", "v"];
  const box = (doc: PlotDocument, who: readonly string[] = ids) => selectionMachineBBox(doc, who, H, TOL);
  const same = (doc: PlotDocument) => expect(doc.drawings[0].transform).toEqual(doc.drawings[1].transform);

  it("expandToGroups: uma camada puxa o conjunto inteiro, sem repetir e na ordem do documento", () => {
    expect(expandToGroups(set(), ["v"])).toEqual(["p", "v"]);
    expect(expandToGroups(set(), ["solto", "v", "p"])).toEqual(["p", "v", "solto"]);
    expect(expandToGroups(set(), ["solto"])).toEqual(["solto"]);
    expect(expandToGroups(set(), ["nao-existe"])).toEqual([]);
  });

  it("a caixa do conjunto é a união das camadas: 40 × 10 mm", () => {
    expect(box(set())).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 10 });
  });

  it("posição: o canto do BLOCO vai para (100, 50) e as camadas continuam com a mesma posição entre si", () => {
    const doc = setSelectionBox(set(), ids, { x: 100, y: 50, keepRatio: true }, H, TOL);
    const b = box(doc);
    expect(b.minX).toBeCloseTo(100, 9);
    expect(b.minY).toBeCloseTo(50, 9);
    expect(box(doc, ["v"]).minX).toBeCloseTo(120, 9); // o risco continua 20 mm à direita do canto
    same(doc);
    expect(box(doc, ["solto"])).toEqual(box(set(), ["solto"])); // quem não está na seleção não mexe
  });

  it("largura 80 com proporção travada dobra o bloco inteiro a partir do canto dele", () => {
    const doc = setSelectionBox(set(), ids, { width: 80, keepRatio: true }, H, TOL);
    const b = box(doc);
    expect(b.maxX - b.minX).toBeCloseTo(80, 9);
    expect(b.maxY - b.minY).toBeCloseTo(20, 9);
    expect(b.minX).toBeCloseTo(0, 9);
    expect(box(doc, ["p"]).maxX).toBeCloseTo(20, 9); // o quadrado dobrou junto
    expect(box(doc, ["v"]).minX).toBeCloseTo(40, 9); // e o risco começa no dobro da distância
    same(doc);
  });

  it("sem travar a proporção, só a largura do bloco muda", () => {
    const b = box(setSelectionBox(set(), ids, { width: 20, keepRatio: false }, H, TOL));
    expect(b.maxX - b.minX).toBeCloseTo(20, 9);
    expect(b.maxY - b.minY).toBeCloseTo(10, 9);
  });

  it("giro: o bloco gira em torno do centro DELE (não cada camada em torno do próprio centro)", () => {
    const moved = setSelectionBox(set(), ids, { x: 100, y: 100, keepRatio: true }, H, TOL);
    const doc = setSelectionRotation(moved, ids, 90, H, TOL);
    const b = box(doc);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(120, 9);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(105, 9);
    expect(b.maxX - b.minX).toBeCloseTo(10, 6); // deitou: 40 × 10 virou 10 × 40
    expect(b.maxY - b.minY).toBeCloseTo(40, 6);
    expect(machineRotationDeg(doc.drawings[0].transform)).toBeCloseTo(90, 9);
    same(doc);
  });

  it("encaixe: o bloco ocupa o maior tamanho que cabe na caixa, com a folga, e fica no centro dela", () => {
    const sheet = { minX: 30, minY: 25, maxX: 570, maxY: 370 };
    const doc = fitSelection(set(), ids, sheet, 5, H, TOL);
    const b = box(doc);
    expect(b.maxX - b.minX).toBeCloseTo(530, 6); // 540 de largura menos 5 mm de cada lado
    expect((b.minX + b.maxX) / 2).toBeCloseTo(300, 6);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(197.5, 6);
    same(doc);
  });

  it("com um desenho só, o resultado é o mesmo das funções de um desenho", () => {
    const one = docWithSquare();
    expect(setSelectionBox(one, ["a"], { x: 12, y: 34, width: 25, keepRatio: true }, H, TOL)).toEqual(setMachineBox(one, "a", { x: 12, y: 34, width: 25, keepRatio: true }, H, TOL));
    expect(setSelectionBox(one, ["a"], { width: 30, height: 7, keepRatio: false }, H, TOL)).toEqual(setMachineBox(one, "a", { width: 30, height: 7, keepRatio: false }, H, TOL));
    const moved = translateMachine(one, ["a"], { x: 100, y: 100 });
    expect(setSelectionRotation(moved, ["a"], -37, H, TOL)).toEqual(setMachineRotation(moved, "a", -37, H, TOL));
  });

  it("nada para fazer devolve o MESMO documento (o histórico não ganha entrada vazia)", () => {
    const doc = set();
    expect(setSelectionBox(doc, [], { x: 1, keepRatio: true }, H, TOL)).toBe(doc);
    expect(setSelectionBox(doc, ["nao-existe"], { x: 1, keepRatio: true }, H, TOL)).toBe(doc);
    expect(setSelectionBox(doc, ids, { keepRatio: true }, H, TOL)).toBe(doc);
    expect(setSelectionRotation(doc, ids, 0, H, TOL)).toBe(doc);
    expect(setSelectionRotation(doc, [], 90, H, TOL)).toBe(doc);
  });

  it("nenhuma dessas operações espelha", () => {
    let doc = setSelectionBox(set(), ids, { width: 100, height: 7, keepRatio: false }, H, TOL);
    doc = setSelectionRotation(doc, ids, -37, H, TOL);
    doc = fitSelection(doc, ids, { minX: 0, minY: 0, maxX: 810, maxY: 385 }, 5, H, TOL);
    for (const d of doc.drawings) expect(determinant(d.transform)).toBeGreaterThan(0);
  });
});

describe("tableItems: o que a mesa mostra como um objeto só", () => {
  const T = importPlacement({ width: 10, height: 10 }, H);
  const base = (): PlotDocument =>
    [createDrawing("solto", "quadrado", square, T), createDrawing("p", "cartaz", square, T, undefined, "g1"), createDrawing("v", "cartaz", square, T, "vermelha", "g1")].reduce(addDrawing, EMPTY_DOCUMENT);

  it("um conjunto com todas as camadas na mesma posição é um item; o desenho solto é outro", () => {
    expect(tableItems(base())).toEqual([["solto"], ["p", "v"]]);
  });

  it("a mesma posição escrita em outra matriz (depois de desfazer, ou de abrir um projeto) continua valendo", () => {
    const doc = base();
    const copy = { drawings: doc.drawings.map((d) => ({ ...d, transform: [...d.transform] as unknown as typeof d.transform })) };
    expect(tableItems(copy)).toEqual([["solto"], ["p", "v"]]);
  });

  it("se uma camada estiver em outra posição, o conjunto não é mais um bloco: cada camada é um item", () => {
    const moved = translateMachine(base(), ["v"], { x: 5, y: 0 });
    expect(tableItems(moved)).toEqual([["solto"], ["p"], ["v"]]);
  });

  it("mesa vazia não tem itens", () => {
    expect(tableItems(EMPTY_DOCUMENT)).toEqual([]);
  });
});
