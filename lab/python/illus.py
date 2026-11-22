"""
Ilustracao colorida (pintura, desenho colorido, render) -> desenho de LINHAS limpo + mapa de tons liso.

E a referencia do modo "illus" do tracador (src/core/trace/illus.ts). O caminho:

  1. apaga a textura e guarda as bordas (rolling guidance com filtro guiado);
  2. acha a direcao das bordas (tensor de estrutura alisado);
  3. diferenca de gaussianas ATRAVESSANDO a borda e media AO LONGO dela (FDoG, Kang et al. 2007):
     da linha do lado escuro de cada borda, continua e sem chuvisco;
  4. histerese: fica a linha forte e a fraca que esta ligada a uma forte;
  5. cada linha normalizada pela propria altura, para o tracador achar o centro dela.

O resultado e uma imagem em tons de cinza com linhas escuras: dali em diante vale o mesmo tracador
de desenho de traco (campo de tinta -> esqueleto -> tracos -> curvas).

So usa borrao gaussiano, media de caixa, Scharr, dilatacao e amostragem bilinear: tudo tem port
direto em TypeScript, e os testes comparam os dois (lab/python/fixtures_illus.py).
Entradas e saidas em float32; as contas do meio em float64.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

# Histerese (resposta da diferenca de gaussianas, em luminancia 0..1). O limiar forte acompanha a imagem:
# uma fracao da resposta das linhas mais fortes DELA, entre um piso e um teto. Assim uma aquarela clara
# tambem ganha linhas, e uma imagem contrastada nao perde as formas de contraste medio.
CANDIDATE = 0.004        # abaixo disto nem entra na conta (papel, grao)
HI_PERCENTILE = 97.0     # "as linhas mais fortes": percentil das candidatas
HI_FRACTION = 0.625
HI_MIN, HI_MAX = 0.012, 0.047
LO_RATIO = 0.19          # limiar fraco = esta fracao do forte...
LO_MIN = 0.003           # ...mas nunca menos que isto
# Peso da resposta dos canais de cor em relacao a da luminancia
COLOR_WEIGHT = 0.8
# Nivel de detalhe 0, 0.25, 0.5, 0.75 e 1 (px da imagem de trabalho, em que 1 px = 1 largura de caneta)
DETAIL_PX = [3.0, 2.2, 1.4, 1.0, 0.7]
SIGMA_E = [1.4, 1.2, 1.0, 0.9, 0.8]
COHERENCE = [7.0, 6.0, 5.0, 4.0, 3.5]
MIN_PX = [14.0, 12.0, 10.0, 8.0, 6.0]


def params_for(detail: float, edge: float = 0.5) -> dict:
    """Ajustes do desenho de linhas a partir dos dois controles da tela (0..1)."""
    t = min(1.0, max(0.0, detail)) * 4
    i = min(3, int(math.floor(t)))
    f = t - i
    mix = lambda a: a[i] + (a[i + 1] - a[i]) * f  # noqa: E731
    k = 2.0 ** (1.0 - 2.0 * min(1.0, max(0.0, edge)))  # edge 1 = pega linha fraca (limiar pela metade)
    return {"detail_px": mix(DETAIL_PX), "sigma_e": mix(SIGMA_E), "coherence": mix(COHERENCE),
            "min_px": mix(MIN_PX), "threshold_scale": k}


def thresholds(resp: np.ndarray, scale: float = 1.0):
    """(fraco, forte) da histerese para esta imagem. `scale` e o controle "linhas fracas" (0,5 a 2)."""
    cand = resp[resp > CANDIDATE]
    ref = float(np.percentile(cand.astype(np.float32), [HI_PERCENTILE])[0]) if cand.size else 0.0
    hi = min(HI_MAX, max(HI_MIN, HI_FRACTION * ref))
    lo = max(LO_MIN, LO_RATIO * hi)
    return lo * scale, hi * scale


def luma(rgb: np.ndarray) -> np.ndarray:
    """Luminancia 0..1 de uma imagem (H, W, 3) em R, G, B 0..1 (mesmos pesos do programa)."""
    c = rgb.astype(np.float64)
    return (0.299 * c[..., 0] + 0.587 * c[..., 1] + 0.114 * c[..., 2]).astype(np.float32)


def sample(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Amostragem bilinear em float64; fora da imagem vale a borda (coordenada presa)."""
    h, w = img.shape
    x = np.clip(x, 0, w - 1)
    y = np.clip(y, 0, h - 1)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = x - x0
    fy = y - y0
    a = img[y0, x0].astype(np.float64)
    b = img[y0, x1].astype(np.float64)
    c = img[y1, x0].astype(np.float64)
    d = img[y1, x1].astype(np.float64)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def resample(chan: np.ndarray, new_w: int, new_h: int) -> np.ndarray:
    """Muda o tamanho (bilinear, centro de pixel alinhado). Ao reduzir mais de 1,5x, borra antes."""
    h, w = chan.shape
    if (new_w, new_h) == (w, h):
        return chan.astype(np.float32).copy()
    fx, fy = w / new_w, h / new_h
    f = max(fx, fy)
    src = chan.astype(np.float32)
    if f >= 1.5:
        src = cv2.GaussianBlur(src, (0, 0), (f - 1) / 2)
    xs = (np.arange(new_w, dtype=np.float64) + 0.5) * fx - 0.5
    ys = (np.arange(new_h, dtype=np.float64) + 0.5) * fy - 0.5
    x, y = np.meshgrid(xs, ys)
    return sample(src, x, y).astype(np.float32)


