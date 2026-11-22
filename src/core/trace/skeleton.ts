/**
 * Da máscara de tinta ao esqueleto: distância até o papel e afinamento até 1 px de largura.
 * Ports de `cv2.distanceTransform(mask, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)` e de
 * `skimage.morphology.skeletonize(mask)` (2-D), usados por `skeleton_strokes` em lab/python/vec.py.
 * Testes de paridade em skeleton.test.ts.
 */
import { mask, type Mask } from "./types";

/** "Sem papel nesta coluna", em px. Cabe exato em float32 mesmo somado à altura da imagem. */
const FAR = 1 << 23;
/** Distância² de uma coluna sem papel: o mesmo valor que o OpenCV usa, (float)UINT_MAX = 2³². */
const FAR_SQ = 4294967296;

/**
 * Para cada pixel de tinta, a distância euclidiana exata (em px) até o centro do pixel de papel
 * mais próximo; 0 no papel. Fora da imagem não conta como papel, igual ao OpenCV. Se a máscara
 * não tiver nenhum papel a distância não existe: sai 65536 em tudo (o "infinito" do OpenCV).
 *
 * Algoritmo exato de Felzenszwalb–Huttenlocher, linear no número de pixels: primeiro a distância
 * vertical em cada coluna, depois, em cada linha, o envelope inferior das parábolas
 * (x − p)² + vertical(p)².
 */
export function distanceTransform(m: Mask): Float32Array {
  const { width: W, height: H, data } = m;
  const out = new Float32Array(W * H);
  if (W === 0 || H === 0) return out;

  // 1) distância vertical até o papel, guardada em `out`: uma varredura para baixo e outra para cima
  for (let x = 0; x < W; x++) out[x] = data[x] !== 0 ? FAR : 0;
  for (let i = W; i < out.length; i++) out[i] = data[i] !== 0 ? out[i - W] + 1 : 0;
  for (let i = out.length - W - 1; i >= 0; i--) {
    const d = out[i + W] + 1;
    if (d < out[i]) out[i] = d;
  }

  // 2) envelope inferior das parábolas, linha a linha
  const f = new Float64Array(W); // distância vertical², por coluna
  const v = new Int32Array(W); // colunas das parábolas que formam o envelope
  const z = new Float64Array(W + 1); // z[k]: a partir de onde a parábola v[k] é a mais baixa
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let ink = false;
    for (let x = 0; x < W; x++) {
      const d = out[o + x];
      if (d !== 0) ink = true;
      f[x] = d >= FAR ? FAR_SQ : d * d;
    }
    if (!ink) continue; // linha só de papel: já está zerada

    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < W; q++) {
      const fq = f[q] + q * q;
      let p = v[k];
      let s = (fq - f[p] - p * p) / (2 * (q - p)); // onde a parábola de q cruza a de p
      while (s <= z[k]) {
        k--;
        p = v[k];
        s = (fq - f[p] - p * p) / (2 * (q - p));
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < W; q++) {
      while (z[k + 1] < q) k++;
      const dx = q - v[k];
      out[o + q] = Math.sqrt(dx * dx + f[v[k]]);
    }
  }
  return out;
}

/**
 * Tabela do afinamento do scikit-image (`_fast_skeletonize` em _skeletonize_various_cy.pyx, v0.26),
 * copiada tal e qual. O índice é a vizinhança de 8 do pixel:
 * 1·NO + 2·N + 4·NE + 8·L + 16·SE + 32·S + 64·SO + 128·O.
 * Valor: 0 = fica; 1 = sai na primeira meia-passada; 2 = sai na segunda; 3 = sai em qualquer uma.
 * Não é o Zhang–Suen "de livro": trocar a tabela dá outro esqueleto e outros traços lá na frente.
 */
// prettier-ignore
const THIN_LUT = new Uint8Array([
  0, 0, 0, 1, 0, 0, 1, 3, 0, 0, 3, 1, 1, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 3, 0, 3, 3,
  0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 2, 2,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 2, 0,
  0, 0, 3, 1, 0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 3, 1, 3, 0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 1, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0,
]);

/**
 * Afina a tinta até sobrar uma linha de 1 px (o esqueleto). Dá exatamente os mesmos pixels que
 * `skimage.morphology.skeletonize(mask)` em 2-D (método padrão, de Zhang, com tabela).
 *
 * Cada passada tem duas metades. Em cada metade, todos os pixels são julgados contra o MESMO
 * estado (o do começo da metade) e só então os condenados saem; repete até uma passada inteira
 * não tirar ninguém. Aqui só os pixels ainda acesos são revisitados (lista compactada a cada
 * metade), em vez de varrer a imagem inteira a cada vez como a referência: o resultado é o mesmo.
 */
export function skeletonize(m: Mask): Mask {
  const { width: W, height: H, data } = m;
  const out = new Uint8Array(W * H);
  if (W === 0 || H === 0) return mask(W, H, out);

  // cópia com 1 px de papel em volta: dispensa testar borda nos vizinhos
  const PW = W + 2;
  const img = new Uint8Array(PW * (H + 2));
  let count = 0;
  for (let y = 0; y < H; y++) {
    const so = y * W;
    const po = (y + 1) * PW + 1;
    for (let x = 0; x < W; x++) {
      if (data[so + x] !== 0) {
        img[po + x] = 1;
        count++;
      }
    }
  }

  const active = new Int32Array(count); // índices (em img) dos pixels ainda acesos
  const doomed = new Int32Array(count); // os que saem no fim da metade atual
  let nActive = 0;
  for (let y = 1; y <= H; y++) {
    const po = y * PW;
    for (let x = 1; x <= W; x++) if (img[po + x] !== 0) active[nActive++] = po + x;
  }

  let removedAny = true;
  while (removedAny) {
    removedAny = false;
    for (let half = 1; half <= 2; half++) {
      let kept = 0;
      let nDoomed = 0;
      for (let a = 0; a < nActive; a++) {
        const i = active[a];
        const up = i - PW;
        const down = i + PW;
        const code =
          THIN_LUT[
            img[up - 1] |
              (img[up] << 1) |
              (img[up + 1] << 2) |
              (img[i + 1] << 3) |
              (img[down + 1] << 4) |
              (img[down] << 5) |
              (img[down - 1] << 6) |
              (img[i - 1] << 7)
          ];
        if (code === 3 || code === half) doomed[nDoomed++] = i;
        else active[kept++] = i;
      }
      for (let d = 0; d < nDoomed; d++) img[doomed[d]] = 0;
      nActive = kept;
      if (nDoomed > 0) removedAny = true;
    }
  }

  for (let a = 0; a < nActive; a++) {
    const i = active[a];
    const y = ((i / PW) | 0) - 1;
    out[y * W + (i - (y + 1) * PW - 1)] = 1;
  }
  return mask(W, H, out);
}
