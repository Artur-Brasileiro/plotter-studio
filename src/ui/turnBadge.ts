import { h } from "./dom";
import { onTurning, ROTATE_SNAP } from "./gestures";

/** 12,5° · 90° (uma casa, vírgula). */
export function angleText(deg: number): string {
  const r = Math.round(deg * 10) / 10;
  return `${(r === 0 ? 0 : r).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}°`;
}

/** Encaixado num dos ângulos redondos (0, 45, 90...)? */
export function isSnapped(deg: number): boolean {
  const r = ((deg % ROTATE_SNAP.step) + ROTATE_SNAP.step) % ROTATE_SNAP.step;
  return r < 1e-6 || ROTATE_SNAP.step - r < 1e-6;
}

/**
 * A etiqueta com o ângulo, ao lado do mouse, enquanto um desenho é girado na mesa. Fica cheia (azul)
 * quando o desenho encaixou num ângulo redondo: é o sinal de que ele está reto.
 */
export function installTurnBadge(wrap: HTMLElement): () => void {
  const badge = h("div", { class: "turn-badge", hidden: true, "aria-hidden": "true" });
  wrap.append(badge);
  const off = onTurning((t) => {
    if (!t) {
      badge.hidden = true;
      return;
    }
    const r = wrap.getBoundingClientRect();
    badge.textContent = angleText(t.deg);
    badge.classList.toggle("snapped", isSnapped(t.deg));
    badge.style.left = `${t.clientX - r.left + 18}px`;
    badge.style.top = `${t.clientY - r.top + 18}px`;
    badge.hidden = false;
  });
  return () => {
    off();
    badge.remove();
  };
}
