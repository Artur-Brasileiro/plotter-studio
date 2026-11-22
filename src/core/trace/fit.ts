import type { Segment, SubPath } from "../geometry/path";
import type { Vec } from "../geometry/vec";
import { fitPieceStraight } from "./straight";

/**
 * Ajuste de curvas: polilinha densa → retas e Béziers cúbicas, preservando os cantos.
 * Porte de `fit_polyline` (e ajudantes) de `lab/python/vec.py`.
 *
 * O objetivo é dar o MESMO resultado do Python, não um parecido. Por isso a aritmética segue a
 * referência operação por operação, inclusive nos detalhes do NumPy/SciPy que mudam o último bit
 * (os testes comparam com dados gerados por `lab/python/fixtures_strokes.py`):
 *  - `ndarray.sum()` e `.mean()` somam em pares (`pairwiseSum`); `cumsum` soma em sequência;
 *  - `np.hypot` é a fórmula direta `sqrt(x² + y²)`; já `math.hypot` é arredondado corretamente
 *    (os dois diferem no último bit em ~17% dos casos, e o Python usa os dois);
 *  - `x ** 3` é o `pow` da libc, praticamente sempre o cubo arredondado corretamente (`cube`);
 *  - `gaussian_filter1d`: raio `int(4σ + 0.5)`, núcleo simétrico somado de fora para dentro,
 *    pesos com `exp` arredondado corretamente (`expExact`).
 * O que sobra de diferença é o último bit de `pow`/`exp` (a libc do Python erra o arredondamento
 * em 0,05% / 0,5% dos valores), de `atan2` (V8 e libc discordam em ~17%) e das tangentes das
 * pontas (`lstsq` do LAPACK lá, Gram-Schmidt aqui). Nos pontos de controle isso dá ~1e-13 px.
 * Só muda o resultado de verdade quando há EMPATE: forma simétrica ou escada de pixels periódica,
 * em que dois candidatos (a canto, ou a ponto de maior erro) têm a mesma nota e o último bit decide.
 * Aí os dois resultados são igualmente bons, e o do Python também muda de uma máquina para outra.
 */
export interface FitOptions {
  /** Erro máximo do ajuste, em px. Padrão 0,2. */
  tol?: number;
  /** Braço (comprimento de arco, px) usado para medir a virada num ponto. Padrão 2,0. */
  cL?: number;
  /** Virada mínima, em graus, para um ponto ser canto. Padrão 55. */
  cdeg?: number;
  /** A virada medida com meio braço tem de ser pelo menos esta fração da medida com o braço inteiro. Padrão 0,7. */
  cratio?: number;
  /** Reconstrói o vértice do canto pela interseção das retas dos dois lados. Padrão true. */
  sharpen?: boolean;
  /** Distância do canto, em px, a partir da qual os pontos servem para achar as retas dos lados. Padrão 1,0. */
  gap?: number;
  /** Suavização (σ em px de arco) de cada trecho entre cantos. Padrão 0. */
  smooth?: number;
  /** Suavização (σ em px de arco) da polilinha inteira, antes de procurar os cantos. Padrão 0. */
  presmooth?: number;
  /** Uma cúbica cujos pontos de controle ficam a menos disto da corda vira reta. Padrão 0,04. */
  lineTol?: number;
  /** Procura cantos. Padrão true. */
  corners?: boolean;
  /**
   * Régua (`straight.ts`): em cada trecho entre cantos, o que é reto vira reta de verdade. O valor é a
   * tolerância em px (quanto o traço pode fugir da reta); 0 desliga. Padrão 0.
   * No Python é o `piece_fitter` de `fit_polyline` com `straight.fit_piece_straight(snap=...)`.
   */
  straighten?: number;
}

// ---------------------------------------------------------------------------------------------
// Aritmética igual à do NumPy / CPython (usada também por strokes.ts)
// ---------------------------------------------------------------------------------------------

const SPLIT = 134217729; // 2^27 + 1 (divisão de Veltkamp)

/** Erro exato do produto: a·b = p + prodErr(a, b, p), onde p = a·b já arredondado (Dekker). */
function prodErr(a: number, b: number, p: number): number {
  let t = SPLIT * a;
  const ah = t - (t - a);
  const al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b);
  const bl = b - bh;
  return ((ah * bh - p) + ah * bl + al * bh) + al * bl;
}

/**
 * `math.hypot` do CPython: arredondado corretamente (raiz direta + uma correção com os erros exatos
 * dos quadrados). Vale para a faixa de valores de coordenadas de pixel; não trata overflow.
 */
export function mathHypot(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  if (x < y) {
    const t = x;
    x = y;
    y = t;
  }
  if (y === 0) return x;
  const xsq = x * x;
  const ysq = y * y;
  const h = Math.sqrt(xsq + ysq);
  if (!(h < Infinity)) return h;
  const hsq = h * h;
  const r = (((hsq - xsq) - ysq) - prodErr(y, y, ysq)) + prodErr(h, h, hsq) - prodErr(x, x, xsq);
  return h - r / (2 * h);
}

/** `x ** 3` do NumPy: o cubo arredondado corretamente (x² exato em duas partes, vezes x). */
function cube(x: number): number {
  let t = SPLIT * x;
  const xh = t - (t - x);
  const xl = x - xh;
  const h = x * x;
  const l = ((xh * xh - h) + 2 * xh * xl) + xl * xl;
  const p = h * x;
  t = SPLIT * h;
  const hh = t - (t - h);
  const hl = h - hh;
  const e = ((hh * xh - p) + hh * xl + hl * xh) + hl * xl;
  return p + (e + l * x);
}

/**
 * Soma de `n` valores a partir de `lo`, na ordem em que o NumPy soma um vetor contíguo:
 * em sequência até 7 valores; 8 acumuladores até 128; acima disso, divide ao meio.
 */
