#!/usr/bin/env node
// Signal Zero evaluation suite - entry point.
//
//   npm run eval                 everything (needs TrueForge + docker for full coverage)
//   npm run eval -- --family B   one family
//   npm run eval -- --offline    skip everything that needs a live dependency
//   npm run eval -- --verbose    print passing cases too
//   npm run eval -- --strict     a SKIP is a failure (use this in CI)
//
// Exit code is 0 only when every case that ran passed and, under --strict, only
// when nothing was skipped. A skipped case is never counted as a pass: the
// summary prints it, the JSON report records it, and the exit line names it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { C, renderSuite } from './lib/runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(HERE, 'report');

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const opts = {
  families: (val('--family', 'ABCD') || 'ABCD').toUpperCase(),
  offline: has('--offline'),
  verbose: has('--verbose'),
  strict: has('--strict'),
  allowDocker: !has('--no-docker') && !has('--offline'),
  trueforgeUrl: val(
    '--trueforge',
    process.env.TRUEFORGE_BASE_URL || 'http://localhost:4000'
  ).replace(/\/+$/, ''),
  dockerContainer: val('--container', 'tforge'),
  basePort: Number(val('--port', '3199'))
};

// Every family must run against a KNOWN configuration, not against whatever
// .env happens to hold. These are set before any src/ module is imported.
process.env.USE_LIVE_SCRAPE = process.env.EVAL_ALLOW_LIVE_SCRAPE === '1' ? 'true' : 'false';
process.env.BRIGHTDATA_API_TOKEN =
  process.env.EVAL_ALLOW_LIVE_SCRAPE === '1' ? process.env.BRIGHTDATA_API_TOKEN || '' : '';
process.env.OPENAI_API_KEY = '';
process.env.TRUEFORGE_ENABLED = 'false';

// --- is the harness actually there? ----------------------------------------
async function probeTrueforge(url) {
  if (opts.offline) return { reachable: false, reason: '--offline' };
  try {
    const res = await fetch(`${url}/api/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { reachable: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const models = (json?.data || []).map((m) => m?.name).filter(Boolean);
    const want = process.env.EVAL_TRUEFORGE_MODEL || 'nebius/signal-zero-triage';
    if (!models.includes(want)) {
      return {
        reachable: false,
        reason: `model "${want}" not registered (have: ${models.join(', ') || 'none'})`,
        models
      };
    }
    return { reachable: true, reason: null, models };
  } catch (err) {
    return { reachable: false, reason: String(err.message || err) };
  }
}

// --- go ---------------------------------------------------------------------
const startedAt = Date.now();
const tf = await probeTrueforge(opts.trueforgeUrl);

console.log('');
console.log(C.bold('  SIGNAL ZERO - EVALUATION SUITE'));
console.log(
  C.dim(
    `  families: ${opts.families}   trueforge: ${opts.trueforgeUrl} -> ${tf.reachable ? 'reachable' : `UNREACHABLE (${tf.reason})`}`
  )
);
console.log(
  C.dim(
    `  docker: ${opts.allowDocker ? `enabled (container "${opts.dockerContainer}")` : 'disabled'}   strict: ${opts.strict}`
  )
);
if (!tf.reachable) {
  console.log(
    C.yellow(
      '  WARNING: the LLM half of families A and C cannot run. Those cases will be SKIPPED, not passed.'
    )
  );
}

const suites = [];
let port = opts.basePort;

if (opts.families.includes('A')) {
  const { runFamilyA } = await import('./families/a-golden-set.js');
  const { suite } = await runFamilyA({
    trueforgeUrl: opts.trueforgeUrl,
    harnessReachable: tf.reachable
  });
  suites.push(suite);
  renderSuite(suite, opts);
}

if (opts.families.includes('B')) {
  const { runFamilyB } = await import('./families/b-properties.js');
  const { suite } = await runFamilyB();
  suites.push(suite);
  renderSuite(suite, opts);
}

if (opts.families.includes('C')) {
  const { runFamilyC } = await import('./families/c-guardrails.js');
  const { suite } = await runFamilyC({
    trueforgeUrl: opts.trueforgeUrl,
    harnessReachable: tf.reachable,
    port: port++
  });
  suites.push(suite);
  renderSuite(suite, opts);
}

if (opts.families.includes('D')) {
  const { runFamilyD } = await import('./families/d-resilience.js');
  const { suite } = await runFamilyD({
    trueforgeUrl: opts.trueforgeUrl,
    port: port++,
    dockerContainer: opts.dockerContainer,
    allowDocker: opts.allowDocker
  });
  suites.push(suite);
  renderSuite(suite, opts);
}

// --- summary ----------------------------------------------------------------
const all = suites.flatMap((s) => s.cases);
const failed = all.filter((c) => c.status === 'fail');
const skipped = all.filter((c) => c.status === 'skip');
const passed = all.filter((c) => c.status === 'pass');
const criticalFails = failed.filter((c) => c.severity === 'critical');

console.log('');
console.log(C.bold('  SUMMARY'));
for (const s of suites) {
  const x = s.summary();
  const tag = x.fail ? C.red('FAIL') : x.skip ? C.yellow('PART') : C.green(' OK ');
  console.log(
    `  ${tag}  ${s.family.padEnd(36)} ${x.pass}/${x.total} pass, ${x.fail} fail, ${x.skip} skip`
  );
}
console.log('');
console.log(
  `  ${passed.length} passed, ${failed.length} failed (${criticalFails.length} critical), ${skipped.length} skipped`
);

if (failed.length) {
  console.log('');
  console.log(C.red('  FAILURES'));
  for (const f of failed)
    console.log(`    ${f.severity.toUpperCase().padEnd(8)} ${f.id}  ${f.name}`);
}
if (skipped.length) {
  console.log('');
  console.log(C.yellow('  SKIPPED (not passed - these proved nothing)'));
  for (const s of skipped) console.log(`    ${s.id}  ${s.name}\n      ${C.dim(s.evidence.reason)}`);
}

// --- machine-readable report ------------------------------------------------
fs.mkdirSync(REPORT_DIR, { recursive: true });
const report = {
  suite: 'signal-zero-evals',
  version: 1,
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  options: opts,
  environment: {
    node: process.version,
    platform: process.platform,
    trueforge: { url: opts.trueforgeUrl, ...tf }
  },
  totals: {
    total: all.length,
    passed: passed.length,
    failed: failed.length,
    skipped: skipped.length,
    criticalFailures: criticalFails.length
  },
  families: suites.map((s) => ({
    family: s.family,
    proves: s.proves,
    summary: s.summary(),
    metrics: s.metrics,
    notes: s.notes,
    cases: s.cases
  }))
};
const reportPath = path.join(REPORT_DIR, 'latest.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log('');
console.log(C.dim(`  machine-readable report: ${reportPath}`));

const exitCode = failed.length > 0 || (opts.strict && skipped.length > 0) ? 1 : 0;
console.log(
  exitCode === 0
    ? C.green(
        `  RESULT: pass${skipped.length ? ` (with ${skipped.length} skipped - re-run with --strict to treat those as failures)` : ''}`
      )
    : C.red(`  RESULT: fail`)
);
console.log('');
process.exit(exitCode);
