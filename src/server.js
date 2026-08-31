// Signal Zero - HTTP server + pipeline orchestrator.
//
// One Express app serves both the JSON API and the static frontend in /web.
// One pipeline pass runs on boot so the dashboard has data the moment it loads.
//
// Pipeline order is fixed: ingest -> triage -> dedup -> observe -> rank -> checkpoint ->
// persist. A stage that throws is NEVER allowed to kill the process: it is caught, written
// to the incident feed (that feed is the product, not an afterthought), and the run
// continues with whatever data survived.
//
// THE HTTP CONTRACT LIVES IN src/http/ AND IS DESCRIBED IN openapi.yaml.
//
//   problem.js       RFC 9457 problem details. ONE error shape, with `type` URIs that
//                    actually dereference at GET /problems/{slug}.
//   idempotency.js   Stripe's Idempotency-Key convention (NOT a standard — the IETF
//                    draft expired) on the three routes that change something.
//   pagination.js    Keyset paging for the incident feed, which is unbounded now that
//                    the 200-item ring buffer is gone.
//   run-progress.js  Progress of the in-flight pass. POST /api/run answers 202 and the
//                    pass proceeds; this is what GET /api/state reports as `run`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import config from './config.js';
import { idempotency } from './http/idempotency.js';
import {
  INCIDENT_PAGE_SIZE_DEFAULT,
  INCIDENT_PAGE_SIZE_MAX,
  parseCursorParam,
  parsePageSize,
  STATE_INCIDENT_PAGE_SIZE_DEFAULT,
  STATE_INCIDENT_PAGE_SIZE_MAX
} from './http/pagination.js';
import {
  PROBLEM_BASE_PATH,
  ProblemError,
  problemFromError,
  problemRegistryRouter,
  sendProblem
} from './http/problem.js';
import * as runProgress from './http/run-progress.js';
import {
  approve,
  buildShortlist,
  createAmbiguousMatch,
  createEscalation,
  getCheckpointItem,
  listDecisions,
  reject
} from './pipeline/checkpoint.js';
import {
  addIncident,
  beginPass,
  flushIncidents,
  initBackend,
  persistence,
  persistenceBanner,
  repos,
  setCurrentRunId,
  store,
  unpersistedIncidentCount
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(__dirname, 'data');

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[signal-zero] could not read ${file}: ${err.message}`);
    return fallback;
  }
}

const gazetteer = readJson(path.join(DATA_DIR, 'gazetteer.json'), []);
const corridor = readJson(path.join(DATA_DIR, 'corridor.json'), {});

// ---------------------------------------------------------------------------
// Pipeline stage loading
// ---------------------------------------------------------------------------
// The four upstream stages are written by other hands in parallel. We resolve each
// stage's exported entry point by name, and if a module is missing or renamed we degrade
// that single stage instead of refusing to boot. Every degrade is logged to the fail feed.

const stageModules = { ingest: null, triage: null, dedup: null, rank: null };

async function loadStages() {
  const specs = [
    ['ingest', './pipeline/ingest.js'],
    ['triage', './pipeline/triage.js'],
    ['dedup', './pipeline/dedup.js'],
    ['rank', './pipeline/rank.js']
  ];
  for (const [name, spec] of specs) {
    try {
      stageModules[name] = await import(spec);
    } catch (err) {
      stageModules[name] = null;
      console.warn(`[signal-zero] stage "${name}" unavailable: ${err.message}`);
      addIncident('degraded-source', `Pipeline stage "${name}" could not be loaded`, {
        stage: name,
        module: spec,
        error: err.message
      });
    }
  }
}

/** Find the first export on `mod` matching one of `names`. */
function pick(mod, names) {
  if (!mod) return null;
  for (const n of names) {
    if (typeof mod[n] === 'function') return mod[n];
    if (mod.default && typeof mod.default[n] === 'function')
      return mod.default[n].bind(mod.default);
  }
  if (typeof mod.default === 'function') return mod.default;
  return null;
}

// Normalizers: each stage may return a bare array or a wrapper object.
function asReports(result, previous) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.reports)) return result.reports;
  return previous;
}

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

// The single-flight guard used to be a bare `let running = false` in this file.
// It now lives in src/http/run-progress.js, because the same fact answers two
// questions that must never disagree: whether POST /api/run may start a pass, and
// what GET /api/state reports as `run`. Two booleans for one fact is how a UI
// ends up showing "idle" while a pass is running.

const MAX_ESCALATIONS_PER_RUN = 8;
const MAX_AMBIGUOUS_PER_RUN = 12;

// Mirror of rank.js's escalation thresholds, used ONLY if the rank stage failed
// to load. Kept explicit and named so the rule is readable from here too: the
// evidence for "anomalously silent" is about the SETTLEMENT (how long it has
// been quiet relative to its own expected cadence), not about its neighbours.
const ESCALATION_MIN_SURPRISAL_NATS = 3.0; // e^-3 ~= a 5% wait; == 3x its expected gap
const ESCALATION_MIN_SILENCE_HOURS = 6; // absolute wall-clock floor

function fallbackEscalationGate(s) {
  return (
    Number(s.silenceHours) >= ESCALATION_MIN_SILENCE_HOURS &&
    Number(s.surprisal) >= ESCALATION_MIN_SURPRISAL_NATS &&
    Number(s.ownZScore) > 0
  );
}

let runSeq = 0;

function mintRunId() {
  return `run-${Date.now().toString(36)}-${process.pid.toString(36)}-${(runSeq++).toString(36)}`;
}

/**
 * REPORTS -> OBSERVATIONS. The write that makes the silence clock durable.
 *
 * An observation is a CONFIRMING SIGHTING: a report that resolved to a named
 * settlement at a known time. The three filters below are each a place where the
 * honest thing is to write nothing:
 *
 *   no settlementId   the report never resolved. It is evidence about the world,
 *                     but not about any particular settlement, so it cannot end
 *                     anyone's silence.
 *   no usable time    src/db/repositories/observations.js REFUSES to guess one,
 *                     and so does this: a report stamped with the fetch instant
 *                     because its "2 days ago" would not parse is a wrong
 *                     timestamp, and a wrong timestamp is a wrong silence score.
 *                     The settlement correctly stays silent.
 *   guardrail-blocked a report whose content was rejected as a prompt-injection
 *                     attempt is left UNRESOLVED upstream, so it has no
 *                     settlementId and is already excluded — but the intent is
 *                     stated here because the alternative (crediting an attacker
 *                     with ending a settlement's silence) is the whole reason the
 *                     guardrail exists.
 *
 * Append-only: this NEVER updates or deletes. Re-observing the same report in a
 * later run appends a second row, which is correct — it is a second sighting,
 * and the clock reads the newest one either way.
 */
function observationsFromReports(reports, knownSettlementIds) {
  const out = [];
  const skipped = { unresolved: 0, unknownSettlement: 0, noTimestamp: 0 };
  for (const r of Array.isArray(reports) ? reports : []) {
    if (!r?.settlementId) {
      skipped.unresolved += 1;
      continue;
    }
    if (!knownSettlementIds.has(r.settlementId)) {
      // A settlement id we have no gazetteer row for would violate the foreign
      // key. Dropping it loudly beats letting one bad id abort the whole batch.
      skipped.unknownSettlement += 1;
      continue;
    }
    const when = r.publishedAt ?? r.fetchedAt ?? null;
    const t = when === null ? null : new Date(when);
    if (!t || Number.isNaN(t.getTime())) {
      skipped.noTimestamp += 1;
      continue;
    }
    out.push({
      settlementId: r.settlementId,
      observedAt: t.toISOString(),
      sourceName: r.sourceName ?? '',
      sourceType: r.sourceType ?? '',
      reportId: r.id ?? null,
      clusterId: r.clusterId ?? null,
      url: r.url ?? null,
      title: r.title ?? null
    });
  }
  return { observations: out, skipped };
}

/**
 * Claim the single-flight slot and mint a run id. SYNCHRONOUS on purpose.
 *
 * POST /api/run has to decide between 202 and 409 before it answers, and two
 * requests arriving in the same event-loop turn must not both be told they
 * started a pass. Everything up to the slot being claimed happens without an
 * await, so the check and the claim cannot interleave.
 */
export function acceptPipelineRun({ trigger = 'api' } = {}) {
  const busy = runProgress.inFlight();
  if (busy) {
    return { accepted: false, runId: busy.runId, startedAt: busy.startedAt, stage: busy.stage };
  }
  const runId = mintRunId();
  runProgress.beginRun(runId, { trigger });
  return { accepted: true, runId, startedAt: runProgress.inFlight().startedAt, stage: null };
}

/**
 * Run one pass to completion for a run id that has ALREADY been accepted.
 *
 * Split from runPipeline() so the same body serves both callers: the boot pass
 * and the tests, which await the whole thing, and POST /api/run, which answers
 * 202 first and lets this finish afterwards. There is exactly one pipeline
 * implementation; the two entry points differ only in when they stop waiting.
 */
async function executePipeline(runId) {
  const started = Date.now();
  setCurrentRunId(runId);

  try {
    beginPass();
    await repos.runs.start(runId);

    // The gazetteer is reference data: upsert it, then read the settlements back
    // FROM THE STORE rather than from the file. Everything downstream — the
    // observations foreign key, the ranked snapshot join — is keyed on the rows
    // that actually exist, so reading them back is what keeps those in step.
    await repos.settlements.upsertMany(gazetteer);
    store.settlements = await repos.settlements.listAll();
    if (store.settlements.length === 0) store.settlements = gazetteer;

    // --- 1. INGEST -------------------------------------------------------
    // Every markStage() below sits at the point the stage ACTUALLY BEGINS. None
    // of them is interpolated from elapsed time or advanced by a timer: the
    // frontend's stage rail is allowed to name a stage only because the server
    // observed it starting.
    runProgress.markStage('ingest');
    let reports = store.reports;
    const ingestFn = pick(stageModules.ingest, [
      'ingest',
      'runIngest',
      'ingestReports',
      'fetchReports'
    ]);
    if (ingestFn) {
      try {
        reports = asReports(await ingestFn(store.settlements, config), []);
      } catch (err) {
        addIncident('degraded-source', `Ingest failed: ${err.message}`, {
          stage: 'ingest',
          error: err.message
        });
        reports = [];
      }
    }
    store.reports = Array.isArray(reports) ? reports : [];

    // --- 2. TRIAGE -------------------------------------------------------
    runProgress.markStage('triage');
    const triageFn = pick(stageModules.triage, [
      'triage',
      'runTriage',
      'triageReports',
      'classify'
    ]);
    if (triageFn) {
      try {
        store.reports = asReports(
          await triageFn(store.reports, store.settlements, config),
          store.reports
        );
      } catch (err) {
        addIncident('degraded-source', `Triage failed: ${err.message}`, {
          stage: 'triage',
          error: err.message
        });
      }
    }

    // --- 3. DEDUP --------------------------------------------------------
    // Deterministic Fellegi-Sunter. No LLM here, by design.
    runProgress.markStage('dedup');
    let ambiguousPairs = [];
    const dedupFn = pick(stageModules.dedup, [
      'dedup',
      'runDedup',
      'dedupe',
      'cluster',
      'clusterReports'
    ]);
    if (dedupFn) {
      try {
        const result = await dedupFn(store.reports, store.settlements, config);
        if (Array.isArray(result)) {
          store.clusters = result;
        } else if (result && typeof result === 'object') {
          if (Array.isArray(result.clusters)) store.clusters = result.clusters;
          store.reports = asReports(result, store.reports);
          ambiguousPairs =
            result.ambiguous ||
            result.ambiguousPairs ||
            result.ambiguousMatches ||
            result.pending ||
            [];
        }
      } catch (err) {
        addIncident('degraded-source', `Dedup failed: ${err.message}`, {
          stage: 'dedup',
          error: err.message
        });
      }
    }
    if (!Array.isArray(store.clusters)) store.clusters = [];
    if (!Array.isArray(ambiguousPairs)) ambiguousPairs = [];

    // --- 3b. OBSERVE -----------------------------------------------------
    // THE POINT OF THIS PHASE. Reports that resolved to a settlement at a known
    // time become append-only observation rows, and the silence clock reads
    // those back — so silence is time since the last OBSERVATION, not time since
    // this process booted.
    //
    // The write happens AFTER dedup so each observation carries the cluster id it
    // belonged to, which is what lets rank collapse a report and its observation
    // onto one event instead of counting a zero-length gap between them.
    //
    // A failure here degrades the pass rather than killing it: rank still runs,
    // it just runs on whatever history was already durable. That is a worse
    // answer, not a wrong one, and it goes on the fail feed.
    runProgress.markStage('observe');
    let observationHistory = [];
    let observationsWritten = 0;
    try {
      const knownIds = new Set(store.settlements.map((s) => s.id));
      const { observations: fresh, skipped } = observationsFromReports(store.reports, knownIds);
      if (fresh.length) {
        const written = await repos.observations.appendMany(fresh);
        observationsWritten = written.length;
      }
      if (skipped.noTimestamp > 0) {
        addIncident(
          'degraded-source',
          `${skipped.noTimestamp} resolved report(s) had no usable timestamp, so no observation was recorded for them. Those settlements stay silent rather than being credited with an observation at a guessed time.`,
          { stage: 'observe', ...skipped }
        );
      }
      if (skipped.unknownSettlement > 0) {
        addIncident(
          'degraded-source',
          `${skipped.unknownSettlement} report(s) resolved to a settlement id that is not in the gazetteer; no observation was recorded for them.`,
          { stage: 'observe', ...skipped }
        );
      }
      // Read the full history back. THIS is the silence clock's input.
      observationHistory = await repos.observations.listAll();
    } catch (err) {
      addIncident('degraded-source', `Observation write/read failed: ${err.message}`, {
        stage: 'observe',
        error: err.message
      });
    }

    // --- 4. RANK ---------------------------------------------------------
    // Exponential TBE baseline + Getis-Ord Gi*. Deterministic and auditable.
    runProgress.markStage('rank');
    const rankFn = pick(stageModules.rank, ['rank', 'runRank', 'rankSettlements', 'score']);
    if (rankFn) {
      try {
        // rank(settlements, clusters, reports, now, { adjacency, observations })
        const result = await rankFn(store.settlements, store.clusters, store.reports, new Date(), {
          adjacency: corridor,
          observations: observationHistory
        });
        if (Array.isArray(result)) store.ranked = result;
        else if (result && Array.isArray(result.ranked)) store.ranked = result.ranked;
        else if (result && Array.isArray(result.settlements)) store.ranked = result.settlements;
      } catch (err) {
        addIncident('degraded-source', `Rank failed: ${err.message}`, {
          stage: 'rank',
          error: err.message
        });
      }
    }
    if (!Array.isArray(store.ranked)) store.ranked = [];

    // --- 5. CHECKPOINT ---------------------------------------------------
    // Escalations for the top anomalous silences, plus every ambiguous dedup pair.
    // Nothing here is actionable until a named human decides. createEscalation is
    // idempotent per settlement, so re-running never buries earlier human decisions.
    //
    // The gate is rank.js's qualifiesForEscalation, NOT isLocalAnomaly. Gi* is a
    // neighbourhood statistic, so a settlement that reported minutes ago clears
    // it whenever the corridor around it is dark; escalating on it alone raised
    // items like "Anomalous silence: Nilkantha - 0h with no confirming report".
    // If the rank module is unavailable or renamed we fall back to an equivalent
    // local rule rather than to the old, broken one.
    // Deliberately not pick(): pick() falls back to a module's default export,
    // which here is rank() itself, and calling that as a predicate would be
    // silently truthy for every row.
    runProgress.markStage('checkpoint');
    const escalationGate =
      typeof stageModules.rank?.qualifiesForEscalation === 'function'
        ? stageModules.rank.qualifiesForEscalation
        : fallbackEscalationGate;
    const anomalies = store.ranked
      .filter((s) => s && escalationGate(s))
      .slice(0, MAX_ESCALATIONS_PER_RUN);

    for (const s of anomalies) {
      try {
        await createEscalation({
          runId,
          settlementId: s.settlementId,
          title: `Anomalous silence: ${s.name} (${s.district}) - ${round(s.silenceHours)}h with no confirming report, expected roughly every ${round(s.expectedGapHours)}h`,
          evidence: {
            settlementId: s.settlementId,
            name: s.name,
            district: s.district,
            population: s.population,
            hazardTier: s.hazardTier,
            lastReportAt: s.lastReportAt ?? null,
            silenceHours: s.silenceHours,
            expectedGapHours: s.expectedGapHours,
            surprisal: s.surprisal,
            // Spatial context for the human reading this - is it this one place,
            // or is the whole valley dark? Not part of the escalation test.
            giZScore: s.giZScore,
            ownZScore: s.ownZScore,
            anomalyType: s.anomalyType,
            fitBasis: s.fitBasis,
            coverageBasis: s.coverageBasis,
            corroborationCount: s.corroborationCount,
            rank: s.rank
          }
        });
      } catch (err) {
        addIncident(
          'degraded-source',
          `Could not raise escalation for ${s.settlementId}: ${err.message}`,
          {
            settlementId: s.settlementId,
            error: err.message
          }
        );
      }
    }

    for (const pair of ambiguousPairs.slice(0, MAX_AMBIGUOUS_PER_RUN)) {
      try {
        await createAmbiguousMatch({
          runId,
          title: pair.title || describePair(pair),
          settlementId: pair.settlementId ?? null,
          evidence: pair
        });
      } catch (err) {
        addIncident('degraded-source', `Could not hold ambiguous match: ${err.message}`, {
          error: err.message
        });
      }
    }

    // --- 6. PERSIST THE DERIVED PROJECTIONS ------------------------------
    // reports / clusters / ranked are replace-for-run: safe to recompute, keyed
    // by run so "what did the ranking look like an hour ago" stays answerable.
    // A failure here is reported and does NOT abort the pass — the observations
    // (the facts) are already durable at this point, and they are the half that
    // cannot be recomputed.
    runProgress.markStage('persist');
    try {
      await repos.reports.replaceForRun(runId, store.reports);
      await repos.clusters.replaceForRun(runId, store.clusters);
      await repos.ranked.replaceForRun(runId, store.ranked);
    } catch (err) {
      addIncident('degraded-source', `Could not persist run projections: ${err.message}`, {
        stage: 'persist',
        runId,
        error: err.message
      });
    }

    // --- 7. STATS --------------------------------------------------------
    const durationMs = Date.now() - started;
    const pendingCheckpointCount = await repos.checkpoint.countPending();
    const stats = {
      reportCount: store.reports.length,
      clusterCount: store.clusters.length,
      // Provisional: overwritten below with the run row's own finished_at.
      lastRunAt: new Date().toISOString(),
      durationMs,
      rankedCount: store.ranked.length,
      observationsWritten,
      observationsKnown: observationHistory.length,
      pendingCheckpointCount,
      ingestMode: store.stats?.ingestMode ?? null,
      ingestSourcesHealthy: store.stats?.ingestSourcesHealthy ?? null,
      ingestSourcesTotal: store.stats?.ingestSourcesTotal ?? null,
      // Tier-3 provenance, counted - never asserted. `harness` is the number of
      // classifications TrueForge actually executed as session turns this pass;
      // `fallback` is the number the direct-fetch path had to cover. Both are
      // read straight off store.harness, which triage writes from the harness
      // client's own counters.
      tier3: harnessSummary(),
      // Which connectors this pass saw. Kept in runs.stats rather than a table
      // because it is a fact about THIS PROCESS'S last pass, not about the world
      // — see the header of src/store.js.
      sources: sourcesArray()
    };

    // ORDER MATTERS HERE, and it is the ordering a race found.
    //
    // `store.stats` is what GET /api/state reports as `lastRunAt`, and the
    // ranking it serves comes from the last COMPLETED run. Publishing the stats
    // BEFORE closing the run left a window in which the response carried this
    // pass's lastRunAt next to the PREVIOUS pass's ranking — two runs presented
    // as one, which is the kind of inconsistency nobody notices until a number
    // is quoted from it. Closing the run first means "a new lastRunAt is
    // visible" implies "its snapshot is the one being served".
    const finished = await repos.runs.finish(runId, { durationMs, stats });
    // `lastRunAt` is taken from the STORE'S clock (the run row's finished_at),
    // not from a second `new Date()` here. Two clocks would differ by a few
    // milliseconds, which is harmless right up until something compares them —
    // and GET /api/state now does exactly that to decide whether its in-process
    // stats describe the run it is serving.
    store.stats = { ...stats, lastRunAt: finished?.finishedAt ?? stats.lastRunAt };

    // The live view closes AFTER the durable row does, in that order, for the
    // same reason the stats are published after runs.finish(): a client that sees
    // `run.status = "done"` must already be able to read the completed pass from
    // GET /api/state, not a moment before.
    runProgress.completeRun({ durationMs, stats });

    return {
      ok: true,
      runId,
      reportCount: store.reports.length,
      clusterCount: store.clusters.length,
      observationsWritten,
      durationMs
    };
  } catch (err) {
    // The run row must not be left claiming 'running' forever.
    await repos.runs.fail(runId, err, { durationMs: Date.now() - started }).catch(() => {});
    // Neither must the live view. `failRun` keeps `stage` at whatever it was, so
    // the pass says which stage it died in rather than tidily reporting nothing.
    runProgress.failRun(err, { durationMs: Date.now() - started });
    throw err;
  } finally {
    setCurrentRunId(null);
    // Every incident raised during this pass is durable before the pass reports
    // done. A caller that runs a pass and then reads the feed cannot observe a
    // gap between the two.
    await flushIncidents();
  }
}

/**
 * Run one pass and AWAIT IT. The boot pass and the tests use this.
 *
 * Returns the busy result rather than throwing when a pass is already in flight,
 * which is the shape this function has always had.
 */
export async function runPipeline({ trigger = 'direct' } = {}) {
  const accepted = acceptPipelineRun({ trigger });
  if (!accepted.accepted) {
    return {
      ok: false,
      error: 'A pipeline pass is already running.',
      runId: accepted.runId,
      reportCount: store.reports.length,
      durationMs: 0
    };
  }
  return executePipeline(accepted.runId);
}

/**
 * Accept a pass, ANSWER, and let it finish in the background. POST /api/run.
 *
 * The returned promise is deliberately not handed back to the caller: the caller
 * is an HTTP request that has already been answered with 202, and awaiting it
 * would put the 45-second pass back inside the request this change exists to get
 * it out of. What replaces the caller's `await` is the fail feed and
 * GET /api/state's `run` — the two surfaces an operator is already watching.
 */
export function startPipelineRun({ trigger = 'api' } = {}) {
  const accepted = acceptPipelineRun({ trigger });
  if (!accepted.accepted) return accepted;

  executePipeline(accepted.runId).catch(async (err) => {
    // executePipeline has already closed the run row and the live view; what is
    // left is to make the failure VISIBLE. Nobody is awaiting this promise, so
    // without the incident the pass would fail into silence — on a product whose
    // entire premise is that silence is the thing worth noticing.
    console.error('[signal-zero] pipeline error:', err);
    addIncident('degraded-source', `Pipeline run failed: ${err.message}`, {
      runId: accepted.runId,
      error: err.message
    });
    await flushIncidents();
  });

  return accepted;
}

/**
 * The agent-harness summary the UI is allowed to render.
 *
 * EVERY field here is a COUNTED FACT produced by src/harness/trueforge.js from
 * TrueForge's own responses during the last pass - a session id TrueForge
 * minted, a turn id it minted, token counts off `turn.done.state.metrics`, an
 * agent id read back off GET /api/v1/agents. Nothing is estimated, and nothing
 * is here that the UI could not truthfully populate:
 *
 *   * `binding` is 'named-agent' only when TrueForge answered the session
 *     create with agent.type === 'reference'. Anything else says 'inline-spec'.
 *   * `approvalGate.armed` is read off the bound agent's own manifest, and
 *     `fired` counts turns that actually parked on an approval decision. The
 *     tier-3 agent has no tools, so honest output today is armed:false, fired:0
 *     - we surface that rather than implying a gate we do not have. TrueForge's
 *     gate is ALSO not Signal Zero's named-approver rule (see
 *     docs/trueforge-verified.md); that stays server-side, below.
 *   * `executedByHarness + executedByFallback + unresolved` is every tier-3
 *     classification attempted this pass.
 *
 * Returns null before the first pipeline pass, because "no run yet" is not
 * "zero executions".
 */
function harnessSummary() {
  const h = store.harness;
  if (!h) return null;
  return {
    executedByHarness: h.executedByHarness ?? 0,
    executedByFallback: h.executedByFallback ?? 0,
    unresolved: h.unresolved ?? 0,
    harnessReachable: h.reachable ?? null,
    harnessBaseUrl: h.baseUrl ?? null,
    harnessModel: h.model ?? null,
    harnessSessionId: h.sessionId ?? null,
    // Tier-3 turns run concurrently, one pooled session each (TrueForge
    // serializes turns inside a session). `harnessSessionId` is the first
    // session of the pass; this is every one it used, and `pool` is what the
    // pool actually did - the configured cap, sessions CREATED this pass,
    // acquisitions that reused one, and how many are live. None of it is a
    // claim about parallelism: the per-turn latencies in `turns` are that.
    harnessSessionIds: Array.isArray(h.sessionIds) ? h.sessionIds : [],
    pool: h.pool ?? null,
    harnessTokens: h.totalTokens ?? 0,
    // --- which agent, and how the session was bound to it -------------------
    agentName: h.agentName ?? null,
    agentId: h.agentId ?? null,
    agentRegistered: h.agentRegistered ?? null,
    binding: h.binding ?? null,
    // --- per-turn evidence, so a claim can be checked against TrueForge ------
    turns: Array.isArray(h.turns) ? h.turns : [],
    tokens: {
      total: h.totalTokens ?? 0,
      input: h.inputTokens ?? 0,
      output: h.outputTokens ?? 0,
      cacheRead: h.cacheReadTokens ?? 0
    },
    approvalGate: h.approvalGate ?? { armed: false, tools: [], fired: 0, resolved: 0 },
    guardrail: h.guardrail ?? { inputBlocked: 0, outputBlocked: 0, advisory: 0, rules: [] },
    lastError: h.lastError ?? null,
    checkedAt: h.checkedAt ?? null
  };
}

function round(n, places = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

// A candidate is either a label the caller supplied or the full report object
// dedup compared. Prefer the headline: the human reading the queue decides about
// two stories, not about two opaque report ids. Never interpolate the object
// itself - that renders as "[object Object]".
function pairLabel(candidate, label, id, fallback) {
  if (typeof label === 'string' && label.trim()) return label.trim();
  if (candidate && typeof candidate === 'object') {
    const t = String(candidate.title || candidate.label || candidate.name || '').trim();
    if (t) return t.length > 70 ? `${t.slice(0, 69)}…` : t;
    const cid = String(candidate.id || '').trim();
    if (cid) return cid;
  }
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  if (typeof id === 'string' && id.trim()) return id.trim();
  return fallback;
}

function describePair(pair) {
  const a = pairLabel(
    pair.a,
    pair.leftLabel || pair.aLabel,
    pair.leftId || pair.aId,
    'candidate A'
  );
  const b = pairLabel(
    pair.b,
    pair.rightLabel || pair.bLabel,
    pair.rightId || pair.bId,
    'candidate B'
  );
  const p = pair.matchProbability ?? pair.probability ?? pair.p;
  const pct = Number.isFinite(Number(p)) ? ` (match p=${round(Number(p), 2)})` : '';
  return `Ambiguous match: ${a} vs ${b}${pct}`;
}

// ---------------------------------------------------------------------------
// Failure simulators (live demo)
// ---------------------------------------------------------------------------
// Prefer a simulate* helper exported by the owning stage; fall back to a local
// implementation so the demo button always produces a real incident.

function findSimulator(names) {
  for (const mod of Object.values(stageModules)) {
    const fn = mod ? names.map((n) => mod[n]).find((f) => typeof f === 'function') : null;
    if (fn) return fn;
  }
  return null;
}

function simulateDegradedSource() {
  const fn = findSimulator(['simulateDegradedSource', 'simulateSourceFailure', 'simulateDegraded']);
  if (fn) return fn(store);

  const names = Object.keys(store.sources || {});
  const name = names.find((n) => store.sources[n]?.status !== 'degraded') || names[0];
  if (!name) {
    return addIncident(
      'degraded-source',
      'Connector health probe failed: no sources registered yet',
      {
        simulated: true
      }
    );
  }
  const source = store.sources[name];
  const previousStatus = source.status;
  source.status = 'degraded';
  const incident = addIncident(
    'degraded-source',
    `Connector "${name}" stopped returning results - coverage is now partial`,
    {
      simulated: true,
      source: name,
      sourceType: source.sourceType ?? null,
      previousStatus
    }
  );

  // Self-heal, so the fail feed shows recovery as well as failure.
  setTimeout(() => {
    if (store.sources[name]) {
      store.sources[name].status = previousStatus || 'ok';
      addIncident('heal', `Connector "${name}" recovered - coverage restored`, { source: name });
    }
  }, 20000).unref?.();

  return incident;
}

async function simulateAmbiguousMatch() {
  // dedup.js owns the band, so it owns the simulation. Its helper scores REAL
  // report pairs and prefers a genuinely near-threshold one, only pinning to the
  // band midpoint when the corpus has none - and then it sets forced:true and
  // keeps originalMatchProbability, so the audit trail never claims a pair was
  // borderline when it was not.
  //
  // The name here has to match dedup's export exactly. It did not, so this
  // silently fell through to a hand-written stub that asserted p=0.61 against
  // thresholds 0.35/0.85 - numbers from an older scheme. Under the real
  // constants (AMBIGUOUS_LOW 0.45, ADMIT 0.60) a pair at 0.61 is above the
  // auto-merge line: the demo was holding up an item for human review that the
  // pipeline would have linked without asking. Exactly the kind of contradiction
  // this checkpoint exists to prevent.
  const fn = findSimulator([
    'simulateAmbiguousPair',
    'simulateAmbiguousMatch',
    'simulateAmbiguous'
  ]);
  const pair = fn ? fn(store.reports) : null;

  if (!pair) {
    return addIncident(
      'degraded-source',
      'Could not simulate an ambiguous match: no scoreable report pair is loaded yet.',
      { simulated: true, reason: 'no-candidate-pair' }
    );
  }

  const item = await createAmbiguousMatch({
    title: pair.title || describePair(pair),
    settlementId: pair.settlementId ?? null,
    evidence: { ...pair, simulated: true }
  });

  // Report the pair's ACTUAL score, not a literal. If dedup had to pin the score
  // to the band midpoint because the corpus held nothing genuinely borderline,
  // say so and carry the original - a reviewer has to be able to tell a real
  // undecidable pair from a manufactured one.
  const p = Number(pair.matchProbability);
  const forced = pair.forced === true;
  const origin = forced
    ? ` (forced into the band for the demo; scored ${round(Number(pair.originalMatchProbability), 3)})`
    : '';

  const incident = addIncident(
    'llm-fallback',
    `Match held for a human: ${describePair(pair)}${origin}`,
    {
      simulated: true,
      forced,
      checkpointId: item.id,
      matchProbability: Number.isFinite(p) ? p : null,
      originalMatchProbability: pair.originalMatchProbability ?? null
    }
  );
  incident.detail.checkpointItem = item.id;
  return { incident, checkpointItem: item };
}

function simulateColdStart() {
  const fn = findSimulator(['simulateColdStart', 'simulateCold']);
  if (fn) return fn(store);

  // Reads the working set rather than the ranked_snapshots table on purpose:
  // this is a DEMO of a label, and it must not rewrite a persisted snapshot.
  // ranked_snapshots is the ranking as it was actually computed at a point in
  // time — editing a stored row to make a demo button do something would make
  // "why was this ranked 3rd an hour ago" answerable with a fabricated answer.
  // The incident it raises is real and is persisted; the label change is local
  // to this process's working set and disappears with the next pass.
  const target =
    store.ranked.find((s) => s.coverageBasis !== 'cohort-cold-start') || store.ranked[0] || null;
  if (!target) {
    return addIncident(
      'cold-start',
      'Cold-start settlement encountered before any ranking existed',
      {
        simulated: true
      }
    );
  }
  target.coverageBasis = 'cohort-cold-start';
  return addIncident(
    'cold-start',
    `${target.name} has no report history - scored from its hazard-tier cohort baseline, not its own data`,
    {
      simulated: true,
      settlementId: target.settlementId,
      expectedGapHours: target.expectedGapHours,
      coverageBasis: 'cohort-cold-start'
    }
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  const p = persistence();
  res.json({
    ok: true,
    lastRunAt: store.stats?.lastRunAt ?? null,
    persistence: { mode: p.mode, durable: p.durable }
  });
});

app.get('/api/state', async (req, res, next) => {
  try {
    // How many incidents this response carries inline. THIS IS A PAGE SIZE, NOT
    // A RING BUFFER — see src/http/pagination.js. Nothing is discarded: every
    // incident stays in the table, `incidentTotal` is the count of ALL of them,
    // and `incidentCursor` walks the rest through GET /api/incidents.
    const { limit: incidentLimit } = parsePageSize(req.query.incidentLimit, {
      param: 'incidentLimit',
      def: STATE_INCIDENT_PAGE_SIZE_DEFAULT,
      max: STATE_INCIDENT_PAGE_SIZE_MAX
    });

    // Every array below is read THROUGH THE REPOSITORIES, not from the in-memory
    // working set. That is what makes src/store.js a facade rather than a shadow:
    // if its arrays were emptied right now this response would be identical.
    // ONE RUN, BOTH READS. `latestCompleted()` is resolved first and its runId
    // is used for the ranking, so the snapshot and the stats describe the same
    // pass. Reading `ranked.listLatest()` and `runs.latestStats()` independently
    // would each pick "the latest" at its own moment, and a pass finishing
    // between the two would produce a response pairing one run's numbers with
    // another run's ranking.
    const lastRun = await repos.runs.latestCompleted();
    const [ranked, checkpoint, incidentPage, incidentTotal] = await Promise.all([
      lastRun ? repos.ranked.listForRun(lastRun.runId) : [],
      repos.checkpoint.list(),
      repos.incidents.list({ limit: incidentLimit }),
      repos.incidents.count()
    ]);

    const pendingCheckpointCount = checkpoint.filter((i) => i.status === 'pending').length;
    // The stats belong to the run whose ranking is above. This process's live
    // `store.stats` is used only when it IS that run — otherwise the persisted
    // stats win, which is also what makes a freshly restarted process report the
    // last completed pass rather than a blank screen. `{}` when no pass has ever
    // finished: `lastRunAt: null` means "never ran", never a zero-filled object.
    const persistedStats = lastRun
      ? { ...lastRun.stats, lastRunAt: lastRun.finishedAt, durationMs: lastRun.durationMs }
      : {};
    const stats =
      store.stats?.lastRunAt && store.stats.lastRunAt === persistedStats.lastRunAt
        ? store.stats
        : persistedStats;
    const p = persistence();

    res.json({
      settlements: ranked,
      checkpoint,
      incidents: incidentPage.items,
      // The feed is unbounded and this is one page of it. `incidentTotal` counts
      // everything in the table; `incidentPageSize` is what this response applied;
      // `incidentCursor` is null when this page IS the whole feed, so a client can
      // tell "that is all of them" from "there are more" without arithmetic.
      incidentTotal,
      incidentPageSize: incidentLimit,
      incidentCursor: incidentPage.nextCursor,
      incidentHasMore: incidentPage.hasMore,
      // PROGRESS OF THE PASS THIS PROCESS IS RUNNING. Null when this process has
      // not started one — which is NOT "no pass has ever run". That question is
      // answered by `stats.lastRunAt`, which comes from the runs table and
      // survives a restart. See src/http/run-progress.js.
      run: runProgress.snapshot(),
      sources: sourcesArray(),
      // WHICH MODE IS THIS. Hard rule 4 applied to the store itself: a client
      // must be able to tell a silence figure backed by a durable observation
      // log from one backed by a process that booted ten minutes ago.
      persistence: {
        mode: p.mode,
        durable: p.durable,
        configured: p.configured,
        reason: p.reason,
        error: p.error,
        databaseUrl: p.databaseUrl,
        // Incidents this process minted and could NOT write down. Non-zero means
        // the fail feed itself is lossy, which is worth shouting about.
        unpersistedIncidents: unpersistedIncidentCount()
      },
      // Agent-harness provenance for the last pass. null until a pass has run.
      // Every field is a counted fact from src/harness/trueforge.js, so the UI can
      // state plainly whether TrueForge executed a classification or the
      // direct-fetch fallback did. See store.harness.
      harness: harnessSummary() ?? stats?.tier3 ?? null,
      stats: {
        reportCount: stats?.reportCount ?? 0,
        clusterCount: stats?.clusterCount ?? 0,
        lastRunAt: stats?.lastRunAt ?? null,
        durationMs: stats?.durationMs ?? 0,
        observationsKnown: stats?.observationsKnown ?? null,
        pendingCheckpointCount,
        tier3: stats?.tier3 ?? null
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * THE UNBOUNDED FEED, KEYSET-PAGED.
 *
 * Ordered `(at DESC, id DESC)`, matching `incidents_feed_idx` exactly. `cursor`
 * is the `nextCursor` from the previous page and is anchored to a row, so
 * incidents arriving at the head mid-read cannot shift the page under a reader —
 * which OFFSET would do, during exactly the failure cascade someone is reading it
 * for.
 *
 * A null `nextCursor` means the client has reached the end. It stops there rather
 * than guessing at an offset.
 *
 * Page size: default 100, maximum 500. An out-of-range `limit` is REFUSED with
 * 400 rather than clamped — see src/http/pagination.js for why silently serving
 * fewer rows than were asked for is a lie a client cannot detect.
 */
app.get('/api/incidents', async (req, res, next) => {
  try {
    const { limit, explicit } = parsePageSize(req.query.limit, {
      def: INCIDENT_PAGE_SIZE_DEFAULT,
      max: INCIDENT_PAGE_SIZE_MAX
    });
    const cursor = parseCursorParam(req.query.cursor);
    const kind = req.query.kind ? String(req.query.kind) : undefined;

    await flushIncidents();
    const page = await repos.incidents.list({ limit, cursor, kind });
    res.json({
      ok: true,
      incidents: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      // What actually applied, and the published bounds. A client never has to
      // infer the page size from the number of rows it happened to receive.
      pageSize: limit,
      pageSizeSource: explicit ? 'request' : 'default',
      pageSizeDefault: INCIDENT_PAGE_SIZE_DEFAULT,
      pageSizeMaximum: INCIDENT_PAGE_SIZE_MAX,
      // The count of EVERYTHING, which can legitimately exceed any page size.
      // That is the property the 200-item ring buffer used to destroy.
      total: await repos.incidents.count({ kind })
    });
  } catch (err) {
    next(err);
  }
});

function sourcesArray() {
  const src = store.sources || {};
  if (Array.isArray(src)) return src;
  return Object.entries(src)
    .map(([name, v]) => ({
      name: v?.name || name,
      sourceType: v?.sourceType ?? null,
      status: v?.status ?? 'unknown',
      lastFetchAt: v?.lastFetchAt ?? null
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/**
 * START a pipeline pass. 202 ACCEPTED, not 200 OK.
 *
 * The pass takes roughly 45 seconds. Holding a connection open for that long put
 * the work inside a request that a client timeout, an intermediary idle timeout
 * or a deploy could all cut in half, and told the caller nothing until it either
 * finished or did not. So this route does the one thing it can do synchronously —
 * claim the single-flight slot and mint a run id — and answers.
 *
 * 202 is the correct code and it is a claim with content: the request was
 * accepted, processing has NOT completed, and the response body says where to
 * watch. `GET /api/state` → `run` carries the status and the current stage;
 * `run.runId` matches the id returned here and the `runs` table row.
 *
 * IDEMPOTENCY. Send `Idempotency-Key` and a double-clicked button replays this
 * same 202 with the same run id instead of racing the single-flight guard into a
 * 409. See src/http/idempotency.js — Stripe's convention, not a standard.
 */
app.post('/api/run', idempotency(), (req, res, next) => {
  try {
    const accepted = startPipelineRun({ trigger: 'api' });
    if (!accepted.accepted) {
      return next(
        new ProblemError(
          'pipeline-run-in-flight',
          `A pipeline pass is already running. Read its progress from GET /api/state ("run").`,
          { runId: accepted.runId, startedAt: accepted.startedAt, stage: accepted.stage }
        )
      );
    }
    res
      .status(202)
      // RFC 9110 §10.2.2: where the result of the accepted work can be found.
      // /api/state is the whole dashboard read, so it is the honest target — there
      // is no per-run resource to point at and inventing one would be a 404.
      .location('/api/state')
      .json({
        ok: true,
        status: 'accepted',
        runId: accepted.runId,
        startedAt: accepted.startedAt,
        progressUrl: '/api/state',
        note:
          'The pass is running. Poll GET /api/state and read `run`: `run.status` moves ' +
          'from "running" to "done" or "error", and `run.stage` names the stage in ' +
          'progress. `stats.lastRunAt` changes when the pass is durable.'
      });
  } catch (err) {
    next(err);
  }
});

function decideRoute(action) {
  return async (req, res, next) => {
    const approvedBy = req.body ? req.body.approvedBy : undefined;
    try {
      const item = await action(req.params.id, approvedBy);
      // The shortlist is built from the SETTLEMENTS TABLE, not from the working
      // set, so it is correct on a process that has not run a pass yet.
      const settlements = store.settlements.length
        ? store.settlements
        : await repos.settlements.listAll();
      await flushIncidents();
      res.json({
        ok: true,
        item,
        // Approval unlocks a sorted CANDIDATE LIST of jurisdictions to inform.
        // It is never an assignment. See buildShortlist() in checkpoint.js.
        shortlist: item.status === 'approved' ? buildShortlist(item, settlements) : []
      });
    } catch (err) {
      // CheckpointError's own `code` is mapped to a problem type by
      // src/http/problem.js. The pipeline stays unaware that HTTP exists.
      next(err);
    }
  };
}

// IDEMPOTENCY ON THE DECISION ROUTES IS THE POINT OF THE FEATURE.
//
// These two record a NAMED HUMAN's signature on a safety control, into an
// append-only log. A double-clicked approve, or a client retry after a timeout,
// used to be answered with 409 ALREADY_DECIDED — a correct refusal that the
// caller could not tell apart from "somebody else got here first". With a key,
// the second submission replays the first one's 200 and the first human's
// decision is what stands.
app.post('/api/checkpoint/:id/approve', idempotency(), decideRoute(approve));
app.post('/api/checkpoint/:id/reject', idempotency(), decideRoute(reject));

/**
 * One checkpoint item plus its APPEND-ONLY DECISION LOG.
 *
 * `status` on the item is a projection of `decisions`; this route returns both
 * so the projection can be checked against the log it claims to summarise. An
 * audit trail nobody can read is not an audit trail either.
 */
app.get('/api/checkpoint/:id', async (req, res, next) => {
  try {
    const item = await getCheckpointItem(req.params.id);
    if (!item) {
      throw new ProblemError(
        'checkpoint-not-found',
        `No checkpoint item with id "${req.params.id}".`
      );
    }
    res.json({ ok: true, item, decisions: await listDecisions(item.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/settlement/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const settlement = await repos.settlements.getById(id);
    // The last COMPLETED run's ranking, which is the one /api/state serves too.
    const lastRun = await repos.runs.latestCompleted();
    const ranked = lastRun ? await repos.ranked.getForRun(lastRun.runId, id) : null;

    if (!settlement && !ranked) {
      throw new ProblemError('settlement-not-found', `No settlement "${id}".`);
    }

    const [reports, clusters, checkpoint, lastObservation, observations] = await Promise.all([
      lastRun ? repos.reports.listForSettlement(lastRun.runId, id) : [],
      lastRun ? repos.clusters.listForSettlement(lastRun.runId, id) : [],
      repos.checkpoint.list({ settlementId: id }),
      repos.observations.latestForSettlement(id),
      repos.observations.listForSettlement(id, { limit: 50 })
    ]);

    res.json({
      ok: true,
      settlement,
      ranked,
      reports,
      clusters,
      // The observation history the silence clock actually read. `lastObservedAt`
      // is null when NOTHING HAS EVER RESOLVED HERE — not 0, not a timestamp.
      observations,
      lastObservedAt: lastObservation ? lastObservation.lastObservedAt : null,
      neighbors: corridor[id] || [],
      checkpoint,
      scoreBreakdown: buildScoreBreakdown(ranked, reports)
    });
  } catch (err) {
    next(err);
  }
});

// Every number the UI shows must be traceable back to an input. No black box.
function buildScoreBreakdown(ranked, reports) {
  if (!ranked) return null;
  const expected = Number(ranked.expectedGapHours);
  const lambda = Number.isFinite(expected) && expected > 0 ? 1 / expected : null;
  return {
    lastReportAt: ranked.lastReportAt ?? null,
    silenceHours: ranked.silenceHours,
    expectedGapHours: ranked.expectedGapHours,
    lambdaPerHour: lambda === null ? null : round(lambda, 5),
    survivalProbability:
      lambda === null ? null : round(Math.exp(-lambda * Number(ranked.silenceHours || 0)), 6),
    surprisal: ranked.surprisal,
    surprisalFormula: 'surprisal = -ln(P(gap >= observed)) = lambda * silenceHours',
    giZScore: ranked.giZScore,
    giThreshold: 1.96,
    isLocalAnomaly: ranked.isLocalAnomaly,
    // Gi* significance is a statement about the NEIGHBOURHOOD. Escalation needs
    // this settlement itself to be silent and surprising - see rank.js.
    isEscalationCandidate: ranked.isEscalationCandidate ?? false,
    escalationThresholds: {
      minSurprisalNats: ESCALATION_MIN_SURPRISAL_NATS,
      minSilenceHours: ESCALATION_MIN_SILENCE_HOURS,
      requiresOwnZAboveMean: true,
      note: 'Gi* is context, not a gate: a wide outage flattens it exactly when it matters most.'
    },
    coverageBasis: ranked.coverageBasis,
    corroborationCount: ranked.corroborationCount,
    reportsUsed: reports.length,
    fitBasis: ranked.fitBasis ?? null,
    cohortKey: ranked.cohortKey ?? null,
    cohortSampleGaps: ranked.cohortSampleGaps ?? 0,
    lambdaBoundsPerHour: [1 / 72, 1 / 2],
    method:
      'Exponential time-between-events baseline per hazard-tier/population cohort. The rate is a Gamma-Exponential posterior: a structural prior (12h expected gap for a tier-2 settlement of 10,000, scaled sqrt-sublinearly by population and modestly by hazard tier) updated with gaps between DISTINCT reporting events (dedup clusters, near-simultaneous arrivals collapsed), then clamped to between one report per 2h and one per 72h. Getis-Ord Gi* over the river-corridor adjacency graph adds spatial context. Deterministic - no LLM touches these numbers.'
  };
}

app.post('/api/demo/fail/:kind', async (req, res, next) => {
  const kind = String(req.params.kind || '').toLowerCase();
  try {
    // Every branch flushes before responding, so a client that POSTs here and
    // immediately GETs /api/state sees the incident it just caused. Without the
    // flush the demo would intermittently show an empty feed and look broken.
    if (kind === 'source') {
      const incident = await simulateDegradedSource();
      await flushIncidents();
      return res.json({ ok: true, incident });
    }
    if (kind === 'ambiguous') {
      const result = await simulateAmbiguousMatch();
      await flushIncidents();
      if (result?.incident) {
        return res.json({
          ok: true,
          incident: result.incident,
          checkpointItem: result.checkpointItem
        });
      }
      return res.json({ ok: true, incident: result });
    }
    if (kind === 'coldstart' || kind === 'cold-start') {
      const incident = simulateColdStart();
      await flushIncidents();
      return res.json({ ok: true, incident });
    }
    throw new ProblemError(
      'unknown-failure-kind',
      `Unknown failure kind "${kind}". Use source | ambiguous | coldstart.`,
      { kind, supported: ['source', 'ambiguous', 'coldstart'] }
    );
  } catch (err) {
    if (!(err instanceof ProblemError)) console.error('[signal-zero] demo failure error:', err);
    next(err);
  }
});

// --- problem type registry -------------------------------------------------
// RFC 9457 §3.1.1 says a `type` URI SHOULD resolve to human-readable
// documentation. Most implementations emit one that 404s. These resolve, and
// they are generated from the same table the error responses are built from, so
// the documentation cannot drift from what it documents. See src/http/problem.js.
app.use(PROBLEM_BASE_PATH, problemRegistryRouter());

// --- static frontend -------------------------------------------------------
if (!fs.existsSync(WEB_DIR)) {
  fs.mkdirSync(WEB_DIR, { recursive: true });
}
app.use(express.static(WEB_DIR, { extensions: ['html'] }));

app.get('/', (_req, res) => {
  const index = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.type('text/plain').send('Signal Zero API is running. UI not built yet - try GET /api/state');
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next(
      new ProblemError('route-not-found', `No route ${req.method} ${req.path}`, {
        method: req.method,
        path: req.path
      })
    );
  }
  const index = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).type('text/plain').send('Not found');
});

/**
 * THE GLOBAL ERROR HANDLER. Every failure in this API leaves through here, and
 * every one of them is now an RFC 9457 problem document.
 *
 * https://www.rfc-editor.org/rfc/rfc9457.html — which obsoletes RFC 7807. One
 * media type (`application/problem+json`), one shape, and a `type` URI that is
 * the stable machine-readable identity, so the English in `title` and `detail`
 * stops being load-bearing. The three inconsistent envelopes this replaces are
 * described in the header of src/http/problem.js.
 *
 * TWO THINGS THIS HANDLER MUST NOT DO, both of which it used to:
 *
 *   1. Answer 500 for everything. A malformed JSON body set `err.status = 400`
 *      and was reported as a server fault, which put the blame on the wrong side
 *      of the wire and produced a 500 in the logs for a client typo.
 *   2. Write an incident for every failure. The fail feed is the product surface
 *      for things the SYSTEM did wrong. A 404 for a settlement that does not
 *      exist, or a 400 for a blank approver, is the system working — filing those
 *      as incidents is how a feed becomes noise nobody reads, which costs exactly
 *      the visibility it exists to provide. 5xx still files one, because a 5xx is
 *      by definition our fault.
 *
 * The process must survive anything a route throws, and it still does.
 */
app.use((err, req, res, _next) => {
  const doc = problemFromError(err, req);
  const status = Number(err?.status ?? err?.statusCode);
  // A 413 keeps its own status while sharing the `malformed-request-body` type:
  // "the body was unreadable" and "the body was too large" are the same problem
  // for a client and different facts for an operator.
  const httpStatus = Number.isFinite(status) && status === 413 ? 413 : doc.status;

  if (httpStatus >= 500) {
    console.error('[signal-zero] unhandled route error:', err);
    addIncident('degraded-source', `Request failed: ${err.message}`, {
      error: err.message,
      method: req?.method ?? null,
      path: req?.path ?? null
    });
  }

  if (res.headersSent) return;
  sendProblem(res, { ...doc, status: httpStatus });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Choose the store and ANNOUNCE THE CHOICE.
 *
 * Lives here rather than inside initBackend() because src/store.js imports the
 * backend, so the backend cannot import addIncident back without a cycle. It
 * lives in ONE function rather than inline in start() because the announcement
 * is the load-bearing half: a non-durable store that only mentions itself in a
 * log line the operator is not reading is the failure this is guarding against,
 * and a test path that skipped the announcement would have let that ship.
 */
async function connectStore({ logger = console } = {}) {
  try {
    const mode = await initBackend({ logger });
    logger?.log?.(`[signal-zero] ${persistenceBanner()}`);
    if (mode.durable) {
      const known = await repos.observations.count();
      logger?.log?.(
        `[signal-zero] ${known} observation(s) already on record — the silence clock resumes from them, not from this boot.`
      );
    } else {
      // On the fail feed, not just in the log: the operator watching the
      // dashboard is the person who needs to know the clock is not durable.
      addIncident('degraded-source', `NON-DURABLE STORE: ${mode.reason}`, {
        component: 'persistence',
        mode: mode.mode,
        configured: mode.configured,
        error: mode.error,
        consequence:
          'silenceHours is time since this process booted, not time since the last observation'
      });
      await flushIncidents();
    }
    return mode;
  } catch (err) {
    logger?.error?.(`[signal-zero] persistence init failed (server still serving): ${err.message}`);
    return persistence();
  }
}

async function start() {
  await loadStages();

  // The first pipeline pass runs AFTER the server is listening, never before.
  //
  // SO DOES THE DATABASE HANDSHAKE. initBackend() connects and migrates, and
  // both of those can hang for as long as the connect timeout when the container
  // is not up. Doing it before listen() would mean a missing database holds the
  // port shut — which is the blocking boot this file already refuses to have for
  // ingest, for the same reason: an operator watching a dead console cannot tell
  // "starting" from "hung". So the port opens first, the mode is decided second,
  // and until it is decided GET /api/state honestly reports "not initialized yet"
  // rather than claiming a durability it has not verified.
  // Live ingest makes one upstream call per settlement, so a blocking boot pass
  // holds the port shut for minutes and the console looks hung. Serving the shell
  // immediately lets the operator watch ingest fill in, which is also the honest
  // picture: an empty map that populates is the real state of the system at t=0.
  async function firstPass() {
    await connectStore({ logger: console });

    try {
      const result = await runPipeline();
      console.log(
        `[signal-zero] boot pipeline pass: ${result.reportCount ?? 0} reports, ` +
          `${store.ranked.length} settlements ranked, ` +
          `${result.observationsWritten ?? 0} observations written, ${result.durationMs ?? 0}ms`
      );
    } catch (err) {
      console.error('[signal-zero] boot pipeline failed (server still serving):', err.message);
      addIncident('degraded-source', `Boot pipeline pass failed: ${err.message}`, {
        error: err.message
      });
      await flushIncidents();
    }
  }

  const port = config.PORT || 3000;
  const server = app.listen(port, () => {
    console.log('');
    console.log('  ███  SIGNAL ZERO');
    console.log('  Ranking settlements by anomalous SILENCE, not report volume.');
    console.log('  Trishuli GLOF - Nuwakot / Rasuwa / Dhading, 26 Aug 2026');
    console.log('');
    console.log(`  ->  http://localhost:${port}`);
    console.log(`  ->  http://localhost:${port}/api/state`);
    console.log('');
    console.log(
      `  live scrape: ${config.USE_LIVE_SCRAPE ? 'ON' : 'off (bundled corpus)'} ` +
        `- connecting to the store, then the first ingest pass. UI is already up.`
    );
    console.log('');
    firstPass();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[signal-zero] port ${port} is already in use.`);
      console.error(`[signal-zero] stop the other process, or run:  PORT=3001 npm start\n`);
    } else {
      console.error('[signal-zero] server error:', err);
    }
    process.exit(1);
  });
}

// Last line of defence: log and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('[signal-zero] unhandled rejection:', reason);
  addIncident('degraded-source', `Unhandled rejection: ${reason?.message || reason}`, {});
});

// A restart is the operation this whole phase exists to survive, so it is worth
// making an orderly one: drain the incident outbox before the process goes, or
// the last few failures before a SIGTERM are the ones that never get recorded.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flushIncidents().finally(() => process.exit(0));
  });
}

// Only bind a port when this file is the process entry point.
//
// `node src/server.js` still boots exactly as before, so the eval harness and
// every operator instruction are unchanged. What this adds is that a TEST can
// `import { app }` and drive the routes with fetch against a port it opened
// itself, instead of spawning a child process and scraping stdout — which is how
// the "a NULL reaches the API as null" test in test/api-honest-null.test.js can
// assert on the actual JSON bytes rather than on a paraphrase of them.
const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntryPoint) start();

/**
 * Load the stages and connect the store WITHOUT binding a port. For tests.
 * Deliberately goes through the same connectStore() the real boot uses, so a
 * test cannot pass on a path that skipped the honesty announcement.
 */
export async function initForTest() {
  await loadStages();
  return connectStore({ logger: null });
}
