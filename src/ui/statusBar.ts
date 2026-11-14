import type { Vec } from "../core/geometry/vec";
import { clear, fmtMm, h } from "./dom";

/**
 * Rodapé: coordenadas do cursor em mm da MÁQUINA, zoom e mensagens com chave
 * (ex.: "area" para o aviso de desenho fora da área, "estimate" para o tempo).
 */
export class StatusBar {
  private readonly cursor = h("span", { class: "sb-cursor" }, "X —  Y —");
  private readonly zoom = h("span", { class: "sb-zoom" });
  private readonly msgs = h("span", { class: "sb-msgs" });
  private readonly messages = new Map<string, { text: string; kind: "info" | "warn" }>();

  constructor(host: HTMLElement) {
    clear(host);
    host.append(this.cursor, this.zoom, this.msgs);
  }

  setCursor(p: Vec | undefined): void {
    this.cursor.textContent = p ? `X ${fmtMm(p.x)}  Y ${fmtMm(p.y)} mm` : "X —  Y —";
  }

  setZoom(pxPerMm: number): void {
    this.zoom.textContent = `zoom ${fmtMm(pxPerMm, 2)} px/mm`;
  }

  setMessage(key: string, text: string | undefined, kind: "info" | "warn" = "info"): void {
    if (text) this.messages.set(key, { text, kind });
    else this.messages.delete(key);
    clear(this.msgs);
    for (const m of this.messages.values()) this.msgs.append(h("span", { class: `sb-msg sb-${m.kind}` }, m.text));
  }
}
