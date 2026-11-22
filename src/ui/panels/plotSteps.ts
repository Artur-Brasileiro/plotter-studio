import { clear, h } from "../dom";
import type { MachineSession } from "../machine/session";
import type { Planner } from "../planner";
import { machineAction } from "./machinePanel";

/**
 * Passo "Plotar", no topo: o caminho até apertar Enviar, na ordem, com o que já foi feito e o que falta.
 * É só um guia: os mesmos botões continuam mais abaixo, com o estado completo da máquina.
 */
export function createPlotSteps(session: MachineSession, planner: Planner, goToStep: (id: "props" | "job") => void): HTMLElement {
  const list = h("ol", { class: "steps" });
  const root = h("div", { class: "panel-section" }, h("h3", null, "Antes de enviar"), list);

  const render = () => {
    const s = session.snapshot;
    const on = s.link === "connected";
    const busy = !!s.busy || session.jobActive;
    const plan = planner.plan;
    const audit = plan && plan.violations.length === 0 ? planner.review()?.audit : undefined;
    const checked = !!audit?.ok;

    type Item = { done: boolean; label: string; note?: string; action?: HTMLElement };
    const items: Item[] = [
      {
        done: !!plan,
        label: "Desenho na mesa",
        note: plan ? undefined : "Traga um SVG ou uma imagem.",
        action: plan ? undefined : h("button", { onclick: () => goToStep("props") }, "Ir para o passo 1"),
      },
      {
        done: checked,
        label: "Conferência aprovada",
        note: !plan ? undefined : checked ? undefined : "O passo 2 mostra o que falta corrigir.",
        action: !plan || checked ? undefined : h("button", { onclick: () => goToStep("job") }, "Ver a conferência"),
      },
      {
        done: on,
        label: "Máquina conectada",
        note: on ? undefined : session.available ? "Feche antes o LaserGRBL: só um programa usa a porta de cada vez." : "O envio direto só existe no Chrome e no Edge.",
        action: on || !session.available ? undefined : h("button", { class: "primary", onclick: () => void machineAction(() => session.connect()) }, "Conectar"),
      },
      {
        done: on && s.homed,
        label: "Home feito",
        note: !on || s.homed ? undefined : "A máquina vai até os fins de curso, atrás à direita. Sem isso a posição não é confiável.",
        action: !on || s.homed ? undefined : h("button", { class: "primary", disabled: busy, onclick: () => void machineAction(() => session.controller!.home()) }, "Fazer o Home"),
      },
      {
        done: false,
        label: "Papel no lugar e caneta no suporte",
        note: "Com o servo embaixo a ponta só encosta no papel, sem zumbir. O Contorno, logo abaixo, mostra onde o desenho vai cair.",
      },
    ];
    clear(list);
    let nextFound = false;
    for (const it of items) {
      const isNext = !it.done && !nextFound;
      if (isNext) nextFound = true;
      list.append(
        h(
          "li",
          { class: it.done ? "done" : isNext ? "next" : "todo" },
          h("span", { class: "mark", "aria-hidden": "true" }, it.done ? "✓" : ""),
          h("div", null, h("span", { class: "label" }, it.label), isNext && it.note ? h("p", { class: "hint" }, it.note) : null, isNext ? (it.action ?? null) : null),
        ),
      );
    }
  };

  let raf = 0;
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render()));
  };
  session.subscribe(schedule);
  planner.subscribe(schedule);
  render();
  return root;
}
