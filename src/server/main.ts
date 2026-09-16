import { buildServer } from './api/server.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config/env.ts';

const config = loadConfig();
const container = await createApp({ databasePath: config.databasePath });
const server = await buildServer(container, { logger: true, webDistPath: config.webDistPath });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  server.log.info(`${signal} recebido, encerrando...`);
  await server.close();
  await container.close();
  process.exit(0);
}
// Um erro inesperado em uma parte (ex.: uma linha) não derruba o sistema: é registrado.
// O estado fica consistente porque toda gravação importante é feita em transação.
process.on('unhandledRejection', (reason) => {
  server.log.error({ reason }, 'Promessa rejeitada sem tratamento');
  container.logs.write({ level: 'error', scope: 'system', message: `Erro não tratado: ${reason instanceof Error ? reason.message : String(reason)}` });
});
process.on('uncaughtException', (error) => {
  server.log.error(error, 'Exceção não tratada');
  container.logs.write({ level: 'error', scope: 'system', message: `Exceção não tratada: ${error.message}`, data: { stack: error.stack ?? null } });
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await server.listen({ port: config.port, host: config.host });
