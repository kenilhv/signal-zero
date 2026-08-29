// Signal Zero - HTTP server + pipeline orchestrator.
//
// One Express app serves both the JSON API and the static frontend in /web.
// One pipeline pass runs on boot so the dashboard has data the moment it loads.
//
// Pipeline order is fixed: ingest -> triage -> dedup -> rank -> checkpoint -> failfeed.
// A stage that throws is NEVER allowed to kill the process: it is caught, written to the
// incident feed (that feed is the product, not an afterthought), and the run continues
// with whatever data survived.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import { store, addIncident } from './store.js';
import {
  createEscalation,
  createAmbiguousMatch,
  approve,
  reject,
  buildShortlist,
  getCheckpointItem,
  CheckpointError
} from './pipeline/checkpoint.js';

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
    if (mod.default && typeof mod.default[n] === 'function') return mod.default[n].bind(mod.default);
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

let running = false;

const MAX_ESCALATIONS_PER_RUN = 8;
const MAX_AMBIGUOUS_PER_RUN = 12;

export async function runPipeline() {
  if (running) {
    return { ok: false, error: 'A pipeline pass is already running.', reportCount: store.reports.length, durationMs: 0 };
  }
  running = true;
  const started = Date.now();

  try {
    if (!Array.isArray(store.settlements) || store.settlements.length === 0) {
      store.settlements = gazetteer;
    }

    // --- 1. INGEST -------------------------------------------------------
    let reports = store.reports;
    const ingestFn = pick(stageModules.ingest, ['ingest', 'runIngest', 'ingestReports', 'fetchReports']);
    if (ingestFn) {
      try {
        reports = asReports(await ingestFn(store.settlements, config), []);
      } catch (err) {
        addIncident('degraded-source', `Ingest failed: ${err.message}`, { stage: 'ingest', error: err.message });
        reports = [];
      }
    }
    store.reports = Array.isArray(reports) ? reports : [];

    // --- 2. TRIAGE -------------------------------------------------------
    const triageFn = pick(stageModules.triage, ['triage', 'runTriage', 'triageReports', 'classify']);
    if (triageFn) {
      try {
        store.reports = asReports(await triageFn(store.reports, store.settlements, config), store.reports);
      } catch (err) {
        addIncident('degraded-source', `Triage failed: ${err.message}`, { stage: 'triage', error: err.message });
      }
    }

    // --- 3. DEDUP --------------------------------------------------------
    // Deterministic Fellegi-Sunter. No LLM here, by design.
    let ambiguousPairs = [];
    const dedupFn = pick(stageModules.dedup, ['dedup', 'runDedup', 'dedupe', 'cluster', 'clusterReports']);
    if (dedupFn) {
      try {
        const result = await dedupFn(store.reports, store.settlements, config);
        if (Array.isArray(result)) {
          store.clusters = result;
        } else if (result && typeof result === 'object') {
          if (Array.isArray(result.clusters)) store.clusters = result.clusters;
          store.reports = asReports(result, store.reports);
          ambiguousPairs =
            result.ambiguous || result.ambiguousPairs || result.ambiguousMatches || result.pending || [];
        }
      } catch (err) {
        addIncident('degraded-source', `Dedup failed: ${err.message}`, { stage: 'dedup', error: err.message });
      }
    }
    if (!Array.isArray(store.clusters)) store.clusters = [];
    if (!Array.isArray(ambiguousPairs)) ambiguousPairs = [];

    // --- 4. RANK ---------------------------------------------------------
    // Exponential TBE baseline + Getis-Ord Gi*. Deterministic and auditable.
    const rankFn = pick(stageModules.rank, ['rank', 'runRank', 'rankSettlements', 'score']);
    if (rankFn) {
      try {
        // rank(settlements, clusters, reports, now, { adjacency })
        const result = await rankFn(store.settlements, store.clusters, store.reports, new Date(), {
          adjacency: corridor
        });
        if (Array.isArray(result)) store.ranked = result;
        else if (result && Array.isArray(result.ranked)) store.ranked = result.ranked;
        else if (result && Array.isArray(result.settlements)) store.ranked = result.settlements;
      } catch (err) {
        addIncident('degraded-source', `Rank failed: ${err.message}`, { stage: 'rank', error: err.message });
      }
    }
    if (!Array.isArray(store.ranked)) store.ranked = [];

    // --- 5. CHECKPOINT ---------------------------------------------------
    // Escalations for the top anomalous silences, plus every ambiguous dedup pair.
    // Nothing here is actionable until a named human decides. createEscalation is
    // idempotent per settlement, so re-running never buries earlier human decisions.
    const anomalies = store.ranked
      .filter((s) => s && s.isLocalAnomaly)
      .slice(0, MAX_ESCALATIONS_PER_RUN);

    for (const s of anomalies) {
      try {
        createEscalation({
          settlementId: s.settlementId,
          title: `Anomalous silence: ${s.name} (${s.district}) - ${round(s.silenceHours)}h with no confirming report`,
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
            giZScore: s.giZScore,
            coverageBasis: s.coverageBasis,
            corroborationCount: s.corroborationCount,
            rank: s.rank
          }
        });
      } catch (err) {
        addIncident('degraded-source', `Could not raise escalation for ${s.settlementId}: ${err.message}`, {
          settlementId: s.settlementId,
          error: err.message
        });
      }
    }

    for (const pair of ambiguousPairs.slice(0, MAX_AMBIGUOUS_PER_RUN)) {
      try {
        createAmbiguousMatch({
          title: pair.title || describePair(pair),
          settlementId: pair.settlementId ?? null,
          evidence: pair
        });
      } catch (err) {
        addIncident('degraded-source', `Could not hold ambiguous match: ${err.message}`, { error: err.message });
      }
    }

    // --- 6. STATS --------------------------------------------------------
    const durationMs = Date.now() - started;
    store.stats = {
      reportCount: store.reports.length,
      clusterCount: store.clusters.length,
      lastRunAt: new Date().toISOString(),
      durationMs,
      rankedCount: store.ranked.length,
      pendingCheckpointCount: store.checkpoint.filter((i) => i.status === 'pending').length
    };

    return { ok: true, reportCount: store.reports.length, clusterCount: store.clusters.length, durationMs };
  } finally {
    running = false;
  }
}

