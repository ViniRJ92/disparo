import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../app.ts';
import type { CampaignAction } from '../../modules/campaigns/campaign.types.ts';
import { idParams, parse } from '../http.ts';

const ids = z.array(z.string().min(1));

const createBody = z.object({
  name: z.string().min(1).max(120),
  lineIds: ids.default([]),
  contactIds: ids.optional(),
  audience: z.enum(['all_active', 'never_received']).optional(),
  start: z.boolean().optional(),
});

const ACTIONS: readonly CampaignAction[] = ['start', 'pause', 'resume', 'cancel', 'complete'];

export function campaignsRoutes(app: FastifyInstance, { campaigns, queue, distribution }: AppContainer): void {
  app.get('/api/campaigns', async () => ({ campaigns: await campaigns.list() }));

  app.post('/api/campaigns', async (request, reply) =>
    reply.status(201).send(await campaigns.create(parse(createBody, request.body))),
  );

  app.get('/api/campaigns/:id', async (request) => campaigns.detail(parse(idParams, request.params).id));

  /** Rodada atual da distribuição (cota e uso por linha) e rodadas anteriores. */
  app.get('/api/campaigns/:id/distribution', async (request) => {
    const { id } = parse(idParams, request.params);
    await campaigns.summary(id);
    return distribution.snapshot(id);
  });

  app.delete('/api/campaigns/:id', async (request, reply) => {
    await campaigns.remove(parse(idParams, request.params).id);
    return reply.status(204).send();
  });

  app.put('/api/campaigns/:id/lines', async (request) =>
    campaigns.setLines(parse(idParams, request.params).id, parse(z.object({ lineIds: ids }), request.body).lineIds),
  );

  app.post('/api/campaigns/:id/contacts', async (request) =>
    campaigns.addContacts(parse(idParams, request.params).id, parse(z.object({ contactIds: ids.min(1) }), request.body).contactIds),
  );

  app.get('/api/campaigns/:id/jobs', async (request) => {
    const { id } = parse(idParams, request.params);
    const query = parse(
      z.object({
        status: z.enum(['pending', 'processing', 'sent', 'failed', 'skipped']).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      request.query,
    );
    return { jobs: await queue.list({ campaignId: id, ...query }) };
  });

  // Controle global do disparo em execução (o controle individual das linhas continua valendo).
  app.post('/api/campaigns/:id/lines/pause-all', async (request) => ({
    results: await campaigns.pauseAllLines(parse(idParams, request.params).id),
  }));
  app.post('/api/campaigns/:id/lines/resume-all', async (request) => ({
    results: await campaigns.resumeAllLines(parse(idParams, request.params).id),
  }));
  app.post('/api/campaigns/:id/finish', async (request) => campaigns.finish(parse(idParams, request.params).id));

  // Controle global do processo: POST /api/campaigns/:id/start | pause | resume | cancel | complete
  for (const action of ACTIONS) {
    app.post(`/api/campaigns/:id/${action}`, async (request) => campaigns.execute(parse(idParams, request.params).id, action));
  }
}
