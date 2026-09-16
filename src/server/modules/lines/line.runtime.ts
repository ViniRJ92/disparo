import { errorMessage, invalidState } from '../../shared/errors.ts';
import { nowIso } from '../../shared/ids.ts';
import { SerialExecutor } from '../../shared/serial.ts';
import type { LogInput } from '../logs/log.types.ts';
import type { ConnectionUpdate, SendResult, SendTextRequest, WhatsAppProvider } from '../providers/provider.types.ts';
import type { LineRepository } from './line.repository.ts';
import { assertCommandAllowed, deriveLineStatus, isLineAvailable } from './line.rules.ts';
import type { Line, LineStatus } from './line.types.ts';

export interface LineRuntimeDeps {
  repo: LineRepository;
  provider: WhatsAppProvider;
  /** Mensagem de conversa informada pelo provedor desta linha. */
  onMessage?: (message: import('../providers/provider.types.ts').ProviderChatMessage) => void;
  /** Chamado após toda mudança de estado. */
  onChange: (line: Line) => void;
  log: (input: Omit<LogInput, 'lineId' | 'scope'>) => void;
  /**
   * Espera antes de cada tentativa automática de reconexão após uma queda.
   * Esgotadas as tentativas, a linha fica em "erro" até ação manual. [] desativa.
   */
  reconnectDelaysMs: readonly number[];
}

/**
 * Instância viva de UMA linha: estado + provedor próprio + fila de comandos própria
 * + reconexão automática própria.
 *
 * Isolamento: toda exceção do provedor é capturada aqui e vira estado desta
 * linha ("error"), nunca propagando para outras linhas ou para o processo.
 */
export class LineRuntime {
  private line: Line;
  private qrCode: string | null = null;
  private readonly deps: LineRuntimeDeps;
  private readonly serial = new SerialExecutor();
  private readonly unsubscribe: () => void;

  private reconnecting = false;
  /** Enquanto true, quedas informadas pelo provedor são esperadas (desconexão manual). */
  private suppressAutoReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private nextReconnectAt: string | null = null;
  private disposed = false;

  constructor(line: Line, deps: LineRuntimeDeps) {
    this.line = line;
    this.deps = deps;
    const offConnection = deps.provider.onConnectionUpdate((update) => {
      void this.applyConnectionUpdate(update);
    });
    const offMessages = deps.provider.onMessage?.((message) => deps.onMessage?.(message));
    this.unsubscribe = () => {
      offConnection();
      offMessages?.();
    };
  }

  get id(): string {
    return this.line.id;
  }

  snapshot(): Readonly<Line> {
    return this.line;
  }

  currentQrCode(): string | null {
    return this.qrCode;
  }

  isAvailable(): boolean {
    return isLineAvailable(this.line);
  }

  status(): LineStatus {
    return deriveLineStatus(this.line, this.reconnecting || this.reconnectTimer !== null);
  }

  isReconnecting(): boolean {
    return this.reconnecting || this.reconnectTimer !== null;
  }

  scheduledReconnectAt(): string | null {
    return this.nextReconnectAt;
  }

  // ---------------------------------------------------------------- comandos

  /** Conecta sem colocar a linha para trabalhar (fica "conectada"). */
  connect(): Promise<Line> {
    return this.serial.run(async () => {
      assertCommandAllowed(this.line, 'connect');
      this.resetAutoReconnect();
      this.deps.log({ level: 'info', message: 'Conectando linha' });
      await this.connectSafely();
      return this.line;
    });
  }

  start(): Promise<Line> {
    return this.serial.run(async () => {
      assertCommandAllowed(this.line, 'start');
      this.resetAutoReconnect();
      await this.patch({ runState: 'active', pauseReason: null, scheduledPausePending: false });
      this.deps.log({ level: 'info', message: 'Linha iniciada' });
      if (this.line.connectionStatus !== 'connected') await this.connectSafely();
      return this.line;
    });
  }

  pause(): Promise<Line> {
    return this.serial.run(async () => {
      assertCommandAllowed(this.line, 'pause');
      await this.patch({ runState: 'paused', pauseReason: 'manual' });
      this.deps.log({ level: 'info', message: 'Linha pausada manualmente' });
      return this.line;
    });
  }

