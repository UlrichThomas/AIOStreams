import { baseline } from './0001_baseline.js';
import { settings } from './0002_settings.js';
import { analytics } from './0003_analytics.js';
import { userIndexes } from './0004_user_indexes.js';
import { analyticsV2 } from './0005_analytics_v2.js';
import { analyticsIp } from './0006_analytics_ip.js';
import { usenet } from './0007_usenet.js';
import { usenetMetrics } from './0008_usenet_metrics.js';
import { usenetLibraryExt } from './0009_usenet_library_ext.js';
import { usenetLibraryPassword } from './0010_usenet_library_password.js';
import { usenetSpeed } from './0011_usenet_speed.js';
import { usenetLibraryAliases } from './0012_usenet_library_aliases.js';
import { releaseBlocklist } from './0013_release_blocklist.js';
import { releaseBlocklistPublish } from './0014_release_blocklist_publish.js';
import { usenetLatency } from './0015_usenet_latency.js';
import { usenetIndexerMetrics } from './0016_usenet_indexer_metrics.js';
import { streamSessions } from './0017_stream_sessions.js';
import { taskState } from './0018_task_state.js';
import { configProfiles } from './0019_config_profiles.js';
import { animeDatabase } from './0020_anime_database.js';
import { analyticsIndexes } from './0021_analytics_indexes.js';
import { animeBuildSources } from './0022_anime_build_sources.js';
import { linkedAccounts } from './0023_linked_accounts.js';
import { community } from './0024_community.js';
import { configSessions } from './0025_config_sessions.js';
import { usenetLibraryArr } from './0026_usenet_library_arr.js';
import { usenetUndecodable } from './0027_usenet_undecodable.js';
import { watchState } from './0028_watch_state.js';
import { playbackHandoff } from './0029_playback_handoff.js';
import { watchStateRebuild } from './0030_watch_state_rebuild.js';
import { watchStateScale } from './0031_watch_state_scale.js';
import { watchStateMatchKey } from './0032_watch_state_match_key.js';
import { watchDeliveryLanes } from './0033_watch_delivery_lanes.js';
import { watchSinkLane } from './0034_watch_sink_lane.js';
import { watchStateWatchlist } from './0035_watch_state_watchlist.js';
import { watchSessionDevice } from './0036_watch_session_device.js';
import { watchSinkRetired } from './0037_watch_sink_retired.js';
import { watchSessionUser } from './0038_watch_session_user.js';
import { watchStateDropped } from './0039_watch_state_dropped.js';
import { watchStateRating } from './0040_watch_state_rating.js';
import { usenetIndexerSearch } from './1001_usenet_indexer_search.js';
import { usenetIndexerUniqueness } from './1002_usenet_indexer_uniqueness.js';
import { usenetIndexerQuality } from './1003_usenet_indexer_quality.js';
import { usenetIndexerHeadToHead } from './1004_usenet_indexer_head_to_head.js';
import type { Migration } from './types.js';

export const MIGRATIONS: readonly Migration[] = [
  baseline,
  settings,
  analytics,
  userIndexes,
  analyticsV2,
  analyticsIp,
  usenet,
  usenetMetrics,
  usenetLibraryExt,
  usenetLibraryPassword,
  usenetSpeed,
  usenetLibraryAliases,
  releaseBlocklist,
  releaseBlocklistPublish,
  usenetLatency,
  usenetIndexerMetrics,
  streamSessions,
  taskState,
  configProfiles,
  animeDatabase,
  analyticsIndexes,
  animeBuildSources,
  linkedAccounts,
  community,
  configSessions,
  usenetLibraryArr,
  usenetUndecodable,
  watchState,
  playbackHandoff,
  watchStateRebuild,
  watchStateScale,
  watchStateMatchKey,
  watchDeliveryLanes,
  watchSinkLane,
  watchStateWatchlist,
  watchSessionDevice,
  watchSinkRetired,
  watchSessionUser,
  watchStateDropped,
  watchStateRating,
  // Fork-only migrations use ids from 1001 up, clear of upstream's
  // sequential ids, so merging upstream never reuses one. Add the next
  // fork migration as 1005, and keep these after every upstream entry.
  usenetIndexerSearch,
  usenetIndexerUniqueness,
  usenetIndexerQuality,
  usenetIndexerHeadToHead,
];

/**
 * Fork migrations that shipped under ids upstream has since used. The runner
 * moves a matching `_migrations` row (same old id and name) to the new id
 * before checking for foreign migrations, so databases migrated by earlier
 * fork builds keep working without re-running anything.
 */
export const RENUMBERED_MIGRATIONS: readonly {
  from: number;
  to: number;
  name: string;
}[] = [
  { from: 40, to: 1001, name: 'usenet_indexer_search' },
  { from: 41, to: 1002, name: 'usenet_indexer_uniqueness' },
  { from: 42, to: 1003, name: 'usenet_indexer_quality' },
];

export type { Migration } from './types.js';
