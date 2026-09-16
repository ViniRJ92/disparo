import type { EventBus } from '../../shared/events.ts';
import { SerialExecutor } from '../../shared/serial.ts';
import type { LineManager } from '../lines/line.manager.ts';
import type { LogService } from '../logs/log.service.ts';
import type { DistributionSettings } from '../settings/settings.schema.ts';
import type { SettingsService } from '../settings/settings.service.ts';
import type { DistributionTicket, LineQuotaSnapshot, RoundSnapshot } from './distribution.types.ts';

export interface DistributionEngineDeps {
  lines: LineManager;
  settings: SettingsService;
  logs: LogService;
  events: EventBus;
  /** Linhas selecionadas para o processo (ordem de exibição). */
  selectedLines: (campaignId: string) => Promise<string[]>;
  /** Status atual do processo (só processos em andamento recebem ciclos). */
  isRunning: (campaignId: string) => Promise<boolean>;
  /**
   * Quantos envios a linha ainda pode fazer agora: o menor valor entre o que
   * resta do limite diário e o que resta até a pausa programada.
   */
  capacity: (lineId: string) => Promise<number>;
  random: () => number;
  now?: () => number;
}

interface LineQuota {
  lineId: string;
  assigned: number;
  used: number;
  /** false = retirada temporariamente (pausada, desconectada, erro ou sem capacidade). */
  active: boolean;
}

interface Round {
  number: number;
  startedAt: number;
  lastReservationAt: number;
  /** Intervalo único (segundos) aplicado aos envios de todas as linhas neste ciclo. */
  intervalSeconds: number;
  quotas: Map<string, LineQuota>;
}

interface CampaignState {
  counter: number;
  round: Round | null;
  past: RoundSnapshot[];
  serial: SerialExecutor;
  finished: boolean;
  /** Linhas retiradas da distribuição e ainda não devolvidas. */
  withdrawn: Set<string>;
}

const PAST_ROUNDS_KEPT = 50;
const FINISHED_CAMPAIGNS_KEPT = 20;

/** Sorteio uniforme de um item da lista. */
function pick<T>(options: readonly T[], random: () => number): T {
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))]!;
}

/**
 * SORTEIO 1 — quantidade de contatos de UMA linha no ciclo.
 *  - opções: minBatch..maxBatch que caibam na capacidade da linha;
 *  - sem capacidade para o mínimo: usa só o que a linha ainda pode enviar;
 *  - evita a quantidade que a MESMA linha recebeu no ciclo imediatamente
 *    anterior, sempre que existir outra opção válida.
 */
export function drawLineQuota(
  { minBatch, maxBatch }: Pick<DistributionSettings, 'minBatch' | 'maxBatch'>,
  capacity: number,
  previous: number | undefined,
  random: () => number,
): number {
  if (capacity < minBatch) return Math.max(0, Math.floor(capacity));
  const options: number[] = [];
  for (let n = minBatch; n <= Math.min(maxBatch, capacity); n++) options.push(n);
  const withoutPrevious = options.filter((n) => n !== previous);
  return pick(withoutPrevious.length > 0 ? withoutPrevious : options, random);
}

/**
 * SORTEIO 2 — intervalo do ciclo (independente das quantidades).
 * Nunca igual ao intervalo do ciclo imediatamente anterior quando houver alternativa.
 */
export function drawCycleInterval(options: readonly number[], previous: number | undefined, random: () => number): number {
  const withoutPrevious = options.filter((seconds) => seconds !== previous);
  return pick(withoutPrevious.length > 0 ? withoutPrevious : options, random);
}

/**
 * Motor de distribuição de contatos entre as linhas selecionadas de um processo.
 *
 * Funciona em CICLOS. Cada ciclo tem: as linhas participantes aptas, uma
 * quantidade sorteada por linha (2 a 5) e UM intervalo sorteado para o ciclo
 * inteiro (2 a 5 s). As linhas trabalham em paralelo, cada uma no seu worker;
 * o motor apenas concede ou nega a permissão de pegar o próximo contato e
 * informa o intervalo do ciclo. Quando todas as linhas aptas esgotam suas
 * quantidades, o ciclo é finalizado e um novo é sorteado.
 *
 * - Linha pausada/desconectada/com erro/sem capacidade: sai do ciclo na hora
 *   (sua cota restante não segura as outras) e volta quando ficar apta.
 * - O motor não guarda contatos: a fila (send_jobs) continua sendo a única fonte
 *   da verdade, então nada se perde se uma linha sair.
 * - Reservas de um mesmo processo são serializadas.
 */
