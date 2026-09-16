import { Pause, Play, Square } from 'lucide-react';
import { api } from '../api/client.ts';
import type { CampaignAction, CampaignSummary, LineView, RoundSnapshot } from '../api/types.ts';
import { CAMPAIGN_STATUS_LABEL, formatNumber } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { percent, Progress, ratio } from './ui.tsx';

interface Props {
  campaigns: CampaignSummary[];
  lines: LineView[];
  distribution: Record<string, RoundSnapshot | null>;
  onError: (message: string) => void;
}

const ACTIONS: Partial<Record<CampaignSummary['status'], { action: CampaignAction; label: string; icon: React.ReactNode; danger?: boolean }[]>> = {
  running: [
    { action: 'pause', label: 'Pausar', icon: <Pause size={14} /> },
    { action: 'cancel', label: 'Encerrar', icon: <Square size={14} />, danger: true },
  ],
  paused: [
    { action: 'resume', label: 'Retomar', icon: <Play size={14} /> },
    { action: 'cancel', label: 'Encerrar', icon: <Square size={14} />, danger: true },
  ],
};

/** Disparos em andamento: linhas selecionadas, ciclo atual e progresso. */
export function CampaignsPanel({ campaigns, lines, distribution, onError }: Props) {
  const lineOf = new Map(lines.map((line) => [line.id, line]));

  const run = (id: string, action: CampaignAction) =>
    (action !== 'cancel' || confirm('Encerrar este disparo? A ação é definitiva; para continuar depois, use Pausar.')) &&
    api.campaignAction(id, action).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Disparo</th>
            <th>Status</th>
            <th>Linhas · ciclo (usado/cota)</th>
            <th>Progresso</th>
            <th>Pendentes</th>
            <th>Enviados</th>
            <th>Erros</th>
            <th className="right">Ações</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((campaign) => {
            const status = CAMPAIGN_STATUS_LABEL[campaign.status];
            const round = distribution[campaign.id];
            const { counts } = campaign;
            return (
              <tr key={campaign.id}>
                <td><strong>{campaign.name}</strong><div className="cell-sub">{formatNumber(counts.total)} contatos</div></td>
                <td><Badge tone={status.tone}><span className="dot" />{status.text}</Badge></td>
                <td>
                  {round && <div className="cell-sub">Ciclo {round.number} · {round.intervalSeconds}s</div>}
                  {campaign.lineIds.map((id) => {
                    const line = lineOf.get(id);
                    const quota = round?.quotas.find((q) => q.lineId === id);
                    return (
                      <span key={id} className={`chip ${line?.available ? 'chip-on' : ''}`} title={quota && !quota.active ? 'Fora da distribuição' : undefined}>
                        {line?.label ?? 'removida'}
                        {quota && ` ${quota.used}/${quota.assigned}`}
                      </span>
                    );
                  })}
                </td>
                <td>
                  <div className="bar-cell">
                    <Progress value={ratio(counts.processed, counts.total)} tone="primary" />
                    <span className="small num">{percent(counts.processed, counts.total)}</span>
                  </div>
                </td>
                <td className="num">{formatNumber(counts.pending + counts.processing)}</td>
                <td className="num ok-text">{formatNumber(counts.sent)}</td>
                <td className={`num ${counts.failed ? 'bad-text' : ''}`}>{formatNumber(counts.failed)}</td>
                <td>
                  <div className="row-actions">
                    {(ACTIONS[campaign.status] ?? []).map(({ action, label, icon, danger }) => (
                      <button key={action} className={`sm ${danger ? 'danger' : ''}`} onClick={() => void run(campaign.id, action)}>
                        {icon} {label}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
