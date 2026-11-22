import { isDark, luminance } from "../core/color";
import type { Drawing, DrawingId } from "../core/document";
import { meanScale } from "../core/geometry/mat2d";
import type { Geometry } from "../core/geometry/path";
import { penOf } from "../core/machine";
import type { Store } from "../core/store";
import { removeStrokes, sceneStrokes, StrokeIndex, type EditStroke } from "../core/strokeEdit";
import { append, h, toast } from "./dom";
import { onPaperChange, paperColor } from "./paper";

/** O mouse pega o traço que estiver a até isto dele (pixels de tela). */
const PICK_PX = 6;
/** Arrastar menos que isto ainda conta como clique (pixels de tela). */
const DRAG_PX = 4;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 160;
/** Parou de aproximar ou de arrastar há este tempo (ms): o desenho é repintado nítido na vista nova. */
const SETTLE_MS = 140;

/** O desenho (ou só os subcaminhos que `keep` aceitar) como caminho do canvas, nas coordenadas do próprio desenho. */
function pathOf(g: Geometry, keep?: (subpath: number) => boolean): Path2D {
  const p = new Path2D();
  g.subpaths.forEach((sp, i) => {
    if (keep && !keep(i)) return;
    p.moveTo(sp.start.x, sp.start.y);
    for (const s of sp.segments) {
      if (s.kind === "line") p.lineTo(s.to.x, s.to.y);
      else p.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y);
    }
    if (sp.closed) p.closePath();
  });
  return p;
}

/** Caneta da cor do papel (preta em papel preto) não apareceria: nesta tela ela ganha um cinza que dá para ver. */
function legible(color: string, paper: string): string {
  if (Math.abs(luminance(color) - luminance(paper)) >= 0.18) return color;
  return isDark(paper) ? "#aab3c5" : "#7a8499";
}

const nf = (v: number) => v.toLocaleString("pt-BR");
const plural = (n: number, one: string, many: string) => `${nf(n)} ${n === 1 ? one : many}`;

/**
 * Tela "Apagar traços": os desenhos escolhidos aparecem grandes, cada traço (cada descida da caneta) pode
 * ser marcado com um clique ou com um retângulo, e Delete tira os marcados. "Concluir" guarda o desenho sem
 * eles, numa mudança só, que o Ctrl+Z da mesa desfaz. Nada aqui chega à máquina.
 *
 * Para um desenho de 20 mil traços continuar leve, a tela pinta em três camadas:
 *  - a base (folha, os outros desenhos, os traços que ficam) só é refeita quando um traço sai ou volta, ou
 *    quando a vista para de mexer; enquanto a pessoa aproxima ou arrasta, a tela estica a pintura pronta;
 *  - os marcados, só quando uma marca muda;
 *  - o traço embaixo do mouse e o retângulo, a cada movimento (é quase nada).
 */
