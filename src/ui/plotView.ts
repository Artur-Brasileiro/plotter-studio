import { describeError } from "../core/grbl/codes";
import { isJobActive, type JobProgress, type JobState } from "../core/grbl/controller";
import { fmtDuration } from "./planner";

/**
 * O que a tela de plotagem mostra, calculado a partir do estado do trabalho. Aqui não entra tela nenhuma:
 * são só as contas e os textos (quem desenha é o `plotScreen.ts`; quem junta os dados é o `sendPanel.ts`).
 */

/** Tempo real de máquina do trabalho (s): do início até agora, ou até o fim, sem contar as pausas. */
export function jobElapsedS(j: JobProgress, now: number): number {
  if (j.startedAt === undefined) return 0;
  const pausedNow = j.pausedAt !== undefined && j.endedAt === undefined ? now - j.pausedAt : 0;
  return Math.max(0, ((j.endedAt ?? now) - j.startedAt - j.pausedMs - pausedNow) / 1000);
}

/**
 * Quanto do trabalho já foi, de 0 a 1. `estAtS` é o tempo estimado do ponto onde a caneta está e `estTotalS`
 * o do envio inteiro; sem estimativa, vale a contagem de linhas confirmadas pela placa.
 */
export function jobFraction(j: JobProgress, estAtS: number, estTotalS: number): number {
  if (j.state === "finished") return 1;
  const f = estTotalS > 0 ? estAtS / estTotalS : j.acked / Math.max(1, j.total);
  return Math.min(1, Math.max(0, f));
}

/**
 * Quanto falta (s). O estimado é corrigido pelo ritmo real: se até aqui a máquina levou 25% a mais que o
 * previsto, o resto também vai levar. Nos primeiros segundos ainda não há ritmo para medir.
 */
export function jobRemainingS(estAtS: number, estTotalS: number, elapsedS: number): number {
  const ratio = estAtS > 5 && elapsedS > 5 ? elapsedS / estAtS : 1;
  return Math.max(0, estTotalS - estAtS) * ratio;
}

export type PlotPhase = Exclude<JobState, "none">;
/** A "cor" do momento: andando, esperando (pausa, parando), concluído, parado por quem usa, ou falhou. */
export type PlotTone = "run" | "hold" | "done" | "stopped" | "failed";

export interface PlotInput {
  readonly job: JobProgress;
  /** Nome do que está sendo desenhado */
  readonly name: string;
  /** Tempo estimado deste envio inteiro (s), e o do ponto onde a caneta está (s) */
  readonly estTotalS: number;
  readonly estAtS: number;
  /** A placa informa a caneta embaixo */
  readonly penDown: boolean;
  /** Velocidade que a placa informa (100 = normal) */
  readonly feedPct: number;
  /** Como a pausa levanta a caneta (do perfil): só muda a dica do botão */
  readonly pauseLift: "spindleStop" | "endOfStroke";
  /** Trabalho com mais de uma caneta: qual camada é esta */
  readonly layer?: { readonly index: number; readonly count: number; readonly penName: string };
  /** Terminou esta camada e há outra na fila */
  readonly next?: { readonly index: number; readonly penName: string };
  /** Terminou a última camada */
  readonly allLayersDone?: boolean;
  /** Parou no meio e ficou guardado de onde retomar */
  readonly canResume?: boolean;
}

export interface PlotView {
  readonly phase: PlotPhase;
  /** A máquina ainda está com o trabalho (desenhando, pausada ou parando) */
  readonly active: boolean;
  readonly tone: PlotTone;
  readonly title: string;
  readonly name: string;
  /** "Camada 1 de 2 · Verde 0,4" */
  readonly detail?: string;
  readonly frac: number;
  readonly percent: string;
  readonly elapsed: string;
  /** Só enquanto o trabalho está na máquina */
  readonly remaining?: string;
  readonly estimated: string;
  readonly lines: string;
  /** Aviso do momento (pausa) */
  readonly note?: string;
  /** Erro numa linha: a placa pulou a linha e o programa pausou para perguntar */
  readonly error?: { readonly title: string; readonly text: string; readonly action: string; readonly canContinue: boolean };
  readonly feedPct: number;
  readonly pause: { readonly label: string; readonly title: string; readonly disabled: boolean; readonly hidden: boolean };
  readonly stopDisabled: boolean;
  /** Depois de terminar uma camada: o que vem agora */
  readonly next?: string;
  /** Por que parou ou falhou, nas palavras do controlador */
  readonly message?: string;
  /** Parou no meio: como continuar */
  readonly resume?: string;
}

