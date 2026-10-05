import {
  UsenetIndexerMetricsRepository,
  type UsenetIndexerHeadToHeadRow,
} from '../../db/index.js';
import type { FailoverAttemptOutcome } from '../../main/failover.js';
import { createLogger } from '../../logging/logger.js';
import { indexerLabelFor } from './grab-metrics.js';

const logger = createLogger('usenet/head-to-head');

/** What the head-to-head tally needs to know about one failover attempt. */
export interface HeadToHeadAttempt {
  type: 'usenet' | 'debrid';
  /** Failover rank; same-release variants share their release's rank. */
  rank: number;
  indexer?: string;
  /** Service the attempt resolves through; copies on another service differ by more than indexer. */
  serviceId?: string;
}

/**
 * Same-release rescues from one settled play chain: every usenet attempt that
 * shares the winner's rank (a copy of the same release) and failed counts as
 * a rescue of its indexer by the winner's. Only `failed` counts: aborted,
 * unlaunched, terminal-error and service-side (`unavailable`) attempts say
 * nothing about the NZB. Nor do attempts with no named indexer, the winner's
 * own indexer, or a different service than the winner (the service, not the
 * indexer, may be what differed).
 */
export function headToHeadRescues(
  attempts: readonly HeadToHeadAttempt[],
  outcomes: readonly FailoverAttemptOutcome[],
  winnerIndex: number | undefined
): UsenetIndexerHeadToHeadRow[] {
  if (winnerIndex === undefined) return [];
  const winner = attempts[winnerIndex];
  if (!winner || winner.type !== 'usenet' || !winner.indexer?.trim()) return [];
  const winnerLabel = indexerLabelFor(winner.indexer);
  const byLoser = new Map<string, number>();
  attempts.forEach((a, i) => {
    if (i === winnerIndex || outcomes[i] !== 'failed') return;
    if (a.type !== 'usenet' || a.rank !== winner.rank || !a.indexer?.trim())
      return;
    if (a.serviceId && winner.serviceId && a.serviceId !== winner.serviceId)
      return;
    const loser = indexerLabelFor(a.indexer);
    if (loser === winnerLabel) return;
    byLoser.set(loser, (byLoser.get(loser) ?? 0) + 1);
  });
  return [...byLoser].map(([loser, rescues]) => ({
    winner: winnerLabel,
    loser,
    rescues,
  }));
}

/** Record one settled play chain's same-release rescues. */
export function recordHeadToHead(
  attempts: readonly HeadToHeadAttempt[],
  outcomes: readonly FailoverAttemptOutcome[],
  winnerIndex: number | undefined
): void {
  const rows = headToHeadRescues(attempts, outcomes, winnerIndex);
  if (rows.length === 0) return;
  UsenetIndexerMetricsRepository.recordHeadToHead(rows).catch((err) =>
    logger.warn({ err }, 'failed to record indexer head-to-head')
  );
}
