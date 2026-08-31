// Signal Zero - tests for STAGE 4 (RANK).
// These exercise the two real statistical methods the ranking rests on:
//   - Exponential time-between-events MLE  (lambda_hat = n / sum(gaps))
//   - Getis-Ord Gi* local spatial statistic over the corridor graph
// Run with: node --test test/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildWeights,
  coalesceEventTimes,
  cohortKeyFor,
  ESCALATION_MIN_SILENCE_HOURS,
  ESCALATION_MIN_SURPRISAL_NATS,
  fitExponentialRate,
  getisOrdGiStar,
  LAMBDA_MAX_PER_HOUR,
  LAMBDA_MIN_PER_HOUR,
  PRIOR_EXPECTED_GAP_HOURS,
  PRIOR_STRENGTH_GAPS,
  populationBucket,
  priorRatePerHour,
  qualifiesForEscalation,
  rank,
  surprisalFor,
  Z_CRITICAL
} from '../src/pipeline/rank.js';
import { store } from '../src/store.js';

// --- fixtures ---------------------------------------------------------------

const NOW = '2026-08-29T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const HOUR = 3600 * 1000;

/** Deterministic LCG so the MLE test is reproducible run to run. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
}

/** Undirected chain graph: s0 - s1 - ... - s(n-1). */
function chainAdjacency(ids) {
  const adj = {};
  ids.forEach((id, i) => {
    adj[id] = [];
    if (i > 0) adj[id].push(ids[i - 1]);
    if (i < ids.length - 1) adj[id].push(ids[i + 1]);
  });
  return adj;
}

/** Every synthetic settlement shares one cohort (tier 2, 5k-20k) so that a
 *  single lambda applies and surprisal is proportional to silence alone. */
function makeSettlements(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: `Settlement ${i}`,
    district: 'Nuwakot',
    lat: 27.9 + i * 0.01,
    lon: 85.1,
    population: 10000,
    hazardTier: 2,
    aliases: []
  }));
}

/** Reports at the given "hours ago" offsets. Three reports => two 3h gaps. */
function makeReports(settlementId, hoursAgoList) {
  return hoursAgoList.map((h, i) => {
    const at = new Date(NOW_MS - h * HOUR).toISOString();
    return {
      id: `${settlementId}-r${i}`,
      sourceType: 'news',
      sourceName: 'Fixture Wire',
      url: `https://example.invalid/${settlementId}/${i}`,
      title: `Report ${i} from ${settlementId}`,
      text: 'fixture',
      publishedAt: at,
      fetchedAt: at,
      settlementId,
      triage: { category: 'corroboration-candidate', confidence: 0.9, tier: 1 },
      clusterId: null
    };
  });
}

const REPORTING_OFFSETS = [7, 4, 1]; // last heard 1h ago
const SILENT_OFFSETS = [26, 23, 20]; // last heard 20h ago

/**
 * Build a field of `n` chained settlements where the indices in `silentIdx`
 * went quiet 20h ago and everyone else reported 1h ago.
 * Every settlement contributes identical 3h gaps, so lambda = 1/3 per hour.
 */
function buildField(n, silentIdx = []) {
  const settlements = makeSettlements(n);
  const silent = new Set(silentIdx);
  const reports = settlements.flatMap((s, i) =>
    makeReports(s.id, silent.has(i) ? SILENT_OFFSETS : REPORTING_OFFSETS)
  );
  const adjacency = chainAdjacency(settlements.map((s) => s.id));
  return { settlements, reports, adjacency };
}

function byId(ranked) {
  return new Map(ranked.map((r) => [r.settlementId, r]));
}

// --- STEP A: exponential TBE ------------------------------------------------

test('exponential MLE is the closed form n / sum(gaps)', () => {
  // 3 gaps summing to 12h => lambda = 3/12 = 0.25 per hour, mean gap 4h.
  assert.equal(fitExponentialRate([2, 4, 6]), 0.25);
  assert.equal(fitExponentialRate([]), null);
  assert.equal(fitExponentialRate(['nonsense', null]), null);
});

test('exponential MLE recovers a known lambda from sampled gaps', () => {
  const trueLambda = 0.25; // mean gap 4 hours
  const rng = makeRng(20260826);
  const gaps = [];
  for (let i = 0; i < 50000; i++) {
    // Inverse-CDF sampling: t = -ln(1-u)/lambda
    gaps.push(-Math.log(1 - rng()) / trueLambda);
  }
  const lambdaHat = fitExponentialRate(gaps);
  assert.ok(
    Math.abs(lambdaHat - trueLambda) / trueLambda < 0.03,
    `expected lambda_hat ~= ${trueLambda}, got ${lambdaHat}`
  );
});

