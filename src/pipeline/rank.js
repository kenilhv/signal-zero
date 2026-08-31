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

/** Expected hours between confirming reports for the REFERENCE cohort:
 *  hazard tier 2, population 10,000. 12h = roughly two confirmations a day,
 *  which is the observed cadence of official situation reporting in a declared
 *  Nepali emergency (NDRRMA / district DDMC sitreps run daily to twice daily)
 *  plus intermittent news coverage. Everything else is scaled off this anchor. */
export const PRIOR_EXPECTED_GAP_HOURS = 12;
export const PRIOR_REFERENCE_POPULATION = 10000;
export const PRIOR_REFERENCE_TIER = 2;

/** How the prior cadence scales with settlement size. Media and relief-reporting
 *  attention grows with population but far slower than linearly, so we use a
 *  square-root (exponent 0.5) scaling: a 40,000-person municipality is expected
 *  to be heard from twice as often as a 10,000-person town, not four times.
 *  This is a deliberately conservative sublinear choice - it keeps the prior
 *  from claiming implausible cadences for the two large towns in the corridor. */
export const PRIOR_POPULATION_EXPONENT = 0.5;

/** How the prior cadence scales with hazard tier. Tier 3 sits directly on the
 *  Trishuli/Bhote Koshi flood path and therefore draws more coverage and more
 *  official attention than an upland tier-1 settlement off the corridor.
 *  Multipliers are relative to the reference tier 2 and stay inside one
 *  doubling end to end - hazard exposure changes how often we EXPECT to hear
 *  from a place; it is not an importance weight bolted onto the score. */
export const PRIOR_TIER_MULTIPLIER = { 1: 0.7, 2: 1.0, 3: 1.4 };

/** Hard, defensible bounds on the fitted rate. NOTHING may leave the estimator
 *  outside this range.
 *
 *   upper 1/2 per hour  - one INDEPENDENT confirming report every two hours is
 *                         the fastest sustained cadence any single settlement in
 *                         this corridor can plausibly produce. Anything faster
 *                         is duplicate coverage of one event (which is dedup's
 *                         job to collapse) or an ingest-window artefact, not a
 *                         reporting rate. This bound is what stops the old
 *                         lambda=60/hour ("60 reports an hour from a rural
 *                         Nepali village") from ever being emitted again.
 *   lower 1/72 per hour - if we would not expect to hear from a place more than
 *                         once every three days, its silence over a four-day
 *                         window carries no evidential weight and surprisal
 *                         would collapse toward zero. We clamp instead, and
 *                         coverageBasis keeps saying the number is borrowed. */
export const LAMBDA_MAX_PER_HOUR = 1 / 2;
export const LAMBDA_MIN_PER_HOUR = 1 / 72;

/** Strength of the prior, expressed in pseudo-observations (Gamma-Exponential
 *  conjugacy: a Gamma(alpha, beta) prior on lambda behaves exactly like alpha
 *  previously observed gaps totalling beta hours). 3 pseudo-gaps means the
 *  prior is worth about as much as the smallest cohort sample we would trust on
 *  its own, so a cohort with 20 real gaps is data-dominated while a cohort with
 *  one gap barely moves off the prior. */
export const PRIOR_STRENGTH_GAPS = 3;

/** A cohort with at least this many observed gaps is reported as fitBasis
 *  'cohort'; below it the posterior is dominated by the pooled corridor-wide
 *  level and we say 'global'. The exponential MLE's relative standard error is
 *  1/sqrt(n), so below ~3 an unshrunk cohort fit is meaningless. */
export const MIN_COHORT_GAPS = 3;

/** Two reports about the same settlement closer together than this are ONE
 *  reporting event, not two independent confirmations: wire copy propagates
 *  across outlets in minutes, and a scraped item with no publication date is
 *  stamped with the scrape instant, so a whole ingest batch can land on one
 *  identical timestamp. Collapsing them is what keeps the inter-event gaps a
 *  measure of reporting CADENCE rather than of scraper throughput. */
export const MIN_DISTINCT_EVENT_HOURS = 0.5;

/** Floor on an individual gap, kept only as a divide-by-zero guard. After event
 *  coalescing no surviving gap can be smaller than MIN_DISTINCT_EVENT_HOURS. */
const MIN_GAP_HOURS = 1 / 60;

