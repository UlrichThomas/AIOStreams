import {
  UsenetIndexerMetricsRepository,
  type UsenetIndexerAgeDelta,
} from '../../db/index.js';
import { ReleaseBlocklistRepository } from '../../db/repositories/release-blocklist.js';
import { createLogger } from '../../logging/logger.js';
import { Cache } from '../../utils/cache.js';
import { requestLockType } from '../../utils/distributed-lock.js';
import { isMissingCode } from './grab-metrics.js';

const logger = createLogger('usenet/age-metrics');

/** How long one post's blocklist refusal suppresses counting it again. */
const REFUSAL_DEDUPE_TTL_S = 7 * 86_400;

/** Posts whose refusal was already counted; shared across replicas on Redis. */
const countedRefusals = () =>
  Cache.getInstance<string, true>(
    'usenet-age:blocklist-refusal',
    10_000,
    requestLockType()
  );

const DAY_MS = 86_400_000;

/** Upper bounds (exclusive) of the post-age buckets, in order. */
const AGE_BOUNDS: readonly [number, string][] = [
  [DAY_MS, '<1d'],
  [7 * DAY_MS, '1-7d'],
  [30 * DAY_MS, '7-30d'],
  [180 * DAY_MS, '30-180d'],
  [365 * DAY_MS, '180d-1y'],
  [3 * 365 * DAY_MS, '1-3y'],
];
const AGE_OPEN_BUCKET = '3y+';
export const UNKNOWN_AGE = 'unknown';

/** Every age bucket, youngest first, unknown last. */
export const AGE_BUCKETS: readonly string[] = [
  ...AGE_BOUNDS.map(([, label]) => label),
  AGE_OPEN_BUCKET,
  UNKNOWN_AGE,
];

/**
 * Pure: the age bucket of a post. `postedAtSec` is the NZB's `date`, in Unix
 * epoch **seconds**. A post dated in the future (clock skew) counts as new.
 */
export function ageBucket(
  postedAtSec: number | undefined,
  nowMs: number
): string {
  if (!postedAtSec || postedAtSec <= 0) return UNKNOWN_AGE;
  const age = Math.max(0, nowMs - postedAtSec * 1000);
  for (const [bound, label] of AGE_BOUNDS) if (age < bound) return label;
  return AGE_OPEN_BUCKET;
}

export interface AgeOutcome {
  /** Indexer label, as the grab rollups use it. */
  indexer: string;
  postedAtSec: number | undefined;
  outcome: 'ok' | 'degraded' | 'failed' | 'blocklisted';
  /** Grab failure code, for telling missing articles apart. */
  errorCode?: string;
}

/** Pure: the hourly-row delta for one playback grab. */
export function ageDelta(o: AgeOutcome, nowMs: number): UsenetIndexerAgeDelta {
  const failed = o.outcome === 'failed' ? 1 : 0;
  return {
    indexer: o.indexer,
    ageBucket: ageBucket(o.postedAtSec, nowMs),
    ok: o.outcome === 'ok' ? 1 : 0,
    degraded: o.outcome === 'degraded' ? 1 : 0,
    failed,
    failedMissing: failed && isMissingCode(o.errorCode) ? 1 : 0,
    blocklisted: o.outcome === 'blocklisted' ? 1 : 0,
  };
}

/**
 * Record one playback grab by its post age. Callers pass playback grabs only:
 * arr and manual imports of back catalogue would skew the older buckets.
 * Fire-and-forget: never lets metrics affect the grab.
 */
export function recordAgeOutcome(o: AgeOutcome): void {
  try {
    const atMs = Date.now();
    UsenetIndexerMetricsRepository.recordAge(ageDelta(o, atMs), atMs).catch(
      (err) =>
        logger.warn(
          { err, indexer: o.indexer },
          'failed to record grab outcome by age'
        )
    );
  } catch (err) {
    logger.warn({ err }, 'failed to compute grab outcome by age');
  }
}

/**
 * Count a playback grab the blocklist refused before import, at most once
 * per post per {@link REFUSAL_DEDUPE_TTL_S}: every later click on the same
 * dead post would otherwise count it again. A post this instance blocklisted
 * itself is skipped, because the failed grab that blocklisted it was already
 * counted as `failed` (the same holds for aiostreams.ts's release-key check,
 * which only honours local verdicts and so records nothing). Only verdicts
 * from remote sources add posts the age stats would otherwise never see.
 * Never rejects; resolves to whether the refusal was counted, so callers can
 * fire and forget it.
 */
export async function recordBlocklistRefusal(
  contentKey: string,
  o: Omit<AgeOutcome, 'outcome' | 'errorCode'>
): Promise<boolean> {
  try {
    // Unknown counts as local: skipping is the safe side of a double count.
    if (
      await ReleaseBlocklistRepository.isLocallyBlocked(contentKey).catch(
        () => true
      )
    )
      return false;
    const counted = countedRefusals();
    if (await counted.get(contentKey)) return false;
    await counted.set(contentKey, true, REFUSAL_DEDUPE_TTL_S);
    recordAgeOutcome({ ...o, outcome: 'blocklisted' });
    return true;
  } catch (err) {
    logger.warn({ err }, 'failed to record blocklist refusal by age');
    return false;
  }
}
