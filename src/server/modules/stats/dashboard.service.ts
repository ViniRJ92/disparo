import type { CampaignService } from '../campaigns/campaign.service.ts';
import type { CampaignStatus } from '../campaigns/campaign.types.ts';
import type { ContactService } from '../contacts/contact.service.ts';
import type { DispatchService } from '../dispatch/dispatch.service.ts';
import type { WorkerSnapshot } from '../dispatch/dispatch.types.ts';
import type { DistributionEngine } from '../distribution/distribution.engine.ts';
import type { LineQuotaSnapshot, RoundSnapshot } from '../distribution/distribution.types.ts';
import type { MessageService } from '../messages/message.service.ts';
import type { SettingsService } from '../settings/settings.service.ts';
import type { HistoryService } from '../history/history.service.ts';
import type { SendAttemptView } from '../history/history.types.ts';
import type { LineManager } from '../lines/line.manager.ts';
import type { ConnectionStatus, LineStatus, LineView, OperationalState } from '../lines/line.types.ts';
import type { LogService } from '../logs/log.service.ts';
import type { LogEntry } from '../logs/log.types.ts';
import type { SendQueue } from '../queue/send-queue.ts';
import { emptyJobCounts, type JobCounts } from '../queue/queue.types.ts';

export interface DashboardLines {
  total: number;
  max: number;
  /** Com sessão conectada (ativas, pausadas ou paradas). */
  connected: number;
  /** Conectadas e trabalhando. */
  active: number;
  paused: number;
  withError: number;
  disconnected: number;
  /** Conectando ou reconectando neste momento. */
  connecting: number;
  /** Selecionadas em pelo menos um disparo em andamento. */
  participating: number;
  /** Pausadas pela pausa programada. */
  pausedBySchedule: number;
}

export interface DashboardProcessing {
  /** null = todos os disparos. */
  campaignId: string | null;
  /** Contatos cadastrados no sistema (independe do escopo). */
  contactsRegistered: number;
  /** Contatos colocados nos disparos do escopo (um contato em 2 disparos conta 2 vezes). */
  total: number;
  /** enviados + erros + não enviados (encerrados/bloqueados). */
  processed: number;
  /** Aguardando envio + em envio agora. */
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface DashboardLineRow {
  lineId: string;
  label: string;
  status: LineStatus;
  /** enviados + erros atribuídos a esta linha no escopo. */
  processed: number;
  sent: number;
  failed: number;
  /** Envio em curso nesta linha. */
  processing: number;
  /** Contatos aguardando nos disparos em que a linha participa (fila compartilhada). */
  pending: number;
  lastSentAt: string | null;
  connectionStatus: ConnectionStatus;
  operationalState: OperationalState;
  /** Selecionada no disparo do escopo (ou em algum disparo em andamento, no escopo "todos"). */
  participating: boolean;
  scheduledPause: LineView['scheduledPause'];
  /** Cota desta linha no ciclo atual do disparo (primeiro disparo em andamento em que participa). */
  cycleQuota: (LineQuotaSnapshot & { cycle: number; campaignId: string }) | null;
}

export interface DashboardCycle {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  current: RoundSnapshot | null;
  /** Ciclos já finalizados (mantidos em memória desde que o servidor iniciou). */
  finishedCycles: number;
}

export interface Dashboard {
  lines: DashboardLines;
  processing: DashboardProcessing;
  perLine: DashboardLineRow[];
  messages: { active: number; total: number };
  scheduledPause: { enabled: boolean; limit: number | null };
  /** Ciclo atual de cada disparo em andamento ou pausado. */
  cycles: DashboardCycle[];
  generatedAt: string;
}

export interface LineProcessParticipation {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  counts: JobCounts;
  /** Cota da linha na rodada atual (processos em andamento). */
  quota: LineQuotaSnapshot | null;
}

export interface LineDetail {
  line: LineView;
  worker: WorkerSnapshot | null;
  /** Resultado final dos contatos atribuídos à linha no escopo. */
  counts: JobCounts;
  /** Todas as tentativas (inclui falhas temporárias que voltaram para a fila). */
  attempts: { total: number; sent: number; failed: number };
  lastSentAt: string | null;
  processes: LineProcessParticipation[];
  recentAttempts: SendAttemptView[];
  recentLogs: LogEntry[];
  /** Contatos diferentes que esta linha já processou (enviados ou com falha). */
  contactsProcessed: number;
  /** Uso de cada mensagem por esta linha (envios com sucesso). */
  messagesUsed: { label: string; sent: number }[];
  /** Ciclos em que a linha trabalhou (mais recentes primeiro). */
  cycles: { campaignId: string; campaignName: string; cycle: number; intervalSeconds: number | null; sent: number; failed: number; startedAt: string }[];
  generatedAt: string;
}

export interface DashboardServiceDeps {
  lines: LineManager;
  campaigns: CampaignService;
  contacts: ContactService;
  queue: SendQueue;
  history: HistoryService;
  logs: LogService;
  dispatch: DispatchService;
  distribution: DistributionEngine;
  messages: MessageService;
  settings: SettingsService;
}

/**
 * Indicadores do Dashboard. Nada é estimado ou armazenado à parte: tudo é lido
 * na hora da fila (send_jobs), do histórico (send_attempts), dos contatos e do
 * estado vivo das linhas. Por usar a mesma fonte, a soma por linha fecha com os
 * totais de enviados e erros.
 */
export class DashboardService {
  private readonly deps: DashboardServiceDeps;

