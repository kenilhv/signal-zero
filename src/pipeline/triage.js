// Signal Zero - TRIAGE (pipeline stage 2)
// ---------------------------------------------------------------------------
// Classifies every ingested Report into one of four categories and, where
// possible, resolves it to a gazetteer settlement.
//
//   category: 'corroboration-candidate' | 'new-settlement' | 'hazard-signal' | 'noise'
//
// THREE-TIER CASCADE. Each tier only sees what the tier above it could not
// settle, so the expensive tier stays tiny:
//
//   TIER 1  deterministic  - normalized, word-boundary gazetteer name/alias
//                            matching + source-type + lexicon rules. Free.
//   TIER 2  local fuzzy    - hand-rolled character-trigram cosine similarity
//                            (no dependencies, no embeddings, no network)
//                            between short windows of the report text and each
//                            settlement's name/aliases/district.
//   TIER 3  LLM            - ONLY the low-confidence residual. This is the one
//                            and only LLM call in the entire codebase. It never
//                            touches dedup scoring or ranking math, which stay
//                            deterministic and auditable by construction.
//
// Reaching tier 3 is itself a failure signal, so it is always written to the
// incident feed via addIncident('llm-fallback', ...) - whether or not an API
// key is configured.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import config from '../config.js';
import { addIncident } from '../store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAZETTEER_PATH = path.join(HERE, '..', 'data', 'gazetteer.json');

// Bound the demo: tier 3 is the only paid/slow path, so it is hard-capped.
const MAX_LLM_CALLS = 6;
const LLM_TIMEOUT_MS = 12000;

export const CATEGORIES = [
  'corroboration-candidate',
  'new-settlement',
  'hazard-signal',
  'noise'
];

// ---------------------------------------------------------------------------
// Text normalization + hand-rolled character trigram cosine.
// Shared with dedup.js (dedup imports these) so both stages agree on what
// "similar text" means. No dependencies anywhere in here.
// ---------------------------------------------------------------------------

/**
 * Lowercase, strip diacritics, collapse everything non-alphanumeric to single
 * spaces. "Syabru-Besi" and "syābru besi" both become "syabru besi".
 */
