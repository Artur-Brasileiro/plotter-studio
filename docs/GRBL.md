# GRBL 1.1h — o que o Plotter Studio precisa saber

Referência oficial: wiki do gnea/grbl (Interface, Commands, Jogging, Error/Alarm codes). Confira lá antes de implementar algum detalhe que não esteja aqui.

## Conexão

- 115200 baud, 8N1, linhas terminadas em `\n`.
- Ao abrir a porta, o Uno reinicia (~1,5–2 s). Esperar o banner:
  ```
  Grbl 1.1h ['$' for help]
  [MSG:'$H'|'$X' to unlock]
  ```
  A segunda linha aparece porque o homing está ligado e o GRBL liga em ALARM. Até o `$H`, comandos de movimento dão `error:9`.

## Envio de um trabalho: contagem de caracteres

O GRBL do Uno tem um buffer de recepção de **128 bytes**. A forma rápida e segura de enviar (a mesma do LaserGRBL e do UGS):

1. Manter uma fila com o tamanho (em bytes, contando o `\n`) de cada linha já enviada e ainda não confirmada.
2. Só enviar a próxima linha se `soma_da_fila + tamanho_da_linha <= 127`.
3. A cada `ok` ou `error:N` recebido, tirar a linha mais antiga da fila.

Analogia: é uma caixa d'água de 127 litros. Você só despeja um balde se ele couber; a cada "ok" o GRBL avisa que esvaziou um balde.

Alternativa mais simples (para depurar): mandar uma linha, esperar o `ok`, mandar a próxima. Funciona, mas pode "gaguejar" em curvas com muitos segmentos curtos.

`error:N` durante um trabalho: pausar e mostrar a linha e a mensagem. Não seguir enviando às cegas.

## Comandos em tempo real (um byte, sem `\n`, furam a fila)

| Byte | Efeito |
|---|---|
| `?` | Pede o relatório de estado |
| `!` | Feed hold (pausa com desaceleração, sem perder posição) |
| `~` | Continua depois do hold |
| `0x18` (Ctrl-X) | Soft reset |
| `0x85` | Cancela o jog em andamento |
| `0x90` / `0x91` / `0x92` | Velocidade 100% / +10% / −10% |
| `0x93` / `0x94` | Velocidade +1% / −1% |
| `0x9E` | Liga/desliga o spindle **só em HOLD** — pode servir para **levantar a caneta durante a pausa** (testar na máquina) |

**Nunca usar os overrides de spindle (0x99–0x9D):** eles mudam o `S`, ou seja, a **posição do servo**. A caneta subiria ou desceria pela metade.

**Todo byte acima de 0x7F é interpretado como comando em tempo real**, mesmo no meio de uma linha ou de um comentário; os desconhecidos são descartados. Por isso o G-code e os comandos enviados têm que ser **só ASCII**. Exemplos de UTF-8 perigoso: "—" termina em `0x94` (velocidade −1%), "”" em `0x9D` (spindle −1% = servo se mexe), "à" em `0xA0` (liga/desliga o pino de refrigeração).

### Parar sem perder a posição
Reset (0x18) com a máquina andando gera `ALARM:3` e a posição se perde (precisa de `$H`). Para parar com segurança: mandar `!`, esperar o estado `Hold:0` (parou de vez) e só então mandar 0x18. O reset executa `M5`, então a caneta sobe.

## Relatório de estado

Exemplo:
```
<Idle|MPos:-797.500,-345.000,0.000|FS:0,0|WCO:-810.000,-385.000,0.000>
<Run|MPos:-700.120,-300.000,0.000|FS:1500,220|Ov:100,100,100>
<Alarm|MPos:0.000,0.000,0.000|FS:0,0|Pn:XY>
```

- Estados: `Idle`, `Run`, `Hold:0` (parado em pausa), `Hold:1` (desacelerando), `Jog`, `Alarm`, `Door`, `Check`, `Home`, `Sleep`.
- `MPos` é a posição de máquina (relativa ao home). A posição de trabalho (a que importa, 0..810 / 0..385) é **`WPos = MPos − WCO`**.
- `WCO` não vem em todo relatório (só de tempos em tempos ou quando muda): guardar o último valor recebido. Também dá para ler com `$#` (linha `[G54:-810.000,-385.000,0.000]`).
- `Pn:` lista os pinos acionados (`X`, `Y` = fins de curso).
- **Não alterar `$10`** para mudar o formato do relatório: isso grava na EEPROM.

## Jog

```
$J=G91 G21 X10 F3000      ; anda 10 mm em X+, relativo
$J=G90 G21 X0 Y0 F6000    ; vai para a origem de trabalho
```
- Não altera o modo G90/G91 do programa.
- Respeita o soft limit: um jog para fora da área dá `error:15` em vez de alarme.
- Para jog contínuo (segurar a tecla), mandar passos curtos repetidos e `0x85` ao soltar.

## Códigos que vão aparecer com mais frequência

| Código | Significado | O que mostrar ao Artur |
|---|---|---|
| `error:1` | Letra de comando esperada | Linha mal formatada (ex.: parênteses aninhados num comentário) |
| `error:2` | Número mal formatado | Bug no gerador de G-code |
| `error:9` | Bloqueado: GRBL em alarme ou jog | Faça o Home ($H) ou desbloqueie ($X) |
| `error:15` | Jog passaria do limite | O movimento sairia da área útil |
| `error:20` | Comando não suportado | Comando que o GRBL não conhece |
| `ALARM:1` | Fim de curso acionado (hard limit) | Hoje `$21=0`, então não deve aparecer |
| `ALARM:2` | Destino fora da área (soft limit) | O desenho saiu da área; posição perdida, refazer o Home |
| `ALARM:3` | Reset com a máquina andando | Posição perdida, refazer o Home |
| `ALARM:8` | Homing: não conseguiu se afastar da chave | Conferir a chave e o `$27` |
| `ALARM:9` | Homing: não encontrou a chave | Conferir fiação do fim de curso |

## Comandos úteis de diagnóstico

- `$$`: lista toda a configuração (útil para mostrar numa aba "Máquina", só leitura).
- `$#`: offsets (confere o G54 = −810, −385).
- `$G`: estado do parser (G90/G91, unidades, etc.).
- `$I`: versão do firmware.
