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

describe("mesa travada: enquanto a máquina desenha, nada na mesa muda", () => {
  const withTwo = () => {
    const s = new Store();
    s.commit("Importar", (doc) => addDrawing(doc, d("a")));
    s.commit("Importar", (doc) => addDrawing(doc, d("b")));
    return s;
  };

  it("começa destravada", () => {
    expect(new Store().state.locked).toBe(false);
  });

  it("travada, um commit não muda o documento nem o histórico", () => {
    const s = withTwo();
    s.setLocked(true);
    const before = s.state.history;
    s.commit("Apagar", (doc) => removeDrawings(doc, ["a"]));
    expect(s.doc.drawings.map((x) => x.id)).toEqual(["a", "b"]);
    expect(s.state.history).toBe(before);
  });

  it("travada, desfazer e refazer não fazem nada", () => {
    const s = withTwo();
    s.undo(); // sobra "a"; "b" fica para refazer
    s.setLocked(true);
    s.undo();
    expect(s.doc.drawings.map((x) => x.id)).toEqual(["a"]);
    s.redo();
    expect(s.doc.drawings.map((x) => x.id)).toEqual(["a"]);
  });

  it("travar solta o que estava selecionado, e nada pode ser selecionado enquanto isso", () => {
    const s = withTwo();
    s.setSelection(["a"]);
    s.setLocked(true);
    expect(s.state.selection).toEqual([]);
    s.setSelection(["b"]);
    expect(s.state.selection).toEqual([]);
  });

  it("quem ouve o estado fica sabendo quando trava e quando destrava", () => {
    const s = withTwo();
    const seen: boolean[] = [];
    s.subscribe((st, prev) => st.locked !== prev.locked && seen.push(st.locked));
    s.setLocked(true);
    s.setLocked(true); // repetir não avisa de novo
    s.setLocked(false);
    expect(seen).toEqual([true, false]);
  });

  it("destravada, tudo volta a funcionar", () => {
    const s = withTwo();
    s.setLocked(true);
    s.setLocked(false);
    s.setSelection(["b"]);
    s.commit("Apagar", (doc) => removeDrawings(doc, ["a"]));
    expect(s.doc.drawings.map((x) => x.id)).toEqual(["b"]);
    expect(s.state.selection).toEqual(["b"]);
    s.undo();
    expect(s.doc.drawings.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("os ajustes do trabalho e da máquina não são da mesa: continuam podendo mudar", () => {
    const s = withTwo();
    s.setLocked(true);
    s.setJob({ optimize: false });
    expect(s.state.job.optimize).toBe(false);
  });
});
