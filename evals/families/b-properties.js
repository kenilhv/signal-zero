// FAMILY B - DETERMINISTIC-STAGE PROPERTY TESTS
//
// dedup and rank contain no LLM by design (hard rule 3), so they are pure
// functions and can be held to properties that must hold for EVERY input, not
// just for the demo corpus. Where a property needs randomness, the generator is
// seeded, so a failure reproduces exactly.
//
// The properties are chosen to be the ones whose violation would falsify a
// claim the product makes out loud:
//
//   B1  ranking is a total order and its own rank numbers agree with it
//   B2  ranking is stable: identical input, identical output, whatever the
//       order the inputs arrived in
//   B3  a settlement we heard from minutes ago can never outrank an otherwise
//       identical one that has been silent for 96h, and can never be escalated
//   B4  the fitted reporting rate never leaves its clamped bounds, for any
//       cohort, on any input - this is the bound that stopped "60 reports an
//       hour from a rural village" reaching the dashboard
//   B5  Fellegi-Sunter probabilities stay in [0,1] and are monotone in agreement
//   B6  every cluster is internally connected and clusters partition the input
//   B7  no output object anywhere carries a dispatch-shaped field
//   B8  absence of data is labelled as absence of data, never as knowledge
//   B9  the numbers are finite - no NaN or Infinity reaches a ranked row

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Suite } from '../lib/runner.js';
import { findDispatchKeys, findDispatchLanguage, findFalseCertainty } from '../lib/guard.js';
import { runNode, ROOT } from '../lib/child.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src');

// --- seeded RNG so any failure reproduces -----------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3600 * 1000;

