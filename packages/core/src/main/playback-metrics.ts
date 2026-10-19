import {
  PlaybackMetricsRepository,
  type PlaybackMetricDelta,
} from '../db/index.js';
import { createLogger } from '../logging/logger.js';
import { Cache } from '../utils/cache.js';
import { requestLockType } from '../utils/distributed-lock.js';
import type { FailoverAttemptOutcome } from './failover.js';

const logger = createLogger('playback-metrics');

/** Upper bounds (exclusive, ms) of the latency buckets, in order. */
const LATENCY_BOUNDS: readonly [number, string][] = [
  [2_000, '<2s'],
  [5_000, '2-5s'],
  [10_000, '5-10s'],
  [30_000, '10-30s'],
];
const LATENCY_OPEN_BUCKET = '30s+';

/** Every latency bucket, fastest first. */
export const LATENCY_BUCKETS: readonly string[] = [
  ...LATENCY_BOUNDS.map(([, label]) => label),
  LATENCY_OPEN_BUCKET,
];

/** Rank bucket for a play no attempt won. */
export const NO_WINNER_RANK = '-';

export type PlaybackResult = 'ok' | 'downloading' | 'error' | 'abandoned';

/** What the playback tally needs to know about one failover attempt. */
export interface PlaybackAttemptInfo {
  /** Failover rank; same-release copies share their release's rank. */
  rank: number;
  serviceId?: string;
}

/** One settled click, as the play route saw it. */
export interface PlaybackOutcome {
  /** Content type of the clicked item. */
  kind: 'usenet' | 'debrid';
  /** Indexed like `outcomes`; index 0 is the clicked item. */
  attempts: readonly PlaybackAttemptInfo[];
  outcomes: readonly FailoverAttemptOutcome[];
  winnerIndex?: number;
  /** The chain produced a playable URL. */
  resolved: boolean;
  /** The chain ended in an error rather than "still downloading". */
  errored: boolean;
  /** Click to answer, including the chain's queueing and imports. */
  ms: number;
  /** The client hung up before the answer was ready. */
  abandoned: boolean;
}

/** Pure: the latency bucket a duration falls in. */
export function latencyBucket(ms: number): string {
  for (const [bound, label] of LATENCY_BOUNDS) if (ms < bound) return label;
  return LATENCY_OPEN_BUCKET;
}

/** Pure: how one click ended, a hang-up taking precedence. */
export function playbackResult(
  o: Pick<PlaybackOutcome, 'resolved' | 'errored' | 'abandoned'>
): PlaybackResult {
  if (o.abandoned) return 'abandoned';
  if (o.resolved) return 'ok';
  return o.errored ? 'error' : 'downloading';
}

/**
 * Pure: the hourly-row delta for one click. Depth is the winner's failover
 * rank (distinct releases), not its position in the chain, so a second copy
 * of the clicked release reads as a same-release win at rank 0 rather than as
 * a fallback to another release.
 */
export function playbackDelta(o: PlaybackOutcome): PlaybackMetricDelta {
  const winner =
    o.winnerIndex !== undefined ? o.attempts[o.winnerIndex] : undefined;
  const count = (outcome: FailoverAttemptOutcome) =>
    o.outcomes.filter((x) => x === outcome).length;
  return {
    kind: o.kind,
    service: winner?.serviceId ?? o.attempts[0]?.serviceId ?? 'unknown',
    result: playbackResult(o),
    rankBucket: winner
      ? winner.rank >= 3
        ? '3+'
        : String(Math.max(0, winner.rank))
      : NO_WINNER_RANK,
    latencyBucket: latencyBucket(o.ms),
    plays: 1,
    sumMs: Math.max(0, Math.round(o.ms)),
    sameReleaseWins: winner && o.winnerIndex! > 0 && winner.rank === 0 ? 1 : 0,
    attemptsLaunched: o.outcomes.filter((x) => x !== 'not_run').length,
    failedAttempts: count('failed'),
    unavailableAttempts: count('unavailable'),
    abortedAttempts: count('aborted'),
  };
}

/** How long a click's answer suppresses repeat records of it. */
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_KEYS = 5_000;

/** A click's remembered answer, as the dedupe stores keep it. */
interface SeenClick {
  result: PlaybackResult;
  atMs: number;
}

/** Cross-replica memory for {@link PlaybackDeduper} (Redis-backed Cache). */
export interface PlaybackDedupeStore {
  get(key: string): Promise<SeenClick | undefined>;
  set(key: string, value: SeenClick, ttlSeconds: number): Promise<void>;
}

/**
 * Drops repeat requests for a click that already got its answer: a player
 * re-requesting the URL would otherwise record a play each time, the later
 * ones near-instant off the warm resolve. A click that errored or was
 * abandoned can be recorded again, since a retry after either is a real
 * second wait. The local map keeps same-replica checks atomic; the optional
 * shared store catches a retry that lands on another replica.
 */
export class PlaybackDeduper {
  private readonly seen = new Map<string, SeenClick>();

  constructor(
    private readonly shared?: PlaybackDedupeStore,
    private readonly windowMs = DEDUPE_WINDOW_MS
  ) {}

  private blocks(prev: SeenClick | undefined, nowMs: number): boolean {
    return (
      !!prev &&
      nowMs - prev.atMs < this.windowMs &&
      (prev.result === 'ok' || prev.result === 'downloading')
    );
  }

  /** Whether to record this click; remembers it when so. */
  async admit(
    key: string,
    result: PlaybackResult,
    nowMs = Date.now()
  ): Promise<boolean> {
    if (this.blocks(this.seen.get(key), nowMs)) return false;
    if (this.seen.size >= DEDUPE_MAX_KEYS) this.prune(nowMs);
    this.seen.set(key, { result, atMs: nowMs });
    if (!this.shared) return true;
    const prev = await this.shared.get(key).catch(() => undefined);
    if (this.blocks(prev, nowMs)) return false;
    await this.shared
      .set(key, { result, atMs: nowMs }, Math.ceil(this.windowMs / 1000))
      .catch(() => {});
    return true;
  }

  private prune(nowMs: number): void {
    for (const [key, v] of this.seen)
      if (nowMs - v.atMs >= this.windowMs) this.seen.delete(key);
    // Still full: drop the oldest, which Map iteration order yields first.
    for (const key of this.seen.keys()) {
      if (this.seen.size < DEDUPE_MAX_KEYS) break;
      this.seen.delete(key);
    }
  }
}

let deduper: PlaybackDeduper | undefined;

/** Built on first use, once config says whether Redis is there to share. */
function getDeduper(): PlaybackDeduper {
  return (deduper ??= new PlaybackDeduper(
    requestLockType() === 'redis'
      ? Cache.getInstance<string, SeenClick>('playback:dedupe', 10_000, 'redis')
      : undefined
  ));
}

/**
 * Record one settled click, once per `dedupeKey` (see {@link PlaybackDeduper}).
 * Fire-and-forget: never lets metrics affect playback.
 */
export function recordPlayback(o: PlaybackOutcome, dedupeKey: string): void {
  try {
    const delta = playbackDelta(o);
    getDeduper()
      .admit(dedupeKey, delta.result as PlaybackResult)
      .then((admitted) =>
        admitted ? PlaybackMetricsRepository.record(delta) : undefined
      )
      .catch((err) =>
        logger.warn({ err }, 'failed to record playback outcome')
      );
  } catch (err) {
    logger.warn({ err }, 'failed to compute playback outcome');
  }
}
