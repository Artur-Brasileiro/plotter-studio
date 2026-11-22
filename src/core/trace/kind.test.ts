import { describe, expect, it } from "vitest";
import { analyzeImage, faintForPattern, suggestedMode } from "./kind";

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [10, 10, 12];
const BLUE: Rgb = [8, 52, 124];

/** Tela de pintura: começa com o fundo e recebe retângulos, linhas e discos. */
function canvas(w: number, h: number, bg: Rgb) {
  const d = new Uint8ClampedArray(w * h * 4);
  const put = (x: number, y: number, c: Rgb) => {
    if (x >= 0 && y >= 0 && x < w && y < h) d.set([c[0], c[1], c[2], 255], 4 * (y * w + x));
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, bg);
  const api = {
    data: d,
    rect(x0: number, y0: number, x1: number, y1: number, c: Rgb) {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, c);
      return api;
    },
    /** linhas horizontais e verticais de `t` px, de `step` em `step` */
    grid(step: number, t: number, c: Rgb, x0 = 0, y0 = 0, x1 = w, y1 = h) {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if ((x - x0) % step < t || (y - y0) % step < t) put(x, y, c);
      return api;
    },
    disc(cx: number, cy: number, r: number, c: Rgb) {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(x, y, c);
      return api;
    },
  };
  return api;
}
const W = 600, H = 400;
const kindOf = (c: { data: Uint8ClampedArray }, w = W, h = H) => analyzeImage(c.data, w, h);

/** Um desenho de linhas: uma malha de traços de 2 px no miolo da imagem, margem limpa. */
const lineArt = (bg: Rgb, ink: Rgb) => canvas(W, H, bg).grid(26, 2, ink, 60, 50, 540, 350);

describe("analyzeImage: a imagem é um desenho de linhas?", () => {
  it("traço fino preto em papel branco: quase tudo fundo, e o que não é fundo é fino", () => {
    const k = kindOf(lineArt(WHITE, BLACK));
    expect(k.background).toBeGreaterThan(0.7);
    expect(k.thin).toBeGreaterThan(0.95);
    expect(k.solid).toBeLessThan(0.01);
    expect(suggestedMode(k)).toBe("line");
  });

  it("planta azul (traço branco em fundo azul) também é desenho de linhas", () => {
    expect(suggestedMode(kindOf(lineArt(BLUE, WHITE)))).toBe("line");
  });

  it("linhas mais um letreiro cheio: o tipo é o Preto e branco, que pinta a área cheia", () => {
    const k = kindOf(lineArt(WHITE, BLACK).rect(80, 8, 240, 38, BLACK));
    expect(k.thin).toBeGreaterThan(0.78);
    expect(k.solid).toBeGreaterThan(0.04);
    expect(suggestedMode(k)).toBe("ink");
  });

  it("pintura de formas largas não é desenho de linhas: nenhuma sugestão", () => {
    const k = kindOf(canvas(W, H, WHITE).rect(80, 60, 360, 340, [230, 190, 40]).disc(430, 200, 90, [40, 90, 160]));
    expect(k.thin).toBeLessThan(0.4);
    expect(suggestedMode(k)).toBeUndefined();
  });

  it("foto (tons por toda parte, sem fundo liso): nenhuma sugestão", () => {
    const c = canvas(W, H, WHITE);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) c.rect(x, y, x + 1, y + 1, [Math.round((255 * x) / W), Math.round((255 * y) / H), 120]);
    const k = kindOf(c);
    expect(k.background).toBeLessThan(0.55);
    expect(suggestedMode(k)).toBeUndefined();
  });

  it("cena escura com manchas de luz (render): as manchas são largas, não é desenho de linhas", () => {
    const c = canvas(W, H, [12, 8, 4]);
    for (let i = 0; i < 40; i++) c.disc(40 + ((i * 97) % 520), 40 + ((i * 61) % 320), 14 + (i % 5) * 3, [150 + (i % 4) * 20, 110, 40]);
    expect(suggestedMode(kindOf(c))).toBeUndefined();
  });

  it("imagem grande é medida numa cópia reduzida: o mesmo desenho, 4 vezes maior, dá a mesma resposta", () => {
    const big = canvas(4 * W, 4 * H, WHITE).grid(104, 8, BLACK, 240, 200, 2160, 1400);
    const k = analyzeImage(big.data, 4 * W, 4 * H);
    expect(suggestedMode(k)).toBe("line");
    expect(k.thin).toBeGreaterThan(0.95);
  });

  it("imagem toda lisa: nada a sugerir, e nenhum erro", () => {
    const k = kindOf(canvas(W, H, WHITE));
    expect(k.background).toBe(1);
    expect(suggestedMode(k)).toBeUndefined();
  });
});

