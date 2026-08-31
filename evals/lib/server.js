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
    /** Wait until the pipeline has produced ranked output, or give up. */
    async waitForState({ timeoutMs = 60000 } = {}) {
      const end = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < end) {
        const res = await request('GET', `${base}/api/state`);
        last = res;
        if (res.ok && Array.isArray(res.json?.settlements) && res.json.settlements.length) return res;
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

async function request(method, url, body, { timeoutMs = 90000, rawBody } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {},
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
    return { ok: res.ok, status: res.status, text, json, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, text: '', json: null, error: String(err.message || err), ms: Date.now() - started };
  }
}
