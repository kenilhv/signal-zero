# Signal Zero — handoff

Written 2026-08-31 for a move to a different machine. Everything here was verified
against the repository on that date, not recalled. Where something is uncertain it
says so.

---

## What this is

Signal Zero ranks real Nepali settlements by how anomalously long they have gone
**silent** — no confirming report has reached us — instead of by report volume,
which is what every other crisis dashboard does. Demo scenario: the 26 Aug 2026
Trishuli glacial lake outburst flood across Rasuwa / Nuwakot / Dhading.

It began as a hackathon entry. The deadline has passed and it is now being rebuilt
as a portfolio project, following `docs/BUILD-PLAN.md`.

---

## Where things stand

| | |
|---|---|
| Repo | https://github.com/kenilhv/signal-zero |
| Branch | `feat/control-room-ux` — **10 commits ahead of `main`**, all pushed |
| Head | `be013f4` |
| Tests | **286 pass** (`npm test`) |
| Evals | **168/168**, 4 families, 0 critical (`npm run eval`) |
| CI | 5 jobs green on the last push |

`main` has never been updated. Everything since the initial scaffold lives on
`feat/control-room-ux`. Opening a PR from that branch is a reasonable next move —
it would also give Qodo something to review.

---

## Getting it running on the new machine

```bash
git clone https://github.com/kenilhv/signal-zero
cd signal-zero
npm install
cp .env.example .env        # then fill in the two credentials below
npm start                   # http://localhost:3000
```

**It runs with no `.env` at all** — every credential is optional and a missing one
degrades a stage into a deterministic offline mode rather than failing it. You only
need secrets for live mode.

### The two credentials

They are NOT in the repo (`.env` is gitignored and has never been committed —
verified by scanning every ref). Carry them across yourself:

- `BRIGHTDATA_API_TOKEN` — live web ingestion. Zones `serp_api1` (SERP) and
  `web_unlocker1` (unblocker).
- `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL` — triage tier 3 only.
  Currently pointed at Nebius Token Factory
  (`https://api.tokenfactory.nebius.com/v1`, `Qwen/Qwen3-30B-A3B-Instruct-2507`).
  **Pick a small fast model**: benchmarked on the real prompt, Llama-3.3-70B took
  31,644 ms and blew the 15 s timeout; Qwen3-30B-A3B returned the *same answer* in
  803 ms.

### The two containers (not in the repo — recreate them)

```bash
# Postgres. Host port 5544 because 5432/5433 were already taken on the old machine;
# change it here and in DATABASE_URL if 5432 is free on the new one.
docker run -d --name sz-pg \
  -e POSTGRES_PASSWORD=signalzero -e POSTGRES_USER=signalzero -e POSTGRES_DB=signalzero \
  -p 5544:5432 postgres:17-alpine

# TrueForge. It CRASHES on Windows natively (upstream ESM bug, root-caused in
# docs/trueforge-windows-bug.md), so it runs in a Linux container. --privileged and
# the extra packages are what enable the local sandbox, which gates Skills.
# Full recipe and the API calls to re-register the provider, MCP server and agents
# are in docs/trueforge-verified.md.
docker run -d --name tforge --privileged -p 4000:4000 -e PORT=4000 -e HOST=0.0.0.0 \
  tforge-sandboxed
```

TrueForge state (model provider, Bright Data MCP server, the 5 registered agents)
lives in the container's SQLite and does **not** survive recreation. Re-register with
`node scripts/load-agents.mjs` plus the two `curl` calls in `docs/trueforge-verified.md`.

`docker-compose.yml` exists and brings up app + Postgres in one command; TrueForge
is behind an optional profile.

---

## What is done

**Phase 0 — truth repairs.** Every published number traces to a run.
`scripts/sync-eval-readme.mjs` generates the results block in `evals/README.md` from
`evals/report/latest.json`, `--check` asserts they match, and CI fails the build if
they drift. It refuses to publish a partial (`--offline`) run.

**Phase 1 — CI.** `.github/workflows/ci.yml`: lint/format (Biome), tests on Node
20 **and** 24, offline evals with the skip count in the job summary, OpenAPI lint,
and a `docs-truth` job. Actions pinned to tag-resolved commit SHAs.

