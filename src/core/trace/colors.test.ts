import { describe, expect, it } from "vitest";
import type { Geometry, SubPath } from "../geometry/path";
import { backgroundRgb, colorLayers, findPalette, lightOnDark, oklab, paperClass, strokeColors, type Palette } from "./colors";

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [12, 12, 14];
const RED: Rgb = [226, 30, 38];
const GREEN: Rgb = [0, 170, 60];

/** Imagem de teste: fundo de uma cor e retângulos [x0, y0, x1, y1, cor] por cima. */
function scene(w: number, h: number, bg: Rgb, rects: [number, number, number, number, Rgb][], noise = 0): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * noise;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = bg;
      for (const [x0, y0, x1, y1, col] of rects) if (x >= x0 && x < x1 && y >= y0 && y < y1) c = col;
      d.set([c[0] + rnd(), c[1] + rnd(), c[2] + rnd(), 255], 4 * (y * w + x));
    }
  return d;
}
const line = (x0: number, y0: number, x1: number, y1: number): SubPath => ({ start: { x: x0, y: y0 }, segments: [{ kind: "line", to: { x: x1, y: y1 } }], closed: false });
const names = (p: Palette) => p.classes.map((c) => c.name);
const byName = (p: Palette, n: string) => p.classes.find((c) => c.name === n)!;

/** Uma cor pela claridade, croma e matiz (graus) do OKLab: o contrário de `oklab`. */
function lch(L: number, C: number, hDeg: number): Rgb {
  const a = C * Math.cos((hDeg * Math.PI) / 180), b = C * Math.sin((hDeg * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const q = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q];
  return lin.map((v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)))) as Rgb;
}

/**
 * Um "robô amarelo com uma plantinha": metade branco; um laranja enorme (matiz 50°) com uma cauda que vai
 * rareando até o amarelo-esverdeado (110°), sem nunca chegar a zero; e um verde pequeno e vivo (125°).
 */
const RW = 200, RH = 100;
function robot(): Uint8ClampedArray {
  const cols: Rgb[] = [];
  const push = (c: Rgb, n: number) => {
    for (let i = 0; i < n; i++) cols.push(c);
  };
  for (let i = 0; i < 6000; i++) push(lch(0.6, 0.12, 46 + (8 * i) / 6000), 1);
  // a cauda: cada vez menos pixels conforme o matiz se afasta do laranja (55° a 112°)
  const N = 4000, end = 1 - Math.exp(-57 / 14);
  for (let i = 0; i < N; i++) push(lch(0.75, 0.15, 55 - 14 * Math.log(1 - ((i + 0.5) / N) * end)), 1);
  for (let i = 0; i < 110; i++) push(lch(0.75, 0.2, 121 + (8 * i) / 110), 1);
  const d = new Uint8ClampedArray(RW * RH * 4).fill(255);
  cols.forEach((c, i) => d.set([c[0], c[1], c[2], 255], 4 * i));
  return d;
}

// branco 100x80; faixa preta em cima; bloco vermelho à esquerda; bloco verde à direita
const W = 100, H = 80;
const poster = () =>
  scene(W, H, WHITE, [
    [0, 0, 100, 16, BLACK],
    [10, 30, 50, 60, RED],
    [65, 30, 90, 50, GREEN],
  ], 3);

describe("oklab", () => {
  it("branco tem L 1 e croma 0; preto tem L 0", () => {
    const w = oklab(255, 255, 255), k = oklab(0, 0, 0);
    expect(w.L).toBeCloseTo(1, 3);
    expect(Math.hypot(w.a, w.b)).toBeLessThan(1e-3);
    expect(k.L).toBe(0);
  });

  it("o matiz separa vermelho, amarelo, verde e azul", () => {
    const hue = (r: number, g: number, b: number) => {
      const c = oklab(r, g, b);
      return ((Math.atan2(c.b, c.a) * 180) / Math.PI + 360) % 360;
    };
    expect(hue(255, 0, 0)).toBeCloseTo(29, 0);
    expect(hue(255, 255, 0)).toBeCloseTo(110, 0);
    expect(hue(0, 170, 60)).toBeCloseTo(147, 0);
    expect(hue(0, 0, 255)).toBeCloseTo(264, 0);
  });
});

