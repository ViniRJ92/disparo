export type JobStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'skipped';

/** Um contato dentro de uma campanha: unidade da fila de processamento. */
export interface SendJob {
  id: string;
  campaignId: string;
  contactId: string;
  /** Linha que assumiu o envio (definida pela distribuição). */
  lineId: string | null;
  messageTemplateId: string | null;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

export interface JobCounts {
  total: number;
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  skipped: number;
  /** sent + failed + skipped */
  processed: number;
}

export const emptyJobCounts = (): JobCounts => ({
  total: 0,
  pending: 0,
  processing: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  processed: 0,
});
