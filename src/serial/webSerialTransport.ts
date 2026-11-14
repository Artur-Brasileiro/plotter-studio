import type { Transport } from "../core/grbl/transport";

const KNOWN: Record<string, string> = {
  "2341:0043": "Arduino Uno",
  "2341:0001": "Arduino Uno",
  "2a03:0043": "Arduino Uno",
  "1a86:7523": "CH340",
  "0403:6001": "FTDI",
  "10c4:ea60": "CP210x",
};

const hex4 = (n?: number) => (n ?? 0).toString(16).padStart(4, "0");

/** "Arduino Uno (2341:0043)". A Web Serial não mostra "COM6", só o fabricante/produto USB. */
export function portLabel(info: SerialPortInfo): string {
  if (info.usbVendorId === undefined) return "Porta serial";
  const id = `${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`;
  return `${KNOWN[id] ?? "USB"} (${id})`;
}

export function serialSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serial && window.isSecureContext;
}

function friendlyOpenError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "NetworkError" || /failed to open/i.test(msg)) {
    return "A porta está em uso por outro programa (LaserGRBL? Monitor serial do Arduino? Outra aba do Plotter Studio?). Feche-o e tente de novo.";
  }
  if (name === "InvalidStateError") return "A porta já está aberta (outra aba do Plotter Studio?).";
  return `Não consegui abrir a porta: ${msg}`;
}

/**
 * Transporte pela Web Serial API (Chrome/Edge). Um único writer com as escritas encadeadas em ordem,
 * um laço de leitura, e "lost" quando o cabo sai (evento disconnect ou read() rejeitando).
 */
export class WebSerialTransport implements Transport {
  onData: ((chunk: Uint8Array) => void) | null = null;
  onClose: ((info: { reason: "user" | "lost"; error?: unknown }) => void) | null = null;
  readonly label: string;

  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private readDone: Promise<void> = Promise.resolve();
  private isOpen = false;
  private closing = false;

  private readonly onDisconnect = (e: Event) => {
    if (e.target === this.port) this.lost(new Error("O dispositivo USB foi desconectado."));
  };

  constructor(
    readonly port: SerialPort,
    private readonly baudRate: number,
  ) {
    this.label = portLabel(port.getInfo());
  }

  async open(): Promise<void> {
    try {
      await this.port.open({ baudRate: this.baudRate, bufferSize: 4096 });
    } catch (e) {
      throw new Error(friendlyOpenError(e));
    }
    this.isOpen = true;
    this.closing = false;
    navigator.serial?.addEventListener("disconnect", this.onDisconnect);
    this.writer = this.port.writable?.getWriter();
    this.readDone = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const readable = this.port.readable;
    if (!readable) return;
    const reader = readable.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) this.onData?.(value);
      }
    } catch (e) {
      if (!this.closing) this.lost(e);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* já liberado */
      }
      this.reader = undefined;
    }
    if (!this.closing && this.isOpen) this.lost(new Error("A leitura da porta terminou."));
  }

  write(bytes: Uint8Array): Promise<void> {
    const p = this.writeChain.then(() => {
      if (!this.writer || !this.isOpen) throw new Error("A porta está fechada.");
      return this.writer.write(bytes);
    });
    this.writeChain = p.catch(() => {});
    return p;
  }

  /** Ordem que a Web Serial exige: cancelar a leitura, soltar os locks, fechar a porta. */
  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.closing = true;
    navigator.serial?.removeEventListener("disconnect", this.onDisconnect);
    try {
      await this.reader?.cancel();
    } catch {
      /* já cancelado */
    }
    await this.readDone;
    await this.writeChain;
    try {
      this.writer?.releaseLock();
    } catch {
      /* já liberado */
    }
    this.writer = undefined;
    try {
      await this.port.close();
    } catch {
      /* a porta pode já ter sumido */
    }
    this.isOpen = false;
    this.onClose?.({ reason: "user" });
  }

  private lost(error: unknown): void {
    if (!this.isOpen || this.closing) return;
    this.closing = true;
    this.isOpen = false;
    navigator.serial?.removeEventListener("disconnect", this.onDisconnect);
    void this.reader?.cancel().catch(() => {});
    try {
      this.writer?.releaseLock();
    } catch {
      /* ok */
    }
    this.writer = undefined;
    void this.readDone.then(() => this.port.close()).catch(() => {});
    this.onClose?.({ reason: "lost", error });
  }
}

const PORT_KEY = "plotter-studio:port";

export function rememberPort(port: SerialPort): void {
  const i = port.getInfo();
  try {
    localStorage.setItem(PORT_KEY, JSON.stringify({ usbVendorId: i.usbVendorId, usbProductId: i.usbProductId }));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

/** A porta usada da última vez, se o Chrome ainda tiver a permissão (getPorts). */
export async function findRememberedPort(): Promise<SerialPort | undefined> {
  if (!serialSupported()) return undefined;
  let saved: SerialPortInfo | undefined;
  try {
    saved = JSON.parse(localStorage.getItem(PORT_KEY) ?? "null") ?? undefined;
  } catch {
    saved = undefined;
  }
  if (!saved) return undefined;
  const ports = await navigator.serial!.getPorts();
  return ports.find((p) => {
    const i = p.getInfo();
    return i.usbVendorId === saved.usbVendorId && i.usbProductId === saved.usbProductId;
  });
}
