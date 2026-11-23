import { h } from "./dom";
import type { PlotView } from "./plotView";
import type { SoundKind } from "./sound";

/** O que os botões da tela de plotagem fazem (quem liga na máquina é o `main.ts`). */
export interface PlotActions {
  /** Para o desenho mantendo a posição (a caneta sobe) */
  stop(): void;
  /** Pausa, ou continua se estiver pausado */
  togglePause(): void;
  /** Depois de um erro numa linha, com a máquina parada: segue da linha seguinte */
  continueAfterError(): void;
  feed(change: "minus" | "reset" | "plus"): void;
  /** Corta tudo na hora (a posição se perde) */
  emergency(): void;
  /** "Voltar para a mesa", depois que o trabalho acabou */
  dismiss(): void;
}

export interface PlotScreen {
  readonly el: HTMLElement;
  readonly visible: boolean;
  /** Mostra o momento atual do trabalho; `undefined` esconde a tela. */
  show(view: PlotView | undefined): void;
}

interface SoundPrefs {
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  play(kind: SoundKind): boolean;
}

/**
 * A tela que toma o lugar do painel lateral enquanto a máquina desenha: o que está sendo feito, quanto já
 * foi, quanto falta e um botão de parar que não dá para errar. Nada aqui edita o desenho, e o resto do
 * programa fica travado até o trabalho acabar e alguém clicar em "Voltar para a mesa".
 */
