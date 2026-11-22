"""
Gera os dados de paridade de `src/core/trace/strokes.ts` e `src/core/trace/fit.ts`.

Roda a referencia de verdade (`vec.skeleton_strokes`, `vec.fit_polyline`, `vec.path_length`,
`vec.path_flatten`) sobre mascaras e polilinhas SINTETICAS (desenhadas aqui mesmo) e grava entradas
e saidas em `src/core/trace/__fixtures__/strokes/`. Os testes do vitest leem esses arquivos e comparam.

Uso (na raiz do repositorio):
    "D:\\Programacao\\Projetos Python\\vetorizador\\.venv\\Scripts\\python.exe" lab/python/fixtures_strokes.py

Formato: JSON; vetores grandes vao em base64 dos bytes crus, little-endian (i4, f4 ou f8).
  skeleton_strokes.json  cenas: esqueleto (indices y*W+x), distancia NOS PIXELS DO ESQUELETO e uma
                         saida por rodada (`runs`: opcoes + polilinhas + pontos).
  fit_polyline.json      polilinhas (proprias ou `ref` = [cena, polilinha da 1a rodada] do arquivo
                         acima) e, para cada conjunto de opcoes, o caminho ajustado na forma do SubPath:
                         `kinds` (L = reta, C = cubica) e `ctrl` (start; depois `to` ou `c1, c2, to`).
                         `stableSort` aparece quando o resultado depende da ordem dos empates do
                         np.argsort (ver `fit_twice`): e o resultado com argsort estavel.

`skeleton_strokes` so le a transformada de distancia nos pixels do esqueleto, entao so esses valores
sao gravados (o teste monta o mapa inteiro com zero no resto).
"""
from __future__ import annotations

import base64
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from skimage.measure import find_contours
from skimage.morphology import skeletonize

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import vec  # noqa: E402

OUT = HERE.parent.parent / "src" / "core" / "trace" / "__fixtures__" / "strokes"


def b64(a, dtype) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode("ascii")


# =====================================================================
# Desenho das mascaras (coordenadas em px da imagem original; a mascara sai em k x)
# =====================================================================
SHIFT = 4


class Canvas:
    """`g` encolhe a geometria (posicoes e raios), nao a largura dos tracos: cenas menores, dados menores."""

    def __init__(self, w, h, k, g=0.7):
        self.k = k
        self.g = g
        self.m = np.zeros((int(math.ceil(h * g)) * k, int(math.ceil(w * g)) * k), np.uint8)

    def _pt(self, p):
        s = 1 << SHIFT
        return (int(round((p[0] * self.g * self.k - 0.5) * s)), int(round((p[1] * self.g * self.k - 0.5) * s)))

    def _th(self, width):
        return max(1, int(round(width * self.k)))

    def _arr(self, pts):
        return np.array([self._pt(p) for p in pts], np.int32)

    def line(self, p0, p1, width):
        cv2.line(self.m, self._pt(p0), self._pt(p1), 1, self._th(width), cv2.LINE_8, SHIFT)

    def poly(self, pts, width, closed=False):
        cv2.polylines(self.m, [self._arr(pts)], closed, 1, self._th(width), cv2.LINE_8, SHIFT)

    def fill(self, pts):
        cv2.fillPoly(self.m, [self._arr(pts)], 1, cv2.LINE_8, SHIFT)

    def disk(self, c, r):
        cv2.circle(self.m, self._pt(c), int(round(r * self.g * self.k * (1 << SHIFT))), 1, -1, cv2.LINE_8, SHIFT)

    def ring(self, c, r, width):
        cv2.circle(self.m, self._pt(c), int(round(r * self.g * self.k * (1 << SHIFT))), 1, self._th(width), cv2.LINE_8, SHIFT)


def arc(cx, cy, rx, ry, a0, a1, rot=0.0, n=160):
    t = np.radians(np.linspace(a0, a1, n))
    x, y = rx * np.cos(t), ry * np.sin(t)
    r = math.radians(rot)
    return [(cx + x[i] * math.cos(r) - y[i] * math.sin(r), cy + x[i] * math.sin(r) + y[i] * math.cos(r))
            for i in range(n)]


def rot_rect(cx, cy, w, h, deg):
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return [(cx + x * c - y * s, cy + x * s + y * c) for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]


