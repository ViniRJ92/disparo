import { useState } from 'react';
import { api, messageOf } from '../api/client.ts';
import type { CampaignDetail } from '../api/types.ts';
import { CAMPAIGN_STATUS_LABEL, formatNumber } from '../labels.ts';
import { Badge } from './Badge.tsx';

interface Props {
  process: CampaignDetail;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Controle global do disparo selecionado. Os botões agem sobre as linhas do
 * disparo (ou sobre o processo, no caso de encerrar); o controle individual de
 * cada linha continua disponível nos cards.
 */
export function ProcessControlBar({ process, onNotice, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const status = CAMPAIGN_STATUS_LABEL[process.status];
  const { counts } = process;
  const open = process.status === 'draft' || process.status === 'running' || process.status === 'paused';

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      onNotice(await work());
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const bulk = (kind: 'pause' | 'resume') =>
    run(async () => {
      const { results } = kind === 'pause' ? await api.pauseAllLines(process.id) : await api.resumeAllLines(process.id);
      const done = results.filter((r) => r.outcome === 'done').length;
      return `${done} linha(s) ${kind === 'pause' ? 'pausada(s)' : 'retomada(s)'} em "${process.name}"`;
    });

  const finish = () => {
    const message =
      `Encerrar o disparo "${process.name}"?\n\n` +
      `${formatNumber(counts.pending)} contato(s) ainda não enviados serão marcados como não enviados. ` +
      'Esta ação é definitiva: o disparo não poderá ser retomado. (Para continuar depois, use "Pausar todas".)';
    if (!confirm(message)) return;
    void run(async () => {
      await api.finishCampaign(process.id);
      return `Disparo "${process.name}" encerrado`;
    });
  };

  return (
    <div className="process-bar">
      <div className="process-bar-info">
        <strong>{process.name}</strong>
        <Badge tone={status.tone}>{status.text}</Badge>
        <span className="muted small">
          {formatNumber(counts.total)} contatos · {formatNumber(counts.sent)} enviados · {formatNumber(counts.failed)} erros ·{' '}
          {formatNumber(counts.pending + counts.processing)} pendentes
          {counts.skipped > 0 && ` · ${formatNumber(counts.skipped)} não enviados`} · {process.availableLineCount}/{process.lines.length}{' '}
          linha(s) aptas
        </span>
      </div>
      {open && (
        <div className="process-bar-actions">
          {process.status === 'draft' && (
            <button className="sm primary" disabled={busy} onClick={() => void run(async () => {
              await api.campaignAction(process.id, 'start');
              return `Disparo "${process.name}" iniciado`;
            })}>
              Iniciar disparo
            </button>
          )}
          {process.status === 'paused' && (
            <button className="sm primary" disabled={busy} onClick={() => void run(async () => {
              await api.campaignAction(process.id, 'resume');
              return `Disparo "${process.name}" retomado`;
            })}>
              Retomar disparo
            </button>
          )}
          <button className="sm" disabled={busy} onClick={() => void bulk('pause')}>Pausar todas</button>
          <button className="sm" disabled={busy} onClick={() => void bulk('resume')}>Retomar todas</button>
          <button className="sm danger" disabled={busy} onClick={finish}>Encerrar disparo</button>
        </div>
      )}
    </div>
  );
}
