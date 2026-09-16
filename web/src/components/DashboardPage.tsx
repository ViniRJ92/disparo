import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, ChevronRight, Clock, Cpu, Download, History, LineChart, MessageSquareText, RefreshCw, Rocket, Search, SendHorizontal, ShieldAlert, Wifi } from 'lucide-react';
import { api, exportUrl } from '../api/client.ts';
import type { DashboardLineRow, GlobalOverview, LineStatus } from '../api/types.ts';
import type { Section } from '../App.tsx';
import { useLiveResource } from '../hooks/useLiveResource.ts';
import { CAMPAIGN_STATUS_LABEL, formatDateTime, formatNumber, LINE_STATUS_LABEL } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { CampaignsPanel } from './CampaignsPanel.tsx';
import { LineDetailModal } from './LineDetailModal.tsx';
import { EmptyState, KpiCard, PageHeader, percent, Progress, ratio, twoDigits } from './ui.tsx';

const LIVE_EVENTS = ['line.updated', 'line.removed', 'send.recorded', 'campaign.updated', 'worker.updated', 'distribution.round', 'messages.updated'];

type StatusFilter = '' | 'active' | 'paused' | 'error' | 'disconnected' | 'connected';
const STATUS_FILTERS: { value: StatusFilter; label: string; match: (s: LineStatus) => boolean }[] = [
  { value: '', label: 'Todos os status', match: () => true },
  { value: 'active', label: 'Ativas', match: (s) => s === 'active' },
  { value: 'paused', label: 'Pausadas', match: (s) => s === 'paused' },
  { value: 'connected', label: 'Conectadas (paradas)', match: (s) => s === 'connected' },
  { value: 'error', label: 'Com erro', match: (s) => s === 'error' },
  { value: 'disconnected', label: 'Desconectadas', match: (s) => s === 'disconnected' || s === 'connecting' || s === 'reconnecting' },
];

interface Props {
  overview: GlobalOverview;
  onNewDispatch: () => void;
  onNavigate: (section: Section) => void;
  onError: (message: string) => void;
}