def sc_straight(k):
    c = Canvas(40, 30, k)
    c.line((4, 4), (36, 4), 1.5)
    c.line((5, 9), (5, 27), 1.0)
    c.line((10, 9), (27, 26), 1.2)
    c.line((12, 8.5), (37, 13), 2.0)
    c.line((14, 27), (36, 18.5), 0.5)
    return c.m


def sc_curves(k):
    c = Canvas(46, 34, k)
    c.poly(arc(12, 12, 8, 8, 200, 345), 1.2)
    c.poly([(x, 27 + 4 * math.sin((x - 4) / 5.0)) for x in np.linspace(4, 42, 200)], 1.0)
    t = np.linspace(0, 4.2 * math.pi, 260)
    c.poly([(33 + (1.5 + 0.6 * a) * math.cos(a), 12 + (1.5 + 0.6 * a) * math.sin(a)) for a in t], 0.8)
    c.poly(arc(12, 14, 9, 4, 20, 160, rot=10), 2.0)
    return c.m


def sc_tjunction(k):
    c = Canvas(46, 30, k)
    c.line((4, 6), (26, 6), 1.2)
    c.line((15, 6), (15, 20), 1.2)
    c.line((32, 3), (32, 27), 2.0)
    c.line((32, 15), (43, 15), 0.8)
    c.line((4, 26), (25, 24), 1.0)
    c.line((12, 25.2), (20, 12), 1.0)
    c.line((36, 22), (44, 27), 1.5)
    c.line((40, 24.5), (43, 20), 0.6)
    return c.m


def sc_xcross(k):
    c = Canvas(46, 32, k)
    c.line((4, 9), (20, 9), 1.2)
    c.line((12, 2), (12, 17), 1.2)
    c.line((25, 3), (40, 18), 1.2)
    c.line((40, 3), (25, 18), 1.2)
    c.line((4, 24), (22, 24), 2.4)
    c.line((13, 18), (13, 30), 0.7)
    c.line((26, 22), (43, 28), 1.0)
    c.line((34.5, 19), (34.5, 31), 1.0)
    return c.m


def sc_oblique(k):
    c = Canvas(64, 36, k)
    for i, (ang, w) in enumerate(((18, 1.0), (33, 1.2), (48, 1.0), (68, 1.4))):
        cx, cy = 9 + 15 * i, 10 + (i % 2) * 14
        for sgn in (-1, 1):
            a = math.radians(sgn * ang / 2)
            dx, dy = 8 * math.cos(a), 8 * math.sin(a)
            c.line((cx - dx, cy - dy), (cx + dx, cy + dy), w)
    c.line((3, 30), (30, 33), 0.9)
    c.line((3, 33.5), (30, 29.5), 0.9)
    return c.m


def sc_yfork(k):
    c = Canvas(52, 32, k)
    for a in (90, 210, 330):                       # Y simetrico
        c.line((10, 12), (10 + 9 * math.cos(math.radians(a)), 12 + 9 * math.sin(math.radians(a))), 1.2)
    c.line((22, 3), (22, 29), 1.0)                 # tronco reto + galho
    c.line((22, 17), (31, 5), 1.0)
    c.line((38, 29), (38, 12), 1.4)                # seta
    c.line((38, 12), (33.5, 3), 1.0)
    c.line((38, 12), (42.5, 3), 1.0)
    c.line((46, 29), (46, 16), 0.8)                # tridente
    for dx in (-3.5, 0, 3.5):
        c.line((46, 16), (46 + dx, 6), 0.8)
    return c.m


def sc_squarecap(k):
    c = Canvas(52, 30, k)
    c.fill([(4, 3), (9, 3), (9, 27), (4, 27)])               # barra grossa de pe
    c.fill(rot_rect(22, 15, 4, 22, 30))                      # barra inclinada
    c.fill([(32, 5), (49, 5), (49, 8.5), (32, 8.5)])         # barra deitada
    c.fill(rot_rect(41, 20, 14, 2.5, -15))
    return c.m


def sc_loops(k):
    c = Canvas(56, 36, k)
    c.ring((9, 9), 6, 1.2)
    c.poly(arc(28, 9, 9, 5, 0, 360, rot=20)[:-1], 1.0, True)
    c.poly([(42, 3), (53, 3), (53, 14), (42, 14)], 1.2, True)
    c.poly(arc(8, 22, 3, 3, 180, 270, n=20) + arc(18, 22, 3, 3, 270, 360, n=20) + arc(18, 30, 3, 3, 0, 90, n=20)
           + arc(8, 30, 3, 3, 90, 180, n=20), 1.0, True)     # retangulo de cantos redondos
    c.poly([(27, 33), (34, 19), (41, 33)], 1.0, True)
    c.ring((49, 26), 2.2, 0.8)
    return c.m


