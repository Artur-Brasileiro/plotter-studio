import { clear, h } from "../dom";

/** Painel lateral com abas. Cada aba é um elemento que já sabe se atualizar sozinho. */
export class SidePanel {
  private readonly bar = h("div", { class: "tabs", role: "tablist" });
  private readonly body = h("div", { class: "side-body" });
  private readonly tabs: { id: string; button: HTMLButtonElement; el: HTMLElement }[] = [];
  private current = "";
  /** Chamado ao trocar de aba (o rodapé mostra se as setas fazem jog). */
  onChange: (id: string) => void = () => {};

  constructor(host: HTMLElement) {
    clear(host);
    host.append(this.bar, this.body);
  }

  addTab(id: string, label: string, el: HTMLElement): void {
    const button = h("button", { role: "tab", onclick: () => this.show(id) }, label);
    this.bar.append(button);
    this.tabs.push({ id, button, el });
    if (!this.current) this.show(id);
  }

  show(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.current = id;
    for (const t of this.tabs) t.button.classList.toggle("on", t.id === id);
    clear(this.body);
    this.body.append(tab.el);
    this.onChange(id);
  }

  get active(): string {
    return this.current;
  }
}
