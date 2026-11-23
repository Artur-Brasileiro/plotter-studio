import { isJobActive, type ControllerSnapshot, type JobState } from "../../core/grbl/controller";
import { RT } from "../../core/grbl/protocol";
import { bboxOfPoints } from "../../core/geometry/path";
import type { GcodeProgram } from "../../core/job/gcode";
import { REGISTRATION_ID } from "../../core/job/layers";
import { parseWhat, planSignature, resumeDescent, sendSpan, type SendWhat } from "../../core/job/resume";
import type { JobPlan } from "../../core/job/types";
import type { Store } from "../../core/store";
import { addRun, loadRuns, type RunRecord } from "../../storage/runsStore";
import { clear, h, toast } from "../dom";
import type { MachineSession } from "../machine/session";
import type { Overlay } from "../overlay";
import { fmtDuration, type Planner } from "../planner";
import type { PlotActions } from "../plotScreen";
import { plotView, type PlotView } from "../plotView";
import { createLayerPicker } from "./layerPicker";
import { machineAction } from "./machinePanel";

interface ActiveJob {
  readonly plan: JobPlan;
  readonly program: GcodeProgram;
  /** Nome no histórico (com a camada e a parte) */
  readonly name: string;
  /** Nome na tela de plotagem (a camada aparece numa linha própria) */
  readonly screenName: string;
  /** tempo estimado (s) em que este envio começa e termina, dentro do plano inteiro */
  readonly t0: number;
  readonly t1: number;
  /** tempo estimado (s) da posição atual, para a barra e o "restante" */
  estAt: number;
  recorded: boolean;
  /** O envio vai até o fim da camada (tudo, a última parte ou uma retomada): ao terminar, a próxima camada é a vez */
  readonly wholeLayer: boolean;
  /** Último traço em que a máquina esteve (índice em plan.strokes), para saber de onde retomar */
  lastStroke: number;
  /** O que foi enviado: tudo, uma parte, ou uma retomada */
  readonly kind: SendWhat["kind"];
  /** Preenchidos quando o trabalho acaba: a próxima camada, se acabaram todas, e se dá para retomar */
  next?: { readonly index: number; readonly penName: string };
  allLayersDone?: boolean;
  canResume?: boolean;
}

const RESULT_TEXT: Record<RunRecord["result"], string> = { finished: "concluído", stopped: "parado", failed: "falhou" };

interface ResumePoint {
  readonly sig: string;
  readonly descent: number;
}
const RESUME_KEY = "plotter-studio.resume.v1";

function loadResume(): ResumePoint | undefined {
  try {
    const r = JSON.parse(localStorage.getItem(RESUME_KEY) ?? "null") as ResumePoint | null;
    return r && typeof r.sig === "string" && Number.isInteger(r.descent) && r.descent >= 0 ? r : undefined;
  } catch {
    return undefined;
  }
}

function saveResume(r: ResumePoint | undefined): void {
  try {
    if (r) localStorage.setItem(RESUME_KEY, JSON.stringify(r));
    else localStorage.removeItem(RESUME_KEY);
  } catch {
    /* sem armazenamento: a retomada só vale até fechar a página */
  }
}

/** Retângulo do desenho em mm da máquina (para o contorno). As cruzes de registro ficam de fora: o contorno mostra onde o DESENHO cai. */
export function planBBox(plan: JobPlan) {
  const body = plan.strokes.filter((s) => s.drawingId !== REGISTRATION_ID);
  return bboxOfPoints((body.length ? body : plan.strokes).flatMap((s) => s.points));
}

export interface SendPanel {
  readonly el: HTMLElement;
  /** Há trabalho na máquina: a pré-visualização mostra o plano dele, não o da mesa. */
  readonly active: () => boolean;
  /** O que os botões da tela de plotagem fazem na máquina */
  readonly actions: PlotActions;
}

