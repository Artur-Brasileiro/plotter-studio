# Plotter Studio — plano de implementação

Escrito em 14/11/2026 a partir do esqueleto v0.1 (perfil da máquina, mesa no canvas, 3 SVGs de teste). É o roteiro para implementar a v1 e a v2 sem precisar voltar a perguntar decisões de arquitetura. A v3 fica em nível alto.

Leia antes: [CLAUDE.md](../CLAUDE.md) (fatos da máquina e convenções), [SPEC.md](SPEC.md) (o que cada fase entrega), [GRBL.md](GRBL.md) (protocolo serial).

## Regras para quem executa

1. **Uma tarefa por sessão**, na ordem da seção 5. Cada tarefa lista dependências; não comece uma tarefa sem as dependências prontas.
2. **"Pronto" é verificável:** `npm test` e `npm run build` passando, critério da tarefa cumprido, e (quando há UI) a página aberta no Chrome. Termine pedindo ao Artur o teste manual descrito na tarefa e registre o resultado em `docs/TESTES.md`. Esse arquivo é criado na T01 e guarda a data, a tarefa, o que foi testado e o resultado.
3. **As interfaces da seção 2 são o contrato.** Pode acrescentar funções auxiliares e campos opcionais. Não mude o significado de um tipo público sem atualizar este plano, na mesma sessão.
4. **Se a realidade divergir do plano** (por exemplo, uma API do Fabric diferente do esperado), preserve a intenção, faça a menor mudança que funcione e registre a divergência na seção 7 deste arquivo, com data.
5. **Nunca** envie comandos que gravam na EEPROM (`$N=`, `$RST`, `G10`, `G28.1`, `G30.1`, `$N0=`, `$I=`) sem confirmação explícita do Artur na interface. **Nunca** envie `$32=1`.
6. Commits em português, curtos, um por tarefa (ou mais, se a tarefa for longa).

---

## 1. Revisão crítica do que já existe

### O que está bom e fica

| Item | Por quê |
|---|---|
| **Vite + TypeScript sem framework** | O app tem poucas telas e muito estado geométrico. Um framework de UI ajudaria pouco e aumentaria o que o Artur precisa aprender para alterar o código. |
| **Fabric.js 7** | Alças de mover, girar e escalar, mais seleção múltipla, prontas. Escrever isso à mão dá umas 600 linhas cheias de casos de borda. O custo é o tamanho do bundle (282 kB, 88 kB gzip, medido no build), irrelevante para uso local. |
| **"O modelo é a fonte da verdade, não o canvas"** | É a decisão mais importante do CLAUDE.md e está certa. Fica, e fica mais forte (ver mudança 3). |
| **`src/core` puro e testado** | Fica. A importação de SVG passa a ser quase toda pura também (mudança 2). |
| **Web Serial + GitHub Pages** | Para Chrome no Windows é o caminho mais curto até a máquina, sem instalar nada. O contexto seguro (https) que a Web Serial exige vem de graça no Pages. |
| **Perfil da máquina editável e salvo no `localStorage`** | Fica, com campos novos (velocidade dinâmica, movimento, tolerâncias). |
| **Fatos da máquina no CLAUDE.md** | Precisos e acionáveis: `M5` como posição segura da caneta, nunca `$32=1`, comentários só com `;`, área e soft limits, dados dos testes de 13/11. |
| **GRBL.md** | A contagem de caracteres e a parada segura (`!` → `Hold:0` → reset) estão corretas. Conferi o comportamento no código do GRBL 1.1: com o hold concluído, o reset não gera alarme e mantém a posição. |
| **Samples** | `orientacao.svg` usa formas assimétricas (um "F" e uma seta), ótimo para pegar espelhamento. `teste_quadrado_circulo.svg` reproduz um teste já feito à mão. `curvas.svg` cobre as faixas de raio. |

### O que encontrei ao rodar (`npm install`, `npm test`, `npm run build` em 14/11)

- **`npm test` falha no terminal do VS Code.** A mensagem é `TypeError: Cannot read properties of undefined (reading 'config')`, em `describe`. A causa é o diretório atual com a letra do drive minúscula (`c:\Users\...`, como o VS Code abre o terminal): o Vitest 5.1 carrega o próprio módulo duas vezes e o `describe` enxerga uma cópia vazia. No PowerShell com `C:\` maiúsculo, os 2 testes passam. Testei duas correções: mudar o `root` e chamar `process.chdir` dentro do config. Nenhuma funciona, porque o Vitest já resolveu os caminhos antes de ler o config. O que funciona é um script de 8 linhas que relança o Vitest com `C:` maiúsculo (T01).
- `npm run build` passa: TypeScript 7.0.2 (o compilador nativo) e Vite 8.3.8.
- **O TypeScript 7 não traz os tipos da Web Serial** (`navigator.serial` não existe no `lib.dom`). Testei: precisamos de um `.d.ts` próprio (T21).
- O `jsdom` 26.1.0 já está instalado, mas só como dependência indireta (via Fabric e Vitest). Vai virar devDependency explícita na mesma versão, sem download novo (T01).
- O projeto **não é um repositório git**, e o workflow de deploy está em `docs/deploy-pages.yml`, não em `.github/workflows/` como o CLAUDE.md dizia (T01 corrige).

### O que mudei nas decisões, e por quê

O CLAUDE.md e o SPEC.md já foram atualizados para refletir estas mudanças.

1. **O modelo guarda curvas (retas + Béziers cúbicas), não polilinhas.** Se a importação já achatasse tudo em polilinhas com 0,05 mm de tolerância, um ícone de 6 mm ampliado 30× ficaria com facetas de 1,5 mm. Guardando as curvas e achatando **depois** de aplicar a transformação final, a tolerância de 0,05 mm vale em qualquer escala. Arcos e círculos viram cúbicas de no máximo 45°: o erro é de 4·10⁻⁶ × raio, ou seja, 0,004 mm num raio de 1 m.
2. **Parser de SVG próprio e puro em `src/core/svg/`.** O `DOMParser` serve só para ler o XML. O `SVGGeometryElement.getPointAtLength` sai, por quatro motivos: é lento em arquivos grandes, amostra por comprimento (o que arredonda os cantos), não dá controle sobre a tolerância e não roda nos testes. O parser de `path`, transforms e unidades tem umas 500 linhas e testes diretos.
3. **A matriz de cada desenho vive no modelo, em mm.** O Fabric exibe e, no fim de cada gesto (`object:modified`), devolve a matriz nova para o modelo. O G-code **nunca** lê o canvas. Ganhos: o núcleo é testável sem navegador, desfazer vira troca de "fotografia" do documento, e salvar a sessão é trivial.
4. **A cena do Fabric é em mm.** 1 unidade = 1 mm, com Y para baixo como em qualquer tela. Zoom e pan acontecem só pelo `viewportTransform`. A inversão de Y acontece em **uma única função**, `sceneToMachineMatrix(H)` em `src/core/coords.ts`. Com isso some o fator `pxPerMm` espalhado pelo código, que é a fonte clássica de erro de escala e de espelhamento.
5. **A mesa sai dos objetos do Fabric.** Hoje são uns 120 objetos (linhas da grade, textos). Ela passa a ser desenhada no evento `before:render` do canvas de baixo do Fabric, e a pré-visualização do caminho (e, na v2, a posição da máquina) vai para um **canvas de sobreposição** com `pointer-events: none`. A grade fica sempre fina, independente do zoom, não entra na seleção, e a animação não força o Fabric a redesenhar os desenhos.
6. **Velocidade dinâmica: canto vivo não ganha F próprio.** A versão anterior do CLAUDE.md mandava "curva fechada/canto vivo → `tightCurve`". Só que o círculo pelos 3 pontos de um canto de quadrado com lados de 100 mm dá R = 70 mm, e o lado inteiro sairia como "curva". Pela fórmula de junção do GRBL (seção 3.5), o próprio GRBL já reduz para **~F314 num canto de 90°** e **~F615 num de 45°**, ou seja, abaixo ou no nível do `tightCurve`. Então um vértice que vira mais de 45° é tratado como canto, e quem freia é o GRBL.
7. **Os limiares de raio vêm dos testes de 13/11.** Usando aceleração lateral (v²/R): F1000 em R40 dá 7 mm/s² (perfeito) e F2000 em R40 dá 28 mm/s² (ondulações). Com o `curve` = F1200, o raio mínimo seguro fica em ~40 mm. Por isso os padrões são **R ≥ 100 → reta, 40 ≤ R < 100 → curva, R < 40 → curva fechada** (seção 3.5).
8. **O G-code é só ASCII.** O GRBL trata **todo byte acima de 0x7F como comando em tempo real**, inclusive dentro de comentários. O travessão "—" do exemplo antigo do SPEC vira os bytes `E2 80 94` em UTF-8, e `0x94` é "velocidade −1%". Aspas curvas "”" terminam em `0x9D`, que é "spindle −1%", ou seja, **mexe na posição do servo**. Acentos de nomes de arquivo também entram nessa conta. O gerador remove acentos, troca travessão por `-` e aspas curvas por retas, e o que sobrar fora de ASCII vira `?`. Um teste golden verifica cada byte.
9. **"Parar" deixa de exigir Home.** O SPEC v2 dizia: "parar = reset 0x18; depois exigir `$H`". Isso contradizia o GRBL.md. Agora **Parar** = `!` → esperar `Hold:0` → `0x18`: a caneta sobe, a posição é mantida e não precisa de Home. **Parada de emergência** = `0x18` direto, que gera `ALARM:3` e exige `$H`.
10. **A pausa levanta a caneta.** Só `!` deixaria a caneta parada no papel (borrão). A pausa vira `!` → `Hold:0` → `0x9E` (o GRBL desliga o "spindle", o servo sobe). Para continuar: `0x9E` → espera do servo → `~`. Se o `0x9E` não funcionar no fork do servo (a testar), fica a alternativa "pausar no fim do traço", que é só lógica do envio. As duas existem; o padrão é decidido no teste manual da T26.
11. **Jog contínuo** = um jog só, até a borda da área, cancelado com `0x85` ao soltar a tecla (ou quando a janela perde o foco). É movimento contínuo de verdade, sem os soluços de passos curtos repetidos.
12. **A sessão é salva automaticamente já na v1** (IndexedDB). Recarregar a página não pode apagar o layout. O "Salvar/abrir projeto" da v3 usa o mesmo formato.
13. **A posição dos gabaritos A4/A3 no perfil é suposta** (o próprio `machine.ts` avisa). Fica pendente de medição (seção 7).

### O que não mudei e alguém poderia questionar

- **Sem G2/G3 no G-code.** Arcos nativos aliviariam a serial em círculos, mas as Béziers genéricas exigiriam ajuste por biarcos, e o planejador fica mais difícil de prever. As polilinhas com a regra de vazão (seção 3.3) bastam.
- **Sem Web Worker na v1.** O planejamento de 200 mil pontos leva uns 100–300 ms. Se ficar lento, o `planJob` é puro e passa para um worker sem mudar a interface.

---

## 2. Arquitetura

### 2.1 Árvore final (v2 concluída)

```
plotter-studio/
  .github/workflows/deploy.yml     (movido de docs/deploy-pages.yml na T01)
  scripts/
    vitest.mjs                     relança o Vitest com a letra do drive maiúscula (Windows)
    make-stress-svg.mjs            gera samples/estresse.svg (20 mil traços) para teste de desempenho
  samples/
    teste_quadrado_circulo.svg  orientacao.svg  curvas.svg
    golden/                        G-code esperado (toMatchFileSnapshot), revisado pelo Artur
  docs/  SPEC.md  GRBL.md  PLAN.md  TESTES.md
  src/
    main.ts                        composição: cria store, canvas, painéis, liga tudo
    style.css
    core/                          PURO: sem DOM, sem Fabric, 100% com testes
      machine.ts                   MachineProfile, DEFAULT_PROFILE, mergeProfile, validateProfile
      coords.ts                    a ÚNICA inversão de Y; matrizes modelo ↔ Fabric
      document.ts                  Drawing, PlotDocument e operações imutáveis
      history.ts                   desfazer/refazer por snapshots
      store.ts                     estado da aplicação + assinaturas
      project.ts                   (de)serialização do documento (sessão e, na v3, arquivo)
      geometry/
        vec.ts  mat2d.ts  path.ts  flatten.ts  simplify.ts
      svg/
        node.ts  units.ts  transform.ts  pathData.ts  arc.ts  shapes.ts  importSvg.ts
      job/
        types.ts  strokes.ts  bounds.ts  optimize.ts  speed.ts  estimate.ts  gcode.ts  pipeline.ts
      grbl/                        (v2)
        protocol.ts  codes.ts  commands.ts  streamer.ts  clock.ts  transport.ts  controller.ts  fakeGrbl.ts
    import/
      svgDom.ts                    DOMParser → SvgNode; leitura de File
      golden.test.ts               testes golden (ambiente jsdom)
    storage/
      profileStore.ts              localStorage
      sessionStore.ts              IndexedDB (autosave)
      kv.ts                        wrapper mínimo de IndexedDB (~40 linhas)
    serial/                        (v2)
      web-serial.d.ts              tipos da Web Serial (o TS 7 não traz)
      webSerialTransport.ts
    ui/
      dom.ts                       h(tag, props, ...filhos): helper para montar HTML sem framework
      layout.ts                    barra superior, painel lateral, rodapé
      board.ts                     desenho da mesa (before:render)
      viewport.ts                  zoom, pan, ajustar à tela
      drawingObject.ts             classe Fabric que desenha um Drawing
      canvasView.ts                sincroniza documento ↔ Fabric
      overlay.ts                   pré-visualização do caminho, animação, posição da máquina
      shortcuts.ts
      statusBar.ts
      panels/
        propertiesPanel.ts  jobPanel.ts  settingsDialog.ts
        machinePanel.ts  jogPanel.ts  consolePanel.ts  sendPanel.ts   (v2)
```

Testes ficam ao lado do código (`x.ts` → `x.test.ts`). Só `src/import/golden.test.ts` usa jsdom (`// @vitest-environment jsdom` na primeira linha). O jsdom custa uns 2,5 s para iniciar, então não use em outros arquivos.

### 2.2 Sistemas de coordenadas

| Espaço | Unidade | Eixo Y | Onde aparece |
|---|---|---|---|
| **SVG (usuário)** | unidade do viewBox | ↓ | dentro do arquivo |
| **Local do desenho** | mm | ↓ | `Drawing.geometry`. A origem é o canto superior esquerdo da **página** do SVG |
| **Cena** | mm | ↓ | o Fabric (`left`, `top`, matrizes). (0,0) é o canto **de trás à esquerda** da mesa, como se vê na tela |
| **Tela** | px CSS | ↓ | cena × `viewportTransform` |
| **Máquina** | mm | ↑ | G-code, GRBL (WPos). (0,0) é a frente à esquerda |

- Local → cena: `drawing.transform` (Mat2D).
- Cena → máquina: `sceneToMachineMatrix(H) = [1, 0, 0, −1, 0, H]`, com H = 385. É **a única inversão de Y do projeto**. Como a mesma inversão vale para a tela e para o papel, o desenho sai igual ao que se vê, sem espelhar.
- Local → máquina (usado no G-code): `multiply(sceneToMachineMatrix(H), drawing.transform)`.

Analogia: o desenho é um adesivo (coordenadas locais) colado numa folha transparente (a cena). A matriz diz onde e como o adesivo foi colado. Para levar à máquina, a folha inteira é virada uma vez, sempre do mesmo jeito.

### 2.3 Fluxo de dados

```
arquivo .svg
  │  import/svgDom.ts: DOMParser → SvgNode (árvore simples, sem DOM)
  ▼
core/svg/importSvg.ts ── unidades, viewBox, transforms aninhados, <use>, formas → Geometry
  │                       (retas + cúbicas, mm, Y↓, origem = canto sup. esq. da página)
  ▼
core/document.ts addDrawing ── transform inicial: canto INFERIOR esquerdo da página no (0,0) da máquina
  ▼
PlotDocument ◄──► Store (histórico) ◄──► ui/canvasView.ts ◄──► Fabric
  │                                       (o Fabric só exibe; object:modified devolve a matriz)
  │  core/job/pipeline.ts planJob(doc, profile, jobSettings)
  ▼  1. strokes.ts   M = sceneToMachine × transform; achatar(geometry, M, 0,05 mm); simplificar
  ▼  2. bounds.ts    fora de 0..810 × 0..385? → violações (bloqueiam exportar/enviar)
  ▼  3. optimize.ts  vizinho mais próximo + inversão + rotação de laços + junção de pontas
  ▼  4. speed.ts     F por segmento (fixo ou dinâmico) + teto de vazão do buffer
  ▼  5. estimate.ts  tempo (trapézios, junção do GRBL, pausas do servo)
JobPlan
  │  core/job/gcode.ts
  ▼
GcodeProgram ──► download .gcode (v1)
             └─► GrblController + CharCountingStreamer ──► Transport: WebSerial | FakeGrbl (v2)
```

