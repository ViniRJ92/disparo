import { useEffect, useState } from 'react';
import { Ban, ChevronLeft, ChevronRight, CircleCheck, Clock, FileUp, History, Loader, Megaphone, Pencil, RefreshCw, Search, ShieldAlert, Trash2, UserPlus, Users } from 'lucide-react';
import { api, messageOf } from '../api/client.ts';
import type { ContactProcessingStatus, ContactStatus, ContactView } from '../api/types.ts';
import { useLiveResource } from '../hooks/useLiveResource.ts';
import { formatDateTime, formatNumber, PROCESSING_LABEL } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { ContactFormModal } from './ContactFormModal.tsx';
import { ContactHistoryModal } from './ContactHistoryModal.tsx';
import { ContactImportModal } from './ContactImportModal.tsx';
import { KpiCard, PageHeader, percent, ratio } from './ui.tsx';

const PAGE_SIZES = [15, 50, 100];
const LIVE_EVENTS = ['send.recorded', 'campaign.updated'];

type Filter = { kind: 'all' } | { kind: 'processing'; value: ContactProcessingStatus } | { kind: 'status'; value: ContactStatus };

/** "+55 21 99876-5432" para celulares/fixos do Brasil; demais números como estão. */
export function formatPhone(phone: string): string {
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return br ? `+55 ${br[1]} ${br[2]}-${br[3]}` : `+${phone}`;
}

function pageList(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const pages = new Set([0, 1, total - 1, current - 1, current, current + 1].filter((p) => p >= 0 && p < total));
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1]! > 1) out.push('…');
    out.push(p);
  });
  return out;
}

