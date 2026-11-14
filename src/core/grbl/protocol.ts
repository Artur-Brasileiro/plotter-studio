import type { Vec } from "../geometry/vec";

/**
 * Comandos de tempo real do GRBL 1.1: um byte só, sem "\n", furam a fila e não contam no buffer.
 * NUNCA 0x99–0x9D (overrides de spindle): eles mudam o S, ou seja, a posição do servo da caneta.
 */
export const RT = {
  STATUS: 0x3f, // ?
  HOLD: 0x21, // !
  RESUME: 0x7e, // ~
  RESET: 0x18, // Ctrl-X
  JOG_CANCEL: 0x85,
  FEED_RESET: 0x90,
  FEED_PLUS_10: 0x91,
  FEED_MINUS_10: 0x92,
  FEED_PLUS_1: 0x93,
  FEED_MINUS_1: 0x94,
  SPINDLE_STOP: 0x9e, // só em Hold: levanta/abaixa a caneta
} as const;

export const FEED_OVERRIDE_BYTES: readonly number[] = [RT.FEED_RESET, RT.FEED_PLUS_10, RT.FEED_MINUS_10, RT.FEED_PLUS_1, RT.FEED_MINUS_1];

export type MachineState = "Idle" | "Run" | "Hold" | "Jog" | "Alarm" | "Door" | "Check" | "Home" | "Sleep";
const STATES: readonly string[] = ["Idle", "Run", "Hold", "Jog", "Alarm", "Door", "Check", "Home", "Sleep"];

export interface StatusReport {
  readonly state: MachineState;
  /** Hold:0 = parou de vez; Hold:1 = desacelerando */
  readonly subState?: number;
  readonly mpos?: Vec;
  readonly wpos?: Vec;
  readonly wco?: Vec;
  /** mm/min */
  readonly feed?: number;
  /** S atual: > 0 = caneta embaixo (M3), 0 = em cima */
  readonly spindle?: number;
  /** "" se ausente; "XY" = fins de curso acionados */
  readonly pins: string;
  readonly overrides?: { readonly feed: number; readonly rapid: number; readonly spindle: number };
  /** Bf: blocos livres no planejador e bytes livres no buffer de recepção (se $10 pedir) */
  readonly buffer?: { readonly blocks: number; readonly bytes: number };
}

export type GrblMessage =
  | { type: "ok" }
  | { type: "error"; code: number }
  | { type: "alarm"; code: number }
  | { type: "status"; report: StatusReport }
  | { type: "banner"; version: string } // "Grbl 1.1h ['$' for help]"
  | { type: "msg"; text: string } // [MSG:...]
  | { type: "feedback"; tag: string; body: string } // [GC:...] [G54:...] [VER:...] [echo:...]
  | { type: "setting"; id: number; value: string } // $100=80.000
  | { type: "unknown"; line: string };

function parseVec(s: string): Vec | undefined {
  const [x, y] = s.split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function parseStatus(body: string): StatusReport | undefined {
  const fields = body.split("|");
  const [name, sub] = fields[0].split(":");
  if (!STATES.includes(name)) return undefined;
  const r: { -readonly [K in keyof StatusReport]: StatusReport[K] } = { state: name as MachineState, pins: "" };
  if (sub !== undefined && sub !== "") r.subState = Number(sub);
  for (const f of fields.slice(1)) {
    const i = f.indexOf(":");
    if (i < 0) continue;
    const key = f.slice(0, i);
    const val = f.slice(i + 1);
    if (key === "MPos") r.mpos = parseVec(val);
    else if (key === "WPos") r.wpos = parseVec(val);
    else if (key === "WCO") r.wco = parseVec(val);
    else if (key === "FS") {
      const [feed, spindle] = val.split(",").map(Number);
      r.feed = feed;
      r.spindle = spindle;
    } else if (key === "F") r.feed = Number(val);
    else if (key === "Pn") r.pins = val;
    else if (key === "Ov") {
      const [feed, rapid, spindle] = val.split(",").map(Number);
      r.overrides = { feed, rapid, spindle };
    } else if (key === "Bf") {
      const [blocks, bytes] = val.split(",").map(Number);
      r.buffer = { blocks, bytes };
    }
  }
  return r;
}

/** Uma linha recebida do GRBL (sem o "\r\n") → mensagem tipada. */
export function parseLine(line: string): GrblMessage {
  const s = line.trim();
  if (s === "ok") return { type: "ok" };
  let m = /^error:(\d+)$/.exec(s);
  if (m) return { type: "error", code: Number(m[1]) };
  m = /^ALARM:(\d+)$/.exec(s);
  if (m) return { type: "alarm", code: Number(m[1]) };
  if (s.startsWith("<") && s.endsWith(">")) {
    const report = parseStatus(s.slice(1, -1));
    return report ? { type: "status", report } : { type: "unknown", line: s };
  }
  m = /^Grbl (\S+)/.exec(s);
  if (m) return { type: "banner", version: m[1] };
  m = /^\[MSG:(.*)\]$/.exec(s);
  if (m) return { type: "msg", text: m[1] };
  m = /^\[([A-Za-z0-9.]+):(.*)\]$/.exec(s);
  if (m) return { type: "feedback", tag: m[1], body: m[2] };
  m = /^\$(\d+)=(.*)$/.exec(s);
  if (m) return { type: "setting", id: Number(m[1]), value: m[2].trim() };
  return { type: "unknown", line: s };
}

/** Junta os pedaços que chegam da serial e devolve as linhas completas (sem "\r"). */
export class LineSplitter {
  private rest = "";

  push(chunk: Uint8Array): string[] {
    // o GRBL só manda ASCII: um byte = um caractere
    let s = "";
    for (let i = 0; i < chunk.length; i++) s += String.fromCharCode(chunk[i]);
    this.rest += s;
    const parts = this.rest.split("\n");
    this.rest = parts.pop() ?? "";
    return parts.map((p) => p.replace(/\r/g, "")).filter((p) => p.length > 0);
  }

  reset(): void {
    this.rest = "";
  }
}

/** WPos = MPos − WCO (guardar o último WCO recebido: ele não vem em todo relatório). */
export function workPosition(r: StatusReport, lastWco: Vec | undefined): Vec | undefined {
  if (r.wpos) return r.wpos;
  const wco = r.wco ?? lastWco;
  if (!r.mpos || !wco) return undefined;
  return { x: r.mpos.x - wco.x, y: r.mpos.y - wco.y };
}

/** "Hold:0", "Idle"... como o GRBL escreve. */
export function stateLabel(r: Pick<StatusReport, "state" | "subState">): string {
  return r.subState === undefined ? r.state : `${r.state}:${r.subState}`;
}

/** Texto ASCII → bytes (o chamador garante que é ASCII). */
export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
