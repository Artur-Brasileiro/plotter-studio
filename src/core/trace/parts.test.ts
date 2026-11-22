import { describe, expect, it } from "vitest";
import { strokeParts } from "./parts";
import { STROKE_KIND as K } from "./traceImage";

const result = (kinds: number[], widthsPx: number[]) => ({ kinds: Uint8Array.from(kinds), widthsPx: Float32Array.from(widthsPx) });

describe("strokeParts: a segunda divisão das camadas (além da cor)", () => {
  it("Traço: fino até o limite, grosso acima dele; o pontinho segue a mesma regra", () => {
    const p = strokeParts(result([K.stroke, K.stroke, K.stroke, K.dot], [1, 2, 6, 1]), "line", 0.2, 0.5)!;
    expect(p.names).toEqual(["fino", "grosso"]);
    expect([...p.partOf]).toEqual([0, 0, 1, 0]); // 0,2 mm, 0,4 mm, 1,2 mm, 0,2 mm
  });

  it("a largura é medida NO PAPEL: a mesma linha de 2 px é fina num desenho pequeno e grossa num grande", () => {
    const r = result([K.stroke], [2]);
    expect([...strokeParts(r, "line", 0.2, 0.5)!.partOf]).toEqual([0]);
    expect([...strokeParts(r, "line", 0.5, 0.5)!.partOf]).toEqual([1]);
  });

  it("o limite é da pessoa: subir o limite passa mais traços para o fino", () => {
    const r = result([K.stroke, K.stroke], [2, 6]);
    expect([...strokeParts(r, "line", 0.2, 0.3)!.partOf]).toEqual([1, 1]);
    expect([...strokeParts(r, "line", 0.2, 2)!.partOf]).toEqual([0, 0]);
  });

  it("Preto e branco: o contorno e a hachura de uma área cheia são sempre do grosso", () => {
    const p = strokeParts(result([K.stroke, K.outline, K.hatch], [1, 0, 0]), "ink", 0.2, 0.5)!;
    expect(p.names).toEqual(["fino", "grosso"]);
    expect([...p.partOf]).toEqual([0, 1, 1]);
  });

  it("Ilustração: a divisão é entre contornos e sombras (a hachura)", () => {
    const p = strokeParts(result([K.hatch, K.stroke, K.stroke], [0, 3, 3]), "illus", 0.4, 0.5)!;
    expect(p.names).toEqual(["contornos", "sombras"]);
    expect([...p.partOf]).toEqual([1, 0, 0]);
  });

  it("Foto: é tudo hachura, não há o que separar", () => {
    expect(strokeParts(result([K.hatch, K.hatch], [0, 0]), "photo", 0.4, 0.5)).toBeUndefined();
  });
});