test('surprisal is lambda * silenceHours (= -ln P(gap >= t) for Exp)', () => {
  const lambda = 0.25;
  const t = 12;
  assert.equal(surprisalFor(lambda, t), 3);
  // cross-check against the survival function directly
  assert.ok(Math.abs(surprisalFor(lambda, t) - -Math.log(Math.exp(-lambda * t))) < 1e-12);
  assert.equal(surprisalFor(lambda, -5), 0); // never negative
});

test('cohort key combines hazard tier and population bucket', () => {
  assert.equal(populationBucket(1240), 'p<5k');
  assert.equal(populationBucket(12600), 'p5-20k');
  assert.equal(populationBucket(32200), 'p>20k');
  assert.equal(cohortKeyFor({ hazardTier: 3, population: 1240 }), 't3|p<5k');
  assert.equal(cohortKeyFor({ hazardTier: 1, population: 28400 }), 't1|p>20k');
});

test('cohort fit is recovered end to end, shrunk toward the cohort prior', () => {
  // 10 settlements x two 3h gaps = 20 observed gaps. The unshrunk MLE would be
  // exactly 3h; the Gamma-Exponential posterior pulls it a little toward the
  // cohort's structural prior (12h for tier 2 / 10k people), and with 20 real
  // gaps against PRIOR_STRENGTH_GAPS=3 pseudo-gaps the data dominates.
  //
  //   u_i = lambda0 * 3h = 0.25 each, sum(u) = 5, n = 20
  //   k_global = (3 + 20) / (3/1 + 5)          = 2.875
  //   k_cohort = (3 + 20) / (3/2.875 + 5)      = 3.80571...
  //   lambda   = k_cohort * (1/12)             = 0.317142...  => 3.1532h
  const { settlements, reports, adjacency } = buildField(10, [4]);
  const ranked = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  const rows = byId(ranked);

  const lambda0 = 1 / PRIOR_EXPECTED_GAP_HOURS; // tier 2, population 10,000
  const kGlobal = (PRIOR_STRENGTH_GAPS + 20) / (PRIOR_STRENGTH_GAPS / 1 + 20 * lambda0 * 3);
  const kCohort = (PRIOR_STRENGTH_GAPS + 20) / (PRIOR_STRENGTH_GAPS / kGlobal + 20 * lambda0 * 3);
  const expectedGap = 1 / (kCohort * lambda0);
  assert.ok(Math.abs(expectedGap - 3.1532) < 1e-3, `closed form drifted: ${expectedGap}`);

  for (const row of ranked) {
    assert.equal(row.fitBasis, 'cohort');
    assert.ok(
      Math.abs(row.expectedGapHours - expectedGap) < 1e-3,
      `expectedGapHours=${row.expectedGapHours}`
    );
    // shrinkage moves it off the raw MLE, but only slightly, and never past the prior
    assert.ok(row.expectedGapHours > 3 && row.expectedGapHours < 3.5);
    assert.equal(row.coverageBasis, 'reports');
  }
  // surprisal = lambda * silenceHours
  assert.ok(Math.abs(rows.get('s0').surprisal - 1 / expectedGap) < 1e-3);
  assert.ok(Math.abs(rows.get('s4').surprisal - 20 / expectedGap) < 1e-3);
});

test('with no observed gaps anywhere, the documented prior is used', () => {
  const settlements = makeSettlements(3);
  store.incidents.length = 0;
  const ranked = rank(settlements, [], [], NOW, { adjacency: chainAdjacency(['s0', 's1', 's2']) });

  for (const row of ranked) {
    assert.equal(row.fitBasis, 'prior');
    assert.equal(row.expectedGapHours, PRIOR_EXPECTED_GAP_HOURS);
    assert.equal(row.coverageBasis, 'cohort-cold-start');
    assert.equal(row.lastReportAt, null);
  }
  // cold starts must surface on the fail feed, capped so it cannot spam
  const coldStarts = store.incidents.filter((i) => i.kind === 'cold-start');
  assert.ok(coldStarts.length > 0 && coldStarts.length <= 3);
  store.incidents.length = 0;
});