  resume(): Promise<Line> {
    return this.serial.run(async () => {
      assertCommandAllowed(this.line, 'resume');
      const afterScheduled = this.line.pauseReason === 'scheduled';
      if (afterScheduled) {
        // CONTINUAR após pausa programada: o contador individual recomeça.
        await this.deps.repo.resetScheduledPauseCount(this.line.id);
        this.line = { ...this.line, scheduledPauseCount: 0 };
      }
      await this.patch({ runState: 'active', pauseReason: null, scheduledPausePending: false });
      this.deps.log({
        level: 'info',
        message: afterScheduled ? 'Linha continuou após a pausa programada (contador zerado)' : 'Linha retomada',
      });
      if (this.line.connectionStatus !== 'connected' && !this.isReconnecting()) {
        this.resetAutoReconnect();
        await this.connectSafely();
      }
      return this.line;
    });
  }

  disconnect(): Promise<Line> {
    return this.serial.run(async () => {
      assertCommandAllowed(this.line, 'disconnect');
      this.resetAutoReconnect();
      await this.providerDisconnectQuietly();
      this.qrCode = null;
      await this.patch({
        runState: 'stopped',
        pauseReason: null,
        scheduledPausePending: false,
        connectionStatus: 'disconnected',
        operationalStatus: 'idle',
        connectedAt: null,
        lastError: null,
      });
      this.deps.log({ level: 'info', message: 'Linha desconectada manualmente' });
      return this.line;
    });
  }

  /**
   * PAUSA PROGRAMADA: pausa ESTA linha ao atingir o limite e aguarda decisão.
   * Não afeta nenhuma outra linha. Ignorada se a linha já não estiver ativa.
   */
  pauseScheduled(limit: number): Promise<boolean> {
    return this.serial.run(async () => {
      if (this.line.runState !== 'active') return false;
      await this.patch({ runState: 'paused', pauseReason: 'scheduled', scheduledPausePending: true });
      this.deps.log({
        level: 'warn',
        message: `Pausa programada: ${this.line.label} atingiu o limite de ${limit} mensagens`,
        data: { limit, count: this.line.scheduledPauseCount },
      });
      return true;
    });
  }

  /** MANTER PAUSADA: registra a decisão; a linha continua pausada. */
  keepPaused(): Promise<Line> {
    return this.serial.run(async () => {
      if (this.line.runState !== 'paused' || this.line.pauseReason !== 'scheduled') {
        throw invalidState(`"${this.line.label}" não está aguardando decisão da pausa programada`);
      }
      await this.patch({ scheduledPausePending: false });
      this.deps.log({ level: 'info', message: 'Decisão da pausa programada: manter pausada' });
      return this.line;
    });
  }

  /** Refaz a conexão mantendo a intenção atual (parada/ativa/pausada) da linha. */
  reconnect(): Promise<Line> {
    return this.serial.run(async () => {
      assertCommandAllowed(this.line, 'reconnect');
      this.resetAutoReconnect();
      this.deps.log({ level: 'info', message: 'Reconectando linha' });
      await this.reconnectNow();
      return this.line;
    });
  }

  /**
   * Envia uma mensagem por ESTA linha. Nunca lança exceção: qualquer falha
   * vira um SendResult com ok=false.
   */
  async send(request: SendTextRequest): Promise<SendResult> {
    if (!this.isAvailable()) {
      return { ok: false, error: `Linha "${this.line.label}" indisponível para envio`, retryable: true };
    }
    await this.patch({ operationalStatus: 'sending' });
    try {
      return await this.deps.provider.sendText(request);
    } catch (error) {
      const message = errorMessage(error);
      this.deps.log({ level: 'error', message: `Exceção no envio: ${message}` });
      return { ok: false, error: message, retryable: true };
    } finally {
      if (this.line.operationalStatus === 'sending') await this.patch({ operationalStatus: 'idle' });
    }
  }

  /** Atualiza rótulo/configurações (dados cadastrais, não o estado de conexão). */
  update(changes: Partial<Pick<Line, 'label' | 'settings' | 'providerConfig' | 'position'>>): Promise<Line> {
    return this.serial.run(async () => {
      await this.patch(changes);
      return this.line;
    });
  }

  /** Recarrega do banco os contadores e a última atividade gravados pelo histórico. */
  async refreshCounters(): Promise<void> {
    const tracking = await this.deps.repo.readTracking(this.line.id);
    if (!tracking) return;
    this.line = { ...this.line, ...tracking };
    this.deps.onChange(this.line);
  }

