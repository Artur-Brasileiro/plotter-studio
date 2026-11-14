// Gera dois SVGs de teste (determinísticos) em samples/:
//
//  estresse.svg  20 mil traços pequenos + curvas densas, para medir o DESEMPENHO DA INTERFACE
//                (arrastar, planejar). NÃO é para desenhar: só as pausas do servo levariam horas.
//  buffer.svg    poucas curvas, mas amostradas a cada 0,05 mm (como SVGs gerados a partir de imagem),
//                para o teste de "gagueira" na máquina: o buffer de ~15 movimentos do GRBL não pode esvaziar.
//
// Uso: node scripts/make-stress-svg.mjs
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const out = (name) => resolve(import.meta.dirname, "..", "samples", name);
const f = (v) => (Math.round(v * 1000) / 1000).toString();
const poly = (pts) => `<polyline points="${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}"/>`;

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

// ---------- estresse.svg (600 × 300 mm)
{
  const parts = [];
  // 20 mil traços curtos (3 pontos, 1–4 mm), espalhados
  for (let i = 0; i < 20_000; i++) {
    const x = 10 + rnd() * 580, y = 10 + rnd() * 280;
    const a = rnd() * Math.PI * 2, l = 1 + rnd() * 3;
    parts.push(poly([[x, y], [x + Math.cos(a) * l, y + Math.sin(a) * l], [x + Math.cos(a + 1) * l * 1.5, y + Math.sin(a + 1) * l * 1.5]]));
  }
  // curvas densas: espiral de 40 voltas amostrada a cada 0,05 mm
  const spiral = [];
  for (let t = 0, r = 2; r < 140; t += 0.05 / Math.max(r, 1)) {
    r = 2 + (t / (2 * Math.PI)) * 3.5;
    spiral.push([300 + r * Math.cos(t), 150 + r * Math.sin(t)]);
  }
  parts.push(poly(spiral));
  writeFileSync(
    out("estresse.svg"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Gerado por scripts/make-stress-svg.mjs: teste de desempenho da interface (não é para desenhar). -->\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="600mm" height="300mm" viewBox="0 0 600 300">\n<g fill="none" stroke="black" stroke-width="0.3">\n${parts.join("\n")}\n</g>\n</svg>\n`,
  );
  console.log(`estresse.svg: ${parts.length} elementos, espiral com ${spiral.length} pontos`);
}

// ---------- buffer.svg (300 × 150 mm)
{
  const parts = [];
  // 1) rosácea r = 45·cos(5θ), amostrada a cada ~0,05 mm
  const rose = [];
  for (let i = 0; i <= 20_000; i++) {
    const th = (i / 20_000) * Math.PI;
    const r = 45 * Math.cos(5 * th);
    rose.push([75 + r * Math.cos(th), 75 + r * Math.sin(th)]);
  }
  parts.push(poly(rose));
  // 2) "escrita" em zigue-zague: onda de 3 mm de amplitude e 3 mm de período, amostrada a cada 0,05 mm
  for (let row = 0; row < 4; row++) {
    const pts = [];
    for (let x = 0; x <= 120; x += 0.05) pts.push([160 + x, 25 + row * 30 + 3 * Math.sin((x * 2 * Math.PI) / 3)]);
    parts.push(poly(pts));
  }
  // 3) espiral de 12 voltas, de r = 1 a r = 25 mm, amostrada a cada 0,05 mm
  const sp = [];
  for (let t = 0, r = 1; r < 25; t += 0.05 / r) {
    r = 1 + (t / (2 * Math.PI)) * 2;
    sp.push([75 + 0 + r * Math.cos(t), 75 + r * Math.sin(t)]);
  }
  parts.push(`<g transform="translate(150,0)">${poly(sp)}</g>`);
  writeFileSync(
    out("buffer.svg"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Gerado por scripts/make-stress-svg.mjs: teste de buffer do GRBL (segmentos densos). -->\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="150mm" viewBox="0 0 300 150">\n<g fill="none" stroke="black" stroke-width="0.3">\n${parts.join("\n")}\n</g>\n</svg>\n`,
  );
  console.log(`buffer.svg: rosácea ${rose.length} pontos, 4 ondas, espiral ${sp.length} pontos`);
}
