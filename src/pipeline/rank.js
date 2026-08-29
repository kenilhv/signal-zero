// Signal Zero - STAGE 4: RANK
// ---------------------------------------------------------------------------
// Ranks settlements by how ANOMALOUSLY SILENT they are, not by report volume.
//
// ZERO LLM IN THIS FILE. Every number below traces to one explicit closed-form
// formula, and the same inputs always produce the same outputs. The only LLM
// touchpoint in the whole system is triage tier 3.
//
// Two real, named methods are used here:
//
//   STEP A - Exponential Time-Between-Events (TBE) modelling, a.k.a. the
//            "t-chart" / "time-between-events control chart" from reliability
//            engineering (Nelson 1994; Xie, Goh & Ranjan 2002). This is the
//            correct distribution family for "how long since the last event"
//            data: for a homogeneous Poisson arrival process the inter-arrival
//            gaps are Exponential(lambda), and the closed-form MLE of the rate
//            is simply lambda_hat = n / sum(gaps).
//
//   STEP B - Getis-Ord Gi* local spatial statistic (Getis & Ord 1992; Ord &
//            Getis 1995). Gi* (star) INCLUDES the focal unit in its own
//            neighbourhood, unlike plain Gi. We run it over the river-corridor
//            adjacency graph with the surprisal from Step A as the attribute,
//            so a "hot spot" in surprisal space is a COLD spot in reporting
//            space: a contiguous stretch of the corridor that has gone quiet.
//
// NOTE ON WEIGHTING: population and hazardTier deliberately do NOT appear as
// multiplied-on importance weights. They only select the COHORT whose expected
// reporting rate we fit. A big town on the flood corridor is expected to be
// noisy, so 6 hours of silence there is genuinely more surprising than 6 hours
// from a tier-1 hamlet - and that shows up honestly in lambda, not as a fudge
// factor bolted onto the score. Ranking is a likelihood statement, not a
// priority opinion.
//
// NOTE ON OUTPUT: nothing in here emits a dispatch instruction. The output is a
// sorted candidate list of places we have not heard from. Who goes where is a
// human decision made downstream at the checkpoint stage.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addIncident } from '../store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORRIDOR_PATH = path.join(HERE, '..', 'data', 'corridor.json');

/** River-corridor adjacency graph. Missing file degrades to "no neighbours". */
let DEFAULT_ADJACENCY = {};
try {
  DEFAULT_ADJACENCY = JSON.parse(readFileSync(CORRIDOR_PATH, 'utf8'));
} catch {
  DEFAULT_ADJACENCY = {};
}

// --- tunables, all documented -----------------------------------------------

/** Documented prior when we have literally no observed gaps anywhere. 12h is
 *  the rough daily news/relief-report cadence for a Nepali district in a
 *  declared emergency: roughly two situation updates per day. */
export const PRIOR_EXPECTED_GAP_HOURS = 12;

/** A cohort needs at least this many observed gaps before we trust its own MLE
 *  rather than borrowing the global one. Below ~3 the exponential MLE is wildly
 *  unstable (its relative standard error is 1/sqrt(n)). */
export const MIN_COHORT_GAPS = 3;

/** Gaps are clamped to at least one minute so a duplicate timestamp cannot
 *  drive sum(gaps) to zero and make lambda infinite. */
const MIN_GAP_HOURS = 1 / 60;

/** Two-sided 95% normal critical value. Standard Gi* significance threshold. */
export const Z_CRITICAL = 1.96;

/** Do not spam the fail feed: only the first few cold starts are logged. */
const MAX_COLD_START_INCIDENTS = 3;

const HOUR_MS = 3600 * 1000;
const EPS = 1e-12;

// --- small helpers ----------------------------------------------------------

