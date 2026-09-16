import { canonicalPersonPhone, normalizePhone } from '../contacts/phone.ts';

export type ChatType = 'individual' | 'group' | 'broadcast';

export interface ParsedChat {
  type: ChatType;
  /** Telefone normalizado, quando a identificação traz o número. */
  phone: string | null;
  /** Chave da pessoa (telefone ou identificação da conversa). null para grupos/transmissões. */
  personKey: string | null;
}

/**
 * Interpreta a identificação de conversa do WhatsApp:
 *   5521999990001@c.us / @s.whatsapp.net  → conversa individual com telefone
 *   123456789@lid                         → conversa individual sem telefone (id vinculado)
 *   120363...@g.us                        → grupo
 *   status@broadcast / ...@broadcast      → transmissão/status (não é conversa individual)
 *   ...@newsletter                        → canal (não é conversa individual)
 *   só dígitos                            → conversa individual com telefone
 */
export function parseChatId(chatId: string, defaultCountryCode: string, isGroupHint?: boolean): ParsedChat {
  const id = chatId.trim();
  const [user = '', server = ''] = id.includes('@') ? id.split('@') : [id, ''];
  if (isGroupHint || server === 'g.us') return { type: 'group', phone: null, personKey: null };
  // Transmissões, status e canais (newsletter) não são pessoas.
  if (server === 'broadcast' || server === 'newsletter') return { type: 'broadcast', phone: null, personKey: null };
  if (server === 'lid') return { type: 'individual', phone: null, personKey: `lid:${user}` };

  const normalized = normalizePhone(user.split(':')[0] ?? '', defaultCountryCode);
  const phone = normalized ? canonicalPersonPhone(normalized) : null;
  return { type: 'individual', phone, personKey: phone ?? `chat:${id}` };
}

/** Normaliza o telefone de quem escreveu (participante de grupo ou remetente). */
export function normalizeSender(raw: string | null | undefined, defaultCountryCode: string): string | null {
  if (!raw) return null;
  const user = raw.split('@')[0]?.split(':')[0] ?? '';
  const phone = normalizePhone(user, defaultCountryCode);
  return phone ? canonicalPersonPhone(phone) : null;
}
