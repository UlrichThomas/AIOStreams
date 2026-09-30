import type { Migration } from './types.js';

const COLS = [
  'search_requests', // upstream search calls made
  'search_failed', // calls that threw an error
  'search_empty', //calls that succeeded with 0 items
  'search_auth', // subset of failed: 401/403 or newznab 100-102
  'search_limited', // subset of failed: 429 or newznab 500/501
  'search_timeout', // subset of failed: request timed out
  'sum_search_ms', // latency sum (avg = / search_requests)
  'results', // items attributed to this indexer label
  'search_hits', // calls where this label returned >= 1 item
];

export const usenetIndexerSearch: Migration = {
  id: 1001,
  name: 'usenet_indexer_search',
  up: {
    sqlite: `
        ${COLS.map((c) => `ALTER TABLE usenet_indexer_metrics ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0;`).join('\n')}
            CREATE TABLE IF NOT EXISTS usenet_indexer_last_search_error (
                indexer TEXT PRIMARY KEY,
                status INTEGER,
                message TEXT NOT NULL,
                at_ms INTEGER NOT NULL
        );
    `,
    postgres: `
        ${COLS.map((c) => `ALTER TABLE usenet_indexer_metrics ADD COLUMN IF NOT EXISTS ${c} BIGINT NOT NULL DEFAULT 0;`).join('\n')}
            CREATE TABLE IF NOT EXISTS usenet_indexer_last_search_error (
                indexer TEXT PRIMARY KEY,
                status INTEGER,
                message TEXT NOT NULL,
                at_ms BIGINT NOT NULL
        );
    `,
  },
};
