import type { BBox } from "../geometry/path";
import type { Vec } from "../geometry/vec";
import { formatCoord } from "../job/gcode";
import type { MachineProfile } from "../machine";

type Area = { readonly width: number; readonly height: number };

const xy = (p: Vec) => `X${formatCoord(p.x)} Y${formatCoord(p.y)}`;
const fmtF = (feed: number) => `F${Math.max(1, Math.round(feed))}`;

/** "$J=G91 G21 X10.00 Y0.00 F3000" (relativo; não altera o modo G90/G91 do programa) */
export function jogRelative(d: Vec, feed: number): string {
  return `$J=G91 G21 ${xy(d)} ${fmtF(feed)}`;
}

/** "$J=G90 G21 X0.00 Y0.00 F6000" (absoluto, em coordenadas de trabalho) */
export function jogTo(p: Vec, feed: number): string {
  return `$J=G90 G21 ${xy(p)} ${fmtF(feed)}`;
}

export function clampToArea(p: Vec, area: Area, marginMm = 0): Vec {
  const m = Math.min(marginMm, area.width / 2, area.height / 2);
  return { x: Math.min(Math.max(p.x, m), area.width - m), y: Math.min(Math.max(p.y, m), area.height - m) };
}

/**
 * Destino de um passo de jog a partir de `base`, sem sair da área (com margem, para não dar error:15
 * por arredondamento). Um eixo nunca anda para trás: em X = 810 com margem 0,5, "+1 mm em X" fica parado
 * em vez de recuar para 809,5.
 */
export function stepTarget(base: Vec, d: Vec, area: Area, marginMm = 0.5): Vec {
  const axis = (b: number, dv: number, max: number) => {
    if (dv > 0) return Math.max(b, Math.min(b + dv, max - marginMm));
    if (dv < 0) return Math.min(b, Math.max(b + dv, marginMm));
    return b;
  };
  return { x: axis(base.x, d.x, area.width), y: axis(base.y, d.y, area.height) };
}

/** Jog contínuo: o ponto da borda da área (com margem) na direção `dir`, saindo de `base`. */
export function edgeTarget(base: Vec, dir: Vec, area: Area, marginMm = 0.5): Vec {
  const len = Math.hypot(dir.x, dir.y);
  if (len === 0) return base;
  const u = { x: dir.x / len, y: dir.y / len };
  let t = Infinity;
  if (u.x > 0) t = Math.min(t, (area.width - marginMm - base.x) / u.x);
  if (u.x < 0) t = Math.min(t, (marginMm - base.x) / u.x);
  if (u.y > 0) t = Math.min(t, (area.height - marginMm - base.y) / u.y);
  if (u.y < 0) t = Math.min(t, (marginMm - base.y) / u.y);
  t = Math.max(0, t);
  return { x: base.x + u.x * t, y: base.y + u.y * t };
}

/**
 * Contorno: percorre o retângulo que envolve o desenho com a caneta levantada (G0 nos 4 cantos e volta
 * ao primeiro), para conferir a posição no papel antes de desenhar.
 */
export function frameProgram(bbox: BBox, profile: MachineProfile): string[] {
  const area = profile.workArea;
  const a = clampToArea({ x: bbox.minX, y: bbox.minY }, area);
  const b = clampToArea({ x: bbox.maxX, y: bbox.maxY }, area);
  const corners: Vec[] = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
  return [
    profile.pen.upCmd,
    `G4 P${profile.pen.settleSeconds}`,
    "G21",
    "G90",
    ...corners.map((p) => `G0 ${xy(p)}`),
  ];
}

export type ManualCommandCheck = { kind: "ok" } | { kind: "confirm"; reason: string } | { kind: "blocked"; reason: string };

const EEPROM = "Isto grava na EEPROM do GRBL (configuração permanente da placa).";

/**
 * Comando digitado no console: bloqueia o que estraga a máquina e pede confirmação para o que grava
 * na EEPROM (regra do CLAUDE.md).
 */
