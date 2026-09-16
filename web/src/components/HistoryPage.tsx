import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { api, exportUrl, messageOf } from '../api/client.ts';
import type { SendAttemptView } from '../api/types.ts';
import { formatNumber } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { formatPhone } from './ContactsPage.tsx';
import { FilterFields, type CommonFilters } from './FilterFields.tsx';
import { PageHeader } from './ui.tsx';

const PAGE = 100;
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Histórico: cada envio registrado, rastreável e filtrável. */
export function HistoryPage() {
  const [filters, setFilters] = useState<CommonFilters>({});
  const [rows, setRows] = useState<SendAttemptView[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = {
    from: filters.from,
    to: filters.to,
    lineId: filters.lineId,
    campaignId: filters.campaignId,
    contact: filters.contact,
    message: filters.message,
    result: filters.status === 'sent' || filters.status === 'failed' ? filters.status : undefined,
  } as const;

  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .history({ ...query, limit: PAGE + 1, offset: page * PAGE })
        .then(({ attempts }) => {
          setRows(attempts.slice(0, PAGE));
          setHasMore(attempts.length > PAGE);
          setError(null);
        })
        .catch((err) => setError(messageOf(err)));
    }, 200);
    return () => clearTimeout(timer);
  }, [JSON.stringify(filters), page]);

  return (
    <>
      <PageHeader
        title="Histórico de envios"
        subtitle="Cada tentativa registrada, com linha, mensagem, ciclo e resultado."
        actions={
          <a className="button-link soft" href={exportUrl('history', { ...filters, status: query.result })} download>
            <Download size={15} /> Exportar CSV
          </a>
        }
      />
      <FilterFields
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(0);
        }}
        statusOptions={[
          { value: 'sent', label: 'Enviado' },
          { value: 'failed', label: 'Falha' },
        ]}
      />
      {error && <p className="line-error">{error}</p>}
      <section className="panel flush">
        {rows.length === 0 ? (
          <p className="empty">Nenhum registro.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Data</th><th>Hora</th><th>Contato</th><th>Telefone</th><th>Linha</th><th>Mensagem</th><th>Disparo</th><th>Ciclo</th><th>Resultado</th><th>Erro</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{dateFmt.format(new Date(r.createdAt))}</td>
                    <td className="num">{timeFmt.format(new Date(r.createdAt))}</td>
                    <td>{r.contactName ?? <span className="muted">—</span>}</td>
                    <td className="mono">{formatPhone(r.contactPhone)}</td>
                    <td>{r.lineLabel ?? '—'}</td>
                    <td title={r.renderedBody ?? undefined}>{r.messageLabel ? <span className="chip">{r.messageLabel}</span> : '—'}</td>
                    <td>{r.campaignName}</td>
                    <td className="num">{r.cycleNumber ?? '—'}</td>
                    <td><Badge tone={r.result === 'sent' ? 'ok' : 'bad'}><span className="dot" />{r.result === 'sent' ? 'Enviado' : 'Falha'}</Badge></td>
                    <td className="small bad-text">{r.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>Página {formatNumber(page + 1)} · até {PAGE} registros por página</span>
          <div className="pager">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={15} /> Anterior</button>
            <button disabled={!hasMore} onClick={() => setPage((p) => p + 1)}>Próxima <ChevronRight size={15} /></button>
          </div>
        </div>
      </section>
    </>
  );
}
