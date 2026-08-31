// Signal Zero - GUARDRAIL 2 / HONEST UNKNOWNS
// ---------------------------------------------------------------------------
// HARD RULE 4: coverageBasis "cohort-cold-start" means NO DATA REACHED US -
// never "confirmed silent". Absence of data is never disguised as knowledge.
//
// This is the rule the whole product rests on. Signal Zero ranks settlements by
// how anomalously long they have gone without a CONFIRMING REPORT REACHING US.
// The instant any surface says "confirmed silent" or "verified no survivors",
// the system has claimed to know something it structurally cannot know: it has
// no observer there. That is not a wording preference. It is the difference
// between "we have not heard from Haku" (true, and the reason it ranks first)
// and "Haku is empty" (a claim nobody made, that would send people to the
// wrong place or stop them going at all).
//
// TWO FAMILIES OF DISHONESTY, and the second one is the sneakier:
//
//   A. absence -> catastrophe   "verified no survivors", "the village is gone"
//   B. absence -> safety        "confirmed all clear", "no news is good news"
//
// B is the one that kills people quietly, so it is treated exactly as harshly.
//
// NEGATION IS LOAD-BEARING HERE. The product's own honest copy contains the
// forbidden phrases in negated form - "This is an absence of data, not a
// confirmed silence." A guardrail that fires on its own correct answer is a
// guardrail that gets deleted, so a negation within the preceding four tokens
// suppresses the match and the suppression is recorded.
// ---------------------------------------------------------------------------

import {
  makeScans,
  anyWordAt,
  phraseAt,
  findWord,
  findPhrase,
  negationBefore,
  uncoveredScripts,
  firstScriptSpan,
  clip
} from './text.js';
import { SEVERITY, violation, makeVerdict, internalErrorVerdict } from './verdict.js';

// --- vocabularies ----------------------------------------------------------

/** Words that assert knowledge. */
const KNOWLEDGE = new Set([
  'confirmed',
  'confirm',
  'confirms',
  'confirming',
  'confirmation',
  'verified',
  'verify',
  'verifies',
  'verification',
  'validated',
  'validate',
  'established',
  'proven',
  'proves',
  'proved',
  'certain',
  'certainly',
  'definitely',
  'definitive',
  'conclusive',
  'conclusively',
  'known',
  'know',
  'knows',
  'determined',
  'ascertained',
  'clearly',
  'undoubtedly',
  'guaranteed',
  'assured',
  'sure',
  'evidently',
  'demonstrably'
]);

/**
 * States that can ONLY be inferred from absence of contact, never observed by
 * this system.
 *
 * DELIBERATELY ABSENT: "dead", "destroyed", "damaged", "missing". "389
 * confirmed dead" and "houses confirmed destroyed" are somebody's real
 * observation being relayed - blocking them would gut the corroboration path
 * and teach operators that the guardrail is noise. The dishonesty this rule
 * hunts is claiming to have OBSERVED a silence.
 */
const ABSENCE_STATES = new Set([
  'silent',
  'silence',
  'quiet',
  'empty',
  'deserted',
  'abandoned',
  'uninhabited',
  'incommunicado'
]);

/** Catastrophe-from-absence assertions. */
const CATASTROPHE_PHRASES = [
  ['no', 'survivors'],
  ['nobody', 'survived'],
  ['no', 'one', 'survived'],
  ['none', 'survived'],
  ['everyone', 'is', 'dead'],
  ['all', 'are', 'dead'],
  ['all', 'dead'],
  ['nobody', 'is', 'alive'],
  ['no', 'one', 'is', 'alive'],
  ['wiped', 'out'],
  ['total', 'loss', 'of', 'life'],
  ['nobody', 'left'],
  ['no', 'one', 'left'],
  ['everyone', 'is', 'gone']
];

/** Safety-from-absence assertions - the quieter, deadlier half. */
const SAFETY_PHRASES = [
  ['no', 'casualties'],
  ['no', 'damage'],
  ['all', 'clear'],
  ['is', 'safe'],
  ['are', 'safe'],
  ['is', 'fine'],
  ['are', 'fine'],
  ['is', 'unaffected'],
  ['are', 'unaffected'],
  ['unaffected'],
  ['no', 'harm'],
  ['nothing', 'happened'],
  ['is', 'intact'],
  ['are', 'intact'],
  ['is', 'ok'],
  ['are', 'ok'],
  ['no', 'emergency'],
  ['no', 'need', 'for', 'concern']
];

