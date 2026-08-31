// Signal Zero — the NON-DURABLE mode must be honest, not merely functional.
//
// Requirement: with DATABASE_URL absent the app still starts and SAYS SO. The
// failure this guards against is the comfortable one — a fallback that works so
// smoothly nobody notices the silence clock has stopped meaning anything. So the
// assertions here are about what the API CLAIMS as much as what it returns:
//
//   * it serves,
//   * it reports mode 'memory' and durable false,
//   * it distinguishes "no DATABASE_URL" (configured: false) from "DATABASE_URL
//     set and unusable" (configured: true, error set) — different operator
//     problems, different fixes,
//   * and hard rule 4 still holds, because a mode that is honest about
//     durability but lies about a NULL would be worse than no mode at all.
//
// This file runs in its own process (node --test isolates per file), which is
// required: the backend is chosen once per process and never swaps.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

// Must be cleared BEFORE src/server.js is imported — src/db/pool.js reads it at
// selection time, and dotenv would otherwise load the developer's .env.
process.env.DATABASE_URL = '';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.USE_LIVE_SCRAPE = 'false';
process.env.TRUEFORGE_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';

const { app, runPipeline, initForTest } = await import('../src/server.js');

let server;
let base;

before(async () => {
  // dotenv may have repopulated DATABASE_URL from .env during the import above.
  // Clear it again before the backend is selected, so this test measures the
  // "absent" case rather than the developer's local configuration.
  process.env.DATABASE_URL = '';
  await initForTest();
  await runPipeline();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};

describe('no DATABASE_URL: the app starts, works, and says it is not durable', () => {
  test('the process did not crash and the API serves a real ranking', async () => {
    const { status, json } = await get('/api/state');
    assert.equal(status, 200);
    assert.ok(json.settlements.length > 0, 'a degraded store must still rank the corridor');
    assert.ok(json.stats.lastRunAt, 'a pass must have completed');
  });

  test('it declares memory mode, non-durable, and names the consequence', async () => {
    const { json } = await get('/api/state');
    assert.equal(json.persistence.mode, 'memory');
    assert.equal(json.persistence.durable, false);
    // NOT configured — this is the "you did not set it" case, which must stay
    // distinguishable from the "you set it and it is broken" case.
    assert.equal(json.persistence.configured, false);
    assert.equal(json.persistence.error, null);
    assert.match(json.persistence.reason, /DATABASE_URL is not set/);
    assert.match(json.persistence.reason, /restart/i);
  });

  test('/api/health also reports the mode, so a probe cannot miss it', async () => {
    const { json } = await get('/api/health');
    assert.equal(json.ok, true);
    assert.equal(json.persistence.mode, 'memory');
    assert.equal(json.persistence.durable, false);
  });

  test('hard rule 4 holds in the fallback too: an unobserved settlement is null', async () => {
    const { json, text } = await get('/api/state');
    const never = json.settlements.filter((s) => s.lastReportAt === null);
    assert.ok(never.length > 0);
    for (const s of never) {
      assert.ok(Object.hasOwn(s, 'lastReportAt'));
      assert.equal(s.lastReportAt, null);
      assert.equal(s.coverageBasis, 'cohort-cold-start');
    }
    assert.ok(text.includes('"lastReportAt":null'));
  });

  test('hard rule 2 holds in the fallback too: a blank approver is refused', async () => {
    const { json } = await get('/api/state');
    const pending = json.checkpoint.find((i) => i.status === 'pending');
    assert.ok(pending, 'the pass should have raised at least one checkpoint item');

    for (const body of [{}, { approvedBy: '' }, { approvedBy: '   ' }, { approvedBy: null }]) {
      const res = await fetch(`${base}/api/checkpoint/${pending.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      assert.equal(res.status, 400, `anonymous approval must be refused: ${JSON.stringify(body)}`);
    }

    const after = await get('/api/state');
    const still = after.json.checkpoint.find((i) => i.id === pending.id);
    assert.equal(still.status, 'pending');
    assert.equal(still.approvedBy, null);
  });

  test('the fail feed is not truncated: it is unbounded and paged', async () => {
    const { json } = await get('/api/incidents?limit=2');
    assert.equal(json.ok, true);
    assert.ok(json.incidents.length <= 2);
    // The degraded-store warning is itself on the feed — the operator watching
    // the dashboard is who needs to know the clock is not durable.
    const all = await get('/api/incidents?limit=500');
    assert.ok(
      all.json.incidents.some((i) => /NON-DURABLE STORE/.test(i.message)),
      'memory mode must raise an incident, not only log a line'
    );
  });
});
