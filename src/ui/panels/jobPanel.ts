import { generateGcode } from "../../core/job/gcode";
import type { JobPlan } from "../../core/job/types";
import type { Store } from "../../core/store";
import { append, clear, h, toast } from "../dom";
import { fmtDuration, fmtLength, type Planner } from "../planner";
import { parseNum } from "./propertiesPanel";

const QUICK_FEEDS = [500, 1000, 1500, 2000];

/** Nome do arquivo: o do primeiro desenho, sem extensão (ou "plotter"). */
export function exportFileName(names: readonly string[]): string {
  const base = (names[0] ?? "plotter").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "plotter";
  return `${base}${names.length > 1 ? `_e_mais_${names.length - 1}` : ""}.gcode`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = h("a", { href: url, download: name, style: "display:none" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Aba "Trabalho": modo de velocidade, otimização, estatísticas do plano,
 * problemas (desenho fora da área) e o botão de exportar.
 */
export function createJobPanel(store: Store, planner: Planner): HTMLElement {
  const root = h("div", { class: "panel" });

  // --- modo de velocidade
  const radio = (value: "dynamic" | "fixed", label: string) => {
    const r = h("input", { type: "radio", name: "speedMode", value });
    r.addEventListener("change", () => r.checked && store.setJob({ speedMode: value }));
    return { r, el: h("label", { class: "check" }, r, label) };
  };
  const dyn = radio("dynamic", "Dinâmico (pela curvatura)");
  const fix = radio("fixed", "Fixo");
  const feedInput = h("input", { type: "text", inputMode: "decimal", "aria-label": "Velocidade fixa (mm/min)" });
  const commitFeed = () => {
    const v = parseNum(feedInput.value);
    const max = store.state.profile.motion.maxRateMmMin;
    if (v === undefined || v <= 0 || v > max) {
      toast(`Velocidade tem que ficar entre 1 e ${max} mm/min.`, "warn");
      return syncControls();
    }
    store.setJob({ fixedFeed: Math.round(v), speedMode: "fixed" });
  };
  feedInput.addEventListener("change", commitFeed);
  feedInput.addEventListener("keydown", (e) => e.key === "Enter" && commitFeed());
  const quick = QUICK_FEEDS.map((f) => h("button", { onclick: () => store.setJob({ fixedFeed: f, speedMode: "fixed" }) }, `F${f}`));
  const dynInfo = h("p", { class: "hint" });

  // --- otimização
  const opt = h("input", { type: "checkbox" });
  opt.addEventListener("change", () => store.setJob({ optimize: opt.checked }));

  // --- estatísticas, problemas, exportar
  const stats = h("dl", { class: "stats" });
  const problems = h("div");
  const exportBtn = h("button", { class: "primary", onclick: () => doExport() }, "Exportar .gcode");
  const exportMsg = h("p", { class: "hint" });

  append(root, [
    h("h3", null, "Velocidade"),
    dyn.el,
    dynInfo,
    fix.el,
    h("div", { class: "grid2" }, h("label", { class: "field" }, "F fixo (mm/min)", feedInput)),
    h("div", { class: "row" }, ...quick),
    h("h3", null, "Ordem dos traços"),
    h("label", { class: "check", title: "Vizinho mais próximo, invertendo traços e juntando pontas que se tocam" }, opt, "Otimizar (menos deslocamento com a caneta levantada)"),
    h("h3", null, "Resumo"),
    stats,
    problems,
    h("h3", null, "Exportar"),
    exportBtn,
    exportMsg,
  ]);

  function syncControls() {
    const { job, profile } = store.state;
    dyn.r.checked = job.speedMode === "dynamic";
    fix.r.checked = job.speedMode === "fixed";
    if (document.activeElement !== feedInput) feedInput.value = String(job.fixedFeed);
    for (const [i, b] of quick.entries()) b.classList.toggle("active", job.speedMode === "fixed" && job.fixedFeed === QUICK_FEEDS[i]);
    opt.checked = job.optimize;
    const f = profile.feed;
    dynInfo.textContent = `Retas F${f.straight}, curvas F${f.curve}, curvas fechadas F${f.tightCurve} (muda em Configurações).`;
  }

  function renderPlan(plan: JobPlan | undefined) {
    clear(stats);
    clear(problems);
    const names = new Map(store.doc.drawings.map((d) => [d.id, d.name]));
    if (!plan) {
      stats.append(h("dt", null, "Nada na mesa"), h("dd", null, "—"));
      exportBtn.disabled = true;
      exportMsg.textContent = "Importe um SVG para gerar o G-code.";
      return;
    }
    const s = plan.stats;
    const row = (k: string, v: string) => stats.append(h("dt", null, k), h("dd", null, v));
    row("Desenhando", fmtLength(s.drawMm));
    row("Caneta levantada", fmtLength(s.travelMm));
    if (store.state.job.optimize && s.travelMmUnoptimized > s.travelMm + 0.5) {
      row("Economia na ordem", `−${fmtLength(s.travelMmUnoptimized - s.travelMm)}`);
    }
    row("Descidas da caneta", s.penLifts.toLocaleString("pt-BR"));
    row("Segmentos", s.segments.toLocaleString("pt-BR"));
    row("Tempo estimado", fmtDuration(s.estimate.totalS));
    row("  só pausas do servo", fmtDuration(s.estimate.penS));

    if (plan.violations.length) {
      problems.append(
        h(
          "ul",
          { class: "problems" },
          ...plan.violations.map((v) => h("li", null, `${names.get(v.drawingId) ?? "Desenho"}: ${v.message} da área útil.`)),
        ),
      );
      exportBtn.disabled = true;
      exportMsg.textContent = "Exportação bloqueada: mova ou diminua o que está fora da área (o GRBL daria ALARM:2 e perderia a posição).";
    } else {
      exportBtn.disabled = false;
      exportMsg.textContent = `Arquivo: ${exportFileName(store.doc.drawings.map((d) => d.name))}`;
    }
  }

  function doExport() {
    const plan = planner.fresh();
    if (!plan || plan.violations.length) return renderPlan(plan);
    const names = store.doc.drawings.map((d) => d.name);
    const fileName = exportFileName(names);
    const program = generateGcode(plan, store.state.profile, { fileName: names.join(" + "), date: new Date(), job: store.state.job });
    download(fileName, program.toText());
    toast(`${fileName} exportado (${program.lines.length.toLocaleString("pt-BR")} linhas).`);
  }

  store.subscribe((s, prev) => {
    if (s.job !== prev.job || s.profile !== prev.profile) syncControls();
  });
  planner.subscribe(renderPlan);
  syncControls();
  renderPlan(planner.plan);
  return root;
}
