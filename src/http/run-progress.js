// Signal Zero — progress of the pipeline pass THIS PROCESS is running.
//
// ---------------------------------------------------------------------------
// WHY THE RUN WENT ASYNCHRONOUS
// ---------------------------------------------------------------------------
// A pass takes roughly 45 seconds (ingest makes one upstream call per settlement;
// tier-3 triage makes real model calls). A unit of work that long does not belong
// inside an HTTP request: the connection is held open across a window in which
// the client's timeout, an intermediary's idle timeout and a deploy can all fire,
// and the caller learns nothing until it finishes or does not.
//
// So POST /api/run answers 202 Accepted with a run id, and the pass proceeds. The
// caller reads progress from GET /api/state, which the frontend already polls.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS ALLOWED TO CLAIM, AND WHAT IT IS NOT — HARD RULE 4
// ---------------------------------------------------------------------------
// This is a fact about THIS PROCESS'S in-flight pass. It has no table, for the
// same reason src/store.js keeps `sources` and `harness` in memory: a run marked
// 'running' by a process that has since died is not evidence of anything.
//
// Two consequences are written into the API rather than left to be inferred:
//
//   * `snapshot()` returns NULL before this process has started a pass. Null here
//     means "this process has not run one", which is NOT "no pass has ever run" —
//     that question is answered by `stats.lastRunAt`, which is read from the runs
//     table and survives a restart. A freshly restarted process legitimately
//     reports `run: null` next to a populated `stats.lastRunAt`, and collapsing
//     those two into one field would make a restart look like a cold start.
//
//   * `stage` is set at the point each stage actually begins, by the orchestrator
//     itself. It is never interpolated, never predicted from elapsed time, and
//     never advanced by a timer. The frontend's stage rail used to say "the server
//     does not report per-stage progress" because that was true; it now names the
//     stage because the server reports it.
//
// The `runs` TABLE is still the durable record — src/server.js opens a row at the
// start of the pass and closes it at the end. This is the live view of the same
// pass, at a resolution the table does not keep.

/**
 * The pipeline's fixed order. `observe` and `persist` are real stages of the pass
 * (reports become append-only observations; derived projections are written) and
 * appear here because a pass that is 30 seconds into `observe` should not be
 * displayed as though it were still ranking.
 */
export const RUN_STAGES = Object.freeze([
  'ingest',
  'triage',
  'dedup',
  'observe',
  'rank',
  'checkpoint',
  'persist'
]);

/** @typedef {'running'|'done'|'error'} RunStatus */

/** The pass in flight, or null. */
let current = null;
/** The last pass this process finished, kept so `run` does not blink out at the end. */
let previous = null;

/**
 * Claim the single-flight slot.
 *
 * SYNCHRONOUS AND ATOMIC, which is the point: POST /api/run must be able to
 * decide between 202 and 409 before it returns, and two requests arriving in the
 * same tick must not both be told they started a pass. Node's single-threaded
 * turn semantics make the read-then-write below indivisible, so no lock is needed
 * — but it only holds while this function stays synchronous, so it does.
 *
 * @param {string} runId
 * @param {{trigger?:string}} [opts]
 * @returns {boolean} true when the caller now owns the pass; false when one is
 *   already in flight (read `inFlight()` for its id).
 */
export function beginRun(runId, { trigger = 'api' } = {}) {
  if (current) return false;
  current = {
    runId: String(runId),
    status: /** @type {RunStatus} */ ('running'),
    trigger,
    startedAt: new Date().toISOString(),
    stage: null,
    stagesCompleted: [],
    finishedAt: null,
    durationMs: null,
    error: null,
    stats: null
  };
  return true;
}

/**
 * Record that a stage has STARTED. Called by the orchestrator at the top of each
 * stage, so the value is observed rather than estimated.
 *
 * A stage name outside RUN_STAGES is ignored rather than stored: the rail is a
 * fixed set the frontend renders, and a typo silently becoming a phantom stage is
 * worse than a rail that does not move.
 */
export function markStage(stage) {
  if (!current) return;
  if (!RUN_STAGES.includes(stage)) return;
  if (
    current.stage &&
    current.stage !== stage &&
    !current.stagesCompleted.includes(current.stage)
  ) {
    current.stagesCompleted.push(current.stage);
  }
  current.stage = stage;
}

/** Close the pass as done, releasing the single-flight slot. */
export function completeRun({ durationMs = null, stats = null } = {}) {
  if (!current) return null;
  if (current.stage && !current.stagesCompleted.includes(current.stage)) {
    current.stagesCompleted.push(current.stage);
  }
  current.status = 'done';
  current.stage = null;
  current.finishedAt = new Date().toISOString();
  current.durationMs = durationMs === null ? null : Math.trunc(Number(durationMs));
  current.stats = stats;
  previous = current;
  current = null;
  return previous;
}

/**
 * Close the pass as failed.
 *
 * `stage` is left at whatever it was, NOT cleared: which stage the pass died in
 * is the most useful fact about a failed run, and blanking it to keep the shape
 * tidy would throw it away.
 */
export function failRun(err, { durationMs = null } = {}) {
  if (!current) return null;
  current.status = 'error';
  current.finishedAt = new Date().toISOString();
  current.durationMs = durationMs === null ? null : Math.trunc(Number(durationMs));
  current.error = String(err?.message ?? err ?? 'unknown error');
  previous = current;
  current = null;
  return previous;
}

/** The in-flight pass, or null. Used by the 409 to name the run already running. */
export function inFlight() {
  return current ? { ...current, stagesCompleted: current.stagesCompleted.slice() } : null;
}

/** Is a pass in flight right now? */
export function isRunning() {
  return current !== null;
}

/**
 * What GET /api/state publishes as `run`.
 *
 * Null before this process has started a pass — see the header. `elapsedMs` is
 * present only while running, because after the fact `durationMs` is the measured
 * number and two nearly-identical duration fields invite one of them to be quoted.
 */
export function snapshot() {
  const r = current ?? previous;
  if (!r) return null;
  const out = {
    runId: r.runId,
    status: r.status,
    trigger: r.trigger,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    // Null while running: no stage has been reported yet, or the pass is between
    // stages. Never a guess.
    stage: r.stage,
    stagesCompleted: r.stagesCompleted.slice(),
    stages: RUN_STAGES.slice(),
    error: r.error
  };
  if (r.status === 'running') {
    out.elapsedMs = Date.now() - Date.parse(r.startedAt);
  }
  return out;
}

/** Test seam: forget everything this process observed. */
export function resetRunProgressForTests() {
  current = null;
  previous = null;
}

export default {
  RUN_STAGES,
  beginRun,
  completeRun,
  failRun,
  inFlight,
  isRunning,
  markStage,
  resetRunProgressForTests,
  snapshot
};
