# Signal Zero — Architecture Decision Records

**Date:** 30 August 2026. **Author:** principal-engineer review for the rebuild.
**Companion documents:** `docs/GAP-ANALYSIS.md` (why), `docs/BUILD-PLAN.md` (order).

Each record uses the standard form: **Context / Decision / Consequences / Alternatives considered**,
plus a **Status** line and a **What would change my mind** line. That last section is not decoration —
it is the difference between an engineer and an advocate, and `frontend-bar` §1.4 names it explicitly
as the thing a reviewer looks for.

**Evidence discipline.** Every claim is either cited to a URL carried through from the four hiring
research reports in `docs/hiring/`, cited to a file in this repository, or labelled **[JUDGEMENT]**.
Nothing is asserted as industry consensus that a source does not say.

**Index**

| # | Decision | Class |
|---|---|---|
| 001 | Types: JSDoc + `checkJs`, not a TypeScript port | table-stakes |
| 002 | Frontend: keep the no-build vanilla console; prove React/TS elsewhere | table-stakes + optional |
| 003 | Persistence: Postgres, append-only observations, hand-rolled SQL migrations | table-stakes |
| 004 | Observability: OTel traces + metrics, structured logs, Prometheus/Grafana | differentiator |
| 005 | SLOs: freshness, coverage, correctness — where the SLI *is* the product | differentiator |
| 006 | CI/CD: what runs, and what gates a merge | table-stakes |
| 007 | Deployment: multi-stage container, compose, one PaaS. No Kubernetes | table-stakes |
| 008 | Security: attribution without authentication; threat-model scope | differentiator |
| 009 | Testing: target shape, and how non-determinism is handled | differentiator |
| 010 | Evals: statistical defensibility, and honest accounting | differentiator |
| 011 | Ranking: change the primary sort key (closes critical `B3.2b`) | table-stakes |
| 012 | API contract: OpenAPI 3.1, RFC 9457, idempotency, async run | differentiator |
| 013 | Agent topology, per-tool risk classification, and the skills decision | differentiator |
| 014 | Probe allocation: bandit + offline policy evaluation — deferred, with a trigger | optional |
| 015 | The refusal register: what we will not build, and why | table-stakes |

---

## ADR-001 — Types: JSDoc plus `tsc --checkJs`, not a TypeScript port

**Status:** Accepted.

### Context

