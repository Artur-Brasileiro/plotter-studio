/**
 * Ilustração colorida (pintura, desenho colorido, render) → desenho de LINHAS limpo + mapa de tons liso.
 * Port de lab/python/illus.py (testes de paridade em illus.test.ts).
 *
 * Os modos de traço supõem que a imagem JÁ é um desenho de linhas. Numa pintura, mancha escura não é
 * linha (o esqueleto dela vira "estrela") e textura não é desenho (cada grão vira um rabisco). Aqui a
 * imagem é redesenhada antes de ser traçada:
 *
 *  1. apaga a textura e guarda as bordas das formas (rolling guidance com filtro guiado);
 *  2. acha a direção das bordas (tensor de estrutura alisado);
 *  3. diferença de gaussianas ATRAVESSANDO a borda e média AO LONGO dela (FDoG, Kang et al. 2007):
 *     dá uma linha do lado escuro de cada borda, contínua e sem chuvisco;
 *  4. histerese: fica a linha forte e a fraca que está ligada a uma forte;
 *  5. cada linha é normalizada pela própria altura, para o traçador achar o centro dela.
 *
 * O resultado é uma imagem em tons de cinza com linhas escuras: dali em diante vale o mesmo traçador
 * do desenho de traço (campo de tinta → esqueleto → traços → curvas).
 *
 * Tudo puro (sem DOM). As contas do meio são em double; o que passa de uma etapa para a outra é float32.
 */
import { dilateEllipse, gaussianBlur, percentile } from "./raster";
import { gray, type GrayImage } from "./types";

const fr = Math.fround;

/** Imagem colorida em três planos, 0..1. `mono` = os três são iguais (veio de uma imagem em cinza). */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly mono?: boolean;
}

/** Direção das bordas: tangente unitária por pixel. O sentido não importa (t e −t são a mesma borda). */
export interface Flow {
  readonly tx: Float32Array;
  readonly ty: Float32Array;
}

// Histerese (resposta da diferença de gaussianas, em luminância 0..1). O limiar forte acompanha a imagem:
// uma fração da resposta das linhas mais fortes DELA, entre um piso e um teto. Assim uma aquarela clara
// também ganha linhas, e uma imagem contrastada não perde as formas de contraste médio.
const CANDIDATE = 0.004; // abaixo disto nem entra na conta (papel, grão)
const HI_PERCENTILE = 97; // "as linhas mais fortes": percentil das candidatas
const HI_FRACTION = 0.625;
const HI_MIN = 0.012;
const HI_MAX = 0.047;
const LO_RATIO = 0.19; // limiar fraco = esta fração do forte...
const LO_MIN = 0.003; // ...mas nunca menos que isto
/** Peso da resposta dos canais de cor em relação à da luminância */
const COLOR_WEIGHT = 0.8;
// Nível de detalhe 0, 0,25, 0,5, 0,75 e 1 (px da imagem de trabalho, em que 1 px = 1 largura de caneta)
const DETAIL_PX = [3.0, 2.2, 1.4, 1.0, 0.7];
const SIGMA_E = [1.4, 1.2, 1.0, 0.9, 0.8];
const COHERENCE = [7.0, 6.0, 5.0, 4.0, 3.5];
const MIN_PX = [14.0, 12.0, 10.0, 8.0, 6.0];

export interface LineArtParams {
  /** Tamanho (px) do que é tratado como textura e some */
  readonly detailPx: number;
  /** Largura (px) da diferença de gaussianas: linhas mais juntas que ~2,5× isto se fundem */
  readonly sigmaE: number;
  /** Quanto (px) a resposta é alisada ao longo da borda */
  readonly coherence: number;
  /** Linhas cuja caixa tem diagonal menor que isto (px) somem */
  readonly minPx: number;
  /** Multiplica os limiares da histerese: 0,5 pega linha fraca, 2 só as fortes */
  readonly thresholdScale: number;
}

