// Paridade de fitPolyline / pathLength / flattenSubPath com a referência em Python
// (lab/python/vec.py: fit_polyline, path_length, path_flatten).
// Os dados vêm de lab/python/fixtures_strokes.py, que roda a referência de verdade.
import { afterAll, describe, expect, it } from "vitest";
import type { SubPath } from "../geometry/path";
import rawFit from "./__fixtures__/strokes/fit_polyline.json?raw";
import rawStrokes from "./__fixtures__/strokes/skeleton_strokes.json?raw";
import { fitPolyline, flattenSubPath, mathHypot, pairwiseSum, pathLength, type FitOptions } from "./fit";

interface FitResult {
  closed: boolean;
  /** Um caractere por segmento: L = reta, C = cúbica. */
  kinds: string;
  /** start; depois, por segmento, `to` (reta) ou `c1, c2, to` (cúbica). f8, base64. */
  ctrl: string;
  /** `path_length` do Python. */
  length: number;
  /** `path_flatten(path, flatStep)` do Python, quando gravado. */
  flatStep?: number;
  flat?: string;
  /**
   * Só aparece quando o resultado do Python depende da ordem em que o np.argsort devolve cantos
   * candidatos com a mesma nota (ele não é estável). É o resultado com ordenação estável, que é a
   * regra do TypeScript.
   */
  stableSort?: FitResult;
}

interface FitCase {
  name: string;
  closed: boolean;
  /** Pontos da polilinha (f8, base64)... */
  points?: string;
  /** ...ou [cena, polilinha] da 1ª rodada de skeleton_strokes.json. */
  ref?: [number, number];
  results: Record<string, FitResult | null>;
}

const fixtures = JSON.parse(rawFit) as { optionSets: Record<string, FitOptions>; cases: FitCase[] };
const scenes = (JSON.parse(rawStrokes) as { scenes: { runs: { counts: number[]; points: string }[] }[] }).scenes;

/** Diferença máxima aceita nos pontos de controle, em px. */
const TOL = 1e-6;

/**
 * Ajustes em que o TypeScript NÃO reproduz o Python, e por quê. São formas simétricas: dois (ou três)
 * candidatos empatam, e quem ganha é decidido pelo último bit de uma conta que as duas bibliotecas de
 * matemática arredondam diferente (o resultado do Python muda do mesmo jeito se a entrada mexer 1e-12 px).
 * O teste exige que cada caso da lista seja mesmo um empate desses: com a entrada perturbada em
 * 1e-12 px o TypeScript tem de reproduzir o Python dentro de TOL. Caso novo fora da lista = falha.
 */
const NOISE_TIES: Record<string, string> = {
  // Três vértices do zigue-zague a 2,297 px um do outro (menos que cL = 2,4): só fica o de maior nota.
  // Notas −(a1+a2): Python 24 e 36 = −3.3031011744197616, 48 = −3.303101174419762 → cantos [24, 48];
  // TypeScript 24 = −3.3031011744197616, 36 e 48 = −3.303101174419762 → cantos [13, 36, 59].
  // A nota do 36 muda 1 ulp porque Math.atan2 (V8) e atan2 (libc do Python) arredondam diferente.
  "syn_zigzag_close / traceBold": "empate entre cantos candidatos; último bit do atan2",
  // Traço com simetria de espelho: o erro do ajuste nos dois pontos espelhados é igual até o 13º dígito.
  // Python e[13] = 0.033978286813059616 > e[43] = 0.03397828681305836 → divide no 13;
  // TypeScript e[13] = 0.033978286813059616 < e[43] = 0.03397828681306106 → divide no 43.
  // A diferença vem das tangentes das pontas (mínimos quadrados: SVD do LAPACK lá, Gram-Schmidt aqui).
  "busy_k4_p1 / traceBold": "empate no ponto de maior erro (Schneider); último bit das tangentes das pontas",
};

function f64(b64: string): Float64Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Float64Array(out.buffer);
}

const sceneCache = new Map<number, Float64Array>();

function casePoints(c: FitCase): Float64Array {
  if (c.points !== undefined) return f64(c.points);
  const [si, pi] = c.ref!;
  const run = scenes[si].runs[0];
  let all = sceneCache.get(si);
  if (!all) sceneCache.set(si, (all = f64(run.points)));
  let start = 0;
  for (let i = 0; i < pi; i++) start += run.counts[i];
  return all.slice(2 * start, 2 * (start + run.counts[pi]));
}

