/** Ponto ou vetor 2D, em mm (ou na unidade do espaço em que estiver). Imutável. */
export interface Vec {
  readonly x: number;
  readonly y: number;
}

export function vec(x: number, y: number): Vec {
  return { x, y };
}

export function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec, k: number): Vec {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}

/** Componente z do produto vetorial (positivo = b está no sentido anti-horário de a, em Y para cima). */
export function cross(a: Vec, b: Vec): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: Vec, b: Vec, t: number): Vec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function nearlyEqual(a: Vec, b: Vec, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/** Distância do ponto p ao segmento ab. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