/** Ajustes do desenho de linhas a partir dos dois controles da tela (0..1). */
export function lineArtParams(detail: number, edge = 0.5): LineArtParams {
  const t = Math.min(1, Math.max(0, detail)) * 4;
  const i = Math.min(3, Math.floor(t));
  const f = t - i;
  const mix = (a: readonly number[]) => a[i] + (a[i + 1] - a[i]) * f;
  return {
    detailPx: mix(DETAIL_PX),
    sigmaE: mix(SIGMA_E),
    coherence: mix(COHERENCE),
    minPx: mix(MIN_PX),
    thresholdScale: Math.pow(2, 1 - 2 * Math.min(1, Math.max(0, edge))),
  };
}

// =====================================================================
// Entrada
// =====================================================================

/** Pixels do navegador (RGBA, 0..255) → três planos 0..1. `invert` = fundo escuro (usa o negativo). */
export function rgbFromRgba(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array, invert = false): RgbImage {
  const n = width * height;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    r[i] = (invert ? 255 - rgba[j] : rgba[j]) / 255;
    g[i] = (invert ? 255 - rgba[j + 1] : rgba[j + 1]) / 255;
    b[i] = (invert ? 255 - rgba[j + 2] : rgba[j + 2]) / 255;
  }
  return { width, height, r, g, b };
}

/**
 * Quanto da imagem é colorido de verdade, de 0 a 1: a fração dos pixels em que o canal mais forte passa
 * do mais fraco em mais de um quarto da escala. Papel amarelado e grafite azulado não contam.
 * A tela usa para sugerir o tipo "Ilustração". Imagem grande é amostrada (~200 mil pixels).
 */
export function colorfulness(rgba: Uint8ClampedArray | Uint8Array): number {
  const n = rgba.length >> 2;
  if (n === 0) return 0;
  const stride = Math.max(1, Math.floor(n / 200_000));
  let seen = 0, vivid = 0;
  for (let i = 0; i < n; i += stride) {
    const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
    const hi = r > g ? (r > b ? r : b) : g > b ? g : b;
    const lo = r < g ? (r < b ? r : b) : g < b ? g : b;
    if (hi - lo > 64) vivid++;
    seen++;
  }
  return vivid / seen;
}

/** Imagem em cinza (0..255) como "cor": os três planos são o mesmo, e os canais de cor não são calculados. */
export function rgbFromGray(img: GrayImage, invert = false): RgbImage {
  const d = new Float32Array(img.data.length);
  for (let i = 0; i < d.length; i++) d[i] = (invert ? 255 - img.data[i] : img.data[i]) / 255;
  return { width: img.width, height: img.height, r: d, g: d, b: d, mono: true };
}

/** Luminância 0..1 (mesmos pesos da conversão para cinza do programa). */
export function luma(rgb: RgbImage): GrayImage {
  const n = rgb.width * rgb.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.299 * rgb.r[i] + 0.587 * rgb.g[i] + 0.114 * rgb.b[i];
  return gray(rgb.width, rgb.height, out);
}

// =====================================================================
// Amostragem e mudança de tamanho
// =====================================================================

/** Amostragem bilinear; fora da imagem vale a borda (coordenada presa). */
function bilinear(data: Float32Array, W: number, H: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > W - 1) x = W - 1;
  if (y < 0) y = 0;
  else if (y > H - 1) y = H - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1 < W ? x0 + 1 : W - 1;
  const y1 = y0 + 1 < H ? y0 + 1 : H - 1;
  const fx = x - x0, fy = y - y0;
  const r0 = y0 * W, r1 = y1 * W;
  return (data[r0 + x0] * (1 - fx) + data[r0 + x1] * fx) * (1 - fy) + (data[r1 + x0] * (1 - fx) + data[r1 + x1] * fx) * fy;
}

/**
 * Muda o tamanho (bilinear, centro de pixel alinhado). Ao reduzir 1,5× ou mais, borra antes, para o
 * detalhe fino não virar serrilhado. É como a imagem chega ao tamanho de trabalho (1 px = 1 caneta).
 */
