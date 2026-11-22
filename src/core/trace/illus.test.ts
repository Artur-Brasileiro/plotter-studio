// Modo "ilustração": imagem colorida → desenho de linhas limpo.
// Paridade com o Python: os valores esperados vêm de rodar lab/python/illus.py de verdade
// (lab/python/fixtures_illus.py) numa cena sintética. Nada aqui é escrito à mão.
import { describe, expect, it } from "vitest";
import guidedJson from "./__fixtures__/illus/guided.json?raw";
import lineArtJson from "./__fixtures__/illus/line_art.json?raw";
import resampleJson from "./__fixtures__/illus/resample.json?raw";
import { countDiff, loadCases, maxAbsDiff } from "./__fixtures__/raster/load";
import {
  acrossDog,
  alongFlow,
  borderMedian,
  boxBlur,
  colorfulness,
  DARK_BACKGROUND,
  edgeFlow,
  guidedFilter,
  hysteresis,
  lineArt,
  lineArtParams,
  lineThresholds,
  luma,
  rawResponse,
  resample,
  rgbFromGray,
  rgbFromRgba,
  ridgeMap,
  rollingGuidance,
  toneDarkness,
  type LineArtParams,
  type RgbImage,
} from "./illus";
import { gray, type GrayImage, type Mask } from "./types";

interface LineArtCase {
  name: string;
  detail: number;
  edge: number;
  mono: boolean;
  params: { detail_px: number; sigma_e: number; coherence: number; min_px: number; threshold_scale: number };
  sigmaC: number;
  r: GrayImage;
  g: GrayImage;
  b: GrayImage;
  smoothR: GrayImage;
  smoothG: GrayImage;
  smoothB: GrayImage;
  tone: GrayImage;
  tx: GrayImage;
  ty: GrayImage;
  coherent: Mask;
  raw: GrayImage;
  resp: GrayImage;
  lo: number;
  hi: number;
  keep: Mask;
  v: GrayImage;
  gray: GrayImage;
  background: number;
  dark: GrayImage;
}
interface ResampleCase {
  name: string;
  src: GrayImage;
  width: number;
  height: number;
  out: GrayImage;
}
interface GuidedCase {
  name: string;
  guide: GrayImage;
  src: GrayImage;
  r: number;
  eps: number;
  box: GrayImage;
  out: GrayImage;
}

const cases = await loadCases<LineArtCase>(lineArtJson);
const resamples = await loadCases<ResampleCase>(resampleJson);
const guideds = await loadCases<GuidedCase>(guidedJson);

const rgbOf = (c: LineArtCase): RgbImage => ({ width: c.r.width, height: c.r.height, r: c.r.data, g: c.g.data, b: c.b.data, mono: c.mono });
const paramsOf = (c: LineArtCase): LineArtParams => ({
  detailPx: c.params.detail_px,
  sigmaE: c.params.sigma_e,
  coherence: c.params.coherence,
  minPx: c.params.min_px,
  thresholdScale: c.params.threshold_scale,
});
const flowOf = (c: LineArtCase) => ({ tx: c.tx.data, ty: c.ty.data });
/** Canais que entram na resposta: a luminância alisada e, se a imagem tem cor, os três canais alisados. */
const chansOf = (c: LineArtCase) => (c.mono ? [c.tone] : [c.tone, c.smoothR, c.smoothG, c.smoothB]);

describe("resample = illus.resample (muda o tamanho da imagem de trabalho)", () => {
  it.each(resamples)("$name", ({ src, width, height, out }) => {
    const got = resample(src, width, height);
    expect([got.width, got.height]).toEqual([width, height]);
    expect(maxAbsDiff(got.data, out.data)).toBeLessThanOrEqual(1e-6);
  });

  it("não mexe na entrada e devolve uma cópia quando o tamanho é o mesmo", () => {
    const src = resamples[0].src;
    const before = src.data.slice();
    const same = resample(src, src.width, src.height);
    expect(maxAbsDiff(same.data, before)).toBe(0);
    expect(same.data).not.toBe(src.data);
    resample(src, 7, 5);
    expect(maxAbsDiff(src.data, before)).toBe(0);
  });
});

