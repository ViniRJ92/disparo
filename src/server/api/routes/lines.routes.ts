import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../app.ts';
import type { BulkLineCommand, LineCommand } from '../../modules/lines/line.types.ts';
import { lineSettingsBaseSchema } from '../../modules/settings/settings.schema.ts';
import { idParams, parse } from '../http.ts';

const createBody = z.object({
  label: z.string().min(1).max(60),
  provider: z.string().min(1).default('mock'),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  settings: lineSettingsBaseSchema.partial().optional(),
});

const updateBody = z.object({
  label: z.string().min(1).max(60).optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  settings: lineSettingsBaseSchema.partial().optional(),
  position: z.number().int().min(0).optional(),
});

const COMMANDS: readonly LineCommand[] = ['connect', 'start', 'pause', 'resume', 'disconnect', 'reconnect'];
const BULK_COMMANDS: readonly BulkLineCommand[] = ['start', 'pause', 'resume'];

const bulkBody = z.object({ lineIds: z.array(z.string().min(1)).min(1).max(50) });

export function linesRoutes(app: FastifyInstance, { lines, providers, dispatch }: AppContainer): void {
  app.get('/api/lines', async () => ({ lines: await lines.list(), summary: await lines.summary() }));

  app.get('/api/providers', async () => ({ providers: providers.kinds() }));

  /** Situação operacional do worker de cada linha. */
  app.get('/api/lines/workers', async () => ({ workers: dispatch.snapshots() }));

  /** Pausar/retomar TODAS as linhas cadastradas (independente de disparo). */
  app.post('/api/lines/all/pause', async () => ({ results: await lines.executeMany((await lines.list()).map((l) => l.id), 'pause') }));
  app.post('/api/lines/all/resume', async () => ({ results: await lines.executeMany((await lines.list()).map((l) => l.id), 'resume') }));

  // Controle global das selecionadas: POST /api/lines/bulk/start | pause | resume  { lineIds }
  for (const command of BULK_COMMANDS) {
    app.post(`/api/lines/bulk/${command}`, async (request) => ({
      results: await lines.executeMany(parse(bulkBody, request.body).lineIds, command),
    }));
  }

  app.post('/api/lines', async (request, reply) => {
    const line = await lines.create(parse(createBody, request.body));
    return reply.status(201).send(line);
  });

  app.get('/api/lines/:id', async (request) => lines.status(parse(idParams, request.params).id));

  app.patch('/api/lines/:id', async (request) =>
    lines.update(parse(idParams, request.params).id, parse(updateBody, request.body ?? {})),
  );

  app.delete('/api/lines/:id', async (request, reply) => {
    await lines.remove(parse(idParams, request.params).id);
    return reply.status(204).send();
  });

  // Pausa programada: decisão individual da linha que atingiu o limite.
  app.post('/api/lines/:id/scheduled-pause/continue', async (request) =>
    lines.continueAfterScheduledPause(parse(idParams, request.params).id),
  );
  app.post('/api/lines/:id/scheduled-pause/keep-paused', async (request) => lines.keepPaused(parse(idParams, request.params).id));

  // Comandos individuais: POST /api/lines/:id/connect | start | pause | resume | disconnect | reconnect
  for (const command of COMMANDS) {
    app.post(`/api/lines/:id/${command}`, async (request) => lines.execute(parse(idParams, request.params).id, command));
  }
}