The repository has no type checking of any kind — no `tsconfig.json`, no JSDoc annotations enforced,
no `tsc` in any script. `frontend-bar` §1.4 measured the demand and it is unambiguous: *"TypeScript
appears in more of the postings I read than React does"*, named as a literal requirement by Linear,
Framer, Figma, Vercel, Airbnb, Anthropic, NYT and MapLibre's own graphics-engineer posting
(https://maplibre.org/jobs/graphics-engineer/). Machinify's AI Engineer posting asks for structured
outputs via Pydantic/JSON Schema and type discipline
(https://job-boards.greenhouse.io/machinifyinc/jobs/4146862009). Both `ai-ml-bar` §7 item 12 and
`frontend-bar` §7 item 2 independently recommend the same mechanism: JSDoc plus `checkJs`, explicitly
*not* a port.

The codebase is ~10,400 lines of ESM JavaScript in `src/`, plus ~5,850 in `web/`. Two subsystems —
`src/guardrails/` and the statistical core in `src/pipeline/rank.js` and `dedup.js` — already clear a
senior bar (`GAP-ANALYSIS.md` §2.2, §2.3).

### Decision

Add a `tsconfig.json` with `allowJs: true`, `checkJs: true`, `noEmit: true`, `strict: true`, and run
`tsc --noEmit` as a **blocking** CI gate. Types are expressed as JSDoc annotations on exported
functions and as `@typedef` records for the six domain types the codebase already names in prose —
`Report`, `Cluster`, `RankedSettlement`, `CheckpointItem`, `IncidentEvent`, `Verdict`.

Adopt it **directory by directory**, in this order, each landing green before the next starts:
`src/guardrails/` → `src/pipeline/rank.js` + `dedup.js` → the rest of `src/pipeline/` →
`src/harness/` → `src/server.js` → `web/`. Use per-directory `include` scoping so partial adoption is
still enforced rather than advisory.

**No emit step, no bundler, no change to how anything loads or runs.** Node continues to execute the
same files.

### Consequences

- Closes the largest single requirement gap in the frontend bar without touching the no-build
  position at all (ADR-002 depends on this being true).
- `@typedef` records give the domain vocabulary one authoritative definition. The four hard rules in
  `README.md:174-194` include *"There is no dispatch-shaped field in any data structure"* — a typed
  `RankedSettlement` makes that a compile-time property in addition to a runtime test (`B7.1`).
- Expect real friction at `src/pipeline/triage.js` and `src/harness/trueforge.js`, where model output
  is `unknown` by nature. That friction is the point: it forces an explicit parse boundary, which is
  exactly where `parseTier3`'s allowlist-and-clamp already lives. **[JUDGEMENT]** Typing that
  boundary makes the existing security control legible as one.
- `strict: true` on `checkJs` over an untyped 10 kLOC codebase will produce hundreds of initial
  errors. The directory-by-directory rollout is what makes that tractable; a big-bang attempt will be
  abandoned halfway and leave a red gate, which is worse than no gate.

### Alternatives considered

- **Full port to `.ts` with a build step.** Rejected. `ai-ml-bar` §7 "Do NOT bother": *"High cost,
  low marginal signal over `checkJs`. It would also churn a codebase whose real strength is the
  statistics and the guardrails."* It would also destroy ADR-002's central claim, since a build step
  for types is still a build step.
- **JSDoc with `checkJs` as a warning, not a gate.** Rejected: an unenforced type checker is
  documentation. `security-qa-bar` §9's critique of coverage applies identically — a metric nobody
  fails on is a metric nobody obeys.
- **Runtime schema validation (zod) instead of static types.** Not an alternative — it is
  complementary and belongs only at the two untrusted boundaries (model output, HTTP request body).
  Not adopted now; noted in ADR-012 as a possible follow-on.

### What would change my mind

If `tsc --checkJs --strict` cannot be made green over `src/guardrails/` in under a day, the
annotation burden is heavier than estimated and the right retreat is `strict: false` with
`noImplicitAny` only — still a gate, still a real signal, materially less work.

---

## ADR-002 — Frontend: keep the no-build vanilla console; prove React/TypeScript in a separate artefact

**Status:** Accepted. **This is the highest-stakes call in this document and the research contains a
direct recommendation, so it is engaged with at length.**

### Context

Signal Zero's frontend is vanilla ESM + MapLibre GL with no build step: `web/app.js` (2,368 lines),
`web/map.js` (1,333), `web/lib.js` (425), `web/styles.css` (1,434), `web/index.html` (291).

**The research is genuinely split, and the split is real rather than cosmetic.**

`frontend-bar` §1.1 is blunt and I am not going to soften it: React + TypeScript is a **literal stated
requirement**, not a preference, at Linear (identically at both the 2–5 yr and 5+ yr levels), Framer,
Figma, Vercel, Airbnb, Anthropic's Staff Accessibility role, NYT Games, Verkada and Ashby. The
counter-evidence is also real and is three separate things: (a) Stripe's Full Stack posting names no
framework at all and requires *"Strong coding skills in any programming language"*
(https://stripe.com/jobs/listing/full-stack-engineer-developer-experience-product-platform/6567104);
(b) even framework-requiring postings list platform fundamentals separately and sometimes first —
Verkada's bullet reads *"JavaScript fundamentals … and React expertise"*; (c) a credible published
argument that the framework default is a mistake exists, from Alex Russell
(https://infrequently.org/2023/02/the-market-for-lemons/) and DHH
(https://world.hey.com/dhh/you-can-t-get-faster-than-no-build-7a44131c).

`frontend-bar` §1.4 then makes the argument that actually decides it, and it is an argument about
**asymmetry, not about technology**:

> A reviewer who wants React and sees no React **cannot verify** you have it… A reviewer who sees
> React on the resume **and then** finds a project that says "here is where I chose *not* to use a
> framework, and here is the measurement that justified it" reads that as senior judgement.

And the conclusion: *"the reasoning-document strategy works, but only downstream of the keyword
screen, not through it. The document is an interview weapon, not a resume weapon."*

`ai-ml-bar` §7 independently reaches the same conclusion about the rewrite from a different
direction: *"No AI-engineering posting in my sample asked for a specific frontend framework."*

Meanwhile, **[MEASURED] 2026-08-30**, gzip -9 of the shipped assets: MapLibre 281 KB, all
author-written code 82 KB, 361 KB gz total. **78% of the payload is the third-party map engine.**

### Decision

**Three-part decision. All three parts are required; any one alone is wrong.**

1. **Do not rewrite Signal Zero in React.** The differentiated content — Fellegi–Sunter linkage,
   Getis-Ord Gi* over a corridor graph, the deterministic guardrails, the eval suite, the MapLibre
   *terrain* surface — is entirely orthogonal to the view layer. A rewrite burns weeks and adds zero
   signal to any of it.
2. **Add TypeScript via ADR-001.** This closes the larger half of the requirement — the half named in
   more postings than React — at near-zero cost and without compromising the no-build position.
3. **Build one small, separate React + TypeScript artefact** and put it on the resume. A weekend. Its
   only job is to make the keyword screen a non-event, and to convert Signal Zero's vanilla choice
   from an unverifiable claim into a legible decision. **[JUDGEMENT]** Make it something that reads
   as deliberate rather than as a tutorial: the strongest candidate is a React/TS **trace viewer** for
   the OTLP spans ADR-004 produces — it consumes this project's own output, so it is not a
   disconnected toy, and Husain argues directly for domain-specific trace-viewing tools to *"remove
   all friction from the process of looking at data"* (https://hamel.dev/blog/posts/evals/).

**And publish the measurement.** Put the 361 KB table in the README with one sentence: *the bundler
we do not have would minify 82 KB of hand-written source; over gzip that saving is a small fraction
of a payload that is 78% third-party map engine — the build step would not have been the thing that
made this fast.* That is falsifiable, specific, and currently published nowhere.

### Consequences

- The no-build ADR only reads as judgement once part 3 exists. **Until then it reads as
  unfamiliarity, and there is no way to prove otherwise from a resume line.** This is the
  uncomfortable half of the decision and it is stated here so it cannot be forgotten.
- Three surfaces to keep honest instead of two.
- Signal Zero keeps genuine properties a framework would cost: zero third-party runtime dependencies
  beyond MapLibre, no supply-chain surface in the view layer, and shipped source a reviewer can read
  directly in DevTools.
- **[JUDGEMENT]** The 2,368-line `web/app.js` is the real risk this decision carries. A single file
  of that size is where "no framework" stops being a taste decision and starts being a maintenance
  argument against itself. Splitting it into modules is not optional if this ADR is to survive
  contact with a reviewer who opens it.

### Alternatives considered

- **Full React/Next.js rewrite.** Rejected per above. It would also make the payload *worse*, and
  the measurement is the strongest asset the frontend has.
- **A lighter framework (Preact, Lit, Alpine) as a compromise.** Rejected. It satisfies neither
  camp: it does not clear the React keyword screen, and it forfeits the no-build argument for a
  framework nobody asked for. **[JUDGEMENT]** The worst of both.
- **Vanilla only, no second artefact, defend it with the ADR.** Rejected on `frontend-bar` §1.4's
  asymmetry argument. This is the option a strong engineer is most tempted by, and the reason to
  refuse it is not technical — it is that recruiters do first-pass screening at that tier, and a
  document they never open cannot help.
- **A second artefact in something other than React** (Svelte, Vue). Rejected on evidence: React is
  the plurality at 44.7%/46.9% (https://survey.stackoverflow.co/2025/technology) and is the one
  actually named in the postings.

### What would change my mind

If the target roles shift to Stripe-shaped generalist backend/AI roles where no framework is named,
part 3 becomes optional and I would drop it. If a Linear/Framer/Figma-tier application is actually
submitted, part 3 becomes urgent and moves ahead of several table-stakes items.

---

## ADR-003 — Persistence: Postgres, an append-only observations table, hand-rolled numbered SQL migrations

**Status:** Accepted.

### Context

`src/store.js` is a plain object of arrays; its own header says *"No database."* Everything is
rebuilt by a pipeline run and lost on restart, including the incident feed and checkpoint decisions
that the same file calls *"the human-facing audit trail"*.

`platform-bar` §3 states the argument that makes this a correctness bug rather than an infrastructure
gap: **the product measures elapsed time since last observation, so a store that forgets on restart
cannot measure its own core metric across a restart.** `ai-ml-bar` §7 item 7 agrees:
*"a time-since-last-report system that forgets time on restart is a correctness bug, not a missing
feature."*

**[JUDGEMENT]** There is a second-order consequence neither report drew out and it is the stronger
one: `rank.js` fits λ by maximum likelihood from inter-arrival gaps per cohort. In an in-memory store
those gaps exist only inside one pass's corpus, so the "cohort baseline" the product quotes has a
maximum meaningful life of one process uptime. **Persistence is not state preservation here. It is
what makes the baseline a baseline** — and it is a prerequisite for ADR-011.

Postgres vs SQLite is a genuine disagreement across the reports; `GAP-ANALYSIS.md` §4.2 resolves it.

### Decision

**Postgres, with an append-only `observations` table as the spine.**

Core schema — deliberately small:

- `observations (id, settlement_id, observed_at, ingested_at, source, report_id, run_id)` —
  **never updated, never deleted**, B-tree on `(settlement_id, observed_at DESC)`.
- `reports`, `clusters`, `ranked_snapshots` — derived, rebuilt per run, keyed by `run_id`.
- `checkpoint_items` and `approvals` — mutable status, but the approval record is append-only and
  hash-chained (ADR-008).
- `incidents` — append-only. **The 200-item ring buffer in `src/store.js:21` disappears the moment
  this lands, which makes `/api/state`'s incident feed genuinely unbounded and makes cursor
  pagination required at exactly that moment** (ADR-012).

**Migrations: numbered plain-SQL files plus a ~40-line runner, applied automatically at boot behind
an advisory lock.** Not an ORM, not a migration framework.

**The reason is specific and it is this repository's own finding.** `docs/trueforge-verified.md`
root-causes an upstream Windows crash to a dynamic `import()` of an absolute path without
`pathToFileURL()` inside kysely's `FileMigrationProvider` — a migration library, breaking on the
platform this project is developed on, discovered by this project. **[JUDGEMENT]** Choosing a
migration mechanism *because* of a documented migration-library failure converts a debugging war
story into an architectural decision, which is the shape of a senior narrative. `platform-bar` §3.2
independently suggests the same move. Numbered SQL is also the mechanism with the fewest moving
parts, and no posting retrieved in any of the four reports names a specific Node migration tool —
what is screened for is whether schema changes are versioned, ordered, reviewable and applied
automatically.

### Consequences

- One `docker compose up` now brings up two services (ADR-007). A reviewer can run it.
- The Exponential TBE baseline becomes meaningful across restarts, which is what ADR-011 needs.
- Cursor pagination on the incident feed becomes required, not optional.
- Freshness becomes queryable — `max(observed_at) per settlement` — which is exactly the SLI in
  ADR-005. **[JUDGEMENT]** The schema and the SLO fall out of the same design, which is the
  strongest available evidence that the design is right.
- Cold-start semantics need care: a settlement with no rows is *"no data reached us"*, never
  *"confirmed silent"*. That distinction is hard rule 4 and is already enforced by
  `src/guardrails/honest-unknown.js`; the schema must not make it easy to violate. A `NULL`
  `last_observed_at` must never be coalesced to a timestamp.

### Alternatives considered

- **SQLite with WAL.** Genuinely defensible and technically adequate — by SQLite's own checklist
  (https://www.sqlite.org/whentouse.html) this workload qualifies: one process, one writer, no
  network separation, thousands of rows. Two of the three research reports recommend it. Rejected on
  deploy topology (every PaaS gives an ephemeral filesystem; SQLite then needs a persistent volume
  and storage attachment becomes something to manage) and on hiring signal (PostgreSQL 55.6% vs
  SQLite 37.5%, https://survey.stackoverflow.co/2025/technology). **[JUDGEMENT]** One
  project-specific reason neither report gave: TrueForge already runs SQLite inside the `tforge`
  container, so choosing SQLite for the app makes our state and the harness's state
  indistinguishable in the deployment story. They should not share a failure mode.
  **Record in the README that SQLite was considered and why it lost.** The reasoning is the signal.
- **TimescaleDB.** Refused. See ADR-015.
- **PostGIS.** Refused. See ADR-015.
- **Event sourcing.** Refused as a *term*, adopted in the only part that pays: the observations
  table is an immutable fact table, which is not event sourcing. See ADR-015.
- **`node-pg-migrate` / Umzug / Drizzle.** Any would clear the bar. Rejected in favour of numbered
  SQL because the justification above is stronger than "it is popular", and because fewer
  dependencies is a real property on a project with four.

### What would change my mind

If the deployment target turns out to be a single always-on VM with a real disk, SQLite's argument
gets materially stronger and the decision should be re-opened rather than defended.

---

## ADR-004 — Observability: OpenTelemetry traces and metrics, structured logs, Prometheus + Grafana

**Status:** Accepted.

### Context

There is no instrumentation. **[MEASURED]** there is no winston either — logging is 30 bare
`console.*` calls, correcting the brief. Consequences: the 37 s → 114 s regression has no
before/after; the fallback rate is invisible; the guardrail rule that fired is a log line; a failing
eval case cannot link to the trace that produced it.

Two precision points the research establishes and that most projects get wrong:

- **OpenTelemetry signal maturity is per-language.** For JavaScript/Node: **Traces Stable, Metrics
  Stable, Logs Development** (https://opentelemetry.io/status/,
  https://opentelemetry.io/docs/languages/js/). OTel graduated from the CNCF on 21 May 2026
  (https://www.cncf.io/announcements/2026/05/21/cloud-native-computing-foundation-announces-opentelemetrys-graduation-solidifying-status-as-the-de-facto-observability-standard/),
  though the CNCF's own project-listing page still showed it as incubating on 2026-08-30 — a source
  disagreement `platform-bar` §4.1 reports rather than smooths.
- **The GenAI semantic conventions are *not* stable.** Verified first-hand in `ai-ml-bar` §5.1: the
  dedicated repo `open-telemetry/semantic-conventions-genai` was created 2026-05-05, its releases
  list returns `[]`, and all 16 stability markers in `model/gen-ai/spans.yaml` read `development`.

### Decision

**Traces and metrics via OpenTelemetry. Logs stay outside OTel until the JS logs SDK stabilises.**

1. **Traces.** `@opentelemetry/sdk-node` with auto-instrumentation for `http` and `express`. One root
   span per pipeline run; child spans per stage (`ingest → triage → dedup → rank → checkpoint →
   failfeed`); a child span per TrueForge turn and per guardrail evaluation. Use the **stable** HTTP
   semantic conventions verbatim (https://opentelemetry.io/docs/specs/semconv/http/http-spans/). For
   pipeline-internal spans there is no convention, so invent a documented namespace —
   `signalzero.stage`, `signalzero.settlement_id`, `signalzero.run_id`. Inventing names where a
   stable convention exists is the mistake; inventing them where none exists is just naming.
2. **GenAI attributes.** Emit `gen_ai.*` on model spans **and write in the docs that these
   conventions are Development status, in a dedicated repository with no tagged release, and may
   change.** **[JUDGEMENT]** That sentence is worth more than the attributes. Every candidate can
   write "OpenTelemetry-compliant"; the one who states the maturity correctly has demonstrably read
   the status page.
3. **Span attributes that make this project's existing work visible.** Tool-call outcome as a
   first-class attribute (`success | schema-validation-failure | timeout | guardrail-blocked |
   human-denied | agent-refusal`); the guardrail **rule id** that fired (`injection.invisible-characters`
   is a real observed block and belongs in a span attribute, not a log line); per-turn token counts
   and cache reads (already collected on `turn.done` — `docs/trueforge-verified.md:153` records
   1,728 of 2,770 input tokens cached on one measured turn, and `platform-bar` §4.3 cites 32,032 of
   33,242 on another; **I re-verified neither figure, only that the telemetry exists** — and it is
   currently invisible to any dashboard); executor
   (`trueforge-harness | trueforge-harness-inline | direct-fetch-fallback | none`).
4. **Metrics.** OTel metrics exported via the Prometheus exporter. **RED** on the six HTTP routes
   (rate, errors, duration as a **histogram**, not a mean — p50/p95/p99 or it answers nothing).
   RED-analogous per pipeline stage: invocations, failures, duration histogram — *this is the
   instrumentation that turns the 114 s regression from a mystery into a graph, and that sentence
   belongs in the README.* **USE**-style saturation signals appropriate to Node: event-loop lag via
   `perf_hooks.monitorEventLoopDelay`, heap used vs limit. (Railway's posting asks literally for Node
   internals — event loop, memory behaviour, and what to do when a service degrades under load:
   https://railway.com/careers/scalability.)
5. **Domain counters:** guardrail blocks by rule id; incidents by kind
   (`degraded-source | llm-fallback | cold-start | heal | agent-refusal`); tier-3 fallback rate;
   harness turns; cache-read ratio.
6. **Logs.** Keep `console` behind a thin structured-JSON wrapper emitting `trace_id`, `span_id` and
   `run_id` on every line. Migrate to the OTel logs SDK when it leaves Development. **[JUDGEMENT]**
   Do not add winston to get structured logs — `JSON.stringify` and a level constant is twenty lines
   and one fewer dependency, and this project's dependency count is itself a claim.
7. **Backends.** A compose profile bringing up Prometheus + Grafana with a **committed dashboard
   JSON**, and self-hosted **Langfuse** as the OTLP GenAI backend — it is open source and receives
   OTLP over HTTP at `/api/public/otel` (https://langfuse.com/docs/opentelemetry/get-started).
8. **Surface the trace id in the UI and in eval output**, so a failing eval case links to the exact
   trace.

### Consequences

- The 114 s question becomes answerable, and (7) plus (4) make the answer a picture. `platform-bar`
  §4.3 is blunt about the ranking: *"A committed, screenshotted dashboard is worth more than twice as
  many metrics with no dashboard — reviewers look at pictures."*
- The eval suite gains a link from every red case to its trace, which is Husain's
  friction-removal argument made concrete.
- Instrumentation cost on a pipeline whose spans are seconds long is negligible; on the guardrail
  path, which runs per report, spans must be cheap — prefer counters there and a single span per
  `guardInput`/`guardOutput` call rather than per rule.
- A new dependency surface (`@opentelemetry/*` is not small). **[JUDGEMENT]** This is the one place I
  accept a meaningful dependency increase, because the alternative is a project that cannot explain
  its own latency.

### Alternatives considered

- **Prometheus metrics only, no traces.** Cheaper, and it answers "how often" but never "why did
  *this* run take 114 s". Rejected: the causal question is the one this project needs.
- **A hosted vendor (LangSmith, Braintrust, Datadog).** Rejected: a reviewer cannot run it, and the
  self-hosted OTLP path demonstrates the standard rather than a product.
- **OTel logs now.** Rejected on the published status matrix — Development in JS. Getting this
  distinction right is itself the differentiator.
- **Custom timing counters instead of OTel.** Rejected: it would answer the latency question and
  demonstrate nothing transferable.

### What would change my mind

If OTel auto-instrumentation measurably distorts the latency being measured, drop the auto-
instrumentation and hand-instrument the six stages. The measurement matters; the SDK does not.

---

## ADR-005 — Service level objectives: freshness, coverage, correctness

**Status:** Accepted.

### Context

The Google SRE Workbook defines three SLI categories specifically for data-processing pipelines:
**freshness** (proportion of data updated more recently than a threshold), **correctness**
(proportion of records that produced the correct output) and **coverage** (proportion of records
successfully processed) — https://sre.google/workbook/implementing-slos/.

`platform-bar` §3.4 makes the observation that is the single strongest idea available to this
project: **freshness is not an operational metric for Signal Zero. Freshness *is* the output.** The
pipeline's SLI and the product's core computation are the same quantity measured at two layers.

**[JUDGEMENT] The extension worth making, which the research did not:** the Workbook's third
category, **correctness**, also already exists here — `harmWeightedErrorRate` in `evals/lib/score.js`
is a correctness measurement with a stated domain weighting. Which means `A8.1` — *harm-weighted
error rate 0.281 with tiers 1+2, 0.375 with live tier 3* — **is already an A/B of a system component
against a correctness SLI that concluded "turn the component off."** Signal Zero has been making
eval-gated component decisions without naming them. Naming them is free.

### Decision

**Declare exactly three SLOs, no more.** The SRE Book's own advice is to keep the number to the
minimum that covers the system (https://sre.google/sre-book/service-level-objectives/).

| SLO | SLI | Why this one |
|---|---|---|
| **Freshness** | p95 age of the newest observation per gazetteer settlement, over a rolling window | It *is* the product. Requires ADR-003. |
| **Coverage** | proportion of gazetteer settlements with any observation in the last N hours; proportion of ingested reports surviving to a ranking | Directly measures the failure the product exists to prevent — a source silently dropped manufactures fake silence. |
| **Correctness** | golden-set harm-weighted error rate, exported as a gauge from the CI eval run | Converts the eval suite from a CI artefact into a live SLI. |

Publish the targets, measure them, **and publish a miss honestly when one happens.** Error budget is
the complement of the target. Burn-rate alerting per
https://sre.google/workbook/alerting-on-slos/ — multiwindow, multi-burn-rate — is documented as the
correct method and **not implemented**, because there is no on-call rotation to page and an alert
nobody receives is theatre. Say that in the SLO document rather than omitting it.

Availability of `/api/state` is deliberately **not** an SLO. It is measured (ADR-004) and left
unpromised. **[JUDGEMENT]** Three SLOs that are evaluated beat four where one is decoration.

### Consequences

- The README gains a sentence almost no other portfolio project can write: *the freshness SLI of this
  pipeline and the output of this product are the same number, computed at two layers.*
- Freshness as an SLO makes the persistence decision self-justifying: an in-memory store literally
  cannot report it across a restart.
- A published SLO can be missed. That is the point; a miss with a burn chart and an honest write-up
  is stronger evidence of production judgement than a target nobody evaluates.

### Alternatives considered

- **No SLOs, just dashboards.** Rejected: Anthropic's Staff SWE AI Reliability posting names
  developing SLOs for LLM serving systems as a responsibility
  (https://job-boards.greenhouse.io/anthropic/jobs/5113224008). The dashboards are the input, not the
  artefact.
- **Availability/latency SLOs like a normal web service.** Rejected as the *primary* set — they would
  be generic, and they would waste the alignment that makes this project's SLO story unusual.
- **Implementing burn-rate paging.** Rejected as padding without a rotation. Documented instead.

### What would change my mind

If the app is publicly deployed and anyone actually depends on it, `/api/state` availability becomes
a real SLO and the burn-rate alerting stops being theatre.

---

## ADR-006 — CI/CD: what the pipeline runs, and what gates a merge

**Status:** Accepted. **All four research reports rank this their number-one item.**

### Context

No `.github/`. 195 tests and 155 eval checks that no machine runs. `ai-ml-bar` Tier 0 item 1:
*"Highest signal-per-hour item in this list, by a wide margin."* `frontend-bar` Tier 0 item 1:
*"Highest leverage item in the project."* `security-qa-bar` table-stakes item 1: *"the single largest
credibility gap in the repo."* `platform-bar` §1.1 adds the framing that keeps this proportionate:
at senior level **CI is assumed, never asked for** — its absence is disqualifying and its
*sophistication* is only interesting if it demonstrably protects something real.

### Decision

**One workflow, `ci.yml`, on every push and every pull request. Everything below is a hard gate: red
blocks merge.**

| Job | Gate | Source |
|---|---|---|
| Install from lockfile (`npm ci`, not `npm install`) | reproducible install | OpenSSF Scorecard, https://github.com/ossf/scorecard |
| `tsc --noEmit` | ADR-001 | `frontend-bar` §7 item 2 |
| Lint + format check (single tool — Biome, one dependency) | ADR-006 | `platform-bar` Tier 1 item 7 |
| `npm test` — 195 unit tests, Node **20 × 24** matrix | catches the `engines: ">=20"` vs Node-24 gap `security-qa-bar` §9 found | `platform-bar` §1.2 — *"a matrix that earns its place"* |
| Coverage via `node --experimental-test-coverage`, lcov, **reported per subsystem, not gated on a number** | ADR-009 | Fowler, https://martinfowler.com/bliki/TestCoverage.html |
| `npm run eval -- --offline` on every PR | **the differentiating gate** | OpenAI Evals posting; `ai-ml-bar` Tier 0 item 1 |
| Full eval incl. live-harness families, **`--strict`**, nightly on a schedule with the `tforge` container up | keeps PR CI fast and hermetic | **[JUDGEMENT]** |
| Secret scan over **full history** (`gitleaks --no-git=false`) | `security-qa-bar` §3.2 — the layer candidates skip | GitGuardian on push-protection limits |
| CodeQL | free for public repos, feeds the Security tab | `platform-bar` §1.2 |
| Container builds **and boots and answers `GET /api/health`** | not just "it built" | `platform-bar` §1.2 |
| Playwright E2E + `@axe-core/playwright`, trace-on-failure | ADR-009 | what3words posting names trace/video capture and flaky-test management |
| Mutation score on the deterministic core, **reported, threshold advisory first** | ADR-009 | Thoughtworks Radar Vol. 34, ring = **Trial** |
| `permissions:` least-privilege; actions pinned to commit SHAs; Dependabot | Scorecard high-risk checks | https://github.com/ossf/scorecard |
| SBOM (CycloneDX) + `actions/attest-build-provenance` on release | **claim SLSA Build L2, never L3** | https://docs.github.com/en/actions/concepts/security/artifact-attestations |

**The eval gate is the item that differentiates this pipeline from every other portfolio pipeline,
and the flag combination matters.** **[REPO]** `evals/README.md:10-12` documents that `--offline`
makes live-dependency cases **SKIP**, while `--strict` makes **a SKIP a failure** — so
`--offline --strict` together can never pass, and specifying it would be an ADR that has not read
the tool it prescribes. The correct split:

- **On every PR:** `npm run eval -- --offline`. The runner already exits non-zero unless every case
  that *ran* passed. Print the skip count in the job summary so the coverage loss is visible rather
  than silent.
- **Nightly, with the `tforge` container up:** the full suite with `--strict`, so a skip is a
  failure and the live-harness families are genuinely exercised.
- **After ADR-009 item 3 (recorded replay) lands:** the model-touching families become hermetic, the
  skip count on PRs drops toward zero, and `--strict` becomes usable on the PR gate. **That is the
  concrete payoff of replay and the reason it is sequenced where it is.**

Publish `evals/report/latest.json` as a workflow artifact; post the four family scorecards as a PR
comment.

**The eval gate has a documented exception and it must be explicit:** `B3.2`/`B3.2b` are currently
red and are a *finding*, not a regression. Until ADR-011 lands, the gate runs with those two cases on
a named, dated allowlist that CI prints in full on every run. **[JUDGEMENT]** An allowlist that
announces itself is honest; a threshold quietly lowered to go green is the exact defect this project
exists to argue against.

### Consequences

- Every claim in every document becomes machine-verified by a stranger, which is the precondition for
  all the rest.
- CI runtime is the real constraint: unit tests 6.6 s, offline evals ~10 s, Playwright and mutation
  are the expensive jobs. Mutation runs on `src/guardrails/` + `rank.js` + `dedup.js` only, nightly,
  never on the PR path.
- A red PR pipeline stops work. That is the intent.

### Alternatives considered

- **CI that runs only unit tests.** Rejected: it leaves the strongest asset unexecuted.
- **Evals as a non-blocking informational job.** Rejected. Braintrust's GitHub Action and Promptfoo
  exist as products *because* merge-blocking eval gates are the practice, and OpenAI's Evals posting
  asks literally for *"continuous eval monitoring frameworks (regression/drift monitoring…)"*.
- **A 12-cell OS × version matrix.** Rejected as theatre on a single-service app. Node 20 × 24 is
  justified by a real declared/actual gap; nothing else is.
- **Separate ESLint + Prettier.** Rejected in favour of Biome: one dependency, one config, and this
  project's dependency count is part of its argument.

### What would change my mind

If offline evals prove flaky in CI, they move to nightly and the PR gate keeps only the deterministic
families B and C — but the gate does not become advisory. A gate that cannot fail is not a gate.

---

## ADR-007 — Deployment: multi-stage container, compose for local, one PaaS for the live URL. No Kubernetes

**Status:** Accepted.

### Context

No `Dockerfile`, no compose file, no `.dockerignore`, no deploy config, no live URL. **[MEASURED]**
`.env` is present in the working tree and gitignored — so the first naive Dockerfile would ship real
Bright Data and model-provider credentials into an image layer. That is a live secret-leak risk, not
a hypothetical one.

Evidence on scope: Docker 71.1% adoption vs Kubernetes 28.5%
(https://survey.stackoverflow.co/2025/technology). Cloudflare's 8+-year Senior Systems Engineer
posting never mentions Kubernetes (https://job-boards.greenhouse.io/cloudflare/jobs/8087792);
Airbnb's data-infrastructure posting lists it as *"familiarity with"*. `platform-bar` §2.2:
Kubernetes is *"a requirement of a job family, not of seniority."*

### Decision

1. **Multi-stage `Dockerfile`.** Builder installs with `npm ci`; runtime stage copies production
   `node_modules`, `src/`, `web/`, `evals/`. Base pinned by **digest** alongside the tag
   (`node:24-slim@sha256:…`), `USER node` (the official images already ship UID 1000 — do not invent
   one), `HEALTHCHECK` against the existing `GET /api/health` at `src/server.js:516`.
   Per https://docs.docker.com/build/building/best-practices/.
2. **`.dockerignore` first, before the Dockerfile exists** — `node_modules`, `.git`, `.env`,
   `evals/.scratch`, `evals/report`.
3. **`docker-compose.yml`: app + Postgres, one command.** `platform-bar` §2.3 is right that this is
   the highest-value artefact in the section: *"If `git clone && docker compose up` does not produce
   a working dashboard, nothing else in the repo gets evaluated."* Optional profiles for
   `observability` (Prometheus + Grafana + Langfuse) and `harness` (the `tforge` container) so the
   default `up` stays fast.
4. **Graceful shutdown on `SIGTERM`** — stop accepting connections, let the in-flight pass finish or
   abort cleanly. 12-factor disposability (https://12factor.net/), and it interacts directly with the
   long pipeline pass: a multi-second unit of work with no cancellation path is *why* shutdown is
   hard here. This is what makes ADR-012's async `POST /api/run` structural rather than cosmetic.
5. **One live deployment on a PaaS with a committed config file** (`fly.toml` / `render.yaml`), with
   a managed Postgres attached. `platform-bar` §2.3: *"A live URL is worth more than any amount of
   infrastructure code."* **This is the trigger that makes ADR-008's authentication section binding.**
6. **No Kubernetes, no Helm, no Terraform, no service mesh, no progressive delivery.** Written down
   as a refusal with a threshold (ADR-015), not silently omitted.

Reproducibility, stated honestly: `npm ci` against a committed lockfile plus a digest-pinned base
gives deterministic builds in the sense a reviewer cares about. **Bit-for-bit reproducible builds are
a different and much harder claim. Do not make it.**

### Consequences

- A stranger can run the project in one command, which gates whether anything else is evaluated.
- A live URL means the checkpoint approve/reject routes are reachable by strangers — see ADR-008.
- `slim` + non-root is the defensible default; distroless would be a small extra flourish at the cost
  of losing a shell, which on a project a reviewer may want to `docker exec` into is a real
  trade-off, not a free win. Not adopted.

### Alternatives considered

- **Kubernetes + Helm.** Refused. A Helm chart for a single-container app reads as résumé-driven
  development to exactly the reviewers it is meant to impress. The ADR itself is the deliverable:
  *"single stateless service plus one database; Kubernetes would add a control plane, an ingress and
  a cluster bill to solve a scheduling problem I do not have."*
- **Terraform.** Refused unless the deploy target genuinely has managed resources to provision.
  Terraform that provisions nothing is worse than no Terraform.
- **Distroless base.** Considered, not adopted — see above.
- **No deploy, local only.** Rejected: it forfeits the highest-value single artefact in the platform
  bar and makes the whole reliability story unverifiable.

### What would change my mind

If the project grows a second independently-deployable service — the most likely candidate is
splitting the pipeline worker from the API server, which ADR-012's async run makes conceivable — the
Kubernetes refusal should be re-examined rather than defended out of consistency.

---

## ADR-008 — Security: attribution without authentication; a scoped, published threat model

**Status:** Accepted, with one conditional clause that arms on public deploy.

### Context

No authentication, no authorization. The three research reports disagree, and `GAP-ANALYSIS.md` §4.3
resolves it: `ai-ml-bar` says do not add auth (*"protecting what?"*); `platform-bar` calls it Tier 3
padding unless publicly deployed; `security-qa-bar` §5 argues the product's own claim requires it.

The decisive argument is `security-qa-bar`'s, and it is about the *product*, not the deployment:

> The project's headline claim is *"a **named** human approves an irreversible action."* That
> sentence contains the word **named**. With no identity system, the system cannot name anyone. The
> approval record says an approval happened; it cannot say who approved.

That is the **Repudiation** category of STRIDE
(https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats) and **ASI09
Human-Agent Trust Exploitation** in the OWASP Top 10 for Agentic Applications.

On taxonomy currency: use the **OWASP Top 10 for LLM Applications 2026** (published 4 Aug 2026,
https://github.com/GenAI-Security-Project/GenAI-LLM-Top10), where Excessive Agency is **LLM03** —
promoted from LLM06 in the 2025 edition — and System Prompt Leakage has been replaced by **LLM08
Hidden Context Exposure**. `GAP-ANALYSIS.md` §4.1 records why this edition wins over the one
`ai-ml-bar` cites.

### Decision

**Four layers of attribution. Authentication is conditional on one trigger and nothing else.**

1. **An append-only, hash-chained approval log.** Every approval record carries: approver identifier,
   timestamp, the exact action approved, a hash of the state it was approved against, and the hash of
   the previous record. **This gives non-repudiation of the record's integrity with no authentication
   at all**, and it is genuinely interesting engineering rather than a login form.
2. **Operator identity injected at deploy time** — an env var, or an `X-Operator` header terminated
   at a reverse proxy. **Document in those words that the app is not authenticating anyone; it is
   recording who the deployment says is present, and the trust boundary is the proxy.** The honest
   minimum, stated honestly, is stronger than a bolted-on login.
3. **Per-agent identity in the audit trail** — which of the registered agents took which action.
   Maps directly onto **ASI03 Identity & Privilege Abuse**, and the harness already emits per-turn
   telemetry, so the cost is near zero.
4. **A written authorization matrix**: which agent may invoke which tool, which actions require human
   approval, which are irreversible. This is a document, not code, and it is the artefact **LLM03
   Excessive Agency** asks for.

**Conditional clause, and it is binding:** the moment ADR-007 item 5 lands and
`POST /api/checkpoint/:id/approve` is reachable by strangers, **OIDC via a hosted provider becomes
table stakes** and layer 2's caveat is deleted. `security-qa-bar` §5: *"a public URL with no auth on
an approval endpoint is a finding any security reviewer will raise in the first five minutes, and no
threat model rescues it."* All three reports agree on this trigger.

**Threat model scope — a `SECURITY.md` plus a two-page `docs/threat-model.md`:**

- A **data-flow diagram with explicit trust boundaries**: public internet → scraper; scraped corpus →
  tier-3 prompt; TrueForge harness ↔ this app; the MCP tool surface; browser ↔ API; the human
  approval step. STRIDE is a *taxonomy*, not a methodology — a STRIDE table with no DFD and no trust
  boundaries is not a threat model.
- **STRIDE per boundary**, with model-specific threats added from **MITRE ATLAS** (Thoughtworks Radar
  Vol. 34 ring = **Assess**, https://www.thoughtworks.com/radar/techniques) and the OWASP agentic
  list rather than forced into STRIDE categories where they do not fit.
- **The lethal-trifecta paragraph**, stated architecturally rather than as a filter claim. Simon
  Willison's three ingredients are private data + untrusted content + an exfiltration channel
  (https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/). **Signal Zero's strongest available
  security claim is that the model has no write authority**: tier 3 returns a classification, ranking
  is deterministic statistics, and the escalation drafter has an empty tool list so it *cannot* send.
  Say that precisely and point at the code — it is a stronger argument than any filter.
- **Guardrails claimed as defence-in-depth, never as the boundary.** Never *prevents* injection;
  *detects and blocks specific enumerated classes*, with the known limits already written in
  `src/guardrails/README.md` carried across verbatim. Anyone claiming a comprehensive
  prompt-injection filter has a much larger model in the loop or a marketing department —
  and the adaptive-attack literature (arXiv:2510.09023) bypassed twelve published defences at >90%
  success where the original papers reported near-zero.
- **The supply-chain page.** **[RESEARCH]** `security-qa-bar` §2.2's sharpest point: for this project
  the high-leverage artefact is *not* the SBOM. It is one page saying **what code and what
  *instructions* execute in this system and where each comes from** — a self-hosted third-party
  harness, an MCP server, a remote model provider, and ~14k characters of agent instructions that
  live **outside this repository** in the TrueForge registry. Almost nobody writes that page, and it
  addresses **LLM04** and **ASI04** directly.
- **The secret-hygiene paragraph**, with the measured result: `.env` has never been committed on any
  ref, 82 paths ever added, every `brd_` hit is the `brd_json=1` query parameter, `.env.example` has
  every secret value empty. The gap is *provable* hygiene, so the CI history scan (ADR-006) is what
  makes the claim continuous rather than a one-time assertion.
- **A residual-risk table.** What was accepted and why. This is the section that reads as judgement
  rather than as a checklist.
- **Assumptions and non-goals stated.** *"No authentication; single-operator deployment"* is a
  legitimate entry in a threat model. **It is not legitimate as a silence.**

### Consequences

- The product's headline claim becomes true rather than aspirational.
- Three of the four hardest-to-fake security artefacts (threat model, supply-chain page, hash-chained
  log) are documents or small code, not infrastructure — high signal per hour.
- The hash chain constrains the schema: approval records become genuinely immutable, which reinforces
  ADR-003.
- A conditional clause that arms on deploy is a commitment. It must actually be honoured, or the
  document becomes the overclaim it was written to prevent.

### Alternatives considered

- **Full OIDC now.** Rejected before public deploy: it adds surface, not insight, and reviewers can
  tell security work from security theatre.
- **No identity at all, defended by scope.** Rejected. This is the option `ai-ml-bar` recommends and
  it is right about the login form and wrong about the product — the claim contains the word
  *named*.
- **Claiming the approval step provides accountability as-is.** Explicitly refused. A security
  reviewer finds that in under a minute, and an overclaim found is worse than a gap disclosed.
- **A generated SBOM as the headline supply-chain artefact.** Demoted below the supply-chain page.
  Generate it (it is nearly free in CI), do not build a README section around it.

### What would change my mind

If the deployed instance ends up genuinely read-only — no reachable `POST /api/run`, no reachable
approve/reject — the authentication trigger does not fire and layers 1–4 stand alone. That is a
defensible end state, but it must be *designed*, not discovered.

---

## ADR-009 — Testing: target shape of the suite, and how non-determinism is handled

**Status:** Accepted.

### Context

**[MEASURED]** 195 tests in six files, five of which are `src/guardrails/`. Roughly 51 tests cover
`rank.js`. **There is no unit test file for `ingest.js`, `triage.js` tiers 1–2, `dedup.js`,
`checkpoint.js` or `server.js`** — those are covered only through the eval suite, which needs a child
process and, for two families, a live container.

GitLab publishes its own measured distribution: unit 75.66%, integration 19.79%, white-box system
4.31%, **black-box end-to-end 0.24%** (https://docs.gitlab.com/development/testing_guide/testing_levels/).
Signal Zero's shape is inverted — its heavyweight suite carries the coverage its unit layer should.

`evals/README.md:372` names the largest hole itself: *"No test drives `src/pipeline/ingest.js`
against Bright Data, live or recorded"*, while `docs/brightdata-serp-shape.md` documents
relative-date and redirect-stub traps — and *"a wrong timestamp is a wrong silence score."*

On non-determinism, the foundational fact most people get wrong: **temperature 0 is not
determinism.** LLM inference is nondeterministic at the *system* level because kernel output depends
on batch size, and production batch size fluctuates with load
(https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/). **You cannot make a
hosted API deterministic from the client side.** Separately, single-sample evaluation systematically
misreports capability (arXiv:2407.10457).

### Decision

**Target shape, in order of how much confidence each layer should carry:**

1. **Unit tests — grow from ~51 non-guardrail tests to real coverage of every pipeline stage.** The
   priority order is `ingest.js` (largest hole, and its inputs are hostile by assumption), then
   `checkpoint.js` (`evals/README.md:378` flags `createEscalation` idempotency across re-runs as
   untested), then triage tiers 1–2, then `server.js` route contracts.
2. **Property-based tests via `fast-check` on the statistical core.** Partly present already as
   hand-rolled seeded fuzzing in eval family B; formalise it. The invariants are genuine mathematics,
   not contrived: Fellegi–Sunter probability in `[0,1]` and monotone in per-field agreement; the
   Exponential/Gamma baseline invariant under time rescaling and returning the prior *exactly* on
   zero observed gaps; Gi* permutation invariance and correct behaviour on a null field.
   Property-based testing is near-absent from portfolios and this project has unusually good targets.
3. **Deterministic replay of recorded model responses — the single highest-value technique here.**
   Record real TrueForge turn responses once, commit them as fixtures, replay in CI. It makes the
   *pipeline around the model* fully deterministic and testable while being honest that the model
   itself is not; it removes API cost and network flake from CI entirely; and it is the only
   client-side route to determinism, because the alternative is to stop calling the model, which is
   what replay is. **This is what makes the eval gate in ADR-006 safe to make blocking.**
4. **Statistical assertions over N runs for anything that must exercise the live model.** Run each
   golden case N times, assert on a *rate* with an explicit tolerance, report the distribution. The
   suite currently reports tier-3 numbers from a **single sample** and says so
   (`evals/README.md:394`); this replaces the concession with a measurement.
5. **Adversarial evals as a scored rate over multiple attempts, not a boolean.** Defences that look
   perfect at one attempt degrade badly at ten — Gray Swan figures for one model report 4.7% attack
   success at one attempt, 33.6% at ten, 63% at one hundred (secondary reporting; the trend line is
   the point, not the decimals). Publish the pass rate and the attempts per case.
6. **Mutation testing (Stryker) over the deterministic core only** — `src/guardrails/`, `rank.js`,
   `dedup.js`. Nightly, not on the PR path. Thoughtworks Radar Vol. 34 ring = **Trial**, not Adopt —
   a correction worth being right about. **It directly pre-empts the obvious challenge to "195
   tests"**: a candidate who says *"195 tests, and here is the mutation score showing they actually
   assert things"* has answered the question before it is asked.
7. **Playwright E2E on the critical path only**, with trace-on-failure, plus `@axe-core/playwright`
   failing the build. Keep it near-vestigial per GitLab's 0.24%: the run happens, an escalation is
   approved by name, a blank approver is refused, the fail feed renders. `web/` is currently never
   loaded by any test.
8. **Fuzz the Bright Data response parser.** Narrow and security-motivated: hostile-by-assumption
   input from the open web, which makes it count in both disciplines at once.
9. **Coverage reported, never gated on a number, and reported *per subsystem*.** The deterministic
   statistical core should be held to a far higher bar than the Express glue, and saying so
   demonstrates judgement a single repo-wide percentage cannot. `node:test` supports coverage
   natively — no dependency. Line coverage measures execution, not assertion; mutation score carries
   the argument about test quality.
10. **A written flake policy**, because there is a known flake source: the tier-3 turn timeout that
    fires and falls back. The rule: (a) that path is replay-tested so it cannot flake in CI; (b) the
    live-model eval reports it as a measured rate rather than failing the build; (c) **blanket
    retries are forbidden** — Google's own guidance applies reruns only to tests already identified
    as flaky (https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html).
    `evals/README.md` already models the right instinct by deliberately grading `C1.0b2` *major*
    rather than *critical* because both its outcomes are correct system behaviour, and noting *"a
    flaky critical is worse than a major — it trains people to ignore red."* Promote that instinct to
    a written policy.

### Consequences

- The suite inverts to the right shape: cheap deterministic tests carry the confidence, the expensive
  suite carries the judgement.
- Replay fixtures need a refresh discipline or they rot into a snapshot of a model that no longer
  exists. Refresh them on a schedule and diff the refresh — **a fixture refresh that changes
  behaviour is itself a finding.**
- Mutation testing on `src/guardrails/` will find weak assertions. That is the intended outcome and
  it will be uncomfortable.

### Alternatives considered

- **Byte-exact snapshot tests on model output.** Rejected: flaky by construction, and within a month
  they get `--update`-ed into meaninglessness. Defensible only for *structured, constrained* output —
  a classification label, a JSON-schema instance — never prose.
- **Retry-until-green on model-touching tests.** Rejected outright per (10).
- **Contract testing (Pact).** Refused. See ADR-015.
- **Chasing a coverage number.** Refused. See ADR-015.

### What would change my mind

If replay fixtures prove to drift faster than they can be maintained, drop to a smaller pinned set
covering only the branch structure of `parseTier3` — the parse boundary is what needs deterministic
coverage; the model's prose does not.

---

## ADR-010 — Evals: statistical defensibility, and honest accounting

**Status:** Accepted.

### Context

The eval suite is the strongest asset in this repository (`GAP-ANALYSIS.md` §2.1) and it has two
distinct problems, one arithmetical and one methodological.

**The arithmetical one first, because it is the credibility risk.** **[MEASURED]** the "69 eval
files" figure is `find evals -type f`; `git ls-files evals` returns **19**, because 49 of them live
in gitignored `evals/.scratch/`. **[MEASURED]** `evals/README.md:20` also still reports *"138 checks"*
and a 132/6 scorecard, while `docs/harness-review.md:680` records the post-repair run as **155
passed, 2 failed (1 critical)** — the two documents disagree with each other.

The methodological one: `evals/README.md:391` already concedes *"32 cases is enough to catch a
category of error, not to put a confidence interval on a precision figure. The difference between
0.857 and 0.818 resolution precision is one case. Treat the errors listed as the result, not the
decimals."* **That is exactly the right posture, stated qualitatively.** Miller,
*Adding Error Bars to Evals* (arXiv:2411.00640), is the toolkit that makes it quantitative:
evaluations are experiments; report CLT-based standard errors alongside means; use clustered standard
errors when questions are clustered; analyse **paired differences** between systems rather than
independent comparisons; run power analysis to size the set; resample multiple answers per question.

### Decision

**Six changes. The first is not optional and takes ten minutes.**

1. **Fix the accounting.** Report **"19 tracked eval files, 4 families, 155 checks"** everywhere, and
   regenerate `evals/README.md`'s results block from `evals/report/latest.json` as a build step so the
   two documents cannot diverge again. **[JUDGEMENT]** An inflated file count on a project whose
   entire thesis is that it does not overclaim is a self-inflicted wound, and it is discovered by one
   `git ls-files`.
2. **Standard errors on every rate.** Every precision, recall and error rate reported with a CLT
   standard error. On n=32, that interval will be embarrassingly wide — **publishing it anyway is the
   point.** It converts the existing qualitative caveat into a number and pre-empts the obvious
   challenge.
3. **Paired differences, not independent comparisons.** The deterministic-vs-harness scorecard is
   currently two independent columns. Report the **paired** difference per case with its own standard
   error. This is precisely what makes `A8.1` — *tier 3 makes it worse* — a defensible claim rather
   than a suggestive one, and `A8.1` is the most valuable single fact in this repository.
4. **A held-out split that is never iterated on.** The golden set is currently one pool that
   development has seen. Anthropic's tools-for-agents guidance argues for held-out test sets to avoid
   overfitting (https://www.anthropic.com/engineering/writing-tools-for-agents). Split it, and be
   honest that at n=32 a held-out fraction is small enough that the split's own value is limited —
   which is an argument for growing the set from **observed production failures**, not for skipping
   the split.
5. **Measure beyond accuracy.** Total runtime, tool-call count, token cost, and **omissions**. The
   Anthropic post observes that *"what agents omit… can often be more important than what they
   include"* — **and for a silence-ranking system, omission is literally the domain.** That is not a
   metaphor; it is the same quantity the product ranks by.
6. **Publish a failure taxonomy** derived from the real observed failures already documented — the
   district-story-pinned-to-a-village case, the dateline case, the fresh-settlement ranking case —
   with a named test per category, so the taxonomy is executable rather than prose.

**Explicitly NOT adopted: an LLM-as-judge.** See ADR-015; this is the sharpest refusal in the set.

### Consequences

- `A8.1` becomes a defensible negative result with an interval, which is the single most
  interview-valuable artefact available.
- Wide intervals on n=32 will look weak to a reader who does not understand them and strong to one
  who does. **[JUDGEMENT]** Optimise for the second reader. The first is not the hiring bar.
- The regenerate-from-JSON step couples the README to a CI artifact, which is a small maintenance
  cost for a permanent honesty guarantee.

### Alternatives considered

- **Grow the golden set to n=200 to get tighter intervals.** Attractive and rejected as the *first*
  move: labelling 168 more cases well is weeks, and the set's current value is that every case is
  hard and its label is reasoned. Grow it from *observed failures* instead — that is the direction
  the sources actually recommend.
- **Report raw agreement instead of precision/recall.** Rejected: raw agreement is misleading under
  class imbalance, and the suite already reports precision and recall separately, which is correct.
- **Bootstrap confidence intervals instead of CLT.** Reasonable, and unnecessary complexity at this
  n. Note it in the eval README as the alternative and move on.

### What would change my mind

If paired differencing on n=32 produces intervals so wide that no comparison is significant, the
honest response is to say so loudly — *"this set cannot resolve a difference of this size"* — rather
than to switch metrics until one looks decisive. That sentence would itself be a strong result.

---

## ADR-011 — Ranking: change the primary sort key

**Status:** Accepted. **This is the only ADR that changes what the product computes.**

### Context

`B3.2b` is a **critical, currently-red** eval case that goes to the core product claim. Over 40
randomised placements on the real corridor graph, **26 trials put a settlement heard from six minutes
ago above one silent for 96 h; 5 of those reach the top ten; worst observed rank for a still-reporting
settlement is 4.**

The cause is structural and `rank.js` documents it itself: **Gi\* is the primary sort key, and Gi\*
is a neighbourhood statistic.** A settlement surrounded by a dark stretch of corridor is carried up
the list by its neighbours' silence. `rank.js` already handles the consequence for **escalation** —
`qualifiesForEscalation` requires the settlement's *own* silence ≥ 6 h and surprisal ≥ 3 nats, and
`B3.3` confirms that gate never leaks — **but not for ordering**, which is what the dashboard displays
under the label "ranked by anomalous silence".

`docs/harness-review.md:1148` declined the fix, and the reasoning was sound at the time: it changes
the documented ranking method, it breaks `test/rank.test.js`'s "sorted by Gi* desc" contract, and
*"guessing at it under time pressure on the one piece of math the whole product rests on is exactly
the wrong trade."*

**[JUDGEMENT] That was the right call then and is the wrong call now.** The time pressure is gone.
A project whose one-sentence pitch is "ranks the places that stopped talking", and whose own suite
proves it sometimes ranks a place that is talking, cannot ship that sentence unqualified.

### Decision

**Make the settlement's own silence the primary sort key, and Gi\* the secondary.**

Concretely, a lexicographic ordering: sort first on the settlement's **own** surprisal against its
own fitted cohort baseline (`−ln P(gap ≥ observed) = λ·silenceHours`), then on Gi\* z-score as the
tiebreaker and as the *spatial context* signal it actually is.

This preserves everything Gi\* is genuinely for — distinguishing "this village is quiet" from "this
whole valley is quiet tonight", which is the product's second-best idea — while ensuring the primary
ordering answers the question the label promises. Gi\* stops being the sort key and becomes the
`anomalyType` classifier (`solo-anomaly` / `silent-cluster` / `cluster-edge` / `none`), which is what
it was always doing well.

**Required accompanying work, none of it optional:**

- Update `test/rank.test.js`'s ordering contract, and `README.md`'s description of the ranking method.
- Keep `B3.2`/`B3.2b` as the regression test, **turned green by the fix rather than by relaxation.**
- Keep `B3.2c` — which asserts that such a row never *claims* to be silent — unchanged; the honest
  mitigation must survive the fix that makes it less necessary.
- **Write the before/after up.** The eval that caught it, the mechanism, the change, the eval turning
  green. **[JUDGEMENT] This write-up is worth more than the bug never having existed.** It is a
  documented critical defect in the project's own core statistic, found by the project's own suite,
  root-caused to a property of the statistic rather than to a coding error, and fixed with a
  measurement on both sides. `ai-ml-bar` §6.3's senior column asks for exactly this shape.

**Sequencing: this lands after ADR-003.** A primary sort key based on a settlement's own expected
cadence needs a real inter-arrival history for λ to be a baseline rather than a within-pass artefact.
Shipping it on an in-memory store would make the ordering depend on process uptime.

### Consequences

- The dashboard's top of list changes. That is the intent, and it is why this is a design change with
  its own record and not a patch smuggled into a repair pass.
- Gi\* becomes less prominent, which is a real loss of "look what statistic I implemented" surface
  and a real gain in correctness. **[JUDGEMENT]** Correctness wins, and being able to say why is the
  better signal anyway.
- Cohort cold starts need an explicit ordering rule — a settlement with no baseline has no surprisal,
  and it must not sort to the top *or* silently to the bottom. Give it its own band with its own
  label, consistent with hard rule 4.

### Alternatives considered

- **Leave it, and document the caveat.** Rejected. The caveat is already documented and the case is
  still critical-red; documenting a defect in the headline claim is a holding position, not a
  resolution.
- **Filter fresh settlements out of the ranking entirely.** Rejected: it destroys the corridor
  context that `cluster-edge` exists to show, and a settlement heard from recently but surrounded by
  silence is genuinely informative — it just is not *the most anomalously silent place*.
- **A weighted composite score of own-surprisal and Gi\*.** Rejected. A weighted sum needs a weight,
  the weight would be unjustified, and it would make the ordering unexplainable in one sentence.
  Lexicographic ordering is explainable, and explainability is a hard requirement in a product that
  refuses to output a dispatch instruction.

### What would change my mind

If, after the change, `B3.2`'s randomised trials show the *reverse* pathology — a settlement with a
high own-surprisal but no corridor context dominating a genuinely dark stretch — then the ordering
needs a third term and this ADR needs a successor, not a defence.

---

## ADR-012 — API contract: OpenAPI 3.1, RFC 9457, idempotency keys, asynchronous run

**Status:** Accepted.

### Context

Six JSON routes in `src/server.js`, no schema document, a global error handler at `:698` returning
`{ok:false, error}`, and a single-flight guard at `:124` already returning a busy result. Correct
status-code handling is already there — 400 on a blank approver, 409 on a concurrent run, 404 on
unknown API routes, 500 through the handler.

### Decision

1. **`openapi.yaml`, 3.1+, validated in CI.** OpenAPI 3.2.0 is current (released 19 Sep 2025,
   https://spec.openapis.org/oas/latest.html); 3.1+ embeds JSON Schema. Roughly an hour of work; it
   makes the API reviewable without reading `src/server.js`, and validating it in CI converts
   documentation into a test. Do not emit 3.0 in 2026.
2. **RFC 9457 Problem Details** (`application/problem+json`, members `type`/`status`/`title`/
   `detail`/`instance`, https://www.rfc-editor.org/rfc/rfc9457.html) for every error response. The
   global handler already exists, so this is contained. **Citing 9457 by number also signals you know
   it obsoletes 7807**, which is a small real discriminator.
3. **Idempotency keys on `POST /api/run` and both checkpoint decision routes.** Stripe's semantics
   (https://docs.stripe.com/api/idempotent_requests): store the status and body of the first request
   for a key regardless of outcome, compare incoming parameters against the original and error on
   mismatch, prune after ≥24 h. **Describe it as an industry convention led by Stripe, not as a
   standard — the IETF `Idempotency-Key` draft is expired and archived
   (https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/), and "RFC-compliant"
   would be wrong.** A double-clicked approve on a human-in-the-loop safety control is a correctness
   bug in a system whose premise is auditable human judgement.
4. **`POST /api/run` returns 202 with a run id; the pass proceeds asynchronously; progress is read
   from `/api/state`.** A multi-second-to-multi-minute unit of work does not belong inside an HTTP
   request. This is also what makes graceful shutdown (ADR-007) tractable, and it makes the run id a
   natural trace correlation id (ADR-004).
5. **`/api/v1/...` path versioning.** Costs nothing now, expensive to retrofit. Header or date-based
   versioning is more sophisticated and unnecessary here — **choosing the simple option deliberately
   and saying why is the better signal.**
6. **Cursor pagination on the incident feed**, required the moment ADR-003 removes the 200-item ring
   buffer. Cursor beats offset on an append-only table, which falls out of the schema correctly.
7. **Retries with full jitter, capped, at exactly one layer.** `sleep = random(0, min(cap, base·2^n))`
   — AWS's simulation found unjittered backoff the clear loser and Full Jitter roughly halving call
   counts (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/). And per the SRE
   Book's retry-amplification warning, if `trueforge.js` retries *and* the pipeline stage retries,
   the amplification is built on purpose.
8. **A circuit breaker around the harness call**: after N consecutive tier-3 timeouts, stop calling
   for a cooldown and use the fallback directly. This fixes an *observed* failure, not a hypothetical
   one, and it is the SRE Book's "reduce the amount of work performed" degradation.

### Consequences

- The async run changes the frontend's run interaction; `web/app.js` must poll or subscribe.
- Idempotency needs a small keyed store, which ADR-003 provides.
- Problem Details changes every error response shape — the eval suite asserts on some of them and
  must be updated in the same change.

### Alternatives considered

- **Generate OpenAPI from route definitions instead of authoring it.** Either is fine. What matters
  is that it exists and is checked, not which direction it was produced in.
- **Server-Sent Events for run progress instead of polling `/api/state`.** Attractive, and deferred:
  polling an already-existing endpoint is smaller, and the frontend already fetches state.
- **HATEOAS / Richardson Level 3.** Refused. See ADR-015.
- **Runtime request validation with zod.** Deferred. `express.json` plus the existing hand-written
  guards cover the current surface; revisit if the API grows.

### What would change my mind

If the async run makes the demo materially worse to watch — a reviewer clicking "run" and seeing
nothing — then the run stays async and the *frontend* gains a progress view. The architecture is not
the thing to compromise.

---

## ADR-013 — Agent topology, per-tool risk classification, and the skills decision

**Status:** Accepted.

### Context

Five agents are registered on TrueForge; historically exactly one was reachable from `src/`, which
`docs/harness-review.md` S2-3 called *"inventory"* and *"the specific kind of padding this prize is
designed to detect."* **[MEASURED]** the uncommitted working tree fixes this: `src/harness/escalation-drafter.js`
puts `signal-zero-escalation-drafter` on the checkpoint path, and `scripts/audit-diff.mjs` puts
`signal-zero-auditor` on a diff-gate path with a deterministic grep as stage 1 that gates on its own
if TrueForge is down.

Three skills are registered and mount into a sandbox that cannot bootstrap in this container — the
sandbox creates, fails `pip install pydantic` with no route to PyPI, and **retries in a loop, so a
skill-attached turn hangs rather than degrades.** Measured A/B: with the skill body in context the
model goes from 2/5 to 5/5 on cases drawn from the product's spine, and eliminates the
wrong-resolution errors that the eval's harm weighting penalises 3×. **The most valuable asset in the
repository is switched off.**

Five Bright Data MCP tools are discovered and **none is risk-rated.**

### Decision

1. **Two production LLM touchpoints, and no more: triage tier 3 and the escalation drafter.**
   Both are already load-bearing; both are already forbidden from dedup scoring and ranking math by
   hard rule 3. `signal-zero-auditor` runs as a CI gate (ADR-006), which is a real call path and not
   a product path. The coordinator and the ingest agent are **operator-run, and labelled as such** —
   the README already does this correctly and must keep doing it. **Adding a sixth agent is refused**
   (ADR-015): breadth is not the axis being measured.
2. **Per-tool risk classification, written down.** Rate each of the five Bright Data tools
   low/medium/high on OpenAI's stated axes — read-only vs write access, reversibility, required
   account permissions, financial impact
   (https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) —
   and gate the high-risk tier behind human approval. Cite **LLM03:2026 Excessive Agency**'s
   "require user approval" mitigation and the MCP specification's RFC-2119 language: *"there SHOULD
   always be a human in the loop with the ability to deny tool invocations"*
   (https://modelcontextprotocol.io/specification/2025-11-25/server/tools). **[JUDGEMENT]** This
   converts a verified demo feature into an argued security control, which is the entire difference
   between the two columns of `ai-ml-bar` §6.3's table — and it costs a table in a document.
3. **Keep reporting the approval gate honestly.** `approvalGate: {armed:false}` on the pipeline path
   is the truth, and `src/harness/trueforge.js` already refuses to report a gate the bound agent
   cannot have. **Preserve that refusal through every change in this plan.** It is the single most
   load-bearing line of restraint in the codebase.
4. **Skills: fix the sandbox route or delete them. Do not leave them registered.** Two acceptable end
   states, in order of preference:
   - **(a)** Give the sandbox a route to PyPI — the offline-wheels approach in
     `docs/trueforge-verified.md` already got `sandbox.created` to fire; the remaining blocker is the
     skill's `git ls-remote` inside the sandbox. A local bare mirror plus `insteadOf` works on the
     host and does not take effect inside. Solving this makes the measured 2/5 → 5/5 improvement
     real, and adds an eval case asserting `manifest.skills` is non-empty.
   - **(b)** If (a) cannot be done, **delete the registrations** and keep the SKILL.md files in the
     repository as authored artefacts with the measured A/B published. **[JUDGEMENT]** The current
     third state — registered, unattached, labelled — is honest but is the worst of the three: it
     reads to a casual reviewer as an exercised capability, and the honesty that saves it lives three
     documents deep. **Never grant the sandbox back the capabilities it deliberately dropped** to
     force this; that trade is not available.
5. **Publish the "skill metadata without its body increases confident fabrication" finding.** The
   metadata-only arm scored identically to control and on one case was *worse*, fabricating a claim
   about which settlement is most downstream. That is a genuine harness finding about progressive
   disclosure and it is worth raising deliberately.
6. **File the two upstream findings upstream** — the Windows ESM crash in kysely's
   `FileMigrationProvider` and the silently-dropped `compaction.trigger`. Both are already root-caused
   with reproductions. `ai-ml-bar` §6.3's senior column asks for *"A root-caused upstream bug, filed,
   with a reproduction"* — the filing is the missing half, and it is an hour.

### Consequences

- Two agents with real jobs is a *stronger* claim than five in a registry, and it is now true.
- The tool risk matrix is a document, which is the cheapest differentiator in the security bar.
- End state (b) for skills loses a capability row on the scorecard and gains an honest one. The
  measured A/B survives either way and is the interesting part.

### Alternatives considered

- **Wire the coordinator agent into the pipeline to make the multi-agent story real.** Refused. It
  would put an LLM on the orchestration path in a product whose credibility rests on hard rule 3, to
  win a claim nobody asked for.
- **Add more MCP servers.** Refused. Five tools already exceed what most portfolio projects show.
- **Keep skills registered-and-labelled indefinitely.** Rejected per (4).

### What would change my mind

If a Daytona key or a PyPI-reachable container becomes available, (4a) is unambiguously correct and
should be done immediately — the measured improvement is the largest single quality gain identified
anywhere in this repository.

---

## ADR-014 — Probe allocation: bandit selection plus offline policy evaluation — deferred, with an explicit trigger

**Status:** Deferred. Trigger stated. **Not started until ADR-003, 004, 006 are green.**

### Context

`ai-ml-bar` §4.3 identifies the one honest way a project without a training run can demonstrate
decision-theoretic depth, and surrounds it with the strongest warning in all four reports:
*"the temptation to overreach here is the single largest credibility risk in this whole document."*
What is dishonest and worse than omitting: claiming a training run, implementing DPO/GRPO on a toy
dataset, calling a prompt-tuning loop "RLHF", presenting an LLM-scored preference dataset as a reward
model.

What is honest: Signal Zero's core operational question — *which settlement should we spend our next
expensive Bright Data probe on?* — is literally a budgeted exploration/exploitation problem, and the
Gamma-prior Exponential model already in `rank.js` is a posterior that Thompson sampling can draw
from. And there is a foundational, citable offline-evaluation method: Li, Chu, Langford & Wang,
*Unbiased Offline Evaluation of Contextual-bandit-based News Article Recommendation Algorithms*
(arXiv:1003.5956, WSDM 2011) — the replay estimator gives a **provably unbiased** offline estimate of
a new policy's value from logged data, provided some fraction of the logged choices were randomised.

### Decision

**Build it, but not yet, and only in the labelled form.**

**Trigger:** ADR-003 (there must be a persisted decision log), ADR-004 (decisions must be traced) and
ADR-006 (it must run in CI) are green. Without persistence there is no logged data, so replay OPE is
not merely hard — it is impossible.

**Scope, if and when built:**

1. Thompson sampling or UCB over settlements for probe allocation, with an **explicit exploration
   budget** and a randomised fraction of choices logged with their propensities. **The randomisation
   is not optional — the replay estimator's unbiasedness depends on it.**
2. A replay offline policy evaluation of an alternative allocation policy against the logged data,
   citing Li et al. by arXiv number.
3. A README paragraph in these words: *no model was trained for this project; the RL-adjacent work
   here is offline policy evaluation of a probe-allocation policy, cited to its source; post-training
   experience is not claimed.*

**Claim it as "bandit-based probe allocation with an explicit exploration budget", never as
"reinforcement learning".**

### Consequences

- Done correctly, it is genuinely rare in a portfolio and it is real decision-theory work defensible
  in an interview with a research engineer.
- **Done sloppily it is worse than omitting**, and it retroactively taints every honest claim in the
  project — which is why the trigger exists and why this is the last item in the build plan.
- It changes ingest behaviour: probes become allocated rather than uniform, which touches the one
  stage with no unit tests (ADR-009 item 1 must land first for that reason too).

### Alternatives considered

- **Do it now, ahead of the infrastructure.** Rejected: without a persisted, propensity-logged
  decision record, the OPE would be a simulation described as an evaluation. That is precisely the
  overreach the source warns against.
- **A preference-elicitation protocol instead** (pairwise comparisons over ranked silence lists,
  randomised presentation order to control position bias, inter-annotator agreement against a
  principal expert). Also honest, also recommended by `ai-ml-bar` §4.3, and **cheaper** — but n=2
  annotators on a solo project produces a protocol document with a token measurement. Keep it as the
  fallback if the OPE trigger never fires.
- **Skip RL-adjacent work entirely.** Entirely defensible, and the correct outcome if the trigger
  does not fire. The README sentence in (3) is worth writing *even if nothing is built*, because
  stating what was deliberately not done is itself the signal.

### What would change my mind

If the deployed instance never accumulates enough logged probe decisions for the replay estimator to
have meaningful support, this should be abandoned and the omission stated, rather than run on
synthetic data and reported as an evaluation.

---

## ADR-015 — The refusal register: what we will not build, and why

**Status:** Accepted. **This section matters as much as the rest.**

### Context

Anthropic's Performance Engineer posting asks candidates to *"Ruthlessly stack-rank a large surface
area of opportunities by impact and effort, and **say no** to the ones that don't make the cut"*
(https://job-boards.greenhouse.io/anthropic/jobs/5224564008). `ai-ml-bar` §6.3 puts *"Explicit 'we
did NOT do X, because Y' statements"* in the senior column against *"Every buzzword present"* in the
capstone column. `platform-bar` §2.2 argues the ADR refusing Kubernetes is worth more to a reviewer
than a copied Helm chart would be.

**[JUDGEMENT]** Each refusal below carries a **threshold** — the condition under which it becomes
correct. A refusal without a threshold is an opinion; a refusal with one is a design boundary.

### Decision — refused, with thresholds

| Refused | Why here | Becomes correct when |
|---|---|---|
| **Kubernetes / Helm / service mesh** | One stateless service plus one database. Docker 71.1% vs K8s 28.5% adoption. A control plane to solve a scheduling problem that does not exist. | Multiple services with independent scaling, or a team operating them. |
| **Argo Rollouts / canary / progressive delivery** | Canary analysis splits traffic across replicas of a service that *has* traffic. One instance, no production traffic. | Real traffic across replicas with a metric to gate promotion. |
| **Kafka / Flink / a streaming stack** | A queue with one producer and one consumer. | Ingest a single process genuinely cannot keep up with. |
| **PostGIS** | Adjacency is precomputed in `src/data/corridor.json`. Storing two float columns and a static edge list is a dependency with no query behind it. | Adjacency becomes *derived* — "which settlements lie within N km of the flood polygon", `ST_DWithin` with a GiST index. Then it is correct immediately. |
| **TimescaleDB** | Hypertables solve a problem that begins at chunk-crossing ingest scale. Plain Postgres with `(settlement_id, observed_at DESC)` answers every query this product asks, for years. | Ingest rate or retention makes partitioning the bottleneck. |
| **The term "event sourcing"** | Append-only ≠ event-sourced. Fowler's own cost/benefit says do not, absent a return. ADR-003's table is an immutable *fact* table; event sourcing would mean every state transition becomes an event and all state is a fold over the log. **Using the term would collapse under one interview follow-up.** | A genuine need to replay *all* state transitions. |
| **SLSA Build L3 claims** | Requires build-platform properties not under our control. Claim **L2**, which GitHub attestations give by construction. | Never, on a GitHub-hosted portfolio project. |
| **A full TypeScript port** | High cost, low marginal signal over `checkJs`; churns the two subsystems that already clear the bar. | A team, or a published package with external consumers. |
| **A React rewrite of Signal Zero** | Discards the measured no-build argument; gains nothing ADR-002's second artefact does not gain in a weekend. | Never. |
| **Fine-tuning / DPO / GRPO / anything called "RLHF"** | Zero application-role postings in a ~2,700-posting sample require it; GRPO and PPO appear in **zero**; Sierra's 52 engineering postings mention none of these terms once. A toy training run invites scrutiny it cannot survive. | Never on this project. **Say in the README that it was omitted deliberately** — the sentence earns more respect than the implementation would. |
| **More agents or MCP servers** | Two agents with real jobs beats five in a registry, and that is now true. Breadth is not the axis; scope, ambiguity and autonomy are. | Never for its own sake. |
| **An LLM-as-judge in the eval suite** | **The sharpest refusal here.** The eval-quality literature is largely advice for teams whose graders *are* LLMs. This suite's graders are hand-labelled gold + deterministic property assertions + wire-level fault injection — **stronger than an LLM judge, not weaker**. Adding one to tick a box replaces a deterministic grader with a biased one (position, verbosity and self-enhancement bias are documented in arXiv:2306.05685). Adopt Miller's error bars, which apply; refuse the judge, which does not. | A subjective output dimension with no code-checkable ground truth appears. None exists here. |
| **Contract testing (Pact)** | Single deployable, no independent consumers. | Independently released services. |
| **`CONTRIBUTING.md` / `CHANGELOG.md`** | Ceremony for a solo repository with no contributors. `LICENSE` and `SECURITY.md` carry information; these do not. (`platform-bar` disagrees; `GAP-ANALYSIS.md` §4.5 records the disagreement.) | Contributors, or a released package. |
| **Multi-region / HA / DR** | No users, no availability requirement, no data that is not reproducible. | A real SLA with real consequences. |
| **HATEOAS / Richardson Level 3** | Six routes, one consumer — this project's own frontend. Level 2 (proper resources, verbs, status codes) is the practical bar and is already met. | A public API with independent third-party clients. |
| **Terraform provisioning nothing** | Worse than no Terraform. | An actual managed database, bucket or DNS record to provision. |
| **A vector-store security section** | There is no vector store and no RAG retrieval. LLM09 does not apply and claiming it would be padding. | A vector store. |
| **WCAG 3.0 targeting** | A Working Draft that says *"It is inappropriate to cite this document as other than a work in progress"*. WCAG 2.1 AA is the regulatory floor; 2.2 AA is what the best employers name. | Recommendation status. |
| **Chasing a coverage percentage** | Line coverage measures execution, not assertion — a test that executes a function and asserts nothing scores identically to one that asserts everything. | Never. Report it as a gap-finder; mutation score carries the quality argument. |
| **Load testing at scale** | Meaningless against an in-memory store, and the infrastructure family will not be fooled by k6 numbers on a demo dataset. Fixing the latency question with traces is worth ten times more. | After ADR-003 and ADR-004 — and then only a modest run with honest p50/p95/p99. |
| **Burn-rate paging** | No on-call rotation. An alert nobody receives is theatre. | Someone is actually paged. |

### Consequences

- Several of these will be asked about in an interview. Each answer is one sentence with a threshold,
  which is a better position than having built the thing.
- Some reviewers genuinely want Kubernetes. **[JUDGEMENT]** The reasoning will land better with them
  than a copied Helm chart would, and the ones it does not land with are screening for a job family
  this project is not applying to.

### What would change my mind

Any individual threshold being crossed. The register is a set of conditional refusals, not a
manifesto — and it should be revised in place, with the date, when one is crossed.

---

## Cross-cutting dependency summary

The build order is derived in `docs/BUILD-PLAN.md`; the hard dependencies among these ADRs are:

- **ADR-003 → ADR-005** (freshness SLI needs a persisted observation history)
- **ADR-003 → ADR-011** (own-cadence sort key needs a real baseline, not a within-pass artefact)
- **ADR-003 → ADR-012** items 3 and 6 (idempotency store; unbounded incident feed → pagination)
- **ADR-003 → ADR-014** (replay OPE needs a logged decision record with propensities)
- **ADR-004 → ADR-005** (SLIs need instrumentation to be measured)
- **ADR-006 → everything** (nothing is credible until a machine runs it)
- **ADR-009 item 3 → ADR-006's eval gate** (replay is what makes a blocking model-touching gate safe)
- **ADR-007 item 5 → ADR-008's authentication clause** (the public deploy is the trigger)
- **ADR-001 → ADR-002** (types are what let the no-build position survive the React requirement)
