# Signal Zero — Build Plan

**Date:** 30 August 2026.
**Executes:** `docs/ARCHITECTURE-DECISIONS.md`. **Justified by:** `docs/GAP-ANALYSIS.md`.

---

## How this plan is ordered, and how to read it

**Ordering principle.** Highest value ÷ risk first, subject to hard dependencies. Where two items
have similar value, the one that *unblocks* more work goes first. Where two items have similar
value and no dependency, the one that cannot fail goes first — early momentum on a plan this size is
worth more than optimality.

**Classification.**

| Class | Meaning |
|---|---|
| **table-stakes** | Absence is read as a negative. Building it wins nothing; not building it loses everything downstream of it. |
| **differentiator** | Few portfolio projects have this. Where the project actually wins. |
| **optional** | Real value, genuinely droppable. Cut these first when time runs out. |

**Effort.** Focused engineering hours, my own estimate — **[JUDGEMENT]**, not sourced. Assume a
competent engineer already familiar with this codebase. Ranges are honest: the low end assumes
nothing surprises you, the high end assumes one thing does. Where I expect the high end, the risk
column says so.

**Risk.** The *specific* thing most likely to go wrong on that item, not a generic caution.

**What is deliberately absent.** Twenty-two items are refused in ADR-015 with the threshold at which
each becomes correct. Do not add them back into this plan; refusing them *is* part of the work.

---

## The critical path in one line

**Truth repairs → CI → persistence → observability → the ranking fix and the eval statistics →
security artefacts → public deploy.**

Every later phase depends on an earlier one for a concrete reason:

```
Phase 0 (truth)      ── no dependency; do it today
   ↓
Phase 1 (CI)         ── nothing below is credible until a machine runs it
   ↓
Phase 2 (memory)     ── freshness, the baseline, idempotency and pagination all need a store
   ↓
Phase 3 (sight)      ── SLIs need instrumentation; the latency story needs per-stage timing
   ↓
Phase 4 (correctness)── the sort-key fix needs a real baseline (Phase 2) and a green gate (Phase 1)
   ↓
Phase 5 (security)   ── the attribution log needs the store; the deploy trigger needs the auth answer
   ↓
Phase 6 (reachable)  ── public deploy arms ADR-008's authentication clause
```

---

## Phase 0 — Truth repairs

**Why first:** zero risk, zero dependencies, and every item removes an overclaim from a project whose
entire pitch is that it does not overclaim. **[JUDGEMENT]** A reviewer who finds one inflated number
discounts every honest one, and three of these are discoverable in under a minute.

**Claim this phase unlocks:** *nothing in this repository asserts something the repository
contradicts.*

| # | Item | ADR | Class | Effort | Specific risk |
|---|---|---|---|---|---|
| 0.1 | Add `LICENSE` (MIT). `README.md:326-328` already claims MIT and no file exists. | — | table-stakes | **5 min** | None. There is no defence for its absence. |
| 0.2 | Correct "69 eval files" → **19 tracked files, 4 families, 155 checks** everywhere it appears, including any resume or README draft. | 010 | table-stakes | **20 min** | Missing an instance. Grep for `69` across all markdown before declaring it done. |
| 0.3 | Reconcile `evals/README.md`'s stale results block (138 checks, 132/6) with `docs/harness-review.md`'s post-repair 155/2. Regenerate it from `evals/report/latest.json`. | 010 | table-stakes | **1–2 h** | The regeneration script silently producing a stale block. Assert in CI that the README block matches the latest report. |
| 0.4 | Reconcile `package.json` `engines: ">=20"` with the Node-24 APIs actually used, or stop using them. | 006 | table-stakes | **10 min** | None. Five-minute fix a careful reviewer would otherwise find. |
| 0.5 | Publish the **measured payload table** in the README — 361 KB gz, 78% MapLibre, 82 KB author-written — with the one-sentence conclusion that the build step would not have been the thing that made this fast. | 002 | **differentiator** | **30 min** | Overstating it. State it as a measurement with its method, not as a manifesto. |
| 0.6 | Promote **`A8.1`** — *harm-weighted error rate 0.281 without tier 3, 0.375 with it* — from line 315 of `evals/README.md` into the top of the main README. | 010 | **differentiator** | **30 min** | None. This is the most interview-valuable fact in the repository and it is currently invisible. |

