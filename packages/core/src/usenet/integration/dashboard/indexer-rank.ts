import type {
  UsenetIndexerHeadToHeadRow,
  UsenetIndexerRollup,
} from '../../../db/index.js';

/** Fewer attributable grabs than this and an indexer gets no rank. */
export const MIN_RANK_GRABS = 10;
/** Net same-release rescues needed for head-to-head to reorder two indexers. */
export const MIN_HEAD_TO_HEAD_NET = 3;
/** Weight of the uniqueness bonus next to the grab-success bound (0–1). */
const UNIQUE_WEIGHT = 0.1;
const Z = 1.96;

/** Wilson score interval for `successes` out of `n` at 95% confidence. */
export function wilsonInterval(
  successes: number,
  n: number
): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
  };
}

export interface IndexerRankInput {
  /** Grabs the indexer is accountable for: auth and 429 fetch failures excluded. */
  attributableGrabs: number;
  /** ok + degraded. */
  successes: number;
  lower: number;
  upper: number;
  /** null below {@link MIN_RANK_GRABS}. */
  score: number | null;
}

/**
 * Confidence-aware preference score for one indexer: the Wilson lower bound
 * of its grab success, plus a small bonus for releases no other indexer had.
 * Auth (401/403) and rate-limit (429) fetch failures are left out because they
 * reflect the account, not what the indexer indexes; missing-article failures
 * stay in.
 */
export function indexerRankInput(agg: UsenetIndexerRollup): IndexerRankInput {
  const successes = agg.ok + agg.degraded;
  const attributableGrabs = Math.max(
    successes,
    agg.grabs - agg.fetchAuth - agg.fetchLimited
  );
  const { lower, upper } = wilsonInterval(successes, attributableGrabs);
  const uniqueRate =
    agg.uniqReleases > 0 ? agg.uniqUnique / agg.uniqReleases : 0;
  const score =
    attributableGrabs < MIN_RANK_GRABS
      ? null
      : Math.round((lower + UNIQUE_WEIGHT * uniqueRate) * 1000) / 1000;
  return { attributableGrabs, successes, lower, upper, score };
}

/** Rescues of `b` by `a` minus rescues of `a` by `b`. */
function netRescues(
  rescues: ReadonlyMap<string, number>,
  a: string,
  b: string
): number {
  return (rescues.get(`${a}\0${b}`) ?? 0) - (rescues.get(`${b}\0${a}`) ?? 0);
}

/**
 * Suggested order (1 = most preferred) for the indexers that have a score.
 * Sorted by score; then neighbours whose success intervals overlap swap when
 * the lower one has rescued the higher one at least
 * {@link MIN_HEAD_TO_HEAD_NET} more times than the reverse, since head-to-head
 * on the same release is the more direct evidence when the rates can't tell
 * them apart.
 */
export function suggestedRanks(
  inputs: ReadonlyMap<string, IndexerRankInput>,
  headToHead: readonly UsenetIndexerHeadToHeadRow[]
): Map<string, number> {
  const rescues = new Map<string, number>();
  for (const r of headToHead) {
    const key = `${r.winner}\0${r.loser}`;
    rescues.set(key, (rescues.get(key) ?? 0) + r.rescues);
  }
  const order = [...inputs]
    .filter(([, i]) => i.score !== null)
    .sort(([an, a], [bn, b]) => b.score! - a.score! || (an < bn ? -1 : 1))
    .map(([name]) => name);

  // Adjacent swaps only, bounded passes: a stable nudge, never a re-sort.
  for (let pass = 0; pass < order.length; pass++) {
    let swapped = false;
    for (let i = 0; i + 1 < order.length; i++) {
      const hi = inputs.get(order[i])!;
      const lo = inputs.get(order[i + 1])!;
      const overlap = lo.upper >= hi.lower;
      if (
        overlap &&
        netRescues(rescues, order[i + 1], order[i]) >= MIN_HEAD_TO_HEAD_NET
      ) {
        [order[i], order[i + 1]] = [order[i + 1], order[i]];
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return new Map(order.map((name, i) => [name, i + 1]));
}
