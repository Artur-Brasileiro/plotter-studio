# Testes na máquina

Registro dos testes manuais (roteiro completo em [PLAN.md](PLAN.md), seção 4.4). Preencha a coluna "Resultado" e as observações. A v1 (exportar e rodar no LaserGRBL) vem primeiro; a v2 (envio direto) depois.

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

## Roteiro da v2 (envio direto, sem LaserGRBL)

Abra o app no **Chrome ou Edge** (https://artur-brasileiro.github.io/plotter-studio/ ou `npm run dev`) com o **LaserGRBL fechado** (só um programa usa a COM6 de cada vez). Tudo da v2 fica na aba **Máquina**; o log da serial fica no botão **Console** (no rodapé).

Para ensaiar antes, sem a máquina: acrescente `?sim=1` na URL (um GRBL falso). Extras: `&simSpeed=5` (5× mais rápido), `&simNoLift=1` (a pausa não levanta a caneta), `&simError=30:20` (error:20 na 30ª linha), `&simDisconnect=200` (o "cabo sai" na 200ª linha).

| # | Teste | Como | Esperado | Resultado |
|---|---|---|---|---|
| 1 | Conectar | **Conectar…** no topo → escolher o Arduino (COM6) | Console mostra `Grbl 1.1h`, estado **Alarm** em vermelho; da segunda vez o botão já diz "Conectar (Arduino Uno …)" e não abre o seletor | |
| 2 | Porta em uso | Abrir o LaserGRBL conectado e clicar **Conectar** no app | Mensagem "A porta está em uso por outro programa (LaserGRBL? …)" | |
| 3 | Home | **⌂ Home** | Estado Home → **Idle** verde; posição perto de 810/385 (menos o pull-off do `$27`); a cruz azul aparece no canto de trás à direita da mesa | |
| 4 | Configuração | Ler o quadro amarelo (se aparecer) e abrir "Configuração do GRBL ($$)" | Sem avisos. **Copie a lista do $$ para cá** (pendência antiga) | |
| 5 | Jog | Passo 10: setas da tela e do teclado; depois "contínuo": segurar e soltar | ↑ afasta a caneta de você, → vai para a direita; no contínuo a máquina para **na hora** em que você solta | |
| 6 | Caneta | **Caneta ↓** e **Caneta ↑** | O servo desce e sobe; o painel mostra "Caneta embaixo/em cima" | |
| 7 | Contorno | Com um desenho na mesa: **▭ Contorno** | O retângulo percorrido (caneta em cima) envolve o desenho como na tela | |
| 8 | Envio | `orientacao.svg` na origem → **▶ Enviar desenho** | Barra anda, a cruz acompanha a caneta, o traço já feito fica forte na tela; no fim a máquina volta a (0,0) e aparece "Desenho concluído em …" | |
| 9 | **Pausa** (decide o `pen.pauseLift`) | `curvas.svg`: **⏸ Pausar** no meio de um círculo; esperar 5 s; **▶ Continuar** | A caneta **sobe** na pausa e **desce antes de andar** ao continuar, sem falha no traço. Se não subir (ou o painel avisar "o GRBL diz que a caneta continua embaixo"): ⚙ Configurações → Subir e descer a caneta → Pausa = "no fim do traço" e repetir | |
| 10 | Parar | **■ Parar** no meio de um desenho; depois **Ir para a origem** | A caneta sobe, **sem alarme**, Home continua "feito"; "Ir para a origem" vai ao lugar certo sem refazer o Home | |
| 11 | Emergência | **⛔ Emergência** (ou Esc) no meio de um desenho | ALARM:3 traduzido, Home "falta"; Enviar fica bloqueado até o Home | |
| 12 | Cabo | Puxar o USB no meio de um desenho | Em até 1 s: aviso vermelho, estado "conexão perdida", a tela não trava. Reconectar: banner, Alarm, Home | |
| 13 | Velocidade | −10% / +10% / 100% durante o desenho | "Velocidade 110%" muda e a máquina acelera/desacelera | |
| 14 | Console | Depois do Home: `G1 X10 (a (b))`; depois `$110=12000` (cancele); depois `$32=1` | error:1 traduzido; a confirmação de EEPROM aparece; `$32=1` é recusado | |
| 15 | Segundo plano | Minimizar a janela ou trocar de aba por 5 min durante um desenho | O desenho continua sem parar (para desenhos longos, desligue a suspensão do Windows) | |
| 16 | Aceite | Um desenho real de 15+ minutos do começo ao fim, sem LaserGRBL | Termina; o tempo real fica em "Últimos trabalhos" ao lado do estimado | |

**Decisão do teste 9:** `pen.pauseLift` = "spindleStop" (padrão, a caneta sobe na hora) ou "endOfStroke" (termina o traço e para). Anote aqui: ______

## Roteiro da v3 (regras de G-code, imagem vira traço, várias canetas)

Feito na noite de 21 para 22/11/2026. **Nada disto rodou na máquina ainda**: passou em testes automáticos, no simulador (`?sim=1`) e num Chrome dirigido por script. A ordem abaixo vai do mais seguro para o mais arriscado. Pare no primeiro que der errado e anote.

Para ensaiar cada passo antes, sem a máquina: `npm run dev` e abra `http://localhost:5173/?sim=1&simSpeed=20`.

### A. Controle da máquina, SEM caneta e com a mão no botão da fonte

| # | Teste | Como | Esperado | Resultado |
|---|---|---|---|---|
| A1 | Conectar | Passo **3 Plotar** → **Conectar** | Banner do GRBL em ~2 s, estado **Alarm**, nenhum aviso amarelo. No Console, digite `$I`: tem que aparecer `[OPT:V,15,128]`. Copie a lista do `$$` para cá (anote o `$1`) | |
| A2 | Parar o Home | **Fazer o Home** e, 1 s depois, **Esc**. Depois de novo, e use **■ Parar** no meio | Para **na hora** nas duas vezes, com `ALARM:6`. (Antes da revisão o Esc não fazia nada durante o Home.) | |
| A3 | Home inteiro | **Fazer o Home** até o fim | O estado mostra "Home" o tempo todo, sem "sem resposta" nem "placa travada" | |
| A4 | Caneta | **Caneta ↓** / **Caneta ↑** | O servo desce e sobe; escute se ele **zumbe** parado em cima | |
| A5 | Jog | Passo 10 nas quatro direções; depois "contínuo": vários toques rápidos, depois segurar e soltar | Cada toque para; ao soltar, para na hora. Sem Home o contínuo é recusado com uma mensagem | |
| A6 | Reset no meio de uma pausa | Console: `G4 P5` e clique **Reset** durante | Um `ok` solto, depois o banner; estado Idle, posição igual | |
| A7 | Fora do curso | Depois do Home, Console: `G0 X820` | `ALARM:2`, estado Alarm, **sem** "placa travada". O Home funciona em seguida | |

### B. O G-code novo, ainda SEM caneta (a máquina desenha no ar)

Traga `samples/orientacao.svg` (passo 1) e confira o passo 2: tem que dizer **Pronto para plotar**.

| # | Teste | Como | Esperado | Resultado |
|---|---|---|---|---|
| B1 | Aquecimento | **Enviar desenho** | Antes de tudo a máquina vai a X0 Y0 e o servo bate **8 vezes** no ar. Só depois vai para o desenho | |
| B2 | Subida dupla | Olhe o Console durante um traço | Depois de cada traço saem dois `M5` seguidos; o servo só se mexe no primeiro | |
| B3 | Pausar | **⏸ Pausar** no meio de um traço, esperar, **▶ Continuar** | O servo **sobe** na pausa e **desce ~0,5 s antes** de andar. Se não subir: Configurações → Subir e descer a caneta → Pausa = "no fim do traço" | |
| B4 | Pausar no aquecimento e num descanso | Pausar durante as 8 batidas; depois durante um "descanso do servo" (use um desenho com muitos tracinhos) | Pausa e continua sem perder nada | |
| B5 | Parar e voltar | **■ Parar** no meio de um traço; depois **Ir para a origem** | Sem alarme. A máquina volta exatamente para uma marca feita antes na origem. Repita 3 vezes | |
| B6 | Retomar | Depois de parar, em "O que enviar" já vem **Retomar de onde parou**. **Enviar** | Aquecimento de novo e o desenho continua do traço anterior ao que parou | |
| B7 | Emergência | **Esc** no meio de um movimento | `ALARM:3`, Home "falta", Enviar bloqueado até o Home | |
| B8 | Descanso do servo | Vetorize uma imagem com muitos tracinhos (passo 2 mostra "a máquina vai esperar…") e envie | Nos descansos a caneta fica **em cima e parada**, e o servo em silêncio. Ponha a mão: ele esfria? | |
| B9 | Aba escondida | Trabalho de 15 min no ar, com a aba minimizada por 10 min (desligue a suspensão do Windows) | Termina. No Console não pode haver "Erro de leitura na serial" (se houver, é ruído no cabo: anote quantos) | |
| B10 | Cabo | Puxar o USB no meio; reconectar | Aviso em ~1 s; depois de reconectar e do Home, "Retomar de onde parou" continua o desenho | |

### C. Com a caneta

| # | Teste | Como | Esperado | Resultado |
|---|---|---|---|---|
| C1 | Escala e posição | `samples/teste_quadrado_circulo.svg`, sem mexer (cai em X30 Y25) | Quadrado 100,0 ± 0,3 mm; círculo Ø 60 ± 0,3 mm; canto do quadrado em X40 Y35 | |
| C2 | Orientação | `samples/orientacao.svg` | "F" legível e seta para cima/direita, igual à tela | |
| C3 | 1º traço | Olhe o primeiro traço de C1 e C2 | Sai com tinta desde o começo (a 1ª descida espera 0,6 s) | |
| C4 | Imagem vira traço | **Trazer desenho → Imagem**, uma imagem de linha pequena (~15 min), tipo **Traço** | O desenho sai igual à prévia da tela de vetorizar. Compare o tempo real com o estimado em "Últimos trabalhos" | |
| C5 | Preto e branco com hachura | Uma imagem de nanquim pequena, tipo **Preto e branco** | Áreas cheias com contorno e hachura a 45°; traços finos em linha única | |
| C5b | Ilustração (acrescentado em 22/11) | Uma imagem colorida pequena (~20 min), tipo **Ilustração**: primeiro com **Sombras** no zero, depois em 50% | Contornos limpos, sem rabisco onde a imagem tem textura; a hachura cai só nas partes escuras e não atravessa área clara. Compare com a prévia da tela | |
| C5c | Fundo escuro (acrescentado em 22/11) | Uma planta azul pequena (linhas claras em fundo escuro), tipo **Traço** | "A imagem tem fundo escuro" já vem marcado; saem só as linhas, e o fundo fica em branco | |
| C6 | Duas canetas | Dois desenhos na mesa, um com a caneta **Fina 0,03** (passo 1 → Caneta). Plote a camada 1, troque a caneta **sem mexer no papel**, plote a camada 2 | Cada camada começa com uma cruz em X20 Y12 e termina com outra em X580 Y12. As cruzes das duas canetas têm que cair uma em cima da outra. Se não caírem, meça a diferença (o braço da cruz tem 6 mm) e ajuste o desvio em Configurações → Estojo de canetas | |
| C7 | Aceite | Um desenho real de 1 h ou mais, em partes ou inteiro | Termina com o servo frio e sem falha de caneta | |

**O que anotar aqui depois dos testes:** `pen.pauseLift` (B3): ______ · desvio medido da caneta fina (C6): X ______ Y ______ · limite do servo que ficou (média/pico): ______ / ______

### O que mudou nos arquivos de referência (goldens)

Os quatro G-codes de `samples/golden/` mudaram para o formato de `docs/REGRAS_GCODE.md` (aquecimento, `G1 F500` modal, subida dupla, `M2`, desenho dentro da folha a partir de X30 Y25, linha "; caneta …" no cabeçalho). **Nenhum deles rodou na máquina ainda**: os testes C1 e C2 são os que os aprovam.
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
| 14/11/2026 | T18–T20 | 89 testes do protocolo, da fila contada, do simulador e do controlador (no controlador: os 14 cenários da seção 4.3 do PLAN e mais 7) | Passou | Tudo em tempo virtual (`ManualClock`) |
| 14/11/2026 | T21–T26 | Interface com `?sim=1` no Chrome headless: conectar/desconectar/reconectar, Home, caneta, ir para a origem, jog (passo, teclado, contínuo, diagonal na borda), console (bloqueio e confirmação), contorno, envio completo de `curvas.svg`, pausa (com e sem 0x9E), pausa no fim do traço, error:20 no meio, parar, Esc, cabo puxado | Passou | Nada disso substitui o roteiro da v2 na máquina |
| 22/11/2026 | v3 | 1.331 testes automáticos (três revisões independentes, ~25 mil G-codes sorteados conferidos por um leitor independente); navegador dirigido por script com `?sim=1`: SVG → Conferir, imagem → traço (linha, preto e branco, foto) → mesa → Conferir, Plotar inteiro no simulador, duas canetas (camada 1 → aviso → camada 2), parar → recarregar a página → retomar | Passou | Nada disso substitui o roteiro da v3 na máquina |
| 22/11/2026 | v3 | Auditoria nova nos G-codes reais de `D:\CNC Plotter - Desenhos` | Passou | Mesmos números do histórico de `REGRAS_GCODE.md` (senna fina 20,5/36/15%/89%; senna grossa 14,2/30/25%/93%) |
| 22/11/2026 | v3 | Traçador TypeScript × laboratório Python nas imagens reais (castelo, F16) | Passou | Mesmos traços e pontos, mesmas coordenadas |