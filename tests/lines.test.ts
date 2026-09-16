import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DomainError } from '../src/server/shared/errors.ts';
import { createTestApp, flush, type TestApp } from './helpers.ts';

describe('LineManager: coleção dinâmica de linhas', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.app.close();
  });

  const createLines = (n: number, providerConfig: Record<string, unknown> = {}) =>
    Promise.all(Array.from({ length: n }, (_, i) => t.app.lines.create({ label: `Linha ${i + 1}`, provider: 'mock', providerConfig })));

  it('trabalha com qualquer quantidade entre 1 e 10 e bloqueia a 11ª', async () => {
    await createLines(1);
    assert.equal((await t.app.lines.list()).length, 1);
    await createLines(9);
    assert.equal((await t.app.lines.list()).length, 10);

    await assert.rejects(
      t.app.lines.create({ label: 'Linha 11', provider: 'mock' }),
      (error: unknown) => error instanceof DomainError && error.code === 'LIMIT_EXCEEDED',
    );
  });

  it('respeita o limite configurado (ex.: máximo de 3 linhas)', async () => {
    await t.app.settings.update({ maxLines: 3 });
    await createLines(3);
    await assert.rejects(t.app.lines.create({ label: 'Extra', provider: 'mock' }), /Limite de 3/);
  });

  it('nova linha tem id único, contadores zerados e configurações padrão', async () => {
    const [a, b] = await createLines(2);
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    assert.equal(a.runState, 'stopped');
    assert.equal(a.connectionStatus, 'disconnected');
    assert.deepEqual(a.counters, { contactsProcessed: 0, messagesSent: 0, failures: 0 });
    assert.equal(a.pending, 0);
    assert.equal(a.settings.dailyLimit, 200);
    assert.equal('providerConfig' in a, false, 'config do provedor não deve vazar na visão pública');
  });

  it('pausar uma linha não afeta as demais', async () => {
    const lines = await createLines(5);
    for (const line of lines) await t.app.lines.start(line.id);

    await t.app.lines.pause(lines[1]!.id);

    const after = await t.app.lines.list();
    assert.deepEqual(
      after.map((l) => l.runState),
      ['active', 'paused', 'active', 'active', 'active'],
    );
    assert.deepEqual(
      after.map((l) => l.available),
      [true, false, true, true, true],
    );
    assert.equal((await t.app.lines.available()).length, 4);
  });

  it('cenário misto: ativa, ativa, pausada, ativa, desconectada', async () => {
    const lines = await createLines(5);
    for (const line of lines) await t.app.lines.start(line.id);
    await t.app.lines.pause(lines[2]!.id);
    await t.app.lines.disconnect(lines[4]!.id);

    const summary = await t.app.lines.summary();
    assert.equal(summary.total, 5);
    assert.equal(summary.connected, 4);
    assert.equal(summary.active, 3);
    assert.equal(summary.paused, 1);
    assert.equal(summary.stopped, 1);
    assert.equal(summary.disconnected, 1);
    assert.equal(summary.available, 3);
  });

  it('erro de conexão em uma linha fica isolado nela', async () => {
    const ok = await t.app.lines.create({ label: 'OK', provider: 'mock' });
    const bad = await t.app.lines.create({ label: 'Ruim', provider: 'mock', providerConfig: { failConnect: true } });

    await t.app.lines.start(ok.id);
    const badAfter = await t.app.lines.start(bad.id); // não lança: o erro vira estado da linha

    assert.equal(badAfter.connectionStatus, 'error');
    assert.match(badAfter.lastError ?? '', /Falha simulada/);
    const okAfter = await t.app.lines.status(ok.id);
    assert.equal(okAfter.connectionStatus, 'connected');
    assert.equal(okAfter.available, true);
  });

  it('queda de conexão vinda do provedor derruba só aquela linha; reconectar recupera', async () => {
    const [a, b] = await createLines(2);
    await t.app.lines.start(a!.id);
    await t.app.lines.start(b!.id);

    t.mocks.get(a!.id)!.simulateDrop('Sessão expirada');
    await flush();

    assert.equal((await t.app.lines.status(a!.id)).connectionStatus, 'error');
    assert.equal((await t.app.lines.status(a!.id)).runState, 'active', 'a intenção do usuário é preservada');
    assert.equal((await t.app.lines.status(b!.id)).available, true);

    const recovered = await t.app.lines.reconnect(a!.id);
    assert.equal(recovered.connectionStatus, 'connected');
    assert.equal(recovered.available, true);
    assert.ok(recovered.connectedAt);
    assert.equal(recovered.lastError, null);
  });

  it('valida transições de comando por linha', async () => {
    const [line] = await createLines(1);
    await assert.rejects(t.app.lines.pause(line!.id), /pausar uma linha ativa/);
    await assert.rejects(t.app.lines.resume(line!.id), /retomar uma linha pausada/);
    await t.app.lines.start(line!.id);
    await assert.rejects(t.app.lines.start(line!.id), /já está ativa/);
    await t.app.lines.pause(line!.id);
    await assert.rejects(t.app.lines.start(line!.id), /use "retomar"/);
    const resumed = await t.app.lines.resume(line!.id);
    assert.equal(resumed.runState, 'active');
  });

  it('envio por linha indisponível falha sem lançar exceção', async () => {
    const [line] = await createLines(1);
    const result = await t.app.lines.send(line!.id, { to: '5521999990000', body: 'oi' });
    assert.equal(result.ok, false);
    await t.app.lines.start(line!.id);
    const sent = await t.app.lines.send(line!.id, { to: '5521999990000', body: 'oi' });
    assert.equal(sent.ok, true);
  });

  it('emite eventos de atualização por linha', async () => {
    const seen: string[] = [];
    t.app.events.on('line.updated', (view) => seen.push(`${view.label}:${view.runState}:${view.connectionStatus}`));
    const [line] = await createLines(1);
    await t.app.lines.start(line!.id);
    await flush();
    assert.ok(seen.includes('Linha 1:active:connected'), seen.join(' | '));
  });

  it('remoção de uma linha mantém as outras', async () => {
    const [a, b] = await createLines(2);
    await t.app.lines.start(a!.id);
    await t.app.lines.remove(a!.id);
    const remaining = await t.app.lines.list();
    assert.deepEqual(remaining.map((l) => l.id), [b!.id]);
  });

  it('alterar config do provedor exige linha desconectada e recria o provedor', async () => {
    const [line] = await createLines(1);
    await t.app.lines.start(line!.id);
    await assert.rejects(t.app.lines.update(line!.id, { providerConfig: { accountId: 'x' } }), /Desconecte/);
    await t.app.lines.disconnect(line!.id);
    await t.app.lines.update(line!.id, { providerConfig: { accountId: '5521988887777' } });
    const started = await t.app.lines.start(line!.id);
    assert.equal(started.accountId, '5521988887777');
  });
});
