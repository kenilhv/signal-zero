#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Signal Zero — repository gate. Audits a diff against the four hard rules.
//
// WHY THIS EXISTS
// ---------------
// `signal-zero-auditor` was registered on TrueForge and nothing invoked it. A
// registered agent that no call path reaches is a roster entry, not a control.
// This script puts it on a real call path: it reads a diff and asks the auditor
// whether the change breaches one of the four rules that ARE the product.
//
//   RULE 1  No dispatch. Never say where anyone should go. No dispatch-shaped
//           field anywhere, and no dispatch-shaped copy either.
//   RULE 2  Nothing actionable without a NAMED human. `approvedBy` may never be
//           defaulted to a system name, an agent name or a placeholder.
//   RULE 3  Zero LLM in dedup scoring or ranking math. Deterministic, auditable.
//   RULE 4  Honest unknowns. `cohort-cold-start` means NO DATA REACHED US. It
//           never means "confirmed silent".
//
// TWO LAYERS, IN THIS ORDER — the cheap one first
// -----------------------------------------------
//   STAGE 1  A deterministic grep over the ADDED lines of the diff. No model, no
//            network, ~10ms. Every finding it makes carries a verbatim quote by
//            construction, because it IS the matched line. This is the line of
//            defence. It runs first and it gates on its own.
//   STAGE 2  `signal-zero-auditor`, bound BY NAME on TrueForge, as a SECOND
//            OPINION over the same diff — it catches the semantic breaches a
//            regex cannot see (copy that means "go there" without using any of
//            the banned verbs; an LLM reached through a helper import).
//
// Stage 2 is not permitted to be the only thing standing between a dispatch
// field and `main`. If TrueForge is down, stage 1 still gates.
//
// HOW IT DEGRADES, AND WHY THAT SHAPE
// -----------------------------------
// A gate that fails closed on infrastructure is a gate people disable, and a
// disabled gate protects nothing. So:
//
//   * TrueForge unreachable / agent unregistered / turn errored / output not
//     parseable  ->  loud WARNING, no model opinion recorded, exit code comes
//     from stage 1 alone.
//   * The diff was too large and had to be truncated  ->  said out loud, in the
//     report, with the byte counts. A partial audit is never printed as a clean
//     one.
//   * A model finding whose `quote` cannot be located in the diff is printed in
//     full and labelled UNVERIFIED, and it does NOT set the exit code. Blocking
//     a commit on a quote the model invented is the same failure mode as
//     blocking it on a dead container.
//
// Only these gate the exit code:
//   - any stage-1 finding at severity `critical`
//   - any stage-2 finding at severity `critical` WHOSE QUOTE IS IN THE DIFF
//
// THIS SCRIPT NEVER EDITS CODE. It reads a diff and prints a report.
//
// USAGE
//   node scripts/audit-diff.mjs                  staged changes, else HEAD~1..HEAD
//   node scripts/audit-diff.mjs --worktree       unstaged working-tree changes
//   node scripts/audit-diff.mjs HEAD~3..HEAD     an explicit ref range
//   node scripts/audit-diff.mjs --range=main...HEAD
//   node scripts/audit-diff.mjs --file=patch.diff   audit a patch file directly
//   node scripts/audit-diff.mjs --no-model       stage 1 only, no TrueForge
//   node scripts/audit-diff.mjs --json           machine-readable report on stdout
//   node scripts/audit-diff.mjs --max-bytes=90000
//
// EXIT CODES
//   0  no gating critical finding (may still have printed warnings)
//   1  at least one gating critical finding — the diff breaches a hard rule
//   2  the script could not run at all (not a git repo, bad arguments)
//
// AS A PRE-COMMIT HOOK
//   printf '#!/bin/sh\nexec node scripts/audit-diff.mjs\n' > .git/hooks/pre-commit
//   chmod +x .git/hooks/pre-commit
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = (process.env.TRUEFORGE_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
const AGENT = process.env.SIGNAL_ZERO_AUDITOR_AGENT || 'signal-zero-auditor';

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_CANNOT_RUN = 2;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    range: null,
    worktree: false,
    file: null,
    useModel: true,
    json: false,
    maxBytes: 60000,
    strict: false,
    probeMs: 2500,
    timeoutMs: 240000
  };
  for (const a of argv) {
    if (a === '--worktree') opts.worktree = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-model') opts.useModel = false;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--range=')) opts.range = a.slice(8);
    else if (a.startsWith('--file=')) opts.file = a.slice(7);
    else if (a.startsWith('--max-bytes=')) opts.maxBytes = Number(a.slice(12));
    else if (a.startsWith('--timeout=')) opts.timeoutMs = Number(a.slice(10));
    else if (a.startsWith('--')) fatal(`unknown flag: ${a}`);
    else opts.range = a; // positional ref range
  }
  if (!Number.isFinite(opts.maxBytes) || opts.maxBytes < 1000) fatal('--max-bytes must be >= 1000');
  return opts;
}

