import { describe, expect, it } from "vitest";
import { addDrawing, createDrawing, EMPTY_DOCUMENT, type PlotDocument } from "./document";
import { scaling, translation, type Mat2D } from "./geometry/mat2d";
import { ellipseSubPath, type Geometry, type SubPath } from "./geometry/path";
import { polylineLength, removeStrokes, removeSubpaths, sceneStrokes, StrokeIndex } from "./strokeEdit";

const line = (x0: number, y0: number, x1: number, y1: number): SubPath => ({ start: { x: x0, y: y0 }, segments: [{ kind: "line", to: { x: x1, y: y1 } }], closed: false });

/** Três traços horizontais de 10 mm, em y = 0, 5 e 10. */
const three: Geometry = { subpaths: [line(0, 0, 10, 0), line(0, 5, 10, 5), line(0, 10, 10, 10)] };

function docWith(geometry: Geometry, transform: Mat2D = translation(100, 50), penId?: string): PlotDocument {
  return addDrawing(EMPTY_DOCUMENT, createDrawing("d1", "desenho", geometry, transform, penId));
}

describe("removeSubpaths: apagar traços de um desenho", () => {
  it("tira só os traços indicados e mantém a ordem dos outros", () => {
    const doc = removeSubpaths(docWith(three), "d1", [1]);
    expect(doc.drawings[0].geometry.subpaths).toEqual([three.subpaths[0], three.subpaths[2]]);
  });

  it("o desenho continua o mesmo: id, nome, posição e caneta", () => {
    const m = translation(40, 60);
    const before = docWith(three, m, "verde");
    const d = removeSubpaths(before, "d1", [0]).drawings[0];
    expect(d.id).toBe("d1");
    expect(d.name).toBe("desenho");
    expect(d.transform).toBe(m);
    expect(d.penId).toBe("verde");
  });

  it("a caixa do desenho é refeita para o que sobrou", () => {
    const d = removeSubpaths(docWith(three), "d1", [2]).drawings[0];
    expect(d.localBBox).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 5 });
  });

  it("não mexe no documento de antes (o Ctrl+Z da mesa depende disso)", () => {
    const before = docWith(three);
    const geometry = before.drawings[0].geometry;
    removeSubpaths(before, "d1", [0, 1]);
    expect(before.drawings[0].geometry).toBe(geometry);
    expect(geometry.subpaths).toHaveLength(3);
  });

  it("sem nada para tirar, devolve o MESMO documento (não cria entrada no histórico)", () => {
    const doc = docWith(three);
    expect(removeSubpaths(doc, "d1", [])).toBe(doc);
    expect(removeSubpaths(doc, "d1", [7, -1])).toBe(doc);
    expect(removeSubpaths(doc, "outro", [0])).toBe(doc);
  });

  it("índice repetido conta uma vez só", () => {
    const doc = removeSubpaths(docWith(three), "d1", [1, 1, 1]);
    expect(doc.drawings[0].geometry.subpaths).toHaveLength(2);
  });

  it("desenho que fica sem traço nenhum sai da mesa", () => {
    expect(removeSubpaths(docWith(three), "d1", [0, 1, 2]).drawings).toHaveLength(0);
  });

  it("sobrou só um subcaminho vazio (um ponto de partida sem traço): o desenho também sai", () => {
    const withEmpty: Geometry = { subpaths: [line(0, 0, 10, 0), { start: { x: 3, y: 3 }, segments: [], closed: false }] };
    expect(removeSubpaths(docWith(withEmpty), "d1", [0]).drawings).toHaveLength(0);
  });

  it("os outros desenhos da mesa ficam intocados", () => {
    const other = createDrawing("d2", "outro", three, translation(0, 0));
    const doc = addDrawing(docWith(three), other);
    const after = removeSubpaths(doc, "d1", [0]);
    expect(after.drawings[1]).toBe(other);
  });
});

describe("removeStrokes: vários desenhos de uma vez (as camadas de cor ficam uma em cima da outra)", () => {
  it("tira de cada desenho os traços dele, num documento só", () => {
    const doc = addDrawing(docWith(three), createDrawing("d2", "vermelho", three, translation(0, 0)));
    const after = removeStrokes(doc, new Map([["d1", [0]], ["d2", [1, 2]]]));
    expect(after.drawings.map((d) => d.geometry.subpaths.length)).toEqual([2, 1]);
  });

  it("um desenho esvaziado sai, os outros ficam", () => {
    const doc = addDrawing(docWith(three), createDrawing("d2", "vermelho", three, translation(0, 0)));
    const after = removeStrokes(doc, new Map([["d2", [0, 1, 2]]]));
    expect(after.drawings.map((d) => d.id)).toEqual(["d1"]);
  });

  it("sem nada para tirar, devolve o mesmo documento", () => {
    const doc = docWith(three);
    expect(removeStrokes(doc, new Map())).toBe(doc);
    expect(removeStrokes(doc, new Map([["d1", []]]))).toBe(doc);
  });
});

describe("polylineLength", () => {
  it("soma os trechos de uma polilinha (x0, y0, x1, y1, ...)", () => {
    expect(polylineLength([0, 0, 3, 4, 3, 14])).toBeCloseTo(15, 9);
    expect(polylineLength([5, 5])).toBe(0);
    expect(polylineLength([])).toBe(0);
  });
});

