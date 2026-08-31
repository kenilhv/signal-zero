# Signal Zero — Gap Analysis Against the 2026 Senior Hiring Bar

**Written:** 30 August 2026. **Branch:** `feat/control-room-ux`.
**Against:** `docs/hiring/ai-ml-bar.md`, `docs/hiring/platform-bar.md`, `docs/hiring/frontend-bar.md`,
`docs/hiring/security-qa-bar.md` — four evidence-cited research reports on what 2026 hiring
managers require.

This document is deliberately unkind. Flattery about a portfolio project is worthless; a reviewer
will find the gaps in ten minutes whether or not this file names them, and the only version of this
exercise that has value is the one that names them first.

---

## 0. How to read the evidence labels

| Label | Meaning |
|---|---|
| **[MEASURED]** | I ran a command against this repository on 2026-08-30 and observed the result. Command given or reproducible. |
| **[REPO]** | I read this in a file in this repository. Path and line given. |
| **[RESEARCH]** | A claim from one of the four hiring reports, which carries its own primary source. The URL is reproduced so the chain is checkable. |
| **[JUDGEMENT]** | My own engineering opinion. Not sourced. Argue with it. |

Where the four research reports disagree with each other, §4 reports the disagreement rather than
averaging it. Where a research report disagrees with what is actually in this repository, §1 says so
and the repository wins.

---

## 1. Measurement ledger — including six corrections to the brief

Everything below was checked today, not taken on trust. **Six of the "verified" facts in the
positioning brief are wrong or misleading, and each correction matters** — a reviewer who finds an
overclaim in the framing discounts the substance behind it.

### 1.1 Confirmed as stated

