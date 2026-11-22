import type { Geometry, Segment, SubPath } from "../geometry/path";
import { findContours, loopArea } from "./contours";
import { fitPolyline, type FitOptions } from "./fit";
import { hatchField } from "./hatch";
import { cleanMask, fieldToMask, inkField } from "./inkField";
import { gaussianBlur, percentile, resizeBicubic } from "./raster";
import { distanceTransform, skeletonize } from "./skeleton";
import { skeletonStrokes } from "./strokes";
import type { GrayImage, Mask, Polyline } from "./types";

/**
 * Imagem → traços de caneta. O método é o do laboratório em Python (lab/python/vec.py):
 * campo de tinta com borda sub-pixel → esqueleto → grafo → traços longos → curvas.
 *
 * Três modos:
 *  - "line":  tudo vira linha única (desenho de traço, planta, texto de contorno);
 *  - "ink":   traço fino vira linha única; área mais larga que a caneta vira contorno + hachura;
 *  - "photo": foto não tem linhas, então o tom vira hachura (mais escuro = mais camadas cruzadas).
 *
 * Tudo aqui é puro (sem DOM): roda igual no navegador, num worker e nos testes.
 * As coordenadas de saída são pixels da imagem original (pixel (0,0) ocupa [0,1]×[0,1]).
 */
export type TraceMode = "line" | "ink" | "photo";

export interface TraceOptions {
  readonly mode: TraceMode;
  /** Tamanho de um pixel da imagem no papel (mm). Com `penMm`, diz a largura da caneta em pixels. */
  readonly mmPerPx: number;
  /** Largura do traço da caneta (mm) */
  readonly penMm: number;
  /** Ampliação interna. Sem valor, é escolhida pelo tamanho da imagem (maior = mais fiel e mais lento). */
  readonly scale?: number;
  /** Mais ou menos tinta: desloca o limiar (−100 a 100; positivo = mais preto) */
  readonly ink: number;
  /** 0 a 1: quanto capturar de linhas claras e apagadas */
  readonly faint: number;
  /** 0 a 1,5: nitidez antes do limiar (separa linhas quase encostadas) */
  readonly sharpen: number;
  /** Manchas com menos que isto (px² da imagem) somem */
  readonly speckPx: number;
  /** Rebarbas do esqueleto mais curtas que isto (px) somem */
  readonly spurPx: number;
  /** 0 a 1: suavização das curvas */
  readonly smooth: number;
  /** Régua: trechos retos viram retas de verdade. Tolerância em px; 0 desliga. */
  readonly straighten: number;
  /** Fundo escuro com linhas claras */
  readonly invert: boolean;
  /** Mantém os pontinhos soltos (cada um é uma descida da caneta) */
  readonly dots: boolean;
  /** Modo "ink": contorna as áreas cheias */
  readonly outline: boolean;
  /** Modo "ink": ângulo (graus) e distância (mm) das linhas da hachura; 0 de distância = sem hachura */
  readonly hatchAngleDeg: number;
  readonly hatchSpacingMm: number;
  /** Modo "ink": segunda hachura, cruzada a 90° */
  readonly hatchCross: boolean;
  /** Hachura mais curta que isto (mm) não vale a descida da caneta (REGRAS_GCODE.md, regra 4) */
  readonly hatchMinMm: number;
  /** Modo "photo": distância entre as linhas de cada direção (mm) */
  readonly photoSpacingMm: number;
  /** Modo "photo": quantas direções de hachura se cruzam no tom mais escuro (1 a 4) */
  readonly photoLevels: number;
  /** Modo "photo": suavização do tom antes de hachurar (mm no papel). Sem isso as manchas saem serrilhadas. */
  readonly photoSmoothMm: number;
}

export const DEFAULT_TRACE: TraceOptions = {
  mode: "line",
  mmPerPx: 0.5,
  penMm: 0.4,
  ink: 0,
  faint: 0.6,
  sharpen: 0.8,
  speckPx: 1,
  spurPx: 1,
  smooth: 0.5,
  straighten: 0.6,
  invert: false,
  dots: true,
  outline: true,
  hatchAngleDeg: 45,
  hatchSpacingMm: 1.5,
  hatchCross: false,
  hatchMinMm: 3,
  photoSpacingMm: 2.2,
  photoLevels: 3,
  photoSmoothMm: 1.2,
};

export interface TraceStats {
  /** Traços de linha única */
  readonly strokes: number;
  /** Pontos (a caneta só encosta) */
  readonly dots: number;
  /** Contornos de áreas cheias */
  readonly outlines: number;
  /** Descidas de hachura (cada uma é um zigue-zague) */
  readonly hatches: number;
  readonly scale: number;
  /** Comprimento total do traço, em px da imagem */
  readonly lengthPx: number;
}

export interface TraceResult {
  readonly geometry: Geometry;
  readonly width: number;
  readonly height: number;
  readonly stats: TraceStats;
}

