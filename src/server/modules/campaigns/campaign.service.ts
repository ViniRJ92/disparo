import { DomainError, errorMessage, notFound } from '../../shared/errors.ts';
import type { EventBus } from '../../shared/events.ts';
import { newId, nowIso } from '../../shared/ids.ts';
import type { ContactProcessingSync } from '../contacts/contact-processing.sync.ts';
import type { ContactService } from '../contacts/contact.service.ts';
import type { LineManager } from '../lines/line.manager.ts';
import type { BulkCommandResult } from '../lines/line.types.ts';
import type { LogService } from '../logs/log.service.ts';
import type { MessageService } from '../messages/message.service.ts';
import type { SendQueue } from '../queue/send-queue.ts';
import { emptyJobCounts } from '../queue/queue.types.ts';
import type { CampaignRepository } from './campaign.repository.ts';
import { assertEditable, nextCampaignStatus } from './campaign.rules.ts';
import type {
  Campaign,
  CampaignAction,
  CampaignDetail,
  CampaignSummary,
  CreateCampaignInput,
} from './campaign.types.ts';

export interface CampaignServiceDeps {
  repo: CampaignRepository;
  queue: SendQueue;
  lines: LineManager;
  contacts: ContactService;
  contactSync: ContactProcessingSync;
  messages: MessageService;
  events: EventBus;
  logs: LogService;
}

/**
 * Camada de controle GLOBAL de cada disparo: quais linhas foram selecionadas,
 * quais mensagens, quais contatos, status do processo e totais.
 *
 * Os comandos de campanha (iniciar/pausar/retomar/cancelar) mudam apenas o
 * status do processo. Eles nunca alteram o estado individual das linhas: pausar
 * a campanha não pausa a Linha 2, e pausar a Linha 2 não pausa a campanha.
 */
export class CampaignService {
  private readonly deps: CampaignServiceDeps;

  constructor(deps: CampaignServiceDeps) {
    this.deps = deps;
    deps.events.on('send.recorded', ({ campaignId }) => this.notify(campaignId));
  }

  async list(): Promise<CampaignSummary[]> {
    const [campaigns, counts] = await Promise.all([this.deps.repo.list(), this.deps.queue.countsByCampaign()]);
    return Promise.all(
      campaigns.map(async (campaign) => ({
        ...campaign,
        lineIds: await this.deps.repo.lineIds(campaign.id),
        counts: counts.get(campaign.id) ?? emptyJobCounts(),
      })),
    );
  }

  async summary(id: string): Promise<CampaignSummary> {
    const campaign = await this.find(id);
    return {
      ...campaign,
      lineIds: await this.deps.repo.lineIds(id),
      counts: await this.deps.queue.counts(id),
    };
  }

  async detail(id: string): Promise<CampaignDetail> {
    const summary = await this.summary(id);
    const selected = new Set(summary.lineIds);
    const [allLines, perLine] = await Promise.all([this.deps.lines.list(), this.deps.queue.countsByLine(id)]);
    const lines = allLines
      .filter((line) => selected.has(line.id))
      .map((line) => ({ line, counts: perLine.get(line.id) ?? emptyJobCounts() }));
    return { ...summary, lines, availableLineCount: lines.filter(({ line }) => line.available).length };
  }

