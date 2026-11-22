import { describe, expect, it } from "vitest";
import { generateGcode, type GcodeLine, type GcodeProgram } from "../job/gcode";
import { planJob } from "../job/pipeline";
import { DEFAULT_PROFILE, type MachineProfile } from "../machine";
import { DEFAULT_JOB_SETTINGS, type JobSettings } from "../store";
import { curvasSvg, docFrom, orientacaoSvg } from "../testing/samples";
import { expectedStrokes, expectSameStrokes, mergeTouching } from "../testing/strokes";
import type { SvgNode } from "../svg/node";
import { ManualClock } from "./clock";
import { consoleRealtimeAction, escapeAction, GrblAlarmError, GrblController, type ControllerSnapshot, type Health, type LogEntry } from "./controller";
import { FakeGrbl, type FakeGrblOptions } from "./fakeGrbl";
import { asciiBytes, RT } from "./protocol";
import { prepareLine } from "./streamer";
import { inked, programOf, regrasProgram, taps } from "./testPrograms";
import type { Transport } from "./transport";

// o simulador tem o mesmo curso do perfil padrão: é o que a máquina de verdade tem gravado
const AREA = DEFAULT_PROFILE.workArea;
/** F3000 no lugar do F500 padrão: o mesmo programa, em menos tempo virtual */
const FAST: JobSettings = { ...DEFAULT_JOB_SETTINGS, speedMode: "fixed", fixedFeed: 3000 };
const END_OF_STROKE: MachineProfile = { ...DEFAULT_PROFILE, pen: { ...DEFAULT_PROFILE.pen, pauseLift: "endOfStroke" } };

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
  // a pior "saúde" vista: o GRBL fica mudo no homing e depois de um alarme crítico, e isso não é travar
  const seen = { health: "ok" as Health };
  ctrl.subscribe((snap) => {
    if (snap.health === "stuck" || (snap.health === "slow" && seen.health === "ok")) seen.health = snap.health;
  });
  return { clock, fake, ctrl, written, logs, seen };
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
  await s.clock.advance((opts.fake?.homingMs ?? 2000) + 500);
  await p;
  return s;
}

type Session = Awaited<ReturnType<typeof setup>>;

/** O programa que o aplicativo gera de verdade (formato de docs/REGRAS_GCODE.md, com a blindagem do perfil). */
function programFor(svg: SvgNode, profile = DEFAULT_PROFILE, job = DEFAULT_JOB_SETTINGS) {
  const plan = planJob(docFrom(svg), profile, job);
  const program = generateGcode(plan, profile, { fileName: "teste.svg", date: new Date(2026, 10, 14), job });
  return { plan, program };
}

/** Índices (em program.lines) das linhas que vão para o GRBL (sem as só de comentário). */
const sendable = (program: GcodeProgram) => program.lines.flatMap((l, i) => (prepareLine(l.text) === null ? [] : [i]));

const jobState = (s: { ctrl: GrblController }) => s.ctrl.snapshot.job.state;
const textOf = (bytes: number[]) => String.fromCharCode(...bytes);
const finished = (s: Session, maxMs = 300_000) => s.clock.advanceUntil(() => jobState(s) === "finished", maxMs, 100);
const errorLogs = (s: Session) => s.logs.filter((e) => e.dir === "error").map((e) => e.text);

/** Espera a caneta estar no meio de um traço (andando), com o trabalho já adiantado. */
async function midStroke(s: Session, minAcked = 20) {
  const ok = await s.clock.advanceUntil(() => s.fake.penDown && s.fake.state === "Run" && s.ctrl.snapshot.job.acked > minAcked, 120_000);
  expect(ok).toBe(true);
  await s.clock.advance(30);
}

const zigzag = (x0: number, y0: number, n: number, step = 20) => Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + step * i, y: y0 + (i % 2) * step }));
const THREE = [zigzag(100, 100, 6), [{ x: 300, y: 50 }, { x: 360, y: 50 }], zigzag(200, 250, 4)];

