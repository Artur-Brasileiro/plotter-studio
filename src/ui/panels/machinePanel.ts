import { describeAlarm } from "../../core/grbl/codes";
import type { ControllerSnapshot } from "../../core/grbl/controller";
import { clear, fmtMm, h, toast } from "../dom";
import { stateClass, stateText } from "../machine/connectControls";
import type { MachineSession } from "../machine/session";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Roda uma ação da máquina e mostra o erro (traduzido pelo controlador) num aviso. */
export async function machineAction(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    toast(errMsg(e), "error", 10000);
  }
}

/** O estado permite movimento manual (jog, caneta, origem)? */
export function canMoveManually(s: ControllerSnapshot, jobActive: boolean): boolean {
  const st = s.status?.state;
  return s.link === "connected" && !jobActive && !s.busy && (st === "Idle" || st === "Jog");
}

/**
 * Aba "Máquina", parte de cima: estado em cores, posição, velocidade, override, fins de curso,
 * botões (Home, Desbloquear, Ir para a origem, Caneta ↑/↓, Reset) e avisos de configuração.
 */
export function createMachinePanel(session: MachineSession): HTMLElement {
  const ctrl = () => session.controller!;
  const badge = h("span", { class: "state-badge big" });
  const conn = h("span", { class: "hint" });
  const pos = h("div", { class: "machine-pos" });
  const details = h("dl", { class: "stats" });
  const alarmBox = h("div", { class: "notice alarm" });
  const warnBox = h("div", { class: "notice" });
  const offline = h(
    "p",
    { class: "hint" },
    session.available
      ? "Conecte a máquina pelo botão no topo. Feche antes o LaserGRBL e o monitor serial do Arduino: só um programa usa a porta de cada vez."
      : "O envio direto usa a Web Serial, que só existe no Chrome e no Edge. Aqui dá para compor e exportar o .gcode.",
  );

  const btn = (label: string, title: string, fn: () => Promise<void> | void, cls = "") =>
    h("button", { class: cls, title, onclick: () => void machineAction(fn) }, label);
  const homeBtn = btn("⌂ Home", "$H: procura os fins de curso e zera a posição. Obrigatório antes de desenhar.", () => ctrl().home(), "primary");
  const unlockBtn = btn("Desbloquear", "$X: tira o alarme sem Home. O jog funciona, mas desenhar continua exigindo Home.", async () => {
    if (!confirm("Desbloquear sem Home?\n\nA posição pode estar errada: o jog funciona, mas para desenhar o Plotter Studio continua exigindo o Home.")) return;
    await ctrl().unlock();
  });
  const originBtn = btn("Ir para a origem", "Levanta a caneta e vai para (0, 0), o canto da frente à esquerda.", () => ctrl().goToOrigin());
  const upBtn = btn("Caneta ↑", "M5 + pausa do servo", () => ctrl().penUp());
  const downBtn = btn("Caneta ↓", "M3 S220 + pausa do servo (teste do servo)", () => ctrl().penDown());
  const stopBtn = btn("■ Parar", "Para o movimento (Home, contorno, ir para a origem) mantendo a posição.", () => ctrl().stop());
  const resetBtn = btn("Reset", "Ctrl-X: reinicia o GRBL. Com a máquina andando, a posição se perde (ALARM:3).", () => ctrl().softReset());

  const settingsList = h("pre", { class: "settings-dump" });
  const settingsDetails = h("details", null, h("summary", null, "Configuração do GRBL ($$)"), settingsList);

  const controls = h(
    "div",
    { class: "panel-section" },
    h("div", { class: "row" }, homeBtn, unlockBtn, originBtn),
    h("div", { class: "row" }, upBtn, downBtn, stopBtn, resetBtn),
  );
  const root = h(
    "div",
    { class: "panel-section" },
    h("h3", null, "Máquina"),
    h("div", { class: "row center" }, badge, conn),
    offline,
    pos,
    details,
    alarmBox,
    controls,
    warnBox,
    settingsDetails,
  );

  let lastSettings: ReadonlyMap<number, string> | undefined;
  const render = (s: ControllerSnapshot) => {
    const on = s.link === "connected";
    badge.textContent = stateText(s);
    badge.className = `state-badge big ${stateClass(s)}`;
    conn.textContent = on ? s.transportLabel : s.linkMessage ?? "";
    offline.hidden = on;
    pos.hidden = details.hidden = controls.hidden = !on;
    const st = s.status?.state;
    const job = session.jobActive;

    if (on) {
      const w = s.wpos;
      pos.textContent = w ? `X ${fmtMm(w.x, 2)}   Y ${fmtMm(w.y, 2)} mm` : "X —   Y —";
      clear(details);
      const row = (k: string, v: string) => details.append(h("dt", null, k), h("dd", null, v));
      row("Velocidade", s.status?.feed !== undefined ? `${Math.round(s.status.feed)} mm/min` : "—");
      if (s.status?.overrides) row("Override", `${s.status.overrides.feed}%`);
      row("Caneta", s.status?.spindle ? "embaixo" : "em cima");
      row("Home", s.homed ? "feito" : "falta");
      if (s.status?.pins) row("Fins de curso", s.status.pins);
    }

    alarmBox.hidden = !(on && (s.alarm !== undefined || s.needsReset || (st === "Alarm" && !s.homed)));
    if (!alarmBox.hidden) {
      clear(alarmBox);
      if (s.alarm !== undefined) {
        const a = describeAlarm(s.alarm);
        alarmBox.append(h("strong", null, `ALARM:${s.alarm} — ${a.title}`), h("br"), a.action);
      } else if (s.needsReset) alarmBox.append("O GRBL está travado esperando um reset: clique em Reset e depois em Home.");
      else alarmBox.append("A placa liga em alarme até o Home: clique em ⌂ Home (a máquina vai até os fins de curso, atrás à direita).");
    }

    const idleish = st === "Idle" || st === "Jog";
    homeBtn.disabled = !on || job || !!s.busy || !(st === "Idle" || st === "Alarm");
    unlockBtn.disabled = !on || job || !!s.busy || st !== "Alarm" || s.needsReset;
    originBtn.disabled = !on || job || !!s.busy || !idleish || !s.homed;
    originBtn.title = s.homed ? "Levanta a caneta e vai para (0, 0), o canto da frente à esquerda." : "Faça o Home antes: sem ele a posição não é confiável.";
    upBtn.disabled = downBtn.disabled = !on || job || !!s.busy || st !== "Idle";
    stopBtn.hidden = !s.busy;
    stopBtn.disabled = !on;
    resetBtn.disabled = !on || job;

    warnBox.hidden = !(on && s.settingsWarnings.length);
    if (!warnBox.hidden) {
      clear(warnBox);
      warnBox.append(
        h("strong", null, "A configuração do GRBL não bate com o perfil:"),
        h("ul", null, ...s.settingsWarnings.map((w) => h("li", null, w))),
        h("span", { class: "hint" }, "Nada é corrigido automaticamente. Confira em ⚙ Configurações ou, se for a placa que está errada, corrija pelo console."),
      );
    }
    settingsDetails.hidden = !on || s.settings.size === 0;
    if (s.settings !== lastSettings) {
      lastSettings = s.settings;
      settingsList.textContent = [...s.settings.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([k, v]) => `$${k}=${v}`)
        .join("\n");
    }
  };

  // até 5 relatórios por segundo: desenha no máximo uma vez por quadro
  let raf = 0;
  session.subscribe(() => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render(session.snapshot)));
  });
  render(session.snapshot);
  return root;
}
