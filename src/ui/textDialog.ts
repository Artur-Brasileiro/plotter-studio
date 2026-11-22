import { addDrawing, createDrawing } from "../core/document";
import { flattenGeometry } from "../core/geometry/flatten";
import { IDENTITY } from "../core/geometry/mat2d";
import { polylineLength } from "../core/geometry/simplify";
import { penOf } from "../core/machine";
import type { Store } from "../core/store";
import type { FontId } from "../core/text/fontData";
import { DEFAULT_TEXT, FONT_NAMES, textGeometry, type TextAlign, type TextOptions, type TextResult } from "../core/text/hershey";
import { append, h, toast } from "./dom";
import { parseNum } from "./panels/propertiesPanel";
import { fmtDuration, fmtLength } from "./planner";

type Settings = { -readonly [K in keyof TextOptions]: TextOptions[K] };
const PREFS_KEY = "plotter-studio:text";
const QUICK_HEIGHTS = [5, 10, 20, 40];

function loadPrefs(): Partial<Settings> {
  try {
    const d = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(DEFAULT_TEXT)) if (typeof d[k] === typeof def) out[k] = d[k];
    if (!(String(out.font) in FONT_NAMES)) delete out.font;
    return out as Partial<Settings>;
  } catch {
    return {};
  }
}

/**
 * Tela de texto: letras de TRAÇO ÚNICO (a caneta escreve com uma linha só, como à mão). O texto vira um
 * desenho comum na mesa: dá para mover, girar e redimensionar como qualquer outro.
 */
