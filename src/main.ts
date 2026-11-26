import { Canvas } from "fabric";
import { sceneToMachine } from "./core/coords";
import { canRedo, canUndo, redoLabel, undoLabel } from "./core/history";
import { penOf } from "./core/machine";
import { initialState, Store } from "./core/store";
import { loadJobSettings, loadProfileWithStatus, saveJobSettings, saveProfile } from "./storage/profileStore";
import { restoreSession, startAutosave } from "./storage/sessionStore";
import { installBoard } from "./ui/board";
import { CanvasView } from "./ui/canvasView";
import { DrawingObject } from "./ui/drawingObject";
import { h, toast } from "./ui/dom";
import { createHelpDialog } from "./ui/helpDialog";
import { createMenu, installImport } from "./ui/importer";
import { onPaperChange } from "./ui/paper";
import { createPaperPicker } from "./ui/paperPicker";
import { getLayout } from "./ui/layout";
import { createJobPanel } from "./ui/panels/jobPanel";
import { createPropertiesPanel, editStrokesOfSelection } from "./ui/panels/propertiesPanel";
import { createSettingsDialog } from "./ui/panels/settingsDialog";
import { fmtDuration, Planner } from "./ui/planner";
import { Overlay, Player } from "./ui/overlay";
import { createPreviewControls } from "./ui/panels/previewControls";
import { SidePanel } from "./ui/panels/sidePanel";
import { installShortcuts } from "./ui/shortcuts";
import { StatusBar } from "./ui/statusBar";
import { installTurnBadge } from "./ui/turnBadge";
import { fitToScreen, installZoomPan } from "./ui/viewport";
import { createConnectControls, installEmergencyKey } from "./ui/machine/connectControls";
import { createMachinePanel } from "./ui/panels/machinePanel";
import { createJogPanel } from "./ui/panels/jogPanel";
import { createConsole } from "./ui/panels/consolePanel";
import { createSendPanel } from "./ui/panels/sendPanel";
import { createPlotSteps } from "./ui/panels/plotSteps";
import { createPlotScreen } from "./ui/plotScreen";
import { Sounds } from "./ui/sound";
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
  uniformScaling: true, // proporção travada; quem decide a cada seleção é o CanvasView (ver ui/gestures.ts)
});
installTurnBadge(layout.canvasWrap);
// as cruzes de registro aparecem na mesa quando o trabalho tem mais de uma caneta (ligado mais abaixo, com o planejador)
let showCrosses = false;
installBoard(canvas, profile, () => showCrosses);
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
// a tela de vetorização é ligada mais abaixo (precisa do store): por enquanto só guarda a referência
let openTracer: (file: File) => void = () => toast("A vetorização ainda está carregando. Tente de novo em instantes.", "warn");
const importer = installImport(store, layout.canvasWrap, (file) => openTracer(file));
// tela de texto: carregada sob demanda, como a de vetorizar
const writeText = () => {
  void import("./ui/textDialog").then((m) => m.openTextDialog(store)).catch((e) => {
    console.error(e);
    toast("Não consegui abrir a tela de texto.", "error");
  });
};
const bringMenu = createMenu("Trazer desenho", [
  { label: "Imagem PNG ou JPG", hint: "Vira traço aqui mesmo: linha única e hachura", action: importer.pickImage },
  { label: "Arquivo SVG", hint: "Desenho que já está em vetor", action: importer.pickSvg },
  { label: "Texto", hint: "Letras de traço único: a caneta escreve com uma linha só", action: writeText },
]);
// Em tela estreita os rótulos com "lbl" somem e fica o ícone (o nome continua no title e no aria-label):
// com a máquina conectada a barra ganha Emergência, Desconectar e o estado, e não pode quebrar em duas linhas.
const lbl = (text: string) => h("span", { class: "lbl" }, text);
// engrenagem desenhada (o caractere ⚙ não existe em todas as fontes e vira um quadradinho)
const gearIcon = () =>
  h("span", {
    class: "ico",
    "aria-hidden": "true",
    innerHTML:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  });
const undoBtn = h("button", { "aria-label": "Desfazer", onclick: () => store.undo() }, "↶", lbl(" Desfazer"));
const redoBtn = h("button", { "aria-label": "Refazer", onclick: () => store.redo() }, "↷", lbl(" Refazer"));
const settings = createSettingsDialog(store);
const help = createHelpDialog();
// v2: máquina pela Web Serial (ou o simulador com ?sim=1)
const session = new MachineSession(store, simSettingsFromUrl(location.search));
import.meta.hot?.dispose(() => session.dispose());
// O que mexe no desenho ou nos ajustes some da barra enquanto a tela de plotagem está aberta
// (classe "edit-tool"; ver "body.plotting" no style.css). Ficam a vista da mesa e a conexão.
const editTool = <T extends HTMLElement>(el: T): T => {
  el.classList.add("edit-tool");
  return el;
};
layout.toolbar.append(
  editTool(bringMenu),
  editTool(h("span", { class: "sep" })),
  editTool(undoBtn),
  editTool(redoBtn),
  h("span", { class: "plotting-tag" }, "Tela de plotagem: a mesa está travada"),
  h("button", { title: "Enquadrar a mesa inteira", onclick: fit }, "Ver a mesa toda"),
  editTool(h("span", { class: "sep" })),
  editTool(createPaperPicker().el),
  h("span", { class: "spacer" }),
  createConnectControls(session),
  editTool(h("button", { title: "Configurações: máquina, caneta, proteção do servo e velocidades", "aria-label": "Configurações", onclick: () => settings.open() }, gearIcon(), lbl(" Configurações"))),
  editTool(h("button", { class: "help-btn", title: "Como usar: os três passos, do desenho ao papel", "aria-label": "Como usar", onclick: () => help.open() }, "?", lbl(" Como usar"))),
);
// a cor do papel é só da tela: a folha da mesa é redesenhada com ela (o G-code não muda)
onPaperChange(() => canvas.requestRenderAll());
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
  const crosses = !!plan?.layer?.registration;
  if (crosses !== showCrosses) {
    showCrosses = crosses;
    canvas.requestRenderAll();
  }
  // durante o envio a pré-visualização mostra o plano do trabalho (o painel de envio cuida dela)
  if (!session.jobActive) {
    if (player.playing) player.stop();
    overlay.setPlan(plan, store.state.job.speedMode === "fixed");
  }
  status.setMessage("estimate", plan ? `tempo estimado ~${fmtDuration(plan.stats.estimate.totalS)}` : undefined);
});
overlay.setPlan(planner.plan, store.state.job.speedMode === "fixed");

