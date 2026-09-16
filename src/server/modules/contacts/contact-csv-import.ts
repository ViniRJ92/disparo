import { DomainError } from '../../shared/errors.ts';
import { parseCsv } from '../exports/csv.ts';
import type { ContactRepository } from './contact.repository.ts';
import type { ContactService } from './contact.service.ts';
import type { ImportContactsResult } from './contact.types.ts';
import { normalizePhone } from './phone.ts';

export const CSV_IMPORT_MAX_ROWS = 50_000;

export interface CsvMapping {
  /** Índice (0-based) da coluna de telefone. */
  phoneColumn: number;
  /** Índice da coluna de nome (null = sem nome). */
  nameColumn: number | null;
  /** A primeira linha contém os nomes das colunas. */
  hasHeader: boolean;
}

export type CsvRowStatus =
  /** Válido e ainda não cadastrado: será criado. */
  | 'new'
  /** Válido e já cadastrado: não duplica; o nome é atualizado se vier preenchido. */
  | 'existing'
  /** Mesmo telefone já apareceu antes neste arquivo: ignorado (a primeira ocorrência vale). */
  | 'duplicate'
  /** Telefone vazio ou inválido: não importado. */
  | 'invalid';

export interface CsvPreviewRow {
  /** Número da linha no arquivo (1 = primeira linha). */
  line: number;
  name: string | null;
  rawPhone: string;
  phone: string | null;
  status: CsvRowStatus;
  /** Motivo (inválidos/duplicados) ou observação (ex.: contato bloqueado). */
  note: string | null;
  existingContactId: string | null;
}

export interface CsvPreview {
  delimiter: string;
  headers: string[];
  /** Maior quantidade de colunas encontrada no arquivo (permite mapear qualquer coluna, mesmo sem cabeçalho). */
  columnCount: number;
  mapping: CsvMapping;
  totalRows: number;
  summary: Record<CsvRowStatus, number>;
  rows: CsvPreviewRow[];
}

export interface CsvImportReport extends ImportContactsResult {
  duplicates: CsvPreviewRow[];
  invalidRows: CsvPreviewRow[];
}

const PHONE_HEADER = /telefone|celular|whats|fone|phone|n[uú]mero|contato|tel\b/i;
const NAME_HEADER = /nome|name|cliente/i;

/** Sugere o mapeamento pelas colunas do cabeçalho ou pelo conteúdo das primeiras linhas. */
export function suggestMapping(table: string[][]): CsvMapping {
  const first = table[0] ?? [];
  const looksLikePhone = (value: string | undefined) => (value ?? '').replace(/\D/g, '').length >= 8;
  const hasHeader = first.length > 0 && !first.some(looksLikePhone);
  let phoneColumn = hasHeader ? first.findIndex((h) => PHONE_HEADER.test(h)) : -1;
  if (phoneColumn < 0) {
    const sample = table.slice(hasHeader ? 1 : 0, 20);
    const width = Math.max(0, ...table.slice(0, 20).map((r) => r.length));
    let best = 0;
    for (let col = 0; col < width; col++) {
      const hits = sample.filter((r) => looksLikePhone(r[col])).length;
      if (hits > best) {
        best = hits;
        phoneColumn = col;
      }
    }
  }
  phoneColumn = Math.max(0, phoneColumn);
  let nameColumn: number | null = hasHeader ? first.findIndex((h, i) => i !== phoneColumn && NAME_HEADER.test(h)) : -1;
  if (nameColumn < 0) nameColumn = (first.length > 1 ? (phoneColumn === 0 ? 1 : 0) : null) as number | null;
  return { phoneColumn, nameColumn, hasHeader };
}

/**
 * Importação de contatos por CSV em duas etapas: PRÉ-VISUALIZAÇÃO (nada é
 * gravado) e CONFIRMAÇÃO. Inválidos e duplicados nunca são descartados em
 * silêncio: aparecem na prévia e no relatório final, com a linha do arquivo.
 */