/** "no reports" reasoned INTO a conclusion. */
const INFERENCE_PHRASES = [
  ['no', 'news', 'is', 'good', 'news'],
  ['silence', 'means'],
  ['silence', 'implies'],
  ['silence', 'confirms'],
  ['silence', 'indicates'],
  ['no', 'reports', 'means'],
  ['no', 'reports', 'implies'],
  ['no', 'reports', 'confirms'],
  ['no', 'reports', 'indicates'],
  ['no', 'report', 'means'],
  ['lack', 'of', 'reports', 'means'],
  ['lack', 'of', 'reports', 'confirms'],
  ['absence', 'of', 'reports', 'means'],
  ['absence', 'of', 'reports', 'confirms'],
  ['absence', 'of', 'data', 'confirms'],
  ['means', 'nothing', 'happened'],
  ['means', 'it', 'is', 'safe'],
  ['proves', 'no', 'one'],
  ['therefore', 'no', 'survivors'],
  ['so', 'it', 'must', 'be', 'empty']
];

/**
 * Generalized form of the phrase list above: an ABSENCE SUBJECT reasoned into
 * a conclusion by an EVIDENCE verb. Catches constructions the fixed phrases
 * miss, e.g. "the absence of any report is itself proof of the worst".
 */
const ABSENCE_SUBJECTS = new Set(['silence', 'absence', 'nothing', 'quiet']);
const ABSENCE_SUBJECT_PHRASES = [
  ['no', 'report'],
  ['no', 'reports'],
  ['no', 'data'],
  ['no', 'news'],
  ['no', 'contact'],
  ['no', 'word'],
  ['no', 'information'],
  ['lack', 'of', 'reports']
];
const EVIDENCE_WORDS = new Set([
  'proof',
  'proves',
  'proven',
  'evidence',
  'confirms',
  'confirmed',
  'means',
  'meaning',
  'implies',
  'implied',
  'indicates',
  'indicating',
  'demonstrates',
  'suggests',
  'establishes'
]);

/** First-person knowledge claims: "we know X is quiet". */
const KNOWERS = new Set(['we', 'i', 'system', 'signal', 'it', 'this', 'dashboard']);
const KNOWING_VERBS = new Set([
  'know',
  'knows',
  'confirm',
  'confirms',
  'confirmed',
  'verified',
  'established',
  'determined'
]);

/**
 * The framings that are TRUE. If a cold-start surface talks about silence at
 * all, one of these must be present.
 */
const HONEST_FRAMINGS = [
  ['no', 'report', 'has', 'reached', 'us'],
  ['no', 'reports', 'have', 'reached', 'us'],
  ['no', 'report', 'has', 'ever', 'reached'],
  ['no', 'data', 'reached', 'us'],
  ['no', 'data', 'has', 'reached', 'us'],
  ['nothing', 'has', 'reached', 'us'],
  ['has', 'not', 'reached', 'us'],
  ['not', 'been', 'reached'],
  ['absence', 'of', 'data'],
  ['absence', 'of', 'reports'],
  ['we', 'have', 'not', 'heard'],
  ['have', 'not', 'heard', 'from'],
  ['no', 'confirming', 'report'],
  ['no', 'report', 'has', 'resolved'],
  ['no', 'observer'],
  ['unconfirmed'],
  ['not', 'confirmed'],
  ['cold', 'start'],
  ['no', 'baseline', 'of', 'its', 'own']
];

/** Words that mean the text is making a coverage claim at all. */
const COVERAGE_TOPIC = new Set([
  'silent',
  'silence',
  'quiet',
  'covered',
  'coverage',
  'unreported',
  'unreachable',
  'contactless'
]);

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
  'neither',
  'un',
  'isnt',
  'arent',
  'rather'
]);

const SUGGESTIONS = {
  absence:
    'Say what actually happened: "no report has reached us from X". Absence of data is not an observation.',
  catastrophe:
    'The system has no observer there. It may say no report has reached us; it may not say what is or is not left.',
  safety:
    'Silence is not an all-clear. Never convert "we have heard nothing" into "nothing happened".',
  inference:
    'Absence of reports is the INPUT to the ranking, never evidence about the world. Drop the inference.',
  framing:
    'coverageBasis is cohort-cold-start: this settlement has no history of its own. Use the "no report has reached us" framing explicitly.'
};

// --- helpers ---------------------------------------------------------------

