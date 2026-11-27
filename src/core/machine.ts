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
/** Uma caneta do estojo. A ordem da lista em `MachineProfile.pens` é a ordem de plotagem das camadas. */
export interface Pen {
  /** Identificador estável (os desenhos guardam este id) */
  id: string;
  name: string;
  /** Largura do traço (mm): decide o que dá para emendar sem aparecer */
  widthMm: number;
  /** Cor na tela */
  color: string;
  /**
   * Quanto a PONTA desta caneta fica deslocada no suporte em relação à caneta de referência (mm).
   * A camada inteira é desenhada com a correção contrária (REGRAS_GCODE.md, seção 7).
   */
  offsetX: number;
  offsetY: number;
}

export interface MachineProfile {
  /** 3 = curso em Y corrigido para 390 mm; 4 = gabaritos de papel na origem (ver `mergeProfile`) */
  readonly version: 4;
  /** Curso da máquina em mm (= $130 / $131 do GRBL). Limite duro: fora dele o GRBL dá ALARM:2. */
  workArea: { width: number; height: number };
  /**
   * Zona de desenho (onde fica o papel), em mm da máquina. Nenhum traço pode sair dela
   * (docs/REGRAS_GCODE.md). O aquecimento do servo e as cruzes de registro são exceções.
   */
  drawZone: { minX: number; minY: number; maxX: number; maxY: number };
  pen: {
    /** Comando que ABAIXA a caneta (servo no PWM do spindle) */
    downCmd: string;
    /** Comando que LEVANTA a caneta. M5 = seguro: o GRBL executa M5 em reset/alarme */
    upCmd: string;
    /** Pausa depois de DESCER, em segundos (G4 P... após o M3) */
    settleSeconds: number;
    /** Pausa depois de SUBIR, em segundos (G4 P... após o M5) */
    settleUpSeconds: number;
    /** Largura do traço da caneta (mm): decide o que dá para emendar sem aparecer */
    widthMm: number;
    /** v2: como a pausa levanta a caneta (decidido no teste da T26) */
    pauseLift: "spindleStop" | "endOfStroke";
  };
  /**
   * Proteção do servo da caneta, o ponto fraco da máquina: o que o esquenta é subir e descer
   * sem parar, não ficar embaixo. Um ciclo = uma descida + uma subida.
   */
  servo: {
    /** Média máxima de ciclos por minuto */
    avgPerMin: number;
    /** Máximo de ciclos em qualquer janela de 60 s */
    peakPer60s: number;
    /** Uma descida não desenha mais que isto (mm): depois disso sobe e desce no mesmo ponto */
    maxDescentMm: number;
    /** Se o desenho passar dos limites: esperar com a caneta em cima, só avisar, ou bloquear */
    onOverload: "wait" | "warn" | "block";
  };
  /** Emendar traços sem levantar a caneta quando a ligação não aparece */
  join: {
    /** Procura um traço para emendar até esta distância (mm) */
    searchMm: number;
    /** Pode emendar passando por cima de tinta já prevista no desenho */
    overInk: boolean;
    /**
     * Caminho pela tinta: em vez de subir, a caneta anda embaixo por cima das linhas do próprio desenho
     * até o próximo traço, se o caminho tiver até isto (mm). 0 = desligado. Precisa de `overInk`.
     */
    retraceMm: number;
    /**
     * Emenda que pode aparecer: a ligação com a caneta embaixo vale se o pedaço dela que cai fora da
     * tinta somar até isto (mm). Fecha as frestas entre linhas que quase se encostam. 0 = só o que não aparece.
     */
    visibleMm: number;
  };
  /** Canetas, na ordem em que as camadas são plotadas (cor → fina → grossa) */
  pens: Pen[];
  /** Caneta dos desenhos que não escolheram uma */
  defaultPen: string;
  /** Cruzes de registro: alinham as camadas quando o desenho usa mais de uma caneta */
  registration: {
    /** auto = só quando o trabalho tem mais de uma caneta */
    mode: "auto" | "always" | "never";
    /** Centro da 1ª cruz (feita antes de tudo) e da 2ª (feita por último), em mm da máquina */
    x1: number;
    x2: number;
    y: number;
    /** Comprimento de cada braço (mm): serve de régua na foto para medir o deslocamento */
    armMm: number;
  };
  /** Blindagem contra falhas da caneta (regras 10 a 14 de docs/REGRAS_GCODE.md) */
  shield: {
    enabled: boolean;
    /** Ciclos de aquecimento do servo antes do 1º traço */
    warmupCycles: number;
    /** Ponto seguro, fora do desenho, onde o aquecimento acontece (mm) */
    safeX: number;
    safeY: number;
    /** Pausa depois da 1ª descida (s): mais longa, para o 1º traço não falhar */
    firstSettleSeconds: number;
    /** Manda o comando de subir duas vezes */
    doubleLift: boolean;
    /** Minutos entre checkpoints (re-sincroniza o servo). 0 desliga. */
    resyncMinutes: number;
    /** Duração alvo de cada parte do arquivo (min). 0 = não divide. */
    partMinutes: number;
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

/** O curso em Y que o projeto usou até 22/11/2026. O da máquina é 390 (corrigido pelo dono dela). */
const OLD_DEFAULT_HEIGHT = 385;

/**
 * Os gabaritos que o projeto trazia até 22/11/2026: no canto da zona de desenho. Era uma posição suposta.
 * O dono da máquina põe a ponta do papel exatamente na origem (onde a caneta fica em "Ir para a origem").
 */
const OLD_TEMPLATES: readonly MachineProfile["paperTemplates"][number][] = [
  { name: "A4", x: 30, y: 25, width: 297, height: 210 },
  { name: "A3", x: 30, y: 25, width: 420, height: 297 },
];

export const DEFAULT_PROFILE: MachineProfile = {
  version: 4,
  // O programa só deixa enviar se a origem gravada na máquina (G54) for (−largura, −altura): se o G54 dela
  // estiver em outro valor, a tela avisa ao conectar e o número certo é o da máquina.
  workArea: { width: 810, height: 390 },
  drawZone: { minX: 30, minY: 25, maxX: 570, maxY: 370 },
  pen: {
    downCmd: "M3 S220",
    upCmd: "M5",
    settleSeconds: 0.3,
    settleUpSeconds: 0.2,
    widthMm: 0.4,
    pauseLift: "spindleStop",
  },
  servo: {
    // REGRAS_GCODE.md pede média <= 20; o Artur aceitou até ~30 (21/11/2026), com espera se passar.
    avgPerMin: 30,
    peakPer60s: 45,
    maxDescentMm: 900,
    onOverload: "wait",
  },
  join: { searchMm: 3, overInk: true, retraceMm: 25, visibleMm: 0.3 },
  // ordem de plotagem de REGRAS_GCODE.md: cor -> fina -> grossa (a grossa cobre as pontas da fina)
  pens: [
    { id: "verde", name: "Verde 0,4", widthMm: 0.4, color: "#12805c", offsetX: 0, offsetY: 0 },
    { id: "fina", name: "Fina 0,03", widthMm: 0.1, color: "#1b4fa8", offsetX: 1, offsetY: 0 },
    { id: "preta", name: "Preta 0,4", widthMm: 0.4, color: "#10151f", offsetX: 0, offsetY: 0 },
  ],
  defaultPen: "preta",
  registration: { mode: "auto", x1: 20, x2: 580, y: 12, armMm: 6 },
  shield: {
    enabled: true,
    warmupCycles: 8,
    safeX: 0,
    safeY: 0,
    firstSettleSeconds: 0.6,
    doubleLift: true,
    resyncMinutes: 10,
    partMinutes: 25,
  },
  feed: {
    // F500 = precisão máxima (REGRAS_GCODE.md). F1000-1500 ainda sai muito bom.
    fixed: 500,
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
  // A ponta do papel fica na origem (0, 0): é onde o dono da máquina encosta a folha. Deitados (paisagem);
  // a zona de desenho começa em X 30, Y 25, então a margem fica DENTRO da folha.
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
  if (typeof def === "boolean") return typeof saved === "boolean" ? saved : def;
  return def;
}

/**
 * Perfil salvo (possivelmente antigo ou incompleto) + padrão. Chaves desconhecidas são ignoradas.
 * Perfil da versão 1 (antes das regras de docs/REGRAS_GCODE.md): a velocidade fixa volta ao padrão
 * novo (F500), porque o valor antigo (F1000) era só o padrão daquela versão, não uma escolha medida.
 */
export function mergeProfile(saved: unknown): MachineProfile {
  const merged = mergeInto(DEFAULT_PROFILE, saved) as MachineProfile;
  const templates = merged.paperTemplates.filter(
    (t) =>
      isObj(t) &&
      typeof t.name === "string" &&
      [t.x, t.y, t.width, t.height].every((n) => typeof n === "number" && Number.isFinite(n)),
  );
  const pauseLift = merged.pen.pauseLift === "endOfStroke" ? "endOfStroke" : "spindleStop";
  const isStr = (v: unknown): v is string => typeof v === "string";
  const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  let pens = merged.pens.filter((p) => isObj(p) && isStr(p.id) && p.id !== "" && isStr(p.name) && isStr(p.color) && [p.widthMm, p.offsetX, p.offsetY].every(isNumber));
  if (pens.length === 0) pens = structuredClone(DEFAULT_PROFILE.pens);
  const defaultPen = pens.some((p) => p.id === merged.defaultPen) ? merged.defaultPen : pens[pens.length - 1].id;
  const regMode = merged.registration.mode === "always" || merged.registration.mode === "never" ? merged.registration.mode : "auto";
  const onOverload = merged.servo.onOverload === "warn" || merged.servo.onOverload === "block" ? merged.servo.onOverload : "wait";
  // de que versão é o perfil salvo (sem número = o primeiro formato)
  const version = isObj(saved) && typeof saved.version === "number" ? saved.version : 1;
  const old = isObj(saved) && version < 2;
  const feed = old ? { ...merged.feed, fixed: DEFAULT_PROFILE.feed.fixed } : merged.feed;
  // Perfil salvo antes da versão 3 com o curso em Y antigo (385): era só o padrão daquela versão, e estava
  // errado. Passa a 390 uma vez; quem salvar 385 de novo, já na versão 3, fica com 385.
  const stale = isObj(saved) && version < 3 && merged.workArea.height === OLD_DEFAULT_HEIGHT;
  const workArea = stale ? { ...merged.workArea, height: DEFAULT_PROFILE.workArea.height } : merged.workArea;
  // Perfil salvo antes da versão 4: o gabarito que ainda está na posição suposta (igual ao padrão antigo)
  // vai para a origem. O que o dono mediu e mudou, ou criou, fica como está.
  const wasDefault = (t: MachineProfile["paperTemplates"][number]) =>
    OLD_TEMPLATES.some((o) => o.name === t.name && o.x === t.x && o.y === t.y && o.width === t.width && o.height === t.height);
  const placed = isObj(saved) && version < 4 ? templates.map((t) => (wasDefault(t) ? { ...t, x: 0, y: 0 } : t)) : templates;
  return {
    ...merged,
    version: 4,
    workArea,
    feed,
    pen: { ...merged.pen, pauseLift },
    servo: { ...merged.servo, onOverload },
    pens,
    defaultPen,
    registration: { ...merged.registration, mode: regMode },
    paperTemplates: placed,
  };
}

/** A caneta de um desenho: a escolhida, ou a padrão do perfil, ou a última da lista. */
export function penOf(profile: MachineProfile, penId: string | undefined): Pen {
  const pens = profile.pens;
  return pens.find((p) => p.id === penId) ?? pens.find((p) => p.id === profile.defaultPen) ?? pens[pens.length - 1];
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
    else if (/[!?~]/.test(cmd)) e.push(`${label} não pode ter "!", "?" nem "~" (para o GRBL são pausa, relatório e continuar).`);
  }
  // sem pausa a máquina anda antes de o servo chegar (regra 9): "G4 P0" não espera nada
  range(p.pen.settleSeconds, 0.05, 5, "Pausa depois de descer (s)");
  range(p.pen.settleUpSeconds, 0.05, 5, "Pausa depois de subir (s)");
  range(p.pen.widthMm, 0.01, 10, "Largura da caneta (mm)");

  const z = p.drawZone;
  if (!(z.minX < z.maxX && z.minY < z.maxY)) e.push("A zona de desenho está invertida (mínimo maior que o máximo).");
  if (z.minX < 0 || z.minY < 0 || z.maxX > p.workArea.width || z.maxY > p.workArea.height) {
    e.push("A zona de desenho tem que ficar dentro do curso da máquina.");
  }

  range(p.servo.avgPerMin, 1, 200, "Média de ciclos do servo por minuto");
  range(p.servo.peakPer60s, 5, 400, "Pico de ciclos do servo em 60 s");
  if (p.servo.peakPer60s < p.servo.avgPerMin) e.push("O pico do servo em 60 s não pode ser menor que a média por minuto.");
  range(p.servo.maxDescentMm, 10, 100000, "Traço máximo por descida (mm)");
  range(p.join.searchMm, 0, 50, "Distância de busca para emendar (mm)");
  range(p.join.retraceMm, 0, 200, "Andar por cima da tinta até (mm)");
  range(p.join.visibleMm, 0, 2, "Emenda que pode aparecer (mm)");

  const ids = new Set<string>();
  for (const pen of p.pens) {
    if (!pen.name.trim()) e.push("Toda caneta precisa de nome.");
    if (ids.has(pen.id)) e.push(`Há duas canetas com o mesmo identificador (${pen.id}).`);
    ids.add(pen.id);
    range(pen.widthMm, 0.01, 10, `Largura da caneta ${pen.name}`);
    range(pen.offsetX, -20, 20, `Deslocamento X da caneta ${pen.name}`);
    range(pen.offsetY, -20, 20, `Deslocamento Y da caneta ${pen.name}`);
  }
  if (p.pens.length === 0) e.push("O perfil precisa de pelo menos uma caneta.");
  const reg = p.registration;
  range(reg.armMm, 1, 50, "Braço da cruz de registro (mm)");
  for (const x of [reg.x1, reg.x2]) {
    if (x - reg.armMm / 2 < 0 || x + reg.armMm / 2 > p.workArea.width || reg.y - reg.armMm / 2 < 0 || reg.y + reg.armMm / 2 > p.workArea.height) {
      e.push("As cruzes de registro têm que caber no curso da máquina.");
      break;
    }
  }

  const sh = p.shield;
  // o aquecimento também são ciclos do servo, um a cada 0,8 s: muitos seguidos estouram o próprio limite
  range(sh.warmupCycles, 0, 20, "Ciclos de aquecimento");
  // as batidas do aquecimento saem todas em poucos segundos: sozinhas, não podem passar do pico
  if (sh.enabled && sh.warmupCycles > p.servo.peakPer60s - 1) e.push(`O aquecimento (${sh.warmupCycles} ciclos) não cabe no pico do servo (${p.servo.peakPer60s} em 60 s): diminua os ciclos ou aumente o pico.`);
  if (!(sh.safeX >= 0 && sh.safeX <= p.workArea.width && sh.safeY >= 0 && sh.safeY <= p.workArea.height)) {
    e.push("O ponto seguro do aquecimento tem que ficar dentro do curso da máquina.");
  }
  range(sh.firstSettleSeconds, 0.05, 5, "Pausa da 1ª descida (s)");
  range(sh.resyncMinutes, 0, 120, "Minutos entre checkpoints");
  range(sh.partMinutes, 0, 600, "Duração de cada parte (min)");

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
