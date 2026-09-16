import type { Database, SqlParams } from '../../db/database.ts';
import type { ContactProcessingSync } from '../contacts/contact-processing.sync.ts';
import { newId, nowIso } from '../../shared/ids.ts';
import type { PendingCounter } from '../lines/line.types.ts';
import { emptyJobCounts, type JobCounts, type JobStatus, type SendJob } from './queue.types.ts';

interface JobRow {
  id: string;
  campaign_id: string;
  contact_id: string;
  line_id: string | null;
  message_template_id: string | null;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}

const toJob = (row: JobRow): SendJob => ({
  id: row.id,
  campaignId: row.campaign_id,
  contactId: row.contact_id,
  lineId: row.line_id,
  messageTemplateId: row.message_template_id,
  status: row.status,
  attempts: row.attempts,
  lastError: row.last_error,
  providerMessageId: row.provider_message_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  processedAt: row.processed_at,
});

/**
 * Fila persistente de envios (tabela send_jobs).
 *
 * Oferece apenas as primitivas da fila: enfileirar, reservar o próximo job
 * para uma linha, contar e recuperar jobs travados. QUAL linha e QUAL mensagem
 * usar é decisão da estratégia de distribuição (próximo módulo).
 */
export class SendQueue implements PendingCounter {
  private readonly db: Database;
  private readonly contactSync: ContactProcessingSync;

  constructor(db: Database, contactSync: ContactProcessingSync) {
    this.db = db;
    this.contactSync = contactSync;
  }

  /** Enfileira contatos numa campanha. Contatos já presentes são ignorados. */
  async enqueue(campaignId: string, contactIds: readonly string[]): Promise<number> {
    const now = nowIso();
    return this.db.transaction(() => {
      let added = 0;
      for (const contactId of new Set(contactIds)) {
        added += this.db.run(
          `INSERT OR IGNORE INTO send_jobs (id, campaign_id, contact_id, status, created_at, updated_at)
           VALUES (:id, :campaignId, :contactId, 'pending', :now, :now)`,
          { id: newId(), campaignId, contactId, now },
        ).changes;
      }
      this.contactSync.contacts(contactIds);
      return added;
    });
  }

  /**
   * Reserva atomicamente o próximo job pendente da campanha para a linha informada.
   * A mensagem é escolhida depois, por contato (ver MessageSelector).
   * Retorna null quando não há pendentes.
   */
  async claimNext(campaignId: string, lineId: string): Promise<SendJob | null> {
    return this.db.transaction(() => {
      const row = this.db.get<JobRow>(
        `SELECT * FROM send_jobs j WHERE j.campaign_id = :campaignId AND j.status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM send_jobs p WHERE p.contact_id = j.contact_id AND p.status = 'processing')
         ORDER BY j.created_at, j.rowid LIMIT 1`,
        { campaignId },
      );
      if (!row) return null;
      this.db.run(
        `UPDATE send_jobs SET status = 'processing', line_id = :lineId, updated_at = :now WHERE id = :id`,
        { id: row.id, lineId, now: nowIso() },
      );
      this.contactSync.contacts([row.contact_id]);
      return toJob({ ...row, status: 'processing', line_id: lineId });
    });
  }

