import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContainer } from '../app.ts';
import { registerErrorHandler } from './http.ts';
import { campaignsRoutes } from './routes/campaigns.routes.ts';
import { contactsRoutes } from './routes/contacts.routes.ts';
import { exportsRoutes } from './routes/exports.routes.ts';
import { analyticsRoutes } from './routes/analytics.routes.ts';
import { linesRoutes } from './routes/lines.routes.ts';
import { messagesRoutes } from './routes/messages.routes.ts';
import { monitoringRoutes } from './routes/monitoring.routes.ts';

export interface ServerOptions {
  logger?: boolean;
  /** Pasta do painel compilado; servida em "/" quando existir. */
  webDistPath?: string;
}

export async function buildServer(container: AppContainer, options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  registerErrorHandler(app);

  linesRoutes(app, container);
  contactsRoutes(app, container);
  messagesRoutes(app, container);
  campaignsRoutes(app, container);
  monitoringRoutes(app, container);
  exportsRoutes(app, container);
  analyticsRoutes(app, container);

  if (options.webDistPath && existsSync(options.webDistPath)) {
    await app.register(fastifyStatic, { root: options.webDistPath });
  }
  return app;
}
