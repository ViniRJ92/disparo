import { useEffect, useMemo, useState } from 'react';
import { History, Layers, ListChecks, RefreshCcw, Save, ShieldCheck, SlidersHorizontal, Trash2, Zap } from 'lucide-react';
import { api, messageOf } from '../api/client.ts';
import type { AppSettings, LineView } from '../api/types.ts';
import type { Section } from '../App.tsx';
import { useLiveResource } from '../hooks/useLiveResource.ts';
import { CAMPAIGN_STATUS_LABEL, LINE_STATUS_LABEL, OPERATIONAL_STATE_LABEL } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { MessagesPage } from './MessagesPage.tsx';
import { ScheduledPausePanel } from './ScheduledPausePanel.tsx';
import { PageHeader } from './ui.tsx';

type Tab = 'lines' | 'processing' | 'messages' | 'general';
const TABS: { id: Tab; label: string }[] = [
  { id: 'lines', label: 'Linhas' },
  { id: 'processing', label: 'Processamento' },
  { id: 'messages', label: 'Mensagens' },
  { id: 'general', label: 'Geral' },
];
const INTERVAL_OPTIONS = [2, 3, 4, 5, 6, 8];

interface SectionProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

/** Área de configurações. Tudo aqui é gravado no banco e sobrevive a recarregar a página ou reiniciar o sistema. */
export function SettingsPage({ onError, onNewDispatch, onNavigate }: { onError: (message: string) => void; onNewDispatch: () => void; onNavigate: (section: Section) => void }) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('settings.tab') as Tab | null) ?? 'processing';
    } catch {
      return 'processing';
    }
  });
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem('settings.tab', tab);
    } catch {
      /* preferência de tela apenas */
    }
  }, [tab]);

  return (
    <>
      <PageHeader
        title="Painel de Configurações"
        subtitle="Linhas, ciclos de envio, pausa programada e padrões do sistema. Tudo fica salvo e vale após reiniciar."
        actions={
          <div className="segmented primary" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        }
      />
      {notice && (
        <div className="notice">
          {notice}
          <button className="sm" onClick={() => setNotice(null)}>OK</button>
        </div>
      )}
      {tab === 'lines' && <LinesSettings onError={onError} onNotice={setNotice} />}
      {tab === 'processing' && <ProcessingSettings onError={onError} onNotice={setNotice} onNewDispatch={onNewDispatch} onNavigate={onNavigate} />}
      {tab === 'messages' && <MessagesPage onError={onError} />}
      {tab === 'general' && <GeneralSettings onError={onError} onNotice={setNotice} />}
    </>
  );
}

// ---------------------------------------------------------------- linhas