  async create(input: CreateCampaignInput): Promise<CampaignDetail> {
    const name = input.name.trim();
    if (!name) throw new DomainError('VALIDATION', 'Informe o nome da campanha');
    this.assertLinesExist(input.lineIds);

    const now = nowIso();
    const campaign: Campaign = {
      id: newId(),
      name,
      status: 'draft',
      settings: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    const contactIds = input.contactIds ?? (input.audience ? await this.deps.contacts.idsForAudience(input.audience) : []);
    await this.deps.repo.insert(campaign, input.lineIds);
    if (contactIds.length) await this.enqueueContacts(campaign.id, contactIds);

    this.deps.logs.write({ level: 'info', scope: 'campaign', campaignId: campaign.id, message: `Campanha "${name}" criada` });
    await this.notify(campaign.id);
    if (!input.start) return this.detail(campaign.id);

    try {
      return await this.execute(campaign.id, 'start');
    } catch (error) {
      // Criado como rascunho: o motivo (sem mensagem ativa, sem linha...) volta para a tela.
      if (error instanceof DomainError) {
        throw new DomainError(error.code, `Disparo salvo como rascunho, mas não iniciado: ${error.message}`, { campaignId: campaign.id });
      }
      throw error;
    }
  }

  /** Define as linhas selecionadas (pode mudar durante o disparo: 1..N linhas). */
  async setLines(id: string, lineIds: readonly string[]): Promise<CampaignDetail> {
    const campaign = await this.find(id);
    assertEditable(campaign.status);
    this.assertLinesExist(lineIds);
    if (campaign.status !== 'draft' && lineIds.length === 0) {
      throw new DomainError('VALIDATION', 'Uma campanha em andamento precisa de ao menos uma linha');
    }
    await this.deps.repo.replaceLines(id, lineIds);
    await this.touch(campaign);
    return this.detail(id);
  }

  async addContacts(id: string, contactIds: readonly string[]): Promise<{ added: number; campaign: CampaignDetail }> {
    const campaign = await this.find(id);
    assertEditable(campaign.status);
    const added = await this.enqueueContacts(id, contactIds);
    await this.touch(campaign);
    return { added, campaign: await this.detail(id) };
  }

  async execute(id: string, action: CampaignAction): Promise<CampaignDetail> {
    const campaign = await this.find(id);
    const status = nextCampaignStatus(campaign.status, action);

    if (action === 'start') {
      const summary = await this.summary(id);
      if (summary.lineIds.length === 0) throw new DomainError('VALIDATION', 'Selecione ao menos uma linha');
      if ((await this.deps.messages.listActive()).length === 0) {
        throw new DomainError('VALIDATION', 'Não há nenhuma mensagem ativa: ative ao menos uma mensagem');
      }
      if (summary.counts.total === 0) throw new DomainError('VALIDATION', 'Adicione contatos à campanha');
    }

    const now = nowIso();
    await this.deps.repo.save({
      ...campaign,
      status,
      updatedAt: now,
      startedAt: action === 'start' ? now : campaign.startedAt,
      finishedAt: status === 'completed' || status === 'cancelled' ? now : campaign.finishedAt,
    });
    if (status === 'cancelled') {
      // Encerrar: quem ainda não foi enviado sai da fila com motivo registrado.
      const skipped = await this.deps.queue.skipPendingForCampaign(id, 'Disparo encerrado');
      if (skipped > 0) {
        this.deps.logs.write({ level: 'info', scope: 'campaign', campaignId: id, message: `${skipped} contato(s) não enviado(s): disparo encerrado` });
      }
    }
    // Cancelar/concluir muda o que conta como "pendente" para os contatos do processo.
    this.deps.contactSync.campaign(id);
    this.deps.logs.write({
      level: 'info',
      scope: 'campaign',
      campaignId: id,
      message: `Campanha "${campaign.name}": ${campaign.status} -> ${status}`,
    });
    await this.notify(id);
    return this.detail(id);
  }

  /** Linhas selecionadas para o processo. */
  lineIds(campaignId: string): Promise<string[]> {
    return this.deps.repo.lineIds(campaignId);
  }

  /**
   * PAUSAR TODAS: pausa as linhas ativas deste disparo. O processo continua
   * "em andamento" e cada linha pode ser retomada individualmente depois.
   */
  pauseAllLines(id: string): Promise<BulkCommandResult[]> {
    return this.lineCommandForAll(id, 'pause');
  }

  /** RETOMAR TODAS: retoma as linhas pausadas deste disparo. */
  resumeAllLines(id: string): Promise<BulkCommandResult[]> {
    return this.lineCommandForAll(id, 'resume');
  }

  /** ENCERRAR DISPARO: finaliza o processo de forma definitiva (não pode ser retomado). */
  finish(id: string): Promise<CampaignDetail> {
    return this.execute(id, 'cancel');
  }

  /** Processos (de qualquer status) em que a linha está selecionada. */
  async listForLine(lineId: string): Promise<CampaignSummary[]> {
    return Promise.all((await this.deps.repo.idsForLine(lineId)).map((id) => this.summary(id)));
  }

  runningIdsForLine(lineId: string): Promise<string[]> {
    return this.deps.repo.runningIdsForLine(lineId);
  }

  /** Conclui o processo quando não resta nenhum contato pendente ou em envio. */
  async completeIfDone(id: string): Promise<boolean> {
    const campaign = await this.deps.repo.findById(id);
    if (!campaign || campaign.status !== 'running') return false;
    const counts = await this.deps.queue.counts(id);
    if (counts.pending + counts.processing > 0) return false;
    try {
      await this.execute(id, 'complete');
      return true;
    } catch (error) {
      // Outra linha concluiu ao mesmo tempo (esperado). Qualquer outra falha é registrada.
      if (!(error instanceof DomainError && error.code === 'INVALID_STATE')) {
        this.deps.logs.write({ level: 'error', scope: 'campaign', campaignId: id, message: `Falha ao concluir o processo: ${errorMessage(error)}` });
      }
      return false;
    }
  }

  async remove(id: string): Promise<void> {
    const campaign = await this.find(id);
    if (campaign.status === 'running' || campaign.status === 'paused') {
      throw new DomainError('INVALID_STATE', 'Cancele a campanha antes de removê-la');
    }
    // Encerrado com um envio ainda em curso: remover agora apagaria o registro desse envio.
    if ((await this.deps.queue.counts(id)).processing > 0) {
      throw new DomainError('INVALID_STATE', 'Aguarde o envio em curso terminar antes de remover o disparo');
    }
    const contactIds = (await this.deps.queue.list({ campaignId: id, limit: 1_000_000 })).map((job) => job.contactId);
    await this.deps.repo.delete(id);
    this.deps.contactSync.contacts(contactIds);
  }

  // ---------------------------------------------------------------- internos

  private async lineCommandForAll(id: string, command: 'pause' | 'resume'): Promise<BulkCommandResult[]> {
    const campaign = await this.find(id);
    assertEditable(campaign.status);
    const results = await this.deps.lines.executeMany(await this.deps.repo.lineIds(id), command);
    const done = results.filter((r) => r.outcome === 'done').length;
    this.deps.logs.write({
      level: 'info',
      scope: 'campaign',
      campaignId: id,
      message: `${command === 'pause' ? 'Pausar todas' : 'Retomar todas'}: ${done} linha(s) ${command === 'pause' ? 'pausada(s)' : 'retomada(s)'}`,
    });
    return results;
  }

  private async find(id: string): Promise<Campaign> {
    const campaign = await this.deps.repo.findById(id);
    if (!campaign) throw notFound('Campanha', id);
    return campaign;
  }

  /** Enfileira contatos existentes; bloqueados ficam de fora. */
  private async enqueueContacts(campaignId: string, contactIds: readonly string[]): Promise<number> {
    const existing = await this.deps.contacts.existingIds(contactIds);
    const missing = contactIds.filter((contactId) => !existing.has(contactId));
    if (missing.length) throw new DomainError('VALIDATION', 'Contatos inexistentes', { missing });
    const blocked = await this.deps.contacts.blockedIds(contactIds);
    return this.deps.queue.enqueue(campaignId, contactIds.filter((contactId) => !blocked.has(contactId)));
  }

  private assertLinesExist(lineIds: readonly string[]): void {
    const missing = lineIds.filter((lineId) => !this.deps.lines.has(lineId));
    if (missing.length) throw new DomainError('VALIDATION', 'Linhas inexistentes', { missing });
  }

  private async touch(campaign: Campaign): Promise<void> {
    await this.deps.repo.save({ ...campaign, updatedAt: nowIso() });
    await this.notify(campaign.id);
  }

  private async notify(campaignId: string): Promise<void> {
    try {
      this.deps.events.emit('campaign.updated', await this.summary(campaignId));
    } catch (error) {
      console.error(`[campaigns] falha ao notificar ${campaignId}: ${errorMessage(error)}`);
      this.deps.logs.write({ level: 'error', scope: 'campaign', campaignId, message: `Falha ao atualizar a tela do processo: ${errorMessage(error)}` });
    }
  }
}
