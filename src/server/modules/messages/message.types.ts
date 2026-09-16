export const MAX_MESSAGE_SLOTS = 5;

export interface MessageTemplate {
  id: string;
  /** Posição fixa: Mensagem 01..05. */
  slot: number;
  /** Rótulo exibido (padrão "Mensagem 0N"). */
  name: string;
  /** Texto com variáveis no formato {{nome}}, {{telefone}} ou {{qualquerCampo}}. */
  body: string;
  /** Somente mensagens ativas participam da seleção. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Uma das 5 posições, ocupada ou livre. */
export interface MessageSlot {
  slot: number;
  message: MessageTemplate | null;
}

export interface SaveMessageInput {
  body: string;
  name?: string;
  active?: boolean;
}

export const defaultMessageName = (slot: number) => `Mensagem ${String(slot).padStart(2, '0')}`;
