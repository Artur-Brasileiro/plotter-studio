import { toHex, type Rgb } from "../color";
import { flattenSubPath } from "../geometry/flatten";
import type { Geometry } from "../geometry/path";

/**
 * Camadas de cor: quais cores de caneta a imagem tem, e de que cor é cada traço.
 *
 * Uma "classe" é uma cor de caneta, não uma cor de pixel: os dois tons de amarelo de um desenho são a
 * mesma classe, e o serrilhado entre o vermelho e o preto não vira classe nenhuma. Por isso as cores são
 * agrupadas pelo MATIZ (vermelho, amarelo, verde...), e o que não tem cor, pela claridade (preto, cinza,
 * branco). As contas são no espaço OKLab, em que distância entre cores parece com a que o olho vê.
 *
 * Tudo aqui é puro (sem DOM). O traçador não muda: a cor entra DEPOIS, olhando por onde cada traço passa.
 */
type Pixels = Uint8ClampedArray | Uint8Array;

export interface ColorClass {
  /** Posição na lista da paleta (é o valor que `classify` e `strokeColors` devolvem) */
  readonly id: number;
  /** Nome para a tela: "Preto", "Vermelho"... */
  readonly name: string;
  /** Cor média dos pixels da classe */
  readonly rgb: Rgb;
  /** A mesma cor, como "#rrggbb" */
  readonly color: string;
  /** Fração dos pixels da imagem (as frações somam 1) */
  readonly share: number;
  /** Sem cor: preto, cinza ou branco */
  readonly neutral: boolean;
  /** Claridade média (L do OKLab): 0 = preto, 1 = branco */
  readonly lightness: number;
}

export interface Palette {
  /** Da que ocupa mais pixels para a que ocupa menos */
  readonly classes: readonly ColorClass[];
  /** A classe de uma cor qualquer (a mais próxima, mesmo que a cor não estivesse na imagem) */
  classify(r: number, g: number, b: number): number;
}

