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
| 9 | **Pausa** (decide o `pen.pauseLift`) | `curvas.svg`: **⏸ Pausar** no meio de um círculo; esperar 5 s; **▶ Continuar** | A caneta **sobe** na pausa e **desce antes de andar** ao continuar, sem falha no traço. Se não subir (ou o painel avisar "o GRBL diz que a caneta continua embaixo"): ⚙ Configurações → Caneta → Pausa = "no fim do traço" e repetir | |
| 10 | Parar | **■ Parar** no meio de um desenho; depois **Ir para a origem** | A caneta sobe, **sem alarme**, Home continua "feito"; "Ir para a origem" vai ao lugar certo sem refazer o Home | |
| 11 | Emergência | **⛔ Emergência** (ou Esc) no meio de um desenho | ALARM:3 traduzido, Home "falta"; Enviar fica bloqueado até o Home | |
| 12 | Cabo | Puxar o USB no meio de um desenho | Em até 1 s: aviso vermelho, estado "conexão perdida", a tela não trava. Reconectar: banner, Alarm, Home | |
| 13 | Velocidade | −10% / +10% / 100% durante o desenho | "Velocidade 110%" muda e a máquina acelera/desacelera | |
| 14 | Console | Depois do Home: `G1 X10 (a (b))`; depois `$110=12000` (cancele); depois `$32=1` | error:1 traduzido; a confirmação de EEPROM aparece; `$32=1` é recusado | |
| 15 | Segundo plano | Minimizar a janela ou trocar de aba por 5 min durante um desenho | O desenho continua sem parar (para desenhos longos, desligue a suspensão do Windows) | |
| 16 | Aceite | Um desenho real de 15+ minutos do começo ao fim, sem LaserGRBL | Termina; o tempo real fica em "Últimos trabalhos" ao lado do estimado | |

**Decisão do teste 9:** `pen.pauseLift` = "spindleStop" (padrão, a caneta sobe na hora) ou "endOfStroke" (termina o traço e para). Anote aqui: ______

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
