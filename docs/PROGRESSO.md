# Progresso da v3 (trabalho da noite de 21 para 22/11/2026)

Ramo: `v3-regras-e-vetorizador`. **Nada foi publicado**: a versão no ar (ramo `main`) não mudou.
**Nada foi enviado para a máquina real**: tudo foi testado com testes automáticos, com o simulador (`?sim=1`)
e num Chrome dirigido por script. O que só a máquina pode confirmar está em [TESTES.md](TESTES.md), "Roteiro da v3".

Para ver funcionando: `npm run dev` e abrir `http://localhost:5173/?sim=1&simSpeed=20` no Chrome.

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
| 6. Texto em fonte de traço único | ver o fim deste arquivo |

Testes automáticos: 1.269 passando (eram 304 no começo da noite). `npm run build` passa.

## O que cada passo da tela faz

1. **Desenho.** "Trazer desenho" aceita SVG e imagem (PNG/JPG). A imagem abre a tela de vetorizar, com três tipos:
   *Traço* (cada linha vira um traço único), *Preto e branco* (traço fino em linha única, área cheia com contorno e
   hachura) e *Foto* (o tom vira hachura cruzada). O desenho cai dentro da folha, e dá para mover, girar, redimensionar,
   "Encaixar na folha" e escolher a **caneta** de cada desenho.
2. **Conferir.** Diz se pode ir para a máquina (verde, amarelo ou vermelho), quanto tempo leva, quanto o servo trabalha
   (média e pico, com a barra do limite) e passa as regras uma a uma. Baixa o G-code inteiro, em partes de ~25 min,
   ou a retomada a partir de um checkpoint. **Arquivo que quebra regra não baixa nem é enviado.**
3. **Plotar.** Lista o que falta antes de enviar (conectar, Home, caneta), envia, mostra o progresso, pausa, para, e
   retoma de onde parou. Com mais de uma caneta, mostra as camadas na ordem e avisa a hora de trocar.

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

Duas partes do código foram entregues a revisores que não participaram da escrita, com a tarefa de achar defeito.

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

## Decisões que tomei e que o Artur pode querer mudar

Todas são configuráveis ou fáceis de trocar.

- **Limite do servo 30 / 45** (o README pede média até 20; o Artur disse que até 30 tudo bem). Em Configurações →
  Proteção do servo dá para voltar a 20: os desenhos ficam mais lentos, com mais descanso.
- **A retomada repete o traço anterior ao que parou**, por segurança (os arquivos RETOMAR antigos repetiam ~42 movimentos).
- **Partes de ~25 min** são cortadas no primeiro checkpoint depois de 20 min; com checkpoints de 10 em 10, saem de ~20 min.
- **Descida longa**: o corte é por comprimento (900 mm = 108 s a F500). Um resto menor que 0,5 mm não ganha descida própria.
- **Emendas "por cima da tinta"** ficaram conservadoras: só emenda quando a ligação inteira cai, com certeza, sobre tinta
  que já existe. Perde-se alguma emenda; não se cria risco novo.
- **Ordem das camadas** = ordem da lista de canetas em Configurações → Canetas (verde → fina → preta).
- **Desvio da caneta fina** = 1,0 mm em X (do README). As cruzes de registro são a conferência.
- **Aquecimento com no máximo 20 ciclos** e pausas do servo com no mínimo 0,05 s nas Configurações.

## O que NÃO foi feito, ou ficou pela metade

- **Nenhum teste na máquina.** Os quatro G-codes de referência (`samples/golden`) mudaram de formato e ainda não rodaram.
- A regra "ligação coberta pela camada grossa, que vem depois" (4º caso da regra 1) não foi implementada: cada camada
  só emenda sobre a própria tinta.
- A regra "elementos soltos pequenos agrupados numa descida só" (regra 4) não existe: pontinhos soltos continuam sendo
  uma descida cada. A tela de vetorizar deixa desligar os pontinhos, e o servo descansa quando precisa.
- A auditoria confere o comprimento das descidas, não a duração: a F250 uma descida de 900 mm dura 3,6 min.
- Importar um G-code pronto (de fora) para conferir e enviar não existe: a auditoria só roda no que o aplicativo gera.
- A tela não foi testada em celular nem em janela estreita.