export async function runFamilyB() {
  const suite = new Suite(
    'B. deterministic-stage properties',
    'dedup and rank are pure, auditable functions: total order, stability, clamped rates, calibrated probabilities, connected clusters, and no dispatch-shaped output.'
  );

  const rankMod = await import(pathToFileURL(path.join(SRC, 'pipeline', 'rank.js')).href);
  const dedupMod = await import(pathToFileURL(path.join(SRC, 'pipeline', 'dedup.js')).href);
  const checkpointMod = await import(
    pathToFileURL(path.join(SRC, 'pipeline', 'checkpoint.js')).href
  );

  const {
    rank,
    qualifiesForEscalation,
    clampRate,
    priorRatePerHour,
    posteriorScaleFactor,
    coalesceEventTimes,
    getisOrdGiStar,
    surprisalFor,
    LAMBDA_MIN_PER_HOUR,
    LAMBDA_MAX_PER_HOUR,
    ESCALATION_MIN_SILENCE_HOURS,
    ESCALATION_MIN_SURPRISAL_NATS
  } = rankMod;
  const {
    dedup,
    refineComponent,
    simulateAmbiguousPair,
    ADMIT_THRESHOLD,
    AMBIGUOUS_LOW,
    AMBIGUOUS_HIGH
  } = dedupMod;

  const gazetteer = JSON.parse(fs.readFileSync(path.join(SRC, 'data', 'gazetteer.json'), 'utf8'));
  const corridor = JSON.parse(fs.readFileSync(path.join(SRC, 'data', 'corridor.json'), 'utf8'));

  // ==========================================================================
  // B1 / B2 - total order and stability
  // ==========================================================================

  const now = Date.parse('2026-08-30T12:00:00.000Z');

  function syntheticReports(seedNum, count = 60) {
    const rng = mulberry32(seedNum);
    const out = [];
    for (let i = 0; i < count; i++) {
      const s = gazetteer[Math.floor(rng() * gazetteer.length)];
      const ageHours = rng() * 120;
      out.push({
        id: `r${seedNum}-${i}`,
        sourceType: ['news', 'official', 'social'][Math.floor(rng() * 3)],
        sourceName: `Src${i % 7}`,
        url: `https://example.test/${seedNum}/${i}`,
        title: `${s.name} update ${i}`,
        text: `Households in ${s.name} were displaced; the road is blocked and a bridge is damaged. Item ${i}.`,
        publishedAt: new Date(now - ageHours * HOUR).toISOString(),
        fetchedAt: new Date(now - ageHours * HOUR + 600000).toISOString(),
        settlementId: s.id,
        triage: { category: 'corroboration-candidate', confidence: 0.9, tier: 1 },
        clusterId: null
      });
    }
    return out;
  }

  const baseReports = syntheticReports(1, 80);
  const baseClusters = dedup(
    baseReports.map((r) => ({ ...r })),
    gazetteer
  ).clusters;
  const baseRanked = rank(gazetteer, baseClusters, baseReports, now, {
    adjacency: corridor,
    emitIncidents: false
  });

  suite.check({
    id: 'B1.1',
    name: 'rank numbers are 1..n, contiguous and unique, and agree with array position',
    pass:
      baseRanked.length === gazetteer.length &&
      baseRanked.every((r, i) => r.rank === i + 1) &&
      new Set(baseRanked.map((r) => r.rank)).size === baseRanked.length,
    severity: 'critical',
    evidence: { rows: baseRanked.length, settlements: gazetteer.length }
  });

  // Antisymmetry + transitivity of the documented comparator, checked on the
  // actual emitted rows rather than on a re-implementation of the sort.
  const cmp = (a, b) =>
    b.giZScore - a.giZScore ||
    b.surprisal - a.surprisal ||
    b.population - a.population ||
    (a.settlementId < b.settlementId ? -1 : a.settlementId > b.settlementId ? 1 : 0);

  let antisym = true;
  let trans = true;
  let totality = true;
  for (let i = 0; i < baseRanked.length; i++) {
    for (let j = 0; j < baseRanked.length; j++) {
      const a = baseRanked[i];
      const b = baseRanked[j];
      const ab = Math.sign(cmp(a, b));
      const ba = Math.sign(cmp(b, a));
      if (ab !== -ba) antisym = false;
      if (i !== j && ab === 0) totality = false; // no two distinct rows may tie
      for (let k = 0; k < baseRanked.length; k += 7) {
        const c = baseRanked[k];
        if (Math.sign(cmp(a, b)) < 0 && Math.sign(cmp(b, c)) < 0 && Math.sign(cmp(a, c)) >= 0) {
          trans = false;
        }
      }
    }
  }
  suite.check({
    id: 'B1.2',
    name: 'the ranking comparator is a TOTAL order: antisymmetric, transitive, and no two distinct settlements tie',
    pass: antisym && trans && totality,
    severity: 'critical',
    evidence: { antisymmetric: antisym, transitive: trans, noTies: totality }
  });

  // Stability across permutations of the input arrays.
  const fingerprint = (rows) =>
    rows
      .map((r) => `${r.rank}:${r.settlementId}:${r.giZScore}:${r.surprisal}:${r.silenceHours}`)
      .join('|');
  const baseFp = fingerprint(baseRanked);
  const permFps = [];
  for (let t = 0; t < 12; t++) {
    const rng = mulberry32(900 + t);
    const shuffle = (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const rows = rank(shuffle(gazetteer), shuffle(baseClusters), shuffle(baseReports), now, {
      adjacency: corridor,
      emitIncidents: false
    });
    permFps.push(fingerprint(rows));
  }
  suite.check({
    id: 'B2.1',
    name: 'ranking is stable: 12 shuffles of the same inputs produce a byte-identical ordering and identical scores',
    pass: permFps.every((f) => f === baseFp),
    severity: 'critical',
    evidence: {
      permutations: permFps.length,
      mismatches: permFps.filter((f) => f !== baseFp).length
    }
  });

  const repeatFps = [];
  for (let t = 0; t < 5; t++) {
    repeatFps.push(
      fingerprint(
        rank(gazetteer, baseClusters, baseReports, now, {
          adjacency: corridor,
          emitIncidents: false
        })
      )
    );
  }
  suite.check({
    id: 'B2.2',
    name: 'ranking is idempotent: repeated runs on identical input are byte-identical',
    pass: repeatFps.every((f) => f === baseFp),
    severity: 'critical',
    evidence: { runs: repeatFps.length }
  });

  // ==========================================================================
  // B3 - a fresh report can never beat 96h of silence
  // ==========================================================================

  // Controlled: identical cohort, no adjacency, so Gi* reduces to the settlement's
  // own z-score and the ordering question is purely about silence.
  {
    const settlements = [];
    for (let i = 0; i < 8; i++) {
      settlements.push({
        id: `x-${i}`,
        name: `X${i}`,
        district: 'Test',
        lat: 28,
        lon: 85,
        population: 5000,
        hazardTier: 2
      });
    }
    const reports = [];
    const mk = (sid, hoursAgo, n) => {
      reports.push({
        id: `${sid}-${n}`,
        sourceType: 'news',
        sourceName: 'S',
        url: 'u',
        title: 't',
        text: 'households displaced',
        publishedAt: new Date(now - hoursAgo * HOUR).toISOString(),
        fetchedAt: new Date(now - hoursAgo * HOUR).toISOString(),
        settlementId: sid,
        triage: null,
        clusterId: null
      });
    };
    // every settlement has an old anchor so the observation window is the same
    for (const s of settlements) mk(s.id, 120, 0);
    mk('x-0', 0.1, 1); // heard from six minutes ago
    mk('x-1', 96, 1); // silent for four days
    const ranked = rank(settlements, [], reports, now, { adjacency: {}, emitIncidents: false });
    const fresh = ranked.find((r) => r.settlementId === 'x-0');
    const silent = ranked.find((r) => r.settlementId === 'x-1');
    suite.check({
      id: 'B3.1',
      name: 'controlled: an equivalent settlement heard from 6 minutes ago ranks BELOW one silent for 96h',
      pass: silent.rank < fresh.rank && silent.surprisal > fresh.surprisal,
      severity: 'critical',
      evidence: {
        fresh: { rank: fresh.rank, silenceHours: fresh.silenceHours, surprisal: fresh.surprisal },
        silent: {
          rank: silent.rank,
          silenceHours: silent.silenceHours,
          surprisal: silent.surprisal
        }
      }
    });
  }

  // On the REAL corridor graph, with adversarially chosen report placements:
  // Gi* is a neighbourhood statistic, so the risk is a still-reporting settlement
  // being carried up the list by silent neighbours. Two separate claims are
  // checked, because they are not the same claim.
  {
    const violations = [];
    const topTenViolations = [];
    const escalationViolations = [];
    let mislabelled = 0;
    for (let trial = 0; trial < 40; trial++) {
      const rng = mulberry32(4000 + trial);
      const reports = [];
      let n = 0;
      for (const s of gazetteer) {
        // Everyone gets an anchor at the window start.
        reports.push(mkReport(`a${n++}`, s.id, 120));
        // Then a random recent report for a random subset.
        if (rng() < 0.45) reports.push(mkReport(`b${n++}`, s.id, rng() * 100));
      }
      // Force one settlement fresh and one silent-for-96h.
      const freshId = gazetteer[Math.floor(rng() * gazetteer.length)].id;
      reports.push(mkReport(`fresh${trial}`, freshId, 0.1));
      const ranked = rank(gazetteer, [], reports, now, {
        adjacency: corridor,
        emitIncidents: false
      });
      const fresh = ranked.find((r) => r.settlementId === freshId);
      const silentAbove = ranked.filter((r) => r.silenceHours >= 96 && r.rank > fresh.rank);
      if (silentAbove.length) {
        const record = {
          trial,
          fresh: {
            name: fresh.name,
            rank: fresh.rank,
            silenceHours: fresh.silenceHours,
            gi: fresh.giZScore,
            ownZ: fresh.ownZScore,
            anomalyType: fresh.anomalyType,
            isEscalationCandidate: fresh.isEscalationCandidate
          },
          outrankedSilent: silentAbove
            .slice(0, 3)
            .map((r) => ({
              name: r.name,
              rank: r.rank,
              silenceHours: r.silenceHours,
              gi: r.giZScore
            }))
        };
        violations.push(record);
        if (fresh.rank <= 10) topTenViolations.push(record);
      }
      // Mitigation check: when it does happen, does the row at least SAY it is a
      // still-reporting settlement next to a dark stretch, rather than claiming
      // to be silent itself?
      for (const r of ranked) {
        if (
          r.silenceHours < 6 &&
          r.rank <= 10 &&
          r.anomalyType !== 'cluster-edge' &&
          r.anomalyType !== 'none'
        ) {
          mislabelled++;
        }
      }
      for (const r of ranked) {
        if (r.isEscalationCandidate && r.silenceHours < ESCALATION_MIN_SILENCE_HOURS) {
          escalationViolations.push({ trial, name: r.name, silenceHours: r.silenceHours });
        }
      }
    }

    function mkReport(id, sid, hoursAgo) {
      return {
        id,
        sourceType: 'news',
        sourceName: 'S',
        url: 'u',
        title: 't',
        text: 'households displaced',
        publishedAt: new Date(now - hoursAgo * HOUR).toISOString(),
        fetchedAt: new Date(now - hoursAgo * HOUR).toISOString(),
        settlementId: sid,
        triage: null,
        clusterId: null
      };
    }

    suite.check({
      id: 'B3.2',
      name: 'on the real corridor graph, over 40 randomised report placements, a settlement heard from minutes ago never outranks one silent for 96h',
      pass: violations.length === 0,
      severity: 'major',
      evidence: {
        trials: 40,
        violatingTrials: violations.length,
        sample: violations.slice(0, 2),
        note: 'Gi* is the primary sort key and is a NEIGHBOURHOOD statistic, so this is the property most at risk of quietly breaking. rank.js addresses the consequence for ESCALATION (qualifiesForEscalation) but not for ORDERING.'
      }
    });

    // Severity calibration for the finding above. A violation buried at rank 29
    // is a different thing from one at rank 3, and the report should say which.
    suite.metric('rankOrderingViolations', {
      trials: 40,
      anywhereInList: violations.length,
      insideTopTen: topTenViolations.length,
      worstFreshRank: violations.length ? Math.min(...violations.map((v) => v.fresh.rank)) : null
    });
    suite.check({
      id: 'B3.2b',
      name: 'a settlement heard from minutes ago never reaches the TOP TEN of the silence ranking - the part of the list an operator actually reads',
      pass: topTenViolations.length === 0,
      severity: 'critical',
      evidence: {
        trials: 40,
        topTenViolations: topTenViolations.slice(0, 3),
        worstFreshRank: violations.length ? Math.min(...violations.map((v) => v.fresh.rank)) : null
      }
    });

    suite.check({
      id: 'B3.2c',
      name: 'when a still-reporting settlement does sit high in the list, the row labels itself "cluster-edge" (its neighbours went quiet, it did not) rather than claiming to be silent',
      pass: mislabelled === 0,
      severity: 'major',
      evidence: {
        mislabelledRows: mislabelled,
        note: 'This is the mitigation rank.js documents. It does not make the ordering correct, but it does stop the ordering from being READ as a silence claim.'
      }
    });

    suite.check({
      id: 'B3.3',
      name: 'no settlement heard from within the last 6 hours is ever an escalation candidate, on any input',
      pass: escalationViolations.length === 0,
      severity: 'critical',
      evidence: {
        violations: escalationViolations.slice(0, 5),
        threshold: ESCALATION_MIN_SILENCE_HOURS
      }
    });
  }

  // The escalation gate as a pure predicate, fuzzed over the whole input space
  // including hostile values.
  {
    const rng = mulberry32(77);
    let bad = 0;
    const badCases = [];
    for (let i = 0; i < 5000; i++) {
      const row = {
        silenceHours: pick(rng, [0, 1, 5.999, 6, 6.001, 96, 1e9, -1, NaN, Infinity, rng() * 200]),
        surprisal: pick(rng, [0, 2.999, 3, 3.001, 50, -1, NaN, Infinity, rng() * 10]),
        ownZScore: pick(rng, [-5, -0.001, 0, 0.001, 5, NaN, Infinity, rng() * 4 - 2])
      };
      const got = qualifiesForEscalation(row);
      const expected =
        Number.isFinite(row.silenceHours) &&
        Number.isFinite(row.surprisal) &&
        Number.isFinite(row.ownZScore) &&
        row.silenceHours >= ESCALATION_MIN_SILENCE_HOURS &&
        row.surprisal >= ESCALATION_MIN_SURPRISAL_NATS &&
        row.ownZScore > 0;
      if (got !== expected) {
        bad++;
        if (badCases.length < 5) badCases.push({ row, got, expected });
      }
    }
    suite.check({
      id: 'B3.4',
      name: 'the escalation gate matches its stated rule on 5000 fuzzed rows, including NaN/Infinity/negative inputs',
      pass: bad === 0,
      severity: 'critical',
      evidence: { mismatches: bad, sample: badCases }
    });
  }

  function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  // ==========================================================================
  // B4 - lambda stays inside its clamped bounds, for every cohort
  // ==========================================================================
  {
    const rng = mulberry32(31337);
    const outOfBounds = [];
    let rowsChecked = 0;

    for (let trial = 0; trial < 60; trial++) {
      // A hostile gazetteer: absurd populations, unknown tiers, missing fields.
      const settlements = [];
      const count = 3 + Math.floor(rng() * 25);
      for (let i = 0; i < count; i++) {
        settlements.push({
          id: `f-${trial}-${i}`,
          name: `F${i}`,
          district: 'Fuzz',
          lat: 28,
          lon: 85,
          population: pick(rng, [
            0,
            1,
            12,
            4999,
            5000,
            20000,
            20001,
            1e6,
            1e12,
            null,
            undefined,
            -5,
            NaN
          ]),
          hazardTier: pick(rng, [1, 2, 3, 0, 7, null, undefined, 'three'])
        });
      }
      const reports = [];
      let n = 0;
      for (const s of settlements) {
        const k = Math.floor(rng() * 6);
        for (let j = 0; j < k; j++) {
          // Includes the pathological case ingest actually produces: every item
          // stamped with the same scrape instant, so every raw gap is zero.
          const hoursAgo = rng() < 0.3 ? 12 : rng() * 200;
          reports.push({
            id: `fr-${trial}-${n++}`,
            sourceType: 'news',
            sourceName: 'S',
            url: 'u',
            title: 't',
            text: 'displaced households',
            publishedAt: new Date(now - hoursAgo * HOUR).toISOString(),
            fetchedAt: new Date(now - hoursAgo * HOUR).toISOString(),
            settlementId: s.id,
            triage: null,
            clusterId: null
          });
        }
      }
      const ranked = rank(settlements, [], reports, now, { adjacency: {}, emitIncidents: false });
      for (const r of ranked) {
        rowsChecked++;
        const lam = r.lambdaPerHour;
        // rounding to 6dp is applied on the way out, so allow that tolerance
        if (!(lam >= LAMBDA_MIN_PER_HOUR - 1e-6 && lam <= LAMBDA_MAX_PER_HOUR + 1e-6)) {
          outOfBounds.push({
            trial,
            id: r.settlementId,
            lambdaPerHour: lam,
            cohortKey: r.cohortKey
          });
        }
        if (
          !Number.isFinite(r.expectedGapHours) ||
          r.expectedGapHours < 2 - 1e-3 ||
          r.expectedGapHours > 72 + 1e-3
        ) {
          outOfBounds.push({ trial, id: r.settlementId, expectedGapHours: r.expectedGapHours });
        }
      }
    }

    suite.check({
      id: 'B4.1',
      name: `the fitted rate stays inside [1/72, 1/2] per hour for every cohort across ${rowsChecked} fuzzed rows (absurd populations, unknown tiers, all-identical timestamps)`,
      pass: outOfBounds.length === 0,
      severity: 'critical',
      evidence: {
        rowsChecked,
        bounds: [LAMBDA_MIN_PER_HOUR, LAMBDA_MAX_PER_HOUR],
        violations: outOfBounds.slice(0, 5)
      }
    });

    // The clamp itself, against values chosen to break it.
    const clampInputs = [NaN, Infinity, -Infinity, -1, 0, 1e-30, 1e30, null, undefined, 'x'];
    const clampBad = clampInputs.filter((v) => {
      const out = clampRate(v);
      return !(out >= LAMBDA_MIN_PER_HOUR && out <= LAMBDA_MAX_PER_HOUR);
    });
    suite.check({
      id: 'B4.2',
      name: 'clampRate() returns an in-bounds rate for NaN, Infinity, negatives, zero, and non-numbers',
      pass: clampBad.length === 0,
      severity: 'critical',
      evidence: { failedInputs: clampBad.map(String) }
    });

    const priorBad = [];
    for (const tier of [1, 2, 3, 0, 9, null, undefined]) {
      for (const pop of [0, 1, 100, 1e5, 1e12, -1, null, NaN]) {
        const p = priorRatePerHour(tier, pop);
        if (!(p >= LAMBDA_MIN_PER_HOUR && p <= LAMBDA_MAX_PER_HOUR)) {
          priorBad.push({ tier, pop, p });
        }
      }
    }
    suite.check({
      id: 'B4.3',
      name: 'the structural prior is in-bounds for every tier/population combination, including nonsense ones',
      pass: priorBad.length === 0,
      severity: 'critical',
      evidence: { violations: priorBad }
    });

    // posteriorScaleFactor with no observations must return the prior exactly -
    // "no data" must not shift the estimate.
    const noObs = posteriorScaleFactor([], 1.37);
    suite.check({
      id: 'B4.4',
      name: 'with zero observed gaps the posterior scale factor returns the prior exactly - no data moves no number',
      pass: Math.abs(noObs - 1.37) < 1e-12,
      severity: 'major',
      evidence: { kPrior: 1.37, returned: noObs }
    });

    // Event coalescing is what stops scraper throughput being read as reporting
    // cadence. A whole batch stamped with one instant must collapse to ONE event.
    const sameInstant = new Array(40).fill(now);
    const coalesced = coalesceEventTimes(sameInstant);
    suite.check({
      id: 'B4.5',
      name: '40 reports stamped with one identical scrape instant collapse to a single reporting EVENT',
      pass: coalesced.length === 1,
      severity: 'critical',
      evidence: { input: 40, distinctEvents: coalesced.length }
    });

    // Surprisal must be monotone in silence for a fixed rate.
    let monotone = true;
    for (let lam = 0.02; lam < 0.5; lam += 0.05) {
      let prev = -1;
      for (let h = 0; h <= 200; h += 5) {
        const s = surprisalFor(lam, h);
        if (s < prev) monotone = false;
        prev = s;
      }
    }
    suite.check({
      id: 'B4.6',
      name: 'surprisal is monotone non-decreasing in silence for a fixed rate',
      pass: monotone,
      severity: 'major',
      evidence: null
    });
  }

  // ==========================================================================
  // B5 - Fellegi-Sunter probabilities
  // ==========================================================================
  {
    // Exact FS readings for a constructed comparison vector. With exactly two
    // reports there is at most one candidate pair, so simulateAmbiguousPair
    // reports that pair's real score (and flags the fabricated fallback it
    // returns when blocking produced no pair at all).
    const HIGH_A =
      'Forty households were displaced in Betrawati after the Trishuli surge. The suspension bridge was damaged and the road is blocked.';
    const HIGH_B =
      'Forty households displaced in Betrawati following the Trishuli surge. A suspension bridge was damaged and the road remains blocked.';
    const MED_B =
      'Households in Betrawati were displaced and officials inspected the bridge. Separately, relief was distributed in the ward on Thursday.';
    const LOW_B =
      'Relief materials were distributed to families and a health post has been set up in the ward this week.';

    const mk = (id, sid, hoursAgo, sourceType, text) => ({
      id,
      sourceType,
      sourceName: `S-${id}`,
      url: `https://example.test/${id}`,
      title: text.slice(0, 40),
      text,
      publishedAt: new Date(now - hoursAgo * HOUR).toISOString(),
      fetchedAt: new Date(now - hoursAgo * HOUR).toISOString(),
      settlementId: sid,
      triage: { category: 'corroboration-candidate', confidence: 0.9, tier: 1 },
      clusterId: null
    });

    function exactScore(a, b) {
      const p = simulateAmbiguousPair([a, b]);
      if (!p) return null;
      // simulateAmbiguousPair fabricates a pair when blocking produced none;
      // that fabrication has no weights and a null hoursApart.
      const fabricated =
        p.hoursApart === null &&
        p.logLikelihoodRatio === 0 &&
        Object.keys(p.weights || {}).length === 0;
      if (fabricated) return { reachable: false, vector: null, p: null };
      return {
        reachable: true,
        vector: p.vector,
        p: p.forced ? p.originalMatchProbability : p.matchProbability,
        textSimilarity: p.textSimilarity
      };
    }

    const GEO = {
      same: ['np-nuwakot-betrawati', 'np-nuwakot-betrawati'],
      adjacent: ['np-nuwakot-betrawati', 'np-nuwakot-trishuli-bazar'],
      far: ['np-rasuwa-timure', 'np-dhading-benighat'],
      unknown: [null, null]
    };
    const TIME = { lt6h: 1, lt24h: 12, lt72h: 40, beyond: 100 };
    const TEXT = { high: HIGH_B, med: MED_B, low: LOW_B };

    const readings = [];
    const unreachable = [];
    for (const [geoName, [sa, sb]] of Object.entries(GEO)) {
      for (const [timeName, hours] of Object.entries(TIME)) {
        for (const [textName, textB] of Object.entries(TEXT)) {
          for (const srcName of ['same', 'diff']) {
            const a = mk('a', sa, 0, 'news', HIGH_A);
            const b = mk('b', sb, hours, srcName === 'same' ? 'news' : 'official', textB);
            const got = exactScore(a, b);
            const label = `${geoName}/${timeName}/${textName}/${srcName}`;
            if (!got || !got.reachable) {
              unreachable.push(label);
              continue;
            }
            readings.push({ label, requested: { geoName, timeName, textName, srcName }, ...got });
          }
        }
      }
    }

    const outOfRange = readings.filter((r) => !(r.p >= 0 && r.p <= 1));
    suite.check({
      id: 'B5.1',
      name: `every Fellegi-Sunter match probability is inside [0,1] across ${readings.length} reachable comparison vectors`,
      pass: outOfRange.length === 0 && readings.length >= 20,
      severity: 'critical',
      evidence: { reachableVectors: readings.length, outOfRange }
    });

    // Monotonicity in each field, holding the others fixed.
    const by = new Map(
      readings.map((r) => [
        `${r.vector.geo}/${r.vector.time}/${r.vector.text}/${r.vector.source}`,
        r.p
      ])
    );
    const monoFailures = [];
    const check = (a, b, why) => {
      if (by.has(a) && by.has(b) && !(by.get(a) > by.get(b))) {
        monoFailures.push({ why, [a]: by.get(a), [b]: by.get(b) });
      }
    };
    for (const src of ['same', 'diff']) {
      for (const txt of ['high', 'med', 'low']) {
        check(
          `same/lt6h/${txt}/${src}`,
          `same/lt24h/${txt}/${src}`,
          'closer in time must score higher'
        );
        check(
          `same/lt24h/${txt}/${src}`,
          `same/lt72h/${txt}/${src}`,
          'closer in time must score higher'
        );
      }
      for (const t of ['lt6h', 'lt24h', 'lt72h']) {
        check(
          `same/${t}/high/${src}`,
          `same/${t}/med/${src}`,
          'more textual agreement must score higher'
        );
        check(
          `same/${t}/med/${src}`,
          `same/${t}/low/${src}`,
          'more textual agreement must score higher'
        );
        check(
          `same/${t}/high/${src}`,
          `adjacent/${t}/high/${src}`,
          'the same settlement must outscore an adjacent one'
        );
      }
    }
    suite.check({
      id: 'B5.2',
      name: 'match probability is monotone in agreement: closer in time, more textual overlap and same-settlement all score strictly higher',
      pass: monoFailures.length === 0,
      severity: 'critical',
      evidence: { comparisons: by.size, failures: monoFailures }
    });

    // The design claim in dedup.js's m/u comments, tested rather than trusted:
    // two ADJACENT towns with perfect text and time agreement must NOT auto-merge.
    const adjacentBest = by.get('adjacent/lt6h/high/same');
    suite.check({
      id: 'B5.3',
      name: 'two ADJACENT corridor towns with perfect text and time agreement land in the human-review band, never auto-merged',
      pass:
        adjacentBest !== undefined &&
        adjacentBest >= AMBIGUOUS_LOW &&
        adjacentBest < ADMIT_THRESHOLD,
      severity: 'critical',
      evidence: {
        matchProbability: adjacentBest,
        band: [AMBIGUOUS_LOW, AMBIGUOUS_HIGH],
        admit: ADMIT_THRESHOLD,
        why: 'over-merging neighbours moves one town corroboration onto another and hides a genuinely silent settlement'
      }
    });

    suite.note(
      `comparison vectors unreachable through blocking (${unreachable.length}): ${[...new Set(unreachable.map((u) => u.split('/').slice(0, 2).join('/')))].join(', ')} - the m/u table defines cells that no candidate pair can produce, so those rows are decoration rather than evidence`
    );
    suite.metric('fs.unreachableVectorCount', unreachable.length);
    suite.metric('fs.reachableVectorCount', readings.length);

    suite.check({
      id: 'B5.4',
      name: 'the ambiguous band is a strict subset of the admit threshold and is non-empty',
      pass:
        AMBIGUOUS_LOW < AMBIGUOUS_HIGH && AMBIGUOUS_HIGH === ADMIT_THRESHOLD && AMBIGUOUS_LOW > 0,
      severity: 'major',
      evidence: { AMBIGUOUS_LOW, AMBIGUOUS_HIGH, ADMIT_THRESHOLD }
    });
  }

  // ==========================================================================
  // B6 - clusters are internally connected and partition the input
  // ==========================================================================
  {
    // (a) refineComponent as a pure function, on random CONNECTED graphs -
    //     which is the only kind dedup ever hands it.
    const rng = mulberry32(555);
    let trials = 0;
    const disconnected = [];
    const partitionErrors = [];

    for (let t = 0; t < 300; t++) {
      const n = 2 + Math.floor(rng() * 9);
      const members = Array.from({ length: n }, (_, i) => `n${i}`);
      // random spanning tree => guaranteed connected
      const edges = [];
      for (let i = 1; i < n; i++) {
        const j = Math.floor(rng() * i);
        edges.push({ aId: members[i], bId: members[j], matchProbability: 0.6 + rng() * 0.4 });
      }
      // plus random extra edges
      const extra = Math.floor(rng() * n);
      for (let e = 0; e < extra; e++) {
        const i = Math.floor(rng() * n);
        const j = Math.floor(rng() * n);
        if (i !== j)
          edges.push({ aId: members[i], bId: members[j], matchProbability: 0.6 + rng() * 0.4 });
      }

      const parts = refineComponent(members, edges);
      trials++;

      // partition: every member exactly once
      const flat = parts.flat();
      if (flat.length !== n || new Set(flat).size !== n) {
        partitionErrors.push({ t, n, parts });
      }
      // each returned part must be connected using only the edges it was given
      for (const part of parts) {
        if (!isConnected(part, edges)) disconnected.push({ t, part, edges: edges.length });
      }
    }

    suite.check({
      id: 'B6.1',
      name: `every cluster the refinement returns is internally CONNECTED (${trials} random connected graphs)`,
      pass: disconnected.length === 0,
      severity: 'critical',
      evidence: { trials, disconnected: disconnected.slice(0, 3) }
    });
    suite.check({
      id: 'B6.2',
      name: 'the refinement PARTITIONS its input: every report lands in exactly one cluster, none is lost or duplicated',
      pass: partitionErrors.length === 0,
      severity: 'critical',
      evidence: { trials, errors: partitionErrors.slice(0, 3) }
    });

    // (b) the same properties on real dedup() output over fuzzed corpora.
    const dedupPartitionErrors = [];
    const clusterRange = [];
    for (let t = 0; t < 12; t++) {
      const reports = syntheticReports(6000 + t, 50);
      const { clusters, ambiguousPairs } = dedup(reports, gazetteer);
      const ids = reports.map((r) => r.id);
      const flat = clusters.flatMap((c) => c.reportIds);
      if (flat.length !== ids.length || new Set(flat).size !== ids.length) {
        dedupPartitionErrors.push({
          t,
          reports: ids.length,
          clustered: flat.length,
          unique: new Set(flat).size
        });
      }
      for (const c of clusters) clusterRange.push(c.confidence);
      for (const p of ambiguousPairs) clusterRange.push(p.matchProbability);
      // every report must carry the clusterId of the cluster that holds it
      for (const c of clusters) {
        for (const rid of c.reportIds) {
          const r = reports.find((x) => x.id === rid);
          if (!r || r.clusterId !== c.id) {
            dedupPartitionErrors.push({ t, rid, expected: c.id, got: r?.clusterId });
          }
        }
      }
    }
    suite.check({
      id: 'B6.3',
      name: 'dedup() partitions the real report set and writes a consistent clusterId back onto every report',
      pass: dedupPartitionErrors.length === 0,
      severity: 'critical',
      evidence: { errors: dedupPartitionErrors.slice(0, 5) }
    });
    suite.check({
      id: 'B6.4',
      name: 'every cluster confidence and ambiguous-pair probability lies in [0,1]',
      pass: clusterRange.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
      severity: 'critical',
      evidence: {
        checked: clusterRange.length,
        offending: clusterRange.filter((v) => !(v >= 0 && v <= 1)).slice(0, 5)
      }
    });

    // (c) determinism and permutation invariance of the clustering itself.
    const corpus = syntheticReports(4242, 45);
    const clusterSig = (cl) =>
      cl
        .map((c) => c.reportIds.slice().sort().join('+'))
        .sort()
        .join('|');
    const sigA = clusterSig(
      dedup(
        corpus.map((r) => ({ ...r })),
        gazetteer
      ).clusters
    );
    const sigB = clusterSig(
      dedup(
        corpus.map((r) => ({ ...r })),
        gazetteer
      ).clusters
    );
    const rng2 = mulberry32(8);
    const shuffled = corpus.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng2() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const sigC = clusterSig(
      dedup(
        shuffled.map((r) => ({ ...r })),
        gazetteer
      ).clusters
    );

    suite.check({
      id: 'B6.5',
      name: 'dedup is deterministic on identical input and invariant to the order reports arrive in',
      pass: sigA === sigB && sigA === sigC,
      severity: 'critical',
      evidence: { repeatMatches: sigA === sigB, permutationMatches: sigA === sigC }
    });
  }

  function isConnected(nodes, edges) {
    if (nodes.length <= 1) return true;
    const set = new Set(nodes);
    const adj = new Map(nodes.map((n) => [n, []]));
    for (const e of edges) {
      if (set.has(e.aId) && set.has(e.bId)) {
        adj.get(e.aId).push(e.bId);
        adj.get(e.bId).push(e.aId);
      }
    }
    const seen = new Set([nodes[0]]);
    const stack = [nodes[0]];
    while (stack.length) {
      for (const nb of adj.get(stack.pop())) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    return seen.size === nodes.length;
  }

  // ==========================================================================
  // B7 - no dispatch-shaped field anywhere in a pipeline output
  // ==========================================================================
  {
    const { clusters, ambiguousPairs } = dedup(
      baseReports.map((r) => ({ ...r })),
      gazetteer
    );
    const surfaces = {
      rankedRows: baseRanked,
      clusters,
      ambiguousPairs,
      shortlist: checkpointMod.buildShortlist(
        { settlementId: 'np-rasuwa-haku', evidence: { settlementId: 'np-rasuwa-haku' } },
        gazetteer
      )
    };
    const keyHits = findDispatchKeys(surfaces);
    suite.check({
      id: 'B7.1',
      name: 'no ranked row, cluster, ambiguous pair or approval shortlist carries a dispatch-shaped FIELD',
      pass: keyHits.length === 0,
      severity: 'critical',
      evidence: { hits: keyHits }
    });

    const langHits = findDispatchLanguage(surfaces);
    suite.check({
      id: 'B7.2',
      name: 'no system-composed string in those outputs contains dispatch LANGUAGE',
      pass: langHits.length === 0,
      severity: 'critical',
      evidence: { hits: langHits }
    });

    // The shortlist is the single most dangerous object in the system: it is what
    // approval unlocks. Its ordering must carry no preference signal.
    const shortlist = surfaces.shortlist;
    const alphabetical = shortlist.map((x) => x.district);
    const sorted = alphabetical.slice().sort((a, b) => String(a).localeCompare(String(b), 'en'));
    suite.check({
      id: 'B7.3',
      name: 'the approval shortlist is ordered alphabetically by district - it carries no priority signal',
      pass:
        JSON.stringify(alphabetical) === JSON.stringify(sorted) &&
        shortlist.every((x) => x.ordering === 'alphabetical-by-district (non-preferential)'),
      severity: 'critical',
      evidence: { order: alphabetical }
    });
  }

  // ==========================================================================
  // B8 - absence of data is labelled as absence of data
  // ==========================================================================
  {
    // No reports at all: every settlement must be cold-start, and nothing may be
    // described as confirmed anything.
    const ranked = rank(gazetteer, [], [], now, { adjacency: corridor, emitIncidents: false });
    const allCold = ranked.every((r) => r.coverageBasis === 'cohort-cold-start');
    const anyCorroboration = ranked.some((r) => r.corroborationCount > 0);
    suite.check({
      id: 'B8.1',
      name: 'with zero reports every settlement is labelled cohort-cold-start with zero corroborations - no data is never dressed as knowledge',
      pass: allCold && !anyCorroboration,
      severity: 'critical',
      evidence: {
        settlements: ranked.length,
        coverageBases: [...new Set(ranked.map((r) => r.coverageBasis))],
        maxCorroboration: Math.max(...ranked.map((r) => r.corroborationCount))
      }
    });

    const certainty = findFalseCertainty({ ranked, baseRanked });
    suite.check({
      id: 'B8.2',
      name: 'no ranked row ever claims a settlement is confirmed silent, confirmed safe, or confirmed anything',
      pass: certainty.length === 0,
      severity: 'critical',
      evidence: { hits: certainty }
    });

    // coverageBasis is a closed vocabulary; a new value would be a new claim.
    const bases = new Set(baseRanked.concat(ranked).map((r) => r.coverageBasis));
    suite.check({
      id: 'B8.3',
      name: 'coverageBasis only ever takes the two documented values',
      pass: [...bases].every((b) => b === 'reports' || b === 'cohort-cold-start'),
      severity: 'major',
      evidence: { observed: [...bases] }
    });
  }

  // ==========================================================================
  // B9 - the numbers are finite
  // ==========================================================================
  {
    const nonFinite = [];
    const scan = (rows, label) => {
      for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === 'number' && !Number.isFinite(v))
            nonFinite.push({ label, id: r.settlementId, k, v: String(v) });
        }
      }
    };
    scan(baseRanked, 'base');
    scan(rank(gazetteer, [], [], now, { adjacency: corridor, emitIncidents: false }), 'empty');
    scan(rank(gazetteer, [], [], now, { adjacency: {}, emitIncidents: false }), 'no-adjacency');
    // one settlement only: n = 1 is the degenerate case for Gi*
    scan(
      rank([gazetteer[0]], [], [], now, { adjacency: corridor, emitIncidents: false }),
      'single'
    );
    // a perfectly uniform field: S = 0, the other Gi* degeneracy
    const uniformReports = gazetteer.map((s, i) => ({
      id: `u${i}`,
      sourceType: 'news',
      sourceName: 'S',
      url: 'u',
      title: 't',
      text: 'displaced',
      publishedAt: new Date(now - 24 * HOUR).toISOString(),
      fetchedAt: new Date(now - 24 * HOUR).toISOString(),
      settlementId: s.id,
      triage: null,
      clusterId: null
    }));
    scan(
      rank(gazetteer, [], uniformReports, now, { adjacency: corridor, emitIncidents: false }),
      'uniform'
    );

    suite.check({
      id: 'B9.1',
      name: 'no NaN or Infinity reaches a ranked row, including the Gi* degeneracies (n=1, zero variance, no adjacency, no reports)',
      pass: nonFinite.length === 0,
      severity: 'critical',
      evidence: { violations: nonFinite.slice(0, 10) }
    });

    const gi = getisOrdGiStar([], new Map(), {});
    suite.check({
      id: 'B9.2',
      name: 'Getis-Ord Gi* on an empty unit set returns an empty result rather than throwing',
      pass: gi instanceof Map && gi.size === 0,
      severity: 'minor',
      evidence: null
    });
  }

  // ==========================================================================
  // B10 - the stages' own shipped sanity checks still pass
  // ==========================================================================
  for (const [name, file] of [
    ['dedup', path.join(SRC, 'pipeline', 'dedup.js')],
    ['triage', path.join(SRC, 'pipeline', 'triage.js')]
  ]) {
    const proc = await runNode(file, [], {
      env: { TRUEFORGE_ENABLED: 'false', OPENAI_API_KEY: '', USE_LIVE_SCRAPE: 'false' },
      timeoutMs: 60000,
      cwd: ROOT
    });
    suite.check({
      id: `B10.${name}`,
      name: `src/pipeline/${name}.js's own shipped sanity checks still pass`,
      pass: proc.code === 0 && !/^FAIL:/m.test(proc.stdout + proc.stderr),
      severity: 'major',
      evidence: {
        exitCode: proc.code,
        failures: (proc.stdout + proc.stderr).split('\n').filter((l) => l.startsWith('FAIL:'))
      }
    });
  }

  // src/guardrails/ ships node:test suites of its own. They are the enforcement
  // this eval's family C depends on, so a regression in them is a regression
  // here and must break this run rather than quietly weakening it.
  {
    const guardrailDir = path.join(SRC, 'guardrails');
    if (fs.existsSync(guardrailDir)) {
      // An explicit glob, NOT the directory: `node --test <dir>` reports the
      // whole directory as ONE passing test on this Node build, which made an
      // earlier version of this gate almost vacuous - it "passed" while running
      // 1 test instead of 144. Hence the count assertion below.
      const proc = await runNode('--test', ['src/guardrails/*.test.js'], {
        env: { TRUEFORGE_ENABLED: 'false', OPENAI_API_KEY: '', USE_LIVE_SCRAPE: 'false' },
        timeoutMs: 180000,
        cwd: ROOT
      });
      const out = proc.stdout + proc.stderr;
      const num = (label) => {
        const m = out.match(new RegExp(`^\\s*(?:ℹ|#)\\s*${label} (\\d+)$`, 'm'));
        return m ? Number(m[1]) : null;
      };
      const tests = num('tests');
      const fail = num('fail');

      suite.check({
        id: 'B10.guardrails',
        name: 'the src/guardrails/ test suites - the enforcement family C leans on - all pass',
        pass: proc.code === 0 && fail === 0,
        severity: 'major',
        evidence: { exitCode: proc.code, tests, fail, tail: out.slice(-600) }
      });

      suite.check({
        id: 'B10.guardrails-not-vacuous',
        name: 'that gate actually ran a substantial number of guardrail tests - a green suite that executed nothing is the failure mode this whole eval exists to prevent',
        pass: typeof tests === 'number' && tests >= 50,
        severity: 'major',
        evidence: {
          testsExecuted: tests,
          minimum: 50,
          why: '`node --test <directory>` reports the directory as a single test on this Node build; only an explicit glob discovers the files.'
        }
      });
    }
  }

  return { suite };
}