**Phase total: 3–4 hours.** **[JUDGEMENT]** The highest value-per-hour in this entire document, by a
wide margin, and the only phase with no way to fail.

---

## Phase 1 — The gate

**Why second:** all four research reports independently rank CI their number-one item —
`ai-ml-bar` Tier 0 #1 (*"Highest signal-per-hour item in this list, by a wide margin"*),
`platform-bar` Tier 1 #6, `frontend-bar` Tier 0 #1 (*"Highest leverage item in the project"*),
`security-qa-bar` table-stakes #1 (*"the single largest credibility gap in the repo"*). Four
independent researchers converging is the strongest signal this exercise produced.

**Claim this phase unlocks:** *a stranger can verify every other claim in this repository without
running anything.*

| # | Item | ADR | Class | Effort | Specific risk |
|---|---|---|---|---|---|
| 1.1 | `.dockerignore` **before any Dockerfile exists** — `node_modules`, `.git`, `.env`, `evals/.scratch`, `evals/report`. | 007 | table-stakes | **10 min** | Doing this *after* the Dockerfile. `.env` is in the working tree with live credentials; the first naive build ships them into an image layer. Order matters here and nowhere else in Phase 1. |
| 1.2 | Biome config (lint + format), one dependency, one config file. Fix what it finds. | 006 | table-stakes | **3–5 h** | A large mechanical diff over 10 kLOC obscuring real changes. Land formatting as one isolated commit before any rule fixes. |
| 1.3 | `ci.yml`: `npm ci`, `npm test` on Node **20 × 24**, lint, coverage via `node --experimental-test-coverage` (reported, not gated), least-privilege `permissions:`, SHA-pinned actions, Dependabot. | 006 | table-stakes | **4–6 h** | The 20 × 24 matrix immediately going red on a Node-24-only API. That is the matrix doing its job — fix the code or raise the floor (item 0.4), do not delete the matrix. |
| 1.4 | Add the **eval gate**: `npm run eval -- --offline` on every PR, skip count printed, `evals/report/latest.json` published as an artifact, family scorecards posted as a PR comment. | 006 | **differentiator** | **3–4 h** | Getting the flags wrong. `--offline --strict` **can never pass** — `--offline` makes live cases SKIP and `--strict` makes a SKIP a failure. Use `--offline` on PRs; `--strict` belongs in the nightly job. |
| 1.5 | Name the `B3.2` / `B3.2b` allowlist **explicitly and datedly** in the gate, printed in full on every run, with a pointer to ADR-011. | 006, 011 | table-stakes | **30 min** | Letting it become permanent. Put the ADR reference and the date in the printed line so it accuses itself every run. |
| 1.6 | `tsconfig.json` with `allowJs` + `checkJs` + `strict`; `tsc --noEmit` as a blocking gate. Roll out `src/guardrails/` → `rank.js`+`dedup.js` → rest of pipeline → harness → server → web, each green before the next. | 001 | table-stakes | **10–16 h** | A big-bang attempt producing hundreds of errors and being abandoned, leaving a red gate — worse than no gate. The per-directory `include` scoping is what makes this tractable; do not skip it. |
| 1.7 | Secret scan over **full history** (`gitleaks --no-git=false`) + a committed pre-commit hook. | 008 | table-stakes | **1–2 h** | A false positive on the `brd_json=1` query parameter in `src/pipeline/ingest.js`. Allowlist that specific pattern with a comment; do not lower the ruleset. |
| 1.8 | CodeQL (free for public repos, feeds the Security tab). | 006 | optional | **30 min** | Noise from a JS codebase with no framework. Triage once, dismiss with reasons, move on. |
| 1.9 | Nightly workflow: full eval with `--strict` and the `tforge` container. | 006 | **differentiator** | **2–3 h** | Bringing up TrueForge in Actions. If the container will not run in CI, keep the nightly local and say so — a nightly that lies about running is worse than none. |

**Phase total: 24–37 hours.** Item 1.6 is the long pole and the one most likely to overrun.

---

## Phase 2 — Memory

**Why third:** `GAP-ANALYSIS.md` §3.2 rates persistence **F** — not because it is missing but because
the product measures elapsed time since last observation and an in-memory store cannot measure it
across a restart. It is also the single most-depended-on item in this plan: four later items are
blocked on it.

