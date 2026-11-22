/**
 * As regras de como o mouse redimensiona e gira um desenho na mesa. Aqui não entra o Fabric: são só as
 * decisões (quem aplica nas alças é o `canvasView.ts`; quem mostra a caixinha e o campo é o painel).
 *
 * - **Proporção travada** (como o programa abre): arrastar um canto aumenta ou diminui o desenho por igual.
 *   As alças do meio de cada lado, que esticam numa direção só, somem. Destravando ("Travar proporção"
 *   desmarcado) elas voltam, e aí o Shift mantém a proporção enquanto estiver apertado.
 * - **Giro com encaixe**: perto de um ângulo redondo (0, 45, 90...) o desenho gruda nele. O ângulo exato
 *   de qualquer outro valor se digita no painel.
 */

/** Ao girar com o mouse, o desenho gruda nos múltiplos de `step` quando chega a menos de `within` graus. */
export const ROTATE_SNAP = { step: 45, within: 4 } as const;

/** Rotação "reta" (0/90/180/270)? Só aí largura e altura podem mudar separadas sem deformar o desenho. */
export function isRightAngle(deg: number): boolean {
  const r = ((deg % 90) + 90) % 90;
  return r < 1e-6 || 90 - r < 1e-6;
}

/**
 * A proporção está travada para o que está selecionado?
 * `userLock` é a caixinha "Travar proporção"; `rotationDeg` é o giro do desenho (quando é um só);
 * `items` é quantos desenhos estão selecionados. Vários juntos, ou um girado em ângulo não reto, ficam
 * sempre travados: esticar ali entortaria o traço.
 */
export function proportionLocked(userLock: boolean, rotationDeg: number | undefined, items: number): boolean {
  if (items > 1) return true;
  if (rotationDeg !== undefined && !isRightAngle(rotationDeg)) return true;
  return userLock;
}

export interface HandlePolicy {
  /** As alças dos cantos mantêm a proporção */
  readonly uniform: boolean;
  /** As alças do meio de cada lado (as que esticam numa direção só) aparecem */
  readonly sideHandles: boolean;
  /** Tecla que inverte `uniform` durante o arraste. Travado não tem tecla: travado é travado. */
  readonly toggleKey: "shiftKey" | undefined;
}

export function handlePolicy(locked: boolean): HandlePolicy {
  return locked ? { uniform: true, sideHandles: false, toggleKey: undefined } : { uniform: false, sideHandles: true, toggleKey: "shiftKey" };
}

// ---------------------------------------------------------------- a caixinha "Travar proporção"
// Não fica guardada entre uma abertura e outra do programa: ele sempre abre travado, para ninguém
// deformar um desenho por ter esquecido a trava solta da última vez.
let locked = true;
const lockListeners = new Set<() => void>();

export function ratioLocked(): boolean {
  return locked;
}

export function setRatioLocked(v: boolean): void {
  if (v === locked) return;
  locked = v;
  for (const l of [...lockListeners]) l();
}

/** Avisa quando a trava muda. Devolve a função que desliga o aviso. */
export function onRatioLockChange(l: () => void): () => void {
  lockListeners.add(l);
  return () => lockListeners.delete(l);
}

/**
 * O ângulo de uma seleção do Fabric (horário na tela, porque o Y da tela cresce para baixo) como o painel
 * mostra: anti-horário positivo, de −180 (fora) a 180 (dentro).
 */
export function shownTurn(fabricAngleDeg: number): number {
  const d = (((-fabricAngleDeg + 180) % 360) + 360) % 360;
  const r = Math.round((d - 180) * 1e9) / 1e9;
  return r === -180 ? 180 : r === 0 ? 0 : r;
}

// ---------------------------------------------------------------- o ângulo ao vivo, enquanto se gira
/** O giro em andamento: o ângulo (anti-horário, como no painel) e onde está o mouse na janela. */
export interface Turning {
  readonly deg: number;
  readonly clientX: number;
  readonly clientY: number;
}

let turning: Turning | undefined;
const turnListeners = new Set<(t: Turning | undefined) => void>();

/** O `canvasView` chama a cada quadro do giro, e com `undefined` quando o giro termina. */
export function publishTurning(t: Turning | undefined): void {
  if (t === undefined && turning === undefined) return;
  turning = t;
  for (const l of [...turnListeners]) l(t);
}

/** Para quem mostra o ângulo na tela (a etiqueta ao lado do mouse e o campo do painel). */
export function onTurning(l: (t: Turning | undefined) => void): () => void {
  turnListeners.add(l);
  return () => turnListeners.delete(l);
}
