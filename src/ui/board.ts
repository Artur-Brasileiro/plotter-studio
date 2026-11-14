import { Canvas, FabricText, Line, Rect } from "fabric";
import type { MachineProfile } from "../core/machine";

/**
 * Converte mm da máquina (origem embaixo à esquerda, Y para cima)
 * para pixels do canvas (origem em cima à esquerda, Y para baixo).
 */
export function makeMapper(profile: MachineProfile, pxPerMm: number) {
  const H = profile.workArea.height;
  return {
    pxPerMm,
    toPx: (x: number, y: number) => ({ left: x * pxPerMm, top: (H - y) * pxPerMm }),
    toMm: (left: number, top: number) => ({ x: left / pxPerMm, y: H - top / pxPerMm }),
  };
}

/** Desenha a mesa: área útil, grade de 10/50 mm, gabaritos A4/A3 e a origem. */
export function drawBoard(canvas: Canvas, profile: MachineProfile, pxPerMm: number) {
  const { width: W, height: H } = profile.workArea;
  const m = makeMapper(profile, pxPerMm);
  const fixed = { selectable: false, evented: false, excludeFromExport: true };
  // Fabric 7 usa origem no CENTRO por padrão; aqui tudo é posicionado pelo canto superior esquerdo.
  const label = { ...fixed, originX: "left" as const, originY: "top" as const, fontFamily: "system-ui, Segoe UI, sans-serif" };

  canvas.add(new Rect({ left: 0, top: 0, width: W * pxPerMm, height: H * pxPerMm, fill: "#fbfaf7", stroke: "#333", strokeWidth: 1, originX: "left", originY: "top", ...fixed }));

  for (let x = 10; x < W; x += 10) {
    const major = x % 50 === 0;
    canvas.add(new Line([x * pxPerMm, 0, x * pxPerMm, H * pxPerMm], { stroke: major ? "#d6d1c4" : "#ece8de", strokeWidth: 1, ...fixed }));
  }
  for (let y = 10; y < H; y += 10) {
    const major = y % 50 === 0;
    const top = m.toPx(0, y).top;
    canvas.add(new Line([0, top, W * pxPerMm, top], { stroke: major ? "#d6d1c4" : "#ece8de", strokeWidth: 1, ...fixed }));
  }

  for (const t of profile.paperTemplates) {
    const p = m.toPx(t.x, t.y + t.height);
    canvas.add(new Rect({ left: p.left, top: p.top, width: t.width * pxPerMm, height: t.height * pxPerMm, fill: "transparent", stroke: "#4a7bd0", strokeDashArray: [6, 4], strokeWidth: 1, originX: "left", originY: "top", ...fixed }));
    canvas.add(new FabricText(t.name, { left: p.left + t.width * pxPerMm - 26, top: p.top + 4, fontSize: 12, fill: "#4a7bd0", ...label }));
  }

  const o = m.toPx(0, 0);
  canvas.add(new FabricText("(0,0)", { left: o.left + 4, top: o.top - 18, fontSize: 12, fill: "#b03a2e", ...label }));
  canvas.add(new FabricText(`${W} × ${H} mm`, { left: W * pxPerMm - 90, top: H * pxPerMm - 18, fontSize: 12, fill: "#777", ...label }));
}
