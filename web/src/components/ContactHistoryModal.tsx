import { useEffect, useState } from 'react';
import { api, messageOf } from '../api/client.ts';
import type { ContactView, SendAttemptView } from '../api/types.ts';
import { formatDateTime } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { Modal } from './Modal.tsx';

/** Histórico individual: cada envio com mensagem, linha, horário, processo e resultado. */
export function ContactHistoryModal({ contact, onClose }: { contact: ContactView; onClose: () => void }) {
  const [history, setHistory] = useState<SendAttemptView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .contactHistory(contact.id)
      .then(({ history }) => setHistory(history))
      .catch((err) => setError(messageOf(err)));
  }, [contact.id]);

  return (
    <Modal title={`Histórico de ${contact.name ?? contact.phone}`} onClose={onClose}>
      <p className="muted small">
        {contact.phone} · {contact.messagesReceived} mensagem(ns) recebida(s)
      </p>
      {error && <p className="line-error">{error}</p>}
      {!history && !error && <p className="empty">Carregando…</p>}
      {history?.length === 0 && <p className="empty">Nenhum envio para este contato ainda.</p>}
      {history && history.length > 0 && (
        <ol className="timeline">
          {history.map((entry) => (
            <li key={entry.id} className={`timeline-item ${entry.result === 'failed' ? 'is-failed' : ''}`}>
              <div className="timeline-head">
                <strong>{entry.messageLabel ?? 'Mensagem removida'}</strong>
                <span>→ {entry.lineLabel ?? 'Linha removida'}</span>
                <span>→ {formatDateTime(entry.createdAt)}</span>
                <Badge tone={entry.result === 'sent' ? 'ok' : 'bad'}>{entry.result === 'sent' ? 'Enviada' : 'Erro'}</Badge>
              </div>
              <div className="muted small">
                Disparo: {entry.campaignName}
                {entry.cycleNumber !== null && ` · Ciclo ${entry.cycleNumber}`}
                {entry.cycleIntervalSeconds !== null && ` (intervalo ${entry.cycleIntervalSeconds}s)`}
              </div>
              {entry.error && <div className="line-error">{entry.error}</div>}
              {entry.renderedBody && <div className="timeline-body">{entry.renderedBody}</div>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
