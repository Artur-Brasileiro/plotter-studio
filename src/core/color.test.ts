import { describe, expect, it } from "vitest";
import { isDark, luminance, parseHex, toHex } from "./color";

describe("cores (#rrggbb)", () => {
  it("lê #rrggbb e #rgb, com ou sem maiúsculas", () => {
    expect(parseHex("#ffffff")).toEqual([255, 255, 255]);
    expect(parseHex("#10151F")).toEqual([16, 21, 31]);
    expect(parseHex("#f00")).toEqual([255, 0, 0]);
  });

  it("recusa o que não é cor", () => {
    expect(parseHex("vermelho")).toBeUndefined();
    expect(parseHex("#12")).toBeUndefined();
    expect(parseHex("#gggggg")).toBeUndefined();
  });

  it("escreve de volta em #rrggbb, arredondando e limitando a 0–255", () => {
    expect(toHex(255, 0, 16)).toBe("#ff0010");
    expect(toHex(300, -5, 127.6)).toBe("#ff0080");
  });

  it("luminância: 0 no preto, 1 no branco, e o verde pesa mais que o azul", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 6);
    expect(luminance("#00ff00")).toBeGreaterThan(luminance("#0000ff"));
  });

  it("papel preto e azul-marinho são escuros; branco, kraft e amarelo são claros", () => {
    expect(isDark("#000000")).toBe(true);
    expect(isDark("#14213d")).toBe(true);
    expect(isDark("#ffffff")).toBe(false);
    expect(isDark("#c9a56b")).toBe(false);
    expect(isDark("#ffe94a")).toBe(false);
  });

  it("cor ilegível conta como clara (o papel padrão é branco)", () => {
    expect(isDark("nada")).toBe(false);
    expect(luminance("nada")).toBe(1);
  });
});
