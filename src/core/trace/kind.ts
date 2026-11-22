import { backgroundRgb } from "./colors";

/**
 * Que tipo de imagem é esta? Olha a imagem ANTES de qualquer traçado, numa cópia de uns 1000 px de lado, e
 * responde duas coisas que a tela usa para não deixar a pessoa cair no tipo errado:
 *
 *  - É um desenho de linhas (contorno, planta, texto)? Num desenho de linhas quase tudo é fundo liso, e o
 *    que não é fundo é FINO: some se for desbastado em poucos pixels. Numa pintura, numa foto ou num render,
 *    o que não é fundo é largo. Desenho de linhas vai para o tipo Traço (ou Preto e branco, se tiver área
 *    cheia); no tipo Ilustração ele é reduzido e alisado, e o texto vira borrão.
 *  - Tem uma grade fraca espalhada pelo fundo (o quadriculado de uma planta)? Se tiver, ela entra no traçado
 *    como centenas de tracinhos e pontos, a não ser que "Linhas claras" desça até ela ficar de fora.
 *
 * Tudo é medido como distância até a cor do fundo (0 = é o fundo, 1 = o mais diferente dele), então vale
 * igual para traço preto em papel branco e para traço branco em planta azul. Puro: sem DOM.
 */
type Pixels = Uint8ClampedArray | Uint8Array;

export interface ImageKind {
  /** Fração da imagem que é fundo liso */
  readonly background: number;
  /** Do que não é fundo, a fração que é fina (some com um desbaste de ~3 px numa imagem de 1000 px) */
  readonly thin: number;
  /** Do que não é fundo, a fração que é área cheia (sobrevive a um desbaste de ~5 px) */
  readonly solid: number;
  /** O quanto a grade do fundo (as linhas mestras dela) se destaca dele, de 0 a 1; 0 se não há grade */
  readonly faintLevel: number;
}

/** Lado maior da cópia em que as medidas são feitas. */
const WORK_SIDE = 1100;
/** A partir desta distância do fundo, o pixel "não é fundo". */
const NOT_BACKGROUND = 0.15;
/** A partir desta, é traço forte (o desenho em si, não a grade). */
const STRONG = 0.4;
/** Uma linha de grade se destaca do fundo pelo menos isto (na cópia reduzida). */
const GRID_MIN = 0.03;
/** ...e ocupa pelo menos esta fração da linha (ou coluna) inteira da imagem. */
const GRID_SPAN = 0.6;
/** Uma grade tem pelo menos estas linhas em CADA direção (duas de cada lado é só uma moldura). */
const GRID_LINES = 4;
/** Uma linha que se destaca mais que isto não é grade: é traço do desenho (a moldura, uma linha de cota). */
const GRID_MAX = 0.33;

/** Mínimo (ou máximo) numa janela quadrada de `size` px (ímpar), separável; a janela é cortada na borda. */
function boxExtreme(src: Float32Array, W: number, H: number, size: number, max: boolean): Float32Array {
  const r = size >> 1;
  // o máximo é o mínimo com o sinal trocado: um laço só, sem chamada de função por pixel
  const sign = max ? -1 : 1;
  const tmp = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = Infinity;
      for (let k = row + (x > r ? x - r : 0), e = row + (x + r < W ? x + r : W - 1); k <= e; k++) {
        const s = sign * src[k];
        if (s < v) v = s;
      }
      tmp[row + x] = v;
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    const y0 = y > r ? y - r : 0, y1 = y + r < H ? y + r : H - 1;
    const row = y * W;
    for (let x = 0; x < W; x++) out[row + x] = tmp[y0 * W + x];
    for (let k = y0 + 1; k <= y1; k++) {
      const other = k * W;
      for (let x = 0; x < W; x++) if (tmp[other + x] < out[row + x]) out[row + x] = tmp[other + x];
    }
    if (max) for (let x = 0; x < W; x++) out[row + x] = -out[row + x];
  }
  return out;
}

