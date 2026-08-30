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
  $, $$, h, clear, fmtHours, fmtZ, fmtNum, fmtInt, fmtCount, fmtLambda,
  relTime, clockTime, localFull, silStop, SIL_BANDS, anomalyOf, ANOMALY,
  INCIDENT_KINDS, statusOf, coverageChip, safeLocal, fetchJson
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
    return /^https?:$/i.test(new URL(String(u), document.baseURI).protocol) && /^https?:\/\//i.test(String(u).trim());
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
  running: false,
  runStartedAt: 0,
  showAllDecided: false,
  releases: new Map(),  // settlementId -> { approvedBy, decidedAt, shortlist }
  adjacency: null
};

const STAGES = [
  { id: 'ingest', label: 'Ingest' },
  { id: 'triage', label: 'Triage' },
  { id: 'dedup', label: 'Dedup' },
  { id: 'rank', label: 'Rank' },
  { id: 'checkpoint', label: 'Checkpoint' },
  { id: 'ready', label: 'Ready' }
];

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
  const node = h('div', { class: `toast ${kind}` },
    h('span', {}, message),
    h('button', { type: 'button', 'aria-label': 'Dismiss', onclick: () => node.remove() }, '✕'));
  box.append(node);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => node.remove(), ms);
}

// ── API ────────────────────────────────────────────────────────────────────

async function pollState() {
  const res = await fetchJson('/api/state', {}, 10000).catch((err) => ({ ok: false, status: 0, netError: err }));

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
  S.state = normalise(res.body);
  S.fetchedAt = Date.now();
  renderApiBanner(null);
  if (wasStale) logLocal('Reconnected to the Signal Zero API. Live state restored.');

  if (prev && prev.stats.lastRunAt !== S.state.stats.lastRunAt && S.state.stats.lastRunAt) {
    logLocal(`Pipeline pass completed: ${S.state.stats.reportCount} reports, ${S.state.stats.clusterCount} clusters, ${S.state.stats.durationMs}ms.`,
      { lastRunAt: S.state.stats.lastRunAt, durationMs: S.state.stats.durationMs });
  }
  renderAll();
}

function normalise(body) {
  const settlements = Array.isArray(body.settlements) ? body.settlements.filter(Boolean) : [];
  return {
    settlements,
    checkpoint: Array.isArray(body.checkpoint) ? body.checkpoint.filter(Boolean) : [],
    incidents: Array.isArray(body.incidents) ? body.incidents.filter(Boolean) : [],
    sources: Array.isArray(body.sources) ? body.sources.filter(Boolean) : [],
    stats: body.stats && typeof body.stats === 'object' ? body.stats : {}
  };
}

function loopPoll() {
  const delay = S.stale ? S.retryMs : (S.running ? 1200 : 5000);
  setTimeout(async () => {
    try { await pollState(); } catch (err) { S.stale = true; renderApiBanner(null); }
    loopPoll();
  }, delay);
}

// ── derived ────────────────────────────────────────────────────────────────

// Relative timestamps ("raised 4 min ago") must keep ticking, so the change
// signatures carry a one-minute bucket. Nothing re-renders faster than it changes.
const minuteBucket = () => Math.floor(Date.now() / 60000);

const rows = () => (S.state ? S.state.settlements : []);
const pendingItems = () => (S.state ? S.state.checkpoint.filter((i) => i.status === 'pending') : []);
const decidedItems = () => (S.state ? S.state.checkpoint.filter((i) => i.status !== 'pending') : []);
const pendingSettlementIds = () => new Set(pendingItems().map((i) => i.settlementId).filter(Boolean));
const rowById = (id) => rows().find((r) => r.settlementId === id) || null;

// ══════════════════════════════════════════════════════════════════════════
// Region A — command bar
// ══════════════════════════════════════════════════════════════════════════

function renderApiBanner(reason) {
  const b = el.apiBanner;
  document.body.classList.toggle('is-stale', S.stale);
  for (const r of $$('.region, .sources-strip')) r.setAttribute('aria-busy', String(S.stale));
  if (!S.stale) { b.hidden = true; clear(b); return; }
  clear(b);
  b.hidden = false;
  const seen = S.fetchedAt ? relTime(new Date(S.fetchedAt).toISOString()) : null;
  if (reason === 'malformed') {
    b.append(
      h('strong', {}, 'The API returned a response this console could not read.'),
      h('span', {}, seen ? ` Showing the last state received ${seen}.` : ' No usable state has arrived yet.'),
      h('details', {}, h('summary', {}, 'Show the first 400 characters'),
        h('pre', { class: 'raw' }, S.parseSample || '(empty body)')));
  } else {
    b.append(
      h('strong', {}, 'Cannot reach the Signal Zero API.'),
      h('span', {}, seen
        ? ` Showing the last state received ${seen}. Retrying in ${Math.round(S.retryMs / 1000)}s.`
        : ` No state has arrived yet. Retrying in ${Math.round(S.retryMs / 1000)}s.`));
  }
  b.append(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => pollState() }, 'Retry now'));
}

