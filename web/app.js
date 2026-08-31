// Signal Zero — coordinator console.
//
// Rules this file is written under (they are product rules, not style rules):
//   1. Nothing here invents a value. Every number rendered came from the API. When a
//      value is missing the UI says so in words rather than showing a plausible blank.
//   2. Nothing becomes actionable without a named human. The checkpoint modal blocks,
//      and both buttons stay unavailable until a name is typed.
//   3. "Silence" is rendered as "no report reached us", never as confirmed quiet.
//   4. The API being slow, unreachable or malformed never clears what is on screen.

import {
  $,
  $$,
  ANOMALY,
  anomalyOf,
  clear,
  clockTime,
  countUp,
  coverageChip,
  fetchJson,
  fmtCount,
  fmtDuration,
  fmtDurationWords,
  fmtHours,
  fmtInt,
  fmtLambda,
  fmtNum,
  fmtPeople,
  fmtZ,
  groupByKind,
  h,
  INCIDENT_KINDS,
  KINDS,
  localFull,
  reducedMotion,
  relTime,
  SIL_BANDS,
  STOPPED_AFTER_HOURS,
  safeLocal,
  silenceKind,
  silStop,
  staggerStep,
  statusOf
} from './lib.js';
import { createMapController } from './map.js';

/**
 * True only for an absolute http(s) URL we can honestly present as a citation.
 * A relative URL (SERP payloads hand back "/goto?url=..." for news redirects)
 * would resolve against this console's own origin and open a second copy of the
 * console, which reads as a working source link and is not one.
 */
function isCitableUrl(u) {
  if (!u) return false;
  try {
    return (
      /^https?:$/i.test(new URL(String(u), document.baseURI).protocol) &&
      /^https?:\/\//i.test(String(u).trim())
    );
  } catch {
    return false;
  }
}

// ── state ──────────────────────────────────────────────────────────────────

const S = {
  state: null,
  fetchedAt: null,
  stale: false,
  retryMs: 4000,
  retryAt: 0,
  parseSample: null,
  selectedId: null,
  detail: null,
  detailId: null,
  detailLoading: false,
  detailError: null,
  filter: 'all',
  query: '',
  sort: { key: 'rank', dir: 'asc' },
  actFilter: 'all',
  local: [],
  // THE SERVER'S OWN VIEW of the pass in flight — `run` from GET /api/state. Null
  // when this process has not started one, which is NOT "no pass has ever run"
  // (that is `stats.lastRunAt`). Everything the stage rail renders comes from
  // here, so the rail can no longer claim progress the server did not report.
  run: null,
  runFetchedAt: 0,
  running: false,
  // Set at the moment this client's own POST /api/run is accepted, and cleared by
  // the first poll that carries the server's answer. It covers the sub-second
  // window between the 202 and the next state read, so the button does not flick
  // back to idle before the server has said anything.
  runOptimisticUntil: 0,
  showAllDecided: false,
  releases: new Map(), // settlementId -> { approvedBy, decidedAt, shortlist }
  adjacency: null
};

// The pipeline's stages, mirroring src/http/run-progress.js RUN_STAGES.
//
// This list used to end in a `Ready` row, which was not a stage — it was a state
// wearing a stage's clothes on a rail whose other rows are real. It is gone; the
// rail's sub-line says "Ready" when the pass is done.
//
// `observe` and `persist` are new here and were previously INVISIBLE: the server
// already wrote `detail.stage: "observe"` on a failed observation write, and the
// rail silently dropped it because the id was not in this list. A degraded stage
// nobody can see on the stage rail is the fail feed's job undone.
const STAGE_LABELS = {
  ingest: 'Ingest',
  triage: 'Triage',
  dedup: 'Dedup',
  observe: 'Observe',
  rank: 'Rank',
  checkpoint: 'Checkpoint',
  persist: 'Persist'
};
const DEFAULT_STAGE_IDS = ['ingest', 'triage', 'dedup', 'observe', 'rank', 'checkpoint', 'persist'];

/**
 * The stages to render. The SERVER publishes its own list on `run.stages`, so
 * that is preferred: if the pipeline gains a stage, the rail gains a row without
 * this file being edited, and it can never show a stage the server does not run.
 * The constant above is only the shape to draw before any state has arrived.
 */
function stageList() {
  const ids =
    Array.isArray(S.run && S.run.stages) && S.run.stages.length ? S.run.stages : DEFAULT_STAGE_IDS;
  return ids.map((id) => ({ id, label: STAGE_LABELS[id] || id }));
}

const el = {};
let mapCtl = null;
let mapSig = '';
let legendProgrammatic = false;
let seq = 0;

// ── local activity log (client-observed events, tagged LOCAL) ──────────────

function logLocal(message, detail) {
  S.local.unshift({
    id: `loc-${++seq}`,
    at: new Date().toISOString(),
    kind: 'local',
    message,
    detail: detail || null
  });
  if (S.local.length > 120) S.local.length = 120;
  renderActivity();
}

// ── toasts (transient, non-decision feedback only) ─────────────────────────

function toast(message, kind = 'ok', ms = 6000) {
  const box = el.toasts;
  const node = h(
    'div',
    { class: `toast ${kind}` },
    h('span', {}, message),
    h('button', { type: 'button', 'aria-label': 'Dismiss', onclick: () => node.remove() }, '✕')
  );
  box.append(node);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => node.remove(), ms);
}

// ── API ────────────────────────────────────────────────────────────────────

async function pollState() {
  const res = await fetchJson('/api/state', {}, 10000).catch((err) => ({
    ok: false,
    status: 0,
    netError: err
  }));

  if (!res.ok) {
    S.stale = true;
    S.parseSample = null;
    S.retryMs = Math.min(15000, Math.round(S.retryMs * 1.5));
    renderApiBanner(res.status === 0 ? null : `HTTP ${res.status}`);
    return;
  }
  if (res.parseError || !res.body || typeof res.body !== 'object') {
    S.stale = true;
    S.parseSample = (res.text || '').slice(0, 400);
    S.retryMs = Math.min(15000, Math.round(S.retryMs * 1.5));
    renderApiBanner('malformed');
    return;
  }

  const wasStale = S.stale;
  S.stale = false;
  S.parseSample = null;
  S.retryMs = 4000;
  const prev = S.state;
  const prevRun = S.run;
  S.state = normalise(res.body);
  S.fetchedAt = Date.now();
  // THE SERVER'S RUN STATE REPLACES THE CLIENT'S GUESS. Once a poll carries an
  // answer, the optimistic window is over regardless of what it says: if the pass
  // already finished, the button must stop spinning; if another client started
  // one, this rail must show it.
  S.run = res.body.run && typeof res.body.run === 'object' ? res.body.run : null;
  S.runFetchedAt = Date.now();
  S.runOptimisticUntil = 0;
  S.running = isRunning();
  if (prevRun && prevRun.status === 'running' && S.run && S.run.status === 'error') {
    logLocal(
      `Pipeline pass ${S.run.runId} failed${S.run.stage ? ` during ${S.run.stage}` : ''}: ${S.run.error || 'no reason reported'}`,
      S.run
    );
  }
  renderApiBanner(null);
  if (wasStale) logLocal('Reconnected to the Signal Zero API. Live state restored.');

  if (prev && prev.stats.lastRunAt !== S.state.stats.lastRunAt && S.state.stats.lastRunAt) {
    logLocal(
      `Pipeline pass completed: ${S.state.stats.reportCount} reports, ${S.state.stats.clusterCount} clusters, ${S.state.stats.durationMs}ms.`,
      { lastRunAt: S.state.stats.lastRunAt, durationMs: S.state.stats.durationMs }
    );
  }
  renderAll();
}

function normalise(body) {
  const settlements = Array.isArray(body.settlements) ? body.settlements.filter(Boolean) : [];
  return {
    settlements,
    checkpoint: Array.isArray(body.checkpoint) ? body.checkpoint.filter(Boolean) : [],
    incidents: Array.isArray(body.incidents) ? body.incidents.filter(Boolean) : [],
    // One PAGE of the feed, plus what the server says about the rest of it. The
    // feed is unbounded now; this is how many of it arrived, not how many exist.
    incidentTotal: Number.isFinite(Number(body.incidentTotal)) ? Number(body.incidentTotal) : null,
    incidentPageSize: Number.isFinite(Number(body.incidentPageSize))
      ? Number(body.incidentPageSize)
      : null,
    incidentHasMore: body.incidentHasMore === true,
    sources: Array.isArray(body.sources) ? body.sources.filter(Boolean) : [],
    stats: body.stats && typeof body.stats === 'object' ? body.stats : {}
  };
}

/**
 * A message a human can read out of an RFC 9457 problem document.
 *
 * Every error from this API is `application/problem+json` now: `detail` is the
 * sentence about THIS occurrence, `title` is the sentence about the class of
 * failure, and `type` is the stable identity to branch on. `error` is checked
 * last only so an older server answering a newer page still says something
 * useful rather than "HTTP 500".
 */
function problemMessage(body, status, fallback) {
  if (body && typeof body === 'object') {
    for (const key of ['detail', 'title', 'error']) {
      if (typeof body[key] === 'string' && body[key].trim()) return body[key];
    }
  }
  return fallback || `HTTP ${status}`;
}

/** A key that makes ONE submission safe to repeat. See src/http/idempotency.js. */
function idempotencyKey(prefix) {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}

function loopPoll() {
  const delay = S.stale ? S.retryMs : S.running ? 1200 : 5000;
  setTimeout(async () => {
    try {
      await pollState();
    } catch (err) {
      S.stale = true;
      renderApiBanner(null);
    }
    loopPoll();
  }, delay);
}

// ── derived ────────────────────────────────────────────────────────────────

// Relative timestamps ("raised 4 min ago") must keep ticking, so the change
// signatures carry a one-minute bucket. Nothing re-renders faster than it changes.
const minuteBucket = () => Math.floor(Date.now() / 60000);

const rows = () => (S.state ? S.state.settlements : []);
const pendingItems = () =>
  S.state ? S.state.checkpoint.filter((i) => i.status === 'pending') : [];
const decidedItems = () =>
  S.state ? S.state.checkpoint.filter((i) => i.status !== 'pending') : [];
const pendingSettlementIds = () =>
  new Set(
    pendingItems()
      .map((i) => i.settlementId)
      .filter(Boolean)
  );
const rowById = (id) => rows().find((r) => r.settlementId === id) || null;

// ══════════════════════════════════════════════════════════════════════════
// The API banner — the console's own error state. It degrades the screen,
// it never clears it.
// ══════════════════════════════════════════════════════════════════════════

function renderApiBanner(reason) {
  const b = el.apiBanner;
  document.body.classList.toggle('is-stale', S.stale);
  for (const r of $$('.view')) r.setAttribute('aria-busy', String(S.stale));
  // The finding must say straight away that it is no longer being updated —
  // waiting for the next render tick would leave a stale sentence looking live.
  if (el.finding) renderFinding();
  if (!S.stale) {
    b.hidden = true;
    clear(b);
    return;
  }
  clear(b);
  b.hidden = false;
  const seen = S.fetchedAt ? relTime(new Date(S.fetchedAt).toISOString()) : null;
  if (reason === 'malformed') {
    b.append(
      h('strong', {}, 'The API returned a response this console could not read.'),
      h(
        'span',
        {},
        seen ? ` Showing the last state received ${seen}.` : ' No usable state has arrived yet.'
      ),
      h(
        'details',
        {},
        h('summary', {}, 'Show the first 400 characters'),
        h('pre', { class: 'raw' }, S.parseSample || '(empty body)')
      )
    );
  } else {
    b.append(
      h('strong', {}, 'Cannot reach the Signal Zero API.'),
      h(
        'span',
        {},
        seen
          ? ` Showing the last state received ${seen}. Retrying in ${Math.round(S.retryMs / 1000)}s.`
          : ` No state has arrived yet. Retrying in ${Math.round(S.retryMs / 1000)}s.`
      )
    );
  }
  b.append(
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => pollState() }, 'Retry now')
  );
}

// ══════════════════════════════════════════════════════════════════════════
// THE FINDING — the landing sentence.
//
// Built entirely from the live /api/state payload. There is no fixed string
// anywhere in here: every count, every duration and every settlement name is
// read off the rows that arrived in this poll. If a value is missing the
// sentence says so rather than filling the gap.
//
// It distinguishes the two claims the data actually supports, because they are
// not equally strong (docs/three-kinds-of-silence.md):
//   • "never heard from"      — an admission of ignorance. Epistemically weak.
//   • "reported, then stopped" — an observed transition. The strongest claim
//     the product has, and it was previously invisible.
//
// States handled: before the first state arrives, before the first pass has
// scored anything (the real first ~40s), mid-run, stale, and failed.
// ══════════════════════════════════════════════════════════════════════════

