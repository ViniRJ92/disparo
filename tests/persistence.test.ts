import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/server/app.ts';

describe('Persistência e reinício', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disparo-test-'));
  const databasePath = join(dir, 'disparo.db');

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('restaura linhas após reinício respeitando a intenção de cada uma', async () => {
    const first = await createApp({ databasePath });
    const active = await first.lines.create({ label: 'Ativa', provider: 'mock' });
    const paused = await first.lines.create({ label: 'Pausada', provider: 'mock' });
    const stopped = await first.lines.create({ label: 'Parada', provider: 'mock' });
    await first.lines.start(active.id);
    await first.lines.start(paused.id);
    await first.lines.pause(paused.id);

    const contacts = await first.contacts.import([{ phone: '21999990001' }]);
    const message = await first.messages.create({ name: 'M', body: 'oi' });
    const campaign = await first.campaigns.create({
      name: 'C',
      lineIds: [active.id],
      contactIds: contacts.contactIds,
    });
    // Simula app fechado no meio de um envio.
    await first.queue.claimNext(campaign.id, active.id);
    await first.close();

    const second = await createApp({ databasePath });
    const byLabel = new Map((await second.lines.list()).map((line) => [line.label, line]));

    assert.equal(byLabel.get('Ativa')?.connectionStatus, 'connected');
    assert.equal(byLabel.get('Ativa')?.runState, 'active');
    assert.equal(byLabel.get('Pausada')?.connectionStatus, 'connected');
    assert.equal(byLabel.get('Pausada')?.runState, 'paused');
    assert.equal(byLabel.get('Parada')?.connectionStatus, 'disconnected');
    assert.equal(byLabel.get(stopped.label)?.runState, 'stopped');

    const counts = await second.queue.counts(campaign.id);
    assert.equal(counts.processing, 0, 'envio interrompido volta para a fila');
    assert.equal(counts.pending, 1);

    // Migrações não são reaplicadas.
    assert.deepEqual(second.db.migrate(), []);
    await second.close();
  });
});