export function pairwiseSum(a: Float64Array, lo: number, n: number): number {
  if (n < 8) {
    let r = 0;
    for (let i = 0; i < n; i++) r += a[lo + i];
    return r;
  }
  if (n <= 128) {
    let r0 = a[lo];
    let r1 = a[lo + 1];
    let r2 = a[lo + 2];
    let r3 = a[lo + 3];
    let r4 = a[lo + 4];
    let r5 = a[lo + 5];
    let r6 = a[lo + 6];
    let r7 = a[lo + 7];
    const end = n - (n % 8);
    let i = 8;
    for (; i < end; i += 8) {
      const o = lo + i;
      r0 += a[o];
      r1 += a[o + 1];
      r2 += a[o + 2];
      r3 += a[o + 3];
      r4 += a[o + 4];
      r5 += a[o + 5];
      r6 += a[o + 6];
      r7 += a[o + 7];
    }
    let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < n; i++) res += a[lo + i];
    return res;
  }
  let n2 = n >> 1;
  n2 -= n2 % 8;
  return pairwiseSum(a, lo, n2) + pairwiseSum(a, lo + n2, n - n2);
}

const LN2_HI = 0.6931471805599453; // double mais próximo de ln 2
const LN2_LO = 2.3190468138462996e-17; // ln 2 − LN2_HI

/**
 * exp(x) arredondado corretamente, para x <= 0 (os pesos do núcleo gaussiano). O `Math.exp` do V8
 * difere do `exp` da libc do Python no último bit em ~10% dos valores; este difere em ~0,5% (a libc
 * não é exata). Parece preciosismo, mas numa forma simétrica o ponto de maior erro do ajuste é
 * decidido por esse último bit.
 * Conta em precisão dupla-dupla (pares hi + lo): x = k·ln2 + r, série de Taylor de exp(r/512) e
 * nove quadrados.
 */
function expExact(x: number): number {
  if (x === 0) return 1;
  // soma e produto sem erro: a ∘ b = hi + lo exatamente
  let hi = 0;
  let lo = 0;
  const twoSum = (a: number, b: number): void => {
    hi = a + b;
    const bb = hi - a;
    lo = (a - (hi - bb)) + (b - bb);
  };
  const mul = (ah: number, al: number, bh: number, bl: number): void => {
    const p = ah * bh;
    twoSum(p, prodErr(ah, bh, p) + (ah * bl + al * bh));
  };
  const k = Math.floor(x / LN2_HI + 0.5);
  const kLn2 = k * LN2_HI;
  twoSum(x, -kLn2);
  twoSum(hi, (lo - prodErr(k, LN2_HI, kLn2)) - k * LN2_LO);
  const rh = hi / 512;
  const rl = lo / 512;
  let th = 1; // termo rⁿ/n!
  let tl = 0;
  let sh = 1; // soma
  let sl = 0;
  for (let n = 1; n < 12; n++) {
    mul(th, tl, rh, rl);
    th = hi / n;
    tl = lo / n;
    twoSum(sh, th);
    twoSum(hi, lo + (sl + tl));
    sh = hi;
    sl = lo;
  }
  for (let i = 0; i < 9; i++) {
    mul(sh, sl, sh, sl);
    sh = hi;
    sl = lo;
  }
  let v = sh + sl;
  for (let i = k; i < 0; i++) v *= 0.5;
  for (let i = k; i > 0; i--) v *= 2;
  return v;
}

/** `round()` do Python: metade vai para o par. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** `np.allclose(a, b)` com os padrões (rtol 1e-5, atol 1e-8) para um ponto. */
export function pointsClose(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) <= 1e-8 + 1e-5 * Math.abs(bx) && Math.abs(ay - by) <= 1e-8 + 1e-5 * Math.abs(by);
}

/** Primeiro índice de `s[0..n)` com valor >= v (`np.searchsorted`, lado esquerdo). */
function lowerBound(s: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Primeiro índice de `s[0..n)` com valor > v (`np.searchsorted`, lado direito). */
function upperBound(s: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------
// Polilinhas (x0, y0, x1, y1, ...)
// ---------------------------------------------------------------------------------------------

/** Tira os pontos que repetem o anterior (diferença <= 1e-9 em x e em y). O primeiro fica sempre. */
function dropRepeats(P: Float64Array): Float64Array {
  const n = P.length >> 1;
  if (n < 2) return P;
  let kept = 1;
  for (let i = 1; i < n; i++) {
    if (Math.abs(P[2 * i] - P[2 * i - 2]) > 1e-9 || Math.abs(P[2 * i + 1] - P[2 * i - 1]) > 1e-9) kept++;
  }
  if (kept === n) return P;
  const out = new Float64Array(2 * kept);
  out[0] = P[0];
  out[1] = P[1];
  let m = 1;
  for (let i = 1; i < n; i++) {
    // compara com o vizinho ORIGINAL, não com o último ponto que ficou (como o np.diff)
    if (Math.abs(P[2 * i] - P[2 * i - 2]) > 1e-9 || Math.abs(P[2 * i + 1] - P[2 * i - 1]) > 1e-9) {
      out[2 * m] = P[2 * i];
      out[2 * m + 1] = P[2 * i + 1];
      m++;
    }
  }
  return out;
}

/** Comprimento de cada segmento (`np.hypot`: a fórmula direta). */
function segmentLengths(P: Float64Array, n: number): Float64Array {
  const seg = new Float64Array(Math.max(n - 1, 0));
  for (let i = 0; i + 1 < n; i++) {
    const dx = P[2 * i + 2] - P[2 * i];
    const dy = P[2 * i + 3] - P[2 * i + 1];
    seg[i] = Math.sqrt(dx * dx + dy * dy);
  }
  return seg;
}

/** `_unit`: vetor unitário; (1, 0) se o vetor é praticamente nulo. */
function unit(x: number, y: number): [number, number] {
  const n = mathHypot(x, y);
  if (n < 1e-12) return [1, 0];
  return [x / n, y / n];
}

// ---------------------------------------------------------------------------------------------
// Suavização (scipy.ndimage.gaussian_filter1d ao longo dos pontos)
// ---------------------------------------------------------------------------------------------

function gaussianKernel(sigma: number): Float64Array {
  const radius = Math.trunc(4 * sigma + 0.5);
  const w = new Float64Array(2 * radius + 1);
  const c = -0.5 / (sigma * sigma);
  for (let x = 0; x <= radius; x++) w[radius + x] = w[radius - x] = expExact(c * (x * x));
  const total = pairwiseSum(w, 0, w.length);
  for (let i = 0; i < w.length; i++) w[i] /= total;
  return w;
}

/**
 * Filtro gaussiano nas duas coordenadas. `wrap` = a polilinha é fechada (dá a volta);
 * senão a borda repete o último ponto (modo "nearest").
 */
function gaussianFilter(P: Float64Array, n: number, sigma: number, wrap: boolean): Float64Array {
  const w = gaussianKernel(sigma);
  const radius = (w.length - 1) >> 1;
  const ext = new Float64Array(n + 2 * radius);
  const out = new Float64Array(2 * n);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < ext.length; i++) {
      let j = i - radius;
      if (wrap) {
        j %= n;
        if (j < 0) j += n;
      } else if (j < 0) j = 0;
      else if (j >= n) j = n - 1;
      ext[i] = P[2 * j + c];
    }
    for (let i = 0; i < n; i++) {
      const m = i + radius;
      // mesma ordem do SciPy para um núcleo simétrico: centro, depois os pares de fora para dentro
      let acc = ext[m] * w[radius];
      for (let d = radius; d >= 1; d--) acc += (ext[m - d] + ext[m + d]) * w[radius - d];
      out[2 * i + c] = acc;
    }
  }
  return out;
}

