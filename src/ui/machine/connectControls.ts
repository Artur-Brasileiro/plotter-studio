import type { ControllerSnapshot } from "../../core/grbl/controller";
import { stateLabel } from "../../core/grbl/protocol";
import { h, toast } from "../dom";
import type { MachineSession } from "./session";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Classe de cor do estado: Idle verde, Run azul, Hold amarelo, Alarm vermelho. */
export function stateClass(s: ControllerSnapshot): string {
  if (s.link === "lost") return "st-alarm";
  if (s.link !== "connected") return "st-off";
  switch (s.status?.state) {
    case "Idle":
      return "st-idle";
    case "Run":
    case "Jog":
    case "Home":
      return "st-run";
    case "Hold":
    case "Door":
      return "st-hold";
    case "Alarm":
      return "st-alarm";
    default:
      return "st-off";
  }
}

export function stateText(s: ControllerSnapshot): string {
  if (s.link === "lost") return "conexão perdida";
  if (s.link === "opening" || s.link === "waitingBanner") return "conectando…";
  if (s.link !== "connected") return "desconectado";
  const st = s.status ? stateLabel(s.status) : "…";
  return s.health === "stuck" ? `${st} · sem resposta` : s.health === "slow" ? `${st} · lento` : st;
}

/** Botão Conectar/Desconectar da barra superior + o estado da máquina. */
export function createConnectControls(session: MachineSession): HTMLElement {
  if (!session.available) {
    return h(
      "span",
      { class: "no-serial", title: "A Web Serial API só existe no Chrome e no Edge (desktop), em https ou localhost. Exportar .gcode continua funcionando." },
      "Envio direto: só no Chrome/Edge",
    );
  }
  const btn = h("button", { class: "connect-btn" });
  const other = h("button", { class: "connect-other", title: "Escolher outra porta serial" }, "▾");
  const estop = h(
    "button",
    {
      class: "estop",
      title: "Parada de emergência (Esc): reset imediato. Com a máquina andando, a posição se perde e é preciso refazer o Home.",
      onclick: () => session.controller?.emergencyStop(),
    },
    "⛔ Emergência",
  );
  let prevLink = session.snapshot.link;
  const badge = h("span", { class: "state-badge" });
  const sim = session.sim
    ? h("span", { class: "sim-tag", title: "?sim=1 na URL: um GRBL falso no lugar da máquina, para ensaiar sem a plotter." }, "SIMULADOR")
    : null;

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "error", 10000);
    }
  };
  btn.addEventListener("click", () => {
    const s = session.snapshot;
    if (s.link === "connected") void run(() => session.disconnect());
    else if (s.link === "disconnected" || s.link === "lost") void run(() => session.connect());
  });
  other.addEventListener("click", () => void run(() => session.connect({ choosePort: true })));

  const render = (s: ControllerSnapshot) => {
    const connecting = s.link === "opening" || s.link === "waitingBanner";
    if (s.link === "connected") {
      btn.textContent = "Desconectar";
      btn.disabled = session.jobActive;
      btn.title = session.jobActive ? "Pare o trabalho antes de desconectar." : `Conectado: ${s.transportLabel}`;
    } else if (connecting) {
      btn.textContent = "Conectando…";
      btn.disabled = true;
    } else {
      const name = session.portName;
      btn.textContent = name ? `Conectar (${name})` : "Conectar…";
      btn.disabled = false;
      btn.title = name
        ? "Conecta na porta usada da última vez. Feche o LaserGRBL antes."
        : "Abre o seletor de portas do Chrome (escolha o Arduino, ex.: COM6). Feche o LaserGRBL antes.";
    }
    btn.classList.toggle("primary", s.link !== "connected");
    other.hidden = !!session.sim || s.link === "connected" || connecting || !session.portName;
    badge.textContent = stateText(s);
    badge.className = `state-badge ${stateClass(s)}`;
    badge.hidden = s.link === "disconnected";
    estop.hidden = s.link !== "connected";
    if (s.link === "lost" && prevLink !== "lost") {
      toast(`${s.linkMessage ?? "A conexão caiu."} Reconectar reinicia a placa (a caneta sobe) e pede Home.`, "error", 15000);
    }
    prevLink = s.link;
  };
  session.subscribe(render);
  render(session.snapshot);
  return h("span", { class: "connect" }, sim, estop, btn, other, badge);
}

/**
 * Esc com a máquina andando (ou trabalho em andamento): parada de emergência. Num jog, só cancela o jog
 * (0x85), que para sem perder a posição. Escuta na captura, antes dos atalhos de edição.
 */
export function installEmergencyKey(session: MachineSession): void {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const s = session.snapshot;
      const c = session.controller;
      if (!c || s.link !== "connected" || document.querySelector("dialog[open]")) return;
      const st = s.status?.state;
      if (session.jobActive || st === "Run" || st === "Home" || st === "Hold") {
        c.emergencyStop();
        toast("Parada de emergência (Esc).", "error", 8000);
      } else if (st === "Jog") c.jogStop();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
}
