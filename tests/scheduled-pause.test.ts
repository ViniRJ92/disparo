import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import type { LineView } from '../src/server/modules/lines/line.types.ts';
import { createTestApp, sleep, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Pausa programada', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  async function setup(o: { lines: { label: string; sendDelayMs: number }[]; contacts: number; scheduledPause?: { enabled: boolean; limit: number | null } }) {
    t = await createTestApp();
    if (o.scheduledPause) await t.app.settings.update({ scheduledPause: o.scheduledPause });
    const lines: LineView[] = [];
    for (const spec of o.lines) {
      const line = await t.app.lines.create({ label: spec.label, provider: 'mock', providerConfig: { sendDelayMs: spec.sendDelayMs }, settings: FAST });
      await t.app.lines.start(line.id);
      lines.push(line);
    }
    await t.app.messages.saveSlot(1, { body: 'Oi {{nome}}' });
    const { contactIds } = await t.app.contacts.import(
      Array.from({ length: o.contacts }, (_, i) => ({ phone: `552195${String(i).padStart(7, '0')}`, name: `C${i}` })),
    );
    const campaign = await t.app.campaigns.create({ name: 'Pausa programada', lineIds: lines.map((l) => l.id), contactIds, start: true });
    return { lines, contactIds, campaignId: campaign.id };
  }

  const status = (id: string) => t.app.lines.status(id);
  const sent = async (id: string) => (await status(id)).counters.messagesSent;

  for (const limit of [10, 15, 30, 50, 7]) {
    it(`limite de ${limit} mensagens${limit === 7 ? ' (personalizado)' : ''}: cada linha pausa exatamente no próprio limite`, async () => {
      const { lines, campaignId } = await setup({
        lines: [{ label: 'Linha 1', sendDelayMs: 1 }, { label: 'Linha 2', sendDelayMs: 1 }],
        contacts: limit * 2 + 6,
        scheduledPause: { enabled: true, limit },
      });
      await waitFor(async () => (await Promise.all(lines.map((l) => status(l.id)))).every((l) => l.runState === 'paused'), 15_000, 'as duas pausadas');

      for (const line of lines) {
        const view = await status(line.id);
        assert.equal(view.counters.messagesSent, limit, `${view.label} enviou exatamente ${limit}`);
        assert.equal(view.pauseReason, 'scheduled');
        assert.equal(view.operationalState, 'paused');
        assert.equal(view.connectionStatus, 'connected', 'pausada, mas continua conectada');
        assert.deepEqual(view.scheduledPause, { enabled: true, limit, count: limit, remaining: 0, awaitingDecision: true });
      }
      const counts = (await t.app.campaigns.summary(campaignId)).counts;
      assert.equal(counts.pending, 6, 'contatos restantes continuam na fila');
      assert.equal((await t.app.campaigns.summary(campaignId)).status, 'running', 'o disparo não é pausado');
    });
  }

  it('sem limite: nenhuma pausa automática', async () => {
    const { lines, campaignId } = await setup({
      lines: [{ label: 'Linha 1', sendDelayMs: 1 }, { label: 'Linha 2', sendDelayMs: 1 }],
      contacts: 60,
      scheduledPause: { enabled: true, limit: null },
    });
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).status === 'completed', 10_000, 'conclusão');
    for (const line of lines) assert.equal((await status(line.id)).runState, 'active');
  });

  it('funcionalidade desativada: nenhuma pausa por quantidade, mesmo com limite configurado', async () => {
    const { lines, campaignId } = await setup({
      lines: [{ label: 'Linha 1', sendDelayMs: 1 }],
      contacts: 40,
      scheduledPause: { enabled: false, limit: 10 },
    });
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).status === 'completed', 10_000, 'conclusão');
    assert.equal(await sent(lines[0]!.id), 40);
    assert.equal((await status(lines[0]!.id)).scheduledPause.remaining, null);
  });

  it('contador individual: Linha 1 atinge o limite e pausa enquanto a Linha 2 continua; depois a Linha 2 pausa em outro momento', async () => {
    const { lines } = await setup({
      lines: [{ label: 'Linha 1', sendDelayMs: 1 }, { label: 'Linha 2', sendDelayMs: 25 }],
      contacts: 100,
      scheduledPause: { enabled: true, limit: 10 },
    });
    const [fast, slow] = lines as [LineView, LineView];
    const events: { lineId: string; label: string; limit: number }[] = [];
    t.app.events.on('line.scheduled_pause', (event) => events.push(event));

    // Linha 2 entra depois (os ciclos equilibram o ritmo; assim os contadores ficam realmente diferentes).
    await t.app.lines.pause(slow.id);
    await waitFor(async () => (await sent(fast.id)) >= 6, 5000, 'Linha 1 adiantada');
    await t.app.lines.resume(slow.id);

    await waitFor(async () => (await status(fast.id)).runState === 'paused', 5000, 'Linha 1 pausada');
    const slowNow = await status(slow.id);
    assert.equal(slowNow.runState, 'active', 'Linha 2 não é afetada');
    assert.ok(slowNow.scheduledPause.count < 10, `Linha 2 com contador próprio (${slowNow.scheduledPause.count})`);
    const slowBefore = slowNow.counters.messagesSent;
    await sleep(120);
    assert.ok((await sent(slow.id)) > slowBefore, 'Linha 2 continua enviando');
    assert.equal(await sent(fast.id), 10, 'Linha 1 não envia mais');

    await waitFor(async () => (await status(slow.id)).runState === 'paused', 5000, 'Linha 2 pausada em outro momento');
    assert.equal(await sent(slow.id), 10);
    assert.deepEqual(events.map((e) => [e.label, e.limit]), [['Linha 1', 10], ['Linha 2', 10]]);
  });

  it('CONTINUAR retoma só aquela linha (contador recomeça); MANTER PAUSADA deixa a linha parada', async () => {
    const { lines, campaignId } = await setup({
      lines: [{ label: 'Linha 1', sendDelayMs: 1 }, { label: 'Linha 2', sendDelayMs: 1 }],
      contacts: 80,
      scheduledPause: { enabled: true, limit: 10 },
    });
    const [a, b] = lines as [LineView, LineView];
    await waitFor(async () => (await Promise.all([a, b].map((l) => status(l.id)))).every((l) => l.scheduledPause.awaitingDecision), 5000, 'decisões pendentes');

    const kept = await t.app.lines.keepPaused(b.id);
    assert.equal(kept.runState, 'paused');
    assert.equal(kept.scheduledPause.awaitingDecision, false, 'decisão registrada');

    const continued = await t.app.lines.continueAfterScheduledPause(a.id);
    assert.equal(continued.runState, 'active');
    assert.equal(continued.scheduledPause.count, 0, 'contador individual recomeça');
    await waitFor(async () => (await status(a.id)).runState === 'paused', 5000, 'Linha 1 pausa de novo no próximo limite');
    assert.equal(await sent(a.id), 20);
    assert.equal(await sent(b.id), 10, 'Linha 2 mantida pausada não recebeu contatos');

    // Uma linha "mantida pausada" pode ser retomada depois: vale como continuar.
    const resumed = await t.app.lines.resume(b.id);
    assert.equal(resumed.scheduledPause.count, 0);
    await waitFor(async () => (await sent(b.id)) > 10, 5000, 'Linha 2 retomada');

    const logs = await t.app.logs.list({ limit: 200 });
    assert.ok(logs.some((l) => l.message.includes('atingiu o limite de 10 mensagens')));
    assert.ok(logs.some((l) => l.message.includes('manter pausada')));
    assert.ok(logs.some((l) => l.message.includes('continuou após a pausa programada')));
    assert.equal((await t.app.campaigns.summary(campaignId)).status, 'running');
  });

  it('pausa manual é independente da programada', async () => {
    const { lines } = await setup({
      lines: [{ label: 'Linha 1', sendDelayMs: 5 }, { label: 'Linha 2', sendDelayMs: 5 }, { label: 'Linha 3', sendDelayMs: 5 }],
      contacts: 300,
      scheduledPause: { enabled: true, limit: 50 },
    });
    await waitFor(async () => (await sent(lines[0]!.id)) >= 3, 5000, 'progresso');

    const manual = await t.app.lines.pause(lines[0]!.id);
    assert.equal(manual.pauseReason, 'manual');
    assert.equal(manual.scheduledPause.awaitingDecision, false, 'pausa manual não pede decisão');
    await assert.rejects(t.app.lines.continueAfterScheduledPause(lines[0]!.id), /não está pausada pela pausa programada/);
    await assert.rejects(t.app.lines.keepPaused(lines[0]!.id), /não está aguardando decisão/);

    // Várias pausas manuais independentes; as demais continuam.
    await t.app.lines.pause(lines[1]!.id);
    const before = await sent(lines[2]!.id);
    await sleep(100);
    assert.ok((await sent(lines[2]!.id)) > before, 'Linha 3 continua');

    const countBefore = (await status(lines[0]!.id)).scheduledPause.count;
    const resumed = await t.app.lines.resume(lines[0]!.id);
    assert.equal(resumed.pauseReason, null);
    assert.equal(resumed.scheduledPause.count, countBefore, 'retomar pausa manual não zera o contador programado');
  });

  it('alterar a configuração zera os contadores individuais e é registrada no log', async () => {
    const { lines } = await setup({ lines: [{ label: 'Linha 1', sendDelayMs: 1 }], contacts: 5 });
    await waitFor(async () => (await sent(lines[0]!.id)) === 5, 5000, 'envios');
    assert.equal((await status(lines[0]!.id)).scheduledPause.count, 5);

    await t.app.settings.update({ scheduledPause: { enabled: true, limit: 30 } });
    await waitFor(async () => (await status(lines[0]!.id)).scheduledPause.count === 0, 1000, 'contador zerado');
    const view = await status(lines[0]!.id);
    assert.deepEqual(view.scheduledPause, { enabled: true, limit: 30, count: 0, remaining: 30, awaitingDecision: false });
    const logs = await t.app.logs.list({ limit: 50 });
    assert.ok(logs.some((l) => l.message.includes('Pausa programada ativada: 30 mensagens por linha')));
    assert.ok(logs.some((l) => l.message.startsWith('Configuração alterada: scheduledPause')));
  });

  it('API: configurar, continuar e manter pausada', async () => {
    const { lines } = await setup({
      lines: [{ label: 'Linha 1', sendDelayMs: 1 }, { label: 'Linha 2', sendDelayMs: 1 }],
      contacts: 30,
    });
    const server = await buildServer(t.app);
    try {
      const configured = await server.inject({ method: 'PATCH', url: '/api/settings', payload: { scheduledPause: { enabled: true, limit: 5 } } });
      assert.equal(configured.statusCode, 200);
      assert.deepEqual(configured.json().scheduledPause, { enabled: true, limit: 5 });
      assert.equal((await server.inject({ method: 'PATCH', url: '/api/settings', payload: { scheduledPause: { limit: 0 } } })).statusCode, 400);

      await waitFor(async () => (await Promise.all(lines.map((l) => status(l.id)))).every((l) => l.scheduledPause.awaitingDecision), 5000, 'limite');
      const cont = await server.inject({ method: 'POST', url: `/api/lines/${lines[0]!.id}/scheduled-pause/continue` });
      assert.equal(cont.json().runState, 'active');
      const keep = await server.inject({ method: 'POST', url: `/api/lines/${lines[1]!.id}/scheduled-pause/keep-paused` });
      assert.equal(keep.json().runState, 'paused');
      assert.equal((await server.inject({ method: 'POST', url: `/api/lines/${lines[1]!.id}/scheduled-pause/keep-paused` })).statusCode, 200);
      assert.equal((await server.inject({ method: 'POST', url: `/api/lines/${lines[0]!.id}/scheduled-pause/continue` })).statusCode, 409);
    } finally {
      await server.close();
    }
  });
});
