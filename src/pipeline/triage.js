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
//                            and only LLM touchpoint in the entire codebase. It
//                            never touches dedup scoring or ranking math, which
//                            stay deterministic and auditable by construction.
//
// TIER 3 RUNS ON THE TRUEFORGE AGENT HARNESS. It is not a raw POST to a model
// endpoint: we create a TrueForge session from an AgentSpec and TrueForge
// executes the turn, resolving the model through its own registered provider.
// The direct fetch is still here, but only as the FALLBACK for when the harness
// is unreachable or a turn fails - and when it runs, the incident feed says the
// fallback ran: once per classification, once on the first mid-pass harness
// failure naming the executor switch, and once more as a per-pass roll-up
// counting how many classifications the harness did not execute. See
// src/harness/trueforge.js for why all three exist.
//
// Reaching tier 3 is itself a failure signal, so it is always written to the
// incident feed via addIncident('llm-fallback', ...) - whichever path executed
// it, and whether or not any executor was available at all.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import config from '../config.js';
import store, { addIncident } from '../store.js';
import * as harness from '../harness/trueforge.js';
import {
  guardInput,
  guardOutput,
  blockAndRecord,
  describeVerdict,
  worstSeverity
} from '../guardrails/index.js';

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

/**
 * A DATELINE IS NOT EVIDENCE ABOUT THE DATELINED PLACE.
 *
 * Wire copy opens with the filing location: "BATTAR - Three passengers were
 * injured when a bus overturned on the Narayanghat road in Chitwan." That story
 * is about Chitwan. Battar is where the reporter was sitting. Tier 1 matched the
 * name, saw "injured", and recorded a CORROBORATION for Battar - which resets
 * Battar's silence clock on the strength of a bus crash 90km away. For a system
 * whose entire output is "how long has this place gone unconfirmed", a false
 * corroboration is the worst single defect available, and this is the cheapest
 * way to manufacture one from real, unmodified wire text.
 *
 * The rule is deliberately narrow, and the narrowness is what makes it correct:
 * it fires ONLY when the settlement name appears nowhere except inside the
 * dateline. "DHUNCHE - Rescue teams reached Dhunche this morning" names Dhunche
 * twice and resolves normally, because there the dateline and the subject
 * coincide - which is the common case and must not be broken.
 */
