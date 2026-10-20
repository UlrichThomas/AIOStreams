import type { PlaybackMetricRow } from '../../../db/index.js';
import {
  LATENCY_BUCKETS,
  NO_WINNER_RANK,
} from '../../../main/playback-metrics.js';

/** Plays answered at least this slowly count as slow (bucket lower bound). */
const SLOW_BUCKETS: ReadonlySet<string> = new Set(['10-30s', '30s+']);
const RANK_BUCKETS = ['0', '1', '2', '3+'] as const;

export interface PlaybackServiceRow {
  service: string;
  plays: number;
  ok: number;
  /** Mean click-to-answer of this service's ok plays; null without any. */
  avgMs: number | null;
}

/** One content kind's plays over a window, for the dashboard. */
export interface PlaybackSummary {
  plays: number;
  ok: number;
  downloading: number;
  error: number;
  /** The player hung up before an answer was ready. */
  abandoned: number;
  /** ok plays per latency bucket, fastest first. */
  latency: { bucket: string; plays: number }[];
  /** Bucket holding the median / 90th-percentile ok play; null without any. */
  p50Bucket: string | null;
  p90Bucket: string | null;
  /** Share of ok plays that took 10s or more; null without any. */
  slowShare: number | null;
  avgMs: number | null;
  /** ok plays won by another copy of the clicked release. */
  rescuedSameRelease: number;
  /** ok plays won by a different release (rank >= 1). */
  rescuedOtherRelease: number;
  /** ok plays per winning failover rank. */
  depth: { rank: string; plays: number }[];
  /**
   * Failed, unavailable and aborted attempts per play, over every result, so
   * numerator and denominator cover the same plays; null without any.
   */
  wastedPerPlay: number | null;
  byService: PlaybackServiceRow[];
}

/**
 * Pure: the bucket holding the `q` quantile (0–1) of a histogram given in
 * bucket order. Buckets only place a percentile, not pin it.
 */
export function quantileBucket(
  hist: readonly { bucket: string; plays: number }[],
  q: number
): string | null {
  const total = hist.reduce((s, h) => s + h.plays, 0);
  if (total === 0) return null;
  const target = q * total;
  let seen = 0;
  for (const h of hist) {
    seen += h.plays;
    if (seen >= target && h.plays > 0) return h.bucket;
  }
  return hist[hist.length - 1].bucket;
}

/** Pure: summarise one kind's rows. */
export function summarisePlayback(
  rows: readonly PlaybackMetricRow[],
  kind: string
): PlaybackSummary {
  // A retracted provisional answer nets its row to zero in every column.
  const mine = rows.filter((r) => r.kind === kind && r.plays > 0);
  const ok = mine.filter((r) => r.result === 'ok');
  const sum = (
    rs: readonly PlaybackMetricRow[],
    f: (r: PlaybackMetricRow) => number
  ) => rs.reduce((s, r) => s + f(r), 0);
  const plays = (rs: readonly PlaybackMetricRow[]) => sum(rs, (r) => r.plays);
  const byResult = (result: string) =>
    plays(mine.filter((r) => r.result === result));

  const okPlays = plays(ok);
  const latency = LATENCY_BUCKETS.map((bucket) => ({
    bucket,
    plays: plays(ok.filter((r) => r.latencyBucket === bucket)),
  }));
  const wasted = sum(
    mine,
    (r) => r.failedAttempts + r.unavailableAttempts + r.abortedAttempts
  );

  const services = new Map<string, PlaybackMetricRow[]>();
  for (const r of mine) {
    const list = services.get(r.service);
    if (list) list.push(r);
    else services.set(r.service, [r]);
  }
  const byService = [...services]
    .map(([service, rs]) => {
      const sOk = rs.filter((r) => r.result === 'ok');
      const n = plays(sOk);
      return {
        service,
        plays: plays(rs),
        ok: n,
        avgMs: n > 0 ? Math.round(sum(sOk, (r) => r.sumMs) / n) : null,
      };
    })
    .sort((a, b) => b.plays - a.plays);

  return {
    plays: plays(mine),
    ok: okPlays,
    downloading: byResult('downloading'),
    error: byResult('error'),
    abandoned: byResult('abandoned'),
    latency,
    p50Bucket: quantileBucket(latency, 0.5),
    p90Bucket: quantileBucket(latency, 0.9),
    slowShare:
      okPlays > 0
        ? plays(ok.filter((r) => SLOW_BUCKETS.has(r.latencyBucket))) / okPlays
        : null,
    avgMs: okPlays > 0 ? Math.round(sum(ok, (r) => r.sumMs) / okPlays) : null,
    rescuedSameRelease: sum(ok, (r) => r.sameReleaseWins),
    rescuedOtherRelease: plays(
      ok.filter((r) => r.rankBucket !== '0' && r.rankBucket !== NO_WINNER_RANK)
    ),
    depth: RANK_BUCKETS.map((rank) => ({
      rank,
      plays: plays(ok.filter((r) => r.rankBucket === rank)),
    })),
    wastedPerPlay: mine.length > 0 ? wasted / plays(mine) : null,
    byService,
  };
}
