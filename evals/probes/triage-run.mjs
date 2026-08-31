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
const { triage } = await import(new URL('../../src/pipeline/triage.js', import.meta.url));
const { store } = await import(new URL('../../src/store.js', import.meta.url));
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
  for (const r of reports) {
    const before = store.incidents.length;
    await triage([r], gazetteer);
    results.push({
      ...shape(r),
      incidents: store.incidents.slice(0, store.incidents.length - before).map((i) => ({
        kind: i.kind,
        message: i.message,
        detail: i.detail
      }))
    });
  }
} else {
  await triage(reports, gazetteer);
  for (const r of reports) results.push(shape(r));
}

const out = {
  ok: true,
  durationMs: Date.now() - started,
  configInForce: {
    TRUEFORGE_ENABLED: config.TRUEFORGE_ENABLED,
    TRUEFORGE_BASE_URL: config.TRUEFORGE_BASE_URL,
    TRUEFORGE_MODEL: config.TRUEFORGE_MODEL,
    TRUEFORGE_TIMEOUT_MS: config.TRUEFORGE_TIMEOUT_MS,
    hasOpenAiKey: Boolean(config.OPENAI_API_KEY)
  },
  harness: store.harness,
  results,
  incidents: store.incidents.map((i) => ({ kind: i.kind, message: i.message, detail: i.detail }))
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`triage-run: ${results.length} cases in ${out.durationMs}ms`);
