// O traçador inteiro (imagem → traços), nos modos que não têm paridade direta com o laboratório:
// "illus" (ilustração colorida) e os tons do "photo". A cena colorida é a mesma dos fixtures do
// modo ilustração (lab/python/fixtures_illus.py): caixa amarela com ferrugem e uma lente azul de aro
// preto, roda escura de miolo claro, bloco vermelho/verde de mesma luminância, uma linha fina.
import { describe, expect, it } from "vitest";
import lineArtJson from "./__fixtures__/illus/line_art.json?raw";
import { loadCases } from "./__fixtures__/raster/load";
import { flattenSubPath } from "../geometry/flatten";
import type { SubPath } from "../geometry/path";
import { illusWorkSize, traceImage, type TraceOptions, type TraceResult } from "./traceImage";
import { gray, type GrayImage, type RgbaImage } from "./types";

const [scene] = await loadCases<{ r: GrayImage; g: GrayImage; b: GrayImage }>(lineArtJson);
const W = scene.r.width, H = scene.r.height; // 80 × 64

/** A cena como o programa a recebe: os pixels coloridos do navegador e a versão em cinza. */
const color: RgbaImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
const mono = gray(W, H);
for (let i = 0; i < W * H; i++) {
  const r = Math.round(scene.r.data[i] * 255), g = Math.round(scene.g.data[i] * 255), b = Math.round(scene.b.data[i] * 255);
  color.data.set([r, g, b, 255], 4 * i);
  mono.data[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

const illus = (opts: Partial<TraceOptions> = {}, withColor = true): TraceResult =>
  traceImage(mono, { mode: "illus", mmPerPx: 0.4, penMm: 0.4, shade: 0, ...opts }, undefined, withColor ? color : undefined);

const points = (sp: SubPath) => flattenSubPath(sp, 0.02).points;
const lengthOf = (sp: SubPath) => {
  const p = points(sp);
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
};
/** No modo ilustração as sombras (hachura) vêm primeiro e os traços depois. */
const hatchesOf = (r: TraceResult) => r.geometry.subpaths.slice(0, r.stats.hatches);
const strokesOf = (r: TraceResult) => r.geometry.subpaths.slice(r.stats.hatches);
/** Quantos pontos dos traços caem num retângulo (px da imagem). */
const pointsIn = (subpaths: readonly SubPath[], x0: number, y0: number, x1: number, y1: number) =>
  subpaths.reduce((n, sp) => n + points(sp).filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1).length, 0);
const bbox = (subpaths: readonly SubPath[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of subpaths)
    for (const p of points(sp)) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  return { minX, minY, maxX, maxY };
};

// miolo da caixa amarela, só ferrugem: longe das bordas da caixa e do aro da lente
const RUST = [11, 41, 41, 49] as const;

describe("modo ilustração: imagem colorida → traços", () => {
  it("a cena vira poucos traços longos, sem pontos soltos e sem hachura quando a sombra está em zero", () => {
    const r = illus();
    expect(r.stats.strokes).toBeGreaterThanOrEqual(6);
    expect(r.stats.strokes).toBeLessThanOrEqual(40);
    expect(r.stats.dots).toBe(0);
    expect(r.stats.hatches).toBe(0);
    expect(r.stats.outlines).toBe(0);
    expect(r.geometry.subpaths).toHaveLength(r.stats.strokes);
    const b = bbox(r.geometry.subpaths);
    expect(b.minX).toBeGreaterThanOrEqual(0);
    expect(b.minY).toBeGreaterThanOrEqual(0);
    expect(b.maxX).toBeLessThanOrEqual(W);
    expect(b.maxY).toBeLessThanOrEqual(H);
    expect([r.width, r.height]).toEqual([W, H]);
  });

  it("a textura não vira traço: a ferrugem que o modo Traço rabisca aqui quase não aparece", () => {
    const asLine = traceImage(mono, { mode: "line", mmPerPx: 0.4, penMm: 0.4 });
    const rustLine = pointsIn(asLine.geometry.subpaths, ...RUST);
    const rustIllus = pointsIn(illus().geometry.subpaths, ...RUST);
    expect(rustLine).toBeGreaterThan(40);
    expect(rustIllus).toBeLessThan(rustLine / 5);
  });

  it("contorna as formas: a roda escura ganha um traço em volta", () => {
    // pontos de traço perto da circunferência da roda (centro 58, 46; raio 13)
    const near = strokesOf(illus()).flatMap(points).filter((p) => Math.abs(Math.hypot(p.x - 58, p.y - 46) - 13) < 2);
    const angles = new Set(near.map((p) => Math.floor(((Math.atan2(p.y - 46, p.x - 58) + Math.PI) / (2 * Math.PI)) * 12)));
    expect(angles.size).toBeGreaterThanOrEqual(10); // dá a volta quase toda (a linha fina cruza embaixo)
  });

  it("com cor enxerga a divisa entre duas cores de mesma luminância; só com o cinza, não", () => {
    // divisa do vermelho com o verde: x ≈ 63, y de 5 a 22 (por dentro do bloco)
    const withColor = pointsIn(illus().geometry.subpaths, 61, 9, 65.5, 18);
    const grayOnly = pointsIn(illus({}, false).geometry.subpaths, 61, 9, 65.5, 18);
    expect(withColor).toBeGreaterThan(3);
    expect(grayOnly).toBe(0);
  });

  it("traço mínimo: tira os tracinhos, e o que fica tem pelo menos aquele comprimento", () => {
    const all = illus({ minStrokeMm: 0 });
    const long = illus({ minStrokeMm: 8 });
    expect(long.stats.strokes).toBeLessThan(all.stats.strokes);
    expect(long.stats.strokes).toBeGreaterThan(0);
    for (const sp of long.geometry.subpaths) expect(lengthOf(sp) * 0.4).toBeGreaterThan(8 * 0.9);
    expect(all.geometry.subpaths.some((sp) => lengthOf(sp) * 0.4 < 8 * 0.9)).toBe(true);
  });

  it("mais detalhe = mais tinta", () => {
    const clean = illus({ detail: 0.1 });
    const fine = illus({ detail: 1 });
    expect(fine.stats.lengthPx).toBeGreaterThan(clean.stats.lengthPx);
    expect(clean.stats.strokes).toBeGreaterThan(0);
  });

  it("linhas fracas: no mínimo sobram só as formas mais contrastadas", () => {
    const few = illus({ edge: 0 });
    const many = illus({ edge: 1 });
    expect(many.stats.lengthPx).toBeGreaterThan(few.stats.lengthPx);
    expect(few.stats.strokes).toBeGreaterThan(0);
  });

  it("as coordenadas saem em pixels da imagem ORIGINAL, qualquer que seja o tamanho no papel", () => {
    // 0,4 mm/px: imagem de trabalho = a própria; 0,8 mm/px: de trabalho com o dobro de pixels
    const a = bbox(illus({ mmPerPx: 0.4 }).geometry.subpaths);
    const b = bbox(illus({ mmPerPx: 0.8 }).geometry.subpaths);
    for (const k of ["minX", "minY", "maxX", "maxY"] as const) expect(Math.abs(a[k] - b[k])).toBeLessThan(2.5);
    expect(a.maxX - a.minX).toBeGreaterThan(60); // a linha fina atravessa a cena
    expect(a.maxY - a.minY).toBeGreaterThan(45);
    // a roda continua no lugar dela
    const wheel = strokesOf(illus({ mmPerPx: 0.8 })).flatMap(points).filter((p) => Math.abs(Math.hypot(p.x - 58, p.y - 46) - 13) < 2);
    expect(wheel.length).toBeGreaterThan(20);
  });

  it("o comprimento informado bate com o que foi desenhado (em px da imagem original)", () => {
    const r = illus({ mmPerPx: 0.8 });
    const real = r.geometry.subpaths.reduce((s, sp) => s + lengthOf(sp), 0);
    expect(Math.abs(r.stats.lengthPx - real) / real).toBeLessThan(0.08);
  });

  it("imagem lisa não dá traço nem erro", () => {
    const flat = gray(40, 30, new Float32Array(1200).fill(200));
    const r = traceImage(flat, { mode: "illus", mmPerPx: 0.4, penMm: 0.4 });
    expect(r.geometry.subpaths).toHaveLength(0);
  });

  it("fundo escuro (invert) também funciona: o negativo da cena dá os mesmos contornos", () => {
    const neg: RgbaImage = { width: W, height: H, data: color.data.map((v, i) => (i % 4 === 3 ? 255 : 255 - v)) };
    const negMono = gray(W, H, mono.data.map((v) => 255 - v));
    const r = traceImage(negMono, { mode: "illus", mmPerPx: 0.4, penMm: 0.4, shade: 0, invert: true }, undefined, neg);
    const ref = illus();
    expect(r.stats.strokes).toBe(ref.stats.strokes);
    expect(Math.abs(r.stats.lengthPx - ref.stats.lengthPx)).toBeLessThan(1e-6 * ref.stats.lengthPx + 1e-3);
  });
});

describe("modo ilustração: sombras (hachura só nas partes escuras)", () => {
  // 0,8 mm/px: a cena tem 64 × 51 mm no papel, e a roda, 21 mm (cabe hachura de 2 mm)
  const big = (opts: Partial<TraceOptions> = {}) => illus({ mmPerPx: 0.8, ...opts });

  it("sombra em zero: nenhuma hachura; com sombra: aparece", () => {
    expect(big({ shade: 0 }).stats.hatches).toBe(0);
    expect(big({ shade: 0.1 }).stats.hatches).toBeGreaterThan(0);
  });

  it("sombra bem leve: a hachura cai só no que é quase preto (a roda e a lente de aro preto)", () => {
    const r = big({ shade: 0.1 });
    const pts = hatchesOf(r).flatMap(points);
    expect(pts.length).toBeGreaterThan(4);
    for (const p of pts) {
      const inWheel = Math.hypot(p.x - 58, p.y - 46) < 13 + 1.5;
      const inLens = Math.hypot(p.x - 26, p.y - 30) < 8 + 1.5;
      expect(inWheel || inLens).toBe(true);
    }
  });

  it("sombra média: entra também o tom do meio (o bloco vermelho e verde); o amarelo e o papel ficam em branco", () => {
    const BLOCK = [51, 6, 75, 21] as const;
    expect(pointsIn(hatchesOf(big({ shade: 0.1 })), ...BLOCK)).toBe(0);
    const r = big({ shade: 0.5 });
    expect(pointsIn(hatchesOf(r), ...BLOCK)).toBeGreaterThan(4);
    expect(pointsIn(hatchesOf(r), ...RUST)).toBe(0);
    expect(pointsIn(hatchesOf(r), 0, 0, 6, 64)).toBe(0); // margem de papel à esquerda
  });

  it("mais sombra = mais hachura, e o mais escuro ganha a segunda direção", () => {
    const len = (r: TraceResult) => hatchesOf(r).reduce((s, sp) => s + lengthOf(sp), 0);
    const light = big({ shade: 0.1 });
    const strong = big({ shade: 0.9 });
    expect(len(strong)).toBeGreaterThan(len(light) * 1.3);
    // direções das linhas da hachura (as emendas do zigue-zague são curtas e ficam de fora)
    const dirs = new Set<number>();
    for (const sp of hatchesOf(strong)) {
      const p = points(sp);
      for (let i = 1; i < p.length; i++) {
        const dx = p[i].x - p[i - 1].x, dy = p[i].y - p[i - 1].y;
        if (Math.hypot(dx, dy) * 0.8 < 5) continue;
        dirs.add(Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 180));
      }
    }
    expect([...dirs].sort((a, b) => a - b)).toEqual([45, 135]);
  });

  it("os traços de contorno não mudam por causa da sombra", () => {
    const a = strokesOf(big({ shade: 0 }));
    const b = strokesOf(big({ shade: 0.6 }));
    expect(b).toEqual(a);
  });

  it("distância da hachura maior = menos tinta", () => {
    const len = (r: TraceResult) => hatchesOf(r).reduce((s, sp) => s + lengthOf(sp), 0);
    expect(len(big({ shade: 0.9, shadeSpacingMm: 3 }))).toBeLessThan(len(big({ shade: 0.9, shadeSpacingMm: 1.5 })));
  });
});