function fatal(msg) {
  console.error(`audit-diff: ${msg}`);
  process.exit(EXIT_CANNOT_RUN);
}

// ---------------------------------------------------------------------------
// Getting the diff
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Resolve what we are auditing. Returns { diff, source } where `source` is the
 * human-readable description printed in the report header — the report must
 * always say WHICH diff it looked at, or a clean result means nothing.
 */
function collectDiff(opts) {
  // Unified diff with zero rename detection noise; 3 lines of context is enough
  // to give the model somewhere to stand without inflating the payload.
  const common = ['--no-color', '--no-ext-diff', '-U3'];

  if (opts.file) {
    let diff;
    try {
      diff = readFileSync(opts.file, 'utf8');
    } catch (err) {
      fatal(`cannot read patch file ${opts.file}: ${err.message}`);
    }
    return { diff, source: `patch file ${opts.file}` };
  }

  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    fatal('not a git repository (and no --file= given)');
  }

  if (opts.range) {
    return { diff: git(['diff', ...common, opts.range]), source: `git diff ${opts.range}` };
  }
  if (opts.worktree) {
    return { diff: git(['diff', ...common]), source: 'git diff (unstaged working tree)' };
  }

  const staged = git(['diff', ...common, '--cached']);
  if (staged.trim()) return { diff: staged, source: 'git diff --cached (staged changes)' };

  // Nothing staged. Fall back to the last commit, and SAY that is what happened
  // — silently auditing a different diff than the caller assumed is its own kind
  // of dishonest output.
  let diff = '';
  try {
    diff = git(['diff', ...common, 'HEAD~1..HEAD']);
  } catch {
    return { diff: '', source: 'nothing staged, and HEAD~1 does not exist' };
  }
  return { diff, source: 'git diff HEAD~1..HEAD (nothing was staged)' };
}

// ---------------------------------------------------------------------------
// Diff parsing — added lines with their real line numbers in the new file
// ---------------------------------------------------------------------------

/**
 * Walk a unified diff and return every ADDED line as
 * { file, line, text } where `line` is the 1-based line number in the NEW file.
 * Only added lines are scanned: this gate judges what a change INTRODUCES, not
 * what it happens to sit next to.
 */
function addedLines(diff) {
  const out = [];
  let file = null;
  let newLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      out.push({ file, line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      // removed line: does not advance the new-file counter
    } else if (raw.startsWith(' ') || raw === '') {
      newLine += 1;
    }
  }
  return out;
}

