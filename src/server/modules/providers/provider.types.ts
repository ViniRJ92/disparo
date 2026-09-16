/**
 * Contrato de transporte do WhatsApp.
 *
 * O núcleo (linhas, campanhas, fila, histórico) só conhece esta interface.
 * Cada linha recebe a SUA instância de provedor: falha ou desconexão de um
 * provedor afeta apenas a linha dona dele.
 *
 * Implementações previstas: "mock" (simulado, disponível agora) e, nos próximos
 * módulos, a WhatsApp Cloud API oficial da Meta (ou outro adaptador).
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'qr_required' | 'connected' | 'error';

export interface ConnectionUpdate {
  status: ConnectionStatus;
  /** Número/identificação da conta, quando o provedor souber. */
  accountId?: string | null;
  displayName?: string | null;
  /** QR Code (para provedores que usam pareamento). */
  qrCode?: string | null;
  error?: string | null;
}

export interface SendTextRequest {
  /** Telefone do destinatário, somente dígitos com DDI. */
  to: string;
  body: string;
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * Mensagem de uma conversa da linha, informada pelo provedor (recebida, enviada
 * pelo próprio aparelho ou de grupo). É a base real do Analytics.
 */
export interface ProviderChatMessage {
  providerMessageId: string;
  /** Identificação da conversa (ex.: 5521...@c.us, ...@lid, ...@g.us). */
  chatId: string;
  /** O provedor informa explicitamente que é grupo (além do sufixo @g.us). */
  isGroup?: boolean;
  /** Nome do grupo ou da conversa. */
  chatName?: string | null;
  /** Quem escreveu (em grupos: o participante). */
  senderId?: string | null;
  senderName?: string | null;
  /** true = enviada pela própria linha. */
  fromMe: boolean;
  body?: string | null;
  /** Horário da mensagem (ms desde 1970). */
  timestamp: number;
}

export interface WhatsAppProvider {
  /** Inicia a conexão. O progresso é informado por onConnectionUpdate. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendText(request: SendTextRequest): Promise<SendResult>;
  onConnectionUpdate(listener: (update: ConnectionUpdate) => void): () => void;
  /** Mensagens das conversas da linha (opcional: provedores sem esse recurso não informam). */
  onMessage?(listener: (message: ProviderChatMessage) => void): () => void;
  /** Libera recursos definitivamente (linha removida ou app encerrando). */
  dispose(): Promise<void>;
}

export interface ProviderContext {
  lineId: string;
  /** Configuração específica do provedor (ex.: IDs e tokens da Cloud API). */
  config: Record<string, unknown>;
}

export type ProviderFactory = (context: ProviderContext) => WhatsAppProvider;
