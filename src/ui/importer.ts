import { addDrawing, createDrawing, importPlacement } from "../core/document";
import type { Store } from "../core/store";
import { SvgImportError } from "../core/svg/importSvg";
import { readSvgFile } from "../import/svgDom";
import { h, toast } from "./dom";

function newId(): string {
  return crypto.randomUUID();
}

/** Importa arquivos SVG como novos desenhos (página no canto (0,0) da máquina) e seleciona-os. */
export async function importFiles(store: Store, files: Iterable<File>): Promise<void> {
  const ids: string[] = [];
  for (const file of files) {
    if (!/\.svg$/i.test(file.name) && file.type !== "image/svg+xml") {
      toast(`"${file.name}" não é um SVG.`, "warn");
      continue;
    }
    try {
      const { name, result } = await readSvgFile(file);
      const H = store.state.profile.workArea.height;
      const d = createDrawing(newId(), name, result.geometry, importPlacement(result.pageMm, H));
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

/** Botão "Importar SVG" (com input escondido) e arrastar-e-soltar na janela. */
export function installImport(store: Store, toolbar: HTMLElement, dropTarget: HTMLElement): void {
  const input = h("input", { type: "file", accept: ".svg,image/svg+xml", multiple: true, style: "display:none" });
  input.addEventListener("change", () => {
    if (input.files) void importFiles(store, Array.from(input.files));
    input.value = "";
  });
  toolbar.append(h("button", { class: "primary", title: "Importar um ou mais arquivos SVG", onclick: () => input.click() }, "Importar SVG"), input);

  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    dropTarget.classList.add("dragover");
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
    void importFiles(store, Array.from(e.dataTransfer!.files));
  });
}
