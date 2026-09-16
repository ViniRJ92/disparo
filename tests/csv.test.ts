import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildServer } from '../src/server/api/server.ts';
import { suggestMapping } from '../src/server/modules/contacts/contact-csv-import.ts';
import { detectDelimiter, parseCsv, toCsv } from '../src/server/modules/exports/csv.ts';
import type { LineView } from '../src/server/modules/lines/line.types.ts';
import { createTestApp, waitFor, type TestApp } from './helpers.ts';

const FAST = { minIntervalSeconds: 0, maxIntervalSeconds: 0 };

/** Lê o CSV exportado (sem BOM) como lista de objetos por cabeçalho. */
function readExport(csv: string): Record<string, string>[] {
  assert.ok(csv.startsWith('﻿'), 'UTF-8 com BOM (abre acentuado no Excel)');
  const [headers, ...rows] = parseCsv(csv, ';');
  return rows.map((row) => Object.fromEntries(headers!.map((h, i) => [h, row[i] ?? ''])));
}

describe('CSV: leitura e gravação', () => {
  it('lê aspas, separador dentro de campo e quebra de linha; detecta ; , e tab', () => {
    const text = 'nome;telefone\r\n"Silva; João";"21 99999-0001"\r\n"Ana ""Aninha""";21988880002\n"Linha\nquebrada";2197777\n\n';
    assert.equal(detectDelimiter(text), ';');
    assert.deepEqual(parseCsv(text), [
      ['nome', 'telefone'],
      ['Silva; João', '21 99999-0001'],
      ['Ana "Aninha"', '21988880002'],
      ['Linha\nquebrada', '2197777'],
    ]);
    assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
    assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  });

  it('grava com ; e escapa aspas/quebras; neutraliza fórmulas', () => {
    const csv = toCsv(['A', 'B'], [['=SOMA(1)', 'texto; com "aspas"'], ['+55 21', null]]);
    assert.equal(csv, "﻿A;B\r\n'=SOMA(1);\"texto; com \"\"aspas\"\"\"\r\n'+55 21;\r\n");
  });

  it('sugere o mapeamento pelo cabeçalho ou pelo conteúdo', () => {
    assert.deepEqual(suggestMapping([['Nome', 'Celular'], ['Ana', '21999990000']]), { phoneColumn: 1, nameColumn: 0, hasHeader: true });
    assert.deepEqual(suggestMapping([['21999990000', 'Ana']]), { phoneColumn: 0, nameColumn: 1, hasHeader: false });
  });
});

