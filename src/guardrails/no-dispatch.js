// Signal Zero - GUARDRAIL 1 / NO DISPATCH
// ---------------------------------------------------------------------------
// HARD RULE 1: the system never says where anyone should go. No dispatch-shaped
// field exists in any data structure. Approval unlocks a sorted candidate list
// to READ, never an assignment.
//
// The tier-3 prompt asks the model not to suggest sending anyone anywhere. That
// is a request. THIS is the check that runs regardless of whether the model
// honoured it - and regardless of whether a scraped page talked it into
// something else.
//
// The whole difficulty is one distinction:
//
//     REPORTING what happened      ->  legitimate, must NOT fire
//         "the report was sent to us"
//         "security personnel were deployed to Betrawati yesterday"
//         "rescue teams reached the village"
//
//     PRESCRIBING what should happen  ->  violation, must fire
//         "send teams to Syabru Besi"
//         "Haku should be the first stop for rescue"
//         "direct resources to the upper valley"
//
// So every dispatch rule is verb-form aware and runs three guards IN THIS ORDER:
//
//   1. PRESCRIPTIVE marker - should / must / recommend / priority in front of
//                        the verb promotes the match straight to critical and
//                        beats BOTH other guards. It runs first on purpose:
//                        while negation ran first, "No confirmation yet, you
//                        must send rescue teams to Haku" passed clean, because
//                        the negation returned before "must" was ever read.
//                        The most explicit dispatch construction in the
//                        language was neutralised by five words of hedging -
//                        which is exactly how a hedging LLM writes about a
//                        disaster.
//   2. NEGATION guard  - "we never say send teams anywhere" is a statement
//                        ABOUT the rule, not a breach of it. CLAUSE-scoped
//                        (see text.js negationBefore) and verb-form aware (see
//                        negationScopesVerb), so a negation stranded in another
//                        clause cannot excuse a directive in this one.
//   3. REPORTING guard - was/were/has been/after/reportedly/plans to in front
//                        of the verb means the sentence narrates, and the
//                        match is SUPPRESSED (and recorded as suppressed, so
//                        the guard is auditable rather than invisible). Also
//                        clause-scoped, and an auxiliary only counts when it
//                        could actually govern THIS verb: "the army is sending
//                        teams" narrates, "The situation is send teams to Haku"
//                        is not English and does not get the exemption.
//
// COVERAGE. The vocabularies below are English plus a small Devanagari set.
// Anything else tokenizes but matches nothing, so checkNoDispatch emits an
// ADVISORY violation naming the unscanned script rather than returning a clean
// verdict it has not earned.
// ---------------------------------------------------------------------------

import {
  makeScans,
  anyWordAt,
  phraseAt,
  findWord,
  findPhrase,
  negationBefore,
  negationScopesVerb,
  uncoveredScripts,
  firstScriptSpan,
  keyWords,
  clip
} from './text.js';
import { SEVERITY, violation, makeVerdict, internalErrorVerdict } from './verdict.js';

// --- vocabularies ----------------------------------------------------------

/**
 * Base / 3rd-person / gerund forms only. Past participles live in their own set
 * below and are NEVER treated as directives, because "were deployed" is how a
 * newspaper reports a deployment that already happened.
 */
const DISPATCH_VERBS = new Set([
  'send',
  'sends',
  'sending',
  'dispatch',
  'dispatches',
  'dispatching',
  'despatch',
  'despatching',
  'deploy',
  'deploys',
  'deploying',
  'assign',
  'assigns',
  'assigning',
  'reassign',
  'redirect',
  'redirects',
  'redirecting',
  'reroute',
  'reroutes',
  'divert',
  'diverts',
  'diverting',
  'allocate',
  'allocates',
  'allocating',
  'mobilize',
  'mobilise',
  'mobilizes',
  'mobilises',
  'mobilizing',
  'mobilising',
  'scramble',
  'scrambles',
  'airlift',
  'airlifts',
  'airlifting'
]);

const DISPATCH_PARTICIPLES = new Set([
  'sent',
  'dispatched',
  'despatched',
  'deployed',
  'assigned',
  'redirected',
  'rerouted',
  'diverted',
  'allocated',
  'mobilized',
  'mobilised',
  'airlifted',
  'directed',
  'routed',
  'stationed'
]);

