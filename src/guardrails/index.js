// Signal Zero - GUARDRAILS / entry point
// ---------------------------------------------------------------------------
// One door in, one verdict out.
//
//   guardInput(text, ctx)   scraped/untrusted text, BEFORE the model sees it
//   guardOutput(value, ctx) model-produced text, BEFORE it is accepted
//
// Both return the same verdict object:
//
//   { ok, blocked, stage, checks, violations:[{rule,severity,matched,span,
//     suggestion,...}], suppressed, stats }
//
// THE CONTRACT THE CALLER MUST HONOUR:
//   * On `blocked`, the output is DROPPED. It is not repaired, not truncated,
//     not "cleaned up until it passes". A guardrail that rewrites hostile text
//     into something that reads clean has destroyed the only evidence that
//     anything happened.
//   * Every block records an incident on the fail feed. Silent enforcement is
//     indistinguishable from no enforcement to the person who has to trust
//     this thing at 3am.
//   * If the guardrail itself throws, it fails CLOSED (see verdict.js). Text
//     that could not be checked is not text that passed.
//
// WHY THE TWO STAGES CHECK DIFFERENT THINGS:
//   input  -> injection only. A news article that says "the army deployed teams
//             to Rasuwa" is legitimate reporting and must ingest cleanly.
//   output -> no-dispatch + honest-unknown. In the system's own voice, that
//             same sentence is a hard-rule violation.
// ---------------------------------------------------------------------------

import { addIncident } from '../store.js';

import { checkNoDispatch, NO_DISPATCH_RULES } from './no-dispatch.js';
import { checkHonestUnknown, HONEST_UNKNOWN_RULES } from './honest-unknown.js';
import { checkInjection, INJECTION_RULES } from './injection.js';
import { SEVERITY, makeVerdict, internalErrorVerdict, severityRank } from './verdict.js';
import { clip } from './text.js';

export { SEVERITY };
export { checkNoDispatch, checkHonestUnknown, checkInjection };

/**
 * Guardrail blocks are filed under an EXISTING incident kind rather than a new
 * one. web/lib.js owns the kind -> glyph/label table and this layer is not
 * allowed to edit web/, so inventing 'guardrail-block' would render as a
 * generic dot. 'degraded-source' is already wired into both the incident feed
 * and the pipeline filter, so a block is visible in the UI the moment it
 * happens. detail.component === 'guardrail' identifies it precisely.
 */
export const GUARDRAIL_INCIDENT_KIND = 'degraded-source';

/** Every rule id this layer can emit. Used by tests and by the README. */
export const ALL_RULES = [
  ...NO_DISPATCH_RULES,
  ...HONEST_UNKNOWN_RULES,
  ...INJECTION_RULES,
  'guardrail.internal-error'
];

// ---------------------------------------------------------------------------
// Text extraction. Tier 3 hands us an object, not a string; a page hands us a
// string. Both must be scannable, and the object must be flattened WITHOUT
// dropping the model-authored fields (which are the only ones that can carry a
// violation).
// ---------------------------------------------------------------------------

/**
 * Fields whose contents get QUOTED FIRST in a violation, because they are the
 * ones an operator recognises. This list decides what a finding quotes. It does
 * NOT decide what gets scanned - see below.
 */
const MODEL_AUTHORED_FIELDS = [
  'category', 'settlementId', 'why', 'whyFull', 'rationale', 'text', 'message',
  'matchedOn', 'note', 'summary', 'rawModelText'
];

/**
 * Flatten a value into something a rule can scan.
 *
 * THE DEFAULT IS "SCAN EVERYTHING". This used to walk a whitelist and, when it
 * matched anything at all, return ONLY those fields - so `rationale` and
 * `evidence`, which are the REGISTERED agent's own contract field names, were
 * never scanned. The real path happened to be safe because parseTier3 renames
 * `rationale` -> `why` before the guardrail runs, i.e. the guarantee rested on a
 * rename documented in a comment. A guardrail that scans a subset by default
 * fails open on the next schema change, so the whitelist now only PRIORITISES;
 * the serialized whole is always appended.
 */
export function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);

  const parts = [];
  for (const key of MODEL_AUTHORED_FIELDS) {
    const v = value[key];
    if (typeof v === 'string' && v) parts.push(`${key}: ${v}`);
  }

  // ALWAYS, whether or not anything above matched. Everything the object holds -
  // nested objects, arrays, fields nobody has thought of yet - gets scanned.
  let whole;
  try {
    whole = JSON.stringify(value);
  } catch {
    whole = String(value);
  }
  if (whole) parts.push(whole);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Verdict merging
// ---------------------------------------------------------------------------

