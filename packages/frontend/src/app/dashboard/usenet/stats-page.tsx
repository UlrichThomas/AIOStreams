import React from 'react';
import { BiErrorCircle, BiEraser } from 'react-icons/bi';
import { Alert } from '@aiostreams/ui/alert';
import { Card } from '@aiostreams/ui/card';
import { IconButton } from '@aiostreams/ui/button';
import { Popover } from '@aiostreams/ui/popover';
import { Tooltip } from '@aiostreams/ui/tooltip';
import { Switch } from '@aiostreams/ui/switch';
import { cn } from '@aiostreams/ui/core/styling';
import { AreaChart, DonutChart, Stat } from '@aiostreams/ui/charts';
import { DashboardQueryBoundary } from '@/components/shared/dashboard-query-boundary';
import { AnimatedNumber } from '@/components/shared/animated-number';
import {
  useUsenetStats,
  useUsenetLive,
  liveFrameMs,
  type PoolInfo,
  type ProviderPoolInfo,
  type UsenetWindow,
  type ProviderState,
  type UsenetProviderStatRow,
  type UsenetIndexerStatRow,
  type UsenetIndexerHeadToHeadRow,
  type UsenetIndexerQualityCell,
  type UsenetStatsOverview,
} from './queries';
import {
  QUALITIES,
  RESOLUTIONS,
} from '../../../../../core/src/utils/constants';
import {
  ResetStatsModal,
  type ResetStatsTarget,
} from './_components/reset-stats-modal';
import {
  formatBytes,
  formatSpeed,
  formatPercent,
  formatCompact,
  formatDurationMs,
} from '@aiostreams/ui/core/format';

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

