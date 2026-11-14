import { DEFAULT_PROFILE, mergeProfile, validateProfile, type MachineProfile } from "../../core/machine";
import type { Store } from "../../core/store";
import { exportProfileJson, importProfileJson, saveProfile } from "../../storage/profileStore";
import { append, clear, h, toast } from "../dom";
import { parseNum } from "./propertiesPanel";

interface NumField {
  readonly path: string;
  readonly label: string;
  readonly help: string;
  readonly min: number;
  readonly max: number | ((p: MachineProfile) => number);
}
interface TextField {
  readonly path: string;
  readonly label: string;
  readonly help: string;
  readonly text: true;
}
interface SelectField {
  readonly path: string;
  readonly label: string;
  readonly help: string;
  readonly options: readonly [string, string][];
}
type Field = NumField | TextField | SelectField;

const maxFeed = (p: MachineProfile) => p.motion.maxRateMmMin;

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Área útil",
    fields: [
      { path: "workArea.width", label: "Largura (mm)", help: "= $130 do GRBL. Até onde a caneta alcança em X.", min: 1, max: 5000 },
      { path: "workArea.height", label: "Altura (mm)", help: "= $131 do GRBL. Até onde a caneta alcança em Y.", min: 1, max: 5000 },
    ],
  },
  {
    title: "Caneta",
    fields: [
      { path: "pen.downCmd", label: "Comando para abaixar", help: "M3 S220 no fork do servo. Sem $ nem comentários.", text: true },
      { path: "pen.upCmd", label: "Comando para levantar", help: "M5: o GRBL faz M5 sozinho em reset ou alarme, então qualquer pane levanta a caneta.", text: true },
      { path: "pen.settleSeconds", label: "Pausa do servo (s)", help: "G4 depois de cada subida e descida. O servo leva ~0,3 s.", min: 0, max: 5 },
      {
        path: "pen.pauseLift",
        label: "Pausa (v2)",
        help: "Como a pausa levanta a caneta. Decidido no teste da máquina.",
        options: [
          ["spindleStop", "Levanta na hora (0x9E)"],
          ["endOfStroke", "Espera o fim do traço"],
        ],
      },
    ],
  },
  {
    title: "Velocidades (mm/min)",
    fields: [
      { path: "feed.fixed", label: "Fixa (padrão)", help: "Usada no modo fixo.", min: 1, max: maxFeed },
      { path: "feed.straight", label: "Retas", help: "Modo dinâmico. Testado perfeito a F1500; se tremer, baixe.", min: 1, max: maxFeed },
      { path: "feed.curve", label: "Curvas suaves", help: "Modo dinâmico. R40 saiu perfeito a F1000.", min: 1, max: maxFeed },
      { path: "feed.tightCurve", label: "Curvas fechadas", help: "Modo dinâmico. Se o círculo R5 de curvas.svg ondular, baixe para ~400.", min: 1, max: maxFeed },
    ],
  },
  {
    title: "Velocidade dinâmica",
    fields: [
      { path: "dynamic.straightMinRadiusMm", label: "Raio de reta (mm)", help: "Raio maior ou igual a isto anda como reta.", min: 0.01, max: 100000 },
      { path: "dynamic.curveMinRadiusMm", label: "Raio de curva (mm)", help: "Raio maior ou igual a isto é curva suave; abaixo, curva fechada.", min: 0.01, max: 10000 },
      { path: "dynamic.cornerAngleDeg", label: "Ângulo de canto (°)", help: "Vértice que vira mais que isto é canto: quem freia é o GRBL ($11).", min: 1, max: 179 },
      { path: "dynamic.maxCurveSegmentMm", label: "Segmento máx. de curva (mm)", help: "Segmento mais longo que isto é reta, não pedaço de curva.", min: 0.1, max: 1000 },
      { path: "dynamic.windowMm", label: "Janela (mm)", help: "A velocidade mais lenta se estende isto para cada lado.", min: 0, max: 100 },
    ],
  },
  {
    title: "Tolerâncias (mm)",
    fields: [
      { path: "tolerance.chordMm", label: "Curva → retas", help: "Erro máximo ao converter curvas em segmentos.", min: 0.001, max: 1 },
      { path: "tolerance.simplifyMm", label: "Simplificação", help: "Ramer–Douglas–Peucker: tira pontos quase alinhados.", min: 0, max: 1 },
      { path: "tolerance.minSegmentMm", label: "Segmento mínimo", help: "Segmentos menores são fundidos (o buffer do GRBL agradece).", min: 0, max: 5 },
      { path: "tolerance.joinGapMm", label: "Junção de pontas", help: "Pontas mais próximas que isto são ligadas sem levantar a caneta.", min: 0, max: 5 },
    ],
  },
  {
    title: "Movimento (estimativa e buffer)",
    fields: [
      { path: "motion.maxRateMmMin", label: "Velocidade máx. (mm/min)", help: "= $110/$111.", min: 1, max: 100000 },
      { path: "motion.accelMmS2", label: "Aceleração (mm/s²)", help: "= $120/$121.", min: 1, max: 100000 },
      { path: "motion.junctionDeviationMm", label: "Junction deviation (mm)", help: "= $11. Quanto menor, mais o GRBL freia nos cantos.", min: 0.0001, max: 1 },
      { path: "motion.minSegmentTimeMs", label: "Tempo mín. por segmento (ms)", help: "Segmentos curtos andam mais devagar para o buffer não esvaziar. 0 desliga.", min: 0, max: 100 },
    ],
  },
  {
    title: "G-code",
    fields: [
      { path: "gcode.finalPosition.x", label: "Posição final X (mm)", help: "Para onde a máquina vai ao terminar.", min: 0, max: (p) => p.workArea.width },
      { path: "gcode.finalPosition.y", label: "Posição final Y (mm)", help: "", min: 0, max: (p) => p.workArea.height },
    ],
  },
  {
    title: "Conexão (v2)",
    fields: [
      { path: "serial.baudRate", label: "Baud rate", help: "115200 no GRBL 1.1.", min: 300, max: 2_000_000 },
      { path: "serial.statusIntervalMs", label: "Intervalo do status (ms)", help: "Consulta '?' do estado da máquina.", min: 50, max: 2000 },
      { path: "serial.rxBufferBytes", label: "Buffer de recepção (bytes)", help: "128 no Arduino Uno.", min: 16, max: 1024 },
    ],
  },
];

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}
function set(obj: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj) as Record<string, unknown>;
  target[last] = value;
}
const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("pt-BR", { maximumFractionDigits: 6, useGrouping: false }) : String(v ?? ""));

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: name, style: "display:none" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Diálogo de Configurações (perfil da máquina). Edita um rascunho; só aplica ao Salvar. */
export function createSettingsDialog(store: Store): { open: () => void } {
  const dialog = h("dialog", { class: "settings" });
  document.body.append(dialog);
  let draft: MachineProfile = mergeProfile(store.state.profile);
  const fieldErrors = new Map<string, string>();
  const globalErrors = h("ul", { class: "problems", hidden: true });
  const saveBtn = h("button", { class: "primary", onclick: () => save() }, "Salvar");

  const refreshErrors = () => {
    const all = validateProfile(draft);
    clear(globalErrors);
    const list = fieldErrors.size ? [...fieldErrors.values()] : all;
    for (const e of list) globalErrors.append(h("li", null, e));
    globalErrors.hidden = list.length === 0;
    saveBtn.disabled = list.length > 0;
  };

  const numField = (f: NumField) => {
    const input = h("input", { type: "text", inputMode: "decimal", value: fmt(get(draft, f.path)), "aria-label": f.label });
    const err = h("span", { class: "field-error" });
    input.addEventListener("input", () => {
      const v = parseNum(input.value);
      const max = typeof f.max === "function" ? f.max(draft) : f.max;
      let msg = "";
      if (v === undefined) msg = "número inválido";
      else if (v < f.min || v > max) msg = `entre ${fmt(f.min)} e ${fmt(max)}`;
      err.textContent = msg;
      input.classList.toggle("invalid", !!msg);
      if (msg) fieldErrors.set(f.path, `${f.label}: ${msg}.`);
      else {
        fieldErrors.delete(f.path);
        set(draft, f.path, v);
      }
      refreshErrors();
    });
    return h("label", { class: "field", title: f.help }, f.label, input, err, f.help ? h("small", { class: "help" }, f.help) : null);
  };
  const textField = (f: TextField) => {
    const input = h("input", { type: "text", value: String(get(draft, f.path) ?? ""), "aria-label": f.label });
    input.addEventListener("input", () => {
      set(draft, f.path, input.value);
      refreshErrors();
    });
    return h("label", { class: "field", title: f.help }, f.label, input, h("small", { class: "help" }, f.help));
  };
  const selectField = (f: SelectField) => {
    const sel = h("select", { "aria-label": f.label }, ...f.options.map(([v, l]) => h("option", { value: v, selected: get(draft, f.path) === v }, l)));
    sel.addEventListener("change", () => set(draft, f.path, sel.value));
    return h("label", { class: "field", title: f.help }, f.label, sel, h("small", { class: "help" }, f.help));
  };

  const templatesSection = () => {
    const box = h("div", { class: "templates" });
    const render = () => {
      clear(box);
      draft.paperTemplates.forEach((t, i) => {
        const num = (k: "x" | "y" | "width" | "height", label: string) => {
          const input = h("input", { type: "text", inputMode: "decimal", value: fmt(t[k]), "aria-label": `${t.name} ${label}`, title: label });
          input.addEventListener("input", () => {
            const v = parseNum(input.value);
            input.classList.toggle("invalid", v === undefined);
            if (v !== undefined) t[k] = v;
            refreshErrors();
          });
          return input;
        };
        const name = h("input", { type: "text", value: t.name, "aria-label": "Nome do gabarito" });
        name.addEventListener("input", () => {
          t.name = name.value;
          refreshErrors();
        });
        box.append(
          h(
            "div",
            { class: "tpl-row" },
            name,
            num("x", "x"),
            num("y", "y"),
            num("width", "largura"),
            num("height", "altura"),
            h(
              "button",
              {
                title: "Remover",
                onclick: () => {
                  draft.paperTemplates.splice(i, 1);
                  render();
                  refreshErrors();
                },
              },
              "✕",
            ),
          ),
        );
      });
      box.append(
        h(
          "button",
          {
            onclick: () => {
              draft.paperTemplates.push({ name: "Novo", x: 0, y: 0, width: 100, height: 100 });
              render();
              refreshErrors();
            },
          },
          "+ Gabarito",
        ),
      );
    };
    render();
    return h(
      "fieldset",
      null,
      h("legend", null, "Gabaritos de papel (mm da máquina: x, y do canto inferior esquerdo, largura, altura)"),
      h("p", { class: "hint" }, "As posições padrão foram supostas na origem. Meça os gabaritos riscados na madeira e corrija aqui."),
      box,
    );
  };

  const fileInput = h("input", { type: "file", accept: ".json,application/json", style: "display:none" });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    try {
      draft = importProfileJson(await f.text());
      fieldErrors.clear();
      render();
      toast("Perfil importado. Confira e clique em Salvar.");
    } catch (e) {
      toast((e as Error).message, "error", 9000);
    }
  });

  function render() {
    clear(dialog);
    const body = h("div", { class: "settings-body" });
    for (const g of GROUPS) {
      const grid = h("div", { class: "grid2" });
      for (const f of g.fields) grid.append("text" in f ? textField(f) : "options" in f ? selectField(f) : numField(f));
      body.append(h("fieldset", null, h("legend", null, g.title), grid));
    }
    body.append(templatesSection());
    append(dialog, [
      h("header", { class: "settings-head" }, h("strong", null, "Configurações da máquina"), h("button", { class: "close", title: "Fechar sem salvar", onclick: () => dialog.close() }, "✕")),
      body,
      globalErrors,
      h(
        "footer",
        { class: "settings-foot" },
        h(
          "button",
          {
            onclick: () => {
              draft = mergeProfile(DEFAULT_PROFILE);
              fieldErrors.clear();
              render();
              toast("Valores padrão carregados. Clique em Salvar para aplicar.");
            },
          },
          "Restaurar padrão",
        ),
        h("button", { onclick: () => downloadText("perfil-plotter.json", exportProfileJson(store.state.profile)), title: "Baixa o perfil salvo (backup)" }, "Exportar JSON"),
        h("button", { onclick: () => fileInput.click() }, "Importar JSON"),
        fileInput,
        h("span", { class: "spacer" }),
        h("button", { onclick: () => dialog.close() }, "Cancelar"),
        saveBtn,
      ),
    ]);
    refreshErrors();
  }

  function save() {
    const errs = [...fieldErrors.values(), ...validateProfile(draft)];
    if (errs.length) return refreshErrors();
    const p = mergeProfile(draft);
    store.setProfile(p);
    try {
      saveProfile(p);
      toast("Configurações salvas.");
    } catch {
      toast("Configurações aplicadas, mas não consegui salvar no navegador.", "warn");
    }
    dialog.close();
  }

  return {
    open: () => {
      draft = mergeProfile(store.state.profile);
      fieldErrors.clear();
      render();
      dialog.showModal();
    },
  };
}