let lastAnnounced = '';
function renderRail() {
  const track = el.railTrack;
  const st = S.state ? S.state.stats : null;
  const hasRun = !!(st && st.lastRunAt);
  const failedStages = failedStagesInLastRun();

  let mode;
  if (S.running) mode = 'running';
  else if (hasRun) mode = 'done';
  else mode = 'pending';

  clear(track);
  STAGES.forEach((stage, i) => {
    let state = 'pending';
    if (mode === 'running') state = 'active';
    else if (mode === 'done') state = failedStages.has(stage.id) ? 'failed' : 'done';
    const seg = h('span', { class: 'rail-seg', 'data-state': state, title: stage.label },
      h('span', { 'aria-hidden': 'true' }, state === 'done' ? '✓' : state === 'failed' ? '▲' : '·'),
      stage.label);
    track.append(seg);
    if (i < STAGES.length - 1) track.append(h('span', { class: 'rail-conn' }));
  });

  let sub;
  if (mode === 'running') {
    const secs = Math.floor((Date.now() - S.runStartedAt) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    sub = `Running — per-stage detail not reported by the server · ${mm}:${ss}`;
  } else if (mode === 'done') {
    sub = `Last pass: ${st.durationMs ?? '—'}ms · ${relTime(st.lastRunAt) || 'just now'}` +
      (failedStages.size ? ` · ${failedStages.size} stage(s) degraded` : '');
  } else {
    sub = S.state ? 'No pipeline pass has completed yet.' : 'Waiting for first state…';
  }
  el.railSub.textContent = sub;
  if (sub !== lastAnnounced) { lastAnnounced = sub; el.railAnnounce.textContent = sub; }
}

// A stage is marked failed only if the server actually wrote an incident naming it
// inside the last run's own window. The rail never guesses.
function failedStagesInLastRun() {
  const out = new Set();
  const st = S.state && S.state.stats;
  if (!st || !st.lastRunAt) return out;
  const end = Date.parse(st.lastRunAt);
  const start = end - (Number(st.durationMs) || 0) - 2000;
  for (const inc of S.state.incidents) {
    if (inc.kind !== 'degraded-source') continue;
    const t = Date.parse(inc.at);
    if (!Number.isFinite(t) || t < start || t > end + 2000) continue;
    const stage = inc.detail && inc.detail.stage;
    if (stage && STAGES.some((s) => s.id === stage)) out.add(stage);
  }
  return out;
}

function renderStats() {
  const st = S.state ? S.state.stats : {};
  el.statReports.textContent = st.reportCount === undefined ? '—' : fmtCount(st.reportCount);
  el.statClusters.textContent = st.clusterCount === undefined ? '—' : fmtCount(st.clusterCount);
  el.statLastRun.textContent = st.lastRunAt ? (relTime(st.lastRunAt) || '—') : 'never';
  el.statLastRun.title = st.lastRunAt ? st.lastRunAt : 'No pipeline pass has completed yet.';

  const n = pendingItems().length;
  el.pendingPill.hidden = n === 0;
  el.pendingPillN.textContent = String(n);
  const badge = $('#tab-badge');
  if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
}

async function runPipeline() {
  if (S.running) return;
  S.running = true;
  S.runStartedAt = Date.now();
  el.btnRun.disabled = true;
  el.btnRun.setAttribute('aria-busy', 'true');
  logLocal('Pipeline run requested from the console.');
  renderRail();
  const tick = setInterval(renderRail, 1000);
  try {
    const res = await fetchJson('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 180000);
    if (res.status === 409) {
      toast('A pipeline pass is already running.', 'warn', 5000);
      logLocal('Run rejected: a pipeline pass was already in flight (HTTP 409).');
    } else if (!res.ok) {
      const msg = (res.body && res.body.error) || `HTTP ${res.status}`;
      toast(`Pipeline run failed: ${msg}`, 'critical', 10000);
      logLocal(`Pipeline run failed: ${msg}`, res.body || null);
    } else {
      const b = res.body || {};
      logLocal(`Pipeline pass finished: ${fmtCount(b.reportCount)} reports, ${fmtCount(b.clusterCount)} clusters in ${b.durationMs}ms.`, b);
    }
  } catch (err) {
    toast('Could not reach the server to start a pipeline pass.', 'critical', 10000);
    logLocal(`Pipeline run could not be started: ${err.message}`);
  } finally {
    clearInterval(tick);
    S.running = false;
    el.btnRun.disabled = false;
    el.btnRun.removeAttribute('aria-busy');
    renderRail();
    pollState();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Region B — silence rank
// ══════════════════════════════════════════════════════════════════════════

function visibleRows() {
  let list = rows().slice();
  if (S.filter === 'anom') list = list.filter((r) => r.anomalyType && r.anomalyType !== 'none');
  else if (S.filter === 'nodata') list = list.filter((r) => r.coverageBasis === 'cohort-cold-start');
  const q = S.query.trim().toLowerCase();
  if (q) list = list.filter((r) =>
    String(r.name || '').toLowerCase().includes(q) || String(r.district || '').toLowerCase().includes(q));

  const { key, dir } = S.sort;
  const sign = dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return sign * String(av ?? '').localeCompare(String(bv ?? ''), 'en');
    }
    const an = Number.isFinite(Number(av)) ? Number(av) : -Infinity;
    const bn = Number.isFinite(Number(bv)) ? Number(bv) : -Infinity;
    return sign * (an - bn);
  });
  return list;
}

let rankSig = '';
function renderRank(force) {
  const list = visibleRows();
  const all = rows();
  const pend = pendingSettlementIds();
  const sig = JSON.stringify([
    S.filter, S.query, S.sort, S.selectedId, all.length,
    list.map((r) => [r.settlementId, r.rank, r.silenceHours, r.giZScore, r.corroborationCount, r.anomalyType, r.coverageBasis, pend.has(r.settlementId)])
  ]);
  if (!force && sig === rankSig) return;
  rankSig = sig;

  el.rankCount.textContent = all.length ? `${list.length}/${all.length}` : '—';
  $('#f-all').textContent = String(all.length);
  $('#f-anom').textContent = String(all.filter((r) => r.anomalyType && r.anomalyType !== 'none').length);
  $('#f-nodata').textContent = String(all.filter((r) => r.coverageBasis === 'cohort-cold-start').length);

  const body = el.rankRows;
  clear(body);
  clear(el.rankEmpty);

  if (!S.state) { el.rankEmpty.append(skeletonRows(8)); el.rankTable.hidden = true; return; }
  if (!all.length) {
    el.rankTable.hidden = true;
    el.rankEmpty.append(emptyState('◌', 'No ranking yet',
      'Run the pipeline to score all 32 settlements in the Trishuli corridor.',
      { label: 'Run pipeline', onClick: runPipeline }));
    return;
  }
  if (!list.length) {
    el.rankTable.hidden = true;
    el.rankEmpty.append(emptyState('⌕', 'No settlements match',
      `${all.length} settlements are loaded. Clear the filter to see them.`,
      { label: 'Clear filter', onClick: () => { S.query = ''; S.filter = 'all'; el.rankFilter.value = ''; syncFilterButtons(); renderRank(true); } }));
    return;
  }
  el.rankTable.hidden = false;

  for (const r of list) {
    const stop = silStop(r.silenceHours);
    const anom = anomalyOf(r.anomalyType);
    const sig2 = Number(r.giZScore) > 1.96;

    const badges = h('div', { class: 'rank-badges' });
    if (r.anomalyType && r.anomalyType !== 'none') {
      badges.append(h('span', { class: `anom ${anom.cls}`, title: anom.label },
        h('span', { 'aria-hidden': 'true' }, anom.glyph), anom.short));
    }
    if (r.coverageBasis === 'cohort-cold-start') badges.append(coverageChip(r));
    if (pend.has(r.settlementId)) {
      badges.append(h('span', { class: 'pause-badge', title: 'A human decision is pending for this settlement' },
        h('span', { 'aria-hidden': 'true' }, '⏸'), ' decision pending'));
    }

    const silTd = h('td', { class: 'c-sil' }, fmtHours(r.silenceHours));
    silTd.style.borderLeftColor = `var(--sil-${stop})`;
    silTd.style.background = `var(--sil-tint-${stop})`;

    const tr = h('tr', {
      class: 'rank-row', tabindex: '0', role: 'button',
      'data-id': r.settlementId,
      'aria-selected': String(S.selectedId === r.settlementId),
      'aria-label': `${r.name}, ${r.district}. Rank ${r.rank}. ${fmtHours(r.silenceHours)} silent.`
    },
      h('td', { class: 'c-rank' }, fmtCount(r.rank)),
      h('td', { class: 'c-name' }, h('div', { class: 'rank-name' },
        h('b', {}, r.name || r.settlementId),
        h('span', {}, r.district || 'district not recorded'),
        badges)),
      silTd,
      h('td', { class: `c-gi${sig2 ? ' is-sig' : ''}` }, fmtZ(r.giZScore)),
      h('td', { class: 'c-corr' }, Number(r.corroborationCount) > 0 ? fmtCount(r.corroborationCount) : '—'));

    tr.addEventListener('click', () => select(r.settlementId));
    tr.addEventListener('keydown', onRankKey);
    tr.addEventListener('pointerenter', () => mapCtl && mapCtl.hover(r.settlementId, true));
    tr.addEventListener('pointerleave', () => mapCtl && mapCtl.hover(r.settlementId, false));
    body.append(tr);
  }
}

function onRankKey(ev) {
  const tr = ev.currentTarget;
  const all = $$('.rank-row', el.rankRows);
  const i = all.indexOf(tr);
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(tr.dataset.id); return; }
  let next = null;
  if (ev.key === 'ArrowDown') next = all[Math.min(all.length - 1, i + 1)];
  else if (ev.key === 'ArrowUp') next = all[Math.max(0, i - 1)];
  else if (ev.key === 'Home') next = all[0];
  else if (ev.key === 'End') next = all[all.length - 1];
  if (next) { ev.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
}

function syncFilterButtons() {
  for (const b of $$('[data-filt]')) b.setAttribute('aria-pressed', String(b.dataset.filt === S.filter));
}

// ══════════════════════════════════════════════════════════════════════════
// Selection + region D — evidence
// ══════════════════════════════════════════════════════════════════════════

async function select(id, opts = {}) {
  if (!id) return;
  S.selectedId = id;
  renderRank(true);
  if (mapCtl) mapCtl.select(id, { fly: opts.fly !== false });
  if (document.body.dataset.layout === 'tabs') setTab('evidence');
  if (document.body.dataset.layout === 'slide') el.evidenceRegion.hidden = false;

  const row = rowById(id);
  el.evidenceSubject.textContent = row ? `· ${row.name}, ${row.district}` : `· ${id}`;
  el.btnEvidenceClose.hidden = false;
  renderEvidenceBasis(row);

  S.detailLoading = true;
  S.detailError = null;
  S.detail = null;      // never render the previous settlement's evidence under a new name
  S.detailId = id;
  renderEvidence();

  const res = await fetchJson(`/api/settlement/${encodeURIComponent(id)}`, {}, 12000)
    .catch((err) => ({ ok: false, status: 0, netError: err }));
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
  S.selectedId = null; S.detail = null; S.detailId = null; S.detailError = null;
  el.evidenceSubject.textContent = '';
  el.btnEvidenceClose.hidden = true;
  clear(el.evidenceBasis);
  if (document.body.dataset.layout === 'slide') el.evidenceRegion.hidden = true;
  if (mapCtl) mapCtl.select(null, { fly: false });
  renderRank(true);
  renderEvidence();
}

function renderEvidenceBasis(row) {
  clear(el.evidenceBasis);
  if (row) el.evidenceBasis.append(coverageChip(row));
}

function renderEvidence() {
  const box = el.evidenceBody;
  clear(box);

  if (!S.selectedId) {
    box.append(emptyState('◇', 'Nothing selected',
      'Pick a settlement from the rank list or the map to see every number behind its score.'));
    return;
  }
  const row = rowById(S.selectedId);

  if (S.detailError && S.detailError.kind === '404') {
    box.append(h('div', { class: 'ev-grid' }, h('div', { class: 'ev-block ev-span' },
      h('h4', {}, 'No record'),
      h('p', { class: 'unknown' },
        h('strong', {}, `No record for "${S.detailError.id}".`),
        ' The ranking may have been rebuilt since this row was drawn.'),
      h('button', { class: 'btn btn-sm', type: 'button', style: 'margin-top:8px', onclick: () => pollState() }, 'Refresh state'))));
    return;
  }
  if (S.detailLoading && !S.detail) {
    box.append(skeletonRows(4));
    return;
  }
  if (S.detailError && S.detailError.kind === 'net') {
    box.append(h('div', { class: 'ev-grid' }, h('div', { class: 'ev-block ev-span' },
      h('p', { class: 'unknown' },
        h('strong', {}, 'Could not load the evidence for this settlement.'),
        ' The ranking row below is the last state the console received.'),
      row ? observedBlock(row) : null)));
    return;
  }

  const d = S.detail || {};
  const ranked = d.ranked || row;
  const sb = d.scoreBreakdown || null;
  const grid = h('div', { class: 'ev-grid' });

  grid.append(observedBlock(ranked, d));
  grid.append(mathBlock(ranked, sb));
  grid.append(unknownBlock(ranked, d));
  grid.append(reportsBlock(d));

  const release = S.releases.get(S.selectedId);
  if (release) grid.append(releaseBlock(release));

  if (Array.isArray(d.neighbors) && d.neighbors.length) {
    grid.append(h('div', { class: 'ev-block ev-span' },
      h('h4', {}, 'Corridor neighbours'),
      h('div', { class: 'nb-chips' }, d.neighbors.map((nid) => {
        const nr = rowById(nid);
        return h('button', { type: 'button', onclick: () => select(nid) },
          nr ? `${nr.name} · ${fmtHours(nr.silenceHours)}` : nid);
      }))));
  }

  box.append(grid);
}

function observedBlock(r, d) {
  if (!r) return h('div', { class: 'ev-block' }, h('h4', {}, 'What we observed'),
    h('p', { class: 'unknown' }, 'This settlement is not in the current ranking.'));
  const dl = h('dl', { class: 'kv' });
  const put = (k, v, na) => { dl.append(h('dt', {}, k), h('dd', { class: na ? 'na' : null }, v)); };
  put('Last report', r.lastReportAt ? (relTime(r.lastReportAt) || localFull(r.lastReportAt)) : 'Never', !r.lastReportAt);
  put('Silent for', fmtHours(r.silenceHours));
  put('Reports', fmtCount(r.reportCount));
  put('Corroboration', fmtCount(r.corroborationCount));
  put('Population', fmtInt(r.population));
  put('Hazard tier', fmtCount(r.hazardTier));
  put('Corridor neighbours', fmtCount(r.neighborCount ?? (d && Array.isArray(d.neighbors) ? d.neighbors.length : null)));
  put('Anomaly type', anomalyOf(r.anomalyType).short || 'none flagged');
  const blk = h('div', { class: 'ev-block' }, h('h4', {}, 'What we observed'), dl);
  if (r.lastReportAt) {
    dl.querySelectorAll('dd')[0].title = r.lastReportAt;
  } else {
    blk.append(h('p', { class: 'method' }, 'Never — no report has ever resolved here.'));
  }
  return blk;
}

function mathBlock(r, sb) {
  const blk = h('div', { class: 'ev-block' }, h('h4', {}, 'How the number was reached'));
  if (!r) { blk.append(h('p', { class: 'unknown' }, 'No scored row for this settlement.')); return blk; }
  const lambda = sb && sb.lambdaPerHour !== null && sb.lambdaPerHour !== undefined
    ? sb.lambdaPerHour : r.lambdaPerHour;
  const surv = sb ? sb.survivalProbability : null;
  const fit = sb?.fitBasis ?? r.fitBasis ?? null;
  const cohort = sb?.cohortKey ?? r.cohortKey ?? null;
  const gaps = sb?.cohortSampleGaps ?? r.cohortSampleGaps ?? null;

  const lines = [
    `λ  = 1 / expectedGapHours = ${fmtLambda(lambda)}`.padEnd(46) +
      `fitBasis: ${fit ?? 'not reported'}${cohort ? ` (${cohort}${gaps !== null ? `, ${gaps} gaps` : ''})` : ''}`,
    `P(gap ≥ ${fmtHours(r.silenceHours)}) = exp(−λ·t) = ${surv === null || surv === undefined ? 'not reported' : fmtNum(surv, 6)}`.padEnd(46) + 'survivalProbability',
    `surprisal      = −ln P = λ·t = ${fmtNum(r.surprisal, 4)}`.padEnd(46) + 'surprisalFormula',
    `Gi* z          = ${fmtZ(r.giZScore)}   (threshold ${fmtNum(sb?.giThreshold ?? 1.96, 2)})`.padEnd(46) +
      `ownZ ${fmtZ(r.ownZScore)} · neighbourZ ${fmtZ(r.neighborZScore)} · n=${fmtCount(r.neighborCount)}`
  ];
  blk.append(h('pre', { class: 'formula' }, lines.join('\n')));
  if (sb && sb.method) {
    blk.append(h('p', { class: 'method' }, h('b', {}, 'Method '), sb.method));
  } else {
    blk.append(h('p', { class: 'method' }, h('b', {}, 'Method '), 'not returned by the server for this row.'));
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
      `is a confirmation that anything happened there.`);
  } else if (r) {
    const n = (S.state && S.state.sources.length) || (d && Array.isArray(d.reports) ? new Set(d.reports.map((x) => x.sourceName)).size : 0);
    p.append(
      `Silence means no report has reached us since ${r.lastReportAt ? localFull(r.lastReportAt) : 'the last resolved report'}. ` +
      `It is not a confirmation that this place went quiet. Coverage is limited to the ${n || 'listed'} sources ` +
      `feeding this run; a gap in our sources looks identical to a gap on the ground.`);
  } else {
    p.append('Silence here means no report reached us. It is not a confirmation that this place is quiet.');
  }
  blk.append(p);
  return blk;
}