/** `_smooth_piece`: suaviza um trecho aberto sem tirar as pontas do lugar (reflexão pontual). */
function smoothPiece(Q: Float64Array, sigmaArc: number): Float64Array {
  const n = Q.length >> 1;
  if (sigmaArc <= 0 || n < 5) return Q;
  const sp = pairwiseSum(segmentLengths(Q, n), 0, n - 1) / (n - 1);
  const sg = sigmaArc / Math.max(sp, 1e-6);
  if (sg < 0.3) return Q;
  const pad = Math.min(n - 1, Math.ceil(3 * sg));
  const m = n + 2 * pad;
  const ext = new Float64Array(2 * m);
  const lx = Q[2 * n - 2];
  const ly = Q[2 * n - 1];
  for (let i = 0; i < pad; i++) {
    ext[2 * i] = 2 * Q[0] - Q[2 * (pad - i)];
    ext[2 * i + 1] = 2 * Q[1] - Q[2 * (pad - i) + 1];
    ext[2 * (pad + n + i)] = 2 * lx - Q[2 * (n - 2 - i)];
    ext[2 * (pad + n + i) + 1] = 2 * ly - Q[2 * (n - 2 - i) + 1];
  }
  ext.set(Q, 2 * pad);
  const sm = gaussianFilter(ext, m, sg, false).slice(2 * pad, 2 * (pad + n));
  sm[0] = Q[0];
  sm[1] = Q[1];
  sm[2 * n - 2] = lx;
  sm[2 * n - 1] = ly;
  return sm;
}

// ---------------------------------------------------------------------------------------------
// Cantos
// ---------------------------------------------------------------------------------------------

interface CornerSearch {
  /** Índices dos cantos (em P), em ordem crescente. */
  corners: number[];
  /** Pontos onde os índices estendidos valem: P (aberta) ou P repetida 3 vezes (fechada). */
  E: Float64Array;
  /** Quantidade de pontos em E. */
  ne: number;
  /** Comprimento de arco acumulado de cada ponto de E. */
  s: Float64Array;
}