function negatedAt(scan, i, suppressed, rule, matchedText, window = 4) {
  // Sentence-scoped: "There is no contact. Confirmed silent." must NOT be
  // excused by a negation that belongs to the previous sentence.
  const negIdx = negationBefore(scan, i, NEGATION, window);
  if (negIdx === -1) return false;
  suppressed.push({
    rule,
    reason: `negated by "${scan.tokens[negIdx].t}" within ${window} tokens - reads as an honest denial`,
    matched: clip(matchedText)
  });
  return true;
}

// --- rules -----------------------------------------------------------------

/** H1: a knowledge word next to a state we can only infer from absence. */
function ruleConfirmedAbsence(scan, out, suppressed) {
  const { tokens } = scan;
  for (let i = 0; i < tokens.length; i++) {
    if (!anyWordAt(scan, i, KNOWLEDGE)) continue;
    const stateIdx = findWord(scan, ABSENCE_STATES, i + 1, i + 3);
    if (stateIdx === -1) continue;

    const rule = 'honest.confirmed-absence';
    const span = scan.spanForTokens(i, stateIdx);
    if (negatedAt(scan, i, suppressed, rule, span.text)) continue;

    out.push(
      violation({
        rule,
        severity: SEVERITY.CRITICAL,
        matched: clip(span.text),
        span,
        suggestion: SUGGESTIONS.absence,
        obfuscated: scan.pass === 'deobfuscated',
        pass: scan.pass,
        evidence: { knowledgeWord: tokens[i].t, state: tokens[stateIdx].t }
      })
    );
  }
}