const DATELINE_RE = /^\s*([\p{Lu}][\p{Lu}\p{N} .'’-]{1,40}?)\s*[-–—]\s/u;

/** Whole-token containment over the normalized stream (never substring). */
function mentions(normalizedHaystack, normalizedNeedle) {
  if (!normalizedNeedle) return false;
  return ` ${normalizedHaystack} `.includes(` ${normalizedNeedle} `);
}

/**
 * Is `name` mentioned ONLY inside this report's dateline?
 * @returns {{dateline: string}|null} the dateline when the rule fires
 */
export function datelineOnlyMention(report, name) {
  const text = String(report?.text || '');
  const m = DATELINE_RE.exec(text);
  if (!m) return null;

  const needle = normalizeText(name);
  if (!needle) return null;

  // The name has to BE the dateline...
  if (!mentions(normalizeText(m[1]), needle)) return null;
  // ...and must appear nowhere else: not in the headline...
  if (mentions(normalizeText(report?.title || ''), needle)) return null;
  // ...and not in the body after the dateline.
  if (mentions(normalizeText(text.slice(m[0].length)), needle)) return null;

  return { dateline: m[0].trim() };
}

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
// TIER 3 - the ONLY LLM touchpoint in Signal Zero.
//
// Two execution paths, in this order:
//
//   A. TRUEFORGE HARNESS (preferred). We create a TrueForge session from an
//      AgentSpec and ask TrueForge to run a turn. TrueForge owns the agent
//      loop, resolves the model through its own registered provider, and hands
//      back a turn object with real ids and token counts. See
//      src/harness/trueforge.js.
//   B. DIRECT FETCH (fallback). The original raw POST to an OpenAI-compatible
//      /chat/completions. Only used when the harness is unreachable or the turn
//      failed, and every use of it is written to the incident feed IN THOSE
//      WORDS. The demo must not hard-fail because a container is down, but it
//      must also never be described as harness-executed when it was not.
//
// Both paths share ONE prompt and ONE parser, so the two are comparable and
// switching path cannot silently change the classification contract.
// ---------------------------------------------------------------------------

const TIER3_INSTRUCTIONS =
  'You classify disaster-response reports for the 2026 Trishuli river GLOF in Nepal. ' +
  'Reply with JSON only: {"category": one of ' + JSON.stringify(CATEGORIES) + ', ' +
  '"settlementId": one of the offered ids or null, "confidence": 0..1, "why": short string}. ' +
  'Never suggest sending anyone anywhere; you only label the text.';

/**
 * The per-report user message. Identical on both paths, with ONE addition on
 * the harness path: the registered agent's output contract keys every
 * classification by `reportId`, so the id has to travel with the text.
 */
function tier3Prompt(report, shortlist, { withReportId = false } = {}) {
  const options = shortlist
    .map((c) => `${c.entry.settlement.id} (${c.entry.settlement.name}, ${c.entry.settlement.district})`)
    .join('\n');
  return (
    (withReportId ? `REPORT ID: ${report.id}\n` : '') +
    `SOURCE: ${report.sourceName} (${report.sourceType})\n` +
    `TITLE: ${report.title || ''}\n` +
    `TEXT: ${String(report.text || '').slice(0, 1500)}\n\n` +
    `CANDIDATE SETTLEMENTS (or null if none apply):\n${options || '(none)'}`
  );
}

/**
 * Unwrap whichever answer shape we were handed.
 *
 *   - The REGISTERED agent (agents/triage-agent.md) answers with its own
 *     contract: {classifications:[{reportId, category, settlementId,
 *     confidence, rationale, evidence, injectionSuspected, ...}], unresolved:[]}.
 *     That contract lives in TrueForge, not here, so we read it rather than
 *     dictate it.
 *   - The direct-fetch fallback answers with the flat
 *     {category, settlementId, confidence, why} shape TIER3_INSTRUCTIONS asks
 *     for.
 *
 * Anything else is a parse failure, which is a tier-3 failure, which is
 * recorded - never smoothed over into a guess.
 */
/**
 * A PRINCIPLED REFUSAL IS NOT A CRASH.
 *
 * The registered agent is instructed to refuse anything that would breach one of
 * the four hard rules, and it does - but it refuses in prose, so `JSON.parse`
 * threw and the report was recorded as "tier 3 failed" with a generic parse
 * error. The system's BEST behaviour (an agent correctly citing Rule 1 at an
 * injected dispatch request) was logged identically to a malformed response,
 * which makes it invisible in exactly the demo where it is the most convincing
 * thing that could happen.
 *
 * This recognises that shape so it can be recorded as what it is. It is
 * deliberately narrow: a refusal VERB plus a citation of one of this system's
 * own rules. Anything vaguer stays a parse failure, because "the model said
 * something that mentions dispatch" is not evidence of a refusal.
 *
 * @returns {{verb: string, cited: string, text: string}|null}
 */
const REFUSAL_VERB_RE =
  /\b(i cannot|i can not|i can't|i will not|i won't|i must not|i am not able to|i refuse|cannot comply|will not comply|unable to comply|i decline)\b/i;
const REFUSAL_CITATION_RE =
  /\b(rule\s*[1-4]|hard rule|no[- ]dispatch|no dispatch|named human|named approver|honest unknown|dispatch-shaped|belongs to a human)\b/i;

export function detectRefusal(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return null;
  const verb = REFUSAL_VERB_RE.exec(text);
  if (!verb) return null;
  const cited = REFUSAL_CITATION_RE.exec(text);
  if (!cited) return null;
  return { verb: verb[0], cited: cited[0], text: text.slice(0, 600) };
}

function unwrapTier3(parsed) {
  if (parsed && Array.isArray(parsed.classifications)) {
    const first = parsed.classifications[0];
    if (!first) {
      // A STRUCTURED refusal: the agent declined inside the contract instead of
      // dropping into prose. Same outcome for the report (unresolved), very
      // different fact for the operator, so it is carried on the error rather
      // than flattened into "no classification".
      const r = parsed.refusal;
      if (r && typeof r === 'object') {
        const err = new Error(
          `agent REFUSED (cited "${String(r.rule || 'a hard rule')}"): ${String(r.reason || r.requested || '').slice(0, 180)}`
        );
        err.refusal = {
          verb: 'structured refusal',
          cited: String(r.rule || 'a hard rule').slice(0, 80),
          text: JSON.stringify(r).slice(0, 600)
        };
        throw err;
      }
      const reason = parsed.unresolved?.[0]?.reason;
      throw new Error(`agent returned no classification${reason ? `: ${String(reason).slice(0, 120)}` : ''}`);
    }
    return {
      category: first.category,
      settlementId: first.settlementId,
      confidence: first.confidence,
      // `rationale` is the registered contract's field name; keep it under
      // `why` so ONE guardrail field list covers both paths.
      why: first.rationale ?? first.why ?? '',
      injectionSuspected: first.injectionSuspected === true,
      ambiguous: first.ambiguous === true,
      evidence: Array.isArray(first.evidence) ? first.evidence.slice(0, 4) : []
    };
  }
  return {
    category: parsed?.category,
    settlementId: parsed?.settlementId,
    confidence: parsed?.confidence,
    why: parsed?.why ?? '',
    injectionSuspected: false,
    ambiguous: false,
    evidence: []
  };
}

/**
 * Parse and HARD-CONSTRAIN a tier-3 answer. Identical on both paths.
 * A model may only pick from the shortlist we offered; anything else is null.
 */
function parseTier3(rawText, shortlist) {
  // Models occasionally wrap JSON in a fenced block even when asked not to.
  const cleaned = String(rawText || '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const raw = unwrapTier3(JSON.parse(cleaned));

  const category = CATEGORIES.includes(raw.category) ? raw.category : 'noise';
  const allowedIds = new Set(shortlist.map((c) => c.entry.settlement.id));
  const settlementId = allowedIds.has(raw.settlementId) ? raw.settlementId : null;
  // Tier 3 is the low-confidence path by construction - never let it claim more
  // certainty than the deterministic tiers. The registered agent is allowed to
  // report 0.95; the pipeline is not allowed to believe it.
  const confidence = clamp(Number(raw.confidence) || 0.4, 0.3, 0.7);

  return {
    category,
    settlementId,
    confidence,
    // `why` is CLIPPED FOR DISPLAY. `whyFull` is what the guardrail scans.
    //
    // These used to be the same field, and the output guardrail scanned the
    // clipped one: a measured 730-936 character rationale was checked 200
    // characters deep, so roughly three quarters of the only free-text field the
    // model produces was never scanned. It was only ever safe because the
    // unscanned remainder was also discarded - i.e. the safety came from a
    // truncation that exists for display, not for enforcement, and would vanish
    // the moment anyone widened the clip or surfaced the full rationale.
    why: String(raw.why || '').slice(0, 200),
    whyFull: String(raw.why || '').slice(0, 8000),
    injectionSuspected: raw.injectionSuspected,
    ambiguous: raw.ambiguous
  };
}

/**
 * PATH A - executed by the TrueForge harness as a session turn against the
 * NAMED registered agent. No AgentSpec crosses the wire: the model, the
 * instructions (the four hard rules included) and the iteration limit are
 * resolved by TrueForge from its own registry on every turn.
 */
async function tier3ViaHarness(report, shortlist) {
  const turn = await harness.runTurn(
    TIER3_INSTRUCTIONS, // used ONLY if the roster is missing and we bind inline
    tier3Prompt(report, shortlist, { withReportId: true })
  );
  let out;
  try {
    out = parseTier3(turn.text, shortlist);
  } catch (err) {
    // Tell a refusal apart from a malformed answer before the error is flattened
    // into a string by the caller. A structured refusal already carries the fact.
    if (err && err.refusal) throw err;
    const refusal = detectRefusal(turn.text);
    if (refusal) {
      const e = new Error(
        `agent REFUSED (cited "${refusal.cited}"): ${refusal.text.replace(/\s+/g, ' ').slice(0, 180)}`
      );
      e.refusal = refusal;
      throw e;
    }
    throw err;
  }
  const named = turn.binding === harness.BINDING.NAMED;
  return {
    ...out,
    // The COMPLETE model utterance, so guardOutput scans what the model actually
    // said rather than the subset the parser kept. Never stored: report.triage is
    // assembled field by field below, so this exists only for the guardrail.
    rawModelText: String(turn.text || '').slice(0, 20000),
    // The executor name distinguishes the two harness bindings, because
    // "TrueForge ran it against our registered agent" and "TrueForge ran it
    // against a spec we shipped in the request" are different claims.
    executor: named ? 'trueforge-harness' : 'trueforge-harness-inline',
    harness: {
      baseUrl: config.TRUEFORGE_BASE_URL,
      model: config.TRUEFORGE_MODEL,
      binding: turn.binding,
      agentName: turn.agentName,
      agentId: turn.agentId,
      sessionId: turn.sessionId,
      sessionReused: turn.sessionReused,
      turnId: turn.turnId,
      totalTokens: turn.totalTokens,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      approvalRequired: turn.approvalRequired,
      latencyMs: turn.latencyMs
    }
  };
}

/** PATH B - the original direct fetch. Fallback only. */
async function tier3ViaDirectFetch(report, shortlist) {
  const startedAt = Date.now();
  const body = {
    model: config.OPENAI_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: TIER3_INSTRUCTIONS },
      { role: 'user', content: tier3Prompt(report, shortlist) }
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

  return {
    ...parseTier3(raw, shortlist),
    rawModelText: String(raw || '').slice(0, 20000),
    executor: 'direct-fetch',
    harness: null,
    direct: {
      baseUrl: config.OPENAI_BASE_URL,
      model: config.OPENAI_MODEL,
      latencyMs: Date.now() - startedAt
    }
  };
}

// ---------------------------------------------------------------------------
// Honest surfacing. `store.harness` is the single source of truth for what the
// UI is allowed to say about the harness, and the sources[] entry exists so an
// operator sees the harness in the same connector strip as everything else.
//
// The rule: the entry is only registered when tier 3 actually ran this pass.
// A harness that was never asked to do anything is not "live" and is not
// "degraded" - it has no result to report, so it reports nothing.
// ---------------------------------------------------------------------------

const HARNESS_SOURCE_NAME = 'TrueForge harness - triage tier 3';

/**
 * Surface a guardrail verdict that FIRED but did not block.
 *
 * blockAndRecord() already puts every block on the failure feed. This covers
 * the other half: an advisory hit is the guardrail telling an operator it saw
 * something, and swallowing it makes a working guardrail indistinguishable from
 * a dead one. It does NOT touch the classification - advisory means advisory.
 */
function noteAdvisory(report, verdict, label, phase, executor) {
  if (!verdict || verdict.ok) return;
  harness.countGuardrail(phase, false, verdict.violations.map((v) => v.rule));
  addIncident(
    'degraded-source',
    `GUARDRAIL ADVISORY (${phase}): "${label}" - ${describeVerdict(verdict)}. Not blocking; the classification was kept and this is on the record.`,
    {
      component: 'guardrail',
      stage: 'triage',
      tier: 3,
      phase,
      blocked: false,
      reportId: report ? report.id : null,
      sourceName: report ? report.sourceName : null,
      executor: executor || 'none',
      severity: worstSeverity(verdict),
      rules: verdict.violations.map((v) => v.rule),
      violations: verdict.violations.map((v) => ({
        rule: v.rule,
        severity: v.severity,
        matched: v.matched,
        span: v.span
      }))
    }
  );
}

function publishHarnessStatus() {
  const t = harness.getTelemetry();
  const facts = harness.getAgentFacts();
  store.harness = {
    ...t,
    // Never claim more than the counters support.
    executedByHarness: t.executedTurns,
    executedByFallback: t.fallbackClassifications,
    unresolved: t.unresolved,
    // What the registry actually says about the bound agent, read off
    // GET /api/v1/agents at probe time - not what this repo hoped it said.
    agent: {
      name: facts.name,
      registered: facts.registered,
      id: facts.id,
      model: facts.model,
      iterationLimit: facts.iterationLimit,
      toolCount: facts.toolCount
    }
  };

  const attempted = t.executedTurns + t.fallbackClassifications + t.unresolved;
  if (attempted === 0) return; // nothing happened; say nothing

  if (!store.sources || typeof store.sources !== 'object') store.sources = {};
  store.sources[HARNESS_SOURCE_NAME] = {
    name: HARNESS_SOURCE_NAME,
    sourceType: 'agent-harness',
    // 'live' ONLY if the harness genuinely executed at least one turn.
    status: t.executedTurns > 0 ? 'live' : 'degraded',
    lastFetchAt: new Date().toISOString()
  };
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
      const matchedName = only.variant ? only.variant.raw : only.entry.settlement.name;

      // A name that occurs ONLY in the dateline is not a resolution. Resolve to
      // nothing and classify the report on its own words - the same path a
      // report with no place name at all takes - rather than attaching a
      // corroboration to the town the reporter filed from.
      const dateline = datelineOnlyMention(report, matchedName);
      if (dateline) {
        const { category, strength, signals } = classifyCategory(
          report,
          normalized,
          null,
          unknownPlace
        );
        report.settlementId = null;
        report.triage = {
          category,
          confidence: Number(clamp(0.9 * strength + 0.1, 0.6, 0.96).toFixed(3)),
          tier: 1,
          matchedOn: null,
          signals: {
            ...signals,
            // Auditable: the match happened and was refused, with the reason.
            datelineOnly: {
              name: matchedName,
              wouldHaveResolvedTo: only.entry.settlement.id,
              dateline: dateline.dateline.slice(0, 60)
            }
          }
        };
        continue;
      }

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
        matchedOn: matchedName,
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
  // Every trip here is logged to the failure feed, harness or no harness, key
  // or no key: hitting the tier-3 fallback IS the degradation we want operators
  // to see. What is NEW is that the feed now also records WHICH path executed
  // the classification, so nobody has to take "the harness ran it" on trust.
  harness.beginPass();

  if (residual.length === 0) {
    publishHarnessStatus();
    return list;
  }

  // One reachability probe per pass, not one per report. If the container is
  // down we want to know that once, cheaply, and say so once.
  let harnessUsable = false;
  let harnessDownReason = null;

  if (harness.isEnabled()) {
    const p = await probeOnce();
    harnessUsable = p.ok;
    harnessDownReason = p.ok ? null : p.reason;

    // Reachable, but our NAMED agent is not on the roster. Tier 3 can still run
    // through the harness on an inline spec - but that is a weaker claim than
    // "the registered agent classified it", so it is said out loud rather than
    // quietly downgraded.
    if (p.ok && p.degraded) {
      addIncident(
        'degraded-source',
        `TrueForge is up but agent "${config.TRUEFORGE_AGENT}" is NOT on the registry - tier 3 is binding an INLINE AgentSpec instead of the registered roster agent. Run "node scripts/load-agents.mjs" to restore it.`,
        {
          stage: 'triage',
          tier: 3,
          component: 'trueforge-harness',
          baseUrl: config.TRUEFORGE_BASE_URL,
          agentName: config.TRUEFORGE_AGENT,
          binding: 'inline-spec',
          reason: p.reason,
          pendingClassifications: residual.length
        }
      );
    }

    if (!p.ok) {
      addIncident(
        'degraded-source',
        `TrueForge harness unreachable at ${config.TRUEFORGE_BASE_URL} (${p.reason}) - tier 3 is running on the DIRECT-FETCH FALLBACK path, not through the harness`,
        {
          stage: 'triage',
          tier: 3,
          component: 'trueforge-harness',
          baseUrl: config.TRUEFORGE_BASE_URL,
          model: config.TRUEFORGE_MODEL,
          reason: p.reason,
          fallback: config.OPENAI_API_KEY ? 'direct-fetch' : 'none (no OPENAI_API_KEY)',
          pendingClassifications: residual.length
        }
      );
    }
  } else {
    harnessDownReason = 'disabled by TRUEFORGE_ENABLED';
    addIncident(
      'degraded-source',
      'TrueForge harness is switched OFF (TRUEFORGE_ENABLED=false) - tier 3 is running on the direct-fetch fallback path',
      { stage: 'triage', tier: 3, component: 'trueforge-harness', reason: harnessDownReason }
    );
  }

  let llmCalls = 0;
  // MID-RUN DEGRADATION. The probe above describes the harness at the START of
  // the pass. It cannot describe a container that dies at t+2.5s - which is
  // precisely what a chaos test does. Without these two, the only thing that
  // announced the executor switch was the per-report incident at the BOTTOM of
  // the loop, which never runs when the fallback's own output is then blocked by
  // the output guardrail, and which says nothing at all about the pass as a
  // whole. src/harness/trueforge.js promises, in those words, that a fallback
  // "says so": that promise is about the pass, so the pass has to say it.
  let midRunFailures = 0;
  let midRunAnnounced = false;
  const firstMidRunError = { reason: null };
  for (const { report, shortlist } of residual) {
    const label = String(report.title || report.id).slice(0, 60);

    // --- GUARDRAIL (input) -------------------------------------------------
    // Scraped content is UNTRUSTED DATA. It is checked for prompt injection
    // BEFORE the model is allowed to see it - catching it on the way out would
    // already be too late. See src/guardrails/README.md.
    const inputVerdict = guardInput(
      `${report.title || ''}\n${report.text || ''}`,
      { reportId: report.id, sourceName: report.sourceName }
    );
    if (inputVerdict.blocked) {
      harness.countGuardrail('input', true, inputVerdict.violations.map((v) => v.rule));
      harness.countUnresolved();
      blockAndRecord(report, inputVerdict, { label, phase: 'input' });
      continue;
    }
    // A verdict that fired but did not block is still enforcement doing
    // something, and an operator who only ever sees blocks cannot tell a quiet
    // guardrail from an absent one. Count it and put it on the feed.
    noteAdvisory(report, inputVerdict, label, 'input', 'none');

    if (llmCalls >= MAX_LLM_CALLS) {
      harness.countUnresolved();
      addIncident(
        'llm-fallback',
        `Tier-3 budget exhausted (${MAX_LLM_CALLS} classifications); "${label}" left unresolved`,
        { reportId: report.id, tier: 3, executor: 'none', resolved: false, reason: 'budget' }
      );
      report.triage = { ...report.triage, tier: 3, confidence: 0.3, executor: 'none' };
      continue;
    }

    // --- PATH A: the harness ---------------------------------------------
    let out = null;
    let harnessError = null;
    if (harnessUsable) {
      llmCalls++;
      try {
        out = await tier3ViaHarness(report, shortlist);
      } catch (err) {
        harnessError = String(err && err.message ? err.message : err);
        harness.noteError(harnessError);

        // A REFUSAL IS NOT A FAULT. Record it as the positive event it is, and
        // do not let it be counted as a mid-pass harness failure - the harness
        // worked perfectly; the agent declined a request that would have broken
        // a hard rule. The report is still left unresolved, which is correct: a
        // refusal is not a classification.
        if (err && err.refusal) {
          harness.countUnresolved();
          addIncident(
            'agent-refusal',
            `Tier-3 agent REFUSED to answer "${label}", citing "${err.refusal.cited}" - the report text asked for something one of the four hard rules forbids. No classification was produced and the report is left UNRESOLVED. This is the guardrail working, not a failure.`,
            {
              component: 'trueforge-harness',
              stage: 'triage',
              tier: 3,
              phase: 'agent-refusal',
              reportId: report.id,
              sourceName: report.sourceName,
              agentName: config.TRUEFORGE_AGENT,
              executor: 'none',
              resolved: false,
              refused: true,
              citedRule: err.refusal.cited,
              refusalVerb: err.refusal.verb
            }
          );
          report.triage = {
            ...report.triage,
            tier: 3,
            confidence: 0.3,
            matchedOn: null,
            executor: 'none',
            refused: { citedRule: err.refusal.cited }
          };
          report.settlementId = null;
          continue;
        }

        midRunFailures++;
        if (!firstMidRunError.reason) firstMidRunError.reason = harnessError;

        // FIRST failure of the pass -> one incident, immediately, naming the
        // error and the executor that is about to take over. Emitted here rather
        // than after the fallback succeeds, so it exists even when the fallback
        // then fails, is blocked by the output guardrail, or is skipped for want
        // of a key.
        if (!midRunAnnounced) {
          midRunAnnounced = true;
          const nextExecutor = config.OPENAI_API_KEY
            ? 'the DIRECT-FETCH FALLBACK path, not through the harness'
            : 'NOTHING - no OPENAI_API_KEY is configured, so these classifications are left UNRESOLVED';
          addIncident(
            'llm-fallback',
            `TrueForge harness FAILED MID-PASS at ${config.TRUEFORGE_BASE_URL} (${harnessError}) - the reachability probe passed before this pass started, so the harness went down while it was running. Tier 3 has SWITCHED EXECUTOR to ${nextExecutor}.`,
            {
              stage: 'triage',
              tier: 3,
              component: 'trueforge-harness',
              phase: 'mid-pass',
              baseUrl: config.TRUEFORGE_BASE_URL,
              model: config.TRUEFORGE_MODEL,
              agentName: config.TRUEFORGE_AGENT,
              probePassed: true,
              reason: harnessError,
              executorBefore: 'trueforge-harness',
              executorAfter: config.OPENAI_API_KEY ? 'direct-fetch' : 'none',
              reportId: report.id,
              resolved: false
            }
          );
        }
      }
    }

    // --- PATH B: the direct-fetch fallback --------------------------------
    if (!out && config.OPENAI_API_KEY) {
      if (!harnessUsable) llmCalls++; // path A never spent the budget slot
      try {
        out = await tier3ViaDirectFetch(report, shortlist);
        harness.countFallback();
      } catch (err) {
        const directError = String(err && err.message ? err.message : err);
        harness.countUnresolved();
        addIncident(
          'llm-fallback',
          harnessError
            ? `Tier-3 FAILED on BOTH paths - harness: ${harnessError}; direct-fetch fallback: ${directError}. "${label}" left unresolved`
            : `Tier-3 direct-fetch fallback FAILED (${directError}); "${label}" left unresolved`,
          {
            reportId: report.id,
            tier: 3,
            executor: 'none',
            resolved: false,
            reason: 'error',
            harnessError,
            error: directError
          }
        );
        report.triage = { ...report.triage, tier: 3, confidence: 0.3, executor: 'none' };
        report.settlementId = null;
        continue;
      }
    }

    // --- Neither path was available ---------------------------------------
    if (!out) {
      harness.countUnresolved();
      addIncident(
        'llm-fallback',
        harnessError
          ? `Tier-3 harness turn FAILED (${harnessError}) and no direct-fetch key is configured; "${label}" left UNRESOLVED`
          : `Tier-3 unavailable (harness: ${harnessDownReason || 'unreachable'}; no OPENAI_API_KEY for the fallback) - "${label}" left UNRESOLVED after tier 2`,
        {
          reportId: report.id,
          sourceName: report.sourceName,
          tier: 3,
          executor: 'none',
          resolved: false,
          reason: harnessError ? 'harness-turn-failed' : 'no-executor',
          harnessError,
          harnessDownReason
        }
      );
      report.triage = { ...report.triage, tier: 3, confidence: 0.3, matchedOn: null, executor: 'none' };
      report.settlementId = null;
      continue;
    }

    // --- GUARDRAIL (output) ------------------------------------------------
    // The prompt ASKS the model never to suggest sending anyone anywhere. This
    // CHECKS it, whichever path produced the answer. A violation is dropped and
    // recorded, never repaired into something that reads clean.
    //
    // `out` carries whyFull and rawModelText, so what is scanned is the model's
    // COMPLETE utterance - not the 200-character display clip, and not only the
    // fields this parser happens to keep.
    const outputVerdict = guardOutput(out, {
      reportId: report.id,
      executor: out.executor,
      coverageBasis: report.coverageBasis || null
    });
    if (outputVerdict.blocked) {
      harness.countGuardrail('output', true, outputVerdict.violations.map((v) => v.rule));
      harness.countUnresolved();
      blockAndRecord(report, outputVerdict, { label, phase: 'output', executor: out.executor });
      continue;
    }
    noteAdvisory(report, outputVerdict, label, 'output', out.executor);

    // The registered agent is instructed to flag report text that tries to
    // instruct IT (agents/triage-agent.md rule 9). Our deterministic injection
    // guardrail above is the enforcement; this is the agent's own second
    // opinion, and it belongs on the feed either way.
    if (out.injectionSuspected) {
      addIncident(
        'degraded-source',
        `Tier-3 agent flagged "${label}" as containing text directed at the classifier (injectionSuspected). The deterministic input guardrail did not block it; both readings are on the record.`,
        {
          component: 'guardrail',
          stage: 'triage',
          tier: 3,
          phase: 'agent-self-report',
          blocked: false,
          reportId: report.id,
          sourceName: report.sourceName,
          executor: out.executor
        }
      );
    }

    // --- Record the classification ----------------------------------------
    const viaHarness = out.executor.startsWith('trueforge-harness');
    report.settlementId = out.settlementId;
    report.triage = {
      category: out.category,
      confidence: out.confidence,
      tier: 3,
      // The provenance travels WITH the classification, not just in the feed.
      executor: out.executor,
      matchedOn: out.settlementId
        ? `${viaHarness ? 'trueforge' : 'llm'}:${out.settlementId}`
        : `${viaHarness ? 'trueforge' : 'llm'}:unresolved`,
      harness: out.harness || null,
      signals: { ...(report.triage?.signals || {}), llmWhy: out.why }
    };

    addIncident(
      'llm-fallback',
      viaHarness
        ? `Tier-3 EXECUTED BY THE TRUEFORGE HARNESS - ${
            out.harness.binding === 'named-agent'
              ? `registered agent "${out.harness.agentName}" (${out.harness.agentId})`
              : 'INLINE spec (agent not on the registry)'
          }, session ${out.harness.sessionId}, turn ${out.harness.turnId}, ${out.harness.totalTokens} tokens: "${label}" -> ${out.category}`
        : `Tier-3 FELL BACK to a direct model fetch (harness: ${harnessError || harnessDownReason || 'unavailable'}): "${label}" -> ${out.category}`,
      {
        reportId: report.id,
        tier: 3,
        executor: out.executor,
        harness: out.harness || null,
        harnessError: viaHarness ? null : harnessError || harnessDownReason,
        model: viaHarness ? config.TRUEFORGE_MODEL : config.OPENAI_MODEL,
        resolved: Boolean(out.settlementId),
        settlementId: out.settlementId,
        confidence: out.confidence
      }
    );
  }

  // --- PER-PASS ROLL-UP ----------------------------------------------------
  // One line an operator reads without counting incidents: how many of this
  // pass's classifications were produced by something other than the harness,
  // and why. `executedByFallback` has always been honest in /api/state; this
  // puts the same number on the feed, which is the surface the product tells
  // people to trust.
  {
    const t = harness.getTelemetry();
    if (t.fallbackClassifications > 0) {
      addIncident(
        'llm-fallback',
        `PASS SUMMARY: ${t.fallbackClassifications} of ${t.executedTurns + t.fallbackClassifications} tier-3 classifications this pass were produced by the DIRECT-FETCH FALLBACK, NOT by the TrueForge harness (${
          midRunFailures > 0
            ? `${midRunFailures} harness turn(s) failed mid-pass; first error: ${firstMidRunError.reason}`
            : `harness unavailable at pass start: ${harnessDownReason || 'unknown'}`
        }). ${t.executedTurns} were executed by the harness.`,
        {
          stage: 'triage',
          tier: 3,
          component: 'trueforge-harness',
          phase: 'pass-summary',
          executedByHarness: t.executedTurns,
          executedByFallback: t.fallbackClassifications,
          unresolved: t.unresolved,
          midRunHarnessFailures: midRunFailures,
          firstHarnessError: firstMidRunError.reason,
          harnessDownReason,
          resolved: false
        }
      );
    }
  }

  publishHarnessStatus();
  return list;
}

/**
 * Probe TrueForge once, converting any thrown error into the same
 * {ok, reason} shape the caller expects. The harness must never be able to
 * throw its way into breaking a pipeline pass.
 */
async function probeOnce() {
  try {
    return await harness.probe();
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
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
