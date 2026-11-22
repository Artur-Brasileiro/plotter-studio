import type { Store } from "../../core/store";
import { toast } from "../dom";

/** Tela de vetorização (imagem → traço). Provisório: a tela de verdade entra na etapa 2. */
export function openTraceDialog(_store: Store, file: File): void {
  toast(`A vetorização de "${file.name}" ainda não está ligada nesta versão.`, "warn");
}
