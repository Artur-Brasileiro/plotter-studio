/** Preferências da interface (localStorage "plotter-studio:ui"): passo e velocidade do jog, console. */
export interface UiPrefs {
  jogStep: number | "continuous";
  jogFeed: number;
  consoleOpen: boolean;
  consoleShowStatus: boolean;
}

const KEY = "plotter-studio:ui";
export const JOG_STEPS: readonly (number | "continuous")[] = [0.1, 1, 10, 50, "continuous"];
const DEFAULTS: UiPrefs = { jogStep: 10, jogFeed: 3000, consoleOpen: false, consoleShowStatus: false };

export function loadUiPrefs(): UiPrefs {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<UiPrefs>;
    return {
      jogStep: JOG_STEPS.includes(d.jogStep as number) ? (d.jogStep as UiPrefs["jogStep"]) : DEFAULTS.jogStep,
      jogFeed: typeof d.jogFeed === "number" && d.jogFeed > 0 ? d.jogFeed : DEFAULTS.jogFeed,
      consoleOpen: typeof d.consoleOpen === "boolean" ? d.consoleOpen : DEFAULTS.consoleOpen,
      consoleShowStatus: typeof d.consoleShowStatus === "boolean" ? d.consoleShowStatus : DEFAULTS.consoleShowStatus,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveUiPrefs(p: Partial<UiPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadUiPrefs(), ...p }));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}
