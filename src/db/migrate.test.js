// Signal Zero — migration runner tests. Live database, no fakes.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadMigrations, MIGRATIONS_DIR, migrate } from './migrate.js';
import { closePool, query } from './pool.js';
import { ensureSchema } from './test-helpers.js';

const tag = randomBytes(3).toString('hex');
const scratchTable = `zz_migrate_test_${tag}`;
const scratchVersion = `900_scratch_${tag}`;
let dir;

before(async () => {
  await ensureSchema();
  dir = await mkdtemp(path.join(tmpdir(), 'sz-migrate-'));
});

after(async () => {
  await query(`DROP TABLE IF EXISTS ${scratchTable}`);
  await query('DELETE FROM schema_migrations WHERE version LIKE $1', ['900_%']);
  if (dir) await rm(dir, { recursive: true, force: true });
  await closePool();
});

describe('migration runner', () => {
  it('has already applied every real migration, and re-running applies nothing', async () => {
    const r = await migrate({ logger: null });
    assert.equal(r.applied.length, 0, 'a second run must apply nothing');
    assert.equal(r.adopted.length, 0, 'adoption is a one-time window and it has closed');
    assert.ok(r.skipped.includes('001_initial'));
    assert.ok(r.skipped.includes('002_store_shape_parity'));
  });

  it('recorded 001 as adopted, not as executed by the runner', async () => {
    // 001 was applied to this database by hand before the runner existed. The
    // ledger must say so rather than claiming the runner ran it.
    const { rows } = await query('SELECT applied_by FROM schema_migrations WHERE version = $1', [
      '001_initial'
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].applied_by, 'adopted');
  });

  it('every migration file parses and none contains transaction control', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    assert.ok(migrations.length >= 2);
    for (const m of migrations) assert.match(m.checksum, /^[0-9a-f]{64}$/);
  });

  it('refuses a migration that opens its own transaction', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'sz-migrate-bad-'));
    await writeFile(path.join(bad, '001_bad.sql'), 'BEGIN;\nSELECT 1;\nCOMMIT;\n');
    await assert.rejects(() => loadMigrations(bad), /transaction control/i);
    await rm(bad, { recursive: true, force: true });
  });

  it('applies a new migration and records it as run by the runner', async () => {
    await writeFile(
      path.join(dir, `${scratchVersion}.sql`),
      `CREATE TABLE ${scratchTable} (id int primary key);\n`
    );
    const r = await migrate({ dir, logger: null });
    assert.deepEqual(r.applied, [scratchVersion]);

    const { rows } = await query('SELECT to_regclass($1) AS reg', [`public.${scratchTable}`]);
    assert.notEqual(rows[0].reg, null, 'the table the migration creates must exist');

    const ledger = await query('SELECT applied_by FROM schema_migrations WHERE version = $1', [
      scratchVersion
    ]);
    assert.equal(ledger.rows[0].applied_by, 'runner');
  });

  it('is idempotent: the same directory a second time applies nothing', async () => {
    const r = await migrate({ dir, logger: null });
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.adopted, []);
    assert.deepEqual(r.skipped, [scratchVersion]);
  });

  it('rejects an applied migration whose contents changed', async () => {
    await writeFile(
      path.join(dir, `${scratchVersion}.sql`),
      `CREATE TABLE ${scratchTable} (id int primary key, extra text);\n`
    );
    await assert.rejects(() => migrate({ dir, logger: null }), /contents changed/i);
    // Restore so the idempotency of later runs is not affected.
    await writeFile(
      path.join(dir, `${scratchVersion}.sql`),
      `CREATE TABLE ${scratchTable} (id int primary key);\n`
    );
  });

  it('the adoption window is closed: a duplicate object now fails loudly', async () => {
    // Same CREATE TABLE under a NEW version. Inside the adoption window this
    // would have been recorded as adopted; outside it, it must abort.
    const dup = `900_dup_${tag}`;
    await writeFile(
      path.join(dir, `${dup}.sql`),
      `CREATE TABLE ${scratchTable} (id int primary key);\n`
    );
    await assert.rejects(() => migrate({ dir, logger: null }), /already exists/i);
    const { rows } = await query('SELECT 1 FROM schema_migrations WHERE version = $1', [dup]);
    assert.equal(rows.length, 0, 'a failed migration must not be recorded');
    await rm(path.join(dir, `${dup}.sql`));
  });

  it('two concurrent runners do not race: the advisory lock serialises them', async () => {
    const raceTable = `zz_migrate_race_${tag}`;
    const raceVersion = `900_race_${tag}`;
    const raceDir = await mkdtemp(path.join(tmpdir(), 'sz-migrate-race-'));
    await writeFile(
      path.join(raceDir, `${raceVersion}.sql`),
      `CREATE TABLE ${raceTable} (id int primary key);\n`
    );
    try {
      // Without pg_advisory_lock one of these loses with 42P07 duplicate_table.
      const [a, b] = await Promise.all([
        migrate({ dir: raceDir, logger: null }),
        migrate({ dir: raceDir, logger: null })
      ]);
      const appliedTotal = a.applied.length + b.applied.length;
      assert.equal(appliedTotal, 1, 'exactly one of the two runners applies it');
      const { rows } = await query(
        'SELECT count(*)::int n FROM schema_migrations WHERE version=$1',
        [raceVersion]
      );
      assert.equal(rows[0].n, 1, 'exactly one ledger row');
    } finally {
      await query(`DROP TABLE IF EXISTS ${raceTable}`);
      await rm(raceDir, { recursive: true, force: true });
    }
  });
});
