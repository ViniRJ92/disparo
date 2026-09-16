import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import { RandomMessageSelector } from '../src/server/modules/distribution/random-message.selector.ts';
import type { ContactService } from '../src/server/modules/contacts/contact.service.ts';
import type { MessageService } from '../src/server/modules/messages/message.service.ts';
import type { MessageTemplate } from '../src/server/modules/messages/message.types.ts';
import { createTestApp, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

/** Seletor isolado: mensagens ativas e "última mensagem por contato" em memória. */
function selectorWith(activeIds: string[], random: () => number = Math.random) {
  const active = activeIds.map((id, i) => ({ id, slot: i + 1, name: id, body: id, active: true }) as MessageTemplate);
  const last = new Map<string, string>();
  const messages = { listActive: async () => active } as unknown as MessageService;
  const contacts = { lastMessageId: async (contactId: string) => last.get(contactId) ?? null } as unknown as ContactService;
  const selector = new RandomMessageSelector(messages, contacts, random);
  /** Sorteia e registra como enviada (o que o histórico faz de verdade). */
  const draw = async (contactId: string) => {
    const message = await selector.select({ campaignId: 'c', contactId, lineId: 'l' });
    if (message) last.set(contactId, message.id);
    return message?.id ?? null;
  };
  return { draw, last };
}

const hasConsecutiveRepeat = (sequence: readonly (string | null)[]) => sequence.some((id, i) => i > 0 && id === sequence[i - 1]);

describe('Módulo 3: seleção aleatória de mensagens', () => {
  it('com 1 mensagem ativa, usa sempre ela sem erro', async () => {
    const { draw } = selectorWith(['m1']);
    const sequence = [await draw('joao'), await draw('joao'), await draw('joao')];
    assert.deepEqual(sequence, ['m1', 'm1', 'm1']);
  });

  it('com 2 mensagens ativas, alterna para o mesmo contato', async () => {
    const { draw } = selectorWith(['m1', 'm2']);
    const sequence = [];
    for (let i = 0; i < 50; i++) sequence.push(await draw('joao'));
    assert.equal(hasConsecutiveRepeat(sequence), false);
    assert.deepEqual(new Set(sequence), new Set(['m1', 'm2']));
  });

  it('com 5 mensagens ativas, nunca repete consecutivamente e usa todas', async () => {
    const { draw } = selectorWith(['m1', 'm2', 'm3', 'm4', 'm5']);
    const sequence = [];
    for (let i = 0; i < 500; i++) sequence.push(await draw('joao'));
    assert.equal(hasConsecutiveRepeat(sequence), false);

    const counts = new Map<string, number>();
    for (const id of sequence) counts.set(id!, (counts.get(id!) ?? 0) + 1);
    assert.equal(counts.size, 5);
    for (const [id, n] of counts) assert.ok(n > 60 && n < 140, `${id} sorteada ${n}x (esperado ~100): seleção aleatória equilibrada`);
  });

  it('a regra é por contato: a última mensagem de um não restringe o outro', async () => {
    // random = 0 escolhe sempre o primeiro candidato disponível.
    const { draw, last } = selectorWith(['m1', 'm2', 'm3'], () => 0);
    last.set('joao', 'm1');
    assert.equal(await draw('joao'), 'm2', 'João recebeu m1 por último, então m1 sai do sorteio');
    assert.equal(await draw('maria'), 'm1', 'Maria nunca recebeu nada: m1 continua disponível para ela');
  });

  it('é aleatória (sequências diferentes entre contatos)', async () => {
    const { draw } = selectorWith(['m1', 'm2', 'm3', 'm4', 'm5']);
    const sequences = new Set<string>();
    for (let c = 0; c < 10; c++) {
      const seq = [];
      for (let i = 0; i < 8; i++) seq.push(await draw(`contato-${c}`));
      sequences.add(seq.join(','));
    }
    assert.ok(sequences.size > 5, 'sequências praticamente nunca coincidem');
  });

  it('sem mensagem ativa, não seleciona nada', async () => {
    const { draw } = selectorWith([]);
    assert.equal(await draw('joao'), null);
  });
});

describe('Módulo 3: gerenciamento das mensagens e integração com envios', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  async function setup(contactCount = 1) {
    t = await createTestApp();
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    await t.app.lines.start(line.id);
    const contacts = await t.app.contacts.import(
      Array.from({ length: contactCount }, (_, i) => ({ phone: `55219${String(i).padStart(8, '0')}`, name: i === 0 ? 'João' : `C${i}` })),
    );
    return { line, contactIds: contacts.contactIds };
  }

  /** Executa um processo completo e devolve quando ele termina. */
  async function runProcess(name: string, lineId: string, contactIds: string[]) {
    const campaign = await t.app.campaigns.create({ name, lineIds: [lineId], contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 5000, `conclusão de ${name}`);
    return campaign;
  }

  it('5 posições: salvar, editar, excluir, ativar/desativar', async () => {
    await setup(0);
    const { messages } = t.app;

    const slots = await messages.slots();
    assert.deepEqual(slots.map((s) => [s.slot, s.message]), [[1, null], [2, null], [3, null], [4, null], [5, null]]);

    const m3 = await messages.saveSlot(3, { body: 'Olá {{nome}}' });
    assert.equal(m3.name, 'Mensagem 03');
    assert.equal(m3.active, true);

    const created = [];
    for (let i = 0; i < 4; i++) created.push(await messages.create({ body: `Texto ${i}` }));
    assert.deepEqual(created.map((m) => m.slot), [1, 2, 4, 5], 'ocupa as posições livres');
    await assert.rejects(messages.create({ body: 'sexta' }), /Limite de 5 mensagens/);
    await assert.rejects(messages.saveSlot(6, { body: 'x' }), /Posição inválida/);
    await assert.rejects(messages.saveSlot(1, { body: '   ' }), /Informe o texto/);

    const edited = await messages.saveSlot(3, { body: 'Oi {{nome}}, tudo bem?' });
    assert.equal(edited.id, m3.id, 'editar mantém a mesma mensagem');
    assert.equal(edited.body, 'Oi {{nome}}, tudo bem?');

    await messages.setActive(created[1]!.id, false); // Mensagem 02
    await messages.setActive(created[3]!.id, false); // Mensagem 05
    assert.deepEqual((await messages.listActive()).map((m) => m.slot), [1, 3, 4], 'somente 01, 03 e 04 participam');

    await messages.remove(m3.id);
    assert.equal((await messages.slots())[2]!.message, null, 'excluir libera a posição 03');
    assert.equal((await messages.create({ body: 'nova' })).slot, 3);
  });

  it('não permite iniciar processo sem mensagem ativa', async () => {
    const { line, contactIds } = await setup(1);
    const campaign = await t.app.campaigns.create({ name: 'Sem msg', lineIds: [line.id], contactIds });
    await assert.rejects(t.app.campaigns.execute(campaign.id, 'start'), /nenhuma mensagem ativa/);

    const message = await t.app.messages.saveSlot(1, { body: 'Oi', active: false });
    await assert.rejects(t.app.campaigns.execute(campaign.id, 'start'), /nenhuma mensagem ativa/, 'desativada não conta');

    await t.app.messages.setActive(message.id, true);
    assert.equal((await t.app.campaigns.execute(campaign.id, 'start')).status, 'running');
  });

  it('funciona normalmente com apenas 1 mensagem ativa (repetição permitida)', async () => {
    const { line, contactIds } = await setup(1);
    await t.app.messages.saveSlot(1, { body: 'Única' });
    await runProcess('P1', line.id, contactIds);
    await runProcess('P2', line.id, contactIds);

    const history = await t.app.history.list({ contactId: contactIds[0]! });
    assert.deepEqual(history.map((h) => h.messageLabel), ['Mensagem 01', 'Mensagem 01']);
  });

  it('o mesmo contato nunca recebe a mesma mensagem duas vezes seguidas (processos sucessivos)', async () => {
    const { line, contactIds } = await setup(1);
    for (let slot = 1; slot <= 5; slot++) await t.app.messages.saveSlot(slot, { body: `Texto ${slot}` });
    await t.app.messages.setActive((await t.app.messages.slots())[2]!.message!.id, false); // desativa 03

    for (let i = 1; i <= 12; i++) await runProcess(`P${i}`, line.id, contactIds);

    const sequence = (await t.app.history.list({ contactId: contactIds[0]! })).reverse().map((h) => h.messageLabel);
    assert.equal(sequence.length, 12);
    assert.equal(hasConsecutiveRepeat(sequence), false, sequence.join(' → '));
    assert.ok(!sequence.includes('Mensagem 03'), 'mensagem desativada nunca é usada');
  });

  it('edição vale para os próximos envios; histórico guarda o texto realmente enviado', async () => {
    const { line, contactIds } = await setup(1);
    const message = await t.app.messages.saveSlot(1, { body: 'Olá {{nome}}, versão 1' });
    await runProcess('Antes', line.id, contactIds);

    await t.app.messages.update(message.id, { body: 'Olá {{nome}}, versão 2' });
    await runProcess('Depois', line.id, contactIds);

    const [latest, earliest] = await t.app.history.list({ contactId: contactIds[0]! });
    assert.equal(earliest!.renderedBody, 'Olá João, versão 1', 'histórico antigo não muda');
    assert.equal(latest!.renderedBody, 'Olá João, versão 2', 'novo envio usa a edição');
  });

  it('excluir ou renomear a mensagem não altera o histórico', async () => {
    const { line, contactIds } = await setup(1);
    const message = await t.app.messages.saveSlot(2, { body: 'Promoção {{nome}}' });
    await runProcess('P', line.id, contactIds);

    await t.app.messages.update(message.id, { name: 'Outro nome' });
    let [entry] = await t.app.history.list({ contactId: contactIds[0]! });
    assert.equal(entry!.messageLabel, 'Mensagem 02');

    await t.app.messages.remove(message.id);
    [entry] = await t.app.history.list({ contactId: contactIds[0]! });
    assert.equal(entry!.messageLabel, 'Mensagem 02');
    assert.equal(entry!.renderedBody, 'Promoção João');
    assert.equal(entry!.messageTemplateId, null);
  });

  it('desativar todas durante o processo segura os contatos na fila; reativar continua', async () => {
    t = await createTestApp({ dispatch: { idlePollMs: 60_000 } });
    const line = await t.app.lines.create({ label: 'Linha 01', provider: 'mock', settings: FAST });
    await t.app.lines.start(line.id);
    const { contactIds } = await t.app.contacts.import(Array.from({ length: 5 }, (_, i) => ({ phone: `5521988880${i}00` })));
    const message = await t.app.messages.saveSlot(1, { body: 'Oi' });
    await t.app.messages.setActive(message.id, true);
    const campaign = await t.app.campaigns.create({ name: 'P', lineIds: [line.id], contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');
    await t.app.messages.setActive(message.id, false);

    await waitFor(() => t.app.dispatch.snapshot(line.id)?.state === 'no_message' || t.app.dispatch.snapshot(line.id)?.state === 'no_contacts', 3000, 'worker parado sem mensagem');
    const held = await t.app.campaigns.summary(campaign.id);
    assert.equal(held.counts.processing, 0, 'nenhum contato preso em processamento');

    // Com idlePollMs alto, só o evento de reativação pode acordar o worker a tempo.
    await t.app.messages.setActive(message.id, true);
    await waitFor(async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed', 1500, 'conclusão');
    assert.equal((await t.app.campaigns.summary(campaign.id)).counts.sent, 5);
  });

  it('API: posições, salvar, ativar/desativar e excluir', async () => {
    await setup(0);
    const server = await buildServer(t.app);
    try {
      const saved = await server.inject({ method: 'PUT', url: '/api/messages/slots/4', payload: { body: 'Mensagem quatro' } });
      assert.equal(saved.statusCode, 200);
      const { id } = saved.json();

      let list = (await server.inject({ method: 'GET', url: '/api/messages' })).json();
      assert.equal(list.slots.length, 5);
      assert.equal(list.slots[3].message.id, id);
      assert.equal(list.activeCount, 1);

      await server.inject({ method: 'POST', url: `/api/messages/${id}/deactivate` });
      list = (await server.inject({ method: 'GET', url: '/api/messages' })).json();
      assert.equal(list.activeCount, 0);

      assert.equal((await server.inject({ method: 'PUT', url: '/api/messages/slots/9', payload: { body: 'x' } })).statusCode, 400);
      assert.equal((await server.inject({ method: 'DELETE', url: `/api/messages/${id}` })).statusCode, 204);
    } finally {
      await server.close();
    }
  });
});