export type TraceProgress = (fraction: number, label: string) => void;

/** Ampliação interna: mira ~5000 px no lado maior, entre 2× e 6×. */
export function autoScale(width: number, height: number): number {
  return Math.min(6, Math.max(2, Math.round(5000 / Math.max(width, height))));
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

function polylineLength(p: Float64Array, closed: boolean): number {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  if (closed && p.length >= 4) L += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
  return L;
}

/** Ajuste de um traço de linha única: mais fiel nos pequenos (estrelas, janelas), mais liso nos longos. */
function strokeFit(length: number, o: TraceOptions): FitOptions {
  const small = length < 40;
  return {
    tol: 0.18,
    cL: small ? 1.6 : 2.4,
    cdeg: 50,
    gap: small ? 0.8 : 1.1,
    smooth: Math.min(0.55, Math.max(0.2, length / 100)) * (o.smooth / 0.5),
    presmooth: 0.25,
    straighten: o.straighten,
  };
}

function polylineToSubPath(p: Float64Array, k: number): SubPath | undefined {
  if (p.length < 4) return undefined;
  const at = (i: number) => ({ x: (p[2 * i] + 0.5) / k, y: (p[2 * i + 1] + 0.5) / k });
  const segments: Segment[] = [];
  for (let i = 1; i < p.length / 2; i++) segments.push({ kind: "line", to: at(i) });
  return { start: at(0), segments, closed: false };
}

/** Ponto: um traço minúsculo (a caneta encosta e sobe). */
function dotSubPath(x: number, y: number): SubPath {
  return { start: { x, y }, segments: [{ kind: "line", to: { x: x + 0.01, y } }], closed: false };
}

export function traceImage(img: GrayImage, opts: Partial<TraceOptions> = {}, progress: TraceProgress = () => {}): TraceResult {
  const o: TraceOptions = { ...DEFAULT_TRACE, ...opts };
  const { width, height } = img;
  const k = Math.max(1, Math.round(o.scale ?? autoScale(width, height)));

  progress(0.02, "Preparando a imagem");
  let src = img;
  if (o.invert) {
    const d = new Float32Array(img.data.length);
    for (let i = 0; i < d.length; i++) d[i] = 255 - img.data[i];
    src = { width, height, data: d };
  }
  /** Onde há tinta (só os modos de traço precisam; a foto trabalha com o tom). */
  const findInk = (): Mask => {
    progress(0.08, "Achando a tinta");
    const field = inkField(src, k, {
      win: 5,
      cmin: lerp(70, 14, o.faint),
      cmax: lerp(110, 38, o.faint),
      bias: o.ink * 0.6,
      blur: 0.22,
      sharpen: o.sharpen,
    });
    return cleanMask(fieldToMask(field), Math.max(2, o.speckPx * k * k));
  };

  const subpaths: SubPath[] = [];
  let strokes = 0, dots = 0, outlines = 0, hatches = 0, lengthPx = 0;

  /** Linha única de uma máscara (a máscara inteira no modo "line"; só a parte fina no modo "ink"). */
  const centerlines = (m: Mask, from: number, to: number) => {
    progress(from, "Afinando os traços");
    const dist = distanceTransform(m);
    const skel = skeletonize(m);
    progress(from + (to - from) * 0.45, "Seguindo os traços");
    const res = skeletonStrokes(skel, dist, k, { spurPx: o.spurPx });
    progress(from + (to - from) * 0.6, "Ajustando as curvas");
    const total = res.polylines.length;
    res.polylines.forEach((pl: Polyline, i: number) => {
      const len = polylineLength(pl.points, pl.closed);
      const sp = fitPolyline(pl.points, pl.closed, strokeFit(len, o));
      if (sp) {
        subpaths.push(sp);
        strokes++;
        lengthPx += len;
      }
      if (i % 400 === 0) progress(from + (to - from) * (0.6 + (0.4 * i) / Math.max(1, total)), "Ajustando as curvas");
    });
    for (let i = 0; o.dots && i < res.dots.length; i += 2) {
      subpaths.push(dotSubPath(res.dots[i], res.dots[i + 1]));
      dots++;
    }
  };

  if (o.mode === "photo") {
    // --- o tom vira hachura. Cada direção entra em duas meias-camadas (linhas intercaladas), e cada
    // meia-camada aparece quando o tom pede mais tinta do que as anteriores já dão.
    progress(0.1, "Lendo os tons da foto");
    const lo = percentile(src.data, 1);
    const hi = percentile(src.data, 88); // os 12% mais claros viram papel branco
    const gamma = 1.3 * Math.pow(2, -o.ink / 60);
    const kp = Math.min(k, 3);
    const dark = new Float32Array(src.data.length);
    for (let i = 0; i < dark.length; i++) dark[i] = Math.pow(Math.min(1, Math.max(0, (hi - src.data[i]) / Math.max(hi - lo, 1e-6))), gamma);
    const up = resizeBicubic({ width, height, data: dark }, kp);
    const tone = gaussianBlur(up, Math.max(0.6, (o.photoSmoothMm / o.mmPerPx) * kp));
    const penPx = (o.penMm / o.mmPerPx) * kp;
    const s = Math.max((o.photoSpacingMm / o.mmPerPx) * kp, penPx * 1.2);
    const cov = Math.min(0.95, penPx / (2 * s));
    const dirs = Math.min(4, Math.max(1, Math.round(o.photoLevels)));
    const angles = [0, 90, 45, 135].slice(0, dirs).map((a) => o.hatchAngleDeg + a);
    const minLength = (o.hatchMinMm / o.mmPerPx) * kp;
    let acc = 0;
    let layer = 0;
    for (const angleDeg of angles) {
      for (const offset of [0, s]) {
        const before = acc;
        acc = acc + (1 - acc) * cov;
        const thr = (before + acc) / 2;
        progress(0.2 + (0.75 * layer++) / (2 * angles.length), "Hachurando os tons");
        for (const z of hatchField(tone.data, tone.width, tone.height, thr, { angleDeg, spacing: 2 * s, offset, link: 0, minLength: penPx })) {
          if (polylineLength(z, false) < minLength) continue;
          const sp = polylineToSubPath(z, kp);
          if (sp) {
            subpaths.push(sp);
            hatches++;
            lengthPx += polylineLength(z, false) / kp;
          }
        }
      }
    }
  } else if (o.mode === "line") {
    centerlines(findInk(), 0.2, 0.98);
  } else {
    const ink = findInk();
    const W = ink.width, H = ink.height;
    // --- separa o grosso do fino pela largura da caneta
    progress(0.2, "Medindo a largura dos traços");
    const r = (o.penMm / o.mmPerPx) * k * 0.5; // raio da ponta, em px ampliados
    const reach = r * 1.35; // área precisa ser ~35% mais larga que a caneta para valer contorno
    const dInk = distanceTransform(ink);
    const notCore = new Uint8Array(W * H);
    let hasCore = false;
    for (let i = 0; i < notCore.length; i++) {
      if (dInk[i] >= reach) hasCore = true;
      else notCore[i] = 1;
    }
    let thin = ink;
    if (hasCore) {
      const toCore = distanceTransform({ width: W, height: H, data: notCore });
      const thick = new Uint8Array(W * H);
      const thinData = new Uint8Array(W * H);
      for (let i = 0; i < thick.length; i++) {
        if (!ink.data[i]) continue;
        if (dInk[i] >= reach || toCore[i] <= reach + 0.5) thick[i] = 1;
        else thinData[i] = 1;
      }
      // sobras nos cantos vivos (onde a ponta redonda não entra) são menores que meia caneta²
      thin = cleanMask({ width: W, height: H, data: thinData }, Math.max(2, 0.5 * (2 * r) * (2 * r)));

      progress(0.32, "Contornando as áreas cheias");
      const dThick = distanceTransform({ width: W, height: H, data: thick });
      if (o.outline) {
        for (const loop of findContours(dThick, W, H, r)) {
          if (Math.abs(loopArea(loop)) < 2 * r * r) continue;
          const pts = new Float64Array(loop.length);
          for (let i = 0; i < loop.length; i++) pts[i] = (loop[i] + 0.5) / k;
          const sp = fitPolyline(pts, true, { tol: 0.13, cL: 2.0, cdeg: 55, gap: 0.9, sharpen: false, straighten: o.straighten });
          if (sp) {
            subpaths.push(sp);
            outlines++;
            lengthPx += polylineLength(pts, true);
          }
        }
      }
      if (o.hatchSpacingMm > 0) {
        progress(0.42, "Hachurando");
        const spacing = (o.hatchSpacingMm / o.mmPerPx) * k;
        const link = Math.max((2 / o.mmPerPx) * k, 1.6 * spacing); // regra 1: ligação curta dentro da hachura
        const angles = o.hatchCross ? [o.hatchAngleDeg, o.hatchAngleDeg + 90] : [o.hatchAngleDeg];
        for (const angleDeg of angles) {
          for (const z of hatchField(dThick, W, H, r, { angleDeg, spacing, link, minLength: r })) {
            // hachura curtinha gasta uma descida do servo e quase não põe tinta: o contorno já resolve
            if ((polylineLength(z, false) / k) * o.mmPerPx < o.hatchMinMm) continue;
            const sp = polylineToSubPath(z, k);
            if (sp) {
              subpaths.push(sp);
              hatches++;
              lengthPx += polylineLength(z, false) / k;
            }
          }
        }
      }
    }
    centerlines(thin, 0.55, 0.98);
  }

  progress(1, "Pronto");
  return { geometry: { subpaths }, width, height, stats: { strokes, dots, outlines, hatches, scale: k, lengthPx } };
}
