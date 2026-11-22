// Paridade de skeletonStrokes com a referência em Python (lab/python/vec.py: skeleton_strokes).
// Os dados vêm de lab/python/fixtures_strokes.py, que roda a referência de verdade em máscaras sintéticas.
import { afterAll, describe, expect, it } from "vitest";
import raw from "./__fixtures__/strokes/skeleton_strokes.json?raw";
import { fitPolyline } from "./fit";
import { skeletonStrokes, type StrokeOptions, type StrokeResult } from "./strokes";
import { mask, type Mask } from "./types";

interface RunFixture {
  opts: StrokeOptions;
  closed: boolean[];
  counts: number[];
  /** Pontos de todas as polilinhas, uma atrás da outra (f8, base64). */
  points: string;
  dots: string;
}

interface SceneFixture {
  name: string;
  k: number;
  width: number;
  height: number;
  /** Índices y·W + x dos pixels do esqueleto (i4, base64). */
  skel: string;
  /** Transformada de distância nesses mesmos pixels (f4, base64). */
  dist: string;
  runs: RunFixture[];
}

const fixtures = JSON.parse(raw) as { scenes: SceneFixture[] };

/** base64 → bytes crus (little-endian, como o gerador grava). */
function bytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function sceneInput(scene: SceneFixture): { skel: Mask; dist: Float32Array } {
  const idx = new Int32Array(bytes(scene.skel));
  const d = new Float32Array(bytes(scene.dist));
  const skel = mask(scene.width, scene.height);
  const dist = new Float32Array(scene.width * scene.height);
  for (let i = 0; i < idx.length; i++) {
    skel.data[idx[i]] = 1;
    dist[idx[i]] = d[i];
  }
  return { skel, dist };
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!(d <= m)) m = d; // NaN também conta como diferença
  }
  return m;
}

function allPoints(r: StrokeResult): Float64Array {
  let total = 0;
  for (const p of r.polylines) total += p.points.length;
  const out = new Float64Array(total);
  let o = 0;
  for (const p of r.polylines) {
    out.set(p.points, o);
    o += p.points.length;
  }
  return out;
}

const TOL = 1e-9;

describe("skeletonStrokes: paridade com o Python", () => {
  const seen = { runs: 0, polylines: 0, points: 0, dots: 0, maxDiff: 0 };

  for (const scene of fixtures.scenes) {
    scene.runs.forEach((run, r) => {
      const label = r === 0 ? scene.name : `${scene.name} ${JSON.stringify(run.opts)}`;
      it(label, () => {
        const { skel, dist } = sceneInput(scene);
        const got = skeletonStrokes(skel, dist, scene.k, run.opts);

        expect(got.polylines.length, "número de polilinhas").toBe(run.counts.length);
        expect(got.polylines.map((p) => p.closed), "fechadas").toEqual(run.closed);
        expect(got.polylines.map((p) => p.points.length / 2), "pontos por polilinha").toEqual(run.counts);
        const want = new Float64Array(bytes(run.points));
        const dPts = maxAbsDiff(allPoints(got), want);
        expect(dPts, "coordenadas das polilinhas").toBeLessThanOrEqual(TOL);

        const wantDots = new Float64Array(bytes(run.dots));
        expect(got.dots.length / 2, "número de pontos").toBe(wantDots.length / 2);
        const dDots = maxAbsDiff(got.dots, wantDots);
        expect(dDots, "coordenadas dos pontos").toBeLessThanOrEqual(TOL);

        seen.runs++;
        seen.polylines += run.counts.length;
        seen.points += want.length / 2;
        seen.dots += wantDots.length / 2;
        seen.maxDiff = Math.max(seen.maxDiff, dPts, dDots);
      });
    });
  }

  afterAll(() => {
    console.log(
      `skeletonStrokes x Python: ${seen.runs} rodadas, ${seen.polylines} polilinhas (${seen.points} pontos), ` +
        `${seen.dots} pontos isolados; maior diferença = ${seen.maxDiff.toExponential(2)} px`,
    );
  });
});

