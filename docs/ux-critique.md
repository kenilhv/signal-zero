# Signal Zero — UX critique of the live build

Method: `web-design-engineer` skill, Step 7 (critique) with Step 2b (Design Read + Five Dials) and
`references/redesign-protocol.md` §2 (audit before editing) applied first.

Evidence base: the running console at `http://localhost:3000`, branch `feat/control-room-ux`,
live data (42 reports, 21 clusters, 9 pending checkpoints, 5 sources, 37,081 ms last pass,
23 of 32 settlements at 96.0 h silence). Inspected at **1600×1000**, **1280×800**, **820×1180**,
in light and dark, across Terrain / Street / Plain, with a settlement selected, the legend open,
and the checkpoint dialog open. Every number below was measured in the page, not estimated from a
screenshot. Source read: `web/index.html` (228 lines), `web/styles.css` (655), `web/app.js` (1579),
`docs/ui-spec.md` (1161).

**Overall: 4.8 / 10 — Needs work.** Weighted for a data product per `critique-guide.md`
(Functionality and Craft first, Hierarchy second, Originality relaxed).

| Dimension | Score | One-line reason |
|---|---|---|
| Philosophy alignment | 5 | The thesis lives entirely in the copy and nowhere in the composition — the largest numerals on screen count *reports* and *clusters*. |
| Visual hierarchy | 3 | Largest visible text is 17 px against a 12 px body (1.4×, rubric wants ≥2.5×); every `h2` is *smaller* than the row names beneath it. |
| Craft quality | 5 | Token architecture, theme handling and state coverage are genuinely strong; 13 border-radius values, two 4°/11° hue collisions, a 4.48:1 primary button and a `1fr 1fr` grid resolving to 139/559 px are not. |
| Functionality | 5 | Nothing is fabricated and every state exists, but the operator sees 11 of 32 rows, 2.9 of 9 decisions, 7 of 32 map labels, and cannot see the uncertainty statement at the moment they sign. |
| Originality | 6 | Green-free sequential ramp, shape-encoded anomaly type and the "what we do not know" block are real ideas; the shell is the AI-default dashboard. |

---

## 1. Design Read

```yaml
Design Read:
  artifact: >
    Live operational monitoring console (single-screen, 4 s polling, five regions)
    plus one blocking irreversible-decision dialog. Not a landing page, not a report,
    not an executive summary.
  audience: >
    PRIMARY — emergency-operations-centre duty staff and district officials during an
    active GLOF response. They scan, compare, and sign their own name to a decision they
    will be held to. They arrive mid-shift, already know the geography, and are tired.
    SECONDARY — a hackathon judge who has never seen the product and will look at it cold
    for roughly three minutes. These two audiences want opposite things. That tension IS
    the design problem, not a footnote to it.
  visual-language: >
    CURRENT — restrained builder-SaaS dashboard: Inter body, 6 px radii, rounded
    left-accent cards, a violet primary button, a photographic satellite hero.
    TARGET — institutional data-first / civic situation room: hairline-ruled panes,
    zero radius, tabular mono numerals, hierarchy by size, one accent.
  mode: >
    Redesign · Preserve. The information architecture, the copy, the honesty contracts
    and the accessibility work are correct and must survive verbatim. What is wrong is
    the visual token layer and the allocation of screen area. This is explicitly NOT an
    overhaul — see Protected Contracts below.
  visual-variance: 3        # current — target 4
  motion-intensity: 2       # current — target 2 (keep)
  information-density: 4    # DELIVERED, current — target 7. (Rendered density is 9. See §3.)
  asset-dependence: 6       # current — target 3
  brand-fidelity: 5         # current — target 8 on product contracts, 4 on visual tokens
constraints:
  - No build step, no framework. Vanilla ES modules + hand-written CSS. Vendored MapLibre.
  - Google Fonts already wired (Space Grotesk / Inter / JetBrains Mono, deferred via media=print).
  - Light + dark, honoured three ways (bare :root, prefers-color-scheme, [data-theme]).
  - WCAG AA. Full keyboard path. prefers-reduced-motion.
  - Hard no-dispatch rule: the UI may never name a destination or imply an action.
  - Never fabricate. Every rendered value comes from GET /api/state or /api/checkpoint/:id.
  - Map must degrade to inline SVG when tiles fail.
```

**Protected contracts** (`redesign-protocol.md` §3) — do not change silently in the rebuild:
the five region IDs and their skip-link anchors (`#region-rank`, `#region-map`,
`#region-checkpoint`), the tab `data-tab` keys, every string in `ui-spec.md` §5.3 and §6.1,
the banned-strings list, the `aria-disabled`-until-named gate on both decision buttons, the
`aria-sort` / `aria-live` / `role="tablist"` semantics, and the `--sil-0…5` ordinal ramp
contract (sequential, no green).

---

## 2. What is already right (do not regress these)

Being specific here matters as much as the criticism, because the rebuild will be tempted to
throw all of it away.

- **The copy is the best thing in the product.** `"Silence = no report reached us. Not a
  confirmation that a place is quiet."` (legend foot). `"We do not know whether Thakre is quiet,
  unreachable, or simply unreported."` (evidence). `Never` rendered literally in `--nodata`
  rather than an em-dash. `"There is nothing behind this row but the cohort baseline."` This
  register — declarative, uncertainty-forward, never persuasive — is exactly right for a
  government tool and is worth more than any visual move in this document.
- **The no-dispatch rule is stated at the decision moment, not buried in a footer.**
  `.rule-bar`, above the dialog fold: *"Signal Zero does not dispatch. Approving this releases a
  non-preferential, alphabetical list of district committees to inform. It never says where to go,
  who should go, or what to do."*
