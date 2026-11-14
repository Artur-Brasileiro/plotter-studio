import type { Canvas } from "fabric";
import type { MachineProfile } from "../core/machine";

/**
 * Desenha a mesa (área útil, grade, gabaritos, origem) no canvas de baixo do Fabric,
 * no evento before:render. Não são objetos do Fabric: a grade fica sempre com 1 px,
 * em qualquer zoom, e nunca entra na seleção.
 *
 * Tudo aqui é em mm da cena (Y para baixo). A grade é alinhada à origem da MÁQUINA
 * (canto inferior esquerdo), por isso as linhas horizontais ficam em y_cena = H − k·10.
 */
export function installBoard(canvas: Canvas, getProfile: () => MachineProfile): () => void {
  const handler = ({ ctx }: { ctx: CanvasRenderingContext2D }) => {
    if (ctx !== canvas.getContext()) return;
    const p = getProfile();
    const v = canvas.viewportTransform;
    const z = v[0];
    ctx.save();
    ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
    drawBoard(ctx, p, z);
    ctx.restore();
  };
  canvas.on("before:render", handler);
  return () => canvas.off("before:render", handler);
}

function drawBoard(ctx: CanvasRenderingContext2D, p: MachineProfile, z: number) {
  const { width: W, height: H } = p.workArea;
  const px = 1 / z; // 1 pixel de tela, em mm

  ctx.fillStyle = "#fbfaf7";
  ctx.fillRect(0, 0, W, H);

  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  };
  ctx.lineWidth = px;
  if (z * 10 >= 4) {
    ctx.beginPath();
    for (let x = 10; x < W; x += 10) if (x % 50 !== 0) line(x, 0, x, H);
    for (let y = 10; y < H; y += 10) if (y % 50 !== 0) line(0, H - y, W, H - y);
    ctx.strokeStyle = "#ece8de";
    ctx.stroke();
  }
  ctx.beginPath();
  for (let x = 50; x < W; x += 50) line(x, 0, x, H);
  for (let y = 50; y < H; y += 50) line(0, H - y, W, H - y);
  ctx.strokeStyle = "#d6d1c4";
  ctx.stroke();

  // gabaritos de papel (em mm da máquina → cena)
  ctx.setLineDash([6 * px, 4 * px]);
  ctx.strokeStyle = "#4a7bd0";
  ctx.fillStyle = "#4a7bd0";
  ctx.font = `${12 * px}px system-ui, "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  for (const t of p.paperTemplates) {
    const top = H - t.y - t.height;
    ctx.strokeRect(t.x, top, t.width, t.height);
    ctx.fillText(t.name, t.x + t.width - 4 * px, top + 4 * px);
  }
  ctx.setLineDash([]);

  // borda da área útil
  ctx.lineWidth = 1.5 * px;
  ctx.strokeStyle = "#333";
  ctx.strokeRect(0, 0, W, H);

  // origem da máquina: setas X+ (direita) e Y+ (para cima na tela = para longe do operador)
  const a = 30 * px;
  const head = 6 * px;
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = ctx.fillStyle = "#b03a2e";
  ctx.beginPath();
  line(0, H, a, H);
  line(a, H, a - head, H - head / 1.5);
  line(a, H, a - head, H + head / 1.5);
  ctx.stroke();
  ctx.strokeStyle = ctx.fillStyle = "#2e7d32";
  ctx.beginPath();
  line(0, H, 0, H - a);
  line(0, H - a, -head / 1.5, H - a + head);
  line(0, H - a, head / 1.5, H - a + head);
  ctx.stroke();

  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillStyle = "#b03a2e";
  ctx.fillText("(0,0)", 4 * px, H - 4 * px);
  ctx.fillText("X+", a + 3 * px, H + 5 * px);
  ctx.fillStyle = "#2e7d32";
  ctx.fillText("Y+", 4 * px, H - a);

  ctx.textAlign = "right";
  ctx.fillStyle = "#777";
  ctx.fillText(`${W} × ${H} mm`, W - 6 * px, H - 4 * px);
}
