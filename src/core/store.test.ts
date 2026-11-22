import { describe, expect, it, vi } from "vitest";
import { addDrawing, createDrawing, EMPTY_DOCUMENT, removeDrawings } from "./document";
import { IDENTITY } from "./geometry/mat2d";
import { Store } from "./store";

const geom = { subpaths: [{ start: { x: 0, y: 0 }, segments: [{ kind: "line" as const, to: { x: 1, y: 0 } }], closed: false }] };
const d = (id: string) => createDrawing(id, id, geom, IDENTITY);

describe("Store", () => {
  it("commit notifica com o estado anterior", () => {
    const s = new Store();
    const calls: [number, number][] = [];
    s.subscribe((st, prev) => calls.push([st.history.present.state.drawings.length, prev.history.present.state.drawings.length]));
    s.commit("Importar", (doc) => addDrawing(doc, d("a")));
    expect(calls).toEqual([[1, 0]]);
  });

  it("commit que não muda nada não notifica", () => {
    const s = new Store();
    const l = vi.fn();
    s.subscribe(l);
    s.commit("Nada", (doc) => doc);
    s.undo();
    expect(l).not.toHaveBeenCalled();
  });

  it("apagar um desenho tira ele da seleção; desfazer devolve o desenho", () => {
    const s = new Store();
    s.commit("Importar", (doc) => addDrawing(doc, d("a")));
    s.setSelection(["a"]);
    s.commit("Apagar", (doc) => removeDrawings(doc, ["a"]));
    expect(s.state.selection).toEqual([]);
    s.undo();
    expect(s.doc.drawings.map((x) => x.id)).toEqual(["a"]);
  });

  it("replaceDocument zera o histórico", () => {
    const s = new Store();
    s.commit("Importar", (doc) => addDrawing(doc, d("a")));
    s.replaceDocument(addDrawing(EMPTY_DOCUMENT, d("b")));
    expect(s.state.history.past).toHaveLength(0);
    expect(s.doc.drawings[0].id).toBe("b");
  });

  it("o relógio injetado controla o coalesce", () => {
    let t = 0;
    const s = new Store(undefined, { now: () => t });
    s.commit("A", (doc) => addDrawing(doc, d("a")));
    s.commit("Mover", (doc) => addDrawing(doc, d("b")), { coalesceKey: "k" });
    t = 100;
    s.commit("Mover", (doc) => addDrawing(doc, d("c")), { coalesceKey: "k" });
    expect(s.state.history.past).toHaveLength(2);
  });

  it("setJob e setProfile", () => {
    const s = new Store();
    s.setJob({ optimize: false });
    expect(s.state.job.optimize).toBe(false);
    expect(s.state.job.speedMode).toBe("fixed"); // padrão de docs/REGRAS_GCODE.md: F500 fixo
    expect(s.state.job.fixedFeed).toBe(500);
  });
});