def sc_looptail(k):
    c = Canvas(60, 36, k)
    c.ring((10, 11), 7, 1.2)                                 # Q
    c.line((12, 13), (20, 21), 1.2)
    c.line((28, 3), (28, 33), 1.2)                           # P
    c.poly(arc(28, 10, 8, 6, -90, 90), 1.2)
    c.ring((46, 9), 5.5, 1.0)                                # 8
    c.ring((46, 20.5), 6.5, 1.0)
    t = np.linspace(-2.2, 2.2, 200)                          # laco que se cruza (alfa)
    c.poly([(10 + 6 * (a * a - 1.6) / 2.2, 29 + 2.6 * a * (a * a - 1.6) / 2.4) for a in t], 0.9)
    c.poly([(36, 33), (41, 30), (37, 30), (42, 33)], 0.8)    # gravata pequena
    return c.m


def sc_dots(k):
    c = Canvas(44, 26, k, g=1.0)
    for i, r in enumerate((0.3, 0.5, 0.8, 1.2, 2.0, 3.0)):
        c.disk((4 + 6.5 * i, 5), r)
    for i, (ln, w) in enumerate(((0.3, 0.5), (0.5, 0.5), (0.8, 0.6), (1.2, 0.5), (2.0, 1.0), (3.0, 0.5), (4.5, 0.8))):
        c.line((3 + 5.5 * i, 13), (3 + 5.5 * i + ln, 13 + 0.2 * ln), w)
        c.line((3 + 5.5 * i, 19 + ln), (3 + 5.5 * i + 0.3 * ln, 19), w)
    m = c.m
    y = 24 * k
    m[y, 3 * k] = 1                                          # pixels soltos e bloquinhos
    m[y, 6 * k:6 * k + 2] = 1
    m[y:y + 2, 9 * k:9 * k + 2] = 1
    m[y:y + 3, 12 * k:12 * k + 3] = 1
    m[y, 15 * k] = m[y + 1, 15 * k + 1] = m[y + 2, 15 * k + 2] = 1
    m[y:y + 2, 18 * k] = 1
    m[y, 21 * k:21 * k + 3] = 1
    m[y + 1, 21 * k + 1] = 1
    return m


def sc_border(k):
    c = Canvas(38, 26, k)
    c.line((0, 0.3), (38, 0.3), 0.8)               # encostado no topo
    c.line((38.4, 4), (38.4, 22), 0.8)             # encostado na direita
    c.line((-3, 9), (12, 30), 1.2)                 # sai pela esquerda e por baixo
    c.ring((0.5, 20), 5, 1.0)                      # circulo cortado pela borda
    c.line((20, 27), (30, 12), 1.0)                # nasce na borda de baixo
    c.line((16, 12), (40, 12), 1.0)                # cruza e sai pela direita
    c.fill([(30, 20), (40, 20), (40, 28), (30, 28)])   # mancha no canto
    c.line((14, 4), (14, -1), 1.0)
    return c.m


def sc_blobs(k):
    c = Canvas(58, 30, k, g=0.8)
    c.disk((8, 8), 5.5)
    c.fill(arc(26, 8, 10, 4, 0, 360, rot=-12)[:-1])
    c.ring((46, 9), 6, 3.5)
    c.fill([(4, 18), (13, 18), (13, 27), (4, 27)])
    c.fill([(18, 27), (25, 16), (32, 27)])
    c.fill(rot_rect(45, 23, 16, 5, 8))
    return c.m


def sc_grid(k):
    c = Canvas(36, 36, k)
    for i in range(3):
        c.line((6 + 12 * i, 3), (6 + 12 * i, 33), 1.0)
        c.line((3, 6 + 12 * i), (33, 6 + 12 * i), 1.0)
    c.line((6, 6), (31, 31), 0.8)
    return c.m


def sc_full(k):
    return np.ones((10 * k, 16 * k), np.uint8)


def sc_empty(k):
    return np.zeros((6 * k, 8 * k), np.uint8)


