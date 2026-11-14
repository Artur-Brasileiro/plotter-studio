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

const AREA = { width: 810, height: 385 };

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

  send(...lines: string[]) {
    const items = lines.map((l) => prepareLine(l)).filter((t): t is string => t !== null);
    this.streamer.enqueue(items.map((text) => ({ text, id: this.nextId++ })));
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

describe("FakeGrbl", () => {
  it("abre como o Uno: reinicia, manda o banner e fica em Alarm", async () => {
    const { host, fake, clock } = await boot();
    expect(host.lines).toEqual(["Grbl 1.1h ['$' for help]", "[MSG:'$H'|'$X' to unlock]"]);
    expect(fake.state).toBe("Alarm");
    host.send("G0 X10 Y10");
    host.send("$J=G91 X1 F100");
    host.send("$$");
    await clock.advance(0);
    expect(host.results).toEqual(["error:9", "error:8", "ok"]);
  });

  it("$H: Home, depois Idle afastado 1 mm da chave", async () => {
    const { host, fake, clock } = await boot();
    host.send("$H");
    await clock.advance(1000);
    expect(fake.state).toBe("Home");
    await clock.advance(1100);
    expect(fake.state).toBe("Idle");
    expect(fake.wpos).toEqual({ x: 809, y: 384 });
    expect(host.results).toEqual(["ok"]);
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

  it("executa o G-code de orientacao enviado pela contagem de caracteres, sem estourar o buffer", async () => {
    const { host, fake, clock } = await homed();
    const plan = planJob(docFrom(orientacaoSvg), DEFAULT_PROFILE, DEFAULT_JOB_SETTINGS);
    const program = generateGcode(plan, DEFAULT_PROFILE, { fileName: "orientacao.svg", date: new Date(2026, 10, 14), job: DEFAULT_JOB_SETTINGS });
    host.send(...program.lines.map((l) => l.text));
    const ok = await clock.advanceUntil(() => host.done && fake.state === "Idle", 120_000, 50);
    expect(ok).toBe(true);
    expect(host.results.every((r) => r === "ok")).toBe(true);
    expect(fake.rxOverflow).toBe(false);
    expect(fake.maxRxUsed).toBeLessThanOrEqual(127);
    expect(fake.penDown).toBe(false);
    expect(fake.wpos).toEqual({ x: 0, y: 0 });
    expectSameStrokes(fake.penStrokes, expectedStrokes(plan));
  });

  it("mandar sem contar estoura o buffer (o teste acima tem dente)", async () => {
    const { fake } = await homed();
    const burst = Array.from({ length: 20 }, (_, i) => `G1 X${i + 1}.00 Y1.00 F1000\n`).join("");
    await fake.write(asciiBytes(burst));
    expect(fake.rxOverflow).toBe(true);
  });

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

  it("reset andando → ALARM:3; reset parado mantém a posição", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X100 Y100");
    await clock.advance(100);
    host.rt(RT.RESET);
    await clock.advance(10);
    expect(host.lines).toContain("ALARM:3");
    expect(fake.state).toBe("Alarm");

    const b = await homed();
    b.host.send("G0 X100 Y100");
    await b.clock.advanceUntil(() => b.fake.state === "Idle" && b.host.done, 10_000);
    b.host.rt(RT.RESET);
    await b.clock.advance(10);
    expect(b.host.lines).not.toContain("ALARM:3");
    expect(b.fake.state).toBe("Idle");
    expect(b.fake.wpos).toEqual({ x: 100, y: 100 });
  });

  it("jog fora da área → error:15; G1 sem F → error:22; G-code desconhecido → error:20", async () => {
    const { host, fake, clock } = await homed();
    host.send("$J=G90 G21 X900.00 Y0.00 F3000", "G1 X10 Y10", "G2 X10 Y10 I5 J0");
    await clock.advance(10);
    expect(host.results.slice(1)).toEqual(["error:15", "error:22", "error:20"]);
    // parênteses aninhados (enviados crus, como no console): sobra um ")" fora do comentário
    const before = host.results.length;
    host.streamer.enqueue([{ text: "G1 X10 (a (b))", id: 999 }]);
    host.pump();
    await clock.advance(10);
    expect(host.results[before]).toBe("error:1");
    expect(fake.state).toBe("Idle");
  });

  it("G0 fora da área → ALARM:2 e trava até o reset", async () => {
    const { host, fake, clock } = await homed();
    host.send("G0 X900 Y10");
    await clock.advance(10);
    expect(host.lines).toContain("ALARM:2");
    expect(fake.state).toBe("Alarm");
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