test('a settlement with zero reports is flagged cohort-cold-start', () => {
  const { settlements, reports, adjacency } = buildField(8, []);
  // strip every report belonging to s3
  const trimmed = reports.filter((r) => r.settlementId !== 's3');
  store.incidents.length = 0;
  const ranked = rank(settlements, [], trimmed, NOW, { adjacency });
  const rows = byId(ranked);

  assert.equal(rows.get('s3').coverageBasis, 'cohort-cold-start');
  assert.equal(rows.get('s3').lastReportAt, null);
  assert.equal(rows.get('s0').coverageBasis, 'reports');
  assert.ok(store.incidents.some((i) => i.kind === 'cold-start' && i.detail.settlementId === 's3'));
  store.incidents.length = 0;
});

// --- REGRESSION: implausible cohort baseline (lambda = 60/hour) -------------

test('a burst of same-timestamp reports cannot inflate lambda (regression)', () => {
  // Live Bright Data items with no publication date are stamped by ingest with
  // the scrape instant, so a whole batch lands on ONE timestamp. Before the fix
  // every gap was 0, got floored at one minute, and lambda_hat = n/sum(gaps)
  // pinned to 60 reports per hour (expectedGapHours 0.0167) for a rural village.
  const settlements = makeSettlements(6);
  const burstAt = new Date(NOW_MS - 1 * HOUR).toISOString();
  const reports = [];
  for (let i = 0; i < 13; i++) {
    reports.push({
      id: `s0-burst-${i}`,
      sourceType: 'news',
      sourceName: 'Wire',
      url: `https://example.invalid/burst/${i}`,
      title: `burst ${i}`,
      text: 'burst',
      publishedAt: burstAt,
      fetchedAt: burstAt,
      settlementId: 's0',
      clusterId: null
    });
  }
  const ranked = rank(settlements, [], reports, NOW, {
    adjacency: chainAdjacency(settlements.map((s) => s.id)),
    emitIncidents: false
  });

  for (const row of ranked) {
    assert.ok(row.lambdaPerHour <= LAMBDA_MAX_PER_HOUR + 1e-9, `lambda=${row.lambdaPerHour}`);
    assert.ok(row.lambdaPerHour >= LAMBDA_MIN_PER_HOUR - 1e-9, `lambda=${row.lambdaPerHour}`);
    assert.ok(row.expectedGapHours >= 2 && row.expectedGapHours <= 72);
  }
  // 13 reports at one instant are ONE reporting event, so no gap was observed
  // anywhere and the structural prior stands untouched.
  const s0 = byId(ranked).get('s0');
  assert.equal(s0.fitBasis, 'prior');
  assert.equal(s0.reportCount, 13);
  assert.ok(Math.abs(s0.expectedGapHours - PRIOR_EXPECTED_GAP_HOURS) < 1e-6);
});

test('the fitted rate is always inside the documented bounds', () => {
  // Even an absurd corpus (one settlement reporting every 30 seconds, another
  // once a fortnight) must leave the estimator inside [1/72, 1/2] per hour.
  const settlements = makeSettlements(4);
  const fast = Array.from({ length: 40 }, (_, i) => i * 0.6); // every 36 minutes
  const slow = [0, 336, 672]; // every two weeks
  const reports = [...makeReports('s0', fast), ...makeReports('s1', slow)];
  const ranked = rank(settlements, [], reports, NOW, {
    adjacency: chainAdjacency(settlements.map((s) => s.id)),
    emitIncidents: false
  });
  for (const row of ranked) {
    assert.ok(row.lambdaPerHour >= LAMBDA_MIN_PER_HOUR - 1e-9);
    assert.ok(row.lambdaPerHour <= LAMBDA_MAX_PER_HOUR + 1e-9);
  }
});

test('near-simultaneous reports collapse into one reporting event', () => {
  const t0 = NOW_MS;
  const times = [t0, t0, t0 + 60 * 1000, t0 + 90 * 60 * 1000, t0 + 95 * 60 * 1000];
  assert.deepEqual(coalesceEventTimes(times), [t0, t0 + 90 * 60 * 1000]);
  assert.deepEqual(coalesceEventTimes([]), []);
});

