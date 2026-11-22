// Paridade com o Python: os valores esperados vêm de rodar lab/python/vec.py de verdade
// (lab/python/fixtures_raster.py), em imagens sintéticas. Nada aqui é escrito à mão.
import { describe, expect, it } from "vitest";
import { countDiff, loadCases, maxAbsDiff, toGray } from "./__fixtures__/raster/load";
import masksJson from "./__fixtures__/raster/masks.json?raw";
import pipelineJson from "./__fixtures__/raster/pipeline.json?raw";
import { cleanMask, fieldToMask, inkField, type InkFieldOptions } from "./inkField";
import { mask, type GrayImage, type Mask } from "./types";

/** Tolerância do campo, na escala 0..255. */
const TOL = 1e-3;

interface CleanStep {
  minArea: number;
  mask: Mask;
}
interface PipelineCase {
  name: string;
  k: number;
  opts: InkFieldOptions;
  gray: GrayImage | Mask; // uint8 (saída de um JPEG) ou float32
  field: GrayImage;
  mask: Mask;
  clean?: CleanStep[];
}
interface MaskCase {
  name: string;
  mask: Mask;
  clean: CleanStep[];
}

const pipeline = await loadCases<PipelineCase>(pipelineJson);
const masks = await loadCases<MaskCase>(masksJson);

describe("inkField = ink_field(gray, k, denoise=0, ...) do laboratório", () => {
  it.each(pipeline)("$name", ({ gray, k, opts, field }) => {
    const src = toGray(gray);
    const before = src.data.slice();
    const got = inkField(src, k, opts);
    expect([got.width, got.height]).toEqual([src.width * k, src.height * k]);
    expect([got.width, got.height]).toEqual([field.width, field.height]);
    expect(maxAbsDiff(got.data, field.data)).toBeLessThanOrEqual(TOL);
    expect(maxAbsDiff(src.data, before)).toBe(0); // não mexe na entrada
  });

  it("os fixtures cobrem k = 1, 2, 3, 4 e 6 e cada opção fora do padrão", () => {
    expect([...new Set(pipeline.map((c) => c.k))].sort()).toEqual([1, 2, 3, 4, 6]);
    const used = new Set(pipeline.flatMap((c) => Object.keys(c.opts)));
    expect([...used].sort()).toEqual(["bias", "blur", "cmax", "cmin", "sharpen", "win"]);
  });

  it("sem opções = padrões do laboratório escritos por extenso", () => {
    const { gray, k } = pipeline[0];
    const src = toGray(gray);
    const explicit = inkField(src, k, { win: 7, cmin: 40, cmax: 90, bias: 0, blur: 0.3, sharpen: 0 });
    expect(maxAbsDiff(inkField(src, k).data, explicit.data)).toBe(0);
  });
});

describe("fieldToMask = (f < 0)", () => {
  it.each(pipeline)("$name", ({ field, mask: expected }) => {
    const got = fieldToMask(field);
    expect([got.width, got.height]).toEqual([expected.width, expected.height]);
    expect(countDiff(got.data, expected.data)).toBe(0);
  });

  it("zero e NaN não são tinta", () => {
    const f = { width: 4, height: 1, data: new Float32Array([-1e-30, 0, NaN, 3]) };
    expect([...fieldToMask(f).data]).toEqual([1, 0, 0, 0]);
  });

  // Ponta a ponta: campo calculado AQUI → máscara idêntica à do Python. Só é garantido porque
  // nestes fixtures nenhum pixel tem |f| menor que a diferença medida entre os dois campos
  // (~1e-4; o menor |f| é ~7e-4). Numa imagem qualquer, um pixel com f ≈ 0 pode cair para o outro lado.
  it.each(pipeline)("campo do TypeScript dá a mesma máscara: $name", ({ gray, k, opts, mask: expected }) => {
    const got = fieldToMask(inkField(toGray(gray), k, opts));
    expect(countDiff(got.data, expected.data)).toBe(0);
  });
});

describe("cleanMask = clean_mask do laboratório (componentes de 8 vizinhos)", () => {
  const steps = [
    ...pipeline.flatMap((c) => (c.clean ?? []).map((s) => ({ label: `${c.name} minArea=${s.minArea}`, src: c.mask, ...s }))),
    ...masks.flatMap((c) => c.clean.map((s) => ({ label: `${c.name} minArea=${s.minArea}`, src: c.mask, ...s }))),
  ];

  it.each(steps)("$label", ({ src, minArea, mask: expected }) => {
    const before = src.data.slice();
    const got = cleanMask(src, minArea);
    expect([got.width, got.height]).toEqual([src.width, src.height]);
    expect(countDiff(got.data, expected.data)).toBe(0);
    expect(countDiff(src.data, before)).toBe(0); // não mexe na entrada
  });

  it("os fixtures tiram alguma coisa e deixam alguma coisa", () => {
    const sum = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);
    expect(steps.some((s) => sum(s.mask.data) < sum(s.src.data) && sum(s.mask.data) > 0)).toBe(true);
    expect(steps.some((s) => sum(s.mask.data) === 0 && sum(s.src.data) > 0)).toBe(true);
    expect(steps.some((s) => sum(s.mask.data) === sum(s.src.data) && sum(s.src.data) > 0)).toBe(true);
  });

  it("qualquer valor diferente de zero conta como tinta, e a saída é sempre 0/1", () => {
    const m = mask(4, 2, new Uint8Array([255, 7, 0, 0, 0, 0, 0, 9]));
    expect([...cleanMask(m, 2).data]).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
  });
});
