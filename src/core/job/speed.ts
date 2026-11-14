import { dist, type Vec } from "../geometry/vec";
import type { MachineProfile } from "../machine";
import type { JobSettings } from "../store";
import type { FeedClass, OrderedStroke, PlannedStroke } from "./types";

type Dyn = MachineProfile["dynamic"];

/** Raio do círculo pelos 3 pontos, ou Infinity se forem colineares/degenerados. */
function circumradius(a: Vec, b: Vec, c: Vec): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const bcx = c.x - b.x, bcy = c.y - b.y;
  const cr = Math.abs(abx * bcy - aby * bcx);
  if (cr < 1e-12) return Infinity;
  return (Math.hypot(abx, aby) * Math.hypot(bcx, bcy) * dist(a, c)) / (2 * cr);
}

/**
 * Raio de curvatura em cada vértice (mesmo tamanho de points). Infinity = reta ou canto:
 * - pontas de traço aberto;
 * - vértice que vira mais que cornerAngleDeg (canto vivo: quem freia é o GRBL, pelo $11);
 * - vértice com segmento vizinho maior que maxCurveSegmentMm (polígono, não amostra de curva).
 * Em laço fechado, todos os vértices têm vizinhos (circular).
 */
export function vertexRadii(points: readonly Vec[], closed: boolean, dyn: Dyn): number[] {
  const n = points.length;
  const r = new Array<number>(n).fill(Infinity);
  if (n < 3) return r;
  const cornerRad = (dyn.cornerAngleDeg * Math.PI) / 180;
  const radiusAt = (prev: Vec, p: Vec, next: Vec): number => {
    const ax = p.x - prev.x, ay = p.y - prev.y;
    const bx = next.x - p.x, by = next.y - p.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0 || la > dyn.maxCurveSegmentMm || lb > dyn.maxCurveSegmentMm) return Infinity;
    const turn = Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by);
    if (turn > cornerRad) return Infinity;
    return circumradius(prev, p, next);
  };
  if (closed && n > 3) {
    for (let i = 0; i < n - 1; i++) {
      const prev = points[i === 0 ? n - 2 : i - 1];
      r[i] = radiusAt(prev, points[i], points[i + 1]);
    }
    r[n - 1] = r[0];
  } else {
    for (let i = 1; i < n - 1; i++) r[i] = radiusAt(points[i - 1], points[i], points[i + 1]);
  }
  return r;
}

export function classifyRadius(r: number, dyn: Dyn): FeedClass {
  if (r >= dyn.straightMinRadiusMm * (1 - 1e-9)) return "straight";
  if (r >= dyn.curveMinRadiusMm * (1 - 1e-9)) return "curve";
  return "tight";
}

const RANK: Record<FeedClass, number> = { straight: 0, curve: 1, tight: 2 };
const BY_RANK: FeedClass[] = ["straight", "curve", "tight"];

/**
 * F de cada segmento (mm/min):
 * 1. classe pelo menor raio das pontas (segmento longo = reta);
 * 2. janela: a classe mais lenta entre os segmentos curtos a até windowMm de caminho, dos dois lados;
 * 3. F da classe (ou o F fixo);
 * 4. teto de vazão: nenhum segmento dura menos que minSegmentTimeMs (piso F100);
 * 5. limite da máquina ($110).
 */
export function assignFeeds(s: OrderedStroke, job: JobSettings, profile: MachineProfile): PlannedStroke {
  const pts = s.points;
  const nSeg = Math.max(0, pts.length - 1);
  const dyn = profile.dynamic;
  const len = new Array<number>(nSeg);
  for (let j = 0; j < nSeg; j++) len[j] = dist(pts[j], pts[j + 1]);

  const radii = vertexRadii(pts, s.closed, dyn);
  const short = (j: number) => len[j] <= dyn.maxCurveSegmentMm;
  const base = new Array<number>(nSeg);
  for (let j = 0; j < nSeg; j++) base[j] = short(j) ? RANK[classifyRadius(Math.min(radii[j], radii[j + 1]), dyn)] : 0;

  const rank = base.slice();
  if (dyn.windowMm > 0) {
    for (let j = 0; j < nSeg; j++) {
      if (!short(j)) continue;
      let gap = 0;
      for (let k = j - 1; k >= 0 && short(k) && gap <= dyn.windowMm && rank[j] < 2; k--) {
        if (base[k] > rank[j]) rank[j] = base[k];
        gap += len[k];
      }
      gap = 0;
      for (let k = j + 1; k < nSeg && short(k) && gap <= dyn.windowMm && rank[j] < 2; k++) {
        if (base[k] > rank[j]) rank[j] = base[k];
        gap += len[k];
      }
    }
  }

  const classes = rank.map((r) => BY_RANK[r]);
  const byClass: Record<FeedClass, number> = { straight: profile.feed.straight, curve: profile.feed.curve, tight: profile.feed.tightCurve };
  const minMs = profile.motion.minSegmentTimeMs;
  const feeds = classes.map((c, j) => {
    let f = job.speedMode === "fixed" ? job.fixedFeed : byClass[c];
    if (minMs > 0) f = Math.min(f, Math.max(100, (60_000 * len[j]) / minMs));
    return Math.round(Math.min(f, profile.motion.maxRateMmMin));
  });
  return { ...s, feeds, classes };
}
