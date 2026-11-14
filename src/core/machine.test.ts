import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "./machine";

describe("DEFAULT_PROFILE", () => {
  it("bate com a configuração gravada no GRBL", () => {
    expect(DEFAULT_PROFILE.workArea).toEqual({ width: 810, height: 385 });
    expect(DEFAULT_PROFILE.pen.upCmd).toBe("M5");
    expect(DEFAULT_PROFILE.pen.downCmd).toBe("M3 S220");
  });

  it("todos os gabaritos de papel cabem na área útil", () => {
    const { width, height } = DEFAULT_PROFILE.workArea;
    for (const t of DEFAULT_PROFILE.paperTemplates) {
      expect(t.x + t.width).toBeLessThanOrEqual(width);
      expect(t.y + t.height).toBeLessThanOrEqual(height);
    }
  });
});