  constructor(deps: DashboardServiceDeps) {
    this.deps = deps;
  }

  async dashboard(campaignId?: string): Promise<Dashboard> {
    const { lines, contacts, queue, history, campaigns } = this.deps;
    if (campaignId) await campaigns.summary(campaignId); // 404 se não existir

    const [views, summary, contactsRegistered, totals, perLineCounts, lastSent] = await Promise.all([
      lines.list(),
      lines.summary(),
      contacts.count(),
      queue.counts(campaignId),
      queue.countsByLine(campaignId),
      history.lastSentAtByLine(campaignId),
    ]);

    const scopePending = campaignId ? totals.pending : 0;
    const selected = campaignId ? new Set(await campaigns.lineIds(campaignId)) : null;

    const allCampaigns = await campaigns.list();
    const live = allCampaigns.filter((c) => c.status === 'running' || c.status === 'paused');
    const running = live.filter((c) => c.status === 'running');
    const participatingIds = new Set(running.flatMap((c) => c.lineIds));
    const cycles: DashboardCycle[] = live.map((c) => {
      const snapshot = this.deps.distribution.snapshot(c.id);
      return { campaignId: c.id, name: c.name, status: c.status, current: snapshot.current, finishedCycles: snapshot.past.length };
    });
    const quotaOf = (lineId: string) => {
      const scoped = campaignId ? cycles.filter((c) => c.campaignId === campaignId) : cycles.filter((c) => c.status === 'running');
      for (const cycle of scoped) {
        const quota = cycle.current?.quotas.find((q) => q.lineId === lineId);
        if (quota) return { ...quota, cycle: cycle.current!.number, campaignId: cycle.campaignId };
      }
      return null;
    };
    const [activeMessages, allMessages, appSettings] = await Promise.all([
      this.deps.messages.listActive(),
      this.deps.messages.list(),
      this.deps.settings.get(),
    ]);
    const count = (predicate: (line: LineView) => boolean) => views.filter(predicate).length;

    return {
      lines: {
        total: views.length,
        max: summary.max,
        connected: count((l) => l.connectionStatus === 'connected'),
        active: count((l) => l.status === 'active'),
        paused: count((l) => l.status === 'paused'),
        withError: count((l) => l.status === 'error'),
        disconnected: count((l) => l.status === 'disconnected'),
        connecting: count((l) => l.status === 'connecting' || l.status === 'reconnecting'),
        participating: views.filter((l) => participatingIds.has(l.id)).length,
        pausedBySchedule: count((l) => l.runState === 'paused' && l.pauseReason === 'scheduled'),
      },
      messages: { active: activeMessages.length, total: allMessages.length },
      scheduledPause: appSettings.scheduledPause,
      cycles,
      processing: {
        campaignId: campaignId ?? null,
        contactsRegistered,
        total: totals.total,
        processed: totals.processed,
        pending: totals.pending + totals.processing,
        processing: totals.processing,
        sent: totals.sent,
        failed: totals.failed,
        skipped: totals.skipped,
      },
      perLine: views.map((line) => {
        const counts = perLineCounts.get(line.id) ?? emptyJobCounts();
        return {
          lineId: line.id,
          label: line.label,
          status: line.status,
          processed: counts.sent + counts.failed,
          sent: counts.sent,
          failed: counts.failed,
          processing: counts.processing,
          pending: selected ? (selected.has(line.id) ? scopePending : 0) : line.pending,
          lastSentAt: lastSent.get(line.id) ?? null,
          connectionStatus: line.connectionStatus,
          operationalState: line.operationalState,
          participating: selected ? selected.has(line.id) : participatingIds.has(line.id),
          scheduledPause: line.scheduledPause,
          cycleQuota: quotaOf(line.id),
        };
      }),
      generatedAt: new Date().toISOString(),
    };
  }

  async lineDetail(lineId: string, campaignId?: string): Promise<LineDetail> {
    const { lines, campaigns, queue, history, logs, dispatch, distribution } = this.deps;
    const line = await lines.get(lineId); // 404 se não existir
    if (campaignId) await campaigns.summary(campaignId);

    const [perLineCounts, attempts, lastSent, recentAttempts, recentLogs, participations] = await Promise.all([
      queue.countsByLine(campaignId),
      history.attemptTotalsForLine(lineId, campaignId),
      history.lastSentAtByLine(campaignId),
      history.list({ lineId, campaignId, limit: 20 }),
      logs.list({ lineId, limit: 20 }),
      campaigns.listForLine(lineId),
    ]);

    const [contactsProcessed, messagesUsed, cycles] = [
      history.distinctContactsForLine(lineId, campaignId),
      history.messageUsageForLine(lineId, campaignId),
      history.cyclesForLine(lineId, campaignId),
    ];
    const processes = await Promise.all(
      participations.map(async (campaign) => ({
        campaignId: campaign.id,
        name: campaign.name,
        status: campaign.status,
        counts: (await queue.countsByLine(campaign.id)).get(lineId) ?? emptyJobCounts(),
        quota: distribution.snapshot(campaign.id).current?.quotas.find((q) => q.lineId === lineId) ?? null,
      })),
    );

    return {
      line,
      worker: dispatch.snapshot(lineId),
      counts: perLineCounts.get(lineId) ?? emptyJobCounts(),
      attempts,
      lastSentAt: lastSent.get(lineId) ?? null,
      processes,
      recentAttempts,
      recentLogs,
      contactsProcessed,
      messagesUsed,
      cycles,
      generatedAt: new Date().toISOString(),
    };
  }
}
