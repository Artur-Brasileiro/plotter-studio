"""
Gera os fixtures de paridade do modo "illus" do tracador (src/core/trace/illus.ts).

Roda a referencia de verdade (lab/python/illus.py) numa cena SINTETICA colorida desenhada aqui mesmo
(caixa amarela com ferrugem, roda escura, lente azul, duas cores de mesma luminancia, uma linha fina)
e grava a entrada e a saida de cada etapa em src/core/trace/__fixtures__/illus/*.json.
Nenhum valor esperado e escrito a mao e nenhuma imagem de terceiros entra no repositorio.

Uso (na raiz do repositorio):
    python lab/python/fixtures_illus.py [--preview pasta]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import illus  # noqa: E402
from fixtures_raster import enc  # noqa: E402  (mesmo formato dos outros fixtures)

OUT = HERE.parent.parent / "src" / "core" / "trace" / "__fixtures__" / "illus"
SS = 4


def write(name: str, cases: list, note: str) -> int:
    doc = {"generator": "lab/python/fixtures_illus.py", "note": note,
           "versions": {"opencv": cv2.__version__, "numpy": np.__version__}, "cases": cases}
    OUT.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=1, ensure_ascii=True) + "\n"
    (OUT / name).write_text(text, encoding="ascii", newline="\n")
    print(f"  {name}: {len(cases)} casos, {len(text) / 1024:.0f} KB")
    return len(text)


def scene(w: int = 80, h: int = 64, seed: int = 5) -> np.ndarray:
    """Cena colorida (H, W, 3) uint8 em R, G, B, parecida com uma ilustracao pintada e comprimida."""
    rng = np.random.default_rng(seed)
    img = np.empty((h * SS, w * SS, 3), np.uint8)
    img[:] = (238, 232, 218)                                                   # papel creme
    p = lambda x, y: (int(round(x * SS)), int(round(y * SS)))                  # noqa: E731
    cv2.rectangle(img, p(8, 16), p(44, 52), (228, 176, 40), -1, cv2.LINE_AA)   # caixa amarela
    for _ in range(170):                                                       # ferrugem: pintas marrons
        x, y = rng.uniform(9, 43), rng.uniform(17, 51)
        cv2.circle(img, p(x, y), int(round(rng.uniform(0.4, 1.0) * SS)), (150, 88, 34), -1, cv2.LINE_AA)
    cv2.circle(img, p(58, 46), int(13 * SS), (58, 54, 50), -1, cv2.LINE_AA)    # roda escura
    cv2.circle(img, p(58, 46), int(6 * SS), (120, 112, 104), -1, cv2.LINE_AA)  # miolo mais claro
    cv2.circle(img, p(26, 30), int(8 * SS), (24, 22, 22), -1, cv2.LINE_AA)     # aro preto
    cv2.circle(img, p(26, 30), int(6 * SS), (40, 90, 200), -1, cv2.LINE_AA)    # lente azul
    cv2.rectangle(img, p(50, 5), p(63, 22), (200, 60, 60), -1, cv2.LINE_AA)    # vermelho e verde de MESMA
    cv2.rectangle(img, p(63, 5), p(76, 22), (40, 140, 60), -1, cv2.LINE_AA)    # luminancia (~101)
    cv2.line(img, p(2, 59), p(78, 57), (70, 70, 80), int(1.0 * SS), cv2.LINE_AA)  # linha fina
    small = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
    small = cv2.GaussianBlur(small, (0, 0), 0.5)
    small += rng.normal(0.0, 3.0, small.shape).astype(np.float32)              # grao
    u8 = np.clip(np.round(small), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", u8[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 80])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)[..., ::-1].copy()


def coherent(chans: list, sigma_c: float) -> np.ndarray:
    """Onde a direcao da borda e bem definida (so ali vale comparar a tangente numero a numero)."""
    e = f = g = 0.0
    for c in chans:
        gx = cv2.Scharr(c.astype(np.float32), cv2.CV_32F, 1, 0).astype(np.float64) / 32.0
        gy = cv2.Scharr(c.astype(np.float32), cv2.CV_32F, 0, 1).astype(np.float64) / 32.0
        e, f, g = e + gx * gx, f + gx * gy, g + gy * gy
    e, f, g = [cv2.GaussianBlur(a.astype(np.float32), (0, 0), sigma_c).astype(np.float64) for a in (e, f, g)]
    root = np.sqrt((e - g) ** 2 + 4 * f * f)
    lam1, lam2 = 0.5 * (e + g + root), 0.5 * (e + g - root)
    return (lam1 > 1e-6) & ((lam1 - lam2) / np.maximum(lam1 + lam2, 1e-30) > 0.3)


def fx_line_art(u8: np.ndarray) -> int:
    rgb = u8.astype(np.float32) / 255.0
    cases = []

    def add(name, detail, edge=0.5, mono=False, negative=False):
        src = 1.0 - rgb if negative else rgb
        if mono:
            lum = illus.luma(src)
            src = np.stack([lum, lum, lum], -1)
        p = illus.params_for(detail, edge)
        r = illus.line_art(src, mono=mono, **p)
        sigma_c = max(1.5, 2.0 * p["sigma_e"])
        chans = [r["tone"]] if mono else [r["smooth"][..., c] for c in range(3)]
        case = {"name": name, "detail": detail, "edge": edge, "mono": mono, "params": p, "sigmaC": sigma_c,
                "r": enc(src[..., 0]), "g": enc(src[..., 1]), "b": enc(src[..., 2]),
                "smoothR": enc(r["smooth"][..., 0]), "smoothG": enc(r["smooth"][..., 1]), "smoothB": enc(r["smooth"][..., 2]),
                "tone": enc(r["tone"]), "tx": enc(r["tx"]), "ty": enc(r["ty"]), "coherent": enc(coherent(chans, sigma_c)),
                "raw": enc(r["raw"]), "resp": enc(r["resp"]), "lo": r["lo"], "hi": r["hi"],
                "keep": enc(r["keep"]), "v": enc(r["v"]), "gray": enc(r["gray"]),
                "background": illus.border_median(r["tone"]), "dark": enc(illus.tone_darkness(r["tone"]))}
        cases.append(case)
        print(f"    {name}: linha {r['keep'].mean() * 100:.1f}% dos px, resposta max {r['resp'].max():.3f}, "
              f"limiares {r['lo']:.4f} / {r['hi']:.4f}")
        return r

    add("cena 80x64 detalhe 0.75 (padrao)", 0.75)
    add("cena detalhe 0.25 (limpo)", 0.25)
    add("cena detalhe 1 com linhas fracas (edge 0.9)", 1.0, 0.9)
    add("cena em cinza (mono) detalhe 0.5", 0.5, mono=True)
    add("cena em negativo (fundo escuro) detalhe 0.75", 0.75, negative=True)
    return write("line_art.json", cases,
                 "illus.line_art(rgb, **illus.params_for(detail, edge)) etapa por etapa + illus.tone_darkness(tone); "
                 "r, g, b em 0..1 (float32)")


def fx_resample(u8: np.ndarray) -> int:
    lum = illus.luma(u8.astype(np.float32) / 255.0)
    cases = []
    for name, src, size in [
        ("reduz 2.5x (borra antes)", lum, (32, 26)),
        ("reduz 1.25x (sem borrar)", lum, (64, 51)),
        ("amplia 1.7x", lum[10:40, 8:44], (61, 51)),
        ("mesmo tamanho", lum[0:9, 0:12], (12, 9)),
        ("proporcao diferente em x e y", lum, (50, 20)),
        ("uma linha", lum[30:31, :], (33, 1)),
    ]:
        src = np.ascontiguousarray(src, dtype=np.float32)
        cases.append({"name": name, "src": enc(src), "width": size[0], "height": size[1],
                      "out": enc(illus.resample(src, size[0], size[1]))})
    return write("resample.json", cases, "illus.resample(src, width, height)")


def fx_guided(u8: np.ndarray) -> int:
    rgb = u8.astype(np.float32) / 255.0
    lum = illus.luma(rgb)
    cases = []
    for name, guide, src, r, eps in [
        ("guia = a propria imagem, r=2", lum, lum, 2, 0.02 ** 2),
        ("guia borrada, canal vermelho, r=4", cv2.GaussianBlur(lum, (0, 0), 2.0), rgb[..., 0], 4, 0.02 ** 2),
        ("janela maior que a imagem, r=9", lum[20:32, 30:44], rgb[20:32, 30:44, 2], 9, 1e-3),
        ("r=1 eps grande", lum[0:20, 0:24], lum[0:20, 0:24], 1, 0.05),
    ]:
        guide, src = np.ascontiguousarray(guide, np.float32), np.ascontiguousarray(src, np.float32)
        cases.append({"name": name, "guide": enc(guide), "src": enc(src), "r": r, "eps": eps,
                      "box": enc(illus.box(src, r).astype(np.float32)), "out": enc(illus.guided(guide, src, r, eps))})
    return write("guided.json", cases, "illus.box(src, r) e illus.guided(guide, src, r, eps)")


def main() -> None:
    print(f"opencv {cv2.__version__}  numpy {np.__version__}")
    u8 = scene()
    if "--preview" in sys.argv:
        prev = Path(sys.argv[sys.argv.index("--preview") + 1])
        prev.mkdir(parents=True, exist_ok=True)
        big = cv2.resize(u8[..., ::-1], None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
        cv2.imencode(".png", big)[1].tofile(str(prev / "cena_illus.png"))
        r = illus.line_art(u8.astype(np.float32) / 255.0, **illus.params_for(0.75))
        g = cv2.resize(np.clip(r["gray"], 0, 255).astype(np.uint8), None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
        cv2.imencode(".png", g)[1].tofile(str(prev / "cena_illus_linhas.png"))
    print(f"gravando em {OUT}")
    total = fx_line_art(u8) + fx_resample(u8) + fx_guided(u8)
    print(f"total: {total / 1024:.0f} KB")


if __name__ == "__main__":
    main()
