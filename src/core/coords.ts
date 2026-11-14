import { apply, multiply, translation, type Mat2D } from "./geometry/mat2d";
import { bboxCenter, type BBox } from "./geometry/path";
import type { Vec } from "./geometry/vec";

/**
 * A ÚNICA inversão de eixo Y do projeto.
 * Cena (Fabric, mm, Y para baixo, (0,0) atrás à esquerda) ↔ máquina (mm, Y para cima, (0,0) na frente à esquerda).
 * É uma involução: a mesma matriz serve nos dois sentidos.
 */
export function sceneToMachineMatrix(workHeight: number): Mat2D {
  return [1, 0, 0, -1, 0, workHeight];
}

export function sceneToMachine(p: Vec, workHeight: number): Vec {
  return apply(sceneToMachineMatrix(workHeight), p);
}

export function machineToScene(p: Vec, workHeight: number): Vec {
  return apply(sceneToMachineMatrix(workHeight), p);
}

/** O Fabric posiciona pelo centro do objeto: fabric = model × T(cx, cy), com (cx, cy) = centro da caixa local. */
export function fabricMatrixFromModel(model: Mat2D, localBBox: BBox): Mat2D {
  const c = bboxCenter(localBBox);
  return multiply(model, translation(c.x, c.y));
}

export function modelMatrixFromFabric(fabric: Mat2D, localBBox: BBox): Mat2D {
  const c = bboxCenter(localBBox);
  return multiply(fabric, translation(-c.x, -c.y));
}

/** Rotação como o operador vê (anti-horária positiva, Y da máquina para cima), em (−180, 180]. */
export function machineRotationDeg(model: Mat2D): number {
  const deg = (Math.atan2(-model[1], model[0]) * 180) / Math.PI;
  const r = Math.round(deg * 1e9) / 1e9;
  return r === -180 ? 180 : r === 0 ? 0 : r; // evita "-0"
}
