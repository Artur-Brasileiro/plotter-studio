import { afterEach, describe, expect, it } from "vitest";
import { handlePolicy, isRightAngle, onRatioLockChange, onTurning, proportionLocked, publishTurning, ratioLocked, ROTATE_SNAP, setRatioLocked, shownTurn } from "./gestures";

afterEach(() => setRatioLocked(true));

describe("trava de proporção: o desenho cresce e diminui por igual", () => {
  it("o programa abre com a proporção travada", () => {
    expect(ratioLocked()).toBe(true);
  });

  it("travado: os cantos mantêm a proporção, as alças que esticam um lado só somem, e o Shift não destrava", () => {
    expect(handlePolicy(true)).toEqual({ uniform: true, sideHandles: false, toggleKey: undefined });
  });

  it("destravado: dá para esticar (alças dos lados à vista), e o Shift mantém a proporção enquanto estiver apertado", () => {
    expect(handlePolicy(false)).toEqual({ uniform: false, sideHandles: true, toggleKey: "shiftKey" });
  });

  it("um desenho reto (0, 90, 180, −90) segue o que a pessoa escolheu", () => {
    for (const deg of [0, 90, 180, -90, 270, 360]) {
      expect(proportionLocked(true, deg, 1), `travado, ${deg}°`).toBe(true);
      expect(proportionLocked(false, deg, 1), `destravado, ${deg}°`).toBe(false);
    }
  });

  it("girado em ângulo não reto fica sempre travado (esticar aí deformaria o desenho)", () => {
    for (const deg of [30, 45, -12.5, 89.5]) expect(proportionLocked(false, deg, 1), `${deg}°`).toBe(true);
  });

  it("vários desenhos selecionados juntos ficam sempre travados", () => {
    expect(proportionLocked(false, undefined, 2)).toBe(true);
    expect(proportionLocked(false, 0, 3)).toBe(true);
  });

  it("sem nada selecionado vale a escolha da pessoa", () => {
    expect(proportionLocked(false, undefined, 0)).toBe(false);
    expect(proportionLocked(true, undefined, 0)).toBe(true);
  });

  it("isRightAngle tolera o erro de arredondamento das contas, e só ele", () => {
    expect(isRightAngle(90 + 1e-9)).toBe(true);
    expect(isRightAngle(-180)).toBe(true);
    expect(isRightAngle(0.01)).toBe(false);
    expect(isRightAngle(44.999)).toBe(false);
  });

  it("mudar a trava avisa quem está ouvindo, uma vez por mudança de verdade", () => {
    const seen: boolean[] = [];
    const off = onRatioLockChange(() => seen.push(ratioLocked()));
    setRatioLocked(false);
    setRatioLocked(false); // igual: não avisa de novo
    setRatioLocked(true);
    off();
    setRatioLocked(false); // já desligou o aviso
    expect(seen).toEqual([false, true]);
    expect(ratioLocked()).toBe(false);
  });
});

describe("girar com o mouse: o desenho encaixa nos ângulos redondos", () => {
  it("os ângulos retos (0, 90, 180, 270) estão entre os que encaixam", () => {
    expect(ROTATE_SNAP.step).toBeGreaterThan(0);
    for (const deg of [0, 90, 180, 270]) expect(deg % ROTATE_SNAP.step).toBe(0);
  });

  it("o encaixe é um ímã perto do ângulo, não uma grade: sobra espaço livre entre dois encaixes", () => {
    expect(ROTATE_SNAP.within).toBeGreaterThan(0);
    expect(ROTATE_SNAP.within * 2).toBeLessThan(ROTATE_SNAP.step / 2);
  });

  it("o giro de vários desenhos juntos aparece como no painel: anti-horário positivo, entre −180 e 180", () => {
    // o Fabric conta o ângulo no sentido horário da tela (Y para baixo)
    expect(shownTurn(0)).toBe(0);
    expect(Object.is(shownTurn(0), -0)).toBe(false);
    expect(shownTurn(90)).toBe(-90);
    expect(shownTurn(-45)).toBe(45);
    expect(shownTurn(270)).toBe(90);
    expect(shownTurn(180)).toBe(180);
    expect(shownTurn(-180)).toBe(180);
    expect(shownTurn(360)).toBe(0);
    expect(shownTurn(315)).toBe(45);
  });

  it("o ângulo ao vivo chega a quem mostra na tela, e some quando o giro termina", () => {
    const seen: (number | undefined)[] = [];
    const off = onTurning((t) => seen.push(t?.deg));
    publishTurning({ deg: 37.5, clientX: 10, clientY: 20 });
    publishTurning({ deg: 45, clientX: 12, clientY: 20 });
    publishTurning(undefined);
    publishTurning(undefined); // já tinha terminado: não repete
    off();
    publishTurning({ deg: 1, clientX: 0, clientY: 0 });
    expect(seen).toEqual([37.5, 45, undefined]);
    publishTurning(undefined);
  });
});