describe('CSV: importação de contatos com pré-visualização', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  const FILE = [
    'Nome;WhatsApp;Cidade',
    'Ana;(21) 99999-0001;Rio',
    'Bruno;21999990002;Niterói',
    'Ana repetida;+55 21 99999-0001;Rio',
    'Carla;123;Rio',
    'Sem telefone;;Rio',
    'Diego;21 98888-0003;Rio',
  ].join('\r\n');

  it('prévia classifica válidos, já cadastrados, duplicados e inválidos sem gravar nada', async () => {
    t = await createTestApp();
    const diego = await t.app.contacts.create({ name: 'Diego', phone: '21988880003' });
    await t.app.contacts.update(diego.id, { status: 'blocked' });

    const preview = await t.app.contactCsv.preview(FILE);
    assert.deepEqual(preview.mapping, { phoneColumn: 1, nameColumn: 0, hasHeader: true });
    assert.deepEqual(preview.headers, ['Nome', 'WhatsApp', 'Cidade']);
    assert.deepEqual(preview.summary, { new: 2, existing: 1, duplicate: 1, invalid: 2 });
    assert.deepEqual(
      preview.rows.map((r) => [r.line, r.name, r.status, r.note]),
      [
        [2, 'Ana', 'new', null],
        [3, 'Bruno', 'new', null],
        [4, 'Ana repetida', 'duplicate', 'Mesmo telefone da linha 2 do arquivo'],
        [5, 'Carla', 'invalid', 'Telefone inválido'],
        [6, 'Sem telefone', 'invalid', 'Telefone vazio'],
        [7, 'Diego', 'existing', 'Já cadastrado e BLOQUEADO (continua bloqueado)'],
      ],
    );
    assert.equal(await t.app.contacts.count(), 1, 'a prévia não grava nada');
  });

  it('confirmação importa só os válidos e devolve inválidos e duplicados (nada é descartado em silêncio)', async () => {
    t = await createTestApp();
    await t.app.contacts.create({ name: 'Diego', phone: '21988880003' });
    const report = await t.app.contactCsv.import(FILE, { phoneColumn: 1, nameColumn: 0, hasHeader: true });

    assert.equal(report.created, 2);
    assert.equal(report.updated, 1);
    assert.deepEqual(report.duplicates.map((r) => r.line), [4]);
    assert.deepEqual(report.invalidRows.map((r) => [r.line, r.rawPhone]), [[5, '123'], [6, '']]);
    assert.equal(await t.app.contacts.count(), 3, 'sem duplicar contatos');
    const ana = (await t.app.contacts.list({ search: '999990001' }))[0]!;
    assert.equal(ana.name, 'Ana', 'vale a primeira ocorrência do arquivo');
  });

  it('mapeamento escolhido pelo usuário: sem cabeçalho e colunas invertidas', async () => {
    t = await createTestApp();
    const file = '21999990005,Eva\n21999990006,Fabio';
    const preview = await t.app.contactCsv.preview(file, { phoneColumn: 0, nameColumn: 1, hasHeader: false });
    assert.deepEqual(preview.rows.map((r) => [r.line, r.name, r.phone, r.status]), [
      [1, 'Eva', '5521999990005', 'new'],
      [2, 'Fabio', '5521999990006', 'new'],
    ]);
    await assert.rejects(t.app.contactCsv.preview(file, { phoneColumn: 5, nameColumn: null, hasHeader: false }), /Coluna mapeada não existe/);
  });

  it('API: pré-visualizar e importar', async () => {
    t = await createTestApp();
    const server = await buildServer(t.app);
    try {
      const preview = await server.inject({ method: 'POST', url: '/api/contacts/csv/preview', payload: { csv: FILE } });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json().summary.invalid, 2);
      const imported = await server.inject({
        method: 'POST',
        url: '/api/contacts/csv/import',
        payload: { csv: FILE, mapping: preview.json().mapping },
      });
      assert.equal(imported.json().created, 3);
      assert.equal(imported.json().invalidRows.length, 2);
      assert.equal((await server.inject({ method: 'POST', url: '/api/contacts/csv/preview', payload: { csv: '' } })).statusCode, 400);
    } finally {
      await server.close();
    }
  });
});

