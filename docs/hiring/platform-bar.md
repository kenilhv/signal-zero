# The Platform Bar (2026)

What backend / platform / infrastructure / SRE / data-engineering hiring actually requires in 2026,
and what Signal Zero must add to clear a senior bar.

**Research date:** 2026-08-30
**Method:** live fetches of primary sources — company career pages, specifications, official docs,
and the Google SRE books. Every factual claim below links to something actually retrieved.

---

## 0. How to read this document

Three labels are used throughout, and they are not interchangeable:

| Label | Meaning |
|---|---|
| **[POSTING]** | A real job posting literally says this. Highest-value evidence — it is what a hiring manager wrote down. |
| **[SOURCE]** | A specification, official doc, or published engineering text states this. Authoritative on *what a thing is*, not on *whether anyone requires it*. |
| **[INFERENCE]** | My own judgement, extrapolated from the above. Argue with it freely. |

### 0.1 Honesty ledger — what I could NOT verify

I am recording these up front so nothing below reads as more certain than it is.

- **Salary bands.** Not researched, not asserted anywhere in this document.
- **Airbnb's own career pages** (`careers.airbnb.com`) returned HTTP 403 to my fetches. The Airbnb
  requirements quoted in §1.4 come from an aggregator mirror (Built In), not from Airbnb's own site.
  Treat as second-hand.
- **Uber, Netflix.** I could not retrieve a live, current posting from either company's own careers
  domain. Netflix aggregator copies I found were marked expired. **I therefore make no claims about
  what Netflix or Uber require.** They are named in the research brief; I am declining to invent
  content for them.
- **Confluent.** `careers.confluent.io` returned HTTP 429 (rate limited) on repeated attempts. No
  Confluent posting is quoted below.
- **Fly.io.** No live engineering posting retrieved. No claims made.
- **"Terraform appears in 4x more job postings than Pulumi."** This number is circulating on several
  SEO blogs. **I could not trace it to any primary source and am not citing it.** §2.4 uses the
  Stack Overflow Developer Survey instead, which is a real, dated, methodologically-described survey.
- **CISA's SBOM page** returned HTTP 403. The SBOM discussion in §1.3 rests on GitHub/npm/SLSA
  primary docs and one posting, not on US federal policy text.
- **Job postings are perishable.** Cloudflare's Greenhouse listings in particular carry explicit
  application deadlines. Links below were live on 2026-08-30 and may 404 later. Several Greenhouse
  URLs I tried had *already* rolled to the board index by the time I fetched them, which is itself a
  reminder that a posting is a snapshot, not a standard.

### 0.2 A caveat about the sample

Job postings are a biased instrument. They are written by recruiters as often as by engineers, they
over-list tools, and they describe the job the company wishes it were hiring for. They are the best
available evidence of hiring intent, but they are not a levelling rubric. Where a posting and an
engineering text disagree, I report the disagreement rather than averaging it.

---

## 1. CI/CD

### 1.1 What postings literally say

The striking finding is **how rarely elite infrastructure postings enumerate a CI/CD toolchain at
all.** They describe operating outcomes instead.

**[POSTING]** Cloudflare, *Systems Engineer, R2 Gateway* — the responsibilities run from design docs
through implementation, testing, deployment, and production monitoring; the engineer participates in
on-call, drives incident resolution, and writes postmortems. Requirements name reliability and
observability practice — monitoring, alerting, performance tuning, incident response.
Kubernetes appears as a thing the service *runs on*, not as a skill bullet.
→ https://job-boards.greenhouse.io/cloudflare/jobs/8155463

**[POSTING]** Cloudflare, *Senior Systems Engineer* (Cloudflare One) — requires 8+ years on complex
production systems, systems-language proficiency (Rust/C/C++/Go), and a track record owning
initiatives from discovery through production including architecture, staged deployment and incident
response. Staged rollouts with monitoring and incident follow-up are called out explicitly.
**This posting does not mention CI/CD, containers, or Kubernetes at all.**
→ https://job-boards.greenhouse.io/cloudflare/jobs/8087792

**[POSTING]** Cloudflare, *Systems Engineer, Spectrum* — lists operational excellence as a named
work area: analytics pipelines, observability, on-call, incident response, and paying down technical
debt in a long-lived production product.
→ https://job-boards.greenhouse.io/cloudflare/jobs/8094826

**[POSTING]** Stripe, *Backend Engineer, Core Technology* — minimum requirements are strong coding
in a systems language, hands-on experience contributing to or building large-scale distributed
systems, collaboration, customer focus, autonomy. Preferred qualifications include optimising
end-to-end performance of distributed systems and holding a high bar when working with production.
**No CI/CD tooling is named.** Stripe states its interview process is language-agnostic.
→ https://stripe.com/careers/listing/backend-engineer-core-technology/6042172

Where toolchains *are* enumerated, it is in explicitly platform-titled roles at smaller companies —
IaC in Terraform/Helm, pipelines in GitHub Actions/ArgoCD, GitOps adoption, observability in
Prometheus/Grafana/Datadog/OpenTelemetry (Vectara, Recorded Future, Koddi, per search result
summaries; **I could not retrieve those individual postings in full — several had already rolled to
the board index — so I cite them as weak evidence only**).

**[INFERENCE]** The pattern is consistent and it matters for how you present this project: at senior
level, **CI/CD is assumed, not asked for.** Nobody asks a senior candidate whether they can write a
GitHub Actions file. They ask whether you have owned something in production through staged rollout
and incident. So a pipeline earns you nothing by existing — its *absence* is disqualifying, and its
*sophistication* is only interesting if it demonstrably protects something real.

### 1.2 Table stakes vs impressive

**[INFERENCE]**, grounded in the sources cited in this section:

**Table stakes — a 2026 pipeline without these looks unserious:**
- Runs on every push and every PR, and the badge is green.
- Installs from a lockfile deterministically (`npm ci`, not `npm install`).
- Runs the test suite. For this project that is the 195 node:test cases.
- Lints and format-checks. Signal Zero currently has neither configured.
- Dependency vulnerability scanning. `npm audit` is free; Dependabot/Renovate is one config file.
- Caches dependencies between runs (`actions/setup-node` with `cache: npm`).
- Fails closed. A red pipeline must block merge.

**Genuinely impressive on a project this size:**
- A **matrix** that earns its place. Node 20 × 24 is defensible — `package.json` declares
  `>=20` but the project is developed on 24, and that gap is exactly what a matrix exists to catch.
  A 12-cell OS × version matrix on a single-service app is theatre.
- Running the **69-file eval suite** in CI as a distinct gate from unit tests, with the JSON report
  published as an artifact. This is the single most differentiating CI thing available to this
  project and almost nobody else's portfolio has an analogue.
- Static analysis wired to a security tab (CodeQL is free for public repos).
- A workflow that verifies the container image actually boots and answers a healthcheck, not just
  that it built.

### 1.3 SLSA, Sigstore, SBOM — the honest answer

The brief asks whether these are in mainstream use or still niche. **The honest answer is: the
tooling is now genuinely mainstream and nearly free, while the hiring demand for it is still niche.
Those two facts are usually conflated and they should not be.**

**The tooling side — mainstream, and closer to a checkbox than most people realise:**

**[SOURCE]** GitHub Actions ships artifact attestations natively. GitHub's docs state that
attestations use Sigstore, and that artifact attestations by themselves provide **SLSA v1.0 Build
Level 2**; Build Level 3 is reachable by using reusable workflows for build isolation.
→ https://docs.github.com/en/actions/concepts/security/artifact-attestations