describe("filtro guiado = illus.box e illus.guided", () => {
  it.each(guideds)("média de caixa: $name", ({ src, r, box }) => {
    const got = boxBlur(src.data, src.width, src.height, r);
    expect(maxAbsDiff(got, box.data)).toBeLessThanOrEqual(1e-6);
  });

  it.each(guideds)("filtro guiado: $name", ({ guide, src, r, eps, out }) => {
    const got = guidedFilter(guide, src, r, eps);
    expect(maxAbsDiff(got.data, out.data)).toBeLessThanOrEqual(1e-5);
  });

  it("média de caixa de imagem constante é a própria constante, até na borda", () => {
    const got = boxBlur(new Float32Array(35).fill(0.25), 7, 5, 3);
    expect(Math.max(...got)).toBeCloseTo(0.25, 12);
    expect(Math.min(...got)).toBeCloseTo(0.25, 12);
  });
});

describe("apagar a textura = illus.rolling (rolling guidance)", () => {
  it.each(cases)("luminância: $name", (c) => {
    const got = rollingGuidance(luma(rgbOf(c)), c.params.detail_px);
    expect(maxAbsDiff(got.data, c.tone.data)).toBeLessThanOrEqual(2e-5);
  });

  it.each(cases.filter((c) => !c.mono))("cada canal por conta própria: $name", (c) => {
    expect(maxAbsDiff(rollingGuidance(c.r, c.params.detail_px).data, c.smoothR.data)).toBeLessThanOrEqual(2e-5);
    expect(maxAbsDiff(rollingGuidance(c.b, c.params.detail_px).data, c.smoothB.data)).toBeLessThanOrEqual(2e-5);
  });

  it("a ferrugem da caixa amarela: quanto menos detalhe, mais ela some (no 'limpo', mais de 60%)", () => {
    const lum = luma(rgbOf(cases[0]));
    /** Desvio-padrão do tom no miolo da caixa amarela, longe da lente e das bordas (cena de fixtures_illus.py). */
    const grain = (img: GrayImage) => {
      let s = 0, s2 = 0, n = 0;
      for (let y = 42; y < 50; y++)
        for (let x = 12; x < 40; x++) {
          const v = img.data[y * img.width + x];
          s += v;
          s2 += v * v;
          n++;
        }
      return Math.sqrt(s2 / n - (s / n) ** 2);
    };
    const before = grain(lum);
    const fine = grain(rollingGuidance(lum, lineArtParams(0.75).detailPx));
    const medium = grain(rollingGuidance(lum, lineArtParams(0.5).detailPx));
    const clean = grain(rollingGuidance(lum, lineArtParams(0.25).detailPx));
    expect(before).toBeGreaterThan(0.06); // a pinta marrom é bem mais escura que o amarelo
    expect(fine).toBeLessThan(before);
    expect(medium).toBeLessThan(fine);
    expect(clean).toBeLessThan(medium);
    expect(clean).toBeLessThan(before * 0.4);
  });

  it("a borda da forma fica no lugar e continua nítida depois de alisar", () => {
    // degrau com grão: o grão some, o degrau não vira rampa
    const W = 40, H = 24;
    const d = new Float32Array(W * H);
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.12;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = (x < 20 ? 0.85 : 0.25) + rnd();
    const out = rollingGuidance(gray(W, H, d), 2.2).data;
    const row = 12 * W;
    expect(out[row + 17]).toBeGreaterThan(0.78);
    expect(out[row + 22]).toBeLessThan(0.32);
    expect(Math.abs(out[row + 10] - out[row + 14])).toBeLessThan(0.03); // o grão sumiu
  });

  it("sigma minúsculo não alisa nada", () => {
    const lum = luma(rgbOf(cases[0]));
    expect(maxAbsDiff(rollingGuidance(lum, 0.3).data, lum.data)).toBe(0);
  });
});

