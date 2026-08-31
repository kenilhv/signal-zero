// Signal Zero — pool tests. Live database.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  closePool,
  DatabaseUnavailableError,
  databaseUrl,
  LOCAL_DATABASE_URL,
  query,
  redactUrl,
  withTransaction
} from './pool.js';
import { ensureSchema, testPrefix } from './test-helpers.js';

const prefix = testPrefix('pool');

before(async () => {
  await ensureSchema();
});

after(async () => {
  await query('DELETE FROM settlements WHERE settlement_id LIKE $1', [`${prefix}%`]);
  await closePool();
});

describe('pool', () => {
  it('talks to the live database', async () => {
    const { rows } = await query('SELECT 1 + 1 AS two');
    assert.equal(rows[0].two, 2);
  });

  it('returns null, not a Date, for a SQL NULL timestamp', async () => {
    // The single most important property of this layer. If node-postgres or a
    // type parser ever turned NULL into a value, every other guarantee in
    // src/db is decoration.
    const { rows } = await query('SELECT NULL::timestamptz AS t');
    assert.equal(rows[0].t, null);
  });

  it('commits a transaction that returns', async () => {
    const id = `${prefix}-commit`;
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO settlements (settlement_id, name, district, lat, lon, population, hazard_tier)
         VALUES ($1, 'Committed', 'Rasuwa', 28.1, 85.3, 100, 1)`,
        [id]
      );
    });
    const { rows } = await query('SELECT 1 FROM settlements WHERE settlement_id = $1', [id]);
    assert.equal(rows.length, 1);
  });

  it('rolls back a transaction that throws, and rethrows', async () => {
    const id = `${prefix}-rollback`;
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO settlements (settlement_id, name, district, lat, lon, population, hazard_tier)
             VALUES ($1, 'Rolled back', 'Rasuwa', 28.1, 85.3, 100, 1)`,
            [id]
          );
          throw new Error('boom');
        }),
      /boom/
    );
    const { rows } = await query('SELECT 1 FROM settlements WHERE settlement_id = $1', [id]);
    assert.equal(rows.length, 0, 'the insert must not have survived the rollback');
  });

  it('names the fix when DATABASE_URL is missing', async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';
    try {
      assert.throws(
        () => databaseUrl(),
        (err) => {
          assert.ok(err instanceof DatabaseUnavailableError);
          assert.match(err.message, /DATABASE_URL is not set/);
          assert.match(err.message, /postgres:\/\//);
          return true;
        }
      );
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it('redacts the password before a URL reaches a log line', () => {
    assert.equal(
      redactUrl(LOCAL_DATABASE_URL),
      'postgres://signalzero:***@localhost:5544/signalzero'
    );
    assert.equal(redactUrl('not a url'), '<unparseable DATABASE_URL>');
  });
});

// Runs last and in its own describe because it deliberately points the pool at a
// dead port. node --test gives each FILE its own process, and this is the final
// test in the file, so no other test inherits the poisoned pool.
describe('pool: unreachable database', () => {
  it('raises DatabaseUnavailableError naming the host and the docker check', async () => {
    const saved = process.env.DATABASE_URL;
    await closePool();
    // Port 1 is reserved and nothing listens on it.
    process.env.DATABASE_URL = 'postgres://signalzero:signalzero@127.0.0.1:1/signalzero';
    try {
      await assert.rejects(
        () => query('SELECT 1'),
        (err) => {
          assert.ok(err instanceof DatabaseUnavailableError, `got ${err.name}: ${err.message}`);
          assert.match(err.message, /Cannot reach Postgres at/);
          assert.match(err.message, /docker ps --filter name=sz-pg/);
          assert.doesNotMatch(err.message, /signalzero:signalzero/, 'password must be redacted');
          return true;
        }
      );
    } finally {
      await closePool();
      process.env.DATABASE_URL = saved;
    }
  });
});
