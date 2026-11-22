"""
Gera os fixtures de paridade da metade "raster" do tracador (src/core/trace).

Roda a referencia de verdade (OpenCV, NumPy, scikit-image e lab/python/vec.py) em imagens
SINTETICAS desenhadas aqui mesmo e grava entradas + saidas esperadas em
src/core/trace/__fixtures__/raster/*.json. Os testes do vitest (raster.test.ts,
inkField.test.ts, skeleton.test.ts) carregam esses arquivos e comparam com o TypeScript.
Nenhum valor esperado e escrito a mao e nenhuma imagem de terceiros entra no repositorio.

Uso (na raiz do repositorio, com numpy + opencv-python + scikit-image + scipy instalados):
    python lab/python/fixtures_raster.py

Formato de cada matriz no JSON: {"dtype": "f32" | "u8", "width", "height", "data"}, onde
data = base64( zlib( bytes ) ). "u8" sao os bytes linha a linha; "f32" sao os float32
little-endian linha a linha com os bytes "embaralhados" (primeiro o byte 0 de todos os
valores, depois o byte 1, ...), o que faz o zlib comprimir bem mais.
"""
from __future__ import annotations

import base64
import json
import sys
import zlib
from pathlib import Path

import cv2
import numpy as np
import skimage
from skimage.morphology import skeletonize

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import vec  # noqa: E402  (a referencia: lab/python/vec.py)

OUT = HERE.parent.parent / "src" / "core" / "trace" / "__fixtures__" / "raster"

SS = 4  # superamostragem do desenho das cenas


# =====================================================================
# Codificacao
# =====================================================================
def enc(a) -> dict:
    """Matriz 2-D (ou vetor) -> dict compacto. float64 e bool sao convertidos (f32 / u8)."""
    a = np.asarray(a)
    if a.ndim == 1:
        a = a[None, :]
    assert a.ndim == 2, a.shape
    h, w = a.shape
    if a.dtype == np.bool_ or a.dtype == np.uint8:
        dtype = "u8"
        raw = np.ascontiguousarray(a.astype(np.uint8)).tobytes()
    elif a.dtype in (np.float32, np.float64):
        dtype = "f32"
        b = np.ascontiguousarray(a.astype("<f4")).view(np.uint8).reshape(-1, 4)
        raw = np.ascontiguousarray(b.T).tobytes()  # embaralhado: todos os bytes 0, depois os 1, ...
    else:
        raise TypeError(a.dtype)
    return {"dtype": dtype, "width": int(w), "height": int(h),
            "data": base64.b64encode(zlib.compress(raw, 9)).decode("ascii")}


