// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { publishTurning } from "./gestures";
import { angleText, installTurnBadge, isSnapped } from "./turnBadge";

describe("etiqueta do ângulo enquanto se gira um desenho", () => {
  let off: (() => void) | undefined;
  afterEach(() => {
    publishTurning(undefined);
    off?.();
    off = undefined;
    document.body.replaceChildren();
  });

  const setup = () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    off = installTurnBadge(wrap);
    return wrap.querySelector<HTMLElement>(".turn-badge")!;
  };

  it("fica escondida enquanto ninguém gira nada", () => {
    expect(setup().hidden).toBe(true);
  });

  it("aparece com o ângulo durante o giro e some quando ele termina", () => {
    const badge = setup();
    publishTurning({ deg: 37.46, clientX: 100, clientY: 80 });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("37,5°");
    publishTurning(undefined);
    expect(badge.hidden).toBe(true);
  });

  it("acompanha o mouse", () => {
    const badge = setup();
    publishTurning({ deg: 10, clientX: 100, clientY: 80 });
    const first = [badge.style.left, badge.style.top];
    publishTurning({ deg: 11, clientX: 140, clientY: 95 });
    expect(parseFloat(badge.style.left) - parseFloat(first[0])).toBe(40);
    expect(parseFloat(badge.style.top) - parseFloat(first[1])).toBe(15);
  });

  it("marca quando o desenho encaixou num ângulo redondo (é o sinal de que está reto)", () => {
    const badge = setup();
    publishTurning({ deg: 88, clientX: 0, clientY: 0 });
    expect(badge.classList.contains("snapped")).toBe(false);
    publishTurning({ deg: 90, clientX: 0, clientY: 0 });
    expect(badge.classList.contains("snapped")).toBe(true);
    publishTurning({ deg: -45, clientX: 0, clientY: 0 });
    expect(badge.classList.contains("snapped")).toBe(true);
  });

  it("escreve o ângulo com vírgula, uma casa, e sem “−0”", () => {
    expect(angleText(90)).toBe("90°");
    expect(angleText(-12.34)).toBe("-12,3°");
    expect(angleText(-0.01)).toBe("0°");
    expect(isSnapped(0)).toBe(true);
    expect(isSnapped(180)).toBe(true);
    expect(isSnapped(44.9)).toBe(false);
  });
});
