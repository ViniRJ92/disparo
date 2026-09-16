import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SqlParams = Record<string, SQLInputValue>;
export type Row = Record<string, unknown>;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Wrapper fino sobre o SQLite nativo do Node (node:sqlite, sem dependências).
 * Os repositórios expõem métodos assíncronos: trocar este banco por Postgres
 * (ex.: Supabase) no futuro não muda os serviços.
 */
export class Database {
  private readonly db: DatabaseSync;
  /** Consultas preparadas reaproveitadas (o SQL é sempre o mesmo texto; só os parâmetros mudam). */
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      // WAL + NORMAL: banco sempre íntegro se o app fechar ou travar (as transações continuam atômicas);
      // só uma queda de energia do sistema operacional pode perder as últimas confirmações.
      this.db.exec('PRAGMA synchronous = NORMAL;');
      // Espera em vez de falhar se outra conexão estiver gravando no mesmo instante.
      this.db.exec('PRAGMA busy_timeout = 5000;');
    }
  }

  all<T = Row>(sql: string, params: SqlParams = {}): T[] {
    return this.prepare(sql).all(params) as T[];
  }

  get<T = Row>(sql: string, params: SqlParams = {}): T | undefined {
    return this.prepare(sql).get(params) as T | undefined;
  }

  run(sql: string, params: SqlParams = {}): { changes: number } {
    const result = this.prepare(sql).run(params);
    return { changes: Number(result.changes) };
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      // Limite de segurança para SQL montado dinamicamente (filtros, listas IN).
      if (this.statements.size >= 500) this.statements.clear();
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Transação síncrona: ou tudo é gravado, ou nada. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Aplica, em ordem, as migrações .sql ainda não aplicadas. */
  migrate(): string[] {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(this.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
    const pending = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql') && !applied.has(file))
      .sort();

    for (const file of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      this.transaction(() => {
        this.db.exec(sql);
        this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (:name, :at)', {
          name: file,
          at: new Date().toISOString(),
        });
      });
    }
    return pending;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}

/** Monta "IN (:p0, :p1, ...)" com parâmetros nomeados. Lista vazia => nunca casa. */
export function inClause(values: readonly string[], prefix = 'p'): { sql: string; params: SqlParams } {
  if (values.length === 0) return { sql: 'IN (NULL)', params: {} };
  const params: SqlParams = {};
  const names = values.map((value, i) => {
    params[`${prefix}${i}`] = value;
    return `:${prefix}${i}`;
  });
  return { sql: `IN (${names.join(', ')})`, params };
}

export const toJson =(value: unknown): string => JSON.stringify(value ?? {});

export function fromJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