- **State coverage is close to complete** — `failure-patterns.md` "Happy-path-only components" is
  the one dashboard pattern this UI does **not** exhibit. `.skel` / `.empty` / `.empty-ok` /
  `.api-banner` / `body.is-stale` / `.conflict` / `.netfail` / `.dialog.ro` / `.cp-decided` all
  exist and are reachable. `body.is-stale .region{opacity:.7}` degrades rather than clearing the
  screen — the right instinct.
- **Anomaly type is encoded by border *shape*, never by hue**
  (`double` / `solid`+glow / `dashed` / `dotted` on `.mk-dot[data-anom]`), and the silence ramp
  deliberately contains no green. That is a sophisticated, colour-vision-safe decision most
  dashboards get wrong.
- **The named-human gate is real.** Both buttons carry `aria-disabled="true"` until a name is
  typed, and `app.js:1207` fires a live-region announcement — *"Approve and reject are now
  available."* — when they enable.
- **Accessibility**: three skip links, `:focus-visible` with a 2 px outline + 4 px halo, a
  visually-hidden map description pointing screen-reader users at the equivalent table,
  `aria-sort` on every sortable header, and a complete `prefers-reduced-motion` block
  (`styles.css:591`) that also kills the rail sweep.
- **Theme implementation is textbook** — complete light palette on bare `:root`, dark redefined
  twice so the manual toggle wins in both directions. No token is defined only inside a media query.
- **The load-bearing CSS comments** (`min-width:0` on `.source-chips`, `flex:0 1 auto` on
  `.scenario`, the `-webkit-line-clamp` on `.cbar p`) document real debugging, not decoration.

---

## 3. Five Dials — current reading, target, and why

### Visual variance — current 3 → target 4

**Current 3.** Stable symmetric three-column grid, familiar navigation, low surprise:
`grid-template-columns: 360px minmax(340px,1fr) 420px`. Left list / centre map / right feed is
the single most common dashboard skeleton in existence.

**Target 4.** One asymmetric move, everything else on a stable spine, per the calibration band
("one or two asymmetric moves, controlled novelty"). The move: **the ranked silence board becomes
the wide primary surface and the map becomes a narrow context strip beside it.** The composition
should assert the thesis before a word is read. A stranger seeing a full-height column of
identically-dark rows learns "almost everywhere has gone quiet" in under a second; today they see
a satellite photograph and learn nothing. Do not raise this above 4 — an EOC console that surprises
its operator with layout novelty is a liability.

### Motion intensity — current 2 → target 2 (hold)

**Current 2.** `@keyframes sweep` on the active rail segment, `@keyframes shimmer` on skeletons,
`@keyframes tin` on toasts, a MapLibre `flyTo` on selection. Reduced motion fully honoured.

**Target 2, with one substitution and one addition.**
- *Remove* the infinite `sweep` loop. It is the only ambient animation on the page and it lives on
  the one element nobody can read (§4.4). Per `failure-patterns.md` "Motion for spectacle only":
  removing it changes no understanding. Replace with a determinate segment fill.
- *Add* a 60 ms background flash on a rank row whose silence band changes between polls — the
  Bloomberg recipe's "blink on data update (50–80 ms flash)". This is the one animation in the
  product that would carry causality: it tells the operator that the ranking they are reading just
  moved under them, which matters when they are mid-decision.

### Information density — the tension, resolved

This dial needs to be split before it can be answered, because the current UI is simultaneously
at 9 and at 4.

**Rendered density (how small the type is): currently 9.** Measured font-size histogram of every
text-bearing element at 1600×1000:

| px | elements |
|---:|---:|
| 9.5 | 11 |
| 10 | 106 |
| 11 | 208 |
| 12 | 244 |
| 13 | 20 |
| 14 | 40 |
| 15 | 3 |
| 17 | 1 |
| 20 | 1 (dialog title, not on the main screen) |

**569 of 634 text-bearing elements — 89.7% — are set at 12 px or smaller.** The largest visible
text anywhere on the console is the 17 px wordmark. This is Bloomberg-grade type sizing.

**Delivered density (decision-relevant facts per viewport): currently 4.** Measured:

| What the operator needs to see | Visible | Total | Share |
|---|---:|---:|---:|
| Ranked settlements (1600×1000) | 11 | 32 | 34% |
| Ranked settlements (1280×800) | 8 | 32 | 25% |
| Ranked settlements (820×1180) | 6.1 | 32 | 19% |
| Pending human decisions | 2.9 | 9 | 32% |
| Named places on the map (820 wide) | 7 | 32 | 22% |
| Decision-dialog content at the moment of signing | 536 px | 786 px | 68% |

`#rank-body` is 779 px tall with a 2248 px scrollHeight at the *widest* viewport tested. The rank
row is **69.6 px tall** — for a row whose payload is a place name, a district, an hours figure and
a z-score.

So the console pays the full legibility cost of terminal density and receives none of the
information benefit. It reads as dense and behaves as sparse.

**Target: delivered density 7, rendered density 5.**

7 is the calibration band's "analytical, operational, comparison-heavy" — correct for someone
whose job is *comparison* under time pressure. Not 8–9, because 8–9 is "cockpit-like; requires
strong grouping, scanning and progressive disclosure", and progressive disclosure is exactly what a
three-minute cold reader cannot perform.

The mechanism that lets rendered density *fall* while delivered density *rises*: **remove things,
do not shrink them.** Arithmetic, not taste —

