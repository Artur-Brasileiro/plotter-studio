import { machineRotationDeg } from "../../core/coords";
import {
  alignCenter,
  duplicateDrawings,
  expandToGroups,
  fitSelection,
  groupsOf,
  removeDrawings,
  selectionMachineBBox,
  setPen,
  setSelectionBox,
  setSelectionRotation,
  type Drawing,
  type DrawingId,
} from "../../core/document";
import type { BBox } from "../../core/geometry/path";
import { penOf } from "../../core/machine";
import type { Store } from "../../core/store";
import { append, clear, h, toast } from "../dom";
import { isRightAngle, onRatioLockChange, onTurning, ratioLocked, setRatioLocked } from "../gestures";

/** Lê número digitado com vírgula ou ponto. */
export function parseNum(s: string): number | undefined {
  const v = Number(s.trim().replace(",", "."));
  return s.trim() !== "" && Number.isFinite(v) ? v : undefined;
}

const fmt = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("pt-BR", { maximumFractionDigits: d });
/** Folga de "Encaixar na folha" (mm de cada lado). */
const FIT_MARGIN = 5;

/** A seleção, sempre com os conjuntos inteiros (as camadas de uma imagem andam juntas). */
function selectedIds(store: Store): DrawingId[] {
  return expandToGroups(store.doc, store.state.selection);
}

export function duplicateSelection(store: Store): void {
  const ids = selectedIds(store);
  if (!ids.length) return;
  let newIds: DrawingId[] = [];
  const H = store.state.profile.workArea.height;
  store.commit("Duplicar", (doc) => {
    const r = duplicateDrawings(doc, ids, () => crypto.randomUUID(), { x: 10, y: -10 }, H);
    newIds = r.newIds;
    return r.doc;
  });
  store.setSelection(newIds);
}

export function deleteSelection(store: Store): void {
  const ids = selectedIds(store);
  if (!ids.length) return;
  // um conjunto conta como um desenho só
  const items = groupsOf(store.doc).filter((item) => item.some((id) => ids.includes(id))).length;
  store.commit(items > 1 ? `Apagar ${items} desenhos` : "Apagar", (doc) => removeDrawings(doc, ids));
}

/**
 * Abre a tela de apagar traços soltos para os desenhos selecionados (o botão "Apagar traços" de cada
 * camada e os dois cliques na mesa chegam aqui). `focusId` abre a tela já numa camada. A tela é carregada
 * sob demanda, como a de vetorizar.
 */
export function editStrokesOfSelection(store: Store, focusId?: DrawingId): void {
  const ids = selectedIds(store);
  if (!ids.length) return;
  void import("../strokeEditor")
    .then((m) => m.openStrokeEditor(store, ids, focusId))
    .catch((e) => {
      console.error(e);
      toast("Não consegui abrir a tela de apagar traços.", "error");
    });
}

/** O que o passo "Desenho" oferece quando a mesa está vazia. */
export interface BringActions {
  pickSvg(): void;
  pickImage(): void;
  writeText?(): void;
}

/**
 * O passo "Desenho". Em cima, "Na mesa": a lista do que está na mesa, sempre à vista (um conjunto de
 * camadas é uma linha só). Embaixo, o que está selecionado: as camadas dele (a caneta de cada uma, apagar
 * traços, remover), a posição e o tamanho, e as ações. Clicar numa linha seleciona; "Soltar" volta a não
 * ter nada selecionado. Nenhuma ação de camada exige selecionar a camada na mesa.
 *
 * X/Y = canto inferior esquerdo da caixa na máquina; largura/altura da caixa; rotação vista pelo operador.
 * Cada edição é um commit (Enter ou sair do campo); editar o mesmo campo seguidamente vira uma entrada só.
 *
 * "Travar proporção" é a mesma trava das alças da mesa (`gestures.ts`): ligada, o desenho cresce e
 * diminui por igual, digitando ou arrastando. O campo "Ângulo" acompanha o giro feito com o mouse.
 */
