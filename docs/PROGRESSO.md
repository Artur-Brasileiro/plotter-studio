# Progresso da v3 (trabalho da noite de 21 para 22/11/2026)

Ramo: `v3-regras-e-vetorizador`. **Nada foi publicado**: a versão no ar (ramo `main`) não mudou.
**Nada foi enviado para a máquina real**: tudo foi testado com testes automáticos, com o simulador (`?sim=1`)
e num Chrome dirigido por script. O que só a máquina pode confirmar está em [TESTES.md](TESTES.md), "Roteiro da v3".

Para ver funcionando: **dois cliques em `Abrir Plotter Studio (simulador).bat`**, na pasta do projeto (abre o navegador sozinho, com uma máquina de mentira). `Abrir Plotter Studio.bat` abre o programa de verdade.

## Acrescentado em 22/11/2026, de manhã: tipo Ilustração e tons da Foto

O Artur abriu o programa, gostou, e trouxe uma imagem em que nada funcionava: uma pintura colorida de um robô
enferrujado, cheia de textura, sobre uma planta técnica. Ele aprovou colocar no programa a solução testada antes
no laboratório.

- **Tipo novo "Ilustração"** na tela de vetorizar, para pintura, desenho colorido e imagem com textura. O programa
  primeiro redesenha a imagem (a textura some, ficam os contornos das formas) e só depois traça. As partes escuras
  podem ganhar hachura. Três controles principais: **Detalhe**, **Traço mínimo** e **Sombras**.
- **Tipo "Foto" corrigido**: os tons escuros saíam todos iguais (um borrão). Agora cada tom mais escuro ganha mais
  hachura. As fotos saem mais claras que antes; o controle "Claro ou escuro" escurece.
- A tela **escolhe Ilustração sozinha** na primeira imagem colorida de quem nunca escolheu um tipo, e **avisa**
  quando uma imagem colorida está no tipo Traço ou Preto e branco.

Medido na imagem do robô, folha inteira (297 × 530 mm, deitado), caneta 0,4, pelo planejador de verdade:

| Tipo | Descidas | Tempo | Espera do servo | Regras |
|---|---|---|---|---|
| Traço (como era) | 7.396 | 4 h 49 min | 49 min | passa, mas o desenho sai cheio de "estrelas" e rabiscos |
| Ilustração, só linhas (Detalhe 75%) | 1.321 | 1 h 09 min | 0 | passa |
| Ilustração, só linhas (Detalhe 50%) | 973 | 59 min | 0 | passa |
| Ilustração padrão (Sombras 50%) | 2.317 | 2 h 28 min | 0 | passa |
| Foto corrigida | 1.996 | 2 h 24 min | ~0 | passa |

Como foi conferido: 106 testes novos (a conversão para TypeScript bate com a referência em Python etapa por etapa,
em cena sintética); a imagem do robô rodou pelo código do programa e pelo navegador com o simulador, do "Trazer
desenho" até o "Pronto para plotar"; o cálculo leva ~6 s (10 a 13 s no navegador de teste).

Limites conhecidos do tipo Ilustração:

- **Testado a fundo numa imagem só** (o robô) e, por alto, em outras quatro. Não foi testado em fotografia.
- **Não separa a figura do fundo.** No robô, as linhas finas da planta ao fundo ficam e o texto miúdo some quase todo.
- **Linha grossa do original vira duas** (o contorno dela) quando é bem mais larga que a caneta. Com sombras, o meio
  é hachurado.
- **Divisa entre duas cores de mesma luminância** (vermelho e verde, por exemplo) sai como duas linhas juntas.
- **Sombras em folha grande custam mais de uma hora.** No zero ficam só as linhas.
- **Nada disso rodou na máquina.** O teste é o C5b de [TESTES.md](TESTES.md).

## Acrescentado em 22/11/2026, à tarde: escolher o tipo antes, fundo escuro, e seis imagens de teste