/** Avisos para quem mostra o trabalho em andamento (a tela de plotagem e o som). */
export interface SendHooks {
  /** O momento atual do trabalho. `undefined`: não há trabalho na tela (nunca houve, ou já voltaram para a mesa). */
  onView?(view: PlotView | undefined): void;
  /** O trabalho acabou de ir para a máquina. Chamado dentro do clique em Enviar: é quando o som pode ser preparado. */
  onStart?(): void;
  /** O trabalho acabou. Chamado mesmo com a janela escondida. */
  onEnd?(result: "finished" | "stopped" | "failed"): void;
}

/**
 * Passo "Plotar", parte do envio: Contorno e Enviar (com as pré-condições na tela), e o acompanhamento do
 * trabalho: onde a máquina está, Wake Lock, confirmação ao fechar a aba, de onde retomar e o registro do
 * tempo real × estimado. O que se VÊ durante o trabalho (progresso, Parar, Pausar) fica na tela de plotagem
 * (`plotScreen.ts`): este painel entrega a ela o momento atual pelos `hooks` e as ações em `actions`.
 */
export function createSendPanel(session: MachineSession, store: Store, planner: Planner, overlay: Overlay, hooks: SendHooks = {}): SendPanel {
  let job: ActiveJob | undefined;
  let wake: WakeLockSentinel | undefined;
  let lastState: JobState = "none";
  let resumePoint = loadResume();
  /** A tela de plotagem: fechada, acompanhando o trabalho, ou mostrando como ele terminou (até "Voltar para a mesa") */
  let screen: "none" | "live" | "ended" = "none";
  let endedView: PlotView | undefined;
  /** "Mostrar o caminho" estava ligado antes do envio? (o envio liga; no fim volta ao que era) */
  let pathWasVisible = false;

  const frameBtn = h("button", { title: "Percorre o retângulo do desenho com a caneta levantada, para conferir a posição no papel." }, "▭ Contorno");
  const sendBtn = h("button", { class: "primary" }, "▶ Enviar desenho");
  const partSelect = h("select", { "aria-label": "O que enviar" });
  const partRow = h("label", { class: "field" }, "O que enviar", partSelect);
  const resumeHint = h("p", { class: "hint", hidden: true });
  const reasons = h("ul", { class: "reasons" });
  const resultBox = h("div", { class: "notice" });
  /** Depois de uma camada: qual é a próxima e o que trocar */
  const nextBox = h("div", { class: "notice next-layer", hidden: true });
  const layerPicker = createLayerPicker(planner, { title: "Camada a enviar", disabled: () => session.jobActive });
  const runsList = h("table", { class: "runs" });
  const runsDetails = h("details", null, h("summary", null, "Últimos trabalhos (real × estimado)"), runsList);

  const el = h(
    "div",
    { class: "panel-section" },
    h("h3", null, "Enviar"),
    layerPicker,
    nextBox,
    partRow,
    resumeHint,
    h("div", { class: "row" }, frameBtn, sendBtn),
    reasons,
    resultBox,
    runsDetails,
  );

  function feed(cmd: number) {
    try {
      session.controller?.feedOverride(cmd);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  const actions: PlotActions = {
    // para mantendo a posição: pausa, espera parar e reinicia a placa (a caneta sobe)
    stop: () => {
      const c = session.controller;
      if (c) void machineAction(() => c.stop());
    },
    togglePause: () => {
      const c = session.controller;
      const st = session.snapshot.job.state;
      if (!c) return;
      if (st === "running") c.pause();
      else if (st === "paused") c.resume();
    },
    // erro numa linha: a placa já pulou a linha; continua da próxima
    continueAfterError: () => session.controller?.resume(),
    feed: (change) => feed(change === "minus" ? RT.FEED_MINUS_10 : change === "plus" ? RT.FEED_PLUS_10 : RT.FEED_RESET),
    emergency: () => session.controller?.emergencyStop(),
    dismiss: () => {
      if (screen !== "ended") return; // com o trabalho na máquina a tela não sai
      screen = "none";
      endedView = undefined;
      hooks.onView?.(undefined);
      render(session.snapshot);
    },
  };

  // ---------------------------------------------------------------- ações
  frameBtn.addEventListener("click", () => {
    const plan = planner.fresh();
    const c = session.controller;
    if (!plan || !c) return;
    void machineAction(() => c.frame(planBBox(plan)));
  });

  /** O ponto de retomada guardado, se ele ainda vale para este plano. */
  const resumeFor = (plan: JobPlan | undefined) => (plan && resumePoint && resumePoint.sig === planSignature(plan) && resumePoint.descent < plan.descents.length ? resumePoint : undefined);

  function renderParts(plan: JobPlan | undefined, select?: string) {
    const total = plan?.stats.parts ?? 1;
    const checkpoints = plan ? plan.descents.map((d, i) => ({ d, i })).filter((x) => x.d.checkpoint !== undefined) : [];
    const rp = resumeFor(plan);
    partRow.hidden = total <= 1 && checkpoints.length === 0 && !rp;
    const prev = select ?? partSelect.value;
    const dur = (what: SendWhat) => {
      const s = sendSpan(plan!, what);
      return fmtDuration(s.t1 - s.t0);
    };
    clear(partSelect);
    const whole = (plan?.layer?.count ?? 1) > 1 ? "Camada inteira" : "Desenho inteiro";
    partSelect.append(h("option", { value: "" }, `${whole} (~${fmtDuration(plan?.stats.estimate.totalS ?? 0)})`));
    if (plan && rp) {
      partSelect.append(h("option", { value: `r${rp.descent}` }, `Retomar de onde parou: descida ${rp.descent + 1} de ${plan.descents.length} (~${dur({ kind: "resume", from: rp.descent })})`));
    }
    if (plan && total > 1) {
      const g = h("optgroup", { label: "Uma parte de cada vez" });
      for (let p = 0; p < total; p++) g.append(h("option", { value: `p${p}` }, `Parte ${p + 1} de ${total} (~${dur({ kind: "part", part: p })})`));
      partSelect.append(g);
    }
    if (plan && checkpoints.length) {
      const g = h("optgroup", { label: "Retomar de um checkpoint até o fim" });
      for (const { d, i } of checkpoints) {
        if (rp?.descent === i) continue;
        g.append(h("option", { value: `r${i}` }, `Do checkpoint ${d.checkpoint} (~${d.checkpointMin ?? 0} min) em diante (~${dur({ kind: "resume", from: i })})`));
      }
      partSelect.append(g);
    }
    partSelect.value = [...partSelect.options].some((o) => o.value === prev) ? prev : "";
    renderResumeHint();
  }

  function renderResumeHint() {
    const what = parseWhat(partSelect.value);
    resumeHint.hidden = what.kind !== "resume" || partRow.hidden;
    resumeHint.textContent =
      "A retomada refaz o aquecimento do servo" +
      (planner.plan?.layer?.registration ? ", desenha de novo a cruz de registro (tem que cair em cima da que já está no papel: se não cair, pare)" : "") +
      " e continua daí até o fim. Não mexa no papel. Se a máquina perdeu a posição, faça o Home antes.";
  }
  partSelect.addEventListener("change", renderResumeHint);

  sendBtn.addEventListener("click", () => {
    const c = session.controller;
    const plan = planner.fresh();
    if (!c || !plan) return;
    if (plan.violations.length) return toast("Há desenho fora da folha: corrija antes de enviar.", "error");
    // arquivo que quebra regra não vai para a máquina (docs/REGRAS_GCODE.md)
    const review = planner.review();
    if (!review?.audit?.ok) return toast("A conferência reprovou este G-code. Veja o passo 2.", "error", 9000);
    const what = parseWhat(partSelect.value);
    let program: GcodeProgram;
    try {
      program = what.kind === "all" ? review.program! : planner.program(what.kind === "part" ? { part: what.part } : { fromDescent: what.from }, plan)!;
      // uma parte ou uma retomada é outro arquivo: passa pela mesma conferência antes de ir
      if (what.kind !== "all" && !planner.audit(program, plan).ok) return toast("A conferência reprovou este arquivo. Envie a camada inteira ou escolha outro ponto.", "error", 9000);
      c.startJob(program);
    } catch (e) {
      return toast(e instanceof Error ? e.message : String(e), "error", 10000);
    }
    const layer = plan.layer;
    const name = (planner.jobName(plan) || "desenho") + (layer && layer.count > 1 ? ` [${layer.index + 1}/${layer.count} ${layer.penName}]` : "");
    const suffix = what.kind === "part" ? ` (parte ${what.part + 1} de ${plan.stats.parts})` : what.kind === "resume" ? " (retomada)" : "";
    const label = what.kind === "part" ? `${name} (parte ${what.part + 1})` : what.kind === "resume" ? `${name} (retomada)` : name;
    job = {
      plan,
      program,
      name: label,
      screenName: (planner.jobName(plan) || "desenho") + suffix,
      ...sendSpan(plan, what),
      estAt: 0,
      recorded: false,
      wholeLayer: what.kind !== "part" || what.part === plan.stats.parts - 1,
      lastStroke: -1,
      kind: what.kind,
    };
    nextBox.hidden = true;
    pathWasVisible = overlay.isVisible;
    overlay.setPlan(plan, store.state.job.speedMode === "fixed");
    overlay.setVisible(true);
    void lockScreen();
    screen = "live";
    endedView = undefined;
    hooks.onStart?.();
    render(session.snapshot);
  });

  // ---------------------------------------------------------------- tela acesa e fechar a aba
  async function lockScreen() {
    try {
      if (!wake && navigator.wakeLock && document.visibilityState === "visible") {
        wake = await navigator.wakeLock.request("screen");
        wake.addEventListener("release", () => (wake = undefined));
      }
    } catch {
      /* sem permissão: segue sem */
    }
  }
  const unlockScreen = () => {
    void wake?.release().catch(() => {});
    wake = undefined;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && session.jobActive) void lockScreen();
  });
  window.addEventListener("beforeunload", (e) => {
    if (session.jobActive) {
      e.preventDefault();
      e.returnValue = ""; // o Chrome mostra a própria pergunta "Sair do site?"
    }
  });

  // ---------------------------------------------------------------- progresso
  /** Linha atual do programa → traço e ponto (num deslocamento, o começo do próximo traço). */
  function progressPoint(program: GcodeProgram, line: number | undefined) {
    if (line === undefined) return undefined;
    const lines = program.lines;
    for (let i = line; i < lines.length; i++) {
      const l = lines[i];
      if (l.strokeIndex >= 0) return { strokeIndex: l.strokeIndex, pointIndex: i === line ? (l.pointIndex ?? 0) : 0 };
    }
    return undefined;
  }

  /** Marca na mesa até onde a máquina já desenhou, e anota o tempo estimado desse ponto. */
  function trackProgress(s: ControllerSnapshot) {
    const j = s.job;
    if (!job || !isJobActive(j.state)) return;
    const total = job.t1 - job.t0;
    const at = progressPoint(job.program, j.currentLine);
    if (at && at.strokeIndex > job.lastStroke) job.lastStroke = at.strokeIndex;
    const t = overlay.setProgress(at);
    if (t !== undefined) job.estAt = Math.max(job.estAt, Math.min(total, t - job.t0));
  }

  /** O momento atual do trabalho, como a tela de plotagem mostra. */
  function viewOf(s: ControllerSnapshot): PlotView | undefined {
    if (!job || s.job.state === "none") return undefined;
    const layer = job.plan.layer;
    return plotView(
      {
        job: s.job,
        name: job.screenName,
        estTotalS: job.t1 - job.t0,
        estAtS: job.estAt,
        penDown: (s.status?.spindle ?? 0) > 0,
        feedPct: s.status?.overrides?.feed ?? 100,
        pauseLift: store.state.profile.pen.pauseLift,
        layer: layer ? { index: layer.index, count: layer.count, penName: layer.penName } : undefined,
        next: job.next,
        allLayersDone: job.allLayersDone,
        canResume: job.canResume,
      },
      performance.now(),
    );
  }

  /** Entrega o momento atual à tela de plotagem (depois do fim, o retrato de como terminou). */
  function publish(s: ControllerSnapshot) {
    if (screen === "none") return;
    const v = screen === "ended" ? endedView : viewOf(s);
    if (v) hooks.onView?.(v);
  }

  function finish(s: ControllerSnapshot) {
    if (!job || job.recorded) return;
    const j = s.job;
    if (j.state !== "finished" && j.state !== "stopped" && j.state !== "failed") return;
    job.recorded = true;
    unlockScreen();
    const realS = j.startedAt !== undefined && j.endedAt !== undefined ? (j.endedAt - j.startedAt - j.pausedMs) / 1000 : 0;
    const est = job.t1 - job.t0;
    addRun({ at: new Date().toISOString(), name: job.name, estimatedS: est, realS, result: j.state, lines: j.total });
    renderRuns();
    overlay.setProgress(undefined);
    // parou no meio: guarda de onde retomar (vale enquanto o desenho e os ajustes forem os mesmos)
    const sig = planSignature(job.plan);
    const forget = () => {
      if (resumePoint?.sig === sig) {
        saveResume((resumePoint = undefined));
        if (planner.plan === job!.plan) renderParts(job!.plan, "");
      }
    };
    if (j.state === "finished") forget(); // terminou o que foi pedido: o ponto antigo não vale mais
    else {
      const from = resumeDescent(job.plan, job.lastStroke);
      if (from !== undefined) {
        resumePoint = { sig, descent: from };
        saveResume(resumePoint);
        if (planner.plan === job.plan) renderParts(job.plan, `r${from}`);
      } else if (job.kind !== "resume") forget(); // recomeçou do início e parou antes de desenhar: idem
      // (uma retomada interrompida ainda no aquecimento deixa o ponto guardado como estava)
    }
    job.canResume = j.state !== "finished" && resumeFor(job.plan) !== undefined;
    if (j.state === "finished") {
      const done = job.plan.layer;
      // a vez da próxima caneta: a lista já aponta para ela
      const next = done && job.wholeLayer ? planner.layers.find((p) => p.layer?.index === done.index + 1) : undefined;
      if (done && next?.layer) {
        job.next = { index: next.layer.index, penName: next.layer.penName };
        planner.setLayer(next.layer.penId);
        clear(nextBox);
        nextBox.append(
          h("strong", null, `Agora a camada ${next.layer.index + 1}: ${next.layer.penName}`),
          h("span", null, ` Troque a caneta sem mexer no papel e envie. A primeira coisa que ela desenha é a cruz de registro: se não cair em cima da cruz da camada anterior, pare e ajuste o desvio dessa caneta em Configurações → Estojo de canetas.`),
        );
        nextBox.hidden = false;
      } else if (done && done.count > 1 && job.wholeLayer) {
        job.allLayersDone = true;
        clear(nextBox);
        nextBox.append(h("strong", null, "Todas as camadas foram plotadas."));
        nextBox.hidden = false;
      }
    }
    overlay.setPlan(planner.plan, store.state.job.speedMode === "fixed");
    overlay.setVisible(pathWasVisible);
    // a tela de plotagem passa a mostrar como terminou, e fica assim até "Voltar para a mesa"
    if (screen === "live") {
      endedView = viewOf(s);
      screen = endedView ? "ended" : "none";
      if (endedView) hooks.onView?.(endedView);
      else hooks.onView?.(undefined);
    }
    hooks.onEnd?.(j.state);
  }

  function renderRuns() {
    const runs = loadRuns();
    runsDetails.hidden = runs.length === 0;
    clear(runsList);
    runsList.append(h("tr", null, h("th", null, "Quando"), h("th", null, "Desenho"), h("th", null, "Real"), h("th", null, "Est."), h("th", null, "")));
    for (const r of runs.slice(0, 8)) {
      const d = new Date(r.at);
      const diff = r.estimatedS > 0 ? Math.round(((r.realS - r.estimatedS) / r.estimatedS) * 100) : 0;
      runsList.append(
        h(
          "tr",
          { title: `${r.lines} linhas` },
          h("td", null, `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`),
          h("td", { class: "run-name" }, r.name),
          h("td", null, fmtDuration(r.realS)),
          h("td", null, fmtDuration(r.estimatedS)),
          h("td", { class: r.result === "finished" ? "" : "run-bad" }, r.result === "finished" ? `${diff >= 0 ? "+" : ""}${diff}%` : RESULT_TEXT[r.result]),
        ),
      );
    }
  }

  // ---------------------------------------------------------------- estado
  function render(s: ControllerSnapshot) {
    const on = s.link === "connected";
    const j = s.job;
    const active = isJobActive(j.state);
    el.hidden = !on && !job;
    const plan = planner.plan;

    const why: string[] = [];
    if (!active) {
      if (!plan) why.push("Traga um desenho (passo 1).");
      else if (plan.violations.length) why.push("Há desenho fora da folha (passo 1).");
      else if (!planner.review()?.audit?.ok) why.push("A conferência reprovou o G-code (passo 2).");
      if (on && session.controller) why.push(...session.controller.jobProblems());
      else if (!on) why.push("Conecte a máquina.");
    }
    clear(reasons);
    for (const r of why) reasons.append(h("li", null, r));
    reasons.hidden = why.length === 0;

    sendBtn.hidden = active;
    sendBtn.disabled = why.length > 0;
    partSelect.disabled = active;
    frameBtn.hidden = active;
    frameBtn.disabled = !on || !plan || !s.homed || !!s.busy || s.status?.state !== "Idle";
    frameBtn.title = s.homed ? "Percorre o retângulo do desenho com a caneta levantada, para conferir a posição no papel." : "Faça o Home antes do contorno.";

    // (Parar, Pausar, a velocidade, o progresso e os avisos do trabalho ficam na tela de plotagem)
    resultBox.hidden = !(job && (j.state === "stopped" || j.state === "failed") && j.message);
    if (!resultBox.hidden) {
      resultBox.className = `notice ${j.state === "failed" ? "alarm" : ""}`;
      resultBox.textContent = j.message ?? "";
    }
    trackProgress(s);
    if (j.state !== lastState) {
      if (!active && isJobActive(lastState)) finish(s);
      lastState = j.state;
    }
    publish(s);
  }

  let raf = 0;
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render(session.snapshot)));
  };
  // Fora do requestAnimationFrame: numa janela escondida ou minimizada ele não roda, e é justamente num
  // desenho longo que a janela fica escondida. Onde a máquina está e o fim do trabalho são anotados aqui.
  let trackedState: JobState = session.snapshot.job.state;
  session.subscribe((s) => {
    if (job && isJobActive(s.job.state)) {
      const at = progressPoint(job.program, s.job.currentLine);
      if (at && at.strokeIndex > job.lastStroke) job.lastStroke = at.strokeIndex;
    }
    if (s.job.state !== trackedState) {
      if (!isJobActive(s.job.state) && isJobActive(trackedState)) finish(s);
      trackedState = s.job.state;
    }
    schedule();
  });
  // ao trocar de camada, volta para "camada inteira": a parte escolhida era da outra caneta
  let shownPen = planner.plan?.layer?.penId;
  planner.subscribe((plan) => {
    const pen = plan?.layer?.penId;
    renderParts(plan, pen !== shownPen ? "" : undefined);
    shownPen = pen;
    schedule();
  });
  renderParts(planner.plan);
  // o tempo decorrido anda mesmo sem relatório novo (pausa)
  setInterval(() => session.jobActive && schedule(), 500);
  renderRuns();
  render(session.snapshot);
  return { el, active: () => session.jobActive, actions };
}