function round(x, dp = 4) {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** A report's event time: publishedAt is the truth, fetchedAt is the backstop. */
function reportTimeMs(report) {
  return toMillis(report?.publishedAt) ?? toMillis(report?.fetchedAt);
}

// --- STEP A helpers ---------------------------------------------------------

/**
 * Population bucket used in the cohort key.
 * <5k hamlet | 5k-20k small town | >20k municipality.
 */
export function populationBucket(population) {
  const p = Number(population) || 0;
  if (p < 5000) return 'p<5k';
  if (p <= 20000) return 'p5-20k';
  return 'p>20k';
}

/**
 * Cohort key = hazardTier + population bucket. Settlements in the same cohort
 * are assumed to share a baseline reporting rate.
 */
export function cohortKeyFor(settlement) {
  const tier = Number(settlement?.hazardTier) || 1;
  return `t${tier}|${populationBucket(settlement?.population)}`;
}

/**
 * Closed-form MLE for the Exponential rate parameter.
 *   f(t) = lambda * exp(-lambda * t)
 *   log-likelihood  L = n*ln(lambda) - lambda*sum(t)
 *   dL/dlambda = 0  =>  lambda_hat = n / sum(t)
 * Returns null when there is nothing to fit.
 */
export function fitExponentialRate(gaps) {
  const clean = [];
  for (const g of gaps || []) {
    // strictly numeric: null/''/booleans must not silently coerce to a 0h gap
    const v = typeof g === 'number' ? g : Number.NaN;
    if (!Number.isFinite(v) || v < 0) continue;
    clean.push(Math.max(v, MIN_GAP_HOURS));
  }
  if (clean.length === 0) return null;
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= EPS) return null;
  return clean.length / total; // lambda_hat = n / sum(gaps)
}

/**
 * Surprisal (self-information) of having waited `silenceHours` with no report.
 * For Exp(lambda): P(gap >= t) = exp(-lambda * t)
 *   =>  -ln P(gap >= t) = lambda * t
 * Units are nats. 3.0 nats ~ a 1-in-20 wait; 4.6 nats ~ a 1-in-100 wait.
 */
export function surprisalFor(lambda, silenceHours) {
  return Math.max(0, lambda * Math.max(0, silenceHours));
}

// --- STEP B: Getis-Ord Gi* --------------------------------------------------

/**
 * Binary, row-standardized spatial weights INCLUDING the focal unit (that self
 * inclusion is exactly what makes this Gi* rather than Gi).
 * Each of the m = (degree + 1) members gets w_ij = 1/m.
 */
export function buildWeights(ids, adjacency) {
  const known = new Set(ids);
  const weights = new Map();
  for (const id of ids) {
    const raw = Array.isArray(adjacency?.[id]) ? adjacency[id] : [];
    const members = new Set([id]); // Gi* includes self
    for (const nb of raw) if (known.has(nb) && nb !== id) members.add(nb);
    const list = [...members];
    const w = 1 / list.length; // row-standardized
    weights.set(id, { members: list, w });
  }
  return weights;
}

/**
 * Getis-Ord Gi* z-scores over the adjacency graph.
 *
 *   Gi* = ( sum_j(w_ij*x_j) - Xbar*sum_j(w_ij) )
 *         / ( S * sqrt( ( n*sum_j(w_ij^2) - (sum_j w_ij)^2 ) / (n-1) ) )
 *   Xbar = mean(x)
 *   S    = sqrt( sum(x^2)/n - Xbar^2 )     (population standard deviation)
 *
 * Also returns, per unit:
 *   ownZ       = (x_i - Xbar)/S        - how extreme this settlement alone is
 *   neighborZ  = (mean_{j != i} x_j - Xbar)/S - how extreme its NEIGHBOURS are
 * Comparing the two separates a whole silent region (regional comms outage)
 * from one settlement standing out among reporting neighbours (true local
 * anomaly). Degenerate inputs (n < 2, or a perfectly uniform field where S = 0)
 * return 0 rather than NaN/Infinity - a flat field genuinely has no hot spots.
 */