/** Two-sided 95% normal critical value. Standard Gi* significance threshold. */
export const Z_CRITICAL = 1.96;

// --- escalation gate (see qualifiesForEscalation) ---------------------------

/** Minimum self-information, in nats, before a silence may be put in front of a
 *  human. 3.0 nats == P(gap >= observed) = e^-3 ~= 0.05, i.e. the same 5% tail
 *  the Gi* Z_CRITICAL uses spatially. Because surprisal = lambda * silence, this
 *  is also the statement "silent for at least three times its own expected gap". */
export const ESCALATION_MIN_SURPRISAL_NATS = 3.0;

/** Absolute floor on wall-clock silence, independent of any fitted rate. No
 *  settlement we heard from within the last quarter of a day may ever be
 *  described as anomalously silent, however extreme its neighbourhood looks. */
export const ESCALATION_MIN_SILENCE_HOURS = 6;

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
 *
 * `minGap` guards against a zero-length sum; it defaults to one minute for gaps
 * measured in hours, and callers fitting DIMENSIONLESS rescaled gaps pass their
 * own floor.
 */
export function fitExponentialRate(gaps, minGap = MIN_GAP_HOURS) {
  const clean = [];
  for (const g of gaps || []) {
    // strictly numeric: null/''/booleans must not silently coerce to a 0h gap
    const v = typeof g === 'number' ? g : Number.NaN;
    if (!Number.isFinite(v) || v < 0) continue;
    clean.push(Math.max(v, minGap));
  }
  if (clean.length === 0) return null;
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= EPS) return null;
  return clean.length / total; // lambda_hat = n / sum(gaps)
}

/**
 * PRIOR reporting rate for a settlement profile, in reports per hour.
 *
 *   lambda0 = (1 / PRIOR_EXPECTED_GAP_HOURS)
 *             * (population / PRIOR_REFERENCE_POPULATION) ^ PRIOR_POPULATION_EXPONENT
 *             * PRIOR_TIER_MULTIPLIER[tier] / PRIOR_TIER_MULTIPLIER[reference tier]
 *
 * This is the number the whole product's credibility rests on, so it is built
 * from stated, checkable assumptions rather than from whatever the scraper
 * happened to return in one ingest window:
 *
 *   - the anchor (12h for a tier-2 town of 10,000) is the observed cadence of
 *     emergency situation reporting in Nepal, not a fitted quantity;
 *   - population scales it sublinearly (sqrt), because coverage attention grows
 *     with size much more slowly than size does;
 *   - hazard tier scales it modestly, because a settlement on the flood path is
 *     genuinely reported on more often than one off it.
 *
 * Crucially the prior VARIES ACROSS COHORTS. That variation is what lets the
 * ranking discriminate between settlements that have all been silent for the
 * same wall-clock time: 96h of silence from a tier-3 town where we expect to
 * hear something every ~10h is a far stronger statement than 96h from a tier-1
 * hamlet where the expectation is ~2 days.
 *
 * Always inside [LAMBDA_MIN_PER_HOUR, LAMBDA_MAX_PER_HOUR].
 */
export function priorRatePerHour(hazardTier, population) {
  const tier = Number(hazardTier) || PRIOR_REFERENCE_TIER;
  const pop = Math.max(1, Number(population) || PRIOR_REFERENCE_POPULATION);
  const tierMult =
    (PRIOR_TIER_MULTIPLIER[tier] ?? PRIOR_TIER_MULTIPLIER[PRIOR_REFERENCE_TIER]) /
    PRIOR_TIER_MULTIPLIER[PRIOR_REFERENCE_TIER];
  const popMult = (pop / PRIOR_REFERENCE_POPULATION) ** PRIOR_POPULATION_EXPONENT;
  return clampRate((1 / PRIOR_EXPECTED_GAP_HOURS) * popMult * tierMult);
}

/** Every rate the estimator emits passes through here. No exceptions. */
export function clampRate(lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) return LAMBDA_MIN_PER_HOUR;
  return Math.min(LAMBDA_MAX_PER_HOUR, Math.max(LAMBDA_MIN_PER_HOUR, lambda));
}

