import { useEffect, useState } from 'react';
import { Activity, Download, MessagesSquare, RadioTower, Smile, TrendingUp, Users } from 'lucide-react';
import { api, exportUrl } from '../api/client.ts';
import type { AnalyticsFilters, AnalyticsOverview, AnalyticsPerson, InteractionCategory } from '../api/types.ts';
import { useLiveResource } from '../hooks/useLiveResource.ts';
import { formatDateTime, formatNumber, LINE_STATUS_LABEL } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { formatPhone } from './ContactsPage.tsx';
import { FilterFields } from './FilterFields.tsx';
import { PersonTimelineModal } from './PersonTimelineModal.tsx';
import { KpiCard, PageHeader, percent, ratio } from './ui.tsx';

const LIVE_EVENTS = ['send.recorded', 'conversation.recorded', 'line.updated'];
const PAGE = 50;
/** O Analytics recalcula todo o período: durante um disparo, recarrega no máximo a cada 3 s. */
const ANALYTICS_REFRESH_MS = 3000;

export const CATEGORY_LABEL: Record<InteractionCategory, { text: string; tone: 'ok' | 'info' | 'muted' }> = {
  replied: { text: 'Respondeu', tone: 'ok' },
  initiated: { text: 'Iniciou a conversa', tone: 'info' },
  no_reply: { text: 'Não respondeu', tone: 'muted' },
};

function MiniKpi({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{formatNumber(value)}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

const dayLabel = (day: string) => day.split('-').reverse().slice(0, 2).join('/');

/** Gráfico por dia (SVG simples): enviados, falhas e mensagens recebidas. */
function DailyChart({ days }: { days: AnalyticsOverview['sends']['byDay'] }) {
  if (days.length === 0) return <p className="empty">Sem envios ou conversas no período.</p>;
  const W = 900;
  const H = 220;
  const pad = { l: 36, r: 16, t: 16, b: 30 };
  const max = Math.max(1, ...days.map((d) => Math.max(d.sent, d.failed, d.inbound)));
  const x = (i: number) => pad.l + (days.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (days.length - 1));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const path = (key: 'sent' | 'failed' | 'inbound') => days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  const area = `${path('sent')} L${x(days.length - 1).toFixed(1)},${H - pad.b} L${x(0).toFixed(1)},${H - pad.b} Z`;
  const step = Math.ceil(days.length / 10);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Envios por dia" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="sentArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="rgba(255,255,255,0.08)" strokeDasharray="4 6" />
          <text x={pad.l - 8} y={y(max * f) + 4} textAnchor="end" fontSize="11" fill="#64748b">{Math.round(max * f)}</text>
        </g>
      ))}
      <path d={area} fill="url(#sentArea)" />
      <path d={path('sent')} fill="none" stroke="#10b981" strokeWidth="2.5" />
      <path d={path('inbound')} fill="none" stroke="#8b5cf6" strokeWidth="2" />
      <path d={path('failed')} fill="none" stroke="#f43f5e" strokeWidth="2" />
      {days.map((d, i) => (
        <g key={d.day}>
          <circle cx={x(i)} cy={y(d.sent)} r="3.5" fill="#10b981">
            <title>{`${dayLabel(d.day)}: ${d.sent} enviados, ${d.failed} falhas, ${d.inbound} recebidas`}</title>
          </circle>
          {i % step === 0 && <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="#94a3b8">{dayLabel(d.day)}</text>}
        </g>
      ))}
    </svg>
  );
}

