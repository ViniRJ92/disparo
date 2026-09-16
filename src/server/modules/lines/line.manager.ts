import { DomainError, errorMessage, invalidState, notFound } from '../../shared/errors.ts';
import type { EventBus } from '../../shared/events.ts';
import { newId, nowIso } from '../../shared/ids.ts';
import type { LogService } from '../logs/log.service.ts';
import type { ProviderRegistry } from '../providers/provider.registry.ts';
import type { SendResult, SendTextRequest } from '../providers/provider.types.ts';
import { lineSettingsSchema } from '../settings/settings.schema.ts';
import type { ScheduledPauseSettings } from '../settings/settings.schema.ts';
import type { SettingsService } from '../settings/settings.service.ts';
import type { LineRepository } from './line.repository.ts';
import { bulkCommandApplies, deriveOperationalState, summarizeLines } from './line.rules.ts';
import { LineRuntime } from './line.runtime.ts';
import { EMPTY_LINE_ACTIVITY } from './line.types.ts';
import type {
  BulkCommandResult,
  BulkLineCommand,
  CreateLineInput,
  Line,
  LineCommand,
  LinesSummary,
  LineView,
  PendingCounter,
  UpdateLineInput,
} from './line.types.ts';

export interface LineManagerDeps {
  repo: LineRepository;
  providers: ProviderRegistry;
  settings: SettingsService;
  events: EventBus;
  logs: LogService;
  pending: PendingCounter;
  /** Backoff da reconexão automática (ms). Padrão: 5s, 15s, 30s, 60s, 120s. */
  reconnectDelaysMs?: readonly number[];
}

const DEFAULT_RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/**
 * Gerencia a COLEÇÃO de linhas (1..N, N <= 10). Nenhuma lógica depende de uma
 * linha específica: tudo é feito sobre a lista de runtimes, e cada comando é
 * encaminhado apenas ao runtime da linha alvo.
 */
export class LineManager {
  private readonly deps: LineManagerDeps;
  private readonly runtimes = new Map<string, LineRuntime>();
  /** Linhas com atualização a emitir (rajadas viram um único evento por linha). */
  private readonly pendingEmits = new Set<string>();
  private emitScheduled = false;
  /** Cópia das configurações da pausa programada (atualizada a cada alteração). */
  private scheduledPause: ScheduledPauseSettings = { enabled: false, limit: null };

  constructor(deps: LineManagerDeps) {
    this.deps = deps;
    deps.events.on('send.recorded', ({ lineId }) => void this.refreshCounters(lineId));
  }