export function getisOrdGiStar(ids, xById, adjacency) {
  const n = ids.length;
  const out = new Map();
  const x = ids.map((id) => Number(xById.get(id)) || 0);

  if (n === 0) return out;

  const sum = x.reduce((a, b) => a + b, 0);
  const sumSq = x.reduce((a, b) => a + b * b, 0);
  const xbar = sum / n;
  const variance = Math.max(0, sumSq / n - xbar * xbar);
  const S = Math.sqrt(variance);

  const weights = buildWeights(ids, adjacency);
  const valueOf = (id) => Number(xById.get(id)) || 0;

  for (const id of ids) {
    const { members, w } = weights.get(id);
    let sumW = 0;
    let sumW2 = 0;
    let sumWX = 0;
    for (const j of members) {
      sumW += w;
      sumW2 += w * w;
      sumWX += w * valueOf(j);
    }

    let gi = 0;
    if (n > 1 && S > EPS) {
      const numerator = sumWX - xbar * sumW;
      const denominator = S * Math.sqrt((n * sumW2 - sumW * sumW) / (n - 1));
      gi = denominator > EPS ? numerator / denominator : 0;
    }

    const neighbours = members.filter((j) => j !== id);
    const neighbourMean = neighbours.length
      ? neighbours.reduce((a, j) => a + valueOf(j), 0) / neighbours.length
      : xbar; // isolated node: treat its neighbourhood as exactly average
    const ownZ = S > EPS ? (valueOf(id) - xbar) / S : 0;
    const neighborZ = S > EPS ? (neighbourMean - xbar) / S : 0;

    out.set(id, {
      gi,
      ownZ,
      neighborZ,
      neighbourMean,
      neighbourCount: neighbours.length,
      sumW,
      sumW2
    });
  }

  return out;
}

// --- cluster / corroboration plumbing --------------------------------------

/** Dedup may hand us several plausible cluster shapes; be liberal about it. */
function clusterReportIds(cluster) {
  const raw = cluster?.reportIds ?? cluster?.reports ?? cluster?.members ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => (typeof r === 'string' ? r : r?.id)).filter(Boolean);
}

function clusterSettlementId(cluster, reportById) {
  if (cluster?.settlementId) return cluster.settlementId;
  for (const rid of clusterReportIds(cluster)) {
    const rep = reportById.get(rid);
    if (rep?.settlementId) return rep.settlementId;
  }
  return null;
}

// --- main entry point -------------------------------------------------------

/**
 * rank(settlements, clusters, reports, now) -> RankedSettlement[]
 *
 * @param {object[]} settlements gazetteer entries
 * @param {object[]} clusters    dedup output (same-event groups)
 * @param {object[]} reports     every report seen this run
 * @param {Date|string|number} now evaluation time (defaults to Date.now())
 * @param {{adjacency?: object, emitIncidents?: boolean}} [opts]
 */
