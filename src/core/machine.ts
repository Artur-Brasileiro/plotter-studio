/**
 * Perfil da máquina: tudo que é específico da CNC Plotter do Artur fica aqui.
 * A UI de Configurações edita estes valores (e salva no localStorage),
 * para que trocar servo, caneta ou velocidades não exija mexer no código.
 *
 * Convenção de coordenadas (igual ao GRBL com G54 gravado):
 *   - origem (0,0) no canto da FRENTE à ESQUERDA da mesa
 *   - X+ para a direita, Y+ para longe do operador
 *   - na tela, Y+ aponta para CIMA (o operador vê o papel de frente)
 */
export interface MachineProfile {
  readonly version: 1;
  /** Área útil em mm (= $130 / $131 do GRBL) */
  workArea: { width: number; height: number };
  pen: {
    /** Comando que ABAIXA a caneta (servo no PWM do spindle) */
    downCmd: string;
    /** Comando que LEVANTA a caneta. M5 = seguro: o GRBL executa M5 em reset/alarme */
    upCmd: string;
    /** Pausa após cada subida/descida, em segundos (G4 P...) */
    settleSeconds: number;
    /** v2: como a pausa levanta a caneta (decidido no teste da T26) */
    pauseLift: "spindleStop" | "endOfStroke";
  };
  feed: {
    /** Velocidade fixa padrão (mm/min). Deslocamentos com a caneta levantada usam G0. */
    fixed: number;
    /** Modo dinâmico: velocidade em trechos retos (mm/min) */
    straight: number;
    /** Modo dinâmico: velocidade em curvas suaves (mm/min) */
    curve: number;
    /** Modo dinâmico: velocidade em curvas fechadas (mm/min) */
    tightCurve: number;
  };
  dynamic: {
    /** Raio a partir do qual o trecho é tratado como reta (mm) */
    straightMinRadiusMm: number;
    /** Raio a partir do qual é curva suave; abaixo, curva fechada (mm) */
    curveMinRadiusMm: number;
    /** Vértice que vira mais que isto é canto: quem freia é o GRBL ($11) */
    cornerAngleDeg: number;
    /** Segmento mais longo que isto é reta, não amostra de curva (mm) */
    maxCurveSegmentMm: number;
    /** A velocidade mais baixa se estende esta distância para cada lado (mm) */
    windowMm: number;
  };
  tolerance: {
    /** Erro máximo ao converter curvas em retas (mm) */
    chordMm: number;
    /** Tolerância do Ramer–Douglas–Peucker (mm) */
    simplifyMm: number;
    /** Segmentos menores que isto são fundidos (mm) */
    minSegmentMm: number;
    /** Pontas mais próximas que isto são unidas sem levantar a caneta (mm) */
    joinGapMm: number;
  };
  motion: {
    /** Velocidade máxima dos eixos ($110/$111), mm/min */
    maxRateMmMin: number;
    /** Aceleração ($120/$121), mm/s² */
    accelMmS2: number;
    /** Junction deviation ($11), mm */
    junctionDeviationMm: number;
    /** Nenhum segmento dura menos que isto (ms), para o buffer do GRBL não esvaziar. 0 = desliga. */
    minSegmentTimeMs: number;
  };
  gcode: {
    /** Para onde a máquina vai ao terminar (mm da máquina) */
    finalPosition: { x: number; y: number };
  };
  serial: { baudRate: number; statusIntervalMs: number; rxBufferBytes: number };
  /** Gabaritos desenhados na madeira da mesa (retângulos de referência, em mm) */
  paperTemplates: { name: string; x: number; y: number; width: number; height: number }[];
}

export const DEFAULT_PROFILE: MachineProfile = {
  version: 1,
  workArea: { width: 810, height: 385 },
  pen: {
    downCmd: "M3 S220",
    upCmd: "M5",
    settleSeconds: 0.3,
    pauseLift: "spindleStop",
  },
  feed: {
    fixed: 1000,
    straight: 2000,
    curve: 1200,
    tightCurve: 600,
  },
  dynamic: {
    straightMinRadiusMm: 100,
    curveMinRadiusMm: 40,
    cornerAngleDeg: 45,
    maxCurveSegmentMm: 10,
    windowMm: 2,
  },
  tolerance: {
    chordMm: 0.05,
    simplifyMm: 0.05,
    minSegmentMm: 0.1,
    joinGapMm: 0.1,
  },
  motion: {
    maxRateMmMin: 12000,
    accelMmS2: 800,
    junctionDeviationMm: 0.01,
    minSegmentTimeMs: 10,
  },
  gcode: { finalPosition: { x: 0, y: 0 } },
  serial: { baudRate: 115200, statusIntervalMs: 200, rxBufferBytes: 128 },
  // ATENÇÃO: posições assumidas a partir da origem, em paisagem.
  // Conferir com o gabarito real da mesa antes de confiar.
  paperTemplates: [
    { name: "A4", x: 0, y: 0, width: 297, height: 210 },
    { name: "A3", x: 0, y: 0, width: 420, height: 297 },
  ],
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Junta recursivamente: mantém do salvo só o que existe no padrão e tem o mesmo tipo. */
function mergeInto(def: unknown, saved: unknown): unknown {
  if (isObj(def)) {
    if (!isObj(saved)) return structuredClone(def);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(def)) out[k] = mergeInto(def[k], saved[k]);
    return out;
  }
  if (Array.isArray(def)) return Array.isArray(saved) ? structuredClone(saved) : structuredClone(def);
  if (typeof def === "number") return typeof saved === "number" && Number.isFinite(saved) ? saved : def;
  if (typeof def === "string") return typeof saved === "string" ? saved : def;
  return def;
}