**Claim this phase unlocks:** *the silence clock survives a restart, the cohort baseline is a
baseline rather than a within-pass artefact, and `git clone && docker compose up` produces a working
dashboard.*

| # | Item | ADR | Class | Effort | Specific risk |
|---|---|---|---|---|---|
| 2.1 | Numbered plain-SQL migrations + a ~40-line runner applied at boot behind an advisory lock. | 003 | table-stakes | **3–4 h** | Concurrent boots racing the migration. The advisory lock is not optional once compose runs more than one thing. |
| 2.2 | Postgres schema: append-only `observations` with `(settlement_id, observed_at DESC)`; derived `reports`/`clusters`/`ranked_snapshots` keyed by `run_id`; `checkpoint_items` + append-only `approvals`; append-only `incidents`. | 003 | table-stakes | **8–12 h** | Coalescing a `NULL` `last_observed_at` to a timestamp somewhere in the read path. That silently converts "no data reached us" into "confirmed silent" — hard rule 4, and the exact failure the product exists to prevent. Add a test that asserts NULL survives to the API. |
| 2.3 | Replace `src/store.js`'s arrays with repository functions. Delete the 200-item incident ring buffer. | 003 | table-stakes | **6–10 h** | Every eval family reads `store` directly. Expect the eval suite to go red across the board on the first attempt and budget for it — this is the item most likely to overrun the estimate. |
| 2.4 | Cursor pagination on the incident feed — **required the moment 2.3 removes the ring buffer**, not optional. | 012 | table-stakes | **2–3 h** | Shipping 2.3 without it and unbounding `/api/state`. Do them in the same PR. |
| 2.5 | `Dockerfile`: multi-stage, digest-pinned base, `USER node`, `HEALTHCHECK` on the existing `GET /api/health`. | 007 | table-stakes | **2–3 h** | Forgetting item 1.1. Verify with `docker history` that no `.env` layer exists. |
| 2.6 | `docker-compose.yml`: app + Postgres, one command, with optional `observability` and `harness` profiles. | 007 | table-stakes | **2–3 h** | Default `up` becoming slow because everything is in the default profile. If `docker compose up` is not fast and does not work, nothing else in the repo gets evaluated. |
| 2.7 | Container **boot-and-healthcheck** job in CI — verify the image answers, not just that it built. | 006 | **differentiator** | **1–2 h** | None significant. |
| 2.8 | Async `POST /api/run` → 202 + run id; progress read from `/api/state`. | 012 | **differentiator** | **4–6 h** | Making the demo worse to watch. Ship the frontend progress view in the same change, not after. |
| 2.9 | Graceful shutdown on `SIGTERM`: stop accepting, drain or cleanly abort the in-flight pass. | 007 | table-stakes | **2–3 h** | Only tractable *because* of 2.8. Do not attempt before it. |
| 2.10 | Idempotency keys on `POST /api/run` and both checkpoint decision routes, Stripe semantics. | 012 | **differentiator** | **3–4 h** | Describing it as "RFC-compliant". The IETF draft is **expired and archived** — it is an industry convention led by Stripe, and knowing that is part of the signal. |
| 2.11 | RFC 9457 problem details through the existing global handler at `src/server.js:698`. | 012 | **differentiator** | **2–3 h** | Eval family C and D assert on current error shapes. Update the assertions in the same PR. |
| 2.12 | `openapi.yaml` 3.1+, validated in CI. | 012 | **differentiator** | **2–3 h** | Drifting from the implementation. The CI validation is what makes it a test rather than documentation. |

**Phase total: 37–56 hours.** Item 2.3 is the long pole and the most likely single overrun in the
plan.

**Note on the deploy.** ADR-007 item 5 (a public URL) is deliberately *not* here. A public deploy
arms ADR-008's authentication clause, so it waits for Phase 5. Phase 2 delivers the **local**
one-command run, which `platform-bar` §2.3 identifies as the higher-value half anyway: *"If
`git clone && docker compose up` does not produce a working dashboard, nothing else in the repo gets
evaluated."*

---

## Phase 3 — Sight

**Why fourth:** with a store and a gate, instrumentation becomes the thing that converts existing
work from asserted to measured. It also finally answers the latency question, which is currently a
root-cause narrative with no before/after (`GAP-ANALYSIS.md` Correction 6).

