/**
 * Primitivas de imagem do traçador: ampliação, borrão gaussiano, erosão/dilatação e percentil.
 *
 * São ports do OpenCV 4.13 (cv2.resize, cv2.GaussianBlur, cv2.erode/dilate) e do np.percentile que
 * o laboratório usa (lab/python/vec.py), e têm de dar os MESMOS números: os testes comparam com
 * fixtures gerados rodando o Python de verdade (lab/python/fixtures_raster.py).
 *
 * Tudo puro (sem DOM), em arrays tipados e com filtros separáveis: as imagens reais chegam a
 * ~30 milhões de pixels depois de ampliadas.
 */
import { gray, type GrayImage } from "./types";

const fr = Math.fround;

// =====================================================================
// Ampliação (cv2.resize com INTER_CUBIC / INTER_LINEAR)
// =====================================================================

/** Para cada pixel de destino: `taps` índices da origem (já presos à borda) e os pesos deles. */
interface Taps {
  readonly idx: Int32Array;
  readonly w: Float64Array;
}

/**
 * Posições e pesos de uma direção: centro do pixel alinhado (destino d ↔ origem (d + 0,5)/k − 0,5),
 * cúbica de Keys com A = −0,75 e borda replicada, como no cv2.resize.
 *
 * Com k inteiro o destino d = k·n + r cai sempre na mesma fração entre dois pixels da origem,
 * (2r + 1)/(2k) − 0,5, qualquer que seja n: os pesos dependem só de r e são calculados exatos.
 * É assim que o OpenCV com IPP (o dos pacotes para x86, usado na referência) responde.
 *
 * Cuidado ao "simplificar": o código próprio do OpenCV (sem IPP) arredonda a posição para float32
 * antes de tirar a fração, o que desloca os pesos conforme a coluna quando k não é potência de 2.
 * Numa imagem de 736×1300 com k = 3, 5 ou 6 isso muda o resultado em até ~0,02 (escala 0..255),
 * acima da tolerância dos testes. Os casos "faixa" de resize.json existem para pegar essa troca.
 */
function resizeTaps(srcLen: number, k: number, cubic: boolean): Taps {
  const taps = cubic ? 4 : 2;
  const dstLen = srcLen * k;
  const idx = new Int32Array(dstLen * taps);
  const w = new Float64Array(dstLen * taps);
  const last = srcLen - 1;
  for (let d = 0; d < dstLen; d++) {
    const r = d % k;
    const pos = (2 * r + 1) / (2 * k) - 0.5; // em (−0,5; 0,5)
    const s = (d - r) / k + (pos < 0 ? -1 : 0); // pixel da origem logo à esquerda
    const f = pos < 0 ? pos + 1 : pos; // fração a partir dele
    const o = d * taps;
    if (cubic) {
      const A = -0.75;
      const a = f + 1;
      const b = 1 - f;
      w[o] = ((A * a - 5 * A) * a + 8 * A) * a - 4 * A;
      w[o + 1] = ((A + 2) * f - (A + 3)) * f * f + 1;
      w[o + 2] = ((A + 2) * b - (A + 3)) * b * b + 1;
      w[o + 3] = 1 - w[o] - w[o + 1] - w[o + 2];
      for (let j = 0; j < 4; j++) {
        const p = s - 1 + j;
        idx[o + j] = p < 0 ? 0 : p > last ? last : p;
      }
    } else {
      w[o] = 1 - f;
      w[o + 1] = f;
      idx[o] = s < 0 ? 0 : s;
      idx[o + 1] = s < last ? s + 1 : last;
    }
  }
  return { idx, w };
}

