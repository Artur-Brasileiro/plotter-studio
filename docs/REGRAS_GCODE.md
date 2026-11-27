# Regras de geração de G-code — CNC Plotter (GRBL + servo MG90S)

Este documento reúne **todas** as regras usadas para gerar G-code para a CNC plotter: formato do arquivo, cuidados com o servo da caneta, blindagem contra falhas, desenho a partir de foto, várias canetas e auditoria.

Quem gera o G-code (pessoa, script ou IA) deve seguir tudo daqui. Se alguma regra for quebrada, o arquivo não vai para a máquina.

---

## Sumário

1. [A máquina](#1-a-máquina)
2. [Formato do arquivo](#2-formato-do-arquivo)
3. [Por que o servo é o centro de tudo](#3-por-que-o-servo-é-o-centro-de-tudo)
4. [Regras para poupar o servo (1 a 9)](#4-regras-para-poupar-o-servo)
5. [Blindagem contra falhas da caneta (10 a 15)](#5-blindagem-contra-falhas-da-caneta)
6. [Script `blindar_gcode.py`](#6-script-blindar_gcodepy)
7. [Várias canetas no mesmo desenho](#7-várias-canetas-no-mesmo-desenho)
8. [Desenho a partir de foto](#8-desenho-a-partir-de-foto)
9. [Orçamento de tempo e tinta](#9-orçamento-de-tempo-e-tinta)
10. [Auditoria obrigatória](#10-auditoria-obrigatória)
11. [Histórico de testes](#11-histórico-de-testes)
12. [Checklist final](#12-checklist-final)
13. [Problemas em aberto](#13-problemas-em-aberto)

---

## 1. A máquina

| Item | Valor |
|---|---|
| Firmware | GRBL (`$32=0`, modo laser desligado) |
| Envio do G-code | LaserGRBL (o UGS deu problema para conectar) |
| Eletrônica | Arduino + CNC Shield + motores de passo NEMA |
| Subir/descer caneta | Servo **MG90S** comandado por `M3 S220` (desce) e `M5` (sobe) |
| Pen holder | ~30 g, correndo em 4 rolamentos LM6UU; embaixo, o peso fica apoiado na ponta da caneta |
| Área útil | **X 30–570 mm × Y 25–370 mm** |
| Velocidade de traço | `G1 F500` (mm/min) |
| Velocidade de deslocamento | `G0` (considerar ~3000 mm/min nos cálculos de tempo) |
| Buffer de linha do GRBL | 80 caracteres → linhas sempre **< 70** |
| Canetas | 0,4 mm (verde, preta, mesmo corpo) e 0,03 mm (fina, corpo diferente) |

> **Ponto fraco da máquina:** o servo. Todo o resto deste documento existe para protegê-lo.

---

## 2. Formato do arquivo

### 2.1 Cabeçalho

```gcode
; comentários de identificação (nome, camada, caneta, data)
G21          ; milímetros
G90          ; coordenadas absolutas
M5           ; caneta em cima
G4 P0.3      ; espera o servo chegar
```

### 2.2 Cada traço (bloco)

Todo traço segue **exatamente** esta estrutura:

```gcode
G0 X123.45 Y67.89    ; vai até o início com a caneta EM CIMA
M3 S220              ; desce a caneta
G4 P0.3              ; espera o servo chegar (obrigatório)
G1 F500              ; modo traço, 500 mm/min
X124.10 Y68.02       ; pontos do traço (G1 modal: só X/Y)
X125.00 Y68.50
...
M5                   ; sobe a caneta
G4 P0.2              ; espera o servo subir (obrigatório)
```

Regras de formato:

- **`G0` nunca acontece com a caneta embaixo.** Antes de todo `G0` tem que haver `M5` + `G4`.
- **Todo `M3` é seguido de `G4 P0.3`** e **todo `M5` de `G4 P0.2`** (no mínimo). Sem a pausa, o GRBL anda antes de o servo chegar e o traço sai riscado ou falhado.
- Os pontos do traço ficam em linhas que começam com **`X` ou `Y`** (o `G1` fica modal na linha `G1 F500`). O script de blindagem só reconhece movimentos nesse formato: linhas `G1 X.. Y..` dentro do bloco **seriam ignoradas** por ele.
- Coordenadas com 2 casas decimais bastam (0,01 mm).
- Linhas com **menos de 70 caracteres**, comentários incluídos.
- Tudo dentro da área útil (X 30–570, Y 25–370). Exceções: ponto de aquecimento (X0 Y0) e cruzes de registro (Y12).

### 2.3 Rodapé

```gcode
M5
G4 P0.3
M5
G4 P0.3
G0 X0 Y0     ; volta para casa
M2           ; fim do programa
```

---

## 3. Por que o servo é o centro de tudo

O que esquenta o servo **não** é a caneta ficar muito tempo embaixo. É **ficar subindo e descendo sem parar**. Cada partida do motor puxa um pico de corrente. O pior caso são as descidas curtinhas: a caneta desce, anda 0,3 mm e sobe.

> **Analogia:** é como dirigir na cidade e na estrada. O motor sofre no anda-e-para, não na velocidade de cruzeiro.

Prova (desenho "máscara", 16/11/2026):

- **verde 1 original:** 58 ciclos/min, pico de 84 em 60 s, 85% das descidas com menos de 1 s → servo esquentou e **parou de subir**.
- **grossa v7:** 15 ciclos/min, caneta embaixo **92%** do tempo → rodou **2h35 com o servo frio**.

Ou seja: **menos subidas e descidas, mesmo que a caneta passe mais tempo encostada.** Isso vale **desde que** o servo não esteja forçando contra o papel (regra 8).

---

## 4. Regras para poupar o servo

### Regra 1 — Emendar traços sempre que a ligação não aparece

A caneta só sobe quando o salto ficaria **visível**. A ligação entre o fim de um traço e o começo do próximo pode ser feita **com a caneta embaixo** quando:

| Caso | Condição |
|---|---|
| Salto pequeno | distância ≤ largura da caneta (**0,4 mm** na grossa/verde, **0,1 mm** na fina) |
| Sobre a própria tinta | o trecho de ligação passa **inteiro** por cima de tinta da **mesma camada** (ex.: anéis concêntricos das linhas grossas) |
| Dentro de hachura (verde) | ligação de **≤ 2 mm** que fica dentro da área que vai ser hachurada |
| Coberto pela grossa (camada fina) | a ligação fica coberta pela tinta da **grossa**, que vem depois, com tolerância de 0,1 mm. **Não vale em áreas de hachura**, onde há branco entre as linhas |
| Pelo caminho da tinta (27/11/2026) | a caneta volta **embaixo, exatamente por cima de linhas da mesma camada** (as que já foram feitas ou as que ainda vão ser), até o começo do próximo traço, com caminho de até **25 mm** (`join.retraceMm`). Passa de uma linha para outra só onde elas se encostam (até a largura da caneta, ou ligação escondida pela tinta até 1,5 mm), inclusive no meio de uma linha (junção em T) |
| Emenda que pode aparecer (27/11/2026) | a ligação pode ter um pedacinho fora da tinta de até **0,3 mm** (`join.visibleMm`, nunca mais que a largura da caneta): fecha frestas entre linhas que quase se encostam |

Os dois últimos casos vieram da plotagem do Eren (27/11/2026): com só os quatro primeiros, o desenho de ~7 mil traços tinha **6.116 subidas**, 1.164 delas descendo em cima da linha que a caneta tinha acabado de fazer. Com eles, **2.110 subidas** (−65%), 4 h 03 → 3 h 28, e o descanso do servo cai de 23 min para meio minuto.

### Regra 2 — Ordenar pensando em emendar

Não usar só "vizinho mais próximo". A cada passo:

1. Procurar, entre os traços a **até 3 mm**, um que dê para emendar sem aparecer (regra 1).
2. Só se não houver, ir para o mais próximo, com a caneta subindo.

Isso também reduz o deslocamento no ar (na grossa: de 21 m para 12 m).

### Regra 3 — Meta de carga do servo

| Métrica | Meta |
|---|---|
| Média | **≤ 20 ciclos/min** |
| Pico em qualquer janela de 60 s | **≤ ~45 ciclos** |
| Zona de perigo | acima de ~50/min com pico de 80+ → servo esquenta |

Um ciclo = uma descida + uma subida.

### Regra 4 — Evitar descidas curtíssimas

- Juntar ou descartar pontinhos e traços escondidos por outros: **traço com menos de 3× a largura da caneta, totalmente coberto por outro, some.**
- Elementos soltos pequenos (tufos, tracinhos de textura) vêm **agrupados numa descida só** e em **pouca quantidade**.
- Atenção: o "vizinho mais próximo" deixa os soltos para o fim e cria um **pico de ciclos no final** do desenho. Distribuir ou agrupar.

### Regra 5 — Limitar cada descida a ~2 min

- Máximo de **850–1000 mm** de traço por descida (em F500).
- Ao atingir o limite, sobe e desce **no mesmo ponto** (não cria marca).
- Cortar **depois** de emendar, porque as emendas juntam traços em cadeias longas.

### Regra 6 — Preenchimento sólido grande vira hachura

- Exemplo: hachura de **1,5 mm a 45°**, com contorno + linhas em zigue-zague emendadas.
- Fundo atrás do personagem pode ser removido inteiro e trocado por contorno e algumas pinceladas.

### Regra 7 — Manter as pausas

- `G4 P0.3` depois de `M3 S220`
- `G4 P0.2` depois de `M5`

O GRBL precisa esperar o servo chegar.

### Regra 8 — Calibração física

- Com `M3 S220`, a ponta **só encosta** no papel e o servo fica **em silêncio**.
- **Zumbido = servo forçando = esquenta**, mesmo com G-code perfeito. Se zumbir, recalibrar o ângulo antes de rodar.

### Regra 9 — Auditoria de cada arquivo

Ver a [seção 10](#10-auditoria-obrigatória).

---

## 5. Blindagem contra falhas da caneta

Desde 17/11/2026, **todo G-code final passa pelo script `blindar_gcode.py`**. Motivo: no desenho "senna", os arquivos passaram em toda a auditoria e mesmo assim a caneta falhou (ver [seção 13](#13-problemas-em-aberto)). A blindagem protege contra uma causa ainda desconhecida.

### Regra 10 — Aquecimento

Antes do 1º traço, vai ao ponto seguro (padrão **X0 Y0**, fora do desenho) e faz:

```gcode
; aquecimento do servo no ponto seguro
M5
G4 P0.3
G0 X0.00 Y0.00
M3 S220      ; repetir este grupo 8 vezes
G4 P0.4
M5
G4 P0.4
G4 P1.0      ; pausa final
```

### Regra 11 — 1º traço com descida longa

- O 1º traço usa `G4 P0.6` (em vez de 0.3) depois do `M3`.
- Se o 1º traço for a **cruz de registro**, ela é feita em **ida e volta pelo mesmo caminho**, sem diagonal. Assim, se a caneta demorar a encostar na ida, a volta cobre.

### Regra 12 — Subida dupla

Todo `M5` vira:

```gcode
M5
G4 P0.2
M5
```

Se uma linha se perder na serial, a segunda ainda levanta a caneta **antes** do deslocamento.

### Regra 13 — Re-sincronização a cada ~10 min

Com a caneta em cima, faz 2 ciclos curtos **no fim do traço que acabou de ser feito** (o ponto cai sobre a própria tinta, sem marca nova):

```gcode
; CHECKPOINT n (~XX min) re-sincroniza servo
M3 S220
G4 P0.3
M5
G4 P0.3
M3 S220
G4 P0.3
M5
G4 P0.4
```

Cada um fica marcado como `; CHECKPOINT n`, que serve de referência para retomar.

### Regra 14 — Partes de ~25 min

- Além do arquivo completo, o desenho é dividido em **partes de ~25 min**.
- Cada parte começa com o **aquecimento** (regra 10) e termina com o rodapé.
- As partes são cortadas sempre num checkpoint.
- Se a caneta travar, roda-se de novo **só a parte em que parou**.

### Regra 15 — Tamanho das linhas

Linhas sempre com **menos de 70 caracteres**, comentários incluídos (o buffer de linha do GRBL é de 80).

---

## 6. Script `blindar_gcode.py`

### Uso

```bash
python3 blindar_gcode.py entrada.gcode [pasta_saida]
```

### Saída

- `entrada_BLINDADO.gcode` → arquivo completo
- `entrada_parte1deN.gcode`, `entrada_parte2deN.gcode`, ... → partes de ~25 min

No terminal: `nome  X tracos, Y checkpoints, N partes`.

### Parâmetros (topo do script)

| Constante | Padrão | Função |
|---|---|---|
| `SAFE_X`, `SAFE_Y` | 0.0, 0.0 | ponto seguro do aquecimento |
| `WARMUP_CYCLES` | 8 | ciclos de aquecimento |
| `RESYNC_MIN` | 10.0 | minutos entre checkpoints |
| `PART_MIN` | 25.0 | duração alvo de cada parte |
| `FEED_G1`, `FEED_G0` | 500, 3000 | velocidades usadas para estimar o tempo |

### O que o arquivo de entrada precisa ter

- Formato da [seção 2](#2-formato-do-arquivo): blocos `G0` → `M3 S220` → `G4` → `G1 F500` → linhas `X.. Y..` → `M5`.
- Comentários do cabeçalho começando com `;` (são preservados).
- O `G0` final para casa (sem `M3` depois) é tratado como rodapé.

### Verificação

Depois de blindar, conferir que **nenhum traço foi perdido nem criado**, tanto no arquivo completo quanto na soma das partes.

---

## 7. Várias canetas no mesmo desenho

### Cruzes de registro

- Cada camada começa com a **cruz de registro em X20 Y12** e tem outra em **X580 Y12**.
- O braço da cruz tem **6 mm**, que serve de régua na foto.

### Correção de deslocamento da ponta

Canetas de marca/corpo diferentes ficam com a ponta deslocada no suporte.

1. Rodar a primeira cruz.
2. Fotografar e medir o deslocamento (usar o braço de 6 mm como régua).
3. Deslocar a **camada inteira** pelo valor medido.

Medido neste suporte:

| Caneta | Deslocamento | Correção |
|---|---|---|
| Verde 0,4 | referência | — |
| Preta 0,4 (mesmo corpo da verde) | nenhum | — |
| Fina 0,03 | ~1,0 mm em X+ | **−1,0 mm em X** |

**Pelo diâmetro do corpo (27/11/2026).** A ponta fica no centro da caneta. Cada caneta pode ter o **Corpo (mm)**
(diâmetro onde o suporte aperta) e o estojo diz como o suporte segura: encostada numa **parede** (a ponta anda
metade da diferença de diâmetro), num **V de 90°** (0,71 da diferença) ou **centralizada** (não anda), e para que
lado a ponta vai quando a caneta é mais grossa. O programa soma essa correção ao deslocamento medido
(`tipOffset` em `src/core/machine.ts`); o deslocamento medido fica para o ajuste fino com as cruzes. Caneta sem
Corpo conta como igual à de referência (sem correção).

### Ordem das camadas

**cor/verde → fina → grossa**

A grossa por último cobre as pontas e as ligações da fina (é isso que permite o 4º caso da regra 1).

---

## 8. Desenho a partir de foto

### Orientação na folha

- Foto em pé vira desenho em **retrato** (345 × 540 mm).
- **Topo da imagem no lado X+** (X = 570); **lado esquerdo da imagem em Y alto**.
- Cruzes na borda **Y12**.
- Foto 9:16: ajustar pela largura e cortar o céu de cima.

### Recorte do fundo

- `rembg` com o modelo **`isnet-general-use`** (baixado do GitHub) separa bem pessoa e carro.
- Limpar a máscara depois: separar os objetos por uma polilinha e cortar o chão abaixo da linha dos pneus.

### Objeto principal (ex.: carro)

- **Hachura pelo tom da foto** (escala 0–255):

| Tom | Hachura |
|---|---|
| < 38 | cruzada |
| < 72 | simples |
| < 108 | grossa espaçada |
| < 140 | fina |
| ≥ 140 | branco |

- Por cima entram **linhas medidas na foto**: para-brisa, faróis, grade, frisos, para-choque, placa, neblinas, espelhos, caixa de roda, emblema.
  - Medir com zoom de 4× e régua de pixels, sobrepor na foto e corrigir.
  - Cada linha medida ganha **margem branca de ~0,45 mm de cada lado**, para não sumir dentro do preto.
- **Rodas:** elipses inclinadas de pneu, aro e cubo; os vãos entre os raios são desenhados à mão na grossa.
- Em foto nítida, um **detector de traço fino** (black-hat/top-hat + esqueleto) pega frestas e frisos automaticamente.

### Pessoa / objetos secundários

- Podem usar hachura guiada pelo tom, mas **suavizando o campo antes do limiar** (cabelo ~1 mm, pele ~2,5 mm). Sem isso, as manchas saem serrilhadas.
- Detalhes que identificam a pessoa (ex.: orelha) podem ser desenhados à mão.

### Roupas

- **Preto chapado** (camiseta preta): uma hachura única e regular na grossa. O sombreado de dobras por contraste local virou padrão de losangos e foi **descartado**.
- **Camiseta branca:** só a sombra grande (componentes > ~900 mm²). Sombras pequenas parecem manchas.

### Paisagem rápida

- Linha da serra na grossa; sol com raios.
- Mata e árvores hachuradas (máscara de "verde escuro" pela cor).
- Poucas curvas longas e bem suavizadas para os morros.
- Estrada detectada pela cor (vermelho − verde).
- Cercas: traço fino vertical.
- Chão quase branco, com algumas touceiras de cascalho.
- **Cuidado:** linhas de nível recortadas por uma zona criam uma linha reta falsa na borda. **Erodir a zona antes de recortar.**

---

## 9. Orçamento de tempo e tinta

- Em F500, **1 m de traço ≈ 2 min**.
- Referências:
  - Omega 1: 109 m (~4 h).
  - Omega 2 (foco no carro, resto em linha): 52 m, ~2h10 com a blindagem.
- **Hachura fina por baixo de área grossa escura não aparece: não gastar.**
- Definir o orçamento antes de gerar: desenhos acima de ~2–3 h aumentam o risco de falha da caneta (ver seção 13).

---

## 10. Auditoria obrigatória

Todo arquivo, antes de ir para a máquina, deve ter um relatório com:

| Item | O que conferir |
|---|---|
| Ciclos/min (média) | ≤ 20 |
| Pico em 60 s | ≤ ~45 |
| % de descidas < 1 s | quanto menor, melhor (v7: 46%) |
| Descida mais longa | ≤ ~2 min (850–1000 mm) |
| % do tempo com caneta embaixo | informativo |
| Tinta extra criada pelas emendas | informar em mm |
| Segmentos | nenhum faltando, nenhum criado |
| `G0` com caneta embaixo | **zero** |
| `M3`/`M5` sem `G4` depois | **zero** |
| Maior linha | < 70 caracteres |
| Limites | tudo dentro de X 30–570 / Y 25–370 (exceto aquecimento e cruzes) |
| Tempo estimado | total e por parte |

**Conferência visual:** redesenhar a imagem **a partir do próprio G-code** e checar orientação, encaixe das camadas e cruzes.

---

## 11. Histórico de testes

| Arquivo | Ciclos/min | Pico 60 s | Descidas < 1 s | Caneta embaixo | Resultado |
|---|---|---|---|---|---|
| verde 1 original | **58** | **84** | **85%** | 73% | servo esquentou e travou |
| fina v5 | 49 | 63 | 75% | 72% | ok (45 min) |
| verde final (junto + emendado) | 19 | 34 | 40% | 86% | ok |
| **grossa v7** | **15** | **45** | **46%** | 92% | **perfeita, servo frio (2h35)** |
| senna fina 0,03 | 20,5 | 36 | 15% | 89% | parou de subir no final (~80 min) |
| senna grossa 0,4 | 14,2 | 30 | 25% | 93% | 1ª cruz sem tinta, resto ok |
| omega2 fina 0,03 blindada | 15,9 | 38 | 37% | 85% | gerado (~59 min) |
| omega2 grossa 0,4 blindada | 8,5 | 34 | 31% | 92% | gerado (~72 min) |

---

## 12. Checklist final

Antes de mandar qualquer arquivo para o LaserGRBL:

- [ ] Cabeçalho `G21` / `G90` / `M5` / `G4`
- [ ] Todo bloco no formato `G0` → `M3 S220` → `G4` → `G1 F500` → `X.. Y..` → `M5` → `G4`
- [ ] Traços emendados onde a ligação não aparece (regra 1)
- [ ] Ordem priorizando emendas, busca em 3 mm (regra 2)
- [ ] Média ≤ 20 ciclos/min e pico ≤ 45 em 60 s (regra 3)
- [ ] Sem pontinhos e traços escondidos; soltos agrupados (regra 4)
- [ ] Nenhuma descida acima de ~2 min (regra 5)
- [ ] Áreas sólidas grandes em hachura (regra 6)
- [ ] Passou pelo `blindar_gcode.py` (regras 10 a 14)
- [ ] Nenhum traço perdido ou criado na blindagem
- [ ] Linhas < 70 caracteres (regra 15)
- [ ] Correção de X aplicada na camada fina (−1,0 mm)
- [ ] Cruzes em X20 Y12 e X580 Y12
- [ ] Ordem das camadas: cor → fina → grossa
- [ ] Relatório de auditoria + redesenho a partir do G-code (seção 10)
- [ ] Servo calibrado: encosta e **não zumbe** com `M3 S220` (regra 8)

---

## 13. Problemas em aberto

**Desenho "senna" (17/11/2026):** os dois arquivos passaram em toda a auditoria (nenhum `G0` com caneta embaixo, todo `M3`/`M5` com `G4`, linhas ≤ 63 caracteres, carga dentro da meta). Mesmo assim:

- a **fina** parou de subir perto dos **80 min**;
- a **1ª cruz da grossa** saiu sem traço.

Já foram **descartados**: força do servo (folga grande para ~100 g), pen holder, curso de subida/descida e barras envergadas. GRBL com `$32=0`, envio pelo LaserGRBL.

**Causa ainda não identificada.** Por isso todo G-code sai blindado (seção 5). Ao descobrir a causa, atualizar este documento.
