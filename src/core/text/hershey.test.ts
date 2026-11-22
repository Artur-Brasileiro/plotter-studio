import { describe, expect, it } from "vitest";
import { flattenGeometry } from "../geometry/flatten";
import { IDENTITY } from "../geometry/mat2d";
import { controlBBox } from "../geometry/path";
import { FONT_DATA, type FontId } from "./fontData";
import { CAP_UNITS, glyphFor, glyphsOf, parseGlyph, polylineToSubPath, textGeometry } from "./hershey";

const FONTS = Object.keys(FONT_DATA) as FontId[];

describe("fontes Hershey", () => {
  it("cada fonte tem as 96 letras do ASCII, e toda linha tem o tamanho que ela mesma declara", () => {
    for (const f of FONTS) {
      expect(FONT_DATA[f]).toHaveLength(96);
      for (const line of FONT_DATA[f]) expect(line.length - 3).toBe(Number(line.slice(0, 3)) * 2);
    }
  });
  it("lê uma letra: o A da Futura são duas pernas e a barra", () => {
    const A = glyphsOf("futura")["A".charCodeAt(0) - 32];
    expect(A.left).toBe(-9);
    expect(A.right).toBe(9);
    expect(A.strokes).toEqual([
      [{ x: 0, y: -12 }, { x: -8, y: 9 }],
      [{ x: 0, y: -12 }, { x: 8, y: 9 }],
      [{ x: -5, y: 2 }, { x: 5, y: 2 }],
    ]);
  });
  it("' R' levanta a caneta; o espaço não tem traço", () => {
    expect(parseGlyph("  1JZ").strokes).toEqual([]);
    expect(parseGlyph("  6JZNFNM RVFVM").strokes).toHaveLength(2);
  });
  it("as maiúsculas vão de −12 a 9 nas três fontes (é o que define a altura pedida)", () => {
    for (const f of FONTS) {
      const ys = glyphFor(f, "H")!.strokes.flat().map((p) => p.y);
      expect([Math.min(...ys), Math.max(...ys)]).toEqual([-12, 9]);
    }
    expect(CAP_UNITS).toBe(21);
  });
});

describe("acentos do português", () => {
  const ALL = "áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÉÊÍÓÔÕÚÜÇÑ";
  it("toda letra acentuada existe nas três fontes: a letra mais o sinal", () => {
    for (const f of FONTS) {
      for (const ch of ALL) {
        const g = glyphFor(f, ch);
        const base = glyphFor(f, ch.normalize("NFD")[0])!;
        expect(g, `${f} ${ch}`).toBeDefined();
        expect(g!.strokes.length, `${f} ${ch}`).toBeGreaterThan(ch === "í" || ch === "ì" || ch === "î" || ch === "ï" ? 1 : base.strokes.length);
        expect(g!.right - g!.left).toBe(base.right - base.left); // o acento não muda o espaço da letra
      }
    }
  });
  it("o acento fica acima da letra e a cedilha abaixo da linha de base", () => {
    const top = (ch: string) => Math.min(...glyphFor("simples", ch)!.strokes.flat().map((p) => p.y));
    const bottom = (ch: string) => Math.max(...glyphFor("simples", ch)!.strokes.flat().map((p) => p.y));
    expect(top("á")).toBeLessThan(top("a") - 3);
    expect(top("É")).toBeLessThan(top("E") - 3);
    expect(bottom("ç")).toBeGreaterThan(bottom("c") + 3);
    expect(top("ç")).toBe(top("c"));
  });
  it("o i acentuado perde o pingo", () => {
    const dots = (ch: string) => glyphFor("simples", ch)!.strokes.filter((s) => s.every((p) => p.y <= -10 && p.y >= -14)).length;
    expect(dots("i")).toBe(1);
    expect(dots("í")).toBe(0);
  });
  it("aspas curvas, travessão e reticências viram os sinais simples; o que a fonte não tem fica de fora e é avisado", () => {
    const a = textGeometry("“Olá” — fim…");
    expect(a.missing).toEqual([]);
    const b = textGeometry("café ☕ 20°");
    expect(b.missing).toEqual(["☕"]);
    expect(textGeometry("20°", { font: "futura" }).missing).toEqual(["°"]);
  });
});

