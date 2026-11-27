import { isDark, luminance } from "../core/color";
import type { Drawing, DrawingId } from "../core/document";
import { meanScale } from "../core/geometry/mat2d";
import type { Geometry } from "../core/geometry/path";
import { penOf } from "../core/machine";
import type { Store } from "../core/store";
import {
  applyStrokeEdits,
  cutGeometry,
  nearestOnSubpath,
  sceneDeltaToLocal,
  sceneStrokes,
  StrokeIndex,
  translateSubpaths,
  withGeometries,
  type EditStroke,
} from "../core/strokeEdit";
import { transformGeometry } from "../core/geometry/path";
import type { Vec } from "../core/geometry/vec";
import { expandToGroups } from "../core/document";
import { append, clear, h, toast } from "./dom";
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
 * Tela "Editar traços": os desenhos escolhidos aparecem grandes e cada traço (cada descida da caneta) pode
 * ser marcado com um clique ou com um retângulo. Com os marcados: Delete apaga, um botão de caneta passa
 * para outra caneta (subcamada), a ferramenta Mover (ou as setas) muda de lugar. A ferramenta Cortar divide
 * uma linha no ponto clicado. "Guardar e voltar" guarda tudo numa mudança só, que o Ctrl+Z da mesa desfaz.
 * Nada aqui chega à máquina. O desfazer DESTA tela guarda uma foto do estado antes de cada ação.
 *
 * Com mais de um desenho (as camadas de uma imagem, uma por caneta), a pessoa escolhe AQUI em qual camada
 * quer mexer: só os traços dela podem ser marcados, e as outras ficam apagadinhas, só para localizar.
 * `focusId` abre a tela já numa camada.
 *
 * Para um desenho de 20 mil traços continuar leve, a tela pinta em três camadas:
 *  - a base (folha, os outros desenhos, os traços que ficam) só é refeita quando um traço sai ou volta, ou
 *    quando a vista para de mexer; enquanto a pessoa aproxima ou arrasta, a tela estica a pintura pronta;
 *  - os marcados, só quando uma marca muda;
 *  - o traço embaixo do mouse e o retângulo, a cada movimento (é quase nada).
 */
