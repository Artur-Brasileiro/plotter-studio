import { describe, expect, it } from "vitest";
import { estimateCurrentLine, programTargets } from "./progress";

const prog = (texts: string[]) => ({ lines: texts.map((text) => ({ text, strokeIndex: -1 })) });

describe("programTargets", () => {
  it("só linhas G0/G1 com X e Y; o from é o destino anterior", () => {
    const t = programTargets(prog(["G21", "G0 X10.00 Y10.00", "M3 S220", "G1 X20.00 Y10.00 F1000", "G4 P0.3"]));
    expect(t.to[1]).toEqual({ x: 10, y: 10 });
    expect(t.from[1]).toEqual({ x: 10, y: 10 });
    expect(t.from[3]).toEqual({ x: 10, y: 10 });
    expect(t.to[3]).toEqual({ x: 20, y: 10 });
    expect(t.to[0]).toBeUndefined();
    expect(t.to[2]).toBeUndefined();
  });
});

describe("estimateCurrentLine", () => {
  // quadrado fechado: começa e termina em (0,0)
  const t = programTargets(prog(["G0 X0.00 Y0.00", "M3 S220", "G1 X10.00 Y0.00 F1000", "G1 X10.00 Y10.00", "G1 X0.00 Y10.00", "G1 X0.00 Y0.00", "M5"]));

  it("escolhe o segmento mais próximo da posição", () => {
    expect(estimateCurrentLine(t, 5, { x: 10, y: 5 })).toBe(3);
    expect(estimateCurrentLine(t, 5, { x: 5, y: 10 })).toBe(4);
  });

  it("no ponto em que o contorno fecha: empate fica com a mais antiga, mas nunca volta", () => {
    expect(estimateCurrentLine(t, 5, { x: 0, y: 0 })).toBe(0);
    expect(estimateCurrentLine(t, 5, { x: 0, y: 0 }, 4)).toBe(5);
  });

  it("só olha a janela das últimas linhas com ok", () => {
    expect(estimateCurrentLine(t, 3, { x: 5, y: 10 })).toBe(3);
    expect(estimateCurrentLine(t, 5, { x: 10, y: 5 }, 0, 1)).toBe(5);
  });
});
