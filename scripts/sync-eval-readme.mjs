#!/usr/bin/env node
// Regenerate the RESULTS block in evals/README.md from evals/report/latest.json.
//
// WHY THIS EXISTS: those numbers were hand-written once and then drifted. The
// README claimed "138 checks" and a harm-weighted error rate of 0.281 vs 0.375
// long after the suite had grown to 157 checks and the rate had moved to
// 0.1875 vs 0.1875. Nobody lied; a human copied a number and the number moved.
//
// So the numbers are no longer written by a human. They are generated from the
// report, and `--check` asserts the file on disk matches what the latest report
// would produce. Wire that into CI and a stale claim fails the build instead of
// surviving in prose.
//
//   node scripts/sync-eval-readme.mjs           rewrite the block
//   node scripts/sync-eval-readme.mjs --check   exit 1 if it is stale
//
// The block is delimited by the markers below. Everything outside them is
// hand-written prose and is never touched.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'evals', 'report', 'latest.json');
const README = path.join(ROOT, 'evals', 'README.md');

const BEGIN =
  '<!-- BEGIN GENERATED RESULTS -- edit scripts/sync-eval-readme.mjs, not this block -->';
const END = '<!-- END GENERATED RESULTS -->';

const checkOnly = process.argv.includes('--check');

function fail_(msg) {
  console.error(`sync-eval-readme: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(REPORT)) {
  fail_(`no report at ${path.relative(ROOT, REPORT)} - run \`npm run eval\` first.`);
}

const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const t = report.totals ?? {};
const A = (report.families ?? []).find((f) => String(f.family).startsWith('A'));
const delta = A?.metrics?.llmDelta ?? null;

function pct(n) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
}
function num(n, dp = 4) {
  return Number.isFinite(n) ? n.toFixed(dp) : '—';
}

// Each family carries its own `summary` {total, pass, fail, skip}; `cases` is the
// per-check detail. Recompute from `cases` and cross-check against `summary`, so a
// divergence between the two is a loud failure rather than a quietly wrong table.
const famRows = (report.families ?? [])
  .map((f) => {
    const cases = f.cases ?? [];
    const pass = cases.filter((c) => c.status === 'pass').length;
    const fail = cases.filter((c) => c.status === 'fail').length;
    const skip = cases.filter((c) => c.status === 'skip').length;
    const s = f.summary ?? {};
    if (
      Number.isFinite(s.total) &&
      (s.total !== cases.length || s.pass !== pass || s.fail !== fail || s.skip !== skip)
    ) {
      fail_(
        `family "${f.family}" disagrees with its own summary: ` +
          `cases say ${pass}/${fail}/${skip} of ${cases.length}, ` +
          `summary says ${s.pass}/${s.fail}/${s.skip} of ${s.total}.`
      );
    }
    return `| ${f.family} | ${pass}/${cases.length} | ${fail} | ${skip} |`;
  })
  .join('\n');

// The tier-3 comparison is the most load-bearing claim in this file, so it is
// stated as whatever the run measured - including "no difference", which is a
// result about the LLM and not a gap in the harness.
let tier3Block;
if (delta) {
  const before = delta.harmWeightedErrorRate?.tiers1and2Only;
  const after = delta.harmWeightedErrorRate?.withTier3Harness;
  const accBefore = delta.categoryAccuracy?.tiers1and2Only;
  const accAfter = delta.categoryAccuracy?.withTier3Harness;
  const fixed = (delta.errorsFixedByTier3 ?? []).length;
  const introduced = (delta.newErrorsIntroducedByTier3 ?? []).length;

  const verdict =
    before === after && fixed === 0 && introduced === 0
      ? `On this run tier 3 changed the harm-weighted error rate by **nothing at all** — it fixed ${fixed} errors and introduced ${introduced}. ` +
        `Category accuracy moved ${num(accBefore, 4)} → ${num(accAfter, 4)}. The deterministic tiers already resolved ` +
        `everything they could resolve correctly, and the model tier neither rescued nor damaged that. ` +
        `That is a finding about the value of the LLM on this task, not a defect in the harness that ran it.`
      : after > before
        ? `On this run tier 3 made the harm-weighted error rate **worse**: ${num(before)} → ${num(after)} ` +
          `(fixed ${fixed}, introduced ${introduced}). Published because it is what was measured.`
        : `On this run tier 3 improved the harm-weighted error rate ${num(before)} → ${num(after)} ` +
          `(fixed ${fixed}, introduced ${introduced}).`;

  tier3Block =
    `| measure | tiers 1+2 only | with live tier 3 |\n` +
    `|---|---|---|\n` +
    `| harm-weighted error rate (lower is better) | **${num(before)}** | **${num(after)}** |\n` +
    `| category accuracy | ${num(accBefore, 4)} | ${num(accAfter, 4)} |\n\n` +
    verdict;
} else {
  tier3Block = '_No `llmDelta` metric in the latest report._';
}

const generated = [
  BEGIN,
  '',
  `<!-- generated ${new Date(report.finishedAt ?? Date.now()).toISOString()} from evals/report/latest.json -->`,
  '',
  `**${t.total ?? 0} checks across ${(report.families ?? []).length} families** — ` +
    `${t.passed ?? 0} passed, ${t.failed ?? 0} failed ` +
    `(${t.criticalFailures ?? 0} critical), ${t.skipped ?? 0} skipped. ` +
    `Wall clock ${((report.durationMs ?? 0) / 1000).toFixed(1)}s on ` +
    `Node ${report.environment?.node ?? '?'} / ${report.environment?.platform ?? '?'}.`,
  '',
  `TrueForge reachable during this run: **${report.environment?.trueforge?.reachable ? 'yes' : 'no'}**` +
    (report.environment?.trueforge?.reachable
      ? ` (${(report.environment.trueforge.models ?? []).join(', ') || 'no models listed'}).`
      : ` — live cases were skipped.`),
  '',
  '| family | passed | failed | skipped |',
  '|---|---|---|---|',
  famRows,
  '',
  '### What tier 3 is actually worth',
  '',
  tier3Block,
  '',
  END
].join('\n');

const current = fs.readFileSync(README, 'utf8');
const i = current.indexOf(BEGIN);
const j = current.indexOf(END);

let next;
if (i === -1 || j === -1) {
  fail_(
    `markers not found in ${path.relative(ROOT, README)}. Add these two lines where the results belong:\n  ${BEGIN}\n  ${END}`
  );
} else {
  next = current.slice(0, i) + generated + current.slice(j + END.length);
}

if (checkOnly) {
  if (next === current) {
    console.log('sync-eval-readme: evals/README.md is in sync with the latest report.');
    process.exit(0);
  }
  fail_(
    'evals/README.md is STALE relative to evals/report/latest.json.\n' +
      '  Run:  node scripts/sync-eval-readme.mjs\n' +
      '  Then commit the result.'
  );
}

fs.writeFileSync(README, next);
console.log(
  `sync-eval-readme: wrote ${t.total ?? 0} checks / ${t.passed ?? 0} passed into evals/README.md`
);
