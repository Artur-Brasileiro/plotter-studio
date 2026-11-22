/**
 * Segunda revisão independente — texto em letra de traço único (hershey.ts), 22/11/2026.
 *
 * - "DEFEITO n": o teste descreve o comportamento CERTO. Todos FALHAVAM no commit 01cc863 e passam desde
 *   as correções da mesma noite; ficam de guarda.
 * - "FIRME": o que foi atacado e se segurou.
 *
 * A revisão foi feita por um revisor independente, que não alterou nenhum arquivo de código.
 */
import { describe, expect, it } from "vitest";
import { flattenGeometry } from "../geometry/flatten";
import { IDENTITY } from "../geometry/mat2d";
import { distToSegment, type Vec } from "../geometry/vec";
import { FONT_DATA, type FontId } from "./fontData";
import { glyphFor, glyphsOf, polylineToSubPath, textGeometry, type TextAlign } from "./hershey";

const FONTS = Object.keys(FONT_DATA) as FontId[];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sameStroke = (a: readonly Vec[], b: readonly Vec[]) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
/** Quanto a curva suave de uma polilinha se afasta da própria polilinha (nas unidades em que ela estiver). */
function smoothDeviation(pts: readonly Vec[]): number {
  const flat = flattenGeometry({ subpaths: [polylineToSubPath(pts, true)] }, IDENTITY, 0.002)[0].points;
  let worst = 0;
  for (const p of flat) {
    let d = Infinity;
    for (let k = 1; k < pts.length; k++) d = Math.min(d, distToSegment(p, pts[k - 1], pts[k]));
    worst = Math.max(worst, d);
  }
  return worst;
}

// ======================================================================================= DEFEITOS

describe("DEFEITO 1 — Cursiva: o i com acento fica com o pingo E com o acento (hershey.ts, glyphFor)", () => {
  // "o i perde o pingo quando ganha acento" tira os traços que ficam todos acima de y = −8. Vale na
  // Simples e na Futura (pingo em y = −13 a −11). Na Cursiva o pingo fica em y = −5 a −4 e continua lá:
  // "país", "saída", "família" saem com pingo e acento.
  it("1a. í ì î ï, nas três fontes: o pingo do i não pode continuar no desenho", () => {
    const withDot: string[] = [];
    for (const f of FONTS) {
      // o pingo: o traço do "i" que cabe num quadrado de 2 unidades (o corpo tem 9 ou mais de altura)
      const dots = glyphFor(f, "i")!.strokes.filter((s) => Math.max(...s.map((p) => p.x)) - Math.min(...s.map((p) => p.x)) <= 2 && Math.max(...s.map((p) => p.y)) - Math.min(...s.map((p) => p.y)) <= 2);
      expect(dots, f).toHaveLength(1);
      for (const ch of "íìîï") if (glyphFor(f, ch)!.strokes.some((s) => sameStroke(s, dots[0]))) withDot.push(`${f} ${ch}`);
    }
    // hoje: ["cursiva í", "cursiva ì", "cursiva î", "cursiva ï"]
    expect(withDot).toEqual([]);
  });
});

describe("DEFEITO 2 — texto em forma decomposta (letra + acento separado, como vem de PDF e do macOS) perde os acentos (hershey.ts, textGeometry)", () => {
  it("2a. 'café ação' decomposto (NFD) desenha o mesmo que o normal, sem 'caractere que a letra não tem'", () => {
    const nfc = textGeometry("café ação");
    const nfd = textGeometry("café ação".normalize("NFD"));
    expect(nfc.missing).toEqual([]);
    // hoje: missing = ["́", "̧", "̃"] (sinais invisíveis no aviso da tela) e 3 traços a menos:
    // o texto sai "cafe acao"
    expect({ missing: nfd.missing, strokes: nfd.strokes }).toEqual({ missing: [], strokes: nfc.strokes });
  });
});

