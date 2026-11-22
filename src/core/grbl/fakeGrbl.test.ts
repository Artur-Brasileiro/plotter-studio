import { describe, expect, it } from "vitest";
import { generateGcode } from "../job/gcode";
import { planJob } from "../job/pipeline";
import { DEFAULT_PROFILE } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { docFrom, orientacaoSvg } from "../testing/samples";
import { expectedStrokes, expectSameStrokes } from "../testing/strokes";
import { ManualClock } from "./clock";
import { FakeGrbl, type FakeGrblOptions } from "./fakeGrbl";
import { asciiBytes, LineSplitter, parseLine, RT } from "./protocol";
import { CharCountingStreamer, prepareLine } from "./streamer";
import { inked, regrasLines, taps } from "./testPrograms";

const AREA = { width: 810, height: 385 };
const BANNER = "Grbl 1.1h ['$' for help]";
const LOCKED = "[MSG:'$H'|'$X' to unlock]";

/** Host mínimo: contagem de caracteres à mão, sem o controlador. */
class TestHost {
  readonly lines: string[] = [];
  readonly results: string[] = [];
  readonly streamer = new CharCountingStreamer({ rxBufferBytes: 128 });
  private readonly splitter = new LineSplitter();
  private nextId = 0;

  constructor(private readonly fake: FakeGrbl) {
    fake.onData = (c) => {
      for (const l of this.splitter.push(c)) {
        this.lines.push(l);
        const m = parseLine(l);
        if (m.type === "ok" || m.type === "error") {
          this.streamer.acknowledge();
          this.results.push(m.type === "ok" ? "ok" : `error:${m.code}`);
          this.pump();
        }
      }
    };
  }

  /** Como o aplicativo manda um trabalho: sem comentários nem linhas vazias. */
  send(...lines: string[]) {
    this.sendRaw(...lines.map((l) => prepareLine(l)).filter((t): t is string => t !== null));
  }

  /** O texto como está (comentários, linha vazia...), para ver o que o GRBL responde. */
  sendRaw(...lines: string[]) {
    this.streamer.enqueue(lines.map((text) => ({ text, id: this.nextId++ })));
    this.pump();
  }

  rt(byte: number) {
    void this.fake.write(Uint8Array.of(byte));
  }

  pump() {
    const s = this.streamer.takeSendable();
    if (s.length) void this.fake.write(asciiBytes(s.map((l) => l.text + "\n").join("")));
  }

  get done(): boolean {
    return this.streamer.pendingCount === 0 && this.streamer.queuedCount === 0;
  }

  get reports(): string[] {
    return this.lines.filter((l) => l.startsWith("<"));
  }
}

async function boot(opts: Partial<FakeGrblOptions> = {}) {
  const clock = new ManualClock();
  const fake = new FakeGrbl(clock, { workArea: AREA, ...opts });
  const host = new TestHost(fake);
  await fake.open();
  await clock.advance(1600);
  return { clock, fake, host };
}