const TITLE: Record<PlotPhase, string> = {
  running: "Desenhando",
  pausing: "Pausando…",
  paused: "Pausado",
  resuming: "Continuando…",
  stopping: "Parando…",
  finished: "Desenho concluído",
  stopped: "Desenho parado",
  failed: "O desenho falhou",
};

const TONE: Record<PlotPhase, PlotTone> = {
  running: "run",
  pausing: "hold",
  paused: "hold",
  resuming: "hold",
  stopping: "hold",
  finished: "done",
  stopped: "stopped",
  failed: "failed",
};

function pauseNote(j: JobProgress, penDown: boolean): string | undefined {
  if (j.state === "pausing") return j.pauseMode === "endOfStroke" ? "Terminando o traço atual antes de parar…" : "Parando o movimento…";
  if (j.state !== "paused") return undefined;
  if (j.pauseMode === "endOfStroke") return "Pausado no fim do traço, com a caneta em cima. Dá para trocar a caneta ou ajeitar o papel.";
  if (j.penLifted && penDown)
    return "Pausado, mas a máquina diz que a caneta continua embaixo: esta placa não levanta a caneta na pausa. Em Configurações → Subir e descer a caneta, mude “Pausa” para “no fim do traço”.";
  if (j.penLifted) return "Pausado com a caneta levantada. Ao continuar, ela desce, espera o servo e só então anda.";
  return "Pausado. Atenção: a caneta ficou no papel.";
}

export function plotView(inp: PlotInput, now: number): PlotView {
  const j = inp.job;
  const phase = j.state as PlotPhase;
  const active = isJobActive(j.state);
  const elapsedS = jobElapsedS(j, now);
  const frac = jobFraction(j, inp.estAtS, inp.estTotalS);
  const layer = inp.layer && inp.layer.count > 1 ? inp.layer : undefined;
  const err = active ? j.error : undefined;

  let next: string | undefined;
  if (phase === "finished" && layer) {
    if (inp.next)
      next =
        `Agora a camada ${inp.next.index + 1}: ${inp.next.penName}. Troque a caneta sem mexer no papel e envie. ` +
        "A primeira coisa que ela desenha é a cruz de registro: se não cair em cima da cruz da camada anterior, pare e ajuste o desvio dessa caneta em Configurações → Estojo de canetas.";
    else if (inp.allLayersDone) next = "Todas as camadas foram plotadas.";
  }

  return {
    phase,
    active,
    tone: TONE[phase],
    title: phase === "finished" && layer ? `Camada ${layer.index + 1} concluída` : TITLE[phase],
    name: inp.name,
    detail: layer ? `Camada ${layer.index + 1} de ${layer.count} · ${layer.penName}` : undefined,
    frac,
    percent: `${Math.round(frac * 100)}%`,
    elapsed: fmtDuration(elapsedS),
    remaining: active ? fmtDuration(jobRemainingS(inp.estAtS, inp.estTotalS, elapsedS)) : undefined,
    estimated: fmtDuration(inp.estTotalS),
    lines: `linha ${j.acked.toLocaleString("pt-BR")} de ${j.total.toLocaleString("pt-BR")}`,
    note: pauseNote(j, inp.penDown),
    error: err
      ? {
          title: `Erro na linha ${err.line + 1}: error:${err.code} — ${describeError(err.code).title}`,
          text: err.text,
          action: describeError(err.code).action,
          canContinue: phase === "paused",
        }
      : undefined,
    feedPct: inp.feedPct,
    pause: {
      label: phase === "paused" ? "▶ Continuar" : phase === "pausing" ? "Pausando…" : phase === "resuming" ? "Descendo a caneta…" : "⏸ Pausar",
      title:
        inp.pauseLift === "spindleStop"
          ? "Para na hora e levanta a caneta. Ao continuar, a caneta desce antes de andar."
          : "Termina o traço atual, levanta a caneta e para.",
      disabled: phase === "pausing" || phase === "resuming",
      hidden: !active || phase === "stopping",
    },
    stopDisabled: phase === "stopping",
    next,
    message: !active && phase !== "finished" ? j.message : undefined,
    resume:
      (phase === "stopped" || phase === "failed") && inp.canResume
        ? "Dá para continuar de onde parou: no passo 3, “O que enviar” já vem em “Retomar de onde parou”. Não mexa no papel."
        : undefined,
  };
}
