import type { EventBus } from '../../shared/events.ts';
import type { CampaignService } from '../campaigns/campaign.service.ts';
import type { ContactService } from '../contacts/contact.service.ts';
import type { DistributionEngine } from '../distribution/distribution.engine.ts';
import type { MessageSelector } from '../distribution/distribution.types.ts';
import type { HistoryService } from '../history/history.service.ts';
import type { LineManager } from '../lines/line.manager.ts';
import type { LogService } from '../logs/log.service.ts';
import type { SendQueue } from '../queue/send-queue.ts';
import type { DispatchOptions, WorkerSnapshot } from './dispatch.types.ts';
import { LineWorker } from './line-worker.ts';

export interface DispatchServiceDeps {
  lines: LineManager;
  queue: SendQueue;
  campaigns: CampaignService;
  contacts: ContactService;
  history: HistoryService;
  selector: MessageSelector;
  distribution: DistributionEngine;
  logs: LogService;
  events: EventBus;
  options: DispatchOptions;
}

/**
 * Mantém UM worker por linha, criado/encerrado junto com a linha.
 *
 * Não decide nada sobre envios: apenas repassa avisos ("algo mudou") aos
 * workers. Cada worker decide sozinho, a partir do estado da SUA linha, se
 * trabalha ou espera.
 */
export class DispatchService {
  private readonly deps: DispatchServiceDeps;
  private readonly workers = new Map<string, LineWorker>();
  private readonly unsubscribers: (() => void)[] = [];
  private started = false;
  /** Última disponibilidade conhecida de cada linha (mudança acorda todos os workers). */
  private readonly availability = new Map<string, boolean>();

  constructor(deps: DispatchServiceDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.started || !this.deps.options.enabled) return;
    this.started = true;
    const { events } = this.deps;

    this.unsubscribers.push(
      events.on('line.updated', (line) => {
        this.ensureWorker(line.id).wake();
        // Linha entrou/saiu da distribuição: as outras reavaliam a rodada na hora.
        if (this.availability.get(line.id) !== line.available) {
          this.availability.set(line.id, line.available);
          this.wakeAll();
        }
      }),
      events.on('distribution.round', () => this.wakeAll()),
      events.on('line.removed', ({ id }) => void this.removeWorker(id)),
      // Processo iniciado/retomado/linhas alteradas: todas reavaliam.
      events.on('campaign.updated', () => this.wakeAll()),
      // Mensagem (re)ativada: workers parados por falta de mensagem voltam na hora.
      events.on('messages.updated', () => this.wakeAll()),
    );

    for (const line of await this.deps.lines.list()) this.ensureWorker(line.id);
  }

  snapshots(): WorkerSnapshot[] {
    return [...this.workers.values()].map((worker) => worker.snapshot());
  }

  snapshot(lineId: string): WorkerSnapshot | null {
    return this.workers.get(lineId)?.snapshot() ?? null;
  }

  async stop(): Promise<void> {
    this.unsubscribers.splice(0).forEach((off) => off());
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.stop()));
    this.workers.clear();
    this.started = false;
  }

  private ensureWorker(lineId: string): LineWorker {
    let worker = this.workers.get(lineId);
    if (!worker) {
      worker = new LineWorker(lineId, {
        ...this.deps,
        onChange: (snapshot) => this.deps.events.emit('worker.updated', snapshot),
      });
      this.workers.set(lineId, worker);
      if (this.started) worker.start();
    }
    return worker;
  }

  private wakeAll(): void {
    for (const worker of this.workers.values()) worker.wake();
  }

  private async removeWorker(lineId: string): Promise<void> {
    this.availability.delete(lineId);
    const worker = this.workers.get(lineId);
    if (!worker) return;
    this.workers.delete(lineId);
    await worker.stop();
  }
}
