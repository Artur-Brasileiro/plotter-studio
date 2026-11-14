import { Canvas } from "fabric";
import { sceneToMachine } from "./core/coords";
import { canRedo, canUndo, redoLabel, undoLabel } from "./core/history";
import { initialState, Store } from "./core/store";
import { loadJobSettings, loadProfileWithStatus, saveJobSettings, saveProfile } from "./storage/profileStore";
import { restoreSession, startAutosave } from "./storage/sessionStore";
import { installBoard } from "./ui/board";
import { CanvasView } from "./ui/canvasView";
import { DrawingObject } from "./ui/drawingObject";
import { h, toast } from "./ui/dom";
import { installImport } from "./ui/importer";
import { getLayout } from "./ui/layout";
import { createJobPanel } from "./ui/panels/jobPanel";
import { createPropertiesPanel } from "./ui/panels/propertiesPanel";
import { createSettingsDialog } from "./ui/panels/settingsDialog";
import { fmtDuration, Planner } from "./ui/planner";
import { Overlay, Player } from "./ui/overlay";
import { createPreviewControls } from "./ui/panels/previewControls";
import { SidePanel } from "./ui/panels/sidePanel";
import { installShortcuts } from "./ui/shortcuts";
import { StatusBar } from "./ui/statusBar";
import { fitToScreen, installZoomPan } from "./ui/viewport";
import { createConnectControls } from "./ui/machine/connectControls";
import { createMachinePanel } from "./ui/panels/machinePanel";
import { createJogPanel } from "./ui/panels/jogPanel";
import { createConsole } from "./ui/panels/consolePanel";
import { createSendPanel } from "./ui/panels/sendPanel";
import { MachineSession, simSettingsFromUrl } from "./ui/machine/session";
import "./style.css";

const layout = getLayout();
const loaded = loadProfileWithStatus();
const store = new Store(initialState(loaded.profile, loadJobSettings()));
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
// pré-visualização do caminho: canvas por cima do Fabric
const overlay = new Overlay(layout.canvasWrap, canvas, () => profile().workArea.height);
const player = new Player(overlay);
overlay.onVisibilityChange = (v) => {
  DrawingObject.dimmed = v;
  canvas.requestRenderAll();
};

const status = new StatusBar(layout.status);
const updateZoom = () => status.setZoom(canvas.getZoom());
installZoomPan(canvas, { minZoom: 0.3, maxZoom: 40, onChange: updateZoom, onPan: (active) => view.setCaching(active) });

canvas.on("mouse:move", (opt) => status.setCursor(sceneToMachine(canvas.getScenePoint(opt.e), profile().workArea.height)));
canvas.on("mouse:out", () => status.setCursor(undefined));

const fit = () => {
  fitToScreen(canvas, profile().workArea);
  updateZoom();
};

let fitted = false;
new ResizeObserver(() => {
  canvas.setDimensions({ width: layout.canvasWrap.clientWidth, height: layout.canvasWrap.clientHeight });
  overlay.resize(layout.canvasWrap.clientWidth, layout.canvasWrap.clientHeight);
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
const settings = createSettingsDialog(store);
// v2: máquina pela Web Serial (ou o simulador com ?sim=1)
const session = new MachineSession(store, simSettingsFromUrl(location.search));
import.meta.hot?.dispose(() => session.dispose());
layout.toolbar.append(
  undoBtn,
  redoBtn,
  h("button", { title: "Enquadrar a mesa inteira", onclick: fit }, "Ajustar à tela"),
  h("span", { class: "spacer" }),
  createConnectControls(session),
  h("button", { title: "Perfil da máquina", onclick: () => settings.open() }, "⚙ Configurações"),
);
const updateUndo = () => {
  const hist = store.state.history;
  undoBtn.disabled = !canUndo(hist);
  redoBtn.disabled = !canRedo(hist);
  undoBtn.title = canUndo(hist) ? `Desfazer: ${undoLabel(hist)} (Ctrl+Z)` : "Nada para desfazer";
  redoBtn.title = canRedo(hist) ? `Refazer: ${redoLabel(hist)} (Ctrl+Y)` : "Nada para refazer";
};
updateUndo();

// painel lateral
const planner = new Planner(store);
planner.subscribe((plan) => {
  // durante o envio a pré-visualização mostra o plano do trabalho (o painel de envio cuida dela)
  if (!session.jobActive) {
    if (player.playing) player.stop();
    overlay.setPlan(plan, store.state.job.speedMode === "fixed");
  }
  status.setMessage("estimate", plan ? `tempo estimado ~${fmtDuration(plan.stats.estimate.totalS)}` : undefined);
});
overlay.setPlan(planner.plan, store.state.job.speedMode === "fixed");

const side = new SidePanel(layout.side);
side.addTab("props", "Propriedades", createPropertiesPanel(store));
side.addTab("job", "Trabalho", createJobPanel(store, planner, createPreviewControls(overlay, player)));
const jog = createJogPanel(session, () => side.active === "machine");
const send = createSendPanel(session, store, planner, overlay, player);
const machineTab = h("div", { class: "panel" }, createMachinePanel(session), send.el, jog.el);
side.addTab("machine", "Máquina", machineTab);
session.subscribe((s) => overlay.setMachinePosition(s.link === "connected" ? s.wpos : undefined, !!s.status?.spindle));
const consolePanel = createConsole(session, layout.console);
layout.status.prepend(consolePanel.toggleButton);
// rodapé: as setas do teclado fazem jog (aba Máquina, conectado) ou movem o desenho?
const updateArrowMode = () => status.setMessage("arrows", jog.keysActive() ? "Setas: jog da máquina" : undefined);
side.onChange = updateArrowMode;
session.subscribe(updateArrowMode);

const view = new CanvasView(canvas, store, (n) =>
  status.setMessage("area", n ? `⚠ ${n} desenho${n > 1 ? "s" : ""} fora da área` : undefined, "warn"),
);
installShortcuts(store, { arrowsEnabled: () => !jog.keysActive() });

store.subscribe((s, prev) => {
  if (s.profile !== prev.profile) canvas.requestRenderAll();
  if (s.history !== prev.history) updateUndo();
  if (s.job !== prev.job) saveJobSettings(s.job);
});

// persistência: perfil no localStorage, sessão no IndexedDB (autosave só depois de restaurar,
// senão um documento vazio poderia sobrescrever a sessão salva)
if (loaded.problem) {
  toast(loaded.problem, "warn", 9000);
  try {
    saveProfile(loaded.profile); // grava o padrão: o aviso não se repete a cada abertura
  } catch {
    /* armazenamento bloqueado */
  }
}
restoreSession()
  .then((doc) => {
    if (doc && doc.drawings.length) {
      store.replaceDocument(doc);
      const n = doc.drawings.length;
      status.setMessage("session", `Sessão restaurada (${n} desenho${n > 1 ? "s" : ""})`);
      setTimeout(() => status.setMessage("session", undefined), 8000);
    }
  })
  .catch((e) => {
    console.warn(e);
    toast("A sessão salva estava corrompida e foi ignorada.", "warn", 9000);
  })
  .finally(() => startAutosave(store, { onError: (e) => console.warn("autosave falhou", e) }));

// acesso pelo console do navegador, para depurar
Object.assign(window, { plotter: { store, canvas, view, planner, side, session } });