def sc_ties(k):
    """Tracinhos com poucos passos: o comprimento cai em cima do limite de `dot_px`."""
    m = np.zeros((14 * k, 30 * k), np.uint8)
    for i in range(1, 9):                           # horizontais com i+1 pixels
        m[2 * k, 3 * k * i:3 * k * i + i + 1] = 1
    for i in range(1, 9):                           # verticais
        m[5 * k:5 * k + i + 1, 3 * k * i] = 1
    for i in range(1, 9):                           # diagonais
        for j in range(i + 1):
            m[9 * k + j, 3 * k * i + j] = 1
    return m


def busy_field(k):
    """Cena mista passando pelo campo de tinta de verdade (borda sub-pixel)."""
    W, H = 84, 50
    img = np.full((H, W), 255, np.uint8)
    cv2.putText(img, "Plot", (3, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 0, 1, cv2.LINE_AA)
    cv2.putText(img, "x=3", (50, 46), cv2.FONT_HERSHEY_COMPLEX, 0.5, 0, 1, cv2.LINE_AA)
    for i in range(3):
        cv2.line(img, (6 + 6 * i, 25), (6 + 6 * i, 46), 0, 1, cv2.LINE_AA)
        cv2.line(img, (3, 29 + 6 * i), (22, 29 + 6 * i), 0, 1, cv2.LINE_AA)
    cv2.circle(img, (36, 36), 10, 0, 1, cv2.LINE_AA)
    cv2.circle(img, (36, 36), 5, 0, 2, cv2.LINE_AA)
    cv2.circle(img, (36, 36), 1, 0, -1, cv2.LINE_AA)
    star = [(70 + (9 if i % 2 == 0 else 4) * math.cos(math.radians(-90 + 36 * i)),
             12 + (9 if i % 2 == 0 else 4) * math.sin(math.radians(-90 + 36 * i))) for i in range(10)]
    cv2.polylines(img, [np.round(np.array(star) * 16).astype(np.int32)], True, 0, 1, cv2.LINE_AA, 4)
    cv2.line(img, (48, 26), (82, 30), 0, 2, cv2.LINE_AA)
    cv2.line(img, (58, 22), (63, 33), 0, 1, cv2.LINE_AA)
    for x, y in ((74, 38), (77, 41), (80, 38), (77, 35)):
        cv2.circle(img, (x, y), 0, 0, -1)
    return vec.ink_field(img, k)


def sc_busy(k):
    f = busy_field(k)
    return vec.clean_mask(f < 0, max(2.0, 0.6 * k * k))


# (nome, funcao, {k: [opcoes de skeleton_strokes de cada rodada]}); a 1a rodada e sempre a padrao
D0 = {}
SCENES = [
    ("straight", sc_straight, {4: [D0], 6: [D0]}),
    ("curves", sc_curves, {4: [D0], 6: [D0]}),
    ("tjunction", sc_tjunction, {4: [D0], 6: [D0]}),
    ("xcross", sc_xcross, {4: [D0, dict(pair_deg=100.0)], 6: [D0]}),
    ("oblique", sc_oblique, {4: [D0, dict(pair_deg=20.0)], 6: [D0]}),
    ("yfork", sc_yfork, {4: [D0], 6: [D0, dict(pair_deg=75.0)]}),
    ("squarecap", sc_squarecap, {4: [D0], 6: [D0, dict(spur_px=2.5)]}),
    ("loops", sc_loops, {4: [D0], 6: [D0]}),
    ("looptail", sc_looptail, {4: [D0, dict(spur_px=0.3), dict(junction_clean=False)], 6: [D0]}),
    ("dots", sc_dots, {4: [D0, dict(dot_px=2.0)], 6: [D0, dict(dot_px=0.0)]}),
    ("border", sc_border, {4: [D0], 6: [D0]}),
    ("blobs", sc_blobs, {4: [D0, dict(spur_px=0.0)], 6: [D0]}),
    ("grid", sc_grid, {4: [D0], 6: [D0, dict(junction_clean=False)]}),
    ("busy", sc_busy, {4: [D0, dict(spur_px=1.6, pair_deg=30.0, dot_px=1.0)], 6: [D0]}),
    ("full", sc_full, {4: [D0], 6: [D0]}),
    ("empty", sc_empty, {4: [D0]}),
    ("ties", sc_ties, {3: [D0], 4: [D0], 5: [D0], 6: [D0]}),
]

STROKE_OPT_NAMES = {"spur_px": "spurPx", "pair_deg": "pairDeg", "dot_px": "dotPx", "junction_clean": "junctionClean"}


def run_scene(name, mask, k, opt_list):
    mask = mask.astype(bool)
    H, W = mask.shape
    # exatamente como skeleton_strokes faz por dentro
    D = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    sk = skeletonize(mask)
    idx = np.flatnonzero(sk)
    ys, xs = np.nonzero(sk)
    touch = "".join(c for c, hit in (("T", (ys == 0).any()), ("B", (ys == H - 1).any()),
                                      ("L", (xs == 0).any()), ("R", (xs == W - 1).any())) if hit) if len(ys) else ""
    runs = []
    first = None
    for opts in opt_list:
        polys, dots = vec.skeleton_strokes(mask, k, **opts)
        if first is None:
            first = polys
        pts = np.concatenate([q for q, _ in polys]) if polys else np.zeros((0, 2))
        runs.append({
            "opts": {STROKE_OPT_NAMES[a]: b for a, b in opts.items()},
            "closed": [bool(cl) for _, cl in polys],
            "counts": [int(len(q)) for q, _ in polys],
            "points": b64(pts, "<f8"),
            "dots": b64(np.array(dots, dtype=np.float64).reshape(-1, 2), "<f8"),
        })
        print(f"{name + '_k' + str(k):14s} {W:4d}x{H:<4d} {int(mask.sum()):6d} {len(idx):5d} {touch:4s} {len(polys):4d} "
              f"{sum(1 for _, c in polys if c):4d} {len(dots):4d}  {opts if opts else ''}")
    fx = {
        "name": f"{name}_k{k}",
        "k": k,
        "width": W,
        "height": H,
        "skel": b64(idx, "<i4"),
        "dist": b64(D.ravel()[idx], "<f4"),
        "runs": runs,
    }
    return fx, first


# =====================================================================
# Polilinhas sinteticas para o ajuste de curvas
# =====================================================================
def resample(P, step, closed):
    """Pontos a cada `step` ao longo da poligonal (os vertices originais entram sempre)."""
    P = [np.array(p, float) for p in P]
    if closed:
        P = P + [P[0]]
    out = [P[0]]
    for a, b in zip(P[:-1], P[1:]):
        L = float(np.hypot(*(b - a)))
        m = max(1, int(round(L / step)))
        for i in range(1, m + 1):
            out.append(a + (b - a) * (i / m))
    if closed:
        out = out[:-1]
    return np.array(out)


def circle(cx, cy, r, step, rx=None, rot=0.0):
    ry = r
    rx = r if rx is None else rx
    n = max(5, int(round(2 * math.pi * max(rx, ry) / step)))
    t = np.arange(n) * (2 * math.pi / n)
    x, y = rx * np.cos(t), ry * np.sin(t)
    c, s = math.cos(rot), math.sin(rot)
    return np.stack([cx + x * c - y * s, cy + x * s + y * c], 1)


def synthetic_polylines():
    rng = np.random.default_rng(20261121)
    out = []

    def add(name, P, closed):
        out.append((name, np.asarray(P, dtype=np.float64).reshape(-1, 2), closed))

    c10 = circle(20, 20, 10, 0.25)
    add("circle_r10", c10, True)
    add("circle_r10_end_repeated", np.concatenate([c10, c10[:1]]), True)
    add("circle_r10_open", c10, False)
    add("circle_r2", circle(5, 5, 2, 0.25), True)
    add("circle_r30_step1", circle(40, 40, 30, 1.0), True)
    add("ellipse_12x5", circle(20, 12, 5, 0.25, rx=12, rot=0.4), True)
    add("rect_sharp", resample([(4, 4), (28, 4), (28, 16), (4, 16)], 0.25, True), True)
    add("rect_sharp_start_mid", np.roll(resample([(4, 4), (28, 4), (28, 16), (4, 16)], 0.25, True), -37, axis=0), True)
    rr = (arc(8, 8, 4, 4, 180, 270, n=26)[:-1] + arc(24, 8, 4, 4, 270, 360, n=26)[:-1]
          + arc(24, 14, 4, 4, 0, 90, n=26)[:-1] + arc(8, 14, 4, 4, 90, 180, n=26)[:-1])
    add("rect_round", resample(rr, 0.25, True), True)
    star = [(20 + (12 if i % 2 == 0 else 5) * math.cos(math.radians(-90 + 36 * i)),
             20 + (12 if i % 2 == 0 else 5) * math.sin(math.radians(-90 + 36 * i))) for i in range(10)]
    add("star5", resample(star, 0.25, True), True)
    add("star5_coarse", resample(star, 0.8, True), True)
    add("triangle_k6", resample([(3, 20), (15, 2), (27, 20)], 1 / 6, True), True)
    x = np.linspace(0, 40, 161)
    add("s_curve", np.stack([x, 10 + 6 * np.tanh((x - 20) / 4)], 1), False)
    add("sine", np.stack([x, 8 + 3 * np.sin(x / 3)], 1), False)
    i = np.arange(0, 121)
    add("stair_k4_shallow", np.stack([(i + 0.5) / 4, (np.round(i * 0.21) + 0.5) / 4], 1), False)
    add("stair_k4_45", np.stack([(i + 0.5) / 4, (i + 0.5) / 4], 1), False)
    add("stair_k6_steep", np.stack([(np.round(i * 0.37) + 0.5) / 6, (i + 0.5) / 6], 1), False)
    add("stair_k4_horizontal", np.stack([(i + 0.5) / 4, np.full(len(i), 7.125)], 1), False)
    add("line_2pt", [(1.5, 2.25), (11.0, 5.5)], False)
    add("line_2pt_closed", [(1.5, 2.25), (11.0, 5.5)], True)
    add("line_3pt", [(0, 0), (2, 0.1), (4, 0)], False)
    add("tiny_loop", circle(3, 3, 0.35, 0.25), True)
    add("tiny_loop_5pts", circle(3, 3, 0.5, 0.6), True)
    add("tiny_loop_k6", circle(3, 3, 0.8, 1 / 6), True)
    add("closed_3pts", [(0, 0), (1, 0), (0.5, 0.8)], True)
    add("closed_4pts", [(0, 0), (1, 0), (1, 1), (0, 1)], True)
    add("one_point", [(1.0, 2.0)], False)
    add("all_repeated", [(1.0, 2.0)] * 5, True)
    add("with_repeats", np.repeat(resample([(0, 0), (10, 0), (10, 8)], 0.25, False), [1, 2, 1, 3] * 18 + [1], axis=0), False)
    add("L_open", resample([(2, 2), (20, 2), (20, 15)], 0.25, False), False)
    add("L_open_k6", resample([(2, 2), (20, 2.4), (17, 15)], 1 / 6, False), False)
    add("L_cut_corner", np.concatenate([resample([(2, 2), (19.75, 2)], 0.25, False), resample([(20, 2.25), (20, 15)], 0.25, False)]), False)
    add("zigzag_close", resample([(0, 0), (1.5, 2), (3, 0), (4.5, 2), (6, 0), (7.5, 2), (9, 0)], 0.2, False), False)
    add("zigzag_wide", resample([(0, 0), (5, 6), (10, 0), (15, 6), (20, 0)], 0.25, False), False)
    add("hairpin", resample([(0, 0), (15, 0.6), (0, 1.2)], 0.25, False), False)
    add("corner_near_ends", resample([(0, 0), (1.2, 0), (1.2, 12), (2.2, 12)], 0.25, False), False)
    t = np.linspace(0, 2 * math.pi, 181)[:-1]
    add("teardrop", np.stack([10 + 8 * np.sin(t / 2), 10 + 5 * np.sin(t)], 1), True)
    add("coarse_polygon", resample([(0, 0), (12, 1), (15, 9), (7, 14), (-2, 8)], 1.0, True), True)
    add("octagon_big_steps", circle(10, 10, 9, 7.0), True)
    add("very_dense_arc", np.array(arc(10, 10, 6, 6, 0, 200, n=600)), False)
    add("very_dense_corner", resample([(0, 0), (6, 0), (6, 5)], 0.03, False), False)
    nc = circle(15, 15, 9, 0.25)
    add("noisy_circle", nc + rng.normal(0, 0.06, nc.shape), True)
    nl = resample([(0, 0), (30, 9)], 0.25, False)
    add("noisy_line", nl + rng.normal(0, 0.05, nl.shape), False)
    w = np.cumsum(rng.normal(0, 0.35, (250, 2)), 0)
    add("random_walk", w, False)
    add("uneven_spacing", np.stack([np.cumsum(rng.uniform(0.02, 1.2, 90)), 3 * np.sin(np.arange(90) / 9)], 1), False)
    add("spiral", np.array([((0.3 + 0.25 * a) * math.cos(a), (0.3 + 0.25 * a) * math.sin(a)) for a in np.linspace(0, 26, 450)]), False)
    add("figure8", np.stack([10 * np.sin(t), 6 * np.sin(2 * t)], 1), True)
    add("square_wave", resample([(0, 0), (4, 0), (4, 3), (8, 3), (8, 0), (12, 0), (12, 3), (16, 3)], 0.25, False), False)
    add("large_coords", c10 * 40 + 5000.0, True)
    return out


def outline_polylines(k):
    """Contornos como `trace_outlines` os entrega a fit_polyline (campo de tinta da cena mista)."""
    f = busy_field(k)
    pad = 2
    fp = np.pad(f, pad, constant_values=float(max(f.max(), 1.0)))
    res = []
    for c in find_contours(fp, 0.0):
        if len(c) < 6:
            continue
        res.append((c[:, ::-1] - pad + 0.5) / k)
    res.sort(key=len, reverse=True)
    return [res[i] for i in (1, 4, 9, 16) if i < len(res)]


FIT_SETS = {
    # nome: opcoes com os nomes do TypeScript
    "default": {},
    "traceFine": dict(tol=0.18, cL=1.6, cdeg=50, gap=0.8, smooth=0.3, presmooth=0.25),      # usados pelo app
    "traceBold": dict(tol=0.18, cL=2.4, cdeg=50, gap=1.1, smooth=0.55, presmooth=0.25),
    "outline": dict(tol=0.13, cL=2.0, cdeg=55, gap=0.9),
    "noCorners": dict(corners=False, smooth=0.4),
    "noSharpen": dict(sharpen=False, tol=0.1, presmooth=0.4),
    "loose": dict(tol=0.5, cL=3.0, cdeg=35, cratio=0.5, lineTol=0.12, gap=1.4),
    "heavySmooth": dict(tol=0.05, smooth=1.2, presmooth=0.9, lineTol=0.01),
}
ALL_SETS = list(FIT_SETS)
REAL_SETS_ALWAYS = ["default", "traceFine", "traceBold"]
# path_flatten so em alguns casos (a saida e grande): nome -> passo
FLATTEN = {"circle_r10": 0.5, "rect_round": 0.2, "s_curve": 0.5, "star5": 1.0, "teardrop": 0.1, "L_open": 0.5,
           "tiny_loop": 0.05, "line_2pt": 0.5}


def py_fit_kwargs(o):
    kw = dict(o)
    if "lineTol" in kw:
        kw["line_tol"] = kw.pop("lineTol")
    return kw


def encode_path(path, flat_step=None):
    """Caminho do Python -> forma do SubPath: start + (to | c1, c2, to) por segmento."""
    segs = path["segs"]
    ctrl = [segs[0][0][0]]
    kinds = []
    gap = 0.0
    prev = segs[0][0][0]
    for bez, is_line in segs:
        gap = max(gap, float(np.abs(bez[0] - prev).max()))
        if is_line:
            kinds.append("L")
            ctrl.append(bez[3])
        else:
            kinds.append("C")
            ctrl.extend([bez[1], bez[2], bez[3]])
        prev = bez[3]
    close_gap = float(np.abs(segs[-1][0][3] - segs[0][0][0]).max()) if path["closed"] else 0.0
    r = {
        "closed": bool(path["closed"]),
        "kinds": "".join(kinds),
        "ctrl": b64(np.array(ctrl), "<f8"),
        "length": float(vec.path_length(path)),
    }
    if flat_step is not None:
        r["flatStep"] = flat_step
        r["flat"] = b64(vec.path_flatten(path, flat_step), "<f8")
    return r, gap, close_gap


def same_path(a, b):
    if a is None or b is None:
        return a is b
    if a["closed"] != b["closed"] or len(a["segs"]) != len(b["segs"]):
        return False
    return all(l1 == l2 and np.array_equal(b1, b2) for (b1, l1), (b2, l2) in zip(a["segs"], b["segs"]))


def fit_twice(P, closed, kw):
    """Roda a referencia como ela e; e de novo com argsort estavel, para saber se o resultado
    depende da ordem dos empates (o np.argsort padrao nao e estavel: com AVX2/AVX-512 a ordem
    de notas iguais muda de uma maquina para outra)."""
    res = vec.fit_polyline(P, closed, **kw)
    orig = np.argsort
    np.argsort = lambda a, *args, **kwargs: orig(a, kind="stable")
    try:
        stable = vec.fit_polyline(P, closed, **kw)
    finally:
        np.argsort = orig
    return res, stable


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    # ---------------- skeleton_strokes
    scenes = []
    real = []   # (indice da cena, indice da polilinha, pts, closed), so da rodada padrao
    print(f"{'cena':14s} {'tam':>9s} {'tinta':>6s} {'esq':>5s} {'brd':4s} {'trac':>4s} {'fech':>4s} {'pts':>4s}  opcoes")
    for name, fn, per_k in SCENES:
        for k, opt_list in per_k.items():
            fx, polys = run_scene(name, fn(k), k, opt_list)
            si = len(scenes)
            scenes.append(fx)
            for pi, (q, cl) in enumerate(polys):
                real.append((si, pi, q, cl))
    text = json.dumps({"version": 1, "generator": "lab/python/fixtures_strokes.py", "scenes": scenes}, separators=(",", ":"))
    (OUT / "skeleton_strokes.json").write_text(text, encoding="ascii")
    size_a = len(text)
    print(f"skeleton_strokes.json: {len(scenes)} cenas, {sum(len(s['runs']) for s in scenes)} rodadas, {size_a / 1024:.0f} KB")

    # ---------------- fit_polyline
    cases = []
    stats = {"runs": 0, "none": 0, "segs": 0, "lines": 0, "cubics": 0, "closed": 0, "gap": 0.0, "close_gap": 0.0}
    tie_cases = []

    def add_case(case, P, closed, sets, flat_step=None):
        case["closed"] = bool(closed)
        case["results"] = {}
        for sname in sets:
            kw = py_fit_kwargs(FIT_SETS[sname])
            res, stable = fit_twice(P, closed, kw)
            stats["runs"] += 1
            if res is None:
                stats["none"] += 1
                case["results"][sname] = None
                assert stable is None
                continue
            r, gap, close_gap = encode_path(res, flat_step if sname == "default" else None)
            if not same_path(res, stable):
                # resultado que depende da ordem dos empates: guarda tambem a versao "argsort estavel"
                tie_cases.append((case["name"], sname))
                r["stableSort"] = encode_path(stable)[0]
            stats["gap"] = max(stats["gap"], gap)
            stats["close_gap"] = max(stats["close_gap"], close_gap)
            stats["segs"] += len(r["kinds"])
            stats["lines"] += r["kinds"].count("L")
            stats["cubics"] += r["kinds"].count("C")
            stats["closed"] += r["closed"]
            case["results"][sname] = r
        cases.append(case)

    for name, P, closed in synthetic_polylines():
        add_case({"name": f"syn_{name}", "points": b64(P, "<f8")}, P, closed, ALL_SETS, FLATTEN.get(name))
    n_syn = len(cases)
    for k in (4, 6):
        for i, P in enumerate(outline_polylines(k)):
            add_case({"name": f"outline_k{k}_{i}", "points": b64(P, "<f8")}, P, True, ["outline", "default", "traceFine"])
    n_out = len(cases) - n_syn
    for j, (si, pi, q, cl) in enumerate(real):
        sets = list(REAL_SETS_ALWAYS)
        sets += [s for n, s in enumerate(ALL_SETS[3:]) if (j + n) % 5 == 0]
        add_case({"name": f"{scenes[si]['name']}_p{pi}", "ref": [si, pi]}, q, cl, sets)

    text = json.dumps({"version": 1, "generator": "lab/python/fixtures_strokes.py", "optionSets": FIT_SETS, "cases": cases},
                      separators=(",", ":"))
    (OUT / "fit_polyline.json").write_text(text, encoding="ascii")
    size_b = len(text)
    print(f"fit_polyline.json: {len(cases)} polilinhas ({n_syn} sinteticas, {n_out} contornos, {len(real)} de skeleton_strokes), "
          f"{stats['runs']} ajustes ({stats['none']} sem caminho), {stats['segs']} segmentos ({stats['lines']} retas, "
          f"{stats['cubics']} cubicas), {stats['closed']} fechados, {size_b / 1024:.0f} KB")
    print(f"  maior salto entre segmentos vizinhos: {stats['gap']:.3g}; maior salto no fechamento: {stats['close_gap']:.3g}")
    print(f"  ajustes que mudam com argsort estavel (empate entre cantos candidatos): {len(tie_cases)}")
    for c in tie_cases:
        print("    ", c)
    print(f"total: {(size_a + size_b) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
