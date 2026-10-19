import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Use the normal core entry point to initialise the dependency graph.
import '../index.js';
import { closeDb, initDb } from '../db/db.js';
import { PlaybackMetricsRepository } from '../db/index.js';
import {
  PlaybackDeduper,
  latencyBucket,
  playbackDelta,
  playbackResult,
  type PlaybackOutcome,
} from './playback-metrics.js';
import {
  quantileBucket,
  summarisePlayback,
} from '../usenet/integration/dashboard/playback-summary.js';

const outcome = (o: Partial<PlaybackOutcome>): PlaybackOutcome => ({
  kind: 'usenet',
  attempts: [{ rank: 0, serviceId: 'builtin' }],
  outcomes: ['ok'],
  winnerIndex: 0,
  resolved: true,
  errored: false,
  ms: 1_500,
  abandoned: false,
  ...o,
});

describe('latencyBucket', () => {
  it('places durations at the bucket edges', () => {
    assert.equal(latencyBucket(0), '<2s');
    assert.equal(latencyBucket(1_999), '<2s');
    assert.equal(latencyBucket(2_000), '2-5s');
    assert.equal(latencyBucket(9_999), '5-10s');
    assert.equal(latencyBucket(10_000), '10-30s');
    assert.equal(latencyBucket(30_000), '30s+');
  });
});

describe('playbackResult', () => {
  it('lets a hang-up override the chain result', () => {
    assert.equal(
      playbackResult({ resolved: true, errored: false, abandoned: true }),
      'abandoned'
    );
    assert.equal(
      playbackResult({ resolved: false, errored: true, abandoned: false }),
      'error'
    );
    assert.equal(
      playbackResult({ resolved: false, errored: false, abandoned: false }),
      'downloading'
    );
  });
});

describe('playbackDelta', () => {
  it('records a clicked-item win at rank 0, not as a same-release win', () => {
    const d = playbackDelta(outcome({}));
    assert.equal(d.rankBucket, '0');
    assert.equal(d.sameReleaseWins, 0);
    assert.equal(d.service, 'builtin');
    assert.equal(d.attemptsLaunched, 1);
  });

  it('uses the winner rank for depth, flagging same-release copies', () => {
    const d = playbackDelta(
      outcome({
        attempts: [
          { rank: 0, serviceId: 'nzbdav' },
          { rank: 0, serviceId: 'nzbdav' },
          { rank: 1, serviceId: 'nzbdav' },
        ],
        outcomes: ['failed', 'ok', 'not_run'],
        winnerIndex: 1,
      })
    );
    assert.equal(d.rankBucket, '0');
    assert.equal(d.sameReleaseWins, 1);
    assert.equal(d.attemptsLaunched, 2);
    assert.equal(d.failedAttempts, 1);
  });

  it('caps deep ranks and counts wasted attempts by kind', () => {
    const d = playbackDelta(
      outcome({
        attempts: [0, 1, 2, 3, 4].map((rank) => ({ rank })),
        outcomes: ['failed', 'unavailable', 'aborted', 'failed', 'ok'],
        winnerIndex: 4,
        ms: 45_000,
      })
    );
    assert.equal(d.rankBucket, '3+');
    assert.equal(d.service, 'unknown');
    assert.equal(d.latencyBucket, '30s+');
    assert.deepEqual(
      [d.failedAttempts, d.unavailableAttempts, d.abortedAttempts],
      [2, 1, 1]
    );
  });

  it('has no rank when nothing won', () => {
    const d = playbackDelta(
      outcome({
        outcomes: ['failed'],
        winnerIndex: undefined,
        resolved: false,
        errored: true,
      })
    );
    assert.equal(d.rankBucket, '-');
    assert.equal(d.result, 'error');
  });
});

