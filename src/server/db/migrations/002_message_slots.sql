-- =====================================================================
-- Módulo 3: mensagens em 5 posições, ativação e regra de não repetição
-- =====================================================================

-- Posição fixa (1..5) e ativação de cada mensagem.
ALTER TABLE message_templates ADD COLUMN slot INTEGER CHECK (slot BETWEEN 1 AND 5);
ALTER TABLE message_templates ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));

-- Mensagens já existentes ocupam as primeiras posições, por ordem de criação.
-- Excedentes (acima de 5) ficam sem posição e não participam dos envios.
UPDATE message_templates
SET slot = (
  SELECT ranked.rn FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM message_templates
  ) AS ranked
  WHERE ranked.id = message_templates.id AND ranked.rn <= 5
);
CREATE UNIQUE INDEX idx_message_templates_slot ON message_templates (slot) WHERE slot IS NOT NULL;

-- Os processos passam a usar as mensagens ATIVAS (seleção global),
-- em vez de uma lista fixa por campanha.
DROP TABLE campaign_messages;

-- Estado por contato para a regra "não repetir a mesma mensagem consecutivamente".
ALTER TABLE contacts ADD COLUMN last_message_template_id TEXT REFERENCES message_templates(id) ON DELETE SET NULL;

-- Um contato nunca é processado por duas linhas ao mesmo tempo (a regra de
-- não repetição depende disso); este índice mantém essa verificação barata.
CREATE INDEX idx_send_jobs_contact_status ON send_jobs (contact_id, status);

-- O histórico guarda como a mensagem se chamava no momento do envio
-- (o texto efetivamente enviado já fica em rendered_body).
ALTER TABLE send_attempts ADD COLUMN message_label TEXT;
