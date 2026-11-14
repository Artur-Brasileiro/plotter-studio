import { machineRotationDeg } from "../../core/coords";
import {
  alignCenter,
  duplicateDrawings,
  removeDrawings,
  selectionMachineBBox,
  setMachineBox,
  setMachineRotation,
  translateMachine,
  type DrawingId,
} from "../../core/document";
import type { BBox } from "../../core/geometry/path";
import type { Store } from "../../core/store";
import { append, clear, h } from "../dom";

/** Lê número digitado com vírgula ou ponto. */
export function parseNum(s: string): number | undefined {
  const v = Number(s.trim().replace(",", "."));
  return s.trim() !== "" && Number.isFinite(v) ? v : undefined;
}

const fmt = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("pt-BR", { maximumFractionDigits: d });

/** Rotação é "reta" (0/90/180/270)? Aí dá para escalar largura e altura separadamente sem distorcer. */
function isRightAngle(deg: number): boolean {
  const r = ((deg % 90) + 90) % 90;
  return r < 1e-6 || 90 - r < 1e-6;
}

export function duplicateSelection(store: Store): void {
  const ids = store.state.selection;
  if (!ids.length) return;
  let newIds: DrawingId[] = [];
  const H = store.state.profile.workArea.height;
  store.commit("Duplicar", (doc) => {
    const r = duplicateDrawings(doc, ids, () => crypto.randomUUID(), { x: 10, y: -10 }, H);
    newIds = r.newIds;
    return r.doc;
  });
  store.setSelection(newIds);
}

export function deleteSelection(store: Store): void {
  const ids = store.state.selection;
  if (ids.length) store.commit(ids.length > 1 ? `Apagar ${ids.length} desenhos` : "Apagar", (doc) => removeDrawings(doc, ids));
}

/**
 * Painel de propriedades da seleção: X/Y = canto inferior esquerdo da caixa na máquina,
 * largura/altura da caixa, rotação vista pelo operador. Cada edição é um commit
 * (Enter ou sair do campo); editar o mesmo campo seguidamente vira uma entrada só.
 */