/**
 * Posterior mean of a Gamma-Exponential update, expressed as a multiplicative
 * FACTOR on a prior rate rather than as a rate.
 *
 * Model: gaps t_i ~ Exp(k * lambda0_i), where lambda0_i is the structural prior
 * for the cohort that produced gap i and k is one shared "how noisy is this
 * emergency, really" factor. Rescaling u_i = lambda0_i * t_i makes every gap
 * comparable, and u_i ~ Exp(k), so with a Gamma(a, a/kPrior) prior on k:
 *
 *   k_posterior_mean = (a + n) / (a / kPrior + sum(u_i))
 *
 * n = 0 returns kPrior exactly, which is the behaviour we want for cohorts with
 * no observations: fall back cleanly, do not invent a rate.
 */
export function posteriorScaleFactor(rescaledGaps, kPrior = 1, strength = PRIOR_STRENGTH_GAPS) {
  let n = 0;
  let sum = 0;
  for (const u of rescaledGaps || []) {
    if (!Number.isFinite(u) || u < 0) continue;
    n += 1;
    sum += u;
  }
  const prior = Number.isFinite(kPrior) && kPrior > 0 ? kPrior : 1;
  return (strength + n) / (strength / prior + sum);
}

/**
 * Collapse a settlement's report timestamps into DISTINCT reporting events.
 *
 * Two things are folded away here, and both were actively corrupting the rate
 * estimate before:
 *   1. dedup clusters - every report in one cluster is one real-world event, so
 *      the cluster contributes its earliest timestamp and nothing more;
 *   2. near-simultaneous arrivals - anything within MIN_DISTINCT_EVENT_HOURS of
 *      the previous kept event is the same event reaching us again (syndicated
 *      copy, or a scraped item with no publication date whose timestamp is just
 *      the scrape instant).
 *
 * Input times must be in milliseconds; output is sorted ascending.
 */