const SRGB_LINEAR = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** sRGB (0 a 255) → OKLab (Björn Ottosson, 2020). */
export function oklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const R = SRGB_LINEAR[r], G = SRGB_LINEAR[g], B = SRGB_LINEAR[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Abaixo deste croma a cor é um cinza (o ruído do JPG e o papel amarelado ficam abaixo). */
const NEUTRAL_CHROMA = 0.045;
/** Abaixo desta claridade é preto, tenha o fio de cor que tiver. */
const BLACK_L = 0.2;
/** Uma classe com menos que esta fração dos pixels é sujeira (borda serrilhada, artefato do JPG). */
const MIN_SHARE = 0.002;
/** Dois picos de matiz mais próximos que isto (graus) são a mesma cor. */
const MIN_HUE_GAP = 25;
/**
 * Entre isto e MIN_HUE_GAP, dois picos só são cores diferentes se houver um vale fundo entre eles (senão é
 * uma cor só, larga). Mais longe que isto são cores diferentes de qualquer jeito: uma plantinha verde ao
 * lado de um robô amarelo enorme é um degrau na cauda do amarelo, não um pico isolado.
 */
const FAR_HUE_GAP = 45;
/** Centros das três classes sem cor, pela claridade: preto, cinza, branco. */
const NEUTRAL_L = [0.15, 0.6, 0.95] as const;
const NEUTRAL_NAME = ["Preto", "Cinza", "Branco"] as const;
const BIN = 5; // graus por caixa do histograma de matiz
const BINS = 360 / BIN;

const hueOf = (a: number, b: number) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const hueDist = (h1: number, h2: number) => {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
};
const isChromatic = (L: number, C: number) => C >= NEUTRAL_CHROMA && L >= BLACK_L && !(L > 0.95 && C < 0.08);

/** Nome de uma cor pelo matiz (graus no OKLab) e pela claridade. */
function hueName(h: number, L: number): string {
  if (h < 12 || h >= 338) return "Rosa";
  if (h < 40) return "Vermelho";
  if (h < 75) return L < 0.56 ? "Marrom" : "Laranja";
  if (h < 118) return "Amarelo";
  if (h < 170) return "Verde";
  if (h < 225) return "Verde-água";
  if (h < 285) return "Azul";
  if (h < 320) return "Roxo";
  return "Rosa-forte";
}

/**
 * As cores de caneta da imagem. O preto, o cinza e o branco saem da claridade; as cores, dos picos do
 * histograma de matiz (um desenho com amarelo e amarelo-escuro tem um pico só). Classe que ocupa menos de
 * 0,2% da imagem não entra.
 */
export function findPalette(rgba: Pixels, width: number, height: number): Palette {
  const n = width * height;
  const stride = Math.max(1, Math.floor(n / 250_000));
  // --- 1ª passada: histograma de matiz dos pixels com cor
  const hist = new Float64Array(BINS);
  for (let i = 0; i < n; i += stride) {
    const c = oklab(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
    const C = Math.hypot(c.a, c.b);
    if (isChromatic(c.L, C)) hist[Math.min(BINS - 1, Math.floor(hueOf(c.a, c.b) / BIN))] += C;
  }
  const smooth = new Float64Array(BINS);
  const K = [1, 2, 3, 2, 1];
  for (let i = 0; i < BINS; i++) for (let k = -2; k <= 2; k++) smooth[i] += hist[(i + k + BINS) % BINS] * K[k + 2];
  const at = (i: number) => smooth[(i + BINS) % BINS];
  const candidates: number[] = [];
  for (let i = 0; i < BINS; i++) if (smooth[i] > 0 && smooth[i] >= at(i - 1) && smooth[i] > at(i + 1)) candidates.push(i);
  candidates.sort((p, q) => smooth[q] - smooth[p]);
  /** O ponto mais baixo do histograma no caminho mais curto entre duas caixas. */
  const valley = (i: number, j: number) => {
    const fwd = (j - i + BINS) % BINS;
    const step = fwd <= BINS / 2 ? 1 : -1;
    let low = Infinity;
    for (let k = i; k !== j; k = (k + step + BINS) % BINS) low = Math.min(low, smooth[k]);
    return Math.min(low, smooth[j]);
  };
  let peaks: number[] = []; // matiz (graus) do centro de cada pico aceito
  const peakBins: number[] = [];
  for (const i of candidates) {
    const far = peakBins.every((j) => {
      const d = hueDist(i * BIN, j * BIN);
      return d >= FAR_HUE_GAP || (d >= MIN_HUE_GAP && valley(i, j) < 0.5 * Math.min(smooth[i], smooth[j]));
    });
    if (far && peakBins.length < 8) peakBins.push(i);
  }
  peaks = peakBins.map((i) => i * BIN + BIN / 2);
  /**
   * De qual pico é cada caixa de matiz. A divisa entre dois picos vizinhos fica no VALE entre eles (o ponto
   * mais baixo do histograma), não no meio do caminho: a cauda de uma cor enorme continua sendo dela.
   */
  const peakOfBin = new Int8Array(BINS);
  const assignBins = () => {
    const bins = peaks.map((h) => Math.floor(h / BIN)).map((b, i) => ({ b, i })).sort((p, q) => p.b - q.b);
    if (bins.length <= 1) return peakOfBin.fill(0);
    for (let k = 0; k < bins.length; k++) {
      const from = bins[k], to = bins[(k + 1) % bins.length];
      const span = (to.b - from.b + BINS) % BINS || BINS;
      // o trecho mais baixo entre os dois picos (se houver empate, o meio do trecho empatado)
      let low = Infinity, first = 1, last = 1;
      for (let d = 1; d < span; d++) {
        const v = smooth[(from.b + d) % BINS];
        if (v < low - 1e-12) (low = v), (first = d), (last = d);
        else if (Math.abs(v - low) <= 1e-12 && d === last + 1) last = d;
      }
      const cut = span > 1 ? (first + last) / 2 : 0.5; // as caixas até `cut` ficam com o pico de trás
      for (let d = 0; d < span; d++) peakOfBin[(from.b + d) % BINS] = d <= cut ? from.i : to.i;
    }
    return peakOfBin;
  };
  assignBins();

  // --- classificação: cinzas pela claridade, cores pelo pico de matiz mais próximo
  let neutrals = [0, 1, 2]; // quais das três classes sem cor existem
  const raw = (r: number, g: number, b: number): number => {
    // devolve 0..2 = sem cor (preto, cinza, branco); 3 + i = pico i
    const c = oklab(r, g, b);
    const C = Math.hypot(c.a, c.b);
    if (peaks.length && isChromatic(c.L, C)) return 3 + peakOfBin[Math.min(BINS - 1, Math.floor(hueOf(c.a, c.b) / BIN))];
    if (!neutrals.length) return 3; // só há cores: vai para a maior
    let best = neutrals[0], bd = Infinity;
    for (const k of neutrals) {
      const d = Math.abs(c.L - NEUTRAL_L[k]);
      if (d < bd) (bd = d), (best = k);
    }
    return best;
  };
  const count = (): Float64Array => {
    const c = new Float64Array(3 + peaks.length);
    for (let i = 0; i < n; i += stride) c[raw(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2])]++;
    return c;
  };
  // tira as classes que ocupam quase nada, uma rodada de cada vez (os pixels delas vão para a vizinha)
  const total = Math.ceil(n / stride);
  for (let round = 0; round < 12; round++) {
    const c = count();
    let worst = -1;
    for (let k = 0; k < c.length; k++) {
      const exists = k < 3 ? neutrals.includes(k) : true;
      if (exists && c[k] / total < MIN_SHARE && (worst < 0 || c[k] < c[worst])) worst = k;
    }
    if (worst < 0 || neutrals.length + peaks.length <= 1) break;
    if (worst < 3) neutrals = neutrals.filter((k) => k !== worst);
    else {
      peaks = peaks.filter((_, i) => i !== worst - 3);
      assignBins();
    }
  }

  // --- 2ª passada: fatia e cor média de cada classe que ficou
  const size = 3 + peaks.length;
  // a cor de uma classe com cor puxa para os pixels mais vivos dela (peso = croma²): num robô amarelo
  // enferrujado, a amostra sai amarela, não cor de ferrugem
  const cnt = new Float64Array(size), sw = new Float64Array(size), sr = new Float64Array(size), sg = new Float64Array(size), sb = new Float64Array(size), sL = new Float64Array(size);
  for (let i = 0; i < n; i += stride) {
    const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
    const k = raw(r, g, b);
    const c = oklab(r, g, b);
    const w = k < 3 ? 1 : c.a * c.a + c.b * c.b + 1e-9;
    cnt[k]++;
    sw[k] += w;
    sr[k] += r * w;
    sg[k] += g * w;
    sb[k] += b * w;
    sL[k] += c.L;
  }
  const order = [...Array(size).keys()].filter((k) => cnt[k] > 0).sort((p, q) => cnt[q] - cnt[p]);
  const idOf = new Int32Array(size).fill(-1);
  const classes: ColorClass[] = order.map((k, id) => {
    idOf[k] = id;
    const rgb: Rgb = [Math.round(sr[k] / sw[k]), Math.round(sg[k] / sw[k]), Math.round(sb[k] / sw[k])];
    const lightness = sL[k] / cnt[k];
    const mean = oklab(rgb[0], rgb[1], rgb[2]);
    return {
      id,
      name: k < 3 ? NEUTRAL_NAME[k] : hueName(hueOf(mean.a, mean.b), mean.L),
      rgb,
      color: toHex(rgb[0], rgb[1], rgb[2]),
      share: cnt[k] / total,
      neutral: k < 3,
      lightness,
    };
  });
  // duas cores com o mesmo nome (dois verdes): a mais clara vira "-claro" e a mais escura, "-escuro"
  const sameName = new Map<string, number[]>();
  classes.forEach((c, i) => sameName.set(c.name, [...(sameName.get(c.name) ?? []), i]));
  for (const [name, ids] of sameName) {
    if (ids.length < 2) continue;
    ids.sort((p, q) => classes[q].lightness - classes[p].lightness);
    ids.forEach((i, k) => {
      const suffix = ids.length === 2 ? (k === 0 ? "-claro" : "-escuro") : ` ${k + 1}`;
      classes[i] = { ...classes[i], name: name + suffix };
    });
  }
  // uma cor que não apareceu na amostra cai na classe mais próxima que existe
  const fallback = classes.length ? 0 : -1;
  const cache = new Int8Array(1 << 18).fill(-1);
  const classify = (r: number, g: number, b: number): number => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let id = cache[key];
    if (id < 0) {
      const k = raw(((r >> 2) << 2) | 2, ((g >> 2) << 2) | 2, ((b >> 2) << 2) | 2);
      id = idOf[k] >= 0 ? idOf[k] : fallback;
      cache[key] = id;
    }
    return id;
  };
  return { classes, classify };
}

