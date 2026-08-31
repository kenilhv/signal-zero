// Signal Zero — migration runner.
//
// Numbered plain-SQL files, one transaction each, behind a Postgres advisory
// lock. No ORM, no migration framework — ADR-003 chose this because this
// repository's own docs/trueforge-verified.md root-caused a Windows crash to a
// migration library's dynamic import(), and picking a mechanism because of a
// documented failure beats picking one because it is popular.
//
// Runnable two ways:
//   node src/db/migrate.js        (standalone; exits non-zero on failure)
//   import { migrate }            (server calls it at boot)
//
// ---------------------------------------------------------------------------
// RECONCILING 001, WHICH WAS APPLIED BY HAND
// ---------------------------------------------------------------------------
// The live database already has the 001 schema and no ledger table. Three
// options were on the table:
//
//   (a) INSERT ... ON CONFLICT DO NOTHING and skip 001 unconditionally.
//       Rejected: it hard-codes "001 is special" forever, and it cannot tell a
//       hand-applied database from a fresh one, so a genuinely empty database
//       would end up marked-as-migrated with no tables in it.
//   (b) Checksum-only. Rejected as the primary mechanism: a checksum tells you
//       whether the FILE changed, never whether it was APPLIED. It cannot
//       answer the question being asked here.
//   (c) A bounded ADOPTION WINDOW, which is what this does.
//
// Adoption window: if `schema_migrations` did not exist when the run started,
// this run is adopting a database somebody else built. In that run only, a
// migration that fails with a duplicate-object SQLSTATE is rolled back and
// recorded as applied_by='adopted' instead of aborting — because "the objects
// this file creates are already here" is exactly the state a hand-applied
// migration leaves behind. The window closes the moment the run ends: on every
// later run the same error aborts loudly.
//
// Checksums are still recorded and verified on every subsequent run, so an
// already-applied file that is edited afterwards is caught. For an adopted row
// the checksum is pinned at adoption time, which is the strongest honest claim
// available: we did not run this file, but we know which bytes we adopted.
//
// The ledger row is INSERTed inside the migration's own transaction, so
// "schema changed" and "migration recorded" commit together or not at all.
// ON CONFLICT DO NOTHING is belt-and-braces under the advisory lock.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closePool, getPool } from './pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'db', 'migrations');

// Arbitrary but FIXED. Only this runner ever takes it, so any two processes
// booting at once serialize here instead of racing to CREATE TABLE. Session
// scope, not xact scope: the lock has to span N transactions, one per migration.
const ADVISORY_LOCK_ID = '4207310003';

// "The objects this file creates already exist." Tolerated only inside the
// adoption window; fatal everywhere else.
const DUPLICATE_OBJECT_SQLSTATES = new Set([
  '42P07', // duplicate_table (also index)
  '42P06', // duplicate_schema
  '42710', // duplicate_object (constraint, type)
  '42701', // duplicate_column
  '42723' // duplicate_function
]);

// Transaction control inside a migration would commit the runner's transaction
// early and decouple the schema change from its ledger row. Checked, not trusted.
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION)\b/im;

/** sha256 over LF-normalised bytes, so a CRLF checkout does not look like an edit. */
function checksum(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const out = [];
  for (const name of names) {
    const sql = await readFile(path.join(dir, name), 'utf8');
    if (TRANSACTION_CONTROL.test(stripComments(sql))) {
      throw new Error(
        `Migration ${name} contains transaction control (BEGIN/COMMIT/ROLLBACK). ` +
          'The runner owns the transaction — one per migration, ledger row included. ' +
          'Remove it.'
      );
    }
    out.push({ version: name.replace(/\.sql$/, ''), name, sql, checksum: checksum(sql) });
  }
  return out;
}

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    checksum   TEXT        NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 'runner'  = this process executed the SQL.
    -- 'adopted' = the objects were already present when the ledger was created.
    applied_by TEXT        NOT NULL DEFAULT 'runner'
  )`;

/**
 * Apply every pending migration. Idempotent: a second run applies nothing.
 * @returns {Promise<{applied:string[], adopted:string[], skipped:string[]}>}
 */
export async function migrate({ dir = MIGRATIONS_DIR, logger = console } = {}) {
  const migrations = await loadMigrations(dir);
  const pool = getPool();
  const client = await pool.connect();
  let poisoned = false;
  const result = { applied: [], adopted: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    const { rows: pre } = await client.query('SELECT to_regclass($1) AS reg', [
      'public.schema_migrations'
    ]);
    const adoptionWindow = pre[0].reg === null;
    await client.query(CREATE_LEDGER);

    const { rows: ledger } = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(ledger.map((r) => [r.version, r.checksum]));

    for (const m of migrations) {
      const known = applied.get(m.version);
      if (known !== undefined) {
        if (known !== m.checksum) {
          throw new Error(
            `Migration ${m.name} was already applied but its contents changed ` +
              `(ledger ${known.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…). ` +
              'Applied migrations are immutable — add a new numbered file instead.'
          );
        }
        result.skipped.push(m.version);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, checksum, applied_by)
           VALUES ($1, $2, 'runner') ON CONFLICT (version) DO NOTHING`,
          [m.version, m.checksum]
        );
        await client.query('COMMIT');
        result.applied.push(m.version);
        logger?.info?.(`[signal-zero:migrate] applied ${m.name}`);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          poisoned = true;
          throw err;
        }
        if (!(adoptionWindow && DUPLICATE_OBJECT_SQLSTATES.has(err.code))) throw err;
        await client.query(
          `INSERT INTO schema_migrations (version, checksum, applied_by)
           VALUES ($1, $2, 'adopted') ON CONFLICT (version) DO NOTHING`,
          [m.version, m.checksum]
        );
        result.adopted.push(m.version);
        logger?.warn?.(
          `[signal-zero:migrate] adopted ${m.name} — its objects already existed ` +
            `(${err.code}: ${err.message}). Recorded, not executed.`
        );
      }
    }
    return result;
  } finally {
    if (!poisoned) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
      } catch {
        poisoned = true;
      }
    }
    client.release(poisoned);
  }
}

// Standalone entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await migrate();
    console.log(
      `[signal-zero:migrate] applied=${r.applied.length} adopted=${r.adopted.length} ` +
        `already-applied=${r.skipped.length}`
    );
  } catch (err) {
    console.error(`[signal-zero:migrate] FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

export default migrate;
