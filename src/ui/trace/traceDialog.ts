import { addDrawing, createDrawing } from "../../core/document";
import type { Mat2D } from "../../core/geometry/mat2d";
import type { Geometry } from "../../core/geometry/path";
import { penOf } from "../../core/machine";
import type { Store } from "../../core/store";
import { DEFAULT_TRACE, type TraceMode, type TraceOptions, type TraceResult } from "../../core/trace/traceImage";
import { CancelledError, loadImage, Tracer, type LoadedImage } from "../../trace/client";
import { append, h, toast } from "../dom";
import { parseNum } from "../panels/propertiesPanel";
import { fmtDuration, fmtLength } from "../planner";

type View = "result" | "both" | "original";
type Settings = { -readonly [K in keyof TraceOptions]: TraceOptions[K] };

const PREFS_KEY = "plotter-studio:trace";
/** Folga entre o desenho e a borda da folha ao encaixar (mm de cada lado). */
const SHEET_MARGIN = 5;

function loadPrefs(): Partial<Settings> {
  try {
    const d = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(DEFAULT_TRACE)) if (typeof d[k] === typeof def && k !== "mmPerPx" && k !== "penMm" && k !== "scale") out[k] = d[k];
    return out as Partial<Settings>;
  } catch {
    return {};
  }
}

function geometryPath(g: Geometry): Path2D {
  const p = new Path2D();
  for (const sp of g.subpaths) {
    p.moveTo(sp.start.x, sp.start.y);
    for (const s of sp.segments) {
      if (s.kind === "line") p.lineTo(s.to.x, s.to.y);
      else p.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y);
    }
    if (sp.closed) p.closePath();
  }
  return p;
}

/**
 * Tela de vetorização: a imagem vira traço de caneta aqui mesmo. À esquerda, a imagem e o resultado
 * (com zoom); à direita, o tipo de desenho, o tamanho no papel e os ajustes. "Colocar na mesa" cria
 * um desenho comum, que segue o mesmo caminho de um SVG importado.
 */