`planJob` roda com debounce de 300 ms sempre que documento, configurações do trabalho ou perfil mudam. O resultado alimenta o painel do trabalho (estatísticas, avisos) e a pré-visualização.

### 2.4 Interfaces públicas

Só tipos e assinaturas. Comentários em português; identificadores em inglês.

#### `core/geometry/vec.ts`

```ts
export interface Vec { readonly x: number; readonly y: number }
export function vec(x: number, y: number): Vec;
export function add(a: Vec, b: Vec): Vec;
export function sub(a: Vec, b: Vec): Vec;
export function scale(a: Vec, k: number): Vec;
export function dot(a: Vec, b: Vec): number;
export function cross(a: Vec, b: Vec): number;
export function length(a: Vec): number;
export function dist(a: Vec, b: Vec): number;
export function lerp(a: Vec, b: Vec, t: number): Vec;
export function nearlyEqual(a: Vec, b: Vec, eps?: number): boolean; // eps padrão 1e-9
```

#### `core/geometry/mat2d.ts`

```ts
/** Mesmo formato do Canvas/SVG/Fabric: x' = a·x + c·y + e ; y' = b·x + d·y + f */
export type Mat2D = readonly [a: number, b: number, c: number, d: number, e: number, f: number];
export const IDENTITY: Mat2D;
/** m1 ∘ m2: aplica m2 primeiro (igual a multiplyTransformMatrices do Fabric) */
export function multiply(m1: Mat2D, m2: Mat2D): Mat2D;
export function invert(m: Mat2D): Mat2D; // lança se det ≈ 0
export function apply(m: Mat2D, p: Vec): Vec;
export function translation(tx: number, ty: number): Mat2D;
export function scaling(sx: number, sy?: number): Mat2D;
export function rotationDeg(deg: number): Mat2D; // sentido do sistema em que for aplicada
export function skewXDeg(deg: number): Mat2D;
export function skewYDeg(deg: number): Mat2D;
export function determinant(m: Mat2D): number;
export function nearlyEqualMat(m1: Mat2D, m2: Mat2D, eps?: number): boolean;
```

#### `core/geometry/path.ts`

```ts
export type Segment =
  | { readonly kind: "line"; readonly to: Vec }
  | { readonly kind: "cubic"; readonly c1: Vec; readonly c2: Vec; readonly to: Vec };

export interface SubPath {
  readonly start: Vec;
  readonly segments: readonly Segment[];
  /** true quando veio de Z/polygon/rect/circle. O último segmento termina em `start`. */
  readonly closed: boolean;
}
export interface Geometry { readonly subpaths: readonly SubPath[] }
export interface BBox { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }

export function transformGeometry(g: Geometry, m: Mat2D): Geometry;   // aplica aos pontos de controle (exato para afins)
export function controlBBox(g: Geometry): BBox;                      // conservadora (pontos de controle)
export function quadToCubic(p0: Vec, q: Vec, p2: Vec): Segment;      // c1 = p0 + 2/3(q−p0), c2 = p2 + 2/3(q−p2)
/** Elipse completa em 8 cúbicas de 45°, começando em (cx+rx, cy), ângulo crescente (horário na tela). */
export function ellipseSubPath(cx: number, cy: number, rx: number, ry: number): SubPath;
export function segmentCount(g: Geometry): number;
export function emptyBBox(): BBox;
export function unionBBox(a: BBox, b: BBox): BBox;
```

#### `core/geometry/flatten.ts`

```ts
export interface Polyline {
  readonly points: readonly Vec[];
  /** closed ⇒ points[0] e points[n−1] são exatamente iguais */
  readonly closed: boolean;
}
/** Fórmula de Wang: n = ceil(sqrt(0,75 · M / tol)), M = max(|p0−2c1+c2|, |c1−2c2+p3|). */
export function cubicSegmentCount(p0: Vec, c1: Vec, c2: Vec, p3: Vec, tolMm: number): number;
export function flattenSubPath(sp: SubPath, tolMm: number): Polyline;
/** Transforma ANTES de achatar: a tolerância vale no espaço de destino (mm da máquina). */
export function flattenGeometry(g: Geometry, m: Mat2D, tolMm: number): Polyline[];
```

#### `core/geometry/simplify.ts`

```ts
/** Ramer–Douglas–Peucker. Mantém primeiro e último. Em laço fechado, divide no ponto mais distante do início. */
export function rdp(points: readonly Vec[], epsMm: number): Vec[];
/** Remove vértices internos a menos de minLenMm do último vértice mantido. Nunca remove o último ponto. */
export function dropShortSegments(points: readonly Vec[], minLenMm: number): Vec[];
export function simplifyPolyline(pl: Polyline, opts: { rdpMm: number; minSegmentMm: number }): Polyline;
export function polylineLength(points: readonly Vec[]): number;
```

#### `core/svg/*`

```ts
// node.ts
export interface SvgNode {
  readonly tag: string;                          // nome local, minúsculo ("path", "g", "svg"...)
  readonly attrs: Readonly<Record<string, string>>; // "xlink:href" e "href" ambos preservados
  readonly children: readonly SvgNode[];
}

// units.ts
export function parseLengthMm(value: string | undefined): number | undefined; // mm cm in pt pc px, sem unidade = px (96 dpi)
export interface ViewBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export function parseViewBox(s: string | undefined): ViewBox | undefined;
/** viewBox → mm, respeitando preserveAspectRatio (meet/slice/none + alinhamento; padrão xMidYMid meet). */
export function viewBoxToMm(vb: ViewBox, widthMm: number, heightMm: number, preserveAspectRatio?: string): Mat2D;
export interface RootMapping { readonly userToMm: Mat2D; readonly pageMm: { width: number; height: number }; readonly sizeSource: "units" | "px" | "viewBoxOnly" | "none" }
export function rootMapping(root: SvgNode): RootMapping;

// transform.ts
export function parseTransformList(s: string): { m: Mat2D; ok: boolean }; // ok=false → IDENTITY + aviso

// pathData.ts
export function parsePathData(d: string): { subpaths: SubPath[]; error?: string }; // para no primeiro erro (como o navegador)

// arc.ts
/** Arco no formato do SVG (ponto final) → cúbicas de no máximo 45°. Corrige raios pequenos (F.6.6). */
export function arcToCubics(p0: Vec, rx: number, ry: number, phiDeg: number, largeArc: boolean, sweep: boolean, p1: Vec): Segment[];

// shapes.ts
export function shapeToSubPaths(node: SvgNode): SubPath[] | null; // null = não é forma geométrica

// importSvg.ts
export type ImportWarningCode =
  | "text-ignored" | "image-ignored" | "invisible-ignored" | "use-missing-ref"
  | "bad-transform" | "bad-path" | "size-in-px" | "no-size";
export interface ImportWarning { readonly code: ImportWarningCode; readonly count: number; readonly message: string }
export interface ImportResult {
  readonly geometry: Geometry;                 // mm, Y↓, origem no canto sup. esq. da página
  readonly pageMm: { readonly width: number; readonly height: number };
  readonly warnings: readonly ImportWarning[];
  readonly stats: { readonly elements: number; readonly subpaths: number; readonly segments: number };
}
export class SvgImportError extends Error {}   // SVG inválido ou sem nenhum traço
export function importSvgTree(root: SvgNode): ImportResult;
```

#### `import/svgDom.ts`

```ts
export function parseSvgText(text: string): SvgNode;             // lança SvgImportError("SVG inválido: ...")
export async function readSvgFile(file: File): Promise<{ name: string; result: ImportResult }>;
```

#### `core/coords.ts`

```ts
/** A ÚNICA inversão de eixo Y do projeto. Cena (mm, Y↓) ↔ máquina (mm, Y↑). É involução: serve nos dois sentidos. */
export function sceneToMachineMatrix(workHeight: number): Mat2D;  // [1,0,0,−1,0,H]
export function sceneToMachine(p: Vec, workHeight: number): Vec;
export function machineToScene(p: Vec, workHeight: number): Vec;
/** Fabric posiciona pelo centro do objeto: fabric = model × T(cx, cy), com (cx, cy) = centro da bbox local. */
export function fabricMatrixFromModel(model: Mat2D, localBBox: BBox): Mat2D;
export function modelMatrixFromFabric(fabric: Mat2D, localBBox: BBox): Mat2D;
/** Rotação vista pelo operador (anti-horária positiva, eixo Y da máquina para cima). */
export function machineRotationDeg(model: Mat2D): number;         // atan2(−b, a)
```

#### `core/document.ts`

```ts
export type DrawingId = string;
export interface Drawing {
  readonly id: DrawingId;
  readonly name: string;           // nome do arquivo, para listas e cabeçalho do G-code
  readonly geometry: Geometry;     // compartilhada por referência entre snapshots (nunca mutar)
  readonly localBBox: BBox;        // controlBBox(geometry), calculada uma vez
  readonly transform: Mat2D;       // local (mm) → cena (mm)
}
export interface PlotDocument { readonly drawings: readonly Drawing[] }
export const EMPTY_DOCUMENT: PlotDocument;

/** Coloca o canto inferior esquerdo da página no (0,0) da máquina: T(0, H − pageHeight). */
export function importPlacement(pageMm: { width: number; height: number }, workHeight: number): Mat2D;
export function addDrawing(doc: PlotDocument, d: Drawing): PlotDocument;
export function removeDrawings(doc: PlotDocument, ids: readonly DrawingId[]): PlotDocument;
export function duplicateDrawings(doc: PlotDocument, ids: readonly DrawingId[], newId: () => DrawingId, offsetMachine: Vec, workHeight: number): { doc: PlotDocument; newIds: DrawingId[] };
export function setTransforms(doc: PlotDocument, updates: ReadonlyMap<DrawingId, Mat2D>): PlotDocument;
export function translateMachine(doc: PlotDocument, ids: readonly DrawingId[], d: Vec): PlotDocument;   // d em mm da máquina (+Y = para longe)
/** Caixa alinhada aos eixos, em mm da MÁQUINA, da geometria achatada (exata, não a dos pontos de controle). */
export function machineBBox(d: Drawing, workHeight: number, tolMm: number): BBox;
export function selectionMachineBBox(doc: PlotDocument, ids: readonly DrawingId[], workHeight: number, tolMm: number): BBox;
/** Edição pelo painel: posiciona/escala/gira pela caixa na máquina. */
export function setMachineBox(doc: PlotDocument, id: DrawingId, box: { x?: number; y?: number; width?: number; height?: number; keepRatio: boolean }, workHeight: number, tolMm: number): PlotDocument;
export function setMachineRotation(doc: PlotDocument, id: DrawingId, deg: number, workHeight: number, tolMm: number): PlotDocument; // gira em torno do centro da caixa
export function alignCenter(doc: PlotDocument, ids: readonly DrawingId[], target: BBox /* máquina */, workHeight: number, tolMm: number): PlotDocument;
```

#### `core/history.ts`

```ts
export interface HistoryEntry<T> { readonly state: T; readonly label: string }
export interface History<T> {
  readonly past: readonly HistoryEntry<T>[];   // mais antigo primeiro
  readonly present: HistoryEntry<T>;
  readonly future: readonly HistoryEntry<T>[]; // próximo a refazer primeiro
  readonly lastCoalesce?: { readonly key: string; readonly at: number };
}
export const HISTORY_LIMIT = 100;
export function createHistory<T>(initial: T): History<T>;
/** Mesmo coalesceKey em menos de 800 ms → substitui o present em vez de empilhar (setas, digitação). */
export function commit<T>(h: History<T>, next: T, label: string, opts: { now: number; coalesceKey?: string; limit?: number }): History<T>;
export function undo<T>(h: History<T>): History<T>;
export function redo<T>(h: History<T>): History<T>;
export function canUndo(h: History<unknown>): boolean;
export function canRedo(h: History<unknown>): boolean;
```

#### `core/store.ts`

```ts
export interface JobSettings {
  readonly speedMode: "fixed" | "dynamic";
  readonly fixedFeed: number;          // mm/min
  readonly optimize: boolean;
}
export interface AppState {
  readonly history: History<PlotDocument>;  // o documento é history.present.state
  readonly selection: readonly DrawingId[];
  readonly job: JobSettings;
  readonly profile: MachineProfile;
}
export type Listener = (state: AppState, prev: AppState) => void;
export class Store {
  constructor(initial: AppState, clock?: { now(): number });
  get state(): AppState;
  get doc(): PlotDocument;
  subscribe(l: Listener): () => void;
  commit(label: string, f: (doc: PlotDocument) => PlotDocument, opts?: { coalesceKey?: string }): void; // não faz nada se f devolver o mesmo doc
  undo(): void;
  redo(): void;
  replaceDocument(doc: PlotDocument): void;   // restauração de sessão: zera o histórico
  setSelection(ids: readonly DrawingId[]): void;
  setJob(patch: Partial<JobSettings>): void;
  setProfile(p: MachineProfile): void;
}
```

#### `core/project.ts`

```ts
export const PROJECT_FORMAT = "plotter-studio-project";
export interface ProjectFileV1 {
  readonly format: typeof PROJECT_FORMAT;
  readonly version: 1;
  readonly savedAt: string;   // ISO
  readonly drawings: readonly {
    readonly id: string; readonly name: string;
    readonly transform: readonly number[];          // 6 números
    readonly subpaths: readonly { readonly start: readonly [number, number]; readonly closed: boolean;
      readonly segs: readonly (readonly number[])[] }[]; // [x,y] = reta; [x1,y1,x2,y2,x,y] = cúbica
  }[];
}
export function serializeDocument(doc: PlotDocument, now: Date): ProjectFileV1;
export function deserializeDocument(data: unknown): PlotDocument; // valida; lança Error com mensagem em português
```

#### `core/machine.ts` (perfil ampliado)

```ts
export interface MachineProfile {
  readonly version: 1;
  workArea: { width: number; height: number };
  pen: {
    downCmd: string; upCmd: string; settleSeconds: number;
    /** v2: como a pausa levanta a caneta. Padrão decidido no teste da T26. */
    pauseLift: "spindleStop" | "endOfStroke";
  };
  feed: { fixed: number; straight: number; curve: number; tightCurve: number };
  dynamic: {
    straightMinRadiusMm: number;  // 100: R ≥ isto → reta
    curveMinRadiusMm: number;     // 40:  R ≥ isto → curva; abaixo → curva fechada
    cornerAngleDeg: number;       // 45:  vértice que vira mais que isto é canto (quem freia é o GRBL)
    maxCurveSegmentMm: number;    // 10:  segmento mais longo que isto é reta
    windowMm: number;             // 2:   a velocidade mais baixa se estende 2 mm para cada lado
  };
  tolerance: {
    chordMm: number;              // 0,05: achatamento de curvas
    simplifyMm: number;           // 0,05: RDP
    minSegmentMm: number;         // 0,1:  segmentos menores são fundidos
    joinGapMm: number;            // 0,1:  pontas mais próximas que isto são unidas sem levantar a caneta
  };
  motion: {
    maxRateMmMin: number;         // 12000 ($110/$111)
    accelMmS2: number;            // 800   ($120/$121)
    junctionDeviationMm: number;  // 0,01  ($11, padrão do GRBL; conferir com $$)
    minSegmentTimeMs: number;     // 10: teto de F para segmentos curtos não esvaziarem o buffer (0 = desliga)
  };
  gcode: { finalPosition: { x: number; y: number } };   // padrão (0, 0)
  serial: { baudRate: number; statusIntervalMs: number; rxBufferBytes: number }; // 115200, 200, 128
  paperTemplates: { name: string; x: number; y: number; width: number; height: number }[];
}
export const DEFAULT_PROFILE: MachineProfile;
/** Junta um perfil salvo (possivelmente antigo ou incompleto) com o padrão; ignora chaves desconhecidas. */
export function mergeProfile(saved: unknown): MachineProfile;
/** Lista de problemas em português (vazia = ok). Ex.: F acima de motion.maxRateMmMin, comando de caneta com "$" ou fora de ASCII. */
export function validateProfile(p: MachineProfile): string[];
```

#### `core/job/*`