export function coalesceEventTimes(timesMs, minSeparationHours = MIN_DISTINCT_EVENT_HOURS) {
  const sorted = [...(timesMs || [])].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const kept = [];
  const minSepMs = Math.max(0, minSeparationHours) * HOUR_MS;
  for (const t of sorted) {
    if (kept.length === 0 || t - kept[kept.length - 1] >= minSepMs) kept.push(t);
  }
  return kept;
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

// --- escalation gate --------------------------------------------------------

/**
 * May this ranked row be put in front of a human as "anomalous silence"?
 *
 * THE OLD RULE WAS isLocalAnomaly ALONE, AND IT WAS WRONG IN BOTH DIRECTIONS.
 *
 * Too loose: Gi* is a NEIGHBOURHOOD statistic. A settlement that reported ten
 * minutes ago still clears the critical value whenever the stretch of corridor
 * around it has gone dark. rank() already names that case 'cluster-edge' -
 * context about the neighbours, not a claim about this settlement - yet the
 * checkpoint escalated it anyway, producing items such as "Anomalous silence:
 * Nilkantha (Dhading) - 0h with no confirming report" for a settlement holding
 * two fresh reports and silenceHours = 0.
 *
 * Too tight: Gi* measures how much a place stands out from its neighbours, so
 * it collapses toward zero in the single most serious scenario this product
 * exists for - a WIDE outage where most of the corridor has gone quiet at once.
 * Requiring spatial significance would silently suppress every escalation
 * exactly when everything is dark.
 *
 * The evidence that a place is anomalously silent is therefore TEMPORAL, and it
 * is about the settlement itself. All three conditions must hold:
 *
 *   1. silenceHours >= ESCALATION_MIN_SILENCE_HOURS
 *        An absolute wall-clock floor that survives any error in the fitted
 *        cadence. We never call a place silent if we heard from it this morning.
 *   2. surprisal >= ESCALATION_MIN_SURPRISAL_NATS
 *        Its own silence is a <=5% wait under its own fitted rate - equivalently
 *        (surprisal = lambda * silence) it has been quiet for at least three
 *        times its expected gap. This is the actual anomaly claim.
 *   3. ownZScore > 0
 *        It is above the corridor-wide mean silence. Keeps us from escalating a
 *        comparatively well-covered settlement merely because the whole
 *        corridor is slow, and independently excludes every cluster-edge row.
 *
 * Gi*, isLocalAnomaly and anomalyType remain in the row and in the escalation's
 * evidence as SUPPORTING CONTEXT for the human reading it - is this one place,
 * or is this the whole valley - but they no longer gate the decision.
 */
export function qualifiesForEscalation(row) {
  if (!row) return false;
  const silence = Number(row.silenceHours);
  const surprisal = Number(row.surprisal);
  const ownZ = Number(row.ownZScore);
  if (!Number.isFinite(silence) || !Number.isFinite(surprisal) || !Number.isFinite(ownZ)) {
    return false;
  }
  return (
    silence >= ESCALATION_MIN_SILENCE_HOURS &&
    surprisal >= ESCALATION_MIN_SURPRISAL_NATS &&
    ownZ > 0
  );
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

  // ---- STEP A.0: structural prior per cohort -------------------------------
  // The cohort is (hazard tier, population bucket), so its representative size
  // is the GEOMETRIC mean of its members' populations - geometric because the
  // prior scales as a power law in population, and the geometric mean is the
  // value that makes the scaled prior unbiased in log space.
  const cohortMembers = new Map();
  for (const s of list) {
    const key = cohortKeyFor(s);
    if (!cohortMembers.has(key)) cohortMembers.set(key, []);
    cohortMembers.get(key).push(s);
  }
  const cohortPrior = new Map(); // cohortKey -> lambda0 (reports per hour)
  for (const [key, members] of cohortMembers) {
    const tier = Number(members[0]?.hazardTier) || PRIOR_REFERENCE_TIER;
    let logSum = 0;
    let counted = 0;
    for (const m of members) {
      const p = Number(m.population);
      if (Number.isFinite(p) && p > 0) {
        logSum += Math.log(p);
        counted += 1;
      }
    }
    const representativePop = counted
      ? Math.exp(logSum / counted)
      : PRIOR_REFERENCE_POPULATION;
    cohortPrior.set(key, priorRatePerHour(tier, representativePop));
  }
  const priorFor = (key) => cohortPrior.get(key) ?? 1 / PRIOR_EXPECTED_GAP_HOURS;

  // ---- STEP A.1: gather inter-EVENT gaps per cohort -------------------------
  // Gaps are measured between DISTINCT reporting events (dedup clusters, then
  // near-simultaneous arrivals coalesced), never between raw scraped reports.
  // Fitting raw reports measured the scraper's throughput inside one ingest
  // window instead of the settlement's reporting cadence: when Bright Data
  // returns items with no publication date, ingest stamps them all with the
  // scrape instant, every gap collapses to zero, and lambda pins to the
  // divide-by-zero floor (that is exactly how lambda = 60/hour, i.e. one report
  // per minute from a rural village, reached the live dashboard).
  //
  // Gaps are stored RESCALED by their own cohort's prior rate (u = lambda0 * t,
  // in units of "expected gaps"), so observations from cohorts with different
  // expected cadences can legitimately be pooled into one level estimate.
  const clusterIdByReport = new Map();
  for (const c of allClusters) {
    const cid = c.id ?? clusterReportIds(c).join('+');
    for (const rid of clusterReportIds(c)) if (rid) clusterIdByReport.set(rid, cid);
  }

  const eventTimesBySettlement = new Map();
  for (const r of allReports) {
    const sid = r.settlementId;
    if (!sid) continue;
    const t = reportTimeMs(r);
    if (t === null) continue;
    const eventKey = clusterIdByReport.get(r.id) ?? r.clusterId ?? `report:${r.id ?? t}`;
    if (!eventTimesBySettlement.has(sid)) eventTimesBySettlement.set(sid, new Map());
    const byEvent = eventTimesBySettlement.get(sid);
    // one event contributes the moment it FIRST reached us
    const prev = byEvent.get(eventKey);
    if (prev === undefined || t < prev) byEvent.set(eventKey, t);
  }

  const cohortRescaled = new Map(); // cohortKey -> number[] of u = lambda0 * gap
  const globalRescaled = [];

  for (const s of list) {
    const byEvent = eventTimesBySettlement.get(s.id);
    if (!byEvent) continue;
    const events = coalesceEventTimes([...byEvent.values()]);
    if (events.length < 2) continue; // need >= 2 distinct events to observe a gap
    const key = cohortKeyFor(s);
    const lambda0 = priorFor(key);
    if (!cohortRescaled.has(key)) cohortRescaled.set(key, []);
    const bucket = cohortRescaled.get(key);
    for (let i = 1; i < events.length; i++) {
      const gapHours = (events[i] - events[i - 1]) / HOUR_MS;
      if (!Number.isFinite(gapHours) || gapHours <= 0) continue;
      const u = lambda0 * gapHours;
      bucket.push(u);
      globalRescaled.push(u);
    }
  }

  // ---- STEP A.2: Gamma-Exponential posterior, per cohort -------------------
  // Two levels, both shrunk toward a stated prior:
  //   k_global - how much faster or slower the corridor as a whole is reporting
  //              than the structural prior expects (prior mean 1: "the stated
  //              assumptions are right"). Estimated from every observed gap.
  //   k_cohort - the same factor for one cohort, shrunk toward k_global rather
  //              than toward 1, so a cohort with few gaps inherits the corridor
  //              level instead of inventing its own.
  // lambda(cohort) = clamp(k_cohort * lambda0(cohort)). With no observed gaps
  // anywhere this reduces exactly to the structural prior.
  const kGlobal = posteriorScaleFactor(globalRescaled, 1);
  const cohortRate = new Map();
  for (const [key, lambda0] of cohortPrior) {
    const rescaled = cohortRescaled.get(key) || [];
    const k = posteriorScaleFactor(rescaled, kGlobal);
    cohortRate.set(key, { lambda: clampRate(k * lambda0), gapCount: rescaled.length });
  }

  function rateFor(cohortKey) {
    const fitted = cohortRate.get(cohortKey);
    const lambda = fitted ? fitted.lambda : clampRate(priorFor(cohortKey));
    const gapCount = fitted ? fitted.gapCount : 0;
    // fitBasis is an honesty label, not a switch: it says WHERE the evidence
    // behind this rate came from.
    if (globalRescaled.length === 0) {
      return { lambda, fitBasis: 'prior', sampleGaps: 0 };
    }
    if (gapCount >= MIN_COHORT_GAPS) {
      return { lambda, fitBasis: 'cohort', sampleGaps: gapCount };
    }
    return { lambda, fitBasis: 'global', sampleGaps: globalRescaled.length };
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
      anomalyType: 'none',
      // Set in STEP B once Gi* is known. This - NOT isLocalAnomaly - is what may
      // be put in front of a human. See qualifiesForEscalation().
      isEscalationCandidate: false
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

  // Escalation gate. Deliberately evaluated AFTER anomalyType so the rule can
  // use ownZScore: neighbourhood significance is necessary but never sufficient.
  for (const row of rows) row.isEscalationCandidate = qualifiesForEscalation(row);

  // ---- STEP C: deterministic ordering --------------------------------------
  // surprisal desc, then Gi* desc, then population desc, then id asc, so the
  // order is fully reproducible for the audit trail. Population is a TIE-BREAK
  // only; its real influence is upstream, in the cohort that set lambda.
  //
  // SURPRISAL IS PRIMARY, NOT Gi*. This used to be the other way round, and it
  // was wrong in a way that attacked the product's only claim.
  //
  // Gi* is a NEIGHBOURHOOD statistic: it is high when a settlement sits INSIDE a
  // cluster of high values, whether or not the settlement itself is quiet. Rank
  // by it and a place that reported five minutes ago, surrounded by neighbours
  // silent for four days, sorts to the top of a list titled "ranked by silence".
  // The row was labelled honestly ('cluster-edge') and correctly excluded from
  // escalation, but neither of those fixes the ORDERING, and the ordering is what
  // an operator actually reads. evals family B measured it: over 40 randomised
  // placements a freshly-heard-from settlement reached the top ten.
  //
  // surprisal is that settlement's OWN evidence: -ln P(gap >= silenceHours)
  // under its own fitted rate. A settlement heard from minutes ago scores ~0 no
  // matter how dark its neighbourhood is, so it cannot displace a genuinely
  // silent one. Gi* keeps its job as the tie-break - among settlements equally
  // surprising on their own terms, the one whose neighbours also went quiet is
  // the more urgent read - and the spatial signal is still surfaced explicitly
  // through anomalyType and the isLocalAnomaly filter. Demoting it costs no
  // information; it just stops a neighbourhood measure from being presented as
  // a per-settlement one.
  rows.sort(
    (a, b) =>
      b.surprisal - a.surprisal ||
      b.giZScore - a.giZScore ||
      b.population - a.population ||
      (a.settlementId < b.settlementId ? -1 : a.settlementId > b.settlementId ? 1 : 0)
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  return rows;
}

export default rank;