export function openStrokeEditor(store: Store, ids: readonly DrawingId[]): void {
  if (document.querySelector("dialog.strokes")) return; // já está aberta (botão + dois cliques)
  const profile = store.state.profile;
  const doc = store.doc;
  const edited = doc.drawings.filter((d) => ids.includes(d.id));
  const others = doc.drawings.filter((d) => !ids.includes(d.id));
  const strokes: EditStroke[] = edited.flatMap((d) => sceneStrokes(d, profile.tolerance.chordMm));
  if (strokes.length === 0) {
    toast("Não há traços para apagar neste desenho.", "warn");
    return;
  }
  const n = strokes.length;
  const index = new StrokeIndex(strokes.map((s) => s.points));
  /** 1 = apagado nesta tela */
  const removed = new Uint8Array(n);
  /** 0 = como o "Marcar os curtos" decidir; 1 = marcado à mão; 2 = desmarcado à mão */
  const manual = new Uint8Array(n);
  let shortMm = 0;
  /** Cada Delete é uma entrada: os traços que saíram naquela vez */
  const undoStack: number[][] = [];
  const isMarked = (i: number) => !removed[i] && (manual[i] === 1 || (manual[i] === 0 && strokes[i].lengthMm < shortMm));

  // de subcaminho do desenho → número do traço nesta tela (−1 = subcaminho vazio, que não é traço)
  const strokeOfSubpath = new Map<DrawingId, Int32Array>();
  for (const d of edited) strokeOfSubpath.set(d.id, new Int32Array(d.geometry.subpaths.length).fill(-1));
  strokes.forEach((s, i) => (strokeOfSubpath.get(s.drawingId)![s.subpath] = i));
  const basePaths = new Map<DrawingId, Path2D>();
  const rebuildBase = (d: Drawing) => {
    const map = strokeOfSubpath.get(d.id)!;
    basePaths.set(d.id, pathOf(d.geometry, (sp) => map[sp] < 0 || !removed[map[sp]]));
  };
  edited.forEach(rebuildBase);
  const contextPaths = new Map<DrawingId, Path2D>();
  const penMm = Math.max(...edited.map((d) => penOf(profile, d.penId).widthMm));

  // ------------------------------------------------------------------ palco
  const dialog = h("dialog", { class: "sheet strokes", "aria-label": "Apagar traços" });
  const canvas = h("canvas");
  const stage = h("div", { class: "trace-stage", tabIndex: 0, "aria-label": "Desenho: clique num traço para marcar" }, canvas);
  const baseLayer = document.createElement("canvas");
  const marksLayer = document.createElement("canvas");
  let zoom = 1, panX = 0, panY = 0;
  /** A vista em que as duas camadas prontas foram pintadas */
  let bz = 1, bx = 0, by = 0;
  let fitted = false;
  let baseDirty = true;
  let marksDirty = true;
  let hover = -1;
  let frame = 0;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let pointer: { x: number; y: number } | undefined; // última posição do mouse no palco (px)
  let rect: { x0: number; y0: number; x1: number; y1: number; unmark: boolean } | undefined; // em mm da cena

  const bounds = (() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      for (let i = 0; i < s.points.length; i += 2) {
        const x = s.points[i], y = s.points[i + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return { minX, minY, maxX, maxY };
  })();

  const fit = () => {
    const r = stage.getBoundingClientRect();
    const bw = Math.max(bounds.maxX - bounds.minX, 1), bh = Math.max(bounds.maxY - bounds.minY, 1);
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((r.width - 60) / bw, (r.height - 60) / bh)));
    panX = (r.width - bw * zoom) / 2 - bounds.minX * zoom;
    panY = (r.height - bh * zoom) / 2 - bounds.minY * zoom;
  };

  /** Pede um redesenho (um por quadro). */
  const invalidate = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    }
  };
  /** A base precisa ser repintada (traço saiu ou voltou, papel mudou, a vista assentou). */
  const repaint = () => {
    if (settle) clearTimeout(settle);
    settle = undefined;
    baseDirty = true;
    invalidate();
  };
  /** A vista mexeu: por enquanto a tela estica a pintura pronta; a nítida vem quando o movimento parar. */
  const viewChanged = (now = false) => {
    if (settle) clearTimeout(settle);
    if (now) return repaint();
    settle = setTimeout(repaint, SETTLE_MS);
    invalidate();
  };

  function draw() {
    const r = stage.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr), Hh = Math.round(r.height * dpr);
    if (canvas.width !== W || canvas.height !== Hh) {
      canvas.width = baseLayer.width = marksLayer.width = W;
      canvas.height = baseLayer.height = marksLayer.height = Hh;
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      baseDirty = true;
    }
    if (!fitted) {
      fit();
      fitted = true;
    }
    const paper = paperColor();
    const dark = isDark(paper);
    const MARK = dark ? "#ff7a6b" : "#c0362c";
    const HOVER = dark ? "#8fb8ff" : "#1b4fa8";
    /** Prepara uma camada para ser pintada na vista (z, x, y), já limpa. */
    const begin = (layer: HTMLCanvasElement, z: number, x: number, y: number) => {
      const c = layer.getContext("2d")!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, W, Hh);
      c.setTransform(dpr * z, 0, 0, dpr * z, dpr * x, dpr * y);
      c.lineCap = "round";
      c.lineJoin = "round";
      return c;
    };
    /** Pinta um desenho com a transformação dele; `width` é a largura do traço em mm da mesa. */
    const strokeDrawing = (c: CanvasRenderingContext2D, d: Drawing, path: Path2D, width: number) => {
      const m = d.transform;
      c.save();
      c.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      c.lineWidth = width / (meanScale(m) || 1);
      c.stroke(path);
      c.restore();
    };

    if (baseDirty) {
      bz = zoom;
      bx = panX;
      by = panY;
      const b = begin(baseLayer, bz, bx, by);
      // a folha (zona de desenho), na cor do papel escolhido
      const z = profile.drawZone;
      const zy = profile.workArea.height - z.maxY;
      b.fillStyle = "rgba(20, 33, 61, 0.18)";
      b.fillRect(z.minX + 3 / bz, zy + 4 / bz, z.maxX - z.minX, z.maxY - z.minY);
      b.fillStyle = paper;
      b.fillRect(z.minX, zy, z.maxX - z.minX, z.maxY - z.minY);
      // os outros desenhos da mesa, apagadinhos: só para a pessoa se localizar
      b.globalAlpha = 0.22;
      for (const d of others) {
        let p = contextPaths.get(d.id);
        if (!p) contextPaths.set(d.id, (p = pathOf(d.geometry)));
        const pen = penOf(profile, d.penId);
        b.strokeStyle = legible(pen.color, paper);
        strokeDrawing(b, d, p, Math.max(pen.widthMm, 1.25 / bz));
      }
      b.globalAlpha = 1;
      for (const d of edited) {
        const pen = penOf(profile, d.penId);
        b.strokeStyle = legible(pen.color, paper);
        strokeDrawing(b, d, basePaths.get(d.id)!, Math.max(pen.widthMm, 1.25 / bz)); // largura real da caneta, nunca menos de ~1 px
      }
      baseDirty = false;
      marksDirty = true;
    }
    if (marksDirty) {
      // marcados: um halo largo e o traço por cima, para aparecer mesmo quando a caneta já é vermelha
      const m = begin(marksLayer, bz, bx, by);
      const w = Math.max(penMm, 1.25 / bz);
      m.strokeStyle = MARK;
      for (const d of edited) {
        const map = strokeOfSubpath.get(d.id)!;
        const p = pathOf(d.geometry, (sp) => map[sp] >= 0 && isMarked(map[sp]));
        m.globalAlpha = 0.3;
        strokeDrawing(m, d, p, w + 6 / bz);
        m.globalAlpha = 1;
        strokeDrawing(m, d, p, w + 1.5 / bz);
      }
      marksDirty = false;
    }

    const c = canvas.getContext("2d");
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, Hh);
    // as camadas prontas, esticadas da vista em que foram pintadas para a vista de agora
    const k = zoom / bz;
    c.setTransform(k, 0, 0, k, dpr * (panX - bx * k), dpr * (panY - by * k));
    c.drawImage(baseLayer, 0, 0);
    c.drawImage(marksLayer, 0, 0);
    c.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
    c.lineCap = "round";
    c.lineJoin = "round";
    const lineMm = Math.max(penMm, 1.25 / zoom);
    if (hover >= 0 && !rect) {
      // embaixo do mouse: azul = "um clique marca este"; já marcado, continua vermelho, só mais grosso
      const on = isMarked(hover);
      const pts = strokes[hover].points;
      c.beginPath();
      c.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
      c.strokeStyle = on ? MARK : HOVER;
      c.lineWidth = lineMm + (on ? 4 : 2.5) / zoom;
      c.stroke();
    }
    if (rect) {
      const x = Math.min(rect.x0, rect.x1), y = Math.min(rect.y0, rect.y1);
      const w = Math.abs(rect.x1 - rect.x0), hh = Math.abs(rect.y1 - rect.y0);
      const color = rect.unmark ? (dark ? "#d5dbea" : "#44506a") : MARK;
      c.fillStyle = color;
      c.globalAlpha = 0.1;
      c.fillRect(x, y, w, hh);
      c.globalAlpha = 1;
      c.strokeStyle = color;
      c.lineWidth = 1.25 / zoom;
      c.setLineDash([5 / zoom, 4 / zoom]);
      c.strokeRect(x, y, w, hh);
      c.setLineDash([]);
    }
  }

  // ------------------------------------------------------------------ painel
  const count = h("p", { class: "stroke-count", "aria-live": "polite" });
  const deleteBtn = h("button", { title: "Tira do desenho os traços marcados (tecla Delete)", onclick: () => removeMarked() }, "Apagar os marcados");
  const clearBtn = h("button", { class: "quiet", title: "Tira todas as marcas (tecla Esc)", onclick: () => clearMarks() }, "Desmarcar tudo");
  const undoBtn = h("button", { title: "Traz de volta os últimos traços apagados (Ctrl+Z)", onclick: () => undoRemoval() }, "↶ Desfazer");
  const doneBtn = h("button", { class: "primary big", onclick: () => conclude() }, "Concluir");
  const shortOut = h("output", null, "desligado");
  const shortInput = h("input", { type: "range", min: "0", max: "20", step: "0.5", value: "0", "aria-label": "Marcar os traços curtos" });
  shortInput.addEventListener("input", () => {
    shortMm = Number(shortInput.value);
    shortOut.textContent = shortMm === 0 ? "desligado" : `menores que ${shortMm.toLocaleString("pt-BR", { minimumFractionDigits: 1 })} mm`;
    marksChanged();
  });

  const counts = () => {
    let marked = 0, gone = 0;
    for (let i = 0; i < n; i++) {
      if (removed[i]) gone++;
      else if (isMarked(i)) marked++;
    }
    return { marked, gone };
  };
  function renderPanel() {
    const { marked, gone } = counts();
    count.textContent = `${plural(n - gone, "traço", "traços")} · ${plural(marked, "marcado", "marcados")} · ${plural(gone, "apagado", "apagados")}`;
    deleteBtn.disabled = marked === 0;
    clearBtn.disabled = marked === 0;
    undoBtn.disabled = undoStack.length === 0;
    doneBtn.textContent = marked > 0 ? "Apagar os marcados e concluir" : "Concluir";
  }
  function marksChanged() {
    marksDirty = true;
    renderPanel();
    invalidate();
  }

  function removeMarked() {
    const list: number[] = [];
    for (let i = 0; i < n; i++) if (isMarked(i)) list.push(i);
    if (list.length === 0) return;
    for (const i of list) removed[i] = 1;
    undoStack.push(list);
    geometryChanged(list);
  }
  function undoRemoval() {
    const list = undoStack.pop();
    if (!list) return;
    for (const i of list) {
      removed[i] = 0;
      manual[i] = 1; // voltam como estavam antes do Delete: marcados
    }
    geometryChanged(list);
  }
  /** Traços saíram ou voltaram: refaz só os desenhos afetados e o que estava embaixo do mouse. */
  function geometryChanged(list: readonly number[]) {
    const touched = new Set(list.map((i) => strokes[i].drawingId));
    for (const d of edited) if (touched.has(d.id)) rebuildBase(d);
    updateHover();
    renderPanel();
    repaint();
  }
  function clearMarks() {
    manual.fill(0);
    shortMm = 0;
    shortInput.value = "0";
    shortOut.textContent = "desligado";
    marksChanged();
  }

  function conclude() {
    removeMarked(); // quem marcou e foi direto em "concluir" queria apagar (o botão diz isso)
    const map = new Map<DrawingId, number[]>();
    let total = 0;
    strokes.forEach((s, i) => {
      if (!removed[i]) return;
      total++;
      const list = map.get(s.drawingId);
      if (list) list.push(s.subpath);
      else map.set(s.drawingId, [s.subpath]);
    });
    if (total === 0) return close();
    // a tela trabalhou em cima destes desenhos: se algum mudou por fora, os números dos traços não valem mais
    const stale = edited.some((d) => store.doc.drawings.find((x) => x.id === d.id)?.geometry !== d.geometry);
    if (stale) {
      toast("O desenho mudou enquanto esta tela estava aberta. Nada foi apagado.", "warn", 8000);
      return close();
    }
    store.commit("Apagar traços", (docNow) => removeStrokes(docNow, map));
    toast(`${plural(total, "traço apagado", "traços apagados")}. Se mudar de ideia, Ctrl+Z na mesa traz de volta.`);
    close();
  }

  // ------------------------------------------------------------------ mouse
  const local = (e: { clientX: number; clientY: number }) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toScene = (p: { x: number; y: number }) => ({ x: (p.x - panX) / zoom, y: (p.y - panY) / zoom });
  const pick = (p: { x: number; y: number }) => {
    const s = toScene(p);
    return index.nearest(s.x, s.y, PICK_PX / zoom, removed);
  };

  type Gesture =
    | { kind: "pan"; x: number; y: number; px: number; py: number }
    | { kind: "press"; x: number; y: number }
    | { kind: "rect" };
  let gesture: Gesture | undefined;
  let spaceDown = false;

  function updateHover() {
    const next = pointer && !gesture ? pick(pointer) : -1;
    stage.classList.toggle("over", next >= 0);
    if (next === hover) return;
    hover = next;
    invalidate();
  }

  stage.addEventListener("pointerdown", (e) => {
    stage.focus();
    const p = local(e);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
      gesture = { kind: "pan", x: e.clientX, y: e.clientY, px: panX, py: panY };
      stage.classList.add("grabbing");
    } else if (e.button === 0) gesture = { kind: "press", x: p.x, y: p.y };
    else return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    pointer = local(e);
    if (!gesture) return updateHover();
    if (gesture.kind === "pan") {
      panX = gesture.px + e.clientX - gesture.x;
      panY = gesture.py + e.clientY - gesture.y;
      return viewChanged();
    }
    if (gesture.kind === "press") {
      if (Math.hypot(pointer.x - gesture.x, pointer.y - gesture.y) < DRAG_PX) return;
      const a = toScene(gesture);
      rect = { x0: a.x, y0: a.y, x1: a.x, y1: a.y, unmark: e.altKey };
      gesture = { kind: "rect" };
      hover = -1;
    }
    if (rect) {
      const b = toScene(pointer);
      rect.x1 = b.x;
      rect.y1 = b.y;
      rect.unmark = e.altKey;
      invalidate();
    }
  });
  const endGesture = (e: PointerEvent, cancelled: boolean) => {
    const g = gesture;
    gesture = undefined;
    stage.classList.remove("grabbing");
    if (!g) return;
    if (g.kind === "pan") viewChanged(true);
    else if (!cancelled && g.kind === "press") {
      // clique: marca ou desmarca o traço que está embaixo do mouse
      const i = pick(local(e));
      if (i >= 0) {
        manual[i] = isMarked(i) ? 2 : 1;
        marksChanged();
      }
    } else if (!cancelled && g.kind === "rect" && rect) {
      const hit = index.inRect(rect.x0, rect.y0, rect.x1, rect.y1, removed);
      const value = e.altKey ? 2 : 1;
      for (const i of hit) manual[i] = value;
      rect = undefined;
      marksChanged();
    }
    rect = undefined;
    pointer = local(e);
    updateHover();
    invalidate();
  };
  stage.addEventListener("pointerup", (e) => endGesture(e, false));
  stage.addEventListener("pointercancel", (e) => endGesture(e, true));
  stage.addEventListener("pointerleave", () => {
    if (gesture) return;
    pointer = undefined;
    updateHover();
  });
  stage.addEventListener("contextmenu", (e) => e.preventDefault()); // o botão direito arrasta a vista
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = local(e);
      const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * Math.exp(-e.deltaY * 0.0015)));
      panX = p.x - ((p.x - panX) * nz) / zoom;
      panY = p.y - ((p.y - panY) * nz) / zoom;
      zoom = nz;
      pointer = p;
      updateHover();
      viewChanged();
    },
    { passive: false },
  );
  stage.addEventListener("dblclick", (e) => {
    if (pick(local(e)) >= 0) return; // dois cliques num traço são só marcar e desmarcar
    fit();
    viewChanged(true);
  });
  const ro = new ResizeObserver(() => invalidate());
  ro.observe(stage);
  const offPaper = onPaperChange(repaint);

  // ------------------------------------------------------------------ teclado
  let escAt = -1e9;
  let escArmed = false;
  /** Esc: primeiro tira as marcas; com traços apagados e ainda não guardados, avisa antes de sair. */
  function onEscape() {
    const { marked, gone } = counts();
    if (marked > 0) return clearMarks();
    if (gone > 0 && !escArmed) {
      escArmed = true;
      setTimeout(() => (escArmed = false), 5000);
      return toast("Há traços apagados que ainda não foram guardados. “Concluir” guarda; Esc de novo sai sem apagar nada.", "warn", 5000);
    }
    close();
  }
  dialog.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      e.preventDefault();
      // a tecla fica aqui: se a tela fechar agora, o mesmo Esc ainda chegaria à mesa e soltaria a seleção
      e.stopPropagation();
      escAt = performance.now();
      onEscape();
    } else if (!ctrl && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      removeMarked();
    } else if (ctrl && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      undoRemoval();
    } else if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault(); // senão o Espaço "clica" no botão que estiver com o foco
      spaceDown = true;
      stage.classList.add("pan");
    }
  });
  dialog.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    spaceDown = false;
    stage.classList.remove("pan");
  });
  // o navegador também pede para fechar com Esc: a decisão é a mesma do teclado (e só uma vez por tecla)
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (performance.now() - escAt > 150) onEscape();
  });

  // ------------------------------------------------------------------ montar e abrir
  function close() {
    if (dialog.open) dialog.close();
    else finish();
  }
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    if (frame) cancelAnimationFrame(frame);
    if (settle) clearTimeout(settle);
    ro.disconnect();
    offPaper();
    dialog.remove();
  }
  dialog.addEventListener("close", finish);

  const side = h("div", { class: "trace-side panel" });
  append(side, [
    h("h3", null, "Como apagar"),
    h("p", { class: "hint" }, "Clique num traço para marcar: ele fica vermelho. Clique de novo para desmarcar. Para marcar vários, arraste um retângulo em volta deles (segurando Alt, o retângulo desmarca). Depois aperte Delete."),
    h("h3", null, "Traços"),
    count,
    h("div", { class: "row" }, deleteBtn, undoBtn),
    h("div", { class: "row" }, clearBtn),
    h("h3", null, "Limpar sujeira"),
    h("label", { class: "range", title: "Marca de uma vez todos os traços pequenos" }, h("span", null, "Marcar os curtos"), shortOut, shortInput),
    h("p", { class: "hint" }, "Marca todos os traços menores que este tamanho no papel. Confira o que ficou vermelho e aperte Delete. Clicar num deles tira a marca só dele."),
    h("h3", null, "Para terminar"),
    h("p", { class: "hint" }, "“Concluir” guarda o desenho sem os traços apagados. Se mudar de ideia depois, Ctrl+Z na mesa traz todos de volta. “Cancelar” sai sem mudar nada."),
  ]);
  // depois de um clique num botão, o foco volta para o desenho: Delete e Espaço continuam valendo lá
  side.addEventListener("click", (e) => (e.target as HTMLElement).closest("button") && stage.focus());

  const name = edited.length === 1 ? edited[0].name : `${edited.length} desenhos`;
  append(dialog, [
    h("header", { class: "settings-head" }, h("strong", null, `Apagar traços de ${name}`), h("button", { class: "close", title: "Fechar sem apagar nada", "aria-label": "Fechar", onclick: close }, "✕")),
    h("div", { class: "trace-main" }, stage, side),
    h(
      "footer",
      { class: "settings-foot" },
      h("span", { class: "hint" }, "Roda do mouse aproxima. Botão direito (ou Espaço) arrasta a vista. Dois cliques no vazio mostram tudo."),
      h("span", { class: "spacer" }),
      h("button", { onclick: close }, "Cancelar"),
      doneBtn,
    ),
  ]);
  document.body.append(dialog);
  renderPanel();
  dialog.showModal();
  stage.focus();
  invalidate();
}
