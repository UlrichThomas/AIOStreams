import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../../utils/index.js';
import type { Cache } from '../../utils/cache.js';
import { ageInHoursSince, searchWithBackgroundRefresh } from './general.js';
import { createLogger } from '../../logging/logger.js';

describe('ageInHoursSince', () => {
  it('rounds up to the next full hour', () => {
    const date = new Date(Date.now() - 47.5 * 60 * 60 * 1000).toISOString();
    assert.equal(ageInHoursSince(date), 48);
  });

  it('returns undefined for an unparsable date', () => {
    assert.equal(ageInHoursSince('not-a-date'), undefined);
  });

  it('returns undefined for a date in the future', () => {
    const date = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    assert.equal(ageInHoursSince(date), undefined);
  });
});

describe('searchWithBackgroundRefresh', () => {
  it('returns a fresh result before finalise settles, then caches it', async () => {
    // The real Cache needs the runtime config; only get/set are used here.
    const store = new Map<string, { n: number; done: boolean }>();
    const cache = {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: { n: number; done: boolean }) => {
        store.set(k, v);
      },
    } as unknown as Cache<string, { n: number; done: boolean }>;
    const key = 'k';
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const result = await searchWithBackgroundRefresh({
      searchCache: cache,
      searchCacheKey: key,
      bgCacheKey: `bg:${key}`,
      cacheTTL: 60,
      fetchFn: async () => ({ n: 1, done: false }),
      isEmptyResult: () => false,
      finalise: async (r) => {
        await gate;
        return { ...r, done: true };
      },
      logger: createLogger('test'),
    });
    assert.deepEqual(result, { n: 1, done: false });
    assert.equal(await cache.get(key), undefined);
    release();
    for (let i = 0; i < 50 && (await cache.get(key)) === undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(await cache.get(key), { n: 1, done: true });
  });
});
