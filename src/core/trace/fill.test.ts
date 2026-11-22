import { describe, expect, it } from "vitest";
import { findContours, loopArea } from "./contours";
import { hatchField } from "./hatch";

/** Campo "distância até a borda de um disco": positivo dentro, negativo fora. */
function disc(size: number, cx: number, cy: number, r: number): Float32Array {
  const f = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) f[y * size + x] = r - Math.hypot(x - cx, y - cy);
  return f;
}
const polyLen = (p: Float64Array) => {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
};

describe("findContours (curvas de nível)", () => {
  it("disco: um laço fechado, no raio certo com precisão sub-pixel", () => {
    const loops = findContours(disc(100, 50, 50, 30), 100, 100, 0);
    expect(loops).toHaveLength(1);
    const l = loops[0];
    let worst = 0;
    for (let i = 0; i < l.length; i += 2) worst = Math.max(worst, Math.abs(Math.hypot(l[i] - 50, l[i + 1] - 50) - 30));
    expect(worst).toBeLessThan(0.05);
    expect(Math.abs(loopArea(l))).toBeCloseTo(Math.PI * 900, -1);
  });

  it("nível diferente de zero desloca o contorno para dentro", () => {
    const [l] = findContours(disc(100, 50, 50, 30), 100, 100, 5);
    for (let i = 0; i < l.length; i += 2) expect(Math.hypot(l[i] - 50, l[i + 1] - 50)).toBeCloseTo(25, 1);
  });

  it("anel: dois laços (fora e dentro); dois discos: dois laços", () => {
    const ring = new Float32Array(100 * 100);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) ring[y * 100 + x] = 8 - Math.abs(Math.hypot(x - 50, y - 50) - 25);
    expect(findContours(ring, 100, 100, 0)).toHaveLength(2);
    const two = disc(100, 25, 50, 15);
    const b = disc(100, 75, 50, 15);
    for (let i = 0; i < two.length; i++) two[i] = Math.max(two[i], b[i]);
    expect(findContours(two, 100, 100, 0)).toHaveLength(2);
  });

  it("região que encosta na borda da imagem ainda fecha o laço", () => {
    const f = new Float32Array(20 * 20).fill(1); // tudo dentro
    const loops = findContours(f, 20, 20, 0.5);
    expect(loops).toHaveLength(1);
    expect(Math.abs(loopArea(loops[0]))).toBeGreaterThan(300);
  });

  it("campo todo abaixo do nível: nenhum laço", () => {
    expect(findContours(new Float32Array(100).fill(-1), 10, 10, 0)).toEqual([]);
  });
});

describe("hatchField (hachura)", () => {
  const f = disc(200, 100, 100, 60);
  const inside = (p: Float64Array, tol: number) => {
    for (let i = 0; i < p.length; i += 2) if (Math.hypot(p[i] - 100, p[i + 1] - 100) > 60 + tol) return false;
    return true;
  };

  it("linhas a 45° com o espaçamento pedido, todas dentro da região", () => {
    const lines = hatchField(f, 200, 200, 0, { angleDeg: 45, spacing: 10, link: 0 });
    expect(lines.length).toBeGreaterThanOrEqual(11);
    expect(lines.length).toBeLessThanOrEqual(13);
    for (const l of lines) {
      expect(l.length).toBe(4);
      expect(inside(l, 0.3)).toBe(true);
      // direção: 45° subindo para a direita (dy = −dx na tela)
      expect(Math.abs((l[2] - l[0]) + (l[3] - l[1]))).toBeLessThan(1e-6);
    }
    // a maior linha passa perto do diâmetro
    expect(Math.max(...lines.map(polyLen))).toBeGreaterThan(115);
  });

  it("emendadas em zigue-zague: uma descida só para o disco inteiro", () => {
    // perto das pontas do disco as linhas encurtam e a ligação fica mais longa: 30 px dá para todas
    const lines = hatchField(f, 200, 200, 0, { angleDeg: 45, spacing: 10, link: 30 });
    expect(lines).toHaveLength(1);
    expect(inside(lines[0], 0.3)).toBe(true);
    // o zigue-zague alterna o sentido: cada linha começa perto de onde a anterior terminou
    const p = lines[0];
    for (let i = 4; i + 3 < p.length; i += 4) expect(Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])).toBeLessThan(30);
  });

  it("ligação mais longa que o limite não é feita: a caneta levanta", () => {
    const joined = hatchField(f, 200, 200, 0, { angleDeg: 45, spacing: 10, link: 30 });
    const strict = hatchField(f, 200, 200, 0, { angleDeg: 45, spacing: 10, link: 15 });
    expect(strict.length).toBeGreaterThan(joined.length);
    const count = (ls: Float64Array[]) => ls.reduce((a, l) => a + l.length / 4, 0);
    expect(count(strict)).toBe(count(joined)); // as mesmas linhas, só menos emendas
  });

  it("nível = meia caneta: as linhas param antes da borda", () => {
    const lines = hatchField(f, 200, 200, 4, { angleDeg: 0, spacing: 8, link: 0 });
    for (const l of lines) for (let i = 0; i < l.length; i += 2) expect(Math.hypot(l[i] - 100, l[i + 1] - 100)).toBeLessThan(56.3);
  });

  it("duas regiões separadas não são emendadas pelo branco", () => {
    const two = disc(200, 50, 100, 30);
    const b = disc(200, 150, 100, 30);
    for (let i = 0; i < two.length; i++) two[i] = Math.max(two[i], b[i]);
    const lines = hatchField(two, 200, 200, 0, { angleDeg: 90, spacing: 6 });
    expect(lines).toHaveLength(2);
  });

  it("região vazia ou espaçamento inválido: nada", () => {
    expect(hatchField(new Float32Array(100).fill(-1), 10, 10, 0, { angleDeg: 45, spacing: 2 })).toEqual([]);
    expect(hatchField(f, 200, 200, 0, { angleDeg: 45, spacing: 0 })).toEqual([]);
  });
});
