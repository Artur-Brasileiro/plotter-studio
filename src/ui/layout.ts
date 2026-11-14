/** Elementos fixos da página (definidos em index.html). */
export interface Layout {
  readonly toolbar: HTMLElement;
  readonly canvasWrap: HTMLElement;
  readonly canvasEl: HTMLCanvasElement;
  readonly side: HTMLElement;
  readonly status: HTMLElement;
  /** v2: console recolhível */
  readonly console: HTMLElement;
}

export function getLayout(): Layout {
  const byId = <T extends HTMLElement>(id: string) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Elemento #${id} não encontrado no index.html`);
    return el as T;
  };
  return {
    toolbar: byId("toolbar"),
    canvasWrap: byId("canvas-wrap"),
    canvasEl: byId<HTMLCanvasElement>("board"),
    side: byId("side"),
    status: byId("statusbar"),
    console: byId("console"),
  };
}