/** Perfil salvo (possivelmente antigo ou incompleto) + padrão. Chaves desconhecidas são ignoradas. */
export function mergeProfile(saved: unknown): MachineProfile {
  const merged = mergeInto(DEFAULT_PROFILE, saved) as MachineProfile;
  const templates = merged.paperTemplates.filter(
    (t) =>
      isObj(t) &&
      typeof t.name === "string" &&
      [t.x, t.y, t.width, t.height].every((n) => typeof n === "number" && Number.isFinite(n)),
  );
  const pauseLift = merged.pen.pauseLift === "endOfStroke" ? "endOfStroke" : "spindleStop";
  return { ...merged, version: 1, pen: { ...merged.pen, pauseLift }, paperTemplates: templates };
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** Problemas do perfil, em português (lista vazia = tudo certo). */
export function validateProfile(p: MachineProfile): string[] {
  const e: string[] = [];
  const range = (v: number, min: number, max: number, label: string) => {
    if (!(v >= min && v <= max)) e.push(`${label}: ${v} fora do intervalo ${min}–${max}.`);
  };
  range(p.workArea.width, 1, 5000, "Largura da área");
  range(p.workArea.height, 1, 5000, "Altura da área");

  for (const [label, cmd] of [
    ["Comando de abaixar a caneta", p.pen.downCmd],
    ["Comando de levantar a caneta", p.pen.upCmd],
  ] as const) {
    if (!cmd.trim()) e.push(`${label} está vazio.`);
    else if (!ASCII_PRINTABLE.test(cmd)) e.push(`${label} tem caracteres fora de ASCII (o GRBL os interpreta como comandos).`);
    else if (cmd.includes("$")) e.push(`${label} não pode ter "$" (comandos $ mexem na configuração do GRBL).`);
    else if (/[;()]/.test(cmd)) e.push(`${label} não pode ter comentários.`);
  }
  range(p.pen.settleSeconds, 0, 5, "Pausa do servo (s)");

  const max = p.motion.maxRateMmMin;
  range(p.motion.maxRateMmMin, 1, 100000, "Velocidade máxima");
  range(p.feed.fixed, 1, max, "Velocidade fixa");
  range(p.feed.straight, 1, max, "Velocidade em retas");
  range(p.feed.curve, 1, max, "Velocidade em curvas");
  range(p.feed.tightCurve, 1, max, "Velocidade em curvas fechadas");

  const d = p.dynamic;
  range(d.curveMinRadiusMm, 0.01, 10000, "Raio mínimo de curva");
  if (!(d.straightMinRadiusMm > d.curveMinRadiusMm)) e.push("O raio de reta tem que ser maior que o raio de curva.");
  range(d.cornerAngleDeg, 1, 179, "Ângulo de canto");
  range(d.maxCurveSegmentMm, 0.1, 1000, "Segmento máximo de curva");
  range(d.windowMm, 0, 100, "Janela de velocidade");

  const t = p.tolerance;
  range(t.chordMm, 0.001, 1, "Tolerância de curva");
  range(t.simplifyMm, 0, 1, "Tolerância de simplificação");
  range(t.minSegmentMm, 0, 5, "Segmento mínimo");
  range(t.joinGapMm, 0, 5, "Distância de junção");

  range(p.motion.accelMmS2, 1, 100000, "Aceleração");
  range(p.motion.junctionDeviationMm, 0.0001, 1, "Junction deviation");
  range(p.motion.minSegmentTimeMs, 0, 100, "Tempo mínimo de segmento");

  const fp = p.gcode.finalPosition;
  if (!(fp.x >= 0 && fp.x <= p.workArea.width && fp.y >= 0 && fp.y <= p.workArea.height)) {
    e.push("A posição final tem que ficar dentro da área.");
  }
  range(p.serial.baudRate, 300, 2_000_000, "Baud rate");
  range(p.serial.statusIntervalMs, 50, 2000, "Intervalo de status");
  range(p.serial.rxBufferBytes, 16, 1024, "Buffer de recepção");

  for (const tpl of p.paperTemplates) {
    if (!tpl.name.trim()) e.push("Todo gabarito precisa de nome.");
    if (tpl.x < 0 || tpl.y < 0 || tpl.x + tpl.width > p.workArea.width || tpl.y + tpl.height > p.workArea.height) {
      e.push(`O gabarito ${tpl.name} sai da área.`);
    }
  }
  return e;
}
