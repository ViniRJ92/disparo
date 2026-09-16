import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, type DomainErrorCode } from '../shared/errors.ts';

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  LIMIT_EXCEEDED: 422,
};

/** Valida a entrada da requisição; erros viram DomainError de validação. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new DomainError('VALIDATION', 'Dados inválidos', result.error.issues);
  return result.data;
}

export const idParams = z.object({ id: z.string().min(1) });

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(STATUS_BY_CODE[error.code]).send({ error: error.code, message: error.message, details: error.details });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) app.log.error(error);
    return reply.status(status).send({ error: 'INTERNAL', message: status >= 500 ? 'Erro interno' : error.message });
  });
}
