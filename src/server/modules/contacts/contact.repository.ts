import type { Database, SqlParams } from '../../db/database.ts';
import { fromJson, inClause, toJson } from '../../db/database.ts';
import { CONTACT_DISPLAY_STATUS_SQL } from './contact-processing.sync.ts';
import type {
  Contact,
  ContactAudience,
  ContactProcessingStatus,
  ContactQuery,
  ContactsSummary,
  ContactStatus,
  ContactView,
} from './contact.types.ts';

interface ContactRow {
  id: string;
  phone: string;
  name: string | null;
  variables: string;
  status: ContactStatus;
  processing_status: ContactProcessingStatus;
  messages_received: number;
  last_message_template_id: string | null;
  last_message_label: string | null;
  last_line_id: string | null;
  last_sent_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  last_line_label?: string | null;
  display_status?: ContactProcessingStatus;
}

const toContact = (row: ContactRow): Contact => ({
  id: row.id,
  phone: row.phone,
  name: row.name,
  variables: fromJson(row.variables, {}),
  status: row.status,
  processingStatus: row.display_status ?? row.processing_status,
  messagesReceived: row.messages_received,
  lastMessageTemplateId: row.last_message_template_id,
  lastMessageLabel: row.last_message_label,
  lastLineId: row.last_line_id,
  lastSentAt: row.last_sent_at,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toView = (row: ContactRow): ContactView => ({ ...toContact(row), lastLineLabel: row.last_line_label ?? null });

const VIEW_SELECT = `SELECT c.*, ${CONTACT_DISPLAY_STATUS_SQL} AS display_status, l.label AS last_line_label
  FROM contacts c LEFT JOIN lines l ON l.id = c.last_line_id`;

export class ContactRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async list(query: ContactQuery = {}): Promise<ContactView[]> {
    const { where, params } = this.filters(query);
    return this.db
      .all<ContactRow>(`${VIEW_SELECT} ${where} ORDER BY c.created_at DESC, c.rowid DESC LIMIT :limit OFFSET :offset`, {
        ...params,
        limit: Math.min(query.limit ?? 100, 1000),
        offset: query.offset ?? 0,
      })
      .map(toView);
  }

  async count(query: Omit<ContactQuery, 'limit' | 'offset'> = {}): Promise<number> {
    const { where, params } = this.filters(query);
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c ${where}`, params)?.n ?? 0;
  }

  async summary(): Promise<ContactsSummary> {
    const byProcessing: ContactsSummary['byProcessing'] = { idle: 0, pending: 0, waiting: 0, processing: 0, sent: 0, failed: 0 };
    for (const row of this.db.all<{ s: ContactProcessingStatus; n: number }>(
      `SELECT ${CONTACT_DISPLAY_STATUS_SQL} AS s, COUNT(*) AS n FROM contacts c GROUP BY s`,
    )) {
      byProcessing[row.s] = row.n;
    }
    const byStatus = new Map(
      this.db.all<{ s: ContactStatus; n: number }>('SELECT status AS s, COUNT(*) AS n FROM contacts GROUP BY status').map((r) => [r.s, r.n]),
    );
    const active = byStatus.get('active') ?? 0;
    const blocked = byStatus.get('blocked') ?? 0;
    return { total: active + blocked, active, blocked, byProcessing };
  }

  async findById(id: string): Promise<ContactView | null> {
    const row = this.db.get<ContactRow>(`${VIEW_SELECT} WHERE c.id = :id`, { id });
    return row ? toView(row) : null;
  }

  async findByPhone(phone: string): Promise<Contact | null> {
    const row = this.db.get<ContactRow>('SELECT * FROM contacts WHERE phone = :phone', { phone });
    return row ? toContact(row) : null;
  }

  async findByPhones(phones: readonly string[]): Promise<{ id: string; phone: string; status: ContactStatus }[]> {
    const { sql, params } = inClause(phones);
    return this.db.all<{ id: string; phone: string; status: ContactStatus }>(`SELECT id, phone, status FROM contacts WHERE phone ${sql}`, params);
  }

  async existingIds(ids: readonly string[]): Promise<Set<string>> {
    const { sql, params } = inClause(ids);
    const rows = this.db.all<{ id: string }>(`SELECT id FROM contacts WHERE id ${sql}`, params);
    return new Set(rows.map((row) => row.id));
  }

  async idsForAudience(audience: ContactAudience): Promise<string[]> {
    return this.db
      .all<{ id: string }>(
        `SELECT id FROM contacts WHERE status = 'active' ${audience === 'never_received' ? 'AND messages_received = 0' : ''}
         ORDER BY created_at, rowid`,
      )
      .map((row) => row.id);
  }

  async blockedIds(ids: readonly string[]): Promise<Set<string>> {
    const { sql, params } = inClause(ids);
    const rows = this.db.all<{ id: string }>(`SELECT id FROM contacts WHERE status = 'blocked' AND id ${sql}`, params);
    return new Set(rows.map((row) => row.id));
  }

  async insert(contact: Contact): Promise<void> {
    this.db.run(
      `INSERT INTO contacts (id, phone, name, variables, status, created_at, updated_at)
       VALUES (:id, :phone, :name, :variables, :status, :createdAt, :updatedAt)`,
      {
        id: contact.id,
        phone: contact.phone,
        name: contact.name,
        variables: toJson(contact.variables),
        status: contact.status,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
      },
    );
  }

  /** Atualiza apenas dados cadastrais; o rastreamento de envios é do histórico. */
  async saveProfile(contact: Contact): Promise<void> {
    this.db.run(
      `UPDATE contacts SET phone = :phone, name = :name, variables = :variables, status = :status, updated_at = :updatedAt
       WHERE id = :id`,
      {
        id: contact.id,
        phone: contact.phone,
        name: contact.name,
        variables: toJson(contact.variables),
        status: contact.status,
        updatedAt: contact.updatedAt,
      },
    );
  }

  /** Insere ou atualiza vários contatos numa única transação (dedup por telefone). */
  async upsertMany(contacts: readonly Contact[]): Promise<void> {
    this.db.transaction(() => {
      for (const contact of contacts) {
        this.db.run(
          `INSERT INTO contacts (id, phone, name, variables, created_at, updated_at)
           VALUES (:id, :phone, :name, :variables, :createdAt, :updatedAt)
           ON CONFLICT(phone) DO UPDATE SET
             name = COALESCE(excluded.name, contacts.name),
             variables = excluded.variables,
             updated_at = excluded.updated_at`,
          {
            id: contact.id,
            phone: contact.phone,
            name: contact.name,
            variables: toJson(contact.variables),
            createdAt: contact.createdAt,
            updatedAt: contact.updatedAt,
          },
        );
      }
    });
  }

  async lastMessageId(contactId: string): Promise<string | null> {
    return (
      this.db.get<{ id: string | null }>('SELECT last_message_template_id AS id FROM contacts WHERE id = :contactId', { contactId })?.id ?? null
    );
  }

  async hasJobInProgress(id: string): Promise<boolean> {
    return !!this.db.get("SELECT 1 FROM send_jobs WHERE contact_id = :id AND status = 'processing' LIMIT 1", { id });
  }

  async delete(id: string): Promise<boolean> {
    return this.db.run('DELETE FROM contacts WHERE id = :id', { id }).changes > 0;
  }

  private filters(query: Omit<ContactQuery, 'limit' | 'offset'>): { where: string; params: SqlParams } {
    const clauses: string[] = [];
    const params: SqlParams = {};
    const search = query.search?.trim();
    if (search) {
      const digits = search.replace(/\D/g, '');
      clauses.push(digits ? '(c.name LIKE :search OR c.phone LIKE :digits)' : 'c.name LIKE :search');
      params.search = `%${search}%`;
      if (digits) params.digits = `%${digits}%`;
    }
    if (query.status) {
      clauses.push('c.status = :status');
      params.status = query.status;
    }
    if (query.processingStatus) {
      clauses.push(`(${CONTACT_DISPLAY_STATUS_SQL}) = :processingStatus`);
      params.processingStatus = query.processingStatus;
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }
}
