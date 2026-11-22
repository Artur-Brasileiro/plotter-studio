# Plotter Studio

Software próprio de G-code para a **CNC Plotter do Artur**: uma página web (Chrome) que importa desenhos, deixa posicionar/girar/redimensionar na área do papel, gera G-code com a velocidade certa para a máquina e, a partir da v2, envia direto para o GRBL pela serial.

O objetivo é a praticidade do LaserGRBL, mas feito sob medida para esta máquina, e que o Artur consiga ajustar tudo sozinho pela tela de Configurações, sem mexer no código.

**As regras de G-code desta máquina estão em [docs/REGRAS_GCODE.md](docs/REGRAS_GCODE.md) e mandam em tudo o que o gerador faz** (se alguma for quebrada, o arquivo não vai para a máquina). Desenho da v3: [docs/V3.md](docs/V3.md); estado atual: [docs/PROGRESSO.md](docs/PROGRESSO.md). Especificação completa e fases: [docs/SPEC.md](docs/SPEC.md). Protocolo serial do GRBL: [docs/GRBL.md](docs/GRBL.md). **Plano de implementação (arquitetura, interfaces, algoritmos, tarefas T01–T27): [docs/PLAN.md](docs/PLAN.md).** Resultados dos testes na máquina: `docs/TESTES.md`.

## Comandos

```bash
npm install
npm run dev      # servidor local (http://localhost:5173) — Web Serial funciona em localhost
npm test         # vitest (núcleo em src/core), via scripts/vitest.mjs
npm run build    # typecheck + build em dist/
```

- `npm test` passa por `scripts/vitest.mjs` (criado na T01). No terminal do VS Code o diretório vem como `c:\...` (drive minúsculo), e com isso o Vitest 5.1 carrega o próprio módulo duas vezes e falha com `Cannot read properties of undefined (reading 'config')`. O script relança o Vitest com `C:\`. Não chame `npx vitest` direto no Windows.
- `?sim=1` na URL (v2) troca a máquina pelo simulador de GRBL (`src/core/grbl/fakeGrbl.ts`). Extras: `simSpeed=5` (mais rápido), `simNoLift=1` (o 0x9E não levanta a caneta), `simError=30:20` (error:20 na 30ª linha de G-code), `simDisconnect=200` (o cabo "sai" na 200ª linha). No console do navegador, `plotter.session.fake` dá acesso ao simulador (ex.: `powerGlitch()`, `unplug()`, `freeze()`).

## A máquina (fatos medidos — não alterar sem o Artur confirmar)

- **Firmware:** GRBL 1.1h, fork `vankesteren/grbl-servo` (servo da caneta no PWM do spindle, pino D11). Arduino Uno + CNC Shield V3, drivers A4988 em 1/16 (`$100`/`$101` = 80).
- **Conexão:** Windows, porta COM6, 115200 baud. Ao abrir a porta, o Uno **reinicia** (DTR) e o GRBL liga em **ALARM** até o `$H` (homing).
- **Curso da máquina:** **810 × 390 mm** (`$130`/`$131`; este documento dizia 385 até 22/11/2026, o Artur corrigiu). O valor fica em `profile.workArea` e é ajustável em Configurações. **Zona de desenho (o papel): X 30–570, Y 25–370** (`profile.drawZone`): nenhum traço sai dela; as exceções são o ponto de aquecimento (X0 Y0) e as cruzes de registro (Y12). Soft limits ligados (`$20=1`): qualquer coordenada fora de 0..810 / 0..390 gera `ALARM:2` (o GRBL fica mudo até um reset; por segurança o aplicativo pede o Home de novo). O software deve **bloquear a exportação** se algo sair da área.
- **Coordenadas:** origem de trabalho G54 gravada na EEPROM (`G10 L2 P1 X-810 Y-390`; ainda não conferido na máquina: ao conectar, o aplicativo lê o `$#`, avisa se o G54 for outro e não envia nada enquanto não bater com o perfil), no canto da **frente à esquerda**. **X+ para a direita, Y+ para longe do operador.** Todas as coordenadas do desenho são positivas, em mm, com `G90` (absoluto).
  - **Na tela, Y+ aponta para cima** (o operador vê o papel de frente). SVG e canvas têm Y para baixo, então é preciso inverter: `y_maquina = altura - y_tela`. Essa inversão existe em **um único lugar**, `sceneToMachineMatrix(H)` em `src/core/coords.ts`; nenhum outro código inverte Y. O desenho no papel deve sair com a mesma orientação que aparece na tela, **sem espelhar** (use `samples/orientacao.svg` para conferir).
