import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../app.ts';
import { parse } from '../http.ts';

const kindParams = z.object({ kind: z.enum(['sent', 'failed', 'pending', 'history']) });

const filtersQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  lineId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  contact: z.string().optional(),
  message: z.string().min(1).optional(),
});

/** Exportações CSV: enviados, falhas, pendentes e histórico, globais ou por linha, com filtros. */
export function exportsRoutes(app: FastifyInstance, { exports }: AppContainer): void {
  /** Quantidade de registros que o CSV terá com os filtros atuais. */
  app.get('/api/exports/:kind/count', async (request) => {
    const { kind } = parse(kindParams, request.params);
    return { kind, rows: exports.count(kind, parse(filtersQuery, request.query)) };
  });

  app.get('/api/exports/:kind.csv', async (request, reply) => {
    const { kind } = parse(kindParams, request.params);
    const result = exports.export(kind, parse(filtersQuery, request.query));
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .header('X-Export-Rows', String(result.rows))
      .send(result.csv);
  });
}
