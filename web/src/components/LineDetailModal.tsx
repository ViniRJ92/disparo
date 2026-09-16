import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { useLiveResource } from '../hooks/useLiveResource.ts';
import {
  CAMPAIGN_STATUS_LABEL,
  CONNECTION_LABEL,
  formatDateTime,
  formatNumber,
  LINE_STATUS_LABEL,
  RUN_STATE_LABEL,
  WORKER_STATE_LABEL,
} from '../labels.ts';
import type { SendAttemptView } from '../api/types.ts';
import { Badge } from './Badge.tsx';
import { ExportLinks } from './ExportLinks.tsx';
import { Modal } from './Modal.tsx';

const LIVE_EVENTS = ['line.updated', 'send.recorded', 'campaign.updated', 'worker.updated', 'log.created'];

/** Detalhes de uma linha no Dashboard (atualizados em tempo real). */
export function LineDetailModal({ lineId, campaignId, onClose }: { lineId: string; campaignId?: string; onClose: () => void }) {
  const { data, error, reload } = useLiveResource(() => api.lineDetail(lineId, campaignId), LIVE_EVENTS);
  const [older, setOlder] = useState<SendAttemptView[]>([]);
  const [noMore, setNoMore] = useState(false);
  const loadMore = async () => {
    const offset = (data?.recentAttempts.length ?? 0) + older.length;
    const { attempts } = await api.history({ lineId, campaignId, limit: 50, offset });
    setOlder((current) => [...current, ...attempts]);
    if (attempts.length < 50) setNoMore(true);
  };
  useEffect(() => {
    void reload();
  }, [lineId, campaignId, reload]);

  if (!data) {
    return (
      <Modal title="Detalhes da linha" onClose={onClose}>
        {error ? <p className="line-error">{error}</p> : <p className="empty">Carregando…</p>}
      </Modal>
    );
  }

  const { line, worker, counts, attempts, processes, recentAttempts, recentLogs, messagesUsed, cycles, contactsProcessed } = data;
  const seen = new Set<string>();
  const allAttempts = [...recentAttempts, ...older].filter((a) => !seen.has(a.id) && seen.add(a.id));
  const status = LINE_STATUS_LABEL[line.status];

  return (
    <Modal title={line.label} onClose={onClose}>
      <div className="detail">
        <div className="detail-head">
          <Badge tone={status.tone}>{status.text}</Badge>
          <span className="muted small">
            {line.accountId ?? 'Conta não identificada'} · {CONNECTION_LABEL[line.connectionStatus]} · {RUN_STATE_LABEL[line.runState]}
            {worker && ` · ${WORKER_STATE_LABEL[worker.state]}`}
          </span>
        </div>
        {line.lastError && <p className="line-error">{line.lastError}</p>}

        <h3 className="section-title">{campaignId ? 'Neste disparo' : 'Todos os disparos'}</h3>
        <dl className="detail-grid">
          <div><dt>Processados</dt><dd>{formatNumber(counts.sent + counts.failed)}</dd></div>
          <div><dt>Enviados</dt><dd>{formatNumber(counts.sent)}</dd></div>
          <div><dt>Erros</dt><dd>{formatNumber(counts.failed)}</dd></div>
          <div><dt>Enviando agora</dt><dd>{formatNumber(counts.processing)}</dd></div>
          <div><dt>Pendentes</dt><dd title="Fila compartilhada dos disparos em que a linha participa">{formatNumber(line.pending)}</dd></div>
          <div><dt>Contatos processados</dt><dd>{formatNumber(contactsProcessed)}</dd></div>
          <div><dt>Pausa programada</dt><dd>{line.scheduledPause.enabled && line.scheduledPause.limit !== null ? `${line.scheduledPause.count}/${line.scheduledPause.limit}` : 'Desativada'}</dd></div>
          <div><dt>Tentativas</dt><dd title="Inclui falhas temporárias que voltaram para a fila">{formatNumber(attempts.total)} ({formatNumber(attempts.failed)} com falha)</dd></div>
          <div><dt>Último envio</dt><dd>{formatDateTime(data.lastSentAt)}</dd></div>
          <div><dt>Último contato</dt><dd>{line.activity.lastContactName ?? line.activity.lastContactPhone ?? '—'}</dd></div>
          <div><dt>Última mensagem</dt><dd>{line.activity.lastMessageLabel ?? '—'}</dd></div>
          <div><dt>Limite diário</dt><dd>{formatNumber(worker?.sentToday ?? 0)} / {formatNumber(line.settings.dailyLimit)}</dd></div>
        </dl>

        <h3 className="section-title">Disparos em que participa</h3>
        {processes.length === 0 ? (
          <p className="muted small">Nenhum.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Disparo</th><th>Status</th><th>Enviados</th><th>Erros</th><th>Ciclo atual (usado/cota)</th></tr>
            </thead>
            <tbody>
              {processes.map((p) => (
                <tr key={p.campaignId}>
                  <td>{p.name}</td>
                  <td><Badge tone={CAMPAIGN_STATUS_LABEL[p.status].tone}>{CAMPAIGN_STATUS_LABEL[p.status].text}</Badge></td>
                  <td>{formatNumber(p.counts.sent)}</td>
                  <td>{formatNumber(p.counts.failed)}</td>
                  <td>{p.quota ? `${p.quota.used}/${p.quota.assigned}${p.quota.active ? '' : ' (fora)'}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="toolbar">
          <ExportLinks kinds={['sent', 'failed', 'history']} filters={{ lineId: line.id, campaignId }} />
        </div>

        <div className="detail-columns">
          <div>
            <h3 className="section-title">Mensagens utilizadas</h3>
            {messagesUsed.length === 0 ? (
              <p className="muted small">Nenhuma.</p>
            ) : (
              <ul className="log-list">
                {messagesUsed.map((m) => (
                  <li key={m.label}>{m.label}: <strong>{formatNumber(m.sent)}</strong> envio(s)</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="section-title">Ciclos recentes</h3>
            {cycles.length === 0 ? (
              <p className="muted small">Nenhum.</p>
            ) : (
              <ul className="log-list">
                {cycles.slice(0, 10).map((c) => (
                  <li key={`${c.campaignId}-${c.cycle}`}>
                    {c.campaignName} · ciclo {c.cycle}{c.intervalSeconds !== null && ` (${c.intervalSeconds}s)`}: {c.sent} enviado(s)
                    {c.failed > 0 && `, ${c.failed} falha(s)`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <h3 className="section-title">Histórico da linha</h3>
        {allAttempts.length === 0 ? (
          <p className="muted small">Nenhum envio.</p>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr><th>Data/hora</th><th>Contato</th><th>Mensagem</th><th>Disparo</th><th>Ciclo</th><th>Resultado</th></tr>
              </thead>
              <tbody>
                {allAttempts.map((a) => (
                  <tr key={a.id}>
                    <td>{formatDateTime(a.createdAt)}</td>
                    <td>{a.contactName ?? a.contactPhone}</td>
                    <td>{a.messageLabel ?? '—'}</td>
                    <td>{a.campaignName}</td>
                    <td>{a.cycleNumber ?? '—'}</td>
                    <td>
                      <Badge tone={a.result === 'sent' ? 'ok' : 'bad'}>{a.result === 'sent' ? 'Enviada' : 'Erro'}</Badge>
                      {a.error && <div className="line-error">{a.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!noMore && allAttempts.length >= 20 && (
              <button onClick={() => void loadMore()}>Carregar mais</button>
            )}
          </>
        )}

        <h3 className="section-title">Eventos recentes</h3>
        {recentLogs.length === 0 ? (
          <p className="muted small">Nenhum evento.</p>
        ) : (
          <ul className="log-list">
            {recentLogs.map((log) => (
              <li key={log.id} className={`log-${log.level}`}>
                <span className="muted small">{formatDateTime(log.createdAt)}</span> {log.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
