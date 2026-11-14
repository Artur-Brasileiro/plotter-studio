import type { Vec } from "../geometry/vec";
import type { MachineProfile } from "../machine";
import type { JobSettings } from "../store";
import type { JobPlan } from "./types";

export interface GcodeMeta {
  readonly fileName: string;
  readonly date: Date;
  readonly job: JobSettings;
}

export interface GcodeLine {
  readonly text: string;
  /** −1 = cabeçalho, deslocamento ou fim */
  readonly strokeIndex: number;
  /** Ponto do traço que esta linha alcança */
  readonly pointIndex?: number;
}

export interface GcodeProgram {
  readonly lines: readonly GcodeLine[];
  /** Texto do arquivo, com "\n" no fim de cada linha */
  toText(): string;
}

/** 2 casas decimais, nunca "-0.00". */
export function formatCoord(v: number): string {
  const r = Math.round(v * 100) / 100;
  return (Math.abs(r) < 0.005 ? 0 : r).toFixed(2);
}

/**
 * Texto seguro para comentário de G-code: o GRBL trata todo byte acima de 0x7F como
 * comando em tempo real (ex.: o "—" em UTF-8 termina em 0x94 = velocidade −1%).
 * Remove acentos; travessão vira "-"; aspas curvas viram retas; parênteses viram colchetes
 * (o GRBL os ignora depois de ";", mas outros programas de envio podem não ignorar);
 * o resto fora de ASCII vira "?".
 */
export function toAsciiComment(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‒-―−]/g, "-")
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/…/g, "...")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\(/g, "[")
    .replace(/\)/g, "]")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 60);
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtSeconds = (s: number) => String(Math.round(s * 1000) / 1000);

/**
 * JobPlan → G-code no formato do SPEC: G21/G90/G17, caneta com M3 S220 / M5 + G4,
 * deslocamentos com G0, desenho com G1 e F só quando muda. Recusa plano com algo fora da área.
 */
export function generateGcode(plan: JobPlan, profile: MachineProfile, meta: GcodeMeta): GcodeProgram {
  if (plan.violations.length) throw new Error("Há desenho fora da área: corrija antes de gerar o G-code.");
  const { width: W, height: H } = profile.workArea;
  const lines: GcodeLine[] = [];
  const push = (text: string, strokeIndex = -1, pointIndex?: number) => lines.push({ text, strokeIndex, pointIndex });
  const xy = (p: Vec) => `X${formatCoord(Math.min(Math.max(p.x, 0), W))} Y${formatCoord(Math.min(Math.max(p.y, 0), H))}`;
  const dwell = `G4 P${fmtSeconds(profile.pen.settleSeconds)}`;
  const up = toAsciiComment(profile.pen.upCmd);
  const down = toAsciiComment(profile.pen.downCmd);

  const mode =
    meta.job.speedMode === "dynamic"
      ? `dinamico - reta F${profile.feed.straight} / curva F${profile.feed.curve} / fechada F${profile.feed.tightCurve}`
      : `fixo F${meta.job.fixedFeed}`;
  push(`; Plotter Studio - ${toAsciiComment(meta.fileName)} - ${fmtDate(meta.date)}`);
  push(`; modo: ${mode}`);
  push("G21");
  push("G90");
  push("G17");
  push(up);
  push(dwell);

  // Posição atual, já formatada. Começa DESCONHECIDA: o arquivo pode ser rodado com a máquina em
  // qualquer lugar (ex.: logo depois do Home, em 810/385), então o primeiro G0 nunca pode ser omitido.
  let pos: string | undefined;
  let lastF: number | undefined;
  let penDown = false;

  const g1 = (p: Vec, f: number, si: number, pi: number) => {
    const t = xy(p);
    if (t === pos) return; // repetido depois de arredondar
    push(`G1 ${t}${f !== lastF ? ` F${f}` : ""}`, si, pi);
    lastF = f;
    pos = t;
  };
  const g0 = (p: Vec) => {
    const t = xy(p);
    if (t !== pos) push(`G0 ${t}`);
    pos = t;
  };

  plan.strokes.forEach((s, si) => {
    const pts = s.points;
    if (pts.length === 0) return;
    if (!s.joinedToPrevious || !penDown) {
      if (penDown) {
        push(up);
        push(dwell);
      }
      g0(pts[0]);
      push(down, si, 0);
      push(dwell, si, 0);
      penDown = true;
    } else {
      g1(pts[0], s.feeds[0] ?? lastF ?? profile.feed.straight, si, 0);
    }
    for (let j = 1; j < pts.length; j++) g1(pts[j], s.feeds[j - 1], si, j);
  });

  if (penDown) {
    push(up);
    push(dwell);
  }
  g0(plan.end);
  return { lines, toText: () => lines.map((l) => l.text).join("\n") + "\n" };
}