function reportsBlock(d) {
  const blk = h('div', { class: 'ev-block' }, h('h4', {}, 'Reports behind this'));
  const reports = Array.isArray(d.reports) ? d.reports : [];
  if (!reports.length) {
    blk.append(h('p', { class: 'unknown' },
      h('strong', {}, 'No report has ever resolved to this settlement. '),
      'There is nothing behind this row but the cohort baseline.'));
  } else {
    const list = h('div', { class: 'rep-list' });
    for (const rep of reports) {
      const tier = rep.triage && rep.triage.tier;
      const item = h('div', { class: `rep${tier === 3 ? ' t3' : ''}` },
        h('div', { class: 'rep-top' },
          h('span', {}, rep.sourceName || 'unnamed source'),
          h('span', { class: 'chip chip-reports' }, rep.sourceType || 'type not recorded'),
          h('span', {
            class: `tier${tier === 3 ? ' t3' : ''}`,
            title: tier === 3 ? 'Tier 3 — LLM fallback classification. Reaching this tier is itself a failure signal.' : `Triage tier ${tier ?? '—'}`
          }, `T${tier ?? '?'}`),
          h('span', {}, (rep.triage && rep.triage.category) || 'uncategorised'),
          h('span', { title: rep.publishedAt || '' }, relTime(rep.publishedAt) || 'no publish time')),
        // Only an absolute http(s) URL becomes a citation. A relative or
        // otherwise unusable one would resolve against our own origin and open a
        // second copy of the console instead of the article - a dead citation is
        // worse than plain text, so it renders as plain text.
        isCitableUrl(rep.url)
          ? h('a', { href: rep.url, target: '_blank', rel: 'noopener noreferrer' }, rep.title || rep.url)
          : h('span', {}, rep.title || 'untitled report'));
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
      dl.append(h('dt', {}, c.id || 'cluster'),
        h('dd', {}, `conf ${fmtNum(c.confidence, 2)} · diversity ${fmtCount(c.sourceTypeDiversity)} · ${members} member${members === 1 ? '' : 's'}`));
      if (Number(c.confidence) === 0.5 && members === 1) {
        dl.append(h('dt', {}, ''), h('dd', { class: 'na' }, 'Singleton — uncorroborated, not "confidently one event".'));
      }
    }
    blk.append(dl);
  }
  return blk;
}