/** Things that get dispatched. Multi-word entries are matched as phrases. */
const RESOURCE_PHRASES = [
  ['team'],
  ['teams'],
  ['crew'],
  ['crews'],
  ['responder'],
  ['responders'],
  ['first', 'responders'],
  ['rescue'],
  ['rescuers'],
  ['rescue', 'team'],
  ['rescue', 'teams'],
  ['search', 'team'],
  ['search', 'teams'],
  ['search', 'and', 'rescue'],
  ['sar', 'team'],
  ['personnel'],
  ['security', 'personnel'],
  ['helicopter'],
  ['helicopters'],
  ['chopper'],
  ['choppers'],
  ['aircraft'],
  ['drone'],
  ['drones'],
  ['ambulance'],
  ['ambulances'],
  ['convoy'],
  ['convoys'],
  ['troops'],
  ['soldiers'],
  ['army'],
  ['police'],
  ['medics'],
  ['paramedics'],
  ['volunteers'],
  ['resources'],
  ['resource'],
  ['assets'],
  ['units'],
  ['unit'],
  ['aid'],
  ['relief'],
  ['supplies'],
  ['manpower'],
  ['boats'],
  ['help'],
  ['support'],
  ['responders'],
  ['ndrf'],
  ['apf'],
  ['task', 'force']
];

const DIRECTIONAL = new Set(['to', 'toward', 'towards', 'into', 'onto', 'unto']);

/**
 * Prescriptive framing. Presence of one of these in front of a dispatch verb
 * means the sentence is telling somebody what to do.
 */
const PRESCRIPTIVE = new Set([
  'should',
  'must',
  'shall',
  'ought',
  'need',
  'needs',
  'needed',
  'require',
  'requires',
  'required',
  'recommend',
  'recommends',
  'recommended',
  'recommending',
  'recommendation',
  'recommendations',
  'advise',
  'advises',
  'advised',
  'advice',
  'suggest',
  'suggests',
  'suggested',
  'suggestion',
  'urge',
  'urges',
  'urging',
  'propose',
  'proposes',
  'proposed',
  'please',
  'priority',
  'prioritize',
  'prioritise',
  'prioritized',
  'prioritised',
  'immediately',
  'urgently',
  'asap'
]);

/**
 * Narration markers. These mean the sentence is describing the world, not
 * instructing it.
 */
const REPORTING = new Set([
  'was',
  'were',
  'been',
  'being',
  'is',
  'are',
  'am',
  'has',
  'have',
  'had',
  'already',
  'reportedly',
  'said',
  'says',
  'stated',
  'announced',
  'reported',
  'reports',
  'after',
  'when',
  'while',
  'yesterday',
  'earlier',
  'today',
  'plan',
  'plans',
  'planned',
  'planning',
  'began',
  'begun',
  'started',
  'continued',
  'continues',
  'continuing',
  'ordered',
  'authorised',
  'authorized'
]);

/**
 * Negation. A negated directive is a statement about the rule, not a breach of
 * it - and the product's own copy is full of them ("never suggest sending
 * anyone anywhere"). See README: this is also the rule's sharpest known edge.
 */
const NEGATION = new Set([
  'not',
  'never',
  'no',
  'nor',
  'cannot',
  'cant',
  'wont',
  'dont',
  'doesnt',
  'didnt',
  'without',
  'refuse',
  'refuses',
  'refused',
  'refrain',
  'avoid',
  'avoids',
  'neither',
  'nothing',
  'none'
]);

/** Prescriptive modals for the "should go to" family. */
const MODALS = new Set(['should', 'must', 'shall', 'ought', 'needs', 'need']);

const MOVEMENT_VERBS = new Set([
  'go',
  'goes',
  'going',
  'move',
  'moves',
  'head',
  'heads',
  'proceed',
  'proceeds',
  'travel',
  'travels',
  'fly',
  'flies',
  'drive',
  'walk',
  'reach',
  'reaches',
  'enter',
  'visit',
  'respond',
  'responds',
  'deploy',
  'dispatch',
  'evacuate',
  'evacuates'
]);