  /** Carrega as linhas do banco e restaura as conexões, cada uma isoladamente. */
  async init(): Promise<void> {
    this.scheduledPause = (await this.deps.settings.get()).scheduledPause;
    this.deps.settings.onChange((next, previous) => void this.onSettingsChanged(next.scheduledPause, previous.scheduledPause));
    const lines = await this.deps.repo.findAll();
    for (const line of lines) this.runtimes.set(line.id, this.createRuntime(line));
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.restoreAfterRestart()));
  }

  // ---------------------------------------------------------------- consulta

  async list(): Promise<LineView[]> {
    const pending = await this.deps.pending.pendingByLine();
    return this.sortedRuntimes().map((runtime) => this.toView(runtime, pending));
  }

  async get(id: string): Promise<LineView> {
    const runtime = this.runtime(id);
    return this.toView(runtime, await this.deps.pending.pendingByLine());
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  labelOf(id: string): string {
    return this.runtime(id).snapshot().label;
  }

  /** Consulta barata (sem pendentes) usada pelo worker a cada ciclo. */
  readiness(id: string): { available: boolean; settings: Line['settings'] } {
    const runtime = this.runtime(id);
    return { available: runtime.isAvailable(), settings: runtime.snapshot().settings };
  }

  /** Linhas aptas a enviar agora; opcionalmente restritas a um subconjunto (ex.: linhas da campanha). */
  async available(lineIds?: readonly string[]): Promise<LineView[]> {
    const views = await this.list();
    const filter = lineIds ? new Set(lineIds) : null;
    return views.filter((view) => view.available && (!filter || filter.has(view.id)));
  }

  async summary(): Promise<LinesSummary> {
    const { maxLines } = await this.deps.settings.get();
    return summarizeLines(
      this.sortedRuntimes().map((runtime) => runtime.snapshot()),
      maxLines,
    );
  }

  // ---------------------------------------------------------------- cadastro

  async create(input: CreateLineInput): Promise<LineView> {
    const appSettings = await this.deps.settings.get();
    if (this.runtimes.size >= appSettings.maxLines) {
      throw new DomainError('LIMIT_EXCEEDED', `Limite de ${appSettings.maxLines} linha(s) atingido`);
    }
    if (!this.deps.providers.has(input.provider)) {
      throw new DomainError('VALIDATION', `Provedor desconhecido: ${input.provider}`);
    }
    const label = input.label.trim();
    if (!label) throw new DomainError('VALIDATION', 'Informe a identificação da linha');

    const now = nowIso();
    const line: Line = {
      id: newId(),
      label,
      provider: input.provider,
      providerConfig: input.providerConfig ?? {},
      accountId: null,
      displayName: null,
      connectionStatus: 'disconnected',
      operationalStatus: 'idle',
      runState: 'stopped',
      pauseReason: null,
      scheduledPauseCount: 0,
      scheduledPausePending: false,
      connectedAt: null,
      lastError: null,
      settings: this.validateSettings({ ...appSettings.defaultLineSettings, ...input.settings }),
      counters: { contactsProcessed: 0, messagesSent: 0, failures: 0 },
      activity: EMPTY_LINE_ACTIVITY,
      position: await this.deps.repo.nextPosition(),
      createdAt: now,
      updatedAt: now,
    };

    await this.deps.repo.insert(line);
    const runtime = this.createRuntime(line);
    this.runtimes.set(line.id, runtime);
    this.deps.logs.write({ level: 'info', scope: 'line', lineId: line.id, message: `Linha "${label}" cadastrada` });
    const view = await this.get(line.id);
    this.deps.events.emit('line.updated', view);
    return view;
  }

  async update(id: string, input: UpdateLineInput): Promise<LineView> {
    const runtime = this.runtime(id);
    const current = runtime.snapshot();
    const changes: Parameters<LineRuntime['update']>[0] = {};
    if (input.label !== undefined) {
      const label = input.label.trim();
      if (!label) throw new DomainError('VALIDATION', 'Informe a identificação da linha');
      changes.label = label;
    }
    const renamedFrom = changes.label && changes.label !== current.label ? current.label : null;
    if (input.settings) changes.settings = this.validateSettings({ ...current.settings, ...input.settings });
    if (input.providerConfig) {
      if (current.runState !== 'stopped' || current.connectionStatus !== 'disconnected') {
        throw invalidState('Desconecte a linha antes de alterar a configuração do provedor');
      }
      changes.providerConfig = input.providerConfig;
    }
    if (input.position !== undefined) changes.position = input.position;
    await runtime.update(changes);

    if (input.providerConfig) {
      // Nova configuração => nova instância de provedor, só para esta linha.
      await runtime.dispose();
      this.runtimes.set(id, this.createRuntime(runtime.snapshot()));
    }
    if (renamedFrom) {
      this.deps.logs.write({ level: 'info', scope: 'line', lineId: id, message: `Linha renomeada: "${renamedFrom}" → "${changes.label}"` });
    }
    if (input.settings) {
      this.deps.logs.write({ level: 'info', scope: 'line', lineId: id, message: 'Configurações da linha alteradas', data: { settings: changes.settings } });
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const runtime = this.runtime(id);
    const { label } = runtime.snapshot();
    if (runtime.snapshot().connectionStatus !== 'disconnected' || runtime.snapshot().runState !== 'stopped') {
      await runtime.disconnect().catch((error) =>
        this.deps.logs.write({ level: 'warn', scope: 'line', lineId: id, message: `Erro ao desconectar antes de remover: ${errorMessage(error)}` }),
      );
    }
    await runtime.dispose();
    this.runtimes.delete(id);
    await this.deps.repo.delete(id);
    this.deps.logs.write({ level: 'info', scope: 'line', message: `Linha "${label}" removida`, data: { lineId: id } });
    this.deps.events.emit('line.removed', { id });
  }

  // ---------------------------------------------------------------- pausa programada

  /**
   * Chamado pelo worker após cada envio bem-sucedido da linha. Se a pausa
   * programada estiver ativa e o contador INDIVIDUAL da linha atingir o limite,
   * pausa somente esta linha e aguarda decisão.
   */
  async applyScheduledPause(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id);
    const { enabled, limit } = this.scheduledPause;
    if (!runtime || !enabled || limit === null) return false;
    const tracking = await this.deps.repo.readTracking(id);
    if (!tracking || tracking.scheduledPauseCount < limit) return false;
    const paused = await runtime.pauseScheduled(limit);
    if (paused) {
      this.deps.events.emit('line.scheduled_pause', {
        lineId: id,
        label: runtime.snapshot().label,
        limit,
        count: tracking.scheduledPauseCount,
      });
    }
    return paused;
  }

  /** Quantas mensagens a linha ainda pode enviar antes da pausa programada (Infinity se não se aplica). */
  scheduledPauseRemaining(id: string): number {
    const { enabled, limit } = this.scheduledPause;
    if (!enabled || limit === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit - this.runtime(id).snapshot().scheduledPauseCount);
  }

  /** CONTINUAR: retoma a linha pausada pela pausa programada (contador individual recomeça). */
  async continueAfterScheduledPause(id: string): Promise<LineView> {
    const runtime = this.runtime(id);
    const line = runtime.snapshot();
    if (line.runState !== 'paused' || line.pauseReason !== 'scheduled') {
      throw invalidState(`"${line.label}" não está pausada pela pausa programada`);
    }
    await runtime.resume();
    return this.get(id);
  }

  /** MANTER PAUSADA. */
  async keepPaused(id: string): Promise<LineView> {
    await this.runtime(id).keepPaused();
    return this.get(id);
  }

  private async onSettingsChanged(next: ScheduledPauseSettings, previous: ScheduledPauseSettings): Promise<void> {
    this.scheduledPause = next;
    if (next.enabled === previous.enabled && next.limit === previous.limit) return;
    // Nova regra vale a partir de agora: todos os contadores individuais recomeçam do zero.
    await this.deps.repo.resetScheduledPauseCount();
    for (const runtime of this.runtimes.values()) await runtime.refreshCounters();
    this.deps.logs.write({
      level: 'info',
      scope: 'line',
      message: next.enabled
        ? `Pausa programada ativada: ${next.limit === null ? 'sem limite' : `${next.limit} mensagens por linha`} (contadores zerados)`
        : 'Pausa programada desativada',
    });
  }

  // ---------------------------------------------------------------- comandos individuais

  async execute(id: string, command: LineCommand): Promise<LineView> {
    const runtime = this.runtime(id);
    switch (command) {
      case 'connect':
        await runtime.connect();
        break;
      case 'start':
        await runtime.start();
        break;
      case 'pause':
        await runtime.pause();
        break;
      case 'resume':
        await runtime.resume();
        break;
      case 'disconnect':
        await runtime.disconnect();
        break;
      case 'reconnect':
        await runtime.reconnect();
        break;
    }
    return this.get(id);
  }

  connect = (id: string) => this.execute(id, 'connect');
  start = (id: string) => this.execute(id, 'start');
  pause = (id: string) => this.execute(id, 'pause');
  resume = (id: string) => this.execute(id, 'resume');
  disconnect = (id: string) => this.execute(id, 'disconnect');
  reconnect = (id: string) => this.execute(id, 'reconnect');
  status = (id: string) => this.get(id);

  /**
   * Comando em lote para as linhas selecionadas. Cada linha é tratada de forma
   * independente e em paralelo: falha ou estado incompatível de uma não impede
   * as outras. Não substitui o controle individual (usa os mesmos comandos).
   */
  async executeMany(lineIds: readonly string[], command: BulkLineCommand): Promise<BulkCommandResult[]> {
    const ids = [...new Set(lineIds)];
    const settled = await Promise.allSettled(
      ids.map(async (lineId): Promise<BulkCommandResult> => {
        const runtime = this.runtimes.get(lineId);
        if (!runtime) return { lineId, outcome: 'failed', message: 'Linha inexistente' };
        if (!bulkCommandApplies(runtime.snapshot(), command)) {
          return { lineId, outcome: 'skipped', message: 'Estado atual da linha não comporta o comando', line: await this.get(lineId) };
        }
        return { lineId, outcome: 'done', line: await this.execute(lineId, command) };
      }),
    );
    return settled.map((result, i) =>
      result.status === 'fulfilled'
        ? result.value
        : { lineId: ids[i]!, outcome: 'failed', message: errorMessage(result.reason) },
    );
  }

  /** Envio por uma linha específica. Falhas ficam contidas na linha (nunca lança). */
  async send(id: string, request: SendTextRequest): Promise<SendResult> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return { ok: false, error: `Linha inexistente: ${id}`, retryable: false };
    return runtime.send(request);
  }

  /** Chamado pelo histórico depois que contadores da linha mudam no banco. */
  async refreshCounters(id: string): Promise<void> {
    await this.runtimes.get(id)?.refreshCounters();
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.runtimes.clear();
  }

  // ---------------------------------------------------------------- internos

  private runtime(id: string): LineRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw notFound('Linha', id);
    return runtime;
  }

  private sortedRuntimes(): LineRuntime[] {
    return [...this.runtimes.values()].sort(
      (a, b) =>
        a.snapshot().position - b.snapshot().position || a.snapshot().createdAt.localeCompare(b.snapshot().createdAt),
    );
  }

  private createRuntime(line: Line): LineRuntime {
    const provider = this.deps.providers.create(line.provider, { lineId: line.id, config: line.providerConfig });
    return new LineRuntime(line, {
      repo: this.deps.repo,
      provider,
      onChange: () => this.emitUpdated(line.id),
      onMessage: (message) => this.deps.events.emit('conversation.message', { lineId: line.id, message }),
      log: (input) => this.deps.logs.write({ ...input, scope: 'line', lineId: line.id }),
      reconnectDelaysMs: this.deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS,
    });
  }

  /**
   * Emissão agrupada e protegida: várias mudanças seguidas da mesma linha geram
   * um único evento, e erro ao montar a visão não afeta o comando em curso.
   */
  private emitUpdated(id: string): void {
    this.pendingEmits.add(id);
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setImmediate(() => {
      this.emitScheduled = false;
      const ids = [...this.pendingEmits].filter((lineId) => this.runtimes.has(lineId));
      this.pendingEmits.clear();
      if (ids.length === 0) return;
      this.deps.pending
        .pendingByLine()
        .then((pending) => {
          for (const lineId of ids) {
            const runtime = this.runtimes.get(lineId);
            if (runtime) this.deps.events.emit('line.updated', this.toView(runtime, pending));
          }
        })
        .catch((error) => {
          console.error(`[lines] falha ao emitir atualização: ${errorMessage(error)}`);
          this.deps.logs.write({ level: 'error', scope: 'line', message: `Falha ao atualizar a tela das linhas: ${errorMessage(error)}` });
        });
    });
  }

  private validateSettings(settings: unknown) {
    const parsed = lineSettingsSchema.safeParse(settings);
    if (!parsed.success) throw new DomainError('VALIDATION', 'Configurações da linha inválidas', parsed.error.issues);
    return parsed.data;
  }

  private toView(runtime: LineRuntime, pending: Map<string, number>): LineView {
    const { providerConfig: _secret, ...line } = runtime.snapshot();
    return {
      ...line,
      pending: pending.get(line.id) ?? 0,
      available: runtime.isAvailable(),
      qrCode: runtime.currentQrCode(),
      status: runtime.status(),
      reconnecting: runtime.isReconnecting(),
      nextReconnectAt: runtime.scheduledReconnectAt(),
      operationalState: deriveOperationalState(line),
      scheduledPause: {
        enabled: this.scheduledPause.enabled,
        limit: this.scheduledPause.limit,
        count: line.scheduledPauseCount,
        remaining:
          this.scheduledPause.enabled && this.scheduledPause.limit !== null
            ? Math.max(0, this.scheduledPause.limit - line.scheduledPauseCount)
            : null,
        awaitingDecision: line.runState === 'paused' && line.pauseReason === 'scheduled' && line.scheduledPausePending,
      },
    };
  }
}
