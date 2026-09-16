import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeLiveEvents, subscribeLiveStatus } from './liveEvents.ts';

/**
 * Carrega um recurso da API e o recarrega quando o servidor emite algum dos
 * eventos informados. Usa a conexão de eventos compartilhada (liveEvents.ts).
 * Rajadas de eventos viram uma única recarga, e um fluxo contínuo de eventos
 * (disparo em andamento) recarrega no máximo uma vez a cada `minIntervalMs`,
 * sem nunca deixar de atualizar.
 */
export function useLiveResource<T>(fetcher: () => Promise<T>, eventNames: readonly string[], minIntervalMs = 150) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadAt = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const eventsKey = eventNames.join(',');

  const reload = useCallback(async () => {
    lastLoadAt.current = Date.now();
    try {
      setData(await fetcherRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    const schedule = () => {
      if (timer.current) return; // já há uma recarga agendada que incluirá este evento
      const wait = Math.max(150, minIntervalMs - (Date.now() - lastLoadAt.current));
      timer.current = setTimeout(() => {
        timer.current = null;
        void reload();
      }, wait);
    };
    const offEvents = subscribeLiveEvents(eventsKey.split(','), schedule);
    const offStatus = subscribeLiveStatus(setLive);
    return () => {
      offEvents();
      offStatus();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [reload, eventsKey, minIntervalMs]);

  return { data, error, live, reload };
}
