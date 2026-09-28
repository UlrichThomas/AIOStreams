import type { Migration } from './types.js';

const COLS = [
  'uniq_requests', // stream requests where this indexer returned >= 1 release
  'uniq_releases', // distinct releases returned across those requests
  'uniq_unique', // releases no other indexer returned in the same request
  'uniq_sole', // requests where this was the only indexer with results
];

export const usenetIndexerUniqueness: Migration = {
  id: 41,
  name: 'usenet_indexer_uniqueness',
  up: {
    sqlite: `
        ${COLS.map((c) => `ALTER TABLE usenet_indexer_metrics ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0;`).join('\n')}
    `,
    postgres: `
        ${COLS.map((c) => `ALTER TABLE usenet_indexer_metrics ADD COLUMN IF NOT EXISTS ${c} BIGINT NOT NULL DEFAULT 0;`).join('\n')}
    `,
  },
};
