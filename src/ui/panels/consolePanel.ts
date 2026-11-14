import { classifyManualCommand } from "../../core/grbl/commands";
import type { LogEntry } from "../../core/grbl/controller";
import { RT } from "../../core/grbl/protocol";
import { loadUiPrefs, saveUiPrefs } from "../../storage/uiPrefs";
import { clear, h } from "../dom";
import type { MachineSession } from "../machine/session";

const MAX_ENTRIES = 2000;
const ARROW: Record<LogEntry["dir"], string> = { in: "←", out: "→", info: "•", error: "⚠" };
const pad = (n: number) => String(n).padStart(2, "0");
const clock = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

interface Row extends LogEntry {
  readonly time: string;
}

export interface ConsolePanel {
  readonly toggleButton: HTMLButtonElement;
  setOpen(open: boolean): void;
}

/**
 * Console recolhível (embaixo): log da serial com filtro (relatórios de estado escondidos por padrão),
 * campo de comando com histórico (↑/↓). `$32=1` e bytes fora de ASCII são recusados; o que grava na
 * EEPROM ($N=, $RST=, G10...) pede confirmação.
 */
export function createConsole(session: MachineSession, host: HTMLElement): ConsolePanel {
  const prefs = loadUiPrefs();
  const entries: Row[] = [];
  let pending: Row[] = [];
  let showStatus = prefs.consoleShowStatus;
  let showNextStatus = false;
  const history: string[] = [];
  let histPos = 0;

  const logEl = h("div", { class: "console-log", role: "log", "aria-live": "off" });
  const input = h("input", { type: "text", class: "console-input", placeholder: "Comando para o GRBL ($$, $#, $G, G0 X10 Y10...). Enter envia.", spellcheck: false, autocomplete: "off" });
  const statusCheck = h("input", { type: "checkbox", checked: showStatus });
  const quick = ["$$", "$#", "$G", "$I", "?"].map((c) => h("button", { title: `Enviar ${c}`, onclick: () => void submit(c) }, c));
  const clearBtn = h("button", { title: "Limpar o log", onclick: () => ((entries.length = 0), (pending = []), clear(logEl)) }, "Limpar");
  const closeBtn = h("button", { class: "console-close", title: "Fechar o console", onclick: () => setOpen(false) }, "✕");

  clear(host);
  host.append(
    h(
      "div",
      { class: "console-bar" },
      h("strong", null, "Console"),
      h("label", { class: "check" }, statusCheck, "relatórios de estado"),
      h("span", { class: "spacer" }),
      ...quick,
      clearBtn,
      closeBtn,
    ),
    logEl,
    h("div", { class: "console-cmd" }, h("span", { class: "console-prompt" }, ">"), input),
  );

  const visible = (r: LogEntry) => showStatus || !r.status;
  const rowEl = (r: Row) => h("div", { class: `log-${r.dir}${r.status ? " log-status" : ""}` }, h("span", { class: "log-time" }, r.time), ` ${ARROW[r.dir]} ${r.text}`);

  let raf = 0;
  const flush = () => {
    raf = 0;
    if (host.hidden) return;
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
    const frag = document.createDocumentFragment();
    for (const r of pending) if (visible(r)) frag.append(rowEl(r));
    pending = [];
    logEl.append(frag);
    while (logEl.childElementCount > MAX_ENTRIES) logEl.firstElementChild?.remove();
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  };
  const rebuild = () => {
    clear(logEl);
    pending = entries.slice();
    flush();
  };

  const add = (e: LogEntry) => {
    let entry = e;
    if (e.status && showNextStatus) {
      showNextStatus = false;
      entry = { ...e, status: false }; // o "?" pedido à mão aparece mesmo com o filtro
    }
    const r: Row = { ...entry, time: clock() };
    entries.push(r);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    pending.push(r);
    if (!raf && !host.hidden) raf = requestAnimationFrame(flush);
  };
  session.onLog(add);
  const local = (dir: LogEntry["dir"], text: string) => add({ at: performance.now(), dir, text });

  async function submit(raw: string) {
    const line = raw.trim();
    if (!line) return;
    if (history[history.length - 1] !== line) history.push(line);
    histPos = history.length;
    const c = session.controller;
    if (!c || session.snapshot.link !== "connected") return local("error", "A máquina não está conectada.");
    // um caractere de tempo real sozinho vai como tempo real
    const rt = { "?": RT.STATUS, "!": RT.HOLD, "~": RT.RESUME }[line];
    if (rt !== undefined) {
      if (rt === RT.STATUS) {
        showNextStatus = true;
        local("out", "?");
      }
      c.realtime(rt);
      return;
    }
    const check = classifyManualCommand(line);
    if (check.kind === "blocked") return local("error", `Recusado: ${check.reason}`);
    if (check.kind === "confirm" && !confirm(`${check.reason}\n\nEnviar "${line}" para o GRBL?`)) return local("info", `Cancelado: ${line}`);
    try {
      await c.send(line, { manual: true });
    } catch (e) {
      local("error", e instanceof Error ? e.message : String(e));
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = input.value;
      input.value = "";
      void submit(v);
    } else if (e.key === "ArrowUp") {
      if (histPos > 0) input.value = history[--histPos] ?? "";
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      histPos = Math.min(history.length, histPos + 1);
      input.value = history[histPos] ?? "";
      e.preventDefault();
    } else if (e.key === "Escape") input.blur();
  });
  statusCheck.addEventListener("change", () => {
    showStatus = statusCheck.checked;
    saveUiPrefs({ consoleShowStatus: showStatus });
    rebuild();
  });

  const toggleButton = h("button", { class: "console-toggle", title: "Log da serial e comandos manuais" }, "Console");
  function setOpen(open: boolean) {
    host.hidden = !open;
    toggleButton.classList.toggle("on", open);
    saveUiPrefs({ consoleOpen: open });
    if (open) {
      rebuild();
      logEl.scrollTop = logEl.scrollHeight;
    }
    window.dispatchEvent(new Event("resize")); // o canvas muda de altura
  }
  toggleButton.addEventListener("click", () => setOpen(host.hidden !== false));
  setOpen(prefs.consoleOpen);
  return { toggleButton, setOpen };
}
