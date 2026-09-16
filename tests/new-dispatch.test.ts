import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import { createTestApp, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Novo disparo: público resolvido no servidor e início imediato', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  async function setup() {
    t = await createTestApp();
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    await t.app.lines.start(line.id);
    const { contactIds } = await t.app.contacts.import(
      Array.from({ length: 6 }, (_, i) => ({ phone: `2199999000${i}`, name: `C${i}` })),
    );
    await t.app.contacts.update(contactIds[5]!, { status: 'blocked' });
    return { line, contactIds };
  }

  it('públicos: todos os ativos e somente quem nunca recebeu (bloqueados nunca entram)', async () => {
    const { line, contactIds } = await setup();
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    assert.equal((await t.app.contacts.idsForAudience('all_active')).length, 5);

    const first = await t.app.campaigns.create({ name: 'Primeiro', lineIds: [line.id], contactIds: contactIds.slice(0, 2), start: true });
    await waitFor(async () => (await t.app.campaigns.summary(first.id)).status === 'completed', 3000, 'primeiro disparo');

    assert.deepEqual(
      new Set(await t.app.contacts.idsForAudience('never_received')),
      new Set(contactIds.slice(2, 5)),
      'quem já recebeu e o bloqueado ficam de fora',
    );
    const second = await t.app.campaigns.create({ name: 'Novos', lineIds: [line.id], audience: 'never_received' });
    assert.equal(second.counts.total, 3);
    const everyone = await t.app.campaigns.create({ name: 'Todos', lineIds: [line.id], audience: 'all_active' });
    assert.equal(everyone.counts.total, 5);
  });

  it('criar e iniciar: sem mensagem ativa, fica salvo como rascunho e informa o motivo', async () => {
    const { line } = await setup();
    await assert.rejects(
      t.app.campaigns.create({ name: 'Sem mensagem', lineIds: [line.id], audience: 'all_active', start: true }),
      /rascunho.*nenhuma mensagem ativa/,
    );
    const drafts = await t.app.campaigns.list();
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.status, 'draft');

    await t.app.messages.saveSlot(1, { body: 'Oi {{nome}}' });
    const started = await t.app.campaigns.create({ name: 'Com mensagem', lineIds: [line.id], audience: 'all_active', start: true });
    assert.equal(started.status, 'running');
  });

  it('API: tamanho do público e criação com início', async () => {
    const { line } = await setup();
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const server = await buildServer(t.app);
    try {
      assert.deepEqual((await server.inject({ method: 'GET', url: '/api/contacts/audience?audience=never_received' })).json(), {
        audience: 'never_received',
        count: 5,
      });
      const created = await server.inject({
        method: 'POST',
        url: '/api/campaigns',
        payload: { name: 'API', lineIds: [line.id], audience: 'never_received', start: true },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().status, 'running');
      assert.equal((await server.inject({ method: 'POST', url: '/api/campaigns', payload: { name: 'X', audience: 'nope' } })).statusCode, 400);
    } finally {
      await server.close();
    }
  });
});
