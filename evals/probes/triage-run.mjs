// Child-process probe: run src/pipeline/triage.js over a batch of reports under
// a controlled configuration, and print the result as one JSON document.
//
// WHY A CHILD PROCESS. src/config.js reads process.env once, at module-eval
// time, so "run the same golden set with the harness on, then with it off"
// cannot be done inside one process without lying about which config was in
// force. Each configuration therefore gets its own process, and the config the
// child actually resolved is echoed back in the output so the parent can assert
// the run happened under the settings it asked for.
//
// Usage:  node triage-run.mjs <input.json> <output.json>
//   input.json  = { perCase: bool, reports: [ {id, ...report} ] }
//   env         = TRUEFORGE_ENABLED / TRUEFORGE_BASE_URL / OPENAI_API_KEY / ...

import fs from 'node:fs';
import path from 'node:path';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: triage-run.mjs <input.json> <output.json>');
  process.exit(2);
}

const input = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const config = (await import(new URL('../../src/config.js', import.meta.url))).default;
const { triage, MAX_LLM_CALLS } = await import(
  new URL('../../src/pipeline/triage.js', import.meta.url)
);
const { store, recentIncidents, initBackend } = await import(
  new URL('../../src/store.js', import.meta.url)
);
// The store is forced into its NON-DURABLE mode here. This probe measures triage
// behaviour, which both backends are required to agree on, and pointing it at the
// shared Postgres would leave this probe's incidents in a table other eval
// scenarios read. The incident FEED is read through recentIncidents(), which
// flushes pending writes first — `store.incidents` is an outbox that drains as
// writes land, so slicing it across an `await` would under-report.
process.env.DATABASE_URL = '';
await initBackend({ logger: null });
const gazetteer = JSON.parse(
  fs.readFileSync(new URL('../../src/data/gazetteer.json', import.meta.url), 'utf8')
);

const started = Date.now();
const results = [];

function shape(r) {
  return {
    id: r.id,
    settlementId: r.settlementId ?? null,
    category: r.triage?.category ?? null,
    confidence: r.triage?.confidence ?? null,
    tier: r.triage?.tier ?? null,
    executor: r.triage?.executor ?? null,
    matchedOn: r.triage?.matchedOn ?? null,
    llmWhy: r.triage?.signals?.llmWhy ?? null,
    harnessTurnId: r.triage?.harness?.turnId ?? null,
    // src/guardrails writes this when it blocks a report at input or output.
    guardrail: r.triage?.guardrail ?? null,
    signals: r.triage?.signals ?? null
  };
}

function materialise(spec, i) {
  const now = Date.now();
  return {
    id: spec.id || `case-${i}`,
    sourceType: spec.sourceType || 'news',
    sourceName: spec.sourceName || 'Test Source',
    url: spec.url || `https://example.test/${spec.id || i}`,
    title: spec.title || '',
    text: spec.text || '',
    publishedAt:
      spec.publishedAt === null
        ? null
        : spec.publishedAt || new Date(now - 3600 * 1000).toISOString(),
    fetchedAt: spec.fetchedAt || new Date(now).toISOString(),
    settlementId: null,
    triage: null,
    clusterId: null
  };
}

const reports = input.reports.map(materialise);

if (input.perCase) {
  // One triage() call per case. Slower, but it is the only way to give every
  // case its own tier-3 budget - triage caps tier 3 at 6 classifications per
  // call, so batching would silently starve most of the set of the LLM path and
  // then report the result as if the LLM had been consulted.
  // Diff the feed BY ID rather than by length. Lengths only work for an
  // append-only array that nothing else touches; ids work regardless of ordering,
  // flush timing, or anything else writing concurrently.
  let seen = new Set((await recentIncidents({ limit: 500 })).map((i) => i.id));
  for (const r of reports) {
    await triage([r], gazetteer);
    const feed = await recentIncidents({ limit: 500 });
    results.push({
      ...shape(r),
      incidents: feed
        .filter((i) => !seen.has(i.id))
        .map((i) => ({ kind: i.kind, message: i.message, detail: i.detail }))
    });
    seen = new Set(feed.map((i) => i.id));
  }
} else {
  await triage(reports, gazetteer);
  for (const r of reports) results.push(shape(r));
}

const out = {
  ok: true,
  durationMs: Date.now() - started,
  // ECHOED, NOT ASSUMED. The parent asked for a batching mode and a case count;
  // this is what the child actually did. They can differ - a caller that forgets
  // `perCase` still gets a full-looking result set, just one where triage's
  // tier-3 cap silently starved most of the cases of the model. The parent
  // asserts on these fields so that failure is named instead of being read as
  // bad model behaviour.
  probeConfig: {
    perCase: Boolean(input.perCase),
    caseCount: reports.length,
    maxLlmCallsPerTriageCall: MAX_LLM_CALLS,
    // With perCase the budget is per case; without it, one budget for the lot.
    tier3BudgetForThisRun: input.perCase ? MAX_LLM_CALLS * reports.length : MAX_LLM_CALLS
  },
  configInForce: {
    TRUEFORGE_ENABLED: config.TRUEFORGE_ENABLED,
    TRUEFORGE_BASE_URL: config.TRUEFORGE_BASE_URL,
    TRUEFORGE_MODEL: config.TRUEFORGE_MODEL,
    TRUEFORGE_TIMEOUT_MS: config.TRUEFORGE_TIMEOUT_MS,
    hasOpenAiKey: Boolean(config.OPENAI_API_KEY)
  },
  harness: store.harness,
  results,
  incidents: (await recentIncidents({ limit: 500 })).map((i) => ({
    kind: i.kind,
    message: i.message,
    detail: i.detail
  }))
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`triage-run: ${results.length} cases in ${out.durationMs}ms`);
