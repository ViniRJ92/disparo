import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AppOptions } from '../src/server/app.ts';
import { buildServer } from '../src/server/api/server.ts';
import type { RoundSnapshot } from '../src/server/modules/distribution/distribution.types.ts';
import type { LineView } from '../src/server/modules/lines/line.types.ts';
import { createTestApp, sleep, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Módulo 5: motor de distribuição entre linhas', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  interface SetupOptions {
    lines: number;
    contacts: number;
    selected?: number;
    sendDelayMs?: number;
    messages?: number;
    distribution?: { minBatch?: number; maxBatch?: number; roundStallSeconds?: number };
    app?: Partial<Omit<AppOptions, 'databasePath' | 'providers'>>;
  }

  async function setup(o: SetupOptions) {
    t = await createTestApp(o.app);
    await t.app.settings.update({ distribution: { minBatch: 2, maxBatch: 5, roundStallSeconds: 120, ...o.distribution } });
    const lines: LineView[] = [];
    for (let i = 1; i <= o.lines; i++) {
      const line = await t.app.lines.create({
        label: `Linha ${String(i).padStart(2, '0')}`,
        provider: 'mock',
        providerConfig: { sendDelayMs: o.sendDelayMs ?? 1 },
        settings: FAST,
      });
      await t.app.lines.start(line.id);
      lines.push(line);
    }
    for (let slot = 1; slot <= (o.messages ?? 3); slot++) await t.app.messages.saveSlot(slot, { body: `Texto ${slot} para {{nome}}` });
    const { contactIds } = await t.app.contacts.import(
      Array.from({ length: o.contacts }, (_, i) => ({ phone: `55219${String(i).padStart(8, '0')}`, name: `Contato ${i}` })),
    );
    const selected = lines.slice(0, o.selected ?? o.lines);
    return { lines, selected, contactIds };
  }

  async function startProcess(name: string, lineIds: string[], contactIds: string[]) {
    const campaign = await t.app.campaigns.create({ name, lineIds, contactIds });
    await t.app.campaigns.execute(campaign.id, 'start');
    return campaign.id;
  }

  const completed = (campaignId: string, timeoutMs = 15_000) =>
    waitFor(
      async () => (await t.app.campaigns.summary(campaignId)).status === 'completed' && t.app.distribution.snapshot(campaignId).current === null,
      timeoutMs,
      'processo concluído',
    );

  const sentBy = async (lineId: string) => (await t.app.lines.status(lineId)).counters.messagesSent;

  function allRounds(campaignId: string): RoundSnapshot[] {
    const { current, past } = t.app.distribution.snapshot(campaignId);
    return [...(current ? [current] : []), ...past];
  }

  /** Invariantes de toda rodada: cota dentro do intervalo e nenhuma linha acima da própria cota. */
  function assertRoundInvariants(campaignId: string, minBatch = 2, maxBatch = 5) {
    const rounds = allRounds(campaignId);
    assert.ok(rounds.length > 0, 'houve rodadas');
    for (const round of rounds) {
      for (const q of round.quotas) {
        assert.ok(q.assigned >= 1 && q.assigned <= maxBatch, `cota ${q.assigned} fora do intervalo`);
        assert.ok(q.assigned >= Math.min(minBatch, q.assigned), 'cota mínima');
        assert.ok(q.used <= q.assigned, `rodada ${round.number}: linha usou ${q.used} com cota ${q.assigned}`);
      }
    }
    return rounds;
  }

  async function assertNothingLost(campaignId: string, contactIds: string[]) {
    const counts = (await t.app.campaigns.summary(campaignId)).counts;
    assert.equal(counts.sent, contactIds.length, 'todos os contatos enviados');
    assert.equal(counts.pending + counts.processing, 0);
    const sent = (await t.app.history.list({ campaignId, result: 'sent', limit: 10_000 })).map((h) => h.contactId);
    assert.equal(sent.length, contactIds.length, 'nenhum contato enviado duas vezes');
    assert.equal(new Set(sent).size, contactIds.length);
  }

  // ------------------------------------------------------------------ quantidades de linhas

  it('1 linha: processa tudo em rodadas sucessivas, sem travar', async () => {
    const { lines, contactIds } = await setup({ lines: 1, contacts: 25 });
    const campaignId = await startProcess('Uma', [lines[0]!.id], contactIds);
    await completed(campaignId);

    await assertNothingLost(campaignId, contactIds);
    assert.equal(await sentBy(lines[0]!.id), 25);
    const rounds = assertRoundInvariants(campaignId);
    assert.ok(rounds.length >= 5, `${rounds.length} rodadas para 25 contatos com cota de 2 a 5`);
  });

  it('2 linhas: ambas trabalham e a soma fecha', async () => {
    const { lines, contactIds } = await setup({ lines: 2, contacts: 60 });
    const campaignId = await startProcess('Duas', lines.map((l) => l.id), contactIds);
    await completed(campaignId);

    await assertNothingLost(campaignId, contactIds);
    const [a, b] = [await sentBy(lines[0]!.id), await sentBy(lines[1]!.id)];
    assert.ok(a > 0 && b > 0);
    assert.equal(a + b, 60);
    assertRoundInvariants(campaignId);
  });

  it('5 linhas: cotas variam por linha e por rodada (não é revezamento fixo)', async () => {
    const { lines, contactIds } = await setup({ lines: 5, contacts: 250, sendDelayMs: 2 });
    const campaignId = await startProcess('Cinco', lines.map((l) => l.id), contactIds);
    await completed(campaignId);

    await assertNothingLost(campaignId, contactIds);
    const rounds = assertRoundInvariants(campaignId);
    const finished = rounds.slice(1); // a mais recente pode ter terminado antes de esgotar (fim dos contatos)
    assert.ok(finished.length >= 10, `${finished.length} rodadas completas`);

    const patterns = finished.map((r) => lines.map((l) => r.quotas.find((q) => q.lineId === l.id)?.assigned ?? 0).join(','));
    assert.ok(new Set(patterns).size > finished.length / 2, 'padrões de cota variam entre rodadas');
    assert.ok(finished.some((r) => new Set(r.quotas.map((q) => q.assigned)).size > 1), 'linhas recebem quantidades diferentes na mesma rodada');
    for (let i = 1; i < patterns.length; i++) assert.notEqual(patterns[i], patterns[i - 1], 'rodadas seguidas não repetem o padrão');

    // Rodadas encerradas por esgotamento: cada linha fez exatamente a sua cota.
    for (const round of finished) for (const q of round.quotas) assert.equal(q.used, q.assigned);

    const perLine = await Promise.all(lines.map((l) => sentBy(l.id)));
    assert.ok(new Set(perLine).size > 1, `totais por linha variam: ${perLine.join(', ')}`);
  });

  it('10 linhas: todas participam, sem duplicar contatos', async () => {
    const { lines, contactIds } = await setup({ lines: 10, contacts: 400, sendDelayMs: 2 });
    const campaignId = await startProcess('Dez', lines.map((l) => l.id), contactIds);
    await completed(campaignId, 30_000);

    await assertNothingLost(campaignId, contactIds);
    const perLine = await Promise.all(lines.map((l) => sentBy(l.id)));
    assert.ok(perLine.every((n) => n > 0), 'as 10 linhas trabalharam');
    assertRoundInvariants(campaignId);
  });

  it('10 conectadas e 6 selecionadas: somente as 6 processam contatos', async () => {
    const { lines, selected, contactIds } = await setup({ lines: 10, selected: 6, contacts: 120 });
    const campaignId = await startProcess('Seis', selected.map((l) => l.id), contactIds);
    await completed(campaignId);

    await assertNothingLost(campaignId, contactIds);
    const selectedIds = new Set(selected.map((l) => l.id));
    for (const line of lines) {
      const sent = await sentBy(line.id);
      if (selectedIds.has(line.id)) assert.ok(sent > 0, `${line.label} selecionada trabalhou`);
      else assert.equal(sent, 0, `${line.label} não selecionada não recebeu contatos`);
    }
    for (const round of allRounds(campaignId)) {
      assert.ok(round.quotas.every((q) => selectedIds.has(q.lineId)), 'rodadas só incluem selecionadas');
    }
  });

  // ------------------------------------------------------------------ pausas e quedas durante o processamento

  it('6 linhas, 2 pausadas no meio: saem da distribuição, as 4 seguem, e voltam ao retomar', async () => {
    const { lines, contactIds } = await setup({ lines: 6, contacts: 500, sendDelayMs: 3 });
    const campaignId = await startProcess('Pausas', lines.map((l) => l.id), contactIds);
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).counts.sent >= 60, 10_000, 'progresso inicial');

    const paused = [lines[1]!.id, lines[4]!.id];
    const running = lines.map((l) => l.id).filter((id) => !paused.includes(id));
    for (const id of paused) await t.app.lines.pause(id);
    await sleep(30); // envio em curso termina

    const frozen = await Promise.all(paused.map(sentBy));
    const before = await Promise.all(running.map(sentBy));
    await sleep(250);
    assert.deepEqual(await Promise.all(paused.map(sentBy)), frozen, 'pausadas não recebem novos contatos');
    const after = await Promise.all(running.map(sentBy));
    running.forEach((_, i) => assert.ok(after[i]! > before[i]!, 'as 4 restantes continuam'));

    const current = t.app.distribution.snapshot(campaignId).current!;
    for (const id of paused) {
      const quota = current.quotas.find((q) => q.lineId === id);
      assert.ok(!quota || !quota.active, 'pausada fora da rodada atual');
    }
    assert.ok(current.quotas.filter((q) => running.includes(q.lineId)).every((q) => q.active), 'as 4 restantes seguem ativas na rodada');

    for (const id of paused) await t.app.lines.resume(id);
    await waitFor(async () => (await Promise.all(paused.map(sentBy))).every((n, i) => n > frozen[i]!), 5000, 'retomadas voltam a participar');

    await completed(campaignId, 30_000);
    await assertNothingLost(campaignId, contactIds);
    assertRoundInvariants(campaignId);

    const logs = await t.app.logs.list({ campaignId, limit: 1000 });
    assert.ok(logs.some((l) => l.message.includes('retirada da distribuição')));
    assert.ok(logs.some((l) => l.message.includes('voltou à distribuição')));
  });

  it('todas as linhas pausadas: contatos ficam "aguardando" (nada se perde) e o processo continua ao retomar', async () => {
    const { lines, contactIds } = await setup({ lines: 2, contacts: 80, sendDelayMs: 3 });
    const campaignId = await startProcess('Tudo pausado', lines.map((l) => l.id), contactIds);
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).counts.sent >= 10, 5000, 'progresso');

    for (const line of lines) await t.app.lines.pause(line.id);
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).counts.processing === 0, 2000, 'envios em curso terminam');

    const summary = await t.app.contacts.summary();
    const counts = (await t.app.campaigns.summary(campaignId)).counts;
    assert.equal(summary.byProcessing.pending, 0, 'sem linha apta, ninguém fica como "pendente"');
    assert.equal(summary.byProcessing.waiting, counts.pending, 'todos os não enviados aparecem como aguardando');
    assert.equal(summary.byProcessing.sent, counts.sent);
    assert.equal(counts.sent + counts.pending, 80, 'nenhum contato sumiu da fila');
    assert.equal((await t.app.contacts.list({ processingStatus: 'waiting', limit: 1000 })).length, counts.pending);

    await t.app.lines.resume(lines[0]!.id);
    await sleep(20);
    assert.ok((await t.app.contacts.summary()).byProcessing.pending > 0, 'com uma linha retomada, voltam a pendente');

    await t.app.lines.resume(lines[1]!.id);
    await completed(campaignId);
    await assertNothingLost(campaignId, contactIds);
  });

  it('linha cai com erro: não recebe novos contatos, erro registrado, demais seguem, reconexão devolve à distribuição', async () => {
    const { lines, contactIds } = await setup({ lines: 3, contacts: 300, sendDelayMs: 3, app: { reconnectDelaysMs: [] } });
    const campaignId = await startProcess('Queda', lines.map((l) => l.id), contactIds);
    await waitFor(async () => (await t.app.campaigns.summary(campaignId)).counts.sent >= 30, 5000, 'progresso');

    const victim = lines[2]!.id;
    t.mocks.get(victim)!.simulateDrop('Conexão perdida');
    await waitFor(async () => (await t.app.lines.status(victim)).status === 'error', 1000, 'linha em erro');
    await sleep(30);
    const frozen = await sentBy(victim);
    const others = async () => (await sentBy(lines[0]!.id)) + (await sentBy(lines[1]!.id));
    const othersBefore = await others();
    await sleep(200);
    assert.equal(await sentBy(victim), frozen, 'nenhum contato novo para a linha com erro');
    assert.ok((await others()) > othersBefore, 'as demais continuam');

    const errors = await t.app.logs.list({ lineId: victim, level: 'error', limit: 100 });
    assert.ok(errors.some((l) => l.message.includes('Conexão perdida')), 'erro registrado');

    await t.app.lines.reconnect(victim);
    await waitFor(async () => (await sentBy(victim)) > frozen, 5000, 'linha reconectada volta a receber');

    await completed(campaignId, 30_000);
    await assertNothingLost(campaignId, contactIds);
  });

  it('linha com cota esgotada aguarda a vez e, se as outras travarem, abre nova rodada', async () => {
    t = await createTestApp();
    await t.app.settings.update({ distribution: { minBatch: 2, maxBatch: 2, roundStallSeconds: 1 } });
    const fast = await t.app.lines.create({ label: 'Rápida', provider: 'mock', providerConfig: { sendDelayMs: 1 }, settings: FAST });
    const slow = await t.app.lines.create({ label: 'Lenta', provider: 'mock', providerConfig: { sendDelayMs: 1500 }, settings: FAST });
    await t.app.lines.start(fast.id);
    await t.app.lines.start(slow.id);
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const { contactIds } = await t.app.contacts.import(Array.from({ length: 20 }, (_, i) => ({ phone: `552198${String(i).padStart(7, '0')}` })));
    const campaignId = await startProcess('Vez', [fast.id, slow.id], contactIds);

    await waitFor(() => t.app.dispatch.snapshot(fast.id)?.state === 'waiting_turn', 1000, 'rápida aguardando a vez');
    assert.equal(await sentBy(fast.id), 2, 'rápida parou na sua cota');

    await waitFor(async () => (await sentBy(fast.id)) > 2, 2500, 'rodada destravada por inatividade');
    const logs = await t.app.logs.list({ campaignId, limit: 100 });
    assert.ok(logs.some((l) => l.message.includes('linhas com cota paradas')));
  });

  // ------------------------------------------------------------------ concorrência e histórico

  it('concorrência: 10 linhas em 2 processos com os mesmos contatos nunca processam o mesmo contato ao mesmo tempo', async () => {
    const { lines, contactIds } = await setup({ lines: 10, contacts: 100, sendDelayMs: 2 });
    const ids = lines.map((l) => l.id);
    const first = await startProcess('A', ids, contactIds);
    const second = await startProcess('B', ids, contactIds);

    let maxSimultaneous = 0;
    const sampler = (async () => {
      while ((await t.app.campaigns.summary(second)).status !== 'completed' || (await t.app.campaigns.summary(first)).status !== 'completed') {
        const row = t.app.db.get<{ n: number | null }>(
          "SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM send_jobs WHERE status = 'processing' GROUP BY contact_id)",
        );
        maxSimultaneous = Math.max(maxSimultaneous, row?.n ?? 0);
        await sleep(2);
      }
    })();
    await Promise.all([completed(first, 30_000), completed(second, 30_000), sampler]);

    assert.equal(maxSimultaneous, 1, 'no máximo 1 envio em curso por contato');
    await assertNothingLost(first, contactIds);
    await assertNothingLost(second, contactIds);

    // A regra do Módulo 3 continua valendo com o motor: as duas mensagens de cada contato diferem.
    for (const contactId of contactIds) {
      const labels = (await t.app.history.list({ contactId })).map((h) => h.messageLabel);
      assert.equal(labels.length, 2);
      assert.notEqual(labels[0], labels[1]);
    }

    // Garantia do banco: nem manualmente é possível ter 2 envios "processing" para o mesmo contato.
    const [jobA, jobB] = t.app.db.all<{ id: string }>('SELECT id FROM send_jobs WHERE contact_id = :c', { c: contactIds[0]! });
    t.app.db.run("UPDATE send_jobs SET status = 'processing' WHERE id = :id", { id: jobA!.id });
    assert.throws(() => t.app.db.run("UPDATE send_jobs SET status = 'processing' WHERE id = :id", { id: jobB!.id }), /UNIQUE/);
  });

  it('histórico registra contato, linha, mensagem, data/hora, resultado e erro de cada processamento', async () => {
    const { lines, contactIds } = await setup({ lines: 2, contacts: 20 });
    await t.app.lines.disconnect(lines[1]!.id);
    await t.app.lines.update(lines[1]!.id, { providerConfig: { failSend: true } });
    await t.app.lines.start(lines[1]!.id);
    const campaignId = await startProcess('Histórico', lines.map((l) => l.id), contactIds);
    await completed(campaignId);

    const history = await t.app.history.list({ campaignId, limit: 100 });
    assert.equal(history.length, 20);
    for (const entry of history) {
      assert.ok(entry.contactPhone && entry.contactName, 'contato');
      assert.ok(entry.lineLabel, 'linha');
      assert.match(entry.messageLabel ?? '', /^Mensagem 0[123]$/, 'mensagem');
      assert.ok(!Number.isNaN(Date.parse(entry.createdAt)), 'data/hora');
      assert.ok(entry.result === 'sent' || entry.result === 'failed', 'resultado');
      if (entry.result === 'failed') assert.equal(entry.error, 'Falha simulada de envio', 'erro');
      else assert.equal(entry.error, null);
    }
    assert.ok(history.some((h) => h.result === 'failed' && h.lineLabel === 'Linha 02'));
    assert.ok(history.some((h) => h.result === 'sent' && h.lineLabel === 'Linha 01'));
    const failedContacts = await t.app.contacts.list({ processingStatus: 'failed', limit: 100 });
    assert.equal(failedContacts.length, history.filter((h) => h.result === 'failed').length);
  });

  it('API: consulta da distribuição e ajuste das cotas', async () => {
    const { lines, contactIds } = await setup({ lines: 3, contacts: 30 });
    const server = await buildServer(t.app);
    try {
      const patched = await server.inject({ method: 'PATCH', url: '/api/settings', payload: { distribution: { maxBatch: 3 } } });
      assert.equal(patched.statusCode, 200);
      assert.deepEqual(patched.json().distribution, { minBatch: 2, maxBatch: 3, cycleIntervalSeconds: [0], roundStallSeconds: 120 });
      const invalid = await server.inject({ method: 'PATCH', url: '/api/settings', payload: { distribution: { minBatch: 9 } } });
      assert.equal(invalid.statusCode, 400);

      const campaignId = await startProcess('API', lines.map((l) => l.id), contactIds);
      await completed(campaignId);
      const snapshot = (await server.inject({ method: 'GET', url: `/api/campaigns/${campaignId}/distribution` })).json();
      // Processo concluído: rodada atual encerrada, histórico de rodadas preservado.
      assert.equal(snapshot.current, null);
      assert.ok(snapshot.past.length > 0);
      assert.ok(snapshot.past.every((r: { quotas: { assigned: number }[] }) => r.quotas.every((q) => q.assigned >= 1 && q.assigned <= 3)));
      assert.equal((await server.inject({ method: 'GET', url: '/api/campaigns/nao-existe/distribution' })).statusCode, 404);
    } finally {
      await server.close();
    }
  });
});