/** Sentence-initial imperatives. Narrow on purpose - see README. */
const IMPERATIVE_VERBS = new Set([
  ...DISPATCH_VERBS,
  'go',
  'move',
  'head',
  'proceed',
  'evacuate',
  'rush',
  'fly',
  'prioritize',
  'prioritise'
]);

/** Nouns that make "priority" a dispatch decision rather than a sort order. */
const DISPATCH_NOUNS = new Set([
  'rescue',
  'dispatch',
  'deployment',
  'deploy',
  'deployments',
  'evacuation',
  'relief',
  'aid',
  'responders',
  'helicopter',
  'helicopters',
  'teams',
  'team',
  'extraction',
  'airlift',
  'rescues'
]);

/** Verbs of channelling effort somewhere. */
const CHANNEL_VERBS = new Set([
  'direct',
  'directs',
  'channel',
  'channels',
  'funnel',
  'funnels',
  'steer',
  'steers',
  'concentrate',
  'concentrates',
  'focus'
]);

const CHANNEL_OBJECTS = new Set([
  'resources',
  'resource',
  'aid',
  'relief',
  'teams',
  'team',
  'responders',
  'assets',
  'effort',
  'efforts',
  'helicopters',
  'personnel',
  'manpower',
  'capacity',
  'rescue'
]);

/** Stock phrases that are dispatch instructions no matter how they are framed. */
const STOCK_PHRASES = [
  ['should', 'go', 'to'],
  ['should', 'be', 'the', 'first'],
  ['first', 'stop'],
  ['next', 'stop'],
  ['first', 'place', 'to'],
  ['priority', 'for', 'rescue'],
  ['rescue', 'priority'],
  ['priority', 'for', 'deployment'],
  ['priority', 'for', 'evacuation'],
  ['direct', 'resources'],
  ['send', 'help', 'to'],
  ['get', 'help', 'to'],
  ['where', 'to', 'send'],
  ['who', 'to', 'send'],
  ['where', 'to', 'deploy'],
  ['boots', 'on', 'the', 'ground'],
  ['go', 'there', 'now'],
  ['head', 'to'],
  ['make', 'your', 'way', 'to'],
  ['begin', 'rescue', 'at'],
  ['focus', 'rescue', 'on'],
  ['top', 'of', 'the', 'dispatch'],
  ['dispatch', 'order'],
  ['assign', 'a', 'team'],
  ['needs', 'a', 'team'],
  ['needs', 'a', 'rescue']
];

/** Prose keys that would BE a dispatch field if they landed in a JSON object. */
const FIELD_VERBS = new Set([
  'dispatch',
  'deploy',
  'deployment',
  'assign',
  'assigned',
  'assignment',
  'assignee',
  'send',
  'route',
  'allocate',
  'allocation',
  'mobilize',
  'airlift',
  'tasking'
]);

const FIELD_QUALIFIERS = new Set([
  'to',
  'target',
  'targets',
  'order',
  'orders',
  'list',
  'team',
  'teams',
  'plan',
  'action',
  'assignment',
  'destination',
  'priority',
  'queue',
  'unit',
  'units',
  'instruction',
  'instructions',
  'recommendation'
]);

const SUGGESTIONS = {
  directive:
    'Describe what a report SAYS, never what anyone should do. The output may rank and explain; it may not direct.',
  priority:
    'Rank order is a reading order, not a dispatch order. Say "ranked by unexplained silence", never "priority for rescue".',
  field:
    'No dispatch-shaped field may exist in any data structure. Drop the key; a sorted list to read is the only allowed artefact.',
  imperative: 'Do not address the reader with an instruction. State the observation and stop.'
};

// --- guards ----------------------------------------------------------------

/**
 * Auxiliaries that only narrate when they can actually govern the verb. English
 * marks this: "is sending" narrates, "is send" is not a construction. So these
 * suppress only a gerund or participle.
 */
const AUXILIARIES = new Set([
  'was',
  'were',
  'been',
  'being',
  'is',
  'are',
  'am',
  'has',
  'have',
  'had'
]);

/** Is the verb at `idx` an -ing / participle form an auxiliary could govern? */
function isNonFiniteForm(scan, idx) {
  const t = scan.tokens[idx]?.t || '';
  return /(ing|ed|en)$/.test(t) || DISPATCH_PARTICIPLES.has(t);
}

