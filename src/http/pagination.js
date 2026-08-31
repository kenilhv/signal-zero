// Signal Zero — page-size and cursor parsing for the incident feed.
//
// ---------------------------------------------------------------------------
// WHY THIS IS REQUIRED RATHER THAN NICE TO HAVE
// ---------------------------------------------------------------------------
// src/store.js used to keep a 200-item ring buffer and silently discard the
// 201st incident — on the one surface whose entire job is making failure
// visible. That buffer is gone: the feed is an append-only table now and
// NOTHING TRUNCATES IT.
//
// Which means GET /api/state would otherwise serialise every incident the
// deployment has ever recorded into one response. Bounding the WRITE was data
// loss wearing a memory-limit costume; bounding the READ is honest — but only if
// the response says how much it bounded, which is what `pageSize`, `total` and
// `nextCursor` are for.
//
// ---------------------------------------------------------------------------
// KEYSET, NOT OFFSET
// ---------------------------------------------------------------------------
// The ordering is `(at DESC, id DESC)`, matching `incidents_feed_idx` exactly, so
// a page is a range scan on the head of the index rather than a scan-and-discard.
// The cursor is the `(at, id)` of the last row a page returned.
//
// OFFSET is wrong here for the ordinary reason and for a specific one: this feed
// grows AT THE HEAD while a human is reading it. Under OFFSET, one new incident
// arriving mid-read shifts every subsequent page by one, so page 2 re-shows a row
// from page 1 and the reader sees a duplicate — during a failure cascade, which
// is exactly when they are counting rows. A keyset cursor is anchored to a row,
// so new arrivals at the head cannot move it.
//
// ---------------------------------------------------------------------------
// REFUSE, DO NOT CLAMP
// ---------------------------------------------------------------------------
// `?limit=5000` could be silently served as 500. It is refused with 400 instead.
// A caller that asked for 5000, received 500 rows and was told nothing has no way
// to distinguish a clamped page from a complete answer, and will conclude the
// deployment has 500 incidents. The repositories still clamp defensively — they
// are called from places that are not HTTP — but at the HTTP boundary the caller
// is told.

import { ProblemError } from './problem.js';

/**
 * GET /api/incidents page size. Both numbers are part of the published contract
 * (openapi.yaml, `IncidentPageLimit`) — changing either changes the contract.
 */
export const INCIDENT_PAGE_SIZE_DEFAULT = 100;
export const INCIDENT_PAGE_SIZE_MAX = 500;

/**
 * How many incidents GET /api/state carries inline, and the ceiling on
 * `?incidentLimit=`.
 *
 * THIS IS A PAGE SIZE, NOT A RING BUFFER. Nothing is discarded: every incident
 * stays in the table, the count of ALL of them travels alongside as
 * `incidentTotal`, and `incidentCursor` walks the rest through GET /api/incidents.
 */
export const STATE_INCIDENT_PAGE_SIZE_DEFAULT = 200;
export const STATE_INCIDENT_PAGE_SIZE_MAX = 500;

/**
 * Parse a `limit`-style query parameter.
 *
 * Absent or empty -> the default, and `explicit:false` so the caller can report
 * which page size actually applied without claiming the client chose it.
 *
 * @param {unknown} raw
 * @param {{param?:string, def:number, max:number}} opts
 * @returns {{limit:number, explicit:boolean}}
 * @throws {ProblemError} 400 invalid-page-size
 */
export function parsePageSize(raw, { param = 'limit', def, max }) {
  if (raw === undefined || raw === null || raw === '') return { limit: def, explicit: false };

  // Array happens when a client repeats the parameter. Two different page sizes
  // in one request is not a request this API can answer, and picking one of them
  // would be a guess.
  if (Array.isArray(raw)) {
    throw new ProblemError(
      'invalid-page-size',
      `The "${param}" parameter was given more than once. Send it exactly once.`,
      { parameter: param, maximum: max, default: def }
    );
  }

  const text = String(raw).trim();
  // Deliberately strict. `Number('12abc')` is NaN but `parseInt('12abc')` is 12,
  // and quietly reading 12 out of a typo is the same class of mistake as
  // coalescing a NULL: it substitutes a plausible value for one the caller did
  // not send.
  if (!/^\d+$/.test(text)) {
    throw new ProblemError(
      'invalid-page-size',
      `"${param}" must be a positive whole number; received ${JSON.stringify(String(raw))}.`,
      { parameter: param, requested: String(raw), maximum: max, default: def }
    );
  }

  const n = Number(text);
  if (n < 1 || n > max) {
    throw new ProblemError(
      'invalid-page-size',
      `"${param}" must be between 1 and ${max}; received ${n}. The request is refused ` +
        'rather than silently reduced, so the page you receive is never smaller than the ' +
        'page you asked for without being told.',
      { parameter: param, requested: n, maximum: max, default: def }
    );
  }

  return { limit: n, explicit: true };
}

/**
 * Validate a cursor's SHAPE before it reaches the repository.
 *
 * The repository's own parser returns null for an unreadable cursor, which makes
 * it behave as "no cursor" — i.e. page one, served again, silently. That is the
 * right defensive behaviour for a library and the wrong answer for an HTTP
 * client, who would page forever without noticing. So the boundary refuses it.
 *
 * Format is `<ISO 8601 instant>|<row id>`, which is what `nextCursor` emits. It
 * is opaque to clients by contract — do not construct one — but readable in a log
 * line on purpose, because an opaque base64 cursor is one more thing to decode at
 * 3am.
 *
 * @returns {string|null} the cursor, or null when none was supplied
 * @throws {ProblemError} 400 invalid-cursor
 */
export function parseCursorParam(raw, { param = 'cursor' } = {}) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) {
    throw new ProblemError(
      'invalid-cursor',
      `The "${param}" parameter was given more than once. Send it exactly once.`,
      { parameter: param }
    );
  }

  const text = String(raw);
  const sep = text.lastIndexOf('|');
  if (sep <= 0 || sep === text.length - 1) {
    throw new ProblemError(
      'invalid-cursor',
      `"${param}" must be the "nextCursor" value from a previous page, of the form ` +
        '"<ISO-8601 instant>|<id>".',
      { parameter: param, received: text.slice(0, 120) }
    );
  }

  const at = Date.parse(text.slice(0, sep));
  if (!Number.isFinite(at)) {
    throw new ProblemError(
      'invalid-cursor',
      `The timestamp half of "${param}" is not a readable ISO 8601 instant.`,
      { parameter: param, received: text.slice(0, 120) }
    );
  }

  return text;
}

export default {
  INCIDENT_PAGE_SIZE_DEFAULT,
  INCIDENT_PAGE_SIZE_MAX,
  STATE_INCIDENT_PAGE_SIZE_DEFAULT,
  STATE_INCIDENT_PAGE_SIZE_MAX,
  parseCursorParam,
  parsePageSize
};
