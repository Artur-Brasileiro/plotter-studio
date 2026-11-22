/**
 * Realce dos tons de uma foto. Numa imagem escura e de pouco contraste quase todos os pixels caem na
 * mesma faixa de tom, e a hachura sai toda igual. Aqui cada tom é levado para a posição que ele ocupa
 * entre os outros (equalização do histograma), misturado com o tom original na proporção pedida:
 * a ordem dos tons nunca muda, só a distância entre eles.
 */

/** Tom abaixo disto é papel: fica como está e não entra na conta (senão um fundo branco grande achataria o resto). */
const PAPER = 0.02;
const BINS = 256;

/**
 * `tone` vai de 0 (papel) a 1 (o mais escuro) e é alterado no lugar. `amount` de 0 (nada) a 1 (tons
 * totalmente redistribuídos). Devolve o mesmo vetor.
 */
export function equalizeTones(tone: Float32Array, amount: number): Float32Array {
  const a = Math.min(1, Math.max(0, amount));
  if (!(a > 0)) return tone;
  const hist = new Float64Array(BINS);
  let n = 0;
  for (let i = 0; i < tone.length; i++) {
    const v = tone[i];
    if (!(v > PAPER)) continue;
    hist[Math.min(BINS - 1, Math.floor(v * BINS))]++;
    n++;
  }
  if (n === 0) return tone;
  // cdf[k] = fração dos pixels com tom abaixo de k/BINS (linear dentro de cada caixa: sem degraus)
  const cdf = new Float64Array(BINS + 1);
  for (let k = 0; k < BINS; k++) cdf[k + 1] = cdf[k] + hist[k] / n;
  for (let i = 0; i < tone.length; i++) {
    const v = tone[i];
    if (!(v > PAPER)) continue;
    const x = Math.min(BINS - 1e-9, v * BINS);
    const k = Math.floor(x);
    // de PAPER até 1: logo acima do papel o tom realçado continua logo acima do papel (a ordem não se inverte)
    const eq = PAPER + (1 - PAPER) * (cdf[k] + (cdf[k + 1] - cdf[k]) * (x - k));
    tone[i] = (1 - a) * v + a * eq;
  }
  return tone;
}
