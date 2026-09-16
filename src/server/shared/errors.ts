/**
 * Erros de domínio. A camada HTTP traduz cada código para um status HTTP;
 * os módulos nunca conhecem HTTP.
 */
export type DomainErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'LIMIT_EXCEEDED' | 'INVALID_STATE';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: unknown;

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const notFound = (entity: string, id: string) =>
  new DomainError('NOT_FOUND', `${entity} não encontrado(a): ${id}`);

export const invalidState = (message: string) => new DomainError('INVALID_STATE', message);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
