import { Canvas } from "fabric";
import { sceneToMachine } from "./core/coords";
import { canRedo, canUndo, redoLabel, undoLabel } from "./core/history";
import { DEFAULT_PROFILE } from "./core/machine";
import { initialState, Store } from "./core/store";
import { installBoard } from "./ui/board";
import { CanvasView } from "./ui/canvasView";
import { h } from "./ui/dom";
import { installImport } from "./ui/importer";
import { getLayout } from "./ui/layout";
import { createPropertiesPanel } from "./ui/panels/propertiesPanel";
import { SidePanel } from "./ui/panels/sidePanel";
import { installShortcuts } from "./ui/shortcuts";
import { StatusBar } from "./ui/statusBar";
import { fitToScreen, installZoomPan } from "./ui/viewport";
import "./style.css";

const layout = getLayout();
const store = new Store(initialState(DEFAULT_PROFILE));
const profile = () => store.state.profile;

// A cena do Fabric é em mm (1 unidade = 1 mm, Y para baixo). Zoom/pan só pelo viewportTransform.
const canvas = new Canvas(layout.canvasEl, {
  selection: true,
  preserveObjectStacking: true,
  fireMiddleClick: true,
  stopContextMenu: true,
  uniformScaling: false, // Shift mantém a proporção (SPEC)
});
installBoard(canvas, profile);

const status = new StatusBar(layout.status);
const updateZoom = () => status.setZoom(canvas.getZoom());
installZoomPan(canvas, { minZoom: 0.3, maxZoom: 40, onChange: updateZoom });

canvas.on("mouse:move", (opt) => status.setCursor(sceneToMachine(canvas.getScenePoint(opt.e), profile().workArea.height)));
canvas.on("mouse:out", () => status.setCursor(undefined));

const fit = () => {
  fitToScreen(canvas, profile().workArea);
  updateZoom();
};

let fitted = false;
new ResizeObserver(() => {
  canvas.setDimensions({ width: layout.canvasWrap.clientWidth, height: layout.canvasWrap.clientHeight });
  if (!fitted) {
    fit();
    fitted = true;
  }
  canvas.requestRenderAll();
}).observe(layout.canvasWrap);

// barra superior
installImport(store, layout.toolbar, layout.canvasWrap);
const undoBtn = h("button", { onclick: () => store.undo() }, "↶ Desfazer");
const redoBtn = h("button", { onclick: () => store.redo() }, "↷ Refazer");
layout.toolbar.append(undoBtn, redoBtn, h("button", { title: "Enquadrar a mesa inteira", onclick: fit }, "Ajustar à tela"));
const updateUndo = () => {
  const hist = store.state.history;
  undoBtn.disabled = !canUndo(hist);
  redoBtn.disabled = !canRedo(hist);
  undoBtn.title = canUndo(hist) ? `Desfazer: ${undoLabel(hist)} (Ctrl+Z)` : "Nada para desfazer";
  redoBtn.title = canRedo(hist) ? `Refazer: ${redoLabel(hist)} (Ctrl+Y)` : "Nada para refazer";
};
updateUndo();

// painel lateral
const side = new SidePanel(layout.side);
side.addTab("props", "Propriedades", createPropertiesPanel(store));

const view = new CanvasView(canvas, store, (n) =>
  status.setMessage("area", n ? `⚠ ${n} desenho${n > 1 ? "s" : ""} fora da área` : undefined, "warn"),
);
installShortcuts(store);

store.subscribe((s, prev) => {
  if (s.profile !== prev.profile) canvas.requestRenderAll();
  if (s.history !== prev.history) updateUndo();
});

// acesso pelo console do navegador, para depurar
Object.assign(window, { plotter: { store, canvas, view } });
