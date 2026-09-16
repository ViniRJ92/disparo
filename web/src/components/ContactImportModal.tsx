import { useState } from 'react';
import { api, messageOf } from '../api/client.ts';
import type { CsvImportReport, CsvMapping, CsvPreview, CsvRowStatus } from '../api/types.ts';
import { formatNumber } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { Modal } from './Modal.tsx';

const STATUS_LABEL: Record<CsvRowStatus, { text: string; tone: 'ok' | 'info' | 'warn' | 'bad' }> = {
  new: { text: 'Novo', tone: 'ok' },
  existing: { text: 'Já cadastrado', tone: 'info' },
  duplicate: { text: 'Duplicado no arquivo', tone: 'warn' },
  invalid: { text: 'Inválido', tone: 'bad' },
};

const PREVIEW_LIMIT = 300;

/** Lê o arquivo como UTF-8; se vier com caracteres inválidos (CSV do Excel em ANSI), relê como Windows-1252. */
async function readCsvFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buffer) : utf8;
}

/**
 * Importação de contatos: arquivo CSV ou lista colada. Em ambos os casos há
 * mapeamento das colunas, pré-visualização com validação e confirmação.
 * Inválidos e duplicados são mostrados antes e depois da importação.
 */
export function ContactImportModal({ onClose }: { onClose: (changed: boolean) => void }) {
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [source, setSource] = useState<{ text: string; name: string } | null>(null);
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [report, setReport] = useState<CsvImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const loadPreview = (text: string, map?: CsvMapping) =>
    run(async () => {
      const result = await api.csvPreview(text, map);
      setPreview(result);
      setMapping(result.mapping);
      setReport(null);
    });

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const text = await readCsvFile(file);
      setSource({ text, name: file.name });
      const result = await api.csvPreview(text);
      setPreview(result);
      setMapping(result.mapping);
      setReport(null);
    });
  };

  const currentText = mode === 'file' ? source?.text : pasted;

  const changeMapping = (patch: Partial<CsvMapping>) => {
    if (!mapping || !currentText) return;
    const next = { ...mapping, ...patch };
    setMapping(next);
    void loadPreview(currentText, next);
  };

  const confirm = () =>
    currentText &&
    mapping &&
    run(async () => {
      setReport(await api.csvImport(currentText, mapping));
      setPreview(null);
    });

  const columnCount = preview ? Math.max(preview.columnCount, preview.headers.length, (mapping?.phoneColumn ?? 0) + 1, (mapping?.nameColumn ?? 0) + 1) : 0;
  const columnNames = (count: number) =>
    Array.from({ length: Math.max(count, preview?.headers.length ?? 0, 2) }, (_, i) => (preview?.headers[i] ? `${i + 1}: ${preview.headers[i]}` : `Coluna ${i + 1}`));
  const accepted = preview ? preview.summary.new + preview.summary.existing : 0;
  const shownRows = (preview?.rows ?? []).filter((r) => !onlyProblems || r.status === 'invalid' || r.status === 'duplicate');

  return (
    <Modal
      title="Importar contatos"
      onClose={() => onClose(report !== null)}
      footer={
        <>
          {preview && (
            <span className="muted small">
              {formatNumber(accepted)} serão importados · {formatNumber(preview.summary.duplicate + preview.summary.invalid)} com problema
            </span>
          )}
          <span className="spacer" />
          <button type="button" onClick={() => onClose(report !== null)}>Fechar</button>
          {preview && (
            <button type="button" className="primary" disabled={busy || accepted === 0} onClick={() => void confirm()}>
              Confirmar importação
            </button>
          )}
        </>
      }
    >
      <div className="form import-modal">
        <div className="tabs">
          <button className={mode === 'file' ? 'tab is-active' : 'tab'} onClick={() => { setMode('file'); setPreview(null); }}>Arquivo CSV</button>
          <button className={mode === 'paste' ? 'tab is-active' : 'tab'} onClick={() => { setMode('paste'); setPreview(null); }}>Colar lista</button>
        </div>

        {mode === 'file' ? (
          <label>
            Arquivo CSV (separado por ; , ou tabulação)
            <input type="file" accept=".csv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
            {source && <span className="muted small">{source.name}</span>}
          </label>
        ) : (
          <>
            <label>
              Cole a lista (um contato por linha)
              <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'Nome;Telefone\nJoão Silva;21 99999-0001\nMaria;(21) 98888-0002'} />
            </label>
            <button type="button" disabled={busy || !pasted.trim()} onClick={() => void loadPreview(pasted)}>Pré-visualizar</button>
          </>
        )}

        {preview && mapping && (
          <>
            <div className="form-row mapping">
              <label>
                Coluna do telefone
                <select value={mapping.phoneColumn} onChange={(e) => changeMapping({ phoneColumn: Number(e.target.value) })}>
                  {columnNames(columnCount).map((name, i) => <option key={i} value={i}>{name}</option>)}
                </select>
              </label>
              <label>
                Coluna do nome
                <select value={mapping.nameColumn ?? ''} onChange={(e) => changeMapping({ nameColumn: e.target.value === '' ? null : Number(e.target.value) })}>
                  <option value="">Sem nome</option>
                  {columnNames(columnCount).map((name, i) => <option key={i} value={i}>{name}</option>)}
                </select>
              </label>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => changeMapping({ hasHeader: e.target.checked })} />
              A primeira linha é o cabeçalho
            </label>

            <div className="import-summary">
              {(Object.keys(STATUS_LABEL) as CsvRowStatus[]).map((status) => (
                <Badge key={status} tone={STATUS_LABEL[status].tone}>
                  {STATUS_LABEL[status].text}: {formatNumber(preview.summary[status])}
                </Badge>
              ))}
              <label className="check-row small">
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
                Mostrar só problemas
              </label>
            </div>

            <div className="table-wrap preview-table">
              <table className="table">
                <thead>
                  <tr><th>Linha</th><th>Nome</th><th>Telefone (arquivo)</th><th>Telefone (normalizado)</th><th>Situação</th><th>Observação</th></tr>
                </thead>
                <tbody>
                  {shownRows.slice(0, PREVIEW_LIMIT).map((row) => (
                    <tr key={row.line}>
                      <td>{row.line}</td>
                      <td>{row.name ?? '—'}</td>
                      <td className="mono">{row.rawPhone || '—'}</td>
                      <td className="mono">{row.phone ?? '—'}</td>
                      <td><Badge tone={STATUS_LABEL[row.status].tone}>{STATUS_LABEL[row.status].text}</Badge></td>
                      <td className="small">{row.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shownRows.length > PREVIEW_LIMIT && (
                <p className="muted small">Mostrando {PREVIEW_LIMIT} de {formatNumber(shownRows.length)} linhas; todas serão consideradas na importação.</p>
              )}
            </div>
          </>
        )}

        {error && <p className="line-error">{error}</p>}

        {report && (
          <div className="notice import-report">
            <div>
              <strong>Importação concluída:</strong> {formatNumber(report.created)} novo(s), {formatNumber(report.updated)} já cadastrado(s) atualizado(s).
            </div>
            {report.duplicates.length > 0 && (
              <div>
                Duplicados no arquivo (não importados novamente): linhas {report.duplicates.map((r) => r.line).join(', ')}
              </div>
            )}
            {report.invalidRows.length > 0 && (
              <div>
                Inválidos (não importados): {report.invalidRows.map((r) => `linha ${r.line} (${r.rawPhone || 'vazio'})`).join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
