import type { Migration } from './types.js';

/**
 * Hourly per-indexer playback grab outcomes by the release's post age: one
 * row per (hour, indexer, age bucket). Only grabs made for playback count, so
 * arr / manual imports of old back catalogue don't skew the older buckets.
 * `blocklisted` counts posts refused before import because the blocklist
 * already knew them dead; without it those failures would never show.
 */
export const usenetIndexerAge: Migration = {
  id: 1006,
  name: 'usenet_indexer_age',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS usenet_indexer_age_metrics (
        hour_ms INTEGER NOT NULL,
        indexer TEXT NOT NULL,
        age_bucket TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        degraded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        failed_missing INTEGER NOT NULL DEFAULT 0,
        blocklisted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, indexer, age_bucket)
      );

      CREATE INDEX IF NOT EXISTS idx_usenet_indexer_age_metrics_hour
        ON usenet_indexer_age_metrics (hour_ms);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS usenet_indexer_age_metrics (
        hour_ms BIGINT NOT NULL,
        indexer TEXT NOT NULL,
        age_bucket TEXT NOT NULL,
        ok BIGINT NOT NULL DEFAULT 0,
        degraded BIGINT NOT NULL DEFAULT 0,
        failed BIGINT NOT NULL DEFAULT 0,
        failed_missing BIGINT NOT NULL DEFAULT 0,
        blocklisted BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, indexer, age_bucket)
      );

      CREATE INDEX IF NOT EXISTS idx_usenet_indexer_age_metrics_hour
        ON usenet_indexer_age_metrics (hour_ms);
    `,
  },
};
