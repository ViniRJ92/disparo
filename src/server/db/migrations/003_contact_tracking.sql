-- =====================================================================
-- Módulo 4: rastreamento individual de cada contato
-- =====================================================================

-- Status cadastral: contatos bloqueados não recebem mensagens.
ALTER TABLE contacts ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked'));

-- Situação do contato na fila (derivada de send_jobs e mantida sincronizada):
--   idle        nunca foi colocado em processo (ou só em processos cancelados)
--   pending     aguardando envio em algum processo não finalizado
--   processing  uma linha está enviando para ele agora
--   sent        último resultado: mensagem enviada
--   failed      último resultado: erro definitivo
ALTER TABLE contacts ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'idle'
  CHECK (processing_status IN ('idle', 'pending', 'processing', 'sent', 'failed'));

-- Resumo do último envio (atualizado na mesma transação do histórico).
ALTER TABLE contacts ADD COLUMN messages_received INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN last_message_label TEXT;
ALTER TABLE contacts ADD COLUMN last_line_id TEXT REFERENCES lines(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN last_sent_at TEXT;
ALTER TABLE contacts ADD COLUMN last_error TEXT;

CREATE INDEX idx_contacts_processing_status ON contacts (processing_status);
CREATE INDEX idx_contacts_status ON contacts (status);

-- Preenche os dados de quem já tinha envios antes desta versão.
UPDATE contacts SET
  messages_received = (SELECT COUNT(*) FROM send_attempts a WHERE a.contact_id = contacts.id AND a.result = 'sent'),
  last_sent_at = (SELECT MAX(a.created_at) FROM send_attempts a WHERE a.contact_id = contacts.id AND a.result = 'sent'),
  last_line_id = (SELECT a.line_id FROM send_attempts a WHERE a.contact_id = contacts.id AND a.result = 'sent'
                  ORDER BY a.created_at DESC LIMIT 1),
  -- Envios anteriores ao Módulo 3 não têm o rótulo gravado: usa o nome atual da mensagem.
  last_message_label = (SELECT COALESCE(a.message_label, m.name) FROM send_attempts a
                        LEFT JOIN message_templates m ON m.id = a.message_template_id
                        WHERE a.contact_id = contacts.id AND a.result = 'sent'
                        ORDER BY a.created_at DESC LIMIT 1);