/**
 * A classe que NÃO é desenhada (o papel): desenhando o escuro da imagem, é a mais clara das classes
 * grandes; desenhando o claro (papel preto, planta azul), a mais escura.
 */
export function paperClass(p: Palette, invert: boolean): number {
  const big = p.classes.filter((c) => c.share >= 0.05);
  const pool = big.length ? big : p.classes;
  let best = pool[0];
  for (const c of pool) if (invert ? c.lightness < best.lightness : c.lightness > best.lightness) best = c;
  return best ? best.id : 0;
}

/**
 * A classe de cada traço (uma por subpath): a cor por onde ele mais passa, olhando também os pixels
 * vizinhos (um contorno fica em cima da borda entre a cor e o papel). O papel não vota; um traço que só
 * passa por cima do papel vai para a cor que mais desenha.
 */
export function strokeColors(
  geometry: Geometry,
  rgba: Pixels,
  width: number,
  height: number,
  palette: Palette,
  opts: { paper: number; radiusPx?: number; stepPx?: number },
): Uint8Array {
  const out = new Uint8Array(geometry.subpaths.length);
  const nc = palette.classes.length;
  if (!out.length || !nc) return out;
  const radius = opts.radiusPx ?? 1.5;
  const step = opts.stepPx ?? 1.5;
  const votes = new Float64Array(nc);
  const totals = new Float64Array(nc);
  const pending: number[] = [];
  const lengths = new Float64Array(out.length);
  const vote = (x: number, y: number, weight: number) => {
    const px = Math.min(width - 1, Math.max(0, Math.floor(x)));
    const py = Math.min(height - 1, Math.max(0, Math.floor(y)));
    const i = 4 * (py * width + px);
    votes[palette.classify(rgba[i], rgba[i + 1], rgba[i + 2])] += weight;
  };
  const sample = (x: number, y: number) => {
    vote(x, y, 2);
    vote(x - radius, y, 1);
    vote(x + radius, y, 1);
    vote(x, y - radius, 1);
    vote(x, y + radius, 1);
  };
  geometry.subpaths.forEach((sp, s) => {
    votes.fill(0);
    const pts = flattenSubPath(sp, 0.25).points;
    sample(pts[0].x, pts[0].y);
    let carry = 0; // distância já andada desde a última amostra
    let length = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      const len = Math.hypot(dx, dy);
      length += len;
      let d = step - carry;
      while (d <= len) {
        sample(pts[i - 1].x + (dx * d) / len, pts[i - 1].y + (dy * d) / len);
        d += step;
      }
      carry = len - (d - step);
    }
    lengths[s] = length;
    let best = -1;
    for (let k = 0; k < nc; k++) if (k !== opts.paper && votes[k] > 0 && (best < 0 || votes[k] > votes[best])) best = k;
    if (best < 0) pending.push(s);
    else {
      out[s] = best;
      totals[best] += length;
    }
  });
  if (pending.length) {
    let most = -1;
    for (let k = 0; k < nc; k++) if (k !== opts.paper && totals[k] > 0 && (most < 0 || totals[k] > totals[most])) most = k;
    if (most < 0) most = opts.paper < nc ? opts.paper : 0; // só há papel: fica tudo numa classe
    for (const s of pending) out[s] = most;
  }
  return out;
}

