import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../app.ts';
import { idParams, parse } from '../http.ts';

const status = z.enum(['active', 'blocked']);
const processingStatus = z.enum(['idle', 'pending', 'waiting', 'processing', 'sent', 'failed']);
const variables = z.record(z.string(), z.string());

const listQuery = z.object({
  search: z.string().optional(),
  status: status.optional(),
  processingStatus: processingStatus.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createBody = z.object({
  phone: z.string().min(1),
  name: z.string().max(120).nullish(),
  variables: variables.optional(),
  status: status.optional(),
});

const updateBody = z.object({
  phone: z.string().min(1).optional(),
  name: z.string().max(120).nullish(),
  variables: variables.optional(),
  status: status.optional(),
});

const importBody = z.object({
  contacts: z
    .array(z.object({ phone: z.string().min(1), name: z.string().nullish(), variables: variables.optional() }))
    .min(1)
    .max(50_000),
});

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const csvMapping = z.object({
  phoneColumn: z.number().int().min(0),
  nameColumn: z.number().int().min(0).nullable(),
  hasHeader: z.boolean(),
});
const CSV_BODY_LIMIT = 15 * 1024 * 1024;

export function contactsRoutes(app: FastifyInstance, { contacts, contactCsv }: AppContainer): void {
  /** Importação por CSV, etapa 1: pré-visualização (nada é gravado). */
  app.post('/api/contacts/csv/preview', { bodyLimit: CSV_BODY_LIMIT }, async (request) => {
    const body = parse(z.object({ csv: z.string().min(1), mapping: csvMapping.optional() }), request.body);
    return contactCsv.preview(body.csv, body.mapping);
  });

  /** Importação por CSV, etapa 2: confirmação. Retorna também inválidos e duplicados. */
  app.post('/api/contacts/csv/import', { bodyLimit: CSV_BODY_LIMIT }, async (request) => {
    const body = parse(z.object({ csv: z.string().min(1), mapping: csvMapping }), request.body);
    return contactCsv.import(body.csv, body.mapping);
  });

  /** Lista filtrável: quem recebeu (sent), quem está pendente, quem teve erro (failed)... */
  app.get('/api/contacts', async (request) => {
    const { limit, offset, ...filters } = parse(listQuery, request.query);
    return {
      contacts: await contacts.list({ ...filters, limit, offset }),
      total: await contacts.count(filters),
      summary: await contacts.summary(),
    };
  });

  /** Tamanho de um público antes de criar o disparo. */
  app.get('/api/contacts/audience', async (request) => {
    const { audience } = parse(z.object({ audience: z.enum(['all_active', 'never_received']) }), request.query);
    return { audience, count: (await contacts.idsForAudience(audience)).length };
  });

  app.post('/api/contacts', async (request, reply) => reply.status(201).send(await contacts.create(parse(createBody, request.body))));

  app.post('/api/contacts/import', async (request) => contacts.import(parse(importBody, request.body).contacts));

  app.get('/api/contacts/:id', async (request) => contacts.get(parse(idParams, request.params).id));

  app.patch('/api/contacts/:id', async (request) =>
    contacts.update(parse(idParams, request.params).id, parse(updateBody, request.body ?? {})),
  );

  app.delete('/api/contacts/:id', async (request, reply) => {
    await contacts.remove(parse(idParams, request.params).id);
    return reply.status(204).send();
  });

  /** Histórico individual do contato (mensagem, linha, processo, horário e resultado). */
  app.get('/api/contacts/:id/history', async (request) => {
    const { id } = parse(idParams, request.params);
    await contacts.get(id);
    return { history: await contacts.history(id, parse(pageQuery, request.query)) };
  });
}
