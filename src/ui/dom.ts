/**
 * Helper mínimo para montar HTML sem framework:
 *   h("button", { class: "btn", onclick: () => ... }, "Importar")
 * Chaves "on..." com função viram addEventListener; "class" vira className;
 * propriedades que existem no elemento são atribuídas direto; o resto vira atributo.
 */
type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "string") el.setAttribute("style", v);
    else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Número em mm no formato brasileiro ("12,5"). */
export function fmtMm(v: number, digits = 1): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Mensagem rápida no canto da tela (some sozinha). */
export function toast(text: string, kind: "info" | "warn" | "error" = "info", ms = 5000): void {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts", class: "toasts" });
    document.body.appendChild(host);
  }
  const t = h("div", { class: `toast toast-${kind}`, role: "status" }, text);
  host.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
