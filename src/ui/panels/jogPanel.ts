import type { ControllerSnapshot } from "../../core/grbl/controller";
import type { Vec } from "../../core/geometry/vec";
import { JOG_STEPS, loadUiPrefs, saveUiPrefs } from "../../storage/uiPrefs";
import { fmtMm, h, isTyping, toast } from "../dom";
import type { MachineSession } from "../machine/session";
import { canMoveManually, machineAction } from "./machinePanel";
import { parseNum } from "./propertiesPanel";

/** Direções em coordenadas da MÁQUINA: ↑ = Y+ (para longe do operador), → = X+. */
const ARROWS: { label: string; d: Vec; title: string }[] = [
  { label: "↖", d: { x: -1, y: 1 }, title: "X− Y+" },
  { label: "↑", d: { x: 0, y: 1 }, title: "Y+ (para longe de você)" },
  { label: "↗", d: { x: 1, y: 1 }, title: "X+ Y+" },
  { label: "←", d: { x: -1, y: 0 }, title: "X− (esquerda)" },
  { label: "", d: { x: 0, y: 0 }, title: "" },
  { label: "→", d: { x: 1, y: 0 }, title: "X+ (direita)" },
  { label: "↙", d: { x: -1, y: -1 }, title: "X− Y−" },
  { label: "↓", d: { x: 0, y: -1 }, title: "Y− (para perto de você)" },
  { label: "↘", d: { x: 1, y: -1 }, title: "X+ Y−" },
];

const KEY_DIR: Record<string, Vec> = {
  ArrowUp: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

export interface JogPanel {
  readonly el: HTMLElement;
  /** As setas do teclado estão fazendo jog agora? (senão movem o desenho) */
  keysActive(): boolean;
}

/**
 * Jog: setas na tela (8 direções) e no teclado, passo 0,1/1/10/50 mm ou contínuo (segurar = um $J até a
 * borda, 0x85 ao soltar, ao perder o foco ou ao trocar de aba) e velocidade.
 * `tabActive` diz se a aba Máquina está aberta: só então as setas do teclado fazem jog.
 */
export function createJogPanel(session: MachineSession, tabActive: () => boolean): JogPanel {
  const prefs = loadUiPrefs();
  let step = prefs.jogStep;
  let feed = prefs.jogFeed;
  let holding = false; // jog contínuo em andamento (tela ou teclado)

  const ctrl = () => session.controller;
  const s = () => session.snapshot;
  const allowed = () => canMoveManually(s(), session.jobActive) && (step !== "continuous" || s().homed);

  const start = (d: Vec) => {
    const c = ctrl();
    if (!c || !allowed()) return;
    if (step === "continuous") {
      try {
        c.jogContinuous(d, feed);
        holding = true;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error");
      }
    } else {
      const k = step;
      void machineAction(() => c.jogStep({ x: d.x * k, y: d.y * k }, feed));
    }
  };
  const stop = () => {
    if (!holding) return;
    holding = false;
    ctrl()?.jogStop();
  };

  // --- setas na tela
  const pad = h("div", { class: "jog-pad" });
  const padButtons: HTMLButtonElement[] = [];
  for (const a of ARROWS) {
    if (!a.label) {
      pad.append(h("span", { class: "jog-center" }));
      continue;
    }
    const b = h("button", { class: "jog-btn", title: a.title }, a.label);
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      b.setPointerCapture(e.pointerId);
      start(a.d);
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, stop);
    padButtons.push(b);
    pad.append(b);
  }

  // --- passo
  const stepButtons = JOG_STEPS.map((v) => {
    const b = h("button", { class: "seg", title: v === "continuous" ? "Segurar a seta = anda até soltar" : `${fmtMm(v as number, v === 0.1 ? 1 : 0)} mm por clique` }, v === "continuous" ? "contínuo" : fmtMm(v as number, v === 0.1 ? 1 : 0));
    b.addEventListener("click", () => {
      step = v;
      saveUiPrefs({ jogStep: v });
      render(s());
    });
    return b;
  });

  // --- velocidade
  const feedInput = h("input", { type: "text", inputMode: "numeric", value: String(feed), "aria-label": "Velocidade do jog (mm/min)" });
  const commitFeed = () => {
    const v = parseNum(feedInput.value);
    const max = session.snapshot.settings.get(110) ? Number(session.snapshot.settings.get(110)) : 12000;
    if (v === undefined || v < 10 || v > max) {
      toast(`Velocidade do jog entre 10 e ${max} mm/min.`, "warn");
      feedInput.value = String(feed);
      return;
    }
    feed = Math.round(v);
    feedInput.value = String(feed);
    saveUiPrefs({ jogFeed: feed });
  };
  feedInput.addEventListener("change", commitFeed);
  feedInput.addEventListener("keydown", (e) => e.key === "Enter" && commitFeed());

  const note = h("p", { class: "hint" });
  const el = h(
    "div",
    { class: "panel-section" },
    h("h3", null, "Jog"),
    h("div", { class: "jog-wrap" }, pad, h("div", { class: "jog-side" }, h("div", { class: "seg-group" }, ...stepButtons), h("label", { class: "field" }, "Velocidade (mm/min)", feedInput))),
    note,
  );

  const keysActive = () => tabActive() && s().link === "connected" && !session.jobActive;

  function render(snap: ControllerSnapshot) {
    const ok = canMoveManually(snap, session.jobActive);
    const contNeedsHome = step === "continuous" && !snap.homed;
    for (const b of padButtons) b.disabled = !ok || contNeedsHome;
    stepButtons.forEach((b, i) => b.classList.toggle("on", JOG_STEPS[i] === step));
    el.hidden = snap.link !== "connected";
    note.textContent = contNeedsHome
      ? "O jog contínuo vai até a borda da área: precisa do Home (sem ele a borda pode estar em qualquer lugar)."
      : snap.homed
        ? "Com esta aba aberta, as setas do teclado também fazem jog (fora dos campos de texto)."
        : "Sem Home a posição mostrada não é a real: o jog anda a distância pedida, mas a área pode estar errada.";
    if (holding && snap.link !== "connected") holding = false;
  }

  // teclado: só com a aba Máquina aberta e conectado
  window.addEventListener("keydown", (e) => {
    const d = KEY_DIR[e.key];
    if (!d || !keysActive() || isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (e.repeat) return; // passo: um por toque; contínuo: o $J já vai até a borda
    start(d);
  });
  window.addEventListener("keyup", (e) => {
    if (KEY_DIR[e.key]) stop();
  });
  window.addEventListener("blur", stop);
  document.addEventListener("visibilitychange", () => document.hidden && stop());

  let raf = 0;
  session.subscribe(() => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render(session.snapshot)));
  });
  render(session.snapshot);
  return { el, keysActive };
}
