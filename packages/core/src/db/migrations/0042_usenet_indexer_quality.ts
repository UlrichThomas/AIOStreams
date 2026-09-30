import type { Migration } from './types.js';

/**
 * Hourly per-indexer resolution × quality counts: one row per
 * (hour, indexer, resolution, quality) accumulates how many distinct releases
 * of that kind the indexer returned per stream request (raw results, before
 * the user's filters). A separate table because the combinations are not a
 * fixed set of columns.
 */
export const usenetIndexerQuality: Migration = {
  id: 42,
  name: 'usenet_indexer_quality',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS usenet_indexer_quality_metrics (
        hour_ms INTEGER NOT NULL,
        indexer TEXT NOT NULL,
        resolution TEXT NOT NULL,
        quality TEXT NOT NULL,
        releases INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, indexer, resolution, quality)
      );

      CREATE INDEX IF NOT EXISTS idx_usenet_indexer_quality_metrics_hour
        ON usenet_indexer_quality_metrics (hour_ms);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS usenet_indexer_quality_metrics (
        hour_ms BIGINT NOT NULL,
        indexer TEXT NOT NULL,
        resolution TEXT NOT NULL,
        quality TEXT NOT NULL,
        releases BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, indexer, resolution, quality)
      );

      CREATE INDEX IF NOT EXISTS idx_usenet_indexer_quality_metrics_hour
        ON usenet_indexer_quality_metrics (hour_ms);
    `,
  },
};
