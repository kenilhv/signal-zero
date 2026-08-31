// Signal Zero - Stage 5: HUMAN CHECKPOINT
//
// This is the stage the whole project exists to demonstrate.
//
// Two kinds of things get held here:
//   1. 'escalation'      - a settlement whose silence looks anomalous enough that a
//                          human should look at it.
//   2. 'ambiguous-match' - a dedup pair whose Fellegi-Sunter match probability landed
//                          in the grey zone. The machine refuses to guess.
//
// Neither becomes actionable until a NAMED human approves it. The name requirement is
// enforced here in code (see assertApprover) - not in the UI - so no client, script or
// future refactor can route around it.
//
// Approval unlocks a *shortlist of jurisdictions to inform*. It never produces an
// assignment, a dispatch, or an instruction. See buildShortlist() for why.

import { describeVerdict, guardInput, guardOutput, worstSeverity } from '../guardrails/index.js';
import * as drafter from '../harness/escalation-drafter.js';
import { addIncident, repos } from '../store.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error carrying an HTTP-ish status so server.js can map it without sniffing strings. */
export class CheckpointError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// RULE #1 ENFORCEMENT: no dispatch-shaped data may enter the checkpoint.
// ---------------------------------------------------------------------------
// Signal Zero never says "go here" or "send team X". The cheapest way for that to
// sneak in is via a free-form `evidence` blob, so we reject those keys outright.
const DISPATCH_SHAPED_KEYS = new Set([
  'dispatch',
  'dispatchto',
  'dispatchedto',
  'assignto',
  'assignedto',
  'assignment',
  'sendteam',
  'deployto',
  'deployment',
  'responderassignment',
  'orders',
  'tasking'
]);

