"""
SPIKE DESCARTAVEL - vetorizacao para caneta (pen plotter).

Nao e codigo de produto. Serve so para ver que tipo de resultado da para obter.
Coordenadas de saida: pixels da imagem original (pixel (0,0) ocupa [0,1]x[0,1]).
"""
from __future__ import annotations

import math

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d
from skimage.measure import find_contours
from skimage.morphology import skeletonize


# =====================================================================
# Pre-processamento
# =====================================================================
def load_gray(path: str) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def ink_field(gray, k, denoise=6, win=7, cmin=40.0, cmax=90.0, bias=0.0, blur=0.3, sharpen=0.0):
    """Campo f em resolucao k x: tinta onde f < 0. O nivel zero e a borda sub-pixel.

    Limiar local (meio caminho entre o claro e o escuro vizinhos) com queda para
    limiar global onde nao ha contraste. Preserva tracos finos e vaos finos.
    """
    g = gray
    if denoise:
        g = cv2.fastNlMeansDenoising(g, None, h=float(denoise), templateWindowSize=5, searchWindowSize=11)
    g = g.astype(np.float32)
    if sharpen:
        g = g + sharpen * (g - cv2.GaussianBlur(g, (0, 0), 1.0))
    lo_p, hi_p = np.percentile(g, [1, 99])
    t_glob = (lo_p + hi_p) / 2 + bias
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (win, win))
    lo = cv2.GaussianBlur(cv2.erode(g, ker), (0, 0), win / 3)
    hi = cv2.GaussianBlur(cv2.dilate(g, ker), (0, 0), win / 3)
    w = np.clip(((hi - lo) - cmin) / (cmax - cmin), 0, 1)
    t = w * ((hi + lo) / 2 + bias) + (1 - w) * t_glob
    H, W = g.shape
    size = (W * k, H * k)
    f = cv2.resize(g, size, interpolation=cv2.INTER_CUBIC) - cv2.resize(t, size, interpolation=cv2.INTER_LINEAR)
    if blur:
        f = cv2.GaussianBlur(f, (0, 0), blur * k)
    return f


def clean_mask(mask, min_area):
    """Remove componentes com area < min_area (px da propria mascara)."""
    m = mask.astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    small = stats[:, cv2.CC_STAT_AREA] < min_area
    small[0] = False
    m[small[lab]] = 0
    return m


# =====================================================================
# Ajuste de curvas (Schneider) com deteccao de cantos
# =====================================================================
def _unit(v):
    n = math.hypot(v[0], v[1])
    if n < 1e-12:
        return np.array([1.0, 0.0])
    return v / n


def _bez_eval(b, t):
    mt = 1 - t
    return ((mt ** 3)[:, None] * b[0] + (3 * mt * mt * t)[:, None] * b[1]
            + (3 * mt * t * t)[:, None] * b[2] + (t ** 3)[:, None] * b[3])


def _gen_bezier(pts, u, t1, t2):
    p0, p3 = pts[0], pts[-1]
    mt = 1 - u
    b0 = mt ** 3
    b1 = 3 * mt * mt * u
    b2 = 3 * mt * u * u
    b3 = u ** 3
    a1v = b1[:, None] * t1
    a2v = b2[:, None] * t2
    c00 = float((a1v * a1v).sum())
    c01 = float((a1v * a2v).sum())
    c11 = float((a2v * a2v).sum())
    tmp = pts - ((b0 + b1)[:, None] * p0 + (b2 + b3)[:, None] * p3)
    x0 = float((a1v * tmp).sum())
    x1 = float((a2v * tmp).sum())
    det = c00 * c11 - c01 * c01
    chord = p3 - p0
    seg = math.hypot(chord[0], chord[1])
    eps = 1e-6 * seg
    if abs(det) > 1e-12:
        al = (x0 * c11 - x1 * c01) / det
        ar = (c00 * x1 - c01 * x0) / det
    else:
        al = ar = 0.0
    bad = al < eps or ar < eps
    if not bad:
        # pontos de controle fora de ordem ao longo da corda -> heuristica
        h1 = t1 * al
        h2 = t2 * ar
        if (h1 @ chord) - (h2 @ chord) > seg * seg:
            bad = True
    if bad:
        al = ar = seg / 3
    return np.array([p0, p0 + t1 * al, p3 + t2 * ar, p3])


def _reparam(pts, bez, u):
    d1 = 3 * (bez[1:] - bez[:-1])
    d2 = 2 * (d1[1:] - d1[:-1])
    q = _bez_eval(bez, u)
    mt = 1 - u
    q1 = (mt * mt)[:, None] * d1[0] + (2 * mt * u)[:, None] * d1[1] + (u * u)[:, None] * d1[2]
    q2 = mt[:, None] * d2[0] + u[:, None] * d2[1]
    diff = q - pts
    num = (diff * q1).sum(1)
    den = (q1 * q1).sum(1) + (diff * q2).sum(1)
    den = np.where(np.abs(den) < 1e-12, 1.0, den)
    un = np.clip(u - num / den, 0, 1)
    un[0] = 0.0
    un[-1] = 1.0
    return un


