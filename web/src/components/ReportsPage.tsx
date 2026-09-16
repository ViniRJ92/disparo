import { useEffect, useState } from 'react';
import { CheckCircle2, CloudDownload, Database, Download, FileSpreadsheet, GitBranch, Hourglass, Info, MessageSquareWarning, RefreshCw, TableProperties } from 'lucide-react';
import { api, exportUrl } from '../api/client.ts';
import type { ExportFilters, ExportKind, SendAttemptView } from '../api/types.ts';
import { useLiveResource } from '../hooks/useLiveResource.ts';
import { formatDateTime, formatNumber, LINE_STATUS_LABEL } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { formatPhone } from './ContactsPage.tsx';
import { FilterFields } from './FilterFields.tsx';
import { PageHeader, percent, Progress, ratio, twoDigits } from './ui.tsx';

const KINDS: ExportKind[] = ['sent', 'failed', 'pending', 'history'];
type Counts = Partial<Record<ExportKind, number | string>>;

function kindAcceptsStatus(kind: ExportKind, status: string | undefined): boolean {
  if (!status) return true;
  if (kind === 'history') return status === 'sent' || status === 'failed';
  if (kind === 'pending') return ['pending', 'waiting', 'processing'].includes(status);
  return false;
}
const scoped = (kind: ExportKind, filters: ExportFilters): ExportFilters => ({ ...filters, status: kindAcceptsStatus(kind, filters.status) ? filters.status : undefined });
const num = (v: number | string | undefined) => (typeof v === 'number' ? v : 0);

function ExportButton({ kind, filters, count, label, className = '' }: { kind: ExportKind; filters: ExportFilters; count: number | string | undefined; label: string; className?: string }) {
  const empty = typeof count === 'number' && count === 0;
  return (
    <a className={`button-link ${className} ${empty ? 'is-disabled' : ''}`} href={exportUrl(kind, scoped(kind, filters))} download aria-disabled={empty}>
      <Download size={14} /> {label}
    </a>
  );
}

