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

import {
  h,
  silStop,
  popRadius,
  anomalyOf,
  fmtHours,
  fmtZ,
  fmtInt,
  reducedMotion,
  throttleRaf,
  silenceKind,
  fmtNum
} from './lib.js';

const CAMERA = { center: [85.05, 27.99], zoom: 8.7, pitch: 54, bearing: 18 };
// The opening is a slow push-in along the valley, not a fly-around. It starts
// higher, flatter and turned a few degrees off the resting bearing so the
// ridgelines rotate into their rim light rather than snapping into place.
const OPENING = { center: [85.02, 27.95], zoom: 7.9, pitch: 22, bearing: 4 };
const MAX_BOUNDS = [
  [83.75, 26.95],
  [86.55, 29.05]
];
// Starting extent for the fallback plot. Replaced by the real data extent as soon
// as settlements arrive, so the corridor fills the pane instead of floating in the
// middle of the camera's guard-rail box.
const FB_DEFAULT = { west: 84.2, east: 86.05, south: 27.35, north: 28.62 };

const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
// NOTE {z}/{y}/{x} — y BEFORE x. Esri, not OSM, tile order.
const SAT_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
];
const OSM_TILES = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];

const LIB_TIMEOUT_MS = 6000;

// ══════════════════════════════════════════════════════════════════════════
// THE FROZEN-PULSE RING — the thesis, made visible.
// ══════════════════════════════════════════════════════════════════════════
//
// Every settlement already carries its own expected reporting interval,
// expectedGapHours = 1/λ, fitted server-side. The ring around each marker is
// that interval drawn as one cycle. Three states, and they are three DIFFERENT
// OBJECTS, not three shades of one:
//
//   recent   a complete, unbroken ring — one full cycle — and, when motion is
//            allowed, a pulse that expands and fades once per cycle. No two
//            settlements pulse alike, because no two share a λ.
//   stopped  a BROKEN arc with a visible gap and a radial notch where the hand
//            stopped. Reports arrived here and then ceased: the arc is drawn to
//            the fraction of its own cycle that had elapsed when contact was
//            lost, and it never closes. This is the strongest signal we have.
//   never    a dashed ghost ring. The pulse NEVER STARTED. No arc, no notch, no
//            end point — because there is no observed cycle to freeze. It must
//            not look like a confirmed going-dark, because it is not one.
//
// Under prefers-reduced-motion the pulse is simply not created; all three states
// above are already static drawings, so the distinction survives untouched.

const RING_VB = 100; // viewBox is 0 0 100 100 for every marker
const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;
const ARC_SWEEP = 300; // degrees. A frozen arc can never close a circle.

// Real hours are compressed into a legible loop — a 37-hour CSS animation is not
// a thing anyone can perceive. The compression is monotone (a longer real
// interval is always a slower ring) and the real figure is stated verbatim in
// the marker tooltip, so nothing is hidden by it.
const CYC_MIN_S = 4.2,
  CYC_MAX_S = 18;
const GAP_MIN_H = 6,
  GAP_MAX_H = 72;
function cycleSeconds(expectedGapHours) {
  const g = Number(expectedGapHours);
  if (!Number.isFinite(g) || g <= 0) return null;
  const t = Math.min(1, Math.max(0, (g - GAP_MIN_H) / (GAP_MAX_H - GAP_MIN_H)));
  return CYC_MIN_S + (CYC_MAX_S - CYC_MIN_S) * t;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs || {}))
    if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  return n;
};

/**
 * The ring for one settlement. Everything it draws comes from the row: the
 * elapsed fraction is silenceHours/expectedGapHours, both server fields.
 */
function buildRing(row, kind) {
  const svg = svgEl('svg', {
    class: 'mk-ring',
    viewBox: `0 0 ${RING_VB} ${RING_VB}`,
    'aria-hidden': 'true'
  });
  svg.dataset.kind = kind;

  if (kind === 'never') {
    // No cycle was ever observed here, so there is nothing to draw a position on.
    svg.append(
      svgEl('circle', {
        class: 'rg-ghost',
        cx: 50,
        cy: 50,
        r: RING_R,
        fill: 'none',
        'vector-effect': 'non-scaling-stroke'
      })
    );
    return svg;
  }

  if (kind === 'recent') {
    svg.append(
      svgEl('circle', {
        class: 'rg-full',
        cx: 50,
        cy: 50,
        r: RING_R,
        fill: 'none',
        'vector-effect': 'non-scaling-stroke'
      })
    );
    return svg;
  }

  // stopped — freeze the hand where it stopped.
  const gap = Number(row.expectedGapHours);
  const sil = Number(row.silenceHours);
  const ratio = Number.isFinite(gap) && gap > 0 && Number.isFinite(sil) ? sil / gap : 1;
  const f = Math.min(1, Math.max(0.08, ratio)); // never a full circle
  const sweptDeg = f * ARC_SWEEP;
  const swept = (sweptDeg / 360) * RING_C;

  svg.append(
    svgEl('circle', {
      class: 'rg-track',
      cx: 50,
      cy: 50,
      r: RING_R,
      fill: 'none',
      'vector-effect': 'non-scaling-stroke'
    })
  );
  svg.append(
    svgEl('circle', {
      class: 'rg-arc',
      cx: 50,
      cy: 50,
      r: RING_R,
      fill: 'none',
      'vector-effect': 'non-scaling-stroke',
      transform: `rotate(-90 50 50)`,
      'stroke-dasharray': `${swept.toFixed(2)} ${(RING_C - swept).toFixed(2)}`
    })
  );

  // The stopped-clock notch: a radial tick at exactly the angle the arc reached.
  const th = ((-90 + sweptDeg) * Math.PI) / 180;
  svg.append(
    svgEl('line', {
      class: 'rg-notch',
      'vector-effect': 'non-scaling-stroke',
      'stroke-linecap': 'butt',
      x1: (50 + Math.cos(th) * (RING_R - 7)).toFixed(2),
      y1: (50 + Math.sin(th) * (RING_R - 7)).toFixed(2),
      x2: (50 + Math.cos(th) * (RING_R + 8)).toFixed(2),
      y2: (50 + Math.sin(th) * (RING_R + 8)).toFixed(2)
    })
  );
  return svg;
}

