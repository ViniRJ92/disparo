-- =====================================================================
-- Disparo: schema inicial (módulo 1, base arquitetural)
--
-- Relacionamentos:
--   lines 1-N campaign_lines N-1 campaigns
--   campaigns 1-N campaign_messages N-1 message_templates
--   campaigns 1-N send_jobs N-1 contacts        (fila: 1 job por contato/campanha)
--   send_jobs N-1 lines / message_templates      (definidos pela distribuição)
--   send_jobs 1-N send_attempts                  (histórico individual de cada envio)
--   logs -> lines / campaigns (opcionais)
-- Estatísticas são derivadas (consultas sobre send_jobs) + contadores por linha.
-- =====================================================================

-- Linhas/contas de WhatsApp: cada uma é uma entidade independente.
CREATE TABLE lines (
  id                  TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_config     TEXT NOT NULL DEFAULT '{}',   -- JSON (credenciais/ids do provedor)
  account_id          TEXT,                          -- número/identificação da conta, quando disponível
  display_name        TEXT,
  connection_status   TEXT NOT NULL DEFAULT 'disconnected'
                      CHECK (connection_status IN ('disconnected','connecting','qr_required','connected','error')),
  operational_status  TEXT NOT NULL DEFAULT 'idle'
                      CHECK (operational_status IN ('idle','sending','error')),
  run_state           TEXT NOT NULL DEFAULT 'stopped'
                      CHECK (run_state IN ('stopped','active','paused')),
  connected_at        TEXT,
  last_error          TEXT,
  settings            TEXT NOT NULL DEFAULT '{}',   -- JSON (configurações próprias da linha)
  contacts_processed  INTEGER NOT NULL DEFAULT 0,
  messages_sent       INTEGER NOT NULL DEFAULT 0,
  failures            INTEGER NOT NULL DEFAULT 0,
  position            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE contacts (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL UNIQUE,               -- somente dígitos, com DDI
  name        TEXT,
  variables   TEXT NOT NULL DEFAULT '{}',         -- JSON (campos livres para personalização)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE message_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Campanha = processo de disparo (controle global).
CREATE TABLE campaigns (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','running','paused','completed','cancelled')),
  settings     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);

-- Linhas selecionadas para cada disparo.
CREATE TABLE campaign_lines (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  line_id      TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, line_id)
);

-- Mensagens (variações) disponíveis para cada disparo.
CREATE TABLE campaign_messages (
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  message_template_id  TEXT NOT NULL REFERENCES message_templates(id) ON DELETE RESTRICT,
  PRIMARY KEY (campaign_id, message_template_id)
);

-- Fila de processamento + envio individual (estado atual de cada contato na campanha).
CREATE TABLE send_jobs (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id           TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  line_id              TEXT REFERENCES lines(id) ON DELETE SET NULL,
  message_template_id  TEXT REFERENCES message_templates(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','sent','failed','skipped')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  provider_message_id  TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  processed_at         TEXT,
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX idx_send_jobs_campaign_status ON send_jobs (campaign_id, status);
CREATE INDEX idx_send_jobs_line_status ON send_jobs (line_id, status);

-- Histórico imutável: um registro por tentativa de envio.
CREATE TABLE send_attempts (
  id                   TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE,
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id           TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  line_id              TEXT REFERENCES lines(id) ON DELETE SET NULL,
  message_template_id  TEXT REFERENCES message_templates(id) ON DELETE SET NULL,
  rendered_body        TEXT,
  result               TEXT NOT NULL CHECK (result IN ('sent','failed')),
  error                TEXT,
  provider_message_id  TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_send_attempts_campaign ON send_attempts (campaign_id, created_at);
CREATE INDEX idx_send_attempts_line ON send_attempts (line_id, created_at);
CREATE INDEX idx_send_attempts_contact ON send_attempts (contact_id);

-- Logs operacionais (conexões, comandos, erros).
CREATE TABLE logs (
  id           TEXT PRIMARY KEY,
  level        TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  scope        TEXT NOT NULL,
  message      TEXT NOT NULL,
  line_id      TEXT REFERENCES lines(id) ON DELETE SET NULL,
  campaign_id  TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  data         TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_logs_created ON logs (created_at);
CREATE INDEX idx_logs_line ON logs (line_id, created_at);

-- Configurações globais (chave/valor JSON).
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