function resize(img: GrayImage, k: number, cubic: boolean): GrayImage {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`fator de ampliação inválido: ${k}`);
  const { width: W, height: H, data: src } = img;
  if (k === 1 || W === 0 || H === 0) return gray(W * k, H * k, src.slice(0, W * H));
  const Wd = W * k;
  const Hd = H * k;
  const tx = resizeTaps(W, k, cubic);
  const ty = resizeTaps(H, k, cubic);
  const xi = tx.idx;
  const xw = tx.w;
  const yi = ty.idx;
  const yw = ty.w;

  // 1) horizontal: cada linha da origem vira uma linha com a largura final (float32, como no OpenCV)
  const tmp = new Float32Array(Wd * H);
  for (let y = 0; y < H; y++) {
    const so = y * W;
    const to = y * Wd;
    if (cubic) {
      for (let x = 0, t = 0; x < Wd; x++, t += 4) {
        tmp[to + x] =
          src[so + xi[t]] * xw[t] +
          src[so + xi[t + 1]] * xw[t + 1] +
          src[so + xi[t + 2]] * xw[t + 2] +
          src[so + xi[t + 3]] * xw[t + 3];
      }
    } else {
      for (let x = 0, t = 0; x < Wd; x++, t += 2) {
        tmp[to + x] = src[so + xi[t]] * xw[t] + src[so + xi[t + 1]] * xw[t + 1];
      }
    }
  }

  // 2) vertical: cada linha de destino mistura 4 (ou 2) linhas de tmp
  const out = new Float32Array(Wd * Hd);
  for (let y = 0; y < Hd; y++) {
    const oo = y * Wd;
    if (cubic) {
      const t = y * 4;
      const r0 = yi[t] * Wd;
      const r1 = yi[t + 1] * Wd;
      const r2 = yi[t + 2] * Wd;
      const r3 = yi[t + 3] * Wd;
      const b0 = yw[t];
      const b1 = yw[t + 1];
      const b2 = yw[t + 2];
      const b3 = yw[t + 3];
      for (let x = 0; x < Wd; x++) {
        out[oo + x] = tmp[r0 + x] * b0 + tmp[r1 + x] * b1 + tmp[r2 + x] * b2 + tmp[r3 + x] * b3;
      }
    } else {
      const t = y * 2;
      const r0 = yi[t] * Wd;
      const r1 = yi[t + 1] * Wd;
      const b0 = yw[t];
      const b1 = yw[t + 1];
      for (let x = 0; x < Wd; x++) out[oo + x] = tmp[r0 + x] * b0 + tmp[r1 + x] * b1;
    }
  }
  return gray(Wd, Hd, out);
}

/**
 * Amplia k× (k inteiro ≥ 1) com interpolação bicúbica.
 * Igual a `cv2.resize(src, (W*k, H*k), interpolation=cv2.INTER_CUBIC)` em float32.
 */
export function resizeBicubic(img: GrayImage, k: number): GrayImage {
  return resize(img, k, true);
}

/**
 * Amplia k× (k inteiro ≥ 1) com interpolação bilinear.
 * Igual a `cv2.resize(src, (W*k, H*k), interpolation=cv2.INTER_LINEAR)` em float32.
 */
export function resizeBilinear(img: GrayImage, k: number): GrayImage {
  return resize(img, k, false);
}

// =====================================================================
// Borrão gaussiano (cv2.GaussianBlur(src, (0, 0), sigma))
// =====================================================================

/**
 * Metade direita do kernel gaussiano do OpenCV para imagens float: `half[0]` é o centro e
 * `half[j]` vale para os dois vizinhos a j px. O tamanho sai do sigma: `round(8·sigma + 1) | 1`
 * (para uint8 o OpenCV usa 6·sigma; aqui é sempre o caso float). Soma normalizada para 1 em
 * double e só então arredondada para float32, como em getGaussianKernel.
 */
