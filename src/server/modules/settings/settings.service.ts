import type { Database } from '../../db/database.ts';
import type { LogService } from '../logs/log.service.ts';
import { fromJson, toJson } from '../../db/database.ts';
import { DomainError } from '../../shared/errors.ts';
import { nowIso } from '../../shared/ids.ts';
import { appSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from './settings.schema.ts';

const KEY = 'app';

/** Configurações globais, validadas e mescladas com os valores padrão. */
export class SettingsService {
  private readonly db: Database;
  private logs: LogService | null = null;
  private readonly listeners = new Set<(next: AppSettings, previous: AppSettings) => void>();

  constructor(db: Database) {
    this.db = db;
  }

  /** Avisa quem depende das configurações (ex.: pausa programada das linhas). */
  onChange(listener: (next: AppSettings, previous: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Liga o registro de alterações de configuração (o LogService depende das configurações). */
  attachLogs(logs: LogService): void {
    this.logs = logs;
  }

  async get(): Promise<AppSettings> {
    const row = this.db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = :key', { key: KEY });
    const stored = fromJson<Partial<AppSettings>>(row?.value, {});
    const merged = {
      ...DEFAULT_APP_SETTINGS,
      ...stored,
      defaultLineSettings: { ...DEFAULT_APP_SETTINGS.defaultLineSettings, ...stored.defaultLineSettings },
      distribution: { ...DEFAULT_APP_SETTINGS.distribution, ...stored.distribution },
      scheduledPause: { ...DEFAULT_APP_SETTINGS.scheduledPause, ...stored.scheduledPause },
    };
    const parsed = appSettingsSchema.safeParse(merged);
    return parsed.success ? parsed.data : DEFAULT_APP_SETTINGS;
  }

  async update(
    patch: Partial<Omit<AppSettings, 'defaultLineSettings' | 'distribution' | 'scheduledPause'>> & {
      defaultLineSettings?: Partial<AppSettings['defaultLineSettings']>;
      distribution?: Partial<AppSettings['distribution']>;
      scheduledPause?: Partial<AppSettings['scheduledPause']>;
    },
  ): Promise<AppSettings> {
    const current = await this.get();
    const next = {
      ...current,
      ...patch,
      defaultLineSettings: { ...current.defaultLineSettings, ...patch.defaultLineSettings },
      distribution: { ...current.distribution, ...patch.distribution },
      scheduledPause: { ...current.scheduledPause, ...patch.scheduledPause },
    };
    const parsed = appSettingsSchema.safeParse(next);
    if (!parsed.success) throw new DomainError('VALIDATION', 'Configurações inválidas', parsed.error.issues);

    this.db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (:key, :value, :at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key: KEY, value: toJson(parsed.data), at: nowIso() },
    );
    const changed = (Object.keys(parsed.data) as (keyof AppSettings)[]).filter(
      (key) => JSON.stringify(parsed.data[key]) !== JSON.stringify(current[key]),
    );
    if (changed.length > 0) {
      this.logs?.write({
        level: 'info',
        scope: 'settings',
        message: `Configuração alterada: ${changed.join(', ')}`,
        data: Object.fromEntries(changed.map((key) => [key, { antes: current[key], depois: parsed.data[key] }])),
      });
      for (const listener of this.listeners) listener(parsed.data, current);
    }
    return parsed.data;
  }
}
