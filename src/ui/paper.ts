import { parseHex } from "../core/color";

/**
 * A cor do papel que está na mesa. É só para a TELA: a mesa, a vetorização e o editor de traços mostram
 * o desenho como ele vai ficar (caneta branca em papel preto, por exemplo). Não muda o G-code.
 * Fica guardada no navegador (localStorage "plotter-studio:paper").
 */
const KEY = "plotter-studio:paper";
export const PAPER_WHITE = "#ffffff";
/** As folhas que aparecem prontas para escolher (qualquer outra cor entra pelo seletor de cor). */
export const PAPERS: readonly { name: string; color: string }[] = [
  { name: "Branco", color: PAPER_WHITE },
  { name: "Preto", color: "#16171a" },
  { name: "Kraft", color: "#c9a56b" },
];

let current: string | undefined;
const listeners = new Set<() => void>();

export function paperColor(): string {
  if (current === undefined) {
    current = PAPER_WHITE;
    try {
      const saved = localStorage.getItem(KEY);
      if (saved && parseHex(saved)) current = saved;
    } catch {
      /* sem armazenamento: papel branco */
    }
  }
  return current;
}

export function setPaperColor(c: string): void {
  if (!parseHex(c) || c === paperColor()) return;
  current = c;
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* sem armazenamento: só não lembra */
  }
  for (const l of [...listeners]) l();
}

/** Avisa quando o papel muda. Devolve a função que desliga o aviso. */
export function onPaperChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