describe("sceneStrokes: os traços de um desenho como estão na mesa (mm)", () => {
  it("aplica a posição e o tamanho do desenho", () => {
    const d = createDrawing("d1", "x", three, [2, 0, 0, 2, 100, 50]);
    const s = sceneStrokes(d);
    expect(s).toHaveLength(3);
    expect(Array.from(s[1].points)).toEqual([100, 60, 120, 60]);
    expect(s[1].lengthMm).toBeCloseTo(20, 9);
  });

  it("cada traço sabe de que desenho e de que subcaminho veio, mesmo pulando os vazios", () => {
    const g: Geometry = { subpaths: [line(0, 0, 10, 0), { start: { x: 1, y: 1 }, segments: [], closed: false }, line(0, 5, 10, 5)] };
    const s = sceneStrokes(createDrawing("abc", "x", g, translation(0, 0)));
    expect(s.map((k) => [k.drawingId, k.subpath])).toEqual([["abc", 0], ["abc", 2]]);
  });

  it("curva vira polilinha fiel: um círculo de raio 10 mede 2·π·10 e fecha no ponto de partida", () => {
    const d = createDrawing("d1", "x", { subpaths: [ellipseSubPath(50, 50, 10, 10)] }, scaling(1));
    const [s] = sceneStrokes(d, 0.01);
    expect(s.lengthMm).toBeCloseTo(2 * Math.PI * 10, 1);
    expect(s.points[0]).toBe(s.points[s.points.length - 2]);
    expect(s.points[1]).toBe(s.points[s.points.length - 1]);
    for (let i = 0; i < s.points.length; i += 2) expect(Math.hypot(s.points[i] - 50, s.points[i + 1] - 50)).toBeCloseTo(10, 1);
  });
});

describe("StrokeIndex: achar o traço embaixo do mouse", () => {
  const strokes = [
    [0, 0, 100, 0], // 0: horizontal comprido
    [0, 10, 100, 10], // 1: outro, 10 mm abaixo
    [50, 20, 50, 60], // 2: vertical
    [200, 200, 200.01, 200], // 3: um pontinho
  ];
  const index = new StrokeIndex(strokes);

  it("devolve o traço que está embaixo do ponto", () => {
    expect(index.nearest(30, 0.4, 2)).toBe(0);
    expect(index.nearest(50.5, 40, 2)).toBe(2);
  });

  it("mede até o TRECHO, não só até as pontas: o meio de uma reta comprida também vale", () => {
    expect(index.nearest(50, 1, 1.5)).toBe(0);
  });

  it("entre dois traços, fica com o mais perto", () => {
    expect(index.nearest(30, 4, 8)).toBe(0);
    expect(index.nearest(30, 6, 8)).toBe(1);
  });

  it("longe de tudo: nenhum (−1)", () => {
    expect(index.nearest(30, 5, 2)).toBe(-1);
    expect(index.nearest(500, 500, 3)).toBe(-1);
  });

  it("acha um pontinho", () => {
    expect(index.nearest(200.5, 200.5, 1)).toBe(3);
  });

  it("traço já apagado é ignorado", () => {
    const skip = new Uint8Array(strokes.length);
    skip[0] = 1;
    expect(index.nearest(30, 4, 8, skip)).toBe(1);
    expect(index.nearest(30, 0, 2, skip)).toBe(-1);
  });

  it("índice vazio não acha nada e não quebra", () => {
    const empty = new StrokeIndex([]);
    expect(empty.nearest(0, 0, 10)).toBe(-1);
    expect(empty.inRect(-5, -5, 5, 5)).toEqual([]);
  });

  it("retângulo: entram os traços que têm um pedaço dentro dele", () => {
    expect(index.inRect(40, 15, 60, 30)).toEqual([2]);
    expect(index.inRect(-5, -5, 5, 15)).toEqual([0, 1]);
  });

  it("retângulo: uma reta que só ATRAVESSA (sem ponta dentro) também entra", () => {
    expect(index.inRect(40, -5, 60, 5)).toEqual([0]);
  });

  it("retângulo vazio de traços, e retângulo arrastado da direita para a esquerda", () => {
    expect(index.inRect(110, 110, 150, 150)).toEqual([]);
    expect(index.inRect(60, 30, 40, 15)).toEqual([2]);
  });

  it("retângulo ignora o que já foi apagado", () => {
    const skip = new Uint8Array(strokes.length);
    skip[1] = 1;
    expect(index.inRect(-5, -5, 5, 15, skip)).toEqual([0]);
  });

  it("diagonal comprida: achada pelo meio, e só entra no retângulo que ela cruza", () => {
    const diag = new StrokeIndex([[0, 0, 300, 300]]);
    expect(diag.nearest(150.5, 149.5, 2)).toBe(0);
    expect(diag.nearest(150, 140, 2)).toBe(-1);
    expect(diag.inRect(100, 90, 120, 110)).toEqual([0]);
    expect(diag.inRect(100, 10, 120, 30)).toEqual([]);
  });

  it("20 mil traços: mesma resposta da busca um por um", () => {
    // gerador fixo (o teste é sempre igual)
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const many: number[][] = [];
    for (let i = 0; i < 20000; i++) {
      const x = rnd() * 500, y = rnd() * 330;
      const pts = [x, y];
      const n = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) pts.push(pts[pts.length - 2] + (rnd() - 0.5) * 12, pts[pts.length - 1] + (rnd() - 0.5) * 12);
      many.push(pts);
    }
    const big = new StrokeIndex(many);
    const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      return Math.hypot(px - ax - t * dx, py - ay - t * dy);
    };
    for (let q = 0; q < 300; q++) {
      const px = rnd() * 500, py = rnd() * 330;
      let best = -1, bestD = 1.5;
      many.forEach((p, i) => {
        for (let k = 0; k + 3 < p.length; k += 2) {
          const d = segDist(px, py, p[k], p[k + 1], p[k + 2], p[k + 3]);
          if (d < bestD) (bestD = d), (best = i);
        }
      });
      expect(big.nearest(px, py, 1.5)).toBe(best);
    }
  });
});
