import type { AuditReport } from "../../core/job/audit";
import { MAX_LINE_LENGTH } from "../../core/job/gcode";
import type { JobPlan } from "../../core/job/types";
import type { Store } from "../../core/store";
import { append, clear, h, toast } from "../dom";
import { fmtDuration, fmtLength, type Planner } from "../planner";
import { parseNum } from "./propertiesPanel";
import type { StepFlag } from "./sidePanel";

const QUICK_FEEDS = [500, 1000, 1500];

/** Nome do arquivo: o do primeiro desenho, sem extensão (ou "plotter"). */
export function exportFileName(names: readonly string[], part?: { index: number; total: number }): string {
  const base = (names[0] ?? "plotter").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "plotter";
  const more = names.length > 1 ? `_e_mais_${names.length - 1}` : "";
  const suffix = part ? `_parte${part.index + 1}de${part.total}` : "";
  return `${base}${more}${suffix}.gcode`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = h("a", { href: url, download: name, style: "display:none" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const num = (v: number, digits = 0) => v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Barra com o valor medido e o risco do limite. */
function gauge(label: string, value: number, limit: number, unit: string, digits = 0): HTMLElement {
  const max = Math.max(limit * 1.5, value * 1.1, 1);
  const state = value > limit * 1.001 ? "bad" : value > limit * 0.85 ? "warn" : "";
  return h(
    "div",
    { class: "gauge" },
    h("div", { class: "gauge-head" }, h("span", null, label), h("b", null, num(value, digits), h("small", null, ` ${unit}`))),
    h(
      "div",
      { class: "gauge-track", role: "img", "aria-label": `${label}: ${num(value, digits)} ${unit}, limite ${num(limit)}` },
      h("div", { class: `gauge-fill ${state}`, style: `width:${Math.min(100, (100 * value) / max).toFixed(1)}%` }),
      h("div", { class: "gauge-limit", style: `left:${((100 * limit) / max).toFixed(1)}%` }),
    ),
    h("div", { class: "gauge-scale" }, h("span", null, "0"), h("span", null, `limite ${num(limit)}`)),
  );
}

/**
 * Passo "Conferir": o veredito (pode ou não ir para a máquina), o tempo, a carga do servo,
 * as regras de docs/REGRAS_GCODE.md uma a uma, os ajustes do trabalho e os arquivos para baixar.
 */
export function createJobPanel(store: Store, planner: Planner, preview?: HTMLElement, onVerdict: (flag: StepFlag, title: string) => void = () => {}): HTMLElement {
  const root = h("div", { class: "panel" });

  const verdict = h("div", { class: "verdict" });
  const problems = h("div");
  const time = h("dl", { class: "stats" });
  const servo = h("div", { class: "panel-section" });
  const checks = h("ul", { class: "checks" });
  const files = h("div", { class: "panel-section" });

  // --- ajustes do trabalho
  const radio = (value: "dynamic" | "fixed", label: string) => {
    const r = h("input", { type: "radio", name: "speedMode", value });
    r.addEventListener("change", () => r.checked && store.setJob({ speedMode: value }));
    return { r, el: h("label", { class: "check" }, r, label) };
  };
  const fix = radio("fixed", "Fixa: a mesma em todo o desenho");
  const dyn = radio("dynamic", "Dinâmica: mais rápido nas retas");
  const feedInput = h("input", { type: "text", inputMode: "decimal", "aria-label": "Velocidade fixa (mm/min)" });
  const commitFeed = () => {
    const v = parseNum(feedInput.value);
    const max = store.state.profile.motion.maxRateMmMin;
    if (v === undefined || v <= 0 || v > max) {
      toast(`A velocidade tem que ficar entre 1 e ${max} mm/min.`, "warn");
      return syncControls();
    }
    store.setJob({ fixedFeed: Math.round(v), speedMode: "fixed" });
  };
  feedInput.addEventListener("change", commitFeed);
  feedInput.addEventListener("keydown", (e) => e.key === "Enter" && commitFeed());
  const quick = QUICK_FEEDS.map((f) => h("button", { onclick: () => store.setJob({ fixedFeed: f, speedMode: "fixed" }) }, `F${f}`));
  const dynInfo = h("p", { class: "hint" });
  const opt = h("input", { type: "checkbox" });
  opt.addEventListener("change", () => store.setJob({ optimize: opt.checked }));

  const empty = h("p", { class: "hint" }, "Traga um desenho no passo 1. Aqui aparece se ele pode ir para a máquina, quanto tempo leva e quanto o servo trabalha.");
  const content = h(
    "div",
    { class: "panel-section" },
    verdict,
    problems,
    h("h3", null, "Tempo"),
    time,
    h("h3", null, "Servo da caneta"),
    servo,
    h("h3", null, "Regras do G-code"),
    checks,
    h("h3", null, "Velocidade do traço"),
    fix.el,
    h("div", { class: "row center" }, h("label", { class: "field", style: "width:110px" }, "mm/min", feedInput), ...quick),
    dyn.el,
    dynInfo,
    h("h3", null, "Ordem dos traços"),
    h(
      "label",
      { class: "check", title: "Emenda traços quando a ligação não aparece, tira o que fica escondido e encurta o caminho com a caneta no ar." },
      opt,
      "Emendar e ordenar para poupar o servo",
    ),
    h("h3", null, "Arquivo"),
    files,
    preview,
  );
  append(root, [empty, content]);

  function syncControls() {
    const { job, profile } = store.state;
    dyn.r.checked = job.speedMode === "dynamic";
    fix.r.checked = job.speedMode === "fixed";
    if (document.activeElement !== feedInput) feedInput.value = String(job.fixedFeed);
    for (const [i, b] of quick.entries()) b.classList.toggle("active", job.speedMode === "fixed" && job.fixedFeed === QUICK_FEEDS[i]);
    opt.checked = job.optimize;
    const f = profile.feed;
    dynInfo.textContent = `Retas F${f.straight}, curvas F${f.curve}, curvas fechadas F${f.tightCurve}. As regras da máquina pedem F500 fixo para precisão máxima.`;
  }

  function setVerdict(kind: "ok" | "warn" | "bad", title: string, detail: string) {
    verdict.className = `verdict ${kind}`;
    clear(verdict);
    verdict.append(h("span", { class: "verdict-mark", "aria-hidden": "true" }, kind === "ok" ? "✓" : kind === "warn" ? "!" : "✕"), h("div", null, title, h("small", null, detail)));
    onVerdict(kind, `${title}: ${detail}`);
  }

  function renderTime(plan: JobPlan) {
    clear(time);
    const s = plan.stats;
    const e = s.estimate;
    const row = (k: string, v: string, cls = "") => time.append(h("dt", { class: cls }, k), h("dd", { class: cls }, v));
    row("Desenhando", fmtDuration(e.drawS), "sub");
    row("Caneta no ar", fmtDuration(e.travelS), "sub");
    row("Pausas do servo e blindagem", fmtDuration(e.penS), "sub");
    if (e.waitS > 0.5) row("Descanso do servo", fmtDuration(e.waitS), "sub");
    row("Tempo total", fmtDuration(e.totalS), "total");
    row("Traço", fmtLength(s.drawMm));
    row("Caneta no ar", fmtLength(s.travelMm));
    if (store.state.job.optimize && s.travelMmUnoptimized > s.travelMm + 0.5) row("Poupado ao reordenar os traços", fmtLength(s.travelMmUnoptimized - s.travelMm));
    if (s.joinInkMm > 0.5) row("Tinta a mais das emendas", fmtLength(s.joinInkMm));
    if (s.hiddenDropped > 0) row("Tracinhos escondidos retirados", num(s.hiddenDropped));
  }

  function renderServo(plan: JobPlan, a: AuditReport) {
    clear(servo);
    const lim = store.state.profile.servo;
    servo.append(
      gauge("Média", a.avgCyclesPerMin, lim.avgPerMin, "descidas/min", 1),
      gauge("Pico em 60 s", a.peakCyclesPer60s, lim.peakPer60s, "descidas"),
      h(
        "p",
        { class: "hint" },
        `${num(a.cycles)} descidas no desenho. ${num(a.shortDescentPct)}% duram menos de 1 s (as que mais esquentam). ` +
          `Caneta embaixo ${num(a.penDownPct)}% do tempo; descida mais longa ${fmtDuration(a.longestDescentS)}.`,
      ),
    );
    const waits = plan.stats.estimate.waitS;
    if (waits > 0.5) {
      servo.append(
        h(
          "p",
          { class: "notice" },
          `Para não passar do limite, a máquina vai esperar ${fmtDuration(waits)} ao todo, com a caneta em cima. ` +
            `Dá para mudar os limites, ou trocar a espera por um aviso, em Configurações → Proteção do servo.`,
        ),
      );
    } else if (plan.stats.overloads > 0 && lim.onOverload !== "wait") {
      servo.append(h("p", { class: "notice" }, `${num(plan.stats.overloads)} descidas passam do limite e a espera está desligada.`));
    }
  }

  function renderChecks(a: AuditReport) {
    clear(checks);
    const zone = store.state.profile.drawZone;
    const item = (ok: boolean, label: string, val: string, warnOnly = false) =>
      checks.append(h("li", { class: ok ? "ok" : warnOnly ? "warn" : "bad" }, h("span", { class: "mark", "aria-hidden": "true" }, ok ? "✓" : warnOnly ? "!" : "✕"), h("span", null, label), h("span", { class: "val" }, val)));
    item(a.rapidsPenDown === 0, "Nunca desloca com a caneta embaixo", a.rapidsPenDown ? `${num(a.rapidsPenDown)} vez(es)` : "ok");
    item(a.penCmdsWithoutDwell === 0, "Sempre espera o servo depois de subir ou descer", a.penCmdsWithoutDwell ? `${num(a.penCmdsWithoutDwell)} sem pausa` : "ok");
    item(a.outOfZone === 0, `Tudo dentro da folha (X ${num(zone.minX)}–${num(zone.maxX)}, Y ${num(zone.minY)}–${num(zone.maxY)})`, a.outOfZone ? `${num(a.outOfZone)} ponto(s) fora` : "ok");
    item(a.outOfArea === 0, "Tudo dentro do curso da máquina", a.outOfArea ? `${num(a.outOfArea)} ponto(s) fora` : "ok");
    item(a.maxLineLength <= MAX_LINE_LENGTH, "Linhas curtas para o buffer do GRBL", `maior: ${a.maxLineLength}`);
    item(a.nonAsciiLines === 0, "Só caracteres que o GRBL entende", a.nonAsciiLines ? `${num(a.nonAsciiLines)} linha(s)` : "ok");
    const sh = store.state.profile.shield;
    item(sh.enabled, "Blindagem: aquecimento, subida dupla e checkpoints", sh.enabled ? `${a.warmupCycles} + ${a.checkpoints} checkpoint(s)` : "desligada", true);
    const capOk = a.longestDescentMm <= store.state.profile.servo.maxDescentMm * 1.01 + 1;
    item(capOk, "Nenhuma descida longa demais", `${fmtLength(a.longestDescentMm)}`, true);
  }

  function renderFiles(plan: JobPlan, canExport: boolean) {
    clear(files);
    const names = store.doc.drawings.map((d) => d.name);
    const full = h("button", { class: "primary big", disabled: !canExport, onclick: () => doExport() }, "Baixar o G-code");
    files.append(full);
    if (!canExport) {
      files.append(h("p", { class: "hint" }, "Bloqueado: corrija o que está em vermelho acima. Arquivo que quebra regra não vai para a máquina."));
      return;
    }
    files.append(h("p", { class: "hint" }, `${exportFileName(names)}. Para mandar direto, sem arquivo, use o passo 3.`));
    const total = plan.stats.parts;
    if (total > 1) {
      const list = h("div", { class: "parts" });
      const ds = plan.descents;
      for (let p = 0; p < total; p++) {
        const mine = ds.filter((d) => d.part === p);
        const next = ds.find((d) => d.part === p + 1);
        const t0 = mine[0]?.tDownS ?? 0;
        const t1 = next?.tDownS ?? plan.stats.estimate.totalS;
        list.append(h("button", { onclick: () => doExport(p) }, h("span", null, `Parte ${p + 1} de ${total}`), h("span", null, `~${fmtDuration(t1 - t0)}`)));
      }
      files.append(
        h("p", { class: "hint" }, `Ou em ${total} partes, cada uma com o aquecimento do servo. Se a caneta falhar, você roda de novo só a parte em que parou.`),
        list,
      );
    }
  }

  function render(plan: JobPlan | undefined) {
    empty.hidden = !!plan;
    content.hidden = !plan;
    clear(problems);
    if (!plan) return onVerdict(undefined, "");
    renderTime(plan);
    const names = new Map(store.doc.drawings.map((d) => [d.id, d.name]));

    if (plan.violations.length) {
      const zone = plan.violations.every((v) => v.kind === "zone");
      setVerdict("bad", zone ? "Tem desenho fora da folha" : "Tem desenho fora do curso da máquina", "Mova ou diminua no passo 1.");
      problems.append(
        h(
          "ul",
          { class: "problems" },
          ...plan.violations.map((v) => h("li", null, `${names.get(v.drawingId) ?? "Desenho"}: ${v.message} ${v.kind === "zone" ? "da folha" : "do curso da máquina (o GRBL daria ALARM:2)"}.`)),
        ),
      );
      clear(servo);
      clear(checks);
      servo.append(h("p", { class: "hint" }, "Aparece quando o desenho estiver dentro da folha."));
      renderFiles(plan, false);
      return;
    }
    const a = planner.review()?.audit;
    if (!a) {
      setVerdict("bad", "Não consegui gerar o G-code", "Veja o console do navegador.");
      renderFiles(plan, false);
      return;
    }
    renderServo(plan, a);
    renderChecks(a);
    const errors = a.problems.filter((p) => p.level === "error");
    const warns = a.problems.filter((p) => p.level === "warn");
    if (errors.length) {
      setVerdict("bad", "Não pode ir para a máquina", `${errors.length} regra(s) quebrada(s).`);
      problems.append(h("ul", { class: "problems" }, ...errors.map((p) => h("li", null, p.message))));
    } else if (warns.length) {
      setVerdict("warn", "Pode ir, com atenção", warns[0].message);
      if (warns.length > 1) problems.append(h("ul", { class: "reasons" }, ...warns.slice(1).map((p) => h("li", null, p.message))));
    } else {
      setVerdict("ok", "Pronto para plotar", `Passou em todas as regras. ${fmtDuration(plan.stats.estimate.totalS)} de máquina.`);
    }
    renderFiles(plan, errors.length === 0);
  }

  function doExport(part?: number) {
    const plan = planner.fresh();
    const review = planner.review();
    if (!plan || !review?.audit?.ok) return render(plan);
    const names = store.doc.drawings.map((d) => d.name);
    const total = plan.stats.parts;
    const fileName = exportFileName(names, part === undefined ? undefined : { index: part, total });
    const program = part === undefined ? review.program! : planner.program(part)!;
    download(fileName, program.toText());
    toast(`${fileName} baixado (${program.lines.length.toLocaleString("pt-BR")} linhas).`);
  }

  store.subscribe((s, prev) => {
    if (s.job !== prev.job || s.profile !== prev.profile) syncControls();
  });
  planner.subscribe(render);
  syncControls();
  render(planner.plan);
  return root;
}
