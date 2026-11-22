import { flattenGeometry } from "../geometry/flatten";
import { IDENTITY } from "../geometry/mat2d";
import { bboxOfPoints, emptyBBox, unionBBox, type Geometry, type Segment, type SubPath } from "../geometry/path";
import type { Vec } from "../geometry/vec";
import { FONT_DATA, type FontId } from "./fontData";

/**
 * Texto em fonte de TRAÇO ÚNICO (fontes Hershey): cada letra é o caminho que a caneta faz, e não um
 * contorno para preencher. É o texto certo para uma plotter de caneta: uma linha só, poucas descidas.
 *
 * As fontes só têm o ASCII. Os acentos do português são montados aqui: a letra sem acento mais o
 * sinal desenhado por cima (ou a cedilha por baixo).
 */

export const FONT_NAMES: Record<FontId, string> = { simples: "Simples", futura: "Futura", cursiva: "Cursiva" };

/** Unidades da fonte: as maiúsculas vão de y = −12 (topo) a y = 9 (linha de base); Y cresce para baixo. */
const CAP_TOP = -12;
const BASELINE = 9;
export const CAP_UNITS = BASELINE - CAP_TOP;
/** Distância entre linhas de base, em unidades, com entrelinha 1 (cabe o acento de uma maiúscula e a perna do "g") */
const LINE_UNITS = 34;

export interface Glyph {
  readonly left: number;
  readonly right: number;
  /** Polilinhas, em unidades da fonte */
  readonly strokes: readonly (readonly Vec[])[];
}

const R = 82; // 'R'
const cache = new Map<FontId, Glyph[]>();

/** As 96 letras (ASCII 32 a 127) de uma fonte. */
export function glyphsOf(font: FontId): Glyph[] {
  let g = cache.get(font);
  if (!g) {
    g = FONT_DATA[font].map(parseGlyph);
    cache.set(font, g);
  }
  return g;
}

/** Uma linha do arquivo .jhf, sem as 5 colunas do número: "  9MWRFRT RRYQZR[SZRY". */
export function parseGlyph(line: string): Glyph {
  const d = line.slice(3);
  const strokes: Vec[][] = [];
  let cur: Vec[] = [];
  for (let i = 2; i + 1 < d.length; i += 2) {
    if (d[i] === " " && d[i + 1] === "R") {
      if (cur.length) strokes.push(cur);
      cur = [];
    } else cur.push({ x: d.charCodeAt(i) - R, y: d.charCodeAt(i + 1) - R });
  }
  if (cur.length) strokes.push(cur);
  return { left: d.charCodeAt(0) - R, right: d.charCodeAt(1) - R, strokes };
}

type Mark = "acute" | "grave" | "circ" | "tilde" | "uml" | "cedilla" | "ring";

/** Letra acentuada → letra sem acento + sinal. */
const COMPOSED: Record<string, [string, Mark]> = {};
for (const [marks, mark] of [
  ["áéíóúýÁÉÍÓÚÝ", "acute"],
  ["àèìòùÀÈÌÒÙ", "grave"],
  ["âêîôûÂÊÎÔÛ", "circ"],
  ["ãõñÃÕÑ", "tilde"],
  ["äëïöüÄËÏÖÜ", "uml"],
  ["çÇ", "cedilla"],
  ["åÅ", "ring"],
] as const) {
  for (const ch of marks) COMPOSED[ch] = [ch.normalize("NFD")[0], mark];
}

/** Caracteres fora do ASCII que têm um equivalente simples. */
const REPLACE: Record<string, string> = {
  "“": '"', "”": '"', "„": '"', "«": '"', "»": '"', "‘": "'", "’": "'", "‚": "'",
  "–": "-", "—": "-", "−": "-", "…": "...", " ": " ", "\t": "    ", "º": "o", "ª": "a", "×": "x", "·": ".",
};

/** O sinal, em unidades da fonte, centrado em `cx`, logo acima de `top` (ou abaixo da linha de base, na cedilha). */
function markStrokes(mark: Mark, cx: number, top: number): Vec[][] {
  const y = top - 2;
  switch (mark) {
    case "acute":
      return [[{ x: cx - 1.5, y }, { x: cx + 2.5, y: y - 4.5 }]];
    case "grave":
      return [[{ x: cx + 1.5, y }, { x: cx - 2.5, y: y - 4.5 }]];
    case "circ":
      return [[{ x: cx - 3.5, y }, { x: cx, y: y - 4 }, { x: cx + 3.5, y }]];
    case "tilde":
      return [[{ x: cx - 4.5, y: y - 0.8 }, { x: cx - 3.2, y: y - 2.6 }, { x: cx - 1.6, y: y - 3 }, { x: cx, y: y - 2 }, { x: cx + 1.6, y: y - 1 }, { x: cx + 3.2, y: y - 1.4 }, { x: cx + 4.5, y: y - 3.2 }]];
    case "uml":
      return [-2.8, 2.8].map((dx) => [{ x: cx + dx, y: y - 1 }, { x: cx + dx, y: y - 2.2 }]);
    case "ring":
      return [[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ x: cx + 2 * Math.cos((k * Math.PI) / 4), y: y - 2.5 + 2 * Math.sin((k * Math.PI) / 4) }))];
    case "cedilla":
      return [[{ x: cx + 0.5, y: BASELINE }, { x: cx - 0.5, y: BASELINE + 2.5 }, { x: cx + 1.2, y: BASELINE + 3 }, { x: cx + 1.6, y: BASELINE + 4.8 }, { x: cx + 0.2, y: BASELINE + 6 }, { x: cx - 2, y: BASELINE + 5.6 }]];
  }
}