describe("findPalette: as cores de caneta de uma imagem", () => {
  it("acha branco, preto, vermelho e verde, com o nome e a fatia de cada um", () => {
    const p = findPalette(poster(), W, H);
    expect(names(p).sort()).toEqual(["Branco", "Preto", "Verde", "Vermelho"]);
    expect(byName(p, "Preto").share).toBeCloseTo(0.2, 2);
    expect(byName(p, "Vermelho").share).toBeCloseTo(0.15, 2);
    expect(byName(p, "Verde").share).toBeCloseTo(0.0625, 2);
    expect(p.classes.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 6);
  });

  it("a cor de cada classe é a cor média dos pixels dela", () => {
    const p = findPalette(poster(), W, H);
    const red = byName(p, "Vermelho").rgb;
    expect(Math.abs(red[0] - RED[0])).toBeLessThan(8);
    expect(Math.abs(red[1] - RED[1])).toBeLessThan(8);
    expect(byName(p, "Vermelho").color).toMatch(/^#[0-9a-f]{6}$/);
    expect(byName(p, "Verde").neutral).toBe(false);
    expect(byName(p, "Preto").neutral).toBe(true);
  });

  it("dois tons do mesmo amarelo são uma classe só, não duas", () => {
    const p = findPalette(scene(W, H, WHITE, [[0, 0, 50, 80, [240, 200, 40]], [50, 0, 80, 80, [225, 180, 30]]], 3), W, H);
    expect(names(p).sort()).toEqual(["Amarelo", "Branco"]);
  });

  it("ferrugem e laranja (matizes a menos de 25° um do outro) são uma classe só", () => {
    const img = scene(W, H, WHITE, [[0, 0, 50, 80, [150, 80, 40]], [50, 0, 80, 80, [240, 150, 40]]]);
    const p = findPalette(img, W, H);
    expect(p.classes.filter((c) => !c.neutral).length).toBe(1);
    expect(p.classify(150, 80, 40)).toBe(p.classify(240, 150, 40));
  });

  it("laranja e amarelo-limão (matizes bem separados) são duas classes", () => {
    const p = findPalette(scene(W, H, WHITE, [[0, 0, 50, 80, [240, 130, 20]], [50, 0, 80, 80, [250, 240, 40]]], 2), W, H);
    expect(names(p).sort()).toEqual(["Amarelo", "Branco", "Laranja"]);
  });

  it("uma cor pequena e viva (a plantinha verde) é uma classe, mesmo sem vale fundo até a cor enorme ao lado", () => {
    const p = findPalette(robot(), RW, RH);
    expect(names(p).sort()).toEqual(["Branco", "Laranja", "Verde"]);
    expect(byName(p, "Verde").share).toBeGreaterThan(0.003);
    expect(byName(p, "Verde").share).toBeLessThan(0.02);
  });

  it("a divisa entre duas cores fica no vale entre elas, não no meio do caminho: o amarelo continua com o laranja", () => {
    const p = findPalette(robot(), RW, RH);
    const cls = (h: number) => p.classes[p.classify(...lch(0.8, 0.15, h))].name;
    expect(cls(55)).toBe("Laranja");
    expect(cls(95)).toBe("Laranja"); // amarelo: está na cauda do laranja, longe do pico dele e perto do verde
    expect(cls(125)).toBe("Verde");
  });

  it("a cor de uma classe puxa para os pixels mais vivos dela (o laranja vivo, não a ferrugem apagada)", () => {
    // metade ferrugem apagada, metade laranja vivo, mesmo matiz
    const dull = lch(0.5, 0.06, 55), vivid = lch(0.75, 0.17, 55);
    const p = findPalette(scene(W, H, WHITE, [[0, 0, 40, 80, dull], [40, 0, 80, 80, vivid]]), W, H);
    const c = p.classes.find((k) => !k.neutral)!;
    expect(Math.abs(c.rgb[0] - vivid[0])).toBeLessThan(Math.abs(c.rgb[0] - dull[0]));
  });

  it("cor que ocupa quase nada (uma borda suja) não vira classe", () => {
    const p = findPalette(scene(W, H, WHITE, [[0, 0, 100, 16, BLACK], [40, 40, 42, 41, RED]]), W, H);
    expect(names(p).sort()).toEqual(["Branco", "Preto"]);
  });

  it("imagem de uma cor só tem uma classe", () => {
    const p = findPalette(scene(40, 40, WHITE, []), 40, 40);
    expect(names(p)).toEqual(["Branco"]);
    expect(p.classes[0].share).toBe(1);
  });

  it("marrom (laranja escuro) e azul recebem o nome certo", () => {
    const p = findPalette(scene(W, H, WHITE, [[0, 0, 50, 40, [120, 70, 30]], [50, 40, 100, 80, [30, 60, 150]]]), W, H);
    expect(names(p).sort()).toEqual(["Azul", "Branco", "Marrom"]);
  });

  it("duas cores diferentes que cairiam no mesmo nome ganham nomes diferentes", () => {
    // verde-limão (matiz 130°) e verde-mar (matiz 165°): os dois se chamariam "Verde"
    const p = findPalette(scene(W, H, WHITE, [[0, 0, 40, 80, [150, 220, 40]], [50, 0, 90, 80, [0, 160, 120]]]), W, H);
    const chroma = p.classes.filter((c) => !c.neutral).map((c) => c.name);
    expect(chroma).toHaveLength(2);
    expect(new Set(chroma).size).toBe(2);
    expect(chroma.every((n) => n.startsWith("Verde"))).toBe(true);
  });

  it("classify devolve a classe mais próxima também para cores que não estavam na imagem", () => {
    const p = findPalette(poster(), W, H);
    const cls = (r: number, g: number, b: number) => p.classes[p.classify(r, g, b)].name;
    expect(cls(200, 40, 50)).toBe("Vermelho");
    expect(cls(120, 20, 30)).toBe("Vermelho"); // vinho: mesmo matiz
    expect(cls(20, 110, 50)).toBe("Verde");
    expect(cls(30, 30, 30)).toBe("Preto");
    expect(cls(245, 245, 240)).toBe("Branco");
    expect(cls(4, 4, 30)).toBe("Preto"); // quase preto com um fio de azul
  });
});

describe("paperClass: a cor que NÃO é desenhada", () => {
  it("desenhando o escuro, o papel é a classe grande mais clara; desenhando o claro, a mais escura", () => {
    const p = findPalette(poster(), W, H);
    expect(p.classes[paperClass(p, false)].name).toBe("Branco");
    expect(p.classes[paperClass(p, true)].name).toBe("Preto");
  });

  it("numa planta azul, desenhando o claro, o papel é o azul do fundo", () => {
    const p = findPalette(scene(W, H, [30, 60, 150], [[10, 10, 90, 12, WHITE], [10, 40, 12, 70, WHITE]]), W, H);
    expect(p.classes[paperClass(p, true)].name).toBe("Azul");
  });
});

describe("strokeColors: de que cor é cada traço", () => {
  const rgba = poster();
  const p = findPalette(rgba, W, H);
  const colorsOf = (subpaths: SubPath[], invert = false) => {
    const g: Geometry = { subpaths };
    return [...strokeColors(g, rgba, W, H, p, { paper: paperClass(p, invert) })].map((i) => p.classes[i].name);
  };

  it("um traço por cima de cada cor recebe a cor de onde passa", () => {
    expect(colorsOf([line(5, 8, 95, 8), line(15, 45, 45, 45), line(70, 40, 85, 40)])).toEqual(["Preto", "Vermelho", "Verde"]);
  });

  it("um contorno em cima da borda entre uma cor e o papel fica com a cor, não com o papel", () => {
    // exatamente na borda de cima do bloco vermelho (y = 30) e na borda esquerda do verde (x = 65)
    expect(colorsOf([line(12, 30, 48, 30), line(65, 32, 65, 48)])).toEqual(["Vermelho", "Verde"]);
  });

  it("um traço que passa por duas cores fica com a que ocupa a maior parte dele", () => {
    // 30 px no vermelho, 8 px no branco, 5 px no verde
    expect(colorsOf([line(22, 45, 70, 45)])).toEqual(["Vermelho"]);
  });

  it("um traço todo em cima do papel vai para a cor que mais desenha", () => {
    expect(colorsOf([line(5, 8, 95, 8), line(5, 10, 95, 10), line(15, 45, 45, 45), line(5, 70, 60, 70)])[3]).toBe("Preto");
  });

  it("desenhando o claro (papel preto), o traço em cima do branco é branco", () => {
    expect(colorsOf([line(5, 70, 60, 70), line(15, 45, 45, 45)], true)).toEqual(["Branco", "Vermelho"]);
  });

  it("curvas também são amostradas ao longo do caminho", () => {
    const curve: SubPath = { start: { x: 15, y: 35 }, segments: [{ kind: "cubic", c1: { x: 25, y: 58 }, c2: { x: 35, y: 58 }, to: { x: 45, y: 35 } }], closed: false };
    expect(colorsOf([curve])).toEqual(["Vermelho"]);
  });

  it("sem traços, devolve uma lista vazia", () => {
    expect(strokeColors({ subpaths: [] }, rgba, W, H, p, { paper: 0 }).length).toBe(0);
  });
});

describe("fundo escuro: quanto cada pixel se destaca do fundo", () => {
  it("backgroundRgb é a cor da moldura da imagem", () => {
    const bg = backgroundRgb(scene(W, H, [30, 60, 150], [[20, 20, 80, 60, WHITE]], 2), W, H);
    expect(Math.abs(bg[0] - 30)).toBeLessThanOrEqual(3);
    expect(Math.abs(bg[1] - 60)).toBeLessThanOrEqual(3);
    expect(Math.abs(bg[2] - 150)).toBeLessThanOrEqual(3);
  });

  it("em fundo preto, branco vale tudo, o vermelho vivo quase tudo (pela luminância valeria um terço) e o preto nada", () => {
    const img = scene(3, 1, [0, 0, 0], [[1, 0, 2, 1, WHITE], [2, 0, 3, 1, RED]]);
    const v = lightOnDark(img, 3, 1, [0, 0, 0]);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(255);
    expect(v[2]).toBeGreaterThan(215);
  });

  it("numa planta azul, o fundo vale zero e a linha branca vale tudo", () => {
    const bg: Rgb = [30, 60, 150];
    const v = lightOnDark(scene(2, 1, bg, [[1, 0, 2, 1, WHITE]]), 2, 1, bg);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(255);
  });

  it("uma linha fraca da grade da planta continua fraca (não é amplificada por estar num canal só)", () => {
    // fundo azul (2, 48, 120); a grade é só 18 a 20 níveis mais clara em cada canal
    const bg: Rgb = [2, 48, 120];
    const v = lightOnDark(scene(2, 1, bg, [[1, 0, 2, 1, [20, 66, 140]]]), 2, 1, bg);
    expect(v[1]).toBeGreaterThan(15);
    expect(v[1]).toBeLessThan(25);
  });

  it("imagem em tons de cinza sobre preto: é a própria luminância", () => {
    const v = lightOnDark(scene(3, 1, [0, 0, 0], [[1, 0, 2, 1, [128, 128, 128]], [2, 0, 3, 1, [40, 40, 40]]]), 3, 1, [0, 0, 0]);
    expect([...v]).toEqual([0, 128, 40]);
  });
});

describe("colorLayers: as camadas que a pessoa escolhe a caneta", () => {
  const GRAY: Rgb = [128, 128, 128];
  // branco; faixa preta; bloco cinza; bloco vermelho; bloco verde
  const rgba = scene(W, H, WHITE, [
    [0, 0, 100, 16, BLACK],
    [0, 62, 100, 80, GRAY],
    [10, 30, 50, 60, RED],
    [65, 30, 90, 50, GREEN],
  ]);
  const p = findPalette(rgba, W, H);
  const id = (n: string) => byName(p, n).id;
  const layersOf = (classes: string[], lengths: number[], paper = "Branco", parts?: number[], names = ["fino", "grosso"]) =>
    colorLayers(p, Uint8Array.from(classes.map(id)), lengths, id(paper), parts && { partOf: Uint8Array.from(parts), names });

  it("a paleta de teste tem as cinco classes", () => {
    expect(names(p).sort()).toEqual(["Branco", "Cinza", "Preto", "Verde", "Vermelho"]);
  });

  it("preto e cinza são a mesma caneta: viram uma camada só, chamada Preto", () => {
    const r = layersOf(["Preto", "Cinza", "Preto"], [50, 30, 20]);
    expect(r.layers.map((l) => l.name)).toEqual(["Preto"]);
    expect(r.layers[0].strokes).toBe(3);
    expect(r.layers[0].lengthPx).toBe(100);
    expect([...r.layerOf]).toEqual([0, 0, 0]);
  });

  it("cada cor de verdade é uma camada, da que tem mais traço para a que tem menos", () => {
    const r = layersOf(["Preto", "Vermelho", "Verde", "Vermelho", "Cinza"], [100, 40, 30, 20, 10]);
    expect(r.layers.map((l) => `${l.name} ${l.strokes} ${l.lengthPx}`)).toEqual(["Preto 2 110", "Vermelho 2 60", "Verde 1 30"]);
    expect([...r.layerOf]).toEqual([0, 1, 2, 1, 0]);
  });

  it("a cor da camada é a cor da classe (serve de amostra e para criar a caneta)", () => {
    const r = layersOf(["Preto", "Vermelho"], [100, 40]);
    expect(r.layers[1].color).toBe(byName(p, "Vermelho").color);
    expect(r.layers[1].key).toBe("Vermelho");
  });

  it("uma cor com menos de 0,3% do traço não vira camada: vai junto com o preto", () => {
    const r = layersOf(["Preto", "Vermelho", "Verde"], [1000, 300, 3]);
    expect(r.layers.map((l) => l.name)).toEqual(["Preto", "Vermelho"]);
    expect([...r.layerOf]).toEqual([0, 1, 0]);
    expect(r.layers[0].strokes).toBe(2);
  });

  it("em papel escuro (desenhando o claro), a camada sem cor se chama Branco", () => {
    const r = layersOf(["Branco", "Cinza", "Vermelho"], [80, 20, 50], "Preto");
    expect(r.layers.map((l) => l.name)).toEqual(["Branco", "Vermelho"]);
  });

  it("só cores, sem preto: a cor pequena vai para a maior", () => {
    const r = layersOf(["Vermelho", "Verde"], [1000, 2]);
    expect(r.layers.map((l) => l.name)).toEqual(["Vermelho"]);
    expect([...r.layerOf]).toEqual([0, 0]);
  });

  it("com a segunda divisão, cada cor que tem as duas partes vira duas camadas (fino e grosso)", () => {
    const r = layersOf(["Preto", "Preto", "Cinza", "Vermelho"], [50, 100, 30, 40], "Branco", [0, 1, 1, 1]);
    expect(r.layers.map((l) => `${l.name} ${l.strokes} ${l.lengthPx}`)).toEqual(["Preto grosso 2 130", "Preto fino 1 50", "Vermelho 1 40"]);
    expect(r.layers.map((l) => l.key)).toEqual(["Preto/grosso", "Preto/fino", "Vermelho"]);
    expect([...r.layerOf]).toEqual([1, 0, 0, 2]);
  });

  it("as duas partes de uma cor têm a mesma cor de amostra, e dizem qual parte são", () => {
    const r = layersOf(["Preto", "Preto"], [50, 100], "Branco", [0, 1]);
    expect(r.layers[0].color).toBe(r.layers[1].color);
    expect(r.layers.map((l) => l.part)).toEqual(["grosso", "fino"]);
    expect(layersOf(["Preto"], [50]).layers[0].part).toBeUndefined();
  });

  it("uma parte com quase nenhum traço não vira camada: fica com a outra parte da mesma cor", () => {
    const r = layersOf(["Preto", "Preto", "Vermelho"], [2, 1000, 300], "Branco", [0, 1, 1]);
    expect(r.layers.map((l) => l.name)).toEqual(["Preto", "Vermelho"]);
    expect([...r.layerOf]).toEqual([0, 0, 1]);
  });

  it("os nomes das partes vêm de quem pediu a divisão (contornos e sombras, na Ilustração)", () => {
    const r = layersOf(["Preto", "Preto"], [80, 60], "Branco", [0, 1], ["contornos", "sombras"]);
    expect(r.layers.map((l) => l.name)).toEqual(["Preto contornos", "Preto sombras"]);
  });

  it("sem traços, nenhuma camada", () => {
    expect(colorLayers(p, new Uint8Array(0), [], 0)).toEqual({ layers: [], layerOf: new Uint8Array(0) });
  });
});