def _schneider(Q, t1, t2, err2, tw):
    out = []
    stack = [(0, len(Q) - 1, t1, t2)]
    nq = len(Q)
    while stack:
        i0, i1, ta, tb = stack.pop()
        pts = Q[i0:i1 + 1]
        n = len(pts)
        if n == 2:
            d = pts[1] - pts[0]
            dist = math.hypot(d[0], d[1]) / 3
            out.append((i0, np.array([pts[0], pts[0] + ta * dist, pts[1] + tb * dist, pts[1]])))
            continue
        seglen = np.hypot(pts[1:, 0] - pts[:-1, 0], pts[1:, 1] - pts[:-1, 1])
        u = np.concatenate([[0.0], np.cumsum(seglen)])
        if u[-1] <= 1e-12:
            out.append((i0, np.array([pts[0], pts[0], pts[-1], pts[-1]])))
            continue
        u /= u[-1]
        bez = _gen_bezier(pts, u, ta, tb)
        d = _bez_eval(bez, u) - pts
        e = (d * d).sum(1)
        split = int(e.argmax())
        emax = e[split]
        ok = emax < err2
        if not ok and emax < err2 * 16:
            for _ in range(4):
                u = _reparam(pts, bez, u)
                bez = _gen_bezier(pts, u, ta, tb)
                d = _bez_eval(bez, u) - pts
                e = (d * d).sum(1)
                split = int(e.argmax())
                emax = e[split]
                if emax < err2:
                    ok = True
                    break
        if ok:
            out.append((i0, bez))
            continue
        split = min(max(split, 1), n - 2)
        c = i0 + split
        a = max(0, c - tw)
        b = min(nq - 1, c + tw)
        tc = _unit(Q[a] - Q[b])
        stack.append((c, i1, -tc, tb))
        stack.append((i0, c, ta, tc))
    out.sort(key=lambda x: x[0])
    return [b for _, b in out]


def _end_tangent(Q, tw_arc):
    """Tangente no inicio de Q (apontando para dentro da curva), por ajuste quadratico."""
    seg = np.hypot(Q[1:, 0] - Q[:-1, 0], Q[1:, 1] - Q[:-1, 1])
    s = np.cumsum(seg)
    m = int(np.searchsorted(s, tw_arc)) + 1
    m = max(1, min(m, len(Q) - 1))
    if m < 3:
        return _unit(Q[m] - Q[0])
    sl = s[:m]
    A = np.stack([sl, sl * sl], 1)
    coef, *_ = np.linalg.lstsq(A, Q[1:m + 1] - Q[0], rcond=None)
    a = coef[0]
    if math.hypot(a[0], a[1]) < 1e-9:
        return _unit(Q[m] - Q[0])
    return _unit(a)


def _smooth_piece(Q, sigma_arc):
    if sigma_arc <= 0 or len(Q) < 5:
        return Q
    seg = np.hypot(Q[1:, 0] - Q[:-1, 0], Q[1:, 1] - Q[:-1, 1])
    sp = float(seg.mean()) if len(seg) else 1.0
    sg = sigma_arc / max(sp, 1e-6)
    if sg < 0.3:
        return Q
    # reflexao pontual nas pontas: mantem as extremidades no lugar
    pad = int(min(len(Q) - 1, math.ceil(3 * sg)))
    head = 2 * Q[0] - Q[pad:0:-1]
    tail = 2 * Q[-1] - Q[-2:-pad - 2:-1]
    ext = np.concatenate([head, Q, tail])
    sm = gaussian_filter1d(ext, sg, axis=0, mode="nearest")[pad:pad + len(Q)]
    sm[0] = Q[0]
    sm[-1] = Q[-1]
    return sm


