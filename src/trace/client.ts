import type { TraceOptions, TraceResult } from "../core/trace/traceImage";
import type { GrayImage } from "../core/trace/types";
import type { LayerTime, PlanReply, PlanRequest } from "./planWorker";
import type { TraceReply, TraceRequest } from "./worker";

/** Lado maior aceito: imagens maiores são reduzidas ao abrir (o traçado amplia por dentro de qualquer jeito). */
const MAX_SIDE = 4000;

export interface LoadedImage {
  readonly gray: GrayImage;
  /** Os pixels coloridos (R, G, B, A), com o fundo transparente já em branco: o modo "illus" usa a cor */
  readonly rgba: Uint8ClampedArray;
  /** A imagem como foi aberta (já reduzida, se era grande demais), para mostrar na tela */
  readonly bitmap: ImageBitmap;
  readonly name: string;
  /** Tamanho original do arquivo, se foi reduzido */
  readonly reducedFrom?: { width: number; height: number };
}

/** Abre PNG/JPG/WebP e converte para tons de cinza (fundo transparente vira branco). */
export async function loadImage(file: File): Promise<LoadedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`Não consegui abrir "${file.name}" como imagem.`);
  }
  let reducedFrom: LoadedImage["reducedFrom"];
  const side = Math.max(bitmap.width, bitmap.height);
  if (side > MAX_SIDE) {
    reducedFrom = { width: bitmap.width, height: bitmap.height };
    const s = MAX_SIDE / side;
    const small = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * s), resizeHeight: Math.round(bitmap.height * s), resizeQuality: "high" });
    bitmap.close();
    bitmap = small;
  }
  const { width, height } = bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext("2d", { willReadFrequently: true });
  if (!c) throw new Error("O navegador não liberou um canvas para ler a imagem.");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, width, height);
  c.drawImage(bitmap, 0, 0);
  const rgba = c.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  // mesma conta do OpenCV (BGR2GRAY)
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]);
  return { gray: { width, height, data }, rgba, bitmap, name: file.name, reducedFrom };
}

/**
 * Roda o traçado num worker. Uma chamada nova cancela a anterior (o worker é encerrado e recriado):
 * mexer num ajuste no meio do cálculo não empilha trabalho.
 */
export class Tracer {
  private worker: Worker | undefined;
  private seq = 0;
  private rejectCurrent: ((e: Error) => void) | undefined;

  run(
    gray: GrayImage,
    options: Partial<TraceOptions>,
    onProgress: (fraction: number, label: string) => void,
    rgba?: Uint8ClampedArray,
  ): Promise<{ result: TraceResult; ms: number }> {
    this.cancel();
    const id = ++this.seq;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      this.rejectCurrent = reject;
      worker.onmessage = (e: MessageEvent<TraceReply>) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === "progress") onProgress(m.fraction, m.label);
        else {
          this.rejectCurrent = undefined;
          worker.terminate();
          if (this.worker === worker) this.worker = undefined;
          if (m.type === "done") resolve({ result: m.result, ms: m.ms });
          else reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => {
        this.rejectCurrent = undefined;
        reject(new Error(e.message || "O traçado falhou."));
      };
      // cópia dos pixels: a original fica com a tela, para rodar de novo com outros ajustes
      const data = gray.data.slice();
      // a cor só viaja quando o modo usa (são 4 bytes por pixel a mais)
      const color = options.mode === "illus" && rgba ? rgba.slice() : undefined;
      const req: TraceRequest = { id, width: gray.width, height: gray.height, data, rgba: color, options };
      worker.postMessage(req, color ? [data.buffer, color.buffer] : [data.buffer]);
    });
  }

  /** Encerra o cálculo em andamento. A promessa dele é rejeitada com `CancelledError`. */
  cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
    }
    const r = this.rejectCurrent;
    this.rejectCurrent = undefined;
    r?.(new CancelledError());
  }
}

export class CancelledError extends Error {
  constructor() {
    super("cancelado");
    this.name = "CancelledError";
  }
}

/**
 * O tempo de máquina de um traçado, calculado num worker pelo mesmo planejador do passo Conferir.
 * Uma chamada nova cancela a anterior.
 */
export class PlanEstimator {
  private worker: Worker | undefined;
  private seq = 0;
  private rejectCurrent: ((e: Error) => void) | undefined;

  run(req: Omit<PlanRequest, "id">): Promise<readonly LayerTime[]> {
    this.cancel();
    const id = ++this.seq;
    const worker = new Worker(new URL("./planWorker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      this.rejectCurrent = reject;
      const finish = () => {
        this.rejectCurrent = undefined;
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
      };
      worker.onmessage = (e: MessageEvent<PlanReply>) => {
        const m = e.data;
        if (m.id !== id) return;
        finish();
        if (m.type === "done") resolve(m.layers);
        else reject(new Error(m.message));
      };
      worker.onerror = (e) => {
        finish();
        reject(new Error(e.message || "Não consegui calcular o tempo."));
      };
      worker.postMessage({ ...req, id } satisfies PlanRequest);
    });
  }

  cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
    }
    const r = this.rejectCurrent;
    this.rejectCurrent = undefined;
    r?.(new CancelledError());
  }
}
