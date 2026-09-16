import { newId } from '../../shared/ids.ts';
import type {
  ConnectionUpdate,
  ProviderChatMessage,
  ProviderContext,
  SendResult,
  SendTextRequest,
  WhatsAppProvider,
} from './provider.types.ts';

/**
 * Provedor simulado: não envia nada de verdade. Serve para desenvolver e testar
 * toda a arquitetura sem conta real e sem risco de bloqueio.
 *
 * Opções (em provider_config da linha):
 *   accountId        número exibido quando "conectado"
 *   failConnect      true => a conexão falha (testa isolamento de erro)
 *   failSend         true => todo envio falha
 *   connectDelayMs   atraso simulado da conexão
 *   sendDelayMs      atraso simulado de cada envio
 */
export class MockProvider implements WhatsAppProvider {
  private readonly context: ProviderContext;
  private readonly listeners = new Set<(update: ConnectionUpdate) => void>();
  private readonly messageListeners = new Set<(message: ProviderChatMessage) => void>();
  private connected = false;

  constructor(context: ProviderContext) {
    this.context = context;
  }

  async connect(): Promise<void> {
    const { failConnect, connectDelayMs, accountId } = this.context.config;
    this.emit({ status: 'connecting' });
    if (typeof connectDelayMs === 'number' && connectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
    }
    if (failConnect === true) {
      this.connected = false;
      throw new Error('Falha simulada de conexão');
    }
    this.connected = true;
    this.emit({
      status: 'connected',
      accountId: typeof accountId === 'string' ? accountId : `mock-${this.context.lineId.slice(0, 8)}`,
      displayName: 'Linha simulada',
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit({ status: 'disconnected' });
  }

  async sendText(_request: SendTextRequest): Promise<SendResult> {
    if (!this.connected) return { ok: false, error: 'Linha não conectada', retryable: true };
    const { sendDelayMs } = this.context.config;
    if (typeof sendDelayMs === 'number' && sendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      if (!this.connected) return { ok: false, error: 'Conexão caiu durante o envio', retryable: true };
    }
    if (this.context.config.failSend === true) {
      return { ok: false, error: 'Falha simulada de envio', retryable: false };
    }
    return { ok: true, providerMessageId: `mock-${newId()}` };
  }

  onConnectionUpdate(listener: (update: ConnectionUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onMessage(listener: (message: ProviderChatMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Testes: simula uma mensagem chegando (ou saindo) numa conversa desta linha. */
  simulateMessage(message: ProviderChatMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  /** Permite simular, em testes, uma queda de conexão vinda do provedor. */
  simulateDrop(error = 'Conexão perdida'): void {
    this.connected = false;
    this.emit({ status: 'error', error });
  }

  async dispose(): Promise<void> {
    this.connected = false;
    this.listeners.clear();
    this.messageListeners.clear();
  }

  private emit(update: ConnectionUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}

export const createMockProvider = (context: ProviderContext): WhatsAppProvider => new MockProvider(context);
