import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Use the normal core entry point to initialise the dependency graph.
import '../../index.js';
import { closeDb, initDb } from '../../db/db.js';
import { UsenetIndexerMetricsRepository } from '../../db/index.js';
import { headToHeadRescues, type HeadToHeadAttempt } from './head-to-head.js';

const usenet = (rank: number, indexer?: string): HeadToHeadAttempt => ({
  type: 'usenet',
  rank,
  indexer,
});

describe('headToHeadRescues', () => {
  it('credits the winner over each failed copy of the same release', () => {
    const rows = headToHeadRescues(
      [usenet(0, 'A'), usenet(0, 'B'), usenet(0, 'C')],
      ['failed', 'failed', 'ok'],
      2
    );
    assert.deepEqual(
      rows.sort((x, y) => (x.loser < y.loser ? -1 : 1)),
      [
        { winner: 'C', loser: 'A', rescues: 1 },
        { winner: 'C', loser: 'B', rescues: 1 },
      ]
    );
  });

  it('ignores other releases, aborted and terminal attempts', () => {
    const rows = headToHeadRescues(
      [usenet(0, 'A'), usenet(0, 'B'), usenet(1, 'C'), usenet(1, 'D')],
      ['aborted', 'error', 'failed', 'ok'],
      3
    );
    assert.deepEqual(rows, [{ winner: 'D', loser: 'C', rescues: 1 }]);
  });

  it('records nothing without a winner, a named indexer, or a usenet win', () => {
    assert.deepEqual(
      headToHeadRescues(
        [usenet(0, 'A'), usenet(0, 'B')],
        ['failed', 'failed'],
        undefined
      ),
      []
    );
    assert.deepEqual(
      headToHeadRescues([usenet(0, 'A'), usenet(0)], ['failed', 'ok'], 1),
      []
    );
    assert.deepEqual(
      headToHeadRescues(
        [usenet(0, 'A'), { type: 'debrid', rank: 0, indexer: 'B' }],
        ['failed', 'ok'],
        1
      ),
      []
    );
  });

  it('skips a failed copy from the winning indexer itself', () => {
    assert.deepEqual(
      headToHeadRescues([usenet(0, 'A'), usenet(0, 'A')], ['failed', 'ok'], 1),
      []
    );
  });
});

describe('UsenetIndexerMetricsRepository head-to-head', () => {
  const dir = path.join(
    process.cwd(),
    '.test-tmp',
    `h2h-${process.pid}-${Date.now()}`
  );

  before(async () => {
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.relative(process.cwd(), dir).split(path.sep).join('/');
    await initDb(`sqlite://./${rel}/db.sqlite`);
  });

  after(async () => {
    await closeDb();
    fs.rmSync(path.join(process.cwd(), '.test-tmp'), {
      recursive: true,
      force: true,
    });
  });

  it('accumulates rescues per pair and prunes old hours', async () => {
    const hour = 3_600_000;
    const now = Date.now();
    await UsenetIndexerMetricsRepository.recordHeadToHead(
      [{ winner: 'B', loser: 'A', rescues: 1 }],
      now
    );
    await UsenetIndexerMetricsRepository.recordHeadToHead(
      [
        { winner: 'B', loser: 'A', rescues: 2 },
        { winner: 'A', loser: 'B', rescues: 1 },
      ],
      now
    );
    await UsenetIndexerMetricsRepository.recordHeadToHead(
      [{ winner: 'C', loser: 'A', rescues: 4 }],
      now - 48 * hour
    );

    const recent = await UsenetIndexerMetricsRepository.headToHeadSince(
      now - 24 * hour
    );
    assert.deepEqual(
      recent.sort((x, y) => (x.winner < y.winner ? -1 : 1)),
      [
        { winner: 'A', loser: 'B', rescues: 1 },
        { winner: 'B', loser: 'A', rescues: 3 },
      ]
    );

    await UsenetIndexerMetricsRepository.pruneOlderThan(now - 24 * hour);
    const all = await UsenetIndexerMetricsRepository.headToHeadSince(0);
    assert.equal(
      all.some((r) => r.winner === 'C'),
      false
    );

    await UsenetIndexerMetricsRepository.deleteScope({ indexer: 'A' });
    assert.deepEqual(
      await UsenetIndexerMetricsRepository.headToHeadSince(0),
      []
    );
  });
});
