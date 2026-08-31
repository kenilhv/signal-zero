// Minimal, dependency-free eval runner.
//
// Deliberately NOT node:test. Two reasons:
//   1. Several families need to report a MEASUREMENT (precision, recall, a
//      distribution) alongside a pass/fail, and node:test's reporter throws that
//      away.
//   2. A skipped case must never be silently counted as a pass. Here a skip is a
//      first-class status with a mandatory reason, it is printed in the summary,
//      and `--strict` turns any skip into a failure.

const SEVERITIES = new Set(['critical', 'major', 'minor']);

export class Suite {
  /**
   * @param {string} family single letter + short name, e.g. 'A. golden set'
   * @param {string} proves one sentence: what a green run of this family proves
   */
  constructor(family, proves) {
    this.family = family;
    this.proves = proves;
    this.cases = [];
    this.metrics = {};
    this.notes = [];
  }

  /** Attach a measured value to the family (shows in the JSON report). */
  metric(key, value) {
    this.metrics[key] = value;
    return value;
  }

  /** Free-text observation that is not itself a pass/fail. */
  note(text) {
    this.notes.push(String(text));
  }

  /**
   * Record one checked assertion.
   * @param {object} spec
   * @param {string} spec.id     stable id, e.g. 'B3'
   * @param {string} spec.name   human sentence stating the property
   * @param {boolean} spec.pass
   * @param {'critical'|'major'|'minor'} [spec.severity]
   * @param {*} [spec.evidence]  whatever a reader needs to verify the verdict
   */
  check({ id, name, pass, severity = 'major', evidence = null, tags = [] }) {
    if (!SEVERITIES.has(severity)) throw new Error(`bad severity "${severity}" on ${id}`);
    const rec = {
      id,
      family: this.family,
      name,
      status: pass ? 'pass' : 'fail',
      severity,
      evidence: normalizeEvidence(evidence),
      tags
    };
    this.cases.push(rec);
    return rec;
  }

  /** Record a case that could not be run. Never counts as a pass. */
  skip({ id, name, reason, severity = 'major', tags = [] }) {
    if (!reason) throw new Error(`skip ${id} needs a reason`);
    const rec = {
      id,
      family: this.family,
      name,
      status: 'skip',
      severity,
      evidence: { reason },
      tags
    };
    this.cases.push(rec);
    return rec;
  }

  /** Run `fn` and turn a thrown error into a failed case rather than a crash. */
  async guarded(spec, fn) {
    try {
      await fn();
    } catch (err) {
      this.check({
        ...spec,
        pass: false,
        severity: spec.severity || 'critical',
        evidence: { threw: String(err && err.stack ? err.stack : err) }
      });
    }
  }

  summary() {
    const pass = this.cases.filter((c) => c.status === 'pass').length;
    const fail = this.cases.filter((c) => c.status === 'fail').length;
    const skip = this.cases.filter((c) => c.status === 'skip').length;
    return { total: this.cases.length, pass, fail, skip };
  }
}

function normalizeEvidence(ev) {
  if (ev === null || ev === undefined) return null;
  try {
    // Force it through JSON so the report file can never hold a live object,
    // a cycle, or a 40MB blob.
    const s = JSON.stringify(ev, replacer);
    if (s === undefined) return { note: String(ev) };
    return s.length > 8000 ? { truncated: true, head: s.slice(0, 8000) } : JSON.parse(s);
  } catch (err) {
    return { unserializable: String(err.message) };
  }
}

function replacer(_key, value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

// --- console rendering ------------------------------------------------------

const C = process.stdout.isTTY
  ? {
      red: (s) => `[31m${s}[0m`,
      green: (s) => `[32m${s}[0m`,
      yellow: (s) => `[33m${s}[0m`,
      dim: (s) => `[2m${s}[0m`,
      bold: (s) => `[1m${s}[0m`
    }
  : { red: (s) => s, green: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s };

export { C };

export function renderSuite(suite, { verbose = false } = {}) {
  const s = suite.summary();
  const head = `${suite.family}  ${s.pass}/${s.total} pass` +
    (s.fail ? `, ${s.fail} FAIL` : '') +
    (s.skip ? `, ${s.skip} skipped` : '');
  console.log('');
  console.log(C.bold(head));
  console.log(C.dim(`  proves: ${suite.proves}`));

  for (const c of suite.cases) {
    if (c.status === 'pass') {
      if (verbose) console.log(`  ${C.green('PASS')} ${c.id}  ${c.name}`);
      continue;
    }
    if (c.status === 'skip') {
      console.log(`  ${C.yellow('SKIP')} ${c.id}  ${c.name}`);
      console.log(C.dim(`        reason: ${c.evidence.reason}`));
      continue;
    }
    console.log(`  ${C.red('FAIL')} ${c.id}  [${c.severity}] ${c.name}`);
    if (c.evidence) {
      const lines = JSON.stringify(c.evidence, null, 2).split('\n').slice(0, 24);
      for (const l of lines) console.log(C.dim(`        ${l}`));
    }
  }

  const metricKeys = Object.keys(suite.metrics);
  if (metricKeys.length) {
    console.log(C.dim('  measurements:'));
    for (const k of metricKeys) {
      const v = suite.metrics[k];
      const rendered = typeof v === 'object' ? JSON.stringify(v) : String(v);
      console.log(C.dim(`    ${k} = ${rendered}`));
    }
  }
  for (const n of suite.notes) console.log(C.dim(`  note: ${n}`));
}