/**
 * Clause-scoped lookback for a marker set. `window` bounds it as before, but the
 * clause start bounds it harder: a marker in a different clause is a marker
 * about something else.
 */
function markerInClause(scan, i, set, window) {
  const from = Math.max(scan.clauseStartFor(i), i - window);
  return findWord(scan, set, from, i - 1);
}

function guardsFor(scan, i, suppressed, rule, matchedText) {
  // 1. PRESCRIPTIVE framing promotes, and beats everything below. Ordered first
  //    because a directive that is explicitly prescribed is a directive no
  //    matter what hedging precedes it.
  const preIdx = markerInClause(scan, i, PRESCRIPTIVE, 4);
  if (preIdx !== -1) {
    // ...unless the PRESCRIPTION ITSELF is negated. "We do not recommend sending
    // teams anywhere" is the product's own honest copy: the negation attaches to
    // "recommend", not to "sending", so it has to be looked for there.
    const preNeg = negationBefore(scan, preIdx, NEGATION);
    if (preNeg !== -1 && negationScopesVerb(scan, preNeg, preIdx)) {
      suppressed.push({
        rule,
        reason: `prescriptive marker "${scan.tokens[preIdx].t}" is itself negated by "${scan.tokens[preNeg].t}"`,
        matched: clip(matchedText)
      });
      return { fire: false };
    }
    return { fire: true, severity: SEVERITY.CRITICAL, marker: scan.tokens[preIdx].t };
  }

  // 2. NEGATION suppresses - but only when it genuinely scopes this verb.
  const negIdx = negationBefore(scan, i, NEGATION);
  if (negIdx !== -1 && negationScopesVerb(scan, negIdx, i)) {
    suppressed.push({
      rule,
      reason: `negated by "${scan.tokens[negIdx].t}" in the same clause`,
      matched: clip(matchedText)
    });
    return { fire: false };
  }

  // 3. NARRATION suppresses, clause-scoped, and an auxiliary must be able to
  //    govern this verb form to count as narration at all.
  const repIdx = markerInClause(scan, i, REPORTING, 3);
  if (repIdx !== -1) {
    const marker = scan.tokens[repIdx].t;
    const auxMismatch = AUXILIARIES.has(marker) && !isNonFiniteForm(scan, i);
    if (!auxMismatch) {
      suppressed.push({
        rule,
        reason: `reads as reporting, not instruction ("${marker}" before the verb)`,
        matched: clip(matchedText)
      });
      return { fire: false };
    }
  }
  return { fire: true, severity: SEVERITY.CRITICAL, marker: null };
}

// --- rules -----------------------------------------------------------------

/** R1/R2: a dispatch verb taking a resource, or pointing at a destination. */
function ruleDirective(scan, out, suppressed) {
  const { tokens } = scan;
  for (let i = 0; i < tokens.length; i++) {
    const consumed = anyWordAt(scan, i, DISPATCH_VERBS);
    if (!consumed) continue;
    const after = i + consumed;

    const resource = findPhrase(scan, RESOURCE_PHRASES, after, after + 2);
    // "send teams to X" but also "send them to X" / "deploy to X": a
    // destination two tokens out is still a destination.
    const directional = findWord(scan, DIRECTIONAL, after, after + 2);
    if (!resource && directional === -1) continue;

    const endIdx = resource ? resource.to : directional;
    const span = scan.spanForTokens(i, Math.min(endIdx + 2, tokens.length - 1));
    const rule = resource ? 'dispatch.directive-verb-resource' : 'dispatch.directive-to-target';
    const g = guardsFor(scan, i, suppressed, rule, span.text);
    if (!g.fire) continue;

    out.push(
      violation({
        rule,
        severity: g.severity,
        matched: clip(span.text),
        span,
        suggestion: SUGGESTIONS.directive,
        obfuscated: scan.pass === 'deobfuscated',
        pass: scan.pass,
        evidence: {
          verb: tokens[i].t,
          resource: resource ? resource.phrase.join(' ') : null,
          prescriptiveMarker: g.marker
        }
      })
    );
  }
}