describe("modo ilustração: imagem de fundo escuro", () => {
  // o negativo da cena: fundo quase preto, roda clara de miolo escuro, caixa azulada
  const neg: RgbaImage = { width: W, height: H, data: color.data.map((v, i) => (i % 4 === 3 ? 255 : 255 - v)) };
  const negMono = gray(W, H, mono.data.map((v) => 255 - v));
  const dark = (opts: Partial<TraceOptions> = {}) => traceImage(negMono, { mode: "illus", mmPerPx: 0.8, penMm: 0.4, ...opts }, undefined, neg);

  it("as sombras não hachuram o fundo (fundo escuro não é sombra)", () => {
    const r = dark({ shade: 0.9 });
    // margens da cena, que são só fundo
    expect(pointsIn(hatchesOf(r), 0, 0, 6, 64)).toBe(0);
    expect(pointsIn(hatchesOf(r), 0, 0, 44, 3)).toBe(0);
    expect(pointsIn(hatchesOf(r), 46, 24, 80, 30)).toBe(0);
  });

  it("os contornos saem do mesmo jeito, sem precisar marcar 'fundo escuro'", () => {
    const r = dark({ shade: 0 });
    const wheel = strokesOf(r).flatMap(points).filter((p) => Math.abs(Math.hypot(p.x - 58, p.y - 46) - 13) < 2.5);
    expect(wheel.length).toBeGreaterThan(20);
    expect(r.stats.strokes).toBeGreaterThanOrEqual(6);
  });
});

