# The Frontend / Product-Engineering Bar, 2026

Research compiled 2026-08-30 for positioning **Signal Zero** (github.com/kenilhv/signal-zero)
as a portfolio project.

## How to read this document

Every claim is tagged:

- **[POSTING]** — literal text from a real job posting I fetched. URL given. This is what a
  company *literally requires*.
- **[SPEC]** — a standards body or browser-vendor primary document (W3C, Chrome, DOJ, EU).
- **[SURVEY]** — a dated, named industry survey, read from its own site.
- **[ARGUMENT]** — a named engineer's published position. Evidence of what a *community*
  believes, not evidence of what a hiring manager requires.
- **[MEASURED]** — a number I measured on this repository myself.
- **[INFERENCE]** — my own reasoning. Not sourced. Treat as opinion.
- **[UNVERIFIED]** — something I looked for and could not confirm. Stated so you don't build on it.

### Scope and honesty caveat, up front

I read **~20 postings end-to-end**. That is a convenience sample, not a survey. Where this
document says "N of the postings I read mention X," that is a literal count over that sample and
nothing more. **I did not find, and am not inventing, a statistically valid corpus study of 2026
frontend postings.** Any percentage-of-all-postings claim you see elsewhere in a resume guide is
probably unsourced; do not repeat one.

Two named companies from the brief could not be sourced properly and are excluded rather than
guessed at:

- **Shopify** — `shopify.com/careers/search` renders its listings client-side; the fetched page
  returned discipline categories only, no individual engineering postings. Search fallbacks
  returned agency/aggregator postings *for Shopify-platform work at other companies*, not Shopify
  Inc. postings. **[UNVERIFIED]** — no Shopify requirement is quoted in this document.
