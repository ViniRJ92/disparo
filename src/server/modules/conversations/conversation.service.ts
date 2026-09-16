import type { Database } from '../../db/database.ts';
import { inClause } from '../../db/database.ts';
import type { EventBus } from '../../shared/events.ts';
import { newId, nowIso } from '../../shared/ids.ts';
import { personPhoneVariants } from '../contacts/phone.ts';
import type { LogService } from '../logs/log.service.ts';
import type { ProviderChatMessage } from '../providers/provider.types.ts';
import type { SettingsService } from '../settings/settings.service.ts';
import { normalizeSender, parseChatId, type ChatType } from './chat-id.ts';

export interface ConversationMessage {
  id: string;
  lineId: string | null;
  lineLabel: string | null;
  chatId: string;
  chatType: ChatType;
  groupName: string | null;
  personKey: string;
  personPhone: string | null;
  personName: string | null;
  contactId: string | null;
  direction: 'inbound' | 'outbound';
  body: string | null;
  providerMessageId: string;
  sentAt: string;
  createdAt: string;
}

/**
 * Registra as mensagens das conversas informadas pelo provedor de cada linha.
 * Cada linha é uma instância independente; a mesma mensagem (mesmo id do
 * provedor na mesma linha) nunca é gravada duas vezes. Grupos também são
 * registrados (marcados como grupo) para rastreabilidade; quem os exclui da
 * classificação individual é o Analytics.
 */
export class ConversationService {
  private readonly db: Database;
  private readonly settings: SettingsService;
  private readonly logs: LogService;
  private readonly events: EventBus;

  constructor(db: Database, events: EventBus, settings: SettingsService, logs: LogService) {
    this.db = db;
    this.settings = settings;
    this.logs = logs;
    this.events = events;
    events.on('conversation.message', ({ lineId, message }) => {
      this.record(lineId, message).catch((error) =>
        this.logs.write({ level: 'error', scope: 'conversation', lineId, message: `Falha ao registrar mensagem da conversa: ${String(error)}` }),
      );
    });
  }

  /** Grava a mensagem. Retorna false se ela já estava registrada. */
  async record(lineId: string, message: ProviderChatMessage): Promise<boolean> {
    const { defaultCountryCode } = await this.settings.get();
    const chat = parseChatId(message.chatId, defaultCountryCode, message.isGroup);
    // Grupo: a "pessoa" do registro é o participante (quando informado), mas o
    // registro fica marcado como grupo e não entra na classificação individual.
    const senderPhone = normalizeSender(message.senderId, defaultCountryCode);
    const personPhone = chat.type === 'individual' ? chat.phone : senderPhone;
    const personKey = chat.personKey ?? (senderPhone ?? `${chat.type}:${message.chatId}`);

    const line = this.db.get<{ label: string }>('SELECT label FROM lines WHERE id = :id', { id: lineId });
    // O contato pode estar cadastrado com ou sem o nono dígito.
    const phones = personPhone ? inClause(personPhoneVariants(personPhone)) : null;
    const contact = phones
      ? this.db.get<{ id: string }>(`SELECT id FROM contacts WHERE phone ${phones.sql} ORDER BY length(phone) DESC LIMIT 1`, phones.params)
      : undefined;

    const { changes } = this.db.run(
      `INSERT OR IGNORE INTO conversation_messages
         (id, line_id, line_label, chat_id, chat_type, group_name, person_key, person_phone, person_name, contact_id,
          direction, body, provider_message_id, sent_at, created_at)
       VALUES (:id, :lineId, :lineLabel, :chatId, :chatType, :groupName, :personKey, :personPhone, :personName, :contactId,
          :direction, :body, :providerMessageId, :sentAt, :createdAt)`,
      {
        id: newId(),
        lineId,
        lineLabel: line?.label ?? null,
        chatId: message.chatId,
        chatType: chat.type,
        groupName: chat.type === 'group' ? (message.chatName ?? null) : null,
        personKey,
        personPhone,
        personName: message.senderName ?? (chat.type === 'individual' ? (message.chatName ?? null) : null),
        contactId: contact?.id ?? null,
        direction: message.fromMe ? 'outbound' : 'inbound',
        body: message.body ?? null,
        providerMessageId: message.providerMessageId,
        sentAt: new Date(message.timestamp).toISOString(),
        createdAt: nowIso(),
      },
    );
    if (changes > 0) this.events.emit('conversation.recorded', { lineId });
    return changes > 0;
  }

  list(filter: { personKey?: string; lineId?: string; limit?: number } = {}): ConversationMessage[] {
    const where: string[] = [];
    const params: Record<string, string | number> = { limit: Math.min(filter.limit ?? 200, 5000) };
    if (filter.personKey) {
      where.push('person_key = :personKey');
      params.personKey = filter.personKey;
    }
    if (filter.lineId) {
      where.push('line_id = :lineId');
      params.lineId = filter.lineId;
    }
    return this.db
      .all<Record<string, unknown>>(
        `SELECT * FROM conversation_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY sent_at, rowid LIMIT :limit`,
        params,
      )
      .map((r) => ({
        id: r.id as string,
        lineId: r.line_id as string | null,
        lineLabel: r.line_label as string | null,
        chatId: r.chat_id as string,
        chatType: r.chat_type as ChatType,
        groupName: r.group_name as string | null,
        personKey: r.person_key as string,
        personPhone: r.person_phone as string | null,
        personName: r.person_name as string | null,
        contactId: r.contact_id as string | null,
        direction: r.direction as 'inbound' | 'outbound',
        body: r.body as string | null,
        providerMessageId: r.provider_message_id as string,
        sentAt: r.sent_at as string,
        createdAt: r.created_at as string,
      }));
  }
}