describe("direção das bordas = illus.flow", () => {
  it.each(cases)("$name", (c) => {
    const chans = c.mono ? [c.tone] : [c.smoothR, c.smoothG, c.smoothB];
    const got = edgeFlow(chans, c.sigmaC);
    let worst = 0, n = 0;
    for (let i = 0; i < got.tx.length; i++) {
      expect(Math.hypot(got.tx[i], got.ty[i])).toBeCloseTo(1, 5); // sempre unitária
      if (!c.coherent.data[i]) continue; // onde a borda não tem direção definida, qualquer uma serve
      n++;
      // a tangente não tem sentido (t e −t são a mesma direção)
      worst = Math.max(worst, 1 - Math.abs(got.tx[i] * c.tx.data[i] + got.ty[i] * c.ty.data[i]));
    }
    expect(n).toBeGreaterThan(200);
    expect(worst).toBeLessThan(1e-6);
  });

  it("imagem lisa: sem borda, a direção é (1, 0) e nada vira NaN", () => {
    const flat = gray(12, 9, new Float32Array(108).fill(0.5));
    const f = edgeFlow([flat], 1.5);
    expect([...f.tx].every((v) => v === 1)).toBe(true);
    expect([...f.ty].every((v) => v === 0)).toBe(true);
  });

  it("borda exatamente vertical: a tangente é vertical; exatamente horizontal: horizontal", () => {
    const v = new Float32Array(20 * 20), h = new Float32Array(20 * 20);
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 20; x++) {
        if (x >= 10) v[y * 20 + x] = 1;
        if (y >= 10) h[y * 20 + x] = 1;
      }
    const i = 10 * 20 + 10;
    const fv = edgeFlow([gray(20, 20, v)], 1.5);
    expect(Math.abs(fv.ty[i])).toBeCloseTo(1, 6);
    expect(Math.abs(fv.tx[i])).toBeLessThan(1e-6);
    const fh = edgeFlow([gray(20, 20, h)], 1.5);
    expect(Math.abs(fh.tx[i])).toBeCloseTo(1, 6);
    expect(Math.abs(fh.ty[i])).toBeLessThan(1e-6);
  });
});

describe("resposta de linha = illus.across, illus.raw_response e illus.along", () => {
  it.each(cases)("atravessando a borda: $name", (c) => {
    const got = rawResponse(chansOf(c), flowOf(c), c.params.sigma_e);
    expect(maxAbsDiff(got, c.raw.data)).toBeLessThanOrEqual(1e-6);
  });

  it.each(cases)("ao longo da borda: $name", (c) => {
    const got = alongFlow(c.raw.data, c.raw.width, c.raw.height, flowOf(c), c.params.coherence);
    expect(maxAbsDiff(got, c.resp.data)).toBeLessThanOrEqual(1e-6);
  });

  it("degrau: a linha fica do lado escuro da borda, e o lado claro não responde", () => {
    const W = 30, H = 12;
    const d = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = x < 15 ? 0.9 : 0.2;
    const img = gray(W, H, d);
    const f = edgeFlow([img], 1.5);
    const a = acrossDog(img, f, 1.0);
    const row = 6 * W;
    expect(-a[row + 15]).toBeGreaterThan(0.03); // primeiro pixel escuro
    expect(-a[row + 14]).toBeLessThan(0); // último pixel claro
    expect(Math.abs(a[row + 3] + 0.2 * 0.9 * 0.05)).toBeLessThan(0.02); // longe da borda: quase zero
  });

  it("borda entre duas cores de MESMA luminância: só os canais de cor enxergam", () => {
    const c = cases[0];
    const onlyLum = rawResponse([c.tone], flowOf(c), c.params.sigma_e);
    const withColor = rawResponse(chansOf(c), flowOf(c), c.params.sigma_e);
    // divisa do vermelho com o verde na cena: x ≈ 63, y de 8 a 19
    let lum = -Infinity, col = -Infinity;
    for (let y = 9; y < 19; y++)
      for (let x = 60; x < 67; x++) {
        lum = Math.max(lum, onlyLum[y * c.tone.width + x]);
        col = Math.max(col, withColor[y * c.tone.width + x]);
      }
    expect(lum).toBeLessThan(0.005);
    expect(col).toBeGreaterThan(0.02);
  });

  it("borda exatamente vertical ou horizontal (arte digital limpa) responde igual a uma inclinada", () => {
    const W = 40, H = 40;
    const step = (dark: (x: number, y: number) => boolean) => {
      const d = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = dark(x, y) ? 0.2 : 0.9;
      const img = gray(W, H, d);
      const a = rawResponse([img], edgeFlow([img], 2), 1.0);
      let best = -Infinity;
      for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) best = Math.max(best, a[y * W + x]);
      return best;
    };
    const vertical = step((x) => x >= 20);
    const horizontal = step((_, y) => y >= 20);
    const diagonal = step((x, y) => x + y >= 40);
    expect(vertical).toBeGreaterThan(0.05);
    expect(horizontal).toBeCloseTo(vertical, 6);
    expect(diagonal).toBeGreaterThan(0.75 * vertical);
  });

  it("alongFlow com coerência 0 devolve uma cópia", () => {
    const c = cases[0];
    const got = alongFlow(c.raw.data, c.raw.width, c.raw.height, flowOf(c), 0);
    expect(maxAbsDiff(got, c.raw.data)).toBe(0);
    expect(got).not.toBe(c.raw.data);
  });
});

