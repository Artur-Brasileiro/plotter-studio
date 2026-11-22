import { machineRotationDeg } from "../../core/coords";
import {
  alignCenter,
  duplicateDrawings,
  removeDrawings,
  selectionMachineBBox,
  setMachineBox,
  setMachineRotation,
  setPen,
  translateMachine,
  type DrawingId,
} from "../../core/document";
import type { BBox } from "../../core/geometry/path";
import { penOf } from "../../core/machine";
import type { Store } from "../../core/store";
import { append, clear, h, toast } from "../dom";

/** Lê número digitado com vírgula ou ponto. */
export function parseNum(s: string): number | undefined {
  const v = Number(s.trim().replace(",", "."));
  return s.trim() !== "" && Number.isFinite(v) ? v : undefined;
}

const fmt = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("pt-BR", { maximumFractionDigits: d });

/** Rotação é "reta" (0/90/180/270)? Aí dá para escalar largura e altura separadamente sem distorcer. */
function isRightAngle(deg: number): boolean {
  const r = ((deg % 90) + 90) % 90;
  return r < 1e-6 || 90 - r < 1e-6;
}

export function duplicateSelection(store: Store): void {
  const ids = store.state.selection;
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
  const ids = store.state.selection;
  if (ids.length) store.commit(ids.length > 1 ? `Apagar ${ids.length} desenhos` : "Apagar", (doc) => removeDrawings(doc, ids));
}

/**
 * Abre a tela de apagar traços soltos para os desenhos selecionados (o botão "Apagar traços…" e os dois
 * cliques na mesa chegam aqui). A tela é carregada sob demanda, como a de vetorizar.
 */
export function editStrokesOfSelection(store: Store): void {
  const ids = store.state.selection;
  if (!ids.length) return;
  void import("../strokeEditor")
    .then((m) => m.openStrokeEditor(store, ids))
    .catch((e) => {
      console.error(e);
      toast("Não consegui abrir a tela de apagar traços.", "error");
    });
}

/**
 * Painel de propriedades da seleção: X/Y = canto inferior esquerdo da caixa na máquina,
 * largura/altura da caixa, rotação vista pelo operador. Cada edição é um commit
 * (Enter ou sair do campo); editar o mesmo campo seguidamente vira uma entrada só.
 */
/** O que o passo "Desenho" oferece quando a mesa está vazia. */
export interface BringActions {
  pickSvg(): void;
  pickImage(): void;
  writeText?(): void;
}