function releaseBlock(rel) {
  const blk = h('div', { class: 'ev-block ev-span' },
    h('h4', {}, `Released to inform — approved by ${rel.approvedBy}`));
  blk.append(shortlistTable(rel.shortlist));
  return blk;
}

function shortlistTable(shortlist) {
  const list = Array.isArray(shortlist) ? shortlist : [];
  if (!list.length) {
    return h('p', { class: 'unknown' }, 'The server released an empty list. Nothing to show.');
  }
  const t = h('table', { class: 'shortlist' },
    h('caption', {}, 'ordering: alphabetical-by-district (non-preferential)'),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Committee'), h('th', { scope: 'col' }, 'District'),
      h('th', { scope: 'col' }, 'Settlements'), h('th', { scope: 'col' }, 'Population'))),
    h('tbody', {}, list.map((s) => h('tr', {},
      h('td', {}, s.name ?? s.committee ?? '—'),
      h('td', {}, s.district ?? '—'),
      h('td', {}, fmtCount(s.settlementsInDistrict)),
      h('td', {}, fmtInt(s.populationInDistrict))))));
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

  el.cpCount.textContent = String(pend.length);
  el.checkpointHead.classList.toggle('has-pending', pend.length > 0);

  const sig = JSON.stringify([!!S.state, S.showAllDecided, minuteBucket(),
    pend.map((i) => [i.id, i.kind, i.title, i.settlementId, i.createdAt]),
    done.map((i) => [i.id, i.status, i.approvedBy, i.decidedAt])]);
  if (!force && sig === cpSig) return;
  cpSig = sig;

  clear(box);
  if (!S.state) { box.append(skeletonRows(2)); return; }

  box.append(h('div', { class: 'cp-sub' }, `Waiting on a human — ${pend.length}`));
  if (!pend.length) {
    box.append(emptyStateOk('✓', 'No decisions pending',
      "Escalations appear here when a settlement's silence clears the escalation gate. Nothing becomes actionable until a named human signs for it."));
  } else {
    for (const item of pend.slice().sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))) {
      const amb = item.kind === 'ambiguous-match';
      box.append(h('article', { class: `cp-card${amb ? ' k-ambiguous' : ''}` },
        h('div', { class: 'cp-kind' },
          h('span', { 'aria-hidden': 'true' }, amb ? '◆ ' : '▲ '),
          amb ? 'AMBIGUOUS MATCH' : 'ESCALATION'),
        h('p', { class: 'cp-title' }, item.title || '(no title recorded)'),
        h('p', { class: 'cp-meta' },
          `${item.settlementId || '—'} · raised ${relTime(item.createdAt) || 'time not recorded'}`),
        h('button', {
          class: 'btn btn-block btn-warn cp-open', type: 'button', 'data-cp': item.id,
          onclick: () => openModal(item.id)
        }, 'Review & decide →')));
    }
  }

  box.append(h('div', { class: 'cp-sub' }, `Decided — ${done.length}`));
  if (!done.length) {
    box.append(h('p', { class: 'helper', style: 'padding:6px 12px' }, 'No decisions recorded yet'));
    return;
  }
  const ordered = done.slice().sort((a, b) => Date.parse(b.decidedAt || 0) - Date.parse(a.decidedAt || 0));
  const shown = S.showAllDecided ? ordered : ordered.slice(0, 5);
  for (const item of shown) {
    const ok = item.status === 'approved';
    box.append(h('button', {
      class: `cp-decided ${ok ? 'ok' : 'no'}`, type: 'button',
      onclick: () => openModal(item.id, true)
    },
      h('span', { class: 'who' },
        h('span', { 'aria-hidden': 'true' }, ok ? '✓ ' : '✕ '),
        `${ok ? 'Approved' : 'Rejected'} by ${item.approvedBy || 'name not recorded'}`),
      h('span', { class: 't' }, item.title || '(no title recorded)'),
      h('span', { class: 'when', title: item.decidedAt || '' }, relTime(item.decidedAt) || 'time not recorded')));
  }
  if (ordered.length > shown.length) {
    box.append(h('button', {
      class: 'btn btn-sm', type: 'button', style: 'margin:8px 12px',
      onclick: () => { S.showAllDecided = true; renderCheckpoint(true); }
    }, `Show all ${ordered.length}`));
  }
}

