import { Canvas } from "fabric";
import { sceneToMachine } from "./core/coords";
import { DEFAULT_PROFILE } from "./core/machine";
import { initialState, Store } from "./core/store";
import { installBoard } from "./ui/board";
import { h } from "./ui/dom";
import { getLayout } from "./ui/layout";
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

layout.toolbar.append(h("button", { title: "Enquadrar a mesa inteira", onclick: fit }, "Ajustar à tela"));
layout.side.append(h("div", { class: "panel" }, h("p", { class: "hint" }, "Importe um SVG para começar.")));

store.subscribe((s, prev) => {
  if (s.profile !== prev.profile) canvas.requestRenderAll();
});

// acesso pelo console do navegador, para depurar
Object.assign(window, { plotter: { store, canvas } });
