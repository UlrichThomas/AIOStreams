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
  /** An answer at `nowMs` whose request took `ms`. */
  const answer = (o: Partial<PlaybackOutcome>, nowMs: number) => {
    const out = outcome(o);
    return { startMs: nowMs - out.ms, delta: playbackDelta(out) };
  };
  const ok = (nowMs: number, ms = 1_500) => answer({ ms }, nowMs);
  const downloading = (nowMs: number, ms = 60_000) =>
    answer({ resolved: false, ms }, nowMs);
  const abandoned = (nowMs: number, ms = 20_000) =>
    answer({ abandoned: true, ms }, nowMs);
  const error = (nowMs: number) =>
    answer({ resolved: false, errored: true, winnerIndex: undefined }, nowMs);
  /** Net plays and summed ms per result, as the hourly rows would hold. */
  const net = (writes: { delta: ReturnType<typeof playbackDelta> }[]) => {
    const m = new Map<string, { plays: number; sumMs: number }>();
    for (const { delta: d } of writes) {
      const c = m.get(d.result) ?? { plays: 0, sumMs: 0 };
      c.plays += d.plays;
      c.sumMs += d.sumMs;
      m.set(d.result, c);
    }
    return Object.fromEntries([...m].filter(([, c]) => c.plays !== 0));
  };

  it('drops repeats of an answered click inside the window', async () => {
    const dd = new PlaybackDeduper(undefined, 60_000);
    assert.equal((await dd.admit('k', ok(0), 0)).length, 1);
    assert.equal((await dd.admit('k', ok(30_000), 30_000)).length, 0);
    assert.equal((await dd.admit('k', ok(61_000), 61_000)).length, 1);
    assert.equal((await dd.admit('other', ok(61_000), 61_000)).length, 1);
  });

  it('defaults to a window long enough to cover a re-request mid-film', async () => {
    const dd = new PlaybackDeduper();
    assert.equal((await dd.admit('k', ok(0), 0)).length, 1);
    const later = 90 * 60_000;
    assert.equal((await dd.admit('k', ok(later), later)).length, 0);
  });

  it('replaces a downloading answer with the play its retry got', async () => {
    const dd = new PlaybackDeduper(undefined, 600_000);
    const writes = [
      ...(await dd.admit('k', downloading(60_000), 60_000)),
      // The player retries at once and the warm resolve answers in 1s.
      ...(await dd.admit('k', ok(62_000, 1_000), 62_000)),
    ];
    // One play, timed from the first request rather than the warm retry.
    assert.deepEqual(net(writes), { ok: { plays: 1, sumMs: 62_000 } });
    assert.equal(writes.at(-1)!.delta.latencyBucket, '30s+');
    // Repeat downloading answers before it played add nothing.
    const dd2 = new PlaybackDeduper(undefined, 600_000);
    await dd2.admit('k', downloading(60_000), 60_000);
    assert.equal((await dd2.admit('k', downloading(70_000), 70_000)).length, 0);
  });

  it('times a re-click well after a downloading answer on its own', async () => {
    const dd = new PlaybackDeduper(undefined, 3_600_000);
    const writes = [
      ...(await dd.admit('k', downloading(60_000), 60_000)),
      ...(await dd.admit('k', ok(600_000, 2_500), 600_000)),
    ];
    assert.deepEqual(net(writes), { ok: { plays: 1, sumMs: 2_500 } });
  });

  it('counts a hung-up request and a retry sharing its chain once', async () => {
    // The original request started at 0 and hung up; the retry started at
    // 20s; both got the chain's answer at 30s. Either may record first.
    for (const order of ['abandoned-first', 'ok-first'] as const) {
      const dd = new PlaybackDeduper(undefined, 600_000);
      const a = abandoned(30_000, 30_000);
      const b = ok(30_000, 10_000);
      const writes =
        order === 'abandoned-first'
          ? [
              ...(await dd.admit('k', a, 30_000)),
              ...(await dd.admit('k', b, 30_000)),
            ]
          : [
              ...(await dd.admit('k', b, 30_000)),
              ...(await dd.admit('k', a, 30_000)),
            ];
      const plays = Object.values(net(writes)).reduce((s, c) => s + c.plays, 0);
      assert.equal(plays, 1, order);
      assert.equal(net(writes).ok?.plays, 1, order);
    }
  });

  it('lets a retry after an error through as a second wait', async () => {
    const dd = new PlaybackDeduper(undefined, 60_000);
    const writes = [
      ...(await dd.admit('k', error(0), 0)),
      ...(await dd.admit('k', ok(2_000), 2_000)),
    ];
    assert.deepEqual(Object.keys(net(writes)).sort(), ['error', 'ok']);
    assert.equal((await dd.admit('k', ok(3_000), 3_000)).length, 0);
  });

  it('catches a retry that lands on another replica via the shared store', async () => {
    const shared = new Map<string, any>();
    const store = {
      get: async (k: string) => shared.get(k),
      set: async (k: string, v: any) => {
        shared.set(k, v);
      },
    };
    const replicaA = new PlaybackDeduper(store, 60_000);
    const replicaB = new PlaybackDeduper(store, 60_000);
    assert.equal((await replicaA.admit('k', ok(0), 0)).length, 1);
    assert.equal((await replicaB.admit('k', ok(5_000), 5_000)).length, 0);
    // A downloading answer on A is replaced by B's play.
    const writes = [
      ...(await replicaA.admit('d', downloading(0), 0)),
      ...(await replicaB.admit('d', ok(5_000), 5_000)),
    ];
    assert.deepEqual(net(writes), { ok: { plays: 1, sumMs: 65_000 } });
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