export class DistributionEngine {
  private readonly deps: DistributionEngineDeps;
  private readonly states = new Map<string, CampaignState>();
  private readonly finishedOrder: string[] = [];
  private readonly now: () => number;

  constructor(deps: DistributionEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    deps.events.on('campaign.updated', (campaign) => {
      if (campaign.status === 'completed' || campaign.status === 'cancelled') this.finish(campaign.id);
    });
  }

  /**
   * Pede permissão para a linha pegar UM contato do processo.
   * Retorna um ticket (a ser devolvido com release() se não houver contato) ou null.
   */
  reserve(campaignId: string, lineId: string): Promise<DistributionTicket | null> {
    const state = this.state(campaignId);
    return state.serial.run(async () => {
      // Processo já finalizado: nenhum ciclo novo (evita ciclos vazios de workers atrasados).
      if (state.finished || !(await this.deps.isRunning(campaignId))) return null;
      const eligible = await this.eligibleLines(campaignId);
      if (!eligible.has(lineId)) return null;

      const { distribution } = await this.deps.settings.get();
      const now = this.now();
      let round = state.round;

      if (round) {
        this.refreshParticipation(campaignId, state, round, eligible);
        for (const [id, capacity] of eligible) {
          if (!round.quotas.has(id)) {
            const previous = state.past[0]?.quotas.find((q) => q.lineId === id)?.assigned;
            round.quotas.set(id, this.newQuota(id, capacity, previous, distribution));
          }
        }
        const open = [...round.quotas.values()].filter((q) => q.active && q.used < q.assigned);
        const stalled = now - round.lastReservationAt > distribution.roundStallSeconds * 1000;
        const mine = round.quotas.get(lineId)!;
        if (open.length === 0 || (stalled && mine.used >= mine.assigned)) {
          round = this.startRound(campaignId, state, eligible, distribution, stalled && open.length > 0);
        }
      } else {
        round = this.startRound(campaignId, state, eligible, distribution, false);
      }

      const quota = round.quotas.get(lineId)!;
      if (quota.used >= quota.assigned) return null; // aguarda a vez: outras linhas ainda têm cota
      quota.used++;
      round.lastReservationAt = now;
      return { campaignId, lineId, round: round.number, intervalSeconds: round.intervalSeconds };
    });
  }

  /** Devolve uma permissão não utilizada (não havia contato pendente). */
  release(ticket: DistributionTicket): void {
    const round = this.states.get(ticket.campaignId)?.round;
    if (!round || round.number !== ticket.round) return;
    const quota = round.quotas.get(ticket.lineId);
    if (quota && quota.used > 0) quota.used--;
  }

  /** Ciclo atual e ciclos anteriores (mais recente primeiro). */
  snapshot(campaignId: string): { current: RoundSnapshot | null; past: RoundSnapshot[] } {
    const state = this.states.get(campaignId);
    return {
      current: state?.round ? toSnapshot(state.round, null) : null,
      past: state ? [...state.past] : [],
    };
  }

  // ---------------------------------------------------------------- internos

  /** Processo encerrado: finaliza o ciclo atual e mantém o histórico (limitado em memória). */
  private finish(campaignId: string): void {
    const state = this.states.get(campaignId);
    if (!state || state.finished) return;
    if (state.round) this.closeRound(campaignId, state, 'processo finalizado');
    state.finished = true;
    this.finishedOrder.push(campaignId);
    while (this.finishedOrder.length > FINISHED_CAMPAIGNS_KEPT) this.states.delete(this.finishedOrder.shift()!);
  }

  private state(campaignId: string): CampaignState {
    let state = this.states.get(campaignId);
    if (!state) {
      state = { counter: 0, round: null, past: [], serial: new SerialExecutor(), finished: false, withdrawn: new Set() };
      this.states.set(campaignId, state);
    }
    return state;
  }

  /** Linhas selecionadas que podem receber contatos agora, com a capacidade de cada uma. */
  private async eligibleLines(campaignId: string): Promise<Map<string, number>> {
    const eligible = new Map<string, number>();
    for (const id of await this.deps.selectedLines(campaignId)) {
      if (!this.deps.lines.has(id) || !this.deps.lines.readiness(id).available) continue;
      const capacity = await this.deps.capacity(id);
      if (capacity > 0) eligible.set(id, capacity);
    }
    return eligible;
  }

