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

  it("formato de REGRAS_GCODE.md: 'G1 F500' não é movimento; as linhas só com X/Y são (modal), com ou sem F", () => {
    const t = programTargets(
      prog([
        "; Plotter Studio - teste",
        "G21",
        "G90",
        "M5",
        "G4 P0.3",
        "G0 X100.00 Y100.00", // 5
        "M3 S220",
        "G4 P0.6",
        "G1 F500", // 8
        "X110.00 Y100.00", // 9
        "X110.00 Y120.00 F1200", // 10
        "Y130.00", // 11: só um eixo
        "M5",
        "G4 P0.2",
        "; CHECKPOINT 1 (~10 min) re-sincroniza servo",
        "G0 X0.00 Y0.00", // 15
        "M2",
      ]),
    );
    expect(t.to[8]).toBeUndefined();
    expect(t.from[9]).toEqual({ x: 100, y: 100 });
    expect(t.to[9]).toEqual({ x: 110, y: 100 });
    expect(t.to[10]).toEqual({ x: 110, y: 120 });
    expect(t.from[11]).toEqual({ x: 110, y: 120 });
    expect(t.to[11]).toEqual({ x: 110, y: 130 });
    expect(t.to[15]).toEqual({ x: 0, y: 0 });
    expect(t.to.filter(Boolean)).toHaveLength(5);
  });

  it("G4, comentários e comandos $ nunca viram alvo; G91 soma; G80 desliga o modo", () => {
    const t = programTargets(prog(["G0 X10 Y10", "G4 P1 X99", "; X5 Y5", "(X1 Y1)", "$J=G91 X1 F100", "G91", "X5 Y-2", "G90", "G80", "X50 Y50"]));
    expect(t.to[1]).toBeUndefined();
    expect(t.to[2]).toBeUndefined();
    expect(t.to[3]).toBeUndefined();
    expect(t.to[4]).toBeUndefined();
    expect(t.to[6]).toEqual({ x: 15, y: 8 });
    expect(t.to[9]).toBeUndefined();
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