- **Caneta:**
  - Abaixar: **`M3 S220`**. Levantar: **`M5`**. Depois de cada um, sempre um `G4`: **0,3 s depois de descer, 0,2 s depois de subir** (0,6 s na 1ª descida do arquivo).
  - **O servo é o ponto fraco da máquina.** Ele esquenta de ficar subindo e descendo, não de ficar embaixo. Por isso o gerador emenda traços, limita os ciclos por minuto e faz a caneta descansar em cima (seção "Regras de G-code", abaixo).
  - `M5` = caneta em cima é proposital: o GRBL executa `M5` sozinho em reset/alarme, então qualquer pane levanta a caneta.
  - **Nunca** enviar `$32=1` (laser mode): o servo para de funcionar.
- **Velocidades:** máximo `$110`/`$111` = 12000 mm/min, aceleração 800 mm/s². Deslocamentos com a caneta levantada usam `G0`.
- **Comentários no G-code:** só com `;`. Parênteses aninhados como `( centro (60,60) )` dão erro no GRBL.
- **G-code só em ASCII, inclusive nos comentários.** O GRBL trata todo byte acima de 0x7F como comando em tempo real. Em UTF-8, um "—" termina em `0x94` (velocidade −1%) e um "”" em `0x9D` (spindle −1% = **move o servo**). Nomes de arquivo vão sem acento, travessão vira `-`, aspas curvas viram retas, e o que sobrar fora de ASCII vira `_`. **`?`, `!` e `~` também nunca aparecem**, nem em comentário: para o GRBL são relatório, pausa e continuar, em qualquer lugar da linha.
- Resolução da máquina: 0,0125 mm por passo. Duas casas decimais nas coordenadas bastam (e deixam as linhas curtas, o que ajuda a serial).

### O que os testes de traço mostraram (13/11/2026) — base do modo de velocidade dinâmica

- Retas de 400 mm em X e 360 mm em Y a **F1500**: perfeitas, nos dois sentidos.
- Círculos de raio 40 mm: **impecáveis em F500 e F1000**; pequenas ondulações em **F2000**; um pouco mais em F4000.
- Reduzir a aceleração de 800 para 400 **não** melhorou. As ondulações são efeito dinâmico (elasticidade da correia + massa da ponte) que só aparece com **curva + velocidade alta**.
- Conclusão usada aqui: retas podem ir rápido, curvas precisam ir mais devagar, e quanto mais fechada a curva, mais devagar.

Regras de implementação que saem disso:
- **Velocidade dinâmica pela curvatura** (algoritmo completo em `docs/PLAN.md`, seção 3.5):
  - Em cada vértice, o raio é o do círculo pelos 3 pontos vizinhos, e cada segmento ganha F por faixa: trecho reto → `feed.straight`; curva suave → `feed.curve`; curva fechada → `feed.tightCurve`.
  - Limiares padrão (configuráveis): **R ≥ 100 mm reta, 40 ≤ R < 100 curva, R < 40 curva fechada**. Eles saem dos dados acima lidos como aceleração lateral v²/R: F1000 em R40 = 7 mm/s² (perfeito), F2000 em R40 = 28 mm/s² (ondula). Com isso, F1200 só é seguro a partir de ~R40.
  - **Canto vivo não ganha F próprio.** Um vértice que vira mais de 45° (ou com segmento vizinho > 10 mm) conta como reta. Quem freia no canto é o GRBL (junction deviation, `$11`): pela fórmula dele, ~F314 num canto de 90° e ~F615 num de 45°, abaixo ou no nível do `tightCurve`. Se o canto puxasse o F, o lado inteiro de um quadrado sairia devagar.
  - A classe mais lenta se estende 2 mm para cada lado (janela), para o F não ficar alternando por ruído.
  - Retas só foram testadas a F1500. O padrão de `feed.straight` é 2000; se o Artur notar tremor, ele baixa na tela de Configurações.
