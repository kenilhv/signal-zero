// Signal Zero — clusters repository (dedup output).
//
// Derived per run, so REPLACE-for-run like reports. Shape returned is exactly
// what src/pipeline/dedup.js emits and src/store.js holds in `clusters`:
//   { id, settlementId, reportIds, confidence, sourceTypeDiversity }
//
// `size` in the table is the member count; it is stored so a count query does
// not have to unpack JSONB, and derived from reportIds on write so the two can
// never disagree. It is deliberately NOT part of the returned object: the
// in-memory cluster has no `size` key, and adding one here would make the
// cutover a shape change rather than a swap.
//
// `confidence` is NULLable in the schema and NULL is preserved. dedup gives a
// singleton 0.5 ("uncorroborated") rather than 1.0, and 0.5 is a computed value,
// not a stand-in — so a NULL arriving here means something upstream declined to
// score, which is worth keeping distinguishable.

import { db as defaultDb } from '../pool.js';
import { asJsonParam, toCount, toJson, toNum } from '../values.js';

const COLUMNS = `cluster_id, run_id, settlement_id, size, confidence, member_ids,
                 source_type_diversity`;

export function rowToCluster(row) {
  return {
    id: row.cluster_id,
    settlementId: row.settlement_id ?? null,
    reportIds: toJson(row.member_ids, []),
    confidence: toNum(row.confidence),
    sourceTypeDiversity: toCount(row.source_type_diversity)
  };
}

/**
 * Write the cluster set for one run.
 * @param {string} runId
 * @param {Array<object>} clusters
 */
export async function replaceForRun(runId, clusters, db = defaultDb) {
  const id = String(runId);
  await db.query('DELETE FROM clusters WHERE run_id = $1', [id]);
  const list = Array.isArray(clusters) ? clusters : [];
  if (list.length === 0) return [];

  const payload = list.map((c) => {
    const memberIds = Array.isArray(c.reportIds) ? c.reportIds : [];
    return {
      cluster_id: String(c.id),
      settlement_id: c.settlementId ?? null,
      size: memberIds.length,
      confidence: c.confidence === null || c.confidence === undefined ? null : Number(c.confidence),
      member_ids: memberIds,
      source_type_diversity: Number(c.sourceTypeDiversity ?? 0)
    };
  });

  const { rows } = await db.query(
    `INSERT INTO clusters (${COLUMNS})
     SELECT c.cluster_id, $2, c.settlement_id, c.size, c.confidence, c.member_ids,
            c.source_type_diversity
     FROM jsonb_to_recordset($1::jsonb) AS c(
       cluster_id text, settlement_id text, size int, confidence float8,
       member_ids jsonb, source_type_diversity int)
     ON CONFLICT (run_id, cluster_id) DO UPDATE SET
       settlement_id         = EXCLUDED.settlement_id,
       size                  = EXCLUDED.size,
       confidence            = EXCLUDED.confidence,
       member_ids            = EXCLUDED.member_ids,
       source_type_diversity = EXCLUDED.source_type_diversity
     RETURNING ${COLUMNS}`,
    [asJsonParam(payload), id]
  );
  return rows.map(rowToCluster);
}

export async function listForRun(runId, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM clusters WHERE run_id = $1 ORDER BY cluster_id`,
    [String(runId)]
  );
  return rows.map(rowToCluster);
}

export async function getById(runId, clusterId, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM clusters WHERE run_id = $1 AND cluster_id = $2`,
    [String(runId), String(clusterId)]
  );
  return rows.length ? rowToCluster(rows[0]) : null;
}

/** Clusters that resolved to a settlement, or that contain one of its reports. */
export async function listForSettlement(runId, settlementId, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT DISTINCT ${COLUMNS}
       FROM clusters c
      WHERE c.run_id = $1
        AND (c.settlement_id = $2
             OR EXISTS (SELECT 1 FROM reports r
                         WHERE r.run_id = c.run_id
                           AND r.settlement_id = $2
                           AND r.cluster_id = c.cluster_id))
      ORDER BY cluster_id`,
    [String(runId), String(settlementId)]
  );
  return rows.map(rowToCluster);
}

export default { rowToCluster, replaceForRun, listForRun, getById, listForSettlement };
