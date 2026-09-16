-- =====================================================================
-- Correções pós-Módulo 7: ciclos, pausa programada e rastreabilidade
-- =====================================================================

-- Pausa manual x pausa programada ficam separadas (não se misturam).
ALTER TABLE lines ADD COLUMN pause_reason TEXT CHECK (pause_reason IN ('manual', 'scheduled'));
-- Contador INDIVIDUAL da pausa programada: mensagens enviadas desde a última vez que a linha continuou.
ALTER TABLE lines ADD COLUMN scheduled_pause_count INTEGER NOT NULL DEFAULT 0;
-- A linha pausada pela pausa programada aguarda decisão (Continuar / Manter pausada)?
ALTER TABLE lines ADD COLUMN scheduled_pause_pending INTEGER NOT NULL DEFAULT 0 CHECK (scheduled_pause_pending IN (0, 1));

-- Linhas que já estavam pausadas antes desta versão foram pausadas manualmente.
UPDATE lines SET pause_reason = 'manual' WHERE run_state = 'paused';

-- Histórico: ciclo, intervalo do ciclo, nome da linha no momento e se a falha voltou para a fila.
ALTER TABLE send_attempts ADD COLUMN cycle_number INTEGER;
ALTER TABLE send_attempts ADD COLUMN cycle_interval_seconds REAL;
ALTER TABLE send_attempts ADD COLUMN line_label TEXT;
ALTER TABLE send_attempts ADD COLUMN requeued INTEGER NOT NULL DEFAULT 0 CHECK (requeued IN (0, 1));

-- Nome da linha nos registros antigos (retrato para o caso de a linha ser removida).
UPDATE send_attempts SET line_label = (SELECT l.label FROM lines l WHERE l.id = send_attempts.line_id)
WHERE line_label IS NULL;

CREATE INDEX idx_send_attempts_result_created ON send_attempts (result, created_at);