- **Não gerar segmentos minúsculos:** o planejador do GRBL no Uno guarda só ~15 movimentos. Milhares de segmentos de 0,05 mm a F2000 esvaziam o buffer e a máquina "gagueja". Ao converter curvas em linhas:
  - tolerância de corda de 0,05 mm, aplicada **depois** da transformação final;
  - Ramer–Douglas–Peucker de 0,05 mm;
  - fusão de segmentos < 0,1 mm;
  - **teto de vazão**: nenhum segmento dura menos que `motion.minSegmentTimeMs` (10 ms), ou seja, F ≤ 6000 × comprimento em mm.

## Regras de G-code (v3) — onde cada uma mora

`docs/REGRAS_GCODE.md` é a fonte. No código (`src/core/job/`):

- **`pipeline.ts`** (`planJob`, `planLayers`): documento → traços → área e zona → retira tracinhos escondidos → ordem com emendas → cruzes de registro → corte das descidas longas → correção da ponta da caneta → velocidades → agenda. **Um plano por camada (caneta).**
- **`inkmap.ts`**: mapa de tinta **conservador** (só diz "tem tinta" onde tem com certeza). Serve para emendar por cima de tinta que já existe e para retirar tracinhos totalmente cobertos. Na dúvida, ele não emenda e não retira: um ciclo a mais do servo é melhor que um risco novo no desenho.
- **`optimize.ts`**: ordem que prefere o traço que dá para emendar (salto ≤ largura da caneta, ou ligação sobre tinta, busca de 3 mm) ao mais próximo; `capDescents` corta descidas acima de 900 mm.
- **`schedule.ts`**: junta os traços em descidas e agenda o tempo. **Balde de fichas** para o servo (padrão: média 30/min, pico 45 em 60 s; faltou ficha, a caneta espera em cima com um `G4`). O balde enche pelo relógio mais apressado entre o da máquina (com aceleração) e o do script de blindagem, e os ciclos do aquecimento são pagos dele. Checkpoints a cada ~10 min, partes de ~25 min cortadas num checkpoint.
- **`gcode.ts`**: escreve o arquivo no formato das regras (bloco `G0` / `M3 S220` / `G4` / `G1 F500` / pontos / `M5` `G4` duas vezes), com aquecimento de 8 ciclos em X0 Y0, checkpoints, descansos, rodapé `M2`. Também faz uma parte avulsa e a **retomada** (`fromDescent`).
- **`layers.ts`**: camadas por caneta (ordem = ordem de `profile.pens`: cor → fina → grossa), cruzes de registro em ida e volta (X20 Y12 e X580 Y12, braço de 6 mm) como 1ª e última descida, desvio da ponta (`pen.offsetX/Y`: a camada inteira sai deslocada ao contrário).
- **`audit.ts`** (`auditGcode`): lê o **texto** final como o GRBL leria e confere tudo da seção 10 das regras. **O que ela não sabe ler, ela acusa.** `checkAgainstPlan` confere que o arquivo risca o que o plano mandou. A interface só deixa baixar ou enviar com `audit.ok`.
- **`resume.ts`**: de onde retomar depois de uma parada (a descida anterior à que estava sendo feita).
- **`review.test.ts` e `review2.test.ts`** (aqui e em `src/core/text`): os defeitos que duas revisões independentes acharam, cada um com o teste que o prova, e os sorteios que conferem milhares de arquivos gerados com um leitor de G-code independente da auditoria. Não apagar.