> A 32-row list at **28 px per row** occupies 896 px: every settlement in the corridor visible at
> once, in one column, with the place name set at **15 px** instead of today's 14 px.
> Today's list is 69.6 px per row and shows 11 rows at 14 px.
> **Three times the information, in larger type, in the same column.**

The 41.6 px per row that gets recovered is currently spent on a stacked `no data reached us` chip
(→ one glyph in a dedicated column), a `⏸ decision pending` badge (→ a right-edge rule), and
`padding:6px 8px` on a two-line `.rank-name` flex stack (→ one line, district as a suffix).

**How this resolves the Bloomberg tension explicitly.** The `bloomberg-terminal` recipe is density
9–10 and its own *Don't use when* says: *"The audience is consumer (they'll bounce in 3 seconds —
terminal density is acquired taste)."* For three minutes, the judge is that consumer. The EOC
operator is not. Both must be served by one screen.

The resolution is that Bloomberg's density and Bloomberg's *typography* are separable, and only one
of them is load-bearing:

- **Adopt** Bloomberg's structure: multi-pane workspace, hairline dividers, radius 0, no shadow,
  tabular mono numerals, colour-coded deltas, a persistent status bar, keyboard-shortcut chips.
  These are what make a practitioner fast, and none of them cost a stranger anything.
- **Reject** Bloomberg's 11–14 px universal mono body and its "no 16 px body, no 32 px headlines"
  rule. Bloomberg can afford 11 px because its user has memorised the layout over years and is
  sitting 50 cm from a calibrated monitor. Our user is standing behind a projector at 2 a.m. and
  our judge has never seen the screen before. We buy the same fact-count by cutting regions and
  row heights, not by cutting point size.

This is a deliberate deviation from the recipe and is declared as one (per `style-recipes/INDEX.md`,
"Don't invent new recipes silently"). The concrete floor: **no text below 12 px anywhere**, and the
one headline fact set at 32 px — a 2.7× ratio against a 12 px caption, clearing the
`critique-guide.md` ≥2.5× bar for the first time.

### Asset dependence — current 6 → target 3

**Current 6.** The console leans on an Esri World Imagery raster plus Mapzen/AWS terrain DEM as the
hero surface: the `#region-map` occupies 447,814 px² = **33.0% of the console area** at 1600×1000,
and 46% of viewport height at 820×1180.

**Target 3** — "typography, data, or interface structure can carry the artifact". The satellite
raster encodes **no variable in the model**. Nothing in the settlement record — `silenceHours`,
`surprisal`, `giZScore`, `isRegionalOutage` — is expressed by hillshade. The product's own
three-way basemap toggle proves it: switching to **Plain** removes the photograph and the identical
data marks read *better*, because the corridor graph and the ramp colours stop competing with brown
and green terrain texture. Terrain becomes an on-demand layer, not the default ground.

### Brand fidelity — current 5 → target 8 / 4 (split)

There is no external brand to protect; this is an internal government tool. Split the dial:

- **8 on product contracts** — the copy register, the no-dispatch rule, the banned strings, the
  named-human gate, the region IDs, the accessibility semantics, the green-free ramp. New work must
  look native to these.
- **4 on visual tokens** — explicit permission to replace the violet accent, the 13-value radius
  set, the type scale and the Inter body. None of these is a brand asset; they are defaults.

---

## 4. Failure patterns actually exhibited

Only patterns this UI genuinely shows, each with the observed evidence. Patterns from the catalog
that it does **not** exhibit are named at the end of this section, because the absence is a credit.

### 4.1 Marketing styling on operational UI — ⚠️ Critical
*(`failure-patterns.md` › Dashboards and Product UI)*

> *Detect: giant headlines, excessive whitespace, cinematic cards, and low-density gestures impede
> scanning.*

No giant headlines here — the inverse: **low-density gestures throughout**.

- `.rank-row td{padding:6px 8px}` + a two-line `.rank-name` flex stack + a `.rank-badges` row →
  measured row height **69.6 px**. 11 of 32 rows visible at 1600×1000; 6.1 at 820×1180.
- `.cp-card{margin:8px 12px;padding:9px 10px;border-radius:7px;gap:6px}` → measured
  **133.8 px per card** to carry one 13 px sentence, one mono meta line and one button.
  `#checkpoint-body` is 389 px tall against a 1359 px scrollHeight: **2.9 of 9 decisions visible.**
- `.feed li` measured **65 px** each; `#activity-list` renders 18 items in a 424 px pane.
- `.btn{height:32px}`, `.dlg-actions .btn{height:44px}`, `.dlg-foot input{height:40px}` — consumer
  form sizing on a console where the operator's hand never leaves the keyboard.

For an EOC operator this is the whole job: the question is never "how bad is Thakre", it is "which
of these 32 is worst, and is the gap between #1 and #8 real". That comparison cannot be made across
a scroll boundary.

### 4.2 Decorative data visualization — ⚠️ Critical
*(`failure-patterns.md` › Dashboards and Product UI)*

> *Detect: gradients, 3D, shadows, or animation obscure comparison and scale.*

- The photographic basemap is decoration in the strict Tufte sense — largest element on screen
  (33.0%), encodes nothing. Confirmed by switching to **Plain**, where the same marks are cleaner.
- In **dark mode with Terrain on**, the raster is a bright photographic panel sitting inside
  near-black chrome (`--panel:#0F151B`). The brightest region of the screen becomes the one region
  carrying no data, and the operator's eye is pulled to hillshade instead of to the ramp.
- **21 overlapping map-label pairs out of 32 labels at 1600×1000** (measured by rect intersection):
  Tarkeshwar ↔ Shivapuri ↔ Devighat ↔ Trishuli Bazar ↔ Battar all collide in the confluence.
  At 820 wide, only **7 of 32 markers are labelled at all** — 25 anonymous dots.
