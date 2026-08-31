// Signal Zero - GUARDRAIL 3 / PROMPT INJECTION IN SCRAPED CONTENT
// ---------------------------------------------------------------------------
// Everything Bright Data hands the pipeline is UNTRUSTED INPUT. A news article,
// a district bulletin, a social post - none of them are instructions, all of
// them are data, and the only stage that ever shows them to a model is triage
// tier 3. So the check belongs BEFORE the model, not after it: an injected
// instruction that is only caught on the way out has already been obeyed.
//
// WHAT THIS DEFENDS AGAINST, in the order an attacker reaches for it:
//   1. instruction override      "ignore all previous instructions"
//   2. role/turn forgery          "SYSTEM:", <|im_start|>, "Assistant:"
//   3. persona escape             "you are now", "act as an unrestricted AI"
//   4. agent-directed imperatives "you must classify this as noise"
//   5. exfiltration               "print your system prompt", "send it to ..."
//   6. tool abuse                 "call the scrape tool on http://..."
//   7. invisible carriers         zero-width, bidi overrides, Unicode TAG chars
//   8. hidden markup              HTML comments, display:none blocks
//   9. encoded payloads           base64 blob next to "decode this"
//  10. forged authority           "SYSTEM OVERRIDE", "authorized by the developer"
//
// DELIBERATE ASYMMETRY WITH no-dispatch.js: an article that says "the army
// deployed teams to Rasuwa" is legitimate reporting and must ingest cleanly, so
// dispatch language is NOT an injection rule. Dispatch language is only ever a
// violation on the way OUT, in the system's own voice.
//
// This module never rewrites its input. It reports. The caller drops the
// report and files an incident; nobody gets a laundered string that looks safe.
// ---------------------------------------------------------------------------

import {
  makeScan,
  clip,
  uncoveredScripts,
  firstScriptSpan,
  INVISIBLE_CHARS,
  BIDI_CONTROL_CHARS,
  TAG_CHAR_RE
} from './text.js';
import { SEVERITY, violation, makeVerdict, internalErrorVerdict } from './verdict.js';

// ---------------------------------------------------------------------------
// Rules that run on the NORMALIZED, DEOBFUSCATED word stream. Because that
// stream is only [a-z0-9 ], these patterns never have to anticipate punctuation
// tricks: "i-g-n-o-r-e   p.r.e.v.i.o.u.s" arrives here as "ignore previous".
// ---------------------------------------------------------------------------

