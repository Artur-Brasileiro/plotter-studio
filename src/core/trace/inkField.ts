/**
 * Campo de tinta: da imagem em tons de cinza até a máscara limpa de tinta.
 * Port de `ink_field` e `clean_mask` de lab/python/vec.py (testes de paridade em inkField.test.ts).
 */
import { dilateEllipse, erodeEllipse, gaussianBlur, percentile, resizeBicubic, resizeBilinear } from "./raster";
import { gray, mask, type GrayImage, type Mask } from "./types";

/** Opções do campo de tinta (mesmos nomes e padrões do laboratório). */
export interface InkFieldOptions {
  /** Diâmetro (px da imagem original) da vizinhança que mede o claro e o escuro locais. Padrão 7. */
  win?: number;
  /** Contraste local (claro − escuro) abaixo do qual vale só o limiar global. Padrão 40. */
  cmin?: number;
  /** Contraste local a partir do qual vale só o limiar local. Padrão 90. */
  cmax?: number;
  /** Soma ao limiar: positivo engrossa a tinta, negativo afina. Padrão 0. */
  bias?: number;
  /** Borrão final do campo, em px da imagem original (sigma = blur·k). 0 desliga. Padrão 0,3. */
  blur?: number;
  /** Realce de nitidez antes de tudo (máscara de nitidez com sigma 1). 0 desliga. Padrão 0. */
  sharpen?: number;
}

/**
 * Campo f na resolução k× (k inteiro ≥ 1): há tinta onde f < 0, e o nível zero é a borda sub-pixel.
 *
 * O limiar é local: fica a meio caminho entre o claro e o escuro vizinhos, e cai para um limiar
 * global onde não há contraste. Isso preserva traços finos e vãos finos.
 *
 * Igual a `ink_field(gray, k, denoise=0, ...)` do laboratório. O denoise (NLM) não foi portado
 * de propósito: medido, muda o resultado em menos de 2%.
 */
export function inkField(img: GrayImage, k: number, opts: InkFieldOptions = {}): GrayImage {
  const { win = 7, cmin = 40, cmax = 90, bias = 0, blur = 0.3, sharpen = 0 } = opts;
  const { width: W, height: H } = img;
  const n = W * H;

  let g = img;
  if (sharpen) {
    const soft = gaussianBlur(img, 1.0).data;
    const src = img.data;
    const sharp = new Float32Array(n);
    for (let i = 0; i < n; i++) sharp[i] = src[i] + sharpen * (src[i] - soft[i]);
    g = gray(W, H, sharp);
  }

  // limiar global: meio caminho entre o escuro (1%) e o claro (99%) da imagem inteira
  const tGlobal = (percentile(g.data, 1) + percentile(g.data, 99)) / 2 + bias;

  // limiar local: escuro e claro da vizinhança (erosão/dilatação), suavizados
  const lo = gaussianBlur(erodeEllipse(g, win), win / 3).data;
  const hi = gaussianBlur(dilateEllipse(g, win), win / 3).data;
  const t = lo; // reaproveita o buffer: lo[i] é lido antes de ser sobrescrito
  const span = cmax - cmin;
  for (let i = 0; i < n; i++) {
    const l = lo[i];
    const h = hi[i];
    let w = (h - l - cmin) / span; // 0 = sem contraste (vale o global), 1 = contraste cheio (vale o local)
    w = w < 0 ? 0 : w > 1 ? 1 : w;
    t[i] = w * ((h + l) / 2 + bias) + (1 - w) * tGlobal;
  }

  // imagem em bicúbica menos limiar em bilinear, os dois na resolução k×
  const field = resizeBicubic(g, k);
  subtractInPlace(field.data, resizeBilinear(gray(W, H, t), k).data);
  return blur ? gaussianBlur(field, blur * k) : field;
}

/**
 * a[i] −= b[i]. Fica numa função à parte para o limiar ampliado (uma imagem inteira em k×) não
 * continuar referenciado durante o borrão final: o pico de memória cai de três imagens para duas.
 */
function subtractInPlace(a: Float32Array, b: Float32Array): void {
  for (let i = 0; i < a.length; i++) a[i] -= b[i];
}

/** Máscara de tinta do campo: 1 onde f < 0. */
export function fieldToMask(field: GrayImage): Mask {
  const { width: W, height: H, data: f } = field;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = f[i] < 0 ? 1 : 0;
  return mask(W, H, out);
}

/** Cópia de `a` com capacidade `cap` (as listas de trechos crescem dobrando). */
function grown(a: Int32Array, cap: number) {
  const b = new Int32Array(cap);
  b.set(a);
  return b;
}

/**
 * Remove as manchas pequenas: componentes (vizinhança de 8) com área < minArea, em px da própria
 * máscara. Igual a `clean_mask` do laboratório (cv2.connectedComponentsWithStats).
 *
 * Trabalha por trechos horizontais de tinta (runs) unidos com union-find, então a memória extra
 * é proporcional ao número de trechos, não ao de pixels.
 */
export function cleanMask(m: Mask, minArea: number): Mask {
  const { width: W, height: H, data } = m;
  const out = new Uint8Array(W * H);

  let cap = 1024;
  let runStart = new Int32Array(cap); // índice linear do primeiro pixel do trecho
  let runEnd = new Int32Array(cap); // índice linear logo depois do último
  let parent = new Int32Array(cap);
  let nRuns = 0;

  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  let prevA = 0; // trechos da linha de cima: [prevA, prevB)
  let prevB = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const above = row - W;
    const curA = nRuns;
    let p = prevA;
    let x = 0;
    while (x < W) {
      if (data[row + x] === 0) {
        x++;
        continue;
      }
      const xs = x;
      x++;
      while (x < W && data[row + x] !== 0) x++;
      // trecho [xs, x)
      if (nRuns === cap) {
        cap *= 2;
        runStart = grown(runStart, cap);
        runEnd = grown(runEnd, cap);
        parent = grown(parent, cap);
      }
      const id = nRuns++;
      runStart[id] = row + xs;
      runEnd[id] = row + x;
      parent[id] = id;
      // une com os trechos de cima que encostam, inclusive na diagonal: [a0, a1) toca se a1 ≥ xs e a0 ≤ x
      while (p < prevB && runEnd[p] - above < xs) p++;
      let q = p;
      while (q < prevB && runStart[q] - above <= x) {
        const ra = find(q);
        const rb = find(id);
        if (ra < rb) parent[rb] = ra;
        else if (rb < ra) parent[ra] = rb;
        q++;
      }
      if (q > p) p = q - 1; // o último que encostou pode encostar também no próximo trecho desta linha
    }
    prevA = curA;
    prevB = nRuns;
  }

  const area = new Int32Array(nRuns);
  for (let i = 0; i < nRuns; i++) area[find(i)] += runEnd[i] - runStart[i];
  for (let i = 0; i < nRuns; i++) {
    if (!(area[find(i)] < minArea)) out.fill(1, runStart[i], runEnd[i]);
  }
  return mask(W, H, out);
}
