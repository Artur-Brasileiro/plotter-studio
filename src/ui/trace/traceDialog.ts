import { isDark, luminance } from "../../core/color";
import { addDrawing, createDrawing, type Drawing } from "../../core/document";
import { flattenSubPath } from "../../core/geometry/flatten";
import type { Mat2D } from "../../core/geometry/mat2d";
import type { SubPath } from "../../core/geometry/path";
import { penOf, type MachineProfile, type Pen } from "../../core/machine";
import type { Store } from "../../core/store";
import { backgroundRgb, colorLayers, findPalette, lightOnDark, paperClass, strokeColors, type ColorLayer, type Palette } from "../../core/trace/colors";
import { borderMedian, colorfulness, DARK_BACKGROUND } from "../../core/trace/illus";
import { analyzeImage, faintForPattern, suggestedMode, type ImageKind } from "../../core/trace/kind";
import { strokeParts } from "../../core/trace/parts";
import { autoScale, DEFAULT_TRACE, STROKE_KIND, type TraceMode, type TraceOptions, type TraceResult } from "../../core/trace/traceImage";
import type { GrayImage } from "../../core/trace/types";
import { saveProfile } from "../../storage/profileStore";
import { CancelledError, loadImage, PlanEstimator, Tracer, type LoadedImage } from "../../trace/client";
import type { LayerTime } from "../../trace/planWorker";
import { append, clear, h, toast } from "../dom";
import { parseNum } from "../panels/propertiesPanel";
import { onPaperChange, paperColor } from "../paper";
import { createPaperPicker } from "../paperPicker";
import { fmtDuration, fmtLength } from "../planner";

type View = "result" | "both" | "original";
type Settings = { -readonly [K in keyof TraceOptions]: TraceOptions[K] };

const PREFS_KEY = "plotter-studio:trace";
/** Folga entre o desenho e a borda da folha ao encaixar (mm de cada lado). */
const SHEET_MARGIN = 5;
/** A partir desta fração de pixels coloridos, a tela sugere o tipo "Ilustração". */
const COLORFUL = 0.03;
/** Imagem "quase toda escura" (planta azul, cena noturna): a partir desta fração de pixels escuros. */
const MOSTLY_DARK = 0.75;
/** docs/REGRAS_GCODE.md, seção 9: acima de 2-3 h o risco de falha da caneta aumenta. */
const LONG_JOB_S = 3 * 3600;
/** "Precisão alta" amplia a imagem um degrau a mais por dentro, até este tamanho (px): acima disso falta memória. */
const PRECISE_MAX_PX = 45_000_000;
/** Ajustes que são de cada imagem: não são lembrados de uma para a outra. */
const PER_IMAGE: readonly (keyof TraceOptions)[] = ["mmPerPx", "penMm", "scale", "invert", "minLineMm", "fillBackground"];

/** O nome de cada tipo de desenho, como aparece nos botões. */
const MODE_NAME: Record<TraceMode, string> = { line: "Traço", ink: "Preto e branco", illus: "Ilustração", photo: "Foto" };
/** Para que serve cada tipo, em uma linha: é o que a pessoa lê para escolher, antes de qualquer cálculo. */
const MODE_FOR: Record<TraceMode, string> = {
  line: "Desenho de linhas: contorno, planta (mesmo de fundo azul), lápis, texto. Cada linha vira um traço da caneta.",
  ink: "Desenho de linhas com partes cheias: nanquim, mangá, logotipo, planta com letreiro. A área cheia ganha contorno e hachura.",
  illus: "Pintura, render, desenho pintado. Ficam só os contornos das formas: texto e linha fina se perdem.",
  photo: "Fotografia. Não tem linhas: o claro e o escuro viram hachura cruzada.",
};
const MODES: readonly TraceMode[] = ["line", "ink", "illus", "photo"];

/** Três pontos de partida do tipo Ilustração: detalhe, linhas fracas e traço mínimo (mm). */
const ILLUS_STYLES: readonly { name: string; title: string; detail: number; edge: number; minStrokeMm: number }[] = [
  { name: "Limpo", title: "Só as formas grandes: poucas linhas, plota rápido", detail: 0.5, edge: 0.4, minStrokeMm: 4 },
  { name: "Equilibrado", title: "O meio-termo: serve para a maioria das ilustrações", detail: 0.75, edge: 0.5, minStrokeMm: 2.5 },
  { name: "Detalhado", title: "Para gravura e desenho cheio de linha fina: entra o detalhe miúdo, e demora mais", detail: 1, edge: 0.8, minStrokeMm: 1.5 },
];

/** Caneta de uma camada: a do desenho (sem valor), outra do estojo (id) ou nenhuma. */
const SKIP = "-";
const NEW_PEN = "+";

function loadPrefs(): Partial<Settings> {
  try {
    const d = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(DEFAULT_TRACE)) if (typeof d[k] === typeof def && !PER_IMAGE.includes(k as keyof TraceOptions)) out[k] = d[k];
    return out as Partial<Settings>;
  } catch {
    return {};
  }
}

function addToPath(p: Path2D, sp: SubPath): void {
  p.moveTo(sp.start.x, sp.start.y);
  for (const s of sp.segments) {
    if (s.kind === "line") p.lineTo(s.to.x, s.to.y);
    else p.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y);
  }
  if (sp.closed) p.closePath();
}

