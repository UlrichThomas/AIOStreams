import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the dependency graph.
import '../../index.js';
import type { ParsedStream } from '../../db/schemas.js';
import { qualityDeltas } from './quality-metrics.js';

function nzb(
  indexer: string | undefined,
  filename: string | undefined,
  parsed: { resolution?: string; quality?: string } = {},
  extra: Partial<ParsedStream> = {}
): ParsedStream {
  return {
    id: Math.random().toString(),
    type: 'usenet',
    indexer,
    filename,
    nzbUrl: `https://${indexer ?? 'x'}.example/${Math.random()}`,
    parsedFile: {
      audioChannels: [],
      visualTags: [],
      audioTags: [],
      languages: [],
      ...parsed,
    },
    ...extra,
  } as unknown as ParsedStream;
}

const UHD_REMUX = { resolution: '2160p', quality: 'BluRay REMUX' };
const FHD_BLURAY = { resolution: '1080p', quality: 'BluRay' };

/** `{ "A|2160p|BluRay REMUX": 2, ... }` for readable assertions. */
function counts(streams: ParsedStream[]): Record<string, number> {
  return Object.fromEntries(
    qualityDeltas(streams).map((d) => [
      `${d.indexer}|${d.resolution}|${d.quality}`,
      d.releases,
    ])
  );
}

describe('qualityDeltas', () => {
  it('returns nothing for no qualifying streams', () => {
    assert.deepEqual(qualityDeltas([]), []);
  });

  it('counts releases per resolution and quality', () => {
    assert.deepEqual(
      counts([
        nzb('A', 'Movie.2160p.Remux-X', UHD_REMUX),
        nzb('A', 'Movie.2160p.Remux-Y', UHD_REMUX),
        nzb('A', 'Movie.1080p.BluRay-X', FHD_BLURAY),
      ]),
      { 'A|2160p|BluRay REMUX': 2, 'A|1080p|BluRay': 1 }
    );
  });

  it('counts reposts of one release once per indexer', () => {
    assert.deepEqual(
      counts([
        nzb('A', 'Movie.2160p.Remux-X', UHD_REMUX),
        nzb('A', 'Movie.2160p.Remux-X.mkv', UHD_REMUX),
      ]),
      { 'A|2160p|BluRay REMUX': 1 }
    );
  });

  it('counts a release shared by two indexers once for each', () => {
    assert.deepEqual(
      counts([
        nzb('A', 'Movie.2160p.Remux-X', UHD_REMUX),
        nzb('B', 'Movie.2160p.Remux-X', UHD_REMUX),
      ]),
      { 'A|2160p|BluRay REMUX': 1, 'B|2160p|BluRay REMUX': 1 }
    );
  });

  it('records single-indexer requests', () => {
    assert.equal(qualityDeltas([nzb('A', 'One', UHD_REMUX)]).length, 1);
  });

  it('buckets missing or unrecognised values as Unknown', () => {
    assert.deepEqual(
      counts([
        nzb('A', 'One'),
        nzb('A', 'Two', { resolution: '4320p', quality: 'Telesync-ish' }),
        nzb('A', 'Three', { resolution: '1080p' }),
      ]),
      { 'A|Unknown|Unknown': 2, 'A|1080p|Unknown': 1 }
    );
  });

  it("takes a known value from any of the indexer's copies", () => {
    assert.deepEqual(
      counts([
        nzb('A', 'Movie.Remux-X', {}),
        nzb('A', 'Movie.Remux-X', UHD_REMUX),
      ]),
      { 'A|2160p|BluRay REMUX': 1 }
    );
  });

  it("does not borrow another indexer's parse", () => {
    assert.deepEqual(
      counts([nzb('A', 'Movie-X', {}), nzb('B', 'Movie-X', UHD_REMUX)]),
      { 'A|Unknown|Unknown': 1, 'B|2160p|BluRay REMUX': 1 }
    );
  });

  it('ignores library NZBs, non-usenet streams and missing indexers', () => {
    assert.deepEqual(
      counts([
        nzb('A', 'Lib', UHD_REMUX, { library: true }),
        nzb('A', 'Torrent', UHD_REMUX, { type: 'debrid' } as never),
        nzb(undefined, 'NoIndexer', UHD_REMUX),
      ]),
      {}
    );
  });

  it('emits each key once', () => {
    const deltas = qualityDeltas([
      nzb('A', 'One', UHD_REMUX),
      nzb('A', 'Two', UHD_REMUX),
      nzb('B', 'Three', UHD_REMUX),
    ]);
    const keys = deltas.map((d) => `${d.indexer}|${d.resolution}|${d.quality}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});
