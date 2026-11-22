import type { Canvas } from "fabric";
import { isDark } from "../core/color";
import type { MachineProfile } from "../core/machine";
import { paperColor } from "./paper";

/**
 * Desenha a mesa no canvas de baixo do Fabric, no evento before:render: o tampo (curso da máquina),
 * as réguas riscadas nele, a folha (zona de desenho), os gabaritos de papel e a origem.
 * Não são objetos do Fabric: as linhas ficam sempre com 1 px, em qualquer zoom, e nunca entram na seleção.
 *
 * Tudo aqui é em mm da cena (Y para baixo). A grade é alinhada à origem da MÁQUINA
 * (canto inferior esquerdo), por isso as linhas horizontais ficam em y_cena = H − k·10.
 */
export function installBoard(canvas: Canvas, getProfile: () => MachineProfile, showCrosses: () => boolean = () => false): () => void {
  const handler = ({ ctx }: { ctx: CanvasRenderingContext2D }) => {
    if (ctx !== canvas.getContext()) return;
    const p = getProfile();
    const v = canvas.viewportTransform;
    const z = v[0];
    ctx.save();
    ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
    drawBoard(ctx, p, z, showCrosses());
    ctx.restore();
  };
  canvas.on("before:render", handler);
  return () => canvas.off("before:render", handler);
}

// cores da mesa (as mesmas de --table e --paper em style.css)
const TABLE = "#dcc09a";
const TABLE_EDGE = "#8a6f48";
const GRAPHITE = "74, 58, 38"; // lápis sobre a madeira
const PAPER_GRID = "20, 33, 61"; // tinta, bem fraca (em papel escuro a grade é clara)
const PAPER_GRID_LIGHT = "236, 240, 248";
const PLAN = "#1b4fa8";
const INK = "#14213d";
const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif';