Regras que não podem quebrar ao mexer aqui: o gerador nunca escreve `G0` com a caneta embaixo; todo `M3`/`M5` tem `G4` depois; nenhuma linha passa de 69 caracteres; só ASCII; o arquivo gerado passa na própria auditoria (há testes de estresse para o arquivo inteiro, cada parte e cada ponto de retomada).

## Imagem → traço (v3)

- `src/core/trace/`: campo de tinta com limiar local e borda subpixel (`inkField.ts`), esqueleto e distância (`skeleton.ts`), grafo de traços com pareamento nas junções (`strokes.ts`), ajuste de curvas de Bézier com cantos (`fit.ts`), "régua" que transforma trecho reto em reta de verdade (`straight.ts`), contornos e hachura (`contours.ts`, `hatch.ts`), e `traceImage.ts` que junta tudo nos quatro modos (`line`, `ink`, `illus`, `photo`).
- `src/core/trace/illus.ts` (modo `illus`, "Ilustração" na tela): para pintura, desenho colorido e imagem com textura. A imagem é REDESENHADA antes de ser traçada: apaga a textura guardando as bordas (rolling guidance com filtro guiado), acha a direção das bordas (tensor de estrutura), tira uma linha de cada borda (diferença de gaussianas ao longo do fluxo, FDoG), fica com as linhas fortes e as fracas ligadas a elas (histerese com limiar que acompanha a imagem) e entrega um desenho de linhas ao mesmo traçador do modo `line`. Trabalha numa imagem em que 1 px = 1 largura de caneta (`illusWorkSize`): é a caneta que decide quanto detalhe cabe. As sombras são hachura do tom já sem textura. É o único modo que usa a cor (`RgbaImage`, quarto parâmetro de `traceImage`). Referência em `lab/python/illus.py`; fixtures sintéticos em `lab/python/fixtures_illus.py`.
- É um porte, **número por número**, do laboratório em Python que fica em `lab/python/` (referência, não faz parte do aplicativo). Os testes comparam com dados gerados por ele (`__fixtures__/`). Mudou o algoritmo: mude no laboratório, regenere as fixtures (`lab/python/fixtures_*.py`) e só então porte.
- `src/core/trace/colors.ts`: as cores de caneta de uma imagem (`findPalette`, por matiz no OKLab), a cor de cada traço (`strokeColors`) e as camadas que a pessoa escolhe a caneta (`colorLayers`). A cor entra DEPOIS do traçado: o traçador não sabe dela. Também `lightOnDark`, a imagem de entrada quando a caneta desenha o claro (papel preto, planta azul).
- `src/core/trace/parts.ts`: a segunda divisão das camadas, além da cor: traço fino ou grosso pela largura que a linha tem no papel (`TraceResult.widthsPx`, medida pelo traçador), ou contornos e sombras na Ilustração.
- O ajuste das curvas é na escala da CANETA, não do pixel: `penDetail` (em `traceImage.ts`) multiplica as tolerâncias quando a caneta vale mais de 1,1 px da imagem. No modo `ink`, uma linha só é área cheia (contorno + hachura) a partir de `fillFromPens` larguras de caneta (padrão 2); abaixo disso é um risco pelo meio.
- `src/core/trace/kind.ts`: mede a imagem antes de traçar. Diz se ela é um desenho de linhas (aí a tela indica o tipo Traço ou Preto e branco, e avisa quem escolher Ilustração ou Foto) e se tem grade no fundo (aí "Linhas claras" desce sozinho).
- As camadas de uma imagem (uma por caneta) chegam à mesa como desenhos do mesmo conjunto (`Drawing.group`): mesma posição, um objeto só na mesa.
- Roda num Web Worker (`src/trace/`); a tela é `src/ui/trace/traceDialog.ts`, carregada sob demanda. O tempo de máquina que ela mostra vem do planejador de verdade, em outro worker (`src/trace/planWorker.ts`).
- A cor do papel (`src/ui/paper.ts`) é só da tela: a mesa, a vetorização e a tela de apagar traços (`src/ui/strokeEditor.ts`, com o núcleo em `src/core/strokeEdit.ts`) pintam a folha com ela. O G-code não muda.
- Imagens de terceiros não vão para o repositório: as fixtures são formas sintéticas.

