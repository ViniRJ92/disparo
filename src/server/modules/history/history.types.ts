export type AttemptResult = 'sent' | 'failed';

/** Registro imutável de uma tentativa de envio. */
export interface SendAttempt {
  id: string;
  jobId: string;
  campaignId: string;
  contactId: string;
  lineId: string | null;
  messageTemplateId: string | null;
  /** Rótulo da mensagem no momento do envio (ex.: "Mensagem 02"). */
  messageLabel: string | null;
  /** Texto efetivamente enviado (não muda se a mensagem for editada depois). */
  renderedBody: string | null;
  result: AttemptResult;
  error: string | null;
  providerMessageId: string | null;
  /** Ciclo de distribuição e o intervalo sorteado para ele. */
  cycleNumber: number | null;
  cycleIntervalSeconds: number | null;
  /** Nome da linha no momento do envio. */
  lineLabelAtSend: string | null;
  /** Falha temporária: o contato voltou para a fila. */
  requeued: boolean;
  createdAt: string;
}

/** Tentativa com os nomes relacionados, para exibição/auditoria. */
export interface SendAttemptView extends SendAttempt {
  contactPhone: string;
  contactName: string | null;
  lineLabel: string | null;
  campaignName: string;
}

export interface RecordAttemptInput {
  jobId: string;
  lineId: string;
  messageTemplateId: string | null;
  messageLabel?: string | null;
  /** Nome da linha no momento do envio (preservado mesmo se a linha for removida antes do registro). */
  lineLabel?: string | null;
  cycleNumber?: number | null;
  cycleIntervalSeconds?: number | null;
  renderedBody: string | null;
  result: AttemptResult;
  error?: string | null;
  providerMessageId?: string | null;
  /**
   * Falha temporária que deve voltar para a fila (job volta a "pending").
   * Nesse caso o contato ainda não conta como processado.
   */
  requeue?: boolean;
}

export interface HistoryQuery {
  campaignId?: string;
  lineId?: string;
  contactId?: string;
  result?: AttemptResult;
  /** AAAA-MM-DD (inclusivo, horário local). */
  from?: string;
  to?: string;
  /** Nome, telefone ou ID do contato. */
  contact?: string;
  /** Rótulo da mensagem. */
  message?: string;
  limit?: number;
  offset?: number;
}

export interface SendRecordedEvent {
  attemptId: string;
  jobId: string;
  campaignId: string;
  lineId: string;
  result: AttemptResult;
  requeued: boolean;
}
