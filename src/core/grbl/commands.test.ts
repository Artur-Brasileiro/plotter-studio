import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../machine";
import { clampToArea, classifyManualCommand, compareSettings, edgeTarget, frameProgram, jogRelative, jogTo, stepTarget } from "./commands";

const AREA = { width: 810, height: 385 };

describe("jog", () => {
  it("formata os comandos $J", () => {
    expect(jogRelative({ x: 10, y: 0 }, 3000)).toBe("$J=G91 G21 X10.00 Y0.00 F3000");
    expect(jogRelative({ x: -0.1, y: 2.5 }, 2999.6)).toBe("$J=G91 G21 X-0.10 Y2.50 F3000");
    expect(jogTo({ x: 0, y: 0 }, 6000)).toBe("$J=G90 G21 X0.00 Y0.00 F6000");
  });

  it("clampToArea com margem", () => {
    expect(clampToArea({ x: -5, y: 400 }, AREA)).toEqual({ x: 0, y: 385 });
    expect(clampToArea({ x: 900, y: -1 }, AREA, 0.5)).toEqual({ x: 809.5, y: 0.5 });
    expect(clampToArea({ x: 100, y: 100 }, AREA, 0.5)).toEqual({ x: 100, y: 100 });
  });

  it("passo não sai da área e não anda para trás", () => {
    expect(stepTarget({ x: 100, y: 100 }, { x: 10, y: -10 }, AREA)).toEqual({ x: 110, y: 90 });
    expect(stepTarget({ x: 805, y: 2 }, { x: 10, y: -10 }, AREA)).toEqual({ x: 809.5, y: 0.5 });
    // logo depois do Home a máquina está em 810/385: "+X" não pode recuar para 809,5
    expect(stepTarget({ x: 810, y: 385 }, { x: 1, y: 0 }, AREA)).toEqual({ x: 810, y: 385 });
    expect(stepTarget({ x: 810, y: 385 }, { x: -1, y: 0 }, AREA)).toEqual({ x: 809, y: 385 });
  });

  it("jog contínuo vai até a borda na direção pedida", () => {
    expect(edgeTarget({ x: 100, y: 100 }, { x: 1, y: 0 }, AREA)).toEqual({ x: 809.5, y: 100 });
    expect(edgeTarget({ x: 100, y: 100 }, { x: 0, y: -1 }, AREA)).toEqual({ x: 100, y: 0.5 });
    const d = edgeTarget({ x: 100, y: 100 }, { x: 1, y: 1 }, AREA);
    expect(d.y).toBeCloseTo(384.5);
    expect(d.x).toBeCloseTo(384.5);
    expect(edgeTarget({ x: 809.9, y: 100 }, { x: 1, y: 0 }, AREA)).toEqual({ x: 809.9, y: 100 });
  });
});

describe("frameProgram", () => {
  it("levanta a caneta e só tem G0 dentro da área", () => {
    const lines = frameProgram({ minX: -3, minY: 10, maxX: 120, maxY: 400 }, DEFAULT_PROFILE);
    expect(lines[0]).toBe("M5");
    expect(lines[1]).toBe("G4 P0.3");
    const moves = lines.filter((l) => l.startsWith("G0 "));
    expect(moves).toEqual(["G0 X0.00 Y10.00", "G0 X120.00 Y10.00", "G0 X120.00 Y385.00", "G0 X0.00 Y385.00", "G0 X0.00 Y10.00"]);
    expect(lines.some((l) => l.startsWith("G1") || l.startsWith("M3"))).toBe(false);
  });
});

describe("classifyManualCommand", () => {
  it.each(["$H", "?", "G0 X10", "$$", "$#", "$X", "$J=G91 X1 F100", "M3 S220"])("%s passa", (c) => {
    expect(classifyManualCommand(c).kind).toBe("ok");
  });

  it.each(["$32=1", "$32 = 1", "$32=1.0", "G1 X10 ç", "G1 X10 ; coração"])("%s é bloqueado", (c) => {
    expect(classifyManualCommand(c).kind).toBe("blocked");
  });

  it.each(["$110=8000", "$32=0", "$RST=*", "$N0=G0X0", "$I=teste", "G10 L2 P1 X0", "g10l20p1x0", "G28.1", "G30.1"])("%s pede confirmação", (c) => {
    expect(classifyManualCommand(c).kind).toBe("confirm");
  });

  it("G1 ou G100 não confundem com G10", () => {
    expect(classifyManualCommand("G1 X10 F100").kind).toBe("ok");
    expect(classifyManualCommand("G0 X10 (G10 no comentario)").kind).toBe("ok");
  });
});

describe("compareSettings", () => {
  const good = new Map(
    Object.entries({ 11: "0.010", 20: "1", 22: "1", 32: "0", 110: "12000.000", 111: "12000.000", 120: "800.000", 121: "800.000", 130: "810.000", 131: "385.000" }).map(
      ([k, v]) => [Number(k), v] as const,
    ),
  );
  const g54 = { x: -810, y: -385 };

  it("configuração igual ao perfil: nenhum aviso", () => {
    expect(compareSettings(good, g54, DEFAULT_PROFILE)).toEqual([]);
  });

  it("avisa $32=1, $20=0, área e G54 errados", () => {
    const bad = new Map(good);
    bad.set(32, "1");
    bad.set(20, "0");
    bad.set(130, "800.000");
    const w = compareSettings(bad, { x: -800, y: -385 }, DEFAULT_PROFILE);
    expect(w.some((s) => s.includes("$32"))).toBe(true);
    expect(w.some((s) => s.includes("$20"))).toBe(true);
    expect(w.some((s) => s.includes("$130"))).toBe(true);
    expect(w.some((s) => s.includes("G54"))).toBe(true);
  });

  it("sem $$ lido", () => {
    expect(compareSettings(new Map(), undefined, DEFAULT_PROFILE)).toHaveLength(1);
  });
});
