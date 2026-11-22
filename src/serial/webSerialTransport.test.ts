import { describe, expect, it } from "vitest";
import { LineSplitter } from "../core/grbl/protocol";
import { portLabel, WebSerialTransport } from "./webSerialTransport";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
// setImmediate (Node) quando existe: o setTimeout(0) do Windows demora até 15 ms
const immediate = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
const tick = () => new Promise<void>((r) => void (immediate ? immediate(r) : setTimeout(r, 0)));
async function settle(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}

/**
 * Porta serial falsa com as regras da Web Serial (serial.spec.whatwg.org): open() falha se já está
 * aberta; close() falha se algum stream ainda está travado; um erro de leitura "não fatal" mata só o
 * stream atual e `readable` passa a devolver outro; na desconexão `readable` vira null.
 */
class FakePort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  readonly written: number[] = [];
  opens = 0;
  closes = 0;
  isOpen = false;
  /** atraso (ms) de cada escrita, para conferir a ordem */
  writeDelayMs = 0;
  /** se definido, o close() só termina quando isto resolver (a porta só fica livre depois) */
  closeGate: Promise<void> | undefined;
  private ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;

  getInfo() {
    return { usbVendorId: 0x2341, usbProductId: 0x0043 };
  }

  async open(_options: SerialOptions): Promise<void> {
    if (this.isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
    this.isOpen = true;
    this.opens++;
    this.newReadable();
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
        this.written.push(...chunk);
      },
    });
  }

  private newReadable() {
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => void (this.ctrl = c) });
  }

  async close(): Promise<void> {
    if (this.readable?.locked || this.writable?.locked) throw new TypeError("Cannot close a port with locked streams.");
    await this.closeGate;
    this.isOpen = false;
    this.closes++;
    this.readable = this.writable = null;
  }

  /** O GRBL mandou isto (em pedaços, como a USB entrega). */
  push(...chunks: string[]) {
    for (const c of chunks) this.ctrl?.enqueue(bytes(c));
  }

  /** Ruído na linha: o stream atual morre, a porta continua e entrega outro. */
  glitch(name = "FramingError") {
    const dead = this.ctrl;
    this.newReadable();
    dead?.error(new DOMException("ruído", name));
  }

  /** Cabo puxado: erro fatal, `readable` fica null. */
  unplug() {
    const dead = this.ctrl;
    this.readable = null;
    dead?.error(new DOMException("The device has been lost.", "NetworkError"));
  }
}

async function opened() {
  const port = new FakePort();
  const t = new WebSerialTransport(port as unknown as SerialPort, 115200);
  const chunks: string[] = [];
  const closes: { reason: string; error?: unknown }[] = [];
  const readErrors: unknown[] = [];
  t.onData = (c) => chunks.push(String.fromCharCode(...c));
  t.onClose = (i) => closes.push(i);
  t.onReadError = (e) => readErrors.push(e);
  await t.open();
  return { port, t, chunks, closes, readErrors };
}