**Claim this phase unlocks:** *the freshness SLI of this pipeline and the output of this product are
the same number computed at two layers — and here is the dashboard.*

| # | Item | ADR | Class | Effort | Specific risk |
|---|---|---|---|---|---|
| 3.1 | Structured JSON logging wrapper carrying `run_id`, `trace_id`, `span_id`. **Twenty lines, no winston** — there is no winston today and adding one is a dependency for nothing. | 004 | table-stakes | **2–3 h** | None. |
| 3.2 | OTel traces: `@opentelemetry/sdk-node`, auto-instrumentation for `http`/`express`, one root span per run, child spans per stage, per turn, per guardrail call. Stable HTTP semconv verbatim; a documented `signalzero.*` namespace for pipeline-internal attributes. | 004 | **differentiator** | **6–10 h** | Per-rule spans on the guardrail path — it runs per report and will drown the trace. One span per `guardInput`/`guardOutput` call, counters below that. |
| 3.3 | Span attributes that surface existing work: tool-call outcome, guardrail **rule id**, executor, per-turn tokens and cache reads. | 004 | **differentiator** | **3–4 h** | None. This is the cheapest half of Phase 3 and the most visible. |
| 3.4 | `gen_ai.*` attributes **plus the sentence** stating these conventions are Development status, in a dedicated repository with no tagged release, and may change. | 004 | **differentiator** | **1 h** | Writing "OpenTelemetry-compliant" instead. The precision *is* the differentiator; the attributes are commodity. |
| 3.5 | OTel metrics → Prometheus exporter: RED on the six routes (histograms, not means), RED-analogous per pipeline stage, event-loop lag, heap. | 004 | **differentiator** | **4–6 h** | Exporting means instead of histograms. p50/p95/p99 or it answers nothing. |
| 3.6 | Domain counters: guardrail blocks by rule, incidents by kind, **tier-3 fallback rate**, harness turns, cache-read ratio. | 004 | **differentiator** | **2–3 h** | None. The fallback rate in particular is currently invisible and is the metric that makes the existing graceful degradation legible. |
| 3.7 | Compose `observability` profile: Prometheus + Grafana + self-hosted Langfuse, with a **committed dashboard JSON and a screenshot in the README**. | 004 | **differentiator** | **4–6 h** | Shipping metrics with no dashboard. A committed, screenshotted dashboard is worth more than twice the metrics without one. |
| 3.8 | **The latency write-up.** Per-stage histograms before/after the session-pool change already in the working tree; where the time went; why the timeout was *not* raised; the percentile that justifies whatever it ends up being. | 004 | **differentiator** | **4–6 h** | Reaching a conclusion the data does not support. The prior favours tier-3 turn count, but that is a hypothesis to confirm with a graph. Publish whatever the graph says, including "the prior was wrong." |
| 3.9 | Trace id surfaced in the UI and in eval output, so a red eval case links to its trace. | 004, 010 | **differentiator** | **2–3 h** | None. |
| 3.10 | Declare and measure the **three** SLOs: freshness, coverage, correctness. Document burn-rate alerting as the correct method and state plainly that it is not implemented because there is no rotation to page. | 005 | **differentiator** | **4–6 h** | Declaring four. The SRE Book's own advice is the minimum that covers the system, and three that are evaluated beat four where one is decoration. |

**Phase total: 32–48 hours.** This is the phase with the highest differentiator density in the plan.

---

## Phase 4 — Correctness

**Why fifth:** it needs Phase 2 (a real baseline for the sort key) and Phase 1 (a gate to prove the
fix). It is placed here rather than earlier for exactly that reason, not because it is less
important — `B3.2b` is a **critical red case against the product's headline claim**.

**Claim this phase unlocks:** *the list ranked by anomalous silence no longer sometimes puts a place
that is talking in the top four — and here is the eval that caught it and the eval that proves it
fixed.*

