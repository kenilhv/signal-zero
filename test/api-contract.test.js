// Signal Zero — the HTTP CONTRACT, asserted against the running app.
//
// Four things changed shape when the store went to Postgres and the pipeline
// pass stopped fitting inside a request, and each of them is a contract a client
// writes code against rather than an implementation detail:
//
//   1. KEYSET PAGINATION on the incident feed. The 200-item ring buffer is gone,
//      so the feed is unbounded and the READ is what gets bounded. The property
//      worth testing is not "a page is returned" — it is that walking the cursor
//      visits every row exactly once, including when incidents share a timestamp,
//      which during a failure cascade is the normal case rather than the edge one.
//   2. ASYNC RUN. POST /api/run answers 202 with a run id; progress is read from
//      GET /api/state. The thing to prove is that the id is followable and that
//      progress is reported rather than invented.
//   3. IDEMPOTENCY KEYS, Stripe's convention. Same key + same body replays; same
//      key + different body is refused. The load-bearing assertion is at the
//      append-only decision log: one click, one signature.
//   4. RFC 9457 PROBLEM DETAILS. One media type, one shape, and a `type` URI that
//      dereferences.
//
// Runs in MEMORY MODE, deliberately. Everything here is a property of the HTTP
// layer that both backends must agree on, and memory mode lets the feed be seeded
// with an exact, known number of incidents — which is what makes the pagination
// assertions arithmetic rather than approximate. Durability is a different claim
// and is tested by test/silence-survives-restart.test.js against a real database.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

// Cleared BEFORE src/server.js is imported: src/db/pool.js reads it at selection
// time, and dotenv would otherwise load the developer's .env.
process.env.DATABASE_URL = '';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.USE_LIVE_SCRAPE = 'false';
process.env.TRUEFORGE_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';

const { app, runPipeline, initForTest } = await import('../src/server.js');
const { addIncident, flushIncidents } = await import('../src/store.js');

/** How many extra incidents this file seeds, on top of whatever a pass raises. */
const SEEDED = 260;

let server;
let base;

before(async () => {
  process.env.DATABASE_URL = '';
  await initForTest();
  await runPipeline();

  // Seed a feed larger than any single page. HALF OF THEM SHARE ONE TIMESTAMP on
  // purpose: `(at, id)` keyset paging is exactly the thing that goes subtly wrong
  // when the sort key is not unique, and a feed written in a tight loop during a
  // cascade produces ties constantly. A test that only ever saw distinct
  // timestamps would pass against a broken `at < cursor` implementation.
  const tie = new Date('2026-08-26T06:00:00.000Z').toISOString();
  for (let i = 0; i < SEEDED; i += 1) {
    const at = i % 2 === 0 ? tie : new Date(Date.parse(tie) + i * 1000).toISOString();
    const ev = addIncident('degraded-source', `seeded incident ${i}`, { seeded: true, i });
    ev.at = at;
  }
  await flushIncidents();

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

async function req(path, opts = {}) {
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return {
    status: res.status,
    text,
    json,
    contentType: res.headers.get('content-type') || '',
    headers: res.headers
  };
}

const post = (path, body, headers = {}) =>
  req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {})
  });

// ---------------------------------------------------------------------------
// 1. Keyset pagination
// ---------------------------------------------------------------------------

