import { describe, expect, it } from "vitest";
import { CharCountingStreamer, prepareLine } from "./streamer";

const line20 = (i: number) => ({ text: `G1 X${String(i).padStart(3, "0")}.00 Y0.00 F2000`.slice(0, 20).padEnd(20, "0"), id: i });

describe("prepareLine", () => {
  it("tira comentários e espaços", () => {
    expect(prepareLine("G1 X1 ; oi")).toBe("G1 X1");
    expect(prepareLine("  G0 X1 (vai) Y2  ")).toBe("G0 X1  Y2");
    expect(prepareLine("(a)")).toBeNull();
    expect(prepareLine("; Plotter Studio - teste")).toBeNull();
    expect(prepareLine("")).toBeNull();
  });

  it("lança com caractere fora de ASCII e com mais de 70 caracteres", () => {
    expect(() => prepareLine("G1 X1 ç")).toThrow(/ASCII/);
    expect(() => prepareLine("G1 X1 ; coração")).not.toThrow(); // comentário sai antes
    expect(() => prepareLine("G1 " + "X".repeat(68))).toThrow(/71/);
    expect(prepareLine("G1 " + "X".repeat(67))).toHaveLength(70);
  });

  it("keepComments só confere", () => {
    expect(prepareLine("G1 X10 (a (b))", { keepComments: true })).toBe("G1 X10 (a (b))");
    expect(() => prepareLine("G1 — X", { keepComments: true })).toThrow();
  });

  it("comentários do formato novo somem inteiros (o '~' do checkpoint nunca chega ao GRBL)", () => {
    expect(prepareLine("; CHECKPOINT 3 (~30 min) re-sincroniza servo")).toBeNull();
    expect(prepareLine("; descanso do servo")).toBeNull();
    expect(prepareLine("; aquecimento do servo no ponto seguro")).toBeNull();
    expect(prepareLine("X12.34 Y56.78")).toBe("X12.34 Y56.78");
    expect(prepareLine("G1 F500")).toBe("G1 F500");
    expect(prepareLine("M2")).toBe("M2");
  });

  it("recusa ?, ! e ~ no que seria enviado: o GRBL os executa como tempo real, até dentro de comentário", () => {
    // parêntese sem fechar: o comentário não é tirado e o "~" iria junto
    expect(() => prepareLine("G0 X10 (~30 min")).toThrow(/continuar/);
    expect(() => prepareLine("G0 X10 ; pronto!", { keepComments: true })).toThrow(/feed hold/);
    expect(() => prepareLine("G0 X10 ; ok?", { keepComments: true })).toThrow(/relatório/);
    expect(prepareLine("G0 X10 ; pronto!")).toBe("G0 X10"); // no trabalho o comentário sai antes
  });
});

describe("CharCountingStreamer", () => {
  it("linhas de 20 bytes: cabem 6 (6 × 21 = 126) e a 7ª não", () => {
    const s = new CharCountingStreamer({ rxBufferBytes: 128 });
    s.enqueue(Array.from({ length: 10 }, (_, i) => line20(i)));
    expect(line20(0).text).toHaveLength(20);
    const first = s.takeSendable();
    expect(first.map((l) => l.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.pendingBytes).toBe(126);
    expect(s.takeSendable()).toEqual([]);
    expect(s.acknowledge()).toEqual({ id: 0 });
    expect(s.takeSendable().map((l) => l.id)).toEqual([6]);
    expect(s.pendingCount).toBe(6);
    expect(s.queuedCount).toBe(3);
    expect(s.nextQueuedId).toBe(7);
  });

  it("respeita o limite de id (pausa no fim do traço)", () => {
    const s = new CharCountingStreamer({ rxBufferBytes: 128 });
    s.enqueue([0, 1, 2, 3].map((id) => ({ text: "G1 X1", id })));
    expect(s.takeSendable(1).map((l) => l.id)).toEqual([0, 1]);
    expect(s.takeSendable(1)).toEqual([]);
    expect(s.takeSendable().map((l) => l.id)).toEqual([2, 3]);
  });

  it("acknowledge sem pendente devolve undefined; clear zera tudo", () => {
    const s = new CharCountingStreamer({ rxBufferBytes: 128 });
    expect(s.acknowledge()).toBeUndefined();
    s.enqueue([0, 1, 2].map((id) => ({ text: "G1 X1", id })));
    s.takeSendable(0);
    s.clearQueued();
    expect(s.queuedCount).toBe(0);
    expect(s.pendingCount).toBe(1);
    s.clear();
    expect(s.pendingCount).toBe(0);
    expect(s.pendingBytes).toBe(0);
  });

  it("setRxBufferBytes: o limite novo vale para as próximas linhas, sem perder as pendentes", () => {
    const s = new CharCountingStreamer({ rxBufferBytes: 128 });
    s.enqueue(Array.from({ length: 10 }, (_, i) => line20(i)));
    expect(s.takeSendable()).toHaveLength(6);
    s.setRxBufferBytes(64); // cabem 3 linhas de 21 bytes em 63
    for (let i = 0; i < 3; i++) s.acknowledge();
    expect(s.takeSendable()).toEqual([]); // ainda há 63 bytes fora
    s.acknowledge();
    expect(s.takeSendable().map((l) => l.id)).toEqual([6]);
    expect(s.pendingBytes).toBeLessThanOrEqual(63);
    expect(s.pendingCount).toBe(3);
  });

  it("recusa linha maior que o buffer", () => {
    const s = new CharCountingStreamer({ rxBufferBytes: 16 });
    expect(() => s.enqueue([{ text: "G1 X100.00 Y100.00", id: 0 }])).toThrow();
  });

  it("10 mil linhas: ordem preservada e nunca passa de 127 bytes", () => {
    const s = new CharCountingStreamer({ rxBufferBytes: 128 });
    s.enqueue(Array.from({ length: 10000 }, (_, i) => ({ text: `G1 X${(i * 0.2).toFixed(2)} Y1.00`, id: i })));
    const acked: number[] = [];
    for (;;) {
      s.takeSendable();
      expect(s.pendingBytes).toBeLessThanOrEqual(127);
      const a = s.acknowledge();
      if (!a) break;
      acked.push(a.id);
    }
    expect(acked).toHaveLength(10000);
    expect(acked.every((id, i) => id === i)).toBe(true);
  });
});