/** Chart axis label for a bucket timestamp, varying granularity by window. */
function fmtBucketLabel(ms: number, window: UsenetWindow): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  if (window === '24h') return `${p(d.getHours())}:00`;
  if (window === '7d')
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}h`;
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

const WINDOWS: UsenetWindow[] = ['24h', '7d', '30d', 'all'];

function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2.5 py-1 rounded-md text-xs font-medium border transition-colors',
            value === o.value
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-[--border] text-[--muted] hover:text-[--foreground]'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STATE_DOT: Record<ProviderState, string> = {
  online: 'bg-emerald-500',
  connecting: 'bg-amber-500',
  offline: 'bg-[--muted]',
  auth_failed: 'bg-red-400',
  disabled: 'bg-[--muted]/40',
};

/** How recently a pool must have proven wire contact to still show green. */
const REACHABLE_WINDOW_MS = 90_000;

interface PoolHealth {
  /** `warn`/`bad` are the actionable tones; they surface the details icon. */
  tone: 'ok' | 'warn' | 'bad' | 'idle' | 'off';
  cls: string;
  label: string;
  /** What the condition means and what, if anything, to do about it. */
  hint?: string;
}

/**
 * Live health driven by reachability evidence, not just the state machine:
 * green means "recently proven reachable" (a pool that hasn't dialed in hours
 * must not look healthy), amber flags degraded-but-recovering conditions.
 */
function poolHealth(p: ProviderPoolInfo): PoolHealth {
  if (p.state === 'disabled') {
    return { tone: 'off', cls: 'bg-[--muted]/40', label: 'Disabled' };
  }
  if (p.state === 'auth_failed') {
    return {
      tone: 'bad',
      cls: 'bg-red-400',
      label: 'Authentication failed',
      hint: 'The provider rejected the username or password. Update the credentials on the Providers page.',
    };
  }
  const amber = (label: string, hint?: string): PoolHealth => ({
    tone: 'warn',
    cls: 'bg-amber-500',
    label,
    hint,
  });
  if (p.tripped) {
    return amber(
      'Circuit breaker tripped',
      'Too many failures in a row, so new requests skip this provider and fail over to the others. It retries automatically.'
    );
  }
  if (p.throttled) {
    return amber(
      'Connection-limit throttled',
      'The provider refused another connection, usually because the account is at its connection limit. The pool has backed off and is running below its configured maximum.'
    );
  }
  if (p.state === 'connecting') {
    return amber('Connecting');
  }
  if (p.lastDialError && p.lastDialError.at > (p.lastDialOkAt ?? 0)) {
    return amber(
      `Last dial failed (${p.lastDialError.kind})`,
      'The most recent connection attempt did not succeed. If this persists, check the host, port and TLS settings.'
    );
  }
  // Affirmative evidence only: transferring now, warm connections (which
  // survive only by passing keepalives), or a recent successful dial.
  if (
    p.acquired > 0 ||
    p.total > 0 ||
    (p.lastDialOkAt && Date.now() - p.lastDialOkAt < REACHABLE_WINDOW_MS)
  ) {
    return { tone: 'ok', cls: 'bg-emerald-500', label: 'Reachable' };
  }
  return {
    tone: 'idle',
    cls: 'bg-[--muted]',
    label: 'Idle (no recent connections)',
  };
}

function timeAgo(at: number): string {
  const ms = Date.now() - at;
  return ms < 1000 ? 'just now' : `${formatDurationMs(ms)} ago`;
}

/**
 * Details for a degraded pool.
 */
function ProviderHealthPopover({
  p,
  health,
}: {
  p: ProviderPoolInfo;
  health: PoolHealth;
}) {
  return (
    <Popover
      modal={false}
      align="start"
      className="w-80"
      trigger={
        <button
          type="button"
          aria-label={`${p.name || p.id}: ${health.label}. Show details`}
          className={cn(
            'shrink-0 -my-1 p-1 rounded-full transition-opacity hover:opacity-70',
            health.tone === 'bad' ? 'text-red-400' : 'text-amber-500'
          )}
        >
          <BiErrorCircle className="w-4 h-4" />
        </button>
      }
    >
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <span className={cn('w-2 h-2 rounded-full shrink-0', health.cls)} />
          <span className="text-sm font-semibold">{health.label}</span>
        </div>
        {health.hint && <p className="text-xs text-[--muted]">{health.hint}</p>}
        {p.lastDialError && (
          <div className="rounded-[--radius] bg-[--subtle] p-2 space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium">
                {p.lastDialError.kind}
              </span>
              <span className="text-xs text-[--muted] shrink-0">
                {timeAgo(p.lastDialError.at)}
              </span>
            </div>
            <p className="text-xs text-[--muted] break-words">
              {p.lastDialError.message}
            </p>
          </div>
        )}
        <p className="text-xs text-[--muted]">
          {p.lastDialOkAt
            ? `Last successful connection ${timeAgo(p.lastDialOkAt)}`
            : 'No successful connection recorded'}
          {p.queued > 0 && ` · ${p.queued} queued in pool`}
        </p>
      </div>
    </Popover>
  );
}

/** Downloading/queued split of the global download budget. */
function budgetSplit(pool: PoolInfo): string {
  const queued = Math.max(
    0,
    pool.globalDownloadsInUse - pool.globalDownloadsOnWire
  );
  return (
    `${pool.globalDownloadsOnWire} downloading · ${queued} queued of ` +
    `${pool.globalDownloadMax} budget` +
    (pool.globalDownloadsWaiting > 0
      ? ` · +${pool.globalDownloadsWaiting} waiting`
      : '')
  );
}

// ---------------------------------------------------------------------------
// Live "now" panel
// ---------------------------------------------------------------------------

/**
 * True once pool queues have held work for over a minute with nothing on the
 * wire
 */
function useStuckPool(pool: PoolInfo | undefined): boolean {
  const [stuck, setStuck] = React.useState(false);
  const since = React.useRef<number | null>(null);
  const queuedInPools = pool?.providers.reduce((n, p) => n + p.queued, 0) ?? 0;
  const onWire = pool?.globalDownloadsOnWire ?? 0;
  React.useEffect(() => {
    if (queuedInPools > 0 && onWire === 0) {
      since.current ??= Date.now();
      setStuck(Date.now() - since.current > 60_000);
    } else {
      since.current = null;
      setStuck(false);
    }
  }, [queuedInPools, onWire, pool]);
  return stuck;
}

function LivePanel() {
  const live = useUsenetLive();
  const d = live.data;
  const tiles = d?.live;
  const pool = d?.pool;
  const stuck = useStuckPool(pool);
  const hasBackup = pool?.providers.some((p) => p.isBackup) ?? false;
  const frameMs = liveFrameMs(d);

  return (
    <div className="space-y-4">
      {stuck && (
        <Alert
          intent="warning"
          title="Downloads are queued but no connections are transferring"
          description="Fetches have been parked for over a minute with no wire activity. If this persists, check provider reachability or re-save the provider settings to rebuild the connection pools."
        />
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Active streams"
          value={tiles ? String(tiles.activeStreams) : '—'}
          hint={pool ? budgetSplit(pool) : ''}
        />
        <Stat
          label="Download speed"
          value={
            tiles ? (
              <AnimatedNumber
                value={tiles.currentBytesPerSec}
                format={formatSpeed}
                durationSec={frameMs / 1000}
              />
            ) : (
              '—'
            )
          }
          hint={tiles ? `peak ${formatSpeed(tiles.peakBytesPerSec)}` : ''}
        />
        <Stat
          label="Articles / min"
          value={
            tiles ? (
              <AnimatedNumber
                value={tiles.articlesLastMinute}
                format={(n) => formatCompact(Math.round(n))}
                durationSec={frameMs / 1000}
              />
            ) : (
              '—'
            )
          }
          hint={tiles ? `${tiles.errorsLastMinute} errors` : ''}
        />
        <Stat
          label="Cache hit rate"
          value={
            d ? (
              <AnimatedNumber
                value={d.cache.hitRate}
                format={formatPercent}
                durationSec={frameMs / 1000}
              />
            ) : (
              '—'
            )
          }
          hint={d ? `${formatBytes(d.cache.diskBytes)} on disk` : ''}
        />
      </div>

      <Card className="p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold">Live connections</h3>
          <span className="text-xs text-[--muted]">
            {pool ? budgetSplit(pool) : '0 downloading · 0 queued'}
            {hasBackup ? ' · includes backup capacity' : ''}
          </span>
        </div>
        {!pool || pool.providers.length === 0 ? (
          <p className="text-sm text-[--muted]">
            No active provider pools. Connections open on demand when streaming.
          </p>
        ) : (
          <div className="space-y-2.5">
            {pool.providers.map((p) => {
              const health = poolHealth(p);
              const degraded = health.tone === 'warn' || health.tone === 'bad';
              const pct = (n: number) =>
                p.max ? `${Math.min(100, (n / p.max) * 100)}%` : '0%';
              return (
                <div key={p.id} className="flex items-center gap-3">
                  <Tooltip
                    trigger={
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full shrink-0',
                          health.cls
                        )}
                      />
                    }
                  >
                    {health.label}
                  </Tooltip>
                  <span className="text-sm font-medium w-40 truncate flex items-center gap-1.5">
                    <span className="truncate">{p.name || p.id}</span>
                    {p.isBackup && (
                      <span className="text-xs text-[--muted] shrink-0">
                        backup
                      </span>
                    )}
                    {degraded && (
                      <ProviderHealthPopover p={p} health={health} />
                    )}
                  </span>
                  {/* Faint layer = open connections (incl. idle/connecting),
                      solid layer = actively transferring. Idle-but-warm must
                      look different from no-connections-at-all. */}
                  <div className="relative flex-1 h-1.5 rounded-full bg-[--subtle] overflow-hidden">
                    <div
                      className={cn(
                        'absolute inset-y-0 left-0',
                        'transition-[width] ease-out motion-reduce:transition-none',
                        p.tripped ? 'bg-red-400/30' : 'bg-brand/30'
                      )}
                      style={{
                        width: pct(p.total),
                        transitionDuration: `${frameMs}ms`,
                      }}
                    />
                    <div
                      className={cn(
                        'absolute inset-y-0 left-0',
                        'transition-[width] ease-out motion-reduce:transition-none',
                        p.tripped ? 'bg-red-400' : 'bg-brand'
                      )}
                      style={{
                        width: pct(p.acquired),
                        transitionDuration: `${frameMs}ms`,
                      }}
                    />
                  </div>
                  <span
                    className="text-xs tabular-nums w-24 text-right text-[--foreground]"
                    title={`per-connection download-rate EWMA the load-balancer splits group traffic by · ${p.freeSlots} free pipeline slots · aggregate ≈ this × active connections (see the windowed table for total speed)`}
                  >
                    {p.throughput ? (
                      <>
                        <AnimatedNumber
                          value={p.throughput}
                          format={formatSpeed}
                          durationSec={frameMs / 1000}
                        />
                        /conn
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span
                    className="text-xs text-[--muted] tabular-nums w-40 text-right"
                    title={`${p.queued} queued in pool`}
                  >
                    {p.acquired} active · {p.total} open · max {p.max}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Historical provider performance (windowed)
// ---------------------------------------------------------------------------

/** A deleted provider keeps its stats but not its name, only its uuid. */
function RemovedProviderName({ id }: { id: string }) {
  return (
    <>
      <span className="font-medium text-[--muted]" title={id}>
        Removed provider
      </span>
      <span className="text-xs text-[--muted] tabular-nums" title={id}>
        {id.slice(0, 8)}
      </span>
    </>
  );
}

function ProviderTable({
  providers,
  onReset,
}: {
  providers: UsenetProviderStatRow[];
  onReset: (target: ResetStatsTarget) => void;
}) {
  if (providers.length === 0) {
    return (
      <p className="text-sm text-[--muted]">
        No provider activity recorded in this window yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0">
      <table className="w-full text-sm min-w-[800px]">
        <thead className="text-[--muted] text-xs uppercase">
          <tr className="text-left border-b border-[--border]">
            <th className="py-2 pr-3">Provider</th>
            <th className="py-2 px-3 text-right">Share</th>
            <th className="py-2 px-3 text-right">Data</th>
            <th className="py-2 px-3 text-right">Avg speed</th>
            <th className="py-2 px-3 text-right">Articles</th>
            <th
              className="py-2 px-3 text-right"
              title="How long the provider takes to answer a request for an article, before it starts sending it. Unlike the time to fetch a whole article, this does not grow when your bandwidth is shared across more streams, so it is comparable between providers."
            >
              Avg latency
            </th>
            <th className="py-2 px-3 text-right">Errors</th>
            <th className="py-2 px-3 text-right">Missing</th>
            <th
              className="py-2 px-3 text-right"
              title="Articles the provider delivered whose contents failed the checksum or size check. The fetch falls over to the next provider."
            >
              Unreadable
            </th>
            <th className="py-2 pl-3 w-8" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.id} className="border-b border-[--border]/50">
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full shrink-0',
                      STATE_DOT[p.live.state]
                    )}
                    title={p.live.state}
                  />
                  {p.removed ? (
                    <RemovedProviderName id={p.id} />
                  ) : (
                    <span className="font-medium">{p.name || p.host}</span>
                  )}
                  {p.isBackup && (
                    <span className="text-xs text-[--muted]">backup</span>
                  )}
                  {p.removed ? (
                    <span className="text-xs px-1.5 py-0.5 rounded-[--radius] bg-[--subtle] text-[--muted]">
                      removed
                    </span>
                  ) : (
                    !p.enabled && (
                      <span className="text-xs text-[--muted]">(disabled)</span>
                    )
                  )}
                </div>
              </td>
              <td className="py-2 px-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="w-16 h-1 rounded-full bg-[--subtle] overflow-hidden">
                    <div
                      className="h-full bg-brand"
                      style={{ width: `${p.articleShare * 100}%` }}
                    />
                  </div>
                  <span className="tabular-nums w-10 text-right">
                    {formatPercent(p.articleShare)}
                  </span>
                </div>
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {formatBytes(p.bytes)}
              </td>
              <td
                className="py-2 px-3 text-right tabular-nums"
                title={
                  p.avgArticleMs
                    ? `${p.avgArticleMs}ms to fetch a whole article on average`
                    : undefined
                }
              >
                {p.avgBytesPerSec ? formatSpeed(p.avgBytesPerSec) : '—'}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {formatCompact(p.articles)}
              </td>
              <td
                className="py-2 px-3 text-right tabular-nums"
                title={
                  p.avgLatencyMs == null && p.articles > 0
                    ? 'Latency is only measured on fetches that had a connection to themselves, so a provider running with pipelining enabled may report none.'
                    : undefined
                }
              >
                {p.avgLatencyMs == null ? '—' : `${p.avgLatencyMs}ms`}
              </td>
              <td
                className={cn(
                  'py-2 px-3 text-right tabular-nums',
                  p.errorRate > 0.1 && 'text-red-400'
                )}
              >
                {formatPercent(p.errorRate)}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-[--muted]">
                {formatPercent(p.missRate)}
              </td>
              <td
                className={cn(
                  'py-2 px-3 text-right tabular-nums',
                  p.undecodableRate > 0 ? 'text-amber-400' : 'text-[--muted]'
                )}
              >
                {formatPercent(p.undecodableRate)}
              </td>
              <td className="py-2 pl-3 text-right">
                <Tooltip
                  trigger={
                    <IconButton
                      size="sm"
                      intent="alert-subtle"
                      icon={<BiEraser />}
                      onClick={() =>
                        onReset({
                          target: 'providers',
                          id: p.id,
                          label: p.removed
                            ? `Removed provider ${p.id.slice(0, 8)}`
                            : p.name || p.host,
                        })
                      }
                      aria-label="Reset stats for this provider"
                    />
                  }
                >
                  Reset this provider's recorded stats
                </Tooltip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Last-error recency window for the inline indexer warning icon. */
const INDEXER_ERROR_RECENT_MS = 24 * 3_600_000;

function indexerFailBreakdown(i: UsenetIndexerStatRow): string {
  const fetchOther = i.failedFetch - i.fetchAuth - i.fetchLimited;
  const other = i.failed - i.failedMissing - i.failedFetch;
  const parts = [
    i.failedMissing > 0 && `${i.failedMissing} missing on providers`,
    i.fetchAuth > 0 && `${i.fetchAuth} blocked (401/403)`,
    i.fetchLimited > 0 && `${i.fetchLimited} rate-limited (429)`,
    fetchOther > 0 && `${fetchOther} fetch failed`,
    other > 0 && `${other} other`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function searchFailBreakdown(i: UsenetIndexerStatRow): string {
  const other =
    i.searchFailed - i.searchAuth - i.searchLimited - i.searchTimeout;
  return [
    i.searchAuth > 0 && `${i.searchAuth} rejected (auth)`,
    i.searchLimited > 0 && `${i.searchLimited} rate-limited (429)`,
    i.searchTimeout > 0 && `${i.searchTimeout} timed out`,
    other > 0 && `${other} other`,
  ]
    .filter(Boolean)
    .join(' · ');
}

type IndexerErrorKind = 'grab' | 'search';

/** Popover shape mirroring {@link ProviderHealthPopover} for grab/search errors. */
function indexerErrorInfo(
  e: NonNullable<UsenetIndexerStatRow['lastError']>,
  kind: IndexerErrorKind
): { tone: 'bad' | 'warn'; label: string; hint: string } {
  const auth =
    e.status === 401 || e.status === 403
      ? true
      : kind === 'search' && /Error Code: 10[0-4]\b/.test(e.message);
  const limited =
    e.status === 429 ||
    (kind === 'search' && /Error Code: 50[01]\b/.test(e.message));
  if (auth) {
    return {
      tone: 'bad',
      label: e.status
        ? `Blocked by indexer (HTTP ${e.status})`
        : 'Blocked by indexer',
      hint:
        kind === 'search'
          ? 'The indexer rejected the search. Check the API key.'
          : 'The indexer refused the NZB download. Check that the API key is valid and the account is in good standing.',
    };
  }
  if (limited) {
    return {
      tone: 'warn',
      label: e.status ? `Rate-limited (HTTP ${e.status})` : 'API limit reached',
      hint:
        kind === 'search'
          ? 'Daily API/search limit reached. Searches resume when the indexer resets its quota.'
          : 'The indexer is rate-limiting NZB downloads, usually because the account hit its daily API or grab limit. This normally clears on its own.',
    };
  }
  const verb = kind === 'search' ? 'Search' : 'Grab';
  return {
    tone: 'warn',
    label: e.status ? `${verb} failed (HTTP ${e.status})` : `${verb} failed`,
    hint:
      kind === 'search'
        ? 'The most recent search on this indexer did not succeed. If this persists, check the indexer URL and its status page.'
        : 'The most recent NZB download from this indexer did not succeed. If this persists, check the indexer URL and its status page.',
  };
}

function IndexerErrorPopover({
  indexer,
  error,
  breakdown,
  kind = 'grab',
}: {
  indexer: string;
  error: NonNullable<UsenetIndexerStatRow['lastError']>;
  breakdown?: string;
  kind?: IndexerErrorKind;
}) {
  const info = indexerErrorInfo(error, kind);
  return (
    <Popover
      modal={false}
      align="start"
      className="w-80"
      trigger={
        <button
          type="button"
          aria-label={`${indexer}: ${info.label}. Show details`}
          className={cn(
            'shrink-0 -my-1 p-1 rounded-full transition-opacity hover:opacity-70',
            info.tone === 'bad' ? 'text-red-400' : 'text-amber-500'
          )}
        >
          <BiErrorCircle className="w-4 h-4" />
        </button>
      }
    >
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'w-2 h-2 rounded-full shrink-0',
              info.tone === 'bad' ? 'bg-red-400' : 'bg-amber-500'
            )}
          />
          <span className="text-sm font-semibold">{info.label}</span>
        </div>
        <p className="text-xs text-[--muted]">{info.hint}</p>
        <div className="rounded-[--radius] bg-[--subtle] p-2 space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium">
              {kind === 'search' ? 'Last search error' : 'Last grab error'}
            </span>
            <span className="text-xs text-[--muted] shrink-0">
              {timeAgo(error.atMs)}
            </span>
          </div>
          <p className="text-xs text-[--muted] break-words">{error.message}</p>
        </div>
        {breakdown && (
          <p className="text-xs text-[--muted]">
            Failed in this window: {breakdown}
          </p>
        )}
      </div>
    </Popover>
  );
}

function IndexerTable({
  indexers,
  onReset,
}: {
  indexers: UsenetIndexerStatRow[];
  onReset: (target: ResetStatsTarget) => void;
}) {
  if (indexers.length === 0) {
    return (
      <p className="text-sm text-[--muted]">
        No grabs recorded in this window yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0">
      <table className="w-full text-sm min-w-[720px]">
        <thead className="text-[--muted] text-xs uppercase">
          <tr className="text-left border-b border-[--border]">
            <th className="py-2 pr-3">Indexer</th>
            <th className="py-2 px-3 text-right">Share</th>
            <th className="py-2 px-3 text-right">Grabs</th>
            <th
              className="py-2 px-3 text-right"
              title="Grabs whose import produced a streamable entry (degraded included)."
            >
              Success
            </th>
            <th className="py-2 px-3 text-right">Failed</th>
            <th
              className="py-2 px-3 text-right"
              title="How long the indexer takes to serve the .nzb file itself."
            >
              Avg grab
            </th>
            <th
              className="py-2 px-3 text-right"
              title="How long the import/inspection of the release took after the grab."
            >
              Avg import
            </th>
            <th className="py-2 pl-3 w-8" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {indexers.map((i) => (
            <tr key={i.indexer} className="border-b border-[--border]/50">
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{i.indexer}</span>
                  {i.lastError &&
                    Date.now() - i.lastError.atMs < INDEXER_ERROR_RECENT_MS && (
                      <IndexerErrorPopover
                        indexer={i.indexer}
                        error={i.lastError}
                        breakdown={
                          i.failed > 0 ? indexerFailBreakdown(i) : undefined
                        }
                      />
                    )}
                </div>
              </td>
              <td className="py-2 px-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="w-16 h-1 rounded-full bg-[--subtle] overflow-hidden">
                    <div
                      className="h-full bg-brand"
                      style={{ width: `${i.grabShare * 100}%` }}
                    />
                  </div>
                  <span className="tabular-nums w-10 text-right">
                    {formatPercent(i.grabShare)}
                  </span>
                </div>
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {formatCompact(i.grabs)}
              </td>
              <td
                className={cn(
                  'py-2 px-3 text-right tabular-nums',
                  i.grabs > 0 && 1 - i.successRate > 0.1 && 'text-red-400'
                )}
                title={
                  i.degraded > 0
                    ? `includes ${i.degraded} degraded import${i.degraded === 1 ? '' : 's'}`
                    : undefined
                }
              >
                {formatPercent(i.successRate)}
              </td>
              <td
                className="py-2 px-3 text-right tabular-nums"
                title={i.failed > 0 ? indexerFailBreakdown(i) : undefined}
              >
                {formatCompact(i.failed)}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {i.avgGrabMs == null ? '—' : formatDurationMs(i.avgGrabMs)}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {i.avgImportMs == null ? '—' : formatDurationMs(i.avgImportMs)}
              </td>
              <td className="py-2 pl-3 text-right">
                <Tooltip
                  trigger={
                    <IconButton
                      size="sm"
                      intent="alert-subtle"
                      icon={<BiEraser />}
                      onClick={() =>
                        onReset({
                          target: 'indexers',
                          id: i.indexer,
                          label: i.indexer,
                        })
                      }
                      aria-label="Reset stats for this indexer"
                    />
                  }
                >
                  Reset this indexer's recorded stats
                </Tooltip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Below this many attributable grabs the server leaves an indexer unranked. */
const MIN_RANK_GRABS = 10;

/**
 * Suggested preference order, for comparing against the addon order. Advice
 * only: nothing re-ranks streams from it.
 */
function IndexerPreferenceTable({
  indexers,
  headToHead,
}: {
  indexers: UsenetIndexerStatRow[];
  headToHead: UsenetIndexerHeadToHeadRow[];
}) {
  const rows = indexers
    .filter((i) => i.grabs > 0 || i.rescuedOthers > 0 || i.wasRescued > 0)
    .sort(
      (a, b) =>
        (a.suggestedRank ?? Infinity) - (b.suggestedRank ?? Infinity) ||
        b.grabs - a.grabs
    );
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[--muted]">
        No grabs recorded in this window yet.
      </p>
    );
  }
  // Each unordered pair once, the side with more rescues first.
  const pairs = new Map<
    string,
    { a: string; b: string; aOverB: number; bOverA: number }
  >();
  for (const r of headToHead) {
    const [a, b] =
      r.winner < r.loser ? [r.winner, r.loser] : [r.loser, r.winner];
    const key = `${a}\0${b}`;
    const pair = pairs.get(key) ?? { a, b, aOverB: 0, bOverA: 0 };
    if (r.winner === a) pair.aOverB += r.rescues;
    else pair.bOverA += r.rescues;
    pairs.set(key, pair);
  }
  const pairRows = [...pairs.values()]
    .map((p) =>
      p.aOverB >= p.bOverA
        ? { top: p.a, other: p.b, topWins: p.aOverB, otherWins: p.bOverA }
        : { top: p.b, other: p.a, topWins: p.bOverA, otherWins: p.aOverB }
    )
    .sort((x, y) => y.topWins + y.otherWins - (x.topWins + x.otherWins));
  return (
    <div className="space-y-4">
      <p className="text-xs text-[--muted]">
        A suggested order for your Usenet addons (or the dedup Usenet Indexer
        Order), best first. Nothing is reordered automatically. Indexers with
        fewer than {MIN_RANK_GRABS} grabs in this window aren't ranked.
      </p>
      <div className="overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="text-[--muted] text-xs uppercase">
            <tr className="text-left border-b border-[--border]">
              <th className="py-2 pr-3 w-12">#</th>
              <th className="py-2 px-3">Indexer</th>
              <th
                className="py-2 px-3 text-right"
                title="The lowest grab success rate the data supports with 95% confidence (Wilson lower bound), so a few lucky grabs can't beat a long record. Auth and rate-limit .nzb fetch failures are left out; missing articles count. Plus up to 0.1 for the share of releases no other indexer returned."
              >
                Score
              </th>
              <th className="py-2 px-3 text-right">Grabs</th>
              <th className="py-2 px-3 text-right">Success</th>
              <th
                className="py-2 px-3 text-right"
                title="Same-release failover: times another indexer's NZB failed and this indexer's copy of the release then played. Breaks near-ties in the suggested order."
              >
                Rescued others
              </th>
              <th
                className="py-2 pl-3 text-right"
                title="Same-release failover: times this indexer's NZB failed and another indexer's copy of the release then played."
              >
                Was rescued
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.indexer} className="border-b border-[--border]/50">
                <td className="py-2 pr-3 tabular-nums font-semibold">
                  {i.suggestedRank ?? (
                    <span
                      className="text-[--muted] font-normal"
                      title={`Not enough grabs to rank (needs ${MIN_RANK_GRABS})`}
                    >
                      —
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 font-medium">{i.indexer}</td>
                <td className="py-2 px-3 text-right tabular-nums">
                  {i.rankScore == null ? '—' : i.rankScore.toFixed(3)}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">
                  {formatCompact(i.grabs)}
                </td>
                <td
                  className={cn(
                    'py-2 px-3 text-right tabular-nums',
                    i.grabs > 0 && 1 - i.successRate > 0.1 && 'text-red-400'
                  )}
                >
                  {i.grabs > 0 ? formatPercent(i.successRate) : '—'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">
                  {i.rescuedOthers > 0 ? formatCompact(i.rescuedOthers) : '—'}
                </td>
                <td
                  className={cn(
                    'py-2 pl-3 text-right tabular-nums',
                    i.wasRescued > i.rescuedOthers && 'text-red-400'
                  )}
                >
                  {i.wasRescued > 0 ? formatCompact(i.wasRescued) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pairRows.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase text-[--muted] mb-2">
            Head-to-head
          </h4>
          <ul className="space-y-1 text-sm">
            {pairRows.map((r) => (
              <li key={`${r.top}\0${r.other}`} className="tabular-nums">
                <span className="font-medium">{r.top}</span> rescued{' '}
                <span className="font-medium">{r.other}</span> ×{r.topWins}
                {r.otherWins > 0 && (
                  <span className="text-[--muted]">
                    {' '}
                    · {r.other} rescued {r.top} ×{r.otherWins}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Sole-source share at which an indexer is flagged as hard to drop. */
const SOLE_SOURCE_HIGHLIGHT = 0.1;

function IndexerSearchTable({
  indexers,
  onReset,
}: {
  indexers: UsenetIndexerStatRow[];
  onReset: (target: ResetStatsTarget) => void;
}) {
  const rows = indexers.filter(
    (i) => i.searchRequests > 0 || i.results > 0 || i.uniqReleases > 0
  );
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[--muted]">
        No usenet searches recorded in this window yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0">
      <table className="w-full text-sm min-w-[800px]">
        <thead className="text-[--muted] text-xs uppercase">
          <tr className="text-left border-b border-[--border]">
            <th className="py-2 pr-3">Indexer</th>
            <th
              className="py-2 px-3 text-right"
              title="Upstream search calls, one per page and per title query. Cached answers aren't counted."
            >
              Requests
            </th>
            <th className="py-2 px-3 text-right">Success</th>
            <th
              className="py-2 px-3 text-right"
              title="Successful searches that returned nothing."
            >
              Empty
            </th>
            <th
              className="py-2 px-3 text-right"
              title="Time for the indexer to answer a search, failed calls included."
            >
              Avg search
            </th>
            <th
              className="py-2 px-3 text-right"
              title="Results attributed to this indexer, and the average per search that returned any."
            >
              Results
            </th>
            <th
              className="py-2 px-3 text-right"
              title="Of the distinct releases this indexer returned, the share no other indexer returned for the same request. Raw results, before your filters, compared against the indexers searched in the same request; requests where a usenet source failed, or that searched only one indexer, are not counted."
            >
              Unique
            </th>
            <th className="py-2 pl-3 w-8" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => {
            const hasRequests = i.searchRequests > 0;
            return (
              <tr key={i.indexer} className="border-b border-[--border]/50">
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{i.indexer}</span>
                    {i.lastSearchError &&
                      Date.now() - i.lastSearchError.atMs <
                        INDEXER_ERROR_RECENT_MS && (
                        <IndexerErrorPopover
                          kind="search"
                          indexer={i.indexer}
                          error={i.lastSearchError}
                          breakdown={
                            i.searchFailed > 0
                              ? searchFailBreakdown(i)
                              : undefined
                          }
                        />
                      )}
                  </div>
                </td>
                <td className="py-2 px-3 text-right tabular-nums">
                  {hasRequests ? formatCompact(i.searchRequests) : '—'}
                </td>
                <td
                  className={cn(
                    'py-2 px-3 text-right tabular-nums',
                    hasRequests &&
                      1 - i.searchSuccessRate > 0.1 &&
                      'text-red-400'
                  )}
                  title={
                    i.searchFailed > 0 ? searchFailBreakdown(i) : undefined
                  }
                >
                  {hasRequests ? formatPercent(i.searchSuccessRate) : '—'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-[--muted]">
                  {hasRequests ? formatCompact(i.searchEmpty) : '—'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">
                  {i.avgSearchMs == null
                    ? '—'
                    : formatDurationMs(i.avgSearchMs)}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">
                  {i.results > 0 ? (
                    <>
                      {formatCompact(i.results)}
                      {i.avgResults != null && (
                        <span className="text-[--muted]">
                          {' '}
                          · {i.avgResults}/hit
                        </span>
                      )}
                    </>
                  ) : hasRequests ? (
                    <span
                      className="text-[--muted]"
                      title="Aggregator endpoint: results are credited to the indexers behind it."
                    >
                      —
                    </span>
                  ) : (
                    '0'
                  )}
                </td>
                <td
                  className="py-2 px-3 text-right tabular-nums"
                  title={
                    i.uniqRequests > 0
                      ? `Only source in ${formatCompact(i.uniqSole)} of ${formatCompact(i.uniqRequests)} requests`
                      : undefined
                  }
                >
                  {i.uniqueRate == null ? (
                    '—'
                  ) : (
                    <>
                      {formatPercent(i.uniqueRate)}
                      <span className="text-[--muted]">
                        {' '}
                        · {formatCompact(i.uniqUnique)}
                      </span>
                      {i.soleRate != null &&
                        i.soleRate >= SOLE_SOURCE_HIGHLIGHT && (
                          <span className="ml-1.5 text-xs text-emerald-400">
                            sole {formatPercent(i.soleRate)}
                          </span>
                        )}
                    </>
                  )}
                </td>
                <td className="py-2 pl-3 text-right">
                  <Tooltip
                    trigger={
                      <IconButton
                        size="sm"
                        intent="alert-subtle"
                        icon={<BiEraser />}
                        onClick={() =>
                          onReset({
                            target: 'indexers',
                            id: i.indexer,
                            label: i.indexer,
                          })
                        }
                        aria-label="Reset stats for this indexer"
                      />
                    }
                  >
                    Reset this indexer's recorded stats
                  </Tooltip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const UNKNOWN = 'Unknown';

/** Short column label for a quality ("BluRay REMUX" → "Remux"). */
function qualityLabel(quality: string): string {
  return quality === 'BluRay REMUX' ? 'Remux' : quality;
}

/** "2160p" reads better as "4K" in a column header. */
function resolutionLabel(resolution: string): string {
  return resolution === '2160p' ? '4K' : resolution;
}

function comboKey(
  c: Pick<UsenetIndexerQualityCell, 'resolution' | 'quality'>
): string {
  return `${c.resolution}\0${c.quality}`;
}

/** Position in the core constant list; unrecognised values sort last. */
function rank(list: readonly string[], value: string): number {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i;
}

function IndexerQualityTable({
  indexers,
  onReset,
}: {
  indexers: UsenetIndexerStatRow[];
  onReset: (target: ResetStatsTarget) => void;
}) {
  const [showUnknown, setShowUnknown] = React.useState(false);
  const rows = indexers
    .filter((i) => i.qualityMix.length > 0)
    .map((i) => ({
      indexer: i.indexer,
      counts: new Map(i.qualityMix.map((c) => [comboKey(c), c.releases])),
      total: i.qualityMix.reduce((s, c) => s + c.releases, 0),
    }))
    .sort((a, b) => b.total - a.total);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[--muted]">
        No usenet results recorded in this window yet.
      </p>
    );
  }

  // Every combo any indexer returned, in resolution then quality order.
  const combos = new Map<string, { resolution: string; quality: string }>();
  for (const i of indexers)
    for (const c of i.qualityMix)
      if (
        c.releases > 0 &&
        (showUnknown || (c.resolution !== UNKNOWN && c.quality !== UNKNOWN))
      )
        combos.set(comboKey(c), {
          resolution: c.resolution,
          quality: c.quality,
        });
  const columns = [...combos.entries()]
    .map(([key, c]) => ({ key, ...c }))
    .sort(
      (a, b) =>
        rank(RESOLUTIONS, a.resolution) - rank(RESOLUTIONS, b.resolution) ||
        rank(QUALITIES, a.quality) - rank(QUALITIES, b.quality)
    );
  // Header groups: consecutive columns sharing a resolution.
  const groups: { resolution: string; span: number }[] = [];
  for (const c of columns) {
    const last = groups[groups.length - 1];
    if (last?.resolution === c.resolution) last.span++;
    else groups.push({ resolution: c.resolution, span: 1 });
  }
  const startsGroup = (ci: number) =>
    ci > 0 && columns[ci - 1].resolution !== columns[ci].resolution;

  return (
    <div className="space-y-3 min-w-0">
      <Switch
        label="Show unknown resolution / quality"
        value={showUnknown}
        onValueChange={setShowUnknown}
        size="sm"
      />
      <div className="overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0">
        <table className="w-full text-sm">
          <thead className="text-[--muted] text-xs">
            <tr>
              <th />
              {groups.map((g, gi) => (
                <th
                  key={g.resolution}
                  colSpan={g.span}
                  className={cn(
                    'pt-1 px-2 text-center font-semibold uppercase',
                    gi > 0 && 'border-l border-[--border]'
                  )}
                >
                  {resolutionLabel(g.resolution)}
                </th>
              ))}
              <th />
              <th />
            </tr>
            <tr className="text-left border-b border-[--border]">
              <th className="py-2 pr-3 uppercase">Indexer</th>
              {columns.map((c, ci) => (
                <th
                  key={c.key}
                  className={cn(
                    'py-2 px-2 text-right font-medium whitespace-nowrap',
                    startsGroup(ci) && 'border-l border-[--border]'
                  )}
                >
                  {qualityLabel(c.quality)}
                </th>
              ))}
              <th
                className="py-2 px-3 text-right uppercase"
                title="Distinct releases from raw results, before your filters; reposts of a release count once per request. Includes unknown resolution / quality even when hidden."
              >
                Total
              </th>
              <th className="py-2 pl-3 w-8" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.indexer} className="border-b border-[--border]/50">
                <td className="py-2 pr-3 font-medium whitespace-nowrap">
                  {r.indexer}
                </td>
                {columns.map((c, ci) => {
                  const n = r.counts.get(c.key) ?? 0;
                  const share = r.total > 0 ? n / r.total : 0;
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        'py-2 px-2 text-right tabular-nums',
                        n === 0 && 'text-[--muted]',
                        startsGroup(ci) && 'border-l border-[--border]'
                      )}
                      style={
                        n > 0
                          ? {
                              backgroundColor: `rgb(var(--color-brand-500) / ${(0.08 + share * 0.6).toFixed(3)})`,
                            }
                          : undefined
                      }
                      title={`${r.indexer}: ${n.toLocaleString()} ${resolutionLabel(c.resolution)} ${c.quality} (${formatPercent(share)} of its releases)`}
                    >
                      {n > 0 ? formatCompact(n) : '—'}
                    </td>
                  );
                })}
                <td className="py-2 px-3 text-right tabular-nums font-medium">
                  {formatCompact(r.total)}
                </td>
                <td className="py-2 pl-3 text-right">
                  <Tooltip
                    trigger={
                      <IconButton
                        size="sm"
                        intent="alert-subtle"
                        icon={<BiEraser />}
                        onClick={() =>
                          onReset({
                            target: 'indexers',
                            id: r.indexer,
                            label: r.indexer,
                          })
                        }
                        aria-label="Reset stats for this indexer"
                      />
                    }
                  >
                    Reset this indexer's recorded stats
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResetAllButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip
      trigger={
        <IconButton
          size="sm"
          intent="alert-subtle"
          icon={<BiEraser />}
          onClick={onClick}
          aria-label={label}
        />
      }
    >
      {label}
    </Tooltip>
  );
}

function StatsSection({
  data,
  onReset,
}: {
  data: UsenetStatsOverview;
  onReset: (target: ResetStatsTarget) => void;
}) {
  const chartData = data.throughput.map((b) => ({
    t: fmtBucketLabel(b.bucketMs, data.window),
    bytes: b.bytes,
  }));
  const share = data.providers
    .filter((p) => p.articles > 0)
    .slice(0, 6)
    .map((p) => ({ name: p.name || p.host, value: p.articles }));
  const totalGrabs = data.indexers.reduce((s, i) => s + i.grabs, 0);
  const grabShare = data.indexers
    .filter((i) => i.grabs > 0)
    .slice(0, 6)
    .map((i) => ({ name: i.indexer, value: i.grabs }));
  const [indexerView, setIndexerView] = React.useState<
    'grabs' | 'searches' | 'quality' | 'preference'
  >('grabs');
  const grabIndexers = data.indexers.filter((i) => i.grabs > 0);
  const totalResults = data.indexers.reduce((s, i) => s + i.results, 0);
  const resultsShare = data.indexers
    .filter((i) => i.results > 0)
    .sort((a, b) => b.results - a.results)
    .slice(0, 6)
    .map((i) => ({ name: i.indexer, value: i.results }));
  const qualityTotals = new Map<string, { name: string; value: number }>();
  for (const i of data.indexers)
    for (const c of i.qualityMix) {
      const name = `${resolutionLabel(c.resolution)} ${qualityLabel(c.quality)}`;
      const cur = qualityTotals.get(name);
      if (cur) cur.value += c.releases;
      else qualityTotals.set(name, { name, value: c.releases });
    }
  const totalQualityReleases = [...qualityTotals.values()].reduce(
    (s, c) => s + c.value,
    0
  );
  const qualityShare = [...qualityTotals.values()]
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const donut =
    indexerView === 'grabs' || indexerView === 'preference'
      ? { data: grabShare, label: 'grabs', value: totalGrabs }
      : indexerView === 'searches'
        ? { data: resultsShare, label: 'results', value: totalResults }
        : {
            data: qualityShare,
            label: 'releases',
            value: totalQualityReleases,
          };
  const table =
    indexerView === 'grabs' ? (
      <IndexerTable indexers={grabIndexers} onReset={onReset} />
    ) : indexerView === 'searches' ? (
      <IndexerSearchTable indexers={data.indexers} onReset={onReset} />
    ) : indexerView === 'preference' ? (
      <IndexerPreferenceTable
        indexers={data.indexers}
        headToHead={data.headToHead ?? []}
      />
    ) : (
      <IndexerQualityTable indexers={data.indexers} onReset={onReset} />
    );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Data downloaded" value={formatBytes(data.totals.bytes)} />
        <Stat
          label="Avg download speed"
          value={
            data.totals.avgBytesPerSec
              ? formatSpeed(data.totals.avgBytesPerSec)
              : '—'
          }
          hint={`avg while streaming · ${data.window}`}
        />
        <Stat label="Articles" value={formatCompact(data.totals.articles)} />
        <Stat
          label="Avg latency"
          value={
            data.totals.avgLatencyMs == null
              ? '—'
              : `${data.totals.avgLatencyMs}ms`
          }
          hint={
            data.totals.avgArticleMs
              ? `${data.totals.avgArticleMs}ms per whole article`
              : ''
          }
        />
        <Stat
          label="Error rate"
          value={formatPercent(
            data.totals.articles + data.totals.errors > 0
              ? data.totals.errors / (data.totals.articles + data.totals.errors)
              : 0
          )}
          hint={
            data.totals.undecodable
              ? `${formatCompact(data.totals.undecodable)} unreadable`
              : ''
          }
        />
      </div>

      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Data downloaded</h3>
        {chartData.length === 0 ? (
          <p className="text-sm text-[--muted]">No data for this window yet.</p>
        ) : (
          <AreaChart
            data={chartData}
            xKey="t"
            series={[
              { key: 'bytes', label: 'Downloaded', color: 'var(--brand)' },
            ]}
            height={240}
            valueFormatter={(v) => formatBytes(Number(v))}
            yTickFormatter={(v) => formatBytes(Number(v))}
          />
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Provider performance</h3>
          <ResetAllButton
            label="Reset all provider stats"
            onClick={() =>
              onReset({ target: 'providers', label: 'All providers' })
            }
          />
        </div>
        {share.length > 0 ? (
          <div className="grid lg:grid-cols-[1fr,240px] gap-6 items-center">
            <ProviderTable providers={data.providers} onReset={onReset} />
            <div className="mx-auto w-full max-w-[240px] aspect-square">
              <DonutChart
                data={share}
                centerLabel="articles"
                centerValue={formatCompact(data.totals.articles)}
                height={240}
              />
            </div>
          </div>
        ) : (
          <ProviderTable providers={data.providers} onReset={onReset} />
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-semibold">Indexer performance</h3>
          <div className="flex items-center gap-2">
            <SegmentedToggle
              label="Indexer metric"
              options={
                [
                  { value: 'grabs', label: 'Grabs' },
                  { value: 'searches', label: 'Searches' },
                  { value: 'quality', label: 'Quality' },
                  { value: 'preference', label: 'Preference' },
                ] as const
              }
              value={indexerView}
              onChange={setIndexerView}
            />
            <ResetAllButton
              label="Reset all indexer stats"
              onClick={() =>
                onReset({ target: 'indexers', label: 'All indexers' })
              }
            />
          </div>
        </div>
        {donut.data.length > 0 ? (
          <div className="grid lg:grid-cols-[1fr,240px] gap-6 items-center">
            {table}
            <div className="mx-auto w-full max-w-[240px] aspect-square">
              <DonutChart
                data={donut.data}
                centerLabel={donut.label}
                centerValue={formatCompact(donut.value)}
                height={240}
              />
            </div>
          </div>
        ) : (
          table
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Stats section: live "now" tiles + connections, plus windowed historical
 * provider performance and throughput.
 */
export function UsenetStatsPage() {
  const [window, setWindow] = React.useState<UsenetWindow>('24h');
  const [resetting, setResetting] = React.useState<ResetStatsTarget | null>(
    null
  );
  const stats = useUsenetStats(window);
  return (
    <div className="space-y-6">
      {/* Window selector lives here (not the page header) so it never squishes
          the heading on narrow screens. */}
      <div className="flex justify-end">
        <SegmentedToggle
          label="Time window"
          options={WINDOWS.map((w) => ({ value: w, label: w }))}
          value={window}
          onChange={setWindow}
        />
      </div>
      <LivePanel />
      <DashboardQueryBoundary
        query={stats}
        errorTitle="Failed to load usenet stats"
      >
        {(d) => <StatsSection data={d} onReset={setResetting} />}
      </DashboardQueryBoundary>
      <ResetStatsModal target={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}