describe("textGeometry", () => {
  it("a altura da maiúscula no papel é a pedida", () => {
    const r = textGeometry("H", { capHeightMm: 30, smooth: false });
    const b = controlBBox(r.geometry);
    expect(b.maxY - b.minY).toBeCloseTo(30, 9);
    expect(b.minX).toBeGreaterThanOrEqual(0);
    expect(b.maxX).toBeLessThanOrEqual(r.width);
    expect(b.maxY).toBeLessThanOrEqual(r.height);
  });
  it("tudo fica dentro da caixa informada, com acento em maiúscula e perna de g", () => {
    for (const f of FONTS) {
      const r = textGeometry("Ágil, Çg\nÕpq", { font: f, capHeightMm: 10 });
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pl of flattenGeometry(r.geometry, IDENTITY, 0.01)) {
        for (const p of pl.points) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      }
      expect(minY, f).toBeGreaterThanOrEqual(-1e-9);
      expect(maxY, f).toBeLessThanOrEqual(r.height + 1e-9);
      expect(minX, f).toBeGreaterThanOrEqual(-1e-9);
      expect(maxX, f).toBeLessThanOrEqual(r.width + 1e-9);
    }
  });
  it("duas linhas: a segunda fica abaixo, e a largura é a da linha mais comprida", () => {
    const one = textGeometry("AAAA");
    const two = textGeometry("AAAA\nA");
    expect(two.width).toBeCloseTo(one.width, 9);
    expect(two.height).toBeGreaterThan(one.height * 1.5);
    expect(textGeometry("AAAA\nA", { lineSpacing: 2 }).height).toBeGreaterThan(two.height);
  });
  it("alinhamento: à direita e centralizado deslocam a linha curta", () => {
    const minX = (align: "left" | "center" | "right") => {
      const g = textGeometry("HHHHHH\nH", { align, smooth: false }).geometry;
      const last = g.subpaths.slice(-3); // o H da 2ª linha
      return Math.min(...last.flatMap((s) => [s.start.x, ...s.segments.map((x) => x.to.x)]));
    };
    expect(minX("left")).toBeLessThan(minX("center"));
    expect(minX("center")).toBeLessThan(minX("right"));
  });
  it("espaço entre letras alarga o texto sem mexer na altura", () => {
    const a = textGeometry("PLOTTER");
    const b = textGeometry("PLOTTER", { letterSpacing: 0.2 });
    expect(b.width).toBeGreaterThan(a.width + 5);
    expect(b.height).toBe(a.height);
  });
  it("conta as descidas da caneta: H são 3 traços, O é 1", () => {
    expect(textGeometry("H").strokes).toBe(3);
    expect(textGeometry("O").strokes).toBe(1);
    expect(textGeometry("   ").strokes).toBe(0);
    expect(textGeometry("").geometry.subpaths).toEqual([]);
  });
  it("coordenadas sempre finitas, em qualquer fonte, com todo o ASCII", () => {
    const all = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
    for (const f of FONTS) {
      const r = textGeometry(all + "\n" + all, { font: f });
      expect(r.missing).toEqual([]);
      for (const sp of r.geometry.subpaths) {
        for (const p of [sp.start, ...sp.segments.flatMap((s) => (s.kind === "line" ? [s.to] : [s.c1, s.c2, s.to]))]) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        }
      }
    }
  });
});

describe("curvas suaves", () => {
  it("reta e canto vivo continuam retos: o H e o V não ganham curva", () => {
    for (const ch of ["H", "V", "M", "L"]) {
      const kinds = textGeometry(ch, { smooth: true }).geometry.subpaths.flatMap((s) => s.segments.map((x) => x.kind));
      expect(new Set(kinds), ch).toEqual(new Set(["line"]));
    }
  });
  it("letra redonda vira curva: o O só tem Béziers e passa pelos mesmos pontos da fonte", () => {
    const smooth = textGeometry("O", { smooth: true }).geometry.subpaths[0];
    const raw = textGeometry("O", { smooth: false }).geometry.subpaths[0];
    expect(smooth.segments.every((s) => s.kind === "cubic")).toBe(true);
    // (a caixa da curva é um fio maior que a do polígono: compara a partir do 1º ponto)
    const rel = (sp: typeof raw) => sp.segments.map((s) => [Math.round((s.to.x - sp.start.x) * 1e6), Math.round((s.to.y - sp.start.y) * 1e6)]);
    expect(rel(smooth)).toEqual(rel(raw));
  });
  it("a curva suave não se afasta mais que uma fração da altura da letra do polígono original", () => {
    const k = 40 / CAP_UNITS;
    const raw = textGeometry("S", { smooth: false, capHeightMm: 40 }).geometry.subpaths[0];
    const pts = [raw.start, ...raw.segments.map((s) => s.to)];
    const sm = textGeometry("S", { smooth: true, capHeightMm: 40 }).geometry;
    // as duas caixas diferem por um fio: alinha pelo 1º ponto do traço
    const off = { x: sm.subpaths[0].start.x - raw.start.x, y: sm.subpaths[0].start.y - raw.start.y };
    const smooth = flattenGeometry(sm, IDENTITY, 0.01)[0].points.map((p) => ({ x: p.x - off.x, y: p.y - off.y }));
    const distToPoly = (p: { x: number; y: number }) => {
      let best = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
        best = Math.min(best, Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t)));
      }
      return best;
    };
    expect(Math.max(...smooth.map(distToPoly))).toBeLessThan(0.6 * k);
  });
  it("uma polilinha de 2 pontos é sempre uma reta", () => {
    const sp = polylineToSubPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], true);
    expect(sp.segments).toEqual([{ kind: "line", to: { x: 10, y: 0 } }]);
  });
});