def box(x: np.ndarray, r: int) -> np.ndarray:
    """Media de caixa (2r+1)x(2r+1) em float64, borda espelhada sem repetir (a padrao do OpenCV)."""
    return cv2.blur(x.astype(np.float64), (2 * r + 1, 2 * r + 1))


def guided(guide: np.ndarray, src: np.ndarray, r: int, eps: float) -> np.ndarray:
    """Filtro guiado (He et al. 2010): alisa `src` respeitando as bordas de `guide`."""
    g = guide.astype(np.float64)
    p = src.astype(np.float64)
    m_g, m_p = box(g, r), box(p, r)
    cov = box(g * p, r) - m_g * m_p
    var = box(g * g, r) - m_g * m_g
    a = cov / (var + eps)
    b = m_p - a * m_g
    return (box(a, r) * g + box(b, r)).astype(np.float32)


def rolling(chan: np.ndarray, sigma: float, eps: float = 0.02 ** 2, n: int = 4) -> np.ndarray:
    """Rolling guidance (Zhang et al. 2014) com filtro guiado: some o que e menor que ~sigma (grao, ferrugem,
    pincelada) e ficam as bordas das formas, no lugar."""
    c = chan.astype(np.float32)
    if sigma <= 0.3:
        return c.copy()
    r = max(1, int(math.floor(2 * sigma + 0.5)))
    j = cv2.GaussianBlur(c, (0, 0), sigma)
    for _ in range(n):
        j = guided(j, c, r, eps)
    return j


def smooth(rgb: np.ndarray, sigma: float, mono: bool = False):
    """Devolve (cor alisada (H, W, 3), luminancia alisada). Cada canal e alisado por conta propria: com a
    luminancia de guia para todos, a borda entre duas cores de MESMA luminancia sairia borrada."""
    tone = rolling(luma(rgb), sigma)
    if mono:
        return np.stack([tone, tone, tone], -1), tone
    return np.stack([rolling(rgb[..., c], sigma) for c in range(3)], -1), tone


