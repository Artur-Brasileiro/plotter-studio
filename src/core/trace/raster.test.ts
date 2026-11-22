// Paridade com o Python: os valores esperados vêm de rodar OpenCV/NumPy de verdade
// (lab/python/fixtures_raster.py), em imagens sintéticas. Nada aqui é escrito à mão.
import { describe, expect, it } from "vitest";
import blurJson from "./__fixtures__/raster/blur.json?raw";
import { loadCases, maxAbsDiff } from "./__fixtures__/raster/load";
import morphJson from "./__fixtures__/raster/morph.json?raw";
import percentileJson from "./__fixtures__/raster/percentile.json?raw";
import resizeJson from "./__fixtures__/raster/resize.json?raw";
import {
  dilateEllipse,
  ellipseKernelRows,
  erodeEllipse,
  gaussianBlur,
  percentile,
  resizeBicubic,
  resizeBilinear,
} from "./raster";
import { gray, type GrayImage, type Mask } from "./types";

/** Tolerância dos resultados em ponto flutuante, na escala 0..255. */
const TOL = 1e-3;

interface ResizeCase {
  name: string;
  src: GrayImage;
  variants: { k: number; bicubic: GrayImage; bilinear: GrayImage }[];
}
interface BlurCase {
  name: string;
  src: GrayImage;
  variants: { sigma: number; out: GrayImage }[];
}
interface MorphCase {
  name: string;
  src: GrayImage;
  variants: { size: number; kernel: Mask; erode: GrayImage; dilate: GrayImage }[];
}
interface PercentileCase {
  name: string;
  data: GrayImage;
  p: number[];
  expected: number[];
  expectedScalarF32: number[];
}

const resizeCases = await loadCases<ResizeCase>(resizeJson);
const blurCases = await loadCases<BlurCase>(blurJson);
const morphCases = await loadCases<MorphCase>(morphJson);
const percentileCases = await loadCases<PercentileCase>(percentileJson);

