import { inClause, type Database, type SqlParams } from '../../db/database.ts';
import { canonicalPersonPhone, personPhoneVariants } from '../contacts/phone.ts';
import { DomainError } from '../../shared/errors.ts';

export type InteractionCategory = 'replied' | 'initiated' | 'no_reply';

export interface AnalyticsFilters {
  /** AAAA-MM-DD (inclusivo, horário local). */
  from?: string;
  to?: string;
  lineId?: string;
  /** sent | failed (envios) ou replied | initiated | no_reply (pessoas). */
  status?: string;
  /** ID do contato, telefone ou parte do nome. */
  contact?: string;
  /** Rótulo da mensagem (ex.: "Mensagem 02"). */
  message?: string;
}

export interface AnalyticsOverview {
  sends: {
    sent: number;
    failed: number;
    byLine: { lineId: string | null; label: string; sent: number; failed: number }[];
    byMessage: { label: string; sent: number; failed: number; people: number; replied: number }[];
    byDay: { day: string; sent: number; failed: number; inbound: number }[];
  };
  classification: {
    people: number;
    replied: number;
    initiated: number;
    noReply: number;
    inboundMessages: number;
    byLine: { lineId: string | null; label: string; people: number; replied: number; initiated: number; noReply: number }[];
  };
  groups: { chats: number; messages: number };
  generatedAt: string;
}

export interface AnalyticsPerson {
  personKey: string;
  name: string | null;
  phone: string | null;
  contactId: string | null;
  category: InteractionCategory;
  lines: string[];
  received: number;
  inbound: number;
  firstAt: string;
  lastAt: string;
}

export interface PersonTimelineEntry {
  at: string;
  kind: 'dispatch' | 'inbound' | 'outbound';
  lineLabel: string | null;
  campaignName: string | null;
  messageLabel: string | null;
  body: string | null;
  result: 'sent' | 'failed' | null;
  error: string | null;
  chatType: 'individual' | 'group' | 'broadcast';
  groupName: string | null;
}

/** Evento real de uma pessoa: algo enviado a ela (S) ou algo que ela escreveu (R). */
interface PersonEvent {
  personKey: string;
  kind: 'S' | 'R';
  at: string;
  lineId: string | null;
  lineLabel: string;
  messageLabel: string | null;
  name: string | null;
  phone: string | null;
  contactId: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PEOPLE_STATUSES = new Set(['replied', 'initiated', 'no_reply']);
const SEND_STATUSES = new Set(['sent', 'failed']);

function localDayStart(day: string, addDays = 0): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + addDays).toISOString();
}

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Analytics sobre os registros reais: envios do disparo (send_attempts) e
 * mensagens das conversas de TODAS as linhas (conversation_messages).
 *
 * CLASSIFICAÇÃO DAS INTERAÇÕES (por pessoa, consolidando TODAS as linhas):
 *  - a pessoa é identificada pelo telefone (ou pela identificação da conversa
 *    quando o provedor não informa o número); a mesma pessoa em várias linhas é
 *    UMA pessoa, com os eventos de todas as linhas somados;
 *  - entram conversas individuais; GRUPOS (e transmissões) ficam de fora;
 *  - Respondeu: a primeira mensagem que escreveu no período veio depois de ter
 *    recebido mensagem (em qualquer linha);
 *  - Iniciou a conversa: a primeira mensagem que escreveu no período não foi
 *    precedida de nenhuma mensagem enviada a ela;
 *  - Não respondeu: recebeu mensagem no período e não escreveu no período.
 * Nada é gravado, alterado ou descartado por esta consulta.
 */
export class AnalyticsService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  overview(filters: AnalyticsFilters = {}): AnalyticsOverview {
    const range = this.range(filters);
    const people = this.classify(filters, range);