def _find_corners(P, closed, cL, cdeg, cratio):
    n = len(P)
    if closed:
        E = np.concatenate([P, P, P, P[:1]])
        idx = np.arange(n, 2 * n)
    else:
        E = P
        idx = np.arange(n)
    seg = np.hypot(E[1:, 0] - E[:-1, 0], E[1:, 1] - E[:-1, 1])
    s = np.concatenate([[0.0], np.cumsum(seg)])
    if closed:
        E = E[:-1]
        s = s[:-1]
    ne = len(E)

    def turn(L):
        jf = np.searchsorted(s, s[idx] + L)
        jb = np.searchsorted(s, s[idx] - L, side="right") - 1
        ok = (jf < ne) & (jb >= 0)
        jf = np.clip(jf, 0, ne - 1)
        jb = np.clip(jb, 0, ne - 1)
        v1 = E[idx] - E[jb]
        v2 = E[jf] - E[idx]
        ang = np.abs(np.arctan2(v1[:, 0] * v2[:, 1] - v1[:, 1] * v2[:, 0], (v1 * v2).sum(1)))
        ang[~ok] = 0
        return ang

    a1 = turn(cL)
    a2 = turn(cL / 2)
    thr = math.radians(cdeg)
    cand = np.nonzero((a1 >= thr) & (a2 >= cratio * a1))[0]
    if len(cand) == 0:
        return [], E, s
    si = s[idx]
    total = s[n] - s[0] if closed else s[-1]
    order = cand[np.argsort(-(a1[cand] + a2[cand]))]
    chosen = []
    for c in order:
        good = True
        for d in chosen:
            ds = abs(si[c] - si[d])
            if closed:
                ds = min(ds, total - ds)
            if ds < cL:
                good = False
                break
        if good:
            chosen.append(int(c))
    return sorted(chosen), E, s


def _sharpen(E, s, c, gap, m, lim_b, lim_f):
    """Reconstroi o vertice do canto pela intersecao das retas dos dois lados."""
    if lim_b < gap + 0.4 * m or lim_f < gap + 0.4 * m:
        return None
    mb = min(m, lim_b - gap)
    mf = min(m, lim_f - gap)
    ib0 = int(np.searchsorted(s, s[c] - gap - mb))
    ib1 = int(np.searchsorted(s, s[c] - gap, side="right")) - 1
    if0 = int(np.searchsorted(s, s[c] + gap))
    if1 = int(np.searchsorted(s, s[c] + gap + mf, side="right")) - 1
    if ib1 - ib0 < 1 or if1 - if0 < 1 or ib0 < 0 or if1 >= len(E):
        return None
    db = _unit(E[ib1] - E[ib0])
    df = _unit(E[if1] - E[if0])
    cr = db[0] * df[1] - db[1] * df[0]
    if abs(cr) < 0.25:
        return None
    w = E[if0] - E[ib1]
    tb = (w[0] * df[1] - w[1] * df[0]) / cr
    tf = (w[0] * db[1] - w[1] * db[0]) / cr
    if tb < 0 or tf > 0:
        return None
    X = E[ib1] + db * tb
    if math.hypot(X[0] - E[c][0], X[1] - E[c][1]) > 1.6 * gap:
        return None
    return X, ib1 - c, if0 - c