def flow(chans: list, sigma_c: float):
    """Direcao das bordas (tangente unitaria) pelo tensor de estrutura dos canais, alisado."""
    e = f = g = 0.0
    for c in chans:
        gx = cv2.Scharr(c.astype(np.float32), cv2.CV_32F, 1, 0).astype(np.float64) / 32.0
        gy = cv2.Scharr(c.astype(np.float32), cv2.CV_32F, 0, 1).astype(np.float64) / 32.0
        e, f, g = e + gx * gx, f + gx * gy, g + gy * gy
    e = cv2.GaussianBlur(e.astype(np.float32), (0, 0), sigma_c).astype(np.float64)
    f = cv2.GaussianBlur(f.astype(np.float32), (0, 0), sigma_c).astype(np.float64)
    g = cv2.GaussianBlur(g.astype(np.float32), (0, 0), sigma_c).astype(np.float64)
    lam = 0.5 * (e + g + np.sqrt((e - g) ** 2 + 4 * f * f))
    # Autovetor do MENOR autovalor (a tangente). Ha duas formulas equivalentes, e cada uma zera num caso:
    # (lam - e, -f) zera na borda exatamente vertical (f = 0, e > g); (-f, lam - g), na exatamente
    # horizontal. Vale a que nao zera, senao uma borda reta de arte digital ficaria sem direcao.
    wide = e >= g
    tx = np.where(wide, -f, lam - e)
    ty = np.where(wide, lam - g, -f)
    n = np.sqrt(tx * tx + ty * ty)
    weak = n < 1e-12
    tx = np.where(weak, 1.0, tx / np.maximum(n, 1e-12))
    ty = np.where(weak, 0.0, ty / np.maximum(n, 1e-12))
    return tx.astype(np.float32), ty.astype(np.float32)


def across(chan: np.ndarray, tx: np.ndarray, ty: np.ndarray, sigma_e: float, k: float = 1.6, rho: float = 0.99) -> np.ndarray:
    """Diferenca de gaussianas de uma dimensao, atravessando a borda. Negativo = lado escuro de uma borda."""
    h, w = chan.shape
    x, y = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    nx, ny = -ty.astype(np.float64), tx.astype(np.float64)
    t = int(math.ceil(2.5 * sigma_e * k))
    a1 = np.zeros((h, w), np.float64)
    a2 = np.zeros((h, w), np.float64)
    w1s = w2s = 0.0
    for d in range(-t, t + 1):
        w1 = math.exp(-d * d / (2 * sigma_e ** 2))
        w2 = math.exp(-d * d / (2 * (sigma_e * k) ** 2))
        v = sample(chan, x + d * nx, y + d * ny)
        a1 += w1 * v
        a2 += w2 * v
        w1s += w1
        w2s += w2
    return (a1 / w1s - rho * a2 / w2s).astype(np.float32)


def along(a: np.ndarray, tx: np.ndarray, ty: np.ndarray, sigma_m: float) -> np.ndarray:
    """Media gaussiana ao longo da borda (segue a tangente nos dois sentidos): emenda a linha e apaga o grao."""
    if sigma_m <= 0:
        return a.astype(np.float32).copy()
    h, w = a.shape
    x, y = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    s_max = int(math.ceil(2.0 * sigma_m))
    out = a.astype(np.float64).copy()
    ws = 1.0
    for sign in (1.0, -1.0):
        px, py = x.copy(), y.copy()
        dx, dy = sign * tx.astype(np.float64), sign * ty.astype(np.float64)
        for s in range(1, s_max + 1):
            px += dx
            py += dy
            wgt = math.exp(-s * s / (2 * sigma_m ** 2))
            out += wgt * sample(a, px, py)
            ws += wgt
            # tangente do pixel mais proximo (sem interpolar: entre t e -t a media daria zero)
            ix = np.clip(np.floor(px + 0.5), 0, w - 1).astype(np.int64)
            iy = np.clip(np.floor(py + 0.5), 0, h - 1).astype(np.int64)
            ntx, nty = tx[iy, ix].astype(np.float64), ty[iy, ix].astype(np.float64)
            flip = (ntx * dx + nty * dy) < 0
            dx = np.where(flip, -ntx, ntx)
            dy = np.where(flip, -nty, nty)
    return (out / ws).astype(np.float32)


def raw_response(chans: list, tx: np.ndarray, ty: np.ndarray, sigma_e: float) -> np.ndarray:
    """Resposta antes de alisar ao longo da borda. chans[0] e a luminancia; os outros sao os canais de cor
    (pegam a borda entre duas cores de mesma luminancia). Positivo = linha."""
    a = -across(chans[0], tx, ty, sigma_e).astype(np.float64)
    for c in chans[1:]:
        a = np.maximum(a, -COLOR_WEIGHT * across(c, tx, ty, sigma_e).astype(np.float64))
    return a.astype(np.float32)