/** R3: "should go to", "must be deployed", "needs to move". */
function ruleShouldGo(scan, out, suppressed) {
  const { tokens } = scan;
  for (let i = 0; i < tokens.length; i++) {
    if (!anyWordAt(scan, i, MODALS)) continue;

    let hitIdx = -1;
    let kind = null;
    for (let j = i + 1; j <= Math.min(i + 4, tokens.length - 1); j++) {
      if (anyWordAt(scan, j, MOVEMENT_VERBS)) {
        hitIdx = j;
        kind = 'movement';
        break;
      }
      if (tokens[j].t === 'be' && anyWordAt(scan, j + 1, DISPATCH_PARTICIPLES)) {
        hitIdx = j + 1;
        kind = 'passive-dispatch';
        break;
      }
    }
    if (hitIdx === -1) continue;

    const rule = 'dispatch.prescribed-movement';
    const span = scan.spanForTokens(i, Math.min(hitIdx + 3, tokens.length - 1));
    const negIdx = negationBefore(scan, i, NEGATION);
    if (negIdx !== -1 && negationScopesVerb(scan, negIdx, hitIdx)) {
      suppressed.push({
        rule,
        reason: `negated by "${tokens[negIdx].t}"`,
        matched: clip(span.text)
      });
      continue;
    }

    out.push(
      violation({
        rule,
        severity: SEVERITY.CRITICAL,
        matched: clip(span.text),
        span,
        suggestion: SUGGESTIONS.directive,
        obfuscated: scan.pass === 'deobfuscated',
        pass: scan.pass,
        evidence: { modal: tokens[i].t, verb: tokens[hitIdx].t, kind }
      })
    );
  }
}

/** R4: "priority for rescue", "prioritize X for deployment". */
function rulePriority(scan, out, suppressed) {
  const { tokens } = scan;
  const PRIORITY_WORDS = new Set([
    'priority',
    'priorities',
    'prioritize',
    'prioritise',
    'prioritized',
    'prioritised',
    'prioritizing',
    'prioritising'
  ]);
  for (let i = 0; i < tokens.length; i++) {
    if (!anyWordAt(scan, i, PRIORITY_WORDS)) continue;
    let hit = findWord(scan, DISPATCH_NOUNS, i + 1, i + 4);
    if (hit === -1) hit = findWord(scan, DISPATCH_NOUNS, i - 2, i - 1);
    if (hit === -1) continue;

    const rule = 'dispatch.priority-as-assignment';
    const lo = Math.min(i, hit);
    const hi = Math.max(i, hit);
    const span = scan.spanForTokens(lo, hi);
    const negIdx = negationBefore(scan, lo, NEGATION);
    if (negIdx !== -1 && negationScopesVerb(scan, negIdx, lo)) {
      suppressed.push({
        rule,
        reason: `negated by "${tokens[negIdx].t}"`,
        matched: clip(span.text)
      });
      continue;
    }
    out.push(
      violation({
        rule,
        severity: SEVERITY.CRITICAL,
        matched: clip(span.text),
        span,
        suggestion: SUGGESTIONS.priority,
        obfuscated: scan.pass === 'deobfuscated',
        pass: scan.pass,
        evidence: { priorityWord: tokens[i].t, target: tokens[hit].t }
      })
    );
  }
}

/** R5: "direct resources", "focus rescue on", "channel aid". */
function ruleChannel(scan, out, suppressed) {
  const { tokens } = scan;
  for (let i = 0; i < tokens.length; i++) {
    if (!anyWordAt(scan, i, CHANNEL_VERBS)) continue;
    const obj = findWord(scan, CHANNEL_OBJECTS, i + 1, i + 3);
    if (obj === -1) continue;

    const rule = 'dispatch.channel-resources';
    const span = scan.spanForTokens(i, Math.min(obj + 2, tokens.length - 1));
    const g = guardsFor(scan, i, suppressed, rule, span.text);
    if (!g.fire) continue;

    out.push(
      violation({
        rule,
        severity: g.severity,
        matched: clip(span.text),
        span,
        suggestion: SUGGESTIONS.directive,
        obfuscated: scan.pass === 'deobfuscated',
        pass: scan.pass,
        evidence: { verb: tokens[i].t, object: tokens[obj].t }
      })
    );
  }
}

