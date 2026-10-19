import { getDb } from '../db.js';
import { join, sql, type SqlFragment } from '../sql.js';

/** One play's outcome, already bucketed, to fold into an hourly row. */
export interface PlaybackMetricDelta {
  /** Content type of the clicked item: 'usenet' or 'debrid'. */
  kind: string;
  /** Service that answered (or the clicked item's), else 'unknown'. */
  service: string;
  /** 'ok' | 'downloading' | 'error' | 'abandoned'. */
  result: string;
  /** Failover rank of the winner ('0', '1', '2', '3+'), or '-' without one. */
  rankBucket: string;
  latencyBucket: string;
  plays: number;
  sumMs: number;
  /** Plays won by a same-release copy other than the clicked item. */
  sameReleaseWins: number;
  attemptsLaunched: number;
  failedAttempts: number;
  unavailableAttempts: number;
  abortedAttempts: number;
}

/** Totals per key over a window: same shape as a delta. */
export type PlaybackMetricRow = PlaybackMetricDelta;

/** An empty scope matches every row. */
export interface PlaybackMetricScope {
  /** Inclusive lower bound on `hour_ms`. */
  sinceMs?: number;
  /** Exclusive upper bound on `hour_ms`. */
  untilMs?: number;
}

const HOUR_MS = 3_600_000;

function hourFloor(ts: number): number {
  return ts - (ts % HOUR_MS);
}

function scopeWhere(s: PlaybackMetricScope): SqlFragment {
  const parts: SqlFragment[] = [];
  if (s.sinceMs !== undefined) parts.push(sql`hour_ms >= ${s.sinceMs}`);
  if (s.untilMs !== undefined) parts.push(sql`hour_ms < ${s.untilMs}`);
  return parts.length === 0 ? sql`1 = 1` : join(parts, ' AND ');
}

/**
 * Persistence for playback-resolve rollups (`playback_metrics`): how long a
 * click took to answer and how much failover it needed.
 */
export class PlaybackMetricsRepository {
  /** Fold one play into the hour bucket containing `atMs`. */
  static async record(
    d: PlaybackMetricDelta,
    atMs: number = Date.now()
  ): Promise<void> {
    const hourMs = hourFloor(atMs);
    await getDb().exec(
      sql`INSERT INTO playback_metrics
            (hour_ms, kind, service, result, rank_bucket, latency_bucket, plays, sum_ms, same_release_wins, attempts_launched, failed_attempts, unavailable_attempts, aborted_attempts)
          VALUES
            (${hourMs}, ${d.kind}, ${d.service}, ${d.result}, ${d.rankBucket}, ${d.latencyBucket}, ${d.plays}, ${d.sumMs}, ${d.sameReleaseWins}, ${d.attemptsLaunched}, ${d.failedAttempts}, ${d.unavailableAttempts}, ${d.abortedAttempts})
          ON CONFLICT(hour_ms, kind, service, result, rank_bucket, latency_bucket) DO UPDATE SET
            plays = playback_metrics.plays + EXCLUDED.plays,
            sum_ms = playback_metrics.sum_ms + EXCLUDED.sum_ms,
            same_release_wins = playback_metrics.same_release_wins + EXCLUDED.same_release_wins,
            attempts_launched = playback_metrics.attempts_launched + EXCLUDED.attempts_launched,
            failed_attempts = playback_metrics.failed_attempts + EXCLUDED.failed_attempts,
            unavailable_attempts = playback_metrics.unavailable_attempts + EXCLUDED.unavailable_attempts,
            aborted_attempts = playback_metrics.aborted_attempts + EXCLUDED.aborted_attempts`
    );
  }

  /** Totals per (kind, service, result, rank, latency) over [sinceMs, now]. */
  static async summarySince(sinceMs: number): Promise<PlaybackMetricRow[]> {
    const rows = await getDb().query<Record<string, string | number>>(
      sql`SELECT kind, service, result, rank_bucket, latency_bucket,
                 SUM(plays) AS plays,
                 SUM(sum_ms) AS sum_ms,
                 SUM(same_release_wins) AS same_release_wins,
                 SUM(attempts_launched) AS attempts_launched,
                 SUM(failed_attempts) AS failed_attempts,
                 SUM(unavailable_attempts) AS unavailable_attempts,
                 SUM(aborted_attempts) AS aborted_attempts
            FROM playback_metrics
           WHERE hour_ms >= ${sinceMs}
           GROUP BY kind, service, result, rank_bucket, latency_bucket`
    );
    return rows.map((r) => ({
      kind: String(r.kind),
      service: String(r.service),
      result: String(r.result),
      rankBucket: String(r.rank_bucket),
      latencyBucket: String(r.latency_bucket),
      plays: Number(r.plays ?? 0),
      sumMs: Number(r.sum_ms ?? 0),
      sameReleaseWins: Number(r.same_release_wins ?? 0),
      attemptsLaunched: Number(r.attempts_launched ?? 0),
      failedAttempts: Number(r.failed_attempts ?? 0),
      unavailableAttempts: Number(r.unavailable_attempts ?? 0),
      abortedAttempts: Number(r.aborted_attempts ?? 0),
    }));
  }

  /** Rows and plays in a scope, for previewing what a reset would remove. */
  static async sumScope(
    scope: PlaybackMetricScope
  ): Promise<{ rows: number; plays: number }> {
    // `rows` is a reserved word in postgres; alias around it.
    const row = await getDb().maybeOne<{
      row_count: number | string;
      plays: number | string | null;
    }>(
      sql`SELECT COUNT(*) AS row_count, SUM(plays) AS plays
            FROM playback_metrics
           WHERE ${scopeWhere(scope)}`
    );
    return {
      rows: Number(row?.row_count ?? 0),
      plays: Number(row?.plays ?? 0),
    };
  }

  /** Returns the rows removed. */
  static async deleteScope(scope: PlaybackMetricScope): Promise<number> {
    const res = await getDb().exec(
      sql`DELETE FROM playback_metrics WHERE ${scopeWhere(scope)}`
    );
    return res.rowCount ?? 0;
  }

  /** Delete rows older than the cutoff; returns the rows removed. */
  static async pruneOlderThan(cutoffMs: number): Promise<number> {
    const res = await getDb().exec(
      sql`DELETE FROM playback_metrics WHERE hour_ms < ${cutoffMs}`
    );
    return res.rowCount ?? 0;
  }
}
