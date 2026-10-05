import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the dependency graph.
import '../index.js';
import { runPlayChain, type FailoverAttempt } from './failover.js';

const ok =
  (url: string, delayMs = 0): FailoverAttempt['resolve'] =>
  () =>
    new Promise((resolve) => setTimeout(() => resolve(url), delayMs));
const fail =
  (code?: string, delayMs = 0): FailoverAttempt['resolve'] =>
  () =>
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Object.assign(new Error('boom'), { code })),
        delayMs
      )
    );
/** Never settles on its own; rejects once aborted. */
const hang: FailoverAttempt['resolve'] = (signal) =>
  new Promise((_, reject) =>
    signal?.addEventListener('abort', () => reject(new Error('aborted')))
  );

const cfg = {
  staggerMs: 0,
  preferredGraceMs: 0,
  maxWaitMs: 5_000,
};

describe('runPlayChain outcomes', () => {
  it('sequential: marks the failed attempt and the winner', async () => {
    const r = await runPlayChain(
      [
        { resolve: fail(), rank: 0 },
        { resolve: ok('u1'), rank: 0 },
        { resolve: ok('u2'), rank: 1 },
      ],
      { ...cfg, parallel: 1 }
    );
    assert.equal(r.url, 'u1');
    assert.equal(r.winnerIndex, 1);
    assert.deepEqual(r.outcomes, ['failed', 'ok', 'not_run']);
  });

  it('sequential: a terminal error is not a source failure', async () => {
    const r = await runPlayChain(
      [
        { resolve: fail('UNAUTHORIZED'), rank: 0 },
        { resolve: ok('u1'), rank: 0 },
      ],
      { ...cfg, parallel: 1 }
    );
    assert.equal(r.winnerIndex, undefined);
    assert.deepEqual(r.outcomes, ['error', 'not_run']);
  });

  it('parallel: attempts still in flight when another wins are aborted', async () => {
    const r = await runPlayChain(
      [
        { resolve: fail(undefined, 5), rank: 0 },
        { resolve: ok('u1', 20), rank: 0 },
        { resolve: hang, rank: 0 },
      ],
      { ...cfg, parallel: 3 }
    );
    assert.equal(r.url, 'u1');
    assert.equal(r.winnerIndex, 1);
    assert.deepEqual(r.outcomes, ['failed', 'ok', 'aborted']);
  });
});
