import { errorMessage } from '../../shared/errors.ts';
import { WakeSignal } from '../../shared/signal.ts';
import type { CampaignService } from '../campaigns/campaign.service.ts';
import type { ContactService } from '../contacts/contact.service.ts';
import type { DistributionEngine } from '../distribution/distribution.engine.ts';
import type { DistributionTicket, MessageSelector } from '../distribution/distribution.types.ts';
import type { HistoryService } from '../history/history.service.ts';
import type { LineManager } from '../lines/line.manager.ts';
import type { LogService } from '../logs/log.service.ts';
import { renderMessage } from '../messages/message.renderer.ts';
import type { SendQueue } from '../queue/send-queue.ts';
import type { SendJob } from '../queue/queue.types.ts';
import type { DispatchOptions, WorkerSnapshot, WorkerState } from './dispatch.types.ts';

export interface LineWorkerDeps {
  lines: LineManager;
  queue: SendQueue;
  campaigns: CampaignService;
  contacts: ContactService;
  history: HistoryService;
  selector: MessageSelector;
  distribution: DistributionEngine;
  logs: LogService;
  options: DispatchOptions;
  onChange: (snapshot: WorkerSnapshot) => void;
}

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Loop de processamento de UMA linha.
 *
 * Enquanto a linha estiver apta (conectada + ativa), pede vaga ao motor de
 * distribuição, reserva o próximo contato pendente dos processos em que ela foi
 * selecionada, envia, registra no histórico e respeita o intervalo da linha.
 *
 * - Pausar a linha: o envio em curso termina e o loop para de reservar contatos.
 * - Retomar: o loop continua do próximo contato pendente (nada é reiniciado).
 * - Queda/erro: só este loop espera; os workers das outras linhas não sabem disso.
 */
export class LineWorker {
  readonly lineId: string;
  private readonly deps: LineWorkerDeps;
  private readonly signal = new WakeSignal();
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private nextSendAtMs = 0;
  private snap: WorkerSnapshot;

  constructor(lineId: string, deps: LineWorkerDeps) {
    this.lineId = lineId;
    this.deps = deps;
    this.snap = {
      lineId,
      state: 'line_unavailable',
      campaignId: null,
      nextSendAt: null,
      sentToday: 0,
      lastSentAt: null,
      lastError: null,
    };
  }

  snapshot(): WorkerSnapshot {
    return this.snap;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
  }

