import { getDb } from '../db.js';
import { join, sql, type SqlFragment } from '../sql.js';

/** One concluded grab attempt to fold into an hourly bucket. */
export interface UsenetIndexerDelta {
  indexer: string;
  ok?: number;
  degraded?: number;
  failed?: number;
  /** Subset of `failed`: articles dead on every provider. */
  failedMissing?: number;
  /** Subset of `failed`: the .nzb download from the indexer failed. */
  failedFetch?: number;
  /** Subset of `failedFetch`: HTTP 401/403 (blocked / bad API key). */
  fetchAuth?: number;
  /** Subset of `failedFetch`: HTTP 429 (rate-limited). */
  fetchLimited?: number;
  /** .nzb download duration; folds into sum_grab_ms + grab_samples. */
  grabMs?: number;
  /** Inspect/import duration; folds into sum_import_ms + import_samples. */
  importMs?: number;
  searchRequests?: number;
  searchFailed?: number;
  searchEmpty?: number;
  searchAuth?: number;
  searchLimited?: number;
  searchTimeout?: number;
  sumSearchMs?: number;
  results?: number;
  searchHits?: number;
  /** Stream requests where this indexer returned >= 1 release. */
  uniqRequests?: number;
  /** Distinct releases returned, across those requests. */
  uniqReleases?: number;
  /** Releases no other indexer returned in the same request. */
  uniqUnique?: number;
  /** Requests where this was the only indexer with results. */
  uniqSole?: number;
}

/** Aggregated per-indexer rollup over a window. */
export interface UsenetIndexerRollup {
  indexer: string;
  /** ok + degraded + failed (derived, not stored). */
  grabs: number;
  ok: number;
  degraded: number;
  failed: number;
  failedMissing: number;
  failedFetch: number;
  fetchAuth: number;
  fetchLimited: number;
  sumGrabMs: number;
  grabSamples: number;
  sumImportMs: number;
  importSamples: number;
  searchRequests: number;
  searchFailed: number;
  searchEmpty: number;
  searchAuth: number;
  searchLimited: number;
  searchTimeout: number;
  sumSearchMs: number;
  results: number;
  searchHits: number;
  uniqRequests: number;
  uniqReleases: number;
  uniqUnique: number;
  uniqSole: number;
}

/** Releases of one resolution × quality an indexer returned, to fold in. */
export interface UsenetIndexerQualityDelta {
  indexer: string;
  resolution: string;
  quality: string;
  releases: number;
}

/** One indexer's resolution × quality total over a window. */
export type UsenetIndexerQualityRow = UsenetIndexerQualityDelta;

/**
 * Same-release failover rescues: `loser`'s NZB failed and `winner`'s copy of
 * the same release then played.
 */
export interface UsenetIndexerHeadToHeadRow {
  winner: string;
  loser: string;
  rescues: number;
}

/** Most recent grab-fetch error for an indexer (diagnostic, not windowed). */
export interface UsenetIndexerLastError {
  indexer: string;
  /** HTTP status when known; undefined for DNS/timeout/non-HTTP failures. */
  status?: number;
  message: string;
  atMs: number;
}

interface RollupRow {
  indexer: string;
  ok: number | string;
  degraded: number | string;
  failed: number | string;
  failed_missing: number | string;
  failed_fetch: number | string;
  fetch_auth: number | string;
  fetch_limited: number | string;
  sum_grab_ms: number | string;
  grab_samples: number | string;
  sum_import_ms: number | string;
  import_samples: number | string;
  [k: string]: unknown;
}

/** An empty scope matches every row. */
export interface UsenetIndexerScope {
  indexer?: string;
  /** Inclusive lower bound on `hour_ms`. */
  sinceMs?: number;
  /** Exclusive upper bound on `hour_ms`. */
  untilMs?: number;
}

const HOUR_MS = 3_600_000;

function hourFloor(ts: number): number {
  return ts - (ts % HOUR_MS);
}

function scopeWhere(s: UsenetIndexerScope): SqlFragment {
  const parts: SqlFragment[] = [];
  if (s.indexer !== undefined) parts.push(sql`indexer = ${s.indexer}`);
  if (s.sinceMs !== undefined) parts.push(sql`hour_ms >= ${s.sinceMs}`);
  if (s.untilMs !== undefined) parts.push(sql`hour_ms < ${s.untilMs}`);
  return parts.length === 0 ? sql`1 = 1` : join(parts, ' AND ');
}

