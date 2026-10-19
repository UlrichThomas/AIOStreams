import type { Migration } from './types.js';

/**
 * Hourly playback-resolve outcomes: one row per (hour, kind, service, result,
 * rank bucket, latency bucket) counts plays, their summed time from click to
 * answer, and the failover attempts they spent. Latency is a bucket in the
 * key, not just a sum, so the dashboard can place p50 / p90 rather than show
 * an average that hides the slow plays.
 */
export const playbackMetrics: Migration = {
  id: 1005,
  name: 'playback_metrics',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS playback_metrics (
        hour_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        service TEXT NOT NULL,
        result TEXT NOT NULL,
        rank_bucket TEXT NOT NULL,
        latency_bucket TEXT NOT NULL,
        plays INTEGER NOT NULL DEFAULT 0,
        sum_ms INTEGER NOT NULL DEFAULT 0,
        same_release_wins INTEGER NOT NULL DEFAULT 0,
        attempts_launched INTEGER NOT NULL DEFAULT 0,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        unavailable_attempts INTEGER NOT NULL DEFAULT 0,
        aborted_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, kind, service, result, rank_bucket, latency_bucket)
      );

      CREATE INDEX IF NOT EXISTS idx_playback_metrics_hour
        ON playback_metrics (hour_ms);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS playback_metrics (
        hour_ms BIGINT NOT NULL,
        kind TEXT NOT NULL,
        service TEXT NOT NULL,
        result TEXT NOT NULL,
        rank_bucket TEXT NOT NULL,
        latency_bucket TEXT NOT NULL,
        plays BIGINT NOT NULL DEFAULT 0,
        sum_ms BIGINT NOT NULL DEFAULT 0,
        same_release_wins BIGINT NOT NULL DEFAULT 0,
        attempts_launched BIGINT NOT NULL DEFAULT 0,
        failed_attempts BIGINT NOT NULL DEFAULT 0,
        unavailable_attempts BIGINT NOT NULL DEFAULT 0,
        aborted_attempts BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, kind, service, result, rank_bucket, latency_bucket)
      );

      CREATE INDEX IF NOT EXISTS idx_playback_metrics_hour
        ON playback_metrics (hour_ms);
    `,
  },
};
