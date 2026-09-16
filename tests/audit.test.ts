import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { parseChatId } from '../src/server/modules/conversations/chat-id.ts';
import type { LineView } from '../src/server/modules/lines/line.types.ts';
import { createTestApp, sleep, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Auditoria: inconsistências encontradas', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
    t = undefined as unknown as TestApp;
  });

  async function oneLine(providerConfig: Record<string, unknown> = {}): Promise<LineView> {
    const line = await t.app.lines.create({ label: 'Linha 1', provider: 'mock', providerConfig, settings: FAST });
    await t.app.lines.start(line.id);
    return line;
  }

  it('Analytics: a mesma pessoa com e sem o nono dígito (BR) é UMA pessoa em todas as instâncias', async () => {
    t = await createTestApp();
    const l1 = await oneLine();
    const l2 = await t.app.lines.create({ label: 'Linha 2', provider: 'mock', settings: FAST });
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    // Cadastro com 9 dígitos; o WhatsApp identifica a conversa sem o nono dígito.
    const { contactIds } = await t.app.contacts.import([{ phone: '21 99876-5432', name: 'Carla' }]);
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [l1.id], contactIds, start: true });
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 3000, 'envio');

    t.mocks.get(l2.id)!.simulateMessage({ providerMessageId: 'x1', chatId: '552198765432@c.us', fromMe: false, body: 'recebi', timestamp: Date.now() + 1000 });
    await waitFor(() => t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversation_messages')!.n === 1, 2000, 'gravação');

    const { people } = t.app.analytics.people();
    assert.equal(people.length, 1, JSON.stringify(people.map((p) => [p.personKey, p.category])));
    assert.equal(people[0]!.category, 'replied');
    assert.deepEqual(people[0]!.lines, ['Linha 1', 'Linha 2']);
    assert.equal(t.app.conversations.list()[0]!.contactId, contactIds[0], 'mensagem ligada ao contato cadastrado');
    assert.equal(t.app.analytics.personTimeline(people[0]!.personKey).length, 2, 'linha do tempo junta disparo e conversa');
    // Telefone fixo (8 dígitos começando com 2 a 5) não recebe o nono dígito.
    assert.equal(parseChatId('552133334444@c.us', '55').phone, '552133334444');
  });

  it('Analytics: canal (newsletter) não é pessoa; grupo continua fora; individual continua dentro', () => {
    assert.equal(parseChatId('120363000000000001@newsletter', '55').type, 'broadcast');
    assert.equal(parseChatId('1203@g.us', '55').type, 'group');
    assert.equal(parseChatId('5521998765432@c.us', '55').type, 'individual');
  });

  it('disparo conclui quando os últimos contatos pendentes são bloqueados (não fica "em andamento" para sempre)', async () => {
    t = await createTestApp();
    const line = await oneLine({ sendDelayMs: 30 });
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const { contactIds } = await t.app.contacts.import([{ phone: '21999990001' }, { phone: '21999990002' }, { phone: '21999990003' }]);
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds, start: true });
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).counts.sent === 1, 3000, 'primeiro envio');
    await t.app.lines.pause(line.id);
    await sleep(60);
    for (const id of contactIds) {
      const contact = await t.app.contacts.get(id);
      if (contact.messagesReceived === 0) await t.app.contacts.update(id, { status: 'blocked' });
    }
    await t.app.lines.resume(line.id);
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 2000, 'processo concluído');
  });

  it('linha removida durante um envio em curso: o envio feito continua registrado no histórico', async () => {
    t = await createTestApp();
    const line = await oneLine({ sendDelayMs: 150 });
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const { contactIds } = await t.app.contacts.import([{ phone: '21999990001' }]);
    // Envio real que já saiu, mas cujo registro acontece depois de a linha ser removida.
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds });
    const job = await t.app.queue.claimNext(campaign.id, line.id);
    t.app.db.run('DELETE FROM lines WHERE id = :id', { id: line.id });
    await t.app.history.recordAttempt({ jobId: job!.id, lineId: line.id, lineLabel: 'Linha 1', messageTemplateId: null, messageLabel: 'Mensagem 01', renderedBody: 'Oi', result: 'sent' });
    const [entry] = await t.app.history.list({ contactId: contactIds[0]! });
    assert.equal(entry!.result, 'sent');
    assert.equal(entry!.lineLabelAtSend, 'Linha 1', 'nome da linha preservado');
  });

  it('mensagem excluída durante um envio em curso: o envio continua registrado com o texto e o rótulo', async () => {
    t = await createTestApp();
    const line = await oneLine();
    const message = await t.app.messages.saveSlot(2, { body: 'Promo' });
    const { contactIds } = await t.app.contacts.import([{ phone: '21999990001' }]);
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds });
    const job = await t.app.queue.claimNext(campaign.id, line.id);
    await t.app.messages.remove(message.id);
    await t.app.history.recordAttempt({ jobId: job!.id, lineId: line.id, messageTemplateId: message.id, messageLabel: 'Mensagem 02', renderedBody: 'Promo', result: 'sent' });
    const [entry] = await t.app.history.list({ contactId: contactIds[0]! });
    assert.deepEqual([entry!.messageLabel, entry!.renderedBody, entry!.messageTemplateId], ['Mensagem 02', 'Promo', null]);
  });

  it('não é possível remover um disparo encerrado enquanto ainda há envio em curso (o registro se perderia)', async () => {
    t = await createTestApp();
    const line = await oneLine();
    const { contactIds } = await t.app.contacts.import([{ phone: '21999990001' }]);
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds });
    await t.app.queue.claimNext(campaign.id, line.id);
    await t.app.campaigns.execute(campaign.id, 'cancel');
    await assert.rejects(t.app.campaigns.remove(campaign.id), /envio em curso/);
  });

  it('CSV sem cabeçalho: a prévia informa quantas colunas o arquivo tem (para mapear qualquer coluna)', async () => {
    t = await createTestApp();
    const preview = await t.app.contactCsv.preview('Rio;Ana;21999990001\nNiterói;Bia;21999990002');
    assert.equal(preview.columnCount, 3);
  });
});