/** SubPath na forma gravada pelo gerador. */
function encode(sp: SubPath): { kinds: string; ctrl: number[] } {
  const ctrl = [sp.start.x, sp.start.y];
  let kinds = "";
  for (const s of sp.segments) {
    if (s.kind === "line") {
      kinds += "L";
    } else {
      kinds += "C";
      ctrl.push(s.c1.x, s.c1.y, s.c2.x, s.c2.y);
    }
    ctrl.push(s.to.x, s.to.y);
  }
  return { kinds, ctrl };
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!(d <= m)) m = d;
  }
  return m;
}

/** Compara com o Python. `problem` diz a primeira coisa que não bate (undefined = tudo certo). */
function compare(sp: SubPath | undefined, want: FitResult): { problem?: string; diff: number } {
  if (!sp) return { problem: "undefined, mas o Python devolve um caminho", diff: Infinity };
  if (sp.closed !== want.closed) return { problem: `closed = ${sp.closed}`, diff: Infinity };
  const enc = encode(sp);
  if (enc.kinds !== want.kinds) return { problem: `segmentos ${enc.kinds}, o Python dá ${want.kinds}`, diff: Infinity };
  const diff = maxAbsDiff(enc.ctrl, f64(want.ctrl));
  if (!(diff <= TOL)) return { problem: `pontos de controle diferem em ${diff.toExponential(2)} px`, diff };
  return { diff };
}

/** A mesma polilinha com cada coordenada mexida em até 1e-12 px (relativo acima de 1). */
function perturbed(points: Float64Array, seed: number): Float64Array {
  let s = seed >>> 0;
  return points.map((v) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return v + (s / 4294967296 - 0.5) * 2e-12 * Math.max(1, Math.abs(v));
  });
}

describe("fitPolyline: paridade com o Python", () => {
  const seen = { cases: 0, fits: 0, none: 0, segments: 0, lines: 0, maxDiff: 0, maxLen: 0, flats: 0, maxFlat: 0, exact: 0 };
  const stableSortCases: string[] = [];
  const noiseCases: string[] = [];

  for (const c of fixtures.cases) {
    it(c.name, () => {
      const points = casePoints(c);
      const before = points.slice();
      for (const [setName, py] of Object.entries(c.results)) {
        const where = `${c.name} / ${setName}`;
        const opts = fixtures.optionSets[setName];
        const got = fitPolyline(points, c.closed, opts);
        seen.fits++;
        if (py === null) {
          expect(got, where).toBeUndefined();
          seen.none++;
          continue;
        }
        const want = py.stableSort ?? py;
        if (py.stableSort) stableSortCases.push(where);
        const r = compare(got, want);
        if (r.problem !== undefined) {
          // só passa se for um empate conhecido E a perturbação provar que é empate
          expect(NOISE_TIES[where], `${where}: ${r.problem}`).toBeDefined();
          let reproduced = false;
          for (let seed = 1; seed <= 32 && !reproduced; seed++) {
            reproduced = compare(fitPolyline(perturbed(points, seed), c.closed, opts), want).problem === undefined;
          }
          expect(reproduced, `${where}: nem com a entrada perturbada em 1e-12 px o resultado do Python aparece`).toBe(true);
          noiseCases.push(where);
          continue;
        }
        const sp = got!;
        if (sp.closed) expect(sp.segments[sp.segments.length - 1].to, `${where}: fecha no início`).toEqual(sp.start);
        const dLen = Math.abs(pathLength(sp) - want.length);
        expect(dLen, `${where}: pathLength`).toBeLessThanOrEqual(TOL);
        if (want.flat !== undefined && want.flatStep !== undefined) {
          const flat = f64(want.flat);
          const gotFlat = flattenSubPath(sp, want.flatStep);
          expect(gotFlat.length, `${where}: flattenSubPath`).toBe(flat.length);
          const dFlat = maxAbsDiff(gotFlat, flat);
          expect(dFlat, `${where}: flattenSubPath`).toBeLessThanOrEqual(TOL);
          seen.flats++;
          seen.maxFlat = Math.max(seen.maxFlat, dFlat);
        }
        seen.segments += want.kinds.length;
        seen.lines += want.kinds.split("L").length - 1;
        seen.maxDiff = Math.max(seen.maxDiff, r.diff);
        seen.maxLen = Math.max(seen.maxLen, dLen);
        if (r.diff === 0) seen.exact++;
      }
      expect(points, "a entrada não é alterada").toEqual(before);
      seen.cases++;
    });
  }

  it("a lista de empates conhecidos está em dia, e eles são raros", () => {
    if (seen.cases !== fixtures.cases.length) return; // rodada parcial (filtro de teste): nada a conferir
    expect(noiseCases.sort()).toEqual(Object.keys(NOISE_TIES).sort());
    expect(noiseCases.length + stableSortCases.length).toBeLessThan(seen.fits / 100);
  });

  afterAll(() => {
    console.log(
      `fitPolyline x Python: ${seen.fits} ajustes em ${seen.cases} polilinhas (${seen.none} sem caminho), ` +
        `${seen.segments} segmentos (${seen.lines} retas). Maior diferença nos pontos de controle = ` +
        `${seen.maxDiff.toExponential(2)} px (${seen.exact} ajustes idênticos bit a bit); pathLength = ` +
        `${seen.maxLen.toExponential(2)}; flattenSubPath (${seen.flats} casos) = ${seen.maxFlat.toExponential(2)}.\n` +
        `  comparados com a referência de argsort estável (${stableSortCases.length}): ${stableSortCases.join(", ") || "-"}\n` +
        `  empates decididos pelo último bit, fora da paridade (${noiseCases.length}): ${noiseCases.join(", ") || "-"}`,
    );
  });
});