```ts
// types.ts
export interface Stroke {
  readonly points: readonly Vec[];   // mm da MÁQUINA; 1 ponto = "ponto" (desce e sobe a caneta)
  readonly closed: boolean;          // closed ⇒ points[0] e points[n−1] são iguais
  readonly drawingId: DrawingId;
}
export interface OrderedStroke extends Stroke { readonly joinedToPrevious: boolean }
export type FeedClass = "straight" | "curve" | "tight";
export interface PlannedStroke extends OrderedStroke {
  readonly feeds: readonly number[];        // mm/min, um por segmento (points.length − 1)
  readonly classes: readonly FeedClass[];   // para colorir a pré-visualização
}
export interface BoundsViolation { readonly drawingId: DrawingId; readonly bbox: BBox; readonly message: string }
export interface TimeEstimate { readonly totalS: number; readonly drawS: number; readonly travelS: number; readonly penS: number }
export interface JobStats {
  readonly drawMm: number; readonly travelMm: number;
  readonly travelMmUnoptimized: number;     // na ordem do documento, para mostrar a economia
  readonly penLifts: number; readonly segments: number;
  readonly estimate: TimeEstimate;
  readonly strokeStartTimesS: readonly number[]; // para progresso e "play"
}
export interface JobPlan {
  readonly strokes: readonly PlannedStroke[];
  readonly start: Vec; readonly end: Vec;     // máquina
  readonly violations: readonly BoundsViolation[];
  readonly stats: JobStats;
}

// strokes.ts
export function documentToStrokes(doc: PlotDocument, profile: MachineProfile): Stroke[];

// bounds.ts
export function checkBounds(strokes: readonly Stroke[], area: { width: number; height: number }, epsMm?: number): BoundsViolation[]; // eps 0,005

// optimize.ts
export interface OrderOptions { readonly start: Vec; readonly joinGapMm: number; readonly allowReverse: boolean; readonly rotateClosed: boolean }
export function orderStrokes(strokes: readonly Stroke[], opts: OrderOptions): OrderedStroke[];
export function keepOrder(strokes: readonly Stroke[], joinGapMm: number): OrderedStroke[];  // otimização desligada: só marca junções
export function travelLength(strokes: readonly Stroke[], start: Vec, end: Vec): number;

// speed.ts
export function vertexRadii(points: readonly Vec[], closed: boolean, dyn: MachineProfile["dynamic"]): number[]; // Infinity = reta/canto
export function classifyRadius(r: number, dyn: MachineProfile["dynamic"]): FeedClass;
export function assignFeeds(s: OrderedStroke, job: JobSettings, profile: MachineProfile): PlannedStroke;

// estimate.ts
export function estimateTime(strokes: readonly PlannedStroke[], start: Vec, end: Vec, profile: MachineProfile): { estimate: TimeEstimate; strokeStartTimesS: number[] };

// gcode.ts
export interface GcodeMeta { readonly fileName: string; readonly date: Date; readonly job: JobSettings }
export interface GcodeLine {
  readonly text: string;
  readonly strokeIndex: number;   // −1 = cabeçalho, deslocamento ou fim
  readonly pointIndex?: number;   // ponto do traço que esta linha alcança
}
export interface GcodeProgram { readonly lines: readonly GcodeLine[]; toText(): string } // "\n" no fim de cada linha
export function formatCoord(v: number): string;  // 2 casas, nunca "-0.00"
/** Remove acentos (NFD + tira diacríticos); "—" e "–" viram "-"; aspas curvas viram " e ';
 *  qualquer outro caractere fora de 0x20–0x7E vira "?"; corta em 60 caracteres. */
export function toAsciiComment(s: string): string;
export function generateGcode(plan: JobPlan, profile: MachineProfile, meta: GcodeMeta): GcodeProgram;

// pipeline.ts
export function planJob(doc: PlotDocument, profile: MachineProfile, job: JobSettings): JobPlan;
```

#### `core/grbl/*` (v2)

```ts
// protocol.ts
export const RT = {
  STATUS: 0x3f, HOLD: 0x21, RESUME: 0x7e, RESET: 0x18, JOG_CANCEL: 0x85,
  FEED_RESET: 0x90, FEED_PLUS_10: 0x91, FEED_MINUS_10: 0x92, FEED_PLUS_1: 0x93, FEED_MINUS_1: 0x94,
  SPINDLE_STOP: 0x9e,
} as const;   // NUNCA 0x99–0x9D (mudam o S = posição do servo)
export type MachineState = "Idle" | "Run" | "Hold" | "Jog" | "Alarm" | "Door" | "Check" | "Home" | "Sleep";
export interface StatusReport {
  readonly state: MachineState; readonly subState?: number;
  readonly mpos?: Vec; readonly wpos?: Vec; readonly wco?: Vec;
  readonly feed?: number; readonly spindle?: number;
  readonly pins: string;                                       // "" se ausente; "XY" = fins de curso
  readonly overrides?: { readonly feed: number; readonly rapid: number; readonly spindle: number };
}
export type GrblMessage =
  | { type: "ok" } | { type: "error"; code: number } | { type: "alarm"; code: number }
  | { type: "status"; report: StatusReport }
  | { type: "banner"; version: string }                       // "Grbl 1.1h ['$' for help]"
  | { type: "msg"; text: string }                             // [MSG:...]
  | { type: "feedback"; tag: string; body: string }           // [GC:...] [G54:...] [VER:...] [echo:...]
  | { type: "setting"; id: number; value: string }            // $100=80.000
  | { type: "unknown"; line: string };
export function parseLine(line: string): GrblMessage;
export class LineSplitter { push(chunk: Uint8Array): string[] } // junta pedaços, separa por \n, tira \r
/** WPos = MPos − WCO (guardar o último WCO recebido). */
export function workPosition(r: StatusReport, lastWco: Vec | undefined): Vec | undefined;

// codes.ts
export function describeError(code: number): { title: string; action: string };
export function describeAlarm(code: number): { title: string; action: string; needsHoming: boolean };

// commands.ts
export function jogRelative(d: Vec, feed: number): string;     // "$J=G91 G21 X10.00 Y0.00 F3000"
export function jogTo(p: Vec, feed: number): string;           // "$J=G90 G21 X0.00 Y0.00 F6000"
export function clampToArea(p: Vec, area: { width: number; height: number }, marginMm?: number): Vec;
export function frameProgram(bbox: BBox, profile: MachineProfile): string[]; // M5, G4, G0 nos 4 cantos e volta
export type ManualCommandCheck =
  | { kind: "ok" } | { kind: "confirm"; reason: string } | { kind: "blocked"; reason: string };
export function classifyManualCommand(line: string): ManualCommandCheck;

// streamer.ts
/** Prepara uma linha para o GRBL: tira comentários (; e parênteses), espaços nas pontas. null = vazia.
 *  Lança se tiver byte fora de ASCII ou mais de 70 caracteres. */
export function prepareLine(raw: string): string | null;
export class CharCountingStreamer {
  constructor(opts: { rxBufferBytes: number });   // usa rxBufferBytes − 1 (127)
  enqueue(lines: readonly { text: string; id: number }[]): void;
  /** Linhas que cabem agora (soma pendente + tamanho+1 ≤ 127). Marca como pendentes. */
  takeSendable(): { text: string; id: number }[];
  /** A cada ok/error: libera a linha pendente mais antiga e devolve qual era. */
  acknowledge(): { id: number } | undefined;
  readonly pendingBytes: number; readonly pendingCount: number; readonly queuedCount: number;
  clear(): void;   // após reset: o GRBL descartou tudo
}

// clock.ts
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number; clearInterval(id: number): void;
}
export const realClock: Clock;
export class ManualClock implements Clock { advance(ms: number): void /* dispara timers na ordem */ }

// transport.ts
export interface Transport {
  readonly label: string;                       // "Arduino Uno (2341:0043)" ou "Simulador"
  open(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  onData: ((chunk: Uint8Array) => void) | null;
  onClose: ((info: { reason: "user" | "lost"; error?: unknown }) => void) | null;
}

// controller.ts
export type LinkState = "disconnected" | "opening" | "waitingBanner" | "connected" | "lost";
export type JobState = "none" | "running" | "pausing" | "paused" | "resuming" | "stopping" | "finished" | "stopped" | "failed";
export interface JobProgress {
  readonly state: JobState; readonly total: number; readonly acked: number;
  readonly currentLine?: number;               // estimada pela posição (ver 3.7)
  readonly startedAt?: number; readonly pausedMs: number;
  readonly error?: { readonly line: number; readonly code: number; readonly text: string };
}
export interface ControllerSnapshot {
  readonly link: LinkState;
  readonly status?: StatusReport; readonly wpos?: Vec; readonly lastStatusAt?: number;
  readonly homed: boolean;
  readonly settings: ReadonlyMap<number, string>;  // lido com $$ ao conectar
  readonly settingsWarnings: readonly string[];    // divergências entre $$ e o perfil
  readonly job: JobProgress;
}
export interface LogEntry { readonly at: number; readonly dir: "in" | "out" | "info"; readonly text: string }
export class GrblController {
  constructor(transport: Transport, profile: MachineProfile, clock: Clock);
  get snapshot(): ControllerSnapshot;
  subscribe(l: (s: ControllerSnapshot) => void): () => void;
  onLog(l: (e: LogEntry) => void): () => void;
  connect(): Promise<void>;                 // abre, espera banner (5 s; se não vier, 0x18 e mais 3 s), lê $$ e $#
  disconnect(): Promise<void>;              // recusa se job rodando (exige parar antes)
  send(line: string): Promise<{ ok: true } | { ok: false; code: number }>; // pela fila contada
  realtime(byte: number): void;
  home(): Promise<void>; unlock(): Promise<void>;
  penUp(): Promise<void>; penDown(): Promise<void>;
  goToOrigin(): Promise<void>; softReset(): void;
  jogStep(d: Vec, feed: number): Promise<void>;
  jogContinuous(dir: Vec, feed: number): void; jogStop(): void;
  frame(bbox: BBox): Promise<void>;
  startJob(program: GcodeProgram): void;    // pré-condições: seção 3.7
  pause(): void; resume(): void; stop(): void; emergencyStop(): void;
  feedOverride(cmd: number): void;          // só RT.FEED_*
}

// fakeGrbl.ts
export interface FakeGrblOptions {
  workArea: { width: number; height: number };
  rxBufferBytes?: number;   // 128
  plannerBlocks?: number;   // 15
  bootDelayMs?: number;     // 1500
  homingMs?: number;        // 2000
  spindleStopInHold?: boolean;  // true; false simula fork sem suporte a 0x9E
  faults?: { errorAtLine?: { line: number; code: number }; disconnectAfterLines?: number; noBanner?: boolean };
}
export class FakeGrbl implements Transport {
  constructor(clock: Clock, opts: FakeGrblOptions);
  // inspeção para testes:
  readonly penStrokes: readonly (readonly Vec[])[];   // o que a caneta desenhou, em WPos
  readonly maxRxUsed: number; readonly rxOverflow: boolean;
  readonly state: MachineState; readonly wpos: Vec; readonly penDown: boolean;
  readonly linesExecuted: number;
}
```

#### `ui/*` e `storage/*`

```ts
// storage/kv.ts
export function kvGet<T>(key: string): Promise<T | undefined>;
export function kvSet(key: string, value: unknown): Promise<void>;
// storage/profileStore.ts  — chave localStorage "plotter-studio:profile"
export function loadProfile(): MachineProfile;           // mergeProfile do salvo; erro de leitura → DEFAULT_PROFILE
export function saveProfile(p: MachineProfile): void;
export function exportProfileJson(p: MachineProfile): string;
export function importProfileJson(text: string): MachineProfile; // lança Error com mensagem em português
// storage/sessionStore.ts  — IndexedDB "plotter-studio", chave "session"
export function startAutosave(store: Store): () => void; // debounce 1 s após cada commit
export function restoreSession(): Promise<PlotDocument | undefined>;

// ui/drawingObject.ts
export class DrawingObject extends FabricObject {   // de "fabric"
  constructor(d: Drawing);
  drawingId: DrawingId;
  setOutOfArea(v: boolean): void;                   // traço vermelho
}
// ui/canvasView.ts
export class CanvasView {
  constructor(canvas: Canvas, store: Store);
  /** Reconcilia o Fabric com o documento (cria, remove, atualiza matrizes) preservando a seleção. */
  sync(doc: PlotDocument): void;
}
// ui/viewport.ts
export function fitToScreen(canvas: Canvas, area: { width: number; height: number }, marginPx?: number): void;
export function installZoomPan(canvas: Canvas, opts: { minZoom: number; maxZoom: number }): () => void;
// ui/board.ts
export function installBoard(canvas: Canvas, getProfile: () => MachineProfile): () => void;
// ui/overlay.ts
export class Overlay {
  constructor(host: HTMLElement, canvas: Canvas, getHeight: () => number);
  setPlan(plan: JobPlan | undefined): void;
  setPlayhead(timeS: number | undefined): void;     // animação "play"
  setMachinePosition(p: Vec | undefined): void;     // v2
  setCurrentLine(strokeIndex: number | undefined): void; // v2
  redraw(): void;
}
```

### 2.5 Desfazer/refazer

- **O que entra no histórico:** só o `PlotDocument`. Seleção, configurações do trabalho, perfil e estado da máquina ficam fora.
- **Como:** snapshots imutáveis. `Geometry` nunca é mutada e é compartilhada por referência, então um snapshot custa um array de `Drawing` (dezenas de bytes por desenho). O limite é 100 entradas.
- **Uma entrada por gesto concluído:** `object:modified` do Fabric, Enter ou saída de foco num campo numérico, importação, apagar, duplicar, alinhar. Toques de seta usam `coalesceKey: "nudge"` (800 ms), e digitar no mesmo campo usa `"field:<nome>"`.
- **Durante o arraste o modelo não muda.** O Fabric mostra o movimento e o modelo recebe a matriz final no `object:modified`.
- **Depois de desfazer,** `CanvasView.sync` reconcilia o canvas. Se algum objeto alterado estiver dentro de uma `ActiveSelection`, a seleção é desfeita (`discardActiveObject`), as matrizes são aplicadas e a seleção é recriada com os mesmos ids. Mexer num objeto dentro do grupo sem isso corrompe a posição.
- **Atalhos:** Ctrl+Z desfaz; Ctrl+Y e Ctrl+Shift+Z refazem. Os botões mostram o rótulo ("Desfazer: Mover").

### 2.6 Como o estado é salvo

| O quê | Onde | Chave | Quando |
|---|---|---|---|
| Perfil da máquina | `localStorage` | `plotter-studio:profile` (`{version:1, profile}`) | ao salvar no diálogo de Configurações |
| Configurações do trabalho | `localStorage` | `plotter-studio:job` | a cada mudança |
| Preferências da UI (aba aberta, passo do jog...) | `localStorage` | `plotter-studio:ui` | a cada mudança |
| Sessão (documento) | IndexedDB `plotter-studio`/`kv` | `session` (`ProjectFileV1`) | debounce de 1 s após cada commit |
| Porta serial usada por último | `localStorage` | `plotter-studio:port` (`usbVendorId`/`usbProductId`) | ao conectar |

- O IndexedDB é necessário porque um SVG grande gera alguns MB de JSON, e o `localStorage` tem limite de ~5 MB.
- Ao abrir o app, se houver sessão salva, ela é restaurada sem perguntar e o rodapé mostra "Sessão restaurada (3 desenhos)".
- Na v3, "Salvar projeto" baixa o mesmo `ProjectFileV1` como `.plotter.json`.

### 2.7 Layout da tela

