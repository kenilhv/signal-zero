// Signal Zero — observations repository tests, including the query plan.
//
// The brief for this layer says: do not claim a query is indexed without showing
// the plan. So the plan is asserted here, against the live database, at a volume
// where a sequential scan would be a plausible choice for the planner.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, query } from './pool.js';
import * as observations from './repositories/observations.js';
import * as settlements from './repositories/settlements.js';
import { cleanup, ensureSchema, makeSettlements, testPrefix } from './test-helpers.js';

const prefix = testPrefix('obs');
const fixtures = makeSettlements(prefix, 4);
const [withMany, withOne, silent, alsoSilent] = fixtures;

// Enough rows that the planner has a real choice to make. At 20 rows it would
// pick a Seq Scan and the assertion below would prove nothing.
const BULK_ROWS = 6000;

before(async () => {
  await ensureSchema();
  await cleanup(prefix);
  await settlements.upsertMany(fixtures);

  await query(
    `INSERT INTO observations (settlement_id, observed_at, source_name, source_type, report_id)
     SELECT $1,
            timestamptz '2026-08-01 00:00:00+00' + (g || ' minutes')::interval,
            'Bulk Source', 'news', 'rpt-' || g
       FROM generate_series(1, $2) AS g`,
    [withMany.id, BULK_ROWS]
  );
  await observations.append({
    settlementId: withOne.id,
    observedAt: '2026-08-26T09:15:00.000Z',
    sourceName: 'Nepali Times',
    sourceType: 'news',
    reportId: 'rpt-single',
    url: 'https://example.test/one',
    title: 'One observation'
  });
  // `silent` and `alsoSilent` deliberately get NOTHING.
  await query(`ANALYZE observations`);
  await query(`ANALYZE settlements`);
});

after(async () => {
  await cleanup(prefix);
  await closePool();
});

describe('observations: append-only writes', () => {
  it('round-trips an observation', async () => {
    const o = await observations.latestForSettlement(withOne.id);
    assert.equal(o.lastObservedAt, '2026-08-26T09:15:00.000Z');
    assert.equal(o.sourceName, 'Nepali Times');
    assert.equal(o.title, 'One observation');
    assert.equal(o.clusterId, null, 'an unset cluster stays null, not an empty string');
  });

  it('refuses to invent a timestamp for an unparseable one', async () => {
    // A report whose date could not be parsed must get NO row. Writing it with
    // the fetch time would credit the settlement with an observation it never
    // made, which is the coalesce failure at the write end of the pipe.
    await assert.rejects(
      () =>
        observations.append({
          settlementId: silent.id,
          observedAt: null,
          sourceName: 'x',
          sourceType: 'news'
        }),
      /must be a real timestamp/
    );
    await assert.rejects(
      () =>
        observations.append({
          settlementId: silent.id,
          observedAt: '2 days ago',
          sourceName: 'x',
          sourceType: 'news'
        }),
      /must be a real timestamp/
    );
    const still = await observations.latestForSettlement(silent.id);
    assert.equal(still.lastObservedAt, null, 'the rejected write left no trace');
  });

  it('rejects a whole batch when one row has an unreadable timestamp', async () => {
    await assert.rejects(
      () =>
        observations.appendMany([
          {
            settlementId: silent.id,
            observedAt: '2026-08-26T00:00:00Z',
            sourceName: 'a',
            sourceType: 'news'
          },
          { settlementId: silent.id, observedAt: 'sometime', sourceName: 'b', sourceType: 'news' }
        ]),
      /observations\[1\]\.observedAt/
    );
    const still = await observations.latestForSettlement(silent.id);
    assert.equal(still.lastObservedAt, null, 'no partial batch was written');
  });
});

describe('observations: latest per settlement', () => {
  it('returns every settlement, including the ones nothing ever resolved to', async () => {
    const rows = await observations.latestPerSettlement();
    const mine = new Map(
      rows.filter((r) => r.settlementId.startsWith(prefix)).map((r) => [r.settlementId, r])
    );
    assert.equal(mine.size, 4, 'a settlement with no observations must still appear');
  });

  it('gives NULL — not epoch, not now() — for a settlement with no observations', async () => {
    const rows = await observations.latestPerSettlement();
    const byId = new Map(rows.map((r) => [r.settlementId, r]));

    for (const s of [silent, alsoSilent]) {
      const row = byId.get(s.id);
      assert.equal(row.lastObservedAt, null, `${s.id} must report null`);
      assert.notEqual(row.lastObservedAt, 0);
      assert.equal(row.observationId, null);
      assert.equal(row.sourceName, null);
      assert.equal(row.recordedAt, null);
      // And it must survive JSON, which is where the API hands it to the UI.
      assert.equal(JSON.parse(JSON.stringify(row)).lastObservedAt, null);
    }
  });

  it('picks the newest observation, not the first or the last inserted', async () => {
    const row = await observations.latestForSettlement(withMany.id);
    const expected = new Date(
      Date.parse('2026-08-01T00:00:00.000Z') + BULK_ROWS * 60_000
    ).toISOString();
    assert.equal(row.lastObservedAt, expected);
  });

  it('uses observations_settlement_time_idx — plan asserted, not assumed', async () => {
    const { rows } = await query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${observations.latestPerSettlementSql}`
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');

    assert.match(
      plan,
      /Index Scan Backward using observations_settlement_time_idx|Index Scan using observations_settlement_time_idx/,
      `expected an index scan on observations_settlement_time_idx, got:\n${plan}`
    );
    assert.doesNotMatch(
      plan,
      /Seq Scan on observations/,
      `the whole point of the LATERAL LIMIT 1 is to avoid scanning observations:\n${plan}`
    );
    // The one Sort node in this plan is on s.settlement_id, for the outer
    // ORDER BY over the ~30-row gazetteer. What must NEVER appear is a sort on
    // observed_at: that would mean the index stopped providing the ordering and
    // Postgres started sorting the fact table per settlement.
    assert.doesNotMatch(
      plan,
      /Sort Key:[^\n]*observed_at/,
      `the index already provides the observed_at ordering; sorting it means the plan regressed:\n${plan}`
    );
    assert.match(plan, /Index Cond: \(settlement_id = s\.settlement_id\)/, plan);
  });

  it('the plan is a per-settlement probe, not a full pass over the fact table', async () => {
    const { rows } = await query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${observations.latestPerSettlementSql}`
    );
    const root = rows[0]['QUERY PLAN'][0].Plan;
    const stack = [root];
    let indexNode = null;
    while (stack.length) {
      const n = stack.pop();
      if (String(n['Index Name'] ?? '') === 'observations_settlement_time_idx') indexNode = n;
      for (const c of n.Plans ?? []) stack.push(c);
    }
    assert.ok(indexNode, 'the index node must be in the plan');
    // One row fetched per probe, regardless of how many observations exist.
    assert.equal(indexNode['Actual Rows'] <= 1.5, true, JSON.stringify(indexNode));
  });
});
