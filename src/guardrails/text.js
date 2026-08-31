// Signal Zero - GUARDRAILS / shared text machinery
// ---------------------------------------------------------------------------
// Everything in src/guardrails is DETERMINISTIC CODE. No model is consulted to
// decide whether a rule fired. A prompt is a request; a guardrail is a check
// that runs whether or not the model cooperated.
//
// This file is the only place that knows how to turn arbitrary (possibly
// hostile, possibly scraped) text into something a rule can scan. Three
// properties matter and every rule depends on all three:
//
//   1. OFFSETS SURVIVE. Every token carries {start,end} into the ORIGINAL
//      string, so a violation can quote the exact span it matched instead of a
//      normalized paraphrase. An incident that says "matched: <mangled text>"
//      is not auditable.
//   2. TWO PASSES. Pass "plain" folds case/diacritics/punctuation only. Pass
//      "deobfuscated" additionally folds a leet table and a small Cyrillic /
//      Greek confusables table, and glues letter-spaced words back together.
//      A hit that only exists in pass 2 is reported with obfuscated:true, so
//      an operator can tell "the model said dispatch" apart from "something
//      tried to smuggle d1spatch past us".
//   3. NO REWRITING. Normalization exists to DETECT. Nothing here ever hands a
//      cleaned-up string back to the pipeline - a guardrail that silently
//      launders hostile text into clean-looking text is worse than no
//      guardrail, because the incident feed then shows nothing.
// ---------------------------------------------------------------------------

/**
 * Invisible characters that have no business inside prose and are the classic
 * carrier for hidden instructions.
 *
 * DELIBERATELY EXCLUDED: U+200C ZWNJ and U+200D ZWJ. Devanagari - the script
 * half this corpus is written in - uses both legitimately. Flagging them would
 * mean every correctly-typed Nepali sentence trips the guardrail, and a
 * guardrail that cries wolf on the primary language of the disaster is a
 * guardrail people switch off.
 */
export const INVISIBLE_CHARS = new Set([
  '​', // zero width space
  '‎',
  '‏', // LTR/RTL marks
  '⁠',
  '⁡',
  '⁢',
  '⁣',
  '⁤', // word joiner / invisible ops
  '᠎', // mongolian vowel separator
  '﻿' // BOM / zero width no-break space
]);

/** Bidirectional overrides - used to render text in an order humans cannot read. */
export const BIDI_CONTROL_CHARS = new Set(['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']);

/** Unicode TAG block: an entire ASCII alphabet that renders as nothing at all. */
export const TAG_CHAR_RE = /[\u{E0000}-\u{E007F}]/u;

/** Leet / symbol substitutions. Applied ONLY in the deobfuscated pass. */
const LEET = {
  0: 'o',
  1: 'i',
  3: 'e',
  4: 'a',
  5: 's',
  7: 't',
  8: 'b',
  9: 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '+': 't'
};

/**
 * Cyrillic / Greek homoglyphs. This is a HAND-PICKED subset, not the Unicode
 * confusables table - see README "Known limits". It covers the lookalikes that
 * actually appear in copy-paste evasion.
 */
const CONFUSABLES = {
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'i',
  ј: 'j',
  ԁ: 'd',
  ѵ: 'v',
  ԛ: 'q',
  ԝ: 'w',
  α: 'a',
  ε: 'e',
  ι: 'i',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  ν: 'v',
  κ: 'k',
  μ: 'm',
  χ: 'x',
  γ: 'y',
  ϲ: 'c'
};

/**
 * What counts as "inside a word".
 *
 * This was `/[a-z0-9]/` and that was a hole, not a simplification: every
 * character outside ASCII-Latin failed it and was treated as a separator, so a
 * document written in Devanagari - the script half this corpus is written in -
 * produced ZERO tokens and every whole-word rule scanned an empty stream. The
 * guardrails did not fail on Nepali; they passed it, silently, which is worse.
 *
 * `\p{M}` (combining marks) is included deliberately. Devanagari matras
 * (U+093E-U+094F and friends) are Mn/Mc, not letters, so excluding them would
 * shatter "हाकुमा" into unusable single-consonant fragments and re-open the same
 * hole one level down.
 */
const ALNUM_RE = /[\p{L}\p{N}\p{M}]/u;

// `।` (danda) and `॥` (double danda) are the Devanagari full stop. Leaving them
// out meant every Nepali sentence was one sentence to the negation scope.
const SENTENCE_BREAK_RE = /[.!?;:\n\r•·।॥]|\|\s*$/;

