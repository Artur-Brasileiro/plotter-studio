/**
 * Hachura: linhas paralelas dentro de uma região, emendadas em zigue-zague.
 * docs/REGRAS_GCODE.md, regra 6: preenchimento grande vira hachura (ex.: 1,5 mm a 45°), com as linhas
 * emendadas para a caneta subir o mínimo possível.
 *
 * A região é {campo >= nível}. O campo costuma ser a distância até a borda da área preta, e o nível,
 * meia largura da caneta: assim a PONTA da caneta nunca passa da borda.
 */
export interface HatchOptions {
  /** Ângulo das linhas, em graus (0 = horizontal; positivo sobe para a direita na tela) */
  readonly angleDeg: number;
  /** Distância entre linhas, em pixels do campo */
  readonly spacing: number;
  /** Desloca a família de linhas (px): com spacing/2, as linhas caem no meio das de deslocamento 0. Padrão 0. */
  readonly offset?: number;
  /** Passo da amostragem ao longo da linha (px). Padrão 0,5. */
  readonly step?: number;
  /** Linhas mais curtas que isto são descartadas (px). Padrão = spacing / 2. */
  readonly minLength?: number;
  /** Emenda a ponta de uma linha ao começo da vizinha se estiver a até isto (px). Padrão = 2,2 × spacing. 0 = não emenda. */
  readonly link?: number;
  /** A ligação pode chegar até esta fração do nível (1 = só dentro da região). Padrão 0,7. */
  readonly linkSlack?: number;
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  used: boolean;
}

/** Devolve polilinhas (x0, y0, x1, y1, ...) em coordenadas do campo. */
export function hatchField(field: Float32Array, width: number, height: number, level: number, o: HatchOptions): Float64Array[] {
  const step = o.step ?? 0.5;
  const spacing = o.spacing;
  if (!(spacing > 0)) return [];
  const minLength = o.minLength ?? spacing / 2;
  const link = o.link ?? 2.2 * spacing;
  const slack = (o.linkSlack ?? 0.7) * level;
  const th = (-o.angleDeg * Math.PI) / 180; // na tela o Y cresce para baixo
  const ux = Math.cos(th), uy = Math.sin(th);
  const nx = -uy, ny = ux;

  const sample = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return -Infinity;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
    const fx = x - x0, fy = y - y0;
    const a = field[y0 * width + x0], b = field[y0 * width + x1];
    const c = field[y1 * width + x0], d = field[y1 * width + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  // faixa de deslocamentos (c) e de posições ao longo da linha (t) que cobrem a imagem
  let cMin = Infinity, cMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    const c = x * nx + y * ny, t = x * ux + y * uy;
    cMin = Math.min(cMin, c);
    cMax = Math.max(cMax, c);
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  const lines: Seg[][] = [];
  const off = o.offset ?? 0;
  const c0 = Math.ceil((cMin - off) / spacing) * spacing + off;
  for (let c = c0; c <= cMax; c += spacing) {
    const segs: Seg[] = [];
    let inside = false;
    let startT = 0;
    let prevT = tMin, prevV = -Infinity;
    const close = (endT: number) => {
      if (endT - startT >= minLength) {
        segs.push({ ax: c * nx + startT * ux, ay: c * ny + startT * uy, bx: c * nx + endT * ux, by: c * ny + endT * uy, used: false });
      }
    };
    for (let t = tMin; t <= tMax + step; t += step) {
      const v = sample(c * nx + t * ux, c * ny + t * uy);
      const now = v >= level;
      if (now !== inside) {
        // cruzamento do nível, refinado entre as duas amostras
        let tc = t;
        if (Number.isFinite(prevV) && Number.isFinite(v) && v !== prevV) tc = prevT + ((level - prevV) / (v - prevV)) * (t - prevT);
        else if (!now) tc = prevT;
        if (now) startT = tc;
        else close(tc);
        inside = now;
      }
      prevT = t;
      prevV = v;
    }
    if (inside) close(prevT);
    lines.push(segs);
  }

  /** A ligação reta fica dentro da região (com a folga)? */
  const linkOk = (x0: number, y0: number, x1: number, y1: number): boolean => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(2, Math.ceil(len / step));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (sample(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) < slack) return false;
    }
    return true;
  };

  const out: Float64Array[] = [];
  for (let li = 0; li < lines.length; li++) {
    for (const s of lines[li]) {
      if (s.used) continue;
      s.used = true;
      const pts: number[] = [s.ax, s.ay, s.bx, s.by];
      let tx = s.bx, ty = s.by;
      // desce pelas linhas seguintes, sempre pegando a ponta mais próxima
      for (let lj = li + 1; link > 0 && lj < lines.length; lj++) {
        let best: Seg | undefined;
        let bestD = link;
        let flip = false;
        for (const q of lines[lj]) {
          if (q.used) continue;
          const da = Math.hypot(q.ax - tx, q.ay - ty);
          const db = Math.hypot(q.bx - tx, q.by - ty);
          if (da <= bestD && linkOk(tx, ty, q.ax, q.ay)) (best = q), (bestD = da), (flip = false);
          if (db < bestD && linkOk(tx, ty, q.bx, q.by)) (best = q), (bestD = db), (flip = true);
        }
        if (!best) break;
        best.used = true;
        if (flip) pts.push(best.bx, best.by, best.ax, best.ay);
        else pts.push(best.ax, best.ay, best.bx, best.by);
        tx = pts[pts.length - 2];
        ty = pts[pts.length - 1];
      }
      out.push(Float64Array.from(pts));
    }
  }
  return out;
}