async function homed(opts: Partial<FakeGrblOptions> = {}) {
  const b = await boot(opts);
  b.host.send("$H");
  await b.clock.advance(2100);
  return b;
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** Manda e espera tudo ser confirmado e a máquina parar. */
async function run(b: Booted, lines: string[], maxMs = 60_000) {
  b.host.send(...lines);
  expect(await b.clock.advanceUntil(() => b.host.done && b.fake.state === "Idle", maxMs, 10)).toBe(true);
}

describe("FakeGrbl: ligar, Home e configuração", () => {
  it("abre como o Uno: reinicia, manda o banner e fica em Alarm, com a posição zerada", async () => {
    const { host, fake, clock } = await boot();
    expect(host.lines).toEqual([BANNER, LOCKED]);
    expect(fake.state).toBe("Alarm");
    expect(fake.wpos).toEqual({ x: 810, y: 385 }); // MPos (0,0): o GRBL não sabe onde a máquina está
    host.send("G0 X10 Y10");
    host.send("$J=G91 X1 F100");
    host.send("$$");
    await clock.advance(0);
    expect(host.results).toEqual(["error:9", "error:8", "ok"]);
  });

  it("$H: nenhum relatório durante o homing; um só, como Home, no fim; depois Idle afastado 1 mm da chave", async () => {
    const { host, fake, clock } = await boot();
    host.send("$H");
    await clock.advance(1000);
    expect(fake.state).toBe("Home");
    host.rt(RT.STATUS);
    host.rt(RT.STATUS);
    host.rt(RT.STATUS);
    await clock.advance(500);
    expect(host.reports).toEqual([]); // limits_go_home() não atende o "?"
    await clock.advance(600);
    expect(fake.state).toBe("Idle");
    expect(fake.wpos).toEqual({ x: 809, y: 384 });
    expect(host.results).toEqual(["ok"]);
    expect(host.reports).toHaveLength(1);
    expect(host.reports[0]).toMatch(/^<Home\|MPos:-1\.000,-1\.000,0\.000\|/);
    expect(host.lines.indexOf(host.reports[0])).toBeLessThan(host.lines.lastIndexOf("ok"));
    expect(fake.statusQueries).toBe(3);
    expect(fake.statusReports).toBe(1);
  });

  it("falha no homing (chave não encontrada): ALARM:9, o ok do $H, banner e Alarm de novo", async () => {
    const { host, fake, clock } = await boot({ faults: { homingAlarm: 9 } });
    host.send("$H");
    await clock.advance(2100);
    expect(host.lines.slice(2)).toEqual(["ALARM:9", "ok", BANNER, LOCKED]);
    expect(fake.state).toBe("Alarm");
  });

  it("$$ e $# coerentes com a máquina", async () => {
    const { host, clock } = await boot({ settings: { 32: "1" } });
    host.send("$$", "$#");
    await clock.advance(10);
    expect(host.lines).toContain("$130=810.000");
    expect(host.lines).toContain("$32=1");
    expect(host.lines).toContain("[G54:-810.000,-385.000,0.000]");
    expect(host.results).toEqual(["ok", "ok"]);
  });

  it("depois do reset o S volta a 0: um M3 sozinho não desce a caneta", async () => {
    const { host, fake, clock } = await homed();
    host.send("M3 S220");
    await clock.advance(10);
    expect(fake.penDown).toBe(true);
    host.rt(RT.RESET);
    await clock.advance(10);
    expect(fake.state).toBe("Idle");
    expect(fake.penDown).toBe(false);
    host.send("M3", "$G");
    await clock.advance(10);
    expect(fake.penDown).toBe(false);
    expect(host.lines).toContain("[GC:G0 G54 G17 G21 G90 G94 M3 M9 T0 F0 S0]");
  });
});

describe("FakeGrbl: relatório de estado", () => {
  it("WCO no 1º relatório, Ov (com A:S) no seguinte; parado voltam de 10 em 10", async () => {
    const { host, clock } = await homed();
    for (let i = 0; i < 12; i++) {
      host.rt(RT.STATUS);
      await clock.advance(1);
    }
    const r = host.reports;
    expect(r).toHaveLength(12);
    const withWco = r.flatMap((l, i) => (l.includes("|WCO:") ? [i] : []));
    const withOv = r.flatMap((l, i) => (l.includes("|Ov:") ? [i] : []));
    expect(withWco).toEqual([0, 10]);
    expect(withOv).toEqual([1, 11]);
    expect(r[0]).toBe("<Idle|MPos:-1.000,-1.000,0.000|FS:0,0|WCO:-810.000,-385.000,0.000>");
    expect(r[1]).toBe("<Idle|MPos:-1.000,-1.000,0.000|FS:0,0|Ov:100,100,100|A:S>");
    expect(r[2]).toBe("<Idle|MPos:-1.000,-1.000,0.000|FS:0,0>");
  });

  it("em movimento o WCO só volta de 30 em 30 relatórios", async () => {
    const { host, clock } = await homed();
    host.send("G1 X0 Y384 F600"); // 809 mm a 10 mm/s
    await clock.advance(50);
    for (let i = 0; i < 70; i++) {
      host.rt(RT.STATUS);
      await clock.advance(1);
    }
    const withWco = host.reports.flatMap((l, i) => (l.includes("|WCO:") ? [i] : []));
    expect(host.reports.every((l) => l.startsWith("<Run|"))).toBe(true);
    expect(withWco).toEqual([0, 30, 60]);
  });

  it("$10=0 relata WPos; $10=3 relata MPos e o Bf", async () => {
    const a = await boot({ settings: { 10: "0" } });
    a.host.rt(RT.STATUS);
    await a.clock.advance(1);
    expect(a.host.reports[0]).toBe("<Alarm|WPos:810.000,385.000,0.000|FS:0,0|WCO:-810.000,-385.000,0.000>");
    const b = await boot({ settings: { 10: "3" } });
    b.host.rt(RT.STATUS);
    await b.clock.advance(1);
    expect(b.host.reports[0]).toBe("<Alarm|MPos:0.000,0.000,0.000|Bf:15,128|FS:0,0|WCO:-810.000,-385.000,0.000>");
  });
});

describe("FakeGrbl: G-code modal (formato de docs/REGRAS_GCODE.md)", () => {
  it("'G1 F600' sozinho só muda o modo; as linhas só com X/Y andam em G1 nessa velocidade; F na linha troca a velocidade", async () => {
    const b = await homed();
    const { host, fake, clock } = b;
    await run(b, ["G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F600"]);
    expect(host.results.every((r) => r === "ok")).toBe(true);
    expect(fake.modalMotion).toBe("G1");
    expect(fake.wpos).toEqual({ x: 100, y: 100 }); // o G1 F600 não andou

    host.send("X110.00 Y100.00"); // 10 mm a F600 = 1 s
    await clock.advance(500);
    expect(fake.wpos.x).toBeGreaterThan(104);
    expect(fake.wpos.x).toBeLessThan(106);
    await clock.advance(600);
    expect(fake.wpos).toEqual({ x: 110, y: 100 });

    host.send("X110.00 Y112.00 F1200"); // 12 mm a F1200 = 0,6 s
    await clock.advance(300);
    expect(fake.wpos.y).toBeGreaterThan(105);
    expect(fake.wpos.y).toBeLessThan(107);
    await clock.advance(400);
    expect(fake.wpos).toEqual({ x: 110, y: 112 });

    await run(b, ["Y120.00"]); // só um eixo: o outro fica
    expect(fake.wpos).toEqual({ x: 110, y: 120 });
    expect(host.results.every((r) => r === "ok")).toBe(true);
    expect(fake.penStrokes).toEqual([[{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 112 }, { x: 110, y: 120 }]]);
  });

  it("'G0 X.. Y..' volta o modo para G0: a linha seguinte só com X/Y é um deslocamento rápido", async () => {
    const b = await homed();
    const { host, fake, clock } = b;
    await run(b, ["G0 X100.00 Y100.00", "G1 F600", "X101.00 Y100.00", "G0 X200.00 Y100.00"]);
    expect(fake.modalMotion).toBe("G0");
    host.send("X400.00 Y100.00"); // 200 mm: 1 s em G0 (12000 mm/min); em G1 F600 seriam 20 s
    await clock.advance(1100);
    expect(fake.wpos).toEqual({ x: 400, y: 100 });
    expect(host.results.every((r) => r === "ok")).toBe(true);
  });

  it("depois de ligar o modo é G0 e não há F: G1 sem F dá error:22 e não muda nada", async () => {
    const b = await homed();
    const { host, fake, clock } = b;
    host.send("G1 X10 Y10", "G1");
    await clock.advance(10);
    expect(host.results.slice(1)).toEqual(["error:22", "error:22"]);
    expect(fake.modalMotion).toBe("G0");
    expect(fake.state).toBe("Idle");
    await run(b, ["X800.00 Y380.00"]); // ainda G0
    expect(fake.wpos).toEqual({ x: 800, y: 380 });
  });

  it("linha com erro não muda o estado: dois comandos do mesmo grupo (21), palavra repetida (25), F negativo (4)", async () => {
    const { host, fake, clock } = await homed();
    host.send("G1 F500", "G0 G1 X5", "G0 X5 X6", "G0 X5 F-1", "G90 G91", "M3 M5");
    await clock.advance(10);
    expect(host.results.slice(1)).toEqual(["ok", "error:21", "error:25", "error:4", "error:21", "error:21"]);
    expect(fake.modalMotion).toBe("G1");
    expect(fake.wpos).toEqual({ x: 809, y: 384 });
    expect(fake.penDown).toBe(false);
  });

  it("M2: espera o movimento acabar, sobe a caneta, volta para G1/G90 e override 100%, avisa [MSG:Pgm End]; o F fica", async () => {
    const b = await homed();
    const { host, fake, clock } = b;
    await run(b, ["G0 X700.00 Y300.00"]);
    host.rt(RT.FEED_PLUS_10);
    expect(fake.feedOverride).toBe(110);
    const before = host.results.length;
    host.send("M3 S220", "G4 P0.1", "G1 F6000", "G91", "X-100.00", "M2"); // 100 mm a 110 mm/s
    await clock.advance(300);
    expect(host.results.length - before).toBe(5); // o M2 ainda não respondeu: espera o planejador esvaziar
    expect(fake.penDown).toBe(true);
    expect(host.lines).not.toContain("[MSG:Pgm End]");
    await clock.advance(1000);
    expect(host.results.length - before).toBe(6);
    expect(host.lines.slice(-2)).toEqual(["[MSG:Pgm End]", "ok"]);
    expect(fake.wpos).toEqual({ x: 600, y: 300 });
    expect(fake.penDown).toBe(false); // sem nenhum M5 na linha
    expect(fake.feedOverride).toBe(100);
    expect(fake.modalMotion).toBe("G1"); // não G0!
    // G90 de volta e F6000 guardado: X650 é absoluto e anda como G1 (50 mm em 0,5 s; em G91 daria ALARM:2)
    host.send("X650.00");
    await clock.advance(300);
    expect(fake.wpos.x).toBeGreaterThan(620);
    expect(fake.wpos.x).toBeLessThan(640);
    await clock.advance(300);
    expect(fake.wpos).toEqual({ x: 650, y: 300 });
    expect(fake.penStrokes).toEqual([[{ x: 700, y: 300 }, { x: 600, y: 300 }]]);
  });

  it("M0 pausa o programa (Hold:0) e só responde ok depois do ~", async () => {
    const { host, fake, clock } = await homed();
    host.send("M0", "G0 X100 Y100");
    await clock.advance(200);
    expect(fake.stateText).toBe("Hold:0");
    expect(host.results).toEqual(["ok"]);
    host.rt(RT.RESUME);
    await clock.advance(50);
    expect(host.results).toEqual(["ok", "ok", "ok"]);
    expect(fake.state).toBe("Run");
  });
});

describe("FakeGrbl: caneta e pausas (G4)", () => {
  it("aquecimento do servo: 8 ciclos M3/G4/M5/G4 sem movimento, cada ok no fim da sua pausa", async () => {
    const b = await homed();
    const { host, fake, clock } = b;
    await run(b, ["G0 X0.00 Y0.00"]);
    const t0 = clock.now();
    const cycle = ["M3 S220", "G4 P0.4", "M5", "G4 P0.4"];
    await run(b, [...Array.from({ length: 8 }, () => cycle).flat(), "G4 P1"]);
    expect(clock.now() - t0).toBeGreaterThanOrEqual(8 * 800 + 1000);
    expect(clock.now() - t0).toBeLessThan(8 * 800 + 1000 + 100);
    expect(host.results.every((r) => r === "ok")).toBe(true);
    expect(taps(fake.penStrokes)).toEqual(Array.from({ length: 8 }, () => ({ x: 0, y: 0 })));
    expect(inked(fake.penStrokes)).toEqual([]);
    expect(fake.penDown).toBe(false);
  });

  it("subida dupla: o 2º M5 não muda nada e responde na hora, mesmo com a máquina andando; o M3 espera", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X400.00 Y200.00", "M5"); // ~2,2 s de deslocamento
    await clock.advance(50);
    expect(fake.state).toBe("Run");
    expect(host.results).toEqual(["ok", "ok", "ok"]); // $H, G0 e o M5 repetido
    host.send("M3 S220");
    await clock.advance(1000);
    expect(host.results).toHaveLength(3); // o M3 muda o estado: espera o planejador esvaziar
    expect(fake.penDown).toBe(false);
    await clock.advance(1500);
    expect(host.results).toHaveLength(4);
    expect(fake.penDown).toBe(true);
    expect(fake.wpos).toEqual({ x: 400, y: 200 });
    host.send("G4 P0.3", "M5", "G4 P0.2", "M5", "G4 P0.2");
    await clock.advance(710);
    expect(host.results).toHaveLength(9);
    expect(host.results.every((r) => r === "ok")).toBe(true);
    expect(fake.penDown).toBe(false);
  });

  it("G4 conta em passos de 50 ms, para cima", async () => {
    const { host, clock } = await homed();
    host.send("G4 P0.01");
    await clock.advance(40);
    expect(host.results).toHaveLength(1);
    await clock.advance(20);
    expect(host.results).toHaveLength(2);
    host.send("G4 P0");
    await clock.advance(1);
    expect(host.results).toHaveLength(3);
    host.send("G4");
    await clock.advance(1);
    expect(host.results[3]).toBe("error:28");
  });

  it("G4 P45 com a caneta em cima: Idle o tempo todo; ! congela a contagem (Hold:0) e ~ continua de onde parou", async () => {
    const { host, fake, clock } = await homed();
    host.send("G4 P45", "G0 X100.00 Y100.00");
    await clock.advance(21_000);
    expect(fake.dwelling).toBe(true);
    expect(fake.state).toBe("Idle");
    expect(host.results).toEqual(["ok"]);
    host.rt(RT.STATUS);
    await clock.advance(1);
    expect(host.reports[0]).toMatch(/^<Idle\|/);

    host.rt(RT.HOLD);
    expect(fake.stateText).toBe("Hold:0");
    await clock.advance(30_000); // meia hora parado não gasta a pausa
    expect(fake.dwelling).toBe(true);
    expect(host.results).toEqual(["ok"]);
    host.rt(RT.RESUME);
    expect(fake.state).toBe("Idle");
    await clock.advance(23_000); // 21 + 23 = 44 s de pausa
    expect(host.results).toEqual(["ok"]);
    await clock.advance(1_100);
    expect(host.results).toEqual(["ok", "ok", "ok"]); // o G4 e, logo depois, o G0
    expect(fake.state).toBe("Run");
  });

  it("reset no meio de um G4: sem alarme, posição mantida; sai o ok atrasado do G4 e o resto do buffer some", async () => {
    const b = await homed();
    const { host, fake, clock } = b;
    await run(b, ["G0 X100.00 Y100.00"]);
    const n = host.lines.length;
    host.send("G4 P45", "G0 X200.00 Y200.00");
    await clock.advance(5000);
    host.rt(RT.RESET);
    await clock.advance(10);
    expect(host.lines.slice(n)).toEqual(["ok", BANNER]);
    expect(fake.state).toBe("Idle");
    await clock.advance(60_000);
    expect(fake.wpos).toEqual({ x: 100, y: 100 });
    expect(fake.dwelling).toBe(false);
  });
});