/** Comprimento de um traço, em px da imagem. */
function subPathLength(sp: SubPath): number {
  const pts = flattenSubPath(sp, 0.25).points;
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** Os traços que uma caneta vai desenhar: é o que aparece na tela e o que vai para a mesa. */
interface PenGroup {
  readonly pen: Pen;
  readonly subpaths: SubPath[];
  readonly path: Path2D;
}

/**
 * Tela de vetorização: a imagem vira traço de caneta aqui mesmo. À esquerda, a imagem e o resultado (com
 * zoom), na cor do papel e das canetas. À direita, de cima para baixo: o tipo de desenho, o papel e a
 * caneta, o tamanho, os poucos ajustes que mais mudam o resultado (o resto fica em "Mais ajustes"), as
 * camadas (por cor e, se a pessoa quiser, por traço fino e grosso, cada uma com a sua caneta) e o tempo de
 * máquina. "Colocar na mesa" cria um desenho por caneta, todos no mesmo conjunto.
 */
export function openTraceDialog(store: Store, file: File): void {
  const dialog = h("dialog", { class: "sheet trace", "aria-label": "Vetorizar imagem" });
  document.body.append(dialog);
  const tracer = new Tracer();
  const estimator = new PlanEstimator();
  const profile = (): MachineProfile => store.state.profile;
  const zone = profile().drawZone;
  // a caneta do desenho: é ela que decide o que é "fino" e o que é "área cheia"
  let pen = penOf(profile(), undefined);
  const s: Settings = { ...DEFAULT_TRACE, ...loadPrefs(), penMm: pen.widthMm };
  // o traçado só começa depois que a pessoa escolhe o tipo de desenho: calcular no tipo errado é tempo jogado fora
  let started = false;
  let img: LoadedImage | undefined;
  /** A imagem como "claro sobre o fundo" (para desenhar o claro nos tipos de traço); calculada quando precisa */
  let lightGray: GrayImage | undefined;
  let result: TraceResult | undefined;
  let fresh = false;
  let turned = false;
  let longSideMm = 0;
  let view: View = "result";
  let zoom = 1, panX = 0, panY = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // camadas: a paleta é da imagem; a cor e o comprimento de cada traço são do resultado; a divisão em
  // fino e grosso e a caneta de cada camada são escolhas da pessoa (não precisam traçar de novo)
  let palette: Palette | undefined;
  let classOf: Uint8Array = new Uint8Array(0);
  let lengths: number[] = [];
  let layers: ColorLayer[] = [];
  let layerOf: Uint8Array = new Uint8Array(0);
  const layerPen = new Map<string, string>();
  // o que a imagem é (desenho de linhas? tem grade no fundo?), medido uma vez ao abrir
  let kind: ImageKind | undefined;
  let suggested: TraceMode | undefined;
  /** "Linhas claras" como a pessoa deixou: é este valor que fica lembrado, não o que a grade obrigou */
  const ownFaint = s.faint;
  let faintTouched = false;
  let gridRemoved = false;
  let precise = false;
  let splitOn = false;
  let thinMm = 0.5;
  let thinTouched = false;
  let groups: PenGroup[] = [];
  let allPath: Path2D | undefined;

  // ------------------------------------------------------------------ palco
  const canvas = h("canvas");
  const placeholder = h("div", { class: "placeholder" }, "Abrindo a imagem…");
  const busyLabel = h("span");
  const busyFill = h("div", { class: "progress-fill" });
  const busy = h("div", { class: "trace-busy", hidden: true }, busyLabel, h("div", { class: "progress" }, busyFill));
  const viewButtons = (["result", "both", "original"] as const).map((v) =>
    h("button", { onclick: () => setView(v) }, v === "result" ? "Resultado" : v === "both" ? "Os dois" : "Original"),
  );
  const viewBar = h("div", { class: "trace-view", hidden: true }, ...viewButtons);
  const stage = h("div", { class: "trace-stage" }, canvas, placeholder, viewBar, busy);

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
    // a folha, da cor do papel escolhido
    c.fillStyle = "rgba(20, 33, 61, 0.18)";
    c.fillRect(3 / zoom, 4 / zoom, w, hh);
    c.fillStyle = paperColor();
    c.fillRect(0, 0, w, hh);
    const has = !!allPath;
    if (view !== "result" || !has) {
      c.imageSmoothingEnabled = zoom < 3;
      c.globalAlpha = view === "both" && has ? 0.4 : 1;
      c.drawImage(img.bitmap, 0, 0);
      c.globalAlpha = 1;
    }
    if (has && view !== "original") {
      c.lineCap = "round";
      c.lineJoin = "round";
      c.globalAlpha = fresh ? 1 : 0.45;
      if (view === "both") {
        // por cima da imagem: tudo de uma cor só, para comparar
        c.lineWidth = Math.max(s.penMm / s.mmPerPx, 1 / zoom);
        c.strokeStyle = "#c0362c";
        c.stroke(allPath!);
      } else {
        // como vai sair: cada caneta com a cor e a largura dela (nunca menos de 1 px de tela)
        for (const g of groups) {
          c.lineWidth = Math.max(g.pen.widthMm / s.mmPerPx, 1 / zoom);
          c.strokeStyle = g.pen.color;
          c.stroke(g.path);
        }
      }
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
  /** Onde o desenho cai na mesa: no meio da folha (a mesma conta vale para o tempo e para "Colocar na mesa"). */
  const placement = (): Mat2D => {
    const k = s.mmPerPx;
    const w = img!.gray.width * k, hh = img!.gray.height * k;
    const H = profile().workArea.height;
    const cx = (zone.minX + zone.maxX) / 2;
    const cy = H - (zone.minY + zone.maxY) / 2; // cena: Y para baixo
    // deitado = girado 90° no sentido horário: o topo da imagem vai para o lado X+ (REGRAS_GCODE.md, seção 8)
    return turned ? [0, k, -k, 0, cx + hh / 2, cy - w / 2] : [k, 0, 0, k, cx - w / 2, cy - hh / 2];
  };

  // ------------------------------------------------------------------ controles
  const side = h("div", { class: "trace-side panel" });
  const emptyNote = h("p", { class: "notice", hidden: true });
  const timeBox = h("div", { class: "time-box", hidden: true });
  // o tempo também fica no rodapé, sempre à vista; clicar leva aos detalhes
  const timeChip = h("button", { class: "time-chip", hidden: true, title: "Ver os detalhes do tempo de máquina", onclick: () => timeBox.scrollIntoView({ behavior: "smooth", block: "center" }) });
  const sizeNote = h("p", { class: "hint" });
  const placeBtn = h("button", { class: "primary big", disabled: true, onclick: () => place() }, "Colocar na mesa");
  const fillBox = h("div", { class: "panel-section" });
  const illusBox = h("div", { class: "panel-section" });
  const photoBox = h("div", { class: "panel-section" });
  const strokeBox = h("div", { class: "panel-section" });
  const layerBox = h("div", { class: "panel-section", hidden: true });
  // imagem colorida num tipo feito para desenho de traço: avisa que existe um tipo próprio
  let colorful = false;
  const colorNote = h("p", { class: "notice", hidden: true });
  // fundo escuro: decide, até a pessoa escolher, se a caneta desenha o escuro ou o claro da imagem
  let darkBackground = false;
  let mostlyDark = false;
  let invertTouched = false;
  const darkNote = h("p", { class: "hint", hidden: true });
  const penNote = h("div", { class: "notice", hidden: true });
  // desenho de linhas num tipo que apaga texto e linha fina: avisa e oferece a troca
  const lineNote = h("div", { class: "notice", hidden: true });
  const gridNote = h("p", { class: "hint", hidden: true }, "Tirei a grade do fundo. Para trazê-la de volta, leve “Linhas claras” para a direita.");
  /** Tudo o que precisa reler o valor quando um ajuste muda por fora do próprio controle. */
  const refreshers: (() => void)[] = [];

  const schedule = (delay = 650) => {
    if (!started) return;
    fresh = false;
    placeBtn.disabled = true;
    estimator.cancel();
    draw();
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  const seg = <T extends string | boolean | number>(options: [T, string, string?][], get: () => T | undefined, set: (v: T) => void) => {
    const buttons = options.map(([v, label, title]) =>
      h(
        "button",
        {
          title,
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
    refreshers.push(sync);
    return { el: h("div", { class: "seg-row" }, ...buttons), sync };
  };

  /** Um controle deslizante. `change` é o que acontece depois de mexer (o padrão é traçar de novo). */
  const range = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, title = "", change: () => void = () => schedule()) => {
    const out = h("output", null, fmt(get()));
    const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(get()), "aria-label": label });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      set(v);
      out.textContent = fmt(v);
      refreshers.forEach((f) => f());
      change();
    });
    refreshers.push(() => {
      if (Number(input.value) !== get()) input.value = String(get());
      out.textContent = fmt(get());
    });
    return h("label", { class: "range", title }, h("span", null, label), out, input);
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void, title = "", change: () => void = () => schedule(150)) => {
    const cb = h("input", { type: "checkbox", checked: get() });
    cb.addEventListener("change", () => {
      set(cb.checked);
      change();
    });
    return h("label", { class: "check", title }, cb, label);
  };
  /** Os ajustes que quase ninguém precisa mexer ficam recolhidos. */
  const more = (...children: HTMLElement[]) => h("details", { class: "more" }, h("summary", null, "Mais ajustes"), ...children);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const px = (v: number) => `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} px`;
  const mmFmt = (v: number) => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 1 })} mm`;
  const minFmt = (v: number) => (v === 0 ? "fica tudo" : mmFmt(v));
  const signed = (v: number) => (v === 0 ? "normal" : v > 0 ? `+${v}` : String(v));
  const angle = (v: number) => `${v}°`;

  const mode = seg<TraceMode>(
    MODES.map((m) => [m, MODE_NAME[m], MODE_FOR[m]]),
    () => s.mode,
    (v) => {
      s.mode = v;
      defaultInvert();
      dropGrid();
      renderMode();
      schedule(150);
    },
  );
  /**
   * Planta com grade no fundo: nos tipos de traço, "Linhas claras" desce até a grade ficar de fora, senão ela
   * entra como centenas de tracinhos e pontos. Só enquanto a pessoa não mexeu nesse controle.
   */
  function dropGrid() {
    if (faintTouched || !kind || kind.faintLevel <= 0 || (s.mode !== "line" && s.mode !== "ink")) return;
    const lower = faintForPattern(kind.faintLevel, ownFaint);
    gridRemoved = lower < ownFaint;
    if (gridRemoved) s.faint = lower;
    refreshers.forEach((f) => f());
  }
  /** A ampliação interna do traçado: a de sempre, ou um degrau a mais ("Precisão alta"), se couber na memória. */
  const baseScale = () => autoScale(img!.gray.width, img!.gray.height);
  const canBePrecise = () => !!img && baseScale() < 8 && img.gray.width * img.gray.height * (baseScale() + 1) ** 2 <= PRECISE_MAX_PX;

  // --- papel e caneta
  const paperDark = () => isDark(paperColor());
  /**
   * O que a caneta desenha, enquanto a pessoa não escolhe.
   *  - Papel claro: o escuro da imagem. A exceção é a imagem quase toda escura de linhas claras (planta
   *    azul) nos tipos de traço e na Foto: aí interessa o claro. A Ilustração em papel claro nunca inverte.
   *  - Papel escuro: o claro da imagem, que sai igual a ela (o fundo escuro é o próprio papel). A exceção é
   *    o desenho de linhas em fundo CLARO nos tipos de traço: pintar o fundo inteiro não faz sentido, então
   *    a caneta clara desenha as linhas, como giz em quadro-negro.
   */
  function defaultInvert() {
    if (!invertTouched) {
      const strokes = s.mode === "line" || s.mode === "ink";
      s.invert = paperDark() ? !strokes || darkBackground : darkBackground && mostlyDark && s.mode !== "illus";
    }
    draws.sync();
  }
  const draws = seg<boolean>(
    [
      [false, "O escuro da imagem", "A caneta passa onde a imagem é escura (o normal, com caneta escura em papel claro)"],
      [true, "O claro da imagem", "A caneta passa onde a imagem é clara: para caneta clara em papel escuro, ou para tirar o negativo de uma planta azul"],
    ],
    () => s.invert,
    (v) => {
      s.invert = v;
      invertTouched = true;
      renderMode();
      schedule(150);
    },
  );
  const drawsField = h("label", { class: "field" }, "A caneta desenha", draws.el);
  const paperPicker = createPaperPicker("Papel");
  const offPaper = onPaperChange(() => {
    const before = s.invert;
    defaultInvert();
    renderMode();
    if (s.invert !== before) schedule(150);
    else draw();
  });

  /** Primeira escolha do tipo: é aqui que o traçado começa. */
  const choose = (m: TraceMode) => {
    if (!img || started) return;
    started = true;
    s.mode = m;
    mode.sync();
    defaultInvert();
    dropGrid();
    renderMode();
    schedule(0);
  };
  const choices = MODES.map((m) => h("button", { class: "choice", disabled: true, onclick: () => choose(m) }, h("strong", null, MODE_NAME[m]), h("span", null, MODE_FOR[m])));
  /** Marca o cartão do tipo que combina com a imagem (só quando ela é claramente um desenho de linhas). */
  const markSuggested = () => {
    choices.forEach((b, i) => {
      const on = MODES[i] === suggested;
      b.classList.toggle("suggested", on);
      b.querySelector(".tag")?.remove();
      if (on) b.querySelector("strong")!.append(h("em", { class: "tag" }, "parece ser este"));
    });
    if (suggested && !started) choices[MODES.indexOf(suggested)].focus();
  };
  const chooser = h("div", { class: "panel-section" }, h("h3", null, "Que tipo de imagem é esta?"), ...choices, h("p", { class: "hint" }, "Dá para trocar depois."));

  const orient = seg<boolean>(
    [
      [false, "Em pé"],
      [true, "Deitado", "O topo da imagem fica do lado direito da mesa"],
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

  const penLabel = (p: Pen) => `${p.name} (${p.widthMm.toLocaleString("pt-BR")} mm)`;
  const penSelect = h("select", { "aria-label": "Caneta deste desenho", title: "É a largura da caneta que decide o que vira linha única e o que vira área com hachura" });
  const fillPenSelect = () => {
    clear(penSelect);
    append(penSelect, profile().pens.map((p) => h("option", { value: p.id, selected: p.id === pen.id }, penLabel(p))));
  };
  fillPenSelect();
  const setPen = (p: Pen) => {
    const widthChanged = p.widthMm !== pen.widthMm;
    pen = p;
    s.penMm = pen.widthMm;
    fillPenSelect();
    renderMode();
    if (widthChanged) schedule(150);
    else applyPens();
  };
  penSelect.addEventListener("change", () => setPen(penOf(profile(), penSelect.value)));

  /** Põe uma caneta nova no estojo (no começo: cor é plotada antes da preta) e guarda o perfil. */
  const addPen = (name: string, color: string, widthMm: number): Pen => {
    const p0 = profile();
    const same = p0.pens.find((q) => q.name === name && q.color.toLowerCase() === color.toLowerCase());
    if (same) return same;
    const created: Pen = { id: `caneta-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`, name, widthMm, color, offsetX: 0, offsetY: 0 };
    const next: MachineProfile = { ...p0, pens: [created, ...p0.pens] };
    store.setProfile(next);
    try {
      saveProfile(next);
    } catch {
      /* sem armazenamento: a caneta vale só até fechar a página */
    }
    fillPenSelect();
    toast(`A caneta “${name}” entrou no estojo. Acerte a largura dela em Configurações → Estojo de canetas.`, "info", 7000);
    return created;
  };

  const sections = h("div", { class: "trace-sections" });
  function renderMode() {
    // antes da escolha só aparecem os quatro tipos; depois, tudo o mais
    chooser.hidden = started;
    sections.hidden = !started;
    fillBox.hidden = s.mode !== "ink";
    illusBox.hidden = s.mode !== "illus";
    photoBox.hidden = s.mode !== "photo";
    strokeBox.hidden = s.mode === "photo" || s.mode === "illus";

    // "a caneta desenha" só aparece quando há o que decidir: imagem de fundo escuro, papel escuro, ou depois de mexer
    const dark = paperDark();
    drawsField.hidden = !(darkBackground || dark || invertTouched);
    darkNote.hidden = drawsField.hidden || !(darkBackground || dark);
    if (!darkNote.hidden)
      darkNote.textContent = dark
        ? s.invert
          ? "O que é escuro na imagem fica sendo o próprio papel."
          : darkBackground
            ? "Assim o desenho sai em negativo."
            : "A caneta clara desenha as linhas, como giz em quadro-negro."
        : s.invert
          ? "A caneta desenha as linhas claras; o fundo escuro fica em branco."
          : s.mode === "illus"
            ? "A Ilustração deixa o fundo escuro em branco."
            : `Em papel claro, a caneta pinta o fundo escuro inteiro${s.mode === "ink" ? " (ou desmarque “Pintar o fundo”)" : ""}.`;

    // caneta que não aparece no papel escolhido
    const contrast = Math.abs(luminance(pen.color) - luminance(paperColor()));
    penNote.hidden = !img || contrast >= 0.25;
    if (!penNote.hidden) {
      clear(penNote);
      // "caneta clara" é branca, prata, amarelo-claro: uma verde ou vermelha viva não serve de substituta
      const light = profile().pens.find((p) => luminance(p.color) >= 0.75);
      append(penNote, [
        `A caneta ${pen.name} quase não aparece neste papel. `,
        dark
          ? light
            ? h("button", { onclick: () => setPen(light) }, `Usar a caneta ${light.name}`)
            : h("button", { onclick: () => setPen(addPen("Branca", "#ffffff", 0.5)) }, "Criar uma caneta branca")
          : "Escolha outra caneta ou outro papel.",
      ]);
    }

    // uma planta azul também é "colorida", mas é desenho de linhas: o aviso só vale para fundo claro,
    // e nunca para uma imagem que foi reconhecida como desenho de linhas
    const wrongType = started && colorful && !darkBackground && !suggested && (s.mode === "line" || s.mode === "ink");
    colorNote.hidden = !wrongType;
    if (wrongType) colorNote.textContent = `Imagem colorida: o tipo ${MODE_NAME.illus} costuma ficar melhor.`;
    // o contrário: desenho de linhas na Ilustração ou na Foto, que reduzem e alisam a imagem
    const better = suggested;
    lineNote.hidden = !started || !better || s.mode === "line" || s.mode === "ink";
    if (!lineNote.hidden && better) {
      clear(lineNote);
      append(lineNote, [
        `Esta imagem é um desenho de linhas. No tipo ${MODE_NAME[better]}, o texto e os detalhes finos saem inteiros. `,
        h("button", { onclick: () => {
          s.mode = better;
          mode.sync();
          defaultInvert();
          dropGrid();
          renderMode();
          schedule(150);
        } }, `Trocar para ${MODE_NAME[better]}`),
      ]);
    }
    gridNote.hidden = !gridRemoved || faintTouched || (s.mode !== "line" && s.mode !== "ink");
  }

  function renderSize() {
    if (!img) return;
    const p = paperSize();
    const fits = p.w <= zone.maxX - zone.minX + 0.01 && p.h <= zone.maxY - zone.minY + 0.01;
    sizeNote.textContent = `${Math.round(p.w)} × ${Math.round(p.h)} mm no papel${fits ? "" : ": não cabe na folha"}`;
    sizeNote.className = fits ? "hint" : "notice";
  }

  // --- os ajustes de cada tipo: à vista, só os que mais mudam o resultado
  const hatchAngle = () => range("Ângulo da hachura", 0, 175, 5, () => s.hatchAngleDeg, (v) => (s.hatchAngleDeg = v), angle);
  const smooth = () => range("Suavizar curvas", 0, 1, 0.05, () => s.smooth, (v) => (s.smooth = v), pct);
  const straighten = () => range("Endireitar retas", 0, 1.5, 0.1, () => s.straighten, (v) => (s.straighten = v), (v) => (v === 0 ? "desligado" : px(v)), "Trechos retos viram retas de verdade");

  append(fillBox, [
    h("h3", null, "Áreas cheias"),
    check("Pintar o fundo", () => s.fillBackground, (v) => (s.fillBackground = v), "O fundo é a área cheia que encosta na borda da imagem. Desmarcado, fica só o contorno dele, e o desenho sai bem mais rápido."),
    range("Distância da hachura", 0, 4, 0.1, () => s.hatchSpacingMm, (v) => (s.hatchSpacingMm = v), (v) => (v === 0 ? "sem hachura" : mmFmt(v)), "Menor = mais escuro e mais demorado. 0 = só o contorno."),
    more(
      check("Contornar a área", () => s.outline, (v) => (s.outline = v)),
      hatchAngle(),
      check("Hachura cruzada", () => s.hatchCross, (v) => (s.hatchCross = v), "Uma segunda hachura, a 90° da primeira"),
    ),
  ]);
  const preciseSeg = seg<boolean>(
    [
      [false, "Normal"],
      [true, "Alta", "Lê a imagem com mais ampliação: ajuda em letra muito miúda. Demora mais e quase nunca muda o desenho, porque o limite costuma ser a largura da caneta."],
    ],
    () => precise,
    (v) => {
      if (v && !canBePrecise()) return toast("Esta imagem já está na ampliação máxima que cabe na memória.", "info");
      precise = v;
      schedule(150);
    },
  );
  append(strokeBox, [
    h("h3", null, "Traço"),
    range("Traço mínimo", 0, 10, 0.5, () => s.minLineMm, (v) => (s.minLineMm = v), minFmt, "Traços mais curtos que isto somem. Os tracinhos de 1 ou 2 mm são metade das descidas da caneta e quase nada da tinta: tirar encurta muito o tempo."),
    range("Tinta", -100, 100, 5, () => s.ink, (v) => (s.ink = v), signed, "Para a direita, mais coisa vira traço"),
    range(
      "Linhas claras",
      0,
      1,
      0.05,
      () => s.faint,
      (v) => {
        s.faint = v;
        faintTouched = true;
        gridNote.hidden = true;
      },
      pct,
      "Quanto das linhas apagadas entra no traçado. Para a esquerda, some a grade do fundo de uma planta",
    ),
    gridNote,
    more(
      h("label", { class: "field" }, "Precisão", preciseSeg.el),
      range("Nitidez", 0, 1.5, 0.1, () => s.sharpen, (v) => (s.sharpen = v), pct, "Separa linhas que estão quase encostadas"),
      range("Limpar sujeira", 0, 12, 0.5, () => s.speckPx, (v) => (s.speckPx = v), px, "Manchas menores que isto somem"),
      range("Tirar rebarbas", 0, 4, 0.25, () => s.spurPx, (v) => (s.spurPx = v), px, "Fiapos mais curtos que isto somem"),
      smooth(),
      straighten(),
      check("Manter os pontinhos soltos", () => s.dots, (v) => (s.dots = v), "Cada pontinho é uma descida da caneta"),
    ),
  ]);
  const illusStyle = seg<number>(
    ILLUS_STYLES.map((st, i) => [i, st.name, st.title]),
    () => {
      const i = ILLUS_STYLES.findIndex((st) => st.detail === s.detail && st.edge === s.edge && st.minStrokeMm === s.minStrokeMm);
      return i < 0 ? undefined : i;
    },
    (i) => {
      const st = ILLUS_STYLES[i];
      s.detail = st.detail;
      s.edge = st.edge;
      s.minStrokeMm = st.minStrokeMm;
      refreshers.forEach((f) => f());
      schedule(150);
    },
  );
  append(illusBox, [
    h("h3", null, "Ilustração"),
    illusStyle.el,
    range("Sombras", 0, 1, 0.05, () => s.shade, (v) => (s.shade = v), (v) => (v === 0 ? "sem sombra" : pct(v)), "Quanto da imagem ganha hachura. No zero ficam só as linhas, e o desenho sai bem mais rápido."),
    more(
      range("Detalhe", 0, 1, 0.05, () => s.detail, (v) => (s.detail = v), pct, "Para a esquerda, só as formas grandes"),
      range("Linhas fracas", 0, 1, 0.05, () => s.edge, (v) => (s.edge = v), pct, "Para a direita, as bordas de pouco contraste também viram linha"),
      range("Traço mínimo", 0, 10, 0.5, () => s.minStrokeMm, (v) => (s.minStrokeMm = v), mmFmt, "Traços mais curtos que isto somem"),
      range("Distância da hachura", 0.8, 6, 0.1, () => s.shadeSpacingMm, (v) => (s.shadeSpacingMm = v), mmFmt, "Menor = sombra mais escura e mais demorada"),
      hatchAngle(),
      smooth(),
      straighten(),
    ),
  ]);
  append(photoBox, [
    h("h3", null, "Hachura dos tons"),
    range("Distância da hachura", 0.8, 6, 0.1, () => s.photoSpacingMm, (v) => (s.photoSpacingMm = v), mmFmt, "Menor = mais escuro e mais demorado"),
    range("Direções que se cruzam", 1, 4, 1, () => s.photoLevels, (v) => (s.photoLevels = v), (v) => String(v), "Mais direções = sombras mais escuras e mais tempo de máquina"),
    range("Claro ou escuro", -100, 100, 5, () => s.ink, (v) => (s.ink = v), signed, "Para a direita, mais hachura"),
    more(
      range("Realçar os tons", 0, 1, 0.05, () => s.photoBoost, (v) => (s.photoBoost = v), (v) => (v === 0 ? "desligado" : pct(v)), "Para imagem escura ou de pouco contraste: espalha os tons pela escala toda"),
      hatchAngle(),
      range("Suavizar os tons", 0.3, 4, 0.1, () => s.photoSmoothMm, (v) => (s.photoSmoothMm = v), mmFmt, "Maior = manchas mais lisas e menos detalhe"),
      range("Tracinho mínimo", 0.5, 10, 0.5, () => s.hatchMinMm, (v) => (s.hatchMinMm = v), mmFmt, "Linhas mais curtas que isto não valem a descida da caneta"),
    ),
  ]);
  append(sections, [
    h("h3", null, "Tipo"),
    mode.el,
    colorNote,
    lineNote,
    h("h3", null, "Papel e caneta"),
    paperPicker.el,
    h("label", { class: "field" }, "Caneta", penSelect),
    penNote,
    drawsField,
    darkNote,
    h("h3", null, "Tamanho"),
    h("div", { class: "size-row" }, orient.el, h("label", { class: "field" }, "Lado maior (mm)", sizeInput)),
    sizeNote,
    fillBox,
    illusBox,
    photoBox,
    strokeBox,
    layerBox,
    h("h3", null, "Tempo de máquina"),
    emptyNote,
    timeBox,
  ]);
  append(side, [chooser, sections]);

  // ------------------------------------------------------------------ camadas e canetas
  /** A caneta de uma camada: a que a pessoa escolheu, ou a do desenho. undefined = não desenhar. */
  const penFor = (layer: ColorLayer): Pen | undefined => {
    const choice = layerPen.get(layer.key);
    if (choice === SKIP) return undefined;
    return (choice && profile().pens.find((p) => p.id === choice)) || pen;
  };

  /** Separa os traços por caneta (é o que a tela mostra e o que vai para a mesa). */
  function buildGroups() {
    groups = [];
    allPath = undefined;
    if (!result) return;
    const byPen = new Map<string, PenGroup>();
    const pens = layers.map(penFor);
    allPath = new Path2D();
    result.geometry.subpaths.forEach((sp, i) => {
      addToPath(allPath!, sp);
      const p = layers.length ? pens[layerOf[i]] : pen;
      if (!p) return;
      let g = byPen.get(p.id);
      if (!g) byPen.set(p.id, (g = { pen: p, subpaths: [], path: new Path2D() }));
      g.subpaths.push(sp);
      addToPath(g.path, sp);
    });
    // na ordem do estojo, que é a ordem de plotar
    const order = profile().pens.map((p) => p.id);
    groups = [...byPen.values()].sort((a, b) => order.indexOf(a.pen.id) - order.indexOf(b.pen.id));
  }

  /** O que a segunda divisão separa neste tipo: nada (Foto), contornos e sombras, ou a largura do traço. */
  const splitKind = (): "none" | "shade" | "width" => (s.mode === "photo" ? "none" : s.mode === "illus" ? "shade" : "width");

  /**
   * Um bom ponto de partida para "Fino até": a largura do meio dos traços deste desenho (metade do
   * comprimento das linhas fica de cada lado). A largura depende do tamanho no papel, então não há valor fixo.
   */
  function suggestThin(): number {
    const r = result;
    if (!r) return thinMm;
    const w: [number, number][] = [];
    r.kinds.forEach((k, i) => {
      if (k === STROKE_KIND.stroke || k === STROKE_KIND.dot) w.push([r.widthsPx[i] * s.mmPerPx, lengths[i] + 1e-6]);
    });
    if (!w.length) return thinMm;
    w.sort((a, b) => a[0] - b[0]);
    const half = w.reduce((t, x) => t + x[1], 0) / 2;
    let acc = 0;
    for (const [width, len] of w) {
      acc += len;
      if (acc >= half) return Math.min(3, Math.max(0.1, Math.round(width / 0.05) * 0.05));
    }
    return thinMm;
  }

  /** As camadas deste resultado: por cor e, se a pessoa pediu, também por parte (fino e grosso). */
  function relayer() {
    layers = [];
    layerOf = new Uint8Array(0);
    if (!result || !palette || !result.geometry.subpaths.length) return;
    if (splitOn && !thinTouched && splitKind() === "width") thinMm = suggestThin();
    const split = splitOn ? strokeParts(result, s.mode, s.mmPerPx, thinMm) : undefined;
    ({ layers, layerOf } = colorLayers(palette, classOf, lengths, paperClass(palette, s.invert), split));
  }

  /** As camadas: uma linha para cada, com a caneta que vai desenhá-la. */
  let rowsKey = "";
  function renderLayers() {
    clear(layerBox);
    rowsKey = layers.map((l) => l.key).join("|");
    const kind = splitKind();
    layerBox.hidden = !started || !result || (layers.length < 2 && kind === "none");
    if (layerBox.hidden) return;
    const rows =
      layers.length < 2
        ? []
        : layers.map((layer) => {
            const choice = layerPen.get(layer.key) ?? "";
            const sel = h(
              "select",
              { "aria-label": `Caneta da camada ${layer.name}` },
              h("option", { value: "", selected: choice === "" }, penLabel(pen)),
              ...profile().pens.filter((p) => p.id !== pen.id).map((p) => h("option", { value: p.id, selected: choice === p.id }, penLabel(p))),
              h("option", { value: NEW_PEN }, "Criar uma caneta desta cor…"),
              h("option", { value: SKIP, selected: choice === SKIP }, "Não desenhar"),
            );
            sel.addEventListener("change", () => {
              if (sel.value === NEW_PEN) layerPen.set(layer.key, addPen(layer.name, layer.color, pen.widthMm).id);
              else if (sel.value === "") layerPen.delete(layer.key);
              else layerPen.set(layer.key, sel.value);
              applyPens();
            });
            return h(
              "div",
              { class: `color-layer${penFor(layer) ? "" : " skip"}`, title: `${layer.strokes.toLocaleString("pt-BR")} traços, ${fmtLength(layer.lengthPx * s.mmPerPx)} de tinta` },
              h("span", { class: `dot${layer.part === "fino" ? " thin" : ""}`, style: `--c:${layer.color}`, "aria-hidden": "true" }),
              h("span", { class: "what" }, layer.name),
              sel,
            );
          });
    const splitCheck =
      kind === "none"
        ? null
        : check(
            kind === "width" ? "Separar o traço fino do grosso" : "Separar contornos e sombras",
            () => splitOn,
            (v) => (splitOn = v),
            kind === "width" ? "Os detalhes finos viram uma camada e os traços fortes, outra: dá para usar a caneta fina numa e a grossa na outra" : "Os contornos viram uma camada e a hachura das sombras, outra",
            () => {
              relayer();
              applyPens();
            },
          );
    const thinRange =
      splitOn && kind === "width"
        ? range(
            "Fino até",
            0.1,
            3,
            0.05,
            () => thinMm,
            (v) => {
              thinMm = v;
              thinTouched = true;
            },
            (v) => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} mm`,
            "As linhas do desenho até esta largura (no papel) vão para a camada fina",
            () => {
              relayer();
              applyPens(false);
            },
          )
        : null;
    append(layerBox, [h("h3", null, "Camadas"), splitCheck, thinRange, rows.length ? h("div", { class: "color-layers" }, ...rows) : null]);
  }

  /** Depois de mexer nas camadas: refaz os grupos, a lista, o desenho e o tempo (não precisa traçar de novo). */
  function applyPens(rebuildList = true) {
    buildGroups();
    // arrastando "Fino até", a lista só é refeita quando o conjunto de camadas muda (senão o controle perderia o foco)
    if (rebuildList || layers.map((l) => l.key).join("|") !== rowsKey) {
      const had = document.activeElement?.getAttribute("aria-label") === "Fino até";
      renderLayers();
      if (had) layerBox.querySelector<HTMLInputElement>('input[aria-label="Fino até"]')?.focus();
    }
    placeBtn.disabled = !fresh || groups.length === 0;
    draw();
    void estimate();
  }

  /** A cor e o comprimento de cada traço do resultado (a parte demorada das camadas: uma vez por traçado). */
  function analyze() {
    classOf = new Uint8Array(0);
    lengths = [];
    if (!img || !result || !result.geometry.subpaths.length) return;
    const { width, height } = img.gray;
    palette ??= findPalette(img.rgba, width, height);
    classOf = strokeColors(result.geometry, img.rgba, width, height, palette, { paper: paperClass(palette, s.invert) });
    lengths = result.geometry.subpaths.map(subPathLength);
  }

  // ------------------------------------------------------------------ tempo de máquina
  async function estimate() {
    if (!img || !result || !groups.length) {
      timeBox.hidden = timeChip.hidden = true;
      return;
    }
    timeBox.hidden = timeChip.hidden = false;
    timeBox.className = "time-box";
    timeChip.className = "time-chip";
    timeBox.textContent = "Calculando…";
    timeChip.textContent = "calculando o tempo…";
    const m = placement();
    const def = penOf(profile(), undefined).id;
    let times: readonly LayerTime[];
    try {
      times = await estimator.run({
        drawings: groups.map((g) => ({ geometry: { subpaths: g.subpaths }, transform: m, penId: g.pen.id === def ? undefined : g.pen.id })),
        profile: profile(),
        job: store.state.job,
      });
    } catch (e) {
      if (e instanceof CancelledError) return;
      console.error(e);
      timeBox.textContent = "Não consegui calcular. O tempo aparece no passo Conferir.";
      timeChip.hidden = true;
      return;
    }
    const totalS = times.reduce((t, l) => t + l.totalS, 0);
    const waitS = times.reduce((t, l) => t + l.waitS, 0);
    const descents = times.reduce((t, l) => t + l.descents, 0);
    const drawMm = times.reduce((t, l) => t + l.drawMm, 0);
    const long = totalS > LONG_JOB_S;
    const shorter =
      s.mode === "photo"
        ? "hachura mais aberta, menos direções, caneta mais grossa ou tamanho menor"
        : s.mode === "illus"
          ? "menos Sombras, estilo Limpo ou tamanho menor"
          : `Traço mínimo maior${s.mode === "ink" ? ", hachura mais aberta, sem “Pintar o fundo”" : ""} ou tamanho menor`;
    clear(timeBox);
    timeBox.className = `time-box${long ? " long" : ""}`;
    timeChip.className = `time-chip${long ? " long" : ""}`;
    timeChip.textContent = `${fmtDuration(totalS)} de máquina`;
    append(timeBox, [
      h("b", null, fmtDuration(totalS)),
      `${descents.toLocaleString("pt-BR")} descidas da caneta · ${fmtLength(drawMm)} de tinta`,
      waitS > 300 ? h("span", { class: "line" }, `Inclui ${fmtDuration(waitS)} de espera para o servo não esquentar.`) : null,
      times.length > 1 ? h("span", { class: "line" }, times.map((l) => `${l.penName}: ${fmtDuration(l.totalS)}`).join(" · ")) : null,
      long ? h("span", { class: "line" }, `Mais de 3 horas aumenta o risco de a caneta falhar. Para encurtar: ${shorter}.`) : null,
    ]);
  }

  // ------------------------------------------------------------------ traçar
  /** A imagem que vai para o traçador: o cinza de sempre, ou "o claro sobre o fundo" para desenhar o claro. */
  const grayFor = (): GrayImage => {
    if (!s.invert || s.mode === "photo" || s.mode === "illus") return img!.gray;
    // pela luminância, um vermelho vivo sobre preto valeria um terço do branco; aqui vale quase o mesmo
    const { width, height } = img!.gray;
    lightGray ??= { width, height, data: lightOnDark(img!.rgba, width, height, backgroundRgb(img!.rgba, width, height)) };
    return lightGray;
  };

  async function run() {
    if (!img || !started) return;
    timer = undefined;
    busy.hidden = false;
    busyFill.style.width = "2%";
    busyLabel.textContent = "Começando…";
    try {
      // fica lembrado o "Linhas claras" da pessoa, não o que a grade desta imagem obrigou
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...s, faint: faintTouched ? s.faint : ownFaint }));
    } catch {
      /* sem armazenamento: só não lembra */
    }
    try {
      const { result: r } = await tracer.run(
        grayFor(),
        { ...s, scale: precise && canBePrecise() ? baseScale() + 1 : undefined },
        (f, label) => {
          busyFill.style.width = `${Math.round(f * 100)}%`;
          busyLabel.textContent = label;
        },
        img.rgba,
      );
      const first = !result;
      result = r;
      busyLabel.textContent = "Separando as camadas…";
      await new Promise((ok) => setTimeout(ok)); // deixa a tela mostrar a mensagem antes da conta
      analyze();
      relayer();
      buildGroups();
      fresh = true;
      busy.hidden = true;
      if (first) {
        // até aqui a tela mostrava a imagem original; agora há um resultado para ver e comparar
        viewBar.hidden = false;
        view = "result";
        viewButtons.forEach((b, i) => b.classList.toggle("active", i === 0));
      }
      renderLayers();
      placeBtn.disabled = groups.length === 0;
      emptyNote.hidden = r.geometry.subpaths.length > 0;
      if (!emptyNote.hidden)
        emptyNote.textContent = `Não achei traço nenhum com estes ajustes. ${s.mode === "illus" ? "Experimente o estilo Detalhado." : s.mode === "photo" ? "Leve “Claro ou escuro” para a direita." : "Aumente a Tinta, ou diminua o Traço mínimo."}`;
      draw();
      void estimate();
    } catch (e) {
      if (e instanceof CancelledError) return;
      busy.hidden = true;
      console.error(e);
      toast(`O traçado falhou: ${(e as Error).message}`, "error", 9000);
    }
  }

  // ------------------------------------------------------------------ colocar na mesa
  function place() {
    if (!img || !result || !fresh || !groups.length) return;
    const m = placement();
    const def = penOf(profile(), undefined).id;
    const name = `${img.name.replace(/\.[^.]+$/, "")} (${MODE_NAME[s.mode].toLowerCase()})`;
    // um desenho por caneta, todos no mesmo conjunto: na mesa eles andam juntos, e cada caneta é plotada em separado
    const set = groups.length > 1 ? crypto.randomUUID() : undefined;
    const made: Drawing[] = groups.map((g) => createDrawing(crypto.randomUUID(), name, { subpaths: g.subpaths }, m, g.pen.id === def ? undefined : g.pen.id, set));
    store.commit("Vetorizar imagem", (doc) => made.reduce(addDrawing, doc));
    store.setSelection(made.map((d) => d.id));
    toast(made.length > 1 ? `“${name}” está na mesa, em ${made.length} camadas (uma por caneta).` : `“${name}” está na mesa.`);
    close();
  }

  function close() {
    if (timer) clearTimeout(timer);
    tracer.cancel();
    estimator.cancel();
    ro.disconnect();
    offPaper();
    paperPicker.dispose();
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
    h("footer", { class: "settings-foot" }, h("span", { class: "hint" }, "Roda do mouse aproxima · arrastar move · dois cliques mostram tudo"), h("span", { class: "spacer" }), timeChip, h("button", { onclick: close }, "Cancelar"), placeBtn),
  ]);
  renderMode();
  setView("original");
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
      // nada é calculado ainda: a pessoa vê a imagem, escolhe o tipo e só então o traçado começa
      colorful = colorfulness(loaded.rgba) > COLORFUL;
      darkBackground = borderMedian(loaded.gray) / 255 < DARK_BACKGROUND;
      const g = loaded.gray.data;
      const step = Math.max(1, Math.floor(g.length / 200_000));
      let darkCount = 0, seen = 0;
      for (let i = 0; i < g.length; i += step, seen++) if (g[i] < 128) darkCount++;
      mostlyDark = darkCount / Math.max(1, seen) >= MOSTLY_DARK;
      defaultInvert();
      choices.forEach((b) => (b.disabled = false));
      renderMode();
      fit();
      draw();
      choices[0].focus();
      // depois de a imagem aparecer: é um desenho de linhas? tem grade no fundo? (a conta leva até um segundo)
      setTimeout(() => {
        if (img !== loaded) return;
        kind = analyzeImage(loaded.rgba, loaded.gray.width, loaded.gray.height);
        const better = suggestedMode(kind);
        suggested = better;
        markSuggested();
        if (started) {
          // a pessoa já escolheu o tipo antes de a conta terminar
          const before = s.faint;
          dropGrid();
          renderMode();
          if (s.faint !== before) schedule(150);
        }
      }, 60);
    })
    .catch((e: Error) => {
      toast(e.message, "error", 9000);
      close();
    });
}
