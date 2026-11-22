/**
 * Curvas de nível de um campo (marching squares, com interpolação linear: precisão sub-pixel).
 * Devolve só LAÇOS FECHADOS: fora da imagem o campo vale "abaixo do nível", então todo contorno fecha.
 *
 * Coordenadas: o valor field[y·width + x] fica no ponto (x, y). Cada laço é x0, y0, x1, y1, ...
 * sem repetir o primeiro ponto no fim.
 */
export function findContours(field: Float32Array, width: number, height: number, level: number): Float64Array[] {
  const W = width + 1; // células vão de −1 a width−1 (a borda de fora vale "abaixo")
  const val = (x: number, y: number): number => (x < 0 || y < 0 || x >= width || y >= height ? -Infinity : field[y * width + x]);
  /** Ponto onde o campo cruza o nível entre dois vizinhos (lado de fora = −∞ → meio caminho não: encosta no de dentro). */
  const cross = (a: number, b: number): number => {
    if (a === -Infinity) return 1;
    if (b === -Infinity) return 0;
    const d = b - a;
    return d === 0 ? 0.5 : Math.min(1, Math.max(0, (level - a) / d));
  };

  // cada segmento liga duas arestas da grade; arestas são numeradas para costurar os laços
  // aresta horizontal de (x,y) a (x+1,y): 2·((y+1)·(W+1) + x+1); vertical de (x,y) a (x,y+1): a mesma + 1
  const eid = (x: number, y: number, vertical: 0 | 1) => 2 * ((y + 1) * (W + 1) + (x + 1)) + vertical;
  const segA: number[] = [];
  const segB: number[] = [];
  const px = new Map<number, number>();
  const py = new Map<number, number>();
  const point = (x: number, y: number, vertical: 0 | 1): number => {
    const id = eid(x, y, vertical);
    if (!px.has(id)) {
      if (vertical) {
        const t = cross(val(x, y), val(x, y + 1));
        px.set(id, x);
        py.set(id, y + t);
      } else {
        const t = cross(val(x, y), val(x + 1, y));
        px.set(id, x + t);
        py.set(id, y);
      }
    }
    return id;
  };

  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      const tl = val(x, y), tr = val(x + 1, y), br = val(x + 1, y + 1), bl = val(x, y + 1);
      const c = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (c === 0 || c === 15) continue;
      // arestas da célula: topo (T), direita (R), base (B), esquerda (L)
      const T = () => point(x, y, 0);
      const R = () => point(x + 1, y, 1);
      const B = () => point(x, y + 1, 0);
      const L = () => point(x, y, 1);
      const add = (a: number, b: number) => {
        segA.push(a);
        segB.push(b);
      };
      switch (c) {
        case 1: add(L(), B()); break;
        case 2: add(B(), R()); break;
        case 3: add(L(), R()); break;
        case 4: add(T(), R()); break;
        case 6: add(T(), B()); break;
        case 7: add(L(), T()); break;
        case 8: add(T(), L()); break;
        case 9: add(T(), B()); break;
        case 11: add(T(), R()); break;
        case 12: add(L(), R()); break;
        case 13: add(B(), R()); break;
        case 14: add(L(), B()); break;
        case 5:
        case 10: {
          // sela: o valor do centro decide quem se liga a quem
          const fin = (v: number) => (v === -Infinity ? level - 1 : v);
          const center = (fin(tl) + fin(tr) + fin(br) + fin(bl)) / 4;
          const high = center >= level;
          if ((c === 5) === high) {
            add(T(), L());
            add(B(), R());
          } else {
            add(T(), R());
            add(L(), B());
          }
          break;
        }
      }
    }
  }

  // costura: cada aresta pertence a exatamente dois segmentos
  const n = segA.length;
  const first = new Map<number, number>();
  const second = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    for (const e of [segA[i], segB[i]]) {
      if (!first.has(e)) first.set(e, i);
      else second.set(e, i);
    }
  }
  const used = new Uint8Array(n);
  const loops: Float64Array[] = [];
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    const pts: number[] = [];
    let seg = s;
    let from = segA[s];
    for (;;) {
      used[seg] = 1;
      pts.push(px.get(from)!, py.get(from)!);
      const to = segA[seg] === from ? segB[seg] : segA[seg];
      const a = first.get(to)!;
      const b = second.get(to);
      const next = a !== seg ? a : b;
      if (next === undefined || used[next]) break;
      seg = next;
      from = to;
    }
    if (pts.length >= 6) loops.push(Float64Array.from(pts));
  }
  return loops;
}

/** Área com sinal de um laço (fórmula do cadarço). */
export function loopArea(loop: Float64Array): number {
  let a = 0;
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[2 * i] * loop[2 * j + 1] - loop[2 * j] * loop[2 * i + 1];
  }
  return a / 2;
}
