#!/usr/bin/env node
// Signal Zero — THE RESTART TEST.
//
// This is the one measurement that says whether Phase 2 did what it claimed.
//
// WHAT IS BEING PROVED, AND WHY THIS PARTICULAR SETUP
//
// The naive version — boot, note silenceHours, restart, note it again — proves
// nothing here, because the demo corpus re-anchors its timestamps to the current
// clock on every load (src/pipeline/ingest.js reanchorTimestamps). Both the
// persistent and the in-memory build would report the same number, and the test
// would pass on a build with no database at all.
//
// The failure being fixed only shows up when a restart is spanned by a gap in
// incoming reports — which is the realistic case, because a restart is usually
// prompted by the same outage that stopped the reports. So:
//
//   BOOT 1  normal corpus. Reports resolve, observations are written.
//           Record silenceHours and lastReportAt for a settlement.
//   KILL    the process.
//   BOOT 2  SAME database, EMPTY corpus (SIGNAL_ZERO_SEED_PATH -> []).
//           Ingest legitimately returns nothing, as during a source outage.
//
// Persistent build: the silence clock reads the observations table, which still
// holds boot 1's rows, so silence CONTINUES from the same lastReportAt and grows
// by exactly the elapsed wall clock.
//
// In-memory build: nothing survives, `reports` is empty, and rank measures
// silence from the start of an observation window that opened at boot — every
// settlement resets to ~0h with lastReportAt null. The CONTROL boot below runs
// exactly that (boot 2 with DATABASE_URL removed) so the number the test claims
// is a pass is shown next to the number that would have been a failure.
//
// Usage:  node scripts/restart-test.mjs [--port 3311]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.js');

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', '3311'));
const CONTAINER = argOf('--container', 'sz-pg');

// A THROWAWAY DATABASE, created for this run and dropped at the end.
//
// Not the demo database, and this is not tidiness. Boot 1 has to be the ONLY
// completed run in its store: because the ranking is durable now, a process
// booting into a database that already holds a snapshot serves that snapshot
// immediately, and boot 1 would then report a PREVIOUS process's numbers as its
// "before". The test would still pass — the deltas would even look plausible —
// while measuring two runs that were never the two runs it named. An empty
// database makes that impossible rather than merely unlikely.
const DB_NAME = `sz_restart_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const DATABASE_URL = `postgres://signalzero:signalzero@localhost:5544/${DB_NAME}`;

function psql(db, sql) {
  const res = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'signalzero', '-d', db, '-c', sql],
    { encoding: 'utf8' }
  );
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? String(res.error ?? '') };
}

const created = psql('postgres', `CREATE DATABASE ${DB_NAME}`);
if (created.code !== 0) {
  console.error(
    [
      '',
      `Cannot provision a throwaway database (${created.err.trim()}).`,
      `This test needs the "${CONTAINER}" Postgres container up:`,
      `  docker ps --filter name=${CONTAINER}`,
      '',
      'Refusing to fall back to the demo database: boot 1 would inherit the ranking',
      'already stored there and report it as its own "before", so the test would',
      'compare two runs it did not make.',
      ''
    ].join('\n')
  );
  process.exit(2);
}
console.log(`provisioned throwaway database ${DB_NAME}`);

// An empty corpus: a source outage, not an error.
const EMPTY_SEED = path.join(os.tmpdir(), `signal-zero-empty-seed-${process.pid}.json`);
fs.writeFileSync(EMPTY_SEED, '[]');

function boot({ label, env }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      USE_LIVE_SCRAPE: 'false',
      BRIGHTDATA_API_TOKEN: '',
      OPENAI_API_KEY: '',
      TRUEFORGE_ENABLED: 'false',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = { out: '', err: '', exited: null };
  child.stdout.on('data', (d) => {
    log.out += d;
  });
  child.stderr.on('data', (d) => {
    log.err += d;
  });
  child.on('exit', (code) => {
    log.exited = code;
  });
  return { label, child, log };
}

