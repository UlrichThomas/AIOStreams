import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Use the normal core entry point to initialise the dependency graph.
import '../../index.js';
import { closeDb, initDb } from '../../db/db.js';
import { UsenetIndexerMetricsRepository } from '../../db/index.js';
import { ReleaseBlocklistRepository } from '../../db/repositories/release-blocklist.js';
import {
  ageBucket,
  ageDelta,
  AGE_BUCKETS,
  recordBlocklistRefusal,
} from './age-metrics.js';
import { ageCells } from './dashboard/stats.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 19);
/** NZB `date` (seconds) for a post `days` old. */
const postedDaysAgo = (days: number) => (now - days * DAY) / 1000;

describe('ageBucket', () => {
  it('buckets by age from NZB seconds', () => {
    assert.equal(ageBucket(postedDaysAgo(0.5), now), '<1d');
    assert.equal(ageBucket(postedDaysAgo(1), now), '1-7d');
    assert.equal(ageBucket(postedDaysAgo(6.9), now), '1-7d');
    assert.equal(ageBucket(postedDaysAgo(29), now), '7-30d');
    assert.equal(ageBucket(postedDaysAgo(100), now), '30-180d');
    assert.equal(ageBucket(postedDaysAgo(200), now), '180d-1y');
    assert.equal(ageBucket(postedDaysAgo(800), now), '1-3y');
    assert.equal(ageBucket(postedDaysAgo(4000), now), '3y+');
  });

  it('treats a missing date as unknown and a future one as new', () => {
    assert.equal(ageBucket(undefined, now), 'unknown');
    assert.equal(ageBucket(0, now), 'unknown');
    assert.equal(ageBucket(postedDaysAgo(-1), now), '<1d');
  });
});

describe('ageDelta', () => {
  it('splits missing-article failures and blocklist refusals out', () => {
    const missing = ageDelta(
      {
        indexer: 'A',
        postedAtSec: postedDaysAgo(400),
        outcome: 'failed',
        errorCode: 'missing_on_providers',
      },
      now
    );
    assert.deepEqual(missing, {
      indexer: 'A',
      ageBucket: '1-3y',
      ok: 0,
      degraded: 0,
      failed: 1,
      failedMissing: 1,
      blocklisted: 0,
    });
    const refused = ageDelta(
      { indexer: 'A', postedAtSec: undefined, outcome: 'blocklisted' },
      now
    );
    assert.equal(refused.blocklisted, 1);
    assert.equal(refused.failed, 0);
    assert.equal(refused.ageBucket, 'unknown');
  });
});

describe('ageCells', () => {
  it('returns every bucket in order, summing rows', () => {
    const cells = ageCells([
      {
        indexer: 'A',
        ageBucket: '1-7d',
        ok: 2,
        degraded: 0,
        failed: 1,
        failedMissing: 1,
        blocklisted: 0,
      },
      {
        indexer: 'B',
        ageBucket: '1-7d',
        ok: 1,
        degraded: 1,
        failed: 0,
        failedMissing: 0,
        blocklisted: 2,
      },
    ]);
    assert.deepEqual(
      cells.map((c) => c.ageBucket),
      AGE_BUCKETS
    );
    const week = cells.find((c) => c.ageBucket === '1-7d')!;
    assert.deepEqual(
      [week.ok, week.degraded, week.failed, week.blocklisted],
      [3, 1, 1, 2]
    );
  });

  it('keeps rows from an unrecognised bucket after the known ones', () => {
    const cells = ageCells([
      {
        indexer: 'A',
        ageBucket: '1-2y',
        ok: 4,
        degraded: 0,
        failed: 1,
        failedMissing: 0,
        blocklisted: 0,
      },
    ]);
    assert.equal(cells.length, AGE_BUCKETS.length + 1);
    assert.deepEqual(cells[cells.length - 1], {
      ageBucket: '1-2y',
      ok: 4,
      degraded: 0,
      failed: 1,
      failedMissing: 0,
      blocklisted: 0,
    });
  });
});

describe('UsenetIndexerMetricsRepository age', () => {
  const dir = path.join(
    process.cwd(),
    '.test-tmp',
    `age-${process.pid}-${Date.now()}`
  );

  before(async () => {
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.relative(process.cwd(), dir).split(path.sep).join('/');
    await initDb(`sqlite://./${rel}/db.sqlite`);
  });

  after(async () => {
    await closeDb();
    // Only this suite's folder: other files may still hold theirs open.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accumulates per bucket, previews, prunes and resets', async () => {
    const hour = 3_600_000;
    const t = Date.now();
    const d = { indexer: 'A', ageBucket: '<1d', ok: 1 };
    await UsenetIndexerMetricsRepository.recordAge(d, t);
    await UsenetIndexerMetricsRepository.recordAge(
      { ...d, ok: 0, failed: 1, failedMissing: 1 },
      t
    );
    await UsenetIndexerMetricsRepository.recordAge(d, t - 48 * hour);

    const recent = await UsenetIndexerMetricsRepository.ageByIndexer(
      t - 24 * hour
    );
    assert.deepEqual(recent, [
      {
        indexer: 'A',
        ageBucket: '<1d',
        ok: 1,
        degraded: 0,
        failed: 1,
        failedMissing: 1,
        blocklisted: 0,
      },
    ]);
    assert.equal(
      (await UsenetIndexerMetricsRepository.sumScope({ indexer: 'A' })).ageRows,
      2
    );

    await UsenetIndexerMetricsRepository.pruneOlderThan(t - 24 * hour);
    assert.equal(
      (await UsenetIndexerMetricsRepository.ageByIndexer(0))[0].ok,
      1
    );

    await UsenetIndexerMetricsRepository.deleteScope({ indexer: 'A' });
    assert.deepEqual(await UsenetIndexerMetricsRepository.ageByIndexer(0), []);
  });

  it('counts a remote-only refusal once and skips local verdicts', async () => {
    const remote = `nh1:${'a'.repeat(40)}`;
    const local = `nh1:${'b'.repeat(40)}`;
    await ReleaseBlocklistRepository.markVerdict(local, 'dead');
    const o = { indexer: 'R', postedAtSec: postedDaysAgo(400) };

    assert.equal(await recordBlocklistRefusal(remote, o), true);
    assert.equal(await recordBlocklistRefusal(remote, o), false);
    // This instance's own verdict: its failed grab was already counted.
    assert.equal(await recordBlocklistRefusal(local, o), false);
  });
});
