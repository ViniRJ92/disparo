import type { Database, SqlParams } from '../../db/database.ts';
import { DomainError, notFound } from '../../shared/errors.ts';
import type { EventBus } from '../../shared/events.ts';
import type { ContactProcessingSync } from '../contacts/contact-processing.sync.ts';
import { newId, nowIso } from '../../shared/ids.ts';
import type { HistoryQuery, RecordAttemptInput, SendAttempt, SendAttemptView } from './history.types.ts';

interface AttemptRow {
  id: string;
  job_id: string;
  campaign_id: string;
  contact_id: string;
  line_id: string | null;
  message_template_id: string | null;
  message_label: string | null;
  rendered_body: string | null;
  result: SendAttempt['result'];
  error: string | null;
  provider_message_id: string | null;
  cycle_number: number | null;
  cycle_interval_seconds: number | null;
  line_label: string | null;
  requeued: number;
  created_at: string;
  contact_phone: string;
  contact_name: string | null;
  current_line_label: string | null;
  campaign_name: string;
}

const toView = (row: AttemptRow): SendAttemptView => ({
  id: row.id,
  jobId: row.job_id,
  campaignId: row.campaign_id,
  contactId: row.contact_id,
  lineId: row.line_id,
  messageTemplateId: row.message_template_id,
  messageLabel: row.message_label,
  renderedBody: row.rendered_body,
  result: row.result,
  error: row.error,
  providerMessageId: row.provider_message_id,
  cycleNumber: row.cycle_number,
  cycleIntervalSeconds: row.cycle_interval_seconds,
  lineLabelAtSend: row.line_label,
  requeued: row.requeued === 1,
  createdAt: row.created_at,
  contactPhone: row.contact_phone,
  contactName: row.contact_name,
  lineLabel: row.current_line_label,
  campaignName: row.campaign_name,
});

/**
 * Histórico de envios. recordAttempt() é o ÚNICO ponto que grava o resultado
 * de um envio: numa só transação registra a tentativa, atualiza o job da fila,
 * incrementa os contadores da linha e atualiza o rastreamento do contato. Assim histórico, fila e estatísticas
 * nunca divergem.
 */
export class HistoryService {
  private readonly db: Database;
  private readonly events: EventBus;
  private readonly contactSync: ContactProcessingSync;

  constructor(db: Database, events: EventBus, contactSync: ContactProcessingSync) {
    this.db = db;
    this.events = events;
    this.contactSync = contactSync;
  }

