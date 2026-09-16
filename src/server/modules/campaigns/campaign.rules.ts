import { invalidState } from '../../shared/errors.ts';
import type { CampaignAction, CampaignStatus } from './campaign.types.ts';

const TRANSITIONS: Record<CampaignAction, { from: readonly CampaignStatus[]; to: CampaignStatus }> = {
  start: { from: ['draft'], to: 'running' },
  pause: { from: ['running'], to: 'paused' },
  resume: { from: ['paused'], to: 'running' },
  cancel: { from: ['draft', 'running', 'paused'], to: 'cancelled' },
  complete: { from: ['running', 'paused'], to: 'completed' },
};

const ACTION_LABEL: Record<CampaignAction, string> = {
  start: 'iniciar',
  pause: 'pausar',
  resume: 'retomar',
  cancel: 'cancelar',
  complete: 'concluir',
};

export function nextCampaignStatus(current: CampaignStatus, action: CampaignAction): CampaignStatus {
  const transition = TRANSITIONS[action];
  if (!transition.from.includes(current)) {
    throw invalidState(`Não é possível ${ACTION_LABEL[action]} uma campanha com status "${current}"`);
  }
  return transition.to;
}

/** Linhas, mensagens e contatos só podem mudar enquanto a campanha não terminou. */
export function assertEditable(status: CampaignStatus): void {
  if (status === 'completed' || status === 'cancelled') {
    throw invalidState(`Campanha com status "${status}" não pode ser alterada`);
  }
}
