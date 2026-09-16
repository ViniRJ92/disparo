import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import type { SqlParams } from '../src/server/db/database.ts';
import type { Dashboard } from '../src/server/modules/stats/dashboard.service.ts';
import { createTestApp, sleep, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Módulo 7: Dashboard com dados reais', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  /** Confere cada indicador contra consultas diretas ao banco. */
  function assertMatchesDatabase(dashboard: Dashboard, campaignId?: string) {
    const scope = campaignId ? 'AND campaign_id = :campaignId' : '';
    const params: SqlParams = campaignId ? { campaignId } : {};
    const jobs = (status: string) =>
      t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM send_jobs WHERE status = :status ${scope}`, { status, ...params })!.n;
    const total = t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM send_jobs WHERE 1 = 1 ${scope}`, params)!.n;

    const p = dashboard.processing;
    assert.equal(p.contactsRegistered, t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts')!.n);
    assert.equal(p.total, total);
    assert.equal(p.sent, jobs('sent'));
    assert.equal(p.failed, jobs('failed'));
    assert.equal(p.skipped, jobs('skipped'));
    assert.equal(p.pending, jobs('pending') + jobs('processing'));
    assert.equal(p.processed, jobs('sent') + jobs('failed') + jobs('skipped'));

    for (const row of dashboard.perLine) {
      const byLine = (status: string) =>
        t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM send_jobs WHERE line_id = :lineId AND status = :status ${scope}`, {
          lineId: row.lineId,
          status,
          ...params,
        })!.n;
      assert.equal(row.sent, byLine('sent'), `${row.label}: enviados`);
      assert.equal(row.failed, byLine('failed'), `${row.label}: erros`);
      assert.equal(row.processed, byLine('sent') + byLine('failed'), `${row.label}: processados`);
      const last = t.app.db.get<{ at: string | null }>(
        `SELECT MAX(created_at) AS at FROM send_attempts WHERE line_id = :lineId AND result = 'sent' ${scope}`,
        { lineId: row.lineId, ...params },
      )!.at;
      assert.equal(row.lastSentAt, last, `${row.label}: último envio`);
    }
    // Mesma fonte: a soma por linha fecha com os totais.
    assert.equal(dashboard.perLine.reduce((s, r) => s + r.sent, 0), p.sent);
    assert.equal(dashboard.perLine.reduce((s, r) => s + r.failed, 0), p.failed);
  }

  it('sistema vazio: tudo zerado, nada inventado', async () => {
    t = await createTestApp();
    const dashboard = await t.app.dashboard.dashboard();
    assert.deepEqual(dashboard.lines, { total: 0, max: 10, connected: 0, active: 0, paused: 0, withError: 0, disconnected: 0, connecting: 0, participating: 0, pausedBySchedule: 0 });
    assert.deepEqual(
      { ...dashboard.processing },
      { campaignId: null, contactsRegistered: 0, total: 0, processed: 0, pending: 0, processing: 0, sent: 0, failed: 0, skipped: 0 },
    );
    assert.deepEqual(dashboard.perLine, []);
  });

  it('LINHAS: conectadas, ativas, pausadas, com erro e desconectadas refletem o estado real', async () => {
    t = await createTestApp({ reconnectDelaysMs: [] });
    const make = (label: string, providerConfig: Record<string, unknown> = {}) =>
      t.app.lines.create({ label, provider: 'mock', providerConfig, settings: FAST });
    const [a1, a2, p1, c1, e1] = await Promise.all([make('A1'), make('A2'), make('P1'), make('C1'), make('E1', { failConnect: true })]);
    await make('D1');
    await t.app.lines.start(a1.id);
    await t.app.lines.start(a2.id);
    await t.app.lines.start(p1.id);
    await t.app.lines.pause(p1.id);
    await t.app.lines.connect(c1.id);
    await t.app.lines.start(e1.id);

    const { lines } = await t.app.dashboard.dashboard();
    assert.deepEqual(lines, { total: 6, max: 10, connected: 4, active: 2, paused: 1, withError: 1, disconnected: 1, connecting: 0, participating: 0, pausedBySchedule: 0 });
  });

  it('PROCESSAMENTO e POR LINHA batem com o banco, inclusive com erros e contatos não enviados', async () => {
    t = await createTestApp();
    const ok = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    const bad = await t.app.lines.create({ label: 'Linha 02', provider: 'mock', providerConfig: { failSend: true }, settings: FAST });
    const idle = await t.app.lines.create({ label: 'Linha 03', provider: 'mock', settings: FAST });
    for (const line of [ok, bad, idle]) await t.app.lines.start(line.id);
    await t.app.messages.saveSlot(1, { body: 'Oi {{nome}}' });
    const { contactIds } = await t.app.contacts.import(Array.from({ length: 30 }, (_, i) => ({ phone: `219800${String(i).padStart(5, '0')}` })));
    await t.app.contacts.update(contactIds[29]!, { status: 'blocked' });

    const campaign = await t.app.campaigns.create({ name: 'Real', lineIds: [ok.id, bad.id], contactIds: contactIds.slice(0, 29), start: true });
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 5000, 'conclusão');

    const dashboard = await t.app.dashboard.dashboard();
    assertMatchesDatabase(dashboard);
    assert.equal(dashboard.processing.total, 29);
    assert.ok(dashboard.processing.sent > 0 && dashboard.processing.failed > 0);
    const byLabel = new Map(dashboard.perLine.map((r) => [r.label, r]));
    assert.equal(byLabel.get('Linha 02')!.sent, 0);
    assert.equal(byLabel.get('Linha 02')!.lastSentAt, null);
    assert.ok(byLabel.get('Linha 02')!.failed > 0);
    assert.deepEqual(
      { processed: byLabel.get('Linha 03')!.processed, lastSentAt: byLabel.get('Linha 03')!.lastSentAt },
      { processed: 0, lastSentAt: null },
      'linha fora do disparo não recebe números',
    );
    assert.equal(dashboard.perLine.find((r) => r.label === 'Linha 01')!.status, 'active');
  });

  it('números acompanham o processamento em andamento', async () => {
    t = await createTestApp();
    const lines = [];
    for (let i = 1; i <= 3; i++) {
      const line = await t.app.lines.create({ label: `Linha 0${i}`, provider: 'mock', providerConfig: { sendDelayMs: 5 }, settings: FAST });
      await t.app.lines.start(line.id);
      lines.push(line);
    }
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const { contactIds } = await t.app.contacts.import(Array.from({ length: 300 }, (_, i) => ({ phone: `219700${String(i).padStart(5, '0')}` })));
    const campaign = await t.app.campaigns.create({ name: 'Ao vivo', lineIds: lines.map((l) => l.id), contactIds, start: true });

    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).counts.sent >= 20, 5000, 'progresso');
    const first = await t.app.dashboard.dashboard();
    await sleep(150);
    const second = await t.app.dashboard.dashboard(campaign.id);
    assert.ok(second.processing.sent > first.processing.sent, `${first.processing.sent} → ${second.processing.sent}`);
    assert.ok(second.processing.pending < first.processing.pending);
    assert.equal(second.processing.total, 300);

    await t.app.campaigns.finish(campaign.id);
    await sleep(30);
    assertMatchesDatabase(await t.app.dashboard.dashboard(campaign.id), campaign.id);
  });

  it('escopo por disparo: só conta o disparo escolhido; "todos" soma os dois', async () => {
    t = await createTestApp();
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    const other = await t.app.lines.create({ label: 'Linha 02', provider: 'mock', settings: FAST });
    await t.app.lines.start(line.id);
    await t.app.lines.start(other.id);
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const { contactIds } = await t.app.contacts.import(Array.from({ length: 15 }, (_, i) => ({ phone: `219600${String(i).padStart(5, '0')}` })));

    const a = await t.app.campaigns.create({ name: 'A', lineIds: [line.id], contactIds: contactIds.slice(0, 10), start: true });
    const b = await t.app.campaigns.create({ name: 'B', lineIds: [other.id], contactIds: contactIds.slice(10), start: true });
    await waitFor(async () => (await t.app.campaigns.list()).every((c) => c.status === 'completed'), 5000, 'conclusão');

    const onlyA = await t.app.dashboard.dashboard(a.id);
    assertMatchesDatabase(onlyA, a.id);
    assert.equal(onlyA.processing.total, 10);
    assert.equal(onlyA.perLine.find((r) => r.lineId === other.id)!.sent, 0);
    const onlyB = await t.app.dashboard.dashboard(b.id);
    assert.equal(onlyB.processing.total, 5);
    const all = await t.app.dashboard.dashboard();
    assertMatchesDatabase(all);
    assert.equal(all.processing.sent, onlyA.processing.sent + onlyB.processing.sent);
  });

  it('detalhes da linha: resultados, tentativas, disparos, últimos envios e logs só desta linha', async () => {
    t = await createTestApp();
    const ok = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    const other = await t.app.lines.create({ label: 'Linha 02', provider: 'mock', settings: FAST });
    await t.app.lines.start(ok.id);
    await t.app.lines.start(other.id);
    await t.app.messages.saveSlot(1, { body: 'Oi {{nome}}' });
    const { contactIds } = await t.app.contacts.import(Array.from({ length: 12 }, (_, i) => ({ phone: `219500${String(i).padStart(5, '0')}`, name: `C${i}` })));
    const campaign = await t.app.campaigns.create({ name: 'Detalhe', lineIds: [ok.id, other.id], contactIds, start: true });
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 5000, 'conclusão');

    const detail = await t.app.dashboard.lineDetail(ok.id);
    assert.equal(detail.line.id, ok.id);
    assert.equal(detail.counts.sent, (await t.app.dashboard.dashboard()).perLine.find((r) => r.lineId === ok.id)!.sent);
    assert.equal(detail.attempts.total, t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM send_attempts WHERE line_id = :id', { id: ok.id })!.n);
    assert.ok(detail.recentAttempts.length > 0 && detail.recentAttempts.every((a) => a.lineId === ok.id));
    assert.ok(detail.recentLogs.every((l) => l.lineId === ok.id));
    assert.deepEqual(detail.processes.map((p) => [p.name, p.status, p.counts.sent]), [['Detalhe', 'completed', detail.counts.sent]]);
    assert.equal(detail.worker?.lineId, ok.id);
    assert.equal(detail.lastSentAt, detail.line.activity.lastSentAt);
  });

  it('API: /api/dashboard e /api/dashboard/lines/:id', async () => {
    t = await createTestApp();
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    const server = await buildServer(t.app);
    try {
      const dashboard = await server.inject({ method: 'GET', url: '/api/dashboard' });
      assert.equal(dashboard.statusCode, 200);
      assert.equal(dashboard.json().perLine[0].label, 'Linha 01');
      assert.equal((await server.inject({ method: 'GET', url: '/api/dashboard?campaignId=nao-existe' })).statusCode, 404);

      const detail = await server.inject({ method: 'GET', url: `/api/dashboard/lines/${line.id}` });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().line.label, 'Linha 01');
      assert.equal((await server.inject({ method: 'GET', url: '/api/dashboard/lines/nao-existe' })).statusCode, 404);
    } finally {
      await server.close();
    }
  });
});