O Artur aprovou o resultado do robô e trouxe seis imagens de estilos diferentes. Pediu também uma mudança na tela:
ela não deve começar a calcular sozinha no tipo que estiver marcado.

- **O tipo é escolhido antes de qualquer cálculo.** A tela de vetorizar abre mostrando a imagem e quatro cartões
  (Traço, Preto e branco, Ilustração, Foto), cada um dizendo para que serve. O traçado só começa no clique. Depois
  dá para trocar de tipo na fileira de botões, como antes. A tela não escolhe nem sugere um tipo sozinha (medi cor,
  fundo e quantidade de figura nas onze imagens de teste e nenhuma conta simples acerta todas).
- **Fundo escuro é detectado** (pela borda da imagem). Nos tipos Traço, Preto e branco e Foto, "A imagem tem fundo
  escuro" já vem marcado, com um aviso. Na Ilustração não vem: ela não precisa.
- **"A imagem tem fundo escuro" não é mais lembrado** de uma imagem para a outra (era uma armadilha: a imagem
  seguinte, de fundo branco, saía em negativo).
- **Ilustração com fundo escuro:** as sombras tratam o fundo como papel. Antes a hachura cobria o fundo inteiro.
- O aviso "esta imagem é colorida" só aparece em imagem de fundo claro (uma planta azul também é "colorida").

As seis imagens, no tamanho que a tela escolhe (folha inteira), caneta 0,4, com o tempo do planejador de verdade.
Todas passam nas regras.

| Imagem | O que funcionou | Tempo | Observação |
|---|---|---|---|
| Planta azul de um carro (linhas brancas) | Traço + fundo escuro | 1 h 09 min | Excelente, texto legível. Sem marcar fundo escuro saía lixo; agora vem marcado |
| Personagem de cores chapadas em fundo verde-escuro | Ilustração | 37 min (20 min sem sombras) | Contorno limpo |
| Estudo de castelo, gravura colorida cheia de detalhe e texto | Ilustração com Detalhe 100% e Linhas fracas 80% | 1 h 04 min (só linhas) | No padrão some detalhe demais. O Traço é mais fiel e leva 3 h 15 min. Texto miúdo não sai em nenhum |
| Retrato, fotografia em preto e branco | Foto | 3 h 18 min | Reconhecível. Com hachura de 1,4 mm e 4 direções fica bem melhor, mas são 6 h |
| Dragão, render escuro e cheio de escamas | nenhum ficou bom | 57 min na Foto + fundo escuro | Imagem quase toda escura e de pouco contraste: sai um "negativo" fraco |
| Página de mangá (nanquim com hachura) | Preto e branco, ou Traço | 5 h 28 min, ou 2 h 09 min | O Preto e branco é fiel e pesado demais; o Traço perde o preto chapado do título |

O que esses testes mostram que ainda falta:

- **Imagem escura e de pouco contraste** (o dragão) não tem tipo que resolva.
- **Foto é lenta** para ficar boa: hachura fina em folha grande passa de 5 horas.
- **Mangá no Preto e branco é pesado**: milhares de tracinhos de hachura do original viram descidas da caneta.
- **Ilustração no padrão perde detalhe fino** em gravura detalhada; é preciso subir o Detalhe e as Linhas fracas.

## Acrescentado em 22/11/2026, à noite: cores em camadas, papel e caneta, apagar traços, e os quatro pontos fracos

O Artur trouxe um cartaz que ele vai mesmo plotar (fundo preto, nove quadros em preto e branco, letreiro vermelho)
e pediu: ver o resultado em papel branco com caneta preta **ou** em papel preto com caneta branca; separar as cores
da imagem em camadas, cada uma com a caneta que ele escolher; apagar à mão um traço que não ficou bom; e atacar os
quatro pontos fracos da rodada anterior.