function buildStyle() {
  return {
    version: 8,
    sources: {
      terrainDEM: {
        type: 'raster-dem',
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
        tiles: DEM_TILES,
        attribution: 'Elevation: Mapzen / AWS Terrain Tiles'
      },
      // A second handle on the same tiles. MapLibre warns when one raster-dem
      // source feeds both setTerrain() and a hillshade layer, and it is right to:
      // the two consume the DEM at different resolutions and sharing one cache
      // costs the hillshade its detail. The tiles are identical URLs, so the
      // browser's HTTP cache serves the second source for free — the only real
      // cost is a second decoded tile cache, which at this extent is small.
      hillshadeDEM: {
        type: 'raster-dem',
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
        tiles: DEM_TILES
      },
      satellite: {
        type: 'raster',
        tileSize: 256,
        maxzoom: 17,
        tiles: SAT_TILES,
        attribution: '© Esri, Maxar, Earthstar Geographics'
      },
      street: {
        type: 'raster',
        tileSize: 256,
        maxzoom: 19,
        tiles: OSM_TILES,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [
      {
        id: 'satellite',
        type: 'raster',
        source: 'satellite',
        // Human features minimised so the data layer dominates (cartography rule).
        paint: { 'raster-saturation': -0.18, 'raster-contrast': 0.06, 'raster-opacity': 1 }
      },
      {
        id: 'street',
        type: 'raster',
        source: 'street',
        layout: { visibility: 'none' },
        paint: { 'raster-saturation': -0.55, 'raster-brightness-min': 0.15, 'raster-contrast': 0.1 }
      },
      {
        // Rim light. A low, near-horizon illumination direction (325°, roughly
        // north-west and grazing) is what produces the bright edge along a ridge
        // in real terrain shading — the same effect a rim-light shader fakes in a
        // WebGL scene, available here as one property. Kept thin (0.3) and warm
        // in the highlight so it draws the ridgelines without greying the valley.
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshadeDEM',
        layout: { visibility: 'none' },
        paint: {
          'hillshade-exaggeration': 0.3,
          'hillshade-illumination-direction': 325,
          'hillshade-illumination-anchor': 'viewport',
          'hillshade-shadow-color': '#0b1420',
          'hillshade-highlight-color': '#fff3df',
          'hillshade-accent-color': '#1d2b3a'
        }
      }
    ]
  };
}

export function createMapController(opts) {
  const { regionEl, canvasEl, overlayEl, statusEl, bannerEl, tipEl, onSelect, onHover, log } = opts;

  let map = null; // MapLibre instance, or null
  let ml = null; // the module namespace
  let rung = 0; // degradation rung, 0 = everything works
  let basemap = 'terrain';
  let terrainOn = false;
  let hold3d = false; // hardware guard, not a failure — the user can override it
  let rows = []; // ranked settlements, as delivered by the API
  let adjacency = {};
  let pending = new Set();
  let selectedId = null;
  let hoveredId = null;
  let destroyed = false;
  const markers = new Map(); // settlementId -> { btn, dot, label, row }
  let linesSvg = null;
  let lineEls = [];
  let demErrors = 0,
    satErrors = 0,
    tileRequests = 0;
  let FB = { ...FB_DEFAULT };
  let slowTimer = null;
  let demFailed = false; // true only when the DEM tiles themselves are unreachable
  let voidLayer = null;
  const voids = new Map(); // settlementId -> { el, r }
  let lastAnomaly = new Map(); // settlementId -> anomalyType, for change detection
  let seenData = false; // first payload must not fire propagation pulses
  let staleHours = 0;
  let framed = false; // the opening camera has been fitted to the corridor
  let restCam = { ...CAMERA }; // where "Reset view" goes: the fitted frame, once known
  let userMoved = false; // the operator has driven the camera; stop correcting it

  // ── effects budget ──────────────────────────────────────────────────────
  // full = rings pulse, the void spreads, corridor pulses fire.
  // lite = every one of those becomes its static drawing. Nothing that carries
  //        meaning is removed; only the motion and the large soft gradients are.
  // Set from the same evidence the 3D guard uses, and lowered (never raised) by
  // the frame sampler. reduced-motion forces lite for motion but keeps the void.
  let fx = 'full';
  function setFx(level, why) {
    if (level === fx) return;
    fx = level;
    regionEl.dataset.fx = level;
    if (why) log(`Map effects reduced to "${level}": ${why}`);
  }
  (function initialFx() {
    const cores = navigator.hardwareConcurrency || 0;
    const mem = navigator.deviceMemory || 0;
    if ((cores && cores < 4) || (mem && mem <= 2)) {
      fx = 'lite';
      regionEl.dataset.fx = 'lite';
    } else {
      regionEl.dataset.fx = 'full';
    }
  })();

  // ── overlay scaffold ────────────────────────────────────────────────────
  // Painting order inside the overlay is the whole point of the void treatment:
  // the darkness sits UNDER the corridor graph and under every marker, so it
  // eats the ground and never the data.
  voidLayer = h('div', { class: 'map-void', 'aria-hidden': 'true' });
  overlayEl.append(voidLayer);

  // The staleness haze. It veils the GROUND only — it is inserted between the
  // map canvas and the data overlay, so a stale console gets harder to read the
  // terrain through and never harder to read the numbers on.
  const hazeEl = h('div', { class: 'map-haze', 'aria-hidden': 'true' });
  regionEl.insertBefore(hazeEl, overlayEl);

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
    const pts = rows.filter(
      (r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon))
    );
    if (pts.length < 2) {
      FB = { ...FB_DEFAULT };
      return;
    }
    const lats = pts.map((r) => Number(r.lat));
    const lons = pts.map((r) => Number(r.lon));
    const padLat = Math.max(0.03, (Math.max(...lats) - Math.min(...lats)) * 0.1);
    const padLon = Math.max(0.03, (Math.max(...lons) - Math.min(...lons)) * 0.1);
    FB = {
      west: Math.min(...lons) - padLon,
      east: Math.max(...lons) + padLon,
      south: Math.min(...lats) - padLat,
      north: Math.max(...lats) + padLat
    };
  }

  function fallbackProject(lon, lat) {
    const { w, h: hh } = size();
    const kx = Math.cos((((FB.south + FB.north) / 2) * Math.PI) / 180);
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
      } catch {
        /* fall through */
      }
    }
    return fallbackProject(lon, lat);
  }

  function currentZoom() {
    if (map && rung < 3) {
      try {
        return map.getZoom();
      } catch {
        /* ignore */
      }
    }
    return 9.6; // fallback plot shows the same labels as a mid-zoom map
  }

  // ── banners / status ────────────────────────────────────────────────────
  function banner(msg) {
    if (!bannerEl) return;
    if (!msg) {
      bannerEl.hidden = true;
      return;
    }
    bannerEl.hidden = false;
    bannerEl.textContent = '';
    bannerEl.append(h('span', { 'aria-hidden': 'true' }, '▲'), h('span', {}, msg));
  }
  function status(msg) {
    if (!statusEl) return;
    if (msg && rung >= 3) return; // nothing is still "loading" once we have fallen back
    if (!msg) {
      statusEl.hidden = true;
      return;
    }
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
      try {
        map.setTerrain(null);
      } catch {
        /* ignore */
      }
      terrainOn = false;
      syncHillshade(); // with the 3D relief gone, hillshade carries the valley
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
        if (!plain)
          b.title =
            'Unavailable — the map engine is not running. The coordinate plot below shows the same 32 settlements.';
      }
      if (map) {
        try {
          map.remove();
        } catch {
          /* ignore */
        }
        map = null;
      }
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

      const kind = silenceKind(row);

      const dot = h('span', { class: 'mk-dot', 'aria-hidden': 'true' });
      dot.dataset.sil = String(stop);
      dot.dataset.anom = anom;
      if (cold) dot.dataset.cold = '1';

      const label = h(
        'span',
        { class: 'mk-label', 'aria-hidden': 'true' },
        h('b', {}, row.name || row.settlementId)
      );
      if ((row.rank ?? 99) <= 3) label.append(h('i', {}, fmtHours(row.silenceHours)));

      const btn = h(
        'button',
        {
          type: 'button',
          class: 'mk',
          'data-id': row.settlementId,
          'aria-label':
            `${row.name}, ${row.district}. ${fmtHours(row.silenceHours)} silent. ` +
            `Rank ${row.rank ?? '—'} of ${rows.length}. ` +
            (cold ? 'No report has ever reached us here.' : `${row.reportCount ?? 0} reports.`)
        },
        buildRing(row, kind),
        dot,
        label
      );
      btn.dataset.kind = kind;

      // Only a settlement still being heard from gets a moving ring, and it moves
      // at its own fitted interval. The others are already at rest.
      const cyc = cycleSeconds(row.expectedGapHours);
      if (kind === 'recent' && cyc && !reducedMotion()) {
        const pulse = h('span', { class: 'mk-pulse', 'aria-hidden': 'true' });
        pulse.style.animationDuration = `${cyc.toFixed(2)}s`;
        // Constant REACH, not constant scale: a pulse from a large settlement
        // must not travel four times as far across the valley as one from a
        // small one. The ring always ends ~23px outside the marker's edge.
        const base = r * 2 + 14;
        pulse.style.setProperty('--pmax', ((base + 46) / base).toFixed(3));
        // Phase-offset by a hash of the id so 7 live markers do not beat in
        // lockstep — the model gives each its own period, not its own phase.
        let seed = 0;
        for (const ch of String(row.settlementId)) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
        pulse.style.animationDelay = `-${((seed / 997) * cyc).toFixed(2)}s`;
        btn.insertBefore(pulse, btn.firstChild);
      }

      btn.style.setProperty('--d', `${(r * 2).toFixed(1)}px`);
      // The frozen arc is drawn in the settlement's own band from the silence
      // ramp, desaturated by the stylesheet — not in a new hue.
      btn.style.setProperty('--ringcol', `var(--sil-${stop})`);
      btn.dataset.rank = String(row.rank ?? 99);
      if (pending.has(row.settlementId)) {
        btn.append(h('span', { class: 'mk-pause', 'aria-hidden': 'true' }, '⏸'));
      }

      btn.addEventListener('click', () => onSelect(row.settlementId));
      btn.addEventListener('pointerenter', () => setHover(row.settlementId, true));
      btn.addEventListener('pointerleave', () => setHover(row.settlementId, false));
      btn.addEventListener('focus', () => {
        showTip(row);
        onHover(row.settlementId, true);
      });
      btn.addEventListener('blur', () => {
        hideTip();
        onHover(row.settlementId, false);
      });

      overlayEl.append(btn);
      markers.set(row.settlementId, { btn, dot, label, row, kind });
    }
    applySelection();
    buildVoids();
    buildLines();
    reposition();
  }

  // ── the void ────────────────────────────────────────────────────────────
  // Hazard maps encode danger as a loud colour. This product's danger signal is
  // an absence, so the encoding is inverted: the longer nothing has arrived, the
  // more the ground around a settlement darkens and recedes. Presence is a small
  // lit island; four days of nothing is the map's own background reclaiming the
  // corridor. Kept strictly in the cool neutral family — never crimson — so it
  // can never be read as "a source is down".
  function voidGeometry(row) {
    const sil = Number(row.silenceHours);
    if (!Number.isFinite(sil)) return null;
    const kind = silenceKind(row);
    if (kind === 'recent') {
      // Lit. Small, and it does not grow.
      return { r: 26 + Math.min(10, (Number(row.population) || 0) / 3000), lit: true, a: 0.5 };
    }
    // Radius and opacity both scale with silenceHours, and both are capped.
    //
    // The per-blob opacity is deliberately far below what a single blob would
    // need to read, because these blobs OVERLAP: twenty-four silent settlements
    // packed into one valley compound to roughly 1-(1-a)^n, and at the dossier's
    // suggested 0.55 the corridor went solid black and swallowed the terrain —
    // which reads as a broken renderer, not as absence. Tuned on the live
    // 24-of-32 payload so the accumulation lands dark but still translucent.
    const r = Math.min(112, Math.max(20, 20 + 0.55 * sil));
    const a = Math.min(0.19, Math.max(0.05, 0.055 + 0.0012 * sil));
    // "Never heard from" is a weaker claim than "heard from, then stopped", and
    // the void says so: it is drawn softer and hollower for a cold start.
    return { r, lit: false, a: kind === 'never' ? a * 0.8 : a, kind };
  }

  function buildVoids() {
    voidLayer.textContent = '';
    voids.clear();
    for (const row of rows) {
      if (!Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lon))) continue;
      const g = voidGeometry(row);
      if (!g) continue;
      const el = h('span', { class: `void-blob${g.lit ? ' is-lit' : ''}` });
      if (g.kind) el.dataset.kind = g.kind;
      el.style.setProperty('--vr', `${g.r.toFixed(0)}px`);
      el.style.setProperty('--va', g.a.toFixed(3));
      voidLayer.append(el);
      voids.set(row.settlementId, { el, row });
    }
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
    const kind = silenceKind(row);
    const gap = Number(row.expectedGapHours);
    const sil = Number(row.silenceHours);
    tipEl.textContent = '';
    tipEl.append(
      h('b', {}, row.name || row.settlementId),
      h('div', { class: 'mono' }, `${row.district} · ${fmtHours(row.silenceHours)} silent`),
      h(
        'div',
        { class: 'mono' },
        `Gi* z ${fmtZ(row.giZScore)} · ${anomalyOf(row.anomalyType).short || 'no anomaly flag'}`
      ),
      h(
        'div',
        { class: cold ? 'mono nod' : 'mono' },
        cold
          ? '◌ no data reached us — baseline borrowed from cohort'
          : `● ${row.reportCount ?? 0} reports · pop ${fmtInt(row.population)}`
      )
    );
    // The ring is a statistic, so it explains itself. The compression from real
    // hours to a legible loop is stated, never implied.
    if (Number.isFinite(gap) && gap > 0) {
      const line = h('div', { class: 'mono tip-ring' });
      if (kind === 'recent') {
        line.append(
          reducedMotion()
            ? `◍ ring = one expected report interval: ${fmtHours(gap)}`
            : `◍ ring pulses once per expected interval — ${fmtHours(gap)}, compressed for display`
        );
      } else if (kind === 'stopped') {
        line.append(
          `◔ ring stopped mid-cycle — expected every ${fmtHours(gap)}, ` +
            `${fmtNum(sil / gap, 1)}× overdue`
        );
      } else {
        line.append(
          `◌ ring never started — ${fmtHours(gap)} is the cohort's interval, not this settlement's`
        );
      }
      tipEl.append(line);
    }
    tipEl.hidden = false;
    positionTip(row);
  }
  function positionTip(row) {
    if (!tipEl || tipEl.hidden) return;
    const p = project(row.lon, row.lat);
    const box = canvasEl.getBoundingClientRect();
    const tw = tipEl.offsetWidth || 200,
      th = tipEl.offsetHeight || 70;
    let x = p.x + 16,
      y = p.y - th - 10;
    if (x + tw > box.width - 8) x = p.x - tw - 16;
    if (y < 8) y = p.y + 18;
    tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  function hideTip() {
    if (tipEl) tipEl.hidden = true;
  }

  // ── corridor arcs — the Gi* adjacency graph, drawn ──────────────────────
  //
  // These are not decoration and they are not "data flowing". Gi* is a measure of
  // spatial autocorrelation: a settlement's z-score is raised by its NEIGHBOURS'
  // surprisal, along exactly these edges. So the edge is weighted by what the
  // statistic actually uses — an edge with silence at both ends is the edge that
  // moved a z-score, and it is drawn heavier. An edge with a live reporter at one
  // end did the opposite, and stays faint. That weighting is static: it is
  // legible with every animation in the browser switched off.
  function edgeWeight(a, b) {
    const ka = silenceKind(a),
      kb = silenceKind(b);
    if (ka === 'recent' || kb === 'recent') return 'live'; // an anchor, not a cluster
    if (ka === 'stopped' || kb === 'stopped') return 'stopped';
    return 'dark';
  }

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
        const ln = svgEl('path', {
          class: 'ov-line',
          fill: 'none',
          'vector-effect': 'non-scaling-stroke',
          id: `arc-${key.replace(/[^a-z0-9|-]/gi, '')}`.replace(/\|/g, '--')
        });
        ln.dataset.w = edgeWeight(a, b);
        linesSvg.append(ln);
        lineEls.push({ ln, a, b, key });
      }
    }
  }

  // A corridor arc: a quadratic curve bowed perpendicular to the edge. The bow is
  // proportional to length so short hops stay nearly straight and the long valley
  // legs read as arcs over the terrain rather than as wires laid on top of it.
  function arcPath(pa, pb) {
    const dx = pb.x - pa.x,
      dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(46, len * 0.16);
    const mx = (pa.x + pb.x) / 2,
      my = (pa.y + pb.y) / 2;
    // Always bow the same way relative to the edge direction, so the graph does
    // not flip its shape as the camera rotates.
    const nx = -dy / len,
      ny = dx / len;
    const s = ny > 0 ? -1 : 1;
    return `M ${pa.x.toFixed(1)} ${pa.y.toFixed(1)} Q ${(mx + nx * bow * s).toFixed(1)} ${(my + ny * bow * s).toFixed(1)} ${pb.x.toFixed(1)} ${pb.y.toFixed(1)}`;
  }

  // ── propagation pulse ───────────────────────────────────────────────────
  // Fires ONCE, at the moment the server's classification changes — never as an
  // ambient loop. What travels is the thing Gi* measures: a settlement has just
  // been flagged because its neighbours are quiet, so the pulse runs from those
  // neighbours in, along the edges the statistic summed over.
  const CLUSTER_TYPES = new Set(['silent-cluster', 'regional-outage', 'cluster-edge']);

  function detectClusterFormation(nextRows) {
    const next = new Map(nextRows.map((r) => [r.settlementId, r.anomalyType || 'none']));
    const formed = [];
    if (seenData) {
      for (const [id, type] of next) {
        const was = lastAnomaly.get(id);
        if (was === undefined) continue; // new row, not a change
        if (CLUSTER_TYPES.has(type) && !CLUSTER_TYPES.has(was)) formed.push(id);
      }
    }
    lastAnomaly = next;
    seenData = true;
    return formed;
  }

  function pulseInto(id) {
    const target = markers.get(id);
    if (!target) return;
    const edges = lineEls.filter((e) => e.a.settlementId === id || e.b.settlementId === id);
    if (!edges.length) return;

    const anom = anomalyOf(target.row.anomalyType).short || 'anomaly';
    log(
      `Corridor: ${target.row.name} entered ${anom.toLowerCase()} — the Gi* graph is showing the ${edges.length} adjacency edge${edges.length === 1 ? '' : 's'} its z-score is summed over.`
    );

    if (reducedMotion() || fx !== 'full') {
      // Same fact, no travel: the edges that carried the statistic are held lit
      // for six seconds and then released.
      for (const e of edges) {
        e.ln.classList.add('is-pulsed');
        setTimeout(() => e.ln.classList.remove('is-pulsed'), 6000);
      }
      return;
    }

    for (const e of edges) {
      // Travel INTO the newly-flagged settlement, from the neighbour end.
      const reverse = e.a.settlementId === id;
      const dot = svgEl('circle', { class: 'ov-pulse', r: 3.1 });
      // begin="indefinite" and an explicit beginElement(): a SMIL `begin="0s"`
      // is measured from DOCUMENT load, not from insertion, so an element added
      // ten minutes into a session starts an animation that finished ten minutes
      // ago and never moves.
      const motion = svgEl('animateMotion', {
        dur: '1.15s',
        begin: 'indefinite',
        fill: 'remove',
        keyPoints: reverse ? '1;0' : '0;1',
        keyTimes: '0;1',
        calcMode: 'linear'
      });
      const mp = svgEl('mpath', { href: `#${e.ln.id}` });
      mp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${e.ln.id}`);
      motion.append(mp);
      dot.append(motion);
      linesSvg.append(dot);
      e.ln.classList.add('is-pulsed');
      let started = false;
      try {
        if (typeof motion.beginElement === 'function') {
          motion.beginElement();
          started = true;
        }
      } catch {
        started = false;
      }
      // No SMIL in this engine. The edge still lights, which is the same fact
      // without the travel — the static form the reduced-motion path already uses.
      if (!started) dot.remove();
      setTimeout(
        () => {
          dot.remove();
          e.ln.classList.remove('is-pulsed');
        },
        started ? 1500 : 6000
      );
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

    for (const { el, row } of voids.values()) {
      const p = pos.get(row.settlementId) || project(row.lon, row.lat);
      const off = p.x < -180 || p.y < -180 || p.x > w + 180 || p.y > hh + 180;
      el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0) translate(-50%,-50%)`;
      el.style.visibility = off ? 'hidden' : 'visible';
    }

    for (const { ln, a, b } of lineEls) {
      const pa = pos.get(a.settlementId) || project(a.lon, a.lat);
      const pb = pos.get(b.settlementId) || project(b.lon, b.lat);
      ln.setAttribute('d', arcPath(pa, pb));
    }

    layoutLabels(pos, w, hh);
    if (hoveredId && markers.has(hoveredId)) positionTip(markers.get(hoveredId).row);
  });

  // Feature importance drives label size AND who wins a collision: rank order.
  function layoutLabels(pos, w, hh) {
    const z = currentZoom();
    const placed = [];
    const ordered = Array.from(markers.values()).sort(
      (a, b) => (a.row.rank ?? 99) - (b.row.rank ?? 99)
    );
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
      const hits = placed.some(
        (q) => !(box.x2 < q.x1 || box.x1 > q.x2 || box.y2 < q.y1 || box.y1 > q.y2)
      );
      if (hits) {
        m.label.style.visibility = 'hidden';
        continue;
      }
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
      const vis = (id, on) =>
        map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      vis('satellite', kind === 'terrain');
      vis('street', kind === 'street');
      if (kind === 'plain' && terrainOn) {
        map.setTerrain(null);
        terrainOn = false;
      }
      // An explicit Terrain click overrides both the hardware guard and a
      // performance-based drop: the operator asked for it. It cannot override
      // unreachable elevation tiles, because there is nothing to render.
      const mayTry = !demFailed && (rung === 0 || (!silent && rung === 1));
      if (kind !== 'plain' && !terrainOn && mayTry) {
        if (!silent && (hold3d || rung === 1)) {
          hold3d = false;
          rung = 0;
          banner(null);
        }
        if (!hold3d) {
          enableTerrain();
          if (terrainOn && !reducedMotion()) {
            try {
              map.easeTo({ pitch: CAMERA.pitch, bearing: CAMERA.bearing, duration: 600 });
            } catch {
              /* ignore */
            }
          }
        }
      }
      syncHillshade();
    } catch (err) {
      log(`Basemap switch failed: ${err.message}`);
    }
  }

  // Hillshade is now doing a different job than it was: at 0.3 exaggeration with a
  // grazing 325° light anchored to the viewport it is a RIM LIGHT, not a relief
  // fill — it brightens ridge edges and leaves the valley floor alone, which is
  // what makes the corridor read as a canyon rather than a green smear. That is
  // worth having under 3D terrain as well as instead of it. On the plain
  // background there is no imagery for it to light, so it stays off.
  function syncHillshade() {
    if (!map || !map.getLayer('hillshade')) return;
    const on = rung < 2 && basemap !== 'plain';
    try {
      map.setLayoutProperty('hillshade', 'visibility', on ? 'visible' : 'none');
    } catch {
      /* ignore */
    }
  }

  // ── atmosphere ──────────────────────────────────────────────────────────
  //
  // Sky and fog are not wallpaper here. Fog density is driven by TIME SINCE THE
  // LAST COMPLETE PIPELINE PASS, so the map itself visibly un-focuses as the
  // console's own knowledge goes stale. It is the same grammar the settlements
  // are drawn with — the longer since we last heard, the harder it is to see —
  // applied recursively to the system's knowledge of itself. Data never fogs:
  // markers, labels and corridor arcs are DOM above the canvas.
  function isDark() {
    const set = document.documentElement.dataset.theme;
    if (set === 'dark') return true;
    if (set === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // 0 at a fresh pass, 1 at six hours cold. Clamped, so a console left running
  // overnight does not white out entirely.
  function stalenessT() {
    return Math.min(1, Math.max(0, staleHours / 6));
  }

  function applyAtmosphere() {
    const t = stalenessT();
    // The DOM haze runs whatever the map engine is doing, so a console going
    // stale still says so on the plain background and on the fallback plot.
    regionEl.style.setProperty('--haze', t.toFixed(3));
    if (!map || rung >= 3 || typeof map.setSky !== 'function') return;
    const dark = isDark();
    // Low sun, late in the day, over a Himalayan valley. The horizon carries the
    // warm band; the ground fog is cool so it reads as distance, not as smoke.
    const sky = dark
      ? { sky: '#0a1622', horizon: '#2b4256', fog: '#0d1a26' }
      : { sky: '#2f5f92', horizon: '#c9d9e6', fog: '#c2d2df' };
    try {
      map.setSky({
        'sky-color': sky.sky,
        'horizon-color': sky.horizon,
        'fog-color': sky.fog,
        'sky-horizon-blend': 0.62,
        'horizon-fog-blend': +(0.34 + 0.42 * t).toFixed(3),
        'fog-ground-blend': +(0.06 + 0.62 * t).toFixed(3),
        'atmosphere-blend': +(0.72 - 0.22 * t).toFixed(3)
      });
    } catch {
      /* atmosphere is never fatal */
    }
  }

  // ── framing ─────────────────────────────────────────────────────────────
  // The opening shot is computed from the corridor that actually arrived, not
  // from a hard-coded viewport: 32 settlements between 84.80°E and 85.39°E, held
  // at a pitch that makes the relief between them read. A fixed centre and zoom
  // put the cluster off to one side on any pane that was not the pane it was
  // tuned on, which on unknown demo hardware is every pane.
  function frameCorridor({ animate = true, duration = 2600 } = {}) {
    if (!map || rung >= 3) return false;
    const pts = rows.filter(
      (r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon))
    );
    if (pts.length < 2) return false;
    const lats = pts.map((r) => Number(r.lat));
    const lons = pts.map((r) => Number(r.lon));
    const bounds = [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)]
    ];
    const pitch = terrainOn ? CAMERA.pitch : 0;
    const bearing = terrainOn ? CAMERA.bearing : 0;
    // Fit FLAT, then pitch. cameraForBounds under a 54° pitch fits the bounds
    // into the near half of the frustum, which for this corridor pulls the
    // camera back far enough that the DEM's own tile boundary comes into shot —
    // the operator sees the edge of the loaded terrain mesh floating over
    // nothing, which reads as a rendering fault rather than as a map. Fitting at
    // pitch 0 gives the honest "bounds fill the pane" zoom and the geographic
    // centre of the corridor; the pitch is then applied about that centre.
    let cam = null;
    try {
      cam = map.cameraForBounds(bounds, {
        // Room for the map tools top right, and the legend and attribution
        // along the bottom edge.
        padding: { top: 40, bottom: 58, left: 54, right: 54 },
        bearing,
        pitch: 0,
        maxZoom: 10.2
      });
    } catch {
      cam = null;
    }
    if (!cam || !cam.center || !Number.isFinite(cam.zoom)) return false;

    // Pitching the camera compresses the ground plane vertically by cos(pitch)
    // about the centre, so the flat fit leaves exactly log2(1/cos(pitch)) of
    // zoom on the table — 0.77 at 54°. Taking it back is what turns "the
    // corridor is a small cluster somewhere in a wide pane" into "the corridor
    // fills the frame". Derived rather than tuned, so it holds if the pitch
    // changes; the fit is still verified against the real markers below.
    const boost = Math.log2(1 / Math.cos((pitch * Math.PI) / 180));
    restCam = {
      center: cam.center,
      zoom: Math.min(10.2, Math.max(7.4, cam.zoom + (pitch > 0 ? boost : 0))),
      pitch,
      bearing,
      // Sit the corridor a hair above the middle of the pane: the ridgelines
      // above it are where the rim light lives, and they are the whole reason
      // the camera is pitched at all.
      offset: [0, -Math.round(size().h * 0.03)]
    };
    try {
      if (animate && !reducedMotion()) {
        // One slow, decelerating push in. No orbit, no overshoot, no return trip.
        map.easeTo({ ...restCam, duration, easing: (x) => 1 - Math.pow(1 - x, 3) });
      } else {
        map.jumpTo(restCam);
      }
    } catch {
      return false;
    }
    framed = true;
    verifyFraming(animate ? duration + 120 : 60);
    return true;
  }

  // The boost above is derived at the centre of the frame; on an unusual pane
  // aspect it can still push a settlement at the edge of the corridor off the
  // pane. Rather than trusting the arithmetic, check it against the real
  // markers once the camera has settled — this uses MapLibre's own terrain-aware
  // projection — and give the zoom back if it was taken wrongly. One correction,
  // never a loop.
  let verifyTimer = null;
  function verifyFraming(afterMs) {
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      if (destroyed || !map || rung >= 3) return;

      // First: did the move actually happen? A camera animation is driven by
      // animation frames, and a tab that was opened in the background — or a
      // machine under enough load — gets none, so the ease can simply never run
      // and leave the camera at its wide opening position for the rest of the
      // session. The opening shot is not allowed to depend on frames arriving.
      // If nobody has touched the map, put it where it was supposed to end up.
      let animationsRun = true;
      if (!userMoved) {
        try {
          const dz = Math.abs(map.getZoom() - restCam.zoom);
          const dp = Math.abs(map.getPitch() - restCam.pitch);
          if (dz > 0.15 || dp > 2) {
            animationsRun = false;
            map.jumpTo(restCam);
            log(
              'Map framing: the opening move did not run (no animation frames) — the camera was placed directly.'
            );
          }
        } catch {
          /* ignore */
        }
      }

      const { w, h: hh } = size();
      let off = 0;
      for (const m of markers.values()) {
        const p = project(m.row.lon, m.row.lat);
        if (p.x < 8 || p.y < 8 || p.x > w - 8 || p.y > hh - 8) off++;
      }
      if (off <= 1 || restCam.zoom <= 7.4) return;
      restCam = { ...restCam, zoom: Math.max(7.4, restCam.zoom - 0.55) };
      log(
        `Map framing: ${off} settlements fell outside the pane at the fitted zoom — widening once.`
      );
      // If the opening ease never ran, an eased correction will not run either.
      const smooth = animationsRun && !reducedMotion();
      try {
        if (smooth) map.easeTo({ ...restCam, duration: 520 });
        else map.jumpTo(restCam);
      } catch {
        /* ignore */
      }
    }, afterMs);
  }

  function enableTerrain() {
    if (!map) return;
    try {
      // 2.6x, not the usual ~1.5x. The corridor runs from ~600m at Benighat to
      // 7000m+ on the Tibet border, and at the zoom that fits all 32 settlements
      // a realistic profile flattens into a green smear. The exaggeration is what
      // makes it read as the valley these places actually sit in - which is the
      // whole reason a downstream settlement is a neighbour and a village over
      // the ridge is not.
      map.setTerrain({ source: 'terrainDEM', exaggeration: 2.6 });
      terrainOn = true;
      if (rung === 0) banner(null);
      syncHillshade();
    } catch (err) {
      terrainOn = false;
      degrade(1, '3D terrain unavailable — showing flat imagery.');
    }
  }

  // ── capability gate (spec §4.6 performance guard) ───────────────────────
  let webglProbe = null; // probe once, and hand the context straight back
  function hasWebGL() {
    if (webglProbe !== null) return webglProbe;
    try {
      if (typeof WebGL2RenderingContext === 'undefined') {
        webglProbe = false;
        return false;
      }
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
    } catch {
      webglProbe = false;
      return false;
    }
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
  function wants3d() {
    return guard3d() === null;
  }

  // ── init ────────────────────────────────────────────────────────────────
  async function init() {
    status('Loading terrain…');
    slowTimer = setTimeout(
      () => status('Still loading terrain. The list and decisions work without it.'),
      6000
    );

    if (!hasWebGL()) {
      clearTimeout(slowTimer);
      degrade(
        3,
        'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.'
      );
      return;
    }

    try {
      ml = await Promise.race([
        import('./vendor/maplibre-gl.mjs'),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('library load timed out')), LIB_TIMEOUT_MS)
        )
      ]);
    } catch (err) {
      clearTimeout(slowTimer);
      degrade(
        3,
        'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.'
      );
      return;
    }
    if (destroyed) {
      clearTimeout(slowTimer);
      return;
    }

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
        maxBounds: MAX_BOUNDS, // users cannot spin into empty space
        minZoom: 6.8,
        maxZoom: 13, // caps DEM/imagery tile fetches. Never raise it.
        maxPitch: 70,
        dragRotate: true,
        touchPitch: true,
        attributionControl: false,
        antialias: false,
        fadeDuration: 0
      });
    } catch (err) {
      clearTimeout(slowTimer);
      degrade(
        3,
        'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.'
      );
      return;
    }

    map.on('error', (e) => {
      const sid = e && e.sourceId;
      const msg = (e && e.error && e.error.message) || '';
      if (sid === 'terrainDEM' || sid === 'hillshadeDEM') {
        demErrors++;
        if (demErrors >= 4) {
          demFailed = true;
          degrade(
            1,
            '3D terrain unavailable — the elevation tiles are unreachable. Showing flat imagery.'
          );
        }
      } else if (sid === 'satellite' || sid === 'street') {
        satErrors++;
        if (satErrors >= 6)
          degrade(2, 'Basemap tiles unreachable — showing the data layer on a plain background.');
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
        if (document.visibilityState === 'hidden') {
          armWatchdog();
          return;
        }
        let ok = false;
        try {
          ok = map.isStyleLoaded();
        } catch {
          ok = false;
        }
        if (!ok) {
          degrade(
            3,
            'Map engine did not finish starting — showing a coordinate plot. All rankings and decisions still work.'
          );
          return;
        }
        // The style IS loaded and yet `load` has not fired. MapLibre withholds
        // that event until every source for the first viewport has settled, so
        // one tile host that answers slowly — or answers with something the
        // engine will not count — holds it back indefinitely. Left alone, this
        // is the exact failure the operator described as "it just shows a flat
        // grey plane": terrain never switches on, the status line says "still
        // loading" forever, and no banner ever explains why. Start the scene on
        // what has actually arrived instead of on an event that may not come.
        log(
          'Map engine finished its style but never reported "load" — starting the terrain scene on the style instead.'
        );
        onStyleReady();
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
        if (document.visibilityState === 'hidden') {
          armSupplyWatchdog();
          return;
        }
        let done = false;
        try {
          done = map.loaded();
        } catch {
          done = false;
        }
        if (!done && satErrors > 0) {
          degrade(
            2,
            'Basemap tiles are not arriving — showing the data layer on a plain background.'
          );
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
    const onVisible = () => {
      if (document.visibilityState === 'visible' && map && !destroyed) armWatchdog();
    };
    document.addEventListener('visibilitychange', onVisible);
    map.on('load', () => document.removeEventListener('visibilitychange', onVisible));

    // Everything the first paint needs, in one idempotent function: it is called
    // by `load` in the normal case and by the watchdog above when `load` never
    // arrives. Running it twice must be harmless, so it guards itself.
    let sceneStarted = false;
    function onStyleReady() {
      if (destroyed || !map || sceneStarted) return;
      sceneStarted = true;
      clearTimeout(slowTimer);
      clearTimeout(watchdog);
      status(null);
      if (!start3d) {
        hold3d = true;
        banner(
          `3D terrain held back by the hardware guard (${heldBecause}) — flat imagery shown. Press Terrain to turn it on anyway.`
        );
        log(
          `3D terrain held back by the hardware guard: ${heldBecause}. Flat imagery shown; the Terrain button overrides it.`
        );
      } else {
        enableTerrain();
        applyAtmosphere();
      }
      applyBasemap(basemap, true);
      // If the ranking beat the tiles here, frame on it now; otherwise setData
      // does it the moment the corridor arrives.
      if (!frameCorridor({ animate: true }) && start3d && !reducedMotion()) {
        try {
          map.easeTo({ ...CAMERA, duration: 2600, easing: (x) => 1 - Math.pow(1 - x, 3) });
        } catch {
          /* ignore */
        }
      }
      reposition();
      sampleFrames();
    }
    map.on('load', onStyleReady);

    for (const ev of ['move', 'zoom', 'rotate', 'pitch', 'resize', 'render', 'terrain']) {
      map.on(ev, reposition);
    }
    // A camera move carrying an originalEvent came from a hand on the map. From
    // then on the framing corrector keeps its hands off; "Reset view" is how the
    // operator asks for the fitted frame back.
    for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) {
      map.on(ev, (e) => {
        if (e && e.originalEvent) userMoved = true;
      });
    }
    map.on('dataloading', () => {
      tileRequests++;
    });

    const canvas = map.getCanvas ? map.getCanvas() : null;
    if (canvas) {
      canvas.setAttribute('aria-hidden', 'true');
      canvas.setAttribute('tabindex', '-1');
      canvas.addEventListener('webglcontextlost', () => {
        degrade(
          3,
          'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.'
        );
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
      if (dt < 4000) {
        requestAnimationFrame(tick);
        return;
      }
      const mean = dt / Math.max(1, frames);
      // Too few frames means the page was not being painted at all (hidden pane,
      // suspended compositor). That is unknown, not slow — do not punish it.
      if (frames < 24) return; // the page was not being painted: unknown, not slow
      // Two thresholds, cheapest thing first. Between 22 and 25fps the scene is
      // holding but the soft effects are not free, so they go before the terrain
      // does — every one of them has a static form that still says the same thing.
      if (mean > 40 && terrainOn) {
        degrade(
          1,
          `3D terrain dropped — this device rendered at ${(1000 / mean).toFixed(0)}fps. Showing flat imagery.`
        );
        setFx('lite', `${(1000 / mean).toFixed(0)}fps`);
      } else if (mean > 26) {
        setFx(
          'lite',
          `${(1000 / mean).toFixed(0)}fps — rings, void and corridor pulses are now static`
        );
      }
    };
    requestAnimationFrame(tick);
  }

  // ── public API ──────────────────────────────────────────────────────────
  const api = {
    setData(nextRows, nextAdjacency) {
      rows = Array.isArray(nextRows) ? nextRows.filter((r) => r && r.settlementId) : [];
      if (nextAdjacency) adjacency = nextAdjacency;
      const formed = detectClusterFormation(rows);
      recomputeFallbackExtent();
      buildMarkers();
      status(rows.length ? null : 'No settlements plotted yet.');
      let styled = false;
      try {
        styled = !!(map && map.isStyleLoaded());
      } catch {
        styled = false;
      }
      if (!framed && styled) frameCorridor({ animate: true });
      // After the markers and edges exist, and only for a real classification
      // change the server just made.
      for (const id of formed) pulseInto(id);
    },

    /**
     * Hours since the last COMPLETE pipeline pass. Drives the fog, and only the
     * fog: nothing about the ranking or the data layer changes with it.
     */
    setStaleness(hours) {
      const n = Number(hours);
      const next = Number.isFinite(n) && n >= 0 ? n : 0;
      if (Math.abs(next - staleHours) < 0.02) return;
      staleHours = next;
      applyAtmosphere();
    },

    /** The theme flipped; the sky belongs to the theme. */
    refreshAtmosphere() {
      applyAtmosphere();
    },

    /** Debug/demo handle: fire the corridor propagation pulse into one node. */
    demoPulse(id) {
      pulseInto(id);
    },
    setAdjacency(a) {
      adjacency = a || {};
      buildLines();
      reposition();
    },
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
      // A pending framing correction would otherwise yank the camera back off
      // the settlement the operator just asked to look at.
      clearTimeout(verifyTimer);
      const target = { center: [m.row.lon, m.row.lat], zoom: Math.max(map.getZoom(), 10.2) };
      try {
        map.easeTo({ ...target, duration: reducedMotion() ? 0 : 900 });
      } catch {
        /* ignore */
      }
    },
    hover(id, on) {
      const m = markers.get(id);
      if (m) m.btn.classList.toggle('hov', !!on);
    },
    resetView() {
      hideTip();
      // An explicit request for the fitted frame, so the corrector is welcome
      // again even if the operator has been driving the camera by hand.
      userMoved = false;
      if (map && rung < 3) {
        // Re-fit rather than jumping to a stored camera: the pane may have been
        // resized, and the corridor is what the operator asked to see again.
        if (!frameCorridor({ animate: true, duration: 780 })) {
          try {
            map.easeTo({
              ...restCam,
              pitch: terrainOn ? restCam.pitch : 0,
              bearing: terrainOn ? restCam.bearing : 0,
              duration: reducedMotion() ? 0 : 700
            });
          } catch {
            /* ignore */
          }
        }
      }
      reposition();
    },
    setBasemap(kind) {
      applyBasemap(kind);
    },
    resize() {
      if (map) {
        try {
          map.resize();
        } catch {
          /* ignore */
        }
      }
      reposition();
    },
    reposition,
    get rung() {
      return rung;
    },
    get engine() {
      return map;
    }, // debug handle, also handy live: window.signalZeroMap.engine
    get terrainOn() {
      return terrainOn;
    },
    destroy() {
      destroyed = true;
      if (map) {
        try {
          map.remove();
        } catch {
          /* ignore */
        }
      }
    }
  };

  // Draw the overlay immediately with the fallback projector, then let MapLibre
  // take over. First paint never waits on the network.
  window.addEventListener('resize', () => api.resize());
  init().catch((err) => {
    degrade(
      3,
      'Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.'
    );
    log(`Map init threw: ${err && err.message}`);
  });

  try {
    window.signalZeroMap = api;
  } catch {
    /* ignore */
  }
  return api;
}