```
┌ Plotter Studio │ Importar SVG │ ↶ ↷ │ (v2) Conectar ● Idle │ ⚙ Configurações ───────────────┐
│                                                     │ [Propriedades] [Trabalho] [Máquina]  │
│               canvas (mesa + desenhos)              │  painel da aba ativa                 │
│               + sobreposição (caminho)              │                                      │
├ X 123,4  Y 56,7 mm │ zoom 2,3 px/mm │ ⚠ 1 desenho fora da área │ ~12 min ─────────────────┤
└ (v2) console recolhível ─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Algoritmos

### 3.1 Importar SVG

**Abordagem.** `DOMParser` (`image/svg+xml`) → `SvgNode`, depois um percurso recursivo puro.

1. **Unidades e página (`rootMapping`).**
   - `width`/`height` com unidade: mm, cm (×10), in (×25,4), pt (×25,4/72), pc (×25,4/6), px ou sem unidade (×25,4/96).
   - Com `viewBox`: `userToMm = viewBoxToMm(viewBox, widthMm, heightMm, preserveAspectRatio)`. Sem `viewBox`: unidade de usuário = px.
   - Sem `width`/`height` mas com `viewBox`: a página mede o viewBox em px (96 dpi), com aviso `no-size`. Sem nenhum dos dois: página = bbox do conteúdo, também com aviso.
   - Tamanho em px (ou sem unidade): aviso `size-in-px`, "tamanho calculado a 96 dpi; se veio do Illustrator (72 dpi), aumente para 133%".
   - `%` em width/height conta como ausente.
2. **Transforms.** `parseTransformList` aceita `matrix`, `translate(tx [ty])`, `scale(sx [sy])`, `rotate(a [cx cy])`, `skewX`, `skewY`, separados por vírgula e/ou espaço. A lista é composta da esquerda para a direita: `M = T1 × T2 × …`. Um transform inválido vira identidade, com aviso. A matriz acumulada desce pela árvore: `ctm_filho = ctm_pai × transform_filho`, começando de `userToMm`.
3. **Elementos.**
   - **Viram traço:** `path`, `line`, `polyline`, `polygon`, `rect` (com `rx`/`ry`: 4 retas + 4 arcos), `circle`, `ellipse`.
   - **Atravessados:** `svg` aninhado (como `g`, mais translate(x,y) e o viewBox dele), `g`, `a`, `switch` (só o primeiro filho), `use` (com `href` ou `xlink:href` para o id, mais translate(x,y); o alvo é procurado na árvore inteira, inclusive dentro de `defs`).
   - **Ignorados:** `defs` (exceto via `use`), `symbol` (exceto via `use`), `metadata` (os samples têm um bloco c2pa grande), `title`, `desc`, `style`, `script`, `clipPath`, `mask`, `pattern`, `marker`, `linearGradient`, `radialGradient`, `filter`, `foreignObject`, e qualquer namespace estranho.
   - **Ignorados com aviso:** `text` (e `tspan`/`textPath`): "Texto ignorado: no Inkscape, use Caminho → Objeto para caminho". `image`: "imagem ignorada".
4. **Visibilidade.** `display="none"`, ou `style="display:none"`, esconde o elemento e todos os filhos (as camadas ocultas do Inkscape são assim). `visibility` é herdado. **Preenchimento é ignorado**: toda forma vira contorno, mesmo que só tenha `fill`. Um elemento com `fill` e `stroke` efetivos iguais a `none` (com herança via atributo e via `style`) é invisível, então é pulado e contado no aviso `invisible-ignored`. Classes CSS em `<style>` **não** são interpretadas (limitação documentada).
5. **Path data.** É um tokenizer que entende:
   - números colados (`.5.5` = 0,5 e 0,5; `-1-1`; `1e-3`, `1E2`);
   - flags de arco coladas (`a10 10 0 1010 0`: as flags são um caractere cada);
   - repetição implícita (depois de `M`, os pares seguintes são `L`);
   - relativos;
   - `H`/`V`;
   - `S`/`T` refletindo o controle anterior só se o comando anterior for C/S (resp. Q/T), senão o controle é o ponto atual;
   - `Z` volta ao início do subpath, e o próximo comando sem `M` começa nesse ponto;
   - subpath sem nenhum segmento (um `M` seguido de outro `M`) é descartado. A espiral de `curvas.svg` começa assim: `M250 55 m2 0`.

   No primeiro erro, para e devolve o que leu, com aviso `bad-path` (o navegador faz o mesmo).
6. **Arcos** (`arcToCubics`). Conversão de ponto final para centro, conforme o SVG 1.1, apêndice F.6.5.
   - Correção de raios pequenos: se Λ = x'²/rx² + y'²/ry² > 1, multiplicar os raios por √Λ.
   - rx = 0 ou ry = 0 vira reta. Pontos inicial e final iguais: o arco é omitido.
   - Fatiado em ⌈|Δθ|/45°⌉ cúbicas, com alça k = 4/3·tan(Δθ/4).
7. **Transformação para mm.** Pontos de controle × ctm. É exato para qualquer afim, inclusive com skew. Por isso arcos e quádricas viram cúbicas **antes** de transformar.
8. **Resultado.** `geometry` em mm, origem no canto superior esquerdo da página. `importPlacement` posiciona a página com o canto inferior esquerdo no (0,0) da máquina: um A4 do Inkscape cai em cima do gabarito A4, e os samples geram as coordenadas "do teste à mão". Se a geometria ficar vazia: `SvgImportError("Nenhum traço encontrado no SVG.")`.

**Parâmetros padrão.** Arcos com no máximo 45° por cúbica e 96 dpi.

**Casos difíceis e o que acontece:**
- **Inkscape 0.92**: viewBox em px com width em mm. Funciona pela razão viewBox/width.
- **Illustrator** (px a 72 dpi): sai com 75% do tamanho. O aviso `size-in-px` sugere ×1,333.
- **`preserveAspectRatio` com viewBox de proporção diferente da página**: deslocamento centralizado (meet).
- **Ícones da web** (só viewBox `0 0 24 24`): entram com 6,35 mm. O Artur escala.
- **`<use>` apontando para `<use>`**: recursão com limite de profundidade 10, para evitar laço.
- **Arquivos com 100 mil elementos**: o parse é linear. Mostrar "Importando…" se passar de 300 ms.

**Testes.** Seção 4.1, casos de `units`, `transform`, `pathData`, `arc`, `shapes` e `importSvg`. Mais os goldens da seção 4.2.

### 3.2 px ↔ mm e a inversão do eixo Y

- **Não existe "px" no modelo.** A cena do Fabric é em mm. A conversão para a tela é só o `viewportTransform` = `[z, 0, 0, z, panX, panY]`, com z em px por mm.
- **Ajustar à tela:** `z = min((w − 2m)/810, (h − 2m)/385)`, com m = 20 px, e o pan centraliza. Zoom pela roda do mouse com `zoomToPoint` (fator 0,999^deltaY), limitado a [0,3; 40] px/mm. Pan com espaço + arrastar ou botão do meio.
- **Inversão de Y:** só em `sceneToMachineMatrix(H)`. Exemplos:
  - O cursor mostra `sceneToMachine(canvas.getScenePoint(e), H)`.
  - O G-code usa `multiply(sceneToMachineMatrix(H), d.transform)`.
  - As setas do teclado convertem "↑" em +Y da máquina, que é −Y na cena.
  - A rotação mostrada é `machineRotationDeg` (anti-horária positiva, como o operador vê). O `angle` do Fabric é horário na tela, então os sinais são opostos.
- **Ponte com o Fabric** (`coords.ts`): o Fabric 7 posiciona objetos pelo **centro** (`originX/originY = "center"`, confirmado em `node_modules/fabric/src/shapes/Object/defaultValues.ts`).
  - `fabricMatrix = modelMatrix × T(cx, cy)`, onde (cx, cy) é o centro de `localBBox`.
  - Modelo → Fabric: `util.applyTransformToObject(obj, fabricMatrix)` (existe no Fabric 7.4 e decompõe com `qrDecompose`).
  - Fabric → modelo: `modelMatrixFromFabric(obj.calcTransformMatrix(), localBBox)`. É `calcTransformMatrix`, não `calcOwnMatrix`, porque quando o objeto está numa `ActiveSelection` só a primeira inclui a matriz do grupo.
- **Sem espelhamento acidental:** `lockScalingFlip: true` em todos os `DrawingObject`. Sem isso, arrastar uma alça além do lado oposto espelharia o desenho. Um teste garante que `determinant(transform) > 0` depois de qualquer operação do documento.
- **`DrawingObject`:**
  - `width`/`height` = tamanho da `localBBox`, com mínimo de 0,5 mm (uma linha vertical tem largura 0, e as alças dividiriam por zero).
  - `strokeWidth: 0` no objeto. O traço é desenhado à mão em `_render`, porque o `strokeWidth` do Fabric entra no cálculo da caixa.
  - `_render(ctx)`: `ctx.translate(−cx, −cy)` e `ctx.stroke(path2d)`, com `lineWidth = 1,5 / escala`, sendo escala = √|det(ctx.getTransform())|. Assim a linha tem ~1,5 px em qualquer zoom.
  - O `Path2D` (com `lineTo` e `bezierCurveTo`) é criado uma vez por geometria e guardado num `WeakMap`.
  - `objectCaching` fica no padrão (true): arrastar desenhos grandes fica leve.

**Testes:**
- `sceneToMachine` de (60, 325) com H = 385 dá (60, 60).
- O canto (0,0) da cena vira (0, 385) na máquina.
- `fabricMatrixFromModel` seguido de `modelMatrixFromFabric` devolve a matriz original (com rotação, escala e translação).
- `machineRotationDeg(rotationDeg(−30))` = 30. A rotação de −30° na cena (Y↓) é anti-horária para quem olha a máquina.
- O golden de orientação (4.2) é o teste definitivo.

### 3.3 Simplificação sem esvaziar o buffer do GRBL

O problema: o planejador do Uno guarda ~15 movimentos. Se cada movimento dura menos do que o GRBL leva para receber e planejar o próximo, a fila esvazia, a máquina freia até parar e recomeça: ela "gagueja". O tempo de um movimento é comprimento ÷ velocidade, então segmentos minúsculos em velocidade alta são o pior caso.

O pipeline por traço, em mm da máquina:

1. **Achatar** com tolerância de corda de 0,05 mm (Wang). Exemplos:
   - Círculo R30: 8 cúbicas × 7 = **56 segmentos de 3,37 mm**.
   - R5: 8 × 3 = 24 segmentos de 1,31 mm.
   - Linhas retas não se dividem.
2. **RDP** com ε = 0,05 mm. Remove pontos colineares e o ruído de polilinhas densas (SVGs gerados a partir de imagem). Não remove vértices de arcos achatados a 0,05: tirar um vértice dobraria a flecha para ~0,19 mm. Erro total ≤ 0,1 mm, invisível com caneta de 0,3–0,5 mm.
3. **Fundir segmentos < 0,1 mm** (`dropShortSegments`), sem nunca remover o último ponto do traço.
4. **Traço com comprimento total < 0,05 mm** vira "ponto": um único vértice (desce e sobe a caneta).
5. **Teto de vazão** (aplicado em `speed.ts`, nos dois modos):
   - Regra: `F ≤ 60 · comprimento_mm / (minSegmentTimeMs/1000)`, com piso de F100.
   - Com 10 ms, o teto dá: 0,1 mm → F600, 0,2 mm → F1200, 0,33 mm → F2000.
   - O efeito é que a máquina desacelera sozinha onde os segmentos são densos, que normalmente é onde há detalhe fino.
   - É conservador porque age por segmento, não pela média da fila. O valor de 10 ms (≤ 100 linhas/s) é calibrado no teste manual da T17 com `samples/estresse.svg`.
6. **Linhas curtas no G-code.** Duas casas decimais; linhas cujas coordenadas arredondadas repetem as anteriores são descartadas. A linha mais longa possível é `G1 X810.00 Y385.00 F12000` (25 caracteres). A 115200 baud, a serial entrega ~570 linhas/s, então não é o gargalo.

**Testes.**
- `rdp` com (0,0), (1, 0,01), (2,0) e ε = 0,05 dá [(0,0), (2,0)].
- `rdp` mantém o canto (0,0), (10,0), (10,10).
- Quadrado fechado com pontos médios redundantes fica com 5 pontos.
- `dropShortSegments` com (0,0), (0,03,0), (0,06,0), (5,0) e mínimo 0,1 dá [(0,0), (5,0)].
- Traço de 0,02 mm vira ponto.
- O círculo R30 continua com 56 segmentos depois do RDP.
- Teto: um segmento de 0,1 mm a F2000 sai a F600.

### 3.4 Ordem dos traços

**Abordagem:** vizinho mais próximo com inversão, rotação de laços e junção.

1. Começa na posição atual: (0,0) na v1, ou a WPos na v2.
2. Para cada traço restante, os candidatos de entrada são:
   - traço aberto: o início, ou o fim (com o traço invertido);
   - traço fechado: **qualquer vértice** (o laço é girado para começar ali; a direção é mantida).
3. Escolhe o candidato mais próximo do ponto atual. Empate: menor índice original, para a saída ser determinística.
4. Se a distância for menor que `joinGapMm` (0,1), o traço é marcado `joinedToPrevious` e no G-code vira um `G1` até o início, sem levantar a caneta. Isso é a "junção de pontas".
5. **Índice espacial:** grade uniforme de 10 mm com todos os candidatos (pontas dos abertos, vértices dos fechados). A busca expande em anéis até que a distância mínima possível do próximo anel seja maior que o melhor achado. Traço usado é removido do índice. Laços com milhares de vértices entram com no máximo 64 vértices amostrados, mais as pontas.
6. Com a otimização desligada, `keepOrder` mantém a ordem do documento e do arquivo, sem inverter nem girar, e só marca as junções.

**Vale um 2-opt depois? Não, na v1 e na v2.** O tempo de um desenho com muitos traços é dominado pelas pausas do servo: 0,6 s por traço (descer + subir). Num desenho de 1000 traços isso dá 10 minutos só de servo. O deslocamento com a caneta levantada é feito a até 200 mm/s: 10 m de viagem custam ~1 min. O 2-opt melhora o vizinho mais próximo em 10–20% da viagem, ou seja, 6–12 s em 11 min. Fica como item opcional da v3.

**Testes.**
- Três traços na mesma reta: A (0,0)→(10,0), B (30,0)→(20,0) (invertido na entrada), C (40,0)→(50,0). Saindo de (0,0): A, B invertido, C; viagem de 20 mm.
- Junção: (0,0)→(10,0) e (10,05,0)→(20,0) dá `joinedToPrevious = true`.
- Rotação de laço: o quadrado do `teste_quadrado_circulo` começa em (10,10) quando a partida é (0,0).
- Determinismo: mesma entrada dá a mesma saída.
- Desempenho: 20 mil traços aleatórios em menos de 1 s no Node.
- Economia no `teste_quadrado_circulo` (4.2): viagem de 312,96 → 109,71 mm.

### 3.5 Velocidade dinâmica pela curvatura

**Os dados de 13/11, em aceleração lateral** (a = v²/R; hipótese de trabalho: a ondulação cresce com essa aceleração):

| Teste | v (mm/s) | R (mm) | v²/R (mm/s²) | Resultado |
|---|---|---|---|---|
| F500 | 8,3 | 40 | 1,7 | impecável |
| F1000 | 16,7 | 40 | 7,0 | impecável |
| F2000 | 33,3 | 40 | 27,8 | pequenas ondulações |
| F4000 | 66,7 | 40 | 111 | mais ondulações |

Mantendo ~10 mm/s² como limite seguro:
- F1200 (`curve`) exige R ≥ 40.
- F600 (`tightCurve`) aguenta até R ≈ 10.
- F2000 (`straight`) exigiria R ≥ 110.

Daí os padrões: **R ≥ 100 → reta; 40 ≤ R < 100 → curva; R < 40 → curva fechada.** Abaixo de R10, mesmo F600 passa do limite. Se o teste manual mostrar ondulação no círculo R5 de `curvas.svg`, a correção é baixar `tightCurve` para F400 nas Configurações. Essa leitura só foi medida em R40; ondulação pode ser ressonância e não depender só de v²/R, e o teste da T17 confirma ou derruba a hipótese.

**Por que cantos não ganham F próprio.** O GRBL limita a velocidade em cada junção pelo `$11` (junction deviation δ). Com φ = ângulo de virada:

v² = a · δ · s / (1 − s), com s = cos(φ/2), δ = 0,01 mm, e a = 800 mm/s² limitado por eixo **na direção da junção** (como o `limit_value_by_axis_maximum` do GRBL 1.1: numa junção diagonal a aceleração efetiva chega a 800/cos 45° = 1131 mm/s²). Valores para movimento ao longo de X:

| φ (virada) | v na junção | equivale a |
|---|---|---|
| 90° | 5,2 mm/s | F314 |
| 45° | 10,3 mm/s | F615 |
| 30° | 15,3 mm/s | F919 |
| 16° (passo de um círculo R5 achatado) | 28,7 mm/s | F1721 |
| 6° (passo de R40) | 76 mm/s | F4585 |

Em cantos de 45° o GRBL já freia a ~F615, praticamente o `tightCurve` (F600); em cantos mais fechados, bem abaixo. Já nas curvas achatadas os passos são pequenos e o GRBL quase não freia. É por isso que o F precisa vir de nós.

**Algoritmo** (`speed.ts`, por traço, em mm da máquina):

1. Para cada vértice interno i (em traço fechado, todos, com vizinhos circulares), calcular R_i:
   - Se o ângulo de virada φ_i > `cornerAngleDeg` (45°): R_i = ∞ (canto).
   - Se algum segmento vizinho for maior que `maxCurveSegmentMm` (10 mm): R_i = ∞. Um segmento longo não é amostra de curva; é polígono.
   - Senão: R_i = raio do círculo pelos 3 pontos = |a|·|b|·|c| / (2·|cross(a, b)|), e ∞ se o cross for ≈ 0.
2. Classe de cada segmento j:
   - segmento > `maxCurveSegmentMm` → reta;
   - senão, `classifyRadius(min(R_j, R_{j+1}))`, com raio ∞ nas pontas de traço aberto.
3. **Janela:** a classe de cada segmento passa a ser a mais lenta entre os segmentos curtos contíguos a até `windowMm` (2 mm) de distância de caminho, para os dois lados. Isso evita alternar F a cada segmento por ruído e faz a curva fechada "vazar" um pouco para as vizinhas.
4. F = `feed[classe]`, ou `fixedFeed` no modo fixo. Depois, o teto de vazão (3.3) e o limite `motion.maxRateMmMin`.
5. Não é preciso desacelerar "antes" da curva: o planejador do GRBL vê o F menor do próximo bloco e desacelera dentro do bloco anterior.

**Testes** (sintéticos, longe das fronteiras):
- Reta de 100 mm, um segmento: straight (F2000).
- Quadrado de 50 mm: os quatro lados straight.
- Círculo R150: straight. Círculo R50: curve (F1200). Círculo R20: tight. Círculo R5: tight.
- Reta de 100 mm seguida de arco R5: a reta fica F2000, o arco F600.
- Janela: um arco de R60 com 1 mm em R5 no meio. Os segmentos do trecho a até 2 mm do R5 ficam tight; o resto, curve.
- Modo fixo F1000: tudo F1000, exceto segmentos curtos limitados pelo teto.
- Polígono de 10 lados com lados de 50 mm (virada de 36°): straight (pela regra do segmento longo).

### 3.6 Estimativa de tempo

Uma simulação simplificada do planejador do GRBL:

1. **Movimentos.** Cada G1 é um bloco com comprimento L e velocidade nominal v = F/60, limitada por eixo. Cada eixo tem máximo de 200 mm/s; para a direção unitária u, `v ≤ min_i(vmax_i/|u_i|)`. Na diagonal, isso permite 283 mm/s, como no GRBL. A aceleração usa o mesmo limite por eixo. Cada G0 é um bloco à velocidade máxima (12000 mm/min).
2. **Paradas.** `M3`, `M5` e `G4` sincronizam o GRBL: velocidade zero antes e depois. Cada G4 soma P segundos. Assim, cada traço e cada deslocamento começa e termina parado.
3. **Junções.** Dentro de uma sequência sem paradas, a velocidade máxima na junção é a fórmula da seção 3.5, limitada também por min(v_anterior, v_seguinte).
4. **Duas passadas.** Para trás: `v_entrada ≤ √(v_saída² + 2aL)`. Para frente: `v_saída ≤ √(v_entrada² + 2aL)`.
5. **Tempo do bloco.** Trapézio: acelera até o pico (limitado por v nominal) e desacelera. Se não houver distância para atingir v, é um triângulo.
6. **Ignorados de propósito:** o limite de 15 blocos de antecipação do GRBL (estimativa levemente otimista), a gagueira por falta de linhas e o arredondamento. A precisão esperada é de ±10%. A v2 registra o tempo real ao fim de cada trabalho para comparar.

**Testes** (valores exatos):
- 100 mm a F600: 99,875/10 + 2·(10/800) = **10,0125 s**.
- 1 mm a F6000: triângulo, pico √(800·1) = 28,3 mm/s, t = 2·√(1/800) = **0,0707 s**.
- `G4 P0.3` soma exatamente 0,3 s.
- 50 + 50 mm colineares no mesmo F levam o mesmo tempo que 100 mm.
- Canto de 90°: a velocidade na junção é 5,23 mm/s (tolerância 0,01), com a aceleração limitada por eixo na direção da junção, como no GRBL.
- G0 de 100 mm a 200 mm/s: 25 mm acelerando, 50 mm em cruzeiro, 25 mm freando: 0,25 + 0,25 + 0,25 = **0,75 s**.

### 3.7 Streaming, conexão, pausa, parada e cabo

**Contagem de caracteres** (`CharCountingStreamer`, como no GRBL.md):
- O buffer de recepção tem 128 bytes; o limite usado é 127.
- Envia enquanto `pendingBytes + len(linha)+1 ≤ 127`.
- A cada `ok` ou `error:N`, libera a linha pendente mais antiga.
- Comentários e linhas vazias saem **antes** de enviar (`prepareLine`), porque também ocupam o buffer.
- Os bytes de tempo real (`?`, `!`, `~`, 0x18, 0x85, 0x9E, 0x90–0x94) furam a fila e não contam.

**Não existe timeout de `ok`.** O GRBL só responde `ok` quando a linha entra no planejador. Uma reta de 800 mm a F600 segura o planejador cheio por 80 s, e o `ok` seguinte demora isso tudo. A saúde da conexão é medida pelo relatório de estado (`?` a cada 200 ms):
- 1 s sem resposta: aviso "sem resposta".
- 5 s sem resposta: "a placa parece travada". A conexão continua aberta; o usuário decide.

**Estado da conexão** (`LinkState`):

```
disconnected ──conectar──► opening ──porta aberta──► waitingBanner ──banner──► connected
     ▲                         │ erro (porta em uso, etc.)  │ 5 s sem banner: envia 0x18
     │                         ▼                            │ mais 3 s sem banner → erro
     └──────────────── desconectar / erro ◄─────────────────┘
