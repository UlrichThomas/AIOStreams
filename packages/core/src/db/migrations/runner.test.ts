import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Use the normal core entry point to initialise the dependency graph.
import '../../index.js';
import { SqliteDriver } from '../driver/sqlite.js';
import { MIGRATIONS, RENUMBERED_MIGRATIONS } from './index.js';
import { runMigrations } from './runner.js';

let dir: string;
let driver: SqliteDriver;

async function appliedRows(): Promise<Map<number, string>> {
  const rows = await driver.query<{ id: number; name: string }>(
    `SELECT id, name FROM _migrations`
  );
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-migrations-'));
  driver = new SqliteDriver(path.join(dir, 'db.sqlite'));
});

afterEach(async () => {
  await driver.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runMigrations', () => {
  it('records every migration under its current id on a fresh database', async () => {
    await runMigrations(driver);
    const applied = await appliedRows();
    for (const m of MIGRATIONS) assert.equal(applied.get(m.id), m.name);
    for (const r of RENUMBERED_MIGRATIONS)
      assert.equal(applied.has(r.from), false);
  });

  it('moves rows from an earlier fork build to their new ids without re-running them', async () => {
    await runMigrations(driver);
    // Rewind to how an earlier fork build recorded them.
    for (const r of RENUMBERED_MIGRATIONS)
      await driver.exec(`UPDATE _migrations SET id = ? WHERE id = ?`, [
        r.from,
        r.to,
      ]);

    // Re-running the ADD COLUMN migrations would throw on sqlite.
    await runMigrations(driver);
    const applied = await appliedRows();
    for (const r of RENUMBERED_MIGRATIONS) {
      assert.equal(applied.get(r.to), r.name);
      assert.equal(applied.has(r.from), false);
    }
    assert.equal(applied.size, MIGRATIONS.length);
  });

  it("leaves an upstream migration that uses a fork's old id alone", async () => {
    await runMigrations(driver);
    await driver.exec(`INSERT INTO _migrations (id, name) VALUES (?, ?)`, [
      40,
      'watch_state_rating',
    ]);
    await runMigrations(driver);
    assert.equal((await appliedRows()).get(40), 'watch_state_rating');
  });

  it('still rejects a database migrated by a different build', async () => {
    await runMigrations(driver);
    const last = MIGRATIONS.find((m) => m.id === 39)!;
    await driver.exec(`UPDATE _migrations SET name = ? WHERE id = ?`, [
      'someone_elses_migration',
      last.id,
    ]);
    await assert.rejects(runMigrations(driver), /different build/);
  });
});
