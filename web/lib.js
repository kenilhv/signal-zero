// Signal Zero — shared helpers.
// Formatting, enums and tiny DOM utilities. No data is ever invented here:
// every formatter has an explicit "we do not have this" path.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

// ── numbers ────────────────────────────────────────────────────────────────

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** silenceHours → "96.0h" / "13.4h"; ≥100 drops the decimal. */
export function fmtHours(v) {
  const n = num(v);
  if (n === null) return '—';
  return n >= 100 ? `${Math.round(n)}h` : `${n.toFixed(1)}h`;
}

/** Signed 2dp with a real minus sign. */
export function fmtZ(v, dp = 2) {
  const n = num(v);
  if (n === null) return '—';
  const s = Math.abs(n).toFixed(dp);
  return (n < 0 ? '−' : '+') + s;
}

export function fmtNum(v, dp = 2) {
  const n = num(v);
  return n === null ? '—' : n.toFixed(dp);
}

export function fmtInt(v) {
  const n = num(v);
  return n === null ? '—' : n.toLocaleString('en-US');
}

/** Grouped integer, but keeps a literal 0 rather than blanking it. */
export function fmtCount(v) {
  const n = num(v);
  return n === null ? '—' : String(n);
}

export function fmtLambda(v) {
  const n = num(v);
  if (n === null) return '—';
  return `${n < 0.001 ? n.toExponential(3) : n.toFixed(5)} /h`;
}

// ── time ───────────────────────────────────────────────────────────────────

export function relTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 45) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.floor(s / 3600);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function clockTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour12: false });
}