describe("a grade fraca do fundo de uma planta", () => {
  /** planta azul com a grade do papel (um azul um pouco mais claro) por toda a folha, e o desenho em branco */
  const blueprint = (gridTone: Rgb) => canvas(W, H, BLUE).grid(13, 1, gridTone).grid(26, 2, WHITE, 60, 50, 540, 350);

  it("acha a grade e diz o quanto ela se destaca do fundo", () => {
    const k = kindOf(blueprint([40, 84, 156])); // 32 níveis acima do fundo: uns 13% do caminho até o branco
    expect(k.faintLevel).toBeGreaterThan(0.08);
    expect(k.faintLevel).toBeLessThan(0.2);
  });

  it("a grade não muda o veredito: continua sendo desenho de linhas", () => {
    expect(suggestedMode(kindOf(blueprint([40, 84, 156])))).toBe("line");
  });

  it("linhas fracas do PRÓPRIO desenho (curtas, não atravessam a folha) não são grade", () => {
    // um desenho a lápis: traço forte e, ao lado, hachuras claras que fazem parte dele
    const c = canvas(W, H, WHITE).grid(26, 2, BLACK, 60, 50, 300, 350);
    for (let i = 0; i < 140; i++) c.rect(320 + ((i * 37) % 150), 40 + ((i * 2) % 320), 320 + ((i * 37) % 150) + 90, 41 + ((i * 2) % 320), [205, 205, 205]);
    for (let i = 0; i < 70; i++) c.rect(322 + i * 3, 50 + ((i * 53) % 220), 323 + i * 3, 50 + ((i * 53) % 220) + 80, [205, 205, 205]);
    expect(kindOf(c).faintLevel).toBe(0);
  });

  it("numa grade com linhas mestras mais fortes, o nível é o das mestras (senão elas sobrariam)", () => {
    const c = canvas(W, H, BLUE).grid(13, 1, [30, 74, 146]).grid(130, 1, [58, 102, 174]).grid(26, 2, WHITE, 60, 50, 540, 350);
    const k = kindOf(c);
    expect(k.faintLevel).toBeGreaterThan(0.17); // as mestras estão 50 níveis acima do fundo: 20%
    expect(k.faintLevel).toBeLessThan(0.26);
  });

  it("sem grade, o nível é zero", () => {
    expect(kindOf(lineArt(BLUE, WHITE)).faintLevel).toBe(0);
  });

  it("um papel um pouco mais escuro que a moldura (um tom só, sem padrão) não é grade", () => {
    // a moldura é branca e o miolo é um cinza-claro liso: é diferença de tom, não um padrão de linhas
    const c = canvas(W, H, WHITE).rect(20, 20, 580, 380, [236, 236, 236]).grid(26, 2, BLACK, 60, 50, 540, 350);
    expect(kindOf(c).faintLevel).toBe(0);
  });

  it("uma moldura (duas linhas de cada lado) não é grade", () => {
    const c = canvas(W, H, WHITE).grid(26, 2, BLACK, 60, 50, 540, 350);
    for (const y of [12, 388]) c.rect(0, y, W, y + 1, [215, 215, 215]);
    for (const x of [12, 588]) c.rect(x, 0, x + 1, H, [215, 215, 215]);
    expect(kindOf(c).faintLevel).toBe(0);
  });

  it("a moldura do desenho, mais forte que a grade, não entra no nível da grade", () => {
    const c = canvas(W, H, BLUE).grid(13, 1, [40, 84, 156]);
    for (const y of [6, 393]) c.rect(0, y, W, y + 1, [110, 150, 215]); // moldura: 40% do caminho até o branco
    for (const x of [6, 593]) c.rect(x, 0, x + 1, H, [110, 150, 215]);
    c.grid(26, 2, WHITE, 60, 50, 540, 350);
    const k = kindOf(c);
    expect(k.faintLevel).toBeGreaterThan(0.08);
    expect(k.faintLevel).toBeLessThan(0.2);
  });

  it("faintForPattern: 'Linhas claras' desce até a grade ficar de fora, e nunca sobe", () => {
    expect(faintForPattern(0.24, 0.6)).toBeCloseTo(0.25, 5); // a planta de verdade que serviu de medida
    expect(faintForPattern(0.13, 0.6)).toBe(0.6); // grade bem fraca: o padrão já a deixa de fora
    expect(faintForPattern(0.24, 0.15)).toBe(0.15); // a pessoa já usa menos que o necessário: fica
    expect(faintForPattern(0.33, 0.6)).toBe(0.1); // piso: abaixo disso o desenho começa a sumir
    expect(faintForPattern(0, 0.6)).toBe(0.6);
  });
});
