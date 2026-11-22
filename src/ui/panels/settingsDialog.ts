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
interface BoolField {
  readonly path: string;
  readonly label: string;
  readonly help: string;
  readonly bool: true;
}
type Field = NumField | TextField | SelectField | BoolField;

const maxFeed = (p: MachineProfile) => p.motion.maxRateMmMin;
const W = (p: MachineProfile) => p.workArea.width;
const H = (p: MachineProfile) => p.workArea.height;

interface Group {
  readonly id: string;
  readonly title: string;
  /** Uma ou duas frases: para que serve este grupo */
  readonly lead: string;
  readonly fields: Field[];
  /** Mostra a lista de gabaritos de papel depois dos campos */
  readonly templates?: boolean;
  /** Mostra o estojo de canetas antes dos campos */
  readonly pens?: boolean;
}

const GROUPS: Group[] = [
  {
    id: "sheet",
    title: "Mesa e folha",
    lead: "O curso é até onde a caneta alcança. A folha é a parte da mesa onde o desenho pode ficar: nada é desenhado fora dela.",
    fields: [
      { path: "drawZone.minX", label: "Folha: X mínimo (mm)", help: "Borda esquerda da folha.", min: 0, max: W },
      { path: "drawZone.maxX", label: "Folha: X máximo (mm)", help: "Borda direita da folha.", min: 0, max: W },
      { path: "drawZone.minY", label: "Folha: Y mínimo (mm)", help: "Borda da frente (perto de você).", min: 0, max: H },
      { path: "drawZone.maxY", label: "Folha: Y máximo (mm)", help: "Borda do fundo.", min: 0, max: H },
      { path: "workArea.width", label: "Curso em X (mm)", help: "= $130 do GRBL.", min: 1, max: 5000 },
      { path: "workArea.height", label: "Curso em Y (mm)", help: "= $131 do GRBL.", min: 1, max: 5000 },
    ],
    templates: true,
  },
  {
    id: "pen",
    title: "Subir e descer a caneta",
    lead: "Como a caneta sobe e desce. A largura e a cor de cada caneta ficam em Canetas.",
    fields: [
      {
        path: "pen.pauseLift",
        label: "Ao pausar um desenho",
        help: "Como a pausa levanta a caneta. Decida no teste da máquina.",
        options: [
          ["spindleStop", "Levanta na hora (0x9E)"],
          ["endOfStroke", "Espera o fim do traço"],
        ],
      },
      { path: "pen.settleSeconds", label: "Pausa depois de descer (s)", help: "G4 depois do M3. O servo leva ~0,3 s para chegar.", min: 0.05, max: 5 },
      { path: "pen.settleUpSeconds", label: "Pausa depois de subir (s)", help: "G4 depois do M5.", min: 0.05, max: 5 },
      { path: "pen.downCmd", label: "Comando para abaixar", help: "M3 S220 no fork do servo. Sem $ nem comentários.", text: true },
      { path: "pen.upCmd", label: "Comando para levantar", help: "M5: o GRBL faz M5 sozinho em reset ou alarme, então qualquer pane levanta a caneta.", text: true },
    ],
  },
  {
    id: "pens",
    title: "Estojo de canetas",
    lead: "O estojo. Cada caneta usada num trabalho vira uma camada, plotada nesta ordem (cor, depois a fina, depois a grossa: a grossa cobre as pontas da fina).",
    pens: true,
    fields: [
      {
        path: "registration.mode",
        label: "Cruzes de registro",
        help: "Uma cruz antes e outra depois de cada camada, para alinhar as canetas.",
        options: [
          ["auto", "Só com mais de uma caneta"],
          ["always", "Sempre"],
          ["never", "Nunca"],
        ],
      },
      { path: "registration.armMm", label: "Braço da cruz (mm)", help: "Serve de régua na foto para medir o deslocamento da ponta.", min: 1, max: 50 },
      { path: "registration.x1", label: "1ª cruz: X (mm)", help: "Feita antes de tudo.", min: 0, max: W },
      { path: "registration.x2", label: "2ª cruz: X (mm)", help: "Feita por último.", min: 0, max: W },
      { path: "registration.y", label: "Cruzes: Y (mm)", help: "Na borda, fora do desenho.", min: 0, max: H },
    ],
  },
  {
    id: "servo",
    title: "Proteção do servo",
    lead: "O que esquenta o servo é subir e descer sem parar, não ficar embaixo. Aqui ficam os limites e o que fazer quando um desenho passa deles.",
    fields: [
      { path: "servo.avgPerMin", label: "Média máxima (descidas por minuto)", help: "A regra original pede 20. Até ~30 tem rodado sem problema.", min: 1, max: 200 },
      { path: "servo.peakPer60s", label: "Pico máximo em 60 s", help: "Acima de ~50 por minuto, com picos de 80, o servo já travou de quente.", min: 1, max: 400 },
      {
        path: "servo.onOverload",
        label: "Se o desenho passar do limite",
        help: "Esperar: a máquina descansa com a caneta em cima e o desenho demora mais.",
        options: [
          ["wait", "Esperar com a caneta em cima"],
          ["warn", "Só avisar"],
          ["block", "Bloquear o envio"],
        ],
      },
      { path: "servo.maxDescentMm", label: "Traço máximo por descida (mm)", help: "Depois disso a caneta sobe e desce no mesmo ponto. 900 mm ≈ 2 min a F500.", min: 10, max: 100000 },
      { path: "join.searchMm", label: "Procurar emenda até (mm)", help: "Distância em que se procura um traço que dê para emendar sem aparecer.", min: 0, max: 50 },
      { path: "join.overInk", label: "Emendar por cima de tinta", help: "A ligação entre dois traços pode ser desenhada quando passa inteira sobre tinta do próprio desenho.", bool: true },
    ],
  },
  {
    id: "shield",
    title: "Blindagem",
    lead: "Proteções contra falha da caneta: aquecer o servo antes, subir duas vezes, re-sincronizar de tempos em tempos e dividir o arquivo em partes.",
    fields: [
      { path: "shield.enabled", label: "Usar a blindagem", help: "Desligada, o arquivo sai no formato simples, sem nada disso.", bool: true },
      { path: "shield.doubleLift", label: "Subir a caneta duas vezes", help: "Se um comando se perder na serial, o segundo ainda levanta a caneta.", bool: true },
      { path: "shield.warmupCycles", label: "Ciclos de aquecimento", help: "Sobe e desce no ponto seguro antes do 1º traço. Também contam para o limite do servo.", min: 0, max: 20 },
      { path: "shield.firstSettleSeconds", label: "Pausa da 1ª descida (s)", help: "Mais longa, para o 1º traço não sair sem tinta.", min: 0.05, max: 5 },
      { path: "shield.safeX", label: "Ponto seguro X (mm)", help: "Onde acontece o aquecimento, fora do desenho.", min: 0, max: W },
      { path: "shield.safeY", label: "Ponto seguro Y (mm)", help: "", min: 0, max: H },
      { path: "shield.resyncMinutes", label: "Checkpoint a cada (min)", help: "Dois ciclos curtos que re-sincronizam o servo. 0 desliga.", min: 0, max: 120 },
      { path: "shield.partMinutes", label: "Duração de cada parte (min)", help: "O arquivo também sai dividido em partes deste tamanho. 0 não divide.", min: 0, max: 600 },
    ],
  },
  {
    id: "speed",
    title: "Velocidades",
    lead: "Em mm/min. F500 é a precisão máxima; até F1500 a diferença não aparece. O modo dinâmico anda mais rápido nas retas.",
    fields: [
      { path: "feed.fixed", label: "Fixa (padrão)", help: "Usada no modo fixo.", min: 1, max: maxFeed },
      { path: "feed.straight", label: "Dinâmico: retas", help: "Testado perfeito a F1500; se tremer, baixe.", min: 1, max: maxFeed },
      { path: "feed.curve", label: "Dinâmico: curvas suaves", help: "R40 saiu perfeito a F1000.", min: 1, max: maxFeed },
      { path: "feed.tightCurve", label: "Dinâmico: curvas fechadas", help: "Se o círculo R5 ondular, baixe para ~400.", min: 1, max: maxFeed },
      { path: "dynamic.straightMinRadiusMm", label: "Raio de reta (mm)", help: "Raio maior ou igual a isto anda como reta.", min: 0.01, max: 100000 },
      { path: "dynamic.curveMinRadiusMm", label: "Raio de curva (mm)", help: "Maior ou igual a isto é curva suave; abaixo, curva fechada.", min: 0.01, max: 10000 },
      { path: "dynamic.cornerAngleDeg", label: "Ângulo de canto (°)", help: "Vértice que vira mais que isto é canto: quem freia é o GRBL ($11).", min: 1, max: 179 },
      { path: "dynamic.maxCurveSegmentMm", label: "Segmento máx. de curva (mm)", help: "Segmento mais longo que isto é reta, não pedaço de curva.", min: 0.1, max: 1000 },
      { path: "dynamic.windowMm", label: "Janela (mm)", help: "A velocidade mais lenta se estende isto para cada lado.", min: 0, max: 100 },
    ],
  },
  {
    id: "precision",
    title: "Precisão e movimento",
    lead: "Como as curvas viram segmentos de reta, e os números do GRBL usados para estimar o tempo.",
    fields: [
      { path: "tolerance.chordMm", label: "Curva → retas (mm)", help: "Erro máximo ao converter curvas em segmentos.", min: 0.001, max: 1 },
      { path: "tolerance.simplifyMm", label: "Simplificação (mm)", help: "Tira pontos quase alinhados.", min: 0, max: 1 },
      { path: "tolerance.minSegmentMm", label: "Segmento mínimo (mm)", help: "Segmentos menores são fundidos (o buffer do GRBL agradece).", min: 0, max: 5 },
      { path: "motion.minSegmentTimeMs", label: "Tempo mín. por segmento (ms)", help: "Segmentos curtos andam mais devagar para o buffer não esvaziar. 0 desliga.", min: 0, max: 100 },
      { path: "motion.maxRateMmMin", label: "Velocidade máx. (mm/min)", help: "= $110/$111.", min: 1, max: 100000 },
      { path: "motion.accelMmS2", label: "Aceleração (mm/s²)", help: "= $120/$121.", min: 1, max: 100000 },
      { path: "motion.junctionDeviationMm", label: "Junction deviation (mm)", help: "= $11. Quanto menor, mais o GRBL freia nos cantos.", min: 0.0001, max: 1 },
    ],
  },
  {
    id: "link",
    title: "Fim e conexão",
    lead: "Para onde a máquina vai ao terminar, e a conversa pela serial.",
    fields: [
      { path: "gcode.finalPosition.x", label: "Posição final X (mm)", help: "Para onde a máquina vai ao terminar.", min: 0, max: W },
      { path: "gcode.finalPosition.y", label: "Posição final Y (mm)", help: "", min: 0, max: H },
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

  const boolField = (f: BoolField) => {
    const cb = h("input", { type: "checkbox", checked: get(draft, f.path) === true, "aria-label": f.label });
    cb.addEventListener("change", () => {
      set(draft, f.path, cb.checked);
      refreshErrors();
    });
    return h("div", { class: "field" }, h("label", { class: "check" }, cb, f.label), f.help ? h("small", { class: "help" }, f.help) : null);
  };

  const pensSection = () => {
    const box = h("div", { class: "templates" });
    const render = () => {
      clear(box);
      box.append(h("div", { class: "pen-row pen-head" }, h("span", null, "Cor"), h("span", null, "Nome"), h("span", null, "Traço (mm)"), h("span", null, "Ponta X"), h("span", null, "Ponta Y"), h("span", null, "")));
      draft.pens.forEach((p, i) => {
        const num = (k: "widthMm" | "offsetX" | "offsetY", label: string) => {
          const input = h("input", { type: "text", inputMode: "decimal", value: fmt(p[k]), "aria-label": `${p.name}: ${label}`, title: label });
          input.addEventListener("input", () => {
            const v = parseNum(input.value);
            input.classList.toggle("invalid", v === undefined);
            if (v !== undefined) p[k] = v;
            refreshErrors();
          });
          return input;
        };
        const color = h("input", { type: "color", value: p.color, "aria-label": `${p.name}: cor na tela` });
        color.addEventListener("input", () => (p.color = color.value));
        const name = h("input", { type: "text", value: p.name, "aria-label": "Nome da caneta" });
        name.addEventListener("input", () => {
          p.name = name.value;
          refreshErrors();
        });
        const move = (d: number) => {
          const j = i + d;
          if (j < 0 || j >= draft.pens.length) return;
          [draft.pens[i], draft.pens[j]] = [draft.pens[j], draft.pens[i]];
          render();
        };
        box.append(
          h(
            "div",
            { class: "pen-row" },
            color,
            name,
            num("widthMm", "largura do traço"),
            num("offsetX", "deslocamento da ponta em X"),
            num("offsetY", "deslocamento da ponta em Y"),
            h(
              "span",
              { class: "row" },
              h("button", { title: "Plotar antes", "aria-label": "Plotar antes", disabled: i === 0, onclick: () => move(-1) }, "↑"),
              h("button", { title: "Plotar depois", "aria-label": "Plotar depois", disabled: i === draft.pens.length - 1, onclick: () => move(1) }, "↓"),
              h(
                "button",
                {
                  title: "Tirar do estojo",
                  "aria-label": "Tirar do estojo",
                  disabled: draft.pens.length <= 1,
                  onclick: () => {
                    draft.pens.splice(i, 1);
                    if (!draft.pens.some((q) => q.id === draft.defaultPen)) draft.defaultPen = draft.pens[draft.pens.length - 1].id;
                    render();
                    refreshErrors();
                  },
                },
                "✕",
              ),
            ),
          ),
        );
      });
      const def = h("select", { "aria-label": "Caneta padrão" }, ...draft.pens.map((p) => h("option", { value: p.id, selected: p.id === draft.defaultPen }, p.name)));
      def.addEventListener("change", () => (draft.defaultPen = def.value));
      box.append(
        h(
          "button",
          {
            onclick: () => {
              draft.pens.push({ id: `caneta-${Date.now().toString(36)}`, name: "Nova caneta", widthMm: 0.4, color: "#7a3fb8", offsetX: 0, offsetY: 0 });
              render();
              refreshErrors();
            },
          },
          "+ Caneta",
        ),
        h("label", { class: "field", style: "max-width:260px" }, "Caneta dos desenhos novos", def),
      );
    };
    render();
    return h(
      "div",
      { class: "panel-section" },
      box,
      h(
        "p",
        { class: "help" },
        "Ponta X / Y: quanto a ponta desta caneta fica deslocada no suporte em relação à de referência. Rode a 1ª cruz, fotografe, meça com o braço da cruz e ponha o valor aqui: a camada inteira sai corrigida. Na fina 0,03 mediu-se +1,0 mm em X.",
      ),
    );
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
      "div",
      { class: "panel-section" },
      h("h4", null, "Gabaritos de papel"),
      h("p", { class: "lead", style: "margin:0" }, "Retângulos tracejados na mesa. Nome, depois x, y do canto inferior esquerdo, largura e altura, em mm da máquina. Meça os que estão riscados na madeira e corrija aqui."),
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

  let currentGroup = GROUPS[0].id;

  function render() {
    clear(dialog);
    const body = h("div", { class: "settings-body" });
    const nav = h("nav", { class: "settings-nav", "aria-label": "Grupos de configuração" });
    const showGroup = (id: string) => {
      currentGroup = id;
      const g = GROUPS.find((x) => x.id === id) ?? GROUPS[0];
      for (const b of Array.from(nav.children)) b.classList.toggle("on", (b as HTMLElement).dataset.id === g.id);
      clear(body);
      const grid = h("div", { class: "grid2" });
      for (const f of g.fields) grid.append("text" in f ? textField(f) : "options" in f ? selectField(f) : "bool" in f ? boolField(f) : numField(f));
      append(body, [h("h4", null, g.title), h("p", { class: "lead" }, g.lead), g.pens ? pensSection() : null, grid, g.templates ? templatesSection() : null]);
      body.scrollTop = 0;
    };
    for (const g of GROUPS) nav.append(h("button", { dataset: { id: g.id }, onclick: () => showGroup(g.id) }, g.title));
    showGroup(currentGroup);
    append(dialog, [
      h("header", { class: "settings-head" }, h("strong", null, "Configurações"), h("button", { class: "close", title: "Fechar sem salvar", "aria-label": "Fechar sem salvar", onclick: () => dialog.close() }, "✕")),
      h("div", { class: "settings-main" }, nav, body),
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
        h("button", { onclick: () => downloadText("perfil-plotter.json", exportProfileJson(store.state.profile)), title: "Baixa o perfil salvo (backup)" }, "Exportar"),
        h("button", { onclick: () => fileInput.click() }, "Importar"),
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