describe("histerese = illus.thresholds e illus.hysteresis", () => {
  it.each(cases)("limiares desta imagem: $name", (c) => {
    const t = lineThresholds(c.resp.data, c.params.threshold_scale);
    expect(t.lo).toBeCloseTo(c.lo, 9);
    expect(t.hi).toBeCloseTo(c.hi, 9);
  });

  it.each(cases)("o que fica: $name", (c) => {
    const got = hysteresis(c.resp.data, c.resp.width, c.resp.height, c.lo, c.hi, c.params.min_px);
    expect(countDiff(got, c.keep.data)).toBe(0);
  });

  it("imagem sem linha nenhuma: limiar no piso, nada fica", () => {
    const resp = new Float32Array(400).fill(-0.009);
    const t = lineThresholds(resp);
    expect(t.hi).toBeCloseTo(0.012, 9);
    expect(t.lo).toBeCloseTo(0.003, 9);
    expect(hysteresis(resp, 20, 20, t.lo, t.hi).some((v) => v !== 0)).toBe(false);
  });

  it("imagem muito contrastada: o limiar forte não passa do teto", () => {
    const resp = new Float32Array(400).fill(0.2);
    expect(lineThresholds(resp).hi).toBeCloseTo(0.047, 9);
    expect(lineThresholds(resp, 2).hi).toBeCloseTo(0.094, 9); // "linhas fracas" no mínimo dobra o limiar
  });

  it("linha fraca só fica se estiver ligada a uma forte; componente pequeno some", () => {
    const W = 30, H = 9;
    const resp = new Float32Array(W * H);
    for (let x = 2; x < 14; x++) resp[2 * W + x] = 0.02; // fraca, ligada (até na diagonal) a um trecho forte
    resp[3 * W + 14] = 0.08;
    for (let x = 18; x < 28; x++) resp[6 * W + x] = 0.02; // fraca e sozinha
    resp[7 * W + 3] = 0.09; // forte, mas um pixel só
    const keep = hysteresis(resp, W, H, 0.01, 0.05, 4);
    expect(keep[2 * W + 5]).toBe(1);
    expect(keep[3 * W + 14]).toBe(1);
    expect(keep[6 * W + 20]).toBe(0);
    expect(keep[7 * W + 3]).toBe(0);
    // sem tamanho mínimo, o pixel forte sozinho fica
    expect(hysteresis(resp, W, H, 0.01, 0.05)[7 * W + 3]).toBe(1);
  });
});