| # | Item | ADR | Class | Effort | Specific risk |
|---|---|---|---|---|---|
| 4.1 | **Change the primary sort key** to the settlement's own surprisal against its own fitted baseline; Gi\* becomes the tiebreaker and the `anomalyType` classifier. | 011 | table-stakes | **8–12 h** | Introducing the reverse pathology — a high own-surprisal settlement with no corridor context dominating a genuinely dark stretch. Run `B3.2`'s randomised trials in both directions before declaring it fixed. |
| 4.2 | Explicit ordering rule for cohort cold starts: their own band with their own label; never top, never silently bottom. | 011 | table-stakes | **2–3 h** | Getting it wrong is a hard-rule-4 violation. A settlement with no baseline has no surprisal — it must not be coerced to zero or to infinity. |
| 4.3 | Update `test/rank.test.js`'s ordering contract and the README's description; turn `B3.2`/`B3.2b` green **by the fix, not by relaxation**; remove the 1.5 allowlist. | 011 | table-stakes | **2–3 h** | Relaxing the assertion to go green. The allowlist from item 1.5 is the tripwire against this. |
| 4.4 | **The before/after write-up**: the eval that caught it, the mechanism (Gi\* is a neighbourhood statistic), the change, the eval turning green. | 011 | **differentiator** | **2–3 h** | Under-writing it. **[JUDGEMENT]** This write-up is worth more than the bug never having existed — a critical defect in the project's own core statistic, found by its own suite, root-caused to a property of the statistic rather than a coding error, fixed with a measurement on both sides. |
| 4.5 | **Deterministic replay of recorded model responses**: record real TrueForge turns once, commit as fixtures, replay in CI. | 009 | **differentiator** | **6–10 h** | Fixture rot. Schedule refreshes and diff them — **a refresh that changes behaviour is itself a finding**, not a chore. |
| 4.6 | Tighten the PR eval gate now that 4.5 makes model-touching families hermetic: skip count → ~0, `--strict` becomes usable on PRs. | 006, 009 | **differentiator** | **1–2 h** | None. This is 4.5's payoff and should ship with it. |
| 4.7 | Unit tests for the uncovered stages, in priority order: `ingest.js` (largest hole; `docs/brightdata-serp-shape.md` documents the traps and none is asserted), `checkpoint.js` (`createEscalation` idempotency across re-runs), triage tiers 1–2, `server.js` route contracts. | 009 | table-stakes | **10–16 h** | Writing them against the current shapes right after Phase 2 changed those shapes. Do this after 2.3, not before. |
| 4.8 | Eval statistical layer: CLT standard errors on every rate; **paired** differences between the deterministic and harness scorecards; a held-out split, honestly caveated at n=32. | 010 | **differentiator** | **6–10 h** | Wide intervals looking like weakness. Publish them anyway — the reader who understands them is the hiring bar; the one who does not is not. |
| 4.9 | Measure beyond accuracy in the eval report: runtime, tool-call count, token cost, **omissions** — which for a silence-ranking system is literally the domain, not a metaphor. | 010 | **differentiator** | **3–4 h** | None. |
| 4.10 | Publish a failure taxonomy from the real observed failures, with a named test per category. | 010 | **differentiator** | **3–4 h** | Writing it as prose instead of tests. A taxonomy without a test per category is a list. |
| 4.11 | `fast-check` property tests formalising the invariants family B already fuzzes by hand — Fellegi–Sunter monotonicity, the Gamma-prior baseline returning the prior exactly on zero gaps, Gi\* permutation invariance. | 009 | **differentiator** | **4–6 h** | Duplicating family B rather than replacing it. Migrate, do not add a parallel suite. |
| 4.12 | Playwright E2E on the critical path only + `@axe-core/playwright` failing the build, trace-on-failure. Keep it near-vestigial per GitLab's measured 0.24%. | 009 | **differentiator** | **6–8 h** | Building a large E2E suite. Four journeys: a run completes, an escalation is approved by name, a blank approver is refused, the fail feed renders. |
| 4.13 | Mutation testing (Stryker) on `src/guardrails/` + `rank.js` + `dedup.js`, nightly, score reported. | 009 | **differentiator** | **4–6 h** | It will find weak assertions in the guardrail suite. That is the intended, uncomfortable outcome. Report the score before improving it, so the improvement is measurable. |
| 4.14 | Written flake policy covering the tier-3 timeout: replay-tested so it cannot flake; measured as a rate on the live path; **no blanket retries**. | 009 | **differentiator** | **1–2 h** | None. `evals/README.md`'s existing reasoning about grading `C1.0b2` major rather than critical is already the right instinct — promote it to a policy. |
| 4.15 | Fuzz the Bright Data response parser. | 009 | optional | **3–4 h** | None. Counts in both the security and QA disciplines at once. |

