import type { Database, SqlParams } from '../../db/database.ts';
import { DomainError } from '../../shared/errors.ts';
import { toCsv } from './csv.ts';

export type ExportKind = 'sent' | 'failed' | 'pending' | 'history';

export interface ExportFilters {
  /** Data inicial (AAAA-MM-DD, inclusiva, horário local). */
  from?: string;
  /** Data final (AAAA-MM-DD, inclusiva, horário local). */
  to?: string;
  lineId?: string;
  /** history: sent | failed. pending: pending | waiting | processing. */
  status?: string;
  campaignId?: string;
  /** ID do contato, telefone (dígitos) ou parte do nome. */
  contact?: string;
  /** Rótulo da mensagem (ex.: "Mensagem 02") ou ID do modelo. */
  message?: string;
}

export interface ExportResult {
  filename: string;
  csv: string;
  rows: number;
}

const KIND_FILE: Record<ExportKind, string> = {
  sent: 'enviados',
  failed: 'falhas',
  pending: 'pendentes',
  history: 'historico',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Início do dia local (AAAA-MM-DD) em ISO UTC, para comparar com created_at. */
function localDayStart(day: string, addDays = 0): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + addDays, 0, 0, 0, 0).toISOString();
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const localDate = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '');
const localTime = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : '');

