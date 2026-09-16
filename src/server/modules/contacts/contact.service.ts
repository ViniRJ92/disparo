import { DomainError, notFound } from '../../shared/errors.ts';
import { newId, nowIso } from '../../shared/ids.ts';
import type { HistoryService } from '../history/history.service.ts';
import type { SendAttemptView } from '../history/history.types.ts';
import type { SendQueue } from '../queue/send-queue.ts';
import type { SettingsService } from '../settings/settings.service.ts';
import type { ContactRepository } from './contact.repository.ts';
import type {
  Contact,
  ContactAudience,
  ContactInput,
  ContactQuery,
  ContactsSummary,
  ContactView,
  CreateContactInput,
  ImportContactsResult,
  UpdateContactInput,
} from './contact.types.ts';
import { normalizePhone } from './phone.ts';

/**
 * Cada pessoa é um contato único, identificado pelo telefone normalizado.
 * O rastreamento (mensagens recebidas, última linha, status de processamento)
 * é mantido pelo histórico e pela fila, nunca editado manualmente.
 */
export class ContactService {
  private readonly repo: ContactRepository;
  private readonly settings: SettingsService;
  private readonly historyService: HistoryService;
  private readonly queue: SendQueue;

  constructor(repo: ContactRepository, settings: SettingsService, history: HistoryService, queue: SendQueue) {
    this.repo = repo;
    this.settings = settings;
    this.historyService = history;
    this.queue = queue;
  }

  list(query?: ContactQuery): Promise<ContactView[]> {
    return this.repo.list(query);
  }

  count(query?: Omit<ContactQuery, 'limit' | 'offset'>): Promise<number> {
    return this.repo.count(query);
  }

  summary(): Promise<ContactsSummary> {
    return this.repo.summary();
  }

  async get(id: string): Promise<ContactView> {
    const contact = await this.repo.findById(id);
    if (!contact) throw notFound('Contato', id);
    return contact;
  }

  existingIds(ids: readonly string[]): Promise<Set<string>> {
    return this.repo.existingIds(ids);
  }

  idsForAudience(audience: ContactAudience): Promise<string[]> {
    return this.repo.idsForAudience(audience);
  }

  blockedIds(ids: readonly string[]): Promise<Set<string>> {
    return this.repo.blockedIds(ids);
  }

  lastMessageId(contactId: string): Promise<string | null> {
    return this.repo.lastMessageId(contactId);
  }

  /** Histórico individual: cada envio com mensagem, linha, processo e horário. */
  history(id: string, options: { limit?: number; offset?: number } = {}): Promise<SendAttemptView[]> {
    return this.historyService.list({ contactId: id, ...options });
  }

  /** Inserção manual: telefone já cadastrado é recusado (sem duplicidade). */
  async create(input: CreateContactInput): Promise<ContactView> {
    const phone = await this.normalize(input.phone);
    const existing = await this.repo.findByPhone(phone);
    if (existing) {
      throw new DomainError('CONFLICT', `Contato já cadastrado com este número (${existing.name ?? existing.phone})`, {
        contactId: existing.id,
      });
    }
    const now = nowIso();
    const contact = blankContact({
      id: newId(),
      phone,
      name: input.name?.trim() || null,
      variables: input.variables ?? {},
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.repo.insert(contact);
    } catch (error) {
      // Outro cadastro do mesmo número aconteceu ao mesmo tempo: é duplicidade, não erro interno.
      if (/UNIQUE/i.test(String(error))) throw new DomainError('CONFLICT', 'Contato já cadastrado com este número');
      throw error;
    }
    return this.get(contact.id);
  }

  async update(id: string, input: UpdateContactInput): Promise<ContactView> {
    const current = await this.get(id);
    let phone = current.phone;
    if (input.phone !== undefined) {
      phone = await this.normalize(input.phone);
      const owner = await this.repo.findByPhone(phone);
      if (owner && owner.id !== id) {
        throw new DomainError('CONFLICT', `Número já pertence a outro contato (${owner.name ?? owner.phone})`, { contactId: owner.id });
      }
    }
    await this.repo.saveProfile({
      ...current,
      phone,
      name: input.name === undefined ? current.name : input.name?.trim() || null,
      variables: input.variables ?? current.variables,
      status: input.status ?? current.status,
      updatedAt: nowIso(),
    });
    if (input.status === 'blocked' && current.status !== 'blocked') {
      await this.queue.skipPendingForContact(id, 'Contato bloqueado');
    }
    return this.get(id);
  }

  /**
   * Importa contatos: normaliza, remove duplicados da própria lista e faz upsert
   * por telefone (quem já existe é atualizado, nunca duplicado).
   */
  async import(inputs: readonly ContactInput[]): Promise<ImportContactsResult> {
    const { defaultCountryCode } = await this.settings.get();
    const result: ImportContactsResult = { created: 0, updated: 0, invalid: [], contactIds: [] };
    const byPhone = new Map<string, ContactInput & { phone: string }>();

    for (const input of inputs) {
      const phone = normalizePhone(input.phone, defaultCountryCode);
      if (!phone) {
        result.invalid.push({ phone: input.phone, reason: 'Telefone inválido' });
        continue;
      }
      byPhone.set(phone, { ...input, phone });
    }

    const now = nowIso();
    const toSave: Contact[] = [];
    for (const input of byPhone.values()) {
      const existing = await this.repo.findByPhone(input.phone);
      if (existing) result.updated++;
      else result.created++;
      toSave.push(
        existing
          ? {
              ...existing,
              name: input.name?.trim() || existing.name,
              variables: { ...existing.variables, ...input.variables },
              updatedAt: now,
            }
          : blankContact({
              id: newId(),
              phone: input.phone,
              name: input.name?.trim() || null,
              variables: input.variables ?? {},
              status: 'active',
              createdAt: now,
              updatedAt: now,
            }),
      );
    }

    await this.repo.upsertMany(toSave);
    result.contactIds = toSave.map((contact) => contact.id);
    return result;
  }

  /** Exclui o contato e o seu histórico. Não é possível durante um envio para ele. */
  async remove(id: string): Promise<void> {
    await this.get(id);
    if (await this.repo.hasJobInProgress(id)) {
      throw new DomainError('INVALID_STATE', 'Há um envio em andamento para este contato; tente novamente em instantes');
    }
    await this.repo.delete(id);
  }

  private async normalize(raw: string): Promise<string> {
    const { defaultCountryCode } = await this.settings.get();
    const phone = normalizePhone(raw, defaultCountryCode);
    if (!phone) throw new DomainError('VALIDATION', `Telefone inválido: ${raw}`);
    return phone;
  }
}

function blankContact(base: Pick<Contact, 'id' | 'phone' | 'name' | 'variables' | 'status' | 'createdAt' | 'updatedAt'>): Contact {
  return {
    ...base,
    processingStatus: 'idle',
    messagesReceived: 0,
    lastMessageTemplateId: null,
    lastMessageLabel: null,
    lastLineId: null,
    lastSentAt: null,
    lastError: null,
  };
}
