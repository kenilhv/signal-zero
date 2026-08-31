// Signal Zero — which store is live, decided once, at boot.
//
// ---------------------------------------------------------------------------
// THE DECISION THIS FILE MAKES, AND WHY IT IS NOT A HARD ERROR
// ---------------------------------------------------------------------------
// DATABASE_URL absent could mean "refuse to boot" or "boot degraded". This picks
// degraded, for the same reason the TrueForge path already does: a disaster tool
// that will not start because one dependency is missing has chosen the operator's
// worst moment to be principled about configuration. An operator with no database
// still needs the map, the fail feed and the checkpoint queue.
//
// The cost of that choice is that the silence clock stops surviving restarts,
// and the silence clock is the product. So the mode is not a footnote: it is on
// GET /api/state as `persistence.durable`, it is on the boot banner, and it
// raises an incident on the feed the operator is already watching. The rule is
// not "always work"; it is NEVER LIE ABOUT WHICH MODE YOU ARE IN.
//
// EXACTLY ONE BACKEND IS LIVE. This is the part that matters. There is no
// write-through cache, no read-through mirror, no "memory with a database behind
// it". `repos` is bound once to one implementation and never swaps. An in-memory
// copy running alongside Postgres is the failure the plan warned about — it
// diverges silently, and the divergence surfaces as a wrong silence score, which
// is indistinguishable from a real one. Two stores is the bug. One store,
// honestly labelled, is a mode.
//
// A THIRD OUTCOME EXISTS AND IS DISTINCT FROM BOTH: DATABASE_URL is set but the
// database is unreachable or the migration fails. That does NOT silently become
// memory mode. It reports `mode: 'memory'` with `configured: true` and an
// `error`, because "you did not configure a database" and "you configured one
// and we could not use it" are different operator problems with different fixes,
// and collapsing them costs an hour of debugging at exactly the wrong time.

import * as memory from './memory-repositories.js';
import { migrate } from './migrate.js';
import { DatabaseUnavailableError, isDatabaseConfigured, redactUrl } from './pool.js';
import * as sql from './repositories/index.js';

/** @type {{mode:'postgres'|'memory', durable:boolean, configured:boolean, reason:string, error:string|null, databaseUrl:string|null, migrations:object|null, initializedAt:string|null}} */
let state = {
  mode: 'memory',
  durable: false,
  configured: false,
  reason: 'not initialized yet',
  error: null,
  databaseUrl: null,
  migrations: null,
  initializedAt: null
};

/**
 * The live repository set. Bound to ONE implementation for the life of the
 * process. Before init() it points at memory so a module that imports it at load
 * time gets a working object rather than undefined; init() rebinds it once.
 */
export let repos = memory;

let initPromise = null;

/**
 * Choose the backend. Idempotent — the first call wins and later ones return the
 * same result, so a second caller cannot swap the store out from under the first.
 *
 * @param {{logger?: {log:Function, warn:Function}|null}} [opts]
 */
export function initBackend({ logger = console } = {}) {
  initPromise ??= (async () => {
    const configured = isDatabaseConfigured();

    if (!configured) {
      repos = memory;
      state = {
        mode: 'memory',
        durable: false,
        configured: false,
        reason:
          'DATABASE_URL is not set. Running in NON-DURABLE memory mode: the silence clock ' +
          'restarts from zero on every process restart, so "hours silent" is time since THIS ' +
          'process booted, not time since the last observation. Set DATABASE_URL to fix.',
        error: null,
        databaseUrl: null,
        migrations: null,
        initializedAt: new Date().toISOString()
      };
      logger?.warn?.(`[signal-zero:db] ${state.reason}`);
      return state;
    }

    try {
      const migrations = await migrate({ logger: null });
      repos = sql;
      state = {
        mode: 'postgres',
        durable: true,
        configured: true,
        reason: 'Postgres connected and migrated. Observations persist across restarts.',
        error: null,
        databaseUrl: redactUrl(String(process.env.DATABASE_URL ?? '')),
        migrations: {
          applied: migrations.applied ?? [],
          adopted: migrations.adopted ?? [],
          skipped: migrations.skipped ?? []
        },
        initializedAt: new Date().toISOString()
      };
      logger?.log?.(`[signal-zero:db] postgres ${state.databaseUrl} — durable`);
      return state;
    } catch (err) {
      // Configured but unusable. Serve, but never claim durability we do not have.
      repos = memory;
      state = {
        mode: 'memory',
        durable: false,
        configured: true,
        reason:
          'DATABASE_URL is set but the database could not be used, so this process fell back ' +
          'to NON-DURABLE memory mode. The silence clock will reset on restart. This is NOT ' +
          'the same as having no database configured — the configuration is there and failing.',
        error: err instanceof DatabaseUnavailableError ? err.message : String(err?.message ?? err),
        databaseUrl: redactUrl(String(process.env.DATABASE_URL ?? '')),
        migrations: null,
        initializedAt: new Date().toISOString()
      };
      logger?.warn?.(`[signal-zero:db] ${state.reason}\n[signal-zero:db] cause: ${state.error}`);
      return state;
    }
  })();
  return initPromise;
}

/** What mode are we in? Safe to call before init() — says so rather than guessing. */
export function persistence() {
  return { ...state };
}

/**
 * One line an operator can read on the banner or in a log.
 * Deliberately blunt in memory mode: an understated warning here is how a demo
 * ends up claiming a silence figure it cannot support.
 */
export function persistenceBanner() {
  const s = state;
  if (s.mode === 'postgres') return `persistence: postgres (durable) ${s.databaseUrl}`;
  if (s.configured) {
    return `persistence: MEMORY — NOT DURABLE. DATABASE_URL is set but unusable: ${s.error}`;
  }
  return 'persistence: MEMORY — NOT DURABLE. DATABASE_URL is not set; silence resets on restart.';
}

/** Test seam: forget the decision so a test can init() a different mode. */
export function resetBackendForTests() {
  initPromise = null;
  repos = memory;
  memory.reset();
  state = {
    mode: 'memory',
    durable: false,
    configured: false,
    reason: 'not initialized yet',
    error: null,
    databaseUrl: null,
    migrations: null,
    initializedAt: null
  };
}

// `repos` is deliberately NOT on the default export: a default object would
// snapshot whichever implementation was bound at module-eval time and go stale
// the moment init() rebinds. Import the named binding — ESM live bindings track
// the rebind, a copied property does not.
export default { initBackend, persistence, persistenceBanner, resetBackendForTests };