describe("resizeBicubic / resizeBilinear = cv2.resize (INTER_CUBIC / INTER_LINEAR)", () => {
  const flat = resizeCases.flatMap((c) => c.variants.map((v) => ({ label: `${c.name} k=${v.k}`, src: c.src, ...v })));

  it.each(flat)("bicúbica: $label", ({ src, k, bicubic }) => {
    const got = resizeBicubic(src, k);
    expect([got.width, got.height]).toEqual([src.width * k, src.height * k]);
    expect(maxAbsDiff(got.data, bicubic.data)).toBeLessThanOrEqual(TOL);
  });

  it.each(flat)("bilinear: $label", ({ src, k, bilinear }) => {
    const got = resizeBilinear(src, k);
    expect([got.width, got.height]).toEqual([src.width * k, src.height * k]);
    expect(maxAbsDiff(got.data, bilinear.data)).toBeLessThanOrEqual(TOL);
  });

  it("k = 1 devolve uma cópia (não o mesmo buffer)", () => {
    const src = resizeCases[0].src;
    for (const fn of [resizeBicubic, resizeBilinear]) {
      const got = fn(src, 1);
      expect(got.data).not.toBe(src.data);
      expect(maxAbsDiff(got.data, src.data)).toBe(0);
    }
  });

  it("os fixtures cobrem k de 1 a 6 e imagens de 1 px de largura/altura", () => {
    expect([...new Set(flat.map((v) => v.k))].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(flat.some((v) => v.src.width === 1)).toBe(true);
    expect(flat.some((v) => v.src.height === 1)).toBe(true);
  });

  // Em largura/altura reais os pesos têm de ser os exatos (iguais a cada k pixels), como no OpenCV
  // com IPP. Com a posição arredondada para float32 (código do OpenCV sem IPP) estas faixas de
  // contraste máximo saem com erro de 0,005 a 0,02, e os casos "faixa" acima falham.
  it("os fixtures incluem largura e altura reais com k que não é potência de 2", () => {
    expect(flat.some((v) => v.src.width >= 700 && (v.k === 3 || v.k === 6))).toBe(true);
    expect(flat.some((v) => v.src.height >= 1200 && v.k === 5)).toBe(true);
  });

  it("recusa fator que não é inteiro ≥ 1", () => {
    const src = gray(2, 2);
    expect(() => resizeBicubic(src, 0)).toThrow(RangeError);
    expect(() => resizeBilinear(src, 1.5)).toThrow(RangeError);
  });
});

describe("gaussianBlur = cv2.GaussianBlur(src, (0, 0), sigma)", () => {
  const flat = blurCases.flatMap((c) => c.variants.map((v) => ({ label: `${c.name} sigma=${v.sigma.toFixed(3)}`, src: c.src, ...v })));

  it.each(flat)("$label", ({ src, sigma, out }) => {
    const before = src.data.slice();
    const got = gaussianBlur(src, sigma);
    expect([got.width, got.height]).toEqual([src.width, src.height]);
    expect(maxAbsDiff(got.data, out.data)).toBeLessThanOrEqual(TOL);
    expect(maxAbsDiff(src.data, before)).toBe(0); // não mexe na entrada
  });

  it("os fixtures incluem imagem menor que o kernel (espelha mais de uma vez)", () => {
    // sigma 7/3 → kernel de 21 px numa imagem de 6×5
    expect(flat.some((v) => v.src.width < 10 && v.src.height < 10 && v.sigma > 2)).toBe(true);
  });

  it("recusa sigma ≤ 0", () => {
    expect(() => gaussianBlur(gray(3, 3), 0)).toThrow(RangeError);
    expect(() => gaussianBlur(gray(3, 3), -1)).toThrow(RangeError);
  });
});

describe("erodeEllipse / dilateEllipse = cv2.erode / cv2.dilate com MORPH_ELLIPSE", () => {
  const flat = morphCases.flatMap((c) => c.variants.map((v) => ({ label: `${c.name} size=${v.size}`, src: c.src, ...v })));

  it.each(flat)("formato do kernel: $label", ({ size, kernel }) => {
    const { lo, hi } = ellipseKernelRows(size);
    const anchor = size >> 1;
    const drawn = new Uint8Array(size * size);
    for (let i = 0; i < size; i++) for (let j = lo[i]; j <= hi[i]; j++) drawn[i * size + anchor + j] = 1;
    expect([...drawn]).toEqual([...kernel.data]);
  });

  it.each(flat)("erosão exata: $label", ({ src, size, erode }) => {
    expect(maxAbsDiff(erodeEllipse(src, size).data, erode.data)).toBe(0);
  });

  it.each(flat)("dilatação exata: $label", ({ src, size, dilate }) => {
    expect(maxAbsDiff(dilateEllipse(src, size).data, dilate.data)).toBe(0);
  });

  it("os fixtures cobrem tamanho par, ímpar e kernel maior que a imagem", () => {
    expect(flat.some((v) => v.size % 2 === 0)).toBe(true);
    expect(flat.some((v) => v.size === 7)).toBe(true); // o padrão do campo de tinta
    expect(flat.some((v) => v.size > v.src.width && v.size > v.src.height)).toBe(true);
  });
});

describe("percentile = np.percentile (linear)", () => {
  it.each(percentileCases)("$name", ({ data, p, expected, expectedScalarF32 }) => {
    const before = data.data.slice();
    // a forma escalar do NumPy faz a conta em float32: difere só pelo arredondamento (~1e-7 relativo)
    const tolF32 = 1e-6 * data.data.reduce((m, v) => Math.max(m, Math.abs(v)), 1);
    for (let i = 0; i < p.length; i++) {
      const got = percentile(data.data, p[i]);
      // forma com lista (float64), a que o campo de tinta usa: mesma conta, mesmo número
      expect(got, `p=${p[i]}`).toBe(expected[i]);
      expect(Math.abs(got - expectedScalarF32[i]), `p=${p[i]} (float32)`).toBeLessThanOrEqual(tolF32);
    }
    expect(maxAbsDiff(data.data, before)).toBe(0); // não reordena a entrada
  });

  it("recusa p fora de 0..100 e devolve NaN para lista vazia", () => {
    expect(() => percentile(new Float32Array([1, 2]), 101)).toThrow(RangeError);
    expect(() => percentile(new Float32Array([1, 2]), -1)).toThrow(RangeError);
    expect(percentile(new Float32Array(0), 50)).toBeNaN();
  });
});
