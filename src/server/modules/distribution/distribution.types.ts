import type { MessageTemplate } from '../messages/message.types.ts';

/**
 * Contratos da distribuição.
 *
 * Linhas: modelo "pull". Cada linha tem o seu próprio worker (ver modules/dispatch)
 * que, enquanto a linha estiver apta, reserva o próximo contato pendente dos
 * processos em que foi selecionada. Não existe um processo central escolhendo
 * linhas: pausar/derrubar uma linha só para o worker dela, e os contatos que
 * ela não pegou continuam na fila para as outras.
 *
 * Quantidade por linha e intervalo: o DistributionEngine divide o trabalho em
 * CICLOS com quantidade sorteada por linha e um intervalo único por ciclo
 * (ver distribution.engine.ts).
 *
 * Mensagens: a escolha de QUAL mensagem enviar a cada contato é delegada a um
 * MessageSelector.
 */
export interface DistributionTicket {
  campaignId: string;
  lineId: string;
  /** Número do ciclo. */
  round: number;
  /** Intervalo do ciclo (segundos) a aplicar depois deste envio. */
  intervalSeconds: number;
}

export interface LineQuotaSnapshot {
  lineId: string;
  /** Contatos sorteados para a linha nesta rodada. */
  assigned: number;
  /** Contatos já reservados pela linha nesta rodada. */
  used: number;
  /** false = retirada temporariamente da distribuição. */
  active: boolean;
}

/** Um CICLO de distribuição. */
export interface RoundSnapshot {
  number: number;
  startedAt: string;
  /** null enquanto o ciclo está em andamento. */
  finishedAt: string | null;
  /** Intervalo único do ciclo, em segundos. */
  intervalSeconds: number;
  quotas: LineQuotaSnapshot[];
}

export interface MessageSelectionContext {
  campaignId: string;
  contactId: string;
  lineId: string;
}

export interface MessageSelector {
  /** Mensagem a usar para o contato, ou null se não houver mensagem utilizável. */
  select(context: MessageSelectionContext): Promise<MessageTemplate | null>;
}
