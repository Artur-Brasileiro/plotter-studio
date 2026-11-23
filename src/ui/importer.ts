import { addDrawing, createDrawing, importPlacement } from "../core/document";
import type { Store } from "../core/store";
import { SvgImportError } from "../core/svg/importSvg";
import { readSvgFile } from "../import/svgDom";
import { h, toast } from "./dom";

function newId(): string {
  return crypto.randomUUID();
}

const isSvg = (f: File) => /\.svg$/i.test(f.name) || f.type === "image/svg+xml";
const isImage = (f: File) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name) || (/^image\//.test(f.type) && f.type !== "image/svg+xml");

/** Importa arquivos SVG como novos desenhos (página no canto da folha) e seleciona-os. */
export async function importFiles(store: Store, files: Iterable<File>): Promise<void> {
  const ids: string[] = [];
  for (const file of files) {
    if (!isSvg(file)) {
      toast(`"${file.name}" não é um SVG.`, "warn");
      continue;
    }
    try {
      const { name, result } = await readSvgFile(file);
      const { workArea, drawZone } = store.state.profile;
      const d = createDrawing(newId(), name, result.geometry, importPlacement(result.pageMm, workArea.height, { x: drawZone.minX, y: drawZone.minY }));
      store.commit("Importar", (doc) => addDrawing(doc, d));
      ids.push(d.id);
      for (const w of result.warnings) toast(`${name}: ${w.message}`, "warn", 9000);
    } catch (e) {
      const msg = e instanceof SvgImportError ? e.message : `erro inesperado (${(e as Error).message})`;
      toast(`Não consegui importar "${file.name}": ${msg}`, "error", 9000);
      if (!(e instanceof SvgImportError)) console.error(e);
    }
  }
  if (ids.length) store.setSelection(ids);
}

export interface Importer {
  /** Abre a escolha de arquivo SVG */
  pickSvg(): void;
  /** Abre a escolha de imagem (PNG, JPG...) para vetorizar */
  pickImage(): void;
}

/**
 * Entrada de desenhos: escolha de arquivo (SVG ou imagem) e arrastar-e-soltar na janela.
 * SVG entra direto na mesa; imagem vai para `onImage` (a tela de vetorização).
 */
export function installImport(store: Store, dropTarget: HTMLElement, onImage: (file: File) => void): Importer {
  /** Mesa travada (a máquina está desenhando): nada entra. Avisa e devolve true. */
  const locked = () => {
    if (!store.state.locked) return false;
    toast("A mesa está travada enquanto a máquina desenha. Traga o desenho quando ela terminar.", "warn", 7000);
    return true;
  };
  const svgInput = h("input", { type: "file", accept: ".svg,image/svg+xml", multiple: true, style: "display:none" });
  svgInput.addEventListener("change", () => {
    if (svgInput.files && !locked()) void importFiles(store, Array.from(svgInput.files));
    svgInput.value = "";
  });
  const imgInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg,.webp,.bmp", style: "display:none" });
  imgInput.addEventListener("change", () => {
    const f = imgInput.files?.[0];
    imgInput.value = "";
    if (f && !locked()) onImage(f);
  });
  document.body.append(svgInput, imgInput);

  const take = (files: File[]) => {
    if (locked()) return;
    const svgs = files.filter(isSvg);
    const image = files.find((f) => !isSvg(f) && isImage(f));
    const other = files.filter((f) => !isSvg(f) && !isImage(f));
    for (const f of other) toast(`"${f.name}" não é SVG nem imagem.`, "warn");
    if (svgs.length) void importFiles(store, svgs);
    if (image) onImage(image);
  };

  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    if (!store.state.locked) dropTarget.classList.add("dragover");
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) dropTarget.classList.remove("dragover");
  });
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dropTarget.classList.remove("dragover");
    take(Array.from(e.dataTransfer!.files));
  });

  return { pickSvg: () => svgInput.click(), pickImage: () => imgInput.click() };
}

/** Botão com lista suspensa (fecha ao escolher, ao clicar fora ou com Esc). */
export function createMenu(label: string, items: { label: string; hint: string; action: () => void }[], cls = "primary"): HTMLElement {
  const list = h("div", { class: "menu-list", role: "menu", hidden: true });
  const button = h("button", { class: cls, "aria-haspopup": "menu", "aria-expanded": "false" }, `${label} ▾`);
  const close = () => {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    list.hidden = !list.hidden;
    button.setAttribute("aria-expanded", String(!list.hidden));
  });
  for (const it of items) {
    list.append(
      h(
        "button",
        {
          role: "menuitem",
          onclick: () => {
            close();
            it.action();
          },
        },
        it.label,
        h("small", null, it.hint),
      ),
    );
  }
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  return h("div", { class: "menu" }, button, list);
}
