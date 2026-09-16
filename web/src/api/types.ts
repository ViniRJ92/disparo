/**
 * Tipos compartilhados com o servidor (import apenas de tipos: nada do código
 * do servidor entra no bundle do painel). Uma única fonte de verdade.
 */
export type {
  BulkCommandResult,
  BulkLineCommand,
  LineCommand,
  LineSettings,
  LineStatus,
  LinesSummary,
  LineView,
} from '../../../src/server/modules/lines/line.types.ts';
export type { CampaignAction, CampaignDetail, CampaignSummary } from '../../../src/server/modules/campaigns/campaign.types.ts';
export type { GlobalOverview } from '../../../src/server/modules/stats/stats.service.ts';
export type { Dashboard, DashboardLineRow, LineDetail } from '../../../src/server/modules/stats/dashboard.service.ts';
export type { JobCounts } from '../../../src/server/modules/queue/queue.types.ts';
export type { WorkerSnapshot, WorkerState } from '../../../src/server/modules/dispatch/dispatch.types.ts';
export type { MessageSlot, MessageTemplate } from '../../../src/server/modules/messages/message.types.ts';
export type {
  ContactAudience,
  ContactProcessingStatus,
  ContactQuery,
  ContactsSummary,
  ContactStatus,
  ContactView,
  ImportContactsResult,
} from '../../../src/server/modules/contacts/contact.types.ts';
export type { SendAttemptView } from '../../../src/server/modules/history/history.types.ts';
export type { RoundSnapshot } from '../../../src/server/modules/distribution/distribution.types.ts';
export type { OperationalState, PauseReason } from '../../../src/server/modules/lines/line.types.ts';
export type { AppSettings, ScheduledPauseSettings } from '../../../src/server/modules/settings/settings.schema.ts';
export type { CsvImportReport, CsvMapping, CsvPreview, CsvRowStatus } from '../../../src/server/modules/contacts/contact-csv-import.ts';
export type { ExportFilters, ExportKind } from '../../../src/server/modules/exports/export.service.ts';
export type {
  AnalyticsFilters,
  AnalyticsOverview,
  AnalyticsPerson,
  InteractionCategory,
  PersonTimelineEntry,
} from '../../../src/server/modules/analytics/analytics.service.ts';
