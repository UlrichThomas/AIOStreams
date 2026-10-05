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

/** Apply a migration's sqlite SQL and record it under `id`, bypassing the runner. */
async function applyAs(id: number, m: (typeof MIGRATIONS)[number]) {
  const statements = m.up.sqlite
    .split(/;\s*(?:\r?\n|$)/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) await driver.exec(stmt);
  await driver.exec(`INSERT INTO _migrations (id, name) VALUES (?, ?)`, [
    id,
    m.name,
  ]);
}

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
      assert.notEqual(applied.get(r.from), r.name);
  });

  it('moves rows from an earlier fork build to their new ids without re-running them', async () => {
    // Recreate an earlier fork build's database: upstream's migrations up to
    // 39, then the fork's under the ids upstream has since taken.
    await driver.exec(
      `CREATE TABLE _migrations (
         id INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    );
    const renumbered = new Map(RENUMBERED_MIGRATIONS.map((r) => [r.name, r]));
    const firstOld = Math.min(...RENUMBERED_MIGRATIONS.map((r) => r.from));
    for (const m of MIGRATIONS)
      if (m.id < firstOld && !renumbered.has(m.name)) await applyAs(m.id, m);
    for (const m of MIGRATIONS) {
      const r = renumbered.get(m.name);
      if (r) await applyAs(r.from, m);
    }

    // Re-running the fork's ADD COLUMN migrations would throw on sqlite.
    await runMigrations(driver);
    const applied = await appliedRows();
    for (const m of MIGRATIONS) assert.equal(applied.get(m.id), m.name);
    assert.equal(applied.size, MIGRATIONS.length);
  });

  it("leaves an upstream migration that uses a fork's old id alone", async () => {
    await runMigrations(driver);
    await runMigrations(driver);
    const applied = await appliedRows();
    for (const r of RENUMBERED_MIGRATIONS) {
      const upstream = MIGRATIONS.find((m) => m.id === r.from);
      if (upstream) assert.equal(applied.get(r.from), upstream.name);
      assert.equal(applied.get(r.to), r.name);
    }
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
