import type { CampaignService } from '../campaigns/campaign.service.ts';
import type { CampaignSummary } from '../campaigns/campaign.types.ts';
import type { ContactService } from '../contacts/contact.service.ts';
import type { DispatchService } from '../dispatch/dispatch.service.ts';
import type { DistributionEngine } from '../distribution/distribution.engine.ts';
import type { RoundSnapshot } from '../distribution/distribution.types.ts';
import type { WorkerSnapshot } from '../dispatch/dispatch.types.ts';
import type { LineManager } from '../lines/line.manager.ts';
import type { LinesSummary, LineView } from '../lines/line.types.ts';
import type { SendQueue } from '../queue/send-queue.ts';
import type { JobCounts } from '../queue/queue.types.ts';

export interface GlobalOverview {
  lines: LinesSummary;
  lineDetails: LineView[];
  /** Situação operacional do worker de cada linha. */
  workers: WorkerSnapshot[];
  contacts: { total: number };
  campaigns: { total: number; running: number; paused: number; draft: number };
  /** Totais somados de todas as campanhas. */
  totals: JobCounts;
  /** Campanhas em andamento ou pausadas, com as linhas selecionadas e seus totais. */
  activeCampaigns: CampaignSummary[];
  /** Rodada de distribuição atual de cada processo ativo (por id do processo). */
  distribution: Record<string, RoundSnapshot | null>;
  generatedAt: string;
}

/** Estatísticas somente leitura, agregadas a partir dos demais módulos. */
export class StatsService {
  private readonly lines: LineManager;
  private readonly campaigns: CampaignService;
  private readonly contacts: ContactService;
  private readonly queue: SendQueue;
  private readonly dispatch: DispatchService;
  private readonly distribution: DistributionEngine;

  constructor(deps: {
    lines: LineManager;
    campaigns: CampaignService;
    contacts: ContactService;
    queue: SendQueue;
    dispatch: DispatchService;
    distribution: DistributionEngine;
  }) {
    this.lines = deps.lines;
    this.campaigns = deps.campaigns;
    this.contacts = deps.contacts;
    this.queue = deps.queue;
    this.dispatch = deps.dispatch;
    this.distribution = deps.distribution;
  }

  async overview(): Promise<GlobalOverview> {
    const [lines, lineDetails, contactsTotal, campaigns, totals] = await Promise.all([
      this.lines.summary(),
      this.lines.list(),
      this.contacts.count(),
      this.campaigns.list(),
      this.queue.counts(),
    ]);
    const active = campaigns.filter((c) => c.status === 'running' || c.status === 'paused');
    const byStatus = (status: CampaignSummary['status']) => campaigns.filter((c) => c.status === status).length;

    return {
      lines,
      lineDetails,
      workers: this.dispatch.snapshots(),
      contacts: { total: contactsTotal },
      campaigns: {
        total: campaigns.length,
        running: byStatus('running'),
        paused: byStatus('paused'),
        draft: byStatus('draft'),
      },
      totals,
      activeCampaigns: active,
      distribution: Object.fromEntries(active.map((c) => [c.id, this.distribution.snapshot(c.id).current])),
      generatedAt: new Date().toISOString(),
    };
  }
}