describe("GrblController com o FakeGrbl", () => {
  it("1. conecta: banner, Alarm, configuração lida; sem Home não começa", async () => {
    const s = await connected();
    const snap = s.ctrl.snapshot;
    expect(snap.link).toBe("connected");
    expect(snap.status?.state).toBe("Alarm");
    expect(snap.homed).toBe(false);
    expect(snap.settings.get(130)).toBe("810.000");
    expect(snap.g54).toEqual({ x: -810, y: -390 });
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

  it("3. $H: homed, Idle, WPos perto de (810, 390)", async () => {
    const s = await homed();
    await s.clock.advance(300);
    const snap = s.ctrl.snapshot;
    expect(snap.homed).toBe(true);
    expect(snap.status?.state).toBe("Idle");
    expect(snap.wpos).toEqual({ x: 809, y: 389 }); // pull-off de 1 mm ($27)
  });

  it("$H digitado no console (com comentário e minúsculas) também marca o Home", async () => {
    const s = await connected();
    const p = s.ctrl.send("$h ; home", { manual: true });
    await s.clock.advance(100);
    expect(s.ctrl.snapshot.status?.state).toBe("Home");
    await s.clock.advance(2400);
    expect(await p).toEqual({ ok: true });
    expect(s.ctrl.snapshot.homed).toBe(true);
  });

  it("firmware com buffer de recepção menor que o do perfil ($I diz 64): avisa e o envio respeita os 64", async () => {
    const s = await homed({ fake: { rxBufferBytes: 64 } });
    expect(s.ctrl.snapshot.settingsWarnings.some((w) => /64 bytes/.test(w) && /128/.test(w))).toBe(true);
    s.ctrl.startJob(regrasProgram(THREE, { warmup: 2, feed: 3000 }));
    expect(await finished(s)).toBe(true);
    expect(s.fake.rxOverflow).toBe(false); // sem o ajuste, 127 bytes de uma vez estourariam um buffer de 64
    expect(s.fake.maxRxUsed).toBeLessThanOrEqual(63);
    expect(inked(s.fake.penStrokes)).toEqual(THREE);
  });

  it("relatórios em WPos ($10=0) dão a mesma posição e não impedem o trabalho", async () => {
    const s = await homed({ fake: { settings: { 10: "0" } } });
    await s.clock.advance(300);
    expect(s.ctrl.snapshot.wpos).toEqual({ x: 809, y: 389 });
    expect(s.ctrl.snapshot.wco).toEqual({ x: -810, y: -390 });
    expect(s.ctrl.jobProblems()).toEqual([]);
  });
});

describe("homing: o GRBL não responde ao ? nem ao ! (limits.c)", () => {
  it("Home demorado: o estado mostrado é Home, e o silêncio não vira 'lento' nem 'travada'", async () => {
    const s = await connected({ fake: { homingMs: 20_000 } });
    const p = s.ctrl.home();
    await s.clock.advance(100);
    expect(s.ctrl.snapshot.status?.state).toBe("Home"); // o controlador sabe, mesmo sem relatório
    expect(s.ctrl.snapshot.busy).toBe("Home");
    const reports = s.fake.statusReports;
    const queries = s.fake.statusQueries;
    await s.clock.advance(19_000);
    expect(s.fake.statusQueries - queries).toBeGreaterThan(50); // o "?" continuou saindo
    expect(s.fake.statusReports).toBe(reports); // e o simulador ficou mudo, como o GRBL
    expect(s.ctrl.snapshot.health).toBe("ok");
    expect(s.seen.health).toBe("ok");
    expect(errorLogs(s)).toEqual([]);
    await s.clock.advance(1500);
    await p;
    expect(s.ctrl.snapshot.homed).toBe(true);
    expect(s.ctrl.snapshot.status?.state).toBe("Idle");
    expect(s.ctrl.snapshot.health).toBe("ok");
  });

  it("placa travada DEPOIS do Home continua sendo detectada", async () => {
    const s = await homed();
    expect(s.ctrl.snapshot.health).toBe("ok");
    s.fake.freeze();
    await s.clock.advance(1300);
    expect(s.ctrl.snapshot.health).toBe("slow");
    await s.clock.advance(4000);
    expect(s.ctrl.snapshot.health).toBe("stuck");
    expect(s.ctrl.snapshot.link).toBe("connected");
  });

  it("Parar durante o Home: reset na hora (sem esperar um Hold que nunca vem), ALARM:6, Home falta", async () => {
    const s = await connected({ fake: { homingMs: 60_000 } });
    // sai do Alarm antes: o último relatório fica "Idle", que é o caso em que o "!" seria mandado
    const u = s.ctrl.unlock();
    await s.clock.advance(300);
    await u;
    await s.clock.advance(300);
    expect(s.ctrl.snapshot.status?.state).toBe("Idle");
    let err: Error | undefined;
    s.ctrl.home().catch((e: Error) => (err = e));
    await s.clock.advance(3000);
    const n = s.written.length;
    const p = s.ctrl.stop();
    await s.clock.advance(50);
    await p;
    expect(s.written.slice(n).filter((b) => b !== RT.STATUS)).toEqual([RT.RESET]); // nenhum "!"
    expect(err).toBeInstanceOf(Error);
    expect(s.fake.state).toBe("Alarm");
    expect(s.ctrl.snapshot.alarm).toBe(6);
    expect(s.ctrl.snapshot.homed).toBe(false);
    expect(s.ctrl.snapshot.busy).toBeUndefined();
    await s.clock.advance(300);
    expect(s.ctrl.snapshot.status?.state).toBe("Alarm");
    // e dá para fazer o Home de novo
    const again = await homedAgain(s, 60_000);
    expect(again).toBe(true);
  });

  it("relatório atrasado (de um ? que cruzou com o $H) não desfaz o estado Home", async () => {
    const s = await connected({ fake: { homingMs: 20_000 } });
    void s.ctrl.send("$H", { manual: true }).catch(() => {}); // pelo console: sem o "busy" do botão
    await s.clock.advance(100);
    s.fake.onData?.(asciiBytes("<Alarm|MPos:0.000,0.000,0.000|FS:0,0>\r\n"));
    expect(s.ctrl.snapshot.status?.state).toBe("Home");
    expect(escapeAction(s.ctrl.snapshot)).toBe("estop");
    s.ctrl.emergencyStop();
    await s.clock.advance(300);
    expect(s.ctrl.snapshot.status?.state).toBe("Alarm");
  });

  it("Esc durante o Home é parada de emergência, já no primeiro instante; num jog só cancela o jog", async () => {
    const s = await connected({ fake: { homingMs: 60_000 } });
    expect(escapeAction(s.ctrl.snapshot)).toBe("none");
    void s.ctrl.home().catch(() => {});
    expect(escapeAction(s.ctrl.snapshot)).toBe("estop"); // antes de qualquer relatório
    await s.clock.advance(5000);
    expect(escapeAction(s.ctrl.snapshot)).toBe("estop");
    s.ctrl.emergencyStop();
    await s.clock.advance(300);
    expect(s.ctrl.snapshot.alarm).toBe(6);
    expect(escapeAction(s.ctrl.snapshot)).toBe("none");
  });

  it("escapeAction: trabalho, Run, Hold e ação manual → emergência; Jog → cancela; parado ou desconectado → nada", () => {
    const base: ControllerSnapshot = {
      link: "connected",
      transportLabel: "x",
      health: "ok",
      homed: true,
      needsReset: false,
      settings: new Map(),
      settingsWarnings: [],
      job: { state: "none", total: 0, acked: 0, pausedMs: 0 },
      status: { state: "Idle", pins: "" },
    };
    const st = (state: "Idle" | "Run" | "Hold" | "Jog" | "Home" | "Alarm") => ({ ...base, status: { state, pins: "" } });
    expect(escapeAction(base)).toBe("none");
    expect(escapeAction(st("Alarm"))).toBe("none");
    expect(escapeAction(st("Run"))).toBe("estop");
    expect(escapeAction(st("Hold"))).toBe("estop");
    expect(escapeAction(st("Home"))).toBe("estop");
    expect(escapeAction(st("Jog"))).toBe("jogCancel");
    expect(escapeAction({ ...st("Jog"), busy: "Indo para a origem" })).toBe("jogCancel");
    expect(escapeAction({ ...base, busy: "Contorno" })).toBe("estop"); // ainda Idle no último relatório
    expect(escapeAction({ ...base, job: { ...base.job, state: "paused" } })).toBe("estop");
    expect(escapeAction({ ...st("Run"), link: "lost" })).toBe("none");
  });

  it("! e ~ digitados no console com trabalho em andamento passam pela pausa do controlador", () => {
    expect(consoleRealtimeAction("!", "none")).toBe("send");
    expect(consoleRealtimeAction("~", "finished")).toBe("send");
    expect(consoleRealtimeAction("?", "running")).toBe("send");
    expect(consoleRealtimeAction("!", "running")).toBe("pause");
    expect(consoleRealtimeAction("~", "paused")).toBe("resume");
    // um "~" cru aqui faria o GRBL sair andando antes de o servo descer; um "!" cru deixaria a tela em "running"
    expect(consoleRealtimeAction("~", "running")).toBe("refuse");
    expect(consoleRealtimeAction("~", "resuming")).toBe("refuse");
    expect(consoleRealtimeAction("!", "paused")).toBe("refuse");
    expect(consoleRealtimeAction("!", "stopping")).toBe("refuse");
  });

  it("falha no Home (ALARM:9): a promessa rejeita com o alarme, e o banner que vem depois não é 'reiniciou sozinha'", async () => {
    const s = await connected({ fake: { faults: { homingAlarm: 9 } } });
    let err: unknown;
    s.ctrl.home().catch((e) => (err = e));
    await s.clock.advance(2500);
    expect(err).toBeInstanceOf(GrblAlarmError);
    expect((err as GrblAlarmError).code).toBe(9);
    expect(s.ctrl.snapshot.alarm).toBe(9);
    expect(s.ctrl.snapshot.homed).toBe(false);
    expect(s.ctrl.snapshot.busy).toBeUndefined();
    expect(s.ctrl.snapshot.status?.state).toBe("Alarm");
    expect(s.ctrl.snapshot.health).toBe("ok");
    expect(errorLogs(s).filter((t) => !t.startsWith("ALARM:9"))).toEqual([]);
    expect(s.logs.some((e) => e.dir === "info" && /depois do alarme/.test(e.text))).toBe(true);
    // o "ok" que o GRBL manda depois do ALARM não confirma nada: o próximo comando espera o próprio ok
    let done = false;
    void s.ctrl.send("$$").then(() => (done = true));
    expect(done).toBe(false);
    await s.clock.advance(50);
    expect(done).toBe(true);
  });
});

async function homedAgain(s: Session, homingMs: number): Promise<boolean> {
  const p = s.ctrl.home();
  await s.clock.advance(homingMs + 500);
  await p;
  return s.ctrl.snapshot.homed;
}

describe("trabalho no formato de docs/REGRAS_GCODE.md", () => {
  it("4. trabalho completo do gerador (orientacao, F500, blindagem): desenha o plano, sem estourar o buffer", async () => {
    const s = await homed();
    const { plan, program } = programFor(orientacaoSvg);
    s.ctrl.startJob(program);
    expect(await finished(s)).toBe(true);
    const job = s.ctrl.snapshot.job;
    expect(job.total).toBe(sendable(program).length);
    expect(job.acked).toBe(job.total);
    expect(s.fake.rxOverflow).toBe(false);
    expect(s.fake.maxRxUsed).toBeLessThanOrEqual(127);
    expect(s.fake.wpos).toEqual({ x: 0, y: 0 });
    expect(s.fake.penDown).toBe(false);
    expectSameStrokes(inked(s.fake.penStrokes), expectedStrokes(plan));
    expect(taps(s.fake.penStrokes)).toHaveLength(DEFAULT_PROFILE.shield.warmupCycles);
    expect(errorLogs(s)).toEqual([]);
    expect(s.seen.health).toBe("ok");
  });

  it("programa blindado escrito à mão: aquecimento, checkpoint, descanso de 45 s, subida dupla, M2", async () => {
    const s = await homed();
    const program = regrasProgram(THREE, { warmup: 8, feed: 1500, checkpoints: [1], rests: { 2: 45 } });
    const seenLines: number[] = [];
    s.ctrl.subscribe((snap) => {
      const c = snap.job.currentLine;
      if (c !== undefined && seenLines[seenLines.length - 1] !== c) seenLines.push(c);
    });
    const t0 = s.clock.now();
    s.ctrl.startJob(program);
    expect(await finished(s)).toBe(true);
    const job = s.ctrl.snapshot.job;
    const ids = sendable(program);
    // linhas só de comentário não vão para o GRBL e não entram na conta
    expect(job.total).toBe(ids.length);
    expect(job.total).toBe(program.lines.length - program.lines.filter((l) => l.text.startsWith(";")).length);
    expect(job.acked).toBe(job.total);
    expect(job.lastAckedLine).toBe(program.lines.length - 1); // o M2
    expect(s.fake.received.slice(-ids.length)).toEqual(ids.map((i) => program.lines[i].text));
    expect(s.fake.received.some((l) => l.includes(";"))).toBe(false);
    expect(s.fake.rtLog.map((e) => e.byte)).toEqual([]); // o "~" do comentário do checkpoint nunca saiu
    expect(inked(s.fake.penStrokes)).toEqual(THREE);
    expect(taps(s.fake.penStrokes)).toHaveLength(8 + 2);
    expect(s.clock.now() - t0).toBeGreaterThan(45_000);
    // só termina depois do ok do M2 (que espera o último G0 acabar)
    const end = s.logs.findIndex((e) => e.text === "[MSG:Pgm End]");
    expect(end).toBeGreaterThan(0);
    expect(s.logs.findIndex((e) => e.text === "Trabalho concluído.")).toBeGreaterThan(end);
    expect(s.fake.wpos).toEqual({ x: 0, y: 0 });
    expect(errorLogs(s)).toEqual([]);
    expect(s.seen.health).toBe("ok"); // 45 s parado em Idle no meio do trabalho não é travar
    // a linha atual acompanha os pontos só com X/Y (G1 modal) e nunca volta
    expect(seenLines.length).toBeGreaterThan(10);
    expect(seenLines.every((v, i) => i === 0 || v > seenLines[i - 1])).toBe(true);
    expect(seenLines.some((i) => /^X/.test(program.lines[i].text))).toBe(true);
  });

  it("ponto com F na própria linha (modo dinâmico): a velocidade muda ali e vale para os pontos seguintes", async () => {
    const s = await homed();
    const program = programOf([
      "G21", "G90", "M5", "G4 P0.3", "G0 X100.00 Y100.00", "M3 S220", "G4 P0.3", "G1 F600",
      "X110.00 Y100.00", // 10 mm a F600 = 1 s
      "X130.00 Y100.00 F1200", // 20 mm a F1200 = 1 s
      "X130.00 Y120.00", // 20 mm, ainda F1200 = 1 s
      "X130.00 Y130.00 F600", // 10 mm a F600 = 1 s
      "M5", "G4 P0.2", "G0 X0.00 Y0.00", "M2",
    ]);
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => s.fake.penDown, 30_000, 10)).toBe(true);
    const down = s.clock.now();
    expect(await s.clock.advanceUntil(() => !s.fake.penDown, 30_000, 10)).toBe(true);
    const penDownMs = s.clock.now() - down; // 0,3 s do G4 + 4 s de traço
    expect(penDownMs).toBeGreaterThan(4200);
    expect(penDownMs).toBeLessThan(4500);
    expect(await finished(s)).toBe(true);
    expect(s.fake.penStrokes).toEqual([[{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 130, y: 100 }, { x: 130, y: 120 }, { x: 130, y: 130 }]]);
    expect(errorLogs(s)).toEqual([]);
  });

  it("aba em segundo plano (timers do Chrome a 1 por minuto): o envio não depende deles e o desenho sai inteiro", async () => {
    // o "?" periódico é o único timer do trabalho; as linhas andam a cada "ok" que chega
    const throttled: MachineProfile = { ...DEFAULT_PROFILE, serial: { ...DEFAULT_PROFILE.serial, statusIntervalMs: 60_000 } };
    const s = await homed({ profile: throttled });
    await s.clock.advance(60_000); // um relatório depois do Home
    s.ctrl.startJob(regrasProgram(THREE, { warmup: 8, feed: 1500 }));
    const drawn = await s.clock.advanceUntil(() => inked(s.fake.penStrokes).length === 3 && !s.fake.penDown && s.fake.plannerLength === 0, 120_000, 100);
    expect(drawn).toBe(true);
    expect(inked(s.fake.penStrokes)).toEqual(THREE);
    expect(s.fake.rxOverflow).toBe(false);
    // o "concluído" só depende de dois relatórios Idle: chega atrasado, mas chega
    expect(await finished(s, 200_000)).toBe(true);
    expect(s.seen.health).toBe("ok");
    expect(errorLogs(s)).toEqual([]);
  });

  it("5. estresse: 10 mil pontos de 0,2 mm (linhas só com X/Y) sem estouro, na ordem", async () => {
    const s = await homed();
    const lines: GcodeLine[] = ["G21", "G90", "M5", "G4 P0.3", "G0 X10.00 Y10.00", "M3 S220", "G4 P0.3", "G1 F2000"].map((text) => ({ text, strokeIndex: -1 }));
    for (let i = 1; i <= 10000; i++) {
      const k = i % 2000;
      const x = 10 + 0.2 * (k <= 1000 ? k : 2000 - k);
      lines.push({ text: `X${x.toFixed(2)} Y10.00`, strokeIndex: 0, pointIndex: i });
    }
    lines.push(...["M5", "G4 P0.2", "M5", "G4 P0.2", "G0 X0.00 Y0.00", "M2"].map((text) => ({ text, strokeIndex: -1 })));
    const program: GcodeProgram = { lines, toText: () => "" };
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => jobState(s) === "finished", 200_000, 200)).toBe(true);
    expect(s.fake.rxOverflow).toBe(false);
    expect(s.fake.maxRxUsed).toBeLessThanOrEqual(127);
    const sent = lines.map((l) => l.text);
    expect(s.fake.received.slice(-sent.length)).toEqual(sent);
    expect(errorLogs(s)).toEqual([]);
  }, 30_000);

  it("6. error:20 no meio de um traço: ! sai antes de qualquer linha nova e o trabalho pausa com o erro", async () => {
    const { program } = programFor(curvasSvg, DEFAULT_PROFILE, FAST);
    const ids = sendable(program);
    // a 10ª linha de ponto (só X/Y) do desenho: bem depois do aquecimento, com a caneta no papel
    const bad = ids.filter((i) => /^X/.test(program.lines[i].text))[9];
    const s = await homed({ fake: { faults: { errorAtLine: { line: ids.indexOf(bad) + 1, code: 20 } } } });
    let marker = -1;
    s.ctrl.onLog((e) => {
      if (marker < 0 && e.dir === "error" && e.text.startsWith("error:20")) marker = s.written.length;
    });
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 120_000)).toBe(true);
    expect(marker).toBeGreaterThan(0);
    expect(s.written[marker]).toBe(RT.HOLD);
    expect(s.ctrl.snapshot.job.error).toMatchObject({ line: bad, code: 20, text: program.lines[bad].text });
    // "Continuar mesmo assim": termina (a linha foi pulada pelo GRBL)
    s.ctrl.resume();
    expect(await finished(s)).toBe(true);
    expect(s.ctrl.snapshot.job.error).toBeUndefined();
    expect(inked(s.fake.penStrokes).length).toBeGreaterThan(0);
  });

  it("error numa pausa (G4) do aquecimento, com a máquina parada: pausa do mesmo jeito e dá para continuar", async () => {
    const program = regrasProgram(THREE, { warmup: 8, feed: 1500 });
    const ids = sendable(program);
    const bad = ids.filter((i) => program.lines[i].text === "G4 P0.4")[2];
    const s = await homed({ fake: { faults: { errorAtLine: { line: ids.indexOf(bad) + 1, code: 20 } } } });
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 60_000)).toBe(true);
    expect(s.ctrl.snapshot.job.error?.code).toBe(20);
    expect(s.fake.stateText).toBe("Hold:0");
    s.ctrl.resume();
    expect(await finished(s)).toBe(true);
    expect(inked(s.fake.penStrokes)).toEqual(THREE);
  });

  it.each(["G1 F1500", "M3 S220", "M5", "G0 X300.00 Y50.00"])(
    "error numa linha que não dá para pular (%s): não oferece continuar, para sozinho mantendo a posição",
    async (text) => {
      const program = regrasProgram(THREE, { feed: 1500 });
      const ids = sendable(program);
      // a ocorrência do 2º traço: o 1º já foi desenhado
      const second = program.lines.findIndex((l) => l.text === "G0 X300.00 Y50.00");
      const bad = ids.find((i) => i >= second && program.lines[i].text === text)!;
      const s = await homed({ fake: { faults: { errorAtLine: { line: ids.indexOf(bad) + 1, code: 20 } } } });
      s.ctrl.startJob(program);
      expect(await s.clock.advanceUntil(() => ["failed", "paused", "finished"].includes(jobState(s)), 120_000)).toBe(true);
      const job = s.ctrl.snapshot.job;
      expect(job.state).toBe("failed"); // nem "paused" com o botão de continuar, nem seguir até o fim
      expect(job.error).toMatchObject({ line: bad, code: 20, text });
      expect(job.message).toMatch(/não|sem ela/);
      expect(job.message).toContain(`linha ${bad + 1}`);
      // parou do jeito seguro: ! → Hold → reset, sem alarme, com o Home valendo e a caneta em cima
      expect(s.ctrl.snapshot.alarm).toBeUndefined();
      expect(s.ctrl.snapshot.homed).toBe(true);
      expect(s.fake.state).toBe("Idle");
      expect(s.fake.penDown).toBe(false);
      // sem o "G1 F1500" os pontos sairiam em G0: nada do 2º traço chegou a ser riscado inteiro
      const drawn = inked(s.fake.penStrokes);
      expect(drawn[0]).toEqual(THREE[0]);
      expect(drawn.length).toBeLessThanOrEqual(2);
      if (drawn[1]) expect(drawn[1]).not.toEqual(THREE[1]);
      expect(drawn).not.toContainEqual(THREE[2]);
      s.ctrl.resume(); // não há o que continuar
      await s.clock.advance(5000);
      expect(jobState(s)).toBe("failed");
      expect(inked(s.fake.penStrokes)).toEqual(drawn);
    },
  );

  it("linha atual acompanha a posição durante o trabalho (gerador no modo dinâmico)", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg, DEFAULT_PROFILE, { ...DEFAULT_JOB_SETTINGS, speedMode: "dynamic" });
    expect(new Set(program.lines.filter((l) => /^G1 F/.test(l.text)).map((l) => l.text)).size).toBeGreaterThan(1);
    s.ctrl.startJob(program);
    const seen: number[] = [];
    s.ctrl.subscribe((snap) => {
      const c = snap.job.currentLine;
      if (c !== undefined && seen[seen.length - 1] !== c) seen.push(c);
    });
    expect(await finished(s)).toBe(true);
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.every((v, i) => i === 0 || v > seen[i - 1])).toBe(true); // nunca volta
    expect(errorLogs(s)).toEqual([]);
  });
});