- Shadow/blur applied to functional chrome: `.legend{box-shadow:0 4px 20px rgba(0,0,0,.25);
  backdrop-filter:blur(4px)}`, `.map-tools .seg{box-shadow:0 2px 10px}`,
  `--shadow:0 32px 80px -16px rgba(10,20,30,.35)`, and
  `.mk-dot[data-anom="regional-outage"]{box-shadow:0 0 0 9px color-mix(...)}` — a 9 px glow ring
  that enlarges the mark's apparent radius, which is the channel already encoding population.
- The open legend covers **18.6% of the map at 1600×1000 and 35.2% at 1280×800** (measured
  212×393 px against a 578×409 map). The code comment at `index.html:136` already concedes the
  problem and solves it by hiding the legend — which trades occlusion for a first-time viewer who
  cannot decode the marks at all.

### 4.3 Cardification + the left-border accent card — ⚡ Important
*(`failure-patterns.md` › Layout and Components; and the named AI cliché in `SKILL.md`)*

`SKILL.md`'s anti-cliché table lists **"rounded card + colored left-border accent"** by name:
*"Material/Tailwind era leftover; now visual noise in every dashboard."* Five separate instances:

```
.cp-card    { border-radius:7px; border-left:3px solid var(--warn) }
.toast      { border-radius:7px; border-left:3px solid var(--ink-3) }
.unknown    { border-radius:6px; border-left:3px solid var(--nodata) }
.rep.t3     { border-radius:6px; border-left:3px solid var(--warn) }
.map-banner { border-radius:6px; border-left:3px solid var(--warn) }
```

Nine checkpoint items are nine identical rounded amber-edged cards with nine identical full-width
amber buttons. They *are* server-ordered by rank, but nothing on screen says so — so the operator
gets nine equal-weight calls to action and no triage. Grouping here should come from a shared
surface and hairline rules, not from nine containers.

### 4.4 Micro-label noise — ⚡ Important
*(`failure-patterns.md` › Typography and Content)*

> *Detect: decorative version numbers, fake coordinates, status dots, or metadata that does not
> help the user.*

- **`Last pass: 37081ms`** in the command bar. Raw milliseconds. No EOC officer reads that; the
  useful form is "last complete pass 10 min ago".
- **`21 CLUSTERS`** given KPI treatment (15 px mono, the largest numeral class on the screen).
  A dedup cluster is an internal pipeline artefact. See §4.6 — this one is worse than noise.
- The pipeline rail's six stage pills measure **31–42 px wide at 10 px font with
  `overflow:hidden`**, so `✓Ingest` renders as `✓In` and `✓Checkpoint` as `✓Che`. The element that
  exists to show *what the agent is doing* renders as six unreadable stubs at every desktop width,
  and `.rail-track{display:none}` removes it entirely below 1024 px, `.rail{display:none}` below
  768 px.
- Settlement IDs (`np-dhading-thakre`) shown on every checkpoint card in mono — correct in the
  audit trail, noise in the triage queue.

### 4.5 Shape drift — ⚡ Important
*(`failure-patterns.md` › Layout and Components)*

> *Default: define a radius grammar and follow it.*

**13 distinct border-radius values in use**, measured across the live DOM:
`50%` (71 elements), `6px` (34), `4px` (34), `5px` (23), `7px` (11), `11px` (6), `12px` (3),
`8px` (2), `9px` (2), `14px` (1), `3px` (1), `10px` (1), plus a compound `5px 0 0`.
There is no semantic rule assigning radius to role — `.btn` is 6, `.chip` is 4, `.src` is 5,
`.cp-card` is 7, `.legend` is 8, `.dialog` is 10, `.rail-seg` is 11, `.nb-chips button` is 12,
`.pending-pill` is 14.

### 4.6 Unreadable hero — ⚠️ Critical (dashboard variant)
*(`failure-patterns.md` › Typography and Content)*

There is no hero fact on this screen, and the product has exactly one.

- The number that *is* the product — **23 of 32 settlements with zero reports** — appears only
  inside a filter toggle: a **76 × 26 px chip reading "No data 23", with the numeral set at
  10 px.** Measured.
- Meanwhile the command-bar stat cluster renders **42 reports · 21 clusters · 10 min ago** at
  **15 px mono** — the largest numerals on the console. Two of the three are *volume* metrics.
  A product whose tagline is *"Ranking by silence, not by volume"* gives volume the only KPI
  treatment on the screen. That is not a typographic slip; it is the composition contradicting
  the thesis.
- Three mutually inconsistent severity counts sit on screen simultaneously with no reconciliation:
  `Anomalies 1` (filter chip), `⏸ 9 waiting` (command bar), `No data 23` (filter chip),
  `9 decisions waiting` (bottom bar). A stranger cannot tell which one answers "how bad is it".
- Type ratio: largest visible text **17 px** (wordmark) against a **12 px** body = **1.4×**.
  `critique-guide.md` requires ≥2.5×. Worse, `.region-head h2` is **13 px** while the
  `.rank-name b` beneath it is **14 px** — every section heading is smaller than its own content.

### 4.7 Motion for spectacle only — 💡 Polish
*(`failure-patterns.md` › Motion and Interaction)*

`@keyframes sweep` runs `1.4s linear infinite` on `.rail-seg[data-state="active"]::after`. It is
the only continuous animation on the page, and it animates a 33 px pill whose label is clipped.
Removing it changes no understanding — the catalog's own detection test.