def hysteresis(resp: np.ndarray, lo: float, hi: float, min_px: float = 0.0) -> np.ndarray:
    """Fica o que passa de `hi`, mais o que passa de `lo` e esta ligado a ele (vizinhanca de 8).
    Componentes cuja caixa tem diagonal menor que `min_px` somem."""
    weak = (resp > lo).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(weak, connectivity=8)
    strong = np.zeros(n, bool)
    strong[np.unique(lab[resp > hi])] = True
    strong[0] = False
    if min_px > 0:
        diag = np.hypot(stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT])
        strong &= diag >= min_px
    return strong[lab]


def ridge(resp: np.ndarray, keep: np.ndarray, lo: float, sigma_e: float) -> np.ndarray:
    """0..1: cada linha dividida pela propria altura. O tracador corta a meia altura e acha o CENTRO da
    crista, na linha forte e na fraca (a fraca nao some nem engorda)."""
    size = max(3, int(math.floor(4 * sigma_e + 0.5)) | 1)
    peak = cv2.dilate(resp.astype(np.float32), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
    peak = cv2.GaussianBlur(peak, (0, 0), sigma_e).astype(np.float64)
    v = np.clip(resp.astype(np.float64) / np.maximum(peak, lo), 0, 1)
    return np.where(keep, v, 0.0).astype(np.float32)


def line_art(rgb: np.ndarray, detail_px: float, sigma_e: float, coherence: float, min_px: float,
             threshold_scale: float = 1.0, mono: bool = False) -> dict:
    """Imagem (H, W, 3) em R, G, B 0..1 -> desenho de linhas. `gray` e o que vai para o tracador
    (0..255, papel = 255); `tone` e a luminancia alisada (para a hachura das sombras)."""
    sm, tone = smooth(rgb, detail_px, mono)
    color = [] if mono else [sm[..., 0], sm[..., 1], sm[..., 2]]
    tx, ty = flow(color or [tone], max(1.5, 2.0 * sigma_e))
    raw = raw_response([tone] + color, tx, ty, sigma_e)
    resp = along(raw, tx, ty, coherence)
    lo, hi = thresholds(resp, threshold_scale)
    keep = hysteresis(resp, lo, hi, min_px)
    v = ridge(resp, keep, lo, sigma_e)
    return {"smooth": sm, "tone": tone, "tx": tx, "ty": ty, "raw": raw, "resp": resp, "lo": lo, "hi": hi, "keep": keep, "v": v,
            "gray": (255.0 * (1.0 - v.astype(np.float64))).astype(np.float32)}


# Fundo com luminancia abaixo disto e "fundo escuro" (planta azul, cena noturna, personagem em fundo chapado)
DARK_BACKGROUND = 0.45
# Diferenca minima (luminancia 0..1) entre o papel e o preto na conta das sombras
MIN_TONE_SPAN = 0.1


def border_median(tone: np.ndarray) -> float:
    """O tom do fundo: a mediana de uma faixa em volta da imagem (4% do lado menor, pelo menos 1 px)."""
    h, w = tone.shape
    b = max(1, int(math.floor(0.04 * min(w, h) + 0.5)))
    m = np.zeros((h, w), bool)
    m[:b] = m[-b:] = True
    m[:, :b] = m[:, -b:] = True
    return float(np.percentile(tone[m].astype(np.float32), [50])[0])


def tone_darkness(tone: np.ndarray) -> np.ndarray:
    """0 = papel, 1 = preto. O preto e o 1% mais escuro. O papel sao os 10% mais claros; mas, se o FUNDO da
    imagem e escuro, o papel e o fundo: fundo escuro nao e sombra, e hachura-lo cobriria a folha inteira."""
    lo, hi = np.percentile(tone.astype(np.float32).ravel(), [1, 90])
    bg = border_median(tone)
    if bg < DARK_BACKGROUND:
        hi = bg
    # a escala nunca e menor que MIN_TONE_SPAN: numa imagem em que nada e bem mais escuro que o papel
    # (fundo preto, desenho palido), o grao do fundo nao pode virar "sombra"
    d = np.clip((hi - tone.astype(np.float64)) / max(hi - lo, MIN_TONE_SPAN), 0, 1)
    return d.astype(np.float32)
