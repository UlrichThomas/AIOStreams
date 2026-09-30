import { settingsStore } from '../../../config/index.js';
import { createLogger } from '../../../logging/logger.js';
import {
  UsenetMetricsRepository,
  UsenetIndexerMetricsRepository,
  type UsenetIndexerRollup,
  type UsenetMetricDelta,
} from '../../../db/index.js';
import {
  ProviderConfig,
  ProviderState,
  PoolInfo,
  LiveTiles,
  LiveStreamInfo,
  CacheStats,
  EngineOptions,
} from '../../index.js';
import { usenetEngineRegistry, getUsenetEngineConfig } from '../engine.js';

export type UsenetStatsWindow = '24h' | '7d' | '30d' | 'all';

const logger = createLogger('usenet/stats');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function configProviders(): ProviderConfig[] {
  return (settingsStore.current.usenet?.providers ?? []) as ProviderConfig[];
}

/** Live connection summary for one provider. */
export interface ProviderLiveInfo {
  state: ProviderState;
  active: number;
  idle: number;
  total: number;
  max: number;
  available: number;
  tripped: boolean;
}

/** A provider row combining config, live pool state, and window aggregates. */
export interface UsenetProviderStatRow {
  id: string;
  name?: string;
  host: string;
  enabled: boolean;
  isBackup: boolean;
  priority: number;
  live: ProviderLiveInfo;
  articles: number;
  bytes: number;
  errors: number;
  missing: number;
  undecodable: number;
  avgLatencyMs: number | null;
  avgArticleMs: number;
  /** bytes / wall-clock busy seconds: the provider's average throughput. */
  avgBytesPerSec: number;
  /** errors / (articles + errors). */
  errorRate: number;
  /** missing / (articles + missing): availability signal. */
  missRate: number;
  /** undecodable / (articles + undecodable): corrupt-copy signal. */
  undecodableRate: number;
  /** articles / total articles across providers in the window. */
  articleShare: number;
  /** Has recorded stats but is no longer configured. */
  removed: boolean;
}

/** Per-indexer grab aggregates over the window (import-time outcomes only). */
export interface UsenetIndexerStatRow {
  indexer: string;
  /** ok + degraded + failed. */
  grabs: number;
  ok: number;
  degraded: number;
  failed: number;
  /** Subset of failed: articles dead on every provider. */
  failedMissing: number;
  /** Subset of failed: the .nzb download from the indexer failed. */
  failedFetch: number;
  /** Subset of failedFetch: HTTP 401/403 (blocked / bad API key). */
  fetchAuth: number;
  /** Subset of failedFetch: HTTP 429 (rate-limited). */
  fetchLimited: number;
  /** (ok + degraded) / grabs. */
  successRate: number;
  /** grabs / total grabs across indexers in the window. */
  grabShare: number;
  /** Mean .nzb download time; null when nothing was sampled. */
  avgGrabMs: number | null;
  /** Mean inspect/import time; null when nothing was sampled. */
  avgImportMs: number | null;
  /** Most recent grab-fetch error, regardless of window. */
  lastError?: { status?: number; message: string; atMs: number };
  searchRequests: number;
  searchFailed: number;
  searchEmpty: number;
  searchAuth: number;
  searchLimited: number;
  searchTimeout: number;
  /** (requests - failed) / requests. */
  searchSuccessRate: number;
  /** Mean upstream search time; null when no requests. */
  avgSearchMs: number | null;
  results: number;
  searchHits: number;
  /** results / searchHits; null when no hits. */
  avgResults: number | null;
  /** results / total results across indexers. */
  resultsShare: number;
  lastSearchError?: { status?: number; message: string; atMs: number };
  /** Stream requests where this indexer returned >= 1 release. */
  uniqRequests: number;
  /** Distinct releases returned (raw, before the user's filters). */
  uniqReleases: number;
  /** Releases no other indexer returned for the same request. */
  uniqUnique: number;
  /** Requests where this was the only indexer with results. */
  uniqSole: number;
  /** uniqUnique / uniqReleases; null when no releases. */
  uniqueRate: number | null;
  /** uniqSole / uniqRequests; null when no requests. */
  soleRate: number | null;
  /** Distinct releases per request by resolution × quality (raw results). */
  qualityMix: UsenetIndexerQualityCell[];
}

