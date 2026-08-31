// Signal Zero — Postgres connection pool.
//
// One pool per process, created lazily so importing a repository module does not
// open sockets as a side effect of `import`. Everything that talks to Postgres
// goes through `query` or `withTransaction`; no other file constructs a Client.
//
// TIMESTAMPS: this module does NOT install any custom type parser. node-postgres
// hands back a JS `Date` for a TIMESTAMPTZ and `null` for a SQL NULL, and the
// repositories convert with a helper that maps null -> null. That is deliberate:
// a parser that turned NULL into `new Date(0)` would be the coalesce failure of
// hard rule 4 wearing a driver's clothes, and it would be invisible in the SQL.

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

/**
 * The local development database — the sz-pg container on host port 5544, whose
 * schema was applied by hand before the runner existed. Named here so the
 * "DATABASE_URL is not set" error can quote something that actually works, and
 * so the tests have somewhere to point when the variable is absent.
 *
 * NOT the compose stack's database. docker-compose.yml brings up its OWN
 * postgres (host port 5545, "postgres:5432" on the compose network) and sets
 * DATABASE_URL explicitly for the app service, precisely so a compose run can
 * never write to the hand-migrated database on 5544.
 *
 * That compose database is NOT migrated by the runner, and the distinction is
 * worth stating because this comment previously claimed the opposite. Compose
 * mounts ./db/migrations at /docker-entrypoint-initdb.d, so on a fresh volume
 * the Postgres entrypoint executes 001 and 002 BEFORE the app ever connects.
 * The app's runner then finds the objects already present and no ledger, opens
 * its adoption window, and records 001 as 'adopted' — 002 lands as 'runner'
 * only because its ALTER ... IF NOT EXISTS statements re-run as a no-op instead
 * of raising a duplicate-object error. Verified against a `docker compose down
 * -v && docker compose up` on 2026-08-31.
 */
export const LOCAL_DATABASE_URL = 'postgres://signalzero:signalzero@localhost:5544/signalzero';

/** Thrown when the database is unreachable, misconfigured, or refuses us. */
export class DatabaseUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'DatabaseUnavailableError';
    this.code = 'DATABASE_UNAVAILABLE';
    this.statusCode = 503;
  }
}

function intFromEnv(name, fallback) {
  const n = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Strip the password out of a connection string before it reaches a log line. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

export function databaseUrl() {
  const raw = String(process.env.DATABASE_URL ?? '').trim();
  if (raw === '') {
    throw new DatabaseUnavailableError(
      'DATABASE_URL is not set. Signal Zero needs Postgres: the silence clock measures ' +
        'time since the last observation, and a store that forgets on restart cannot ' +
        `measure it. Start the database and set DATABASE_URL, e.g. ${LOCAL_DATABASE_URL}`
    );
  }
  return raw;
}

export function isDatabaseConfigured() {
  return String(process.env.DATABASE_URL ?? '').trim() !== '';
}

let pool = null;

/**
 * The process-wide pool. Created on first use.
 *
 * max defaults to 10: the pipeline is one process doing a handful of concurrent
 * statements per stage, and Postgres's own default max_connections is 100 shared
 * with psql sessions and the migration runner's dedicated lock connection. A
 * larger pool would not make a single-writer pipeline faster, it would only make
 * connection exhaustion a subtler failure.
 */
export function getPool() {
  if (pool) return pool;
  const connectionString = databaseUrl();
  pool = new Pool({
    connectionString,
    max: intFromEnv('PGPOOL_MAX', 10),
    // A connection idle this long is closed; keeps a long-lived server from
    // pinning ten backends overnight.
    idleTimeoutMillis: intFromEnv('PGPOOL_IDLE_MS', 30_000),
    // Fail fast and loudly when nothing is listening, rather than hanging the
    // request that happened to be first after the database went away.
    connectionTimeoutMillis: intFromEnv('PGPOOL_CONNECT_TIMEOUT_MS', 5_000),
    // Server-side cap: kills the statement inside Postgres, so a runaway query
    // stops burning a backend even if the Node process has moved on.
    statement_timeout: intFromEnv('PG_STATEMENT_TIMEOUT_MS', 15_000),
    application_name: 'signal-zero'
  });

  // A pooled connection can die between checkouts (database restart, idle
  // termination). Without this handler node-postgres emits an unhandled 'error'
  // and takes the process down.
  pool.on('error', (err) => {
    console.error(`[signal-zero:db] idle client error: ${err.message}`);
  });

  return pool;
}

const CONNECTION_ERRNOS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNRESET'
]);

