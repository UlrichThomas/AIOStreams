import {
  UsenetIndexerMetricsRepository,
  type UsenetIndexerDelta,
} from '../../db/index.js';
import type { Addon, ParsedStream } from '../../db/schemas.js';
import { createLogger } from '../../logging/logger.js';
import { normaliseReleaseName } from '../../parser/title.js';
import { PresetManager } from '../../presets/index.js';
import { constants } from '../../utils/index.js';
import { DSU } from '../../utils/dsu.js';
import { indexerLabelFor } from './grab-metrics.js';

const logger = createLogger('usenet/uniqueness-metrics');

const USENET_TYPES: readonly string[] = [
  constants.USENET_STREAM_TYPE,
  constants.STREMIO_USENET_STREAM_TYPE,
];

const usenetCapableByPreset = new Map<string, boolean>();

/**
 * Pure: whether a preset declaring these stream types could return usenet
 * results. Declaring nothing (custom, nested AIOStreams) means it might
 * return anything.
 */
export function declaresUsenet(declared: readonly string[]): boolean {
  return (
    declared.length === 0 || declared.some((t) => USENET_TYPES.includes(t))
  );
}

/**
 * Whether an addon could have contributed usenet results, from its preset's
 * declared stream types. A failure in any other addon cannot hide a usenet
 * release, so it need not keep the request out of the uniqueness metrics.
 * A preset that cannot be resolved counts as capable.
 */
export function mayReturnUsenet(addon: Addon): boolean {
  const type = addon.preset.type;
  const cached = usenetCapableByPreset.get(type);
  if (cached !== undefined) return cached;
  try {
    const capable = declaresUsenet(
      PresetManager.fromId(type).METADATA.SUPPORTED_STREAM_TYPES
    );
    usenetCapableByPreset.set(type, capable);
    return capable;
  } catch {
    // Not cached: the lookup may succeed later (e.g. config not yet loaded).
    return true;
  }
}

/**
 * Usenet streams that name the indexer that found them. Library NZBs are out:
 * they carry the service id as their "indexer", not a real one.
 */
function isIndexerResult(s: ParsedStream): boolean {
  return (
    (s.type === 'usenet' || s.type === 'stremio-usenet') &&
    !!s.indexer?.trim() &&
    !s.library
  );
}

/**
 * Pure: per-indexer uniqueness for one stream request's raw results.
 *
 * Streams are the same release when they share a `releaseKey` (size + poster +
 * day fingerprint) or a normalised release name; either link is enough, so an
 * indexer without poster data still matches one with it. Size is left out of
 * the name key because indexers disagree on it, so reposts and re-uploads under
 * the same name count as one release: "unique" means a name (or fingerprint)
 * no other indexer had, not a distinct upload.
 *
 * Uniqueness is relative to the sources this request actually searched
 * (addons skipped by media type or a group condition are not competitors).
 * Only meaningful when every usenet source searched answered in full; the
 * caller skips degraded requests (see `StreamFetcher.fetch`).
 */
export function uniquenessDeltas(
  streams: readonly ParsedStream[]
): UsenetIndexerDelta[] {
  const dsu = new DSU<string>();
  const keysByStream: { indexer: string; node: string }[] = [];

  streams.filter(isIndexerResult).forEach((s, i) => {
    const node = `s:${i}`;
    dsu.makeSet(node);
    const rawName = s.filename ?? s.folderName;
    // A name that normalises to nothing would link every such stream.
    const name = rawName ? normaliseReleaseName(rawName) : '';
    const keys = [
      s.releaseKey ? `rk:${s.releaseKey}` : undefined,
      name ? `name:${name}` : undefined,
      s.nzbUrl ? `nzb:${s.nzbUrl}` : undefined,
    ];
    for (const key of keys) if (key) dsu.union(node, key);
    keysByStream.push({ indexer: indexerLabelFor(s.indexer), node });
  });
  if (keysByStream.length === 0) return [];

  const releasesByIndexer = new Map<string, Set<string>>();
  const indexersByRelease = new Map<string, Set<string>>();
  for (const { indexer, node } of keysByStream) {
    const release = dsu.find(node);
    let releases = releasesByIndexer.get(indexer);
    if (!releases) releasesByIndexer.set(indexer, (releases = new Set()));
    releases.add(release);
    let indexers = indexersByRelease.get(release);
    if (!indexers) indexersByRelease.set(release, (indexers = new Set()));
    indexers.add(indexer);
  }

  const sole = releasesByIndexer.size === 1;
  return [...releasesByIndexer].map(([indexer, releases]) => {
    let unique = 0;
    for (const r of releases)
      if (indexersByRelease.get(r)!.size === 1) unique++;
    return {
      indexer,
      uniqRequests: 1,
      uniqReleases: releases.size,
      uniqUnique: unique,
      uniqSole: sole ? 1 : 0,
    };
  });
}

/** Fire-and-forget: never lets metrics affect the stream request. */
export function recordUniqueness(streams: readonly ParsedStream[]): void {
  try {
    const atMs = Date.now();
    for (const d of uniquenessDeltas(streams)) {
      UsenetIndexerMetricsRepository.record(d, atMs).catch((err) =>
        logger.warn(
          { err, indexer: d.indexer },
          'Failed to record uniqueness outcome'
        )
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to compute indexer uniqueness');
  }
}
