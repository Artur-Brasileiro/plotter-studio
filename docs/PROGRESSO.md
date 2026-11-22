# Progresso da v3 (trabalho da noite de 21/11/2026)

Ramo: `v3-regras-e-vetorizador`. Nada foi publicado: a versao no ar (ramo `main`) nao mudou.

Este arquivo e atualizado a cada etapa. Se o trabalho for interrompido, o estado real e o que esta aqui.

## Combinado com o Artur

- As regras de `docs/REGRAS_GCODE.md` mandam onde contradizem o gerador antigo.
- F500 fixo e o padrao; a velocidade dinamica continua existindo, desligada.
- Zona de desenho padrao X 30-570 / Y 25-370, ajustavel. O curso de 810 x 385 e o limite duro.
- Servo: media ate 30 descidas/min, pico de 45 em 60 s. Passou do limite: a maquina espera com a caneta em cima. Tudo configuravel.
- Hachura e o preenchimento preferido.
- Vetorizacao (imagem -> traco) roda dentro do Plotter Studio, no navegador.
- Nada e enviado para a maquina real durante este trabalho: so simulador e testes automaticos.

## Estado

| Etapa | Estado |
|---|---|
| 0. Preparacao (ramo, linha de base dos testes) | em andamento |
| 1. Regras do README no gerador de G-code | a fazer |
| 2. Imagem -> traco, com hachura | a fazer |
| 3. Revisao do controle da CNC | a fazer |
| 4. Interface | a fazer |
| 5. Varias canetas, retomar | se sobrar tempo |
| 6. Fotos e texto | se sobrar tempo |

## O que precisa da maquina real (para o Artur testar)

(preenchido ao longo do trabalho)