  async recordAttempt(input: RecordAttemptInput): Promise<SendAttempt> {
    const requeue = input.result === 'failed' && input.requeue === true;
    const now = nowIso();

    const attempt = this.db.transaction(() => {
      const job = this.db.get<{ campaign_id: string; contact_id: string; status: string }>(
        'SELECT campaign_id, contact_id, status FROM send_jobs WHERE id = :id',
        { id: input.jobId },
      );
      if (!job) throw notFound('Envio', input.jobId);
      if (job.status !== 'processing' && job.status !== 'pending') {
        throw new DomainError('INVALID_STATE', `Envio ${input.jobId} já foi finalizado (${job.status})`);
      }

      // Linha ou mensagem removida enquanto o envio estava em curso: o envio já
      // aconteceu e PRECISA ser registrado; só a referência fica vazia (o nome
      // da linha e o rótulo/texto da mensagem continuam gravados).
      const lineRow = this.db.get<{ label: string }>('SELECT label FROM lines WHERE id = :id', { id: input.lineId });
      const lineId = lineRow ? input.lineId : null;
      const messageTemplateId =
        input.messageTemplateId && this.db.get('SELECT 1 FROM message_templates WHERE id = :id', { id: input.messageTemplateId })
          ? input.messageTemplateId
          : null;
      const record: SendAttempt = {
        id: newId(),
        jobId: input.jobId,
        campaignId: job.campaign_id,
        contactId: job.contact_id,
        lineId,
        messageTemplateId,
        messageLabel: input.messageLabel ?? null,
        renderedBody: input.renderedBody,
        result: input.result,
        error: input.error ?? null,
        providerMessageId: input.providerMessageId ?? null,
        cycleNumber: input.cycleNumber ?? null,
        cycleIntervalSeconds: input.cycleIntervalSeconds ?? null,
        lineLabelAtSend: lineRow?.label ?? input.lineLabel ?? null,
        requeued: requeue,
        createdAt: now,
      };

      this.db.run(
        `INSERT INTO send_attempts (id, job_id, campaign_id, contact_id, line_id, message_template_id, message_label,
           rendered_body, result, error, provider_message_id, cycle_number, cycle_interval_seconds, line_label, requeued, created_at)
         VALUES (:id, :jobId, :campaignId, :contactId, :lineId, :messageTemplateId, :messageLabel,
           :renderedBody, :result, :error, :providerMessageId, :cycleNumber, :cycleIntervalSeconds, :lineLabelAtSend, :requeued, :createdAt)`,
        { ...record, requeued: record.requeued ? 1 : 0 },
      );

      this.db.run(
        requeue
          ? `UPDATE send_jobs SET status = 'pending', line_id = NULL, attempts = attempts + 1,
               last_error = :error, updated_at = :now WHERE id = :id`
          : `UPDATE send_jobs SET status = :status, line_id = :lineId, message_template_id = :messageTemplateId,
               attempts = attempts + 1, last_error = :error, provider_message_id = :providerMessageId,
               processed_at = :now, updated_at = :now WHERE id = :id`,
        requeue
          ? { id: input.jobId, error: record.error, now }
          : {
              id: input.jobId,
              status: input.result,
              lineId,
              messageTemplateId,
              error: record.error,
              providerMessageId: record.providerMessageId,
              now,
            },
      );

      const contact = this.db.get<{ name: string | null; phone: string }>('SELECT name, phone FROM contacts WHERE id = :id', {
        id: job.contact_id,
      });
      this.db.run(
        `UPDATE lines SET
           contacts_processed = contacts_processed + :processed,
           messages_sent = messages_sent + :sent,
           failures = failures + :failed,
           scheduled_pause_count = scheduled_pause_count + :sent,
           last_contact_id = :contactId,
           last_contact_name = :contactName,
           last_contact_phone = :contactPhone,
           last_message_label = :messageLabel,
           last_attempt_at = :now,
           last_attempt_result = :result,
           last_sent_at = CASE WHEN :result = 'sent' THEN :now ELSE last_sent_at END
         WHERE id = :lineId`,
        {
          lineId: input.lineId,
          processed: requeue ? 0 : 1,
          sent: input.result === 'sent' ? 1 : 0,
          failed: input.result === 'failed' ? 1 : 0,
          contactId: job.contact_id,
          contactName: contact?.name ?? null,
          contactPhone: contact?.phone ?? null,
          messageLabel: record.messageLabel,
          result: input.result,
          now,
        },
      );

      // Rastreamento individual do contato (inclui a última mensagem, usada na
      // regra de não repetição consecutiva).
      if (input.result === 'sent') {
        this.db.run(
          `UPDATE contacts SET
             messages_received = messages_received + 1,
             last_message_template_id = :messageTemplateId,
             last_message_label = :messageLabel,
             last_line_id = :lineId,
             last_sent_at = :now,
             last_error = NULL
           WHERE id = :contactId`,
          {
            contactId: job.contact_id,
            messageTemplateId,
            messageLabel: record.messageLabel,
            lineId,
            now,
          },
        );
      } else {
        this.db.run('UPDATE contacts SET last_error = :error WHERE id = :contactId', {
          contactId: job.contact_id,
          error: record.error,
        });
      }
      this.contactSync.contacts([job.contact_id]);

      return record;
    });

    this.events.emit('send.recorded', {
      attemptId: attempt.id,
      jobId: attempt.jobId,
      campaignId: attempt.campaignId,
      lineId: input.lineId,
      result: attempt.result,
      requeued: requeue,
    });
    return attempt;
  }