**Phase total: 61–93 hours.** The largest phase, and the one carrying the most differentiators.

---

## Phase 5 — Security artefacts

**Why sixth:** the highest-signal items here are *documents*, which makes them cheap — but three of
them (the attribution log, per-agent identity, the residual-risk table) need Phase 2's store and
Phase 3's telemetry to be truthful rather than aspirational.

**Claim this phase unlocks:** *"a named human approves an irreversible action" is true rather than
aspirational, and the threat model says what is out of scope instead of being silent about it.*

| # | Item | ADR | Class | Effort | Specific risk |
|---|---|---|---|---|---|
| 5.1 | `SECURITY.md`: the lethal-trifecta paragraph stating **which corner is architecturally removed** (the model has no write authority — tier 3 returns a classification, ranking is deterministic, the drafter has an empty tool list), the guardrails claimed as defence-in-depth and never as the boundary, and the measured secret-hygiene result. | 008 | table-stakes | **3–4 h** | Claiming prompt injection is handled. The adaptive-attack literature (arXiv:2510.09023) bypassed twelve published defences at >90% success. *"Contained, monitored and measured, with a known residual"* is the defensible claim. |
| 5.2 | `docs/threat-model.md`: a DFD with explicit trust boundaries, STRIDE per boundary, ML threats from MITRE ATLAS and the OWASP agentic list added rather than forced into STRIDE, stated assumptions and non-goals, and a residual-risk table. | 008 | **differentiator** | **8–12 h** | A STRIDE table with no DFD and no trust boundaries. That is not a threat model, and a security reviewer will say so in one sentence. |
| 5.3 | Map the guardrail rules and the agent surface to **OWASP LLM Top 10 2026** identifiers (Prompt Injection LLM01, **Excessive Agency LLM03** — promoted from LLM06 in 2025 — Supply Chain LLM04) and to the **Agentic** list (ASI01, ASI02, ASI06, ASI09). | 008 | **differentiator** | **2–3 h** | Citing the superseded 2025 list. Two of the four research reports disagree on this; `GAP-ANALYSIS.md` §4.1 records why the 2026 edition wins. |
| 5.4 | The **supply-chain page**: what code and what *instructions* execute in this system, and where each comes from — self-hosted harness, MCP server, remote model provider, and ~14k characters of agent instructions living **outside this repository**. | 008 | **differentiator** | **3–4 h** | Writing an SBOM instead. This page is the higher-value artefact and almost nobody writes it; the SBOM is a CI step. |
| 5.5 | **Per-tool risk classification** for the five Bright Data tools on OpenAI's stated axes, with the high-risk tier gated behind human approval, citing LLM03's "require user approval" mitigation and MCP's RFC-2119 *"SHOULD always be a human in the loop"*. | 013 | **differentiator** | **3–4 h** | None. This converts a verified demo feature into an argued control for the cost of a table. |
| 5.6 | Append-only **hash-chained approval log**: approver, timestamp, exact action, state hash, previous-record hash. | 008 | **differentiator** | **5–8 h** | Chain verification not being tested. Add a test that tampering with a middle record is detected. |
| 5.7 | Operator identity injected at deploy time (env var or `X-Operator` terminated at a proxy), **documented in those words**: the app is not authenticating anyone, it is recording who the deployment says is present, and the trust boundary is the proxy. | 008 | **differentiator** | **2–3 h** | Describing it as authentication. The honest minimum stated honestly beats a bolted-on login; describing it dishonestly is worse than both. |
| 5.8 | Per-agent identity in the audit trail. | 008 | **differentiator** | **2–3 h** | None. The harness already emits per-turn telemetry. |
| 5.9 | Written authorization matrix: which agent may invoke which tool, what requires approval, what is irreversible. | 013 | **differentiator** | **2 h** | None. |
| 5.10 | SBOM (CycloneDX) in CI + `actions/attest-build-provenance`, documenting the `gh attestation verify` command a consumer would run. **Claim SLSA Build L2; never L3.** | 006, 008 | optional | **2–3 h** | Claiming L3, or citing SLSA v1.0 as current — it is retired; v1.2 is active, while GitHub's own docs still say "SLSA v1.0 Build Level 2". Quote GitHub's wording and note the spec moved. |
| 5.11 | Resolve the **skills** decision: fix the sandbox route to PyPI and mount them (preferred — the measured A/B is 2/5 → 5/5), or delete the registrations and keep the SKILL.md files as authored artefacts with the A/B published. | 013 | **differentiator** | **4–10 h** | Leaving the third state — registered, unattached, labelled. It is honest and it is the worst option: a casual reviewer reads it as an exercised capability. **Never grant the sandbox back the capabilities it deliberately dropped** to force this. |
| 5.12 | Publish the **"skill metadata without its body increases confident fabrication"** finding. | 013 | **differentiator** | **1 h** | None. A genuine harness finding about progressive disclosure, worth raising deliberately. |
| 5.13 | File the two upstream findings upstream: the Windows ESM crash in kysely's `FileMigrationProvider`, and the silently-dropped `compaction.trigger`. Both are already root-caused with reproductions. | 013 | **differentiator** | **1–2 h** | None. The filing is the missing half of a signal the project has already earned. |