describe("linha normalizada pela própria altura = illus.ridge", () => {
  it.each(cases)("$name", (c) => {
    const got = ridgeMap(c.resp, c.keep.data, c.lo, c.params.sigma_e);
    expect(maxAbsDiff(got, c.v.data)).toBeLessThanOrEqual(1e-5);
  });

  it("linha forte e linha fraca chegam à mesma altura no centro (a fraca não some)", () => {
    const W = 40, H = 30;
    const d = new Float32Array(W * H);
    const keep = new Uint8Array(W * H);
    const bump = (y0: number, peak: number) => {
      for (let y = y0 - 3; y <= y0 + 3; y++)
        for (let x = 4; x < 36; x++) {
          d[y * W + x] = peak * Math.exp(-((y - y0) ** 2) / 2);
          keep[y * W + x] = 1;
        }
    };
    bump(8, 0.08);
    bump(21, 0.015);
    const v = ridgeMap(gray(W, H, d), keep, 0.004, 1.0);
    expect(v[8 * W + 20]).toBeGreaterThan(0.85);
    expect(v[21 * W + 20]).toBeGreaterThan(0.85);
    expect(v[8 * W + 20] - v[21 * W + 20]).toBeLessThan(0.05);
    expect(v[15 * W + 20]).toBe(0); // fora das linhas
  });
});

describe("lineArt = illus.line_art (tudo junto)", () => {
  it.each(cases)("$name", (c) => {
    const rgb = rgbOf(c);
    const before = rgb.r.slice();
    const got = lineArt(rgb, paramsOf(c));
    expect([got.gray.width, got.gray.height]).toEqual([c.gray.width, c.gray.height]);
    expect(maxAbsDiff(got.tone.data, c.tone.data)).toBeLessThanOrEqual(2e-5);
    // a histerese é um corte: um pixel no fio da navalha pode cair do outro lado por um arredondamento.
    // Não cai nenhum nestas cenas; se um dia cair, este teste diz quantos.
    let off = 0;
    for (let i = 0; i < got.gray.data.length; i++) if (Math.abs(got.gray.data[i] - c.gray.data[i]) > 0.02) off++;
    expect(off).toBe(0);
    expect(maxAbsDiff(rgb.r, before)).toBe(0); // não mexe na entrada
  });

  it("o papel é 255 e a linha desce quase a 0", () => {
    const g = lineArt(rgbOf(cases[0]), paramsOf(cases[0])).gray.data;
    expect(Math.max(...g)).toBe(255);
    expect(Math.min(...g)).toBeLessThan(25);
  });

  it("imagem lisa: nenhuma linha", () => {
    const flat: RgbImage = { width: 24, height: 18, r: new Float32Array(432).fill(0.8), g: new Float32Array(432).fill(0.7), b: new Float32Array(432).fill(0.3) };
    const g = lineArt(flat, lineArtParams(0.75)).gray.data;
    expect(Math.min(...g)).toBe(255);
  });
});

describe("lineArtParams = illus.params_for", () => {
  it.each(cases)("$name", (c) => {
    const p = lineArtParams(c.detail, c.edge);
    expect(p.detailPx).toBeCloseTo(c.params.detail_px, 12);
    expect(p.sigmaE).toBeCloseTo(c.params.sigma_e, 12);
    expect(p.coherence).toBeCloseTo(c.params.coherence, 12);
    expect(p.minPx).toBeCloseTo(c.params.min_px, 12);
    expect(p.thresholdScale).toBeCloseTo(c.params.threshold_scale, 12);
  });

  it("mais detalhe = alisa menos; fora de 0..1 fica preso na ponta", () => {
    expect(lineArtParams(1).detailPx).toBeLessThan(lineArtParams(0.5).detailPx);
    expect(lineArtParams(0.5).detailPx).toBeLessThan(lineArtParams(0).detailPx);
    expect(lineArtParams(7)).toEqual(lineArtParams(1));
    expect(lineArtParams(-3)).toEqual(lineArtParams(0));
    expect(lineArtParams(0.6, 0.5).thresholdScale).toBe(1);
    expect(lineArtParams(0.6, 1).thresholdScale).toBe(0.5);
    expect(lineArtParams(0.6, 0).thresholdScale).toBe(2);
  });
});

