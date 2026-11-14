import type { SvgNode } from "../core/svg/node";
import { importSvgTree, SvgImportError, type ImportResult } from "../core/svg/importSvg";

const SVG_NS = "http://www.w3.org/2000/svg";

function convert(el: Element): SvgNode {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const children: SvgNode[] = [];
  for (const c of Array.from(el.children)) {
    // elementos de outros namespaces (sodipodi:, inkscape:, metadados) não fazem parte do desenho
    if (c.namespaceURI === SVG_NS) children.push(convert(c));
  }
  return { tag: el.localName.toLowerCase(), attrs, children };
}

/** Texto do arquivo → árvore simples. É a única parte da importação que usa o DOM. */
export function parseSvgText(text: string): SvgNode {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) {
    // Chrome: "<h3>This page contains...</h3><div>error on line 1 at column 14: ...</div>"
    const raw = (err.querySelector("div")?.textContent ?? err.textContent ?? "").trim();
    const m = /line (\d+) at column (\d+):\s*([^\n]*?)\s*(?:Below is|$)/.exec(raw);
    const detail = m ? `linha ${m[1]}, coluna ${m[2]}: ${m[3]}` : raw.split("\n")[0].slice(0, 120) || "XML mal formado";
    throw new SvgImportError(`SVG inválido (${detail.slice(0, 160)})`);
  }
  const root = doc.documentElement;
  if (root.localName !== "svg") throw new SvgImportError("O arquivo não é um SVG.");
  return convert(root);
}

export async function readSvgFile(file: File): Promise<{ name: string; result: ImportResult }> {
  const text = await file.text();
  return { name: file.name, result: importSvgTree(parseSvgText(text)) };
}
