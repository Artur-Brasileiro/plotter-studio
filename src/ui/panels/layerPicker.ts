import type { JobPlan } from "../../core/job/types";
import { clear, h } from "../dom";
import { fmtDuration, type Planner } from "../planner";

const MARK = { ok: "✓", warn: "!", bad: "✕" } as const;

/** "−1 mm em X": como a camada foi deslocada para compensar a ponta da caneta. */
export function offsetText(plan: JobPlan): string {
  const o = plan.layer?.offset;
  if (!o || (o.x === 0 && o.y === 0)) return "";
  const n = (v: number) => `${v > 0 ? "−" : "+"}${Math.abs(v).toLocaleString("pt-BR")} mm`;
  return [o.x ? `${n(o.x)} em X` : "", o.y ? `${n(o.y)} em Y` : ""].filter(Boolean).join(" e ");
}

/**
 * Lista das camadas (uma por caneta), na ordem de plotar. Clicar escolhe a camada que os painéis
 * conferem, mostram e enviam. Some quando o desenho usa uma caneta só.
 */
export function createLayerPicker(planner: Planner, opts: { title: string; disabled?: () => boolean }): HTMLElement {
  const list = h("div", { class: "layers", role: "radiogroup", "aria-label": opts.title });
  const note = h("p", { class: "hint" });
  const root = h("div", { class: "layer-picker" }, h("h3", null, opts.title), list, note);

  const render = () => {
    const plans = planner.layers;
    root.hidden = plans.length <= 1;
    if (root.hidden) return;
    const active = planner.plan;
    const locked = opts.disabled?.() ?? false;
    clear(list);
    let total = 0;
    for (const p of plans) {
      const l = p.layer!;
      const status = planner.status(p);
      total += p.stats.estimate.totalS;
      const on = p === active;
      list.append(
        h(
          "button",
          {
            class: `layer${on ? " active" : ""}`,
            role: "radio",
            "aria-checked": String(on),
            disabled: locked && !on,
            onclick: () => planner.setLayer(l.penId),
          },
          h("span", { class: "layer-n" }, String(l.index + 1)),
          h("span", { class: "layer-dot", style: `background:${l.color}`, "aria-hidden": "true" }),
          h("span", { class: "layer-name" }, l.penName),
          h("span", { class: "layer-time" }, fmtDuration(p.stats.estimate.totalS)),
          h("span", { class: `layer-mark ${status ?? ""}`, title: status === "ok" ? "Passou na conferência" : status === "warn" ? "Passou, com atenção" : "Reprovada na conferência" }, status ? MARK[status] : ""),
        ),
      );
    }
    const off = active ? offsetText(active) : "";
    note.textContent =
      `Plote nesta ordem, sem mexer no papel: só a caneta muda. Ao todo, ${fmtDuration(total)}. ` +
      (active?.layer?.registration ? "Cada camada começa e termina por uma cruz de registro, na borda de baixo: as cruzes têm que cair uma em cima da outra. " : "") +
      (off ? `A camada ${active!.layer!.penName} sai deslocada ${off}, para compensar a ponta dessa caneta.` : "");
  };

  planner.subscribe(render);
  render();
  return root;
}
