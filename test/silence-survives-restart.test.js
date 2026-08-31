// Signal Zero — the silence clock reads OBSERVATIONS, not this pass's reports.
//
// scripts/restart-check.mjs proves this end to end by actually killing a
// process. This file proves the same property deterministically and in
// milliseconds, at the seam where it is decided: rank()'s `opts.observations`.
//
// The distinction being tested is exact. Before this phase, `silenceHours` was
// derived from the reports of the pass currently running, so:
//
//   * a restart threw the history away, and
//   * a pass whose ingest returned nothing — a source outage, which is the
//     usual reason for a restart — reset every settlement to ~0h with
//     lastReportAt null, i.e. the system forgot every silence it had measured
//     at exactly the moment those silences mattered most.
//
// After: the observations table is the input, so an empty pass leaves the clock
// running from the last real sighting. That is the whole phase in one assertion.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { rank } from '../src/pipeline/rank.js';

const HOUR = 3_600_000;
const NOW_MS = Date.UTC(2026, 7, 30, 12, 0, 0);
const NOW = new Date(NOW_MS);

const settlements = [
  {
    id: 's1',
    name: 'One',
    district: 'Rasuwa',
    lat: 28.1,
    lon: 85.3,
    population: 4000,
    hazardTier: 3
  },
  {
    id: 's2',
    name: 'Two',
    district: 'Rasuwa',
    lat: 28.2,
    lon: 85.4,
    population: 4000,
    hazardTier: 3
  },
  {
    id: 's3',
    name: 'Three',
    district: 'Nuwakot',
    lat: 28.3,
    lon: 85.5,
    population: 4000,
    hazardTier: 3
  }
];
const adjacency = { s1: ['s2'], s2: ['s1', 's3'], s3: ['s2'] };

/** Observation rows in the shape src/db/repositories/observations.js returns. */
function obs(settlementId, hoursAgo, i) {
  return {
    settlementId,
    observedAt: new Date(NOW_MS - hoursAgo * HOUR).toISOString(),
    sourceName: 'Wire',
    sourceType: 'news',
    reportId: `r-${settlementId}-${i}`,
    clusterId: `c-${settlementId}-${i}`
  };
}

const byId = (rows) => new Map(rows.map((r) => [r.settlementId, r]));

describe('the silence clock is derived from persisted observations', () => {
  test('with NO reports this pass, silence still runs from the last observation', () => {
    // This is the restart: process came up, ingest returned nothing, and the
    // only thing it has is the fact table.
    const history = [obs('s1', 30, 0), obs('s1', 54, 1), obs('s2', 4, 0)];
    const ranked = byId(
      rank(settlements, [], [], NOW, { adjacency, observations: history, emitIncidents: false })
    );

    assert.equal(ranked.get('s1').silenceHours, 30);
    assert.equal(ranked.get('s1').lastReportAt, new Date(NOW_MS - 30 * HOUR).toISOString());
    assert.equal(ranked.get('s1').coverageBasis, 'reports');

    assert.equal(ranked.get('s2').silenceHours, 4);
    assert.equal(ranked.get('s2').coverageBasis, 'reports');

    // s3 has never been observed. It must stay honestly unknown — this is the
    // one that must NOT be backfilled with a timestamp.
    assert.equal(ranked.get('s3').lastReportAt, null);
    assert.equal(ranked.get('s3').coverageBasis, 'cohort-cold-start');
  });

  test('the same empty pass WITHOUT observations resets the clock — the bug being fixed', () => {
    // The control. Without persisted history, an empty pass opens its
    // observation window at `now` and every settlement reads as freshly silent.
    // Printing this next to the assertion above is what makes the one above mean
    // something: if this ever started passing the same way, the test would be
    // asserting a tautology.
    const ranked = byId(rank(settlements, [], [], NOW, { adjacency, emitIncidents: false }));
    for (const row of ranked.values()) {
      assert.equal(row.lastReportAt, null, 'no persisted history means no known last report');
      assert.equal(row.silenceHours, 0, 'and the clock starts from this pass, not from the past');
    }
  });

  test('silence accrues across passes: a later `now` against the same history grows', () => {
    const history = [obs('s1', 30, 0)];
    const first = byId(
      rank(settlements, [], [], NOW, { adjacency, observations: history, emitIncidents: false })
    );
    const sixHoursLater = new Date(NOW_MS + 6 * HOUR);
    const second = byId(
      rank(settlements, [], [], sixHoursLater, {
        adjacency,
        observations: history,
        emitIncidents: false
      })
    );

    assert.equal(first.get('s1').silenceHours, 30);
    assert.equal(second.get('s1').silenceHours, 36);
    // Continued from the SAME anchor rather than re-anchoring to the new `now`.
    assert.equal(second.get('s1').lastReportAt, first.get('s1').lastReportAt);
  });

  test('a report already written as an observation is not counted twice', () => {
    // The orchestrator writes observations BEFORE it reads them back and calls
    // rank, so rank receives both. Counting each sighting once is what keeps
    // reportCount honest and stops a fabricated zero-length gap from dragging
    // the fitted rate up.
    const history = [obs('s1', 30, 0), obs('s1', 54, 1)];
    const reports = history.map((o) => ({
      id: o.reportId,
      settlementId: o.settlementId,
      sourceName: o.sourceName,
      sourceType: o.sourceType,
      publishedAt: o.observedAt,
      fetchedAt: o.observedAt,
      clusterId: o.clusterId
    }));

    const withBoth = byId(
      rank(settlements, [], reports, NOW, {
        adjacency,
        observations: history,
        emitIncidents: false
      })
    );
    const withHistoryOnly = byId(
      rank(settlements, [], [], NOW, { adjacency, observations: history, emitIncidents: false })
    );

    assert.equal(withBoth.get('s1').reportCount, 2, 'two sightings, not four');
    assert.equal(withBoth.get('s1').reportCount, withHistoryOnly.get('s1').reportCount);
    assert.equal(withBoth.get('s1').silenceHours, withHistoryOnly.get('s1').silenceHours);
    assert.equal(withBoth.get('s1').lambdaPerHour, withHistoryOnly.get('s1').lambdaPerHour);
  });

  test('an observation with an unreadable time is dropped, never given a substitute', () => {
    // requireIso would have refused to write such a row in the first place; this
    // covers the read path, where the temptation is a defensive `?? Date.now()`.
    const history = [
      { settlementId: 's1', observedAt: null, sourceName: 'X', sourceType: 'news' },
      { settlementId: 's1', observedAt: 'not a date', sourceName: 'X', sourceType: 'news' },
      obs('s2', 10, 0)
    ];
    const ranked = byId(
      rank(settlements, [], [], NOW, { adjacency, observations: history, emitIncidents: false })
    );

    // s1 had two unusable rows and nothing else: it is UNOBSERVED, not observed
    // at the epoch and not observed now.
    assert.equal(ranked.get('s1').lastReportAt, null);
    assert.equal(ranked.get('s1').coverageBasis, 'cohort-cold-start');
    assert.equal(ranked.get('s1').reportCount, 0);
    assert.equal(ranked.get('s2').silenceHours, 10);
  });
});
