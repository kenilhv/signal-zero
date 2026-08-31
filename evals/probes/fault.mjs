// Child-process probe: inject ONE fault into the TrueForge dependency, run the
// real triage stage against it, and report exactly what the system did.
//
// The question this answers is the AgentBreak question: not "does it work", but
// "what happens AFTER the fault". So the output records, for every case:
//   - whether the process survived at all
//   - how long the fault took to be given up on (a hang is a failure mode)
//   - what the incident feed says, in the system's own words
//   - whether an unresolved classification was left honestly unresolved, or
//     quietly invented
//
// env: FAULT_MODE  one of trueforge-stub.js MODES, or 'dead-port'
//      TRUEFORGE_TIMEOUT_MS / TRUEFORGE_POLL_MS as usual

import fs from 'node:fs';
import { startStub, findDeadPort } from '../lib/trueforge-stub.js';

const outPath = process.argv[2];
const mode = process.env.FAULT_MODE || 'healthy';

let stub = null;
let baseUrl;
if (mode === 'dead-port') {
  baseUrl = `http://127.0.0.1:${await findDeadPort()}`;
} else if (mode === 'real') {
  // No stub at all: talk to whatever is (or is not) at TRUEFORGE_BASE_URL. Used
  // by the real-container stop/restart case.
  baseUrl = process.env.TRUEFORGE_BASE_URL || 'http://localhost:4000';
} else {
  stub = await startStub({ mode });
  baseUrl = stub.url;
}

process.env.TRUEFORGE_BASE_URL = baseUrl;
process.env.TRUEFORGE_ENABLED = 'true';
process.env.OPENAI_API_KEY = ''; // no fallback: the harness is the only executor
process.env.USE_LIVE_SCRAPE = 'false';

const { triage } = await import(new URL('../../src/pipeline/triage.js', import.meta.url));
const { store } = await import(new URL('../../src/store.js', import.meta.url));
const harness = await import(new URL('../../src/harness/trueforge.js', import.meta.url));
const gazetteer = JSON.parse(
  fs.readFileSync(new URL('../../src/data/gazetteer.json', import.meta.url), 'utf8')
);

// Two reports engineered to land in the tier-3 residual: on-hazard, but with no
// gazetteer name the deterministic tiers can attach them to.
const now = Date.now();
const reports = [
  {
    id: 'f1',
    sourceType: 'news',
    sourceName: 'The Guardian',
    url: 'https://example.test/f1',
    title: 'Nearly 1,400 missing after Nepal-Tibet flash flood',
    text: 'At least 356 people are confirmed dead and nearly 1,400 missing after a flash flood swept down from the Nepal-Tibet border. The worst-affected area is Rasuwa district. Rescue efforts continue.',
    publishedAt: new Date(now - 3 * 3600 * 1000).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    settlementId: null,
    triage: null,
    clusterId: null
  },
  {
    id: 'f2',
    sourceType: 'social',
    sourceName: 'Reddit r/Nepal',
    url: 'https://example.test/f2',
    title: 'Several upstream hamlets still unreachable',
    text: 'Several upstream hamlets remain unreachable four days on. No word from any of them.',
    publishedAt: new Date(now - 2 * 3600 * 1000).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    settlementId: null,
    triage: null,
    clusterId: null
  }
];

const started = Date.now();
let threw = null;
try {
  await triage(reports, gazetteer);
} catch (err) {
  // triage() throwing at all is itself the finding: a dependency fault must not
  // be able to take a pipeline stage down.
  threw = String(err && err.stack ? err.stack : err);
}
const elapsedMs = Date.now() - started;

const out = {
  mode,
  baseUrl,
  survived: threw === null,
  threw,
  elapsedMs,
  stubCalls: stub ? stub.calls.map((c) => `${c.method} ${c.path}`) : [],
  telemetry: harness.getTelemetry(),
  storeHarness: store.harness,
  reports: reports.map((r) => ({
    id: r.id,
    settlementId: r.settlementId,
    category: r.triage?.category ?? null,
    confidence: r.triage?.confidence ?? null,
    tier: r.triage?.tier ?? null,
    executor: r.triage?.executor ?? null,
    matchedOn: r.triage?.matchedOn ?? null,
    llmWhy: r.triage?.signals?.llmWhy ?? null,
    triage: r.triage
  })),
  incidents: store.incidents.map((i) => ({ kind: i.kind, message: i.message, detail: i.detail }))
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
if (stub) await stub.close();
console.log(
  `fault[${mode}]: survived=${out.survived} elapsed=${elapsedMs}ms incidents=${out.incidents.length}`
);
