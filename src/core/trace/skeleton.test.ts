// Paridade com o Python: os valores esperados vêm de rodar OpenCV e scikit-image de verdade
// (lab/python/fixtures_raster.py), em máscaras sintéticas. Nada aqui é escrito à mão.
import { describe, expect, it } from "vitest";
import { countDiff, loadCases, maxAbsDiff, toGray } from "./__fixtures__/raster/load";
import masksJson from "./__fixtures__/raster/masks.json?raw";
import pipelineJson from "./__fixtures__/raster/pipeline.json?raw";
import { cleanMask, fieldToMask, inkField, type InkFieldOptions } from "./inkField";
import { distanceTransform, skeletonize } from "./skeleton";
import type { GrayImage, Mask } from "./types";

/** Tolerância da distância, em px. */
const TOL_PX = 1e-4;

interface PipelineCase {
  name: string;
  k: number;
  opts: InkFieldOptions;
  gray: GrayImage | Mask;
  mask: Mask;
  chainMinArea?: number;
  dt?: GrayImage;
  skeleton?: Mask;
}
interface MaskCase {
  name: string;
  mask: Mask;
  dt?: GrayImage;
  skeleton: Mask;
}
interface Chain extends PipelineCase {
  chainMinArea: number;
  dt: GrayImage;
  skeleton: Mask;
}

const pipeline = await loadCases<PipelineCase>(pipelineJson);
const masks = await loadCases<MaskCase>(masksJson);

// casos da cadeia completa: distância e esqueleto sobre a máscara já limpa (como em skeleton_strokes)
const chains = pipeline.filter((c): c is Chain => c.chainMinArea !== undefined && c.dt !== undefined && c.skeleton !== undefined);
const chainMasks = chains.map((c) => ({ name: `${c.name} (máscara limpa)`, mask: cleanMask(c.mask, c.chainMinArea), dt: c.dt, skeleton: c.skeleton }));
const all: MaskCase[] = [...chainMasks, ...masks];

describe("distanceTransform = cv2.distanceTransform(mask, DIST_L2, DIST_MASK_PRECISE)", () => {
  const withDt = all.filter((c): c is MaskCase & { dt: GrayImage } => c.dt !== undefined);

  it.each(withDt)("$name", ({ mask, dt }) => {
    const before = mask.data.slice();
    const got = distanceTransform(mask);
    expect(got.length).toBe(mask.width * mask.height);
    expect(maxAbsDiff(got, dt.data)).toBeLessThanOrEqual(TOL_PX);
    for (let i = 0; i < got.length; i++) if (mask.data[i] === 0 && got[i] !== 0) throw new Error(`papel com distância ${got[i]} em ${i}`);
    expect(countDiff(mask.data, before)).toBe(0); // não mexe na entrada
  });

  it("os fixtures passam pelos dois caminhos do OpenCV (IPP abaixo de 16384 px, código próprio acima)", () => {
    expect(withDt.some((c) => c.mask.data.length < 16384)).toBe(true);
    expect(withDt.some((c) => c.mask.data.length >= 16384)).toBe(true);
  });
});

describe("skeletonize = skimage.morphology.skeletonize (2-D)", () => {
  it.each(all)("$name", ({ mask, skeleton }) => {
    const before = mask.data.slice();
    const got = skeletonize(mask);
    expect([got.width, got.height]).toEqual([mask.width, mask.height]);
    expect(countDiff(got.data, skeleton.data)).toBe(0);
    expect(countDiff(mask.data, before)).toBe(0); // não mexe na entrada
  });

  it.each(all)("o esqueleto fica dentro da tinta e afinar de novo não muda nada: $name", ({ mask }) => {
    const sk = skeletonize(mask);
    for (let i = 0; i < sk.data.length; i++) if (sk.data[i] !== 0 && mask.data[i] === 0) throw new Error(`esqueleto fora da tinta em ${i}`);
    expect(countDiff(skeletonize(sk).data, sk.data)).toBe(0);
  });

  it("qualquer valor diferente de zero conta como tinta, e a saída é sempre 0/1", () => {
    const { mask, skeleton } = all[0];
    const scaled = { width: mask.width, height: mask.height, data: mask.data.map((v) => v * 200) };
    expect(countDiff(skeletonize(scaled).data, skeleton.data)).toBe(0);
  });
});

describe("cadeia inteira em TypeScript: cinza → campo → máscara → limpeza → distância e esqueleto", () => {
  // Mesma ressalva de inkField.test.ts: exato porque nestes fixtures nenhum pixel tem f ≈ 0.
  it.each(chains)("$name", ({ gray, k, opts, chainMinArea, dt, skeleton }) => {
    const ink = cleanMask(fieldToMask(inkField(toGray(gray), k, opts)), chainMinArea);
    expect(countDiff(skeletonize(ink).data, skeleton.data)).toBe(0);
    expect(maxAbsDiff(distanceTransform(ink), dt.data)).toBeLessThanOrEqual(TOL_PX);
  });

  it("há pelo menos um caso com tinta encostada na borda", () => {
    const touches = chains.some(({ skeleton: s }) => {
      for (let x = 0; x < s.width; x++) if (s.data[x] || s.data[(s.height - 1) * s.width + x]) return true;
      for (let y = 0; y < s.height; y++) if (s.data[y * s.width] || s.data[y * s.width + s.width - 1]) return true;
      return false;
    });
    expect(touches).toBe(true);
  });
});
