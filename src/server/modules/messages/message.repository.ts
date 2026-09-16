import type { Database } from '../../db/database.ts';
import type { MessageTemplate } from './message.types.ts';

interface MessageRow {
  id: string;
  slot: number;
  name: string;
  body: string;
  active: number;
  created_at: string;
  updated_at: string;
}

const toMessage = (row: MessageRow): MessageTemplate => ({
  id: row.id,
  slot: row.slot,
  name: row.name,
  body: row.body,
  active: row.active === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toParams = (message: MessageTemplate) => ({ ...message, active: message.active ? 1 : 0 });

/** Mensagens sem posição (legado acima de 5) são ignoradas em todas as consultas. */
export class MessageRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async list(): Promise<MessageTemplate[]> {
    return this.db.all<MessageRow>('SELECT * FROM message_templates WHERE slot IS NOT NULL ORDER BY slot').map(toMessage);
  }

  async listActive(): Promise<MessageTemplate[]> {
    return this.db
      .all<MessageRow>('SELECT * FROM message_templates WHERE slot IS NOT NULL AND active = 1 ORDER BY slot')
      .map(toMessage);
  }

  async findById(id: string): Promise<MessageTemplate | null> {
    const row = this.db.get<MessageRow>('SELECT * FROM message_templates WHERE id = :id AND slot IS NOT NULL', { id });
    return row ? toMessage(row) : null;
  }

  async findBySlot(slot: number): Promise<MessageTemplate | null> {
    const row = this.db.get<MessageRow>('SELECT * FROM message_templates WHERE slot = :slot', { slot });
    return row ? toMessage(row) : null;
  }

  async insert(message: MessageTemplate): Promise<void> {
    this.db.run(
      `INSERT INTO message_templates (id, slot, name, body, active, created_at, updated_at)
       VALUES (:id, :slot, :name, :body, :active, :createdAt, :updatedAt)`,
      toParams(message),
    );
  }

  async save(message: MessageTemplate): Promise<void> {
    const { createdAt: _createdAt, ...params } = toParams(message);
    this.db.run(
      `UPDATE message_templates SET slot = :slot, name = :name, body = :body, active = :active, updated_at = :updatedAt
       WHERE id = :id`,
      params,
    );
  }

  async delete(id: string): Promise<boolean> {
    return this.db.run('DELETE FROM message_templates WHERE id = :id', { id }).changes > 0;
  }
}
