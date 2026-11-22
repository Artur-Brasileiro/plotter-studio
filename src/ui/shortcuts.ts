import { translateMachine } from "../core/document";
import type { Store } from "../core/store";
import { isTyping } from "./dom";
import { deleteSelection, duplicateSelection } from "./panels/propertiesPanel";

/**
 * Atalhos de edição (ignorados enquanto o foco está num campo de texto ou há uma tela aberta por cima da mesa):
 * Delete apaga, Ctrl+D duplica, setas movem 1 mm (Shift: 10 mm), Ctrl+Z/Ctrl+Y desfaz/refaz,
 * Ctrl+A seleciona tudo, Esc limpa a seleção.
 * `arrowsEnabled` permite à v2 usar as setas para o jog quando a aba da máquina estiver ativa.
 */
export function installShortcuts(store: Store, opts: { arrowsEnabled?: () => boolean } = {}): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTyping()) return;
    // com uma tela aberta por cima (vetorizar, apagar traços, configurações) as teclas são dela:
    // sem isto, Delete lá dentro apagaria o desenho selecionado na mesa
    if (document.querySelector("dialog[open]")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    let handled = true;

    if (ctrl && (key === "z" || key === "Z") && !e.shiftKey) store.undo();
    else if (ctrl && (key === "y" || key === "Y" || ((key === "z" || key === "Z") && e.shiftKey))) store.redo();
    else if (ctrl && (key === "d" || key === "D")) duplicateSelection(store);
    else if (ctrl && (key === "a" || key === "A")) store.setSelection(store.doc.drawings.map((d) => d.id));
    else if (!ctrl && (key === "Delete" || key === "Backspace")) deleteSelection(store);
    else if (!ctrl && key === "Escape") store.setSelection([]);
    else if (!ctrl && key.startsWith("Arrow") && store.state.selection.length && (opts.arrowsEnabled?.() ?? true)) {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: step }, ArrowDown: { x: 0, y: -step } }[key];
      if (d) store.commit("Mover", (doc) => translateMachine(doc, store.state.selection, d), { coalesceKey: "nudge" });
      else handled = false;
    } else handled = false;

    if (handled) e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