/** "96 hours" / "4 days" — prose, and never rounded into a claim. */
function hoursPhrase(n) {
  if (!Number.isFinite(n)) return 'an unrecorded length of time';
  if (n < 2) return `${n.toFixed(1)} hours`;
  if (n < 168) return `${Math.floor(n)} hours`;
  const d = Math.floor(n / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

const fnum = (id) => h('b', { class: 'fnum', id });

let findingShape = '';
function renderFinding() {
  const line = el.finding;
  const bLine = el.findingB;
  const note = el.findingNote;
  const all = rows();

  // ── state 1: nothing has arrived yet ──────────────────────────────────
  if (!S.state) {
    if (findingShape !== 'boot') {
      findingShape = 'boot';
      clear(line);
      clear(bLine);
      line.append(
        h('span', { class: 'skel skel-finding', 'aria-hidden': 'true' }),
        h('span', { class: 'vh' }, 'Waiting for the first state from the console API.')
      );
      bLine.className = 'finding-b is-none';
    }
    note.className = 'finding-note';
    note.textContent = 'Waiting for the first state from the console API.';
    return;
  }

  // ── state 2: state arrived, nothing scored yet (the real first ~40s) ───
  if (!all.length) {
    if (findingShape !== 'nodata') {
      findingShape = 'nodata';
      clear(line);
      clear(bLine);
      line.append('No settlement has been scored yet.');
      bLine.className = 'finding-b is-none';
      bLine.textContent =
        'The first pass has to reach the sources, resolve reports to places and fit ' +
        'a baseline before anything can be ranked.';
    }
    note.className = 'finding-note';
    clear(note);
    note.append(
      S.running
        ? h('span', {}, h('span', { class: 'runmark', 'aria-hidden': 'true' }), 'Pass running…')
        : h('span', {}, 'No pipeline pass has completed.')
    );
    return;
  }

  // ── state 3: live ─────────────────────────────────────────────────────
  const g = groupByKind(all);
  const never = g.never.length;
  const stopped = g.stopped.length;
  const total = all.length;
  const neverHours = g.never.map((r) => Number(r.silenceHours)).filter(Number.isFinite);
  const floorHours = neverHours.length ? Math.min(...neverHours) : NaN;

  const shape = `live|${never > 0}|${stopped > 0}`;
  if (shape !== findingShape) {
    findingShape = shape;
    clear(line);
    clear(bLine);

    // Wording is load-bearing (skills/no-dispatch-language). The sentence says
    // what has reached US. It never says what a settlement did — we cannot see
    // that, and asserting it would convert an absence into a diagnosis.
    if (never > 0) {
      line.append(
        'Nothing has reached us from ',
        fnum('fnum-never'),
        ' of ',
        fnum('fnum-total'),
        ' settlements ',
        h('span', { id: 'finding-window' }, ''),
        '.'
      );
    } else {
      line.append(
        'At least one report has reached us from every one of ',
        fnum('fnum-total'),
        ' settlements.'
      );
    }

    if (stopped > 0) {
      bLine.className = 'finding-b';
      bLine.append(
        fnum('fnum-stopped'),
        ' ',
        h('span', { id: 'finding-b-verb' }, ''),
        h('span', { class: 'fb-who', id: 'finding-b-who' })
      );
    } else {
      bLine.className = 'finding-b is-none';
      bLine.append(h('span', { id: 'finding-b-verb' }, ''));
    }
  }

  if (never > 0) {
    countUp($('#fnum-never'), never);
    const win = $('#finding-window');
    if (win) {
      win.textContent = Number.isFinite(floorHours)
        ? `in ${hoursPhrase(floorHours)}`
        : 'for a length of time the server did not record';
    }
  }
  countUp($('#fnum-total'), total);

  const verb = $('#finding-b-verb');
  if (stopped > 0) {
    countUp($('#fnum-stopped'), stopped);
    if (verb) {
      verb.textContent =
        stopped === 1
          ? 'more reported, and nothing has reached us since.'
          : 'more reported, and nothing has reached us since.';
    }
    const who = $('#finding-b-who');
    if (who) {
      clear(who);
      // Named, with the two figures that matter and the moment contact was lost.
      for (const r of g.stopped.slice(0, 3)) {
        who.append(
          h(
            'span',
            { class: 'fb-one', title: r.lastReportAt || '' },
            h('b', {}, r.name || r.settlementId || 'unnamed'),
            ` · ${fmtPeople(r.population)} · ${fmtDuration(r.silenceHours)} since the ` +
              `${Number(r.reportCount) === 1 ? 'only report' : 'last of ' + fmtCount(r.reportCount) + ' reports'}` +
              ` that resolved here${r.lastReportAt ? `, ${relTime(r.lastReportAt)}` : ''}`
          )
        );
      }
      if (g.stopped.length > 3) {
        who.append(h('span', { class: 'fb-one' }, `and ${g.stopped.length - 3} more.`));
      }
    }
  } else if (verb) {
    verb.textContent =
      'No settlement reported and then stopped in this pass. That group is the ' +
      'strongest signal this console can produce, and today it is empty.';
  }

  // ── the honest status line under the sentence ─────────────────────────
  const st = S.state.stats || {};
  clear(note);
  if (S.stale) {
    note.className = 'finding-note warnish';
    note.append(
      `Last state received ${S.fetchedAt ? relTime(new Date(S.fetchedAt).toISOString()) : 'never'}. ` +
        'The console cannot reach the API; these figures are not being updated.'
    );
  } else if (S.running) {
    note.className = 'finding-note';
    note.append(
      h('span', { class: 'runmark', 'aria-hidden': 'true' }),
      'Recomputing. The sentence above is from the last completed pass.'
    );
  } else {
    note.className = 'finding-note';
    const srcs = S.state.sources.length;
    note.append(
      `Last complete pass ${st.lastRunAt ? relTime(st.lastRunAt) || 'just now' : 'never'} · ` +
        `${fmtCount(st.reportCount)} reports from ${srcs || 'no'} source${srcs === 1 ? '' : 's'} · ` +
        `ranking computed server-side, not here.`
    );
  }

  announceFinding();
}

// One announcement per settled sentence — never one per animation frame.
let lastFindingSpoken = '';
function announceFinding() {
  const spoken = `${el.finding.textContent.trim()} ${el.findingB.textContent.trim()}`.replace(
    /\s+/g,
    ' '
  );
  if (spoken === lastFindingSpoken) return;
  lastFindingSpoken = spoken;
  clearTimeout(announceFinding._t);
  announceFinding._t = setTimeout(() => {
    if (el.findingLive) el.findingLive.textContent = spoken;
  }, 1000);
}

// ══════════════════════════════════════════════════════════════════════════
// The unmissable count: what the agent is waiting on.
// ══════════════════════════════════════════════════════════════════════════

function renderHumanBand() {
  const n = pendingItems().length;
  const band = el.humanBand;
  const txt = el.humanBandText;
  band.hidden = false;
  band.classList.toggle('is-clear', n === 0);
  if (el.humanBandGlyph) el.humanBandGlyph.textContent = n === 0 ? '✓' : '▮';
  el.humanBandGo.hidden = n === 0;
  clear(txt);
  if (n > 0) {
    txt.append(
      h('b', {}, h('span', { class: 'n' }, String(n)), ` decision${n === 1 ? '' : 's'}`),
      ` waiting on a named human. Nothing becomes actionable until someone types their name against it.`
    );
  } else {
    txt.append(
      'Nothing is waiting on a human right now. Everything raised so far has been signed for.'
    );
  }
  // Same count, three places: this band, the tab badge, the status bar.
  el.navBadge.hidden = n === 0;
  el.navBadge.textContent = String(n);
}

// ══════════════════════════════════════════════════════════════════════════
// What the agent is doing — pipeline stages, status track, pass numbers.
// ══════════════════════════════════════════════════════════════════════════

/** Is a pass in flight? The SERVER's answer, with a short optimistic window. */
function isRunning() {
  if (S.run && S.run.status === 'running') return true;
  // Between our 202 and the first poll that reflects it, the server has not said
  // anything yet. `runOptimisticUntil` covers exactly that gap and expires on its
  // own, so a lost poll cannot leave the button spinning forever.
  return Date.now() < S.runOptimisticUntil;
}

/**
 * How long the in-flight pass has been running, in whole seconds, or null.
 *
 * SERVER-MEASURED, extended by the client's own elapsed time since the poll that
 * carried it. Reading `Date.parse(run.startedAt)` against the browser's clock
 * instead would show a negative timer on any machine whose clock is a few seconds
 * ahead of the server's, and a stopwatch that counts backwards is worse than none.
 */
function runElapsedSeconds() {
  if (!S.run || S.run.status !== 'running') return null;
  const base = Number(S.run.elapsedMs);
  if (!Number.isFinite(base)) return null;
  return Math.max(0, Math.floor((base + (Date.now() - S.runFetchedAt)) / 1000));
}

function clock(secs) {
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

let lastAnnounced = '';
function renderStages() {
  const st = S.state ? S.state.stats : null;
  const hasRun = !!(st && st.lastRunAt);
  const failedStages = failedStagesInLastRun();
  const running = isRunning();
  const errored = !!(S.run && S.run.status === 'error');
  const mode = running ? 'running' : hasRun ? 'done' : 'pending';
  // ONE source of truth for "a pass is in flight", derived from the server's
  // answer. Everything else in this file reads S.running; nothing else sets it.
  S.running = running;
  document.body.classList.toggle('is-running', running);

  // The run button reflects the SERVER's single-flight state, not this tab's.
  // Two tabs open on one deployment now agree: the one that did not click still
  // sees the button held while the pass runs, instead of offering an action the
  // server would answer with 409.
  if (el.btnRun) {
    el.btnRun.disabled = running;
    if (running) el.btnRun.setAttribute('aria-busy', 'true');
    else el.btnRun.removeAttribute('aria-busy');
  }

  // WHICH STAGES THE SERVER SAYS ARE DONE. Not a guess from elapsed time, not
  // every row lit at once: `run.stagesCompleted` and `run.stage` are reported by
  // the orchestrator at the point each stage actually begins.
  const completed = new Set(
    running && S.run && Array.isArray(S.run.stagesCompleted) ? S.run.stagesCompleted : []
  );
  const activeStage = running && S.run ? S.run.stage : null;

  const stateOf = (id) => {
    if (mode === 'running') {
      if (failedStages.has(id)) return 'failed';
      if (id === activeStage) return 'active';
      if (completed.has(id)) return 'done';
      // Null `run.stage` means the server has not reported one yet. Nothing is
      // lit rather than everything: "we do not know which stage" is a fact, and
      // lighting the whole rail to look busy would invent one.
      return 'pending';
    }
    if (mode === 'done') return failedStages.has(id) ? 'failed' : 'done';
    return 'pending';
  };
  const glyphOf = (s) => (s === 'done' ? '✓' : s === 'failed' ? '▲' : s === 'active' ? '▸' : '·');
  const wordOf = (s) =>
    s === 'done'
      ? 'complete'
      : s === 'failed'
        ? 'degraded'
        : s === 'active'
          ? 'running'
          : 'not started';

  const stages = stageList();

  // Full labels, never clipped, at every width.
  clear(el.stageList);
  for (const stage of stages) {
    const state = stateOf(stage.id);
    el.stageList.append(
      h(
        'div',
        { class: 'stage-row', 'data-state': state },
        h('span', { class: 'g', 'aria-hidden': 'true' }, glyphOf(state)),
        h('span', {}, h('span', {}, stage.label), h('span', { class: 'bar' }, h('i', {}))),
        h('span', { class: 'lb' }, wordOf(state))
      )
    );
  }

  clear(el.sbTrack);
  for (const stage of stages) {
    el.sbTrack.append(h('i', { 'data-state': stateOf(stage.id), title: stage.label }));
  }

  let sub;
  if (mode === 'running') {
    const secs = runElapsedSeconds();
    const label = activeStage ? STAGE_LABELS[activeStage] || activeStage : null;
    const where = label ? `Running ${label.toLowerCase()}` : 'Running';
    // Every clause below is something the server said. When it has said nothing
    // yet — the window between our 202 and the first poll — the line says exactly
    // that instead of filling in a stage or a stopwatch.
    sub =
      secs === null
        ? `${where} · waiting for the first progress report`
        : `${where} · ${clock(secs)}` +
          (completed.size ? ` · ${completed.size} of ${stages.length} stages complete` : '');
  } else if (errored && S.run) {
    // A pass that failed used to disappear behind the previous pass's "Ready".
    // The run id is here so the failure can be found in the fail feed and in the
    // runs table.
    sub =
      `Last pass failed${S.run.stage ? ` during ${S.run.stage}` : ''}: ${S.run.error || 'no reason reported'}` +
      ` · run ${S.run.runId}`;
  } else if (mode === 'done') {
    sub =
      `Ready · last complete pass ${relTime(st.lastRunAt) || 'just now'}` +
      (Number.isFinite(Number(st.durationMs))
        ? ` in ${(Number(st.durationMs) / 1000).toFixed(1)}s`
        : '') +
      (failedStages.size
        ? ` · ${failedStages.size} stage${failedStages.size === 1 ? '' : 's'} degraded`
        : '');
  } else {
    sub = S.state ? 'No pipeline pass has completed yet.' : 'Waiting for first state…';
  }
  el.railSub.textContent = sub;
  el.sbText.textContent = sub;
  el.sbText.title = sub;
  if (sub !== lastAnnounced) {
    lastAnnounced = sub;
    el.railAnnounce.textContent = sub;
  }
}

/**
 * A stage is marked failed only if the server actually wrote an incident naming
 * it inside THE WINDOW OF THE PASS THE RAIL IS SHOWING. The rail never guesses.
 *
 * The window is the load-bearing part. While a pass is in flight the rail is
 * headed "This pass", so it must not carry the PREVIOUS pass's degradations
 * forward: a triage failure ten minutes ago is not evidence about a run that
 * started four seconds ago, and showing it as one would have a reviewer watching
 * a stage fail that had not yet been reached. So the window starts at
 * `run.startedAt` — the server's own start time for the run being displayed —
 * and the rail comes up clean, filling in only what this pass actually reports.
 */
function failedStagesInLastRun() {
  const out = new Set();
  if (!S.state) return out;
  const st = S.state.stats;

  let start;
  let end;
  if (S.run && S.run.status === 'running' && S.run.startedAt) {
    start = Date.parse(S.run.startedAt) - 2000;
    end = Infinity;
  } else {
    if (!st || !st.lastRunAt) return out;
    end = Date.parse(st.lastRunAt) + 2000;
    start = end - (Number(st.durationMs) || 0) - 4000;
  }
  if (!Number.isFinite(start)) return out;

  const known = new Set(stageList().map((s) => s.id));
  for (const inc of S.state.incidents) {
    if (inc.kind !== 'degraded-source') continue;
    const t = Date.parse(inc.at);
    if (!Number.isFinite(t) || t < start || t > end) continue;
    const stage = inc.detail && inc.detail.stage;
    if (stage && known.has(stage)) out.add(stage);
  }
  return out;
}

// Every number the pass produced, including the tier-3 telemetry — in the room
// whose job is auditing, not on the landing view.
function renderPassKv() {
  const box = el.passKv;
  clear(box);
  if (!S.state) {
    box.append(h('dt', {}, 'state'), h('dd', { class: 'na' }, 'not received yet'));
    return;
  }
  const st = S.state.stats || {};
  const all = rows();
  const g = groupByKind(all);
  const put = (k, v, na) => box.append(h('dt', {}, k), h('dd', { class: na ? 'na' : null }, v));

  put('Reports ingested', fmtCount(st.reportCount));
  put('Clusters after dedup', fmtCount(st.clusterCount));
  put('Settlements scored', all.length ? String(all.length) : 'none', !all.length);
  put('Never reported', String(g.never.length));
  put('Reported then stopped', String(g.stopped.length));
  put('Heard from recently', String(g.recent.length));
  put('Pending decisions', String(pendingItems().length));
  put(
    'Pass duration',
    Number.isFinite(Number(st.durationMs))
      ? `${(Number(st.durationMs) / 1000).toFixed(1)}s`
      : 'not reported',
    !Number.isFinite(Number(st.durationMs))
  );
  put('Last complete pass', st.lastRunAt ? localFull(st.lastRunAt) : 'never', !st.lastRunAt);

  const t3 = st.tier3;
  if (t3 && typeof t3 === 'object') {
    put('Tier-3 by harness', fmtCount(t3.executedByHarness));
    put('Tier-3 by fallback', fmtCount(t3.executedByFallback));
    put('Tier-3 unresolved', fmtCount(t3.unresolved));
    put(
      'Harness',
      t3.harnessReachable
        ? `reachable · ${t3.harnessModel || 'model not reported'}`
        : 'not reachable',
      !t3.harnessReachable
    );
    if (t3.harnessTokens !== undefined) put('Harness tokens', fmtInt(t3.harnessTokens));
  } else {
    put('Tier-3 telemetry', 'not reported by this run', true);
  }
}

/**
 * START a pass. The request no longer waits for it.
 *
 * POST /api/run answers 202 in milliseconds with a run id; the pass itself takes
 * roughly 45 seconds and proceeds on the server. So this function's job ends at
 * "accepted", and everything after that — which stage, how long, whether it
 * failed — is read from GET /api/state, which this page already polls.
 *
 * That is a better view than the one it replaces, not a worse one. The old
 * blocking call could only show a client-side stopwatch and a rail that lit every
 * stage at once, and its sub-line said so: "the server does not report per-stage
 * progress". It does now.
 *
 * The `Idempotency-Key` makes the submission safe to repeat: if the network
 * retries this POST, the server replays the same 202 with the same run id instead
 * of queueing a second pass. See src/http/idempotency.js.
 */
async function runPipeline() {
  if (isRunning()) {
    toast('A pipeline pass is already running.', 'warn', 5000);
    return;
  }
  // Optimistic only until the next poll answers — two seconds, not forever.
  S.runOptimisticUntil = Date.now() + 2000;
  S.running = true;
  el.btnRun.disabled = true;
  el.btnRun.setAttribute('aria-busy', 'true');
  logLocal('Pipeline run requested from the console.');
  renderStages();
  try {
    const res = await fetchJson(
      '/api/run',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey('run')
        },
        body: '{}'
      },
      20000
    );
    if (res.status === 409) {
      const runId = res.body && res.body.runId;
      toast('A pipeline pass is already running.', 'warn', 5000);
      logLocal(
        `Run not started: a pass was already in flight (HTTP 409${runId ? `, run ${runId}` : ''}).`,
        res.body || null
      );
    } else if (res.status !== 202) {
      S.runOptimisticUntil = 0;
      const msg = problemMessage(res.body, res.status);
      toast(`Pipeline run could not be started: ${msg}`, 'critical', 10000);
      logLocal(`Pipeline run could not be started: ${msg}`, res.body || null);
    } else {
      const b = res.body || {};
      // ACCEPTED, not finished. The wording matters: a line saying the pass
      // "completed" here would be a claim this client is in no position to make.
      logLocal(
        `Pipeline pass ${b.runId} accepted (HTTP 202). Progress is on the stage rail; it is read from the server, not timed here.`,
        b
      );
    }
  } catch (err) {
    S.runOptimisticUntil = 0;
    toast('Could not reach the server to start a pipeline pass.', 'critical', 10000);
    logLocal(`Pipeline run could not be started: ${err.message}`);
  } finally {
    el.btnRun.disabled = false;
    el.btnRun.removeAttribute('aria-busy');
    // Ask immediately rather than waiting out the poll interval, so the rail
    // picks up the server's first stage report as soon as there is one.
    pollState();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Region B — silence rank
// ══════════════════════════════════════════════════════════════════════════

function visibleRows() {
  let list = rows().slice();
  if (S.filter === 'anom') list = list.filter((r) => r.anomalyType && r.anomalyType !== 'none');
  else if (S.filter === 'nodata') list = list.filter((r) => silenceKind(r) === 'never');
  else if (S.filter === 'stopped') list = list.filter((r) => silenceKind(r) === 'stopped');
  const q = S.query.trim().toLowerCase();
  if (q)
    list = list.filter(
      (r) =>
        String(r.name || '')
          .toLowerCase()
          .includes(q) ||
        String(r.district || '')
          .toLowerCase()
          .includes(q)
    );

  const { key, dir } = S.sort;
  const sign = dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const av = a[key],
      bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return sign * String(av ?? '').localeCompare(String(bv ?? ''), 'en');
    }
    const an = Number.isFinite(Number(av)) ? Number(av) : -Infinity;
    const bn = Number.isFinite(Number(bv)) ? Number(bv) : -Infinity;
    return sign * (an - bn);
  });
  return list;
}