/** R6: a sentence that STARTS with an imperative and points somewhere. */
function ruleImperativeSentence(scan, out, suppressed) {
  const { tokens } = scan;
  for (let i = 0; i < tokens.length; i++) {
    if (!scan.isSentenceStart(i)) continue;
    if (!anyWordAt(scan, i, IMPERATIVE_VERBS)) continue;

    // Bound the look-ahead to this sentence.
    let end = i + 1;
    while (end < tokens.length && !scan.isSentenceStart(end)) end++;
    const last = end - 1;

    const hasTarget = findWord(scan, DIRECTIONAL, i + 1, last) !== -1;
    const resource = findPhrase(scan, RESOURCE_PHRASES, i + 1, last);
    if (!hasTarget && !resource) continue;

    const rule = 'dispatch.imperative-sentence';
    const span = scan.spanForTokens(i, Math.min(last, i + 8));
    const negIdx = findWord(scan, NEGATION, i + 1, Math.min(last, i + 2)); // imperative: negation follows the verb
    if (negIdx !== -1) {
      suppressed.push({
        rule,
        reason: `negated by "${tokens[negIdx].t}"`,
        matched: clip(span.text)
      });
      continue;
    }

    out.push(
      violation({
        rule,
        severity: SEVERITY.CRITICAL,
        matched: clip(span.text),
        span,
        suggestion: SUGGESTIONS.imperative,
        obfuscated: scan.pass === 'deobfuscated',
        pass: scan.pass,
        evidence: { verb: tokens[i].t, hasDestination: hasTarget }
      })
    );
  }
}

/** R7: fixed dispatch idioms. */
function ruleStockPhrase(scan, out, suppressed) {
  const { tokens } = scan;
  for (let i = 0; i < tokens.length; i++) {
    for (const phrase of STOCK_PHRASES) {
      const hit = phraseAt(scan, i, phrase);
      if (!hit) continue;
      const rule = 'dispatch.stock-phrase';
      const span = scan.spanForTokens(hit.from, hit.to);
      const negIdx = negationBefore(scan, i, NEGATION);
      if (negIdx !== -1 && negationScopesVerb(scan, negIdx, i)) {
        suppressed.push({
          rule,
          reason: `negated by "${tokens[negIdx].t}"`,
          matched: clip(span.text)
        });
        continue;
      }
      out.push(
        violation({
          rule,
          severity: SEVERITY.CRITICAL,
          matched: clip(span.text),
          span,
          suggestion: SUGGESTIONS.directive,
          obfuscated: scan.pass === 'deobfuscated',
          pass: scan.pass,
          evidence: { phrase: phrase.join(' ') }
        })
      );
      break;
    }
  }
}

/**
 * R8: GLUED BLOB. Backstop for letter-spacing that the tokenizer could not
 * split - "s e n d t e a m s t o h a k u" arrives as one merged token, so
 * whole-word matching cannot see it.
 *
 * Only merged tokens are examined (a merged token can only come from a run of
 * 3+ single letters, which does not occur in prose), and a verb prefix alone is
 * not enough: the remainder must continue with a resource word or a
 * destination. That pairing requirement is what stops "sendhelpline" or a
 * concatenated headline from firing.
 */
function ruleGluedBlob(scan, out) {
  const RESOURCE_HEADS = new Set(RESOURCE_PHRASES.map((p) => p[0]));
  for (let i = 0; i < scan.tokens.length; i++) {
    const tok = scan.tokens[i];
    if (!tok.merged || tok.t.length < 7) continue;
    for (const verb of DISPATCH_VERBS) {
      if (!tok.t.startsWith(verb)) continue;
      const rest = tok.t.slice(verb.length);
      const continues =
        [...RESOURCE_HEADS].some((r) => rest.startsWith(r)) ||
        rest.startsWith('to') ||
        rest.startsWith('into');
      if (!continues) continue;
      const span = scan.spanForTokens(i, i);
      out.push(
        violation({
          rule: 'dispatch.obfuscated-blob',
          severity: SEVERITY.CRITICAL,
          matched: clip(span.text),
          span,
          suggestion: SUGGESTIONS.directive,
          obfuscated: true,
          pass: scan.pass,
          evidence: { blob: tok.t, verb }
        })
      );
      break;
    }
  }
}