describe("DEFEITO 3 — 'curvas suaves' entorta o Y da Simples e da Futura (hershey.ts, polylineToSubPath)", () => {
  // O Y são 3 retas longas (dois braços e a haste). O braço esquerdo e a haste formam um traço só, com um
  // canto de 39° no meio: abaixo do limite de 55°, o canto é tratado como curva e as duas retas viram
  // Béziers. O outro braço continua reto, e a letra fica torta. Só o ângulo decide; o tamanho dos segmentos
  // (12,8 e 11 unidades, contra 2 a 4 nas curvas de verdade) não entra na conta.
  it("3a. letra feita só de retas longas continua só com retas (como o H, o V, o M e o L)", () => {
    const curved = (["simples", "futura"] as const).filter((f) => textGeometry("Y", { font: f, smooth: true }).geometry.subpaths.some((sp) => sp.segments.some((s) => s.kind === "cubic")));
    expect(curved).toEqual([]); // hoje: ["simples", "futura"]
  });
  it("3b. a haste e o braço do Y não se afastam da reta mais que 0,1 unidade (com maiúscula de 40 mm, 0,2 mm)", () => {
    for (const f of ["simples", "futura"] as const) {
      const worst = Math.max(...glyphFor(f, "Y")!.strokes.map(smoothDeviation));
      expect(worst, f).toBeLessThanOrEqual(0.1); // hoje: 0,58 unidade = 1,1 mm numa letra de 40 mm
    }
  });
});

// ========================================================================================== FIRME

describe("FIRME — acentos do português nas três fontes (hershey.ts)", () => {
  const ACCENTED = "áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ";
  it("toda letra acentuada, maiúscula e minúscula: existe, tem a largura da letra sem acento, e o sinal não encosta na letra", () => {
    for (const f of FONTS) {
      for (const ch of ACCENTED) {
        const base = glyphFor(f, ch.normalize("NFD")[0])!;
        const g = glyphFor(f, ch);
        expect(g, `${f} ${ch}`).toBeDefined();
        expect([g!.left, g!.right], `${f} ${ch}`).toEqual([base.left, base.right]);
        // os traços a mais são o sinal: acima do topo da letra (ou abaixo da linha de base, na cedilha)
        const mark = g!.strokes.filter((s) => !base.strokes.some((b) => sameStroke(s, b)));
        expect(mark.length, `${f} ${ch}`).toBeGreaterThan(0);
        const baseTop = Math.min(...base.strokes.flat().map((p) => p.y));
        for (const s of mark) {
          for (const p of s) {
            expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
            if (ch === "ç" || ch === "Ç") expect(p.y, `${f} ${ch}`).toBeGreaterThanOrEqual(9);
            else if (ch.normalize("NFD")[0] !== "i") expect(p.y, `${f} ${ch}`).toBeLessThan(baseTop);
            // e o sinal fica em cima da letra, não ao lado
            expect(p.x, `${f} ${ch}`).toBeGreaterThanOrEqual(base.left - 3);
            expect(p.x, `${f} ${ch}`).toBeLessThanOrEqual(base.right + 3);
          }
        }
      }
    }
  });
  it("frase com tudo junto: nada fica de fora em nenhuma fonte", () => {
    for (const f of FONTS) expect(textGeometry("Não é só à noite: ação, pêssego, vovô, lingüiça, ÁGUA, ÓRGÃO, AÇÚCAR, R$ 1.000,00 (50%)", { font: f }).missing, f).toEqual([]);
  });
});

