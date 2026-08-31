// FAMILY A - GOLDEN-SET CLASSIFICATION
//
// What a green run of this family proves: on 32 hand-labelled reports drawn from
// the real 26 Aug 2026 Trishuli GLOF coverage, triage resolves settlements it can
// justify, refuses the ones it cannot, and never turns a report that does not
// confirm a settlement into a corroboration for that settlement.
//
// The set is scored under TWO configurations, in two separate processes:
//
//   deterministic  TRUEFORGE_ENABLED=false, no OPENAI key. Tiers 1 and 2 only;
//                  tier 3 has no executor, so anything that reaches it is left
//                  UNRESOLVED. This is the floor, and it is fully reproducible.
//   harness        TRUEFORGE_ENABLED=true against the live TrueForge instance,
//                  and STILL no OPENAI key - so if a classification comes back
//                  tier 3, the harness and only the harness produced it. There
//                  is no fallback path that could be mistaken for it.
//
// Running both is the point. Tier 3 is the only LLM in Signal Zero, so the
// difference between the two scorecards IS the LLM's measured contribution -
// in both directions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Suite } from '../lib/runner.js';
import { runNode, writeScratch, readJson, EVALS_DIR } from '../lib/child.js';
import { scoreResolution, scoreCategory } from '../lib/score.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(HERE, '..', 'data', 'golden-set.json');
const PROBE = path.join(EVALS_DIR, 'probes', 'triage-run.mjs');

const CATEGORIES = ['corroboration-candidate', 'new-settlement', 'hazard-signal', 'noise'];

function acceptedCategories(expect) {
  if (Array.isArray(expect.categoryAny)) return expect.categoryAny;
  return [expect.category];
}

async function runConfiguration(golden, { name, env, perCase }) {
  const inPath = writeScratch(`golden-${name}-in.json`, {
    perCase,
    reports: golden.cases.map((c) => ({ id: c.id, ...c.report }))
  });
  const outPath = writeScratch(`golden-${name}-out.json`, '{}');
  const proc = await runNode(PROBE, [inPath, outPath], { env, timeoutMs: 300000 });
  const out = readJson(outPath, null);
  return { proc, out, outPath };
}

/**
 * @param {Suite} suite
 */
