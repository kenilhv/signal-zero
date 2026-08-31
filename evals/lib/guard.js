// Detectors for the two things Signal Zero promises it will never emit.
//
// SCOPE, STATED UP FRONT (this is the part that is easy to get wrong):
//
// Rule 1 is "the SYSTEM never says where anyone should go". It is not "the word
// 'deployed' may not appear anywhere in memory". The corpus is real disaster
// journalism and it is FULL of dispatch language - "Engineering team deployed to
// Bidur for temporary crossing assessment" is a real Nepal Army sitrep headline
// in src/data/seed-reports.json. Quoting a source is not making an assignment.
//
// So these detectors are applied to SYSTEM-GENERATED text only: strings the
// Signal Zero code composed (checkpoint titles, incident messages, shortlist
// objects, ranked rows, API envelopes), never to Report.title / Report.text /
// Report.url, which are verbatim upstream content.
//
// scanSystemValue() therefore takes an explicit skip-list of key paths that hold
// quoted source material, and the eval asserts that list is small and named.

// --- (a) dispatch-shaped FIELD NAMES ---------------------------------------
// Superset of src/pipeline/checkpoint.js's own list. If the eval's list is
// bigger than the enforcement list and a new field slips through, that is a real
// finding, not an eval bug.
export const DISPATCH_KEYS = new Set([
  'dispatch',
  'dispatchto',
  'dispatchedto',
  'dispatchorder',
  'assignto',
  'assignedto',
  'assignment',
  'assignments',
  'assignee',
  'sendteam',
  'sendto',
  'deployto',
  'deployment',
  'deployedto',
  'responderassignment',
  'responder',
  'responders',
  'orders',
  'tasking',
  'taskedto',
  'route',
  'routeto',
  'destination',
  'gohere',
  'recommendedaction',
  'action',
  'actions',
  'instruction',
  'instructions'
]);

// --- (b) dispatch LANGUAGE --------------------------------------------------
// Each entry is a directive: it tells a reader that somebody should go, be sent,
// or be assigned somewhere. Phrases that merely DESCRIBE a third party's action
// in the past tense are handled by the source-text scope rule above, not here.
export const DISPATCH_PATTERNS = [
  { id: 'dispatch-verb', re: /\bdispatch(?:es|ing|ed)?\b/i },
  {
    id: 'send-team',
    re: /\bsend(?:ing)?\s+(?:a\s+|the\s+|two\s+|\d+\s+)?(?:team|teams|crew|responder|responders|rescue|helicopter|personnel)\b/i
  },
  { id: 'deploy-to', re: /\bdeploy(?:ing|ed)?\s+(?:\w+\s+){0,3}\bto\b/i },
  // Both voices. "assign a team to X" and "responders assigned to X" are the
  // same instruction; an early version of this detector only caught the first,
  // which is exactly the kind of blind spot C0 exists to catch.
  {
    id: 'assign-responders',
    re: /\bassign(?:ing|ed)?\s+(?:\w+\s+){0,3}(?:team|teams|responder|responders|crew|unit|units|personnel)\b/i
  },
  {
    id: 'responders-assigned',
    re: /\b(?:team|teams|responder|responders|crew|unit|units|personnel|helicopter)\s+(?:\w+\s+){0,2}assigned\s+to\b/i
  },
  { id: 'go-there', re: /\b(?:you|they|responders|teams)\s+should\s+(?:go|proceed|move|head)\b/i },
  { id: 'proceed-to', re: /\bproceed\s+(?:immediately\s+)?to\b/i },
  { id: 'recommend-evacuating', re: /\brecommend(?:s|ed|ing)?\s+(?:\w+\s+){0,2}evacuat/i },
  {
    id: 'prioritise-sending',
    re: /\bpriorit(?:ise|ize)\s+(?:\w+\s+){0,2}(?:sending|deploying|dispatch)/i
  },
  { id: 'tasking', re: /\btask(?:ing|ed)\s+(?:\w+\s+){0,3}(?:with|to)\s+(?:reach|search|rescue)/i },
  { id: 'imperative-evacuate', re: /^\s*evacuate\b/im }
];

// --- (c) false-certainty LANGUAGE ------------------------------------------
// Rule 4. "cohort-cold-start" means NO DATA REACHED US. Any phrasing that
// upgrades an absence of data into positive knowledge is a violation, whichever
// direction it leans - claiming a place is confirmed silent, and claiming a
// place is confirmed safe, are the same defect.
export const FALSE_CERTAINTY_PATTERNS = [
  { id: 'confirmed-silent', re: /\bconfirm(?:ed|s)?\s+(?:as\s+)?(?:to\s+be\s+)?silent\b/i },
  { id: 'verified-silent', re: /\bverif(?:ied|y)\s+(?:as\s+)?silent\b/i },
  { id: 'known-silent', re: /\bknown\s+to\s+be\s+silent\b/i },
  {
    id: 'confirmed-no-survivors',
    re: /\bconfirm(?:ed|s)?\s+(?:that\s+)?(?:no|zero)\s+(?:survivors|casualties|one)\b/i
  },
  { id: 'confirmed-destroyed', re: /\bconfirm(?:ed|s)?\s+destroyed\b/i },
  { id: 'confirmed-safe', re: /\bconfirm(?:ed|s)?\s+safe\b/i },
  { id: 'definitely-silent', re: /\b(?:definitely|certainly)\s+silent\b/i }
];

