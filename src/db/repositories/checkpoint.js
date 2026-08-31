// Signal Zero — checkpoint repository. The human gate.
//
// Returns exactly the CheckpointItem src/pipeline/checkpoint.js builds:
//   { id, kind, settlementId, title, evidence, provenance, approvedBy,
//     decidedAt, createdAt, status }
// Same keys in the same order, so the cutover is a swap. `run_id` exists in the
// table but is NOT on the object, because the in-memory item has no such key and
// adding one would turn a persistence change into an API change.
//
// ---------------------------------------------------------------------------
// STATUS IS A PROJECTION. THERE IS NO SETTER.
// ---------------------------------------------------------------------------
// A decision is written by APPENDING to `approvals` — never by updating a
// status. `checkpoint_items.status` is then recomputed from the latest row of
// that log, inside the same transaction, by a subquery that reads the log rather
// than by trusting the argument that was just passed in. That is what makes it a
// projection instead of a duplicate source of truth: if the two ever disagreed,
// `refreshStatus()` recomputing from the log would be the authority.
//
// In-memory, this was enforced by a throwing setter on a defineProperty getter.
// Here it is enforced by there being no function in this module that writes
// `status` from anything except the approvals log.
//
// approvedBy / decidedAt are read from that same latest approval, not stored on
// the item. approvals.approved_by is NOT NULL with a non-blank CHECK, so an
// anonymous decision is rejected by the database, not by a UI convention. This
// module deliberately does NOT pre-validate the name: the point of hard rule 2
// living in the schema is that it holds when application code is bypassed, and a
// JS guard here would hide whether the database is actually doing its job.

import { db as defaultDb, withTransaction } from '../pool.js';
import { asJsonParam, toIso, toJson } from '../values.js';

// The latest decision for an item, by decided_at then approval_id — approval_id
// breaks ties for two decisions written inside the same transaction, where
// decided_at (now()) is identical by definition.
const LATEST_APPROVAL = `
  LEFT JOIN LATERAL (
    SELECT a.decision, a.approved_by, a.decided_at, a.shortlist
      FROM approvals a
     WHERE a.item_id = ci.id
     ORDER BY a.decided_at DESC, a.approval_id DESC
     LIMIT 1
  ) d ON true`;

const SELECT_SQL = `
  SELECT ci.id, ci.kind, ci.settlement_id, ci.title, ci.evidence, ci.provenance,
         ci.status, ci.created_at,
         d.approved_by, d.decided_at
    FROM checkpoint_items ci
    ${LATEST_APPROVAL}`;

export function rowToItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    settlementId: row.settlement_id ?? null,
    title: row.title,
    evidence: toJson(row.evidence, {}),
    provenance: toJson(row.provenance, {}),
    // Null until a named human has decided. Never a placeholder name.
    approvedBy: row.approved_by ?? null,
    decidedAt: toIso(row.decided_at),
    createdAt: toIso(row.created_at),
    status: row.status
  };
}

/**
 * Insert a pending item. `id` is supplied by the caller (src/pipeline/checkpoint.js
 * already mints `esc-…` / `amb-…` ids) so the cutover keeps existing ids stable.
 * ON CONFLICT DO NOTHING makes creation idempotent per id, which is what the
 * once-per-settlement escalation rule upstream relies on.
 */
