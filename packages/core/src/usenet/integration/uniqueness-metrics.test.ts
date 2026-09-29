import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the dependency graph.
import '../../index.js';
import type { Addon, ParsedStream } from '../../db/schemas.js';
import {
  declaresUsenet,
  mayReturnUsenet,
  uniquenessDeltas,
} from './uniqueness-metrics.js';
import { normaliseReleaseName } from '../../parser/title.js';

describe('normaliseReleaseName', () => {
  it('strips a trailing video extension only after a dot', () => {
    assert.equal(normaliseReleaseName('Show.Parts.mkv'), 'showparts');
    assert.equal(normaliseReleaseName('Show.Parts'), 'showparts');
  });
});

const RK_A = `wd1:${'a'.repeat(32)}`;

function nzb(
  indexer: string | undefined,
  filename: string | undefined,
  extra: Partial<ParsedStream> = {}
): ParsedStream {
  return {
    id: Math.random().toString(),
    type: 'usenet',
    indexer,
    filename,
    nzbUrl: `https://${indexer ?? 'x'}.example/${Math.random()}`,
    ...extra,
  } as unknown as ParsedStream;
}

function byIndexer(streams: ParsedStream[]) {
  return Object.fromEntries(
    uniquenessDeltas(streams).map(({ indexer, ...d }) => [indexer, d])
  );
}

describe('uniquenessDeltas', () => {
  it('returns nothing for no qualifying streams', () => {
    assert.deepEqual(uniquenessDeltas([]), []);
  });

  it('treats a shared releaseKey as the same release', () => {
    const d = byIndexer([
      nzb('A', 'Obfuscated.One.mkv', { releaseKey: RK_A }),
      nzb('B', 'Different.Name.mkv', { releaseKey: RK_A }),
    ]);
    assert.equal(d.A.uniqUnique, 0);
    assert.equal(d.B.uniqUnique, 0);
    assert.equal(d.A.uniqSole, 0);
  });

  it('matches normalised names regardless of size', () => {
    const d = byIndexer([
      nzb('A', 'Show.S01E01.1080p.WEB-DL-GRP.mkv', { size: 1_000 }),
      nzb('B', 'show s01e01 1080p web dl grp', { size: 5_000 }),
      nzb('B', 'Show.S01E01.2160p.WEB-DL-GRP.mkv'),
    ]);
    assert.deepEqual(d.A, {
      uniqRequests: 1,
      uniqReleases: 1,
      uniqUnique: 0,
      uniqSole: 0,
    });
    assert.deepEqual(d.B, {
      uniqRequests: 1,
      uniqReleases: 2,
      uniqUnique: 1,
      uniqSole: 0,
    });
  });

  it('links releases transitively across key kinds', () => {
    // A–B share a releaseKey, B–C share a name: all one release.
    const d = byIndexer([
      nzb('A', 'Name.One', { releaseKey: RK_A }),
      nzb('B', 'Name.Two', { releaseKey: RK_A }),
      nzb('C', 'Name.Two'),
    ]);
    assert.equal(d.A.uniqUnique, 0);
    assert.equal(d.B.uniqUnique, 0);
    assert.equal(d.C.uniqUnique, 0);
  });

  it('counts the same NZB through several services once', () => {
    const url = 'https://a.example/get/1';
    const d = byIndexer([
      nzb('A', 'Movie.2024.mkv', { nzbUrl: url }),
      nzb('A', 'Movie.2024.mkv', { nzbUrl: url }),
      nzb('A', undefined, { nzbUrl: url }),
    ]);
    assert.deepEqual(d.A, {
      uniqRequests: 1,
      uniqReleases: 1,
      uniqUnique: 1,
      uniqSole: 1,
    });
  });

  it('flags a lone indexer as the sole source', () => {
    const d = byIndexer([nzb('A', 'One'), nzb('A', 'Two')]);
    assert.equal(d.A.uniqSole, 1);
    assert.equal(d.A.uniqUnique, 2);
  });

  it('ignores library, unlabelled and non-usenet streams', () => {
    const d = byIndexer([
      nzb('A', 'Shared'),
      nzb('torbox', 'Shared', { library: true }),
      nzb(undefined, 'Shared'),
      nzb('  ', 'Shared'),
      nzb('B', 'Shared', { type: 'debrid' } as Partial<ParsedStream>),
    ]);
    assert.deepEqual(Object.keys(d), ['A']);
    assert.equal(d.A.uniqSole, 1);
  });

  it('does not link names that normalise to nothing', () => {
    const d = byIndexer([nzb('A', '---'), nzb('B', '...')]);
    assert.equal(d.A.uniqUnique, 1);
    assert.equal(d.B.uniqUnique, 1);
  });

  it('counts stremio-usenet streams', () => {
    const d = byIndexer([
      nzb('A', 'Shared'),
      nzb('B', 'Shared', { type: 'stremio-usenet' } as Partial<ParsedStream>),
    ]);
    assert.equal(d.A.uniqUnique, 0);
    assert.equal(d.B.uniqUnique, 0);
  });
});

describe('declaresUsenet', () => {
  it('is true for presets that declare a usenet type', () => {
    assert.equal(declaresUsenet(['usenet']), true);
    assert.equal(declaresUsenet(['debrid', 'stremio-usenet']), true);
  });

  it('is false for torrent-only presets', () => {
    assert.equal(declaresUsenet(['p2p', 'debrid']), false);
  });

  it('is true for presets that declare nothing', () => {
    assert.equal(declaresUsenet([]), true);
  });
});

describe('mayReturnUsenet', () => {
  it('is true for a preset that cannot be resolved', () => {
    const addon = { preset: { type: 'no-such-preset' } } as unknown as Addon;
    assert.equal(mayReturnUsenet(addon), true);
  });
});