describe("FakeGrbl: comentários, linhas vazias e limites da linha", () => {
  it("linha só com comentário, vazia ou só com espaços responde ok (até em Alarm); o ~ e o ? do comentário viram tempo real", async () => {
    const { host, fake, clock } = await boot();
    host.sendRaw("; CHECKPOINT 3 (~30 min) re-sincroniza servo", "(so comentario)", "", "   ", "; pronto?");
    await clock.advance(10);
    expect(host.results).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    // por isso o aplicativo tira os comentários antes de mandar: o "~" é "continuar" e o "?" pede relatório
    expect(fake.rtLog.map((e) => e.byte)).toEqual([RT.RESUME]);
    expect(host.reports).toHaveLength(1);
    expect(fake.gcodeLinesReceived).toBe(0);
  });

  it("\\r\\n são duas linhas para o GRBL: dois ok", async () => {
    const { host, fake, clock } = await homed();
    await fake.write(asciiBytes("G21\r\n"));
    await clock.advance(10);
    expect(host.results).toEqual(["ok", "ok", "ok"]);
  });

  it("mais de 79 caracteres úteis: error:11 e a linha não executa; comentário e espaços não contam", async () => {
    const { host, fake, clock } = await homed();
    host.sendRaw("G0 X" + "1".repeat(80));
    host.sendRaw("G0 X100 Y100 ; " + "comentario ".repeat(9));
    await clock.advance(10);
    expect(host.results.slice(1)).toEqual(["error:11", "ok"]);
    expect(fake.state).toBe("Run");
  });

  it("parênteses aninhados (enviados crus, como no console): sobra um ')' fora do comentário → error:1", async () => {
    const { host, fake, clock } = await homed();
    host.sendRaw("G1 X10 (a (b))");
    await clock.advance(10);
    expect(host.results[1]).toBe("error:1");
    expect(fake.state).toBe("Idle");
  });
});

