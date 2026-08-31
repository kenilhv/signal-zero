// Signal Zero — the store facade.
//
// =========================================================================
// WHY THIS FILE STILL EXISTS AFTER THE POSTGRES CUTOVER
// =========================================================================
//
// Deleting it was on the table. Roughly forty call sites across four pipeline
// stages and the guardrails import `store` or `addIncident`, and most of them
// are SYNCHRONOUS functions in the middle of hot loops — src/guardrails/index.js
// blockAndRecord() returns the incident it just wrote, src/pipeline/rank.js
// raises cold-start incidents from inside a pure scoring pass. Making every one
// of those async to reach a database would have turned a persistence change into
// a rewrite of the scoring code, which is where the actual product risk lives.
// So the facade stays, and it is a facade over the repositories rather than a
// store in its own right.
//
// -------------------------------------------------------------------------
// THE THING THIS IS NOT: A SHADOW COPY
// -------------------------------------------------------------------------
// The tempting version of this file keeps the old arrays, writes to Postgres on
// the side, and serves reads from memory. That is the exact failure to avoid:
// two stores, one of which is authoritative and neither of which says which. It
// diverges silently, and a diverged silence clock is indistinguishable from a
// correct one until someone checks by hand.
//
// So the arrays below are scoped to a role that cannot diverge, and it is a role
// with a name:
//
//   `store` IS THE WORKING SET FOR THE PIPELINE PASS CURRENTLY IN FLIGHT.
//
// Ingest fills `reports`; triage annotates them; dedup reads them and fills
// `clusters`; rank reads both. That hand-off is what the arrays are for. They
// live exactly as long as one pass, they are overwritten at the start of the
// next one, and NOTHING SERVES A READ FROM THEM. GET /api/state, GET
// /api/settlement/:id, GET /api/incidents and the checkpoint routes all read
// through `repos`. If this file's arrays were wiped mid-flight the API would
// return the same bytes.
//
// The one exception is `sources` and `harness`: per-pass connector health and
// TrueForge telemetry. Those have no table because they are not facts about the
// world, they are facts about THIS PROCESS'S LAST PASS — a connector marked
// 'live' by a process that has since died is not evidence of anything. They are
// in-memory on purpose, they are null before the first pass rather than
// zero-filled, and the durable half (the counts) is copied into runs.stats so a
// restart can still say what the last completed pass did.
//
// -------------------------------------------------------------------------
// addIncident: SYNCHRONOUS RETURN, DURABLE WRITE
// -------------------------------------------------------------------------
// The signature could not change (see above), so the event object is minted and
// returned synchronously while the durable write is queued. `store.incidents` is
// therefore an OUTBOX, not the feed: it holds events written by this process
// that have not been confirmed durable yet, and entries drop out of it once they
// are. An entry whose write FAILED stays in the outbox with `persisted: false`
// and is reported by GET /api/state as `unpersistedIncidents`, because an
// incident feed that loses incidents is the one failure this feed may not have.
//
// There is no MAX_INCIDENTS. The 200-item ring buffer this replaces silently
// discarded the 201st failure on the one surface whose entire job is making
// failure visible. The feed is unbounded and the READ is paged instead.

import { initBackend, persistence, persistenceBanner, repos } from './db/backend.js';

export { initBackend, persistence, persistenceBanner, repos };

/**
 * THE WORKING SET FOR THE PASS IN FLIGHT. Not a cache of the database, and not
 * read by any HTTP route. See the header.
 */
export const store = {
  /** Gazetteer for this pass, loaded from the settlements table at pass start. */
  settlements: [],
  /** Stage hand-off: ingest -> triage -> dedup -> rank. */
  reports: [],
  clusters: [],
  ranked: [],
  /** Outbox. See the header — this is not the incident feed. */
  incidents: [],
  /** Per-pass connector health. No table: see the header. */
  sources: {},
  /**
   * TrueForge agent-harness telemetry for the last pass, written by triage tier
   * 3 and read verbatim by GET /api/state. Counters here are the ONLY thing the
   * UI may use to claim a classification was executed by the harness rather than
   * by the fallback. null before the first pass — "no run yet" is not "zero".
   */
  harness: null,
  /** Last pass's summary. Persisted into runs.stats; this copy is the live one. */
  stats: {}
};

