/**
 * O "cabo": a porta Web Serial de verdade (src/serial/webSerialTransport.ts) ou o simulador (FakeGrbl).
 * O controlador só conhece esta interface.
 */
export interface Transport {
  /** "Arduino Uno (2341:0043)" ou "Simulador" */
  readonly label: string;
  open(): Promise<void>;
  /** Escritas em ordem; rejeita se a porta caiu. */
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  onData: ((chunk: Uint8Array) => void) | null;
  /** "user" = fechada por nós; "lost" = cabo desconectado ou placa sumiu */
  onClose: ((info: { reason: "user" | "lost"; error?: unknown }) => void) | null;
  /**
   * Erro de leitura que NÃO derruba a porta (ruído na linha: FramingError, BreakError, BufferOverrunError...).
   * Alguns bytes do GRBL podem ter se perdido. Opcional: o simulador não usa.
   */
  onReadError?: ((error: unknown) => void) | null;
}
