import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { drawCycleInterval, drawLineQuota } from '../src/server/modules/distribution/distribution.engine.ts';
import { DEFAULT_APP_SETTINGS } from '../src/server/modules/settings/settings.schema.ts';
import { createTestApp, waitFor, type TestApp } from './helpers.ts';

const RANGE = { minBatch: 2, maxBatch: 5 };
const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

describe('Ciclos: sorteios (regras puras)', () => {
  it('padrão do sistema: quantidade 2 a 5 por linha e intervalo de 2, 3, 4 ou 5 segundos', () => {
    assert.equal(DEFAULT_APP_SETTINGS.distribution.minBatch, 2);
    assert.equal(DEFAULT_APP_SETTINGS.distribution.maxBatch, 5);
    assert.deepEqual(DEFAULT_APP_SETTINGS.distribution.cycleIntervalSeconds, [2, 3, 4, 5]);
  });

  it('quantidade: sempre entre 2 e 5, nunca igual à do ciclo anterior da mesma linha, todas as opções aparecem', () => {
    let previous: number | undefined;
    const seen = new Map<number, number>();
    let returnedToEarlierValue = false;
    const history: number[] = [];
    for (let cycle = 0; cycle < 4000; cycle++) {
      const quota = drawLineQuota(RANGE, 100, previous, Math.random);
      assert.ok(quota >= 2 && quota <= 5, `quantidade ${quota}`);
      assert.notEqual(quota, previous, 'não repete a quantidade do ciclo imediatamente anterior');
      if (history.length >= 2 && history[history.length - 2] === quota) returnedToEarlierValue = true;
      seen.set(quota, (seen.get(quota) ?? 0) + 1);
      history.push(quota);
      previous = quota;
    }
    assert.deepEqual([...seen.keys()].sort(), [2, 3, 4, 5]);
    for (const [value, n] of seen) assert.ok(n > 800 && n < 1200, `${value} sorteado ${n}x (esperado ~1000)`);
    assert.ok(returnedToEarlierValue, 'um valor pode voltar depois de um ciclo (restrição só do imediatamente anterior)');
  });

  it('quantidade com pouca capacidade: usa a alternativa válida e só repete quando não há outra', () => {
    assert.equal(drawLineQuota(RANGE, 3, 3, Math.random), 2, 'capacidade 3 e anterior 3: única alternativa é 2');
    assert.equal(drawLineQuota(RANGE, 2, 2, Math.random), 2, 'capacidade 2: não há alternativa, repetir é permitido');
    assert.equal(drawLineQuota(RANGE, 1, undefined, Math.random), 1, 'só 1 disponível: processa somente 1');
    assert.equal(drawLineQuota(RANGE, 0, undefined, Math.random), 0);
  });

  it('intervalo: um valor da lista, nunca igual ao do ciclo anterior, aleatório e sem sequência fixa', () => {
    const options = [2, 3, 4, 5];
    let previous: number | undefined;
    const sequence: number[] = [];
    for (let cycle = 0; cycle < 4000; cycle++) {
      const interval = drawCycleInterval(options, previous, Math.random);
      assert.ok(options.includes(interval));
      assert.notEqual(interval, previous, 'nunca igual ao ciclo imediatamente anterior');
      sequence.push(interval);
      previous = interval;
    }
    const counts = options.map((o) => sequence.filter((s) => s === o).length);
    counts.forEach((n) => assert.ok(n > 800 && n < 1200, `distribuição equilibrada: ${counts.join(', ')}`));
    // Sequência fixa (2→3→4→5→2...) teria sempre o mesmo sucessor para cada valor.
    const successors = new Map<number, Set<number>>();
    for (let i = 1; i < sequence.length; i++) {
      const set = successors.get(sequence[i - 1]!) ?? new Set<number>();
      set.add(sequence[i]!);
      successors.set(sequence[i - 1]!, set);
    }
    for (const [value, set] of successors) assert.equal(set.size, 3, `depois de ${value}s aparecem os outros 3 valores`);
    assert.ok(sequence.some((v, i) => i >= 2 && sequence[i - 2] === v), 'um intervalo pode voltar após um ciclo');
  });

  it('intervalo com uma única opção: repete sem erro', () => {
    assert.equal(drawCycleInterval([3], 3, Math.random), 3);
  });
});

