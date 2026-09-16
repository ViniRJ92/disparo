-- =====================================================================
-- Módulo 5: segurança de concorrência da distribuição
-- =====================================================================

-- Garantia no próprio banco: um contato só pode estar "processing" em UM envio
-- por vez, mesmo que duas linhas tentem reservá-lo ao mesmo tempo (inclusive
-- entre processos diferentes). A reserva em código já evita isso; o índice
-- torna a regra impossível de violar.
CREATE UNIQUE INDEX idx_send_jobs_one_processing_per_contact
  ON send_jobs (contact_id) WHERE status = 'processing';
