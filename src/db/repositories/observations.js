// Signal Zero — observations repository. THE fact table.
//
// One row = one confirming observation that resolved to one settlement at one
// known instant. This table is the ONLY input to the silence clock, so:
//   - INSERT only. There is no update function and no delete function in this
//     module, because mutating history would retroactively change what the
//     system claimed to know.
//   - observed_at is required and is never guessed. requireIso throws rather
//     than substituting a fetch time; a report whose timestamp could not be
//     parsed gets no row and the settlement correctly stays silent.

import { db as defaultDb } from '../pool.js';
import { asJsonParam, requireIso, toIso, toNum } from '../values.js';

const COLUMNS = `observation_id, settlement_id, observed_at, source_name, source_type,
                 report_id, cluster_id, url, title, recorded_at`;

export function rowToObservation(row) {
  return {
    observationId: toNum(row.observation_id),
    settlementId: row.settlement_id,
    observedAt: toIso(row.observed_at),
    sourceName: row.source_name,
    sourceType: row.source_type,
    reportId: row.report_id ?? null,
    clusterId: row.cluster_id ?? null,
    url: row.url ?? null,
    title: row.title ?? null,
    recordedAt: toIso(row.recorded_at)
  };
}

/**
 * Append one observation.
 * @param {{settlementId:string, observedAt:string|Date, sourceName:string,
 *          sourceType:string, reportId?:string|null, clusterId?:string|null,
 *          url?:string|null, title?:string|null}} obs
 */
export async function append(obs, db = defaultDb) {
  const { rows } = await db.query(
    `INSERT INTO observations
       (settlement_id, observed_at, source_name, source_type, report_id, cluster_id, url, title)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      String(obs.settlementId),
      requireIso(obs.observedAt, 'observation.observedAt'),
      String(obs.sourceName ?? ''),
      String(obs.sourceType ?? ''),
      obs.reportId ?? null,
      obs.clusterId ?? null,
      obs.url ?? null,
      obs.title ?? null
    ]
  );
  return rowToObservation(rows[0]);
}

/**
 * Append a batch in one round trip. Every observed_at is validated in JS BEFORE
 * the statement is sent, so a batch containing one unparseable timestamp fails
 * without writing any of it — partial credit for a bad batch would leave the
 * silence clock half-advanced.
 * @param {Array<object>} list
 */
export async function appendMany(list, db = defaultDb) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) return [];
  const payload = items.map((o, i) => ({
    settlement_id: String(o.settlementId),
    observed_at: requireIso(o.observedAt, `observations[${i}].observedAt`),
    source_name: String(o.sourceName ?? ''),
    source_type: String(o.sourceType ?? ''),
    report_id: o.reportId ?? null,
    cluster_id: o.clusterId ?? null,
    url: o.url ?? null,
    title: o.title ?? null
  }));

  const { rows } = await db.query(
    `INSERT INTO observations
       (settlement_id, observed_at, source_name, source_type, report_id, cluster_id, url, title)
     SELECT o.settlement_id, o.observed_at, o.source_name, o.source_type,
            o.report_id, o.cluster_id, o.url, o.title
     FROM jsonb_to_recordset($1::jsonb) AS o(
       settlement_id text, observed_at timestamptz, source_name text, source_type text,
       report_id text, cluster_id text, url text, title text)
     RETURNING ${COLUMNS}`,
    [asJsonParam(payload)]
  );
  return rows.map(rowToObservation);
}

// ---------------------------------------------------------------------------
// LATEST OBSERVATION PER SETTLEMENT
// ---------------------------------------------------------------------------
// This is the read the whole product is built on, and its two properties are
// non-negotiable: every gazetteer settlement must appear, and a settlement with
// no observations must come back with lastObservedAt === null.
//
// WHY LEFT JOIN LATERAL ... LIMIT 1, and not the two obvious alternatives:
//
//   DISTINCT ON (settlement_id) ... ORDER BY settlement_id, observed_at DESC
//     Drives from `observations`, so a settlement with zero rows simply does not
//     appear in the result at all. You would have to LEFT JOIN settlements back
//     on anyway, and the "missing" case would then be reconstructed in JS —
//     which is precisely where a defensive `?? new Date()` gets added one day.
//     It also has to walk the whole index, not just its head.
//
//   GROUP BY settlement_id + max(observed_at)
//     Same absence problem, and it cannot carry the rest of the row (source,
//     url, title) without a second join back onto observations.
//
// The LATERAL form drives from `settlements` — a 32-row gazetteer — and does
// one probe per settlement into observations_settlement_time_idx
// (settlement_id, observed_at DESC). Because the index is already in that order,
// LIMIT 1 stops after the first tuple: no sort on observed_at, no aggregate,
// cost O(settlements x index descent) instead of O(observations).
//
// MEASURED, not assumed. Live database, 32 gazetteer settlements, 120,000
// observations (31 MB), 8 settlements with none:
//
//   Sort  (actual time=0.198..0.200 rows=32 loops=1)          <- 32 rows, outer ORDER BY
//     Sort Key: s.settlement_id
//     ->  Nested Loop Left Join  (actual time=0.019..0.167 rows=32 loops=1)
//           ->  Seq Scan on settlements s  (rows=32 loops=1)  <- 2 buffers
//           ->  Limit  (actual time=0.005..0.005 rows=1 loops=32)
//                 ->  Index Scan using observations_settlement_time_idx on observations obs
//                       Index Cond: (settlement_id = s.settlement_id)
//                       Buffers: shared hit=120
//   Execution Time: 0.227 ms
//
// 120 buffers for 32 probes — under 4 pages each — and 0.005 ms per probe. The
// DISTINCT ON alternative on the same data:
//
//   Unique  (actual time=0.051..16.328 rows=24 loops=1)
//     ->  Index Only Scan ... (rows=120000) Heap Fetches: 120000  Buffers: 3271
//   Execution Time: 16.372 ms
//
// 72x slower, 27x the buffers — and note `rows=24`, not 32. It silently omits
// the eight settlements nothing has ever resolved to, which are the exact rows
// this product exists to surface.
//
// src/db/observations.test.js re-asserts the shape of this plan on every run,
// so a regression fails a test instead of quietly costing a page scan.
//
// And the NULL: it falls out of LEFT JOIN semantics. No matching row means every
// observation column is NULL. Hard rule 4 is enforced by the join, not by a
// branch someone can forget to write.
const LATEST_PER_SETTLEMENT_SQL = `
  SELECT s.settlement_id,
         s.name,
         s.district,
         o.observation_id,
         o.observed_at,
         o.source_name,
         o.source_type,
         o.report_id,
         o.cluster_id,
         o.url,
         o.title,
         o.recorded_at
  FROM settlements s
  LEFT JOIN LATERAL (
    SELECT obs.observation_id, obs.observed_at, obs.source_name, obs.source_type,
           obs.report_id, obs.cluster_id, obs.url, obs.title, obs.recorded_at
    FROM observations obs
    WHERE obs.settlement_id = s.settlement_id
    ORDER BY obs.observed_at DESC
    LIMIT 1
  ) o ON true
  ORDER BY s.settlement_id`;

/** The exact SQL above, exposed so a test can EXPLAIN it rather than a paraphrase. */
export const latestPerSettlementSql = LATEST_PER_SETTLEMENT_SQL;

function rowToLatest(row) {
  return {
    settlementId: row.settlement_id,
    name: row.name,
    district: row.district,
    // NULL means NO REPORT HAS EVER RESOLVED HERE. Not 0, not now(), not epoch.
    lastObservedAt: toIso(row.observed_at),
    observationId: row.observation_id === null ? null : toNum(row.observation_id),
    sourceName: row.source_name ?? null,
    sourceType: row.source_type ?? null,
    reportId: row.report_id ?? null,
    clusterId: row.cluster_id ?? null,
    url: row.url ?? null,
    title: row.title ?? null,
    recordedAt: toIso(row.recorded_at)
  };
}

/**
 * One row per gazetteer settlement, newest observation attached.
 * `lastObservedAt` is null for a settlement nothing has ever resolved to.
 */
export async function latestPerSettlement(db = defaultDb) {
  const { rows } = await db.query(LATEST_PER_SETTLEMENT_SQL);
  return rows.map(rowToLatest);
}

/** Same query narrowed to one settlement. null when the settlement is unknown. */
export async function latestForSettlement(settlementId, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT * FROM (${LATEST_PER_SETTLEMENT_SQL}) q WHERE q.settlement_id = $1`,
    [String(settlementId)]
  );
  return rows.length ? rowToLatest(rows[0]) : null;
}

