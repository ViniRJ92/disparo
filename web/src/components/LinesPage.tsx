import { useEffect, useMemo, useState } from 'react';
import { FastForward, LayoutGrid, List, Pause, PauseCircle, Play, PlayCircle, Plus, PlusCircle, Rocket, Save, Server } from 'lucide-react';
import { api, messageOf } from '../api/client.ts';
import type { BulkLineCommand, LineCommand, LinesSummary, LineView, WorkerSnapshot } from '../api/types.ts';
import { useLiveResource } from '../hooks/useLiveResource.ts';
import { CAMPAIGN_STATUS_LABEL, CONNECTION_LABEL, formatDateTime, formatNumber, LINE_STATUS_LABEL, OPERATIONAL_STATE_LABEL } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { actionsFor, LineCard } from './LineCard.tsx';
import { LineConfigModal } from './LineConfigModal.tsx';
import { ProcessControlBar } from './ProcessControlBar.tsx';
import { ScheduledPausePanel } from './ScheduledPausePanel.tsx';
import { PageHeader, percent, Progress, ratio } from './ui.tsx';

interface Props {
  lines: LineView[];
  summary: LinesSummary;
  workers: WorkerSnapshot[];
  onNewDispatch: () => void;
  onError: (message: string) => void;
}

const BULK: { command: BulkLineCommand; label: string; done: string; icon: React.ReactNode }[] = [
  { command: 'start', label: 'Iniciar selecionadas', done: 'iniciada(s)', icon: <Play size={14} /> },
  { command: 'pause', label: 'Pausar selecionadas', done: 'pausada(s)', icon: <Pause size={14} /> },
  { command: 'resume', label: 'Retomar selecionadas', done: 'retomada(s)', icon: <FastForward size={14} /> },
];

const sameSet = (a: ReadonlySet<string>, b: readonly string[]) => a.size === b.length && b.every((id) => a.has(id));