### 4.8 Generic display typography — 💡 Polish
*(`failure-patterns.md` › Typography and Content)*

`--f-ui:"Inter"` carries the entire body of the console — Inter is on the skill's named
anti-default list. Space Grotesk is a defensible display choice but is only ever used at 13 px
uppercase for section heads and at 20 px for the dialog title, so the identity-bearing typographic
role is in practice performed by Inter at 11–14 px. There is no brand spec requiring it.

### 4.9 Image-label clutter — 💡 Polish
*(`failure-patterns.md` › Imagery and Brand)*

`.mk-label` overlays the place name **plus a second `96.0h` line** on the photographic basemap,
carried by a four-layer text-shadow halo
(`0 0 3px, 0 0 3px, 0 0 6px, 0 1px 2px var(--map-halo)`). The hours figure duplicates the rank
table's `Silent` column and is the direct cause of the taller label boxes that produce the 21
collisions in §4.2.

### Patterns checked and **not** exhibited — credit where due

- **Happy-path-only components** — the full state ladder exists (§2). Rare and worth saying.
- **Decorative trust theater** — no fabricated metrics, no fake logos, no invented testimonials;
  simulated faults are explicitly tagged `SIMULATED` via `.chip-sim`.
- **Copy-shaped decoration** — the copy is load-bearing throughout, with a documented banned-strings
  list in `ui-spec.md` §6.1.
- **CSS as counterfeit asset** — no fake imagery anywhere.
- **Missing reduced-motion path** — fully handled at `styles.css:591`.
- **Scroll-state rendering** — vanilla listeners, no per-frame state churn.
- **Bento without rhythm**, **Split-header filler**, **Zigzag monotony**, **Default centered hero**,
  **Repeated spectacle**, **Generated-world drift** — not applicable or not present.

### Craft defects found outside the catalog

- **`.ev-grid` does not do what it declares.** Written as `grid-template-columns:1fr 1fr`; it
  *resolves* to **139.4 px / 558.7 px** because `.formula{white-space:pre}` sets a large
  `min-content` on the second track. Consequence at 1280×800: `#evidence-body` has a **726 px
  scrollWidth inside a 563 px box**, the formula block's right edge sits **148 px past the panel
  edge** and is clipped mid-line, and the "What we observed" key–value list — the part an operator
  actually reads — is crushed into 139 px.
- **Contrast.** `--on-warn #FFFFFF` on `--warn #A66A00` = **4.48:1** at 12 px — below AA for the
  most-pressed control in the product (`Review & decide →` ×9, `Review queue →`).
  `--warn` on `--warn-bg` = **3.97:1**, used for `.cp-kind`, `.chip-sim`, `.pause-badge` at
  10–11 px. Disabled decision buttons sit at `opacity:.45`, taking the approve label to roughly
  1.9:1 while the operator is reading the very screen that explains why it is disabled.
- **Text below any defensible floor.** `.legend-rings li`, `.legend-misc li` and `.legend-foot` are
  set at **9.5 px**; 106 elements sit at 10 px. Even the Bloomberg recipe floors at 11.
- **Hue collisions in the semantic layer.** Measured hue angles —
  `--sil-3 #B8933F` = 42° vs `--warn #A66A00` = 38° (**4° apart**);
  `--sil-5 #B03410` = 14° vs `--critical #B3261E` = 3° (**11° apart**).
  Dark mode is no better: `--sil-3` 44° vs `--warn` 40°, `--sil-5` 16° vs `--critical` 5°.
  The top of the silence ramp and the system-failure colour are the same red; the middle of the
  ramp and the pending-decision amber are the same amber. An operator glancing at the map cannot
  distinguish *"this place has been silent 96 h"* from *"this source is down"* by hue.
- **Palette breadth.** 11 named colour roles in play (6 ramp steps + accent + ok + warn + critical
  + nodata) against `critique-guide.md`'s guidance of ~4 families. A sequential ramp legitimately
  counts as one — but the four semantics on top of it are two too many, and two of them collide
  with the ramp.
- **Tablet: the map is pinned above every tab.** `.region-map{order:-1;height:46dvh}` at ≤1023 px
  applies regardless of the selected tab. Working the Checkpoint queue on an 820-wide tablet spends
  **46% of the viewport on a satellite photograph** while the decision list scrolls in the
  remaining half. Verified in-browser.
- **Screen-area allocation at 1600×1000** (measured, console area 1,357,456 px²):
  map **33.0%**, rank **22.5%**, evidence **18.1%**, checkpoint **13.1%**, activity **13.1%**.
  On cold open, evidence is empty ("Nothing selected") — **18.1% of the console is a placeholder**,
  and **13.1% is a log in which 12 of 18 visible entries are the same message**
  (`LLM FALLBACK — Tier-3 budget exhausted (6 calls); "…" left unresolved`). That log has exactly
  the same area as the human-decision queue and out-shouts it by repetition, which trains the
  operator to ignore the panel that also carries `SOURCE DEGRADED`.

### The decision dialog — measured against the prize criterion

The target prize asks for an interface that *"asks before the irreversible step rather than after
it."* The dialog asks. It does not yet **show what it is about to do**, and it hides the
uncertainty at the moment of signing.

Measured with the dialog open (820×1180; the 1600×1000 figures are the same shape):

| Section | `offsetTop` in `.dlg-body` |
|---|---:|
| What we observed | 338 |
| How the number was reached | 590 |
| **What we do not know** | **866** |
| Reports behind this | 992 |

