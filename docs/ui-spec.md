# Signal Zero — UI Specification v2

**Status:** buildable spec. Another agent implements from this file.
**Target:** ONE single-page console at `http://localhost:3000/`. No second surface. No separate demo
site. No marketing page. The console *is* the demo.
**Stack constraint:** vanilla JS + CSS, no build step. Files: `web/index.html`, `web/styles.css`,
`web/app.js`. MapLibre GL v6.6.0 vendored to `web/vendor/maplibre-gl.js` + `web/vendor/maplibre-gl.css`.

**Judging criterion this is built against:**
> "An interface that shows what the agent is doing, what it is waiting on, and what it did, and asks
> before the irreversible step rather than after it."

Section 3 maps each of those three to a specific screen element. Section 5 is the ask-before step.

---

## 0. Data contract (verified against source, do not re-derive)

### 0.1 Endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/health` | `{ ok, lastRunAt }` |
| `GET` | `/api/state` | `{ settlements[], checkpoint[], incidents[], sources[], stats }` |
| `POST` | `/api/run` | `{ ok, reportCount, clusterCount, durationMs }` — **409** `{ ok:false, error }` if a pass is already running |
| `GET` | `/api/settlement/:id` | `{ ok, settlement, ranked, reports[], clusters[], neighbors[], checkpoint[], scoreBreakdown }` — **404** if unknown |
| `POST` | `/api/checkpoint/:id/approve` | body `{ approvedBy }` → `{ ok, item, shortlist[] }` |
| `POST` | `/api/checkpoint/:id/reject` | body `{ approvedBy }` → `{ ok, item, shortlist: [] }` |
| `POST` | `/api/demo/fail/:kind` | `kind` ∈ `source` \| `ambiguous` \| `coldstart` |

`/api/settlement/:id` takes the **gazetteer id** (`settlement.id` / `ranked.settlementId`), e.g.
`np-dhading-benighat`.

### 0.2 Field enums the UI must handle exhaustively

- `coverageBasis`: `"reports"` \| `"cohort-cold-start"`
- `fitBasis`: `"cohort"` \| `"global"` \| `"prior"`
- `anomalyType`: `"solo-anomaly"` \| `"regional-outage"` \| `"silent-cluster"` \| `"cluster-edge"` \| `"none"`
- `checkpoint[].kind`: `"escalation"` \| `"ambiguous-match"`
- `checkpoint[].status`: `"pending"` \| `"approved"` \| `"rejected"`
- `incidents[].kind`: `"degraded-source"` \| `"llm-fallback"` \| `"cold-start"` \| `"heal"`
- `sources[].status`: `"live"` \| `"degraded"` \| `"down"` \| `"ok"` \| `"unknown"`
- `sources[].sourceType`: `"news"` \| `"official"` \| `"social"`
- `reports[].triage.tier`: `1` \| `2` \| `3`
- `reports[].triage.category`: `"corroboration-candidate"` \| `"new-settlement"` \| `"hazard-signal"` \| `"noise"`

### 0.3 Checkpoint error codes → UI response

| HTTP | `code` | UI does |
|---|---|---|
| 400 | `APPROVER_REQUIRED` | Inline error under the name field. Field gets `aria-invalid="true"`, focus moves to it. Modal stays open. |
| 404 | `NOT_FOUND` | Toast + full `/api/state` refetch. Modal closes. |
| 409 | `ALREADY_DECIDED` | Inline banner in the modal, both buttons disabled, refetch, advance to next pending item. |
| 400 | `DISPATCH_FIELD_FORBIDDEN` | Should never surface. If it does, render as a `critical` incident row — it means a rule-1 violation was attempted. |

### 0.4 Real data shape at demo time (drives every default)

32 settlements. **8 have reports** (Timure 13, Trishuli Bazar 9, Bidur 3, Nilkantha 2, Betrawati 2,
Dhunche 1, Galchhi 1, Meghang 1). **24 have zero reports and `silenceHours ≈ 96`, with
`coverageBasis: "cohort-cold-start"`.**

**Design consequence — this is the whole product:** three quarters of the map is "no data reached
us". The UI must make that legible and *honest* at a glance. The 24 are not decoration and they are
not confirmed silence. See §6.

---

## 1. Layout

### 1.1 Region inventory

| id | Region | Answers |
|---|---|---|
| **A** | Command Bar | doing / global controls |
| **B** | Silence Rank (ranked settlement list) | the ranking |
| **C** | Terrain Map (dominant) | where |
| **D** | Evidence Panel (detail) | why — every number traceable |
| **E** | Human Checkpoint Queue | waiting on / did |
| **F** | Activity & Incident Feed | doing / did |
| **G** | Source Health Strip | what is feeding us |
| **H** | Checkpoint Bar (persistent, fixed) | waiting on |

### 1.2 Grid — desktop `≥1600px`

```
┌───────────────────────────────────────────────────────────────────────────┐
│ A  COMMAND BAR                                                      56px  │
├──────────────┬──────────────────────────────────────┬─────────────────────┤
│              │  C  TERRAIN MAP                      │  E  CHECKPOINT      │
│  B  SILENCE  │     (dominant)                       │     QUEUE           │
│     RANK     │     minmax(340px, 1fr)               │     minmax(280px,1fr)│
│              │                                      ├─────────────────────┤
│   360px      ├──────────────────────────────────────┤  F  ACTIVITY &      │
│              │  D  EVIDENCE PANEL          300px    │     INCIDENTS       │
│              │                                      │     minmax(240px,1fr)│
├──────────────┴──────────────────────────────────────┴─────────────────────┤
│ G  SOURCE HEALTH STRIP                                              44px  │
├───────────────────────────────────────────────────────────────────────────┤
│ H  CHECKPOINT BAR (position: fixed, bottom: 0)                      52px  │
└───────────────────────────────────────────────────────────────────────────┘
```

```css
body {
  display: grid;
  grid-template-rows: 56px 1fr 44px;
  height: 100dvh;
  padding-bottom: 52px;          /* reserve for the fixed checkpoint bar */
  overflow: hidden;
}
.console {                        /* row 2 */
  display: grid;
  grid-template-columns: var(--col-left) minmax(340px, 1fr) var(--col-right);
  gap: 1px;                       /* hairline via background: var(--line) */
  background: var(--line);
  min-height: 0;
}
.col-center { display: grid; grid-template-rows: minmax(320px, 1fr) var(--evidence-h); min-height: 0; }
.col-right  { display: grid; grid-template-rows: minmax(280px, 1fr) minmax(240px, 1fr); min-height: 0; }
```

Tokens: `--col-left: 360px; --col-right: 420px; --evidence-h: 300px;`

**Every region scrolls internally.** `body` never scrolls. Each scrollable region gets
`min-height: 0; overflow-y: auto; overscroll-behavior: contain;` and a sticky header
(`position: sticky; top: 0; z-index: 2; background: var(--panel);`).

### 1.3 Proportions at 1600×900 (the number that matters)

- Map: **~700 × 500px** = 39% of console area. Dominant single element. ✔
- Rank list: 360 × 800.
- Evidence: 700 × 300.
- Checkpoint queue: 420 × ~410. Activity: 420 × ~390.

At 1920×1080 the map is ~1080 × 660 (48%). The map must always be the largest single region on
any viewport ≥1024px wide.

### 1.4 Responsive breakpoints

| Width | Behaviour |
|---|---|
| **≥1600** | As above. `--col-left: 360px; --col-right: 420px;` |
| **1280–1599** | `--col-left: 320px; --col-right: 380px; --evidence-h: 260px;` Rank list drops the `Corr` column. |
| **1024–1279** | `--col-left: 280px; --col-right: 344px;` **Evidence Panel collapses** out of the grid and becomes a slide-over sheet over the map (`right: 0; width: min(520px, 60%); height: 100%;` with a scrim at 40% opacity). `--evidence-h: 0`. Source strip hides its `lastFetchAt` timestamps. |
| **768–1023 (tablet)** | Two rows. Map full width, `height: 46dvh`. Below it, a **tab bar** with 5 tabs: `Rank · Evidence · Checkpoint · Activity · Sources`. Checkpoint tab carries a count badge. Source strip G is absorbed into the Sources tab; the Command Bar keeps an aggregate pill (`4/5 sources live`). |
| **<768 (phone)** | Single column. Map `height: 34dvh`, terrain forced off (see §4.6). Same tab bar, horizontally scrollable. Rank rows drop to two lines. |