describe("tamanho da imagem de trabalho do modo ilustração (1 px = 1 largura de caneta)", () => {
  it("imagem que já está nessa escala não é mexida", () => {
    expect(illusWorkSize(736, 1313, 0.405, 0.4)).toEqual({ width: 736, height: 1313 });
  });
  it("imagem grande num papel pequeno encolhe; imagem pequena num papel grande cresce", () => {
    expect(illusWorkSize(3000, 2000, 0.1, 0.4)).toEqual({ width: 750, height: 500 });
    expect(illusWorkSize(300, 200, 1.2, 0.4)).toEqual({ width: 900, height: 600 });
  });
  it("caneta mais grossa = imagem de trabalho menor (menos detalhe cabe)", () => {
    expect(illusWorkSize(1000, 1000, 0.4, 0.8)).toEqual({ width: 500, height: 500 });
  });
  it("tem teto (≈ 4 milhões de px) e piso (nunca menos de 8 px de lado)", () => {
    const big = illusWorkSize(4000, 4000, 0.5, 0.1);
    expect(big.width * big.height).toBeLessThanOrEqual(4_000_000 * 1.01);
    expect(big.width).toBe(big.height);
    expect(illusWorkSize(40, 30, 0.01, 0.4)).toEqual({ width: 8, height: 8 });
  });
});