**[SOURCE]** npm provenance is built on Sigstore's model — an OIDC-federated certificate authority
that issues short-lived signing certificates carrying verifiable build information, plus a
tamper-evident transparency log. npm's docs are also careful to state the limit of the guarantee:
provenance gives a verifiable link to source and build instructions; it does **not** certify the
package is free of malicious code.
→ https://docs.npmjs.com/generating-provenance-statements

**[SOURCE]** SLSA's own level definitions are modest and worth reading before invoking them.
Build L1 is essentially "provenance exists and is distributed." L2 adds a hosted build platform with
a signed provenance tied to that infrastructure. L3 adds hardened isolation between runs and
protection of signing material from user-defined build steps.
→ https://slsa.dev/spec/v1.0/levels

**[INFERENCE]** Consequence: a GitHub-hosted project gets SLSA Build L2 from roughly one workflow
permission and one action step. Claiming L2 is therefore true but cheap. **Claiming "SLSA L3" on a
portfolio project is a red flag** — it requires build-platform properties you do not control, and a
reviewer who knows the spec will read the claim as unearned.

**The hiring side — still niche, and I want to be precise about how niche:**

**[POSTING]** Chainguard — a company **whose entire commercial product is software supply chain
security** — lists a *Software Engineer (Libraries Platform)* whose core requirements are
infrastructure for language ecosystems, Go, developer tooling ownership, CI/CD and IaC, production
debugging. Supply chain security experience (SLSA, SBOMs, sigstore, provenance, attestations)
appears in the **nice-to-have** section.
→ https://job-boards.greenhouse.io/chainguard/jobs/4699210006

**[INFERENCE]** If it is a nice-to-have at Chainguard, it is a nice-to-have almost everywhere. Where
it *is* a hard requirement, the role is titled for it — GitLab's Engineering Manager for Software
Supply Chain Security, MX's Senior Information Security Engineer (both surfaced in search; **full
text not retrieved, cited as weak evidence**). Supply-chain security is a *specialisation* in 2026,
not a general backend expectation.

**One factual correction worth carrying, because getting it wrong signals shallowness:**

**[SOURCE]** **Sigstore is an OpenSSF project, not a CNCF project.** It does not appear in the CNCF
graduated or incubating lists. People say "CNCF Sigstore" constantly and it is wrong.
→ https://openssf.org/projects/sigstore/ and https://www.cncf.io/projects/

**Verdict for Signal Zero:** generate an SBOM and enable build provenance, because on GitHub both
are nearly free and the failure mode of *not* doing it is that a security-minded reviewer notices.
But do not build a section of the README around it, and do not claim a SLSA level above L2.
It is a differentiator, not table stakes, and a small one.

### 1.4 Preview environments and progressive delivery

**[SOURCE]** Argo Rollouts is a Kubernetes controller providing blue-green, canary, canary analysis
and experimentation, integrating with metric providers (Prometheus, Datadog, New Relic, Graphite,
InfluxDB, Wavefront, Kayenta and others) and with ingress controllers and service meshes to shape
traffic and automatically promote or roll back based on KPI analysis.
→ https://argo-rollouts.readthedocs.io/en/stable/

**[SOURCE]** Argo is a CNCF **graduated** project. → https://www.cncf.io/projects/

