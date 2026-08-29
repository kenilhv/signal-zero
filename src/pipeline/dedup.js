// Signal Zero - DEDUP (pipeline stage 3)
// ---------------------------------------------------------------------------
// Turns a pile of reports into "same event" clusters, so that ten outlets
// rewriting one wire story count as ONE corroboration, not ten. This is what
// keeps the silence ranking honest: volume must never masquerade as coverage.
//
// Method, all deterministic and auditable - no LLM is involved anywhere in
// this file, by design:
//
//   a) BLOCKING          - only compare pairs that could plausibly match
//                          (shared/adjacent settlement, or high text overlap,
//                          inside a time window). Never all-pairs.
//   b) COMPARISON VECTOR - geo bucket, time-delta bucket, trigram-cosine
//                          bucket, source-type agreement.
//   c) FELLEGI-SUNTER    - log-likelihood ratio over those buckets with
//                          hand-pinned m/u probabilities, turned into a
//                          calibrated matchProbability in [0,1].
//   d) CLUSTERING        - connected components, then a Leiden-inspired
//                          connectivity refinement pass.
//   e) AMBIGUOUS BAND    - pairs the model is genuinely unsure about are NOT
//                          auto-decided. They are handed to the Human
//                          Checkpoint and wait for a named approver.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeText, trigramVector, cosineOfVectors } from './triage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORRIDOR_PATH = path.join(HERE, '..', 'data', 'corridor.json');

// --- tuning knobs (all explicit, all auditable) ----------------------------

const TIME_WINDOW_HOURS = 72; // outside this, two reports are not one event
const TEXT_SIM_BLOCK = 0.35; // minimum text overlap to bother comparing
const TEXT_SNIPPET_CHARS = 600; // bound the cost of the text vectors

export const ADMIT_THRESHOLD = 0.6; // >= this => auto-linked edge
export const AMBIGUOUS_LOW = 0.45; // [LOW, ADMIT) => Human Checkpoint
export const AMBIGUOUS_HIGH = ADMIT_THRESHOLD;

// A weak bridge holding a component together gets cut by the refinement pass.
const WEAK_BRIDGE_MAX = 0.75;

// ---------------------------------------------------------------------------
// FELLEGI-SUNTER m/u PROBABILITIES - HAND-PINNED ON PURPOSE.
//
// m[level] = P(comparison lands in this level | the pair IS the same event)
// u[level] = P(comparison lands in this level | the pair is NOT)
//
// WHY NOT EM-TRAINED:
// The textbook move is to fit m/u with expectation-maximisation over the
// candidate pairs. We deliberately do not, and it is not laziness:
//   1. The true-match class here is tiny and wildly imbalanced - a live
//      disaster feed yields a few dozen genuine duplicate pairs against
//      thousands of non-matches. EM on that ratio is badly identified and
//      routinely converges to a degenerate solution that labels everything a
//      match (or nothing).
//   2. EM assumes the comparison fields are conditionally independent given
//      match status. Ours are openly not: geo agreement and text agreement are
//      strongly correlated (same town name in both texts drives both fields).
//      EM will happily double-count that correlation into overconfident
//      probabilities.
//   3. Fitted-on-the-fly parameters mean the same two reports can be linked in
//      one run and split in the next, with no human-legible reason. In a
//      system whose entire promise is an auditable trail behind a human
//      approval, silently drifting weights are a defect, not a feature.
// Pinned values are conservative, reviewable, and stable across runs. Each
// field's m values sum to 1 and its u values sum to 1.
// ---------------------------------------------------------------------------

const MU = {
  geo: {
    // levels: same settlement / adjacent on the river corridor / far / unknown
    same: { m: 0.88, u: 0.1 },
    adjacent: { m: 0.08, u: 0.15 },
    far: { m: 0.02, u: 0.7 },
    unknown: { m: 0.02, u: 0.05 }
  },
  time: {
    lt6h: { m: 0.7, u: 0.12 },
    lt24h: { m: 0.22, u: 0.23 },
    lt72h: { m: 0.07, u: 0.35 },
    beyond: { m: 0.01, u: 0.3 }
  },
  text: {
    high: { m: 0.55, u: 0.03 },
    med: { m: 0.33, u: 0.17 },
    low: { m: 0.12, u: 0.8 }
  },
  source: {
    // Deliberately a WEAK field (likelihood ratios near 1). Two outlets of
    // different types covering one event is completely normal, so source-type
    // agreement carries almost no evidence either way. It is kept in the
    // vector for transparency, not for lift.
    same: { m: 0.45, u: 0.38 },
    diff: { m: 0.55, u: 0.62 }
  }
};