const side = new SidePanel(layout.side);
side.addTab("props", "Desenho", createPropertiesPanel(store, { ...importer, writeText }));
side.addTab(
  "job",
  "Conferir",
  createJobPanel(store, planner, createPreviewControls(overlay, player), (flag, title) => side.setFlag("job", flag, title)),
);
// (com a tela de plotagem aberta o painel do jog não está à vista: as setas não podem mexer na máquina)
const jog = createJogPanel(session, () => side.active === "machine" && !store.state.locked);
// Tela de plotagem: enquanto a máquina desenha (e até alguém clicar em "Voltar para a mesa"), ela toma o
// lugar do painel lateral e a mesa fica travada. O painel de envio diz o que mostrar e executa os botões.
const sounds = new Sounds();
const plotScreen = createPlotScreen(
  {
    stop: () => send.actions.stop(),
    togglePause: () => send.actions.togglePause(),
    continueAfterError: () => send.actions.continueAfterError(),
    feed: (change) => send.actions.feed(change),
    emergency: () => send.actions.emergency(),
    dismiss: () => send.actions.dismiss(),
  },
  sounds,
);
layout.side.after(plotScreen.el);
const setPlotting = (on: boolean) => {
  if (store.state.locked === on) return;
  store.setLocked(on);
  document.body.classList.toggle("plotting", on);
  layout.side.hidden = on;
};
const send = createSendPanel(session, store, planner, overlay, {
  onView: (view) => {
    plotScreen.show(view);
    setPlotting(!!view);
  },
  // dentro do clique em Enviar: o navegador só deixa tocar som depois de um gesto de quem usa
  onStart: () => sounds.arm(),
  onEnd: (result) => {
    if (result === "finished") sounds.play("done");
    else if (result === "failed") sounds.play("failed");
  },
});
const machineTab = h("div", { class: "panel" }, createPlotSteps(session, planner, (id) => side.show(id)), send.el, createMachinePanel(session), jog.el);
side.addTab("machine", "Plotar", machineTab);
session.subscribe((s) => overlay.setMachinePosition(s.link === "connected" ? s.wpos : undefined, !!s.status?.spindle));
const consolePanel = createConsole(session, layout.console);
layout.status.prepend(consolePanel.toggleButton);
// rodapé: as setas do teclado fazem jog (aba Máquina, conectado) ou movem o desenho?
const updateArrowMode = () => status.setMessage("arrows", jog.keysActive() ? "Setas: jog da máquina" : undefined);
side.onChange = updateArrowMode;
session.subscribe(updateArrowMode);

const view = new CanvasView(canvas, store, (n) =>
  status.setMessage("area", n ? `${n} desenho${n > 1 ? "s" : ""} fora da folha` : undefined, "warn"),
);
installEmergencyKey(session); // antes dos atalhos: Esc com a máquina andando é emergência, não "limpar seleção"
installShortcuts(store, { arrowsEnabled: () => !jog.keysActive() });
// dois cliques num desenho abrem a tela de apagar traços soltos (o primeiro clique já selecionou o desenho)
canvas.on("mouse:dblclick", (opt) => {
  const t = opt.target;
  if (!t) return;
  // (um conjunto é um objeto só: os dois cliques abrem a tela com todas as camadas dele, e lá dentro se escolhe uma)
  if (t instanceof DrawingObject && !store.state.selection.includes(t.drawingId)) store.setSelection([...t.drawingIds]);
  editStrokesOfSelection(store);
});

DrawingObject.penStyle = (id) => penOf(profile(), id);
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

// tela de vetorização (imagem → traço): carregada sob demanda, porque é a parte mais pesada
openTracer = (file) => {
  void import("./ui/trace/traceDialog").then((m) => m.openTraceDialog(store, file)).catch((e) => {
    console.error(e);
    toast("Não consegui abrir a vetorização.", "error");
  });
};

// acesso pelo console do navegador, para depurar
Object.assign(window, { plotter: { store, canvas, view, planner, side, session, sounds, openTracer: (f: File) => openTracer(f) } });
