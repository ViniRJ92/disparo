import { invalidState } from '../../shared/errors.ts';
import type { BulkLineCommand, Line, LineCommand, LinesSummary, LineStatus, OperationalState } from './line.types.ts';

/** Regras puras da entidade Linha (sem I/O, fáceis de testar). */

export function isLineAvailable(line: Pick<Line, 'connectionStatus' | 'runState' | 'operationalStatus'>): boolean {
  return line.connectionStatus === 'connected' && line.runState === 'active' && line.operationalStatus !== 'error';
}

export function deriveLineStatus(
  line: Pick<Line, 'connectionStatus' | 'runState' | 'operationalStatus'>,
  reconnecting: boolean,
): LineStatus {
  switch (line.connectionStatus) {
    case 'connecting':
    case 'qr_required':
      return reconnecting ? 'reconnecting' : 'connecting';
    case 'error':
      return reconnecting ? 'reconnecting' : 'error';
    case 'disconnected':
      return reconnecting ? 'reconnecting' : 'disconnected';
    case 'connected':
      if (line.operationalStatus === 'error') return 'error';
      if (line.runState === 'active') return 'active';
      if (line.runState === 'paused') return 'paused';
      return 'connected';
  }
}

export function deriveOperationalState(line: Pick<Line, 'runState' | 'operationalStatus'>): OperationalState {
  return line.operationalStatus === 'error' ? 'error' : line.runState;
}

export function assertCommandAllowed(line: Line, command: LineCommand): void {
  switch (command) {
    case 'connect':
      if (line.connectionStatus === 'connected') throw invalidState(`"${line.label}" já está conectada`);
      if (line.connectionStatus === 'connecting') throw invalidState(`"${line.label}" já está conectando`);
      return;
    case 'start':
      if (line.runState === 'active') throw invalidState(`"${line.label}" já está ativa`);
      if (line.runState === 'paused') throw invalidState(`"${line.label}" está pausada: use "retomar"`);
      return;
    case 'pause':
      if (line.runState !== 'active') throw invalidState(`Só é possível pausar uma linha ativa ("${line.label}")`);
      return;
    case 'resume':
      if (line.runState !== 'paused') throw invalidState(`Só é possível retomar uma linha pausada ("${line.label}")`);
      return;
    case 'disconnect':
      if (line.runState === 'stopped' && line.connectionStatus === 'disconnected') {
        throw invalidState(`"${line.label}" já está desconectada`);
      }
      return;
    case 'reconnect':
      return;
  }
}

/**
 * Em lote, linhas cujo estado não comporta o comando são IGNORADAS (não é erro):
 * "pausar selecionadas" pausa só as ativas e deixa as demais como estão.
 */
export function bulkCommandApplies(line: Line, command: BulkLineCommand): boolean {
  switch (command) {
    case 'start':
      return line.runState === 'stopped';
    case 'pause':
      return line.runState === 'active';
    case 'resume':
      return line.runState === 'paused';
  }
}

export function summarizeLines(lines: readonly Line[], max: number): LinesSummary {
  const count = (predicate: (line: Line) => boolean) => lines.filter(predicate).length;
  return {
    max,
    total: lines.length,
    connected: count((l) => l.connectionStatus === 'connected'),
    active: count((l) => l.runState === 'active'),
    paused: count((l) => l.runState === 'paused'),
    stopped: count((l) => l.runState === 'stopped'),
    disconnected: count((l) => l.connectionStatus === 'disconnected'),
    withError: count((l) => l.connectionStatus === 'error' || l.operationalStatus === 'error'),
    available: count(isLineAvailable),
  };
}