test('the structural prior discriminates between cohorts', () => {
  // A tier-3 town on the flood path is expected to be heard from far more often
  // than a tier-1 hamlet off it, so identical silence is NOT identical evidence.
  const townGap = 1 / priorRatePerHour(3, 6870); // Benighat-shaped
  const hamletGap = 1 / priorRatePerHour(1, 1240); // small upland settlement
  assert.ok(townGap < hamletGap, `${townGap} should be shorter than ${hamletGap}`);
  assert.ok(townGap > 2 && townGap < 24, `implausible town cadence: ${townGap}h`);
  assert.ok(hamletGap > 24 && hamletGap <= 72, `implausible hamlet cadence: ${hamletGap}h`);
  // the reference cohort reproduces the documented anchor exactly
  assert.ok(Math.abs(1 / priorRatePerHour(2, 10000) - PRIOR_EXPECTED_GAP_HOURS) < 1e-9);
});

test('silent settlements do not all collapse to one identical score', async () => {
  // The saturation failure: every silent settlement pinned at the same extreme
  // surprisal, leaving the ranking nothing to discriminate on. Real gazetteer,
  // one report 96h back to open the observation window, nothing since.
  const { default: gazetteer } = await import('../src/data/gazetteer.json', {
    with: { type: 'json' }
  });
  const opener = makeReports('np-nuwakot-bidur', [96]);
  const ranked = rank(gazetteer, [], opener, NOW, { emitIncidents: false });
  const silent = ranked.filter((r) => r.coverageBasis === 'cohort-cold-start');

  assert.ok(silent.length > 20, `expected a wide silent field, got ${silent.length}`);
  const distinct = new Set(silent.map((r) => r.surprisal.toFixed(3)));
  assert.ok(distinct.size >= 5, `surprisal saturated: only ${distinct.size} distinct values`);

  const values = silent.map((r) => r.surprisal);
  const spread = Math.max(...values) / Math.min(...values);
  assert.ok(spread > 1.5, `surprisal spread too flat: ${spread}`);
  for (const row of ranked) {
    assert.ok(row.expectedGapHours >= 2 && row.expectedGapHours <= 72);
    assert.ok(row.surprisal < 100, `implausible surprisal ${row.surprisal}`);
  }
});

// --- REGRESSION: escalation fired on a settlement that was not silent -------

test('a settlement with fresh reports is never an escalation candidate', () => {
  // Live output raised "Anomalous silence: Nilkantha (Dhading) - 0h with no
  // confirming report" for a settlement holding two fresh reports, because the
  // checkpoint gated on isLocalAnomaly - a NEIGHBOURHOOD statistic that a
  // still-reporting settlement clears whenever the corridor around it is dark.
  const { settlements, reports, adjacency } = buildField(20, [8, 9, 11, 12]);
  const rows = byId(rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false }));
  const edge = rows.get('s10'); // reported an hour ago, wedged between dark stretches

  assert.equal(edge.anomalyType, 'cluster-edge');
  assert.ok(edge.giZScore > Z_CRITICAL, 'fixture must still clear the Gi* threshold');
  assert.equal(edge.isLocalAnomaly, true);
  assert.ok(edge.silenceHours < ESCALATION_MIN_SILENCE_HOURS);
  assert.equal(edge.isEscalationCandidate, false);
  assert.equal(qualifiesForEscalation(edge), false);
});

test('escalation requires real silence AND real surprisal', () => {
  const base = { silenceHours: 96, surprisal: 9, ownZScore: 1.2, isLocalAnomaly: true };
  assert.equal(qualifiesForEscalation(base), true);
  // fails the wall-clock floor
  assert.equal(qualifiesForEscalation({ ...base, silenceHours: 0 }), false);
  assert.equal(
    qualifiesForEscalation({ ...base, silenceHours: ESCALATION_MIN_SILENCE_HOURS - 0.1 }),
    false
  );
  // fails the statistical floor (silent, but not for long relative to its own cadence)
  assert.equal(
    qualifiesForEscalation({ ...base, surprisal: ESCALATION_MIN_SURPRISAL_NATS - 0.01 }),
    false
  );
  // below the corridor mean: comparatively well covered, not an anomaly
  assert.equal(qualifiesForEscalation({ ...base, ownZScore: -0.5 }), false);
  // a wide outage flattens Gi*; that must NOT suppress the escalation
  assert.equal(qualifiesForEscalation({ ...base, isLocalAnomaly: false, giZScore: 0.1 }), true);
  assert.equal(qualifiesForEscalation(null), false);
  assert.equal(qualifiesForEscalation({}), false);
});

// --- STEP B: Getis-Ord Gi* --------------------------------------------------