## Texto (v3)

- `src/core/text/`: fontes Hershey de traço único (`fontData.ts` é gerado dos arquivos .jhf; uso livre, com o reconhecimento que está no topo do arquivo). `hershey.ts` monta o texto como geometria: acentos do português compostos (letra + sinal), alinhamento, entrelinha e curvas suaves (vértice de curva vira Bézier, canto continua vivo). A tela é `src/ui/textDialog.ts`. O texto vira um desenho comum; não é reeditável depois de colocado na mesa.
## Arquitetura (decisões tomadas)

- **Vite + TypeScript, sem framework de UI** (HTML + módulos TS). Mantém o projeto simples de entender e de alterar.
- **Fabric.js 7** no canvas: dá de graça as alças de arrastar/girar/escalar e a seleção múltipla.
  - **A cena do Fabric é em mm** (1 unidade = 1 mm, Y para baixo). Zoom e pan acontecem só pelo `viewportTransform`. Não existe fator `pxPerMm` no código.
  - Atenção: no Fabric 7 a origem padrão dos objetos é o **centro** (`originX/originY = "center"`). A ponte modelo ↔ Fabric (`fabricMatrixFromModel`/`modelMatrixFromFabric` em `src/core/coords.ts`) compensa isso com o centro da caixa local.
  - A **mesa** (grade, gabaritos, origem) é desenhada no evento `before:render` do canvas de baixo; não são objetos do Fabric. A **pré-visualização do caminho** (e, na v2, a posição da máquina) fica num canvas de sobreposição com `pointer-events: none`.
  - `lockScalingFlip: true`: arrastar uma alça nunca espelha o desenho.
- **Fonte única da verdade = o modelo, não o canvas.** Cada desenho é guardado como **curvas (retas + Béziers cúbicas) em mm**, em coordenadas locais, mais uma matriz local → cena (`Drawing.transform`). Arcos e círculos viram cúbicas de no máximo 45° na importação.
  - O objeto do Fabric é só a "vista": no fim de cada gesto (`object:modified`), a matriz dele (`calcTransformMatrix()`, que inclui a seleção múltipla) volta para o modelo.
  - O G-code **nunca lê o canvas**: ele achata as curvas já transformadas para mm da máquina, de modo que a tolerância de 0,05 mm vale em qualquer escala.
- **`src/core/` é puro (sem DOM)** e testado com vitest: geometria, **parser de SVG** (unidades, viewBox, transforms, path data, arcos), documento e histórico (desfazer por snapshots imutáveis), otimização da ordem dos traços, velocidade dinâmica, estimativa, geração de G-code, e (v2) o protocolo de envio, o controlador e um **simulador de GRBL** (`FakeGrbl`).
  - `src/import/svgDom.ts` só usa o `DOMParser` para transformar o XML numa árvore simples (`SvgNode`); o resto é puro.
  - `getPointAtLength` **não** é usado (lento, sem controle de tolerância, arredonda cantos).
- **`src/ui/`**: canvas, painéis e diálogos. **`src/storage/`**: `localStorage` (perfil, configurações) e IndexedDB (sessão salva sozinha a cada mudança). **`src/serial/`** (v2): transporte Web Serial.
- **Perfil da máquina** em `src/core/machine.ts` (`DEFAULT_PROFILE`), editável pela tela de Configurações e salvo no `localStorage`, com botões de exportar/importar o perfil em JSON (para fazer backup). Além de área, caneta e velocidades, guarda os limiares da velocidade dinâmica, as tolerâncias e os parâmetros de movimento usados na estimativa (`$110`, `$120`, `$11`).
- **Web Serial API** (v2): só funciona em Chrome/Edge e em contexto seguro (localhost ou https). Por isso o deploy é no **GitHub Pages**. O workflow fica em `.github/workflows/deploy.yml` (roda `npm test` e `npm run build` a cada push na `main`).
  - O TypeScript 7 não traz os tipos da Web Serial: eles ficam em `src/serial/web-serial.d.ts`.
