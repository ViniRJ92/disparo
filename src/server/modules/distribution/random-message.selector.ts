import type { ContactService } from '../contacts/contact.service.ts';
import type { MessageService } from '../messages/message.service.ts';
import type { MessageTemplate } from '../messages/message.types.ts';
import type { MessageSelectionContext, MessageSelector } from './distribution.types.ts';

/**
 * Sorteia uma mensagem ATIVA para o contato, sem repetir a última mensagem
 * que ESTE contato recebeu.
 *
 * - 2+ ativas: a última recebida pelo contato sai do sorteio.
 * - 1 ativa: é usada normalmente (não há alternativa; não é erro).
 * - 0 ativas: null (o worker devolve o contato à fila e aguarda).
 */
export class RandomMessageSelector implements MessageSelector {
  private readonly messages: MessageService;
  private readonly contacts: ContactService;
  private readonly random: () => number;

  constructor(messages: MessageService, contacts: ContactService, random: () => number = Math.random) {
    this.messages = messages;
    this.contacts = contacts;
    this.random = random;
  }

  async select({ contactId }: MessageSelectionContext): Promise<MessageTemplate | null> {
    const active = await this.messages.listActive();
    if (active.length === 0) return null;
    if (active.length === 1) return active[0]!;

    const lastId = await this.contacts.lastMessageId(contactId);
    const pool = active.filter((message) => message.id !== lastId);
    return pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))]!;
  }
}
