/**
 * Gravação e leitura de CSV (sem dependências).
 *
 * Gravação no formato que o Excel em português abre direto: separador ";",
 * UTF-8 com BOM e quebra de linha CRLF. Valores que começam com = + - @ recebem
 * um apóstrofo para não serem interpretados como fórmula (injeção de CSV).
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(csvEscape).join(';'), ...rows.map((row) => row.map(csvEscape).join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Detecta o separador mais provável na primeira linha (; , ou tab). */
export function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [';', ',', '\t'].map((d) => ({ d, n: countOutsideQuotes(firstLine, d) }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 0 ? counts[0]!.d : ';';
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let n = 0;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === delimiter && !inQuotes) n++;
  }
  return n;
}

/** Lê CSV com aspas, aspas duplicadas e quebras de linha dentro de campos. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const input = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Linhas totalmente vazias não são registros.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}
