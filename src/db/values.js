// Signal Zero — value conversion between Postgres rows and store-shaped objects.
//
// THE ONLY RULE THAT MATTERS IN THIS FILE
//
// `toIso(null)` returns `null`. It does not return now(), it does not return the
// epoch, and there is no `fallback` parameter for a caller to pass one in. A
// NULL timestamp means NO DATA REACHED US (hard rule 4), and the single place
// that could quietly turn that into a confirmed observation is a conversion
// helper. So the helper cannot express it.

/**
 * Postgres TIMESTAMPTZ (a `Date` from node-postgres) or an ISO string -> ISO string.
 * NULL/undefined -> null. Never a substituted timestamp.
 *
 * An unparseable value also becomes null rather than a guess: "we could not read
 * this time" is the same fact as "we were never told this time", and inventing
 * one is the failure this whole module exists to prevent.
 * @param {Date|string|number|null|undefined} value
 * @returns {string|null}
 */
export function toIso(value) {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Same conversion, but for a column the schema declares NOT NULL. Throws instead
 * of guessing — `observations.observed_at` is the one timestamp a row is not
 * allowed to be vague about, because the silence clock is derived from it.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function requireIso(value, field) {
  const iso = toIso(value);
  if (iso === null) {
    throw new TypeError(
      `${field} must be a real timestamp. A report whose time could not be parsed gets ` +
        'NO observation row — the settlement stays silent rather than being credited ' +
        'with an observation at a guessed time.'
    );
  }
  return iso;
}

/** Numeric column -> number, NULL -> null. Never 0 for NULL. */
export function toNum(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * NOT NULL numeric column -> number. `fallback` is only ever reached when the
 * caller is building a row for a column the schema declares NOT NULL DEFAULT 0,
 * i.e. where 0 is a counted fact, never a stand-in for unknown.
 */
export function toCount(value, fallback = 0) {
  const n = toNum(value);
  return n === null ? fallback : n;
}

/** JSONB column -> the parsed value node-postgres already gave us, or `fallback`. */
export function toJson(value, fallback = null) {
  return value === null || value === undefined ? fallback : value;
}

/** JS value -> a JSON text parameter for a `$n::jsonb` placeholder. */
export function asJsonParam(value) {
  return JSON.stringify(value ?? null);
}

export default { toIso, requireIso, toNum, toCount, toJson, asJsonParam };
