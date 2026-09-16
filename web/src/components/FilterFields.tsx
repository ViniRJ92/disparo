import type { ReactNode } from 'react';
import { CalendarDays, CircleDot, Eraser, Layers, MessageSquare, RadioTower, SlidersHorizontal, User } from 'lucide-react';
import { api } from '../api/client.ts';
import { useLiveResource } from '../hooks/useLiveResource.ts';

export interface CommonFilters {
  from?: string;
  to?: string;
  lineId?: string;
  status?: string;
  campaignId?: string;
  contact?: string;
  message?: string;
}

interface Props<F extends CommonFilters> {
  value: F;
  onChange: (next: F) => void;
  statusOptions: { value: string; label: string }[];
  /** Mostrar o filtro de campanha/disparo. */
  withCampaign?: boolean;
  /** Mostrar o filtro de mensagem. */
  withMessage?: boolean;
  title?: string;
  /** Texto à esquerda do rodapé (ex.: quantidade de resultados). */
  footer?: ReactNode;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type Period = 'today' | '7d' | '30d' | 'month' | 'all';
function periodRange(period: Period): { from?: string; to?: string } {
  const now = new Date();
  if (period === 'all') return {};
  if (period === 'today') return { from: iso(now), to: iso(now) };
  if (period === 'month') return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  const start = new Date(now);
  start.setDate(now.getDate() - (period === '7d' ? 6 : 29));
  return { from: iso(start), to: iso(now) };
}
const PERIODS: { id: Period; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: 'Últimos 7 dias' },
  { id: '30d', label: '30 dias' },
  { id: 'month', label: 'Mês atual' },
];

/** Filtros compartilhados: período, linha, status, disparo, contato e mensagem. */
export function FilterFields<F extends CommonFilters>({ value, onChange, statusOptions, withCampaign = true, withMessage = true, title = 'Filtros', footer }: Props<F>) {
  const { data: overview } = useLiveResource(api.overview, ['line.updated', 'line.removed']);
  const { data: campaigns } = useLiveResource(api.campaigns, ['campaign.updated']);
  const { data: messages } = useLiveResource(api.messages, ['messages.updated']);
  const set = (key: keyof CommonFilters, v: string) => onChange({ ...value, [key]: v || undefined });
  const activePeriod = PERIODS.find((p) => {
    const range = periodRange(p.id);
    return range.from === value.from && range.to === value.to;
  })?.id;
  const lines = overview?.lineDetails ?? [];

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <SlidersHorizontal size={17} />
          <h3>{title}</h3>
        </div>
        <div className="segmented" role="group" aria-label="Período rápido">
          {PERIODS.map((p) => (
            <button key={p.id} className={activePeriod === p.id ? 'is-active' : ''} onClick={() => onChange({ ...value, ...periodRange(p.id), ...(p.id === 'all' ? { from: undefined, to: undefined } : {}) })}>
              {p.label}
            </button>
          ))}
          <button className={activePeriod ? '' : 'is-active'} disabled title="Escolha as datas nos campos De e Até">Personalizado</button>
        </div>
      </div>
      <div className="filters">
        <label>
          <span className="field-label"><CalendarDays size={12} /> De</span>
          <input type="date" value={value.from ?? ''} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label>
          <span className="field-label"><CalendarDays size={12} /> Até</span>
          <input type="date" value={value.to ?? ''} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label>
          <span className="field-label"><RadioTower size={12} /> Linha</span>
          <select value={value.lineId ?? ''} onChange={(e) => set('lineId', e.target.value)}>
            <option value="">Todas as linhas ({lines.filter((l) => l.status === 'active').length} ativas)</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label"><CircleDot size={12} /> Status</span>
          <select value={value.status ?? ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">Todos os status</option>
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {withCampaign && (
          <label>
            <span className="field-label"><Layers size={12} /> Disparo</span>
            <select value={value.campaignId ?? ''} onChange={(e) => set('campaignId', e.target.value)}>
              <option value="">Todos os disparos</option>
              {(campaigns?.campaigns ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span className="field-label"><User size={12} /> Contato</span>
          <input type="search" placeholder="Nome, telefone ou ID…" value={value.contact ?? ''} onChange={(e) => set('contact', e.target.value)} />
        </label>
        {withMessage && (
          <label>
            <span className="field-label"><MessageSquare size={12} /> Mensagem</span>
            <select value={value.message ?? ''} onChange={(e) => set('message', e.target.value)}>
              <option value="">Todas</option>
              {(messages?.slots ?? []).map((s) => {
                const label = s.message?.name ?? `Mensagem ${String(s.slot).padStart(2, '0')}`;
                return <option key={s.slot} value={label}>{label}</option>;
              })}
            </select>
          </label>
        )}
      </div>
      <div className="filters-footer">
        <span className="row small muted">{footer}</span>
        <button className="sm" onClick={() => onChange({} as F)}><Eraser size={14} /> Limpar filtros</button>
      </div>
    </section>
  );
}