export function openTraceDialog(store: Store, file: File): void {
  const dialog = h("dialog", { class: "sheet trace", "aria-label": "Vetorizar imagem" });
  document.body.append(dialog);
  const tracer = new Tracer();
  const profile = store.state.profile;
  const zone = profile.drawZone;
  // a caneta dos desenhos novos: é ela que decide o que é "fino" e o que é "área cheia"
  let pen = penOf(profile, undefined);
  const s: Settings = { ...DEFAULT_TRACE, ...loadPrefs(), penMm: pen.widthMm };
  let img: LoadedImage | undefined;
  let result: TraceResult | undefined;
  let resultPath: Path2D | undefined;
  let fresh = false;
  let turned = false;
  let longSideMm = 0;
  let view: View = "result";
  let zoom = 1, panX = 0, panY = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ------------------------------------------------------------------ palco
  const canvas = h("canvas");
  const placeholder = h("div", { class: "placeholder" }, "Abrindo a imagem…");
  const busyLabel = h("span");
  const busyFill = h("div", { class: "progress-fill" });
  const busy = h("div", { class: "trace-busy", hidden: true }, busyLabel, h("div", { class: "progress" }, busyFill));
  const viewButtons = (["result", "both", "original"] as const).map((v) =>
    h("button", { onclick: () => setView(v) }, v === "result" ? "Resultado" : v === "both" ? "Os dois" : "Original"),
  );
  const stage = h("div", { class: "trace-stage" }, canvas, placeholder, h("div", { class: "trace-view" }, ...viewButtons), busy);

  const setView = (v: View) => {
    view = v;
    viewButtons.forEach((b, i) => b.classList.toggle("active", ["result", "both", "original"][i] === v));
    draw();
  };

  const fit = () => {
    if (!img) return;
    const r = stage.getBoundingClientRect();
    zoom = Math.min((r.width - 40) / img.gray.width, (r.height - 40) / img.gray.height);
    panX = (r.width - img.gray.width * zoom) / 2;
    panY = (r.height - img.gray.height * zoom) / 2;
  };

  function draw() {
    const r = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
    }
    const c = canvas.getContext("2d");
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    if (!img) return;
    c.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
    const { width: w, height: hh } = img.gray;
    // a folha
    c.fillStyle = "rgba(20, 33, 61, 0.18)";
    c.fillRect(3 / zoom, 4 / zoom, w, hh);
    c.fillStyle = "#fff";
    c.fillRect(0, 0, w, hh);
    if (view !== "result" || !resultPath) {
      c.imageSmoothingEnabled = zoom < 3;
      c.globalAlpha = view === "both" && resultPath ? 0.4 : 1;
      c.drawImage(img.bitmap, 0, 0);
      c.globalAlpha = 1;
    }
    if (resultPath && view !== "original") {
      // o traço aparece com a largura real da caneta (nunca menos de 1 px de tela)
      c.lineWidth = Math.max(s.penMm / s.mmPerPx, 1 / zoom);
      c.lineCap = "round";
      c.lineJoin = "round";
      c.strokeStyle = view === "both" ? "#c0362c" : "#10151f";
      c.globalAlpha = fresh ? 1 : 0.45;
      c.stroke(resultPath);
      c.globalAlpha = 1;
    }
  }

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const nz = Math.min(60, Math.max(0.05, zoom * Math.exp(-e.deltaY * 0.0015)));
      panX = cx - ((cx - panX) * nz) / zoom;
      panY = cy - ((cy - panY) * nz) / zoom;
      zoom = nz;
      draw();
    },
    { passive: false },
  );
  let drag: { x: number; y: number; px: number; py: number } | undefined;
  stage.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("grabbing");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    panX = drag.px + e.clientX - drag.x;
    panY = drag.py + e.clientY - drag.y;
    draw();
  });
  const endDrag = () => {
    drag = undefined;
    stage.classList.remove("grabbing");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("dblclick", () => {
    fit();
    draw();
  });
  const ro = new ResizeObserver(() => draw());
  ro.observe(stage);

  // ------------------------------------------------------------------ tamanho no papel
  const zoneW = zone.maxX - zone.minX - 2 * SHEET_MARGIN;
  const zoneH = zone.maxY - zone.minY - 2 * SHEET_MARGIN;
  /** Maior escala (mm por pixel) em que a imagem cabe na folha, em pé ou deitada. */
  const fitScale = (isTurned: boolean) => {
    const w = img!.gray.width, hh = img!.gray.height;
    return isTurned ? Math.min(zoneW / hh, zoneH / w) : Math.min(zoneW / w, zoneH / hh);
  };
  const applySize = () => {
    if (!img) return;
    s.mmPerPx = longSideMm / Math.max(img.gray.width, img.gray.height);
  };
  const paperSize = () => {
    const w = img!.gray.width * s.mmPerPx, hh = img!.gray.height * s.mmPerPx;
    return turned ? { w: hh, h: w } : { w, h: hh };
  };

  // ------------------------------------------------------------------ controles
  const side = h("div", { class: "trace-side panel" });
  const stats = h("p", { class: "hint" });
  const budget = h("p", { class: "notice", hidden: true });
  const sizeNote = h("p", { class: "hint" });
  const placeBtn = h("button", { class: "primary big", disabled: true, onclick: () => place() }, "Colocar na mesa");
  const fillBox = h("div", { class: "panel-section" });
  const photoBox = h("div", { class: "panel-section" });
  const strokeBox = h("div", { class: "panel-section" });

  const schedule = (delay = 650) => {
    fresh = false;
    placeBtn.disabled = true;
    draw();
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  const seg = <T extends string | boolean>(options: [T, string][], get: () => T, set: (v: T) => void) => {
    const buttons = options.map(([v, label]) =>
      h(
        "button",
        {
          onclick: () => {
            set(v);
            sync();
          },
        },
        label,
      ),
    );
    const sync = () => buttons.forEach((b, i) => b.classList.toggle("on", options[i][0] === get()));
    sync();
    return { el: h("div", { class: "seg-row" }, ...buttons), sync };
  };

  const range = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, title = "") => {
    const out = h("output", null, fmt(get()));
    const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(get()), "aria-label": label });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      set(v);
      out.textContent = fmt(v);
      schedule();
    });
    return h("label", { class: "range", title }, h("span", null, label), out, input);
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void, title = "") => {
    const cb = h("input", { type: "checkbox", checked: get() });
    cb.addEventListener("change", () => {
      set(cb.checked);
      schedule(150);
    });
    return h("label", { class: "check", title }, cb, label);
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const px = (v: number) => `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} px`;

  const modeHint = h("p", { class: "hint" });
  const mode = seg<TraceMode>(
    [
      ["line", "Traço"],
      ["ink", "Preto e branco"],
      ["photo", "Foto"],
    ],
    () => s.mode,
    (v) => {
      s.mode = v;
      renderMode();
      schedule(150);
    },
  );
  const orient = seg<boolean>(
    [
      [false, "Em pé"],
      [true, "Deitado"],
    ],
    () => turned,
    (v) => {
      turned = v;
      longSideMm = Math.round(Math.max(img!.gray.width, img!.gray.height) * fitScale(turned));
      sizeInput.value = String(longSideMm);
      applySize();
      renderSize();
      schedule(150);
    },
  );
  const sizeInput = h("input", { type: "text", inputMode: "decimal", "aria-label": "Lado maior no papel (mm)" });
  const commitSize = () => {
    const v = parseNum(sizeInput.value);
    if (v === undefined || v < 10 || v > 2000) {
      sizeInput.value = String(longSideMm);
      return toast("O lado maior tem que ficar entre 10 e 2000 mm.", "warn");
    }
    longSideMm = v;
    applySize();
    renderSize();
    schedule(150);
  };
  sizeInput.addEventListener("change", commitSize);
  sizeInput.addEventListener("keydown", (e) => e.key === "Enter" && commitSize());

  const penSelect = h(
    "select",
    { "aria-label": "Caneta deste desenho" },
    ...profile.pens.map((p) => h("option", { value: p.id, selected: p.id === pen.id }, `${p.name} (${p.widthMm.toLocaleString("pt-BR")} mm)`)),
  );
  penSelect.addEventListener("change", () => {
    pen = penOf(profile, penSelect.value);
    s.penMm = pen.widthMm;
    renderSize();
    schedule(150);
  });

  function renderMode() {
    modeHint.textContent =
      s.mode === "line"
        ? "Cada linha do desenho vira um traço único da caneta. Para desenho de contorno, planta, texto vazado."
        : s.mode === "ink"
          ? "Traço fino vira linha única; área preta mais larga que a caneta vira contorno com hachura. Para gravura, nanquim, logotipo cheio."
          : "Foto não tem linhas: o tom vira hachura. Quanto mais escuro, mais direções se cruzam. É uma interpretação, não uma cópia.";
    fillBox.hidden = s.mode !== "ink";
    photoBox.hidden = s.mode !== "photo";
    strokeBox.hidden = s.mode === "photo";
  }

  function renderSize() {
    if (!img) return;
    const p = paperSize();
    const fits = p.w <= zone.maxX - zone.minX + 0.01 && p.h <= zone.maxY - zone.minY + 0.01;
    const penPx = s.penMm / s.mmPerPx;
    sizeNote.textContent =
      `No papel: ${Math.round(p.w)} × ${Math.round(p.h)} mm${fits ? "" : " — não cabe na folha"}. ` +
      `Cada pixel da imagem vale ${s.mmPerPx.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mm; a caneta de ${s.penMm.toLocaleString("pt-BR")} mm cobre ${penPx.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} pixel(s).` +
      (turned ? " Deitado: o topo da imagem fica do lado direito da mesa." : "");
    sizeNote.className = fits ? "hint" : "notice";
  }

  append(fillBox, [
    h("h3", null, "Áreas cheias"),
    check("Contornar a área", () => s.outline, (v) => (s.outline = v)),
    range("Distância da hachura", 0, 4, 0.1, () => s.hatchSpacingMm, (v) => (s.hatchSpacingMm = v), (v) => (v === 0 ? "sem hachura" : `${v.toLocaleString("pt-BR", { minimumFractionDigits: 1 })} mm`), "Menor = mais escuro e mais demorado. 0 = só o contorno."),
    range("Ângulo da hachura", 0, 175, 5, () => s.hatchAngleDeg, (v) => (s.hatchAngleDeg = v), (v) => `${v}°`),
    check("Hachura cruzada", () => s.hatchCross, (v) => (s.hatchCross = v), "Uma segunda hachura, a 90° da primeira"),
  ]);

  const mmFmt = (v: number) => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 1 })} mm`;
  append(photoBox, [
    h("h3", null, "Hachura dos tons"),
    range("Direções que se cruzam", 1, 4, 1, () => s.photoLevels, (v) => (s.photoLevels = v), (v) => String(v), "Mais direções = sombras mais escuras e mais tempo de máquina"),
    range("Distância da hachura", 0.8, 6, 0.1, () => s.photoSpacingMm, (v) => (s.photoSpacingMm = v), mmFmt, "Menor = mais escuro e mais demorado"),
    range("Ângulo da hachura", 0, 175, 5, () => s.hatchAngleDeg, (v) => (s.hatchAngleDeg = v), (v) => `${v}°`),
    range("Suavizar os tons", 0.3, 4, 0.1, () => s.photoSmoothMm, (v) => (s.photoSmoothMm = v), mmFmt, "Maior = manchas mais lisas e menos detalhe"),
    range("Claro ou escuro", -100, 100, 5, () => s.ink, (v) => (s.ink = v), (v) => (v === 0 ? "normal" : v > 0 ? `+${v}` : String(v)), "Para a direita, mais hachura"),
    range("Tracinho mínimo", 0.5, 10, 0.5, () => s.hatchMinMm, (v) => (s.hatchMinMm = v), mmFmt, "Linhas mais curtas que isto não valem a descida da caneta"),
    check("A imagem tem fundo escuro", () => s.invert, (v) => (s.invert = v)),
  ]);
  append(side, [
    h("h3", null, "Tipo de desenho"),
    mode.el,
    modeHint,
    h("h3", null, "Tamanho no papel"),
    orient.el,
    h("label", { class: "field" }, "Lado maior (mm)", sizeInput),
    h("label", { class: "field", title: "É a largura da caneta que decide o que vira linha única e o que vira área com hachura. Dá para trocar depois, no passo 1." }, "Caneta", penSelect),
    sizeNote,
    fillBox,
    photoBox,
    strokeBox,
    h("h3", null, "Resultado"),
    stats,
    budget,
  ]);
  append(strokeBox, [
    h("h3", null, "Ajustes do traço"),
    range("Tinta", -100, 100, 5, () => s.ink, (v) => (s.ink = v), (v) => (v === 0 ? "normal" : v > 0 ? `+${v}` : String(v)), "Mais para a direita, mais coisa vira traço"),
    range("Linhas claras", 0, 1, 0.05, () => s.faint, (v) => (s.faint = v), pct, "Quanto das linhas apagadas entra no traçado"),
    range("Nitidez", 0, 1.5, 0.1, () => s.sharpen, (v) => (s.sharpen = v), pct, "Separa linhas que estão quase encostadas"),
    range("Limpar sujeira", 0, 12, 0.5, () => s.speckPx, (v) => (s.speckPx = v), px, "Manchas menores que isto somem"),
    range("Tirar rebarbas", 0, 4, 0.25, () => s.spurPx, (v) => (s.spurPx = v), px, "Fiapos mais curtos que isto somem"),
    range("Suavizar curvas", 0, 1, 0.05, () => s.smooth, (v) => (s.smooth = v), pct),
    range("Endireitar retas", 0, 1.5, 0.1, () => s.straighten, (v) => (s.straighten = v), (v) => (v === 0 ? "desligado" : px(v)), "Trechos retos viram retas de verdade"),
    check("Manter os pontinhos soltos", () => s.dots, (v) => (s.dots = v), "Cada pontinho é uma descida da caneta. Num céu estrelado são centenas: tirar poupa o servo."),
    check("A imagem tem fundo escuro", () => s.invert, (v) => (s.invert = v)),
  ]);

  // ------------------------------------------------------------------ traçar
  async function run() {
    if (!img) return;
    timer = undefined;
    busy.hidden = false;
    busyFill.style.width = "2%";
    busyLabel.textContent = "Começando…";
    stats.textContent = "Calculando o traçado…";
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(s));
    } catch {
      /* sem armazenamento: só não lembra */
    }
    try {
      const { result: r, ms } = await tracer.run(img.gray, { ...s }, (f, label) => {
        busyFill.style.width = `${Math.round(f * 100)}%`;
        busyLabel.textContent = label;
      });
      result = r;
      resultPath = geometryPath(r.geometry);
      fresh = true;
      busy.hidden = true;
      placeBtn.disabled = r.geometry.subpaths.length === 0;
      const st = r.stats;
      const lengthMm = st.lengthPx * s.mmPerPx;
      const drawS = (lengthMm / profile.feed.fixed) * 60;
      const parts: string[] = [];
      if (st.strokes) parts.push(`${st.strokes.toLocaleString("pt-BR")} traços`);
      if (st.dots) parts.push(`${st.dots.toLocaleString("pt-BR")} pontos`);
      if (st.outlines) parts.push(`${st.outlines.toLocaleString("pt-BR")} contornos`);
      if (st.hatches) parts.push(`${st.hatches.toLocaleString("pt-BR")} hachuras`);
      stats.textContent =
        r.geometry.subpaths.length === 0
          ? "Não achei traço nenhum com estes ajustes. Aumente a Tinta ou as Linhas claras."
          : `${parts.join(", ")}. Cerca de ${fmtLength(lengthMm)} de tinta, uns ${fmtDuration(drawS)} só desenhando a F${profile.feed.fixed}. ` +
            `Calculado em ${fmtDuration(ms / 1000)} (ampliação interna de ${st.scale}×). O tempo certo, com as subidas da caneta, aparece no passo Conferir.`;
      // docs/REGRAS_GCODE.md, seção 9: acima de 2-3 h o risco de falha da caneta aumenta
      budget.hidden = drawS < 3 * 3600 || r.geometry.subpaths.length === 0;
      budget.textContent = `São mais de 3 horas de máquina, e acima disso o risco de a caneta falhar aumenta. Para encurtar: ${s.mode === "line" ? "diminua o tamanho no papel ou limpe mais sujeira" : "aumente a distância da hachura, use menos direções ou diminua o tamanho no papel"}.`;
      draw();
    } catch (e) {
      if (e instanceof CancelledError) return;
      busy.hidden = true;
      stats.textContent = "";
      console.error(e);
      toast(`O traçado falhou: ${(e as Error).message}`, "error", 9000);
    }
  }

  // ------------------------------------------------------------------ colocar na mesa
  function place() {
    if (!img || !result || !fresh) return;
    const k = s.mmPerPx;
    const w = img.gray.width * k, hh = img.gray.height * k;
    const H = store.state.profile.workArea.height;
    const cx = (zone.minX + zone.maxX) / 2;
    const cy = H - (zone.minY + zone.maxY) / 2; // cena: Y para baixo
    // deitado = girado 90° no sentido horário: o topo da imagem vai para o lado X+ (REGRAS_GCODE.md, seção 8)
    const m: Mat2D = turned ? [0, k, -k, 0, cx + hh / 2, cy - w / 2] : [k, 0, 0, k, cx - w / 2, cy - hh / 2];
    const name = img.name.replace(/\.[^.]+$/, "") + (s.mode === "line" ? " (traço)" : s.mode === "ink" ? " (preto e branco)" : " (foto)");
    const d = createDrawing(crypto.randomUUID(), name, result.geometry, m, pen.id === penOf(profile, undefined).id ? undefined : pen.id);
    store.commit("Vetorizar imagem", (doc) => addDrawing(doc, d));
    store.setSelection([d.id]);
    toast(`"${name}" está na mesa. Posicione no passo 1 e confira no passo 2.`);
    close();
  }

  function close() {
    if (timer) clearTimeout(timer);
    tracer.cancel();
    ro.disconnect();
    img?.bitmap.close();
    dialog.close();
    dialog.remove();
  }
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });

  const title = h("strong", null, `Vetorizar ${file.name}`);
  append(dialog, [
    h("header", { class: "settings-head" }, title, h("button", { class: "close", title: "Fechar sem colocar na mesa", "aria-label": "Fechar", onclick: close }, "✕")),
    h("div", { class: "trace-main" }, stage, side),
    h("footer", { class: "settings-foot" }, h("span", { class: "hint" }, "Role o mouse para aproximar, arraste para mover, dois cliques para ver tudo."), h("span", { class: "spacer" }), h("button", { onclick: close }, "Cancelar"), placeBtn),
  ]);
  renderMode();
  setView("result");
  dialog.showModal();

  loadImage(file)
    .then((loaded) => {
      img = loaded;
      placeholder.remove();
      turned = fitScale(true) > fitScale(false) * 1.02;
      longSideMm = Math.round(Math.max(loaded.gray.width, loaded.gray.height) * fitScale(turned));
      sizeInput.value = String(longSideMm);
      orient.sync();
      applySize();
      renderSize();
      if (loaded.reducedFrom) toast(`A imagem era grande (${loaded.reducedFrom.width} × ${loaded.reducedFrom.height} px) e foi reduzida para ${loaded.gray.width} × ${loaded.gray.height} px. O traçado continua fiel.`, "info", 8000);
      fit();
      draw();
      void run();
    })
    .catch((e: Error) => {
      toast(e.message, "error", 9000);
      close();
    });

}