/** A letra pronta para desenhar, ou `undefined` se a fonte não tem esse caractere. */
export function glyphFor(font: FontId, ch: string): Glyph | undefined {
  const glyphs = glyphsOf(font);
  const plain = (c: string): Glyph | undefined => {
    // o último caractere (127) é o sinal de grau nas fontes Simples e Cursiva; na Futura é um bloco cheio, que não serve
    if (c === "°") return font === "futura" ? undefined : glyphs[127 - 32];
    if (c.length !== 1) return undefined;
    const code = c.charCodeAt(0);
    return code >= 32 && code < 127 ? glyphs[code - 32] : undefined;
  };
  const direct = plain(ch);
  if (direct) return direct;
  const comp = COMPOSED[ch];
  if (!comp) return undefined;
  const base = plain(comp[0]);
  if (!base) return undefined;
  let top = Infinity, minX = Infinity, maxX = -Infinity;
  for (const s of base.strokes) {
    for (const p of s) {
      if (p.y < top) top = p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
  }
  // O "i" perde o pingo quando ganha acento. O pingo é o traço pequeno e solto da letra (na Simples e
  // na Futura fica lá em cima; na Cursiva, logo acima do corpo): acha-se pelo tamanho, não pela altura.
  let strokes = base.strokes;
  if (comp[0] === "i" && base.strokes.length > 1) {
    const size = (s: readonly Vec[]) => {
      const xs = s.map((q) => q.x), ys = s.map((q) => q.y);
      return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    };
    const dot = base.strokes.reduce((a, b) => (size(b) < size(a) ? b : a));
    if (size(dot) <= 4) {
      strokes = base.strokes.filter((s) => s !== dot);
      top = Math.min(...strokes.flat().map((q) => q.y));
    }
  }
  const cx = comp[1] === "cedilla" ? (minX + maxX) / 2 : (minX + maxX) / 2 + (font === "cursiva" ? 2 : 0);
  return { left: base.left, right: base.right, strokes: [...strokes, ...markStrokes(comp[1], cx, Number.isFinite(top) ? top : CAP_TOP)] };
}

export type TextAlign = "left" | "center" | "right";

export interface TextOptions {
  readonly font: FontId;
  /** Altura das letras maiúsculas no papel (mm) */
  readonly capHeightMm: number;
  /** Entrelinha: 1 = normal */
  readonly lineSpacing: number;
  /** Espaço a mais entre letras, em fração da altura da maiúscula (0 = o da fonte) */
  readonly letterSpacing: number;
  readonly align: TextAlign;
  /** Curvas suaves: os vértices das curvas viram Béziers (as letras ficam redondas em tamanho grande) */
  readonly smooth: boolean;
}

export const DEFAULT_TEXT: TextOptions = { font: "simples", capHeightMm: 12, lineSpacing: 1, letterSpacing: 0, align: "left", smooth: true };

export interface TextResult {
  /** mm, Y para baixo, canto superior esquerdo da caixa do texto em (0, 0) */
  readonly geometry: Geometry;
  readonly width: number;
  readonly height: number;
  /** Caracteres que a fonte não tem (ficaram de fora) */
  readonly missing: readonly string[];
  /** Quantas vezes a caneta desce */
  readonly strokes: number;
}

/** Vértice de curva: a linha vira menos que isto. Acima disso é canto e fica vivo. */
const SMOOTH_MAX_TURN = (55 * Math.PI) / 180;

/**
 * Segmento "longo", em unidades da fonte: as curvas das letras são feitas de passos de 2 a 4 unidades;
 * daqui para cima é uma reta de verdade (a haste e os braços do Y têm 11 e 13).
 */
export const LONG_SEGMENT_UNITS = 7;

/**
 * Polilinha → subcaminho. Com `smooth`, os vértices suaves ganham tangente contínua (Catmull-Rom).
 * Um vértice entre DUAS retas longas é canto, por menor que seja o ângulo (o encontro do braço com a
 * haste do Y vira só 39°). `longLen` é o comprimento a partir do qual um segmento conta como reta
 * longa, na unidade dos pontos.
 */
export function polylineToSubPath(pts: readonly Vec[], smooth: boolean, longLen: number = LONG_SEGMENT_UNITS): SubPath {
  const n = pts.length;
  const closed = n > 3 && Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y) < 1e-9;
  if (!smooth || n < 3) return { start: pts[0], segments: pts.slice(1).map((to) => ({ kind: "line" as const, to })), closed: false };
  const dir = (a: Vec, b: Vec): Vec => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  // tangente em cada vértice, ou undefined num canto / numa ponta
  const tangents: (Vec | undefined)[] = pts.map((p, i) => {
    let prev: Vec | undefined = pts[i - 1], next: Vec | undefined = pts[i + 1];
    if (closed && i === 0) prev = pts[n - 2];
    if (closed && i === n - 1) next = pts[1];
    if (!prev || !next) return undefined;
    const a = dir(prev, p), b = dir(p, next);
    const turn = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)));
    if (turn > SMOOTH_MAX_TURN) return undefined;
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > longLen && Math.hypot(next.x - p.x, next.y - p.y) > longLen) return undefined;
    return dir(prev, next);
  });
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = pts[i], b = pts[i + 1];
    const ta = tangents[i], tb = tangents[i + 1];
    if (!ta && !tb) {
      segments.push({ kind: "line", to: b });
      continue;
    }
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const d = dir(a, b);
    const k = len / 3;
    const c1 = { x: a.x + (ta ?? d).x * k, y: a.y + (ta ?? d).y * k };
    const c2 = { x: b.x - (tb ?? d).x * k, y: b.y - (tb ?? d).y * k };
    segments.push({ kind: "cubic", c1, c2, to: b });
  }
  return { start: pts[0], segments, closed: false };
}

