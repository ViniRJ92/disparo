import { DomainError, notFound } from '../../shared/errors.ts';
import type { EventBus } from '../../shared/events.ts';
import { newId, nowIso } from '../../shared/ids.ts';
import type { MessageRepository } from './message.repository.ts';
import {
  defaultMessageName,
  MAX_MESSAGE_SLOTS,
  type MessageSlot,
  type MessageTemplate,
  type SaveMessageInput,
} from './message.types.ts';

/**
 * Gerencia as até 5 mensagens do sistema. Editar uma mensagem só afeta os
 * PRÓXIMOS envios: o histórico guarda o texto efetivamente enviado.
 */
export class MessageService {
  private readonly repo: MessageRepository;
  private readonly events: EventBus;

  constructor(repo: MessageRepository, events: EventBus) {
    this.repo = repo;
    this.events = events;
  }

  list(): Promise<MessageTemplate[]> {
    return this.repo.list();
  }

  listActive(): Promise<MessageTemplate[]> {
    return this.repo.listActive();
  }

  /** As 5 posições, na ordem, ocupadas ou livres. */
  async slots(): Promise<MessageSlot[]> {
    const bySlot = new Map((await this.repo.list()).map((message) => [message.slot, message]));
    return Array.from({ length: MAX_MESSAGE_SLOTS }, (_, i) => ({ slot: i + 1, message: bySlot.get(i + 1) ?? null }));
  }

  async get(id: string): Promise<MessageTemplate> {
    const message = await this.repo.findById(id);
    if (!message) throw notFound('Mensagem', id);
    return message;
  }

  /** Cria na primeira posição livre. */
  async create(input: SaveMessageInput): Promise<MessageTemplate> {
    const free = (await this.slots()).find((slot) => slot.message === null);
    if (!free) throw new DomainError('LIMIT_EXCEEDED', `Limite de ${MAX_MESSAGE_SLOTS} mensagens atingido`);
    return this.saveSlot(free.slot, input);
  }

  /** Salva (cria ou edita) a mensagem de uma posição específica. */
  async saveSlot(slot: number, input: SaveMessageInput): Promise<MessageTemplate> {
    assertSlot(slot);
    const body = validateBody(input.body);
    const existing = await this.repo.findBySlot(slot);
    const now = nowIso();

    if (existing) {
      const next: MessageTemplate = {
        ...existing,
        body,
        name: input.name?.trim() || existing.name,
        active: input.active ?? existing.active,
        updatedAt: now,
      };
      await this.repo.save(next);
      await this.notify();
      return next;
    }

    const message: MessageTemplate = {
      id: newId(),
      slot,
      name: input.name?.trim() || defaultMessageName(slot),
      body,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insert(message);
    await this.notify();
    return message;
  }

  async update(id: string, input: Partial<SaveMessageInput>): Promise<MessageTemplate> {
    const current = await this.get(id);
    return this.saveSlot(current.slot, { body: input.body ?? current.body, name: input.name, active: input.active });
  }

  async setActive(id: string, active: boolean): Promise<MessageTemplate> {
    const current = await this.get(id);
    const next = { ...current, active, updatedAt: nowIso() };
    await this.repo.save(next);
    await this.notify();
    return next;
  }

  /** Libera a posição. O histórico mantém o texto e o rótulo enviados. */
  async remove(id: string): Promise<void> {
    if (!(await this.repo.delete(id))) throw notFound('Mensagem', id);
    await this.notify();
  }

  private async notify(): Promise<void> {
    this.events.emit('messages.updated', { activeCount: (await this.repo.listActive()).length });
  }
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_MESSAGE_SLOTS) {
    throw new DomainError('VALIDATION', `Posição inválida: use de 1 a ${MAX_MESSAGE_SLOTS}`);
  }
}

function validateBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new DomainError('VALIDATION', 'Informe o texto da mensagem');
  if (trimmed.length > 4096) throw new DomainError('VALIDATION', 'Mensagem muito longa (máximo 4096 caracteres)');
  return trimmed;
}