export function resample(img: GrayImage, width: number, height: number): GrayImage {
  const { width: W, height: H } = img;
  if (!(width >= 1 && height >= 1) || !Number.isInteger(width) || !Number.isInteger(height)) throw new RangeError(`tamanho inválido: ${width} × ${height}`);
  if (width === W && height === H) return gray(W, H, img.data.slice(0, W * H));
  const fx = W / width, fy = H / height;
  const f = Math.max(fx, fy);
  const src = (f >= 1.5 ? gaussianBlur(img, (f - 1) / 2) : img).data;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = (y + 0.5) * fy - 0.5;
    for (let x = 0; x < width; x++) out[y * width + x] = bilinear(src, W, H, (x + 0.5) * fx - 0.5, sy);
  }
  return gray(width, height, out);
}

// =====================================================================
// Apagar a textura (rolling guidance com filtro guiado)
// =====================================================================

/** Índice espelhado sem repetir a borda (BORDER_REFLECT_101, o padrão do OpenCV): `cba|abcd|cba`. */
function reflect101(p: number, len: number): number {
  if (len === 1) return 0;
  while (p < 0 || p >= len) p = p < 0 ? -p : 2 * len - 2 - p;
  return p;
}

/**
 * Média de caixa (2r+1)×(2r+1), borda espelhada. Igual a `cv2.blur(src, (2r+1, 2r+1))` em float64.
 * Separável e com soma corrida: o custo por pixel não depende do raio.
 */
export function boxBlur(src: Float32Array | Float64Array, W: number, H: number, r: number): Float64Array {
  const out = new Float64Array(W * H);
  if (W === 0 || H === 0) return out;
  const n = 2 * r + 1;
  // horizontal
  const tmp = new Float64Array(W * H);
  const padX = new Float64Array(W + 2 * r);
  const mapX = new Int32Array(W + 2 * r);
  for (let j = 0; j < mapX.length; j++) mapX[j] = reflect101(j - r, W);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let j = 0; j < padX.length; j++) padX[j] = src[o + mapX[j]];
    let s = 0;
    for (let j = 0; j < n; j++) s += padX[j];
    tmp[o] = s;
    for (let x = 1; x < W; x++) {
      s += padX[x + n - 1] - padX[x - 1];
      tmp[o + x] = s;
    }
  }
  // vertical: soma corrida das linhas, uma coluna inteira por vez
  const mapY = new Int32Array(H + 2 * r);
  for (let j = 0; j < mapY.length; j++) mapY[j] = reflect101(j - r, H);
  const acc = new Float64Array(W);
  for (let j = 0; j < n; j++) {
    const o = mapY[j] * W;
    for (let x = 0; x < W; x++) acc[x] += tmp[o + x];
  }
  const inv = 1 / (n * n);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    if (y > 0) {
      const add = mapY[y + n - 1] * W, sub = mapY[y - 1] * W;
      for (let x = 0; x < W; x++) acc[x] += tmp[add + x] - tmp[sub + x];
    }
    for (let x = 0; x < W; x++) out[o + x] = acc[x] * inv;
  }
  return out;
}

/**
 * Filtro guiado (He et al. 2010): alisa `src` respeitando as bordas de `guide`.
 * `r` é o raio da janela e `eps`, o quanto de variação ainda conta como "liso" (em 0..1, ao quadrado).
 */
export function guidedFilter(guide: GrayImage, src: GrayImage, r: number, eps: number): GrayImage {
  const { width: W, height: H } = src;
  const n = W * H;
  const g = guide.data, p = src.data;
  const gp = new Float64Array(n), gg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    gp[i] = g[i] * p[i];
    gg[i] = g[i] * g[i];
  }
  const mG = boxBlur(g, W, H, r), mP = boxBlur(p, W, H, r);
  const a = boxBlur(gp, W, H, r); // vira `a` no laço abaixo
  const b = boxBlur(gg, W, H, r); // vira `b`
  for (let i = 0; i < n; i++) {
    const cov = a[i] - mG[i] * mP[i];
    const variance = b[i] - mG[i] * mG[i];
    const ai = cov / (variance + eps);
    a[i] = ai;
    b[i] = mP[i] - ai * mG[i];
  }
  const mA = boxBlur(a, W, H, r), mB = boxBlur(b, W, H, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = mA[i] * g[i] + mB[i];
  return gray(W, H, out);
}