// Two figures per row by default — how long silent, and how many people. Every
// statistic behind the rank is one disclosure click away and none of it is
// approximated. The row set is rebuilt only when something actually changed;
// a poll that changes nothing must not tear the DOM out from under a focus.
let rankSig = '';
const openWhy = new Set(); // settlementIds whose disclosure is open
const prevBand = new Map(); // settlementId -> last silence band, for the flash

function renderRank(force) {
  const list = visibleRows();
  const all = rows();
  const pend = pendingSettlementIds();
  // !!S.state is part of the signature on purpose: "no state has arrived" and
  // "state arrived with zero rows" produce identical row lists but are two
  // completely different screens (skeletons vs. the honest empty state). Without
  // it the board never leaves its skeletons on a cold boot.
  const sig = JSON.stringify([
    !!S.state,
    S.stale,
    S.running,
    S.filter,
    S.query,
    S.sort,
    S.selectedId,
    all.length,
    list.map((r) => [
      r.settlementId,
      r.rank,
      r.silenceHours,
      r.population,
      r.giZScore,
      r.corroborationCount,
      r.anomalyType,
      r.coverageBasis,
      r.reportCount,
      pend.has(r.settlementId)
    ])
  ]);
  if (!force && sig === rankSig) return;
  const firstPaint = rankSig === '';
  const reordered = rankSig !== sig;
  rankSig = sig;

  const g = groupByKind(all);
  el.rankCount.textContent = all.length
    ? list.length === all.length
      ? `${all.length} settlements`
      : `${list.length} of ${all.length}`
    : '—';
  $('#f-all').textContent = String(all.length);
  $('#f-anom').textContent = String(
    all.filter((r) => r.anomalyType && r.anomalyType !== 'none').length
  );
  $('#f-nodata').textContent = String(g.never.length);
  $('#f-stopped').textContent = String(g.stopped.length);

  const body = el.rankRows;
  clear(body);
  clear(el.rankEmpty);
  clear(el.boardFoot);

  // ── loading: real, not hypothetical. The first ~40s genuinely has no rows. ──
  if (!S.state) {
    el.rankTable.hidden = true;
    el.rankEmpty.append(skeletonRows(10));
    el.boardFoot.textContent = 'Waiting for the first state from the API…';
    return;
  }
  // ── empty ──
  if (!all.length) {
    el.rankTable.hidden = true;
    el.rankEmpty.append(
      emptyState(
        '◌',
        'Nothing scored yet',
        'The first pipeline pass has not produced a ranking. It reaches the sources, resolves reports ' +
          'to places, then fits a baseline before any settlement can be ranked.',
        S.running ? null : { label: 'Run pipeline', onClick: runPipeline }
      )
    );
    el.boardFoot.textContent = S.running ? 'Pass running…' : 'No ranking has been produced.';
    return;
  }
  // ── empty after filtering ──
  if (!list.length) {
    el.rankTable.hidden = true;
    el.rankEmpty.append(
      emptyState(
        '⌕',
        'No settlements match',
        `${all.length} settlements are loaded. Clear the filter to see them.`,
        {
          label: 'Clear filter',
          onClick: () => {
            S.query = '';
            S.filter = 'all';
            el.rankFilter.value = '';
            syncFilterButtons();
            renderRank(true);
          }
        }
      )
    );
    el.boardFoot.textContent = `0 of ${all.length} shown.`;
    return;
  }

  el.rankTable.hidden = false;
  const step = staggerStep(list.length);
  body.style.setProperty('--stg', `${step}ms`);
  const animate = (firstPaint || reordered) && !reducedMotion();

  list.forEach((r, i) => {
    const stop = silStop(r.silenceHours);
    const kind = silenceKind(r);
    const km = KINDS[kind];
    const isPending = pend.has(r.settlementId);
    const open = openWhy.has(r.settlementId);
    const whyId = `why-${r.settlementId}`;

    const silTd = h('td', { class: 'c-sil n' }, fmtDuration(r.silenceHours));
    silTd.style.setProperty('--band', `var(--sil-${stop})`);
    silTd.style.setProperty('--bandtint', `var(--sil-tint-${stop})`);

    const whyBtn = h(
      'button',
      {
        type: 'button',
        class: 'why-btn',
        'aria-expanded': String(open),
        'aria-controls': whyId,
        title: 'Why this ranks here',
        'aria-label': `Why ${r.name || r.settlementId} ranks here`,
        onclick: (ev) => {
          ev.stopPropagation();
          if (openWhy.has(r.settlementId)) openWhy.delete(r.settlementId);
          else openWhy.add(r.settlementId);
          renderRank(true);
          const b = $(`.why-btn[aria-controls="${whyId}"]`, el.rankRows);
          if (b) b.focus();
        }
      },
      open ? '▾' : '▸'
    );

    const tr = h(
      'tr',
      {
        class: `rank-row${isPending ? ' is-pending' : ''}${animate ? ' enter' : ''}`,
        tabindex: '0',
        role: 'button',
        'data-id': r.settlementId,
        'data-kind': kind,
        'aria-selected': String(S.selectedId === r.settlementId),
        'aria-label':
          `${r.name || r.settlementId}, ${r.district || 'district not recorded'}. ` +
          `Rank ${fmtCount(r.rank)}. Silent ${fmtDuration(r.silenceHours)}. ${fmtPeople(r.population)}. ` +
          `${km.word}.${isPending ? ' A human decision is pending here.' : ''} ` +
          'Press Enter to open the full evidence.'
      },
      h('td', { class: 'c-rank' }, fmtCount(r.rank)),
      h(
        'td',
        {
          class: 'c-name',
          title: `${r.name || r.settlementId} · ${r.district || 'district not recorded'}`
        },
        h('b', {}, r.name || r.settlementId),
        h('span', { class: 'd' }, r.district || 'district not recorded')
      ),
      silTd,
      h('td', { class: 'c-pop n' }, fmtInt(r.population)),
      h(
        'td',
        { class: 'c-kind', title: km.label },
        h('span', { class: 'g', 'aria-hidden': 'true' }, km.glyph),
        km.short
      ),
      h('td', { class: 'c-why' }, whyBtn)
    );
    if (animate) tr.style.setProperty('--i', String(i));

    // Direction-aware flash: worse = the ramp's own warm end, resolved = --ok.
    // Never a new hue, and never on a poll where the band did not move.
    const was = prevBand.get(r.settlementId);
    if (was !== undefined && was !== stop) {
      tr.classList.add(stop > was ? 'flash-worse' : 'flash-better');
    }
    prevBand.set(r.settlementId, stop);

    tr.addEventListener('click', () => select(r.settlementId));
    tr.addEventListener('keydown', onRankKey);
    tr.addEventListener('pointerenter', () => mapCtl && mapCtl.hover(r.settlementId, true));
    tr.addEventListener('pointerleave', () => mapCtl && mapCtl.hover(r.settlementId, false));
    body.append(tr);

    if (open) body.append(whyRow(r, whyId));
  });

  const shown = list.length;
  el.boardFoot.textContent =
    (shown === all.length
      ? `All ${all.length} settlements in the corridor. `
      : `Showing ${shown} of ${all.length} — ${all.length - shown} hidden by the filter. `) +
    'Two figures per row; ▸ opens why it ranks there, Enter opens the full evidence.';
}

/**
 * "Why this ranks here" — the complete statistical record for one row.
 * Nothing here is computed in the browser; every figure is the server's own
 * field, printed. The closing note says so explicitly.
 */
function whyRow(r, id) {
  const sig = Number(r.giZScore) > 1.96;
  const kind = silenceKind(r);
  const stat = (k, v, opts = {}) =>
    h(
      'div',
      { class: `why-stat${opts.sig ? ' is-sig' : ''}` },
      h('span', { class: 'k' }, k),
      h('span', { class: `v${opts.na ? ' na' : ''}`, title: opts.title || null }, v)
    );

  const grid = h(
    'div',
    { class: 'why-grid' },
    stat('Gi* z-score', fmtZ(r.giZScore), {
      sig,
      title: 'Getis-Ord Gi* local clustering statistic'
    }),
    stat('own z', fmtZ(r.ownZScore)),
    stat('neighbour z', fmtZ(r.neighborZScore)),
    stat('corridor neighbours', fmtCount(r.neighborCount)),
    stat('surprisal (−ln P)', fmtNum(r.surprisal, 4)),
    stat('λ per hour', fmtLambda(r.lambdaPerHour)),
    stat('expected gap', fmtHours(r.expectedGapHours)),
    stat('silence', fmtHours(r.silenceHours)),
    stat('population', fmtInt(r.population)),
    stat('hazard tier', fmtCount(r.hazardTier)),
    stat('reports resolved here', fmtCount(r.reportCount)),
    stat('independent corroboration', fmtCount(r.corroborationCount)),
    stat('cohort', r.cohortKey || 'not recorded', { na: !r.cohortKey }),
    stat('baseline fit', r.fitBasis || 'not recorded', { na: !r.fitBasis }),
    stat('cohort sample gaps', fmtCount(r.cohortSampleGaps)),
    stat('anomaly type', anomalyOf(r.anomalyType).short || 'none flagged', {
      na: !r.anomalyType || r.anomalyType === 'none'
    }),
    stat('coverage basis', r.coverageBasis || 'not recorded', { na: !r.coverageBasis }),
    stat('last report', r.lastReportAt ? localFull(r.lastReportAt) : 'Never', {
      na: !r.lastReportAt,
      title: r.lastReportAt || ''
    })
  );

  const note = h('p', { class: 'why-note' });
  if (kind === 'never') {
    note.append(
      h('b', {}, 'No data reached us. '),
      `No report has ever resolved to ${r.name || 'this settlement'}, so its expected reporting rate is ` +
        `borrowed from cohort ${r.cohortKey || 'unknown'} rather than measured here. ` +
        `We do not know whether it is quiet, unreachable, or simply unreported.`
    );
  } else if (kind === 'stopped') {
    note.append(
      h('b', {}, 'Coverage existed here and then ceased. '),
      `${fmtCount(r.reportCount)} report${Number(r.reportCount) === 1 ? '' : 's'} resolved to ` +
        `${r.name || 'this settlement'}, the last of them ` +
        `${r.lastReportAt ? localFull(r.lastReportAt) : 'at a time the server did not record'}. ` +
        `A gap in our sources still looks identical to a gap on the ground.`
    );
  } else {
    note.append(
      `A report reached us within the last ${STOPPED_AFTER_HOURS} hours. ` +
        `This row is in the ranking for completeness, not because it is silent.`
    );
  }

  const rule = h(
    'p',
    { class: 'why-note' },
    h('b', {}, 'Ordering. '),
    'The server ranks by Gi* z descending, then surprisal, then population, then settlement id. ' +
      'It is deterministic and no language model touches it. This console displays that rank; ' +
      'it does not compute it.'
  );

  return h(
    'tr',
    { class: 'why-row', id },
    h(
      'td',
      { colspan: '6' },
      h(
        'div',
        { class: 'why-panel' },
        h('h4', {}, `Why ${r.name || r.settlementId} ranks ${fmtCount(r.rank)}`),
        grid,
        note,
        rule
      )
    )
  );
}

