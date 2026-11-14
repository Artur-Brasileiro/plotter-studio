# Plotter Studio — especificação

Referência de praticidade: **LaserGRBL**. Referência de interface para plotter de caneta: o **saxi** (UI web do AxiDraw), que vale olhar para ideias de layout e de otimização de caminho.

Cada fase termina com algo que o Artur consegue usar de verdade na máquina. Como implementar cada item (interfaces, algoritmos, tarefas): [PLAN.md](PLAN.md).

---

## v1 — Compor e exportar G-code

Nesta fase o envio continua pelo LaserGRBL (que já funciona). Só uma coisa muda por vez.

### Área de trabalho
- Mesa 810 × 385 mm desenhada em escala, com grade de 10/50 mm, origem (0,0) marcada embaixo à esquerda e gabaritos A4/A3 tracejados (já existe em `src/ui/board.ts`).
- Zoom (roda do mouse) e pan (espaço + arrastar ou botão do meio). Botão "ajustar à tela".
- Régua/coordenadas do mouse em mm no rodapé.

### Desenhos
- Importar **SVG** (botão e arrastar-e-soltar arquivo na janela). Vários desenhos na mesma mesa.
  - Converter `path`, `line`, `polyline`, `polygon`, `rect`, `circle`, `ellipse` em polilinhas, respeitando os `transform` do SVG.
  - Respeitar as unidades do SVG (`mm`, `px` a 96 dpi, `viewBox`). Um SVG de 100 mm do Inkscape tem que entrar com 100 mm. SVG com tamanho em px gera aviso (o Illustrator usa 72 dpi).
  - Ignorar preenchimento (fill): a plotter só desenha contornos. Forma só com `fill` também é desenhada (o contorno dela). Texto e imagens são ignorados com aviso ("converta o texto em curvas no Inkscape").
  - Ao importar, o canto inferior esquerdo da **página** do SVG vai para o (0,0) da máquina.
- Selecionar, **arrastar, girar e redimensionar** com o mouse (alças do Fabric). Shift mantém a proporção. Arrastar uma alça não espelha o desenho.
- Painel de propriedades com campos numéricos: X, Y (canto inferior esquerdo da caixa do desenho, em mm da máquina), largura, altura (da caixa, em mm), rotação (graus, anti-horária como o operador vê), travar proporção. Com rotação fora de múltiplos de 90°, a proporção fica sempre travada. Com vários desenhos selecionados, só X e Y.
- Atalhos: Delete apaga, Ctrl+D duplica, setas movem 1 mm (Shift = 10 mm), Ctrl+Z / Ctrl+Y desfazer/refazer.
- Alinhar: centralizar na mesa, no A4 ou no A3.
- **Alerta visual** se algum desenho sair da área útil (contorno vermelho), e a exportação fica bloqueada até corrigir.
- **Sessão salva sozinha** (IndexedDB): recarregar a página ou fechar o navegador não perde os desenhos nem as posições.

### Geração de G-code
- **Modo de velocidade:**
  - **Fixo:** um F para todo o desenho (campo numérico com atalhos F500 / F1000 / F1500 / F2000).
  - **Dinâmico:** F por curvatura (reta / curva / curva fechada), com limiares configuráveis (padrão: R ≥ 100 mm reta, R ≥ 40 mm curva, abaixo disso curva fechada). Cantos vivos não ganham F próprio: quem freia neles é o GRBL. Ver regras no `CLAUDE.md`.
  - Nos dois modos, segmentos muito curtos têm o F limitado para o buffer do GRBL não esvaziar (`motion.minSegmentTimeMs`).
- **Otimização dos traços** (liga/desliga):
  - Ordem pelo vizinho mais próximo, podendo **inverter** o sentido de um traço se o fim dele estiver mais perto. Contornos fechados podem começar em qualquer vértice.
  - Juntar traços cujas pontas se tocam (distância < 0,1 mm), para não levantar a caneta à toa.
  - Mostrar quanto de deslocamento com a caneta levantada foi economizado.
