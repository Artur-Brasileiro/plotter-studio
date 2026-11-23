// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Player, type Overlay } from "../overlay";
import { createPreviewControls } from "./previewControls";

/** O que o Player e a seção usam do Overlay, sem o canvas de verdade. */
function fakeOverlay(totalTime = 0) {
  const o = {
    totalTime,
    visible: false,
    playhead: undefined as number | undefined,
    onPlanChange: () => {},
    get isVisible() {
      return o.visible;
    },
    setVisible(v: boolean) {
      o.visible = v;
    },
    setPlayhead(t: number | undefined) {
      o.playhead = t;
    },
    /** como o `setPlan` de verdade: troca o plano e avisa */
    plan(total: number) {
      o.totalTime = total;
      o.onPlanChange();
    },
  };
  return o;
}

describe("seção Pré-visualização (passo Conferir)", () => {
  afterEach(() => document.body.replaceChildren());

  const setup = (totalTime = 0) => {
    const overlay = fakeOverlay(totalTime);
    const player = new Player(overlay as unknown as Overlay);
    const root = createPreviewControls(overlay as unknown as Overlay, player);
    document.body.append(root);
    const box = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const time = root.querySelector<HTMLElement>(".preview-time")!;
    const toggle = (on: boolean) => {
      box.checked = on;
      box.dispatchEvent(new Event("change"));
    };
    return { overlay, player, root, box, time, toggle };
  };

  it("marcar Mostrar o caminho mostra o caminho", () => {
    const { overlay, box, toggle } = setup();
    toggle(true);
    expect(overlay.visible).toBe(true);
    expect(box.checked).toBe(true);
  });

  it("desmarcar esconde o caminho, e a caixa fica desmarcada (antes ela voltava a ficar marcada)", () => {
    const { overlay, box, toggle } = setup();
    toggle(true);
    toggle(false);
    expect(overlay.visible).toBe(false);
    expect(box.checked).toBe(false);
  });

  it("desmarcar no meio da animação para a animação e esconde o caminho", () => {
    const { overlay, player, box, toggle } = setup(600);
    toggle(true);
    player.play();
    expect(player.playing).toBe(true);
    toggle(false);
    expect(player.playing).toBe(false);
    expect(overlay.visible).toBe(false);
    expect(box.checked).toBe(false);
  });

  it("o tempo total aparece logo, sem precisar apertar Play", () => {
    expect(setup(1764).time.textContent).toBe("0:00 / 29:24");
  });

  it("o tempo acompanha quando o desenho muda (antes ficava parado no valor antigo)", () => {
    const { overlay, time } = setup(1764);
    overlay.plan(900);
    expect(time.textContent).toBe("0:00 / 15:00");
  });

  it("sem desenho na mesa não mostra tempo nenhum", () => {
    const { overlay, time } = setup(1764);
    overlay.plan(0);
    expect(time.textContent).toBe("");
  });

  it("quando o desenho muda com a animação parada no meio, ela volta ao começo", () => {
    const { overlay, player, time } = setup(600);
    player.play();
    player.pause();
    overlay.playhead = 300;
    overlay.plan(120);
    expect(overlay.playhead).toBeUndefined();
    expect(time.textContent).toBe("0:00 / 2:00");
  });

  it("a legenda usa uma classe só dela: a das bolinhas de cor do papel a transformava em argolas", () => {
    const { root } = setup();
    expect(root.querySelectorAll(".legend .swatch").length).toBe(0);
    expect(root.querySelectorAll(".legend .legend-line").length).toBe(5);
  });
});