describe("tons para a hachura = illus.tone_darkness", () => {
  it.each(cases)("$name", (c) => {
    expect(maxAbsDiff(toneDarkness(c.tone), c.dark.data)).toBeLessThanOrEqual(1e-6);
  });

  it("imagem toda de um tom só: tudo papel, nada de NaN", () => {
    const d = toneDarkness(gray(8, 8, new Float32Array(64).fill(0.4)));
    expect([...d].every((v) => v === 0)).toBe(true);
  });

  it("os fixtures têm cena de fundo claro e cena de fundo escuro", () => {
    expect(cases.some((c) => c.background < DARK_BACKGROUND)).toBe(true);
    expect(cases.some((c) => c.background >= DARK_BACKGROUND)).toBe(true);
  });

  it("fundo escuro não é sombra: o fundo é o papel, e só o que é mais escuro que ele conta", () => {
    // fundo 0,2; um disco claro (0,8) e um retângulo quase preto (0,03)
    const W = 60, H = 40;
    const d = new Float32Array(W * H).fill(0.2);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (Math.hypot(x - 20, y - 20) < 9) d[y * W + x] = 0.8;
        if (x >= 38 && x < 50 && y >= 12 && y < 28) d[y * W + x] = 0.03;
      }
    const dark = toneDarkness(gray(W, H, d));
    expect(dark[2 * W + 2]).toBe(0); // fundo
    expect(dark[20 * W + 20]).toBe(0); // figura clara
    expect(dark[20 * W + 44]).toBe(1); // o que é mais escuro que o fundo
  });

  it("imagem em que nada é bem mais escuro que o papel: o grão do fundo não vira sombra", () => {
    // fundo escuro com grão de ±0,01 e uma figura clara; e papel claro com o mesmo grão
    for (const base of [0.1, 0.9]) {
      const W = 40, H = 40;
      const d = new Float32Array(W * H);
      let seed = 3;
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.02;
      for (let i = 0; i < d.length; i++) d[i] = base + rnd();
      if (base < 0.5) for (let y = 14; y < 26; y++) for (let x = 14; x < 26; x++) d[y * W + x] = 0.7;
      expect(Math.max(...toneDarkness(gray(W, H, d)))).toBeLessThan(0.25);
    }
  });

  it("fundo claro: continua valendo 'papel = os 10% mais claros'", () => {
    const W = 60, H = 40;
    const d = new Float32Array(W * H).fill(0.9);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 50; x++) d[y * W + x] = 0.5;
    for (let y = 16; y < 24; y++) for (let x = 20; x < 40; x++) d[y * W + x] = 0.1;
    const dark = toneDarkness(gray(W, H, d));
    expect(dark[2 * W + 2]).toBe(0);
    expect(dark[12 * W + 12]).toBeCloseTo(0.5, 6);
    expect(dark[20 * W + 30]).toBe(1);
  });
});

describe("borderMedian = illus.border_median (o tom do fundo)", () => {
  it.each(cases)("$name", (c) => {
    expect(borderMedian(c.tone)).toBeCloseTo(c.background, 6);
  });

  it("olha só a faixa da borda: o miolo não muda a resposta", () => {
    const W = 50, H = 50; // faixa de 2 px (4% de 50)
    const d = new Float32Array(W * H).fill(0.15);
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) d[y * W + x] = 0.95;
    expect(borderMedian(gray(W, H, d))).toBeCloseTo(0.15, 6);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = x < 2 || y < 2 || x >= W - 2 || y >= H - 2 ? 0.95 : 0.15;
    expect(borderMedian(gray(W, H, d))).toBeCloseTo(0.95, 6);
  });

  it("imagem minúscula: a faixa tem pelo menos 1 px e nunca passa da imagem", () => {
    expect(borderMedian(gray(1, 1, new Float32Array([0.3])))).toBeCloseTo(0.3, 6);
    expect(borderMedian(gray(3, 2, new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])))).toBeCloseTo(0.35, 6);
  });

  it("serve para a imagem em 0..255 também (a tela usa assim)", () => {
    expect(borderMedian(gray(4, 4, new Float32Array(16).fill(51))) / 255).toBeCloseTo(0.2, 6);
  });
});