export class ContactCsvImporter {
  private readonly repo: ContactRepository;
  private readonly contacts: ContactService;
  private readonly defaultCountryCode: () => Promise<string>;

  constructor(repo: ContactRepository, contacts: ContactService, defaultCountryCode: () => Promise<string>) {
    this.repo = repo;
    this.contacts = contacts;
    this.defaultCountryCode = defaultCountryCode;
  }

  async preview(csv: string, mapping?: CsvMapping): Promise<CsvPreview> {
    const table = parseCsv(csv);
    if (table.length === 0) throw new DomainError('VALIDATION', 'Arquivo CSV vazio');
    const used = mapping ?? suggestMapping(table);
    const width = Math.max(...table.map((r) => r.length));
    if (used.phoneColumn >= width || (used.nameColumn !== null && used.nameColumn >= width)) {
      throw new DomainError('VALIDATION', 'Coluna mapeada não existe no arquivo');
    }
    const body = used.hasHeader ? table.slice(1) : table;
    if (body.length > CSV_IMPORT_MAX_ROWS) {
      throw new DomainError('VALIDATION', `Arquivo com ${body.length} registros; o máximo por importação é ${CSV_IMPORT_MAX_ROWS}`);
    }

    const country = await this.defaultCountryCode();
    const headerOffset = used.hasHeader ? 2 : 1;
    const firstLineByPhone = new Map<string, number>();
    const rows: CsvPreviewRow[] = body.map((cells, index) => {
      const line = index + headerOffset;
      const rawPhone = (cells[used.phoneColumn] ?? '').trim();
      const name = used.nameColumn === null ? null : (cells[used.nameColumn] ?? '').trim() || null;
      if (!rawPhone) return { line, name, rawPhone, phone: null, status: 'invalid', note: 'Telefone vazio', existingContactId: null };
      const phone = normalizePhone(rawPhone, country);
      if (!phone) return { line, name, rawPhone, phone: null, status: 'invalid', note: 'Telefone inválido', existingContactId: null };
      const firstLine = firstLineByPhone.get(phone);
      if (firstLine !== undefined) {
        return { line, name, rawPhone, phone, status: 'duplicate', note: `Mesmo telefone da linha ${firstLine} do arquivo`, existingContactId: null };
      }
      firstLineByPhone.set(phone, line);
      return { line, name, rawPhone, phone, status: 'new', note: null, existingContactId: null };
    });

    // Já cadastrados (consulta em lotes).
    const phones = [...firstLineByPhone.keys()];
    const existing = new Map<string, { id: string; status: string }>();
    for (let i = 0; i < phones.length; i += 500) {
      for (const contact of await this.repo.findByPhones(phones.slice(i, i + 500))) existing.set(contact.phone, contact);
    }
    for (const row of rows) {
      const found = row.status === 'new' && row.phone ? existing.get(row.phone) : undefined;
      if (!found) continue;
      row.status = 'existing';
      row.existingContactId = found.id;
      row.note = found.status === 'blocked' ? 'Já cadastrado e BLOQUEADO (continua bloqueado)' : 'Já cadastrado: não será duplicado';
    }

    const summary: Record<CsvRowStatus, number> = { new: 0, existing: 0, duplicate: 0, invalid: 0 };
    for (const row of rows) summary[row.status]++;
    const columnCount = table.reduce((max, cells) => Math.max(max, cells.length), 0);
    return { delimiter: '', headers: used.hasHeader ? table[0]! : [], columnCount, mapping: used, totalRows: rows.length, summary, rows };
  }

  async import(csv: string, mapping: CsvMapping): Promise<CsvImportReport> {
    const preview = await this.preview(csv, mapping);
    const accepted = preview.rows.filter((r) => r.status === 'new' || r.status === 'existing');
    const result = await this.contacts.import(accepted.map((r) => ({ phone: r.phone!, name: r.name })));
    return {
      ...result,
      duplicates: preview.rows.filter((r) => r.status === 'duplicate'),
      invalidRows: preview.rows.filter((r) => r.status === 'invalid'),
    };
  }
}
