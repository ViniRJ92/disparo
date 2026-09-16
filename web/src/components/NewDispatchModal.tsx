import { useEffect, useState } from 'react';
import { PlayCircle, ShieldCheck, Tag, Triangle } from 'lucide-react';
import { api, messageOf } from '../api/client.ts';
import type { ContactAudience, LineView } from '../api/types.ts';
import { CONNECTION_LABEL, formatNumber, LINE_STATUS_LABEL } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { Modal } from './Modal.tsx';

interface Props {
  lines: LineView[];
  onClose: (createdId: string | null) => void;
}

const AUDIENCES: { value: ContactAudience; label: string; unit: string; description: string }[] = [
  { value: 'all_active', label: 'Todos os contatos ativos', unit: 'Total cadastrado', description: 'Disparo para toda a base ativa, incluindo contatos já abordados.' },
  { value: 'never_received', label: 'Novos / sem contato', unit: 'Contatos elegíveis', description: 'Somente números que nunca receberam mensagem.' },
];

/** Cria um disparo: nome, linhas participantes, público e início imediato. */
export function NewDispatchModal({ lines, onClose }: Props) {
  const today = new Date().toLocaleDateString('pt-BR');
  const [name, setName] = useState(`Disparo ${today}`);
  const [lineIds, setLineIds] = useState<Set<string>>(new Set(lines.filter((l) => l.available).map((l) => l.id)));
  const [audience, setAudience] = useState<ContactAudience>('never_received');
  const [counts, setCounts] = useState<Partial<Record<ContactAudience, number>>>({});
  const [startNow, setStartNow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    for (const { value } of AUDIENCES) {
      api
        .audienceSize(value)
        .then(({ count }) => setCounts((current) => ({ ...current, [value]: count })))
        .catch(() => undefined);
    }
  }, []);

  const toggle = (id: string) =>
    setLineIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCampaign({ name, lineIds: [...lineIds], audience, start: startNow });
      onClose(created.id);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const available = lines.filter((l) => l.available);
  const selectedLines = lines.filter((l) => lineIds.has(l.id));
  const selectedAvailable = selectedLines.filter((l) => l.available).length;
  const audienceCount = counts[audience];
  // Divisão aproximada da fila entre as linhas aptas (a distribuição real acontece em ciclos).
  const share = audienceCount !== undefined && selectedAvailable > 0 ? Math.ceil(audienceCount / selectedAvailable) : null;

  return (
    <Modal
      title="Novo disparo"
      badge={<Badge tone="primary">Multi-linhas</Badge>}
      subtitle="Distribuição em ciclos entre as linhas selecionadas"
      icon={<Triangle size={20} className="primary-text" />}
      accent
      onClose={() => onClose(null)}
      footer={
        <>
          <span className="row small muted">
            <span className="dot ok-text" />
            {audienceCount === undefined ? 'Calculando contatos…' : `${formatNumber(audienceCount)} contato(s) em ${selectedLines.length} linha(s)`}
          </span>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => onClose(null)}>Cancelar</button>
          <button type="submit" form="new-dispatch" className="primary" disabled={busy || lineIds.size === 0 || !name.trim()}>
            <PlayCircle size={16} /> {startNow ? 'Criar e iniciar disparo' : 'Criar rascunho'}
          </button>
        </>
      }
    >
      <form id="new-dispatch" className="form dispatch-form" onSubmit={submit}>
        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="field-label">Nome do disparo</span>
            <span className="mono primary-text">Data: {today}</span>
          </div>
          <div className="input-icon">
            <Tag size={15} />
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required aria-label="Nome do disparo" />
          </div>
        </div>

        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="row">
              <span className="field-label">Linhas participantes</span>
              <Badge tone="muted">{lineIds.size} de {lines.length} · {available.length} disponíveis</Badge>
            </span>
            <span className="row small">
              <button type="button" className="link-button" onClick={() => setLineIds(new Set(lines.map((l) => l.id)))}>Selecionar todas</button>
              <span className="subtle">•</span>
              <button type="button" className="link-button muted" onClick={() => setLineIds(new Set())}>Desmarcar</button>
            </span>
          </div>
          {lines.length === 0 && <p className="muted small">Cadastre ao menos uma linha.</p>}
          <div className="dispatch-lines">
            {lines.map((line) => {
              const on = lineIds.has(line.id);
              const status = LINE_STATUS_LABEL[line.status];
              return (
                <label key={line.id} className={`select-card ${on ? 'is-on' : ''} ${line.available ? '' : 'is-off'}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(line.id)} />
                  <span className="cell-stack">
                    <span className="row"><strong>{line.label}</strong>{line.accountId && <span className="mono subtle">[{line.accountId.slice(-8)}]</span>}</span>
                    <span className={`small row ${status.tone === 'ok' ? 'ok-text' : status.tone === 'bad' ? 'bad-text' : 'muted'}`}>
                      <span className="dot" /> {status.text} · {CONNECTION_LABEL[line.connectionStatus]}
                    </span>
                  </span>
                  <span className="mono small muted">{line.available ? (on && share ? `~${formatNumber(share)} envios` : '') : 'Indisponível'}</span>
                </label>
              );
            })}
          </div>
          <div className="notice" style={{ marginTop: 4 }}>
            <span className="row"><ShieldCheck size={15} className="primary-text" /> Distribuição automática: <b>{selectedAvailable} linha(s) apta(s)</b> agora</span>
            {selectedLines.length > selectedAvailable && <span className="small warn-text">{selectedLines.length - selectedAvailable} entram quando ficarem ativas</span>}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Contatos</span>
          <div className="audience-grid">
            {AUDIENCES.map(({ value, label, unit, description }) => (
              <label key={value} className={`audience-card ${audience === value ? 'is-on' : ''}`}>
                <span className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{label}</strong>
                  <input type="radio" name="audience" checked={audience === value} onChange={() => setAudience(value)} />
                </span>
                <span className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <strong className="big">{counts[value] === undefined ? '…' : formatNumber(counts[value]!)}</strong>
                  <span className="small muted">{unit}</span>
                </span>
                <span className="small muted">{description}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="start-box">
          <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
          <span className="cell-stack">
            <strong>Iniciar envio imediatamente</strong>
            <span className="small muted">{startNow ? 'A fila começa assim que você confirmar.' : 'O disparo fica em rascunho até ser iniciado.'}</span>
          </span>
        </label>
        {error && <p className="line-error">{error}</p>}
      </form>
    </Modal>
  );
}