/** {@link scopeWhere} for `usenet_indexer_h2h`, whose rows name two indexers. */
function headToHeadScopeWhere(s: UsenetIndexerScope): SqlFragment {
  const parts: SqlFragment[] = [];
  if (s.indexer !== undefined)
    parts.push(sql`(winner = ${s.indexer} OR loser = ${s.indexer})`);
  if (s.sinceMs !== undefined) parts.push(sql`hour_ms >= ${s.sinceMs}`);
  if (s.untilMs !== undefined) parts.push(sql`hour_ms < ${s.untilMs}`);
  return parts.length === 0 ? sql`1 = 1` : join(parts, ' AND ');
}

/**
 * Persistence for per-indexer NZB grab rollups (`usenet_indexer_metrics`).
 */
export class UsenetIndexerMetricsRepository {
  /** Fold one grab outcome into the hour bucket containing `atMs` (defaults now). */
  static async record(
    d: UsenetIndexerDelta,
    atMs: number = Date.now()
  ): Promise<void> {
    const hourMs = hourFloor(atMs);
    const grabMs = d.grabMs ?? 0;
    const importMs = d.importMs ?? 0;
    await getDb().exec(
      sql`INSERT INTO usenet_indexer_metrics
            (hour_ms, indexer, ok, degraded, failed, failed_missing, failed_fetch, fetch_auth, fetch_limited, sum_grab_ms, grab_samples, sum_import_ms, import_samples, search_requests, search_failed, search_empty, search_auth, search_limited, search_timeout, sum_search_ms, results, search_hits, uniq_requests, uniq_releases, uniq_unique, uniq_sole)
          VALUES
            (${hourMs}, ${d.indexer}, ${d.ok ?? 0}, ${d.degraded ?? 0}, ${d.failed ?? 0}, ${d.failedMissing ?? 0}, ${d.failedFetch ?? 0}, ${d.fetchAuth ?? 0}, ${d.fetchLimited ?? 0}, ${grabMs}, ${d.grabMs != null ? 1 : 0}, ${importMs}, ${d.importMs != null ? 1 : 0}, ${d.searchRequests ?? 0}, ${d.searchFailed ?? 0}, ${d.searchEmpty ?? 0}, ${d.searchAuth ?? 0}, ${d.searchLimited ?? 0}, ${d.searchTimeout ?? 0}, ${d.sumSearchMs ?? 0}, ${d.results ?? 0}, ${d.searchHits ?? 0}, ${d.uniqRequests ?? 0}, ${d.uniqReleases ?? 0}, ${d.uniqUnique ?? 0}, ${d.uniqSole ?? 0})
          ON CONFLICT(hour_ms, indexer) DO UPDATE SET
            ok = usenet_indexer_metrics.ok + EXCLUDED.ok,
            degraded = usenet_indexer_metrics.degraded + EXCLUDED.degraded,
            failed = usenet_indexer_metrics.failed + EXCLUDED.failed,
            failed_missing = usenet_indexer_metrics.failed_missing + EXCLUDED.failed_missing,
            failed_fetch = usenet_indexer_metrics.failed_fetch + EXCLUDED.failed_fetch,
            fetch_auth = usenet_indexer_metrics.fetch_auth + EXCLUDED.fetch_auth,
            fetch_limited = usenet_indexer_metrics.fetch_limited + EXCLUDED.fetch_limited,
            sum_grab_ms = usenet_indexer_metrics.sum_grab_ms + EXCLUDED.sum_grab_ms,
            grab_samples = usenet_indexer_metrics.grab_samples + EXCLUDED.grab_samples,
            sum_import_ms = usenet_indexer_metrics.sum_import_ms + EXCLUDED.sum_import_ms,
            import_samples = usenet_indexer_metrics.import_samples + EXCLUDED.import_samples,
            search_requests = usenet_indexer_metrics.search_requests + EXCLUDED.search_requests,
            search_failed = usenet_indexer_metrics.search_failed + EXCLUDED.search_failed,
            search_empty = usenet_indexer_metrics.search_empty + EXCLUDED.search_empty,
            search_auth = usenet_indexer_metrics.search_auth + EXCLUDED.search_auth,
            search_limited = usenet_indexer_metrics.search_limited + EXCLUDED.search_limited,
            search_timeout = usenet_indexer_metrics.search_timeout + EXCLUDED.search_timeout,
            sum_search_ms = usenet_indexer_metrics.sum_search_ms + EXCLUDED.sum_search_ms,
            results = usenet_indexer_metrics.results + EXCLUDED.results,
            search_hits = usenet_indexer_metrics.search_hits + EXCLUDED.search_hits,
            uniq_requests = usenet_indexer_metrics.uniq_requests + EXCLUDED.uniq_requests,
            uniq_releases = usenet_indexer_metrics.uniq_releases + EXCLUDED.uniq_releases,
            uniq_unique = usenet_indexer_metrics.uniq_unique + EXCLUDED.uniq_unique,
            uniq_sole = usenet_indexer_metrics.uniq_sole + EXCLUDED.uniq_sole`
    );
  }