`.dlg-body` clientHeight is **536 px** against a **786 px** scrollHeight. **"What we do not know" —
the sentence that says *we do not know whether Thakre is quiet, unreachable, or simply unreported*
— starts 330 px below the fold and is never visible unless the operator scrolls.** The block above
it, "How the number was reached", is a monospace derivation (λ, `exp(−λ·t)`, surprisal, Gi\* z)
plus a seven-line statistical prose paragraph at 11 px, and it occupies roughly 250 px of the
536 px viewport — the largest and least actionable block in the dialog.

And the button says **"Approve — release shortlist"** while `app.js:1319–1323` shows the shortlist
**only in the post-decision success block**. The operator signs their name to releasing a list they
have not seen. Both buttons render at identical 44 px with equal visual weight and
`opacity:.45`, so the irreversible action is not distinguished from the reversible one, and nothing
adjacent to them states the gate ("enter your name to enable") — the helper text explains what the
name is *for*, not that it is *required to proceed*.

---

## 5. Prioritised changes

Ordered by impact on an EOC operator's ability to scan, compare, decide and be accountable —
not by visual appeal. Each names the element, the current value, and the target.

### P0 — the product's claim is not visible

**1. Put the finding on the screen in words, at 32 px.**
- Current: the number 23 exists only as a 10 px numeral inside a 76×26 px filter chip.
- Target: a single line above the board, `32px / --f-display / 1.15`, built from
  `stats` + `settlements[]`: *"23 of 32 settlements have produced no report in 96 hours."*
  With a second line at 13 px: *"Silence is not confirmation that a place is quiet."*
  Nothing else on the screen is permitted to exceed 20 px.
- **Why for an EOC operator:** shift handovers happen every few hours and the incoming officer
  must absorb the state of the corridor before they touch anything. Today that requires decoding a
  filter chip. It is also the only element a supervisor can read from across the room, and the only
  one a stranger can read in three seconds.

**2. Rebuild the rank list so all 32 settlements fit without scrolling.**
- Current: `.rank-row` measures **69.6 px**; `padding:6px 8px`; two-line `.rank-name` stack plus a
  wrapped `.rank-badges` row. 11 of 32 visible at 1600×1000, 6.1 at 820×1180.
- Target: **26–28 px per row**. One line: `#` · name at **15 px** with district as a 12 px suffix ·
  `Silent` · `Gi* z` · `Corr`. The `no data reached us` chip becomes a single dedicated column with
  one glyph and a column header that carries the words once. `⏸ decision pending` becomes a 3 px
  right-edge rule in `--warn`. All 32 rows = 896 px = one column, no scroll, at 1600×1000.
- **Why for an EOC operator:** the operator's actual task is ranking, not lookup. "Is the gap
  between rank 1 and rank 8 meaningful?" is unanswerable when rank 8 is below the fold. Seeing 23
  consecutive rows at 96.0 h as one unbroken block is the argument the product exists to make, and
  it only exists when the rows are adjacent.

**3. Reorder the decision dialog and show the shortlist before approval.**
- Current: `What we do not know` at `offsetTop:866` in a 536 px viewport; shortlist rendered only
  after the decision (`app.js:1319`).
- Target order: (1) the no-dispatch rule bar — keep it where it is; (2) **What we do not know**;
  (3) **What approving releases** — the actual alphabetical committee list, rendered from a
  dry-run, before the button; (4) What we observed; (5) How the number was reached, collapsed
  behind `<details>` open-by-default-off. Approve at full weight, Reject as a quiet secondary, and
  a literal line above them: *"Both buttons stay unavailable until you type your name."*
- **Why for an EOC operator:** this is the accountability moment. The officer's name is written
  permanently to the record and cannot be edited. They must be able to see the limits of the
  evidence and the exact consequence of the click in the same viewport as the click. It is also
  the precise thing the prize is testing.

**4. Make the pipeline rail legible at every width.**
- Current: six `.rail-seg` pills measured 31–42 px at 10 px with `overflow:hidden`
  (`✓Ingest` → `✓In`); `.rail-track{display:none}` below 1024 px; `.rail{display:none}` below
  768 px. The `.cmdbar` at 1600 px is 100% packed — eight flex children summing to 1599 px — which
  is *why* the rail is squeezed to 324 px.
- Target: move the rail out of the command bar into the persistent bottom bar beside the checkpoint
  count, as a full-width six-segment track at **12 px** with complete labels, a determinate fill on
  the active stage, and an explicit terminal state
  (`Ready · last complete pass 10 min ago · next in 3:12`). Never hidden below 1024 px. Retire the
  `Last pass: 37081ms` string and the `21 clusters` stat to make room.
- **Why for an EOC operator:** before trusting a ranking, the operator must know whether the run
  that produced it finished. "Was that a complete pass or did ingest fail?" changes whether they
  escalate. It is also the literal first clause of the prize criterion — *show what the agent is
  doing* — and it currently renders as six illegible stubs.

### P1 — scanning and trust

**5. Demote the map; make Plain the default; take the terrain raster off the critical path.**
- Current: `#region-map` = 33.0% of console area, `height:46dvh` on tablet regardless of active
  tab, Terrain default, 21 overlapping label pairs at 1600×1000, 7 of 32 labels at 820 wide.
- Target: map to ~22–24% of console area beside a wider board; **Plain as the default basemap**
  with Terrain as an opt-in layer; labels drop the second `96.0h` line (it duplicates the `Silent`
  column) and use a collision-avoidance pass with leader lines for the confluence cluster; on
  tablet the map collapses to a strip when the Checkpoint or Activity tab is active.
