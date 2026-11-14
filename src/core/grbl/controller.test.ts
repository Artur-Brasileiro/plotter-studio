import { describe, expect, it } from "vitest";
import { generateGcode, type GcodeLine, type GcodeProgram } from "../job/gcode";
import { planJob } from "../job/pipeline";
import { DEFAULT_PROFILE, type MachineProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS } from "../store";
import { curvasSvg, docFrom, orientacaoSvg } from "../testing/samples";
import { expectedStrokes, expectSameStrokes, mergeTouching } from "../testing/strokes";
import type { SvgNode } from "../svg/node";
import { ManualClock } from "./clock";
import { GrblController, type LogEntry } from "./controller";
import { FakeGrbl, type FakeGrblOptions } from "./fakeGrbl";
import { RT } from "./protocol";
import { prepareLine } from "./streamer";

const AREA = { width: 810, height: 385 };

interface Opts {
  fake?: Partial<FakeGrblOptions>;
  profile?: MachineProfile;
}

async function setup(opts: Opts = {}) {
  const clock = new ManualClock();
  const fake = new FakeGrbl(clock, { workArea: AREA, ...opts.fake });
  const written: number[] = [];
  const write = fake.write.bind(fake);
  fake.write = (b: Uint8Array) => {
    written.push(...b);
    return write(b);
  };
  const ctrl = new GrblController(fake, opts.profile ?? DEFAULT_PROFILE, clock);
  const logs: LogEntry[] = [];
  ctrl.onLog((e) => logs.push(e));
  return { clock, fake, ctrl, written, logs };
}

async function connected(opts: Opts = {}) {
  const s = await setup(opts);
  const p = s.ctrl.connect();
  await s.clock.advance(2000);
  await p;
  await s.clock.advance(300); // primeiro relatório de estado
  return s;
}

async function homed(opts: Opts = {}) {
  const s = await connected(opts);
  const p = s.ctrl.home();
  await s.clock.advance(2500);
  await p;
  return s;
}

function programFor(svg: SvgNode, profile = DEFAULT_PROFILE) {
  const plan = planJob(docFrom(svg), profile, DEFAULT_JOB_SETTINGS);
  const program = generateGcode(plan, profile, { fileName: "teste.svg", date: new Date(2026, 10, 14), job: DEFAULT_JOB_SETTINGS });
  return { plan, program };
}

const jobState = (s: { ctrl: GrblController }) => s.ctrl.snapshot.job.state;
const textOf = (bytes: number[]) => String.fromCharCode(...bytes);

/** Espera a caneta estar no meio de um traço, com o trabalho já adiantado. */
async function midStroke(s: Awaited<ReturnType<typeof homed>>, minAcked = 20) {
  const ok = await s.clock.advanceUntil(() => s.fake.penDown && s.fake.state === "Run" && s.ctrl.snapshot.job.acked > minAcked, 60_000);
  expect(ok).toBe(true);
  await s.clock.advance(30);
}

