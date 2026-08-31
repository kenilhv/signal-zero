// Signal Zero — runs repository. One row per pipeline pass.
//
// `finished_at`, `duration_ms` and `error` are NULL while a run is in flight and
// STAY NULL if the process dies mid-pass. A crashed run is honestly a run with
// no finish time, not a run that finished at the moment we noticed.
//
// `latestStats()` returns the object src/store.js keeps in `stats`, so the
// cutover of GET /api/state is a swap.

import { db as defaultDb } from '../pool.js';
import { asJsonParam, toIso, toJson, toNum } from '../values.js';

const COLUMNS = `run_id, started_at, finished_at, duration_ms, status, error, stats`;

export function rowToRun(row) {
  return {
    runId: row.run_id,
    startedAt: toIso(row.started_at),
    // Null while running, and null forever for a run that never finished.
    finishedAt: toIso(row.finished_at),
    durationMs: toNum(row.duration_ms),
    status: row.status,
    error: row.error ?? null,
    stats: toJson(row.stats, {})
  };
}

/** Open a run. Idempotent on run_id so a retried boot does not duplicate it. */
export async function start(runId, db = defaultDb) {
  const { rows } = await db.query(
    `INSERT INTO runs (run_id, status) VALUES ($1, 'running')
     ON CONFLICT (run_id) DO UPDATE SET status = 'running'
     RETURNING ${COLUMNS}`,
    [String(runId)]
  );
  return rowToRun(rows[0]);
}

/**
 * Close a run as done.
 * durationMs is passed in rather than computed as now() - started_at: the
 * pipeline already measures its own wall clock and two clocks disagreeing is a
 * bug waiting to be argued about.
 */
export async function finish(runId, { durationMs = null, stats = {} } = {}, db = defaultDb) {
  const { rows } = await db.query(
    `UPDATE runs
        SET status = 'done', finished_at = now(), duration_ms = $2, stats = $3::jsonb
      WHERE run_id = $1
      RETURNING ${COLUMNS}`,
    [String(runId), durationMs === null ? null : Math.trunc(Number(durationMs)), asJsonParam(stats)]
  );
  return rows.length ? rowToRun(rows[0]) : null;
}

/** Close a run as failed. The message is kept verbatim; the fail feed is the product. */
export async function fail(runId, error, { durationMs = null, stats = {} } = {}, db = defaultDb) {
  const { rows } = await db.query(
    `UPDATE runs
        SET status = 'error', finished_at = now(), duration_ms = $2,
            error = $3, stats = $4::jsonb
      WHERE run_id = $1
      RETURNING ${COLUMNS}`,
    [
      String(runId),
      durationMs === null ? null : Math.trunc(Number(durationMs)),
      error === null || error === undefined ? null : String(error?.message ?? error),
      asJsonParam(stats)
    ]
  );
  return rows.length ? rowToRun(rows[0]) : null;
}

export async function getById(runId, db = defaultDb) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM runs WHERE run_id = $1`, [String(runId)]);
  return rows.length ? rowToRun(rows[0]) : null;
}

/** Most recent run by start time, whatever its status. null when none exist. */
export async function latest(db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1`
  );
  return rows.length ? rowToRun(rows[0]) : null;
}

/** Most recent COMPLETED run. null when no pass has ever finished. */
export async function latestCompleted(db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM runs
      WHERE status = 'done' AND finished_at IS NOT NULL
      ORDER BY finished_at DESC, run_id DESC LIMIT 1`
  );
  return rows.length ? rowToRun(rows[0]) : null;
}

export async function list({ limit = 50 } = {}, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM runs ORDER BY started_at DESC, run_id DESC LIMIT $1`,
    [Math.max(1, Math.min(1000, Number(limit) || 50))]
  );
  return rows.map(rowToRun);
}

/**
 * The object src/store.js holds in `stats`, rebuilt from the last completed run.
 *
 * Returns `{}` when no pass has ever finished — NOT a zero-filled object.
 * `lastRunAt: null` inside a populated stats object means "the pass finished but
 * we do not know when", which is a different and much worse claim than "no pass
 * has run", so the two cases stay distinguishable.
 */
export async function latestStats(db = defaultDb) {
  const run = await latestCompleted(db);
  if (!run) return {};
  return { ...run.stats, lastRunAt: run.finishedAt, durationMs: run.durationMs };
}

export default {
  rowToRun,
  start,
  finish,
  fail,
  getById,
  latest,
  latestCompleted,
  list,
  latestStats
};
