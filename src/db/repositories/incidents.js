// Signal Zero — incidents repository. The fail feed.
//
// APPEND-ONLY, AND NOTHING TRUNCATES.
//
// src/store.js kept a 200-item ring buffer and silently dropped the 201st
// failure — on the one surface whose entire job is making failure visible. There
// is no MAX_INCIDENTS in this file, no TRIM, no delete function, and no cap on
// what can be stored. The feed is genuinely unbounded now, which is exactly why
// the reader below is paginated: bounding the READ is honest, bounding the WRITE
// is data loss wearing a memory-limit costume.
//
// Returned shape is exactly the IncidentEvent src/store.js addIncident builds:
//   { id, at, kind, message, detail }
// `run_id` exists in the table (it is a useful filter) but is not on the object,
// because the in-memory event has no such key.

import { randomBytes } from 'node:crypto';
import { db as defaultDb } from '../pool.js';
import { asJsonParam, toIso, toJson } from '../values.js';

const COLUMNS = 'id, run_id, at, kind, message, detail';
const MAX_PAGE = 500;
const DEFAULT_PAGE = 100;

export function rowToIncident(row) {
  return {
    id: row.id,
    at: toIso(row.at),
    kind: row.kind,
    message: row.message,
    detail: toJson(row.detail, {})
  };
}

/**
 * Mint an id in the store's format: `inc-<base36 ms>-<suffix>`.
 * The suffix is random rather than a process-local counter because two booting
 * processes share this table now and a counter would collide on the primary key.
 */
function mintId() {
  return `inc-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Append one incident. Signature matches store.addIncident(kind, message, detail)
 * so the cutover of ~40 call sites is a re-import, not an edit.
 * @param {string} kind 'degraded-source' | 'llm-fallback' | 'cold-start' | 'heal' | 'agent-refusal'
 * @param {string} message
 * @param {object} [detail]
 * @param {{runId?:string|null, id?:string, at?:string|Date|null}} [opts]
 */
export async function append(kind, message, detail = {}, opts = {}, db = defaultDb) {
  const at = toIso(opts.at);
  const base = [
    opts.id ?? mintId(),
    opts.runId ?? null,
    String(kind),
    String(message),
    asJsonParam(detail ?? {})
  ];

  // Two statements rather than COALESCE($n::timestamptz, now()). The coalesce
  // form would read as "a NULL timestamp is fine, we will fill it in", which is
  // the exact habit hard rule 4 exists to break — and habits do not stay in the
  // column they were learned in. Omitting the column lets the schema's own
  // DEFAULT now() apply, which is a declared default, not a substitution for a
  // value someone failed to supply.
  const { rows } = at
    ? await db.query(
        `INSERT INTO incidents (id, run_id, kind, message, detail, at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz) RETURNING ${COLUMNS}`,
        [...base, at]
      )
    : await db.query(
        `INSERT INTO incidents (id, run_id, kind, message, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${COLUMNS}`,
        base
      );
  return rowToIncident(rows[0]);
}

/**
 * KEYSET-paginated read, newest first.
 *
 * ORDER BY (at, id) DESC matches incidents_feed_idx (at DESC, id DESC) exactly,
 * so the page is a range scan on the head of the index. The cursor is the
 * (at, id) of the last row returned and the predicate is a ROW COMPARISON —
 * `(at, id) < ($1, $2)` — not `at < $1 OR (at = $1 AND id < $2)`. Postgres can
 * push a row comparison straight into the index as a start key; the OR form
 * usually cannot be, and it is also the form people get subtly wrong when two
 * incidents share a timestamp, which for a feed written in tight loops during a
 * failure cascade is the normal case, not the edge case.
 *
 * OFFSET was the alternative and is wrong here for the usual reason plus a
 * specific one: the feed grows at the head while a human is reading it, so page
 * 2 under OFFSET would re-show rows from page 1 every time a new incident lands
 * mid-read. A keyset cursor is anchored to a row, so it cannot drift.
 *
 * @param {{limit?:number, cursor?:{at:string,id:string}|string|null,
 *          kind?:string, runId?:string}} [opts]
 * @returns {Promise<{items:object[], nextCursor:string|null, hasMore:boolean}>}
 */
export async function list({ limit, cursor = null, kind, runId } = {}, db = defaultDb) {
  const size = Math.max(1, Math.min(MAX_PAGE, Number(limit) || DEFAULT_PAGE));
  const where = [];
  const params = [];

  const parsed = parseCursor(cursor);
  if (parsed) {
    params.push(parsed.at, parsed.id);
    where.push(`(i.at, i.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  if (kind) {
    params.push(String(kind));
    where.push(`i.kind = $${params.length}`);
  }
  if (runId) {
    params.push(String(runId));
    where.push(`i.run_id = $${params.length}`);
  }
  // Fetch one extra row to answer hasMore without a second COUNT query.
  params.push(size + 1);

  const { rows } = await db.query(
    `SELECT ${COLUMNS.split(', ')
      .map((c) => `i.${c}`)
      .join(', ')}
       FROM incidents i
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.at DESC, i.id DESC
      LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(rowToIncident),
    // Null when there is nothing after this page — the client stops rather than
    // guessing at an offset.
    nextCursor: hasMore && last ? encodeCursor(last.at, last.id) : null,
    hasMore
  };
}

/** Cursor is `<ISO at>|<id>`, opaque to the client but readable in a log line. */
export function encodeCursor(at, id) {
  const iso = toIso(at);
  return iso === null ? null : `${iso}|${id}`;
}

export function parseCursor(cursor) {
  if (!cursor) return null;
  if (typeof cursor === 'object') {
    const at = toIso(cursor.at);
    return at && cursor.id ? { at, id: String(cursor.id) } : null;
  }
  const s = String(cursor);
  const sep = s.lastIndexOf('|');
  if (sep < 0) return null;
  const at = toIso(s.slice(0, sep));
  const id = s.slice(sep + 1);
  return at && id ? { at, id } : null;
}

export async function getById(id, db = defaultDb) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM incidents WHERE id = $1`, [String(id)]);
  return rows.length ? rowToIncident(rows[0]) : null;
}

/** Total count. Unbounded by design — if this is large, that is the truth. */
export async function count({ kind } = {}, db = defaultDb) {
  const { rows } = kind
    ? await db.query('SELECT count(*)::int AS n FROM incidents WHERE kind = $1', [String(kind)])
    : await db.query('SELECT count(*)::int AS n FROM incidents');
  return rows[0].n;
}

export default {
  rowToIncident,
  append,
  list,
  getById,
  count,
  encodeCursor,
  parseCursor
};