/**
 * Rolling guidance (Zhang et al. 2014) com filtro guiado: some o que é menor que ~sigma (grão, ferrugem,
 * pincelada) e ficam as bordas das formas, no lugar. Começa de um borrão e, a cada volta, o filtro
 * guiado devolve as bordas grandes que o borrão tinha apagado.
 */
export function rollingGuidance(chan: GrayImage, sigma: number, eps = 0.02 ** 2, n = 4): GrayImage {
  if (sigma <= 0.3) return gray(chan.width, chan.height, chan.data.slice(0, chan.width * chan.height));
  const r = Math.max(1, Math.floor(2 * sigma + 0.5));
  let j = gaussianBlur(chan, sigma);
  for (let i = 0; i < n; i++) j = guidedFilter(j, chan, r, eps);
  return j;
}

// =====================================================================
// Direção das bordas e resposta de linha
// =====================================================================

/**
 * Tangente das bordas pelo tensor de estrutura dos canais (gradiente de Scharr), alisado com `sigmaC`.
 * Onde não há borda nenhuma a direção é (1, 0).
 */
export function edgeFlow(chans: readonly GrayImage[], sigmaC: number): Flow {
  const { width: W, height: H } = chans[0];
  const n = W * H;
  const E = new Float32Array(n), F = new Float32Array(n), G = new Float32Array(n);
  const e = new Float64Array(n), f = new Float64Array(n), g = new Float64Array(n);
  for (const c of chans) {
    const d = c.data;
    for (let y = 0; y < H; y++) {
      const ra = reflect101(y - 1, H) * W, rb = y * W, rc = reflect101(y + 1, H) * W;
      for (let x = 0; x < W; x++) {
        const xl = reflect101(x - 1, W), xr = reflect101(x + 1, W);
        const gx = (3 * (d[ra + xr] - d[ra + xl]) + 10 * (d[rb + xr] - d[rb + xl]) + 3 * (d[rc + xr] - d[rc + xl])) / 32;
        const gy = (3 * (d[rc + xl] - d[ra + xl]) + 10 * (d[rc + x] - d[ra + x]) + 3 * (d[rc + xr] - d[ra + xr])) / 32;
        const i = rb + x;
        e[i] += gx * gx;
        f[i] += gx * gy;
        g[i] += gy * gy;
      }
    }
  }
  E.set(e);
  F.set(f);
  G.set(g);
  const Es = gaussianBlur(gray(W, H, E), sigmaC).data;
  const Fs = gaussianBlur(gray(W, H, F), sigmaC).data;
  const Gs = gaussianBlur(gray(W, H, G), sigmaC).data;
  const tx = new Float32Array(n), ty = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ee = Es[i], ff = Fs[i], gg = Gs[i];
    const lam = 0.5 * (ee + gg + Math.sqrt((ee - gg) * (ee - gg) + 4 * ff * ff));
    // Autovetor do MENOR autovalor (a tangente). Há duas fórmulas equivalentes, e cada uma zera num caso:
    // (lam − E, −F) zera na borda exatamente vertical (F = 0, E > G); (−F, lam − G), na exatamente
    // horizontal. Vale a que não zera, senão uma borda reta de arte digital ficaria sem direção.
    const wide = ee >= gg;
    const x = wide ? -ff : lam - ee;
    const y = wide ? lam - gg : -ff;
    const len = Math.sqrt(x * x + y * y);
    if (len < 1e-12) tx[i] = 1;
    else {
      tx[i] = x / len;
      ty[i] = y / len;
    }
  }
  return { tx, ty };
}

/**
 * Diferença de gaussianas de uma dimensão, ATRAVESSANDO a borda (na direção perpendicular à tangente).
 * Negativo = lado escuro de uma borda, ou uma linha escura fina.
 */