describe('the incident feed is unbounded and keyset-paged', () => {
  test('walking the cursor to the end visits every incident EXACTLY once, ties included', async () => {
    const seen = [];
    const ids = new Set();
    let cursor = null;
    let pages = 0;

    for (;;) {
      const q = `/api/incidents?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { status, json } = await req(q);
      assert.equal(status, 200);
      pages += 1;
      for (const inc of json.incidents) {
        // THE ASSERTION THAT CATCHES A BROKEN CURSOR. An `at < $1` predicate
        // instead of a row comparison silently skips rows that share a timestamp;
        // an OFFSET-based pager repeats them. Both show up here.
        assert.ok(!ids.has(inc.id), `incident ${inc.id} was served on two pages`);
        ids.add(inc.id);
        seen.push(inc);
      }
      if (!json.hasMore) {
        assert.equal(json.nextCursor, null, 'the last page must hand back a null cursor');
        break;
      }
      assert.ok(json.nextCursor, 'a page with more after it must hand back a cursor');
      cursor = json.nextCursor;
      assert.ok(pages < 200, 'the cursor walk did not terminate');
    }

    const { json: head } = await req('/api/incidents?limit=1');
    assert.equal(
      seen.length,
      head.total,
      'the walk must visit every row the feed says it holds — nothing skipped, nothing truncated'
    );
    assert.ok(head.total >= SEEDED, 'the seeded incidents must all still be there');
  });

  test('the page is newest-first and the cursor never goes backwards', async () => {
    const { json } = await req('/api/incidents?limit=50');
    for (let i = 1; i < json.incidents.length; i += 1) {
      const prev = json.incidents[i - 1];
      const cur = json.incidents[i];
      // Newest first: `at` DESC, and `id` DESC as the tiebreak. Both halves are
      // descending — an ascending tiebreak here would have silently accepted a
      // feed whose ties came back in the wrong order.
      const ord = prev.at === cur.at ? prev.id.localeCompare(cur.id) : cur.at < prev.at ? 1 : -1;
      assert.ok(
        ord > 0,
        `feed order broke at index ${i}: ${prev.at}/${prev.id} then ${cur.at}/${cur.id}`
      );
    }
  });

  test('the default and maximum page sizes are published in the response, not just in the docs', async () => {
    const { json } = await req('/api/incidents');
    assert.equal(json.pageSizeDefault, 100);
    assert.equal(json.pageSizeMaximum, 500);
    assert.equal(json.pageSize, 100);
    assert.equal(json.pageSizeSource, 'default');
    assert.equal(json.incidents.length, 100);

    const { json: explicit } = await req('/api/incidents?limit=7');
    assert.equal(explicit.pageSize, 7);
    assert.equal(explicit.pageSizeSource, 'request');
    assert.equal(explicit.incidents.length, 7);
  });

  test('an over-limit page size is REFUSED, not silently clamped', async () => {
    // Clamping would hand back 500 rows to a caller who asked for 5000 and said
    // nothing, and that caller cannot tell a clamped page from a complete feed.
    const { status, json, contentType } = await req('/api/incidents?limit=5000');
    assert.equal(status, 400);
    assert.match(contentType, /^application\/problem\+json/);
    assert.equal(json.type, '/problems/invalid-page-size');
    assert.equal(json.requested, 5000);
    assert.equal(json.maximum, 500);

    for (const bad of ['0', '-1', '12abc', 'ten', '1.5']) {
      const r = await req(`/api/incidents?limit=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `limit=${bad} must be refused`);
      assert.equal(r.json.type, '/problems/invalid-page-size');
    }
  });

  test('an unreadable cursor is refused rather than quietly re-serving page one', async () => {
    const { status, json } = await req('/api/incidents?cursor=garbage');
    assert.equal(status, 400);
    assert.equal(json.type, '/problems/invalid-cursor');
  });

  test('GET /api/state carries ONE PAGE plus the count of everything, and says which', async () => {
    const { json } = await req('/api/state');
    assert.equal(json.incidentPageSize, 200);
    assert.equal(json.incidents.length, 200);
    // The count is of the whole table and legitimately exceeds the page. This is
    // the property the 200-item ring buffer destroyed: back then 200 was ALL of
    // them, because the 201st had been thrown away.
    assert.ok(json.incidentTotal > json.incidents.length);
    assert.equal(json.incidentHasMore, true);
    assert.ok(json.incidentCursor, 'a truncated page must hand back a cursor to walk the rest');

    const rest = await req(`/api/incidents?cursor=${encodeURIComponent(json.incidentCursor)}`);
    const firstIds = new Set(json.incidents.map((i) => i.id));
    for (const inc of rest.json.incidents) {
      assert.ok(!firstIds.has(inc.id), 'the continuation must not repeat rows from /api/state');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Async run + progress
// ---------------------------------------------------------------------------

describe('POST /api/run is asynchronous and its progress is readable', () => {
  test('it answers 202 with a followable run id and a Location header', async () => {
    const res = await post('/api/run');
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('location'), '/api/state');
    assert.equal(res.json.ok, true);
    assert.equal(res.json.status, 'accepted');
    assert.equal(typeof res.json.runId, 'string');
    assert.ok(res.json.runId.startsWith('run-'));

    // FOLLOWABLE: the id in the 202 is the id GET /api/state reports on. An id a
    // caller cannot follow would make the async contract worse than the blocking
    // call it replaced.
    const state = await req('/api/state');
    assert.equal(state.json.run.runId, res.json.runId);
    assert.ok(['running', 'done', 'error'].includes(state.json.run.status));

    // Let the pass finish so it cannot bleed into the next test.
    for (let i = 0; i < 300; i += 1) {
      const s = await req('/api/state');
      if (s.json.run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test('progress reports only stages the server actually ran, and never invents one', async () => {
    const started = await post('/api/run');
    assert.equal(started.status, 202);

    const stagesSeen = new Set();
    let final = null;
    for (let i = 0; i < 400; i += 1) {
      const { json } = await req('/api/state');
      const run = json.run;
      assert.equal(run.runId, started.json.runId);
      // Every stage it names must be one the server publishes. A rail row the
      // server does not run is a fabricated progress bar.
      if (run.stage !== null) {
        assert.ok(run.stages.includes(run.stage), `unknown stage "${run.stage}"`);
        stagesSeen.add(run.stage);
      }
      for (const done of run.stagesCompleted) assert.ok(run.stages.includes(done));
      // `stagesCompleted` only ever grows within one run.
      if (final) assert.ok(run.stagesCompleted.length >= final.stagesCompleted.length);
      final = run;
      if (run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(final.status, 'done');
    assert.equal(final.stage, null, 'a finished pass is in no stage');
    assert.deepEqual(
      final.stagesCompleted,
      final.stages,
      'a pass that completed must report every stage as completed'
    );
    assert.equal(typeof final.durationMs, 'number');
    assert.equal(final.error, null);
  });

  test('a second run while one is in flight is refused with a problem document naming the first', async () => {
    const [a, b] = await Promise.all([post('/api/run'), post('/api/run')]);
    const accepted = [a, b].find((r) => r.status === 202);
    const refused = [a, b].find((r) => r.status === 409);
    assert.ok(accepted, 'one of two concurrent runs must be accepted');
    assert.ok(refused, 'the other must be refused');
    assert.match(refused.contentType, /^application\/problem\+json/);
    assert.equal(refused.json.type, '/problems/pipeline-run-in-flight');
    // It names the run that is holding the slot, which the old {ok:false,error}
    // body could not do.
    assert.equal(refused.json.runId, accepted.json.runId);

    for (let i = 0; i < 300; i += 1) {
      const s = await req('/api/state');
      if (s.json.run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotency keys — Stripe's convention, NOT an IETF standard
// ---------------------------------------------------------------------------

describe('idempotency keys on the routes that change something', () => {
  test('same key + same body replays the stored response byte for byte', async () => {
    const key = `test-run-${Date.now().toString(36)}`;
    const first = await post('/api/run', {}, { 'Idempotency-Key': key });
    const replay = await post('/api/run', {}, { 'Idempotency-Key': key });

    assert.equal(first.status, 202);
    assert.equal(replay.status, 202);
    assert.equal(replay.text, first.text, 'a replay must be the stored bytes, not a re-render');
    assert.equal(first.headers.get('idempotent-replayed'), 'false');
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(replay.headers.get('idempotency-key'), key);

    for (let i = 0; i < 300; i += 1) {
      const s = await req('/api/state');
      if (s.json.run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test('same key + different body is refused with 409, not replayed', async () => {
    const key = `test-reuse-${Date.now().toString(36)}`;
    const first = await post('/api/run', {}, { 'Idempotency-Key': key });
    assert.equal(first.status, 202);
    const reused = await post('/api/run', { different: true }, { 'Idempotency-Key': key });
    assert.equal(reused.status, 409);
    assert.equal(reused.json.type, '/problems/idempotency-key-reuse');

    for (let i = 0; i < 300; i += 1) {
      const s = await req('/api/state');
      if (s.json.run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test('key order inside the body does not make it a different request', async () => {
    const key = `test-canon-${Date.now().toString(36)}`;
    const a = await req('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: '{"a":1,"b":2}'
    });
    const b = await req('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: '{"b":2,"a":1}'
    });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202, 'reordered keys are the same request, not a reuse conflict');
    assert.equal(b.headers.get('idempotent-replayed'), 'true');

    for (let i = 0; i < 300; i += 1) {
      const s = await req('/api/state');
      if (s.json.run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test('an unusable key is refused before the route runs', async () => {
    for (const bad of ['', '   ', 'x'.repeat(256)]) {
      const res = await post('/api/run', {}, { 'Idempotency-Key': bad });
      assert.equal(res.status, 400, `key ${JSON.stringify(bad.slice(0, 20))} must be refused`);
      assert.equal(res.json.type, '/problems/invalid-idempotency-key');
    }
  });

  test('DOUBLE-APPROVING A CHECKPOINT ITEM WRITES ONE SIGNATURE, NOT TWO', async () => {
    // The correctness bug this feature exists for. The approvals table is an
    // append-only decision log; a retried submission must not put a second row in
    // it, and must not answer the caller with a 409 they cannot distinguish from
    // "somebody else got here first".
    const state = await req('/api/state');
    const pending = state.json.checkpoint.find((i) => i.status === 'pending');
    assert.ok(
      pending,
      'the pipeline must leave something held for a human, or this proves nothing'
    );

    const key = `test-decide-${Date.now().toString(36)}`;
    const body = { approvedBy: 'Sunita Gurung (DEOC Rasuwa)' };
    const path = `/api/checkpoint/${encodeURIComponent(pending.id)}/approve`;

    const first = await post(path, body, { 'Idempotency-Key': key });
    const replay = await post(path, body, { 'Idempotency-Key': key });

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.text, first.text);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');

    const log = await req(`/api/checkpoint/${encodeURIComponent(pending.id)}`);
    assert.equal(log.json.decisions.length, 1, 'one click must leave exactly one signature');
    assert.equal(log.json.decisions[0].approvedBy, body.approvedBy);

    // WITHOUT a key, the second submission still cannot double-decide — the
    // checkpoint's own guard holds. The key upgrades that refusal to a replay; it
    // is not the only thing preventing the duplicate.
    const noKey = await post(path, { approvedBy: 'Someone Else' });
    assert.equal(noKey.status, 409);
    assert.equal(noKey.json.type, '/problems/checkpoint-already-decided');
    const after = await req(`/api/checkpoint/${encodeURIComponent(pending.id)}`);
    assert.equal(after.json.decisions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. RFC 9457 problem details
// ---------------------------------------------------------------------------

describe('every error is an RFC 9457 problem document', () => {
  test('the media type, the members, and a status that agrees with the response', async () => {
    const cases = [
      ['/api/nope-not-a-route', {}, 404, '/problems/route-not-found'],
      ['/api/settlement/np-nowhere', {}, 404, '/problems/settlement-not-found'],
      ['/api/checkpoint/esc-nope', {}, 404, '/problems/checkpoint-not-found'],
      ['/api/incidents?limit=99999', {}, 400, '/problems/invalid-page-size']
    ];
    for (const [path, , status, type] of cases) {
      const res = await req(path);
      assert.equal(res.status, status, path);
      assert.match(res.contentType, /^application\/problem\+json/, path);
      assert.equal(res.json.type, type, path);
      assert.equal(res.json.status, status, `${path}: document status must match HTTP status`);
      assert.equal(typeof res.json.title, 'string');
      assert.ok(res.json.title.length > 0);
      assert.equal(typeof res.json.detail, 'string');
      assert.ok(res.json.detail.length > 0);
      assert.equal(typeof res.json.instance, 'string');
    }
  });

  test('an unreachable database is 503 DATABASE_UNAVAILABLE, never a 500', async () => {
    // WHY THIS IS NOT A 500, AND WHY THAT DISTINCTION IS WORTH A TEST.
    //
    // src/db/pool.js has always raised DatabaseUnavailableError carrying
    // `code: 'DATABASE_UNAVAILABLE'` and `statusCode: 503`. Nothing read either
    // one: there was no matching entry in the problem registry, so every
    // database outage fell through to `internal-error` and answered HTTP 500.
    //
    // 500 tells a client "this server has a bug" — not retryable, go read code.
    // 503 tells it "a dependency this server needs is down" — which is the true
    // statement, and the one a client may retry on. Getting that backwards sends
    // an operator hunting a bug that does not exist while the database is simply
    // stopped.
    //
    // Driven through problemFromError rather than by stopping the real container,
    // because this asserts the MAPPING. The two live outage shapes that produce
    // this error — a cold pool (ECONNREFUSED) and a live pool losing its backend
    // (57P01 / a codeless "Connection terminated unexpectedly") — are covered in
    // src/db/pool.test.js, where the pool is the thing under test.
    const { DatabaseUnavailableError } = await import('../src/db/pool.js');
    const { problemFromError } = await import('../src/http/problem.js');

    const doc = problemFromError(
      new DatabaseUnavailableError('Cannot reach Postgres at postgres://user:***@host/db')
    );
    assert.equal(doc.status, 503, 'a dependency being down is 503, not 500');
    assert.equal(doc.type, '/problems/database-unavailable');
    assert.equal(doc.code, 'DATABASE_UNAVAILABLE');
    assert.match(doc.detail, /Cannot reach Postgres/);

    // And the type dereferences, like every other one in the registry.
    const entry = await req('/problems/database-unavailable');
    assert.equal(entry.status, 200);
    assert.equal(entry.json.status, 503);
    assert.equal(entry.json.code, 'DATABASE_UNAVAILABLE');
  });

  test('a blank approver is 400 APPROVER_REQUIRED - hard rule 2, over HTTP', async () => {
    // Against a NONEXISTENT id on purpose. The approver check runs BEFORE the
    // lookup, so a blank approver answers 400 rather than 404 - which means rule 2
    // is enforced even for a request that could never have decided anything, and
    // this assertion does not depend on a pending item surviving earlier tests.
    for (const bad of [undefined, null, '', '   ', 42, ['a'], { name: 'x' }, true]) {
      const res = await post(
        '/api/checkpoint/esc-does-not-exist/approve',
        bad === undefined ? {} : { approvedBy: bad }
      );
      assert.equal(res.status, 400, `approvedBy=${JSON.stringify(bad)} must be refused`);
      assert.equal(res.json.type, '/problems/approver-required');
      assert.equal(res.json.code, 'APPROVER_REQUIRED');
    }
    // A NAMED approver against the same nonexistent id gets past rule 2 and then
    // legitimately 404s. Without this, the test above would also pass on a build
    // that answered 400 to everything.
    const named = await post('/api/checkpoint/esc-does-not-exist/approve', {
      approvedBy: 'Sunita Gurung (DEOC Rasuwa)'
    });
    assert.equal(named.status, 404);
    assert.equal(named.json.type, '/problems/checkpoint-not-found');
  });

  test("a malformed body is the CLIENT's 400, not the server's 500", async () => {
    const res = await req('/api/checkpoint/x/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json'
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.type, '/problems/malformed-request-body');
  });

  test('the `type` URI dereferences to documentation — RFC 9457 §3.1.1, actually honoured', async () => {
    const err = await req('/api/nope-not-a-route');
    const doc = await req(err.json.type);
    assert.equal(doc.status, 200);
    assert.equal(doc.json.type, err.json.type);
    assert.equal(doc.json.status, err.json.status);
    assert.equal(typeof doc.json.description, 'string');
    assert.ok(doc.json.description.length > 0);

    const index = await req('/problems');
    assert.equal(index.status, 200);
    assert.ok(Array.isArray(index.json.problems));
    // Every registered type must resolve, or the registry is documentation that
    // lies about itself.
    for (const p of index.json.problems) {
      const one = await req(p.type);
      assert.equal(one.status, 200, `${p.type} did not resolve`);
    }
  });

  test('no problem document carries a dispatch-shaped field - hard rule 1 does not stop at the success payloads', async () => {
    const forbidden = new Set([
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
    const walk = (v, path) => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        v.forEach((x, i) => {
          walk(x, `${path}[${i}]`);
        });
        return;
      }
      for (const [k, val] of Object.entries(v)) {
        assert.ok(!forbidden.has(k.toLowerCase()), `dispatch-shaped key at ${path}.${k}`);
        walk(val, `${path}.${k}`);
      }
    };

    const index = await req('/problems');
    walk(index.json, '/problems');
    for (const p of index.json.problems) {
      const one = await req(p.type);
      walk(one.json, p.type);
    }
    // And on a live error response, which is the document a client actually sees.
    walk((await req('/api/nope-not-a-route')).json, 'error');
  });
});