def write(name: str, cases: list, note: str) -> int:
    doc = {
        "generator": "lab/python/fixtures_raster.py",
        "note": note,
        "versions": {"opencv": cv2.__version__, "numpy": np.__version__, "scikit-image": skimage.__version__},
        "ipp": bool(cv2.ipp.useIPP()),
        "cases": cases,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    text = json.dumps(doc, indent=1, ensure_ascii=True) + "\n"
    path.write_text(text, encoding="ascii", newline="\n")
    print(f"  {name}: {len(cases)} casos, {len(text) / 1024:.0f} KB")
    return len(text)


# =====================================================================
# Cenas sinteticas (parecidas com um scan JPEG de baixa resolucao)
# =====================================================================
class Scene:
    """Desenha com anti-aliasing em SS x e depois reduz. Coordenadas em px da imagem final."""

    def __init__(self, w: int, h: int):
        self.w, self.h = w, h
        self.img = np.full((h * SS, w * SS), 255, np.uint8)

    @staticmethod
    def _pt(p):
        return int(round(p[0] * SS)), int(round(p[1] * SS))

    def line(self, p0, p1, width, ink=40):
        cv2.line(self.img, self._pt(p0), self._pt(p1), int(ink), max(1, int(round(width * SS))), cv2.LINE_AA)

    def circle(self, c, r, width, ink=40):
        cv2.circle(self.img, self._pt(c), int(round(r * SS)), int(ink), max(1, int(round(width * SS))), cv2.LINE_AA)

    def disk(self, c, r, ink=40):
        cv2.circle(self.img, self._pt(c), max(1, int(round(r * SS))), int(ink), -1, cv2.LINE_AA)

    def ellipse(self, c, axes, angle, width, ink=40, a0=0, a1=360):
        cv2.ellipse(self.img, self._pt(c), self._pt(axes), angle, a0, a1, int(ink),
                    max(1, int(round(width * SS))), cv2.LINE_AA)

    def text(self, s, org, scale, width, ink=40):
        cv2.putText(self.img, s, self._pt(org), cv2.FONT_HERSHEY_SIMPLEX, scale * SS, int(ink),
                    max(1, int(round(width * SS))), cv2.LINE_AA)

    def render(self, seed: int, blur=0.6, noise=3.0, jpeg=60) -> tuple[np.ndarray, np.ndarray]:
        """Devolve (float32 antes de arredondar, uint8 depois de passar por um JPEG de verdade)."""
        rng = np.random.default_rng(seed)
        g = cv2.resize(self.img, (self.w, self.h), interpolation=cv2.INTER_AREA).astype(np.float32)
        # papel: nao e branco puro e a iluminacao varia de um lado para o outro
        xx, yy = np.meshgrid(np.arange(self.w, dtype=np.float32), np.arange(self.h, dtype=np.float32))
        paper = 244.0 - 22.0 * xx / self.w - 10.0 * yy / self.h
        g = g * (paper / 255.0)
        g = cv2.GaussianBlur(g, (0, 0), blur)
        g = g + rng.normal(0.0, noise, g.shape).astype(np.float32)
        g = np.clip(g, 0, 255).astype(np.float32)
        ok, buf = cv2.imencode(".jpg", np.round(g).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, jpeg])
        assert ok
        u8 = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
        return g, u8


def scene_tracos() -> Scene:
    """Linhas de varias larguras e angulos, circulo, elipse, paralelas quase encostadas, T, X, pontos, texto."""
    s = Scene(96, 80)
    s.line((4, 5), (58, 5), 1.0)                 # horizontal fina
    s.line((5, 11), (60, 25), 2.0, ink=55)       # ~14 graus
    s.line((70, 3), (70, 40), 3.0, ink=30)       # vertical grossa
    s.line((60, 6), (92, 36), 1.5)               # 45 graus: cruza a vertical (X)
    s.line((84, 3), (92, 30), 2.0, ink=60)       # ~73 graus
    s.circle((20, 46), 11, 2.0)
    s.ellipse((54, 52), (15, 7), 25, 1.5, ink=50)
    s.line((5, 66), (48, 66), 1.5)               # paralelas com 1,5 px de vao
    s.line((5, 69), (48, 69), 1.5)
    s.line((56, 70), (92, 70), 2.0)              # T
    s.line((76, 70), (76, 78), 2.0)
    s.line((62, 60), (90, 78), 1.0, ink=70)      # cruza a barra do T em angulo raso
    s.disk((36, 34), 0.7)
    s.disk((42, 34), 1.2)
    s.disk((48, 33), 0.5, ink=90)
    s.text("aR4", (4, 79), 0.32, 1.0)
    s.text("e", (79, 55), 0.4, 1.2)
    return s


def scene_bordas() -> Scene:
    """Tinta encostando nas quatro bordas e nos cantos."""
    s = Scene(72, 60)
    s.line((10, 0.5), (50, 0.5), 2.0)            # ao longo da borda de cima
    s.line((-6, 18), (30, 34), 3.0, ink=35)      # entra pela esquerda
    s.line((40, 28), (40, 66), 2.0)              # sai por baixo
    s.circle((70, 28), 12, 2.0, ink=50)          # cortado pela direita
    s.disk((0, 60), 6)                           # borrao no canto de baixo a esquerda
    s.disk((71.5, 0.5), 1.0)                     # ponto no canto de cima a direita
    s.line((71.4, 44), (71.4, 60), 1.5)          # ao longo da borda direita
    s.text("Xy", (46, 60), 0.5, 1.2)             # texto cortado por baixo
    s.line((0, 8), (14, 8), 1.0)                 # fina saindo da esquerda
    s.line((20, 44), (34, 59.5), 1.5, ink=60)    # termina na borda de baixo
    s.ellipse((14, 46), (9, 5), -30, 1.5)
    return s