export function openTextDialog(store: Store): void {
  const dialog = h("dialog", { class: "sheet trace", "aria-label": "Escrever texto" });
  document.body.append(dialog);
  const profile = store.state.profile;
  const zone = profile.drawZone;
  const zoneW = zone.maxX - zone.minX, zoneH = zone.maxY - zone.minY;
  let pen = penOf(profile, undefined);
  const s: Settings = { ...DEFAULT_TEXT, ...loadPrefs() };
  let result: TextResult | undefined;

  // ------------------------------------------------------------------ palco: a folha, com o texto no meio
  const canvas = h("canvas");
  const stage = h("div", { class: "trace-stage" }, canvas);
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
    const zoom = Math.min((r.width - 40) / zoneW, (r.height - 40) / zoneH);
    const ox = (r.width - zoneW * zoom) / 2, oy = (r.height - zoneH * zoom) / 2;
    c.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * ox, dpr * oy);
    c.fillStyle = "rgba(20, 33, 61, 0.18)";
    c.fillRect(3 / zoom, 4 / zoom, zoneW, zoneH);
    c.fillStyle = "#fff";
    c.fillRect(0, 0, zoneW, zoneH);
    if (!result || result.geometry.subpaths.length === 0) return;
    const p = new Path2D();
    const dx = (zoneW - result.width) / 2, dy = (zoneH - result.height) / 2;
    for (const sp of result.geometry.subpaths) {
      p.moveTo(sp.start.x + dx, sp.start.y + dy);
      for (const g of sp.segments) {
        if (g.kind === "line") p.lineTo(g.to.x + dx, g.to.y + dy);
        else p.bezierCurveTo(g.c1.x + dx, g.c1.y + dy, g.c2.x + dx, g.c2.y + dy, g.to.x + dx, g.to.y + dy);
      }
    }
    // o traço aparece com a largura real da caneta (nunca menos de 1 px de tela)
    c.lineWidth = Math.max(pen.widthMm, 1 / zoom);
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = pen.color;
    c.stroke(p);
  }
  const ro = new ResizeObserver(() => draw());
  ro.observe(stage);

  // ------------------------------------------------------------------ controles
  const side = h("div", { class: "trace-side panel" });
  const stats = h("p", { class: "hint" });
  const fitNote = h("p", { class: "notice", hidden: true });
  const placeBtn = h("button", { class: "primary big", disabled: true, onclick: () => place() }, "Colocar na mesa");
  const input = h("textarea", { rows: "4", placeholder: "Escreva aqui. Enter começa outra linha.", "aria-label": "Texto", spellcheck: "false" });
  input.value = "";

  function update() {
    result = textGeometry(input.value, s);
    const has = result.geometry.subpaths.length > 0;
    placeBtn.disabled = !has;
    fitNote.hidden = !has || (result.width <= zoneW + 0.01 && result.height <= zoneH + 0.01);
    fitNote.textContent = `Com esta altura o texto fica com ${Math.round(result.width)} × ${Math.round(result.height)} mm e não cabe na folha (${Math.round(zoneW)} × ${Math.round(zoneH)} mm). Diminua a altura ou quebre em mais linhas.`;
    if (!has) stats.textContent = input.value.trim() ? "Nenhum destes caracteres existe nesta letra." : "";
    else {
      const lengthMm = flattenGeometry(result.geometry, IDENTITY, 0.05).reduce((a, pl) => a + polylineLength(pl.points), 0);
      const missing = result.missing.length ? ` Ficaram de fora (a letra não tem): ${result.missing.join(" ")}.` : "";
      stats.textContent =
        `No papel: ${Math.round(result.width)} × ${Math.round(result.height)} mm. ${result.strokes.toLocaleString("pt-BR")} descidas da caneta, ` +
        `${fmtLength(lengthMm)} de traço, uns ${fmtDuration((lengthMm / profile.feed.fixed) * 60)} só desenhando.${missing}`;
    }
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(s));
    } catch {
      /* sem armazenamento: só não lembra */
    }
    draw();
  }
  input.addEventListener("input", update);

  const seg = <T extends string>(options: [T, string][], get: () => T, set: (v: T) => void) => {
    const buttons = options.map(([v, label]) =>
      h(
        "button",
        {
          onclick: () => {
            set(v);
            sync();
            update();
          },
        },
        label,
      ),
    );
    const sync = () => buttons.forEach((b, i) => b.classList.toggle("on", options[i][0] === get()));
    sync();
    return h("div", { class: "seg-row" }, ...buttons);
  };
  const range = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, title = "") => {
    const out = h("output", null, fmt(get()));
    const el = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(get()), "aria-label": label });
    el.addEventListener("input", () => {
      set(Number(el.value));
      out.textContent = fmt(Number(el.value));
      update();
    });
    return h("label", { class: "range", title }, h("span", null, label), out, el);
  };

  const heightInput = h("input", { type: "text", inputMode: "decimal", "aria-label": "Altura da letra maiúscula (mm)" });
  const quick = QUICK_HEIGHTS.map((v) => h("button", { onclick: () => setHeight(v) }, String(v)));
  const setHeight = (v: number) => {
    s.capHeightMm = v;
    heightInput.value = v.toLocaleString("pt-BR");
    quick.forEach((b, i) => b.classList.toggle("active", QUICK_HEIGHTS[i] === v));
    update();
  };
  const commitHeight = () => {
    const v = parseNum(heightInput.value);
    if (v === undefined || v < 1.5 || v > 300) {
      heightInput.value = s.capHeightMm.toLocaleString("pt-BR");
      return toast("A altura da letra tem que ficar entre 1,5 e 300 mm.", "warn");
    }
    setHeight(v);
  };
  heightInput.addEventListener("change", commitHeight);
  heightInput.addEventListener("keydown", (e) => e.key === "Enter" && commitHeight());

  const penSelect = h(
    "select",
    { "aria-label": "Caneta deste texto" },
    ...profile.pens.map((p) => h("option", { value: p.id, selected: p.id === pen.id }, `${p.name} (${p.widthMm.toLocaleString("pt-BR")} mm)`)),
  );
  penSelect.addEventListener("change", () => {
    pen = penOf(profile, penSelect.value);
    draw();
  });
  const smooth = h("input", { type: "checkbox", checked: s.smooth });
  smooth.addEventListener("change", () => {
    s.smooth = smooth.checked;
    update();
  });

  append(side, [
    h("h3", null, "Texto"),
    input,
    h("p", { class: "hint" }, "Letras de traço único: a caneta escreve com uma linha só, como à mão. Acentos e cedilha funcionam."),
    h("h3", null, "Letra"),
    seg<FontId>(Object.entries(FONT_NAMES) as [FontId, string][], () => s.font, (v) => (s.font = v)),
    h("div", { class: "row center" }, h("label", { class: "field", style: "width:120px" }, "Altura da maiúscula (mm)", heightInput), ...quick),
    h("label", { class: "field" }, "Caneta", penSelect),
    h("h3", null, "Linhas"),
    seg<TextAlign>(
      [
        ["left", "À esquerda"],
        ["center", "Ao centro"],
        ["right", "À direita"],
      ],
      () => s.align,
      (v) => (s.align = v),
    ),
    range("Entrelinha", 0.7, 2.5, 0.05, () => s.lineSpacing, (v) => (s.lineSpacing = v), (v) => `${Math.round(v * 100)}%`),
    range("Espaço entre as letras", 0, 0.6, 0.02, () => s.letterSpacing, (v) => (s.letterSpacing = v), (v) => (v === 0 ? "normal" : `+${Math.round(v * 100)}%`)),
    h("label", { class: "check", title: "As curvas das letras ficam redondas em vez de facetadas. Faz diferença em letra grande." }, smooth, "Curvas suaves"),
    h("h3", null, "Resultado"),
    stats,
    fitNote,
  ]);

  // ------------------------------------------------------------------ colocar na mesa
  function place() {
    if (!result || result.geometry.subpaths.length === 0) return;
    const H = store.state.profile.workArea.height;
    // centro da folha; se o texto for maior que ela, o canto de baixo à esquerda fica no canto da folha
    const x = result.width <= zoneW ? zone.minX + (zoneW - result.width) / 2 : zone.minX;
    const yTop = result.height <= zoneH ? zone.maxY - (zoneH - result.height) / 2 : zone.minY + result.height;
    const first = input.value.trim().split("\n")[0].slice(0, 24);
    const name = `Texto: ${first}${input.value.trim().length > first.length ? "…" : ""}`;
    const d = createDrawing(crypto.randomUUID(), name, result.geometry, [1, 0, 0, 1, x, H - yTop], pen.id === penOf(profile, undefined).id ? undefined : pen.id);
    store.commit("Escrever texto", (doc) => addDrawing(doc, d));
    store.setSelection([d.id]);
    toast(`"${first}" está na mesa. Posicione no passo 1 e confira no passo 2.`);
    close();
  }

  function close() {
    ro.disconnect();
    dialog.close();
    dialog.remove();
  }
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });

  append(dialog, [
    h("header", { class: "settings-head" }, h("strong", null, "Escrever texto"), h("button", { class: "close", title: "Fechar sem colocar na mesa", "aria-label": "Fechar", onclick: close }, "✕")),
    h("div", { class: "trace-main" }, stage, side),
    h("footer", { class: "settings-foot" }, h("span", { class: "hint" }, "A folha aparece no tamanho da sua zona de desenho, com o traço na largura da caneta."), h("span", { class: "spacer" }), h("button", { onclick: close }, "Cancelar"), placeBtn),
  ]);
  dialog.showModal();
  setHeight(s.capHeightMm);
  input.focus();
}
