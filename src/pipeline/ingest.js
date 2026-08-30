// Signal Zero - stage 1: INGEST.
//
// Produces Report[] for the rest of the pipeline. Two modes:
//
//   LIVE  (config.USE_LIVE_SCRAPE === true, i.e. BRIGHTDATA_API_TOKEN is set)
//         Talks straight to the Bright Data REST API over HTTPS - no MCP process,
//         no browser, no SDK. POST https://api.brightdata.com/request with
//         { zone, url, format: "raw" } returns the unlocked page body (or, for a
//         SERP zone URL carrying &brd_json=1, a JSON search payload).
//
//   SEED  (default) Reads the offline corpus at src/data/seed-reports.json.
//         Timestamps are re-anchored to "now" so the silence maths stays
//         meaningful whenever the demo is run.
//
// Contract: this stage does NOT resolve settlementId. Per the shared data
// contract that is triage/dedup's job, so every Report leaves here with
// settlementId: null, triage: null, clusterId: null. What ingest DOES guarantee
// is that any settlement name or alias appears verbatim in title/text, so the
// downstream resolver has something to match on.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import config from '../config.js';
import { store, addIncident } from '../store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEED_PATH = path.join(DATA_DIR, 'seed-reports.json');
const GAZETTEER_PATH = path.join(DATA_DIR, 'gazetteer.json');

// ---------------------------------------------------------------------------
// Mode flag (read by the UI via /api/state -> stats.ingestMode).
// Exported as `let` on purpose: ESM named imports are live bindings, so
// `import { LAST_INGEST_MODE } from './ingest.js'` sees the updated value after
// a run. `const` could never change, which would make the flag useless.
// ---------------------------------------------------------------------------
export let LAST_INGEST_MODE = 'seed'; // 'live' | 'seed'

export function getLastIngestMode() {
  return LAST_INGEST_MODE;
}

// ---------------------------------------------------------------------------
// Bright Data configuration
// ---------------------------------------------------------------------------
const BRIGHTDATA_ENDPOINT = 'https://api.brightdata.com/request';

