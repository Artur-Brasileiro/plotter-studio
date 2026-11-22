/**
 * Cores escritas como "#rrggbb": a do papel e a de cada caneta. Só o que a tela precisa para decidir
 * se um papel é escuro (aí a grade e os textos da mesa mudam para claro) e para escrever uma cor de volta.
 */
export type Rgb = [number, number, number];

/** "#rrggbb" ou "#rgb" → [r, g, b] (0 a 255). Qualquer outra coisa → undefined. */
export function parseHex(c: string): Rgb | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return undefined;
  const s = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join("") : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function toHex(r: number, g: number, b: number): string {
  const p = (v: number) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`;
}

/** Luminância relativa (0 = preto, 1 = branco), a mesma conta do cinza das imagens. Cor ilegível = 1. */
export function luminance(c: string): number {
  const rgb = parseHex(c);
  if (!rgb) return 1;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

/** Papel (ou caneta) escuro: mais perto do preto que do branco. */
export function isDark(c: string): boolean {
  return luminance(c) < 0.45;
}