/** Reset the per-pass hand-off state. Called at the top of every pipeline pass. */
export function beginPass() {
  store.reports = [];
  store.clusters = [];
  store.ranked = [];
  store.sources = {};
}

// ---------------------------------------------------------------------------
// Incident outbox
// ---------------------------------------------------------------------------

/** Writes in flight, plus any that failed. Awaited by flushIncidents(). */
const pending = new Set();
let unpersisted = 0;
/** Run id stamped onto incidents raised during a pass, so the feed can filter. */
let currentRunId = null;

export function setCurrentRunId(runId) {
  currentRunId = runId ?? null;
}

let seq = 0;

function mintId() {
  // Includes the pid so two processes writing the same table cannot collide on
  // the primary key — the in-memory version's bare counter could.
  return `inc-${Date.now().toString(36)}-${process.pid.toString(36)}-${(seq++).toString(36)}`;
}

/**
 * Push an IncidentEvent onto the fail feed and return it SYNCHRONOUSLY.
 *
 * kind: 'degraded-source' | 'llm-fallback' | 'cold-start' | 'heal' | 'agent-refusal'
 *
 * The returned object is the same shape callers have always mutated
 * (`incident.detail.checkpointItem = ...` in server.js), so it is the object
 * that gets written — the durable row is built from it, not from a copy taken
 * beforehand, and the write is scheduled on a microtask so a caller that
 * decorates `detail` immediately still has that decoration persisted.
 *
 * @returns {{id:string, at:string, kind:string, message:string, detail:object}}
 */
export function addIncident(kind, message, detail = {}) {
  const event = {
    id: mintId(),
    at: new Date().toISOString(),
    kind,
    message,
    detail
  };
  // Newest first, matching the order the old array kept.
  store.incidents.unshift(event);

  const write = Promise.resolve()
    .then(() =>
      repos.incidents.append(event.kind, event.message, event.detail, {
        id: event.id,
        at: event.at,
        runId: currentRunId
      })
    )
    .then(() => {
      // Confirmed durable: it belongs to the feed now, not to the outbox.
      const i = store.incidents.indexOf(event);
      if (i >= 0) store.incidents.splice(i, 1);
    })
    .catch((err) => {
      // A LOST INCIDENT IS THE ONE FAILURE THIS FEED MAY NOT HAVE. It stays in
      // the outbox, it is counted, and GET /api/state reports the count. It is
      // NOT retried in a loop: if the database is down, a retry storm from the
      // failure path makes the outage worse, and the honest state ("we could not
      // record N failures") is what the operator needs either way.
      event.persisted = false;
      event.persistError = String(err?.message ?? err);
      unpersisted += 1;
      console.error(`[signal-zero] incident not persisted (${event.id}): ${event.persistError}`);
    })
    .finally(() => {
      pending.delete(write);
    });

  pending.add(write);
  return event;
}

/**
 * Wait for every queued incident write to settle.
 *
 * Called at the end of a pipeline pass and before any route that has just
 * written an incident returns, so a client that POSTs a demo failure and then
 * GETs the feed cannot observe the gap. Never throws: a failed write is already
 * accounted for above, and making the flush throw would let a database blip take
 * down a request that otherwise succeeded.
 */
export async function flushIncidents() {
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * The FEED — the incidents table, newest first, flushed first so a caller cannot
 * read past a write this process just made. This is what a test asserting "the
 * block appears on the fail feed" should read; `store.incidents` is the outbox
 * and will be empty once the write lands.
 */
export async function recentIncidents(opts = {}) {
  await flushIncidents();
  const page = await repos.incidents.list({ limit: 200, ...opts });
  return page.items;
}

/** How many incidents this process minted but could not persist. */
export function unpersistedIncidentCount() {
  return unpersisted;
}

/**
 * The outbox contents: events this process wrote that are not confirmed durable.
 * Exposed for tests and for the API's honesty field. Reading the FEED is
 * `repos.incidents.list(...)`, which is a different thing and deliberately so.
 */
export function outbox() {
  return store.incidents.slice();
}

export default store;
