import { api } from '../api/client.ts';
import { useLiveResource } from './useLiveResource.ts';

const LIVE_EVENTS = ['line.updated', 'line.removed', 'campaign.updated', 'send.recorded', 'worker.updated', 'distribution.round', 'line.scheduled_pause'];

/** Visão global (linhas, workers, processos e totais) sempre atualizada. */
export function useOverview() {
  const { data, error, live, reload } = useLiveResource(api.overview, LIVE_EVENTS);
  return { overview: data, error, live, reload };
}
