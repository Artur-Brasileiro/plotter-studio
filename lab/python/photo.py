"""SPIKE DESCARTAVEL - foto -> tracos de caneta (estilos artisticos)."""
from __future__ import annotations

import math

import cv2
import numpy as np

import vec


def darkness_map(gray, gamma=1.25, clahe=1.6, white_pct=97.0, black_pct=1.0):
    """0 = papel branco, 1 = preto. Contraste local leve + curva de tons."""
    g = gray
    if clahe:
        g = cv2.createCLAHE(clipLimit=clahe, tileGridSize=(8, 8)).apply(g)
    g = g.astype(np.float32)
    lo, hi = np.percentile(g, [black_pct, white_pct])
    d = np.clip((hi - g) / max(hi - lo, 1e-6), 0, 1)
    return d ** gamma


def _sample(img, x, y):
    return cv2.remap(img, x.astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def hatch_layer(dmap, angle_deg, spacing, offset, thr, step=0.4, min_len=2.5, max_gap=1.5):
    """Linhas retas paralelas onde o tom passa de thr. Devolve lista de segmentos (2,2)."""
    H, W = dmap.shape
    th = math.radians(angle_deg)
    u = np.array([math.cos(th), math.sin(th)])
    n = np.array([-math.sin(th), math.cos(th)])
    corners = np.array([[0, 0], [W, 0], [0, H], [W, H]], float)
    cn = corners @ n
    cu = corners @ u
    cs = np.arange(math.floor(cn.min() / spacing) * spacing + offset, cn.max(), spacing)
    ts = np.arange(cu.min(), cu.max(), step)
    X = cs[:, None] * n[0] + ts[None, :] * u[0]
    Y = cs[:, None] * n[1] + ts[None, :] * u[1]
    V = _sample(dmap, X - 0.5, Y - 0.5)
    inside = (X >= 0) & (X <= W) & (Y >= 0) & (Y <= H)
    M = (V > thr) & inside
    segs = []
    gap_n = int(round(max_gap / step))
    min_n = int(round(min_len / step))
    for i in range(len(cs)):
        m = M[i]
        if not m.any():
            continue
        dm = np.diff(m.astype(np.int8))
        starts = list(np.nonzero(dm == 1)[0] + 1)
        ends = list(np.nonzero(dm == -1)[0])
        if m[0]:
            starts.insert(0, 0)
        if m[-1]:
            ends.append(len(m) - 1)
        runs = []
        for a, b in zip(starts, ends):
            if runs and a - runs[-1][1] <= gap_n:
                runs[-1][1] = b
            else:
                runs.append([a, b])
        for a, b in runs:
            if b - a < min_n:
                continue
            # refino sub-passo das pontas (cruzamento do limiar)
            ta, tb = ts[a], ts[b]
            if a > 0 and V[i, a] > thr >= V[i, a - 1]:
                ta -= step * (V[i, a] - thr) / max(V[i, a] - V[i, a - 1], 1e-6)
            if b < len(ts) - 1 and V[i, b] > thr >= V[i, b + 1]:
                tb += step * (V[i, b] - thr) / max(V[i, b] - V[i, b + 1], 1e-6)
            p0 = cs[i] * n + ta * u
            p1 = cs[i] * n + tb * u
            segs.append(np.array([p0, p1]))
    return segs


def crosshatch(gray, pen_px, spacing_pens=2.4, angles=(45, -45, 0, 90), gamma=1.3, sigma=1.0, white_pct=88.0):
    """Hachura cruzada calibrada: cada camada entra quando o tom pede mais tinta."""
    d = darkness_map(gray, gamma=gamma, white_pct=white_pct)
    d = cv2.GaussianBlur(d, (0, 0), sigma)
    s = spacing_pens * pen_px
    cov1 = min(0.95, pen_px / (2 * s))        # cobertura de meia camada
    levels = []
    acc = 0.0
    for _ in range(2 * len(angles)):
        acc = acc + (1 - acc) * cov1
        levels.append(acc)
    thr = [(a + b) / 2 for a, b in zip([0.0] + levels[:-1], levels)]
    paths = []
    li = 0
    for ang in angles:
        for off in (0.0, s):
            for seg in hatch_layer(d, ang, 2 * s, off, thr[li]):
                paths.append(vec.path_from_points(seg))
            li += 1
    return paths


def squiggle(gray, pen_px, row_pens=3.4, gamma=1.15, cutoff=0.10, white_pct=88.0, per_cycle=8):
    """Linhas horizontais onduladas: quanto mais escuro, mais alta e apertada a onda."""
    d = darkness_map(gray, gamma=gamma, white_pct=white_pct)
    H, W = d.shape
    s_row = row_pens * pen_px
    d = cv2.GaussianBlur(d, (0, 0), s_row / 2.6)
    a_max = 0.47 * s_row
    f_min, f_max = 0.02, 1.0 / (2.4 * pen_px)
    dx = 0.15
    xs = np.arange(0, W, dx)
    paths = []
    row = 0
    y0 = s_row / 2
    while y0 < H:
        v = _sample(d, xs[None, :] - 0.5, np.full((1, len(xs)), y0 - 0.5))[0]
        f = f_min + (f_max - f_min) * v ** 1.15
        phi = np.cumsum(2 * math.pi * f * dx)
        amp = a_max * np.clip(v * 1.5, 0, 1) ** 0.85
        ys = y0 + amp * np.sin(phi)
        on = v >= cutoff
        keyp = np.floor(phi / (2 * math.pi / per_cycle) + 0.5).astype(np.int64)
        keyx = np.floor(xs / 4.0).astype(np.int64)
        keep = np.concatenate([[True], (np.diff(keyp) != 0) | (np.diff(keyx) != 0)])
        dm = np.diff(on.astype(np.int8))
        starts = list(np.nonzero(dm == 1)[0] + 1)
        ends = list(np.nonzero(dm == -1)[0])
        if on[0]:
            starts.insert(0, 0)
        if on[-1]:
            ends.append(len(on) - 1)
        rowpaths = []
        for a, b in zip(starts, ends):
            if xs[b] - xs[a] < 3.0:
                continue
            idx = np.nonzero(keep[a:b + 1])[0] + a
            if idx[0] != a:
                idx = np.concatenate([[a], idx])
            if idx[-1] != b:
                idx = np.concatenate([idx, [b]])
            P = np.stack([xs[idx], ys[idx]], 1)
            p = vec.catmull_path(P)
            if p:
                rowpaths.append(p)
        if row % 2:
            rowpaths = [vec.path_reverse(p) for p in reversed(rowpaths)]
        paths.extend(rowpaths)
        row += 1
        y0 += s_row
    return paths


def xdog(gray, sigma=1.0, kk=1.6, p=22.0, eps=0.52, phi=9.0):
    """Estilizacao tipo nanquim: bordas + sombras viram preto. Devolve 0..255 (branco=255)."""
    g = gray.astype(np.float32) / 255.0
    g1 = cv2.GaussianBlur(g, (0, 0), sigma)
    g2 = cv2.GaussianBlur(g, (0, 0), sigma * kk)
    s = (1 + p) * g1 - p * g2
    t = np.where(s >= eps, 1.0, 1.0 + np.tanh(phi * (s - eps)))
    return np.clip(t, 0, 1) * 255.0


def ink_style(gray, k, pen_px, eps=0.5, log=print):
    """Desenho a nanquim: XDoG -> tracos de caneta que pintam o preto."""
    g = cv2.bilateralFilter(gray, 7, 32, 3)   # tira a textura fina, mantem as bordas
    t = xdog(cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(g), sigma=1.25, eps=eps)
    H, W = gray.shape
    f = cv2.resize(t.astype(np.float32), (W * k, H * k), interpolation=cv2.INTER_CUBIC) - 127.5
    f = cv2.GaussianBlur(f, (0, 0), 0.35 * k)
    loops, cl, dots, ink = vec.pen_cover(f, k, pen_px, min_area_px=5.0, spur_px=1.5, log=log)
    paths = []
    for pts, closed in loops:
        q = vec.fit_polyline(pts, True, tol=0.15, cL=2.0, cdeg=55, gap=0.9, sharpen=False)
        if q:
            paths.append(q)
    for pts, closed in cl:
        L = vec._polylen(pts)
        if L < 2.0:
            continue
        q = vec.fit_polyline(pts, closed, tol=0.2, cL=2.4, cdeg=50, gap=1.0,
                             smooth=float(np.clip(L / 80.0, 0.3, 0.7)), presmooth=0.3)
        if q:
            paths.append(q)
    return paths, dots