export function openStrokeEditor(store: Store, ids: readonly DrawingId[], focusId?: DrawingId): void {
  if (document.querySelector("dialog.strokes")) return; // já está aberta (botão + dois cliques)
  const profile = store.state.profile;
  const doc = store.doc;
  const edited = doc.drawings.filter((d) => ids.includes(d.id));
  const others = doc.drawings.filter((d) => !ids.includes(d.id));
  const tol = profile.tolerance.chordMm;
  /**
   * A geometria de cada desenho NESTA tela: começa igual à do documento e muda com a tesoura e o mover.
   * Só vai para o documento no "Guardar e voltar".
   */
  let geoms = new Map<DrawingId, Geometry>(edited.map((d) => [d.id, d.geometry]));
  const working = (d: Drawing): Drawing => ({ ...d, geometry: geoms.get(d.id)! });
  let strokes: EditStroke[] = edited.flatMap((d) => sceneStrokes(d, tol));
  if (strokes.length === 0) {
    toast("Não há traços para apagar neste desenho.", "warn");
    return;
  }
  let n = strokes.length;
  let index = new StrokeIndex(strokes.map((s) => s.points));
  /** 1 = apagado nesta tela */
  let removed = new Uint8Array(n);
  /** 0 = como o "Marcar os curtos" decidir; 1 = marcado à mão; 2 = desmarcado à mão */
  let manual = new Uint8Array(n);
  let shortMm = 0;
  /** A caneta de cada desenho editado, já resolvida (sem caneta = a padrão do perfil) */
  const ownPen = new Map(edited.map((d) => [d.id, penOf(profile, d.penId).id]));
  /** Caneta para a qual o traço foi passado nesta tela; undefined = continua na caneta do desenho */
  let penTo: (string | undefined)[] = new Array(n).fill(undefined);
  /**
   * Desfazer: cada ação (apagar, trocar a caneta, cortar, mover) guarda antes uma foto da tela inteira.
   * A lista de traços sai da geometria, então a foto da geometria basta para refazê-la igual.
   */
  type Snapshot = { geoms: Map<DrawingId, Geometry>; removed: Uint8Array<ArrayBuffer>; manual: Uint8Array<ArrayBuffer>; penTo: (string | undefined)[] };
  const undoStack: Snapshot[] = [];
  const pushUndo = () => undoStack.push({ geoms: new Map(geoms), removed: removed.slice(), manual: manual.slice(), penTo: penTo.slice() });
  /** A camada em que a pessoa está mexendo; undefined = todas */
  let activeLayer: DrawingId | undefined = edited.length > 1 && edited.some((d) => d.id === focusId) ? focusId : undefined;
  const inLayer = (i: number) => activeLayer === undefined || strokes[i].drawingId === activeLayer;
  // "Marcar os curtos" só vale para a camada escolhida; as marcas feitas à mão valem onde foram feitas
  const isMarked = (i: number) => !removed[i] && (manual[i] === 1 || (manual[i] === 0 && inLayer(i) && strokes[i].lengthMm < shortMm));
  /** 1 = o mouse não pega este traço: já foi apagado, ou é de outra camada */
  let blocked = new Uint8Array(n);
  const refreshBlocked = () => {
    for (let i = 0; i < n; i++) blocked[i] = removed[i] || !inLayer(i) ? 1 : 0;
  };
  refreshBlocked();

  // de subcaminho do desenho → número do traço nesta tela (−1 = subcaminho vazio, que não é traço)
  const strokeOfSubpath = new Map<DrawingId, Int32Array>();
  const indexSubpaths = () => {
    for (const d of edited) strokeOfSubpath.set(d.id, new Int32Array(geoms.get(d.id)!.subpaths.length).fill(-1));
    strokes.forEach((s, i) => (strokeOfSubpath.get(s.drawingId)![s.subpath] = i));
  };
  indexSubpaths();
  const basePaths = new Map<DrawingId, Path2D>();
  /** Os traços de cada desenho que foram passados para outra caneta, um caminho por caneta */
  const movedPaths = new Map<DrawingId, Map<string, Path2D>>();
  const rebuildBase = (d: Drawing) => {
    const map = strokeOfSubpath.get(d.id)!;
    const g = geoms.get(d.id)!;
    basePaths.set(d.id, pathOf(g, (sp) => map[sp] < 0 || (!removed[map[sp]] && penTo[map[sp]] === undefined)));
    const pens = new Set<string>();
    for (const i of map) if (i >= 0 && !removed[i] && penTo[i] !== undefined) pens.add(penTo[i]!);
    movedPaths.set(d.id, new Map([...pens].map((pen) => [pen, pathOf(g, (sp) => map[sp] >= 0 && !removed[map[sp]] && penTo[map[sp]] === pen)])));
  };
  edited.forEach(rebuildBase);

  /**
   * A geometria mudou (corte, movimento, desfazer): refaz a lista de traços e tudo o que sai dela.
   * `remap` diz em que subcaminhos novos cada subcaminho antigo virou, para as marcas, os apagados e as
   * canetas irem junto (o corte de um traço marcado deixa os dois pedaços marcados). Sem `remap`, o estado
   * por traço vem de `state` (o desfazer).
   */
  function rebuildStrokes(remap?: (id: DrawingId, sp: number) => number[], state?: Snapshot) {
    const old = { strokes, removed, manual, penTo };
    strokes = edited.flatMap((d) => sceneStrokes(working(d), tol));
    n = strokes.length;
    index = new StrokeIndex(strokes.map((s) => s.points));
    removed = new Uint8Array(n);
    manual = new Uint8Array(n);
    penTo = new Array(n).fill(undefined);
    blocked = new Uint8Array(n);
    if (state) {
      removed.set(state.removed);
      manual.set(state.manual);
      penTo = state.penTo.slice();
    } else {
      const key = (id: DrawingId, sp: number) => `${id}\u0000${sp}`;
      const at = new Map<string, number>();
      strokes.forEach((s, i) => at.set(key(s.drawingId, s.subpath), i));
      old.strokes.forEach((s, i) => {
        for (const sp of remap ? remap(s.drawingId, s.subpath) : [s.subpath]) {
          const j = at.get(key(s.drawingId, sp));
          if (j === undefined) continue;
          removed[j] = old.removed[i];
          manual[j] = old.manual[i];
          penTo[j] = old.penTo[i];
        }
      });
    }
    indexSubpaths();
    refreshBlocked();
    edited.forEach(rebuildBase);
    hover = -1;
    cutAt = undefined;
    updateHover();
    renderPanel();
    repaint();
  }
  /** A geometria desta tela é diferente da do documento (houve corte ou movimento)? */
  const geometryEdited = () => edited.some((d) => geoms.get(d.id) !== d.geometry);
  const contextPaths = new Map<DrawingId, Path2D>();
  const penMm = Math.max(...edited.map((d) => penOf(profile, d.penId).widthMm));

  // ------------------------------------------------------------------ palco
  const dialog = h("dialog", { class: "sheet strokes", "aria-label": "Editar traços" });
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
  /** Ferramenta: marcar (clique e retângulo), cortar (tesoura) ou mover os marcados */
  type Tool = "mark" | "cut" | "move";
  let tool: Tool = "mark";
  /** Tesoura: onde o clique cortaria o traço embaixo do mouse (mm da cena) */
  let cutAt: { i: number; seg: number; t: number; point: Vec } | undefined;
  /** Mover: quanto os marcados estão sendo arrastados agora (mm da cena) */
  let dragDelta: Vec | undefined;

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
      for (const d of edited) {
        const pen = penOf(profile, d.penId);
        // as camadas em que a pessoa não está mexendo ficam apagadinhas
        b.globalAlpha = activeLayer === undefined || d.id === activeLayer ? 1 : 0.25;
        b.strokeStyle = legible(pen.color, paper);
        strokeDrawing(b, d, basePaths.get(d.id)!, Math.max(pen.widthMm, 1.25 / bz)); // largura real da caneta, nunca menos de ~1 px
        // os traços passados para outra caneta já aparecem com a cor e a largura dela
        for (const [penId, p] of movedPaths.get(d.id) ?? []) {
          const to = penOf(profile, penId);
          b.strokeStyle = legible(to.color, paper);
          strokeDrawing(b, d, p, Math.max(to.widthMm, 1.25 / bz));
        }
      }
      b.globalAlpha = 1;
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
        const p = pathOf(geoms.get(d.id)!, (sp) => map[sp] >= 0 && isMarked(map[sp])); // a geometria DESTA tela (com os cortes)
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
    const polyline = (pts: Float64Array) => {
      c.beginPath();
      c.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    };
    if (dragDelta) {
      // os marcados acompanham o mouse (o lugar antigo continua aparecendo, por baixo)
      c.save();
      c.translate(dragDelta.x, dragDelta.y);
      c.strokeStyle = HOVER;
      c.lineWidth = lineMm + 2 / zoom;
      for (let i = 0; i < n; i++) {
        if (!isMarked(i)) continue;
        polyline(strokes[i].points);
        c.stroke();
      }
      c.restore();
    } else if (tool === "cut" && cutAt && !rect) {
      // tesoura: o traço inteiro em azul e um alvo no ponto do corte
      polyline(strokes[cutAt.i].points);
      c.strokeStyle = HOVER;
      c.lineWidth = lineMm + 2 / zoom;
      c.stroke();
      c.beginPath();
      c.arc(cutAt.point.x, cutAt.point.y, 5 / zoom, 0, Math.PI * 2);
      c.fillStyle = paper;
      c.fill();
      c.lineWidth = 2 / zoom;
      c.strokeStyle = MARK;
      c.stroke();
    } else if (hover >= 0 && !rect) {
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
  const undoBtn = h("button", { title: "Desfaz a última coisa feita nesta tela: apagar, trocar a caneta, cortar ou mover (Ctrl+Z)", onclick: () => undoRemoval() }, "↶ Desfazer");
  // ferramentas: o que o clique faz no desenho
  const TOOL_HINT: Record<Tool, string> = {
    mark: "Clique num traço para marcar (fica vermelho); clique de novo para desmarcar. Arraste no vazio para marcar vários.",
    cut: "Clique num ponto de uma linha: ela é cortada ali e vira duas (a bolinha mostra onde). Depois, marque um dos pedaços para apagar ou pintar com outra caneta.",
    move: "Arraste um traço para movê-lo, junto com os outros marcados. As setas do teclado movem os marcados 0,5 mm (com Shift, 5 mm).",
  };
  const toolHint = h("p", { class: "hint" }, TOOL_HINT.mark);
  const toolButtons = (
    [
      ["mark", "Marcar", "Marcar e desmarcar traços (tecla 1)"],
      ["cut", "✂ Cortar", "Cortar uma linha num ponto (tecla 2)"],
      ["move", "✥ Mover", "Arrastar os traços marcados para outro lugar (tecla 3)"],
    ] as const
  ).map(([t, label, title]) => h("button", { class: `tool-btn${t === "mark" ? " active" : ""}`, title, "aria-pressed": String(t === "mark"), onclick: () => setTool(t) }, label));
  function setTool(t: Tool) {
    tool = t;
    toolButtons.forEach((b, k) => {
      const on = (["mark", "cut", "move"] as const)[k] === t;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    toolHint.textContent = TOOL_HINT[t];
    stage.classList.toggle("tool-cut", t === "cut");
    stage.classList.toggle("tool-move", t === "move");
    cutAt = undefined;
    updateHover();
    invalidate();
  }
  // passar os marcados para outra caneta: um botão por caneta do estojo
  const penButtons = profile.pens.map((pen) =>
    h(
      "button",
      { class: "layer-chip", title: `Os traços marcados passam a ser feitos com a caneta ${pen.name}`, onclick: () => movePen(pen.id) },
      h("span", { class: "dot", style: `--c:${pen.color}`, "aria-hidden": "true" }),
      h("span", { class: "name" }, pen.name),
      h("span", { class: "n" }),
    ),
  );
  const doneBtn = h("button", { class: "primary big", onclick: () => conclude() }, "Voltar para a mesa");
  const backBtn = h("button", { title: "Sai desta tela e deixa o desenho como estava", onclick: () => close() }, "Voltar sem mudar nada");
  // a camada em que se mexe (só aparece quando há mais de uma)
  const layerChips = h("div", { class: "layer-chips", role: "radiogroup", "aria-label": "Camada em que você está mexendo" });
  const layerBox = h("div", { class: "panel-section", hidden: edited.length < 2 }, h("h3", null, "Camada"), layerChips);
  /** Troca a camada em que a pessoa mexe. As marcas do "Marcar os curtos" viram marcas comuns e o controle volta a zero. */
  function setLayer(id: DrawingId | undefined) {
    if (id === activeLayer) return;
    if (shortMm > 0) {
      for (let i = 0; i < n; i++) if (manual[i] === 0 && isMarked(i)) manual[i] = 1;
      shortMm = 0;
      shortInput.value = "0";
      shortOut.textContent = "desligado";
    }
    activeLayer = id;
    refreshBlocked();
    hover = -1;
    updateHover();
    renderPanel();
    repaint();
  }
  const shortOut = h("output", null, "desligado");
  const shortInput = h("input", { type: "range", min: "0", max: "20", step: "0.5", value: "0", "aria-label": "Marcar os traços curtos" });
  shortInput.addEventListener("input", () => {
    shortMm = Number(shortInput.value);
    shortOut.textContent = shortMm === 0 ? "desligado" : `menores que ${shortMm.toLocaleString("pt-BR", { minimumFractionDigits: 1 })} mm`;
    marksChanged();
  });

  const counts = () => {
    let marked = 0, gone = 0, moved = 0;
    const shaped = geometryEdited();
    for (let i = 0; i < n; i++) {
      if (removed[i]) gone++;
      else {
        if (isMarked(i)) marked++;
        if (penTo[i] !== undefined) moved++;
      }
    }
    return { marked, gone, moved, shaped, changed: gone > 0 || moved > 0 || shaped };
  };
  /** A caneta em que o traço está agora (a do desenho, ou a que recebeu nesta tela) */
  const penNow = (i: number) => penTo[i] ?? ownPen.get(strokes[i].drawingId)!;
  function renderPanel() {
    const { marked, gone, moved, changed } = counts();
    count.textContent =
      `${plural(n - gone, "traço", "traços")} · ${plural(marked, "marcado", "marcados")} · ${plural(gone, "apagado", "apagados")}` +
      (moved > 0 ? ` · ${plural(moved, "em outra caneta", "em outra caneta")}` : "");
    deleteBtn.disabled = marked === 0;
    clearBtn.disabled = marked === 0;
    undoBtn.disabled = undoStack.length === 0;
    // quantos traços cada caneta vai fazer, contando os que mudaram de caneta aqui
    const perPen = new Map<string, number>();
    for (let i = 0; i < n; i++) if (!removed[i]) perPen.set(penNow(i), (perPen.get(penNow(i)) ?? 0) + 1);
    profile.pens.forEach((pen, k) => {
      penButtons[k].disabled = marked === 0;
      penButtons[k].querySelector(".n")!.textContent = perPen.get(pen.id) ? nf(perPen.get(pen.id)!) : "";
    });
    // os botões de sair dizem o que vai acontecer
    // (as marcas sozinhas não mudam nada: servem para apagar, pintar e mover; quem quer apagar usa o botão)
    doneBtn.textContent = changed ? "Guardar e voltar" : "Voltar para a mesa";
    backBtn.hidden = !changed;
    if (edited.length < 2) return;
    // uma ficha por camada, com a cor da caneta e quantos traços ainda tem
    const left = new Map<DrawingId, number>();
    for (let i = 0; i < n; i++) if (!removed[i]) left.set(strokes[i].drawingId, (left.get(strokes[i].drawingId) ?? 0) + 1);
    const chip = (id: DrawingId | undefined, label: string, total: number, color?: string) =>
      h(
        "button",
        { class: `layer-chip${activeLayer === id ? " on" : ""}`, role: "radio", "aria-checked": String(activeLayer === id), onclick: () => setLayer(id) },
        h("span", color ? { class: "dot", style: `--c:${color}`, "aria-hidden": "true" } : { class: "dot all", "aria-hidden": "true" }),
        h("span", { class: "name" }, label),
        h("span", { class: "n" }, nf(total)),
      );
    clear(layerChips);
    append(layerChips, [
      chip(undefined, "Todas", n - gone),
      ...edited.map((d) => {
        const pen = penOf(profile, d.penId);
        return chip(d.id, pen.name, left.get(d.id) ?? 0, pen.color);
      }),
    ]);
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
    pushUndo();
    for (const i of list) removed[i] = 1;
    geometryChanged(list);
  }
  /** Os marcados passam para a caneta `penId` (voltar para a caneta do próprio desenho desfaz a troca). */
  function movePen(penId: string) {
    const list: number[] = [];
    for (let i = 0; i < n; i++) if (isMarked(i)) list.push(i);
    if (list.length === 0) return;
    pushUndo();
    for (const i of list) {
      penTo[i] = ownPen.get(strokes[i].drawingId) === penId ? undefined : penId;
      manual[i] = 2; // a marca sai: a pessoa vê a cor nova na hora
    }
    geometryChanged(list);
  }
  /** Volta a tela como estava antes da última ação (a foto guardada por `pushUndo`). */
  function undoRemoval() {
    const snap = undoStack.pop();
    if (!snap) return;
    const sameShape = edited.every((d) => snap.geoms.get(d.id) === geoms.get(d.id));
    geoms = snap.geoms;
    if (sameShape) {
      removed = snap.removed;
      manual = snap.manual;
      penTo = snap.penTo;
      edited.forEach(rebuildBase);
      refreshBlocked();
      updateHover();
      renderPanel();
      repaint();
    } else rebuildStrokes(undefined, snap);
  }
  /** Tesoura: corta o traço `cutAt.i` no ponto escolhido. */
  function cutHere(at: NonNullable<typeof cutAt>) {
    const s = strokes[at.i];
    const g = geoms.get(s.drawingId)!;
    const next = cutGeometry(g, s.subpath, at.seg, at.t);
    if (next === g) return toast("Aqui é a ponta do traço: não há o que cortar.", "warn");
    pushUndo();
    const pieces = next.subpaths.length - g.subpaths.length + 1;
    geoms = new Map(geoms).set(s.drawingId, next);
    rebuildStrokes((id, sp) => (id !== s.drawingId || sp < s.subpath ? [sp] : sp === s.subpath ? Array.from({ length: pieces }, (_, k) => sp + k) : [sp + pieces - 1]));
  }
  /** Move os traços marcados `d` mm na cena. */
  function moveMarked(d: Vec) {
    if (d.x === 0 && d.y === 0) return;
    const byDrawing = new Map<DrawingId, number[]>();
    for (let i = 0; i < n; i++) {
      if (!isMarked(i)) continue;
      const list = byDrawing.get(strokes[i].drawingId);
      if (list) list.push(strokes[i].subpath);
      else byDrawing.set(strokes[i].drawingId, [strokes[i].subpath]);
    }
    if (byDrawing.size === 0) return;
    pushUndo();
    const next = new Map(geoms);
    for (const dr of edited) {
      const list = byDrawing.get(dr.id);
      if (list) next.set(dr.id, translateSubpaths(next.get(dr.id)!, list, sceneDeltaToLocal(dr.transform, d)));
    }
    geoms = next;
    rebuildStrokes();
  }
  /** Traços saíram ou voltaram: refaz só os desenhos afetados e o que estava embaixo do mouse. */
  function geometryChanged(list: readonly number[]) {
    const touched = new Set(list.map((i) => strokes[i].drawingId));
    for (const d of edited) if (touched.has(d.id)) rebuildBase(d);
    refreshBlocked();
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
    // o que acontece com cada traço: null = sai; id de caneta = passa para aquela caneta
    const map = new Map<DrawingId, Map<number, string | null>>();
    let gone = 0, moved = 0;
    strokes.forEach((s, i) => {
      const to = removed[i] ? null : penTo[i];
      if (to === undefined) return;
      if (to === null) gone++;
      else moved++;
      let m = map.get(s.drawingId);
      if (!m) map.set(s.drawingId, (m = new Map()));
      m.set(s.subpath, to);
    });
    const shaped = geometryEdited();
    if (gone + moved === 0 && !shaped) return close();
    // a tela trabalhou em cima destes desenhos: se algum mudou por fora, os números dos traços não valem mais
    const stale = edited.some((d) => store.doc.drawings.find((x) => x.id === d.id)?.geometry !== d.geometry);
    if (stale) {
      toast("O desenho mudou enquanto esta tela estava aberta. Nada foi guardado.", "warn", 8000);
      return close();
    }
    const label = shaped || (gone > 0 && moved > 0) ? "Editar traços" : moved === 0 ? "Apagar traços" : "Trocar a caneta de traços";
    const existed = new Set(store.doc.drawings.map((d) => d.id));
    // primeiro a forma nova (cortes e movimentos), depois apagar e trocar de caneta: os números dos traços são os desta tela
    store.commit(label, (docNow) => applyStrokeEdits(withGeometries(docNow, geoms), map, store.state.profile, () => crypto.randomUUID()));
    // a seleção fica com o conjunto inteiro, incluindo as camadas que acabaram de nascer
    const after = store.doc.drawings;
    const keep = ids.filter((id) => after.some((d) => d.id === id));
    const born = after.filter((d) => !existed.has(d.id)).map((d) => d.id);
    store.setSelection(expandToGroups(store.doc, [...keep, ...born]));
    const parts = [
      gone > 0 ? plural(gone, "traço apagado", "traços apagados") : "",
      moved > 0 ? `${plural(moved, "traço passou", "traços passaram")} para outra caneta` : "",
      shaped ? "cortes e movimentos guardados" : "",
    ].filter(Boolean);
    parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
    toast(`${parts.join(", ")}. Se mudar de ideia, Ctrl+Z na mesa desfaz.`);
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
    return index.nearest(s.x, s.y, PICK_PX / zoom, blocked);
  };

  type Gesture =
    | { kind: "pan"; x: number; y: number; px: number; py: number }
    | { kind: "press"; x: number; y: number }
    | { kind: "rect" }
    | { kind: "drag"; x: number; y: number };
  /** Tesoura: o ponto exato do traço `i` mais perto do mouse (na curva de verdade, não na polilinha). */
  const cutPointOf = (i: number, p: { x: number; y: number }): typeof cutAt => {
    const s = strokes[i];
    const d = edited.find((x) => x.id === s.drawingId)!;
    const sp = transformGeometry({ subpaths: [geoms.get(d.id)!.subpaths[s.subpath]] }, d.transform).subpaths[0];
    const r = nearestOnSubpath(sp, toScene(p));
    return r ? { i, seg: r.seg, t: r.t, point: r.point } : undefined;
  };
  let gesture: Gesture | undefined;
  let spaceDown = false;

  function updateHover() {
    const next = pointer && !gesture ? pick(pointer) : -1;
    stage.classList.toggle("over", next >= 0);
    if (tool === "cut") {
      // a bolinha da tesoura acompanha o mouse ao longo do traço
      cutAt = next >= 0 && pointer ? cutPointOf(next, pointer) : undefined;
      hover = next;
      return invalidate();
    }
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
    } else if (e.button === 0) {
      const i = tool === "move" ? pick(p) : -1;
      if (i >= 0) {
        // mover: pegar um traço leva junto todos os marcados (o pego entra nas marcas)
        if (!isMarked(i)) {
          manual[i] = 1;
          marksChanged();
        }
        const a = toScene(p);
        gesture = { kind: "drag", x: a.x, y: a.y };
        dragDelta = { x: 0, y: 0 };
        stage.classList.add("grabbing");
      } else gesture = { kind: "press", x: p.x, y: p.y };
    } else return;
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
    if (gesture.kind === "drag") {
      const b = toScene(pointer);
      dragDelta = { x: b.x - gesture.x, y: b.y - gesture.y };
      return invalidate();
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
    else if (g.kind === "drag") {
      const d = dragDelta;
      dragDelta = undefined;
      // (arrastar menos de meio pixel é tremida do clique, não movimento)
      if (!cancelled && d && Math.hypot(d.x, d.y) * zoom >= 0.5) moveMarked(d);
    } else if (!cancelled && g.kind === "press" && tool === "cut") {
      // tesoura: corta onde a bolinha está
      const i = pick(local(e));
      const at = i >= 0 ? cutPointOf(i, local(e)) : undefined;
      if (at) cutHere(at);
    } else if (!cancelled && g.kind === "press") {
      // clique: marca ou desmarca o traço que está embaixo do mouse
      const i = pick(local(e));
      if (i >= 0) {
        manual[i] = isMarked(i) ? 2 : 1;
        marksChanged();
      }
    } else if (!cancelled && g.kind === "rect" && rect) {
      const hit = index.inRect(rect.x0, rect.y0, rect.x1, rect.y1, blocked);
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
    const { marked, changed } = counts();
    if (marked > 0) return clearMarks();
    if (changed && !escArmed) {
      escArmed = true;
      setTimeout(() => (escArmed = false), 5000);
      return toast("Há mudanças que ainda não foram guardadas. “Guardar e voltar” guarda; Esc de novo sai sem mudar nada.", "warn", 5000);
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
    } else if (!ctrl && !(e.target instanceof HTMLInputElement) && (e.key === "1" || e.key === "2" || e.key === "3")) {
      e.preventDefault();
      setTool((["mark", "cut", "move"] as const)[Number(e.key) - 1]);
    } else if (!ctrl && e.key.startsWith("Arrow") && !(e.target instanceof HTMLInputElement) && counts().marked > 0) {
      // setas: movem os marcados (na tela, para cima é Y menor na cena)
      e.preventDefault();
      const step = e.shiftKey ? 5 : 0.5;
      const d = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }[e.key];
      if (d) moveMarked(d);
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
    layerBox,
    h("h3", null, "Ferramenta"),
    h("div", { class: "row tool-row", role: "group", "aria-label": "Ferramenta" }, ...toolButtons),
    toolHint,
    count,
    h("div", { class: "row" }, deleteBtn, undoBtn),
    h("div", { class: "row" }, clearBtn),
    h("h3", null, "Pintar com outra caneta"),
    h("p", { class: "hint" }, "Clique numa caneta: os traços marcados passam a ser feitos com ela, numa camada só dela, que vai para a máquina junto com o resto."),
    h("div", { class: "layer-chips", role: "group", "aria-label": "Passar os marcados para a caneta" }, ...penButtons),
    h(
      "label",
      { class: "range", title: "Marca de uma vez todos os traços menores que este tamanho no papel. Confira o que ficou vermelho antes de apagar; clicar num deles tira a marca só dele." },
      h("span", null, "Marcar os curtos"),
      shortOut,
      shortInput,
    ),
  ]);
  // depois de um clique num botão, o foco volta para o desenho: Delete e Espaço continuam valendo lá
  side.addEventListener("click", (e) => (e.target as HTMLElement).closest("button") && stage.focus());

  // as camadas de um conjunto têm o mesmo nome (o da imagem): o título diz o nome uma vez só
  const names = [...new Set(edited.map((d) => d.name))];
  const name = names.length === 1 ? names[0] : `${edited.length} desenhos`;
  append(dialog, [
    h(
      "header",
      { class: "settings-head" },
      h("strong", null, `Editar traços de ${name}`),
      h("button", { class: "close", title: "Voltar para a mesa sem mudar nada", "aria-label": "Voltar para a mesa sem mudar nada", onclick: close }, "✕"),
    ),
    h("div", { class: "trace-main" }, stage, side),
    h(
      "footer",
      { class: "settings-foot" },
      h("span", { class: "hint" }, "Roda do mouse aproxima. Botão direito (ou Espaço) arrasta a vista. Dois cliques no vazio mostram tudo."),
      h("span", { class: "spacer" }),
      backBtn,
      doneBtn,
    ),
  ]);
  document.body.append(dialog);
  renderPanel();
  dialog.showModal();
  stage.focus();
  invalidate();
}