function LinesSettings({ onError, onNotice }: SectionProps) {
  const { data } = useLiveResource(api.overview, ['line.updated', 'line.removed']);
  const lines = data?.lineDetails ?? [];
  return (
    <section className="panel flush">
      <div className="panel-header" style={{ paddingBottom: 16, marginBottom: 0 }}>
        <div className="panel-title"><Layers size={18} /><h2>Linhas cadastradas</h2></div>
        <span className="small muted">Nome e limite diário de cada linha</span>
      </div>
      {lines.length === 0 ? (
        <p className="empty">Nenhuma linha cadastrada.</p>
      ) : (
        <div className="table-wrap">
          <table className="table settings-table">
            <thead>
              <tr><th>Nome</th><th>Conta</th><th>Status</th><th>Limite diário</th><th className="right">Ações</th></tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <LineSettingsRow key={line.id} line={line} onError={onError} onNotice={onNotice} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LineSettingsRow({ line, onError, onNotice }: SectionProps & { line: LineView }) {
  const [label, setLabel] = useState(line.label);
  const [dailyLimit, setDailyLimit] = useState(String(line.settings.dailyLimit));
  useEffect(() => {
    setLabel(line.label);
    setDailyLimit(String(line.settings.dailyLimit));
  }, [line.label, line.settings.dailyLimit]);

  const dirty = label.trim() !== line.label || Number(dailyLimit) !== line.settings.dailyLimit;
  const status = LINE_STATUS_LABEL[line.status];

  const save = async () => {
    try {
      await api.updateLine(line.id, { label: label.trim(), settings: { dailyLimit: Number(dailyLimit) } });
      onNotice(`"${label.trim()}" salva`);
    } catch (error) {
      onError(messageOf(error));
    }
  };

  const remove = async () => {
    if (!confirm(`Remover "${line.label}"? A linha será desconectada.`)) return;
    try {
      await api.removeLine(line.id);
      onNotice(`"${line.label}" removida`);
    } catch (error) {
      onError(messageOf(error));
    }
  };

  return (
    <tr>
      <td><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} aria-label={`Nome de ${line.label}`} /></td>
      <td className="mono">{line.accountId ?? '—'}</td>
      <td><Badge tone={status.tone}><span className="dot" />{status.text}</Badge></td>
      <td>
        <input type="number" min={1} className="input-narrow" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} aria-label={`Limite diário de ${line.label}`} />
      </td>
      <td>
        <div className="row-actions">
          <button className={`sm ${dirty ? 'primary' : ''}`} disabled={!dirty || !label.trim() || !(Number(dailyLimit) >= 1)} onClick={() => void save()}><Save size={14} /> Salvar</button>
          <button className="sm ghost danger" onClick={() => void remove()}><Trash2 size={14} /> Remover</button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- processamento

function ProcessingSettings({ onError, onNotice, onNewDispatch, onNavigate }: SectionProps & { onNewDispatch: () => void; onNavigate: (section: Section) => void }) {
  const { data: overview } = useLiveResource(api.overview, ['line.updated', 'line.removed']);
  const { data: campaignData } = useLiveResource(api.campaigns, ['campaign.updated']);
  const processes = useMemo(
    () => (campaignData?.campaigns ?? []).filter((c) => c.status === 'draft' || c.status === 'running' || c.status === 'paused'),
    [campaignData],
  );
  const [processId, setProcessId] = useState('');
  const process = processes.find((p) => p.id === processId) ?? null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const lines = overview?.lineDetails ?? [];

  useEffect(() => {
    api.settings().then(setSettings).catch((error) => onError(messageOf(error)));
  }, [onError]);
  useEffect(() => {
    if (!processId && processes.length > 0) setProcessId(processes[0]!.id);
  }, [processes, processId]);
  useEffect(() => {
    if (process) setSelected(new Set(process.lineIds));
    // Recarrega a seleção quando o processo muda ou a seleção salva muda no servidor.
  }, [processId, process?.lineIds.join(',')]);

  const dirty = process ? process.lineIds.length !== selected.size || process.lineIds.some((id) => !selected.has(id)) : false;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const saveSelection = async () => {
    if (!process) return;
    try {
      await api.setCampaignLines(process.id, [...selected]);
      onNotice(`Linhas de "${process.name}" salvas: ${selected.size}`);
    } catch (error) {
      onError(messageOf(error));
    }
  };

  const setPaused = async (line: LineView, paused: boolean) => {
    try {
      await api.lineCommand(line.id, paused ? 'pause' : 'resume');
    } catch (error) {
      onError(messageOf(error));
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-header" style={{ marginBottom: processes.length ? 18 : 0 }}>
          <div className="row" style={{ gap: 16, flexWrap: 'nowrap' }}>
            <span className="page-icon"><ListChecks size={22} /></span>
            <div>
              <div className="row">
                <span className="eyebrow">Linhas do processo</span>
                <Badge tone={processes.length ? 'ok' : 'muted'}><span className="dot" />{processes.length ? `${processes.length} processo(s) aberto(s)` : 'Sem processo aberto'}</Badge>
              </div>
              {processes.length === 0 ? (
                <>
                  <h3 style={{ marginTop: 4 }}>Nenhum processo em rascunho, em andamento ou pausado no momento.</h3>
                  <p className="small muted">{lines.filter((l) => l.available).length} linha(s) apta(s) para participar do próximo disparo.</p>
                </>
              ) : (
                <p className="small muted" style={{ marginTop: 4 }}>Escolha quais linhas participam e pause as que devem ficar de fora.</p>
              )}
            </div>
          </div>
          <div className="row">
            <button onClick={() => onNavigate('history')}><History size={15} /> Ver histórico</button>
            <button onClick={onNewDispatch}><Zap size={15} /> Novo disparo</button>
          </div>
        </div>
        {processes.length > 0 && (
          <>
            <div className="toolbar" style={{ marginBottom: 12 }}>
              <span className="toolbar-field">Processo</span>
              <select value={processId} onChange={(e) => setProcessId(e.target.value)}>
                {processes.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {CAMPAIGN_STATUS_LABEL[p.status].text}</option>
                ))}
              </select>
              <span className="spacer" />
              <button className="ghost sm" onClick={() => setSelected(new Set(lines.map((l) => l.id)))}>Selecionar todas</button>
              <button className="ghost sm" onClick={() => setSelected(new Set())}>Desmarcar todas</button>
              <button className={`sm ${dirty ? 'primary' : ''}`} disabled={!dirty} onClick={() => void saveSelection()}><Save size={14} /> Salvar seleção</button>
            </div>
            <div className="table-wrap" style={{ border: '1px solid var(--hairline)', borderRadius: 12 }}>
              <table className="table settings-table">
                <thead>
                  <tr><th>Participa</th><th>Linha</th><th>Status</th><th>Operacional</th><th>Pausada</th></tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const canToggle = line.runState === 'active' || line.runState === 'paused';
                    return (
                      <tr key={line.id}>
                        <td><input type="checkbox" checked={selected.has(line.id)} onChange={() => toggle(line.id)} aria-label={`${line.label} participa`} /></td>
                        <td><strong>{line.label}</strong></td>
                        <td><Badge tone={LINE_STATUS_LABEL[line.status].tone}><span className="dot" />{LINE_STATUS_LABEL[line.status].text}</Badge></td>
                        <td>
                          {OPERATIONAL_STATE_LABEL[line.operationalState]}
                          {line.pauseReason && <span className="muted small"> ({line.pauseReason === 'scheduled' ? 'programada' : 'manual'})</span>}
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            disabled={!canToggle}
                            checked={line.runState === 'paused'}
                            onChange={(e) => void setPaused(line, e.target.checked)}
                            aria-label={`${line.label} pausada`}
                            title={canToggle ? undefined : 'Inicie a linha para poder pausá-la'}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <div className="settings-layout">
        <div className="stack">
          <section className="setting-card">
            <div className="setting-card-head">
              <div className="row" style={{ flexWrap: 'nowrap', gap: 12 }}>
                <span className="kpi-icon ok"><ShieldCheck size={16} /></span>
                <div>
                  <h3>Pausa programada</h3>
                  <p className="small muted">Limite de envios por linha, com contador individual</p>
                </div>
              </div>
              {settings && (
                <Badge tone={settings.scheduledPause.enabled ? 'ok' : 'muted'}><span className="dot" />{settings.scheduledPause.enabled ? 'Ativa' : 'Desativada'}</Badge>
              )}
            </div>
            <div className="setting-block">
              <ScheduledPausePanel onError={onError} detailed />
            </div>
            <div className="grid-2">
              <div className="kv-list"><div><dt>Ao atingir o limite</dt><dd>Aguarda sua decisão</dd></div></div>
              <div className="kv-list"><div><dt>Contador</dt><dd className="ok-text">Zera ao continuar</dd></div></div>
            </div>
            <p className="small muted">Salvar uma alteração zera os contadores de todas as linhas.</p>
          </section>

          <CycleSettings onError={onError} onNotice={onNotice} onSaved={setSettings} />
        </div>

        <aside className="stack">
          <section className="setting-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 className="row"><SlidersHorizontal size={16} className="primary-text" /> Resumo atual</h3>
              <Badge tone="ok"><span className="dot" />Salvo</Badge>
            </div>
            {settings ? (
              <dl className="kv-list">
                <div><dt>Contatos por linha / ciclo</dt><dd>{settings.distribution.minBatch} a {settings.distribution.maxBatch}</dd></div>
                <div><dt>Intervalos do ciclo</dt><dd>{[...settings.distribution.cycleIntervalSeconds].sort((a, b) => a - b).map((s) => `${s}s`).join(', ')}</dd></div>
                <div><dt>Pausa programada</dt><dd>{settings.scheduledPause.enabled ? (settings.scheduledPause.limit === null ? 'Sem limite' : `${settings.scheduledPause.limit} por linha`) : 'Desativada'}</dd></div>
                <div><dt>Limite diário padrão</dt><dd>{settings.defaultLineSettings.dailyLimit} por linha</dd></div>
                <div><dt>Linhas aptas agora</dt><dd>{lines.filter((l) => l.available).length} de {lines.length}</dd></div>
              </dl>
            ) : (
              <p className="empty">Carregando…</p>
            )}
          </section>
          <section className="setting-card">
            <h3 className="row"><RefreshCcw size={16} className="info-text" /> Como os ciclos funcionam</h3>
            <ul className="check-list">
              <li><ShieldCheck size={15} /> Cada linha recebe uma quantidade sorteada, diferente da do ciclo anterior.</li>
              <li><ShieldCheck size={15} /> O ciclo inteiro usa um único intervalo, diferente do ciclo anterior.</li>
              <li><ShieldCheck size={15} /> Linhas pausadas ou desconectadas saem do ciclo sem perder contatos.</li>
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}

function CycleSettings({ onError, onNotice, onSaved }: SectionProps & { onSaved: (settings: AppSettings) => void }) {
  const [current, setCurrent] = useState<AppSettings['distribution'] | null>(null);
  const [minBatch, setMinBatch] = useState('2');
  const [maxBatch, setMaxBatch] = useState('5');
  const [intervals, setIntervals] = useState<number[]>([2, 3, 4, 5]);

  const load = (d: AppSettings['distribution']) => {
    setCurrent(d);
    setMinBatch(String(d.minBatch));
    setMaxBatch(String(d.maxBatch));
    setIntervals(d.cycleIntervalSeconds);
  };
  useEffect(() => {
    api.settings().then((s) => load(s.distribution)).catch((error) => onError(messageOf(error)));
  }, [onError]);
  if (!current) return null;

  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const dirty =
    Number(minBatch) !== current.minBatch ||
    Number(maxBatch) !== current.maxBatch ||
    sortedIntervals.join(',') !== [...current.cycleIntervalSeconds].sort((a, b) => a - b).join(',');

  const save = async () => {
    try {
      const saved = await api.updateSettings({ distribution: { minBatch: Number(minBatch), maxBatch: Number(maxBatch), cycleIntervalSeconds: sortedIntervals } });
      load(saved.distribution);
      onSaved(saved);
      onNotice('Configuração dos ciclos salva (vale a partir do próximo ciclo)');
    } catch (error) {
      onError(messageOf(error));
    }
  };

  const options = [...new Set([...INTERVAL_OPTIONS, ...current.cycleIntervalSeconds])].sort((a, b) => a - b);

  return (
    <section className="setting-card">
      <div className="setting-card-head">
        <div className="row" style={{ flexWrap: 'nowrap', gap: 12 }}>
          <span className="kpi-icon primary"><RefreshCcw size={16} /></span>
          <div>
            <h3>Ciclos de envio</h3>
            <p className="small muted">Quantidade sorteada por linha e intervalo sorteado por ciclo</p>
          </div>
        </div>
      </div>

      <div className="setting-block">
        <div className="setting-block-head">
          <span className="eyebrow">Quantidade por linha (sorteada a cada ciclo)</span>
          <span className="mono small muted">de {minBatch || '?'} a {maxBatch || '?'} envios</span>
        </div>
        <div className="inline-inputs">
          <label className="boxed-input">de <input type="number" min={1} value={minBatch} onChange={(e) => setMinBatch(e.target.value)} aria-label="Mínimo por linha" /> mínimo</label>
          <label className="boxed-input">até <input type="number" min={1} value={maxBatch} onChange={(e) => setMaxBatch(e.target.value)} aria-label="Máximo por linha" /> máximo</label>
          <span className="small muted">mensagens por linha antes de passar a vez</span>
        </div>
      </div>

      <div className="setting-block">
        <div className="setting-block-head">
          <span className="eyebrow">Intervalo do ciclo (segundos)</span>
          <Badge tone="ok">{sortedIntervals.length ? `Sorteio entre ${sortedIntervals.map((s) => `${s}s`).join(', ')}` : 'Escolha ao menos um'}</Badge>
        </div>
        <div className="inline-inputs">
          {options.map((seconds) => {
            const on = intervals.includes(seconds);
            return (
              <label key={seconds} className={`check-pill ${on ? 'is-on' : ''}`}>
                <input type="checkbox" checked={on} onChange={(e) => setIntervals((list) => (e.target.checked ? [...list, seconds] : list.filter((s) => s !== seconds)))} />
                {seconds}s
              </label>
            );
          })}
        </div>
        <p className="small muted">A cada ciclo é sorteado um dos intervalos marcados, diferente do ciclo anterior sempre que houver mais de um.</p>
      </div>

      <div className="setting-card-foot">
        <span className="mono small muted">Vale a partir do próximo ciclo</span>
        <button className={dirty ? 'primary' : ''} disabled={!dirty || intervals.length === 0} onClick={() => void save()}>
          <Save size={15} /> Salvar configurações de ciclo
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- geral

function GeneralSettings({ onError, onNotice }: SectionProps) {
  const [current, setCurrent] = useState<AppSettings | null>(null);
  const [maxLines, setMaxLines] = useState('10');
  const [country, setCountry] = useState('55');
  const [defaultDaily, setDefaultDaily] = useState('200');

  const load = (s: AppSettings) => {
    setCurrent(s);
    setMaxLines(String(s.maxLines));
    setCountry(s.defaultCountryCode);
    setDefaultDaily(String(s.defaultLineSettings.dailyLimit));
  };
  useEffect(() => {
    api.settings().then(load).catch((error) => onError(messageOf(error)));
  }, [onError]);
  if (!current) return null;

  const dirty =
    Number(maxLines) !== current.maxLines || country !== current.defaultCountryCode || Number(defaultDaily) !== current.defaultLineSettings.dailyLimit;

  const save = async () => {
    try {
      load(
        await api.updateSettings({
          maxLines: Number(maxLines),
          defaultCountryCode: country.trim(),
          defaultLineSettings: { dailyLimit: Number(defaultDaily) },
        }),
      );
      onNotice('Configurações gerais salvas');
    } catch (error) {
      onError(messageOf(error));
    }
  };

  return (
    <section className="setting-card settings-general">
      <div className="setting-card-head">
        <div className="row" style={{ flexWrap: 'nowrap', gap: 12 }}>
          <span className="kpi-icon primary"><SlidersHorizontal size={16} /></span>
          <div>
            <h3>Geral</h3>
            <p className="small muted">Padrões usados em todo o sistema</p>
          </div>
        </div>
      </div>
      <div className="form">
        <label>
          Máximo de linhas (1 a 10)
          <input type="number" min={1} max={10} value={maxLines} onChange={(e) => setMaxLines(e.target.value)} />
        </label>
        <label>
          DDI padrão para números sem código do país
          <input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={3} />
        </label>
        <label>
          Limite diário padrão para novas linhas
          <input type="number" min={1} value={defaultDaily} onChange={(e) => setDefaultDaily(e.target.value)} />
        </label>
      </div>
      <div className="setting-card-foot">
        <span className="small muted">Alterações ficam salvas no banco</span>
        <button className={dirty ? 'primary' : ''} disabled={!dirty} onClick={() => void save()}><Save size={15} /> Salvar</button>
      </div>
    </section>
  );
}
