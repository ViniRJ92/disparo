/** Status cadastral: bloqueado nunca recebe mensagens. */
export type ContactStatus = 'active' | 'blocked';

/**
 * Situação do contato na fila de processamento:
 *   idle        fora de qualquer processo ativo
 *   pending     na fila, com linha apta para enviar
 *   waiting     na fila, mas pausado/aguardando (processo pausado ou sem linha apta)
 *   processing  uma linha está enviando agora
 *   sent        último resultado: enviado
 *   failed      último resultado: erro
 */
export type ContactProcessingStatus = 'idle' | 'pending' | 'waiting' | 'processing' | 'sent' | 'failed';

export interface Contact {
  id: string;
  /** Somente dígitos, com DDI (ex.: 5521999998888). Único: não há contatos duplicados. */
  phone: string;
  name: string | null;
  /** Campos livres usados na personalização das mensagens ({{campo}}). */
  variables: Record<string, string>;
  status: ContactStatus;
  processingStatus: ContactProcessingStatus;
  /** Quantidade de mensagens recebidas com sucesso. */
  messagesReceived: number;
  /** Última mensagem recebida (usada também na regra de não repetição). */
  lastMessageTemplateId: string | null;
  /** Rótulo da última mensagem no momento do envio (preservado se a mensagem mudar). */
  lastMessageLabel: string | null;
  lastLineId: string | null;
  lastSentAt: string | null;
  /** Erro do último envio que falhou. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Contato com nomes relacionados para exibição. */
export interface ContactView extends Contact {
  lastLineLabel: string | null;
}

/**
 * Público de um disparo, resolvido no servidor (bloqueados nunca entram):
 *   all_active      todos os contatos ativos
 *   never_received  contatos ativos que ainda não receberam nenhuma mensagem
 */
export type ContactAudience = 'all_active' | 'never_received';

export interface ContactInput {
  phone: string;
  name?: string | null;
  variables?: Record<string, string>;
}

export interface CreateContactInput extends ContactInput {
  status?: ContactStatus;
}

export interface UpdateContactInput {
  phone?: string;
  name?: string | null;
  variables?: Record<string, string>;
  status?: ContactStatus;
}

export interface ContactQuery {
  search?: string;
  status?: ContactStatus;
  processingStatus?: ContactProcessingStatus;
  limit?: number;
  offset?: number;
}

export interface ContactsSummary {
  total: number;
  active: number;
  blocked: number;
  byProcessing: Record<ContactProcessingStatus, number>;
}

export interface ImportContactsResult {
  created: number;
  updated: number;
  invalid: { phone: string; reason: string }[];
  contactIds: string[];
}