/** Relatórios: filtros antes da exportação, exportação geral, por linha e amostra do arquivo. */
export function ReportsPage() {
  const [filters, setFilters] = useState<ExportFilters>({});
  const [counts, setCounts] = useState<Counts>({});
  const [lineCounts, setLineCounts] = useState<Record<string, { sent: number; failed: number }>>({});
  const [sample, setSample] = useState<SendAttemptView[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const { data: overview } = useLiveResource(api.overview, ['line.updated', 'line.removed']);
  const lines = overview?.lineDetails ?? [];
  const lineKey = lines.map((l) => l.id).join(',');

  // Quantidade de registros de cada CSV com os filtros atuais (consultada no servidor).
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const kind of KINDS) {
        api
          .exportCount(kind, scoped(kind, filters))
          .then(({ rows }) => setCounts((c) => ({ ...c, [kind]: rows })))
          .catch((error: Error) => setCounts((c) => ({ ...c, [kind]: error.message })));
      }
      const lineFilters = filters.lineId ? lines.filter((l) => l.id === filters.lineId) : lines;
      Promise.all(
        lineFilters.map(async (line) => {
          const [sent, failed] = await Promise.all([
            api.exportCount('sent', { ...filters, status: undefined, lineId: line.id }),
            api.exportCount('failed', { ...filters, status: undefined, lineId: line.id }),
          ]);
          return [line.id, { sent: sent.rows, failed: failed.rows }] as const;
        }),
      )
        .then((entries) => setLineCounts(Object.fromEntries(entries)))
        .catch(() => undefined);
      const result = filters.status === 'sent' || filters.status === 'failed' ? filters.status : undefined;
      api
        .history({ ...filters, result, limit: 5 })
        .then(({ attempts }) => setSample(attempts))
        .catch(() => setSample([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [JSON.stringify(filters), lineKey, refresh]);

  const sent = num(counts.sent);
  const failed = num(counts.failed);
  const pending = num(counts.pending);
  const history = num(counts.history);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const visibleLines = filters.lineId ? lines.filter((l) => l.id === filters.lineId) : lines;
  const totalLineSent = Object.values(lineCounts).reduce((s, c) => s + c.sent, 0);

  return (
    <>
      <PageHeader
        title="Central de Relatórios & Exportação"
        badge={
          <>
            <Badge tone="ok"><span className="dot" />Dados em tempo real</Badge>
            <Badge tone="info"><FileSpreadsheet size={12} /> CSV · UTF-8 com BOM</Badge>
            <Badge tone="muted">{timezone}</Badge>
          </>
        }
        subtitle="Filtre o período e baixe os arquivos gerais ou de cada linha."
        actions={<ExportButton kind="history" filters={filters} count={counts.history} label="Baixar histórico completo" className="soft" />}
      />

      <FilterFields
        title="Parâmetros de filtragem"
        value={filters}
        onChange={setFilters}
        statusOptions={[
          { value: 'sent', label: 'Enviados (histórico)' },
          { value: 'failed', label: 'Falhas (histórico)' },
          { value: 'pending', label: 'Pendentes (fila)' },
          { value: 'waiting', label: 'Aguardando (fila)' },
          { value: 'processing', label: 'Enviando agora (fila)' },
        ]}
        footer={<><span className="dot ok-text" /> Registros encontrados: <b className="num">{formatNumber(history)}</b> no histórico com os filtros atuais</>}
      />

      <div className="section-heading">
        <div className="panel-title"><TableProperties size={19} /><h2>Métricas globais & exportação imediata</h2></div>
        {filters.status && <span className="small muted">Arquivos em que o filtro de status não se aplica ignoram esse filtro</span>}
      </div>
      <div className="grid-4">
        <div className="export-card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="dot-label ok-text"><span className="dot" />Envios bem-sucedidos</span>
            <CheckCircle2 size={17} className="ok-text" />
          </div>
          <div className="kpi-value"><strong>{formatNumber(sent)}</strong><span className="small ok-text">{percent(sent, sent + failed)} de sucesso</span></div>
          <p className="small muted">Mensagens entregues ao WhatsApp pelas linhas.</p>
          <ExportButton kind="sent" filters={filters} count={counts.sent} label={sent ? 'Exportar enviados (CSV)' : 'Nenhum enviado'} className="ok-outline" />
        </div>
        <div className="export-card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="dot-label muted"><span className="dot" />Falhas / erros</span>
            <MessageSquareWarning size={17} className={failed ? 'bad-text' : 'muted'} />
          </div>
          <div className="kpi-value"><strong>{formatNumber(failed)}</strong><span className="small muted">{percent(failed, sent + failed)} de falha</span></div>
          <p className="small muted">Envios que não foram entregues, com o motivo registrado.</p>
          <ExportButton kind="failed" filters={filters} count={counts.failed} label={failed ? 'Exportar falhas (CSV)' : 'Exportar falhas (0 registros)'} />
        </div>
        <div className="export-card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="dot-label info-text"><span className="dot" />Fila pendente</span>
            <Hourglass size={17} className="info-text" />
          </div>
          <div className="kpi-value"><strong>{formatNumber(pending)}</strong><span className="small info-text">{pending ? 'na fila' : 'Fila limpa'}</span></div>
          <p className="small muted">Contatos aguardando envio nos disparos.</p>
          <ExportButton kind="pending" filters={filters} count={counts.pending} label={pending ? 'Exportar pendentes (CSV)' : 'Fila vazia (0 registros)'} />
        </div>
        <div className="export-card is-primary">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="dot-label primary-text"><span className="dot" />Histórico completo</span>
            <Database size={17} className="primary-text" />
          </div>
          <div className="kpi-value"><strong>{formatNumber(history)}</strong><span className="small muted">tentativas registradas</span></div>
          <p className="small muted">Todas as tentativas com linha, mensagem, ciclo e horário.</p>
          <ExportButton kind="history" filters={filters} count={counts.history} label="Baixar histórico completo CSV" className="soft" />
        </div>
      </div>

      <div className="section-heading">
        <div>
          <div className="panel-title"><GitBranch size={19} className="info-text" /><h2>Exportação por linha</h2></div>
          <p className="panel-subtitle">Aplica os filtros acima; cada arquivo contém somente a linha indicada.</p>
        </div>
        <div className="row">
          <Badge tone="ok"><span className="dot" />{lines.filter((l) => l.status === 'active').length} ativa(s)</Badge>
          <Badge tone="muted"><span className="dot" />{lines.filter((l) => l.status !== 'active').length} fora de operação</Badge>
        </div>
      </div>
      <section className="panel flush">
        {visibleLines.length === 0 ? (
          <p className="empty">Nenhuma linha cadastrada.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Identificação da linha</th>
                  <th>Status do canal</th>
                  <th>Volume</th>
                  <th>Taxa de sucesso</th>
                  <th>Falhas</th>
                  <th className="right">Ações de exportação</th>
                </tr>
              </thead>
              <tbody>
                {visibleLines.map((line) => {
                  const c = lineCounts[line.id];
                  const status = LINE_STATUS_LABEL[line.status];
                  const idle = !c || c.sent + c.failed === 0;
                  return (
                    <tr key={line.id} className={idle && line.status !== 'active' ? 'is-dim' : ''}>
                      <td>
                        <div className="cell-title">
                          <span className={`num-badge ${line.status === 'active' ? '' : 'is-muted'}`}>{twoDigits(lines.indexOf(line) + 1)}</span>
                          <span className="cell-stack"><strong>{line.label}</strong><span className="cell-sub mono">{line.accountId ?? 'Conta não identificada'}</span></span>
                        </div>
                      </td>
                      <td><Badge tone={status.tone}><span className="dot" />{status.text}</Badge></td>
                      <td>
                        {c ? (
                          <span className="cell-stack"><strong className="num">{formatNumber(c.sent)} envios</strong><span className="cell-sub">{percent(c.sent, totalLineSent)} do total</span></span>
                        ) : <span className="muted">…</span>}
                      </td>
                      <td>
                        {c && !idle ? (
                          <div className="bar-cell"><Progress value={ratio(c.sent, c.sent + c.failed)} /><span className="small ok-text num">{percent(c.sent, c.sent + c.failed)}</span></div>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className={c?.failed ? 'bad-text num' : 'muted num'}>{c ? `${formatNumber(c.failed)} erro(s)` : '—'}</td>
                      <td>
                        {idle ? (
                          <div className="export-actions"><span className="small subtle">Nenhum registro no período</span></div>
                        ) : (
                          <div className="export-actions">
                            <ExportButton kind="sent" filters={{ ...filters, lineId: line.id }} count={c?.sent} label={`Enviados (${formatNumber(c?.sent ?? 0)})`} className="sm" />
                            <ExportButton kind="failed" filters={{ ...filters, lineId: line.id }} count={c?.failed} label={`Falhas (${formatNumber(c?.failed ?? 0)})`} className="sm" />
                            <ExportButton kind="history" filters={{ ...filters, lineId: line.id }} count={undefined} label="CSV histórico" className="sm soft" />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <FileSpreadsheet size={19} />
            <div>
              <h2>Amostra do arquivo</h2>
              <p className="panel-subtitle">Os 5 registros mais recentes do histórico com os filtros aplicados.</p>
            </div>
          </div>
          <button className="sm" onClick={() => setRefresh((n) => n + 1)}><RefreshCw size={14} /> Atualizar amostra</button>
        </div>
        {!sample ? (
          <p className="empty">Carregando…</p>
        ) : sample.length === 0 ? (
          <p className="empty">Nenhum registro no histórico com estes filtros.</p>
        ) : (
          <div className="table-wrap" style={{ border: '1px solid var(--hairline)', borderRadius: 12 }}>
            <table className="table">
              <thead>
                <tr><th>Disparo</th><th>Destinatário</th><th>Telefone</th><th>Linha</th><th>Mensagem</th><th>Data e hora</th><th className="right">Resultado</th></tr>
              </thead>
              <tbody>
                {sample.map((r) => (
                  <tr key={r.id}>
                    <td className="primary-text">{r.campaignName}</td>
                    <td>{r.contactName ?? <span className="muted">Sem nome</span>}</td>
                    <td className="mono">{formatPhone(r.contactPhone)}</td>
                    <td>{r.lineLabel ?? '—'}{r.cycleNumber !== null && <span className="cell-sub"> · ciclo {r.cycleNumber}</span>}</td>
                    <td title={r.renderedBody ?? undefined}>{r.messageLabel ?? '—'}</td>
                    <td className="small num">{formatDateTime(r.createdAt)}</td>
                    <td className="right">
                      <Badge tone={r.result === 'sent' ? 'ok' : 'bad'}>{r.result === 'sent' ? 'Enviado' : 'Falha'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="footnote">
          <span className="row"><Info size={14} className="info-text" /> Abre direto no Excel e no Google Sheets.</span>
          <span>Codificação: <b>UTF-8 com BOM</b> · Separador: <b>ponto e vírgula (;)</b> · <CloudDownload size={13} style={{ verticalAlign: -2 }} /> gerado na hora pelo servidor</span>
        </div>
      </section>
    </>
  );
}
