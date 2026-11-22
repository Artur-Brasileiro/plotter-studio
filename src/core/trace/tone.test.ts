import { describe, expect, it } from "vitest";
import { equalizeTones } from "./tone";

describe("equalizeTones: realce dos tons", () => {
  const lowKey = () => Float32Array.from({ length: 1000 }, (_, i) => Math.pow(i / 999, 4)); // quase tudo perto de zero

  it("com zero não muda nada", () => {
    const t = lowKey();
    expect([...equalizeTones(t, 0)]).toEqual([...lowKey()]);
  });

  it("com tudo, cada tom vai para a posição que ocupa entre os outros (a mediana vai para o meio)", () => {
    const t = equalizeTones(lowKey(), 1);
    expect(lowKey()[750]).toBeLessThan(0.35); // antes: três quartos da imagem abaixo de 35% de escuro
    expect(t[750]).toBeGreaterThan(0.6);
    expect(t[999]).toBeCloseTo(1, 2);
  });

  it("a ordem dos tons nunca muda", () => {
    const t = equalizeTones(lowKey(), 0.7);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
  });

  it("o papel (tom zero) continua papel, e não entra na conta", () => {
    const t = new Float32Array(1000); // 90% papel
    for (let i = 900; i < 1000; i++) t[i] = 0.2 + (0.6 * (i - 900)) / 99;
    equalizeTones(t, 1);
    expect(t[0]).toBe(0);
    expect(t[899]).toBe(0);
    expect(t[950]).toBeGreaterThan(0.4); // o meio dos tons, não "acima de 95% dos pixels"
    expect(t[950]).toBeLessThan(0.6);
  });

  it("tons já bem distribuídos ficam praticamente iguais", () => {
    const t = Float32Array.from({ length: 1000 }, (_, i) => (i + 1) / 1000);
    const before = [...t];
    equalizeTones(t, 1);
    for (let i = 30; i < 1000; i++) expect(Math.abs(t[i] - before[i])).toBeLessThan(0.03);
  });

  it("imagem toda papel não dá erro", () => {
    expect([...equalizeTones(new Float32Array(10), 1)]).toEqual(new Array(10).fill(0));
  });
});