function renderCheckpointBar() {
  const n = pendingItems().length;
  el.cbar.classList.toggle('pending', n > 0);
  clear(el.cbarText);
  if (n > 0) {
    el.cbarText.append(
      h('strong', {}, `${n} decision${n === 1 ? '' : 's'} waiting on a named human.`),
      ' Nothing in Signal Zero becomes actionable until someone signs for it.');
    el.cbarAction.hidden = false;
  } else {
    el.cbarText.append('No decisions pending. Everything raised so far has been signed for.');
    el.cbarAction.hidden = true;
  }
}

function focusQueue() {
  el.checkpointRegion.scrollIntoView({ block: 'nearest' });
  if (document.body.dataset.layout === 'tabs') setTab('checkpoint');
  const first = $('.cp-open', el.checkpointBody);
  if (first) first.focus();
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
    if (actSig !== 'skel') { actSig = 'skel'; clear(list); list.append(skeletonRows(5)); }
    return;
  }

  let items = mergedFeed();
  if (S.actFilter === 'incidents') items = items.filter((i) => i._src === 'server' && i.kind !== 'heal');
  else if (S.actFilter === 'decisions') items = items.filter((i) => /approved by|rejected by/i.test(i.message || ''));
  else if (S.actFilter === 'pipeline') items = items.filter((i) => i._src === 'local' || i.kind === 'degraded-source');

  items = items.slice(0, 80);
  const sig = JSON.stringify([S.actFilter, items.map((i) => i.id || i.at + i.message)]);
  if (!force && sig === actSig) return;
  actSig = sig;
  clear(list);

  if (!items.length) {
    list.append(h('li', { style: 'display:block' }, emptyState('·', 'No activity yet',
      'Pipeline runs, degraded sources, LLM fallbacks and human decisions all land here.')));
    return;
  }

  for (const item of items) {
    const kind = item._src === 'local' ? 'local' : (item.kind || 'local');
    const meta = INCIDENT_KINDS[kind] || INCIDENT_KINDS.local;
    const li = h('li', { class: `k-${kind}` },
      h('span', { class: 't', title: item.at || '' }, clockTime(item.at)),
      h('span', { class: 'g', 'aria-hidden': 'true' }, meta.glyph),
      h('span', { class: 'm' },
        h('span', { class: 'lbl' }, meta.label),
        item.message || '(no message)',
        item.detail && item.detail.simulated
          ? h('span', { class: 'chip chip-sim', style: 'margin-left:6px' }, 'SIMULATED') : null));
    if (item.detail && Object.keys(item.detail).length) {
      const det = h('details', {}, h('summary', {}, 'detail'),
        h('pre', {}, JSON.stringify(item.detail, null, 2)));
      li.append(det);
    }
    list.append(li);
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
      srcSig = 'skel'; clear(box); clear(el.sourceAgg);
      for (let i = 0; i < 4; i++) box.append(h('span', { class: 'src skel', style: 'width:120px;height:20px' }));
    }
    return;
  }

  const list = S.state.sources;
  const sig = JSON.stringify([minuteBucket(),
    list.map((x) => [x.name, x.status, x.sourceType, x.lastFetchAt]), S.state.stats.reportCount]);
  if (sig === srcSig) return;
  srcSig = sig;
  clear(box);
  clear(el.sourceAgg);
  if (!list.length) {
    const anyReports = Number(S.state.stats.reportCount) > 0;
    box.append(h('span', { class: 'src s-degraded' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }, '▲'),
      anyReports ? 'Sources not reported by this run' : 'No sources registered yet — run the pipeline.'));
    return;
  }
  let live = 0, latest = null;
  for (const s of list) {
    const st = statusOf(s.status);
    if (s.status === 'live' || s.status === 'ok') live++;
    if (s.lastFetchAt && (!latest || Date.parse(s.lastFetchAt) > Date.parse(latest))) latest = s.lastFetchAt;
    box.append(h('span', {
      class: `src ${st.cls}`,
      title: s.lastFetchAt ? `last fetch ${s.lastFetchAt}` : 'no fetch recorded'
    },
      h('span', { class: 'dot', 'aria-hidden': 'true' }, st.glyph),
      `${s.name} · ${s.sourceType || 'type not recorded'}`,
      h('span', { class: 'vh' }, ` status ${s.status || 'unknown'}`)));
  }
  el.sourceAgg.textContent = `${live}/${list.length} live · last fetch ${latest ? (relTime(latest) || '—') : 'not recorded'}`;
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
  if (!item) { toast('That checkpoint item is no longer in the queue.', 'warn'); pollState(); return; }
  if (modal) { swapModal(item, readOnly); return; }

  const opener = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const dlg = h('div', {
    class: 'dialog', role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
    'aria-label': `Human Checkpoint. ${item.title || ''}`
  });
  scrim.append(dlg);
  el.modalRoot.append(scrim);

  for (const node of Array.from(document.body.children)) {
    if (node === el.modalRoot) continue;
    node.setAttribute('aria-hidden', 'true');
    try { node.inert = true; } catch { /* older engines */ }
  }

  modal = { scrim, dlg, item, readOnly, opener, submitting: false, decided: null, shortlist: null };
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
    try { node.inert = false; } catch { /* older engines */ }
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
  if (ev.key === 'Escape') { ev.preventDefault(); closeModal('escape'); return; }
  if (ev.key !== 'Tab') return;
  const f = focusables(modal.dlg);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

