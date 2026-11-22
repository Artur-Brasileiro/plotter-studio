/**
 * Tipos do traçador (imagem → traços). Tudo aqui é puro: sem DOM, sem canvas.
 * Convenção de coordenadas: pixel (0,0) da imagem ORIGINAL ocupa [0,1]×[0,1];
 * o centro dele é (0,5; 0,5). X para a direita, Y para baixo.
 */

/** Imagem em tons de cinza, linha a linha (índice = y·width + x). Valores 0..255 em ponto flutuante. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** Máscara binária, linha a linha. 1 = tinta, 0 = papel. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Polilinha densa. `points` = x0, y0, x1, y1, ... */
export interface Polyline {
  readonly points: Float64Array;
  readonly closed: boolean;
}

export const gray = (width: number, height: number, data?: Float32Array): GrayImage => ({
  width,
  height,
  data: data ?? new Float32Array(width * height),
});

export const mask = (width: number, height: number, data?: Uint8Array): Mask => ({
  width,
  height,
  data: data ?? new Uint8Array(width * height),
});
