import { STROKE_KIND, type TraceMode, type TraceResult } from "./traceImage";

/**
 * A segunda divisão das camadas, além da cor: que PARTE do desenho cada traço é.
 *  - Traço e Preto e branco: fino ou grosso, pela largura que a linha tem no papel. É o que deixa
 *    desenhar os detalhes com a caneta fina e os contornos fortes com a grossa.
 *  - Ilustração: contornos ou sombras (a hachura).
 *  - Foto: é tudo hachura; não há o que separar.
 */
export interface StrokeSplit {
  /** A parte de cada traço (índice em `names`), na ordem dos subcaminhos */
  readonly partOf: Uint8Array;
  /** O nome de cada parte, como aparece ao lado da cor ("Preto fino") */
  readonly names: readonly string[];
}

/**
 * `thinMm`: até esta largura NO PAPEL (px da imagem × mm por px) a linha é "fina". O contorno e a hachura
 * de uma área cheia são sempre do grosso: são eles que enchem a área.
 */
export function strokeParts(result: Pick<TraceResult, "kinds" | "widthsPx">, mode: TraceMode, mmPerPx: number, thinMm: number): StrokeSplit | undefined {
  if (mode === "photo") return undefined;
  const n = result.kinds.length;
  const partOf = new Uint8Array(n);
  if (mode === "illus") {
    for (let i = 0; i < n; i++) partOf[i] = result.kinds[i] === STROKE_KIND.hatch ? 1 : 0;
    return { partOf, names: ["contornos", "sombras"] };
  }
  for (let i = 0; i < n; i++) {
    const k = result.kinds[i];
    const line = k === STROKE_KIND.stroke || k === STROKE_KIND.dot;
    partOf[i] = line && result.widthsPx[i] * mmPerPx <= thinMm ? 0 : 1;
  }
  return { partOf, names: ["fino", "grosso"] };
}