/**
 * R9: dispatch-SHAPED FIELDS. Hard rule 1 forbids the field, not just the
 * sentence, so this runs over the RAW text and looks at anything shaped like a
 * key: `"dispatchTo":`, `assigned_to =`, `Deployment:`.
 */
function ruleFieldShape(rawText, out) {
  const KEY_RE = /["'`]?\b([A-Za-z_][A-Za-z0-9_\-.]{0,40})["'`]?\s*[:=]/g;
  let m;
  while ((m = KEY_RE.exec(rawText)) !== null) {
    const words = keyWords(m[1]);
    if (!words.length) continue;
    const hasVerb = words.some((w) => FIELD_VERBS.has(w));
    const hasQualifier = words.some((w) => FIELD_QUALIFIERS.has(w));
    const isActionKey =
      words.includes('action') &&
      words.some((w) => ['recommended', 'next', 'required', 'suggested'].includes(w));

    const fires = (hasVerb && (words.length === 1 || hasQualifier)) || isActionKey;
    if (!fires) continue;

    const start = m.index + m[0].indexOf(m[1]);
    out.push(
      violation({
        rule: 'dispatch.field-shape',
        severity: SEVERITY.CRITICAL,
        matched: clip(m[0]),
        span: { start, end: start + m[1].length },
        suggestion: SUGGESTIONS.field,
        pass: 'raw',
        evidence: { key: m[1], words }
      })
    );
  }
}

/**
 * R10: DEVANAGARI DIRECTIVE.
 *
 * The English rules above are verb-form aware because English marks tense and
 * mood with word forms. Nepali marks them with suffixes, so a token-set match
 * would either miss every inflection or fire on every one. This rule therefore
 * works on stems over the raw text, and requires THREE things inside one
 * window - a sending stem, a resource, and an explicit prescriptive/imperative
 * marker - rather than two.
 *
 * That triple is what keeps ordinary Nepali reporting clean:
 *   "राहत सामग्री पठाइएको छ"      (relief material HAS BEEN sent) - no marker, no fire
 *   "उद्धार टोली गाउँमा पुग्यो"     (rescue team reached the village) - no stem, no fire
 *   "उद्धार टोली पठाउनुहोस्"       (SEND a rescue team) - all three, fires
 *
 * This vocabulary is small and it is honestly small. It covers the imperative
 * and modal constructions a model would actually produce; it is not a Nepali
 * parser, and checkNoDispatch's advisory rule reports any OTHER script it
 * cannot read rather than implying this one is complete.
 */
const NE_SEND_STEMS = ['पठा', 'खटा', 'तैनाथ', 'परिचालन', 'परिचालित', 'डिस्प्याच'];

const NE_RESOURCE_STEMS = [
  'टोली',
  'उद्धार',
  'हेलिकप्टर',
  'हेलिकोप्टर',
  'सेना',
  'प्रहरी',
  'राहत',
  'एम्बुलेन्स',
  'बचाव',
  'स्वयंसेवक',
  'जनशक्ति',
  'सामग्री',
  'बचावकर्ता'
];

/** Imperative / modal / urgency markers. Without one of these nothing fires. */
const NE_PRESCRIPTIVE = [
  'नुहोस्',
  'नुपर्',
  'पर्छ',
  'पर्ने',
  'गर्नुपर्',
  'आवश्यक',
  'प्राथमिकता',
  'तुरुन्त',
  'तत्काल',
  'अविलम्ब',
  'सिफारिस'
];

/** Perfective / passive narration. Present in the window, nothing fires. */
const NE_NARRATION = ['एको', 'इयो', 'ियो', 'एका', 'भयो', 'गरियो', 'गइयो'];

/** Negation. Present in the window, nothing fires. */
const NE_NEGATION = ['छैन', 'हुँदैन', 'नगर्नु', 'नपठा', 'कहिल्यै'];

const NE_WINDOW = 80;

function ruleDevanagariDirective(rawText, out) {
  const text = String(rawText || '');
  const anyAt = (list, from, to) => {
    const slice = text.slice(Math.max(0, from), to);
    return list.find((s) => slice.includes(s)) || null;
  };

  for (const stem of NE_SEND_STEMS) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(stem, from);
      if (idx === -1) break;
      from = idx + stem.length;

      const lo = idx - NE_WINDOW;
      const hi = idx + stem.length + NE_WINDOW;
      const resource = anyAt(NE_RESOURCE_STEMS, lo, hi);
      const marker = anyAt(NE_PRESCRIPTIVE, lo, hi);
      if (!resource || !marker) continue;
      if (anyAt(NE_NARRATION, lo, hi) || anyAt(NE_NEGATION, lo, hi)) continue;

      const start = Math.max(0, lo);
      const end = Math.min(text.length, hi);
      out.push(
        violation({
          rule: 'dispatch.devanagari-directive',
          severity: SEVERITY.CRITICAL,
          matched: clip(text.slice(start, end)),
          span: { start, end },
          suggestion: SUGGESTIONS.directive,
          pass: 'raw',
          evidence: { script: 'devanagari', stem, resource, marker }
        })
      );
      break; // one finding per stem is enough to block
    }
  }
}

