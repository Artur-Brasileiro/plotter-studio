# Progresso da v3 (trabalho da noite de 21 para 22/11/2026)

Ramo: `v3-regras-e-vetorizador`. Nada foi publicado: a versao no ar (ramo `main`) nao mudou.
Nada foi enviado para a maquina real: tudo foi testado com testes automaticos, com o simulador (`?sim=1`)
e num Chrome dirigido por script.

Este arquivo e atualizado a cada etapa. Se o trabalho for interrompido, o estado real e o que esta aqui.

## Combinado com o Artur

- As regras de `docs/REGRAS_GCODE.md` mandam onde contradizem o gerador antigo.
- F500 fixo e o padrao; a velocidade dinamica continua existindo, desligada.
- Zona de desenho padrao X 30-570 / Y 25-370, ajustavel. O curso de 810 x 385 e o limite duro.
- Servo: media ate 30 descidas/min, pico de 45 em 60 s. Passou do limite: a maquina espera com a caneta em cima.
  Tudo configuravel em Configuracoes -> Protecao do servo.
- Hachura e o preenchimento preferido.
- Vetorizacao (imagem -> traco) roda dentro do Plotter Studio, no navegador.

## Estado

| Etapa | Estado |
|---|---|
| 0. Preparacao (ramo, linha de base: 304 testes passando) | pronto |
| 1. Regras do README no gerador de G-code + auditoria | pronto no nucleo e na tela (ver abaixo) |
| 2. Imagem -> traco (linha unica, preto e branco com hachura, foto por tom) | funcionando no navegador; falta ligar a "regua" |
| 3. Revisao do controle da CNC | em andamento (revisor independente) |
| 4. Interface nova | passos Desenho / Conferir / Plotar, Configuracoes e tela de vetorizar prontos; falta o passo Plotar |
| 5. Varias canetas, retomar | a fazer |
| 6. Texto em fonte de traco unico | a fazer (se sobrar tempo) |

## O que foi medido

- **Auditoria x historico do README.** A auditoria nova, rodada nos arquivos reais de
  `D:\CNC Plotter - Desenhos\G-codes - Desenhos`, da os mesmos numeros da tabela de `REGRAS_GCODE.md`:
  senna fina 20,5/min, pico 36, 15% curtas, 89% embaixo (identico); senna grossa 14,2 / 30 / 25% / 93% (identico);
  grossa v7 15,0 / 46 / 46% / 92% (o README diz pico 45). "Descida curta" = caneta embaixo menos de 1 s contando
  a pausa de 0,3 s depois de descer.
- **Tracador TypeScript x laboratorio Python.** Nas imagens reais (castelo e F16) o resultado e identico:
  mesmos 2.224 tracos e 264 pontos no castelo, mesmas coordenadas, diferenca de 0,00% dos pixels.
  Tempo: 4,6 s no navegador contra 18 s no Python.
- **O filtro de ruido NLM do laboratorio nao foi portado**: sem ele o tracado muda menos de 2%.
- **Castelo de amostra, 503 x 335 mm, caneta 0,4:** 2.159 descidas, 29 m de traco, 1 h 35 min,
  media 22,8 descidas/min, pico 44 (limite 45), com 6 min de descanso do servo distribuidos.

## O que precisa da maquina real (para o Artur testar)

(lista final em `docs/TESTES.md`, secao v3)

- Os goldens de `samples/golden` mudaram para o formato novo e ainda NAO rodaram na maquina.
- O descanso do servo e um `G4` longo com a caneta em cima: conferir se o servo fica frio e em silencio.