describe('Ciclos: execução real com várias linhas', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  async function run(lineCount: number, contactCount: number, intervals = [0.02, 0.03, 0.04, 0.05]) {
    t = await createTestApp();
    await t.app.settings.update({ distribution: { minBatch: 2, maxBatch: 5, cycleIntervalSeconds: intervals } });
    const lines = [];
    for (let i = 1; i <= lineCount; i++) {
      const line = await t.app.lines.create({ label: `Linha ${i}`, provider: 'mock', providerConfig: { sendDelayMs: 1 }, settings: FAST });
      await t.app.lines.start(line.id);
      lines.push(line);
    }
    await t.app.messages.saveSlot(1, { body: 'Oi {{nome}}' });
    await t.app.messages.saveSlot(2, { body: 'Olá {{nome}}' });
    const { contactIds } = await t.app.contacts.import(
      Array.from({ length: contactCount }, (_, i) => ({ phone: `552196${String(i).padStart(7, '0')}`, name: `C${i}` })),
    );
    const campaign = await t.app.campaigns.create({ name: 'Ciclos', lineIds: lines.map((l) => l.id), contactIds, start: true });
    await waitFor(
      async () => (await t.app.campaigns.summary(campaign.id)).status === 'completed' && t.app.distribution.snapshot(campaign.id).current === null,
      30_000,
      'conclusão',
    );
    return { lines, contactIds, campaignId: campaign.id };
  }

  it('vários ciclos consecutivos: quantidades e intervalo re-sorteados, sem repetição imediata, intervalo único por ciclo', async () => {
    const { lines, campaignId } = await run(6, 260);
    const cycles = [...t.app.distribution.snapshot(campaignId).past].reverse(); // do primeiro ao último
    assert.ok(cycles.length >= 8, `${cycles.length} ciclos`);
    assert.deepEqual(cycles.map((c) => c.number), cycles.map((_, i) => i + 1), 'ciclos numerados em sequência');

    for (let i = 0; i < cycles.length; i++) {
      const cycle = cycles[i]!;
      assert.ok([0.02, 0.03, 0.04, 0.05].includes(cycle.intervalSeconds));
      for (const q of cycle.quotas) assert.ok(q.assigned >= 2 && q.assigned <= 5, `ciclo ${cycle.number}: ${q.assigned}`);
      if (i === 0) continue;
      const previous = cycles[i - 1]!;
      assert.notEqual(cycle.intervalSeconds, previous.intervalSeconds, `ciclo ${cycle.number}: intervalo repetido`);
      const isLast = i === cycles.length - 1;
      for (const q of cycle.quotas) {
        const before = previous.quotas.find((p) => p.lineId === q.lineId);
        if (before && !isLast) assert.notEqual(q.assigned, before.assigned, `ciclo ${cycle.number}: linha repetiu ${q.assigned}`);
      }
    }
    const patterns = cycles.map((c) => lines.map((l) => c.quotas.find((q) => q.lineId === l.id)?.assigned).join(','));
    assert.ok(new Set(patterns).size > cycles.length * 0.8, 'padrões variam entre ciclos');

    // Histórico: cada envio registra o ciclo e o intervalo; um único intervalo por ciclo.
    const rows = t.app.db.all<{ cycle_number: number; intervals: number; interval: number }>(
      `SELECT cycle_number, COUNT(DISTINCT cycle_interval_seconds) AS intervals, MAX(cycle_interval_seconds) AS interval
       FROM send_attempts WHERE campaign_id = :campaignId GROUP BY cycle_number`,
      { campaignId },
    );
    assert.ok(rows.every((r) => r.cycle_number !== null && r.intervals === 1), 'um único intervalo por ciclo');
    for (const r of rows) {
      assert.equal(r.interval, cycles.find((c) => c.number === r.cycle_number)?.intervalSeconds, 'histórico = intervalo sorteado do ciclo');
    }
    // Cotas cumpridas: o número de envios de cada linha em cada ciclo nunca passa da quantidade sorteada.
    const perLineCycle = t.app.db.all<{ line_id: string; cycle_number: number; n: number }>(
      `SELECT line_id, cycle_number, COUNT(*) AS n FROM send_attempts WHERE campaign_id = :campaignId GROUP BY line_id, cycle_number`,
      { campaignId },
    );
    for (const r of perLineCycle) {
      const quota = cycles.find((c) => c.number === r.cycle_number)!.quotas.find((q) => q.lineId === r.line_id)!;
      assert.ok(r.n <= quota.assigned, `linha fez ${r.n} com cota ${quota.assigned}`);
    }
  });

  it('o intervalo do ciclo é aplicado entre os envios de cada linha durante o ciclo inteiro', async () => {
    const { campaignId } = await run(3, 60, [0.03, 0.06, 0.09]);
    const attempts = t.app.db.all<{ line_id: string; created_at: string; cycle_interval_seconds: number }>(
      'SELECT line_id, created_at, cycle_interval_seconds FROM send_attempts WHERE campaign_id = :campaignId ORDER BY line_id, created_at, rowid',
      { campaignId },
    );
    let checked = 0;
    for (let i = 1; i < attempts.length; i++) {
      const [prev, cur] = [attempts[i - 1]!, attempts[i]!];
      if (prev.line_id !== cur.line_id) continue;
      const gapMs = Date.parse(cur.created_at) - Date.parse(prev.created_at);
      assert.ok(gapMs >= prev.cycle_interval_seconds * 1000 - 5, `intervalo de ${gapMs}ms < ${prev.cycle_interval_seconds}s do ciclo`);
      checked++;
    }
    assert.ok(checked > 40);
  });

  it('poucos contatos restantes: processa só os disponíveis, sem inventar contatos', async () => {
    const { campaignId, contactIds } = await run(4, 7);
    const summary = await t.app.campaigns.summary(campaignId);
    assert.equal(summary.counts.total, 7);
    assert.equal(summary.counts.sent, 7);
    assert.equal(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM send_attempts WHERE campaign_id = :c', { c: campaignId })!.n, 7);
    assert.equal(new Set(t.app.db.all<{ contact_id: string }>('SELECT contact_id FROM send_attempts').map((r) => r.contact_id)).size, contactIds.length);
    const cycles = t.app.distribution.snapshot(campaignId).past;
    const used = cycles.reduce((sum, c) => sum + c.quotas.reduce((s, q) => s + q.used, 0), 0);
    assert.equal(used, 7, 'vagas usadas = contatos reais');
  });

  it('logs registram início e finalização de cada ciclo com a distribuição e o intervalo', async () => {
    const { campaignId } = await run(2, 20);
    const logs = await t.app.logs.list({ campaignId, limit: 500 });
    const started = logs.filter((l) => l.message.startsWith('Ciclo') && l.message.includes('iniciado'));
    const finished = logs.filter((l) => l.message.startsWith('Ciclo') && l.message.includes('finalizado'));
    assert.ok(started.length > 0);
    assert.equal(finished.length, started.length, 'todo ciclo iniciado foi finalizado');
    assert.match(started[0]!.message, /intervalo 0\.0[2-5]s: Linha [12] → [2-5]/);
  });

  it('nenhuma linha selecionada: o disparo não inicia', async () => {
    t = await createTestApp();
    await t.app.messages.saveSlot(1, { body: 'Oi' });
    const { contactIds } = await t.app.contacts.import([{ phone: '21999990000' }]);
    const campaign = await t.app.campaigns.create({ name: 'Vazio', lineIds: [], contactIds });
    await assert.rejects(t.app.campaigns.execute(campaign.id, 'start'), /Selecione ao menos uma linha/);
  });
});