describe('PlaybackDeduper', () => {
  it('drops repeats of an answered click inside the window', async () => {
    const dd = new PlaybackDeduper(undefined, 60_000);
    assert.equal(await dd.admit('k', 'ok', 0), true);
    assert.equal(await dd.admit('k', 'ok', 30_000), false);
    assert.equal(await dd.admit('k', 'ok', 61_000), true);
    assert.equal(await dd.admit('other', 'ok', 61_000), true);
  });

  it('lets a retry after an error or a hang-up through', async () => {
    const dd = new PlaybackDeduper(undefined, 60_000);
    assert.equal(await dd.admit('k', 'error', 0), true);
    assert.equal(await dd.admit('k', 'abandoned', 1_000), true);
    assert.equal(await dd.admit('k', 'ok', 2_000), true);
    assert.equal(await dd.admit('k', 'ok', 3_000), false);
  });

  it('catches a retry that lands on another replica via the shared store', async () => {
    const shared = new Map<string, { result: 'ok'; atMs: number }>();
    const store = {
      get: async (k: string) => shared.get(k),
      set: async (k: string, v: { result: 'ok'; atMs: number }) => {
        shared.set(k, v);
      },
    };
    const replicaA = new PlaybackDeduper(store, 60_000);
    const replicaB = new PlaybackDeduper(store, 60_000);
    assert.equal(await replicaA.admit('k', 'ok', 0), true);
    assert.equal(await replicaB.admit('k', 'ok', 5_000), false);
  });
});

describe('quantileBucket', () => {
  it('names the bucket holding the quantile', () => {
    const hist = [
      { bucket: '<2s', plays: 5 },
      { bucket: '2-5s', plays: 3 },
      { bucket: '5-10s', plays: 0 },
      { bucket: '10-30s', plays: 2 },
    ];
    assert.equal(quantileBucket(hist, 0.5), '<2s');
    assert.equal(quantileBucket(hist, 0.8), '2-5s');
    assert.equal(quantileBucket(hist, 0.9), '10-30s');
    assert.equal(quantileBucket([{ bucket: '<2s', plays: 0 }], 0.5), null);
  });
});

describe('summarisePlayback', () => {
  it('summarises one kind, timing only the plays that played', () => {
    const rows = [
      playbackDelta(outcome({ ms: 1_000 })),
      playbackDelta(outcome({ ms: 12_000 })),
      playbackDelta(
        outcome({
          attempts: [{ rank: 0 }, { rank: 1 }],
          outcomes: ['failed', 'ok'],
          winnerIndex: 1,
          ms: 3_000,
        })
      ),
      playbackDelta(outcome({ resolved: false, ms: 50 })),
      playbackDelta(outcome({ kind: 'debrid' })),
    ];
    const s = summarisePlayback(rows, 'usenet');
    assert.equal(s.plays, 4);
    assert.equal(s.ok, 3);
    assert.equal(s.downloading, 1);
    assert.equal(s.avgMs, Math.round((1_000 + 12_000 + 3_000) / 3));
    assert.equal(s.slowShare, 1 / 3);
    assert.equal(s.rescuedOtherRelease, 1);
    assert.equal(s.rescuedSameRelease, 0);
    // One failed attempt over four plays, not over the three that played.
    assert.equal(s.wastedPerPlay, 1 / 4);
    assert.equal(s.p50Bucket, '2-5s');
  });
});

describe('PlaybackMetricsRepository', () => {
  const dir = path.join(
    process.cwd(),
    '.test-tmp',
    `playback-${process.pid}-${Date.now()}`
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

  it('accumulates plays per key, previews, prunes and resets', async () => {
    const hour = 3_600_000;
    const now = Date.now();
    const d = playbackDelta(outcome({ ms: 1_000 }));
    await PlaybackMetricsRepository.record(d, now);
    await PlaybackMetricsRepository.record(d, now);
    await PlaybackMetricsRepository.record(d, now - 48 * hour);

    const recent = await PlaybackMetricsRepository.summarySince(
      now - 24 * hour
    );
    assert.equal(recent.length, 1);
    assert.equal(recent[0].plays, 2);
    assert.equal(recent[0].sumMs, 2_000);

    assert.deepEqual(await PlaybackMetricsRepository.sumScope({}), {
      rows: 2,
      plays: 3,
    });

    await PlaybackMetricsRepository.pruneOlderThan(now - 24 * hour);
    assert.equal((await PlaybackMetricsRepository.sumScope({})).rows, 1);

    await PlaybackMetricsRepository.deleteScope({});
    assert.deepEqual(await PlaybackMetricsRepository.summarySince(0), []);
  });
});
