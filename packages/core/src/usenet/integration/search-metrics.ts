import {
  UsenetIndexerMetricsRepository,
  type UsenetIndexerDelta,
} from '../../db/index.js';
import { createLogger } from '../../logging/logger.js';
import { indexerLabelFor, grabErrorMessage } from './grab-metrics.js';

const logger = createLogger('usenet/search-metrics');
const MAX_ERROR_MESSAGE_LENGTH = 200;
const NAB_LIMIT_CODES = new Set([500, 501]); // request / download limit reached

export interface SearchOutcome {
  /** Label of the endpoint that was called (caps title / 'Prowlarr' / hostname). */
  endpoint: string;
  ok: boolean;
  searchMs: number;
  /** One entry per returned item. that item's indexer label (may repeat).*/
  itemLabels: string[];
  httpStatus?: number;
  auth?: boolean;
  limited?: boolean;
  timedOut?: boolean;
  errorMessage?: string;
}

/** Pure: one endpoint delta plus one results delta per distinct item label. */
export function searchOutcomeDeltas(o: SearchOutcome): UsenetIndexerDelta[] {
  const endpoint = indexerLabelFor(o.endpoint);
  const byLabel = new Map<string, UsenetIndexerDelta>();
  byLabel.set(endpoint, {
    indexer: endpoint,
    searchRequests: 1,
    searchFailed: o.ok ? 0 : 1,
    searchEmpty: o.ok && o.itemLabels.length === 0 ? 1 : 0,
    searchAuth: !o.ok && o.auth ? 1 : 0,
    searchLimited: !o.ok && o.limited ? 1 : 0,
    searchTimeout: !o.ok && o.timedOut ? 1 : 0,
    sumSearchMs: o.searchMs,
  });
  for (const raw of o.itemLabels) {
    const label = indexerLabelFor(raw);
    const d = byLabel.get(label) ?? { indexer: label };
    if (!d.results) d.searchHits = 1; // first item for this label in this call
    d.results = (d.results ?? 0) + 1;
    byLabel.set(label, d);
  }
  return [...byLabel.values()];
}

export function recordSearchOutcome(o: SearchOutcome): void {
  const atMs = Date.now();
  for (const d of searchOutcomeDeltas(o)) {
    UsenetIndexerMetricsRepository.record(d, atMs).catch((err) =>
      logger.warn(
        { err, indexer: d.indexer },
        'Failed to record search outcome'
      )
    );
  }
  if (!o.ok && o.errorMessage) {
    UsenetIndexerMetricsRepository.setLastSearchError(
      indexerLabelFor(o.endpoint),
      {
        status: o.httpStatus,
        message: o.errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH),
      },
      atMs
    ).catch((err) =>
      logger.warn(
        { err, indexer: indexerLabelFor(o.endpoint) },
        'Failed to record search error'
      )
    );
  }
}

export function classifySearchError(
  err: unknown
): Pick<
  SearchOutcome,
  'httpStatus' | 'auth' | 'limited' | 'timedOut' | 'errorMessage'
> {
  const e = err as {
    name?: string;
    code?: unknown;
    status?: unknown;
    message?: string;
  };
  const errorMessage = grabErrorMessage(err);
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return { timedOut: true, errorMessage };
  if (e?.name === 'NabApiError' && typeof e.code === 'number')
    return {
      auth: e.code >= 100 && e.code <= 104,
      limited: NAB_LIMIT_CODES.has(e.code),
      errorMessage,
    };
  const status =
    typeof e?.status === 'number'
      ? e.status
      : Number(/^(\d{3}) - /.exec(e?.message ?? '')?.[1]) || undefined;
  return {
    httpStatus: status,
    auth: status === 401 || status === 403,
    limited: status === 429,
    errorMessage,
  };
}