describe("FakeGrbl: envio de um programa", () => {
  it("executa o G-code do gerador (orientacao) pela contagem de caracteres, sem estourar o buffer", async () => {
    const { host, fake, clock } = await homed();
    const plan = planJob(docFrom(orientacaoSvg), DEFAULT_PROFILE, DEFAULT_JOB_SETTINGS);
    const program = generateGcode(plan, DEFAULT_PROFILE, { fileName: "orientacao.svg", date: new Date(2026, 10, 14), job: DEFAULT_JOB_SETTINGS });
    host.send(...program.lines.map((l) => l.text));
    const ok = await clock.advanceUntil(() => host.done && fake.state === "Idle", 300_000, 50);
    expect(ok).toBe(true);
    expect(host.results.every((r) => r === "ok")).toBe(true);
    expect(fake.rxOverflow).toBe(false);
    expect(fake.maxRxUsed).toBeLessThanOrEqual(127);
    expect(fake.penDown).toBe(false);
    expect(fake.wpos).toEqual({ x: 0, y: 0 });
    expect(host.lines).toContain("[MSG:Pgm End]");
    expectSameStrokes(inked(fake.penStrokes), expectedStrokes(plan));
  });

  it("programa blindado escrito à mão: aquecimento, checkpoint, descanso de 45 s, subida dupla e M2", async () => {
    const { host, fake, clock } = await homed();
    const strokes = [
      [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 130 }],
      [{ x: 200, y: 50 }, { x: 260, y: 50 }],
      [{ x: 300, y: 200 }, { x: 300, y: 240 }, { x: 340, y: 240 }, { x: 340, y: 200 }],
    ];
    const lines = regrasLines(strokes, { warmup: 8, feed: 1500, checkpoints: [1], rests: { 2: 45 } }).map((l) => l.text);
    const t0 = clock.now();
    host.send(...lines);
    expect(await clock.advanceUntil(() => host.done && fake.state === "Idle", 200_000, 50)).toBe(true);
    expect(host.results.every((r) => r === "ok")).toBe(true);
    expect(host.results).toHaveLength(1 + lines.filter((l) => prepareLine(l) !== null).length);
    expect(fake.rxOverflow).toBe(false);
    expect(inked(fake.penStrokes)).toEqual(strokes);
    // 8 toques do aquecimento em (0,0) e 2 do checkpoint no fim do 1º traço
    expect(taps(fake.penStrokes)).toEqual([...Array.from({ length: 8 }, () => ({ x: 0, y: 0 })), { x: 150, y: 130 }, { x: 150, y: 130 }]);
    expect(clock.now() - t0).toBeGreaterThan(45_000 + 8 * 800);
    expect(fake.wpos).toEqual({ x: 0, y: 0 });
    expect(fake.modalMotion).toBe("G1"); // é o que o M2 deixa
    expect(host.lines.slice(-2)).toEqual(["[MSG:Pgm End]", "ok"]);
  });

  it("mandar sem contar estoura o buffer (o teste acima tem dente)", async () => {
    const { fake } = await homed();
    const burst = Array.from({ length: 20 }, (_, i) => `G1 X${i + 1}.00 Y1.00 F1000\n`).join("");
    await fake.write(asciiBytes(burst));
    expect(fake.rxOverflow).toBe(true);
  });
});