/** Código do erro quando o provedor o informa no formato "[código] descrição" ou "(#código)". */
function errorCode(error: string | null): string {
  if (!error) return '';
  return error.match(/^\[([^\]]+)\]/)?.[1] ?? error.match(/\(#(\d+)\)/)?.[1] ?? '';
}

const JOB_STATUS_LABEL: Record<string, string> = {
  pending: 'Pendente',
  processing: 'Enviando',
  sent: 'Enviado',
  failed: 'Falha',
  skipped: 'Não enviado',
};

interface AttemptExportRow {
  created_at: string;
  result: 'sent' | 'failed';
  error: string | null;
  requeued: number;
  rendered_body: string | null;
  message_label: string | null;
  cycle_number: number | null;
  cycle_interval_seconds: number | null;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string;
  line_id: string | null;
  line_account: string | null;
  line_label: string | null;
  campaign_name: string;
  job_status: string;
  job_attempts: number;
}

interface PendingExportRow {
  created_at: string;
  job_status: string;
  display_status: string;
  attempts: number;
  last_error: string | null;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string;
  line_id: string | null;
  line_account: string | null;
  line_label: string | null;
  campaign_name: string;
}

/**
 * Exportações CSV. Tudo é lido do histórico (send_attempts) e da fila
 * (send_jobs); nenhum dado é calculado à parte. O nome personalizado da linha
 * é o atual (com o nome da época como reserva, se a linha foi removida).
 */
export class ExportService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  export(kind: ExportKind, filters: ExportFilters = {}): ExportResult {
    const { headers, rows } = kind === 'pending' ? this.pending(filters) : this.attempts(kind, filters);
    return { filename: this.filename(kind, filters), csv: toCsv(headers, rows), rows: rows.length };
  }

  count(kind: ExportKind, filters: ExportFilters = {}): number {
    return kind === 'pending' ? this.pendingRows(filters).length : this.attemptRows(kind, filters).length;
  }

  // ---------------------------------------------------------------- enviados, falhas e histórico

  private attempts(kind: Exclude<ExportKind, 'pending'>, filters: ExportFilters) {
    const data = this.attemptRows(kind, filters);
    const base = (r: AttemptExportRow) => [r.contact_name, r.contact_phone, r.contact_id, r.line_account ?? r.line_id, r.line_label];

    if (kind === 'sent') {
      return {
        headers: ['Nome', 'Telefone', 'ID do contato', 'Linha', 'Nome personalizado da linha', 'Mensagem utilizada', 'Data', 'Hora', 'Status', 'Campanha/disparo', 'Ciclo', 'Intervalo do ciclo (s)', 'Texto enviado'],
        rows: data.map((r) => [...base(r), r.message_label, localDate(r.created_at), localTime(r.created_at), 'Enviado', r.campaign_name, r.cycle_number, r.cycle_interval_seconds, r.rendered_body]),
      };
    }
    if (kind === 'failed') {
      return {
        headers: ['Nome', 'Telefone', 'ID do contato', 'Linha', 'Nome personalizado da linha', 'Data', 'Hora', 'Status', 'Motivo da falha', 'Código do erro', 'Erro retornado', 'Tentativas', 'Campanha/disparo', 'Ciclo', 'Mensagem utilizada', 'Situação atual do contato no disparo'],
        rows: data.map((r) => [
          ...base(r),
          localDate(r.created_at),
          localTime(r.created_at),
          'Falha',
          r.requeued ? 'Falha temporária: o contato voltou para a fila' : 'Falha definitiva',
          errorCode(r.error),
          r.error,
          r.job_attempts,
          r.campaign_name,
          r.cycle_number,
          r.message_label,
          JOB_STATUS_LABEL[r.job_status] ?? r.job_status,
        ]),
      };
    }
    return {
      headers: ['Nome', 'Telefone', 'ID do contato', 'Linha', 'Nome personalizado da linha', 'Mensagem utilizada', 'Data', 'Hora', 'Status', 'Motivo/erro', 'Tentativas', 'Campanha/disparo', 'Ciclo', 'Intervalo do ciclo (s)', 'Texto enviado'],
      rows: data.map((r) => [
        ...base(r),
        r.message_label,
        localDate(r.created_at),
        localTime(r.created_at),
        r.result === 'sent' ? 'Enviado' : 'Falha',
        r.result === 'failed' ? `${r.requeued ? 'Temporária' : 'Definitiva'}: ${r.error ?? ''}` : '',
        r.job_attempts,
        r.campaign_name,
        r.cycle_number,
        r.cycle_interval_seconds,
        r.rendered_body,
      ]),
    };
  }

  private attemptRows(kind: Exclude<ExportKind, 'pending'>, filters: ExportFilters): AttemptExportRow[] {
    const where: string[] = [];
    const params: SqlParams = {};
    if (kind === 'sent') where.push("a.result = 'sent'");
    if (kind === 'failed') where.push("a.result = 'failed'");
    if (kind === 'history' && filters.status) {
      if (filters.status !== 'sent' && filters.status !== 'failed') {
        throw new DomainError('VALIDATION', 'Status do histórico deve ser "sent" ou "failed"');
      }
      where.push('a.result = :status');
      params.status = filters.status;
    }
    this.commonFilters(filters, where, params, 'a.created_at', 'a.line_id');
    if (filters.message) {
      where.push('(COALESCE(a.message_label, m.name) = :message OR a.message_template_id = :message)');
      params.message = filters.message;
    }

    return this.db.all<AttemptExportRow>(
      `SELECT a.created_at, a.result, a.error, a.requeued, a.rendered_body, COALESCE(a.message_label, m.name) AS message_label,
              a.cycle_number, a.cycle_interval_seconds, a.contact_id,
              c.name AS contact_name, c.phone AS contact_phone,
              a.line_id, l.account_id AS line_account, COALESCE(l.label, a.line_label) AS line_label,
              cp.name AS campaign_name, j.status AS job_status, j.attempts AS job_attempts
       FROM send_attempts a
       JOIN contacts c ON c.id = a.contact_id
       JOIN campaigns cp ON cp.id = a.campaign_id
       JOIN send_jobs j ON j.id = a.job_id
       LEFT JOIN lines l ON l.id = a.line_id
       LEFT JOIN message_templates m ON m.id = a.message_template_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at, a.rowid`,
      params,
    );
  }

  // ---------------------------------------------------------------- pendentes

  private pending(filters: ExportFilters) {
    const data = this.pendingRows(filters);
    const label: Record<string, string> = { pending: 'Pendente', waiting: 'Aguardando', processing: 'Enviando' };
    return {
      headers: ['Nome', 'Telefone', 'ID do contato', 'Status', 'Campanha/disparo', 'Linha', 'Nome personalizado da linha', 'Tentativas', 'Último erro', 'Data de entrada', 'Hora de entrada'],
      rows: data.map((r) => [
        r.contact_name,
        r.contact_phone,
        r.contact_id,
        label[r.display_status] ?? r.display_status,
        r.campaign_name,
        r.line_account ?? r.line_id,
        r.line_label,
        r.attempts,
        r.last_error,
        localDate(r.created_at),
        localTime(r.created_at),
      ]),
    };
  }

  private pendingRows(filters: ExportFilters): PendingExportRow[] {
    const where = ["j.status IN ('pending', 'processing')", "cp.status IN ('draft', 'running', 'paused')"];
    const params: SqlParams = {};
    // Linha: envios em curso nela + pendentes dos disparos em que ela está selecionada (fila compartilhada).
    this.commonFilters({ ...filters, lineId: undefined }, where, params, 'j.created_at', 'j.line_id');
    if (filters.lineId) {
      where.push(`(j.line_id = :lineId OR (j.status = 'pending' AND EXISTS (
        SELECT 1 FROM campaign_lines cl WHERE cl.campaign_id = j.campaign_id AND cl.line_id = :lineId)))`);
      params.lineId = filters.lineId;
    }
    const rows = this.db.all<PendingExportRow>(
      `SELECT j.created_at, j.status AS job_status, j.attempts, j.last_error, j.contact_id,
              c.name AS contact_name, c.phone AS contact_phone,
              CASE
                WHEN j.status = 'processing' THEN 'processing'
                WHEN cp.status = 'running' AND EXISTS (
                  SELECT 1 FROM campaign_lines cl JOIN lines al ON al.id = cl.line_id
                  WHERE cl.campaign_id = j.campaign_id AND al.connection_status = 'connected'
                    AND al.run_state = 'active' AND al.operational_status <> 'error'
                ) THEN 'pending'
                ELSE 'waiting'
              END AS display_status,
              j.line_id, l.account_id AS line_account, l.label AS line_label, cp.name AS campaign_name
       FROM send_jobs j
       JOIN contacts c ON c.id = j.contact_id
       JOIN campaigns cp ON cp.id = j.campaign_id
       LEFT JOIN lines l ON l.id = j.line_id
       WHERE ${where.join(' AND ')}
       ORDER BY j.created_at, j.rowid`,
      params,
    );
    // Situação dentro DESTE disparo: aguardando = disparo pausado/rascunho ou sem linha apta.
    const out = rows;
    if (!filters.status) return out;
    if (!['pending', 'waiting', 'processing'].includes(filters.status)) {
      throw new DomainError('VALIDATION', 'Status de pendentes deve ser "pending", "waiting" ou "processing"');
    }
    return out.filter((r) => r.display_status === filters.status);
  }

  // ---------------------------------------------------------------- comum

  private commonFilters(filters: ExportFilters, where: string[], params: SqlParams, dateColumn: string, lineColumn: string): void {
    if (filters.from) {
      if (!DATE.test(filters.from)) throw new DomainError('VALIDATION', 'Data inicial inválida (use AAAA-MM-DD)');
      where.push(`${dateColumn} >= :from`);
      params.from = localDayStart(filters.from);
    }
    if (filters.to) {
      if (!DATE.test(filters.to)) throw new DomainError('VALIDATION', 'Data final inválida (use AAAA-MM-DD)');
      where.push(`${dateColumn} < :to`);
      params.to = localDayStart(filters.to, 1);
    }
    if (filters.from && filters.to && filters.from > filters.to) {
      throw new DomainError('VALIDATION', 'A data inicial deve ser anterior ou igual à data final');
    }
    if (filters.lineId) {
      where.push(`${lineColumn} = :lineId`);
      params.lineId = filters.lineId;
    }
    if (filters.campaignId) {
      where.push(`${dateColumn.split('.')[0]}.campaign_id = :campaignId`);
      params.campaignId = filters.campaignId;
    }
    if (filters.contact?.trim()) {
      const text = filters.contact.trim();
      const digits = text.replace(/\D/g, '');
      where.push(`(c.id = :contactExact OR c.name LIKE :contactLike${digits ? ' OR c.phone LIKE :contactDigits' : ''})`);
      params.contactExact = text;
      params.contactLike = `%${text}%`;
      if (digits) params.contactDigits = `%${digits}%`;
    }
  }

  private filename(kind: ExportKind, filters: ExportFilters): string {
    const parts = [KIND_FILE[kind]];
    if (filters.lineId) {
      const label = this.db.get<{ label: string }>('SELECT label FROM lines WHERE id = :id', { id: filters.lineId })?.label;
      parts.push(label ?? 'linha');
    }
    if (filters.from || filters.to) parts.push(`${filters.from ?? 'inicio'}_a_${filters.to ?? 'hoje'}`);
    parts.push(new Date().toISOString().slice(0, 10));
    const safe = parts
      .join('_')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-');
    return `${safe}.csv`;
  }
}
