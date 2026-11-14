import { describe, expect, it } from "vitest";
import { flattenSubPath } from "./flatten";
import { ellipseSubPath } from "./path";
import { dropShortSegments, polylineLength, rdp, simplifyPolyline } from "./simplify";

const P = (x: number, y: number) => ({ x, y });
const OPTS = { rdpMm: 0.05, minSegmentMm: 0.1 };

describe("rdp", () => {
  it("remove ponto quase colinear", () => {
    expect(rdp([P(0, 0), P(1, 0.01), P(2, 0)], 0.05)).toEqual([P(0, 0), P(2, 0)]);
  });

  it("mantém um canto", () => {
    expect(rdp([P(0, 0), P(10, 0), P(10, 10)], 0.05)).toEqual([P(0, 0), P(10, 0), P(10, 10)]);
  });

  it("aguenta 200 mil pontos sem estourar a pilha", () => {
    const pts = Array.from({ length: 200_000 }, (_, i) => P(i * 0.001, Math.sin(i * 0.001)));
    const out = rdp(pts, 0.05);
    expect(out.length).toBeGreaterThan(2);
    expect(out.length).toBeLessThan(pts.length / 100);
  });
});

describe("dropShortSegments", () => {
  it("funde segmentos menores que o mínimo e mantém o último ponto", () => {
    expect(dropShortSegments([P(0, 0), P(0.03, 0), P(0.06, 0), P(5, 0)], 0.1)).toEqual([P(0, 0), P(5, 0)]);
  });

  it("se o último segmento ficaria curto, sai o vértice interno anterior", () => {
    expect(dropShortSegments([P(0, 0), P(5, 0), P(5.05, 0)], 0.1)).toEqual([P(0, 0), P(5.05, 0)]);
  });
});

describe("simplifyPolyline", () => {
  it("quadrado fechado com pontos médios redundantes fica com 5 pontos", () => {
    const sq = [P(0, 0), P(5, 0), P(10, 0), P(10, 5), P(10, 10), P(5, 10), P(0, 10), P(0, 5), P(0, 0)];
    const out = simplifyPolyline({ points: sq, closed: true }, OPTS);
    expect(out.points).toHaveLength(5);
    expect(out.closed).toBe(true);
    expect(out.points[4]).toBe(out.points[0]);
    expect(polylineLength(out.points)).toBeCloseTo(40, 9);
  });

  it("traço de 0,02 mm vira ponto", () => {
    const out = simplifyPolyline({ points: [P(1, 1), P(1.02, 1)], closed: false }, OPTS);
    expect(out.points).toEqual([P(1, 1)]);
  });

  it("círculo R30 continua com 56 segmentos (o RDP não come vértices de arco)", () => {
    const pl = flattenSubPath(ellipseSubPath(60, 60, 30, 30), 0.05);
    const out = simplifyPolyline(pl, OPTS);
    expect(out.points).toHaveLength(57);
    expect(out.closed).toBe(true);
  });
});