/** Analytics: números derivados dos registros reais de envios e conversas de todas as linhas. */
export function AnalyticsPage() {
  const [filters, setFilters] = useState<AnalyticsFilters>({});
  const [page, setPage] = useState(0);
  const [personKey, setPersonKey] = useState<AnalyticsPerson | null>(null);
  const overview = useLiveResource(() => api.analyticsOverview(filters), LIVE_EVENTS, ANALYTICS_REFRESH_MS);
  const people = useLiveResource(() => api.analyticsPeople(filters, { limit: PAGE, offset: page * PAGE }), LIVE_EVENTS, ANALYTICS_REFRESH_MS);
  const { data: lines } = useLiveResource(api.overview, ['line.updated', 'line.removed']);

  useEffect(() => {
    const timer = setTimeout(() => {
      void overview.reload();
      void people.reload();
    }, 200);
    return () => clearTimeout(timer);
  }, [JSON.stringify(filters), page]);

  const data = overview.data;
  const error = overview.error ?? people.error;
  const lineOf = new Map((lines?.lineDetails ?? []).map((l) => [l.id, l]));
  const exportFilters = { from: filters.from, to: filters.to, lineId: filters.lineId, contact: filters.contact, message: filters.message, status: filters.status === 'sent' || filters.status === 'failed' ? filters.status : undefined };

  return (
    <>
      <PageHeader
        title="Analytics & Engajamento"
        badge={data && <Badge tone="ok"><span className="dot" />{percent(data.sends.sent, data.sends.sent + data.sends.failed)} de entrega</Badge>}
        subtitle="Envios, classificação das interações por pessoa e evolução diária, somando todas as linhas."
        actions={
          <>
            {lines && <span className="info-pill"><RadioTower size={13} /> <b>{lines.lineDetails.filter((l) => l.status === 'active').length} de {lines.lines.total}</b> linhas ativas</span>}
            <a className="button-link" href={exportUrl('history', exportFilters)} download><Download size={15} /> Exportar CSV</a>
          </>
        }
      />

      <FilterFields
        title="Filtros de segmentação"
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(0);
        }}
        withCampaign={false}
        statusOptions={[
          { value: 'sent', label: 'Envios: enviados' },
          { value: 'failed', label: 'Envios: falhas' },
          { value: 'replied', label: 'Pessoas: responderam' },
          { value: 'initiated', label: 'Pessoas: iniciaram a conversa' },
          { value: 'no_reply', label: 'Pessoas: não responderam' },
        ]}
      />
      {error && <p className="line-error">{error}</p>}

      {data && (
        <>
          <div className="section-heading">
            <span className="dot-label"><span className="dot ok-text" />Envios</span>
            <span className="small muted">Total no período: <b className="num">{formatNumber(data.sends.sent + data.sends.failed)}</b> tentativas</span>
          </div>
          <div className="grid-4">
            <KpiCard label="Total enviados" value={data.sends.sent} suffix={<span className="small muted">mensagens</span>}
              progress={ratio(data.sends.sent, data.sends.sent + data.sends.failed)} foot={<span>{percent(data.sends.sent, data.sends.sent + data.sends.failed)} das tentativas</span>} />
            <KpiCard label="Falhas de envio" value={data.sends.failed} suffix={<Badge tone={data.sends.failed ? 'bad' : 'ok'}>{percent(data.sends.failed, data.sends.sent + data.sends.failed)}</Badge>}
              progress={ratio(data.sends.failed, data.sends.sent + data.sends.failed)} progressTone="bad" foot={<span>Motivos no histórico e no CSV de falhas</span>} />
            <KpiCard label="Taxa de resposta geral" value={percent(data.classification.replied, data.classification.people)}
              suffix={<span className="small muted">{formatNumber(data.classification.replied)} resposta(s)</span>}
              progress={ratio(data.classification.replied, data.classification.people)} progressTone="primary" foot={<span>Pessoas que responderam após receber</span>} />
            <KpiCard label="Pessoas com interação" value={data.classification.people} suffix={<span className="small muted">destinatários</span>}
              progress={data.classification.people ? 100 : 0} progressTone="info" foot={<span>Em {data.classification.byLine.length} linha(s)</span>} />
          </div>

          <div className="grid-2">
            <section className="panel">
              <div className="panel-header">
                <div className="panel-title"><RadioTower size={17} /><h3>Envios por linha</h3></div>
                <Badge tone="muted">{data.sends.byLine.length} linha(s)</Badge>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Linha</th><th className="right">Enviados</th><th className="right">Falhas</th><th className="right">Sucesso</th></tr></thead>
                  <tbody>
                    {data.sends.byLine.map((l) => (
                      <tr key={l.lineId ?? l.label}>
                        <td><span className="row"><span className={`dot ${l.lineId && lineOf.get(l.lineId)?.status === 'active' ? 'ok-text' : 'subtle'}`} />{l.label}</span></td>
                        <td className="right num">{formatNumber(l.sent)}</td>
                        <td className={`right num ${l.failed ? 'bad-text' : ''}`}>{formatNumber(l.failed)}</td>
                        <td className="right"><Badge tone="ok">{percent(l.sent, l.sent + l.failed)}</Badge></td>
                      </tr>
                    ))}
                    {data.sends.byLine.length > 0 && (
                      <tr>
                        <td><strong>Total</strong></td>
                        <td className="right num ok-text"><strong>{formatNumber(data.sends.sent)}</strong></td>
                        <td className="right num">{formatNumber(data.sends.failed)}</td>
                        <td className="right ok-text">{percent(data.sends.sent, data.sends.sent + data.sends.failed)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {data.sends.byLine.length === 0 && <p className="empty">Nenhum envio no período.</p>}
            </section>

            <section className="panel">
              <div className="panel-header">
                <div className="panel-title"><MessagesSquare size={17} /><h3>Envios por mensagem & taxa de resposta</h3></div>
                <Badge tone="muted">{data.sends.byMessage.length} mensagem(ns)</Badge>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Mensagem</th><th className="right">Enviados</th><th className="right">Pessoas</th><th className="right">Responderam</th><th className="right">Taxa</th></tr></thead>
                  <tbody>
                    {data.sends.byMessage.map((m, i) => (
                      <tr key={m.label}>
                        <td><span className="row"><span className="slot-num">{String.fromCharCode(65 + i)}</span>{m.label}</span></td>
                        <td className="right num">{formatNumber(m.sent)}</td>
                        <td className="right num">{formatNumber(m.people)}</td>
                        <td className="right num">{formatNumber(m.replied)}</td>
                        <td className="right num">{percent(m.replied, m.people)}</td>
                      </tr>
                    ))}
                    {data.sends.byMessage.length > 0 && (
                      <tr>
                        <td><strong>Total</strong></td>
                        <td className="right num ok-text"><strong>{formatNumber(data.sends.byMessage.reduce((s, m) => s + m.sent, 0))}</strong></td>
                        <td className="right num ok-text">{formatNumber(data.sends.byMessage.reduce((s, m) => s + m.people, 0))}</td>
                        <td className="right num">{formatNumber(data.sends.byMessage.reduce((s, m) => s + m.replied, 0))}</td>
                        <td className="right muted">—</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {data.sends.byMessage.length === 0 && <p className="empty">Nenhum envio no período.</p>}
            </section>
          </div>

          <div className="section-heading">
            <span className="dot-label"><span className="dot info-text" />Classificação das Interações</span>
          </div>
          <div className="stat-grid">
            <MiniKpi label="Pessoas" value={data.classification.people} />
            <MiniKpi label="Responderam" value={data.classification.replied} tone="ok" hint={percent(data.classification.replied, data.classification.people)} />
            <MiniKpi label="Iniciaram a conversa" value={data.classification.initiated} tone="info" hint={percent(data.classification.initiated, data.classification.people)} />
            <MiniKpi label="Não responderam" value={data.classification.noReply} tone="warn" hint={percent(data.classification.noReply, data.classification.people)} />
            <MiniKpi label="Mensagens recebidas" value={data.classification.inboundMessages} />
            <MiniKpi label="Mensagens em grupos" value={data.groups.messages} />
          </div>

          <section className="panel">
            <div className="panel-header">
              <div className="panel-title"><Smile size={17} /><h3>Classificação por linha</h3></div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Linha</th><th className="right">Pessoas</th><th className="right">Responderam</th><th className="right">Iniciaram</th><th className="right">Não responderam</th><th className="right">Taxa de retorno</th><th className="right">Status da linha</th></tr></thead>
                <tbody>
                  {data.classification.byLine.map((l) => {
                    const line = l.lineId ? lineOf.get(l.lineId) : undefined;
                    const status = line ? LINE_STATUS_LABEL[line.status] : null;
                    return (
                      <tr key={l.lineId ?? l.label}>
                        <td>{l.label}</td>
                        <td className="right num">{formatNumber(l.people)}</td>
                        <td className="right num ok-text">{formatNumber(l.replied)}</td>
                        <td className="right num info-text">{formatNumber(l.initiated)}</td>
                        <td className="right num">{formatNumber(l.noReply)}</td>
                        <td className="right num">{percent(l.replied, l.people)}</td>
                        <td className="right">{status ? <Badge tone={status.tone}>{status.text}</Badge> : <Badge tone="muted">Removida</Badge>}</td>
                      </tr>
                    );
                  })}
                  {data.classification.byLine.length > 0 && (
                    <tr>
                      <td><strong>Total de pessoas</strong></td>
                      <td className="right num ok-text"><strong>{formatNumber(data.classification.people)}</strong></td>
                      <td className="right num">{formatNumber(data.classification.replied)}</td>
                      <td className="right num">{formatNumber(data.classification.initiated)}</td>
                      <td className="right num">{formatNumber(data.classification.noReply)}</td>
                      <td className="right num">{percent(data.classification.replied, data.classification.people)}</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {data.classification.byLine.length === 0 && <p className="empty">Nenhuma interação no período.</p>}
          </section>

          <section className="panel">
            <div className="panel-header">
              <div className="panel-title"><TrendingUp size={17} className="ok-text" /><h3>Por dia</h3></div>
              <div className="row small">
                <span className="row"><span className="dot ok-text" />Enviados ({formatNumber(data.sends.sent)})</span>
                <span className="row"><span className="dot bad-text" />Falhas ({formatNumber(data.sends.failed)})</span>
                <span className="row"><span className="dot" style={{ color: '#8b5cf6' }} />Recebidas ({formatNumber(data.classification.inboundMessages)})</span>
              </div>
            </div>
            <div style={{ background: 'var(--bg)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '14px 12px 6px' }}>
              <div className="row small muted" style={{ justifyContent: 'space-between', padding: '0 6px 6px' }}>
                <span className="row"><Activity size={13} /> Maior volume diário: <b className="num">{formatNumber(Math.max(0, ...data.sends.byDay.map((d) => d.sent)))} enviados</b></span>
                {data.sends.byDay.length > 0 && <span>Período: {dayLabel(data.sends.byDay[0]!.day)} – {dayLabel(data.sends.byDay[data.sends.byDay.length - 1]!.day)}</span>}
              </div>
              <DailyChart days={data.sends.byDay} />
            </div>
          </section>
        </>
      )}

      <section className="panel flush">
        <div className="panel-header" style={{ paddingBottom: 16, marginBottom: 0 }}>
          <div className="panel-title"><Users size={17} /><h3>Pessoas</h3><Badge tone="muted">{formatNumber(people.data?.total ?? 0)}</Badge></div>
        </div>
        {people.data && people.data.people.length > 0 ? (
          <div className="table-wrap">
            <table className="table table-clickable">
              <thead>
                <tr><th>Pessoa</th><th>Telefone</th><th>Classificação</th><th>Linhas</th><th className="right">Recebeu</th><th className="right">Escreveu</th><th>Última interação</th></tr>
              </thead>
              <tbody>
                {people.data.people.map((p) => (
                  <tr key={p.personKey} onClick={() => setPersonKey(p)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setPersonKey(p)}>
                    <td><button className="link-button">{p.name ?? (p.phone ? formatPhone(p.phone) : p.personKey)}</button></td>
                    <td className="mono">{p.phone ? formatPhone(p.phone) : '—'}</td>
                    <td><Badge tone={CATEGORY_LABEL[p.category].tone}><span className="dot" />{CATEGORY_LABEL[p.category].text}</Badge></td>
                    <td>{p.lines.map((l) => <span key={l} className="chip">{l}</span>)}</td>
                    <td className="right num">{formatNumber(p.received)}</td>
                    <td className="right num">{formatNumber(p.inbound)}</td>
                    <td className="small">{formatDateTime(p.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">Nenhuma pessoa com interação.</p>
        )}
        {(people.data?.total ?? 0) > PAGE && (
          <div className="table-footer">
            <span>Página {page + 1} de {Math.ceil((people.data?.total ?? 0) / PAGE)}</span>
            <div className="pager">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</button>
              <button disabled={(page + 1) * PAGE >= (people.data?.total ?? 0)} onClick={() => setPage((p) => p + 1)}>Próxima</button>
            </div>
          </div>
        )}
      </section>

      {personKey && <PersonTimelineModal person={personKey} onClose={() => setPersonKey(null)} />}
    </>
  );
}