- **Envio (v2)**: `src/core/grbl/controller.ts` (`GrblController`) é a máquina de estados inteira (conexão, fila com contagem de caracteres, trabalho, pausa, parada, emergência, jog). É puro: recebe um `Transport` e um `Clock`, e os testes rodam com o `FakeGrbl` e o `ManualClock` em tempo virtual. Na interface, `src/ui/machine/session.ts` cria um controlador por conexão (a porta pode mudar) e reemite o estado para os painéis da aba **Máquina**.
  - Regras que não podem quebrar: nunca mandar 0x99–0x9D (o controlador recusa); parar = `!` → `Hold:0` → reset (mantém a posição); `homed` só depois do ok de um `$H` e volta a false com qualquer alarme ou reinício; desenhar exige Home; nunca reconectar sozinho (abrir a porta reinicia o Uno).
  - Esc com trabalho ativo ou a máquina andando = parada de emergência; Esc num jog só cancela o jog (0x85).

Estrutura (árvore completa em `docs/PLAN.md`, seção 2.1):

```
src/
  core/      lógica pura + testes (*.test.ts): geometry/, svg/, job/ (regras de G-code), trace/ (imagem → traço), grbl/, documento, histórico
  import/    DOMParser → SvgNode; testes golden (jsdom)
  storage/   localStorage e IndexedDB
  serial/    Web Serial (v2)
  ui/        canvas Fabric, mesa, sobreposição, painéis
  main.ts    monta a aplicação
scripts/     vitest.mjs, make-stress-svg.mjs
samples/     SVGs de teste; golden/ com o G-code esperado
docs/        REGRAS_GCODE.md, V3.md, PROGRESSO.md, SPEC.md, GRBL.md, PLAN.md, TESTES.md
lab/python/  laboratório do vetorizador (referência em Python; não faz parte do aplicativo)
```

## Convenções

- Textos da interface em **português do Brasil**. Identificadores do código em inglês. Mensagens de commit em português, curtas.
- Todo o núcleo (`src/core`) com testes. Para o G-code, usar testes "golden": um SVG pequeno conhecido → G-code esperado (`samples/golden/`, via `toMatchFileSnapshot`). Um golden só vale depois de o Artur rodá-lo na máquina; mudou um golden, explique no commit.
- Só `src/import/golden.test.ts` usa o ambiente jsdom (`// @vitest-environment jsdom`); os demais testes rodam em Node puro.
- Antes de dizer que algo está pronto: `npm test`, `npm run build` e abrir no navegador para ver funcionando.
- Não adicionar dependência sem motivo claro. Se uma função de 30 linhas resolve, prefira ela.
- **Para quem é a interface:** em 21/11/2026 o Artur disse que não sabe programar. Textos da tela e explicações para ele: diretos, sem jargão, com analogias do mundo real, tudo resolvido por clique. Qualidade do desenho vem antes de velocidade.
- **Visual ("mesa de desenho")**: a mesa é madeira clara (`--table`), a folha é branca, o cromo é azul-tinta (`--ink`) com azul de planta (`--plan`) nas ações; fonte Bahnschrift (DIN); mono só no console. As cores e medidas são variáveis no topo de `src/style.css`. Três passos numerados: Desenho, Conferir, Plotar.
- **Nunca** publicar (push na `main` faz o deploy), nunca conectar na máquina real nem mandar nada para ela, nunca gravar EEPROM sem o Artur pedir.
- Qualquer mudança que mexa na EEPROM do GRBL (comandos `$xxx=`) precisa de confirmação explícita do Artur na interface.