**Phase 2 — persistence (mostly).** Postgres replaces the in-memory store.
`observations` is an append-only fact table and the only input to the silence clock.
`approvals` is a separate append-only decision log.

---

## The two results worth leading with

**The LLM tier is not earning its keep.** The eval suite scores the same 32
hand-labelled reports twice in two processes — once with tier 3 disabled, once live
through the harness with no fallback that could be mistaken for it. Most recent full
run: harm-weighted error rate **0.1875 either way**, tier 3 fixed 0 errors and
introduced 0, category accuracy fell 1.0000 → 0.9688. That is a finding about the
model on this task, and the reason tier 3 stays a fallback rather than the spine.

**Silence now survives a restart.**

```
before                 92.3667 h
after restart          92.3851 h
process was down       0.0183 h
control (no database)  0 h, lastReportAt = null
```

The control is the proof: the same restart without a database resets to zero. That
is what the build did before — it did not merely lose data, it reported a settlement
as freshly heard-from when nothing had been heard. Now eval `D13`.

---

## Open items

1. **Phase 2 is unfinished.** The API agent was stopped mid-flight. Landed:
   `src/http/problem.js`, `src/http/run-progress.js`, `test/api-contract.test.js`.
   **Not done:** idempotency keys on `POST /api/run` and the checkpoint decision
   routes, and reconciling `openapi.yaml` against the routes as they changed.

2. **Family C cannot tell "the model answered badly" from "the model was taken
   away".** If TrueForge disappears mid-run the family FAILS when it should SKIP —
   a failure blames the product for infrastructure pulled out from under it. This
   was discovered the hard way: three separate diagnoses of a "family C bug" were
   wrong, and the real cause was a concurrent agent running `docker stop tforge` to
   test fault paths. The eval was reporting the truth throughout. Needs a quiet
   machine to build and verify against.

3. **One intermittent test.** A single run showed 285/286; three subsequent runs
   showed 286/286 and the failing test was not captured. Unidentified. Suspect a
   database-dependent test racing, but that is a hypothesis, not a finding.

4. **Biome lint backlog** — 48 findings, mostly `useOptionalChain` in `web/`. CI
   warns rather than gates on purpose; a red gate everyone learns to ignore is worse
   than an honest warning. Flip to gating once cleared (BUILD-PLAN 1.2).

5. **The TrueForge Windows bug report is written but NOT filed.**
   `docs/trueforge-windows-bug.md` has the root cause pinned to
   `kysely/dist/migration/file-migration-provider.js:32-35` and a one-line fix using
   kysely's own `props.import` escape hatch. Filing it is a public action under your
   GitHub identity, so it was left for you.

---

## The plan from here

`docs/BUILD-PLAN.md` is dependency-ordered with honest effort estimates
(242–367 h total for everything, with three cuts if that is more time than exists).
`docs/GAP-ANALYSIS.md` rates the project per hiring dimension with file-level
evidence. `docs/ARCHITECTURE-DECISIONS.md` holds 15 ADRs — including ADR-015, a
refusal register naming 15 things deliberately **not** built and the threshold that
would make each correct.

Next on the critical path: finish Phase 2's API items, then Phase 3 (observability —
OpenTelemetry traces and metrics, and the SLO work where *freshness is the product
output, not an operational metric*).

---

## Conventions this repo holds itself to

- **No dispatch.** The system never says where anyone should go. No dispatch-shaped
  field exists in any data structure, and a test asserts it.
- **Nothing actionable without a named human.** Enforced in application code *and*
  as a database constraint — `approvals.approved_by` is `NOT NULL` with a non-blank
  `CHECK`, so an anonymous approval cannot be written even if the code is bypassed.
- **Zero LLM in dedup scoring or ranking math.** Tier 3 is the only LLM touchpoint.
- **Honest unknowns.** `last_observed_at IS NULL` means *no report has ever reached
  us*. Never `COALESCE` it. One coalesce in the read path converts absence of data
  into a confirmed observation — the product lying in the exact direction it exists
  to prevent.