**Cores em camadas** (`src/core/trace/colors.ts`). A tela de vetorizar acha as cores de caneta da imagem e diz de
que cor é cada traço. Aparece a lista "Cores da imagem": uma linha por cor, com a caneta que vai desenhá-la (a do
desenho, outra do estojo, "Criar uma caneta desta cor" ou "Não desenhar esta cor"). Do jeito que vem, tudo sai com
uma caneta só, como antes. Cada caneta escolhida vira um desenho próprio na mesa; eles chegam selecionados juntos.
Preto, cinza e branco contam como a mesma caneta. No cartaz: preto e vermelho. No robô: preto, laranja, azul (as
lentes) e verde (a plantinha).

**Papel e caneta.** A cor do papel (branco, preto, kraft ou qualquer outra) fica na barra de cima e na tela de
vetorizar; a mesa, a prévia e a tela de apagar traços mostram o desenho na cor do papel e das canetas. É só para a
tela: o G-code não muda. "A caneta desenha: o escuro da imagem / o claro da imagem" substitui a caixinha "A imagem
tem fundo escuro". Em papel escuro o padrão é desenhar o claro (o fundo escuro vira o próprio papel); se a caneta
escolhida não aparece no papel, a tela avisa e oferece criar uma caneta branca. Desenhando o claro, o que conta é
quanto cada pixel se destaca do fundo, e não a luminância: senão o vermelho do letreiro sumia ao lado do branco.

**Apagar traços** (`src/core/strokeEdit.ts`, `src/ui/strokeEditor.ts`). Botão "Apagar traços…" no passo Desenho, ou
dois cliques no desenho. Clique marca um traço, arrastar marca vários, "Marcar os curtos" marca tudo abaixo de um
tamanho, Delete apaga, Ctrl+Z traz de volta. "Concluir" vira uma mudança só no desenho, que o Ctrl+Z da mesa
desfaz. Funciona em vários desenhos de uma vez (as camadas de cor).

**Tempo de máquina na tela de vetorizar.** O mesmo planejador do passo Conferir roda sobre o traçado, num worker, e
mostra o tempo de verdade no rodapé da tela, com as descidas da caneta e a espera do servo. Cada ajuste agora
responde em tempo de máquina, sem precisar colocar na mesa para descobrir.

Os quatro pontos fracos da rodada anterior:

| Ponto fraco | O que foi feito | Medido |
|---|---|---|
| Imagem escura e de pouco contraste | Foto: "Realçar os tons" (já vem em 50%) espalha os tons pela escala toda. E papel preto com caneta clara: o escuro vira papel | Dragão: antes, 19 m de tinta e irreconhecível. Agora 42 m, 1 h 50 min, e dá para reconhecer. Continua sendo hachura grossa, não um retrato fino |
| Mangá no Preto e branco pesado | "Traço mínimo" nos tipos Traço e Preto e branco: tracinho e contorno mais curtos que o valor somem | Mangá: 5 h 30 → 4 h 23 (1,5 mm) → 4 h 02 (2 mm, sem pontinhos). Metade das descidas eram traços de menos de 2 mm, com 4% da tinta |
| Foto lenta | Não tem atalho: numa foto o tempo é a tinta (1 m ≈ 2 min a F500). O que mudou foi a tela mostrar o tempo de verdade a cada ajuste | Retrato no padrão: 3 h 11 min (era 3 h 18) |
| Ilustração perde detalhe fino | Três estilos de um clique: Limpo, Equilibrado, Detalhado | Castelo no Detalhado: 1 h 05 min só linhas, 1 h 55 min com sombras |

O cartaz, na folha inteira (509 × 335 mm), caneta 0,4. Todas as combinações passam nas regras.

| Como | Tempo | Descidas |
|---|---|---|
| Papel branco, como abre (pinta o fundo preto) | 9 h 23 min | 12.149 |
| Papel branco, Traço mínimo 2 mm | 6 h 38 min | 7.001 |
| Papel branco, Traço mínimo 2 mm, sem pintar o fundo | 5 h 22 min | 6.665 |
| Papel preto, caneta branca de 0,5, Traço mínimo 2 mm | 5 h 52 min | 6.867 |

O que ainda falta, e que esses testes mostraram:

- **O cartaz continua longo** (mais de 5 horas) mesmo com os cortes: é um desenho muito cheio numa folha grande. O
  que encurta de verdade é o tamanho no papel ou a distância da hachura. A decisão é do Artur.
- **O programa não escolhe o estilo da Ilustração sozinho.** Medi a quantidade de traço fino nas nove imagens e o
  número do castelo (gravura) é igual ao do robô (pintura cheia de textura): não dá para distinguir sem errar.
- **A cor é do traço inteiro.** Um traço que passa por duas cores fica com a que ocupa a maior parte dele; ele não
  é cortado no meio.
- **Só o escuro é tinta em papel claro.** Uma área amarela clara num papel branco não vira hachura amarela: ela é
  "papel". No tipo Ilustração ela ganha contorno (que pode ir para a caneta amarela), mas não preenchimento.
- **As camadas de cor são desenhos separados na mesa.** Se um for movido sozinho, as cores desencontram.
- **A hachura da Foto continua sendo uma descida por linha.** Emendar as linhas em zigue-zague pouparia uns 10% do
  tempo, mas desenharia o contorno das manchas; não foi feito.
- **Nada disso rodou na máquina.**

## Acrescentado em 23/11/2026: traço fino e grosso em camadas, conjuntos na mesa, telas mais enxutas

O Artur testou as camadas e o apagar traços ("funcionou") e pediu duas coisas. Primeira: separar o detalhe fino do
grosso, como nos G-codes da máscara que ele plotou antes (`mascara_2fina_003mm`, `mascara_3grossa_04mm`): lá, as
linhas finas do desenho foram para a caneta 0,03 e os contornos fortes para a 0,4. Segunda: as telas estavam com
texto e ajuste demais, e a mesa era confusa (para apagar traços de uma camada era preciso clicar nela no desenho, e
para voltar à lista só com Esc, que ele achou por acaso).

**Traço fino e grosso.** O traçador passou a dizer, para cada traço, o que ele é (linha, ponto, contorno, hachura)
e a largura da linha que ele seguiu no desenho original. Na tela de vetorizar, em "Camadas", a caixinha "Separar o
traço fino do grosso" divide cada cor em duas camadas ("Preto fino" e "Preto grosso"), cada uma com a sua caneta. O
controle "Fino até" diz até que largura (no papel) a linha é fina; ele começa na largura do meio do desenho. Na
Ilustração a divisão é entre contornos e sombras. Na Foto não há divisão. No desenho de linhas de teste, na folha
inteira: 2.740 traços finos e 1.870 grossos com o limite em 0,6 mm.

**Conjuntos na mesa.** As camadas de uma mesma imagem (uma por caneta) agora formam um conjunto: na mesa são um
objeto só, que se move, gira e muda de tamanho junto. Acabou o risco de uma cor desencontrar da outra.

**Telas mais enxutas.**
- Vetorizar: a janela ocupa quase a tela toda; cada tipo mostra só os dois ou três ajustes que mais mudam o
  resultado, e o resto fica em "Mais ajustes"; os textos longos viraram dicas ao passar o mouse; "A caneta desenha"
  só aparece quando há o que decidir (imagem de fundo escuro ou papel escuro).
- Passo Desenho: a lista "Na mesa" fica sempre à vista; o item escolhido mostra as suas camadas, e cada camada tem
  na própria linha a caneta e o botão "Apagar traços". Não é mais preciso clicar na camada no desenho, nem usar Esc
  para voltar.
- Apagar traços: dá para escolher a camada lá dentro.

O que ainda falta:

- **A largura é medida no desenho original.** Uma linha que afina na ponta conta pela largura do meio dela, e vai
  inteira para uma camada só.
- **Só os tipos Traço e Preto e branco medem largura.** No Preto e branco, a área cheia (contorno e hachura) é
  sempre do grosso.
- **Nada disso rodou na máquina.**

## Combinado com o Artur