| Claim | Status |
|---|---|
| 195 tests passing | **[MEASURED]** `npm test` → `pass 195, fail 0`, 6.59 s. True. |
| No CI/CD | **[MEASURED]** `.github/` absent. |
| No Dockerfile, compose, `.dockerignore` | **[MEASURED]** all three absent. |
| No linter, formatter, `tsconfig.json` | **[MEASURED]** `eslint.config.js`, `.eslintrc`, `.prettierrc`, `tsconfig.json` all absent. |
| No persistence | **[REPO]** `src/store.js` is a plain object of arrays with a 200-item incident ring buffer; its own header says "No database." |
| No `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `openapi.yaml` | **[MEASURED]** all absent. |
| No authn/authz | **[MEASURED]** no auth middleware; all six routes are open. |
| `engines: ">=20"` vs a Node 24 stack | **[REPO]** `package.json:8-10`. Confirms the `security-qa-bar` §9 finding. |
| `.env` present and gitignored | **[MEASURED]** `.env` exists in the working tree; `.gitignore:2` covers it. |

### 1.2 Corrections

**Correction 1 — "69 eval files" is an artefact of a `find` over gitignored scratch.**
**[MEASURED]** `find evals -type f` returns 69. `git ls-files evals` returns **19**. Forty-nine of
those files live in `evals/.scratch/`, which `evals/.gitignore:1` excludes and which every
`npm run eval` regenerates; one more is `evals/report/latest.json`, also gitignored. The honest
figure is **19 tracked files organised into 4 families running 155 checks**. Saying "69 eval files"
on a resume is an overclaim a reviewer reproduces with one `git ls-files`, and it would poison the
credibility of the eval work — which is the strongest thing in the repository. **Fix the number
before anything else in this document.**

**Correction 2 — the tests are 195 assertions across six files, five of which are one subsystem.**
**[MEASURED]** the only test files are `test/rank.test.js` and five `src/guardrails/*.test.js`.
**[REPO]** `src/guardrails/README.md:41` accounts for 144 of the 195. So ~51 tests cover `rank.js`
and **zero unit-test files exist for `ingest.js`, `triage.js` (tiers 1–2), `dedup.js`,
`checkpoint.js` or `server.js`** — those are exercised only through the eval suite, which needs a
child process and (for two families) a live TrueForge container. **[JUDGEMENT]** "195 tests" is
technically true and structurally misleading. The number is fine; the *shape* is the finding.

**Correction 3 — there is no winston. There is no structured logging at all.**
**[MEASURED]** `grep -rn winston` over `src`, `web`, `evals`, `scripts`, `package.json` returns
nothing; `package.json` lists four runtime dependencies (`@truefoundry/trueforge-sdk`, `dotenv`,
`express`, `maplibre-gl`). Logging is **30 bare `console.*` calls** in non-test `src/`. This makes
the observability gap one step worse than the brief and than `platform-bar` §7 Tier 1 item 8
assumed — that item says "winston already exists; make output structured", and it does not exist.

**Correction 4 — the repository claims a licence it does not carry.**
**[REPO]** `README.md:326-328` ends with "## License — MIT." **[MEASURED]** no `LICENSE` file
exists. **[JUDGEMENT]** This is worse than an absent licence. An absent licence is an omission; a
claimed-but-absent licence is a statement in the README that the filesystem contradicts, in a
project whose entire pitch is that it does not overclaim. Five minutes to fix.

**Correction 5 — "5 persistent agents" describes a registry, not a system.**
**[REPO]** `README.md:274-280` and `docs/harness-review.md` S2-3 both already correct this: exactly
one agent, `signal-zero-triage-tier3`, is reachable from `src/`; deleting the other four changes no
product output. **[MEASURED]** the *uncommitted working tree* is ahead of both documents — it adds
`src/harness/escalation-drafter.js` (616 lines, binds `signal-zero-escalation-drafter` by name) and
`scripts/audit-diff.mjs` (950 lines, puts `signal-zero-auditor` on a diff-gate call path). Those
two files close "Still open #5" in `docs/harness-review.md:1187`. **The honest current claim is two
production LLM touchpoints and one CI-gate agent, not five agents** — and that is a *better* claim
than five, because each one has a job.

**Correction 6 — the 114 s regression's status is unknown, not fixed and not measured.**
**[MEASURED]** the uncommitted `src/config.js` diff adds `TRUEFORGE_SESSION_POOL=4` and
`TRUEFORGE_TIER3_CONCURRENCY=4` with a benchmark in the comment: *four identical prompts through a
shared session took 9,470 ms; through four separate sessions, 1,310 ms* — TrueForge serialises turns
inside a session, so one shared session was a hidden serialisation point. That is a real, measured
root cause and a real fix. **But no measurement of a full pipeline pass after the change exists
anywhere in the repository**, because nothing times the stages. `src/server.js:266` computes one
aggregate `durationMs` and that is the entire timing story. **[JUDGEMENT]** The project currently
has a root-cause narrative with no before/after graph, which is 60% of a senior story and 0% of a
credible one.

### 1.3 Things the brief undersold

- **[REPO]** A single-flight guard on the pipeline already exists — `src/server.js:124` returns
  `A pipeline pass is already running.` This is `platform-bar` §7 Tier 2 item 10, already done.
- **[REPO]** Structural clamping already exists and is verified adversarially: `parseTier3`
  allowlists `settlementId` against the offered shortlist and clamps confidence to `[0.3, 0.7]`
  (`docs/harness-review.md` "What I could not break" #3). This is the correct architecture and it is
  not framed as a security control anywhere.
- **[MEASURED]** Re-measured the shipped frontend payload independently of `frontend-bar` §3.4:
  `app.js` 30 KB gz, `map.js` 20, `lib.js` 6, `styles.css` 21, `index.html` 5, MapLibre bundle 281 —
  **361 KB gz concatenated, of which 78% is the third-party map engine and 82 KB is author-written**.
  The researcher's 363 KB figure reproduces.

---

## 2. What is already above the bar — foreground this, do not rebuild it

**[JUDGEMENT]** Five things in this repository already clear a senior bar. Rebuilding any of them is
waste. The failure mode to guard against is not that these are weak; it is that they are **buried in
`docs/` and `src/guardrails/` where no reviewer will find them.**

### 2.1 The eval suite is the single strongest asset, and it is not close

Not because it is large. Because of five specific properties that almost no portfolio eval suite has:

1. **It publishes its own red.** **[REPO]** `evals/README.md:35` — *"The six failures are findings
   about Signal Zero, not about the suite."* Four were critical. `docs/harness-review.md:1132`
   leaves `B3.2`/`B3.2b` open by name and explains *why the fix was declined under time pressure*.
   **[RESEARCH]** `ai-ml-bar` §6.3 lists "A documented regression with a root cause" and "Explicit
   'we did NOT do X, because Y' statements" as the senior column of its capstone-vs-senior table.
2. **It has controls that invalidate the family above them.** `D0` asserts the TrueForge double
   really produces a harness-executed classification; the stub's own header states that if `D0`
   fails, *"every fault result built on it is worthless."* When `D0` went red, the suite said the
   other 49 greens meant nothing. **[JUDGEMENT]** A test suite that knows which of its own results
   are load-bearing is rarer than any tool on any checklist.
3. **It tests the detectors before it trusts them.** `C0.1`–`C0.3` run positive and negative
   controls against the dispatch/false-certainty detectors, *"because a clean scan from a blind
   detector is the most dangerous result an eval can produce"* (`evals/README.md:225`). It has
   already caught the dispatch detector missing the passive voice.
4. **It has a domain-weighted metric and a meta-test of the metric.** `harmWeightedErrorRate` weights
   a wrong resolution 3× a missed one, with the weight stated. `A6` scores two synthetic baselines —
   a maximally lucky guesser and a pure abstainer — and `A6.2` *passes when the unweighted macro-F1
   misbehaves*, so the claim has to be rewritten rather than silently becoming false if the set
   changes. **[RESEARCH]** Cognition's Research Engineer posting asks for exactly this:
   *"making numbers go up and making sure the numbers mean something"* —
   https://jobs.ashbyhq.com/cognition/72d3db28-07d3-4c28-b49f-1bdf6e8e0f10.
5. **It has already produced a negative result about the project's own LLM.** `A8.1`: harm-weighted
   error rate **0.281 with tiers 1+2 only, 0.375 with live tier 3**. The model fixed zero resolution
   errors and introduced one. **[JUDGEMENT] This is the single most interview-valuable fact in the
   repository and it is currently on line 315 of a file in `evals/`.** It is an A/B of a component
   against a domain-weighted metric that concluded *turn the component off*. That is what an eval is
   *for*, and almost nobody has one that has ever said no.

**Rating: A. Foreground it. The only work needed is §5.2's statistical layer and Correction 1.**

### 2.2 The guardrail layer

**[REPO]** `src/guardrails/` — deterministic code, not prompt text; a verdict object with spans that
index the **original** string; recorded *suppressions* so a guard's decision to let something through
is reviewable; fail-closed on an internal error; and a two-pass tokenizer whose `spanFor` binary
search preserves offsets so an incident is auditable.

The part that clears a senior bar is `src/guardrails/README.md`'s **"Known limits"** sections — one
per rule, naming what the layer cannot catch: implication, ordering-as-instruction, the exploitable
negation guard, semantic paraphrase, multi-document injection, and (before the NFKD fix) every
non-Latin script. **[RESEARCH]** `security-qa-bar` §1.4 and `ai-ml-bar` §3.2 both make the same
point from Simon Willison's *lethal trifecta* — https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
— that a project claiming to have solved prompt injection is disqualifying, and a project that
documents what it has *not* solved is credible. This layer already does the credible thing.

**Rating: A.** The one gap is that nothing maps it to a published taxonomy (§3.4).

### 2.3 The applied statistics

**[REPO]** Fellegi–Sunter record linkage with per-field m/u log-likelihood weights; an Exponential
time-between-events fit per cohort with a Gamma prior; Getis-Ord Gi* over a hand-built river-corridor
adjacency graph. All deterministic, all LLM-free by hard rule, and `test/rank.test.js` asserts
byte-identical output across runs.

The senior signal is not the methods — it is the honesty around them. `README.md:159-162` labels the
clustering *"Leiden-inspired"* and states exactly which half of Leiden it does not do.
`evals/README.md:153` records that **48 of the 96 Fellegi–Sunter comparison vectors are unreachable**
because blocking discards them first — *"those m/u rows are decoration rather than evidence"*.
**[JUDGEMENT]** A candidate who volunteers that half their own model is unreachable is a candidate
whose other numbers you believe.

**Rating: A.** Do not touch, except for the ranking defect in §5.1, which is a *product* decision
rather than a statistics defect.

### 2.4 The harness-integration honesty

**[REPO]** `docs/trueforge-verified.md` contains two upstream findings — the Windows ESM crash
root-caused to a dynamic `import()` of an absolute path without `pathToFileURL()`, and
`compaction.trigger` being silently dropped with an HTTP 200 — plus a capability scorecard that
corrects itself **in both directions** (*"the previous version undercounted skills and overcounted
approval — both corrections, not only the flattering one"*, line 165). It states plainly that
TrueForge provides the pause and **does not** provide a named approver, and that Signal Zero's server
adds that. **[RESEARCH]** `ai-ml-bar` §6.3 lists "A root-caused upstream bug, filed, with a
reproduction" as a senior signal.

**Rating: A.** One gap: neither upstream finding appears to have been filed upstream. Filing them
converts "I found a bug" into "I found a bug and the maintainers have it."

### 2.5 The adversarial self-review

**[REPO]** `docs/harness-review.md` is a severity-rated review of the project against itself, with
reproductions, followed by a repairs section that closes each finding — and that **declines** one
(S1-1) as *"PARTLY WRONG, FIXED ANYWAY"* rather than counting a non-reproducing finding as a win, and
leaves five items explicitly open. **[JUDGEMENT]** This document, `evals/README.md`'s "What this
suite does NOT cover", and `README.md`'s "What's real vs. simulated" table together are the rarest
asset here — a demonstrated *habit* of writing down what is not true. Every other item in this gap
analysis is a thing to build. That one is a thing to protect.

**Rating: A.**

---

## 3. Ratings against each role bar

**Scale.** **A** — above the bar; foreground it. **B** — at the bar; present and credible, not a
differentiator. **C** — below the bar; a reviewer would probe and find it thin. **D** — absent, and
the absence itself reads as a negative. **F** — actively disqualifying, or contradicts a claim the
project makes.

### 3.1 AI / Agent Engineer — the family this project can actually clear

**[RESEARCH]** `ai-ml-bar` §1.1: the bar is a software-engineering bar with an evaluation discipline
on top. Machinify requires *"A bias toward measurement: you don't ship without an eval"*
(https://job-boards.greenhouse.io/machinifyinc/jobs/4146862009); LangChain requires, as a required
bullet, *"Hands-on experience implementing evaluation and monitoring systems for agents or
workflows"* (https://jobs.ashbyhq.com/langchain/c75915ba-a32b-4e17-873d-19b47564170d); Baseten asks
you to *"Design the harnesses, execution flows, and guardrails that make AI systems reliable in
production"* (https://jobs.ashbyhq.com/baseten/b13ec426-d09d-4122-8112-cf25adbd7d60).

| Dimension | Rating | Justification |
|---|---|---|
| Eval design and rigour | **A** | §2.1. Golden set with per-case reasoning, property family, adversarial family, fault family, controls, a domain-weighted metric, a meta-test of that metric, and a published negative result about its own LLM (`A8.1`). |
| Eval statistical defensibility | **C** | No standard errors, no paired differences, no held-out split, no repeated sampling. `evals/README.md:391` already concedes *"32 cases is enough to catch a category of error, not to put a confidence interval on a precision figure"* — correct posture, unquantified. Miller, arXiv:2411.00640, is the exact toolkit. |
| Evals in CI as a merge gate | **D** | `npm run eval --strict` exists (`package.json:17`). Nothing runs it. **[RESEARCH]** OpenAI's Evals posting asks literally for *"continuous eval monitoring frameworks (regression/drift monitoring…)"* — https://jobs.ashbyhq.com/openai/3d064454-c0c3-4225-bc2c-6d8c0f8735b2. 155 checks that no machine runs are a claim. |
| Agent-loop / tool-calling fluency | **B** | Named-agent binding verified (`binding: named-agent`, agent id read back off the registry); `runTurn` polls to a terminal state and rejects `done`-with-null-output — "HTTP 200 is not success" enforced, not documented. But the shipping agent has `mcp_servers: []`, so there is no tool-call loop on the product path. |
| Guardrails / reliability engineering on the model boundary | **A** | §2.2, plus structural clamping that survived direct attack. |
| Human-in-the-loop / tool risk | **C** | HITL is verified in `scripts/verify-agents.mjs` and **never arms in the product** (`approvalGate: {armed:false}`). The docs are scrupulous about this. But there is **no per-tool risk classification** — OpenAI's agents guide prescribes rating each tool low/medium/high on read-vs-write, reversibility, permissions and financial impact (https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf), and five Bright Data tools are unrated. |
| LLM observability / tracing | **D** | No traces, no spans, no OTLP export. Per-turn token and cache figures are collected and then rendered to one HTTP response. **[RESEARCH]** `ai-ml-bar` §5.3: winston-equivalent logging answers none of "one trace per task", "latency by layer", "tool outcome as an attribute", or "trace id linked from a failing eval case". |
| Applied statistics / decision theory | **A** | §2.3. |
| RL / post-training | **n/a — correctly** | **[RESEARCH]** `ai-ml-bar` §4.1 measured it: Sierra's 52 engineering postings mention RLHF/DPO/GRPO/post-training **zero** times; GRPO and PPO appear in zero postings across ~2,700. Claiming any of it here would be the single largest credibility risk available. Currently claimed: none. Keep it that way. |
| Written communication of tradeoffs | **A** | §2.5. **[RESEARCH]** Anthropic lists clear written communication as a *minimum* qualification — https://job-boards.greenhouse.io/anthropic/jobs/5198255008. |

**Family verdict: this is the family to target, and it is closer than the gap list suggests.** The
substance is there; the gap is entirely that nothing is *executed automatically* and nothing is
*instrumented*.

### 3.2 Backend / Platform / SRE

**[RESEARCH]** `platform-bar` §1.1's central finding: elite infrastructure postings rarely enumerate
a CI/CD toolchain — Cloudflare's Senior Systems Engineer posting
(https://job-boards.greenhouse.io/cloudflare/jobs/8087792) *never mentions Kubernetes, CI/CD or
containers at all*. They screen for ownership through staged rollout and incident. So a pipeline
earns nothing by existing; its absence is disqualifying.

| Dimension | Rating | Justification |
|---|---|---|
| Persistence | **F** | `src/store.js` is in-memory. **[RESEARCH]** `platform-bar` §3 makes the argument that matters: the product measures *elapsed time since last observation*, so a store that forgets on restart **cannot measure its own core metric across a restart**. This is not an infrastructure omission; it invalidates the product thesis. It is also why the Exponential TBE fit has a maximum meaningful history of one process uptime. |
| CI/CD | **D** | Absent. |
| Containerisation / one-command run | **D** | Absent. Compounded: `.env` is in the working tree with no `.dockerignore`, so the first naive `Dockerfile` would ship real Bright Data and model-provider credentials into an image layer. |
| IaC / deployment | **D** | No deploy config, no live URL. **[RESEARCH]** `platform-bar` §2.3: *"A live URL is worth more than any amount of infrastructure code."* |
| Metrics / tracing | **D** | None. See Correction 3 — worse than the brief stated. |
| Structured logging | **D** | 30 `console.*` calls, no correlation id, no run id. |
| SLOs / error budgets | **D** | None declared. **[RESEARCH]** And this is the single largest *unclaimed* asset: the SRE Workbook's three pipeline SLI categories are freshness, correctness and coverage (https://sre.google/workbook/implementing-slos/) — and **freshness is not this system's operational metric, it is its output**. `platform-bar` §3.4 calls this the strongest idea available to the project. I agree, and add one extension in §5.3. |
| Reliability under fault | **B** | Genuinely good and under-credited: fault-injection at the wire across 9 modes, container-kill survival, honest degradation, a single-flight guard, and a fallback that is counted rather than silent. What is missing is that none of it is a *metric* — the fallback rate is invisible to any dashboard. |
| Latency diagnosis | **C** | A real root cause (session serialisation) with a real benchmark, and **no per-stage instrumentation and no before/after number** (Correction 6). **[RESEARCH]** `platform-bar` §5.2 step 1: *"Do not touch the timeout yet. The timeout is a detector."* `src/config.js:63-74` already argues exactly this in a comment — the reasoning is right and the measurement is absent. |
| API design | **C** | Six coherent JSON routes, correct 400/409/404/500 handling, a global error handler at `src/server.js:698`. No OpenAPI document, no RFC 9457 problem details, no idempotency key on the checkpoint approve/reject routes, no versioning. **[RESEARCH]** Double-approving a human-in-the-loop safety control is a correctness bug in an auditability product, not a theoretical one — Stripe's semantics are the de-facto reference (https://docs.stripe.com/api/idempotent_requests) and the IETF draft is *expired*, which is worth knowing. |
| Repo hygiene | **F** | No `LICENSE`, while `README.md` claims MIT (Correction 4). |

**Family verdict: this is where the project fails hardest, and every failure is cheap to fix.**

### 3.3 Frontend / Product Engineering

**[RESEARCH]** `frontend-bar` §1.1 is unambiguous and I am not going to soften it: React + TypeScript
is a **literal stated requirement** at Linear, Framer, Figma, Vercel, Airbnb, Anthropic, NYT and
Verkada. §1.4's asymmetry is the operative argument: *"A reviewer who wants React and sees no React
cannot verify you have it… The document is an interview weapon, not a resume weapon."*

| Dimension | Rating | Justification |
|---|---|---|
| TypeScript | **D** | None. **[RESEARCH]** `frontend-bar` §1.4: *"TypeScript appears in more of the postings I read than React does."* This is the largest single requirement gap in the whole project and the cheapest to close without a rewrite. |
| Framework (React) | **C** | Vanilla, no build step. **[RESEARCH]** Defensible as a choice (DHH — https://world.hey.com/dhh/you-can-t-get-faster-than-no-build-7a44131c; Alex Russell — https://infrequently.org/2023/02/the-market-for-lemons/), and **only legible as a choice once React exists somewhere else on the resume**. Rated C, not D, because §3.4's measurement genuinely defends it. |
| Empirical defence of the no-build decision | **A** | **[MEASURED]** 361 KB gz total, 78% MapLibre, 82 KB author-written. The bundler you do not have would minify 82 KB of hand-written source; over gzip that saving is a small fraction of a payload dominated by a third-party map engine. **The build step would not have been the thing that made this fast.** That is falsifiable and specific. It is currently published nowhere. |
| Accessibility | **B** | Better than typical and unclaimed: **[RESEARCH]** `frontend-bar` §2.3 measured `role="tablist"/"tab"/"tabpanel"`, `aria-live` ×5, `aria-sort` ×4, `aria-pressed` ×14, `<meta name="color-scheme">`. Gaps: roving tabindex on the tabs, sortable headers as real buttons, and — the sophisticated point nobody makes — **a WebGL canvas is opaque to assistive tech, so the ranked list must be a genuinely equivalent non-visual path to every fact the map conveys.** Signal Zero already has that list and does not say so. |
| Performance | **C** | Payload measured; `preconnect` and the non-blocking-stylesheet pattern are deliberate. LCP/INP/CLS unmeasured on the real console. A map + live regions + a ranked table is an **INP** risk specifically (≤200 ms, https://web.dev/articles/vitals). Measure before claiming. |
| Data visualisation | **B→A available** | **[RESEARCH]** `frontend-bar` §4.2: Verkada's Staff Mapping posting makes projections and linear algebra *required* and MapLibre/deck.gl *nice-to-have* — the library is the easy half. Signal Zero's Gi* over a corridor graph is a published spatial-autocorrelation statistic, not a heatmap, and ranking by *absence* is a genuine analytical inversion. **The missing piece is uncertainty in the visual encoding** — a Gi* z-score and a Gamma-prior interval both carry confidence, and showing it in the encoding rather than a tooltip is the rarest viz skill and exactly what this project computes. |
| UI testing | **D** | `evals/README.md:377` says it outright: *"The UI. `web/` is never loaded."* No Playwright, no component tests, no automated a11y. |
| Design craft | **not rated** | Out of scope for a filesystem audit; `docs/ui-spec.md` and `docs/ux-critique.md` exist and I did not evaluate the rendered result. |

**Family verdict: one cheap fix (types), one measured asset to publish (payload table), one weekend
artefact to build elsewhere (React/TS), and a genuine viz differentiator left on the table.**

### 3.4 Security & QA

| Dimension | Rating | Justification |
|---|---|---|
| LLM/agentic threat awareness | **B** | The *practice* is excellent (§2.2). The *vocabulary* is absent: no mapping to OWASP LLM Top 10 identifiers, none to the Agentic Top 10 (ASI01–ASI10), no STRIDE, no data-flow diagram. **[RESEARCH]** `security-qa-bar` §4.1: threat modelling is a literal named duty in Cloudflare's Product Security posting (https://job-boards.greenhouse.io/cloudflare/jobs/8102768) and *"almost no portfolio project has one"* — high signal, low prevalence. |
| Written threat model | **D** | Absent. The highest-value security document available to this project. |
| Supply chain | **C** | Lockfile committed; four runtime dependencies; no SBOM, no provenance, no Dependabot, no pinned action SHAs (no actions at all). **[RESEARCH]** `security-qa-bar` §2.2's sharpest point: the high-leverage move here is **not** the SBOM — it is a one-page document of *what code and what instructions execute in this system and where each comes from*, because a self-hosted third-party harness + an MCP server + a remote model provider + ~14k characters of agent instructions living **outside the repo** is a genuinely unusual supply chain and almost nobody writes that page. |
| Secrets | **B** | **[RESEARCH]** `security-qa-bar` §3.2 measured it: `.env` has never been committed on any ref; 82 paths ever added; all `brd_` hits are the `brd_json=1` query parameter; `.env.example` has every secret value empty. The repo is clean. **The gap is provable hygiene, not hygiene** — no history-scanning CI job, no pre-commit hook, no `SECURITY.md` stating the result. |
| AuthN / AuthZ / attribution | **C, trending F on public deploy** | See §4.3 — this is where the research genuinely disagrees, and I think `security-qa-bar` wins. The project's headline claim contains the word **named**. With no identity, the approval record proves an approval happened and cannot say who. That is the **Repudiation** category and **ASI09**, and it is a gap in the *product thesis*, not the deployment posture. |
| Testing shape | **C** | Correction 2. 195 assertions in six files, five of them one subsystem; the pipeline is covered only via a suite requiring a child process and a container. **[RESEARCH]** GitLab's published measured distribution is 75.66% unit / 19.79% integration / **0.24% end-to-end** (https://docs.gitlab.com/development/testing_guide/testing_levels/) — Signal Zero is inverted. |
| Non-determinism handling | **B** | Better than most and incomplete. The statistical core is genuinely deterministic and asserted so; all fuzzing is seeded (`mulberry32`); `evals/README.md:394` concedes tier-3 numbers are **a single sample** at temperature 0. **[RESEARCH]** `security-qa-bar` §8.1: temperature 0 is not determinism — Thinking Machines' batch-invariance result (https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/) means you cannot make a hosted API deterministic from the client side. **The missing technique is deterministic replay of recorded model responses**, which would also remove network flake and API cost from CI. |
| Coverage / mutation | **D** | No coverage reported (`node:test` supports it natively, no dependency needed); no mutation testing. **[RESEARCH]** Mutation testing is Thoughtworks Radar Vol. 34 **Trial** — not Adopt, a correction `security-qa-bar` §7 makes explicitly against a secondary source that overstated it — and it *directly answers* the obvious challenge to "195 tests". |
| Fuzzing | **D** | `evals/README.md:372` names the biggest hole itself: *"No test drives `src/pipeline/ingest.js` against Bright Data, live or recorded"*, while `docs/brightdata-serp-shape.md` documents relative-date and redirect-stub traps — and *"a wrong timestamp is a wrong silence score"*. A parser fuzz target here counts in both disciplines at once. |

**Family verdict: the security *engineering* is strong and the security *artefacts* are missing. The
QA shape is inverted and the one technique that would fix CI, cost and flake at once — recorded
replay — is not present.**

---

## 4. Where the research disagrees, and how I resolve it

Averaging these would be mush. Each is reported and decided.

### 4.1 OWASP edition — `ai-ml-bar` and `security-qa-bar` cite different lists

`ai-ml-bar` §3.1 cites the **2025** edition (LLM01 Prompt Injection, LLM06 Excessive Agency) and
notes it *"did not find a later edition, but cannot prove none exists."* `security-qa-bar` §1.1
reports a **2026** edition published 4 Aug 2026 with Excessive Agency promoted to **LLM03** and
System Prompt Leakage replaced by **Hidden Context Exposure (LLM08)**, cross-checked against the
OWASP GitHub repo (https://github.com/GenAI-Security-Project/GenAI-LLM-Top10) and Help Net Security.

**Resolution: `security-qa-bar` wins** — it has two independent sources that agree on all five
movements, and it explicitly checked the arithmetic. **Cite the 2026 identifiers and note the 2025
mapping in one parenthesis.** **[JUDGEMENT]** Getting this right is a real discriminator; citing the
2025 list in late 2026 is the same class of error as citing SLSA v1.0 (see §4.4).

### 4.2 Persistence: Postgres or SQLite

`platform-bar` §3.1 says Postgres, while conceding *"By SQLite's own checklist, Signal Zero qualifies
for SQLite"* (https://www.sqlite.org/whentouse.html) and losing on two grounds: deploy topology on
ephemeral PaaS filesystems, and hiring signal (PostgreSQL 55.6% vs SQLite 37.5%,
https://survey.stackoverflow.co/2025/technology). `ai-ml-bar` §7 item 7 and `frontend-bar` §7 item 10
both say *"SQLite is sufficient."*

**Resolution: Postgres, and record that SQLite was technically adequate.** Two of three reports say
SQLite; I side with the minority because only `platform-bar` engaged with the deploy topology, and a
live URL is worth more than any other single artefact. **[JUDGEMENT]** One project-specific argument
neither report made: TrueForge itself already runs SQLite inside the `tforge` container
(`docs/trueforge-verified.md:35`), so choosing SQLite for the app makes the two stores
indistinguishable in the deployment narrative — "our state" and "the harness's state" should not
share a failure mode.

### 4.3 Authentication: three reports, three positions

- `ai-ml-bar` §7: *"Do not add auth… Adding auth invites the question 'protecting what?'"*
- `platform-bar` §7 Tier 3: auth theatre is padding — *unless* the app is publicly deployed with
  mutable state, at which point it becomes Tier 2.
- `security-qa-bar` §5: the product's claim is *"a **named** human approves an irreversible
  action"*, and with no identity the system cannot name anyone — Repudiation and ASI09.

**Resolution: `security-qa-bar` is right about the *product*; the other two are right about the
*login form*.** These are not the same thing. The decision (ADR-008) is **attribution without
authentication** — a hash-chained approval log, an operator identity injected at deploy time and
documented as trusted-from-the-proxy, per-agent identity in the audit trail, and a written
authorization matrix. **Real authentication becomes table stakes at exactly one trigger: a public
deploy where `POST /api/checkpoint/:id/approve` is reachable by strangers.** All three reports agree
on that trigger; they only disagree on whether it will be pulled.

### 4.4 SLSA version

`platform-bar` §1.3 cites v1.0 levels; `security-qa-bar` §2.1 states **v1.0 is retired and v1.2 is
active**. **Resolution: `security-qa-bar`.** Note the wrinkle: GitHub's own attestation docs still
say the feature provides *"SLSA v1.0 Build Level 2"*
(https://docs.github.com/en/actions/concepts/security/artifact-attestations), so the accurate
sentence quotes GitHub's wording and notes the spec has moved. Both reports agree on the important
half: **never claim L3.**

### 4.5 Smaller disagreements, decided in one line each

| Question | Positions | Resolution |
|---|---|---|
| `CONTRIBUTING.md` / `CHANGELOG.md` | `platform-bar` Tier 1 says add; `ai-ml-bar` says *"ceremony"* for a solo repo; `security-qa-bar` lists neither | **Skip both. Add `LICENSE` and `SECURITY.md`, which carry information.** 2-1, and the majority has the better argument. |
| Load testing | `platform-bar` Tier 2 (modest, real numbers); `ai-ml-bar` says don't bother; `frontend-bar` says not before persistence | **Defer. Optional at best.** All three agree it is worthless before persistence. |
| Second React/TS artefact | `frontend-bar` §1.4 recommends it directly; `ai-ml-bar` §7 says a framework migration gains nothing | **No conflict — they are different proposals.** Both agree: do not rewrite Signal Zero. Only `frontend-bar` addressed the recruiter keyword screen, and its asymmetry argument is sound. Build the separate artefact. |
| Kubernetes | `platform-bar` §2.2 says overkill and *"write down the decision"*; `ai-ml-bar` says padding | **Agreement. Refuse it, in writing.** |

---

## 5. The five things that actually gate this project

**[JUDGEMENT]** Everything in §3 rated D or F is fixable. But five items are load-bearing in a way
the rest are not — each either invalidates a claim the project makes, or converts existing strength
into visible strength.

### 5.1 A red critical eval case goes to the core product claim, and it is still open

`B3.2b`: over 40 randomised placements on the real corridor graph, **5 trials put a settlement heard
from six minutes ago into the top ten of a list labelled "ranked by anomalous silence"; worst
observed fresh rank is 4.** Cause, from `rank.js`'s own note: **Gi\* is the primary sort key and Gi\*
is a neighbourhood statistic**, so a still-reporting settlement surrounded by silence is carried up
by its neighbours. The escalation gate is correct and never leaks (`B3.3`); the *ordering* — which is
what the dashboard shows — is not.

`docs/harness-review.md:1148` declines the fix deliberately, because it changes the documented
ranking method and breaks `test/rank.test.js`'s "sorted by Gi* desc" contract. **That was the right
call under time pressure and is the wrong call now.** ADR-011 decides it. **[JUDGEMENT]** A project
whose one-sentence pitch is "ranks the places that stopped talking" and whose own test suite proves
it sometimes ranks a place that is talking cannot ship that sentence unqualified — and fixing it,
with the eval that caught it as the before/after, is a better artefact than the bug never existing.

### 5.2 Nothing runs automatically

195 tests and 155 eval checks that no machine runs are, to a reviewer, tests that might not pass.
Every research report independently ranks this first: `ai-ml-bar` Tier 0 item 1 (*"Highest
signal-per-hour item in this list, by a wide margin"*), `platform-bar` Tier 1 item 6, `frontend-bar`
Tier 0 item 1 (*"Highest leverage item in the project"*), `security-qa-bar` table-stakes item 1
(*"the single largest credibility gap in the repo"*). **Four independent researchers converging on
the same first item is as close to certainty as this exercise produces.**

### 5.3 The store forgets the one thing the product measures

§3.2. And there is a second-order consequence neither report drew out: **[JUDGEMENT]** the Exponential
TBE baseline fits λ from inter-arrival gaps between confirming reports. In an in-memory store those
gaps exist only within one pass's corpus, so the "cohort baseline" the product quotes is fitted to a
window with a maximum life of one process uptime. Persistence does not merely preserve state — **it
is what makes the baseline a baseline.** This is also why ADR-003 must land before ADR-011: a primary
sort key based on a settlement's *own* expected cadence needs a real history to be worth switching to.

### 5.4 Nothing is instrumented, so no claim about behaviour under load is checkable

No traces, no spans, no metrics, no structured logs, no per-stage timing. Consequences that compound:
the 114 s regression has no before/after; the fallback rate is invisible; the guardrail rule that
fired is a log line rather than a span attribute; a failing eval case cannot link to the trace that
produced it. **[RESEARCH]** `ai-ml-bar` §5.3 item 6 frames the last one as the practical realisation
of Husain's *"remove all friction from the process of looking at data"*
(https://hamel.dev/blog/posts/evals/).

**[JUDGEMENT] The extension worth making, which no report made:** `platform-bar` §3.4 observes that
**freshness is simultaneously this pipeline's SLI and its product output**. Push it one step further —
the SRE Workbook's third pipeline SLI is **correctness**, and this project already has a
correctness measurement: `harmWeightedErrorRate`. `A8.1` is therefore already an A/B of a system
component against a correctness SLI that concluded *turn the component off*. Signal Zero has been
doing eval-gated component decisions without calling them that. Naming it is free.

### 5.5 The best material is invisible

`A8.1`. The 48-of-96 unreachable Fellegi–Sunter vectors. The `compaction.trigger` upstream trap. The
kysely `FileMigrationProvider` Windows ESM root cause. The 361 KB payload measurement. The
capability scorecard that corrects itself in both directions. Every one of these is on line 300+ of
a file in `docs/` or `evals/`. **[RESEARCH]** `ai-ml-bar` §6.3 names it exactly: *"Those are its
strongest senior signals and they are currently buried in `docs/`."*

---

## 6. What would be resume padding on a project this size — refused, with reasons

**[JUDGEMENT]** Saying no with a reason is itself the signal being screened for. **[RESEARCH]**
Anthropic's Performance Engineer posting asks candidates to *"Ruthlessly stack-rank a large surface
area of opportunities by impact and effort, and **say no** to the ones that don't make the cut"*
(https://job-boards.greenhouse.io/anthropic/jobs/5224564008).

| Refused | Why it is padding here | When it becomes correct |
|---|---|---|
| Kubernetes / Helm / service mesh | One stateless service. Docker 71.1% vs Kubernetes 28.5% adoption (https://survey.stackoverflow.co/2025/technology). K8s adds a control plane to solve a scheduling problem that does not exist. | Multiple services with independent scaling. |
| Argo Rollouts / canary / progressive delivery | Requires traffic to split across replicas. There is one instance and no production traffic. | Real traffic and a metric to gate promotion. |
| Kafka / Flink / a streaming stack | A queue with one producer and one consumer. | Ingest a single process cannot keep up with. |
| PostGIS | Adjacency is precomputed in `src/data/corridor.json`. There is no spatial *query*. | The moment adjacency is *derived* from geometry — `ST_DWithin`, dynamic radius, polygon containment. |
| TimescaleDB | Plain Postgres with `(settlement_id, observed_at DESC)` answers every query this product asks, for years. | Ingest rate or retention where partitioning is the bottleneck. |
| **The term "event sourcing"** | Append-only ≠ event-sourced. Fowler's own cost/benefit says do not, absent a return (https://martinfowler.com/eaaDev/EventSourcing.html). It is an immutable fact table. | Genuine need to replay *all* state transitions. |
| SLSA L3 claims | Requires build-platform properties not under our control. Both security reports flag it as a catchable overclaim. | Never, on a GitHub-hosted portfolio project. |
| A full TypeScript port | High cost, low marginal signal over `checkJs`, and it churns the two subsystems (statistics, guardrails) that already clear the bar. | A team, or a public API surface with external consumers. |
| A React rewrite of Signal Zero | Discards the measured no-build argument and gains nothing the second artefact does not gain more cheaply. | Never. Build the second artefact instead. |
| Fine-tuning, DPO, GRPO, "RLHF" | Zero application-role postings in a ~2,700-posting sample require it. A toy training run invites exactly the scrutiny it cannot survive. | Never on this project. Say in the README that it was omitted deliberately. |
| More agents, more MCP servers | Breadth is not the axis. Two agents with real jobs beats five in a registry — and the working tree has just made that true. | Never. |
| Contract testing (Pact) | Single deployable, no independent consumers. | Independent services with independent release cycles. |
| **Adding an LLM-as-judge to the eval suite** | **[JUDGEMENT] The sharpest refusal available, and no report made it.** The eval-quality literature (`ai-ml-bar` §2.2) is largely advice for teams whose graders *are* LLMs — validate the judge, report precision and recall separately, avoid uncalibrated Likert scales. Signal Zero's graders are **hand-labelled gold plus deterministic property assertions plus wire-level fault injection**. That is *stronger* than an LLM judge, not weaker. Adding one to tick the box would replace a deterministic grader with a biased one. Adopt Miller's error bars, which apply; refuse the judge, which does not. | A subjective output dimension with no code-checkable ground truth. There isn't one here. |
| `CONTRIBUTING.md` / `CHANGELOG.md` | Ceremony for a solo repo with no contributors. §4.5. | Contributors. |
| Multi-region / HA / DR | No users, no SLA, no irreproducible data. | A real SLA with consequences. |
| HATEOAS / Richardson Level 3 | Six routes, one consumer — this project's own frontend. | A public API with third-party clients. |
| Terraform provisioning nothing | Worse than no Terraform. | A managed database, bucket or DNS record that actually exists. |
| A vector-store security section | There is no vector store. LLM09 does not apply and claiming it is padding. | A vector store. |
| WCAG 3.0 targeting | A Working Draft that says *"It is inappropriate to cite this document as other than a work in progress"* (https://www.w3.org/TR/wcag-3.0/). | Recommendation status. |
| Chasing a coverage percentage | Line coverage measures execution, not assertion. | Never. Report it as a gap-finder; let mutation score carry the argument. |
| Load testing at scale | Meaningless against an in-memory store; the infra family will not be fooled by k6 numbers on a demo dataset. | After persistence, and then only a modest run with honest p50/p95/p99. |

---

## 7. The one-paragraph verdict

**[JUDGEMENT]** Signal Zero is not an ML project and should stop being positioned as one. It is an
**agent-reliability and evaluation-methodology project with unusually real statistical machinery
underneath**, and against the AI/Agent Engineer bar in `ai-ml-bar` §1.1 its substance is already
above the line — the eval suite has published a negative result about its own LLM, the guardrails are
deterministic code with documented limits, and the statistics are honest about which half of the
Fellegi–Sunter model is decoration. Against every other bar it fails on the same axis, and it is a
single axis: **nothing runs automatically, nothing is remembered, and nothing is measured.** The
project cannot be built by a stranger, cannot survive a restart, cannot explain where 114 seconds
went, and claims a licence it does not carry. Fix those and the existing work becomes visible;
rebuild the existing work and the project gets worse.

Next: `docs/ARCHITECTURE-DECISIONS.md` for the decisions, `docs/BUILD-PLAN.md` for the order.