- **Why for an EOC operator:** in the Trishuli corridor the operator already knows the geography;
  what they cannot hold in their head is the ranking. Spending a third of the console on hillshade
  that encodes no variable, and 46% of a tablet on it while triaging decisions, inverts the
  priority. Anonymous dots are worse than no dots — an unlabelled marker cannot be acted on.

**6. Separate silence hue from alert hue.**
- Current: `--sil-3` 42° vs `--warn` 38°; `--sil-5` 14° vs `--critical` 3°.
- Target: keep the ordinal ramp but end it before the critical red — either stop the warm end at
  `--sil-5 = #C96B14` (29°) and give `--critical` the only true red on the screen, or move the ramp
  to a single-hue luminance ramp so hue is reserved entirely for semantics. Move
  "human decision pending" off amber-as-hue onto a shape signal (filled square + edge rule),
  consistent with the existing and excellent shape-encodes-anomaly-type decision.
- **Why for an EOC operator:** during a live response, "this settlement has been dark for four
  days" and "our feed from this district just died" demand completely different responses. Today
  they are 11° apart on the same screen.

**7. Raise the type floor to 12 px and fix the amber contrast.**
- Current: 9.5 px on `.legend-rings li` / `.legend-misc li` / `.legend-foot`; 106 elements at
  10 px; `--on-warn` on `--warn` = 4.48:1 on the most-pressed button; `--warn` on `--warn-bg`
  = 3.97:1.
- Target: **12 px floor everywhere**; darken `--warn` to reach ≥4.5:1 against both white and
  `--warn-bg` (roughly `#8A5600`), or set the amber button's label in `--ink` on a lighter amber
  fill; replace `opacity:.45` on disabled buttons with a token pair that holds ≥3:1.
- **Why for an EOC operator:** EOC displays are projectors and whatever monitor was in the room,
  read at 2 a.m. by someone on hour fourteen. A 9.5 px legend is functionally absent, and the
  legend is the only place the map's encoding is ever explained.

**8. Group the Activity feed's repetitions.**
- Current: 12 of 18 visible entries are `LLM FALLBACK — Tier-3 budget exhausted (6 calls); "…"
  left unresolved`, in a 424 px pane with exactly the same area as the checkpoint queue.
- Target: collapse identical consecutive kinds into one row with a count
  (*"6 items unresolved — Tier-3 LLM budget exhausted"*, expandable), and give
  `SOURCE DEGRADED` / `COLD START` visual precedence over `LLM FALLBACK`.
- **Why for an EOC operator:** a feed that cries wolf twelve times in a row is a feed the operator
  stops reading — and it is the same panel that will carry the one line saying a data source has
  died, which is the only Activity entry that changes what they should trust.

### P2 — craft consolidation

**9. One radius grammar; remove the left-border accent cards.**
- Current: 13 radius values; five `border-left:3px solid` accent containers.
- Target: `0` for panels, tables, inputs and the dialog; `2px` for chips and buttons; `50%`
  reserved for map marks only. Replace the nine `.cp-card` containers with one surface divided by
  hairline `--line` rules, urgency carried by rank order and a leading rank number rather than by
  nine amber edges.
- **Why for an EOC operator:** nine identically-weighted containers give no triage order. A single
  ruled list with a rank column tells the operator where to start.

**10. Retire the violet accent `#5B4BD6`.**
- Current: the highest-chroma element on a flood console is the `Run pipeline` button, and the same
  violet also carries the `.rule-bar`, the sort arrows, the segmented-control active state, focus
  rings, links and the ambiguous-match kind — six unrelated meanings on one hue.
- Target: one accent under the Vignelli rule (§6), used for *selection and focus only*; the rule
  bar carried by `--ink` on `--panel-2` with a rule, not by chroma; `Run pipeline` demoted to a
  secondary control, since the operator's primary action is *Review queue*, not *re-run*.
- **Why for an EOC operator:** the loudest thing on the screen should be the thing that needs a
  human. Today it is a button that re-runs a pipeline that re-runs itself.

**11. Rebuild the type scale around a real hierarchy.**
- Current histogram: 9.5(11) · 10(106) · 11(208) · 12(244) · 13(20) · 14(40) · 15(3) · 17(1) · 20(1).
- Target: **32 / 20 / 15 / 13 / 12**, with 12 px the absolute floor and 11 px permitted only for
  true uppercase micro-labels if a specific case demands it. Ratio headline:caption = 2.7×.
- **Why for an EOC operator:** with 89.7% of the screen at one size, there is no visual triage —
  everything demands equal reading effort, and under time pressure that means nothing gets read.

**12. Fix `.ev-grid`.**
- Current: declared `1fr 1fr`, resolves to `139.405px 558.653px`; `#evidence-body` scrollWidth 726
  in a 563 px box at 1280×800; the formula block clipped 148 px past the panel edge.
- Target: `grid-template-columns: minmax(0,1fr) minmax(0,1fr)` (or `minmax(0,320px) 1fr`) and
  `.formula{white-space:pre-wrap; overflow-wrap:anywhere}` — or move the derivation behind a
  `<details>` so it stops driving the track sizing.
- **Why for an EOC operator:** the evidence panel is where they check the machine's reasoning
  before trusting a rank. Right now its most-read column is 139 px wide and its math is cut off
  mid-equation at the most common laptop width.

---

## 6. Recommended visual direction

**Anchor: `bloomberg-terminal` for structure and behaviour, `vignelli-swiss-helvetica` for
typography, colour discipline and voice, with one Tufte constraint applied to the map and evidence
panel.**

This is a deliberate two-recipe marriage. `style-recipes/INDEX.md` says remixes work *"only when
the user explicitly asks and you can articulate why the marriage is coherent."* The articulation:

