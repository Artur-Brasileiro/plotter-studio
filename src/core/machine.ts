/**
 * Perfil da máquina: tudo que é específico da CNC Plotter do Artur fica aqui.
 * A UI de Configurações deve editar estes valores (e salvar no localStorage),
 * para que trocar servo, caneta ou velocidades não exija mexer no código.
 *
 * Convenção de coordenadas (igual ao GRBL com G54 gravado):
 *   - origem (0,0) no canto da FRENTE à ESQUERDA da mesa
 *   - X+ para a direita, Y+ para longe do operador
 *   - na tela, Y+ aponta para CIMA (o operador vê o papel de frente)
 */
export interface MachineProfile {
  /** Área útil em mm (= $130 / $131 do GRBL) */
  workArea: { width: number; height: number };
  pen: {
    /** Comando que ABAIXA a caneta (servo no PWM do spindle) */
    downCmd: string;
    /** Comando que LEVANTA a caneta. M5 = seguro: o GRBL executa M5 em reset/alarme */
    upCmd: string;
    /** Pausa após cada subida/descida, em segundos (G4 P...) */
    settleSeconds: number;
  };
  feed: {
    /** Velocidade fixa padrão (mm/min). Deslocamentos com a caneta levantada usam G0. */
    fixed: number;
    /** Modo dinâmico: velocidade em trechos retos (mm/min) */
    straight: number;
    /** Modo dinâmico: velocidade em curvas suaves (mm/min) */
    curve: number;
    /** Modo dinâmico: velocidade em curvas fechadas / cantos vivos (mm/min) */
    tightCurve: number;
  };
  /** Gabaritos desenhados na madeira da mesa (retângulos de referência, em mm) */
  paperTemplates: { name: string; x: number; y: number; width: number; height: number }[];
}

export const DEFAULT_PROFILE: MachineProfile = {
  workArea: { width: 810, height: 385 },
  pen: {
    downCmd: "M3 S220",
    upCmd: "M5",
    settleSeconds: 0.3,
  },
  feed: {
    fixed: 1000,
    straight: 2000,
    curve: 1200,
    tightCurve: 600,
  },
  // ATENÇÃO: posições assumidas a partir da origem, em paisagem.
  // Conferir com o gabarito real da mesa antes de confiar.
  paperTemplates: [
    { name: "A4", x: 0, y: 0, width: 297, height: 210 },
    { name: "A3", x: 0, y: 0, width: 420, height: 297 },
  ],
};
