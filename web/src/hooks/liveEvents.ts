/**
 * UMA única conexão de eventos em tempo real (SSE) para o painel inteiro.
 *
 * Cada EventSource ocupa uma conexão HTTP permanente, e o navegador limita a 6
 * conexões por endereço. Com uma conexão por tela/componente, as requisições
 * seguintes ficavam esperando indefinidamente. Aqui todos os componentes
 * compartilham a mesma conexão e apenas registram ouvintes.
 */
type Listener = () => void;

let source: EventSource | null = null;
const listenersByEvent = new Map<string, Set<Listener>>();
const statusListeners = new Set<(live: boolean) => void>();
let live = false;

function ensureSource(): EventSource {
  if (source) return source;
  source = new EventSource('/api/events');
  source.onopen = () => setLive(true);
  source.onerror = () => setLive(false);
  for (const name of listenersByEvent.keys()) attach(name);
  return source;
}

const attached = new Set<string>();
function attach(name: string): void {
  if (!source || attached.has(name)) return;
  attached.add(name);
  source.addEventListener(name, () => {
    for (const listener of listenersByEvent.get(name) ?? []) listener();
  });
}

function setLive(value: boolean): void {
  live = value;
  for (const listener of statusListeners) listener(value);
}

/** Registra um ouvinte para os eventos informados; devolve a função para cancelar. */
export function subscribeLiveEvents(names: readonly string[], listener: Listener): () => void {
  ensureSource();
  for (const name of names) {
    const set = listenersByEvent.get(name) ?? new Set<Listener>();
    set.add(listener);
    listenersByEvent.set(name, set);
    attach(name);
  }
  return () => {
    for (const name of names) listenersByEvent.get(name)?.delete(listener);
  };
}

export function subscribeLiveStatus(listener: (live: boolean) => void): () => void {
  ensureSource();
  statusListeners.add(listener);
  listener(live);
  return () => statusListeners.delete(listener);
}