  /** Após reinício do app: a sessão do provedor não existe mais em memória. */
  async restoreAfterRestart(): Promise<void> {
    await this.patch({ connectionStatus: 'disconnected', operationalStatus: 'idle', connectedAt: null });
    if (this.line.runState !== 'stopped') {
      await this.serial.run(() => this.reconnectNow());
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearReconnectTimer();
    this.unsubscribe();
    try {
      await this.deps.provider.dispose();
    } catch (error) {
      console.error(`[line ${this.line.id}] erro ao liberar provedor`, error);
      this.deps.log({ level: 'warn', message: `Erro ao liberar o provedor da linha: ${errorMessage(error)}` });
    }
  }

  // ---------------------------------------------------------------- internos

  private async reconnectNow(): Promise<void> {
    this.reconnecting = true;
    this.deps.onChange(this.line);
    try {
      await this.providerDisconnectQuietly();
      if (this.line.operationalStatus === 'error') await this.patch({ operationalStatus: 'idle' });
      await this.connectSafely();
    } finally {
      this.reconnecting = false;
      this.deps.onChange(this.line);
    }
  }

  private async providerDisconnectQuietly(): Promise<void> {
    this.suppressAutoReconnect = true;
    try {
      await this.deps.provider.disconnect();
    } catch (error) {
      this.deps.log({ level: 'warn', message: `Erro ao encerrar conexão anterior: ${errorMessage(error)}` });
    } finally {
      this.suppressAutoReconnect = false;
    }
  }

  private async connectSafely(): Promise<void> {
    try {
      await this.deps.provider.connect();
    } catch (error) {
      await this.applyConnectionUpdate({ status: 'error', error: errorMessage(error) });
    }
  }

  private async applyConnectionUpdate(update: ConnectionUpdate): Promise<void> {
    if (this.disposed) return;
    // Capturado já: a desconexão manual termina antes deste handler assíncrono.
    const expectedDrop = this.suppressAutoReconnect;
    const changes: Partial<Line> = { connectionStatus: update.status };
    if (update.accountId !== undefined) changes.accountId = update.accountId;
    if (update.displayName !== undefined) changes.displayName = update.displayName;
    this.qrCode = update.status === 'qr_required' ? (update.qrCode ?? null) : null;

    switch (update.status) {
      case 'connected':
        changes.connectedAt = nowIso();
        changes.lastError = null;
        break;
      case 'disconnected':
        changes.connectedAt = null;
        break;
      case 'error':
        changes.connectedAt = null;
        changes.lastError = update.error ?? 'Erro de conexão';
        break;
    }

    try {
      await this.patch(changes);
    } catch (error) {
      console.error(`[line ${this.line.id}] falha ao persistir estado`, error);
      this.deps.log({ level: 'error', message: `Falha ao gravar o estado da linha: ${errorMessage(error)}` });
      return;
    }

    if (update.status === 'connected') {
      this.reconnectAttempt = 0;
      this.deps.log({ level: 'info', message: 'Linha conectada' });
    }
    if (update.status === 'error') this.deps.log({ level: 'error', message: `Erro de conexão: ${changes.lastError}` });

    const dropped = update.status === 'error' || update.status === 'disconnected';
    if (dropped && !expectedDrop && this.line.runState !== 'stopped') this.scheduleAutoReconnect();
  }

  /** Agenda a próxima tentativa de reconexão desta linha (backoff progressivo). */
  private scheduleAutoReconnect(): void {
    if (this.reconnectTimer || this.disposed) return;
    const delay = this.deps.reconnectDelaysMs[this.reconnectAttempt];
    if (delay === undefined) {
      if (this.deps.reconnectDelaysMs.length > 0) {
        this.deps.log({ level: 'error', message: 'Reconexão automática esgotada: reconecte manualmente' });
      }
      return;
    }
    this.reconnectAttempt++;
    this.nextReconnectAt = new Date(Date.now() + delay).toISOString();
    this.deps.log({
      level: 'warn',
      message: `Queda detectada: tentativa ${this.reconnectAttempt}/${this.deps.reconnectDelaysMs.length} em ${Math.round(delay / 1000)}s`,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextReconnectAt = null;
      void this.serial.run(async () => {
        if (this.disposed || this.line.runState === 'stopped' || this.line.connectionStatus === 'connected') return;
        await this.reconnectNow();
      });
    }, delay);
    this.reconnectTimer.unref?.();
    this.deps.onChange(this.line);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.nextReconnectAt = null;
  }

  /** Ação manual do usuário: cancela a agenda automática e zera as tentativas. */
  private resetAutoReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
  }

  private async patch(changes: Partial<Line>): Promise<void> {
    // Estado em memória atualizado de forma síncrona: eventos concorrentes do
    // provedor sempre partem do estado mais recente.
    const next: Line = { ...this.line, ...changes, updatedAt: nowIso() };
    this.line = next;
    await this.deps.repo.save(next);
    this.deps.onChange(next);
  }
}
