import { DEFAULT_PROFILE, mergeProfile, validateProfile, type MachineProfile } from "../core/machine";
import { DEFAULT_JOB_SETTINGS, type JobSettings } from "../core/store";

/** O mínimo do localStorage que usamos (injetável nos testes). */
export type KeyValue = Pick<Storage, "getItem" | "setItem">;

const PROFILE_KEY = "plotter-studio:profile";
const JOB_KEY = "plotter-studio:job";
const PROFILE_FILE_FORMAT = "plotter-studio-profile";

const ls = (): KeyValue => localStorage;

/** Perfil salvo + padrão. Se o salvo estiver corrompido ou inválido, volta ao padrão e diz por quê. */
export function loadProfileWithStatus(storage: KeyValue = ls()): { profile: MachineProfile; problem?: string } {
  let raw: string | null;
  try {
    raw = storage.getItem(PROFILE_KEY);
  } catch {
    return { profile: mergeProfile(undefined), problem: "Não consegui ler o perfil salvo (armazenamento bloqueado)." };
  }
  if (raw === null) return { profile: mergeProfile(undefined) };
  try {
    const data = JSON.parse(raw) as { version?: number; profile?: unknown };
    const profile = mergeProfile(data?.profile);
    const errors = validateProfile(profile);
    if (errors.length) return { profile: mergeProfile(undefined), problem: `Perfil salvo inválido (${errors[0]}). Usei o padrão.` };
    return { profile };
  } catch {
    return { profile: mergeProfile(undefined), problem: "Perfil salvo corrompido. Usei o padrão." };
  }
}

export function loadProfile(storage: KeyValue = ls()): MachineProfile {
  return loadProfileWithStatus(storage).profile;
}

export function saveProfile(p: MachineProfile, storage: KeyValue = ls()): void {
  storage.setItem(PROFILE_KEY, JSON.stringify({ version: 1, profile: p }));
}

export function exportProfileJson(p: MachineProfile): string {
  return JSON.stringify({ format: PROFILE_FILE_FORMAT, version: 1, profile: p }, null, 2);
}

/** Aceita o arquivo exportado (com "format") ou o perfil puro. Lança Error com mensagem em português. */
export function importProfileJson(text: string): MachineProfile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("O arquivo não é um JSON válido.");
  }
  const obj = data as { format?: string; profile?: unknown };
  const raw = obj && typeof obj === "object" && "profile" in obj ? obj.profile : data;
  if (!raw || typeof raw !== "object") throw new Error("O arquivo não tem um perfil de máquina.");
  const profile = mergeProfile(raw);
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(`Perfil inválido: ${errors.join(" ")}`);
  return profile;
}

export function loadJobSettings(storage: KeyValue = ls()): JobSettings {
  try {
    const raw = storage.getItem(JOB_KEY);
    if (!raw) return DEFAULT_JOB_SETTINGS;
    const d = JSON.parse(raw) as Partial<JobSettings>;
    return {
      speedMode: d.speedMode === "fixed" ? "fixed" : "dynamic",
      fixedFeed: typeof d.fixedFeed === "number" && d.fixedFeed > 0 ? d.fixedFeed : DEFAULT_JOB_SETTINGS.fixedFeed,
      optimize: typeof d.optimize === "boolean" ? d.optimize : DEFAULT_JOB_SETTINGS.optimize,
    };
  } catch {
    return DEFAULT_JOB_SETTINGS;
  }
}

export function saveJobSettings(j: JobSettings, storage: KeyValue = ls()): void {
  try {
    storage.setItem(JOB_KEY, JSON.stringify(j));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

export { DEFAULT_PROFILE };