def fit_polyline(P, closed, tol=0.2, cL=2.0, cdeg=55.0, cratio=0.7, sharpen=True, gap=1.0,
                 smooth=0.0, presmooth=0.0, line_tol=0.04, corners=True):
    """Polilinha densa -> caminho de Beziers cubicas/retas, preservando cantos.

    Devolve dict(segs=[(bez(4,2), is_line)], closed) ou None.
    """
    P = np.asarray(P, dtype=np.float64)
    if len(P) >= 2:
        keep = np.concatenate([[True], np.any(np.abs(np.diff(P, axis=0)) > 1e-9, axis=1)])
        P = P[keep]
    if closed and len(P) > 2 and np.allclose(P[0], P[-1]):
        P = P[:-1]
    n = len(P)
    if n < 2:
        return None
    if closed and n < 4:
        closed = False
    if presmooth > 0 and n >= 7:
        seg = np.hypot(P[1:, 0] - P[:-1, 0], P[1:, 1] - P[:-1, 1])
        sg = presmooth / max(float(seg.mean()), 1e-6)
        if sg >= 0.3:
            if closed:
                P = gaussian_filter1d(P, sg, axis=0, mode="wrap")
            else:
                P = _smooth_piece(P, presmooth)

    seg = np.hypot(P[1:, 0] - P[:-1, 0], P[1:, 1] - P[:-1, 1])
    total = float(seg.sum()) + (math.hypot(*(P[0] - P[-1])) if closed else 0.0)
    sp = total / max(n - (0 if closed else 1), 1)
    tw_arc = max(1.0, 3 * sp)
    tw = max(1, int(round(0.75 / max(sp, 1e-6))))
    err2 = tol * tol

    cs = []
    E = s = None
    if corners and total > (4 * cL if closed else 2 * cL) and n >= 8:
        cs, E, s = _find_corners(P, closed, cL, cdeg, cratio)

    pieces = []  # cada peca: array de pontos (ancoras nas pontas)
    if not cs:
        if closed:
            if smooth > 0:
                sg = smooth / max(sp, 1e-6)
                if sg >= 0.3:
                    P = gaussian_filter1d(P, sg, axis=0, mode="wrap")
            Q = np.concatenate([P, P[:1]])
            w = min(tw, (n - 1) // 2)
            tc = _unit(P[w % n] - P[-w])
            pieces.append((Q, tc, -tc))
        else:
            pieces.append((_smooth_piece(P, smooth), None, None))
    else:
        off = n if closed else 0
        anchors = []  # (ext_index, vertex, back_off, fwd_off)
        ext = [off + c for c in cs]
        for i, ce in enumerate(ext):
            if closed:
                prev_s = s[ext[i - 1]] if i > 0 else s[ext[-1]] - total
                next_s = s[ext[i + 1]] if i + 1 < len(ext) else s[ext[0]] + total
            else:
                prev_s = s[ext[i - 1]] if i > 0 else s[0]
                next_s = s[ext[i + 1]] if i + 1 < len(ext) else s[-1]
            lim_b = (s[ce] - prev_s) / 2
            lim_f = (next_s - s[ce]) / 2
            res = _sharpen(E, s, ce, gap, 1.5 * gap, lim_b, lim_f) if sharpen else None
            if res is None:
                anchors.append((ce, E[ce].copy(), -1, 1))
            else:
                anchors.append((ce, res[0], res[1], res[2]))
        if closed:
            for i in range(len(anchors)):
                a = anchors[i]
                b = anchors[(i + 1) % len(anchors)]
                b_idx = b[0] if i + 1 < len(anchors) else b[0] + n
                lo = a[0] + a[3]
                hi = b_idx + b[2]
                mid = E[lo:hi + 1] if hi >= lo else np.zeros((0, 2))
                pieces.append((np.concatenate([[a[1]], mid, [b[1]]]), None, None))
        else:
            first = (0, E[0].copy(), 0, 1)
            last = (n - 1, E[n - 1].copy(), -1, 0)
            seq = [first] + anchors + [last]
            for a, b in zip(seq[:-1], seq[1:]):
                lo = a[0] + a[3]
                hi = b[0] + b[2]
                mid = E[lo:hi + 1] if hi >= lo else np.zeros((0, 2))
                pieces.append((np.concatenate([[a[1]], mid, [b[1]]]), None, None))
        pieces = [(_smooth_piece(q, smooth), t1, t2) for q, t1, t2 in pieces]

    segs = []
    for Q, t1, t2 in pieces:
        keep = np.concatenate([[True], np.any(np.abs(np.diff(Q, axis=0)) > 1e-9, axis=1)])
        Q = Q[keep]
        if len(Q) < 2:
            continue
        if len(Q) == 2:
            segs.append((np.array([Q[0], Q[0], Q[1], Q[1]]), True))
            continue
        if t1 is None:
            t1 = _end_tangent(Q, tw_arc)
        if t2 is None:
            t2 = _end_tangent(Q[::-1], tw_arc)
        for bez in _schneider(Q, t1, t2, err2, tw):
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
    if not segs:
        return None
    return {"segs": segs, "closed": closed}


# =====================================================================
# Caminhos: utilitarios e SVG
# =====================================================================
PREC = 2  # casas decimais nas coordenadas do SVG


def _fmt(v):
    s = f"{v:.{PREC}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def path_d(path):
    segs = path["segs"]
    p0 = segs[0][0][0]
    out = [f"M{_fmt(p0[0])},{_fmt(p0[1])}"]
    for bez, is_line in segs:
        if is_line:
            out.append(f"L{_fmt(bez[3][0])},{_fmt(bez[3][1])}")
        else:
            out.append(f"C{_fmt(bez[1][0])},{_fmt(bez[1][1])} {_fmt(bez[2][0])},{_fmt(bez[2][1])} "
                       f"{_fmt(bez[3][0])},{_fmt(bez[3][1])}")
    if path["closed"]:
        out.append("Z")
    return "".join(out)


def path_reverse(path):
    return {"segs": [(b[::-1].copy(), l) for b, l in reversed(path["segs"])], "closed": path["closed"]}


def path_length(path):
    tot = 0.0
    t = np.linspace(0, 1, 9)
    for bez, is_line in path["segs"]:
        if is_line:
            tot += math.hypot(*(bez[3] - bez[0]))
        else:
            q = _bez_eval(bez, t)
            tot += float(np.hypot(q[1:, 0] - q[:-1, 0], q[1:, 1] - q[:-1, 1]).sum())
    return tot


def path_flatten(path, step=0.5):
    pts = [path["segs"][0][0][0][None, :]]
    for bez, is_line in path["segs"]:
        if is_line:
            pts.append(bez[3][None, :])
        else:
            L = math.hypot(*(bez[3] - bez[0])) + 1e-9
            nseg = int(min(40, max(3, L / step)))
            pts.append(_bez_eval(bez, np.linspace(0, 1, nseg + 1))[1:])
    return np.concatenate(pts)


def path_from_points(P, closed=False):
    """Polilinha pura -> caminho de segmentos de reta (sem ajuste)."""
    P = np.asarray(P, float)
    segs = [(np.array([a, a, b, b]), True) for a, b in zip(P[:-1], P[1:])]
    return {"segs": segs, "closed": closed} if segs else None


def catmull_path(P, closed=False):
    """Curva suave passando por todos os pontos (Catmull-Rom -> Bezier)."""
    P = np.asarray(P, float)
    n = len(P)
    if n < 2:
        return None
    if n == 2:
        return path_from_points(P)
    if closed:
        ext = np.concatenate([P[-1:], P, P[:2]])
        m = n
    else:
        ext = np.concatenate([2 * P[:1] - P[1:2], P, 2 * P[-1:] - P[-2:-1]])
        m = n - 1
    p0, p1, p2, p3 = ext[:m], ext[1:m + 1], ext[2:m + 2], ext[3:m + 3]
    c1 = p1 + (p2 - p0) / 6
    c2 = p2 - (p3 - p1) / 6
    segs = [(np.array([p1[i], c1[i], c2[i], p2[i]]), False) for i in range(m)]
    return {"segs": segs, "closed": closed}


def order_paths(paths):
    """Ordena por vizinho mais proximo (com inversao). Devolve (lista, viagem_no_ar)."""
    n = len(paths)
    if n == 0:
        return [], 0.0
    S = np.array([p["segs"][0][0][0] for p in paths])
    E = np.array([p["segs"][0][0][0] if p["closed"] else p["segs"][-1][0][3] for p in paths])
    alive = np.ones(n, bool)
    cur = np.array([0.0, 0.0])
    out = []
    travel = 0.0
    INF = 1e30
    for _ in range(n):
        ds = ((S - cur) ** 2).sum(1)
        de = ((E - cur) ** 2).sum(1)
        ds[~alive] = INF
        de[~alive] = INF
        i = int(ds.argmin())
        j = int(de.argmin())
        if ds[i] <= de[j]:
            travel += math.sqrt(ds[i])
            out.append(paths[i])
            cur = E[i]
            alive[i] = False
        else:
            travel += math.sqrt(de[j])
            out.append(path_reverse(paths[j]))
            cur = S[j]
            alive[j] = False
    return out, travel


def svg_strokes(paths, W, H, mm_per_px, stroke_px, dots=(), color="#000"):
    wmm, hmm = W * mm_per_px, H * mm_per_px
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{wmm:.2f}mm" height="{hmm:.2f}mm" '
        f'viewBox="0 0 {W} {H}">',
        f'<g fill="none" stroke="{color}" stroke-width="{stroke_px:.3f}" '
        'stroke-linecap="round" stroke-linejoin="round">',
    ]
    for p in paths:
        out.append(f'<path d="{path_d(p)}"/>')
    for x, y in dots:
        out.append(f'<path d="M{_fmt(x)},{_fmt(y)}h0.01"/>')
    out.append("</g></svg>")
    return "\n".join(out)