/**
 * CLAUSE boundaries. Weaker than a sentence break and the reason S1-3/S2-2 were
 * bypassable: negation and narration are CLAUSE-scoped, not sentence-scoped.
 * "No confirmation has arrived, send teams to Haku" is two clauses - the
 * negation belongs to the first and has no business excusing an imperative in
 * the second.
 */
const CLAUSE_BREAK_PUNCT_RE = /[,;:—–(){}[\]"“”]|\.\.\./;

/** Words that open a new clause, so a negation before them does not scope past. */
const CLAUSE_BREAK_WORDS = new Set([
  'that',
  'which',
  'who',
  'whom',
  'whose',
  'because',
  'since',
  'although',
  'though',
  'but',
  'and',
  'or',
  'so',
  'then',
  'however',
  'therefore',
  'thus',
  'whereas',
  'meanwhile',
  'yet',
  'still',
  'instead',
  'nevertheless'
]);

/**
 * Tokenize into [{t,start,end}] where t is normalized and start/end index the
 * ORIGINAL string.
 *
 * @param {string} src
 * @param {{deobfuscate?: boolean}} opts
 */
export function tokenize(src, opts = {}) {
  const deobfuscate = Boolean(opts.deobfuscate);
  const text = String(src ?? '');
  const tokens = [];
  let cur = null;

  const push = () => {
    if (cur) tokens.push(cur);
    cur = null;
  };

  for (let i = 0; i < text.length; i++) {
    const raw = text[i];

    // Invisible characters are DROPPED WITHOUT closing the token, which is
    // exactly what makes "d​ispatch" normalize to "dispatch".
    if (INVISIBLE_CHARS.has(raw) || BIDI_CONTROL_CHARS.has(raw)) continue;

    // Per-character NFKD so combining marks vanish AND compatibility forms fold
    // (offsets stay exact - normalizing the whole string first would shift every
    // index after the first accented character).
    //
    // NFKD not NFD: NFD leaves fullwidth Latin (Ｓｅｎｄ), circled letters, math
    // alphanumerics (𝐒𝐞𝐧𝐝) and ligatures untouched, so "Ｓｅｎｄ ｒｅｓｃｕｅ
    // ｔｅａｍｓ ｔｏ Ｈａｋｕ" tokenized to nothing and walked past every rule.
    // NFKD closes that entire class in one character.
    const folded = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (!folded) continue;

    for (const rawCh of folded) {
      let ch = rawCh;
      if (deobfuscate) {
        if (Object.prototype.hasOwnProperty.call(CONFUSABLES, ch)) ch = CONFUSABLES[ch];
        else if (Object.prototype.hasOwnProperty.call(LEET, ch)) ch = LEET[ch];
      }
      if (ALNUM_RE.test(ch)) {
        if (!cur) cur = { t: ch, start: i, end: i + 1 };
        else {
          cur.t += ch;
          cur.end = i + 1;
        }
      } else {
        push();
      }
    }
  }
  push();

  return deobfuscate ? mergeLetterSpacing(tokens, text) : tokens;
}

/**
 * Glue runs of >=3 single LETTER tokens back into one word, so
 * "d i s p a t c h   t e a m s" is scanned as "dispatch teams".
 *
 * Restricted to letters (never digits) and to runs of 3+, because two adjacent
 * one-letter words are ordinary English ("a b" in a list) while seven of them
 * in a row are not.
 *
 * A run BREAKS on a gap of two or more whitespace characters, or on any
 * punctuation. That is how "s e n d  t e a m s" recovers two words instead of
 * one nonsense blob: the attacker's own word spacing is wider than their
 * letter spacing. When it is not (single-spaced throughout), the run stays
 * glued and gluedBlobRule in no-dispatch.js is the backstop.
 */
function mergeLetterSpacing(tokens, text) {
  const runContinues = (a, b) => {
    const gap = text.slice(a.end, b.start);
    return gap.length <= 1 && !/[^\s]/.test(gap);
  };
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    while (
      j < tokens.length &&
      tokens[j].t.length === 1 &&
      /[a-z]/.test(tokens[j].t) &&
      (j === i || runContinues(tokens[j - 1], tokens[j]))
    )
      j++;
    const run = j - i;
    if (run >= 3) {
      out.push({
        t: tokens
          .slice(i, j)
          .map((x) => x.t)
          .join(''),
        start: tokens[i].start,
        end: tokens[j - 1].end,
        merged: true
      });
      i = j;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return out;
}

/**
 * A scan is one normalization pass plus every index a rule needs.
 *
 *   .tokens      [{t,start,end}]
 *   .joined      tokens joined by single spaces - only letters, digits, marks
 *                and spaces ever appear, so rule regexes never have to think
 *                about punctuation
 *   .spanFor()   joined-string offsets -> original-string span
 *   .isSentenceStart(i)
 *   .gluedToPrev(i)  true when tokens i-1 and i were split by punctuation only
 */
export function makeScan(src, opts = {}) {
  const text = String(src ?? '');
  const tokens = tokenize(text, opts);

  const starts = new Array(tokens.length);
  let joined = '';
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0) joined += ' ';
    starts[i] = joined.length;
    joined += tokens[i].t;
  }

  const sentenceStart = new Set();
  const clauseStart = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (i === 0) {
      sentenceStart.add(0);
      clauseStart.add(0);
      continue;
    }
    const gap = text.slice(tokens[i - 1].end, tokens[i].start);
    if (SENTENCE_BREAK_RE.test(gap) || /\n/.test(gap)) {
      sentenceStart.add(i);
      clauseStart.add(i);
    } else if (CLAUSE_BREAK_PUNCT_RE.test(gap) || CLAUSE_BREAK_WORDS.has(tokens[i].t)) {
      // A conjunction/subordinator OPENS the new clause, so the boundary sits on
      // the word itself: "...arrived, send" and "...no doubt THAT responders".
      clauseStart.add(i);
    }
  }

  const gluedToPrev = (i) => {
    if (i <= 0 || i >= tokens.length) return false;
    const gap = text.slice(tokens[i - 1].end, tokens[i].start);
    return gap.length > 0 && !/\s/.test(gap);
  };

  /** Binary search: joined offset -> token index. */
  const tokenIndexAt = (offset) => {
    let lo = 0;
    let hi = tokens.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };

  const spanFor = (jStart, jEnd) => {
    if (!tokens.length) return { start: 0, end: 0, text: '' };
    const a = tokenIndexAt(jStart);
    const b = tokenIndexAt(Math.max(jStart, jEnd - 1));
    return spanForTokens(a, b);
  };

  const spanForTokens = (a, b) => {
    if (!tokens.length) return { start: 0, end: 0, text: '' };
    const lo = Math.max(0, Math.min(a, tokens.length - 1));
    const hi = Math.max(lo, Math.min(b, tokens.length - 1));
    const start = tokens[lo].start;
    const end = tokens[hi].end;
    return { start, end, text: text.slice(start, end) };
  };

  /** Index of the first token of the sentence containing token i. */
  const sentenceStartFor = (i) => {
    for (let k = Math.min(i, tokens.length - 1); k > 0; k--) {
      if (sentenceStart.has(k)) return k;
    }
    return 0;
  };

  /** Index of the first token of the CLAUSE containing token i. */
  const clauseStartFor = (i) => {
    for (let k = Math.min(i, tokens.length - 1); k > 0; k--) {
      if (clauseStart.has(k)) return k;
    }
    return 0;
  };

  /**
   * SECOND STREAM. `joined` separates every token with a space, which is right
   * for whole-word rules but blind to punctuation-split words: "i-g-n-o-r-e"
   * stays six tokens. The glued stream re-joins tokens that were separated by
   * punctuation only (never by whitespace), so the same regex sees "ignore".
   * Rules that run over streams should run over BOTH; identical findings are
   * collapsed by dedupeViolations().
   */
  const gluedStarts = new Array(tokens.length);
  let gluedText = '';
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && !gluedToPrev(i)) gluedText += ' ';
    gluedStarts[i] = gluedText.length;
    gluedText += tokens[i].t;
  }

  const indexIn = (arr, offset) => {
    let lo = 0;
    let hi = arr.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= offset) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };

  const streams = [
    {
      name: 'spaced',
      text: joined,
      spanFor: (a, b) => spanForTokens(indexIn(starts, a), indexIn(starts, Math.max(a, b - 1)))
    },
    {
      name: 'glued',
      text: gluedText,
      spanFor: (a, b) =>
        spanForTokens(indexIn(gluedStarts, a), indexIn(gluedStarts, Math.max(a, b - 1)))
    }
  ];

  return {
    src: text,
    pass: opts.deobfuscate ? 'deobfuscated' : 'plain',
    tokens,
    joined,
    streams,
    starts,
    sentenceStart,
    clauseStart,
    gluedToPrev,
    tokenIndexAt,
    spanFor,
    spanForTokens,
    sentenceStartFor,
    clauseStartFor,
    isSentenceStart: (i) => sentenceStart.has(i),
    isClauseStart: (i) => clauseStart.has(i)
  };
}

