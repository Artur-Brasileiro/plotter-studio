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
Reset (0x18) com a máquina andando gera `ALARM:3` (durante o Home, `ALARM:6`) e a posição se perde (precisa de `$H`). Para parar com segurança: mandar `!`, esperar o estado `Hold:0` (parou de vez) e só então mandar 0x18. O reset executa `M5`, então a caneta sobe.

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
- Jog contínuo (segurar a tecla): **um único** `$J=` até a borda da área e `0x85` ao soltar. O `0x85` para com desaceleração, sem perder a posição, e descarta os jogs que estavam no planejador.
- Em `Alarm`, `$J=` responde `error:8` (só funciona em Idle/Jog). Depois de um `$X` funciona, mas a posição pode estar errada.

## Códigos que vão aparecer com mais frequência

| Código | Significado | O que mostrar ao Artur |
|---|---|---|
| `error:1` | Letra de comando esperada | Linha mal formatada (ex.: parênteses aninhados num comentário) |
| `error:2` | Número mal formatado | Bug no gerador de G-code |
| `error:9` | Bloqueado: GRBL em alarme ou jog | Faça o Home ($H) ou desbloqueie ($X) |
| `error:15` | Jog passaria do limite | O movimento sairia da área útil |
| `error:20` | Comando não suportado | Comando que o GRBL não conhece |
| `ALARM:1` | Fim de curso acionado (hard limit) | Hoje `$21=0`, então não deve aparecer |
| `ALARM:2` | Destino fora da área (soft limit) | O desenho saiu da área. O GRBL para com desaceleração e diz que a posição foi mantida; por segurança o Plotter Studio pede o Home de novo |
| `ALARM:3` | Reset com a máquina andando | Posição perdida, refazer o Home |
| `ALARM:6` | Reset durante o Home | Refazer o Home |
| `ALARM:8` | Homing: não conseguiu se afastar da chave | Conferir a chave e o `$27` |
| `ALARM:9` | Homing: não encontrou a chave | Conferir fiação do fim de curso |

## Detalhes que o envio (v2) precisou respeitar

Conferidos no fonte do GRBL 1.1 (`protocol.c`, `motion_control.c`, `system.c`) e reproduzidos no simulador (`src/core/grbl/fakeGrbl.ts`):

- **O `ok` sai quando a linha entra no planejador**, não quando termina. Uma reta longa e lenta segura o planejador cheio por muito tempo, então não existe "timeout de ok": a saúde da conexão é medida pelo relatório `?`.
- **`M3`, `M5` e `G4` esperam o planejador esvaziar** antes de executar (e o `ok` do `G4` só vem no fim da pausa). Durante um `G4` o estado é **Idle**, mesmo no meio do trabalho.
- **Durante um Hold o GRBL não lê linhas novas**: fica preso na rotina de suspensão até o `~` ou o reset.
- **`!` em Idle vira `Hold:0` na hora**; `!` durante um jog **cancela o jog** (não vira Hold).
- **O `?` e o `!` são tratados na mesma passada**, com o relatório primeiro. Por isso o primeiro relatório depois de um `!` pode ainda mostrar o estado antigo: espere `Hold:0`. Pelo mesmo motivo, um único "Idle" logo depois do último `ok` não prova que acabou: o Plotter Studio exige dois seguidos.
- **`WCO` e `Ov` não vêm em todo relatório** (parado: de 10 em 10; andando: de 30 em 30; ou quando mudam): guarde o último.
- **Em Alarm, qualquer G-code dá `error:9`**, antes mesmo de interpretar a linha.
- **Soft limit num G-code** (`G0`/`G1` fora da área) dá `ALARM:2` seguido de `[MSG:Reset to continue]`: o GRBL ignora tudo até um reset (0x18) e depois volta em Alarm.
- **Depois do Home**, a máquina se afasta da chave pelo `$27` (pull-off): a posição fica perto de 810/385, não exatamente.
- **Reset (0x18) parado** (Idle ou `Hold:0`): banner novo, posição e Home mantidos, a caneta sobe (o reset executa `M5`). **Andando** (Run, Jog ou `Hold:1`): `ALARM:3` antes do banner; **durante o Home**: `ALARM:6`. Se uma linha estava no meio da execução (um `G4`, o `$H`), o `ok` dela ainda chega **depois** do alarme e antes do banner.
- **Dois silêncios que não são placa travada** (`limits.c`, `protocol.c`): durante o `$H` o GRBL **não responde ao `?` nem ao `!`** (só o reset interrompe o Home); e depois de um `ALARM:1`/`ALARM:2` ele fica **mudo até o reset**. O Plotter Studio mostra "Home" por conta própria enquanto o `$H` não responde e não acusa "sem resposta" nesses dois casos.
- **`?`, `!` e `~` são comandos em tempo real em qualquer lugar da linha, até dentro de comentário.** Um comentário `; pronto!` enviado cru seria uma pausa. O envio tira os comentários antes de mandar e recusa linha que ainda tenha um desses; o gerador nunca os escreve no nome do arquivo.
- **Formato modal (`REGRAS_GCODE.md`)**: depois de `G1 F500`, uma linha só com `X.. Y..` é um `G1`. Se o GRBL recusar o `G1 F500` (ou o `M3`, o `M5`, o `G0`), nada muda de estado e o resto do bloco sairia errado (um traço inteiro em `G0` com a caneta no papel). Por isso um `error` numa linha que não é ponto nem `G4` **para o trabalho sozinho** (`!` → `Hold:0` → reset), em vez de oferecer "continuar mesmo assim".
- **`M2` espera o planejador esvaziar**, levanta a caneta (`M5`), volta para `G1`/`G90` e devolve os overrides a 100%; só então responde `ok`. O trabalho só é dado como terminado depois desse `ok`.
- **Um `M5` repetido não faz nada** (o GRBL só age quando o estado do spindle muda): a "subida dupla" da blindagem só mexe no servo se a primeira tiver se perdido na serial.
- **`$I` informa o buffer de recepção real**: `[OPT:V,15,128]`. O Plotter Studio lê isso ao conectar e avisa (e se adapta) se for diferente do perfil.
- **Erro de leitura na serial não é cabo solto**: ruído (FramingError, BreakError, BufferOverrun) só derruba o fluxo de leitura atual; a porta continua aberta e o Plotter Studio volta a ler. Só a desconexão de verdade encerra o trabalho.
- **0x9E (parada do spindle) só vale em Hold**. Com o "spindle" ligado (`M3`), o primeiro 0x9E desliga (a caneta deveria subir) e o segundo religa. Se o `~` vier com o spindle parado, o GRBL religa e **já sai andando**, sem esperar o servo. Por isso o Plotter Studio manda o 0x9E, espera o servo e só então o `~`.
  - **Falta testar no fork `vankesteren/grbl-servo`** (teste 9 da v2 em `TESTES.md`). Se não funcionar, use a pausa "no fim do traço".

## Comandos úteis de diagnóstico

- `$$`: lista toda a configuração (útil para mostrar numa aba "Máquina", só leitura).
- `$#`: offsets (confere o G54 = −810, −385).
- `$G`: estado do parser (G90/G91, unidades, etc.).
- `$I`: versão do firmware.
