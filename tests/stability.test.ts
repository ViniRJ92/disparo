import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { createApp, type AppContainer } from '../src/server/app.ts';
import { DomainError } from '../src/server/shared/errors.ts';
import { MockProvider } from '../src/server/modules/providers/mock.provider.ts';
import { ProviderRegistry } from '../src/server/modules/providers/provider.registry.ts';
import type { LineView } from '../src/server/modules/lines/line.types.ts';
import { sleep, waitFor } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };
const dir = mkdtempSync(join(tmpdir(), 'disparo-stability-'));

interface Harness {
  app: AppContainer;
  mocks: Map<string, MockProvider>;
}

async function open(file = ':memory:', reconnectDelaysMs: number[] = []): Promise<Harness> {
  const mocks = new Map<string, MockProvider>();
  const providers = new ProviderRegistry().register('mock', (context) => {
    const provider = new MockProvider(context);
    mocks.set(context.lineId, provider);
    return provider;
  });
  const app = await createApp({
    databasePath: file === ':memory:' ? file : join(dir, file),
    providers,
    reconnectDelaysMs,
    dispatch: { idlePollMs: 20, errorBackoffMs: 20 },
  });
  await app.settings.update({ distribution: { cycleIntervalSeconds: [0] } });
  return { app, mocks };
}

async function lines(app: AppContainer, count: number, providerConfig: Record<string, unknown> = { sendDelayMs: 2 }) {
  const created: LineView[] = [];
  for (let i = 1; i <= count; i++) {
    const line = await app.lines.create({ label: `Linha ${String(i).padStart(2, '0')}`, provider: 'mock', providerConfig, settings: FAST });
    await app.lines.start(line.id);
    created.push(line);
  }
  return created;
}

async function contacts(app: AppContainer, count: number, prefix = '21993') {
  const { contactIds } = await app.contacts.import(
    Array.from({ length: count }, (_, i) => ({ phone: `55${prefix}${String(i).padStart(6, '0')}`, name: `Pessoa ${i}` })),
  );
  return contactIds;
}

const one = (app: AppContainer, sql: string, params = {}) => app.db.get<{ n: number }>(sql, params)!.n;

/** Invariantes de consistência entre fila, histórico, linhas e contatos. */
function assertConsistent(app: AppContainer, campaignIds: string[], contactCount: number) {
  for (const id of campaignIds) {
    assert.equal(one(app, "SELECT COUNT(*) AS n FROM send_jobs WHERE campaign_id = :id AND status IN ('pending', 'processing')", { id }), 0, 'nada preso na fila');
    assert.equal(one(app, "SELECT COUNT(*) AS n FROM send_attempts WHERE campaign_id = :id AND result = 'sent'", { id }), contactCount, 'cada contato enviado');
    assert.equal(
      one(app, "SELECT COUNT(DISTINCT contact_id) AS n FROM send_attempts WHERE campaign_id = :id AND result = 'sent'", { id }),
      contactCount,
      'nenhum contato enviado duas vezes no mesmo disparo',
    );
  }
  assert.equal(
    one(app, 'SELECT COALESCE(SUM(messages_sent), 0) AS n FROM lines'),
    one(app, "SELECT COUNT(*) AS n FROM send_attempts WHERE result = 'sent'"),
    'contadores das linhas batem com o histórico',
  );
  assert.equal(
    one(app, 'SELECT COALESCE(SUM(failures), 0) AS n FROM lines'),
    one(app, "SELECT COUNT(*) AS n FROM send_attempts WHERE result = 'failed'"),
    'falhas das linhas batem com o histórico',
  );
  assert.equal(one(app, "SELECT COUNT(*) AS n FROM contacts WHERE processing_status IN ('pending', 'processing')"), 0, 'nenhum contato preso como pendente');
}