// Zone names are deployment-specific. Defaults match the zone names Bright Data
// creates for a fresh account; override in .env if yours are named differently.
const UNLOCKER_ZONE = (process.env.BRIGHTDATA_UNLOCKER_ZONE || 'web_unlocker1').trim();
const SERP_ZONE = (process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1').trim();

const FETCH_TIMEOUT_MS = Number.parseInt(process.env.INGEST_TIMEOUT_MS || '20000', 10);
const RETRY_DELAYS_MS = [500, 1500]; // => 3 attempts total (initial + 2 retries)
const MAX_ARTICLES_PER_CONNECTOR = 6;
const MAX_TEXT_CHARS = 1800;

// 'shift' (default) re-anchors seed timestamps onto the current clock.
// 'absolute' keeps the literal ISO strings in seed-reports.json.
const SEED_TIME_MODE = (process.env.SIGNAL_ZERO_SEED_TIME || 'shift').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Live connector plan.
//
// `kind`:
//   'serp'    -> a search-engine results page fetched through the SERP zone with
//                &brd_json=1, parsed as JSON.
//   'listing' -> an index/section page fetched through the unlocker zone; we pull
//                candidate article links out of it, then fetch each article.
// ---------------------------------------------------------------------------
const CONNECTORS = [
  {
    name: 'Bright Data SERP - Nepali news',
    sourceType: 'news',
    kind: 'serp',
    targets: [
      'https://www.google.com/search?q=Trishuli+GLOF+flood+Nuwakot+Rasuwa+Dhading&tbm=nws&num=20&hl=en&brd_json=1',
      'https://www.google.com/search?q=%22glacial+lake+outburst%22+Trishuli+Nepal+August+2026&num=20&hl=en&brd_json=1'
    ]
  },
  {
    name: 'Bright Data SERP - settlement mentions',
    sourceType: 'news',
    kind: 'serp',
    targets: [
      'https://www.google.com/search?q=Betrawati+OR+Syabrubesi+OR+Dhunche+OR+Galchhi+flood+bridge&tbm=nws&num=20&hl=en&brd_json=1'
    ]
  },
  {
    // Official / humanitarian reporting. These portals (ReliefWeb, BIPAD,
    // DHM) render their index pages client-side, so scraping the listing HTML
    // returns navigation chrome only. Reaching them through the SERP zone with
    // site: filters is both more reliable and cheaper.
    name: 'Bright Data SERP - official portals',
    sourceType: 'official',
    kind: 'serp',
    targets: [
      'https://www.google.com/search?q=Trishuli+OR+Rasuwa+flood+site%3Areliefweb.int+OR+site%3Abipadportal.gov.np+OR+site%3Ahydrology.gov.np+OR+site%3Aun.org.np&num=20&hl=en&brd_json=1'
    ]
  },
  {
    name: 'Bright Data SERP - social chatter',
    sourceType: 'social',
    kind: 'serp',
    targets: [
      'https://www.google.com/search?q=Trishuli+Rasuwa+Nuwakot+flood+site%3Ax.com+OR+site%3Areddit.com&num=20&hl=en&brd_json=1'
    ]
  },
  {
    // The one connector that exercises the Web Unlocker + HTML extractor path:
    // fetch a server-rendered section index, pull article links, fetch each.
    name: 'Kathmandu Post - National',
    sourceType: 'news',
    kind: 'listing',
    targets: ['https://kathmandupost.com/national'],
    linkPattern: /kathmandupost\.com\/[a-z-]+\/20\d\d\/\d\d\/\d\d\//i
  }
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reportId(url) {
  return 'rpt-' + crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 12);
}

function isoOrNull(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const RELATIVE_UNITS_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 3600 * 1000,
  day: 86400 * 1000,
  week: 7 * 86400 * 1000,
  month: 30 * 86400 * 1000,
  year: 365 * 86400 * 1000
};

/**
 * Google SERP results carry relative dates ("3 days ago", "5 hours ago") rather
 * than timestamps. The whole ranking model is built on time-between-events, so a
 * report whose publishedAt silently collapses to "now" is worse than useless -
 * it makes a stale settlement look freshly covered. Parse them properly.
 */
function parseLooseDate(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();

  const rel = /^(?:about\s+)?(\d+)\s*(second|sec|minute|min|hour|hr|day|week|month|year)s?\s+ago$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit =
      { sec: 'second', min: 'minute', hr: 'hour' }[rel[2]] || rel[2];
    const ms = RELATIVE_UNITS_MS[unit];
    if (ms) return new Date(Date.now() - n * ms).toISOString();
  }
  if (s === 'yesterday') return new Date(Date.now() - RELATIVE_UNITS_MS.day).toISOString();
  if (s === 'today' || s === 'just now') return new Date().toISOString();

  return isoOrNull(value);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Record connector health for /api/state -> sources[]. */
function markSource(name, sourceType, status) {
  store.sources[name] = {
    name,
    sourceType,
    status,
    lastFetchAt: new Date().toISOString()
  };
}

/**
 * Run `fn` with two retries and linear-ish backoff.
 * Throws the last error if all three attempts fail.
 */
async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
  }
  const err = new Error(`${label}: ${lastErr && lastErr.message ? lastErr.message : 'failed'}`);
  err.cause = lastErr;
  err.attempts = RETRY_DELAYS_MS.length + 1;
  throw err;
}

// ---------------------------------------------------------------------------
// Bright Data transport
// ---------------------------------------------------------------------------

/**
 * Fetch one URL through Bright Data's /request endpoint.
 * Returns the raw response body as a string.
 */