describe("aritmética igual à do NumPy/CPython", () => {
  it("mathHypot é exato nos triângulos pitagóricos e nos eixos", () => {
    expect(mathHypot(3, 4)).toBe(5);
    expect(mathHypot(-5, 12)).toBe(13);
    expect(mathHypot(7.5, 4)).toBe(8.5);
    expect(mathHypot(0, -2.25)).toBe(2.25);
    expect(mathHypot(0, 0)).toBe(0);
  });

  it("pairwiseSum soma tudo, em qualquer tamanho", () => {
    for (const n of [0, 1, 7, 8, 9, 127, 128, 129, 1000, 4097]) {
      const a = Float64Array.from({ length: n }, (_, i) => i + 1);
      expect(pairwiseSum(a, 0, n), `n = ${n}`).toBe((n * (n + 1)) / 2);
    }
  });
});

describe("fitPolyline: propriedades", () => {
  it("menos de 2 pontos distintos → undefined", () => {
    expect(fitPolyline(new Float64Array(0), false)).toBeUndefined();
    expect(fitPolyline(new Float64Array([1, 2]), false)).toBeUndefined();
    expect(fitPolyline(new Float64Array([1, 2, 1, 2, 1, 2]), true)).toBeUndefined();
  });

  const syn = (name: string): FitCase => {
    const c = fixtures.cases.find((f) => f.name === name);
    if (!c) throw new Error(`polilinha ${name} não está nos dados de teste`);
    return c;
  };
  const kinds = (sp: SubPath | undefined) => sp?.segments.map((s) => (s.kind === "line" ? "L" : "C")).join("");

  it("régua desligada (straighten 0) não muda nada", () => {
    for (const name of ["syn_stair_k4_shallow", "syn_L_open", "syn_circle_r10", "syn_star5"]) {
      const c = syn(name);
      for (const opts of Object.values(fixtures.optionSets)) {
        expect(fitPolyline(casePoints(c), c.closed, { ...opts, straighten: 0 }), name).toEqual(fitPolyline(casePoints(c), c.closed, opts));
      }
    }
  });

  it("régua ligada: a escada de pixels de uma reta vira uma reta só, de ponta a ponta", () => {
    for (const name of ["syn_stair_k4_shallow", "syn_noisy_line"]) {
      const pts = casePoints(syn(name));
      const sp = fitPolyline(pts, false, { straighten: 0.6 })!;
      expect(kinds(sp), name).toBe("L");
      expect(sp.start, name).toEqual({ x: pts[0], y: pts[1] });
      expect(sp.segments[0].to, name).toEqual({ x: pts[pts.length - 2], y: pts[pts.length - 1] });
    }
  });

  it("régua ligada: o L continua com o canto vivo e vira duas retas", () => {
    const sp = fitPolyline(casePoints(syn("syn_L_open")), false, { straighten: 0.6 })!;
    expect(kinds(sp)).toBe("LL");
    expect(sp.segments[0].to.x).toBeCloseTo(20, 6);
    expect(sp.segments[0].to.y).toBeCloseTo(2, 6);
  });

  it("régua ligada: curva sem trecho reto sai igual ao ajuste normal", () => {
    const c = syn("syn_circle_r10");
    expect(fitPolyline(casePoints(c), true, { straighten: 0.6 })).toEqual(fitPolyline(casePoints(c), true));
  });

  it("uma polilinha aberta começa e termina nas próprias pontas", () => {
    const pts = new Float64Array(2 * 80);
    for (let i = 0; i < 80; i++) {
      pts[2 * i] = i * 0.25;
      pts[2 * i + 1] = 3 * Math.sin(i / 12);
    }
    for (const opts of Object.values(fixtures.optionSets)) {
      const sp = fitPolyline(pts, false, opts)!;
      expect(sp.closed).toBe(false);
      expect(sp.start).toEqual({ x: pts[0], y: pts[1] });
      expect(sp.segments[sp.segments.length - 1].to).toEqual({ x: pts[158], y: pts[159] });
    }
  });
});
