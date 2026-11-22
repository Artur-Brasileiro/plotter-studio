# Plotter Studio

Software de G-code para a minha CNC Plotter de caneta (GRBL 1.1h + servo, área útil 810 × 390 mm).

Roda no navegador (Chrome/Edge), em três passos:

1. **Desenho**: traz um SVG, uma imagem (PNG/JPG, que vira traço de caneta ali mesmo: linha única, hachura, foto por tom) ou um texto em letra de traço único, posiciona, gira e redimensiona na folha, escolhe a caneta.
2. **Conferir**: mostra o tempo, a carga do servo e as regras de [docs/REGRAS_GCODE.md](docs/REGRAS_GCODE.md) uma a uma. Arquivo que quebra regra não sai.
3. **Plotar**: envia direto para a máquina pela serial (Web Serial API), com pausa, parada, retomada e troca de caneta entre camadas. Também dá para baixar o `.gcode` e usar o LaserGRBL.

## Abrir o programa

**Dois cliques em `Abrir Plotter Studio.bat`** (na pasta do projeto). Uma janela preta abre, e em alguns segundos o navegador abre sozinho. Deixe a janela preta aberta enquanto usa; para encerrar, feche-a.

Para treinar sem a máquina: **`Abrir Plotter Studio (simulador).bat`**. É o mesmo programa conversando com uma máquina de mentira.

Pelo terminal é a mesma coisa:

```bash
npm install
npm run dev
```

Abra http://localhost:5173 no Chrome. Versão publicada: https://artur-brasileiro.github.io/plotter-studio/

Testes: `npm test` (no Windows passa por `scripts/vitest.mjs`, que contorna um problema do Vitest com o drive `c:` minúsculo do terminal do VS Code).

### Enviar direto para a máquina (v2)

No Chrome ou no Edge, com o LaserGRBL fechado: botão **Conectar…** no topo, escolha a porta do Arduino, depois a aba **Máquina** (Home, jog, contorno, enviar, pausar, parar). O log da serial e os comandos manuais ficam no botão **Console**, no rodapé. **Esc** com a máquina andando é parada de emergência.

Para ensaiar sem a máquina, acrescente `?sim=1` na URL: o app conversa com um GRBL simulado. Dá para acelerar e provocar falhas com `&simSpeed=5`, `&simNoLift=1`, `&simError=30:20` e `&simDisconnect=200`.

## Documentação

- [CLAUDE.md](CLAUDE.md) — dados da máquina, decisões de arquitetura e convenções
- [docs/SPEC.md](docs/SPEC.md) — funcionalidades e fases (v1, v2, v3)
- [docs/REGRAS_GCODE.md](docs/REGRAS_GCODE.md) — as regras de G-code desta máquina (formato, servo, blindagem, canetas). **Mandam em tudo.**
- [docs/V3.md](docs/V3.md) — desenho da v3: regras no gerador, imagem → traço, camadas
- [docs/PROGRESSO.md](docs/PROGRESSO.md) — o que está pronto, o que foi medido e o que falta
- [docs/GRBL.md](docs/GRBL.md) — protocolo serial do GRBL usado no envio
- [docs/TESTES.md](docs/TESTES.md) — roteiros de teste na máquina (v1, v2 e v3)
- [docs/PLAN.md](docs/PLAN.md) — plano de implementação: arquitetura, algoritmos, testes e tarefas T01–T27

## Status

- [x] Esqueleto: mesa 810 × 390 mm com grade e gabaritos A4/A3
- [x] v1 — compor desenhos e exportar `.gcode` (software pronto em 14/11/2026; falta o roteiro de testes na máquina: [docs/TESTES.md](docs/TESTES.md))
- [x] v2 — enviar direto para a máquina (software pronto em 14/11/2026, testado no simulador; falta o roteiro na máquina: [docs/TESTES.md](docs/TESTES.md))
- [x] v3 — regras de G-code no gerador, auditoria, imagem → traço com hachura, várias canetas, retomada (software pronto em 22/11/2026 no ramo `v3-regras-e-vetorizador`, testado no simulador; **falta o roteiro na máquina**: [docs/TESTES.md](docs/TESTES.md))