def svg_filled(paths, W, H, mm_per_px, color="#000"):
    wmm, hmm = W * mm_per_px, H * mm_per_px
    d = "".join(path_d(p) for p in paths)
    return "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{wmm:.2f}mm" height="{hmm:.2f}mm" '
        f'viewBox="0 0 {W} {H}">',
        f'<path fill="{color}" fill-rule="evenodd" d="{d}"/>',
        "</svg>",
    ])


# =====================================================================
# Contorno preenchido (vetor classico, borda sub-pixel)
# =====================================================================
def trace_outlines(f, k, min_area=0.8, tol=0.15, **fit_kw):
    pad = 2
    fp = np.pad(f, pad, constant_values=float(max(f.max(), 1.0)))
    paths = []
    for c in find_contours(fp, 0.0):
        if len(c) < 6:
            continue
        xy = (c[:, ::-1] - pad + 0.5) / k
        x, y = xy[:-1, 0], xy[:-1, 1]
        area = 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))
        if area < min_area:
            continue
        p = fit_polyline(xy, True, tol=tol, **fit_kw)
        if p:
            paths.append(p)
    return paths


# =====================================================================
# Linha central: esqueleto -> grafo -> tracos longos
# =====================================================================
_OFF8 = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


def _polylen(P):
    return float(np.hypot(P[1:, 0] - P[:-1, 0], P[1:, 1] - P[:-1, 1]).sum()) if len(P) > 1 else 0.0


