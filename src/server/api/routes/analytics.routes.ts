import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../app.ts';
import { parse } from '../http.ts';

const filtersQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  lineId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  contact: z.string().optional(),
  message: z.string().min(1).optional(),
});

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Analytics sobre registros reais (envios do disparo + conversas de todas as linhas). */
export function analyticsRoutes(app: FastifyInstance, { analytics }: AppContainer): void {
  app.get('/api/analytics/overview', async (request) => analytics.overview(parse(filtersQuery, request.query)));

  app.get('/api/analytics/people', async (request) => {
    const { limit, offset, ...filters } = parse(filtersQuery.merge(pageQuery), request.query);
    return analytics.people(filters, { limit, offset });
  });

  app.get('/api/analytics/people/:key/timeline', async (request) => {
    const { key } = parse(z.object({ key: z.string().min(1) }), request.params);
    return { timeline: analytics.personTimeline(key) };
  });
}