describe("colorfulness: a imagem é colorida? (para a tela sugerir o tipo Ilustração)", () => {
  const filled = (n: number, px: (i: number) => [number, number, number]) => {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) d.set([...px(i), 255], 4 * i);
    return d;
  };

  it("a cena pintada (amarelo, azul, vermelho, verde) é colorida", () => {
    const c = cases[0];
    const n = c.r.width * c.r.height;
    const rgba = filled(n, (i) => [Math.round(c.r.data[i] * 255), Math.round(c.g.data[i] * 255), Math.round(c.b.data[i] * 255)]);
    expect(colorfulness(rgba)).toBeGreaterThan(0.2);
  });

  it("cinza puro e desenho a lápis em papel creme não são (papel amarelado não conta como cor)", () => {
    expect(colorfulness(filled(5000, (i) => [i % 256, i % 256, i % 256]))).toBe(0);
    // papel creme com traços de grafite levemente azulados
    const pencil = filled(5000, (i) => (i % 9 === 0 ? [70, 72, 80] : [243, 238, 224]));
    expect(colorfulness(pencil)).toBe(0);
  });

  it("um detalhe colorido pequeno num desenho cinza conta na proporção do tamanho", () => {
    const rgba = filled(10000, (i) => (i < 200 ? [220, 40, 40] : [250, 250, 250]));
    expect(colorfulness(rgba)).toBeCloseTo(0.02, 3);
  });

  it("imagem grande é amostrada (não muda a resposta) e imagem vazia dá 0", () => {
    const big = filled(600_000, (i) => (i % 2 ? [30, 90, 220] : [128, 128, 128]));
    expect(colorfulness(big)).toBeGreaterThan(0.4);
    expect(colorfulness(big)).toBeLessThan(0.6);
    expect(colorfulness(new Uint8ClampedArray(0))).toBe(0);
  });
});

describe("entrada: cor do navegador (RGBA) ou só cinza", () => {
  it("rgbFromRgba: 0..255 vira 0..1, e a luminância usa os pesos do programa", () => {
    const rgb = rgbFromRgba(2, 1, new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]));
    expect([rgb.r[0], rgb.g[0], rgb.b[0]]).toEqual([1, 0, 0]);
    const l = luma(rgb);
    expect(l.data[0]).toBeCloseTo(0.299, 6);
    expect(l.data[1]).toBeCloseTo(0.587, 6);
    expect(rgb.mono).toBeFalsy();
  });

  it("rgbFromRgba com fundo escuro (invert): o negativo de cada canal", () => {
    const rgb = rgbFromRgba(1, 1, new Uint8ClampedArray([255, 51, 0, 255]), true);
    expect(rgb.r[0]).toBe(0);
    expect(rgb.g[0]).toBeCloseTo(0.8, 6);
    expect(rgb.b[0]).toBe(1);
  });

  it("rgbFromGray: marca a imagem como sem cor (os canais de cor nem são calculados)", () => {
    const rgb = rgbFromGray(gray(2, 1, new Float32Array([0, 255])));
    expect(rgb.mono).toBe(true);
    expect([rgb.r[0], rgb.r[1]]).toEqual([0, 1]);
    expect(luma(rgb).data[1]).toBeCloseTo(1, 6);
    expect(rgbFromGray(gray(1, 1, new Float32Array([51])), true).r[0]).toBeCloseTo(0.8, 6);
  });
});