**Never collapsed at any width:** region **H** (checkpoint bar) and the pending count in the command
bar. If a decision is waiting, it is visible on a 360px phone.

**Tab bar rules (≤1023px):** `role="tablist"`, arrow-key navigation, `aria-selected`, panels get
`role="tabpanel"` + `tabindex="0"`. Selecting a settlement anywhere auto-switches to the Evidence
tab. A new pending checkpoint auto-switches to nothing (never steal focus) but pulses the tab badge
once — respecting `prefers-reduced-motion` (§8.4).

---

## 2. Region specs

### 2.A Command Bar — 56px

Left → right, single flex row, `gap: 20px`, `padding: 0 16px`:

1. **Brand**: 28px mark + `SIGNAL ZERO` in Space Grotesk 600 / 17px / `letter-spacing: .06em`.
   Sub-line 11px `--ink-3`: `Ranking by silence, not by volume`.
2. **Scenario chip**: `Trishuli GLOF · Rasuwa / Nuwakot / Dhading · 26 Aug 2026`, 11px mono,
   `--panel-2` background.
3. **Pipeline Stage Rail** — see §3.1. `flex: 1`, `min-width: 260px`.
4. **Stat cluster** — 3 stats, mono 15px value over 10px uppercase label:
   `reports` (`stats.reportCount`) · `clusters` (`stats.clusterCount`) · `last run`
   (relative, e.g. `42s ago`; title attr = full ISO).
5. **`Run pipeline`** primary button (§3.1).
6. **Theme toggle** — 3-state segmented control `Auto · Light · Dark`, persists to
   `localStorage['sz-theme']`, wrapped in try/catch.
7. **`Demo` menu** — a `<details>` disclosure (not a hover menu; hover menus die on tablets)
   containing the three failure injectors: `Break a source`, `Force ambiguous match`,
   `Force cold-start`. Each posts to `/api/demo/fail/:kind`. The disclosure summary is labeled
   `Demo failures` and is visually marked with a dashed border so a judge can tell simulated
   failures from real ones.

At `<1280px` the stat cluster drops `clusters`. At `<1024px` brand sub-line hides. At `<768px` the
stage rail becomes a single 4px progress line under the bar plus a text label.

### 2.B Silence Rank — left column

Sticky header: `Silence Rank` (Space Grotesk 600/14) + count pill + a filter row.

**Filter row** (32px, three segmented toggles, all default OFF except the first):
- `All (32)` / `Anomalies (n)` / `No data (24)` — mutually exclusive.
- A text input `Filter settlements…` (matches name + district, case-insensitive).

**Table columns** (`<table>` with `role` intact — screen readers get real semantics):

| Col | Width | Content | Notes |
|---|---|---|---|
| `#` | 32px | `rank` | mono 12px |
| Settlement | 1fr | `name` (14px, 550) over `district` (11px `--ink-3`) | |
| Silent | 62px | `silenceHours` → `96h` / `13.4h` | mono; right-aligned; **cell background = silence ramp stop at 14% opacity**, left border 3px solid at the full ramp stop |
| Gi* z | 54px | `giZScore` to 2dp | mono; `--warn` if >1.96 |
| Corr | 40px | `corroborationCount` | mono; `—` when 0 |

**Row badges** (right of the settlement name, 10px, max 2 shown):
- `anomalyType` glyph + short label (§4.4 table).
- `coverageBasis === "cohort-cold-start"` → the **No-data chip** (§6.2). Always shown, never truncated.

**Row states**: hover `--panel-2`; selected `--panel-2` + 3px `--accent` left inset border +
`aria-selected="true"`; keyboard focus per §8.1.

**Interaction**: row is a `<tr tabindex="0" role="button">`; `Enter`/`Space`/click →
selects settlement (loads Evidence Panel D, flies the map to it, §4.5). Arrow Up/Down move
selection through rows. `Home`/`End` jump to first/last.

**Sorting**: clicking a column header sorts; header is a `<button>` with `aria-sort` set to
`ascending`/`descending`/`none`. Default sort = `rank` ascending (i.e. server order — do not re-sort
client-side by default; the server order is the audit-stable one and the tooltip on `#` says so:
`Server rank: Gi* desc, then surprisal, then population, then id. Deterministic.`).

### 2.C Terrain Map — see §4 (full spec)

### 2.D Evidence Panel — 300px, center column bottom

Header: `EVIDENCE · {name}, {district}` + `coverageBasis` chip + close/collapse button.

Content is a 2-column grid (`grid-template-columns: 1fr 1fr; gap: 16px;`), collapsing to 1 column
below 900px of panel width. Four blocks, in this order:

1. **What we observed**
   `lastReportAt` (or `Never — no report has ever resolved here`), `silenceHours`,
   `reportCount`, `corroborationCount`, `population`, `hazardTier`, `neighborCount`.
2. **How the number was reached** — from `scoreBreakdown`. Render as a labelled equation, mono:
   ```
   λ  = 1 / expectedGapHours = 0.01042 /h        fitBasis: cohort (t3|small, 7 gaps)
   P(gap ≥ 96.0h) = exp(−λ·t) = 0.367            survivalProbability
   surprisal      = −ln P = λ·t = 1.000          surprisalFormula
   Gi* z          = 2.868   (threshold 1.96)     ownZ 3.11 · neighborZ 0.42 · n=3
   ```
   Under it, verbatim from `scoreBreakdown.method`, in 11px `--ink-2`, prefixed with the label
   `Method`. Below that a fixed line in `--ok`:
   `Deterministic. No LLM touched these numbers.`
3. **What we do not know** — §6. Mandatory block. Never empty; when everything is well-grounded it
   still renders: `Silence here means no report reached us. It is not a confirmation that this place
   is quiet.`
4. **Reports behind this** — list from `/api/settlement/:id` `reports[]`. Each row:
   `sourceName` · `sourceType` chip · triage tier badge (`T1`/`T2`/`T3`) · `triage.category` ·
   `publishedAt` relative · title as an external link (`rel="noopener noreferrer"`, opens new tab).
   `triage.matchedOn` shown as 11px mono under the title.
   **T3 rows get a `--warn` left border and the tooltip** `Tier 3 — LLM fallback classification.
   Reaching this tier is itself a failure signal.`
   Below the list: `Clusters` — for each cluster, `id`, `confidence` to 2dp,
   `sourceTypeDiversity`, member count. A cluster with `confidence === 0.5` and one member renders
   the literal note `Singleton — uncorroborated, not "confidently one event".`

Also render **Corridor neighbours** as a horizontal chip row from `neighbors[]`; each chip is
clickable and selects that settlement. This is the only place adjacency is enumerated in text.

### 2.E Human Checkpoint Queue — right column top

This region is the reason the project exists. It is styled one tier louder than everything else.

Header: `HUMAN CHECKPOINT` (Space Grotesk 600/13, `letter-spacing: .08em`) + pending count in a
`--warn` pill. Header background is `--panel-2` with a 2px `--warn` bottom border **when
`pendingCount > 0`**, and `--line` when zero.

Two stacked sub-lists with sticky sub-headers:

**`Waiting on a human — {n}`** (pending items, newest first). Each card:
- Kind glyph + label: `▲ ESCALATION` (`--warn`) or `◆ AMBIGUOUS MATCH` (`--accent`).
- `title` — 13px/1.35, 2-line clamp.
- Meta line, 11px mono: `{settlementId ?? '—'} · raised {relative}`.
- Full-width button: `Review & decide →`. Opens the modal (§5) at that item.
- The card itself is **not** a click target — only the button is. A misclick must never open a
  decision dialog.

**`Decided — {n}`** (approved + rejected, most recent first, collapsed to 5 with a
`Show all {n}` button). Each row, 12px:
`✓ Approved by {approvedBy}` (`--ok`) or `✕ Rejected by {approvedBy}` (`--ink-2`), then title
(1-line clamp), then `{decidedAt}` relative. Clicking re-opens the item in the modal in
**read-only mode** (§5.7).

