import { useState } from 'react';
import { api, messageOf } from '../api/client.ts';
import type { LineView } from '../api/types.ts';
import { Modal } from './Modal.tsx';

interface Props {
  line: LineView;
  onClose: () => void;
}

/** Configurações próprias de UMA linha. */
export function LineConfigModal({ line, onClose }: Props) {
  const [label, setLabel] = useState(line.label);
  const [dailyLimit, setDailyLimit] = useState(String(line.settings.dailyLimit));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.updateLine(line.id, {
        label,
        settings: {
          dailyLimit: Number(dailyLimit),
        },
      });
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remover "${line.label}"? A linha será desconectada.`)) return;
    try {
      await api.removeLine(line.id);
      onClose();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <Modal
      title={`Configurar ${line.label}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="danger" onClick={remove}>Remover linha</button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" form="line-config" className="primary" disabled={saving}>Salvar</button>
        </>
      }
    >
      <form id="line-config" className="form" onSubmit={save}>
        <label>
          Identificação
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required />
        </label>
        <label>
          Limite diário de mensagens
          <input type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} required />
        </label>
        <p className="muted small">
          Provedor: {line.provider}. O intervalo entre envios não é por linha: ele é sorteado a cada ciclo (2 a 5 segundos) e vale
          para todas as linhas do ciclo. O nome é apenas uma identificação interna: não altera o número nem a conta conectada.
        </p>
        {error && <p className="line-error">{error}</p>}
      </form>
    </Modal>
  );
}