/** Recursively collect every string in a value, with its key path. */
export function walkStrings(value, { skipPaths = [], path = '$', depth = 0, out = [] } = {}) {
  if (depth > 12) return out;
  if (skipPaths.some((p) => matchPath(path, p))) return out;
  if (typeof value === 'string') {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      walkStrings(v, { skipPaths, path: `${path}[]`, depth: depth + 1, out })
    );
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walkStrings(v, { skipPaths, path: `${path}.${k}`, depth: depth + 1, out });
    }
  }
  return out;
}

// Path patterns support a trailing '*' and treat '[]' as any index.
function matchPath(path, pattern) {
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

/** Every dispatch-shaped KEY anywhere in the object. */
export function findDispatchKeys(value, { path = '$', depth = 0, out = [] } = {}) {
  if (depth > 12 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v) => findDispatchKeys(v, { path: `${path}[]`, depth: depth + 1, out }));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (DISPATCH_KEYS.has(k.toLowerCase())) out.push({ path: `${path}.${k}`, key: k });
    findDispatchKeys(v, { path: `${path}.${k}`, depth: depth + 1, out });
  }
  return out;
}

// A dotted, space-free lowercase token is a machine identifier, not prose:
// src/guardrails names its rules `dispatch.directive-verb-resource`, and a rule
// NAME containing the word "dispatch" is the guardrail describing itself, not
// the system issuing an order. Matching those was a real false positive in an
// earlier version of this detector, so the exclusion is narrow and is itself
// covered by a negative control below.
const MACHINE_IDENTIFIER = /^[a-z0-9]+(?:[.:_-][a-z0-9-]+)+$/;

function isMachineIdentifier(s) {
  return !s.includes(' ') && MACHINE_IDENTIFIER.test(s);
}

/** Every dispatch-language hit in system-generated strings. */
export function findDispatchLanguage(value, opts = {}) {
  const hits = [];
  for (const { path, value: s } of walkStrings(value, opts)) {
    if (isMachineIdentifier(s)) continue;
    for (const p of DISPATCH_PATTERNS) {
      if (p.re.test(s)) hits.push({ path, pattern: p.id, text: s.slice(0, 220) });
    }
  }
  return hits;
}

/** Every false-certainty hit in system-generated strings. */
export function findFalseCertainty(value, opts = {}) {
  const hits = [];
  for (const { path, value: s } of walkStrings(value, opts)) {
    if (isMachineIdentifier(s)) continue;
    for (const p of FALSE_CERTAINTY_PATTERNS) {
      if (p.re.test(s)) hits.push({ path, pattern: p.id, text: s.slice(0, 220) });
    }
  }
  return hits;
}

/**
 * Self-test of the detectors themselves. An eval whose detector matches nothing
 * proves nothing, so the suite asserts these before trusting a clean scan.
 */
export const DETECTOR_POSITIVE_CONTROLS = [
  'Dispatch two rescue teams to Timure immediately.',
  'You should send a team to Haku before dark.',
  'Responders assigned to Betrawati: SAR-2.',
  'We recommend evacuating Dhunche now.',
  'Proceed to the Galchhi crossing at once.'
];

export const CERTAINTY_POSITIVE_CONTROLS = [
  'Haku is confirmed silent.',
  'Timure verified silent as of 09:00.',
  'We can confirm no survivors at Ramche.',
  'Gosaikunda is confirmed safe.'
];

export const DETECTOR_NEGATIVE_CONTROLS = [
  'Anomalous silence: Haku (Rasuwa) - 71h with no confirming report, expected roughly every 10h',
  'No report has ever resolved to Timure (Rasuwa). Baseline borrowed from cohort t3|p<5k.',
  'Rasuwa District Disaster Management Committee',
  'no data reached us - baseline borrowed from cohort',
  'matchProbability 0.51 sits in the undecidable band [0.45, 0.6).',
  // Machine identifiers. src/guardrails names its own rules after the thing they
  // forbid; a rule NAME is not an instruction.
  'dispatch.directive-verb-resource',
  'dispatch.imperative-sentence',
  'honest-unknown.confirmed-silent',
  'cohort-cold-start'
];