    // ---------------- envios (registros individuais do disparo)
    const sendWhere = ['a.created_at >= :from', 'a.created_at < :to'];
    const sendParams: SqlParams = { from: range.from, to: range.to };
    this.lineContactMessageFilters(filters, sendWhere, sendParams, 'a.line_id', 'c', 'COALESCE(a.message_label, m.name)');
    if (filters.status && SEND_STATUSES.has(filters.status)) {
      sendWhere.push('a.result = :status');
      sendParams.status = filters.status;
    }
    const sendRows = this.db.all<{ line_id: string | null; label: string; message: string; result: string; day_at: string }>(
      `SELECT a.line_id, COALESCE(l.label, a.line_label, 'Linha removida') AS label,
              COALESCE(a.message_label, m.name, 'Sem rótulo') AS message, a.result, a.created_at AS day_at
       FROM send_attempts a
       JOIN contacts c ON c.id = a.contact_id
       LEFT JOIN lines l ON l.id = a.line_id
       LEFT JOIN message_templates m ON m.id = a.message_template_id
       WHERE ${sendWhere.join(' AND ')}`,
      sendParams,
    );

    const byLine = new Map<string, { lineId: string | null; label: string; sent: number; failed: number }>();
    const byMessage = new Map<string, { label: string; sent: number; failed: number }>();
    const byDay = new Map<string, { day: string; sent: number; failed: number; inbound: number }>();
    let sent = 0;
    let failed = 0;
    for (const row of sendRows) {
      const isSent = row.result === 'sent';
      if (isSent) sent++;
      else failed++;
      const line = byLine.get(row.line_id ?? row.label) ?? { lineId: row.line_id, label: row.label, sent: 0, failed: 0 };
      line[isSent ? 'sent' : 'failed']++;
      byLine.set(row.line_id ?? row.label, line);
      const message = byMessage.get(row.message) ?? { label: row.message, sent: 0, failed: 0 };
      message[isSent ? 'sent' : 'failed']++;
      byMessage.set(row.message, message);
      const day = localDay(row.day_at);
      const dayRow = byDay.get(day) ?? { day, sent: 0, failed: 0, inbound: 0 };
      dayRow[isSent ? 'sent' : 'failed']++;
      byDay.set(day, dayRow);
    }
    for (const event of people.periodInbound) {
      const day = localDay(event.at);
      const dayRow = byDay.get(day) ?? { day, sent: 0, failed: 0, inbound: 0 };
      dayRow.inbound++;
      byDay.set(day, dayRow);
    }

    // Resposta por mensagem: pessoas que receberam a mensagem no período e responderam depois dela.
    const responseByMessage = new Map<string, { people: Set<string>; replied: Set<string> }>();
    for (const [personKey, events] of people.eventsByPerson) {
      const inbound = events.filter((e) => e.kind === 'R' && e.at >= range.from).map((e) => e.at);
      for (const e of events) {
        if (e.kind !== 'S' || !e.messageLabel || e.at < range.from) continue;
        const entry = responseByMessage.get(e.messageLabel) ?? { people: new Set<string>(), replied: new Set<string>() };
        entry.people.add(personKey);
        if (inbound.some((at) => at > e.at)) entry.replied.add(personKey);
        responseByMessage.set(e.messageLabel, entry);
      }
    }

    // ---------------- grupos (fora da classificação individual)
    const groupWhere = ["cm.chat_type <> 'individual'", 'cm.sent_at >= :from', 'cm.sent_at < :to'];
    const groupParams: SqlParams = { from: range.from, to: range.to };
    if (filters.lineId) {
      groupWhere.push('cm.line_id = :lineId');
      groupParams.lineId = filters.lineId;
    }
    const groups = this.db.get<{ chats: number; messages: number }>(
      `SELECT COUNT(DISTINCT cm.line_id || '|' || cm.chat_id) AS chats, COUNT(*) AS messages FROM conversation_messages cm WHERE ${groupWhere.join(' AND ')}`,
      groupParams,
    )!;