export function createPlotScreen(actions: PlotActions, sounds: SoundPrefs): PlotScreen {
  const title = h("h2", { class: "plot-title" });
  const name = h("p", { class: "plot-name" });
  const detail = h("p", { class: "plot-detail", hidden: true });

  const percent = h("div", { class: "plot-percent" });
  const fill = h("div", { class: "plot-bar-fill" });
  const bar = h("div", { class: "plot-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": "Quanto do desenho já foi feito" }, fill);
  const elapsed = h("dd", { class: "plot-elapsed" });
  const remaining = h("dd", { class: "plot-remaining" });
  const remainingLabel = h("dt", { class: "plot-remaining-label" }, "Falta");
  const lines = h("p", { class: "plot-lines" });

  const note = h("p", { class: "plot-note", hidden: true });

  const errTitle = h("strong", null);
  const errLine = h("code", { class: "err-line" });
  const errAction = h("span", null);
  const errContinue = h("button", { title: "A placa já pulou essa linha; continua da próxima.", onclick: () => actions.continueAfterError() }, "Continuar mesmo assim");
  const error = h("div", { class: "plot-error", role: "alert", hidden: true }, errTitle, errLine, errAction, errContinue);

  const stop = h(
    "button",
    { class: "plot-stop", title: "Para o desenho. A caneta sobe e a máquina guarda a posição.", onclick: () => actions.stop() },
    h("span", { class: "plot-stop-mark", "aria-hidden": "true" }),
    "Parar",
  );
  const pause = h("button", { class: "plot-pause", onclick: () => actions.togglePause() });
  const speedValue = h("span", { class: "plot-speed-value" });
  const speed = h(
    "div",
    { class: "plot-speed" },
    h("span", { class: "plot-speed-label" }, "Velocidade ", speedValue),
    h("button", { title: "10% mais devagar", onclick: () => actions.feed("minus") }, "−10%"),
    h("button", { title: "Volta para a velocidade normal", onclick: () => actions.feed("reset") }, "100%"),
    h("button", { title: "10% mais rápido", onclick: () => actions.feed("plus") }, "+10%"),
  );
  const estop = h(
    "button",
    {
      class: "plot-estop",
      title: "Corta tudo na hora. Se a máquina estava andando, a posição se perde e é preciso refazer o Home.",
      onclick: () => actions.emergency(),
    },
    "Emergência (tecla Esc)",
  );
  // O Parar vem logo depois do progresso e não sai do lugar: os avisos (pausa, erro numa linha) aparecem
  // ABAIXO dele. Se viessem antes, empurrariam o botão para fora da tela justamente quando há um problema.
  const running = h(
    "div",
    { class: "plot-actions" },
    stop,
    h("p", { class: "plot-stop-hint" }, "A caneta sobe e a posição fica guardada: dá para retomar depois."),
    pause,
    note,
    error,
    speed,
    estop,
  );

  const message = h("p", { class: "plot-message", hidden: true });
  const resume = h("p", { class: "plot-resume", hidden: true });
  const next = h("p", { class: "plot-next", hidden: true });
  const back = h("button", { class: "plot-back", onclick: () => actions.dismiss() }, "Voltar para a mesa");
  const result = h("div", { class: "plot-result", hidden: true }, message, resume, next, back);

  const soundBox = h("input", { type: "checkbox", checked: sounds.enabled });
  soundBox.addEventListener("change", () => {
    sounds.setEnabled(soundBox.checked);
    if (soundBox.checked) sounds.play("done"); // ligou: ouve como é
  });
  const lockText = h("p", { class: "plot-lock" });

  const el = h(
    "aside",
    { class: "plot-screen", "aria-label": "Plotagem", hidden: true },
    h("header", { class: "plot-head" }, title, name, detail),
    h(
      "div",
      { class: "plot-meter" },
      percent,
      bar,
      h("dl", { class: "plot-times" }, h("div", null, h("dt", null, "Decorrido"), elapsed), h("div", null, remainingLabel, remaining)),
      lines,
    ),
    running,
    result,
    h("footer", { class: "plot-foot" }, h("label", { class: "check plot-sound" }, soundBox, "Tocar um som quando terminar"), lockText),
  );

  const setText = (node: HTMLElement, text: string | undefined) => {
    const t = text ?? "";
    if (node.textContent !== t) node.textContent = t;
    return node;
  };
  /** Texto opcional: sem texto, o elemento some. */
  const optional = (node: HTMLElement, text: string | undefined) => {
    setText(node, text).hidden = !text;
  };

  let visible = false;
  let wasActive: boolean | undefined;

  function show(v: PlotView | undefined): void {
    visible = !!v;
    el.hidden = !v;
    if (!v) {
      wasActive = undefined;
      return;
    }
    for (const c of [...el.classList]) if (c.startsWith("tone-") && c !== `tone-${v.tone}`) el.classList.remove(c);
    el.classList.add(`tone-${v.tone}`);

    setText(title, v.title);
    setText(name, v.name);
    optional(detail, v.detail);

    setText(percent, v.percent);
    const pct = Math.round(v.frac * 1000) / 10;
    fill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    setText(elapsed, v.elapsed);
    // em andamento: quanto falta; depois: quanto era o estimado
    setText(remainingLabel, v.active ? "Falta" : "Estimado");
    setText(remaining, v.active ? `~${v.remaining ?? ""}` : v.estimated);
    setText(lines, v.lines);

    optional(note, v.note);

    error.hidden = !v.error;
    if (v.error) {
      setText(errTitle, v.error.title);
      setText(errLine, v.error.text);
      setText(errAction, v.error.action);
      errContinue.disabled = !v.error.canContinue;
    }

    running.hidden = !v.active;
    stop.disabled = v.stopDisabled;
    setText(pause, v.pause.label);
    pause.title = v.pause.title;
    pause.disabled = v.pause.disabled;
    pause.hidden = v.pause.hidden;
    setText(speedValue, `${v.feedPct}%`);

    result.hidden = v.active;
    optional(message, v.message);
    optional(resume, v.resume);
    optional(next, v.next);

    setText(lockText, v.active ? "A mesa fica travada enquanto a máquina desenha. Dá para aproximar e mover a vista." : "A mesa continua travada até você voltar para ela.");
    if (soundBox.checked !== sounds.enabled && document.activeElement !== soundBox) soundBox.checked = sounds.enabled;

    // terminou: o botão de voltar recebe o foco (Enter fecha). Durante o trabalho nenhum botão é focado
    // sozinho: um Enter ou espaço distraído não pode parar o desenho.
    if (wasActive === true && !v.active) back.focus();
    wasActive = v.active;
  }

  return {
    el,
    get visible() {
      return visible;
    },
    show,
  };
}