describe("pausar e continuar", () => {
  it("7. pausa agora: !, Hold:0, 0x9E (caneta sobe); continuar: 0x9E e ~ 500 ms depois, sem falha no traço", async () => {
    const s = await homed();
    const { plan, program } = programFor(curvasSvg, DEFAULT_PROFILE, FAST);
    s.ctrl.startJob(program);
    await midStroke(s, 60);
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
    expect(await finished(s)).toBe(true);
    const resumeLog = s.fake.rtLog.slice(rt1);
    expect(resumeLog.map((e) => e.byte)).toEqual([RT.SPINDLE_STOP, RT.RESUME]);
    expect(resumeLog[1].at - resumeLog[0].at).toBeGreaterThanOrEqual(500);
    expect(s.ctrl.snapshot.job.pausedMs).toBeGreaterThanOrEqual(3000);
    expectSameStrokes(mergeTouching(inked(s.fake.penStrokes)), expectedStrokes(plan));
  });

  it("pausa agora no meio de um toque do aquecimento (caneta embaixo, máquina em Idle no G4): sobe e volta a descer", async () => {
    const s = await homed();
    s.ctrl.startJob(regrasProgram(THREE, { warmup: 8, feed: 1500 }));
    expect(await s.clock.advanceUntil(() => s.fake.penDown && s.fake.dwelling && taps(s.fake.penStrokes).length === 3, 30_000, 5)).toBe(true);
    s.ctrl.pause();
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 5000, 5)).toBe(true);
    expect(s.fake.stateText).toBe("Hold:0");
    expect(s.fake.penDown).toBe(false);
    await s.clock.advance(10_000);
    s.ctrl.resume();
    await s.clock.advance(450);
    expect(s.fake.penDown).toBe(true);
    expect(await finished(s)).toBe(true);
    expect(inked(s.fake.penStrokes)).toEqual(THREE);
    expect(taps(s.fake.penStrokes)).toHaveLength(8 + 1); // o toque interrompido conta duas vezes
  });

  it("pausa agora durante um descanso longo (G4 P45, caneta em cima): Hold:0 na hora; o descanso continua de onde parou", async () => {
    const s = await homed();
    s.ctrl.startJob(regrasProgram(THREE, { feed: 1500, rests: { 1: 45 } }));
    expect(await s.clock.advanceUntil(() => s.fake.dwelling && inked(s.fake.penStrokes).length === 1, 60_000, 50)).toBe(true);
    await s.clock.advance(5000);
    expect(s.fake.dwelling).toBe(true); // é o G4 P45
    const t0 = s.clock.now();
    s.ctrl.pause();
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 1000, 5)).toBe(true);
    expect(s.clock.now() - t0).toBeLessThan(300);
    expect(s.fake.stateText).toBe("Hold:0");
    expect(s.fake.penDown).toBe(false);
    await s.clock.advance(60_000);
    expect(s.fake.dwelling).toBe(true); // a pausa não gastou o descanso
    s.ctrl.resume();
    await s.clock.advance(1000);
    expect(jobState(s)).toBe("running");
    expect(s.fake.state).toBe("Idle");
    expect(inked(s.fake.penStrokes)).toHaveLength(1);
    expect(await finished(s)).toBe(true);
    expect(inked(s.fake.penStrokes)).toEqual(THREE);
    expect(s.ctrl.snapshot.job.pausedMs).toBeGreaterThanOrEqual(60_000);
    expect(s.seen.health).toBe("ok");
  });

  it("8. pausa no fim do traço (gerador): a caneta não para no meio; pausado em Idle com a caneta em cima", async () => {
    const s = await homed({ profile: END_OF_STROKE });
    const { plan, program } = programFor(curvasSvg, END_OF_STROKE, FAST);
    s.ctrl.startJob(program);
    await midStroke(s, 60);
    s.ctrl.pause();
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 60_000, 20)).toBe(true);
    expect(s.fake.state).toBe("Idle");
    expect(s.fake.penDown).toBe(false);
    expect(s.fake.rtLog.some((e) => e.byte === RT.HOLD)).toBe(false);
    const exp = expectedStrokes(plan);
    const done = inked(s.fake.penStrokes);
    expect(done.length).toBeGreaterThan(0);
    expect(done.length).toBeLessThan(exp.length);
    expectSameStrokes(done, exp.slice(0, done.length)); // só traços inteiros
    s.ctrl.resume();
    expect(await finished(s)).toBe(true);
    expectSameStrokes(inked(s.fake.penStrokes), exp);
  });

  it("pausa no fim do traço com subida dupla: para depois do 1º M5 + G4 (caneta já em cima e assentada)", async () => {
    const s = await homed({ profile: END_OF_STROKE });
    const strokes = [zigzag(100, 100, 60, 10), [{ x: 300, y: 300 }, { x: 360, y: 300 }]];
    s.ctrl.startJob(regrasProgram(strokes, { warmup: 2, feed: 1500 }));
    await midStroke(s, 10);
    s.ctrl.pause();
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 120_000, 20)).toBe(true);
    expect(s.fake.received.slice(-2)).toEqual(["M5", "G4 P0.2"]);
    expect(s.fake.penDown).toBe(false);
    expect(s.fake.state).toBe("Idle");
    expect(inked(s.fake.penStrokes)).toEqual([strokes[0]]);
    await s.clock.advance(5000);
    expect(s.fake.received.slice(-2)).toEqual(["M5", "G4 P0.2"]); // nada mais saiu durante a pausa
    s.ctrl.resume();
    expect(await finished(s)).toBe(true);
    expect(inked(s.fake.penStrokes)).toEqual(strokes);
  });

  it("pausa no fim do traço pedida durante o aquecimento: termina o toque e para com a caneta em cima", async () => {
    const s = await homed({ profile: END_OF_STROKE });
    s.ctrl.startJob(regrasProgram(THREE, { warmup: 8, feed: 1500 }));
    expect(await s.clock.advanceUntil(() => s.fake.penDown && taps(s.fake.penStrokes).length === 2, 30_000, 5)).toBe(true);
    s.ctrl.pause();
    expect(await s.clock.advanceUntil(() => jobState(s) === "paused", 30_000, 20)).toBe(true);
    expect(s.fake.penDown).toBe(false);
    expect(s.fake.state).toBe("Idle");
    expect(taps(s.fake.penStrokes).length).toBeLessThan(8);
    expect(inked(s.fake.penStrokes)).toEqual([]);
    s.ctrl.resume();
    expect(await finished(s)).toBe(true);
    expect(taps(s.fake.penStrokes)).toHaveLength(8);
    expect(inked(s.fake.penStrokes)).toEqual(THREE);
  });
});

