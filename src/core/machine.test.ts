import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, mergeProfile, validateProfile } from "./machine";

describe("DEFAULT_PROFILE", () => {
  it("bate com a configuração gravada no GRBL", () => {
    expect(DEFAULT_PROFILE.workArea).toEqual({ width: 810, height: 385 });
    expect(DEFAULT_PROFILE.pen.upCmd).toBe("M5");
    expect(DEFAULT_PROFILE.pen.downCmd).toBe("M3 S220");
    expect(DEFAULT_PROFILE.motion.maxRateMmMin).toBe(12000);
    expect(DEFAULT_PROFILE.motion.accelMmS2).toBe(800);
  });

  it("todos os gabaritos de papel cabem na área útil", () => {
    const { width, height } = DEFAULT_PROFILE.workArea;
    for (const t of DEFAULT_PROFILE.paperTemplates) {
      expect(t.x + t.width).toBeLessThanOrEqual(width);
      expect(t.y + t.height).toBeLessThanOrEqual(height);
    }
  });

  it("o padrão é válido", () => {
    expect(validateProfile(DEFAULT_PROFILE)).toEqual([]);
  });
});

describe("mergeProfile", () => {
  it("undefined → padrão", () => {
    expect(mergeProfile(undefined)).toEqual(DEFAULT_PROFILE);
  });

  it("perfil antigo (sem dynamic/motion) ganha os padrões e mantém o que tinha", () => {
    const old = { workArea: { width: 800, height: 380 }, feed: { fixed: 900, straight: 1500, curve: 1000, tightCurve: 500 } };
    const p = mergeProfile(old);
    expect(p.workArea).toEqual({ width: 800, height: 380 });
    expect(p.feed.straight).toBe(1500);
    expect(p.dynamic).toEqual(DEFAULT_PROFILE.dynamic);
    expect(p.motion).toEqual(DEFAULT_PROFILE.motion);
  });

  it("ignora chaves desconhecidas e tipos errados", () => {
    const p = mergeProfile({ lixo: 1, feed: { fixed: "rápido" }, pen: { pauseLift: "outro" } });
    expect("lixo" in p).toBe(false);
    expect(p.feed.fixed).toBe(DEFAULT_PROFILE.feed.fixed);
    expect(p.pen.pauseLift).toBe("spindleStop");
  });

  it("não compartilha objetos com o padrão", () => {
    const p = mergeProfile(undefined);
    p.workArea.width = 1;
    expect(DEFAULT_PROFILE.workArea.width).toBe(810);
  });
});

describe("validateProfile", () => {
  it("acusa F acima do máximo, '$' e não-ASCII nos comandos da caneta", () => {
    const p = mergeProfile(undefined);
    p.feed.straight = 20000;
    p.pen.downCmd = "M3 S220 $32=1";
    p.pen.upCmd = "M5 ç";
    const errs = validateProfile(p);
    expect(errs.some((e) => e.includes("Velocidade em retas"))).toBe(true);
    expect(errs.some((e) => e.includes('"$"'))).toBe(true);
    expect(errs.some((e) => e.includes("ASCII"))).toBe(true);
  });

  it("acusa raio de reta menor que o de curva e gabarito fora da área", () => {
    const p = mergeProfile(undefined);
    p.dynamic.straightMinRadiusMm = 10;
    p.paperTemplates.push({ name: "grande", x: 500, y: 0, width: 420, height: 297 });
    const errs = validateProfile(p);
    expect(errs.some((e) => e.includes("raio de reta"))).toBe(true);
    expect(errs.some((e) => e.includes("grande"))).toBe(true);
  });
});