connected ──read() rejeita ou evento "disconnect" da porta──► lost ──"Reconectar"──► opening
```

- Ao chegar em `connected`, envia `$$` (configurações) e `$#` (offsets). Compara com o perfil:
  - `$130`/`$131` com a área;
  - `$110`/`$111` com `motion.maxRateMmMin`;
  - `$120`/`$121` com `motion.accelMmS2`;
  - `$11` com `motion.junctionDeviationMm`;
  - `$32` tem que ser 0;
  - `$20` tem que ser 1;
  - G54 tem que ser (−810, −385).

  As divergências aparecem como aviso no painel da máquina. **Nada é corrigido automaticamente.**
- Um banner `Grbl 1.1h` **inesperado** (sem reset pedido por nós) significa que a placa reiniciou (queda de energia ou DTR). Então: fila zerada, trabalho em `failed` com "a placa reiniciou; a posição foi perdida", e `homed = false`.

**Estado da máquina:** vem do relatório (`Idle`, `Run`, `Hold:0/1`, `Jog`, `Alarm`, `Home`...). A `WPos` é `MPos − WCO`, guardando o último WCO recebido.

**`homed`** só vira `true` depois do `ok` de um `$H`. Vira `false` com qualquer `ALARM`, banner de power-up ou parada de emergência. `$X` desbloqueia mas **não** marca `homed`: o jog funciona, mas desenhar exige Home.

**Estado do trabalho** (`JobState`):

```
none ──startJob──► running ──fim (último ok + Idle)──► finished
                     │  ├─ pause ──► pausing ──Hold:0 (+0x9E)──► paused ──resume──► resuming ──(0x9E, servo, ~)──► running
                     │  ├─ error:N ──► (! imediato) ──► paused (com erro na tela: "Continuar mesmo assim" ou "Parar")
                     │  ├─ stop ──► stopping ──(! → Hold:0 → 0x18 → banner)──► stopped   (posição mantida)
                     │  ├─ emergencyStop ──(0x18 já)──► stopped + ALARM:3 → homed=false
                     │  └─ link lost / banner inesperado ──► failed
```

- **Pré-condições do `startJob`.** Todas são checadas, cada uma com mensagem própria:
  - conectado;
  - estado `Idle`;
  - `homed`;
  - plano sem violações de área;
  - WCO conhecido e igual a (−810, −385) ± 0,01;
  - programa não vazio.
- **Durante o trabalho:**
  - Wake Lock de tela (`navigator.wakeLock.request("screen")`), renovado ao voltar à aba.
  - `beforeunload` pede confirmação.
  - O console mostra só envios manuais e erros; as linhas do trabalho só entram no contador.
- **`error:N` durante o trabalho:**
  - `!` imediato, porque o GRBL continua executando o que já está no buffer;
  - para de enviar;
  - mostra linha, texto e código traduzido.
- **Pausa "agora"** (`pauseLift = "spindleStop"`):
  - `!`, depois espera `Hold:0` (poll de `?` a cada 50 ms enquanto isso), depois `0x9E`: o GRBL chama `spindle_stop()` e o servo sobe.
  - Continuar: `0x9E` (restaura o "spindle"; com o hold ativo, o GRBL só religa e não sai andando), espera `settleSeconds + 0,2 s`, depois `~`.
  - Por que essa ordem: se o `~` fosse mandado com o "spindle" parado, o GRBL religaria e sairia andando **na mesma hora**, e o comecinho do traço sairia no ar.
- **Pausa "no fim do traço"** (`pauseLift = "endOfStroke"`, ou o fork não suporta `0x9E`):
  - continua enviando até a próxima linha `M5` e o `G4` dela (inclusive);
  - para de enviar e espera os `ok` pendentes e o estado `Idle`; a caneta já está em cima.
  - Continuar = voltar a enviar.
- **Parar** (`stop`):
  - se `Run`: `!`, espera `Hold:0` (timeout 10 s; se estourar, vira parada de emergência), `0x18`, espera o banner;
  - se `Hold:0` ou `Idle`: `0x18` direto;
  - fila zerada.

  O reset executa `M5`: a caneta sobe e a posição é mantida (sem `ALARM`). O painel oferece "Ir para a origem".
- **Parada de emergência:** `0x18` imediato. Se a máquina estava andando, vem `ALARM:3` e é preciso `$H`.
- **Cabo desconectado:**
  - O `reader.read()` rejeita (`NetworkError: The device has been lost`) e/ou chega o evento `disconnect`. A conexão vai para `lost`, o trabalho para `failed`, e a interface continua responsiva: nada espera por uma promessa que nunca resolve. O `write()` pendente é abandonado com `catch`.
  - A mensagem: "Conexão perdida na linha N de M. Se a placa continuou ligada, ela terminou os ~15 movimentos que já tinha e parou, e a caneta pode ter ficado no papel. Reconecte: a placa vai reiniciar (caneta sobe) e pedir Home."
  - Nunca reconectar sozinho, porque abrir a porta reinicia o Uno.
- **Linha atual na pré-visualização:**
  - a linha executando está entre `acked − 16` e `acked`;
  - dentro dessa janela, escolher o segmento mais próximo da WPos;
  - o progresso usa `strokeStartTimesS` da estimativa, corrigido pela razão entre o tempo real e o estimado até ali.
- **Jog:**
  - **Passo:** `$J=G91 G21 X.. Y.. F..` com o destino calculado e limitado à área (`clampToArea` com margem de 0,5 mm). Assim não há `error:15` em uso normal.
  - **Contínuo** (segurar seta na tela ou no teclado): `jogTo` até a borda da área na direção escolhida; ao soltar, ao perder o foco ou ao trocar de aba, `0x85`.
  - Velocidade de jog padrão: F3000 (editável no painel).
- **Console manual:** `classifyManualCommand`:
  - **bloqueia** `$32=1` e qualquer byte fora de ASCII;
  - **pede confirmação** para `$N=valor`, `$RST=`, `$N0=`, `$N1=`, `$I=`, `G10`, `G28.1`, `G30.1` ("isto grava na EEPROM do GRBL");
  - libera o resto.

**Testes:** com `FakeGrbl` + `ManualClock`, seção 4.3.

---

## 4. Estratégia de testes

### 4.1 Testes unitários do `src/core`

| Arquivo | Casos concretos |
|---|---|
| `geometry/mat2d` | `multiply(translation(10,0), scaling(2))` aplicado a (1,1) dá (12,2); `invert` × original = identidade; `rotationDeg(90)` leva (1,0) a (0,1); `determinant` de `scaling(−1,1)` < 0 |
| `geometry/path` | `ellipseSubPath(60,60,30,30)`: 8 cúbicas, começa em (90,60), fecha; todos os pontos achatados a 30 ± 0,001 do centro; `quadToCubic` reproduz a quádrica em t = 0,5 |
| `geometry/flatten` | `cubicSegmentCount` da cúbica de 45° de R30 = 7; círculo R30 = 56 segmentos; reta = 1 segmento; com `scaling(10)` o círculo R3 também dá 56 (a tolerância vale depois da transformação); o desvio máximo entre polilinha e curva amostrada em 1000 pontos é ≤ 0,05 |
| `geometry/simplify` | os casos da seção 3.3 |
| `svg/units` | "100mm" → 100; "10cm" → 100; "1in" → 25,4; "96px" → 25,4; "96" → 25,4; "72pt" → 25,4; "6pc" → 25,4; viewBox 0 0 200 100 com 100 × 50 mm → escala 0,5; viewBox 0 0 100 50 numa página de 100 × 100 mm (meet) → escala 1, deslocamento y = 25; Inkscape 0.92 (viewBox 0 0 744.09 1052.36, 210 × 297 mm) → escala 0,28222 |
| `svg/transform` | `translate(10)` → ty = 0; `rotate(90 10 10)` leva (20,10) a (10,20); `scale(2 3)`; `skewX(45)` leva (1,1) a (2,1); `translate(10,0) scale(2)` leva (1,1) a (12,2); separadores com vírgula e espaço; `foo(1)` → ok = false |
| `svg/pathData` | `M10 20L30 40`; `M0 0 10 0 10 10` (L implícito, 2 retas); `m10 10 l5 0 l0 5 z m2 2 l1 0` (o segundo subpath começa em (12,12)); `M.5.5L-1-1`; `1e-3`; flags coladas `M0 0a10 10 0 1010 0`; H/V relativos; S depois de C reflete; S depois de L usa o ponto atual; T; Q vira cúbica; `M10 10 L foo` devolve o primeiro subpath e o erro |
| `svg/arc` | `M0 0 A1 1 0 0 1 10 0`: raio corrigido para 5, ponto do meio ≈ (5,−5); `A0 5 ...` vira reta; arco de 180° vira 4 cúbicas; `large`/`sweep` nas 4 combinações (pontos médios conferidos) |
| `svg/shapes` | rect sem rx = 4 retas fechadas começando em (x,y); rect com só `rx` → ry = rx; rx > w/2 é limitado a w/2; rect de largura 0 = nada; circle de r = 0 = nada; polyline "0,0 10,0 10,10" aberta; polygon fecha; line |
| `svg/importSvg` | `<g transform="translate(10,0)"><g transform="scale(2)"><rect x="1" y="1" width="1" height="1"/></g></g>` dá cantos (12,2), (14,2), (14,4), (12,4) (em mm, com width/height em mm e viewBox 1:1); `display:none` num `g` oculta os filhos; `<use href="#a" x="10">` e `xlink:href`; `use` para id inexistente → aviso; `text` → aviso `text-ignored` com count; `fill="red"` sem stroke entra; `fill="none" stroke="none"` → `invisible-ignored`; stroke herdado do `g` conta; `metadata` ignorado; SVG sem traço → `SvgImportError` |
| `coords` | os casos da seção 3.2 |
| `document` | `importPlacement({120,120}, 385)` = T(0, 265); `duplicateDrawings` com offset (10,−10) na máquina; `translateMachine` com +Y na máquina dá −Y na cena; `setMachineBox` com x = 100, y = 50 leva o canto inferior esquerdo da caixa para (100,50); `setMachineBox` com width = 200 e keepRatio dobra também a altura; `setMachineRotation(90)` mantém o centro da caixa; `alignCenter` no A4 centraliza; nenhuma operação deixa det ≤ 0 |
| `history` | commit, undo, redo; o redo é descartado por um commit novo; limite de 100; coalesce dentro de 800 ms junta e depois de 800 ms não junta; commit sem mudança (mesma referência) não empilha |
| `store` | `commit` notifica assinantes com o prev; `undo` sem histórico não notifica; `replaceDocument` zera o histórico |
| `project` | ida e volta preserva geometria e transform (igualdade exata); `deserializeDocument` rejeita formato errado, versão 2 e transform com 5 números, com mensagens em português |
| `machine` | os testes atuais; `mergeProfile(undefined)` = DEFAULT; `mergeProfile` de perfil antigo (sem `dynamic`) preenche os padrões; chave desconhecida é ignorada; `validateProfile` acusa `feed.straight` acima de `maxRate`, `downCmd` com "$" e `upCmd` com "ç" |
| `job/strokes` | o quadrado do `teste_quadrado_circulo` em (0,0) sai com os vértices (10,110), (110,110), (110,10), (10,10), (10,110) |
| `job/bounds` | desenho em x = −0,004 passa (eps); em x = −0,1, violação com o id; em x = 810,004 passa; em y = 386, violação |
| `job/optimize` | os casos da seção 3.4 |
| `job/speed` | os casos da seção 3.5 |
| `job/estimate` | os casos da seção 3.6 |
| `job/gcode` | `formatCoord(−0.004)` = "0.00"; `formatCoord(12.345)` = "12.35"; `toAsciiComment("Coração — “teste” ★")` = `Coracao - "teste" ?`; F só aparece quando muda; o primeiro G1 tem F; traço `joinedToPrevious` não tem M5/M3 entre os dois; ponto = M3, G4, M5, G4; coordenada repetida depois de arredondar é omitida |
| `grbl/protocol` | `<Idle|MPos:-797.500,-345.000,0.000|FS:0,0|WCO:-810.000,-385.000,0.000>` → WPos (12,5, 40); `<Hold:0|...>` → Hold, subState 0; `<Alarm|...|Pn:XY>` → pins "XY"; `ok`; `error:9`; `ALARM:3`; banner; `[MSG:'$H'|'$X' to unlock]`; `$110=12000.000`; `[G54:-810.000,-385.000,0.000]`; `LineSplitter` com "o", "k\r\nerr", "or:2\n" dá ["ok", "error:2"] |
| `grbl/codes` | todos os erros 1–38 e alarmes 1–9 têm título; `describeAlarm(2).needsHoming` = true |
| `grbl/commands` | `jogRelative({10,0}, 3000)` = "$J=G91 G21 X10.00 Y0.00 F3000"; `clampToArea` com margem; `frameProgram` começa com M5 e só tem G0 dentro da área; `classifyManualCommand`: "$32=1" bloqueado, "$110=8000" pede confirmação, "G10 L2 P1 X0" pede confirmação, "$H", "?", "G0 X10" e "$$" passam, "G1 X10 ç" bloqueado |
| `grbl/streamer` | linhas de 20 bytes: as 6 primeiras cabem (6 × 21 = 126) e a 7ª não; depois de um `acknowledge`, cabe mais uma; `prepareLine("G1 X1 ; oi")` = "G1 X1"; `prepareLine("(a)")` = null; `prepareLine` lança com "ç" e com 71 caracteres; `clear` zera |

