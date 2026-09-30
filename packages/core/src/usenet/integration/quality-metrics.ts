import {
  UsenetIndexerMetricsRepository,
  type UsenetIndexerQualityDelta,
} from '../../db/index.js';
import type { ParsedStream } from '../../db/schemas.js';
import { createLogger } from '../../logging/logger.js';
import { constants } from '../../utils/index.js';
import { groupReleases } from './uniqueness-metrics.js';

const logger = createLogger('usenet/quality-metrics');

const UNKNOWN = 'Unknown';
const RESOLUTIONS: ReadonlySet<string> = new Set(constants.RESOLUTIONS);
const QUALITIES: ReadonlySet<string> = new Set(constants.QUALITIES);

/** First value among `values` that is a known, non-Unknown member of `known`. */
function firstKnown(
  values: (string | undefined)[],
  known: ReadonlySet<string>
): string {
  return values.find((v) => v && v !== UNKNOWN && known.has(v)) ?? UNKNOWN;
}

/**
 * Pure: per-indexer resolution × quality counts for one stream request's raw
 * results, counting each release (as grouped by `groupReleases`) once per
 * indexer that returned it.
 *
 * A release's bucket comes from that indexer's own copies of it: the first
 * recognised resolution / quality among them, else Unknown. Unlike the
 * uniqueness metrics this needs no competitor, so single-indexer requests
 * count too. Output has one entry per (indexer, resolution, quality).
 */
export function qualityDeltas(
  streams: readonly ParsedStream[]
): UsenetIndexerQualityDelta[] {
  const copies = new Map<
    string,
    { indexer: string; streams: ParsedStream[] }
  >();
  for (const { indexer, release, stream } of groupReleases(streams)) {
    const key = `${indexer}\0${release}`;
    let entry = copies.get(key);
    if (!entry) copies.set(key, (entry = { indexer, streams: [] }));
    entry.streams.push(stream);
  }

  const counts = new Map<string, UsenetIndexerQualityDelta>();
  for (const { indexer, streams: own } of copies.values()) {
    const resolution = firstKnown(
      own.map((s) => s.parsedFile?.resolution),
      RESOLUTIONS
    );
    const quality = firstKnown(
      own.map((s) => s.parsedFile?.quality),
      QUALITIES
    );
    const key = `${indexer}\0${resolution}\0${quality}`;
    const cur = counts.get(key);
    if (cur) cur.releases++;
    else counts.set(key, { indexer, resolution, quality, releases: 1 });
  }
  return [...counts.values()];
}

/** Fire-and-forget: never lets metrics affect the stream request. */
export function recordQuality(streams: readonly ParsedStream[]): void {
  try {
    const deltas = qualityDeltas(streams);
    if (deltas.length === 0) return;
    UsenetIndexerMetricsRepository.recordQuality(deltas).catch((err) =>
      logger.warn({ err }, 'Failed to record indexer quality mix')
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to compute indexer quality mix');
  }
}