function drawBoard(ctx: CanvasRenderingContext2D, p: MachineProfile, z: number, crosses: boolean) {
  const { width: W, height: H } = p.workArea;
  const zone = p.drawZone;
  const px = 1 / z; // 1 pixel de tela, em mm
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  };

  // ---------------------------------------------------------------- tampo
  ctx.fillStyle = TABLE;
  ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = px;
  if (z * 10 >= 5) {
    ctx.beginPath();
    for (let x = 10; x < W; x += 10) if (x % 50 !== 0) line(x, 0, x, H);
    for (let y = 10; y < H; y += 10) if (y % 50 !== 0) line(0, H - y, W, H - y);
    ctx.strokeStyle = `rgba(${GRAPHITE}, 0.13)`;
    ctx.stroke();
  }
  ctx.beginPath();
  for (let x = 50; x < W; x += 50) line(x, 0, x, H);
  for (let y = 50; y < H; y += 50) line(0, H - y, W, H - y);
  ctx.strokeStyle = `rgba(${GRAPHITE}, 0.3)`;
  ctx.stroke();

  // ---------------------------------------------------------------- folha (zona de desenho)
  const zx = zone.minX, zy = H - zone.maxY, zw = zone.maxX - zone.minX, zh = zone.maxY - zone.minY;
  ctx.fillStyle = "rgba(60, 44, 20, 0.22)";
  ctx.fillRect(zx + 2.5 * px, zy + 3 * px, zw, zh); // sombra da folha no tampo
  // a folha tem a cor do papel escolhido (src/ui/paper.ts): caneta branca em papel preto aparece como vai sair
  const paper = paperColor();
  const grid = isDark(paper) ? PAPER_GRID_LIGHT : PAPER_GRID;
  ctx.fillStyle = paper;
  ctx.fillRect(zx, zy, zw, zh);
  ctx.save();
  ctx.beginPath();
  ctx.rect(zx, zy, zw, zh);
  ctx.clip();
  if (z * 10 >= 5) {
    ctx.beginPath();
    for (let x = 10; x < W; x += 10) if (x % 50 !== 0) line(x, 0, x, H);
    for (let y = 10; y < H; y += 10) if (y % 50 !== 0) line(0, H - y, W, H - y);
    ctx.strokeStyle = `rgba(${grid}, 0.05)`;
    ctx.stroke();
  }
  ctx.beginPath();
  for (let x = 50; x < W; x += 50) line(x, 0, x, H);
  for (let y = 50; y < H; y += 50) line(0, H - y, W, H - y);
  ctx.strokeStyle = `rgba(${grid}, 0.1)`;
  ctx.stroke();
  ctx.restore();
  ctx.lineWidth = px;
  ctx.strokeStyle = `rgba(${PAPER_GRID}, 0.35)`;
  ctx.strokeRect(zx, zy, zw, zh);

  // ---------------------------------------------------------------- gabaritos de papel
  ctx.font = `${12 * px}px ${FONT}`;
  ctx.setLineDash([6 * px, 4 * px]);
  ctx.strokeStyle = PLAN;
  ctx.fillStyle = PLAN;
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  for (const t of p.paperTemplates) {
    const top = H - t.y - t.height;
    ctx.strokeRect(t.x, top, t.width, t.height);
    ctx.fillText(t.name, t.x + t.width - 4 * px, top + 4 * px);
  }
  ctx.setLineDash([]);

  // ---------------------------------------------------------------- réguas (números a cada 50 mm, se couberem)
  if (z * 50 >= 34) {
    ctx.fillStyle = `rgba(${GRAPHITE}, 0.85)`;
    ctx.font = `${11 * px}px ${FONT}`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    for (let x = 50; x < W; x += 50) ctx.fillText(String(x), x + 3 * px, H - 2 * px);
    for (let y = 50; y < H; y += 50) ctx.fillText(String(y), 3 * px, H - y - 2 * px);
  }

  // ---------------------------------------------------------------- borda do tampo
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = TABLE_EDGE;
  ctx.strokeRect(0, 0, W, H);

  // ---------------------------------------------------------------- legendas
  ctx.font = `${12 * px}px ${FONT}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  ctx.fillStyle = `rgba(${GRAPHITE}, 0.9)`;
  ctx.fillText(`curso da máquina ${W} × ${H} mm`, W - 6 * px, 5 * px);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = `rgba(${grid}, 0.55)`;
  ctx.fillText(`folha ${fmt(zw)} × ${fmt(zh)} mm`, zx + 5 * px, zy + 4 * px);

  // ---------------------------------------------------------------- ponto seguro do aquecimento do servo
  if (p.shield.enabled && p.shield.warmupCycles > 0) {
    const sx = p.shield.safeX, sy = H - p.shield.safeY;
    const r = 5 * px;
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    line(sx - r * 1.7, sy, sx + r * 1.7, sy);
    line(sx, sy - r * 1.7, sx, sy + r * 1.7);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- cruzes de registro (quando o trabalho tem mais de uma caneta)
  if (crosses) {
    const r = p.registration;
    const hArm = r.armMm / 2;
    ctx.lineWidth = Math.max(1.5 * px, 0.4);
    ctx.strokeStyle = PLAN;
    ctx.beginPath();
    for (const cx of [r.x1, r.x2]) {
      const cy = H - r.y;
      line(cx - hArm, cy, cx + hArm, cy);
      line(cx, cy - hArm, cx, cy + hArm);
    }
    ctx.stroke();
    // (sem legenda: ali embaixo ficam os números da régua; o passo Desenho explica as cruzes)
  }


  // ---------------------------------------------------------------- origem: X+ (direita) e Y+ (para longe do operador)
  const a = 30 * px;
  const head = 6 * px;
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = ctx.fillStyle = "#c0362c";
  ctx.beginPath();
  line(0, H, a, H);
  line(a, H, a - head, H - head / 1.5);
  line(a, H, a - head, H + head / 1.5);
  ctx.stroke();
  ctx.strokeStyle = "#12805c";
  ctx.beginPath();
  line(0, H, 0, H - a);
  line(0, H - a, -head / 1.5, H - a + head);
  line(0, H - a, head / 1.5, H - a + head);
  ctx.stroke();
  ctx.font = `600 ${12 * px}px ${FONT}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "#c0362c";
  ctx.fillText("X+", a + 3 * px, H + 3 * px);
  ctx.fillStyle = INK;
  ctx.fillText("(0,0)", -2 * px, H + 16 * px);
  ctx.textBaseline = "bottom";
  ctx.textAlign = "right";
  ctx.fillStyle = "#12805c";
  ctx.fillText("Y+", -5 * px, H - a + 4 * px);
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString("pt-BR");