function focusables(root) {
  return $$('a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])', root)
    .filter((n) => n === document.activeElement || n.getClientRects().length > 0);
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
  const kicker = h('div', { class: 'dlg-kicker' },
    ro
      ? h('span', { class: `pill-decided${item.status === 'approved' ? '' : ' no'}` }, 'DECIDED')
      : h('span', {}, `HUMAN CHECKPOINT · ${idx >= 0 ? idx + 1 : 1} of ${pend.length} pending`),
    h('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: () => closeModal('close')
    }, ro ? 'Close' : 'Close without deciding'));

  const head = h('div', { class: 'dlg-head' }, kicker,
    h('h2', { class: 'dlg-title' }, item.title || '(no title recorded)'),
    h('p', { class: `dlg-kind${amb ? ' amb' : ''}` },
      h('b', {}, amb ? '◆ AMBIGUOUS MATCH' : '▲ ESCALATION'),
      ` · ${item.settlementId || 'no settlement resolved'} · raised ${relTime(item.createdAt) || 'time not recorded'}`));
  dlg.append(head);

  if (ro) {
    dlg.append(h('div', { class: 'ro-banner' },
      `Decided by ${item.approvedBy || 'name not recorded'} on ${localFull(item.decidedAt)}. This record cannot be changed.`));
  } else {
    dlg.append(h('div', { class: 'rule-bar' }, h('span', { 'aria-hidden': 'true' }, 'ⓘ'), RULE_BAR));
  }

  // ── body ──
  const body = h('div', { class: 'dlg-body' });
  const ev = item.evidence || {};
  const row = item.settlementId ? rowById(item.settlementId) : null;
  const src = { ...ev, ...(row || {}) };

  body.append(h('section', {}, h('h4', {}, 'What we observed'), observedKv(src, ev)));

  body.append(h('section', {}, h('h4', {}, 'How the number was reached'),
    (() => {
      const inner = mathBlock(row || evAsRow(ev), modal.breakdown || null);
      inner.classList.remove('ev-block');
      inner.querySelector('h4')?.remove();
      return inner;
    })()));

  body.append(h('section', {}, h('h4', {}, 'What we do not know'), unknownParagraph(item, src)));

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
      sec.append(h('p', { class: 'helper' }, 'Loading the reports the server holds for this settlement…'));
    } else {
      sec.append(h('p', { class: 'unknown' }, 'This item is not tied to a settlement, so there are no reports behind it.'));
    }
    body.append(sec);
  }

  body.append(h('details', {},
    h('summary', {}, 'Show the exact evidence the server holds'),
    h('pre', { class: 'raw' }, JSON.stringify(item, null, 2))));

  if (modal.decided) body.append(successBlock());
  dlg.append(body);

  // ── footer ──
  dlg.append(ro || modal.decided ? decidedFooter() : decisionFooter());

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
      .catch(() => { if (modal) modal.detailPending = false; });
  }
}

function evAsRow(ev) {
  return {
    name: ev.name, district: ev.district, silenceHours: ev.silenceHours,
    expectedGapHours: ev.expectedGapHours, surprisal: ev.surprisal, giZScore: ev.giZScore,
    ownZScore: ev.ownZScore, neighborZScore: ev.neighborZScore, neighborCount: ev.neighborCount,
    coverageBasis: ev.coverageBasis, cohortKey: ev.cohortKey, fitBasis: ev.fitBasis,
    lambdaPerHour: ev.lambdaPerHour, cohortSampleGaps: ev.cohortSampleGaps
  };
}

function observedKv(src, ev) {
  const dl = h('dl', { class: 'kv' });
  const put = (k, v, na) => dl.append(h('dt', {}, k), h('dd', { class: na ? 'na' : null }, v));
  if (src.name) put('Settlement', `${src.name}${src.district ? `, ${src.district}` : ''}`);
  if (src.settlementId || ev.settlementId) put('Settlement id', src.settlementId || ev.settlementId);
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
      `Merging two different places, or splitting one, both corrupt the ranking downstream.`);
  } else if (src.coverageBasis === 'cohort-cold-start') {
    p.append(h('strong', {}, 'No data reached us. '),
      `No report has ever resolved to ${src.name || 'this settlement'}. Its expected reporting rate is ` +
      `borrowed from cohort ${src.cohortKey || 'unknown'} (${src.fitBasis || 'unreported'} fit` +
      `${src.cohortSampleGaps !== undefined ? `, ${src.cohortSampleGaps} observed gaps` : ''}), not measured here. ` +
      `We do not know whether ${src.name || 'it'} is quiet, unreachable, or simply unreported. Nothing on this ` +
      `screen is a confirmation that anything happened there.`);
  } else {
    const n = (S.state && S.state.sources.length) || 0;
    p.append(
      `Silence means no report has reached us since ${src.lastReportAt ? localFull(src.lastReportAt) : 'the last resolved report'}. ` +
      `It is not a confirmation that this place went quiet. Coverage is limited to the ${n || 'listed'} sources ` +
      `feeding this run; a gap in our sources looks identical to a gap on the ground.`);
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
    wrap.append(h('p', { class: 'unknown' }, 'The server did not record the two candidates for this item.'));
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
  dl.append(h('dt', {}, 'Match probability'), h('dd', {}, fmtNum(ev.matchProbability ?? ev.probability ?? ev.p, 2)));
  dl.append(h('dt', {}, 'Undecidable band'),
    h('dd', {}, lo === undefined && hi === undefined ? 'not recorded' : `${fmtNum(lo, 2)} … ${fmtNum(hi, 2)}`));
  wrap.append(dl);
  if (ev.note) wrap.append(h('p', { class: 'method' }, ev.note));
  if (ev.reason) wrap.append(h('p', { class: 'method' }, ev.reason));
  return wrap;
}