  /** Marca quem saiu/voltou da distribuição e registra cada mudança no log. */
  private refreshParticipation(campaignId: string, state: CampaignState, round: Round, eligible: Map<string, number>): void {
    for (const quota of round.quotas.values()) {
      quota.active = eligible.has(quota.lineId);
      if (!quota.active && !state.withdrawn.has(quota.lineId)) {
        state.withdrawn.add(quota.lineId);
        this.deps.logs.write({
          level: 'warn',
          scope: 'distribution',
          campaignId,
          lineId: quota.lineId,
          message: `${this.label(quota.lineId)} retirada da distribuição (pausada, desconectada, com erro ou sem capacidade)`,
        });
      }
    }
    for (const lineId of [...state.withdrawn]) {
      if (!eligible.has(lineId)) continue;
      state.withdrawn.delete(lineId);
      this.deps.logs.write({
        level: 'info',
        scope: 'distribution',
        campaignId,
        lineId,
        message: `${this.label(lineId)} voltou à distribuição (ciclo ${round.number})`,
      });
    }
  }

  private closeRound(campaignId: string, state: CampaignState, reason: string): void {
    const round = state.round!;
    const snapshot = toSnapshot(round, new Date(this.now()).toISOString());
    state.past.unshift(snapshot);
    state.past.length = Math.min(state.past.length, PAST_ROUNDS_KEPT);
    state.round = null;
    this.deps.logs.write({
      level: 'info',
      scope: 'distribution',
      campaignId,
      message:
        `Ciclo ${round.number} finalizado (${reason}): ` +
        snapshot.quotas.map((q) => `${this.label(q.lineId)} ${q.used}/${q.assigned}`).join(', '),
      data: { cycle: round.number, intervalSeconds: round.intervalSeconds, quotas: snapshot.quotas },
    });
  }

  private startRound(
    campaignId: string,
    state: CampaignState,
    eligible: Map<string, number>,
    distribution: DistributionSettings,
    byStall: boolean,
  ): Round {
    if (state.round) this.closeRound(campaignId, state, byStall ? 'linhas com cota paradas' : 'cotas cumpridas');
    const previous = state.past[0];

    // SORTEIO 1: quantidade de cada linha (independente do intervalo).
    const quotas = new Map<string, LineQuota>();
    for (const [lineId, capacity] of eligible) {
      const previousQuota = previous?.quotas.find((q) => q.lineId === lineId)?.assigned;
      quotas.set(lineId, this.newQuota(lineId, capacity, previousQuota, distribution));
    }
    // SORTEIO 2: intervalo único do ciclo.
    const intervalSeconds = drawCycleInterval(distribution.cycleIntervalSeconds, previous?.intervalSeconds, this.deps.random);

    const now = this.now();
    const round: Round = { number: ++state.counter, startedAt: now, lastReservationAt: now, intervalSeconds, quotas };
    state.round = round;

    this.deps.logs.write({
      level: 'info',
      scope: 'distribution',
      campaignId,
      message:
        `Ciclo ${round.number} iniciado${byStall ? ' (linhas com cota paradas)' : ''} · intervalo ${intervalSeconds}s: ` +
        [...quotas.values()].map((q) => `${this.label(q.lineId)} → ${q.assigned}`).join(', '),
      data: {
        cycle: round.number,
        intervalSeconds,
        quotas: Object.fromEntries([...quotas.values()].map((q) => [q.lineId, q.assigned])),
      },
    });
    this.deps.events.emit('distribution.round', { campaignId, round: toSnapshot(round, null) });
    return round;
  }

  private newQuota(lineId: string, capacity: number, previous: number | undefined, distribution: DistributionSettings): LineQuota {
    return { lineId, assigned: drawLineQuota(distribution, capacity, previous, this.deps.random), used: 0, active: true };
  }

  private label(lineId: string): string {
    return this.deps.lines.has(lineId) ? this.deps.lines.labelOf(lineId) : 'Linha removida';
  }
}

function toSnapshot(round: Round, finishedAt: string | null): RoundSnapshot {
  const quotas: LineQuotaSnapshot[] = [...round.quotas.values()].map((q) => ({ ...q }));
  return {
    number: round.number,
    startedAt: new Date(round.startedAt).toISOString(),
    finishedAt,
    intervalSeconds: round.intervalSeconds,
    quotas,
  };
}
