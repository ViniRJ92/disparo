import { useEffect, useState } from 'react';
import { api, messageOf } from '../api/client.ts';
import type { AnalyticsPerson, PersonTimelineEntry } from '../api/types.ts';
import { formatDateTime } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { Modal } from './Modal.tsx';

const KIND: Record<PersonTimelineEntry['kind'], string> = {
  dispatch: 'Disparo',
  inbound: 'Escreveu',
  outbound: 'Resposta da linha',
};

/** Histórico completo de uma pessoa em todas as linhas. */
export function PersonTimelineModal({ person, onClose }: { person: AnalyticsPerson; onClose: () => void }) {
  const [timeline, setTimeline] = useState<PersonTimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .personTimeline(person.personKey)
      .then(({ timeline }) => setTimeline(timeline))
      .catch((err) => setError(messageOf(err)));
  }, [person.personKey]);

  return (
    <Modal title={person.name ?? person.phone ?? person.personKey} onClose={onClose}>
      <p className="muted small">
        {person.phone ?? person.personKey} · {person.lines.join(', ')}
      </p>
      {error && <p className="line-error">{error}</p>}
      {!timeline && !error && <p className="empty">Carregando…</p>}
      {timeline && (
        <ol className="timeline">
          {timeline.map((entry, i) => (
            <li key={i} className={`timeline-item ${entry.result === 'failed' ? 'is-failed' : ''} ${entry.chatType !== 'individual' ? 'is-group' : ''}`}>
              <div className="timeline-head">
                <strong>{KIND[entry.kind]}</strong>
                <span>→ {entry.lineLabel ?? 'Linha removida'}</span>
                <span>→ {formatDateTime(entry.at)}</span>
                {entry.messageLabel && <span>→ {entry.messageLabel}</span>}
                {entry.result && <Badge tone={entry.result === 'sent' ? 'ok' : 'bad'}>{entry.result === 'sent' ? 'Enviado' : 'Falha'}</Badge>}
                {entry.chatType === 'group' && <Badge tone="muted">Grupo{entry.groupName ? `: ${entry.groupName}` : ''}</Badge>}
              </div>
              {entry.campaignName && <div className="muted small">Disparo: {entry.campaignName}</div>}
              {entry.error && <div className="line-error">{entry.error}</div>}
              {entry.body && <div className="timeline-body">{entry.body}</div>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
