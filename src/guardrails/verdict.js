// Signal Zero - GUARDRAILS / verdict shape
// ---------------------------------------------------------------------------
// One shape, used by every checker, so a caller never has to know which rule
// family fired to decide what to do.
//
//   {
//     ok:         boolean   - true only when NOTHING fired
//     blocked:    boolean   - true when at least one non-advisory rule fired
//     stage:      'input' | 'output'
//     checks:     string[]  - which checkers ran (so a silent skip is visible)
//     violations: [{ rule, severity, matched, span, suggestion, obfuscated,
//                    evidence }]
//     suppressed: [{ rule, reason, matched }]  - matches a guard deliberately
//                                                let through, kept so the
//                                                guard itself is auditable
//     stats:      { chars, tokens }
//   }
//
// `ok` and `blocked` are separate on purpose. An advisory violation must still
// be visible in the incident feed without killing a classification; a critical
// one must be impossible to ignore. Nothing here ever returns a bare boolean:
// a guardrail that answers "false" tells an operator nothing about what it saw.
// ---------------------------------------------------------------------------

export const SEVERITY = {
  CRITICAL: 'critical', // violates one of the four hard rules outright
  HIGH: 'high', // strongly indicative; block and let a human read it
  ADVISORY: 'advisory' // recorded, does not block
};

const ORDER = { critical: 3, high: 2, advisory: 1 };

export function severityRank(sev) {
  return ORDER[sev] || 0;
}

export function isBlocking(severity) {
  return severityRank(severity) >= ORDER.high;
}

/** Build one violation record. `span` is {start,end} into the ORIGINAL text. */
export function violation({
  rule,
  severity = SEVERITY.HIGH,
  matched = '',
  span = null,
  suggestion = '',
  evidence = null,
  obfuscated = false,
  pass = 'plain'
}) {
  return {
    rule,
    severity,
    matched,
    span: span ? { start: span.start, end: span.end } : null,
    suggestion,
    evidence,
    obfuscated: Boolean(obfuscated),
    pass
  };
}

/**
 * Drop duplicates produced by scanning the same text twice (plain +
 * deobfuscated). Same rule at the same place is one finding; the plain-pass
 * copy wins because it quotes the text as a human would read it.
 */
export function dedupeViolations(list) {
  const byKey = new Map();
  for (const v of list) {
    const key = `${v.rule}@${v.span ? v.span.start : 'x'}:${v.span ? v.span.end : 'x'}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, v);
      continue;
    }
    if (prev.obfuscated && !v.obfuscated) byKey.set(key, v);
  }
  return [...byKey.values()].sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity) return bySeverity;
    return (a.span ? a.span.start : 0) - (b.span ? b.span.start : 0);
  });
}

/** Assemble the final verdict from raw violation records. */
export function makeVerdict({
  stage = 'output',
  checks = [],
  violations = [],
  suppressed = [],
  stats = {}
}) {
  const deduped = dedupeViolations(violations);
  return {
    ok: deduped.length === 0,
    blocked: deduped.some((v) => isBlocking(v.severity)),
    stage,
    checks,
    violations: deduped,
    suppressed,
    stats
  };
}

/**
 * FAIL CLOSED. If a checker throws, the correct answer is not "looks fine" -
 * it is "this text was never actually checked, so it does not ship".
 */
export function internalErrorVerdict(stage, err, checks = []) {
  return makeVerdict({
    stage,
    checks,
    violations: [
      violation({
        rule: 'guardrail.internal-error',
        severity: SEVERITY.CRITICAL,
        matched: '',
        suggestion:
          'The guardrail itself failed, so this text is unverified. Fail closed: block it and fix the guardrail.',
        evidence: { error: String((err && err.message) || err) }
      })
    ]
  });
}
