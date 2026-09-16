import { useEffect, useState } from 'react';
import { Save, Timer } from 'lucide-react';
import { api, messageOf } from '../api/client.ts';
import type { ScheduledPauseSettings } from '../api/types.ts';

const PRESETS = [10, 15, 30, 50];
type Choice = '10' | '15' | '30' | '50' | 'custom' | 'unlimited';

const toChoice = (limit: number | null): Choice =>
  limit === null ? 'unlimited' : PRESETS.includes(limit) ? (String(limit) as Choice) : 'custom';

/** Configuração da PAUSA PROGRAMADA (opcional). O contador é individual por linha. */
export function ScheduledPausePanel({ onError, detailed = false }: { onError: (message: string) => void; detailed?: boolean }) {
  const [current, setCurrent] = useState<ScheduledPauseSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [choice, setChoice] = useState<Choice>('50');
  const [custom, setCustom] = useState('20');
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(({ scheduledPause }) => {
        setCurrent(scheduledPause);
        setEnabled(scheduledPause.enabled);
        setChoice(toChoice(scheduledPause.limit));
        if (scheduledPause.limit !== null && !PRESETS.includes(scheduledPause.limit)) setCustom(String(scheduledPause.limit));
      })
      .catch((error) => onError(messageOf(error)));
  }, [onError]);

  if (!current) return null;

  const limit = choice === 'unlimited' ? null : choice === 'custom' ? Number(custom) : Number(choice);
  const dirty = enabled !== current.enabled || limit !== current.limit;

  const save = async () => {
    try {
      const { scheduledPause } = await api.updateSettings({ scheduledPause: { enabled, limit } });
      setCurrent(scheduledPause);
      setSaved(
        scheduledPause.enabled
          ? `Ativada: ${scheduledPause.limit === null ? 'sem limite' : `${scheduledPause.limit} mensagens por linha`}. Contadores zerados.`
          : 'Pausa programada desativada.',
      );
    } catch (error) {
      onError(messageOf(error));
    }
  };

  return (
    <div className="scheduled-panel" style={{ width: '100%' }}>
      <label className="check-row" style={{ flex: detailed ? '1 1 320px' : '0 1 auto' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {!detailed && <Timer size={15} className="primary-text" />}
        <span className="cell-stack">
          <strong>Pausa programada</strong>
          {detailed && <span className="small muted">Pausa a linha ao atingir o limite e aguarda a sua decisão (Continuar ou Manter pausada).</span>}
        </span>
      </label>
      {!detailed && <span className="spacer" />}
      <select value={choice} disabled={!enabled} onChange={(e) => setChoice(e.target.value as Choice)} aria-label="Limite da pausa programada">
        {PRESETS.map((n) => (
          <option key={n} value={String(n)}>{n} mensagens</option>
        ))}
        <option value="custom">Personalizado</option>
        <option value="unlimited">Sem limite</option>
      </select>
      {choice === 'custom' && (
        <input type="number" min={1} value={custom} disabled={!enabled} onChange={(e) => setCustom(e.target.value)} aria-label="Limite personalizado" className="input-narrow" />
      )}
      <span className="muted small">por linha <span className="subtle">(contador individual)</span></span>
      {saved && !dirty && <span className="small ok-text">{saved}</span>}
      <button className={`sm ${dirty ? 'primary' : ''}`} disabled={!dirty || (choice === 'custom' && !(Number(custom) >= 1))} onClick={() => void save()}>
        <Save size={14} /> Salvar
      </button>
    </div>
  );
}