function onRankKey(ev) {
  const tr = ev.currentTarget;
  const all = $$('.rank-row', el.rankRows);
  const i = all.indexOf(tr);
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    select(tr.dataset.id, { open: true });
    return;
  }
  let next = null;
  if (ev.key === 'ArrowDown') next = all[Math.min(all.length - 1, i + 1)];
  else if (ev.key === 'ArrowUp') next = all[Math.max(0, i - 1)];
  else if (ev.key === 'Home') next = all[0];
  else if (ev.key === 'End') next = all[all.length - 1];
  if (next) {
    ev.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
}

function syncFilterButtons() {
  for (const b of $$('[data-filt]'))
    b.setAttribute('aria-pressed', String(b.dataset.filt === S.filter));
}

// ══════════════════════════════════════════════════════════════════════════
// Selection + region D — evidence
// ══════════════════════════════════════════════════════════════════════════

async function select(id, opts = {}) {
  if (!id) return;
  S.selectedId = id;
  renderRank(true);
  if (mapCtl) mapCtl.select(id, { fly: opts.fly !== false });
  if (opts.open) setView('settlement');

  const row = rowById(id);
  renderSettlementHead(row, id);

  S.detailLoading = true;
  S.detailError = null;
  S.detail = null; // never render the previous settlement's evidence under a new name
  S.detailId = id;
  renderEvidence();

  const res = await fetchJson(`/api/settlement/${encodeURIComponent(id)}`, {}, 12000).catch(
    (err) => ({ ok: false, status: 0, netError: err })
  );
  if (S.detailId !== id) return;
  S.detailLoading = false;
  if (res.status === 404) {
    S.detail = null;
    S.detailError = { kind: '404', id };
  } else if (!res.ok || res.parseError || !res.body) {
    S.detail = null;
    S.detailError = { kind: 'net', id, status: res.status };
  } else {
    S.detail = res.body;
    S.detailError = null;
  }
  renderEvidence();
}

function clearSelection() {
  S.selectedId = null;
  S.detail = null;
  S.detailId = null;
  S.detailError = null;
  renderSettlementHead(null, null);
  if (mapCtl) mapCtl.select(null, { fly: false });
  renderRank(true);
  renderEvidence();
}

/**
 * The settlement room's header: the two figures that decide anything, large,
 * plus the coverage chip that says what kind of silence this is. Statistics
 * live below, in "why this ranks here".
 */
function renderSettlementHead(row, id) {
  const tab = el.tabSettlement;
  if (!row && !id) {
    el.setName.textContent = 'Nothing selected';
    el.setDistrict.textContent = 'Pick a settlement on the map or on the silence board.';
    clear(el.setFacts);
    if (tab) tab.lastChild.textContent = ' Settlement';
    return;
  }
  el.setName.textContent = row ? row.name || id : id;
  el.setDistrict.textContent = row
    ? `${row.district || 'district not recorded'} · ${row.settlementId}`
    : 'Not in the current ranking.';
  if (tab)
    tab.lastChild.textContent = row && row.name ? ` Settlement · ${row.name}` : ' Settlement';

  clear(el.setFacts);
  if (!row) return;
  const km = KINDS[silenceKind(row)];
  const fact = (k, v, sub) =>
    h(
      'div',
      { class: 'set-fact' },
      h('span', { class: 'k' }, k),
      h('span', { class: 'v' }, v),
      sub ? h('span', { class: 'sub' }, sub) : null
    );
  el.setFacts.append(
    fact(
      'Silent for',
      fmtDuration(row.silenceHours),
      row.lastReportAt ? `since ${localFull(row.lastReportAt)}` : 'no report has ever resolved here'
    ),
    fact('People', fmtInt(row.population), 'population of record'),
    h(
      'div',
      { class: 'set-fact' },
      h('span', { class: 'k' }, 'Coverage'),
      h('span', { class: 'sub', style: 'margin-top:4px' }, coverageChip(row)),
      h('span', { class: 'sub' }, km.word)
    )
  );
}

function renderEvidence() {
  const box = el.evidenceBody;
  clear(box);

  if (!S.selectedId) {
    box.append(
      emptyState(
        '◇',
        'Nothing selected',
        'Pick a settlement from the silence board or the map to see every number behind its score, ' +
          'the reports that reached us, and what we do not know.'
      )
    );
    return;
  }
  const row = rowById(S.selectedId);

  if (S.detailError && S.detailError.kind === '404') {
    box.append(
      h(
        'div',
        { class: 'ev' },
        h(
          'div',
          { class: 'ev-block' },
          h('h4', {}, 'No record'),
          h(
            'p',
            { class: 'unknown' },
            h('strong', {}, `No record for "${S.detailError.id}".`),
            ' The ranking may have been rebuilt since this row was drawn.'
          ),
          h(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              style: 'margin-top:8px',
              onclick: () => pollState()
            },
            'Refresh state'
          )
        )
      )
    );
    return;
  }
  if (S.detailLoading && !S.detail) {
    box.append(skeletonRows(4));
    return;
  }
  if (S.detailError && S.detailError.kind === 'net') {
    box.append(
      h(
        'div',
        { class: 'ev' },
        h(
          'div',
          { class: 'ev-block' },
          h(
            'p',
            { class: 'unknown' },
            h('strong', {}, 'Could not load the evidence for this settlement.'),
            ' The ranking row below is the last state the console received.'
          ),
          row ? observedBlock(row) : null
        )
      )
    );
    return;
  }

  const d = S.detail || {};
  const ranked = d.ranked || row;
  const sb = d.scoreBreakdown || null;
  const grid = h('div', { class: 'ev' });

  // "What we do not know" comes first here, before any number that could be
  // mistaken for a confirmation.
  grid.append(unknownBlock(ranked, d));
  grid.append(h('div', { class: 'ev-cols' }, observedBlock(ranked, d), reportsBlock(d)));

  // The derivation is complete and unedited, but it is folded — it is the
  // largest and least actionable block on the screen when it is open.
  const math = mathBlock(ranked, sb);
  math.classList.remove('ev-block');
  math.querySelector('h4')?.remove();
  grid.append(
    h(
      'details',
      { class: 'why' },
      h(
        'summary',
        {},
        'Why this ranks here',
        h('span', { class: 'hint' }, 'λ, surprisal, Gi* — computed server-side')
      ),
      h('div', { class: 'why-body' }, math)
    )
  );

  const release = S.releases.get(S.selectedId);
  if (release) grid.append(releaseBlock(release));

  if (Array.isArray(d.neighbors) && d.neighbors.length) {
    grid.append(
      h(
        'div',
        { class: 'ev-block' },
        h('h4', {}, 'Corridor neighbours'),
        h(
          'div',
          { class: 'nb-chips' },
          d.neighbors.map((nid) => {
            const nr = rowById(nid);
            return h(
              'button',
              { type: 'button', onclick: () => select(nid) },
              nr ? `${nr.name} · ${fmtHours(nr.silenceHours)}` : nid
            );
          })
        )
      )
    );
  }

  box.append(grid);
}

function observedBlock(r, d) {
  if (!r)
    return h(
      'div',
      { class: 'ev-block' },
      h('h4', {}, 'What we observed'),
      h('p', { class: 'unknown' }, 'This settlement is not in the current ranking.')
    );
  const dl = h('dl', { class: 'kv' });
  const put = (k, v, na) => {
    dl.append(h('dt', {}, k), h('dd', { class: na ? 'na' : null }, v));
  };
  put(
    'Last report',
    r.lastReportAt ? relTime(r.lastReportAt) || localFull(r.lastReportAt) : 'Never',
    !r.lastReportAt
  );
  put('Silent for', fmtHours(r.silenceHours));
  put('Reports', fmtCount(r.reportCount));
  put('Corroboration', fmtCount(r.corroborationCount));
  put('Population', fmtInt(r.population));
  put('Hazard tier', fmtCount(r.hazardTier));
  put(
    'Corridor neighbours',
    fmtCount(r.neighborCount ?? (d && Array.isArray(d.neighbors) ? d.neighbors.length : null))
  );
  put('Anomaly type', anomalyOf(r.anomalyType).short || 'none flagged');
  const blk = h('div', { class: 'ev-block' }, h('h4', {}, 'What we observed'), dl);
  if (r.lastReportAt) {
    dl.querySelectorAll('dd')[0].title = r.lastReportAt;
  } else {
    blk.append(h('p', { class: 'method' }, 'Never — no report has ever resolved here.'));
  }
  blk.append(emptyTail(r, d));
  return blk;
}

// ══════════════════════════════════════════════════════════════════════════
// THE EMPTY-TAIL TIMELINE
// ══════════════════════════════════════════════════════════════════════════
//
// A report-arrival timeline where the data-ink is spent on the GAP. Every tick
// is one report that resolved here, placed by its publishedAt. The stretch at
// the end where no tick appears is drawn heavier and longer than any tick, and
// it is captioned with its measured length — because an empty chart on its own
// reads as "broken" or "not configured", and this one has to read as "measured,
// and nothing arrived".
//
// Nothing here is computed beyond placing server timestamps on an axis. If the
// reports have not loaded, it says so instead of drawing a plausible line.

const TL = { w: 720, h: 86, x0: 10, x1: 710, axis: 44 };

