import { EventEmitter } from 'node:events';
import type { LineView } from '../modules/lines/line.types.ts';
import type { CampaignSummary } from '../modules/campaigns/campaign.types.ts';
import type { LogEntry } from '../modules/logs/log.types.ts';
import type { SendRecordedEvent } from '../modules/history/history.types.ts';
import type { WorkerSnapshot } from '../modules/dispatch/dispatch.types.ts';
import type { RoundSnapshot } from '../modules/distribution/distribution.types.ts';
import type { ProviderChatMessage } from '../modules/providers/provider.types.ts';

/** Catálogo de eventos do domínio (consumidos pela UI via SSE e por módulos futuros). */
export interface DomainEvents {
  'line.updated': LineView;
  'line.removed': { id: string };
  'campaign.updated': CampaignSummary;
  'log.created': LogEntry;
  /** Uma tentativa de envio foi registrada no histórico. */
  'send.recorded': SendRecordedEvent;
  /** O worker de uma linha mudou de situação operacional. */
  'worker.updated': WorkerSnapshot;
  /** Mensagens criadas, editadas, (des)ativadas ou excluídas. */
  'messages.updated': { activeCount: number };
  /** Uma linha atingiu o limite da pausa programada e aguarda decisão. */
  'line.scheduled_pause': { lineId: string; label: string; limit: number; count: number };
  /** Mensagem de conversa informada pelo provedor de uma linha. */
  'conversation.message': { lineId: string; message: ProviderChatMessage };
  /** Mensagem de conversa gravada (para atualizar Histórico/Analytics em tempo real). */
  'conversation.recorded': { lineId: string };
  /** Nova rodada de distribuição sorteada para um processo. */
  'distribution.round': { campaignId: string; round: RoundSnapshot };
}

export type DomainEventName = keyof DomainEvents;

export class EventBus {
  private readonly emitter = new EventEmitter();
  private errorReporter: ((name: DomainEventName, error: unknown) => void) | null = null;

  /** Registra onde relatar falhas de ouvintes (ex.: log do sistema). */
  setErrorReporter(reporter: (name: DomainEventName, error: unknown) => void): void {
    this.errorReporter = reporter;
  }

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends DomainEventName>(name: K, payload: DomainEvents[K]): void {
    // Um ouvinte com defeito nunca pode derrubar quem emitiu o evento.
    for (const listener of this.emitter.listeners(name)) {
      try {
        (listener as (p: DomainEvents[K]) => void)(payload);
      } catch (error) {
        console.error(`[events] ouvinte de "${name}" falhou`, error);
        // Falhas ao tratar o próprio evento de log não voltam para o log (evita laço).
        if (name !== 'log.created') {
          try {
            this.errorReporter?.(name, error);
          } catch {
            /* o relato já foi para o console acima */
          }
        }
      }
    }
  }

  on<K extends DomainEventName>(name: K, listener: (payload: DomainEvents[K]) => void): () => void {
    this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
  }

  onAny(listener: <K extends DomainEventName>(name: K, payload: DomainEvents[K]) => void): () => void {
    const names: DomainEventName[] = ['line.updated', 'line.removed', 'campaign.updated', 'log.created', 'send.recorded', 'worker.updated', 'messages.updated', 'distribution.round', 'line.scheduled_pause', 'conversation.recorded'];
    const offs = names.map((name) => this.on(name, (payload) => listener(name, payload)));
    return () => offs.forEach((off) => off());
  }
}