/** Both passes of one input, in the order rules should consider them. */
export function makeScans(src) {
  return [makeScan(src, { deobfuscate: false }), makeScan(src, { deobfuscate: true })];
}

// ---------------------------------------------------------------------------
// Token matching. Every helper understands "glue": a keyword split by
// punctuation but NOT by whitespace ("d-i-s-p-a-t-c-h", "dis.patch") is still
// the keyword. Whitespace is never glued, which is what keeps this from
// inventing keywords out of adjacent innocent words.
// ---------------------------------------------------------------------------

// Long enough to reassemble a fully hyphen-split word ("d-i-s-p-a-t-c-h").
// Safe because glue never crosses whitespace and stops at the target length.
const MAX_GLUE = 16;

/**
 * Does `word` start at token i? Returns the number of tokens consumed, or 0.
 */
export function wordAt(scan, i, word) {
  const { tokens } = scan;
  if (i < 0 || i >= tokens.length) return 0;
  if (tokens[i].t === word) return 1;
  let acc = tokens[i].t;
  for (let k = 1; k < MAX_GLUE && i + k < tokens.length; k++) {
    if (!scan.gluedToPrev(i + k)) break;
    acc += tokens[i + k].t;
    if (acc === word) return k + 1;
    if (acc.length >= word.length) break;
  }
  return 0;
}