function emptyTail(r, d) {
  const wrap = h('div', { class: 'tl' });
  const sil = Number(r && r.silenceHours);
  const haveReports = d && Array.isArray(d.reports);

  if (!Number.isFinite(sil)) {
    wrap.append(
      h(
        'p',
        { class: 'tl-cap na' },
        'No silence duration was returned for this settlement, so there is no timeline to draw.'
      )
    );
    return wrap;
  }
  if (!haveReports) {
    wrap.append(
      h(
        'p',
        { class: 'tl-cap na' },
        'The reports behind this row have not loaded, so the arrival timeline is not drawn.'
      )
    );
    return wrap;
  }

  const now = Date.now();
  const ages = d.reports
    .map((rep) => (rep && rep.publishedAt ? (now - Date.parse(rep.publishedAt)) / 3600000 : NaN))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => b - a);
  const undated = d.reports.length - ages.length;

  // The window has to hold the whole silence AND every report that reached us.
  const windowH = Math.max(12, sil, ages.length ? ages[0] : 0) * 1.06;
  const xOf = (ageH) => TL.x1 - (Math.min(ageH, windowH) / windowH) * (TL.x1 - TL.x0);

  // The tail starts at the newest report, or at the very start of the window
  // when nothing has ever arrived.
  const tailStart = ages.length ? xOf(ages[ages.length - 1]) : TL.x0;
  const kind = silenceKind(r);
  const stop = silStop(sil);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tl-svg');
  svg.setAttribute('viewBox', `0 0 ${TL.w} ${TL.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.dataset.kind = kind;
  svg.style.setProperty('--tlband', `var(--sil-${stop})`);
  svg.setAttribute(
    'aria-label',
    `Report arrivals over the last ${fmtDuration(windowH)}. ` +
      (ages.length
        ? `${ages.length} report${ages.length === 1 ? '' : 's'} arrived, the most recent ${fmtDuration(sil)} ago, ` +
          `followed by ${fmtDuration(sil)} with no arrival.`
        : `No report arrived at any point in this window.`)
  );

  const add = (name, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.append(n);
    return n;
  };

  // The emptiness gets AREA, not just a line. A tick is one event; a gap is a
  // duration, and a duration on a timeline is a region. This band is what makes
  // the void the largest mark in the component.
  add('rect', {
    class: 'tl-void',
    x: tailStart,
    y: TL.axis - 22,
    width: Math.max(0, TL.x1 - tailStart),
    height: 44
  });

  // the axis
  add('line', { class: 'tl-axis', x1: TL.x0, y1: TL.axis, x2: TL.x1, y2: TL.axis });

  // the gap rule — the heaviest stroke on the drawing, with a bracket at each end
  add('line', { class: 'tl-gap', x1: tailStart, y1: TL.axis, x2: TL.x1, y2: TL.axis });
  add('line', {
    class: 'tl-gap-cap',
    x1: tailStart,
    y1: TL.axis - 20,
    x2: tailStart,
    y2: TL.axis + 20
  });
  add('line', { class: 'tl-gap-cap', x1: TL.x1, y1: TL.axis - 20, x2: TL.x1, y2: TL.axis + 20 });

  // one hairline tick per report that resolved here
  for (const age of ages) {
    const x = xOf(age);
    add('line', { class: 'tl-tick', x1: x, y1: TL.axis - 15, x2: x, y2: TL.axis + 1 });
  }

  // "now" is the right-hand edge and is labelled as such
  const nowT = add('text', { class: 'tl-lab', x: TL.x1, y: TL.axis + 36, 'text-anchor': 'end' });
  nowT.textContent = 'now';
  const startT = add('text', {
    class: 'tl-lab',
    x: TL.x0,
    y: TL.axis + 36,
    'text-anchor': 'start'
  });
  startT.textContent = `${fmtDuration(windowH)} ago`;
  // The measured length of the void, written inside the void — but only when it
  // actually fits inside it. A caption that overflows its own gap would be
  // making the gap look wider than the measurement it is labelling.
  const gapW = TL.x1 - tailStart;
  const inner = fmtDuration(sil);
  if (gapW > inner.length * 10.4 + 26) {
    const t = add('text', {
      class: 'tl-inner',
      x: (tailStart + TL.x1) / 2,
      y: TL.axis - 28,
      'text-anchor': 'middle'
    });
    t.textContent = inner;
  }

  wrap.append(svg);

  // The measured length of the emptiness, stated. This is the whole point of
  // the component: the void is a quantity, not a rendering accident.
  const cap = h('p', { class: `tl-cap tl-kind-${kind}` });
  if (kind === 'never') {
    cap.append(
      h('b', {}, `${fmtDuration(sil)} with no tick. `),
      'No report has ever resolved here, so there is nothing on this line at all. ' +
        'That is an absence of data, not a confirmed silence.'
    );
  } else if (kind === 'stopped') {
    cap.append(
      h('b', {}, `${fmtDuration(sil)} with no tick. `),
      `${fmtCount(ages.length)} report${ages.length === 1 ? '' : 's'} resolved here, the last on ` +
        `${r.lastReportAt ? localFull(r.lastReportAt) : 'a date the server did not record'}, and nothing since. ` +
        'Coverage existed and then ceased.'
    );
  } else {
    cap.append(
      h('b', {}, `Last arrival ${fmtDuration(sil)} ago. `),
      `${fmtCount(ages.length)} report${ages.length === 1 ? '' : 's'} resolved here. This settlement is still being heard from.`
    );
  }
  wrap.append(cap);
  if (undated > 0) {
    wrap.append(
      h(
        'p',
        { class: 'tl-cap na' },
        `${undated} report${undated === 1 ? ' has' : 's have'} no publish time on record and could not be placed on this line.`
      )
    );
  }
  return wrap;
}

function mathBlock(r, sb) {
  const blk = h('div', { class: 'ev-block' }, h('h4', {}, 'How the number was reached'));
  if (!r) {
    blk.append(h('p', { class: 'unknown' }, 'No scored row for this settlement.'));
    return blk;
  }
  const lambda =
    sb && sb.lambdaPerHour !== null && sb.lambdaPerHour !== undefined
      ? sb.lambdaPerHour
      : r.lambdaPerHour;
  const surv = sb ? sb.survivalProbability : null;
  const fit = sb?.fitBasis ?? r.fitBasis ?? null;
  const cohort = sb?.cohortKey ?? r.cohortKey ?? null;
  const gaps = sb?.cohortSampleGaps ?? r.cohortSampleGaps ?? null;

  const lines = [
    `λ  = 1 / expectedGapHours = ${fmtLambda(lambda)}`.padEnd(46) +
      `fitBasis: ${fit ?? 'not reported'}${cohort ? ` (${cohort}${gaps !== null ? `, ${gaps} gaps` : ''})` : ''}`,
    `P(gap ≥ ${fmtHours(r.silenceHours)}) = exp(−λ·t) = ${surv === null || surv === undefined ? 'not reported' : fmtNum(surv, 6)}`.padEnd(
      46
    ) + 'survivalProbability',
    `surprisal      = −ln P = λ·t = ${fmtNum(r.surprisal, 4)}`.padEnd(46) + 'surprisalFormula',
    `Gi* z          = ${fmtZ(r.giZScore)}   (threshold ${fmtNum(sb?.giThreshold ?? 1.96, 2)})`.padEnd(
      46
    ) +
      `ownZ ${fmtZ(r.ownZScore)} · neighbourZ ${fmtZ(r.neighborZScore)} · n=${fmtCount(r.neighborCount)}`
  ];
  blk.append(h('pre', { class: 'formula' }, lines.join('\n')));
  if (sb && sb.method) {
    blk.append(h('p', { class: 'method' }, h('b', {}, 'Method '), sb.method));
  } else {
    blk.append(
      h('p', { class: 'method' }, h('b', {}, 'Method '), 'not returned by the server for this row.')
    );
  }
  blk.append(h('p', { class: 'det-line' }, 'Deterministic. No LLM touched these numbers.'));
  return blk;
}

// Mandatory block — never empty, in any state (spec §6).
function unknownBlock(r, d) {
  const blk = h('div', { class: 'ev-block' }, h('h4', {}, 'What we do not know'));
  const p = h('p', { class: 'unknown' });
  if (r && r.coverageBasis === 'cohort-cold-start') {
    p.append(
      h('strong', {}, 'No data reached us. '),
      `No report has ever resolved to ${r.name}. Its expected reporting rate is borrowed from cohort ` +
        `${r.cohortKey || 'unknown'} (${r.fitBasis || 'unreported'} fit` +
        `${r.cohortSampleGaps !== undefined ? `, ${r.cohortSampleGaps} observed gaps` : ''}), not measured here. ` +
        `We do not know whether ${r.name} is quiet, unreachable, or simply unreported. Nothing on this screen ` +
        `is a confirmation that anything happened there.`
    );
  } else if (r) {
    const n =
      (S.state && S.state.sources.length) ||
      (d && Array.isArray(d.reports) ? new Set(d.reports.map((x) => x.sourceName)).size : 0);
    p.append(
      `Silence means no report has reached us since ${r.lastReportAt ? localFull(r.lastReportAt) : 'the last resolved report'}. ` +
        `It is not a confirmation that this place went quiet. Coverage is limited to the ${n || 'listed'} sources ` +
        `feeding this run; a gap in our sources looks identical to a gap on the ground.`
    );
  } else {
    p.append(
      'Silence here means no report reached us. It is not a confirmation that this place is quiet.'
    );
  }
  blk.append(p);
  return blk;
}

function reportsBlock(d) {
  const blk = h('div', { class: 'ev-block' }, h('h4', {}, 'Reports behind this'));
  const reports = Array.isArray(d.reports) ? d.reports : [];
  if (!reports.length) {
    blk.append(
      h(
        'p',
        { class: 'unknown' },
        h('strong', {}, 'No report has ever resolved to this settlement. '),
        'There is nothing behind this row but the cohort baseline.'
      )
    );
  } else {
    const list = h('div', { class: 'rep-list' });
    for (const rep of reports) {
      const tier = rep.triage && rep.triage.tier;
      const item = h(
        'div',
        { class: `rep${tier === 3 ? ' t3' : ''}` },
        h(
          'div',
          { class: 'rep-top' },
          h('span', {}, rep.sourceName || 'unnamed source'),
          h('span', { class: 'chip chip-reports' }, rep.sourceType || 'type not recorded'),
          h(
            'span',
            {
              class: `tier${tier === 3 ? ' t3' : ''}`,
              title:
                tier === 3
                  ? 'Tier 3 — LLM fallback classification. Reaching this tier is itself a failure signal.'
                  : `Triage tier ${tier ?? '—'}`
            },
            `T${tier ?? '?'}`
          ),
          h('span', {}, (rep.triage && rep.triage.category) || 'uncategorised'),
          h('span', { title: rep.publishedAt || '' }, relTime(rep.publishedAt) || 'no publish time')
        ),
        // Only an absolute http(s) URL becomes a citation. A relative or
        // otherwise unusable one would resolve against our own origin and open a
        // second copy of the console instead of the article - a dead citation is
        // worse than plain text, so it renders as plain text.
        isCitableUrl(rep.url)
          ? h(
              'a',
              { href: rep.url, target: '_blank', rel: 'noopener noreferrer' },
              rep.title || rep.url
            )
          : h('span', {}, rep.title || 'untitled report')
      );
      if (rep.triage && rep.triage.matchedOn) {
        item.append(h('div', { class: 'matched' }, `matched on ${rep.triage.matchedOn}`));
      }
      list.append(item);
    }
    blk.append(list);
  }

  const clusters = Array.isArray(d.clusters) ? d.clusters : [];
  if (clusters.length) {
    blk.append(h('h4', { style: 'margin-top:10px' }, 'Clusters'));
    const dl = h('dl', { class: 'kv' });
    for (const c of clusters) {
      const members = Array.isArray(c.reportIds) ? c.reportIds.length : 0;
      dl.append(
        h('dt', {}, c.id || 'cluster'),
        h(
          'dd',
          {},
          `conf ${fmtNum(c.confidence, 2)} · diversity ${fmtCount(c.sourceTypeDiversity)} · ${members} member${members === 1 ? '' : 's'}`
        )
      );
      if (Number(c.confidence) === 0.5 && members === 1) {
        dl.append(
          h('dt', {}, ''),
          h('dd', { class: 'na' }, 'Singleton — uncorroborated, not "confidently one event".')
        );
      }
    }
    blk.append(dl);
  }
  return blk;
}

function releaseBlock(rel) {
  const blk = h(
    'div',
    { class: 'ev-block' },
    h('h4', {}, `Released to inform — approved by ${rel.approvedBy}`)
  );
  blk.append(shortlistTable(rel.shortlist));
  return blk;
}

function shortlistTable(shortlist) {
  const list = Array.isArray(shortlist) ? shortlist : [];
  if (!list.length) {
    return h('p', { class: 'unknown' }, 'The server released an empty list. Nothing to show.');
  }
  const t = h(
    'table',
    { class: 'shortlist' },
    h('caption', {}, 'ordering: alphabetical-by-district (non-preferential)'),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Committee'),
        h('th', { scope: 'col' }, 'District'),
        h('th', { scope: 'col' }, 'Settlements'),
        h('th', { scope: 'col' }, 'Population')
      )
    ),
    h(
      'tbody',
      {},
      list.map((s) =>
        h(
          'tr',
          {},
          h('td', {}, s.name ?? s.committee ?? '—'),
          h('td', {}, s.district ?? '—'),
          h('td', {}, fmtCount(s.settlementsInDistrict)),
          h('td', {}, fmtInt(s.populationInDistrict))
        )
      )
    )
  );
  return t;
}

// ══════════════════════════════════════════════════════════════════════════
// Region E — human checkpoint queue
// ══════════════════════════════════════════════════════════════════════════

// Live regions re-render only when their content actually changed. A poll that
// changes nothing must not tear the DOM out from under a focused button — the
// keyboard journey to a decision runs through these cards.
let cpSig = '';
function renderCheckpoint(force) {
  const box = el.checkpointBody;
  const pend = pendingItems();
  const done = decidedItems();

  // The lead line for this room, built from live counts.
  clear(el.cpLeadLine);
  if (!S.state) {
    el.cpLeadLine.append('Waiting for the first state…');
  } else if (pend.length) {
    el.cpLeadLine.append(
      h('span', { class: 'n' }, String(pend.length)),
      ` decision${pend.length === 1 ? '' : 's'} ${pend.length === 1 ? 'is' : 'are'} waiting on a named human.`
    );
  } else {
    el.cpLeadLine.append('No decisions are pending.');
  }

  const sig = JSON.stringify([
    !!S.state,
    S.showAllDecided,
    minuteBucket(),
    pend.map((i) => [i.id, i.kind, i.title, i.settlementId, i.createdAt]),
    done.map((i) => [i.id, i.status, i.approvedBy, i.decidedAt])
  ]);
  if (!force && sig === cpSig) return;
  const firstPaint = cpSig === '';
  cpSig = sig;

  clear(box);
  if (!S.state) {
    box.append(skeletonRows(3));
    return;
  }

  box.append(h('div', { class: 'cp-sub' }, `Waiting on a human — ${pend.length}`));
  if (!pend.length) {
    box.append(
      emptyStateOk(
        '✓',
        'Nothing is waiting on a human',
        "Escalations appear here when a settlement's silence clears the escalation gate. " +
          'Nothing becomes actionable until a named human signs for it, and that name cannot be edited afterwards.'
      )
    );
  } else {
    // One ruled surface ordered by the server's own rank — not N equal cards.
    const ordered = pend.slice().sort((a, b) => {
      const ra = rowById(a.settlementId),
        rb = rowById(b.settlementId);
      const na = Number(ra && ra.rank),
        nb = Number(rb && rb.rank);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
    });
    const step = staggerStep(ordered.length);
    const animate = firstPaint && !reducedMotion();
    ordered.forEach((item, i) => {
      const amb = item.kind === 'ambiguous-match';
      const row = item.settlementId ? rowById(item.settlementId) : null;
      const btn = h(
        'button',
        {
          class: `cp-row${animate ? ' enter' : ''}`,
          type: 'button',
          'data-cp': item.id,
          onclick: () => openModal(item.id)
        },
        h('span', { class: 'idx' }, row && row.rank !== undefined ? `#${row.rank}` : String(i + 1)),
        h(
          'span',
          {},
          h('span', { class: 't' }, item.title || '(no title recorded)'),
          h(
            'span',
            { class: 'm' },
            h('span', { class: 'kind' }, amb ? '◆ AMBIGUOUS MATCH' : '▮ ESCALATION'),
            ` · ${row ? `${row.name}, ${row.district}` : item.settlementId || 'no settlement resolved'}` +
              ` · raised ${relTime(item.createdAt) || 'time not recorded'}`
          )
        ),
        h('span', { class: 'go' }, 'Review and decide →')
      );
      if (animate) {
        btn.style.setProperty('--i', String(i));
        btn.style.setProperty('--stg', `${step}ms`);
      }
      box.append(btn);
    });
  }

  box.append(h('div', { class: 'cp-sub' }, `Decided — ${done.length}`));
  if (!done.length) {
    box.append(
      h('p', { class: 'helper', style: 'padding:8px 16px' }, 'No decisions recorded yet.')
    );
    return;
  }
  const ordered = done
    .slice()
    .sort((a, b) => Date.parse(b.decidedAt || 0) - Date.parse(a.decidedAt || 0));
  const shown = S.showAllDecided ? ordered : ordered.slice(0, 8);
  for (const item of shown) {
    const ok = item.status === 'approved';
    box.append(
      h(
        'button',
        {
          class: `cp-decided ${ok ? 'ok' : 'no'}`,
          type: 'button',
          onclick: () => openModal(item.id, true)
        },
        h(
          'span',
          { class: 'who' },
          h('span', { 'aria-hidden': 'true' }, ok ? '✓ ' : '✕ '),
          `${ok ? 'Approved' : 'Rejected'} by ${item.approvedBy || 'name not recorded'}`
        ),
        h('span', { class: 't' }, item.title || '(no title recorded)'),
        h(
          'span',
          { class: 'when', title: item.decidedAt || '' },
          relTime(item.decidedAt) || 'time not recorded'
        )
      )
    );
  }
  if (ordered.length > shown.length) {
    box.append(
      h(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          style: 'margin:8px 16px',
          onclick: () => {
            S.showAllDecided = true;
            renderCheckpoint(true);
          }
        },
        `Show all ${ordered.length} decided`
      )
    );
  }
}

function renderCheckpointBar() {
  const n = pendingItems().length;
  el.statusbar.classList.toggle('pending', n > 0);
  clear(el.cbarText);
  if (n > 0) {
    el.cbarText.append(`${n} waiting on a named human`);
    el.cbarAction.hidden = false;
  } else {
    el.cbarText.append('Nothing waiting on a human');
    el.cbarAction.hidden = true;
  }
}

function focusQueue() {
  setView('decisions');
  const first = $('.cp-row', el.checkpointBody);
  if (first) first.focus();
  else el.viewDecisions.focus();
}

// ══════════════════════════════════════════════════════════════════════════
// Region F — activity & incidents
// ══════════════════════════════════════════════════════════════════════════

function mergedFeed() {
  const server = (S.state ? S.state.incidents : []).map((i) => ({ ...i, _src: 'server' }));
  const local = S.local.map((i) => ({ ...i, _src: 'local' }));
  return server.concat(local).sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
}

