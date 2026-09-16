import { useState } from 'react';
import { api, messageOf } from '../api/client.ts';
import type { LineView } from '../api/types.ts';

/**
 * Decisões pendentes da pausa programada. Cada linha que atingiu o limite tem
 * o seu próprio aviso: decidir sobre uma não afeta as outras.
 */
export function ScheduledPauseAlerts({ lines, onError }: { lines: LineView[]; onError: (message: string) => void }) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const pending = lines.filter((line) => line.scheduledPause.awaitingDecision);
  if (pending.length === 0) return null;

  const decide = async (line: LineView, action: 'continue' | 'keep') => {
    setBusy((current) => new Set(current).add(line.id));
    try {
      if (action === 'continue') await api.continueAfterScheduledPause(line.id);
      else await api.keepPaused(line.id);
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(line.id);
        return next;
      });
    }
  };

  return (
    <div className="scheduled-alerts" role="alert">
      {pending.map((line) => (
        <div key={line.id} className="scheduled-alert">
          <span>
            <strong>{line.label}</strong> atingiu o limite de {line.scheduledPause.limit ?? line.scheduledPause.count} mensagens e foi pausada.
          </span>
          <span className="spacer" />
          <button className="sm primary" disabled={busy.has(line.id)} onClick={() => void decide(line, 'continue')}>
            Continuar
          </button>
          <button className="sm" disabled={busy.has(line.id)} onClick={() => void decide(line, 'keep')}>
            Manter pausada
          </button>
        </div>
      ))}
    </div>
  );
}
