import type { ReactNode } from 'react';
import { formatNumber } from '../labels.ts';

/** Percentual com uma casa decimal; "—" quando não há base. */
export const percent = (part: number, total: number) =>
  total > 0 ? `${(Math.round((part / total) * 1000) / 10).toLocaleString('pt-BR')}%` : '—';

export const ratio = (part: number, total: number) => (total > 0 ? Math.min(100, Math.max(0, (part / total) * 100)) : 0);

export function PageHeader({ title, badge, subtitle, icon, actions }: { title: string; badge?: ReactNode; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        {icon && <span className="page-icon">{icon}</span>}
        <div>
          <div className="page-title">
            <h1>{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Progress({ value, tone = '' }: { value: number; tone?: '' | 'info' | 'primary' | 'bad' | 'warn' }) {
  return (
    <div className={`progress ${tone}`} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

export function KpiCard({
  label,
  icon,
  iconTone,
  value,
  suffix,
  progress,
  progressTone,
  foot,
  primary,
}: {
  label: ReactNode;
  icon?: ReactNode;
  iconTone?: string;
  value: ReactNode;
  suffix?: ReactNode;
  progress?: number;
  progressTone?: '' | 'info' | 'primary' | 'bad' | 'warn';
  foot?: ReactNode;
  primary?: boolean;
}) {
  return (
    <div className={`kpi ${primary ? 'is-primary' : ''}`}>
      <div className="kpi-head">
        <span>{label}</span>
        {icon && <span className={`kpi-icon ${iconTone ?? ''}`}>{icon}</span>}
      </div>
      <div className="kpi-value">
        <strong>{typeof value === 'number' ? formatNumber(value) : value}</strong>
        {suffix}
      </div>
      {progress !== undefined && <Progress value={progress} tone={progressTone} />}
      {foot && <div className="kpi-foot">{foot}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{icon}</span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export const twoDigits = (n: number) => String(n).padStart(2, '0');