const isCommentOnly = (t) => /^\s*(\/\/|\/\*|\*|#|<!--)/.test(t);

// ---------------------------------------------------------------------------
// Use vs. mention — the hardest problem this gate has
// ---------------------------------------------------------------------------
//
// A grep for banned dispatch copy fires on the two places in this repo that are
// SUPPOSED to contain it: `agents/_standing-context.md`, which states the rule by
// quoting the forbidden phrase, and `docs/harness-review.md`, which carries a
// guardrail attack corpus of sentences like "send rescue teams to Haku" as test
// fixtures. Measured, not assumed: the first version of this script raised 14
// criticals against `HEAD~4..HEAD` and every one of them was a document
// discussing the ban rather than breaching it.
//
// Suppressing those silently would be the wrong fix — it would make the gate
// lie. So the finding is still RAISED and still PRINTED; what changes is whether
// it gates, and the reason is stated on the line.
//
// PRODUCT path      -> critical, gates. This is a surface that ships to a human.
// NON-PRODUCT path  -> same finding, downgraded, labelled. Docs, evals, tests and
//                      this script's own source legitimately quote banned strings.
//
// `--strict` turns the downgrade off, for a CI job that wants everything to gate.

const NON_PRODUCT = [
  /^docs\//,
  /^evals?\//,
  /^tests?\//,
  /\.test\.(js|mjs|ts)$/,
  /(?:^|\/)fixtures?\//,
  /^README\.md$/,
  /^scripts\/audit-diff\.mjs$/ // this file is a list of the banned patterns
];

const isProductPath = (f) => !NON_PRODUCT.some((re) => re.test(f));

// A file whose JOB is to define the banned language has to be able to name it.
// `src/guardrails/` holds the regexes and rewrite tables that implement Rule 1
// and Rule 4; `skills/no-dispatch-language/` is an entire document of
// banned-phrase -> honest-rewrite pairs. Both are product code, and neither could
// be written at all if every occurrence counted as a breach.
//
// This exemption is deliberately narrow: it covers the PROSE rules only. A
// dispatch-shaped FIELD, a defaulted `approvedBy`, or a model call inside the
// ranking math still gates in these paths exactly as it does anywhere else —
// none of those can be a "mention", because nobody needs to declare a real
// `dispatchTo:` key in order to describe one.
const GUARDRAIL_SURFACES = [/^src\/guardrails\//, /^skills\/no-dispatch-language\//];
const PROSE_RULES = new Set([
  'dispatch-copy-deploy-team',
  'dispatch-copy-directive',
  'silence-asserted-as-fact',
  'harm-inferred-from-silence'
]);

const isGuardrailDefinition = (file, ruleId) =>
  PROSE_RULES.has(ruleId) && GUARDRAIL_SURFACES.some((re) => re.test(file));

/**
 * Use/mention test for prompt text under `agents/`. Those .md files DO ship into
 * a model's context, so they are a product surface — but they also have to state
 * the rules, which means naming the forbidden phrase. A phrase in quotes or
 * backticks on a line that also carries a negation is a MENTION.
 */
function isMention(text, match) {
  const quoted = new RegExp(
    `["'\`“”]\\s*${match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'i'
  ).test(text);
  const negated =
    /\b(never|not|no|must not|cannot|refuse|refused|forbidden|banned|prohibit\w*|violation|blocked|instead of|rather than)\b/i.test(
      text
    );
  return quoted && negated;
}

// ---------------------------------------------------------------------------
// STAGE 1 — the deterministic pre-check
// ---------------------------------------------------------------------------
//
// Every rule here is a regex over one added line. That is the point: it is cheap,
// it is reproducible, it has no opinion, and it cannot be talked out of a finding
// by anything written in the diff. It is deliberately narrower than the model —
// it aims at the shapes that are unambiguous, and leaves the judgement calls to
// stage 2 rather than inventing confidence it does not have.

/** Field names that name who goes where. Matched only in key/assignment position. */
const DISPATCH_FIELDS = [
  'dispatchTo',
  'dispatch',
  'dispatchedTo',
  'dispatchTeam',
  'assignedTo',
  'assignTo',
  'assignee',
  'deployTo',
  'deployedTo',
  'deployment',
  'sendTo',
  'sentTo',
  'recipient',
  'recipients',
  'destination',
  'responder',
  'responders',
  'crew',
  'squad',
  'unit',
  'eta',
  'route',
  'routeTo',
  'waypoint',
  'priorityDeployment',
  'deploymentPriority',
  'taskedTo',
  'goTo'
];

// Two shapes only, and both of them are FIELDS:
//   object key      ->  `dispatchTo:`  /  `"dispatchTo":`
//   property assign ->  `x.dispatchTo =`
//
// A local variable DECLARATION is deliberately not matched. Measured: the first
// version of this file carried a bare `name =` alternative and raised a critical
// on `src/guardrails/index.js:160` — `const dispatch = checkNoDispatch(text, …)`,
// a local holding the guardrail's own result. That is not a dispatch-shaped field
// by any reading, and a gate that fires on it is a gate somebody mutes.
const FIELD_KEY_RE = new RegExp(
  String.raw`(?:^|[{,\s\[])["']?(${DISPATCH_FIELDS.join('|')})["']?\s*:(?!:)`
);
const FIELD_ASSIGN_RE = new RegExp(String.raw`\.(${DISPATCH_FIELDS.join('|')})\s*=(?!=|>)`);
const FIELD_RE = { exec: (t) => FIELD_KEY_RE.exec(t) || FIELD_ASSIGN_RE.exec(t) };

const STAGE1_RULES = [
  {
    id: 'dispatch-field',
    rule: 'no-dispatch',
    severity: 'critical',
    why: 'Rule 1 — a dispatch-shaped field names who goes where. No such field may exist.',
    skipComments: true,
    test: (t) => FIELD_RE.exec(t)
  },
  {
    id: 'dispatch-copy-deploy-team',
    rule: 'no-dispatch',
    severity: 'critical',
    why: 'Rule 1 — copy instructing a human to deploy, send or dispatch people somewhere.',
    skipComments: false,
    test: (t) =>
      /\b(deploy|dispatch|send|despatch)\b[^.\n]{0,40}\b(a |the |your |another |additional )?(team|teams|crew|responder|responders|unit|units|squad|personnel|rescuers?|helicopters?)\b/i.exec(
        t
      )
  },
  {
    id: 'dispatch-copy-directive',
    rule: 'no-dispatch',
    severity: 'critical',
    why: 'Rule 1 — copy telling someone where to go, or naming a place as an assignment.',
    skipComments: false,
    test: (t) =>
      // NOTE: a bare "route to" was tried and removed — it fired on README prose
      // about a container having "no route to" PyPI. A dispatch route names who
      // travels, so the pattern requires that noun.
      /\b(go to|head to|proceed to|prioriti[sz]e for deployment|assign(?:ed)? (?:a team|responders?|crews?)|rout(?:e|ing) (?:responders?|teams?|crews?|units?|aid|relief)|first responders? (?:to|should))\b/i.exec(
        t
      )
  },
  {
    id: 'approver-defaulted',
    rule: 'named-approver-required',
    severity: 'critical',
    why: 'Rule 2 — approvedBy defaulted to a literal. Only a named human may approve.',
    skipComments: true,
    // approvedBy: 'system' / approvedBy = "auto" / approvedBy: `agent` — a string
    // literal in the approver slot is a placeholder approver by definition.
    test: (t) => /\bapprovedBy\s*[:=]\s*(['"`])(?!\s*\1)[^'"`]+\1/.exec(t)
  },
  {
    id: 'llm-in-math',
    rule: 'no-llm-in-math',
    severity: 'critical',
    why: 'Rule 3 — dedup scoring and ranking math must contain no model call at all.',
    skipComments: true,
    files: /(?:^|\/)(?:dedup|rank|score|cluster)\.js$/i,
    test: (t) =>
      /\b(fetch\s*\(|openai|anthropic|OPENAI_API_KEY|OPENAI_BASE_URL|chat\.completions|createCompletion|callModel|askModel|llm|trueforge)\b/i.exec(
        t
      )
  },
  {
    id: 'nondeterminism-in-math',
    rule: 'no-llm-in-math',
    severity: 'major',
    why: 'Rule 3 — scoring must be reproducible; randomness or wall-clock inside it is not.',
    skipComments: true,
    files: /(?:^|\/)(?:dedup|rank|score|cluster)\.js$/i,
    test: (t) => /\b(Math\.random\s*\(|Date\.now\s*\(|new Date\s*\()/.exec(t)
  },
  {
    id: 'silence-asserted-as-fact',
    rule: 'honest-unknowns',
    severity: 'critical',
    why: 'Rule 4 — cohort-cold-start means NO DATA REACHED US, never "confirmed silent".',
    skipComments: false,
    test: (t) =>
      // NOTE: `confirmed dead|casualties|destroyed` was tried here and REMOVED.
      // It fired on `skills/disaster-source-credibility/SKILL.md`, which quotes a
      // real government bulletin — "Rasuwa: 71 confirmed dead, 210 missing".
      // Rule 4 forbids turning SILENCE into confirmation. It does not forbid
      // repeating a casualty figure a named source actually published. Conflating
      // the two made this gate wrong, not stricter.
      /\b(confirmed silent|verified silent|known silent|silence confirms|confirmed (?:to be )?(?:cut off|wiped out|destroyed by)|proves? (?:they are|the settlement is))\b/i.exec(
        t
      )
  },
  {
    id: 'harm-inferred-from-silence',
    rule: 'honest-unknowns',
    severity: 'major',
    why: 'Rule 4 — silence is missing information. It is never evidence of harm.',
    skipComments: false,
    test: (t) =>
      /\b(?:people|residents|population|casualties)\s+(?:affected|at risk|dead|missing)\b[^.\n]{0,30}\b(?:estimat|becaus|since|due to)\w*\b[^.\n]{0,30}\bsilen/i.exec(
        t
      )
  }
];

function runStage1(added, strict) {
  const findings = [];
  for (const { file, line, text } of added) {
    if (!text.trim()) continue;
    for (const rule of STAGE1_RULES) {
      if (rule.files && !rule.files.test(file)) continue;
      if (rule.skipComments && isCommentOnly(text)) continue;
      const m = rule.test(text);
      if (!m) continue;

      // The finding is always recorded. Only its GATING is conditional, and the
      // reason travels with it so a downgrade can never be silent.
      let severity = rule.severity;
      let downgradedBecause = null;
      if (!strict) {
        if (isGuardrailDefinition(file, rule.id)) {
          severity = 'minor';
          downgradedBecause =
            'guardrail definition surface — this file exists to DEFINE the banned language, so it has to name it. Structural rules (dispatch field, defaulted approver, LLM in math) still gate here.';
        } else if (!isProductPath(file)) {
          severity = severity === 'critical' ? 'major' : 'minor';
          downgradedBecause =
            'non-product path (docs / evals / tests / this script) — these legitimately quote banned strings; run --strict to gate on them too';
        } else if (/^agents\/.*\.md$/.test(file) && isMention(text, m[0])) {
          severity = 'minor';
          downgradedBecause =
            'prompt text stating the rule: the banned phrase is quoted AND negated on this line — a mention, not a use';
        }
      }

      findings.push({
        stage: 'deterministic',
        id: rule.id,
        rule: rule.rule,
        severity,
        originalSeverity: rule.severity,
        downgradedBecause,
        file,
        line,
        quote: text.trim().slice(0, 240),
        match: m[0].trim(),
        summary: rule.why,
        quoteVerified: true // it IS the line; nothing to verify against
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// STAGE 2 — signal-zero-auditor, bound BY NAME on TrueForge
// ---------------------------------------------------------------------------

async function api(method, path, body, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw for the error path */
    }
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 300)}`);
    return json?.data ?? json;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['done', 'error', 'cancelled', 'failed']);

/**
 * HTTP 200 IS NOT SUCCESS — see docs/trueforge-verified.md. `POST /turns`
 * returns as soon as the turn is accepted; a malformed body fails INSIDE the
 * run. The result lives in `turn.state.status`, so we poll for a terminal one.
 */
async function waitForTurn(sessionId, turnId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turn = await api('GET', `/api/v1/sessions/${sessionId}/turns/${turnId}`);
    const status = turn?.state?.status;
    if (status && TERMINAL.has(status)) return turn;
    if (Date.now() > deadline)
      throw new Error(`turn ${turnId} still ${status} after ${timeoutMs}ms`);
    await sleep(2000);
  }
}

function turnText(turn) {
  const c = turn?.state?.output?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => p?.text ?? '').join('');
  return '';
}

/** Pull the first balanced top-level JSON object out of a model reply. */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function buildPrompt(diff, source, truncated, stage1) {
  const pre = stage1.length
    ? stage1
        .map((f) => `  - [${f.severity}] ${f.rule} ${f.file}:${f.line} matched "${f.match}"`)
        .join('\n')
    : '  (none)';
  return [
    'Audit the unified diff below against the four hard rules. This is a repository',
    'gate on a real commit path, so a false clean is worse than a false alarm.',
    '',
    `Diff source: ${source}`,
    truncated
      ? `NOTE: this diff was TRUNCATED to fit your context. You are seeing a PART of the change. Put anything you could not see in notChecked.`
      : 'The diff below is complete.',
    '',
    'A deterministic grep already ran over the added lines. Its findings:',
    pre,
    '',
    'You are the SECOND opinion. Do not merely repeat the grep. Look for what a',
    'regex cannot see: copy that means "go there" without using a banned verb; a',
    'model call reached through a helper import; an approval path that sets a',
    'status without a name; a fallback that swallows a failure; absence of data',
    'presented as knowledge.',
    '',
    'Judge ONLY the added ("+") lines. Removed lines are context.',
    'Judge THIS DIFF, not the repository and not the project as a whole. A rule is',
    'breached only by what these added lines themselves do or emit.',
    'Prose that DESCRIBES a limitation, a known bug, a failed experiment or an',
    'infrastructure problem is documentation, not a breach. A paragraph reporting',
    'that a sandbox failed is Rule 4 being OBEYED — an honest unknown recorded out',
    'loud — not a swallowed failure. A table comparing model behaviour is not an',
    'LLM inside the ranking math; that rule is about dedup.js and rank.js calling a',
    'model. Do not report a document for accurately describing something imperfect.',
    'Every finding must quote text that appears VERBATIM in this diff — a quote I',
    'cannot locate in the diff will be printed as UNVERIFIED and will not gate.',
    'For `file` use the path as it appears in the diff; for `line` use the line',
    'number in the new file.',
    '',
    'Return ONLY the JSON object from your output contract. No prose, no fences.',
    '',
    '===== BEGIN DIFF =====',
    diff,
    '===== END DIFF ====='
  ].join('\n');
}

async function runStage2(diff, source, truncated, stage1, opts) {
  const result = {
    attempted: true,
    ok: false,
    binding: null,
    agentId: null,
    sessionId: null,
    turnId: null,
    status: null,
    tokens: null,
    verdict: null,
    findings: [],
    verified: [],
    notChecked: [],
    warning: null,
    rawHead: null
  };

  // Probe first: cheap, and it separates "container is down" from "agent is
  // missing", which are different operator problems.
  try {
    await api('GET', '/api/v1/capabilities', null, opts.probeMs);
  } catch (err) {
    result.warning = `TrueForge unreachable at ${BASE} (${err.message}). No model opinion recorded.`;
    return result;
  }

  let agents;
  try {
    agents = await api('GET', '/api/v1/agents');
  } catch (err) {
    result.warning = `TrueForge reachable but /agents failed (${err.message}). No model opinion recorded.`;
    return result;
  }
  const agent = (agents || []).find((a) => a.name === AGENT);
  if (!agent) {
    result.warning = `agent "${AGENT}" is not registered on ${BASE}. Run scripts/load-agents.mjs. No model opinion recorded.`;
    return result;
  }
  result.agentId = agent.id;

  try {
    // NAMED reference. No inline spec: the auditor's ~13.5k characters of
    // instructions and its output contract live server-side in the registry,
    // which is what makes this a roster agent doing a job rather than a prompt
    // this script keeps re-pasting.
    const session = await api('POST', '/api/v1/sessions', { agent: { name: AGENT } });
    result.sessionId = session.id;
    result.binding = 'named-agent';

    const turn = await api('POST', `/api/v1/sessions/${session.id}/turns`, {
      input: [{ type: 'user.message', content: buildPrompt(diff, source, truncated, stage1) }],
      stream: false
    });
    result.turnId = turn.id;

    const done = await waitForTurn(session.id, turn.id, opts.timeoutMs);
    result.status = done?.state?.status ?? null;
    const m = done?.metrics || done?.state?.metrics || null;
    if (m) {
      result.tokens = {
        total: m.total_tokens ?? null,
        input: m.input_tokens ?? null,
        output: m.output_tokens ?? null,
        cacheRead: m.total_cache_read_tokens ?? null
      };
    }
    if (result.status !== 'done') {
      result.warning = `auditor turn ended status="${result.status}". No model opinion recorded.`;
      return result;
    }

    const text = turnText(done);
    result.rawHead = text.slice(0, 400);
    const parsed = extractJson(text);
    if (!parsed) {
      result.warning =
        'auditor returned output that is not parseable JSON. No model opinion recorded. ' +
        'Raw head is printed below so this is visible rather than silently dropped.';
      return result;
    }

    result.ok = true;
    result.verdict = typeof parsed.verdict === 'string' ? parsed.verdict : null;
    result.verified = Array.isArray(parsed.verified) ? parsed.verified : [];
    result.notChecked = Array.isArray(parsed.notChecked) ? parsed.notChecked : [];
    result.findings = (Array.isArray(parsed.findings) ? parsed.findings : []).map((f) => ({
      stage: 'model',
      id: String(f?.id ?? 'unnamed'),
      rule: String(f?.rule ?? 'other'),
      severity: String(f?.severity ?? 'minor').toLowerCase(),
      file: String(f?.file ?? '(unstated)'),
      line: Number.isFinite(Number(f?.line)) ? Number(f.line) : 0,
      quote: String(f?.quote ?? ''),
      summary: String(f?.summary ?? ''),
      failureScenario: String(f?.failureScenario ?? ''),
      suggestedFix: String(f?.suggestedFix ?? '')
    }));
  } catch (err) {
    result.warning = `TrueForge call failed (${err.message}). No model opinion recorded.`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Quote verification — a model finding must point at text that really exists
// ---------------------------------------------------------------------------

/**
 * A hallucinated quote must not block a commit, for exactly the reason a dead
 * container must not: a gate that fires on things that are not in the diff gets
 * switched off. So an unlocatable quote is printed loudly and marked UNVERIFIED,
 * and it is excluded from the exit code.
 */
function verifyQuotes(findings, added, strict) {
  const haystack = added.map((a) => a.text.replace(/\s+/g, ' ').trim().toLowerCase());
  return findings.map((f) => {
    const q = f.quote.replace(/\s+/g, ' ').trim().toLowerCase();
    const quoteVerified = q
      ? haystack.some((h) => h.includes(q) || (q.length > 40 && q.includes(h) && h.length > 20))
      : false;

    // The SAME path class stage 1 uses, applied to the model. Measured, and the
    // reason this exists: on a documentation-only diff the auditor returned three
    // criticals against `docs/trueforge-verified.md` — reading a paragraph that
    // DESCRIBES a sandbox network failure as an unreported failure in the code,
    // and an A/B table about skill mounting as an LLM inside the ranking math.
    // All three quoted the diff verbatim, so quote-verification passed them, and
    // a docs commit was blocked by a category error.
    //
    // A model critical on `src/` or `web/` still gates. A model critical on docs,
    // evals or tests is printed in full and marked advisory. Same argument as the
    // dead container: a gate that blocks a docs edit on a misread paragraph is a
    // gate that gets uninstalled, and then it is not protecting `src/` either.
    let severity = f.severity;
    let downgradedBecause = null;
    if (!strict && severity === 'critical' && !isProductPath(f.file)) {
      severity = 'major';
      downgradedBecause =
        'model critical on a non-product path (docs / evals / tests) — printed, but advisory; run --strict to gate on it';
    }
    return { ...f, quoteVerified, severity, originalSeverity: f.severity, downgradedBecause };
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const SEV_ORDER = { critical: 0, major: 1, minor: 2 };
const bar = (c = '=') => c.repeat(78);

function printFinding(f, i) {
  const flag =
    f.stage === 'model' && !f.quoteVerified ? '  [UNVERIFIED QUOTE — DOES NOT GATE]' : '';
  console.log(
    `\n  ${String(i + 1).padStart(2)}. [${f.severity.toUpperCase()}] ${f.rule}   (${f.stage})${flag}`
  );
  console.log(`      ${f.file}:${f.line}`);
  if (f.summary) console.log(`      ${f.summary}`);
  if (f.downgradedBecause) {
    console.log(`      DOWNGRADED from ${f.originalSeverity}: ${f.downgradedBecause}`);
  }
  if (f.quote) console.log(`      quote > ${f.quote.replace(/\n/g, '\\n').slice(0, 200)}`);
  if (f.failureScenario) console.log(`      scenario: ${f.failureScenario}`);
  if (f.suggestedFix) console.log(`      fix (described, NOT applied): ${f.suggestedFix}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      readFileSync(new URL(import.meta.url))
        .toString()
        .split('\n')
        .slice(0, 70)
        .join('\n')
    );
    process.exit(EXIT_CLEAN);
  }

  const { diff: rawDiff, source } = collectDiff(opts);
  const added = addedLines(rawDiff);

  const truncated = Buffer.byteLength(rawDiff, 'utf8') > opts.maxBytes;
  const diffForModel = truncated ? rawDiff.slice(0, opts.maxBytes) : rawDiff;

  // STAGE 1 always runs, and it runs over the FULL diff — truncation is a
  // context-window concession to the model, not to the grep.
  const stage1 = runStage1(added, opts.strict);

  return { opts, rawDiff, added, source, truncated, diffForModel, stage1 };
}

// ---------------------------------------------------------------------------

(async () => {
  const ctx = main();
  const { opts, rawDiff, added, source, truncated, diffForModel, stage1 } = ctx;

  if (!opts.json) {
    console.log(bar());
    console.log('SIGNAL ZERO — DIFF AUDIT (repository gate, four hard rules)');
    console.log(bar());
    console.log(`source        : ${source}`);
    console.log(
      `diff size     : ${Buffer.byteLength(rawDiff, 'utf8')} bytes, ${added.length} added lines`
    );
    console.log(`files touched : ${new Set(added.map((a) => a.file)).size}`);
    console.log(
      `auditor       : ${AGENT} @ ${BASE}${opts.useModel ? '' : '   (--no-model: SKIPPED)'}`
    );
    console.log(
      `mode          : ${opts.strict ? 'STRICT — every path gates' : 'default — findings in docs/evals/tests are reported but do not gate'}`
    );
    if (truncated) {
      console.log(
        `TRUNCATION    : diff exceeds --max-bytes=${opts.maxBytes}; the model sees the FIRST ` +
          `${opts.maxBytes} bytes only. Stage 1 still scanned all ${added.length} added lines.`
      );
    }
  }

  if (!rawDiff.trim()) {
    if (opts.json)
      console.log(JSON.stringify({ source, empty: true, exitCode: EXIT_CLEAN }, null, 2));
    else console.log('\nNothing to audit — the diff is empty.\n');
    process.exit(EXIT_CLEAN);
  }

  // ---- Stage 1 --------------------------------------------------------------
  if (!opts.json) {
    console.log(`\n${bar('-')}`);
    console.log('STAGE 1 — deterministic pre-check (no model, runs first, gates on its own)');
    console.log(bar('-'));
    if (!stage1.length)
      console.log('  clean: no dispatch-shaped, approver-defaulting, LLM-in-math or');
    if (!stage1.length) console.log('  silence-as-fact pattern in any added line.');
    else stage1.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]).forEach(printFinding);
  }

  // ---- Stage 2 --------------------------------------------------------------
  let stage2 = {
    attempted: false,
    ok: false,
    findings: [],
    warning: null,
    verified: [],
    notChecked: []
  };
  if (opts.useModel) {
    stage2 = await runStage2(diffForModel, source, truncated, stage1, opts);
    stage2.findings = verifyQuotes(stage2.findings, added, opts.strict);
  }

  if (!opts.json) {
    console.log(`\n${bar('-')}`);
    console.log(`STAGE 2 — ${AGENT} on TrueForge (second opinion)`);
    console.log(bar('-'));
    if (!opts.useModel) {
      console.log('  skipped (--no-model). Stage 1 result stands alone.');
    } else if (stage2.warning) {
      console.log(`  WARNING: ${stage2.warning}`);
      console.log('  This gate does NOT fail closed on infrastructure. Stage 1 determines the');
      console.log('  exit code. A gate that blocks commits when a container is down is a gate');
      console.log('  people disable, and a disabled gate protects nothing.');
      if (stage2.rawHead)
        console.log(`\n  raw output head:\n  ${stage2.rawHead.replace(/\n/g, '\n  ')}`);
    } else {
      console.log(`  binding    : ${stage2.binding}   agent id ${stage2.agentId}`);
      console.log(`  session    : ${stage2.sessionId}`);
      console.log(`  turn       : ${stage2.turnId}  status=${stage2.status}`);
      if (stage2.tokens) {
        console.log(
          `  tokens     : total=${stage2.tokens.total} in=${stage2.tokens.input} out=${stage2.tokens.output} cacheRead=${stage2.tokens.cacheRead}`
        );
      }
      console.log(`  verdict    : ${stage2.verdict ?? '(none stated)'}`);
      if (!stage2.findings.length) console.log('\n  no findings returned.');
      else
        stage2.findings
          .slice()
          .sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3))
          .forEach(printFinding);
      if (stage2.verified.length) {
        console.log(`\n  verified by the auditor (${stage2.verified.length}):`);
        for (const v of stage2.verified.slice(0, 8)) {
          console.log(
            `    - ${v.rule ?? '?'} — ${v.file ?? '?'} — ${String(v.evidence ?? '').slice(0, 150)}`
          );
        }
      }
      if (stage2.notChecked.length) {
        console.log(`\n  NOT checked (${stage2.notChecked.length}):`);
        for (const n of stage2.notChecked.slice(0, 8)) {
          console.log(`    - ${n.item ?? '?'} — ${String(n.reason ?? '').slice(0, 150)}`);
        }
      }
    }
  }

  // ---- Verdict --------------------------------------------------------------
  const gating = [
    ...stage1.filter((f) => f.severity === 'critical'),
    ...stage2.findings.filter((f) => f.severity === 'critical' && f.quoteVerified)
  ];
  const advisoryCritical = stage2.findings.filter(
    (f) => f.severity === 'critical' && !f.quoteVerified
  );
  const exitCode = gating.length ? EXIT_VIOLATION : EXIT_CLEAN;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          source,
          truncated,
          addedLines: added.length,
          stage1: { findings: stage1 },
          stage2: {
            attempted: stage2.attempted,
            ok: stage2.ok,
            binding: stage2.binding ?? null,
            sessionId: stage2.sessionId ?? null,
            turnId: stage2.turnId ?? null,
            tokens: stage2.tokens ?? null,
            verdict: stage2.verdict ?? null,
            warning: stage2.warning ?? null,
            findings: stage2.findings,
            verified: stage2.verified,
            notChecked: stage2.notChecked
          },
          gatingFindings: gating.length,
          advisoryUnverifiedCriticals: advisoryCritical.length,
          exitCode
        },
        null,
        2
      )
    );
    process.exit(exitCode);
  }

  console.log(`\n${bar()}`);
  const counts = (arr) => ({
    critical: arr.filter((f) => f.severity === 'critical').length,
    major: arr.filter((f) => f.severity === 'major').length,
    minor: arr.filter((f) => f.severity === 'minor').length
  });
  const c1 = counts(stage1);
  const c2 = counts(stage2.findings);
  console.log(
    `stage 1 (grep) : ${stage1.length} finding(s)  critical=${c1.critical} major=${c1.major} minor=${c1.minor}`
  );
  console.log(
    `stage 2 (model): ${stage2.findings.length} finding(s)  critical=${c2.critical} major=${c2.major} minor=${c2.minor}` +
      (stage2.warning ? '   [NO MODEL OPINION — see warning above]' : '')
  );
  if (advisoryCritical.length) {
    console.log(
      `                 ${advisoryCritical.length} model critical(s) had quotes NOT found in the diff — advisory only.`
    );
  }
  if (truncated)
    console.log(
      'PARTIAL AUDIT  : the model saw a truncated diff. This is not a clean bill of health.'
    );
  console.log(bar());
  if (exitCode === EXIT_VIOLATION) {
    console.log(
      `GATE: FAIL — ${gating.length} critical finding(s) breach a hard rule. exit ${EXIT_VIOLATION}`
    );
    console.log('This script reports. It has not changed a single line of your code.');
  } else {
    console.log(`GATE: PASS — no gating critical finding. exit ${EXIT_CLEAN}`);
    if (stage2.warning)
      console.log('NOTE: passed on stage 1 alone; the model opinion was unavailable.');
  }
  console.log(bar());
  process.exit(exitCode);
})().catch((err) => {
  console.error(`audit-diff: unexpected failure: ${err && err.stack ? err.stack : err}`);
  process.exit(EXIT_CANNOT_RUN);
});
