import { describeError } from "../../core/grbl/codes";
import { isJobActive, type ControllerSnapshot, type JobState } from "../../core/grbl/controller";
import { RT } from "../../core/grbl/protocol";
import { bboxOfPoints } from "../../core/geometry/path";
import type { GcodeProgram } from "../../core/job/gcode";
import { parseWhat, planSignature, resumeDescent, sendSpan, type SendWhat } from "../../core/job/resume";
import type { JobPlan } from "../../core/job/types";
import type { Store } from "../../core/store";
import { addRun, loadRuns, type RunRecord } from "../../storage/runsStore";
import { clear, h, toast } from "../dom";
import type { MachineSession } from "../machine/session";
import type { Overlay, Player } from "../overlay";
import { fmtDuration, type Planner } from "../planner";
import { createLayerPicker } from "./layerPicker";
import { machineAction } from "./machinePanel";

interface ActiveJob {
  readonly plan: JobPlan;
  readonly program: GcodeProgram;
  readonly name: string;
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
  let lastErrKey = "";
  let resumePoint = loadResume();

  const frameBtn = h("button", { title: "Percorre o retângulo do desenho com a caneta levantada, para conferir a posição no papel." }, "▭ Contorno");
  const sendBtn = h("button", { class: "primary" }, "▶ Enviar desenho");
  const stopBtn = h("button", { title: "Para mantendo a posição: pausa, espera parar e reinicia o GRBL (a caneta sobe)." }, "■ Parar");
  const pauseBtn = h("button", { class: "primary" }, "⏸ Pausar");
  const pauseNote = h("p", { class: "hint" });
  const errorBox = h("div", { class: "notice alarm" });
  const ovValue = h("span", { class: "ov-value" });
  const ovRow = h(
    "div",
    { class: "row center ov-row" },
    h("span", { class: "hint" }, "Velocidade ", ovValue),
    h("button", { title: "−10% (0x92)", onclick: () => feed(RT.FEED_MINUS_10) }, "−10%"),
    h("button", { title: "Volta para 100% (0x90)", onclick: () => feed(RT.FEED_RESET) }, "100%"),
    h("button", { title: "+10% (0x91)", onclick: () => feed(RT.FEED_PLUS_10) }, "+10%"),
  );
  const partSelect = h("select", { "aria-label": "O que enviar" });
  const partRow = h("label", { class: "field" }, "O que enviar", partSelect);
  const resumeHint = h("p", { class: "hint", hidden: true });
  const reasons = h("ul", { class: "reasons" });
  const bar = h("div", { class: "progress-fill" });
  const progress = h("div", { class: "progress" }, bar);
  const progressText = h("div", { class: "progress-text" });
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
    h("div", { class: "row" }, frameBtn, sendBtn, pauseBtn, stopBtn),
    reasons,
    progress,
    progressText,
    pauseNote,
    errorBox,
    ovRow,
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

