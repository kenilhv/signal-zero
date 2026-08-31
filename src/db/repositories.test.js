// Signal Zero — repository tests. Live database, no fakes.
//
// The contract these tests defend is "the cutover is a swap": a repository
// function must return an object with the same keys, in the same shape, as the
// one src/store.js held. Where that is checked it is checked against the literal
// key list from the pipeline stage that builds the object.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, query, withTransaction } from './pool.js';
import * as checkpoint from './repositories/checkpoint.js';
import * as clusters from './repositories/clusters.js';
import * as incidents from './repositories/incidents.js';
import * as ranked from './repositories/ranked.js';
import * as reports from './repositories/reports.js';
import * as runs from './repositories/runs.js';
import * as settlements from './repositories/settlements.js';
import { cleanup, ensureSchema, makeSettlements, testPrefix } from './test-helpers.js';

const prefix = testPrefix('repo');
const fixtures = makeSettlements(prefix, 3);
const [heard, neverHeard, third] = fixtures;
const runId = `${prefix}-run1`;

before(async () => {
  await ensureSchema();
  await cleanup(prefix);
  await settlements.upsertMany(fixtures);
  await runs.start(runId);
});

after(async () => {
  await cleanup(prefix);
  await closePool();
});

// ---------------------------------------------------------------------------

describe('settlements', () => {
  it('round-trips the gazetteer shape, aliases included', async () => {
    const s = await settlements.getById(heard.id);
    assert.deepEqual(Object.keys(s), [
      'id',
      'name',
      'district',
      'lat',
      'lon',
      'population',
      'hazardTier',
      'aliases'
    ]);
    assert.deepEqual(s.aliases, heard.aliases);
    assert.equal(s.hazardTier, heard.hazardTier);
    assert.equal(s.lat, heard.lat);
  });

  it('returns null for an unknown id rather than a stub', async () => {
    assert.equal(await settlements.getById(`${prefix}-nope`), null);
  });

  it('upsert is idempotent', async () => {
    const before = await settlements.count();
    await settlements.upsertMany(fixtures);
    assert.equal(await settlements.count(), before);
  });
});

// ---------------------------------------------------------------------------

describe('runs', () => {
  it('leaves finishedAt NULL while a run is in flight', async () => {
    const r = await runs.getById(runId);
    assert.equal(r.status, 'running');
    assert.equal(r.finishedAt, null, 'an unfinished run has no finish time');
    assert.equal(r.durationMs, null);
    assert.equal(r.error, null);
  });

  it('reports no stats at all when no pass has ever completed', async () => {
    // Distinct from "a pass completed and every counter was zero".
    const openRun = `${prefix}-open`;
    await runs.start(openRun);
    const r = await runs.getById(openRun);
    assert.equal(r.finishedAt, null);
  });

  it('records duration and stats on finish', async () => {
    await runs.finish(runId, {
      durationMs: 1234,
      stats: { reportCount: 2, clusterCount: 1, rankedCount: 3, pendingCheckpointCount: 1 }
    });
    const r = await runs.getById(runId);
    assert.equal(r.status, 'done');
    assert.equal(r.durationMs, 1234);
    assert.ok(r.finishedAt, 'a finished run has a finish time');
    assert.equal(r.stats.reportCount, 2);

    const stats = await runs.latestStats();
    assert.equal(stats.durationMs, 1234);
    assert.equal(stats.lastRunAt, r.finishedAt);
  });

  it('keeps the error message verbatim on a failed run', async () => {
    const failed = `${prefix}-failed`;
    await runs.start(failed);
    await runs.fail(failed, new Error('Bright Data zone refused the request'));
    const r = await runs.getById(failed);
    assert.equal(r.status, 'error');
    assert.match(r.error, /Bright Data zone refused/);
  });
});

// ---------------------------------------------------------------------------