/**
 * R11: UNSCANNED SCRIPT. Not a dispatch finding - a COVERAGE finding. It says
 * "this text was not actually checked", which is the one thing a guardrail must
 * never leave unsaid. Advisory: it records, it does not block, because a Chinese
 * news quote in a report body is not a hard-rule violation.
 */
const COVERED_SCRIPTS = ['latin', 'devanagari'];

function ruleUnscannedScript(rawText, out) {
  for (const u of uncoveredScripts(rawText, { covered: COVERED_SCRIPTS })) {
    const span = firstScriptSpan(rawText, u.script);
    out.push(
      violation({
        rule: 'dispatch.unscanned-script',
        severity: SEVERITY.ADVISORY,
        matched: clip(span.text || u.script, 60),
        span,
        suggestion:
          `${u.chars} characters of ${u.script} script (${Math.round(u.share * 100)}% of the text). ` +
          'The no-dispatch vocabulary covers Latin and Devanagari only, so this text was NOT scanned for dispatch language. ' +
          'Treat it as unchecked, not as clean.',
        pass: 'raw',
        evidence: { script: u.script, chars: u.chars, share: u.share, covered: COVERED_SCRIPTS }
      })
    );
  }
}

// --- entry point -----------------------------------------------------------

export const NO_DISPATCH_RULES = [
  'dispatch.directive-verb-resource',
  'dispatch.directive-to-target',
  'dispatch.prescribed-movement',
  'dispatch.priority-as-assignment',
  'dispatch.channel-resources',
  'dispatch.imperative-sentence',
  'dispatch.stock-phrase',
  'dispatch.obfuscated-blob',
  'dispatch.field-shape',
  'dispatch.devanagari-directive',
  'dispatch.unscanned-script'
];

/**
 * Scan model-produced text for dispatch-shaped language.
 *
 * @param {string} text
 * @param {{stage?: string}} [options]
 * @returns {object} verdict - see verdict.js. NEVER a bare boolean.
 */
export function checkNoDispatch(text, options = {}) {
  const stage = options.stage || 'output';
  try {
    const raw = String(text ?? '');
    const scans = makeScans(raw);
    const violations = [];
    const suppressed = [];

    for (const scan of scans) {
      ruleDirective(scan, violations, suppressed);
      ruleShouldGo(scan, violations, suppressed);
      rulePriority(scan, violations, suppressed);
      ruleChannel(scan, violations, suppressed);
      ruleImperativeSentence(scan, violations, suppressed);
      ruleStockPhrase(scan, violations, suppressed);
      ruleGluedBlob(scan, violations);
    }
    ruleFieldShape(raw, violations);
    ruleDevanagariDirective(raw, violations);
    ruleUnscannedScript(raw, violations);

    return makeVerdict({
      stage,
      checks: ['no-dispatch'],
      violations,
      suppressed,
      stats: { chars: raw.length, tokens: scans[0].tokens.length }
    });
  } catch (err) {
    return internalErrorVerdict(stage, err, ['no-dispatch']);
  }
}

export default checkNoDispatch;