def skeleton_strokes(mask, k, spur_px=1.0, pair_deg=42.0, dot_px=0.6, junction_clean=True):
    """mask (k x) -> (polilinhas [(pts_xy_px_original, closed)], pontos [(x,y)])."""
    mask = mask.astype(bool)
    if not mask.any():
        return [], []
    D = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    sk = skeletonize(mask)
    pad = np.pad(sk, 1)
    ys, xs = np.nonzero(pad)
    N = len(ys)
    if N == 0:
        return [], []
    idmap = np.full(pad.shape, -1, np.int32)
    idmap[ys, xs] = np.arange(N, dtype=np.int32)
    nb = np.full((N, 8), -1, np.int32)
    for j, (dy, dx) in enumerate(_OFF8):
        v = idmap[ys + dy, xs + dx]
        if dy and dx:
            blocked = (idmap[ys + dy, xs] >= 0) | (idmap[ys, xs + dx] >= 0)
            v = np.where(blocked, -1, v)
        nb[:, j] = v
    deg = (nb >= 0).sum(1)
    X = (xs - 1).astype(np.float64)
    Y = (ys - 1).astype(np.float64)
    Dp = D[ys - 1, xs - 1].astype(np.float64)
    nbl = [[t for t in row if t >= 0] for row in nb.tolist()]
    degl = deg.tolist()

    # ---- cadeias entre pixels-no (grau != 2)
    chains = []
    visited = set()
    seen = np.zeros(N, bool)
    for p in range(N):
        if degl[p] == 2:
            continue
        seen[p] = True
        for q in nbl[p]:
            if (p, q) in visited:
                continue
            chain = [p, q]
            prev, cur = p, q
            while degl[cur] == 2:
                a = nbl[cur]
                nxt = a[0] if a[0] != prev else a[1]
                chain.append(nxt)
                prev, cur = cur, nxt
            visited.add((p, q))
            visited.add((cur, prev))
            chains.append(chain)
    for ch in chains:
        seen[ch] = True
    loops = []
    for p in range(N):
        if seen[p]:
            continue
        chain = [p]
        prev, cur = -1, p
        guard = 0
        while guard < N + 2:
            guard += 1
            a = nbl[cur]
            nxt = a[0] if a[0] != prev else a[1]
            if nxt == p:
                break
            chain.append(nxt)
            seen[nxt] = True
            prev, cur = cur, nxt
        seen[p] = True
        loops.append(chain)
    dots = [(X[p], Y[p]) for p in range(N) if degl[p] == 0]

    # ---- une pixels-juncao proximos (union-find)
    uf = list(range(N))

    def find(a):
        while uf[a] != a:
            uf[a] = uf[uf[a]]
            a = uf[a]
        return a

    kept = []
    for ch in chains:
        a, b = ch[0], ch[-1]
        if degl[a] >= 3 and degl[b] >= 3:
            steps = len(ch) - 1
            if steps <= max(2.0, 1.0 * (Dp[a] + Dp[b])):
                ra, rb = find(a), find(b)
                if ra != rb:
                    uf[ra] = rb
                continue
        kept.append(ch)
    node_of = {}
    npos = []
    nrad = []
    members = {}
    for p in range(N):
        if degl[p] != 2 and degl[p] != 0:
            members.setdefault(find(p), []).append(p)
    for root, mem in members.items():
        nid = len(npos)
        for p in mem:
            node_of[p] = nid
        npos.append(np.array([X[mem].mean(), Y[mem].mean()]))
        nrad.append(float(Dp[mem].max()))

    edges = []  # [a, b, pts, alive]
    for ch in kept:
        pts = np.stack([X[ch], Y[ch]], 1)
        a, b = node_of[ch[0]], node_of[ch[-1]]
        if a == b and _polylen(pts) < 2.5 * nrad[a] + 2:
            continue
        edges.append([a, b, pts, True])

    def degrees():
        dg = {}
        for e in edges:
            if e[3]:
                dg[e[0]] = dg.get(e[0], 0) + 1
                dg[e[1]] = dg.get(e[1], 0) + 1
        return dg

    def dissolve():
        """Funde as duas arestas de cada no de grau 2."""
        changed = True
        while changed:
            changed = False
            inc = {}
            for i, e in enumerate(edges):
                if e[3]:
                    inc.setdefault(e[0], []).append((i, 0))
                    inc.setdefault(e[1], []).append((i, 1))
            busy = set()
            for nd, lst in inc.items():
                if len(lst) != 2:
                    continue
                (i1, s1), (i2, s2) = lst
                if i1 == i2 or i1 in busy or i2 in busy:
                    continue
                e1, e2 = edges[i1], edges[i2]
                p1 = e1[2] if s1 == 1 else e1[2][::-1]   # termina em nd
                p2 = e2[2] if s2 == 0 else e2[2][::-1]   # comeca em nd
                a = e1[0] if s1 == 1 else e1[1]
                b = e2[1] if s2 == 0 else e2[0]
                if np.allclose(p1[-1], p2[0]):
                    p2 = p2[1:]
                e1[3] = False
                e2[3] = False
                busy.add(i1)
                busy.add(i2)
                edges.append([a, b, np.concatenate([p1, p2]), True])
                changed = True

    spur_abs = spur_px * k
    for _ in range(4):
        dg = degrees()
        removed = False
        for e in edges:
            if not e[3] or e[0] == e[1]:
                continue
            la = dg.get(e[0], 0) == 1
            lb = dg.get(e[1], 0) == 1
            if la == lb:
                continue
            jn = e[1] if la else e[0]
            if dg.get(jn, 0) >= 3 and _polylen(e[2]) < nrad[jn] + spur_abs:
                e[3] = False
                removed = True
        dissolve()
        if not removed:
            break
    edges = [e for e in edges if e[3]]

    # ---- juncoes: emparelha continuacoes suaves, limpa a geometria
    inc = {}
    for i, e in enumerate(edges):
        inc.setdefault(e[0], []).append((i, 0))
        inc.setdefault(e[1], []).append((i, 1))
    partner = {}
    newpos = {}
    cut = {}   # (edge, end) -> quantos pontos descartar nessa ponta
    cos_thr = math.cos(math.radians(pair_deg))
    for nd, lst in inc.items():
        if len(lst) < 3:
            continue
        pos = npos[nd]
        rho = 1.5 * nrad[nd] + 1.0
        dirs = []
        cutpts = []
        for (i, sd) in lst:
            pts = edges[i][2] if sd == 0 else edges[i][2][::-1]
            dist = np.hypot(pts[:, 0] - pos[0], pts[:, 1] - pos[1])
            far = np.nonzero(dist > rho)[0]
            ci = int(far[0]) if len(far) else len(pts) - 1
            far2 = np.nonzero(dist > rho + max(4.0, 2 * nrad[nd]))[0]
            di = int(far2[0]) if len(far2) else len(pts) - 1
            dirs.append(_unit(pts[di] - pos))
            cutpts.append(pts[ci])
            cut[(i, sd)] = ci if len(far) else len(pts)
        cand = []
        for a in range(len(lst)):
            for b in range(a + 1, len(lst)):
                if lst[a][0] == lst[b][0]:
                    continue
                c = -float(dirs[a] @ dirs[b])
                if c >= cos_thr:
                    cand.append((c, a, b))
        cand.sort(reverse=True)
        used = set()
        pairs = []
        for c, a, b in cand:
            if a in used or b in used:
                continue
            used.add(a)
            used.add(b)
            partner[lst[a]] = lst[b]
            partner[lst[b]] = lst[a]
            pairs.append((a, b))
        P = pos
        if junction_clean and pairs:
            projs = []
            for a, b in pairs:
                A, B = cutpts[a], cutpts[b]
                ab = B - A
                den = float(ab @ ab)
                t = 0.5 if den < 1e-9 else min(1.0, max(0.0, float((pos - A) @ ab) / den))
                projs.append(A + t * ab)
            if len(pairs) >= 2:
                A1, B1 = cutpts[pairs[0][0]], cutpts[pairs[0][1]]
                A2, B2 = cutpts[pairs[1][0]], cutpts[pairs[1][1]]
                d1, d2 = B1 - A1, B2 - A2
                cr = d1[0] * d2[1] - d1[1] * d2[0]
                Xp = None
                if abs(cr) > 1e-6:
                    w = A2 - A1
                    t = (w[0] * d2[1] - w[1] * d2[0]) / cr
                    cand_p = A1 + t * d1
                    if math.hypot(*(cand_p - pos)) <= rho:
                        Xp = cand_p
                P = Xp if Xp is not None else np.mean(projs, axis=0)
            else:
                P = projs[0]
        newpos[nd] = P

    final_pts = []
    for i, e in enumerate(edges):
        pts = e[2]
        n = len(pts)
        c0 = cut.get((i, 0), 0) if junction_clean else 0
        c1 = cut.get((i, 1), 0) if junction_clean else 0
        head = [newpos[e[0]]] if e[0] in newpos else []
        tail = [newpos[e[1]]] if e[1] in newpos else []
        if not head:
            c0 = 0
        if not tail:
            c1 = 0
        mid = pts[c0:n - c1] if c0 + c1 < n else np.zeros((0, 2))
        if not junction_clean:
            mid = pts[1:-1] if (head and tail) else (pts[1:] if head else (pts[:-1] if tail else pts))
        parts = ([np.array(head)] if head else []) + [mid] + ([np.array(tail)] if tail else [])
        final_pts.append(np.concatenate(parts) if parts else mid)

    # ---- monta tracos seguindo os pares
    used = set()
    strokes = []

    def walk(i, sd):
        seq = []
        closed = False
        first = i
        while True:
            used.add(i)
            pts = final_pts[i] if sd == 0 else final_pts[i][::-1]
            seq.append(pts if not seq else pts[1:])
            nxt = partner.get((i, 1 - sd))
            if nxt is None:
                break
            if nxt[0] in used:
                closed = nxt[0] == first and nxt[1] == (0 if seq else 0)
                break
            i, sd = nxt
        return np.concatenate(seq), closed

    for i in range(len(edges)):
        if i in used:
            continue
        for sd in (0, 1):
            if (i, sd) not in partner:
                pts, _ = walk(i, sd)
                # laco que volta ao proprio inicio (ex.: janela com rebarba removida)
                if len(pts) > 8 and math.hypot(*(pts[0] - pts[-1])) < 2.6 and _polylen(pts) > 10:
                    strokes.append((pts[:-1], True))
                else:
                    strokes.append((pts, False))
                break
    for i in range(len(edges)):
        if i in used:
            continue
        pts, _ = walk(i, 0)
        cl = len(pts) > 3 and math.hypot(*(pts[0] - pts[-1])) < 1e-6
        strokes.append((pts[:-1] if cl else pts, cl))
    for ch in loops:
        if len(ch) >= 4:
            strokes.append((np.stack([X[ch], Y[ch]], 1), True))

    # ---- converte para px originais; separa pontos
    out = []
    for pts, cl in strokes:
        if len(pts) < 2:
            if len(pts) == 1:
                dots.append((pts[0][0], pts[0][1]))
            continue
        q = (pts + 0.5) / k
        if not cl and _polylen(q) < dot_px:
            m = q.mean(0)
            out.append(("dot", m))
        else:
            out.append((q, cl))
    dots_o = [((x + 0.5) / k, (y + 0.5) / k) for x, y in dots] + [tuple(m) for t, m in out if isinstance(t, str)]
    polys = [(q, cl) for q, cl in out if not isinstance(q, str)]
    return polys, dots_o