- **Observable** — I found no live Observable engineering posting on any first-party page.
  **[UNVERIFIED]**. (Observable Plot the library is cited below; the company's hiring is not.)

**Vercel** has no open frontend-titled role at time of writing; its nearest equivalent is
**Site Engineer**, quoted below. **Figma** has no "Frontend Engineer" title either; its web-facing
roles are "Software Engineer — Full Stack" and "Software Engineer — Mobile Web," both quoted.
**Cloudflare's** public Greenhouse board had no frontend/UI-titled role. **[POSTING]**

---

# 1. The framework question

## 1.1 What the postings literally say

The most senior, most craft-obsessed product companies name React and TypeScript **explicitly and
as a requirement, not a preference**:

| Company | Role | Literal requirement | Source |
|---|---|---|---|
| Linear | Product Engineer (2–5 yrs) **and** Senior/Staff Product Engineer (5+ yrs) | "Strong React and TypeScript fundamentals, with experience across the full stack" — *identical bullet at both levels* | [Linear job board](https://api.ashbyhq.com/posting-api/job-board/Linear) |
| Framer | Senior Product Engineer | "Expertise in JavaScript, TypeScript, and React." | [framer.com/careers/senior-product-engineer](https://www.framer.com/careers/senior-product-engineer) |
| Figma | Software Engineer — Full Stack | "Strong proficiency in modern front-end frameworks (e.g. React/TypeScript) and back-end technologies" | [Greenhouse job 5691911004](https://boards.greenhouse.io/figma/jobs/5691911004) |
| Vercel | Site Engineer | "5+ years of professional frontend engineering experience (React, JavaScript, Tailwind CSS, or similar)." + "Strong proficiency in Next.js" | [Greenhouse job 5732855004](https://job-boards.greenhouse.io/vercel/jobs/5732855004) |
| Airbnb | Senior SWE, Community Support (Frontend) | "Experience with modern JavaScript/Typescript libraries and tooling (e.g. React, graphql)" | [Greenhouse job 8138069](https://careers.airbnb.com/positions/8138069) |
| Anthropic | Staff SWE, Accessibility | "strong practical skills in modern web technologies (React, TypeScript or comparable frameworks)" | [Menlo VC board mirror](https://jobs.menlovc.com/companies/anthropic/jobs/79778982-staff-software-engineer-accessibility) |
| NYT | Software Engineer, Games | "2+ years ... using TypeScript and modern frontend frameworks such as React" | [Greenhouse job 4713043005](https://job-boards.greenhouse.io/thenewyorktimes/jobs/4713043005) |
| Verkada | Staff Frontend Engineer, Mapping & Spatial | "Mastery of Web Technologies: JavaScript fundamentals … and React expertise" | [Greenhouse job 5215839007](https://job-boards.greenhouse.io/verkada/jobs/5215839007) |
| Ashby | Design Engineer | "Deep knowledge of React, CSS, and HTML is needed" | [YC job board](https://www.ycombinator.com/companies/ashby/jobs/3UaRO5l-design-engineer-uk) (mirror; Ashby's own page is JS-rendered) |

**Verdict on the literal reading: React + TypeScript is a stated requirement at essentially every
frontend-shaped role I could read.** Not a nice-to-have. Not "or similar" in most cases. This is
not ambiguous and I am not going to soften it.

## 1.2 The counter-evidence, which is real and which people get wrong

Three genuinely different things cut against "you must have React on the resume." They are not the
same argument and they should not be blurred together.

**(a) Some serious companies explicitly de-weight language and framework.**

Stripe's Full Stack Engineer minimum requirements are, verbatim and in full:

> "2–12+ years of industry software engineering experience"; "Strong coding skills in any
> programming language"; "Strong collaboration skills…"; "Ability to thrive on a high level of
> autonomy and responsibility"; "Interest in working as a generalist across varying technologies
> and stacks"

— [stripe.com job 6567104](https://stripe.com/jobs/listing/full-stack-engineer-developer-experience-product-platform/6567104) **[POSTING]**

There is **no preferred-qualifications section and no framework named at all**. Stripe's careers
material also states candidates "can choose from a number of different programming languages" in
interviews. **[POSTING]**

**(b) Even framework-requiring postings put platform fundamentals in the same sentence — sometimes first.**

Verkada's Staff Frontend Engineer bullet is ordered "**JavaScript fundamentals** … and React
expertise" — fundamentals named first. NYT requires "Demonstrated understanding of frontend web
fundamentals (HTML, CSS, JavaScript, web performance) to deliver accessible, responsive user
interfaces" as a *separate basic qualification* alongside the React one. Ashby's Design Engineer
asks for "React, **CSS, and HTML**." Airbnb asks for "Fluency in HTML, CSS, and related web
technologies" as its own bullet. **[POSTING]**

**[INFERENCE]** These postings are written by people who have interviewed React developers who
cannot explain a stacking context or a focus trap. Fundamentals are being listed separately
*because* framework fluency has stopped predicting them.

**(c) A credible published argument exists that the framework default is a mistake.**

Alex Russell — Google, browsers and web standards — argues in
["The Market for Lemons" (2023)](https://infrequently.org/2023/02/the-market-for-lemons/) that
mainstream JS frameworks "have utterly failed to deliver on that promise" of better user
experience, using Core Web Vitals field data and consulting experience. He notes that the orgs
which succeed with heavy JS are the ones with dedicated platform teams, strict budgets and
management oversight. **[ARGUMENT]**

DHH's ["You can't get faster than No Build"](https://world.hey.com/dhh/you-can-t-get-faster-than-no-build-7a44131c)
(11 Oct 2023) makes the no-build case concretely: **import maps + HTTP/2 + native ES modules and
modern CSS** remove the need to bundle or transpile. He explicitly scopes it — the approach works
"if you aren't wedded to React, Vue, or whatever," and he still calls esbuild and bun "great
tools." **[ARGUMENT]**

Note carefully what these two are and are not. They are **evidence that the position is
intellectually respectable and defended by named, senior people**. They are **not** evidence that a
hiring screen will accept it. Russell and DHH do not review your resume.

## 1.3 The market-share number, verified directly

Stack Overflow Developer Survey 2025, read from
[survey.stackoverflow.co/2025/technology](https://survey.stackoverflow.co/2025/technology)
**[SURVEY]** (n = 23,678 answering the web-frameworks question):

| | All respondents | Professional devs |
|---|---|---|
| React | 44.7% | 46.9% |
| jQuery | 23.4% | 24.1% |
| Next.js | 20.8% | 21.5% |
| Angular | 18.2% | 19.8% |
| Vue.js | 17.6% | 18.4% |
| Svelte | 7.2% | 6.9% |

React is the plurality but **not** the majority. jQuery is still the #2 web technology among
professional developers, which is a useful corrective to "everyone is on modern React."
**[INFERENCE]** The gap between React's ~47% usage and its ~100% appearance in elite product-company
postings tells you these postings are a *filter for a specific hiring tier*, not a description of
the industry.

## 1.4 Honest verdict on vanilla JS

**Vanilla JS is a liability *as the only thing on the resume*, and a differentiator *as one
deliberate choice among several, in a portfolio that also proves React/TS competence elsewhere*.**

The asymmetry that decides it:

- A reviewer who wants React and sees no React **cannot verify** you have it. Your documented
  reasoning does not help, because they never open the doc — they are screening 300 applications
  and the requirement bullet says React.
- A reviewer who sees React on the resume **and then** finds a project that says "here is where I
  chose *not* to use a framework, and here is the measurement that justified it" reads that as
  senior judgement. It is the single hardest thing to fake.

So the reasoning-document strategy works, but **only downstream of the keyword screen, not through
it**. The document is an interview weapon, not a resume weapon. **[INFERENCE]**

Supporting datapoint for "the doc is an interview weapon": NYT lists as a *basic qualification*
"Experience creating detailed technical documentation, including the ability to explain tradeoffs
and rationale in writing and in conversation." **[POSTING]** That is a company literally hiring for
the skill the no-build write-up would demonstrate.

### What would have to be true for each answer to be right

**"Stay vanilla" is right if:**
1. The target roles are Stripe-shaped — "strong coding skills in any programming language,"
   generalist, no framework named. These exist and pay well.
2. The resume *already* establishes React/TS credibly from employment or a second project, so
   Signal Zero is not carrying the framework burden.
3. The no-build decision is **defended with numbers you measured**, not with a manifesto. A
   reviewer who smells rationalisation will discount it harder than if you'd said nothing.
4. The demo-robustness rationale is a live constraint you can name. "No build step so the demo
   cannot break at a hackathon" was a real constraint; "the deadline has passed" weakens it, so
   you need the *current* justification (zero-dependency deploy, no supply-chain surface, works
   from `file://`, reviewer can read shipped source directly).

**"Port to React/TypeScript" is right if:**
1. You are applying to Linear/Framer/Figma/Vercel-tier product roles, where the bullet is
   unconditional and there is no second project carrying React.
2. Recruiters, not engineers, do first-pass screening — which is the norm at that tier.
3. You would otherwise have zero TypeScript anywhere, which is a bigger problem than the framework:
   **TypeScript appears in more of the postings I read than React does**, and the repo has none.

### My direct recommendation

**Do not rewrite Signal Zero in React. Do add TypeScript, and do build a second, smaller React/TS
artifact.**

Reasoning:

1. **The framework is not what makes this project strong.** The differentiated content is the
   Fellegi-Sunter linkage, the Getis-Ord Gi* spatial anomaly detection, the deterministic
   guardrails, the 157 eval checks, and the MapLibre terrain map. A React rewrite adds zero signal to any
   of that and burns weeks. **[INFERENCE]**
2. **TypeScript is the cheap, high-yield half of the requirement, and it is separable from React.**
   Linear, Framer, Figma, Airbnb, Anthropic, NYT all name TypeScript. You can get most of the way
   there with JSDoc types + `checkJs` in a `tsconfig.json` and `tsc --noEmit` in CI — **no build
   step, no bundler, no change to how the page loads.** This is the single highest
   requirement-coverage-per-hour move available and it does not compromise the no-build position at
   all. **[INFERENCE]**
3. **The keyword screen is real and cheap to satisfy elsewhere.** A second, deliberately small
   React/TS project (a component, a Next.js page, a design-system fragment) costs a weekend and
   removes the "cannot verify React" failure mode entirely.
4. **The no-build story becomes an asset only once (3) exists.** Then it reads as choice. Until
   then it reads as unfamiliarity, and you have no way to prove otherwise from a resume line.

**Write the decision record either way.** Put it in the repo as an ADR — the constraint, the
alternatives, the measurement, and *what would change your mind*. That last section is what
separates an engineer from an advocate.

---

# 2. Accessibility

## 2.1 What the standard actually is right now — verified

- **WCAG 2.2 is a W3C Recommendation, dated 12 December 2024** (that date is the current
  republication; 2.2 first reached Recommendation in 2023). Read from
  [w3.org/TR/WCAG22](https://www.w3.org/TR/WCAG22/). It states content conforming to 2.2 also
  conforms to 2.0 and 2.1. **[SPEC]**
- **WCAG 3.0 is a Working Draft dated 03 March 2026** and says of itself: "It is inappropriate to
  cite this document as other than a work in progress."
  [w3.org/TR/wcag-3.0](https://www.w3.org/TR/wcag-3.0/). **[SPEC]** Do not target WCAG 3.
- **US regulation still points at 2.1 AA, not 2.2.** The DOJ ADA Title II web rule requires "the
  Web Content Accessibility Guidelines (WCAG) Version 2.1, Level AA," with compliance dates now
  **26 April 2027** (jurisdictions ≥50,000 population) and **26 April 2028** (smaller/special
  districts) following an Interim Final Rule published 20 April 2026.
  [ada.gov/resources/2024-03-08-web-rule](https://www.ada.gov/resources/2024-03-08-web-rule/)
  **[SPEC]**
- **EU:** Directive (EU) 2019/882 (European Accessibility Act) applies from **28 June 2025**;
  confirmed on [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32019L0882).
  **[SPEC]** The commonly-cited mapping to EN 301 549 v3.2.1 → WCAG 2.1 AA I could only source
  from accessibility-vendor blogs, not from ETSI directly. **[UNVERIFIED]** — say "EN 301 549" in
  an interview, don't quote a version number you haven't read.

**So: 2.1 AA is the regulatory floor. 2.2 AA is the standards ceiling and what the best employers
name.** Both are true simultaneously; that is not a contradiction and it is worth being able to
explain.

## 2.2 What postings literally require

The strongest single specification I found is Anthropic's **Staff Software Engineer, Accessibility**
($320k–$405k, New York; posting now closed). Verbatim requirements:

> "hands-on familiarity with **WCAG 2.2 AA, ARIA Authoring Practices, and HTML semantics**"
>
> "experience testing with assistive technology — screen readers (**VoiceOver, NVDA, JAWS,
> TalkBack**), keyboard-only navigation, magnification, voice control"

and among the responsibilities:

> "Develop **automated testing and agentic scanning infrastructure** that catches accessibility
> regressions across surfaces"
>
> "Integrate accessibility into product workflows so standards are met **by default rather than
> retroactively remediated**"

— [Menlo VC board mirror](https://jobs.menlovc.com/companies/anthropic/jobs/79778982-staff-software-engineer-accessibility) **[POSTING]**

That posting answers your question exactly: **2.2 AA, ARIA Authoring Practices by name, four named
screen readers, keyboard-only, magnification, voice control, and automated regression detection.**

Frequency in my sample — **counted, not estimated**:

- Explicit accessibility requirement in a general (non-a11y-specialist) engineering posting:
  **Airbnb** ("Demonstrated **excellence in accessibility**, performance optimization, and paved-path
  client practices; influence beyond your immediate team"), **NYT** ("to deliver **accessible**,
  responsive user interfaces"), **Vercel Site Engineer** ("especially around performance,
  **accessibility**, and search optimization"), **Grove Collaborative** ("Own performance, stability,
  **accessibility**, and maintainability in the code you and your team ship"), **what3words**
  (accessibility named in frontend nuances + a11y testing as bonus).
- **Not** mentioned in: Linear (both levels), Framer, Figma Full Stack, Figma Mobile Web, Stripe
  Full Stack, Verkada, MapLibre.

**Reading of that split [INFERENCE]:** accessibility is required where there is a large consumer or
public-facing surface (Airbnb, NYT, Grove, marketing sites) and at companies with a dedicated a11y
function; it is frequently *absent* from B2B product-engineering postings at the Linear/Framer tier.
Airbnb's phrasing is the giveaway about seniority: at senior level it is not "knows about
accessibility," it is "**excellence in** … **influence beyond your immediate team**."

## 2.3 What credible a11y work looks like in a portfolio

**[INFERENCE]**, but grounded directly in the Anthropic bullets above:

- **Not credible:** an axe score, a Lighthouse a11y 100, `aria-label` sprinkled on things.
  Automated tooling catches a minority of WCAG failures; a reviewer who does a11y for a living
  knows this.
- **Credible:** a documented keyboard walkthrough of every interactive surface; a named screen
  reader and a named finding you fixed because of it; correct APG-conformant patterns for the
  composite widgets you actually have (tabs, grid, listbox, dialog); a live region that announces
  the right thing at the right time; visible focus that survives your own theme.
- **Rare and impressive:** an a11y regression test in CI that *fails the build*, plus an honest
  written list of the WCAG criteria you did **not** meet and why. Nobody publishes the second one.
  Anthropic is literally hiring someone to build the first one.

### Where Signal Zero stands **[MEASURED]**

Grep over `web/` shows this is already better than typical:

- `role="tablist"` / `role="tab"` / `role="tabpanel"` — a real APG composite pattern, not decoration
- `aria-live` ×5, `role="status"`, `role="alert"` — the correct mechanism for a console whose whole
  premise is *changing* rankings
- `aria-sort` ×4 on the table, `aria-pressed` ×14, `aria-controls`, `aria-labelledby` ×9,
  `aria-selected`, `aria-disabled`, `aria-invalid`
- `<html lang="en">`, `role="banner"`, `<meta name="color-scheme" content="light dark">`

**Gaps [INFERENCE]:** `aria-*` present ≠ keyboard-operable. Tabs need arrow-key roving tabindex to
be APG-conformant. `aria-sort` needs the header to actually be an activatable button. And a
**MapLibre GL canvas map is a hard a11y problem** — a WebGL canvas is opaque to assistive tech, so
the ranked list must be a genuinely equivalent non-visual path to every fact the map conveys.
Signal Zero already has that list. **Say so explicitly in the README — that is the single most
sophisticated a11y point this project can make**, and almost no map-based portfolio project makes it.

---

# 3. Performance

## 3.1 The metrics, verified — INP has replaced FID

Read directly from [web.dev/articles/vitals](https://web.dev/articles/vitals) **[SPEC]**:

The three **stable** Core Web Vitals and their "good" thresholds:

| Metric | Threshold | |
|---|---|---|
| **LCP** — Largest Contentful Paint | ≤ **2.5 s** | loading |
| **INP** — Interaction to Next Paint | ≤ **200 ms** | responsiveness |
| **CLS** — Cumulative Layout Shift | ≤ **0.1** | visual stability |

**FID is retired.** INP was developed to address runtime responsiveness "more comprehensively than
First Input Delay (FID)," went pending in 2023 and became a stable Core Web Vital in 2024,
replacing FID. **Confirmed, not assumed.** **[SPEC]**

**There are no pending or newly added Core Web Vitals** listed as of this reading. All three are
stable. **[SPEC]**

## 3.2 What is genuinely changing in 2026 — and what is SEO noise

I found many 2026 blog posts claiming Google "tightened INP methodology" and "expanded soft-navigation
support in CrUX" this year. **Those are SEO-content sites and I could not corroborate any of it
from a Google primary source. Treat as false until proven.** **[UNVERIFIED]**

What Chrome's own documentation actually says
([developer.chrome.com/docs/web-platform/soft-navigations](https://developer.chrome.com/docs/web-platform/soft-navigations))
**[SPEC]**:

- The **Soft Navigations API is shipping from Chrome 151**, unflagged, for all sites.
- The aim *is* eventually to include soft navigations in Core Web Vitals: "the aim is to include
  these in Core Web Vitals measurements as exposed by all tools after the API is launched."
- But: "How exactly soft navigations will be reported in **CrUX**, once the feature is launched, is
  also still to be determined."

So the correct 2026 statement is: **the API has shipped; the CrUX/CWV integration has not, and Chrome
says the reporting design is undecided.** Being able to say that precisely — API shipped, metric
integration pending — is exactly the kind of thing that separates someone who reads primary sources
from someone who reads listicles. **[INFERENCE]**

**web.dev's `/blog/vitals-changelog` and `/articles/vitals-changelog` both 404'd** for me, so I
cannot cite a changelog. **[UNVERIFIED]**

## 3.3 What postings require

- **Airbnb (senior):** "Demonstrated excellence in accessibility, **performance optimization**, and
  paved-path client practices; **influence beyond your immediate team**" **[POSTING]**
- **Vercel Site Engineer:** "Deep understanding of SEO principles and best practices—especially
  around **performance**, accessibility, and search optimization"; "**Identify bottlenecks and
  optimize** for conversion, speed, and reliability across the funnel"; "Proven knowledge of **A/B
  testing** concepts and conversion rate optimization" **[POSTING]**
- **Linear (both levels):** "Product sensibility: you care about UX, **speed**, and polish"
  **[POSTING]**
- **Figma Mobile Web:** pragmatic approach emphasising "maintainable, **performant** code"
  **[POSTING]**
- **Verkada Staff:** "**Optimize for Latency**: Solve the '500-element wall' with partial GPU buffer
  updates" and "you notice the half-pixel misalignment, **the 16ms jank**" **[POSTING]**
- **Grove Collaborative:** "performance optimization" in the core skills bullet **[POSTING]**

**Notable:** among the postings I read, **not one named "Core Web Vitals," "Lighthouse CI," or
"performance budget" as a literal requirement.** Search surfaced two smaller companies (Durable,
Lumimeds) whose *search snippets* mention Core Web Vitals/LCP/INP/bundle size, but both Greenhouse
pages rendered as index listings when I fetched them and I could not read the bullets. **I am not
quoting them.** **[UNVERIFIED]**

**[INFERENCE]** Elite postings say "performance," not "Core Web Vitals," because CWV is an SEO
framing and these are product companies. The Verkada bullet is the tell: at the top of the market
performance is expressed as **frame budget and jank** (16 ms), not as a lab score.

## 3.4 What a reviewer expects you to measure and defend

**[INFERENCE]**, calibrated to the bullets above:

1. **A number, from your own machine, on your own project.** Not a Lighthouse badge.
2. **Field vs lab literacy.** Lighthouse is lab; CrUX/RUM is field; they disagree and you should
   know why (`web-vitals` JS library is the standard way to collect the field version).
3. **A budget with a failure mode.** "JS ≤ X KB gz, LCP ≤ 2.5 s, and CI fails if exceeded" beats
   any score.
4. **INP specifically**, because it is the one a data-heavy console actually fails: long tasks that
   block the next paint. Long Animation Frames (LoAF) in DevTools is the diagnostic.

### Signal Zero, measured right now **[MEASURED]**

gzip -9 of the shipped assets:

| Asset | gzip |
|---|---|
| `vendor/maplibre-gl.mjs` | 139 KB |
| `vendor/maplibre-gl-shared.mjs` | 132 KB |
| `vendor/maplibre-gl.css` | 10 KB |
| `app.js` | 30 KB |
| `map.js` | 20 KB |
| `styles.css` | 21 KB |
| `lib.js` | 6 KB |
| `index.html` | 5 KB |
| **Total** | **≈ 363 KB gz** |

Of which **MapLibre is ≈ 271 KB (75%)** and **all author-written code is ≈ 82 KB gz**.

**This is the strongest possible empirical defence of the no-build decision and you should lead
with it.** The bundler you don't have would minify ~82 KB of hand-written code; over gzip the
saving is a small fraction of a payload that is 75% third-party map engine. **The build step would
not have been the thing that made this fast.** That is a measured, falsifiable, specific claim —
exactly the shape of argument the Verkada and Airbnb bullets are screening for. **[INFERENCE from
MEASURED data]**

Also already correct in `index.html` **[MEASURED]**: `preconnect` to both Google Fonts origins, and
the `media="print" onload="this.media='all'"` non-blocking stylesheet pattern with a `<noscript>`
fallback. That is a deliberate render-blocking mitigation, not an accident.

Not yet measured and worth doing: **LCP, INP, CLS on the real console under real data.** A map +
ranked table + live regions is an INP risk. Measure before claiming.

---

# 4. Data visualisation and mapping

## 4.1 State of practice, from primary sources

**Observable Plot** — [observablehq.com/plot](https://observablehq.com/plot/), current version
**0.6.17**, tagline verbatim: *"The JavaScript library for exploratory data visualization."* Built
by the D3 team, on top of D3; the docs state "If you know some D3, you'll be right at home with
Plot." **[SPEC/primary]** **[INFERENCE]** Plot is positioned for *exploratory* work — analysis and
notebooks. D3 remains the tool when you need bespoke, explanatory, pixel-controlled output. Using
Plot for a shipped product surface is a defensible but unusual choice; be able to say why.

**MapLibre** — [maplibre.org/jobs/graphics-engineer](https://maplibre.org/jobs/graphics-engineer/)
**[POSTING]**, an open-source contract role, is a direct readout of what map-engine work is:

> Required: "Intermediate experience with **TypeScript**"; "Intermediate knowledge of **WebGL**";
> "Familiarity with **GPUs, graphics programming, and shaders**"
>
> Responsibilities include "Improve **Globe view** performance and stability", "Extend support for
> **custom coordinate systems**", "Enhance **Terrain3D** functionality", and "render pipeline
> modernization … laying the groundwork for **WebGPU support**"

Signal Zero uses MapLibre GL **terrain** — that is the Terrain3D surface this posting names.
**[INFERENCE]** That is a real, non-trivial capability, and worth naming precisely rather than
saying "a map."

## 4.2 What distinguishes serious geospatial work — from a posting, not from me

Verkada's **Staff Frontend Engineer — Mapping & Spatial Platform**
([Greenhouse 5215839007](https://job-boards.greenhouse.io/verkada/jobs/5215839007), $185k–$265k) is
the clearest statement of the bar I found. Verbatim:

Requirements:
> "**Mathematical Precision:** Understanding of **coordinate system conversions, geospatial
> projections, and 3D geometry**"
>
> "**CS Fundamentals:** … strong intuition for **data structures, memory management, and linear
> algebra**"
>
> "**Eye for Detail:** Pixel-perfect execution—you notice the half-pixel misalignment, the 16ms jank"

Nice-to-have:
> "**Graphics Stack:** Experience with **Deck.gl, MapLibre, Three.js, or raw WebGL/WebGPU**"
>
> "**Low-Level Web:** Proficiency in high-performance 2D/3D graphics (Canvas API, low-level buffer
> management, or custom shaders)"
>
> "**Geospatial Mastery:** Familiarity with **PostGIS, vector tiling (MVT), and GIS workflows**"

Responsibilities include "**Optimize for Latency:** Solve the '500-element wall' with **partial GPU
buffer updates**."

**Read the structure of that posting, not just its words.** Projections and linear algebra are
**required**; deck.gl and MapLibre are **nice-to-have**. The library is the easy half. The maths and
the frame budget are the hard half. **[INFERENCE]**

Planet Labs' **Data Visualization Engineer**
([Greenhouse 8044691](https://job-boards.greenhouse.io/planetlabs/jobs/8044691)) **[POSTING]** shows
the other pole — a communications/storytelling role: "4+ years … preferably working with geospatial
and/or remote sensing data," "manipulating vector and raster data with core geospatial software"
(QGIS, ArcGIS, GDAL), Python, Adobe Creative Suite, with "working knowledge of … Javascript, React,
D3, NextJS, Svelte" and "experience with **web mapping and/or interactive web storytelling**" listed
under *what makes you stand out*. **Notably it does not mention deck.gl or WebGL at all.**

**[INFERENCE]** So "data visualisation engineer" splits into two distinct jobs — a *rendering/graphics*
job (Verkada: projections, buffers, shaders) and a *storytelling/analysis* job (Planet: GDAL,
narrative, design tools). Know which one you are claiming. Signal Zero straddles them and is
stronger on the analysis side.

### Serious vs decorative — the honest test **[INFERENCE]**

Decorative: a chart that could be a table; a map used as a background; a colour ramp chosen for
looks; a basemap with pins on it.

Serious, and Signal Zero already has three of these:
1. **The encoding answers a question the table cannot** — here, spatial contiguity of silence along
   a river corridor.
2. **The statistics are real and named.** Getis-Ord Gi* over a river-corridor adjacency graph is a
   published spatial-autocorrelation statistic, not a heatmap. **This is the single most
   differentiating thing in the project** and most "geospatial portfolio projects" have nothing like
   it.
3. **The negative space is the point.** Ranking by *absence* of reports rather than volume is a
   genuine analytical inversion. Say that in one sentence at the top of the README.
4. **Missing:** uncertainty. A Gi* z-score and an Exponential/Gamma baseline both have confidence
   attached. **Showing uncertainty in the visual encoding** — not just in a tooltip — is what
   separates a viz engineer from a chart author, and it is rare. **[INFERENCE]** This is the highest-
   value viz upgrade available to this project.

---

# 5. Testing

## 5.1 What postings literally say

- **Framer, Senior Product Engineer:** "**A strong knowledge of automated testing and QA.**" — one
  of only four requirement bullets in the whole posting. **[POSTING]**
- **Grove Collaborative:** "**Champion testing**, documentation, and workflows the rest of the team
  can build on"; under *Even better if you have*: "**component testing libraries, Vitest or Jest,
  and Cypress or Playwright**." **[POSTING]**
- **Anthropic (a11y):** "Develop **automated testing and agentic scanning infrastructure** that
  catches accessibility regressions across surfaces." **[POSTING]**
- **Figma Mobile Web:** participation in "user research, **testing**, and release duties."
  **[POSTING]**
- **what3words, Frontend Automation QA Engineer**
  ([Ashby](https://api.ashbyhq.com/posting-api/job-board/what3words)) — the most specific testing
  posting I found, verbatim: **[POSTING]**
  > "Experience building robust web automation frameworks using **Playwright**, with a focus on
  > reliable end-to-end and cross-browser functional testing."
  >
  > "Experience integrating Playwright test suites into build pipelines, including **parallel
  > execution, test reporting, trace/video capture, and flaky test management**."
  >
  > "Experience with build and configuration tools such as **GitHub Actions and CircleCI**."
  >
  > Extra credit for "**accessibility testing, visual regression testing, or performance testing**."

**Linear, Figma Full Stack, Stripe, Verkada and Vercel Site Engineer name no testing requirement at
all** in the text I read. **[POSTING]**

## 5.2 Expected vs rare **[INFERENCE, calibrated to the above]**

| | Signal |
|---|---|
| **Table stakes** | Unit tests exist. Some CI runs them. |
| **Expected at senior** | Playwright/Cypress E2E on the critical path; component tests; tests in CI on every PR. Note Grove lists Playwright under *even better* — E2E is still differentiating outside QA-titled roles. |
| **Genuinely rare** | **Flaky-test management** (named explicitly by what3words). Trace/video capture on failure. **Visual regression** — listed as *extra credit* even in a dedicated QA role. **Automated a11y in CI that fails the build** — Anthropic is hiring a Staff engineer at $320k+ to build exactly this. |
| **Rarer still, and this project's actual edge** | **Adversarial and property-based evaluation of non-deterministic behaviour.** Nothing in my sample asked for it. Signal Zero has 157 eval checks (19 tracked files, 4 families) covering golden-set classification, deterministic property tests, prompt-injection adversarials and harness fault-resilience, with a runner emitting JSON + human report. |

**[INFERENCE]** For an AI-adjacent role in 2026, the eval suite is worth more than the 195 unit
tests, and **the fact that a guardrail was observed blocking a real input** (`injection.invisible-characters`)
is worth more than either. That is a *demonstrated* control, not a claimed one. Lead with the
observation, not the count.

**The critical gap:** there is **no `.github/workflows`**. 195 tests and 157 eval checks that don't run
automatically are, to a reviewer, tests that might not pass. what3words names GitHub Actions
explicitly. **This is the single highest-leverage missing item in the entire project.**

---

# 6. Design craft

## 6.1 How much do postings actually weight it?

More than people expect, and it is usually phrased as **product sensibility / craft / detail**
rather than "design skills."

- **Linear**, identically at both levels: "**Product sensibility: you care about UX, speed, and
  polish**"; Linear's careers page states they want people who "share our passion for software
  **craftsmanship and getting even the smallest details right**." **[POSTING]**
- **Figma Full Stack:** "**Passion for engineering craft** and building polished, maintainable, and
  scalable systems"; "balance **user experience craft** with performance and architecture quality."
  **[POSTING]**
- **Verkada Staff:** "**Eye for Detail: Pixel-perfect execution—you notice the half-pixel
  misalignment, the 16ms jank**"; "**Set the UX Bar:** Partner with Design to define the interaction
  model for spatial editing." **[POSTING]**
- **Vercel Site Engineer:** "contribute to our **design system** and uphold industry-leading UX
  standards (e.g., **interactions, micro-animations, layout consistency**)"; "visually stunning web
  experiences." **[POSTING]**
- **Airbnb:** "**Product mindset** with strong communication." **[POSTING]**
- **Grove:** "Partner with UX Design to define and scale our **design system and UI component
  library**." **[POSTING]**
- **Ashby, Design Engineer** (via [YC job board](https://www.ycombinator.com/companies/ashby/jobs/3UaRO5l-design-engineer-uk),
  since Ashby's own page is client-rendered): the role "isn't just a Frontend Engineer with new
  branding, nor … a Designer vibe coding prototypes"; it "truly expects you to design and code."
  Requires "at least 5 years … as a full-time front-end engineer **and** significant contributions
  to a product's design or design systems," *or* 2.5+ years each as designer and frontend engineer;
  "Deep knowledge of React, CSS, and HTML." **[POSTING]**
- **Notion, Product Designer:** "craft every detail of new product features, from idea to UX to
  **pixel-perfect execution**," with "a designer who can code" as a nice-to-have.
  **[POSTING]** ([Notion job board](https://api.ashbyhq.com/posting-api/job-board/Notion))

**Count over my sample: craft/polish/detail language appears in 7 of the ~20 postings, and in
essentially every posting from a design-led product company (Linear, Figma, Vercel, Verkada, Ashby,
Notion).** Stripe and MapLibre are the clean counterexamples — pure systems/graphics roles that
don't mention it.

## 6.2 Senior product-engineering taste vs decoration **[INFERENCE]**

The postings themselves suggest the discriminator, and it is not aesthetics — it is **restraint plus
system**.

Decoration: gradients, glow, glassmorphism, animated everything, a dark theme with no light theme, a
dashboard that looks like a movie prop.

Taste, per the actual language above:
- **"layout consistency"** and **"design system"** (Vercel, Grove) → a token set and a spacing scale
  you can point to, not one-off values.
- **"half-pixel misalignment"** (Verkada) → optical alignment, correct baselines, consistent
  border-radius nesting.
- **"micro-animations"** (Vercel) → motion that communicates state change, respects
  `prefers-reduced-motion`, and stays inside the frame budget.
- **"polish"** (Linear) → the states nobody builds: empty, loading, error, zero-results, stale-data,
  offline, and the long-string / long-number overflow case.
- **"pixel-perfect execution"** (Notion, Verkada) → it holds up at 320 px wide and at 200 % browser
  zoom.

**[INFERENCE]** For a crisis console specifically, taste is legible as **information hierarchy under
pressure**: what does an operator see first, what is suppressed, how is uncertainty shown, and how
does the interface behave when the data is *wrong or missing* — which is this product's entire
premise. A screenshot of the empty state and the stale-data state, side by side in the README, will
read as more senior than any amount of visual polish.

---

# 7. Prioritised list for Signal Zero

Ordered by **(requirement coverage across the postings above) ÷ (effort)**. Every item traces to a
cited bullet.

### Tier 0 — do these first; they are cheap and they gate everything

1. **GitHub Actions CI.** Run the 195 tests + 157 eval checks on every push. Put the badge in the README.
   *Why:* what3words names GitHub Actions; Grove says "workflows the rest of the team can build on."
   Uncertified tests read as no tests. **Highest leverage item in the project.**
2. **TypeScript via `checkJs` + JSDoc + `tsc --noEmit` in CI.** No bundler, no build step, no change
   to how the page loads. *Why:* TypeScript is named by Linear, Framer, Figma, Airbnb, Anthropic,
   NYT, MapLibre — **more often than React**. This closes the largest single requirement gap at the
   lowest cost to the no-build position.
3. **LICENSE (MIT), README rewrite, one ADR on the no-build decision.** The ADR must include *what
   would change my mind*. *Why:* NYT requires "detailed technical documentation, including the
   ability to explain tradeoffs and rationale."
4. **Publish the measured payload table** (§3.4) in the README. *Why:* it converts the no-build
   decision from a claim into evidence. Nothing else in this list changes a reviewer's mind as fast.

### Tier 1 — the differentiators, now that they are provable

5. **Playwright E2E on the critical path**, in CI, with trace-on-failure. *Why:* Grove lists
   Playwright; what3words names trace/video capture and flaky-test management explicitly.
6. **`@axe-core/playwright` in the same suite, failing the build.** *Why:* Anthropic's Staff a11y
   role exists to build precisely this. Rare enough to be a talking point.
7. **Keyboard + screen-reader pass, written up honestly.** Roving tabindex on the tabs; sortable
   headers as real buttons; **document the map's non-visual equivalent path**; name the screen
   reader you used and one bug it found; list the WCAG 2.2 AA criteria you do *not* meet.
   *Why:* Anthropic names VoiceOver/NVDA/JAWS/TalkBack; Airbnb wants "excellence," not awareness.
8. **Measure LCP / INP / CLS on the real console and publish a budget** that CI enforces.
   *Why:* Airbnb "performance optimization," Verkada "16ms jank," Linear "speed." A data-heavy map
   console is an INP risk — measure before claiming.
9. **Fix the 114 s regression** (was 37 s) and the tier-3 15 s turn timeout, and **write up the
   root cause**. *Why:* a documented, root-caused, fixed performance regression is a better
   interview story than a project that was always fast. You already do this well — the kysely
   `FileMigrationProvider` ESM finding and the dropped `compaction.trigger` are exactly the right
   genre. Do it for your own code too.

### Tier 2 — production credibility

10. **Persistence.** In-memory state lost on restart is the gap most likely to end a systems
    conversation badly. SQLite is sufficient and keeps the deploy story simple.
11. **Dockerfile + one-command deploy.** Reviewers who cannot run it will not run it.
12. **Linter + formatter** (`eslint` + `prettier`, or `biome` for one dependency). Grove:
    "workflows the rest of the team can build on."
13. **Uncertainty in the visual encoding** — Gi* z-score confidence and the Gamma-prior interval
    rendered, not hidden in a tooltip. *Why:* §4.2. This is the rarest data-viz skill and the one
    that best matches what this project actually computes.
14. **SECURITY.md, CONTRIBUTING.md, CHANGELOG.md.** Cheap; signals you've worked somewhere real.

### Tier 3 — resume-shaped, not project-shaped

15. **Build a small React + TypeScript artifact.** A weekend. Removes the "cannot verify React"
    screen failure permanently and is what makes Signal Zero's vanilla-JS choice legible as a
    *choice*. See §1.4.

### Explicitly deprioritised

- **Do not rewrite Signal Zero in React.** §1.4.
- **Do not add auth**, unless applying to security roles. It adds surface, not signal, to a
  read-only public console.
- **Do not chase load testing** before persistence exists. Load-testing an in-memory store measures
  nothing.
- **Do not target WCAG 3.0.** It is a Working Draft that says not to cite it as anything but a work
  in progress. **[SPEC]**

---

# 8. Everything I could not verify

Listed so nothing here gets treated as established.

- **Shopify** engineering postings — client-rendered board; no first-party requirement text obtained.
- **Observable** (the company) — no live first-party engineering posting found.
- **Durable** and **Lumimeds** Core Web Vitals bullets — search snippets only; both Greenhouse pages
  rendered as index listings on fetch. Not quoted.
- **web.dev vitals changelog** — both candidate URLs returned 404.
- **EN 301 549 v3.2.1 → WCAG 2.1 AA mapping** — sourced only from accessibility-vendor marketing
  pages, not from ETSI.
- **Claims that Google changed Core Web Vitals methodology in 2026** — SEO-content sites only, no
  Google primary source. Chrome's own soft-navigations doc says CrUX reporting is still undecided.
  Treat the 2026-change claims as unsupported.
- **Any percentage of frontend postings that mention accessibility / testing / performance.** I read
  ~20 postings. Counts over that sample are given where relevant and are labelled as such. There is
  no defensible population statistic in this document.
- **Ashby's Design Engineer posting** — quoted from the Y Combinator mirror; Ashby's own
  `jobs.ashbyhq.com` page and its posting API did not return the description.
- **Stripe's interview-process page** — 404 at `stripe.com/careers/interview-process`. The
  "choose your own language" statement comes from Stripe careers material surfaced in search, and
  is weaker evidence than the job posting itself, which I did read in full.

---

## Source index

**Job postings (primary):**
Linear · https://api.ashbyhq.com/posting-api/job-board/Linear ·
Framer · https://www.framer.com/careers/senior-product-engineer ·
Figma Full Stack · https://boards.greenhouse.io/figma/jobs/5691911004 ·
Figma Mobile Web · https://boards.greenhouse.io/figma/jobs/6100023004 ·
Vercel Site Engineer · https://job-boards.greenhouse.io/vercel/jobs/5732855004 ·
Airbnb · https://careers.airbnb.com/positions/8138069 ·
Stripe Full Stack · https://stripe.com/jobs/listing/full-stack-engineer-developer-experience-product-platform/6567104 ·
Anthropic Staff SWE Accessibility · https://jobs.menlovc.com/companies/anthropic/jobs/79778982-staff-software-engineer-accessibility ·
NYT Games · https://job-boards.greenhouse.io/thenewyorktimes/jobs/4713043005 ·
Verkada Mapping · https://job-boards.greenhouse.io/verkada/jobs/5215839007 ·
Planet Labs Data Viz · https://job-boards.greenhouse.io/planetlabs/jobs/8044691 ·
MapLibre Graphics Engineer · https://maplibre.org/jobs/graphics-engineer/ ·
what3words QA · https://api.ashbyhq.com/posting-api/job-board/what3words ·
Grove Collaborative · https://job-boards.greenhouse.io/grovecollaborative/jobs/5381745008 ·
Notion · https://api.ashbyhq.com/posting-api/job-board/Notion ·
Ashby Design Engineer (mirror) · https://www.ycombinator.com/companies/ashby/jobs/3UaRO5l-design-engineer-uk ·
Linear careers · https://linear.app/careers

**Standards & regulation:**
WCAG 2.2 · https://www.w3.org/TR/WCAG22/ ·
WCAG 3.0 WD · https://www.w3.org/TR/wcag-3.0/ ·
DOJ ADA Title II web rule · https://www.ada.gov/resources/2024-03-08-web-rule/ ·
EAA Directive (EU) 2019/882 · https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32019L0882 ·
Core Web Vitals · https://web.dev/articles/vitals ·
Soft Navigations · https://developer.chrome.com/docs/web-platform/soft-navigations

**Surveys & published arguments:**
Stack Overflow Developer Survey 2025 · https://survey.stackoverflow.co/2025/technology ·
Alex Russell, "The Market for Lemons" · https://infrequently.org/2023/02/the-market-for-lemons/ ·
DHH, "You can't get faster than No Build" · https://world.hey.com/dhh/you-can-t-get-faster-than-no-build-7a44131c ·
Observable Plot · https://observablehq.com/plot/
