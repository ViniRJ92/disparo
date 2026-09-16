import type { ConnectionStatus } from '../providers/provider.types.ts';
import type { LineSettings } from '../settings/settings.schema.ts';

export type { ConnectionStatus, LineSettings };

/** O que a linha está fazendo agora. */
export type OperationalStatus = 'idle' | 'sending' | 'error';

/**
 * Intenção do usuário para a linha:
 *   stopped  nunca iniciada ou desconectada manualmente
 *   active   participa dos disparos
 *   paused   conectada, mas fora dos disparos até ser retomada
 */
export type RunState = 'stopped' | 'active' | 'paused';

/** Por que a linha está pausada: pelo usuário ou pela pausa programada. */
export type PauseReason = 'manual' | 'scheduled';

/**
 * ESTADO OPERACIONAL (separado do estado da conexão e da participação no disparo):
 *   active / paused / stopped vêm da intenção do usuário; error = erro operacional.
 */
export type OperationalState = 'active' | 'paused' | 'stopped' | 'error';

export type LineCommand = 'connect' | 'start' | 'pause' | 'resume' | 'disconnect' | 'reconnect';

/** Comandos que podem ser aplicados em lote às linhas selecionadas. */
export type BulkLineCommand = 'start' | 'pause' | 'resume';

/**
 * Estado único e claro da linha, derivado de conexão + intenção + operação:
 *   disconnected  desconectada
 *   connecting    conectando (inclui aguardando QR Code)
 *   reconnecting  reconectando (manual ou automática após queda)
 *   connected     conectada, mas parada (não participa dos envios)
 *   active        conectada e ativa (trabalhando)
 *   paused        conectada e pausada
 *   error         erro de conexão ou operacional
 */
export type LineStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'active' | 'paused' | 'error';

/** Última atividade da linha (atualizada pelo histórico a cada tentativa de envio). */
export interface LineActivity {
  /** Último contato processado (enviado ou com erro). */
  lastContactId: string | null;
  lastContactName: string | null;
  lastContactPhone: string | null;
  /** Última mensagem utilizada. */
  lastMessageLabel: string | null;
  lastAttemptAt: string | null;
  lastAttemptResult: 'sent' | 'failed' | null;
  /** Último envio concluído com sucesso. */
  lastSentAt: string | null;
}

export const EMPTY_LINE_ACTIVITY: LineActivity = {
  lastContactId: null,
  lastContactName: null,
  lastContactPhone: null,
  lastMessageLabel: null,
  lastAttemptAt: null,
  lastAttemptResult: null,
  lastSentAt: null,
};

export interface LineCounters {
  contactsProcessed: number;
  messagesSent: number;
  failures: number;
}

/** Entidade persistida (inclui a configuração do provedor, que nunca sai da API). */
export interface Line {
  id: string;
  label: string;
  provider: string;
  providerConfig: Record<string, unknown>;
  accountId: string | null;
  displayName: string | null;
  connectionStatus: ConnectionStatus;
  operationalStatus: OperationalStatus;
  runState: RunState;
  /** Só tem valor quando runState = 'paused'. */
  pauseReason: PauseReason | null;
  /** Mensagens enviadas desde a última vez que a linha continuou (pausa programada, por linha). */
  scheduledPauseCount: number;
  /** Pausada pela pausa programada e aguardando decisão (Continuar / Manter pausada). */
  scheduledPausePending: boolean;
  connectedAt: string | null;
  lastError: string | null;
  settings: LineSettings;
  counters: LineCounters;
  activity: LineActivity;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** Visão pública da linha (API, UI, eventos). */
export interface LineView extends Omit<Line, 'providerConfig'> {
  /**
   * Contatos ainda pendentes nos processos em andamento (ou pausados) dos quais
   * esta linha participa, mais o envio que ela tem em curso. A fila é
   * compartilhada entre as linhas selecionadas: se uma cair, as outras seguem.
   */
  pending: number;
  /** Pode receber envios agora (conectada + ativa + sem erro operacional). */
  available: boolean;
  /** Último QR Code recebido (somente provedores com pareamento). */
  qrCode: string | null;
  /** Estado consolidado exibido na interface. */
  status: LineStatus;
  reconnecting: boolean;
  /** Próxima tentativa automática de reconexão, se agendada. */
  nextReconnectAt: string | null;
  operationalState: OperationalState;
  scheduledPause: LineScheduledPauseView;
}

export interface LineScheduledPauseView {
  enabled: boolean;
  /** null = sem limite. */
  limit: number | null;
  /** Contador individual desta linha. */
  count: number;
  /** Quantas mensagens faltam para esta linha pausar (null = não se aplica). */
  remaining: number | null;
  awaitingDecision: boolean;
}

export interface BulkCommandResult {
  lineId: string;
  outcome: 'done' | 'skipped' | 'failed';
  message?: string;
  line?: LineView;
}

export interface LinesSummary {
  max: number;
  total: number;
  connected: number;
  active: number;
  paused: number;
  stopped: number;
  disconnected: number;
  withError: number;
  available: number;
}

export interface CreateLineInput {
  label: string;
  provider: string;
  providerConfig?: Record<string, unknown>;
  settings?: Partial<LineSettings>;
}

export interface UpdateLineInput {
  label?: string;
  providerConfig?: Record<string, unknown>;
  settings?: Partial<LineSettings>;
  position?: number;
}

/** Fornece a quantidade pendente por linha (implementado pela fila). */
export interface PendingCounter {
  pendingByLine(): Promise<Map<string, number>>;
}
