// Signal Zero — ranked_snapshots repository.
//
// The ranking as computed at a point in time, kept per run so "why was this
// ranked 3rd an hour ago" stays answerable. Returns exactly the RankedSettlement
// object src/pipeline/rank.js builds and src/store.js holds in `ranked` — same
// keys, same order — so the cutover of GET /api/state is a swap.
//
// THE COLUMN NAME AND THE FIELD NAME DIFFER ON PURPOSE.
// The table calls it `last_observed_at`; the object calls it `lastReportAt`.
// That mapping happens here and only here, and it is a rename, never a fill:
//   last_observed_at IS NULL  ->  lastReportAt: null
// If anything ever writes COALESCE(last_observed_at, ...) it has to be in this
// file, in this module's SQL, where a reviewer looking for it will find it. It
// is not here. It is not anywhere.
//
// Every statistical column is NULLable and stays NULL: a settlement with no
// fitted rate has no surprisal, and that is a fact, not a zero.

import { db as defaultDb } from '../pool.js';
import { asJsonParam, toCount, toIso, toNum } from '../values.js';

const SELECT_SQL = `
  SELECT rs.run_id,
         rs.settlement_id,
         rs.rank,
         rs.last_observed_at,
         rs.silence_hours,
         rs.expected_gap_hours,
         rs.lambda_per_hour,
         rs.surprisal,
         rs.gi_z_score,
         rs.own_z_score,
         rs.neighbor_z_score,
         rs.neighbor_mean_surprisal,
         rs.neighbor_count,
         rs.report_count,
         rs.corroboration_count,
         rs.coverage_basis,
         rs.fit_basis,
         rs.cohort_key,
         rs.cohort_sample_gaps,
         rs.anomaly_type,
         rs.is_local_anomaly,
         rs.is_regional_outage,
         rs.is_solo_anomaly,
         rs.is_escalation_candidate,
         s.name,
         s.district,
         s.lat,
         s.lon,
         s.population,
         s.hazard_tier
    FROM ranked_snapshots rs
    JOIN settlements s ON s.settlement_id = rs.settlement_id`;

/** Key order mirrors src/pipeline/rank.js so a diff of two JSON payloads is empty. */
export function rowToRanked(row) {
  return {
    settlementId: row.settlement_id,
    name: row.name,
    district: row.district,
    lat: toNum(row.lat),
    lon: toNum(row.lon),
    population: toCount(row.population),
    hazardTier: toCount(row.hazard_tier),
    // NULL means NO REPORT HAS EVER RESOLVED HERE. Hard rule 4.
    lastReportAt: toIso(row.last_observed_at),
    silenceHours: toNum(row.silence_hours),
    expectedGapHours: toNum(row.expected_gap_hours),
    surprisal: toNum(row.surprisal),
    giZScore: toNum(row.gi_z_score),
    isLocalAnomaly: row.is_local_anomaly === true,
    coverageBasis: row.coverage_basis ?? null,
    rank: toCount(row.rank),
    corroborationCount: toCount(row.corroboration_count),
    cohortKey: row.cohort_key ?? null,
    lambdaPerHour: toNum(row.lambda_per_hour),
    fitBasis: row.fit_basis ?? null,
    cohortSampleGaps: toCount(row.cohort_sample_gaps),
    reportCount: toCount(row.report_count),
    ownZScore: toNum(row.own_z_score),
    neighborZScore: toNum(row.neighbor_z_score),
    neighborMeanSurprisal: toNum(row.neighbor_mean_surprisal),
    neighborCount: toCount(row.neighbor_count),
    isRegionalOutage: row.is_regional_outage === true,
    isSoloAnomaly: row.is_solo_anomaly === true,
    anomalyType: row.anomaly_type ?? null,
    isEscalationCandidate: row.is_escalation_candidate === true
  };
}

/**
 * Write the ranking for one run.
 *
 * `last_observed_at` is passed through toIso, which maps null to null and has no
 * fallback parameter. A row whose lastReportAt is null is written as SQL NULL.
 * @param {string} runId
 * @param {Array<object>} ranked
 */