describe('reports', () => {
  const sample = [
    {
      id: 'rpt-aaa',
      sourceType: 'news',
      sourceName: 'Nepali Times',
      url: 'https://example.test/a',
      title: 'Trishuli flooding',
      text: 'Water levels rose overnight.',
      publishedAt: '2026-08-26T04:00:00.000Z',
      fetchedAt: '2026-08-26T06:00:00.000Z',
      settlementId: null,
      triage: null,
      clusterId: null
    },
    {
      id: 'rpt-bbb',
      sourceType: 'official',
      sourceName: 'DHM',
      url: 'https://example.test/b',
      title: 'Bulletin',
      text: 'Advisory issued.',
      // Unparseable relative date upstream: stays UNKNOWN, never stamped.
      publishedAt: null,
      fetchedAt: '2026-08-26T06:05:00.000Z',
      settlementId: null,
      triage: { category: 'corroboration-candidate', confidence: 0.9, tier: 1 },
      clusterId: 'cl-001'
    }
  ];

  it('round-trips the Report shape exactly', async () => {
    await reports.replaceForRun(runId, sample);
    const back = await reports.listForRun(runId);
    assert.equal(back.length, 2);
    assert.deepEqual(Object.keys(back[0]), [
      'id',
      'sourceType',
      'sourceName',
      'url',
      'title',
      'text',
      'publishedAt',
      'fetchedAt',
      'settlementId',
      'triage',
      'clusterId'
    ]);
    assert.deepEqual(back[0], sample[0]);
    assert.deepEqual(back[1].triage, sample[1].triage);
  });

  it('keeps an unknown publishedAt NULL', async () => {
    const b = await reports.getById(runId, 'rpt-bbb');
    assert.equal(b.publishedAt, null);
    assert.equal(JSON.parse(JSON.stringify(b)).publishedAt, null);
  });

  it('replaceForRun removes reports a re-run no longer produced', async () => {
    await reports.replaceForRun(runId, [sample[0]]);
    assert.equal(await reports.countForRun(runId), 1);
    await reports.replaceForRun(runId, sample);
    assert.equal(await reports.countForRun(runId), 2);
  });
});

// ---------------------------------------------------------------------------

describe('clusters', () => {
  const sample = [
    {
      id: 'cl-001',
      settlementId: heard.id,
      reportIds: ['rpt-aaa', 'rpt-bbb'],
      confidence: 0.91,
      sourceTypeDiversity: 2
    },
    {
      id: 'cl-002',
      settlementId: null,
      reportIds: ['rpt-ccc'],
      confidence: 0.5,
      sourceTypeDiversity: 1
    }
  ];

  it('round-trips the Cluster shape exactly', async () => {
    await clusters.replaceForRun(runId, sample);
    const back = await clusters.listForRun(runId);
    assert.deepEqual(Object.keys(back[0]), [
      'id',
      'settlementId',
      'reportIds',
      'confidence',
      'sourceTypeDiversity'
    ]);
    assert.deepEqual(back, sample);
  });

  it('does not leak the stored size column into the object', async () => {
    const back = await clusters.getById(runId, 'cl-001');
    assert.equal('size' in back, false);
    const { rows } = await query('SELECT size FROM clusters WHERE run_id=$1 AND cluster_id=$2', [
      runId,
      'cl-001'
    ]);
    assert.equal(rows[0].size, 2, 'size is still maintained for cheap counting');
  });
});

// ---------------------------------------------------------------------------