- As regras de `docs/REGRAS_GCODE.md` mandam onde contradizem o gerador antigo.
- F500 fixo é o padrão; a velocidade dinâmica continua existindo, desligada.
- Zona de desenho padrão X 30–570 / Y 25–370, ajustável. O curso de 810 × 385 é o limite duro.
- Servo: média até 30 descidas/min, pico de 45 em 60 s. Passou do limite: a máquina espera com a caneta em cima.
  Tudo configurável em Configurações → Proteção do servo.
- Hachura é o preenchimento preferido.
- Vetorização (imagem → traço) roda dentro do Plotter Studio, no navegador.

## Estado

| Etapa | Estado |
|---|---|
| 1. Regras do README no gerador de G-code + auditoria | pronto, e revisado por um revisor independente (ver "Revisões") |
| 2. Imagem → traço (linha única, preto e branco com hachura, foto por tom) | pronto; idêntico ao laboratório em Python |
| 3. Revisão do controle da CNC | pronto: 11 achados corrigidos, simulador refeito a partir do fonte do GRBL |
| 4. Interface nova | pronto: passos Desenho / Conferir / Plotar, Configurações, tela de vetorizar |
| 5. Várias canetas (camadas, cruzes de registro, correção da ponta) e retomar | pronto |
| 6. Texto em fonte de traço único | pronto: "Trazer desenho → Texto", três letras (Simples, Futura, Cursiva), acentos e cedilha |
| 7. Tipo Ilustração (imagem colorida → contornos + sombras) e tons da Foto | pronto em 22/11, de manhã (ver acima) |
| 8. Cores em camadas, papel e caneta, apagar traços, tempo de máquina na tela de vetorizar | pronto em 22/11, à noite (ver acima) |
| 9. Traço fino e grosso em camadas, conjuntos na mesa, telas mais enxutas | pronto em 23/11 (ver acima) |

Testes automáticos: 1.596 passando (eram 304 no começo da noite e 1.331 ao fim dela). `npm run build` passa.

## O que cada passo da tela faz

1. **Desenho.** "Trazer desenho" aceita SVG, imagem (PNG/JPG) e **texto** (letras de traço único: a caneta escreve com uma linha só). A imagem abre a tela de vetorizar, com quatro tipos:
   *Traço* (cada linha vira um traço único), *Preto e branco* (traço fino em linha única, área cheia com contorno e
   hachura), *Ilustração* (pintura ou desenho colorido: contornos limpos e sombras em hachura) e *Foto* (o tom vira
   hachura cruzada). O desenho cai dentro da folha, e dá para mover, girar, redimensionar,
   "Encaixar na folha" e escolher a **caneta** de cada desenho.
2. **Conferir.** Diz se pode ir para a máquina (verde, amarelo ou vermelho), quanto tempo leva, quanto o servo trabalha
   (média e pico, com a barra do limite) e passa as regras uma a uma. Baixa o G-code inteiro, em partes de ~25 min,
   ou a retomada a partir de um checkpoint. **Arquivo que quebra regra não baixa nem é enviado.**
3. **Plotar.** Lista o que falta antes de enviar (conectar, Home, caneta), envia, mostra o progresso, pausa, para, e
   retoma de onde parou. Com mais de uma caneta, mostra as camadas na ordem e avisa a hora de trocar.

No alto da tela, **Como usar** explica os três passos, a parada de emergência e os atalhos, sem termos técnicos.

## O que foi medido

- **Auditoria × histórico do README.** Rodada nos 29 arquivos reais de `D:\CNC Plotter - Desenhos\G-codes - Desenhos`,
  dá os mesmos números da tabela de `REGRAS_GCODE.md`: senna fina 20,5/min, pico 36, 15% curtas, 89% embaixo (idêntico);
  senna grossa 14,2 / 30 / 25% / 93% (idêntico); grossa v7 15,0 / 46 / 46% / 92% (o README diz pico 45).
  Os arquivos blindados que já rodaram (`omega3_1fina_BLINDADO` e as duas retomadas) passam com **zero problemas**,
  e nenhum dos 29 tem linha que a auditoria não saiba ler.