export function normalizeText(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Character trigrams of an already-normalized string, padded at both ends. */
export function trigrams(normalized) {
  if (!normalized) return [];
  const padded = `  ${normalized}  `;
  const out = [];
  for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
  return out;
}

/** Term-frequency vector (Map trigram -> count) plus its precomputed norm. */
export function trigramVector(text) {
  const counts = new Map();
  for (const g of trigrams(normalizeText(text))) {
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  let sumSq = 0;
  for (const c of counts.values()) sumSq += c * c;
  return { counts, norm: Math.sqrt(sumSq) };
}

/** Cosine similarity between two vectors from trigramVector(). */
export function cosineOfVectors(a, b) {
  if (!a || !b || a.norm === 0 || b.norm === 0) return 0;
  // Iterate the smaller map - the dot product is sparse.
  const [small, large] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [g, c] of small.counts) {
    const other = large.counts.get(g);
    if (other) dot += c * other;
  }
  return dot / (a.norm * b.norm);
}

/** Character-trigram cosine similarity between two raw strings, in [0,1]. */
export function trigramCosine(a, b) {
  return cosineOfVectors(trigramVector(a), trigramVector(b));
}

// ---------------------------------------------------------------------------
// Lexicons. Matched as substrings of the NORMALIZED text, so stems like
// "evacuat" cover evacuate/evacuated/evacuation without a stemmer.
// ---------------------------------------------------------------------------

const HAZARD_WORDS = [
  'glof', 'glacial lake', 'outburst', 'flood', 'inundat', 'submerg',
  'landslide', 'debris flow', 'debris', 'surge', 'breach', 'burst',
  'water level', 'discharge', 'swollen', 'overflow', 'siren', 'warning',
  'alert', 'evacuat', 'upstream', 'downstream', 'moraine', 'dam',
  'river rose', 'rising river', 'cloudburst', 'washed away', 'swept away'
];

// Concrete, on-the-ground observation. Only these can turn a report into a
// corroboration - i.e. positive evidence that somebody actually looked.
const STRONG_STATUS_WORDS = [
  'reached', 'contacted', 'casualt', 'injur', 'dead', 'death', 'missing',
  'rescue', 'relief', 'shelter', 'displaced', 'damaged', 'destroyed',
  'swept', 'washed away', 'cut off', 'households', 'houses', 'homes',
  'search team', 'helicopter', 'security personnel', 'health post',
  'no casualties', 'road blocked', 'distributed'
];

// Suggestive but not sufficient on its own. Two of these with no warning
// framing count as corroboration; one does not.
const WEAK_STATUS_WORDS = [
  'residents', 'villagers', 'families', 'bridge', 'ward', 'confirmed',
  'police post', 'local unit'
];

const STATUS_WORDS = [...STRONG_STATUS_WORDS, ...WEAK_STATUS_WORDS];

// Forward-looking framing: this report is telling people what MIGHT happen,
// not reporting what did. A warning is never a corroboration.
const WARNING_WORDS = [
  'warned', 'warning', 'alert', 'advisory', 'forecast', 'siren', 'issued',
  'expected to', 'may rise', 'could rise', 'on standby', 'preparedness'
];

// Explicit statements that nobody has heard from a place. Signal Zero exists
// precisely because these are the OPPOSITE of a corroboration - treating them
// as confirmation would mark a silent settlement as covered.
const NEGATIVE_CONTACT_WORDS = [
  'no contact', 'not been reached', 'yet to be reached', 'unreachable',
  'unaccounted', 'no word', 'no communication', 'cannot be reached',
  'could not be reached', 'lost contact', 'no information', 'still silent',
  'no response'
];

const NOISE_WORDS = [
  'trekking season', 'tourist arrival', 'cricket', 'election', 'stock market',
  'share market', 'film', 'cinema', 'festival lineup', 'transfer window',
  'cabinet reshuffle', 'horoscope', 'recipe', 'gold price', 'hotel booking',
  'visit nepal campaign', 'match fixture'
];

// Words that, when they FOLLOW a matched settlement token, mean the token was
// naming the river/valley, not the town. Without this every single report that
// says "Trishuli river" would resolve to Trishuli Bazar.
// Deliberately limited to hydrological / physical-feature words. Words like
// "rural" are NOT here: "Uttargaya Rural Municipality" must still resolve.
const GEOGRAPHIC_CONTEXT = new Set([
  'river', 'khola', 'nadi', 'valley', 'corridor', 'basin', 'catchment',
  'watershed', 'gorge', 'district'
]);

// Markers that a capitalized token in the RAW text is naming a place.
const PLACE_MARKER_RE =
  /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(village|bazar|bazaar|gaun|gaon|tole|hamlet|settlement|basti|VDC|ward)\b/g;
const PLACE_MARKER_RE_2 =
  /\b(?:village|settlement|hamlet|ward)\s+of\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/g;

function countHits(normalized, lexicon) {
  const hits = [];
  for (const w of lexicon) if (normalized.includes(w)) hits.push(w);
  return { n: hits.length, hits };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Gazetteer index (built once per triage() call).
// ---------------------------------------------------------------------------

function loadGazetteerFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(GAZETTEER_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function buildIndex(settlements) {
  const entries = [];
  // trigram -> Set of entry indices, used to prefilter tier-2 comparisons so we
  // never do windows x settlements as a full cross product.
  const trigramIndex = new Map();

  settlements.forEach((s) => {
    const variants = [s.name, ...(Array.isArray(s.aliases) ? s.aliases : [])];
    const entry = {
      settlement: s,
      variants: [],
      // "Betrawati Nuwakot" - district appended, per the tier-2 spec.
      docVector: trigramVector(`${s.name} ${variants.join(' ')} ${s.district}`)
    };
    for (const raw of variants) {
      const norm = normalizeText(raw);
      if (!norm) continue;
      const v = {
        raw,
        norm,
        // Word-boundary aware without relying on \b (normalized text is
        // strictly [a-z0-9 ], so space-or-edge IS the word boundary).
        re: new RegExp(`(?:^| )${escapeRe(norm)}(?= |$)`, 'g'),
        vector: trigramVector(raw),
        tokenCount: norm.split(' ').length
      };
      entry.variants.push(v);
    }
    const idx = entries.push(entry) - 1;
    for (const v of entry.variants) {
      for (const g of new Set(trigrams(v.norm))) {
        let bucket = trigramIndex.get(g);
        if (!bucket) trigramIndex.set(g, (bucket = new Set()));
        bucket.add(idx);
      }
    }
  });

  return { entries, trigramIndex };
}

// ---------------------------------------------------------------------------
// Category decision. Deterministic rules over the lexicons above.
// Used by tier 1 and tier 2 alike; only the confidence differs.
// ---------------------------------------------------------------------------

function classifyCategory(report, normalized, settlementId, unknownPlace) {
  const hazard = countHits(normalized, HAZARD_WORDS);
  const status = countHits(normalized, STATUS_WORDS);
  const strong = countHits(normalized, STRONG_STATUS_WORDS);
  const weak = countHits(normalized, WEAK_STATUS_WORDS);
  const warning = countHits(normalized, WARNING_WORDS);
  const negative = countHits(normalized, NEGATIVE_CONTACT_WORDS);
  const noise = countHits(normalized, NOISE_WORDS);
  const signals = {
    hazardHits: hazard.hits.slice(0, 6),
    statusHits: status.hits.slice(0, 6),
    warningHits: warning.hits.slice(0, 4),
    negativeContactHits: negative.hits.slice(0, 4),
    noiseHits: noise.hits.slice(0, 4),
    unknownPlace: unknownPlace || null
  };

  // Off-topic content that never mentions the hazard at all.
  if (noise.n > 0 && hazard.n === 0) return { category: 'noise', strength: 0.95, signals };
  if (hazard.n === 0 && status.n === 0) return { category: 'noise', strength: 0.85, signals };

  // An on-hazard report naming a place we have never heard of is exactly the
  // cold-start case the whole product exists to surface.
  if (!settlementId && unknownPlace && hazard.n > 0) {
    return { category: 'new-settlement', strength: 0.8, signals };
  }

  // A report that says nobody has heard from a place is the exact inverse of a
  // corroboration. It must never be allowed to mark that place as covered.
  const corroborationVetoed = negative.n > 0 || (warning.n > 0 && strong.n === 0);

  // A resolved settlement plus concrete on-the-ground status = the thing that
  // can CONFIRM a settlement is not silent. Official sources are stronger.
  const hasRealStatus = strong.n > 0 || (weak.n >= 2 && warning.n === 0);
  if (settlementId && hasRealStatus && !corroborationVetoed) {
    const official = report.sourceType === 'official';
    const social = report.sourceType === 'social';
    const strength = official ? 0.95 : social ? 0.78 : 0.88;
    return { category: 'corroboration-candidate', strength, signals };
  }

  // An explicit "nobody has heard from X" is a hazard signal about X, and it is
  // the single most valuable input this system takes.
  if (negative.n > 0) {
    return { category: 'hazard-signal', strength: settlementId ? 0.9 : 0.7, signals };
  }

  // Hazard talk without settlement-level status: forecasts, warnings, upstream
  // observations. Useful for the hazard picture, never a corroboration.
  if (hazard.n > 0) return { category: 'hazard-signal', strength: settlementId ? 0.85 : 0.7, signals };

  return { category: 'noise', strength: 0.6, signals };
}

/** Find a capitalized place-looking name in the RAW text that is not in the gazetteer. */
function findUnknownPlace(report, index) {
  const haystack = `${report.title || ''}. ${report.text || ''}`;
  const candidates = new Set();
  for (const re of [PLACE_MARKER_RE, PLACE_MARKER_RE_2]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(haystack)) !== null) {
      const name = (m[1] || '').trim();
      if (name && name.length >= 3) candidates.add(name);
    }
  }
  for (const cand of candidates) {
    const norm = normalizeText(cand);
    if (!norm) continue;
    let best = 0;
    for (const entry of index.entries) {
      for (const v of entry.variants) {
        if (v.norm === norm) { best = 1; break; }
        const sim = cosineOfVectors(v.vector, trigramVector(cand));
        if (sim > best) best = sim;
      }
      if (best >= 0.85) break;
    }
    // Clearly a place, clearly not one of ours.
    if (best < 0.6) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TIER 1 - deterministic gazetteer + rules.
// ---------------------------------------------------------------------------

function tier1Match(report, index) {
  const normalized = normalizeText(`${report.title || ''} ${report.text || ''}`);
  const tokens = normalized ? normalized.split(' ') : [];
  const matches = []; // { entry, variant, count }

  for (const entry of index.entries) {
    let bestVariant = null;
    let count = 0;
    for (const v of entry.variants) {
      v.re.lastIndex = 0;
      let m;
      while ((m = v.re.exec(normalized)) !== null) {
        // Reject "Trishuli river" / "Tadi khola" style geographic uses.
        const after = normalized.slice(m.index + m[0].length).trimStart().split(' ')[0];
        if (GEOGRAPHIC_CONTEXT.has(after)) continue;
        count++;
        if (!bestVariant || v.norm.length > bestVariant.norm.length) bestVariant = v;
      }
    }
    if (count > 0) matches.push({ entry, variant: bestVariant, count });
  }

  return { normalized, tokens, matches };
}

// ---------------------------------------------------------------------------
// TIER 2 - hand-rolled character-trigram cosine over short text windows.
//
// Comparing a 200-word article against a 1-word settlement name with plain
// cosine always scores near zero (length mismatch dominates). So instead we
// slide 1-3 token windows over the report and take the best cosine of any
// window against any name/alias. That is what actually catches the misspellings
// media use: "Syabru Besi" / "Syabrubensi" / "Shyaphrubesi".
// ---------------------------------------------------------------------------

const MIN_TIER2_SIM = 0.55;

function tier2Match(tokens, index, restrictTo = null) {
  const scores = new Map(); // entryIndex -> best cosine
  const evidence = new Map(); // entryIndex -> matched window text
  const allowed = restrictTo
    ? new Set(restrictTo.map((m) => index.entries.indexOf(m.entry)))
    : null;

  for (let i = 0; i < tokens.length; i++) {
    for (let w = 1; w <= 3 && i + w <= tokens.length; w++) {
      const window = tokens.slice(i, i + w).join(' ');
      if (window.length < 4) continue;
      // Same guard tier 1 applies: "trishuli river" names the river, not the
      // town, so no window ending right before a hydrological feature word
      // is allowed to resolve a settlement.
      const nextToken = tokens[i + w];
      if (nextToken && GEOGRAPHIC_CONTEXT.has(nextToken)) continue;
      let hasFeatureWord = false;
      for (let k = i; k < i + w; k++) {
        if (GEOGRAPHIC_CONTEXT.has(tokens[k])) { hasFeatureWord = true; break; }
      }
      if (hasFeatureWord) continue;
      const wv = trigramVector(window);

      // Prefilter: only settlements that share at least one trigram with this
      // window are worth a cosine. Keeps this O(text) rather than O(text x gaz).
      const candidateIdx = new Set();
      for (const g of wv.counts.keys()) {
        const bucket = index.trigramIndex.get(g);
        if (bucket) for (const idx of bucket) candidateIdx.add(idx);
      }
      if (candidateIdx.size === 0) continue;

      for (const idx of candidateIdx) {
        if (allowed && !allowed.has(idx)) continue;
        const entry = index.entries[idx];
        let best = 0;
        for (const v of entry.variants) {
          const sim = cosineOfVectors(wv, v.vector);
          if (sim > best) best = sim;
        }
        if (best > (scores.get(idx) || 0)) {
          scores.set(idx, best);
          evidence.set(idx, window);
        }
      }
    }
  }

  const ranked = [...scores.entries()]
    .map(([idx, score]) => ({
      entry: index.entries[idx],
      score,
      window: evidence.get(idx)
    }))
    .sort((a, b) => b.score - a.score);

  return ranked;
}

// ---------------------------------------------------------------------------
// TIER 3 - the ONLY LLM call in Signal Zero.
// ---------------------------------------------------------------------------

async function tier3Classify(report, shortlist) {
  const options = shortlist
    .map((c) => `${c.entry.settlement.id} (${c.entry.settlement.name}, ${c.entry.settlement.district})`)
    .join('\n');

  const body = {
    model: config.OPENAI_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You classify disaster-response reports for the 2026 Trishuli river GLOF in Nepal. ' +
          'Reply with JSON only: {"category": one of ' + JSON.stringify(CATEGORIES) + ', ' +
          '"settlementId": one of the offered ids or null, "confidence": 0..1, "why": short string}. ' +
          'Never suggest sending anyone anywhere; you only label the text.'
      },
      {
        role: 'user',
        content:
          `SOURCE: ${report.sourceName} (${report.sourceType})\n` +
          `TITLE: ${report.title || ''}\n` +
          `TEXT: ${String(report.text || '').slice(0, 1500)}\n\n` +
          `CANDIDATE SETTLEMENTS (or null if none apply):\n${options || '(none)'}`
      }
    ]
  };

  const res = await fetch(`${config.OPENAI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
  });

  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('LLM returned no content');
  const parsed = JSON.parse(raw);

  const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'noise';
  const allowedIds = new Set(shortlist.map((c) => c.entry.settlement.id));
  const settlementId = allowedIds.has(parsed.settlementId) ? parsed.settlementId : null;
  // Tier 3 is the low-confidence path by construction - never let it claim more
  // certainty than the deterministic tiers.
  const confidence = clamp(Number(parsed.confidence) || 0.4, 0.3, 0.7);

  return { category, settlementId, confidence, why: String(parsed.why || '').slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * @param {Array} reports     Report[] from ingest (mutated in place)
 * @param {Array} settlements Settlement[] from the gazetteer
 * @returns {Promise<Array>}  the same reports, with .triage and .settlementId set
 */
export async function triage(reports, settlements) {
  const list = Array.isArray(reports) ? reports : [];
  const gaz =
    Array.isArray(settlements) && settlements.length ? settlements : loadGazetteerFromDisk();
  const index = buildIndex(gaz);

  const residual = []; // { report, shortlist }

  for (const report of list) {
    // Always recompute - a pipeline run rebuilds everything from scratch.
    report.triage = null;
    report.settlementId = null;

    const { normalized, tokens, matches } = tier1Match(report, index);
    const unknownPlace = findUnknownPlace(report, index);

    // --- TIER 1 -----------------------------------------------------------
    if (matches.length === 1) {
      const only = matches[0];
      const settlementId = only.entry.settlement.id;
      const { category, strength, signals } = classifyCategory(
        report,
        normalized,
        settlementId,
        unknownPlace
      );
      report.settlementId = settlementId;
      report.triage = {
        category,
        confidence: Number(clamp(0.9 * strength + 0.1, 0.6, 0.96).toFixed(3)),
        tier: 1,
        matchedOn: only.variant ? only.variant.raw : only.entry.settlement.name,
        signals
      };
      continue;
    }

    // No place name at all, but the rules are still decisive about the
    // category (clear noise, or a place-less hazard bulletin).
    if (matches.length === 0) {
      const { category, strength, signals } = classifyCategory(
        report,
        normalized,
        null,
        unknownPlace
      );
      if (category === 'noise' && strength >= 0.85) {
        report.triage = {
          category: 'noise',
          confidence: Number((0.9 * strength).toFixed(3)),
          tier: 1,
          matchedOn: null,
          signals
        };
        continue;
      }
      if (category === 'new-settlement') {
        report.triage = {
          category,
          confidence: Number((0.9 * strength).toFixed(3)),
          tier: 1,
          matchedOn: unknownPlace,
          signals
        };
        continue;
      }
    }

    // --- TIER 2 -----------------------------------------------------------
    // Ambiguous (several gazetteer hits) or nothing solid: fall back to fuzzy.
    const ranked = tier2Match(tokens, index, matches.length > 1 ? matches : null);
    const best = ranked[0];

    if (best && best.score >= MIN_TIER2_SIM) {
      const settlementId = best.entry.settlement.id;
      const { category, strength, signals } = classifyCategory(
        report,
        normalized,
        settlementId,
        unknownPlace
      );
      // Map cosine 0.55..1.0 onto the tier-2 confidence band 0.5..0.8.
      const geoConf = 0.5 + 0.3 * ((best.score - MIN_TIER2_SIM) / (1 - MIN_TIER2_SIM));
      const confidence = clamp(geoConf * (0.6 + 0.4 * strength), 0.5, 0.8);
      report.settlementId = settlementId;
      report.triage = {
        category,
        confidence: Number(confidence.toFixed(3)),
        tier: 2,
        matchedOn: `~"${best.window}" -> ${best.entry.settlement.name} (cos ${best.score.toFixed(2)})`,
        signals
      };
      // A resolved settlement with a weak category is still good enough.
      if (confidence >= 0.5 && report.triage.category !== 'noise') continue;
      if (confidence >= 0.5) continue;
    }

    // Category-only tier 2 (no settlement resolved).
    const { category, strength, signals } = classifyCategory(
      report,
      normalized,
      null,
      unknownPlace
    );
    const catConfidence = clamp(0.5 + 0.3 * (strength - 0.5) / 0.5, 0.35, 0.75);
    report.triage = {
      category,
      confidence: Number(catConfidence.toFixed(3)),
      tier: 2,
      matchedOn: null,
      signals
    };

    // Residual: too weak to trust, or on-topic but with nowhere to attach it.
    const needsPlace = category !== 'noise' && !report.settlementId;
    if (catConfidence < 0.5 || needsPlace) {
      residual.push({ report, shortlist: ranked.slice(0, 8) });
    }
  }

  // --- TIER 3 -------------------------------------------------------------
  // Every trip here is logged to the failure feed, key or no key: hitting the
  // LLM fallback IS the degradation we want operators to see.
  let llmCalls = 0;
  for (const { report, shortlist } of residual) {
    if (!config.OPENAI_API_KEY) {
      addIncident(
        'llm-fallback',
        `No LLM key: "${(report.title || report.id).slice(0, 70)}" left UNRESOLVED after tier 2`,
        { reportId: report.id, sourceName: report.sourceName, tier: 3, resolved: false, reason: 'no-api-key' }
      );
      report.triage = { ...report.triage, tier: 3, confidence: 0.3, matchedOn: null };
      report.settlementId = null;
      continue;
    }

    if (llmCalls >= MAX_LLM_CALLS) {
      addIncident(
        'llm-fallback',
        `Tier-3 budget exhausted (${MAX_LLM_CALLS} calls); "${(report.title || report.id).slice(0, 60)}" left unresolved`,
        { reportId: report.id, tier: 3, resolved: false, reason: 'budget' }
      );
      report.triage = { ...report.triage, tier: 3, confidence: 0.3 };
      continue;
    }

    llmCalls++;
    try {
      const out = await tier3Classify(report, shortlist);
      report.settlementId = out.settlementId;
      report.triage = {
        category: out.category,
        confidence: out.confidence,
        tier: 3,
        matchedOn: out.settlementId ? `llm:${out.settlementId}` : 'llm:unresolved',
        signals: { ...(report.triage?.signals || {}), llmWhy: out.why }
      };
      addIncident(
        'llm-fallback',
        `Tier-3 LLM classified "${(report.title || report.id).slice(0, 60)}" as ${out.category}`,
        {
          reportId: report.id,
          model: config.OPENAI_MODEL,
          tier: 3,
          resolved: Boolean(out.settlementId),
          settlementId: out.settlementId,
          confidence: out.confidence
        }
      );
    } catch (err) {
      addIncident(
        'llm-fallback',
        `Tier-3 LLM call FAILED (${err.message}); "${(report.title || report.id).slice(0, 50)}" left unresolved`,
        { reportId: report.id, tier: 3, resolved: false, reason: 'error', error: String(err.message) }
      );
      report.triage = { ...report.triage, tier: 3, confidence: 0.3 };
      report.settlementId = null;
    }
  }

  return list;
}

export default triage;

// ---------------------------------------------------------------------------
// Sanity checks: `node src/pipeline/triage.js`
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

  const gaz = loadGazetteerFromDisk();
  assert(gaz.length > 0, 'gazetteer loads');

  assert(normalizeText('Syābru-Besi!') === 'syabru besi', 'diacritics + punctuation normalized');
  assert(trigramCosine('Syabrubesi', 'Syabrubensi') > 0.7, 'misspelling scores high on trigram cosine');
  assert(trigramCosine('Betrawati', 'Gosaikunda') < 0.2, 'unrelated names score low');

  const reports = [
    {
      id: 'r1',
      sourceType: 'official',
      sourceName: 'DEOC Nuwakot',
      url: 'x',
      title: 'Betrawati: 40 households displaced',
      text: 'Security personnel reached Betrawati this morning. Forty households were displaced after the flood; the bridge is damaged.',
      publishedAt: '2026-08-26T09:00:00Z',
      fetchedAt: '2026-08-26T10:00:00Z',
      settlementId: null,
      triage: null,
      clusterId: null
    },
    {
      id: 'r2',
      sourceType: 'news',
      sourceName: 'Kathmandu Post',
      url: 'x',
      title: 'Trishuli river swells after glacial lake outburst',
      text: 'Water level in the Trishuli river rose sharply following a glacial lake outburst upstream. A warning was issued downstream.',
      publishedAt: '2026-08-26T07:00:00Z',
      fetchedAt: '2026-08-26T10:00:00Z',
      settlementId: null,
      triage: null,
      clusterId: null
    },
    {
      id: 'r3',
      sourceType: 'news',
      sourceName: 'Sports Desk',
      url: 'x',
      title: 'Nepal wins cricket series',
      text: 'The national side sealed the cricket series in Kirtipur on Tuesday.',
      publishedAt: '2026-08-26T07:00:00Z',
      fetchedAt: '2026-08-26T10:00:00Z',
      settlementId: null,
      triage: null,
      clusterId: null
    },
    {
      id: 'r4',
      sourceType: 'social',
      sourceName: 'X/@relief',
      url: 'x',
      title: 'No word from Syabru Besi',
      text: 'Still no contact with Syabru Besi after the flood. Residents there are unaccounted for.',
      publishedAt: '2026-08-26T11:00:00Z',
      fetchedAt: '2026-08-26T12:00:00Z',
      settlementId: null,
      triage: null,
      clusterId: null
    }
  ];

  const out = await triage(reports, gaz);
  assert(out === reports, 'triage returns the same array it was given');
  assert(out.every((r) => r.triage && CATEGORIES.includes(r.triage.category)), 'every report categorized');

  const r1 = out.find((r) => r.id === 'r1');
  assert(r1.settlementId === 'np-nuwakot-betrawati', `r1 resolved to Betrawati (got ${r1.settlementId})`);
  assert(r1.triage.tier === 1, 'r1 handled by tier 1');
  assert(r1.triage.category === 'corroboration-candidate', `r1 is corroboration (got ${r1.triage.category})`);

  const r2 = out.find((r) => r.id === 'r2');
  assert(
    r2.settlementId !== 'np-nuwakot-trishuli-bazar',
    '"Trishuli river" does NOT resolve to Trishuli Bazar'
  );
  assert(r2.triage.category === 'hazard-signal', `r2 is hazard-signal (got ${r2.triage.category})`);

  const r3 = out.find((r) => r.id === 'r3');
  assert(r3.triage.category === 'noise', `r3 is noise (got ${r3.triage.category})`);

  const r4 = out.find((r) => r.id === 'r4');
  assert(
    r4.settlementId === 'np-rasuwa-syabrubesi',
    `r4 fuzzy-resolved to Syabrubesi (got ${r4.settlementId})`
  );

  console.log('\ntriage.js sanity checks complete.');
}