def scene_mini() -> Scene:
    """Cena pequena para variar as opcoes do campo de tinta."""
    s = Scene(40, 32)
    s.line((-2, 6), (30, 12), 2.0)
    s.ellipse((22, 20), (11, 6), 15, 1.5, a0=20, a1=300)
    s.line((30, 2), (30, 34), 1.5, ink=55)
    s.line((30, 24), (40, 24), 2.0)
    s.disk((6, 22), 1.0)
    s.disk((10, 27), 0.6)
    s.line((2, 30.5), (20, 30.5), 1.0)
    return s


# =====================================================================
# Fixtures
# =====================================================================
def fx_resize(f_bordas: np.ndarray, f_mini: np.ndarray) -> int:
    cases = []

    def add(name, src, ks):
        src = np.ascontiguousarray(src, dtype=np.float32)
        h, w = src.shape
        variants = []
        for k in ks:
            size = (w * k, h * k)
            variants.append({"k": k,
                             "bicubic": enc(cv2.resize(src, size, interpolation=cv2.INTER_CUBIC)),
                             "bilinear": enc(cv2.resize(src, size, interpolation=cv2.INTER_LINEAR))})
        cases.append({"name": name, "src": enc(src), "variants": variants})

    add("bordas 26x20", f_bordas[2:22, 0:26], [2, 3, 4])       # tinta na borda esquerda
    add("mini canto 14x11", f_mini[21:32, 0:14], [1, 5, 6])    # tinta na borda de baixo
    add("uma linha 9x1", f_mini[6:7, 0:9], [3])
    add("uma coluna 1x7", f_mini[3:10, 30:31], [4])
    add("um pixel 1x1", f_mini[6:7, 3:4], [3])
    add("2x2", f_mini[6:8, 3:5], [5])
    # Largura e altura reais (736 e 1300 px) com contraste maximo entre vizinhos. E onde aparece uma
    # diferenca DENTRO do OpenCV: com IPP (pacotes para x86, o caso desta referencia) os pesos sao
    # exatos e se repetem a cada k pixels; o codigo proprio (sem IPP) arredonda a posicao de amostragem
    # para float32 e, com k = 3, 5 ou 6, desvia ate ~0.02 nestas faixas. O port segue o IPP, entao estes
    # casos so batem se os fixtures forem gerados com IPP. O padrao e periodico: comprime quase a zero.
    yy, xx = np.mgrid[0:6, 0:736]
    add("faixa larga 736x6", 255.0 * ((xx * 7 + yy * 3) % 5 < 2), [3, 6])
    yy, xx = np.mgrid[0:1300, 0:6]
    add("faixa alta 6x1300", 255.0 * ((yy * 7 + xx * 3) % 5 < 2), [5])
    return write("resize.json", cases,
                 "cv2.resize(src, (W*k, H*k), interpolation=cv2.INTER_CUBIC / cv2.INTER_LINEAR) em float32")


def fx_blur(f_bordas: np.ndarray, f_mini: np.ndarray) -> int:
    cases = []

    def add(name, src, sigmas):
        src = np.ascontiguousarray(src, dtype=np.float32)
        variants = [{"sigma": float(sg), "out": enc(cv2.GaussianBlur(src, (0, 0), float(sg)))} for sg in sigmas]
        cases.append({"name": name, "src": enc(src), "variants": variants})

    # 0.3*k (borra final do campo), win/3 (limiar local), 1.0 (sharpen) e casos de arredondamento do tamanho
    add("bordas 44x36", f_bordas[0:36, 28:72], [0.3, 0.6, 0.9, 1.0, 1.2, 1.5, 1.8, 5 / 3, 7 / 3, 3.0])
    add("menor que o kernel 6x5", f_mini[4:9, 0:6], [1.0, 7 / 3, 0.05])  # 0.05: kernel de 1 px (copia)
    add("uma linha 12x1", f_mini[6:7, 0:12], [1.2])
    add("uma coluna 1x9", f_mini[3:12, 30:31], [1.2])
    add("um pixel 1x1", f_mini[6:7, 3:4], [2.0])
    return write("blur.json", cases, "cv2.GaussianBlur(src, (0, 0), sigma) em float32")


