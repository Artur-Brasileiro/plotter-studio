import type { Vec } from "../geometry/vec";
import type { GcodeLine, GcodeProgram } from "../job/gcode";

/**
 * Só para testes: um programa no formato de docs/REGRAS_GCODE.md escrito à mão, linha por linha, sem
 * passar pelo gerador (assim os testes do envio não dependem dele). Cada traço vira um bloco
 * G0 / M3 S220 / G4 / G1 F / pontos só com X e Y / M5 / G4 / M5 / G4.
 */
export interface RegrasOptions {
  /** ciclos de aquecimento do servo em (0,0) antes do 1º traço (regra 10); 0 = sem aquecimento */
  warmup?: number;
  /** F do "G1 F..." de cada bloco */
  feed?: number;
  /** índices de traços que ganham um checkpoint antes (regra 13) */
  checkpoints?: readonly number[];
  /** índice do traço → segundos de descanso (G4 com a caneta em cima) antes dele */
  rests?: Readonly<Record<number, number>>;
}

const c = (v: number) => v.toFixed(2);
const xy = (p: Vec) => `X${c(p.x)} Y${c(p.y)}`;

export function regrasLines(strokes: readonly (readonly Vec[])[], o: RegrasOptions = {}): GcodeLine[] {
  const feed = o.feed ?? 500;
  const out: GcodeLine[] = [];
  const push = (text: string, strokeIndex = -1, pointIndex?: number) => out.push({ text, strokeIndex, pointIndex });
  push("; Plotter Studio - teste - 2026-11-21 12:00");
  push(`; modo: fixo F${feed}`);
  for (const t of ["G21", "G90", "M5", "G4 P0.3"]) push(t);
  if (o.warmup) {
    for (const t of ["; aquecimento do servo no ponto seguro", "M5", "G4 P0.3", "G0 X0.00 Y0.00"]) push(t);
    for (let i = 0; i < o.warmup; i++) for (const t of ["M3 S220", "G4 P0.4", "M5", "G4 P0.4"]) push(t);
    push("G4 P1");
  }
  let checkpoint = 0;
  strokes.forEach((pts, si) => {
    const rest = o.rests?.[si];
    if (rest) {
      push("; descanso do servo");
      push(`G4 P${rest}`);
    }
    if (o.checkpoints?.includes(si)) {
      push(`; CHECKPOINT ${++checkpoint} (~${10 * checkpoint} min) re-sincroniza servo`);
      for (const t of ["M3 S220", "G4 P0.3", "M5", "G4 P0.3", "M3 S220", "G4 P0.3", "M5", "G4 P0.4"]) push(t);
    }
    push(`G0 ${xy(pts[0])}`);
    push("M3 S220", si, 0);
    push(si === 0 ? "G4 P0.6" : "G4 P0.3", si, 0);
    push(`G1 F${feed}`, si, 0);
    for (let j = 1; j < pts.length; j++) push(xy(pts[j]), si, j);
    for (const t of ["M5", "G4 P0.2", "M5", "G4 P0.2"]) push(t);
  });
  for (const t of ["M5", "G4 P0.3", "M5", "G4 P0.3", "G0 X0.00 Y0.00", "M2"]) push(t);
  return out;
}

export function regrasProgram(strokes: readonly (readonly Vec[])[], o: RegrasOptions = {}): GcodeProgram {
  const lines = regrasLines(strokes, o);
  return { lines, toText: () => lines.map((l) => l.text).join("\n") + "\n" };
}

/** Só para testes: programa a partir de textos soltos. */
export function programOf(texts: readonly string[]): GcodeProgram {
  const lines = texts.map((text) => ({ text, strokeIndex: -1 }));
  return { lines, toText: () => texts.join("\n") + "\n" };
}

/** O que a caneta riscou de fato: tira os "pontos" (descidas sem movimento: aquecimento e checkpoints). */
export function inked(penStrokes: readonly (readonly Vec[])[]): Vec[][] {
  return penStrokes.filter((s) => s.length > 1).map((s) => [...s]);
}

/** Descidas sem movimento (um ponto só): os ciclos de aquecimento e os toques dos checkpoints. */
export function taps(penStrokes: readonly (readonly Vec[])[]): Vec[] {
  return penStrokes.filter((s) => s.length === 1).map((s) => s[0]);
}
