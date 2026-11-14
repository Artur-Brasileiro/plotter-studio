import { quadToCubic, type Segment, type SubPath } from "../geometry/path";
import { nearlyEqual, type Vec } from "../geometry/vec";
import { arcToCubics } from "./arc";
import { NUMBER_RE } from "./node";

const ARG_COUNT: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * Atributo `d` do <path> → subpaths (em unidades de usuário). Arcos e quádricas já
 * saem como cúbicas. No primeiro erro, para e devolve o que leu até ali, como o
 * navegador faz, junto com a mensagem de erro.
 */
export function parsePathData(d: string): { subpaths: SubPath[]; error?: string } {
  const subpaths: SubPath[] = [];
  let i = 0;
  const n = d.length;

  let cur: Vec = { x: 0, y: 0 };
  let start: Vec = { x: 0, y: 0 };
  let segments: Segment[] | null = null; // null = sem subpath aberto
  let lastCubicC2: Vec | null = null;
  let lastQuadQ: Vec | null = null;
  let cmd = "";

  const skipSep = () => {
    while (i < n) {
      const ch = d.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 44) i++;
      else break;
    }
  };
  const readNumber = (): number | undefined => {
    skipSep();
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(d);
    if (!m) return undefined;
    i = NUMBER_RE.lastIndex;
    return Number(m[0]);
  };
  const readFlag = (): boolean | undefined => {
    skipSep();
    const ch = d[i];
    if (ch === "0" || ch === "1") {
      i++;
      return ch === "1";
    }
    return undefined;
  };
  const finishSubpath = (closed: boolean) => {
    if (segments && segments.length > 0) subpaths.push({ start, segments, closed });
    segments = null;
  };
  const ensureOpen = () => {
    if (!segments) {
      start = cur;
      segments = [];
    }
  };
  const push = (s: Segment) => {
    ensureOpen();
    segments!.push(s);
    cur = s.to;
  };
  const fail = (msg: string) => {
    finishSubpath(false);
    return { subpaths, error: msg };
  };

  skipSep();
  while (i < n) {
    const ch = d[i];
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toLowerCase() in ARG_COUNT)) return fail(`comando desconhecido "${ch}"`);
      cmd = ch;
      i++;
    } else if (!cmd) {
      return fail("o caminho não começa com M");
    } else if (cmd === "z" || cmd === "Z") {
      return fail("número depois de Z sem comando");
    }
    // depois de M/m, pares extras viram L/l
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;

    if (lower === "z") {
      if (segments) {
        const segs: Segment[] = segments;
        if (!nearlyEqual(cur, start, 1e-9)) segs.push({ kind: "line", to: start });
        else if (segs.length > 0) {
          const last = segs[segs.length - 1];
          segs[segs.length - 1] = { ...last, to: start };
        }
        finishSubpath(true);
      }
      cur = start;
      lastCubicC2 = lastQuadQ = null;
      skipSep();
      continue;
    }

    const nums: number[] = [];
    const argc = ARG_COUNT[lower];
    for (let k = 0; k < argc; k++) {
      if (lower === "a" && (k === 3 || k === 4)) {
        const f = readFlag();
        if (f === undefined) return fail("flag de arco inválida");
        nums.push(f ? 1 : 0);
      } else {
        const v = readNumber();
        if (v === undefined) return fail(`faltam números para "${cmd}"`);
        nums.push(v);
      }
    }
    const ox = rel ? cur.x : 0;
    const oy = rel ? cur.y : 0;

    switch (lower) {
      case "m": {
        finishSubpath(false);
        cur = { x: ox + nums[0], y: oy + nums[1] };
        start = cur;
        segments = [];
        cmd = rel ? "l" : "L";
        lastCubicC2 = lastQuadQ = null;
        break;
      }
      case "l":
        push({ kind: "line", to: { x: ox + nums[0], y: oy + nums[1] } });
        lastCubicC2 = lastQuadQ = null;
        break;
      case "h":
        push({ kind: "line", to: { x: ox + nums[0], y: cur.y } });
        lastCubicC2 = lastQuadQ = null;
        break;
      case "v":
        push({ kind: "line", to: { x: cur.x, y: oy + nums[0] } });
        lastCubicC2 = lastQuadQ = null;
        break;
      case "c": {
        const c1 = { x: ox + nums[0], y: oy + nums[1] };
        const c2 = { x: ox + nums[2], y: oy + nums[3] };
        push({ kind: "cubic", c1, c2, to: { x: ox + nums[4], y: oy + nums[5] } });
        lastCubicC2 = c2;
        lastQuadQ = null;
        break;
      }
      case "s": {
        const c1 = lastCubicC2 ? { x: 2 * cur.x - lastCubicC2.x, y: 2 * cur.y - lastCubicC2.y } : cur;
        const c2 = { x: ox + nums[0], y: oy + nums[1] };
        push({ kind: "cubic", c1, c2, to: { x: ox + nums[2], y: oy + nums[3] } });
        lastCubicC2 = c2;
        lastQuadQ = null;
        break;
      }
      case "q": {
        const q = { x: ox + nums[0], y: oy + nums[1] };
        push(quadToCubic(cur, q, { x: ox + nums[2], y: oy + nums[3] }));
        lastQuadQ = q;
        lastCubicC2 = null;
        break;
      }
      case "t": {
        const q: Vec = lastQuadQ ? { x: 2 * cur.x - lastQuadQ.x, y: 2 * cur.y - lastQuadQ.y } : cur;
        push(quadToCubic(cur, q, { x: ox + nums[0], y: oy + nums[1] }));
        lastQuadQ = q;
        lastCubicC2 = null;
        break;
      }
      case "a": {
        const to = { x: ox + nums[5], y: oy + nums[6] };
        const segs = arcToCubics(cur, nums[0], nums[1], nums[2], nums[3] === 1, nums[4] === 1, to);
        ensureOpen();
        for (const s of segs) segments!.push(s);
        cur = to;
        lastCubicC2 = lastQuadQ = null;
        break;
      }
    }
    skipSep();
  }
  finishSubpath(false);
  return { subpaths };
}
