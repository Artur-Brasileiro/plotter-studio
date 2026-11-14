/**
 * Árvore SVG simplificada, sem DOM. `src/import/svgDom.ts` converte o resultado do
 * DOMParser para isto; os testes montam árvores à mão com `el()`.
 */
export interface SvgNode {
  /** Nome local, minúsculo ("path", "g", "svg"...) */
  readonly tag: string;
  /** Atributos como vieram ("xlink:href" e "href" preservados) */
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly SvgNode[];
}

export function el(tag: string, attrs: Record<string, string> = {}, children: SvgNode[] = []): SvgNode {
  return { tag: tag.toLowerCase(), attrs, children };
}

/** Número no formato do SVG: "1", "-.5", "1.5e-3". */
export const NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Lê todos os números de uma lista ("1,2 3-4" → [1,2,3,−4]). undefined se sobrar lixo. */
export function parseNumberList(s: string): number[] | undefined {
  const out: number[] = [];
  let i = 0;
  const skip = () => {
    while (i < s.length && (s[i] === " " || s[i] === "," || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  };
  skip();
  while (i < s.length) {
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(s);
    if (!m) return undefined;
    out.push(Number(m[0]));
    i = NUMBER_RE.lastIndex;
    skip();
  }
  return out;
}
