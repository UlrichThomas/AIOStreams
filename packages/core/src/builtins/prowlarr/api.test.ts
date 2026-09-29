import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the dependency graph.
import '../../index.js';
import { searchWasIncomplete } from './api.js';

const START = Date.parse('2026-09-29T12:00:00Z');
const iso = (offsetMs: number) => new Date(START + offsetMs).toISOString();

describe('searchWasIncomplete', () => {
  it('is false with no status entries', () => {
    assert.equal(searchWasIncomplete([], [1, 2], START), false);
  });

  it('ignores indexers that were not searched', () => {
    assert.equal(
      searchWasIncomplete(
        [{ indexerId: 9, mostRecentFailure: iso(1000) }],
        [1, 2],
        START
      ),
      false
    );
  });

  it('flags a failure during the search', () => {
    assert.equal(
      searchWasIncomplete(
        [{ indexerId: 2, mostRecentFailure: iso(1500) }],
        [1, 2],
        START
      ),
      true
    );
  });

  it('flags an indexer backed off past the search start', () => {
    assert.equal(
      searchWasIncomplete(
        [
          {
            indexerId: 1,
            disabledTill: iso(3_600_000),
            mostRecentFailure: iso(-3_600_000),
          },
        ],
        [1],
        START
      ),
      true
    );
  });

  it('ignores an old failure whose backoff has expired', () => {
    assert.equal(
      searchWasIncomplete(
        [
          {
            indexerId: 1,
            disabledTill: iso(-60_000),
            mostRecentFailure: iso(-3_600_000),
          },
        ],
        [1],
        START
      ),
      false
    );
  });

  it('tolerates modest clock skew', () => {
    assert.equal(
      searchWasIncomplete(
        [{ indexerId: 1, mostRecentFailure: iso(-30_000) }],
        [1],
        START
      ),
      true
    );
  });
});