export function acrossDog(chan: GrayImage, flow: Flow, sigmaE: number, k = 1.6, rho = 0.99): Float32Array {
  const { width: W, height: H, data } = chan;
  const T = Math.ceil(2.5 * sigmaE * k);
  const w1 = new Float64Array(2 * T + 1), w2 = new Float64Array(2 * T + 1);
  let w1s = 0, w2s = 0;
  for (let d = -T; d <= T; d++) {
    w1[d + T] = Math.exp((-d * d) / (2 * sigmaE * sigmaE));
    w2[d + T] = Math.exp((-d * d) / (2 * (sigmaE * k) * (sigmaE * k)));
    w1s += w1[d + T];
    w2s += w2[d + T];
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const nx = -flow.ty[i], ny = flow.tx[i];
      let a1 = 0, a2 = 0;
      for (let d = -T; d <= T; d++) {
        const v = bilinear(data, W, H, x + d * nx, y + d * ny);
        a1 += w1[d + T] * v;
        a2 += w2[d + T] * v;
      }
      out[i] = a1 / w1s - (rho * a2) / w2s;
    }
  }
  return out;
}

/**
 * Resposta antes de alisar ao longo da borda. `chans[0]` é a luminância; os outros são os canais de cor,
 * que pegam a borda entre duas cores de mesma luminância. Positivo = linha.
 */
export function rawResponse(chans: readonly GrayImage[], flow: Flow, sigmaE: number): Float32Array {
  const out = acrossDog(chans[0], flow, sigmaE);
  for (let i = 0; i < out.length; i++) out[i] = -out[i];
  for (let c = 1; c < chans.length; c++) {
    const h = acrossDog(chans[c], flow, sigmaE);
    for (let i = 0; i < out.length; i++) {
      const v = fr(-COLOR_WEIGHT * h[i]);
      if (v > out[i]) out[i] = v;
    }
  }
  return out;
}

/**
 * Média gaussiana AO LONGO da borda: de cada pixel, segue a tangente nos dois sentidos. Emenda os
 * pedaços de uma mesma linha e apaga o que é grão (que não tem vizinho na direção da borda).
 */
export function alongFlow(a: Float32Array, W: number, H: number, flow: Flow, sigmaM: number): Float32Array {
  const out = new Float32Array(W * H);
  if (!(sigmaM > 0)) {
    out.set(a.subarray(0, W * H));
    return out;
  }
  const { tx, ty } = flow;
  const S = Math.ceil(2 * sigmaM);
  const w = new Float64Array(S + 1);
  let ws = 1;
  for (let s = 1; s <= S; s++) {
    w[s] = Math.exp((-s * s) / (2 * sigmaM * sigmaM));
    ws += 2 * w[s];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let acc: number = a[i];
      for (let sign = 1; sign >= -1; sign -= 2) {
        let px = x, py = y;
        let dx = sign * tx[i], dy = sign * ty[i];
        for (let s = 1; s <= S; s++) {
          px += dx;
          py += dy;
          acc += w[s] * bilinear(a, W, H, px, py);
          // tangente do pixel mais próximo (sem interpolar: entre t e −t a média daria zero)
          let ix = Math.floor(px + 0.5), iy = Math.floor(py + 0.5);
          ix = ix < 0 ? 0 : ix > W - 1 ? W - 1 : ix;
          iy = iy < 0 ? 0 : iy > H - 1 ? H - 1 : iy;
          const j = iy * W + ix;
          const ntx = tx[j], nty = ty[j];
          if (ntx * dx + nty * dy < 0) {
            dx = -ntx;
            dy = -nty;
          } else {
            dx = ntx;
            dy = nty;
          }
        }
      }
      out[i] = acc / ws;
    }
  }
  return out;
}

// =====================================================================
// Histerese e linha normalizada
// =====================================================================

/** Limiares (fraco, forte) da histerese para esta imagem. `scale` é o controle "linhas fracas" (0,5 a 2). */
export function lineThresholds(resp: Float32Array, scale = 1): { lo: number; hi: number } {
  const floor = fr(CANDIDATE); // o NumPy compara em float32
  let n = 0;
  for (let i = 0; i < resp.length; i++) if (resp[i] > floor) n++;
  let ref = 0;
  if (n) {
    const cand = new Float32Array(n);
    for (let i = 0, j = 0; i < resp.length; i++) if (resp[i] > floor) cand[j++] = resp[i];
    ref = percentile(cand, HI_PERCENTILE);
  }
  const hi = Math.min(HI_MAX, Math.max(HI_MIN, HI_FRACTION * ref));
  const lo = Math.max(LO_MIN, LO_RATIO * hi);
  return { lo: lo * scale, hi: hi * scale };
}