/**
 * Observation history for one settlement, newest first. Used by the baseline
 * fit in src/pipeline/rank.js, which needs the inter-arrival gaps rather than
 * just the head of the list.
 */
export async function listForSettlement(settlementId, { limit = 500 } = {}, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM observations
     WHERE settlement_id = $1
     ORDER BY observed_at DESC, observation_id DESC
     LIMIT $2`,
    [String(settlementId), Math.max(1, Math.min(10_000, Number(limit) || 500))]
  );
  return rows.map(rowToObservation);
}

/**
 * Every observation, OLDEST FIRST, across every settlement.
 *
 * This is what the baseline fit in src/pipeline/rank.js consumes: it needs the
 * inter-arrival gaps for the whole corridor, not just the head of each list, and
 * it needs them in chronological order to difference them.
 *
 * `limit` is a read bound, not a retention policy — nothing is deleted, and the
 * caller is told (via the row count) when it hit the ceiling. Ordered
 * (observed_at, observation_id) so two observations sharing a timestamp still
 * come back in a stable, insertion-ordered sequence rather than an arbitrary one.
 */
export async function listAll({ limit = 100_000 } = {}, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM observations
     ORDER BY observed_at ASC, observation_id ASC
     LIMIT $1`,
    [Math.max(1, Math.min(1_000_000, Number(limit) || 100_000))]
  );
  return rows.map(rowToObservation);
}

export async function count(db = defaultDb) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM observations');
  return rows[0].n;
}

export default {
  rowToObservation,
  append,
  appendMany,
  latestPerSettlement,
  latestForSettlement,
  latestPerSettlementSql,
  listForSettlement,
  listAll,
  count
};
