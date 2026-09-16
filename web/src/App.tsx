import { useState } from 'react';
import { Send, Zap } from 'lucide-react';
import { ContactsPage } from './components/ContactsPage.tsx';
import { DashboardPage } from './components/DashboardPage.tsx';
import { LinesPage } from './components/LinesPage.tsx';
import { MessagesPage } from './components/MessagesPage.tsx';
import { ReportsPage } from './components/ReportsPage.tsx';
import { AnalyticsPage } from './components/AnalyticsPage.tsx';
import { HelpPage } from './components/HelpPage.tsx';
import { HistoryPage } from './components/HistoryPage.tsx';
import { NewDispatchModal } from './components/NewDispatchModal.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { ScheduledPauseAlerts } from './components/ScheduledPauseAlerts.tsx';
import { api } from './api/client.ts';
import { useLiveResource } from './hooks/useLiveResource.ts';
import { useOverview } from './hooks/useOverview.ts';

export type Section = 'overview' | 'lines' | 'messages' | 'contacts' | 'history' | 'analytics' | 'reports' | 'settings' | 'help';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Dashboard' },
  { id: 'lines', label: 'Linhas' },
  { id: 'messages', label: 'Mensagens' },
  { id: 'contacts', label: 'Contatos' },
  { id: 'history', label: 'Histórico' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'reports', label: 'Relatórios' },
  { id: 'settings', label: 'Configurações' },
  { id: 'help', label: 'Ajuda' },
];

export function App() {
  const { overview, error, live } = useOverview();
  const { data: messages } = useLiveResource(api.messages, ['messages.updated']);
  const [section, setSectionState] = useState<Section>(() => {
    try {
      return (localStorage.getItem('app.section') as Section | null) ?? 'lines';
    } catch {
      return 'lines';
    }
  });
  const setSection = (next: Section) => {
    setSectionState(next);
    try {
      localStorage.setItem('app.section', next);
    } catch {
      /* só preferência de tela */
    }
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const openNewDispatch = () => setCreating(true);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Zap size={18} /></span>
          Disparo
        </div>
        <span className="brand-divider" />
        <nav className="nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`nav-item ${section === s.id ? 'is-active' : ''}`} onClick={() => setSection(s.id)}>
              {s.label}
              {s.id === 'lines' && overview && <span className="nav-count">{overview.lines.total}/{overview.lines.max}</span>}
              {s.id === 'messages' && messages && <span className="nav-count is-ok">{messages.activeCount}</span>}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <span className={`live-pill ${live ? 'is-on' : ''}`}>
            <span className={`dot ${live ? 'pulse' : ''}`} />
            {live ? 'Tempo real' : 'Offline'}
          </span>
          <button className="soft" onClick={openNewDispatch} disabled={!overview}>
            <Send size={15} /> Novo disparo
          </button>
        </div>
      </header>

      {(error || actionError || (overview && overview.lineDetails.some((l) => l.scheduledPause.awaitingDecision))) && (
        <div className="global-alerts">
          {(error || actionError) && (
            <div className="alert" role="alert">
              {actionError ?? error}
              {actionError && <button className="sm" onClick={() => setActionError(null)}>Fechar</button>}
            </div>
          )}
          {overview && <ScheduledPauseAlerts lines={overview.lineDetails} onError={setActionError} />}
        </div>
      )}

      {!overview ? (
        <main className="content"><p className="empty">Carregando…</p></main>
      ) : (
        <main className="content">
          {section === 'overview' && <DashboardPage overview={overview} onNewDispatch={openNewDispatch} onNavigate={setSection} onError={setActionError} />}
          {section === 'lines' && (
            <LinesPage lines={overview.lineDetails} summary={overview.lines} workers={overview.workers} onNewDispatch={openNewDispatch} onError={setActionError} />
          )}
          {section === 'messages' && <MessagesPage onError={setActionError} />}
          {section === 'contacts' && <ContactsPage onError={setActionError} />}
          {section === 'history' && <HistoryPage />}
          {section === 'analytics' && <AnalyticsPage />}
          {section === 'reports' && <ReportsPage />}
          {section === 'settings' && <SettingsPage onError={setActionError} onNewDispatch={openNewDispatch} onNavigate={setSection} />}
          {section === 'help' && <HelpPage />}
        </main>
      )}

      <footer className="footer">
        <span><strong>Disparo</strong> · gestão de disparos multi-linhas</span>
        {overview && (
          <span>
            {overview.lines.total} linha(s) cadastrada(s) · atualizado às {new Date(overview.generatedAt).toLocaleTimeString('pt-BR')}
          </span>
        )}
      </footer>

      {creating && overview && (
        <NewDispatchModal
          lines={overview.lineDetails}
          onClose={(createdId) => {
            setCreating(false);
            if (createdId) setSection('lines');
          }}
        />
      )}
    </div>
  );
}
