import type { Contact } from '../contacts/contact.types.ts';

/**
 * Substitui {{variavel}} pelos dados do contato. Variáveis sem valor viram texto vazio.
 * Disponíveis: {{nome}}, {{telefone}} e qualquer chave de contact.variables.
 */
export function renderMessage(body: string, contact: Pick<Contact, 'name' | 'phone' | 'variables'>): string {
  const values: Record<string, string> = {
    ...contact.variables,
    nome: contact.name ?? '',
    telefone: contact.phone,
  };
  return body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}
