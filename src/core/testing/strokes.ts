// Auxiliar de testes: compara o que o FakeGrbl desenhou com os traços do plano.
import { expect } from "vitest";
import { distToSegment, type Vec } from "../geometry/vec";
import type { JobPlan } from "../job/types";

/** Traços do plano como a caneta os desenha: os ligados (joinedToPrevious) continuam o anterior. */
export function expectedStrokes(plan: JobPlan): Vec[][] {
  const out: Vec[][] = [];
  const r = (p: Vec) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
  for (const s of plan.strokes) {
    const pts = s.points.map(r);
    if (s.joinedToPrevious && out.length) out[out.length - 1].push(...pts);
    else out.push(pts);
  }
  return out.map((pts) => pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y));
}

/**
 * Junta traços consecutivos em que um começa onde o outro terminou (caneta subiu e desceu no lugar, numa
 * pausa). O ponto da emenda sai se estiver em cima da reta entre os vizinhos (pausa no meio de um segmento).
 */
export function mergeTouching(strokes: readonly (readonly Vec[])[], tol = 1e-6): Vec[][] {
  const out: Vec[][] = [];
  for (const s of strokes) {
    const last = out[out.length - 1];
    const end = last?.[last.length - 1];
    if (end && Math.abs(end.x - s[0].x) < tol && Math.abs(end.y - s[0].y) < tol) {
      const prev = last[last.length - 2];
      if (prev && s[1] && distToSegment(end, prev, s[1]) < 1e-6) last.pop();
      last.push(...s.slice(1)); // s[0] é o próprio ponto da emenda
    } else out.push([...s]);
  }
  return out;
}

/** Igualdade ponto a ponto, com tolerância de arredondamento (2 casas no G-code). */
export function expectSameStrokes(actual: readonly (readonly Vec[])[], expected: Vec[][], tol = 0.011): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((s, i) => {
    expect(s.length).toBe(expected[i].length);
    s.forEach((p, j) => {
      expect(Math.abs(p.x - expected[i][j].x)).toBeLessThan(tol);
      expect(Math.abs(p.y - expected[i][j].y)).toBeLessThan(tol);
    });
  });
}
