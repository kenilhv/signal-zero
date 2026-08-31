// Signal Zero — reports repository.
//
// Derived per run and safe to recompute, so the write path is REPLACE-for-run
// rather than upsert-and-hope. Shape returned is exactly the Report the pipeline
// passes around (src/pipeline/ingest.js buildReport):
//   { id, sourceType, sourceName, url, title, text, publishedAt, fetchedAt,
//     settlementId, triage, clusterId }
//
// `publishedAt` is NULLable and stays NULL. docs/brightdata-serp-shape.md
// documents the trap: an unparseable relative date ("2 days ago") stamped with
// the fetch time is a wrong timestamp, and a wrong timestamp is a wrong silence
// score. Note that ingest itself currently defaults publishedAt to fetchedAt
// before it ever reaches this layer; this repository does not add a second
// default on top, so if that upstream default is ever removed the NULL survives
// all the way to the API.

import { db as defaultDb } from '../pool.js';
import { asJsonParam, toIso, toJson } from '../values.js';

const COLUMNS = `report_id, run_id, settlement_id, source_name, source_type, url, title,
                 text, published_at, fetched_at, triage, cluster_id`;

export function rowToReport(row) {
  return {
    id: row.report_id,
    sourceType: row.source_type ?? null,
    sourceName: row.source_name ?? null,
    url: row.url ?? null,
    title: row.title ?? null,
    text: row.text ?? null,
    publishedAt: toIso(row.published_at),
    fetchedAt: toIso(row.fetched_at),
    settlementId: row.settlement_id ?? null,
    triage: toJson(row.triage, null),
    clusterId: row.cluster_id ?? null
  };
}

/**
 * Write the report set for one run. Deletes this run's rows first so a re-run
 * that produced fewer reports does not leave the extras behind pretending to be
 * current. Caller should wrap in withTransaction when atomicity matters.
 * @param {string} runId
 * @param {Array<object>} reports
 */
export async function replaceForRun(runId, reports, db = defaultDb) {
  const id = String(runId);
  await db.query('DELETE FROM reports WHERE run_id = $1', [id]);
  const list = Array.isArray(reports) ? reports : [];
  if (list.length === 0) return [];

  const payload = list.map((r) => ({
    report_id: String(r.id),
    settlement_id: r.settlementId ?? null,
    source_name: r.sourceName ?? null,
    source_type: r.sourceType ?? null,
    url: r.url ?? null,
    title: r.title ?? null,
    text: r.text ?? null,
    published_at: toIso(r.publishedAt),
    fetched_at: toIso(r.fetchedAt),
    triage: r.triage ?? null,
    cluster_id: r.clusterId ?? null
  }));

  const { rows } = await db.query(
    `INSERT INTO reports (${COLUMNS})
     SELECT r.report_id, $2, r.settlement_id, r.source_name, r.source_type, r.url, r.title,
            r.text, r.published_at, r.fetched_at, r.triage, r.cluster_id
     FROM jsonb_to_recordset($1::jsonb) AS r(
       report_id text, settlement_id text, source_name text, source_type text, url text,
       title text, text text, published_at timestamptz, fetched_at timestamptz,
       triage jsonb, cluster_id text)
     ON CONFLICT (run_id, report_id) DO UPDATE SET
       settlement_id = EXCLUDED.settlement_id,
       triage        = EXCLUDED.triage,
       cluster_id    = EXCLUDED.cluster_id
     RETURNING ${COLUMNS}`,
    [asJsonParam(payload), id]
  );
  return rows.map(rowToReport);
}

export async function listForRun(runId, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM reports WHERE run_id = $1 ORDER BY report_id`,
    [String(runId)]
  );
  return rows.map(rowToReport);
}

export async function listForSettlement(runId, settlementId, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM reports
      WHERE run_id = $1 AND settlement_id = $2
      ORDER BY report_id`,
    [String(runId), String(settlementId)]
  );
  return rows.map(rowToReport);
}

export async function getById(runId, reportId, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM reports WHERE run_id = $1 AND report_id = $2`,
    [String(runId), String(reportId)]
  );
  return rows.length ? rowToReport(rows[0]) : null;
}

export async function countForRun(runId, db = defaultDb) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM reports WHERE run_id = $1', [
    String(runId)
  ]);
  return rows[0].n;
}

export default {
  rowToReport,
  replaceForRun,
  listForRun,
  listForSettlement,
  getById,
  countForRun
};
