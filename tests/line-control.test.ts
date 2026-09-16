import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AppOptions } from '../src/server/app.ts';
import { buildServer } from '../src/server/api/server.ts';
import type { LineView } from '../src/server/modules/lines/line.types.ts';
import { createTestApp, sleep, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Módulo 2: gerenciamento e controle individual das linhas', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  async function setup(
    lineCount: number,
    contactCount: number,
    options: { providerConfig?: Record<string, unknown>; app?: Partial<Omit<AppOptions, 'databasePath' | 'providers'>> } = {},
  ) {
    t = await createTestApp(options.app);
    const lines: LineView[] = [];
    for (let i = 1; i <= lineCount; i++) {
      lines.push(
        await t.app.lines.create({
          label: `Linha ${String(i).padStart(2, '0')}`,
          provider: 'mock',
          providerConfig: options.providerConfig,
          settings: FAST,
        }),
      );
    }
    const contacts = await t.app.contacts.import(
      Array.from({ length: contactCount }, (_, i) => ({ phone: `55219${String(i).padStart(8, '0')}`, name: `Contato ${i}` })),
    );
    const message = await t.app.messages.create({ name: 'Msg', body: 'Olá {{nome}}' });
    return { lines, contactIds: contacts.contactIds, message };
  }

  const sentBy = async (lineId: string) => (await t.app.lines.status(lineId)).counters.messagesSent;
  const campaignCounts = async (id: string) => (await t.app.campaigns.summary(id)).counts;

  // ------------------------------------------------------------------ conexão e estados

  it('conexão independente: conectar uma linha não conecta nem ativa as outras', async () => {
    const { lines } = await setup(3, 0, { providerConfig: { connectDelayMs: 40 } });
    const connecting = t.app.lines.connect(lines[0]!.id);
    await sleep(10);
    assert.equal((await t.app.lines.status(lines[0]!.id)).status, 'connecting');

    const connected = await connecting;
    assert.equal(connected.status, 'connected', 'conectada, porém parada');
    assert.equal(connected.available, false);
    assert.ok(connected.accountId);
    assert.ok(connected.connectedAt);
    assert.deepEqual(
      (await t.app.lines.list()).map((l) => l.status),
      ['connected', 'disconnected', 'disconnected'],
    );
    await assert.rejects(t.app.lines.connect(lines[0]!.id), /já está conectada/);
  });

  it('estados claros: desconectada, conectada, ativa, pausada, erro, reconectando', async () => {
    const { lines } = await setup(5, 0, { app: { reconnectDelaysMs: [60_000] } });
    const [a, b, c, d] = lines.map((l) => l.id);
    await t.app.lines.connect(a!);
    await t.app.lines.start(b!);
    await t.app.lines.start(c!);
    await t.app.lines.pause(c!);
    await t.app.lines.start(d!);
    t.mocks.get(d!)!.simulateDrop('Sessão caiu');
    await waitFor(async () => (await t.app.lines.status(d!)).status === 'reconnecting', 1000, 'reconectando');

    assert.deepEqual(
      (await t.app.lines.list()).map((l) => l.status),
      ['connected', 'active', 'paused', 'reconnecting', 'disconnected'],
    );
    const dropped = await t.app.lines.status(d!);
    assert.ok(dropped.nextReconnectAt, 'tentativa automática agendada');

    const failing = await t.app.lines.create({ label: 'Falha', provider: 'mock', providerConfig: { failConnect: true } });
    assert.equal((await t.app.lines.connect(failing.id)).status, 'error');
  });

  it('queda de uma linha: reconexão automática só dela, e o envio segue nas outras', async () => {
    const { lines, contactIds, message } = await setup(3, 150, {
      providerConfig: { sendDelayMs: 3 },
      app: { reconnectDelaysMs: [80] },
    });
    for (const line of lines) await t.app.lines.start(line.id);
    const campaign = await t.app.campaigns.create({ name: 'Queda', lineIds: lines.map((l) => l.id), contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');
    await waitFor(async () => (await campaignCounts(campaign.id)).sent >= 15, 5000, 'progresso inicial');

    const victim = lines[1]!.id;
    t.mocks.get(victim)!.simulateDrop('Conexão perdida');
    await waitFor(async () => (await t.app.lines.status(victim)).status === 'reconnecting', 1000, 'reconectando');

    const othersBefore = (await sentBy(lines[0]!.id)) + (await sentBy(lines[2]!.id));
    await sleep(40);
    const othersDuring = (await sentBy(lines[0]!.id)) + (await sentBy(lines[2]!.id));
    assert.ok(othersDuring > othersBefore, 'as outras linhas continuam enviando durante a queda');

    await waitFor(async () => (await t.app.lines.status(victim)).status === 'active', 2000, 'linha reconectada');
    const victimAfterReconnect = await sentBy(victim);
    await waitFor(async () => (await campaignCounts(campaign.id)).processed === 150, 10_000, 'processo concluído');
    assert.ok((await sentBy(victim)) >= victimAfterReconnect);

    const counts = await campaignCounts(campaign.id);
    assert.equal(counts.sent + counts.failed, 150, 'nenhum contato perdido na queda');
    assert.equal((await t.app.campaigns.summary(campaign.id)).status, 'completed');
  });

  // ------------------------------------------------------------------ envio com 1 e várias linhas

  it('funciona com apenas uma linha', async () => {
    const { lines, contactIds, message } = await setup(1, 20);
    await t.app.lines.start(lines[0]!.id);
    const campaign = await t.app.campaigns.create({ name: 'Uma', lineIds: [lines[0]!.id], contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');

    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 5000, 'conclusão');
    const line = await t.app.lines.status(lines[0]!.id);
    assert.deepEqual(line.counters, { contactsProcessed: 20, messagesSent: 20, failures: 0 });
    assert.equal(line.pending, 0);

    const history = await t.app.history.list({ campaignId: campaign.id, limit: 100 });
    assert.equal(history.length, 20);
    assert.equal(new Set(history.map((h) => h.contactId)).size, 20, 'cada contato recebeu uma única vez');
    assert.ok(history.every((h) => h.renderedBody?.startsWith('Olá Contato')));
  });

  it('funciona com várias linhas (10) dividindo a mesma fila sem duplicar contatos', async () => {
    const { lines, contactIds, message } = await setup(10, 200, { providerConfig: { sendDelayMs: 2 } });
    for (const line of lines) await t.app.lines.start(line.id);
    const campaign = await t.app.campaigns.create({ name: 'Dez', lineIds: lines.map((l) => l.id), contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');

    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 10_000, 'conclusão');
    const all = await t.app.lines.list();
    assert.equal(all.reduce((sum, l) => sum + l.counters.messagesSent, 0), 200);
    assert.ok(all.every((l) => l.counters.messagesSent > 0), 'todas as 10 linhas trabalharam');

    const history = await t.app.history.list({ campaignId: campaign.id, limit: 1000 });
    assert.equal(new Set(history.map((h) => h.contactId)).size, 200);
  });

  it('seleção parcial: só as linhas selecionadas participam do processo', async () => {
    const { lines, contactIds, message } = await setup(5, 60, { providerConfig: { sendDelayMs: 1 } });
    for (const line of lines) await t.app.lines.start(line.id); // todas ativas e conectadas
    const selected = [lines[0]!.id, lines[1]!.id, lines[3]!.id]; // 01, 02 e 04
    const campaign = await t.app.campaigns.create({ name: 'Parcial', lineIds: selected, contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');

    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 5000, 'conclusão');
    const sent = await Promise.all(lines.map((l) => sentBy(l.id)));
    assert.ok(sent[0]! > 0 && sent[1]! > 0 && sent[3]! > 0);
    assert.equal(sent[2], 0, 'Linha 03 não selecionada');
    assert.equal(sent[4], 0, 'Linha 05 não selecionada');
    assert.equal(sent.reduce((a, b) => a + b, 0), 60);

    const workers = t.app.dispatch.snapshots();
    assert.equal(workers.find((w) => w.lineId === lines[2]!.id)?.state, 'no_process');
  });

  // ------------------------------------------------------------------ pausa, retomada e desconexão

  it('pausar as linhas 02, 05 e 08 para somente elas; as outras 7 continuam', async () => {
    const { lines, contactIds, message } = await setup(10, 600, { providerConfig: { sendDelayMs: 3 } });
    for (const line of lines) await t.app.lines.start(line.id);
    const campaign = await t.app.campaigns.create({ name: 'Pausa', lineIds: lines.map((l) => l.id), contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');
    await waitFor(async () => (await campaignCounts(campaign.id)).sent >= 50, 5000, 'progresso inicial');

    const pausedIds = [lines[1]!.id, lines[4]!.id, lines[7]!.id];
    for (const id of pausedIds) await t.app.lines.pause(id);
    await sleep(20); // envio que já estava em curso termina
    const frozen = await Promise.all(pausedIds.map(sentBy));
    const runningIds = lines.map((l) => l.id).filter((id) => !pausedIds.includes(id));
    const runningBefore = await Promise.all(runningIds.map(sentBy));

    // Cada linha ativa avança (os ciclos podem fazê-la aguardar as outras por alguns instantes).
    await waitFor(
      async () => (await Promise.all(runningIds.map(sentBy))).every((n, i) => n > runningBefore[i]!),
      5000,
      'todas as linhas ativas continuaram',
    );
    assert.deepEqual(await Promise.all(pausedIds.map(sentBy)), frozen, 'pausadas não enviam mais');
    assert.deepEqual(
      (await t.app.lines.list()).map((l) => l.status),
      lines.map((l) => (pausedIds.includes(l.id) ? 'paused' : 'active')),
    );
    assert.equal((await t.app.campaigns.summary(campaign.id)).status, 'running', 'o processo não foi pausado');
  });

  it('retomar uma linha pausada continua do ponto atual, sem reiniciar o processo', async () => {
    const { lines, contactIds, message } = await setup(2, 300, { providerConfig: { sendDelayMs: 3 } });
    for (const line of lines) await t.app.lines.start(line.id);
    const campaign = await t.app.campaigns.create({ name: 'Retomada', lineIds: lines.map((l) => l.id), contactIds });
    const started = await t.app.campaigns.execute(campaign.id, 'start');
    await waitFor(async () => (await campaignCounts(campaign.id)).sent >= 20, 5000, 'progresso');

    const line04 = lines[1]!.id;
    await t.app.lines.pause(line04);
    await sleep(20);
    const frozen = await sentBy(line04);
    await sleep(60);
    assert.equal(await sentBy(line04), frozen);
    const processedBeforeResume = (await campaignCounts(campaign.id)).processed;

    const resumed = await t.app.lines.resume(line04);
    assert.equal(resumed.status, 'active');
    await waitFor(async () => (await sentBy(line04)) > frozen, 2000, 'linha retomada voltou a enviar');

    const after = await t.app.campaigns.summary(campaign.id);
    assert.equal(after.startedAt, started.startedAt, 'processo não reiniciado');
    assert.ok(after.counts.processed >= processedBeforeResume, 'progresso preservado');

    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 10_000, 'conclusão');
    const history = await t.app.history.list({ campaignId: campaign.id, limit: 1000 });
    assert.equal(history.length, 300);
    assert.equal(new Set(history.map((h) => h.contactId)).size, 300, 'nenhum contato reenviado após retomar');
  });

  it('desconectar uma linha durante o processo não interrompe as demais nem perde contatos', async () => {
    const { lines, contactIds, message } = await setup(3, 150, { providerConfig: { sendDelayMs: 3 } });
    for (const line of lines) await t.app.lines.start(line.id);
    const campaign = await t.app.campaigns.create({ name: 'Desc', lineIds: lines.map((l) => l.id), contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');
    await waitFor(async () => (await campaignCounts(campaign.id)).sent >= 10, 5000, 'progresso');

    const disconnected = await t.app.lines.disconnect(lines[0]!.id);
    assert.equal(disconnected.status, 'disconnected');
    assert.equal(disconnected.nextReconnectAt, null, 'desconexão manual não agenda reconexão');
    await sleep(10);
    const frozen = await sentBy(lines[0]!.id);

    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 10_000, 'conclusão');
    assert.equal(await sentBy(lines[0]!.id), frozen);
    const counts = await campaignCounts(campaign.id);
    assert.equal(counts.sent, 150);
  });

  it('respeita o limite diário de cada linha isoladamente', async () => {
    const { lines, contactIds, message } = await setup(2, 10);
    await t.app.lines.update(lines[0]!.id, { settings: { dailyLimit: 2 } });
    await t.app.lines.update(lines[1]!.id, { providerConfig: { sendDelayMs: 15 } });
    for (const line of lines) await t.app.lines.start(line.id);
    const campaign = await t.app.campaigns.create({ name: 'Limite', lineIds: lines.map((l) => l.id), contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');

    await waitFor(() => t.app.dispatch.snapshot(lines[0]!.id)?.state === 'daily_limit', 3000, 'limite diário atingido');
    assert.equal((await t.app.campaigns.summary(campaign.id)).status, 'running', 'a outra linha segue trabalhando');

    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 5000, 'conclusão');
    assert.equal(await sentBy(lines[0]!.id), 2);
    assert.equal(await sentBy(lines[1]!.id), 8);
  });

  // ------------------------------------------------------------------ controle global das selecionadas

  it('iniciar/pausar/retomar selecionadas sem eliminar o controle individual', async () => {
    const { lines } = await setup(5, 0);
    const ids = lines.map((l) => l.id);

    const started = await t.app.lines.executeMany([ids[0]!, ids[1]!, ids[3]!], 'start');
    assert.deepEqual(started.map((r) => r.outcome), ['done', 'done', 'done']);
    assert.deepEqual((await t.app.lines.list()).map((l) => l.status), ['active', 'active', 'disconnected', 'active', 'disconnected']);

    // Ajuste individual entre comandos globais.
    await t.app.lines.pause(ids[1]!);

    const paused = await t.app.lines.executeMany([ids[0]!, ids[1]!, ids[2]!], 'pause');
    assert.deepEqual(paused.map((r) => r.outcome), ['done', 'skipped', 'skipped']);
    assert.deepEqual((await t.app.lines.list()).map((l) => l.runState), ['paused', 'paused', 'stopped', 'active', 'stopped']);

    const resumed = await t.app.lines.executeMany([ids[1]!, 'inexistente'], 'resume');
    assert.deepEqual(resumed.map((r) => r.outcome), ['done', 'failed']);
    assert.deepEqual((await t.app.lines.list()).map((l) => l.runState), ['paused', 'active', 'stopped', 'active', 'stopped']);

    // Individual continua funcionando.
    assert.equal((await t.app.lines.resume(ids[0]!)).status, 'active');
  });

  it('API: conectar, comandos em lote e situação dos workers', async () => {
    const { lines } = await setup(3, 0);
    const server = await buildServer(t.app);
    try {
      const connected = await server.inject({ method: 'POST', url: `/api/lines/${lines[2]!.id}/connect` });
      assert.equal(connected.statusCode, 200);
      assert.equal(connected.json().status, 'connected');

      const bulk = await server.inject({
        method: 'POST',
        url: '/api/lines/bulk/start',
        payload: { lineIds: [lines[0]!.id, lines[1]!.id] },
      });
      assert.equal(bulk.statusCode, 200);
      assert.deepEqual(bulk.json().results.map((r: { outcome: string }) => r.outcome), ['done', 'done']);
      assert.equal((await server.inject({ method: 'POST', url: '/api/lines/bulk/pause', payload: { lineIds: [] } })).statusCode, 400);

      const workers = (await server.inject({ method: 'GET', url: '/api/lines/workers' })).json().workers;
      assert.equal(workers.length, 3);
      const overview = (await server.inject({ method: 'GET', url: '/api/overview' })).json();
      assert.equal(overview.workers.length, 3);
    } finally {
      await server.close();
    }
  });
});