- **Pré-visualização do caminho:** traços com caneta embaixo em cor sólida, deslocamentos com caneta levantada tracejados, e um "play" que anima a ordem do desenho.
- **Estimativa** de distância desenhada, distância de deslocamento e tempo total (considerar aceleração de 800 mm/s² de forma aproximada e as pausas do servo).
- **Exportar `.gcode`** com o formato abaixo.

### Formato do G-code

```gcode
; Plotter Studio - <nome do arquivo> - <data e hora>
; modo: dinamico - reta F2000 / curva F1200 / fechada F600
G21
G90
G17
M5
G4 P0.3
G0 X12.50 Y40.00
M3 S220
G4 P0.3
G1 X60.00 Y40.00 F2000
G1 X61.20 Y41.10 F1200
...
M5
G4 P0.3
G0 X0.00 Y0.00
```

- Comentários só com `;`, e sem parênteses nem dentro deles (um `( centro (60,60) )` dá erro no GRBL; nome de arquivo com parênteses sai com colchetes).
- **Arquivo inteiro em ASCII, inclusive os comentários:** sem acentos, sem "—", sem aspas curvas. O GRBL trata bytes acima de 0x7F como comandos em tempo real (ver `CLAUDE.md`).
- Coordenadas com 2 casas decimais. Só repetir o `F` quando ele mudar.
- Traços cujas pontas se tocam (< 0,1 mm) são ligados com `G1`, sem `M5`/`M3` entre eles.
- Posição final configurável (padrão: voltar a X0 Y0).

### Configurações (perfil da máquina)
- Todos os campos de `MachineProfile` (`src/core/machine.ts`): área, comandos da caneta, pausa do servo, velocidades e limiares do modo dinâmico, tolerâncias, parâmetros de movimento (velocidade máxima, aceleração, junction deviation, tempo mínimo de segmento), posição final, gabaritos de papel. Cada campo tem uma frase de ajuda e é validado.
- Salvo no `localStorage`. Botões: restaurar padrão, exportar JSON, importar JSON.

### Critérios de aceite da v1
- [ ] `samples/teste_quadrado_circulo.svg` importado em (0,0) gera um G-code equivalente ao teste feito à mão em 07/11 (quadrado de 100 mm + círculo de raio 30).
- [ ] `samples/orientacao.svg` desenhado na máquina sai **igual** à tela (não espelhado, não de cabeça para baixo).
- [ ] Um SVG de 100 × 100 mm feito no Inkscape mede 100 × 100 mm no papel.
- [x] Desenho fora da área → exportação bloqueada com mensagem clara.
- [ ] O `.gcode` gerado roda no LaserGRBL sem erros.
- [ ] `samples/curvas.svg` no modo dinâmico sai sem ondulação visível (limiares calibrados e anotados em `docs/TESTES.md`).
- [x] Recarregar a página mantém os desenhos.
- [x] `npm test` e `npm run build` passam.

---

## v2 — Enviar direto para a máquina (Web Serial)

Aqui o LaserGRBL sai de cena. Detalhes do protocolo em [GRBL.md](GRBL.md).