async function brightDataRequest(targetUrl, { zone = UNLOCKER_ZONE } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(BRIGHTDATA_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.BRIGHTDATA_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ zone, url: targetUrl, format: 'raw' })
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`brightdata ${res.status} ${res.statusText} :: ${body.slice(0, 200)}`);
    }
    if (!body || body.length < 40) {
      throw new Error(`brightdata returned an empty body for ${targetUrl}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML extraction - deliberately small and forgiving. Every helper returns a
// usable value on garbage input rather than throwing, because a half-parsed
// page is still worth more than a dropped source.
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#39;': "'", rsquo: '’', lsquo: '‘',
  ldquo: '"', rdquo: '"', ndash: '–', mdash: '—', hellip: '…'
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : m));
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html, ...patterns) {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1] && m[1].trim()) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  }
  return '';
}

function extractTitle(html) {
  return firstMatch(
    html,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<h1[^>]*>([\s\S]{3,220}?)<\/h1>/i,
    /<title[^>]*>([\s\S]{3,220}?)<\/title>/i
  ).replace(/\s*[|–-]\s*[^|–-]{0,40}$/, '').trim();
}

function extractPublishedAt(html) {
  const raw = firstMatch(
    html,
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<meta[^>]+name=["'](?:pubdate|publish-date|date)["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i
  );
  return parseLooseDate(raw);
}

function extractBodyText(html) {
  const description = firstMatch(
    html,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
  );

  // Prefer the article/main container when the page has one.
  const scoped =
    /<article[\s\S]*?<\/article>/i.exec(html) ||
    /<main[\s\S]*?<\/main>/i.exec(html) ||
    null;
  const region = scoped ? scoped[0] : html;

  const paragraphs = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(region)) && paragraphs.length < 12) {
    const t = stripTags(m[1]);
    if (t.length >= 45) paragraphs.push(t);
  }

  let text = paragraphs.join(' ');
  if (text.length < 120) text = [description, text].filter(Boolean).join(' ');
  if (text.length < 120) text = stripTags(region).slice(0, MAX_TEXT_CHARS);
  return text.slice(0, MAX_TEXT_CHARS).trim();
}

function extractLinks(html, baseUrl, linkPattern) {
  const out = new Map();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1];
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (linkPattern && !linkPattern.test(abs)) continue;
    const label = stripTags(m[2]);
    if (label.length < 18) continue;
    if (!out.has(abs)) out.set(abs, label);
  }
  return [...out.entries()].map(([url, label]) => ({ url, label }));
}

// ---------------------------------------------------------------------------
// Relevance filter. Keeps live mode from importing unrelated national news.
// ---------------------------------------------------------------------------

const EVENT_KEYWORDS = [
  'trishuli', 'glof', 'glacial lake', 'outburst', 'flood', 'inundat', 'bagmati province',
  'nuwakot', 'rasuwa', 'dhading', 'landslide', 'swept away', 'washed away', 'displaced'
];

let placeNeedlesCache = null;
function placeNeedles() {
  if (placeNeedlesCache) return placeNeedlesCache;
  const gaz = readJson(GAZETTEER_PATH, []);
  const set = new Set();
  for (const s of gaz) {
    if (s && s.name) set.add(String(s.name).toLowerCase());
    for (const a of s && Array.isArray(s.aliases) ? s.aliases : []) set.add(String(a).toLowerCase());
  }
  placeNeedlesCache = [...set];
  return placeNeedlesCache;
}

function isRelevant(title, text) {
  const hay = `${title} ${text}`.toLowerCase();
  if (hay.length < 60) return false;
  const hitsEvent = EVENT_KEYWORDS.some((k) => hay.includes(k));
  const hitsPlace = placeNeedles().some((k) => hay.includes(k));
  return hitsEvent || hitsPlace;
}

/**
 * Relevance test for an index-page link, where all we have is anchor text plus a
 * URL slug. No minimum-length gate here - headlines are short by design.
 */
function isRelevantLink(label, url) {
  const hay = `${label} ${url}`.toLowerCase();
  return EVENT_KEYWORDS.some((k) => hay.includes(k)) || placeNeedles().some((k) => hay.includes(k));
}

function publisherName(url, fallback) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const label = host.split('.')[0];
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Report construction / normalisation
// ---------------------------------------------------------------------------

function buildReport({ url, title, text, sourceType, sourceName, publishedAt, fetchedAt }) {
  const now = new Date().toISOString();
  const fetched = isoOrNull(fetchedAt) || now;
  return {
    id: reportId(url),
    sourceType,
    sourceName,
    url,
    title: String(title || '').slice(0, 300),
    text: String(text || '').slice(0, MAX_TEXT_CHARS),
    publishedAt: isoOrNull(publishedAt) || fetched,
    fetchedAt: fetched,
    settlementId: null,
    triage: null,
    clusterId: null
  };
}

/** Force any object into the Report shape. Used on the seed corpus too. */
function normalizeReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || '').trim();
  const title = String(raw.title || '').trim();
  if (!url || !title) return null;
  const sourceType = ['news', 'social', 'official'].includes(raw.sourceType) ? raw.sourceType : 'news';
  const fetchedAt = isoOrNull(raw.fetchedAt) || new Date().toISOString();
  return {
    id: String(raw.id || reportId(url)),
    sourceType,
    sourceName: String(raw.sourceName || publisherName(url, 'Unknown source')),
    url,
    title: title.slice(0, 300),
    text: String(raw.text || '').slice(0, MAX_TEXT_CHARS),
    publishedAt: isoOrNull(raw.publishedAt) || fetchedAt,
    fetchedAt,
    settlementId: null,
    triage: null,
    clusterId: null
  };
}

function dedupeById(reports) {
  const seen = new Map();
  for (const r of reports) if (r && !seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
}

// ---------------------------------------------------------------------------
// SEED mode
// ---------------------------------------------------------------------------

/**
 * Re-anchor the offline corpus onto the current clock, preserving every relative
 * gap exactly. Without this, a demo run in October would show every settlement
 * as ~1400h silent and the ranking would flatten into noise.
 */
function reanchorTimestamps(reports) {
  if (SEED_TIME_MODE === 'absolute' || reports.length === 0) return reports;
  const newestFetch = Math.max(...reports.map((r) => Date.parse(r.fetchedAt)));
  if (!Number.isFinite(newestFetch)) return reports;
  const shiftMs = Date.now() - 5 * 60 * 1000 - newestFetch;
  if (Math.abs(shiftMs) < 60 * 1000) return reports;
  return reports.map((r) => ({
    ...r,
    publishedAt: new Date(Date.parse(r.publishedAt) + shiftMs).toISOString(),
    fetchedAt: new Date(Date.parse(r.fetchedAt) + shiftMs).toISOString()
  }));
}

function loadSeedReports() {
  const raw = readJson(SEED_PATH, null);
  if (!Array.isArray(raw)) {
    throw new Error(`seed corpus missing or invalid at ${SEED_PATH}`);
  }
  const reports = reanchorTimestamps(dedupeById(raw.map(normalizeReport).filter(Boolean)));

  // Register every distinct publisher as a source so the UI has a real source
  // list and simulateSourceFailure() has something to knock over.
  for (const r of reports) markSource(r.sourceName, r.sourceType, 'live');

  return reports;
}

// ---------------------------------------------------------------------------
// LIVE mode - one connector at a time, each isolated by try/catch + retries.
// ---------------------------------------------------------------------------

/**
 * SERP results frequently carry a RELATIVE link ("/goto?url=CAES..." for a Google
 * News redirect). Left as-is, that resolves against our own origin, and every
 * evidence link in the console opens a second copy of the console instead of the
 * article. Resolve it against the page it was scraped from. Anything that still
 * is not http(s) after that is dropped rather than shown as a dead citation - an
 * unverifiable link is worse than no link.
 */
function absolutizeUrl(rawUrl, base) {
  const s = String(rawUrl || '').trim();
  if (!s) return null;
  let resolved;
  try {
    resolved = base ? new URL(s, base).href : new URL(s).href;
  } catch {
    return null;
  }
  return /^https?:$/i.test(new URL(resolved).protocol) ? resolved : null;
}

function parseSerpPayload(body, connector, target) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    // brd_json was ignored or the zone returned HTML; fall back to link scraping.
    return [];
  }
  const buckets = []
    .concat(json.organic || [], json.news || [], json.organic_results || [], json.top_stories || [])
    .filter(Boolean);

  const out = [];
  for (const item of buckets) {
    const url = absolutizeUrl(item.link || item.url || item.href, target);
    const title = item.title || item.name;
    const text = item.description || item.snippet || item.summary || '';
    if (!url || !title) continue;
    if (!isRelevant(title, text)) continue;
    out.push(
      buildReport({
        url,
        title,
        text,
        sourceType: connector.sourceType,
        sourceName: item.source || publisherName(url, connector.name),
        publishedAt: parseLooseDate(item.date || item.published || item.time)
      })
    );
  }
  return out;
}

async function runSerpConnector(connector) {
  const reports = [];
  for (const target of connector.targets) {
    const body = await withRetry(`${connector.name} :: ${target}`, () =>
      brightDataRequest(target, { zone: SERP_ZONE })
    );
    reports.push(...parseSerpPayload(body, connector, target));
  }
  return reports;
}

async function runListingConnector(connector) {
  const reports = [];
  for (const target of connector.targets) {
    const listing = await withRetry(`${connector.name} :: ${target}`, () =>
      brightDataRequest(target, { zone: UNLOCKER_ZONE })
    );

    const candidates = extractLinks(listing, target, connector.linkPattern)
      .filter(({ url, label }) => isRelevantLink(label, url))
      .slice(0, MAX_ARTICLES_PER_CONNECTOR);

    for (const candidate of candidates) {
      try {
        const html = await withRetry(`${connector.name} :: article`, () =>
          brightDataRequest(candidate.url, { zone: UNLOCKER_ZONE })
        );
        const title = extractTitle(html) || candidate.label;
        const text = extractBodyText(html);
        if (!isRelevant(title, text)) continue;
        reports.push(
          buildReport({
            url: candidate.url,
            title,
            text,
            sourceType: connector.sourceType,
            sourceName: publisherName(candidate.url, connector.name),
            publishedAt: extractPublishedAt(html)
          })
        );
      } catch (err) {
        // One bad article must not sink the connector.
        addIncident('degraded-source', `Article fetch failed for ${connector.name}`, {
          connector: connector.name,
          url: candidate.url,
          error: String(err && err.message ? err.message : err)
        });
      }
    }
  }
  return reports;
}

async function runConnector(connector) {
  const reports =
    connector.kind === 'serp' ? await runSerpConnector(connector) : await runListingConnector(connector);
  return reports;
}

async function ingestLive() {
  const all = [];
  let healthy = 0;

  for (const connector of CONNECTORS) {
    try {
      const reports = await runConnector(connector);
      if (reports.length === 0) {
        markSource(connector.name, connector.sourceType, 'degraded');
        addIncident('degraded-source', `${connector.name} returned no usable items`, {
          connector: connector.name,
          zone: connector.kind === 'serp' ? SERP_ZONE : UNLOCKER_ZONE,
          targets: connector.targets,
          reason: 'zero-yield'
        });
      } else {
        markSource(connector.name, connector.sourceType, 'live');
        healthy++;
        all.push(...reports);
      }
    } catch (err) {
      markSource(connector.name, connector.sourceType, 'down');
      addIncident('degraded-source', `${connector.name} failed after 3 attempts`, {
        connector: connector.name,
        zone: connector.kind === 'serp' ? SERP_ZONE : UNLOCKER_ZONE,
        targets: connector.targets,
        attempts: RETRY_DELAYS_MS.length + 1,
        error: String(err && err.message ? err.message : err)
      });
      // Continue with the remaining connectors - a dead source degrades coverage,
      // it does not stop the run.
    }
  }

  return { reports: dedupeById(all), healthy };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the INGEST stage.
 * @returns {Promise<Report[]>} newest-last, de-duplicated by stable id.
 */
export async function ingest() {
  store.sources = {};

  if (config.USE_LIVE_SCRAPE) {
    let live = { reports: [], healthy: 0 };
    try {
      live = await ingestLive();
    } catch (err) {
      addIncident('degraded-source', 'Live ingest aborted unexpectedly', {
        error: String(err && err.message ? err.message : err)
      });
    }

    if (live.reports.length > 0) {
      LAST_INGEST_MODE = 'live';
      store.stats.ingestMode = 'live';
      store.stats.ingestSourcesHealthy = live.healthy;
      store.stats.ingestSourcesTotal = CONNECTORS.length;
      return live.reports;
    }

    addIncident('degraded-source', 'Every live connector failed - falling back to the offline corpus', {
      connectors: CONNECTORS.map((c) => c.name),
      fallback: 'src/data/seed-reports.json'
    });
    store.sources = {};
  }

  const reports = loadSeedReports();
  LAST_INGEST_MODE = 'seed';
  store.stats.ingestMode = 'seed';
  store.stats.ingestSourcesHealthy = Object.keys(store.sources).length;
  store.stats.ingestSourcesTotal = Object.keys(store.sources).length;
  return reports;
}

/**
 * Deliberately knock over one source for the live demo.
 * Wired to POST /api/demo/fail/source.
 * @returns {Promise<IncidentEvent>}
 */
export async function simulateSourceFailure() {
  const names = Object.keys(store.sources);

  // Prefer a currently-healthy source so the fail feed shows a real transition.
  const target =
    names.find((n) => store.sources[n].status === 'live') ||
    names[0] ||
    'Bright Data SERP - Nepali news';

  const existing = store.sources[target];
  const sourceType = existing ? existing.sourceType : 'news';
  const previousStatus = existing ? existing.status : 'unknown';

  store.sources[target] = {
    name: target,
    sourceType,
    status: 'degraded',
    lastFetchAt: existing ? existing.lastFetchAt : null
  };

  const contributed = store.reports.filter((r) => r.sourceName === target).length;

  return addIncident('degraded-source', `${target} is degraded - connector stopped responding`, {
    connector: target,
    sourceType,
    previousStatus,
    newStatus: 'degraded',
    reportsContributed: contributed,
    simulated: true,
    note: 'Coverage for this source is now stale. Silence attributable to a dead connector is not evidence of safety.'
  });
}

export default ingest;
