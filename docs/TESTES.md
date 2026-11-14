# Testes na máquina

Registro dos testes manuais (roteiro completo em [PLAN.md](PLAN.md), seção 4.4). Preencha a coluna "Resultado" e as observações.

## Roteiro da v1 (envio pelo LaserGRBL)

Os G-codes ficam em `out/` (não vão para o git). Para gerar de novo: importe o SVG de `samples/` no app, deixe-o na origem e clique em **Exportar .gcode** (aba Trabalho). `buffer.svg` e `estresse.svg` saem de `node scripts/make-stress-svg.mjs`.

**Antes de cada teste:** papel com o canto na origem (frente à esquerda), Home (`$H`) no LaserGRBL. Todos os arquivos começam com `G0` até o primeiro ponto, então tanto faz onde a máquina está.

| # | Teste | Arquivo | Como conferir | Esperado | Resultado |
|---|---|---|---|---|---|
| 1 | Escala | `out/teste_quadrado_circulo.gcode` (~34 s) | Régua/paquímetro no quadrado e no círculo | Quadrado 100,0 ± 0,3 mm; círculo Ø 60 ± 0,3 mm; mesmos cantos do teste à mão de 07/11 (10,10)–(110,110), centro (60,60) | |
| 2 | Escala pelo Inkscape | um quadrado 100 × 100 mm feito por você no Inkscape | Importar no app, exportar, desenhar, medir | 100 × 100 mm | |
| 3 | Orientação | `out/orientacao.gcode` (~22 s) | Foto da tela com o `orientacao.svg` importado × papel visto da frente da máquina | "F" legível, seta para cima e para a direita, igual à tela | |
| 4 | Área | (no app) | Arrastar um desenho para fora da mesa | Contorno vermelho, aviso no rodapé, "Exportar" bloqueado dizendo quanto saiu; ao voltar, tudo normal | |
| 5 | Velocidade dinâmica | `out/curvas_dinamico.gcode` (~1 min 35 s) e `out/curvas_fixo_F2000.gcode` (~47 s) | Desenhar os dois em folhas diferentes e comparar o arco R50, os círculos R20 e R5 e a espiral | O dinâmico sem ondulação; o F2000 provavelmente ondula nas curvas | |
| 6 | Buffer (gagueira) | `out/buffer.gcode` (~5 min 37 s, 2493 segmentos a partir de 0,1 mm) | Escutar a máquina nos trechos densos (rosácea, ondas, espiral) | Movimento contínuo, sem "para-e-anda". Se gaguejar: Configurações → Tempo mín. por segmento 10 → 15 ms e exportar de novo | |
| 7 | Tempo | todos os acima | Cronometrar do início ao fim | Dentro de ±10% do tempo estimado (entre parênteses) | |
| 8 | Gabaritos | `out/gabarito_a4.gcode` (~31 s) e `out/gabarito_a3.gcode` (~44 s) | Comparar o retângulo desenhado com a marcação na madeira | Coincidir. Se não: medir x, y reais e corrigir em Configurações → Gabaritos | |
| 9 | LaserGRBL | todos os `.gcode` | Abrir e rodar | Sem nenhum erro (`error:N`) nem alarme | |
| 10 | Sessão | (no app) | Montar uma mesa com 3 desenhos, fechar o Chrome, abrir de novo | Desenhos e posições iguais; rodapé diz "Sessão restaurada" | |

Se o teste 5 mostrar ondulação no dinâmico, baixe a faixa correspondente em **Configurações → Velocidades** (ex.: curvas fechadas 600 → 400), exporte de novo e repita. Anote os valores finais na tabela abaixo.

## Valores calibrados

Preencher depois dos testes da T17 (velocidade dinâmica, `minSegmentTimeMs`, gabaritos).

| Parâmetro | Padrão | Calibrado | Data | Como foi medido |
|---|---|---|---|---|
| `feed.straight` | 2000 | | | |
| `feed.curve` | 1200 | | | |
| `feed.tightCurve` | 600 | | | |
| `dynamic.curveMinRadiusMm` | 40 | | | |
| `motion.minSegmentTimeMs` | 10 | | | |
| Gabarito A4 (x, y) | (0, 0) | | | |
| Gabarito A3 (x, y) | (0, 0) | | | |

## Goldens aprovados

Um G-code de `samples/golden/` só vale depois de rodar na máquina e sair certo.

| Arquivo | Data | Resultado |
|---|---|---|
| `teste_quadrado_circulo.dinamico.gcode` | | |
| `teste_quadrado_circulo.otimizado.gcode` (= `out/teste_quadrado_circulo.gcode`, só muda a data) | | |
| `orientacao.fixo.gcode` | | |
| `curvas.dinamico.gcode` | | |

## Registro

| Data | Tarefa | Teste | Resultado | Observação |
|---|---|---|---|---|
| 14/11/2026 | T07–T17 | Testes automáticos no navegador (Chrome headless, sem GPU) | Passou | Importar, arrastar, girar em grupo, desfazer, atalhos, painel, exportar = golden, pré-visualização, configurações, sessão restaurada depois de fechar o Chrome |
| 14/11/2026 | T17 | Desempenho com `estresse.svg` (20 mil traços, 351 mil pontos) | Passou | `planJob` 337 ms; arrastar mediana 16,7 ms/quadro (p90 33 ms); pan ~36 fps. Medido sem GPU: no Chrome normal deve ser melhor. Confirme no seu notebook (F12 → Performance). |