/** Is any member of `set` (a Set of single words) at token i? -> consumed|0 */
export function anyWordAt(scan, i, set) {
  const { tokens } = scan;
  if (i < 0 || i >= tokens.length) return 0;
  if (set.has(tokens[i].t)) return 1;
  let acc = tokens[i].t;
  for (let k = 1; k < MAX_GLUE && i + k < tokens.length; k++) {
    if (!scan.gluedToPrev(i + k)) break;
    acc += tokens[i + k].t;
    if (set.has(acc)) return k + 1;
  }
  return 0;
}

/** Does the word-array `phrase` start at token i? -> {from,to} or null. */
export function phraseAt(scan, i, phrase) {
  let cursor = i;
  for (const word of phrase) {
    const consumed = wordAt(scan, cursor, word);
    if (!consumed) return null;
    cursor += consumed;
  }
  return { from: i, to: cursor - 1 };
}

/** First hit of any phrase in [from,to] inclusive. -> {from,to,phrase} or null */
export function findPhrase(scan, phrases, from = 0, to = Infinity) {
  const last = Math.min(scan.tokens.length - 1, to);
  for (let i = Math.max(0, from); i <= last; i++) {
    for (const phrase of phrases) {
      const hit = phraseAt(scan, i, phrase);
      if (hit) return { ...hit, phrase };
    }
  }
  return null;
}

/** First token index in [from,to] whose word is in `set`, else -1. */
export function findWord(scan, set, from, to) {
  const last = Math.min(scan.tokens.length - 1, to);
  for (let i = Math.max(0, from); i <= last; i++) {
    if (anyWordAt(scan, i, set)) return i;
  }
  return -1;
}

/** True when any word of `set` appears in the window BEFORE token i. */
export function precededBy(scan, i, set, window = 4) {
  return findWord(scan, set, i - window, i - 1) !== -1;
}

/**
 * Negation scope. Negation is CLAUSAL, not sentential - "we never say send
 * teams" negates the verb, while "No confirmation has arrived, send teams to
 * Haku" does not: the negation lives in the first clause and the imperative in
 * the second.
 *
 * This used to clamp to the SENTENCE, and because SENTENCE_BREAK_RE has no
 * comma, five hedging words in front of any directive switched the whole
 * no-dispatch guardrail off ("Nothing is confirmed yet, send teams to Haku"
 * passed clean). Three clamps now apply and each one matters:
 *   - the CLAUSE clamp stops another clause's negation from excusing a directive
 *   - the window clamp stops a long clause's early "no report" from doing it
 *   - the NOMINAL-NEGATOR clamp (below) stops "Without delay send helicopters",
 *     where the negator attaches to a noun phrase and never reaches the verb
 *
 * Returns the negating token index, or -1.
 */
export function negationBefore(scan, i, set, window = 5) {
  const from = Math.max(scan.clauseStartFor(i), i - window);
  return findWord(scan, set, from, i - 1);
}

/**
 * Negators that scope over a NOUN PHRASE rather than over a verb. "without
 * sending teams" genuinely negates the sending; "without delay send teams" does
 * not - the "without" belongs to "delay". English marks the difference by verb
 * form, so we require one: a nominal negator only suppresses a verb that is a
 * gerund (`-ing`) or a participle.
 */
const NOMINAL_NEGATORS = new Set(['without']);

