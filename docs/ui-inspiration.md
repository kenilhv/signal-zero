# Signal Zero — UI/UX research dossier: from competent to extraordinary

Research pass for the "Best UI" push. Method: web search + page fetches against real award
galleries, animation-craft references, WebGL/mapping docs, and absence/missing-data literature,
cross-checked against what already exists in this repo (`docs/ui-spec.md`, `docs/ux-critique.md`,
`web/*`). Every recommendation below states what it is, why it works, how to build it with real
library names and values, and whether it belongs in a life-safety product — because the fastest way
to lose this prize is a 3D flourish that reads as cosplay over a disaster that killed 389 people.

**Read this against, not instead of, the existing specs.** `ui-spec.md` and `ux-critique.md`
already did the hard information-architecture and honesty work: the `--sil-0…5` ramp, the
no-dispatch rule, the named-human gate, the region layout, the Bloomberg/Vignelli/Tufte direction,
and a `motion-intensity` dial explicitly held at **2**. This dossier does not propose blowing that
dial open. It proposes spending the motion and dimensionality budget on a small number of moments
that *make the thesis felt* — chiefly the absence problem in §4 — rather than on volume of
animation. "Plenty of animation" and "disciplined motion" are compatible if the plenty is in the
*number of small, meaningful state changes* (rank flashes, frozen pulses, stagger-ins, camera
settles) rather than in amplitude or decoration per element.

---

## Top 15 highest-impact moves for Signal Zero, ranked

Ranked by (thesis-legibility gain) × (judge-visible in 3 minutes) × (feasible with no build step).
Each links to its full writeup in the numbered sections below.

1. **Frozen-pulse marker ring** — animate a ring on every settlement marker that *would* complete
   one breathing cycle at the settlement's own expected reporting interval (`1/λ` from the model
   the pipeline already computes); for silent settlements the ring is stalled mid-cycle, desaturated,
   with a static "stopped clock" notch. This is the single highest-value idea in this document —
   it turns the product's own math into the animation, so the motion *is* the evidence, not a skin
   on top of it. §4.1.
2. **Void/negative-space silence encoding on the map** — invert the usual "loud color = danger"
   convention: the longer a settlement has been silent, the more the map *darkens and recedes*
   around it, encroaching over the corridor lines. Presence looks like a lit place; absence looks
   like the dark spreading. §4.2.
3. **One somber hero count-up, no bounce** — the "23 of 32 settlements" headline (already specified
   as P0 in `ux-critique.md`) animates in with a monotonic ease-out count, zero overshoot, ~900ms.
   A grim number should never bounce. §2.3, §6.6.
4. **Staggered rank-row entrance** — 28–32px rows, `translateY(6px)→0`, `opacity 0→1`,
   **28ms per-row stagger**, `cubic-bezier(0.16,1,0.3,1)`, total sweep ≈ 900ms for 32 rows. Runs on
   first load and after a pipeline re-run, never on every 4s poll. §2.1.
5. **60–80ms flash-on-update, direction-aware** — already recommended in `ux-critique.md` P1 as a
   plain background flash; sharpen it into two flashes (silence got worse vs. a report resolved it)
   using the same ramp tokens, never a new hue. §2.4.
