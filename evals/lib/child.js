// Run a probe in a child process with a controlled environment.
//
// Everything in src/ reads configuration once, at module-eval time. So the only
// honest way to evaluate "the same code under a different configuration" is a
// fresh process per configuration. Probes echo the config they actually
// resolved so the parent can assert the run happened under the settings it
// asked for rather than assuming it did.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVALS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ROOT = path.dirname(EVALS_DIR);
export const SCRATCH = path.join(EVALS_DIR, '.scratch');

fs.mkdirSync(SCRATCH, { recursive: true });

/**
 * Spawn `node <script> ...args` and resolve with { code, stdout, stderr, timedOut }.
 * Never rejects on a non-zero exit - a failing child is data, not an exception.
 */
export function runNode(script, args = [], { env = {}, timeoutMs = 120000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
  });
}

/** Same contract as runNode, for an arbitrary executable (docker, git, ...). */
export function runCmd(cmd, args = [], { env = {}, timeoutMs = 90000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // On Windows a bare `docker` needs the shell to resolve docker.exe. Passing
      // an args array together with shell:true is deprecated (and unescaped), so
      // the command is assembled and quoted here instead.
      const useShell = process.platform === 'win32';
      const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a));
      child = useShell
        ? spawn([cmd, ...quoted].join(' '), {
            cwd,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true
          })
        : spawn(cmd, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
          });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: String(err), timedOut: false });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
  });
}

let seq = 0;
export function scratchPath(name) {
  return path.join(SCRATCH, `${String(seq++).padStart(3, '0')}-${name}`);
}

export function writeScratch(name, data) {
  const p = scratchPath(name);
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Wait until `fn()` returns truthy, or give up. Returns the value or null. */
export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export function tmpDir(prefix = 'signal-zero-eval-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