export interface UsenetIndexerQualityCell {
  resolution: string;
  quality: string;
  releases: number;
}

export interface UsenetThroughputPoint {
  bucketMs: number;
  articles: number;
  bytes: number;
  errors: number;
  missing: number;
  undecodable: number;
  /** Server response time; null when the bucket holds no samples. */
  avgLatencyMs: number | null;
  /** Aggregate download rate for the bucket: bytes / wall-clock active time. */
  avgBytesPerSec: number;
}

export interface UsenetStatsOverview {
  window: UsenetStatsWindow;
  generatedAt: number;
  bucketMs: number;
  live: LiveTiles;
  pool: PoolInfo;
  cache: CacheStats;
  totals: {
    articles: number;
    bytes: number;
    errors: number;
    missing: number;
    undecodable: number;
    /** Server response time across providers; null when nothing was sampled. */
    avgLatencyMs: number | null;
    /** Mean whole-article fetch time, transfer included (not responsiveness). */
    avgArticleMs: number;
    /** Aggregate download rate over the window: bytes / wall-clock active time. */
    avgBytesPerSec: number;
  };
  providers: UsenetProviderStatRow[];
  indexers: UsenetIndexerStatRow[];
  throughput: UsenetThroughputPoint[];
  firstSeenAt?: number;
}

/**
 * Mean server response time, or null when nothing was sampled.
 */
function avgLatency(sumTtfbMs: number, samples: number): number | null {
  return samples > 0 ? Math.round(sumTtfbMs / samples) : null;
}

function resolveWindow(window: UsenetStatsWindow): {
  sinceMs: number;
  bucketMs: number;
} {
  const now = Date.now();
  switch (window) {
    case '24h':
      return { sinceMs: now - DAY_MS, bucketMs: HOUR_MS };
    case '7d':
      return { sinceMs: now - 7 * DAY_MS, bucketMs: HOUR_MS };
    case '30d':
      return { sinceMs: now - 30 * DAY_MS, bucketMs: DAY_MS };
    case 'all':
    default:
      return { sinceMs: 0, bucketMs: DAY_MS };
  }
}

function emptyIndexerRollup(indexer: string): UsenetIndexerRollup {
  return {
    indexer,
    grabs: 0,
    ok: 0,
    degraded: 0,
    failed: 0,
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
  };
}

function emptyLive(): LiveTiles {
  return {
    activeStreams: 0,
    currentBytesPerSec: 0,
    peakBytesPerSec: 0,
    articlesLastMinute: 0,
    errorsLastMinute: 0,
    bytesLastMinute: 0,
  };
}

function emptyCache(): CacheStats {
  return {
    hits: 0,
    misses: 0,
    hitRate: 0,
    diskBytes: 0,
    diskCount: 0,
    diskHits: 0,
  };
}

/**
 * Drain in-memory per-provider deltas from every warm engine and fold them into
 * the hourly metrics table. Returns the number of provider deltas persisted.
 */
export async function drainUsenetMetrics(): Promise<number> {
  const merged = new Map<string, UsenetMetricDelta>();
  for (const engine of usenetEngineRegistry.all()) {
    for (const d of engine.drainMetrics()) {
      const cur =
        merged.get(d.providerId) ??
        ({
          providerId: d.providerId,
          articles: 0,
          bytes: 0,
          errors: 0,
          missing: 0,
          undecodable: 0,
          sumDurationMs: 0,
          wallClockMs: 0,
          sumTtfbMs: 0,
          ttfbSamples: 0,
        } satisfies UsenetMetricDelta);
      cur.articles += d.articles;
      cur.bytes += d.bytes;
      cur.errors += d.errors;
      cur.missing += d.missing;
      cur.undecodable += d.undecodable;
      cur.sumDurationMs += d.sumDurationMs;
      // Per-provider wall-clock busy time (union of in-flight fetches).
      cur.wallClockMs += d.wallClockMs;
      cur.sumTtfbMs += d.sumTtfbMs;
      cur.ttfbSamples += d.ttfbSamples;
      merged.set(d.providerId, cur);
    }
  }
  const deltas = [...merged.values()];
  if (deltas.length === 0) return 0;
  await UsenetMetricsRepository.addDeltas(deltas);
  return deltas.length;
}