### 4.2 Testes golden (`src/import/golden.test.ts`, ambiente jsdom)

Cada golden importa o sample (`import svg from "../../samples/x.svg?raw"`), monta o documento com `importPlacement`, roda `planJob` + `generateGcode` com data fixa (`2026-11-14T12:00:00`) e compara com `expect(text).toMatchFileSnapshot("../../samples/golden/<nome>.gcode")`. Na primeira vez o arquivo é escrito. **Ele só vale depois de o Artur rodar na máquina e aprovar** (registrar em `docs/TESTES.md`). Mudou um golden? A explicação vai no commit.

Regras verificadas em **todos** os goldens, além do snapshot:
- todos os bytes < 0x80;
- nenhuma linha com mais de 70 caracteres;
- nenhum `(`;
- nenhum `$`;
- o primeiro `G1` tem `F`;
- todas as coordenadas dentro de 0..810 × 0..385;
- os comandos de caneta alternam (nunca M3 com a caneta abaixada);
- termina com `M5`, `G4 P0.3`, `G0 X0.00 Y0.00`.

**`teste_quadrado_circulo.dinamico.gcode`** (otimização **desligada**, modo dinâmico). O começo é exato:

```gcode
; Plotter Studio - teste_quadrado_circulo.svg - 2026-11-14 12:00
; modo: dinamico - reta F2000 / curva F1200 / fechada F600
G21
G90
G17
M5
G4 P0.3
G0 X10.00 Y110.00
M3 S220
G4 P0.3
G1 X110.00 Y110.00 F2000
G1 X110.00 Y10.00
G1 X10.00 Y10.00
G1 X10.00 Y110.00
M5
G4 P0.3
G0 X90.00 Y60.00
M3 S220
G4 P0.3
G1 X... Y... F600
```

Por quê:
- A página tem 120 mm e vai para y = 0..120. O rect do SVG começa em (10,10), que na máquina é (10, 120−10) = (10,110), e segue para a direita: o SVG desenha o rect no sentido horário na tela.
- O círculo começa em (cx+r, cy) = (90,60) e o primeiro ponto seguinte tem Y < 60: ele desce na tela, horário, como no SVG.
- O círculo tem **56 linhas G1**, todas a 30 ± 0,01 de (60,60). Fica tight porque R30 < 40.

Isso é "equivalente ao teste à mão de 07/11": mesmos cantos do quadrado, mesmo centro e raio do círculo. Se o Artur tiver o G-code de 07/11, ele vai para `samples/teste_0711_manual.gcode` e um teste confere os cantos e o centro.

**`teste_quadrado_circulo.otimizado.gcode`** (otimização ligada):
- o primeiro `G0` vai a X10.00 Y10.00 (o laço do quadrado foi girado);
- o segundo `G0` vai a X38.79 Y38.79 (o vértice do círculo em 225°);
- a viagem com a caneta levantada cai de **312,96 mm para 109,71 mm** (±0,05).

**`orientacao.fixo.gcode`** (F1000, sem otimização). Página de 100 × 80 mm, então `y_maquina = 80 − y_svg`. Coordenadas exigidas, nesta ordem:
- haste e barra de cima do "F": (10,10) → (10,70) → (40,70);
- barra do meio: (10,42) → (32,42).

A barra de cima tem Y maior que a do meio, as duas saem para +X a partir da haste e a haste sobe. Isso é um "F" legível visto da frente da máquina. A seta: (55,10) → (90,55) (sobe para a direita); pontas (90,55) → (72,53) e (90,55) → (87,37). Se este teste passar e o papel sair espelhado, o erro está na máquina (G54 ou fiação), não no software.

**`curvas.dinamico.gcode`** (modo dinâmico). Asserções por elemento, em coordenadas da máquina:
- a reta de y = 10 sai inteira a F2000;
- o quadrado de 50 mm, a F2000;
- o arco R50 (centro (140,20), passa por (140,70)), a F1200;
- os círculos R20 (centro (110,95)) e R5 (centro (160,85)), a F600;
- a espiral é verificada só pelo snapshot. O último trecho tem R40 exatamente na fronteira e pode cair em qualquer das duas faixas.

### 4.3 Simulador de GRBL (`FakeGrbl`)

O `FakeGrbl` implementa `Transport` e roda com `ManualClock`, de forma totalmente determinística. Ele modela o que importa para o envio:

- **Abertura:** "reinicia" e, depois de `bootDelayMs`, manda o banner e `[MSG:'$H'|'$X' to unlock]`. O estado começa em `Alarm`.
- **Buffer de recepção de 128 bytes.** Se o envio passar disso, `rxOverflow = true`. Esse é o teste principal da contagem de caracteres.
- **Leitura de linhas:** só quando o planejador (15 blocos) tem vaga. O `ok` sai nesse momento.
- **Sincronização:** `M3`, `M5` e `G4` esperam o planejador esvaziar, como no GRBL. `G4` também espera P segundos.
- **Movimento:** velocidade constante igual a F, ou 12000 mm/min no G0, sem aceleração. Basta para a ordem e o tempo.
- **Tempo real:**
  - `?` responde com o relatório (WCO a cada 10 relatórios, como no GRBL);
  - `!` vai para `Hold:1` e, 100 ms depois, `Hold:0`;
  - `~` retoma;
  - `0x18`: se andando, gera `ALARM:3`; se `Hold:0`/`Idle`, mantém a posição; nos dois casos, banner novo;
  - `0x85` cancela o jog;
  - `0x9E` em `Hold` levanta ou baixa a caneta (se `spindleStopInHold`);
  - `0x90`–`0x94` alteram o override.
- **Comandos:**
  - `$H` (fica `homingMs` em `Home` e termina em `Idle` com WPos = (810, 385));
  - `$X`;
  - `$$` (lista coerente com o CLAUDE.md);
  - `$#`;
  - `$J=` (com soft limit → `error:15`);
  - G-code em alarme → `error:9`;
  - destino fora da área → `ALARM:2`;
  - G1 sem F nunca definido → `error:22`.
- **Falhas injetáveis:** `error:N` na linha k; desconexão depois de k linhas (dispara `onClose({reason: "lost"})`); sem banner.
- **Inspeção:** `penStrokes` (o que a caneta desenhou), `maxRxUsed`, `state`, `wpos`, `penDown`.

**Testes do envio com o `FakeGrbl`** (`controller.test.ts`):

1. Conectar: chega em `connected` com `Alarm`; `homed = false`; `startJob` recusa com "Faça o Home".
2. Banner ausente: depois de 5 s, envia 0x18; sem resposta em mais 3 s, erro.
3. `$H`: `homed = true`, `Idle`, WPos (810,385).
4. Trabalho completo com o G-code de `orientacao`:
   - `penStrokes` é igual aos traços do plano (±0,01);
   - `rxOverflow = false`;
   - `maxRxUsed ≤ 127`;
   - estado `finished`.
5. Estresse: 10 mil segmentos de 0,2 mm, sem estouro; ordem dos `ok` preservada.
6. `error:20` injetado na linha 30: `!` sai antes de qualquer outra linha nova e o trabalho fica `paused` com o erro da linha 30.
7. Pausa "agora" no meio de um traço: a sequência de bytes é `!`, (espera `Hold:0`), `0x9E`. Durante a pausa, `penDown = false`. Ao continuar, `0x9E` e `~` só depois de 500 ms, e nada é desenhado entre a pausa e a volta da caneta.
8. Pausa "no fim do traço": a caneta não para no meio de um traço; ao pausar, o estado é `Idle` com a caneta em cima.
9. Parar: termina `stopped` sem `ALARM`; `homed` continua `true`; `penDown = false`; WPos igual à do momento da parada.
10. Parada de emergência andando: `ALARM:3`, `homed = false`.
11. Cabo desconectado na linha 200: o estado vai para `lost`/`failed` em menos de 100 ms (no relógio virtual); nenhuma promessa fica pendurada (`await` do `startJob`/`send` resolve ou rejeita).
12. Banner inesperado no meio do trabalho: `failed` com "a placa reiniciou".
13. `$$` com `$32=1` simulado: `settingsWarnings` contém o aviso.
14. Jog contínuo: `jogContinuous` + `jogStop` envia `$J=` e depois `0x85`; a posição para entre o início e a borda.

O simulador também fica disponível **na interface** com `?sim=1` na URL, usando o relógio real. Serve para desenvolver a v2 sem a máquina e para o Artur ensaiar.

### 4.4 Roteiro de testes manuais na máquina

Registre cada resultado em `docs/TESTES.md` (data, tarefa, passou/falhou, observação).

**Fase v1** (o envio continua pelo LaserGRBL):

1. **Escala:**
   - exporte `teste_quadrado_circulo.svg` em (0,0) e desenhe;
   - o quadrado tem que medir 100,0 ± 0,3 mm e o círculo 60 ± 0,3 mm de diâmetro (régua ou paquímetro);
   - em seguida, desenhe no Inkscape um quadrado de 100 × 100 mm, salve como SVG, importe e desenhe; ele também tem que medir 100 mm.
2. **Orientação:** coloque `orientacao.svg` perto de (100,100), tire uma foto da tela, desenhe e compare com o papel visto da frente. O "F" tem que estar legível e a seta apontando para cima e para a direita.
3. **Área:** arraste um desenho até sair pela direita. O contorno fica vermelho, "Exportar" desabilita e a mensagem diz quanto saiu. Ao trazer de volta, tudo volta ao normal.
4. **Velocidade dinâmica (calibração):**
   - desenhe `curvas.svg` no modo dinâmico e depois no modo fixo F2000;
   - compare R50, R20, R5 e a espiral;
   - se houver ondulação no dinâmico, baixe a faixa correspondente nas Configurações e repita;
   - anote os valores finais.
5. **Buffer:** gere `samples/estresse.svg` (`node scripts/make-stress-svg.mjs`) e desenhe com o LaserGRBL. Escute: a máquina não pode "gaguejar" (parar e voltar em trechos densos). Se gaguejar, aumente `minSegmentTimeMs` (10 → 15).
6. **Tempo:** cronometre um desenho de 5–15 min. O real tem que ficar a ±10% da estimativa.
7. **Gabaritos:** desenhe um retângulo exatamente no gabarito A4 do perfil e compare com a marcação na madeira. Corrija `paperTemplates` nas Configurações se precisar.
8. **LaserGRBL:** todos os `.gcode` exportados abrem e rodam sem erro.

**Fase v2** (sem LaserGRBL):

1. Conectar: banner, `Alarm`, Home, `Idle`. A posição mostrada bate com a caneta (atrás à direita, perto de 810/385).
2. Jog: a seta ↑ da tela afasta a caneta do operador; → vai para a direita. Testar passo de 1 mm e contínuo (soltar a tecla para no ato).
3. Caneta ↑/↓: o servo responde.
4. Contorno: o retângulo percorrido com a caneta em cima envolve o papel/desenho como na tela.
5. Enviar `orientacao.svg`: a barra de progresso anda, a linha atual acompanha a caneta e no fim a máquina volta a (0,0).
6. Pausa no meio de um traço: a caneta **sobe**? (Esse é o teste do `0x9E` no fork do servo.) Continuar: a caneta desce **antes** de andar, sem falha no traço. Se não subir, mude `pen.pauseLift` para "Pausar no fim do traço" e repita.
7. Parar no meio: a caneta sobe, sem alarme; "Ir para a origem" vai ao lugar certo sem refazer o Home.
8. Parada de emergência: aparece o alarme e o software exige Home.
9. Puxar o USB no meio: a interface avisa em até 1 s e não trava. Ao reconectar: banner, `Alarm`, Home.
10. Velocidade +10%/−10% durante o desenho: o "Ov" no painel muda.
11. Console: mandar `G1 X10 (a (b))` → `error:1` traduzido. Mandar `$110=12000` → confirmação aparece (cancele).
12. Aba em segundo plano ou janela minimizada por 5 min durante o trabalho: o desenho continua sem parar.
13. Ao fim de um trabalho longo, comparar o tempo real (registrado) com a estimativa.

---

## 5. Plano de execução

Formato: **Objetivo · Arquivos · Depende de · Pronto quando · Você testa** (o que o Artur faz com as mãos).

### v1 — compor e exportar G-code

**T01 — Fundação** — ✅ concluída em 14/11/2026
- **Objetivo:** deixar o projeto em pé no Windows e no GitHub.
- **Arquivos:**
  - `scripts/vitest.mjs` (relança o Vitest com a letra do drive maiúscula; código abaixo);
  - `package.json` (`"test": "node scripts/vitest.mjs run"`, `"test:watch": "node scripts/vitest.mjs"`, devDependency `jsdom@26.1.0`);
  - `.github/workflows/deploy.yml` (mover de `docs/deploy-pages.yml`, sem a linha "MOVER este arquivo");
  - `vite.config.ts` (`/// <reference types="vitest/config" />` no topo);
  - `docs/TESTES.md` (modelo);
  - `.gitignore` (já existe);
  - `git init` e primeiro commit.
  ```js
  // scripts/vitest.mjs — no Windows, um cwd com o drive minúsculo (terminal do VS Code: c:\...)
  // faz o Vitest 5 carregar o próprio módulo duas vezes e o describe() falha com "reading 'config'".
  // Este script relança o Vitest com C:\ maiúsculo. Rever ao atualizar o Vitest.
  import { spawnSync } from "node:child_process";
  import { resolve } from "node:path";
  const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
  const bin = resolve(cwd, "node_modules/vitest/vitest.mjs");
  const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
  process.exit(r.status ?? 1);
  ```
- **Depende de:** nada.
- **Pronto quando:**
  - `npm test` passa a partir do terminal do VS Code (`c:` minúsculo) e do PowerShell;
  - um teste falhando faz o `npm test` sair com código ≠ 0;
  - `npm run build` passa;
  - `npm run dev` abre a mesa no Chrome a partir do terminal do VS Code (conferir que o drive minúsculo não quebra o dev server também; se quebrar, aplicar o mesmo wrapper ao `vite`);
  - existe um repositório git com o primeiro commit.
- **Você testa:** rodar `npm test` no terminal do VS Code. Criar o repositório no GitHub, dar push e, em Settings → Pages → Source, escolher "GitHub Actions". Abrir a URL do Pages.

**T02 — Geometria** — ✅ concluída em 14/11/2026
- **Objetivo:** a base matemática pura.
- **Arquivos:** `core/geometry/{vec,mat2d,path,flatten}.ts` + testes.
- **Depende de:** T01.
- **Pronto quando:** os testes de `mat2d`, `path` e `flatten` da seção 4.1 passam, inclusive "círculo R30 = 56 segmentos" e "tolerância depois da escala".
- **Você testa:** nada na máquina; ler os nomes dos testes e ver se fazem sentido.

**T03 — Simplificação** — ✅ concluída em 14/11/2026
- **Objetivo:** RDP, fusão de segmentos curtos e pontos.
- **Arquivos:** `core/geometry/simplify.ts` + testes.
- **Depende de:** T02.
- **Pronto quando:** os casos da seção 3.3 passam.
- **Você testa:** nada.

**T04 — Parser SVG, parte 1** — ✅ concluída em 14/11/2026
- **Objetivo:** unidades, viewBox, transforms, path data e arcos.
- **Arquivos:** `core/svg/{node,units,transform,pathData,arc}.ts` + testes.
- **Depende de:** T02.
- **Pronto quando:** todos os casos de `units`, `transform`, `pathData` e `arc` da seção 4.1 passam.
- **Você testa:** nada.

**T05 — Importador SVG, parte 2** — ✅ concluída em 14/11/2026
- **Objetivo:** formas, percurso da árvore e `importSvgTree`; adaptador DOM.
- **Arquivos:** `core/svg/{shapes,importSvg}.ts`, `import/svgDom.ts`, `import/golden.test.ts` (só a parte de importação: os 3 samples importam com a página e a contagem de subpaths esperadas, sem avisos indevidos). Testes.
- **Depende de:** T04.
- **Pronto quando:**
  - os casos de `shapes` e `importSvg` passam;
  - `teste_quadrado_circulo` dá página de 120 × 120 mm e 2 subpaths;
  - `orientacao` dá 100 × 80 mm e 6 subpaths ("F" = 2, seta = 3, retângulo = 1);
  - `curvas` dá 300 × 120 mm e 6 subpaths (o `M250 55` solto antes do `m2 0` da espiral é descartado).
- **Você testa:** abrir 2 ou 3 SVGs seus do Inkscape com a função de importar (via teste temporário ou console) e conferir as dimensões.