describe("parar, emergência e alarmes", () => {
  it("9. parar: sem ALARM, Home mantido, caneta em cima, posição igual à da parada", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg, DEFAULT_PROFILE, FAST);
    s.ctrl.startJob(program);
    await midStroke(s, 60);
    const p = s.ctrl.stop();
    const pos = { ...s.fake.wpos };
    await s.clock.advance(1000);
    await p;
    expect(jobState(s)).toBe("stopped");
    expect(s.ctrl.snapshot.job.message).toMatch(/posição foi mantida/);
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

  it("parar durante um descanso longo (G4 P45): Hold:0 na hora, reset sem alarme, posição e Home mantidos", async () => {
    const s = await homed();
    s.ctrl.startJob(regrasProgram(THREE, { feed: 1500, rests: { 1: 45 } }));
    expect(await s.clock.advanceUntil(() => s.fake.dwelling && inked(s.fake.penStrokes).length === 1, 60_000, 50)).toBe(true);
    await s.clock.advance(5000);
    const pos = { ...s.fake.wpos };
    const p = s.ctrl.stop();
    await s.clock.advance(500);
    await p;
    expect(jobState(s)).toBe("stopped");
    expect(s.ctrl.snapshot.alarm).toBeUndefined();
    expect(s.ctrl.snapshot.homed).toBe(true);
    expect(s.fake.state).toBe("Idle");
    expect(s.fake.wpos).toEqual(pos);
    expect(errorLogs(s)).toEqual([]);
  });

  it("10. parada de emergência andando: ALARM:3 e Home obrigatório", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg, DEFAULT_PROFILE, FAST);
    s.ctrl.startJob(program);
    await midStroke(s, 60);
    s.ctrl.emergencyStop();
    await s.clock.advance(300);
    expect(jobState(s)).toBe("stopped");
    expect(s.ctrl.snapshot.alarm).toBe(3);
    expect(s.ctrl.snapshot.homed).toBe(false);
    expect(s.fake.penDown).toBe(false);
    expect(s.ctrl.jobProblems(program).join(" ")).toMatch(/Faça o Home/);
    expect(errorLogs(s).some((t) => /reiniciou sozinha/.test(t))).toBe(false);
  });

  it("parada de emergência sem resposta (placa travada): avisa que o reset NÃO foi confirmado", async () => {
    const s = await homed();
    s.ctrl.startJob(regrasProgram(THREE, { feed: 1500 }));
    await midStroke(s, 5);
    s.fake.freeze();
    s.ctrl.emergencyStop();
    expect(jobState(s)).toBe("stopped");
    await s.clock.advance(2900);
    expect(errorLogs(s).some((t) => /NÃO confirmou o reset/.test(t))).toBe(false);
    await s.clock.advance(200);
    expect(errorLogs(s).some((t) => /NÃO confirmou o reset/.test(t))).toBe(true);
    expect(s.ctrl.snapshot.job.message).toMatch(/NÃO confirmou o reset/);
  });

  it("parada de emergência confirmada (banner em milissegundos): nenhum aviso de reset não confirmado", async () => {
    const s = await homed();
    s.ctrl.startJob(regrasProgram(THREE, { feed: 1500 }));
    await midStroke(s, 5);
    s.ctrl.emergencyStop();
    await s.clock.advance(5000);
    expect(errorLogs(s).some((t) => /NÃO confirmou/.test(t))).toBe(false);
    expect(s.ctrl.snapshot.job.message).toMatch(/Parada de emergência/);
    expect(s.ctrl.snapshot.alarm).toBe(3);
  });

  it("o 'ok' atrasado que o GRBL manda depois de um reset não confirma o comando seguinte", async () => {
    const s = await homed();
    s.ctrl.send("G4 P30").catch(() => {});
    await s.clock.advance(1000);
    expect(s.fake.dwelling).toBe(true);
    s.ctrl.emergencyStop(); // reset parado: o G4 interrompido ainda devolve "ok" antes do banner
    let state = "pendente";
    s.ctrl.send("G4 P1").then(
      () => (state = "ok"),
      () => (state = "descartado"),
    );
    await s.clock.advance(50);
    expect(state).toBe("descartado"); // estava na fila quando o banner chegou
    expect(s.ctrl.snapshot.alarm).toBeUndefined();
    expect(s.ctrl.snapshot.homed).toBe(true);
    let done = false;
    void s.ctrl.send("G4 P1").then(() => (done = true));
    await s.clock.advance(900);
    expect(done).toBe(false); // só no fim da pausa de 1 s
    await s.clock.advance(200);
    expect(done).toBe(true);
  });

  it("ALARM:2 (soft limit) no meio do trabalho: failed, Alarm na tela, GRBL mudo sem virar 'travada'; o Home reseta antes", async () => {
    const s = await homed();
    s.ctrl.startJob(programOf(["G21", "G90", "M5", "G4 P0.3", "G0 X100.00 Y100.00", "G0 X900.00 Y100.00", "G0 X50.00 Y50.00"]));
    expect(await s.clock.advanceUntil(() => jobState(s) === "failed", 10_000)).toBe(true);
    expect(s.ctrl.snapshot.job.message).toMatch(/ALARM:2/);
    expect(s.ctrl.snapshot.alarm).toBe(2);
    expect(s.ctrl.snapshot.needsReset).toBe(true);
    expect(s.ctrl.snapshot.homed).toBe(false);
    expect(s.ctrl.snapshot.status?.state).toBe("Alarm"); // sem esperar um relatório que não vem
    const reports = s.fake.statusReports;
    await s.clock.advance(10_000);
    expect(s.fake.statusReports).toBe(reports); // nenhum relatório até o reset
    expect(s.ctrl.snapshot.health).toBe("ok");
    expect(s.seen.health).toBe("ok");
    expect(s.fake.rxOverflow).toBe(false);
    expect(await homedAgain(s, 2000)).toBe(true);
    expect(s.ctrl.snapshot.needsReset).toBe(false);
    expect(s.ctrl.snapshot.alarm).toBeUndefined();
    await s.clock.advance(300);
    expect(s.ctrl.snapshot.status?.state).toBe("Idle");
  });

  it("alarme enquanto o Parar espera o Hold: segue direto para o reset, e a mensagem pede Home", async () => {
    const s = await homed();
    s.ctrl.startJob(regrasProgram(THREE, { feed: 1500 }));
    await midStroke(s, 5);
    const n = s.written.length;
    const p = s.ctrl.stop();
    expect(jobState(s)).toBe("stopping");
    // um fim de curso acionado bem na hora: o alarme chega antes de qualquer relatório de Hold
    s.fake.onData?.(asciiBytes("ALARM:1\r\n[MSG:Reset to continue]\r\n"));
    await s.clock.advance(20);
    expect(s.written.slice(n).filter((b) => b !== RT.STATUS)).toEqual([RT.HOLD, RT.RESET]); // não esperou os 10 s
    await s.clock.advance(500);
    await p;
    expect(jobState(s)).toBe("stopped");
    expect(s.ctrl.snapshot.job.message).toMatch(/alarme.*Home/);
    expect(s.ctrl.snapshot.homed).toBe(false);
  });

  it("Parar com a placa travada: sem Hold em 10 s vira emergência, e o reset sem banner é avisado", async () => {
    const s = await homed();
    s.ctrl.startJob(regrasProgram(THREE, { feed: 1500 }));
    await midStroke(s, 5);
    s.fake.freeze();
    const p = s.ctrl.stop();
    await s.clock.advance(10_100);
    await p;
    expect(jobState(s)).toBe("stopped");
    expect(s.ctrl.snapshot.job.message).toMatch(/não confirmou a parada/);
    await s.clock.advance(3100);
    expect(s.ctrl.snapshot.job.message).toMatch(/NÃO confirmou o reset/);
  });

  it("11. cabo desconectado na linha 200: lost/failed em menos de 100 ms, nada fica pendurado", async () => {
    const s = await homed({ fake: { faults: { disconnectAfterLines: 200 } } });
    const { program } = programFor(curvasSvg, DEFAULT_PROFILE, FAST);
    expect(sendable(program).length).toBeGreaterThan(200);
    s.ctrl.startJob(program);
    expect(await s.clock.advanceUntil(() => s.fake.cableCut, 300_000, 5)).toBe(true);
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
    const { program } = programFor(curvasSvg, DEFAULT_PROFILE, FAST);
    s.ctrl.startJob(program);
    await midStroke(s, 60);
    s.fake.powerGlitch();
    await s.clock.advance(2000);
    expect(jobState(s)).toBe("failed");
    expect(s.ctrl.snapshot.job.message).toMatch(/reiniciou/);
    expect(s.ctrl.snapshot.homed).toBe(false);
    expect(errorLogs(s).some((t) => /reiniciou sozinha/.test(t))).toBe(true);
  });

  it("erro de leitura que não derruba a porta (ruído): avisa no log e a conexão continua", async () => {
    const s = await homed();
    (s.fake as Transport).onReadError?.(new Error("FramingError"));
    expect(errorLogs(s).some((t) => /FramingError/.test(t) && /continua aberta/.test(t))).toBe(true);
    expect(s.ctrl.snapshot.link).toBe("connected");
    const p = s.ctrl.send("$G");
    await s.clock.advance(10);
    expect(await p).toEqual({ ok: true });
  });

  it("13. $32=1 na placa: aviso de configuração", async () => {
    const s = await connected({ fake: { settings: { 32: "1" } } });
    expect(s.ctrl.snapshot.settingsWarnings.some((w) => w.includes("$32"))).toBe(true);
  });
});

