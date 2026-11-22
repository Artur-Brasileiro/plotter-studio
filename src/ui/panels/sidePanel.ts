import { clear, h } from "../dom";

export type StepFlag = "ok" | "warn" | "bad" | undefined;

/**
 * Painel lateral com os passos do trabalho, na ordem em que acontecem:
 * trazer e posicionar o desenho, conferir, plotar. Cada passo é um elemento que já sabe se atualizar sozinho.
 */
export class SidePanel {
  private readonly bar = h("div", { class: "tabs", role: "tablist" });
  private readonly body = h("div", { class: "side-body" });
  private readonly tabs: { id: string; button: HTMLButtonElement; flag: HTMLElement; el: HTMLElement }[] = [];
  private current = "";
  /** Chamado ao trocar de passo (o rodapé mostra se as setas fazem jog). */
  onChange: (id: string) => void = () => {};

  constructor(host: HTMLElement) {
    clear(host);
    host.append(this.bar, this.body);
  }

  addTab(id: string, label: string, el: HTMLElement): void {
    const flag = h("span", { class: "step-flag", hidden: true });
    const button = h(
      "button",
      { role: "tab", onclick: () => this.show(id) },
      h("span", { class: "step-n", "aria-hidden": "true" }, String(this.tabs.length + 1)),
      label,
      flag,
    );
    this.bar.append(button);
    this.tabs.push({ id, button, flag, el });
    if (!this.current) this.show(id);
  }

  /** Bolinha de estado ao lado do nome do passo (ex.: a conferência achou um erro). */
  setFlag(id: string, flag: StepFlag, title = ""): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.flag.hidden = !flag;
    tab.flag.className = `step-flag ${flag ?? ""}`;
    tab.flag.title = title;
  }

  show(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.current = id;
    for (const t of this.tabs) {
      t.button.classList.toggle("on", t.id === id);
      t.button.setAttribute("aria-selected", String(t.id === id));
    }
    clear(this.body);
    this.body.append(tab.el);
    this.onChange(id);
  }

  get active(): string {
    return this.current;
  }
}