function merge(stage, verdicts, stats = {}) {
  return makeVerdict({
    stage,
    checks: verdicts.flatMap((v) => v.checks),
    violations: verdicts.flatMap((v) => v.violations),
    suppressed: verdicts.flatMap((v) => v.suppressed || []),
    stats
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Guard UNTRUSTED input before a model ever sees it.
 *
 * @param {string|object} value  scraped title/body/social post
 * @param {{sourceName?: string, reportId?: string}} [context]
 */
export function guardInput(value, context = {}) {
  try {
    const text = textOf(value);
    const injection = checkInjection(text, { stage: 'input', sourceName: context.sourceName });
    return merge('input', [injection], {
      chars: text.length,
      reportId: context.reportId || null,
      sourceName: context.sourceName || null
    });
  } catch (err) {
    return internalErrorVerdict('input', err, ['injection']);
  }
}

/**
 * Guard MODEL-PRODUCED output before it is accepted into the pipeline.
 *
 * @param {string|object} value  a string, or the parsed tier-3 result
 * @param {{coverageBasis?: string|null, reportId?: string, executor?: string}} [context]
 */
export function guardOutput(value, context = {}) {
  try {
    const text = textOf(value);
    const dispatch = checkNoDispatch(text, { stage: 'output' });
    const honest = checkHonestUnknown(text, {
      stage: 'output',
      coverageBasis: context.coverageBasis || null
    });
    return merge('output', [dispatch, honest], {
      chars: text.length,
      reportId: context.reportId || null,
      executor: context.executor || null,
      coverageBasis: context.coverageBasis || null
    });
  } catch (err) {
    return internalErrorVerdict('output', err, ['no-dispatch', 'honest-unknown']);
  }
}

/** Generic form, for callers that carry the stage in data. */
export function guard({ stage = 'output', text, context = {} } = {}) {
  return stage === 'input' ? guardInput(text, context) : guardOutput(text, context);
}

/** The worst severity present, or null. */
export function worstSeverity(verdict) {
  if (!verdict || !verdict.violations.length) return null;
  return verdict.violations.reduce(
    (worst, v) => (severityRank(v.severity) > severityRank(worst) ? v.severity : worst),
    SEVERITY.ADVISORY
  );
}

/** One line an operator can read in the fail feed without opening anything. */
export function describeVerdict(verdict) {
  if (!verdict || verdict.ok) return 'no guardrail violation';
  const top = verdict.violations[0];
  const extra = verdict.violations.length > 1 ? ` (+${verdict.violations.length - 1} more)` : '';
  return `${top.rule} [${top.severity}] on "${clip(top.matched, 80)}"${extra}`;
}

// ---------------------------------------------------------------------------
// Enforcement helper.
//
// Lives here rather than in triage.js so the wiring into the pipeline stays one
// import and two call sites. It does three things and refuses to do a fourth:
//   1. writes a VISIBLE incident
//   2. forces the report back to UNRESOLVED (never a half-accepted answer)
//   3. attaches the verdict to the report so the UI can show WHY
// It never edits the offending text.
// ---------------------------------------------------------------------------

/**
 * @param {object} report   the Report being triaged (mutated)
 * @param {object} verdict  from guardInput/guardOutput
 * @param {object} [extra]  {label, phase, executor, ...} for the incident detail
 * @returns {object} the incident that was recorded
 */
export function blockAndRecord(report, verdict, extra = {}) {
  const phase = extra.phase || verdict.stage;
  const label = clip(extra.label || (report && (report.title || report.id)) || 'report', 60);
  const summary = describeVerdict(verdict);

  const message =
    phase === 'input'
      ? `GUARDRAIL BLOCK (input): scraped content for "${label}" contains a prompt-injection attempt - ${summary}. It was NOT shown to the model; the report is left UNRESOLVED.`
      : `GUARDRAIL BLOCK (output): tier-3 output for "${label}" broke a hard rule - ${summary}. The classification was DISCARDED, not rewritten; the report is left UNRESOLVED.`;

  const incident = addIncident(GUARDRAIL_INCIDENT_KIND, message, {
    component: 'guardrail',
    stage: 'triage',
    tier: 3,
    phase,
    reportId: report ? report.id : null,
    sourceName: report ? report.sourceName : null,
    executor: extra.executor || 'none',
    resolved: false,
    blocked: true,
    rules: verdict.violations.map((v) => v.rule),
    violations: verdict.violations.map((v) => ({
      rule: v.rule,
      severity: v.severity,
      matched: v.matched,
      span: v.span,
      suggestion: v.suggestion,
      obfuscated: v.obfuscated
    })),
    suppressed: verdict.suppressed
  });

  if (report) {
    report.settlementId = null;
    report.triage = {
      ...(report.triage || {}),
      tier: 3,
      confidence: 0.3,
      matchedOn: null,
      executor: 'none',
      guardrail: {
        phase,
        blocked: true,
        rules: verdict.violations.map((v) => v.rule),
        severity: worstSeverity(verdict),
        summary
      }
    };
  }

  return incident;
}

export default { guardInput, guardOutput, guard, blockAndRecord, describeVerdict, ALL_RULES };
