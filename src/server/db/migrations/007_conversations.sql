-- =====================================================================
-- Módulo 8: mensagens das conversas de cada linha (instância)
--
-- Os envios do disparo continuam em send_attempts. Aqui ficam as mensagens
-- que o provedor informa nas conversas da linha: recebidas, enviadas fora do
-- disparo (ex.: resposta manual) e mensagens de grupos.
-- Nada é apagado nem resumido: o Analytics lê estes registros como estão.
-- =====================================================================

CREATE TABLE conversation_messages (
  id                   TEXT PRIMARY KEY,
  line_id              TEXT REFERENCES lines(id) ON DELETE SET NULL,
  line_label           TEXT,                                    -- nome da linha no momento do registro
  chat_id              TEXT NOT NULL,                           -- identificação da conversa no provedor
  chat_type            TEXT NOT NULL CHECK (chat_type IN ('individual', 'group', 'broadcast')),
  group_name           TEXT,
  -- Pessoa: telefone normalizado (dígitos com DDI) quando conhecido; senão a
  -- identificação da conversa (ex.: "lid:123"). É a chave que consolida a mesma
  -- pessoa entre linhas diferentes.
  person_key           TEXT NOT NULL,
  person_phone         TEXT,
  person_name          TEXT,
  contact_id           TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  direction            TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body                 TEXT,
  provider_message_id  TEXT NOT NULL,
  sent_at              TEXT NOT NULL,                           -- horário da mensagem informado pelo provedor
  created_at           TEXT NOT NULL,
  UNIQUE (line_id, provider_message_id)                         -- a mesma mensagem nunca é contada duas vezes
);
CREATE INDEX idx_conversation_person ON conversation_messages (person_key, sent_at);
CREATE INDEX idx_conversation_line ON conversation_messages (line_id, sent_at);
CREATE INDEX idx_conversation_type_sent ON conversation_messages (chat_type, direction, sent_at);
CREATE INDEX idx_contacts_phone ON contacts (phone);