- Conectar / desconectar (seletor de porta do Chrome, 115200). Esperar o banner `Grbl 1.1h` antes de mandar qualquer coisa (5 s; se não vier, mandar 0x18 e esperar mais 3 s). A porta usada fica lembrada: da segunda vez, conecta sem abrir o seletor. Se a porta estiver em uso (LaserGRBL, monitor serial do Arduino), dizer isso.
- Ao conectar, ler `$$` e `$#` e **avisar** (sem corrigir nada) se a configuração divergir do perfil: área, velocidades, aceleração, `$11`, `$32` ≠ 0, `$20` ≠ 1, G54 ≠ (−810, −385).
- Painel de estado em tempo real (consulta `?` ~5×/s): estado (Idle, Run, Hold, Alarm, Home...), posição de trabalho X/Y, velocidade atual, overrides, fins de curso acionados (`Pn`). A posição da caneta também aparece na mesa.
- Botões: **Home** (`$H`), **Desbloquear** (`$X`, com aviso de que desenhar continua exigindo Home), **Ir para a origem**, **Caneta ↑ / ↓** (teste do servo), **Reset** (0x18).
- **Jog** com setas na tela e no teclado: passo 0,1 / 1 / 10 / 50 mm ou **contínuo** (segurar a tecla = um `$J=` até a borda da área, cancelado com 0x85 ao soltar ou ao sair da janela), e velocidade de jog. O destino é sempre limitado à área.
- **Contorno (frame):** percorrer o retângulo que envolve o desenho com a caneta levantada, para conferir a posição no papel antes de desenhar.
- **Enviar trabalho** com o protocolo de contagem de caracteres, com barra de progresso, tempo decorrido/restante e linha atual destacada na pré-visualização. Só começa com a máquina em Idle, **com Home feito**, G54 correto e nada fora da área. Durante o envio, a tela não apaga (Wake Lock), e fechar a aba pede confirmação.
- **Pausar:** `!`, espera parar, e **levanta a caneta** (0x9E). **Continuar:** abaixa a caneta, espera o servo, e só então `~`. Alternativa configurável (se o 0x9E não funcionar no fork do servo): pausar no fim do traço atual.
- **Parar:** `!` → espera `Hold:0` → reset (0x18). A caneta sobe com o M5 do reset e **a posição é mantida** (sem novo Home).
- **Parada de emergência** (botão vermelho, Esc): reset imediato. Com a máquina andando, gera `ALARM:3` e exige `$H`.
- `error:N` durante o trabalho: pausa na hora (`!`) e mostra a linha e a mensagem; o Artur escolhe continuar ou parar.
- Ajuste de velocidade durante o desenho (feed override: 0x90–0x94). Nunca os overrides de spindle (0x99–0x9D).
- Console com o log da serial e campo para mandar comandos manuais. `$32=1` é recusado; comandos que gravam na EEPROM (`$N=`, `$RST`, `G10`...) pedem confirmação.
- Traduzir `error:N` e `ALARM:N` para mensagens em português com o que fazer.
- Cabo desconectado: avisar na hora, sem travar, explicar o que aconteceu e nunca reconectar sozinho (reconectar reinicia o Uno).
- Registrar o tempo real de cada trabalho ao lado do estimado.
- Modo simulador (`?sim=1`): um GRBL falso no lugar da máquina, para testar e ensaiar.

### Critérios de aceite da v2
- [ ] Fluxo completo sem o LaserGRBL: conectar → Home → contorno → desenhar → fim.
- [ ] Pausar e continuar no meio de um desenho sem perder posição e sem borrar (a caneta sobe na pausa, ou a pausa espera o fim do traço).
- [ ] Parar no meio levanta a caneta e mantém a posição ("Ir para a origem" acerta sem novo Home). A parada de emergência exige novo Home.
- [ ] Desconectar o cabo no meio não trava a interface.

---

## v3 — Recursos extras (ordem a decidir com o Artur)

- **Texto** com fonte de traço único (Hershey), a mesma usada no logo do projeto.
- **Hachura** para preencher áreas (ângulo e espaçamento configuráveis).
- **Várias cores:** camadas por cor (ou por camada do Inkscape), com pausa para trocar a caneta entre elas.
- **Salvar/abrir projeto** (`.json` com os desenhos e as posições; mesmo formato da sessão salva automaticamente).
- **Retomar a partir do traço N** depois de uma falha (com Home antes).
- **Imagem → linhas** (simples: contorno ou hachura por tom de cinza). Para coisas sofisticadas, o DrawingBotV3 continua existindo.
- Extras possíveis: 2-opt na ordem dos traços, abrir e enviar um `.gcode` externo, velocidade contínua pela curvatura, uso offline (PWA).