export function createPropertiesPanel(store: Store, bring?: BringActions): HTMLElement {
  const root = h("div", { class: "panel" });
  let keepRatio = true;
  const fields = new Map<string, HTMLInputElement>();

  const H = () => store.state.profile.workArea.height;
  const tol = () => store.state.profile.tolerance.chordMm;
  const sel = () => store.state.selection;
  const box = (): BBox => selectionMachineBBox(store.doc, sel(), H(), tol());

  const field = (key: string, label: string, onCommit: (v: number) => void, disabled = false) => {
    const input = h("input", { type: "text", inputMode: "decimal", disabled, "aria-label": label });
    const commit = () => {
      const v = parseNum(input.value);
      if (v === undefined) return render(true);
      onCommit(v);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commit();
        input.select();
      } else if (e.key === "Escape") {
        render(true);
        input.blur();
      }
    });
    fields.set(key, input);
    return h("label", { class: "field" }, label, input);
  };

  const align = (label: string, target: BBox) =>
    h("button", { onclick: () => store.commit("Alinhar", (doc) => alignCenter(doc, sel(), target, H(), tol())) }, label);

  const render = (force = false) => {
    const ids = sel();
    // não atrapalha quem está digitando
    if (!force && root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) {
      fill(ids.length);
      return;
    }
    clear(root);
    fields.clear();
    const docCount = store.doc.drawings.length;
    if (ids.length === 0) {
      const choices = bring
        ? [
            h("button", { class: "choice", onclick: () => bring.pickImage() }, h("strong", null, "Imagem PNG ou JPG"), h("span", null, "Vira traço aqui mesmo: linha única e hachura.")),
            h("button", { class: "choice", onclick: () => bring.pickSvg() }, h("strong", null, "Arquivo SVG"), h("span", null, "Desenho que já está em vetor (Inkscape, Illustrator).")),
            ...(bring.writeText ? [h("button", { class: "choice", onclick: () => bring.writeText!() }, h("strong", null, "Texto"), h("span", null, "Letras de traço único: a caneta escreve com uma linha só."))] : []),
          ]
        : [];
      if (!docCount) {
        append(root, [
          h("div", { class: "empty" }, h("h3", null, "Traga um desenho"), ...choices, h("p", { class: "hint" }, "Ou arraste o arquivo para cima da mesa. Ele cai dentro da folha, pronto para posicionar.")),
        ]);
        return;
      }
      const z = store.state.profile.drawZone;
      const list = h("ul", { class: "drawing-list" });
      for (const d of store.doc.drawings) {
        const b = selectionMachineBBox(store.doc, [d.id], H(), tol());
        const out = b.minX < z.minX - 0.005 || b.minY < z.minY - 0.005 || b.maxX > z.maxX + 0.005 || b.maxY > z.maxY + 0.005;
        list.append(
          h(
            "li",
            null,
            h(
              "button",
              { onclick: () => store.setSelection([d.id]), title: out ? "Este desenho sai da folha" : "Selecionar" },
              h("span", { class: "name" }, `${out ? "⚠ " : ""}${d.name}`),
              h("span", { class: "size" }, `${fmt(b.maxX - b.minX, 0)} × ${fmt(b.maxY - b.minY, 0)} mm`),
            ),
          ),
        );
      }
      append(root, [
        h("h3", null, docCount > 1 ? `${docCount} desenhos na mesa` : "Na mesa"),
        list,
        h("p", { class: "hint" }, "Clique num desenho para mover, girar ou mudar o tamanho. Shift + clique soma à seleção."),
        h("h3", null, "Trazer outro"),
        ...choices,
      ]);
      return;
    }
    const single = ids.length === 1 ? store.doc.drawings.find((d) => d.id === ids[0]) : undefined;
    const rot = single ? machineRotationDeg(single.transform) : 0;
    const free = !!single && isRightAngle(rot);

    root.append(h("div", { class: "title" }, single ? single.name : `${ids.length} desenhos selecionados`));
    const grid = h("div", { class: "grid2" });
    grid.append(
      field("x", "X (mm)", (v) => {
        if (single) store.commit("Mover", (doc) => setMachineBox(doc, single.id, { x: v, keepRatio: true }, H(), tol()), { coalesceKey: "field:x" });
        else store.commit("Mover", (doc) => translateMachine(doc, ids, { x: v - box().minX, y: 0 }), { coalesceKey: "field:x" });
      }),
      field("y", "Y (mm)", (v) => {
        if (single) store.commit("Mover", (doc) => setMachineBox(doc, single.id, { y: v, keepRatio: true }, H(), tol()), { coalesceKey: "field:y" });
        else store.commit("Mover", (doc) => translateMachine(doc, ids, { x: 0, y: v - box().minY }), { coalesceKey: "field:y" });
      }),
    );
    if (single) {
      const sizeLabel = "Redimensionar";
      grid.append(
        field("w", "Largura (mm)", (v) => {
          if (v <= 0) return render(true);
          store.commit(sizeLabel, (doc) => setMachineBox(doc, single.id, { width: v, keepRatio: keepRatio || !free }, H(), tol()), { coalesceKey: "field:w" });
        }),
        field("h", "Altura (mm)", (v) => {
          if (v <= 0) return render(true);
          store.commit(sizeLabel, (doc) => setMachineBox(doc, single.id, { height: v, keepRatio: keepRatio || !free }, H(), tol()), { coalesceKey: "field:h" });
        }),
        field("r", "Rotação (°)", (v) => {
          store.commit("Girar", (doc) => setMachineRotation(doc, single.id, v, H(), tol()), { coalesceKey: "field:r" });
        }),
      );
    }
    root.append(grid);

    if (single) {
      const cb = h("input", { type: "checkbox", checked: keepRatio || !free, disabled: !free });
      cb.addEventListener("change", () => (keepRatio = cb.checked));
      root.append(
        h("label", { class: "check", title: free ? "" : "Com o desenho girado em ângulo não reto, a proporção fica sempre travada (senão ele distorce)." }, cb, "Travar proporção"),
      );
    }

    // --- caneta: só aparece quando o estojo tem mais de uma
    const prof = store.state.profile;
    if (prof.pens.length > 1) {
      const chosen = store.doc.drawings.filter((d) => ids.includes(d.id)).map((d) => penOf(prof, d.penId).id);
      const same = chosen.every((p) => p === chosen[0]);
      const penSel = h(
        "select",
        { "aria-label": "Caneta" },
        same ? null : h("option", { value: "", selected: true }, "(várias)"),
        ...prof.pens.map((p) => h("option", { value: p.id, selected: same && p.id === chosen[0] }, `${p.name} (${fmt(p.widthMm)} mm)`)),
      );
      penSel.addEventListener("change", () => penSel.value && store.commit("Trocar a caneta", (doc) => setPen(doc, ids, penSel.value)));
      root.append(
        h("h3", null, "Caneta"),
        h("label", { class: "field" }, "Desenhado com", penSel),
        h("p", { class: "hint" }, "Cada caneta vira uma camada, plotada na ordem do estojo (Configurações → Estojo de canetas), com cruzes de registro para alinhar."),
      );
    }

    const { drawZone, paperTemplates } = store.state.profile;
    const zoneBox: BBox = { minX: drawZone.minX, minY: drawZone.minY, maxX: drawZone.maxX, maxY: drawZone.maxY };
    /** Aumenta ou diminui até caber na folha, com 5 mm de folga, e centraliza. */
    const fitToSheet = () => {
      if (!single) return;
      const b = box();
      const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
      if (!(bw > 0) || !(bh > 0)) return;
      const k = Math.min((drawZone.maxX - drawZone.minX - 10) / bw, (drawZone.maxY - drawZone.minY - 10) / bh);
      store.commit("Encaixar na folha", (doc) => alignCenter(setMachineBox(doc, single.id, { width: bw * k, keepRatio: true }, H(), tol()), [single.id], zoneBox, H(), tol()));
    };
    const turn = () => single && store.commit("Girar 90°", (doc) => setMachineRotation(doc, single.id, rot + 90, H(), tol()));
    root.append(
      h("h3", null, "Na folha"),
      h(
        "div",
        { class: "row" },
        single ? h("button", { class: "primary", title: "Deixa do maior tamanho que cabe na folha, centralizado", onclick: fitToSheet }, "Encaixar na folha") : null,
        align("Centralizar", zoneBox),
        single ? h("button", { title: "Gira 90° no sentido anti-horário", onclick: turn }, "Girar 90°") : null,
      ),
      ...(paperTemplates.length
        ? [h("div", { class: "row center" }, h("span", { class: "hint" }, "Centralizar no"), ...paperTemplates.map((t) => align(t.name, { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.height })))]
        : []),
      h("h3", null, "Ações"),
      h(
        "div",
        { class: "row" },
        h("button", { title: "Ctrl+D", onclick: () => duplicateSelection(store) }, "Duplicar"),
        h("button", { title: "Delete", onclick: () => deleteSelection(store) }, "Apagar"),
        h("button", { title: "Marcar traços soltos e tirar só eles do desenho (ou dois cliques no desenho)", onclick: () => editStrokesOfSelection(store) }, "Apagar traços…"),
        h("button", { class: "quiet", title: "Esc", onclick: () => store.setSelection([]) }, "Soltar seleção"),
      ),
      h("p", { class: "hint" }, "Setas movem 1 mm (Shift: 10 mm). Ctrl+Z desfaz, Ctrl+Y refaz. Dois cliques no desenho abrem “Apagar traços”."),
    );
    fill(ids.length);
  };

  /** Preenche os campos com a caixa atual (menos o que está com foco). */
  const fill = (n: number) => {
    if (n === 0) return;
    const b = box();
    const single = n === 1 ? store.doc.drawings.find((d) => d.id === sel()[0]) : undefined;
    const values: Record<string, string> = {
      x: fmt(b.minX),
      y: fmt(b.minY),
      w: fmt(b.maxX - b.minX),
      h: fmt(b.maxY - b.minY),
      r: single ? fmt(machineRotationDeg(single.transform), 2) : "",
    };
    for (const [k, input] of fields) if (input !== document.activeElement) input.value = values[k] ?? "";
  };

  store.subscribe((s, prev) => {
    if (s.selection !== prev.selection) render(true);
    else if (s.history !== prev.history || s.profile !== prev.profile) render();
  });
  render(true);
  return root;
}