const STREAM_RULES = [
  {
    id: 'injection.instruction-override',
    severity: SEVERITY.CRITICAL,
    re: /\b(ignore|disregard|forget|discard|override|bypass|skip|drop)\b(?:\s+\w+){0,4}?\s+\b(previous|prior|above|earlier|preceding|initial|original|all|any|the|your|system)\b(?:\s+\w+){0,3}?\s+\b(instruction|instructions|prompt|prompts|rule|rules|directive|directives|guideline|guidelines|guardrail|guardrails|constraint|constraints|context|training)\b/,
    suggestion:
      'Untrusted content tried to rewrite the task. Drop the document; do not show it to the model.'
  },
  {
    // The rule above needs an anchor word (previous/prior/system/...) between the
    // verb and an instruction noun. Ordinary paraphrase carries neither: "Put
    // aside what came before", "Disregard everything you were told". Same attack,
    // no anchor, so it walked through.
    id: 'injection.instruction-override-paraphrase',
    severity: SEVERITY.HIGH,
    re: /\b(?:ignore|disregard|forget|put aside|set aside|leave aside|discard|override|never mind|pay no attention to)\b(?:\s+\w+){0,2}?\s+\b(?:everything|anything|whatever|all|what)\b(?:\s+\w+){0,3}?\s+\b(?:said|told|came|wrote|instructed|given|above|before|earlier|previously|prior)\b/,
    suggestion:
      'A paraphrased instruction override is still an instruction override. Drop the document.'
  },
  {
    // The corpus is half non-English. An override written in Spanish, Portuguese,
    // French, German or Italian is the same attack and used to pass clean.
    // Fires on a non-English VERB with any instruction noun, or any verb with a
    // non-English instruction NOUN - so plain English stays with the anchored
    // rule above and does not lose its false-positive protection.
    id: 'injection.instruction-override-nonenglish',
    severity: SEVERITY.HIGH,
    re: /\b(?:(?:ignora|ignore[nz]|ignorez|ignorier\w*|olvid\w+|esquec\w+|esqueca|oubli\w+|dimentic\w+|negeer|vergiss|vergessen|desconsider\w+|desatend\w+)\b(?:\s+\w+){0,4}?\s+\b(?:instruc\w+|instruction\w*|anweisung\w*|istruzion\w*|regla\w*|regra\w*|regeln?|regole|befehl\w*|prompt\w*)|(?:ignore|ignora|disregard|forget|olvida|oublie)\b(?:\s+\w+){0,4}?\s+\b(?:instrucciones|instrucoes|instrucao|instruccion|anweisungen|istruzioni|reglas|regras|regeln|regole)\b)/,
    suggestion:
      'An instruction override in another language is an instruction override. Drop the document.'
  },
  {
    id: 'injection.persona-escape',
    severity: SEVERITY.CRITICAL,
    re: /\b(?:you are (?:now|no longer)|from now on you|you will now (?:act|behave|respond)|act as (?:an?|the)?\s*(?:ai|assistant|model|agent|dan|admin|administrator|system|developer|expert|unrestricted|unfiltered|uncensored|chatbot)|pretend (?:to be|you are)|role\s?play as|simulate being|enter (?:developer|debug|god|dan) mode|(?:developer|dan|jailbreak) mode|jailbreak)\b/,
    suggestion: 'Untrusted content tried to reassign the model a persona. Drop the document.'
  },
  {
    id: 'injection.agent-directive',
    severity: SEVERITY.HIGH,
    re: /\b(?:you (?:must|should|shall|will|need to|are required to|have to)|do not (?:tell|inform|mention|reveal|report|log)|never (?:tell|mention|reveal|log)|always (?:respond|reply|answer|output|return)|respond only with|reply only with|answer only with|output the following|print the following|return the following|say exactly|word for word|set the (?:field|value|category|status|flag)|mark (?:this|it) as|classify (?:this|it) as|label (?:this|it) as|treat (?:this|it) as|rate (?:this|it) as)\b/,
    suggestion:
      'Instruction-shaped text inside an article body is an injection attempt, not content.',
    // Scraped pages are full of consent/JS boilerplate that begins "you must".
    // Suppressing those is what keeps this rule usable on real web data.
    except:
      /\byou (?:must|should|need to|have to)\s+(?:\w+\s+){0,2}(?:enable|allow|accept|update|login|log in|sign in|register|subscribe|upgrade|verify your email|javascript|cookies|browser|be logged)\b/
  },
  {
    id: 'injection.exfiltration',
    severity: SEVERITY.CRITICAL,
    re: /\b(?:reveal|show|print|repeat|output|display|disclose|leak|dump|forward|email|post|upload|send|paste|copy|share|transmit)\b(?:\s+\w+){0,4}?\s+\b(?:system prompt|your prompt|your instructions|your rules|your guidelines|the prompt above|everything above|the text above|api key|secret key|access token|credentials|environment variables)\b/,
    suggestion:
      'Untrusted content asked for the system prompt or credentials. Drop the document and keep the incident.'
  },
  {
    id: 'injection.tool-abuse',
    severity: SEVERITY.CRITICAL,
    re: /\b(?:call(?:ing)? the (?:\w+ ){0,3}(?:tool|function|api)|use the (?:\w+ ){0,3}tool|invoke the (?:\w+ ){0,3}(?:tool|function)|execute the following|run the following|run this (?:command|code|script)|eval this|open the url|fetch the url|make a (?:request|post) to|send (?:the|all|this) (?:data|results|reports|list) to)\b/,
    suggestion:
      'Untrusted content tried to drive tool use. Drop the document; tool selection is never content-controlled.'
  },
  {
    id: 'injection.forged-authority',
    severity: SEVERITY.HIGH,
    re: /\b(?:system override|admin(?:istrator)? override|security override|priority override|this (?:message|instruction) is from (?:the )?(?:system|developer|operator|admin|anthropic|openai)|authoriz?ed by (?:the )?(?:system|developer|admin|anthropic|openai)|new system message|updated system prompt|end of (?:user )?(?:input|document) new instructions|you (?:have been|are) granted (?:full )?(?:permission|access|authority))\b/,
    suggestion:
      'Untrusted content claimed operator authority. Authority never arrives inside scraped text.'
  },
  {
    id: 'injection.output-shaping',
    severity: SEVERITY.HIGH,
    re: /\b(?:add (?:a )?(?:dispatch|recommendation|assignment) (?:field|key|line)|include (?:the )?(?:phrase|text|sentence|field)|append to your (?:answer|output|json)|in your json (?:add|include|set)|set confidence to)\b/,
    suggestion: 'Untrusted content tried to shape the output schema. Drop the document.'
  }
];