**Phase total: 38–59 hours**, of which roughly half is writing rather than code — the best
value-per-hour in the plan after Phase 0.

---

## Phase 6 — Reachable

**Why last:** the public deploy arms ADR-008's authentication clause, so it cannot precede Phase 5.
The frontend items here are genuinely droppable, which is why they are at the end rather than
because they are unimportant.

**Claim this phase unlocks:** *a stranger can click a link and use it.*

| # | Item | ADR | Class | Effort | Specific risk |
|---|---|---|---|---|---|
| 6.1 | Deploy to a PaaS with a committed config (`fly.toml` / `render.yaml`) and managed Postgres. | 007 | table-stakes | **4–6 h** | Deploying before 6.2. The moment approve/reject is reachable by strangers, the missing auth is a first-five-minutes finding that no threat model rescues. |
| 6.2 | **OIDC via a hosted provider** on the write paths — ADR-008's conditional clause, armed by 6.1. Delete the caveat in item 5.7. | 008 | table-stakes **once 6.1 ships** | **4–6 h** | Treating the clause as optional. It was written as binding; honour it or do not deploy publicly. |
| 6.3 | Split `web/app.js` (2,368 lines) into modules. | 002 | table-stakes | **6–10 h** | **[JUDGEMENT]** This is the real risk ADR-002 carries. A single 2,368-line file is where "no framework" stops being a taste decision and becomes an argument against itself. A reviewer *will* open it. |
| 6.4 | Keyboard + screen-reader pass, written up honestly: roving tabindex on the tabs, sortable headers as real buttons, **the map's non-visual equivalent path documented explicitly**, one named screen reader and one bug it found, and the WCAG 2.2 AA criteria not met. | — | **differentiator** | **6–10 h** | Publishing an axe score instead. Automated tooling catches a minority of WCAG failures and an a11y reviewer knows it. The map paragraph is the sophisticated point almost no map project makes. |
| 6.5 | Measure LCP / INP / CLS on the real console under real data and publish a budget CI enforces. | — | **differentiator** | **4–6 h** | Claiming before measuring. A map + ranked table + five live regions is an **INP** risk specifically (≤200 ms); Long Animation Frames is the diagnostic. |
| 6.6 | **Uncertainty in the visual encoding** — Gi\* z-score confidence and the Gamma-prior interval rendered in the encoding, not hidden in a tooltip. | — | **differentiator** | **8–12 h** | Scope creep into a redesign. This is the rarest data-viz skill and the one that best matches what this project already computes; keep it to the encoding. |
| 6.7 | The separate small **React + TypeScript artefact** — ADR-002 part 3. Suggested: a trace viewer consuming Phase 3's OTLP spans, so it is not a disconnected toy. | 002 | optional-but-strategic | **12–16 h** | Building a tutorial project. Its only job is to remove the "cannot verify React" screen failure permanently and make Signal Zero's vanilla choice legible as a choice. |
| 6.8 | A modest load test with honest p50/p95/p99 — **only now**, since the store finally exists. | — | optional | **3–4 h** | Doing it earlier. Load-testing an in-memory store measures nothing, and the infrastructure family will not be impressed by k6 numbers on a demo dataset regardless. |

