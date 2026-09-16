/**
 * Situação operacional do worker de UMA linha:
 *   line_unavailable  linha desconectada, pausada, parada ou com erro
 *   no_process        linha apta, mas não selecionada em nenhum processo em andamento
 *   no_contacts       processos sem contatos pendentes
 *   waiting_turn      cota da rodada esgotada: aguarda as outras linhas (distribuição)
 *   no_message        nenhuma mensagem utilizável para o contato
 *   daily_limit       limite diário da linha atingido
 *   cooldown          aguardando o intervalo configurado entre envios
 *   sending           enviando agora
 *   error             exceção inesperada (o worker tenta de novo sozinho)
 *   stopped           worker encerrado (linha removida ou app fechando)
 */
export type WorkerState =
  | 'line_unavailable'
  | 'no_process'
  | 'no_contacts'
  | 'waiting_turn'
  | 'no_message'
  | 'daily_limit'
  | 'cooldown'
  | 'sending'
  | 'error'
  | 'stopped';

export interface WorkerSnapshot {
  lineId: string;
  state: WorkerState;
  /** Processo do envio atual ou do último envio. */
  campaignId: string | null;
  /** Quando a linha poderá enviar de novo (intervalo entre envios). */
  nextSendAt: string | null;
  sentToday: number;
  lastSentAt: string | null;
  lastError: string | null;
}

export interface DispatchOptions {
  /** Liga os workers automaticamente (default true). */
  enabled: boolean;
  /** Reavaliação periódica quando não há o que fazer (eventos acordam antes). */
  idlePollMs: number;
  /** Espera após uma exceção inesperada no worker. */
  errorBackoffMs: number;
  /** Tentativas por contato antes de marcar falha definitiva (falhas temporárias). */
  maxAttempts: number;
  /** Fonte de aleatoriedade (injetável para testes). */
  random: () => number;
}

export const DEFAULT_DISPATCH_OPTIONS: DispatchOptions = {
  enabled: true,
  idlePollMs: 30_000,
  errorBackoffMs: 10_000,
  maxAttempts: 3,
  random: Math.random,
};
