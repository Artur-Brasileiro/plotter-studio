import type { Vec } from "../geometry/vec";
import type { MachineProfile } from "../machine";
import type { JobSettings } from "../store";
import { REGISTRATION_ID } from "./layers";
import { CHECKPOINT_DWELLS_S, FOOTER_SETTLE_S, HEADER_SETTLE_S, WARMUP_FINAL_S, WARMUP_SETTLE_S } from "./schedule";
import type { JobPlan } from "./types";

export interface GcodeMeta {
  readonly fileName: string;
  readonly date: Date;
  readonly job: JobSettings;
}

export interface GcodeOptions {
  /** Só esta parte (0, 1, 2...) do trabalho, com cabeçalho, aquecimento e rodapé próprios */
  readonly part?: number;
  /**
   * RETOMADA: continua desta descida (índice em `plan.descents`) até o fim, depois de uma parada no
   * meio. Como nos arquivos de retomada que já rodaram na máquina: aquecimento do servo, a cruz de
   * registro de novo (tem que cair em cima da que já está no papel) e então o desenho continua.
   * Ignora `part`.
   */
  readonly fromDescent?: number;
}

export interface GcodeLine {
  readonly text: string;
  /** −1 = cabeçalho, deslocamento, blindagem ou fim */
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
 * (o GRBL os ignora depois de ";", mas outros programas de envio podem não ignorar).
 * "!", "?" e "~" também saem: para o GRBL são comandos em tempo real (pausa, relatório, continuar)
 * até dentro de comentário, e um programa de envio que mande os comentários pausaria a máquina por
 * causa de um arquivo chamado "Olá!.svg". O resto fora de ASCII vira "_".
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
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[!?]/g, ".")
    .replace(/~/g, "-")
    .slice(0, 60);
}

/** Nenhuma linha passa disto: o buffer de linha do GRBL é de 80 caracteres (REGRAS_GCODE.md, regra 15). */
export const MAX_LINE_LENGTH = 69;

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtSeconds = (s: number) => String(Math.round(s * 1000) / 1000);

/**
 * JobPlan → G-code no formato de docs/REGRAS_GCODE.md (copiado de um arquivo blindado que já rodou
 * na máquina). Cada descida é um bloco:
 *
 *   G0 X.. Y..      vai até o início com a caneta EM CIMA
 *   M3 S220         desce
 *   G4 P0.3         espera o servo (0.6 na 1ª descida)
 *   G1 F500         modo traço
 *   X.. Y..         pontos (G1 modal; no modo dinâmico o F vai na própria linha)
 *   M5              sobe
 *   G4 P0.2         espera o servo
 *   M5 / G4 P0.2    subida dupla (blindagem)
 *
 * Com a blindagem ligada: aquecimento do servo no ponto seguro antes do 1º traço, checkpoints
 * que re-sincronizam o servo, e descansos (G4 com a caneta em cima) quando o servo passaria do limite.
 * Recusa plano com algo fora da área.
 */
