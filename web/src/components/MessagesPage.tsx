import { useState } from 'react';
import { Braces, CheckCircle2, Copy, Gauge, Info, MailCheck, PlusCircle, Shuffle, ShieldCheck } from 'lucide-react';
import { api } from '../api/client.ts';
import { useLiveResource } from '../hooks/useLiveResource.ts';
import { formatNumber } from '../labels.ts';
import { Badge } from './Badge.tsx';
import { MessageSlotCard } from './MessageSlotCard.tsx';
import { PageHeader } from './ui.tsx';

const VARIABLES = ['{{nome}}', '{{telefone}}'];

/** Área "Mensagens": 5 posições fixas; somente as ativas participam do sorteio. */
export function MessagesPage({ onError }: { onError: (message: string) => void }) {
  const { data } = useLiveResource(api.messages, ['messages.updated']);
  // Uso real de cada mensagem (envios registrados no histórico, todo o período).
  const { data: usage } = useLiveResource(() => api.analyticsOverview({}), ['send.recorded', 'messages.updated'], 3000);
  const [copied, setCopied] = useState<string | null>(null);

  if (!data) return <p className="empty">Carregando…</p>;

  const filled = data.slots.filter((s) => s.message).length;
  const byLabel = new Map((usage?.sends.byMessage ?? []).map((m) => [m.label, m]));
  const activeLabels = data.slots.filter((s) => s.message?.active).map((s) => s.message!.name);
  const totalSent = (usage?.sends.byMessage ?? []).reduce((sum, m) => sum + m.sent, 0);
  const activeSent = activeLabels.map((l) => byLabel.get(l)?.sent ?? 0);
  const activeTotal = activeSent.reduce((a, b) => a + b, 0);
  const balance = activeTotal > 0 ? activeSent.map((n) => `${Math.round((n / activeTotal) * 100)}%`).join(' / ') : '—';

  const copy = async (variable: string) => {
    try {
      await navigator.clipboard.writeText(variable);
      setCopied(variable);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* área de transferência indisponível */
    }
  };

  const focusEmptySlot = () => {
    const empty = document.querySelector<HTMLTextAreaElement>('.message-card.is-empty textarea');
    empty?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    empty?.focus();
  };

  return (
    <>
      <section className="panel">
        <PageHeader
          title="Mensagens"
          badge={
            <>
              <Badge tone={data.activeCount > 0 ? 'ok' : 'bad'}><span className="dot" />{data.activeCount} ativa(s) de 5 posições</Badge>
              <Badge tone="muted"><ShieldCheck size={12} /> Sem repetição consecutiva</Badge>
            </>
          }
          subtitle="A cada envio uma mensagem ativa é sorteada, e o mesmo contato nunca recebe a mesma mensagem duas vezes seguidas. Editar vale para os próximos envios; o histórico mantém o texto enviado."
          actions={
            <button className="soft" onClick={focusEmptySlot} disabled={filled >= 5}>
              <PlusCircle size={16} /> Adicionar variação
            </button>
          }
        />
        <div className="message-stats">
          <div className="message-stat">
            <span className="kpi-icon ok"><Shuffle size={16} /></span>
            <span><span className="eyebrow">Distribuição atual</span><strong className="num">{balance}</strong></span>
          </div>
          <div className="message-stat">
            <span className="kpi-icon primary"><ShieldCheck size={16} /></span>
            <span><span className="eyebrow">Proteção de repetição</span><strong className="ok-text">{data.activeCount > 1 ? 'Ativa' : data.activeCount === 1 ? 'Mensagem única' : 'Sem mensagens'}</strong></span>
          </div>
          <div className="message-stat">
            <span className="kpi-icon"><MailCheck size={16} /></span>
            <span><span className="eyebrow">Enviadas pelas mensagens</span><strong className="num">{formatNumber(totalSent)} mensagens</strong></span>
          </div>
          <div className="message-stat">
            <span className="kpi-icon"><Gauge size={16} /></span>
            <span><span className="eyebrow">Posições livres</span><strong className="num">{5 - filled} disponíveis</strong></span>
          </div>
        </div>
      </section>

      {data.activeCount === 0 && <div className="notice warn">Nenhuma mensagem ativa: não é possível iniciar processos.</div>}

      <div className="var-bar">
        <span className="row eyebrow"><Braces size={14} /> Variáveis:</span>
        {VARIABLES.map((v) => (
          <button key={v} className="var-chip sm" onClick={() => void copy(v)} title="Copiar variável">
            {v} {copied === v ? <CheckCircle2 size={12} /> : <Copy size={12} />}
          </button>
        ))}
        <span className="spacer" />
        <span className="row small muted"><Info size={14} /> Clique na variável para copiar e cole no texto</span>
      </div>

      <div className="message-grid">
        {data.slots.map((slot) => (
          <MessageSlotCard
            key={slot.slot}
            slot={slot}
            usage={slot.message ? (byLabel.get(slot.message.name) ?? null) : null}
            totalActiveSent={activeTotal}
            onError={onError}
          />
        ))}
        <aside className="info-card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 className="row"><ShieldCheck size={17} className="primary-text" /> Regras do sorteio</h3>
          </div>
          <ul className="check-list">
            <li><CheckCircle2 size={15} /> Somente mensagens ativas participam do sorteio.</li>
            <li><CheckCircle2 size={15} /> O mesmo contato não recebe a mesma mensagem duas vezes seguidas.</li>
            <li><CheckCircle2 size={15} /> O histórico guarda exatamente o texto enviado.</li>
            <li><Info size={15} className="info-text" /> Edições valem para os próximos envios.</li>
          </ul>
        </aside>
      </div>
    </>
  );
}