function gaussianHalfKernel(sigma: number): Float64Array {
  const n = Math.round(sigma * 8 + 1) | 1;
  const r = (n - 1) >> 1;
  const scale = -0.125 / (sigma * sigma); // x abaixo vem dobrado (2·distância), daí −0,125 e não −0,5
  const vals = new Float64Array(r);
  let sum = 0;
  for (let i = 0, x = 1 - n; i < r; i++, x += 2) {
    vals[i] = Math.exp(x * x * scale);
    sum += vals[i];
  }
  const mul = 1 / (2 * sum + 1);
  const half = new Float64Array(r + 1);
  half[0] = fr(mul);
  for (let i = 0; i < r; i++) half[r - i] = fr(vals[i] * mul);
  return half;
}

/** Índice espelhado sem repetir a borda (BORDER_REFLECT_101, o padrão do OpenCV): `cba|abcd|cba`. */
function reflect101(p: number, len: number): number {
  if (len === 1) return 0;
  while (p < 0 || p >= len) p = p < 0 ? -p : 2 * len - 2 - p;
  return p;
}

/**
 * Borrão gaussiano separável. Igual a `cv2.GaussianBlur(src, (0, 0), sigma)` em float32:
 * tamanho do kernel tirado do sigma e borda espelhada (BORDER_REFLECT_101).
 */
export function gaussianBlur(img: GrayImage, sigma: number): GrayImage {
  if (!(sigma > 0) || !Number.isFinite(sigma)) throw new RangeError(`sigma inválido: ${sigma}`);
  const { width: W, height: H, data: src } = img;
  const out = new Float32Array(W * H);
  if (W === 0 || H === 0) return gray(W, H, out);
  const half = gaussianHalfKernel(sigma);
  const r = half.length - 1;
  // como no OpenCV: uma dimensão com 1 px não é filtrada (o kernel dela vira 1)
  const doX = r > 0 && W > 1;
  const doY = r > 0 && H > 1;
  if (!doX && !doY) {
    out.set(src.subarray(0, W * H));
    return gray(W, H, out);
  }
  const k0 = half[0];

  // horizontal: a linha é copiada para `pad` com as bordas já espelhadas, e o laço não testa limites
  const pad = new Float32Array(W + 2 * r);
  const left = new Int32Array(r);
  const right = new Int32Array(r);
  for (let j = 0; j < r; j++) {
    left[j] = reflect101(j - r, W);
    right[j] = reflect101(W + j, W);
  }
  const filterRow = (y: number, dst: Float32Array, o: number): void => {
    const so = y * W;
    if (!doX) {
      dst[o] = src[so];
      return;
    }
    for (let j = 0; j < r; j++) {
      pad[j] = src[so + left[j]];
      pad[r + W + j] = src[so + right[j]];
    }
    pad.set(src.subarray(so, so + W), r);
    for (let x = 0; x < W; x++) {
      const c = x + r;
      let acc = k0 * pad[c];
      for (let j = 1; j <= r; j++) acc += half[j] * (pad[c - j] + pad[c + j]);
      dst[o + x] = acc;
    }
  };

  if (!doY) {
    for (let y = 0; y < H; y++) filterRow(y, out, y * W);
    return gray(W, H, out);
  }

  // vertical: só as últimas linhas filtradas na horizontal ficam guardadas (anel), não a imagem toda
  const n = 2 * r + 1;
  const cap = Math.min(n, H);
  const ring = new Float32Array(cap * W);
  const acc = new Float64Array(W);
  let next = 0; // próxima linha da origem a filtrar na horizontal
  for (let y = 0; y < H; y++) {
    const need = Math.min(H - 1, y + r);
    while (next <= need) {
      filterRow(next, ring, (next % cap) * W);
      next++;
    }
    const c = (y % cap) * W;
    for (let x = 0; x < W; x++) acc[x] = k0 * ring[c + x];
    for (let j = 1; j < r; j++) {
      const a = (reflect101(y - j, H) % cap) * W;
      const b = (reflect101(y + j, H) % cap) * W;
      const kj = half[j];
      for (let x = 0; x < W; x++) acc[x] += kj * (ring[a + x] + ring[b + x]);
    }
    const a = (reflect101(y - r, H) % cap) * W;
    const b = (reflect101(y + r, H) % cap) * W;
    const kr = half[r];
    const oo = y * W;
    for (let x = 0; x < W; x++) out[oo + x] = acc[x] + kr * (ring[a + x] + ring[b + x]);
  }
  return gray(W, H, out);
}