// SQLSTATEs that mean "you did not get in", not "your query was wrong".
const CONNECTION_SQLSTATES = new Set([
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
  '3D000', // invalid_catalog_name — the database does not exist
  '57P03', // cannot_connect_now — server still starting
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '57P01', // admin_shutdown — the DBA (or `docker stop`) ended the backend
  '57P02' // crash_shutdown — another backend crashed and took the cluster down
]);

// ---------------------------------------------------------------------------
// THE CODELESS FAILURES, WHICH ARE THE COMMON ONES
// ---------------------------------------------------------------------------
// The two sets above key off `err.code`, and that covers the case where the
// database is ALREADY down when we go looking: connect() fails with ECONNREFUSED
// and everything works.
//
// It does not cover the case that actually happens in production, which is the
// database going away UNDER A LIVE POOL. node-postgres then rejects the in-flight
// query with `Connection terminated unexpectedly` — an Error with NO `code`
// property at all — and every check above misses it. Measured, not guessed:
// `docker stop sz-pg` against an idle app gives ECONNREFUSED, and against an app
// that has just run a pipeline pass (so the pool holds live backends) gives the
// codeless message instead. Only the first of those was being recognised, so the
// most common real outage was reported as `internal-error` / HTTP 500 — "this
// server has a bug" — instead of 503 "the database is down".
//
// Matched by exact driver phrases rather than by a loose /connection/i, because
// a broad pattern would swallow genuine application errors that merely mention
// the word and relabel a bug as an outage. That is the same failure as coalescing
// a NULL: it substitutes a comfortable explanation for an unknown one.
const CONNECTION_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /connection terminated unexpectedly/i,
  /connection terminated due to connection timeout/i,
  /client has encountered a connection error and is not queryable/i,
  /client was closed and is not queryable/i,
  /terminating connection due to administrator command/i,
  /the database system is (starting up|shutting down|in recovery mode)/i
];

/** Re-wrap driver-level connection failures with something a human can act on. */
function asFriendlyError(err) {
  const message = String(err?.message ?? '');
  const isConnection =
    CONNECTION_ERRNOS.has(err?.code) ||
    CONNECTION_SQLSTATES.has(err?.code) ||
    CONNECTION_MESSAGES.some((re) => re.test(message));
  if (!isConnection) return err;
  return new DatabaseUnavailableError(
    `Cannot reach Postgres at ${redactUrl(String(process.env.DATABASE_URL ?? ''))} ` +
      `(${err.code ?? 'unknown'}: ${err.message}). Is the container up? ` +
      'docker ps --filter name=sz-pg',
    err
  );
}

/**
 * Run one statement. Returns the pg Result.
 * @param {string} text
 * @param {unknown[]} [params]
 */
export async function query(text, params) {
  try {
    return await getPool().query(text, params);
  } catch (err) {
    throw asFriendlyError(err);
  }
}

/** The shape every repository function accepts as its optional `db` argument. */
export const db = { query };

/**
 * Check out a client, hand it to `fn`, always release it.
 * `fn` receives an object with the same `query(text, params)` shape as `db`, so
 * a repository function does not know or care whether it is inside a transaction.
 */
export async function withClient(fn) {
  let client;
  try {
    client = await getPool().connect();
  } catch (err) {
    throw asFriendlyError(err);
  }
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a single transaction. Commits on return, rolls back on throw.
 *
 * The client is released with `release(true)` — destroying it — if the ROLLBACK
 * itself fails, because a connection whose transaction state is unknown must not
 * go back into the pool for the next caller to inherit.
 */
export async function withTransaction(fn) {
  let client;
  try {
    client = await getPool().connect();
  } catch (err) {
    throw asFriendlyError(err);
  }
  let poisoned = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      poisoned = true;
    }
    throw asFriendlyError(err);
  } finally {
    client.release(poisoned);
  }
}

/** Close the pool. Call from a standalone script or a test teardown. */
export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

export default { query, db, withClient, withTransaction, getPool, closePool };
