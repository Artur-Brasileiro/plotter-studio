# Plotter Studio

Software de G-code para a minha CNC Plotter de caneta (GRBL 1.1h + servo, área útil 810 × 385 mm).

Roda no navegador (Chrome/Edge): importa SVGs, posiciona/gira/redimensiona os desenhos na área do papel, gera G-code com velocidade fixa ou dinâmica (mais rápido nas retas, mais devagar nas curvas) e, a partir da v2, envia direto para a máquina pela serial (Web Serial API).

## Rodar localmente

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
- [docs/GRBL.md](docs/GRBL.md) — protocolo serial do GRBL usado no envio
- [docs/PLAN.md](docs/PLAN.md) — plano de implementação: arquitetura, algoritmos, testes e tarefas T01–T27

## Status

- [x] Esqueleto: mesa 810 × 385 mm com grade e gabaritos A4/A3
- [x] v1 — compor desenhos e exportar `.gcode` (software pronto em 14/11/2026; falta o roteiro de testes na máquina: [docs/TESTES.md](docs/TESTES.md))
- [x] v2 — enviar direto para a máquina (software pronto em 14/11/2026, testado no simulador; falta o roteiro na máquina: [docs/TESTES.md](docs/TESTES.md))
- [ ] v3 — texto, hachura, várias cores