describe("FakeGrbl: pausa, reset e alarmes", () => {
  it("! → Hold:1 → Hold:0; 0x9E levanta a caneta; ~ volta a andar", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X100 Y100", "M3 S220", "G4 P0.3", "G1 X300 Y100 F1000");
    await clock.advanceUntil(() => fake.state === "Run" && fake.penDown, 30_000);
    await clock.advance(500);
    host.rt(RT.HOLD);
    expect(fake.stateText).toBe("Hold:1");
    await clock.advance(120);
    expect(fake.stateText).toBe("Hold:0");
    const x = fake.wpos.x;
    host.rt(RT.SPINDLE_STOP);
    expect(fake.penDown).toBe(false);
    await clock.advance(1000);
    expect(fake.wpos.x).toBe(x);
    host.rt(RT.SPINDLE_STOP);
    expect(fake.penDown).toBe(true);
    host.rt(RT.RESUME);
    expect(fake.state).toBe("Run");
    await clock.advance(200);
    expect(fake.wpos.x).toBeGreaterThan(x);
    expect(fake.penStrokes).toHaveLength(2); // a caneta subiu e desceu no mesmo ponto
    expect(host.lines).toContain("[MSG:Restoring spindle]");
  });

  it("0x9E pedido ainda em Hold:1 vale uma vez só, quando o Hold completa; ~ com a caneta parada religa e já anda", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X100 Y100", "M3 S220", "G4 P0.3", "G1 X300 Y100 F1000");
    await clock.advanceUntil(() => fake.state === "Run" && fake.penDown, 30_000);
    host.rt(RT.HOLD);
    host.rt(RT.SPINDLE_STOP);
    host.rt(RT.SPINDLE_STOP); // o GRBL não "desfaz" um pedido que ainda não foi atendido
    expect(fake.penDown).toBe(true);
    await clock.advance(120);
    expect(fake.stateText).toBe("Hold:0");
    expect(fake.penDown).toBe(false);
    host.rt(RT.RESUME);
    expect(fake.penDown).toBe(true);
    expect(fake.state).toBe("Run");
  });

  it("0x9E com a caneta em cima (M5) não faz nada, nem na ida nem na volta", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X100 Y100");
    await clock.advance(500);
    host.rt(RT.HOLD);
    await clock.advance(120);
    host.rt(RT.SPINDLE_STOP);
    host.rt(RT.SPINDLE_STOP);
    host.rt(RT.RESUME);
    await clock.advance(10);
    expect(fake.penDown).toBe(false);
    expect(fake.state).toBe("Run");
    expect(host.lines).not.toContain("[MSG:Restoring spindle]");
  });

  it("sem suporte ao 0x9E (spindleStopInHold: false) a caneta fica no papel", async () => {
    const { host, fake, clock } = await homed({ spindleStopInHold: false });
    host.send("G0 X100 Y100", "M3 S220", "G4 P0.3", "G1 X300 Y100 F1000");
    await clock.advanceUntil(() => fake.state === "Run" && fake.penDown, 30_000);
    host.rt(RT.HOLD);
    await clock.advance(120);
    host.rt(RT.SPINDLE_STOP);
    expect(fake.penDown).toBe(true);
  });

  it("reset andando → ALARM:3; reset parado (Idle ou Hold:0) mantém a posição, sem alarme", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X100 Y100");
    await clock.advance(100);
    const n = host.lines.length;
    host.rt(RT.RESET);
    await clock.advance(10);
    expect(host.lines.slice(n)).toEqual(["ALARM:3", BANNER, LOCKED]);
    expect(fake.state).toBe("Alarm");

    const b = await homed();
    await run(b, ["G0 X100 Y100"]);
    b.host.rt(RT.RESET);
    await b.clock.advance(10);
    expect(b.host.lines).not.toContain("ALARM:3");
    expect(b.fake.state).toBe("Idle");
    expect(b.fake.wpos).toEqual({ x: 100, y: 100 });

    const c = await homed();
    c.host.send("G0 X100 Y100", "M3 S220");
    await c.clock.advance(1000);
    c.host.rt(RT.HOLD);
    await c.clock.advance(120);
    expect(c.fake.stateText).toBe("Hold:0");
    const pos = { ...c.fake.wpos };
    const k = c.host.lines.length;
    c.host.rt(RT.RESET);
    await c.clock.advance(10);
    // o M3 estava esperando o planejador esvaziar: ainda devolve o seu ok antes do banner
    expect(c.host.lines.slice(k)).toEqual(["ok", BANNER]);
    expect(c.fake.state).toBe("Idle");
    expect(c.fake.wpos).toEqual(pos);
  });

  it("reset durante o homing → ALARM:6 (não 3), o ok do $H e Alarm", async () => {
    const { host, fake, clock } = await boot();
    host.send("$H");
    await clock.advance(500);
    host.rt(RT.RESET);
    await clock.advance(10);
    expect(host.lines.slice(2)).toEqual(["ALARM:6", "ok", BANNER, LOCKED]);
    expect(fake.state).toBe("Alarm");
  });

  it("reset com uma linha esperando o planejador (máquina andando): ALARM:3 e depois o ok atrasado dela", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X100 Y100", "M3 S220");
    await clock.advance(100);
    const n = host.lines.length;
    host.rt(RT.RESET);
    await clock.advance(10);
    expect(host.lines.slice(n)).toEqual(["ALARM:3", "ok", BANNER, LOCKED]);
    expect(fake.penDown).toBe(false);
  });

  it("jog fora da área → error:15; comando que o GRBL não tem → error:20; nada disso tira de Idle", async () => {
    const { host, fake, clock } = await homed();
    host.send("$J=G90 G21 X900.00 Y0.00 F3000", "M7", "G1 X10 Y10 Q3", "$J=G90 X10 Y10", "$J=G1 X10 F100", "$JX10F100");
    await clock.advance(10);
    expect(host.results.slice(1)).toEqual(["error:15", "error:20", "error:20", "error:22", "error:16", "error:3"]);
    expect(fake.state).toBe("Idle");
  });

  it("G0 fora da área → ALARM:2 e [MSG:Reset to continue]; mudo (nem relatório) até o reset; depois Alarm", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X900 Y10");
    await clock.advance(10);
    expect(host.lines.slice(-2)).toEqual(["ALARM:2", "[MSG:Reset to continue]"]);
    expect(fake.state).toBe("Alarm");
    const n = host.lines.length;
    host.rt(RT.STATUS);
    host.send("$X");
    await clock.advance(1000);
    expect(host.lines).toHaveLength(n); // nenhum relatório, nenhum ok
    host.rt(RT.RESET);
    await clock.advance(10);
    expect(host.lines.slice(n)).toEqual(["ok", BANNER, LOCKED]); // o ok é da linha do soft limit
    host.rt(RT.STATUS);
    await clock.advance(1);
    expect(host.reports.at(-1)).toMatch(/^<Alarm\|/);
  });

  it("jog cancelado com 0x85 para entre o início e o fim", async () => {
    const { host, fake, clock } = await homed();
    host.send("$J=G90 G21 X100.00 Y384.00 F6000");
    await clock.advance(1000);
    expect(fake.state).toBe("Jog");
    host.rt(RT.JOG_CANCEL);
    expect(fake.state).toBe("Idle");
    expect(fake.wpos.x).toBeLessThan(809);
    expect(fake.wpos.x).toBeGreaterThan(100);
  });

  it("G-code durante um jog → error:9", async () => {
    const { host, fake, clock } = await homed();
    host.send("$J=G90 G21 X100.00 Y384.00 F6000", "G0 X10 Y10");
    await clock.advance(10);
    expect(host.results.slice(1)).toEqual(["ok", "error:9"]);
    expect(fake.state).toBe("Jog");
  });

  it("override de velocidade e bytes proibidos", async () => {
    const { host, fake } = await homed();
    host.rt(RT.FEED_PLUS_10);
    host.rt(RT.FEED_PLUS_10);
    host.rt(RT.FEED_MINUS_1);
    expect(fake.feedOverride).toBe(119);
    host.rt(RT.FEED_RESET);
    expect(fake.feedOverride).toBe(100);
    host.rt(0x9a);
    expect(fake.forbiddenBytes).toEqual([0x9a]);
  });

  it("falha injetada: desconexão depois de k linhas", async () => {
    const { host, fake, clock } = await homed({ faults: { disconnectAfterLines: 3 } });
    let closed: string | undefined;
    fake.onClose = (i) => (closed = i.reason);
    host.send("G21", "G90", "G0 X10 Y10", "G0 X20 Y20");
    await clock.advance(10);
    expect(closed).toBe("lost");
    await expect(fake.write(asciiBytes("?"))).rejects.toThrow(/lost/);
  });
});
