/**
 * Códigos de erro e alarme do GRBL 1.1 (lista oficial do gnea/grbl, doc/csv/error_codes_en_US.csv e
 * alarm_codes_en_US.csv), traduzidos, com o que fazer nos que aparecem nesta máquina.
 */

export interface CodeInfo {
  readonly title: string;
  readonly action: string;
}

export interface AlarmInfo extends CodeInfo {
  /** A posição pode ter se perdido: refazer o Home antes de desenhar */
  readonly needsHoming: boolean;
}

const ERRORS: Record<number, CodeInfo> = {
  1: { title: "Letra de comando esperada", action: "Linha mal formatada (ex.: parênteses aninhados num comentário, como \"( a (b) )\"). Confira o texto da linha." },
  2: { title: "Número mal formatado", action: "Falta o valor de uma palavra do G-code ou o número é inválido. Se a linha veio do Plotter Studio, é bug." },
  3: { title: "Comando $ não reconhecido", action: "Confira o comando ($$, $#, $G, $I, $H, $X, $J=...)." },
  4: { title: "Valor negativo", action: "O comando esperava um valor positivo." },
  5: { title: "Homing desabilitado", action: "O homing está desligado ($22=0). Não mude a configuração sem conferir a máquina." },
  6: { title: "Pulso de passo menor que 3 µs", action: "O $0 tem que ser pelo menos 3." },
  7: { title: "Falha ao ler a EEPROM", action: "O GRBL restaurou os valores padrão. Confira a configuração ($$) e a origem ($#) antes de desenhar." },
  8: { title: "Só com a máquina parada (Idle)", action: "Esse comando $ não pode ser usado durante um movimento. Espere a máquina parar." },
  9: { title: "G-code bloqueado (alarme ou jog)", action: "Faça o Home ($H) ou desbloqueie ($X)." },
  10: { title: "Soft limits exigem homing", action: "O soft limit ($20) só funciona com o homing ($22) ligado." },
  11: { title: "Linha longa demais", action: "A linha passou de 80 caracteres e não foi executada." },
  12: { title: "Velocidade de passos acima de 30 kHz", action: "O valor da configuração faria os motores passarem do limite do Arduino." },
  13: { title: "Porta de segurança aberta", action: "A entrada de porta de segurança foi acionada." },
  14: { title: "Linha longa demais para a EEPROM", action: "Linha de inicialização ou build info maior que o limite: não foi gravada." },
  15: { title: "O jog passaria do limite", action: "O movimento sairia da área útil e foi ignorado." },
  16: { title: "Comando de jog inválido", action: "Falta \"=\" ou há G-code proibido no $J=." },
  17: { title: "Modo laser exige PWM", action: "Não use o modo laser: $32 tem que ficar 0 (com 1 o servo da caneta para de funcionar)." },
  20: { title: "Comando não suportado", action: "Comando G ou M que o GRBL não conhece." },
  21: { title: "Dois comandos do mesmo grupo na linha", action: "Ex.: G0 e G1 na mesma linha. Separe em duas linhas." },
  22: { title: "Velocidade (F) não definida", action: "O primeiro G1 precisa de F. Se a linha veio do Plotter Studio, é bug." },
  23: { title: "O comando exige valor inteiro", action: "Confira o número depois da letra." },
  24: { title: "Dois comandos com eixos na mesma linha", action: "Separe em duas linhas." },
  25: { title: "Palavra repetida na linha", action: "Ex.: dois X na mesma linha." },
  26: { title: "Faltam os eixos (X/Y) no comando", action: "O comando precisa de pelo menos um eixo." },
  27: { title: "Número de linha inválido", action: "O valor do N está fora do intervalo." },
  28: { title: "Falta um valor obrigatório", action: "Ex.: G4 sem P." },
  29: { title: "G59.x não é suportado", action: "Use G54–G59." },
  30: { title: "G53 só com G0 ou G1", action: "Confira o modo de movimento." },
  31: { title: "Eixos sem comando que os use", action: "Há X/Y numa linha que não move nada." },
  32: { title: "G2/G3 sem eixo no plano", action: "O arco precisa de pelo menos um eixo do plano." },
  33: { title: "Destino do movimento inválido", action: "O destino do arco não bate com o raio." },
  34: { title: "Raio do arco inválido", action: "Confira o R do arco." },
  35: { title: "G2/G3 sem offset no plano", action: "O arco precisa de I/J." },
  36: { title: "Valores sobrando na linha", action: "Há palavras que nenhum comando usa." },
  37: { title: "G43.1 no eixo errado", action: "O offset de ferramenta só vale no eixo configurado." },
  38: { title: "Número de ferramenta acima do máximo", action: "Use uma ferramenta menor." },
};

const ALARMS: Record<number, AlarmInfo> = {
  1: {
    title: "Fim de curso acionado (hard limit)",
    action: "A máquina parou de repente e a posição pode ter se perdido. Hoje $21=0, então isto não devia aparecer: confira os fins de curso. Reset e depois Home.",
    needsHoming: true,
  },
  2: {
    title: "Destino fora da área (soft limit)",
    action: "Um movimento sairia do curso da máquina (o tamanho dele está em Configurações). Clique em Reset e refaça o Home para garantir a posição.",
    needsHoming: true,
  },
  3: { title: "Reset com a máquina andando", action: "A posição pode ter se perdido (passos perdidos na parada brusca). Refaça o Home.", needsHoming: true },
  4: { title: "Sonda: estado inicial errado", action: "Esta máquina não usa sonda. Desbloqueie ($X).", needsHoming: false },
  5: { title: "Sonda não tocou", action: "Esta máquina não usa sonda. Desbloqueie ($X).", needsHoming: false },
  6: { title: "Homing: reset durante o homing", action: "O homing foi interrompido. Faça o Home de novo.", needsHoming: true },
  7: { title: "Homing: porta de segurança aberta", action: "Feche a porta de segurança e faça o Home de novo.", needsHoming: true },
  8: { title: "Homing: não conseguiu se afastar da chave", action: "Confira a chave de fim de curso e o $27 (pull-off). Faça o Home de novo.", needsHoming: true },
  9: { title: "Homing: não encontrou a chave", action: "Confira a fiação dos fins de curso e se nada travou o carro. Faça o Home de novo.", needsHoming: true },
};

export function describeError(code: number): CodeInfo {
  return ERRORS[code] ?? { title: `Erro ${code} desconhecido`, action: "Código que o GRBL 1.1 não documenta. Confira a linha enviada." };
}

export function describeAlarm(code: number): AlarmInfo {
  return ALARMS[code] ?? { title: `Alarme ${code} desconhecido`, action: "Clique em Reset e refaça o Home.", needsHoming: true };
}

/** Códigos documentados (para testes e para a tabela de ajuda). */
export const KNOWN_ERROR_CODES: readonly number[] = Object.keys(ERRORS).map(Number);
export const KNOWN_ALARM_CODES: readonly number[] = Object.keys(ALARMS).map(Number);

/** "error:22 — Velocidade (F) não definida" */
export function errorText(code: number): string {
  return `error:${code} — ${describeError(code).title}`;
}

export function alarmText(code: number): string {
  return `ALARM:${code} — ${describeAlarm(code).title}`;
}
