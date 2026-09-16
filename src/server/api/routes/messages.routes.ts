import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContainer } from '../../app.ts';
import { MAX_MESSAGE_SLOTS } from '../../modules/messages/message.types.ts';
import { idParams, parse } from '../http.ts';

const saveBody = z.object({
  body: z.string().min(1).max(4096),
  name: z.string().max(80).optional(),
  active: z.boolean().optional(),
});

const slotParams = z.object({ slot: z.coerce.number().int().min(1).max(MAX_MESSAGE_SLOTS) });

export function messagesRoutes(app: FastifyInstance, { messages }: AppContainer): void {
  /** As 5 posições (ocupadas ou livres) e as mensagens ativas. */
  app.get('/api/messages', async () => ({
    slots: await messages.slots(),
    activeCount: (await messages.listActive()).length,
  }));

  /** Cria na primeira posição livre. */
  app.post('/api/messages', async (request, reply) => reply.status(201).send(await messages.create(parse(saveBody, request.body))));

  /** Salvar/editar a mensagem de uma posição (Mensagem 01..05). */
  app.put('/api/messages/slots/:slot', async (request) =>
    messages.saveSlot(parse(slotParams, request.params).slot, parse(saveBody, request.body)),
  );

  app.patch('/api/messages/:id', async (request) =>
    messages.update(parse(idParams, request.params).id, parse(saveBody.partial(), request.body ?? {})),
  );

  app.post('/api/messages/:id/activate', async (request) => messages.setActive(parse(idParams, request.params).id, true));
  app.post('/api/messages/:id/deactivate', async (request) => messages.setActive(parse(idParams, request.params).id, false));

  app.delete('/api/messages/:id', async (request, reply) => {
    await messages.remove(parse(idParams, request.params).id);
    return reply.status(204).send();
  });
}
