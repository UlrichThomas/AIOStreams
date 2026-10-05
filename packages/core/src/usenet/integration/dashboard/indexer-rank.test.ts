import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { UsenetIndexerRollup } from '../../../db/index.js';
import {
  indexerRankInput,
  MIN_RANK_GRABS,
  suggestedRanks,
  wilsonInterval,
} from './indexer-rank.js';

function rollup(
  indexer: string,
  ok: number,
  failed: number,
  extra: Partial<UsenetIndexerRollup> = {}
): UsenetIndexerRollup {
  return {
    indexer,
    grabs: ok + failed,
    ok,
    degraded: 0,
    failed,
    failedMissing: 0,
    failedFetch: 0,
    fetchAuth: 0,
    fetchLimited: 0,
    sumGrabMs: 0,
    grabSamples: 0,
    sumImportMs: 0,
    importSamples: 0,
    searchRequests: 0,
    searchFailed: 0,
    searchEmpty: 0,
    searchAuth: 0,
    searchLimited: 0,
    searchTimeout: 0,
    sumSearchMs: 0,
    results: 0,
    searchHits: 0,
    uniqRequests: 0,
    uniqReleases: 0,
    uniqUnique: 0,
    uniqSole: 0,
    ...extra,
  };
}

function inputs(...rows: UsenetIndexerRollup[]) {
  return new Map(rows.map((r) => [r.indexer, indexerRankInput(r)]));
}

describe('wilsonInterval', () => {
  it('is wide on little data and narrow on a lot', () => {
    const few = wilsonInterval(3, 3);
    const many = wilsonInterval(480, 500);
    assert.ok(few.upper - few.lower > many.upper - many.lower);
    assert.ok(many.lower > few.lower);
  });

  it('covers everything with no data', () => {
    assert.deepEqual(wilsonInterval(0, 0), { lower: 0, upper: 1 });
  });
});

describe('indexerRankInput', () => {
  it('leaves an indexer unranked below the minimum grabs', () => {
    const r = indexerRankInput(rollup('a', MIN_RANK_GRABS - 1, 0));
    assert.equal(r.score, null);
  });

  it('ranks a long record above a short perfect one', () => {
    const long = indexerRankInput(rollup('long', 480, 20));
    const short = indexerRankInput(rollup('short', 10, 0));
    assert.ok(long.score! > short.score!);
  });

  it('leaves auth and rate-limit fetch failures out', () => {
    const r = indexerRankInput(
      rollup('a', 20, 10, { failedFetch: 10, fetchAuth: 6, fetchLimited: 4 })
    );
    assert.equal(r.attributableGrabs, 20);
    assert.equal(r.successes, 20);
  });

  it('counts missing-article failures against the indexer', () => {
    const clean = indexerRankInput(rollup('a', 50, 0));
    const missing = indexerRankInput(
      rollup('b', 40, 10, { failedMissing: 10 })
    );
    assert.ok(clean.score! > missing.score!);
  });

  it('adds a small bonus for unique releases', () => {
    const plain = indexerRankInput(rollup('a', 50, 0));
    const unique = indexerRankInput(
      rollup('b', 50, 0, { uniqReleases: 10, uniqUnique: 5 })
    );
    assert.ok(Math.abs(unique.score! - plain.score! - 0.05) < 0.002);
  });
});

describe('suggestedRanks', () => {
  it('orders by score and skips unranked indexers', () => {
    const ranks = suggestedRanks(
      inputs(rollup('b', 40, 10), rollup('a', 50, 0), rollup('c', 2, 0)),
      []
    );
    assert.deepEqual(
      [...ranks],
      [
        ['a', 1],
        ['b', 2],
      ]
    );
  });

  it('lets head-to-head swap indexers whose rates overlap', () => {
    const rows = inputs(rollup('a', 48, 2), rollup('b', 47, 3));
    assert.equal(suggestedRanks(rows, []).get('a'), 1);
    const ranks = suggestedRanks(rows, [
      { winner: 'b', loser: 'a', rescues: 5 },
      { winner: 'a', loser: 'b', rescues: 1 },
    ]);
    assert.equal(ranks.get('b'), 1);
    assert.equal(ranks.get('a'), 2);
  });

  it('needs enough net rescues to swap', () => {
    const rows = inputs(rollup('a', 48, 2), rollup('b', 47, 3));
    const ranks = suggestedRanks(rows, [
      { winner: 'b', loser: 'a', rescues: 3 },
      { winner: 'a', loser: 'b', rescues: 1 },
    ]);
    assert.equal(ranks.get('a'), 1);
  });

  it('does not swap when the rates clearly differ', () => {
    const rows = inputs(rollup('a', 990, 10), rollup('b', 300, 200));
    const ranks = suggestedRanks(rows, [
      { winner: 'b', loser: 'a', rescues: 50 },
    ]);
    assert.equal(ranks.get('a'), 1);
  });
});
