import type { PlotDocument } from "../core/document";
import { deserializeDocument, serializeDocument, type ProjectFileV1 } from "../core/project";
import type { Store } from "../core/store";
import { kvGet, kvSet } from "./kv";

const SESSION_KEY = "session";

export interface AutosaveOptions {
  /** Onde gravar (padrão: IndexedDB). Injetável nos testes. */
  save?: (data: ProjectFileV1) => Promise<void>;
  delayMs?: number;
  onError?: (e: unknown) => void;
}

/**
 * Salva o documento 1 s depois de cada mudança (debounce) e na hora em que a aba
 * fica oculta (fechar/trocar de aba). Devolve a função que desliga.
 */
export function startAutosave(store: Store, opts: AutosaveOptions = {}): () => void {
  const save = opts.save ?? ((data) => kvSet(SESSION_KEY, data));
  const delay = opts.delayMs ?? 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    pending = false;
    save(serializeDocument(store.doc, new Date())).catch((e) => opts.onError?.(e));
  };
  const unsub = store.subscribe((s, prev) => {
    if (s.history.present === prev.history.present) return;
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delay);
  });
  const onHide = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") flush();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onHide);
  return () => {
    flush();
    unsub();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onHide);
  };
}

/** Lê a sessão salva. Sessão ausente → undefined; corrompida → lança Error (quem chama avisa). */
export async function restoreSession(load: () => Promise<unknown> = () => kvGet(SESSION_KEY)): Promise<PlotDocument | undefined> {
  const data = await load();
  if (data === undefined || data === null) return undefined;
  return deserializeDocument(data);
}
