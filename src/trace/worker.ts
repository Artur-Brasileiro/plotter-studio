// Worker da vetorização: o traçado leva de segundos a um minuto e não pode travar a tela.
import { traceImage, type TraceOptions, type TraceResult } from "../core/trace/traceImage";

export interface TraceRequest {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
  /** Os pixels coloridos (R, G, B, A), só quando o modo usa cor ("illus") */
  readonly rgba?: Uint8ClampedArray;
  readonly options: Partial<TraceOptions>;
}

export type TraceReply =
  | { readonly id: number; readonly type: "progress"; readonly fraction: number; readonly label: string }
  | { readonly id: number; readonly type: "done"; readonly result: TraceResult; readonly ms: number }
  | { readonly id: number; readonly type: "error"; readonly message: string };

const ctx = self as unknown as { onmessage: ((e: MessageEvent<TraceRequest>) => void) | null; postMessage(m: TraceReply): void };

ctx.onmessage = (e) => {
  const { id, width, height, data, rgba, options } = e.data;
  const t0 = performance.now();
  try {
    let last = 0;
    const onProgress = (fraction: number, label: string) => {
      const now = performance.now();
      if (now - last < 80 && fraction < 1) return; // não inunda a tela de mensagens
      last = now;
      ctx.postMessage({ id, type: "progress", fraction, label });
    };
    const result = traceImage({ width, height, data }, options, onProgress, rgba ? { width, height, data: rgba } : undefined);
    ctx.postMessage({ id, type: "done", result, ms: performance.now() - t0 });
  } catch (err) {
    ctx.postMessage({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