describe("skeletonStrokes: propriedades", () => {
  const scene = (name: string): SceneFixture => {
    const s = fixtures.scenes.find((f) => f.name === name);
    if (!s) throw new Error(`cena ${name} não está nos dados de teste`);
    return s;
  };

  it("esqueleto vazio não dá traço nem ponto", () => {
    const r = skeletonStrokes(mask(7, 5), new Float32Array(35), 4);
    expect(r.polylines).toEqual([]);
    expect(r.dots.length).toBe(0);
  });

  it("não altera as entradas", () => {
    const { skel, dist } = sceneInput(scene("looptail_k4"));
    const skelCopy = skel.data.slice();
    const distCopy = dist.slice();
    skeletonStrokes(skel, dist, 4);
    expect(skel.data).toEqual(skelCopy);
    expect(dist).toEqual(distCopy);
  });

  it("só lê a distância nos pixels do esqueleto", () => {
    // é isso que permite aos dados de teste guardar a distância só nesses pixels
    for (const name of ["busy_k4", "blobs_k6", "border_k4"]) {
      const s = scene(name);
      const { skel, dist } = sceneInput(s);
      const dirty = dist.map((v, i) => (skel.data[i] ? v : NaN));
      expect(skeletonStrokes(skel, dirty, s.k), name).toEqual(skeletonStrokes(skel, dist, s.k));
    }
  });

  it("o resultado não depende da posição da cena na imagem (inclusive encostada na borda)", () => {
    const [dx, dy] = [5, 3];
    for (const name of ["border_k4", "xcross_k6", "looptail_k4", "dots_k4"]) {
      const s = scene(name);
      const { skel, dist } = sceneInput(s);
      const W = s.width + 2 * dx;
      const H = s.height + 2 * dy;
      const skel2 = mask(W, H);
      const dist2 = new Float32Array(W * H);
      for (let y = 0; y < s.height; y++) {
        for (let x = 0; x < s.width; x++) {
          skel2.data[(y + dy) * W + x + dx] = skel.data[y * s.width + x];
          dist2[(y + dy) * W + x + dx] = dist[y * s.width + x];
        }
      }
      const a = skeletonStrokes(skel, dist, s.k);
      const b = skeletonStrokes(skel2, dist2, s.k);
      expect(b.polylines.map((p) => [p.closed, p.points.length]), name).toEqual(a.polylines.map((p) => [p.closed, p.points.length]));
      const shift = (v: number, i: number) => v - (i % 2 === 0 ? dx : dy) / s.k;
      expect(maxAbsDiff(allPoints(b).map(shift), allPoints(a)), name).toBeLessThanOrEqual(TOL);
      expect(b.dots.length, name).toBe(a.dots.length);
      expect(maxAbsDiff(b.dots.map(shift), a.dots), name).toBeLessThanOrEqual(TOL);
    }
  });
});

// Medição de tempo num esqueleto do tamanho de uma imagem real. Não roda no `npm test`:
//   VITE_TRACE_PERF=1 node scripts/vitest.mjs run src/core/trace/strokes
describe.skipIf(!import.meta.env.VITE_TRACE_PERF)("tempo: esqueleto de ~1 milhão de pixels", () => {
  it("skeletonStrokes e fitPolyline", () => {
    // riscos de 1 pixel em posições pseudoaleatórias (gerador fixo), que se cruzam como num desenho denso
    const W = 6000;
    const H = 6000;
    const skel = mask(W, H);
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 4200; i++) {
      const x0 = 150 + rnd() * (W - 300);
      const y0 = 150 + rnd() * (H - 300);
      const ang = rnd() * 2 * Math.PI;
      const len = 120 + rnd() * 260;
      const bend = (rnd() - 0.5) * 0.006;
      let x = x0;
      let y = y0;
      let a = ang;
      for (let t = 0; t < len; t++) {
        skel.data[Math.round(y) * W + Math.round(x)] = 1;
        x += Math.cos(a);
        y += Math.sin(a);
        a += bend;
        if (x < 1 || y < 1 || x > W - 2 || y > H - 2) break;
      }
    }
    const dist = new Float32Array(W * H).fill(2.5);
    let pixels = 0;
    for (let i = 0; i < skel.data.length; i++) pixels += skel.data[i];

    const k = 4;
    const times: number[] = [];
    let result = skeletonStrokes(skel, dist, k);
    for (let rep = 0; rep < 3; rep++) {
      const t0 = performance.now();
      result = skeletonStrokes(skel, dist, k);
      times.push(performance.now() - t0);
    }
    const points = result.polylines.reduce((s, p) => s + p.points.length / 2, 0);
    console.log(
      `skeletonStrokes: ${W}x${H}, ${pixels} pixels de esqueleto -> ${result.polylines.length} polilinhas ` +
        `(${points} pontos), ${result.dots.length / 2} pontos isolados; ${times.map((t) => t.toFixed(0)).join(" / ")} ms`,
    );

    const sets = {
      traceFine: { tol: 0.18, cL: 1.6, cdeg: 50, gap: 0.8, smooth: 0.3, presmooth: 0.25 },
      traceBold: { tol: 0.18, cL: 2.4, cdeg: 50, gap: 1.1, smooth: 0.55, presmooth: 0.25 },
      padrao: {},
    };
    for (const [name, opts] of Object.entries(sets)) {
      const fitTimes: number[] = [];
      let segments = 0;
      for (let rep = 0; rep < 3; rep++) {
        segments = 0;
        const t0 = performance.now();
        for (const p of result.polylines) segments += fitPolyline(p.points, p.closed, opts)?.segments.length ?? 0;
        fitTimes.push(performance.now() - t0);
      }
      console.log(
        `fitPolyline (${name}): ${result.polylines.length} polilinhas -> ${segments} segmentos; ` +
          `${fitTimes.map((t) => t.toFixed(0)).join(" / ")} ms`,
      );
    }
    expect(result.polylines.length).toBeGreaterThan(1000);
  }, 120_000);
});