**T06 — Documento, coordenadas e histórico** — ✅ concluída em 14/11/2026
- **Objetivo:** o modelo da aplicação.
- **Arquivos:** `core/{coords,document,history,store,project}.ts` + testes; `core/machine.ts` (perfil ampliado da seção 2.4 + `mergeProfile`/`validateProfile`; **os valores atuais não mudam**, só entram campos novos).
- **Depende de:** T02, T05.
- **Pronto quando:** os casos de `coords`, `document`, `history`, `store`, `project` e `machine` passam; o teste de orientação no nível de documento (pontos do "F" na máquina) passa.
- **Você testa:** nada.

**T07 — Canvas em mm** — ✅ concluída em 14/11/2026
- **Objetivo:** a nova mesa e a navegação.
- **Arquivos:**
  - `ui/{dom,layout,board,viewport,statusBar}.ts`;
  - `main.ts`, `index.html`, `style.css`;
  - remover `makeMapper` (a cena agora é em mm).
- **Detalhes:**
  - mesa no `before:render`, só quando `ctx === canvas.getContext()` (o canvas de baixo; o de cima também dispara `after:render`, mas não `before:render`), com `ctx.save(); ctx.transform(...vpt); …; ctx.restore()`;
  - grade de 10 mm só quando z·10 ≥ 4 px;
  - linhas com `lineWidth = 1/z`;
  - canvas redimensionado com `ResizeObserver` + `canvas.setDimensions`.
- **Depende de:** T06.
- **Pronto quando:**
  - zoom com a roda centrado no cursor;
  - pan com espaço + arrastar e com o botão do meio;
  - botão "Ajustar à tela";
  - o rodapé mostra X/Y da máquina: o canto da frente à esquerda dá (0,0) e o de trás à direita (810,385);
  - a grade fica fina em qualquer zoom.
- **Você testa:** passear com o mouse pelos cantos e conferir as coordenadas; dar zoom até ver a grade de 10 mm.

**T08 — Desenhos no canvas** — ✅ concluída em 14/11/2026
- **Objetivo:** importar e manipular desenhos.
- **Arquivos:**
  - `ui/{drawingObject,canvasView}.ts`;
  - botão "Importar SVG";
  - arrastar e soltar arquivo na janela;
  - avisos de importação (toast);
  - contorno vermelho fora da área (`machineBBox` vs. área, no `object:modified`; durante o arraste, aproximado pelo `getBoundingRect`).
- **Detalhes:** `object:modified` → para cada objeto de `canvas.getActiveObjects()`: `modelMatrixFromFabric(obj.calcTransformMatrix(), localBBox)` → um `commit` com rótulo "Mover", "Girar" ou "Redimensionar" (pelo `transform.action`). Seleção do Fabric → `store.setSelection`. `lockScalingFlip: true`.
- **Depende de:** T07.
- **Pronto quando:**
  - os 3 samples importam e aparecem com o canto inferior esquerdo da página em (0,0);
  - arrastar, girar e escalar funcionam, inclusive com 2 desenhos selecionados juntos;
  - depois de mover, o modelo (ver no console: `store.doc`) tem a matriz nova;
  - com o desenho fora da área, o contorno fica vermelho.
- **Você testa:** importar os 3 samples e um SVG seu; mexer à vontade; selecionar dois e girar juntos; ver que nada "pula" de lugar ao soltar.

**T09 — Propriedades, atalhos, alinhar, desfazer** — ✅ concluída em 14/11/2026
- **Objetivo:** o fluxo completo de edição.
- **Arquivos:** `ui/panels/propertiesPanel.ts`, `ui/shortcuts.ts`, botões de desfazer/refazer.
- **Detalhes do painel:**
  - X, Y = canto inferior esquerdo da caixa na máquina; largura e altura da caixa; rotação; travar proporção;
  - com rotação fora de múltiplos de 90°, a proporção fica sempre travada (escalar uma caixa girada sem proporção distorceria o desenho);
  - com vários selecionados, só X/Y.
- **Atalhos** (ignorados quando o foco está num campo):
  - Delete;
  - Ctrl+D duplica com offset (+10, −10);
  - setas: 1 mm, Shift = 10 mm, coalesce "nudge";
  - Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z.
- **Alinhar:** centralizar na mesa, no A4, no A3.
- **Depende de:** T08.
- **Pronto quando:** cada campo e cada atalho funciona e é desfazível; 10 toques de seta viram uma entrada só no histórico; desfazer com 2 objetos selecionados não os desloca.
- **Você testa:** digitar X = 100, Y = 50 e conferir no rodapé o canto do desenho; girar 90°; Ctrl+Z várias vezes até o começo e Ctrl+Y até o fim.

**T10 — Persistência** — ✅ concluída em 14/11/2026
- **Objetivo:** perfil e sessão salvos.
- **Arquivos:** `storage/{kv,profileStore,sessionStore}.ts` + testes (`mergeProfile`/(de)serialização já testados no core; aqui só o fluxo).
- **Depende de:** T06, T08.
- **Pronto quando:** recarregar a página (F5) mantém os desenhos e as posições; o rodapé mostra "Sessão restaurada (N desenhos)"; um perfil corrompido no `localStorage` volta ao padrão com aviso.
- **Você testa:** montar uma mesa com 3 desenhos, fechar o Chrome, abrir de novo.

**T11 — Traços, área e ordem** — ✅ concluída em 14/11/2026
- **Objetivo:** do documento à lista ordenada de traços.
- **Arquivos:** `core/job/{types,strokes,bounds,optimize}.ts` + testes.
- **Depende de:** T03, T06.
- **Pronto quando:** os casos das seções 3.3, 3.4, `strokes` e `bounds` passam, inclusive desempenho com 20 mil traços em < 1 s.
- **Você testa:** nada.

**T12 — Velocidade dinâmica e estimativa** — ✅ concluída em 14/11/2026
- **Arquivos:** `core/job/{speed,estimate}.ts` + testes.
- **Depende de:** T11.
- **Pronto quando:** os casos das seções 3.5 e 3.6 passam.
- **Você testa:** ler a tabela de limiares da seção 3.5 e dizer se concorda com os padrões. (Não é bloqueante: eles são editáveis.)

**T13 — G-code e goldens** — ✅ concluída em 14/11/2026 (goldens gerados; falta o Artur aprovar na máquina)
- **Arquivos:**
  - `core/job/{gcode,pipeline}.ts` + testes;
  - `import/golden.test.ts` completo;
  - `samples/golden/*.gcode` (gerados).
- **Depende de:** T05, T12.
- **Pronto quando:** os testes de `gcode` e os 4 goldens da seção 4.2 passam (com as regras gerais), e o começo exato do golden do quadrado bate.
- **Você testa:** abrir os `.gcode` de `samples/golden/` no LaserGRBL, conferir a pré-visualização e rodar o do quadrado e o da orientação na máquina. Se aprovar, registrar em `docs/TESTES.md`. A partir daí os goldens valem.

**T14 — Painel do trabalho e exportar** — ✅ concluída em 14/11/2026
- **Arquivos:** `ui/panels/jobPanel.ts`; `planJob` com debounce de 300 ms ligado ao store.
- **Detalhes:**
  - modo fixo, com atalhos F500/F1000/F1500/F2000, ou dinâmico;
  - otimização liga/desliga;
  - distâncias desenhada e de deslocamento, economia ("−203 mm de deslocamento"), levantadas de caneta, tempo estimado;
  - lista de problemas (fora da área);
  - "Exportar .gcode" gera `<nome>.gcode` (nome do primeiro desenho, ou "plotter"), desabilitado com violações, com a mensagem do porquê.
- **Depende de:** T09, T13.
- **Pronto quando:** exportar baixa um arquivo idêntico ao golden quando a mesa tem só o sample na origem; com desenho fora da área o botão fica bloqueado e explica.
- **Você testa:** testes manuais v1 1, 2, 3 e 8 (seção 4.4).

**T15 — Pré-visualização do caminho** — ✅ concluída em 14/11/2026
- **Arquivos:** `ui/overlay.ts`; toggle "Mostrar caminho"; botão play/pausa; velocidade ×1, ×5, ×20, ×50.
- **Detalhes:**
  - canvas absoluto sobre o Fabric, `pointer-events: none`, redesenhado no `after:render` do canvas de baixo e quando o plano muda;
  - traços coloridos por classe (verde = reta, laranja = curva, vermelho = fechada) ou numa cor só no modo fixo;
  - deslocamentos tracejados;
  - a animação desenha o caminho até o tempo t, usando `strokeStartTimesS` e incremental num canvas fora da tela.
- **Depende de:** T14.
- **Pronto quando:** a pré-visualização acompanha zoom/pan sem atraso, e o "play" mostra a ordem real de desenho de `curvas.svg`.
- **Você testa:** ver se a ordem do "play" bate com a ordem em que a máquina desenha (comparar com o teste 4 da v1).

**T16 — Configurações** — ✅ concluída em 14/11/2026
- **Arquivos:** `ui/panels/settingsDialog.ts`.
- **Detalhes:**
  - todos os campos do perfil, em grupos (Área, Caneta, Velocidades, Velocidade dinâmica, Tolerâncias, Movimento, G-code, Gabaritos), cada um com uma frase de ajuda;
  - validação com `validateProfile` (os erros aparecem ao lado do campo);
  - restaurar padrão;
  - exportar/importar JSON.
- **Depende de:** T10.
- **Pronto quando:** mudar `feed.curve` reflete no próximo plano; um JSON exportado e reimportado dá o mesmo perfil; um campo inválido impede salvar.
- **Você testa:** exportar o perfil como backup; mudar um valor e restaurar o padrão.

**T17 — Aceite da v1** — 🟡 parte de software concluída em 14/11/2026; falta o roteiro na máquina (`docs/TESTES.md`)
- **Objetivo:** fechar a v1 na máquina.
- **Arquivos:**
  - `scripts/make-stress-svg.mjs` (20 mil traços pequenos e curvas densas, determinístico);
  - correções que aparecerem;
  - `README.md` (status);
  - deploy.
- **Depende de:** T14, T15, T16.
- **Pronto quando:**
  - todos os critérios de aceite da v1 do SPEC.md marcados;
  - mesa com `estresse.svg` arrasta a ≥ 30 fps no notebook do Artur (medir com o painel Performance do Chrome);
  - `planJob` do estresse < 500 ms;
  - o site no GitHub Pages funciona.
- **Você testa:** roteiro v1 completo (seção 4.4), principalmente os testes 4, 5 e 6, que calibram os limiares, o `minSegmentTimeMs` e a estimativa.

### v2 — enviar direto para a máquina

**T18 — Protocolo GRBL puro** — ✅ concluída em 14/11/2026
- **Arquivos:** `core/grbl/{protocol,codes,commands}.ts` + testes. Os textos de erro e alarme vêm da lista oficial do gnea/grbl (`doc/csv/error_codes_en_US.csv` e `alarm_codes_en_US.csv`), traduzidos, com a "ação" para os mais comuns (tabela do GRBL.md).
- **Depende de:** T01.
- **Pronto quando:** os casos de `protocol`, `codes` e `commands` da seção 4.1 passam.
- **Você testa:** nada.

**T19 — Contagem de caracteres e simulador** — ✅ concluída em 14/11/2026
- **Arquivos:** `core/grbl/{streamer,clock,transport,fakeGrbl}.ts` + testes.
- **Depende de:** T18.
- **Pronto quando:** os testes de `streamer` passam; o `FakeGrbl` executa um programa enviado à mão pelo streamer (sem controller) sem `rxOverflow` e com `penStrokes` correto.
- **Você testa:** nada.

**T20 — GrblController**
- **Arquivos:** `core/grbl/controller.ts` + `controller.test.ts` (os 14 cenários da seção 4.3).
- **Depende de:** T19, T13 (usa `GcodeProgram`).
- **Pronto quando:** os 14 cenários passam, sem `setTimeout` real em teste nenhum.
- **Você testa:** nada.

**T21 — Transporte Web Serial**
- **Arquivos:** `serial/{web-serial.d.ts,webSerialTransport.ts}`; botão Conectar/Desconectar na barra superior; `?sim=1` troca o transporte pelo `FakeGrbl`.
- **Detalhes:**
  - `navigator.serial.requestPort()` só com clique;
  - se `getPorts()` já tiver a porta salva (vendor/product), o botão vira "Conectar (Arduino Uno)" e não abre o seletor;
  - `open({ baudRate: 115200 })`;
  - laço de `reader.read()`;
  - um único `writer`, com escritas serializadas;
  - fechar na ordem `reader.cancel()` → `releaseLock()` → `writer.releaseLock()` → `port.close()`;
  - evento `disconnect` → `onClose("lost")`;
  - erro de abertura `NetworkError`/"Failed to open" → "A porta está em uso por outro programa (LaserGRBL? Monitor serial do Arduino?)";
  - `import.meta.hot.dispose` fecha a porta (sem isso, um hot reload deixa a porta presa);
  - fora do Chrome/Edge: o botão some e aparece um aviso.
- **Depende de:** T20.
- **Pronto quando:** conecta no simulador (`?sim=1`) e na máquina; o log mostra o banner; desconectar e reconectar funciona sem recarregar a página.
- **Você testa:** conectar na máquina (COM6, com o LaserGRBL **fechado**); depois tentar com o LaserGRBL aberto e ver a mensagem de porta em uso.

**T22 — Painel da máquina**
- **Arquivos:** `ui/panels/machinePanel.ts`; posição da máquina no `Overlay`.
- **Detalhes:**
  - estado em cores (Idle verde, Run azul, Hold amarelo, Alarm vermelho);
  - WPos X/Y, F atual, Ov, fins de curso (`Pn`);
  - botões Home, Desbloquear (com o aviso de que desenhar exige Home), Ir para a origem, Caneta ↑/↓ (desabilitados em Alarm) e Reset;
  - avisos de configuração (`settingsWarnings`);
  - o cursor da máquina na mesa (cruz + círculo).
- **Depende de:** T21, T15.
- **Pronto quando:** tudo funciona no simulador, e os botões ficam desabilitados nos estados em que o GRBL recusaria o comando.
- **Você testa:** testes manuais v2 1 e 3.

**T23 — Jog**
- **Arquivos:** `ui/panels/jogPanel.ts`, extensão de `ui/shortcuts.ts`.
- **Detalhes:**
  - setas na tela (8 direções) e no teclado (com o foco no canvas, fora dos campos);
  - passo 0,1 / 1 / 10 / 50 mm ou "contínuo";
  - F do jog;
  - `0x85` no `keyup`, `blur` e `visibilitychange`.
  - Atenção: com a aba "Máquina" ativa e conectado, as setas fazem jog; senão, movem o desenho (como na T09). O rodapé mostra qual modo está valendo.
- **Depende de:** T22.
- **Pronto quando:** no simulador, o jog contínuo para ao soltar a tecla; o passo não sai da área.
- **Você testa:** teste manual v2 2.

**T24 — Console**
- **Arquivos:** `ui/panels/consolePanel.ts`.
- **Detalhes:**
  - log com filtro (relatórios de estado escondidos por padrão);
  - campo de comando com histórico (↑/↓);
  - `classifyManualCommand` (bloqueio e confirmação);
  - `error:N` e `ALARM:N` aparecem traduzidos ao lado do código.
- **Depende de:** T22.
- **Pronto quando:** `$32=1` é recusado; `$110=...` pede confirmação; `$$` lista as configurações.
- **Você testa:** teste manual v2 11.

**T25 — Enviar trabalho**
- **Arquivos:** `ui/panels/sendPanel.ts`.
- **Detalhes:**
  - Contorno (`frame`);
  - Enviar (pré-condições da seção 3.7 com mensagens);
  - barra de progresso, tempo decorrido e restante;
  - linha atual destacada na pré-visualização;
  - Wake Lock e `beforeunload`;
  - ao terminar, registrar o tempo real vs. estimado em `localStorage` (`plotter-studio:runs`, últimos 20) e mostrar no painel.
- **Depende de:** T22, T14.
- **Pronto quando:** no simulador, um trabalho completo de `curvas.svg` termina `finished`, com o destaque acompanhando.
- **Você testa:** testes manuais v2 4 e 5.

**T26 — Pausa, parada, override e falhas**
- **Arquivos:** `sendPanel.ts`, `controller.ts` (se faltar algo).
- **Detalhes:**
  - Pausar (o modo vem do perfil, `pen.pauseLift`), Continuar, Parar e Parada de emergência (botão vermelho, com Esc como atalho);
  - feed override (+10, −10, 100%);
  - diálogo de erro no meio do trabalho;
  - tela de "conexão perdida".
- **Depende de:** T25.
- **Pronto quando:** os cenários 6 a 12 da seção 4.3 passam e funcionam na UI com o simulador (incluindo `spindleStopInHold: false`).
- **Você testa:** testes manuais v2 6 a 10 e 12. **Decida o padrão de `pen.pauseLift`** pelo resultado do teste 6.