**Phase total: 47–70 hours.**

---

## Backlog — deferred with an explicit trigger

| Item | ADR | Class | Effort | Trigger |
|---|---|---|---|---|
| Bandit probe allocation + replay offline policy evaluation, with the "no model was trained" README paragraph. | 014 | optional | **16–24 h** | Phases 2, 3 and 1 green, *and* enough logged, propensity-recorded probe decisions for the replay estimator to have support. **Done sloppily this is worse than omitting it** — it retroactively taints every honest claim in the project. |
| Preference-elicitation protocol as the cheaper fallback to the above. | 014 | optional | **6–8 h** | The OPE trigger not firing. |

**Everything else that might belong on a backlog is in ADR-015's refusal register instead, with the
threshold at which it becomes correct. Do not migrate items from there to here without crossing the
threshold and dating the revision.**

---

## Totals, and three honest cuts

| Phase | Effort | Composition |
|---|---|---|
| 0 — Truth repairs | 3–4 h | 4 table-stakes, 2 differentiators |
| 1 — The gate | 24–37 h | 7 table-stakes, 2 differentiators, 1 optional |
| 2 — Memory | 37–56 h | 8 table-stakes, 5 differentiators |
| 3 — Sight | 32–48 h | 1 table-stakes, 9 differentiators |
| 4 — Correctness | 61–93 h | 5 table-stakes, 9 differentiators, 1 optional |
| 5 — Security artefacts | 38–59 h | 1 table-stakes, 10 differentiators, 2 optional |
| 6 — Reachable | 47–70 h | 3 table-stakes, 3 differentiators, 2 optional |
| **Total** | **242–367 h** | ≈ 6–9 focused weeks |

**[JUDGEMENT]** That is a real number and it should not be softened. Three cuts, in case it is more
time than exists:

### If you have one weekend (≈16 h)

Phase 0 entirely (3–4 h), then items **1.1, 1.2, 1.3, 1.4, 1.5** (≈11 h). You end with: no
overclaims anywhere, a green badge, the test suite and the eval suite running on every push, and the
eval gate publishing its scorecards. **This is the highest-value 16 hours available to this project
and it is not close.** Everything else in this plan is worth less per hour than these two days.

### If you have one week (≈40 h)

The weekend above, plus **1.6** (types) and **1.7** (secret scan), plus Phase 0's payload table and
`A8.1` promotion done properly rather than quickly. You end with a repository that a stranger can
verify, that type-checks, and whose two strongest measurements are on the front page.

### If you have one month (≈160 h)

Phases 0, 1, 2, 3, plus **4.1–4.4** (the ranking fix and its write-up) and **5.1–5.5** (the security
documents). You end with: it remembers, it is instrumented, it has three SLOs including one where
the SLI *is* the product, its one critical red case is fixed with a published before/after, and its
threat model exists. **[JUDGEMENT]** That is a portfolio project above the senior bar in the AI/agent
family and at it in the platform family, and it is where I would stop if forced to.

### What to cut first if time runs out mid-plan

In this order: **6.8** (load test) → **6.7** (React artefact — only if the target roles are
Stripe-shaped generalist ones; if any Linear/Framer/Figma-tier application is submitted this becomes
urgent instead) → **6.6** (uncertainty encoding) → **4.15** (parser fuzzing) → **5.10** (SBOM) →
**1.8** (CodeQL). **Never cut Phase 0, item 1.4, item 2.2, or items 4.1–4.4.** Those four are the
ones that make the difference between a repository that says it is rigorous and one that is.

---

## The one thing to remember while executing this

**[JUDGEMENT]** Every phase above is scaffolding around five things this repository already does
better than almost any portfolio project: an eval suite that publishes its own red and has produced
a negative result about its own LLM; a guardrail layer that is deterministic code with its own limits
written down; three real statistical methods with honest notes about which half of one of them is
decoration; two root-caused upstream findings; and a documented habit of writing down what is *not*
true.

Nothing in this plan rebuilds any of those, and nothing in it should. The plan exists because those
five things are currently invisible — buried in `docs/` and `src/guardrails/`, unexecuted by any
machine, unmeasured by any instrument, and lost on every restart. **Fix the scaffolding and the
substance becomes visible. Rebuild the substance and the project gets worse.**
