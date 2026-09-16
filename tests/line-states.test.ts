import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import { createTestApp, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Estados das linhas: conexão, operacional e participação ficam separados', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  it('conectada+pausada, conectada sem participar, desconectada+parada e erro de conexão', async () => {
    t = await createTestApp();
    const make = (label: string, providerConfig: Record<string, unknown> = {}) =>
      t.app.lines.create({ label, provider: 'mock', providerConfig, settings: FAST });
    const paused = await make('Pausada');
    const outside = await make('Fora do disparo');
    const stopped = await make('Parada');
    const broken = await make('Com erro', { failConnect: true });
    await t.app.lines.start(paused.id);
    await t.app.lines.pause(paused.id);
    await t.app.lines.start(outside.id);
    await t.app.lines.start(broken.id);
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const { contactIds } = await t.app.contacts.import([{ phone: '21999990000' }]);
    await t.app.campaigns.create({ name: 'D', lineIds: [paused.id, stopped.id], contactIds, start: true });

    const view = async (id: string) => {
      const line = await t.app.lines.status(id);
      const row = (await t.app.dashboard.dashboard()).perLine.find((r) => r.lineId === id)!;
      return { connection: line.connectionStatus, operational: line.operationalState, participating: row.participating };
    };
    assert.deepEqual(await view(paused.id), { connection: 'connected', operational: 'paused', participating: true });
    assert.deepEqual(await view(outside.id), { connection: 'connected', operational: 'active', participating: false });
    assert.deepEqual(await view(stopped.id), { connection: 'disconnected', operational: 'stopped', participating: true });
    assert.deepEqual(await view(broken.id), { connection: 'error', operational: 'active', participating: false });
  });

  it('pausar todas e retomar todas (todas as linhas cadastradas), sem mexer nas paradas', async () => {
    t = await createTestApp();
    const ids = [];
    for (let i = 1; i <= 4; i++) {
      const line = await t.app.lines.create({ label: `Linha ${i}`, provider: 'mock', settings: FAST });
      if (i < 4) await t.app.lines.start(line.id);
      ids.push(line.id);
    }
    const server = await buildServer(t.app);
    try {
      const paused = (await server.inject({ method: 'POST', url: '/api/lines/all/pause' })).json().results;
      assert.deepEqual(paused.map((r: { outcome: string }) => r.outcome), ['done', 'done', 'done', 'skipped']);
      assert.deepEqual((await t.app.lines.list()).map((l) => l.operationalState), ['paused', 'paused', 'paused', 'stopped']);
      await server.inject({ method: 'POST', url: '/api/lines/all/resume' });
      assert.deepEqual((await t.app.lines.list()).map((l) => l.operationalState), ['active', 'active', 'active', 'stopped']);
    } finally {
      await server.close();
    }
  });
});