describe('CSV: exportação de enviados, falhas, pendentes e histórico', () => {
  let t: TestApp;

  afterEach(async () => {
    await t?.app.close();
  });

  /** Duas linhas renomeadas (uma sempre falha), um disparo concluído e um rascunho com pendentes. */
  async function scenario() {
    t = await createTestApp();
    const secretaria = await t.app.lines.create({ label: 'Linha 1', provider: 'mock', providerConfig: { accountId: '5521900000001' }, settings: FAST });
    const atendimento = await t.app.lines.create({ label: 'Linha 2', provider: 'mock', providerConfig: { failSend: true }, settings: FAST });
    await t.app.lines.update(secretaria.id, { label: 'Secretaria' });
    await t.app.lines.update(atendimento.id, { label: 'Atendimento' });
    for (const line of [secretaria, atendimento]) await t.app.lines.start(line.id);
    await t.app.messages.saveSlot(1, { body: 'Olá {{nome}}, versão 1' });
    const { contactIds } = await t.app.contacts.import(
      Array.from({ length: 20 }, (_, i) => ({ phone: `552194${String(i).padStart(7, '0')}`, name: `Pessoa ${i}` })),
    );
    const done = await t.app.campaigns.create({ name: 'Setembro', lineIds: [secretaria.id, atendimento.id], contactIds: contactIds.slice(0, 16), start: true });
    await waitFor(async () => (await t.app.campaigns.summary(done.id)).status === 'completed', 5000, 'conclusão');
    const draft = await t.app.campaigns.create({ name: 'Outubro', lineIds: [secretaria.id], contactIds: contactIds.slice(16) });
    return { secretaria, atendimento, done, draft, contactIds };
  }

  it('enviados: colunas pedidas, nome personalizado, ciclo e texto realmente enviado', async () => {
    const { secretaria } = await scenario();
    await t.app.messages.saveSlot(1, { body: 'Texto editado depois' });
    const rows = readExport(t.app.exports.export('sent').csv);
    assert.ok(rows.length > 0);
    assert.deepEqual(Object.keys(rows[0]!), [
      'Nome', 'Telefone', 'ID do contato', 'Linha', 'Nome personalizado da linha', 'Mensagem utilizada', 'Data', 'Hora',
      'Status', 'Campanha/disparo', 'Ciclo', 'Intervalo do ciclo (s)', 'Texto enviado',
    ]);
    for (const row of rows) {
      assert.equal(row['Nome personalizado da linha'], 'Secretaria');
      assert.equal(row.Linha, '5521900000001');
      assert.equal(row.Status, 'Enviado');
      assert.equal(row['Campanha/disparo'], 'Setembro');
      assert.match(row.Ciclo!, /^\d+$/);
      assert.match(row.Data!, /^\d{2}\/\d{2}\/\d{4}$/);
      assert.match(row.Hora!, /^\d{2}:\d{2}:\d{2}$/);
      assert.match(row['Texto enviado']!, /^Olá Pessoa \d+, versão 1$/, 'edição posterior não altera o registro');
    }
    const dbSent = t.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM send_attempts WHERE result = 'sent'")!.n;
    assert.equal(rows.length, dbSent);
    assert.equal(t.app.exports.count('sent', { lineId: secretaria.id }), dbSent);
  });

  it('falhas: motivo, erro retornado, tentativas, linha e ciclo', async () => {
    const { atendimento } = await scenario();
    const rows = readExport(t.app.exports.export('failed').csv);
    assert.ok(rows.length > 0);
    assert.deepEqual(Object.keys(rows[0]!), [
      'Nome', 'Telefone', 'ID do contato', 'Linha', 'Nome personalizado da linha', 'Data', 'Hora', 'Status', 'Motivo da falha',
      'Código do erro', 'Erro retornado', 'Tentativas', 'Campanha/disparo', 'Ciclo', 'Mensagem utilizada', 'Situação atual do contato no disparo',
    ]);
    for (const row of rows) {
      assert.equal(row['Nome personalizado da linha'], 'Atendimento');
      assert.equal(row.Linha, (await t.app.lines.status(atendimento.id)).accountId, 'identificação da conta conectada');
      assert.equal(row['Motivo da falha'], 'Falha definitiva');
      assert.equal(row['Erro retornado'], 'Falha simulada de envio');
      assert.equal(row.Tentativas, '1');
      assert.match(row.Ciclo!, /^\d+$/);
    }
    assert.equal(rows.length, t.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM send_attempts WHERE result = 'failed'")!.n);
  });

  it('pendentes: contatos ainda na fila, com status aguardando (rascunho) e por linha da fila compartilhada', async () => {
    const { secretaria, atendimento, draft } = await scenario();
    const rows = readExport(t.app.exports.export('pending').csv);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r['Campanha/disparo'] === 'Outubro' && r.Status === 'Aguardando'));
    assert.equal(t.app.exports.count('pending', { lineId: secretaria.id }), 4, 'Secretaria participa do Outubro');
    assert.equal(t.app.exports.count('pending', { lineId: atendimento.id }), 0, 'Atendimento não participa');
    assert.equal(t.app.exports.count('pending', { status: 'waiting' }), 4);
    assert.equal(t.app.exports.count('pending', { status: 'pending' }), 0);

    await t.app.campaigns.execute(draft.id, 'start');
    await waitFor(() => t.app.exports.count('pending') === 0, 5000, 'fila esvaziada');
  });

  it('histórico e filtros: período, linha, status, disparo, contato e mensagem', async () => {
    const { secretaria, atendimento, done, contactIds } = await scenario();
    const total = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM send_attempts')!.n;
    const today = new Date();
    const day = (offset: number) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    assert.equal(t.app.exports.count('history'), total);
    assert.equal(t.app.exports.count('history', { from: day(0), to: day(0) }), total, 'período de hoje');
    assert.equal(t.app.exports.count('history', { from: day(1) }), 0, 'período futuro');
    assert.equal(t.app.exports.count('history', { to: day(-1) }), 0, 'período passado');
    assert.equal(
      t.app.exports.count('history', { lineId: secretaria.id }) + t.app.exports.count('history', { lineId: atendimento.id }),
      total,
      'por linha soma o total',
    );
    assert.equal(t.app.exports.count('history', { status: 'failed' }), t.app.exports.count('failed'));
    assert.equal(t.app.exports.count('history', { campaignId: done.id }), total);
    assert.equal(t.app.exports.count('history', { campaignId: 'outro' }), 0);
    const one = await t.app.contacts.get(contactIds[0]!);
    assert.equal(t.app.exports.count('history', { contact: one.id }), 1);
    assert.equal(t.app.exports.count('history', { contact: one.phone }), 1);
    assert.equal(t.app.exports.count('history', { message: 'Mensagem 01' }), total);
    assert.equal(t.app.exports.count('history', { message: 'Mensagem 05' }), 0);
    assert.throws(() => t.app.exports.count('history', { from: '16/09/2026' }), /Data inicial inválida/);
    assert.throws(() => t.app.exports.count('history', { status: 'pending' }), /Status do histórico/);

    const perLine = readExport(t.app.exports.export('history', { lineId: atendimento.id }).csv);
    assert.ok(perLine.every((r) => r['Nome personalizado da linha'] === 'Atendimento'), 'CSV por linha só tem a linha');
  });

  it('API: download com nome do arquivo pela linha, contagem e validação', async () => {
    const { secretaria } = await scenario();
    const server = await buildServer(t.app);
    try {
      const res = await server.inject({ method: 'GET', url: `/api/exports/sent.csv?lineId=${secretaria.id}` });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /text\/csv/);
      assert.match(res.headers['content-disposition'] as string, /attachment; filename="enviados_Secretaria_\d{4}-\d{2}-\d{2}\.csv"/);
      assert.equal(Number(res.headers['x-export-rows']), readExport(res.body).length);

      const count = await server.inject({ method: 'GET', url: '/api/exports/failed/count' });
      assert.equal(count.json().kind, 'failed');
      assert.equal((await server.inject({ method: 'GET', url: '/api/exports/tudo.csv' })).statusCode, 400);
      assert.equal((await server.inject({ method: 'GET', url: '/api/exports/history.csv?from=ontem' })).statusCode, 400);
    } finally {
      await server.close();
    }
  });

  it('renomear a linha: aparece no histórico, no Dashboard e nas exportações, e fica registrado no log', async () => {
    const { secretaria } = await scenario();
    await t.app.lines.update(secretaria.id, { label: 'Recepção' });
    const history = await t.app.history.list({ lineId: secretaria.id, limit: 1 });
    assert.equal(history[0]!.lineLabel, 'Recepção');
    assert.equal(history[0]!.lineLabelAtSend, 'Secretaria', 'o registro guarda o nome da época');
    assert.equal((await t.app.dashboard.dashboard()).perLine.find((r) => r.lineId === secretaria.id)!.label, 'Recepção');
    assert.ok(readExport(t.app.exports.export('sent').csv).every((r) => r['Nome personalizado da linha'] === 'Recepção'));
    const logs = await t.app.logs.list({ lineId: secretaria.id, limit: 50 });
    assert.ok(logs.some((l) => l.message === 'Linha renomeada: "Secretaria" → "Recepção"'));
    const view: LineView = await t.app.lines.status(secretaria.id);
    assert.equal(view.accountId, '5521900000001', 'renomear não altera a identidade da conta');
  });
});