export async function replaceForRun(runId, ranked, db = defaultDb) {
  const id = String(runId);
  await db.query('DELETE FROM ranked_snapshots WHERE run_id = $1', [id]);
  const list = Array.isArray(ranked) ? ranked : [];
  if (list.length === 0) return [];

  const payload = list.map((r, i) => ({
    settlement_id: String(r.settlementId),
    rank: Number(r.rank ?? i + 1),
    last_observed_at: toIso(r.lastReportAt),
    silence_hours: toNum(r.silenceHours),
    expected_gap_hours: toNum(r.expectedGapHours),
    lambda_per_hour: toNum(r.lambdaPerHour),
    surprisal: toNum(r.surprisal),
    gi_z_score: toNum(r.giZScore),
    own_z_score: toNum(r.ownZScore),
    neighbor_z_score: toNum(r.neighborZScore),
    neighbor_mean_surprisal: toNum(r.neighborMeanSurprisal),
    neighbor_count: toCount(r.neighborCount),
    report_count: toCount(r.reportCount),
    corroboration_count: toCount(r.corroborationCount),
    coverage_basis: r.coverageBasis ?? null,
    fit_basis: r.fitBasis ?? null,
    cohort_key: r.cohortKey ?? null,
    cohort_sample_gaps: toCount(r.cohortSampleGaps),
    anomaly_type: r.anomalyType ?? null,
    is_local_anomaly: r.isLocalAnomaly === true,
    is_regional_outage: r.isRegionalOutage === true,
    is_solo_anomaly: r.isSoloAnomaly === true,
    is_escalation_candidate: r.isEscalationCandidate === true
  }));

  await db.query(
    `INSERT INTO ranked_snapshots (
       run_id, settlement_id, rank, last_observed_at, silence_hours, expected_gap_hours,
       lambda_per_hour, surprisal, gi_z_score, own_z_score, neighbor_z_score,
       neighbor_mean_surprisal, neighbor_count, report_count, corroboration_count,
       coverage_basis, fit_basis, cohort_key, cohort_sample_gaps, anomaly_type,
       is_local_anomaly, is_regional_outage, is_solo_anomaly, is_escalation_candidate)
     SELECT $2, x.settlement_id, x.rank, x.last_observed_at, x.silence_hours,
            x.expected_gap_hours, x.lambda_per_hour, x.surprisal, x.gi_z_score,
            x.own_z_score, x.neighbor_z_score, x.neighbor_mean_surprisal, x.neighbor_count,
            x.report_count, x.corroboration_count, x.coverage_basis, x.fit_basis,
            x.cohort_key, x.cohort_sample_gaps, x.anomaly_type, x.is_local_anomaly,
            x.is_regional_outage, x.is_solo_anomaly, x.is_escalation_candidate
     FROM jsonb_to_recordset($1::jsonb) AS x(
       settlement_id text, rank int, last_observed_at timestamptz, silence_hours float8,
       expected_gap_hours float8, lambda_per_hour float8, surprisal float8, gi_z_score float8,
       own_z_score float8, neighbor_z_score float8, neighbor_mean_surprisal float8,
       neighbor_count int, report_count int, corroboration_count int, coverage_basis text,
       fit_basis text, cohort_key text, cohort_sample_gaps int, anomaly_type text,
       is_local_anomaly boolean, is_regional_outage boolean, is_solo_anomaly boolean,
       is_escalation_candidate boolean)`,
    [asJsonParam(payload), id]
  );
  return listForRun(id, db);
}

export async function listForRun(runId, db = defaultDb) {
  const { rows } = await db.query(`${SELECT_SQL} WHERE rs.run_id = $1 ORDER BY rs.rank`, [
    String(runId)
  ]);
  return rows.map(rowToRanked);
}

export async function getForRun(runId, settlementId, db = defaultDb) {
  const { rows } = await db.query(`${SELECT_SQL} WHERE rs.run_id = $1 AND rs.settlement_id = $2`, [
    String(runId),
    String(settlementId)
  ]);
  return rows.length ? rowToRanked(rows[0]) : null;
}

/**
 * The ranking from the most recent COMPLETED run. Empty array when no pass has
 * ever finished — not a fabricated ranking of every settlement at rank 0.
 */
export async function listLatest(db = defaultDb) {
  const { rows } = await db.query(
    `${SELECT_SQL}
      WHERE rs.run_id = (
        SELECT run_id FROM runs
         WHERE status = 'done' AND finished_at IS NOT NULL
         ORDER BY finished_at DESC, run_id DESC LIMIT 1)
      ORDER BY rs.rank`
  );
  return rows.map(rowToRanked);
}

export default { rowToRanked, replaceForRun, listForRun, getForRun, listLatest };