  /**
   * Fold one request's resolution × quality counts into the hour bucket
   * containing `atMs`. Deltas must have distinct keys: postgres rejects an
   * upsert that touches the same row twice. Rows go in key order so
   * concurrent requests lock shared rows in the same order and can't
   * deadlock.
   */
  static async recordQuality(
    deltas: readonly UsenetIndexerQualityDelta[],
    atMs: number = Date.now()
  ): Promise<void> {
    if (deltas.length === 0) return;
    const hourMs = hourFloor(atMs);
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const ordered = [...deltas].sort(
      (a, b) =>
        cmp(a.indexer, b.indexer) ||
        cmp(a.resolution, b.resolution) ||
        cmp(a.quality, b.quality)
    );
    const values = join(
      ordered.map(
        (d) =>
          sql`(${hourMs}, ${d.indexer}, ${d.resolution}, ${d.quality}, ${d.releases})`
      )
    );
    await getDb().exec(
      sql`INSERT INTO usenet_indexer_quality_metrics
            (hour_ms, indexer, resolution, quality, releases)
          VALUES ${values}
          ON CONFLICT(hour_ms, indexer, resolution, quality) DO UPDATE SET
            releases = usenet_indexer_quality_metrics.releases + EXCLUDED.releases`
    );
  }

  /** Per-indexer resolution × quality totals over [sinceMs, now]. */
  static async qualityByIndexer(
    sinceMs: number
  ): Promise<UsenetIndexerQualityRow[]> {
    const rows = await getDb().query<{
      indexer: string;
      resolution: string;
      quality: string;
      releases: number | string;
    }>(
      sql`SELECT indexer, resolution, quality, SUM(releases) AS releases
            FROM usenet_indexer_quality_metrics
           WHERE hour_ms >= ${sinceMs}
           GROUP BY indexer, resolution, quality`
    );
    return rows.map((r) => ({
      indexer: r.indexer,
      resolution: r.resolution,
      quality: r.quality,
      releases: Number(r.releases ?? 0),
    }));
  }

  /**
   * Fold one play's rescues into the hour bucket containing `atMs`. Rows must
   * have distinct (winner, loser) pairs and go in key order, for the same
   * reasons as {@link recordQuality}.
   */
  static async recordHeadToHead(
    rows: readonly UsenetIndexerHeadToHeadRow[],
    atMs: number = Date.now()
  ): Promise<void> {
    if (rows.length === 0) return;
    const hourMs = hourFloor(atMs);
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const ordered = [...rows].sort(
      (a, b) => cmp(a.winner, b.winner) || cmp(a.loser, b.loser)
    );
    const values = join(
      ordered.map(
        (r) => sql`(${hourMs}, ${r.winner}, ${r.loser}, ${r.rescues})`
      )
    );
    await getDb().exec(
      sql`INSERT INTO usenet_indexer_h2h (hour_ms, winner, loser, rescues)
          VALUES ${values}
          ON CONFLICT(hour_ms, winner, loser) DO UPDATE SET
            rescues = usenet_indexer_h2h.rescues + EXCLUDED.rescues`
    );
  }

  /** Rescue totals per (winner, loser) pair over [sinceMs, now]. */
  static async headToHeadSince(
    sinceMs: number
  ): Promise<UsenetIndexerHeadToHeadRow[]> {
    const rows = await getDb().query<{
      winner: string;
      loser: string;
      rescues: number | string;
    }>(
      sql`SELECT winner, loser, SUM(rescues) AS rescues
            FROM usenet_indexer_h2h
           WHERE hour_ms >= ${sinceMs}
           GROUP BY winner, loser`
    );
    return rows.map((r) => ({
      winner: r.winner,
      loser: r.loser,
      rescues: Number(r.rescues ?? 0),
    }));
  }

