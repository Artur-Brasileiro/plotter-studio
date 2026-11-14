/** Maior linha que aceitamos mandar (o GRBL aceita 80; folga para não chegar perto). */
export const MAX_LINE_CHARS = 70;

/**
 * Prepara uma linha para o GRBL: tira comentários (";" e parênteses) e espaços nas pontas, porque
 * comentários também ocupam o buffer de 128 bytes. null = linha vazia (não envia).
 * Lança se sobrar byte fora de ASCII (o GRBL os trata como comandos em tempo real) ou mais de 70 caracteres.
 * `keepComments` (console manual): só confere, sem mexer no texto.
 */
export function prepareLine(raw: string, opts: { keepComments?: boolean } = {}): string | null {
  let s = raw.replace(/\t/g, " ");
  if (!opts.keepComments) s = s.replace(/\([^)]*\)/g, "").replace(/;.*$/, "");
  s = s.trim();
  if (!s) return null;
  if (/[^\x20-\x7e]/.test(s)) throw new Error(`Linha com caractere fora de ASCII (o GRBL o trataria como comando em tempo real): "${s}"`);
  if (s.length > MAX_LINE_CHARS) throw new Error(`Linha com ${s.length} caracteres (máximo ${MAX_LINE_CHARS}): "${s.slice(0, 40)}..."`);
  return s;
}

export interface StreamLine {
  readonly text: string;
  readonly id: number;
}

/**
 * Contagem de caracteres (GRBL.md): uma "caixa d'água" de 127 bytes. Só despeja a próxima linha
 * (texto + "\n") se ela couber junto com as que ainda não receberam ok/error.
 */
export class CharCountingStreamer {
  private readonly limit: number;
  private queue: (StreamLine & { bytes: number })[] = [];
  private qHead = 0;
  private pending: { id: number; bytes: number }[] = [];
  private pHead = 0;
  private bytesInFlight = 0;

  constructor(opts: { rxBufferBytes: number }) {
    this.limit = opts.rxBufferBytes - 1;
  }

  enqueue(lines: readonly StreamLine[]): void {
    for (const l of lines) {
      const bytes = l.text.length + 1;
      if (bytes > this.limit) throw new Error(`Linha maior que o buffer do GRBL: "${l.text.slice(0, 40)}"`);
      this.queue.push({ ...l, bytes });
    }
  }

  /** Linhas que cabem agora (só as com id ≤ maxId). Marca como pendentes. */
  takeSendable(maxId = Infinity): StreamLine[] {
    const out: StreamLine[] = [];
    while (this.qHead < this.queue.length) {
      const l = this.queue[this.qHead];
      if (l.id > maxId || this.bytesInFlight + l.bytes > this.limit) break;
      this.qHead++;
      this.bytesInFlight += l.bytes;
      this.pending.push({ id: l.id, bytes: l.bytes });
      out.push({ text: l.text, id: l.id });
    }
    if (this.qHead > 4096 && this.qHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.qHead);
      this.qHead = 0;
    }
    return out;
  }

  /** A cada ok/error: libera a linha pendente mais antiga e devolve qual era. */
  acknowledge(): { id: number } | undefined {
    if (this.pHead >= this.pending.length) return undefined;
    const p = this.pending[this.pHead++];
    this.bytesInFlight -= p.bytes;
    if (this.pHead > 1024 && this.pHead * 2 > this.pending.length) {
      this.pending = this.pending.slice(this.pHead);
      this.pHead = 0;
    }
    return { id: p.id };
  }

  /** Id da próxima linha a enviar (undefined = fila vazia). */
  get nextQueuedId(): number | undefined {
    return this.queue[this.qHead]?.id;
  }

  get pendingBytes(): number {
    return this.bytesInFlight;
  }
  get pendingCount(): number {
    return this.pending.length - this.pHead;
  }
  get queuedCount(): number {
    return this.queue.length - this.qHead;
  }

  /** Esvazia só a fila de espera (o que já foi enviado continua esperando ok). */
  clearQueued(): void {
    this.queue = [];
    this.qHead = 0;
  }

  /** Depois de um reset: o GRBL descartou tudo. */
  clear(): void {
    this.clearQueued();
    this.pending = [];
    this.pHead = 0;
    this.bytesInFlight = 0;
  }
}