describe("WebSerialTransport", () => {
  it("rótulo da porta pelo fabricante USB", () => {
    expect(portLabel({ usbVendorId: 0x2341, usbProductId: 0x0043 })).toBe("Arduino Uno (2341:0043)");
    expect(portLabel({ usbVendorId: 0x1a86, usbProductId: 0x7523 })).toBe("CH340 (1a86:7523)");
    expect(portLabel({})).toBe("Porta serial");
  });

  it("entrega os pedaços na ordem; uma linha partida entre dois pedaços se junta no LineSplitter", async () => {
    const { port, chunks } = await opened();
    port.push("\r\nGrbl 1.1h ['$' for", " help]\r\n[MSG:'$H'|'$X' to unlock]\r\no", "k\r\n<Idle|MPos:0.000,0.0", "00,0.000|FS:0,0>\r\n");
    await settle();
    expect(chunks).toHaveLength(4);
    const splitter = new LineSplitter();
    const lines = chunks.flatMap((c) => splitter.push(bytes(c)));
    expect(lines).toEqual(["Grbl 1.1h ['$' for help]", "[MSG:'$H'|'$X' to unlock]", "ok", "<Idle|MPos:0.000,0.000,0.000|FS:0,0>"]);
  });

  it("escritas saem na ordem em que foram pedidas, mesmo sem esperar uma pela outra", async () => {
    const { port, t } = await opened();
    port.writeDelayMs = 5;
    const all = Promise.all([t.write(bytes("G0 X1\n")), t.write(bytes("!")), t.write(bytes("G0 X2\n")), t.write(Uint8Array.of(0x18))]);
    await all;
    expect(String.fromCharCode(...port.written)).toBe("G0 X1\n!G0 X2\n\x18");
  });

  it.each(["FramingError", "BreakError", "BufferOverrunError", "ParityError", "UnknownError"])(
    "erro de leitura não fatal (%s): a conexão continua, avisa por onReadError e segue lendo e escrevendo",
    async (name) => {
      const { port, t, chunks, closes, readErrors } = await opened();
      port.push("ok\r\n");
      await settle();
      port.glitch(name);
      await settle();
      expect(closes).toEqual([]);
      expect(readErrors).toHaveLength(1);
      expect((readErrors[0] as DOMException).name).toBe(name);
      port.push("ok\r\n");
      await settle();
      expect(chunks).toEqual(["ok\r\n", "ok\r\n"]);
      await t.write(bytes("?"));
      expect(port.written).toEqual([0x3f]);
      expect(port.isOpen).toBe(true);
    },
  );

  it("cabo puxado (NetworkError, readable = null): 'lost' uma vez só, escrita rejeita, a porta é fechada", async () => {
    const { port, t, closes, readErrors } = await opened();
    port.unplug();
    await settle();
    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe("lost");
    expect(readErrors).toEqual([]);
    await expect(t.write(bytes("?"))).rejects.toThrow(/fechada/);
    expect(port.closes).toBe(1);
    await t.close(); // já caiu: não faz nada nem avisa de novo
    expect(closes).toHaveLength(1);
  });

  it("erros de leitura em sequência, sem nenhum byte bom no meio: desiste e dá a porta como perdida", async () => {
    const { port, closes, readErrors } = await opened();
    for (let i = 0; i < 8 && !closes.length; i++) {
      port.glitch();
      await settle();
    }
    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe("lost");
    expect(readErrors).toHaveLength(5);
  });

  it("um erro isolado de vez em quando não acumula: cada byte bom zera a contagem", async () => {
    const { port, closes, readErrors } = await opened();
    for (let i = 0; i < 12; i++) {
      port.glitch();
      await settle();
      port.push("ok\r\n");
      await settle();
    }
    expect(closes).toEqual([]);
    expect(readErrors).toHaveLength(12);
  });

  it("close(): cancela a leitura, solta os locks e só então fecha a porta; avisa 'user'", async () => {
    const { port, t, closes } = await opened();
    port.push("ok\r\n");
    await settle();
    await t.close();
    expect(port.closes).toBe(1); // o FakePort recusaria o close com stream travado
    expect(port.isOpen).toBe(false);
    expect(closes).toEqual([{ reason: "user" }]);
    await expect(t.write(bytes("?"))).rejects.toThrow(/fechada/);
  });

  it("close() espera as escritas pendentes", async () => {
    const { port, t } = await opened();
    port.writeDelayMs = 10;
    void t.write(bytes("G0 X1\n"));
    void t.write(Uint8Array.of(0x18));
    await t.close();
    expect(String.fromCharCode(...port.written)).toBe("G0 X1\n\x18");
  });

  it("reconectar logo depois de a conexão cair espera o fechamento antigo terminar", async () => {
    const { port, closes } = await opened();
    let release = () => {};
    port.closeGate = new Promise<void>((r) => (release = r));
    port.unplug();
    await settle();
    expect(closes).toHaveLength(1);
    expect(port.isOpen).toBe(true); // o close() da porta ainda está em andamento
    const again = new WebSerialTransport(port as unknown as SerialPort, 115200);
    let state = "esperando";
    const opening = again.open().then(
      () => (state = "aberta"),
      (e: Error) => (state = e.message),
    );
    await settle();
    expect(state).toBe("esperando"); // sem a espera daria "A porta já está aberta"
    release();
    await opening;
    expect(state).toBe("aberta");
    expect(port.opens).toBe(2);
    await again.close();
  });

  it("erro ao tratar os bytes (bug nosso, não da porta) não é engolido: a conexão cai com esse erro", async () => {
    const { port, t, closes, readErrors } = await opened();
    t.onData = () => {
      throw new Error("bug no parser");
    };
    port.push("ok\r\n");
    await settle();
    expect(readErrors).toEqual([]);
    expect(closes).toHaveLength(1);
    expect((closes[0].error as Error).message).toBe("bug no parser");
  });

  it("abrir uma porta em uso dá a mensagem amigável", async () => {
    const port = new FakePort();
    port.open = async () => {
      throw new DOMException("Failed to open serial port.", "NetworkError");
    };
    const t = new WebSerialTransport(port as unknown as SerialPort, 115200);
    await expect(t.open()).rejects.toThrow(/em uso por outro programa/);
  });
});