/** Prune rollups older than `retentionDays`. Returns rows removed. */
export async function pruneUsenetMetrics(
  retentionDays: number
): Promise<number> {
  const cutoff = Date.now() - retentionDays * DAY_MS;
  const [providerRows, indexerRows] = await Promise.all([
    UsenetMetricsRepository.pruneOlderThan(cutoff),
    UsenetIndexerMetricsRepository.pruneOlderThan(cutoff),
  ]);
  return providerRows + indexerRows;
}

// ---------------------------------------------------------------------------
// Resetting recorded stats
// ---------------------------------------------------------------------------

export type UsenetStatsResetTarget = 'providers' | 'indexers' | 'all';

export interface UsenetStatsResetInput {
  target: UsenetStatsResetTarget;
  /** Provider id or indexer label; omit to reset every row of that kind. */
  id?: string;
  /** Inclusive lower bound on the hour bucket. */
  sinceMs?: number;
  /** Exclusive upper bound on the hour bucket. */
  untilMs?: number;
  /** Report what would be removed without removing it. */
  dryRun?: boolean;
  username?: string;
}

export interface UsenetStatsResetResult {
  dryRun: boolean;
  providerRows: number;
  providerArticles: number;
  providerBytes: number;
  indexerRows: number;
  indexerGrabs: number;
  indexerSearches: number;
  /** Resolution × quality rows, counted apart from the hourly rollups. */
  indexerQualityRows: number;
  lastErrorRows: number;
}

/**
 * Persist what the warm engines still hold, or the next drain re-materialises
 * the hour just cleared. Must be `drain()`, not `StatsAccumulator.reset()`,
 * which discards the in-flight busy intervals live streams are mid-way through.
 * Sibling replicas hold their own, so a drain interval of theirs can still land.
 */
async function flushBeforeDelete(): Promise<void> {
  try {
    await drainUsenetMetrics();
  } catch (err) {
    logger.warn({ err }, 'drain before stats reset failed');
  }
}

/** Reset recorded rollups for one provider/indexer, or for all of them. */
export async function resetUsenetStats(
  input: UsenetStatsResetInput
): Promise<UsenetStatsResetResult> {
  const { target, id, sinceMs, untilMs, dryRun = false, username } = input;
  const touchesProviders = target === 'providers' || target === 'all';
  const touchesIndexers = target === 'indexers' || target === 'all';
  const providerScope = { providerId: id, sinceMs, untilMs };
  const indexerScope = { indexer: id, sinceMs, untilMs };

  if (!dryRun) await flushBeforeDelete();

  const provider = touchesProviders
    ? await UsenetMetricsRepository.sumScope(providerScope)
    : { rows: 0, articles: 0, bytes: 0 };
  const indexer = touchesIndexers
    ? await UsenetIndexerMetricsRepository.sumScope(indexerScope)
    : { rows: 0, grabs: 0, searches: 0, qualityRows: 0 };

  // The last-error row carries no hour, so only an unbounded reset can clear it.
  const clearsLastError =
    touchesIndexers && sinceMs === undefined && untilMs === undefined;

  let lastErrorRows = 0;
  if (!dryRun) {
    if (touchesProviders)
      await UsenetMetricsRepository.deleteScope(providerScope);
    if (touchesIndexers)
      await UsenetIndexerMetricsRepository.deleteScope(indexerScope);
    if (clearsLastError) {
      const [grabErrRows, searchErrRows] = await Promise.all([
        UsenetIndexerMetricsRepository.deleteLastError(id),
        UsenetIndexerMetricsRepository.deleteLastSearchError(id),
      ]);
      lastErrorRows = grabErrRows + searchErrRows;
    }
    logger.warn(
      {
        username,
        target,
        id,
        sinceMs,
        untilMs,
        providerRows: provider.rows,
        indexerRows: indexer.rows,
        indexerQualityRows: indexer.qualityRows,
      },
      'usenet stats reset'
    );
  }

  return {
    dryRun,
    providerRows: provider.rows,
    providerArticles: provider.articles,
    providerBytes: provider.bytes,
    indexerRows: indexer.rows,
    indexerGrabs: indexer.grabs,
    indexerSearches: indexer.searches,
    indexerQualityRows: indexer.qualityRows,
    lastErrorRows,
  };
}