describe("FIRME — textGeometry com as opções que a tela deixa escolher (hershey.ts)", () => {
  const CHARS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?()-+/'\"áàâãéêíóôõúüçÁÉÍÓÚÇ\n\n   \t“”—…°ºª☕😀​"];
  it("400 textos sorteados: coordenadas sempre finitas, tudo dentro da caixa informada, e uma descida por traço", () => {
    const r = rng(42);
    for (let c = 0; c < 400; c++) {
      const text = Array.from({ length: Math.floor(r() * 40) }, () => CHARS[Math.floor(r() * CHARS.length)]).join("");
      const capHeightMm = 1.5 + r() * r() * 298.5;
      const res = textGeometry(text, {
        font: FONTS[Math.floor(r() * 3)],
        capHeightMm,
        lineSpacing: 0.7 + r() * 1.8,
        letterSpacing: r() < 0.5 ? 0 : r() * 0.6,
        align: (["left", "center", "right"] as TextAlign[])[Math.floor(r() * 3)],
        smooth: r() < 0.7,
      });
      expect(res.strokes).toBe(res.geometry.subpaths.length);
      expect(Number.isFinite(res.width) && Number.isFinite(res.height) && res.width >= 0 && res.height >= 0, text).toBe(true);
      // a caixa é medida com tolerância de 2% da unidade da fonte
      const slack = Math.max(0.006, (capHeightMm / 21) * 0.021);
      let bad = "";
      for (const pl of flattenGeometry(res.geometry, IDENTITY, Math.max(0.01, capHeightMm / 2000))) {
        for (const p of pl.points) {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) bad = `coordenada que não é número em ${JSON.stringify(text)}`;
          else if (!(p.x >= -slack && p.x <= res.width + slack && p.y >= -slack && p.y <= res.height + slack)) bad = `${JSON.stringify(text)}: (${p.x}, ${p.y}) fora de ${res.width} x ${res.height}`;
        }
      }
      expect(bad).toBe("");
    }
  }, 60_000);
  it("vazio, só espaços, só quebras de linha e só caracteres que a fonte não tem: nenhum traço, e os que faltam são avisados", () => {
    for (const t of ["", " ", "   \t  ", "\n", "\n\n\r\n", " \n \n "]) expect(textGeometry(t), JSON.stringify(t)).toMatchObject({ width: 0, height: 0, strokes: 0, missing: [] });
    expect(textGeometry("☕😀")).toMatchObject({ strokes: 0, missing: ["☕", "😀"] });
  });
  it("linha de 20 mil caracteres e texto de 2 mil linhas: montam sem erro, com tudo finito", () => {
    const long = textGeometry("ação ".repeat(4000), { font: "cursiva" });
    expect(long.strokes).toBeGreaterThan(20000);
    expect(Number.isFinite(long.width) && long.width > 10000).toBe(true);
    const tall = textGeometry("linha\n".repeat(2000));
    expect(Number.isFinite(tall.height) && tall.height > 2000 * 12).toBe(true);
  });
});

describe("FIRME — curvas suaves nas letras de verdade (hershey.ts, polylineToSubPath)", () => {
  it("as 288 letras: a curva passa por todos os pontos da fonte e não se afasta mais que 0,3 unidade (1,4% da altura) do polígono", () => {
    let worst = 0;
    for (const f of FONTS) {
      glyphsOf(f).forEach((g, gi) => {
        const ch = String.fromCharCode(32 + gi);
        if (ch === "Y" && f !== "cursiva") return; // DEFEITO 3
        for (const s of g.strokes) {
          if (s.length < 2) continue;
          const sp = polylineToSubPath(s, true);
          expect(sp.segments.map((x) => x.to)).toEqual(s.slice(1));
          for (const seg of sp.segments) {
            if (seg.kind === "cubic") expect([seg.c1.x, seg.c1.y, seg.c2.x, seg.c2.y].every(Number.isFinite)).toBe(true);
          }
          const d = smoothDeviation(s);
          expect(d, `${f} ${ch}`).toBeLessThanOrEqual(0.3);
          worst = Math.max(worst, d);
        }
      });
    }
    expect(worst).toBeGreaterThan(0.1); // a suavização mexe mesmo nas curvas (22/11/2026: 0,25)
  });
  it("hastes retas ao lado de curvas (J, U, f, g, j, t, b, l...) continuam retas: flecha de até 0,2 unidade em segmentos de 6 ou mais", () => {
    for (const f of FONTS) {
      glyphsOf(f).forEach((g, gi) => {
        const ch = String.fromCharCode(32 + gi);
        if (ch === "Y" && f !== "cursiva") return; // DEFEITO 3
        for (const s of g.strokes) {
          if (s.length < 2) continue;
          const sp = polylineToSubPath(s, true);
          let a = sp.start;
          for (const seg of sp.segments) {
            const b = seg.to;
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            if (seg.kind === "cubic" && len >= 6) {
              const start = a;
              for (const p of flattenGeometry({ subpaths: [{ start, segments: [seg], closed: false }] }, IDENTITY, 0.002)[0].points) {
                expect(distToSegment(p, start, b), `${f} ${ch}`).toBeLessThanOrEqual(0.2); // 22/11/2026: 0,17 no pior caso
              }
            }
            a = b;
          }
        }
      });
    }
  });
});