export function analyzeImage(rgba: Pixels, width: number, height: number): ImageKind {
  // --- cópia reduzida (média de blocos: uma linha fina vira um tom mais fraco, não some)
  const f = Math.max(1, Math.ceil(Math.max(width, height) / WORK_SIDE));
  const W = Math.max(1, Math.floor(width / f)), H = Math.max(1, Math.floor(height / f));
  const small = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = 4 * ((y * f + dy) * width + x * f);
        for (let dx = 0; dx < f; dx++, i += 4) {
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
        }
      }
      const o = 4 * (y * W + x), n = f * f;
      small[o] = r / n;
      small[o + 1] = g / n;
      small[o + 2] = b / n;
      small[o + 3] = 255;
    }
  }
  // --- distância até a cor do fundo, numa escala só para os três canais
  const bg = backgroundRgb(small, W, H);
  const span = Math.max(bg[0], 255 - bg[0], bg[1], 255 - bg[1], bg[2], 255 - bg[2], 64);
  const N = W * H;
  const d = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) d[i] = Math.min(1, Math.max(Math.abs(small[j] - bg[0]), Math.abs(small[j + 1] - bg[1]), Math.abs(small[j + 2] - bg[2])) / span);

  // os tamanhos das janelas valem para uma imagem de 1000 px de lado: numa menor, encolhem junto
  const scale = Math.max(W, H) / 1000;
  const odd = (px: number) => Math.max(3, Math.round(px * scale) | 1);

  // --- fino ou largo: o que sobra do "não fundo" depois de desbastar
  const mask = new Float32Array(N);
  let area = 0;
  for (let i = 0; i < N; i++) if (d[i] >= NOT_BACKGROUND) (mask[i] = 1), area++;
  const count = (m: Float32Array) => {
    let c = 0;
    for (let i = 0; i < N; i++) if (m[i] > 0.5) c++;
    return c;
  };
  const thin = area ? 1 - count(boxExtreme(mask, W, H, odd(7), false)) / area : 0;
  const solid = area ? count(boxExtreme(mask, W, H, odd(11), false)) / area : 0;

  // --- a grade fraca do fundo. O que só uma grade tem: linhas finas e fracas que ATRAVESSAM a folha, em
  // linhas e colunas inteiras. As linhas fracas do próprio desenho (hachura a lápis) são curtas e ficam de fora.
  // O "chapéu" (d menos a abertura de d) guarda só o que é mais estreito que a janela: um degrau de tom largo
  // (papel mais escuro que a moldura) não entra. Perto do traço forte nada é medido.
  const win = odd(15);
  const open = boxExtreme(boxExtreme(d, W, H, win, false), W, H, win, true);
  const strong = new Float32Array(N);
  for (let i = 0; i < N; i++) if (d[i] >= STRONG) strong[i] = 1;
  const near = boxExtreme(strong, W, H, odd(9), true);
  const isLine = (i: number) => near[i] < 0.5 && d[i] - open[i] >= GRID_MIN;
  const gridRows: number[] = [], gridCols: number[] = [];
  for (let y = 0; y < H; y++) {
    let far = 0, on = 0;
    for (let x = 0, i = y * W; x < W; x++, i++) {
      if (near[i] < 0.5) far++;
      if (isLine(i)) on++;
    }
    if (far >= 0.3 * W && on >= GRID_SPAN * far) gridRows.push(y);
  }
  for (let x = 0; x < W; x++) {
    let far = 0, on = 0;
    for (let y = 0, i = x; y < H; y++, i += W) {
      if (near[i] < 0.5) far++;
      if (isLine(i)) on++;
    }
    if (far >= 0.3 * H && on >= GRID_SPAN * far) gridCols.push(x);
  }
  let faintLevel = 0;
  // linhas vizinhas são a mesma linha (uma linha de 2 px pega duas fileiras da cópia)
  const distinct = (v: number[]) => v.filter((x, k) => k === 0 || x - v[k - 1] > 1).length;
  if (distinct(gridRows) >= GRID_LINES && distinct(gridCols) >= GRID_LINES) {
    // o nível de cada linha da grade, medido na imagem em tamanho real (na cópia reduzida uma linha de 1 px
    // sai mais fraca do que é): a mediana, ao longo da linha, do pixel que mais se destaca na espessura dela.
    // Vale a linha mais forte (as mestras): é ela que "Linhas claras" tem que deixar de fora. Uma linha forte
    // demais para ser grade (a moldura do desenho) não conta.
    const dist = (x: number, y: number) => {
      const o = 4 * (y * width + x);
      return Math.max(Math.abs(rgba[o] - bg[0]), Math.abs(rgba[o + 1] - bg[1]), Math.abs(rgba[o + 2] - bg[2])) / span;
    };
    const median = (v: number[]) => (v.length ? v.sort((a, b) => a - b)[v.length >> 1] : 0);
    const take = (level: number) => {
      if (level <= GRID_MAX) faintLevel = Math.max(faintLevel, level);
    };
    const stepX = Math.max(1, Math.floor(width / 1500)), stepY = Math.max(1, Math.floor(height / 1500));
    for (const y of gridRows) {
      const v: number[] = [];
      for (let x = 0; x < W * f; x += stepX) {
        if (near[y * W + Math.floor(x / f)] > 0.5) continue;
        let m = 0;
        for (let k = 0; k < f; k++) m = Math.max(m, dist(x, y * f + k));
        v.push(m);
      }
      take(median(v));
    }
    for (const x of gridCols) {
      const v: number[] = [];
      for (let y = 0; y < H * f; y += stepY) {
        if (near[Math.floor(y / f) * W + x] > 0.5) continue;
        let m = 0;
        for (let k = 0; k < f; k++) m = Math.max(m, dist(x * f + k, y));
        v.push(m);
      }
      take(median(v));
    }
  }
  return { background: 1 - area / N, thin, solid, faintLevel };
}

/**
 * O tipo que combina com um desenho de linhas: Traço, ou Preto e branco quando há área cheia para pintar
 * (um letreiro, um logotipo). Nas outras imagens não há como saber com segurança: nenhuma sugestão.
 * Os limites vêm de dez imagens de teste: os quatro desenhos de linhas ficaram entre 81% e 100% de "fino",
 * e as outras seis (pintura, foto, render, cartaz de áreas cheias), entre 14% e 68%.
 */
export function suggestedMode(k: ImageKind): "line" | "ink" | undefined {
  if (k.background < 0.55 || k.thin < 0.78) return undefined;
  return k.solid >= 0.04 ? "ink" : "line";
}

/**
 * O valor de "Linhas claras" (0 a 1) que deixa de fora uma grade de nível `level`. No campo de tinta
 * (inkField.ts), uma linha fraca só vira traço quando o contraste local dela passa de 102 − 68,8 · linhas
 * claras (em níveis de 0 a 255); o realce de nitidez aumenta o contraste de uma linha fina, e o fator 1,36
 * foi medido numa planta de verdade (grade mestra de nível 0,24: some com linhas claras em 25%).
 * Nunca sobe o valor que a pessoa já usa, e não desce de 0,1 (abaixo disso o próprio desenho começa a sumir).
 */
export function faintForPattern(level: number, current: number): number {
  if (!(level > 0)) return current;
  const needed = (102 - 255 * level * 1.36) / 68.8;
  const stepped = Math.floor(needed / 0.05 + 1e-9) * 0.05;
  return Math.min(current, Math.max(0.1, stepped));
}