export function generateGcode(plan: JobPlan, profile: MachineProfile, meta: GcodeMeta, opts: GcodeOptions = {}): GcodeProgram {
  if (plan.violations.length) throw new Error("Há desenho fora da área: corrija antes de gerar o G-code.");
  const { width: W, height: H } = profile.workArea;
  const { pen, shield } = profile;
  const lines: GcodeLine[] = [];
  const push = (text: string, strokeIndex = -1, pointIndex?: number) => lines.push({ text, strokeIndex, pointIndex });
  const xy = (p: Vec) => `X${formatCoord(Math.min(Math.max(p.x, 0), W))} Y${formatCoord(Math.min(Math.max(p.y, 0), H))}`;
  const dwell = (s: number) => `G4 P${fmtSeconds(s)}`;
  const up = toAsciiComment(pen.upCmd);
  const down = toAsciiComment(pen.downCmd);
  const dynamic = meta.job.speedMode === "dynamic";
  const parts = plan.stats.parts;
  const resume = opts.fromDescent !== undefined && plan.descents.length > 0;
  const from = resume ? Math.min(Math.max(Math.trunc(opts.fromDescent!), 0), plan.descents.length - 1) : 0;
  // na retomada, a 1ª cruz de registro é refeita antes de continuar
  const redoCross = resume && from > 0 && plan.strokes[plan.descents[0].first]?.drawingId === REGISTRATION_ID;
  const part = resume ? undefined : opts.part;
  const descents = resume ? [...(redoCross ? [plan.descents[0]] : []), ...plan.descents.slice(from)] : part === undefined ? plan.descents : plan.descents.filter((d) => d.part === part);
  /** Descidas, no começo do arquivo, que vêm logo depois do aquecimento: sem descanso nem checkpoint */
  const lead = redoCross ? 2 : 1;

  const lift = () => {
    const n = shield.enabled && shield.doubleLift ? 2 : 1;
    for (let i = 0; i < n; i++) {
      push(up);
      push(dwell(pen.settleUpSeconds));
    }
  };

  // ------------------------------------------------------------ cabeçalho
  const mode = dynamic
    ? `dinamico - reta F${profile.feed.straight} / curva F${profile.feed.curve} / fechada F${profile.feed.tightCurve}`
    : `fixo F${meta.job.fixedFeed}`;
  if (resume) {
    const at = plan.strokes[plan.descents[from].first]?.points[0];
    push(`; RETOMADA: continua da descida ${from + 1} de ${plan.descents.length}`);
    push(`; 1o: aquecimento do servo${redoCross ? "; 2o: cruz EM CIMA da ja feita" : ""}`);
    if (at) push(`; ${redoCross ? "3o" : "2o"}: continua do traco que comeca em ${xy(at)}`);
  }
  push(`; Plotter Studio - ${toAsciiComment(meta.fileName).slice(0, 28)} - ${fmtDate(meta.date)}`);
  push(`; modo: ${mode}`);
  const layer = plan.layer;
  if (layer) {
    const which = layer.count > 1 ? `camada ${layer.index + 1} de ${layer.count} - ` : "";
    push(`; ${which}caneta ${toAsciiComment(layer.penName).slice(0, 24)} - ${fmtSeconds(layer.penWidthMm)} mm`);
    if (layer.count > 1 && layer.index > 0) push("; rodar DEPOIS da camada anterior, sem mexer no papel");
    const off = [layer.offset.x ? `${formatCoord(-layer.offset.x)} mm em X` : "", layer.offset.y ? `${formatCoord(-layer.offset.y)} mm em Y` : ""].filter(Boolean);
    if (off.length) push(`; ponta corrigida: camada deslocada ${off.join(" e ")}`);
    if (layer.registration) {
      const r = profile.registration;
      const at = (x: number) => `X${fmtSeconds(x - layer.offset.x)} Y${fmtSeconds(r.y - layer.offset.y)}`;
      push(`; 1o traco: cruz em ${at(r.x1)} - ultimo: cruz em ${at(r.x2)}`);
    }
  }
  if (part !== undefined) push(`; parte ${part + 1} de ${parts}`);
  push("G21");
  push("G90");
  push(up);
  push(dwell(HEADER_SETTLE_S));
  if (shield.enabled && shield.warmupCycles > 0) {
    push("; aquecimento do servo no ponto seguro");
    push(up);
    push(dwell(HEADER_SETTLE_S));
    push(`G0 ${xy({ x: shield.safeX, y: shield.safeY })}`);
    for (let i = 0; i < shield.warmupCycles; i++) {
      push(down);
      push(dwell(WARMUP_SETTLE_S));
      push(up);
      push(dwell(WARMUP_SETTLE_S));
    }
    push(dwell(WARMUP_FINAL_S));
  }

  // ------------------------------------------------------------ descidas
  descents.forEach((d, di) => {
    // numa parte avulsa, a 1ª descida vem logo depois do aquecimento: sem descanso nem checkpoint
    const firstOfFile = di === 0;
    const afterWarmup = di < lead && (part !== undefined || resume);
    if (!afterWarmup) {
      if (d.waitS > 0.05) {
        push("; descanso do servo");
        push(dwell(Math.round(d.waitS * 10) / 10));
      }
      if (d.checkpoint !== undefined) {
        push(`; CHECKPOINT ${d.checkpoint} (~${d.checkpointMin ?? 0} min) re-sincroniza servo`);
        CHECKPOINT_DWELLS_S.forEach((s, i) => {
          push(i % 2 === 0 ? down : up);
          push(dwell(s));
        });
      }
    }
    const s0 = plan.strokes[d.first];
    // o G0 sai sempre: o arquivo pode ser rodado com a máquina em qualquer lugar, e num corte
    // de descida longa ele repete o ponto atual (mantém todo bloco com a mesma forma)
    const startPoint = d.relift && d.first > 0 ? lastPointBefore(plan, d.first) : s0.points[0];
    let pos = xy(startPoint);
    if (s0.drawingId === REGISTRATION_ID) push("; cruz de registro em ida e volta");
    push(`G0 ${pos}`);
    push(down, d.first, 0);
    push(dwell(firstOfFile && shield.enabled ? shield.firstSettleSeconds : pen.settleSeconds), d.first, 0);

    let lastF = dynamic ? (s0.feeds[0] ?? profile.feed.straight) : meta.job.fixedFeed;
    push(`G1 F${lastF}`, d.first, 0);
    const move = (p: Vec, f: number, si: number, pi: number) => {
      const t = xy(p);
      if (t === pos) return; // repetido depois de arredondar
      const feed = dynamic && f !== lastF ? ` F${f}` : "";
      if (feed) lastF = f;
      push(`${t}${feed}`, si, pi);
      pos = t;
    };
    for (let si = d.first; si <= d.last; si++) {
      const s = plan.strokes[si];
      const pts = s.points;
      if (pts.length === 0) continue;
      // ligação da emenda: desenhada, com a caneta embaixo
      move(pts[0], s.feeds[0] ?? lastF, si, 0);
      for (let j = 1; j < pts.length; j++) move(pts[j], s.feeds[j - 1], si, j);
    }
    lift();
  });

  // ------------------------------------------------------------ rodapé
  if (shield.enabled) {
    for (let i = 0; i < 2; i++) {
      push(up);
      push(dwell(FOOTER_SETTLE_S));
    }
  }
  push(`G0 ${xy(plan.end)}`);
  push("M2");
  return { lines, toText: () => lines.map((l) => l.text).join("\n") + "\n" };
}

/** Onde a caneta parou antes do traço `index` (para re-descer no mesmo ponto). */
function lastPointBefore(plan: JobPlan, index: number): Vec {
  for (let i = index - 1; i >= 0; i--) {
    const pts = plan.strokes[i].points;
    if (pts.length) return pts[pts.length - 1];
  }
  return plan.strokes[index].points[0];
}