export function localFull(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// ── silence ramp (spec §4.4 / §7.3) ────────────────────────────────────────

export const SIL_BANDS = [
  { stop: 0, from: 0,  to: 6,        label: '0 – 6h' },
  { stop: 1, from: 6,  to: 18,       label: '6 – 18h' },
  { stop: 2, from: 18, to: 36,       label: '18 – 36h' },
  { stop: 3, from: 36, to: 60,       label: '36 – 60h' },
  { stop: 4, from: 60, to: 84,       label: '60 – 84h' },
  { stop: 5, from: 84, to: Infinity, label: '84h and over' }
];

export function silStop(hours) {
  const n = num(hours);
  if (n === null) return 5; // unknown silence is not "fresh" — never paint it cool
  for (const b of SIL_BANDS) if (n < b.to) return b.stop;
  return 5;
}

/** Marker radius from population (secondary encoding, never the primary read). */
export function popRadius(population) {
  const p = num(population) ?? 0;
  return Math.max(5, Math.min(22, 5 + 16 * Math.sqrt(p / 25000)));
}

// ── the three kinds of silence (docs/three-kinds-of-silence.md) ────────────
// The live field carries three materially different states and they are not
// equally meaningful. Flattening them into one "silenceHours" axis hides the
// strongest claim the product has.
//
//   never   coverageBasis "cohort-cold-start" — NO REPORT HAS EVER RESOLVED
//           here. Weak signal: we cannot separate "quiet" from "nobody looked".
//           This must never be rendered as confirmed silence.
//   stopped coverageBasis "reports", at least one report, and nothing since
//           STOPPED_AFTER_HOURS. Coverage existed and then ceased. This is the
//           strongest signal in the system.
//   recent  heard from inside the window. Not silent.
//
// Every count derived from this is computed from live rows at render time.
// Nothing here is hard-coded to a number that appeared in a past run.

export const STOPPED_AFTER_HOURS = 24;

export function silenceKind(row) {
  if (!row) return 'never';
  if (row.coverageBasis === 'cohort-cold-start') return 'never';
  const reports = Number(row.reportCount);
  const hours = Number(row.silenceHours);
  if (Number.isFinite(reports) && reports >= 1 &&
      Number.isFinite(hours) && hours >= STOPPED_AFTER_HOURS) return 'stopped';
  return 'recent';
}

// Wording note (skills/no-dispatch-language): none of these labels may say what
// a settlement DID. "Went dark" and "stopped reporting" assert a fact about the
// place; all we observe is what reached our inbox. Every label below is phrased
// as a statement about arriving reports, not about the settlement.
export const KINDS = {
  never: {
    glyph: '◌', short: 'no report ever', word: 'no report has ever reached us',
    label: 'No report has ever resolved here. This is an absence of data, not a confirmed silence. ' +
           'Whether the place is quiet, unreachable or simply unreported is not determinable from this.'
  },
  stopped: {
    glyph: '◐', short: 'stopped', word: 'reports reached us, then stopped',
    label: `Reports resolved here, and then nothing for ${STOPPED_AFTER_HOURS} hours or more. ` +
           'Coverage existed and then ceased. A gap in our sources still looks identical to a gap on the ground.'
  },
  recent: {
    glyph: '●', short: 'recent', word: 'a report reached us recently',
    label: `A report resolved here within the last ${STOPPED_AFTER_HOURS} hours.`
  }
};

/** { never:[], stopped:[], recent:[] } — always all three keys, never undefined. */
export function groupByKind(rowList) {
  const out = { never: [], stopped: [], recent: [] };
  for (const r of rowList || []) out[silenceKind(r)].push(r);
  return out;
}

// ── anomaly types (qualitative — encoded by SHAPE on the map) ───────────────

export const ANOMALY = {
  'solo-anomaly': {
    glyph: '◆', short: 'Solo anomaly', cls: 'anom-solo',
    label: 'Solo anomaly — this place is dark, its neighbours are not'
  },
  'regional-outage': {
    glyph: '▮', short: 'Regional outage', cls: 'anom-outage',
    label: 'Regional outage — it and its neighbours are all silent'
  },
  'silent-cluster': {
    glyph: '◈', short: 'Silent cluster', cls: 'anom-cluster',
    label: 'Silent cluster — inside a significant quiet stretch'
  },
  'cluster-edge': {
    glyph: '◇', short: 'Cluster edge', cls: 'anom-edge',
    label: 'Cluster edge — its neighbours went quiet, it did not'
  },
  none: { glyph: '·', short: '', cls: 'anom-none', label: 'No spatial anomaly flagged' }
};

export const anomalyOf = (t) => ANOMALY[t] || ANOMALY.none;

export const INCIDENT_KINDS = {
  'degraded-source': { glyph: '▲', label: 'SOURCE DEGRADED' },
  'llm-fallback':    { glyph: '◆', label: 'LLM FALLBACK' },
  'cold-start':      { glyph: '◌', label: 'COLD START' },
  heal:              { glyph: '●', label: 'RECOVERED' },
  // A refusal is not a fault and must not read as one. The tier-3 agent
  // declining a request that would break a hard rule is the system working;
  // logging it under 'llm-fallback' made the best thing that can happen
  // indistinguishable from a crash.
  'agent-refusal':   { glyph: '⊘', label: 'AGENT REFUSED' },
  local:             { glyph: '·', label: 'LOCAL' }
};

export const SOURCE_STATUS = {
  live:     { glyph: '●', cls: 's-live' },
  ok:       { glyph: '●', cls: 's-ok' },
  degraded: { glyph: '▲', cls: 's-degraded' },
  down:     { glyph: '■', cls: 's-down' },
  unknown:  { glyph: '◌', cls: 's-unknown' }
};

export const statusOf = (s) => SOURCE_STATUS[s] || SOURCE_STATUS.unknown;

export const NODATA_TITLE = (cohortKey) =>
  `No report has ever resolved to this settlement. Its baseline comes from cohort ${cohortKey || 'unknown'}, ` +
  `not from its own history. This is an absence of data, not a confirmed silence.`;

// ── chips ──────────────────────────────────────────────────────────────────

/** The single reusable coverage chip. Identical in every surface (spec §6.2). */
export function coverageChip(row) {
  if (!row) return null;
  if (row.coverageBasis === 'cohort-cold-start') {
    return h('span', {
      class: 'chip chip-nodata',
      title: NODATA_TITLE(row.cohortKey),
      'aria-label': NODATA_TITLE(row.cohortKey)
    }, h('span', { 'aria-hidden': 'true' }, '◌'), ' no data reached us');
  }
  const n = num(row.reportCount);
  const kind = silenceKind(row);
  if (kind === 'stopped') {
    return h('span', {
      class: 'chip chip-stopped',
      title: KINDS.stopped.label,
      'aria-label': KINDS.stopped.label
    }, h('span', { 'aria-hidden': 'true' }, KINDS.stopped.glyph),
      ` ${n === null ? 'reports' : n + ' report' + (n === 1 ? '' : 's')} reached us, then stopped`);
  }
  return h('span', { class: 'chip chip-reports' },
    h('span', { 'aria-hidden': 'true' }, '●'),
    ` ${n === null ? '—' : n} report${n === 1 ? '' : 's'}`);
}

// ── environment ────────────────────────────────────────────────────────────

const rmq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let reduced = rmq ? rmq.matches : false;
const rmListeners = [];
if (rmq) {
  const onChange = (e) => { reduced = e.matches; rmListeners.forEach((f) => f(reduced)); };
  if (rmq.addEventListener) rmq.addEventListener('change', onChange);
  else if (rmq.addListener) rmq.addListener(onChange);
}
export const reducedMotion = () => reduced;
export const onReducedMotionChange = (fn) => rmListeners.push(fn);

export function readCssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

export function safeLocal(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
    return value;
  } catch { return null; }
}