  pauseBtn.addEventListener("click", () => {
    const c = session.controller;
    const st = session.snapshot.job.state;
    if (!c) return;
    if (st === "running") c.pause();
    else if (st === "paused") c.resume();
  });

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
    const label = what.kind === "part" ? `${name} (parte ${what.part + 1})` : what.kind === "resume" ? `${name} (retomada)` : name;
    job = { plan, program, name: label, ...sendSpan(plan, what), estAt: 0, recorded: false, wholeLayer: what.kind !== "part" || what.part === plan.stats.parts - 1, lastStroke: -1 };
    nextBox.hidden = true;
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
    const total = job.t1 - job.t0;
    if (isJobActive(j.state)) {
      const at = progressPoint(job.program, j.currentLine);
      if (at && at.strokeIndex > job.lastStroke) job.lastStroke = at.strokeIndex;
      const t = overlay.setProgress(at);
      if (t !== undefined) job.estAt = Math.max(job.estAt, Math.min(total, t - job.t0));
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
    const est = job.t1 - job.t0;
    addRun({ at: new Date().toISOString(), name: job.name, estimatedS: est, realS, result: j.state, lines: j.total });
    renderRuns();
    overlay.setProgress(undefined);
    // parou no meio: guarda de onde retomar (vale enquanto o desenho e os ajustes forem os mesmos)
    const sig = planSignature(job.plan);
    if (j.state === "finished") {
      if (job.wholeLayer && resumePoint?.sig === sig) saveResume((resumePoint = undefined));
    } else {
      const from = resumeDescent(job.plan, job.lastStroke);
      if (from !== undefined) {
        resumePoint = { sig, descent: from };
        saveResume(resumePoint);
        if (planner.plan === job.plan) renderParts(job.plan, `r${from}`);
      }
    }
    if (j.state === "finished") {
      const diff = est > 0 ? Math.round(((realS - est) / est) * 100) : 0;
      const done = job.plan.layer;
      const what = done && done.count > 1 ? `Camada ${done.index + 1} (${done.penName}) concluída` : "Desenho concluído";
      toast(`${what} em ${fmtDuration(realS)} (estimado ${fmtDuration(est)}, ${diff >= 0 ? "+" : ""}${diff}%).`, "info", 12000);
      // a vez da próxima caneta: a lista já aponta para ela
      const next = done && job.wholeLayer ? planner.layers.find((p) => p.layer?.index === done.index + 1) : undefined;
      if (done && next?.layer) {
        planner.setLayer(next.layer.penId);
        clear(nextBox);
        nextBox.append(
          h("strong", null, `Agora a camada ${next.layer.index + 1}: ${next.layer.penName}`),
          h("span", null, ` Troque a caneta sem mexer no papel e envie. A primeira coisa que ela desenha é a cruz de registro: se não cair em cima da cruz da camada anterior, pare e ajuste o desvio dessa caneta em Configurações → Canetas.`),
        );
        nextBox.hidden = false;
      } else if (done && done.count > 1 && job.wholeLayer) {
        clear(nextBox);
        nextBox.append(h("strong", null, "Todas as camadas foram plotadas."));
        nextBox.hidden = false;
      }
    }
    overlay.setPlan(planner.plan, store.state.job.speedMode === "fixed");
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
    stopBtn.hidden = !active;
    stopBtn.disabled = j.state === "stopping";

    // pausa / continuar
    const mode = store.state.profile.pen.pauseLift;
    pauseBtn.hidden = !active || j.state === "stopping";
    pauseBtn.disabled = j.state === "pausing" || j.state === "resuming";
    pauseBtn.textContent =
      j.state === "paused" ? "▶ Continuar" : j.state === "pausing" ? "Pausando…" : j.state === "resuming" ? "Descendo a caneta…" : "⏸ Pausar";
    pauseBtn.title =
      mode === "spindleStop"
        ? "Para na hora e levanta a caneta (0x9E). Ao continuar, a caneta desce antes de andar."
        : "Termina o traço atual, levanta a caneta e para.";
    let note = "";
    if (j.state === "pausing") note = j.pauseMode === "endOfStroke" ? "Terminando o traço atual antes de parar…" : "Parando…";
    else if (j.state === "paused") {
      if (j.pauseMode === "endOfStroke") note = "Pausado no fim do traço, com a caneta em cima. Dá para trocar a caneta ou ajustar o papel.";
      else if (j.penLifted && (s.status?.spindle ?? 0) > 0)
        note =
          "Pausado, mas o GRBL diz que a caneta continua embaixo: este firmware não levanta a caneta com 0x9E. Em ⚙ Configurações → Caneta, mude \"Pausa\" para \"no fim do traço\".";
      else if (j.penLifted) note = "Pausado com a caneta levantada. Ao continuar, ela desce, espera o servo e só então anda.";
      else note = "Pausado. Atenção: a caneta ficou no papel.";
    }
    pauseNote.textContent = note;
    pauseNote.hidden = !note;

    // erro no meio do trabalho
    errorBox.hidden = !(active && j.error);
    const errKey = j.error && !errorBox.hidden ? `${j.error.line}:${j.error.code}:${j.state === "paused"}` : "";
    if (j.error && errKey && errKey !== lastErrKey) {
      const info = describeError(j.error.code);
      clear(errorBox);
      errorBox.append(
        h("strong", null, `Erro na linha ${j.error.line + 1}: error:${j.error.code} — ${info.title}`),
        h("code", { class: "err-line" }, j.error.text),
        h("span", null, info.action),
        h(
          "div",
          { class: "row" },
          h("button", { disabled: j.state !== "paused", onclick: () => session.controller?.resume(), title: "O GRBL já pulou essa linha; continua da próxima." }, "Continuar mesmo assim"),
          h("button", { onclick: () => session.controller && void machineAction(() => session.controller!.stop()) }, "■ Parar"),
        ),
      );
    }
    lastErrKey = errKey;

    ovRow.hidden = !active;
    ovValue.textContent = `${s.status?.overrides?.feed ?? 100}%`;

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
  planner.subscribe((plan) => {
    renderParts(plan);
    schedule();
  });
  renderParts(planner.plan);
  // o tempo decorrido anda mesmo sem relatório novo (pausa)
  setInterval(() => session.jobActive && schedule(), 500);
  renderRuns();
  render(session.snapshot);
  return { el, active: () => session.jobActive };
}
