/**
 * Normaliza telefone para somente dígitos com DDI.
 * Números nacionais (10 ou 11 dígitos, ex.: DDD + número) recebem o DDI padrão.
 */
export function normalizePhone(raw: string, defaultCountryCode: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `${defaultCountryCode}${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

/**
 * Chave única da pessoa para celulares do Brasil: o WhatsApp muitas vezes
 * identifica a conversa SEM o nono dígito (55 + DDD + 8 dígitos começando com
 * 6 a 9), enquanto o cadastro costuma ter 13 dígitos. Os dois formatos são a
 * mesma pessoa; a chave canônica é sempre a de 13 dígitos. Fixos e outros
 * países não mudam.
 */
export function canonicalPersonPhone(phone: string): string {
  return /^55[1-9]{2}[6-9]\d{7}$/.test(phone) ? `${phone.slice(0, 4)}9${phone.slice(4)}` : phone;
}

/** Formatos possíveis do mesmo celular (com e sem o nono dígito), para localizar registros antigos. */
export function personPhoneVariants(phone: string): string[] {
  const canonical = canonicalPersonPhone(phone);
  const variants = new Set([phone, canonical]);
  if (/^55[1-9]{2}9[6-9]\d{7}$/.test(canonical)) variants.add(canonical.slice(0, 4) + canonical.slice(5));
  return [...variants];
}
