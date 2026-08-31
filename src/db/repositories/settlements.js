// Signal Zero — settlements repository (the gazetteer).
//
// Returns objects shaped exactly like the entries in src/data/gazetteer.json,
// which is what src/store.js holds in `settlements`:
//   { id, name, district, lat, lon, population, hazardTier, aliases }
//
// SQL lives here and nowhere else.

import { db as defaultDb } from '../pool.js';
import { asJsonParam, toCount, toJson, toNum } from '../values.js';

const COLUMNS = `settlement_id, name, district, lat, lon, population, hazard_tier, aliases`;

/** @param {Record<string, any>} row */
export function rowToSettlement(row) {
  return {
    id: row.settlement_id,
    name: row.name,
    district: row.district,
    lat: toNum(row.lat),
    lon: toNum(row.lon),
    population: toCount(row.population),
    hazardTier: toCount(row.hazard_tier),
    aliases: toJson(row.aliases, [])
  };
}

/**
 * Load the gazetteer. Reference data, so this is an UPSERT rather than a
 * replace: settlement_id is referenced by observations, which are append-only
 * facts, so a settlement row can never be deleted out from under them.
 *
 * One statement for the whole batch via jsonb_to_recordset — a loop of N inserts
 * would be N round trips for data that always arrives as one file.
 * @param {Array<Record<string, any>>} settlements
 */
export async function upsertMany(settlements, db = defaultDb) {
  const list = Array.isArray(settlements) ? settlements : [];
  if (list.length === 0) return [];
  const payload = list.map((s) => ({
    id: String(s.id),
    name: String(s.name ?? ''),
    district: String(s.district ?? ''),
    lat: Number(s.lat),
    lon: Number(s.lon),
    population: Number(s.population ?? 0),
    hazard_tier: Number(s.hazardTier ?? s.hazard_tier ?? 1),
    aliases: Array.isArray(s.aliases) ? s.aliases : []
  }));

  const { rows } = await db.query(
    `INSERT INTO settlements (${COLUMNS})
     SELECT s.id, s.name, s.district, s.lat, s.lon, s.population, s.hazard_tier, s.aliases
     FROM jsonb_to_recordset($1::jsonb) AS s(
       id text, name text, district text, lat float8, lon float8,
       population int, hazard_tier smallint, aliases jsonb)
     ON CONFLICT (settlement_id) DO UPDATE SET
       name        = EXCLUDED.name,
       district    = EXCLUDED.district,
       lat         = EXCLUDED.lat,
       lon         = EXCLUDED.lon,
       population  = EXCLUDED.population,
       hazard_tier = EXCLUDED.hazard_tier,
       aliases     = EXCLUDED.aliases
     RETURNING ${COLUMNS}`,
    [asJsonParam(payload)]
  );
  return rows.map(rowToSettlement);
}

export async function listAll(db = defaultDb) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM settlements ORDER BY settlement_id`);
  return rows.map(rowToSettlement);
}

/** @returns {Promise<object|null>} null when the id is unknown — not a stub object. */
export async function getById(id, db = defaultDb) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM settlements WHERE settlement_id = $1`, [
    String(id)
  ]);
  return rows.length ? rowToSettlement(rows[0]) : null;
}

export async function count(db = defaultDb) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM settlements');
  return rows[0].n;
}

export default { rowToSettlement, upsertMany, listAll, getById, count };