describe("GrblController com o FakeGrbl", () => {
  it("1. conecta: banner, Alarm, configuração lida; sem Home não começa", async () => {
    const s = await connected();
    const snap = s.ctrl.snapshot;
    expect(snap.link).toBe("connected");
    expect(snap.status?.state).toBe("Alarm");
    expect(snap.homed).toBe(false);
    expect(snap.settings.get(130)).toBe("810.000");
    expect(snap.g54).toEqual({ x: -810, y: -385 });
    expect(snap.settingsWarnings).toEqual([]);
    const { program } = programFor(orientacaoSvg);
    expect(() => s.ctrl.startJob(program)).toThrow(/Faça o Home/);
  });

  it("2. sem banner: 0x18 depois de 5 s; sem resposta em mais 3 s, erro", async () => {
    const s = await setup({ fake: { faults: { noBanner: true } } });
    let err: Error | undefined;
    s.ctrl.connect().catch((e: Error) => (err = e));
    await s.clock.advance(4990);
    expect(s.written).not.toContain(RT.RESET);
    await s.clock.advance(20);
    expect(s.written).toContain(RT.RESET);
    await s.clock.advance(2900);
    expect(err).toBeUndefined();
    await s.clock.advance(200);
    expect(err?.message).toMatch(/não respondeu/);
    expect(s.ctrl.snapshot.link).toBe("disconnected");
  });

  it("3. $H: homed, Idle, WPos perto de (810, 385)", async () => {
    const s = await homed();
    await s.clock.advance(300);
    const snap = s.ctrl.snapshot;
    expect(snap.homed).toBe(true);
    expect(snap.status?.state).toBe("Idle");
    expect(snap.wpos).toEqual({ x: 809, y: 384 }); // pull-off de 1 mm ($27)
  });

  it("$H digitado no console também marca o Home", async () => {
    const s = await connected();
    const p = s.ctrl.send("$H", { manual: true });
    await s.clock.advance(2500);
    expect(await p).toEqual({ ok: true });
    expect(s.ctrl.snapshot.homed).toBe(true);
  });

  it("4. trabalho completo (orientacao): desenha o plano, sem estourar o buffer", async () => {
    const s = await homed();
    const { plan, program } = programFor(orientacaoSvg);
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => jobState(s) === "finished", 120_000, 100)).toBe(true);
    const job = s.ctrl.snapshot.job;
    expect(job.acked).toBe(job.total);
    expect(s.fake.rxOverflow).toBe(false);
    expect(s.fake.maxRxUsed).toBeLessThanOrEqual(127);
    expect(s.fake.wpos).toEqual({ x: 0, y: 0 });
    expectSameStrokes(s.fake.penStrokes, expectedStrokes(plan));
  });

  it("5. estresse: 10 mil segmentos de 0,2 mm sem estouro, na ordem", async () => {
    const s = await homed();
    const lines: GcodeLine[] = ["G21", "G90", "M5", "G4 P0.3", "G0 X10.00 Y10.00", "M3 S220", "G4 P0.3"].map((text) => ({ text, strokeIndex: -1 }));
    for (let i = 1; i <= 10000; i++) {
      const k = i % 2000;
      const x = 10 + 0.2 * (k <= 1000 ? k : 2000 - k);
      lines.push({ text: `G1 X${x.toFixed(2)} Y10.00${i === 1 ? " F2000" : ""}`, strokeIndex: 0, pointIndex: i });
    }
    lines.push(...["M5", "G4 P0.3", "G0 X0.00 Y0.00"].map((text) => ({ text, strokeIndex: -1 })));
    const program: GcodeProgram = { lines, toText: () => "" };
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => jobState(s) === "finished", 200_000, 200)).toBe(true);
    expect(s.fake.rxOverflow).toBe(false);
    expect(s.fake.maxRxUsed).toBeLessThanOrEqual(127);
    const sent = lines.map((l) => l.text);
    expect(s.fake.received.slice(-sent.length)).toEqual(sent);
  }, 30_000);

  it("6. error:20 na linha 30: ! sai antes de qualquer linha nova e o trabalho pausa com o erro", async () => {
    const s = await homed({ fake: { faults: { errorAtLine: { line: 30, code: 20 } } } });
    const { plan, program } = programFor(curvasSvg);
    let marker = -1;
    s.ctrl.onLog((e) => {
      if (marker < 0 && e.dir === "error" && e.text.startsWith("error:20")) marker = s.written.length;
    });
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 60_000)).toBe(true);
    expect(marker).toBeGreaterThan(0);
    expect(s.written[marker]).toBe(RT.HOLD);
    const sendable = program.lines.flatMap((l, i) => (prepareLine(l.text) === null ? [] : [i]));
    expect(s.ctrl.snapshot.job.error).toMatchObject({ line: sendable[29], code: 20, text: program.lines[sendable[29]].text });
    // "Continuar mesmo assim": termina (a linha 30 foi pulada pelo GRBL)
    s.ctrl.resume();
    expect(await s.clock.advanceUntil(() => jobState(s) === "finished", 120_000, 100)).toBe(true);
    expect(s.ctrl.snapshot.job.error).toBeUndefined();
    expect(s.fake.penStrokes.length).toBeGreaterThan(0);
    void plan;
  });

  it("7. pausa agora: !, Hold:0, 0x9E (caneta sobe); continuar: 0x9E e ~ 500 ms depois, sem falha no traço", async () => {
    const s = await homed();
    const { plan, program } = programFor(curvasSvg);
    s.ctrl.startJob(program);
    await midStroke(s);
    const rt0 = s.fake.rtLog.length;
    s.ctrl.pause();
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 5000, 5)).toBe(true);
    const pauseLog = s.fake.rtLog.slice(rt0);
    expect(pauseLog.map((e) => e.byte)).toEqual([RT.HOLD, RT.SPINDLE_STOP]);
    expect(pauseLog[0].state).toBe("Run");
    expect(pauseLog[1].state).toBe("Hold:0");
    expect(s.fake.penDown).toBe(false);
    expect(s.ctrl.snapshot.job.penLifted).toBe(true);
    const pos = { ...s.fake.wpos };
    await s.clock.advance(3000);
    expect(s.fake.wpos).toEqual(pos);

    const rt1 = s.fake.rtLog.length;
    s.ctrl.resume();
    expect(jobState(s)).toBe("resuming");
    await s.clock.advance(450);
    expect(s.fake.penDown).toBe(true); // desceu, mas ainda não andou
    expect(s.fake.wpos).toEqual(pos);
    expect(await s.clock.advanceUntil(() => jobState(s) === "finished", 120_000, 100)).toBe(true);
    const resumeLog = s.fake.rtLog.slice(rt1);
    expect(resumeLog.map((e) => e.byte)).toEqual([RT.SPINDLE_STOP, RT.RESUME]);
    expect(resumeLog[1].at - resumeLog[0].at).toBeGreaterThanOrEqual(500);
    expect(s.ctrl.snapshot.job.pausedMs).toBeGreaterThanOrEqual(3000);
    expectSameStrokes(mergeTouching(s.fake.penStrokes), expectedStrokes(plan));
  });

  it("8. pausa no fim do traço: a caneta não para no meio; pausado em Idle com a caneta em cima", async () => {
    const profile: MachineProfile = { ...DEFAULT_PROFILE, pen: { ...DEFAULT_PROFILE.pen, pauseLift: "endOfStroke" } };
    const s = await homed({ profile });
    const { plan, program } = programFor(curvasSvg, profile);
    s.ctrl.startJob(program);
    await midStroke(s);
    s.ctrl.pause();
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 60_000, 20)).toBe(true);
    expect(s.fake.state).toBe("Idle");
    expect(s.fake.penDown).toBe(false);
    expect(s.fake.rtLog.some((e) => e.byte === RT.HOLD)).toBe(false);
    const exp = expectedStrokes(plan);
    const done = s.fake.penStrokes.map((st) => [...st]);
    expect(done.length).toBeGreaterThan(0);
    expect(done.length).toBeLessThan(exp.length);
    expectSameStrokes(done, exp.slice(0, done.length)); // só traços inteiros
    s.ctrl.resume();
    expect(await s.clock.advanceUntil(() => jobState(s) === "finished", 120_000, 100)).toBe(true);
    expectSameStrokes(s.fake.penStrokes, exp);
  });

  it("9. parar: sem ALARM, Home mantido, caneta em cima, posição igual à da parada", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg);
    s.ctrl.startJob(program);
    await midStroke(s);
    const p = s.ctrl.stop();
    const pos = { ...s.fake.wpos };
    await s.clock.advance(1000);
    await p;
    expect(jobState(s)).toBe("stopped");
    expect(s.logs.some((e) => e.text.includes("ALARM"))).toBe(false);
    expect(s.ctrl.snapshot.homed).toBe(true);
    expect(s.fake.penDown).toBe(false);
    expect(s.fake.state).toBe("Idle");
    expect(s.fake.wpos).toEqual(pos);
    // "Ir para a origem" sem refazer o Home
    const g = s.ctrl.goToOrigin();
    expect(await s.clock.advanceUntil(() => !s.ctrl.snapshot.busy, 60_000, 50)).toBe(true);
    await g;
    expect(s.fake.wpos).toEqual({ x: 0, y: 0 });
  });

  it("10. parada de emergência andando: ALARM:3 e Home obrigatório", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg);
    s.ctrl.startJob(program);
    await midStroke(s);
    s.ctrl.emergencyStop();
    await s.clock.advance(300);
    expect(jobState(s)).toBe("stopped");
    expect(s.ctrl.snapshot.alarm).toBe(3);
    expect(s.ctrl.snapshot.homed).toBe(false);
    expect(s.fake.penDown).toBe(false);
    expect(s.ctrl.jobProblems(program).join(" ")).toMatch(/Faça o Home/);
  });

  it("11. cabo desconectado na linha 200: lost/failed em menos de 100 ms, nada fica pendurado", async () => {
    const s = await homed({ fake: { faults: { disconnectAfterLines: 200 } } });
    const { program } = programFor(curvasSvg);
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => s.fake.cableCut, 120_000, 5)).toBe(true);
    expect(await s.clock.advanceUntil(() => s.ctrl.snapshot.link === "lost", 100, 1)).toBe(true);
    const job = s.ctrl.snapshot.job;
    expect(job.state).toBe("failed");
    expect(job.message).toMatch(/Conexão perdida na linha \d+ de \d+/);
    await expect(s.ctrl.send("$$")).rejects.toThrow();
    await expect(s.ctrl.home()).rejects.toThrow();
    // reconectar: a placa reinicia e pede Home
    const p = s.ctrl.connect();
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(300);
    expect(s.ctrl.snapshot.link).toBe("connected");
    expect(s.ctrl.snapshot.status?.state).toBe("Alarm");
    expect(s.ctrl.snapshot.homed).toBe(false);
  });

  it("11b. cabo puxado durante o Home: a promessa rejeita", async () => {
    const s = await connected();
    let err: Error | undefined;
    s.ctrl.home().catch((e: Error) => (err = e));
    await s.clock.advance(500);
    s.fake.unplug();
    await s.clock.advance(10);
    expect(err).toBeInstanceOf(Error);
    expect(s.ctrl.snapshot.busy).toBeUndefined();
  });

  it("12. banner inesperado no meio do trabalho: failed, \"a placa reiniciou\"", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg);
    s.ctrl.startJob(program);
    await midStroke(s);
    s.fake.powerGlitch();
    await s.clock.advance(2000);
    expect(jobState(s)).toBe("failed");
    expect(s.ctrl.snapshot.job.message).toMatch(/reiniciou/);
    expect(s.ctrl.snapshot.homed).toBe(false);
  });

  it("13. $32=1 na placa: aviso de configuração", async () => {
    const s = await connected({ fake: { settings: { 32: "1" } } });
    expect(s.ctrl.snapshot.settingsWarnings.some((w) => w.includes("$32"))).toBe(true);
  });

  it("14. jog contínuo: $J= e depois 0x85; para entre o início e a borda", async () => {
    const s = await homed();
    s.ctrl.jogContinuous({ x: -1, y: 0 }, 3000);
    await s.clock.advance(1000);
    expect(s.fake.state).toBe("Jog");
    const before = s.written.length;
    s.ctrl.jogStop();
    await s.clock.advance(300);
    expect(textOf(s.written.slice(0, before))).toContain("$J=G90 G21 X0.50 Y384.00 F3000");
    expect(s.written.slice(before)).toContain(RT.JOG_CANCEL);
    expect(s.fake.state).toBe("Idle");
    expect(s.fake.wpos.x).toBeLessThan(809);
    expect(s.fake.wpos.x).toBeGreaterThan(1);
  });

  it("jog por passos: soma os destinos e não sai da área", async () => {
    const s = await homed();
    const all = Promise.all([s.ctrl.jogStep({ x: -10, y: 0 }, 3000), s.ctrl.jogStep({ x: -10, y: 0 }, 3000), s.ctrl.jogStep({ x: 5, y: 5 }, 3000)]);
    await s.clock.advance(3000);
    await all;
    expect(s.fake.wpos.x).toBeCloseTo(794);
    expect(s.fake.wpos.y).toBeCloseTo(384.5);
  });

  it("override de velocidade; override de spindle é recusado; não desconecta com trabalho rodando", async () => {
    const s = await homed();
    s.ctrl.feedOverride(RT.FEED_PLUS_10);
    expect(s.fake.feedOverride).toBe(110);
    await s.clock.advance(3000); // vários relatórios, a maioria sem o campo Ov
    expect(s.ctrl.snapshot.status?.overrides?.feed).toBe(110);
    expect(() => s.ctrl.feedOverride(0x9a)).toThrow();
    expect(() => s.ctrl.realtime(0x9b)).toThrow();
    const { program } = programFor(orientacaoSvg);
    s.ctrl.startJob(program);
    await expect(s.ctrl.disconnect()).rejects.toThrow(/Pare o trabalho/);
    expect(s.fake.forbiddenBytes).toEqual([]);
  });

  it("parar durante a pausa e frame com a caneta levantada", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg);
    s.ctrl.startJob(program);
    await midStroke(s);
    s.ctrl.pause();
    await s.clock.advanceUntil(() => jobState(s) === "paused", 5000, 5);
    const p = s.ctrl.stop();
    await s.clock.advance(500);
    await p;
    expect(jobState(s)).toBe("stopped");
    expect(s.ctrl.snapshot.homed).toBe(true);
    expect(s.fake.penDown).toBe(false);

    const strokes = s.fake.penStrokes.length;
    const f = s.ctrl.frame({ minX: 10, minY: 10, maxX: 110, maxY: 60 });
    expect(await s.clock.advanceUntil(() => !s.ctrl.snapshot.busy, 60_000, 50)).toBe(true);
    await f;
    expect(s.fake.penStrokes.length).toBe(strokes); // nada desenhado
    expect(s.fake.wpos).toEqual({ x: 10, y: 10 });
  });

  it("linha atual acompanha a posição durante o trabalho", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg);
    s.ctrl.startJob(program);
    const seen: number[] = [];
    s.ctrl.subscribe((snap) => {
      const c = snap.job.currentLine;
      if (c !== undefined && seen[seen.length - 1] !== c) seen.push(c);
    });
    await s.clock.advanceUntil(() => jobState(s) === "finished", 120_000, 100);
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.every((v, i) => i === 0 || v > seen[i - 1])).toBe(true); // nunca volta
  });
});
