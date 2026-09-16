export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  level: LogLevel;
  /** Origem do log, ex.: "line", "campaign", "provider". */
  scope: string;
  message: string;
  lineId: string | null;
  campaignId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface LogInput {
  level: LogLevel;
  scope: string;
  message: string;
  lineId?: string | null;
  campaignId?: string | null;
  data?: Record<string, unknown>;
}

export interface LogQuery {
  lineId?: string;
  campaignId?: string;
  level?: LogLevel;
  limit?: number;
}