  /** Overwrite the most recent grab-fetch error for an indexer. */
  static async setLastError(
    indexer: string,
    e: { status?: number; message: string },
    atMs: number = Date.now()
  ): Promise<void> {
    await getDb().exec(
      sql`INSERT INTO usenet_indexer_last_error (indexer, status, message, at_ms)
          VALUES (${indexer}, ${e.status ?? null}, ${e.message}, ${atMs})
          ON CONFLICT(indexer) DO UPDATE SET
            status = EXCLUDED.status,
            message = EXCLUDED.message,
            at_ms = EXCLUDED.at_ms`
    );
  }

  /** All last-error rows (one per indexer that ever had a fetch failure). */
  static async lastErrors(): Promise<UsenetIndexerLastError[]> {
    const rows = await getDb().query<{
      indexer: string;
      status: number | string | null;
      message: string;
      at_ms: number | string;
    }>(
      sql`SELECT indexer, status, message, at_ms FROM usenet_indexer_last_error`
    );
    return rows.map((r) => ({
      indexer: r.indexer,
      status: r.status == null ? undefined : Number(r.status),
      message: r.message,
      atMs: Number(r.at_ms),
    }));
  }

  /** Per-indexer totals over [sinceMs, now]. */
  static async summaryByIndexer(
    sinceMs: number
  ): Promise<UsenetIndexerRollup[]> {
    const rows = await getDb().query<RollupRow>(
      sql`SELECT indexer,
                 SUM(ok) AS ok,
                 SUM(degraded) AS degraded,
                 SUM(failed) AS failed,
                 SUM(failed_missing) AS failed_missing,
                 SUM(failed_fetch) AS failed_fetch,
                 SUM(fetch_auth) AS fetch_auth,
                 SUM(fetch_limited) AS fetch_limited,
                 SUM(sum_grab_ms) AS sum_grab_ms,
                 SUM(grab_samples) AS grab_samples,
                 SUM(sum_import_ms) AS sum_import_ms,
                 SUM(import_samples) AS import_samples,
                 SUM(search_requests) AS search_requests,
                 SUM(search_failed) AS search_failed,
                 SUM(search_empty) AS search_empty,
                 SUM(search_auth) AS search_auth,
                 SUM(search_limited) AS search_limited,
                 SUM(search_timeout) AS search_timeout,
                 SUM(sum_search_ms) AS sum_search_ms,
                 SUM(results) AS results,
                 SUM(search_hits) AS search_hits,
                 SUM(uniq_requests) AS uniq_requests,
                 SUM(uniq_releases) AS uniq_releases,
                 SUM(uniq_unique) AS uniq_unique,
                 SUM(uniq_sole) AS uniq_sole
            FROM usenet_indexer_metrics
           WHERE hour_ms >= ${sinceMs}
           GROUP BY indexer`
    );
    return rows.map((r) => {
      const ok = Number(r.ok ?? 0);
      const degraded = Number(r.degraded ?? 0);
      const failed = Number(r.failed ?? 0);
      return {
        indexer: r.indexer,
        grabs: ok + degraded + failed,
        ok,
        degraded,
        failed,
        failedMissing: Number(r.failed_missing ?? 0),
        failedFetch: Number(r.failed_fetch ?? 0),
        fetchAuth: Number(r.fetch_auth ?? 0),
        fetchLimited: Number(r.fetch_limited ?? 0),
        sumGrabMs: Number(r.sum_grab_ms ?? 0),
        grabSamples: Number(r.grab_samples ?? 0),
        sumImportMs: Number(r.sum_import_ms ?? 0),
        importSamples: Number(r.import_samples ?? 0),
        searchRequests: Number(r.search_requests ?? 0),
        searchFailed: Number(r.search_failed ?? 0),
        searchEmpty: Number(r.search_empty ?? 0),
        searchAuth: Number(r.search_auth ?? 0),
        searchLimited: Number(r.search_limited ?? 0),
        searchTimeout: Number(r.search_timeout ?? 0),
        sumSearchMs: Number(r.sum_search_ms ?? 0),
        results: Number(r.results ?? 0),
        searchHits: Number(r.search_hits ?? 0),
        uniqRequests: Number(r.uniq_requests ?? 0),
        uniqReleases: Number(r.uniq_releases ?? 0),
        uniqUnique: Number(r.uniq_unique ?? 0),
        uniqSole: Number(r.uniq_sole ?? 0),
      };
    });
  }