test('Gi* weights are row-standardized and include the focal unit', () => {
  const ids = ['a', 'b', 'c'];
  const w = buildWeights(ids, { a: ['b'], b: ['a', 'c'], c: ['b'] });
  assert.deepEqual(new Set(w.get('b').members), new Set(['a', 'b', 'c'])); // self included
  assert.equal(w.get('b').w, 1 / 3);
  assert.equal(w.get('a').members.length, 2); // a + b
  assert.equal(w.get('a').w, 1 / 2);
  // row sums are exactly 1
  for (const id of ids) {
    const { members, w: wi } = w.get(id);
    assert.ok(Math.abs(members.length * wi - 1) < 1e-12);
  }
});

test('Gi* is ~0 everywhere for a uniform field', () => {
  const ids = ['s0', 's1', 's2', 's3', 's4', 's5'];
  const x = new Map(ids.map((id) => [id, 5])); // perfectly flat
  const gi = getisOrdGiStar(ids, x, chainAdjacency(ids));
  for (const id of ids) {
    assert.ok(Math.abs(gi.get(id).gi) < 1e-9, `${id} gi=${gi.get(id).gi}`);
  }
});

test('a uniform field produces no anomalies through the full rank()', () => {
  const { settlements, reports, adjacency } = buildField(12, []); // nobody silent
  const ranked = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  for (const row of ranked) {
    assert.equal(row.giZScore, 0);
    assert.equal(row.isLocalAnomaly, false);
    assert.equal(row.isSoloAnomaly, false);
    assert.equal(row.anomalyType, 'none');
  }
});

test('one silent settlement among reporting neighbours gets a high positive Gi*', () => {
  const { settlements, reports, adjacency } = buildField(20, [10]);
  const ranked = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  const rows = byId(ranked);
  const focal = rows.get('s10');

  assert.ok(focal.giZScore > Z_CRITICAL, `expected Gi* > 1.96, got ${focal.giZScore}`);
  assert.equal(focal.isLocalAnomaly, true);
  // it stands out on its own AND its neighbours are demonstrably fine
  assert.ok(focal.ownZScore > Z_CRITICAL, `ownZ=${focal.ownZScore}`);
  assert.ok(focal.neighborZScore < 0, `neighborZ=${focal.neighborZScore}`);
  assert.equal(focal.isSoloAnomaly, true);
  assert.equal(focal.isRegionalOutage, false);
  assert.equal(focal.anomalyType, 'solo-anomaly');

  // and it must come out on top of the candidate list
  assert.equal(focal.rank, 1);
  assert.equal(ranked[0].settlementId, 's10');
});

test('a uniformly silent region does NOT flag any single settlement as a solo anomaly', () => {
  // Four contiguous settlements out of twelve go quiet together. Because the
  // whole neighbourhood moved, no individual settlement is extreme against the
  // global mean - which is exactly the honest answer.
  const { settlements, reports, adjacency } = buildField(12, [4, 5, 6, 7]);
  const ranked = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  const rows = byId(ranked);

  for (const row of ranked) {
    assert.equal(row.isSoloAnomaly, false, `${row.settlementId} was wrongly flagged solo`);
    assert.ok(row.ownZScore <= Z_CRITICAL, `${row.settlementId} ownZ=${row.ownZScore}`);
  }
  // The silent stretch is still surfaced as a cluster - it just is not blamed
  // on one settlement standing out.
  assert.ok(rows.get('s5').giZScore > Z_CRITICAL);
  assert.equal(rows.get('s5').anomalyType, 'silent-cluster');
});

test('a still-reporting neighbour of a silent stretch is labelled cluster-edge', () => {
  // Gi* is a neighbourhood statistic, so s10 (which reported an hour ago, but is
  // wedged between two dark stretches) sits inside a significant hot spot. It
  // must not be described as silent or as part of the outage.
  const { settlements, reports, adjacency } = buildField(20, [8, 9, 11, 12]);
  const rows = byId(rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false }));
  const edge = rows.get('s10');

  assert.ok(edge.giZScore > Z_CRITICAL, `gi=${edge.giZScore}`);
  assert.ok(edge.ownZScore < 0, `s10 is itself reporting, ownZ=${edge.ownZScore}`);
  assert.equal(edge.isRegionalOutage, false);
  assert.equal(edge.anomalyType, 'cluster-edge');
  assert.equal(edge.isSoloAnomaly, false);
  assert.ok(edge.silenceHours < 2);
});