/** Uma camada de cor do desenho: tudo o que uma caneta pode desenhar de uma vez. */
export interface ColorLayer {
  /** Nome estável da camada ("Preto", "Vermelho"): a escolha de caneta da pessoa é guardada por ele */
  readonly key: string;
  readonly name: string;
  /** Cor para a amostra na tela (e para criar uma caneta dessa cor) */
  readonly color: string;
  readonly strokes: number;
  /** Comprimento somado dos traços, na mesma unidade de `lengths` */
  readonly lengthPx: number;
}

/** Uma cor com menos que esta fração do traço não vale uma troca de caneta: vai junto com a maior. */
const MIN_LAYER_SHARE = 0.003;

/**
 * Junta os traços em camadas, uma por cor de caneta. Preto, cinza e branco são a MESMA caneta (a que
 * contrasta com o papel), então viram uma camada só: "Preto" em papel claro, "Branco" em papel escuro.
 * Cada cor de verdade é uma camada, menos as que têm quase nenhum traço. `layerOf` diz a camada de cada
 * traço; as camadas vêm da que tem mais traço para a que tem menos.
 */
export function colorLayers(palette: Palette, classOf: ArrayLike<number>, lengths: ArrayLike<number>, paper: number): { layers: ColorLayer[]; layerOf: Uint8Array } {
  const n = classOf.length;
  const layerOf = new Uint8Array(n);
  if (!n) return { layers: [], layerOf };
  const NEUTRAL = -1;
  const groupOf = (cls: number) => (palette.classes[cls]?.neutral ?? true ? NEUTRAL : cls);
  const len = new Map<number, number>(), count = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < n; i++) {
    const g = groupOf(classOf[i]);
    len.set(g, (len.get(g) ?? 0) + lengths[i]);
    count.set(g, (count.get(g) ?? 0) + 1);
    total += lengths[i];
  }
  // a camada que recebe as cores pequenas: a sem cor, se existir; senão, a maior
  const biggest = [...len.keys()].sort((a, b) => len.get(b)! - len.get(a)!)[0];
  const home = len.has(NEUTRAL) ? NEUTRAL : biggest;
  const kept = [...len.keys()].filter((g) => g === home || len.get(g)! >= MIN_LAYER_SHARE * total);
  const target = (g: number) => (kept.includes(g) ? g : home);
  const L = new Map<number, number>(), C = new Map<number, number>();
  // cor da camada sem cor: média das classes que entraram nela, pelo comprimento
  let nr = 0, ng = 0, nb = 0, nw = 0;
  for (let i = 0; i < n; i++) {
    const g = target(groupOf(classOf[i]));
    L.set(g, (L.get(g) ?? 0) + lengths[i]);
    C.set(g, (C.get(g) ?? 0) + 1);
    if (g === NEUTRAL) {
      const c = palette.classes[classOf[i]];
      const w = Math.max(lengths[i], 1e-9);
      if (c) (nr += c.rgb[0] * w), (ng += c.rgb[1] * w), (nb += c.rgb[2] * w), (nw += w);
    }
  }
  const order = [...L.keys()].sort((a, b) => L.get(b)! - L.get(a)! || a - b);
  const paperIsLight = (palette.classes[paper]?.lightness ?? 1) >= 0.5;
  const layers: ColorLayer[] = order.map((g) => {
    if (g === NEUTRAL) {
      const name = paperIsLight ? "Preto" : "Branco";
      return { key: name, name, color: nw > 0 ? toHex(nr / nw, ng / nw, nb / nw) : paperIsLight ? "#000000" : "#ffffff", strokes: C.get(g)!, lengthPx: L.get(g)! };
    }
    const c = palette.classes[g];
    return { key: c.name, name: c.name, color: c.color, strokes: C.get(g)!, lengthPx: L.get(g)! };
  });
  const index = new Map(order.map((g, i) => [g, i]));
  for (let i = 0; i < n; i++) layerOf[i] = index.get(target(groupOf(classOf[i])))!;
  return { layers, layerOf };
}