function decidedFooter() {
  return h('div', { class: 'dlg-foot' },
    h('div', { class: 'dlg-actions' },
      pendingItems().length && modal.decided
        ? h('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: () => {
              const next = pendingItems()[0];
              if (next) swapModal(next, false); else closeModal('close');
            }
          }, 'Next pending item →')
        : null,
      h('button', { class: 'btn', type: 'button', onclick: () => closeModal('close') }, 'Close')));
}

function decisionFooter() {
  const input = h('input', {
    type: 'text', id: 'approver', autocomplete: 'name', spellcheck: 'false',
    placeholder: 'e.g. R. Gurung, District Duty Officer', 'aria-describedby': 'approver-help'
  });
  const help = h('p', { class: 'helper', id: 'approver-help' }, HELPER_DEFAULT);
  const announce = h('p', { class: 'vh', 'aria-live': 'polite' });

  const reject = h('button', {
    class: 'btn btn-reject', type: 'button', 'aria-disabled': 'true'
  }, h('span', { 'aria-hidden': 'true' }, '✕'), 'Reject — not actionable');
  const approve = h('button', {
    class: 'btn btn-approve', type: 'button', 'aria-disabled': 'true'
  }, h('span', { 'aria-hidden': 'true' }, '✓'), 'Approve — release shortlist');

  let wasEnabled = false;
  const sync = () => {
    const on = input.value.trim().length > 0;
    for (const b of [reject, approve]) b.setAttribute('aria-disabled', String(!on));
    if (on && !wasEnabled) { announce.textContent = 'Approve and reject are now available.'; wasEnabled = true; }
    if (!on) wasEnabled = false;
  };
  input.addEventListener('input', sync);
  // Enter must never be a path to an irreversible decision.
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); reject.focus(); } });

  const needName = () => {
    help.classList.add('err');
    help.textContent = 'Enter your name to approve or reject.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };

  const submit = async (action, btn) => {
    if (btn.getAttribute('aria-disabled') === 'true') { needName(); return; }
    if (modal.submitting) return;
    modal.submitting = true;
    const name = input.value.trim();
    const label = btn.textContent;
    btn.textContent = 'Recording…';
    for (const b of [reject, approve]) b.setAttribute('aria-disabled', 'true');
    input.setAttribute('readonly', 'true');

    let res;
    try {
      res = await fetchJson(`/api/checkpoint/${encodeURIComponent(modal.item.id)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedBy: name })
      }, 20000);
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
      help.append(h('span', {}, 'Could not reach the server. '),
        h('strong', {}, 'No decision was recorded.'),
        h('span', {}, ' Check the connection and try again.'));
      const retry = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => submit(action, btn) }, 'Retry');
      help.append(' ', retry);
      logLocal(`Checkpoint ${modal.item.id}: ${action} could not be sent. No decision was recorded.`);
      return;
    }
    if (res.status === 400 && res.body && res.body.code === 'APPROVER_REQUIRED') {
      help.classList.add('err');
      help.textContent = res.body.error ||
        'A named human approver is required. Nothing in Signal Zero becomes actionable anonymously.';
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
      const b = res.body || {};
      modal.dlg.querySelector('.dlg-body').prepend(h('div', { class: 'conflict' },
        `This item was already ${b.status || 'decided'}${b.approvedBy ? ` by ${b.approvedBy}` : ''}. Refreshing the queue.`));
      for (const bt of [reject, approve]) { bt.setAttribute('aria-disabled', 'true'); bt.disabled = true; }
      await pollState();
      const next = pendingItems()[0];
      if (next) swapModal(next, false);
      return;
    }
    if (!res.ok || !res.body || !res.body.ok) {
      help.classList.add('err');
      help.textContent = (res.body && res.body.error) || `The server rejected the decision (HTTP ${res.status}). No decision was recorded.`;
      return;
    }

    const item = res.body.item || {};
    modal.decided = { status: item.status, approvedBy: item.approvedBy, decidedAt: item.decidedAt };
    modal.shortlist = Array.isArray(res.body.shortlist) ? res.body.shortlist : [];
    modal.item = { ...modal.item, ...item };
    logLocal(`Checkpoint ${modal.item.id} ${item.status} by ${item.approvedBy}.`, { checkpointId: modal.item.id, status: item.status });
    if (item.status === 'approved' && modal.item.settlementId) {
      S.releases.set(modal.item.settlementId, {
        approvedBy: item.approvedBy, decidedAt: item.decidedAt, shortlist: modal.shortlist
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

  return h('div', { class: 'dlg-foot' },
    h('label', { for: 'approver' }, 'Your name (required, recorded permanently)'),
    input, help, announce,
    h('div', { class: 'dlg-actions' }, reject, approve));
}

function successBlock() {
  const d = modal.decided;
  const ok = d.status === 'approved';
  const blk = h('div', { class: `success${ok ? '' : ' no'}`, tabindex: '-1' });
  if (ok) {
    blk.append(h('h4', {}, `Approved by ${d.approvedBy}`),
      h('p', { class: 'method' },
        `at ${localFull(d.decidedAt)}. Released a list of ${modal.shortlist.length} district committees to inform. ` +
        `This list is alphabetical and carries no order of preference.`),
      shortlistTable(modal.shortlist));
  } else {
    blk.append(h('h4', {}, `Rejected by ${d.approvedBy}`),
      h('p', { class: 'method' },
        `at ${localFull(d.decidedAt)}. Nothing was released. The item stays in the record.`));
  }
  return blk;
}

// ══════════════════════════════════════════════════════════════════════════
// shared fragments
// ══════════════════════════════════════════════════════════════════════════

function emptyState(glyph, title, bodyText, action) {
  const node = h('div', { class: 'empty' },
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, glyph),
    h('h3', {}, title),
    h('p', {}, bodyText));
  if (action) node.append(h('button', { class: 'btn btn-sm', type: 'button', onclick: action.onClick }, action.label));
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
    frag.append(h('div', { class: 'skel-row' },
      h('span', { class: 'skel', style: 'width:60%' }),
      h('span', { class: 'skel', style: 'width:35%;height:9px' })));
  }
  return frag;
}

// ══════════════════════════════════════════════════════════════════════════
// theme, tabs, shortcuts, boot
// ══════════════════════════════════════════════════════════════════════════

function applyTheme(mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  for (const b of $$('[data-theme-set]')) b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode));
  safeLocal('sz-theme', mode);
}

function setTab(name) {
  document.body.dataset.tab = name;
  for (const b of $$('#tabbar [role="tab"]')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function syncLayout() {
  const w = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0) || 1440;
  const layout = w <= 1023 ? 'tabs' : (w <= 1279 ? 'slide' : 'wide');
  const prev = document.body.dataset.layout;
  document.body.dataset.layout = layout;
  el.tabbar.hidden = layout !== 'tabs';
  if (layout === 'slide') el.evidenceRegion.hidden = !S.selectedId;
  else el.evidenceRegion.hidden = false;
  if (layout !== prev && mapCtl) setTimeout(() => mapCtl.resize(), 60);
  syncLegend();
}

// The legend must never eat the map. On a short pane it folds to its summary;
// the operator can always open it, and the ramp stays one click away.
function syncLegend() {
  const legend = $('#legend');
  const pane = $('#map-canvas');
  if (!legend || !pane) return;
  if (legend.dataset.userSet === '1') return;
  const r = pane.getBoundingClientRect();
  const want = document.body.dataset.layout !== 'tabs' && r.height >= 420 && r.width >= 620;
  if (legend.open === want) return;
  legendProgrammatic = true;
  legend.open = want;
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
    rings.append(h('li', {}, h('span', { class: 'swwrap' }, dot), a.label === '—' ? a.short : a.label));
  }
}

function bind() {
  el.btnRun.addEventListener('click', runPipeline);
  el.pendingPill.addEventListener('click', focusQueue);
  el.cbarAction.addEventListener('click', focusQueue);
  el.btnEvidenceClose.addEventListener('click', clearSelection);

  for (const b of $$('[data-theme-set]')) b.addEventListener('click', () => applyTheme(b.dataset.themeSet));
  for (const b of $$('[data-filt]')) b.addEventListener('click', () => { S.filter = b.dataset.filt; syncFilterButtons(); renderRank(true); });
  for (const b of $$('[data-act]')) b.addEventListener('click', () => {
    S.actFilter = b.dataset.act;
    for (const o of $$('[data-act]')) o.setAttribute('aria-pressed', String(o === b));
    renderActivity(true);
  });
  for (const b of $$('[data-basemap]')) b.addEventListener('click', () => mapCtl && mapCtl.setBasemap(b.dataset.basemap));
  $('#btn-reset-view').addEventListener('click', () => mapCtl && mapCtl.resetView());

  el.rankFilter.addEventListener('input', () => { S.query = el.rankFilter.value; renderRank(true); });

  for (const th of $$('.rank-table thead button')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (S.sort.key === key) S.sort.dir = S.sort.dir === 'asc' ? 'desc' : 'asc';
      else S.sort = { key, dir: key === 'rank' || key === 'name' ? 'asc' : 'desc' };
      for (const o of $$('.rank-table thead button')) {
        o.setAttribute('aria-sort', o.dataset.sort === S.sort.key ? (S.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      }
      renderRank(true);
    });
  }

  for (const b of $$('[data-fail]')) {
    b.addEventListener('click', async () => {
      const kind = b.dataset.fail;
      b.disabled = true;
      const res = await fetchJson(`/api/demo/fail/${kind}`, { method: 'POST' }, 12000).catch(() => ({ ok: false, status: 0 }));
      b.disabled = false;
      if (!res.ok) toast(`Simulated failure "${kind}" could not be injected.`, 'critical');
      else logLocal(`Simulated failure injected: ${kind}. Everything it produces is tagged SIMULATED.`, { simulated: true, kind });
      $('#demo-menu').open = false;
      pollState();
    });
  }

  for (const t of $$('#tabbar [role="tab"]')) {
    t.addEventListener('click', () => setTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      const tabs = $$('#tabbar [role="tab"]');
      const i = tabs.indexOf(t);
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      if (e.key === 'Home') next = tabs[0];
      if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); setTab(next.dataset.tab); next.focus(); }
    });
  }

  window.addEventListener('resize', syncLayout);
  $('#legend').addEventListener('toggle', function () {
    if (legendProgrammatic) { legendProgrammatic = false; return; }
    this.dataset.userSet = '1';
  });

  document.addEventListener('keydown', (e) => {
    if (modal) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'r') { if (mapCtl) mapCtl.resetView(); }
    else if (e.key === '/') { e.preventDefault(); el.rankFilter.focus(); }
  });
}

function renderAll() {
  renderRail();
  renderStats();
  renderRank();
  renderCheckpoint();
  renderCheckpointBar();
  renderActivity();
  renderSources();
  if (S.selectedId) renderEvidenceBasis(rowById(S.selectedId));
  if (mapCtl) {
    const pend = pendingSettlementIds();
    const sig = JSON.stringify(rows().map((r) =>
      [r.settlementId, r.rank, r.silenceHours, r.population, r.anomalyType, r.coverageBasis]));
    if (sig !== mapSig) { mapSig = sig; mapCtl.setData(rows(), S.adjacency || {}); }
    mapCtl.setPending(pend);
    if (S.selectedId) mapCtl.select(S.selectedId, { fly: false });
  }
}

function boot() {
  Object.assign(el, {
    apiBanner: $('#api-banner'), railTrack: $('#rail-track'), railSub: $('#rail-sub'),
    railAnnounce: $('#rail-announce'), statReports: $('#stat-reports'), statClusters: $('#stat-clusters'),
    statLastRun: $('#stat-lastrun'), pendingPill: $('#pending-pill'), pendingPillN: $('#pending-pill-n'),
    btnRun: $('#btn-run'), rankRows: $('#rank-rows'), rankTable: $('#rank-table'), rankEmpty: $('#rank-empty'),
    rankCount: $('#rank-count'), rankFilter: $('#rank-filter'),
    evidenceBody: $('#evidence-body'), evidenceSubject: $('#evidence-subject'), evidenceBasis: $('#evidence-basis'),
    evidenceRegion: $('#region-evidence'), btnEvidenceClose: $('#btn-evidence-close'),
    checkpointBody: $('#checkpoint-body'), checkpointHead: $('#checkpoint-head'),
    checkpointRegion: $('#region-checkpoint'), cpCount: $('#cp-count'),
    activityList: $('#activity-list'), sourceChips: $('#source-chips'), sourceAgg: $('#source-agg'),
    cbar: $('#checkpoint-bar'), cbarText: $('#cbar-text'), cbarAction: $('#cbar-action'),
    toasts: $('#toasts'), modalRoot: $('#modal-root'), tabbar: $('#tabbar')
  });

  applyTheme(safeLocal('sz-theme') || 'auto');
  syncLayout();
  syncFilterButtons();
  renderLegend();
  bind();
  syncLegend();

  // Shell + skeletons paint before anything touches the network.
  renderRail(); renderStats(); renderRank(); renderCheckpoint();
  renderCheckpointBar(); renderActivity(); renderSources(); renderEvidence();

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
    $('#map-status').textContent = 'Map unavailable — the rank list, evidence and decisions all still work.';
  }

  // Corridor adjacency: static reference data, mirrored into web/ so the browser
  // can draw the exact graph Gi* runs on. Its absence costs the lines, nothing else.
  fetch('./data/corridor.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((adj) => { S.adjacency = adj; if (mapCtl) mapCtl.setAdjacency(adj); })
    .catch((err) => logLocal(`Corridor adjacency could not be loaded (${err.message}). The map shows settlements without the corridor lines.`));

  pollState().finally(loopPoll);
  setInterval(() => { renderStats(); renderCheckpoint(); renderSources(); if (!S.running) renderRail(); }, 15000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
