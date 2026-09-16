import { useState } from 'react';
import { AlertTriangle, BookOpen, CheckCircle2, CircleHelp, FileSpreadsheet, Hand, Info, Layers, PauseCircle, RefreshCcw, Search, Shuffle, Timer, Users, Wifi } from 'lucide-react';
import { Badge } from './Badge.tsx';
import { PageHeader } from './ui.tsx';

interface HelpSection {
  id: string;
  number: string;
  title: string;
  tag: string;
  keywords: string;
  body: React.ReactNode;
}

const SECTIONS: HelpSection[] = [
  {
    id: 'classificacao',
    number: '01',
    title: 'Classificação das Interações',
    tag: 'Analytics',
    keywords: 'classificação interações respondeu iniciou não respondeu grupos pessoas linhas analytics nono dígito',
    body: (
      <>
        <div className="help-card primary">
          <h4><Info size={16} className="primary-text" /> Escopo</h4>
          <p>Considera as <strong>conversas individuais de todas as linhas</strong>. Grupos ficam de fora, assim como listas de transmissão, status e canais, que não são conversas com pessoas.</p>
        </div>
        <div className="grid-3">
          <div className="help-card ok">
            <Badge tone="ok"><span className="dot" />Respondeu</Badge>
            <p>A primeira mensagem que a pessoa escreveu no período veio <strong>depois</strong> de ela ter recebido mensagem, em qualquer linha.</p>
          </div>
          <div className="help-card info">
            <Badge tone="info"><span className="dot" />Iniciou a conversa</Badge>
            <p>A primeira mensagem que a pessoa escreveu no período <strong>não</strong> foi precedida de mensagem enviada a ela.</p>
          </div>
          <div className="help-card warn">
            <Badge tone="warn"><span className="dot" />Não respondeu</Badge>
            <p>Recebeu mensagem no período e <strong>não escreveu</strong> nenhuma mensagem no período.</p>
          </div>
        </div>
        <div className="grid-2">
          <div className="help-card">
            <h4><Users size={15} /> Identificação da pessoa</h4>
            <p>Cada pessoa é identificada pelo telefone. O mesmo celular com ou sem o nono dígito conta como a mesma pessoa. Quando o WhatsApp não informa o número, é usada a identificação da conversa.</p>
          </div>
          <div className="help-card">
            <h4><Layers size={15} /> Várias linhas</h4>
            <p>A mesma pessoa em várias linhas é contada <strong>uma vez</strong> no total. Na tabela por linha ela aparece em cada linha onde interagiu, por isso a soma das linhas pode ser maior que o total.</p>
          </div>
          <div className="help-card">
            <h4><Search size={15} /> Filtros</h4>
            <p>Com o filtro de linha, a classificação considera somente aquela linha. O filtro de mensagem restringe os envios do disparo; respostas manuais não têm rótulo de mensagem.</p>
          </div>
          <div className="help-card">
            <h4><CheckCircle2 size={15} /> Contagem</h4>
            <p>É uma contagem de <strong>pessoas</strong>, não de mensagens.</p>
          </div>
        </div>
      </>
    ),
  },
  {
    id: 'ciclos',
    number: '02',
    title: 'Ciclos de envio',
    tag: 'Distribuição',
    keywords: 'ciclos envio quantidade intervalo sorteio linhas distribuição fila contatos',
    body: (
      <>
        <div className="grid-2">
          <div className="help-card">
            <h4><Shuffle size={15} className="ok-text" /> Passo 1 · quantidade por linha</h4>
            <p>A cada ciclo, cada linha participante recebe uma quantidade sorteada de contatos (padrão: 2 a 5), diferente da que recebeu no ciclo anterior sempre que houver alternativa.</p>
            <div className="row">{[2, 3, 4, 5].map((n) => <span key={n} className="chip">{n} contatos</span>)}</div>
          </div>
          <div className="help-card">
            <h4><Timer size={15} className="ok-text" /> Passo 2 · intervalo do ciclo</h4>
            <p>O ciclo inteiro usa um único intervalo entre envios, sorteado entre os valores configurados (padrão: 2, 3, 4 e 5 segundos) e diferente do intervalo do ciclo anterior.</p>
            <div className="row">{[2, 3, 4, 5].map((n) => <span key={n} className="chip">{n}s</span>)}</div>
          </div>
        </div>
        <div className="help-card info">
          <h4><RefreshCcw size={15} className="info-text" /> Linhas fora de operação</h4>
          <p>Linhas pausadas, desconectadas ou com erro saem do ciclo e voltam quando ficam aptas. <strong>Contatos pendentes nunca se perdem</strong>: seguem na fila para as outras linhas.</p>
        </div>
      </>
    ),
  },
  {
    id: 'pausas',
    number: '03',
    title: 'Pausa programada e pausa manual',
    tag: 'Controle',
    keywords: 'pausa programada manual contador limite continuar manter pausada',
    body: (
      <div className="grid-2">
        <div className="help-card">
          <Badge tone="primary"><Timer size={12} /> Pausa programada</Badge>
          <ul>
            <li><strong>Contador individual:</strong> cada linha pausa sozinha ao enviar o limite configurado.</li>
            <li><strong>Continuar</strong> zera o contador daquela linha; <strong>Manter pausada</strong> deixa a linha parada.</li>
            <li>Alterar a configuração zera os contadores de <strong>todas</strong> as linhas.</li>
          </ul>
        </div>
        <div className="help-card">
          <Badge tone="info"><Hand size={12} /> Pausa manual</Badge>
          <ul>
            <li>Você pausa e retoma qualquer linha a qualquer momento.</li>
            <li>Pausar uma linha <strong>não afeta</strong> as outras nem o andamento do disparo.</li>
            <li>Os contatos da linha pausada continuam na fila e são enviados pelas demais.</li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    id: 'estados',
    number: '04',
    title: 'Estados da linha',
    tag: 'Linhas',
    keywords: 'estados linha conexão conectada desconectada reconectando erro operacional ativa pausada parada participação',
    body: (
      <div className="grid-3">
        <div className="help-card">
          <h4><Wifi size={15} /> Conexão</h4>
          <div className="state-list">
            <div><span className="row ok-text"><span className="dot" />Conectada</span><span className="muted">Sessão ativa</span></div>
            <div><span className="row warn-text"><span className="dot" />Conectando</span><span className="muted">Iniciando sessão</span></div>
            <div><span className="row info-text"><span className="dot" />Reconectando</span><span className="muted">Nova tentativa automática</span></div>
            <div><span className="row muted"><span className="dot" />Desconectada</span><span className="muted">Sem sessão</span></div>
            <div><span className="row bad-text"><span className="dot" />Erro</span><span className="muted">Falha na conexão</span></div>
          </div>
        </div>
        <div className="help-card">
          <h4><PauseCircle size={15} /> Operacional</h4>
          <div className="state-list">
            <div><Badge tone="ok">Ativa</Badge><span className="muted">Participa dos ciclos</span></div>
            <div><Badge tone="warn">Pausada</Badge><span className="muted">Manual ou programada</span></div>
            <div><Badge tone="muted">Parada</Badge><span className="muted">Não iniciada</span></div>
            <div><Badge tone="bad">Erro</Badge><span className="muted">Precisa de atenção</span></div>
          </div>
        </div>
        <div className="help-card">
          <h4><Layers size={15} /> Participação</h4>
          <div className="state-list">
            <div><span className="info-text">Selecionada</span><span className="muted">Faz parte do disparo</span></div>
            <div><span className="muted">Não selecionada</span><span className="muted">Fica fora do disparo</span></div>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: 'relatorios',
    number: '05',
    title: 'Relatórios e exportações CSV',
    tag: 'Dados',
    keywords: 'relatórios exportação csv excel pendentes falha temporária definitiva separador',
    body: (
      <>
        <div className="grid-2">
          <div className="help-card">
            <h4><FileSpreadsheet size={15} /> Arquivo CSV</h4>
            <ul>
              <li>Separador <strong>ponto e vírgula (;)</strong> e codificação UTF-8 com BOM: abre direto no Excel.</li>
              <li>Datas e horas no horário deste computador.</li>
            </ul>
          </div>
          <div className="help-card">
            <h4><Layers size={15} /> Pendentes por linha</h4>
            <p>Contatos ainda na fila dos disparos em que a linha participa. A fila é <strong>compartilhada</strong>: se uma linha para, as outras seguem enviando.</p>
          </div>
        </div>
        <div className="grid-2">
          <div className="help-card warn">
            <h4><RefreshCcw size={15} className="warn-text" /> Falha temporária</h4>
            <p>O contato voltou para a fila e será tentado de novo automaticamente.</p>
          </div>
          <div className="help-card">
            <h4><AlertTriangle size={15} className="bad-text" /> Falha definitiva</h4>
            <p>O contato não será reenviado; o motivo fica registrado no histórico e no CSV de falhas.</p>
          </div>
        </div>
      </>
    ),
  },
];

const FAQ = [
  { q: 'Se o sistema for reiniciado, as pausas se perdem?', a: 'Não. Linhas pausadas, contadores da pausa programada, fila e histórico ficam salvos no banco.' },
  { q: 'Por que uma resposta manual não tem rótulo de mensagem?', a: 'Porque não foi enviada por um disparo: só os envios do disparo usam as mensagens cadastradas.' },
];

/** Ajuda: definições usadas nas telas (as telas principais ficam sem textos explicativos). */
export function HelpPage() {
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const visible = SECTIONS.filter((s) => !term || `${s.title} ${s.keywords}`.toLowerCase().includes(term));

  return (
    <>
      <section className="panel help-hero">
        <PageHeader
          icon={<BookOpen size={22} />}
          title="Central de Ajuda"
          badge={<Badge tone="primary">Regras do sistema</Badge>}
          subtitle="Como funcionam a classificação das interações, os ciclos de envio, as pausas, os estados das linhas e as exportações."
        />
        <div className="row" style={{ marginTop: 20, justifyContent: 'space-between' }}>
          <div className="input-icon" style={{ width: 'min(420px, 100%)' }}>
            <Search size={15} />
            <input type="search" placeholder="Buscar regra ou comportamento…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="row small muted">
            Tópicos:
            {SECTIONS.map((s) => <a key={s.id} className="chip" href={`#${s.id}`} style={{ textDecoration: 'none' }}>{s.title}</a>)}
          </div>
        </div>
      </section>

      <div className="help-layout">
        <nav className="help-toc" aria-label="Índice">
          <span className="eyebrow" style={{ padding: '4px 10px' }}>Índice</span>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}><span className="mono subtle">{s.number}</span>{s.title}</a>
          ))}
          <a href="#faq"><span className="mono subtle">?</span>Perguntas frequentes</a>
        </nav>

        <div className="stack" style={{ gap: 36 }}>
          {visible.length === 0 && <p className="empty">Nenhum tópico encontrado para "{query}".</p>}
          {visible.map((s) => (
            <section key={s.id} id={s.id} className="help-section">
              <div className="section-heading">
                <div className="help-section-title">
                  <span className="num-badge">{s.number}</span>
                  <h2>{s.title}</h2>
                </div>
                <span className="mono small subtle">{s.tag}</span>
              </div>
              {s.body}
            </section>
          ))}

          <section id="faq" className="help-section">
            <div className="help-section-title">
              <span className="num-badge is-muted"><CircleHelp size={15} /></span>
              <h2>Perguntas frequentes</h2>
            </div>
            <div className="grid-2">
              {FAQ.map((f) => (
                <div key={f.q} className="help-card">
                  <h4>{f.q}</h4>
                  <p>{f.a}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