export function rank(settlements, clusters, reports, now, opts = {}) {
  const adjacency = opts.adjacency ?? DEFAULT_ADJACENCY;
  const emitIncidents = opts.emitIncidents !== false;
  const nowMs = toMillis(now) ?? Date.now();

  const list = Array.isArray(settlements) ? settlements.filter(Boolean) : [];
  const allReports = Array.isArray(reports) ? reports.filter(Boolean) : [];
  const allClusters = Array.isArray(clusters) ? clusters.filter(Boolean) : [];

  // ---- index reports by settlement, chronologically ------------------------
  const reportById = new Map();
  const timesBySettlement = new Map();
  let windowStartMs = null;

  for (const r of allReports) {
    if (r.id) reportById.set(r.id, r);
    const t = reportTimeMs(r);
    if (t === null) continue;
    if (windowStartMs === null || t < windowStartMs) windowStartMs = t;
    const sid = r.settlementId;
    if (!sid) continue; // unresolved reports cannot inform any settlement
    if (!timesBySettlement.has(sid)) timesBySettlement.set(sid, []);
    timesBySettlement.get(sid).push(t);
  }
  for (const times of timesBySettlement.values()) times.sort((a, b) => a - b);

  // Cold-start settlements have never reported, so their silence is measured
  // from the start of the observation window - the earliest moment we could
  // possibly have heard from them.
  const observationStartMs = windowStartMs ?? nowMs;

  // ---- corroboration counts -------------------------------------------------
  // A cluster is one deduplicated real-world event, so distinct clusters is the
  // honest count of independent corroborations. Fall back to raw report counts
  // if dedup produced nothing.
  const clustersBySettlement = new Map();
  for (const c of allClusters) {
    const sid = clusterSettlementId(c, reportById);
    if (!sid) continue;
    if (!clustersBySettlement.has(sid)) clustersBySettlement.set(sid, new Set());
    clustersBySettlement.get(sid).add(c.id ?? clusterReportIds(c).join('+'));
  }

  // ---- STEP A.1: gather inter-report gaps per cohort ------------------------
  const cohortGaps = new Map();
  const globalGaps = [];

  for (const s of list) {
    const times = timesBySettlement.get(s.id) || [];
    if (times.length < 2) continue; // need >= 2 reports to observe a gap
    const key = cohortKeyFor(s);
    if (!cohortGaps.has(key)) cohortGaps.set(key, []);
    const bucket = cohortGaps.get(key);
    for (let i = 1; i < times.length; i++) {
      const gapHours = (times[i] - times[i - 1]) / HOUR_MS;
      if (!Number.isFinite(gapHours) || gapHours < 0) continue;
      bucket.push(gapHours);
      globalGaps.push(gapHours);
    }
  }

  // ---- STEP A.2: fit lambda per cohort, with documented fallbacks ----------
  const globalLambda = fitExponentialRate(globalGaps); // may be null
  const cohortLambda = new Map();
  for (const [key, gaps] of cohortGaps) {
    if (gaps.length < MIN_COHORT_GAPS) continue;
    const lambda = fitExponentialRate(gaps);
    if (lambda) cohortLambda.set(key, { lambda, gapCount: gaps.length });
  }

  function rateFor(cohortKey) {
    const fitted = cohortLambda.get(cohortKey);
    if (fitted) {
      return { lambda: fitted.lambda, fitBasis: 'cohort', sampleGaps: fitted.gapCount };
    }
    if (globalLambda) {
      return { lambda: globalLambda, fitBasis: 'global', sampleGaps: globalGaps.length };
    }
    // Documented prior - see PRIOR_EXPECTED_GAP_HOURS.
    return { lambda: 1 / PRIOR_EXPECTED_GAP_HOURS, fitBasis: 'prior', sampleGaps: 0 };
  }

  // ---- STEP A.3: silence, expected gap, surprisal --------------------------
  let coldStartsLogged = 0;
  const rows = [];
  const surprisalById = new Map();

  for (const s of list) {
    const times = timesBySettlement.get(s.id) || [];
    const lastMs = times.length ? times[times.length - 1] : null;
    const sinceMs = lastMs ?? observationStartMs;
    const silenceHours = Math.max(0, (nowMs - sinceMs) / HOUR_MS);

    const cohortKey = cohortKeyFor(s);
    const { lambda, fitBasis, sampleGaps } = rateFor(cohortKey);
    const expectedGapHours = 1 / lambda;
    const surprisal = surprisalFor(lambda, silenceHours);

    // 'reports' = this settlement has spoken for itself at least once.
    // 'cohort-cold-start' = total silence since the window opened; every number
    // for it is borrowed from its cohort, so the UI must say so out loud.
    const coverageBasis = times.length > 0 ? 'reports' : 'cohort-cold-start';

    if (coverageBasis === 'cohort-cold-start' && emitIncidents && coldStartsLogged < MAX_COLD_START_INCIDENTS) {
      coldStartsLogged++;
      addIncident(
        'cold-start',
        `No report has ever resolved to ${s.name} (${s.district}). Baseline borrowed from cohort ${cohortKey}.`,
        {
          settlementId: s.id,
          cohortKey,
          fitBasis,
          expectedGapHours: round(expectedGapHours),
          silenceHours: round(silenceHours)
        }
      );
    }

    const clusterSet = clustersBySettlement.get(s.id);
    const corroborationCount = clusterSet ? clusterSet.size : times.length;

    surprisalById.set(s.id, surprisal);
    rows.push({
      settlementId: s.id,
      name: s.name,
      district: s.district,
      lat: s.lat,
      lon: s.lon,
      population: s.population,
      hazardTier: s.hazardTier,
      lastReportAt: lastMs === null ? null : new Date(lastMs).toISOString(),
      silenceHours: round(silenceHours),
      expectedGapHours: round(expectedGapHours),
      surprisal: round(surprisal),
      giZScore: 0,
      isLocalAnomaly: false,
      coverageBasis,
      rank: 0,
      corroborationCount,
      // --- traceability extras (not part of the minimum contract) ----------
      cohortKey,
      lambdaPerHour: round(lambda, 6),
      fitBasis,
      cohortSampleGaps: sampleGaps,
      reportCount: times.length,
      ownZScore: 0,
      neighborZScore: 0,
      neighborMeanSurprisal: 0,
      neighborCount: 0,
      isRegionalOutage: false,
      isSoloAnomaly: false,
      anomalyType: 'none'
    });
  }

  // ---- STEP B: Getis-Ord Gi* over the corridor graph -----------------------
  const ids = rows.map((r) => r.settlementId);
  const gi = getisOrdGiStar(ids, surprisalById, adjacency);

  for (const row of rows) {
    const g = gi.get(row.settlementId);
    if (!g) continue;
    row.giZScore = round(g.gi);
    row.ownZScore = round(g.ownZ);
    row.neighborZScore = round(g.neighborZ);
    row.neighborMeanSurprisal = round(g.neighbourMean);
    row.neighborCount = g.neighbourCount;

    // A Gi* HOT spot in surprisal space is a COLD spot in reporting space:
    // this stretch of the corridor has gone quiet relative to everywhere else.
    row.isLocalAnomaly = g.gi > Z_CRITICAL;

    // Regional comms outage: the settlement AND its neighbours are all silent.
    // ownZ > 0 is required so a still-reporting settlement sitting next to a
    // dark stretch is never described as being part of the outage.
    row.isRegionalOutage = g.gi > Z_CRITICAL && g.neighborZ > Z_CRITICAL && g.ownZ > 0;

    // True local anomaly: this one place is extreme while its neighbours keep
    // reporting normally. That is the signal a dispatcher would otherwise miss,
    // because the surrounding district looks perfectly healthy.
    row.isSoloAnomaly = g.ownZ > Z_CRITICAL && g.neighborZ <= Z_CRITICAL;

    // Gi* is a NEIGHBOURHOOD statistic, so a settlement that is still reporting
    // normally can sit inside a significant hot spot. Say so plainly instead of
    // calling it silent: 'cluster-edge' means "its neighbours went quiet, it did
    // not" - useful context, not an alarm about this settlement.
    row.anomalyType = row.isSoloAnomaly
      ? 'solo-anomaly'
      : row.isRegionalOutage
        ? 'regional-outage'
        : row.isLocalAnomaly
          ? (g.ownZ > 0 ? 'silent-cluster' : 'cluster-edge')
          : 'none';
  }

  // ---- STEP C: deterministic ordering --------------------------------------
  // Gi* desc, then surprisal desc, then population desc, then id asc so the
  // order is fully reproducible for the audit trail. Population is a TIE-BREAK
  // only; its real influence is upstream, in the cohort that set lambda.
  rows.sort(
    (a, b) =>
      b.giZScore - a.giZScore ||
      b.surprisal - a.surprisal ||
      b.population - a.population ||
      (a.settlementId < b.settlementId ? -1 : a.settlementId > b.settlementId ? 1 : 0)
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  return rows;
}

export default rank;