/** H2: catastrophe asserted outright. */
function ruleCatastrophe(scan, out, suppressed) {
  for (let i = 0; i < scan.tokens.length; i++) {
    for (const phrase of CATASTROPHE_PHRASES) {
      const hit = phraseAt(scan, i, phrase);
      if (!hit) continue;
      const rule = 'honest.catastrophe-from-absence';
      const span = scan.spanForTokens(hit.from, hit.to);
      // "no survivors" starts with a negation itself, so only look BEFORE it.
      if (negatedAt(scan, i, suppressed, rule, span.text, 3)) break;
      out.push(
        violation({
          rule,
          severity: SEVERITY.CRITICAL,
          matched: clip(span.text),
          span,
          suggestion: SUGGESTIONS.catastrophe,
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
 * H3: safety asserted from absence. Requires a knowledge word nearby, because
 * "no casualties were reported by the DEOC" is somebody else's observation
 * being relayed, while "confirmed no casualties" is us inventing one.
 */
function ruleSafetyClaim(scan, out, suppressed) {
  for (let i = 0; i < scan.tokens.length; i++) {
    for (const phrase of SAFETY_PHRASES) {
      const hit = phraseAt(scan, i, phrase);
      if (!hit) continue;
      const knowIdx = findWord(scan, KNOWLEDGE, i - 4, i - 1);
      if (knowIdx === -1) break;

      const rule = 'honest.safety-from-absence';
      const span = scan.spanForTokens(knowIdx, hit.to);
      if (negatedAt(scan, knowIdx, suppressed, rule, span.text)) break;

      out.push(
        violation({
          rule,
          severity: SEVERITY.CRITICAL,
          matched: clip(span.text),
          span,
          suggestion: SUGGESTIONS.safety,
          obfuscated: scan.pass === 'deobfuscated',
          pass: scan.pass,
          evidence: { phrase: phrase.join(' '), knowledgeWord: scan.tokens[knowIdx].t }
        })
      );
      break;
    }
  }
}

/** H4: "silence means ...", "no news is good news". */
function ruleInference(scan, out, suppressed) {
  for (let i = 0; i < scan.tokens.length; i++) {
    for (const phrase of INFERENCE_PHRASES) {
      const hit = phraseAt(scan, i, phrase);
      if (!hit) continue;
      const rule = 'honest.absence-as-evidence';
      const span = scan.spanForTokens(hit.from, Math.min(hit.to + 3, scan.tokens.length - 1));
      if (negatedAt(scan, i, suppressed, rule, span.text, 2)) break;
      out.push(
        violation({
          rule,
          severity: SEVERITY.CRITICAL,
          matched: clip(span.text),
          span,
          suggestion: SUGGESTIONS.inference,
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
 * H4b: the general form - an absence SUBJECT plus an EVIDENCE verb within six
 * tokens. "The absence of any report is itself proof of the worst" carries no
 * fixed phrase, but it is the same fallacy.
 *
 * The negation guard is applied at the EVIDENCE word, which is what keeps the
 * product's own honest copy clean: in "an absence of data, not a confirmed
 * silence", the "not" sits directly in front of "confirmed".
 */
function ruleAbsenceEvidence(scan, out, suppressed) {
  const { tokens } = scan;
  for (let i = 0; i < tokens.length; i++) {
    let subjectEnd = -1;
    let subject = null;
    if (anyWordAt(scan, i, ABSENCE_SUBJECTS)) {
      subjectEnd = i;
      subject = tokens[i].t;
    } else {
      for (const phrase of ABSENCE_SUBJECT_PHRASES) {
        const hit = phraseAt(scan, i, phrase);
        if (hit) {
          subjectEnd = hit.to;
          subject = phrase.join(' ');
          break;
        }
      }
    }
    if (subjectEnd === -1) continue;

    const evidenceIdx = findWord(scan, EVIDENCE_WORDS, subjectEnd + 1, subjectEnd + 6);
    if (evidenceIdx === -1) continue;

    const rule = 'honest.absence-as-evidence';
    const span = scan.spanForTokens(i, Math.min(evidenceIdx + 3, tokens.length - 1));
    if (negatedAt(scan, evidenceIdx, suppressed, rule, span.text, 3)) continue;

    out.push(
      violation({
        rule,
        severity: SEVERITY.CRITICAL,
        matched: clip(span.text),
        span,
        suggestion: SUGGESTIONS.inference,
        obfuscated: scan.pass === 'deobfuscated',
        pass: scan.pass,
        evidence: { subject, verb: tokens[evidenceIdx].t }
      })
    );
  }
}

/** H5: "we know Syabru Besi is quiet" - a knower plus a state, at distance. */
function ruleWeKnow(scan, out, suppressed) {
  const { tokens } = scan;
  for (let i = 0; i < tokens.length; i++) {
    if (!anyWordAt(scan, i, KNOWERS)) continue;
    const verbIdx = findWord(scan, KNOWING_VERBS, i + 1, i + 2);
    if (verbIdx === -1) continue;

    let stateIdx = findWord(scan, ABSENCE_STATES, verbIdx + 1, verbIdx + 8);
    let phraseHit = null;
    if (stateIdx === -1) {
      phraseHit = findPhrase(scan, SAFETY_PHRASES, verbIdx + 1, verbIdx + 8);
      if (!phraseHit) continue;
      stateIdx = phraseHit.to;
    }

    const rule = 'honest.we-know-from-absence';
    const span = scan.spanForTokens(i, stateIdx);
    if (negatedAt(scan, verbIdx, suppressed, rule, span.text, 3)) continue;

    out.push(
      violation({
        rule,
        severity: SEVERITY.CRITICAL,
        matched: clip(span.text),
        span,
        suggestion: SUGGESTIONS.absence,
        obfuscated: scan.pass === 'deobfuscated',
        pass: scan.pass,
        evidence: {
          knower: tokens[i].t,
          verb: tokens[verbIdx].t,
          state: phraseHit ? phraseHit.phrase.join(' ') : tokens[stateIdx].t
        }
      })
    );
  }
}

/**
 * H6: COLD-START FRAMING. Only active when the caller states that this text
 * describes a cohort-cold-start settlement. In that case the text may talk
 * about silence, but it must say WHOSE silence and how we know - i.e. it must
 * contain one of the honest framings. A bare "Haku is silent" on a cold-start
 * row is the exact failure hard rule 4 exists to prevent.
 */
function ruleColdStartFraming(scan, out) {
  const topicIdx = findWord(scan, COVERAGE_TOPIC, 0, scan.tokens.length - 1);
  if (topicIdx === -1) return;
  const honest = findPhrase(scan, HONEST_FRAMINGS, 0, scan.tokens.length - 1);
  if (honest) return;

  const span = scan.spanForTokens(
    Math.max(0, topicIdx - 3),
    Math.min(topicIdx + 3, scan.tokens.length - 1)
  );
  out.push(
    violation({
      rule: 'honest.missing-cold-start-framing',
      severity: SEVERITY.HIGH,
      matched: clip(span.text),
      span,
      suggestion: SUGGESTIONS.framing,
      pass: scan.pass,
      evidence: { coverageBasis: 'cohort-cold-start', topicWord: scan.tokens[topicIdx].t }
    })
  );
}

// --- entry point -----------------------------------------------------------

// ---------------------------------------------------------------------------
// DEVANAGARI. "हाकु मौन भएको पुष्टि भएको छ" is "Haku is CONFIRMED SILENT" - the
// single sentence this entire product exists to prevent - and until the
// tokenizer was widened no rule above could see one character of it. Stems, not
// word forms, for the same reason as no-dispatch.js R10.
// ---------------------------------------------------------------------------

/** Knowledge / confirmation stems. */
const NE_KNOWLEDGE = ['पुष्टि', 'प्रमाणित', 'निश्चित', 'यकिन', 'सत्यापित'];

/** States only inferable from absence of contact. */
const NE_ABSENCE_STATES = ['मौन', 'सुनसान', 'खाली', 'निर्जन', 'सम्पर्कविहीन', 'चुप'];

/** Negated / honest framings that must NOT fire. */
const NE_NEGATION = ['छैन', 'हुँदैन', 'पुष्टि भएको छैन', 'अपुष्ट', 'नभएको'];

const NE_WINDOW = 60;

function ruleDevanagariFalseCertainty(rawText, out) {
  const text = String(rawText || '');
  for (const k of NE_KNOWLEDGE) {
    const idx = text.indexOf(k);
    if (idx === -1) continue;
    const lo = Math.max(0, idx - NE_WINDOW);
    const hi = Math.min(text.length, idx + k.length + NE_WINDOW);
    const window = text.slice(lo, hi);
    const state = NE_ABSENCE_STATES.find((s) => window.includes(s));
    if (!state) continue;
    if (NE_NEGATION.some((n) => window.includes(n))) continue;
    out.push(
      violation({
        rule: 'honest.confirmed-absence',
        severity: SEVERITY.CRITICAL,
        matched: clip(window),
        span: { start: lo, end: hi },
        suggestion: SUGGESTIONS.absence,
        pass: 'raw',
        evidence: { script: 'devanagari', knowledgeWord: k, state }
      })
    );
    break;
  }
}

/** COVERAGE, not detection - see the identical rule in no-dispatch.js. */
const COVERED_SCRIPTS = ['latin', 'devanagari'];

function ruleUnscannedScript(rawText, out) {
  for (const u of uncoveredScripts(rawText, { covered: COVERED_SCRIPTS })) {
    const span = firstScriptSpan(rawText, u.script);
    out.push(
      violation({
        rule: 'honest.unscanned-script',
        severity: SEVERITY.ADVISORY,
        matched: clip(span.text || u.script, 60),
        span,
        suggestion:
          `${u.chars} characters of ${u.script} script (${Math.round(u.share * 100)}% of the text). ` +
          'The honest-unknown vocabulary covers Latin and Devanagari only, so this text was NOT scanned for false certainty. ' +
          'Treat it as unchecked, not as clean.',
        pass: 'raw',
        evidence: { script: u.script, chars: u.chars, share: u.share, covered: COVERED_SCRIPTS }
      })
    );
  }
}

export const HONEST_UNKNOWN_RULES = [
  'honest.unscanned-script',
  'honest.confirmed-absence',
  'honest.catastrophe-from-absence',
  'honest.safety-from-absence',
  'honest.absence-as-evidence',
  'honest.we-know-from-absence',
  'honest.missing-cold-start-framing'
];

/**
 * @param {string} text
 * @param {{coverageBasis?: string|null, stage?: string}} [options]
 *        coverageBasis === 'cohort-cold-start' additionally requires the
 *        "no report has reached us" framing.
 * @returns {object} verdict - see verdict.js. NEVER a bare boolean.
 */
export function checkHonestUnknown(text, options = {}) {
  const stage = options.stage || 'output';
  try {
    const raw = String(text ?? '');
    const scans = makeScans(raw);
    const violations = [];
    const suppressed = [];
    const coldStart = options.coverageBasis === 'cohort-cold-start';

    for (const scan of scans) {
      ruleConfirmedAbsence(scan, violations, suppressed);
      ruleCatastrophe(scan, violations, suppressed);
      ruleSafetyClaim(scan, violations, suppressed);
      ruleInference(scan, violations, suppressed);
      ruleAbsenceEvidence(scan, violations, suppressed);
      ruleWeKnow(scan, violations, suppressed);
    }
    // Framing is a whole-text property; running it on the plain pass only keeps
    // one finding per text instead of two identical ones.
    if (coldStart) ruleColdStartFraming(scans[0], violations);
    ruleDevanagariFalseCertainty(raw, violations);
    ruleUnscannedScript(raw, violations);

    return makeVerdict({
      stage,
      checks: ['honest-unknown'],
      violations,
      suppressed,
      stats: {
        chars: raw.length,
        tokens: scans[0].tokens.length,
        coverageBasis: options.coverageBasis || null
      }
    });
  } catch (err) {
    return internalErrorVerdict(stage, err, ['honest-unknown']);
  }
}

export default checkHonestUnknown;
