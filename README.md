# Plotter Studio

Software de G-code para a minha CNC Plotter de caneta (GRBL 1.1h + servo, área útil 810 × 385 mm).

Roda no navegador (Chrome/Edge): importa SVGs, posiciona/gira/redimensiona os desenhos na área do papel, gera G-code com velocidade fixa ou dinâmica (mais rápido nas retas, mais devagar nas curvas) e, a partir da v2, envia direto para a máquina pela serial (Web Serial API).

## Rodar localmente

```bash
npm install
npm run dev
```

Abra http://localhost:5173 no Chrome.

## Documentação

- [CLAUDE.md](CLAUDE.md) — dados da máquina, decisões de arquitetura e convenções
- [docs/SPEC.md](docs/SPEC.md) — funcionalidades e fases (v1, v2, v3)
- [docs/GRBL.md](docs/GRBL.md) — protocolo serial do GRBL usado no envio
- [docs/PLAN.md](docs/PLAN.md) — plano de implementação: arquitetura, algoritmos, testes e tarefas T01–T27

## Status

- [x] Esqueleto: mesa 810 × 385 mm com grade e gabaritos A4/A3
- [ ] v1 — compor desenhos e exportar `.gcode`
- [ ] v2 — enviar direto para a máquina
- [ ] v3 — texto, hachura, várias cores