/**
 * Histerese: fica o que passa de `hi`, mais o que passa de `lo` e está ligado a ele (vizinhança de 8).
 * Componentes cuja caixa tem diagonal menor que `minPx` somem. Devolve 1 onde fica.
 *
 * Trabalha por trechos horizontais (runs) unidos com union-find, como o cleanMask.
 */
export function hysteresis(resp: Float32Array, W: number, H: number, lo: number, hi: number, minPx = 0): Uint8Array {
  const loF = fr(lo), hiF = fr(hi); // o NumPy compara em float32
  const out = new Uint8Array(W * H);
  let cap = 1024;
  let runStart = new Int32Array(cap), runEnd = new Int32Array(cap), parent = new Int32Array(cap);
  let runStrong = new Uint8Array(cap);
  let nRuns = 0;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  let prevA = 0, prevB = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W, above = row - W;
    const curA = nRuns;
    let p = prevA;
    let x = 0;
    while (x < W) {
      if (!(resp[row + x] > loF)) {
        x++;
        continue;
      }
      const xs = x;
      let strong = 0;
      while (x < W && resp[row + x] > loF) {
        if (resp[row + x] > hiF) strong = 1;
        x++;
      }
      if (nRuns === cap) {
        cap *= 2;
        const grow = (a: Int32Array) => {
          const b = new Int32Array(cap);
          b.set(a);
          return b;
        };
        runStart = grow(runStart);
        runEnd = grow(runEnd);
        parent = grow(parent);
        const s = new Uint8Array(cap);
        s.set(runStrong);
        runStrong = s;
      }
      const id = nRuns++;
      runStart[id] = row + xs;
      runEnd[id] = row + x;
      parent[id] = id;
      runStrong[id] = strong;
      // une com os trechos de cima que encostam, inclusive na diagonal
      while (p < prevB && runEnd[p] - above < xs) p++;
      let q = p;
      while (q < prevB && runStart[q] - above <= x) {
        const ra = find(q), rb = find(id);
        if (ra < rb) parent[rb] = ra;
        else if (rb < ra) parent[ra] = rb;
        q++;
      }
      if (q > p) p = q - 1;
    }
    prevA = curA;
    prevB = nRuns;
  }
  // por componente: tem trecho forte? qual a caixa?
  const strong = new Uint8Array(nRuns);
  const minX = new Int32Array(nRuns).fill(W), maxX = new Int32Array(nRuns).fill(-1);
  const minY = new Int32Array(nRuns).fill(H), maxY = new Int32Array(nRuns).fill(-1);
  for (let i = 0; i < nRuns; i++) {
    const root = find(i);
    if (runStrong[i]) strong[root] = 1;
    const y = Math.floor(runStart[i] / W);
    const x0 = runStart[i] - y * W, x1 = runEnd[i] - 1 - y * W;
    if (x0 < minX[root]) minX[root] = x0;
    if (x1 > maxX[root]) maxX[root] = x1;
    if (y < minY[root]) minY[root] = y;
    if (y > maxY[root]) maxY[root] = y;
  }
  for (let i = 0; i < nRuns; i++) {
    const root = find(i);
    if (!strong[root]) continue;
    if (minPx > 0 && Math.hypot(maxX[root] - minX[root] + 1, maxY[root] - minY[root] + 1) < minPx) continue;
    out.fill(1, runStart[i], runEnd[i]);
  }
  return out;
}

/**
 * 0..1: cada linha dividida pela própria altura. O traçador corta a meia altura e acha o CENTRO da
 * crista, na linha forte e na fraca (a fraca não some nem engorda).
 */