// ---------------------------------------------------------------------------
// Rules that run on the RAW text, because the evidence IS the punctuation:
// chat-template tokens, role markers at line starts, markup, invisible chars.
// ---------------------------------------------------------------------------

/** Chat-template / turn-boundary tokens. Nothing legitimate emits these. */
const TEMPLATE_TOKENS = [
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<|system|>',
  '<|user|>',
  '<|assistant|>',
  '<|eot_id|>',
  '<|start_header_id|>',
  '[INST]',
  '[/INST]',
  '<<SYS>>',
  '<</SYS>>',
  '### Instruction:',
  '### System:',
  '### Response:',
  '<system>',
  '</system>',
  '<|channel|>',
  '<|message|>'
];

const ROLE_MARKER_RE =
  /^[ \t>#*\-•]{0,6}(system|assistant|user|human|ai|developer|admin|root|instruction|instructions|prompt)\s*[:：]/gim;

/** Confirms a role marker is addressing a model rather than labelling prose. */
const ROLE_CONFIRM_RE =
  /\b(you|your|ignore|disregard|must|always|never|respond|reply|output|print|return|say|act|classify|mark|set|from now on|do not|forget|override|instruction)\b/i;

const HIDDEN_INSTRUCTION_RE =
  /\b(ignore|disregard|forget|you must|you are|act as|system prompt|respond|reply|output|classify|instructions?|prompt)\b/i;

const BASE64_BLOB_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;
const DECODE_CONTEXT_RE =
  /\b(base64|b64|decode|atob|decrypt|rot13|obfuscat|encoded (?:instruction|prompt|message)|following string)\b/i;

function scanTemplateTokens(raw, out) {
  const lower = raw.toLowerCase();
  for (const token of TEMPLATE_TOKENS) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(token.toLowerCase(), from);
      if (idx === -1) break;
      out.push(
        violation({
          rule: 'injection.chat-template-token',
          severity: SEVERITY.CRITICAL,
          matched: token,
          span: { start: idx, end: idx + token.length },
          suggestion:
            'A chat-template token inside scraped content is a forged turn boundary. Drop the document.',
          pass: 'raw',
          evidence: { token }
        })
      );
      from = idx + token.length;
    }
  }
}

function scanRoleMarkers(raw, out) {
  ROLE_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = ROLE_MARKER_RE.exec(raw)) !== null) {
    const role = m[1].toLowerCase();
    const rest = raw.slice(m.index + m[0].length, m.index + m[0].length + 160);
    // "Instructions:" heads plenty of honest civil-defence copy, and a news
    // sentence can start "System:". A role marker only counts as an injection
    // when what follows it is actually addressed to a model.
    if (!ROLE_CONFIRM_RE.test(rest)) continue;
    out.push(
      violation({
        rule: 'injection.role-marker',
        severity: SEVERITY.CRITICAL,
        matched: clip(`${m[0]}${rest.slice(0, 60)}`),
        span: { start: m.index, end: m.index + m[0].length },
        suggestion:
          'Scraped text tried to open a new conversational turn. Roles are set by this codebase, never by content.',
        pass: 'raw',
        evidence: { role }
      })
    );
  }
}

function scanInvisibleCharacters(raw, out) {
  let zeroWidth = 0;
  let bidi = 0;
  let firstIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (INVISIBLE_CHARS.has(ch)) {
      zeroWidth++;
      if (firstIdx === -1) firstIdx = i;
    } else if (BIDI_CONTROL_CHARS.has(ch)) {
      bidi++;
      if (firstIdx === -1) firstIdx = i;
    }
  }
  const tagMatch = TAG_CHAR_RE.exec(raw);
  if (!zeroWidth && !bidi && !tagMatch) return;

  const start = firstIdx !== -1 ? firstIdx : tagMatch.index;
  out.push(
    violation({
      rule: 'injection.invisible-characters',
      severity: SEVERITY.HIGH,
      matched: `${zeroWidth} zero-width, ${bidi} bidi-control, ${tagMatch ? 'tag chars present' : 'no tag chars'}`,
      span: { start, end: start + 1 },
      suggestion:
        'Invisible characters carry text a reviewer cannot see. Drop the document rather than stripping them silently.',
      pass: 'raw',
      evidence: { zeroWidth, bidi, tagChars: Boolean(tagMatch) }
    })
  );
}