export async function create(item, db = defaultDb) {
  const { rows } = await db.query(
    `INSERT INTO checkpoint_items (id, run_id, kind, settlement_id, title, evidence, provenance)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      String(item.id),
      item.runId ?? null,
      String(item.kind),
      item.settlementId ?? null,
      String(item.title ?? ''),
      asJsonParam(item.evidence ?? {}),
      asJsonParam(item.provenance ?? {})
    ]
  );
  if (rows.length === 0) return getById(item.id, db);
  return getById(rows[0].id, db);
}

export async function getById(id, db = defaultDb) {
  const { rows } = await db.query(`${SELECT_SQL} WHERE ci.id = $1`, [String(id)]);
  return rows.length ? rowToItem(rows[0]) : null;
}

/** @param {{status?:string, kind?:string, settlementId?:string}} [filter] */
export async function list(filter = {}, db = defaultDb) {
  const where = [];
  const params = [];
  if (filter.status) {
    params.push(String(filter.status));
    where.push(`ci.status = $${params.length}`);
  }
  if (filter.kind) {
    params.push(String(filter.kind));
    where.push(`ci.kind = $${params.length}`);
  }
  if (filter.settlementId) {
    params.push(String(filter.settlementId));
    where.push(`ci.settlement_id = $${params.length}`);
  }
  const { rows } = await db.query(
    `${SELECT_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ci.created_at DESC, ci.id DESC`,
    params
  );
  return rows.map(rowToItem);
}

export async function countPending(db = defaultDb) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM checkpoint_items WHERE status = 'pending'`
  );
  return rows[0].n;
}

/**
 * Recompute `status` from the approvals log. The projection, in one place.
 *
 * The COALESCE here is on an ENUM-ish TEXT status, not on a timestamp: an empty
 * decision log genuinely means 'pending', which is the true state, not a
 * substitute for an unknown one. No timestamp in this repository is coalesced —
 * `decidedAt` comes straight off the latest approval and is null until one
 * exists.
 */
async function refreshStatus(id, db) {
  await db.query(
    `UPDATE checkpoint_items ci
        SET status = COALESCE(
              (SELECT a.decision FROM approvals a
                WHERE a.item_id = ci.id
                ORDER BY a.decided_at DESC, a.approval_id DESC
                LIMIT 1),
              'pending')
      WHERE ci.id = $1`,
    [String(id)]
  );
}

/**
 * Record a decision.
 *
 * Append to `approvals`, then reproject `status`, in ONE transaction. The item
 * row is locked FOR UPDATE first so two concurrent approvers cannot interleave
 * their append and their reprojection and leave the status reflecting the older
 * decision.
 *
 * This function does NOT reject a second decision on an already-decided item.
 * That is application policy (src/pipeline/checkpoint.js returns HTTP 409) and
 * it does not belong here: an append-only log's job is to accept the append and
 * move the projection. Call getById first if you need the 409.
 *
 * @param {{id:string, decision:'approved'|'rejected', approvedBy:string,
 *          shortlist?:unknown}} decision
 */
export async function decide({ id, decision, approvedBy, shortlist = null }, db = null) {
  const run = async (tx) => {
    const { rows: locked } = await tx.query(
      'SELECT id FROM checkpoint_items WHERE id = $1 FOR UPDATE',
      [String(id)]
    );
    if (locked.length === 0) return null;

    // btrim here rather than in JS so that a whitespace-only name reaches the
    // database CHECK as '' and is rejected there. The rule is in the schema.
    await tx.query(
      `INSERT INTO approvals (item_id, decision, approved_by, shortlist)
       VALUES ($1, $2, btrim($3), $4::jsonb)`,
      [
        String(id),
        String(decision),
        approvedBy === null || approvedBy === undefined ? null : String(approvedBy),
        shortlist === null ? null : asJsonParam(shortlist)
      ]
    );
    await refreshStatus(id, tx);
    const { rows } = await tx.query(`${SELECT_SQL} WHERE ci.id = $1`, [String(id)]);
    return rows.length ? rowToItem(rows[0]) : null;
  };
  return db ? run(db) : withTransaction(run);
}

/** The full append-only decision log for one item, oldest first. */
export async function listDecisions(id, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT approval_id, item_id, decision, approved_by, decided_at, shortlist
       FROM approvals
      WHERE item_id = $1
      ORDER BY decided_at ASC, approval_id ASC`,
    [String(id)]
  );
  return rows.map((r) => ({
    approvalId: Number(r.approval_id),
    itemId: r.item_id,
    decision: r.decision,
    approvedBy: r.approved_by,
    decidedAt: toIso(r.decided_at),
    shortlist: toJson(r.shortlist, null)
  }));
}

export default {
  rowToItem,
  create,
  getById,
  list,
  countPending,
  decide,
  listDecisions
};
