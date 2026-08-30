// Signal Zero — the terrain map (region C).
//
// Architecture, chosen for a live demo on unknown hardware:
//
//   MapLibre GL renders ONLY the world: terrarium raster-dem terrain, satellite or
//   street imagery, hillshade and sky. Every piece of DATA — the 32 settlements, the
//   corridor adjacency graph, the labels — lives in a DOM/SVG overlay positioned by a
//   `project(lon,lat)` function.
//
//   That indirection is the whole robustness story. When MapLibre is available the
//   projector is `map.project` (terrain-aware). When it is not — no WebGL, context
//   lost, library never arrived — the projector becomes a linear corridor-bbox fit and
//   the identical overlay keeps working as a coordinate plot. Same colours, same ring
//   shapes, same labels, same click and keyboard behaviour, no library.
//
//   It also means no glyph server, no sprite sheet, no map-image generation and no
//   style expressions: three more network/GPU dependencies that cannot fail.

import { h, silStop, popRadius, anomalyOf, fmtHours, fmtZ, fmtInt, reducedMotion, throttleRaf } from './lib.js';

const CAMERA = { center: [85.05, 27.99], zoom: 8.7, pitch: 52, bearing: 18 };
const OPENING = { center: [85.05, 27.99], zoom: 8.2, pitch: 30, bearing: 18 };
const MAX_BOUNDS = [[83.75, 26.95], [86.55, 29.05]];
// Starting extent for the fallback plot. Replaced by the real data extent as soon
// as settlements arrive, so the corridor fills the pane instead of floating in the
// middle of the camera's guard-rail box.
const FB_DEFAULT = { west: 84.20, east: 86.05, south: 27.35, north: 28.62 };

const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
// NOTE {z}/{y}/{x} — y BEFORE x. Esri, not OSM, tile order.
const SAT_TILES = ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'];
const OSM_TILES = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];

const LIB_TIMEOUT_MS = 6000;