def fx_morph(f_bordas: np.ndarray, f_mini: np.ndarray) -> int:
    cases = []

    def add(name, src, sizes):
        src = np.ascontiguousarray(src, dtype=np.float32)
        variants = []
        for n in sizes:
            ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (n, n))
            variants.append({"size": n, "kernel": enc(ker),
                             "erode": enc(cv2.erode(src, ker)), "dilate": enc(cv2.dilate(src, ker))})
        cases.append({"name": name, "src": enc(src), "variants": variants})

    add("bordas 40x30", f_bordas[30:60, 0:40], [1, 2, 3, 4, 5, 6, 7, 9, 11])
    add("menor que o kernel 5x4", f_mini[4:8, 0:5], [7, 12])
    add("uma linha 12x1", f_mini[6:7, 0:12], [7])
    add("uma coluna 1x9", f_mini[3:12, 30:31], [5])
    return write("morph.json", cases,
                 "cv2.erode / cv2.dilate com cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)) em float32")


def fx_percentile(u_tracos: np.ndarray, f_bordas: np.ndarray) -> int:
    rng = np.random.default_rng(7)
    cases = []

    def add(name, data, ps):
        data = np.ascontiguousarray(data, dtype=np.float32).ravel()
        # forma usada em ink_field: q em lista -> float64. A forma escalar devolve float32.
        lst = np.percentile(data, list(ps))
        assert lst.dtype == np.float64
        cases.append({"name": name, "data": enc(data), "p": [float(p) for p in ps],
                      "expected": [float(v) for v in lst],
                      "expectedScalarF32": [float(np.percentile(data, float(p))) for p in ps]})

    ps = [0, 1, 2.5, 25, 33.3, 50, 75, 99, 99.9, 100]
    add("cena tracos (uint8 -> float32)", u_tracos, ps)
    add("cena bordas (float32 com fracao)", f_bordas, ps)
    add("ruido n=101", rng.random(101) * 255, ps)
    add("ruido n=1000", rng.normal(128, 40, 1000), ps)
    add("n=1", [42.5], [0, 1, 50, 100])
    add("n=2", [10.25, 200.5], [0, 1, 50, 99, 100])
    add("n=7 com repetidos", [5, 5, 5, 1, 9, 9, 2], ps)
    add("constante", np.full(64, 17.0), [1, 50, 99])
    # vizinhos de grandezas e sinais diferentes: so aqui a subtracao em float32 do _lerp do NumPy arredonda
    add("grandezas misturadas n=12", rng.normal(0, 1, 12) * 10.0 ** rng.uniform(-3, 3, 12), ps + [10, 40, 60, 90])
    return write("percentile.json", cases, "np.percentile(data, [p...]) (metodo linear), data float32")


