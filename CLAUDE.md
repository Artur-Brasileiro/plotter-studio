# Plotter Studio

Software próprio de G-code para a **CNC Plotter do Artur**: uma página web (Chrome) que importa desenhos, deixa posicionar/girar/redimensionar na área do papel, gera G-code com a velocidade certa para a máquina e, a partir da v2, envia direto para o GRBL pela serial.

O objetivo é a praticidade do LaserGRBL, mas feito sob medida para esta máquina, e que o Artur consiga ajustar tudo sozinho pela tela de Configurações, sem mexer no código.

Especificação completa e fases: [docs/SPEC.md](docs/SPEC.md). Protocolo serial do GRBL: [docs/GRBL.md](docs/GRBL.md). **Plano de implementação (arquitetura, interfaces, algoritmos, tarefas T01–T27): [docs/PLAN.md](docs/PLAN.md).** Resultados dos testes na máquina: `docs/TESTES.md`.

## Comandos

```bash
npm install
npm run dev      # servidor local (http://localhost:5173) — Web Serial funciona em localhost
npm test         # vitest (núcleo em src/core), via scripts/vitest.mjs
npm run build    # typecheck + build em dist/
```

- `npm test` passa por `scripts/vitest.mjs` (criado na T01). No terminal do VS Code o diretório vem como `c:\...` (drive minúsculo), e com isso o Vitest 5.1 carrega o próprio módulo duas vezes e falha com `Cannot read properties of undefined (reading 'config')`. O script relança o Vitest com `C:\`. Não chame `npx vitest` direto no Windows.
- `?sim=1` na URL (v2) troca a máquina pelo simulador de GRBL (`src/core/grbl/fakeGrbl.ts`).

## A máquina (fatos medidos — não alterar sem o Artur confirmar)

- **Firmware:** GRBL 1.1h, fork `vankesteren/grbl-servo` (servo da caneta no PWM do spindle, pino D11). Arduino Uno + CNC Shield V3, drivers A4988 em 1/16 (`$100`/`$101` = 80).
- **Conexão:** Windows, porta COM6, 115200 baud. Ao abrir a porta, o Uno **reinicia** (DTR) e o GRBL liga em **ALARM** até o `$H` (homing).
- **Área útil:** **810 × 385 mm** (`$130`/`$131`). Soft limits ligados (`$20=1`): qualquer coordenada fora de 0..810 / 0..385 gera `ALARM:2` e perde a posição. O software deve **bloquear a exportação** se algo sair da área.
- **Coordenadas:** origem de trabalho G54 gravada na EEPROM (`G10 L2 P1 X-810 Y-385`), no canto da **frente à esquerda**. **X+ para a direita, Y+ para longe do operador.** Todas as coordenadas do desenho são positivas, em mm, com `G90` (absoluto).
  - **Na tela, Y+ aponta para cima** (o operador vê o papel de frente). SVG e canvas têm Y para baixo, então é preciso inverter: `y_maquina = altura - y_tela`. Essa inversão existe em **um único lugar**, `sceneToMachineMatrix(H)` em `src/core/coords.ts`; nenhum outro código inverte Y. O desenho no papel deve sair com a mesma orientação que aparece na tela, **sem espelhar** (use `samples/orientacao.svg` para conferir).
- **Caneta:**
  - Abaixar: **`M3 S220`**. Levantar: **`M5`**. Depois de cada um: **`G4 P0.3`** (o servo leva ~0,3 s).
  - `M5` = caneta em cima é proposital: o GRBL executa `M5` sozinho em reset/alarme, então qualquer pane levanta a caneta.
  - **Nunca** enviar `$32=1` (laser mode): o servo para de funcionar.
- **Velocidades:** máximo `$110`/`$111` = 12000 mm/min, aceleração 800 mm/s². Deslocamentos com a caneta levantada usam `G0`.
- **Comentários no G-code:** só com `;`. Parênteses aninhados como `( centro (60,60) )` dão erro no GRBL.
- **G-code só em ASCII, inclusive nos comentários.** O GRBL trata todo byte acima de 0x7F como comando em tempo real. Em UTF-8, um "—" termina em `0x94` (velocidade −1%) e um "”" em `0x9D` (spindle −1% = **move o servo**). Nomes de arquivo vão sem acento, travessão vira `-`, aspas curvas viram retas, e o que sobrar fora de ASCII vira `?`.
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
  - **Canto vivo não ganha F próprio.** Um vértice que vira mais de 45° (ou com segmento vizinho > 10 mm) conta como reta. Quem freia no canto é o GRBL (junction deviation, `$11`): pela fórmula dele, ~F264 num canto de 90° e ~F590 num de 45°, abaixo do `tightCurve`. Se o canto puxasse o F, o lado inteiro de um quadrado sairia devagar.
  - A classe mais lenta se estende 2 mm para cada lado (janela), para o F não ficar alternando por ruído.
  - Retas só foram testadas a F1500. O padrão de `feed.straight` é 2000; se o Artur notar tremor, ele baixa na tela de Configurações.
- **Não gerar segmentos minúsculos:** o planejador do GRBL no Uno guarda só ~15 movimentos. Milhares de segmentos de 0,05 mm a F2000 esvaziam o buffer e a máquina "gagueja". Ao converter curvas em linhas:
  - tolerância de corda de 0,05 mm, aplicada **depois** da transformação final;
  - Ramer–Douglas–Peucker de 0,05 mm;
  - fusão de segmentos < 0,1 mm;
  - **teto de vazão**: nenhum segmento dura menos que `motion.minSegmentTimeMs` (10 ms), ou seja, F ≤ 6000 × comprimento em mm.

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

Estrutura (árvore completa em `docs/PLAN.md`, seção 2.1):

```
src/
  core/      lógica pura + testes (*.test.ts): geometry/, svg/, job/, grbl/, documento, histórico
  import/    DOMParser → SvgNode; testes golden (jsdom)
  storage/   localStorage e IndexedDB
  serial/    Web Serial (v2)
  ui/        canvas Fabric, mesa, sobreposição, painéis
  main.ts    monta a aplicação
scripts/     vitest.mjs, make-stress-svg.mjs
samples/     SVGs de teste; golden/ com o G-code esperado
docs/        SPEC.md, GRBL.md, PLAN.md, TESTES.md
```

## Convenções

- Textos da interface em **português do Brasil**. Identificadores do código em inglês. Mensagens de commit em português, curtas.
- Todo o núcleo (`src/core`) com testes. Para o G-code, usar testes "golden": um SVG pequeno conhecido → G-code esperado (`samples/golden/`, via `toMatchFileSnapshot`). Um golden só vale depois de o Artur rodá-lo na máquina; mudou um golden, explique no commit.
- Só `src/import/golden.test.ts` usa o ambiente jsdom (`// @vitest-environment jsdom`); os demais testes rodam em Node puro.
- Antes de dizer que algo está pronto: `npm test`, `npm run build` e abrir no navegador para ver funcionando.
- Não adicionar dependência sem motivo claro. Se uma função de 30 linhas resolve, prefira ela.
- O Artur é estudante de Engenharia da Computação e sabe programar. Ele prefere explicações diretas e práticas, com analogias do mundo real, em vez de texto formal e denso.
- Qualquer mudança que mexa na EEPROM do GRBL (comandos `$xxx=`) precisa de confirmação explícita do Artur na interface.
