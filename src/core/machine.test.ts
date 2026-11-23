import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, mergeProfile, validateProfile } from "./machine";

describe("DEFAULT_PROFILE", () => {
  it("bate com a configuração gravada no GRBL", () => {
    expect(DEFAULT_PROFILE.workArea).toEqual({ width: 810, height: 390 });
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

describe("curso da máquina: 810 × 390 mm (corrigido pelo dono da máquina em 22/11/2026; o projeto dizia 385)", () => {
  it("o padrão é 810 × 390, e a zona de desenho (o papel) continua dentro dele", () => {
    expect(DEFAULT_PROFILE.workArea).toEqual({ width: 810, height: 390 });
    expect(DEFAULT_PROFILE.drawZone.maxY).toBeLessThanOrEqual(390);
    expect(validateProfile(DEFAULT_PROFILE)).toEqual([]);
  });

  it("perfil salvo antes da correção, com Y 385 (o padrão antigo), passa a 390", () => {
    const p = mergeProfile({ ...structuredClone(DEFAULT_PROFILE), version: 2, workArea: { width: 810, height: 385 } });
    expect(p.workArea).toEqual({ width: 810, height: 390 });
    expect(p.version).toBe(DEFAULT_PROFILE.version);
  });

  it("a correção não mexe em mais nada do perfil salvo (as canetas e o resto ficam)", () => {
    const saved = { ...structuredClone(DEFAULT_PROFILE), version: 2, workArea: { width: 810, height: 385 } };
    saved.pens.unshift({ id: "branca", name: "Branca", widthMm: 0.5, color: "#ffffff", offsetX: 0, offsetY: 0 });
    saved.feed.straight = 1800;
    const p = mergeProfile(saved);
    expect(p.pens[0].name).toBe("Branca");
    expect(p.feed.straight).toBe(1800);
    expect(p.feed.fixed).toBe(saved.feed.fixed);
  });

  it("quem tinha escolhido outro valor fica com o dele", () => {
    expect(mergeProfile({ ...structuredClone(DEFAULT_PROFILE), version: 2, workArea: { width: 800, height: 380 } }).workArea).toEqual({ width: 800, height: 380 });
  });

  it("perfil já salvo depois da correção com 385 fica em 385: aí foi escolha de quem salvou", () => {
    expect(mergeProfile({ ...structuredClone(DEFAULT_PROFILE), version: 3, workArea: { width: 810, height: 385 } }).workArea.height).toBe(385);
  });
});

describe("gabaritos de papel: a ponta da folha fica na origem (dito pelo dono da máquina em 22/11/2026)", () => {
  const OLD = [
    { name: "A4", x: 30, y: 25, width: 297, height: 210 },
    { name: "A3", x: 30, y: 25, width: 420, height: 297 },
  ];
  const savedV3 = (templates: unknown) => ({ ...structuredClone(DEFAULT_PROFILE), version: 3, paperTemplates: templates });

  it("o A4 e o A3 do padrão começam em (0, 0), onde a caneta fica em Ir para a origem", () => {
    expect(DEFAULT_PROFILE.paperTemplates).toEqual([
      { name: "A4", x: 0, y: 0, width: 297, height: 210 },
      { name: "A3", x: 0, y: 0, width: 420, height: 297 },
    ]);
    expect(DEFAULT_PROFILE.version).toBe(4);
  });

  it("perfil salvo antes da correção, com os gabaritos na posição suposta (30, 25), passa para a origem", () => {
    const p = mergeProfile(savedV3(structuredClone(OLD)));
    expect(p.paperTemplates.map((t) => [t.name, t.x, t.y])).toEqual([["A4", 0, 0], ["A3", 0, 0]]);
    expect(p.paperTemplates.map((t) => [t.width, t.height])).toEqual([[297, 210], [420, 297]]);
    expect(p.version).toBe(4);
  });

  it("gabarito que o dono já tinha medido e mudado fica como ele deixou", () => {
    const mine = [
      { name: "A4", x: 12, y: 8, width: 297, height: 210 },
      { name: "Cartolina", x: 30, y: 25, width: 500, height: 330 },
    ];
    expect(mergeProfile(savedV3(structuredClone(mine))).paperTemplates).toEqual(mine);
  });

  it("perfil já salvo depois da correção com o A4 em (30, 25) fica assim: aí foi escolha de quem salvou", () => {
    const p = mergeProfile({ ...structuredClone(DEFAULT_PROFILE), version: 4, paperTemplates: structuredClone(OLD) });
    expect(p.paperTemplates).toEqual(OLD);
  });

  it("as correções antigas continuam valendo só para quem é de antes delas", () => {
    // curso em Y: 385 -> 390 só em perfil anterior à versão 3
    expect(mergeProfile({ ...structuredClone(DEFAULT_PROFILE), version: 2, workArea: { width: 810, height: 385 } }).workArea.height).toBe(390);
    expect(mergeProfile({ ...structuredClone(DEFAULT_PROFILE), version: 4, workArea: { width: 810, height: 385 } }).workArea.height).toBe(385);
    // velocidade fixa: volta ao padrão só em perfil da versão 1
    const fast = (version: number | undefined) => mergeProfile({ ...structuredClone(DEFAULT_PROFILE), version, feed: { ...DEFAULT_PROFILE.feed, fixed: 1000 } }).feed.fixed;
    expect(fast(undefined)).toBe(DEFAULT_PROFILE.feed.fixed);
    expect(fast(1)).toBe(DEFAULT_PROFILE.feed.fixed);
    expect(fast(3)).toBe(1000);
    expect(fast(4)).toBe(1000);
  });
});