export function createPropertiesPanel(store: Store, bring?: BringActions): HTMLElement {
  const listBox = h("div", { class: "panel-section" });
  const detailBox = h("div", { class: "panel-section" });
  const root = h("div", { class: "panel" }, listBox, detailBox);
  const fields = new Map<string, HTMLInputElement>();
  // o que depende do giro atual e precisa acompanhar o desenho mesmo sem refazer o painel (ver `fill`)
  let ratioBox: HTMLInputElement | undefined;
  let straighten: HTMLButtonElement | undefined;

  const H = () => store.state.profile.workArea.height;
  const tol = () => store.state.profile.tolerance.chordMm;
  const sel = () => selectedIds(store);
  const boxOf = (ids: readonly DrawingId[]): BBox => selectionMachineBBox(store.doc, ids, H(), tol());
  const pensOf = (members: readonly Drawing[]) => members.map((d) => penOf(store.state.profile, d.penId));
  const outOfSheet = (b: BBox) => {
    const z = store.state.profile.drawZone;
    return b.minX < z.minX - 0.005 || b.minY < z.minY - 0.005 || b.maxX > z.maxX + 0.005 || b.maxY > z.maxY + 0.005;
  };

  const choices = () =>
    bring
      ? [
          h("button", { class: "choice", onclick: () => bring.pickImage() }, h("strong", null, "Imagem PNG ou JPG"), h("span", null, "Vira traço aqui mesmo: linha única e hachura.")),
          h("button", { class: "choice", onclick: () => bring.pickSvg() }, h("strong", null, "Arquivo SVG"), h("span", null, "Desenho que já está em vetor (Inkscape, Illustrator).")),
          ...(bring.writeText ? [h("button", { class: "choice", onclick: () => bring.writeText!() }, h("strong", null, "Texto"), h("span", null, "Letras de traço único: a caneta escreve com uma linha só."))] : []),
        ]
      : [];

  // ------------------------------------------------------------------ "Na mesa": a lista, sempre à vista
  /** Clicar numa linha seleciona o item; com Shift ou Ctrl, soma à seleção (ou tira dela). */
  const pick = (item: readonly DrawingId[], add: boolean) => {
    if (!add) return store.setSelection(item);
    const cur = sel();
    const inside = item.every((id) => cur.includes(id));
    store.setSelection(inside ? cur.filter((id) => !item.includes(id)) : [...cur, ...item]);
  };

  function renderList() {
    clear(listBox);
    const doc = store.doc;
    if (!doc.drawings.length) {
      listBox.append(h("div", { class: "empty" }, h("h3", null, "Traga um desenho"), ...choices(), h("p", { class: "hint" }, "Ou arraste o arquivo para cima da mesa.")));
      return;
    }
    const byId = new Map(doc.drawings.map((d) => [d.id, d]));
    const cur = sel();
    const items = groupsOf(doc);
    const list = h("ul", { class: "drawing-list" });
    for (const item of items) {
      const members = item.map((id) => byId.get(id)!);
      const b = boxOf(item);
      const out = outOfSheet(b);
      const on = item.every((id) => cur.includes(id));
      const colors = [...new Set(pensOf(members).map((p) => p.color))].slice(0, 5);
      list.append(
        h(
          "li",
          null,
          h(
            "button",
            {
              class: on ? "on" : "",
              "aria-pressed": String(on),
              title: out ? "Este desenho sai da folha" : members.length > 1 ? `${members.length} camadas, uma por caneta` : "",
              onclick: (e: MouseEvent) => pick(item, e.shiftKey || e.ctrlKey || e.metaKey),
            },
            h("span", { class: "dots", "aria-hidden": "true" }, ...colors.map((c) => h("span", { class: "pen-dot", style: `--c:${c}` }))),
            h("span", { class: "name" }, `${out ? "⚠ " : ""}${members[0].name}`),
            h("span", { class: "size" }, `${fmt(b.maxX - b.minX, 0)} × ${fmt(b.maxY - b.minY, 0)} mm`),
          ),
        ),
      );
    }
    append(listBox, [h("h3", null, items.length > 1 ? `Na mesa (${items.length})` : "Na mesa"), list]);
  }

  // ------------------------------------------------------------------ o que está selecionado
  /** Campo de número. `label` é o que aparece (curto); `name` é o nome completo, com a unidade, para leitor de tela. */
  const field = (key: string, label: string, name: string, onCommit: (v: number) => void) => {
    const input = h("input", { type: "text", inputMode: "decimal", "aria-label": name, title: name });
    const commit = () => {
      const v = parseNum(input.value);
      if (v === undefined) return renderDetail(true);
      onCommit(v);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commit();
        input.select();
      } else if (e.key === "Escape") {
        renderDetail(true);
        input.blur();
      }
    });
    fields.set(key, input);
    return h("label", { class: "field" }, label, input);
  };

  /** Uma linha por camada: a caneta, quantos traços, e as duas ações que só valem para ela. */
  const layerRow = (d: Drawing, alone: boolean) => {
    const prof = store.state.profile;
    const pen = penOf(prof, d.penId);
    const n = d.geometry.subpaths.length;
    const penSel =
      prof.pens.length > 1
        ? h("select", { "aria-label": `Caneta da camada ${pen.name}`, title: "A caneta que desenha esta camada" }, ...prof.pens.map((p) => h("option", { value: p.id, selected: p.id === pen.id }, `${p.name} (${fmt(p.widthMm)} mm)`)))
        : h("span", { class: "pen-name" }, `${pen.name} (${fmt(pen.widthMm)} mm)`);
    if (penSel instanceof HTMLSelectElement) penSel.addEventListener("change", () => store.commit("Trocar a caneta", (doc) => setPen(doc, [d.id], penSel.value)));
    return h(
      "div",
      { class: "layer-row" },
      h("span", { class: "pen-dot", style: `--c:${pen.color}`, "aria-hidden": "true" }),
      penSel,
      h(
        "div",
        { class: "acts" },
        h("span", { class: "n" }, `${n.toLocaleString("pt-BR")} ${n === 1 ? "traço" : "traços"}`),
        h("button", { title: "Abre o desenho grande para marcar traços desta camada e apagar ou passar para outra caneta", onclick: () => editStrokesOfSelection(store, d.id) }, "Editar traços"),
        alone ? null : h("button", { class: "quiet", title: "Tira esta camada do desenho (as outras ficam)", "aria-label": `Remover a camada ${pen.name}`, onclick: () => store.commit("Remover camada", (doc) => removeDrawings(doc, [d.id])) }, "Remover"),
      ),
    );
  };

  function renderDetail(force = false) {
    const ids = sel();
    // não atrapalha quem está digitando
    if (!force && detailBox.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return fill(ids);
    clear(detailBox);
    fields.clear();
    ratioBox = undefined;
    straighten = undefined;
    const doc = store.doc;
    if (!doc.drawings.length) return;
    if (!ids.length) {
      append(detailBox, [h("p", { class: "hint" }, "Clique num desenho, na lista ou na mesa, para mexer nele."), h("h3", null, "Trazer outro"), ...choices()]);
      return;
    }
    const members = doc.drawings.filter((d) => ids.includes(d.id));
    const items = groupsOf(doc).filter((item) => item.some((id) => ids.includes(id)));
    const one = items.length === 1;
    // lidos na hora de agir, não na hora de montar o painel: quem acabou de digitar um ângulo continua com o
    // foco no campo, e o painel não é refeito enquanto isso
    const rotNow = () => rotationOf(ids);
    const lockNow = () => ratioLocked() || !isRightAngle(rotNow());
    const commit = store.commit.bind(store);

    detailBox.append(
      h(
        "div",
        { class: "sel-head" },
        h("strong", { class: "title" }, one ? members[0].name : `${items.length} desenhos selecionados`),
        h("button", { class: "quiet", title: "Deixa de selecionar (tecla Esc)", onclick: () => store.setSelection([]) }, "✕ Soltar"),
      ),
    );

    if (one) {
      append(detailBox, [
        h("h3", { class: "sub" }, members.length > 1 ? `Camadas (${members.length})` : "Caneta e traços"),
        h("div", { class: "layer-rows" }, ...members.map((d) => layerRow(d, members.length === 1))),
      ]);
    }

    // posição e tamanho: os quatro números numa linha só (a unidade vai no título)
    const grid = h("div", { class: one ? "grid4" : "grid2" });
    grid.append(
      field("x", "X", "X (mm)", (v) => commit("Mover", (d) => setSelectionBox(d, ids, { x: v, keepRatio: true }, H(), tol()), { coalesceKey: "field:x" })),
      field("y", "Y", "Y (mm)", (v) => commit("Mover", (d) => setSelectionBox(d, ids, { y: v, keepRatio: true }, H(), tol()), { coalesceKey: "field:y" })),
    );
    let ratioRow: HTMLElement | null = null;
    let turnRow: HTMLElement | null = null;
    if (one) {
      grid.append(
        field("w", "Largura", "Largura (mm)", (v) => {
          if (v <= 0) return renderDetail(true);
          commit("Redimensionar", (d) => setSelectionBox(d, ids, { width: v, keepRatio: lockNow() }, H(), tol()), { coalesceKey: "field:w" });
        }),
        field("h", "Altura", "Altura (mm)", (v) => {
          if (v <= 0) return renderDetail(true);
          commit("Redimensionar", (d) => setSelectionBox(d, ids, { height: v, keepRatio: lockNow() }, H(), tol()), { coalesceKey: "field:h" });
        }),
      );
      const cb = h("input", { type: "checkbox" });
      cb.addEventListener("change", () => setRatioLocked(cb.checked));
      ratioBox = cb;
      ratioRow = h("label", { class: "check ratio" }, cb, "Travar proporção");
      straighten = h("button", { title: "Volta o desenho para o ângulo 0", onclick: () => commit("Endireitar", (d) => setSelectionRotation(d, ids, 0, H(), tol())) }, "Endireitar");
      turnRow = h(
        "div",
        { class: "turn-row" },
        field("r", "Ângulo (°)", "Ângulo do giro (°): positivo gira para a esquerda", (v) => commit("Girar", (d) => setSelectionRotation(d, ids, v, H(), tol()), { coalesceKey: "field:r" })),
        h("button", { title: "Gira 90° no sentido anti-horário", onclick: () => commit("Girar 90°", (d) => setSelectionRotation(d, ids, rotNow() + 90, H(), tol())) }, "Girar 90°"),
        straighten,
      );
    }
    append(detailBox, [h("h3", { class: "sub" }, one ? "Posição e tamanho (mm)" : "Posição (mm)"), grid, ratioRow, turnRow]);

    const { drawZone, paperTemplates } = store.state.profile;
    const zoneBox: BBox = { minX: drawZone.minX, minY: drawZone.minY, maxX: drawZone.maxX, maxY: drawZone.maxY };
    const center = (label: string, target: BBox, title = "") => h("button", { title, onclick: () => commit("Alinhar", (d) => alignCenter(d, ids, target, H(), tol())) }, label);
    append(detailBox, [
      h(
        "div",
        { class: "row" },
        one ? h("button", { class: "primary", title: "Deixa do maior tamanho que cabe na folha, centralizado", onclick: () => commit("Encaixar na folha", (d) => fitSelection(d, ids, zoneBox, FIT_MARGIN, H(), tol())) }, "Encaixar na folha") : null,
        center("Centralizar na folha", zoneBox, "Leva para o meio da folha, sem mudar o tamanho"),
      ),
      paperTemplates.length
        ? h("div", { class: "row center" }, h("span", { class: "hint" }, "Centralizar no gabarito"), ...paperTemplates.map((t) => center(t.name, { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.height }, `Leva para o meio do gabarito ${t.name} riscado na mesa`)))
        : null,
      h(
        "div",
        { class: "row sel-actions" },
        h("button", { title: "Faz uma cópia ao lado (Ctrl+D)", onclick: () => duplicateSelection(store) }, "Duplicar"),
        h("button", { title: one ? "Tira o desenho inteiro da mesa (Delete)" : "Tira os desenhos selecionados da mesa (Delete)", onclick: () => deleteSelection(store) }, one ? "Apagar o desenho" : "Apagar"),
      ),
      h("p", { class: "hint" }, "Arraste na mesa para mover; as setas movem 1 mm (com Shift, 10 mm)."),
    ]);
    fill(ids);
  }

  /** O giro do que está selecionado (o do primeiro desenho; as camadas de um conjunto giram juntas). */
  function rotationOf(ids: readonly DrawingId[]): number {
    const first = store.doc.drawings.find((d) => ids.includes(d.id));
    return first ? machineRotationDeg(first.transform) : 0;
  }

  /** Preenche os campos com a caixa atual (menos o que está com foco), e acerta a trava e o "Endireitar". */
  function fill(ids: readonly DrawingId[]) {
    if (!ids.length || !fields.size) return;
    const b = boxOf(ids);
    const rot = rotationOf(ids);
    const values: Record<string, string> = {
      x: fmt(b.minX),
      y: fmt(b.minY),
      w: fmt(b.maxX - b.minX),
      h: fmt(b.maxY - b.minY),
      r: fmt(rot, 2),
    };
    for (const [k, input] of fields) if (input !== document.activeElement) input.value = values[k] ?? "";
    if (ratioBox) {
      // girado em ângulo não reto, a proporção fica sempre travada (esticar ali entortaria o traço)
      const free = isRightAngle(rot);
      ratioBox.checked = ratioLocked() || !free;
      ratioBox.disabled = !free;
      const label = ratioBox.parentElement;
      if (label) {
        label.title = !free
          ? "Com o desenho girado em ângulo não reto, a proporção fica sempre travada (senão ele deforma)."
          : ratioBox.checked
            ? "Ligado: o desenho aumenta e diminui por igual, na mesa e nos campos. Desligue para esticar só a largura ou só a altura."
            : "Desligado: dá para esticar só a largura ou só a altura. Na mesa, o Shift mantém a proporção enquanto estiver apertado.";
      }
    }
    if (straighten) straighten.disabled = rot === 0;
  }

  const render = (force: boolean) => {
    // refazer o painel não pode jogar a rolagem lá para cima (trocar a caneta de uma camada no fim da lista, por exemplo)
    const scroller = root.parentElement;
    const top = scroller?.scrollTop ?? 0;
    renderList();
    renderDetail(force);
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  };
  store.subscribe((s, prev) => {
    if (s.selection !== prev.selection) render(true);
    else if (s.history !== prev.history || s.profile !== prev.profile) render(false);
  });
  onRatioLockChange(() => fill(sel()));
  // girando com o mouse na mesa: o campo "Ângulo" mostra o valor ao vivo; quando o giro termina, vale o que ficou gravado
  onTurning((t) => {
    const input = fields.get("r");
    if (!t) return fill(sel());
    if (input && input !== document.activeElement) input.value = fmt(t.deg, 2);
  });
  render(true);
  return root;
}
