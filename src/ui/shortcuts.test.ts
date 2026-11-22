// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDrawing, createDrawing, EMPTY_DOCUMENT } from "../core/document";
import { translation } from "../core/geometry/mat2d";
import type { Geometry } from "../core/geometry/path";
import { Store } from "../core/store";
import { installShortcuts } from "./shortcuts";

const line: Geometry = { subpaths: [{ start: { x: 0, y: 0 }, segments: [{ kind: "line", to: { x: 10, y: 0 } }], closed: false }] };

const press = (key: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

describe("atalhos da mesa", () => {
  let store: Store;
  let off: () => void;

  beforeEach(() => {
    store = new Store();
    store.commit("Importar", (doc) => addDrawing(doc, createDrawing("d1", "desenho", line, translation(50, 50))));
    store.setSelection(["d1"]);
    off = installShortcuts(store);
  });
  afterEach(() => {
    off();
    document.body.replaceChildren();
  });

  it("Delete apaga o desenho selecionado", () => {
    press("Delete");
    expect(store.doc.drawings).toHaveLength(0);
  });

  it("com uma tela aberta por cima (vetorizar, apagar traços), Delete NÃO apaga o desenho da mesa", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    press("Delete");
    press("Backspace");
    expect(store.doc.drawings).toHaveLength(1);
  });

  it("com uma tela aberta, Ctrl+Z, Ctrl+A, Esc e as setas também ficam com a tela", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    const before = store.doc;
    press("z", { ctrlKey: true });
    expect(store.doc).toBe(before);
    press("ArrowRight");
    expect(store.doc).toBe(before);
    press("Escape");
    expect(store.state.selection).toEqual(["d1"]);
    store.setSelection([]);
    press("a", { ctrlKey: true });
    expect(store.state.selection).toEqual([]);
  });

  describe("conjunto de camadas (as camadas de uma imagem andam juntas)", () => {
    beforeEach(() => {
      store.commit("Vetorizar imagem", (doc) => [createDrawing("p", "cartaz", line, translation(100, 100), undefined, "g1"), createDrawing("v", "cartaz", line, translation(100, 100), "vermelha", "g1")].reduce(addDrawing, doc));
      // por algum caminho a seleção ficou só com UMA camada do conjunto
      store.setSelection(["v"]);
    });
    const at = (id: string) => store.doc.drawings.find((d) => d.id === id)!.transform;

    it("as setas movem o conjunto inteiro: as camadas continuam na mesma posição", () => {
      press("ArrowRight");
      expect(at("p")[4]).toBe(101);
      expect(at("v")[4]).toBe(101);
      expect(at("d1")[4]).toBe(50); // o desenho solto, fora da seleção, não mexe
    });

    it("Delete apaga o conjunto inteiro, numa entrada só do histórico", () => {
      press("Delete");
      expect(store.doc.drawings.map((d) => d.id)).toEqual(["d1"]);
      store.undo();
      expect(store.doc.drawings.map((d) => d.id)).toEqual(["d1", "p", "v"]);
    });

    it("Ctrl+D duplica o conjunto inteiro, e a cópia é um conjunto novo já selecionado", () => {
      press("d", { ctrlKey: true });
      const copies = store.doc.drawings.filter((d) => !["d1", "p", "v"].includes(d.id));
      expect(copies).toHaveLength(2);
      expect(copies[0].group).toBe(copies[1].group);
      expect(copies[0].group).not.toBe("g1");
      expect([...store.state.selection].sort()).toEqual(copies.map((d) => d.id).sort());
    });
  });

  it("fechada a tela, os atalhos voltam", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    press("Delete");
    dialog.remove();
    press("Delete");
    expect(store.doc.drawings).toEqual(EMPTY_DOCUMENT.drawings);
  });
});