function round(n, places = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function describePair(pair) {
  const a = pair.leftLabel || pair.aLabel || pair.leftId || pair.aId || pair.a || 'candidate A';
  const b = pair.rightLabel || pair.bLabel || pair.rightId || pair.bId || pair.b || 'candidate B';
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
    return addIncident('degraded-source', 'Connector health probe failed: no sources registered yet', {
      simulated: true
    });
  }
  const source = store.sources[name];
  const previousStatus = source.status;
  source.status = 'degraded';
  const incident = addIncident('degraded-source', `Connector "${name}" stopped returning results - coverage is now partial`, {
    simulated: true,
    source: name,
    sourceType: source.sourceType ?? null,
    previousStatus
  });

  // Self-heal, so the fail feed shows recovery as well as failure.
  setTimeout(() => {
    if (store.sources[name]) {
      store.sources[name].status = previousStatus || 'ok';
      addIncident('heal', `Connector "${name}" recovered - coverage restored`, { source: name });
    }
  }, 20000).unref?.();

  return incident;
}

function simulateAmbiguousMatch() {
  const fn = findSimulator(['simulateAmbiguousMatch', 'simulateAmbiguous']);
  if (fn) return fn(store);

  // Two real near-identical transliterations from the gazetteer make the honest demo.
  const a = store.settlements[0] || { id: 'unknown-a', name: 'Candidate A' };
  const b = store.settlements.find((s) => s.id !== a.id) || { id: 'unknown-b', name: 'Candidate B' };

  const item = createAmbiguousMatch({
    title: `Ambiguous match: "${a.name}" vs "${b.name}" - Fellegi-Sunter p in the grey zone`,
    evidence: {
      leftId: a.id,
      rightId: b.id,
      leftSettlementId: a.id,
      rightSettlementId: b.id,
      leftLabel: a.name,
      rightLabel: b.name,
      matchProbability: 0.61,
      lowerThreshold: 0.35,
      upperThreshold: 0.85,
      note: 'Below the auto-merge threshold and above auto-reject. The machine refuses to guess.',
      simulated: true
    }
  });

  const incident = addIncident(
    'llm-fallback',
    `Low-confidence classification held for review: "${a.name}" vs "${b.name}"`,
    { simulated: true, checkpointId: item.id, matchProbability: 0.61 }
  );
  incident.detail.checkpointItem = item.id;
  return { incident, checkpointItem: item };
}

function simulateColdStart() {
  const fn = findSimulator(['simulateColdStart', 'simulateCold']);
  if (fn) return fn(store);

  const target =
    store.ranked.find((s) => s.coverageBasis !== 'cohort-cold-start') || store.ranked[0] || null;
  if (!target) {
    return addIncident('cold-start', 'Cold-start settlement encountered before any ranking existed', {
      simulated: true
    });
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
  res.json({ ok: true, lastRunAt: store.stats?.lastRunAt ?? null });
});