let actSig = '';
function renderActivity(force) {
  const list = el.activityList;
  if (!S.state && !S.local.length) {
    if (actSig !== 'skel') {
      actSig = 'skel';
      clear(list);
      list.append(skeletonRows(5));
    }
    return;
  }

  let items = mergedFeed();
  if (S.actFilter === 'incidents')
    items = items.filter((i) => i._src === 'server' && i.kind !== 'heal');
  else if (S.actFilter === 'decisions')
    items = items.filter((i) => /approved by|rejected by/i.test(i.message || ''));
  else if (S.actFilter === 'pipeline')
    items = items.filter((i) => i._src === 'local' || i.kind === 'degraded-source');

  const totalMatched = items.length;
  items = items.slice(0, 80);
  const sig = JSON.stringify([
    S.actFilter,
    totalMatched,
    items.map((i) => i.id || i.at + i.message)
  ]);
  if (!force && sig === actSig) return;
  actSig = sig;
  clear(list);

  el.actCount.textContent = totalMatched
    ? totalMatched > items.length
      ? `showing ${items.length} of ${totalMatched}`
      : `${totalMatched} entries`
    : '';

  if (!items.length) {
    list.append(
      h(
        'li',
        { style: 'display:block' },
        emptyState(
          '·',
          'No activity yet',
          'Pipeline runs, degraded sources, LLM fallbacks and human decisions all land here.'
        )
      )
    );
    return;
  }

  for (const item of items) {
    const kind = item._src === 'local' ? 'local' : item.kind || 'local';
    const meta = INCIDENT_KINDS[kind] || INCIDENT_KINDS.local;
    const li = h(
      'li',
      { class: `k-${kind}` },
      h('span', { class: 't', title: item.at || '' }, clockTime(item.at)),
      h('span', { class: 'g', 'aria-hidden': 'true' }, meta.glyph),
      h(
        'span',
        { class: 'm' },
        h('span', { class: 'lbl' }, meta.label),
        item.message || '(no message)',
        item.detail && item.detail.simulated
          ? h('span', { class: 'chip chip-sim', style: 'margin-left:6px' }, 'SIMULATED')
          : null
      )
    );
    if (item.detail && Object.keys(item.detail).length) {
      const det = h(
        'details',
        {},
        h('summary', {}, 'detail'),
        h('pre', { class: 'raw' }, JSON.stringify(item.detail, null, 2))
      );
      li.append(det);
    }
    list.append(li);
  }
  if (totalMatched > items.length) {
    list.append(
      h(
        'li',
        { class: 'overflow-note', style: 'display:block' },
        `${totalMatched - items.length} older entries are not shown. The full record is in the API response.`
      )
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Region G — source health
// ══════════════════════════════════════════════════════════════════════════

let srcSig = '';
function renderSources() {
  const box = el.sourceChips;
  if (!S.state) {
    if (srcSig !== 'skel') {
      srcSig = 'skel';
      clear(box);
      clear(el.sourceAgg);
      for (let i = 0; i < 4; i++) {
        box.append(h('span', { class: 'skel', style: 'height:16px;margin:5px 0' }));
      }
      el.sbSources.textContent = '';
    }
    return;
  }

  const list = S.state.sources;
  const sig = JSON.stringify([
    minuteBucket(),
    list.map((x) => [x.name, x.status, x.sourceType, x.lastFetchAt]),
    S.state.stats.reportCount
  ]);
  if (sig === srcSig) return;
  srcSig = sig;
  clear(box);
  clear(el.sourceAgg);
  if (!list.length) {
    const anyReports = Number(S.state.stats.reportCount) > 0;
    box.append(
      h(
        'div',
        { class: 'src s-degraded' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }, '▲'),
        h(
          'span',
          { class: 'nm' },
          anyReports
            ? 'Sources not reported by this run'
            : 'No sources registered yet — run the pipeline.'
        ),
        h('span', { class: 'st' }, 'unknown')
      )
    );
    el.sbSources.textContent = 'sources not reported';
    return;
  }
  let live = 0,
    latest = null;
  for (const s of list) {
    const st = statusOf(s.status);
    if (s.status === 'live' || s.status === 'ok') live++;
    if (s.lastFetchAt && (!latest || Date.parse(s.lastFetchAt) > Date.parse(latest)))
      latest = s.lastFetchAt;
    box.append(
      h(
        'div',
        {
          class: `src ${st.cls}`,
          title: s.lastFetchAt ? `last fetch ${s.lastFetchAt}` : 'no fetch recorded'
        },
        h('span', { class: 'dot', 'aria-hidden': 'true' }, st.glyph),
        h(
          'span',
          { class: 'nm' },
          s.name || 'unnamed source',
          h('span', { class: 'ty' }, ` · ${s.sourceType || 'type not recorded'}`)
        ),
        h('span', { class: 'st' }, s.status || 'unknown')
      )
    );
  }
  el.sourceAgg.textContent = `${live} of ${list.length} live · last fetch ${latest ? relTime(latest) || '—' : 'not recorded'}`;
  el.sbSources.textContent = `${live}/${list.length} sources live`;
}

// ══════════════════════════════════════════════════════════════════════════
// Section 5 — the Human Checkpoint modal
// ══════════════════════════════════════════════════════════════════════════

const RULE_BAR =
  'Signal Zero does not dispatch. Approving this releases a non-preferential, alphabetical list of ' +
  'district committees to inform. It never says where to go, who should go, or what to do.';
const HELPER_DEFAULT =
  'This name is written to the decision record, shown in the activity log, and cannot be edited ' +
  'afterwards. The server refuses anonymous decisions.';

let modal = null;

function openModal(itemId, readOnly = false) {
  const item = (S.state ? S.state.checkpoint : []).find((i) => i.id === itemId);
  if (!item) {
    toast('That checkpoint item is no longer in the queue.', 'warn');
    pollState();
    return;
  }
  if (modal) {
    swapModal(item, readOnly);
    return;
  }

  const opener = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const dlg = h('div', {
    class: 'dialog',
    role: 'dialog',
    'aria-modal': 'true',
    tabindex: '-1',
    'aria-label': `Human Checkpoint. ${item.title || ''}`
  });
  scrim.append(dlg);
  el.modalRoot.append(scrim);

  for (const node of Array.from(document.body.children)) {
    if (node === el.modalRoot) continue;
    node.setAttribute('aria-hidden', 'true');
    try {
      node.inert = true;
    } catch {
      /* older engines */
    }
  }

  modal = {
    scrim,
    dlg,
    item,
    readOnly,
    opener,
    submitting: false,
    decided: null,
    shortlist: null,
    // ONE IDEMPOTENCY KEY PER (item, action, name) ATTEMPT, minted lazily below
    // and REUSED by the Retry button. That reuse is the point: a decision whose
    // response was lost to a timeout is exactly the case where a human clicks
    // again, and without a key the retry either writes a second row into an
    // append-only decision log or comes back 409 with no way to tell whether the
    // first attempt landed. With one, the server replays the first answer.
    idempotencyKeys: new Map()
  };
  dlg.addEventListener('keydown', onModalKey);
  renderModal();
  dlg.focus();
}

function swapModal(item, readOnly) {
  modal.item = item;
  modal.readOnly = readOnly;
  modal.decided = null;
  modal.shortlist = null;
  modal.submitting = false;
  // The per-settlement detail belongs to the item we are leaving, not the one we
  // are opening. Left in place it renders the PREVIOUS settlement's reports under
  // "Reports behind this" and its cohort in the math block - which is exactly the
  // claim this product must never get wrong: a settlement with no reports would
  // show another settlement's headlines as its evidence. Clearing these also
  // re-arms the fetch guard below, so the new item loads its own detail.
  modal.detail = null;
  modal.breakdown = null;
  modal.detailPending = false;
  modal.cued = false;
  renderModal();
  modal.dlg.focus();
}

function closeModal(reason) {
  if (!modal) return;
  const { scrim, opener, item } = modal;
  scrim.remove();
  for (const node of Array.from(document.body.children)) {
    if (node === el.modalRoot) continue;
    node.removeAttribute('aria-hidden');
    try {
      node.inert = false;
    } catch {
      /* older engines */
    }
  }
  if (reason === 'escape' || reason === 'close') {
    if (item && item.status === 'pending') {
      logLocal(`Checkpoint ${item.id} left pending — no decision recorded.`);
    }
  }
  modal = null;
  if (opener && document.contains(opener)) opener.focus();
  else focusQueue();
}

function onModalKey(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeModal('escape');
    return;
  }
  if (ev.key !== 'Tab') return;
  const f = focusables(modal.dlg);
  if (!f.length) return;
  const first = f[0],
    last = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
}

function focusables(root) {
  return $$(
    'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    root
  ).filter((n) => n === document.activeElement || n.getClientRects().length > 0);
}

function renderModal() {
  const { dlg, item } = modal;
  const pend = pendingItems();
  const idx = pend.findIndex((i) => i.id === item.id);
  const amb = item.kind === 'ambiguous-match';
  const ro = modal.readOnly || item.status !== 'pending';
  dlg.classList.toggle('ro', ro);
  clear(dlg);

  // ── header ──
  const kicker = h(
    'div',
    { class: 'dlg-kicker' },
    ro
      ? h('span', { class: `pill-decided${item.status === 'approved' ? '' : ' no'}` }, 'DECIDED')
      : h('span', {}, `HUMAN CHECKPOINT · ${idx >= 0 ? idx + 1 : 1} of ${pend.length} pending`),
    h(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => closeModal('close')
      },
      ro ? 'Close' : 'Close without deciding'
    )
  );

  const head = h(
    'div',
    { class: 'dlg-head' },
    kicker,
    h('h2', { class: 'dlg-title' }, item.title || '(no title recorded)'),
    h(
      'p',
      { class: `dlg-kind${amb ? ' amb' : ''}` },
      h('b', {}, amb ? '◆ AMBIGUOUS MATCH' : '▲ ESCALATION'),
      ` · ${item.settlementId || 'no settlement resolved'} · raised ${relTime(item.createdAt) || 'time not recorded'}`
    )
  );
  dlg.append(head);

  if (ro) {
    dlg.append(
      h(
        'div',
        { class: 'ro-banner' },
        `Decided by ${item.approvedBy || 'name not recorded'} on ${localFull(item.decidedAt)}. This record cannot be changed.`
      )
    );
  } else {
    dlg.append(
      h('div', { class: 'rule-bar' }, h('span', { 'aria-hidden': 'true' }, 'ⓘ'), RULE_BAR)
    );
  }

  // ── body ──
  const body = h('div', { class: 'dlg-body' });
  const ev = item.evidence || {};
  const row = item.settlementId ? rowById(item.settlementId) : null;
  const src = { ...ev, ...(row || {}) };

  // Reading order teaches priority: the limits of the evidence come before the
  // confidence-inspiring numbers, and the derivation comes last, folded.
  body.append(h('section', {}, h('h4', {}, 'What we do not know'), unknownParagraph(item, src)));

  body.append(h('section', {}, h('h4', {}, 'What we observed'), observedKv(src, ev)));

  if (amb) {
    body.append(h('section', {}, h('h4', {}, 'The two candidates'), candidatesBlock(ev)));
  } else {
    const sec = h('section', {}, h('h4', {}, 'Reports behind this'));
    if (modal.detail) {
      const rb = reportsBlock(modal.detail);
      rb.classList.remove('ev-block');
      rb.querySelector('h4')?.remove();
      sec.append(rb);
    } else if (item.settlementId) {
      sec.append(
        h('p', { class: 'helper' }, 'Loading the reports the server holds for this settlement…')
      );
    } else {
      sec.append(
        h(
          'p',
          { class: 'unknown' },
          'This item is not tied to a settlement, so there are no reports behind it.'
        )
      );
    }
    body.append(sec);
  }

  body.append(
    h(
      'details',
      { class: 'why' },
      h(
        'summary',
        {},
        'How the number was reached',
        h('span', { class: 'hint' }, 'λ, surprisal, Gi* — computed server-side')
      ),
      h(
        'div',
        { class: 'why-body' },
        (() => {
          const inner = mathBlock(row || evAsRow(ev), modal.breakdown || null);
          inner.classList.remove('ev-block');
          inner.querySelector('h4')?.remove();
          return inner;
        })()
      )
    )
  );

  body.append(
    h(
      'details',
      {},
      h('summary', {}, 'Show the exact evidence the server holds'),
      h('pre', { class: 'raw' }, JSON.stringify(item, null, 2))
    )
  );

  if (modal.decided) body.append(successBlock());
  dlg.append(body);

  // ── footer ──
  const signing = !(ro || modal.decided);
  dlg.append(signing ? decisionFooter() : decidedFooter());
  // Once per opened item, not once per re-render — the detail fetch re-renders
  // this dialog and a cue that repeated on every poll would be a nag, not a cue.
  if (signing && !modal.cued) {
    modal.cued = true;
    requestAnimationFrame(() => requestAnimationFrame(() => cueSignNote()));
  }

  if (!modal.detail && item.settlementId && !modal.detailPending) {
    modal.detailPending = true;
    fetchJson(`/api/settlement/${encodeURIComponent(item.settlementId)}`, {}, 12000)
      .then((res) => {
        if (!modal || modal.item.id !== item.id) return;
        modal.detailPending = false;
        if (res.ok && res.body && !res.parseError) {
          modal.detail = res.body;
          modal.breakdown = res.body.scoreBreakdown || null;
          renderModal();
        }
      })
      .catch(() => {
        if (modal) modal.detailPending = false;
      });
  }
}

function evAsRow(ev) {
  return {
    name: ev.name,
    district: ev.district,
    silenceHours: ev.silenceHours,
    expectedGapHours: ev.expectedGapHours,
    surprisal: ev.surprisal,
    giZScore: ev.giZScore,
    ownZScore: ev.ownZScore,
    neighborZScore: ev.neighborZScore,
    neighborCount: ev.neighborCount,
    coverageBasis: ev.coverageBasis,
    cohortKey: ev.cohortKey,
    fitBasis: ev.fitBasis,
    lambdaPerHour: ev.lambdaPerHour,
    cohortSampleGaps: ev.cohortSampleGaps
  };
}

function observedKv(src, ev) {
  const dl = h('dl', { class: 'kv' });
  const put = (k, v, na) => dl.append(h('dt', {}, k), h('dd', { class: na ? 'na' : null }, v));
  if (src.name) put('Settlement', `${src.name}${src.district ? `, ${src.district}` : ''}`);
  if (src.settlementId || ev.settlementId)
    put('Settlement id', src.settlementId || ev.settlementId);
  put('Last report', src.lastReportAt ? localFull(src.lastReportAt) : 'Never', !src.lastReportAt);
  put('Silent for', fmtHours(src.silenceHours));
  put('Expected gap', fmtHours(src.expectedGapHours));
  put('Reports', fmtCount(src.reportCount));
  put('Corroboration', fmtCount(src.corroborationCount));
  put('Population', fmtInt(src.population));
  put('Hazard tier', fmtCount(src.hazardTier));
  put('Rank', fmtCount(src.rank));
  put('Coverage basis', src.coverageBasis || 'not recorded');
  return dl;
}