/**
 * Does a negation at `negIdx` actually scope over the verb token at `verbIdx`?
 *
 * @param {object} scan
 * @param {number} negIdx  index returned by negationBefore(), or -1
 * @param {number} verbIdx index of the matched verb
 * @returns {boolean}
 */
export function negationScopesVerb(scan, negIdx, verbIdx) {
  if (negIdx === -1) return false;
  const neg = scan.tokens[negIdx]?.t;
  if (!NOMINAL_NEGATORS.has(neg)) return true;
  // "without" only reaches the verb through a gerund/participle complement.
  const verb = scan.tokens[verbIdx]?.t || '';
  return /(ing|ed|en)$/.test(verb);
}

/** Convert a set-like literal into a Set of normalized words. */
export function wordSet(list) {
  return new Set(list);
}

/** "dispatchTo" / "dispatch_to" / "dispatch-to" -> ["dispatch","to"] */
export function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// SCRIPT COVERAGE.
//
// Widening the tokenizer (above) means non-Latin text now produces tokens. It
// does NOT mean a rule can read it: a rule can only match vocabulary it holds,
// and the vocabularies here cover Latin-script English plus a deliberately small
// Devanagari set. Everything else tokenizes cleanly and then matches nothing.
//
// That is a legitimate limit. Being SILENT about it is not - it is the exact
// failure mode this product exists to attack, one level up. So a document
// carrying a substantial run of a script the rules have no vocabulary for gets
// an ADVISORY violation saying it was not scanned, rather than a clean pass that
// cannot be told apart from a real one.
// ---------------------------------------------------------------------------

const SCRIPT_PROBES = [
  ['latin', /\p{Script=Latin}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['han', /\p{Script=Han}/u],
  ['hiragana', /\p{Script=Hiragana}/u],
  ['katakana', /\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['thai', /\p{Script=Thai}/u]
];

const LETTER_RE = /\p{L}/u;

/**
 * Count letters per script. Marks and punctuation are ignored; only letters
 * decide what language a document is written in.
 *
 * @returns {{counts: Record<string, number>, letters: number}}
 */
export function scriptProfile(src) {
  const text = String(src ?? '');
  const counts = Object.create(null);
  let letters = 0;
  for (const ch of text) {
    if (!LETTER_RE.test(ch)) continue;
    letters++;
    let name = 'other';
    for (const [label, re] of SCRIPT_PROBES) {
      if (re.test(ch)) {
        name = label;
        break;
      }
    }
    counts[name] = (counts[name] || 0) + 1;
  }
  return { counts, letters };
}

/**
 * Which scripts in `src` do the given rule vocabularies not cover?
 *
 * A script is reported only when it is a real presence rather than a stray
 * loanword: at least `minChars` letters AND at least `minShare` of all letters.
 *
 * @param {string} src
 * @param {{covered?: string[], minChars?: number, minShare?: number}} [opts]
 * @returns {Array<{script: string, chars: number, share: number}>}
 */
export function uncoveredScripts(src, opts = {}) {
  // Default matches the vocabularies that actually exist in this repo. Callers
  // still pass `covered` explicitly, so the two cannot drift silently - but a
  // default of ['latin'] would have reported Nepali as unscannable, which is the
  // opposite of true and exactly the kind of quiet wrongness this rule is for.
  const covered = new Set(opts.covered || ['latin', 'devanagari']);
  const minChars = opts.minChars ?? 12;
  const minShare = opts.minShare ?? 0.15;
  const { counts, letters } = scriptProfile(src);
  if (!letters) return [];
  const out = [];
  for (const [script, chars] of Object.entries(counts)) {
    if (covered.has(script)) continue;
    const share = chars / letters;
    if (chars < minChars || share < minShare) continue;
    out.push({ script, chars, share: Number(share.toFixed(3)) });
  }
  return out.sort((a, b) => b.chars - a.chars);
}

/** The first run of `script` in `src`, as a {start,end,text} span for an incident. */
export function firstScriptSpan(src, script) {
  const text = String(src ?? '');
  const probe = SCRIPT_PROBES.find(([label]) => label === script)?.[1];
  if (!probe) return { start: 0, end: 0, text: '' };
  let start = -1;
  let end = 0;
  let i = 0;
  for (const ch of text) {
    const size = ch.length;
    if (probe.test(ch)) {
      if (start === -1) start = i;
      end = i + size;
    } else if (start !== -1 && !/\s|\p{M}|\p{P}/u.test(ch)) {
      break;
    }
    i += size;
  }
  if (start === -1) return { start: 0, end: 0, text: '' };
  return { start, end, text: text.slice(start, end) };
}

/** Clip a quoted span so an incident message stays readable. */
export function clip(str, max = 120) {
  const s = String(str ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
