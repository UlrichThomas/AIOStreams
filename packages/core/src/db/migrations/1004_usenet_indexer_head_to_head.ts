import type { Migration } from './types.js';

/**
 * Hourly same-release failover outcomes between indexers: one row per
 * (hour, winner, loser) counts how often `loser`'s NZB failed and `winner`'s
 * copy of the same release then played. The most direct evidence for which
 * indexer to prefer when both return a release.
 */
export const usenetIndexerHeadToHead: Migration = {
  id: 1004,
  name: 'usenet_indexer_head_to_head',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS usenet_indexer_h2h (
        hour_ms INTEGER NOT NULL,
        winner TEXT NOT NULL,
        loser TEXT NOT NULL,
        rescues INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, winner, loser)
      );

      CREATE INDEX IF NOT EXISTS idx_usenet_indexer_h2h_hour
        ON usenet_indexer_h2h (hour_ms);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS usenet_indexer_h2h (
        hour_ms BIGINT NOT NULL,
        winner TEXT NOT NULL,
        loser TEXT NOT NULL,
        rescues BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, winner, loser)
      );

      CREATE INDEX IF NOT EXISTS idx_usenet_indexer_h2h_hour
        ON usenet_indexer_h2h (hour_ms);
    `,
  },
};
