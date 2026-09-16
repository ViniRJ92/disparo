-- =====================================================================
-- Módulo 6: última atividade de cada linha (exibida em tempo real)
-- =====================================================================

-- Último contato processado pela linha (nome/telefone guardados como retrato do momento).
ALTER TABLE lines ADD COLUMN last_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE lines ADD COLUMN last_contact_name TEXT;
ALTER TABLE lines ADD COLUMN last_contact_phone TEXT;
-- Última mensagem utilizada e resultado/horário da última tentativa.
ALTER TABLE lines ADD COLUMN last_message_label TEXT;
ALTER TABLE lines ADD COLUMN last_attempt_at TEXT;
ALTER TABLE lines ADD COLUMN last_attempt_result TEXT CHECK (last_attempt_result IN ('sent', 'failed'));
-- Último envio concluído com sucesso.
ALTER TABLE lines ADD COLUMN last_sent_at TEXT;

-- Preenche a partir do histórico já existente.
UPDATE lines SET
  last_contact_id = (SELECT a.contact_id FROM send_attempts a WHERE a.line_id = lines.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1),
  last_contact_name = (SELECT c.name FROM send_attempts a JOIN contacts c ON c.id = a.contact_id
                       WHERE a.line_id = lines.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1),
  last_contact_phone = (SELECT c.phone FROM send_attempts a JOIN contacts c ON c.id = a.contact_id
                        WHERE a.line_id = lines.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1),
  last_message_label = (SELECT COALESCE(a.message_label, m.name) FROM send_attempts a
                        LEFT JOIN message_templates m ON m.id = a.message_template_id
                        WHERE a.line_id = lines.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1),
  last_attempt_at = (SELECT MAX(a.created_at) FROM send_attempts a WHERE a.line_id = lines.id),
  last_attempt_result = (SELECT a.result FROM send_attempts a WHERE a.line_id = lines.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1),
  last_sent_at = (SELECT MAX(a.created_at) FROM send_attempts a WHERE a.line_id = lines.id AND a.result = 'sent');