/** fetch with a timeout that never leaves a hung promise behind. */
export async function fetchJson(url, opts = {}, timeoutMs = 12000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl ? ctl.signal : undefined });
    const text = await res.text();
    let body = null;
    let parseError = null;
    try { body = text ? JSON.parse(text) : null; }
    catch (err) { parseError = err; }
    return { ok: res.ok, status: res.status, body, text, parseError };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * rAF-throttled, with a timer backstop. Some environments throttle or entirely
 * suspend requestAnimationFrame (background tabs, power saving, a compositor that
 * is not painting). The overlay this drives is the data layer of the map, so it
 * must still update; the timer runs the work if the frame never arrives.
 */
export function throttleRaf(fn) {
  let queued = false;
  let timer = null;
  return (...args) => {
    if (queued) return;
    queued = true;
    const run = () => {
      if (!queued) return;
      queued = false;
      clearTimeout(timer);
      timer = null;
      fn(...args);
    };
    try { requestAnimationFrame(run); } catch { /* no rAF at all */ }
    timer = setTimeout(run, 120);
  };
}

// ── plain-language duration and counts ─────────────────────────────────────
// The landing view and the board must be readable by someone who has never seen
// the product. "96.0h" is precise and opaque; "4d 0h" is precise and legible.
// Both formatters carry the real value - nothing is rounded away silently.

/** Compact, comparison-safe: "4d 0h" / "13h 24m" / "48m". Never invents a value. */
export function fmtDuration(v) {
  const n = num(v);
  if (n === null) return '—';
  if (n < 1) return `${Math.round(n * 60)}m`;
  if (n < 48) {
    const hrs = Math.floor(n);
    const mins = Math.round((n - hrs) * 60);
    return mins ? `${hrs}h ${String(mins).padStart(2, '0')}m` : `${hrs}h`;
  }
  const d = Math.floor(n / 24);
  const hrs = Math.round(n - d * 24);
  return hrs ? `${d}d ${hrs}h` : `${d}d`;
}

/** Prose form for the one headline sentence: "96 hours" / "4 days". */
export function fmtDurationWords(v) {
  const n = num(v);
  if (n === null) return 'an unrecorded length of time';
  if (n < 2) return `${n.toFixed(1)} hours`;
  if (n < 72) return `${Math.floor(n)} hours`;
  const d = Math.floor(n / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** Population with its unit attached, because a bare integer is ambiguous. */
export function fmtPeople(v) {
  const n = num(v);
  return n === null ? 'population not recorded' : `${n.toLocaleString('en-US')} people`;
}

// ── motion helpers ─────────────────────────────────────────────────────────
// Three motion weights exist on this console and no more: the hero count-up,
// the list stagger, and nothing. Both helpers below degrade to the FINAL STATE
// under prefers-reduced-motion rather than to a shortened animation, because
// the information (the number, the ordering) must not depend on the movement.

/**
 * Monotonic ease-out count. A grim number must never overshoot and correct
 * itself, so the easing is cubic ease-out (1-(1-t)^3) rather than anything
 * elastic — it approaches the target from below and stops.
 * Does nothing at all when the rendered value already equals `to`, so a poll
 * that changed nothing produces no motion.
 */
export function countUp(node, to, opts = {}) {
  if (!node) return;
  const target = num(to);
  if (target === null) { node.textContent = '—'; return; }
  const format = opts.format || ((v) => String(Math.round(v)));
  const final = format(target);
  // First appearance counts from zero; after that, from the value on screen.
  // A poll that did not move the number produces no motion at all — motion
  // with no informational delta is decoration.
  const seen = num(node.dataset.countValue);
  const from = seen === null ? (opts.from ?? 0) : seen;

  node.dataset.countValue = String(target);
  if (reduced || from === target || opts.animate === false) {
    node.textContent = final;
    return;
  }

  // Timer-driven, not requestAnimationFrame-driven, and deliberately so.
  // Some environments throttle or entirely suspend rAF (background tabs, power
  // saving, a compositor that is not painting) — this is the same hazard
  // throttleRaf below documents. This number is the product's headline claim;
  // it must never be left blank because a frame did not arrive.
  const dur = opts.duration ?? 900;
  const t0 = Date.now();
  clearInterval(node._countTimer);
  node.textContent = format(from);
  const tick = () => {
    if (!node.isConnected) { clearInterval(node._countTimer); return; }
    const t = Math.min(1, (Date.now() - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);      // monotonic ease-out — never overshoots
    node.textContent = t >= 1 ? final : format(from + (target - from) * e);
    if (t >= 1) clearInterval(node._countTimer);
  };
  node._countTimer = setInterval(tick, 16);
}

/**
 * Per-row stagger index. 28ms per row is the crafted band; the total sweep is
 * capped at 900ms so a larger gazetteer cannot produce a multi-second
 * waterfall. Returns the step actually used, in ms.
 */
export function staggerStep(count, per = 28, cap = 900) {
  if (!count || count < 2) return 0;
  return Math.min(per, cap / count);
}
