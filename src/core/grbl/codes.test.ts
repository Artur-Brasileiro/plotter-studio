import { describe, expect, it } from "vitest";
import { describeAlarm, describeError, errorText, KNOWN_ALARM_CODES, KNOWN_ERROR_CODES } from "./codes";

describe("códigos do GRBL", () => {
  it("todos os erros documentados do GRBL 1.1 (1–17, 20–38) têm título e ação", () => {
    const expected = [...Array.from({ length: 17 }, (_, i) => i + 1), ...Array.from({ length: 19 }, (_, i) => i + 20)];
    expect([...KNOWN_ERROR_CODES].sort((a, b) => a - b)).toEqual(expected);
    for (const c of expected) {
      expect(describeError(c).title.length).toBeGreaterThan(3);
      expect(describeError(c).action.length).toBeGreaterThan(3);
    }
  });

  it("todos os alarmes 1–9 têm título", () => {
    expect([...KNOWN_ALARM_CODES].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const c of KNOWN_ALARM_CODES) expect(describeAlarm(c).title.length).toBeGreaterThan(3);
  });

  it("alarmes que perdem a posição exigem Home", () => {
    expect(describeAlarm(2).needsHoming).toBe(true);
    expect(describeAlarm(3).needsHoming).toBe(true);
    expect(describeAlarm(5).needsHoming).toBe(false);
  });

  it("código desconhecido não quebra", () => {
    expect(describeError(18).title).toContain("18");
    expect(describeAlarm(42).needsHoming).toBe(true);
    expect(errorText(22)).toBe("error:22 — Velocidade (F) não definida");
  });
});