export function ridgeMap(resp: GrayImage, keep: Uint8Array, lo: number, sigmaE: number): Float32Array {
  const size = Math.max(3, Math.floor(4 * sigmaE + 0.5) | 1);
  const peak = gaussianBlur(dilateEllipse(resp, size), sigmaE).data;
  const out = new Float32Array(resp.data.length);
  for (let i = 0; i < out.length; i++) {
    if (!keep[i]) continue;
    const v = resp.data[i] / Math.max(peak[i], lo);
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

// =====================================================================
// Tudo junto
// =====================================================================

export interface LineArt {
  /** O desenho de linhas, pronto para o traçador: 0..255, papel = 255 */
  readonly gray: GrayImage;
  /** Luminância alisada (0..1), sem textura: é dela que sai a hachura das sombras */
  readonly tone: GrayImage;
}

/** Imagem colorida → desenho de linhas. `progress` recebe 0..1 conforme as etapas terminam. */
export function lineArt(rgb: RgbImage, p: LineArtParams, progress: (fraction: number) => void = () => {}): LineArt {
  const { width: W, height: H } = rgb;
  const tone = rollingGuidance(luma(rgb), p.detailPx);
  progress(0.2);
  const color = rgb.mono ? [] : [rgb.r, rgb.g, rgb.b].map((d) => rollingGuidance(gray(W, H, d), p.detailPx));
  progress(0.5);
  const flow = edgeFlow(color.length ? color : [tone], Math.max(1.5, 2 * p.sigmaE));
  const raw = rawResponse([tone, ...color], flow, p.sigmaE);
  progress(0.8);
  const resp = alongFlow(raw, W, H, flow, p.coherence);
  const { lo, hi } = lineThresholds(resp, p.thresholdScale);
  const keep = hysteresis(resp, W, H, lo, hi, p.minPx);
  const v = ridgeMap(gray(W, H, resp), keep, lo, p.sigmaE);
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = 255 * (1 - v[i]);
  progress(1);
  return { gray: gray(W, H, out), tone };
}

/** Fundo com luminância (0..1) abaixo disto é "fundo escuro": planta azul, cena noturna, personagem em fundo chapado. */
export const DARK_BACKGROUND = 0.45;
/** Diferença mínima (luminância 0..1) entre o papel e o preto na conta das sombras */
const MIN_TONE_SPAN = 0.1;

/**
 * O tom do fundo: a mediana de uma faixa em volta da imagem (4% do lado menor, pelo menos 1 px).
 * Devolve na mesma escala da imagem (0..1 ou 0..255).
 */
export function borderMedian(img: GrayImage): number {
  const { width: W, height: H, data } = img;
  if (W === 0 || H === 0) return NaN;
  const b = Math.max(1, Math.floor(0.04 * Math.min(W, H) + 0.5));
  const band: number[] = [];
  for (let y = 0; y < H; y++) {
    const edgeRow = y < b || y >= H - b;
    for (let x = 0; x < W; x++) if (edgeRow || x < b || x >= W - b) band.push(data[y * W + x]);
  }
  return percentile(Float32Array.from(band), 50);
}

/**
 * Tom → 0 (papel) a 1 (preto). O preto é o 1% mais escuro. O papel são os 10% mais claros; mas, se o
 * FUNDO da imagem é escuro, o papel é o fundo: fundo escuro não é sombra, e hachurá-lo cobriria a folha.
 */
export function toneDarkness(tone: GrayImage): Float32Array {
  const lo = percentile(tone.data, 1);
  const background = borderMedian(tone);
  const hi = background < DARK_BACKGROUND ? background : percentile(tone.data, 90);
  // a escala nunca é menor que MIN_TONE_SPAN: numa imagem em que nada é bem mais escuro que o papel
  // (fundo preto, desenho pálido), o grão do fundo não pode virar "sombra"
  const span = Math.max(hi - lo, MIN_TONE_SPAN);
  const out = new Float32Array(tone.data.length);
  for (let i = 0; i < out.length; i++) {
    const d = (hi - tone.data[i]) / span;
    out[i] = d < 0 ? 0 : d > 1 ? 1 : d;
  }
  return out;
}
