import { afterEach, describe, expect, it, vi } from "vitest";
import { addDrawing, createDrawing } from "../core/document";
import { IDENTITY } from "../core/geometry/mat2d";
import { DEFAULT_PROFILE, mergeProfile } from "../core/machine";
import type { ProjectFileV1 } from "../core/project";
import { DEFAULT_JOB_SETTINGS, Store } from "../core/store";
import {
  exportProfileJson,
  importProfileJson,
  loadJobSettings,
  loadProfileWithStatus,
  saveJobSettings,
  saveProfile,
  type KeyValue,
} from "./profileStore";
import { restoreSession, startAutosave } from "./sessionStore";

const memory = (init: Record<string, string> = {}): KeyValue & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe("profileStore", () => {
  it("sem nada salvo → padrão, sem problema", () => {
    expect(loadProfileWithStatus(memory())).toEqual({ profile: DEFAULT_PROFILE });
  });

  it("salvar e carregar de volta", () => {
    const st = memory();
    const p = mergeProfile(undefined);
    p.feed.curve = 900;
    saveProfile(p, st);
    expect(loadProfileWithStatus(st).profile.feed.curve).toBe(900);
  });

  it("perfil guardado no navegador antes da correção do curso (Y 385): abre com 390, sem aviso e sem perder as canetas", () => {
    const old = { ...structuredClone(DEFAULT_PROFILE), version: 2, workArea: { width: 810, height: 385 } };
    old.pens.push({ id: "branca", name: "Branca", widthMm: 0.5, color: "#ffffff", offsetX: 0, offsetY: 0 });
    const st = memory({ "plotter-studio:profile": JSON.stringify({ version: 1, profile: old }) });
    const r = loadProfileWithStatus(st);
    expect(r.problem).toBeUndefined();
    expect(r.profile.workArea).toEqual({ width: 810, height: 390 });
    expect(r.profile.pens.map((p) => p.name)).toContain("Branca");
    // gravado de novo e reaberto, continua 390 (a correção não desfaz nem repete nada)
    saveProfile(r.profile, st);
    expect(loadProfileWithStatus(st).profile.workArea.height).toBe(390);
  });

  it("perfil corrompido volta ao padrão com aviso", () => {
    const r = loadProfileWithStatus(memory({ "plotter-studio:profile": "{quebrado" }));
    expect(r.profile).toEqual(DEFAULT_PROFILE);
    expect(r.problem).toContain("corrompido");
  });

  it("perfil inválido (velocidade acima do máximo) volta ao padrão com aviso", () => {
    const p = mergeProfile(undefined);
    p.feed.straight = 99999;
    const r = loadProfileWithStatus(memory({ "plotter-studio:profile": JSON.stringify({ version: 1, profile: p }) }));
    expect(r.profile).toEqual(DEFAULT_PROFILE);
    expect(r.problem).toContain("inválido");
  });

  it("exportar e importar JSON dá o mesmo perfil", () => {
    const p = mergeProfile(undefined);
    p.pen.settleSeconds = 0.4;
    expect(importProfileJson(exportProfileJson(p))).toEqual(p);
  });

  it("importar JSON ruim lança erro em português", () => {
    expect(() => importProfileJson("nada")).toThrow("JSON válido");
    expect(() => importProfileJson(JSON.stringify({ profile: { pen: { downCmd: "$32=1" } } }))).toThrow("Perfil inválido");
  });

  it("configurações do trabalho: ida e volta e valores ruins", () => {
    const st = memory();
    saveJobSettings({ speedMode: "fixed", fixedFeed: 1500, optimize: false }, st);
    expect(loadJobSettings(st)).toEqual({ speedMode: "fixed", fixedFeed: 1500, optimize: false });
    expect(loadJobSettings(memory({ "plotter-studio:job": '{"fixedFeed":-1}' }))).toEqual(DEFAULT_JOB_SETTINGS);
  });
});

describe("sessionStore", () => {
  afterEach(() => vi.useRealTimers());

  const geom = { subpaths: [{ start: { x: 0, y: 0 }, segments: [{ kind: "line" as const, to: { x: 5, y: 0 } }], closed: false }] };

  it("autosave com debounce de 1 s: várias mudanças seguidas = uma gravação", async () => {
    vi.useFakeTimers();
    const saved: ProjectFileV1[] = [];
    const store = new Store();
    const stop = startAutosave(store, { save: async (d) => void saved.push(d) });
    store.commit("A", (doc) => addDrawing(doc, createDrawing("a", "a", geom, IDENTITY)));
    vi.advanceTimersByTime(500);
    store.commit("B", (doc) => addDrawing(doc, createDrawing("b", "b", geom, IDENTITY)));
    vi.advanceTimersByTime(999);
    expect(saved).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].drawings.map((d) => d.id)).toEqual(["a", "b"]);
    stop();
  });

  it("mudar só a seleção não grava; desligar grava o que estiver pendente", async () => {
    vi.useFakeTimers();
    const saved: ProjectFileV1[] = [];
    const store = new Store();
    const stop = startAutosave(store, { save: async (d) => void saved.push(d) });
    store.setSelection(["x"]);
    vi.advanceTimersByTime(2000);
    expect(saved).toHaveLength(0);
    store.commit("A", (doc) => addDrawing(doc, createDrawing("a", "a", geom, IDENTITY)));
    stop();
    expect(saved).toHaveLength(1);
  });

  it("restoreSession: ausente → undefined; válida → documento; corrompida → erro", async () => {
    expect(await restoreSession(async () => undefined)).toBeUndefined();
    const store = new Store();
    let data: unknown;
    const stop = startAutosave(store, { save: async (d) => void (data = JSON.parse(JSON.stringify(d))) });
    store.commit("A", (doc) => addDrawing(doc, createDrawing("a", "nome", geom, [1, 0, 0, 1, 3, 4])));
    stop();
    const doc = await restoreSession(async () => data);
    expect(doc?.drawings[0].transform).toEqual([1, 0, 0, 1, 3, 4]);
    await expect(restoreSession(async () => ({ format: "x" }))).rejects.toThrow("Projeto inválido");
  });
});
