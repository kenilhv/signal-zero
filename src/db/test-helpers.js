// Signal Zero — shared fixtures for the src/db tests.
//
// These tests run against the LIVE database. There is no in-memory fake and no
// `describe.skip` when DATABASE_URL is unset, because the things being tested —
// that a NULL timestamp survives a round trip, that the index is actually used,
// that approvals.approved_by rejects a blank name — are properties of Postgres,
// and a fake would assert only that the fake agrees with itself.
//
// DATABASE_URL falls back to the URL docker compose publishes so `npm test`
// works with no extra setup. If nothing is listening there the tests FAIL with
// DatabaseUnavailableError; they do not skip. A silently-skipped database test
// suite is indistinguishable from one that passes, which is the worst of both.

import { randomBytes } from 'node:crypto';
import { migrate } from './migrate.js';
import { LOCAL_DATABASE_URL, query } from './pool.js';

if (!String(process.env.DATABASE_URL ?? '').trim()) {
  process.env.DATABASE_URL = LOCAL_DATABASE_URL;
}

let migrated = null;

/** Bring the schema up to date once per test process. */
export function ensureSchema() {
  migrated ??= migrate({ logger: null });
  return migrated;
}

/** A collision-proof prefix so parallel test files never clean up each other's rows. */
export function testPrefix(tag = 't') {
  return `zz-test-${tag}-${process.pid.toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** Insert n gazetteer-shaped settlements under `prefix`. */
export function makeSettlements(prefix, n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-s${i}`,
    name: `Test Settlement ${i}`,
    district: 'Rasuwa',
    lat: 28.1 + i / 100,
    lon: 85.3 + i / 100,
    population: 1000 + i * 100,
    hazardTier: (i % 3) + 1,
    aliases: [`Alias ${i}`, `Alt ${i}`]
  }));
}

/**
 * Delete every row this test run created. Ordered so foreign keys never block a
 * delete, and scoped by prefix so nothing else in the database is touched.
 *
 * Deleting from `observations` here is the one exception to append-only, and it
 * is scoped to settlement ids beginning `zz-test-`: a fixture is not a fact.
 */
export async function cleanup(prefix) {
  const like = `${prefix}%`;
  await query('DELETE FROM incidents WHERE id LIKE $1 OR run_id LIKE $1', [like]);
  await query('DELETE FROM approvals WHERE item_id LIKE $1', [like]);
  await query('DELETE FROM checkpoint_items WHERE id LIKE $1 OR run_id LIKE $1', [like]);
  await query('DELETE FROM ranked_snapshots WHERE run_id LIKE $1 OR settlement_id LIKE $1', [like]);
  await query('DELETE FROM reports WHERE run_id LIKE $1 OR settlement_id LIKE $1', [like]);
  await query('DELETE FROM clusters WHERE run_id LIKE $1 OR settlement_id LIKE $1', [like]);
  await query('DELETE FROM observations WHERE settlement_id LIKE $1', [like]);
  await query('DELETE FROM runs WHERE run_id LIKE $1', [like]);
  await query('DELETE FROM settlements WHERE settlement_id LIKE $1', [like]);
}

export default { ensureSchema, testPrefix, makeSettlements, cleanup };