/** A cor do fundo da imagem: a mediana, canal por canal, de uma moldura de 4% em volta dela. */
export function backgroundRgb(rgba: Pixels, width: number, height: number): Rgb {
  const band = Math.max(1, Math.round(0.04 * Math.min(width, height)));
  const idx: number[] = [];
  const stride = Math.max(1, Math.floor((2 * band * (width + height)) / 40_000));
  let seen = 0;
  for (let y = 0; y < height; y++) {
    const edgeRow = y < band || y >= height - band;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= band && x < width - band) {
        x = width - band - 1; // pula o miolo da linha
        continue;
      }
      if (seen++ % stride === 0) idx.push(4 * (y * width + x));
    }
  }
  const median = (c: number) => {
    const v = Uint8Array.from(idx, (i) => rgba[i + c]).sort();
    return v.length ? v[v.length >> 1] : 255;
  };
  return [median(0), median(1), median(2)];
}

/**
 * Para desenhar o CLARO de uma imagem de fundo escuro: quanto cada pixel se destaca do fundo (0 = é o
 * fundo, 255 = branco). Pela luminância, um vermelho vivo sobre preto valeria um terço do branco e sumiria
 * ao lado dele; aqui vale quase o mesmo, porque o que conta é o canal que mais se afasta do fundo.
 * A escala é uma só para os três canais (a distância do fundo até o branco): uma diferença pequena continua
 * pequena, como na luminância, e a grade fraca de uma planta azul não vira sujeira. Numa imagem em tons de
 * cinza sobre preto, o resultado é a própria luminância.
 */
export function lightOnDark(rgba: Pixels, width: number, height: number, bg: Rgb): Float32Array {
  const out = new Float32Array(width * height);
  const scale = 255 / Math.max(255 - bg[0], 255 - bg[1], 255 - bg[2], 64);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const d = Math.max(Math.abs(rgba[j] - bg[0]), Math.abs(rgba[j + 1] - bg[1]), Math.abs(rgba[j + 2] - bg[2]));
    out[i] = Math.round(Math.min(255, d * scale));
  }
  return out;
}