/** `_find_corners`: pontos onde a direção vira de repente, medidos em duas escalas. */
function findCorners(P: Float64Array, n: number, closed: boolean, cL: number, cdeg: number, cratio: number): CornerSearch {
  let E: Float64Array;
  let count: number; // pontos usados para acumular o arco (na fechada, um a mais que os de E)
  let first: number; // índice estendido do ponto 0 de P
  if (closed) {
    E = new Float64Array(2 * (3 * n + 1));
    E.set(P.subarray(0, 2 * n), 0);
    E.set(P.subarray(0, 2 * n), 2 * n);
    E.set(P.subarray(0, 2 * n), 4 * n);
    E[6 * n] = P[0];
    E[6 * n + 1] = P[1];
    count = 3 * n + 1;
    first = n;
  } else {
    E = P;
    count = n;
    first = 0;
  }
  const s = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const dx = E[2 * i] - E[2 * i - 2];
    const dy = E[2 * i + 1] - E[2 * i - 1];
    s[i] = s[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  const ne = closed ? 3 * n : n;

  // virada em cada ponto: ângulo entre "L para trás" e "L para a frente" ao longo do arco
  const turn = (L: number): Float64Array => {
    const ang = new Float64Array(n);
    let jf = 0;
    let ub = 0;
    for (let t = 0; t < n; t++) {
      const i = first + t;
      const fwd = s[i] + L;
      while (jf < ne && s[jf] < fwd) jf++; // searchsorted à esquerda (s é crescente, o ponteiro só avança)
      const back = s[i] - L;
      while (ub < ne && s[ub] <= back) ub++; // searchsorted à direita
      const jb = ub - 1;
      if (jf >= ne || jb < 0) continue;
      const v1x = E[2 * i] - E[2 * jb];
      const v1y = E[2 * i + 1] - E[2 * jb + 1];
      const v2x = E[2 * jf] - E[2 * i];
      const v2y = E[2 * jf + 1] - E[2 * i + 1];
      ang[t] = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
    }
    return ang;
  };

  const a1 = turn(cL);
  const a2 = turn(cL / 2);
  const thr = cdeg * (Math.PI / 180);
  const cand: number[] = [];
  for (let t = 0; t < n; t++) if (a1[t] >= thr && a2[t] >= cratio * a1[t]) cand.push(t);
  if (cand.length === 0) return { corners: [], E, ne, s };

  const total = closed ? s[n] - s[0] : s[n - 1];
  // Do mais marcado para o menos. Empate: fica na frente o de menor índice (ordenação estável).
  // O Python usa np.argsort sem `kind`, que NÃO é estável: com notas exatamente iguais (acontece em
  // formas simétricas) a ordem dele depende da máquina. Aqui a regra é fixa.
  const score = (t: number) => -(a1[t] + a2[t]);
  const order = cand.slice().sort((p, q) => score(p) - score(q) || p - q);
  const chosen: number[] = [];
  for (const c of order) {
    let good = true;
    for (const d of chosen) {
      let ds = Math.abs(s[first + c] - s[first + d]);
      if (closed) ds = Math.min(ds, total - ds);
      if (ds < cL) {
        good = false;
        break;
      }
    }
    if (good) chosen.push(c);
  }
  chosen.sort((p, q) => p - q);
  return { corners: chosen, E, ne, s };
}

interface Anchor {
  /** Índice estendido do canto. */
  idx: number;
  x: number;
  y: number;
  /** Deslocamento (negativo) até o último ponto que vale antes do canto. */
  back: number;
  /** Deslocamento (positivo) até o primeiro ponto que vale depois do canto. */
  fwd: number;
}

/**
 * `_sharpen`: refaz o vértice do canto pela interseção das retas dos dois lados (os pontos perto do
 * canto vêm arredondados pelo esqueleto). Devolve null quando não dá para confiar.
 */
function sharpenCorner(
  E: Float64Array,
  ne: number,
  s: Float64Array,
  c: number,
  gap: number,
  m: number,
  limB: number,
  limF: number,
): Anchor | null {
  if (limB < gap + 0.4 * m || limF < gap + 0.4 * m) return null;
  const mb = Math.min(m, limB - gap);
  const mf = Math.min(m, limF - gap);
  const ib0 = lowerBound(s, ne, s[c] - gap - mb);
  const ib1 = upperBound(s, ne, s[c] - gap) - 1;
  const if0 = lowerBound(s, ne, s[c] + gap);
  const if1 = upperBound(s, ne, s[c] + gap + mf) - 1;
  if (ib1 - ib0 < 1 || if1 - if0 < 1 || ib0 < 0 || if1 >= ne) return null;
  const [dbx, dby] = unit(E[2 * ib1] - E[2 * ib0], E[2 * ib1 + 1] - E[2 * ib0 + 1]);
  const [dfx, dfy] = unit(E[2 * if1] - E[2 * if0], E[2 * if1 + 1] - E[2 * if0 + 1]);
  const cr = dbx * dfy - dby * dfx;
  if (Math.abs(cr) < 0.25) return null;
  const wx = E[2 * if0] - E[2 * ib1];
  const wy = E[2 * if0 + 1] - E[2 * ib1 + 1];
  const tb = (wx * dfy - wy * dfx) / cr;
  const tf = (wx * dby - wy * dbx) / cr;
  if (tb < 0 || tf > 0) return null;
  const x = E[2 * ib1] + dbx * tb;
  const y = E[2 * ib1 + 1] + dby * tb;
  if (mathHypot(x - E[2 * c], y - E[2 * c + 1]) > 1.6 * gap) return null;
  return { idx: c, x, y, back: ib1 - c, fwd: if0 - c };
}

// ---------------------------------------------------------------------------------------------
// Tangentes das pontas
// ---------------------------------------------------------------------------------------------

/**
 * `_end_tangent`: tangente na ponta do trecho, apontando para dentro, por ajuste quadrático dos
 * primeiros pontos. `fromEnd` mede a partir do último ponto (o Python passa `Q[::-1]`).
 */
function endTangent(Q: Float64Array, n: number, twArc: number, fromEnd: boolean): [number, number] {
  const at = (i: number) => 2 * (fromEnd ? n - 1 - i : i);
  const ox = Q[at(0)];
  const oy = Q[at(0) + 1];
  // m = quantos pontos entram: os que estão a menos de twArc da ponta, mais um
  const sl: number[] = [];
  let acc = 0;
  let m = n; // searchsorted devolve n-1 (tudo abaixo de twArc); +1
  for (let i = 1; i < n; i++) {
    const dx = Q[at(i)] - Q[at(i - 1)];
    const dy = Q[at(i) + 1] - Q[at(i - 1) + 1];
    const d = Math.sqrt(dx * dx + dy * dy);
    acc = i === 1 ? d : acc + d;
    sl.push(acc);
    if (acc >= twArc) {
      m = i;
      break;
    }
  }
  m = Math.max(1, Math.min(m, n - 1));
  const chord = (): [number, number] => unit(Q[at(m)] - ox, Q[at(m) + 1] - oy);
  if (m < 3) return chord();

  // Mínimos quadrados de (s, s²) → deslocamento, para x e para y; só interessa o coeficiente de s.
  // O NumPy resolve por SVD; aqui, Gram-Schmidt modificado nas duas colunas (mesma solução, e sem
  // elevar o condicionamento ao quadrado como as equações normais fariam).
  let r11 = 0;
  for (let i = 0; i < m; i++) r11 += sl[i] * sl[i];
  r11 = Math.sqrt(r11);
  const q1 = new Float64Array(m);
  const q2 = new Float64Array(m);
  let r12 = 0;
  for (let i = 0; i < m; i++) {
    q1[i] = sl[i] / r11;
    r12 += q1[i] * (sl[i] * sl[i]);
  }
  let r22 = 0;
  for (let i = 0; i < m; i++) {
    q2[i] = sl[i] * sl[i] - r12 * q1[i];
    r22 += q2[i] * q2[i];
  }
  r22 = Math.sqrt(r22);
  if (!(r11 > 0) || !(r22 > 0)) return chord();
  for (let i = 0; i < m; i++) q2[i] /= r22;
  const solve = (c: number): number => {
    let y1 = 0;
    for (let i = 0; i < m; i++) y1 += q1[i] * (Q[at(i + 1) + c] - (c === 0 ? ox : oy));
    let y2 = 0;
    for (let i = 0; i < m; i++) y2 += q2[i] * (Q[at(i + 1) + c] - (c === 0 ? ox : oy) - y1 * q1[i]);
    return (y1 - r12 * (y2 / r22)) / r11;
  };
  const ax = solve(0);
  const ay = solve(1);
  if (!(mathHypot(ax, ay) >= 1e-9)) return chord();
  return unit(ax, ay);
}

// ---------------------------------------------------------------------------------------------
// Schneider: uma ou mais cúbicas por um trecho, dadas as tangentes das pontas
// ---------------------------------------------------------------------------------------------

/** Memória de trabalho de um trecho (evita alocar a cada divisão). */
interface FitScratch {
  /** Parâmetro de cada ponto, de 0 a 1. */
  u: Float64Array;
  /** Polinômios de Bernstein em u[i] (ver `bernstein`): valem enquanto `u` não mudar. */
  b0: Float64Array;
  b1: Float64Array;
  b2: Float64Array;
  b3: Float64Array;
  /** Parcelas das somas do `genBezier` (o NumPy soma tudo de uma vez, em pares). */
  c00: Float64Array;
  c01: Float64Array;
  c11: Float64Array;
  x0: Float64Array;
  x1: Float64Array;
}

/**
 * Os quatro pesos da cúbica em cada u[i]. São usados três vezes por rodada (alças, erro e
 * reparametrização) com exatamente as mesmas contas do Python, então são calculados uma vez só.
 */
function bernstein(w: FitScratch, n: number): void {
  for (let i = 0; i < n; i++) {
    const t = w.u[i];
    const mt = 1 - t;
    w.b0[i] = cube(mt);
    w.b1[i] = 3 * mt * mt * t;
    w.b2[i] = 3 * mt * t * t;
    w.b3[i] = cube(t);
  }
}

/**
 * `_gen_bezier`: mínimos quadrados para os dois comprimentos de alça, com as direções fixas.
 * `o` = posição (em números) do primeiro ponto do trecho dentro de Q; `n` = pontos do trecho.
 * Escreve os 4 pontos de controle em `bez`.
 */
function genBezier(
  Q: Float64Array,
  o: number,
  n: number,
  w: FitScratch,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
  bez: Float64Array,
): void {
  const p0x = Q[o];
  const p0y = Q[o + 1];
  const p3x = Q[o + 2 * n - 2];
  const p3y = Q[o + 2 * n - 1];
  for (let i = 0; i < n; i++) {
    const b0 = w.b0[i];
    const b1 = w.b1[i];
    const b2 = w.b2[i];
    const b3 = w.b3[i];
    const a1x = b1 * t1x;
    const a1y = b1 * t1y;
    const a2x = b2 * t2x;
    const a2y = b2 * t2y;
    const k03 = b0 + b1;
    const k23 = b2 + b3;
    const tx = Q[o + 2 * i] - (k03 * p0x + k23 * p3x);
    const ty = Q[o + 2 * i + 1] - (k03 * p0y + k23 * p3y);
    const j = 2 * i;
    w.c00[j] = a1x * a1x;
    w.c00[j + 1] = a1y * a1y;
    w.c01[j] = a1x * a2x;
    w.c01[j + 1] = a1y * a2y;
    w.c11[j] = a2x * a2x;
    w.c11[j + 1] = a2y * a2y;
    w.x0[j] = a1x * tx;
    w.x0[j + 1] = a1y * ty;
    w.x1[j] = a2x * tx;
    w.x1[j + 1] = a2y * ty;
  }
  const c00 = pairwiseSum(w.c00, 0, 2 * n);
  const c01 = pairwiseSum(w.c01, 0, 2 * n);
  const c11 = pairwiseSum(w.c11, 0, 2 * n);
  const x0 = pairwiseSum(w.x0, 0, 2 * n);
  const x1 = pairwiseSum(w.x1, 0, 2 * n);
  const det = c00 * c11 - c01 * c01;
  const chx = p3x - p0x;
  const chy = p3y - p0y;
  const seg = mathHypot(chx, chy);
  const eps = 1e-6 * seg;
  let al = 0;
  let ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  let bad = al < eps || ar < eps;
  if (!bad) {
    // pontos de controle fora de ordem ao longo da corda → cai na heurística
    const h1 = t1x * al * chx + t1y * al * chy;
    const h2 = t2x * ar * chx + t2y * ar * chy;
    if (h1 - h2 > seg * seg) bad = true;
  }
  if (bad) al = ar = seg / 3;
  bez[0] = p0x;
  bez[1] = p0y;
  bez[2] = p0x + t1x * al;
  bez[3] = p0y + t1y * al;
  bez[4] = p3x + t2x * ar;
  bez[5] = p3y + t2y * ar;
  bez[6] = p3x;
  bez[7] = p3y;
}

/** Maior erro (ao quadrado) entre a cúbica em u[i] e os pontos; `at` = índice do pior ponto. */
function maxError(Q: Float64Array, o: number, n: number, w: FitScratch, bez: Float64Array): { err: number; at: number } {
  let err = -Infinity;
  let at = 0;
  for (let i = 0; i < n; i++) {
    const dx = w.b0[i] * bez[0] + w.b1[i] * bez[2] + w.b2[i] * bez[4] + w.b3[i] * bez[6] - Q[o + 2 * i];
    const dy = w.b0[i] * bez[1] + w.b1[i] * bez[3] + w.b2[i] * bez[5] + w.b3[i] * bez[7] - Q[o + 2 * i + 1];
    const e = dx * dx + dy * dy;
    if (e > err) {
      err = e;
      at = i;
    }
  }
  return { err, at };
}

/** `_reparam`: um passo de Newton em cada parâmetro u[i], no lugar (depois é preciso refazer `bernstein`). */
function reparameterize(Q: Float64Array, o: number, n: number, w: FitScratch, bez: Float64Array): void {
  const u = w.u;
  const d10x = 3 * (bez[2] - bez[0]);
  const d10y = 3 * (bez[3] - bez[1]);
  const d11x = 3 * (bez[4] - bez[2]);
  const d11y = 3 * (bez[5] - bez[3]);
  const d12x = 3 * (bez[6] - bez[4]);
  const d12y = 3 * (bez[7] - bez[5]);
  const d20x = 2 * (d11x - d10x);
  const d20y = 2 * (d11y - d10y);
  const d21x = 2 * (d12x - d11x);
  const d21y = 2 * (d12y - d11y);
  for (let i = 0; i < n; i++) {
    const t = u[i];
    const mt = 1 - t;
    const dx = w.b0[i] * bez[0] + w.b1[i] * bez[2] + w.b2[i] * bez[4] + w.b3[i] * bez[6] - Q[o + 2 * i];
    const dy = w.b0[i] * bez[1] + w.b1[i] * bez[3] + w.b2[i] * bez[5] + w.b3[i] * bez[7] - Q[o + 2 * i + 1];
    const k0 = mt * mt;
    const k1 = 2 * mt * t;
    const k2 = t * t;
    const q1x = k0 * d10x + k1 * d11x + k2 * d12x;
    const q1y = k0 * d10y + k1 * d11y + k2 * d12y;
    const q2x = mt * d20x + t * d21x;
    const q2y = mt * d20y + t * d21y;
    const num = dx * q1x + dy * q1y;
    let den = (q1x * q1x + q1y * q1y) + (dx * q2x + dy * q2y);
    if (Math.abs(den) < 1e-12) den = 1;
    const v = t - num / den;
    u[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  u[0] = 0;
  u[n - 1] = 1;
}

/**
 * `_schneider`: ajusta cúbicas ao trecho Q, dividindo no ponto de maior erro enquanto o erro
 * passar de `err2`. Devolve as cúbicas em ordem, cada uma com 8 números (4 pontos de controle).
 */
function schneider(
  Q: Float64Array,
  nq: number,
  t1: readonly [number, number],
  t2: readonly [number, number],
  err2: number,
  tw: number,
): Float64Array[] {
  const out: { i0: number; bez: Float64Array }[] = [];
  const w: FitScratch = {
    u: new Float64Array(nq),
    b0: new Float64Array(nq),
    b1: new Float64Array(nq),
    b2: new Float64Array(nq),
    b3: new Float64Array(nq),
    c00: new Float64Array(2 * nq),
    c01: new Float64Array(2 * nq),
    c11: new Float64Array(2 * nq),
    x0: new Float64Array(2 * nq),
    x1: new Float64Array(2 * nq),
  };
  const u = w.u;
  // pilha de (i0, i1, tangente no início, tangente no fim)
  const stack: number[] = [0, nq - 1, t1[0], t1[1], t2[0], t2[1]];
  while (stack.length > 0) {
    const tby = stack.pop()!;
    const tbx = stack.pop()!;
    const tay = stack.pop()!;
    const tax = stack.pop()!;
    const i1 = stack.pop()!;
    const i0 = stack.pop()!;
    const n = i1 - i0 + 1;
    const o = 2 * i0;
    const bez = new Float64Array(8);
    if (n === 2) {
      const d = mathHypot(Q[o + 2] - Q[o], Q[o + 3] - Q[o + 1]) / 3;
      bez[0] = Q[o];
      bez[1] = Q[o + 1];
      bez[2] = Q[o] + tax * d;
      bez[3] = Q[o + 1] + tay * d;
      bez[4] = Q[o + 2] + tbx * d;
      bez[5] = Q[o + 3] + tby * d;
      bez[6] = Q[o + 2];
      bez[7] = Q[o + 3];
      out.push({ i0, bez });
      continue;
    }
    // parâmetro inicial: comprimento de corda acumulado, de 0 a 1
    u[0] = 0;
    for (let i = 1; i < n; i++) {
      const dx = Q[o + 2 * i] - Q[o + 2 * i - 2];
      const dy = Q[o + 2 * i + 1] - Q[o + 2 * i - 1];
      const d = Math.sqrt(dx * dx + dy * dy);
      u[i] = i === 1 ? d : u[i - 1] + d;
    }
    const total = u[n - 1];
    if (total <= 1e-12) {
      bez[0] = bez[2] = Q[o];
      bez[1] = bez[3] = Q[o + 1];
      bez[4] = bez[6] = Q[o + 2 * n - 2];
      bez[5] = bez[7] = Q[o + 2 * n - 1];
      out.push({ i0, bez });
      continue;
    }
    for (let i = 0; i < n; i++) u[i] /= total;
    bernstein(w, n);
    genBezier(Q, o, n, w, tax, tay, tbx, tby, bez);
    let e = maxError(Q, o, n, w, bez);
    let ok = e.err < err2;
    if (!ok && e.err < err2 * 16) {
      for (let it = 0; it < 4; it++) {
        reparameterize(Q, o, n, w, bez);
        bernstein(w, n);
        genBezier(Q, o, n, w, tax, tay, tbx, tby, bez);
        e = maxError(Q, o, n, w, bez);
        if (e.err < err2) {
          ok = true;
          break;
        }
      }
    }
    if (ok) {
      out.push({ i0, bez });
      continue;
    }
    const split = Math.min(Math.max(e.at, 1), n - 2);
    const c = i0 + split;
    const a = Math.max(0, c - tw);
    const b = Math.min(nq - 1, c + tw);
    const [tcx, tcy] = unit(Q[2 * a] - Q[2 * b], Q[2 * a + 1] - Q[2 * b + 1]);
    stack.push(c, i1, -tcx, -tcy, tbx, tby);
    stack.push(i0, c, tax, tay, tcx, tcy);
  }
  out.sort((p, q) => p.i0 - q.i0);
  return out.map((p) => p.bez);
}

// ---------------------------------------------------------------------------------------------
// fitPolyline
// ---------------------------------------------------------------------------------------------

interface Piece {
  q: Float64Array;
  /** Tangentes já conhecidas (curva fechada sem cantos); senão saem de `endTangent`. */
  t1?: [number, number];
  t2?: [number, number];
}

/** Trecho entre duas âncoras: vértice de `a`, os pontos de E entre elas, vértice de `b`. */
function pieceBetween(E: Float64Array, ne: number, a: Anchor, b: Anchor, bIdx: number): Float64Array {
  const lo = a.idx + a.fwd;
  const hi = Math.min(bIdx + b.back, ne - 1);
  const mid = hi >= lo ? hi - lo + 1 : 0;
  const q = new Float64Array(2 * (mid + 2));
  q[0] = a.x;
  q[1] = a.y;
  if (mid > 0) q.set(E.subarray(2 * lo, 2 * (hi + 1)), 2);
  q[2 * mid + 2] = b.x;
  q[2 * mid + 3] = b.y;
  return q;
}

/**
 * Ajusta retas e cúbicas a uma polilinha densa (`points` = x0, y0, x1, y1, ...; unidade livre, os
 * padrões das opções foram pensados para px da imagem). Devolve `undefined` se sobrar menos de
 * 2 pontos distintos. Num caminho fechado o último segmento termina exatamente em `start`.
 */
export function fitPolyline(points: Float64Array, closed: boolean, opts: FitOptions = {}): SubPath | undefined {
  const tol = opts.tol ?? 0.2;
  const cL = opts.cL ?? 2.0;
  const cdeg = opts.cdeg ?? 55.0;
  const cratio = opts.cratio ?? 0.7;
  const sharpen = opts.sharpen ?? true;
  const gap = opts.gap ?? 1.0;
  const smooth = opts.smooth ?? 0.0;
  const presmooth = opts.presmooth ?? 0.0;
  const lineTol = opts.lineTol ?? 0.04;
  const corners = opts.corners ?? true;
  const straighten = opts.straighten ?? 0;

  let P = dropRepeats(points.length % 2 === 0 ? points : points.subarray(0, points.length - 1));
  let n = P.length >> 1;
  if (closed && n > 2 && pointsClose(P[0], P[1], P[2 * n - 2], P[2 * n - 1])) {
    n--;
    P = P.subarray(0, 2 * n);
  }
  if (n < 2) return undefined;
  if (closed && n < 4) closed = false;
  if (presmooth > 0 && n >= 7) {
    const sg = presmooth / Math.max(pairwiseSum(segmentLengths(P, n), 0, n - 1) / (n - 1), 1e-6);
    if (sg >= 0.3) P = closed ? gaussianFilter(P, n, sg, true) : smoothPiece(P, presmooth);
  }

  const total =
    pairwiseSum(segmentLengths(P, n), 0, n - 1) + (closed ? mathHypot(P[0] - P[2 * n - 2], P[1] - P[2 * n - 1]) : 0);
  const sp = total / Math.max(n - (closed ? 0 : 1), 1); // espaçamento médio dos pontos
  const twArc = Math.max(1.0, 3 * sp);
  const tw = Math.max(1, roundHalfEven(0.75 / Math.max(sp, 1e-6)));
  const err2 = tol * tol;

  let found: CornerSearch | undefined;
  if (corners && total > (closed ? 4 * cL : 2 * cL) && n >= 8) found = findCorners(P, n, closed, cL, cdeg, cratio);

  const pieces: Piece[] = [];
  if (!found || found.corners.length === 0) {
    if (closed) {
      if (smooth > 0) {
        const sg = smooth / Math.max(sp, 1e-6);
        if (sg >= 0.3) P = gaussianFilter(P, n, sg, true);
      }
      const q = new Float64Array(2 * n + 2);
      q.set(P.subarray(0, 2 * n), 0);
      q[2 * n] = P[0];
      q[2 * n + 1] = P[1];
      // tangente na emenda: direção entre os vizinhos dos dois lados do ponto 0
      const w = Math.min(tw, (n - 1) >> 1);
      const a = w % n;
      const b = (n - w) % n;
      const tc = unit(P[2 * a] - P[2 * b], P[2 * a + 1] - P[2 * b + 1]);
      pieces.push({ q, t1: tc, t2: [-tc[0], -tc[1]] });
    } else {
      pieces.push({ q: smoothPiece(P.subarray(0, 2 * n), smooth) });
    }
  } else {
    const { E, ne, s } = found;
    const off = closed ? n : 0;
    const ext = found.corners.map((c) => off + c);
    const anchors: Anchor[] = [];
    for (let i = 0; i < ext.length; i++) {
      const ce = ext[i];
      let prevS: number;
      let nextS: number;
      if (closed) {
        prevS = i > 0 ? s[ext[i - 1]] : s[ext[ext.length - 1]] - total;
        nextS = i + 1 < ext.length ? s[ext[i + 1]] : s[ext[0]] + total;
      } else {
        prevS = i > 0 ? s[ext[i - 1]] : s[0];
        nextS = i + 1 < ext.length ? s[ext[i + 1]] : s[n - 1];
      }
      // cada canto só usa metade do caminho até o vizinho
      const limB = (s[ce] - prevS) / 2;
      const limF = (nextS - s[ce]) / 2;
      const sharp = sharpen ? sharpenCorner(E, ne, s, ce, gap, 1.5 * gap, limB, limF) : null;
      anchors.push(sharp ?? { idx: ce, x: E[2 * ce], y: E[2 * ce + 1], back: -1, fwd: 1 });
    }
    if (closed) {
      for (let i = 0; i < anchors.length; i++) {
        const last = i + 1 === anchors.length;
        const b = anchors[last ? 0 : i + 1];
        pieces.push({ q: pieceBetween(E, ne, anchors[i], b, last ? b.idx + n : b.idx) });
      }
    } else {
      const seq: Anchor[] = [
        { idx: 0, x: E[0], y: E[1], back: 0, fwd: 1 },
        ...anchors,
        { idx: n - 1, x: E[2 * n - 2], y: E[2 * n - 1], back: -1, fwd: 0 },
      ];
      for (let i = 0; i + 1 < seq.length; i++) pieces.push({ q: pieceBetween(E, ne, seq[i], seq[i + 1], seq[i + 1].idx) });
    }
    for (const piece of pieces) piece.q = smoothPiece(piece.q, smooth);
  }

  let start: Vec | undefined;
  const segments: Segment[] = [];
  for (const piece of pieces) {
    const Q = dropRepeats(piece.q);
    const nq = Q.length >> 1;
    if (nq < 2) continue;
    start ??= { x: Q[0], y: Q[1] };
    if (nq === 2) {
      segments.push({ kind: "line", to: { x: Q[2], y: Q[3] } });
      continue;
    }
    if (straighten > 0) {
      // Régua: se o trecho tem partes retas, quem ajusta é straight.ts (as curvas dele voltam para cá).
      // Como no Python (`piece_fitter(Q, tol, tw_arc, tw)`), as tangentes já conhecidas de uma curva
      // fechada sem cantos (piece.t1/t2) NÃO são repassadas: a régua estima as dela. Para repassar,
      // basta incluir `t1: piece.t1, t2: piece.t2` aqui, mas aí o resultado deixa de bater com o Python.
      const ruled = fitPieceStraight(Q, nq, { snap: straighten, tol, twArc, tw, lineTol }, { schneider, endTangent });
      if (ruled) {
        for (const s of ruled) segments.push(s);
        continue;
      }
    }
    const t1 = piece.t1 ?? endTangent(Q, nq, twArc, false);
    const t2 = piece.t2 ?? endTangent(Q, nq, twArc, true);
    for (const bez of schneider(Q, nq, t1, t2, err2, tw)) {
      // régua: cúbica com os pontos de controle praticamente em cima da corda vira reta
      const chx = bez[6] - bez[0];
      const chy = bez[7] - bez[1];
      const L = mathHypot(chx, chy);
      let isLine = true;
      if (!(L < 1e-9)) {
        const nx = -chy / L;
        const ny = chx / L;
        const d1 = Math.abs((bez[2] - bez[0]) * nx + (bez[3] - bez[1]) * ny);
        const d2 = Math.abs((bez[4] - bez[0]) * nx + (bez[5] - bez[1]) * ny);
        isLine = (d2 > d1 ? d2 : d1) < lineTol;
      }
      const to = { x: bez[6], y: bez[7] };
      segments.push(
        isLine ? { kind: "line", to } : { kind: "cubic", c1: { x: bez[2], y: bez[3] }, c2: { x: bez[4], y: bez[5] }, to },
      );
    }
  }
  if (segments.length === 0 || !start) return undefined;
  if (closed) {
    // Já termina em `start` (o último trecho acaba na âncora em que o primeiro começa); isto só
    // garante a igualdade exata mesmo se a limpeza de pontos repetidos comer o último ponto.
    const last = segments[segments.length - 1];
    segments[segments.length - 1] = { ...last, to: start };
  }
  return { start, segments, closed };
}

// ---------------------------------------------------------------------------------------------
// Utilitários de caminho (`path_length`, `path_flatten`)
// ---------------------------------------------------------------------------------------------

function cubicPoint(p0: Vec, c1: Vec, c2: Vec, p3: Vec, t: number, out: Float64Array, o: number): void {
  const mt = 1 - t;
  const b0 = cube(mt);
  const b1 = 3 * mt * mt * t;
  const b2 = 3 * mt * t * t;
  const b3 = cube(t);
  out[o] = b0 * p0.x + b1 * c1.x + b2 * c2.x + b3 * p3.x;
  out[o + 1] = b0 * p0.y + b1 * c1.y + b2 * c2.y + b3 * p3.y;
}

/** Comprimento do caminho: retas exatas; cada cúbica medida por 8 cordas (como o `path_length` do Python). */
export function pathLength(sp: SubPath): number {
  let total = 0;
  let prev = sp.start;
  const pts = new Float64Array(18);
  const seg = new Float64Array(8);
  for (const s of sp.segments) {
    if (s.kind === "line") {
      total += mathHypot(s.to.x - prev.x, s.to.y - prev.y);
    } else {
      for (let i = 0; i <= 8; i++) cubicPoint(prev, s.c1, s.c2, s.to, i === 8 ? 1 : i * 0.125, pts, 2 * i);
      for (let i = 0; i < 8; i++) {
        const dx = pts[2 * i + 2] - pts[2 * i];
        const dy = pts[2 * i + 3] - pts[2 * i + 1];
        seg[i] = Math.sqrt(dx * dx + dy * dy);
      }
      total += pairwiseSum(seg, 0, 8);
    }
    prev = s.to;
  }
  return total;
}

/**
 * Caminho → polilinha (x0, y0, x1, y1, ...): cada cúbica vira de 3 a 40 cordas, ~uma a cada `stepPx`
 * da distância entre as pontas (como o `path_flatten` do Python). Serve para medir e comparar em px;
 * o G-code usa o achatamento por tolerância de `src/core/geometry/flatten.ts`.
 */
export function flattenSubPath(sp: SubPath, stepPx: number): Float64Array {
  const counts: number[] = [];
  let total = 1;
  let prev = sp.start;
  for (const s of sp.segments) {
    let nseg = 1;
    if (s.kind === "cubic") {
      const L = mathHypot(s.to.x - prev.x, s.to.y - prev.y) + 1e-9;
      nseg = Math.trunc(Math.min(40, Math.max(3, L / stepPx)));
    }
    counts.push(nseg);
    total += nseg;
    prev = s.to;
  }
  const out = new Float64Array(2 * total);
  out[0] = sp.start.x;
  out[1] = sp.start.y;
  let m = 1;
  prev = sp.start;
  sp.segments.forEach((s, k) => {
    if (s.kind === "line") {
      out[2 * m] = s.to.x;
      out[2 * m + 1] = s.to.y;
      m++;
    } else {
      const nseg = counts[k];
      const step = 1 / nseg; // np.linspace: i·passo, com o último valor trocado por 1
      for (let i = 1; i <= nseg; i++, m++) cubicPoint(prev, s.c1, s.c2, s.to, i === nseg ? 1 : i * step, out, 2 * m);
    }
    prev = s.to;
  });
  return out;
}
