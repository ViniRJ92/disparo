import type { CampaignSummary, ContactProcessingStatus, LineStatus, LineView, WorkerState } from './api/types.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info' | 'primary';

/** Os 7 estados da linha exibidos na interface. */
export const LINE_STATUS_LABEL: Record<LineStatus, { text: string; tone: Tone }> = {
  disconnected: { text: 'Desconectada', tone: 'muted' },
  connecting: { text: 'Conectando', tone: 'info' },
  reconnecting: { text: 'Reconectando', tone: 'warn' },
  connected: { text: 'Conectada', tone: 'info' },
  active: { text: 'Ativa', tone: 'ok' },
  paused: { text: 'Pausada', tone: 'warn' },
  error: { text: 'Erro', tone: 'bad' },
};

export const CONNECTION_LABEL: Record<LineView['connectionStatus'], string> = {
  connected: 'Conectada',
  connecting: 'Conectando',
  qr_required: 'Aguardando QR Code',
  disconnected: 'Desconectada',
  error: 'Erro de conexão',
};

export const OPERATIONAL_STATE_LABEL: Record<LineView['operationalState'], string> = {
  active: 'Ativa',
  paused: 'Pausada',
  stopped: 'Parada',
  error: 'Erro',
};

export const RUN_STATE_LABEL: Record<LineView['runState'], string> = {
  active: 'Ativa',
  paused: 'Pausada',
  stopped: 'Parada',
};

export const WORKER_STATE_LABEL: Record<WorkerState, string> = {
  line_unavailable: 'Fora do processamento',
  no_process: 'Sem processo em andamento',
  no_contacts: 'Sem contatos pendentes',
  waiting_turn: 'Cota do ciclo cumprida: aguardando as outras linhas',
  no_message: 'Sem mensagem disponível',
  daily_limit: 'Limite diário atingido',
  cooldown: 'Aguardando intervalo',
  sending: 'Enviando',
  error: 'Erro no processamento',
  stopped: 'Encerrado',
};

export const CAMPAIGN_STATUS_LABEL: Record<CampaignSummary['status'], { text: string; tone: Tone }> = {
  draft: { text: 'Rascunho', tone: 'muted' },
  running: { text: 'Em andamento', tone: 'ok' },
  paused: { text: 'Pausado', tone: 'warn' },
  completed: { text: 'Concluído', tone: 'info' },
  cancelled: { text: 'Encerrado', tone: 'bad' },
};

export const PROCESSING_LABEL: Record<ContactProcessingStatus, { text: string; tone: Tone }> = {
  idle: { text: 'Sem processo', tone: 'muted' },
  pending: { text: 'Pendente', tone: 'info' },
  waiting: { text: 'Aguardando', tone: 'warn' },
  processing: { text: 'Enviando', tone: 'warn' },
  sent: { text: 'Recebeu', tone: 'ok' },
  failed: { text: 'Erro', tone: 'bad' },
};

export const formatDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export const formatTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export const formatNumber = (n: number) => n.toLocaleString('pt-BR');
