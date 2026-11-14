import { describe, expect, it } from "vitest";
import {
  fabricMatrixFromModel,
  machineRotationDeg,
  machineToScene,
  modelMatrixFromFabric,
  sceneToMachine,
} from "./coords";
import { multiplyAll, nearlyEqualMat, rotationDeg, scaling, translation } from "./geometry/mat2d";

const H = 385;

describe("coords", () => {
  it("sceneToMachine: (60, 325) na cena = (60, 60) na máquina", () => {
    expect(sceneToMachine({ x: 60, y: 325 }, H)).toEqual({ x: 60, y: 60 });
  });

  it("o canto (0,0) da cena (atrás à esquerda) é (0, 385) na máquina", () => {
    expect(sceneToMachine({ x: 0, y: 0 }, H)).toEqual({ x: 0, y: 385 });
  });

  it("machineToScene desfaz sceneToMachine", () => {
    const p = { x: 123.4, y: 56.7 };
    const q = machineToScene(sceneToMachine(p, H), H);
    expect(q.x).toBeCloseTo(p.x, 12);
    expect(q.y).toBeCloseTo(p.y, 12);
  });

  it("ida e volta modelo → Fabric → modelo preserva a matriz", () => {
    const model = multiplyAll(translation(100, 50), rotationDeg(33), scaling(2, 1.5));
    const bbox = { minX: 2, minY: 4, maxX: 102, maxY: 54 };
    const back = modelMatrixFromFabric(fabricMatrixFromModel(model, bbox), bbox);
    expect(nearlyEqualMat(back, model)).toBe(true);
  });

  it("fabricMatrixFromModel leva o centro da caixa local para a posição do objeto", () => {
    const bbox = { minX: 0, minY: 0, maxX: 10, maxY: 20 };
    const f = fabricMatrixFromModel(translation(100, 100), bbox);
    expect(f[4]).toBe(105);
    expect(f[5]).toBe(110);
  });

  it("rotação vista pelo operador: −30° na cena (Y↓) = 30° anti-horário na máquina", () => {
    expect(machineRotationDeg(rotationDeg(-30))).toBeCloseTo(30, 9);
    expect(machineRotationDeg(translation(5, 5))).toBe(0);
    expect(machineRotationDeg(rotationDeg(180))).toBe(180);
  });
});