function readView(): 'grid' | 'list' {
  try {
    return localStorage.getItem('lines.view') === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/**
 * Área "Linhas": um card por linha (1..N), controle individual, seleção de
 * linhas por processo e comandos globais aplicados somente às selecionadas.
 */
export function LinesPage({ lines, summary, workers, onNewDispatch, onError }: Props) {
  const { data: campaignData } = useLiveResource(api.campaigns, ['campaign.updated']);
  const processes = useMemo(
    () => (campaignData?.campaigns ?? []).filter((c) => c.status !== 'completed' && c.status !== 'cancelled'),
    [campaignData],
  );

  const [processId, setProcessId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [configuring, setConfiguring] = useState<LineView | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setViewState] = useState<'grid' | 'list'>(readView);
  const setView = (next: 'grid' | 'list') => {
    setViewState(next);
    try {
      localStorage.setItem('lines.view', next);
    } catch {
      /* preferência de tela apenas */
    }
  };

  const selectedProcess = processes.find((p) => p.id === processId) ?? null;
  const workerOf = useMemo(() => new Map(workers.map((w) => [w.lineId, w])), [workers]);
  const selectionDirty = selectedProcess ? !sameSet(selected, selectedProcess.lineIds) : false;

  // Um único disparo em andamento: já abre selecionado para controle imediato.
  useEffect(() => {
    if (processId) return;
    const running = processes.filter((p) => p.status === 'running');
    if (running.length === 1) setProcessId(running[0]!.id);
  }, [processes, processId]);

  // Números por linha do disparo selecionado, atualizados em tempo real.
  const detail = useLiveResource(
    () => (processId ? api.campaignDetail(processId) : Promise.resolve(null)),
    ['send.recorded', 'campaign.updated', 'line.updated'],
  );
  useEffect(() => {
    void detail.reload();
  }, [processId, detail.reload]);
  const processDetail = detail.data && detail.data.id === processId ? detail.data : null;
  const countsByLine = new Map((processDetail?.lines ?? []).map((l) => [l.line.id, l.counts]));

  // Ao escolher um processo, a seleção passa a refletir as linhas dele.
  useEffect(() => {
    if (selectedProcess) setSelected(new Set(selectedProcess.lineIds));
  }, [processId]);

  // Linhas removidas saem da seleção.
  useEffect(() => {
    const existing = new Set(lines.map((l) => l.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => existing.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [lines]);

  const withBusy = async (ids: string[], work: () => Promise<void>) => {
    setBusyIds((current) => new Set([...current, ...ids]));
    try {
      await work();
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusyIds((current) => new Set([...current].filter((id) => !ids.includes(id))));
    }
  };

  const toggle = (line: LineView) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(line.id)) next.delete(line.id);
      else next.add(line.id);
      return next;
    });

  const command = (line: LineView, cmd: LineCommand) =>
    withBusy([line.id], async () => {
      await api.lineCommand(line.id, cmd);
    });

  const bulk = (cmd: (typeof BULK)[number]) => {
    const ids = [...selected];
    return withBusy(ids, async () => {
      const { results } = await api.bulkLineCommand(ids, cmd.command);
      const done = results.filter((r) => r.outcome === 'done').length;
      const skipped = results.filter((r) => r.outcome === 'skipped').length;
      const failed = results.filter((r) => r.outcome === 'failed');
      setNotice(
        `${done} ${cmd.done}` +
          (skipped ? `, ${skipped} ignorada(s) pelo estado atual` : '') +
          (failed.length ? `, ${failed.length} com falha: ${failed.map((f) => f.message).join('; ')}` : ''),
      );
    });
  };

  /** Pausar/retomar TODAS as linhas cadastradas (cada uma de forma independente). */
  const globalAll = (kind: 'pause' | 'resume') =>
    withBusy(lines.map((l) => l.id), async () => {
      const { results } = kind === 'pause' ? await api.pauseAllLinesGlobal() : await api.resumeAllLinesGlobal();
      const done = results.filter((r) => r.outcome === 'done').length;
      setNotice(`${done} linha(s) ${kind === 'pause' ? 'pausada(s)' : 'retomada(s)'}`);
    });

  const saveSelection = () =>
    selectedProcess &&
    withBusy(['selection'], async () => {
      await api.setCampaignLines(selectedProcess.id, [...selected]);
      setNotice(`Seleção salva: ${selected.size} linha(s) participam de "${selectedProcess.name}"`);
    });

  const nextLabel = `Linha ${String(lines.length + 1).padStart(2, '0')}`;
  const createLine = (event?: React.FormEvent) => {
    event?.preventDefault();
    const label = newLabel.trim() || nextLabel;
    return withBusy(['new'], async () => {
      await api.createLine(label);
      setNewLabel('');
    });
  };

  const full = summary.total >= summary.max;
  const connected = lines.filter((l) => l.connectionStatus === 'connected');
  const totalSent = lines.reduce((sum, l) => sum + l.counters.messagesSent, 0);
  const totalFailed = lines.reduce((sum, l) => sum + l.counters.failures, 0);
  const activeCount = lines.filter((l) => l.status === 'active').length;

  return (
    <>
      <PageHeader
        icon={<Server size={22} />}
        title="Gestão Operacional de Linhas"
        badge={<Badge tone="muted">{activeCount}/{summary.max} ativas</Badge>}
        subtitle="Conexões WhatsApp em rotação por ciclos entre as linhas selecionadas."
        actions={
          <>
            <div className="capacity">
              <div className="capacity-head"><span>Capacidade</span><span className="ok-text num">{summary.total}/{summary.max} · {percent(summary.total, summary.max)}</span></div>
              <Progress value={ratio(summary.total, summary.max)} />
            </div>
            <form className="row" onSubmit={createLine}>
              <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder={nextLabel} maxLength={60} disabled={full} aria-label="Nome da nova linha" />
              <button type="submit" className="success" disabled={full || busyIds.has('new')}>
                <Plus size={15} /> {full ? `Limite de ${summary.max}` : 'Adicionar linha'}
              </button>
            </form>
            <button className="soft" onClick={onNewDispatch}><Rocket size={15} /> Novo disparo</button>
          </>
        }
      />

      <div className="control-row">
        <div className="control-card">
          <span className="toolbar-field">Processo:</span>
          <select value={processId} onChange={(e) => setProcessId(e.target.value)} style={{ flex: 1, minWidth: 180 }}>
            <option value="">Nenhum (seleção livre)</option>
            {processes.map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {CAMPAIGN_STATUS_LABEL[p.status].text}</option>
            ))}
          </select>
          <button className="ghost sm" onClick={() => setSelected(new Set(lines.map((l) => l.id)))}>Selecionar todas</button>
          <button className="ghost sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>Desmarcar</button>
          {selectedProcess && (
            <button className={`sm ${selectionDirty ? 'primary' : ''}`} disabled={!selectionDirty || busyIds.has('selection')} onClick={saveSelection}>
              <Save size={14} /> {selectionDirty ? 'Salvar seleção' : 'Seleção salva'}
            </button>
          )}
        </div>
        <div className="control-card">
          <ScheduledPausePanel onError={onError} />
        </div>
      </div>

      <div className="action-row">
        <span className="select-count">{selected.size} selecionada(s)</span>
        {BULK.map((cmd) => (
          <button key={cmd.command} className="ghost sm" disabled={selected.size === 0} onClick={() => void bulk(cmd)}>
            {cmd.icon} {cmd.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="sm" onClick={() => void globalAll('pause')}><PauseCircle size={14} /> Pausar todas</button>
        <button className="sm" onClick={() => void globalAll('resume')}><PlayCircle size={14} /> Retomar todas</button>
        <div className="segmented" role="group" aria-label="Modo de exibição">
          <button className={view === 'grid' ? 'is-active' : ''} onClick={() => setView('grid')} title="Cards"><LayoutGrid size={15} /></button>
          <button className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')} title="Lista"><List size={15} /></button>
        </div>
      </div>

      {processDetail && <ProcessControlBar process={processDetail} onNotice={setNotice} onError={onError} />}

      {notice && (
        <div className="notice">
          {notice}
          <button className="sm" onClick={() => setNotice(null)}>OK</button>
        </div>
      )}

      {lines.length > 0 && (
        <div className="summary-strip">
          <div className="avatar-stack">
            {lines.map((l, i) => (
              <span key={l.id} className={`avatar ${l.connectionStatus === 'connected' ? '' : 'is-off'}`} title={l.label}>L{i + 1}</span>
            ))}
          </div>
          <div className="cell-stack">
            <strong>{connected.length} linha(s) conectada(s) de {lines.length}</strong>
            <span className="cell-sub">{activeCount} ativa(s) · {lines.filter((l) => l.status === 'paused').length} pausada(s) · {lines.filter((l) => l.status === 'error').length} com erro</span>
          </div>
          <span className="spacer" />
          <span className="row small"><span className="dot ok-text" /> Total enviado: <b className="num">{formatNumber(totalSent)}</b></span>
          <span className="row small"><span className="dot info-text" /> Taxa de entrega: <b className="info-text num">{percent(totalSent, totalSent + totalFailed)}</b></span>
        </div>
      )}

      {lines.length === 0 && full ? (
        <p className="empty">Nenhuma linha cadastrada.</p>
      ) : view === 'grid' ? (
        <div className="line-grid">
          {lines.map((line) => (
            <LineCard
              key={line.id}
              line={line}
              worker={workerOf.get(line.id) ?? null}
              processCounts={selectedProcess?.lineIds.includes(line.id) ? (countsByLine.get(line.id) ?? null) : null}
              processName={selectedProcess?.name ?? null}
              participating={selectedProcess ? selectedProcess.lineIds.includes(line.id) : null}
              selected={selected.has(line.id)}
              busy={busyIds.has(line.id)}
              onToggleSelected={toggle}
              onCommand={command}
              onConfigure={setConfiguring}
            />
          ))}
          {!full && (
            <div className="add-card">
              <span className="add-card-icon"><PlusCircle size={22} /></span>
              <h3>Adicionar nova linha</h3>
              <p className="small">Cadastre a {nextLabel} e conecte o número pelo QR Code.</p>
              <button className="sm" disabled={busyIds.has('new')} onClick={() => void createLine()}><Plus size={14} /> Criar {nextLabel}</button>
              <span className="chip">{summary.max - summary.total} vaga(s) livre(s)</span>
            </div>
          )}
        </div>
      ) : (
        <section className="panel flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>Linha</th>
                  <th>Status</th>
                  <th>Conexão</th>
                  <th>Operacional</th>
                  <th className="right">Enviadas</th>
                  <th className="right">Falhas</th>
                  <th className="right">Pendentes</th>
                  <th>Último envio</th>
                  <th className="right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const status = LINE_STATUS_LABEL[line.status];
                  const busy = busyIds.has(line.id);
                  return (
                    <tr key={line.id}>
                      <td><input type="checkbox" checked={selected.has(line.id)} onChange={() => toggle(line)} aria-label={`Selecionar ${line.label}`} /></td>
                      <td><div className="cell-stack"><strong>{line.label}</strong><span className="cell-sub mono">{line.accountId ?? 'Conta não identificada'}</span></div></td>
                      <td><Badge tone={status.tone}><span className="dot" />{status.text}</Badge></td>
                      <td>{CONNECTION_LABEL[line.connectionStatus]}</td>
                      <td>{OPERATIONAL_STATE_LABEL[line.operationalState]}{line.pauseReason && <span className="muted small"> ({line.pauseReason === 'scheduled' ? 'programada' : 'manual'})</span>}</td>
                      <td className="right num">{formatNumber(line.counters.messagesSent)}</td>
                      <td className="right num">{formatNumber(line.counters.failures)}</td>
                      <td className="right num">{formatNumber(line.pending)}</td>
                      <td className="small">{formatDateTime(line.activity.lastSentAt)}</td>
                      <td>
                        <div className="row-actions">
                          {actionsFor(line).map(({ command: cmd, label, danger }) => (
                            <button key={cmd} className={`sm ${danger ? 'danger' : ''}`} disabled={busy} onClick={() => void command(line, cmd)}>{label}</button>
                          ))}
                          <button className="sm ghost" disabled={busy} onClick={() => setConfiguring(line)}>Configurar</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {configuring && <LineConfigModal line={configuring} onClose={() => setConfiguring(null)} />}
    </>
  );
}