  /** Mensagens enviadas com sucesso pela linha desde o instante informado (limite diário). */
  async countSentSince(lineId: string, sinceIso: string): Promise<number> {
    return (
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM send_attempts WHERE line_id = :lineId AND result = 'sent' AND created_at >= :since`,
        { lineId, since: sinceIso },
      )?.n ?? 0
    );
  }

  /** Horário do último envio com sucesso de cada linha (opcionalmente dentro de um disparo). */
  async lastSentAtByLine(campaignId?: string): Promise<Map<string, string>> {
    const rows = this.db.all<{ line_id: string; at: string }>(
      `SELECT line_id, MAX(created_at) AS at FROM send_attempts
       WHERE result = 'sent' AND line_id IS NOT NULL ${campaignId ? 'AND campaign_id = :campaignId' : ''}
       GROUP BY line_id`,
      campaignId ? { campaignId } : {},
    );
    return new Map(rows.map((row) => [row.line_id, row.at]));
  }

  /** Total de tentativas de uma linha (inclui falhas temporárias que voltaram para a fila). */
  async attemptTotalsForLine(lineId: string, campaignId?: string): Promise<{ total: number; sent: number; failed: number }> {
    const row = this.db.get<{ total: number; sent: number | null; failed: number | null }>(
      `SELECT COUNT(*) AS total, SUM(result = 'sent') AS sent, SUM(result = 'failed') AS failed
       FROM send_attempts WHERE line_id = :lineId ${campaignId ? 'AND campaign_id = :campaignId' : ''}`,
      campaignId ? { lineId, campaignId } : { lineId },
    );
    return { total: row?.total ?? 0, sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
  }

  distinctContactsForLine(lineId: string, campaignId?: string): number {
    return (
      this.db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT contact_id) AS n FROM send_attempts WHERE line_id = :lineId ${campaignId ? 'AND campaign_id = :campaignId' : ''}`,
        campaignId ? { lineId, campaignId } : { lineId },
      )?.n ?? 0
    );
  }

  messageUsageForLine(lineId: string, campaignId?: string): { label: string; sent: number }[] {
    return this.db.all<{ label: string; sent: number }>(
      `SELECT COALESCE(message_label, 'Sem rótulo') AS label, COUNT(*) AS sent FROM send_attempts
       WHERE line_id = :lineId AND result = 'sent' ${campaignId ? 'AND campaign_id = :campaignId' : ''}
       GROUP BY label ORDER BY label`,
      campaignId ? { lineId, campaignId } : { lineId },
    );
  }

  cyclesForLine(lineId: string, campaignId?: string, limit = 30) {
    return this.db
      .all<{ campaign_id: string; campaign_name: string; cycle: number; interval: number | null; sent: number; failed: number; started_at: string }>(
        `SELECT a.campaign_id, cp.name AS campaign_name, a.cycle_number AS cycle, MAX(a.cycle_interval_seconds) AS interval,
                SUM(a.result = 'sent') AS sent, SUM(a.result = 'failed') AS failed, MIN(a.created_at) AS started_at
         FROM send_attempts a JOIN campaigns cp ON cp.id = a.campaign_id
         WHERE a.line_id = :lineId AND a.cycle_number IS NOT NULL ${campaignId ? 'AND a.campaign_id = :campaignId' : ''}
         GROUP BY a.campaign_id, a.cycle_number ORDER BY started_at DESC LIMIT :limit`,
        campaignId ? { lineId, campaignId, limit } : { lineId, limit },
      )
      .map((r) => ({
        campaignId: r.campaign_id,
        campaignName: r.campaign_name,
        cycle: r.cycle,
        intervalSeconds: r.interval,
        sent: r.sent,
        failed: r.failed,
        startedAt: r.started_at,
      }));
  }

  async list(query: HistoryQuery = {}): Promise<SendAttemptView[]> {
    const where: string[] = [];
    const params: SqlParams = { limit: Math.min(query.limit ?? 100, 1000), offset: query.offset ?? 0 };
    const filters = { campaignId: 'a.campaign_id', lineId: 'a.line_id', contactId: 'a.contact_id', result: 'a.result' } as const;
    for (const [key, column] of Object.entries(filters) as [keyof typeof filters, string][]) {
      const value = query[key];
      if (value) {
        where.push(`${column} = :${key}`);
        params[key] = value;
      }
    }
    const day = (value: string, add: number) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError('VALIDATION', 'Data inválida (use AAAA-MM-DD)');
      const [y, m, d] = value.split('-').map(Number) as [number, number, number];
      return new Date(y, m - 1, d + add).toISOString();
    };
    if (query.from) {
      where.push('a.created_at >= :fromDay');
      params.fromDay = day(query.from, 0);
    }
    if (query.to) {
      where.push('a.created_at < :toDay');
      params.toDay = day(query.to, 1);
    }
    if (query.contact?.trim()) {
      const text = query.contact.trim();
      const digits = text.replace(/\D/g, '');
      where.push(`(c.id = :contactExact OR c.name LIKE :contactLike${digits ? ' OR c.phone LIKE :contactDigits' : ''})`);
      params.contactExact = text;
      params.contactLike = `%${text}%`;
      if (digits) params.contactDigits = `%${digits}%`;
    }
    if (query.message) {
      where.push('COALESCE(a.message_label, m.name) = :messageLabel');
      params.messageLabel = query.message;
    }

    return this.db
      .all<AttemptRow>(
        `SELECT a.*, c.phone AS contact_phone, c.name AS contact_name, COALESCE(l.label, a.line_label) AS current_line_label,
                COALESCE(a.message_label, m.name) AS message_label, cp.name AS campaign_name
         FROM send_attempts a
         JOIN contacts c ON c.id = a.contact_id
         JOIN campaigns cp ON cp.id = a.campaign_id
         LEFT JOIN lines l ON l.id = a.line_id
         LEFT JOIN message_templates m ON m.id = a.message_template_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT :limit OFFSET :offset`,
        params,
      )
      .map(toView);
  }
}
