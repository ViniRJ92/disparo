import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import type { AnalyticsPerson } from '../src/server/modules/analytics/analytics.service.ts';
import { parseChatId } from '../src/server/modules/conversations/chat-id.ts';
import type { LineView } from '../src/server/modules/lines/line.types.ts';
import type { ProviderChatMessage } from '../src/server/modules/providers/provider.types.ts';
import { createTestApp, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

const PHONE = {
  A: '5521911110001', // fala só na Linha 1 (e também posta num grupo)
  B: '5521911110002', // fala só na Linha 2
  C: '5521911110003', // recebe pela Linha 1 e responde pela Linha 2
  D: '5521911110004', // fala nas Linhas 1, 2 e 3 (várias mensagens)
  E: '5521911110005', // aparece só em grupo
  F: '5521911110006', // recebe e não responde
};

describe('Módulo 8: Analytics com conversas de todas as linhas', () => {
  let t: TestApp;
  let L1: LineView;
  let L2: LineView;
  let L3: LineView;
  let campaignId: string;
  let tableCountsBefore: Record<string, number>;
  let base: number;
  let seq = 0;

  /** Simula uma mensagem chegando pelo provedor da linha (mesmo caminho do provedor real). */
  function chat(line: LineView, message: Omit<ProviderChatMessage, 'providerMessageId' | 'timestamp'> & { id?: string; offsetMs?: number }) {
    const { id, offsetMs, ...rest } = message;
    t.mocks.get(line.id)!.simulateMessage({ providerMessageId: id ?? `msg-${++seq}`, timestamp: base + (offsetMs ?? seq * 10), ...rest });
  }

  const countRows = () =>
    Object.fromEntries(
      ['send_attempts', 'send_jobs', 'conversation_messages', 'contacts'].map((table) => [
        table,
        t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n,
      ]),
    );

  const personByPhone = (people: AnalyticsPerson[], phone: string) => people.find((p) => p.phone === phone);

  before(async () => {
    t = await createTestApp();
    L1 = await t.app.lines.create({ label: 'Linha 1', provider: 'mock', settings: FAST });
    L2 = await t.app.lines.create({ label: 'Linha 2', provider: 'mock', settings: FAST });
    L3 = await t.app.lines.create({ label: 'Linha 3', provider: 'mock', settings: FAST });
    for (const line of [L1, L2, L3]) await t.app.lines.start(line.id);
    await t.app.messages.saveSlot(1, { body: 'Olá {{nome}}' });

    // Disparo real pela Linha 1 para C e F.
    const { contactIds } = await t.app.contacts.import([
      { phone: PHONE.C, name: 'Carla' },
      { phone: PHONE.F, name: 'Fabio' },
    ]);
    const campaign = await t.app.campaigns.create({ name: 'Setembro', lineIds: [L1.id], contactIds, start: true });
    campaignId = campaign.id;
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).status === 'completed', 5000, 'disparo');
    base = Date.now() + 1000; // conversas acontecem depois dos envios

    // 1. Pessoa que fala na Linha 1
    chat(L1, { chatId: `${PHONE.A}@c.us`, fromMe: false, body: 'Oi, sou a Ana', senderName: 'Ana' });
    // 2. Pessoa que fala na Linha 2
    chat(L2, { chatId: `${PHONE.B}@s.whatsapp.net`, fromMe: false, body: 'Olá', senderName: 'Bruno' });
    // 3. Pessoa que fala nas duas (recebeu pela 1, responde pela 2)
    chat(L2, { chatId: `${PHONE.C}@c.us`, fromMe: false, body: 'Recebi, obrigada!' });
    // 4. Pessoa que fala em várias instâncias, com várias mensagens (7. histórico)
    chat(L1, { chatId: `${PHONE.D}@c.us`, fromMe: false, body: 'D na linha 1', senderName: 'Diego' });
    chat(L2, { chatId: `${PHONE.D}@c.us`, fromMe: false, body: 'D na linha 2' });
    chat(L3, { chatId: `${PHONE.D}@c.us`, fromMe: false, body: 'D na linha 3', id: 'dup-1' });
    chat(L3, { chatId: `${PHONE.D}@c.us`, fromMe: false, body: 'D na linha 3 (repetida pelo provedor)', id: 'dup-1' });
    chat(L3, { chatId: `${PHONE.D}@c.us`, fromMe: true, body: 'Resposta manual da linha 3' });
    chat(L3, { chatId: `${PHONE.D}@c.us`, fromMe: false, body: 'Obrigado' });
    // 5. Grupos: A e E escrevem em grupos (fora da classificação individual)
    chat(L1, { chatId: '120363000000001@g.us', chatName: 'Grupo Bairro', senderId: `${PHONE.A}@c.us`, fromMe: false, body: 'msg no grupo' });
    chat(L2, { chatId: '120363000000002@g.us', chatName: 'Grupo Escola', senderId: `${PHONE.E}@c.us`, fromMe: false, body: 'só em grupo' });
    chat(L2, { chatId: 'grupo-sem-sufixo', isGroup: true, chatName: 'Grupo sinalizado', senderId: PHONE.E, fromMe: false, body: 'outro grupo' });
    // 6. Conversa individual sem número (identificação @lid)
    chat(L3, { chatId: '987654321@lid', fromMe: false, body: 'contato sem número', senderName: 'Gabi' });

    await waitFor(() => t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversation_messages')!.n === 12, 2000, 'mensagens gravadas');
    tableCountsBefore = countRows();
  });

  after(async () => {
    await t.app.close();
  });

  it('identifica conversa individual, sem número (@lid) e grupo', () => {
    assert.deepEqual(parseChatId(`${PHONE.A}@c.us`, '55'), { type: 'individual', phone: PHONE.A, personKey: PHONE.A });
    assert.deepEqual(parseChatId('21911110001@s.whatsapp.net', '55'), { type: 'individual', phone: PHONE.A, personKey: PHONE.A });
    assert.deepEqual(parseChatId('987654321@lid', '55'), { type: 'individual', phone: null, personKey: 'lid:987654321' });
    assert.deepEqual(parseChatId('1203@g.us', '55'), { type: 'group', phone: null, personKey: null });
    assert.deepEqual(parseChatId('qualquer', '55', true), { type: 'group', phone: null, personKey: null });
    assert.equal(parseChatId('status@broadcast', '55').type, 'broadcast');
  });

  it('registro: cada mensagem gravada uma única vez, com linha, conversa e tipo', () => {
    const d3 = t.app.conversations.list({ personKey: PHONE.D, lineId: L3.id });
    assert.deepEqual(d3.map((m) => [m.direction, m.body]), [
      ['inbound', 'D na linha 3'],
      ['outbound', 'Resposta manual da linha 3'],
      ['inbound', 'Obrigado'],
    ], 'mensagem repetida pelo provedor (mesmo id) não duplica');
    const groupRows = t.app.db.all<{ chat_type: string }>("SELECT chat_type FROM conversation_messages WHERE chat_type = 'group'");
    assert.equal(groupRows.length, 3, 'grupos ficam registrados (marcados como grupo)');
    const carla = t.app.conversations.list({ personKey: PHONE.C })[0]!;
    assert.ok(carla.contactId, 'mensagem ligada ao contato cadastrado');
    assert.equal(carla.lineLabel, 'Linha 2');
  });

  it('classificação: todas as pessoas de todas as linhas; grupos fora; ninguém perdido por estar em outra linha', () => {
    const overview = t.app.analytics.overview();
    assert.deepEqual(
      { people: overview.classification.people, replied: overview.classification.replied, initiated: overview.classification.initiated, noReply: overview.classification.noReply },
      { people: 6, replied: 1, initiated: 4, noReply: 1 },
    );
    const { people } = t.app.analytics.people();
    const cat = (phone: string) => personByPhone(people, phone)?.category;
    assert.equal(cat(PHONE.A), 'initiated', '1. fala na Linha 1');
    assert.equal(cat(PHONE.B), 'initiated', '2. fala na Linha 2');
    assert.equal(cat(PHONE.C), 'replied', '3. recebeu pela Linha 1 e respondeu pela Linha 2: resposta consolidada');
    assert.equal(cat(PHONE.D), 'initiated', '4. várias instâncias');
    assert.equal(cat(PHONE.F), 'no_reply');
    assert.equal(personByPhone(people, PHONE.E), undefined, '5. quem só aparece em grupo não entra na classificação individual');
    assert.equal(people.find((p) => p.personKey === 'lid:987654321')?.category, 'initiated', '6. conversa individual sem número');

    const d = personByPhone(people, PHONE.D)!;
    assert.deepEqual(d.lines, ['Linha 1', 'Linha 2', 'Linha 3'], 'uma pessoa, dados das três linhas');
    assert.equal(d.inbound, 4, '7. histórico com várias mensagens (sem a duplicada)');
    assert.equal(d.received, 1, 'resposta manual da linha conta como mensagem recebida pela pessoa');
    assert.equal(personByPhone(people, PHONE.A)!.inbound, 1, 'mensagem de A no grupo não entra na conta individual');
    assert.deepEqual(personByPhone(people, PHONE.C)!.lines, ['Linha 1', 'Linha 2']);
    assert.equal(overview.classification.inboundMessages, 8);
    assert.deepEqual(overview.groups, { chats: 3, messages: 3 });
  });

  it('por linha: a pessoa conta em cada linha onde interagiu; o total é de pessoas únicas', () => {
    const { byLine, people } = t.app.analytics.overview().classification;
    assert.deepEqual(
      byLine.map((l) => [l.label, l.people, l.replied, l.initiated, l.noReply]),
      [
        ['Linha 1', 4, 1, 2, 1], // A, C(recebeu), D, F
        ['Linha 2', 3, 1, 2, 0], // B, C(respondeu), D
        ['Linha 3', 2, 0, 2, 0], // D, @lid
      ],
    );
    assert.equal(people, 6);
  });

  it('linha do tempo da pessoa junta todas as linhas em ordem', () => {
    const timeline = t.app.analytics.personTimeline(PHONE.C);
    assert.deepEqual(timeline.map((e) => [e.kind, e.lineLabel]), [
      ['dispatch', 'Linha 1'],
      ['inbound', 'Linha 2'],
    ]);
    const a = t.app.analytics.personTimeline(PHONE.A);
    assert.deepEqual(a.map((e) => e.chatType), ['individual', 'group'], 'mensagem em grupo aparece marcada, sem entrar na classificação');
  });

  it('filtros: linha, status, contato, mensagem e período', () => {
    const onlyL2 = t.app.analytics.overview({ lineId: L2.id }).classification;
    assert.deepEqual([onlyL2.people, onlyL2.replied, onlyL2.initiated, onlyL2.noReply], [3, 0, 3, 0], 'escopo da Linha 2: só o que aconteceu nela');

    assert.deepEqual(t.app.analytics.people({ status: 'replied' }).people.map((p) => p.phone), [PHONE.C]);
    assert.deepEqual(t.app.analytics.people({ status: 'no_reply' }).people.map((p) => p.phone), [PHONE.F]);
    assert.deepEqual(t.app.analytics.people({ contact: 'Carla' }).people.map((p) => p.phone), [PHONE.C]);
    assert.deepEqual(t.app.analytics.people({ contact: '911110004' }).people.map((p) => p.phone), [PHONE.D]);

    const byMessage = t.app.analytics.overview({ message: 'Mensagem 01' });
    assert.deepEqual(byMessage.sends.byMessage, [{ label: 'Mensagem 01', sent: 2, failed: 0, people: 2, replied: 1 }]);
    assert.equal(t.app.analytics.overview({ message: 'Mensagem 05' }).sends.sent, 0);
    assert.equal(t.app.analytics.overview({ status: 'failed' }).sends.sent, 0);

    const today = new Date();
    const day = (offset: number) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    assert.equal(t.app.analytics.overview({ from: day(0), to: day(0) }).classification.people, 6);
    const future = t.app.analytics.overview({ from: day(1) });
    assert.deepEqual([future.classification.people, future.sends.sent, future.groups.messages], [0, 0, 0]);
    assert.throws(() => t.app.analytics.overview({ from: 'ontem' }), /Data inicial inválida/);
    assert.throws(() => t.app.analytics.overview({ status: 'xyz' }), /Status inválido/);
  });

  it('envios do Analytics batem com os registros e nada é alterado pelas consultas', () => {
    const overview = t.app.analytics.overview();
    assert.equal(overview.sends.sent, t.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM send_attempts WHERE result = 'sent'")!.n);
    assert.deepEqual(overview.sends.byLine.map((l) => [l.label, l.sent]), [['Linha 1', 2]]);
    assert.deepEqual(countRows(), tableCountsBefore, 'consultas não gravam nem apagam registros');
  });

  it('renomear a linha reflete no Analytics sem alterar os registros', async () => {
    await t.app.lines.update(L2.id, { label: 'Atendimento' });
    const labels = t.app.analytics.overview().classification.byLine.map((l) => l.label);
    assert.ok(labels.includes('Atendimento'));
    assert.equal(t.app.db.get<{ line_label: string }>('SELECT line_label FROM conversation_messages WHERE line_id = :id LIMIT 1', { id: L2.id })!.line_label, 'Linha 2');
    await t.app.lines.update(L2.id, { label: 'Linha 2' });
  });

  it('API: overview, pessoas e linha do tempo', async () => {
    const server = await buildServer(t.app);
    try {
      const overview = await server.inject({ method: 'GET', url: '/api/analytics/overview' });
      assert.equal(overview.statusCode, 200);
      assert.equal(overview.json().classification.people, 6);
      const people = await server.inject({ method: 'GET', url: '/api/analytics/people?status=initiated&limit=2' });
      assert.equal(people.json().total, 4);
      assert.equal(people.json().people.length, 2);
      const timeline = await server.inject({ method: 'GET', url: `/api/analytics/people/${PHONE.D}/timeline` });
      assert.equal(timeline.json().timeline.length, 5, 'mensagens de D nas 3 linhas, sem a duplicada');
      assert.equal((await server.inject({ method: 'GET', url: '/api/analytics/overview?to=31/12' })).statusCode, 400);
      const history = await server.inject({ method: 'GET', url: `/api/history?contact=Carla&message=Mensagem%2001&campaignId=${campaignId}` });
      assert.equal(history.json().attempts.length, 1);
    } finally {
      await server.close();
    }
  });
});
