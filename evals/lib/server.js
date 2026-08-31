// Boot the REAL Signal Zero server in a child process and talk to it over HTTP.
//
// Not an in-process import: src/server.js calls start() at module scope, so
// importing it would bind a port as a side effect and share one store across
// every test. A child process per scenario also means a scenario can inject a
// hostile environment (dead TrueForge, bogus scraping credentials) without
// contaminating the next one - and it is the only way to prove the process
// SURVIVED a fault, which is the whole point of family D.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './child.js';

const SERVER = path.join(ROOT, 'src', 'server.js');

export async function startServer({ port, env = {}, bootTimeoutMs = 45000 } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // Default every scenario to offline + no LLM key. A scenario that wants a
      // live dependency switches it on explicitly, so no test can pass because
      // of a credential that happened to be lying around in .env.
      USE_LIVE_SCRAPE: 'false',
      BRIGHTDATA_API_TOKEN: '',
      OPENAI_API_KEY: '',
      TRUEFORGE_ENABLED: 'false',
      // ---------------------------------------------------------------------
      // AND DEFAULT EVERY SCENARIO TO A PRIVATE, NON-DURABLE STORE.
      // ---------------------------------------------------------------------
      // Same reasoning as the credentials above, one level down: a scenario must
      // not pass or fail because of a database that happened to be lying around
      // in .env. Without this every spawned server would share ONE Postgres, so
      // scenario N would boot into scenario N-1's checkpoint queue, incident feed
      // and ranked snapshot — and the failures would be order-dependent, which is
      // the worst kind to debug.
      //
      // This is not a gap in coverage. What these families test — guardrails,
      // no-dispatch, ranking properties, surviving a dead dependency — is
      // behaviour both backends are required to agree on, and each scenario
      // wants a clean store, which is exactly what this gives it. Durability
      // itself is NOT provable this way and is therefore tested separately, by a
      // scenario that provisions its own real database and passes it in here
      // explicitly (family D, "silence survives a restart").
      DATABASE_URL: '',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const log = { stdout: '', stderr: '', exited: null };
  child.stdout.on('data', (d) => (log.stdout += d));
  child.stderr.on('data', (d) => (log.stderr += d));
  child.on('exit', (code, signal) => (log.exited = { code, signal, at: Date.now() }));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + bootTimeoutMs;
  let healthy = false;
  while (Date.now() < deadline) {
    if (log.exited) break;
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    base,
    child,
    log,
    healthy,
    alive: () => log.exited === null && child.exitCode === null,
    async get(p, opts = {}) {
      return request('GET', `${base}${p}`, undefined, opts);
    },
    async post(p, body, opts = {}) {
      return request('POST', `${base}${p}`, body, opts);
    },
    /**
     * Wait until NO pipeline pass is in flight.
     *
     * Required now that POST /api/run is asynchronous AND the pass yields the
     * event loop at every stage boundary: the server answers requests DURING a
     * pass, including the boot pass it starts for itself. A scenario that POSTs
     * /api/run the instant /api/health goes green is therefore racing the boot
     * pass and gets a correct 409 for it. That refusal is the single-flight guard
     * working; it is not the thing those scenarios are measuring, so they wait
     * for the slot instead of asserting on whoever happened to win it.
     *
     * (Before the async change this race was invisible rather than absent: the
     * blocking run held the whole event loop, so the request was not read off the
     * socket until the pass was over.)
     */
    async waitForIdle({ timeoutMs = 90000 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const res = await request('GET', `${base}/api/state`);
        const run = res.json?.run;
        if (!run || run.status !== 'running') return res;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    },
    /** Wait until the pipeline has produced ranked output, or give up. */
    async waitForState({ timeoutMs = 60000 } = {}) {
      const end = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < end) {
        const res = await request('GET', `${base}/api/state`);
        last = res;
        if (res.ok && Array.isArray(res.json?.settlements) && res.json.settlements.length)
          return res;
        await new Promise((r) => setTimeout(r, 400));
      }
      return last;
    },
    async stop() {
      if (log.exited) return log;
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      return log;
    }
  };
}

async function request(method, url, body, { timeoutMs = 90000, rawBody, headers = {} } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined || rawBody !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
        // Extra request headers, so a case can send an `Idempotency-Key` and
        // prove the double-submission behaviour over real HTTP rather than at
        // the unit level, where a middleware can be bypassed.
        ...headers
      },
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return {
      ok: res.ok,
      status: res.status,
      text,
      json,
      // Headers are returned so a case can assert on the MEDIA TYPE, not just the
      // body. RFC 9457 is a content-type contract as much as a shape one: a
      // problem document served as application/json is not a problem document to
      // a client that dispatches on the type, so `application/problem+json` has
      // to be checkable here.
      headers: Object.fromEntries(res.headers.entries()),
      contentType: res.headers.get('content-type') || '',
      ms: Date.now() - started
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: '',
      json: null,
      headers: {},
      contentType: '',
      error: String(err.message || err),
      ms: Date.now() - started
    };
  }
}
