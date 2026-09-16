import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../app.ts';
import { MAX_LINES_HARD_CAP, MIN_LINES } from '../../config/limits.ts';
import { lineSettingsBaseSchema } from '../../modules/settings/settings.schema.ts';
import { DomainError } from '../../shared/errors.ts';
import { parse } from '../http.ts';

const historyQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  contact: z.string().optional(),
  message: z.string().min(1).optional(),
  campaignId: z.string().optional(),
  lineId: z.string().optional(),
  contactId: z.string().optional(),
  result: z.enum(['sent', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Atualização parcial (inclusive dentro de defaultLineSettings e distribution); a validação completa fica no serviço. */
const settingsPatch = z.object({
  maxLines: z.number().int().min(MIN_LINES).max(MAX_LINES_HARD_CAP).optional(),
  defaultCountryCode: z.string().regex(/^\d{1,3}$/).optional(),
  defaultLineSettings: lineSettingsBaseSchema.partial().optional(),
  distribution: z
    .object({
      minBatch: z.number().int(),
      maxBatch: z.number().int(),
      cycleIntervalSeconds: z.array(z.number()),
      roundStallSeconds: z.number().int(),
    })
    .partial()
    .optional(),
  scheduledPause: z.object({ enabled: z.boolean(), limit: z.number().int().nullable() }).partial().optional(),
});

const logsQuery = z.object({
  lineId: z.string().optional(),
  campaignId: z.string().optional(),
  level: z.enum(['info', 'warn', 'error']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Visão global, histórico, logs, configurações e eventos em tempo real. */
export function monitoringRoutes(app: FastifyInstance, container: AppContainer): void {
  const { stats, dashboard, history, logs, settings, events, lines } = container;

  app.get('/api/overview', async () => stats.overview());

  /** Dashboard: indicadores reais de linhas e processamento (todos os disparos ou um). */
  app.get('/api/dashboard', async (request) =>
    dashboard.dashboard(parse(z.object({ campaignId: z.string().min(1).optional() }), request.query).campaignId),
  );

  /** Detalhes de uma linha no Dashboard. */
  app.get('/api/dashboard/lines/:id', async (request) => {
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const { campaignId } = parse(z.object({ campaignId: z.string().min(1).optional() }), request.query);
    return dashboard.lineDetail(id, campaignId);
  });

  app.get('/api/history', async (request) => ({ attempts: await history.list(parse(historyQuery, request.query)) }));

  app.get('/api/logs', async (request) => ({ logs: await logs.list(parse(logsQuery, request.query)) }));

  app.get('/api/settings', async () => settings.get());

  app.patch('/api/settings', async (request) => {
    const patch = parse(settingsPatch, request.body ?? {});
    const registered = (await lines.list()).length;
    if (patch.maxLines !== undefined && patch.maxLines < registered) {
      throw new DomainError('CONFLICT', `Já existem ${registered} linhas cadastradas: remova linhas antes de reduzir o máximo para ${patch.maxLines}`);
    }
    return settings.update(patch);
  });

  // Server-Sent Events: a UI recebe mudanças de linhas/campanhas sem polling.
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': conectado\n\n');

    const off = events.onAny((name, payload) => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      off();
    });
  });
}
