# Laboratorio (referencia em Python)

Aqui fica o tracador de referencia, em Python, que serviu para escolher o metodo antes de ele ser
reescrito em TypeScript (`src/core/trace`). Ele NAO faz parte do site: serve para comparar resultados.

- `python/vec.py` — campo de tinta, esqueleto, grafo de tracos, ajuste de curvas.
- `python/photo.py` — estilos de traco para foto (hachura cruzada, linhas onduladas, nanquim).
- `python/illus.py` — ilustracao colorida -> desenho de linhas limpo (apaga a textura, acha os contornos).
  E a referencia do modo "illus" (`src/core/trace/illus.ts`).

Para rodar e preciso de Python com `numpy`, `opencv-python`, `scipy` e `scikit-image`. Na maquina do Artur
isso ja existe em `D:\Programacao\Projetos Python\vetorizador\.venv\Scripts\python.exe`.

Os testes de `src/core/trace` comparam a versao TypeScript com dados gerados por estes arquivos
(`src/core/trace/__fixtures__`). Os scripts que geram esses dados ficam em `lab/python/fixtures_*.py`
(`fixtures_raster.py`, `fixtures_strokes.py` e `fixtures_illus.py`).
Imagens de terceiros nao entram no repositorio: os dados de teste sao sinteticos.