function unknownParagraph(item, src) {
  const p = h('p', { class: 'unknown' });
  if (item.kind === 'ambiguous-match') {
    const ev = item.evidence || {};
    p.append(
      `The match probability is ${fmtNum(ev.matchProbability ?? ev.probability ?? ev.p, 2)}, between the ` +
        `auto-reject threshold (${fmtNum(ev.lowerThreshold, 2)}) and the auto-merge threshold ` +
        `(${fmtNum(ev.upperThreshold, 2)}). The machine refuses to guess which of these is correct. ` +
        `Merging two different places, or splitting one, both corrupt the ranking downstream.`
    );
  } else if (src.coverageBasis === 'cohort-cold-start') {
    p.append(
      h('strong', {}, 'No data reached us. '),
      `No report has ever resolved to ${src.name || 'this settlement'}. Its expected reporting rate is ` +
        `borrowed from cohort ${src.cohortKey || 'unknown'} (${src.fitBasis || 'unreported'} fit` +
        `${src.cohortSampleGaps !== undefined ? `, ${src.cohortSampleGaps} observed gaps` : ''}), not measured here. ` +
        `We do not know whether ${src.name || 'it'} is quiet, unreachable, or simply unreported. Nothing on this ` +
        `screen is a confirmation that anything happened there.`
    );
  } else {
    const n = (S.state && S.state.sources.length) || 0;
    p.append(
      `Silence means no report has reached us since ${src.lastReportAt ? localFull(src.lastReportAt) : 'the last resolved report'}. ` +
        `It is not a confirmation that this place went quiet. Coverage is limited to the ${n || 'listed'} sources ` +
        `feeding this run; a gap in our sources looks identical to a gap on the ground.`
    );
  }
  return p;
}

/**
 * A candidate may arrive as a plain label (the simulated ambiguous match) or as
 * the full report object dedup actually compared (`{id, title, sourceName, …}`).
 * Rendering the object with String() printed "[object Object]" where the human
 * needs the headline they are being asked to decide about.
 */
function candidateLabel(c) {
  if (c === null || c === undefined) return null;
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if (typeof c !== 'object') return null;
  const title = String(c.title || c.label || c.name || '').trim();
  const src = String(c.sourceName || c.source || '').trim();
  if (title) return src ? `${title} — ${src}` : title;
  const id = String(c.id || c.reportId || '').trim();
  return id || null;
}

function candidatesBlock(ev) {
  const wrap = h('div', {});
  const left = candidateLabel(ev.leftLabel ?? ev.aLabel ?? ev.a ?? ev.leftId ?? ev.aId ?? null);
  const right = candidateLabel(ev.rightLabel ?? ev.bLabel ?? ev.b ?? ev.rightId ?? ev.bId ?? null);
  if (!left && !right) {
    wrap.append(
      h('p', { class: 'unknown' }, 'The server did not record the two candidates for this item.')
    );
    return wrap;
  }
  // Dedup records the undecidable window as `band: [lo, hi]`; the simulated item
  // uses lowerThreshold/upperThreshold. Read whichever is present rather than
  // printing an empty range.
  const band = Array.isArray(ev.band) ? ev.band : null;
  const lo = ev.lowerThreshold ?? (band ? band[0] : undefined);
  const hi = ev.upperThreshold ?? (band ? band[1] : undefined);

  const dl = h('dl', { class: 'kv' });
  dl.append(h('dt', {}, 'Candidate A'), h('dd', {}, left ?? '—'));
  dl.append(h('dt', {}, 'Candidate B'), h('dd', {}, right ?? '—'));
  dl.append(
    h('dt', {}, 'Match probability'),
    h('dd', {}, fmtNum(ev.matchProbability ?? ev.probability ?? ev.p, 2))
  );
  dl.append(
    h('dt', {}, 'Undecidable band'),
    h(
      'dd',
      {},
      lo === undefined && hi === undefined ? 'not recorded' : `${fmtNum(lo, 2)} … ${fmtNum(hi, 2)}`
    )
  );
  wrap.append(dl);
  if (ev.note) wrap.append(h('p', { class: 'method' }, ev.note));
  if (ev.reason) wrap.append(h('p', { class: 'method' }, ev.reason));
  return wrap;
}

function decidedFooter() {
  return h(
    'div',
    { class: 'dlg-foot' },
    h(
      'div',
      { class: 'dlg-actions' },
      pendingItems().length && modal.decided
        ? h(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onclick: () => {
                const next = pendingItems()[0];
                if (next) swapModal(next, false);
                else closeModal('close');
              }
            },
            'Next pending item →'
          )
        : null,
      h('button', { class: 'btn', type: 'button', onclick: () => closeModal('close') }, 'Close')
    )
  );
}

