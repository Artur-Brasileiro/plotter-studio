import { describe, expect, it } from "vitest";
import type { JobProgress } from "../core/grbl/controller";
import { jobElapsedS, jobFraction, jobRemainingS, plotView, type PlotInput } from "./plotView";

const job = (over: Partial<JobProgress> = {}): JobProgress => ({ state: "running", total: 1000, acked: 400, pausedMs: 0, startedAt: 1_000, ...over });
const input = (over: Partial<PlotInput> = {}): PlotInput => ({
  job: job(),
  name: "robo.png",
  estTotalS: 600,
  estAtS: 240,
  penDown: true,
  feedPct: 100,
  pauseLift: "spindleStop",
  ...over,
});
const NOW = 301_000; // 300 s depois do início

describe("tempo real de um trabalho", () => {
  it("conta do início até agora", () => {
    expect(jobElapsedS(job(), NOW)).toBe(300);
  });

  it("as pausas não contam: nem as que já passaram, nem a que está acontecendo", () => {
    expect(jobElapsedS(job({ pausedMs: 60_000 }), NOW)).toBe(240);
    expect(jobElapsedS(job({ state: "paused", pausedMs: 60_000, pausedAt: 281_000 }), NOW)).toBe(220);
  });

  it("depois de terminar, o relógio para no fim", () => {
    expect(jobElapsedS(job({ state: "finished", endedAt: 201_000 }), NOW)).toBe(200);
  });

  it("trabalho que nem começou: zero", () => {
    expect(jobElapsedS(job({ startedAt: undefined }), NOW)).toBe(0);
  });
});

describe("quanto já foi e quanto falta", () => {
  it("a fração vem do tempo estimado de onde a caneta está", () => {
    expect(jobFraction(job(), 240, 600)).toBeCloseTo(0.4);
  });

  it("sem estimativa, vale a contagem de linhas", () => {
    expect(jobFraction(job({ acked: 250 }), 0, 0)).toBeCloseTo(0.25);
  });

  it("terminado é 100%, e nunca passa disso", () => {
    expect(jobFraction(job({ state: "finished" }), 590, 600)).toBe(1);
    expect(jobFraction(job(), 700, 600)).toBe(1);
  });

  it("o que falta acompanha o ritmo real: máquina 25% mais lenta que o estimado, resto 25% mais longo", () => {
    // estimado: 240 s até aqui; real: 300 s; faltam 360 s estimados -> 450 s
    expect(jobRemainingS(240, 600, 300)).toBeCloseTo(450);
  });

  it("nos primeiros segundos ainda não dá para medir o ritmo: vale o estimado", () => {
    expect(jobRemainingS(3, 600, 4)).toBeCloseTo(597);
  });

  it("nunca fica negativo", () => {
    expect(jobRemainingS(650, 600, 700)).toBe(0);
  });
});