function assertNoDispatchFields(value, path = 'evidence', depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoDispatchFields(v, `${path}[${i}]`, depth + 1));
    return;
  }
  for (const key of Object.keys(value)) {
    if (DISPATCH_SHAPED_KEYS.has(key.toLowerCase())) {
      throw new CheckpointError(
        `Dispatch-shaped field "${path}.${key}" is not allowed. Signal Zero ranks silence; it never assigns responders.`,
        'DISPATCH_FIELD_FORBIDDEN',
        400
      );
    }
    assertNoDispatchFields(value[key], `${path}.${key}`, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// RULE #3 ENFORCEMENT: a decision requires a real, non-empty human name.
// ---------------------------------------------------------------------------

/**
 * Throws unless `approvedBy` is a non-empty, non-whitespace string.
 * Returns the trimmed name.
 */
export function assertApprover(approvedBy) {
  if (typeof approvedBy !== 'string' || approvedBy.trim() === '') {
    throw new CheckpointError(
      'A named human approver is required. Nothing in Signal Zero becomes actionable anonymously.',
      'APPROVER_REQUIRED',
      400
    );
  }
  return approvedBy.trim();
}

// ---------------------------------------------------------------------------
// Item construction
// ---------------------------------------------------------------------------

let seq = 0;

function nextId(kind) {
  const prefix = kind === 'escalation' ? 'esc' : 'amb';
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

/**
 * WHO WROTE THE WORDS A HUMAN IS ABOUT TO SIGN.
 *
 * Two sources, and they are not interchangeable:
 *
 *   harness-drafted  a registered TrueForge agent wrote the prose and every
 *                    guardrail accepted it. Carries the agent name and the turn
 *                    id, so the exact execution is recoverable from TrueForge.
 *   template         deterministic string templating in this file. No model was
 *                    involved.
 *
 * A template item ALWAYS names why it is not a draft. "The agent did not write
 * this" and "the agent tried and a guardrail blocked it" are different facts
 * about the same screen, and a reviewer signing their name is entitled to know
 * which one they are looking at. Defaulting `reason` to null would quietly erase
 * that distinction, so the default is the honest `not-attempted` instead.
 *
 * No timestamp here: the item already carries createdAt, and a second clock read
 * would make two items built in the same pass differ for no reason.
 */
function makeProvenance({
  source,
  reason = null,
  agent = null,
  turnId = null,
  guardrails = null
} = {}) {
  const harness = source === drafter.DRAFT_SOURCE.HARNESS;
  return {
    source: harness ? drafter.DRAFT_SOURCE.HARNESS : drafter.DRAFT_SOURCE.TEMPLATE,
    // Only meaningful for a template item, and never empty for one.
    reason: harness ? null : reason || 'not-attempted',
    // Only meaningful for a draft. Null on a template item rather than absent,
    // so the shape is stable and the UI never branches on key presence.
    agent: harness ? (agent ?? null) : null,
    turnId: harness ? (turnId ?? null) : null,
    // Which guardrails ran and passed. An empty array means "none recorded",
    // which is NOT the same as "none ran" - callers that know must pass them.
    guardrails: Array.isArray(guardrails) ? guardrails.slice() : []
  };
}

/**
 * Wrap a repository row so `item.status = 'approved'` still throws.
 *
 * The authority for status moved into the database — `checkpoint_items.status`
 * is a projection recomputed from the append-only `approvals` log, and there is
 * no setter for it anywhere in src/db/repositories/checkpoint.js. This guard is
 * the SECOND line, kept because it fails at the point of the mistake: assigning
 * to a detached JS object would otherwise succeed silently and the caller would
 * carry an object claiming a status the database never recorded. One throws
 * immediately; the other is discovered later, by someone else.
 */
function decorateItem(row) {
  if (!row) return null;
  const status = row.status;
  const item = { ...row };
  delete item.status;
  Object.defineProperty(item, 'status', {
    enumerable: true,
    configurable: false,
    get() {
      return status;
    },
    set() {
      throw new CheckpointError(
        'CheckpointItem.status is read-only. Use approve(id, approvedBy) or reject(id, approvedBy).',
        'STATUS_IMMUTABLE',
        409
      );
    }
  });
  return item;
}

/**
 * Build the DRAFT that goes to the store. It carries no status: status is not an
 * input any more, it is what the approvals log projects, so a draft that named
 * one would be asserting something it has no standing to assert.
 */
function makeItem({ kind, settlementId, title, evidence, provenance }) {
  assertNoDispatchFields(evidence ?? {});

  return {
    id: nextId(kind),
    kind,
    settlementId: settlementId ?? null,
    title: String(title ?? '').trim() || '(untitled checkpoint item)',
    evidence: evidence ?? {},
    // WHO WROTE THE WORDS THIS HUMAN IS ABOUT TO SIGN.
    // Every item carries this, always, so the UI never has to infer it. See
    // makeProvenance() - `source` is either 'harness-drafted' (the registered
    // TrueForge agent wrote it and every guardrail accepted it) or 'template'
    // (deterministic string templating here), and a template item always names
    // the reason it is not a draft.
    provenance: provenance ?? makeProvenance({ source: drafter.DRAFT_SOURCE.TEMPLATE })
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * A settlement's silence looks anomalous. Hold it for a human.
 * Idempotent per settlement: a pipeline re-run will NOT pile up duplicate pending
 * escalations, and it will never resurrect one a human already decided.
 */
export async function createEscalation({ settlementId, title, evidence, runId = null } = {}) {
  // Idempotence is checked against the STORE, not against a process-local array,
  // so a restarted process does not re-raise an escalation a human already
  // decided before the restart. That is the same rule it always was; it now
  // survives the thing it always claimed to survive.
  const existing = await repos.checkpoint.list({
    kind: 'escalation',
    ...(settlementId ? { settlementId } : {})
  });
  const match = existing.find((i) => (i.settlementId ?? null) === (settlementId ?? null));
  if (match) return decorateItem(match);

  const draft = makeItem({ kind: 'escalation', settlementId, title, evidence });
  return decorateItem(await repos.checkpoint.create({ ...draft, runId }));
}

/**
 * A Fellegi-Sunter pair landed between the reject and accept thresholds.
 * The machine does not break the tie; a human does.
 */
export async function createAmbiguousMatch({ title, evidence, settlementId, runId = null } = {}) {
  const fingerprint = ambiguousFingerprint(evidence);
  if (fingerprint) {
    const existing = await repos.checkpoint.list({ kind: 'ambiguous-match' });
    const match = existing.find((i) => ambiguousFingerprint(i.evidence) === fingerprint);
    if (match) return decorateItem(match);
  }

  const draft = makeItem({
    kind: 'ambiguous-match',
    settlementId: settlementId ?? null,
    title,
    evidence
  });
  return decorateItem(await repos.checkpoint.create({ ...draft, runId }));
}

// Stable key for "the same ambiguous pair", order-independent.
function ambiguousFingerprint(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const a = evidence.leftId || evidence.aId || evidence.reportAId || evidence.a || null;
  const b = evidence.rightId || evidence.bId || evidence.reportBId || evidence.b || null;
  if (!a || !b) return null;
  return [String(a), String(b)].sort().join('::');
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function getCheckpointItem(id) {
  return decorateItem(await repos.checkpoint.getById(id));
}

export async function listCheckpoint(status) {
  const rows = await repos.checkpoint.list(status ? { status } : {});
  return rows.map(decorateItem);
}

export function listPending() {
  return listCheckpoint('pending');
}

async function decide(id, approvedBy, nextStatus) {
  // assertApprover still runs FIRST and still returns HTTP 400. It is not
  // redundant with the database's NOT NULL + non-blank CHECK on
  // approvals.approved_by: this one produces a message a human can act on, and
  // that one holds when this code is bypassed entirely. Two layers, on purpose —
  // hard rule 2 is the product's headline claim, so it is enforced where the
  // request arrives AND where the row lands.
  const name = assertApprover(approvedBy);

  const item = await getCheckpointItem(id);
  if (!item) {
    throw new CheckpointError(`No checkpoint item with id "${id}".`, 'NOT_FOUND', 404);
  }
  if (item.status !== 'pending') {
    throw new CheckpointError(
      `Checkpoint item "${id}" was already ${item.status} by ${item.approvedBy || 'unknown'}.`,
      'ALREADY_DECIDED',
      409
    );
  }

  // Appends to the approvals log and reprojects status inside one transaction.
  // There is no status setter to call: the decision IS the append.
  const decided = decorateItem(
    await repos.checkpoint.decide({ id, decision: nextStatus, approvedBy: name })
  );
  if (!decided) {
    throw new CheckpointError(`No checkpoint item with id "${id}".`, 'NOT_FOUND', 404);
  }

  addIncident(
    'heal',
    `${nextStatus === 'approved' ? 'Approved' : 'Rejected'} by ${name}: ${decided.title}`,
    {
      checkpointId: decided.id,
      kind: decided.kind,
      settlementId: decided.settlementId,
      approvedBy: name
    }
  );

  return decided;
}

/** Approve. Requires a non-empty approver name. */
export function approve(id, approvedBy) {
  return decide(id, approvedBy, 'approved');
}

/** Reject. Requires a non-empty approver name too - a rejection is a decision on record. */
export function reject(id, approvedBy) {
  return decide(id, approvedBy, 'rejected');
}

/** The append-only decision log for one item, oldest first. */
export function listDecisions(id) {
  return repos.checkpoint.listDecisions(id);
}

// ---------------------------------------------------------------------------
// Shortlist
// ---------------------------------------------------------------------------

/**
 * buildShortlist(item, settlements)
 *
 * NOT AN OPTIMIZER. NOT AN ASSIGNMENT. NOT A DISPATCH.
 *
 * This returns the district-level jurisdictions that have standing authority over the
 * settlement(s) an approved checkpoint item touches - filtered from the gazetteer's
 * `district` field, then sorted alphabetically by district name.
 *
 * Alphabetical is deliberate and load-bearing. The obvious "improvement" would be to
 * sort by population at risk, distance, or capacity - i.e. to rank a "best responder".
 * That is DISPATCH REASONING, and this project forbids it: the moment the output implies
 * "this authority should go", the system has made an operational decision that belongs to
 * a human incident commander. So the ordering carries no preference signal at all, and
 * no field in the returned object may be read as an instruction. The counts below are
 * context for a human reading the list, not a score to sort by.
 *
 * Deterministic and stable: same item + same gazetteer => byte-identical list.
 */
export function buildShortlist(item, settlements = []) {
  const gazetteer = Array.isArray(settlements) ? settlements : [];
  if (gazetteer.length === 0) return [];

  // --- FILTER --------------------------------------------------------------
  // Which districts are in scope? The item's own settlement, plus any settlement id
  // named in its evidence (ambiguous matches reference two candidates).
  const scopedIds = new Set();
  if (item && item.settlementId) scopedIds.add(item.settlementId);
  collectSettlementIds(item && item.evidence, scopedIds);

  const districts = new Set();
  for (const s of gazetteer) {
    if (scopedIds.has(s.id)) districts.add(s.district);
  }

  // Nothing resolved to a settlement yet (cold start, unresolved report): fall back to
  // every district represented in the gazetteer. A wider list of who to *inform* is a
  // safe failure mode; a narrower guess is not.
  if (districts.size === 0) {
    for (const s of gazetteer) districts.add(s.district);
  }

  // --- STABLE SORT ---------------------------------------------------------
  // Alphabetical by district name. Explicitly not a priority order. See above.
  const ordered = [...districts].sort((a, b) => String(a).localeCompare(String(b), 'en'));

  return ordered.map((district) => {
    const inDistrict = gazetteer.filter((s) => s.district === district);
    return {
      jurisdictionId: `np-district-${slug(district)}`,
      // Nepal's standing local structure for this: the District Disaster Management Committee.
      name: `${district} District Disaster Management Committee`,
      district,
      // Context for a human reader. NOT a ranking key.
      settlementsInDistrict: inDistrict.length,
      settlementsInScope: inDistrict
        .filter((s) => scopedIds.has(s.id))
        .map((s) => s.id)
        .sort(),
      populationInDistrict: inDistrict.reduce((sum, s) => sum + (Number(s.population) || 0), 0),
      ordering: 'alphabetical-by-district (non-preferential)'
    };
  });
}

function collectSettlementIds(value, out, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectSettlementIds(v, out, depth + 1);
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string' && /settlementid$/i.test(key) && v) out.add(v);
    else collectSettlementIds(v, out, depth + 1);
  }
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default {
  createEscalation,
  listDecisions,
  createAmbiguousMatch,
  approve,
  reject,
  buildShortlist,
  getCheckpointItem,
  listCheckpoint,
  listPending,
  assertApprover,
  CheckpointError
};