test('a wide silent block inside a large field reads as a regional outage', () => {
  // 5 silent out of 30: the block members ARE extreme globally, and so are
  // their neighbours -> regional outage, not a per-settlement anomaly.
  const { settlements, reports, adjacency } = buildField(30, [12, 13, 14, 15, 16]);
  const ranked = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  const interior = byId(ranked).get('s14');

  assert.ok(interior.ownZScore > Z_CRITICAL);
  assert.ok(interior.neighborZScore > Z_CRITICAL);
  assert.equal(interior.isRegionalOutage, true);
  assert.equal(interior.isSoloAnomaly, false);
  assert.equal(interior.anomalyType, 'regional-outage');
});

// --- STEP C: ordering, contract, determinism --------------------------------

test('ranking is sorted by Gi* desc and numbered 1..n', () => {
  const { settlements, reports, adjacency } = buildField(15, [3, 9]);
  const ranked = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });

  assert.equal(ranked.length, 15);
  ranked.forEach((row, i) => assert.equal(row.rank, i + 1));
  for (let i = 1; i < ranked.length; i++) {
    const a = ranked[i - 1];
    const b = ranked[i];
    assert.ok(
      a.giZScore > b.giZScore ||
        (a.giZScore === b.giZScore && a.surprisal >= b.surprisal) ||
        (a.giZScore === b.giZScore && a.surprisal === b.surprisal && a.population >= b.population),
      `ordering broken at ${i}`
    );
  }
});

test('rank() is deterministic - identical inputs give byte-identical output', () => {
  const { settlements, reports, adjacency } = buildField(20, [2, 11, 12]);
  const a = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  const b = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('output satisfies the RankedSettlement contract', () => {
  const { settlements, reports, adjacency } = buildField(6, [1]);
  const ranked = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  const required = [
    'settlementId',
    'name',
    'district',
    'lat',
    'lon',
    'population',
    'hazardTier',
    'lastReportAt',
    'silenceHours',
    'expectedGapHours',
    'surprisal',
    'giZScore',
    'isLocalAnomaly',
    'coverageBasis',
    'rank',
    'corroborationCount'
  ];
  for (const row of ranked) {
    for (const key of required) assert.ok(key in row, `missing ${key}`);
    assert.ok(Number.isFinite(row.silenceHours));
    assert.ok(Number.isFinite(row.expectedGapHours));
    assert.ok(Number.isFinite(row.surprisal));
    assert.ok(Number.isFinite(row.giZScore));
    assert.ok(['reports', 'cohort-cold-start'].includes(row.coverageBasis));
  }
});

test('NO dispatch-shaped field exists anywhere in the output', () => {
  // The whole point of Signal Zero: it ranks candidates, it never assigns work.
  const { settlements, reports, adjacency } = buildField(6, [2]);
  const ranked = rank(settlements, [], reports, NOW, { adjacency, emitIncidents: false });
  const banned = /(dispatch|assign|deploy|sendteam|team|responder|order|tasking)/i;
  for (const row of ranked) {
    for (const key of Object.keys(row)) {
      assert.ok(!banned.test(key), `dispatch-shaped field leaked: ${key}`);
    }
  }
});

test('corroborationCount counts distinct dedup clusters for the settlement', () => {
  const { settlements, reports, adjacency } = buildField(5, []);
  const clusters = [
    { id: 'c1', settlementId: 's0', reportIds: ['s0-r0', 's0-r1'] },
    { id: 'c2', settlementId: 's0', reportIds: ['s0-r2'] },
    { id: 'c3', reportIds: ['s1-r0'] } // settlement inferred from its reports
  ];
  const rows = byId(rank(settlements, clusters, reports, NOW, { adjacency, emitIncidents: false }));
  assert.equal(rows.get('s0').corroborationCount, 2);
  assert.equal(rows.get('s1').corroborationCount, 1);
  // no clusters resolved here -> falls back to the raw report count
  assert.equal(rows.get('s4').corroborationCount, 3);
});

test('the real corridor graph loads and ranks the real gazetteer', async () => {
  const { default: gazetteer } = await import('../src/data/gazetteer.json', {
    with: { type: 'json' }
  });
  const now = '2026-08-27T06:00:00.000Z';
  const reports = [
    ...makeReports('np-nuwakot-bidur', [40, 30, 20]),
    ...makeReports('np-nuwakot-trishuli-bazar', [38, 26, 14])
  ];
  store.incidents.length = 0;
  const ranked = rank(gazetteer, [], reports, now);

  assert.equal(ranked.length, gazetteer.length);
  assert.equal(ranked[0].rank, 1);
  for (const row of ranked) assert.ok(Number.isFinite(row.giZScore));
  store.incidents.length = 0;
});
