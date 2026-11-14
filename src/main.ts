import { Canvas } from "fabric";
import { DEFAULT_PROFILE } from "./core/machine";
import { drawBoard } from "./ui/board";
import "./style.css";

const profile = DEFAULT_PROFILE;
const wrap = document.getElementById("canvas-wrap")!;

// Escala para caber na largura da janela (o resto da UI entra nas próximas fases).
const pxPerMm = Math.max(0.5, (wrap.clientWidth - 2) / profile.workArea.width);

const canvas = new Canvas("board", {
  width: profile.workArea.width * pxPerMm,
  height: profile.workArea.height * pxPerMm,
  selection: true,
  preserveObjectStacking: true,
});

drawBoard(canvas, profile, pxPerMm);
canvas.requestRenderAll();
