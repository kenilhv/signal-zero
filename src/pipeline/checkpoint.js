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

import { store, addIncident } from '../store.js';

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

// Only approve()/reject() may move status. `status` is exposed as an enumerable
// getter with a throwing setter, so `item.status = 'approved'` from anywhere else
// (a route handler, a test, a future teammate in a hurry) fails loudly.
const setStatusInternal = new WeakMap();

function makeItem({ kind, settlementId, title, evidence }) {
  assertNoDispatchFields(evidence ?? {});

  let status = 'pending';

  const item = {
    id: nextId(kind),
    kind,
    settlementId: settlementId ?? null,
    title: String(title ?? '').trim() || '(untitled checkpoint item)',
    evidence: evidence ?? {},
    approvedBy: null,
    decidedAt: null,
    createdAt: new Date().toISOString()
  };

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

  setStatusInternal.set(item, (next) => {
    status = next;
  });

  return item;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * A settlement's silence looks anomalous. Hold it for a human.
 * Idempotent per settlement: a pipeline re-run will NOT pile up duplicate pending
 * escalations, and it will never resurrect one a human already decided.
 */
export function createEscalation({ settlementId, title, evidence } = {}) {
  const existing = store.checkpoint.find(
    (i) => i.kind === 'escalation' && i.settlementId === (settlementId ?? null)
  );
  if (existing) return existing;

  const item = makeItem({ kind: 'escalation', settlementId, title, evidence });
  store.checkpoint.push(item);
  return item;
}

/**
 * A Fellegi-Sunter pair landed between the reject and accept thresholds.
 * The machine does not break the tie; a human does.
 */
export function createAmbiguousMatch({ title, evidence, settlementId } = {}) {
  const fingerprint = ambiguousFingerprint(evidence);
  if (fingerprint) {
    const existing = store.checkpoint.find(
      (i) => i.kind === 'ambiguous-match' && ambiguousFingerprint(i.evidence) === fingerprint
    );
    if (existing) return existing;
  }

  const item = makeItem({
    kind: 'ambiguous-match',
    settlementId: settlementId ?? null,
    title,
    evidence
  });
  store.checkpoint.push(item);
  return item;
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

export function getCheckpointItem(id) {
  return store.checkpoint.find((i) => i.id === id) || null;
}

export function listCheckpoint(status) {
  return status ? store.checkpoint.filter((i) => i.status === status) : store.checkpoint.slice();
}

export function listPending() {
  return listCheckpoint('pending');
}

function decide(id, approvedBy, nextStatus) {
  const name = assertApprover(approvedBy);

  const item = getCheckpointItem(id);
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

  setStatusInternal.get(item)(nextStatus);
  item.approvedBy = name;
  item.decidedAt = new Date().toISOString();

  addIncident(
    'heal',
    `${nextStatus === 'approved' ? 'Approved' : 'Rejected'} by ${name}: ${item.title}`,
    { checkpointId: item.id, kind: item.kind, settlementId: item.settlementId, approvedBy: name }
  );

  return item;
}

/** Approve. Requires a non-empty approver name. */
export function approve(id, approvedBy) {
  return decide(id, approvedBy, 'approved');
}

/** Reject. Requires a non-empty approver name too - a rejection is a decision on record. */
export function reject(id, approvedBy) {
  return decide(id, approvedBy, 'rejected');
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
export function buildShortlist(item, settlements = store.settlements) {
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
      settlementsInScope: inDistrict.filter((s) => scopedIds.has(s.id)).map((s) => s.id).sort(),
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
