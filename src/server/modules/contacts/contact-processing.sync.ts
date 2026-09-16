import type { Database } from '../../db/database.ts';
import { inClause } from '../../db/database.ts';

/**
 * Recalcula contacts.processing_status a partir da fila (send_jobs), que é a
 * fonte da verdade. Chamado em todo ponto que muda a fila ou o status de um
 * processo, sempre de forma síncrona (pode rodar dentro de transações).
 *
 * Prioridade quando o contato está em vários processos:
 *   processing > pending (processo não finalizado) > último resultado > idle
 */
const STATUS_EXPRESSION = `CASE
  WHEN EXISTS (SELECT 1 FROM send_jobs j WHERE j.contact_id = contacts.id AND j.status = 'processing') THEN 'processing'
  WHEN EXISTS (
    SELECT 1 FROM send_jobs j JOIN campaigns c ON c.id = j.campaign_id
    WHERE j.contact_id = contacts.id AND j.status = 'pending' AND c.status IN ('draft', 'running', 'paused')
  ) THEN 'pending'
  ELSE COALESCE((
    SELECT j.status FROM send_jobs j
    WHERE j.contact_id = contacts.id AND j.status IN ('sent', 'failed')
    ORDER BY j.processed_at DESC LIMIT 1
  ), 'idle')
END`;

/**
 * Situação EXIBIDA do contato (alias c): um pendente vira "waiting" (pausado/aguardando)
 * quando nenhum dos seus envios pendentes pode andar agora, ou seja, o processo está
 * pausado/em rascunho ou nenhuma linha selecionada está conectada e ativa.
 * Derivado na leitura a partir do estado real, portanto nunca fica desatualizado.
 */
export const CONTACT_DISPLAY_STATUS_SQL = `CASE
  WHEN c.processing_status = 'pending' AND NOT EXISTS (
    SELECT 1 FROM send_jobs j JOIN campaigns cp ON cp.id = j.campaign_id
    WHERE j.contact_id = c.id AND j.status = 'pending' AND cp.status = 'running'
      AND EXISTS (
        SELECT 1 FROM campaign_lines cl JOIN lines l ON l.id = cl.line_id
        WHERE cl.campaign_id = cp.id AND l.connection_status = 'connected'
          AND l.run_state = 'active' AND l.operational_status <> 'error'
      )
  ) THEN 'waiting'
  ELSE c.processing_status
END`;

export class ContactProcessingSync {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  contacts(contactIds: readonly string[]): void {
    if (contactIds.length === 0) return;
    const { sql, params } = inClause([...new Set(contactIds)], 'c');
    this.db.run(`UPDATE contacts SET processing_status = ${STATUS_EXPRESSION} WHERE id ${sql}`, params);
  }

  campaign(campaignId: string): void {
    this.db.run(
      `UPDATE contacts SET processing_status = ${STATUS_EXPRESSION}
       WHERE id IN (SELECT contact_id FROM send_jobs WHERE campaign_id = :campaignId)`,
      { campaignId },
    );
  }

  all(): void {
    this.db.run(`UPDATE contacts SET processing_status = ${STATUS_EXPRESSION}`);
  }
}