def fx_pipeline(scenes: dict) -> int:
    """imagem -> ink_field -> f < 0 -> clean_mask -> distanceTransform + skeletonize (como em vec.py)."""
    cases = []

    def add(name, gray, k, opts, chain):
        f = vec.ink_field(gray, k, denoise=0, **opts)
        f32 = f.astype(np.float32)
        ink = f < 0
        assert np.array_equal(ink, f32 < 0)  # guardar em float32 nao muda o sinal
        case = {"name": name, "k": k, "opts": opts, "gray": enc(gray), "field": enc(f32), "mask": enc(ink)}
        if chain:
            areas = [2.0, 0.6 * k * k, 30.0, 400.0]  # 0.6*k*k e o que pen_cover usa
            case["clean"] = [{"minArea": float(a), "mask": enc(vec.clean_mask(ink, a))} for a in areas]
            m = vec.clean_mask(ink, max(2.0, 0.6 * k * k))
            case["chainMinArea"] = float(max(2.0, 0.6 * k * k))
            case["dt"] = enc(cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE))
            case["skeleton"] = enc(skeletonize(m.astype(bool)))
            assert m.any() and not m.all()
        cases.append(case)
        print(f"    {name}: campo {f.shape[1]}x{f.shape[0]} {f.dtype}, tinta {ink.mean() * 100:.1f}%")

    u_tracos = scenes["tracos"][1]
    u_bordas = scenes["bordas"][1]
    f_mini, u_mini = scenes["mini"]
    add("tracos k=3 (padrao)", u_tracos, 3, {}, True)
    add("bordas k=4 (padrao)", u_bordas, 4, {}, True)
    add("mini k=2 sharpen=0.8", u_mini, 2, {"sharpen": 0.8}, False)
    add("mini k=2 win=5 bias=-12", u_mini, 2, {"win": 5, "bias": -12.0}, False)
    add("mini k=3 blur=0", u_mini, 3, {"blur": 0.0}, False)
    add("mini k=1 cmin=20 cmax=60 blur=0.5", u_mini, 1, {"cmin": 20.0, "cmax": 60.0, "blur": 0.5}, False)
    add("mini canto k=6 (padrao)", u_mini[8:32, 14:40], 6, {}, True)
    add("mini float32 com fracao k=2", f_mini, 2, {}, False)
    return write("pipeline.json", cases,
                 "vec.ink_field(gray, k, denoise=0, **opts) -> f < 0 -> vec.clean_mask -> "
                 "cv2.distanceTransform(DIST_L2, DIST_MASK_PRECISE) e skimage.morphology.skeletonize "
                 "(os dois ultimos sobre a mascara limpa com chainMinArea)")