/**
 * Pool shape for a configured provider set with no engine warm: known accounts,
 * nothing dialled. Mirrors what a freshly-built engine's pool reports before its
 * first connection, so the dashboard renders the same rows either way.
 */
function idlePool(
  providers: ProviderConfig[],
  options: Partial<EngineOptions>
): PoolInfo {
  return {
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      state: 'offline' as ProviderState,
      total: 0,
      idle: 0,
      acquired: 0,
      available: Math.max(1, p.maxConnections),
      max: p.maxConnections,
      tripped: false,
      throttled: false,
      isBackup: p.isBackup ?? false,
      freeSlots: 0,
      throughput: 0,
      queued: 0,
    })),
    globalDownloadsInUse: 0,
    globalDownloadMax: options.maxConcurrentDownloads ?? 0,
    globalDownloadsOnWire: 0,
    globalDownloadsWaiting: 0,
  };
}

/** Live tiles + pool snapshot from the warm engine for the configured set. */
export function getUsenetLiveStats(): {
  live: LiveTiles;
  pool: PoolInfo;
  cache: CacheStats;
  streams: LiveStreamInfo[];
} {
  const { providers, options } = getUsenetEngineConfig();
  const engine =
    providers.length > 0 ? usenetEngineRegistry.peek(providers) : undefined;
  if (!engine) {
    return {
      live: emptyLive(),
      pool: idlePool(providers, options),
      cache: emptyCache(),
      streams: [],
    };
  }
  const snapshot = engine.liveStats();
  return {
    live: snapshot.tiles,
    pool: snapshot.pool,
    cache: snapshot.cache,
    streams: snapshot.streams,
  };
}

