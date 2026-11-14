import { isJobActive, type ControllerSnapshot, type JobState } from "../../core/grbl/controller";
import { bboxOfPoints } from "../../core/geometry/path";
import { generateGcode, type GcodeProgram } from "../../core/job/gcode";
import type { JobPlan } from "../../core/job/types";
import type { Store } from "../../core/store";
import { addRun, loadRuns, type RunRecord } from "../../storage/runsStore";
import { clear, h, toast } from "../dom";
import type { MachineSession } from "../machine/session";
import type { Overlay, Player } from "../overlay";
import { fmtDuration, type Planner } from "../planner";
import { machineAction } from "./machinePanel";

interface ActiveJob {
  readonly plan: JobPlan;
  readonly program: GcodeProgram;
  readonly name: string;
  /** tempo estimado (s) da posição atual, para a barra e o "restante" */
  estAt: number;
  recorded: boolean;
}

const RESULT_TEXT: Record<RunRecord["result"], string> = { finished: "concluído", stopped: "parado", failed: "falhou" };

/** Retângulo do desenho em mm da máquina (para o contorno). */
export function planBBox(plan: JobPlan) {
  return bboxOfPoints(plan.strokes.flatMap((s) => s.points));
}

export interface SendPanel {
  readonly el: HTMLElement;
  /** Há trabalho na máquina: a pré-visualização mostra o plano dele, não o da mesa. */
  readonly active: () => boolean;
}

/**
 * Aba "Máquina", parte do envio: Contorno, Enviar (com as pré-condições na tela), barra de progresso,
 * tempo decorrido/restante, linha atual destacada na pré-visualização, Wake Lock, confirmação ao fechar
 * a aba e registro do tempo real × estimado.
 */
