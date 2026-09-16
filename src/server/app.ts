import { Database } from './db/database.ts';
import { CampaignRepository } from './modules/campaigns/campaign.repository.ts';
import { CampaignService } from './modules/campaigns/campaign.service.ts';
import { ContactProcessingSync } from './modules/contacts/contact-processing.sync.ts';
import { ContactRepository } from './modules/contacts/contact.repository.ts';
import { ContactService } from './modules/contacts/contact.service.ts';
import { ContactCsvImporter } from './modules/contacts/contact-csv-import.ts';
import { ExportService } from './modules/exports/export.service.ts';
import { AnalyticsService } from './modules/analytics/analytics.service.ts';
import { ConversationService } from './modules/conversations/conversation.service.ts';
import { DispatchService } from './modules/dispatch/dispatch.service.ts';
import { DEFAULT_DISPATCH_OPTIONS, type DispatchOptions } from './modules/dispatch/dispatch.types.ts';
import { DistributionEngine } from './modules/distribution/distribution.engine.ts';
import { RandomMessageSelector } from './modules/distribution/random-message.selector.ts';
import { HistoryService } from './modules/history/history.service.ts';
import { LineManager } from './modules/lines/line.manager.ts';
import { LineRepository } from './modules/lines/line.repository.ts';
import { LogService } from './modules/logs/log.service.ts';
import { MessageRepository } from './modules/messages/message.repository.ts';
import { MessageService } from './modules/messages/message.service.ts';
import { createMockProvider } from './modules/providers/mock.provider.ts';
import { ProviderRegistry } from './modules/providers/provider.registry.ts';
import { SendQueue } from './modules/queue/send-queue.ts';
import { SettingsService } from './modules/settings/settings.service.ts';
import { DashboardService } from './modules/stats/dashboard.service.ts';
import { StatsService } from './modules/stats/stats.service.ts';
import { EventBus } from './shared/events.ts';

export interface AppOptions {
  databasePath: string;
  /** Permite substituir/adicionar provedores (ex.: testes). */
  providers?: ProviderRegistry;
  /** Backoff da reconexão automática por linha (ms). */
  reconnectDelaysMs?: readonly number[];
  /** Ajustes do processamento por linha (ex.: testes rápidos). */
  dispatch?: Partial<DispatchOptions>;
}

export type AppContainer = Awaited<ReturnType<typeof createApp>>;

/** Raiz de composição: único lugar que conhece todas as implementações concretas. */
export async function createApp(options: AppOptions) {
  const db = new Database(options.databasePath);
  const appliedMigrations = db.migrate();

  const events = new EventBus();
  const settings = new SettingsService(db);
  const logs = new LogService(db, events);
  settings.attachLogs(logs);
  events.setErrorReporter((name, error) =>
    logs.write({ level: 'error', scope: 'events', message: `Falha ao processar o evento "${name}": ${error instanceof Error ? error.message : String(error)}` }),
  );
  const providers = options.providers ?? new ProviderRegistry().register('mock', createMockProvider);

  const contactSync = new ContactProcessingSync(db);
  // Dados anteriores a uma migração: recalcula a situação de cada contato a partir da fila.
  if (appliedMigrations.length > 0) contactSync.all();
  const queue = new SendQueue(db, contactSync);
  const history = new HistoryService(db, events, contactSync);
  const lines = new LineManager({
    repo: new LineRepository(db),
    providers,
    settings,
    events,
    logs,
    pending: queue,
    reconnectDelaysMs: options.reconnectDelaysMs,
  });
  const contactRepository = new ContactRepository(db);
  const contacts = new ContactService(contactRepository, settings, history, queue);
  const contactCsv = new ContactCsvImporter(contactRepository, contacts, async () => (await settings.get()).defaultCountryCode);
  const exports = new ExportService(db);
  const conversations = new ConversationService(db, events, settings, logs);
  const analytics = new AnalyticsService(db);
  const messages = new MessageService(new MessageRepository(db), events);
  const campaigns = new CampaignService({
    repo: new CampaignRepository(db),
    queue,
    lines,
    contacts,
    contactSync,
    messages,
    events,
    logs,
  });
  const dispatchOptions = { ...DEFAULT_DISPATCH_OPTIONS, ...options.dispatch };
  const distribution = new DistributionEngine({
    lines,
    settings,
    logs,
    events,
    selectedLines: (campaignId) => campaigns.lineIds(campaignId),
    // Processo removido não existe mais: simplesmente não está em andamento.
    isRunning: async (campaignId) => (await campaigns.summary(campaignId).catch(() => null))?.status === 'running',
    capacity: async (lineId) => {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const sent = await history.countSentSince(lineId, midnight.toISOString());
      return Math.min(lines.readiness(lineId).settings.dailyLimit - sent, lines.scheduledPauseRemaining(lineId));
    },
    random: dispatchOptions.random,
  });
  const dispatch = new DispatchService({
    lines,
    queue,
    campaigns,
    contacts,
    history,
    selector: new RandomMessageSelector(messages, contacts, dispatchOptions.random),
    distribution,
    logs,
    events,
    options: dispatchOptions,
  });
  const dashboard = new DashboardService({ lines, campaigns, contacts, queue, history, logs, dispatch, distribution, messages, settings });
  const stats = new StatsService({ lines, campaigns, contacts, queue, dispatch, distribution });

  const released = await queue.releaseStuck();
  if (released > 0) logs.write({ level: 'warn', scope: 'queue', message: `${released} envio(s) interrompido(s) voltaram para a fila` });
  await lines.init();
  await dispatch.start();

  return {
    db,
    events,
    settings,
    logs,
    providers,
    queue,
    history,
    lines,
    contacts,
    messages,
    campaigns,
    distribution,
    dispatch,
    stats,
    dashboard,
    contactCsv,
    exports,
    conversations,
    analytics,
    async close() {
      await dispatch.stop();
      await lines.shutdown();
      db.close();
    },
  };
}