describe("modo foto: os tons", () => {
  it("cada tom mais escuro ganha mais hachura (os escuros não saem todos iguais)", () => {
    // quatro faixas verticais: papel, 30%, 60% e 90% de escuro
    const BW = 60, BH = 140;
    const img = gray(4 * BW, BH);
    const levels = [255, 255 * 0.7, 255 * 0.4, 255 * 0.1];
    for (let y = 0; y < BH; y++) for (let x = 0; x < 4 * BW; x++) img.data[y * 4 * BW + x] = levels[Math.floor(x / BW)];
    const r = traceImage(img, { mode: "photo", mmPerPx: 0.5, penMm: 0.4, photoSmoothMm: 0.3, hatchMinMm: 0.5 });
    // tinta em cada faixa: amostra os traços a cada meio pixel e conta por faixa (longe das divisas)
    const ink = [0, 0, 0, 0];
    for (const sp of r.geometry.subpaths) {
      const p = points(sp);
      for (let i = 1; i < p.length; i++) {
        const n = Math.max(1, Math.ceil(Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y) / 0.5));
        for (let k = 0; k < n; k++) {
          const x = p[i - 1].x + ((p[i].x - p[i - 1].x) * (k + 0.5)) / n;
          const band = Math.floor(x / BW);
          if (band >= 0 && band < 4 && Math.abs(x - (band + 0.5) * BW) < BW / 2 - 8) ink[band]++;
        }
      }
    }
    expect(ink[0]).toBe(0); // papel
    expect(ink[1]).toBeGreaterThan(0);
    expect(ink[2]).toBeGreaterThan(ink[1] * 1.3);
    expect(ink[3]).toBeGreaterThan(ink[2] * 1.3);
  });
});

describe("modo traço (o que já existia continua igual)", () => {
  it("uma linha preta num papel branco é um traço só, do comprimento dela", () => {
    const img = gray(80, 40, new Float32Array(3200).fill(255));
    for (let y = 19; y < 22; y++) for (let x = 10; x < 70; x++) img.data[y * 80 + x] = 0;
    const r = traceImage(img, { mode: "line", mmPerPx: 0.4, penMm: 0.4 });
    expect(r.stats.strokes).toBe(1);
    expect(r.stats.dots).toBe(0);
    expect(lengthOf(r.geometry.subpaths[0])).toBeGreaterThan(54);
    expect(lengthOf(r.geometry.subpaths[0])).toBeLessThan(62);
    const p = points(r.geometry.subpaths[0]);
    for (const q of p) expect(Math.abs(q.y - 20.5)).toBeLessThan(0.6);
  });
});