describe('ranked', () => {
  // Two rows. One has been heard from; one NEVER has, and its lastReportAt is
  // the value this entire layer exists to carry intact.
  const rows = [
    {
      settlementId: neverHeard.id,
      rank: 1,
      lastReportAt: null,
      silenceHours: 96.4,
      expectedGapHours: 11.2,
      surprisal: 8.6,
      giZScore: 2.4,
      isLocalAnomaly: true,
      coverageBasis: 'cohort-cold-start',
      corroborationCount: 0,
      cohortKey: 't3-small',
      lambdaPerHour: 0.0893,
      fitBasis: 'cohort',
      cohortSampleGaps: 0,
      reportCount: 0,
      ownZScore: 2.1,
      neighborZScore: 1.4,
      neighborMeanSurprisal: 3.2,
      neighborCount: 2,
      isRegionalOutage: false,
      isSoloAnomaly: true,
      anomalyType: 'solo-anomaly',
      isEscalationCandidate: true
    },
    {
      settlementId: heard.id,
      rank: 2,
      lastReportAt: '2026-08-26T09:15:00.000Z',
      silenceHours: 3.25,
      expectedGapHours: 12,
      surprisal: 0.27,
      giZScore: -0.4,
      isLocalAnomaly: false,
      coverageBasis: 'reports',
      corroborationCount: 2,
      cohortKey: 't2-small',
      lambdaPerHour: 0.0833,
      fitBasis: 'cohort',
      cohortSampleGaps: 4,
      reportCount: 2,
      ownZScore: -0.2,
      neighborZScore: 0.1,
      neighborMeanSurprisal: null,
      neighborCount: 0,
      isRegionalOutage: false,
      isSoloAnomaly: false,
      anomalyType: 'none',
      isEscalationCandidate: false
    }
  ];

  it('round-trips the RankedSettlement shape exactly, key order included', async () => {
    await ranked.replaceForRun(runId, rows);
    const back = await ranked.listForRun(runId);
    assert.equal(back.length, 2);
    assert.deepEqual(Object.keys(back[0]), [
      'settlementId',
      'name',
      'district',
      'lat',
      'lon',
      'population',
      'hazardTier',
      'lastReportAt',
      'silenceHours',
      'expectedGapHours',
      'surprisal',
      'giZScore',
      'isLocalAnomaly',
      'coverageBasis',
      'rank',
      'corroborationCount',
      'cohortKey',
      'lambdaPerHour',
      'fitBasis',
      'cohortSampleGaps',
      'reportCount',
      'ownZScore',
      'neighborZScore',
      'neighborMeanSurprisal',
      'neighborCount',
      'isRegionalOutage',
      'isSoloAnomaly',
      'anomalyType',
      'isEscalationCandidate'
    ]);
    // The gazetteer fields are joined back on, not stored twice.
    assert.equal(back[0].name, neverHeard.name);
    assert.equal(back[0].population, neverHeard.population);
  });

  // === THE TEST THIS WHOLE LAYER EXISTS FOR ================================
  it('a NULL lastReportAt survives the round trip UNCHANGED', async () => {
    const back = await ranked.getForRun(runId, neverHeard.id);

    assert.equal(back.lastReportAt, null, 'must be null');
    assert.notEqual(back.lastReportAt, 0, 'must not be the epoch');
    assert.notEqual(back.lastReportAt, '1970-01-01T00:00:00.000Z');
    assert.equal(typeof back.lastReportAt, 'object', 'null, not a string timestamp');

    // Straight to SQL: the column itself must be NULL, not a sentinel.
    const { rows: raw } = await query(
      'SELECT last_observed_at FROM ranked_snapshots WHERE run_id=$1 AND settlement_id=$2',
      [runId, neverHeard.id]
    );
    assert.equal(raw[0].last_observed_at, null);

    // And through JSON, which is the exact bytes GET /api/state emits.
    const json = JSON.stringify(back);
    assert.match(json, /"lastReportAt":null/);
    assert.equal(JSON.parse(json).lastReportAt, null);

    // A second write/read cycle must not "settle" it into a value.
    await ranked.replaceForRun(runId, [back, ...rows.slice(1)]);
    const again = await ranked.getForRun(runId, neverHeard.id);
    assert.equal(again.lastReportAt, null, 'still null after a second round trip');
  });

  it('a NULL neighborMeanSurprisal is not silently zeroed either', async () => {
    const back = await ranked.getForRun(runId, heard.id);
    assert.equal(back.neighborMeanSurprisal, null);
    assert.notEqual(back.neighborMeanSurprisal, 0);
  });

  it('no SQL in this repository coalesces a timestamp', async () => {
    // A grep is a weak test on its own; it is here because the failure it
    // guards against is a one-word edit that no other assertion would catch.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('./repositories/', import.meta.url));
    for (const f of [
      'ranked.js',
      'observations.js',
      'reports.js',
      'runs.js',
      'checkpoint.js',
      'incidents.js',
      'clusters.js',
      'settlements.js'
    ]) {
      // Comments are stripped first: this file's own prose says the word
      // COALESCE several times to explain why it is absent from the SQL, and a
      // test that fails on its own documentation is a test nobody keeps.
      const src = (await readFile(dir + f, 'utf8'))
        .replace(/^\s*\/\/[^\n]*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      // Precise patterns, not "the word COALESCE". checkpoint.js legitimately
      // coalesces a missing DECISION to 'pending' — a text status where the
      // fallback is the true state. What is banned is substituting a value for
      // an unknown TIME, in SQL or in JS.
      const banned = [
        [/COALESCE\s*\(\s*[\w."]*_at\b/i, 'coalesces a timestamp column'],
        [/COALESCE\s*\(\s*\$\d+\s*::\s*timestamptz/i, 'coalesces a timestamp parameter'],
        [/COALESCE\s*\((?:[^;]{0,250}?)\bnow\s*\(\s*\)/i, 'coalesces to now()'],
        [
          /COALESCE\s*\((?:[^;]{0,250}?)(?:'1970-01-01|to_timestamp\s*\(\s*0)/i,
          'coalesces to the epoch'
        ],
        [/_[aA]t\s*(?:\?\?|\|\|)\s*(?:new Date|Date\.now)/, 'defaults a JS timestamp'],
        [/toIso\([^)]*\)\s*(?:\?\?|\|\|)\s*[^n]/, 'supplies a fallback for a null timestamp']
      ];
      const offenders = banned
        .filter(([re]) => re.test(src))
        .map(([re, why]) => `${why}: ${src.match(re)[0].slice(0, 60)}`);
      assert.deepEqual(offenders, [], `${f} ${offenders.join(' | ')}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('checkpoint', () => {
  const itemId = `${prefix}-esc-1`;

  it('creates a pending item with no approver and no decision time', async () => {
    const created = await checkpoint.create({
      id: itemId,
      runId,
      kind: 'escalation',
      settlementId: neverHeard.id,
      title: 'Anomalous silence: Test Settlement 1',
      evidence: { settlementId: neverHeard.id, lastReportAt: null, silenceHours: 96.4 },
      provenance: {
        source: 'template',
        reason: 'not-attempted',
        agent: null,
        turnId: null,
        guardrails: []
      }
    });
    assert.deepEqual(Object.keys(created), [
      'id',
      'kind',
      'settlementId',
      'title',
      'evidence',
      'provenance',
      'approvedBy',
      'decidedAt',
      'createdAt',
      'status'
    ]);
    assert.equal(created.status, 'pending');
    assert.equal(created.approvedBy, null);
    assert.equal(created.decidedAt, null, 'an undecided item has no decision time');
    assert.equal(created.evidence.lastReportAt, null, 'a null inside evidence survives too');
  });

  it('creation is idempotent per id', async () => {
    const again = await checkpoint.create({ id: itemId, kind: 'escalation', title: 'different' });
    assert.equal(again.title, 'Anomalous silence: Test Settlement 1');
  });

  it('THE DATABASE rejects an anonymous decision', async () => {
    await assert.rejects(
      () => checkpoint.decide({ id: itemId, decision: 'approved', approvedBy: '   ' }),
      (err) => {
        // 23514 check_violation. Not an application-level 400 — the schema.
        assert.equal(err.code, '23514', `expected a CHECK violation, got ${err.code}`);
        return true;
      }
    );
    await assert.rejects(
      () => checkpoint.decide({ id: itemId, decision: 'approved', approvedBy: null }),
      (err) => {
        assert.equal(err.code, '23502', `expected NOT NULL violation, got ${err.code}`);
        return true;
      }
    );
    const still = await checkpoint.getById(itemId);
    assert.equal(still.status, 'pending', 'a rejected decision must not move the status');
  });

  it('a decision goes through the append-only log and status follows it', async () => {
    const decided = await checkpoint.decide({
      id: itemId,
      decision: 'approved',
      approvedBy: 'Anita Gurung',
      shortlist: [{ jurisdiction: 'Rasuwa DDMC' }]
    });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.approvedBy, 'Anita Gurung');
    assert.ok(decided.decidedAt);

    const log = await checkpoint.listDecisions(itemId);
    assert.equal(log.length, 1);
    assert.equal(log[0].approvedBy, 'Anita Gurung');
    assert.deepEqual(log[0].shortlist, [{ jurisdiction: 'Rasuwa DDMC' }]);
  });

  it('status is a PROJECTION: it is recomputed from the log, never set directly', async () => {
    // Corrupt the projection behind the repository's back, then append a
    // decision. If status were stored independently the corruption would
    // survive; because it is reprojected from the log, it is repaired.
    await query(`UPDATE checkpoint_items SET status = 'pending' WHERE id = $1`, [itemId]);
    assert.equal((await checkpoint.getById(itemId)).status, 'pending');

    await checkpoint.decide({ id: itemId, decision: 'rejected', approvedBy: 'Bikash Thapa' });
    const after = await checkpoint.getById(itemId);
    assert.equal(after.status, 'rejected', 'projection follows the LATEST approval');
    assert.equal(after.approvedBy, 'Bikash Thapa');

    const log = await checkpoint.listDecisions(itemId);
    assert.equal(log.length, 2, 'the earlier decision is still in the log — append-only');
    assert.equal(log[0].approvedBy, 'Anita Gurung');
  });

  it('countPending sees the item is no longer pending', async () => {
    const pending = await checkpoint.list({ status: 'pending', settlementId: neverHeard.id });
    assert.equal(pending.length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('incidents', () => {
  const N = 250; // more than the 200-item ring buffer this replaces

  it('keeps every incident — the 201st is not discarded', async () => {
    const base = Date.parse('2026-08-26T00:00:00.000Z');
    for (let i = 0; i < N; i++) {
      await incidents.append(
        'degraded-source',
        `failure ${i}`,
        { i },
        { id: `${prefix}-inc-${String(i).padStart(4, '0')}`, runId, at: new Date(base + i * 1000) }
      );
    }
    const { rows } = await query('SELECT count(*)::int n FROM incidents WHERE id LIKE $1', [
      `${prefix}-inc-%`
    ]);
    assert.equal(rows[0].n, N, 'nothing truncated');
  });

  it('returns the store IncidentEvent shape', async () => {
    const page = await incidents.list({ runId, limit: 1 });
    assert.deepEqual(Object.keys(page.items[0]), ['id', 'at', 'kind', 'message', 'detail']);
    assert.equal(page.items[0].message, `failure ${N - 1}`, 'newest first');
  });

  it('pages by keyset without repeating or skipping a row', async () => {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await incidents.list({ runId, limit: 40, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages < 20, 'pagination must terminate');
    } while (cursor);

    assert.equal(seen.length, N);
    assert.equal(new Set(seen).size, N, 'no duplicates across pages');
    const sorted = [...seen].sort().reverse();
    assert.deepEqual(seen, sorted, 'strictly descending by (at, id)');
  });

  it('a new incident landing mid-read does not shift the cursor', async () => {
    // The failure OFFSET pagination has: page 2 re-shows rows from page 1.
    const first = await incidents.list({ runId, limit: 10 });
    await incidents.append('heal', 'arrived mid-read', {}, { id: `${prefix}-inc-9999`, runId });
    const second = await incidents.list({ runId, limit: 10, cursor: first.nextCursor });
    const overlap = second.items.filter((i) => first.items.some((f) => f.id === i.id));
    assert.deepEqual(overlap, [], 'keyset pages cannot overlap');
  });

  it('nextCursor is null on the last page', async () => {
    const page = await incidents.list({ runId, limit: 500 });
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
  });
});

// ---------------------------------------------------------------------------

describe('transaction composition', () => {
  it('one transaction spans several repositories and rolls back as a unit', async () => {
    const txRun = `${prefix}-tx`;
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await runs.start(txRun, tx);
          await reports.replaceForRun(
            txRun,
            [
              {
                id: 'rpt-tx',
                sourceType: 'news',
                sourceName: 'x',
                url: 'https://example.test/tx',
                title: 't',
                text: 'b',
                publishedAt: null,
                fetchedAt: '2026-08-26T06:00:00.000Z',
                settlementId: third.id,
                triage: null,
                clusterId: null
              }
            ],
            tx
          );
          throw new Error('stage 4 exploded');
        }),
      /stage 4 exploded/
    );
    assert.equal(await runs.getById(txRun), null, 'the run row rolled back with the reports');
  });
});