  /** Devolve um job reservado para a fila sem contar tentativa (nada foi enviado). */
  async release(jobId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.run(
        `UPDATE send_jobs SET status = 'pending', line_id = NULL, updated_at = :now
         WHERE id = :id AND status = 'processing'`,
        { id: jobId, now: nowIso() },
      );
      this.syncJobContact(jobId);
    });
  }

  /** Finaliza um job sem envio (ex.: contato bloqueado depois de entrar na fila). */
  async skip(jobId: string, reason: string): Promise<void> {
    this.db.transaction(() => {
      const now = nowIso();
      this.db.run(
        `UPDATE send_jobs SET status = 'skipped', last_error = :reason, processed_at = :now, updated_at = :now
         WHERE id = :id AND status IN ('pending', 'processing')`,
        { id: jobId, reason, now },
      );
      this.syncJobContact(jobId);
    });
  }

  /**
   * Encerramento de processo: todo contato ainda não iniciado vira "skipped" com o
   * motivo. Envios já em curso terminam normalmente e são registrados.
   */
  async skipPendingForCampaign(campaignId: string, reason: string): Promise<number> {
    return this.db.transaction(() => {
      const now = nowIso();
      const { changes } = this.db.run(
        `UPDATE send_jobs SET status = 'skipped', last_error = :reason, processed_at = :now, updated_at = :now
         WHERE campaign_id = :campaignId AND status = 'pending'`,
        { campaignId, reason, now },
      );
      this.contactSync.campaign(campaignId);
      return changes;
    });
  }

  /** Retira da fila todos os envios ainda não iniciados de um contato. */
  async skipPendingForContact(contactId: string, reason: string): Promise<number> {
    return this.db.transaction(() => {
      const now = nowIso();
      const { changes } = this.db.run(
        `UPDATE send_jobs SET status = 'skipped', last_error = :reason, processed_at = :now, updated_at = :now
         WHERE contact_id = :contactId AND status = 'pending'`,
        { contactId, reason, now },
      );
      this.contactSync.contacts([contactId]);
      return changes;
    });
  }

  /** Devolve à fila jobs que ficaram "processing" (ex.: app fechado no meio do envio). */
  async releaseStuck(): Promise<number> {
    return this.db.transaction(() => {
      const { changes } = this.db.run(
        `UPDATE send_jobs SET status = 'pending', line_id = NULL, updated_at = :now WHERE status = 'processing'`,
        { now: nowIso() },
      );
      if (changes > 0) this.contactSync.all();
      return changes;
    });
  }

  async findById(id: string): Promise<SendJob | null> {
    const row = this.db.get<JobRow>('SELECT * FROM send_jobs WHERE id = :id', { id });
    return row ? toJob(row) : null;
  }

  async list(filter: { campaignId: string; status?: JobStatus; limit?: number; offset?: number }): Promise<SendJob[]> {
    const params: SqlParams = {
      campaignId: filter.campaignId,
      limit: filter.limit ?? 100,
      offset: filter.offset ?? 0,
    };
    if (filter.status) params.status = filter.status;
    return this.db
      .all<JobRow>(
        `SELECT * FROM send_jobs WHERE campaign_id = :campaignId ${filter.status ? 'AND status = :status' : ''}
         ORDER BY created_at, rowid LIMIT :limit OFFSET :offset`,
        params,
      )
      .map(toJob);
  }

  /** Contagens por campanha (ou de todas as campanhas quando campaignId é omitido). */
  async counts(campaignId?: string): Promise<JobCounts> {
    const rows = this.db.all<{ status: JobStatus; n: number }>(
      `SELECT status, COUNT(*) AS n FROM send_jobs ${campaignId ? 'WHERE campaign_id = :campaignId' : ''} GROUP BY status`,
      campaignId ? { campaignId } : {},
    );
    return foldCounts(rows);
  }

  async countsByCampaign(): Promise<Map<string, JobCounts>> {
    return this.groupedCounts('SELECT campaign_id AS k, status, COUNT(*) AS n FROM send_jobs GROUP BY campaign_id, status');
  }

  /** Contagens por linha dentro de uma campanha (ou de todas, se omitida). */
  async countsByLine(campaignId?: string): Promise<Map<string, JobCounts>> {
    return this.groupedCounts(
      `SELECT line_id AS k, status, COUNT(*) AS n FROM send_jobs
       WHERE line_id IS NOT NULL ${campaignId ? 'AND campaign_id = :campaignId' : ''} GROUP BY line_id, status`,
      campaignId ? { campaignId } : {},
    );
  }

  /**
   * Pendentes por linha: contatos ainda não enviados dos processos em andamento
   * ou pausados em que a linha está selecionada (fila compartilhada), mais o
   * envio que a própria linha tem em curso.
   */
  async pendingByLine(): Promise<Map<string, number>> {
    const rows = this.db.all<{ line_id: string; n: number }>(
      `SELECT cl.line_id, COUNT(*) AS n
       FROM campaign_lines cl
       JOIN campaigns c ON c.id = cl.campaign_id AND c.status IN ('running', 'paused')
       JOIN send_jobs j ON j.campaign_id = cl.campaign_id
         AND (j.status = 'pending' OR (j.status = 'processing' AND j.line_id = cl.line_id))
       GROUP BY cl.line_id`,
    );
    return new Map(rows.map((row) => [row.line_id, row.n]));
  }

  private syncJobContact(jobId: string): void {
    const row = this.db.get<{ contact_id: string }>('SELECT contact_id FROM send_jobs WHERE id = :id', { id: jobId });
    if (row) this.contactSync.contacts([row.contact_id]);
  }

  private groupedCounts(sql: string, params: SqlParams = {}): Map<string, JobCounts> {
    const grouped = new Map<string, { status: JobStatus; n: number }[]>();
    for (const row of this.db.all<{ k: string; status: JobStatus; n: number }>(sql, params)) {
      const list = grouped.get(row.k) ?? [];
      list.push(row);
      grouped.set(row.k, list);
    }
    return new Map([...grouped].map(([key, rows]) => [key, foldCounts(rows)]));
  }
}

function foldCounts(rows: readonly { status: JobStatus; n: number }[]): JobCounts {
  const counts = emptyJobCounts();
  for (const { status, n } of rows) {
    counts[status] += n;
    counts.total += n;
  }
  counts.processed = counts.sent + counts.failed + counts.skipped;
  return counts;
}
