import type { Database } from '../../db/database.ts';
import { fromJson, toJson } from '../../db/database.ts';
import { DEFAULT_APP_SETTINGS } from '../settings/settings.schema.ts';
import type { Line } from './line.types.ts';

interface LineRow {
  id: string;
  label: string;
  provider: string;
  provider_config: string;
  account_id: string | null;
  display_name: string | null;
  connection_status: Line['connectionStatus'];
  operational_status: Line['operationalStatus'];
  run_state: Line['runState'];
  pause_reason: Line['pauseReason'];
  scheduled_pause_count: number;
  scheduled_pause_pending: number;
  connected_at: string | null;
  last_error: string | null;
  settings: string;
  contacts_processed: number;
  messages_sent: number;
  failures: number;
  last_contact_id: string | null;
  last_contact_name: string | null;
  last_contact_phone: string | null;
  last_message_label: string | null;
  last_attempt_at: string | null;
  last_attempt_result: 'sent' | 'failed' | null;
  last_sent_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

type TrackingRow = Pick<
  LineRow,
  | 'contacts_processed'
  | 'messages_sent'
  | 'failures'
  | 'scheduled_pause_count'
  | 'last_contact_id'
  | 'last_contact_name'
  | 'last_contact_phone'
  | 'last_message_label'
  | 'last_attempt_at'
  | 'last_attempt_result'
  | 'last_sent_at'
>;

const toActivity = (row: TrackingRow): Line['activity'] => ({
  lastContactId: row.last_contact_id,
  lastContactName: row.last_contact_name,
  lastContactPhone: row.last_contact_phone,
  lastMessageLabel: row.last_message_label,
  lastAttemptAt: row.last_attempt_at,
  lastAttemptResult: row.last_attempt_result,
  lastSentAt: row.last_sent_at,
});

const toLine = (row: LineRow): Line => ({
  id: row.id,
  label: row.label,
  provider: row.provider,
  providerConfig: fromJson(row.provider_config, {}),
  accountId: row.account_id,
  displayName: row.display_name,
  connectionStatus: row.connection_status,
  operationalStatus: row.operational_status,
  runState: row.run_state,
  pauseReason: row.pause_reason,
  scheduledPauseCount: row.scheduled_pause_count,
  scheduledPausePending: row.scheduled_pause_pending === 1,
  connectedAt: row.connected_at,
  lastError: row.last_error,
  settings: { ...DEFAULT_APP_SETTINGS.defaultLineSettings, ...fromJson(row.settings, {}) },
  counters: {
    contactsProcessed: row.contacts_processed,
    messagesSent: row.messages_sent,
    failures: row.failures,
  },
  activity: toActivity(row),
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toParams = (line: Line) => ({
  id: line.id,
  label: line.label,
  provider: line.provider,
  providerConfig: toJson(line.providerConfig),
  accountId: line.accountId,
  displayName: line.displayName,
  connectionStatus: line.connectionStatus,
  operationalStatus: line.operationalStatus,
  runState: line.runState,
  pauseReason: line.pauseReason,
  scheduledPausePending: line.scheduledPausePending ? 1 : 0,
  connectedAt: line.connectedAt,
  lastError: line.lastError,
  settings: toJson(line.settings),
  position: line.position,
  createdAt: line.createdAt,
  updatedAt: line.updatedAt,
});

/**
 * Persistência das linhas. Contadores e última atividade NÃO são gravados por
 * save(): só o histórico os atualiza, de forma atômica.
 */
export class LineRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async findAll(): Promise<Line[]> {
    return this.db.all<LineRow>('SELECT * FROM lines ORDER BY position, created_at').map(toLine);
  }

  async findById(id: string): Promise<Line | null> {
    const row = this.db.get<LineRow>('SELECT * FROM lines WHERE id = :id', { id });
    return row ? toLine(row) : null;
  }

  async count(): Promise<number> {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM lines')?.n ?? 0;
  }

  async nextPosition(): Promise<number> {
    return (this.db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM lines')?.p ?? -1) + 1;
  }

  async insert(line: Line): Promise<void> {
    this.db.run(
      `INSERT INTO lines (id, label, provider, provider_config, account_id, display_name, connection_status,
         operational_status, run_state, pause_reason, scheduled_pause_pending, connected_at, last_error, settings, position, created_at, updated_at)
       VALUES (:id, :label, :provider, :providerConfig, :accountId, :displayName, :connectionStatus,
         :operationalStatus, :runState, :pauseReason, :scheduledPausePending, :connectedAt, :lastError, :settings, :position, :createdAt, :updatedAt)`,
      toParams(line),
    );
  }

  async save(line: Line): Promise<void> {
    const { createdAt: _createdAt, ...params } = toParams(line);
    this.db.run(
      `UPDATE lines SET label = :label, provider = :provider, provider_config = :providerConfig,
         account_id = :accountId, display_name = :displayName, connection_status = :connectionStatus,
         operational_status = :operationalStatus, run_state = :runState, pause_reason = :pauseReason,
         scheduled_pause_pending = :scheduledPausePending, connected_at = :connectedAt,
         last_error = :lastError, settings = :settings, position = :position, updated_at = :updatedAt
       WHERE id = :id`,
      params,
    );
  }

  /** Relê contadores e última atividade (atualizados pelo histórico). */
  async readTracking(id: string): Promise<Pick<Line, 'counters' | 'activity' | 'scheduledPauseCount'> | null> {
    const row = this.db.get<TrackingRow>(
      `SELECT contacts_processed, messages_sent, failures, scheduled_pause_count, last_contact_id, last_contact_name, last_contact_phone,
         last_message_label, last_attempt_at, last_attempt_result, last_sent_at
       FROM lines WHERE id = :id`,
      { id },
    );
    return row
      ? {
          counters: { contactsProcessed: row.contacts_processed, messagesSent: row.messages_sent, failures: row.failures },
          activity: toActivity(row),
          scheduledPauseCount: row.scheduled_pause_count,
        }
      : null;
  }

  /** Zera o contador da pausa programada (de uma linha ou de todas). */
  async resetScheduledPauseCount(id?: string): Promise<void> {
    this.db.run(`UPDATE lines SET scheduled_pause_count = 0 ${id ? 'WHERE id = :id' : ''}`, id ? { id } : {});
  }

  async delete(id: string): Promise<void> {
    this.db.run('DELETE FROM lines WHERE id = :id', { id });
  }
}
