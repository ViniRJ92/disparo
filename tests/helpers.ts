import { createApp, type AppContainer, type AppOptions } from '../src/server/app.ts';
import { MockProvider } from '../src/server/modules/providers/mock.provider.ts';
import { ProviderRegistry } from '../src/server/modules/providers/provider.registry.ts';

export interface TestApp {
  app: AppContainer;
  /** Provedores simulados criados, por id da linha (para simular quedas). */
  mocks: Map<string, MockProvider>;
}

/** App completo com banco em memória, provedores simulados observáveis e tempos curtos. */
export async function createTestApp(
  overrides: Partial<Omit<AppOptions, 'databasePath' | 'providers'>> & { keepCycleIntervals?: boolean } = {},
): Promise<TestApp> {
  const mocks = new Map<string, MockProvider>();
  const providers = new ProviderRegistry().register('mock', (context) => {
    const provider = new MockProvider(context);
    mocks.set(context.lineId, provider);
    return provider;
  });
  const app = await createApp({
    databasePath: ':memory:',
    providers,
    reconnectDelaysMs: overrides.reconnectDelaysMs ?? [],
    dispatch: { idlePollMs: 20, errorBackoffMs: 20, ...overrides.dispatch },
  });
  // Intervalo de ciclo zerado para os testes gerais não esperarem segundos reais.
  if (!overrides.keepCycleIntervals) await app.settings.update({ distribution: { cycleIntervalSeconds: [0] } });
  return { app, mocks };
}

/** Aguarda a fila de microtasks/eventos assíncronos assentar. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera até a condição ser verdadeira (ou falha após o tempo limite). */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000, label = 'condição'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`Tempo esgotado aguardando: ${label}`);
}
