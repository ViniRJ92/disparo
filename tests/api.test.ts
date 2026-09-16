import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server/api/server.ts';
import { createTestApp, type TestApp } from './helpers.ts';

describe('API HTTP', () => {
  let t: TestApp;
  let server: FastifyInstance;

  before(async () => {
    t = await createTestApp();
    server = await buildServer(t.app);
  });
  after(async () => {
    await server.close();
    await t.app.close();
  });

  it('cadastra linhas e executa comandos individuais', async () => {
    const created = await server.inject({ method: 'POST', url: '/api/lines', payload: { label: 'Linha API' } });
    assert.equal(created.statusCode, 201);
    const { id } = created.json();

    const started = await server.inject({ method: 'POST', url: `/api/lines/${id}/start` });
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().available, true);

    const paused = await server.inject({ method: 'POST', url: `/api/lines/${id}/pause` });
    assert.equal(paused.json().runState, 'paused');

    const invalid = await server.inject({ method: 'POST', url: `/api/lines/${id}/pause` });
    assert.equal(invalid.statusCode, 409);
    assert.equal(invalid.json().error, 'INVALID_STATE');

    const list = await server.inject({ method: 'GET', url: '/api/lines' });
    assert.equal(list.json().summary.paused, 1);
  });

  it('traduz erros de domínio em status HTTP', async () => {
    assert.equal((await server.inject({ method: 'GET', url: '/api/lines/nao-existe' })).statusCode, 404);
    assert.equal((await server.inject({ method: 'POST', url: '/api/lines', payload: {} })).statusCode, 400);
    assert.equal(
      (await server.inject({ method: 'POST', url: '/api/lines', payload: { label: 'X', settings: { dailyLimit: 0 } } })).statusCode,
      400,
    );
  });

  it('fluxo de campanha via API', async () => {
    const line = (await server.inject({ method: 'POST', url: '/api/lines', payload: { label: 'L' } })).json();
    const contacts = (
      await server.inject({ method: 'POST', url: '/api/contacts/import', payload: { contacts: [{ phone: '21 98888-7777' }] } })
    ).json();
    const message = (await server.inject({ method: 'POST', url: '/api/messages', payload: { name: 'M', body: 'oi' } })).json();

    const campaign = await server.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: { name: 'API', lineIds: [line.id], messageTemplateIds: [message.id], contactIds: contacts.contactIds },
    });
    assert.equal(campaign.statusCode, 201);
    const { id } = campaign.json();

    const started = await server.inject({ method: 'POST', url: `/api/campaigns/${id}/start` });
    assert.equal(started.json().status, 'running');

    const overview = (await server.inject({ method: 'GET', url: '/api/overview' })).json();
    assert.equal(overview.campaigns.running, 1);
    assert.equal(overview.totals.pending, 1);

    const jobs = (await server.inject({ method: 'GET', url: `/api/campaigns/${id}/jobs?status=pending` })).json();
    assert.equal(jobs.jobs.length, 1);
    assert.equal((await server.inject({ method: 'GET', url: '/api/history' })).statusCode, 200);
    assert.equal((await server.inject({ method: 'GET', url: '/api/logs?limit=5' })).json().logs.length, 5);
  });

  it('atualiza configurações globais com validação', async () => {
    const ok = await server.inject({ method: 'PATCH', url: '/api/settings', payload: { maxLines: 5 } });
    assert.equal(ok.json().maxLines, 5);
    const bad = await server.inject({ method: 'PATCH', url: '/api/settings', payload: { maxLines: 11 } });
    assert.equal(bad.statusCode, 400);
  });
});
