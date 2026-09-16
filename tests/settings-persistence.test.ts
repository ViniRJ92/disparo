import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import { createApp } from '../src/server/app.ts';
import { MockProvider } from '../src/server/modules/providers/mock.provider.ts';
import { ProviderRegistry } from '../src/server/modules/providers/provider.registry.ts';

const dir = mkdtempSync(join(tmpdir(), 'disparo-settings-'));
const open = (file: string) =>
  createApp({
    databasePath: join(dir, file),
    providers: new ProviderRegistry().register('mock', (context) => new MockProvider(context)),
    reconnectDelaysMs: [],
    dispatch: { idlePollMs: 20, errorBackoffMs: 20 },
  });

describe('Módulo 9: configurações persistentes', () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('todas as configurações salvas continuam após reiniciar o sistema', async () => {
    const first = await open('persist.db');
    await first.settings.update({
      maxLines: 6,
      defaultCountryCode: '351',
      defaultLineSettings: { dailyLimit: 150 },
      distribution: { minBatch: 3, maxBatch: 4, cycleIntervalSeconds: [2, 4] },
      scheduledPause: { enabled: true, limit: 30 },
    });
    const a = await first.lines.create({ label: 'Linha 1', provider: 'mock' });
    const b = await first.lines.create({ label: 'Linha 2', provider: 'mock' });
    const c = await first.lines.create({ label: 'Linha 3', provider: 'mock' });
    await first.lines.update(a.id, { label: 'Secretaria', settings: { dailyLimit: 80 } });
    await first.lines.start(a.id);
    await first.lines.start(b.id);
    await first.lines.pause(b.id);
    const m1 = await first.messages.saveSlot(1, { body: 'Olá {{nome}}' });
    const m2 = await first.messages.saveSlot(2, { body: 'Oi' });
    await first.messages.setActive(m2.id, false);
    const draft = await first.campaigns.create({ name: 'Outubro', lineIds: [a.id] });
    await first.campaigns.setLines(draft.id, [a.id, c.id]);
    await first.close();

    const second = await open('persist.db');
    const settings = await second.settings.get();
    assert.equal(settings.maxLines, 6);
    assert.equal(settings.defaultCountryCode, '351');
    assert.equal(settings.defaultLineSettings.dailyLimit, 150);
    assert.deepEqual(settings.distribution, { minBatch: 3, maxBatch: 4, cycleIntervalSeconds: [2, 4], roundStallSeconds: 180 });
    assert.deepEqual(settings.scheduledPause, { enabled: true, limit: 30 });

    const lines = new Map((await second.lines.list()).map((l) => [l.id, l]));
    assert.equal(lines.get(a.id)!.label, 'Secretaria');
    assert.equal(lines.get(a.id)!.settings.dailyLimit, 80);
    assert.equal(lines.get(a.id)!.operationalState, 'active');
    assert.equal(lines.get(b.id)!.operationalState, 'paused', 'linha pausada continua pausada');
    assert.equal(lines.get(b.id)!.pauseReason, 'manual');
    assert.equal(lines.get(c.id)!.operationalState, 'stopped');
    assert.equal(lines.get(a.id)!.scheduledPause.limit, 30);

    assert.deepEqual((await second.messages.listActive()).map((m) => m.id), [m1.id], 'mensagem desativada continua desativada');
    assert.deepEqual(new Set((await second.campaigns.summary(draft.id)).lineIds), new Set([a.id, c.id]), 'linhas do processo mantidas');
    await second.close();
  });

  it('validações: máximo de linhas abaixo das cadastradas e ciclos inválidos são recusados', async () => {
    const app = await open('validation.db');
    const server = await buildServer(app);
    try {
      for (let i = 1; i <= 3; i++) await app.lines.create({ label: `Linha ${i}`, provider: 'mock' });
      const tooFew = await server.inject({ method: 'PATCH', url: '/api/settings', payload: { maxLines: 2 } });
      assert.equal(tooFew.statusCode, 409);
      assert.match(tooFew.json().message, /Já existem 3 linhas/);
      assert.equal((await server.inject({ method: 'PATCH', url: '/api/settings', payload: { maxLines: 3 } })).statusCode, 200);

      const bad = [
        { distribution: { cycleIntervalSeconds: [] } },
        { distribution: { cycleIntervalSeconds: [2, 2] } },
        { distribution: { minBatch: 6, maxBatch: 5 } },
        { defaultCountryCode: 'BR' },
      ];
      for (const payload of bad) {
        assert.equal((await server.inject({ method: 'PATCH', url: '/api/settings', payload })).statusCode, 400, JSON.stringify(payload));
      }
      const logs = await app.logs.list({ limit: 20 });
      assert.ok(logs.some((l) => l.message === 'Configuração alterada: maxLines'), 'alteração registrada');
    } finally {
      await server.close();
      await app.close();
    }
  });
});