// =====================================================================
// Erosão e dilatação com elemento elíptico (cv2.erode / cv2.dilate)
// =====================================================================

/**
 * Linhas do elemento `cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))`: para cada linha
 * i, o trecho de colunas [lo[i], hi[i]] em relação à âncora (size/2, size/2, divisão inteira).
 * Não é um disco "de livro": para 7 as larguras são 1, 5, 7, 7, 7, 5, 1 e, para tamanho par, a
 * âncora fica deslocada (sobra uma linha/coluna a mais para cima e para a esquerda).
 */
export function ellipseKernelRows(size: number): { lo: Int32Array; hi: Int32Array } {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`tamanho de kernel inválido: ${size}`);
  const lo = new Int32Array(size);
  const hi = new Int32Array(size);
  const r = size >> 1;
  const invR2 = r ? 1 / (r * r) : 0;
  for (let i = 0; i < size; i++) {
    const dy = i - r;
    const dx = Math.round(r * Math.sqrt((r * r - dy * dy) * invR2));
    lo[i] = Math.max(r - dx, 0) - r;
    hi[i] = Math.min(r + dx + 1, size) - 1 - r;
  }
  return { lo, hi };
}

/**
 * Erosão (sign = 1) ou dilatação (sign = −1, feita como mínimo da imagem negada).
 * Fora da imagem não conta (é o BORDER_CONSTANT com o valor padrão do OpenCV: +∞ na erosão,
 * −∞ na dilatação). Por linha do kernel: mínimo corrido horizontal (van Herk, custo fixo por
 * pixel) e depois o mínimo entre as linhas, com um anel das últimas `size` linhas.
 */
function morph(img: GrayImage, size: number, sign: 1 | -1): GrayImage {
  const { lo, hi } = ellipseKernelRows(size);
  const { width: W, height: H, data: src } = img;
  const out = new Float32Array(W * H);
  if (W === 0 || H === 0) return gray(W, H, out);
  if (size === 1) {
    out.set(src.subarray(0, W * H));
    return gray(W, H, out);
  }
  const r = size >> 1;

  // janelas horizontais distintas (várias linhas do kernel têm a mesma largura)
  const winLo: number[] = [];
  const winHi: number[] = [];
  const winOf = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    let w = 0;
    while (w < winLo.length && (winLo[w] !== lo[i] || winHi[w] !== hi[i])) w++;
    if (w === winLo.length) {
      winLo.push(lo[i]);
      winHi.push(hi[i]);
    }
    winOf[i] = w;
  }
  const nWin = winLo.length;
  let padL = 0;
  let padR = 0;
  for (let w = 0; w < nWin; w++) {
    padL = Math.max(padL, -winLo[w]);
    padR = Math.max(padR, winHi[w]);
  }

  const cap = Math.min(size, H);
  const rings: Float32Array[] = [];
  for (let w = 0; w < nWin; w++) rings.push(new Float32Array(cap * W));
  const pad = new Float32Array(padL + W + padR).fill(Infinity);
  const g = new Float32Array(W + padL + padR);
  const h = new Float32Array(W + padL + padR);

  /** Mínimos corridos da linha y da origem, um por janela, gravados na posição `slot` dos anéis. */
  const filterRow = (y: number, slot: number): void => {
    const so = y * W;
    if (sign > 0) pad.set(src.subarray(so, so + W), padL);
    else for (let x = 0; x < W; x++) pad[padL + x] = -src[so + x];
    for (let w = 0; w < nWin; w++) {
      const dst = rings[w];
      const o = slot * W;
      const width = winHi[w] - winLo[w] + 1;
      const base = padL + winLo[w]; // a janela do pixel x cobre pad[base + x .. base + x + width − 1]
      if (width === 1) {
        dst.set(pad.subarray(base, base + W), o);
        continue;
      }
      // van Herk: em blocos de `width`, g = mínimo do começo do bloco até i; h = de i até o fim do bloco
      const len = W + width - 1;
      for (let b0 = 0; b0 < len; b0 += width) {
        const b1 = Math.min(b0 + width, len);
        let m = Infinity;
        for (let i = b0; i < b1; i++) {
          const v = pad[base + i];
          if (v < m) m = v;
          g[i] = m;
        }
        m = Infinity;
        for (let i = b1 - 1; i >= b0; i--) {
          const v = pad[base + i];
          if (v < m) m = v;
          h[i] = m;
        }
      }
      for (let x = 0; x < W; x++) {
        const a = h[x];
        const b = g[x + width - 1];
        dst[o + x] = a < b ? a : b;
      }
    }
  };

  let next = 0; // próxima linha da origem a filtrar
  for (let y = 0; y < H; y++) {
    const need = Math.min(H - 1, y + size - 1 - r);
    while (next <= need) {
      filterRow(next, next % cap);
      next++;
    }
    const oo = y * W;
    let first = true;
    for (let i = 0; i < size; i++) {
      const sy = y + i - r;
      if (sy < 0 || sy >= H) continue;
      const buf = rings[winOf[i]];
      const o = (sy % cap) * W;
      if (first) {
        out.set(buf.subarray(o, o + W), oo);
        first = false;
      } else {
        for (let x = 0; x < W; x++) {
          const v = buf[o + x];
          if (v < out[oo + x]) out[oo + x] = v;
        }
      }
    }
    if (sign < 0) for (let x = 0; x < W; x++) out[oo + x] = -out[oo + x];
  }
  return gray(W, H, out);
}

