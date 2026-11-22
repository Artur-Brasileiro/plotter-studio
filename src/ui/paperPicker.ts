import { h } from "./dom";
import { onPaperChange, paperColor, PAPERS, setPaperColor } from "./paper";

/**
 * Escolha da cor do papel: as folhas prontas (branco, preto, kraft) e um seletor para qualquer outra cor.
 * Aparece na barra de cima e na tela de vetorizar; as duas mostram e mudam a mesma coisa.
 * `dispose` desliga o aviso de mudança (para quem cria o seletor dentro de uma janela que fecha).
 */
export function createPaperPicker(label = "Papel"): { el: HTMLElement; dispose: () => void } {
  const buttons = PAPERS.map((p) =>
    h("button", { class: "swatch", title: `Papel ${p.name.toLowerCase()}`, "aria-label": `Papel ${p.name.toLowerCase()}`, style: `--c:${p.color}`, onclick: () => setPaperColor(p.color) }),
  );
  const custom = h("input", { type: "color", class: "swatch-custom", title: "Outra cor de papel", "aria-label": "Outra cor de papel" });
  custom.addEventListener("input", () => setPaperColor(custom.value));
  const sync = () => {
    const c = paperColor().toLowerCase();
    let known = false;
    buttons.forEach((b, i) => {
      const on = PAPERS[i].color.toLowerCase() === c;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      known ||= on;
    });
    custom.value = c;
    custom.classList.toggle("on", !known);
  };
  sync();
  const dispose = onPaperChange(sync);
  const el = h("div", { class: "paper-picker", role: "group", "aria-label": "Cor do papel" }, h("span", { class: "paper-label" }, label), ...buttons, custom);
  return { el, dispose };
}