function buildStyle() {
  return {
    version: 8,
    sources: {
      terrainDEM: {
        type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
        tiles: DEM_TILES,
        attribution: 'Elevation: Mapzen / AWS Terrain Tiles'
      },
      satellite: {
        type: 'raster', tileSize: 256, maxzoom: 17, tiles: SAT_TILES,
        attribution: '© Esri, Maxar, Earthstar Geographics'
      },
      street: {
        type: 'raster', tileSize: 256, maxzoom: 19, tiles: OSM_TILES,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [
      {
        id: 'satellite', type: 'raster', source: 'satellite',
        // Human features minimised so the data layer dominates (cartography rule).
        paint: { 'raster-saturation': -0.18, 'raster-contrast': 0.06, 'raster-opacity': 1 }
      },
      {
        id: 'street', type: 'raster', source: 'street',
        layout: { visibility: 'none' },
        paint: { 'raster-saturation': -0.55, 'raster-brightness-min': 0.15, 'raster-contrast': 0.1 }
      },
      {
        id: 'hillshade', type: 'hillshade', source: 'terrainDEM',
        layout: { visibility: 'none' },
        paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#0a1018' }
      }
    ]
  };
}

export function createMapController(opts) {
  const {
    regionEl, canvasEl, overlayEl, statusEl, bannerEl, tipEl,
    onSelect, onHover, log
  } = opts;

  let map = null;              // MapLibre instance, or null
  let ml = null;               // the module namespace
  let rung = 0;                // degradation rung, 0 = everything works
  let basemap = 'terrain';
  let terrainOn = false;
  let hold3d = false;   // hardware guard, not a failure — the user can override it
  let rows = [];               // ranked settlements, as delivered by the API
  let adjacency = {};
  let pending = new Set();
  let selectedId = null;
  let hoveredId = null;
  let destroyed = false;
  const markers = new Map();   // settlementId -> { btn, dot, label, row }
  let linesSvg = null;
  let lineEls = [];
  let demErrors = 0, satErrors = 0, tileRequests = 0;
  let FB = { ...FB_DEFAULT };
  let slowTimer = null;
  let demFailed = false;   // true only when the DEM tiles themselves are unreachable

  // ── overlay scaffold ────────────────────────────────────────────────────
  linesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  linesSvg.setAttribute('class', 'ov-lines');
  linesSvg.setAttribute('aria-hidden', 'true');
  overlayEl.append(linesSvg);

  // ── projection ──────────────────────────────────────────────────────────
  function size() {
    const r = canvasEl.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  // Linear corridor-bbox fit, aspect preserved. Used whenever MapLibre is not
  // painting. It is a real plot of real coordinates — just not a projection of
  // the terrain.
  // Fit the plot to the settlements actually on screen, with a margin.
  function recomputeFallbackExtent() {
    const pts = rows.filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)));
    if (pts.length < 2) { FB = { ...FB_DEFAULT }; return; }
    const lats = pts.map((r) => Number(r.lat));
    const lons = pts.map((r) => Number(r.lon));
    const padLat = Math.max(0.03, (Math.max(...lats) - Math.min(...lats)) * 0.10);
    const padLon = Math.max(0.03, (Math.max(...lons) - Math.min(...lons)) * 0.10);
    FB = {
      west: Math.min(...lons) - padLon, east: Math.max(...lons) + padLon,
      south: Math.min(...lats) - padLat, north: Math.max(...lats) + padLat
    };
  }

  function fallbackProject(lon, lat) {
    const { w, h: hh } = size();
    const kx = Math.cos(((FB.south + FB.north) / 2 * Math.PI) / 180);
    const bw = (FB.east - FB.west) * kx;
    const bh = FB.north - FB.south;
    const pad = 34;
    const s = Math.min((w - pad * 2) / bw, (hh - pad * 2) / bh);
    const ox = (w - bw * s) / 2;
    const oy = (hh - bh * s) / 2;
    return {
      x: ox + (lon - FB.west) * kx * s,
      y: oy + (FB.north - lat) * s
    };
  }

  function project(lon, lat) {
    if (map && rung < 3) {
      try {
        const p = map.project([lon, lat]);
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
      } catch { /* fall through */ }
    }
    return fallbackProject(lon, lat);
  }

  function currentZoom() {
    if (map && rung < 3) { try { return map.getZoom(); } catch { /* ignore */ } }
    return 9.6; // fallback plot shows the same labels as a mid-zoom map
  }

  // ── banners / status ────────────────────────────────────────────────────
  function banner(msg) {
    if (!bannerEl) return;
    if (!msg) { bannerEl.hidden = true; return; }
    bannerEl.hidden = false;
    bannerEl.textContent = '';
    bannerEl.append(h('span', { 'aria-hidden': 'true' }, '▲'), h('span', {}, msg));
  }
  function status(msg) {
    if (!statusEl) return;
    if (msg && rung >= 3) return;   // nothing is still "loading" once we have fallen back
    if (!msg) { statusEl.hidden = true; return; }
    statusEl.hidden = false;
    statusEl.textContent = msg;
  }

  // ── degradation ladder (spec §4.6) ──────────────────────────────────────
  function degrade(to, message) {
    if (to <= rung) return;
    rung = to;
    // Whatever we were waiting for is not coming. Leaving "Still loading terrain"
    // on screen next to a banner that says the tiles are unreachable tells the
    // operator two different things at once; the banner is the true one.
    clearTimeout(slowTimer);
    status(null);
    log(`Map degraded to rung ${to}: ${message}`);
    banner(message);
    if (to >= 1 && terrainOn && map) {
      try { map.setTerrain(null); } catch { /* ignore */ }
      terrainOn = false;
      syncHillshade();   // with the 3D relief gone, hillshade carries the valley
    }
    if (to >= 2 && map) applyBasemap('plain');
    if (to >= 3) {
      clearTimeout(slowTimer);
      regionEl.classList.add('map-flat');
      // Terrain and Street have nothing to render without an engine. Say so on the
      // control rather than leaving a button that silently does nothing.
      for (const b of regionEl.querySelectorAll('[data-basemap]')) {
        const plain = b.dataset.basemap === 'plain';
        b.disabled = !plain;
        b.setAttribute('aria-pressed', String(plain));
        if (!plain) b.title = 'Unavailable — the map engine is not running. The coordinate plot below shows the same 32 settlements.';
      }
      if (map) { try { map.remove(); } catch { /* ignore */ } map = null; }
      status(null);
      reposition();
    }
  }

  // ── markers ─────────────────────────────────────────────────────────────
  function buildMarkers() {
    for (const { btn } of markers.values()) btn.remove();
    markers.clear();

    const sorted = rows.slice().sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    for (const row of sorted) {
      if (!Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lon))) continue;
      const stop = silStop(row.silenceHours);
      const r = popRadius(row.population);
      const anom = row.anomalyType || 'none';
      const cold = row.coverageBasis === 'cohort-cold-start';

      const dot = h('span', { class: 'mk-dot', 'aria-hidden': 'true' });
      dot.dataset.sil = String(stop);
      dot.dataset.anom = anom;
      if (cold) dot.dataset.cold = '1';

      const label = h('span', { class: 'mk-label', 'aria-hidden': 'true' },
        h('b', {}, row.name || row.settlementId));
      if ((row.rank ?? 99) <= 3) label.append(h('i', {}, fmtHours(row.silenceHours)));

      const btn = h('button', {
        type: 'button',
        class: 'mk',
        'data-id': row.settlementId,
        'aria-label':
          `${row.name}, ${row.district}. ${fmtHours(row.silenceHours)} silent. ` +
          `Rank ${row.rank ?? '—'} of ${rows.length}. ` +
          (cold ? 'No report has ever reached us here.' : `${row.reportCount ?? 0} reports.`)
      }, dot, label);

      btn.style.setProperty('--d', `${(r * 2).toFixed(1)}px`);
      btn.dataset.rank = String(row.rank ?? 99);
      if (pending.has(row.settlementId)) {
        btn.append(h('span', { class: 'mk-pause', 'aria-hidden': 'true' }, '⏸'));
      }

      btn.addEventListener('click', () => onSelect(row.settlementId));
      btn.addEventListener('pointerenter', () => setHover(row.settlementId, true));
      btn.addEventListener('pointerleave', () => setHover(row.settlementId, false));
      btn.addEventListener('focus', () => { showTip(row); onHover(row.settlementId, true); });
      btn.addEventListener('blur', () => { hideTip(); onHover(row.settlementId, false); });

      overlayEl.append(btn);
      markers.set(row.settlementId, { btn, dot, label, row });
    }
    applySelection();
    buildLines();
    reposition();
  }

  let tipTimer = null;
  function setHover(id, on) {
    const m = markers.get(id);
    if (!m) return;
    if (on) {
      hoveredId = id;
      m.btn.classList.add('hov');
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(m.row), 250);
    } else {
      if (hoveredId === id) hoveredId = null;
      m.btn.classList.remove('hov');
      clearTimeout(tipTimer);
      hideTip();
    }
    onHover(id, on);
  }

  function showTip(row) {
    if (!tipEl || !row) return;
    const cold = row.coverageBasis === 'cohort-cold-start';
    tipEl.textContent = '';
    tipEl.append(
      h('b', {}, row.name || row.settlementId),
      h('div', { class: 'mono' }, `${row.district} · ${fmtHours(row.silenceHours)} silent`),
      h('div', { class: 'mono' }, `Gi* z ${fmtZ(row.giZScore)} · ${anomalyOf(row.anomalyType).short || 'no anomaly flag'}`),
      h('div', { class: cold ? 'mono nod' : 'mono' },
        cold ? '◌ no data reached us — baseline borrowed from cohort'
             : `● ${row.reportCount ?? 0} reports · pop ${fmtInt(row.population)}`)
    );
    tipEl.hidden = false;
    positionTip(row);
  }
  function positionTip(row) {
    if (!tipEl || tipEl.hidden) return;
    const p = project(row.lon, row.lat);
    const box = canvasEl.getBoundingClientRect();
    const tw = tipEl.offsetWidth || 200, th = tipEl.offsetHeight || 70;
    let x = p.x + 16, y = p.y - th - 10;
    if (x + tw > box.width - 8) x = p.x - tw - 16;
    if (y < 8) y = p.y + 18;
    tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; }

  // ── corridor lines ──────────────────────────────────────────────────────
  function buildLines() {
    linesSvg.textContent = '';
    lineEls = [];
    const byId = new Map(rows.map((r) => [r.settlementId, r]));
    const seen = new Set();
    for (const [id, neighbours] of Object.entries(adjacency || {})) {
      const a = byId.get(id);
      if (!a) continue;
      for (const nb of neighbours || []) {
        const key = [id, nb].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const b = byId.get(nb);
        if (!b) continue;
        const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('class', 'ov-line');
        linesSvg.append(ln);
        lineEls.push({ ln, a, b });
      }
    }
  }

  // ── layout pass ─────────────────────────────────────────────────────────
  const reposition = throttleRaf(() => {
    if (destroyed) return;
    const { w, h: hh } = size();
    linesSvg.setAttribute('viewBox', `0 0 ${w} ${hh}`);
    linesSvg.setAttribute('width', w);
    linesSvg.setAttribute('height', hh);

    const pos = new Map();
    for (const [id, m] of markers) {
      const p = project(m.row.lon, m.row.lat);
      pos.set(id, p);
      const off = p.x < -80 || p.y < -80 || p.x > w + 80 || p.y > hh + 80;
      m.btn.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
      m.btn.style.visibility = off ? 'hidden' : 'visible';
      m.btn.style.zIndex = String(1000 - (Number(m.btn.dataset.rank) || 99));
    }

    for (const { ln, a, b } of lineEls) {
      const pa = pos.get(a.settlementId) || project(a.lon, a.lat);
      const pb = pos.get(b.settlementId) || project(b.lon, b.lat);
      ln.setAttribute('x1', pa.x.toFixed(1)); ln.setAttribute('y1', pa.y.toFixed(1));
      ln.setAttribute('x2', pb.x.toFixed(1)); ln.setAttribute('y2', pb.y.toFixed(1));
    }

    layoutLabels(pos, w, hh);
    if (hoveredId && markers.has(hoveredId)) positionTip(markers.get(hoveredId).row);
  });

  // Feature importance drives label size AND who wins a collision: rank order.
  function layoutLabels(pos, w, hh) {
    const z = currentZoom();
    const placed = [];
    const ordered = Array.from(markers.values())
      .sort((a, b) => (a.row.rank ?? 99) - (b.row.rank ?? 99));
    for (const m of ordered) {
      const rank = m.row.rank ?? 99;
      const tier = rank <= 3 ? 1 : rank <= 10 ? 2 : 3;
      m.label.dataset.tier = String(tier);
      const zoomOk = tier === 1 || (tier === 2 && z >= 8.0) || (tier === 3 && z >= 9.5);
      const p = pos.get(m.row.settlementId);
      if (!zoomOk || !p || p.x < 0 || p.y < 0 || p.x > w || p.y > hh) {
        m.label.style.visibility = 'hidden';
        continue;
      }
      const lw = m.label.offsetWidth || 60;
      const lh = m.label.offsetHeight || 14;
      const box = { x1: p.x - lw / 2, y1: p.y + 8, x2: p.x + lw / 2, y2: p.y + 8 + lh };
      const hits = placed.some((q) => !(box.x2 < q.x1 || box.x1 > q.x2 || box.y2 < q.y1 || box.y1 > q.y2));
      if (hits) { m.label.style.visibility = 'hidden'; continue; }
      placed.push(box);
      m.label.style.visibility = 'visible';
    }
  }

  function applySelection() {
    for (const [id, m] of markers) {
      m.btn.classList.toggle('sel', id === selectedId);
      m.btn.setAttribute('aria-current', id === selectedId ? 'true' : 'false');
    }
  }

  // ── basemap ─────────────────────────────────────────────────────────────
  function applyBasemap(kind, silent) {
    basemap = kind;
    if (!silent) {
      for (const b of regionEl.querySelectorAll('[data-basemap]')) {
        b.setAttribute('aria-pressed', String(b.dataset.basemap === kind));
      }
    }
    regionEl.dataset.basemap = kind;
    if (!map) return;
    try {
      const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      vis('satellite', kind === 'terrain');
      vis('street', kind === 'street');
      if (kind === 'plain' && terrainOn) { map.setTerrain(null); terrainOn = false; }
      // An explicit Terrain click overrides both the hardware guard and a
      // performance-based drop: the operator asked for it. It cannot override
      // unreachable elevation tiles, because there is nothing to render.
      const mayTry = !demFailed && (rung === 0 || (!silent && rung === 1));
      if (kind !== 'plain' && !terrainOn && mayTry) {
        if (!silent && (hold3d || rung === 1)) { hold3d = false; rung = 0; banner(null); }
        if (!hold3d) {
          enableTerrain();
          if (terrainOn && !reducedMotion()) {
            try { map.easeTo({ pitch: CAMERA.pitch, bearing: CAMERA.bearing, duration: 600 }); } catch { /* ignore */ }
          }
        }
      }
      syncHillshade();
    } catch (err) {
      log(`Basemap switch failed: ${err.message}`);
    }
  }

  // Hillshade earns its place only where relief is not already carried by something
  // else: on the muted street basemap, or on imagery once 3D terrain has gone away.
  // Painted over live satellite under 3D terrain it just greys the valley out.
  function syncHillshade() {
    if (!map || !map.getLayer('hillshade')) return;
    const on = rung < 2 && basemap !== 'plain' && (basemap === 'street' || !terrainOn);
    try { map.setLayoutProperty('hillshade', 'visibility', on ? 'visible' : 'none'); } catch { /* ignore */ }
  }

  function enableTerrain() {
    if (!map) return;
    try {
      map.setTerrain({ source: 'terrainDEM', exaggeration: 1.5 });
      terrainOn = true;
      if (rung === 0) banner(null);
      syncHillshade();
    } catch (err) {
      terrainOn = false;
      degrade(1, '3D terrain unavailable — showing flat imagery.');
    }
  }

  // ── capability gate (spec §4.6 performance guard) ───────────────────────
  let webglProbe = null;   // probe once, and hand the context straight back
  function hasWebGL() {
    if (webglProbe !== null) return webglProbe;
    try {
      if (typeof WebGL2RenderingContext === 'undefined') { webglProbe = false; return false; }
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) {
        // Release it immediately. A browser only grants a handful of live contexts
        // and MapLibre needs one of them.
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
      webglProbe = !!gl;
      return webglProbe;
    } catch { webglProbe = false; return false; }
  }
  // Returns null when 3D is safe to start, otherwise the reason it is being held
  // back — which is written to the activity feed verbatim, so the operator can see
  // exactly why the console chose flat imagery on this machine.
  function guard3d() {
    if (!hasWebGL()) return 'no usable WebGL context';
    const cores = navigator.hardwareConcurrency || 0;
    if (cores && cores < 4) return `${cores} logical cores (needs 4)`;
    // A width of 0 means the container has not been measured yet — that is unknown,
    // not small. Only a real, positive, narrow viewport holds 3D back.
    const w = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
    if (w > 0 && w < 1024) return `viewport ${w}px wide (needs 1024)`;
    return null;
  }
  function wants3d() { return guard3d() === null; }

  // ── init ────────────────────────────────────────────────────────────────
  async function init() {
    status('Loading terrain…');
    slowTimer = setTimeout(() => status('Still loading terrain. The list and decisions work without it.'), 6000);

    if (!hasWebGL()) {
      clearTimeout(slowTimer);
      degrade(3, 'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.');
      return;
    }

    try {
      ml = await Promise.race([
        import('./vendor/maplibre-gl.mjs'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('library load timed out')), LIB_TIMEOUT_MS))
      ]);
    } catch (err) {
      clearTimeout(slowTimer);
      degrade(3, 'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.');
      return;
    }
    if (destroyed) { clearTimeout(slowTimer); return; }

    const heldBecause = guard3d();
    const start3d = heldBecause === null;
    try {
      map = new ml.Map({
        container: canvasEl,
        style: buildStyle(),
        center: reducedMotion() || !start3d ? CAMERA.center : OPENING.center,
        zoom: reducedMotion() || !start3d ? CAMERA.zoom : OPENING.zoom,
        pitch: start3d ? (reducedMotion() ? CAMERA.pitch : OPENING.pitch) : 0,
        bearing: start3d ? CAMERA.bearing : 0,
        maxBounds: MAX_BOUNDS,      // users cannot spin into empty space
        minZoom: 6.8,
        maxZoom: 13,                // caps DEM/imagery tile fetches. Never raise it.
        maxPitch: 70,
        dragRotate: true,
        touchPitch: true,
        attributionControl: false,
        antialias: false,
        fadeDuration: 0
      });
    } catch (err) {
      clearTimeout(slowTimer);
      degrade(3, 'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.');
      return;
    }

    map.on('error', (e) => {
      const sid = e && e.sourceId;
      const msg = (e && e.error && e.error.message) || '';
      if (sid === 'terrainDEM') {
        demErrors++;
        if (demErrors >= 4) { demFailed = true; degrade(1, '3D terrain unavailable — the elevation tiles are unreachable. Showing flat imagery.'); }
      } else if (sid === 'satellite' || sid === 'street') {
        satErrors++;
        if (satErrors >= 6) degrade(2, 'Basemap tiles unreachable — showing the data layer on a plain background.');
      } else if (msg) {
        log(`Map engine reported: ${msg}`);
      }
    });

    // If the engine never finishes starting, that is a hang. Treat it as rung 3
    // rather than sitting on "Loading terrain…" for the length of a demo.
    // A hidden or unpainted tab is UNKNOWN, not broken - the same distinction the
    // frame sampler already makes. A background tab gets no animation frames, so
    // MapLibre cannot finish its first style pass and the watchdog used to condemn
    // a perfectly healthy engine to rung 3 permanently, with no way back but a
    // reload. Re-arm while the page is hidden and judge it once it is actually
    // being painted.
    let watchdog = null;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (destroyed || !map) return;
        if (document.visibilityState === 'hidden') { armWatchdog(); return; }
        let ok = false;
        try { ok = map.isStyleLoaded(); } catch { ok = false; }
        if (!ok) degrade(3, 'Map engine did not finish starting — showing a coordinate plot. All rankings and decisions still work.');
      }, 12000);
    };
    armWatchdog();

    // Tile-supply watchdog. The per-error counters below only degrade once enough
    // tile errors have accumulated, which needs the operator to keep moving the
    // map; on a still map with an unreachable tile host the console sat on
    // "Still loading terrain" for minutes without ever saying why. If the engine
    // has not finished loading AND we have seen real tile errors, say so on a
    // bounded timer instead. Guarded on visibility for the same reason as above:
    // a suspended tab is unknown, not broken.
    const TILE_SUPPLY_MS = 25000;
    let supplyTimer = null;
    const armSupplyWatchdog = () => {
      clearTimeout(supplyTimer);
      supplyTimer = setTimeout(() => {
        if (destroyed || !map || rung >= 2) return;
        if (document.visibilityState === 'hidden') { armSupplyWatchdog(); return; }
        let done = false;
        try { done = map.loaded(); } catch { done = false; }
        if (!done && satErrors > 0) {
          degrade(2, 'Basemap tiles are not arriving — showing the data layer on a plain background.');
        } else if (!done) {
          // Not loaded, but no tile error has registered yet - that is still just
          // slow. Look again rather than either condemning it or giving up on it.
          armSupplyWatchdog();
        }
      }, TILE_SUPPLY_MS);
    };
    armSupplyWatchdog();

    // Coming back to a foregrounded tab, give the engine a fresh window to finish
    // rather than judging it on time it spent suspended.
    const onVisible = () => { if (document.visibilityState === 'visible' && map && !destroyed) armWatchdog(); };
    document.addEventListener('visibilitychange', onVisible);
    map.on('load', () => document.removeEventListener('visibilitychange', onVisible));

    map.on('load', () => {
      clearTimeout(slowTimer);
      clearTimeout(watchdog);
      status(null);
      if (!start3d) {
        hold3d = true;
        banner(`3D terrain held back by the hardware guard (${heldBecause}) — flat imagery shown. Press Terrain to turn it on anyway.`);
        log(`3D terrain held back by the hardware guard: ${heldBecause}. Flat imagery shown; the Terrain button overrides it.`);
      } else {
        enableTerrain();
        try {
          if (typeof map.setSky === 'function') {
            map.setSky({
              'sky-color': '#3a6ea5', 'horizon-color': '#b8cbdd', 'fog-color': '#c8d6e2',
              'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.2
            });
          }
        } catch { /* sky is decoration; never fatal */ }
        if (!reducedMotion()) {
          try { map.easeTo({ ...CAMERA, duration: 1400 }); } catch { /* ignore */ }
        }
      }
      applyBasemap(basemap, true);
      reposition();
      sampleFrames();
    });

    for (const ev of ['move', 'zoom', 'rotate', 'pitch', 'resize', 'render', 'terrain']) {
      map.on(ev, reposition);
    }
    map.on('dataloading', () => { tileRequests++; });

    const canvas = map.getCanvas ? map.getCanvas() : null;
    if (canvas) {
      canvas.setAttribute('aria-hidden', 'true');
      canvas.setAttribute('tabindex', '-1');
      canvas.addEventListener('webglcontextlost', () => {
        degrade(3, 'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.');
      });
    }
  }

  // Frame-time sample for the first 4s. A conference-room tablet that cannot hold
  // 25fps drops to flat imagery rather than stuttering through the demo.
  function sampleFrames() {
    if (reducedMotion()) return;
    // Start after the first tile burst. The worst frames of a map's life are the
    // ones where it is decoding its first screenful, and they say nothing about
    // whether this machine can hold the scene.
    setTimeout(runSample, 3000);
  }
  function runSample() {
    if (destroyed || !map) return;
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      const dt = performance.now() - t0;
      if (dt < 4000) { requestAnimationFrame(tick); return; }
      const mean = dt / Math.max(1, frames);
      // Too few frames means the page was not being painted at all (hidden pane,
      // suspended compositor). That is unknown, not slow — do not punish it.
      if (frames >= 24 && mean > 40 && terrainOn) {
        degrade(1, `3D terrain dropped — this device rendered at ${(1000 / mean).toFixed(0)}fps. Showing flat imagery.`);
      }
    };
    requestAnimationFrame(tick);
  }

  // ── public API ──────────────────────────────────────────────────────────
  const api = {
    setData(nextRows, nextAdjacency) {
      rows = Array.isArray(nextRows) ? nextRows.filter((r) => r && r.settlementId) : [];
      if (nextAdjacency) adjacency = nextAdjacency;
      recomputeFallbackExtent();
      buildMarkers();
      status(rows.length ? null : 'No settlements plotted yet.');
    },
    setAdjacency(a) { adjacency = a || {}; buildLines(); reposition(); },
    setPending(ids) {
      pending = new Set(ids || []);
      for (const [id, m] of markers) {
        const existing = m.btn.querySelector('.mk-pause');
        if (pending.has(id) && !existing) {
          m.btn.append(h('span', { class: 'mk-pause', 'aria-hidden': 'true' }, '⏸'));
        } else if (!pending.has(id) && existing) {
          existing.remove();
        }
      }
    },
    select(id, { fly = true } = {}) {
      selectedId = id;
      applySelection();
      const m = id && markers.get(id);
      if (!m || !fly || !map || rung >= 3) return;
      const target = { center: [m.row.lon, m.row.lat], zoom: Math.max(map.getZoom(), 10.2) };
      try { map.easeTo({ ...target, duration: reducedMotion() ? 0 : 900 }); } catch { /* ignore */ }
    },
    hover(id, on) {
      const m = markers.get(id);
      if (m) m.btn.classList.toggle('hov', !!on);
    },
    resetView() {
      hideTip();
      if (map && rung < 3) {
        try {
          map.easeTo({
            ...CAMERA,
            pitch: terrainOn ? CAMERA.pitch : 0,
            bearing: terrainOn ? CAMERA.bearing : 0,
            duration: reducedMotion() ? 0 : 700
          });
        } catch { /* ignore */ }
      }
      reposition();
    },
    setBasemap(kind) { applyBasemap(kind); },
    resize() { if (map) { try { map.resize(); } catch { /* ignore */ } } reposition(); },
    reposition,
    get rung() { return rung; },
    get engine() { return map; },   // debug handle, also handy live: window.signalZeroMap.engine
    get terrainOn() { return terrainOn; },
    destroy() { destroyed = true; if (map) { try { map.remove(); } catch { /* ignore */ } } }
  };

  // Draw the overlay immediately with the fallback projector, then let MapLibre
  // take over. First paint never waits on the network.
  window.addEventListener('resize', () => api.resize());
  init().catch((err) => {
    degrade(3, 'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.');
    log(`Map init threw: ${err && err.message}`);
  });

  try { window.signalZeroMap = api; } catch { /* ignore */ }
  return api;
}