function decisionFooter() {
  const input = h('input', {
    type: 'text',
    id: 'approver',
    autocomplete: 'name',
    spellcheck: 'false',
    placeholder: 'e.g. R. Gurung, District Duty Officer',
    'aria-describedby': 'approver-help'
  });
  const help = h('p', { class: 'helper', id: 'approver-help' }, HELPER_DEFAULT);
  const announce = h('p', { class: 'vh', 'aria-live': 'polite' });

  // Both buttons are described by the uncertainty statement itself, so a screen
  // reader hears the limits of the evidence as part of the control it is about
  // to operate — the non-visual form of "on screen at the moment of signing".
  const reject = h(
    'button',
    {
      class: 'btn btn-reject',
      type: 'button',
      'aria-disabled': 'true',
      'aria-describedby': 'sign-caveat'
    },
    h('span', { 'aria-hidden': 'true' }, '✕'),
    'Reject — not actionable'
  );
  const approve = h(
    'button',
    {
      class: 'btn btn-approve',
      type: 'button',
      'aria-disabled': 'true',
      'aria-describedby': 'sign-caveat'
    },
    h('span', { 'aria-hidden': 'true' }, '✓'),
    'Approve — release shortlist'
  );

  let wasEnabled = false;
  const sync = () => {
    const on = input.value.trim().length > 0;
    for (const b of [reject, approve]) b.setAttribute('aria-disabled', String(!on));
    // needName() below latches a red "Enter your name" error and aria-invalid on
    // the field. Nothing used to take them off again, so once an operator had
    // clicked a disabled button, the dialog showed enabled buttons and a red
    // "enter your name" error side by side for the rest of its life — and a
    // screen reader kept announcing a filled, valid field as invalid. Clearing
    // is part of validating, so it belongs here, on the same signal.
    if (on) {
      help.classList.remove('err');
      help.textContent = HELPER_DEFAULT;
      input.removeAttribute('aria-invalid');
    }
    if (on && !wasEnabled) {
      announce.textContent = 'Approve and reject are now available.';
      wasEnabled = true;
      // This is the moment of signing. Pull the eye back to what we do not know
      // — once, slowly, with no bounce — and then LEAVE it emphasised. From here
      // on a click is irreversible, so the caveat stays raised until the dialog
      // closes rather than settling back down.
      cueSignNote({ persist: true });
    }
    if (!on) wasEnabled = false;
  };
  input.addEventListener('input', sync);
  // Enter must never be a path to an irreversible decision.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      reject.focus();
    }
  });

  const needName = () => {
    help.classList.add('err');
    help.textContent = 'Enter your name to approve or reject.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };

  const submit = async (action, btn) => {
    if (btn.getAttribute('aria-disabled') === 'true') {
      needName();
      return;
    }
    if (modal.submitting) return;
    modal.submitting = true;
    const name = input.value.trim();
    const label = btn.textContent;
    btn.textContent = 'Recording…';
    for (const b of [reject, approve]) b.setAttribute('aria-disabled', 'true');
    input.setAttribute('readonly', 'true');

    let res;
    try {
      // Keyed on the action AND the name: changing the name is a different
      // decision and must not replay the previous one's answer. The server
      // enforces that too — a reused key with a changed body is refused with
      // 409 idempotency-key-reuse rather than silently replayed.
      const keySeed = `${action}:${name}`;
      if (!modal.idempotencyKeys.has(keySeed)) {
        modal.idempotencyKeys.set(keySeed, idempotencyKey('decide'));
      }
      res = await fetchJson(
        `/api/checkpoint/${encodeURIComponent(modal.item.id)}/${action}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': modal.idempotencyKeys.get(keySeed)
          },
          body: JSON.stringify({ approvedBy: name })
        },
        20000
      );
    } catch (err) {
      res = { ok: false, status: 0 };
    }

    modal.submitting = false;
    btn.textContent = label;
    input.removeAttribute('readonly');
    sync();

    if (res.status === 0) {
      // A decision failure is never a toast — it must not be dismissible.
      help.classList.add('err');
      clear(help);
      help.append(
        h('span', {}, 'Could not reach the server. '),
        h('strong', {}, 'No decision was recorded.'),
        h('span', {}, ' Check the connection and try again.')
      );
      const retry = h(
        'button',
        { class: 'btn btn-sm', type: 'button', onclick: () => submit(action, btn) },
        'Retry'
      );
      help.append(' ', retry);
      logLocal(
        `Checkpoint ${modal.item.id}: ${action} could not be sent. No decision was recorded.`
      );
      return;
    }
    if (res.status === 400 && res.body && res.body.code === 'APPROVER_REQUIRED') {
      help.classList.add('err');
      help.textContent = problemMessage(
        res.body,
        res.status,
        'A named human approver is required. Nothing in Signal Zero becomes actionable anonymously.'
      );
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    if (res.status === 404) {
      toast('That checkpoint item is no longer on the server. Refreshing the queue.', 'warn');
      closeModal('gone');
      pollState();
      return;
    }
    if (res.status === 409) {
      // The server's `detail` NAMES THE HUMAN who decided first — that is the
      // whole point of the conflict, and paraphrasing it here would drop the name.
      // (This line previously read `b.status`, which under RFC 9457 is the integer
      // 409, and would have rendered "This item was already 409".)
      const detail = problemMessage(
        res.body,
        res.status,
        'This item was already decided by someone else.'
      );
      modal.dlg
        .querySelector('.dlg-body')
        .prepend(h('div', { class: 'conflict' }, `${detail} Refreshing the queue.`));
      for (const bt of [reject, approve]) {
        bt.setAttribute('aria-disabled', 'true');
        bt.disabled = true;
      }
      await pollState();
      const next = pendingItems()[0];
      if (next) swapModal(next, false);
      return;
    }
    if (!res.ok || !res.body || !res.body.ok) {
      help.classList.add('err');
      help.textContent = problemMessage(
        res.body,
        res.status,
        `The server rejected the decision (HTTP ${res.status}). No decision was recorded.`
      );
      return;
    }

    const item = res.body.item || {};
    modal.decided = { status: item.status, approvedBy: item.approvedBy, decidedAt: item.decidedAt };
    modal.shortlist = Array.isArray(res.body.shortlist) ? res.body.shortlist : [];
    modal.item = { ...modal.item, ...item };
    logLocal(`Checkpoint ${modal.item.id} ${item.status} by ${item.approvedBy}.`, {
      checkpointId: modal.item.id,
      status: item.status
    });
    if (item.status === 'approved' && modal.item.settlementId) {
      S.releases.set(modal.item.settlementId, {
        approvedBy: item.approvedBy,
        decidedAt: item.decidedAt,
        shortlist: modal.shortlist
      });
    }
    await pollState();
    if (!modal) return;
    renderModal();
    const heading = modal.dlg.querySelector('.success');
    if (heading) heading.focus();
  };

  reject.addEventListener('click', () => submit('reject', reject));
  approve.addEventListener('click', () => submit('approve', approve));

  // Hard rule: the uncertainty statement must be on screen AT THE MOMENT OF
  // SIGNING, not 300px above the fold in a scrolling body. It is repeated here,
  // in the signing panel itself, alongside the gate.
  const ev = modal.item.evidence || {};
  const row = modal.item.settlementId ? rowById(modal.item.settlementId) : null;
  const src = { ...ev, ...(row || {}) };
  const caveat = h(
    'p',
    { class: 'sign-note', id: 'sign-caveat', tabindex: '-1' },
    h('b', {}, 'Before you sign: '),
    unknownParagraph(modal.item, src).textContent
  );

  const gate = h(
    'p',
    { class: 'gate' },
    'Both buttons stay unavailable until you type your name. Approve and reject carry equal weight.'
  );

  // The rail is the choreography: a single 3px rule draws down the left edge of
  // the signing panel and stops at the caveat. It moves once, on a hard
  // ease-in-out with no overshoot, and it never repeats on its own.
  return h(
    'div',
    { class: 'dlg-foot' },
    h('span', { class: 'sign-rail', 'aria-hidden': 'true' }),
    caveat,
    gate,
    h('label', { for: 'approver' }, 'Your name (required, recorded permanently)'),
    input,
    help,
    announce,
    h('div', { class: 'dlg-actions' }, reject, approve)
  );
}

/**
 * One deliberate, un-bouncy emphasis on the uncertainty statement. Fired when
 * the signing panel first appears, and again at the moment the typed name arms
 * the two buttons. Under reduced motion the emphasised state is simply the
 * resting state — see .sign-note in the stylesheet — so nothing is lost.
 */
let signCue = null;
function cueSignNote({ persist = false } = {}) {
  if (!modal) return;
  const note = modal.dlg.querySelector('.sign-note');
  if (!note) return;
  clearTimeout(signCue);
  if (persist) {
    note.classList.add('is-cued');
    return;
  }
  if (reducedMotion()) return; // already permanently emphasised by the stylesheet
  note.classList.remove('is-cued');
  // Force a reflow so the class can be re-applied and re-run in the same frame.
  void note.offsetWidth;
  note.classList.add('is-cued');
  signCue = setTimeout(() => note.classList.remove('is-cued'), 1400);
}

function successBlock() {
  const d = modal.decided;
  const ok = d.status === 'approved';
  const blk = h('div', { class: `success${ok ? '' : ' no'}`, tabindex: '-1' });
  if (ok) {
    blk.append(
      h('h4', {}, `Approved by ${d.approvedBy}`),
      h(
        'p',
        { class: 'method' },
        `at ${localFull(d.decidedAt)}. Released a list of ${modal.shortlist.length} district committees to inform. ` +
          `This list is alphabetical and carries no order of preference.`
      ),
      shortlistTable(modal.shortlist)
    );
  } else {
    blk.append(
      h('h4', {}, `Rejected by ${d.approvedBy}`),
      h(
        'p',
        { class: 'method' },
        `at ${localFull(d.decidedAt)}. Nothing was released. The item stays in the record.`
      )
    );
  }
  return blk;
}

// ══════════════════════════════════════════════════════════════════════════
// shared fragments
// ══════════════════════════════════════════════════════════════════════════

function emptyState(glyph, title, bodyText, action) {
  const node = h(
    'div',
    { class: 'empty' },
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, glyph),
    h('h3', {}, title),
    h('p', {}, bodyText)
  );
  if (action)
    node.append(
      h('button', { class: 'btn btn-sm', type: 'button', onclick: action.onClick }, action.label)
    );
  return node;
}
function emptyStateOk(glyph, title, bodyText) {
  const n = emptyState(glyph, title, bodyText);
  n.classList.add('empty-ok');
  return n;
}
function skeletonRows(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    frag.append(
      h(
        'div',
        { class: 'skel-row' },
        h('span', { class: 'skel', style: 'width:60%' }),
        h('span', { class: 'skel', style: 'width:35%;height:9px' })
      )
    );
  }
  return frag;
}

// ══════════════════════════════════════════════════════════════════════════
// theme, tabs, shortcuts, boot
// ══════════════════════════════════════════════════════════════════════════

function applyTheme(mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  for (const b of $$('[data-theme-set]'))
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode));
  safeLocal('sz-theme', mode);
  // The sky belongs to the theme; MapLibre paints it and cannot see a CSS token.
  if (mapCtl && mapCtl.refreshAtmosphere) mapCtl.refreshAtmosphere();
}

// ── views ──────────────────────────────────────────────────────────────────
// Four rooms, real ARIA tabs, and the selected panel written to the URL hash
// so any view is linkable. Unknown hashes are left alone so the skip links
// (#region-rank, #region-checkpoint, #region-map) keep working as anchors.

const VIEWS = ['overview', 'decisions', 'settlement', 'activity'];
// Which room owns each skip-link anchor.
const ANCHOR_VIEW = {
  'region-rank': 'overview',
  'region-map': 'overview',
  'region-checkpoint': 'decisions',
  'region-evidence': 'settlement',
  'region-activity': 'activity',
  'region-sources': 'activity'
};

function setView(name, opts = {}) {
  if (!VIEWS.includes(name)) return;
  const changed = document.body.dataset.view !== name;
  document.body.dataset.view = name;

  for (const tab of $$('#viewnav [role="tab"]')) {
    const on = tab.dataset.view === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const v of VIEWS) {
    const panel = $(`#view-${v}`);
    if (!panel) continue;
    panel.classList.toggle('is-active', v === name);
    panel.hidden = v !== name;
  }
  if (opts.focusPanel) {
    const p = $(`#view-${name}`);
    if (p) p.focus();
  }

  const hash = `#v/${name}`;
  if (!opts.fromHash && location.hash !== hash) {
    try {
      history.replaceState(null, '', hash);
    } catch {
      location.hash = hash;
    }
  }
  // MapLibre measures its canvas on resize; a pane that was display:none has
  // no size until the frame after it is shown.
  if (changed && name === 'overview' && mapCtl) setTimeout(() => mapCtl.resize(), 60);
}

function viewFromHash() {
  const m = /^#v\/([a-z]+)$/.exec(location.hash || '');
  return m && VIEWS.includes(m[1]) ? m[1] : null;
}

function syncLayout() {
  if (mapCtl) setTimeout(() => mapCtl.resize(), 60);
  syncLegend();
}

// The legend must never eat the map. It stays folded to its summary until the
// operator asks for it - measured at 1600x1000 it covered about a quarter of the
// map, which is the one element on screen that has to carry the story. The ramp
// is one click away, and the same encoding is already readable in the rank list
// (silence hours, Gi* z-score, "no data reached us" chips), so folding it hides
// nothing. Once the operator sets it either way, userSet wins and we stop
// touching it.
function syncLegend() {
  const legend = $('#legend');
  const pane = $('#map-canvas');
  if (!legend || !pane) return;
  if (legend.dataset.userSet === '1') return;
  if (legend.open === false) return;
  legendProgrammatic = true;
  legend.open = false;
}

function renderLegend() {
  const ramp = $('#ramp');
  clear(ramp);
  SIL_BANDS.forEach((b) => {
    const i = h('i', { title: `${b.label} silent` });
    i.style.background = `var(--sil-${b.stop})`;
    ramp.append(i);
  });
  const rings = $('#legend-rings');
  clear(rings);
  for (const key of ['solo-anomaly', 'regional-outage', 'silent-cluster', 'cluster-edge', 'none']) {
    const a = ANOMALY[key];
    const dot = h('span', { class: 'mk-dot', 'aria-hidden': 'true' });
    dot.dataset.anom = key;
    rings.append(
      h('li', {}, h('span', { class: 'swwrap' }, dot), a.label === '—' ? a.short : a.label)
    );
  }
  renderRingLegend();
}

/**
 * The ring is the map's primary read, so it gets the first legend block. Each
 * swatch is the real component the map draws, not a picture of it, so the legend
 * cannot drift away from the encoding.
 */
function renderRingLegend() {
  const body = $('#legend .legend-body');
  if (!body || $('#legend-cadence')) return;
  const swatch = (kind) => {
    const wrap = h('span', { class: 'lg-ring', 'aria-hidden': 'true' });
    wrap.dataset.kind = kind;
    wrap.append(h('i', {}));
    return wrap;
  };
  const block = h(
    'div',
    { class: 'legend-block', id: 'legend-cadence' },
    h('span', { class: 'legend-title' }, 'Reporting cadence'),
    h(
      'ul',
      { class: 'legend-rings lg-cad' },
      h(
        'li',
        {},
        swatch('recent'),
        'a full ring — reports still arriving, one cycle per expected interval'
      ),
      h(
        'li',
        {},
        swatch('stopped'),
        'a broken arc with a notch — reports arrived, then stopped mid-cycle'
      ),
      h(
        'li',
        {},
        swatch('never'),
        'a dashed ghost — no report has ever arrived, so no cycle ever started'
      )
    ),
    h(
      'p',
      { class: 'legend-cap' },
      'Each ring runs at that settlement’s own fitted interval (1/λ), compressed for display. ' +
        'The dark spreading around a marker grows with how long nothing has arrived.'
    )
  );
  body.insertBefore(block, body.firstChild);
}

function bind() {
  el.btnRun.addEventListener('click', runPipeline);
  el.cbarAction.addEventListener('click', focusQueue);
  el.humanBandGo.addEventListener('click', focusQueue);

  for (const b of $$('[data-theme-set]'))
    b.addEventListener('click', () => applyTheme(b.dataset.themeSet));
  for (const b of $$('[data-filt]'))
    b.addEventListener('click', () => {
      S.filter = b.dataset.filt;
      syncFilterButtons();
      renderRank(true);
    });
  for (const b of $$('[data-act]'))
    b.addEventListener('click', () => {
      S.actFilter = b.dataset.act;
      for (const o of $$('[data-act]')) o.setAttribute('aria-pressed', String(o === b));
      renderActivity(true);
    });
  for (const b of $$('[data-basemap]'))
    b.addEventListener('click', () => mapCtl && mapCtl.setBasemap(b.dataset.basemap));
  $('#btn-reset-view').addEventListener('click', () => mapCtl && mapCtl.resetView());

  el.rankFilter.addEventListener('input', () => {
    S.query = el.rankFilter.value;
    renderRank(true);
  });

  for (const th of $$('.rank-table thead button')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (S.sort.key === key) S.sort.dir = S.sort.dir === 'asc' ? 'desc' : 'asc';
      else S.sort = { key, dir: key === 'rank' || key === 'name' ? 'asc' : 'desc' };
      for (const o of $$('.rank-table thead button')) {
        o.setAttribute(
          'aria-sort',
          o.dataset.sort === S.sort.key
            ? S.sort.dir === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'
        );
      }
      renderRank(true);
    });
  }

  for (const b of $$('[data-fail]')) {
    b.addEventListener('click', async () => {
      const kind = b.dataset.fail;
      b.disabled = true;
      const res = await fetchJson(`/api/demo/fail/${kind}`, { method: 'POST' }, 12000).catch(
        () => ({ ok: false, status: 0 })
      );
      b.disabled = false;
      if (!res.ok) toast(`Simulated failure "${kind}" could not be injected.`, 'critical');
      else
        logLocal(
          `Simulated failure injected: ${kind}. Everything it produces is tagged SIMULATED.`,
          { simulated: true, kind }
        );
      $('#demo-menu').open = false;
      pollState();
    });
  }

  // Real ARIA tab semantics: arrows move, Home/End jump, the panel follows.
  const tabs = $$('#viewnav [role="tab"]');
  for (const t of tabs) {
    t.addEventListener('click', () => setView(t.dataset.view));
    t.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(t);
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
        next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) {
        e.preventDefault();
        setView(next.dataset.view);
        next.focus();
      }
    });
  }

  // A linkable view: #v/decisions restores that panel on load and on Back.
  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v) setView(v, { fromHash: true });
  });

  // The skip links stay real anchors; they just open the room that owns them.
  for (const a of $$('a.skip')) {
    a.addEventListener('click', (e) => {
      const id = (a.getAttribute('href') || '').slice(1);
      const view = ANCHOR_VIEW[id];
      if (!view) return;
      e.preventDefault();
      setView(view);
      const target = document.getElementById(id);
      if (target) {
        target.setAttribute('tabindex', '-1');
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  window.addEventListener('resize', syncLayout);
  $('#legend').addEventListener('toggle', function () {
    if (legendProgrammatic) {
      legendProgrammatic = false;
      return;
    }
    this.dataset.userSet = '1';
  });

  document.addEventListener('keydown', (e) => {
    if (modal) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key >= '1' && e.key <= '4') {
      setView(VIEWS[Number(e.key) - 1]);
      return;
    }
    if (e.key === 'r') {
      if (mapCtl) mapCtl.resetView();
    } else if (e.key === '/') {
      e.preventDefault();
      setView('overview');
      el.rankFilter.focus();
    }
  });
}

function renderAll() {
  renderFinding();
  renderHumanBand();
  renderStages();
  renderPassKv();
  renderRank();
  renderCheckpoint();
  renderCheckpointBar();
  renderActivity();
  renderSources();
  if (S.selectedId) renderSettlementHead(rowById(S.selectedId), S.selectedId);
  if (mapCtl) {
    const pend = pendingSettlementIds();
    const sig = JSON.stringify(
      rows().map((r) => [
        r.settlementId,
        r.rank,
        r.silenceHours,
        r.population,
        r.anomalyType,
        r.coverageBasis
      ])
    );
    if (sig !== mapSig) {
      mapSig = sig;
      mapCtl.setData(rows(), S.adjacency || {});
    }
    mapCtl.setPending(pend);
    if (S.selectedId) mapCtl.select(S.selectedId, { fly: false });
    syncMapStaleness();
  }
}

/**
 * The map's fog is driven by how long it has been since the last COMPLETE
 * pipeline pass — the console's own silence, measured the same way a
 * settlement's is. Nothing about the ranking changes with it; only how clearly
 * the ground behind the ranking can be seen.
 */
function syncMapStaleness() {
  if (!mapCtl || !mapCtl.setStaleness) return;
  const last = S.state && S.state.stats && S.state.stats.lastRunAt;
  const t = last ? Date.parse(last) : NaN;
  // No completed pass yet, or the API itself is unreachable: that is the most
  // stale the console can be, and it says so rather than looking fresh.
  if (!Number.isFinite(t)) {
    mapCtl.setStaleness(S.state ? 6 : 0);
    return;
  }
  mapCtl.setStaleness(Math.max(0, (Date.now() - t) / 3600000));
}

function boot() {
  Object.assign(el, {
    apiBanner: $('#api-banner'),
    // finding
    finding: $('#finding'),
    findingB: $('#finding-b'),
    findingNote: $('#finding-note'),
    findingLive: $('#finding-live'),
    humanBandGlyph: $('#human-band .hb-glyph'),
    humanBand: $('#human-band'),
    humanBandText: $('#human-band-text'),
    humanBandGo: $('#human-band-go'),
    navBadge: $('#nav-badge'),
    tabSettlement: $('#tab-settlement'),
    // board
    btnRun: $('#btn-run'),
    rankRows: $('#rank-rows'),
    rankTable: $('#rank-table'),
    rankEmpty: $('#rank-empty'),
    rankCount: $('#rank-count'),
    rankFilter: $('#rank-filter'),
    boardFoot: $('#board-foot'),
    // settlement
    setName: $('#set-name'),
    setDistrict: $('#set-district'),
    setFacts: $('#set-facts'),
    evidenceBody: $('#evidence-body'),
    // decisions
    checkpointBody: $('#checkpoint-body'),
    cpLeadLine: $('#cp-lead-line'),
    viewDecisions: $('#view-decisions'),
    // activity
    activityList: $('#activity-list'),
    actCount: $('#act-count'),
    stageList: $('#stage-list'),
    railSub: $('#rail-sub'),
    railAnnounce: $('#rail-announce'),
    sourceChips: $('#source-chips'),
    sourceAgg: $('#source-agg'),
    passKv: $('#pass-kv'),
    // status bar
    statusbar: $('#statusbar'),
    sbTrack: $('#sb-track'),
    sbText: $('#sb-text'),
    sbSources: $('#sb-sources'),
    cbarText: $('#cbar-text'),
    cbarAction: $('#cbar-action'),
    toasts: $('#toasts'),
    modalRoot: $('#modal-root')
  });

  applyTheme(safeLocal('sz-theme') || 'auto');
  setView(viewFromHash() || 'overview');
  syncFilterButtons();
  renderLegend();
  bind();
  syncLegend();

  // Shell + skeletons paint before anything touches the network. The first
  // ~40 seconds after a cold boot genuinely has zero settlements, so these
  // loading states are the real screen, not a hypothetical one.
  renderFinding();
  renderHumanBand();
  renderStages();
  renderPassKv();
  renderRank();
  renderCheckpoint();
  renderCheckpointBar();
  renderActivity();
  renderSources();
  renderSettlementHead(null, null);
  renderEvidence();

  try {
    mapCtl = createMapController({
      regionEl: $('#region-map'),
      canvasEl: $('#map-canvas'),
      overlayEl: $('#map-markers'),
      statusEl: $('#map-status'),
      bannerEl: $('#map-banner'),
      tipEl: $('#map-tip'),
      onSelect: (id) => select(id),
      onHover: (id, on) => {
        const safe = window.CSS && CSS.escape ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
        const tr = $(`.rank-row[data-id="${safe}"]`, el.rankRows);
        if (!tr) return;
        tr.classList.toggle('is-hover', !!on);
        if (on) tr.scrollIntoView({ block: 'nearest' });
      },
      log: (msg) => logLocal(msg)
    });
  } catch (err) {
    logLocal(`The map could not be initialised: ${err.message}. Everything else still works.`);
    $('#map-status').textContent =
      'Map unavailable — the rank list, evidence and decisions all still work.';
  }

  // Corridor adjacency: static reference data, mirrored into web/ so the browser
  // can draw the exact graph Gi* runs on. Its absence costs the lines, nothing else.
  fetch('./data/corridor.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((adj) => {
      S.adjacency = adj;
      if (mapCtl) mapCtl.setAdjacency(adj);
    })
    .catch((err) =>
      logLocal(
        `Corridor adjacency could not be loaded (${err.message}). The map shows settlements without the corridor lines.`
      )
    );

  pollState().finally(loopPoll);
  // Relative timestamps have to keep ticking even when the payload does not.
  setInterval(() => {
    renderFinding();
    renderCheckpoint();
    renderSources();
    syncMapStaleness();
    if (!isRunning()) renderStages();
  }, 15000);
  // The stopwatch on the stage rail. One second, unconditionally, and it only
  // repaints while a pass is in flight — the seconds it shows are the server's
  // own `run.elapsedMs` carried forward, not a client-side count from the click.
  setInterval(() => {
    if (isRunning()) renderStages();
  }, 1000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
