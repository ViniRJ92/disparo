import { resolve } from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  /** Caminho do arquivo SQLite, ou ':memory:' (testes). */
  databasePath: string;
  /** Pasta do painel web já compilado (npm run build:web). */
  webDistPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.DISPARO_PORT ?? 3333),
    host: env.DISPARO_HOST ?? '127.0.0.1',
    databasePath: env.DISPARO_DB_PATH ?? resolve('data', 'disparo.db'),
    webDistPath: resolve('dist', 'web'),
  };
}
