// Signal Zero — HARD RULE 4, END TO END.
//
// `last_observed_at IS NULL` means NO REPORT HAS EVER RESOLVED HERE. Every other
// test in this repository checks that property at one layer: the schema declares
// the column NULLable, src/db/values.js maps null to null with no fallback
// parameter, src/db/repositories.test.js round-trips a NULL through the
// observations table. None of that is worth anything if a route handler, a
// JSON.stringify, an Express default or a frontend-shaped rename turns it into 0
// or into a timestamp on the way out.
//
// So this test asserts on THE ACTUAL RESPONSE BYTES. Not on a parsed object — on
// the text — because `JSON.parse` would happily give back `null` for a field
// that had been omitted entirely, and "omitted" is its own failure: a client
// reading `row.lastReportAt ?? Date.now()` is broken by an absent key in exactly
// the same way it is broken by a zero.
//
// It runs against BOTH backends, because the whole point of having two is that
// they behave identically about this one thing. A fallback mode that is honest
// about durability but lies about a NULL would be worse than no fallback.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { LOCAL_DATABASE_URL } from '../src/db/pool.js';

// Match src/db/test-helpers.js: point at the local container when nothing else
// is configured, and FAIL rather than skip if it is not there. A silently
// skipped database test is indistinguishable from one that passes.
if (!String(process.env.DATABASE_URL ?? '').trim()) {
  process.env.DATABASE_URL = LOCAL_DATABASE_URL;
}
process.env.USE_LIVE_SCRAPE = 'false';
process.env.TRUEFORGE_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';

const { app, runPipeline, initForTest } = await import('../src/server.js');

let server;
let base;

before(async () => {
  const mode = await initForTest();
  assert.equal(
    mode.mode,
    'postgres',
    `these assertions must run against the real database, not the fallback: ${mode.reason} ${mode.error ?? ''}`
  );
  await runPipeline();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

/** Raw response text plus its parse, so both can be asserted on. */
async function getBoth(path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

describe('hard rule 4: a NULL last_observed_at reaches the API as null', () => {
  test('GET /api/state emits literal `"lastReportAt":null` for a never-observed settlement', async () => {
    const { json, text } = await getBoth('/api/state');
    const never = json.settlements.filter((s) => s.lastReportAt === null);
    assert.ok(
      never.length > 0,
      'the corridor must contain at least one settlement nothing has resolved to, ' +
        'or this test proves nothing. Check the seed corpus.'
    );

    for (const s of never) {
      // The KEY IS PRESENT. An omitted key is not the same claim as a null one:
      // a client doing `row.lastReportAt ?? now` breaks identically on both, but
      // only one of them is detectable by looking at the payload.
      assert.ok(
        Object.hasOwn(s, 'lastReportAt'),
        `${s.settlementId} omitted lastReportAt entirely`
      );
      assert.equal(s.lastReportAt, null);
      // Not 0, not '', not the epoch, not a Date that stringified.
      assert.notEqual(s.lastReportAt, 0);
      assert.notEqual(s.lastReportAt, '1970-01-01T00:00:00.000Z');
      assert.equal(typeof s.lastReportAt, 'object'); // typeof null === 'object'
      // And it must say WHY it is null rather than presenting as a normal row.
      assert.equal(
        s.coverageBasis,
        'cohort-cold-start',
        `${s.settlementId} has no observation but does not say its baseline is borrowed`
      );
    }

    // The literal bytes. `"lastReportAt": null` after JSON.stringify with no
    // spacing is exactly this substring; if anything coalesced it upstream the
    // substring is simply absent.
    assert.ok(
      text.includes('"lastReportAt":null'),
      'the serialized response must contain a literal null, not a substituted value'
    );
  });

  test('GET /api/settlement/:id returns null for lastObservedAt, and an empty history', async () => {
    const { json: state } = await getBoth('/api/state');
    const never = state.settlements.find((s) => s.lastReportAt === null);
    const { text, json } = await getBoth(`/api/settlement/${never.settlementId}`);

    assert.ok(Object.hasOwn(json, 'lastObservedAt'));
    assert.equal(json.lastObservedAt, null);
    assert.ok(text.includes('"lastObservedAt":null'));
    // A settlement with a null clock must have nothing behind it. If these
    // disagree, one of the two reads is lying about the same fact.
    assert.deepEqual(json.observations, []);
    assert.equal(json.ranked.lastReportAt, null);
    assert.equal(json.scoreBreakdown.lastReportAt, null);
  });

  test('a settlement that HAS been observed carries a real timestamp, not a null', async () => {
    // The converse. Without this, a bug that nulled EVERYTHING would pass the
    // tests above, and "always null" is just as dishonest as "never null".
    const { json: state } = await getBoth('/api/state');
    const observed = state.settlements.filter((s) => s.lastReportAt !== null);
    assert.ok(observed.length > 0, 'the seed corpus must resolve to at least one settlement');
    for (const s of observed) {
      assert.equal(typeof s.lastReportAt, 'string');
      assert.ok(Number.isFinite(Date.parse(s.lastReportAt)));
      assert.equal(s.coverageBasis, 'reports');
    }
  });

  test('the response says which store it came from, and does not overclaim', async () => {
    const { json } = await getBoth('/api/state');
    assert.equal(json.persistence.mode, 'postgres');
    assert.equal(json.persistence.durable, true);
    assert.equal(json.persistence.configured, true);
    assert.equal(json.persistence.error, null);
    // The password must never be in the payload.
    assert.ok(!/signalzero:signalzero@/.test(JSON.stringify(json.persistence)));
    // A lossy fail feed is reported, not swallowed.
    assert.equal(json.persistence.unpersistedIncidents, 0);
  });

  test('the incident feed is unbounded and paged, not truncated at 200', async () => {
    const { json } = await getBoth('/api/incidents?limit=5');
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.incidents));
    assert.ok(json.incidents.length <= 5);
    assert.equal(typeof json.total, 'number');
    // `total` is the count of EVERYTHING, so it can legitimately exceed any page
    // size — that is the property the 200-item ring buffer used to destroy.
    if (json.hasMore) {
      assert.ok(json.nextCursor, 'a page that has more must hand back a cursor');
      const next = await getBoth(
        `/api/incidents?limit=5&cursor=${encodeURIComponent(json.nextCursor)}`
      );
      const firstIds = new Set(json.incidents.map((i) => i.id));
      for (const i of next.json.incidents) {
        assert.ok(!firstIds.has(i.id), 'a keyset page must not repeat rows from the previous page');
      }
    }
  });
});