function scanHiddenMarkup(raw, out) {
  const COMMENT_RE = /<!--([\s\S]{0,4000}?)-->/g;
  let m;
  while ((m = COMMENT_RE.exec(raw)) !== null) {
    if (!HIDDEN_INSTRUCTION_RE.test(m[1])) continue;
    out.push(
      violation({
        rule: 'injection.hidden-markup',
        severity: SEVERITY.HIGH,
        matched: clip(m[0]),
        span: { start: m.index, end: m.index + m[0].length },
        suggestion: 'Instruction text hidden in an HTML comment. Drop the document.',
        pass: 'raw',
        evidence: { carrier: 'html-comment' }
      })
    );
  }

  const HIDDEN_STYLE_RE =
    /<([a-z]+)\b[^>]*(?:style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0)[^"']*["']|hidden\b|aria-hidden\s*=\s*["']true["'])[^>]*>([\s\S]{0,1000}?)<\/\1>/gi;
  while ((m = HIDDEN_STYLE_RE.exec(raw)) !== null) {
    if (!HIDDEN_INSTRUCTION_RE.test(m[2])) continue;
    out.push(
      violation({
        rule: 'injection.hidden-markup',
        severity: SEVERITY.HIGH,
        matched: clip(m[0]),
        span: { start: m.index, end: m.index + m[0].length },
        suggestion: 'Instruction text hidden behind CSS. Drop the document.',
        pass: 'raw',
        evidence: { carrier: 'hidden-element', tag: m[1] }
      })
    );
  }
}

function scanEncodedPayload(raw, out) {
  BASE64_BLOB_RE.lastIndex = 0;
  let m;
  while ((m = BASE64_BLOB_RE.exec(raw)) !== null) {
    // A base64 blob on its own is usually an image or a tracking token. It only
    // becomes evidence when something nearby is telling a reader to decode it.
    const context = raw.slice(Math.max(0, m.index - 120), m.index + m[0].length + 60);
    if (!DECODE_CONTEXT_RE.test(context)) continue;
    out.push(
      violation({
        rule: 'injection.encoded-payload',
        severity: SEVERITY.HIGH,
        matched: clip(m[0], 60),
        span: { start: m.index, end: m.index + m[0].length },
        suggestion:
          'An encoded blob presented for decoding is a payload, not content. Drop the document.',
        pass: 'raw',
        evidence: { length: m[0].length }
      })
    );
  }
}

// ---------------------------------------------------------------------------
// DEVANAGARI. Half this corpus is written in it, and until the tokenizer was
// widened (see text.js) not one of the rules above could see a single character
// of it - a Nepali injection reached the live model past guardInput. Nepali
// inflects with suffixes rather than word forms, so these are STEM pairs over
// the raw text: an override/exfiltration stem within one window of an
// instruction noun. Deliberately narrow; the coverage advisory below reports
// what it does not reach.
// ---------------------------------------------------------------------------

const NE_OVERRIDE_STEMS = [
  'बेवास्ता',
  'बेवास्ता',
  'नजरअन्दाज',
  'अनदेखा',
  'बिर्स',
  'भुल',
  'रद्द',
  'उल्लङ्घन',
  'खारेज'
];

const NE_INSTRUCTION_NOUNS = [
  'निर्देशन',
  'निर्देशिका',
  'नियम',
  'आदेश',
  'प्रम्प्ट',
  'प्रोम्प्ट',
  'सिस्टम',
  'प्रणाली',
  'हुकुम'
];

/** "you are now ...", "from now on you ..." - persona reassignment in Nepali. */
const NE_PERSONA = ['तिमी अब', 'तपाईं अब', 'अबदेखि तिमी', 'अबदेखि तपाईं', 'अब तिमी'];

const NE_WINDOW = 70;

function scanDevanagariInjection(raw, out) {
  const text = String(raw || '');
  for (const stem of NE_OVERRIDE_STEMS) {
    const idx = text.indexOf(stem);
    if (idx === -1) continue;
    const lo = Math.max(0, idx - NE_WINDOW);
    const hi = Math.min(text.length, idx + stem.length + NE_WINDOW);
    const window = text.slice(lo, hi);
    const noun = NE_INSTRUCTION_NOUNS.find((n) => window.includes(n));
    if (!noun) continue;
    out.push(
      violation({
        rule: 'injection.instruction-override',
        severity: SEVERITY.CRITICAL,
        matched: clip(window),
        span: { start: lo, end: hi },
        suggestion:
          'Untrusted content tried to rewrite the task, in Devanagari. Drop the document; do not show it to the model.',
        pass: 'raw',
        evidence: { script: 'devanagari', stem, noun }
      })
    );
    break;
  }

  for (const phrase of NE_PERSONA) {
    const idx = text.indexOf(phrase);
    if (idx === -1) continue;
    out.push(
      violation({
        rule: 'injection.persona-escape',
        severity: SEVERITY.CRITICAL,
        matched: clip(text.slice(idx, idx + NE_WINDOW)),
        span: { start: idx, end: Math.min(text.length, idx + phrase.length) },
        suggestion:
          'Untrusted content tried to reassign the model a persona, in Devanagari. Drop the document.',
        pass: 'raw',
        evidence: { script: 'devanagari', phrase }
      })
    );
    break;
  }
}

/**
 * COVERAGE, not detection. Everything above is Latin-script English plus the
 * small Devanagari set. Any other script tokenizes and then matches nothing, so
 * say so: an unscannable document must be visibly unscanned rather than
 * invisibly passed. Advisory - it records, it does not block.
 */
const COVERED_SCRIPTS = ['latin', 'devanagari'];

function scanUnscannedScript(raw, out) {
  for (const u of uncoveredScripts(raw, { covered: COVERED_SCRIPTS })) {
    const span = firstScriptSpan(raw, u.script);
    out.push(
      violation({
        rule: 'injection.unscanned-script',
        severity: SEVERITY.ADVISORY,
        matched: clip(span.text || u.script, 60),
        span,
        suggestion:
          `${u.chars} characters of ${u.script} script (${Math.round(u.share * 100)}% of the text). ` +
          'The injection vocabulary covers Latin and Devanagari only, so this text was NOT scanned for prompt injection. ' +
          'Treat it as unchecked, not as clean.',
        pass: 'raw',
        evidence: { script: u.script, chars: u.chars, share: u.share, covered: COVERED_SCRIPTS }
      })
    );
  }
}

// --- entry point -----------------------------------------------------------

export const INJECTION_RULES = [
  ...STREAM_RULES.map((r) => r.id),
  'injection.chat-template-token',
  'injection.role-marker',
  'injection.invisible-characters',
  'injection.hidden-markup',
  'injection.encoded-payload',
  'injection.unscanned-script'
];

/**
 * Scan UNTRUSTED content (scraped article bodies, titles, social posts) for
 * prompt-injection attempts, BEFORE any of it reaches a model.
 *
 * @param {string} text
 * @param {{stage?: string, sourceName?: string}} [options]
 * @returns {object} verdict - see verdict.js. NEVER a bare boolean.
 */
export function checkInjection(text, options = {}) {
  const stage = options.stage || 'input';
  try {
    const raw = String(text ?? '');
    // One deobfuscated stream is enough here: unlike dispatch language, there is
    // no such thing as a "legitimate but obfuscated" injection phrase, so the
    // plain pass would only produce duplicates.
    const scan = makeScan(raw, { deobfuscate: true });
    const violations = [];

    for (const rule of STREAM_RULES) {
      for (const stream of scan.streams) {
        const re = new RegExp(rule.re.source, `${rule.re.flags.replace('g', '')}g`);
        let m;
        while ((m = re.exec(stream.text)) !== null) {
          if (m[0].length === 0) break;
          if (rule.except && rule.except.test(stream.text.slice(m.index, m.index + 120))) continue;
          const span = stream.spanFor(m.index, m.index + m[0].length);
          const asWritten = span.text
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N} ]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          violations.push(
            violation({
              rule: rule.id,
              severity: rule.severity,
              matched: clip(span.text || m[0]),
              span,
              suggestion: rule.suggestion,
              obfuscated: asWritten !== m[0],
              pass: `deobfuscated/${stream.name}`,
              evidence: { normalized: clip(m[0]), stream: stream.name }
            })
          );
        }
      }
    }

    scanTemplateTokens(raw, violations);
    scanRoleMarkers(raw, violations);
    scanInvisibleCharacters(raw, violations);
    scanHiddenMarkup(raw, violations);
    scanEncodedPayload(raw, violations);
    scanDevanagariInjection(raw, violations);
    scanUnscannedScript(raw, violations);

    return makeVerdict({
      stage,
      checks: ['injection'],
      violations,
      suppressed: [],
      stats: {
        chars: raw.length,
        tokens: scan.tokens.length,
        sourceName: options.sourceName || null
      }
    });
  } catch (err) {
    return internalErrorVerdict(stage, err, ['injection']);
  }
}

export default checkInjection;