/** Dashboard: todos os números são lidos do banco e do estado vivo das linhas. */
export function DashboardPage({ overview, onNewDispatch, onNavigate, onError }: Props) {
  const [campaignId, setCampaignId] = useState('');
  const [detailOf, setDetailOf] = useState<DashboardLineRow | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const { data: campaigns } = useLiveResource(api.campaigns, ['campaign.updated']);
  const { data, error, reload } = useLiveResource(() => api.dashboard(campaignId || undefined), LIVE_EVENTS, 1000);

  useEffect(() => {
    void reload();
  }, [campaignId, reload]);

  const accountOf = useMemo(() => new Map(overview.lineDetails.map((l) => [l.id, l.accountId])), [overview.lineDetails]);

  if (error && !data) return <p className="line-error">{error}</p>;
  if (!data) return <p className="empty">Carregando…</p>;
  const { lines, processing, perLine } = data;

  const matcher = STATUS_FILTERS.find((f) => f.value === statusFilter)!.match;
  const term = search.trim().toLowerCase();
  const rows = perLine.filter((r) => matcher(r.status) && (!term || r.label.toLowerCase().includes(term) || (accountOf.get(r.lineId) ?? '').toLowerCase().includes(term)));
  const finished = processing.sent + processing.failed;
  const running = overview.activeCampaigns.filter((c) => c.status === 'running').length;

  return (
    <>
      <PageHeader
        title="Dashboard Geral"
        badge={<Badge tone={overview.lines.total > 0 ? 'ok' : 'muted'}><span className="dot" />{running > 0 ? `${running} disparo(s) em andamento` : 'Sem disparo em andamento'}</Badge>}
        subtitle="Monitoramento em tempo real das linhas e do volume de disparos."
        actions={
          <>
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Escopo do processamento">
              <option value="">Todos os disparos</option>
              {(campaigns?.campaigns ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {CAMPAIGN_STATUS_LABEL[c.status].text}</option>
              ))}
            </select>
            <span className="info-pill">
              <RefreshCw size={13} /> Última atualização: <b className="num">{new Date(data.generatedAt).toLocaleTimeString('pt-BR')}</b>
            </span>
            <button className="soft" onClick={onNewDispatch}><Rocket size={15} /> Iniciar novo disparo</button>
          </>
        }
      />

      <div className="grid-4">
        <KpiCard
          label="Taxa de entrega / Enviados"
          icon={<MessageSquareText size={16} />}
          iconTone="ok"
          value={percent(processing.sent, finished)}
          suffix={<span className="small ok-text">{formatNumber(processing.sent)} com sucesso</span>}
          progress={ratio(processing.sent, finished)}
          foot={<><span><b>{formatNumber(processing.sent)}</b> enviados</span><span><b>{formatNumber(processing.skipped)}</b> não enviados</span></>}
        />
        <KpiCard
          label="Volume processado"
          icon={<Activity size={16} />}
          iconTone="info"
          value={`${formatNumber(processing.processed)} / ${formatNumber(processing.total)}`}
          suffix={<span className="small info-text">{percent(processing.processed, processing.total)} da fila</span>}
          progress={ratio(processing.processed, processing.total)}
          progressTone="info"
          foot={<><span>Contatos cadastrados: <b>{formatNumber(processing.contactsRegistered)}</b></span><span><b>{formatNumber(processing.pending)}</b> pendentes</span></>}
        />
        <KpiCard
          label="Falhas & erros"
          icon={<ShieldAlert size={16} />}
          iconTone={processing.failed > 0 ? 'bad' : 'ok'}
          value={percent(processing.failed, finished)}
          suffix={<Badge tone={processing.failed > 0 ? 'bad' : 'ok'}>{formatNumber(processing.failed)} erro(s)</Badge>}
          progress={ratio(processing.failed, finished)}
          progressTone="bad"
          foot={<><span>{processing.processing > 0 ? `${processing.processing} enviando agora` : 'Nenhum envio em curso'}</span></>}
        />
        <KpiCard
          label="Capacidade de linhas"
          icon={<Cpu size={16} />}
          iconTone="primary"
          value={`${lines.total} / ${lines.max}`}
          suffix={<Badge tone="primary">{lines.active} ativas · {lines.paused} pausadas</Badge>}
          progress={ratio(lines.total, lines.max)}
          progressTone="primary"
          foot={<><span>{percent(lines.total, lines.max)} da capacidade</span><span className="primary-text">+{Math.max(0, lines.max - lines.total)} disponíveis</span></>}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span className="kpi-icon primary"><Wifi size={16} /></span>
            <div>
              <h2>Saúde e conectividade das linhas</h2>
              <p className="panel-subtitle">Situação atual de cada número conectado.</p>
            </div>
          </div>
          <div className="row">
            <span className="info-pill">
              <Clock size={13} /> Pausa programada:{' '}
              <b>{data.scheduledPause.enabled ? (data.scheduledPause.limit === null ? 'sem limite' : `${data.scheduledPause.limit} por linha`) : 'desativada'}</b>
              ({lines.pausedBySchedule} em pausa)
            </span>
            <span className="info-pill">
              <MessageSquareText size={13} /> Mensagens: <b>{data.messages.active} ativas de {data.messages.total}</b>
            </span>
            <button className="ghost sm" onClick={() => onNavigate('lines')}>Gerenciar linhas <ChevronRight size={14} /></button>
          </div>
        </div>
        <div className="health-bar">
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span className="row"><span className="dot ok-text" /> {percent(lines.connected, lines.total)} das linhas conectadas</span>
            <span className="muted">{lines.connected} conectadas de {lines.total} cadastradas</span>
          </div>
          <Progress value={ratio(lines.connected, lines.total)} />
          <div className="health-segments">
            <div className="health-seg"><span className="row"><span className="dot ok-text" /> <b>{lines.active}</b> Ativas</span><span className="muted">{lines.connected} conectadas</span></div>
            <div className="health-seg"><span className="row"><span className="dot warn-text" /> <b>{lines.paused}</b> Pausadas</span><span className="muted">{percent(lines.paused, lines.total)}</span></div>
            <div className="health-seg"><span className="row"><span className="dot bad-text" /> <b>{lines.withError}</b> Com erro</span><span className={lines.withError ? 'bad-text' : 'ok-text'}>{lines.withError ? 'Verificar' : 'OK'}</span></div>
            <div className="health-seg"><span className="row"><span className="dot subtle" /> <b>{lines.disconnected}</b> Desconectadas</span><span className="muted">{lines.connecting > 0 ? `${lines.connecting} conectando` : '—'}</span></div>
            <div className="health-seg"><span className="row"><span className="dot info-text" /> <b>{lines.participating}</b> Em disparo</span><span className="muted">{lines.participating ? 'Enviando' : 'Livre'}</span></div>
          </div>
        </div>
        {data.cycles.length > 0 && (
          <>
            <h3 className="section-title">Ciclo atual</h3>
            <div className="cycle-list">
              {data.cycles.map((c) => (
                <div key={c.campaignId} className="cycle-card">
                  <strong>{c.name}</strong>
                  <Badge tone={CAMPAIGN_STATUS_LABEL[c.status].tone}>{CAMPAIGN_STATUS_LABEL[c.status].text}</Badge>
                  {c.current ? (
                    <>
                      <span className="muted">Ciclo {c.current.number} · intervalo {c.current.intervalSeconds}s</span>
                      {c.current.quotas.map((q) => (
                        <span key={q.lineId} className={`chip ${q.active ? 'chip-on' : ''}`}>
                          {perLine.find((r) => r.lineId === q.lineId)?.label ?? 'linha removida'} {q.used}/{q.assigned}{q.active ? '' : ' (fora)'}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="muted">Nenhum ciclo em andamento{c.finishedCycles > 0 && ` (${c.finishedCycles} finalizado(s))`}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel flush">
        <div className="panel-header" style={{ paddingBottom: 16, marginBottom: 0 }}>
          <div className="row">
            <div className="input-icon" style={{ width: 260 }}>
              <Search size={15} />
              <input type="search" placeholder="Buscar linha por nome ou conta…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="Filtrar por status">
              {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="row">
            <a className="button-link sm" href={exportUrl('history', { campaignId: campaignId || undefined })} download>
              <Download size={14} /> Exportar CSV
            </a>
            <span className="info-pill">Total: <b>{rows.length} linha(s)</b></span>
          </div>
        </div>
        {perLine.length === 0 ? (
          <p className="empty">Nenhuma linha cadastrada.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Identificação da linha</th>
                  <th>Status & conexão</th>
                  <th>Em disparo</th>
                  <th>Ciclo / cota</th>
                  <th>Pausa prog.</th>
                  <th>Volumetria & conclusão</th>
                  <th title="Contatos aguardando nos disparos em que a linha participa (fila compartilhada)">Pendentes</th>
                  <th>Erros</th>
                  <th>Último envio</th>
                  <th className="right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const status = LINE_STATUS_LABEL[row.status];
                  const done = row.sent + row.failed;
                  return (
                    <tr key={row.lineId} onClick={() => setDetailOf(row)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setDetailOf(row)}>
                      <td>
                        <div className="cell-title">
                          <span className={`num-badge ${row.status === 'active' ? '' : 'is-muted'}`}>{twoDigits(perLine.indexOf(row) + 1 || index + 1)}</span>
                          <span className="cell-stack">
                            <strong>{row.label}</strong>
                            <span className="cell-sub mono">{accountOf.get(row.lineId) ?? 'Conta não identificada'}</span>
                          </span>
                        </div>
                      </td>
                      <td><Badge tone={status.tone}><span className="dot" />{status.text}</Badge></td>
                      <td>{row.participating ? <Badge tone="info">No disparo</Badge> : <span className="muted small">Fora do disparo</span>}</td>
                      <td className="num">{row.cycleQuota ? `${row.cycleQuota.used}/${row.cycleQuota.assigned}${row.cycleQuota.active ? '' : ' (fora)'}` : '—'}</td>
                      <td className="num">
                        {row.scheduledPause.enabled && row.scheduledPause.limit !== null ? `${row.scheduledPause.count}/${row.scheduledPause.limit}` : <span className="muted">Inativa</span>}
                      </td>
                      <td>
                        <div className="bar-cell">
                          <span className="num small">{formatNumber(row.sent)} / {formatNumber(done)}</span>
                          <Progress value={ratio(row.sent, done)} />
                          <span className="small ok-text num">{percent(row.sent, done)}</span>
                        </div>
                      </td>
                      <td className="num">{formatNumber(row.pending)}</td>
                      <td>
                        <span className={`row small ${row.failed ? 'bad-text' : 'ok-text'}`}>
                          <CheckCircle2 size={14} /> {formatNumber(row.failed)} erro(s)
                        </span>
                      </td>
                      <td className="small"><span className="row"><Clock size={13} className="subtle" />{formatDateTime(row.lastSentAt)}</span></td>
                      <td className="right">
                        <button className="ghost icon" title="Ver detalhes" onClick={(e) => { e.stopPropagation(); setDetailOf(row); }}>
                          <LineChart size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>Mostrando <b>{rows.length}</b> de <b>{perLine.length}</b> linha(s)</span>
          <span className={lines.withError ? 'bad-text' : 'ok-text'}>
            <span className="dot" /> {lines.withError ? `${lines.withError} linha(s) com erro` : 'Nenhuma linha com erro'}
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span className="kpi-icon primary"><Rocket size={16} /></span>
            <h2>Disparos em andamento</h2>
            <Badge tone="muted">{running} em execução</Badge>
          </div>
          <button className="ghost sm" onClick={() => onNavigate('history')}><History size={14} /> Consultar histórico completo</button>
        </div>
        {overview.activeCampaigns.length === 0 ? (
          <EmptyState icon={<SendHorizontal size={22} />} title="Nenhum disparo em andamento no momento">
            <p className="muted">Crie um disparo escolhendo as linhas participantes e os contatos.</p>
            <div className="row" style={{ justifyContent: 'center', marginTop: 6 }}>
              <button className="primary" onClick={onNewDispatch}><Rocket size={15} /> Novo disparo</button>
              <button onClick={() => onNavigate('history')}><History size={15} /> Histórico de disparos</button>
            </div>
          </EmptyState>
        ) : (
          <CampaignsPanel campaigns={overview.activeCampaigns} lines={overview.lineDetails} distribution={overview.distribution} onError={onError} />
        )}
      </section>

      {detailOf && <LineDetailModal lineId={detailOf.lineId} campaignId={campaignId || undefined} onClose={() => setDetailOf(null)} />}
    </>
  );
}