/**
 * Wait for a pass THIS PROCESS ran.
 *
 * `notLastRunAt` matters and is easy to leave out. Since the ranking became
 * durable, a restarted process answers /api/state with the LAST KNOWN ranking
 * immediately — which is the persistence payoff working, and is also exactly how
 * this script would compare boot 1's numbers to boot 1's numbers and print a
 * confident pass. So boot 2 waits for `lastRunAt` to MOVE, not merely to exist.
 */
async function waitForRankedState(base, { timeoutMs = 90000, notLastRunAt = null } = {}) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const json = await res.json();
        last = json;
        const ran = json?.stats?.lastRunAt;
        const isNew = ran && (notLastRunAt === null || ran !== notLastRunAt);
        if (isNew && Array.isArray(json.settlements) && json.settlements.length) return json;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return last;
}

async function stop(server) {
  if (server.log.exited !== null) return;
  server.child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
}

const base = `http://127.0.0.1:${PORT}`;
const rows = [];

function pick(state, settlementId) {
  return (state?.settlements ?? []).find((s) => s.settlementId === settlementId) ?? null;
}

try {
  // ---------------------------------------------------------------- BOOT 1
  console.log('\n=== BOOT 1: normal corpus, Postgres ===');
  const b1 = boot({ label: 'boot1', env: { DATABASE_URL } });
  const s1 = await waitForRankedState(base);
  if (!s1) throw new Error(`boot 1 never produced state.\n${b1.log.out}\n${b1.log.err}`);

  console.log(`persistence: ${s1.persistence.mode} durable=${s1.persistence.durable}`);
  if (!s1.persistence.durable) {
    throw new Error(
      `boot 1 is not durable (${s1.persistence.reason}). The restart test cannot prove anything ` +
        'against a non-durable store — fix the database before reading this result.'
    );
  }

  // A settlement that ACTUALLY HAS an observation: the clock can only be shown
  // to continue for a settlement that has something to continue from. One that
  // has never been heard from is the honest-null case, checked separately below.
  const observed = (s1.settlements ?? []).filter((s) => s.lastReportAt !== null);
  if (observed.length === 0) {
    throw new Error('boot 1 produced no settlement with an observation — nothing to measure.');
  }
  const subject = observed.sort((a, b) => b.silenceHours - a.silenceHours)[0];
  const neverObserved = (s1.settlements ?? []).find((s) => s.lastReportAt === null) ?? null;

  console.log(`subject: ${subject.settlementId} (${subject.name})`);
  console.log(`  BEFORE  silenceHours = ${subject.silenceHours}`);
  console.log(`  BEFORE  lastReportAt = ${subject.lastReportAt}`);
  console.log(`  observations on record = ${s1.stats.observationsKnown}`);
  rows.push({ phase: 'boot1', ...snapshot(subject) });

  const killedAt = Date.now();
  await stop(b1);
  console.log('--- process killed ---');

  // Let real time pass, so "continued accruing" is a measurable claim and not a
  // rounding artefact. 65s puts the delta above 0.01h, which is the precision
  // silenceHours is rounded to.
  const WAIT_MS = Number(argOf('--wait-ms', '65000'));
  console.log(`waiting ${(WAIT_MS / 1000).toFixed(0)}s before restarting...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // ---------------------------------------------------------------- BOOT 2
  console.log('\n=== BOOT 2: EMPTY corpus (source outage), SAME Postgres ===');
  const b2 = boot({
    label: 'boot2',
    env: { DATABASE_URL, SIGNAL_ZERO_SEED_PATH: EMPTY_SEED }
  });
  const s2 = await waitForRankedState(base, { notLastRunAt: s1.stats.lastRunAt });
  if (!s2) throw new Error(`boot 2 never produced state.\n${b2.log.out}\n${b2.log.err}`);
  const after = pick(s2, subject.settlementId);
  const gapHours = (Date.now() - killedAt) / 3_600_000;

  console.log(`persistence: ${s2.persistence.mode} durable=${s2.persistence.durable}`);
  console.log(`  AFTER   silenceHours = ${after?.silenceHours}`);
  console.log(`  AFTER   lastReportAt = ${after?.lastReportAt}`);
  console.log(`  reports this pass = ${s2.stats.reportCount} (expected 0 — outage)`);
  rows.push({ phase: 'boot2-postgres', ...snapshot(after) });
  await stop(b2);

  // ---------------------------------------------------------------- CONTROL
  // The same second boot with NO database. This is what the code did before this
  // phase, and it is printed next to the result so the pass is legible as a
  // difference rather than as an assertion.
  console.log('\n=== CONTROL: same empty-corpus boot with NO DATABASE_URL ===');
  const b3 = boot({
    label: 'control',
    env: { DATABASE_URL: '', SIGNAL_ZERO_SEED_PATH: EMPTY_SEED }
  });
  // No `notLastRunAt`: the control has no store to inherit a run from, so any
  // completed pass it reports is necessarily its own.
  const s3 = await waitForRankedState(base);
  const control = s3 ? pick(s3, subject.settlementId) : null;
  console.log(`persistence: ${s3?.persistence?.mode} durable=${s3?.persistence?.durable}`);
  console.log(`  CONTROL silenceHours = ${control?.silenceHours}`);
  console.log(`  CONTROL lastReportAt = ${control?.lastReportAt}`);
  rows.push({ phase: 'control-memory', ...snapshot(control) });
  await stop(b3);

  // ---------------------------------------------------------------- VERDICT
  const before = subject.silenceHours;
  const now = after?.silenceHours ?? null;
  const grew = now !== null && now > before;
  const sameAnchor = after?.lastReportAt === subject.lastReportAt;
  // The clock should have advanced by roughly the wall time the process was
  // down. Generous tolerance: this is measuring that it CONTINUED, not that two
  // clocks agree to the millisecond.
  const delta = now === null ? null : now - before;
  const plausible = delta !== null && Math.abs(delta - gapHours) < 0.05;
  const controlReset = control !== null && control.lastReportAt === null;

  console.log('\n=== VERDICT ===');
  console.log(`  before                 ${before} h`);
  console.log(`  after restart          ${now} h`);
  console.log(`  delta                  ${delta?.toFixed(4)} h`);
  console.log(`  process was down       ${gapHours.toFixed(4)} h`);
  console.log(`  lastReportAt unchanged ${sameAnchor}`);
  console.log(
    `  control (no database)  ${control?.silenceHours} h, lastReportAt=${control?.lastReportAt}`
  );

  const checks = [
    ['silence continued accruing rather than resetting', grew],
    ['it accrued by the time the process was actually down', plausible],
    ['it continued from the SAME persisted observation', sameAnchor],
    ['the no-database control DOES reset (so the test measures persistence)', controlReset]
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed += 1;
  }

  // Hard rule 4, end to end: a settlement nothing has ever resolved to must
  // reach the API as null — not 0, not a timestamp, not omitted.
  if (neverObserved) {
    console.log(
      `\n  never-observed settlement in boot 1: ${neverObserved.settlementId} ` +
        `lastReportAt=${JSON.stringify(neverObserved.lastReportAt)} ` +
        `coverageBasis=${neverObserved.coverageBasis}`
    );
  }

  console.log('');
  console.log(JSON.stringify({ subject: subject.settlementId, gapHours, rows }, null, 2));
  // SET the exit code, do not exit here. process.exit() terminates immediately
  // and skips `finally`, which is where the throwaway database is dropped — so
  // exiting from inside the try leaked one database per run.
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  try {
    fs.unlinkSync(EMPTY_SEED);
  } catch {
    /* already gone */
  }
  const dropped = psql('postgres', `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  console.log(
    dropped.code === 0
      ? `dropped throwaway database ${DB_NAME}`
      : `WARNING: could not drop ${DB_NAME}: ${dropped.err.trim()}`
  );
}

function snapshot(s) {
  return s
    ? {
        settlementId: s.settlementId,
        silenceHours: s.silenceHours,
        lastReportAt: s.lastReportAt,
        coverageBasis: s.coverageBasis,
        reportCount: s.reportCount
      }
    : null;
}
