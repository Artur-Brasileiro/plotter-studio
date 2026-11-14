import { describe, expect, it } from "vitest";
import { canRedo, canUndo, commit, createHistory, redo, redoLabel, undo, undoLabel } from "./history";

describe("history", () => {
  it("commit, undo e redo", () => {
    let h = createHistory("a");
    h = commit(h, "b", "B", { now: 0 });
    h = commit(h, "c", "C", { now: 1000 });
    expect(h.present.state).toBe("c");
    expect(undoLabel(h)).toBe("C");
    h = undo(h);
    expect(h.present.state).toBe("b");
    expect(redoLabel(h)).toBe("C");
    h = undo(h);
    expect(h.present.state).toBe("a");
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    expect(h.present.state).toBe("b");
  });

  it("um commit novo descarta o redo", () => {
    let h = commit(commit(createHistory("a"), "b", "B", { now: 0 }), "c", "C", { now: 1000 });
    h = undo(h);
    h = commit(h, "d", "D", { now: 2000 });
    expect(canRedo(h)).toBe(false);
    expect(h.past.map((e) => e.state)).toEqual(["a", "b"]);
  });

  it("limite de 100 entradas", () => {
    let h = createHistory(0);
    for (let i = 1; i <= 150; i++) h = commit(h, i, `#${i}`, { now: i * 1000 });
    expect(h.past).toHaveLength(100);
    expect(h.past[0].state).toBe(50);
  });

  it("mesmo coalesceKey em menos de 800 ms junta; depois de 800 ms não junta", () => {
    let h = createHistory(0);
    h = commit(h, 1, "Mover", { now: 0, coalesceKey: "nudge" });
    h = commit(h, 2, "Mover", { now: 300, coalesceKey: "nudge" });
    h = commit(h, 3, "Mover", { now: 600, coalesceKey: "nudge" });
    expect(h.past).toHaveLength(1);
    expect(h.present.state).toBe(3);
    h = commit(h, 4, "Mover", { now: 1500, coalesceKey: "nudge" });
    expect(h.past).toHaveLength(2);
    expect(undo(h).present.state).toBe(3);
  });

  it("commit sem mudança (mesma referência) não empilha", () => {
    const h = createHistory({ x: 1 });
    expect(commit(h, h.present.state, "nada", { now: 0 })).toBe(h);
  });

  it("undo sem passado devolve o mesmo histórico", () => {
    const h = createHistory(1);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});
