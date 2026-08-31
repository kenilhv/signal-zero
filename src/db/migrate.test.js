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

  it('records every migration with a provenance the ledger can defend', async () => {
    // WHAT THIS DOES NOT ASSERT, AND WHY.
    //
    // This test used to read `applied_by` for 001 out of whatever database it
    // happened to be pointed at and assert 'adopted'. That passed on exactly one
    // machine — the laptop whose sz-pg had 001 applied by hand before the runner
    // existed — and it FAILED everywhere else, including CI, whose own workflow
    // comment says the service container "starts genuinely empty, so 001 is RUN
    // here rather than adopted". The assertion was pinned to an accident of one
    // database's history rather than to a behaviour of this code, so it went red
    // on every fresh checkout and on every `drop schema public cascade`.
    //
    // `applied_by` is legitimately EITHER value depending on how the database
    // came to exist, so the environment-independent invariant is: every real
    // migration is recorded exactly once, with a provenance from the known set.
    // The 'adopted' path itself is proved below, by CONSTRUCTING the hand-applied
    // database instead of hoping to be run against one.
    const versions = (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.version);
    for (const version of versions) {
      const { rows } = await query('SELECT applied_by FROM schema_migrations WHERE version = $1', [
        version
      ]);
      assert.equal(rows.length, 1, `${version} must be recorded exactly once`);
      assert.ok(
        ['runner', 'adopted'].includes(rows[0].applied_by),
        `${version} has provenance "${rows[0].applied_by}", which is neither runner nor adopted`
      );
    }
  });

  it('adopts a hand-applied database instead of claiming the runner built it', async () => {
    // The adoption window opens only when `schema_migrations` does not exist
    // while the objects a migration creates already do. That state cannot be
    // reached in a database this runner has already migrated, so the test builds
    // it: a throwaway database, 001 applied BY HAND exactly as a human would
    // have, then the runner let loose on it.
    //
    // CREATE DATABASE cannot run inside a transaction, which is why it goes
    // through query() rather than withTransaction().
    const scratchDb = `sz_adopt_test_${tag}`;
    const originalUrl = process.env.DATABASE_URL;
    const scratchUrl = new URL(originalUrl);
    scratchUrl.pathname = `/${scratchDb}`;

    const [first] = await loadMigrations(MIGRATIONS_DIR);
    await query(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await query(`CREATE DATABASE ${scratchDb}`);

    try {
      // Point the process-wide pool at the throwaway database. closePool() first
      // so the next getPool() reads the new URL rather than reusing the old one.
      await closePool();
      process.env.DATABASE_URL = scratchUrl.toString();

      // The hand application. No ledger row is written — that is the whole point:
      // this is what a database somebody else built looks like.
      await query(first.sql);
      const { rows: pre } = await query("SELECT to_regclass('public.schema_migrations') AS reg");
      assert.equal(pre[0].reg, null, 'the hand-applied database must have no ledger yet');

      const r = await migrate({ logger: null });
      assert.ok(
        r.adopted.includes(first.version),
        `${first.version} should have been adopted, got applied=${r.applied} adopted=${r.adopted}`
      );

      const { rows } = await query(
        'SELECT applied_by, checksum FROM schema_migrations WHERE version = $1',
        [first.version]
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].applied_by, 'adopted');
      // The checksum is pinned at adoption time — "we did not run this file, but
      // we know which bytes we adopted".
      assert.equal(rows[0].checksum, first.checksum);

      // The window is one run wide. A second run must not adopt anything else.
      const again = await migrate({ logger: null });
      assert.equal(again.applied.length, 0);
      assert.equal(again.adopted.length, 0, 'the adoption window must close with the run');
    } finally {
      await closePool();
      process.env.DATABASE_URL = originalUrl;
      await query(`DROP DATABASE IF EXISTS ${scratchDb}`);
    }
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