- **Traçador TypeScript × laboratório Python.** Nas imagens reais (castelo e F16) o resultado é idêntico: mesmos traços
  e pontos, mesmas coordenadas. Tempo: ~3 s no navegador contra 18 s no Python.
- **Castelo de amostra, 503 × 335 mm, caneta 0,4:** 2.201 descidas, 29 m de traço, 1 h 37 min, média de 22,8 descidas/min,
  pico de 42 (limite 45), com 7 min 38 s de descanso do servo distribuídos.
- **Gravura de amostra em preto e branco, 186 × 330 mm:** 4.950 descidas, 28,7 m, 3 h 03 min, dos quais 1 h de descanso
  do servo (80% das descidas duram menos de 1 s). Passa nas regras, mas é um desenho pesado: aumentar a distância da
  hachura ou diminuir o tamanho encurta bastante.
- **O filtro de ruído NLM do laboratório não foi portado**: sem ele o traçado muda menos de 2%.
- **Planejar** (ordem, emendas, agenda do servo) leva 0,2 a 0,8 s nesses desenhos.

## Revisões independentes feitas nesta noite

O código foi entregue três vezes a revisores que não participaram da escrita, com a tarefa de achar defeito. Cada defeito confirmado ficou com um teste que o prova e que agora passa.

**Controle da CNC** (comparado com o código-fonte do GRBL 1.1h e do fork `grbl-servo`): 11 achados, todos corrigidos.
Os mais importantes:
- durante o Home o GRBL não responde a nada além do reset: o Esc não parava a máquina e o "Parar" esperava 10 s;
- depois de um `ALARM:2` ele fica mudo até o reset: a tela dizia "placa travada";
- um erro numa linha que não é ponto (`G1 F500`, `M3`, `M5`, `G0`) faria o resto do traço sair em `G0` com a caneta
  embaixo se o usuário clicasse "continuar": agora o trabalho para sozinho;
- qualquer ruído na serial era tratado como cabo solto, o que mataria um desenho de 2 horas.

O simulador tinha as mesmas crenças erradas do controlador, por isso os testes antigos passavam: ele foi corrigido
primeiro. Detalhes em [GRBL.md](GRBL.md).

**Gerador de G-code** (contra `REGRAS_GCODE.md`): 10 defeitos, cada um com um teste que falhava
(`src/core/job/review.test.ts`), todos corrigidos. Os mais importantes:
- tracinhos que se cobriam uns aos outros sumiam todos (o papel ficava em branco onde havia desenho);
- a emenda podia atravessar um filete de papel em branco de 0,19 mm;
- a auditoria deixava passar `M3 S220 G4 P0.3` numa linha só, `G4 P0`, coordenada com sinal de mais, `G91`, `$32=1`;
- no modo "esperar", o arquivo gerado podia ser reprovado pela própria auditoria (as duas contavam o tempo de jeitos
  diferentes), e os 8 ciclos do aquecimento não entravam em conta nenhuma.

**Segunda revisão do gerador** (tudo o que foi escrito depois da primeira: camadas, retomada, auditoria reescrita,
agenda do servo, texto): `src/core/job/review2.test.ts` e `src/core/text/review2.test.ts`. O revisor gerou perto de
25 mil arquivos sorteados (inteiros, em partes e retomadas, com 1 a 3 canetas) e conferiu cada um com um leitor de
G-code escrito por ele, sem usar a auditoria do aplicativo. **Com as configurações padrão ele não achou nenhum arquivo
que quebrasse uma regra.** Achou 11 defeitos, todos corrigidos; o único que podia estragar um desenho:
- o "Retomar de onde parou" continuava sendo oferecido depois de o desenho ser movido na mesa (a retomada riscaria
  ao lado do que já estava no papel). Agora o ponto guardado só vale se todos os pontos do desenho forem os mesmos.