/** Monta o texto (com quebras de linha) como geometria em mm. */
export function textGeometry(text: string, options: Partial<TextOptions> = {}): TextResult {
  const o = { ...DEFAULT_TEXT, ...options };
  const empty: TextResult = { geometry: { subpaths: [] }, width: 0, height: 0, missing: [], strokes: 0 };
  // medida que não é número (ou não é positiva) não tem desenho
  if (!(o.capHeightMm > 0) || !Number.isFinite(o.capHeightMm) || !Number.isFinite(o.lineSpacing) || !Number.isFinite(o.letterSpacing)) return empty;
  const k = o.capHeightMm / CAP_UNITS;
  const extra = o.letterSpacing * CAP_UNITS;
  const missing = new Set<string>();
  // NFC: texto colado de PDF ou vindo do macOS traz "a" + "~" separados; aqui voltam a ser uma letra só
  const clean = [...text.normalize("NFC").replace(/\r\n?/g, "\n")].map((ch) => REPLACE[ch] ?? ch).join("");
  const rows = clean.split("\n").map((row) => {
    const items: { glyph: Glyph; x: number }[] = [];
    let x = 0;
    for (const ch of row) {
      const g = glyphFor(o.font, ch);
      if (!g) {
        if (ch.trim()) missing.add(ch);
        continue;
      }
      items.push({ glyph: g, x: x - g.left });
      x += g.right - g.left + extra;
    }
    return { items, width: Math.max(0, x - (items.length ? extra : 0)) };
  });
  const widthU = Math.max(0, ...rows.map((r) => r.width));
  let subpaths: SubPath[] = [];
  rows.forEach((row, ri) => {
    const dx = o.align === "left" ? 0 : o.align === "center" ? (widthU - row.width) / 2 : widthU - row.width;
    const dy = ri * LINE_UNITS * o.lineSpacing;
    for (const it of row.items) {
      for (const s of it.glyph.strokes) {
        if (s.length === 0) continue;
        const pts = s.map((p) => ({ x: (p.x + it.x + dx) * k, y: (p.y + dy) * k }));
        // um ponto solto (não há nas fontes, mas um sinal poderia ter) vira um tracinho mínimo
        subpaths.push(pts.length === 1 ? { start: pts[0], segments: [{ kind: "line", to: pts[0] }], closed: false } : polylineToSubPath(pts, o.smooth, LONG_SEGMENT_UNITS * k));
      }
    }
  });
  if (subpaths.length === 0) return { ...empty, missing: [...missing] };
  // a caixa é a da tinta de verdade (acentos e pernas incluídos), com o canto de cima à esquerda em (0, 0)
  let box = emptyBBox();
  for (const pl of flattenGeometry({ subpaths }, IDENTITY, Math.max(0.005, k * 0.02))) box = unionBBox(box, bboxOfPoints(pl.points));
  const move = (p: Vec): Vec => ({ x: p.x - box.minX, y: p.y - box.minY });
  subpaths = subpaths.map((sp) => ({
    start: move(sp.start),
    closed: sp.closed,
    segments: sp.segments.map((s): Segment => (s.kind === "line" ? { kind: "line", to: move(s.to) } : { kind: "cubic", c1: move(s.c1), c2: move(s.c2), to: move(s.to) })),
  }));
  return { geometry: { subpaths }, width: box.maxX - box.minX, height: box.maxY - box.minY, missing: [...missing], strokes: subpaths.length };
}
