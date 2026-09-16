import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import type { LineView } from '../src/server/modules/lines/line.types.ts';
import { createTestApp, sleep, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Módulo 6: controle individual das linhas durante o disparo', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  async function setup(lineCount: number, contactCount: number, sendDelayMs = 3, app: Parameters<typeof createTestApp>[0] = {}) {
    t = await createTestApp(app);
    const lines: LineView[] = [];
    for (let i = 1; i <= lineCount; i++) {
      const line = await t.app.lines.create({
        label: `Linha ${String(i).padStart(2, '0')}`,
        provider: 'mock',
        providerConfig: { sendDelayMs },
        settings: FAST,
      });
      await t.app.lines.start(line.id);
      lines.push(line);
    }
    for (let slot = 1; slot <= 3; slot++) await t.app.messages.saveSlot(slot, { body: `Texto ${slot} {{nome}}` });
    const { contactIds } = await t.app.contacts.import(
      Array.from({ length: contactCount }, (_, i) => ({ phone: `55219${String(i).padStart(8, '0')}`, name: `Contato ${i}` })),
    );
    const campaign = await t.app.campaigns.create({ name: 'Disparo', lineIds: lines.map((l) => l.id), contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');
    const ids = lines.map((l) => l.id);
    return { lines, ids, contactIds, campaignId: campaign.id };
  }

  const sent = async (id: string) => (await t.app.lines.status(id)).counters.messagesSent;
  const sentAll = (ids: string[]) => Promise.all(ids.map(sent));
  const campaignSent = async (id: string) => (await t.app.campaigns.summary(id)).counts.sent;

  /**
   * Mede o avanço de cada linha até que TODAS as linhas em "moving" tenham enviado algo
   * (limite de 5 s). Os ciclos fazem uma linha que cumpriu a cota aguardar as outras,
   * então uma janela fixa curta não é confiável. As demais devem ficar paradas o tempo todo.
   */
  async function progress(ids: string[], moving: string[]) {
    await sleep(25); // envio que já estava em curso termina
    const before = await sentAll(ids);
    const deadline = Date.now() + 5000;
    let after = before;
    do {
      await sleep(40);
      after = await sentAll(ids);
    } while (Date.now() < deadline && !moving.every((id) => after[ids.indexOf(id)]! > before[ids.indexOf(id)]!));
    return ids.map((_, i) => after[i]! - before[i]!);
  }

  async function assertNothingLost(campaignId: string, contactIds: string[]) {
    const row = t.app.db.get<{ total: number; distinct_contacts: number }>(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT contact_id) AS distinct_contacts
       FROM send_attempts WHERE campaign_id = :campaignId AND result = 'sent'`,
      { campaignId },
    );
    assert.equal(row?.total, contactIds.length, 'todos enviados');
    assert.equal(row?.distinct_contacts, contactIds.length, 'nenhum contato repetido');
  }

  it('10 linhas: pausar 03, depois 07, retomar 03 — as demais nunca param', async () => {
    const { ids, contactIds, campaignId } = await setup(10, 1500);
    await waitFor(async () => (await campaignSent(campaignId)) >= 50, 10_000, 'disparo em andamento');
    const L = (n: number) => ids[n - 1]!;
    const others = (...paused: number[]) => ids.filter((_, i) => !paused.includes(i + 1));

    // PAUSAR LINHA 03
    assert.equal((await t.app.lines.pause(L(3))).status, 'paused');
    let delta = await progress(ids, others(3));
    assert.equal(delta[2], 0, 'Linha 03 parou');
    others(3).forEach((id) => assert.ok(delta[ids.indexOf(id)]! > 0, 'demais continuam'));

    // PAUSAR LINHA 07
    await t.app.lines.pause(L(7));
    delta = await progress(ids, others(3, 7));
    assert.equal(delta[2], 0, 'Linha 03 continua pausada');
    assert.equal(delta[6], 0, 'Linha 07 parou');
    others(3, 7).forEach((id) => assert.ok(delta[ids.indexOf(id)]! > 0, 'demais continuam'));
    assert.deepEqual(
      (await t.app.lines.list()).map((l) => l.status),
      ids.map((_, i) => ([3, 7].includes(i + 1) ? 'paused' : 'active')),
    );

    // RETOMAR LINHA 03
    await t.app.lines.resume(L(3));
    delta = await progress(ids, ids.filter((_, i) => i !== 6));
    assert.ok(delta[2]! > 0, 'Linha 03 voltou a participar');
    assert.equal(delta[6], 0, 'Linha 07 segue pausada');

    assert.equal((await t.app.campaigns.summary(campaignId)).status, 'running', 'o disparo nunca foi interrompido');
    await t.app.lines.resume(L(7));
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).status === 'completed', 30_000, 'conclusão');
    await assertNothingLost(campaignId, contactIds);
  });

  it('pausar várias e retomar várias ao mesmo tempo; desconectar uma e reconectar uma', async () => {
    const { ids, contactIds, campaignId } = await setup(6, 900);
    await waitFor(async () => (await campaignSent(campaignId)) >= 30, 10_000, 'disparo em andamento');

    // Pausar várias (comandos simultâneos, cada um na sua linha).
    const several = [ids[0]!, ids[2]!, ids[4]!];
    await Promise.all(several.map((id) => t.app.lines.pause(id)));
    let delta = await progress(ids, ids.filter((id) => !several.includes(id)));
    ids.forEach((id, i) => (several.includes(id) ? assert.equal(delta[i], 0) : assert.ok(delta[i]! > 0)));

    // Retomar várias.
    await Promise.all(several.map((id) => t.app.lines.resume(id)));
    delta = await progress(ids, ids);
    assert.ok(delta.every((d) => d > 0), 'todas voltaram');

    // Desconectar uma.
    const victim = ids[1]!;
    assert.equal((await t.app.lines.disconnect(victim)).status, 'disconnected');
    delta = await progress(ids, ids.filter((id) => id !== victim));
    ids.forEach((id, i) => (id === victim ? assert.equal(delta[i], 0) : assert.ok(delta[i]! > 0)));

    // Reconectar uma (desconexão manual para a linha: iniciar a reconecta e ativa).
    assert.equal((await t.app.lines.start(victim)).status, 'active');
    delta = await progress(ids, ids);
    assert.ok(delta.every((d) => d > 0), 'reconectada volta a enviar, demais seguem');

    // Reconectar uma linha ativa (refaz a sessão) sem afetar as outras.
    await t.app.lines.reconnect(ids[3]!);
    delta = await progress(ids, ids);
    assert.ok(delta.every((d) => d > 0));

    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).status === 'completed', 30_000, 'conclusão');
    await assertNothingLost(campaignId, contactIds);
  });

  it('PAUSAR TODAS / RETOMAR TODAS: o disparo continua existindo e o controle individual segue funcionando', async () => {
    const { ids, contactIds, campaignId } = await setup(4, 400);
    await waitFor(async () => (await campaignSent(campaignId)) >= 20, 10_000, 'disparo em andamento');

    const paused = await t.app.campaigns.pauseAllLines(campaignId);
    assert.deepEqual(paused.map((r) => r.outcome), ['done', 'done', 'done', 'done']);
    const frozen = await (async () => {
      await sleep(30);
      return campaignSent(campaignId);
    })();
    await sleep(150);
    assert.equal(await campaignSent(campaignId), frozen, 'nada é enviado com todas pausadas');
    assert.equal((await t.app.campaigns.summary(campaignId)).status, 'running', 'pausar todas não encerra o disparo');
    assert.ok((await t.app.contacts.summary()).byProcessing.waiting > 0, 'contatos ficam aguardando');

    // Controle individual durante "todas pausadas": retomar só a Linha 02.
    await t.app.lines.resume(ids[1]!);
    const delta = await progress(ids, [ids[1]!]);
    assert.deepEqual(delta.map((d) => d > 0), [false, true, false, false]);

    const resumed = await t.app.campaigns.resumeAllLines(campaignId);
    assert.deepEqual(resumed.map((r) => r.outcome), ['done', 'skipped', 'done', 'done'], 'Linha 02 já estava ativa');
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).status === 'completed', 30_000, 'conclusão');
    await assertNothingLost(campaignId, contactIds);
  });

  it('ENCERRAR DISPARO é definitivo e diferente de pausar', async () => {
    const { ids, contactIds, campaignId } = await setup(3, 600);
    await waitFor(async () => (await campaignSent(campaignId)) >= 20, 10_000, 'disparo em andamento');

    // Pausar o processo: pode continuar depois.
    await t.app.campaigns.execute(campaignId, 'pause');
    await sleep(30);
    const atPause = await campaignSent(campaignId);
    await sleep(100);
    assert.equal(await campaignSent(campaignId), atPause);
    await t.app.campaigns.execute(campaignId, 'resume');
    await waitFor(async () => (await campaignSent(campaignId)) > atPause, 2000, 'pausado continua depois');

    // Encerrar: finaliza.
    const finished = await t.app.campaigns.finish(campaignId);
    assert.equal(finished.status, 'cancelled');
    assert.ok(finished.finishedAt);
    await sleep(30); // envios que já estavam em curso terminam e são registrados
    const final = await t.app.campaigns.summary(campaignId);
    await sleep(150);
    assert.deepEqual((await t.app.campaigns.summary(campaignId)).counts, final.counts, 'nenhum envio após encerrar');

    assert.equal(final.counts.pending, 0, 'ninguém fica pendente num disparo encerrado');
    assert.equal(final.counts.processing, 0);
    assert.equal(final.counts.sent + final.counts.skipped + final.counts.failed, contactIds.length, 'todo contato tem estado final');
    assert.ok(final.counts.skipped > 0);
    const skippedJob = (await t.app.queue.list({ campaignId, status: 'skipped', limit: 1 }))[0]!;
    assert.equal(skippedJob.lastError, 'Disparo encerrado');
    const summary = await t.app.contacts.summary();
    assert.equal(summary.byProcessing.pending + summary.byProcessing.waiting, 0);

    await assert.rejects(t.app.campaigns.execute(campaignId, 'resume'), /Não é possível retomar/);
    await assert.rejects(t.app.campaigns.pauseAllLines(campaignId), /não pode ser alterada/);

    // Encerrar o disparo não pausa nem derruba as linhas.
    assert.deepEqual((await t.app.lines.list()).map((l) => l.status), ['active', 'active', 'active']);
    assert.ok(ids.every((id) => t.app.dispatch.snapshot(id)?.state === 'no_process'));
  });

  it('cada linha mostra último contato, último envio e última mensagem, atualizados em tempo real', async () => {
    t = await createTestApp();
    const ok = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    const bad = await t.app.lines.create({ label: 'Linha 02', provider: 'mock', providerConfig: { failSend: true }, settings: FAST });
    assert.deepEqual(ok.activity, {
      lastContactId: null,
      lastContactName: null,
      lastContactPhone: null,
      lastMessageLabel: null,
      lastAttemptAt: null,
      lastAttemptResult: null,
      lastSentAt: null,
    });
    await t.app.messages.saveSlot(2, { body: 'Olá {{nome}}' });
    const { contactIds } = await t.app.contacts.import([{ phone: '21999990001', name: 'João' }]);

    const updates: LineView[] = [];
    t.app.events.on('line.updated', (view) => updates.push(view));

    await t.app.lines.start(ok.id);
    const first = await t.app.campaigns.create({ name: 'A', lineIds: [ok.id], contactIds });
    await t.app.campaigns.execute(first.id, 'start');
    await waitFor(async () => (await t.app.campaigns.summary(first.id)).status === 'completed', 3000, 'envio');

    const line = await t.app.lines.status(ok.id);
    assert.equal(line.activity.lastContactName, 'João');
    assert.equal(line.activity.lastContactPhone, '5521999990001');
    assert.equal(line.activity.lastMessageLabel, 'Mensagem 02');
    assert.equal(line.activity.lastAttemptResult, 'sent');
    assert.ok(line.activity.lastSentAt);
    await waitFor(() => updates.some((u) => u.id === ok.id && u.activity.lastContactName === 'João' && u.counters.messagesSent === 1), 1000, 'evento em tempo real');

    // Falha: atualiza o último contato processado, mas não o "último envio".
    await t.app.lines.start(bad.id);
    const second = await t.app.campaigns.create({ name: 'B', lineIds: [bad.id], contactIds });
    await t.app.campaigns.execute(second.id, 'start');
    await waitFor(async () => (await t.app.campaigns.summary(second.id)).status === 'completed', 3000, 'falha');
    const failed = await t.app.lines.status(bad.id);
    assert.equal(failed.activity.lastContactName, 'João');
    assert.equal(failed.activity.lastAttemptResult, 'failed');
    assert.equal(failed.activity.lastSentAt, null);
    assert.equal(failed.counters.failures, 1);
    assert.equal(failed.counters.contactsProcessed, 1);
  });

  it('API: pausar todas, retomar todas e encerrar disparo', async () => {
    const { campaignId } = await setup(3, 300);
    const server = await buildServer(t.app);
    try {
      const pause = await server.inject({ method: 'POST', url: `/api/campaigns/${campaignId}/lines/pause-all` });
      assert.equal(pause.statusCode, 200);
      assert.equal(pause.json().results.filter((r: { outcome: string }) => r.outcome === 'done').length, 3);

      const resume = await server.inject({ method: 'POST', url: `/api/campaigns/${campaignId}/lines/resume-all` });
      assert.equal(resume.json().results.length, 3);

      const finish = await server.inject({ method: 'POST', url: `/api/campaigns/${campaignId}/finish` });
      assert.equal(finish.statusCode, 200);
      assert.equal(finish.json().status, 'cancelled');
      assert.equal((await server.inject({ method: 'POST', url: `/api/campaigns/${campaignId}/finish` })).statusCode, 409);
      assert.equal((await server.inject({ method: 'POST', url: `/api/campaigns/${campaignId}/lines/pause-all` })).statusCode, 409);

      const lines = (await server.inject({ method: 'GET', url: '/api/lines' })).json().lines;
      assert.ok('activity' in lines[0]);
    } finally {
      await server.close();
    }
  });
});
