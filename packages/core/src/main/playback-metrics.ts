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

/**
 * How long a click's answer suppresses repeat records of it: about a film's
 * length, since some players go back to the playback URL on every seek or
 * reconnect, and each of those would otherwise count as a near-instant play.
 */
const DEDUPE_WINDOW_MS = 3 * 3_600_000;
const DEDUPE_MAX_KEYS = 5_000;

/**
 * A final answer that starts within this long of a provisional one (or before
 * it settled, as a request joining the same chain does) continues that wait,
 * so it is timed from the first request. A later re-click is timed on its own.
 */
const RETRY_GAP_MS = 30_000;

/** Results a later answer for the same click replaces rather than adds to. */
const PROVISIONAL: ReadonlySet<PlaybackResult> = new Set([
  'downloading',
  'abandoned',
]);

/** A click's remembered answer, as the dedupe stores keep it. */
export interface SeenClick {
  result: PlaybackResult;
  /** When the answer was recorded: its row is in this hour. */
  atMs: number;
  /** When the wait this answer ended began. */
  startMs: number;
  /** The row recorded for it, so a later answer can retract it. */
  delta: PlaybackMetricDelta;
}

/** One click's answer, as the route measured it. */
export interface ClickAnswer {
  startMs: number;
  delta: PlaybackMetricDelta;
}

/** One fold into the hourly rows, at the hour of `atMs`. */
export interface PlaybackWrite {
  delta: PlaybackMetricDelta;
  atMs: number;
}

/** Cross-replica memory for {@link PlaybackDeduper} (Redis-backed Cache). */
export interface PlaybackDedupeStore {
  get(key: string): Promise<SeenClick | undefined>;
  set(key: string, value: SeenClick, ttlSeconds: number): Promise<void>;
}

/** Pure: `d` timed as `ms` instead. */
export function withLatency(
  d: PlaybackMetricDelta,
  ms: number
): PlaybackMetricDelta {
  return {
    ...d,
    latencyBucket: latencyBucket(ms),
    sumMs: Math.max(0, Math.round(ms)),
  };
}

/** Pure: the delta that cancels `d` in its row. */
export function negateDelta(d: PlaybackMetricDelta): PlaybackMetricDelta {
  return {
    ...d,
    plays: -d.plays,
    sumMs: -d.sumMs,
    sameReleaseWins: -d.sameReleaseWins,
    attemptsLaunched: -d.attemptsLaunched,
    failedAttempts: -d.failedAttempts,
    unavailableAttempts: -d.unavailableAttempts,
    abortedAttempts: -d.abortedAttempts,
  };
}

/**
 * Counts each click once. A repeat of a click that played is dropped. A click
 * left provisional ('downloading', or the player hung up) is replaced by its
 * final answer: the provisional row is retracted in the hour it was recorded
 * and the final one recorded, so "downloading, then played on the retry" or a
 * hung-up request beside a retry that joined its chain reads as one play. A
 * retry after an error is a real second wait and counts again. The local map
 * keeps same-replica checks atomic; the optional shared store catches a retry
 * that lands on another replica.
 */
export class PlaybackDeduper {
  private readonly seen = new Map<string, SeenClick>();

  constructor(
    private readonly shared?: PlaybackDedupeStore,
    private readonly windowMs = DEDUPE_WINDOW_MS
  ) {}

  /** What an answer writes given the click's earlier one; null drops it. */
  private plan(
    prev: SeenClick | undefined,
    a: ClickAnswer,
    nowMs: number
  ): { entry: SeenClick; writes: PlaybackWrite[] } | null {
    const result = a.delta.result as PlaybackResult;
    const record = (delta: PlaybackMetricDelta, startMs: number) => ({
      entry: { result, atMs: nowMs, startMs, delta },
      writes: [{ delta, atMs: nowMs }],
    });
    if (!prev || nowMs - prev.atMs >= this.windowMs || prev.result === 'error')
      return record(a.delta, a.startMs);
    if (!PROVISIONAL.has(prev.result) || PROVISIONAL.has(result)) return null;
    const continues = a.startMs - prev.atMs <= RETRY_GAP_MS;
    const startMs = continues ? Math.min(prev.startMs, a.startMs) : a.startMs;
    const out = record(
      continues ? withLatency(a.delta, nowMs - startMs) : a.delta,
      startMs
    );
    out.writes.unshift({ delta: negateDelta(prev.delta), atMs: prev.atMs });
    return out;
  }

  /** The writes this answer makes (none for a repeat); remembers it. */
  async admit(
    key: string,
    a: ClickAnswer,
    nowMs = Date.now()
  ): Promise<PlaybackWrite[]> {
    const local = this.seen.get(key);
    const mine = this.plan(local, a, nowMs);
    if (!mine) return [];
    // Reserve before awaiting, so a concurrent answer here plans against it.
    this.remember(key, mine.entry, nowMs);
    if (!this.shared) return mine.writes;
    const remote = await this.shared.get(key).catch(() => undefined);
    // Only another replica's newer answer changes the plan.
    const plan =
      remote && (!local || remote.atMs > local.atMs)
        ? this.plan(remote, a, nowMs)
        : mine;
    if (!plan) {
      this.remember(key, remote!, nowMs);
      return [];
    }
    if (plan !== mine) this.remember(key, plan.entry, nowMs);
    await this.shared
      .set(key, plan.entry, Math.ceil(this.windowMs / 1000))
      .catch(() => {});
    return plan.writes;
  }

  private remember(key: string, entry: SeenClick, nowMs: number): void {
    // Re-insert so Map order stays oldest-first for pruning.
    this.seen.delete(key);
    if (this.seen.size >= DEDUPE_MAX_KEYS) this.prune(nowMs);
    this.seen.set(key, entry);
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
    const nowMs = Date.now();
    getDeduper()
      .admit(
        dedupeKey,
        { startMs: nowMs - o.ms, delta: playbackDelta(o) },
        nowMs
      )
      .then(async (writes) => {
        for (const w of writes)
          await PlaybackMetricsRepository.record(w.delta, w.atMs);
      })
      .catch((err) =>
        logger.warn({ err }, 'failed to record playback outcome')
      );
  } catch (err) {
    logger.warn({ err }, 'failed to compute playback outcome');
  }
}