  /** Totals for a scope, for previewing what a reset would remove. */
  static async sumScope(scope: UsenetIndexerScope): Promise<{
    rows: number;
    grabs: number;
    searches: number;
    qualityRows: number;
  }> {
    // `rows` is a reserved word in postgres; alias around it.
    const [row, quality] = await Promise.all([
      getDb().maybeOne<{
        row_count: number | string;
        grabs: number | string | null;
        searches: number | string | null;
      }>(
        sql`SELECT COUNT(*) AS row_count,
                   SUM(ok + degraded + failed) AS grabs,
                   SUM(search_requests) AS searches
              FROM usenet_indexer_metrics
             WHERE ${scopeWhere(scope)}`
      ),
      getDb().maybeOne<{ row_count: number | string }>(
        sql`SELECT COUNT(*) AS row_count
              FROM usenet_indexer_quality_metrics
             WHERE ${scopeWhere(scope)}`
      ),
    ]);
    return {
      rows: Number(row?.row_count ?? 0),
      grabs: Number(row?.grabs ?? 0),
      searches: Number(row?.searches ?? 0),
      qualityRows: Number(quality?.row_count ?? 0),
    };
  }

  /**
   * Also clears the scope's quality and head-to-head rows (an indexer scope
   * matches either side of a pair); returns the rollup rows removed.
   */
  static async deleteScope(scope: UsenetIndexerScope): Promise<number> {
    await getDb().exec(
      sql`DELETE FROM usenet_indexer_quality_metrics WHERE ${scopeWhere(scope)}`
    );
    await getDb().exec(
      sql`DELETE FROM usenet_indexer_h2h WHERE ${headToHeadScopeWhere(scope)}`
    );
    const res = await getDb().exec(
      sql`DELETE FROM usenet_indexer_metrics WHERE ${scopeWhere(scope)}`
    );
    return res.rowCount ?? 0;
  }

  /** Drops every indexer's row when `indexer` is omitted. */
  static async deleteLastError(indexer?: string): Promise<number> {
    const res = await getDb().exec(
      indexer === undefined
        ? sql`DELETE FROM usenet_indexer_last_error`
        : sql`DELETE FROM usenet_indexer_last_error WHERE indexer = ${indexer}`
    );
    return res.rowCount ?? 0;
  }

  /**
   * Delete rollups (and quality and head-to-head rows) older than the
   * cutoff; returns the rollup rows removed. Last-error rows are kept
   * (1 per indexer).
   */
  static async pruneOlderThan(cutoffMs: number): Promise<number> {
    await getDb().exec(
      sql`DELETE FROM usenet_indexer_quality_metrics WHERE hour_ms < ${cutoffMs}`
    );
    await getDb().exec(
      sql`DELETE FROM usenet_indexer_h2h WHERE hour_ms < ${cutoffMs}`
    );
    const res = await getDb().exec(
      sql`DELETE FROM usenet_indexer_metrics WHERE hour_ms < ${cutoffMs}`
    );
    return res.rowCount ?? 0;
  }

  /** Overwrite the most recent search error for an indexer/endpoint. */
  static async setLastSearchError(
    indexer: string,
    e: { status?: number; message: string },
    atMs = Date.now()
  ): Promise<void> {
    await getDb().exec(
      sql`INSERT INTO usenet_indexer_last_search_error (indexer, status, message, at_ms)
      VALUES (${indexer}, ${e.status ?? null}, ${e.message}, ${atMs})
      ON CONFLICT(indexer) DO UPDATE SET
        status = EXCLUDED.status,
        message = EXCLUDED.message,
        at_ms = EXCLUDED.at_ms`
    );
  }

  /** All last-search-error rows (one per indexer that ever failed a search). */
  static async lastSearchErrors(): Promise<UsenetIndexerLastError[]> {
    const rows = await getDb().query<{
      indexer: string;
      status: number | string | null;
      message: string;
      at_ms: number | string;
    }>(
      sql`SELECT indexer, status, message, at_ms FROM usenet_indexer_last_search_error`
    );
    return rows.map((r) => ({
      indexer: r.indexer,
      status: r.status == null ? undefined : Number(r.status),
      message: r.message,
      atMs: Number(r.at_ms),
    }));
  }

  /** Drops every indexer's row when `indexer` is omitted. */
  static async deleteLastSearchError(indexer?: string): Promise<number> {
    const res = await getDb().exec(
      indexer === undefined
        ? sql`DELETE FROM usenet_indexer_last_search_error`
        : sql`DELETE FROM usenet_indexer_last_search_error WHERE indexer = ${indexer}`
    );
    return res.rowCount ?? 0;
  }
}