**T27 — Aceite da v2**
- **Arquivos:** correções; `README.md`; `docs/GRBL.md` (atualizar com o que se aprendeu, por exemplo o comportamento do `0x9E` no fork); deploy.
- **Depende de:** T23, T24, T26.
- **Pronto quando:** todos os critérios de aceite da v2 do SPEC.md marcados, e roteiro v2 completo registrado em `docs/TESTES.md`.
- **Você testa:** um desenho real de 15+ minutos do começo ao fim sem LaserGRBL.

### v3 — visão geral (ordem a decidir com o Artur)

- **Salvar/abrir projeto:** o `ProjectFileV1` já existe. É um botão de download/upload, mais "Abrir recentes" a partir do IndexedDB. Sessão pequena.
- **Retomar a partir do traço N:** depois de uma falha, gerar o programa a partir do traço N, com Home antes. O plano já tem os índices de traço por linha.
- **Texto com fonte Hershey:** a fonte vira `Geometry` (é traço único). É um `Drawing` como outro qualquer, com o texto editável guardado em `Drawing.source`.
- **Hachura:** o polígono vem dos subpaths fechados; linhas paralelas com ângulo e espaçamento, recortadas por par/ímpar. Entra como opção por desenho e gera traços extras no `documentToStrokes`.
- **Várias cores:** `Drawing.layer` (pela cor do stroke ou pela camada do Inkscape na importação), plano por camada, `M5`, ir para a posição de troca, pausa "troque a caneta" (na v2 é um `pause` com mensagem; no `.gcode` exportado, `M0`, que o GRBL suporta).
- **Imagem → linhas:** contorno por limiar ou hachura por tom de cinza, num Web Worker.
- **Também:** 2-opt opcional; abrir e enviar um `.gcode` externo (com checagem de área por parser simples de G0/G1); modo de velocidade contínuo (`F = 60·√(a_lat·R)`, se os testes da v1 confirmarem a hipótese da aceleração lateral); PWA/offline (service worker) para usar sem internet; `planJob` em Web Worker se o estresse pedir.

---

## 6. Riscos e armadilhas

| Risco | Como aparece | Como evitar |
|---|---|---|
| **Escala errada** | O quadrado de 100 mm sai com 75 mm ou 133 mm | Cena em mm (sem `pxPerMm`); unidades testadas caso a caso (4.1); aviso `size-in-px` para SVGs em px; teste manual 1 da v1 com régua. O Illustrator (72 dpi) é o suspeito número 1. |
| **Desenho espelhado ou de cabeça para baixo** | O "F" sai ao contrário | Uma única inversão de Y (`sceneToMachineMatrix`); golden de `orientacao` com coordenadas exatas; `lockScalingFlip`; teste de det > 0. Se o golden passa e o papel sai espelhado, o problema é G54 ou fiação, não o software. |
| **Bytes UTF-8 no G-code viram comandos em tempo real** | Velocidade cai 1% ou o servo muda de posição "do nada" ao rodar um arquivo com acento ou travessão no nome | `toAsciiComment`; teste golden de todos os bytes < 0x80; `prepareLine` recusa não-ASCII; o console bloqueia. |
| **`npm test` quebrado no terminal do VS Code** | `Cannot read properties of undefined (reading 'config')` | `scripts/vitest.mjs` (T01). Rever ao atualizar o Vitest; quando corrigirem, remover. |
| **Web Serial no Windows** | Seletor vazio, "Failed to open", porta presa | Driver do Uno/CH340 instalado (se o LaserGRBL conecta, está ok); **fechar o LaserGRBL e o monitor serial do Arduino** antes de conectar (mensagem específica para porta em uso); só Chrome/Edge (aviso nos outros); `import.meta.hot.dispose` fecha a porta no hot reload; a Web Serial não mostra "COM6" (só vendor/product), então a porta é lembrada por esse id. |
| **O Uno reinicia ao conectar** | Toda conexão gera `ALARM` e exige Home; reconectar no meio de um desenho mata o trabalho | É esperado (DTR). O software espera o banner (5 s, com 0x18 de reserva), nunca reconecta sozinho e trata banner inesperado como "a placa reiniciou". |
| **Desempenho do canvas** | Arrastar trava com SVGs de 100 mil segmentos | `Path2D` criado uma vez por geometria; `objectCaching` ligado; a mesa fora dos objetos do Fabric; pré-visualização incremental num canvas separado; `estresse.svg` medido na T17. Se não bastar, simplificar o `Path2D` de exibição pela escala da tela (só a vista; o G-code continua com tolerância cheia). |
| **Gagueira por falta de linhas no buffer** | A máquina para e volta em trechos densos | RDP, fusão < 0,1 mm, teto de vazão (`minSegmentTimeMs`), teste manual 5 da v1. |
| **`ok` demorado parece travamento** | Timeout falso numa reta longa e lenta | Sem timeout de `ok`; saúde medida pelo relatório de estado. |
| **`error:N` no meio: o GRBL continua o buffer** | Mais 15 movimentos depois do erro | `!` imediato ao receber `error:N` durante o trabalho. |
| **Arredondamento na borda** | Coordenada 810,004 vira `ALARM:2` | `checkBounds` com eps de 0,005 e corte em [0, W] depois de arredondar; `formatCoord` sem "-0.00". |
| **Seleção múltipla do Fabric** | Desenhos "pulam" de lugar ao desfazer ou ao editar no painel com 2 selecionados | Ler `calcTransformMatrix()` (inclui o grupo); em `sync`, desfazer e recriar a `ActiveSelection`; teste manual da T09. |
| **Origem no centro (Fabric 7)** | Objeto posicionado meio desenho fora | `fabricMatrixFromModel` com o centro da `localBBox`, testado em ida e volta. |
| **Aba em segundo plano ou PC dormindo** | Status lento; PC hiberna e derruba a USB no meio | O envio é guiado pelos eventos de leitura (não por timers); Wake Lock durante o trabalho; aviso para desligar a suspensão do Windows em desenhos longos. |
| **`0x9E` não levanta a caneta no fork do servo** | A caneta fica no papel durante a pausa | Modo alternativo "pausar no fim do traço", testado no simulador com `spindleStopInHold: false`; a decisão sai do teste manual. |
| **Cabo solto com a placa ainda alimentada** | A placa termina ~15 movimentos e para com a caneta possivelmente abaixada | Não há como enviar nada; a mensagem explica; a reconexão reinicia o Uno (M5) e exige Home. Nenhuma promessa fica pendurada na UI. |
| **Hipótese de v²/R errada** | Ondulação mesmo dentro das faixas | Limiares e F configuráveis; teste manual 4 da v1 calibra; a seção 3.5 documenta a hipótese. |
| **Sem internet** | O site do GitHub Pages não abre | `npm run dev` local funciona igual (localhost é contexto seguro). PWA na v3. |
| **TypeScript 7 (compilador nativo novo)** | Erros de tipo estranhos ou ausência de libs (como a da Web Serial) | Tipos próprios onde faltar; se o `tsc` 7 falhar em algo legítimo, registrar na seção 7 e fixar o TypeScript 5.x como alternativa. |
| **jsdom indireto** | Some numa atualização do Fabric e os goldens quebram | devDependency explícita (T01). |

---

## 7. Decisões que tomei sem te consultar

| # | Decisão | Alternativa | Por que escolhi esta |
|---|---|---|---|
| 1 | O modelo guarda retas + cúbicas | Polilinhas (como estava) | Tolerância correta em qualquer escala |
| 2 | Parser de SVG próprio, puro | `getPointAtLength`, `loadSVGFromString` do Fabric, biblioteca `svg-pathdata` | Testável sem navegador, controle de unidades e tolerância, sem prender o core ao Fabric |
| 3 | Arcos viram cúbicas ≤ 45° na importação | Guardar arcos como tipo próprio | Um tipo de curva a menos; erro de 0,004 mm por metro de raio |
| 4 | Cena do Fabric em mm | Cena em px | Elimina conversões e erros de escala |
| 5 | Mesa no `before:render` + canvas de sobreposição | Objetos do Fabric (como estava) ou 3 canvases empilhados | Grade fina em qualquer zoom e sincronização automática com o zoom; um canvas a menos que a ideia inicial |
| 6 | Canto vivo não ganha F; quem freia é o GRBL ($11) | Canto vivo = `tightCurve` (CLAUDE.md antigo) | Pela fórmula, o GRBL já freia mais que o `tightCurve` em cantos ≥ 45°; a regra antiga deixava lados retos inteiros devagar |
| 7 | Limiares R100 / R40 | R100 / R10 (minha primeira proposta) | Os dados de 13/11 em v²/R indicam que F1200 só é seguro a partir de ~R40 |
| 8 | Teto de vazão por `minSegmentTimeMs` (10 ms) | Só o comprimento mínimo de segmento | Liga a velocidade ao que o buffer aguenta; calibrável |
| 9 | G-code só ASCII | Copiar o nome do arquivo como veio | Bytes > 0x7F viram comandos em tempo real no GRBL |
| 10 | Canto inferior esquerdo da **página** do SVG no (0,0) | Caixa do desenho no (0,0), ou centralizado na mesa | Reproduz as coordenadas do Inkscape e dos samples; A4 cai no gabarito |
| 11 | Formas só com `fill` são desenhadas como contorno; `fill` e `stroke` = none é pulado; texto e imagem ignorados com aviso | Desenhar só o que tem `stroke` | É o que o SPEC pede ("só contornos"), e muitos SVGs só têm `fill` |
| 12 | Sem espelhar (`lockScalingFlip`) | Permitir, ou botões de espelhar | Espelhar sem querer é o erro mais caro; dá para acrescentar botões depois |
| 13 | X/Y/largura/altura = caixa na máquina; proporção travada se a rotação não for múltipla de 90°; multisseleção só X/Y | Tamanho no referencial do objeto (como o Fabric) | É o que se mede no papel com a régua |
| 14 | Sem 2-opt | 2-opt depois do vizinho mais próximo | O servo domina o tempo (~6–12 s de ganho em 11 min) |
| 15 | Ordem global, misturando desenhos | Um desenho de cada vez | Menos deslocamento; na v3 as camadas de cor separam |
| 16 | Duplicar com offset (+10, −10) mm | Duplicar no mesmo lugar | Mostra que duplicou |
| 17 | Sessão em IndexedDB (autosave) desde a v1 | Nada até a v3 | Recarregar não pode apagar o trabalho |
| 18 | Desfazer por snapshots | Padrão "command" (do/undo por operação) | Muito mais simples com documento imutável |
| 19 | Parar = `!` + `Hold:0` + reset (mantém posição); emergência separada | Parar = reset direto e Home (SPEC antigo) | É o que o GRBL.md descreve e evita refazer Home à toa |
| 20 | A pausa levanta a caneta (`0x9E`), com "fim do traço" como alternativa | Pausa com a caneta no papel | Evita borrão; depende de teste no fork |
| 21 | Jog contínuo = um `$J` até a borda + `0x85` | Passos curtos repetidos | Movimento suave e menos código |
| 22 | Desenhar exige `$H` (não aceita só `$X`) | Aceitar `$X` com aviso | Com `$X` a posição não é confiável e o soft limit não protege |
| 23 | Sem timeout de `ok`; saúde pelo `?` a cada 200 ms | Timeout fixo de `ok` | Retas longas e lentas atrasam o `ok` legitimamente |
| 24 | Linhas do G-code com espaços e `G1` em toda linha | Compactar (`G1X10Y20`, modal) | Legível para o Artur; a serial não é o gargalo |
| 25 | Script `scripts/vitest.mjs` | Pedir para sempre usar o PowerShell com `C:` maiúsculo, ou trocar a versão do Vitest | Funciona em qualquer terminal, inclusive no CI |
| 26 | jsdom só nos goldens; core recebe `SvgNode` | happy-dom; ou jsdom em todos os testes | O core fica sem DOM; o jsdom custa ~2,5 s por arquivo |
| 27 | `.d.ts` próprio para a Web Serial | `@types/w3c-web-serial` | Umas 40 linhas; uma dependência a menos |
| 28 | Wrapper próprio de IndexedDB | `idb-keyval` | Umas 40 linhas |
| 29 | Simulador acessível na UI com `?sim=1` | Só nos testes | Desenvolver e ensaiar sem a máquina |
| 30 | Sem G2/G3 | Arcos nativos | Simplicidade; regra de vazão resolve |

### Pendências que só você resolve, na máquina

1. **Colar a saída de `$$`** (e conferir `$11`, a junction deviation, que entra no cálculo dos cantos). O plano assume o padrão de 0,010 mm.
2. **Testar se o `0x9E` levanta a caneta em pausa** no fork `vankesteren/grbl-servo` (T26). Isso define `pen.pauseLift`.
3. **Medir a posição real dos gabaritos A4/A3 na madeira** (T17). O perfil atual assume os dois na origem.
4. **O G-code do teste à mão de 07/11**, se ainda existir, vai para `samples/teste_0711_manual.gcode`.
5. **O Uno é alimentado só pela USB?** Muda o que acontece quando o cabo sai (seção 3.7).
6. **Calibrar as faixas de velocidade** com `curvas.svg` (T17) e confirmar ou derrubar a hipótese de v²/R.

### Registro de divergências durante a execução

(Quem executar uma tarefa e precisar desviar do plano anota aqui: data, tarefa, o que mudou e por quê.)

| Data | Tarefa | Desvio | Motivo |
|---|---|---|---|
| 14/11/2026 | T01 | Acrescentado `.gitattributes` com `* text=auto eol=lf`. | O git do Windows está com `core.autocrlf=true`: no checkout, os `.gcode` esperados (goldens) ganhariam CRLF e o `toMatchFileSnapshot` falharia no PC mas não no GitHub Actions (ou vice-versa). |
| 14/11/2026 | T01 | Repositório criado como `Artur-Brasileiro/plotter-studio` (público), com o GitHub Pages via Actions em https://artur-brasileiro.github.io/plotter-studio/. | Pedido do Artur. |
| 14/11/2026 | T08 | `DrawingObject` com `objectCaching: false` (o plano dizia "padrão, true"). | Com cache, o Fabric recorta o bitmap na caixa do objeto e o traço que fica exatamente na borda (ex.: o retângulo de `orientacao.svg`) sai com metade da espessura. Sem cache o desenho é direto com `Path2D`; o desempenho é medido na T17 com `estresse.svg`. |
| 14/11/2026 | T12 | Velocidades de junção corrigidas: 90° = 5,23 mm/s (F314), 45° = 10,25 mm/s (F615), e não 4,39/9,85 como estava na seção 3.5. | O GRBL 1.1 limita a aceleração da junção por eixo na direção do vetor de junção (`limit_value_by_axis_maximum(acceleration, junction_unit_vec)`), o que dá mais que 800 mm/s² em junções diagonais. A conclusão (canto ≥ 45° não precisa de F próprio) continua valendo. |
| 14/11/2026 | T13 | Cabeçalho sem parênteses (`; modo: dinamico - reta F2000 / ...`) e `toAsciiComment` troca `(` `)` por `[` `]`. | O GRBL ignora parênteses depois de `;`, mas outros programas de envio (LaserGRBL) podem não ignorar, e a regra "nunca `(` no arquivo" fica simples de verificar no golden. Nomes como "desenho (1).svg" são comuns. |
| 14/11/2026 | T17 | O gerador sempre emite o primeiro `G0`, mesmo que o primeiro traço comece em `plan.start`. | Bug achado ao gerar `gabarito_a4.gcode` (começa em 0,0): o arquivo descia a caneta "no lugar", mas a máquina pode estar em qualquer posição ao rodar o arquivo (ex.: 810/385 depois do Home) e riscaria uma reta. Teste novo em `gcode.test.ts`. |
| 14/11/2026 | T17 | `estresse.svg` dividido em dois: `estresse.svg` (desempenho da interface, 20 mil traços; não é para desenhar: 172 min, quase tudo servo) e `buffer.svg` (teste de gagueira na máquina, ~5,6 min). Os dois são gerados e ficam fora do git. Acrescentados `samples/gabarito_a4.svg` e `gabarito_a3.svg` para o teste dos gabaritos. | Um arquivo só não serve para os dois testes. |
| 14/11/2026 | T17 | RDP em blocos de 512 pontos. | Numa espiral de 351 mil pontos o RDP levava 730 ms (divisões desequilibradas, custo quase quadrático); em blocos, 117 ms. `planJob` do estresse: 337 ms. |
| 14/11/2026 | T17 | Cache de bitmap do Fabric ligado só durante gestos (arrastar/girar/escalar) e pan (`CanvasView.setCaching`). | Sem cache, arrastar o estresse dava 4 fps (redesenha 411 mil pontos por quadro); com cache sempre ligado, desenhos grandes ficariam borrados no zoom (limite de tamanho do cache do Fabric). Agora: mediana 16,7 ms/quadro, p90 33 ms (Chrome headless sem GPU). |
| 14/11/2026 | T08 | `lockSkewingX/Y` além de `lockScalingFlip`, aplicados também à `ActiveSelection` (via `InteractiveFabricObject.ownDefaults`). | Sem isso, a seleção múltipla podia espelhar, e Shift + alça lateral distorcia (skew) o desenho. |