describe("jog, overrides e ações manuais", () => {
  it("14. jog contínuo: $J= e depois 0x85; para entre o início e a borda", async () => {
    const s = await homed();
    s.ctrl.jogContinuous({ x: -1, y: 0 }, 3000);
    await s.clock.advance(1000);
    expect(s.fake.state).toBe("Jog");
    const before = s.written.length;
    s.ctrl.jogStop();
    await s.clock.advance(300);
    expect(textOf(s.written.slice(0, before))).toContain("$J=G90 G21 X0.50 Y389.00 F3000");
    expect(s.written.slice(before)).toContain(RT.JOG_CANCEL);
    expect(s.fake.state).toBe("Idle");
    expect(s.fake.wpos.x).toBeLessThan(809);
    expect(s.fake.wpos.x).toBeGreaterThan(1);
  });

  it("sem Home: jog por passos pode (para soltar a máquina), mas 'ir para a origem' e jog contínuo não", async () => {
    const s = await connected();
    const u = s.ctrl.unlock();
    await s.clock.advance(300);
    await u;
    await s.clock.advance(300);
    expect(s.ctrl.snapshot.homed).toBe(false);
    await expect(s.ctrl.goToOrigin()).rejects.toThrow(/Home/);
    expect(() => s.ctrl.jogContinuous({ x: -1, y: 0 }, 3000)).toThrow(/Home/);
    expect(textOf(s.written)).not.toContain("$J=");
    const j = s.ctrl.jogStep({ x: -10, y: 0 }, 3000);
    await s.clock.advance(1000);
    await j;
    expect(s.fake.wpos).toEqual({ x: 800, y: 390 });
  });

  it("jog por passos: soma os destinos e não sai da área", async () => {
    const s = await homed();
    const all = Promise.all([s.ctrl.jogStep({ x: -10, y: 0 }, 3000), s.ctrl.jogStep({ x: -10, y: 0 }, 3000), s.ctrl.jogStep({ x: 5, y: 5 }, 3000)]);
    await s.clock.advance(3000);
    await all;
    expect(s.fake.wpos.x).toBeCloseTo(794);
    expect(s.fake.wpos.y).toBeCloseTo(389.5);
  });

  it("override de velocidade; override de spindle é recusado; não desconecta com trabalho rodando", async () => {
    const s = await homed();
    s.ctrl.feedOverride(RT.FEED_PLUS_10);
    expect(s.fake.feedOverride).toBe(110);
    await s.clock.advance(3000); // vários relatórios, a maioria sem o campo Ov
    expect(s.ctrl.snapshot.status?.overrides?.feed).toBe(110);
    expect(() => s.ctrl.feedOverride(0x9a)).toThrow();
    expect(() => s.ctrl.realtime(0x9b)).toThrow();
    // nenhum outro byte acima de 0x7F que o GRBL entenda passa: porta de segurança, refrigeração, override do G0
    for (const b of [0x84, 0xa0, 0xa1, 0x95, 0x96, 0x97, 0x99, 0x9c, 0x9d, 0x80, 0xff]) expect(() => s.ctrl.realtime(b)).toThrow();
    const n = s.written.length;
    for (const b of Object.values(RT)) if (b !== RT.RESET) s.ctrl.realtime(b);
    expect(s.written.slice(n).filter((b) => b >= 0x80).sort()).toEqual([RT.JOG_CANCEL, RT.FEED_RESET, RT.FEED_PLUS_10, RT.FEED_MINUS_10, RT.FEED_PLUS_1, RT.FEED_MINUS_1, RT.SPINDLE_STOP].sort());
    s.ctrl.feedOverride(RT.FEED_RESET);
    s.ctrl.feedOverride(RT.FEED_PLUS_10);
    s.ctrl.realtime(RT.RESUME); // desfaz o "!" de cima
    await s.clock.advance(50);
    const { program } = programFor(orientacaoSvg);
    s.ctrl.startJob(program);
    await expect(s.ctrl.disconnect()).rejects.toThrow(/Pare o trabalho/);
    // o M2 do fim do programa devolve o override a 100% no GRBL, e a tela acompanha
    expect(await finished(s)).toBe(true);
    await s.clock.advance(3000);
    expect(s.fake.feedOverride).toBe(100);
    expect(s.ctrl.snapshot.status?.overrides?.feed).toBe(100);
    expect(s.fake.forbiddenBytes).toEqual([]);
  });

  it("parar durante a pausa e frame com a caneta levantada", async () => {
    const s = await homed();
    const { program } = programFor(curvasSvg, DEFAULT_PROFILE, FAST);
    s.ctrl.startJob(program);
    await midStroke(s, 60);
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
    expect(escapeAction(s.ctrl.snapshot)).toBe("estop"); // Esc já vale, mesmo com o último relatório em Idle
    expect(await s.clock.advanceUntil(() => !s.ctrl.snapshot.busy, 60_000, 50)).toBe(true);
    await f;
    expect(s.fake.penStrokes.length).toBe(strokes); // nada desenhado
    expect(s.fake.wpos).toEqual({ x: 10, y: 10 });
  });

  it("alarme no meio do contorno, com todas as linhas já confirmadas: a ação rejeita na hora (não espera 2 min nem 'termina')", async () => {
    const s = await homed();
    let err: unknown;
    let done = false;
    s.ctrl.frame({ minX: 10, minY: 10, maxX: 700, maxY: 300 }).then(
      () => (done = true),
      (e) => (err = e),
    );
    await s.clock.advance(1500); // M5, G4 e os cinco G0 já tiveram ok; a máquina está andando
    expect(s.fake.state).toBe("Run");
    expect(err).toBeUndefined();
    s.fake.onData?.(asciiBytes("ALARM:1\r\n[MSG:Reset to continue]\r\n"));
    await s.clock.advance(50);
    expect(done).toBe(false);
    expect(err).toBeInstanceOf(GrblAlarmError);
    expect((err as GrblAlarmError).code).toBe(1);
    expect(s.ctrl.snapshot.busy).toBeUndefined();
    expect(s.ctrl.snapshot.needsReset).toBe(true);
  });

  it("em movimento o WCO só vem de 30 em 30 relatórios: a posição de trabalho nunca some", async () => {
    const s = await homed();
    let missing = 0;
    s.ctrl.subscribe((snap) => {
      if (snap.status && !snap.wpos) missing++;
    });
    void s.ctrl.send("G1 X0 Y389 F600"); // 80 s andando
    await s.clock.advance(20_000);
    expect(s.fake.state).toBe("Run");
    expect(missing).toBe(0);
    const w = s.ctrl.snapshot.wpos;
    expect(w && Math.abs(w.x - s.fake.wpos.x)).toBeLessThan(5);
    expect(w?.y).toBe(389);
  });
});