export function createPropertiesPanel(store: Store): HTMLElement {
  const root = h("div", { class: "panel" });
  let keepRatio = true;
  const fields = new Map<string, HTMLInputElement>();

  const H = () => store.state.profile.workArea.height;
  const tol = () => store.state.profile.tolerance.chordMm;
  const sel = () => store.state.selection;
  const box = (): BBox => selectionMachineBBox(store.doc, sel(), H(), tol());

  const field = (key: string, label: string, onCommit: (v: number) => void, disabled = false) => {
    const input = h("input", { type: "text", inputMode: "decimal", disabled, "aria-label": label });
    const commit = () => {
      const v = parseNum(input.value);
      if (v === undefined) return render(true);
      onCommit(v);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commit();
        input.select();
      } else if (e.key === "Escape") {
        render(true);
        input.blur();
      }
    });
    fields.set(key, input);
    return h("label", { class: "field" }, label, input);
  };

  const align = (label: string, target: BBox) =>
    h("button", { onclick: () => store.commit("Alinhar", (doc) => alignCenter(doc, sel(), target, H(), tol())) }, label);

  const render = (force = false) => {
    const ids = sel();
    // não atrapalha quem está digitando
    if (!force && root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) {
      fill(ids.length);
      return;
    }
    clear(root);
    fields.clear();
    const docCount = store.doc.drawings.length;
    if (ids.length === 0) {
      append(root, [
        h("h3", null, "Propriedades"),
        h(
          "p",
          { class: "hint" },
          docCount
            ? "Clique num desenho para selecionar. Shift + clique soma à seleção; arraste no vazio para selecionar vários."
            : "Importe um SVG para começar (botão ou arraste o arquivo para a janela).",
        ),
        docCount ? h("p", { class: "hint" }, `${docCount} desenho${docCount > 1 ? "s" : ""} na mesa.`) : null,
      ]);
      return;
    }

    const single = ids.length === 1 ? store.doc.drawings.find((d) => d.id === ids[0]) : undefined;
    const rot = single ? machineRotationDeg(single.transform) : 0;
    const free = !!single && isRightAngle(rot);

    root.append(h("div", { class: "title" }, single ? single.name : `${ids.length} desenhos selecionados`));
    const grid = h("div", { class: "grid2" });
    grid.append(
      field("x", "X (mm)", (v) => {
        if (single) store.commit("Mover", (doc) => setMachineBox(doc, single.id, { x: v, keepRatio: true }, H(), tol()), { coalesceKey: "field:x" });
        else store.commit("Mover", (doc) => translateMachine(doc, ids, { x: v - box().minX, y: 0 }), { coalesceKey: "field:x" });
      }),
      field("y", "Y (mm)", (v) => {
        if (single) store.commit("Mover", (doc) => setMachineBox(doc, single.id, { y: v, keepRatio: true }, H(), tol()), { coalesceKey: "field:y" });
        else store.commit("Mover", (doc) => translateMachine(doc, ids, { x: 0, y: v - box().minY }), { coalesceKey: "field:y" });
      }),
    );
    if (single) {
      const sizeLabel = "Redimensionar";
      grid.append(
        field("w", "Largura (mm)", (v) => {
          if (v <= 0) return render(true);
          store.commit(sizeLabel, (doc) => setMachineBox(doc, single.id, { width: v, keepRatio: keepRatio || !free }, H(), tol()), { coalesceKey: "field:w" });
        }),
        field("h", "Altura (mm)", (v) => {
          if (v <= 0) return render(true);
          store.commit(sizeLabel, (doc) => setMachineBox(doc, single.id, { height: v, keepRatio: keepRatio || !free }, H(), tol()), { coalesceKey: "field:h" });
        }),
        field("r", "Rotação (°)", (v) => {
          store.commit("Girar", (doc) => setMachineRotation(doc, single.id, v, H(), tol()), { coalesceKey: "field:r" });
        }),
      );
    }
    root.append(grid);

    if (single) {
      const cb = h("input", { type: "checkbox", checked: keepRatio || !free, disabled: !free });
      cb.addEventListener("change", () => (keepRatio = cb.checked));
      root.append(
        h("label", { class: "check", title: free ? "" : "Com o desenho girado em ângulo não reto, a proporção fica sempre travada (senão ele distorce)." }, cb, "Travar proporção"),
      );
    }

    const { workArea, paperTemplates } = store.state.profile;
    root.append(
      h("h3", null, "Alinhar (centralizar)"),
      h(
        "div",
        { class: "row" },
        align("Na mesa", { minX: 0, minY: 0, maxX: workArea.width, maxY: workArea.height }),
        ...paperTemplates.map((t) => align(`No ${t.name}`, { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.height })),
      ),
      h("h3", null, "Ações"),
      h(
        "div",
        { class: "row" },
        h("button", { title: "Ctrl+D", onclick: () => duplicateSelection(store) }, "Duplicar"),
        h("button", { title: "Delete", onclick: () => deleteSelection(store) }, "Apagar"),
      ),
      h("p", { class: "hint" }, "Setas movem 1 mm (Shift: 10 mm). Ctrl+Z desfaz, Ctrl+Y refaz."),
    );
    fill(ids.length);
  };

  /** Preenche os campos com a caixa atual (menos o que está com foco). */
  const fill = (n: number) => {
    if (n === 0) return;
    const b = box();
    const single = n === 1 ? store.doc.drawings.find((d) => d.id === sel()[0]) : undefined;
    const values: Record<string, string> = {
      x: fmt(b.minX),
      y: fmt(b.minY),
      w: fmt(b.maxX - b.minX),
      h: fmt(b.maxY - b.minY),
      r: single ? fmt(machineRotationDeg(single.transform), 2) : "",
    };
    for (const [k, input] of fields) if (input !== document.activeElement) input.value = values[k] ?? "";
  };

  store.subscribe((s, prev) => {
    if (s.selection !== prev.selection) render(true);
    else if (s.history !== prev.history || s.profile !== prev.profile) render();
  });
  render(true);
  return root;
}