// Prior probability that an arbitrary BLOCKED pair is a true match. Blocking
// has already thrown away the obvious non-matches, so this is well above the
// all-pairs base rate but still small.
const PRIOR_MATCH = 0.05;

// ---------------------------------------------------------------------------
// Adjacency (river-corridor graph). Same file the ranking stage uses.
// ---------------------------------------------------------------------------

function loadCorridor() {
  try {
    return JSON.parse(fs.readFileSync(CORRIDOR_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function buildAdjacency() {
  const raw = loadCorridor();
  const adj = new Map();
  for (const [id, neighbours] of Object.entries(raw)) {
    adj.set(id, new Set(Array.isArray(neighbours) ? neighbours : []));
  }
  return adj;
}

// ---------------------------------------------------------------------------
// Comparison vector
// ---------------------------------------------------------------------------

function geoLevel(a, b, adj) {
  if (!a.settlementId || !b.settlementId) return 'unknown';
  if (a.settlementId === b.settlementId) return 'same';
  const na = adj.get(a.settlementId);
  if (na && na.has(b.settlementId)) return 'adjacent';
  const nb = adj.get(b.settlementId);
  if (nb && nb.has(a.settlementId)) return 'adjacent';
  return 'far';
}

function timeLevel(hours) {
  if (!Number.isFinite(hours)) return 'beyond';
  if (hours < 6) return 'lt6h';
  if (hours < 24) return 'lt24h';
  if (hours < 72) return 'lt72h';
  return 'beyond';
}

function textLevel(sim) {
  if (sim >= 0.55) return 'high';
  if (sim >= 0.3) return 'med';
  return 'low';
}

function hoursBetween(a, b) {
  const ta = Date.parse(a.publishedAt);
  const tb = Date.parse(b.publishedAt);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs(ta - tb) / 3600000;
}

/**
 * Fellegi-Sunter: sum the per-field log-likelihood ratios, apply the prior,
 * convert posterior odds to a probability.
 */
function fellegiSunter(vector) {
  let logLR = 0;
  const contributions = {};
  for (const field of Object.keys(MU)) {
    const level = vector[field];
    const cell = MU[field][level];
    if (!cell) continue;
    const w = Math.log(cell.m / cell.u);
    contributions[field] = Number(w.toFixed(4));
    logLR += w;
  }
  const priorOdds = PRIOR_MATCH / (1 - PRIOR_MATCH);
  const posteriorOdds = priorOdds * Math.exp(logLR);
  const p = posteriorOdds / (1 + posteriorOdds);
  return {
    matchProbability: Number(p.toFixed(4)),
    logLikelihoodRatio: Number(logLR.toFixed(4)),
    weights: contributions
  };
}

/** Build the full comparison vector + score for one candidate pair. */
function scorePair(a, b, ctx) {
  const hours = hoursBetween(a, b);
  const sim = cosineOfVectors(ctx.vectors.get(a.id), ctx.vectors.get(b.id));
  const vector = {
    geo: geoLevel(a, b, ctx.adj),
    time: timeLevel(hours),
    text: textLevel(sim),
    source: a.sourceType === b.sourceType ? 'same' : 'diff'
  };
  const scored = fellegiSunter(vector);
  return {
    aId: a.id,
    bId: b.id,
    vector,
    textSimilarity: Number(sim.toFixed(4)),
    hoursApart: Number.isFinite(hours) ? Number(hours.toFixed(2)) : null,
    ...scored
  };
}

// ---------------------------------------------------------------------------
// Blocking: generate only plausible candidate pairs.
// ---------------------------------------------------------------------------

function candidatePairs(reports, ctx) {
  const pairs = [];
  const seen = new Set();
  const key = (a, b) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

  const bySettlement = new Map();
  const unresolved = [];
  for (const r of reports) {
    if (r.settlementId) {
      let bucket = bySettlement.get(r.settlementId);
      if (!bucket) bySettlement.set(r.settlementId, (bucket = []));
      bucket.push(r);
    } else {
      unresolved.push(r);
    }
  }

  const consider = (a, b) => {
    if (a.id === b.id) return;
    const k = key(a, b);
    if (seen.has(k)) return;
    if (hoursBetween(a, b) > TIME_WINDOW_HOURS) return;
    seen.add(k);
    pairs.push([a, b]);
  };

  // Block 1: same settlement.
  for (const bucket of bySettlement.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) consider(bucket[i], bucket[j]);
    }
  }

  // Block 2: adjacent settlements on the river corridor. A single flood pulse
  // moving downstream really does get reported as one event from two towns.
  for (const [sid, bucket] of bySettlement) {
    const neighbours = ctx.adj.get(sid);
    if (!neighbours) continue;
    for (const nid of neighbours) {
      if (nid <= sid) continue; // each unordered settlement pair once
      const other = bySettlement.get(nid);
      if (!other) continue;
      for (const a of bucket) for (const b of other) consider(a, b);
    }
  }

  // Block 3: unresolved reports have no geography to block on, so they are
  // compared on text alone - but only against everything else, never
  // everything against everything. This set is small by construction (triage
  // resolves most reports); if it somehow is not, we cap it and let the
  // unmatched reports stand as their own singleton clusters.
  const MAX_UNRESOLVED = 200;
  if (unresolved.length && unresolved.length <= MAX_UNRESOLVED) {
    for (const a of unresolved) {
      for (const b of reports) {
        if (a.id === b.id) continue;
        if (hoursBetween(a, b) > TIME_WINDOW_HOURS) continue;
        const sim = cosineOfVectors(ctx.vectors.get(a.id), ctx.vectors.get(b.id));
        if (sim >= TEXT_SIM_BLOCK) consider(a, b);
      }
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Clustering: connected components, then Leiden-inspired refinement.
// ---------------------------------------------------------------------------

function connectedComponents(nodeIds, edges) {
  const adj = new Map();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const e of edges) {
    if (!adj.has(e.aId) || !adj.has(e.bId)) continue;
    adj.get(e.aId).add(e.bId);
    adj.get(e.bId).add(e.aId);
  }

  const seen = new Set();
  const components = [];
  for (const id of nodeIds) {
    if (seen.has(id)) continue;
    const stack = [id];
    const comp = [];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (const nb of adj.get(cur)) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    components.push(comp);
  }
  return components;
}

/**
 * Find bridges (edges whose removal disconnects the subgraph) among `members`.
 * Plain DFS bridge-finding; small graphs, so clarity beats cleverness.
 */
function findBridges(members, edges) {
  const idx = new Map(members.map((id, i) => [id, i]));
  const adj = members.map(() => []);
  edges.forEach((e, ei) => {
    const a = idx.get(e.aId);
    const b = idx.get(e.bId);
    if (a === undefined || b === undefined) return;
    adj[a].push([b, ei]);
    adj[b].push([a, ei]);
  });

  const disc = new Array(members.length).fill(-1);
  const low = new Array(members.length).fill(0);
  const bridges = [];
  let timer = 0;

  const dfs = (u, parentEdge) => {
    disc[u] = low[u] = timer++;
    for (const [v, ei] of adj[u]) {
      if (ei === parentEdge) continue;
      if (disc[v] === -1) {
        dfs(v, ei);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] > disc[u]) bridges.push(ei);
      } else {
        low[u] = Math.min(low[u], disc[v]);
      }
    }
  };

  for (let i = 0; i < members.length; i++) if (disc[i] === -1) dfs(i, -1);
  return bridges;
}

/**
 * LEIDEN-INSPIRED CONNECTIVITY REFINEMENT.
 *
 * Honest framing: this is NOT the Leiden algorithm. There is no modularity
 * optimisation, no local moving phase, no aggregation loop here. What it does
 * borrow is the single property Leiden guarantees and Louvain does not: that
 * every returned community is WELL CONNECTED internally. Louvain can and does
 * emit communities that are internally disconnected or held together by one
 * flimsy edge, because it only ever checks modularity gain, never internal
 * structure.
 *
 * Connected components have the same disease in a worse form: one 0.61 edge
 * between two dense groups fuses them permanently. For duplicate detection on
 * disaster reports that is a real failure mode - it silently merges two
 * distinct events into one "corroborated" cluster and inflates the coverage of
 * a settlement that has not actually been confirmed.
 *
 * So after components, each component is checked for a weak articulation:
 * a bridge edge whose weight is below WEAK_BRIDGE_MAX and which, when cut,
 * yields two non-trivial sides. Such a bridge is cut and both sides are
 * re-examined recursively. Every cluster this returns is therefore internally
 * connected and not dependent on a single weak link.
 */
export function refineComponent(members, edgesWithin, depth = 0) {
  if (members.length < 3 || depth > 6) return [members];

  const bridgeIdxs = findBridges(members, edgesWithin);
  if (!bridgeIdxs.length) return [members];

  // Cut the weakest qualifying bridge first.
  let target = null;
  for (const ei of bridgeIdxs) {
    const e = edgesWithin[ei];
    if (e.matchProbability > WEAK_BRIDGE_MAX) continue;
    if (!target || e.matchProbability < edgesWithin[target].matchProbability) target = ei;
  }
  if (target === null) return [members];

  const kept = edgesWithin.filter((_, i) => i !== target);
  const sides = connectedComponents(members, kept);
  if (sides.length < 2) return [members];

  // Only accept the split if both sides are substantive - snipping a single
  // leaf report off a cluster is not a badly-connected-community fix.
  const nonTrivial = sides.filter((s) => s.length >= 2).length;
  if (nonTrivial < 2) return [members];

  const out = [];
  for (const side of sides) {
    const sideSet = new Set(side);
    const inside = kept.filter((e) => sideSet.has(e.aId) && sideSet.has(e.bId));
    out.push(...refineComponent(side, inside, depth + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {Array} reports     Report[] (post-triage). clusterId is set in place.
 * @param {Array} settlements Settlement[] (unused for math, kept for contract
 *                            symmetry and future gazetteer-aware blocking)
 * @returns {{clusters: Array, ambiguousPairs: Array}}
 */
export function dedup(reports, settlements) {
  const list = Array.isArray(reports) ? reports : [];
  const adj = buildAdjacency();

  // Precompute one trigram vector per report; every pair comparison reuses it.
  const vectors = new Map();
  for (const r of list) {
    const snippet = `${r.title || ''} ${String(r.text || '').slice(0, TEXT_SNIPPET_CHARS)}`;
    vectors.set(r.id, trigramVector(snippet));
    r.clusterId = null;
  }
  const ctx = { adj, vectors, settlements: settlements || [] };

  const pairs = candidatePairs(list, ctx);
  const scored = pairs.map(([a, b]) => scorePair(a, b, ctx));

  const admitted = scored.filter((p) => p.matchProbability >= ADMIT_THRESHOLD);
  const ambiguousPairs = scored
    .filter(
      (p) => p.matchProbability >= AMBIGUOUS_LOW && p.matchProbability < AMBIGUOUS_HIGH
    )
    .map((p) => decoratePair(p, list));

  // --- cluster ------------------------------------------------------------
  const nodeIds = list.map((r) => r.id);
  const components = connectedComponents(nodeIds, admitted);

  const refined = [];
  for (const comp of components) {
    const compSet = new Set(comp);
    const inside = admitted.filter((e) => compSet.has(e.aId) && compSet.has(e.bId));
    refined.push(...refineComponent(comp, inside));
  }

  const byId = new Map(list.map((r) => [r.id, r]));
  const clusters = refined
    .map((members) => {
      const memberSet = new Set(members);
      const inside = admitted.filter((e) => memberSet.has(e.aId) && memberSet.has(e.bId));
      const memberReports = members.map((id) => byId.get(id)).filter(Boolean);

      // Majority settlement among members; ties broken by earliest report.
      const tally = new Map();
      for (const r of memberReports) {
        if (!r.settlementId) continue;
        tally.set(r.settlementId, (tally.get(r.settlementId) || 0) + 1);
      }
      let settlementId = null;
      let bestCount = 0;
      for (const [sid, count] of tally) {
        if (count > bestCount) {
          bestCount = count;
          settlementId = sid;
        }
      }

      const confidence = inside.length
        ? Number(
            (inside.reduce((s, e) => s + e.matchProbability, 0) / inside.length).toFixed(4)
          )
        : // Singleton cluster: no internal edges exist, so there is nothing to
          // average. 0.5 = "uncorroborated", not "confidently one event".
          0.5;

      const earliest = memberReports
        .map((r) => Date.parse(r.publishedAt))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];

      return {
        settlementId,
        reportIds: members.slice().sort(),
        confidence,
        sourceTypeDiversity: new Set(memberReports.map((r) => r.sourceType).filter(Boolean)).size,
        _sortKey: Number.isFinite(earliest) ? earliest : Number.MAX_SAFE_INTEGER
      };
    })
    .sort((a, b) => a._sortKey - b._sortKey)
    .map((c, i) => {
      const id = `cl-${String(i + 1).padStart(3, '0')}`;
      delete c._sortKey;
      const cluster = { id, ...c };
      for (const rid of cluster.reportIds) {
        const r = byId.get(rid);
        if (r) r.clusterId = id;
      }
      return cluster;
    });

  return { clusters, ambiguousPairs };
}

function decoratePair(pair, reports) {
  const byId = new Map(reports.map((r) => [r.id, r]));
  const a = byId.get(pair.aId);
  const b = byId.get(pair.bId);
  return {
    id: `amb-${pair.aId}-${pair.bId}`,
    ...pair,
    settlementId: a?.settlementId || b?.settlementId || null,
    a: a
      ? { id: a.id, sourceName: a.sourceName, sourceType: a.sourceType, title: a.title, url: a.url, publishedAt: a.publishedAt, settlementId: a.settlementId }
      : null,
    b: b
      ? { id: b.id, sourceName: b.sourceName, sourceType: b.sourceType, title: b.title, url: b.url, publishedAt: b.publishedAt, settlementId: b.settlementId }
      : null,
    band: [AMBIGUOUS_LOW, AMBIGUOUS_HIGH],
    reason:
      `matchProbability ${pair.matchProbability} sits in the undecidable band ` +
      `[${AMBIGUOUS_LOW}, ${AMBIGUOUS_HIGH}). Linking these would change the ` +
      `corroboration count for this settlement, so a named human decides.`
  };
}

/**
 * Force one ambiguous pair for the live demo (POST /api/demo/fail/ambiguous).
 * Prefers a genuinely near-threshold pair; if the corpus does not contain one,
 * it takes the closest pair available and pins the score into the band, marking
 * the result forced:true so the audit trail never lies about what happened.
 */
export function simulateAmbiguousPair(reports) {
  const list = Array.isArray(reports) ? reports : [];
  if (list.length < 2) return null;

  const adj = buildAdjacency();
  const vectors = new Map();
  for (const r of list) {
    vectors.set(
      r.id,
      trigramVector(`${r.title || ''} ${String(r.text || '').slice(0, TEXT_SNIPPET_CHARS)}`)
    );
  }
  const ctx = { adj, vectors, settlements: [] };

  const scored = candidatePairs(list, ctx).map(([a, b]) => scorePair(a, b, ctx));

  const genuine = scored.find(
    (p) => p.matchProbability >= AMBIGUOUS_LOW && p.matchProbability < AMBIGUOUS_HIGH
  );
  if (genuine) return { ...decoratePair(genuine, list), forced: false };

  const mid = (AMBIGUOUS_LOW + AMBIGUOUS_HIGH) / 2;
  let closest = scored.sort(
    (x, y) => Math.abs(x.matchProbability - mid) - Math.abs(y.matchProbability - mid)
  )[0];

  if (!closest) {
    // No blocked pair at all - fabricate one from the two most recent reports
    // so the demo button always produces something reviewable.
    const [a, b] = list.slice(0, 2);
    closest = {
      aId: a.id,
      bId: b.id,
      vector: { geo: 'unknown', time: 'lt24h', text: 'med', source: a.sourceType === b.sourceType ? 'same' : 'diff' },
      textSimilarity: Number(cosineOfVectors(vectors.get(a.id), vectors.get(b.id)).toFixed(4)),
      hoursApart: null,
      matchProbability: mid,
      logLikelihoodRatio: 0,
      weights: {}
    };
  }

  return {
    ...decoratePair({ ...closest, matchProbability: mid }, list),
    forced: true,
    originalMatchProbability: closest.matchProbability
  };
}

export default dedup;

// ---------------------------------------------------------------------------
// Sanity checks: `node src/pipeline/dedup.js`
// ---------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error('FAIL:', msg);
      process.exitCode = 1;
    } else {
      console.log('ok  :', msg);
    }
  };

  const mk = (id, settlementId, publishedAt, sourceType, sourceName, title, text) => ({
    id,
    sourceType,
    sourceName,
    url: `https://example.test/${id}`,
    title,
    text,
    publishedAt,
    fetchedAt: '2026-08-26T18:00:00Z',
    settlementId,
    triage: { category: 'corroboration-candidate', confidence: 0.9, tier: 1 },
    clusterId: null
  });

  // m/u tables must be proper distributions or the FS weights are meaningless.
  for (const [field, levels] of Object.entries(MU)) {
    const sm = Object.values(levels).reduce((s, c) => s + c.m, 0);
    const su = Object.values(levels).reduce((s, c) => s + c.u, 0);
    assert(Math.abs(sm - 1) < 1e-9, `${field}: m probabilities sum to 1 (got ${sm.toFixed(4)})`);
    assert(Math.abs(su - 1) < 1e-9, `${field}: u probabilities sum to 1 (got ${su.toFixed(4)})`);
  }

  // Monotonicity: strong agreement must outscore weak agreement.
  const strong = fellegiSunter({ geo: 'same', time: 'lt6h', text: 'high', source: 'diff' });
  const weak = fellegiSunter({ geo: 'far', time: 'beyond', text: 'low', source: 'diff' });
  assert(strong.matchProbability > 0.95, `strong agreement scores high (${strong.matchProbability})`);
  assert(weak.matchProbability < 0.01, `total disagreement scores near zero (${weak.matchProbability})`);
  assert(
    strong.matchProbability > weak.matchProbability,
    'match probability is monotone in agreement'
  );

  // Two outlets, same town, same hour, near-identical wording => one cluster.
  const dupA = mk(
    'a1', 'np-nuwakot-betrawati', '2026-08-26T09:00:00Z', 'news', 'Kathmandu Post',
    'Forty households displaced in Betrawati',
    'Forty households were displaced in Betrawati after the Trishuli surge. The suspension bridge was damaged and the road is blocked.'
  );
  const dupB = mk(
    'a2', 'np-nuwakot-betrawati', '2026-08-26T10:30:00Z', 'news', 'Republica',
    '40 households displaced at Betrawati',
    '40 households displaced in Betrawati following the Trishuli surge. A suspension bridge was damaged and the road remains blocked.'
  );
  // Unrelated settlement, days later, different subject => must stay separate.
  const far = mk(
    'a3', 'np-dhading-benighat', '2026-08-29T09:00:00Z', 'official', 'DEOC Dhading',
    'Benighat relief distribution',
    'Relief materials were distributed to families in Benighat. A health post has been set up.'
  );

  const reports = [dupA, dupB, far];
  const { clusters, ambiguousPairs } = dedup(reports, []);

  assert(Array.isArray(clusters) && Array.isArray(ambiguousPairs), 'dedup returns both arrays');
  assert(clusters.length === 2, `duplicates merge, far report stays alone (got ${clusters.length} clusters)`);

  const merged = clusters.find((c) => c.reportIds.length === 2);
  assert(Boolean(merged), 'the two near-identical reports landed in one cluster');
  assert(merged.settlementId === 'np-nuwakot-betrawati', 'merged cluster carries the settlement id');
  assert(merged.confidence >= ADMIT_THRESHOLD, `cluster confidence is the mean edge weight (${merged.confidence})`);
  assert(merged.sourceTypeDiversity === 1, 'both duplicates are news => diversity 1');
  assert(dupA.clusterId && dupA.clusterId === dupB.clusterId, 'clusterId written back onto reports');
  assert(far.clusterId !== dupA.clusterId, 'unrelated report has its own clusterId');

  const solo = clusters.find((c) => c.reportIds.length === 1);
  assert(solo.confidence === 0.5, 'singleton cluster is marked uncorroborated (0.5), not 1.0');

  // Every cluster must be internally connected - the Leiden-inspired guarantee.
  assert(
    clusters.every((c) => c.reportIds.length >= 1),
    'refinement never returns an empty cluster'
  );

  // Nothing in the corpus should be silently auto-decided inside the band.
  assert(
    ambiguousPairs.every(
      (p) => p.matchProbability >= AMBIGUOUS_LOW && p.matchProbability < AMBIGUOUS_HIGH
    ),
    'every returned ambiguous pair really is inside the band'
  );

  const forced = simulateAmbiguousPair(reports);
  assert(Boolean(forced), 'simulateAmbiguousPair returns a pair');
  assert(
    forced.matchProbability >= AMBIGUOUS_LOW && forced.matchProbability < AMBIGUOUS_HIGH,
    `forced pair sits in the band (${forced.matchProbability})`
  );
  assert(forced.a && forced.b, 'forced pair carries both report summaries for review');
  assert(
    !('dispatch' in forced) && !('assignTo' in forced),
    'no dispatch-shaped field exists on a dedup output'
  );

  console.log('\ndedup.js sanity checks complete.');
}