/** Área "Contatos": cadastro sem duplicidade, situação de cada pessoa e histórico individual. */
export function ContactsPage({ onError }: { onError: (message: string) => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(15);
  const [editing, setEditing] = useState<ContactView | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [historyOf, setHistoryOf] = useState<ContactView | null>(null);

  const query = {
    search: search.trim() || undefined,
    processingStatus: filter.kind === 'processing' ? filter.value : undefined,
    status: filter.kind === 'status' ? filter.value : undefined,
    limit: pageSize,
    offset: page * pageSize,
  };
  const { data, reload } = useLiveResource(() => api.contacts(query), LIVE_EVENTS);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 200);
    return () => clearTimeout(timer);
  }, [search, filter, page, pageSize, reload]);

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await reload();
    } catch (error) {
      onError(messageOf(error));
    }
  };

  const summary = data?.summary;
  const chips: { label: string; count: number; filter: Filter }[] = summary
    ? [
        { label: 'Todos', count: summary.total, filter: { kind: 'all' } },
        { label: 'Pendentes', count: summary.byProcessing.pending, filter: { kind: 'processing', value: 'pending' } },
        { label: 'Aguardando', count: summary.byProcessing.waiting, filter: { kind: 'processing', value: 'waiting' } },
        { label: 'Enviando', count: summary.byProcessing.processing, filter: { kind: 'processing', value: 'processing' } },
        { label: 'Receberam', count: summary.byProcessing.sent, filter: { kind: 'processing', value: 'sent' } },
        { label: 'Com erro', count: summary.byProcessing.failed, filter: { kind: 'processing', value: 'failed' } },
        { label: 'Sem processo', count: summary.byProcessing.idle, filter: { kind: 'processing', value: 'idle' } },
        { label: 'Bloqueados', count: summary.blocked, filter: { kind: 'status', value: 'blocked' } },
      ]
    : [];
  const isActive = (f: Filter) => JSON.stringify(f) === JSON.stringify(filter);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  const total = summary?.total ?? 0;
  const activeContacts = total - (summary?.blocked ?? 0);
  const received = summary?.byProcessing.sent ?? 0;
  const queue = (summary?.byProcessing.pending ?? 0) + (summary?.byProcessing.waiting ?? 0) + (summary?.byProcessing.processing ?? 0);
  const failed = summary?.byProcessing.failed ?? 0;

  return (
    <>
      <PageHeader
        title="Gestão de Contatos"
        subtitle="Cadastro sem duplicidade, situação de envio de cada pessoa e histórico individual."
        actions={
          <>
            <button onClick={() => setImporting(true)}><FileUp size={16} /> Importar lista <span className="tag">CSV</span></button>
            <button className="success" onClick={() => setEditing('new')}><UserPlus size={16} /> Novo contato</button>
          </>
        }
      />

      <div className="grid-4">
        <KpiCard label="Total cadastrado" icon={<Users size={16} />} iconTone="primary" value={total}
          suffix={<span className="small ok-text">{percent(activeContacts, total)} ativo</span>} progress={ratio(activeContacts, total)} progressTone="primary" />
        <KpiCard label="Receberam" icon={<CircleCheck size={16} />} iconTone="ok" value={received}
          suffix={<Badge tone="ok">{percent(received, total)} da base</Badge>} progress={ratio(received, total)} />
        <KpiCard label="Fila ativa / envios" icon={<Loader size={16} />} iconTone="info" value={queue}
          suffix={<span className="small muted">{summary?.byProcessing.processing ? `${summary.byProcessing.processing} enviando agora` : 'na fila'}</span>} progress={ratio(queue, total)} progressTone="info" />
        <KpiCard label="Falhas & bloqueios" icon={<ShieldAlert size={16} />} iconTone={failed || summary?.blocked ? 'bad' : ''} value={failed + (summary?.blocked ?? 0)}
          suffix={<span className="small muted">{formatNumber(failed)} erro(s) · {formatNumber(summary?.blocked ?? 0)} bloqueado(s)</span>} progress={ratio(failed + (summary?.blocked ?? 0), total)} progressTone="bad" />
      </div>

      <section className="panel">
        <div className="tabs-bar">
          {chips.map((chip) => (
            <button
              key={chip.label}
              className={`filter-chip ${isActive(chip.filter) ? 'is-active' : ''}`}
              onClick={() => {
                setFilter(chip.filter);
                setPage(0);
              }}
            >
              {chip.label} <span className="nav-count">{formatNumber(chip.count)}</span>
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
          <div className="input-icon" style={{ width: 'min(440px, 100%)' }}>
            <Search size={16} />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Buscar por nome ou número…"
              aria-label="Buscar contatos"
            />
          </div>
          <button className="icon" onClick={() => void reload()} title="Atualizar"><RefreshCw size={16} /></button>
        </div>
      </section>

      <section className="panel flush">
        {!data ? (
          <p className="empty">Carregando…</p>
        ) : data.contacts.length === 0 ? (
          <p className="empty">Nenhum contato encontrado.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Contato / nome</th>
                  <th>Telefone</th>
                  <th>Status</th>
                  <th>Recebidas</th>
                  <th>Mensagem</th>
                  <th>Linha de saída</th>
                  <th>Último envio</th>
                  <th className="right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {data.contacts.map((contact) => {
                  const processing = PROCESSING_LABEL[contact.processingStatus];
                  const blocked = contact.status === 'blocked';
                  return (
                    <tr key={contact.id} className={blocked ? 'is-blocked' : ''}>
                      <td>
                        <div className="contact-cell">
                          <span className="avatar">{(contact.name ?? '#').trim().charAt(0).toUpperCase()}</span>
                          <span className="cell-stack">
                            <strong>{contact.name ?? <span className="muted">Sem nome</span>}</strong>
                            {blocked && <span className="cell-sub bad-text">Bloqueado</span>}
                          </span>
                        </div>
                      </td>
                      <td className="mono">{formatPhone(contact.phone)}</td>
                      <td>
                        <Badge tone={processing.tone}><span className="dot" />{processing.text}</Badge>
                        {contact.lastError && contact.processingStatus !== 'sent' && (
                          <div className="line-error" title={contact.lastError} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.lastError}</div>
                        )}
                      </td>
                      <td><span className="num-badge is-muted">{formatNumber(contact.messagesReceived)}</span></td>
                      <td>{contact.lastMessageLabel ? <span className="chip"><Megaphone size={12} /> {contact.lastMessageLabel}</span> : <span className="muted">—</span>}</td>
                      <td>{contact.lastLineLabel ? <span className="row"><span className="dot info-text" /> {contact.lastLineLabel}</span> : <span className="muted">—</span>}</td>
                      <td className="small">{contact.lastSentAt ? <span className="row"><Clock size={13} className="subtle" />{formatDateTime(contact.lastSentAt)}</span> : '—'}</td>
                      <td>
                        <div className="icon-actions">
                          <button onClick={() => setHistoryOf(contact)} title="Histórico" aria-label="Histórico"><History size={16} /></button>
                          <button onClick={() => setEditing(contact)} title="Editar" aria-label="Editar"><Pencil size={16} /></button>
                          <button
                            className={blocked ? 'is-on' : ''}
                            title={blocked ? 'Desbloquear' : 'Bloquear'}
                            aria-label={blocked ? 'Desbloquear' : 'Bloquear'}
                            onClick={() => void run(() => api.updateContact(contact.id, { status: blocked ? 'active' : 'blocked' }))}
                          >
                            <Ban size={16} />
                          </button>
                          <button
                            className="danger"
                            title="Excluir"
                            aria-label="Excluir"
                            onClick={() => {
                              if (confirm(`Excluir ${contact.name ?? contact.phone}? O histórico deste contato também será apagado.`)) {
                                void run(() => api.removeContact(contact.id));
                              }
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data && (
          <div className="table-footer">
            <span className="row">
              Mostrando {data.total === 0 ? 0 : page * pageSize + 1}–{Math.min(data.total, (page + 1) * pageSize)} de <b>{formatNumber(data.total)}</b> contatos
              <span className="subtle">|</span>
              Linhas por página:
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} aria-label="Linhas por página">
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </span>
            <div className="pager">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Anterior"><ChevronLeft size={15} /></button>
              {pageList(page, totalPages).map((p, i) =>
                p === '…' ? <span key={`e${i}`} className="subtle">…</span> : (
                  <button key={p} className={p === page ? 'is-active' : ''} onClick={() => setPage(p)}>{p + 1}</button>
                ),
              )}
              <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Próxima"><ChevronRight size={15} /></button>
            </div>
          </div>
        )}
      </section>

      {editing && (
        <ContactFormModal
          contact={editing === 'new' ? undefined : editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
        />
      )}
      {importing && (
        <ContactImportModal
          onClose={(changed) => {
            setImporting(false);
            if (changed) void reload();
          }}
        />
      )}
      {historyOf && <ContactHistoryModal contact={historyOf} onClose={() => setHistoryOf(null)} />}
    </>
  );
}
