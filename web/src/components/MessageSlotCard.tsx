import { Fragment, useEffect, useState } from 'react';
import { Eye, Lightbulb, Pause, Pencil, Play, Save, Trash2 } from 'lucide-react';
import { renderMessage } from '../../../src/server/modules/messages/message.renderer.ts';
import { api, messageOf } from '../api/client.ts';
import type { AnalyticsOverview, MessageSlot } from '../api/types.ts';
import { defaultMessageName } from '../../../src/server/modules/messages/message.types.ts';
import { formatDateTime, formatNumber } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { Modal } from './Modal.tsx';
import { percent, Progress, ratio, twoDigits } from './ui.tsx';

/** Contato fictício para a visualização. */
const SAMPLE_CONTACT = { name: 'João Silva', phone: '5521999998888', variables: {} };

interface Props {
  slot: MessageSlot;
  usage: AnalyticsOverview['sends']['byMessage'][number] | null;
  totalActiveSent: number;
  onError: (message: string) => void;
}

/** Destaca as variáveis {{...}} do texto. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\{\{\s*[\w.-]+\s*\}\})/g);
  return (
    <>
      {parts.map((part, i) => (/^\{\{/.test(part) ? <span key={i} className="var-inline">{part}</span> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

export function MessageSlotCard({ slot, usage, totalActiveSent, onError }: Props) {
  const { message } = slot;
  const [editing, setEditing] = useState(message === null);
  const [draft, setDraft] = useState(message?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Mensagem salva/excluída em outro lugar: volta ao estado coerente.
  useEffect(() => {
    setEditing(message === null);
    setDraft(message?.body ?? '');
  }, [message?.id, message?.updatedAt]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    await api.saveMessageSlot(slot.slot, draft);
    setEditing(false);
  });

  const remove = () => {
    if (message && confirm(`Excluir ${message.name}? O histórico de envios é preservado.`)) {
      void run(() => api.removeMessage(message.id));
    }
  };

  const name = message?.name ?? defaultMessageName(slot.slot);
  const dirty = draft.trim() !== (message?.body ?? '').trim();
  const sent = usage?.sent ?? 0;
  const failed = usage?.failed ?? 0;

  return (
    <article className={`message-card ${!message ? 'is-empty' : message.active ? 'is-active' : 'is-inactive'}`}>
      <header className="message-card-header">
        <span className="row">
          <span className="slot-num">{twoDigits(slot.slot)}</span>
          <h3>{name}</h3>
        </span>
        {!message ? (
          <Badge tone="muted">Posição vazia</Badge>
        ) : message.active ? (
          <Badge tone="ok"><span className="dot" />Ativa no sorteio</Badge>
        ) : (
          <Badge tone="muted"><Pause size={11} />Desativada</Badge>
        )}
      </header>

      {editing ? (
        <textarea
          className="message-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Digite a mensagem. Use {{nome}} para personalizar…"
          maxLength={4096}
          rows={6}
          aria-label={`Texto da ${defaultMessageName(slot.slot)}`}
        />
      ) : (
        <div className="message-body">
          <Highlighted text={message?.body ?? ''} />
        </div>
      )}

      {message && !editing ? (
        message.active ? (
          <div className="message-usage">
            <div>
              <span className="small muted">Participação no sorteio</span>
              <span className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="ok-text">{percent(sent, totalActiveSent)}</strong>
                <span className="small muted num">{formatNumber(sent)} envios</span>
              </span>
              <Progress value={ratio(sent, totalActiveSent)} tone="" />
            </div>
            <div>
              <span className="small muted">Taxa de sucesso</span>
              <strong>{percent(sent, sent + failed)}</strong>
              <span className="small muted num">{formatNumber(failed)} falha(s)</span>
            </div>
          </div>
        ) : (
          <div className="message-usage" style={{ gridTemplateColumns: '1fr' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">Histórico de envios</span>
              <strong className="num">{formatNumber(sent)} envios</strong>
            </div>
          </div>
        )
      ) : (
        <p className="row small primary-text"><Lightbulb size={14} /> Suporta emojis e quebras de linha</p>
      )}

      <div className="message-meta">
        <span>{message ? `Atualizada em ${formatDateTime(message.updatedAt)}` : 'Posição livre'}</span>
        <span className="mono">{draft.length} / 4096</span>
      </div>

      <footer className="line-actions">
        {editing ? (
          <>
            <button className="sm success" disabled={busy || !draft.trim() || (message !== null && !dirty)} onClick={() => void save()}>
              <Save size={14} /> {message ? 'Salvar' : 'Salvar e ativar'}
            </button>
            {message && (
              <button className="sm ghost" disabled={busy} onClick={() => { setDraft(message.body); setEditing(false); }}>Cancelar</button>
            )}
          </>
        ) : (
          <button className="sm" disabled={busy} onClick={() => setEditing(true)}><Pencil size={14} /> Editar</button>
        )}
        <button className="sm" disabled={!draft.trim()} onClick={() => setPreviewing(true)}><Eye size={14} /> Visualizar</button>
        {message && !editing && (
          <button className="sm" disabled={busy} onClick={() => void run(() => api.setMessageActive(message.id, !message.active))}>
            {message.active ? <><Pause size={14} /> Desativar</> : <><Play size={14} /> Ativar</>}
          </button>
        )}
        <span className="spacer" />
        {message ? (
          <button className="ghost icon danger" disabled={busy} onClick={remove} title="Excluir" aria-label={`Excluir ${name}`}><Trash2 size={16} /></button>
        ) : (
          <span className="small subtle">Posição {slot.slot}</span>
        )}
      </footer>

      {previewing && (
        <Modal title={`Visualizar ${name}`} onClose={() => setPreviewing(false)}>
          <p className="muted small" style={{ marginBottom: 10 }}>Exemplo para o contato {SAMPLE_CONTACT.name}:</p>
          <div className="chat-bubble">{renderMessage(draft, SAMPLE_CONTACT)}</div>
        </Modal>
      )}
    </article>
  );
}