**Bloomberg supplies the workspace.** Multi-pane layout with hairline dividers; radius 0; no
shadow, elevation by 1 px rule only; tabular monospaced numerals with right-aligned digit columns;
colour-coded deltas; a persistent status bar; keyboard-shortcut chips in the margins; instant state
flips with a 50–80 ms flash on data update. Every one of these makes a practitioner faster and
costs a first-time viewer nothing — they are structural, not stylistic. The current build already
reaches for several of them (mono tabular numerals, a status strip, a `1px` grid gap that draws
dividers) and should commit fully.

**Bloomberg's typography and chrome are rejected, deliberately.** Two reasons, one general and one
specific to this product:

1. Its own *Don't use when* rules out an audience that will bounce in three seconds. That is the
   judge. 11 px mono body is the part of the recipe that is an acquired taste, and it is separable
   from the density (§3).
2. **Bloomberg amber would collide with the one semantic this product cannot afford to blur.**
   In Signal Zero, amber already means *a human decision is pending here* — the checkpoint kind,
   the pause badge, the bottom bar, the map `⏸` glyph. Adopting `#FFA02F` as brand chrome would put
   the product's most important state signal into the same visual channel as its wallpaper. The
   recipe's signature move is the one move this product must not make.

**Vignelli supplies exactly what Bloomberg's rejected half was doing.** From
`vignelli-swiss-helvetica.md`: *hierarchy by size, not weight or colour*; *black and white plus one
accent — never two*; *an 8 px baseline grid*; *information sets get tabular layouts with strict
baseline alignment*; *a single oversized number at the top-left of each block*; *matter-of-fact
copy, never friendly*. This is the transit-signage school — a design tradition whose entire purpose
is being read correctly by a stranger, under stress, in seconds, in a public institution. That is
simultaneously the judging condition and the EOC condition. The recipe's own *Don't use when*
warns it reads as "institutional / cold" — which is the correct register for a government tool
during a disaster, and is already the register of the product's copy.

The single oversized number is the direct fix for §4.6: **23**, set large at the top-left of the
silence board, is the Vignelli move and the missing hero fact in the same gesture.

**Tufte contributes one constraint, not a whole system:** maximum data-ink on the map and evidence
panel. Kill the photographic ground (`asset-dependence 6 → 3`), direct-label the marks rather than
relying on a legend that occludes 18–35% of the map, and demote the derivation block to a margin
note rather than a 250 px monospace slab in the decision path. Do not adopt Tufte's serif body or
12–14 px reading size — its own *Don't use when* excludes interactive filtered products and small
viewports, both of which this is.

**`nyt-the-daily` is explicitly rejected** despite being named in the same school: its *Don't use
when* says *"the product is a SaaS dashboard — NYT craft reads as overformal there"*, and a serif
authority voice on a government console with no editorial claim would read as cosplay.

### Concrete direction values

| | Value |
|---|---|
| **Ground / surfaces** | Near-black `#0B0E11` ground, `#14181C` panel, `#1A2026` raised (dark-first, as an EOC runs dark). Light mode holds the current `#EEF1F4` / `#FFFFFF` structure. |
| **Rules** | Single hairline `1px` in `--line`. **No shadows anywhere** except the modal scrim. Elevation is a rule, not a blur. |
| **Radius** | `0` panels/tables/inputs/dialog · `2px` chips and buttons · `50%` map marks only. Three values, assigned by role. |
| **Type** | Display + UI: a grotesque with real institutional weight range — **Archivo** or **Inter Tight** at 500/600 (Space Grotesk is acceptable if kept, but it must appear at 32 px, not only at 13 px uppercase). Numerals: **JetBrains Mono**, `font-variant-numeric: tabular-nums`, unchanged — this is already correct. Scale **32 / 20 / 15 / 13 / 12**, 12 px floor. |
| **Accent** | **One.** Selection and focus only. A cool institutional blue outside the ramp's 199–205° band and far from every semantic hue — e.g. `#0033A0` (Vignelli's blue) in light, a lifted `#5C8FE8` in dark. The violet `#5B4BD6` retires. |
| **Silence ramp** | Keep the ordinal ramp and the no-green rule; end the warm terminus before critical red (§ P1-6). It remains the product's signature and its best existing idea. |
| **Semantics** | `--critical` owns the only true red. `--warn` keeps pending-decision but gains a shape partner. `--ok` and `--nodata` unchanged. |
| **Spacing** | 8 px baseline grid: `4 / 8 / 12 / 16 / 24 / 32`. Rank rows on a 28 px rhythm; checkpoint rows on 56 px. |
| **Motion** | Instant state flips. One 60 ms flash on a silence-band change. `flyTo` retained on selection at ≤220 ms. No infinite loops. |

### The stranger test, restated as an acceptance condition

Three things a first-time viewer must get in the first fifteen seconds, none of which costs
density:

1. **One sentence at 32 px** stating the finding — *"23 of 32 settlements have produced no report
   in 96 hours."*
2. **Column headers in plain words** — `Silent for` / `How unlikely that is` / `Reports that
   reached us`, with `silenceHours` / `Gi* z` / `corroborationCount` as a 12 px second line for
   the practitioner. Today a stranger meets `Gi* z` cold with only a `title` tooltip.
3. **The decision dialog opening on what we do not know and what will be released**, not on a
   λ derivation.

If those three land, the console can run at delivered density 7 — full 32-row board, full 9-item
queue, a persistent stage rail — and still be drivable cold. That is the resolution of the tension:
**take the density from Bloomberg, take the legibility from Vignelli, and never buy one with the
other.**