export function createSendPanel(session: MachineSession, store: Store, planner: Planner, overlay: Overlay, player: Player): SendPanel {
  let job: ActiveJob | undefined;
  let wake: WakeLockSentinel | undefined;
  let lastState: JobState = "none";

  const frameBtn = h("button", { title: "Percorre o retângulo do desenho com a caneta levantada, para conferir a posição no papel." }, "▭ Contorno");
  const sendBtn = h("button", { class: "primary" }, "▶ Enviar desenho");
  const stopBtn = h("button", { title: "Para mantendo a posição: pausa, espera parar e reinicia o GRBL (a caneta sobe)." }, "■ Parar");
  const reasons = h("ul", { class: "reasons" });
  const bar = h("div", { class: "progress-fill" });
  const progress = h("div", { class: "progress" }, bar);
  const progressText = h("div", { class: "progress-text" });
  const resultBox = h("div", { class: "notice" });
  const runsList = h("table", { class: "runs" });
  const runsDetails = h("details", null, h("summary", null, "Últimos trabalhos (real × estimado)"), runsList);

  const el = h(
    "div",
    { class: "panel-section" },
    h("h3", null, "Enviar"),
    h("div", { class: "row" }, frameBtn, sendBtn, stopBtn),
    reasons,
    progress,
    progressText,
    resultBox,
    runsDetails,
  );

  // ---------------------------------------------------------------- ações
  frameBtn.addEventListener("click", () => {
    const plan = planner.fresh();
    const c = session.controller;
    if (!plan || !c) return;
    void machineAction(() => c.frame(planBBox(plan)));
  });

  sendBtn.addEventListener("click", () => {
    const c = session.controller;
    const plan = planner.fresh();
    if (!c || !plan) return;
    if (plan.violations.length) return toast("Há desenho fora da área: corrija antes de enviar.", "error");
    const names = store.doc.drawings.map((d) => d.name);
    let program: GcodeProgram;
    try {
      program = generateGcode(plan, store.state.profile, { fileName: names.join(" + "), date: new Date(), job: store.state.job });
      c.startJob(program);
    } catch (e) {
      return toast(e instanceof Error ? e.message : String(e), "error", 10000);
    }
    job = { plan, program, name: names.join(" + ") || "desenho", estAt: 0, recorded: false };
    if (player.playing) player.stop();
    overlay.setPlan(plan, store.state.job.speedMode === "fixed");
    overlay.setVisible(true);
    void lockScreen();
    render(session.snapshot);
  });

  stopBtn.addEventListener("click", () => {
    const c = session.controller;
    if (c) void machineAction(() => c.stop());
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

  function renderProgress(s: ControllerSnapshot) {
    const j = s.job;
    const showing = !!job && j.state !== "none";
    progress.hidden = progressText.hidden = !showing;
    if (!showing || !job) return;
    const total = job.plan.stats.estimate.totalS;
    if (isJobActive(j.state)) {
      const t = overlay.setProgress(progressPoint(job.program, j.currentLine));
      if (t !== undefined) job.estAt = Math.max(job.estAt, t);
    }
    const now = performance.now();
    const pausedNow = j.pausedAt !== undefined ? now - j.pausedAt : 0;
    const realS = j.startedAt !== undefined ? ((j.endedAt ?? now) - j.startedAt - j.pausedMs - pausedNow) / 1000 : 0;
    const frac = j.state === "finished" ? 1 : total > 0 ? Math.min(1, job.estAt / total) : j.acked / Math.max(1, j.total);
    bar.style.width = `${(frac * 100).toFixed(1)}%`;
    bar.className = `progress-fill ${j.state}`;
    const remainingEst = Math.max(0, total - job.estAt);
    const ratio = job.estAt > 5 && realS > 5 ? realS / job.estAt : 1;
    const parts = [`${Math.round(frac * 100)}%`, `linha ${j.acked.toLocaleString("pt-BR")} de ${j.total.toLocaleString("pt-BR")}`, `decorrido ${fmtDuration(realS)}`];
    if (isJobActive(j.state)) parts.push(`falta ~${fmtDuration(remainingEst * ratio)}`);
    else parts.push(`estimado ${fmtDuration(total)}`);
    progressText.textContent = parts.join(" · ");
  }

  function finish(s: ControllerSnapshot) {
    if (!job || job.recorded) return;
    const j = s.job;
    if (j.state !== "finished" && j.state !== "stopped" && j.state !== "failed") return;
    job.recorded = true;
    unlockScreen();
    const realS = j.startedAt !== undefined && j.endedAt !== undefined ? (j.endedAt - j.startedAt - j.pausedMs) / 1000 : 0;
    const est = job.plan.stats.estimate.totalS;
    addRun({ at: new Date().toISOString(), name: job.name, estimatedS: est, realS, result: j.state, lines: j.total });
    renderRuns();
    overlay.setProgress(undefined);
    overlay.setPlan(planner.plan, store.state.job.speedMode === "fixed");
    if (j.state === "finished") {
      const diff = est > 0 ? Math.round(((realS - est) / est) * 100) : 0;
      toast(`Desenho concluído em ${fmtDuration(realS)} (estimado ${fmtDuration(est)}, ${diff >= 0 ? "+" : ""}${diff}%).`, "info", 12000);
    }
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
      if (!plan) why.push("Importe um desenho.");
      else if (plan.violations.length) why.push("Há desenho fora da área (veja a aba Trabalho).");
      if (on && session.controller) why.push(...session.controller.jobProblems());
      else if (!on) why.push("Conecte a máquina.");
    }
    clear(reasons);
    for (const r of why) reasons.append(h("li", null, r));
    reasons.hidden = why.length === 0;

    sendBtn.hidden = active;
    sendBtn.disabled = why.length > 0;
    frameBtn.hidden = active;
    frameBtn.disabled = !on || !plan || !s.homed || !!s.busy || s.status?.state !== "Idle";
    frameBtn.title = s.homed ? "Percorre o retângulo do desenho com a caneta levantada, para conferir a posição no papel." : "Faça o Home antes do contorno.";
    stopBtn.hidden = !active;
    stopBtn.disabled = j.state === "stopping";

    resultBox.hidden = !(job && (j.state === "stopped" || j.state === "failed") && j.message);
    if (!resultBox.hidden) {
      resultBox.className = `notice ${j.state === "failed" ? "alarm" : ""}`;
      resultBox.textContent = j.message ?? "";
    }
    renderProgress(s);
    if (j.state !== lastState) {
      if (!active && isJobActive(lastState)) finish(s);
      lastState = j.state;
    }
  }

  let raf = 0;
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render(session.snapshot)));
  };
  session.subscribe(schedule);
  planner.subscribe(schedule);
  // o tempo decorrido anda mesmo sem relatório novo (pausa)
  setInterval(() => session.jobActive && schedule(), 500);
  renderRuns();
  render(session.snapshot);
  return { el, active: () => session.jobActive };
}
