import { Point, type Canvas, type TPointerEventInfo } from "fabric";
import { isTyping } from "./dom";

/** Enquadra a área útil inteira no canvas, centralizada, com margem em px. */
export function fitToScreen(canvas: Canvas, area: { width: number; height: number }, marginPx = 24): void {
  const w = canvas.getWidth();
  const h = canvas.getHeight();
  const z = Math.max(0.05, Math.min((w - 2 * marginPx) / area.width, (h - 2 * marginPx) / area.height));
  canvas.setViewportTransform([z, 0, 0, z, (w - area.width * z) / 2, (h - area.height * z) / 2]);
}

/**
 * Zoom pela roda do mouse (centrado no cursor) e pan com espaço + arrastar ou botão do meio.
 * Zoom em px por mm. Devolve a função que desliga tudo.
 */
export function installZoomPan(
  canvas: Canvas,
  opts: { minZoom: number; maxZoom: number; onChange?: () => void; onPan?: (active: boolean) => void },
): () => void {
  let spaceDown = false;
  let panning = false;
  let last = { x: 0, y: 0 };
  let saved = { selection: true, skipTargetFind: false };
  const el = canvas.upperCanvasEl;

  const onWheel = (opt: TPointerEventInfo<WheelEvent>) => {
    const e = opt.e;
    const zoom = Math.min(opts.maxZoom, Math.max(opts.minZoom, canvas.getZoom() * 0.999 ** e.deltaY));
    canvas.zoomToPoint(new Point(e.offsetX, e.offsetY), zoom);
    e.preventDefault();
    e.stopPropagation();
    opts.onChange?.();
  };

  const startPan = (e: MouseEvent) => {
    panning = true;
    opts.onPan?.(true);
    last = { x: e.clientX, y: e.clientY };
    saved = { selection: canvas.selection, skipTargetFind: canvas.skipTargetFind };
    canvas.selection = false;
    canvas.skipTargetFind = true;
    canvas.discardActiveObject();
    canvas.setCursor("grabbing");
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault(); // botão do meio: sem a rolagem automática do navegador
      e.stopImmediatePropagation();
      startPan(e);
    }
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!panning) return;
    canvas.relativePan(new Point(e.clientX - last.x, e.clientY - last.y));
    last = { x: e.clientX, y: e.clientY };
    opts.onChange?.();
  };
  const onMouseUp = () => {
    if (!panning) return;
    panning = false;
    opts.onPan?.(false);
    canvas.selection = saved.selection;
    canvas.skipTargetFind = spaceDown ? true : saved.skipTargetFind;
    canvas.setCursor(spaceDown ? "grab" : "default");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== "Space" || spaceDown || isTyping()) return;
    spaceDown = true;
    canvas.skipTargetFind = true;
    canvas.defaultCursor = "grab";
    canvas.setCursor("grab");
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== "Space" || !spaceDown) return;
    spaceDown = false;
    if (!panning) canvas.skipTargetFind = false;
    canvas.defaultCursor = "default";
    canvas.setCursor("default");
  };

  canvas.on("mouse:wheel", onWheel);
  // captura antes do Fabric, para o pan não começar uma seleção ou um arraste
  el.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    canvas.off("mouse:wheel", onWheel);
    el.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