describe("tela de plotagem: o que ela diz em cada momento", () => {
  it("desenhando: título, nome, porcentagem, tempo decorrido e quanto falta", () => {
    const v = plotView(input(), NOW);
    expect(v.active).toBe(true);
    expect(v.tone).toBe("run");
    expect(v.title).toBe("Desenhando");
    expect(v.name).toBe("robo.png");
    expect(v.percent).toBe("40%");
    expect(v.elapsed).toBe("5 min");
    expect(v.remaining).toBe("7 min 30 s");
    expect(v.lines).toBe("linha 400 de 1.000");
  });

  it("com mais de uma caneta diz qual camada é", () => {
    const v = plotView(input({ layer: { index: 0, count: 2, penName: "Verde 0,4" } }), NOW);
    expect(v.detail).toBe("Camada 1 de 2 · Verde 0,4");
    expect(plotView(input(), NOW).detail).toBeUndefined();
  });

  it("o botão de pausa acompanha o estado", () => {
    const pause = (state: JobProgress["state"]) => plotView(input({ job: job({ state, pausedAt: state === "running" ? undefined : NOW }) }), NOW).pause;
    expect(pause("running")).toMatchObject({ label: "⏸ Pausar", disabled: false, hidden: false });
    expect(pause("pausing")).toMatchObject({ label: "Pausando…", disabled: true, hidden: false });
    expect(pause("paused")).toMatchObject({ label: "▶ Continuar", disabled: false, hidden: false });
    expect(pause("resuming")).toMatchObject({ label: "Descendo a caneta…", disabled: true, hidden: false });
    expect(pause("stopping").hidden).toBe(true);
  });

  it("parando: o botão de parar fica apagado (já foi apertado) e o título avisa", () => {
    const v = plotView(input({ job: job({ state: "stopping" }) }), NOW);
    expect(v.title).toBe("Parando…");
    expect(v.stopDisabled).toBe(true);
    expect(plotView(input(), NOW).stopDisabled).toBe(false);
  });

  it("pausado com a caneta levantada: diz o que acontece ao continuar", () => {
    const v = plotView(input({ job: job({ state: "paused", pausedAt: NOW, pauseMode: "now", penLifted: true }), penDown: false }), NOW);
    expect(v.title).toBe("Pausado");
    expect(v.tone).toBe("hold");
    expect(v.note).toContain("caneta levantada");
  });

  it("pausado mas a máquina diz que a caneta continua embaixo: avisa e diz onde mudar", () => {
    const v = plotView(input({ job: job({ state: "paused", pausedAt: NOW, pauseMode: "now", penLifted: true }), penDown: true }), NOW);
    expect(v.note).toContain("continua embaixo");
    expect(v.note).toContain("no fim do traço");
  });

  it("pausado sem levantar a caneta: atenção, ela ficou no papel", () => {
    const v = plotView(input({ job: job({ state: "paused", pausedAt: NOW, pauseMode: "now", penLifted: false }) }), NOW);
    expect(v.note).toContain("a caneta ficou no papel");
  });

  it("pausa no fim do traço: enquanto termina o traço, e depois de parado", () => {
    expect(plotView(input({ job: job({ state: "pausing", pausedAt: NOW, pauseMode: "endOfStroke" }) }), NOW).note).toContain("Terminando o traço");
    expect(plotView(input({ job: job({ state: "paused", pausedAt: NOW, pauseMode: "endOfStroke" }) }), NOW).note).toContain("caneta em cima");
  });

  it("desenhando normalmente não há aviso nenhum", () => {
    expect(plotView(input(), NOW).note).toBeUndefined();
    expect(plotView(input(), NOW).error).toBeUndefined();
  });

  it("erro numa linha: mostra qual foi, o que fazer, e só deixa continuar quando a máquina já parou", () => {
    const err = { line: 41, code: 20, text: "G7 X1" };
    const paused = plotView(input({ job: job({ state: "paused", pausedAt: NOW, error: err }) }), NOW);
    expect(paused.error?.title).toContain("linha 42");
    expect(paused.error?.title).toContain("error:20");
    expect(paused.error?.text).toBe("G7 X1");
    expect(paused.error?.action.length).toBeGreaterThan(5);
    expect(paused.error?.canContinue).toBe(true);
    expect(plotView(input({ job: job({ state: "pausing", pausedAt: NOW, error: err }) }), NOW).error?.canContinue).toBe(false);
  });

  it("a velocidade aparece como a máquina informa", () => {
    expect(plotView(input({ feedPct: 110 }), NOW).feedPct).toBe(110);
  });
});

describe("tela de plotagem: como o trabalho terminou", () => {
  const ended = (state: JobProgress["state"], over: Partial<PlotInput> = {}, message?: string) =>
    plotView(input({ job: job({ state, endedAt: 601_000, acked: state === "finished" ? 1000 : 400, message }), ...over }), 900_000);

  it("concluído: 100%, quanto levou e quanto era o estimado", () => {
    const v = ended("finished");
    expect(v.active).toBe(false);
    expect(v.tone).toBe("done");
    expect(v.title).toBe("Desenho concluído");
    expect(v.percent).toBe("100%");
    expect(v.elapsed).toBe("10 min");
    expect(v.estimated).toBe("10 min");
    expect(v.remaining).toBeUndefined();
  });

  it("camada concluída com outra na fila: diz qual caneta vem agora e o que conferir", () => {
    const v = ended("finished", { layer: { index: 0, count: 2, penName: "Verde 0,4" }, next: { index: 1, penName: "Fina 0,03" } });
    expect(v.title).toBe("Camada 1 concluída");
    expect(v.next).toContain("camada 2");
    expect(v.next).toContain("Fina 0,03");
    expect(v.next).toContain("sem mexer no papel");
  });

  it("última camada concluída: avisa que acabaram todas", () => {
    const v = ended("finished", { layer: { index: 1, count: 2, penName: "Fina 0,03" }, allLayersDone: true });
    expect(v.title).toBe("Camada 2 concluída");
    expect(v.next).toBe("Todas as camadas foram plotadas.");
  });

  it("parado por quem está usando: diz o que a máquina informou e que dá para retomar", () => {
    const v = ended("stopped", { canResume: true }, "Trabalho parado na linha 400 de 1000.");
    expect(v.tone).toBe("stopped");
    expect(v.title).toBe("Desenho parado");
    expect(v.message).toBe("Trabalho parado na linha 400 de 1000.");
    expect(v.resume).toContain("Retomar de onde parou");
    expect(v.percent).toBe("40%");
  });

  it("parado antes de desenhar qualquer coisa: não oferece retomada", () => {
    expect(ended("stopped", { canResume: false }).resume).toBeUndefined();
  });

  it("falhou: tom de erro e a explicação da máquina", () => {
    const v = ended("failed", { canResume: true }, "Conexão perdida na linha 400 de 1000.");
    expect(v.tone).toBe("failed");
    expect(v.title).toBe("O desenho falhou");
    expect(v.message).toContain("Conexão perdida");
    expect(v.resume).toContain("Retomar de onde parou");
  });
});
