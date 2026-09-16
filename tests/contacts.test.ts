import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import { DomainError } from '../src/server/shared/errors.ts';
import { createTestApp, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Módulo 4: gerenciamento de contatos', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.app.close();
  });

  const isCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

  /** Registra manualmente um envio por uma linha e mensagem específicas (sem worker). */
  async function manualSend(campaignId: string, lineId: string, messageId: string, result: 'sent' | 'failed' = 'sent') {
    const message = await t.app.messages.get(messageId);
    const job = await t.app.queue.claimNext(campaignId, lineId);
    assert.ok(job, 'havia contato pendente');
    return t.app.history.recordAttempt({
      jobId: job.id,
      lineId,
      messageTemplateId: message.id,
      messageLabel: message.name,
      renderedBody: message.body,
      result,
      error: result === 'failed' ? 'Número inexistente' : null,
    });
  }

  // ------------------------------------------------------------------ inserção, edição, exclusão, duplicidade

  it('inserção: ID único, número normalizado e rastreamento zerado', async () => {
    const joao = await t.app.contacts.create({ name: 'João', phone: '(21) 99999-0001' });
    const maria = await t.app.contacts.create({ name: 'Maria', phone: '21 98888-0002' });

    assert.notEqual(joao.id, maria.id);
    assert.equal(joao.phone, '5521999990001');
    assert.equal(joao.status, 'active');
    assert.equal(joao.processingStatus, 'idle');
    assert.equal(joao.messagesReceived, 0);
    assert.equal(joao.lastMessageLabel, null);
    assert.equal(joao.lastLineId, null);
    assert.equal(joao.lastSentAt, null);
    await assert.rejects(t.app.contacts.create({ phone: '123' }), /Telefone inválido/);
  });

  it('duplicidade: o mesmo número nunca gera dois contatos', async () => {
    const joao = await t.app.contacts.create({ name: 'João', phone: '21999990001' });

    await assert.rejects(t.app.contacts.create({ name: 'Outro', phone: '+55 (21) 99999-0001' }), isCode('CONFLICT'));

    const imported = await t.app.contacts.import([
      { phone: '5521999990001', name: 'João Silva' }, // já existe => atualiza
      { phone: '21 97777-0003', name: 'Ana' },
      { phone: '(21) 97777-0003', name: 'Ana Souza' }, // repetido na própria lista
    ]);
    assert.equal(imported.created, 1);
    assert.equal(imported.updated, 1);
    assert.equal(imported.contactIds.includes(joao.id), true, 'importação reaproveita o mesmo ID');
    assert.equal(await t.app.contacts.count(), 2);
    assert.equal((await t.app.contacts.get(joao.id)).name, 'João Silva');

    const ana = (await t.app.contacts.list({ search: 'Ana' }))[0]!;
    await assert.rejects(t.app.contacts.update(ana.id, { phone: '21999990001' }), isCode('CONFLICT'), 'não pode assumir o número de outro');
  });

  it('edição: dados cadastrais mudam, rastreamento de envios não', async () => {
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    const message = await t.app.messages.saveSlot(1, { body: 'Oi' });
    const joao = await t.app.contacts.create({ name: 'João', phone: '21999990001' });
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds: [joao.id] });
    await manualSend(campaign.id, line.id, message.id);

    const edited = await t.app.contacts.update(joao.id, { name: 'João Pedro', phone: '21 99999-1111', variables: { cidade: 'Rio' } });
    assert.equal(edited.name, 'João Pedro');
    assert.equal(edited.phone, '5521999991111');
    assert.deepEqual(edited.variables, { cidade: 'Rio' });
    assert.equal(edited.messagesReceived, 1, 'rastreamento preservado');
    assert.equal(edited.lastLineId, line.id);
    assert.equal((await t.app.contacts.history(joao.id)).length, 1, 'histórico preservado');
  });

  it('exclusão: remove o contato e seu histórico; bloqueada durante envio em curso', async () => {
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    const message = await t.app.messages.saveSlot(1, { body: 'Oi' });
    const [a, b] = (await t.app.contacts.import([{ phone: '21999990001' }, { phone: '21999990002' }])).contactIds;
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds: [a!, b!] });
    await manualSend(campaign.id, line.id, message.id);

    await t.app.queue.claimNext(campaign.id, line.id); // envio "em curso" para b
    await assert.rejects(t.app.contacts.remove(b!), isCode('INVALID_STATE'));

    await t.app.contacts.remove(a!);
    await assert.rejects(t.app.contacts.get(a!), isCode('NOT_FOUND'));
    assert.equal((await t.app.history.list({ contactId: a! })).length, 0);
    assert.equal(await t.app.contacts.count(), 1);
    await assert.rejects(t.app.contacts.remove(a!), isCode('NOT_FOUND'));
  });

  // ------------------------------------------------------------------ status de processamento

  it('status do processamento acompanha a fila: idle → pending → processing → sent/failed', async () => {
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    const message = await t.app.messages.saveSlot(1, { body: 'Oi' });
    const ids = (await t.app.contacts.import([{ phone: '21999990001' }, { phone: '21999990002' }, { phone: '21999990003' }])).contactIds;
    const status = async (id: string) => (await t.app.contacts.get(id)).processingStatus;

    assert.equal(await status(ids[0]!), 'idle');
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds: ids });
    assert.deepEqual(await Promise.all(ids.map(status)), ['waiting', 'waiting', 'waiting']);

    const job = await t.app.queue.claimNext(campaign.id, line.id);
    assert.equal(await status(job!.contactId), 'processing');
    await t.app.queue.release(job!.id);
    assert.equal(await status(job!.contactId), 'waiting', 'devolvido à fila (processo em rascunho = aguardando)');

    await manualSend(campaign.id, line.id, message.id, 'sent');
    await manualSend(campaign.id, line.id, message.id, 'failed');
    assert.deepEqual(await Promise.all(ids.map(status)), ['sent', 'failed', 'waiting']);

    // Falha temporária: volta a pendente e registra o erro.
    const retry = await t.app.queue.claimNext(campaign.id, line.id);
    await t.app.history.recordAttempt({ jobId: retry!.id, lineId: line.id, messageTemplateId: message.id, renderedBody: 'Oi', result: 'failed', error: 'Timeout', requeue: true });
    const third = await t.app.contacts.get(ids[2]!);
    assert.equal(third.processingStatus, 'waiting');
    assert.equal(third.lastError, 'Timeout');

    // Cancelar o processo: quem estava só pendente volta a "idle"; resultados ficam.
    await t.app.campaigns.execute(campaign.id, 'cancel');
    assert.deepEqual(await Promise.all(ids.map(status)), ['sent', 'failed', 'idle']);

    const summary = await t.app.contacts.summary();
    assert.deepEqual(summary.byProcessing, { idle: 1, pending: 0, waiting: 0, processing: 0, sent: 1, failed: 1 });
    assert.deepEqual((await t.app.contacts.list({ processingStatus: 'sent' })).map((c) => c.id), [ids[0]]);
    assert.deepEqual((await t.app.contacts.list({ processingStatus: 'failed' })).map((c) => c.id), [ids[1]]);
  });

  it('quem recebeu, quem está pendente e quem teve erro, com processamento real por várias linhas', async () => {
    const lines = [];
    for (let i = 1; i <= 3; i++) {
      const line = await t.app.lines.create({ label: `Linha 0${i}`, provider: 'mock', settings: FAST });
      await t.app.lines.start(line.id);
      lines.push(line);
    }
    await t.app.lines.update(lines[2]!.id, {}); // sem mudança: linhas independentes
    for (let slot = 1; slot <= 3; slot++) await t.app.messages.saveSlot(slot, { body: `Texto ${slot} {{nome}}` });
    const ids = (await t.app.contacts.import(Array.from({ length: 30 }, (_, i) => ({ phone: `2199000${String(i).padStart(4, '0')}`, name: `C${i}` })))).contactIds;

    const campaign = await t.app.campaigns.create({ name: 'Real', lineIds: lines.map((l) => l.id), contactIds: ids });
    await t.app.campaigns.execute(campaign.id, 'start');
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 5000, 'conclusão');

    const contacts = await t.app.contacts.list({ limit: 100 });
    assert.equal(contacts.length, 30);
    for (const contact of contacts) {
      assert.equal(contact.processingStatus, 'sent');
      assert.equal(contact.messagesReceived, 1);
      assert.ok(contact.lastLineLabel?.startsWith('Linha 0'), 'sabe qual linha fez o último envio');
      assert.match(contact.lastMessageLabel ?? '', /^Mensagem 0[123]$/, 'sabe qual mensagem foi utilizada');
      assert.ok(contact.lastSentAt);
    }
    const perLine = new Set(contacts.map((c) => c.lastLineId));
    assert.ok(perLine.size > 1, 'envios distribuídos entre as linhas');
  });

  // ------------------------------------------------------------------ histórico individual

  it('histórico individual: João → Mensagem 02 / Linha 03 e depois Mensagem 05 / Linha 01', async () => {
    const l1 = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    await t.app.lines.create({ label: 'Linha 02', provider: 'mock', settings: FAST });
    const l3 = await t.app.lines.create({ label: 'Linha 03', provider: 'mock', settings: FAST });
    const m2 = await t.app.messages.saveSlot(2, { body: 'Promo {{nome}}' });
    const m5 = await t.app.messages.saveSlot(5, { body: 'Lembrete {{nome}}' });
    const { contactIds } = await t.app.contacts.import([{ phone: '21999990001', name: 'João' }, { phone: '21999990002', name: 'Maria' }]);
    const [joao, maria] = contactIds;

    const first = await t.app.campaigns.create({ name: 'Manhã', lineIds: [l3.id], contactIds: [joao!] });
    await manualSend(first.id, l3.id, m2.id);
    await t.app.campaigns.execute(first.id, 'cancel');

    const second = await t.app.campaigns.create({ name: 'Tarde', lineIds: [l1.id], contactIds: [joao!, maria!] });
    await manualSend(second.id, l1.id, m5.id); // João
    await manualSend(second.id, l1.id, m2.id, 'failed'); // Maria

    const history = await t.app.contacts.history(joao!);
    assert.deepEqual(
      history.map((h) => [h.messageLabel, h.lineLabel, h.campaignName, h.result]),
      [
        ['Mensagem 05', 'Linha 01', 'Tarde', 'sent'],
        ['Mensagem 02', 'Linha 03', 'Manhã', 'sent'],
      ],
    );
    assert.ok(history.every((h) => !Number.isNaN(Date.parse(h.createdAt))), 'cada envio tem data/hora');
    assert.ok(history[0]!.createdAt >= history[1]!.createdAt, 'mais recente primeiro');

    const joaoNow = await t.app.contacts.get(joao!);
    assert.equal(joaoNow.messagesReceived, 2);
    assert.equal(joaoNow.lastMessageLabel, 'Mensagem 05');
    assert.equal(joaoNow.lastLineLabel, 'Linha 01');

    const mariaHistory = await t.app.contacts.history(maria!);
    assert.deepEqual(mariaHistory.map((h) => [h.messageLabel, h.result, h.error]), [['Mensagem 02', 'failed', 'Número inexistente']]);
    const mariaNow = await t.app.contacts.get(maria!);
    assert.equal(mariaNow.messagesReceived, 0);
    assert.equal(mariaNow.processingStatus, 'failed');
    assert.equal(mariaNow.lastError, 'Número inexistente');
  });

  // ------------------------------------------------------------------ bloqueio

  it('contato bloqueado não entra na fila, sai da fila ao ser bloqueado e é pulado pelo worker', async () => {
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const [a, b, c] = (await t.app.contacts.import([{ phone: '21999990001' }, { phone: '21999990002' }, { phone: '21999990003' }])).contactIds;

    await t.app.contacts.update(a!, { status: 'blocked' });
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds: [a!, b!, c!] });
    assert.equal((await t.app.campaigns.summary(campaign.id)).counts.total, 2, 'bloqueado não entra');

    await t.app.contacts.update(b!, { status: 'blocked' });
    assert.equal((await t.app.contacts.get(b!)).processingStatus, 'idle', 'retirado da fila ao bloquear');

    await t.app.lines.start(line.id);
    await t.app.campaigns.execute(campaign.id, 'start');
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 5000, 'conclusão');
    const counts = (await t.app.campaigns.summary(campaign.id)).counts;
    assert.deepEqual({ sent: counts.sent, skipped: counts.skipped }, { sent: 1, skipped: 1 });
    assert.equal((await t.app.contacts.get(b!)).messagesReceived, 0);
    assert.equal((await t.app.contacts.get(c!)).messagesReceived, 1);
  });

  // ------------------------------------------------------------------ API

  it('API: criar, duplicidade, editar, filtrar, histórico e excluir', async () => {
    const server = await buildServer(t.app);
    try {
      const created = await server.inject({ method: 'POST', url: '/api/contacts', payload: { name: 'João', phone: '21 99999-0001' } });
      assert.equal(created.statusCode, 201);
      const { id } = created.json();

      const duplicate = await server.inject({ method: 'POST', url: '/api/contacts', payload: { phone: '5521999990001' } });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().details.contactId, id);

      const edited = await server.inject({ method: 'PATCH', url: `/api/contacts/${id}`, payload: { name: 'João S.' } });
      assert.equal(edited.json().name, 'João S.');

      const list = (await server.inject({ method: 'GET', url: '/api/contacts?processingStatus=idle&search=99999' })).json();
      assert.equal(list.total, 1);
      assert.equal(list.summary.byProcessing.idle, 1);
      assert.equal((await server.inject({ method: 'GET', url: '/api/contacts?processingStatus=xyz' })).statusCode, 400);

      const history = await server.inject({ method: 'GET', url: `/api/contacts/${id}/history` });
      assert.deepEqual(history.json(), { history: [] });

      assert.equal((await server.inject({ method: 'DELETE', url: `/api/contacts/${id}` })).statusCode, 204);
      assert.equal((await server.inject({ method: 'GET', url: `/api/contacts/${id}/history` })).statusCode, 404);
    } finally {
      await server.close();
    }
  });
});
