import { describe, expect, it } from "vitest";
import { flattenSubPath } from "../geometry/flatten";
import { ellipseSubPath } from "../geometry/path";
import { simplifyPolyline } from "../geometry/simplify";
import type { Vec } from "../geometry/vec";
import { DEFAULT_PROFILE, mergeProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { assignFeeds, classifyRadius, vertexRadii } from "./speed";
import type { OrderedStroke } from "./types";

const P = DEFAULT_PROFILE;
const DYN = { ...DEFAULT_JOB_SETTINGS, speedMode: "dynamic" as const }; // modo dinâmico (o padrão passou a ser F500 fixo)
const stroke = (points: Vec[], closed = false): OrderedStroke => ({ points, closed, drawingId: "d", joinedToPrevious: false });
const circle = (r: number): OrderedStroke => {
  const pl = simplifyPolyline(flattenSubPath(ellipseSubPath(0, 0, r, r), 0.05), { rdpMm: 0.05, minSegmentMm: 0.1 });
  return stroke([...pl.points], true);
};
const uniq = <T>(a: readonly T[]) => [...new Set(a)];

/** Caminho por curvatura: lista de [raio (Infinity = reta), comprimento, passo] */
function walk(parts: [number, number, number][]): Vec[] {
  let x = 0, y = 0, th = 0;
  const pts: Vec[] = [{ x, y }];
  for (const [r, length, step] of parts) {
    const n = Math.round(length / step);
    for (let i = 0; i < n; i++) {
      th += Number.isFinite(r) ? step / r : 0;
      x += step * Math.cos(th);
      y += step * Math.sin(th);
      pts.push({ x, y });
    }
  }
  return pts;
}

describe("classifyRadius (padrões: R ≥ 100 reta, R ≥ 40 curva)", () => {
  it.each([
    [Infinity, "straight"],
    [100, "straight"],
    [99, "curve"],
    [40, "curve"],
    [39.9, "tight"],
  ] as const)("R = %d → %s", (r, c) => {
    expect(classifyRadius(r, P.dynamic)).toBe(c);
  });
});

describe("vertexRadii", () => {
  it("canto de 90° entre lados curtos é canto (Infinity), não curva", () => {
    expect(vertexRadii([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], false, P.dynamic)).toEqual([Infinity, Infinity, Infinity]);
  });
  it("pontos num círculo de raio 20 dão raio 20", () => {
    const r = vertexRadii(circle(20).points, true, P.dynamic);
    for (const v of r) expect(v).toBeCloseTo(20, 1);
  });
});

describe("assignFeeds", () => {
  it("reta de 100 mm (um segmento) → F2000", () => {
    const s = assignFeeds(stroke([{ x: 0, y: 0 }, { x: 100, y: 0 }]), DYN, P);
    expect(s.feeds).toEqual([2000]);
    expect(s.classes).toEqual(["straight"]);
  });

  it("quadrado de 50 mm: os quatro lados a F2000 (o canto fica com o GRBL)", () => {
    const sq = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }, { x: 0, y: 0 }];
    expect(assignFeeds(stroke(sq, true), DYN, P).feeds).toEqual([2000, 2000, 2000, 2000]);
  });

  it("círculos: R150 reta, R50 curva, R20 e R5 curva fechada", () => {
    expect(uniq(assignFeeds(circle(150), DYN, P).feeds)).toEqual([2000]);
    expect(uniq(assignFeeds(circle(50), DYN, P).feeds)).toEqual([1200]);
    expect(uniq(assignFeeds(circle(20), DYN, P).feeds)).toEqual([600]);
    expect(uniq(assignFeeds(circle(5), DYN, P).feeds)).toEqual([600]);
  });

  it("reta de 100 mm seguida de arco R5: a reta a F2000, o arco a F600", () => {
    const pts = walk([
      [Infinity, 100, 100],
      [5, 8, 1],
    ]);
    const s = assignFeeds(stroke(pts), DYN, P);
    expect(s.feeds[0]).toBe(2000);
    expect(uniq(s.feeds.slice(1))).toEqual([600]);
  });

  it("janela: 1 mm de R5 no meio de um arco R60 deixa ~2 mm para cada lado em curva fechada", () => {
    const pts = walk([
      [60, 30, 0.5],
      [5, 1, 0.25],
      [60, 30, 0.5],
    ]);
    const s = assignFeeds(stroke(pts), DYN, P);
    // segmentos: 60 de 0,5 mm, 4 de 0,25 mm, 60 de 0,5 mm
    expect(s.classes.slice(0, 50).every((c) => c === "curve")).toBe(true); // a mais de 3 mm do R5
    expect(s.classes.slice(60, 64).every((c) => c === "tight")).toBe(true); // o próprio R5
    expect(s.classes[57]).toBe("tight"); // a ~1,5 mm antes
    expect(s.classes[66]).toBe("tight"); // a ~1 mm depois
    expect(s.classes.slice(74).every((c) => c === "curve")).toBe(true);
  });

  it("modo fixo F1000: tudo F1000, menos segmentos curtos limitados pelo teto", () => {
    const fixed = { ...DYN, speedMode: "fixed" as const, fixedFeed: 1000 };
    expect(uniq(assignFeeds(circle(50), fixed, P).feeds)).toEqual([1000]);
    expect(assignFeeds(stroke([{ x: 0, y: 0 }, { x: 0.1, y: 0 }]), fixed, P).feeds).toEqual([600]);
  });

  it("teto de vazão: segmento de 0,1 mm a F2000 sai a F600; com o teto desligado, F2000", () => {
    expect(assignFeeds(stroke([{ x: 0, y: 0 }, { x: 0.1, y: 0 }]), DYN, P).feeds).toEqual([600]);
    const off = mergeProfile(undefined);
    off.motion.minSegmentTimeMs = 0;
    expect(assignFeeds(stroke([{ x: 0, y: 0 }, { x: 0.1, y: 0 }]), DYN, off).feeds).toEqual([2000]);
  });

  it("polígono de 10 lados de 50 mm (36° por vértice) é reta: segmento longo não é curva", () => {
    const R = 50 / (2 * Math.sin(Math.PI / 10));
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: R * Math.cos((i * 2 * Math.PI) / 10), y: R * Math.sin((i * 2 * Math.PI) / 10) }));
    pts[10] = pts[0];
    expect(uniq(assignFeeds(stroke(pts, true), DYN, P).feeds)).toEqual([2000]);
  });

  it("ponto (1 vértice) não tem segmentos", () => {
    expect(assignFeeds(stroke([{ x: 1, y: 1 }]), DYN, P).feeds).toEqual([]);
  });
});