**[POSTING]** Airbnb, *Senior Data Engineer, Infrastructure* — requirements include distributed
processing (Spark, Kafka, Flink, Hadoop), warehousing and database breadth (PostgreSQL, MySQL,
Redshift, BigQuery, ClickHouse), scalable ETL with schedulers (Airflow, Luigi, Oozie, AWS Glue), and
familiarity with Kubernetes, Docker and modern infrastructure tooling; 5+ years, or 2+ with a PhD.
*(Retrieved from the Built In aggregator mirror, not Airbnb's own site, which blocked me.)*
→ https://builtin.com/job/senior-data-engineer-infrastructure/6835799

**[INFERENCE]** **Progressive delivery is resume-padding on a single-service project.** Canary
analysis is a mechanism for splitting traffic across replicas of a service that has traffic. Signal
Zero has one service and no production traffic. Building Argo Rollouts config here would demonstrate
that you can copy a tutorial, and a senior reviewer will read it as judgement failure, not skill.
Preview environments per-PR are more defensible — they are cheap on a PaaS and they make the demo
reviewable — but they are still a differentiator, not a requirement.

---

## 2. Containerisation, deploy, and IaC

### 2.1 What the container should look like

**[SOURCE]** Docker's official best-practice guidance: multi-stage builds separate build from final
output and reduce final image size; use `USER` to drop privileges when a service can run without
them, creating users with explicit UID/GID; order instructions so layer caching works; use
`.dockerignore`; and pin base images by digest alongside the tag so a republished tag cannot silently
change what you ship.
→ https://docs.docker.com/build/building/best-practices/

**[SOURCE]** Distroless images contain the application and its runtime dependencies and deliberately
omit package managers and shells. The project's stated rationale is that a smaller runtime surface
improves the signal-to-noise ratio of CVE scanners and reduces the provenance burden. `nonroot`
tagged variants are published.
→ https://github.com/GoogleContainerTools/distroless

**[SOURCE]** The Twelve-Factor App: config in the environment; backing services as attached
resources; the app as stateless processes; **disposability — fast startup and graceful shutdown**;
logs as event streams; dev/prod parity.
→ https://12factor.net/

**[INFERENCE]** For Signal Zero specifically, the Dockerfile checklist is:

1. Multi-stage: builder installs with `npm ci`, runtime stage copies only production `node_modules`
   and `src/`, `web/`, `evals/`.
2. Pin the base by digest. `node:24-slim@sha256:...` is fine; distroless `nodejs24` is a small extra
   flourish, at the cost of losing a shell for debugging — which on a project a reviewer may want to
   `docker exec` into is a real trade-off, not a free win. **Slim + non-root is the defensible
   default; distroless is the differentiator.**
3. `USER node` (the official Node images already ship a `node` user, UID 1000) — do not invent one.
4. `HEALTHCHECK` hitting the existing `GET /api/health` route (`src/server.js:508`).
5. `.dockerignore` excluding `node_modules`, `.git`, `.env`. **Signal Zero currently has no
   `.dockerignore` and has a committed-adjacent `.env` in the working tree — shipping that into an
   image would be a real secret leak, not a hypothetical one.**
6. Graceful shutdown: trap `SIGTERM`, stop accepting connections, let the in-flight pipeline pass
   finish or abort cleanly. This is 12-factor disposability and it is currently absent. It also
   interacts directly with the 114s pipeline problem in §5 — a 114-second unit of work with no
   cancellation path is *why* shutdown is hard here.

Reproducibility, honestly: `npm ci` against a committed lockfile plus a digest-pinned base gets you
*deterministic* builds in the sense a reviewer cares about. **Bit-for-bit reproducible builds are a
different and much harder claim — do not make it.**

### 2.2 Is Kubernetes expected, or does it read as overkill?

**Verdict: on a single-service portfolio project, Kubernetes reads as overkill, and worse than
overkill — it reads as a candidate who cannot size a solution to a problem.** I hold this with
reasonable confidence and here is the evidence.

**[SOURCE]** Stack Overflow Developer Survey 2025, technology section: **Docker 71.1%**,
**Kubernetes 28.5%**, **Terraform 17.8%** among all respondents (databases section n=26,083;
cloud platforms n=24,473).
→ https://survey.stackoverflow.co/2025/technology

That gap is the whole argument. Containerisation is a majority practice. Orchestration is a minority
practice, concentrated in organisations that have many services to orchestrate.

**[POSTING]** Corroborating from the postings themselves: Cloudflare's *Senior Systems Engineer*
posting — an 8+ years, deeply infrastructural role — **never mentions Kubernetes**
(https://job-boards.greenhouse.io/cloudflare/jobs/8087792). Cloudflare's *R2 Gateway* posting
mentions it as a platform the service runs on
(https://job-boards.greenhouse.io/cloudflare/jobs/8155463). Airbnb's data infrastructure posting
lists it as "familiarity with"
(https://builtin.com/job/senior-data-engineer-infrastructure/6835799). Datadog's *Staff Engineer,
Data Platform Experience* lists Kubernetes alongside Kafka as distributed infrastructure experience
(https://careers.datadoghq.com/detail/8119496/). In none of these is Kubernetes the skill being
hired for — it is context.

**Where sources point the other way:** platform-titled roles at smaller companies *do* enumerate
Kubernetes/ArgoCD/Helm as hard requirements (Recorded Future, Koddi, Vectara — search-result
summaries, full text not retrieved). **[INFERENCE]** If you are specifically targeting roles titled
"Platform Engineer" or "DevOps Engineer" rather than backend/SRE, Kubernetes literacy moves from
optional to expected. The honest framing is: **Kubernetes is a requirement of a job family, not of
seniority.** Decide which family you are applying to.

**[INFERENCE]** The strongest move for Signal Zero is not to add Kubernetes and not to ignore it. It
is to **write down the decision.** A short ADR that says "single stateless service plus one database;
Kubernetes would add a control plane, an ingress, and a cluster bill to solve a scheduling problem I
do not have; here is the threshold at which I would migrate" demonstrates exactly the judgement the
senior postings are actually screening for. A reviewer who wanted K8s will respect the reasoning far
more than a copied Helm chart.

### 2.3 What IaC is actually expected for a portfolio project

**[INFERENCE]**, with the survey data above as support. Ranked by credibility-per-unit-effort:

1. **A committed `docker-compose.yml`** that brings up app + Postgres with one command. This is the
   highest-value single artefact in this whole section, because it is what a reviewer will actually
   run. If `git clone && docker compose up` does not produce a working dashboard, nothing else in
   the repo gets evaluated.
2. **A real deploy that a stranger can visit.** A live URL is worth more than any amount of
   infrastructure code. Fly.io / Render / Railway with a committed config file (`fly.toml`,
   `render.yaml`) is proportionate.
3. **Terraform, only if the deploy target genuinely has managed resources** — a database, a bucket,
   DNS. At 17.8% survey usage it is a recognised skill and worth demonstrating *once*, but
   Terraform that provisions nothing real is worse than no Terraform.
4. **Pulumi** — no evidence gathered that it is expected. Terraform has the larger installed base in
   the one survey I trust. If you know Pulumi, use it; do not learn it for this.

**Plain compose is not a cop-out at this size.** It is the correct tool, and a reviewer who is senior
enough to matter knows that.

---

## 3. Persistence and data

The current state, verified by reading the code rather than trusting the brief:
`src/store.js` is a single exported object of arrays — `reports`, `clusters`, `settlements`,
`ranked`, `checkpoint`, `incidents`, `sources`, `harness`, `stats` — with a 200-item incident ring
buffer. Its own header comment states there is no database. Everything is rebuilt by a pipeline run
except incidents and checkpoint decisions, and those are lost on restart too.

**[INFERENCE]** This is the single most disqualifying gap in the project, and it is worse than
"no persistence" in the abstract, for a domain-specific reason developed in §3.4: **the product
measures elapsed time since last observation. A store that forgets on restart cannot measure elapsed
time across a restart. The persistence gap is not an infrastructure omission — it invalidates the
core metric.** That framing is also, conveniently, the most senior-sounding way to describe the fix.

### 3.1 Postgres vs SQLite

**[SOURCE]** SQLite's own guidance is unusually direct. Its checklist: is the data separated from
the application by a network → client/server. Many concurrent writers → client/server. Big data →
client/server. Otherwise → SQLite. It states SQLite permits only one writer at any instant, and that
for device-local storage with low writer concurrency it is usually the better choice.
→ https://www.sqlite.org/whentouse.html

**[SOURCE]** Stack Overflow 2025: PostgreSQL 55.6%, SQLite 37.5%.
→ https://survey.stackoverflow.co/2025/technology

**Verdict — and I want to be genuinely even-handed here, because the reflex answer is wrong:**

By SQLite's own checklist, **Signal Zero qualifies for SQLite.** One process, one writer (the
pipeline pass), no network separation, data volume measured in thousands of rows. If the only
question were engineering fit, SQLite with WAL mode would be the right call and a defensible one.

**[INFERENCE]** But there are two reasons to choose Postgres anyway, and they are not
cargo-culting:

1. **Deploy topology.** The moment the app runs in a container on an ephemeral filesystem — which is
   what every PaaS gives you — SQLite needs a persistent volume, and you are now managing storage
   attachment. Postgres-as-attached-service is the 12-factor answer
   (https://12factor.net/) and is one line of compose.
2. **Hiring signal, stated plainly as such.** Postgres is the majority database, it is what the
   postings name (Airbnb lists PostgreSQL first among warehousing/database systems —
   https://builtin.com/job/senior-data-engineer-infrastructure/6835799; Railway asks for deep
   Postgres and relational-modelling expertise — https://railway.com/careers/scalability), and this
   project's purpose is to get its author hired.

**Recommendation: Postgres.** But say in the ADR that SQLite was considered and why it lost — the
reasoning is what demonstrates seniority, and a reviewer who reads "SQLite would have been
technically adequate; I chose Postgres for deploy topology and ecosystem" will rate that above
someone who never considered it.

### 3.2 Migrations tooling

**[POSTING]** Railway's *Senior Product Engineer: Scalability* asks for deep Postgres and relational
data modelling expertise, and for Node.js internals — the event loop, memory behaviour, and what to
do when a service degrades under load. → https://railway.com/careers/scalability

**[INFERENCE]** No posting I retrieved names a specific Node migration tool. What is actually being
screened is whether schema changes are versioned, ordered, reviewable and applied by an automated
step rather than by hand. Any of `node-pg-migrate`, Umzug, Drizzle, or plain numbered SQL files with
a tiny runner clears that bar.

One project-specific note with real evidence behind it: this repo has already **root-caused a
Windows ESM crash in TrueForge to kysely's `FileMigrationProvider`**
(`docs/trueforge-windows-bug.md`). That is a genuine, documented, upstream finding about a migration
library. **[INFERENCE]** Choosing a different tool and citing that investigation as the reason is a
much stronger story than choosing a tool at random — it converts a debugging war story into an
architectural decision, which is exactly the shape of a senior narrative.

### 3.3 Is PostGIS worth it, or overkill?

**[SOURCE]** PostGIS extends PostgreSQL with storage, indexing and querying of geospatial data:
2D/3D geometry types, spatial indexing to retrieve data by location, measurement functions
(distance, area), geometric operations (intersection, buffer), processing (union, simplification),
raster support, and geocoding.
→ https://postgis.net/

**Verdict: overkill for what Signal Zero currently computes. Worth it only if a specific feature
lands.**

**[INFERENCE]** The reasoning is about what the statistics layer actually does. Getis-Ord Gi* here
runs over a **precomputed river-corridor adjacency graph** — `src/data/corridor.json`, a fixed
artefact. The spatial relationship has already been decided offline and reduced to graph edges.
PostGIS earns its place when you need the database to *answer* spatial questions: nearest-neighbour
lookups, dynamic radius queries, polygon containment, on-the-fly adjacency from geometry. Signal Zero
asks none of those. Adding PostGIS to store two float columns and a static edge list is a dependency
with no query behind it, and a reviewer who knows PostGIS will ask what you are using it *for*.

**The honest exception:** if the corridor graph ever becomes *derived* rather than committed — "which
settlements lie within N km of the flood polygon", "recompute adjacency when the river course
changes" — PostGIS becomes correct immediately, and `ST_DWithin` with a GiST index is the right
answer. **[INFERENCE]** Say this in the ADR. "PostGIS is not warranted while adjacency is
precomputed; it becomes warranted the moment adjacency is derived" is a sharper signal than either
adopting it or ignoring it.

### 3.4 Time-series or event-sourced? The strongest argument in this document

The brief asks me to argue this. Here is the argument, and I think it is the most important design
insight available to this project.

**[SOURCE]** The Google SRE Workbook's chapter on implementing SLOs identifies three SLI categories
specifically for **data processing pipelines**:
- **Freshness** — the proportion of data updated more recently than a threshold.
- **Correctness** — the proportion of records entering the pipeline that produced the correct output.
- **Coverage** — for batch, the proportion of jobs meeting a processing target; for streaming, the
  proportion of records successfully processed in a window.

→ https://sre.google/workbook/implementing-slos/

**[INFERENCE] Read those three next to Signal Zero's product thesis.** The product ranks settlements
by how anomalously long they have gone without a confirming report. **Freshness is not an operational
metric for this system. Freshness *is* the output.** The pipeline's SLI and the product's core
computation are the same quantity measured at different layers. I have not seen another portfolio
project where that alignment exists, and it is the thing to build the observability and reliability
story around (§4, §5).

Now the modelling question, in three separable parts, because they are routinely conflated:

**(a) Should the store be append-only? Yes, unambiguously.**
The domain is *time between events*. The current design destroys history: `store.reports` is
rebuilt each pass. An Exponential time-between-events model with a per-cohort Gamma prior — which
`src/pipeline/rank.js` already implements — needs the historical inter-arrival record to be
meaningful, and right now that record has a maximum lifetime of one process uptime. The fix is an
append-only `observations` table: `(settlement_id, observed_at, source, report_id, ingested_at)`,
never updated, never deleted, with the ranked view derived from it. This is table stakes, and it is
the persistence fix from §3 stated precisely.

**(b) Is this *event sourcing* in the technical sense? No — and do not claim it is.**
**[SOURCE]** Fowler defines Event Sourcing as capturing all changes to application state as a
sequence of events, with the benefits of full rebuild, temporal query and replay. He is equally clear
about the costs: packaging every change as an event is an interface style not everyone is
comfortable with; integrating with external systems that do not work this way is one of the tricky
parts; and code evolution over a long event log is genuinely hard. He notes it is not a natural
choice and you should expect a return for it. He explicitly suggests that if you only want audit,
simpler logging may suffice.
→ https://martinfowler.com/eaaDev/EventSourcing.html

**[INFERENCE]** An append-only observations log is **not** event sourcing — it is an immutable fact
table. Event sourcing would mean every state transition in the system (checkpoint approvals,
guardrail verdicts, agent turns) becomes an event and all state is a fold over that log. Signal Zero
does not need that, and the honest reason is Fowler's own: there is no return that justifies the
interface cost. Calling an append-only table "event-sourced" on a resume is the kind of overclaim
that collapses under one follow-up question in an interview. **Verdict: append-only, yes. Event
sourcing, no. Do not use the term.**

**(c) Is a time-series database warranted? Not yet, and probably not ever at this size.**
**[SOURCE]** A TimescaleDB hypertable is a PostgreSQL table that automatically partitions by time
(and optionally other dimensions) into chunks, auto-creates a descending time index, and targets
time-series and event data with near-zero-latency analytical queries.
→ https://www.tigerdata.com/docs/use-timescale/latest/hypertables

**[INFERENCE]** Hypertables solve a problem that begins at chunk-crossing scale — high-rate ingest
where full-table scans and index maintenance become the bottleneck. Signal Zero ingests reports
about settlements in three districts. A plain Postgres table with a B-tree on
`(settlement_id, observed_at DESC)` will answer every query this product asks, instantly, for years.
**Timescale here is resume-padding.** The correct thing to write in the ADR is the threshold: "plain
Postgres until ingest rate or retention makes partitioning necessary; Timescale at that point."
Knowing *when* a tool becomes correct is the senior signal — reaching for it early is the junior one.

---

## 4. Observability

### 4.1 The real OpenTelemetry story in 2026

**[SOURCE] OpenTelemetry graduated from the CNCF on 21 May 2026**, announced at the Observability
Summit in Minneapolis. The announcement cites over 12,000 contributors from more than 2,800
companies; 1.36 billion downloads of the JavaScript API package and 1.3 billion of the Python API
package, both setting monthly records in April 2026; and the second-highest project velocity of
CNCF's 240+ projects, after Kubernetes. It also notes Profiles is in alpha and an independent
security audit was completed for graduation.
→ https://www.cncf.io/announcements/2026/05/21/cloud-native-computing-foundation-announces-opentelemetrys-graduation-solidifying-status-as-the-de-facto-observability-standard/

**A source disagreement, reported rather than smoothed over:** the CNCF's own
`cncf.io/projects` listing page still showed OpenTelemetry under *incubating* when I fetched it on
2026-08-30 (https://www.cncf.io/projects/). The dated graduation announcement is the authoritative
record; the listing page appears not to have been updated. Prometheus and Argo are listed as
graduated on that same page.

**The critical caveat for this project, and it is the one most people get wrong:**

**[SOURCE]** OpenTelemetry signal maturity is **per-language, and not uniform.** For
**JavaScript/Node**: **Traces — Stable. Metrics — Stable. Logs — Development.**
→ https://opentelemetry.io/docs/languages/js/ and https://opentelemetry.io/status/

**[INFERENCE]** So the correct 2026 Node posture — and saying this precisely is itself a
differentiator, because it shows you read the status page instead of the marketing — is:

- **Traces via OTel: yes, now.** Stable in JS. `@opentelemetry/sdk-node` with auto-instrumentation
  for `http` and `express` is a small change.
- **Metrics via OTel: yes.** Stable in JS. Export via the Prometheus exporter so a Grafana stack can
  scrape it.
- **Logs via OTel: not yet.** Development status in JS. **Keep winston.** The right intermediate
  move is to emit structured JSON logs carrying `trace_id` and `span_id` so logs correlate with
  traces, then adopt the OTel logs SDK when it stabilises. A reviewer who knows the status matrix
  will recognise this as a correct call; one who does not will not penalise it.

**[SOURCE]** Semantic conventions are the standardised naming scheme for telemetry attributes across
traces, metrics, logs, profiles and resources
(https://opentelemetry.io/docs/concepts/semantic-conventions/). **HTTP span conventions are marked
Stable**, with required attributes including `http.request.method`, `url.path`, `url.scheme` for
server spans, `server.address`, `server.port`, `url.full` for client spans, and
`http.response.status_code` conditionally required.
→ https://opentelemetry.io/docs/specs/semconv/http/http-spans/

**[INFERENCE]** Use the stable conventions verbatim for the HTTP layer. For pipeline-internal spans
there is no convention to follow — invent a consistent namespace (`signalzero.stage`,
`signalzero.settlement_id`) and document it. Inventing attribute names *where a stable convention
already exists* is the mistake; inventing them where none exists is just naming.

### 4.2 RED and USE

**[SOURCE] USE** — Brendan Gregg: for every resource, check **Utilization** (average time the
resource was busy servicing work), **Saturation** (the degree to which the resource has extra work it
cannot service, often queued), and **Errors** (count of error events). Intended for early
bottleneck identification across system resources.
→ https://www.brendangregg.com/usemethod.html

**[SOURCE] RED** — Tom Wilkie, 2015: for every service, monitor **Rate** (requests per second),
**Errors** (failing requests), **Duration** (time taken). Wilkie created it because USE applies to
hardware and resources rather than services. Grafana's write-up frames the pair as RED caring about
users' happiness and USE about machines'. It also notes Google's Four Golden Signals — Latency,
Traffic, Errors, Saturation — covers similar ground, matching RED plus saturation.
→ https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/

### 4.3 What a reviewer would expect instrumented on *this* data pipeline

**[INFERENCE]**, built from the SRE Workbook pipeline SLIs (§3.4) plus RED/USE:

**RED on the HTTP surface** — the six routes in `src/server.js`: `/api/health`, `/api/state`,
`/api/run`, `/api/checkpoint/:id/approve|reject`, `/api/settlement/:id`. Rate, error rate, and
latency **as a histogram, not an average** — you need p50/p95/p99, and §5 explains why that is not
optional here.

**RED-analogous on each pipeline stage** — the fixed order is
ingest → triage → dedup → rank → checkpoint → failfeed. Per stage: invocations, failures, duration
histogram. This is the instrumentation that would have made the 37s → 114s regression a graph
instead of a mystery, and that is the sentence to put in the README.

**USE on the constrained resources** — for a Node service the meaningful saturation signals are
event-loop lag (`perf_hooks.monitorEventLoopDelay`), heap used vs limit, and the depth of any
in-flight work queue. **[POSTING]** Railway asks literally for Node.js internals — event loop, memory
behaviour, and what to do when a service degrades under load
(https://railway.com/careers/scalability). Event-loop lag is the single metric that answers that
question, and exporting it is a direct, demonstrable match to a real posting requirement.

**Pipeline SLIs from the Workbook, which is where this project can be exceptional:**
- **Freshness** — max and p95 age of the newest observation per settlement. *This is the product.*
- **Coverage** — proportion of gazetteer settlements with any observation in the last N hours;
  proportion of ingested reports that survived to a ranking.
- **Correctness** — the 69-file eval suite already measures this. Export the golden-set
  classification pass rate as a gauge and it becomes a live SLI rather than a CI artefact.

**Domain counters that make the guardrails legible:** guardrail blocks by rule (the repo has an
observed real block on `injection.invisible-characters`), incidents by kind (`degraded-source`,
`llm-fallback`, `cold-start`, `heal`, `agent-refusal` — already enumerated in `src/store.js`),
harness turns, tokens, and cache-read ratio (32,032 of 33,242 input tokens cached is a genuinely
good number and currently invisible to any dashboard).

**[SOURCE]** Prometheus is a CNCF graduated project (https://www.cncf.io/projects/). **[INFERENCE]**
A `/metrics` endpoint plus a committed Grafana dashboard JSON plus a compose profile that brings up
Prometheus and Grafana is the proportionate deliverable. **A committed, screenshotted dashboard is
worth more than twice as many metrics with no dashboard** — reviewers look at pictures.

---

## 5. Reliability engineering

### 5.1 SLOs and error budgets

**[SOURCE]** SRE Book definitions: an **SLI** is a carefully defined quantitative measure of some
aspect of the level of service provided; an **SLO** is a target value or range for a service level
measured by an SLI; an **SLA** is an explicit or implicit contract with users that includes
consequences for meeting or missing the SLOs it contains. The book advises choosing indicators by
starting from what users need; warns against setting a target by simply adopting current performance,
which risks locking in an unsustainable support burden; favours simple aggregations; and advises
keeping the number of SLOs to the minimum that covers the system.
→ https://sre.google/sre-book/service-level-objectives/

**[SOURCE]** SRE Workbook: an SLI is best expressed as the ratio of good events to total events; the
**error budget** is the complement of the SLO target (a 99.9% SLO yields a 0.1% budget).
→ https://sre.google/workbook/implementing-slos/

**[SOURCE]** Alerting: **burn rate** measures how fast, relative to the SLO, the service consumes its
error budget. Alerting on raw error thresholds has poor precision — the Workbook's worked example
shows you could receive up to 144 alerts a day, act on none, and still meet the SLO. The recommended
approach is multiwindow, multi-burn-rate: for a 99.9% SLO, page at 14.4× burn over 1h (with a 5m
short window, 2% of budget), page at 6× over 6h (30m short window, 5%), ticket at 1× over 3d (6h
short window, 10%).
→ https://sre.google/workbook/alerting-on-slos/

**[INFERENCE]** Signal Zero should declare **two or three SLOs and no more** — the book's own advice.
Candidates: pipeline pass completion (coverage), observation freshness (the product metric), and
`/api/state` availability/latency. Publishing an SLO you then measure and miss honestly, with the
burn shown on a dashboard, is far stronger than publishing three you never evaluate.

### 5.2 The 114-second pipeline and the 15-second timeout

This is the most instructive problem in the repo, and how it is handled is a direct seniority test.

**Verified facts, from reading the code and the brief:**
- `src/config.js:63` — `TRUEFORGE_TIMEOUT_MS` defaults to `15000`.
- `src/harness/trueforge.js:378` passes `timeoutInSeconds: Math.ceil(TRUEFORGE_TIMEOUT_MS / 1000)`.
- A full pipeline pass takes **114s**, up from **37s** — a ~3× regression.
- A tier-3 turn exceeds 15,000 ms, the timeout fires, and the system falls back.
- The pipeline runs on boot and on `POST /api/run`, and stage failures are caught and written to the
  incident feed rather than killing the process.

**What the discipline says — and it says the opposite of "raise the timeout":**

**[SOURCE]** Google's SRE Book chapter on cascading failures warns that setting no deadline or an
extremely high deadline can let short-term problems that have long since passed continue consuming
server resources until restart, and specifically cautions against deadlines several orders of
magnitude longer than mean request latency. It advises always using randomised exponential backoff
when scheduling retries; limiting retries per request; using service-wide retry budgets; and avoiding
retry amplification across layers — its example shows three layers each retrying producing 64
attempts at the database. On overload it recommends failing early and cheaply, returning 503 above an
in-flight-request threshold, degrading gracefully by reducing work (for example serving cached rather
than full results), and keeping queues short relative to thread pools — 50% or less — so requests are
rejected early rather than queuing and draining resources.
→ https://sre.google/sre-book/addressing-cascading-failures/

**[INFERENCE] The disciplined sequence, in order, and each step is refusable-at:**

1. **Do not touch the timeout yet.** The timeout is a *detector*. Raising it before diagnosis
   destroys the only signal you have and converts a fast, visible failure into a slow, invisible one.
   Write this sentence in the README; it is the whole lesson.

2. **Measure the distribution, not the mean.** 114s is an aggregate over
   ingest→triage→dedup→rank→checkpoint. Instrument per-stage duration histograms (§4.3) and find out
   *which* stage moved. A 3× regression is almost always one thing, not five things each 3× slower.
   **[INFERENCE]** Given `docs/trueforge-verified.md` documents a tier-3 model latency trap, the
   prior strongly favours triage tier 3 — but that is a hypothesis to confirm with data, not a
   conclusion. Confirming it with a graph is the deliverable.

3. **Separate the two numbers.** The 15s per-turn timeout and the 114s whole-pass duration are
   different quantities and may have nothing to do with each other. A per-turn timeout firing is
   consistent with *either* a genuinely slower model *or* an unchanged model plus more turns. Count
   turns. The repo already captures per-turn telemetry — token counts, cache reads, latency — so this
   data may already exist and merely be unaggregated.

4. **Set the timeout from measured latency, not from a round number.** The Workbook's discipline is
   percentile-driven: pick a deadline above the p99 of *healthy* turns, not above the worst observed.
   15,000 ms was chosen before there was data. Whatever replaces it should cite a percentile.

5. **Distinguish "slow" from "hung."** If a tier-3 turn legitimately needs more than 15s, the
   architecture is wrong, not the constant: a 114-second synchronous unit of work should not be
   inside an HTTP request at all. `POST /api/run` returning 202 with a run id, and the pass
   proceeding asynchronously with progress on `/api/state`, is the structural fix. This also
   resolves the graceful-shutdown problem from §2.1.

6. **Fall back deliberately, and count it.** The project already degrades to a fallback classifier
   and writes an `llm-fallback` incident — that is genuinely good and is already the graceful
   degradation the SRE book describes. Make it a *metric* so the fallback rate is visible, and make
   the UI state plainly that a result came from the fallback. Silent degradation is the failure mode;
   counted degradation is the feature.

7. **Only then, if at all, adjust the timeout** — and record why, with the percentile that justified
   it.

**[INFERENCE]** The narrative value here is enormous and mostly unclaimed. "I found a 3× regression,
resisted raising the timeout, instrumented per-stage latency, isolated it to tier-3 turn count, and
moved the long pass off the request path" is a senior story with a measurement in the middle. "I
raised the timeout to 30s" is the answer that ends an interview.

### 5.3 Retries, jitter, backpressure, circuit breakers, idempotency

**[SOURCE]** AWS on backoff and jitter: their simulation under high contention found exponential
backoff *without* jitter to be the clear loser on both work performed and completion time; **Full
Jitter** — `sleep = random(0, min(cap, base * 2^attempt))` — produced the lowest client work,
roughly halving call counts versus unjittered backoff; Equal Jitter performed worse than Full Jitter;
Decorrelated Jitter took more work but slightly less time. They conclude jittered backoff should be
considered a standard approach for remote clients.
→ https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/

*(Note: the AWS Builders' Library article on timeouts/retries/backoff has been relocated to
`builder.aws.com` and returned no article body to my fetch; I am citing only the AWS Architecture
Blog post, which I did retrieve.)*

**[INFERENCE]** Concretely for Signal Zero: outbound calls to Bright Data and to the TrueForge
harness should retry with **full jitter**, with a **capped attempt count**, and — per the SRE book's
retry-amplification warning — **retry at exactly one layer.** If `trueforge.js` retries and the
pipeline stage also retries, you have built the 4³ problem on purpose.

**Backpressure and load shedding.** **[INFERENCE]** `POST /api/run` currently accepts a request that
triggers a 114-second pass. Concurrent invocations would stack. The proportionate fix is a single-
flight guard — if a pass is already running, return 409 (or 202 with the in-flight run id) rather
than starting a second — which is the SRE book's "fail early and cheaply" at the scale of this app.

**Circuit breakers.** **[INFERENCE]** A breaker around the harness call is defensible and cheap:
after N consecutive tier-3 timeouts, stop calling for a cooldown and use the fallback directly. Given
the timeout is *already* firing in the current build, this is a real fix for an observed problem, not
a hypothetical. **[SOURCE]** It is also exactly the "reduce the amount of work performed" degradation
the SRE book recommends (https://sre.google/sre-book/addressing-cascading-failures/).

**Idempotency.** See §6.3 — it belongs with the API contract.

---

## 6. API design

### 6.1 OpenAPI-first

**[SOURCE]** The current OpenAPI Specification is **v3.2.0, released 19 September 2025**. It
describes a language-agnostic interface description for HTTP APIs allowing humans and machines to
understand a service's capabilities without access to source. Schema Objects embed JSON Schema;
3.2.0 references JSON Schema Draft 2020-12 for reference resolution (`$id`, `$anchor`,
`$dynamicAnchor`). Backward compatibility is maintained within the 3.x line.
→ https://spec.openapis.org/oas/latest.html

**[INFERENCE]** Signal Zero has six JSON routes and no schema document. An `openapi.yaml` describing
them is perhaps an hour of work and produces disproportionate return: it is the artefact that makes
the API reviewable without reading `src/server.js`, it enables generated docs, and it can be
**validated in CI** — which converts it from documentation into a test. Whether you author it by hand
(true "OpenAPI-first") or generate it from route definitions matters far less than whether it exists
and is checked. 3.1+ is what to target; do not emit 3.0 in 2026.

### 6.2 Error envelopes

**[SOURCE]** **RFC 9457, Problem Details for HTTP APIs** (July 2023) obsoletes RFC 7807. It defines
a machine-readable error object served as `application/problem+json` with members: `type` (a URI
reference identifying the problem type), `status` (the HTTP status code), `title` (short
human-readable summary of the type), `detail` (human-readable explanation of this occurrence), and
`instance` (URI reference identifying this specific occurrence). An XML equivalent
(`application/problem+xml`) is also defined.
→ https://www.rfc-editor.org/rfc/rfc9457.html

**[INFERENCE]** This is the cheapest credibility win in the entire API section. The repo already has
a `CheckpointError` type and a global error handler at `src/server.js:690` — routing every error
response through an RFC 9457 shape is a contained change with a citable standard behind it.
**Adopting 9457 and citing it by number also quietly signals you know 7807 is superseded**, which is
a small but real discriminator.

### 6.3 Idempotency keys — with an honest standards caveat

**[SOURCE]** Stripe's implementation, which is the de facto reference: clients send an
`Idempotency-Key` header on POST requests. Stripe saves the status code and body of the first request
for a given key regardless of success or failure, and subsequent requests with that key return the
same result — including 500s. Stripe suggests V4 UUIDs or another random string with sufficient
entropy, permits keys up to 255 characters, and advises against using sensitive data as keys. Keys
may be pruned after at least 24 hours. Incoming parameters are compared against the original request
and a mismatch errors, to prevent accidental misuse. Results are only saved once endpoint execution
begins, so requests failing validation or conflicting with a concurrent request can be retried.
GET and DELETE are idempotent by definition and should not carry the header.
→ https://docs.stripe.com/api/idempotent_requests

**[SOURCE] The honest caveat, which most write-ups omit:** the IETF `Idempotency-Key` header draft
(`draft-ietf-httpapi-idempotency-key-header`, HTTPAPI working group) is **expired and archived** —
latest revision 07, dated 2025-10-15, IESG state *Expired*, intended RFC status *(None)*. **It is not
an RFC.** → https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/

**[INFERENCE]** So the correct framing is: idempotency keys are an **industry convention led by
Stripe**, not a ratified standard. Implement Stripe's semantics and say so. Describing it as
"RFC-compliant" would be wrong, and being the candidate who knows the draft expired is a genuine
signal of source-reading.

**Where it applies here:** `POST /api/run` and the two checkpoint decision routes
(`/api/checkpoint/:id/approve|reject`). A double-clicked approve on a human-in-the-loop safety
control is a *correctness* bug in a system whose entire premise is auditable human judgement, not a
theoretical concern. **[POSTING]** Railway's posting asks specifically for knowledge of idempotency,
retries, reconciliation and their failure modes, and for payment flows correct under concurrency and
partial failure (https://railway.com/careers/scalability) — this is a directly matching requirement.

### 6.4 Versioning, pagination, REST maturity

**[INFERENCE]**, as no posting I retrieved specified any of these:

- **Versioning.** `/api/v1/...` costs nothing now and is expensive to retrofit. Do it. Header or
  date-based versioning (Stripe's model) is more sophisticated and unnecessary here — choosing the
  simple option deliberately and saying why is the better signal.
- **Pagination.** Only `/api/state` plausibly grows unbounded, and only in `incidents`, which is
  already capped at 200 (`src/store.js`). **Once persistence lands, that ring buffer disappears and
  the incident feed becomes genuinely unbounded — pagination becomes required at exactly that
  moment.** Cursor-based beats offset-based on an append-only table, which is another small
  consequence of the §3.4 design falling out correctly.
- **REST maturity / HATEOAS.** No posting I retrieved mentioned Richardson maturity or hypermedia.
  **Level 2 — proper resources, proper verbs, proper status codes — is the practical bar.**
  Pursuing Level 3 hypermedia on a six-route internal API is resume-padding.

---

## 7. Prioritised verdict: what Signal Zero must add

All gaps below were verified by filesystem check on 2026-08-30, not taken on trust. Confirmed absent:
`.github/`, `Dockerfile`, `docker-compose.yml`, any ESLint/Prettier config, `tsconfig.json`,
`LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `openapi.yaml`, `.dockerignore`.
Confirmed present: `src/store.js` as a pure in-memory object; `TRUEFORGE_TIMEOUT_MS = 15000` at
`src/config.js:63`.

### Tier 1 — Table stakes. Absence is disqualifying.

A senior reviewer stops reading when these are missing. Ordered by the sequence I would actually do
them, because several unblock the others.

| # | Item | Why it is disqualifying |
|---|---|---|
| 1 | **`LICENSE`** | A public repo with no licence is legally unusable. Five minutes. There is no defence for its absence. |
| 2 | **Persistence — Postgres, append-only observations table** | §3.4. The product measures elapsed time since last observation; an in-memory store cannot measure across a restart. This is not an infra gap, it invalidates the core metric. |
| 3 | **Migrations, versioned and applied automatically** | Follows immediately from (2). A schema with no migration history is not a real database. |
| 4 | **`Dockerfile` + `.dockerignore`** | Docker is at 71.1% adoption (https://survey.stackoverflow.co/2025/technology). Multi-stage, digest-pinned base, `USER node`, `HEALTHCHECK` on `/api/health`. The `.dockerignore` is urgent independently: `.env` exists in the working tree. |
| 5 | **`docker-compose.yml`: app + Postgres, one command** | The artefact a reviewer actually runs. If `docker compose up` does not work, nothing else is evaluated. |
| 6 | **CI on every push and PR** | Install from lockfile, unit tests (195), evals (69), lint. Green badge. §1.1: assumed, never asked for. |
| 7 | **Linter + formatter config** | Their absence reads as "never worked on a team." ESLint flat config + Prettier. |
| 8 | **Structured JSON logs with correlation ids** | winston already exists; make output structured and carry a request/run id. Prerequisite for §4. |
| 9 | **Graceful shutdown on SIGTERM** | 12-factor disposability (https://12factor.net/). Required the moment (4) exists; interacts with the 114s pass (§5.2). |
| 10 | **Diagnose the 114s regression — do NOT raise the timeout** | §5.2. This is the reasoning test. Instrument per-stage latency, isolate the cause, publish the finding. |
| 11 | **`SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`** | Cheap, expected on any repo presented as production-shaped. |

### Tier 2 — Differentiators. These are where the project wins.

Ordered by signal-per-hour. The first three are, in my judgement, the highest-leverage work
available to this project.

| # | Item | Why it differentiates |
|---|---|---|
| 1 | **Pipeline SLIs: freshness, coverage, correctness** | §3.4/§4.3. Straight from the SRE Workbook (https://sre.google/workbook/implementing-slos/), and **freshness is literally this product's output.** I have not seen another portfolio project with that alignment. This is the strongest single idea in this document. |
| 2 | **`/metrics` + committed Grafana dashboard JSON + compose profile** | Prometheus is CNCF-graduated. A screenshotted dashboard is worth more than twice the metrics with no dashboard. |
| 3 | **A written engineering decision record** | ADRs for: no Kubernetes; Postgres over SQLite; no PostGIS; no Timescale; append-only but *not* event-sourced. §2.2 — the postings screen for judgement, and refusals-with-reasons are the cheapest way to demonstrate it. |
| 4 | **OTel traces + metrics (not logs)** | §4.1. Stable in JS; logs are still Development. Getting this distinction right is itself the signal. |
| 5 | **`openapi.yaml` (3.1+), validated in CI** | §6.1. An hour of work; makes the API reviewable without reading the server. |
| 6 | **RFC 9457 error envelopes** | §6.2. Cheapest credibility win in the API section; the global handler already exists at `src/server.js:690`. |
| 7 | **Idempotency keys on the checkpoint decision routes** | §6.3. Double-approving a human-in-the-loop safety control is a correctness bug in an auditability product. Directly matches https://railway.com/careers/scalability. |
| 8 | **Async `POST /api/run` (202 + run id)** | §5.2 step 5. Structural fix for the 114s pass; also resolves graceful shutdown. |
| 9 | **Retries with full jitter, single layer, capped** | https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ plus the SRE book's retry-amplification warning. |
| 10 | **Single-flight guard / load shedding on `/api/run`** | "Fail early and cheaply" (https://sre.google/sre-book/addressing-cascading-failures/) at this app's scale. |
| 11 | **Circuit breaker around the harness call** | Fixes an *observed* failure, not a hypothetical one — the timeout fires today. |
| 12 | **A live deployed URL** | Worth more than any amount of infrastructure code. A reviewer who can click is a reviewer who engages. |
| 13 | **2–3 published SLOs with burn-rate alerting** | https://sre.google/workbook/alerting-on-slos/. Keep it to two or three — the SRE book's own advice. |
| 14 | **Node 20 × 24 CI matrix** | Justified: `package.json` declares `>=20`, development is on 24. A matrix that catches a real gap. |
| 15 | **SBOM + build provenance** | Nearly free on GitHub (SLSA Build L2 — https://docs.github.com/en/actions/concepts/security/artifact-attestations). Small win. **Do not claim L3.** |
| 16 | **Load test with published numbers** | A modest k6/autocannon run with real p50/p95/p99 beats an elaborate one never run. |

### Tier 3 — Would read as resume-padding on a project this size.

Not "bad practice" — genuinely good practice, at a scale this project does not have. Adding these
signals inability to size a solution, which is the opposite of the intended effect.

| Item | Why it is padding here | Threshold at which it becomes correct |
|---|---|---|
| **Kubernetes / Helm** | One stateless service. K8s adds a control plane, ingress and cluster bill to solve a scheduling problem that does not exist. 28.5% adoption vs Docker's 71.1% (https://survey.stackoverflow.co/2025/technology). | Multiple services with independent scaling, or a team operating them. |
| **Argo Rollouts / canary / progressive delivery** | Requires traffic to split. There is one instance and no production traffic. | Real traffic across replicas with a metric to gate promotion. |
| **Service mesh (Istio / Linkerd)** | mTLS and traffic policy between services that do not exist. | Many services with cross-cutting policy needs. |
| **Kafka / Flink / streaming stack** | Appears in Airbnb and Datadog postings at *their* scale. Here it is a queue with one producer and one consumer. | Ingest that a single process genuinely cannot keep up with. |
| **PostGIS** | §3.3. Adjacency is precomputed in `src/data/corridor.json`; no spatial *query* exists to justify it. | Adjacency derived from geometry — `ST_DWithin`, dynamic radius, polygon containment. |
| **TimescaleDB** | §3.4(c). Plain Postgres with a `(settlement_id, observed_at DESC)` index answers every query for years. | Ingest rate or retention where partitioning becomes the bottleneck. |
| **Full event sourcing** | §3.4(b). Fowler's own cost/benefit says do not, absent a return (https://martinfowler.com/eaaDev/EventSourcing.html). **Append-only ≠ event-sourced. Do not use the term.** | Genuine need for temporal replay of *all* state transitions. |
| **SLSA L3 claims** | Requires build-platform properties you do not control (https://slsa.dev/spec/v1.0/levels). An overclaim a knowledgeable reviewer will catch. | Never, on a GitHub-hosted portfolio project. Claim L2 if anything. |
| **Multi-region / HA / DR** | No users, no availability requirement, no data to lose that is not reproducible. | A real SLA with real consequences. |
| **HATEOAS / Richardson Level 3** | Six routes, one consumer — this project's own frontend. | A public API with independent third-party clients. |
| **Terraform provisioning nothing** | Worse than no Terraform. | An actual managed database, bucket or DNS record to provision. |
| **AuthN/AuthZ theatre** | Real auth is Tier 2 *if* the app is publicly deployed with mutable state. A hand-rolled JWT layer on a read-mostly demo is not. | Public deploy where `POST /api/run` and the checkpoint routes are reachable by strangers. |

---

## 8. The one-sentence version

**[INFERENCE]** Signal Zero's statistical and agentic core is already well above the level of a
typical portfolio project — Fellegi-Sunter linkage, a Gamma-prior exponential baseline, Getis-Ord
Gi*, deterministic guardrails, 195 tests and 157 eval checks are not common. What is missing is entirely
**operational**: it cannot remember, cannot be deployed, cannot be observed, and has a known
performance regression with no measurement behind it. The postings I retrieved screen for exactly
that axis — Cloudflare's repeated framing of owning a system through staged deployment and incident
response, Stripe's preference for holding a high bar in production, Railway's demand to know what to
do when a Node service degrades under load. **Fix Tier 1 and the project stops being a hackathon
demo. Add Tier 1's items 2 and 10 plus Tier 2's items 1–3, and the operational story becomes the
strongest part of the resume rather than its gap** — because "freshness is both my SLI and my
product" is an observation that a reviewer will remember, and almost nobody else can make it.

---

## Appendix: sources actually retrieved

**Job postings (primary, company-hosted unless noted)**
- Stripe, Backend Engineer, Core Technology — https://stripe.com/careers/listing/backend-engineer-core-technology/6042172
- Cloudflare, Senior Systems Engineer — https://job-boards.greenhouse.io/cloudflare/jobs/8087792
- Cloudflare, Systems Engineer, Spectrum — https://job-boards.greenhouse.io/cloudflare/jobs/8094826
- Cloudflare, Systems Engineer, R2 Gateway — https://job-boards.greenhouse.io/cloudflare/jobs/8155463
- Datadog, Staff Engineer, Data Platform Experience — https://careers.datadoghq.com/detail/8119496/
- Railway, Senior Product Engineer: Scalability — https://railway.com/careers/scalability
- Chainguard, Software Engineer (Libraries Platform) — https://job-boards.greenhouse.io/chainguard/jobs/4699210006
- Supabase, careers / hiring principles — https://supabase.com/careers
- Grafana Labs, Senior Software Engineer – OpenTelemetry — https://www.builtinnyc.com/job/senior-software-engineer-opentelemetry-us-remote/9365509 *(aggregator; marked removed 2026-06-17)*
- Airbnb, Senior Data Engineer, Infrastructure — https://builtin.com/job/senior-data-engineer-infrastructure/6835799 *(aggregator mirror; Airbnb's own site returned 403)*

**Specifications and standards**
- SLSA v1.0 build levels — https://slsa.dev/spec/v1.0/levels
- GitHub artifact attestations (Sigstore; SLSA Build L2) — https://docs.github.com/en/actions/concepts/security/artifact-attestations
- npm provenance — https://docs.npmjs.com/generating-provenance-statements
- RFC 9457, Problem Details — https://www.rfc-editor.org/rfc/rfc9457.html
- OpenAPI Specification v3.2.0 — https://spec.openapis.org/oas/latest.html
- IETF Idempotency-Key draft *(expired)* — https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/

**Observability**
- OpenTelemetry CNCF graduation, 2026-05-21 — https://www.cncf.io/announcements/2026/05/21/cloud-native-computing-foundation-announces-opentelemetrys-graduation-solidifying-status-as-the-de-facto-observability-standard/
- OpenTelemetry status matrix — https://opentelemetry.io/status/
- OpenTelemetry JS status — https://opentelemetry.io/docs/languages/js/
- Semantic conventions — https://opentelemetry.io/docs/concepts/semantic-conventions/
- HTTP span conventions (Stable) — https://opentelemetry.io/docs/specs/semconv/http/http-spans/
- USE method, Brendan Gregg — https://www.brendangregg.com/usemethod.html
- RED method, Tom Wilkie via Grafana — https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/
- CNCF project maturity listing — https://www.cncf.io/projects/

**Reliability**
- SRE Book, Service Level Objectives — https://sre.google/sre-book/service-level-objectives/
- SRE Workbook, Implementing SLOs — https://sre.google/workbook/implementing-slos/
- SRE Workbook, Alerting on SLOs — https://sre.google/workbook/alerting-on-slos/
- SRE Book, Addressing Cascading Failures — https://sre.google/sre-book/addressing-cascading-failures/
- AWS, Exponential Backoff and Jitter — https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- Stripe, Idempotent requests — https://docs.stripe.com/api/idempotent_requests

**Containers, data, architecture**
- Docker build best practices — https://docs.docker.com/build/building/best-practices/
- Google distroless — https://github.com/GoogleContainerTools/distroless
- The Twelve-Factor App — https://12factor.net/
- Argo Rollouts — https://argo-rollouts.readthedocs.io/en/stable/
- SQLite, appropriate uses — https://www.sqlite.org/whentouse.html
- PostGIS — https://postgis.net/
- TimescaleDB hypertables — https://www.tigerdata.com/docs/use-timescale/latest/hypertables
- Martin Fowler, Event Sourcing — https://martinfowler.com/eaaDev/EventSourcing.html
- Sigstore (OpenSSF, **not** CNCF) — https://openssf.org/projects/sigstore/

**Surveys**
- Stack Overflow Developer Survey 2025, Technology — https://survey.stackoverflow.co/2025/technology
- DORA, State of AI-assisted Software Development 2025 — https://dora.dev/research/2025/dora-report/ *(title and headline framing retrieved; sample size and the five-metric list were **not** available on the landing page and are therefore not cited)*
