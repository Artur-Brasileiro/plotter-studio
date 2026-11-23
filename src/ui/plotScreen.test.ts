// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobProgress } from "../core/grbl/controller";
import { createPlotScreen, type PlotActions } from "./plotScreen";
import { plotView, type PlotInput } from "./plotView";

const NOW = 301_000;
const job = (over: Partial<JobProgress> = {}): JobProgress => ({ state: "running", total: 1000, acked: 400, pausedMs: 0, startedAt: 1_000, ...over });
const view = (over: Partial<PlotInput> = {}, now = NOW) =>
  plotView({ job: job(), name: "robo.png", estTotalS: 600, estAtS: 240, penDown: true, feedPct: 100, pauseLift: "spindleStop", ...over }, now);

describe("tela de plotagem", () => {
  afterEach(() => document.body.replaceChildren());

  const setup = (soundOn = true) => {
    const actions: PlotActions = { stop: vi.fn(), togglePause: vi.fn(), continueAfterError: vi.fn(), feed: vi.fn(), emergency: vi.fn(), dismiss: vi.fn() };
    const sounds = { enabled: soundOn, setEnabled: vi.fn((on: boolean) => void (sounds.enabled = on)), play: vi.fn(() => true) };
    const screen = createPlotScreen(actions, sounds);
    document.body.append(screen.el);
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => screen.el.querySelector<T>(sel)!;
    const text = (sel: string) => q(sel).textContent;
    const shown = (sel: string) => {
      for (let e: HTMLElement | null = q(sel); e && e !== screen.el.parentElement; e = e.parentElement) if (e.hidden) return false;
      return true;
    };
    return { actions, sounds, screen, q, text, shown };
  };

  it("sem trabalho na máquina a tela não aparece", () => {
    const { screen } = setup();
    expect(screen.el.hidden).toBe(true);
    expect(screen.visible).toBe(false);
  });

  it("desenhando: mostra o que está sendo feito, quanto já foi e quanto falta", () => {
    const { screen, text } = setup();
    screen.show(view());
    expect(screen.el.hidden).toBe(false);
    expect(screen.visible).toBe(true);
    expect(text(".plot-title")).toBe("Desenhando");
    expect(text(".plot-name")).toBe("robo.png");
    expect(text(".plot-percent")).toBe("40%");
    expect(text(".plot-elapsed")).toBe("5 min");
    expect(text(".plot-remaining")).toBe("~7 min 30 s");
    expect(text(".plot-lines")).toBe("linha 400 de 1.000");
  });

  it("a barra anda com a porcentagem, e quem usa leitor de tela também fica sabendo", () => {
    const { screen, q } = setup();
    screen.show(view());
    expect(q(".plot-bar-fill").style.width).toBe("40%");
    expect(q(".plot-bar").getAttribute("role")).toBe("progressbar");
    expect(q(".plot-bar").getAttribute("aria-valuenow")).toBe("40");
  });

  it("o botão grande de parar para o desenho, sem perguntar nada", () => {
    const { screen, q, actions } = setup();
    screen.show(view());
    expect(q(".plot-stop").textContent).toContain("Parar");
    q(".plot-stop").click();
    expect(actions.stop).toHaveBeenCalledTimes(1);
  });

  it("depois de apertar parar o botão apaga (a máquina já está parando)", () => {
    const { screen, q } = setup();
    screen.show(view({ job: job({ state: "stopping" }) }));
    expect(q<HTMLButtonElement>(".plot-stop").disabled).toBe(true);
    expect(q(".plot-title").textContent).toBe("Parando…");
  });

  it("pausar e continuar são o mesmo botão, com o nome do que ele faz agora", () => {
    const { screen, q, actions } = setup();
    screen.show(view());
    expect(q(".plot-pause").textContent).toBe("⏸ Pausar");
    q(".plot-pause").click();
    expect(actions.togglePause).toHaveBeenCalledTimes(1);
    screen.show(view({ job: job({ state: "paused", pausedAt: NOW, penLifted: true }), penDown: false }));
    expect(q(".plot-pause").textContent).toBe("▶ Continuar");
    screen.show(view({ job: job({ state: "pausing", pausedAt: NOW }) }));
    expect(q<HTMLButtonElement>(".plot-pause").disabled).toBe(true);
    screen.show(view({ job: job({ state: "stopping" }) }));
    expect(q(".plot-pause").hidden).toBe(true);
  });

  it("o aviso da pausa aparece só quando há o que dizer", () => {
    const { screen, q } = setup();
    screen.show(view());
    expect(q(".plot-note").hidden).toBe(true);
    screen.show(view({ job: job({ state: "paused", pausedAt: NOW, penLifted: true }), penDown: false }));
    expect(q(".plot-note").hidden).toBe(false);
    expect(q(".plot-note").textContent).toContain("caneta levantada");
  });

  it("a velocidade aparece e os três botões mandam o ajuste certo", () => {
    const { screen, q, actions } = setup();
    screen.show(view({ feedPct: 110 }));
    expect(q(".plot-speed-value").textContent).toBe("110%");
    const [minus, reset, plus] = [...screen.el.querySelectorAll<HTMLButtonElement>(".plot-speed button")];
    minus.click();
    reset.click();
    plus.click();
    expect((actions.feed as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["minus", "reset", "plus"]);
  });

  it("erro numa linha: mostra o erro, e Continuar mesmo assim só acende com a máquina parada", () => {
    const { screen, q, actions, shown } = setup();
    const err = { line: 41, code: 20, text: "G7 X1" };
    screen.show(view());
    expect(shown(".plot-error")).toBe(false);
    screen.show(view({ job: job({ state: "pausing", pausedAt: NOW, error: err }) }));
    expect(shown(".plot-error")).toBe(true);
    expect(q(".plot-error").textContent).toContain("linha 42");
    expect(q(".plot-error").textContent).toContain("G7 X1");
    expect(q<HTMLButtonElement>(".plot-error button").disabled).toBe(true);
    screen.show(view({ job: job({ state: "paused", pausedAt: NOW, error: err }) }));
    expect(q<HTMLButtonElement>(".plot-error button").disabled).toBe(false);
    q(".plot-error button").click();
    expect(actions.continueAfterError).toHaveBeenCalledTimes(1);
  });

  it("emergência também está à mão", () => {
    const { screen, q, actions } = setup();
    screen.show(view());
    q(".plot-estop").click();
    expect(actions.emergency).toHaveBeenCalledTimes(1);
  });

  it("concluído: somem os botões de parar e pausar, aparece quanto levou e o botão de voltar", () => {
    const { screen, q, text, actions, shown } = setup();
    screen.show(view({ job: job({ state: "finished", acked: 1000, endedAt: 601_000 }) }, 900_000));
    expect(text(".plot-title")).toBe("Desenho concluído");
    expect(text(".plot-percent")).toBe("100%");
    expect(shown(".plot-stop")).toBe(false);
    expect(shown(".plot-pause")).toBe(false);
    expect(shown(".plot-speed")).toBe(false);
    expect(shown(".plot-back")).toBe(true);
    // no lugar de "Falta", o estimado: dá para comparar com o que levou
    expect(text(".plot-elapsed")).toBe("10 min");
    expect(text(".plot-remaining-label")).toBe("Estimado");
    expect(text(".plot-remaining")).toBe("10 min");
    q(".plot-back").click();
    expect(actions.dismiss).toHaveBeenCalledTimes(1);
  });

  it("enquanto desenha não existe botão de voltar: a tela só sai quando o trabalho acaba", () => {
    const { screen, shown } = setup();
    screen.show(view());
    expect(shown(".plot-back")).toBe(false);
  });

  it("camada concluída com outra na fila: diz qual caneta colocar", () => {
    const { screen, q } = setup();
    screen.show(view({ job: job({ state: "finished", endedAt: 601_000 }), layer: { index: 0, count: 2, penName: "Verde 0,4" }, next: { index: 1, penName: "Fina 0,03" } }, 900_000));
    expect(q(".plot-next").hidden).toBe(false);
    expect(q(".plot-next").textContent).toContain("Fina 0,03");
  });

  it("parado ou com falha: diz o motivo e como retomar", () => {
    const { screen, q, text } = setup();
    screen.show(view({ job: job({ state: "stopped", endedAt: 601_000, message: "Trabalho parado na linha 400 de 1000." }), canResume: true }, 900_000));
    expect(text(".plot-title")).toBe("Desenho parado");
    expect(text(".plot-message")).toBe("Trabalho parado na linha 400 de 1000.");
    expect(q(".plot-resume").textContent).toContain("Retomar de onde parou");
    screen.show(view({ job: job({ state: "failed", endedAt: 601_000, message: "Conexão perdida." }) }, 900_000));
    expect(text(".plot-title")).toBe("O desenho falhou");
    expect(q(".plot-resume").hidden).toBe(true);
  });

  it("o Parar não sai do lugar: os avisos da pausa e de erro aparecem abaixo dele, nunca o empurram para baixo", () => {
    const { screen, q } = setup();
    screen.show(view({ job: job({ state: "paused", pausedAt: NOW, penLifted: true, error: { line: 41, code: 20, text: "G7 X1" } }), penDown: false }));
    const after = (a: HTMLElement, b: HTMLElement) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(q(".plot-note").hidden).toBe(false);
    expect(after(q(".plot-stop"), q(".plot-note"))).toBe(true);
    expect(after(q(".plot-stop"), q(".plot-error"))).toBe(true);
    expect(after(q(".plot-pause"), q(".plot-note"))).toBe(true);
  });

  it("enquanto desenha, o segundo número é quanto falta", () => {
    const { screen, text } = setup();
    screen.show(view());
    expect(text(".plot-remaining-label")).toBe("Falta");
  });

  it("a cara da tela muda com o momento (andando, esperando, concluído, parado, falhou)", () => {
    const { screen } = setup();
    const tone = () => [...screen.el.classList].filter((c) => c.startsWith("tone-"));
    screen.show(view());
    expect(tone()).toEqual(["tone-run"]);
    screen.show(view({ job: job({ state: "paused", pausedAt: NOW }) }));
    expect(tone()).toEqual(["tone-hold"]);
    screen.show(view({ job: job({ state: "finished", endedAt: 601_000 }) }, 900_000));
    expect(tone()).toEqual(["tone-done"]);
    screen.show(view({ job: job({ state: "failed", endedAt: 601_000 }) }, 900_000));
    expect(tone()).toEqual(["tone-failed"]);
  });

  it("a caixinha do som mostra a escolha guardada, e ligar toca uma amostra", () => {
    const off = setup(false);
    off.screen.show(view());
    const box = off.q<HTMLInputElement>(".plot-sound input");
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(off.sounds.setEnabled).toHaveBeenCalledWith(true);
    expect(off.sounds.play).toHaveBeenCalledWith("done");

    const on = setup(true);
    on.screen.show(view());
    const box2 = on.q<HTMLInputElement>(".plot-sound input");
    expect(box2.checked).toBe(true);
    box2.checked = false;
    box2.dispatchEvent(new Event("change"));
    expect(on.sounds.setEnabled).toHaveBeenCalledWith(false);
    expect(on.sounds.play).not.toHaveBeenCalled();
  });

  it("some quando não há mais o que mostrar", () => {
    const { screen } = setup();
    screen.show(view());
    screen.show(undefined);
    expect(screen.el.hidden).toBe(true);
    expect(screen.visible).toBe(false);
  });
});