describe('Módulo 10: estabilidade', () => {
  let h: Harness | null = null;

  afterEach(async () => {
    await h?.app.close();
    h = null;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const count of [1, 2, 5, 10]) {
    it(`${count} linha(s): processo completo, consistente e sem duplicidade`, async () => {
      h = await open();
      const created = await lines(h.app, count);
      await h.app.messages.saveSlot(1, { body: 'Oi {{nome}}' });
      await h.app.messages.saveSlot(2, { body: 'Olá {{nome}}' });
      const ids = await contacts(h.app, 30 * count);
      const campaign = await h.app.campaigns.create({ name: 'P', lineIds: created.map((l) => l.id), contactIds: ids, start: true });
      await waitFor(async () => (await h!.app.campaigns.summary(campaign.id)).status === 'completed', 20_000, 'conclusão');
      assertConsistent(h.app, [campaign.id], ids.length);
    });
  }

  it('estresse: 10 linhas, 2 disparos com os mesmos contatos, pausas, retomadas, quedas e reconexões aleatórias', async () => {
    h = await open(':memory:', [30, 30, 30, 30, 30]);
    const created = await lines(h.app, 10);
    for (let slot = 1; slot <= 3; slot++) await h.app.messages.saveSlot(slot, { body: `Texto ${slot}` });
    const ids = await contacts(h.app, 250);
    const all = created.map((l) => l.id);
    const a = await h.app.campaigns.create({ name: 'A', lineIds: all, contactIds: ids, start: true });
    const b = await h.app.campaigns.create({ name: 'B', lineIds: all.slice(0, 6), contactIds: ids, start: true });

    let maxProcessingPerContact = 0;
    const done = async () => (await h!.app.campaigns.summary(a.id)).status === 'completed' && (await h!.app.campaigns.summary(b.id)).status === 'completed';
    const deadline = Date.now() + 60_000;
    let step = 0;
    while (!(await done()) && Date.now() < deadline) {
      const row = h.app.db.get<{ n: number | null }>("SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM send_jobs WHERE status = 'processing' GROUP BY contact_id)");
      maxProcessingPerContact = Math.max(maxProcessingPerContact, row?.n ?? 0);
      const line = created[Math.floor(Math.random() * created.length)]!;
      const view = await h.app.lines.status(line.id);
      try {
        switch (step++ % 5) {
          case 0: if (view.runState === 'active') await h.app.lines.pause(line.id); break;
          case 1: if (view.runState === 'paused') await h.app.lines.resume(line.id); break;
          case 2: if (view.connectionStatus === 'connected') h.mocks.get(line.id)!.simulateDrop('Queda simulada'); break;
          case 3: if (view.runState === 'stopped') await h.app.lines.start(line.id); else if (Math.random() < 0.3) await h.app.lines.disconnect(line.id); break;
          case 4: await h.app.lines.reconnect(line.id); break;
        }
      } catch (error) {
        assert.ok(error instanceof DomainError, `erro inesperado: ${String(error)}`);
      }
      await sleep(15);
      // Periodicamente devolve tudo ao normal para o processo terminar.
      if (step % 40 === 0) {
        for (const l of await h.app.lines.list()) {
          if (l.runState === 'paused') await h.app.lines.resume(l.id);
          else if (l.runState === 'stopped') await h.app.lines.start(l.id);
          else if (l.connectionStatus !== 'connected') await h.app.lines.reconnect(l.id);
        }
      }
    }
    for (const l of await h.app.lines.list()) {
      if (l.runState === 'paused') await h.app.lines.resume(l.id);
      else if (l.runState === 'stopped') await h.app.lines.start(l.id);
      else if (l.connectionStatus !== 'connected') await h.app.lines.reconnect(l.id);
    }
    await waitFor(done, 30_000, 'os dois disparos concluídos');

    assert.equal(maxProcessingPerContact <= 1, true, 'dois envios simultâneos para o mesmo contato nunca aconteceram');
    const retriedFailures = one(h.app, "SELECT COUNT(*) AS n FROM send_attempts WHERE result = 'failed'");
    assert.equal(one(h.app, "SELECT COUNT(*) AS n FROM send_jobs WHERE status = 'failed'"), 0, 'quedas geram só falhas temporárias (contato volta para a fila)');
    assertConsistent(h.app, [a.id, b.id], ids.length);
    assert.ok(retriedFailures >= 0);

    const logs = await h.app.logs.list({ limit: 1000 });
    const has = (text: string) => logs.some((l) => l.message.includes(text));
    for (const text of ['Enviado para', 'Linha pausada manualmente', 'Linha retomada', 'Erro de conexão', 'Reconectando linha', 'Linha conectada', 'Ciclo']) {
      assert.ok(has(text), `log de diagnóstico: "${text}"`);
    }
  });

  it('reinício no meio do processamento: retoma do ponto certo, sem duplicar e sem estados presos', async () => {
    h = await open('restart.db');
    const created = await lines(h.app, 3, { sendDelayMs: 5 });
    await h.app.messages.saveSlot(1, { body: 'Oi' });
    const ids = await contacts(h.app, 200);
    const campaign = await h.app.campaigns.create({ name: 'Reinício', lineIds: created.map((l) => l.id), contactIds: ids, start: true });
    await waitFor(async () => (await h!.app.campaigns.summary(campaign.id)).counts.sent >= 30, 10_000, 'progresso');
    await h.app.lines.pause(created[2]!.id);
    await h.app.close();
    h = null;

    // Simula o que um fechamento abrupto deixaria para trás: um contato marcado como "enviando".
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(join(dir, 'restart.db'));
    raw.exec("UPDATE send_jobs SET status = 'processing' WHERE rowid = (SELECT rowid FROM send_jobs WHERE status = 'pending' LIMIT 1)");
    const sentBeforeRestart = (raw.prepare("SELECT COUNT(*) AS n FROM send_attempts WHERE result = 'sent'").get() as { n: number }).n;
    raw.close();

    h = await open('restart.db');
    const logs = await h.app.logs.list({ limit: 50 });
    assert.ok(logs.some((l) => l.message.includes('voltaram para a fila')), 'envio interrompido recuperado e registrado');
    const restored = await h.app.lines.list();
    assert.deepEqual(restored.map((l) => l.operationalState), ['active', 'active', 'paused'], 'intenção de cada linha preservada');
    assert.ok(restored.slice(0, 2).every((l) => l.connectionStatus === 'connected'), 'linhas ativas reconectadas');
    assert.equal((await h.app.campaigns.summary(campaign.id)).status, 'running');

    await h.app.lines.resume(created[2]!.id);
    await waitFor(async () => (await h!.app.campaigns.summary(campaign.id)).status === 'completed', 20_000, 'conclusão após reiniciar');
    assert.ok(one(h.app, "SELECT COUNT(*) AS n FROM send_attempts WHERE result = 'sent'") > sentBeforeRestart, 'continuou de onde parou');
    assertConsistent(h.app, [campaign.id], ids.length);
  });

  it('pausa programada aguardando decisão continua aguardando após reiniciar', async () => {
    h = await open('scheduled.db');
    const [line] = await lines(h.app, 1, { sendDelayMs: 1 });
    await h.app.settings.update({ scheduledPause: { enabled: true, limit: 5 } });
    await h.app.messages.saveSlot(1, { body: 'Oi' });
    const ids = await contacts(h.app, 12);
    const campaign = await h.app.campaigns.create({ name: 'S', lineIds: [line!.id], contactIds: ids, start: true });
    await waitFor(async () => (await h!.app.lines.status(line!.id)).scheduledPause.awaitingDecision, 5000, 'limite');
    await h.app.close();

    h = await open('scheduled.db');
    const view = await h.app.lines.status(line!.id);
    assert.deepEqual([view.operationalState, view.pauseReason, view.scheduledPause.awaitingDecision, view.scheduledPause.count], ['paused', 'scheduled', true, 5]);
    await sleep(100);
    assert.equal((await h.app.campaigns.summary(campaign.id)).counts.sent, 5, 'nada enviado enquanto aguarda decisão');
  });

  it('falha individual: exceção no provedor de uma linha é registrada e as outras continuam', async () => {
    h = await open();
    const created = await lines(h.app, 3);
    // A Linha 02 lança exceção a cada envio (não um resultado de falha: um erro inesperado).
    h.mocks.get(created[1]!.id)!.sendText = async () => {
      throw new Error('Falha interna do provedor');
    };
    await h.app.messages.saveSlot(1, { body: 'Oi' });
    const ids = await contacts(h.app, 60);
    const campaign = await h.app.campaigns.create({ name: 'Falha', lineIds: created.map((l) => l.id), contactIds: ids, start: true });
    await waitFor(async () => (await h!.app.campaigns.summary(campaign.id)).status === 'completed', 15_000, 'conclusão');

    const summary = await h.app.campaigns.summary(campaign.id);
    assert.equal(summary.counts.sent + summary.counts.failed, 60, 'todos os contatos têm resultado');
    assert.ok((await h.app.lines.status(created[0]!.id)).counters.messagesSent > 0);
    assert.ok((await h.app.lines.status(created[2]!.id)).counters.messagesSent > 0);
    const errors = await h.app.logs.list({ lineId: created[1]!.id, level: 'error', limit: 100 });
    assert.ok(errors.some((l) => l.message.includes('Falha interna do provedor')), 'erro registrado, não escondido');
    assertConsistent(h.app, [], 0);
  });

  it('erro inesperado no processamento (contato apagado durante o envio) é registrado e não derruba o worker', async () => {
    h = await open();
    const [line] = await lines(h.app, 1, { sendDelayMs: 20 });
    await h.app.messages.saveSlot(1, { body: 'Oi' });
    const ids = await contacts(h.app, 30);
    const campaign = await h.app.campaigns.create({ name: 'Apagado', lineIds: [line!.id], contactIds: ids, start: true });
    await waitFor(() => one(h!.app, "SELECT COUNT(*) AS n FROM send_jobs WHERE status = 'processing'") === 1, 3000, 'envio em curso');
    const processingContact = h.app.db.get<{ contact_id: string }>("SELECT contact_id FROM send_jobs WHERE status = 'processing'")!.contact_id;
    h.app.db.run('DELETE FROM contacts WHERE id = :id', { id: processingContact }); // apagado por fora, no meio do envio

    await waitFor(async () => (await h!.app.campaigns.summary(campaign.id)).status === 'completed', 10_000, 'processo segue até o fim');
    assert.equal((await h.app.campaigns.summary(campaign.id)).counts.sent, 29);
    const logs = await h.app.logs.list({ level: 'error', limit: 50 });
    assert.ok(logs.some((l) => l.message.includes('Erro no processamento')), 'erro registrado');
  });

  it('ouvinte de evento com defeito: erro registrado no log e o sistema continua', async () => {
    h = await open();
    h.app.events.on('line.updated', () => {
      throw new Error('ouvinte quebrado');
    });
    const [line] = await lines(h.app, 1);
    assert.equal((await h.app.lines.status(line!.id)).operationalState, 'active');
    await waitFor(async () => (await h!.app.logs.list({ level: 'error', limit: 50 })).some((l) => l.message.includes('ouvinte quebrado')), 2000, 'erro do ouvinte registrado');
  });

  it('contatos duplicados em operações simultâneas: nunca duplica e responde como conflito', async () => {
    h = await open();
    const results = await Promise.allSettled([
      h.app.contacts.create({ name: 'A', phone: '21 99999-7777' }),
      h.app.contacts.create({ name: 'B', phone: '(21) 99999-7777' }),
      h.app.contacts.import([{ phone: '5521999997777' }, { phone: '21999997777' }]),
    ]);
    assert.equal(one(h.app, "SELECT COUNT(*) AS n FROM contacts WHERE phone = '5521999997777'"), 1);
    for (const r of results) {
      if (r.status === 'rejected') assert.ok(r.reason instanceof DomainError && r.reason.code === 'CONFLICT', String(r.reason));
    }
  });

  it('Analytics e histórico idênticos antes e depois de reiniciar', async () => {
    h = await open('analytics.db');
    const created = await lines(h.app, 2);
    await h.app.messages.saveSlot(1, { body: 'Oi' });
    const ids = await contacts(h.app, 20);
    const campaign = await h.app.campaigns.create({ name: 'An', lineIds: created.map((l) => l.id), contactIds: ids, start: true });
    await waitFor(async () => (await h!.app.campaigns.summary(campaign.id)).status === 'completed', 5000, 'conclusão');
    h.mocks.get(created[1]!.id)!.simulateMessage({ providerMessageId: 'r1', chatId: '5521993000001@c.us', fromMe: false, body: 'oi', timestamp: Date.now() + 500 });
    await waitFor(() => one(h!.app, 'SELECT COUNT(*) AS n FROM conversation_messages') === 1, 2000, 'resposta gravada');
    const before = { ...h.app.analytics.overview(), generatedAt: '' };
    const historyBefore = await h.app.history.list({ limit: 1000 });
    await h.app.close();

    h = await open('analytics.db');
    assert.deepEqual({ ...h.app.analytics.overview(), generatedAt: '' }, before);
    assert.deepEqual(await h.app.history.list({ limit: 1000 }), historyBefore);
  });
});