# =====================================================================
# Cobertura com caneta: contornos paralelos + linha central no que sobra
# =====================================================================
def pen_cover(f, k, pen_px, overlap=0.2, delta=0.15, reach=1.5, min_area_px=0.6, fill=True,
              spur_px=1.0, log=print):
    """Gera os tracos de uma caneta de largura pen_px (px originais) que pintam a tinta.

    Devolve (polys [(pts, closed)], dots, ink_mask_k).
    """
    ink = clean_mask(f < 0, max(2.0, min_area_px * k * k)).astype(bool)
    wk = pen_px * k
    r = wk / 2
    polys = []
    if fill:
        D = cv2.distanceTransform(ink.astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE) - 0.5
        s = wk * (1 - overlap)
        dl = delta * wk
        cover = np.zeros(ink.shape, np.uint8)
        thick = int(round(wk)) + 2
        dmax = float(D.max())
        j = 0
        nloops = 0
        while True:
            d = r + j * s
            if dmax < d + dl:
                break
            core = D >= d + dl
            ysc, xsc = np.nonzero(core.any(1))[0], np.nonzero(core.any(0))[0]
            mg = int(reach * wk + 6)
            y0, y1 = max(0, ysc[0] - mg), min(D.shape[0], ysc[-1] + mg + 1)
            x0, x1 = max(0, xsc[0] - mg), min(D.shape[1], xsc[-1] + mg + 1)
            dc = cv2.distanceTransform((~core[y0:y1, x0:x1]).astype(np.uint8), cv2.DIST_L2, 5)
            g = np.minimum(D[y0:y1, x0:x1] - d, reach * wk - dc)
            g = cv2.GaussianBlur(g, (0, 0), 0.7)
            gp = np.pad(g, 1, constant_values=-1.0)
            for c in find_contours(gp, 0.0):
                if len(c) < 8:
                    continue
                xy = c[:-1, ::-1] - 1 + np.array([x0, y0])
                cv2.polylines(cover, [np.round(xy).astype(np.int32)], True, 1, thickness=thick)
                polys.append(((xy + 0.5) / k, True))
                nloops += 1
            j += 1
        log(f"  contornos paralelos: {nloops} lacos em {j} niveis")
        residual = ink & (cover == 0)
        residual = clean_mask(residual, max(2.0, 0.5 * wk * wk)).astype(bool)
    else:
        residual = ink
    cl, dots = skeleton_strokes(residual, k, spur_px=spur_px)
    log(f"  linha central: {len(cl)} tracos, {len(dots)} pontos")
    return polys, cl, dots, ink


def coverage_score(paths, dots, ink, k, pen_px):
    """Simula a caneta e compara com a tinta original. Devolve (cobertura, excesso)."""
    canvas = np.zeros(ink.shape, np.uint8)
    th = max(1, int(round(pen_px * k)))
    for p in paths:
        q = np.round(path_flatten(p, 0.25) * k - 0.5).astype(np.int32)
        cv2.polylines(canvas, [q], p["closed"], 1, thickness=th, lineType=cv2.LINE_8)
    for x, y in dots:
        cv2.circle(canvas, (int(round(x * k - 0.5)), int(round(y * k - 0.5))), max(1, th // 2), 1, -1)
    drawn = canvas > 0
    inter = (drawn & ink).sum()
    return inter / max(ink.sum(), 1), (drawn & ~ink).sum() / max(drawn.sum(), 1), drawn
