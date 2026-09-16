import { useState } from 'react';
import { api, messageOf } from '../api/client.ts';
import type { ContactView } from '../api/types.ts';
import { Modal } from './Modal.tsx';

interface Props {
  /** Ausente = novo contato. */
  contact?: ContactView;
  onClose: (changed: boolean) => void;
}

export function ContactFormModal({ contact, onClose }: Props) {
  const [name, setName] = useState(contact?.name ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (contact) await api.updateContact(contact.id, { name: name.trim() || null, phone });
      else await api.createContact({ name: name.trim() || undefined, phone });
      onClose(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={contact ? 'Editar contato' : 'Novo contato'}
      onClose={() => onClose(false)}
      footer={
        <>
          <span className="spacer" />
          <button type="button" onClick={() => onClose(false)}>Cancelar</button>
          <button type="submit" form="contact-form" className="primary" disabled={saving}>Salvar</button>
        </>
      }
    >
      <form id="contact-form" className="form" onSubmit={save}>
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <label>
          Número (com DDD)
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(21) 99999-0000" required />
        </label>
        <p className="muted small">Números sem DDI recebem o código do país configurado. Um número só pode existir uma vez.</p>
        {error && <p className="line-error">{error}</p>}
      </form>
    </Modal>
  );
}
