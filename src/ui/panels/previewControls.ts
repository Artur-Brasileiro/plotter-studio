import { h } from "../dom";
import type { Overlay, Player } from "../overlay";

const SPEEDS = [1, 5, 20, 50];

const mmss = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** Seção "Pré-visualização": mostrar o caminho, play/pausa/parar e a velocidade da animação. */
export function createPreviewControls(overlay: Overlay, player: Player): HTMLElement {
  const show = h("input", { type: "checkbox" });
  show.addEventListener("change", () => {
    if (!show.checked) player.stop();
    overlay.setVisible(show.checked);
  });
  const playBtn = h("button", { title: "Anima a ordem real do desenho" }, "▶ Play");
  playBtn.addEventListener("click", () => (player.playing ? player.pause() : player.play()));
  const stopBtn = h("button", { onclick: () => player.stop() }, "⏹");
  const speed = h("select", { "aria-label": "Velocidade da animação" }, ...SPEEDS.map((s) => h("option", { value: String(s), selected: s === player.speed }, `×${s}`)));
  speed.addEventListener("change", () => (player.speed = Number(speed.value)));
  const time = h("span", { class: "hint" }, "");

  player.onTick = (t, total, playing) => {
    playBtn.textContent = playing ? "⏸ Pausar" : "▶ Play";
    time.textContent = total ? `${mmss(t)} / ${mmss(total)}` : "";
    show.checked = overlay.isVisible;
  };

  const swatch = (color: string, label: string, dashed = false) =>
    h("span", { class: "legend-item" }, h("span", { class: "swatch", style: `border-top: 3px ${dashed ? "dashed" : "solid"} ${color}` }), label);

  return h(
    "div",
    { class: "panel-section" },
    h("h3", null, "Pré-visualização"),
    h("label", { class: "check" }, show, "Mostrar o caminho"),
    h("div", { class: "row", style: "align-items:center" }, playBtn, stopBtn, speed, time),
    h(
      "div",
      { class: "legend" },
      swatch("#2e7d32", "reta"),
      swatch("#ef6c00", "curva"),
      swatch("#c62828", "curva fechada"),
      swatch("#1565c0", "F fixo"),
      swatch("#8a8a8a", "caneta levantada", true),
    ),
  );
}