def fx_masks() -> int:
    """Mascaras binarias diretas para cleanMask, distanceTransform e skeletonize."""
    rng = np.random.default_rng(11)
    cases = []

    def add(name, m, areas=(2, 5, 20), dt=True):
        m = np.ascontiguousarray(m).astype(bool)
        u = m.astype(np.uint8)
        case = {"name": name, "mask": enc(u),
                "clean": [{"minArea": float(a), "mask": enc(vec.clean_mask(m, a))} for a in areas],
                "skeleton": enc(skeletonize(m))}
        if dt:
            case["dt"] = enc(cv2.distanceTransform(u, cv2.DIST_L2, cv2.DIST_MASK_PRECISE))
        cases.append(case)

    def blobs(w, h, sigma, level):
        n = cv2.GaussianBlur(rng.normal(0, 1, (h, w)).astype(np.float32), (0, 0), sigma)
        return n > level * n.std()

    # Ruido em varias densidades: passa pelas 256 vizinhancas da tabela do afinamento. Conferido por
    # mutacao: das 768 trocas possiveis de uma entrada da tabela, 766 mudam o esqueleto de algum caso
    # deste arquivo; as outras 2 (entrada 10 trocada de 3 para 1 ou 2) nao mudam esqueleto nenhum
    # (8 milhoes de mascaras ao acaso testadas).
    for dens in (0.2, 0.35, 0.5, 0.65, 0.8, 0.93):
        add(f"ruido 64x48 densidade {dens}", rng.random((48, 64)) < dens)
    add("manchas 96x72 (tinta nas bordas)", blobs(96, 72, 4.0, 0.2), areas=(2, 50, 600))
    add("manchas finas 120x90", blobs(120, 90, 2.0, 0.6), areas=(3, 12, 40))
    # >= 16384 px: o OpenCV usa a propria implementacao da distancia exata (abaixo disso usa a do IPP)
    add("manchas 200x150 (acima de 16384 px)", blobs(200, 150, 6.0, -0.3), areas=(2, 200, 3000))
    add("manchas largas 160x40", blobs(160, 40, 9.0, -0.8), areas=(2, 100))

    frame = np.ones((30, 40), bool)
    frame[6:24, 8:32] = False
    add("moldura encostada nas 4 bordas", frame)
    full_cols = np.zeros((24, 50), bool)
    full_cols[:, 10:17] = True     # faixa vertical de ponta a ponta (colunas sem nenhum papel)
    full_cols[9:13, :] = True      # faixa horizontal de ponta a ponta
    add("cruz de ponta a ponta", full_cols)
    one = np.zeros((9, 9), bool)
    one[4, 4] = True
    add("um pixel", one, areas=(1, 2))
    corner = np.zeros((7, 8), bool)
    corner[0, 0] = corner[6, 7] = corner[0, 7] = True
    corner[3:5, 3:5] = True
    add("cantos e bloco 2x2", corner, areas=(1, 2, 5))
    diag = np.zeros((16, 16), bool)
    for i in range(12):
        diag[i + 2, i + 1] = True          # diagonal de 1 px: so liga por 8-vizinhanca
        diag[i + 1, 14 - i] = True
    add("diagonais de 1 px (X)", diag, areas=(2, 12, 13, 30))
    chess = (np.indices((10, 13)).sum(0) % 2).astype(bool)
    add("xadrez", chess, areas=(2, 65, 66))  # um componente so, de 65 px: 65 fica (nao e < 65), 66 tira
    add("uma linha 20x1", (rng.random((1, 20)) < 0.7))
    add("uma coluna 1x20", (rng.random((20, 1)) < 0.7))
    add("vazia", np.zeros((6, 9), bool))
    # Sem nenhum papel a distancia nao existe e o OpenCV responde conforme o caminho interno:
    # abaixo de 16384 px usa o IPP (sai 1.8e19); dai para cima, com mais de 1 thread, usa o codigo
    # proprio (sai 65536 = sqrt(UINT_MAX)). O port segue o codigo proprio.
    add("toda tinta 14x11 (so afinamento)", np.ones((11, 14), bool), dt=False)
    assert cv2.getNumThreads() > 1, "com 1 thread o OpenCV usa o IPP tambem nas imagens grandes"
    add("toda tinta 128x128", np.ones((128, 128), bool), areas=(2,))
    return write("masks.json", cases,
                 "vec.clean_mask(mask, minArea), cv2.distanceTransform(mask, cv2.DIST_L2, cv2.DIST_MASK_PRECISE) "
                 "e skimage.morphology.skeletonize(mask), todos sobre a mesma mascara")


def main() -> None:
    print(f"opencv {cv2.__version__}  numpy {np.__version__}  scikit-image {skimage.__version__}  "
          f"IPP {'sim' if cv2.ipp.useIPP() else 'nao'}")
    if not cv2.ipp.useIPP():
        print("AVISO: OpenCV sem IPP. Os casos 'faixa' de resize.json vao divergir do TypeScript (ver fx_resize).")
    scenes = {
        "tracos": scene_tracos().render(seed=1),
        "bordas": scene_bordas().render(seed=2),
        "mini": scene_mini().render(seed=3),
    }
    if "--preview" in sys.argv:  # so para olhar as cenas; nao faz parte dos fixtures
        prev = Path(sys.argv[sys.argv.index("--preview") + 1])
        prev.mkdir(parents=True, exist_ok=True)
        for name, (_, u8) in scenes.items():
            big = cv2.resize(u8, None, fx=6, fy=6, interpolation=cv2.INTER_NEAREST)
            cv2.imencode(".png", big)[1].tofile(str(prev / f"{name}.png"))
    print(f"gravando em {OUT}")
    total = 0
    total += fx_resize(scenes["bordas"][0], scenes["mini"][0])
    total += fx_blur(scenes["bordas"][0], scenes["mini"][0])
    total += fx_morph(scenes["bordas"][0], scenes["mini"][0])
    total += fx_percentile(scenes["tracos"][1], scenes["bordas"][0])
    total += fx_pipeline(scenes)
    total += fx_masks()
    print(f"total: {total / 1024:.0f} KB")


if __name__ == "__main__":
    main()
