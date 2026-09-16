import { z } from 'zod';
import { MAX_LINES_HARD_CAP, MIN_LINES } from '../../config/limits.ts';

/**
 * Configurações próprias de cada linha. O intervalo entre envios NÃO vem daqui:
 * ele pertence ao ciclo (distribution.cycleIntervalSeconds). min/maxIntervalSeconds
 * são mantidos apenas por compatibilidade com dados já gravados.
 */
export const lineSettingsBaseSchema = z.object({
  /** Máximo de mensagens por dia nesta linha. */
  dailyLimit: z.number().int().min(1).max(100_000),
  /** Intervalo mínimo/máximo entre envios desta linha (segundos). */
  minIntervalSeconds: z.number().int().min(0).max(86_400),
  maxIntervalSeconds: z.number().int().min(0).max(86_400),
});

export const lineSettingsSchema = lineSettingsBaseSchema.refine((s) => s.maxIntervalSeconds >= s.minIntervalSeconds, {
    message: 'maxIntervalSeconds deve ser >= minIntervalSeconds',
    path: ['maxIntervalSeconds'],
  });

export type LineSettings = z.infer<typeof lineSettingsSchema>;

/**
 * Motor de distribuição por CICLOS. Em cada ciclo:
 *  - cada linha recebe uma quantidade sorteada entre minBatch e maxBatch;
 *  - o ciclo inteiro usa UM intervalo sorteado entre cycleIntervalSeconds.
 */
export const distributionSettingsSchema = z
  .object({
    minBatch: z.number().int().min(1).max(1000),
    maxBatch: z.number().int().min(1).max(1000),
    /** Opções de intervalo (segundos) entre envios, sorteadas uma vez por ciclo. */
    cycleIntervalSeconds: z.array(z.number().min(0).max(3600)).min(1).max(20),
    /** Sem nenhuma reserva por este tempo, linhas que já esgotaram a cota abrem novo ciclo. */
    roundStallSeconds: z.number().int().min(1).max(86_400),
  })
  .refine((s) => s.maxBatch >= s.minBatch, { message: 'maxBatch deve ser >= minBatch', path: ['maxBatch'] })
  .refine((s) => new Set(s.cycleIntervalSeconds).size === s.cycleIntervalSeconds.length, {
    message: 'cycleIntervalSeconds não pode ter valores repetidos',
    path: ['cycleIntervalSeconds'],
  });

export type DistributionSettings = z.infer<typeof distributionSettingsSchema>;

/**
 * PAUSA PROGRAMADA (opcional): cada linha pausa sozinha ao enviar `limit`
 * mensagens desde a última vez que continuou. limit = null → sem limite.
 */
export const scheduledPauseSchema = z.object({
  enabled: z.boolean(),
  limit: z.number().int().min(1).max(100_000).nullable(),
});

export type ScheduledPauseSettings = z.infer<typeof scheduledPauseSchema>;

/** Opções prontas oferecidas na interface (além de Personalizado e Sem limite). */
export const SCHEDULED_PAUSE_PRESETS = [10, 15, 30, 50] as const;

export const appSettingsSchema = z.object({
  /** Quantidade máxima de linhas cadastradas (1..10). */
  maxLines: z.number().int().min(MIN_LINES).max(MAX_LINES_HARD_CAP),
  /** DDI aplicado a números sem código do país. */
  defaultCountryCode: z.string().regex(/^\d{1,3}$/),
  /** Configuração inicial de cada nova linha. */
  defaultLineSettings: lineSettingsSchema,
  distribution: distributionSettingsSchema,
  scheduledPause: scheduledPauseSchema,
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  maxLines: MAX_LINES_HARD_CAP,
  defaultCountryCode: '55',
  defaultLineSettings: {
    dailyLimit: 200,
    minIntervalSeconds: 20,
    maxIntervalSeconds: 60,
  },
  distribution: {
    minBatch: 2,
    maxBatch: 5,
    cycleIntervalSeconds: [2, 3, 4, 5],
    roundStallSeconds: 180,
  },
  scheduledPause: {
    enabled: false,
    limit: 50,
  },
};