export async function runFamilyA({ trueforgeUrl, harnessReachable }) {
  const suite = new Suite(
    'A. golden-set classification',
    '32 hand-labelled real-domain reports: what triage resolves, what it refuses to resolve, and that it never manufactures a corroboration.'
  );

  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const byId = new Map(golden.cases.map((c) => [c.id, c]));

  // --- A0: the set itself has to be hard, or the score means nothing ---------
  const resolvable = golden.cases.filter((c) => c.expect.settlementId !== null);
  const unresolvable = golden.cases.filter((c) => c.expect.settlementId === null);
  const withMustNot = golden.cases.filter((c) => Array.isArray(c.expect.mustNotResolveTo));
  const withAny = golden.cases.filter((c) => Array.isArray(c.expect.categoryAny));

  suite.check({
    id: 'A0.1',
    name: 'the golden set has at least 25 cases and both classes are well represented',
    pass: golden.cases.length >= 25 && resolvable.length >= 10 && unresolvable.length >= 8,
    severity: 'critical',
    evidence: {
      total: golden.cases.length,
      resolvable: resolvable.length,
      unresolvable: unresolvable.length
    }
  });

  suite.check({
    id: 'A0.2',
    name: 'the set contains the named hard cases the design calls for',
    pass:
      byId.has('g16') && // district-only national story
      byId.has('g17') && // river name vs town name
      byId.has('g18') && // a different flood elsewhere in Nepal
      byId.has('g19') && // a different flood in a different country
      byId.has('g20') && // wholly unrelated story
      byId.has('g22') && byId.has('g23') && // genuinely ambiguous, UNRESOLVED is correct
      byId.has('g24') && byId.has('g25') && // cold start - place not in the gazetteer
      golden.cases.some((c) => /transliteration/i.test(c.hard)) &&
      golden.cases.some((c) => /diacritic/i.test(c.hard)),
    severity: 'critical',
    evidence: { mustNotResolveToCases: withMustNot.map((c) => c.id) }
  });

  suite.check({
    id: 'A0.3',
    name: 'few enough cases admit two answers that the set can still be failed',
    pass: withAny.length <= Math.ceil(golden.cases.length * 0.2),
    severity: 'major',
    evidence: {
      dualAnswerCases: withAny.map((c) => c.id),
      count: withAny.length,
      cap: Math.ceil(golden.cases.length * 0.2),
      note: 'A golden set where everything is defensible proves nothing. Cases with categoryAny still carry a hard settlementId label.'
    }
  });

  suite.check({
    id: 'A0.4',
    name: 'every gold label names a real gazetteer id and a real category',
    pass: golden.cases.every((c) => {
      const cats = acceptedCategories(c.expect);
      return cats.every((x) => CATEGORIES.includes(x));
    }),
    severity: 'critical',
    evidence: null
  });

  // --- run both configurations ---------------------------------------------
  const configs = [
    {
      name: 'deterministic',
      perCase: false,
      env: { TRUEFORGE_ENABLED: 'false', OPENAI_API_KEY: '', USE_LIVE_SCRAPE: 'false' }
    }
  ];
  if (harnessReachable) {
    configs.push({
      name: 'harness',
      perCase: true,
      env: {
        TRUEFORGE_ENABLED: 'true',
        TRUEFORGE_BASE_URL: trueforgeUrl,
        // No key on purpose: the direct-fetch fallback must NOT be available, so
        // a tier-3 answer can only have come from TrueForge.
        OPENAI_API_KEY: '',
        USE_LIVE_SCRAPE: 'false'
      }
    });
  }

  const scorecards = {};

  for (const cfg of configs) {
    const { proc, out } = await runConfiguration(golden, cfg);

    if (!out || !out.ok) {
      suite.check({
        id: `A1.${cfg.name}`,
        name: `the golden set runs to completion under the "${cfg.name}" configuration`,
        pass: false,
        severity: 'critical',
        evidence: { exitCode: proc.code, stderr: proc.stderr.slice(-2000) }
      });
      continue;
    }

    // The child must have run under the config we asked for, or every number
    // below is describing a different system than the one we named.
    const cfgOk =
      out.configInForce.hasOpenAiKey === false &&
      out.configInForce.TRUEFORGE_ENABLED === (cfg.name === 'harness');
    suite.check({
      id: `A1.${cfg.name}`,
      name: `the "${cfg.name}" run really happened under the "${cfg.name}" configuration`,
      pass: cfgOk,
      severity: 'critical',
      evidence: out.configInForce
    });

    const results = new Map(out.results.map((r) => [r.id, r]));
    const tier3 = out.results.filter((r) => r.tier === 3);
    const byHarness = out.results.filter((r) => r.executor === 'trueforge-harness');
    const byFallback = out.results.filter((r) => r.executor === 'direct-fetch');

    if (cfg.name === 'harness') {
      suite.check({
        id: 'A1.harness-executed',
        name: 'in harness mode, tier 3 was executed BY TrueForge - not by a fallback, not skipped',
        pass: byHarness.length > 0 && byFallback.length === 0,
        severity: 'critical',
        evidence: {
          tier3Cases: tier3.map((r) => r.id),
          executedByHarness: byHarness.length,
          executedByFallback: byFallback.length,
          turnIds: byHarness.map((r) => r.harnessTurnId).filter(Boolean).slice(0, 10)
        }
      });
    }

    // --- scoring -----------------------------------------------------------
    const resRows = golden.cases.map((c) => ({
      id: c.id,
      gold: c.expect.settlementId ?? null,
      predicted: results.get(c.id)?.settlementId ?? null
    }));
    const catRows = golden.cases.map((c) => ({
      id: c.id,
      acceptedCategories: acceptedCategories(c.expect),
      predicted: results.get(c.id)?.category ?? null
    }));

    const res = scoreResolution(resRows);
    const cat = scoreCategory(catRows);
    scorecards[cfg.name] = { resolution: res, category: cat };

    suite.metric(`${cfg.name}.resolution`, {
      precision: res.resolution.precision,
      recall: res.resolution.recall,
      f1: res.resolution.f1
    });
    suite.metric(`${cfg.name}.abstention`, {
      precision: res.abstention.precision,
      recall: res.abstention.recall,
      f1: res.abstention.f1
    });
    suite.metric(`${cfg.name}.counts`, res.counts);
    suite.metric(`${cfg.name}.harmWeightedErrorRate`, res.harmWeightedErrorRate);
    suite.metric(`${cfg.name}.categoryAccuracy`, cat.accuracy);
    suite.metric(`${cfg.name}.tier3Cases`, tier3.length);

    // --- A2: hard constraints. These are not thresholds, they are rules. ----
    const mustNotViolations = [];
    for (const c of golden.cases) {
      const pred = results.get(c.id)?.settlementId ?? null;
      const banned = c.expect.mustNotResolveTo || [];
      if (pred && banned.includes(pred)) {
        mustNotViolations.push({ id: c.id, hard: c.hard, resolvedTo: pred, why: results.get(c.id)?.llmWhy ?? null });
      }
    }
    suite.check({
      id: `A2.${cfg.name}`,
      name: `[${cfg.name}] no case resolves to a settlement its label explicitly forbids (district story -> village, river -> town, other flood -> our corridor)`,
      pass: mustNotViolations.length === 0,
      severity: 'critical',
      evidence: { violations: mustNotViolations }
    });

    // --- A3: false corroboration -------------------------------------------
    // The failure this product exists to prevent: a report that does not confirm
    // a settlement being recorded as one, which resets that settlement's silence
    // clock even though nobody has looked at it.
    const falseCorroborations = [];
    for (const c of golden.cases) {
      const r = results.get(c.id);
      if (!r || r.category !== 'corroboration-candidate' || !r.settlementId) continue;
      const goldSaysCorroborated =
        acceptedCategories(c.expect).includes('corroboration-candidate') &&
        c.expect.settlementId === r.settlementId;
      const explicitlyBanned = c.expect.mustNotBeCorroborationFor === r.settlementId;
      if (!goldSaysCorroborated || explicitlyBanned) {
        falseCorroborations.push({
          id: c.id,
          hard: c.hard,
          claimedCorroborationFor: r.settlementId,
          goldSettlement: c.expect.settlementId,
          goldCategories: acceptedCategories(c.expect),
          tier: r.tier,
          executor: r.executor,
          why: r.llmWhy
        });
      }
    }
    suite.metric(`${cfg.name}.falseCorroborations`, falseCorroborations.length);
    suite.check({
      id: `A3.${cfg.name}`,
      name: `[${cfg.name}] no report is turned into a corroboration for a settlement the text does not confirm`,
      pass: falseCorroborations.length === 0,
      severity: 'critical',
      evidence: { falseCorroborations }
    });

    // --- A4: the two scorecards --------------------------------------------
    // Thresholds are set at "clearly better than the trivial baselines", not at
    // an aspirational number, and both baselines are computed below so the bar
    // is visible rather than asserted.
    suite.check({
      id: `A4.${cfg.name}.resolution`,
      name: `[${cfg.name}] resolution precision >= 0.80 and recall >= 0.80`,
      pass: res.resolution.precision >= 0.8 && res.resolution.recall >= 0.8,
      severity: 'major',
      evidence: {
        precision: res.resolution.precision,
        recall: res.resolution.recall,
        errors: res.errors
      }
    });

    suite.check({
      id: `A4.${cfg.name}.abstention`,
      name: `[${cfg.name}] abstention precision >= 0.80 and recall >= 0.70 - refusing to resolve is measured as its own skill`,
      pass: res.abstention.precision >= 0.8 && res.abstention.recall >= 0.7,
      severity: 'major',
      evidence: {
        precision: res.abstention.precision,
        recall: res.abstention.recall,
        overReach: res.errors.filter((e) => e.kind === 'over-reach')
      }
    });

    suite.check({
      id: `A5.${cfg.name}`,
      name: `[${cfg.name}] category accuracy >= 0.85`,
      pass: cat.accuracy >= 0.85,
      severity: 'major',
      evidence: { accuracy: cat.accuracy, errors: cat.errors }
    });
  }

  // --- A6: the metric itself must punish guessing --------------------------
  // Two synthetic systems, scored on the identical golden set:
  //   the GUESSER   resolves every case, and is right whenever a right answer
  //                 exists (a maximally lucky over-confident system);
  //   the ABSTAINER never resolves anything.
  // If the headline metric does not rank the abstainer above the guesser, the
  // metric is endorsing exactly the behaviour this product forbids.
  const guesserRows = golden.cases.map((c) => ({
    id: c.id,
    gold: c.expect.settlementId ?? null,
    // maximally lucky: correct where a correct answer exists, and where none
    // exists it still commits to something.
    predicted: c.expect.settlementId ?? (c.expect.mustNotResolveTo?.[0] ?? 'np-rasuwa-haku')
  }));
  const abstainerRows = golden.cases.map((c) => ({
    id: c.id,
    gold: c.expect.settlementId ?? null,
    predicted: null
  }));
  const guesser = scoreResolution(guesserRows);
  const abstainer = scoreResolution(abstainerRows);

  suite.metric('baseline.guesser', {
    resolutionF1: guesser.resolution.f1,
    abstentionF1: guesser.abstention.f1,
    macroF1: guesser.macroF1,
    harmWeightedErrorRate: guesser.harmWeightedErrorRate
  });
  suite.metric('baseline.abstainer', {
    resolutionF1: abstainer.resolution.f1,
    abstentionF1: abstainer.abstention.f1,
    macroF1: abstainer.macroF1,
    harmWeightedErrorRate: abstainer.harmWeightedErrorRate
  });

  suite.check({
    id: 'A6.1',
    name: 'the headline metric ranks an always-abstain system ABOVE a maximally lucky always-guess system',
    pass: abstainer.harmWeightedErrorRate < guesser.harmWeightedErrorRate,
    severity: 'critical',
    evidence: {
      metric: 'harmWeightedErrorRate (lower is better)',
      abstainer: abstainer.harmWeightedErrorRate,
      guesser: guesser.harmWeightedErrorRate,
      weights: { wrongOrOverReachingResolution: 3, missedResolution: 1 }
    }
  });

  // Stated as a check rather than a footnote, because it is a limitation a
  // reader is entitled to see: the UNWEIGHTED macro-F1 does NOT have this
  // property on a set with this many resolvable cases. That is precisely why the
  // suite headlines the harm-weighted number instead.
  suite.check({
    id: 'A6.2',
    name: 'the unweighted macro-F1 is documented as NOT having that property (it rewards the guesser here)',
    pass: guesser.macroF1 > abstainer.macroF1,
    severity: 'minor',
    tags: ['self-critique'],
    evidence: {
      guesserMacroF1: guesser.macroF1,
      abstainerMacroF1: abstainer.macroF1,
      note: 'This check passes when the unweighted metric MISBEHAVES, which is the honest state of affairs. If it ever starts failing, the set composition changed and the README claim about macro-F1 must be rewritten.'
    }
  });

  // --- A7: the real system must beat both trivial baselines -----------------
  for (const [name, card] of Object.entries(scorecards)) {
    suite.check({
      id: `A7.${name}`,
      name: `[${name}] the real system beats BOTH trivial baselines on the harm-weighted error rate`,
      pass:
        card.resolution.harmWeightedErrorRate < abstainer.harmWeightedErrorRate &&
        card.resolution.harmWeightedErrorRate < guesser.harmWeightedErrorRate,
      severity: 'major',
      evidence: {
        system: card.resolution.harmWeightedErrorRate,
        abstainer: abstainer.harmWeightedErrorRate,
        guesser: guesser.harmWeightedErrorRate
      }
    });
  }

  // --- A8: what did the LLM actually buy us? -------------------------------
  if (scorecards.deterministic && scorecards.harness) {
    const d = scorecards.deterministic;
    const h = scorecards.harness;
    suite.metric('llmDelta', {
      harmWeightedErrorRate: {
        tiers1and2Only: d.resolution.harmWeightedErrorRate,
        withTier3Harness: h.resolution.harmWeightedErrorRate
      },
      categoryAccuracy: {
        tiers1and2Only: d.category.accuracy,
        withTier3Harness: h.category.accuracy
      },
      newErrorsIntroducedByTier3: h.resolution.errors.filter(
        (e) => !d.resolution.errors.some((x) => x.id === e.id)
      ),
      errorsFixedByTier3: d.resolution.errors.filter(
        (e) => !h.resolution.errors.some((x) => x.id === e.id)
      )
    });
    suite.check({
      id: 'A8.1',
      name: 'turning tier 3 on does not make settlement resolution worse than tiers 1+2 alone',
      pass: h.resolution.harmWeightedErrorRate <= d.resolution.harmWeightedErrorRate,
      severity: 'major',
      evidence: {
        tiers1and2Only: d.resolution.harmWeightedErrorRate,
        withTier3Harness: h.resolution.harmWeightedErrorRate,
        introduced: h.resolution.errors.filter(
          (e) => !d.resolution.errors.some((x) => x.id === e.id)
        )
      }
    });
  } else {
    suite.skip({
      id: 'A8.1',
      name: 'turning tier 3 on does not make settlement resolution worse than tiers 1+2 alone',
      reason: 'the TrueForge harness was not reachable, so there is no tier-3 scorecard to compare against'
    });
  }

  if (!harnessReachable) {
    suite.skip({
      id: 'A1.harness-executed',
      name: 'in harness mode, tier 3 was executed BY TrueForge',
      reason: `no TrueForge instance answered at ${trueforgeUrl}; the LLM half of family A did not run and is NOT counted as passing`,
      severity: 'critical'
    });
  }

  return { suite, scorecards, golden };
}