### 2.F Activity & Incident Feed — right column bottom

One merged, reverse-chronological stream. Two sources:
1. Server `incidents[]`.
2. Client-side pipeline events the UI itself observed (run started, run finished, stage
   transitions, fetch failures, decisions posted).

Client events get a 10px `LOCAL` tag so a judge can tell which came from the server.

Header: `ACTIVITY` + a filter chip row: `All` · `Incidents` · `Decisions` · `Pipeline`.
`aria-live="polite"`, `aria-relevant="additions"` on the list. **Only the 3 most recent additions
are announced**; batch older ones (implement by moving items out of the live region after 4s) so a
52-item refresh does not machine-gun a screen reader.

Row: `[time mono 11px] [kind glyph] [message] [detail toggle]`. Detail toggle expands the raw
`detail` object as a `<pre>` with 11px mono, `--panel-2` background. Nothing is hidden from the
judge.

| `incidents[].kind` | Glyph | Colour token | Label |
|---|---|---|---|
| `degraded-source` | `▲` | `--warn` | `SOURCE DEGRADED` |
| `llm-fallback` | `◆` | `--accent` | `LLM FALLBACK` |
| `cold-start` | `◌` | `--nodata` | `COLD START` |
| `heal` | `●` | `--ok` | `RECOVERED` |

An incident whose `detail.simulated === true` gets an extra dashed-border `SIMULATED` chip. Do not
let a demo injection be mistaken for a real failure.

### 2.G Source Health Strip — 44px full-width footer

`SOURCES` label, then one chip per `sources[]` entry, then a right-aligned aggregate
`{live}/{total} live · last fetch {relative}`.

Chip: `[status dot] {name} · {sourceType}`, 11px, `--panel-2` background, 1px border in the status
colour. `title` = `last fetch {ISO}`.

| status | dot glyph | colour | chip border |
|---|---|---|---|
| `live` / `ok` | `●` | `--ok` | `--ok` at 45% |
| `degraded` | `▲` | `--warn` | `--warn` |
| `down` | `■` | `--critical` | `--critical` |
| `unknown` | `◌` | `--ink-3` | `--line` |

Glyph + text always accompany the colour (§7.5). The strip scrolls horizontally on overflow with
`scroll-snap-type: x proximity`.

### 2.H Checkpoint Bar — fixed, 52px, always present

`position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;` Full width. Present at **all**
viewport widths and in **both** states so the layout never reflows mid-demo.

**Pending state** (`pendingCount > 0`) — background `--warn-bg`, top border 2px `--warn`:
> **{n} decisions waiting on a named human.**  Nothing in Signal Zero becomes actionable until
> someone signs for it.        `[ Review queue → ]`

**Clear state** (`pendingCount === 0`) — background `--panel`, top border 1px `--line`:
> No decisions pending. Everything raised so far has been signed for.

The bar has **no close button**. It cannot be dismissed, minimised, or scrolled away.

---

## 3. The three things the criterion names

### 3.1 What the agent is DOING → Pipeline Stage Rail (region A)

Six segments, fixed order, matching `runPipeline()` in `src/server.js`:

| # | id | Label | Sub-label while active |
|---|---|---|---|
| 1 | `ingest` | `Ingest` | `Fetching connectors` |
| 2 | `triage` | `Triage` | `Tier 1 → 2 → 3 cascade` |
| 3 | `dedup` | `Dedup` | `Fellegi–Sunter, deterministic` |
| 4 | `rank` | `Rank` | `Exponential TBE + Getis-Ord Gi*` |
| 5 | `checkpoint` | `Checkpoint` | `Raising escalations` |
| 6 | `ready` | `Ready` | `Awaiting human decisions` |

Rendering: 6 pill segments, `height: 22px`, joined by 8px connectors.

- **done**: filled `--ok` at 22% with a `--ok` 1px border, `✓` glyph, label `--ink-2`.
- **active**: filled `--accent` at 18%, 1px `--accent` border, label `--ink` 600, plus a 2px
  indeterminate sweep bar along the segment's bottom edge (1.4s linear, `--accent`).
- **pending**: `--panel-2`, `--line` border, label `--ink-3`.
- **failed**: `--critical` at 18%, `--critical` border, `▲` glyph. A stage that threw is marked
  failed but the rail continues — matching the server's "a stage that throws never kills the run".

The rail's `aria-label` is `Pipeline progress`, and it contains a visually-hidden
`aria-live="polite"` element that announces exactly one string per transition:
`Stage 3 of 6: Dedup.`

**Honesty rule for progress — non-negotiable.** `POST /api/run` is a single blocking call that
returns only at the end; it does not stream stage boundaries. Therefore:

- **If** the backend exposes stage progress (an SSE endpoint `GET /api/run/stream` emitting
  `{stage, status}`, or `stats.currentStage` in `/api/state`) → drive the rail from it.
- **If it does not** → the UI shows exactly two states: all six segments in a `running` style with
  the shared sub-label **`Running — per-stage detail not reported by the server`**, and an elapsed
  timer (`00:12`). Then, on response, all six flip to `done` (or to `failed` for any stage that
  produced a `degraded-source` incident during this run window).
- **The UI must never animate a fake stage-by-stage march on a timer.** A judge who reads the code
  will find it. A dashboard that lies about its own progress fails the criterion it is competing on.

Recommended (small, safe) backend hook so the honest path is the rich one — set
`store.stats.currentStage = <id>` at the top of each stage block in `runPipeline()` and clear it in
the `finally`. The UI then polls `/api/state` at **1200ms** while a run is in flight. This is the
preferred implementation; the degraded copy above is the fallback if the hook is not added.

**`Run pipeline` button states:**

| State | Label | Notes |
|---|---|---|
| idle | `Run pipeline` | enabled |
| in flight | `Running… 00:12` | `aria-busy="true"`, `disabled`, spinner (static dot under reduced-motion) |
| 409 conflict | toast: `A pipeline pass is already running.` | button switches to in-flight state and starts polling |
| error | `Run pipeline` + `--critical` toast with the message | re-enabled |

### 3.2 What the agent is WAITING ON → regions E + H

Three redundant, always-visible surfaces so it cannot be missed in a noisy room:

1. **Region H** — fixed bottom bar, undismissable, states the count and the rule.
2. **Region E** — the `Waiting on a human` list with full evidence per item.
3. **Command bar** — the pending count appears as a `--warn` pill next to the stage rail whenever
   `pendingCount > 0`: `⏸ 8 waiting`. Clicking it scrolls region E into view and focuses the first
   pending card's `Review & decide` button.

Additionally, every settlement that has a **pending** checkpoint item gets a `⏸` marker overlay on
the map (§4.4) and a `⏸` badge in the rank list. The link between "a place on the map" and "a
decision a human owes" is drawn everywhere.

### 3.3 What the agent DID → regions E (Decided) + F

- **Decided list** (E): approver name, decision, timestamp, and re-openable read-only evidence.
  The approver's name is never abbreviated and never hidden behind a tooltip.
- **Activity feed** (F): the server writes a `heal` incident on every decision
  (`Approved by {name}: {title}`), so decisions land in the feed automatically. The UI renders those
  with the `Decisions` filter chip.
- **Shortlist result**: after an approve, the released shortlist is shown inline in the modal's
  success state (§5.6) *and* appended to the Evidence Panel for that settlement under the heading
  `Released to inform — approved by {name}`.

---

## 4. The map (region C)

### 4.1 Library and loading

MapLibre GL **v6.6.0**, BSD-3-Clause. **Vendored locally** at `web/vendor/maplibre-gl.js` and
`web/vendor/maplibre-gl.css`. No CDN in the load path — venue wifi is assumed hostile.