/**
 * Erosão (mínimo local) com elemento elíptico. Igual a
 * `cv2.erode(src, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))` em float32.
 */
export function erodeEllipse(img: GrayImage, size: number): GrayImage {
  return morph(img, size, 1);
}

/**
 * Dilatação (máximo local) com elemento elíptico. Igual a
 * `cv2.dilate(src, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))` em float32.
 */
export function dilateEllipse(img: GrayImage, size: number): GrayImage {
  return morph(img, size, -1);
}

// =====================================================================
// Percentil (np.percentile, método linear)
// =====================================================================

/** Deixa em a[k] o k-ésimo menor valor, com os menores à esquerda e os maiores à direita. */
function selectKth(a: Float32Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >>> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break; // a[k] já é o pivô
  }
  return a[k];
}

/**
 * Percentil p (0..100) com interpolação linear entre os dois valores vizinhos da lista ordenada.
 * Igual a `np.percentile(data, [p])[0]` (a forma com lista, em float64, que é a que o campo de
 * tinta usa). Não altera `data` e não ordena tudo: seleciona só os dois valores necessários.
 * Os dados não podem ter NaN.
 */
export function percentile(data: Float32Array, p: number): number {
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentil fora de 0..100: ${p}`);
  const n = data.length;
  if (n === 0) return NaN;
  const a = data.slice();
  const vi = (n - 1) * (p / 100); // posição "virtual" na lista ordenada
  if (vi >= n - 1) return selectKth(a, n - 1);
  const i = Math.floor(vi);
  const t = vi - i;
  const lower = selectKth(a, i);
  let upper = a[i + 1]; // depois da seleção, tudo à direita de i é ≥ a[i]: o próximo é o mínimo de lá
  for (let j = i + 2; j < n; j++) if (a[j] < upper) upper = a[j];
  // mesma conta do _lerp do NumPy: a diferença sai em float32 e o lado depende de t
  const diff = fr(upper - lower);
  return t >= 0.5 ? upper - diff * (1 - t) : lower + diff * t;
}
