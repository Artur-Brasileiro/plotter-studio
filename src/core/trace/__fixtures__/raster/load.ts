/**
 * Leitura dos fixtures de paridade gerados por lab/python/fixtures_raster.py (só para os testes).
 *
 * Cada matriz vem como { dtype, width, height, data }, com data = base64(zlib(bytes)):
 *  - "u8": os bytes linha a linha → vira Mask;
 *  - "f32": float32 little-endian com os bytes embaralhados (todos os bytes 0, depois todos os
 *    bytes 1, ...), que comprime melhor → vira GrayImage.
 */
import { gray, mask, type GrayImage, type Mask } from "../../types";

interface Packed {
  dtype: "f32" | "u8";
  width: number;
  height: number;
  data: string;
}

const isPacked = (v: object): v is Packed => "dtype" in v && "data" in v && "width" in v && "height" in v;

async function inflate(b64: string): Promise<Uint8Array> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unpack(p: Packed): Promise<GrayImage | Mask> {
  const raw = await inflate(p.data);
  const n = p.width * p.height;
  if (p.dtype === "u8") {
    if (raw.length !== n) throw new Error(`fixture u8 com ${raw.length} bytes, esperava ${n}`);
    return mask(p.width, p.height, raw);
  }
  if (raw.length !== 4 * n) throw new Error(`fixture f32 com ${raw.length} bytes, esperava ${4 * n}`);
  const bytes = new Uint8Array(4 * n);
  for (let b = 0; b < 4; b++) for (let i = 0; i < n; i++) bytes[4 * i + b] = raw[b * n + i];
  return gray(p.width, p.height, new Float32Array(bytes.buffer)); // supõe máquina little-endian
}

async function decode(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(decode));
  if (node !== null && typeof node === "object") {
    if (isPacked(node)) return unpack(node);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = await decode(value);
    return out;
  }
  return node;
}

/**
 * Decodifica o texto de um fixture e devolve os casos, com cada matriz já como GrayImage (f32)
 * ou Mask (u8). O tipo T descreve um caso; quem chama sabe o formato do arquivo que importou.
 */
export async function loadCases<T>(json: string): Promise<T[]> {
  const doc = (await decode(JSON.parse(json))) as { cases: T[] };
  return doc.cases;
}

/** Imagem de entrada guardada em uint8 (como sai de um JPEG) → GrayImage em float, como o app entrega. */
export function toGray(a: GrayImage | Mask): GrayImage {
  return gray(a.width, a.height, Float32Array.from(a.data));
}

/** Maior diferença absoluta entre duas matrizes (Infinity se os tamanhos diferem ou se aparecer NaN). */
export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (Number.isNaN(d)) return Infinity;
    if (d > worst) worst = d;
  }
  return worst;
}

/** Quantos elementos diferem (Infinity se os tamanhos diferem). */
export function countDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}
