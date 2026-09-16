import type {
  BulkCommandResult,
  BulkLineCommand,
  CampaignAction,
  CampaignDetail,
  CampaignSummary,
  Dashboard,
  GlobalOverview,
  LineDetail,
  LineCommand,
  LineSettings,
  LineView,
  MessageSlot,
  MessageTemplate,
  AnalyticsFilters,
  AnalyticsOverview,
  AnalyticsPerson,
  AppSettings,
  PersonTimelineEntry,
  ContactAudience,
  ContactQuery,
  CsvImportReport,
  CsvMapping,
  CsvPreview,
  ExportFilters,
  ExportKind,
  SendAttemptView as HistoryEntry,
  ContactsSummary,
  ContactStatus,
  ContactView,
  ImportContactsResult,
  SendAttemptView,
} from './types.ts';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.message ?? `Erro ${response.status}`);
  return data as T;
}

export const api = {
  overview: () => request<GlobalOverview>('GET', '/api/overview'),
  settings: () => request<AppSettings>('GET', '/api/settings'),
  updateSettings: (patch: {
    maxLines?: number;
    defaultCountryCode?: string;
    defaultLineSettings?: Partial<AppSettings['defaultLineSettings']>;
    distribution?: Partial<AppSettings['distribution']>;
    scheduledPause?: Partial<AppSettings['scheduledPause']>;
  }) => request<AppSettings>('PATCH', '/api/settings', patch),

  pauseAllLinesGlobal: () => request<{ results: BulkCommandResult[] }>('POST', '/api/lines/all/pause'),
  resumeAllLinesGlobal: () => request<{ results: BulkCommandResult[] }>('POST', '/api/lines/all/resume'),
  continueAfterScheduledPause: (id: string) => request<LineView>('POST', `/api/lines/${id}/scheduled-pause/continue`),
  keepPaused: (id: string) => request<LineView>('POST', `/api/lines/${id}/scheduled-pause/keep-paused`),

  csvPreview: (csv: string, mapping?: CsvMapping) => request<CsvPreview>('POST', '/api/contacts/csv/preview', { csv, mapping }),
  csvImport: (csv: string, mapping: CsvMapping) => request<CsvImportReport>('POST', '/api/contacts/csv/import', { csv, mapping }),
  exportCount: (kind: ExportKind, filters: ExportFilters) => request<{ kind: ExportKind; rows: number }>('GET', `/api/exports/${kind}/count?${toQuery(filters)}`),
  analyticsOverview: (filters: AnalyticsFilters) => request<AnalyticsOverview>('GET', `/api/analytics/overview?${toQuery(filters)}`),
  analyticsPeople: (filters: AnalyticsFilters, page: { limit: number; offset: number }) =>
    request<{ total: number; people: AnalyticsPerson[] }>('GET', `/api/analytics/people?${toQuery({ ...filters, ...page })}`),
  personTimeline: (personKey: string) =>
    request<{ timeline: PersonTimelineEntry[] }>('GET', `/api/analytics/people/${encodeURIComponent(personKey)}/timeline`),
  history: (filters: {
    lineId?: string;
    contactId?: string;
    campaignId?: string;
    result?: 'sent' | 'failed';
    from?: string;
    to?: string;
    contact?: string;
    message?: string;
    limit?: number;
    offset?: number;
  }) =>
    request<{ attempts: HistoryEntry[] }>('GET', `/api/history?${toQuery(filters)}`),
  dashboard: (campaignId?: string) =>
    request<Dashboard>('GET', `/api/dashboard${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ''}`),
  lineDetail: (lineId: string, campaignId?: string) =>
    request<LineDetail>('GET', `/api/dashboard/lines/${lineId}${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ''}`),

  createLine: (label: string) => request<LineView>('POST', '/api/lines', { label, provider: 'mock' }),
  updateLine: (id: string, changes: { label?: string; settings?: Partial<LineSettings> }) =>
    request<LineView>('PATCH', `/api/lines/${id}`, changes),
  removeLine: (id: string) => request<void>('DELETE', `/api/lines/${id}`),
  lineCommand: (id: string, command: LineCommand) => request<LineView>('POST', `/api/lines/${id}/${command}`),
  bulkLineCommand: (lineIds: string[], command: BulkLineCommand) =>
    request<{ results: BulkCommandResult[] }>('POST', `/api/lines/bulk/${command}`, { lineIds }),

  messages: () => request<{ slots: MessageSlot[]; activeCount: number }>('GET', '/api/messages'),
  saveMessageSlot: (slot: number, body: string) => request<MessageTemplate>('PUT', `/api/messages/slots/${slot}`, { body }),
  setMessageActive: (id: string, active: boolean) =>
    request<MessageTemplate>('POST', `/api/messages/${id}/${active ? 'activate' : 'deactivate'}`),
  removeMessage: (id: string) => request<void>('DELETE', `/api/messages/${id}`),

  contacts: (query: ContactQuery) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    return request<{ contacts: ContactView[]; total: number; summary: ContactsSummary }>('GET', `/api/contacts?${params}`);
  },
  createContact: (input: { name?: string; phone: string }) => request<ContactView>('POST', '/api/contacts', input),
  updateContact: (id: string, input: { name?: string | null; phone?: string; status?: ContactStatus }) =>
    request<ContactView>('PATCH', `/api/contacts/${id}`, input),
  removeContact: (id: string) => request<void>('DELETE', `/api/contacts/${id}`),
  importContacts: (contacts: { name?: string; phone: string }[]) =>
    request<ImportContactsResult>('POST', '/api/contacts/import', { contacts }),
  contactHistory: (id: string) => request<{ history: SendAttemptView[] }>('GET', `/api/contacts/${id}/history?limit=200`),

  campaigns: () => request<{ campaigns: CampaignSummary[] }>('GET', '/api/campaigns'),
  setCampaignLines: (id: string, lineIds: string[]) => request<unknown>('PUT', `/api/campaigns/${id}/lines`, { lineIds }),
  createCampaign: (input: { name: string; lineIds: string[]; audience: ContactAudience; start: boolean }) =>
    request<CampaignDetail>('POST', '/api/campaigns', input),
  audienceSize: (audience: ContactAudience) =>
    request<{ audience: ContactAudience; count: number }>('GET', `/api/contacts/audience?audience=${audience}`),
  campaignDetail: (id: string) => request<CampaignDetail>('GET', `/api/campaigns/${id}`),
  pauseAllLines: (id: string) => request<{ results: BulkCommandResult[] }>('POST', `/api/campaigns/${id}/lines/pause-all`),
  resumeAllLines: (id: string) => request<{ results: BulkCommandResult[] }>('POST', `/api/campaigns/${id}/lines/resume-all`),
  finishCampaign: (id: string) => request<CampaignDetail>('POST', `/api/campaigns/${id}/finish`),
  campaignAction: (id: string, action: CampaignAction) => request<unknown>('POST', `/api/campaigns/${id}/${action}`),
};

function toQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  return search.toString();
}

/** URL de download do CSV (o navegador baixa o arquivo gerado pelo servidor). */
export const exportUrl = (kind: ExportKind, filters: ExportFilters) => `/api/exports/${kind}.csv?${toQuery(filters)}`;

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