6. **Cinematic terrain tuned, not decorated** — MapLibre `setSky()` + `setFog()` + a low-angle light
   position + `exaggeration: 1.5` (already spec'd) to get real rim-lit ridgelines at the Trishuli
   valley's actual terrain, with fog density tied to *time since last complete pipeline pass* so the
   map itself visibly "un-focuses" when data goes stale. §3.1, §4.6.
7. **Corridor contagion arcs** — draw the Gi* adjacency graph (already planned as static lines in
   `ui-spec.md` §4.4) as animated propagation pulses only when a *new* silent-cluster forms, showing
   the statistical contagion the Gi* z-score is detecting — not a generic "data flowing" flourish.
   §3.3, §4.4.
8. **Sonar-sweep timing layer** — a slow conic sweep synced to the actual poll interval, framed
   explicitly as "how often we check for new reports," not as an active probe of settlements (honesty
   guardrail, §4.3). Silent settlements produce visibly *nothing* when the sweep passes over them.
9. **Empty-tail timeline sparkline** — in the evidence panel, a per-settlement report-arrival
   timeline where the *empty stretch* at the end is drawn longer and starker than the ticks — Tufte
   data-ink turned toward absence instead of presence. §4.5.
10. **Reorder + choreograph the decision dialog** — already spec'd content order fix in
    `ux-critique.md` P0-3; add a deliberate, un-bouncy 260ms crossfade/slide when "What we do not
    know" scrolls into primary position, so a rushed reader's eye is *pulled* there, not just placed
    there. §2.5, §6.1.
11. **Branded focus rings + magnetic-free hover craft** — 2px solid + 4px halo (already in the CSS
    per `ux-critique.md`), extended to every new element with WCAG 2.2's 3:1 non-text contrast rule
    verified, no "magnetic button" gimmicks (wrong register for this product). §6.2.
12. **Typography: commit Archivo (or keep Space Grotesk) at real display size + JetBrains Mono
    tabular numerals everywhere** — both on Google Fonts, both already partially wired; the fix is
    using the display face at 32px instead of only 13px uppercase labels. §5.1.
13. **Kill the violet, adopt one institutional accent + NASA-style semantic color discipline** —
    a single blue/amber pair with glyph+text redundancy, modeled on real ATC color-usage guidance,
    not a SaaS gradient. §5.2, §5.3.
14. **GSAP (free, CDN, zero build step) as the orchestration layer** for stagger, ScrollTrigger-free
    JS-timeline sequencing of the checkpoint dialog and camera moves — a real, current, license-clean
    choice for "plenty of animation" without a bundler. §2.6, §3.5.
15. **Skeleton-to-content as a FLIP morph, not a swap** — the skeleton bar's exact box becomes the
    real content's box via a first-last-invert-play transform, so loading reads as "the data arrived
    into this shape" rather than "the skeleton was replaced." §6.5.

**Deliberately excluded from the top 15, and why:** a rotating 3D globe intro (wrong geography — this
is one valley, not a planet, and a spinning-globe cold-open is now the single most common AI-generated
dashboard cliché); particle-system backgrounds behind the console (tested against the product's own
`prefers-reduced-motion` commitment and the "never fabricate" rule — ambient particles look like they
mean something and mean nothing); a custom cursor (craft signal on a portfolio site, noise on a tool
someone drives with a keyboard under stress); sound design as a default-on feature (see §6.7 — audio
alarms in a room of officials is a liability, not a delight).

---

## 1. Award-winning dashboard / data UI

### 1.1 What the current galleries actually reward (verified by browsing, not assumed)

Awwwards' [data-visualization category](https://www.awwwards.com/websites/data-visualization/)
right now is dominated by two families, neither of which is "add more chrome":

- **Restraint sites**: [Signal IQ by Setu/Pine Labs](https://marketing.pinelabs.com/signaliq) and
  [HydraDB](https://hydradb.com/) — financial/DB monitoring products that win on typographic
  confidence and one strong motion idea (usually a hero metric that resolves via motion) rather than
  many small ones.
- **Single-thesis sites**: [Where the Shadow Fell](http://eclipses.bogachev.fr) — an eclipse-path
  data visualization that is the closest genre match to Signal Zero: real geography, a map that
  *is* the argument, minimal chrome, one phenomenon explained through motion and camera. Worth
  studying specifically for how a *geographic, time-based, single-phenomenon* story is told without
  becoming a generic dashboard.

**Technique inventory you can name and reuse** (synthesized from the award pool and the animation
research below, not vibes):

| Technique | What it is | Fit for Signal Zero |
|---|---|---|
| **Bento grid** | Modular grid of unequal-sized cards forming an asymmetric mosaic | Already rejected correctly in `ux-critique.md` (cardification, §4.3) — the checkpoint queue is being *de*-cardified. Do not reintroduce. |
| **Kinetic hero number** | One oversized statistic that animates in, dominates the fold | **Adopt.** This is exactly P0-1 in `ux-critique.md` (23 of 32, at 32px). Section 2.3 below gives the exact tween. |
| **Scroll-choreographed reveal** | Content enters as the user scrolls, pinned/staged sections | **Reject as primary pattern.** Signal Zero is a single-viewport operational console, not a scrollytelling story — an EOC operator does not scroll to discover the pending-decision count. Reserve scroll-triggered reveal for exactly one place: the evidence panel's "How the number was reached" derivation, already spec'd to sit behind a closed `<details>`. |
| **Command-center dark chrome** | Near-black ground, hairline rules, monospace figures, status strip | **Already the direction** per `ux-critique.md` §6 (Bloomberg-for-structure). Confirmed as the right genre by the [command-center dashboard search on Dribbble](https://dribbble.com/search/command-center-dashboard) and [Godly's](https://godly.design/) curated commercial-dashboard entries — the pattern that reads as "serious tool" across both award circuits is the same one already chosen. |
| **Live-data pulse chip** | A small dot/glyph that visibly updates on poll, proving liveness | **Adopt, redirect.** Most dashboards use this to prove *the system* is alive. Redirect it in §4 to prove *the settlement* is (or isn't). |

### 1.2 The genre lesson

The award sites that read as "best UI" for data/ops products are not winning on 3D or particle
count. They are winning on **one correct, load-bearing idea executed with total typographic and
motion discipline** (`eclipses.bogachev.fr`'s single phenomenon; Signal IQ's one hero metric).
Signal Zero already has that one idea — silence ranked over volume — and the entire job of this
dossier is to make that idea the thing the motion, color, and dimensionality serve, not to add a
second, competing spectacle.

### 1.3 Real control-room references (grounding, not aesthetic cosplay)

- [NASA's Air Traffic Management color-usage guide](https://colorusage.arc.nasa.gov/ATM_1.php) —
  a real, applied government spec for exactly this genre of interface: color reserved for a small
  number of operationally meaningful states, redundant glyph+text encoding, restrained palette. This
  is a stronger citation for Signal Zero's palette decisions than any dashboard gallery, because it
  is an artifact from the actual professional tradition Signal Zero is imitating (see §5.3).
- [NASA Mission Control Center diagram, Smithsonian Air & Space Museum](https://airandspace.si.edu/multimedia-gallery/image/nasa-consolesjpg) —
  the layout lesson is a *bank of specialized consoles*, each owning one question, not one dashboard
  trying to answer everything — which maps directly onto Signal Zero's five-region layout (rank /
  map / evidence / checkpoint / activity) already in `ui-spec.md` §1.1.
- Bloomberg Terminal — already the anchor recipe in `ux-critique.md` §6; the [IDEO redesign story](https://medium.com/@katschoi/bloomberg-saving-private-ryan-and-the-art-science-of-design-75f3cad054d9)
  is worth reading once for the underlying lesson: professional users' speed is trained on density
  and stable layout, and redesigns that optimize for a first-time viewer at the expense of a
  practitioner's muscle memory *fail in the field even when they test well in a demo*. This is the
  same tension `ux-critique.md` §3 already names between the EOC operator and the three-minute judge
  — cited here because it is independent evidence the tension is real, not invented for this project.

---

## 2. Motion and animation that serves data, not decoration

Two independent, current sources agree closely enough that their numbers should be treated as an
industry consensus, not a single opinion: Emil Kowalski's
[animation review standards](https://github.com/emilkowalski/skills/blob/main/skills/review-animations/STANDARDS.md)
(the animator behind Vercel/Linear-adjacent craft writing) and Vercel Labs'
[web-animation-design skill](https://github.com/vercel-labs/open-agents/blob/main/.agents/skills/web-animation-design/SKILL.md).
Motion.dev's [easing-functions reference](https://motion.dev/docs/easing-functions) supplies the
underlying math.

### 2.1 Durations and stagger — the numbers that read as "crafted"

| Element | Duration | Source |
|---|---|---|
| Button press feedback | 100–160ms | Kowalski standards |
| Tooltip / small popover | 125–200ms | Kowalski standards |
| Dropdown / select | 150–250ms | both sources agree |
| Modal / drawer | 200–500ms (Kowalski) / 200–300ms (Vercel) | use 260–300ms for the checkpoint dialog — it is the highest-stakes surface, deserves the top of the range, never the bottom |
| **Hard ceiling for any UI animation** | **300ms** | both sources state this explicitly |
| Stagger between list items | **30–80ms** (Kowalski) / confirmed by [30 Seconds of Code's staggered-list pattern](https://www.30secondsofcode.org/css/s/staggered-animation/) | for Signal Zero's 32-row board, use **28ms** (see math below) |

**Why 28ms specifically, not a round 40 or 50:** at 32 rows, 40ms/row costs 1.28s to sweep the full
board — noticeably slow for a re-rank after a pipeline run the operator is impatiently watching.
28ms × 32 = 784ms, inside the "feels immediate but visibly sequential" band both sources describe.
Cap the *total* stagger sweep at 900ms regardless of row count (formula:
`stagger = min(28, 900/rowCount)`), so a future gazetteer expansion beyond 32 settlements doesn't
silently produce a multi-second waterfall.

### 2.2 Easing curves — exact values, and which one for which motion

- **Strong ease-out**, for anything entering or responding to the user:
  `cubic-bezier(0.23, 1, 0.32, 1)` (Kowalski) — near-identical to
  `cubic-bezier(0.19, 1, 0.22, 1)` ("expo-out," Vercel). Use this for row entrances, the hero
  count-up's deceleration, marker selection rings.
- **Strong ease-in-out**, for on-screen movement between two states (camera flyTo, evidence panel
  swap): `cubic-bezier(0.77, 0, 0.175, 1)` (Kowalski) or `cubic-bezier(0.86, 0, 0.07, 1)` (Vercel,
  "quint"). Signal Zero's map already uses MapLibre's own `easeTo`/`flyTo` curves — leave those as
  MapLibre's internal defaults (they already approximate this family) and reserve a custom curve for
  DOM elements only.
- **iOS-style drawer curve** `cubic-bezier(0.32, 0.72, 0, 1)` — good fit for the evidence-panel
  slide-over sheet already spec'd for the 1024–1279px breakpoint (`ui-spec.md` §1.4).
- **Never `ease-in` alone on anything the user is watching** — both sources call this out explicitly:
  it front-loads the wait exactly when attention is highest. If existing CSS has `ease-in` on
  anything user-facing (check `styles.css`), replace it.

### 2.3 The hero count-up — exact spec for "23 of 32 settlements"

This is `ux-critique.md` P0-1 (a static 32px line) upgraded with motion, because a number this
important earns one deliberate animation, not because every number should animate.

- **Library**: [CountUp.js](https://github.com/inorganik/CountUp.js) — zero dependencies, works as a
  plain `<script>` tag from a CDN (`https://cdn.jsdelivr.net/npm/countup.js@2/dist/countUp.min.js`),
  no build step, MIT license.
- **Config**: `duration: 0.9` (seconds), `useEasing: true`, **but override the default elastic-ish
  easing with a monotonic ease-out** — CountUp's default `easingFn` can overshoot slightly; pass a
  custom `easingFn` implementing `cubic-bezier(0.23, 1, 0.32, 1)` or simply set
  `useEasing: true` with `useGrouping: false` (no thousands commas needed at this scale) and confirm
  in testing that it never ticks past 23 and back down. **A grim number must never overshoot and
  correct itself** — that reads as a slot machine, which is the single worst tonal note this product
  could hit.
- **Trigger**: once, on first successful `/api/state` resolution and again only when the *value
  changes* after a pipeline run (compare previous vs. new count) — never on the routine 4s poll if
  the number is unchanged. Re-triggering an unchanged number is the "AI-generated feels cheap" tell
  named in the animation research: motion with no informational delta reads as decoration.
- **Reduced motion**: render the final value immediately, no tween — CountUp.js supports this via
  skipping `.start()` and calling `.printValue()` directly, gated on
  `matchMedia('(prefers-reduced-motion: reduce)').matches`.

### 2.4 Flash-on-update — sharpened from `ux-critique.md`'s recommendation

The critique already proposes a 50–80ms background flash on rank-row change (the Bloomberg
"blink on data update" pattern). Two refinements from the animation research:

- **Duration**: 60ms flash-in, 400ms fade-out of the flash (not a symmetric blink) — a fast attack
  and slow release is what reads as "something changed here" rather than "something is broken/
  glitching." This matches the general craft rule that entrances are fast and exits/settles are
  comparatively slow.
- **Two directions, one hue family**: a settlement moving to a *worse* silence band flashes with the
  ramp's own warmer stop at 25% opacity (never a new red); a settlement whose silence *resolved*
  (a report arrived) flashes with `--ok` at 25% opacity, once, then settles into its new row position
  via the same 28ms-stagger reflow. This directly serves an EOC operator's actual question — "did
  anything just get worse, or better" — with zero new color vocabulary.

### 2.5 Choreographing the checkpoint dialog (ties to `ux-critique.md` P0-3)

The critique already specifies reordering the dialog so "What we do not know" sits above the fold.
Motion can reinforce that reorder instead of just repositioning it:

- On dialog open, the rule bar and "What we do not know" block fade/slide in first
  (`translateY(4px)→0`, 220ms, strong ease-out), 80ms *before* "What we observed" and the evidence
  list, which follow at the standard stagger. This uses motion order to teach reading order — the
  operator's eye is drawn to the caveat before the confidence-inspiring numbers, which is the
  correct sequence for an accountability decision.
- The name field and both buttons never animate in with a delay — they should feel *immediately
  present but inert* (per the existing `aria-disabled` gate), so the operator never waits on
  animation to reach the point where they can start typing their name.

### 2.6 GSAP as the orchestration engine — current, free, no-build

[Webflow made GSAP (including every previously-paid Club plugin — ScrollTrigger, SplitText,
DrawSVG, Inertia) 100% free for commercial use as of April 2025](https://webflow.com/blog/gsap-becomes-free),
confirmed independently by [CSS-Tricks](https://css-tricks.com/gsap-is-now-completely-free-even-for-commercial-use/)
and GSAP's own [standard license page](https://gsap.com/community/standard-license/). This matters
concretely for a no-build vanilla-JS project: GSAP ships a plain `<script>` CDN build
(`https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js`) with a real timeline API
(`gsap.timeline()`) that is far less error-prone than hand-rolling 32 staggered CSS animation-delays
in JS. Use it specifically for:
- The rank-row stagger (`gsap.from('.rank-row', {opacity:0, y:6, stagger:0.028, ease:'expo.out'})`).
- The checkpoint-dialog choreography in §2.5 (`.timeline()` with explicit `position` offsets is more
  legible and auditable than nested `setTimeout`s — a judge who reads the code should find a clean
  sequence, not a callback pyramid).
- The map camera's one-time establishing move (§4.3 of `ui-spec.md`) if MapLibre's own `easeTo`
  proves too limited for the fog/exposure cross-fade in §3.1 below.

**Do not** reach for GSAP's `MorphSVG` or `Inertia`/physics plugins here — they are built for
playful, draggable, illustrative interfaces. Their presence in the free tier is a reason they're
*available*, not a reason to *use* them on this product.

### 2.7 What makes motion read as cheap or AI-generated — and how to avoid it here

Cross-referencing both animation sources plus the AI-slop research in §5:

- **Cheap tell #1: animating everything the same amount.** A product where every card fades in
  identically has no hierarchy in time, mirroring the flat-hierarchy problem `ux-critique.md`
  already found in *type* size (§4.6). Fix: only three motion "weights" exist in Signal Zero —
  (a) the hero count-up and dialog choreography (rare, deliberate), (b) list stagger and flash-on-
  update (frequent, small), (c) nothing else animates continuously. No ambient loops. The existing
  `@keyframes sweep` infinite loop that `ux-critique.md` flags for removal (§4.7) is exactly this
  tell — remove it as planned, don't replace it with a new ambient loop.
- **Cheap tell #2: bounce/elastic easing on data.** Bounce belongs to playful confirmation moments
  (a cart icon, a "liked" heart). It is never appropriate on a casualty-adjacent statistic. Every
  curve recommended above is monotonic ease-out or ease-in-out — none overshoot.
- **Cheap tell #3: motion that doesn't survive `prefers-reduced-motion` gracefully.** The existing
  reduced-motion block (`styles.css:591`) already removes the sweep and disables the shimmer. Extend
  the same discipline to every new animation in this document: per both animation sources, reduced
  motion means "fewer and gentler, not zero" — keep the *state change* (flash color, final rank
  position, count-up's final digits) and strip the *movement* (no translateY, no count-up tween, no
  stagger delay — everything appears in final position at once). This is directly testable: with
  `prefers-reduced-motion: reduce` forced on, every one of the 15 moves in this document must still
  communicate its information, just without the choreography. If a move fails that test, it was
  decorative and should be cut.

---

## 3. 3D and spatial techniques (no build step)

Signal Zero already commits to MapLibre GL v6.6.0 vendored locally, 3D terrain via a raster-DEM
source, and a documented degradation ladder down to a 2D SVG fallback (`ui-spec.md` §4.6). The
research below is about **making that existing 3D surface cinematic**, not about adding a second,
unrelated 3D object to the page. A rotating decorative globe next to a terrain map of one valley
would be two competing spatial metaphors on one screen — reject it outright.

### 3.1 MapLibre-native cinematic techniques (highest priority — no new library)

MapLibre GL's own [style spec `sky` object](https://maplibre.org/maplibre-style-spec/sky/) plus
`setFog()` gives real atmospheric depth without touching WebGL directly:

```js
map.setSky({
  'sky-color': '#0a1420',
  'sky-horizon-blend': 0.5,
  'horizon-color': '#1a2a3a',
  'horizon-fog-blend': 0.6,
  'fog-color': '#0d1520',
  'fog-ground-blend': 0.7,
  'atmosphere-blend': 0.8
});
```
[Fog requires 3D terrain to be active and is faded out below pitch 60°](https://maplibre.org/maplibre-gl-js/docs/examples/sky-fog-terrain/),
which is already true of Signal Zero's default camera (`pitch: 52`, per `ui-spec.md` §4.3) — this
is a same-day addition, not new infrastructure. [Jawg's worked example](https://www.jawg.io/docs/integration/maplibre-gl-js/sky-fog-terrain/)
is a good second reference for tuning values.

**Concrete, product-specific use of fog, not just prettiness (see §4.6 for the full mechanism):**
drive `fog-ground-blend` from *time since the last complete pipeline pass* rather than a fixed
value. A console whose data just refreshed reads clear; a console going stale visibly hazes over.
This makes an atmospheric effect load-bearing instead of decorative — it answers "can I trust what
I'm looking at right now" without a single new word of copy.

**Elevation exaggeration**: already spec'd at `exaggeration: 1.5` — this is the correct range;
research into Three.js terrain work generally confirms 1.3–2.0 as the band where relief reads
clearly without caricaturing the landscape (`ui-spec.md` already has this right; do not raise it
further — a cartoonish canyon reads as a video game, wrong register for a real flood).

### 3.2 Rim lighting on terrain

The atmospheric-glow/rim-light technique documented on the
[three.js forum](https://discourse.threejs.org/t/how-to-create-an-atmospheric-glow-effect-on-surface-of-globe-sphere/32852)
and [Three.js Roadmap's rim-lighting writeup](https://threejsroadmap.com/blog/rim-lighting-shader)
is built for raw WebGL scenes, but the *effect* — brightened edges at grazing viewing angles — is
approximable in MapLibre's raster-DEM hillshade layer already spec'd in `ui-spec.md` §4.2 (the
hillshade layer under the imagery at `raster-opacity: 0.55`) by setting the hillshade
`hillshade-illumination-direction` to a low, near-horizon angle (`315`–`335`) rather than straight
overhead. A low sun angle is what produces visible ridgeline rim light in real terrain shading — it
is a one-property change (`hillshade-illumination-direction`), not a new render pipeline, and it is
the single cheapest "looks cinematic" lever available on the existing map.

### 3.3 Corridor arcs — deck.gl over MapLibre, or a lighter DOM/SVG substitute

For an animated propagation effect along the corridor adjacency graph (move #7 in the top 15):

- **Full option**: [deck.gl's MapboxOverlay interleaved with MapLibre](https://deck.gl/gallery/maplibre-overlay),
  loaded via CDN (`https://unpkg.com/deck.gl@^9.0.0-beta.5/dist.min.js` +
  `https://unpkg.com/maplibre-gl@^3.0.0/dist/maplibre-gl.js` in the reference example — pin to the
  MapLibre version already vendored, v6.6.0, rather than the example's pinned v3). The
  [ArcLayer](https://deck.gl/docs/api-reference/layers/arc-layer) draws curved great-circle-style
  connections between two lon/lat points with per-arc color and width — exactly the corridor edges
  Gi* already computes adjacency over. Interleaved mode (`interleaved: true`) lets deck.gl draw
  *between* MapLibre's own layers, so an arc can sit correctly under labels and over terrain.
  MIT-licensed, actively maintained by the OpenJS Foundation (Uber's original project).
- **Lighter option, recommended first**: given only 32 settlements and a fixed corridor graph (already
  drawn as static `LineString`s per `ui-spec.md` §4.4), a full deck.gl dependency is more weight than
  the payoff justifies for a single new visual. Implement the "contagion pulse" as an SVG
  `<animateMotion>` or a small Canvas overlay drawing a moving dot/gradient along the existing
  corridor `LineString` paths only *at the moment a new silent-cluster anomaly forms* — same visual
  idea, zero new dependency, consistent with the project's existing "vanilla first, MapLibre is
  already the one big library" posture. Reach for deck.gl only if the team wants the same technique
  reused for a second layer (e.g., animated report-arrival dots) where the dependency pays for itself
  twice.

### 3.4 Radar/sonar sweep — pure CSS, no WebGL required

A [conic-gradient sweep](https://dev.to/nikolab/animated-sonar-screen-css-only-3p9f) is a
well-documented CSS-only pattern:

```css
.sweep {
  background: conic-gradient(from 0deg, transparent 0deg, var(--accent) 8deg, transparent 40deg);
  animation: sweep-rotate 12s linear infinite;
  mix-blend-mode: screen;
}
@keyframes sweep-rotate { to { transform: rotate(360deg); } }
```
This can run as a full-map overlay `<div>` positioned above the MapLibre canvas (MapLibre renders to
its own canvas; a sibling absolutely-positioned div composites fine and costs nothing on the GPU
budget MapLibre is using). **Tie the rotation period to the real poll interval** (the console already
polls `/api/state` every 4s per `ux-critique.md` — either match the sweep period to a human-legible
multiple of that, e.g. 12s, or better, tie one full rotation to the *actual pipeline run interval* if
one exists) so the metaphor is truthful rather than an arbitrary loop — see the honesty guardrail in
§4.3.

### 3.5 What is realistically achievable and what is not, on unknown conference-room hardware

`ui-spec.md` §4.6 already has a real performance guard (WebGL2 + `hardwareConcurrency >= 4` gate,
frame-time sampling, auto-fallback). Everything recommended in this section respects that ladder:

- Sky/fog/hillshade-angle changes: **free** — same draw calls MapLibre already issues, different
  parameter values.
- CSS conic-gradient sweep: **near-free** — one composited layer, no WebGL.
- deck.gl ArcLayer (if chosen over the SVG/Canvas alternative): **cheap at this scale** — 32 points,
  well under a dozen active arcs at once. deck.gl's own examples run this class of scene at 60fps on
  integrated graphics; it is not the risk. The risk is dependency weight and a second WebGL context
  fighting MapLibre's for the same GPU on truly bottom-tier hardware — which is exactly why §3.3
  recommends the SVG/Canvas path as the default and deck.gl only as an upgrade.
- **Do not** add a second full 3D scene (a Three.js globe, particle field, or shader background)
  behind or beside the map. Two WebGL contexts on unknown hardware is the scenario `ui-spec.md`'s own
  frame-time guard exists to protect against, and a decorative second scene is the one thing in this
  entire dossier most likely to actively cause the degradation ladder to fire during judging.

---

## 4. The silence / absence visual problem — the product's entire thesis

This is the hardest and most important section, because it is the one place where "extraordinary"
and "honest" are not just compatible but *the same instruction*: the more viscerally the UI makes
absence felt, the more faithfully it represents what the product actually knows. Every idea below is
built to pass a specific test: **it must communicate correctly with `prefers-reduced-motion` forced
on**, because the underlying fact (nothing happened) cannot depend on motion to be true.

### 4.1 Frozen-pulse marker ring — the flagship idea

**What it is.** Every settlement's expected reporting cadence is already a real number the pipeline
computes: `λ = 1/expectedGapHours` (visible today in the evidence panel's derivation block,
`ui-spec.md` §2.D.2). Render a thin ring around each map marker (and a matching small ring/sparkline
glyph in the rank-list row) that, *for a settlement with recent reports*, completes one soft
pulse-expand-and-fade cycle every `expectedGapHours` — a heartbeat literally timed to that
settlement's own statistical model. For a settlement that has gone silent, the ring does not pulse;
it sits at a fixed, partially-drawn arc (e.g., `stroke-dasharray` frozen at the fraction of a cycle
elapsed since the last report, capped at a visibly "stuck" position) in a desaturated version of the
same stroke color, with a small perpendicular tick — a stopped clock's hand — marking exactly where
in its expected cycle it stopped.

**Why it works.** This is the rare case where the *literal mechanism of the statistic* (a Poisson-
process time-between-events model) has a direct, non-metaphorical visual analog (a periodic pulse).
Missing-data visualization research is explicit that absence needs a **reference frame** to be
perceptible — a viewer cannot recognize "this is missing" without a baseline to compare against
(["reference framing provides the cognitive substrate for absence detection by anchoring perception
to an explicit baseline"](https://arxiv.org/pdf/2505.23447)). A frozen ring next to actively-pulsing
rings *is* that reference frame, rendered directly in the interface rather than requiring the
operator to do the comparison mentally.

**How to implement.** SVG per marker: a `<circle>` with `stroke-dasharray`/`stroke-dashoffset`
animated via CSS `@keyframes` (`transform: scale(1)→scale(1.4); opacity: 0.6→0`) at
`animation-duration: {expectedGapHours}s-scaled-to-a-legible-loop` — in practice, compress real
hours into a perceptible loop (e.g., `Math.min(expectedGapHours, 18)` seconds, floored at ~4s so fast
reporters don't strobe) rather than literally running a multi-hour CSS animation, and label this
compression honestly in a tooltip (`"pulse compressed for display — real interval: {n}h"`). For the
frozen state, no `animation` property at all — a static partial arc — which is exactly what
"reduced motion" degrades every *other* marker to anyway, meaning **the silent markers already look
correct under `prefers-reduced-motion`, and only the live markers need a fallback** (a small solid
dot instead of the pulse, still visually distinct from the frozen arc).

**Fit for a life-safety product.** High. It does not fabricate anything — the frozen state is
literally "no new data extended this arc," which is the exact honesty contract already in
`ui-spec.md` §6 (never render "confirmed quiet"). It also gives the operator a *glanceable urgency
ordinal* that degrades gracefully to the existing `silenceHours` numeral for anyone who prefers
reading over pattern-matching.

### 4.2 Void / negative-space silence encoding — invert the loud-is-bad convention

**What it is.** Almost every hazard map in existence encodes danger as saturated red/orange glow —
*presence* of a bad signal is loud. Signal Zero's actual claim is the opposite: the danger signal is
an *absence*. Represent the longest-silent settlements not with a brighter mark but with a **spreading
dark halo** — a soft radial gradient in `--bg`/near-black, growing in radius and opacity with
`silenceHours`, drawn *underneath* the corridor lines and terrain so it visibly eats into the
surrounding map the longer the silence runs. A settlement with fresh reports looks like a small lit
island; a settlement dark for 96 hours looks like it's being reclaimed by the map's own background.

**Why it works.** This is a direct, deliberate inversion of the dominant convention, and inversion is
exactly the lever the missing-data-visualization literature identifies as underused: most systems
"space-fill" absence as a neutral gap or empty cell
([survey of missing-data visualization strategies](https://arxiv.org/pdf/2410.03712)); very few make
absence *visually dominant* the way presence normally is. [FlowingData's essay on visualizing
incomplete data](https://flowingdata.com/2018/01/30/visualizing-incomplete-and-missing-data/) and the
industry note that ["what's missing is as vital as what's there"](https://www.mycustomer.com/marketing/data/the-negative-space-in-data-why-whats-missing-is-as-vital-as-whats-there)
both argue for exactly this kind of deliberate negative-space treatment rather than a footnote or an
asterisk. For Signal Zero specifically, it also solves a real craft problem `ux-critique.md` already
found: the fill ramp currently competes with a photographic basemap for visual dominance (§4.2 of
that critique). A void treatment does not compete with the terrain — it *uses* the terrain's own dark
tones as the encoding, so the map becomes more legible, not busier.

**How to implement.** A `radial-gradient` MapLibre paint layer (`fill-color` on a buffered polygon
generated client-side from each silent settlement's point, or a WebGL-free CSS radial-gradient div
positioned over the marker in screen space, re-projected on `map.on('move')` like the existing
keyboard-focus buttons in `ui-spec.md` §4.5). Radius formula:
`r = clamp(20 + 0.6 * silenceHours, 20, 140)` px at the default zoom, opacity
`clamp(0.15 + 0.003 * silenceHours, 0.15, 0.55)`. **Critically, this must never fully occlude the
marker, its label, or the corridor line beneath it** — cap opacity at 0.55 and always paint the
marker/label/corridor line in a layer above the void.

**Fit for a life-safety product.** High, with one caution: test this against the "decorative trust
theater" and "unreadable hero" failure patterns already in `ux-critique.md`'s catalog — a void effect
that gets *so* dark it starts to look like an outage/error state (rather than a data-absence state)
would blur exactly the semantic distinction `ux-critique.md` P1-6 is trying to protect (silence vs.
system failure). Keep the void strictly in cool dark neutrals from the existing `--bg`/`--panel`
family, never in `--critical` red, so it cannot be confused with the "source is down" signal.

### 4.3 Sonar-sweep with no return — the honesty guardrail

**What it is.** A slow radar/sonar-style sweep (§3.4) crossing the map on a fixed period. When the
sweep line passes over a settlement with a recent report, that marker gives a brief, bright
"contact" response — a quick outward ring, like a return echo. When it passes over a silent
settlement, **nothing happens** — the sweep simply continues, and the absence of a response is the
entire point. [Submarine sonar doctrine is a genuinely apt metaphor here](https://militarymachine.com/how-submarine-sonar-works-explained):
["the ping that you transmit is audible at much greater distances than the returning echo"](https://www.bgr.com/2129885/how-submarines-stay-hidden-science-explained/)
— a real sonar operator spends most of their time listening to silence and treats *the absence of an
echo* as operationally meaningful, not as a null result to ignore. That is precisely Signal Zero's
epistemic position.

**Why it works, and the trap to avoid.** The sweep motif is powerful *and* dangerous in the same
breath: it visually implies the system is "pinging" settlements in real time, which is not literally
what's happening (the system is aggregating third-party reports, not actively polling the ground).
If the copy or framing lets a viewer believe Signal Zero is broadcasting a signal that settlements
could respond to, that is a subtle honesty violation — closer to the banned-strings spirit in
`ui-spec.md` §6.1 than it first appears, because it implies causal reach the system doesn't have.
**Mandatory guardrail**: any sweep implementation must be labeled in its tooltip/legend as
"how often this console checks for new reports," never as "scanning" or "pinging settlements" or any
language implying an outbound signal reaching the ground. The sweep visualizes the *polling
cadence of the monitoring system*, not a search beam over the valley.

**How to implement.** Combine the CSS conic-gradient sweep from §3.4 with a per-marker response: on
each `sweep-rotate` cycle, when the current sweep angle crosses within ~4° of a marker's bearing from
map center, and that settlement has `lastReportAt` within some recent window, trigger a one-shot
`ping-response` CSS animation (outward ring, 480ms, ease-out, opacity 0.8→0). Settlements outside
that recency window are simply skipped — no code path fires for them, which is the implementation
mirror of "nothing happens."

**Fit for a life-safety product.** Conditionally high — *only* with the labeling guardrail above.
Without it, reject this idea entirely; it would be the one recommendation in this document that
risks trivializing the product's honesty contract for a cool effect.

### 4.4 Silent-cluster contagion, not "spreading infection" imagery

**What it is.** When the Gi* statistic detects a new `silent-cluster` or `regional-outage` (fields
already in the data model per `ui-spec.md` §0.2), animate a single, restrained pulse traveling along
the corridor edges connecting the newly-flagged settlements to their already-silent neighbors — once,
at the moment the classification changes, not as an ambient loop. This literalizes *why* the Gi*
statistic fired: it is specifically about spatial autocorrelation between neighbors, and a graph-edge
pulse is a faithful diagram of that math, not an arbitrary effect.

**Naming caution.** Do not describe or visually style this as "spreading" or "infection" language or
imagery (no red bleeding edges, no organic/viral visual language) — Signal Zero is about report
silence in a flood disaster, and disease-outbreak visual tropes would import a wrong and distressing
association. Keep the pulse in the same cool, restrained palette as the rest of the corridor system
(`--corridor` token already defined in `ui-spec.md` §7.2), just animated once.

**Fit.** High, implemented per §3.3's lightweight SVG/Canvas approach, gated to fire only on an
actual classification change (never decoratively).

### 4.5 Empty-tail timeline sparkline — Tufte data-ink spent on the gap

**What it is.** In the evidence panel's "What we observed" block, add a single-row horizontal
timeline: a thin baseline with a tick for every report that has ever resolved to this settlement,
positioned by `publishedAt`, running left (oldest) to right (now). For a settlement with reports, this
looks like an ordinary event sparkline. For the 24 of 32 settlements with zero reports
(`ui-spec.md` §0.4), the entire baseline renders with **zero ticks** — an unbroken, unremarkable-
looking flat line — and the visual point is made by *labeling the length of that emptiness explicitly*
next to it: a bracket or small caption reading the plain duration (`"96h with no tick"`), so the
absence is not just implied by empty space (which a viewer could misread as "no data configured" or
a rendering bug) but is stated as a measured quantity next to the void.

**Why it works.** This directly implements the missing-data-visualization literature's "space-filling"
strategy — showing missingness as literal empty space in an otherwise-familiar chart form
([survey](https://arxiv.org/pdf/2410.03712)) — while avoiding that strategy's most common failure mode
(an empty chart reading as broken rather than meaningful) by always pairing the void with an explicit
measured caption, which is also consistent with `ui-spec.md`'s existing rule that the no-data chip
must never be "confused with a status badge" (§6.2) — the same caution generalizes to this new
component.

**Fit.** High — this is Tufte's own maximum-data-ink principle (already an explicit anchor in
`ux-critique.md` §6) applied to exactly the variable this product cares about, rather than to report
volume.

### 4.6 Fog-as-staleness — tying §3.1's atmosphere to the honesty contract

Already described in §3.1: drive the map's fog density from time-since-last-complete-pipeline-pass
rather than a fixed aesthetic value. This is listed again here because it belongs conceptually to
the absence problem, not just to "cinematic terrain" — a console whose *own* data is stale is itself
a form of silence (the silence of the pipeline, not of a settlement), and letting the same visual
grammar (things get harder to see the longer since we last heard) apply recursively to the system's
self-knowledge is a small, coherent, honest idea rather than a gimmick.

### 4.7 What NOT to do here — rejected absence treatments and why

- **Skull/warning iconography, sirens, or flashing red for "no data."** Wrong register entirely —
  `ui-spec.md` §6.2 is explicit that the no-data chip "must look like a caveat, not a status badge,"
  and any of these would make absence look like a confirmed emergency, which is the exact
  overclaiming the product exists to refuse.
- **A literal "missing person" visual metaphor** (silhouettes, question-mark avatars). These
  settlements are places, not confirmed missing individuals — conflating the two would be a serious
  overclaim given 389 real deaths in this disaster, and the product's own copy is careful never to
  imply anything about casualties (`ui-spec.md` §6.1's banned strings already forbid "no survivors" /
  "casualties expected" language). Any visual metaphor implying "people are missing" would violate
  that same principle even without using the words.
- **Glitch/corruption effects (scanlines, static noise, RGB-split)** to represent "no signal." This
  register reads as broken hardware or a horror-genre aesthetic, not as an institutional monitoring
  gap. It would also actively undermine trust in the console itself — a judge or operator seeing
  "glitch" styling could reasonably wonder if the *tool* is malfunctioning rather than understanding
  that *reporting* has stopped.

---

## 5. Typography and color for institutional, premium, non-generic

### 5.1 Typography — pairings, and why the current choice is closer to right than wrong

`ui-spec.md` already specifies Space Grotesk (display) / Inter (body) / JetBrains Mono (numerals),
all served via Google Fonts. `ux-critique.md` §4.8 correctly flags that Inter is doing the real
typographic work at 11–14px while Space Grotesk only appears at small uppercase sizes — the fix isn't
a new typeface family, it's **using the display face at display size.**

Current font-pairing research converges on a small set of legitimately institutional options, all
confirmed present on Google Fonts:

- **Recommended path (least disruption, most upside): keep Space Grotesk, commit it at 32/20/15px**
  per the type scale `ux-critique.md` §5-11 already specifies, and additionally consider
  **Archivo** as an alternative/supplement — both are named in current pairing research as
  institutional-grade grotesques with real weight range, and
  [Archivo pairs cleanly with a serif or stays solo for a "government-agency futurism...restrained
  and functional rather than flashy"](https://madegooddesigns.com/futuristic-fonts/) register — the
  exact register this product needs. Changing typefaces this late is lower priority than simply using
  the one already wired at the sizes it was designed for.
- **JetBrains Mono for all numerals stays correct and should not change** — it is already the right
  choice (`font-variant-numeric: tabular-nums` already spec'd) and appears repeatedly in current
  "fonts for dashboards" research as the standard for data-legible monospace figures.
- **Source Sans 3** is independently named as a strong choice for "government, education, and
  corporate sites where the tone needs to feel authoritative yet approachable" —
  [worth knowing as the fallback](https://www.thebrief.ai/blog/google-font-pairings/) if Inter is
  ever fully retired from the body role, since it explicitly avoids the "2026 trend" over-familiarity
  Inter now carries.
- **Reject** Fraunces/Newsreader/serif-editorial pairings for this product specifically — they read
  as *narrative authority* (a newspaper, a report), and `ux-critique.md` §6 already correctly rejects
  the `nyt-the-daily` recipe on exactly this basis ("a serif authority voice on a government console
  with no editorial claim would read as cosplay"). This dossier concurs independently.

### 5.2 Palette — what "avoid the AI-generated look" concretely means

Current research on AI-slop design tells is consistent and specific:
["purple-to-blue gradients, Inter, centered heroes with three feature cards"](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website)
are the named defaults; [avoid-ai-design's own audit list](https://github.com/funboy322/avoid-ai-design)
targets exactly "purple gradients, Inter, default shadcn." `ux-critique.md` §5 P2-10 already
identifies the product's own violet `#5B4BD6` accent as this exact tell and recommends retiring it —
this dossier's research independently confirms that call from the opposite direction (what reads as
generic-AI, rather than what reads as data-craft) and arrives at the same answer. **Do not reintroduce
violet/purple in any new component this research proposes** — the frozen-pulse rings, void gradients,
and sweep effects should all draw from the existing `--sil-*` ramp, `--ok`/`--warn`/`--critical`, and
neutral tokens, never a new accent hue.

### 5.3 Institutional color discipline, modeled on a real applied spec

[NASA's Air Traffic Management color-usage guidance](https://colorusage.arc.nasa.gov/ATM_1.php) is
worth reading directly (not just citing) before finalizing any new color use in this project, because
it is a real government interface-design standard for exactly this genre (safety-critical,
time-pressured, glanceable) rather than a dashboard-gallery aesthetic reference. Its core, transferable
rules — a small fixed vocabulary of operationally meaningful colors, color never as the sole encoding
channel, and reserved use of red for the single most urgent category — are already partially present
in `ui-spec.md` §7 (the `--ring` anomaly encoding is shape-based specifically to keep hue free for
semantics) and should be the explicit standard any new color decision in this document is checked
against, rather than "does it look premium."

### 5.4 What real control rooms, aviation, and defense interfaces actually look like

Consistent across every source found: **restraint, not richness.** Hairline dividers over shadows;
monospace tabular figures over proportional numerals; a palette of 4–6 operationally meaningful colors
with redundant glyph/text encoding rather than a rich gradient system; information density earned
through layout discipline (NASA's console-bank model, §1.3) rather than through small type. This
matches `ux-critique.md` §6's Bloomberg/Vignelli direction closely enough that no course-correction is
needed there — the new research in this dossier confirms the direction already chosen rather than
contradicting it.

---

## 6. Micro-interactions and craft details

### 6.1 Focus rings — the accessibility craft signal that also reads as premium

[Current WCAG 2.2 guidance](https://www.72technologies.com/blog/focus-rings-accessibility-design-2026)
is explicit and testable: a focus indicator needs **at least a 2px perimeter** around the focused
control and **≥3:1 contrast** against adjacent colors, and must never be hidden behind sticky
headers/overlays. `ux-critique.md` §2 already confirms the existing implementation
(`:focus-visible` with a 2px outline + 4px halo) meets this. The craft opportunity is narrow but real:
apply the *same* branded focus treatment to every new interactive surface this dossier proposes
(marker buttons, sweep-triggered elements, timeline sparkline ticks if they become focusable) rather
than letting new components fall back to browser defaults — [design-craft writing on this exact point
notes that "designed focus states" are one of the details most teams skip and one of the ones users
register even without consciously noticing](https://orpetron-team.medium.com/10-websites-with-exceptional-custom-cursors-for-inspiration-8c8222ff509c)
(the same source that documents custom cursors, cited here for its adjacent point about focus states,
not for the cursor recommendation itself — see §6.4 for why cursors are rejected).

### 6.2 Button press feedback — the smallest "haptic-feeling" moment worth keeping

Per the animation research in §2: `transform: scale(0.97)`, 100–160ms ease-out, on `:active`. This is
small enough to never read as playful, and it is the one piece of "haptic-feeling feedback" the brief
asks about that fits a serious product without qualification — it confirms a click registered, nothing
more. Do not add rotation, color pulse, or icon morph on button press; scale alone is the correct
amount of feedback for this register.

### 6.3 Toast design — confirm the existing restraint, extend it explicitly

`ui-spec.md` §6.5 already states the correct rule: toasts are for transient, non-decision feedback
only, and a decision failure is *never* shown as a toast. Current toast-design research reinforces two
implementation details worth locking in: [pause any auto-dismiss timer on hover/focus](https://dev.to/hritickjaiswal/building-an-accessible-toast-notification-system-in-react-a65)
(already implicitly required by the "max 3 stacked, `aria-live=polite`" spec) and keep slide+fade as
the entrance, never bounce — consistent with the no-elastic-easing rule in §2.7.

### 6.4 Cursor treatments — explicitly rejected, with the reasoning stated

Custom cursors are real, well-documented craft signals on
[award-winning creative/agency sites](https://orpetron.com/blog/10-websites-with-exceptional-custom-cursors-for-inspiration/).
They are rejected here specifically because Signal Zero's user drives the interface with a keyboard
under time pressure (`ux-critique.md`'s own audience framing: "their hand never leaves the keyboard"),
and a custom cursor is a mouse-only flourish that adds zero information for that primary user while
adding visual noise for the secondary judge audience. This is a case where a genuinely good technique
for one genre (creative portfolio) is a genuine mismatch for another (operational console) — worth
naming explicitly so it isn't reconsidered later by someone who only remembers "custom cursors are a
craft signal" without the context.

### 6.5 Skeleton-to-content transitions — FLIP instead of a hard swap

`ui-spec.md` §6.3 already specifies real skeletons (shimmer bars) sized to match real content, which
is already better than a generic spinner. The refinement: when real content replaces a skeleton,
measure the skeleton element's bounding box before removal and the real element's bounding box after
insertion, then animate the delta (the FLIP technique — First, Last, Invert, Play) so content appears
to "resolve into" the exact space the skeleton occupied rather than popping in at a possibly different
size. This is most valuable for the rank rows (skeleton row height must exactly equal the spec'd
26–28px real row height per `ux-critique.md` P0-2, so this is nearly a no-op animation-wise, but worth
verifying the two heights genuinely match rather than assuming it) and the evidence panel's four
skeleton blocks.

### 6.6 "Delight" appropriate for a serious product — the honest answer

The brief explicitly asks for delight moments while cautioning against playfulness. The correct
delight register for this product, based on everything above, is **precision and restraint made
visible** — not surprise or whimsy. Concretely: the moment the rank board finishes its 900ms stagger
sweep and settles into a stable ranked column with zero further motion; the moment a decision's
success block appears with the exact shortlist that was promised, in the exact order promised
(alphabetical, non-preferential, as `ui-spec.md` §5.3 already specifies); the moment the frozen-pulse
ring's stopped-clock notch lines up exactly with the numeral next to it. **The delight in this product
should be the delight of an instrument that is exactly as accurate as it claims to be** — every
"reveal" moment should be a confirmation that the number/state you're about to see matches the honest
math already computed server-side, never a surprise or a reward. This is consistent with (not a
loophole around) the "never fabricate" rule already governing every other decision in this codebase.

### 6.7 Sound design — recommend against, with the reasoning stated plainly

Alert-design research is consistent: ["restraint is important — the higher the risk, the stronger the
interruption should become," and interruption should be reserved](https://www.eleken.co/blog-posts/alert-ui-examples)
for genuinely high-risk moments; clinical alarm research on [redesigned monitoring alarms](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12692177/)
shows that poorly-differentiated or overused alarm sounds cause real clinical alarm fatigue — a
directly relevant finding for an EOC context where sound could plausibly compete with radio traffic,
phone calls, and other officials' conversations in the same room. **Recommendation: no sound by
default anywhere in this product.** If a future iteration wants sound, the only defensible use is a
single, distinct, non-alarming tone tied *only* to a new pending human-checkpoint item (never to
routine polling, rank changes, or the sweep/pulse effects in §3–4), user-togglable and off by default,
because a console that plays an unexpected sound during a live briefing in front of officials is a
liability this product cannot afford for a decorative gain.

---

## Summary table — every technique, one line, fit verdict

| # | Technique | Section | Fit for Signal Zero |
|---|---|---|---|
| 1 | Frozen-pulse marker ring | §4.1 | Adopt — flagship |
| 2 | Void/negative-space silence encoding | §4.2 | Adopt |
| 3 | Somber hero count-up (CountUp.js, no bounce) | §2.3 | Adopt |
| 4 | Staggered rank-row entrance, 28ms | §2.1 | Adopt |
| 5 | Direction-aware 60ms flash-on-update | §2.4 | Adopt |
| 6 | MapLibre sky/fog/hillshade-angle tuning | §3.1–3.2 | Adopt |
| 7 | Corridor contagion pulse (SVG/Canvas, not deck.gl) | §3.3, §4.4 | Adopt |
| 8 | Sonar sweep, honestly labeled | §3.4, §4.3 | Adopt, with mandatory copy guardrail |
| 9 | Empty-tail timeline sparkline | §4.5 | Adopt |
| 10 | Fog-as-staleness | §4.6, §3.1 | Adopt |
| 11 | Checkpoint dialog motion choreography | §2.5 | Adopt |
| 12 | Branded focus rings on all new components | §6.1 | Adopt |
| 13 | Space Grotesk/Archivo at real display size | §5.1 | Adopt |
| 14 | Institutional color discipline (NASA ATM model) | §5.3 | Adopt |
| 15 | GSAP as orchestration layer | §2.6 | Adopt |
| 16 | Button press scale(0.97) feedback | §6.2 | Adopt |
| 17 | FLIP skeleton-to-content transitions | §6.5 | Adopt |
| 18 | deck.gl ArcLayer (full library) | §3.3 | Optional upgrade only |
| 19 | Bento grid layout | §1.1 | Reject |
| 20 | Scroll-choreographed page reveal as primary pattern | §1.1 | Reject as primary; ok for derivation `<details>` only |
| 21 | Custom cursor | §6.4 | Reject |
| 22 | Particle-system ambient background | Top 15 exclusions | Reject |
| 23 | Rotating 3D globe | Top 15 exclusions | Reject |
| 24 | Skull/siren/red-flash "no data" iconography | §4.7 | Reject |
| 25 | Missing-person visual metaphor | §4.7 | Reject — overclaims against real deaths |
| 26 | Glitch/corruption "no signal" effect | §4.7 | Reject |
| 27 | Sound/audio alerts by default | §6.7 | Reject (opt-in only, if ever) |
| 28 | Disease/infection "spreading" imagery for clusters | §4.4 | Reject |

---

## Sources consulted

Award/dashboard genre: [Awwwards data-visualization](https://www.awwwards.com/websites/data-visualization/) ·
[Where the Shadow Fell](http://eclipses.bogachev.fr) · [Signal IQ](https://marketing.pinelabs.com/signaliq) ·
[HydraDB](https://hydradb.com/) · [Godly](https://godly.design/) ·
[Dribbble command-center search](https://dribbble.com/search/command-center-dashboard) ·
[NASA Mission Control diagram](https://airandspace.si.edu/multimedia-gallery/image/nasa-consolesjpg) ·
[Bloomberg/IDEO redesign history](https://medium.com/@katschoi/bloomberg-saving-private-ryan-and-the-art-science-of-design-75f3cad054d9)

Motion/animation: [emilkowalski/skills animation standards](https://github.com/emilkowalski/skills/blob/main/skills/review-animations/STANDARDS.md) ·
[vercel-labs web-animation-design skill](https://github.com/vercel-labs/open-agents/blob/main/.agents/skills/web-animation-design/SKILL.md) ·
[Motion.dev easing functions](https://motion.dev/docs/easing-functions) ·
[30 Seconds of Code staggered animation](https://www.30secondsofcode.org/css/s/staggered-animation/) ·
[CountUp.js](https://github.com/inorganik/CountUp.js) ·
[GSAP now free](https://webflow.com/blog/gsap-becomes-free) · [CSS-Tricks on GSAP license](https://css-tricks.com/gsap-is-now-completely-free-even-for-commercial-use/)

3D/spatial: [MapLibre Sky spec](https://maplibre.org/maplibre-style-spec/sky/) ·
[MapLibre sky/fog/terrain example](https://maplibre.org/maplibre-gl-js/docs/examples/sky-fog-terrain/) ·
[Jawg sky/fog/terrain guide](https://www.jawg.io/docs/integration/maplibre-gl-js/sky-fog-terrain/) ·
[deck.gl MapLibre overlay gallery](https://deck.gl/gallery/maplibre-overlay) ·
[deck.gl + MapLibre developer guide](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre) ·
[deck.gl ArcLayer docs](https://deck.gl/docs/api-reference/layers/arc-layer) ·
[three.js forum: atmospheric glow](https://discourse.threejs.org/t/how-to-create-an-atmospheric-glow-effect-on-surface-of-globe-sphere/32852) ·
[Three.js Roadmap rim lighting](https://threejsroadmap.com/blog/rim-lighting-shader) ·
[CSS sonar sweep](https://dev.to/nikolab/animated-sonar-screen-css-only-3p9f)

Absence/silence: [Toward Systematic Considerations of Missingness in Visual Analytics](https://arxiv.org/pdf/2108.04931) ·
[To Measure What Isn't There](https://arxiv.org/pdf/2505.23447) ·
[Visualization of missing data: a state-of-the-art survey](https://arxiv.org/pdf/2410.03712) ·
[FlowingData: Visualizing Incomplete and Missing Data](https://flowingdata.com/2018/01/30/visualizing-incomplete-and-missing-data/) ·
[The negative space in data (MyCustomer)](https://www.mycustomer.com/marketing/data/the-negative-space-in-data-why-whats-missing-is-as-vital-as-whats-there) ·
[How submarine sonar works](https://militarymachine.com/how-submarine-sonar-works-explained) ·
[How submarines stay hidden (BGR)](https://www.bgr.com/2129885/how-submarines-stay-hidden-science-explained/) ·
[USGS seismographs](https://www.usgs.gov/programs/earthquake-hazards/seismographs-keeping-track-earthquakes)

Typography/color: [Google Font pairings 2026](https://www.thebrief.ai/blog/google-font-pairings/) ·
[Best futuristic fonts 2026](https://madegooddesigns.com/futuristic-fonts/) ·
[NASA ATM color-usage guide](https://colorusage.arc.nasa.gov/ATM_1.php) ·
[avoid-ai-design audit tool](https://github.com/funboy322/avoid-ai-design) ·
[Why your AI keeps building the same purple gradient](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website)

Micro-interactions: [Focus rings for WCAG 2.2 (2026 guide)](https://www.72technologies.com/blog/focus-rings-accessibility-design-2026) ·
[Accessible toast notification system](https://dev.to/hritickjaiswal/building-an-accessible-toast-notification-system-in-react-a65) ·
[Custom cursor craft examples](https://orpetron.com/blog/10-websites-with-exceptional-custom-cursors-for-inspiration/) ·
[Alert UI restraint principles](https://www.eleken.co/blog-posts/alert-ui-examples) ·
[Clinical alarm redesign study](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12692177/)

Internal (this repo): `docs/ui-spec.md`, `docs/ux-critique.md`, `web/index.html`, `web/styles.css`,
`web/app.js`, `web/lib.js`, `web/map.js`.
