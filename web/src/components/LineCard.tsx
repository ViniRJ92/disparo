import { useState } from 'react';
import { Check, Copy, Info, MessageSquare, Pause, Play, Settings } from 'lucide-react';
import type { JobCounts, LineCommand, LineView, WorkerSnapshot } from '../api/types.ts';
import {
  CONNECTION_LABEL,
  OPERATIONAL_STATE_LABEL,
  formatDateTime,
  formatNumber,
  formatTime,
  LINE_STATUS_LABEL,
  WORKER_STATE_LABEL,
} from '../labels.ts';
import { Badge } from './Badge.tsx';

interface Props {
  line: LineView;
  worker: WorkerSnapshot | null;
  /** Números desta linha no disparo selecionado (quando houver). */
  processCounts?: JobCounts | null;
  processName?: string | null;
  /** null = nenhum disparo selecionado. */
  participating?: boolean | null;
  selected: boolean;
  busy: boolean;
  onToggleSelected: (line: LineView) => void;
  onCommand: (line: LineView, command: LineCommand) => void;
  onConfigure: (line: LineView) => void;
}

interface Action {
  command: LineCommand;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

/** Ações coerentes com o estado atual da linha. */
export function actionsFor(line: LineView): Action[] {
  switch (line.status) {
    case 'disconnected':
      return [
        { command: 'connect', label: 'Conectar', primary: true },
        { command: 'start', label: 'Iniciar' },
      ];
    case 'connecting':
      return [{ command: 'disconnect', label: 'Cancelar', danger: true }];
    case 'reconnecting':
      return [
        { command: 'reconnect', label: 'Tentar agora' },
        { command: 'disconnect', label: 'Desconectar', danger: true },
      ];
    case 'connected':
      return [
        { command: 'start', label: 'Iniciar', primary: true },
        { command: 'disconnect', label: 'Desconectar', danger: true },
      ];
    case 'active':
      return [
        { command: 'pause', label: 'Pausar', primary: true },
        { command: 'reconnect', label: 'Reconectar' },
        { command: 'disconnect', label: 'Desconectar', danger: true },
      ];
    case 'paused':
      return [
        { command: 'resume', label: 'Retomar', primary: true },
        { command: 'reconnect', label: 'Reconectar' },
        { command: 'disconnect', label: 'Desconectar', danger: true },
      ];
    case 'error':
      return [
        { command: 'reconnect', label: 'Reconectar', primary: true },
        { command: 'disconnect', label: 'Desconectar', danger: true },
      ];
  }
}

function activityText(line: LineView, worker: WorkerSnapshot | null): string {
  if (line.status === 'reconnecting' && line.nextReconnectAt) return `Nova tentativa às ${formatTime(line.nextReconnectAt)}`;
  if (!worker) return '—';
  if (worker.state === 'cooldown' && worker.nextSendAt) return `Próximo envio às ${formatTime(worker.nextSendAt)}`;
  return WORKER_STATE_LABEL[worker.state];
}

const connectionTone = (status: LineView['connectionStatus']) =>
  status === 'connected' ? 'ok-text' : status === 'error' ? 'bad-text' : status === 'disconnected' ? 'subtle' : 'warn-text';
const operationalTone = (state: LineView['operationalState']) =>
  state === 'active' ? 'ok-text' : state === 'paused' ? 'warn-text' : state === 'error' ? 'bad-text' : 'muted';

export function LineCard({ line, worker, processCounts, processName, participating = null, selected, busy, onToggleSelected, onCommand, onConfigure }: Props) {
  const { activity } = line;
  const status = LINE_STATUS_LABEL[line.status];
  const [copied, setCopied] = useState(false);

  const copyAccount = async () => {
    if (!line.accountId) return;
    try {
      await navigator.clipboard.writeText(line.accountId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* área de transferência indisponível */
    }
  };

  return (
    <article className={`line-card tone-${status.tone} ${selected ? 'is-selected' : ''}`}>
      <header className="line-card-header">
        <label className="line-select">
          <input type="checkbox" aria-label={`Selecionar ${line.label}`} checked={selected} onChange={() => onToggleSelected(line)} />
          <span>
            <span className="line-name">
              {line.label}
              {line.connectionStatus === 'connected' && <span className="dot" />}
            </span>
            <span className="account-id mono">
              {line.accountId ?? 'Conta não identificada'}
              {line.accountId && (
                <button type="button" className="copy-btn" onClick={(e) => { e.preventDefault(); void copyAccount(); }} title="Copiar identificação">
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              )}
            </span>
          </span>
        </label>
        <Badge tone={status.tone}><span className="dot" />{status.text}</Badge>
      </header>

      <dl className="state-box">
        <div>
          <dt>Conexão</dt>
          <dd><span className={`dot ${connectionTone(line.connectionStatus)}`} />{CONNECTION_LABEL[line.connectionStatus]}</dd>
        </div>
        <div>
          <dt>Operacional</dt>
          <dd className={operationalTone(line.operationalState)} title={line.pauseReason ? `Pausa ${line.pauseReason === 'scheduled' ? 'programada' : 'manual'}` : undefined}>
            {OPERATIONAL_STATE_LABEL[line.operationalState]}
            {line.pauseReason && <span className="muted small">({line.pauseReason === 'scheduled' ? 'programada' : 'manual'})</span>}
          </dd>
        </div>
        <div>
          <dt>No disparo</dt>
          <dd className={participating ? 'info-text' : 'muted'}>{participating === null ? '—' : participating ? 'Selecionada' : 'Não selecionada'}</dd>
        </div>
      </dl>

      <dl className="metric-cells">
        <div><dt>Enviadas</dt><dd>{formatNumber(line.counters.messagesSent)}</dd></div>
        <div><dt>Falhas</dt><dd className={line.counters.failures ? 'bad-text' : ''}>{formatNumber(line.counters.failures)}</dd></div>
        <div><dt>Pendentes</dt><dd>{formatNumber(line.pending)}</dd></div>
        <div><dt>Processados</dt><dd className="ok-text">{formatNumber(line.counters.contactsProcessed)}</dd></div>
      </dl>

      {line.scheduledPause.enabled && line.scheduledPause.limit !== null && (
        <p className="line-process">
          Pausa programada: <b className="num">{line.scheduledPause.count}/{line.scheduledPause.limit}</b> mensagens
          {line.scheduledPause.awaitingDecision && <strong className="warn-text"> · aguardando decisão</strong>}
        </p>
      )}
      {processCounts && (
        <p className="line-process">
          No disparo {processName ? `"${processName}"` : ''}: {formatNumber(processCounts.processed)} processados · {formatNumber(processCounts.sent)} enviados ·{' '}
          {formatNumber(processCounts.failed)} erros
        </p>
      )}

      <dl className="detail-rows">
        <div>
          <dt>Último contato</dt>
          <dd title={activity.lastContactPhone ?? undefined}>
            {activity.lastContactId || activity.lastContactPhone
              ? `${activity.lastContactName ?? activity.lastContactPhone}${activity.lastAttemptResult === 'failed' ? ' (erro)' : ''}`
              : '—'}
          </dd>
        </div>
        <div><dt>Último envio</dt><dd>{formatDateTime(activity.lastSentAt)}</dd></div>
        <div>
          <dt>Última mensagem</dt>
          <dd className="primary-text">{activity.lastMessageLabel ? <><MessageSquare size={13} />{activity.lastMessageLabel}</> : '—'}</dd>
        </div>
      </dl>

      <p className="line-meta">
        <Info size={13} />
        <span>{activityText(line, worker)} · conectada em {formatDateTime(line.connectedAt)}</span>
      </p>
      {line.lastError && <p className="line-error">{line.lastError}</p>}

      <footer className="line-actions">
        {actionsFor(line).map(({ command, label, primary, danger }) => (
          <button
            key={command}
            className={`sm ${danger ? 'ghost danger' : primary ? '' : 'ghost'}`}
            disabled={busy}
            onClick={() => onCommand(line, command)}
          >
            {command === 'pause' && <Pause size={13} />}
            {(command === 'resume' || command === 'start') && <Play size={13} />}
            {label}
          </button>
        ))}
        <span className="spacer" />
        <button className="ghost icon" disabled={busy} onClick={() => onConfigure(line)} title="Configurar linha" aria-label={`Configurar ${line.label}`}>
          <Settings size={16} />
        </button>
      </footer>
    </article>
  );
}