  /** Pede reavaliação imediata (linha mudou, processo mudou...). */
  wake(): void {
    this.signal.notify();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.signal.notify();
    await this.loopDone;
    this.update('stopped');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let waitMs: number;
      try {
        waitMs = await this.tick();
      } catch (error) {
        if (!this.deps.lines.has(this.lineId)) break; // linha removida
        const message = errorMessage(error);
        this.update('error', { lastError: message });
        this.deps.logs.write({ level: 'error', scope: 'dispatch', lineId: this.lineId, message: `Erro no processamento: ${message}` });
        waitMs = this.deps.options.errorBackoffMs;
      }
      if (!this.running) break;
      if (waitMs > 0) await this.signal.wait(waitMs);
      else await yieldToEventLoop();
    }
  }

  /** Um passo do loop. Retorna quanto tempo esperar antes do próximo (0 = seguir já). */
  private async tick(): Promise<number> {
    const { lines, campaigns, history, queue, distribution, options } = this.deps;
    const line = lines.readiness(this.lineId);

    if (!line.available) return this.idle('line_unavailable');

    const campaignIds = await campaigns.runningIdsForLine(this.lineId);
    if (campaignIds.length === 0) return this.idle('no_process');

    const sentToday = await history.countSentSince(this.lineId, startOfToday().toISOString());
    if (sentToday >= line.settings.dailyLimit) {
      const untilMidnight = startOfToday().getTime() + 86_400_000 - Date.now();
      return this.idle('daily_limit', { sentToday }, Math.min(untilMidnight, options.idlePollMs));
    }

    const cooldown = this.nextSendAtMs - Date.now();
    if (cooldown > 0) {
      this.update('cooldown', { sentToday });
      return cooldown;
    }

    // Distribuição: só pega contato se o motor conceder vaga na rodada atual.
    let job: SendJob | null = null;
    let ticket: DistributionTicket | null = null;
    let waitingTurn = false;
    for (const campaignId of campaignIds) {
      ticket = await distribution.reserve(campaignId, this.lineId);
      if (!ticket) {
        waitingTurn = true;
        continue;
      }
      job = await queue.claimNext(campaignId, this.lineId);
      if (job) break;
      distribution.release(ticket);
      ticket = null;
    }
    if (!job || !ticket) {
      // Sem contato para esta linha: se os pendentes restantes foram pulados fora
      // do worker (ex.: contato bloqueado), o processo precisa ser concluído aqui.
      if (!waitingTurn) for (const campaignId of campaignIds) await this.deps.campaigns.completeIfDone(campaignId);
      return this.idle(waitingTurn ? 'waiting_turn' : 'no_contacts', { sentToday });
    }

    const outcome = await this.process(job, ticket);
    if (outcome !== 'attempted') distribution.release(ticket); // nada foi enviado: a vaga volta para a linha
    if (outcome === 'no_message') return this.idle('no_message');
    if (outcome === 'skipped') return 0;

    // O intervalo pertence ao CICLO (sorteado uma vez para o ciclo inteiro), não à mensagem.
    const intervalMs = ticket.intervalSeconds * 1000;
    this.nextSendAtMs = Date.now() + intervalMs;
    this.update(intervalMs > 0 ? 'cooldown' : this.snap.state, {
      nextSendAt: intervalMs > 0 ? new Date(this.nextSendAtMs).toISOString() : null,
    });
    return 0;
  }

  /** Envia um job reservado. Sem mensagem, o job volta à fila; contato bloqueado é pulado. */
  private async process(job: SendJob, ticket: DistributionTicket): Promise<'attempted' | 'no_message' | 'skipped'> {
    const { contacts, selector, lines, history, queue, campaigns, options } = this.deps;
    let settled = false;
    try {
      const contact = await contacts.get(job.contactId);
      if (contact.status === 'blocked') {
        await queue.skip(job.id, 'Contato bloqueado');
        settled = true;
        await campaigns.completeIfDone(job.campaignId);
        return 'skipped';
      }
      const message = await selector.select({ campaignId: job.campaignId, contactId: contact.id, lineId: this.lineId });
      if (!message) {
        await queue.release(job.id);
        settled = true;
        return 'no_message';
      }

      const body = renderMessage(message.body, contact);
      this.update('sending', { campaignId: job.campaignId });
      const lineLabel = lines.labelOf(this.lineId);
      const result = await lines.send(this.lineId, { to: contact.phone, body });

      if (result.ok) {
        await history.recordAttempt({
          jobId: job.id,
          lineId: this.lineId,
          lineLabel,
          messageTemplateId: message.id,
          messageLabel: message.name,
          renderedBody: body,
          result: 'sent',
          providerMessageId: result.providerMessageId,
          cycleNumber: ticket.round,
          cycleIntervalSeconds: ticket.intervalSeconds,
        });
        this.update('sending', { lastSentAt: new Date().toISOString(), sentToday: this.snap.sentToday + 1, lastError: null });
        this.deps.logs.write({
          level: 'info',
          scope: 'send',
          lineId: this.lineId,
          campaignId: job.campaignId,
          message: `Enviado para ${contact.name ?? contact.phone} (${message.name}, ciclo ${ticket.round})`,
          data: { contactId: contact.id, cycle: ticket.round, intervalSeconds: ticket.intervalSeconds },
        });
      } else {
        const requeue = result.retryable && job.attempts + 1 < options.maxAttempts;
        await history.recordAttempt({
          jobId: job.id,
          lineId: this.lineId,
          lineLabel,
          messageTemplateId: message.id,
          messageLabel: message.name,
          renderedBody: body,
          result: 'failed',
          error: result.error,
          requeue,
          cycleNumber: ticket.round,
          cycleIntervalSeconds: ticket.intervalSeconds,
        });
        this.update('sending', { lastError: result.error });
        this.deps.logs.write({
          level: 'error',
          scope: 'send',
          lineId: this.lineId,
          campaignId: job.campaignId,
          message: `Falha de envio para ${contact.name ?? contact.phone}: ${result.error}${requeue ? ' (contato voltou para a fila)' : ''}`,
          data: { contactId: contact.id, cycle: ticket.round, requeued: requeue },
        });
      }
      settled = true;
      // Pausa programada: verifica o contador INDIVIDUAL desta linha.
      if (result.ok) await lines.applyScheduledPause(this.lineId);
      await campaigns.completeIfDone(job.campaignId);
      return 'attempted';
    } finally {
      // Exceção antes de registrar: o contato volta para a fila, sem se perder.
      if (!settled) {
        await queue.release(job.id).catch((error) =>
          this.deps.logs.write({
            level: 'error',
            scope: 'queue',
            lineId: this.lineId,
            campaignId: job.campaignId,
            message: `Falha ao devolver contato à fila após erro: ${errorMessage(error)} (será recuperado ao reiniciar)`,
          }),
        );
      }
    }
  }

  private idle(state: WorkerState, extra: Partial<WorkerSnapshot> = {}, waitMs = this.deps.options.idlePollMs): number {
    this.update(state, extra);
    return waitMs;
  }

  private update(state: WorkerState, extra: Partial<WorkerSnapshot> = {}): void {
    const next = { ...this.snap, ...extra, state };
    const changed = (Object.keys(next) as (keyof WorkerSnapshot)[]).some((key) => next[key] !== this.snap[key]);
    this.snap = next;
    if (changed) this.deps.onChange(next);
  }
}