app.get('/api/state', (_req, res) => {
  res.json({
    settlements: store.ranked,
    checkpoint: store.checkpoint,
    incidents: store.incidents,
    sources: sourcesArray(),
    stats: {
      reportCount: store.stats?.reportCount ?? store.reports.length,
      clusterCount: store.stats?.clusterCount ?? store.clusters.length,
      lastRunAt: store.stats?.lastRunAt ?? null,
      durationMs: store.stats?.durationMs ?? 0,
      pendingCheckpointCount: store.checkpoint.filter((i) => i.status === 'pending').length
    }
  });
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

app.post('/api/run', async (_req, res) => {
  try {
    const result = await runPipeline();
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    addIncident('degraded-source', `Pipeline run failed: ${err.message}`, { error: err.message });
    console.error('[signal-zero] pipeline error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function decideRoute(action) {
  return (req, res) => {
    const approvedBy = req.body ? req.body.approvedBy : undefined;
    try {
      const item = action(req.params.id, approvedBy);
      res.json({
        ok: true,
        item,
        // Approval unlocks a sorted CANDIDATE LIST of jurisdictions to inform.
        // It is never an assignment. See buildShortlist() in checkpoint.js.
        shortlist: item.status === 'approved' ? buildShortlist(item, store.settlements) : []
      });
    } catch (err) {
      const status = err instanceof CheckpointError ? err.statusCode : 500;
      if (status >= 500) console.error('[signal-zero] checkpoint error:', err);
      res.status(status || 500).json({ ok: false, error: err.message, code: err.code || 'ERROR' });
    }
  };
}

app.post('/api/checkpoint/:id/approve', decideRoute(approve));
app.post('/api/checkpoint/:id/reject', decideRoute(reject));

app.get('/api/settlement/:id', (req, res) => {
  const id = req.params.id;
  const settlement = store.settlements.find((s) => s.id === id) || null;
  const ranked = store.ranked.find((s) => s.settlementId === id) || null;

  if (!settlement && !ranked) {
    return res.status(404).json({ ok: false, error: `No settlement "${id}".` });
  }

  const reports = store.reports.filter((r) => r.settlementId === id);
  const clusterIds = new Set(reports.map((r) => r.clusterId).filter(Boolean));
  const clusters = store.clusters.filter(
    (c) => clusterIds.has(c.id) || c.settlementId === id
  );

  res.json({
    ok: true,
    settlement,
    ranked,
    reports,
    clusters,
    neighbors: corridor[id] || [],
    checkpoint: store.checkpoint.filter((i) => i.settlementId === id),
    scoreBreakdown: buildScoreBreakdown(ranked, reports)
  });
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
    coverageBasis: ranked.coverageBasis,
    corroborationCount: ranked.corroborationCount,
    reportsUsed: reports.length,
    method: 'Exponential time-between-events baseline per hazard-tier cohort, then Getis-Ord Gi* over the river-corridor adjacency graph. Deterministic - no LLM touches these numbers.'
  };
}

app.post('/api/demo/fail/:kind', (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  try {
    if (kind === 'source') return res.json({ ok: true, incident: simulateDegradedSource() });
    if (kind === 'ambiguous') {
      const result = simulateAmbiguousMatch();
      if (result && result.incident) {
        return res.json({ ok: true, incident: result.incident, checkpointItem: result.checkpointItem });
      }
      return res.json({ ok: true, incident: result });
    }
    if (kind === 'coldstart' || kind === 'cold-start') {
      return res.json({ ok: true, incident: simulateColdStart() });
    }
    res.status(400).json({ ok: false, error: `Unknown failure kind "${kind}". Use source | ambiguous | coldstart.` });
  } catch (err) {
    console.error('[signal-zero] demo failure error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: `No route ${req.method} ${req.path}` });
  }
  const index = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).type('text/plain').send('Not found');
});

// Express error handler - the process must survive anything a route throws.
app.use((err, _req, res, _next) => {
  console.error('[signal-zero] unhandled route error:', err);
  addIncident('degraded-source', `Request failed: ${err.message}`, { error: err.message });
  res.status(500).json({ ok: false, error: err.message });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function start() {
  await loadStages();

  try {
    const result = await runPipeline();
    console.log(
      `[signal-zero] boot pipeline pass: ${result.reportCount ?? 0} reports, ` +
        `${store.ranked.length} settlements ranked, ${result.durationMs ?? 0}ms`
    );
  } catch (err) {
    console.error('[signal-zero] boot pipeline failed (server still starting):', err.message);
    addIncident('degraded-source', `Boot pipeline pass failed: ${err.message}`, { error: err.message });
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
    console.log(`  settlements: ${store.settlements.length}   reports: ${store.reports.length}   ` +
      `pending checkpoints: ${store.checkpoint.filter((i) => i.status === 'pending').length}`);
    console.log('');
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

start();
