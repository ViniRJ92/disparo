import type { Database, SqlParams } from '../../db/database.ts';
import { fromJson, toJson } from '../../db/database.ts';
import type { EventBus } from '../../shared/events.ts';
import { newId, nowIso } from '../../shared/ids.ts';
import type { LogEntry, LogInput, LogQuery } from './log.types.ts';

interface LogRow {
  id: string;
  level: LogEntry['level'];
  scope: string;
  message: string;
  line_id: string | null;
  campaign_id: string | null;
  data: string;
  created_at: string;
}

const toEntry = (row: LogRow): LogEntry => ({
  id: row.id,
  level: row.level,
  scope: row.scope,
  message: row.message,
  lineId: row.line_id,
  campaignId: row.campaign_id,
  data: fromJson(row.data, {}),
  createdAt: row.created_at,
});

/** Logs operacionais persistidos. Falhar ao registrar log nunca interrompe a operação. */
export class LogService {
  private readonly db: Database;
  private readonly events: EventBus;

  constructor(db: Database, events: EventBus) {
    this.db = db;
    this.events = events;
  }

  write(input: LogInput): void {
    const entry: LogEntry = {
      id: newId(),
      level: input.level,
      scope: input.scope,
      message: input.message,
      lineId: input.lineId ?? null,
      campaignId: input.campaignId ?? null,
      data: input.data ?? {},
      createdAt: nowIso(),
    };
    try {
      this.db.run(
        `INSERT INTO logs (id, level, scope, message, line_id, campaign_id, data, created_at)
         VALUES (:id, :level, :scope, :message, :lineId, :campaignId, :data, :createdAt)`,
        { ...entry, data: toJson(entry.data) },
      );
      this.events.emit('log.created', entry);
    } catch (error) {
      console.error('[logs] falha ao gravar log', error, entry);
    }
  }

  async list(query: LogQuery = {}): Promise<LogEntry[]> {
    const where: string[] = [];
    const params: SqlParams = { limit: Math.min(query.limit ?? 100, 1000) };
    if (query.lineId) {
      where.push('line_id = :lineId');
      params.lineId = query.lineId;
    }
    if (query.campaignId) {
      where.push('campaign_id = :campaignId');
      params.campaignId = query.campaignId;
    }
    if (query.level) {
      where.push('level = :level');
      params.level = query.level;
    }
    const sql = `SELECT * FROM logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT :limit`;
    return this.db.all<LogRow>(sql, params).map(toEntry);
  }
}
