// No Windows, um diretório atual com o drive minúsculo (o terminal do VS Code abre em c:\...)
// faz o Vitest 5 carregar o próprio módulo duas vezes, e o describe() falha com
// "Cannot read properties of undefined (reading 'config')".
// Este script relança o Vitest com C:\ maiúsculo. Em Linux/macOS não muda nada.
// Rever ao atualizar o Vitest: quando corrigirem, dá para voltar a chamar "vitest" direto.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const bin = resolve(cwd, "node_modules/vitest/vitest.mjs");
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(r.status ?? 1);
