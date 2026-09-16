import type { ContactAudience } from '../contacts/contact.types.ts';
import type { LineView } from '../lines/line.types.ts';
import type { JobCounts } from '../queue/queue.types.ts';

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';

/** cancel = ENCERRAR o disparo (definitivo). pause = interromper podendo retomar depois. */
export type CampaignAction = 'start' | 'pause' | 'resume' | 'cancel' | 'complete';

/** Processo de disparo. */
export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CampaignSummary extends Campaign {
  /** Linhas selecionadas para este disparo. */
  lineIds: string[];
  counts: JobCounts;
}

/** Situação de uma linha selecionada dentro da campanha. */
export interface CampaignLineStatus {
  line: LineView;
  counts: JobCounts;
}

export interface CampaignDetail extends CampaignSummary {
  lines: CampaignLineStatus[];
  /** Quantas das linhas selecionadas podem enviar agora. */
  availableLineCount: number;
}

export interface CreateCampaignInput {
  name: string;
  lineIds: string[];
  /** Contatos específicos... */
  contactIds?: string[];
  /** ...ou um público resolvido no servidor (ignorado se contactIds for informado). */
  audience?: ContactAudience;
  /** Inicia o disparo logo após criar. */
  start?: boolean;
}