Os outros pediam configurações fora do padrão (servo com o pico igual à média, blindagem desligada, aquecimento
maior que o pico) ou eram de acabamento (o "í" da letra cursiva ficava com pingo e acento; o "Y" entortava).

## Decisões que tomei e que o Artur pode querer mudar

Todas são configuráveis ou fáceis de trocar.

- **Limite do servo 30 / 45** (o README pede média até 20; o Artur disse que até 30 tudo bem). Em Configurações →
  Proteção do servo dá para voltar a 20: os desenhos ficam mais lentos, com mais descanso.
- **A retomada repete o traço anterior ao que parou**, por segurança (os arquivos RETOMAR antigos repetiam ~42 movimentos).
- **Partes de ~25 min** são cortadas no primeiro checkpoint depois de 20 min; com checkpoints de 10 em 10, saem de ~20 min.
- **Descida longa**: o corte é em 900 mm a F500 (108 s); num trabalho mais lento o comprimento encolhe junto, para o tempo ser o mesmo. Um resto menor que 0,5 mm não ganha descida própria.
- **Emendas "por cima da tinta"** ficaram conservadoras: só emenda quando a ligação inteira cai, com certeza, sobre tinta
  que já existe. Perde-se alguma emenda; não se cria risco novo.
- **Ordem das camadas** = ordem da lista de canetas em Configurações → Estojo de canetas (verde → fina → preta).
- **Desvio da caneta fina** = 1,0 mm em X (do README). As cruzes de registro são a conferência.
- **Aquecimento com no máximo 20 ciclos** e pausas do servo com no mínimo 0,05 s nas Configurações.
- **O comentário do checkpoint saiu sem o "~"**: `; CHECKPOINT 1 (10 min) re-sincroniza servo`, e não `(~10 min)` como
  no script antigo. Para o GRBL o "~" é o comando "continuar", até dentro de comentário: com a máquina em pausa, um
  programa de envio que mande os comentários faria ela voltar a andar. A referência para retomar continua sendo o
  `; CHECKPOINT n`.
- **Numa retomada, o servo pode descansar alguns segundos depois do aquecimento** (até ~30 s no pior caso, com duas
  batidas de reaquecimento no fim). É a conta do limite do servo refeita para um arquivo que começa no meio.
- **A média do servo de um arquivo com menos de um minuto** é contada como "descidas nesse minuto" (um tracinho só,
  de 2 segundos, não são "30 por minuto").
- **Tipo Ilustração: os padrões são Detalhe 75%, Traço mínimo 2,5 mm e Sombras 50%** (hachura a 2 mm). Com as sombras
  o desenho fica mais bonito e bem mais demorado; quem preferir rapidez põe Sombras no zero.
- **A tela troca o tipo para Ilustração sozinha** só para quem nunca escolheu um tipo; depois disso respeita a última
  escolha e apenas avisa.
- **Foto: os tons agora são proporcionais** (o mais escuro da imagem recebe todas as camadas). Uma foto que antes saía
  escura agora sai mais clara.

## O que NÃO foi feito, ou ficou pela metade

- **Nenhum teste na máquina.** Os quatro G-codes de referência (`samples/golden`) mudaram de formato e ainda não rodaram.
- A regra "ligação coberta pela camada grossa, que vem depois" (4º caso da regra 1) não foi implementada: cada camada
  só emenda sobre a própria tinta.
- A regra "elementos soltos pequenos agrupados numa descida só" (regra 4) não existe: pontinhos soltos continuam sendo
  uma descida cada. A tela de vetorizar deixa desligar os pontinhos, e o servo descansa quando precisa.
- Importar um G-code pronto (de fora) para conferir e enviar não existe: a auditoria só roda no que o aplicativo gera.
- Em velocidade FIXA acima de F500 (os botões F1000 e F1500), segmentos muito curtos podem fazer a máquina "gaguejar":
  o limite de vazão só entra no arquivo no modo dinâmico. A F500, que é o padrão das regras, não acontece.
- A tela foi conferida em 1440 × 900 e 1366 × 768; não em celular nem em janela estreita.
