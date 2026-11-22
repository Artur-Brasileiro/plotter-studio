import { describe, expect, it } from "vitest";
import { addDrawing, createDrawing, EMPTY_DOCUMENT } from "./document";
import { ellipseSubPath } from "./geometry/path";
import { deserializeDocument, serializeDocument } from "./project";

const doc = addDrawing(
  EMPTY_DOCUMENT,
  createDrawing(
    "id1",
    "círculo e reta",
    {
      subpaths: [
        ellipseSubPath(60, 60, 30, 30),
        { start: { x: 0, y: 0 }, segments: [{ kind: "line", to: { x: 1.2345678901234, y: 2 } }], closed: false },
      ],
    },
    [0.5, 0.1, -0.1, 0.5, 12.3, 45.6],
  ),
);

describe("project", () => {
  it("ida e volta preserva geometria e transform exatamente", () => {
    const json = JSON.parse(JSON.stringify(serializeDocument(doc, new Date("2026-11-14T12:00:00Z"))));
    const back = deserializeDocument(json);
    expect(back.drawings[0].transform).toEqual(doc.drawings[0].transform);
    expect(back.drawings[0].geometry).toEqual(doc.drawings[0].geometry);
    expect(back.drawings[0].name).toBe("círculo e reta");
    expect(back.drawings[0].localBBox).toEqual(doc.drawings[0].localBBox);
    // laço fechado continua terminando exatamente no início
    const sp = back.drawings[0].geometry.subpaths[0];
    expect(sp.segments[sp.segments.length - 1].to).toBe(sp.start);
  });

  it("o conjunto (camadas da mesma imagem) vai e volta; arquivo antigo, sem conjunto, continua abrindo", () => {
    const g = { subpaths: [{ start: { x: 0, y: 0 }, segments: [{ kind: "line" as const, to: { x: 5, y: 0 } }], closed: false }] };
    const doc = { drawings: [createDrawing("a", "cartaz", g, [1, 0, 0, 1, 0, 0], undefined, "g1"), createDrawing("b", "solto", g, [1, 0, 0, 1, 0, 0])] };
    const file = JSON.parse(JSON.stringify(serializeDocument(doc, new Date(0))));
    expect(file.drawings[0].group).toBe("g1");
    expect("group" in file.drawings[1]).toBe(false);
    const back = deserializeDocument(file);
    expect(back.drawings[0].group).toBe("g1");
    expect("group" in back.drawings[1]).toBe(false);
  });

  it("rejeita formato errado, versão 2 e transform com 5 números", () => {
    const ok = serializeDocument(doc, new Date());
    expect(() => deserializeDocument({ format: "outro" })).toThrow("não é um arquivo do Plotter Studio");
    expect(() => deserializeDocument({ ...ok, version: 2 })).toThrow("versão 2");
    const bad = { ...ok, drawings: [{ ...ok.drawings[0], transform: [1, 0, 0, 1, 0] }] };
    expect(() => deserializeDocument(bad)).toThrow("6 números");
    expect(() => deserializeDocument(null)).toThrow("Projeto inválido");
  });
});