/** Build the full dashboard overview for the given window. */
export async function getUsenetStatsOverview(
  window: UsenetStatsWindow
): Promise<UsenetStatsOverview> {
  const { sinceMs, bucketMs } = resolveWindow(window);
  const configured = configProviders();

  const { live, pool, cache } = getUsenetLiveStats();
  const poolById = new Map(pool.providers.map((p) => [p.id, p]));

  const [
    summary,
    series,
    firstSeenAt,
    indexerSummary,
    indexerErrors,
    indexerSearchErrors,
    indexerQuality,
  ] = await Promise.all([
    UsenetMetricsRepository.summaryByProvider(sinceMs),
    UsenetMetricsRepository.timeSeries(sinceMs, bucketMs),
    UsenetMetricsRepository.firstHour(),
    UsenetIndexerMetricsRepository.summaryByIndexer(sinceMs),
    UsenetIndexerMetricsRepository.lastErrors(),
    UsenetIndexerMetricsRepository.lastSearchErrors(),
    UsenetIndexerMetricsRepository.qualityByIndexer(sinceMs),
  ]);
  const summaryById = new Map(summary.map((s) => [s.providerId, s]));

  const totalArticles = summary.reduce((s, p) => s + p.articles, 0);
  const totalBytes = summary.reduce((s, p) => s + p.bytes, 0);
  const totalWallClockMs = summary.reduce((s, p) => s + p.wallClockMs, 0);
  const totalSpeedBytes = summary.reduce((s, p) => s + p.speedBytes, 0);
  const totalTtfbSamples = summary.reduce((s, p) => s + p.ttfbSamples, 0);
  const totals = {
    articles: totalArticles,
    bytes: totalBytes,
    errors: summary.reduce((s, p) => s + p.errors, 0),
    missing: summary.reduce((s, p) => s + p.missing, 0),
    undecodable: summary.reduce((s, p) => s + p.undecodable, 0),
    avgLatencyMs: avgLatency(
      summary.reduce((s, p) => s + p.sumTtfbMs, 0),
      totalTtfbSamples
    ),
    avgArticleMs: (() => {
      const dur = summary.reduce((s, p) => s + p.sumDurationMs, 0);
      return totalArticles > 0 ? Math.round(dur / totalArticles) : 0;
    })(),
    avgBytesPerSec:
      totalWallClockMs > 0
        ? Math.round(totalSpeedBytes / (totalWallClockMs / 1000))
        : 0,
  };

  // Build a row per configured provider (so idle providers still show), plus
  // any provider that appears in metrics but is no longer configured. Nothing
  // records what a deleted provider was called, so the row can only be flagged
  // `removed` and offered up for deletion.
  const ids = new Set<string>([
    ...configured.map((p) => p.id),
    ...summary.map((s) => s.providerId),
  ]);

  const providers: UsenetProviderStatRow[] = [...ids].map((id) => {
    const cfg = configured.find((p) => p.id === id);
    const agg = summaryById.get(id);
    const info = poolById.get(id);
    const articles = agg?.articles ?? 0;
    const errors = agg?.errors ?? 0;
    const missing = agg?.missing ?? 0;
    const undecodable = agg?.undecodable ?? 0;
    return {
      id,
      name: cfg?.name,
      host: cfg?.host ?? id,
      removed: !cfg,
      enabled: cfg ? cfg.enabled !== false : false,
      isBackup: cfg?.isBackup ?? info?.isBackup ?? false,
      priority: cfg?.priority ?? 0,
      live: {
        state: info?.state ?? (cfg ? 'offline' : 'disabled'),
        active: info?.acquired ?? 0,
        idle: info?.idle ?? 0,
        total: info?.total ?? 0,
        max: info?.max ?? cfg?.maxConnections ?? 0,
        available: info?.available ?? 0,
        tripped: info?.tripped ?? false,
      },
      articles,
      bytes: agg?.bytes ?? 0,
      errors,
      missing,
      undecodable,
      avgLatencyMs: avgLatency(agg?.sumTtfbMs ?? 0, agg?.ttfbSamples ?? 0),
      avgArticleMs:
        articles > 0 ? Math.round((agg?.sumDurationMs ?? 0) / articles) : 0,
      avgBytesPerSec:
        agg && agg.wallClockMs > 0
          ? Math.round(agg.speedBytes / (agg.wallClockMs / 1000))
          : 0,
      errorRate: articles + errors > 0 ? errors / (articles + errors) : 0,
      missRate: articles + missing > 0 ? missing / (articles + missing) : 0,
      undecodableRate:
        articles + undecodable > 0 ? undecodable / (articles + undecodable) : 0,
      articleShare: totalArticles > 0 ? articles / totalArticles : 0,
    };
  });

  // Sort by usage desc, keeping configured-but-idle providers after active ones.
  providers.sort((a, b) => b.articles - a.articles || a.priority - b.priority);

  const lastErrorByIndexer = new Map(indexerErrors.map((e) => [e.indexer, e]));
  const totalGrabs = indexerSummary.reduce((s, i) => s + i.grabs, 0);
  const lastSearchErrorByIndexer = new Map(
    indexerSearchErrors.map((e) => [e.indexer, e])
  );
  const totalResults = indexerSummary.reduce((s, i) => s + i.results, 0);
  const qualityByIndexer = new Map<string, UsenetIndexerQualityCell[]>();
  for (const { indexer, ...cell } of indexerQuality) {
    let cells = qualityByIndexer.get(indexer);
    if (!cells) qualityByIndexer.set(indexer, (cells = []));
    cells.push(cell);
  }
  // Quality rows record even when nothing else does (e.g. a lone indexer
  // behind an external addon), so those indexers still need a row.
  const summaryIndexers = new Set(indexerSummary.map((a) => a.indexer));
  const rollups = [
    ...indexerSummary,
    ...[...qualityByIndexer.keys()]
      .filter((indexer) => !summaryIndexers.has(indexer))
      .map(emptyIndexerRollup),
  ];
  const indexers: UsenetIndexerStatRow[] = rollups
    .map((agg) => {
      const err = lastErrorByIndexer.get(agg.indexer);
      const searchErr = lastSearchErrorByIndexer.get(agg.indexer);
      return {
        indexer: agg.indexer,
        grabs: agg.grabs,
        ok: agg.ok,
        degraded: agg.degraded,
        failed: agg.failed,
        failedMissing: agg.failedMissing,
        failedFetch: agg.failedFetch,
        fetchAuth: agg.fetchAuth,
        fetchLimited: agg.fetchLimited,
        successRate: agg.grabs > 0 ? (agg.ok + agg.degraded) / agg.grabs : 0,
        grabShare: totalGrabs > 0 ? agg.grabs / totalGrabs : 0,
        avgGrabMs:
          agg.grabSamples > 0
            ? Math.round(agg.sumGrabMs / agg.grabSamples)
            : null,
        avgImportMs:
          agg.importSamples > 0
            ? Math.round(agg.sumImportMs / agg.importSamples)
            : null,
        lastError: err
          ? { status: err.status, message: err.message, atMs: err.atMs }
          : undefined,
        searchRequests: agg.searchRequests,
        searchFailed: agg.searchFailed,
        searchEmpty: agg.searchEmpty,
        searchAuth: agg.searchAuth,
        searchLimited: agg.searchLimited,
        searchTimeout: agg.searchTimeout,
        searchSuccessRate:
          agg.searchRequests > 0
            ? (agg.searchRequests - agg.searchFailed) / agg.searchRequests
            : 0,
        avgSearchMs:
          agg.searchRequests > 0
            ? Math.round(agg.sumSearchMs / agg.searchRequests)
            : null,
        results: agg.results,
        searchHits: agg.searchHits,
        avgResults:
          agg.searchHits > 0
            ? Math.round((agg.results / agg.searchHits) * 10) / 10
            : null,
        resultsShare: totalResults > 0 ? agg.results / totalResults : 0,
        lastSearchError: searchErr
          ? {
              status: searchErr.status,
              message: searchErr.message,
              atMs: searchErr.atMs,
            }
          : undefined,
        uniqRequests: agg.uniqRequests,
        uniqReleases: agg.uniqReleases,
        uniqUnique: agg.uniqUnique,
        uniqSole: agg.uniqSole,
        uniqueRate:
          agg.uniqReleases > 0 ? agg.uniqUnique / agg.uniqReleases : null,
        soleRate: agg.uniqRequests > 0 ? agg.uniqSole / agg.uniqRequests : null,
        qualityMix: qualityByIndexer.get(agg.indexer) ?? [],
      };
    })
    .sort(
      (a, b) =>
        b.grabs - a.grabs ||
        b.searchRequests - a.searchRequests ||
        b.results - a.results
    );

  const throughput: UsenetThroughputPoint[] = series.map((b) => ({
    bucketMs: b.bucketMs,
    articles: b.articles,
    bytes: b.bytes,
    errors: b.errors,
    missing: b.missing,
    undecodable: b.undecodable,
    avgLatencyMs: avgLatency(b.sumTtfbMs, b.ttfbSamples),
    avgBytesPerSec:
      b.wallClockMs > 0 ? Math.round(b.speedBytes / (b.wallClockMs / 1000)) : 0,
  }));

  return {
    window,
    generatedAt: Date.now(),
    bucketMs,
    live,
    pool,
    cache,
    totals,
    providers,
    indexers,
    throughput,
    firstSeenAt,
  };
}
