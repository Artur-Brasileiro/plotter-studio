"""
LABORATORIO - "regua": trechos retos do desenho viram retas de verdade.

O ajuste de curvas de vec.fit_polyline segue o esqueleto pixel a pixel, entao uma reta longa de um
desenho tecnico sai levemente ondulada. Aqui cada peca (trecho entre dois cantos) e dividida em
TRECHOS RETOS e TRECHOS CURVOS antes do ajuste:

  1. Ramer-Douglas-Peucker com tolerancia `snap` acha os vertices candidatos.
  2. Um segmento entre dois vertices e RETO se for longo o bastante e os pontos dele oscilarem dos
     dois lados da corda (ruido), e nao todos do mesmo lado (arco).
  3. Dois retos seguidos que viram pouco um para o outro sao, na verdade, uma curva suave: voltam
     a ser curva (senao um arco aberto viraria um poligono).
  4. Retos saem como retas (ajustadas por minimos quadrados); curvas passam pelo ajuste de Bezier
     de sempre, com tangente continua onde encostam numa reta.
"""
from __future__ import annotations

import math

import numpy as np

import vec


def rdp_indices(Q, tol):
    """Indices dos vertices que o Ramer-Douglas-Peucker mantem."""
    n = len(Q)
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        p, q = Q[a], Q[b]
        d = q - p
        L = math.hypot(d[0], d[1])
        seg = Q[a + 1:b] - p
        if L < 1e-12:
            dev = np.hypot(seg[:, 0], seg[:, 1])
        else:
            dev = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L
        i = int(dev.argmax())
        if dev[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack.append((a, k))
            stack.append((k, b))
    return np.nonzero(keep)[0]


def _signed_dev(Q, a, b):
    p, q = Q[a], Q[b]
    d = q - p
    L = math.hypot(d[0], d[1])
    if L < 1e-12 or b - a < 2:
        return np.zeros(0), L
    seg = Q[a + 1:b] - p
    return (seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L, L


def _tls_line(pts):
    """Reta de minimos quadrados totais: (ponto medio, direcao unitaria)."""
    c = pts.mean(0)
    x = pts[:, 0] - c[0]
    y = pts[:, 1] - c[1]
    sxx, syy, sxy = float((x * x).sum()), float((y * y).sum()), float((x * y).sum())
    th = 0.5 * math.atan2(2 * sxy, sxx - syy)
    return c, np.array([math.cos(th), math.sin(th)])


def _project(p, c, u):
    return c + u * float((p - c) @ u)


def classify_runs(Q, snap=0.45, min_len=6.0, small_sag=0.12, one_side=0.5, gentle_deg=6.0):
    """Devolve (idx dos vertices, lista de bool: o segmento i->i+1 e reto?)."""
    idx = rdp_indices(Q, snap)
    straight = []
    for a, b in zip(idx[:-1], idx[1:]):
        dev, L = _signed_dev(Q, a, b)
        if L < min_len:
            straight.append(False)
            continue
        if len(dev) == 0:
            straight.append(True)
            continue
        mx = float(np.abs(dev).max())
        if mx <= small_sag:
            straight.append(True)
            continue
        rho = abs(float(dev.mean())) / (float(np.abs(dev).mean()) + 1e-12)
        straight.append(rho < one_side)
    # retos seguidos com pouca virada entre eles = curva suave
    thr = math.radians(gentle_deg)
    kill = [False] * len(straight)
    for i in range(len(straight) - 1):
        if straight[i] and straight[i + 1]:
            d1 = Q[idx[i + 1]] - Q[idx[i]]
            d2 = Q[idx[i + 2]] - Q[idx[i + 1]]
            ang = abs(math.atan2(d1[0] * d2[1] - d1[1] * d2[0], float(d1 @ d2)))
            if 0.5 * math.pi / 180 < ang < thr:
                kill[i] = kill[i + 1] = True
    straight = [s and not k for s, k in zip(straight, kill)]
    return idx, straight


def fit_piece_straight(Q, tol, tw_arc, tw, snap=0.45, min_len=6.0, line_tol=0.04):
    """Uma peca (sem cantos no meio) -> lista de (bez 4x2, is_line), com retas de verdade."""
    Q = np.asarray(Q, float)
    if len(Q) < 3:
        return [(np.array([Q[0], Q[0], Q[-1], Q[-1]]), True)]
    idx, straight = classify_runs(Q, snap=snap, min_len=min_len)
    nseg = len(straight)
    if not any(straight):
        return None  # nada reto: quem chama usa o ajuste normal
    lines = [None] * nseg
    for i in range(nseg):
        if straight[i]:
            lines[i] = _tls_line(Q[idx[i]:idx[i + 1] + 1])
    # vertices ajustados
    V = [Q[k].copy() for k in idx]
    for j in range(len(idx)):
        left = lines[j - 1] if j > 0 else None
        right = lines[j] if j < nseg else None
        if j == 0 or j == len(idx) - 1:
            continue  # as pontas da peca (cantos) ficam onde estao
        if left is not None and right is not None:
            (c1, u1), (c2, u2) = left, right
            cr = u1[0] * u2[1] - u1[1] * u2[0]
            if abs(cr) > 0.05:
                w = c2 - c1
                t = (w[0] * u2[1] - w[1] * u2[0]) / cr
                X = c1 + u1 * t
                if math.hypot(*(X - V[j])) < 1.0:
                    V[j] = X
                    continue
            V[j] = 0.5 * (_project(V[j], c1, u1) + _project(V[j], c2, u2))
        elif left is not None:
            V[j] = _project(V[j], *left)
        elif right is not None:
            V[j] = _project(V[j], *right)
    segs = []
    err2 = tol * tol
    i = 0
    while i < nseg:
        if straight[i]:
            segs.append((np.array([V[i], V[i], V[i + 1], V[i + 1]]), True))
            i += 1
            continue
        j = i
        while j < nseg and not straight[j]:
            j += 1
        pts = Q[idx[i]:idx[j] + 1].copy()
        pts[0] = V[i]
        pts[-1] = V[j]
        keep = np.concatenate([[True], np.any(np.abs(np.diff(pts, axis=0)) > 1e-9, axis=1)])
        pts = pts[keep]
        if len(pts) < 2:
            i = j
            continue
        if len(pts) == 2:
            segs.append((np.array([pts[0], pts[0], pts[1], pts[1]]), True))
            i = j
            continue
        # tangente continua onde a curva encosta numa reta
        if i > 0 and straight[i - 1]:
            t1 = vec._unit(V[i] - V[i - 1])
        else:
            t1 = vec._end_tangent(pts, tw_arc)
        if j < nseg and straight[j]:
            t2 = vec._unit(V[j] - V[j + 1])
        else:
            t2 = vec._end_tangent(pts[::-1], tw_arc)
        for bez in vec._schneider(pts, t1, t2, err2, tw):
            ch = bez[3] - bez[0]
            L = math.hypot(ch[0], ch[1])
            if L < 1e-9:
                is_line = True
            else:
                nx, ny = -ch[1] / L, ch[0] / L
                d1 = abs((bez[1][0] - bez[0][0]) * nx + (bez[1][1] - bez[0][1]) * ny)
                d2 = abs((bez[2][0] - bez[0][0]) * nx + (bez[2][1] - bez[0][1]) * ny)
                is_line = max(d1, d2) < line_tol
            segs.append((bez, is_line))
        i = j
    return segs
