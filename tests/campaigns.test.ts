import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { renderMessage } from '../src/server/modules/messages/message.renderer.ts';
import { normalizePhone } from '../src/server/modules/contacts/phone.ts';
import { createTestApp, flush, type TestApp } from './helpers.ts';

describe('Contatos e mensagens', () => {
  it('normaliza telefones', () => {
    assert.equal(normalizePhone('(21) 99999-8888', '55'), '5521999998888');
    assert.equal(normalizePhone('+55 21 99999-8888', '55'), '5521999998888');
    assert.equal(normalizePhone('0055 21 3333-4444', '55'), '552133334444');
    assert.equal(normalizePhone('123', '55'), null);
  });

  it('renderiza variáveis do contato', () => {
    const text = renderMessage('Olá {{nome}}, seu código é {{ codigo }}{{inexistente}}.', {
      name: 'Ana',
      phone: '5521999998888',
      variables: { codigo: 'X1' },
    });
    assert.equal(text, 'Olá Ana, seu código é X1.');
  });
});

describe('Campanhas (controle global), fila e histórico', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.app.close();
  });

  async function seed(lineCount = 3, contactCount = 5) {
    const lines = [];
    for (let i = 0; i < lineCount; i++) lines.push(await t.app.lines.create({ label: `Linha ${i + 1}`, provider: 'mock' }));
    const imported = await t.app.contacts.import(
      Array.from({ length: contactCount }, (_, i) => ({ phone: `21 9${String(i).padStart(4, '0')}-0000`, name: `C${i}` })),
    );
    const message = await t.app.messages.create({ name: 'Boas-vindas', body: 'Olá {{nome}}' });
    return { lines, contactIds: imported.contactIds, message };
  }

  it('importa contatos removendo duplicados e inválidos', async () => {
    const result = await t.app.contacts.import([
      { phone: '21 99999-0001', name: 'A' },
      { phone: '(21) 99999-0001', name: 'A2' },
      { phone: 'abc' },
    ]);
    assert.equal(result.created, 1);
    assert.equal(result.invalid.length, 1);
    const again = await t.app.contacts.import([{ phone: '5521999990001' }]);
    assert.equal(again.updated, 1);
    assert.equal(await t.app.contacts.count(), 1);
  });

  it('cria campanha com linhas selecionadas e totais globais', async () => {
    const { lines, contactIds, message } = await seed(4, 5);
    const selected = [lines[0]!.id, lines[2]!.id];

    const campaign = await t.app.campaigns.create({
      name: 'Teste',
      lineIds: selected,
      contactIds,
    });

    assert.equal(campaign.status, 'draft');
    assert.deepEqual(new Set(campaign.lineIds), new Set(selected));
    assert.equal(campaign.lines.length, 2);
    assert.equal(campaign.counts.total, 5);
    assert.equal(campaign.counts.pending, 5);
    assert.equal(campaign.availableLineCount, 0, 'linhas ainda não iniciadas');

    await t.app.lines.start(lines[0]!.id);
    assert.equal((await t.app.campaigns.detail(campaign.id)).availableLineCount, 1);
  });

  it('valida linhas, mensagens e contatos inexistentes', async () => {
    const { message } = await seed(1, 1);
    await assert.rejects(t.app.campaigns.create({ name: 'X', lineIds: ['nope'] }), /Linhas inexistentes/);
    await assert.rejects(
      t.app.campaigns.create({ name: 'X', lineIds: [], contactIds: ['nope'] }),
      /Contatos inexistentes/,
    );
  });

  it('ciclo de status do processo sem alterar o estado das linhas', async () => {
    const { lines, contactIds, message } = await seed(2, 2);
    await t.app.lines.start(lines[0]!.id);
    const draft = await t.app.campaigns.create({ name: 'C', lineIds: [lines[0]!.id] });

    await assert.rejects(t.app.campaigns.execute(draft.id, 'start'), /Adicione contatos/);
    await t.app.campaigns.addContacts(draft.id, contactIds);

    assert.equal((await t.app.campaigns.execute(draft.id, 'start')).status, 'running');
    assert.equal((await t.app.campaigns.execute(draft.id, 'pause')).status, 'paused');
    assert.equal((await t.app.lines.status(lines[0]!.id)).runState, 'active', 'pausar campanha não pausa linha');
    await assert.rejects(t.app.campaigns.execute(draft.id, 'pause'), /Não é possível pausar/);
    assert.equal((await t.app.campaigns.execute(draft.id, 'resume')).status, 'running');
    const cancelled = await t.app.campaigns.execute(draft.id, 'cancel');
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.finishedAt);
    await assert.rejects(t.app.campaigns.setLines(draft.id, []), /não pode ser alterada/);
  });

  it('fluxo manual fila -> envio -> histórico mantém tudo consistente', async () => {
    const { lines, contactIds, message } = await seed(2, 3);
    const [l1, l2] = lines;
    await t.app.lines.start(l1!.id);
    await t.app.lines.start(l2!.id);
    const campaign = await t.app.campaigns.create({
      name: 'Fluxo',
      lineIds: [l1!.id, l2!.id],
      contactIds,
    });

    // Processo em rascunho: os workers não atuam, então o fluxo é exercitado manualmente.
    const job1 = await t.app.queue.claimNext(campaign.id, l1!.id);
    assert.ok(job1);
    assert.equal(job1.lineId, l1!.id);
    const result = await t.app.lines.send(l1!.id, { to: '5521900000000', body: 'Olá' });
    assert.equal(result.ok, true);
    await t.app.history.recordAttempt({
      jobId: job1.id,
      lineId: l1!.id,
      messageTemplateId: message.id,
      renderedBody: 'Olá C0',
      result: 'sent',
      providerMessageId: result.ok ? result.providerMessageId : null,
    });

    const job2 = await t.app.queue.claimNext(campaign.id, l2!.id);
    await t.app.history.recordAttempt({
      jobId: job2!.id,
      lineId: l2!.id,
      messageTemplateId: message.id,
      renderedBody: 'Olá C1',
      result: 'failed',
      error: 'Número inexistente',
    });

    const job3 = await t.app.queue.claimNext(campaign.id, l2!.id);
    await t.app.history.recordAttempt({
      jobId: job3!.id,
      lineId: l2!.id,
      messageTemplateId: message.id,
      renderedBody: 'Olá C2',
      result: 'failed',
      error: 'Timeout',
      requeue: true,
    });
    await flush();

    const detail = await t.app.campaigns.detail(campaign.id);
    assert.deepEqual(
      { total: detail.counts.total, sent: detail.counts.sent, failed: detail.counts.failed, pending: detail.counts.pending, processed: detail.counts.processed },
      { total: 3, sent: 1, failed: 1, pending: 1, processed: 2 },
    );

    const line1 = await t.app.lines.status(l1!.id);
    const line2 = await t.app.lines.status(l2!.id);
    assert.deepEqual(line1.counters, { contactsProcessed: 1, messagesSent: 1, failures: 0 });
    assert.deepEqual(line2.counters, { contactsProcessed: 1, messagesSent: 0, failures: 2 });

    const history = await t.app.history.list({ campaignId: campaign.id });
    assert.equal(history.length, 3);
    const sent = history.find((h) => h.result === 'sent')!;
    assert.equal(sent.lineLabel, 'Linha 1');
    assert.equal(sent.messageLabel, 'Boas-vindas');
    assert.equal(sent.campaignName, 'Fluxo');
    assert.equal(sent.renderedBody, 'Olá C0');
    assert.ok(sent.providerMessageId);
    assert.equal((await t.app.history.list({ lineId: l2!.id, result: 'failed' })).length, 2);

    await assert.rejects(
      t.app.history.recordAttempt({ jobId: job1.id, lineId: l1!.id, messageTemplateId: null, renderedBody: null, result: 'sent' }),
      /já foi finalizado/,
    );
  });

  it('visão global agrega linhas, campanhas e totais', async () => {
    const { lines, contactIds, message } = await seed(3, 4);
    await t.app.lines.start(lines[0]!.id);
    await t.app.lines.start(lines[1]!.id);
    await t.app.lines.pause(lines[1]!.id);
    const campaign = await t.app.campaigns.create({ name: 'G', lineIds: [lines[0]!.id], contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');

    const overview = await t.app.stats.overview();
    assert.equal(overview.lines.total, 3);
    assert.equal(overview.lines.connected, 2);
    assert.equal(overview.lines.active, 1);
    assert.equal(overview.lines.paused, 1);
    assert.equal(overview.contacts.total, 4);
    assert.equal(overview.campaigns.running, 1);
    assert.equal(overview.totals.total, 4);
    assert.equal(overview.totals.pending + overview.totals.processing + overview.totals.sent, 4);
    assert.deepEqual(overview.activeCampaigns[0]?.lineIds, [lines[0]!.id]);
  });
});