Attribution (required, rendered in the map's bottom-right control, 10px):
`© Esri, Maxar, Earthstar Geographics · © OpenStreetMap contributors · Elevation: Mapzen/AWS Terrain Tiles`

### 4.2 Sources (all key-free, all verified 200)

```js
sources: {
  terrainDEM: {
    type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png']
  },
  satellite: {
    type: 'raster', tileSize: 256, maxzoom: 17,
    // NOTE: {z}/{y}/{x} — y BEFORE x. Not OSM order.
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}']
  },
  street: {
    type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png']
  }
}
```

Terrain: `map.setTerrain({ source: 'terrainDEM', exaggeration: 1.5 })`.
Hillshade layer from the same DEM below the imagery at `raster-opacity: 0.55` when the street
basemap is active, so relief reads even without imagery.

**Basemap toggle** (3 buttons, top-right of map): `Terrain` (satellite + hillshade + 3D, default) ·
`Street` (OSM + hillshade) · `Plain` (no tiles, `--map-void` background + markers only).
`Plain` is the guaranteed-working mode and is what the auto-fallback selects.

**Human features minimised**: on the `Street` basemap, apply
`raster-saturation: -0.55, raster-brightness-min: 0.15, raster-contrast: 0.1` so roads and labels
recede and the data layer dominates. On `Terrain`, `raster-saturation: -0.3`.

### 4.3 Default camera — frame the story on load

```js
{ center: [85.05, 27.99], zoom: 8.7, pitch: 52, bearing: 18,
  maxPitch: 70, minZoom: 6.8, maxZoom: 13,
  maxBounds: [[84.20, 27.35], [86.05, 28.62]],   // users cannot spin into space
  dragRotate: true, touchPitch: true }
```

That frame contains the entire Trishuli/Bhote Koshi corridor from Timure (28.216, 85.383) to
Benighat (27.8, 84.8) with margin. On first load only, after `map.on('load')` and after markers
render, run `map.easeTo` a 1400ms settle from `zoom: 8.2, pitch: 30` to the frame above — one
gentle establishing move, **skipped entirely under `prefers-reduced-motion`**.

**`Reset view` button** (top-right, keyboard-reachable) returns to exactly this camera. It must be
one keystroke away at all times — a lost camera during a demo is a dead demo.

### 4.4 Data encoding

Two GeoJSON sources built from `/api/state` `settlements[]`:
`sz-settlements` (points) and `sz-corridor` (LineStrings from `src/data/corridor.json`, drawn
client-side by joining each id's coordinates to its neighbours' — dedupe by sorted pair key).

**Corridor lines**: 1.5px, `--corridor` at 55% opacity, below the points. Purpose: show the
adjacency graph Gi* actually runs on. Legend entry: `river-corridor adjacency (the Gi* graph)`.

**Point fill — SEQUENTIAL, magnitude = `silenceHours`** (§7.3 ramp). Six discrete stops, not a
continuous interpolation — discrete stops are readable at a glance from across a room and survive
projector colour crush.

| stop | `silenceHours` band |
|---|---|
| `SIL-0` | `0 – 6` |
| `SIL-1` | `6 – 18` |
| `SIL-2` | `18 – 36` |
| `SIL-3` | `36 – 60` |
| `SIL-4` | `60 – 84` |
| `SIL-5` | `≥ 84` |

**Point radius — population** (secondary, never the primary read):
`r = clamp(5 + 16 * Math.sqrt(population / 25000), 5, 22)` px. Benighat (6870) → 13.4px;
Timure (1240) → 8.6px.

**Ring — QUALITATIVE, `anomalyType`, encoded by SHAPE not hue** (this is what keeps it CVD-safe;
the fill already owns hue):

| `anomalyType` | Ring | Glyph used in lists | Label |
|---|---|---|---|
| `solo-anomaly` | double ring, 3px + 1px, solid, 2px gap | `◆` | `Solo anomaly — this place is dark, its neighbours are not` |
| `regional-outage` | 3px solid ring + 10px soft outer halo at 30% | `▮` | `Regional outage — it and its neighbours are all silent` |
| `silent-cluster` | 2.5px dashed ring, dash 4 / gap 3 | `◈` | `Silent cluster — inside a significant quiet stretch` |
| `cluster-edge` | 2px dotted ring, dash 1 / gap 3, 60% opacity | `◇` | `Cluster edge — its neighbours went quiet, it did not` |
| `none` | no ring | `·` | — |

Ring colour is a single high-contrast neutral: `--ring` (`#FFFFFF` at 90% in dark, `#0B0F14` at 85%
in light). One hue, five shapes.

**Cold-start overlay — `coverageBasis === "cohort-cold-start"`:** a 45° hatch pattern
(2px stroke, 6px pitch, `--nodata` at 30%) composited over the fill, plus a 1.5px dashed outer
stroke in `--nodata`, dash 3 / gap 3. The fill still carries the silence ramp — the silence duration
*is* real — but the hatch says the basis is borrowed. Legend copy:
`hatched = no report has ever reached us (cold start)`.

**Pending checkpoint overlay:** a 14px `⏸` badge pinned to the marker's top-right in `--warn` with a
1px `--panel` outline.

**Labels — halo mandatory** (imagery basemap): `text-halo-color` `rgba(6,10,14,.88)` in dark /
`rgba(255,255,255,.92)` in light, `text-halo-width: 1.6`, `text-halo-blur: 0.4`.
Text colour flips with the fill stop so it stays legible: stops `SIL-0..SIL-2` → `#FFFFFF`;
stops `SIL-3..SIL-5` → `#0B0F14`.

**Label size is driven by feature importance** (`rank`), per the cartography rule:

| rank | size / weight | visible from zoom |
|---|---|---|
| 1–3 | 13px / 600, `{name}` + a second line `{silenceHours|0}h` | always |
| 4–10 | 12px / 500, `{name}` | ≥ 8.0 |
| 11+ | 11px / 400, `{name}` | ≥ 9.5 |

`text-allow-overlap: false`, `symbol-sort-key: rank` so the top of the list always wins collisions.

**Legend** — bottom-left of the map, `<details open>` so it can be folded on small screens.
Contains: the 6-stop ramp with `0h` and `96h+` end labels and the caption
`silence duration — how long since a report resolved here`; the 5 ring shapes; the hatch swatch;
the size key; the corridor line; and a one-line footer in `--ink-2`:
**`Silence = no report reached us. Not a confirmation that a place is quiet.`**

### 4.5 Map ↔ list ↔ evidence linkage

- Click / `Enter` on a marker → same as clicking its rank row.
- Selecting a settlement anywhere: rank row gets `aria-selected`, map marker gets a 3px `--accent`
  selection ring, evidence panel loads, and the map `easeTo({ center, zoom: max(current, 10.2),
  duration: 900 })` — `duration: 0` under reduced motion.
- Hover on a rank row → marker gets a `--accent` 2px ring at 60%. Hover on a marker → rank row
  highlights and, if off-screen, `scrollIntoView({ block: 'nearest' })`. No animation on that
  scroll under reduced motion.
- Marker hover tooltip (250ms delay): name, district, `{silenceHours|1}h silent`, `Gi* z {…}`,
  and the coverageBasis line. **Tooltips are never the only way to reach information** — everything
  in them also exists in the evidence panel.

Markers must be keyboard reachable: render the point layer for painting, and a parallel set of
absolutely-positioned invisible 24×24 `<button>` elements (repositioned on `map.on('move')`,
throttled with `requestAnimationFrame`) for focus, `Tab` order by `rank`. Each carries
`aria-label="{name}, {district}. {hours} hours silent. Rank {rank} of 32."`

### 4.6 Degradation ladder — a blank screen at judging is a total loss

Implement as an explicit ordered ladder. Each rung logs a `LOCAL` activity event so the judge sees
the system narrate its own degradation.

| Rung | Trigger | Result |
|---|---|---|
| 0 | Everything works | Terrain + satellite + 3D + markers |
| 1 | DEM tiles 4xx/5xx, or `setTerrain` throws | Drop terrain, keep satellite 2D. Banner: `3D terrain unavailable — showing flat imagery.` |
| 2 | Imagery tiles fail (≥50% of first 12 tile requests error) | Switch to `Plain` basemap. Banner: `Basemap tiles unreachable — showing the data layer on a plain background.` |
| 3 | No WebGL, WebGL context lost, or `maplibregl` undefined **6000ms** after DOM ready | **2D Fallback Grid** (below). Banner: `Map engine unavailable — showing a coordinate plot. All rankings and decisions still work.` |
| 4 | `/api/state` unreachable | Offline banner + last-known state, retry every 4s with backoff to 15s. Every region shows its stale state (§6.4). |

**2D Fallback Grid** — a pure-SVG scatter in the same container. No library. Linear projection of
the corridor bbox `lon [84.20, 86.05] → x`, `lat [27.35, 28.62] → y (inverted)`, `preserveAspectRatio="xMidYMid meet"`, `viewBox="0 0 1000 700"`. Same fill ramp, same radius formula, same ring
shapes, same labels for ranks 1–10, plus the corridor lines. It is a real map — just not a
geographic one — and it is fully clickable and keyboard-navigable. Build this **first**, before the
MapLibre integration, and make MapLibre the enhancement.

**Performance guard (unknown conference-room hardware):**
- Start in 3D only if `WebGL2RenderingContext` exists **and** `navigator.hardwareConcurrency >= 4`
  **and** viewport width ≥ 1024. Otherwise start at rung 1 (flat) with the `Terrain` button still
  available and enabled.
- Sample frame time via `requestAnimationFrame` for the first 4s after load. If the mean is >40ms
  (<25fps), auto-drop to rung 1 and log it.
- 32 markers is the entire dataset; there is nothing to stream at this size. Do **not** load or
  render report-level geometry on the map. If the gazetteer ever exceeds 500 points, switch the
  point layer to a `geojson` source with `cluster: true` — noted here so the rule is not lost.
- `maxzoom: 13` on the camera caps DEM/imagery tile fetches. Never raise it.

---

## 5. The Human Checkpoint (the ask-before-the-irreversible-step)

### 5.1 Non-negotiable properties

1. **It blocks.** A hard modal: full-viewport scrim, focus trapped, `aria-modal="true"`,
   background marked `inert` (and `aria-hidden="true"` for browsers without `inert`). No
   click-outside-to-dismiss. No auto-dismiss. No timeout. It is never rendered as a toast, snackbar,
   banner, or corner notification, and it never shares a stacking context with the toast layer.
2. **A typed, non-empty approver name is required**, for approve *and* for reject. The client
   disables both decision buttons until `name.trim().length > 0`. The server enforces it
   independently (`assertApprover`), and the client shows the server's own error text on failure.
3. **Approve and reject are equally weighted.** Same size, same row, same prominence. Reject is not
   a link, not a "cancel", not smaller. A rejection is a decision on record.
4. **Full evidence is on screen before the buttons.** The approver must be able to reach every
   number the machine used without leaving the dialog.
5. **It never says where to go.** The dispatch-refusal line is rendered in the dialog, not a footnote.

### 5.2 Anatomy

```
┌──────────── scrim rgba(4,7,10,.82) + backdrop-filter: blur(3px) ────────────┐
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ HUMAN CHECKPOINT · 3 of 8 pending          [ Close without deciding ] │  │ 72px
│  │ {item.title}                                                          │  │
│  │ ▲ ESCALATION · np-dhading-benighat · raised 4 min ago                  │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │ ⓘ  Signal Zero does not dispatch. …                          rule bar │  │ 44px
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │  EVIDENCE  (scrolls)                                                  │  │ 1fr
│  │   1. What we observed                                                 │  │
│  │   2. How the number was reached                                       │  │
│  │   3. What we do not know          ← always present                    │  │
│  │   4. Reports behind this / The two candidates                         │  │
│  │   5. Raw evidence object (collapsed <details>)                        │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │  Your name (required, recorded permanently)                           │  │
│  │  [_______________________________________]                            │  │ 132px
│  │  helper / error text                                                  │  │
│  │  [ Reject — not actionable ]      [ Approve — release shortlist ]     │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

Dialog: `width: min(880px, 92vw); max-height: min(88dvh, 900px);`
`display: grid; grid-template-rows: auto auto 1fr auto;` Body scrolls; header, rule bar and footer
are pinned. `border: 1px solid var(--warn); border-top: 4px solid var(--warn);`
`box-shadow: 0 32px 80px -16px rgba(0,0,0,.7);` `z-index: 100` (toast layer is `z-index: 90` — the
modal is always above it).

### 5.3 Exact copy — use these strings verbatim

**Kicker:** `HUMAN CHECKPOINT · {index} of {pendingCount} pending`

**Kind line:** `▲ ESCALATION` or `◆ AMBIGUOUS MATCH`, then ` · {settlementId ?? 'no settlement resolved'} · raised {relative}`

**Rule bar (always, both kinds):**
> Signal Zero does not dispatch. Approving this releases a non-preferential, alphabetical list of
> district committees to inform. It never says where to go, who should go, or what to do.

**Section headings:**
- `What we observed`
- `How the number was reached`
- `What we do not know`
- `Reports behind this` (escalation) / `The two candidates` (ambiguous-match)
- `Raw evidence object` (inside `<details>`, summary text: `Show the exact evidence the server holds`)

**"What we do not know" body — escalation with `coverageBasis: "cohort-cold-start"`:**
> **No data reached us.** No report has ever resolved to {name}. Its expected reporting rate is
> borrowed from cohort `{cohortKey}` ({fitBasis} fit, {cohortSampleGaps} observed gaps), not measured
> here. We do not know whether {name} is quiet, unreachable, or simply unreported. Nothing on this
> screen is a confirmation that anything happened there.

**"What we do not know" body — escalation with `coverageBasis: "reports"`:**
> Silence means no report has reached us since {lastReportAt}. It is not a confirmation that this
> place went quiet. Coverage is limited to the {n} sources listed below; a gap in our sources looks
> identical to a gap on the ground.

**"What we do not know" body — ambiguous-match:**
> The match probability is {p}, between the auto-reject threshold ({lowerThreshold}) and the
> auto-merge threshold ({upperThreshold}). The machine refuses to guess which of these is correct.
> Merging two different places, or splitting one, both corrupt the ranking downstream.

**Name field label:** `Your name (required, recorded permanently)`
**Placeholder:** `e.g. R. Gurung, District Duty Officer`
**Helper text (default):**
> This name is written to the decision record, shown in the activity log, and cannot be edited
> afterwards. The server refuses anonymous decisions.

**Helper text when field is empty and a button was reached by keyboard:**
`Enter your name to approve or reject.`

**Inline error on 400 `APPROVER_REQUIRED` (server's own wording):**
> A named human approver is required. Nothing in Signal Zero becomes actionable anonymously.

**Buttons:**
- Reject: `Reject — not actionable`
- Approve: `Approve — release shortlist`
- Close: `Close without deciding`

**Confirmation line shown in the queue after closing without deciding:**
`Left pending. No decision was recorded.`

**Success — approve:**
> **Approved by {approvedBy}** at {decidedAt, local time}. Released a list of {shortlist.length}
> district committees to inform. This list is alphabetical and carries no priority order — it is not
> a dispatch.

Then the shortlist table: `name` · `district` · `settlementsInDistrict` · `populationInDistrict`,
with a caption in `--ink-2`: `ordering: alphabetical-by-district (non-preferential)`.

**Success — reject:**
> **Rejected by {approvedBy}** at {decidedAt, local time}. Nothing was released. The item stays in
> the record.

**409 `ALREADY_DECIDED` banner:**
> This item was already {status} by {approvedBy}. Refreshing the queue.

**Network failure on submit:**
> Could not reach the server. **No decision was recorded.** Check the connection and try again.
> `[ Retry ]`

### 5.4 Button and field states

| Condition | Approve | Reject | Name field |
|---|---|---|---|
| `name.trim() === ''` | `disabled`, `aria-disabled="true"`, 45% opacity | same | `aria-describedby` → helper |
| name entered | enabled, `--ok` border + `--ok-bg` fill | enabled, `--critical` border + transparent fill | normal |
| submitting | both `disabled`, clicked one shows `Recording…` + spinner | | `readonly` |
| decided | both hidden, replaced by success block | | hidden |
| read-only re-open | both hidden | | hidden |

`disabled` buttons stay in the tab order via `aria-disabled` + a click handler that focuses the
name field and swaps in the "Enter your name…" helper — a disabled control the keyboard cannot
reach is a dead end.

Approve is styled with `--ok` and reject with `--critical`, but **both carry a glyph and full text**
(`✓` / `✕`) so hue is never load-bearing (§7.5).

### 5.5 Keyboard path (the full journey, no mouse)

1. `Tab` to the checkpoint bar's `Review queue →` (it is the last focusable element in DOM order
   before the toast layer; also reachable from the command-bar pending pill).
2. `Enter` → focus moves to region E, first pending card's `Review & decide →` button.
   `↑`/`↓` move between cards' buttons.
3. `Enter` → modal opens. **Focus lands on the dialog container** (`tabindex="-1"`), not on a
   button — so a screen reader reads the title and rule bar before the user can act. Announce order:
   dialog label (`Human Checkpoint. {title}`) → rule bar → first heading.
4. `Tab` cycles: `Close without deciding` → evidence links / `<details>` toggles → name input →
   `Reject` → `Approve` → wraps to `Close`. `Shift+Tab` reverses. Focus never escapes the dialog.
5. Typing in the name field enables both buttons; the change is announced once via a
   `aria-live="polite"` region: `Approve and reject are now available.`
6. `Enter` in the name field does **not** submit. There is no accidental-Enter path to an
   irreversible decision. It moves focus to `Reject` (the less consequential of the two).
7. `Enter`/`Space` on `Approve` or `Reject` submits.
8. On success, focus moves to the success block heading (`tabindex="-1"`), which is announced. The
   footer offers `Next pending item →` (if any) or `Close`.
9. **`Escape`**: WCAG 2.1.2 forbids a true keyboard trap, so `Escape` must work — it performs
   exactly `Close without deciding`. The item **stays pending**, region H still shows the count, and
   a `LOCAL` activity row is written: `Checkpoint {id} left pending — no decision recorded.` Focus
   returns to the `Review & decide →` button that opened the dialog.

There is no keyboard shortcut, gesture, or shortcut key that approves anything. The only path to an
approval is: open dialog → type a name → activate a labelled button.

### 5.6 Post-decision behaviour

- Optimistically render nothing. Wait for the server response — the server is the source of truth
  for `status`, `approvedBy`, and `decidedAt`.
- On success: refetch `/api/state`, move the item from `Waiting` to `Decided`, decrement H, append
  the shortlist to the evidence panel if a settlement is selected.
- If `pendingCount` is still > 0, the footer's primary action becomes `Next pending item →`, which
  swaps the dialog content in place (do not close and reopen — the focus dance is worse).

### 5.7 Read-only mode

Opening a decided item from the `Decided` list shows the same dialog with:
- Header pill: `DECIDED` in `--ok` (approved) or `--ink-2` (rejected).
- A banner directly under the kicker:
  `Decided by {approvedBy} on {decidedAt}. This record cannot be changed.`
- No name field, no decision buttons. Single footer action: `Close`.
- Full evidence, unchanged. The audit trail is the point.

---

## 6. Honesty: empty, loading, error, and "no data reached us"

### 6.1 Banned strings — never render these, in any region

`dispatch` · `deploy` · `send team` · `respond to` · `go to` · `assign` · `tasking` · `priority
target` · `recommended destination` · `next stop` · `confirmed silent` · `verified quiet` ·
`no survivors` · `casualties expected` · any imperative directed at the reader about physical
movement.

The word **"priority"** may only appear as `sorted by silence rank`, never as `priority 1`.
The shortlist heading is always `Released to inform`, never `Recommended responders`.

### 6.2 The No-data chip (`coverageBasis === "cohort-cold-start"`)

A single reusable component, used identically in the rank list, evidence panel, checkpoint modal,
map tooltip, and activity feed. It must look like a caveat, not a status badge.

- Markup: `<span class="chip chip--nodata">◌ no data reached us</span>`
- Style: `background: transparent; border: 1px dashed var(--nodata); color: var(--nodata);
  font-size: 10px; letter-spacing: .04em; text-transform: none;`
- `title` / `aria-label`:
  `No report has ever resolved to this settlement. Its baseline comes from cohort {cohortKey}, not from its own history. This is an absence of data, not a confirmed silence.`
- It is **never** coloured with a semantic token, never green, never rendered as a filled pill, and
  never abbreviated to `cold start` alone in user-facing text (the raw enum value may appear in the
  raw-evidence `<details>`).

For `coverageBasis === "reports"` the counterpart chip is
`<span class="chip chip--reports">● {reportCount} reports</span>` in `--ink-2` — factual, not
reassuring. There is no "confirmed" or "verified" state anywhere in this product.

### 6.3 Loading states

Skeletons, never spinners-in-place, for regions with known shape. Skeleton bars:
`background: linear-gradient(90deg, var(--panel-2) 25%, var(--raised) 50%, var(--panel-2) 75%);
background-size: 200% 100%; animation: shimmer 1.6s linear infinite;`
Under `prefers-reduced-motion: reduce` the animation is removed and the bar is a flat `--panel-2`.

| Region | Loading |
|---|---|
| B Rank | 8 skeleton rows at real row height (46px) |
| C Map | `--map-void` background + centred 12px `--ink-3` text `Loading terrain…` and, after 6s, `Still loading terrain. The list and decisions work without it.` |
| D Evidence | 4 skeleton blocks; header shows the selected name immediately (we already have it) |
| E Checkpoint | 2 skeleton cards |
| F Activity | 5 skeleton rows |
| G Sources | 4 skeleton chips |
| A Stage rail | all segments `pending` style, label `Waiting for first state…` |

First paint must show the shell + skeletons within 200ms of DOM ready. Never a blank page.

### 6.4 Empty states

Each is a centred block: 20px glyph, 13px title in `--ink-2`, 11px body in `--ink-3`, optional
action button.

| Region | Glyph | Title | Body | Action |
|---|---|---|---|---|
| B Rank | `◌` | `No ranking yet` | `Run the pipeline to score all 32 settlements in the Trishuli corridor.` | `Run pipeline` |
| B Rank (filtered to zero) | `⌕` | `No settlements match` | `{n} settlements are loaded. Clear the filter to see them.` | `Clear filter` |
| C Map | `◌` | `No settlements plotted` | `The gazetteer loaded but nothing has been ranked yet.` | `Run pipeline` |
| D Evidence | `◇` | `Nothing selected` | `Pick a settlement from the rank list or the map to see every number behind its score.` | — |
| E Checkpoint | `✓` | `No decisions pending` | `Escalations appear here when a settlement's silence clears the Gi* threshold of 1.96. Nothing becomes actionable until a named human signs for it.` | — |
| E Decided | — | `No decisions recorded yet` | (inline, 11px, no glyph) | — |
| F Activity | `·` | `No activity yet` | `Pipeline runs, degraded sources, LLM fallbacks and human decisions all land here.` | — |
| G Sources | `◌` | (inline) `No sources registered yet — run the pipeline.` | — | — |

The checkpoint empty state uses `✓` and `--ok`. Every other empty state is neutral `--ink-3`. An
empty rank list is not good news and must not be styled as such.

### 6.5 Error states

| Region / cause | Presentation |
|---|---|
| `/api/state` fetch fails | Full-width banner under the command bar, `--critical-bg`, 2px `--critical` top border: **`Cannot reach the Signal Zero API.`** ` Showing the last state received {relative}. Retrying in {n}s.` + `Retry now` button. All regions dim to 70% opacity and get `aria-busy="true"`. **Data on screen is never cleared** — stale-and-labelled beats blank. |
| `/api/state` returns malformed JSON | Same banner, message `The API returned a response this console could not read.` + a `<details>` with the first 400 chars of the body. |
| `POST /api/run` 500 | Toast (`--critical`, 10s, dismissible) with the server's `error` string + a `LOCAL` activity row. Stage rail marks the failed stage. |
| `POST /api/run` 409 | Toast (`--warn`, 5s): `A pipeline pass is already running.` Button enters in-flight state. |
| `GET /api/settlement/:id` 404 | Evidence panel error block: `No record for "{id}".` ` The ranking may have been rebuilt since this row was drawn.` + `Refresh state` button. |
| Checkpoint POST failure | Handled in-dialog only (§5.3). **Never a toast** — a decision failure must not be dismissible. |
| Tile / map failures | §4.6 ladder. In-map banner, not a toast. |
| Zero sources but reports exist | Source strip shows `Sources not reported by this run` in `--warn` — do not render an empty strip that reads as "all clear". |

**Toast policy:** toasts are for *transient, non-decision* feedback only. They are `role="status"`,
`aria-live="polite"`, max 3 stacked, bottom-right above region H, `z-index: 90`. Nothing
irreversible is ever confirmed or requested via a toast.

---

## 7. Colour system

Colourblind-safe by construction: the data ramp is **blue → sand → orange** (never red↔green);
categorical distinctions on the map are carried by **shape**, not hue; and every semantic colour is
always paired with a glyph and a text label.

### 7.1 Structure

Define the complete light palette on bare `:root`. Redefine **only** the changed tokens in
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` and again in
`:root[data-theme="dark"] { … }` so the manual toggle wins in both directions. Never define a colour
for the first time inside a media query.

### 7.2 Surface / ink tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#EEF1F4` | `#080B0F` | page ground |
| `--panel` | `#FFFFFF` | `#0F151B` | region background |
| `--panel-2` | `#F3F6F8` | `#141C24` | headers, sub-blocks, chips |
| `--raised` | `#E7ECF0` | `#1B2530` | modal, hover, skeleton highlight |
| `--line` | `#D4DBE2` | `#1F2B36` | 1px borders, grid hairlines |
| `--line-soft` | `#E4E9ED` | `#18212A` | internal dividers |
| `--ink` | `#0E1620` | `#E6EDF3` | primary text |
| `--ink-2` | `#41505C` | `#A7B6C2` | secondary text |
| `--ink-3` | `#5F6E7A` | `#7C8D9B` | tertiary / captions |
| `--ink-4` | `#8B99A4` | `#55646F` | **non-text only** — disabled glyphs, decorative rules |
| `--map-void` | `#DDE3E8` | `#0A0E12` | plain-basemap background |
| `--corridor` | `#8EA0AE` | `#5B6E7C` | adjacency lines |
| `--ring` | `rgba(11,15,20,.85)` | `rgba(255,255,255,.90)` | map anomaly rings |

### 7.3 Silence-magnitude ramp (sequential) — `--sil-0` … `--sil-5`

| Stop | `silenceHours` | Light | Dark | Label text on this fill |
|---|---|---|---|---|
| `--sil-0` | 0 – 6 | `#14496E` | `#1A5C8A` | `#FFFFFF` |
| `--sil-1` | 6 – 18 | `#22698A` | `#2E86AB` | `#FFFFFF` |
| `--sil-2` | 18 – 36 | `#4A93B8` | `#67B0CF` | `#FFFFFF` |
| `--sil-3` | 36 – 60 | `#B8933F` | `#E9D6A3` | `#0B0F14` |
| `--sil-4` | 60 – 84 | `#C96B14` | `#E8963C` | `#0B0F14` |
| `--sil-5` | ≥ 84 | `#B03410` | `#F4622E` | `#0B0F14` |

Ordered by hue (cool → warm) and by chroma. Under deuteranopia and protanopia the blue half stays
blue and the warm half collapses toward yellow-brown — the two halves remain separable, and the
within-half ordering is carried by lightness. Under tritanopia the blue→warm axis is the surviving
one. Redundant channels: ring shape, marker size, the numeric `{h}h` label on ranks 1–3, and the
`Silent` column value in region B.

`--sil-tint-N` variants at 14% alpha for the rank-list cell backgrounds:
e.g. `--sil-tint-5: color-mix(in srgb, var(--sil-5) 14%, transparent);` (with a hard-coded
fallback declared first for older engines).

### 7.4 Brand accent — deliberately outside both the ramp and the semantics

| Token | Light | Dark |
|---|---|---|
| `--accent` | `#5B4BD6` | `#9B8CFF` |
| `--accent-2` | `#4438B0` | `#B7ACFF` |
| `--accent-bg` | `#EEEBFB` | `#1C1836` |

Violet appears nowhere in the silence ramp and nowhere in the semantic set. It is used for: focus
rings, selection state, the active pipeline stage, `ambiguous-match` glyphs, and links. It is
**never** used to indicate severity or health.

### 7.5 Semantic colours — separate from brand, never hue-alone

| Token | Light | Dark | Glyph | Meaning |
|---|---|---|---|---|
| `--ok` | `#1E7A52` | `#3FBF85` | `●` / `✓` | live source, recovered, approved |
| `--ok-bg` | `#E4F3EB` | `#0E2A1F` | | |
| `--warn` | `#A66A00` | `#E0A32B` | `▲` / `⏸` | degraded source, pending decision, anomaly |
| `--warn-bg` | `#FBF0DC` | `#2C2008` | | |
| `--critical` | `#B3261E` | `#F0584A` | `■` / `✕` | source down, run failed, rejected |
| `--critical-bg` | `#FBE7E5` | `#320F0C` | | |
| `--nodata` | `#5C6874` | `#8A99A6` | `◌` | **no data reached us** — deliberately neutral grey, never green, never a health colour |

**Rule:** a semantic colour never appears without its glyph *and* a text label. `ok` green and
`critical` red are the one red/green pair in the system; they are permitted only because they are
status chips carrying redundant shape + text, and they are never used to encode data values. The
data ramp (§7.3) contains no green.

### 7.6 Contrast (WCAG AA)

Text tokens against their intended background, contrast ratio:

| Pair | Dark | Light | Requirement |
|---|---|---|---|
| `--ink` on `--bg` | 15.9 | 16.4 | ≥ 4.5 ✔ |
| `--ink-2` on `--panel` | 7.9 | 8.1 | ≥ 4.5 ✔ |
| `--ink-3` on `--panel` | 5.1 | 5.2 | ≥ 4.5 ✔ |
| `--ink-4` on `--panel` | 2.9 | 2.7 | **non-text only** — never used for text |
| `--ok` on `--panel` | 7.3 | 5.2 | ≥ 4.5 ✔ |
| `--warn` on `--panel` | 8.6 | 4.9 | ≥ 4.5 ✔ |
| `--critical` on `--panel` | 5.9 | 6.1 | ≥ 4.5 ✔ |
| `--accent` on `--panel` | 7.2 | 6.4 | ≥ 4.5 ✔ |
| `--nodata` on `--panel` | 6.0 | 5.5 | ≥ 4.5 ✔ |
| `--warn` on `--warn-bg` (region H) | 8.9 | 5.4 | ≥ 4.5 ✔ |
| map label on `--sil-*` + halo | ≥ 7 | ≥ 7 | ✔ via §4.4 flip rule |

Non-text contrast (WCAG 1.4.11, ≥ 3:1): `--line` on `--panel` is below 3:1 by design for decorative
hairlines; **any border that carries meaning** (input borders, focus rings, status chip borders,
selected-row indicators) uses `--ink-3`, `--accent`, or a semantic token, all ≥ 3:1.

Verify the final values with an automated checker before submission and adjust the *token*, not the
usage.

---

## 8. Typography

### 8.1 Families (Google Fonts)

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap">
```

| Role | Family | Fallback stack |
|---|---|---|
| Display — brand, region headers, modal titles | **Space Grotesk** 500/600/700 | `"Space Grotesk", "Archivo", "Segoe UI", system-ui, sans-serif` |
| UI & prose — labels, body, buttons | **Inter** 400/500/600 | `"Inter", ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif` |
| Data — all numerics, IDs, timestamps, formulas, raw JSON | **JetBrains Mono** 400/500/700 | `"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace` |

**Venue-wifi rule:** `display=swap` plus complete fallback stacks means a font failure degrades to
system faces with no layout break and no invisible text. The app must not block first paint on
fonts, and must not measure or lay out assuming the webfont's metrics. Vendoring the three WOFF2
files into `web/vendor/fonts/` with `@font-face` + `font-display: swap` is preferred if time allows.

### 8.2 Type scale (base 14px, ratio 1.20 minor third)

| Token | px | line-height | Typical use |
|---|---|---|---|
| `--fs-3xs` | 10 | 1.3 | uppercase micro-labels, `SIMULATED` / `LOCAL` tags |
| `--fs-2xs` | 11 | 1.4 | captions, meta lines, chips, legend |
| `--fs-xs` | 12 | 1.45 | table numerics, activity rows, source chips |
| `--fs-sm` | 13 | 1.5 | secondary body, card titles, section headings |
| `--fs-base` | 14 | 1.55 | body, table names, buttons |
| `--fs-md` | 17 | 1.4 | brand wordmark, region headers |
| `--fs-lg` | 20 | 1.3 | modal title |
| `--fs-xl` | 24 | 1.25 | stat cluster values, empty-state titles |
| `--fs-2xl` | 29 | 1.2 | reserved (unused at desktop; used for the phone stat row) |

Tracking: `letter-spacing: .08em` on all uppercase micro-labels; `-0.011em` on `--fs-lg` and above;
`0` elsewhere. Body max measure `68ch` in evidence and modal prose blocks.

**Numeric rule:** every number rendered anywhere uses JetBrains Mono with
`font-variant-numeric: tabular-nums;` so columns align and values do not jitter on refresh.

### 8.3 Formatting conventions

| Value | Format | Example |
|---|---|---|
| `silenceHours` | 1dp, `h` suffix; `≥100` → 0dp | `96.0h`, `13.4h` |
| `giZScore`, `surprisal`, `*ZScore` | 2dp, signed | `+2.87`, `−0.42` |
| `lambdaPerHour` | 5 significant decimals | `0.01042 /h` |
| `survivalProbability` | 3dp | `0.367` |
| `population` | grouped | `6,870` |
| `matchProbability` | 2dp | `p = 0.61` |
| timestamps | relative in-line, full ISO in `title` | `4 min ago` / `2026-08-29T14:26:11.204Z` |
| `null` timestamp | literal `Never` in `--nodata`, never `—` | `Never` |
| zero counts | `0` in `--ink-3`, never blank | `0` |
| `settlementId` | mono, `--ink-3` | `np-dhading-benighat` |

---

## 9. Accessibility

### 9.1 Focus

One global focus style, visible on every background including imagery:

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
  box-shadow: 0 0 0 4px var(--accent-bg);   /* outer bloom for contrast on the map */
}
```

- Never `outline: none` without a replacement.
- Map markers are focusable via the parallel button layer (§4.5) and additionally receive a 3px
  `--accent` painted ring so focus is visible *on the canvas*, not just in the DOM.
- Focus order follows DOM order: A → B → C(markers, by rank) → D → E → F → G → H. `Skip to`
  links at the very top (visually hidden until focused): `Skip to rank list`,
  `Skip to checkpoint queue`, `Skip to map`.
- All regions are `<section>` with `aria-labelledby` pointing at their header, so a screen reader's
  landmark list is the region inventory in §1.1.

### 9.2 Keyboard

- Every interactive element is a real `<button>`, `<a>`, `<input>`, or `<details>`. No
  `<div onclick>`.
- Full checkpoint keyboard journey: §5.5. It is the path that must be tested first.
- Global shortcuts (only three, all non-destructive, all disabled while an input has focus):
  `r` = reset map view · `/` = focus the rank filter input · `?` = toggle a shortcuts panel.
  **There is deliberately no shortcut for `Run pipeline` and none for any checkpoint decision.**
- Modal focus trap implemented by cycling within the dialog's focusable set; `Escape` is the
  documented exit (§5.5 step 9), satisfying WCAG 2.1.2.

### 9.3 Screen reader

- `<html lang="en">`. Nepali place names carry no `lang` change (they are romanised).
- `aria-live="polite"` on: the activity feed (throttled per §2.F), the stage-rail announcer, and the
  modal's button-enabled announcement.
- `aria-live="assertive"` only on the API-unreachable banner. Nothing else is assertive.
- Every colour-bearing element has a text equivalent. Every icon-only button has `aria-label`.
- Tables use `<th scope="col">` and `aria-sort`. Row selection uses `aria-selected` on
  `role="row"` within a `role="grid"` when arrow-key navigation is active.
- The map canvas is `aria-hidden="true"`; the accessible representation is the marker button layer
  plus region B, which contains the same 32 records. State this in the map's
  `aria-describedby`: `A visual map. The same 32 settlements are listed in the Silence Rank table.`
- Decorative glyphs (`◌`, `▲`, `◆`) are wrapped in `aria-hidden="true"` spans; the adjacent text
  carries the meaning.

### 9.4 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Beyond the blanket rule, these are handled explicitly in JS (CSS alone cannot reach them):

| Motion | Reduced-motion behaviour |
|---|---|
| Opening camera settle (§4.3) | Skipped — `jumpTo` the final camera |
| `easeTo` on selection | `duration: 0` |
| Anomaly ring pulse | Static ring, 1px thicker instead |
| Stage-rail sweep bar | Static 40%-width bar + the text `Running` |
| Skeleton shimmer | Flat `--panel-2`, no gradient |
| Checkpoint bar attention pulse | No pulse; a 2px `--warn` top border is always present instead |
| Toast slide-in | Instant appearance |
| Tab badge pulse | Single static badge |

Query once with `window.matchMedia('(prefers-reduced-motion: reduce)')` and listen for changes; do
not read it only at boot.

### 9.5 Other

- Zoom to 200% without loss of function (WCAG 1.4.4): at 200% on a 1600px display the layout is
  effectively 800px wide and lands in the tablet breakpoint — verify the tab bar path works there.
- Minimum hit target 24×24px (WCAG 2.5.8); primary buttons and all checkpoint controls are ≥ 40px
  tall.
- No information conveyed by colour alone, anywhere (§7.5).
- Text can be resized without horizontal body scroll; wide content (rank table, formula block, raw
  JSON) scrolls inside its own `overflow-x: auto` container.

---

## 10. Build order (highest demo-risk first)

1. Shell: grid, tokens (both themes), typography, skeletons, empty states. Ship a page that looks
   finished with zero data.
2. `/api/state` polling (5s idle, 1.2s while running), stale/offline banner, region G.
3. Region B rank list + region D evidence panel, fully keyboard-navigable.
4. **Region E + H + the checkpoint modal, end to end, including the reject path and the
   keyboard-only journey.** This is the scored feature; do not defer it.
5. Region F activity feed + the three demo failure injectors.
6. Region A stage rail (with the honest fallback copy if no backend hook).
7. **2D Fallback Grid map** (SVG, no library).
8. MapLibre terrain map as a progressive enhancement over step 7, with the full §4.6 ladder.

Steps 1–7 constitute a complete, demonstrable product with no map library. Step 8 can fail on the
night without costing the demo.

## 11. Pre-demo checklist

- [ ] Kill the network mid-demo: banner appears, data stays, nothing blanks.
- [ ] Block `unpkg`/`fonts.gstatic.com` in devtools: layout intact, fonts fall back, map still works.
- [ ] Force `WEBGL_lose_context`: fallback grid appears within 6s, list and decisions still work.
- [ ] Approve an item with an empty name → both buttons disabled; force the POST via console → the
      server's `APPROVER_REQUIRED` text renders inline.
- [ ] Complete one approval and one rejection using only the keyboard.
- [ ] `Escape` mid-decision → item stays pending, region H count unchanged.
- [ ] Toggle Light / Dark / Auto: every region legible, no token defined only in a media query.
- [ ] Deuteranopia + protanopia + tritanopia simulation: rank order still readable from the map.
- [ ] `prefers-reduced-motion: reduce`: no camera flight, no shimmer, no pulse.
- [ ] Grep the built UI for every banned string in §6.1 — zero hits.
- [ ] Confirm all 24 cold-start settlements render the no-data chip in every surface that shows them.
- [ ] 200% browser zoom: tab-bar layout, checkpoint modal still usable.
- [ ] Run at 1366×768 (typical conference-room projector) — the map is still the dominant region.