    const counts = { replied: 0, initiated: 0, noReply: 0 };
    for (const person of people.list) counts[person.category === 'no_reply' ? 'noReply' : person.category]++;

    return {
      sends: {
        sent,
        failed,
        byLine: [...byLine.values()].sort((a, b) => a.label.localeCompare(b.label)),
        byMessage: [...byMessage.values()]
          .map((m) => ({ ...m, people: responseByMessage.get(m.label)?.people.size ?? 0, replied: responseByMessage.get(m.label)?.replied.size ?? 0 }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      },
      classification: {
        people: people.list.length,
        ...counts,
        inboundMessages: people.periodInbound.length,
        byLine: people.byLine,
      },
      groups: { chats: groups.chats, messages: groups.messages },
      generatedAt: new Date().toISOString(),
    };
  }

  people(filters: AnalyticsFilters = {}, page: { limit?: number; offset?: number } = {}): { total: number; people: AnalyticsPerson[] } {
    const { list } = this.classify(filters, this.range(filters));
    const filtered = filters.status && PEOPLE_STATUSES.has(filters.status) ? list.filter((p) => p.category === filters.status) : list;
    const sorted = filtered.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    const offset = page.offset ?? 0;
    return { total: sorted.length, people: sorted.slice(offset, offset + Math.min(page.limit ?? 100, 1000)) };
  }

  /** Linha do tempo completa de uma pessoa em TODAS as linhas (inclui mensagens dela em grupos, marcadas). */
  personTimeline(personKey: string): PersonTimelineEntry[] {
    // A mesma pessoa pode estar registrada com ou sem o nono dígito.
    const keys = inClause(/^\d+$/.test(personKey) ? personPhoneVariants(personKey) : [personKey]);
    const dispatch = this.db.all<PersonTimelineEntry>(
      `SELECT a.created_at AS at, 'dispatch' AS kind, COALESCE(l.label, a.line_label) AS lineLabel, cp.name AS campaignName,
              COALESCE(a.message_label, m.name) AS messageLabel, a.rendered_body AS body, a.result, a.error,
              'individual' AS chatType, NULL AS groupName
       FROM send_attempts a
       JOIN contacts c ON c.id = a.contact_id
       JOIN campaigns cp ON cp.id = a.campaign_id
       LEFT JOIN lines l ON l.id = a.line_id
       LEFT JOIN message_templates m ON m.id = a.message_template_id
       WHERE c.phone ${keys.sql}`,
      keys.params,
    );
    const chats = this.db.all<PersonTimelineEntry>(
      `SELECT cm.sent_at AS at, cm.direction AS kind, COALESCE(l.label, cm.line_label) AS lineLabel, NULL AS campaignName,
              NULL AS messageLabel, cm.body, NULL AS result, NULL AS error, cm.chat_type AS chatType, cm.group_name AS groupName
       FROM conversation_messages cm LEFT JOIN lines l ON l.id = cm.line_id
       WHERE cm.person_key ${keys.sql}`,
      keys.params,
    );
    return [...dispatch, ...chats].sort((a, b) => a.at.localeCompare(b.at));
  }

  // ---------------------------------------------------------------- classificação

  private classify(filters: AnalyticsFilters, range: { from: string; to: string }) {
    const events: PersonEvent[] = [];

    // S (dispatch): mensagens entregues pelo disparo, de qualquer linha, até o fim do período.
    const sWhere = ["a.result = 'sent'", 'a.created_at < :to'];
    const sParams: SqlParams = { to: range.to };
    this.lineContactMessageFilters(filters, sWhere, sParams, 'a.line_id', 'c', 'COALESCE(a.message_label, m.name)');
    for (const row of this.db.all<{ phone: string; name: string | null; contact_id: string; at: string; line_id: string | null; label: string; message: string | null }>(
      `SELECT c.phone, c.name, c.id AS contact_id, a.created_at AS at, a.line_id,
              COALESCE(l.label, a.line_label, 'Linha removida') AS label, COALESCE(a.message_label, m.name) AS message
       FROM send_attempts a
       JOIN contacts c ON c.id = a.contact_id
       LEFT JOIN lines l ON l.id = a.line_id
       LEFT JOIN message_templates m ON m.id = a.message_template_id
       WHERE ${sWhere.join(' AND ')}`,
      sParams,
    )) {
      events.push({ personKey: canonicalPersonPhone(row.phone), kind: 'S', at: row.at, lineId: row.line_id, lineLabel: row.label, messageLabel: row.message, name: row.name, phone: row.phone, contactId: row.contact_id });
    }

    // Conversas individuais de TODAS as linhas (grupos/transmissões excluídos).
    const cWhere = ["cm.chat_type = 'individual'", 'cm.sent_at < :to'];
    const cParams: SqlParams = { to: range.to };
    if (filters.lineId) {
      cWhere.push('cm.line_id = :lineId');
      cParams.lineId = filters.lineId;
    }
    if (filters.contact?.trim()) {
      const text = filters.contact.trim();
      const digits = text.replace(/\D/g, '');
      cWhere.push(`(cm.contact_id = :cExact OR cm.person_key = :cExact OR cm.person_name LIKE :cLike OR c.name LIKE :cLike${digits ? ' OR cm.person_phone LIKE :cDigits' : ''})`);
      cParams.cExact = text;
      cParams.cLike = `%${text}%`;
      if (digits) cParams.cDigits = `%${digits}%`;
    }
    for (const row of this.db.all<{ person_key: string; direction: string; at: string; line_id: string | null; label: string; person_name: string | null; contact_name: string | null; person_phone: string | null; contact_id: string | null }>(
      `SELECT cm.person_key, cm.direction, cm.sent_at AS at, cm.line_id, COALESCE(l.label, cm.line_label, 'Linha removida') AS label,
              cm.person_name, c.name AS contact_name, cm.person_phone, cm.contact_id
       FROM conversation_messages cm
       LEFT JOIN lines l ON l.id = cm.line_id
       LEFT JOIN contacts c ON c.id = cm.contact_id OR (cm.contact_id IS NULL AND c.phone = cm.person_phone)
       WHERE ${cWhere.join(' AND ')}`,
      cParams,
    )) {
      // Mensagem enviada manualmente pela linha conta como "recebeu" (sem rótulo de mensagem do disparo).
      if (row.direction === 'outbound' && filters.message) continue;
      events.push({
        // Registros gravados antes da chave canônica também se juntam à mesma pessoa.
        personKey: /^\d+$/.test(row.person_key) ? canonicalPersonPhone(row.person_key) : row.person_key,
        kind: row.direction === 'inbound' ? 'R' : 'S',
        at: row.at,
        lineId: row.line_id,
        lineLabel: row.label,
        messageLabel: null,
        name: row.contact_name ?? row.person_name,
        phone: row.person_phone,
        contactId: row.contact_id,
      });
    }

    const eventsByPerson = new Map<string, PersonEvent[]>();
    for (const e of events) {
      const list = eventsByPerson.get(e.personKey) ?? [];
      list.push(e);
      eventsByPerson.set(e.personKey, list);
    }

    const list: AnalyticsPerson[] = [];
    const periodInbound: PersonEvent[] = [];
    const lineStats = new Map<string, { lineId: string | null; label: string; people: Set<string>; byCategory: Map<string, InteractionCategory> }>();

    for (const [personKey, personEvents] of eventsByPerson) {
      personEvents.sort((a, b) => a.at.localeCompare(b.at));
      const inPeriod = personEvents.filter((e) => e.at >= range.from);
      if (inPeriod.length === 0) continue;

      const inbound = inPeriod.filter((e) => e.kind === 'R');
      const sentInPeriod = inPeriod.filter((e) => e.kind === 'S');
      periodInbound.push(...inbound);
      // A categoria é definida pela PRIMEIRA mensagem que a pessoa escreveu no período:
      // houve algo enviado a ela antes (em qualquer linha)? Respondeu. Senão, iniciou.
      const firstInbound = inbound[0];
      let category: InteractionCategory;
      if (!firstInbound) category = 'no_reply';
      else if (personEvents.some((e) => e.kind === 'S' && e.at < firstInbound.at)) category = 'replied';
      else category = 'initiated';

      const named = [...personEvents].reverse().find((e) => e.name) ?? personEvents[0]!;
      list.push({
        personKey,
        name: named.name,
        phone: personEvents.find((e) => e.phone)?.phone ?? null,
        contactId: personEvents.find((e) => e.contactId)?.contactId ?? null,
        category,
        lines: [...new Set(inPeriod.map((e) => e.lineLabel))].sort(),
        received: sentInPeriod.length,
        inbound: inbound.length,
        firstAt: inPeriod[0]!.at,
        lastAt: inPeriod[inPeriod.length - 1]!.at,
      });

      // Por linha: a pessoa conta em CADA linha onde interagiu (com a categoria consolidada).
      for (const e of inPeriod) {
        const key = e.lineId ?? `removida:${e.lineLabel}`;
        const stat = lineStats.get(key) ?? { lineId: e.lineId, label: e.lineLabel, people: new Set<string>(), byCategory: new Map() };
        stat.people.add(personKey);
        stat.byCategory.set(personKey, category);
        lineStats.set(key, stat);
      }
    }

    const byLine = [...lineStats.values()]
      .map((s) => {
        const categories = [...s.byCategory.values()];
        return {
          lineId: s.lineId,
          label: s.label,
          people: s.people.size,
          replied: categories.filter((c) => c === 'replied').length,
          initiated: categories.filter((c) => c === 'initiated').length,
          noReply: categories.filter((c) => c === 'no_reply').length,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    return { list, periodInbound, eventsByPerson, byLine };
  }

  // ---------------------------------------------------------------- filtros

  private range(filters: AnalyticsFilters): { from: string; to: string } {
    for (const [name, value] of [['inicial', filters.from], ['final', filters.to]] as const) {
      if (value && !DATE.test(value)) throw new DomainError('VALIDATION', `Data ${name} inválida (use AAAA-MM-DD)`);
    }
    if (filters.from && filters.to && filters.from > filters.to) {
      throw new DomainError('VALIDATION', 'A data inicial deve ser anterior ou igual à data final');
    }
    if (filters.status && !PEOPLE_STATUSES.has(filters.status) && !SEND_STATUSES.has(filters.status)) {
      throw new DomainError('VALIDATION', 'Status inválido');
    }
    return {
      from: filters.from ? localDayStart(filters.from) : '0000',
      to: filters.to ? localDayStart(filters.to, 1) : '9999',
    };
  }

  private lineContactMessageFilters(filters: AnalyticsFilters, where: string[], params: SqlParams, lineColumn: string, contactAlias: string, messageExpr: string): void {
    if (filters.lineId) {
      where.push(`${lineColumn} = :lineId`);
      params.lineId = filters.lineId;
    }
    if (filters.contact?.trim()) {
      const text = filters.contact.trim();
      const digits = text.replace(/\D/g, '');
      where.push(`(${contactAlias}.id = :contactExact OR ${contactAlias}.phone = :contactExact OR ${contactAlias}.name LIKE :contactLike${digits ? ` OR ${contactAlias}.phone LIKE :contactDigits` : ''})`);
      params.contactExact = text;
      params.contactLike = `%${text}%`;
      if (digits) params.contactDigits = `%${digits}%`;
    }
    if (filters.message) {
      where.push(`${messageExpr} = :message`);
      params.message = filters.message;
    }
  }
}