export function classifyManualCommand(line: string): ManualCommandCheck {
  const s = line.trim();
  if (/[^\x20-\x7e]/.test(s)) {
    return { kind: "blocked", reason: "Tem caractere fora de ASCII (acento, travessão...): o GRBL interpretaria esses bytes como comandos em tempo real." };
  }
  const u = s.toUpperCase().replace(/\s+/g, "");
  const m32 = /^\$32=(.*)$/.exec(u);
  if (m32) {
    if (Number(m32[1]) !== 0) return { kind: "blocked", reason: "$32=1 liga o modo laser, e com ele o servo da caneta para de funcionar." };
    return { kind: "confirm", reason: EEPROM };
  }
  if (/^\$\d+=/.test(u)) return { kind: "confirm", reason: `${EEPROM} Anote o valor antigo (veja com $$) antes de mudar.` };
  if (/^\$RST=/.test(u)) return { kind: "confirm", reason: "Isto apaga configurações da EEPROM do GRBL (volta aos padrões de fábrica: área, velocidades, G54...)." };
  if (/^\$N\d*=/.test(u)) return { kind: "confirm", reason: "Isto grava uma linha de inicialização na EEPROM (ela roda a cada Home)." };
  if (/^\$I=/.test(u)) return { kind: "confirm", reason: EEPROM };
  if (!u.startsWith("$")) {
    const code = u.replace(/\([^)]*\)/g, "").replace(/;.*$/, "");
    if (/G0*10(?![\d.])/.test(code)) return { kind: "confirm", reason: "G10 grava a origem de trabalho (G54) na EEPROM. Errar aqui desloca todos os desenhos." };
    if (/G28\.1|G30\.1/.test(code)) return { kind: "confirm", reason: "G28.1/G30.1 gravam posições na EEPROM." };
  }
  return { kind: "ok" };
}

/**
 * Compara o que o GRBL tem ($$ e $#) com o perfil. Só avisa: nada é corrigido automaticamente.
 */
export function compareSettings(settings: ReadonlyMap<number, string>, g54: Vec | undefined, profile: MachineProfile): string[] {
  const w: string[] = [];
  if (settings.size === 0) return ["Não consegui ler a configuração do GRBL ($$)."];
  const num = (id: number) => {
    const v = settings.get(id);
    return v === undefined ? undefined : Number(v);
  };
  const check = (id: number, expected: number, tol: number, what: string, unit: string) => {
    const v = num(id);
    if (v === undefined) w.push(`$${id} (${what}) não veio no $$.`);
    else if (Math.abs(v - expected) > tol) w.push(`$${id} (${what}) = ${v} ${unit}, mas o perfil diz ${expected} ${unit}.`);
  };
  const { workArea, motion } = profile;
  check(130, workArea.width, 0.01, "curso X", "mm");
  check(131, workArea.height, 0.01, "curso Y", "mm");
  check(110, motion.maxRateMmMin, 0.5, "velocidade máx. X", "mm/min");
  check(111, motion.maxRateMmMin, 0.5, "velocidade máx. Y", "mm/min");
  check(120, motion.accelMmS2, 0.5, "aceleração X", "mm/s²");
  check(121, motion.accelMmS2, 0.5, "aceleração Y", "mm/s²");
  check(11, motion.junctionDeviationMm, 0.0005, "junction deviation", "mm");
  const laser = num(32);
  if (laser !== undefined && laser !== 0) w.push("$32 = 1 (modo laser): com ele o servo da caneta não funciona. Corrija para $32=0.");
  const soft = num(20);
  if (soft !== undefined && soft !== 1) w.push("$20 = 0: soft limits desligados. Um desenho fora da área bateria no fim do curso.");
  const homing = num(22);
  if (homing !== undefined && homing !== 1) w.push("$22 = 0: homing desligado. O Plotter Studio exige Home antes de desenhar.");
  const ex = { x: -workArea.width, y: -workArea.height };
  if (!g54) w.push("Não consegui ler a origem de trabalho G54 ($#).");
  else if (Math.abs(g54.x - ex.x) > 0.01 || Math.abs(g54.y - ex.y) > 0.01) {
    w.push(`G54 = (${g54.x}, ${g54.y}), mas o esperado é (${ex.x}, ${ex.y}). Os desenhos sairiam deslocados.`);
  }
  return w;
}
