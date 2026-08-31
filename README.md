# Signal Zero

**Every crisis dashboard ranks the places that are talking. Signal Zero ranks the places that stopped.**

---

## The problem

When a disaster hits, the response is steered by whatever is on the map. And what
is on the map is *reports*: news articles, social posts, official bulletins,
counted and heat-mapped by volume.

That metric is backwards at exactly the moment it matters most.

A settlement generates reports when it still has a road, a mobile tower, a
stringer, a functioning ward office, and someone with the time and signal to
post. Take those away — which is precisely what a flood does to the places it hits
hardest — and the settlement goes quiet. On a volume-ranked dashboard, quiet
looks like *fine*. The worst-hit places sink to the bottom of the list and stay
there, structurally, until someone happens to drive up the valley and find out.

Silence is not the absence of a signal. Silence **is** the signal — but only if
you know what a normal gap between reports looks like for that particular place,
and only if you can tell "this village is quiet" apart from "this whole valley is
quiet tonight".

Signal Zero does that arithmetic. It fits a baseline for how often each cohort of
settlements normally produces a confirming report, measures how surprising the
current gap is, and then checks whether a settlement is quiet *relative to its
neighbours along the river corridor* — a local cold spot — or just part of a
generally quiet region.

The output is a **ranked list of places worth checking on**, with the evidence
trail, the score breakdown, and the boring explanations attached. It is never a
dispatch order. A human with a name decides what happens next.

**Demo scenario:** a glacial lake outburst flood (GLOF) on the Trishuli river,
26 Aug 2026, affecting the Nuwakot, Rasuwa and Dhading districts of Nepal — 32
settlements along the corridor from Timure down to Benighat.

---

## Two measurements this project publishes against itself

Both are inconvenient. They are here because a claim nobody can check is not
evidence, and because the interesting number is usually the one you would rather
not print.

### The LLM tier is currently not earning its keep

Triage runs in three tiers: a deterministic rule table, a deterministic
embedding/alias matcher, and — only for what those two cannot settle — one LLM
call. The eval suite scores the **same 32 hand-labelled reports twice, in two
separate processes**: once with the LLM tier disabled entirely, once with it live
through the TrueForge harness and no fallback path that could be mistaken for it.

| | tiers 1+2 only | with live tier 3 |
|---|---|---|
| harm-weighted error rate *(lower is better)* | **0.1875** | **0.1875** |
| category accuracy | 1.0000 | 0.9688 |

On the most recent full run the LLM tier **fixed 0 errors and introduced 0**, and
category accuracy went *down* slightly. The deterministic tiers had already
resolved everything resolvable on this set.

That is a result about the value of the model on this task, not a defect in the
harness that executed it — and it is the reason tier 3 stays a *fallback* rather
than the pipeline's spine. The generated scorecard, including the run this came
from, lives in [`evals/README.md`](evals/README.md) and is regenerated from
`evals/report/latest.json` rather than typed by hand.

### The build step would not have been the thing that made this fast

The frontend is vanilla ES modules with no bundler — a decision, not an omission
([ADR-002](docs/ARCHITECTURE-DECISIONS.md)). The usual objection is payload size,
so here is the payload, gzipped, measured on the committed tree:

| | gzipped |
|---|---|
| `app.js` + `map.js` + `lib.js` + `styles.css` + `index.html` | **84.2 KB** |
| MapLibre GL (vendored, third-party) | **287.6 KB** |
| **total** | **369.9 KB** — MapLibre is **77.8%** of it |

Reproduce it: `gzip -c web/app.js | wc -c`, and so on across the five files.

A bundler would minify the 84 KB of hand-written source. Over gzip that saving is
a small fraction of a payload already dominated by a third-party map engine that
ships pre-minified. The honest conclusion is not "builds are bad" — it is that on
*this* project the build step is not where the bytes are, and choosing it would
have bought tooling rather than speed.

---

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

**Zero environment variables required.** With no `.env` file at all, the app
boots, runs the full six-stage pipeline against the bundled offline corpus, and
serves the dashboard. Nothing crashes on a missing key — every credential is
optional, and a missing one degrades a stage into a deterministic offline mode
rather than failing it. That degradation is *visible*: it shows up in the fail
feed, which is the point.

For live mode, copy `.env.example` to `.env` and add either or both:

| Variable | What it unlocks | Without it |
| --- | --- | --- |
| `BRIGHTDATA_API_TOKEN` | INGEST pulls live news / social / official reports from the web | Ingest runs the bundled offline corpus |
| `OPENAI_API_KEY` | Triage tier 3 (low-confidence fallback) calls a real model | Tier 3 uses a deterministic fallback classifier |
| `USE_LIVE_SCRAPE=true` | Actually attempts live scraping (ignored when the Bright Data token is blank) | Offline corpus |
| `OPENAI_BASE_URL`, `OPENAI_MODEL` | Point tier 3 at any OpenAI-compatible endpoint | Defaults to `api.openai.com` / `gpt-4o-mini` |
| `PORT` | HTTP port | `3000` |

Requires Node 20+ (developed on Node v24 / npm 11). Plain ESM JavaScript, no
TypeScript, no build step — the frontend is static HTML/CSS/JS served by the same
Express process that serves the API.

---

## Architecture

One Express server on port 3000 serves both the JSON API and the static frontend
from `/web`. Everything lives in memory in `src/store.js` — no database. A
pipeline run rebuilds state from scratch, except the human decision log and the
incident feed, which are the audit trail and persist across runs.

Six stages, in fixed order:

### 1. INGEST
Pulls news, social and official reports about the flood from the live web via
Bright Data, or reads the bundled offline corpus. Normalises everything into
`Report` records that preserve the **original URL and the publisher's own
timestamp**, byte for byte. Failures are never swallowed: a rate limit, a bot
wall, a parse error or an empty result set becomes a `degraded-source` incident.
A silently dropped source would manufacture fake silence, which is the one bug
this system cannot tolerate.

### 2. TRIAGE
Classifies each report as `corroboration-candidate`, `new-settlement`,
`hazard-signal` or `noise`, in three tiers. Tier 1 is deterministic rules —
gazetteer name and alias hits, known sources, known noise patterns. Tier 2 is
deterministic fuzzy scoring above a fixed confidence floor. **Tier 3 is the only
LLM call in the entire system**, reserved for the residue the deterministic tiers
admit they cannot handle — and every tier-3 invocation writes an `llm-fallback`
incident to the visible fail feed. The model's existence in this pipeline is
logged as a degradation, on purpose.

### 3. DEDUP
Six outlets reporting the same rescue is one event, not six corroborations —
and counting it as six would wrongly silence a real silence signal. Pairwise
match probabilities are computed with **Fellegi–Sunter** record linkage over
comparison vectors (settlement name and alias agreement, time proximity, title and
body similarity, source independence), then reports are grouped into same-event
clusters. Matches that land in the ambiguous band between the auto-merge and
auto-reject thresholds are **not** decided by the machine: they become pending
checkpoint items.

### 4. RANK
Two deterministic steps.

First, an **Exponential time-between-events (TBE) baseline** per cohort.
Settlements are cohorted (district × hazard tier), the inter-arrival gaps between
confirming reports are fitted to an exponential with rate λ, and the observed
silence is scored as surprisal: `−ln P(gap ≥ observed) = λ · silenceHours`. This
is what makes 8 hours of quiet alarming for a settlement that normally reports
every 90 minutes and unremarkable for one that reports twice a day.

Second, **Getis–Ord Gi\*** over the river-corridor adjacency graph. This is the
"is it just a quiet night in this valley?" test. A settlement is flagged as a
local anomaly only when `|z| > 1.96` **and** it is a *cold* spot — silent
relative to its corridor neighbours, not merely part of a quiet region.

### 5. CHECKPOINT
The human gate. Two kinds of item wait here: drafted **escalations**, and
**ambiguous dedup matches**. Both sit at `status: "pending"` until a human
approves or rejects them *by name*. An approve or reject request with a missing,
blank or whitespace-only `approvedBy` is rejected with HTTP 400 in
`src/server.js` — enforced server-side, not in the UI. Nothing becomes actionable
without a name attached to it.

### 6. FAILFEED
A visible incident log fed by **real failure branches**, not decoration:
`degraded-source` when a connector fails, `llm-fallback` when tier 3 fires,
`cold-start` when a settlement has no reporting history to baseline against, and
`heal` when a degraded source recovers. `POST /api/demo/fail/:kind` triggers the
genuine branch for a live demo — it does not push a fabricated string.

### API surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | Ranked settlements, checkpoint queue, incidents, source health, stats |
| `POST /api/run` | Trigger one full pipeline pass |
| `POST /api/checkpoint/:id/approve` | Body `{approvedBy}` — **400 if missing or blank** |
| `POST /api/checkpoint/:id/reject` | Body `{approvedBy}` |
| `GET /api/settlement/:id` | Full evidence trail: reports, cluster, score breakdown |
| `POST /api/demo/fail/:kind` | Trigger a real failure branch (`source` \| `ambiguous` \| `coldstart`) |

---

## The algorithms, named honestly

| Stage | Method | What it actually is here |
| --- | --- | --- |
| Dedup scoring | **Fellegi–Sunter** record linkage | A real implementation of the classical probabilistic matching model: per-field m- and u-probabilities, log-likelihood ratio agreement weights summed into a match probability, with explicit upper and lower thresholds. The m/u values are hand-set constants tuned on the corpus, not EM-estimated from labelled data — they are readable in the source and auditable. |
| Clustering | **Leiden-inspired connectivity refinement** | Honestly labelled: this is *inspired by* Leiden, not an implementation of it. It takes the graph of high-probability pairwise matches and does the part of Leiden that matters for this problem — guaranteeing every resulting cluster is internally connected, so transitive chains of weak links cannot fuse two unrelated events into one. It does **not** do Leiden's modularity optimisation or its randomised refinement phase. Calling it "Leiden" without this paragraph would be overclaiming. |
| Silence baseline | **Exponential TBE** | A genuine maximum-likelihood exponential fit to inter-arrival gaps per cohort (λ = 1/mean gap), used to compute surprisal. The exponential assumption — memoryless arrivals — is a simplification; real reporting is bursty and diurnal. It is the right first model and it is the model actually implemented. |
| Spatial anomaly | **Getis–Ord Gi\*** | A real Gi\* statistic over a binary adjacency weight matrix derived from the river-corridor graph in `src/data/corridor.json`, with the standard z-score formulation. Adjacency is hand-built corridor topology, not a distance-decay kernel. |

No LLM touches any of the four. All of it is deterministic and reproducible: run
the pipeline twice on the same corpus and you get identical numbers, every time.

---

## The four hard rules

These are the project, not the polish. `architecture-review-agent` audits the
codebase against them and any breach is an automatic fail.

**1. The system never outputs a dispatch instruction.**
No "go here", no "send team X", no destination, no assignment, no ETA, no route.
There is no dispatch-shaped field in any data structure — not in `Report`, not in
`RankedSettlement`, not in `CheckpointItem`, not in `IncidentEvent`. What human
approval unlocks is a **sorted candidate list for humans to read**. A tool that
tells responders where to go has quietly taken a decision away from the person
accountable for it, and it does so at the exact moment when its input data is
least reliable.

**2. No LLM anywhere inside the dedup-scoring or ranking math.**
Fellegi–Sunter, the clustering, the TBE baseline and Gi\* are deterministic and
auditable. A number you cannot reproduce is a number nobody should act on.

**3. The only LLM touchpoint in the entire system is triage tier 3.**
The low-confidence fallback classifier, and nothing else. Every time it fires, it
writes an `llm-fallback` incident to the fail feed where a human can see it.

**4. Escalations require a non-empty approver name, enforced in code.**
`src/server.js` returns 400 on a missing, empty or whitespace-only `approvedBy`.
Not a UI validation — a UI-only check is not a gate. Agents cannot approve;
no agent name, system name or placeholder is accepted.

There is a fifth rule the code follows even though it did not need to be one:
**silence is never reported as harm.** The system says "no confirming report in
31.4h against a cohort baseline of 6.2h". It never says a village was destroyed,
and it never derives a casualty estimate from population. Every escalation draft
carries a non-empty list of boring explanations — no stringer covers this place,
the tower is down for unrelated reasons, the reports exist under a spelling the
gazetteer does not carry.

---

## What's real vs. simulated

Scrupulously, because a disaster-response demo that overclaims is worse than one
that underclaims.

| Thing | Status | The honest detail |
| --- | --- | --- |
| The six-stage pipeline | **Real** | Runs end to end on every `POST /api/run`. Not a scripted playback. |
| Fellegi–Sunter dedup scoring | **Real** | Implemented and deterministic. m/u probabilities are hand-set constants, not EM-estimated from labelled data. |
| Connectivity-refined clustering | **Real, honestly named** | Leiden-*inspired* connectivity guarantee. Not Leiden's modularity optimisation. |
| Exponential TBE baseline + surprisal | **Real** | Genuine MLE fit per cohort. The memoryless assumption is a simplification of bursty real-world reporting. |
| Getis–Ord Gi\* | **Real** | Standard formulation over the hand-built corridor adjacency graph. |
| Human checkpoint + named approver | **Real** | Enforced server-side in `src/server.js`, returns 400 on a blank name. Verify it with `curl`. |
| Fail feed | **Real** | Fed by actual failure branches. `POST /api/demo/fail/:kind` takes the real branch rather than pushing a fake string. |
| Settlements, coordinates, districts, aliases | **Real geography** | 32 real settlements in Nuwakot, Rasuwa and Dhading with real coordinates. Population figures are approximate. The alias lists are real transliteration variants (Syabrubesi / Syaphrubesi / Syabru Besi). |
| River-corridor adjacency graph | **Hand-built** | Authored by us from the Trishuli corridor topology. Not derived from a hydrological model or a routing dataset. |
| The Trishuli GLOF event itself | **Constructed demo scenario** | The flood scenario, its timeline, and the reporting patterns are constructed for this demo. Do not read anything in this repo as reporting on a real event or the real status of any real village. |
| The bundled report corpus | **Simulated** | **With no `BRIGHTDATA_API_TOKEN`, every report you see is seed data we wrote.** The sources, headlines and timestamps are plausible-looking fiction designed to exercise the pipeline. The dashboard labels the run mode; do not mistake seed mode for live mode. |
| Live web ingestion | **Real, when a token is present** | With `BRIGHTDATA_API_TOKEN` + `USE_LIVE_SCRAPE=true`, INGEST really does hit the live web through Bright Data. Live results on a constructed scenario will of course be sparse. |
| Triage tier 3 LLM call | **Real, when a key is present** | With `OPENAI_API_KEY`, tier 3 calls a real model. Without it, a deterministic fallback classifier runs and the fail feed says so. |
| Mesh network / off-grid comms | **Does not exist** | We do not run one. Nothing in this repo talks to a radio, a LoRa node, or a satellite terminal. |
| Drones / aerial imagery | **Does not exist** | No imagery pipeline, no CV model, no drone integration of any kind. |
| Hardware / edge devices | **Does not exist** | This is a Node process and a static web page. There is no device. |
| SMS, calls, or any outbound messaging | **Does not exist, deliberately** | Nothing in this system sends anything to anyone. The escalation-drafting agent has an empty tool list specifically so that it *cannot*. |
| Integration with any real response agency | **Does not exist** | No agency has seen, endorsed, or connected to this. It is a hackathon submission. |
| Persistence | **None** | Everything is in memory. Restart the process and the state is gone. |

---

## Sponsor integrations

### TrueForge — the agent harness

**What is actually on the call path: one agent.** Triage tier 3 —
`src/pipeline/triage.js:575` — is the only place in `src/` that opens a TrueForge
session, and it binds by name to `signal-zero-triage-tier3`. That is not an
oversight, it is Hard Rule 3: no LLM may touch dedup scoring or ranking math, so
there is exactly one place an agent is allowed to run. Read the roster below as
**one production agent plus four operator-run agents**, not as a multi-agent
system: deleting the other four would not change a single byte of the product's
output. What the binding does buy is real and is the claim worth checking — the
model, the ~15k-character instructions, the iteration limit, the tool surface and
the approval policy all live inside TrueForge, so editing the agent there changes
this pipeline's behaviour with no redeploy.

[`trueforge.yaml`](./trueforge.yaml) is an **illustrative** TrueForge catalog. It
is not what registers the roster and it is not read by any code:
`scripts/load-agents.mjs` builds every manifest from the `trueforge:` frontmatter
in `agents/*.md`, which is the source of truth. Several fields in the YAML have
drifted from the live registry and its header says so field by field; use
`GET /api/v1/agents` for what is actually running.

The file carries a provenance header separating what was **verified** against the
upstream repo (`packages/trueforge/catalog/*.yaml`, the `agentSpec.ts` zod schema,
the generated SDK types) from what is our own **best-effort** convention — because
TrueForge ships four separate catalog files and has no agent-catalog YAML at all,
so the single-file composition and the `agents:` wrapper are ours and are labelled
as such. Nothing in that file invents a field name silently. It also documents
one honest mismatch: the TrueForge MCP catalog only accepts `type: remote` with a
URL, so Bright Data is declared in its verified remote form rather than as an
`npx` stdio server.

The five registered agents. **Only the third one is reachable from `src/`**; the
other four are run by hand (`scripts/verify-agents.mjs`, the TrueForge UI) and
are marked as such rather than described as a delegation that no code path
performs — `dynamic_sub_agents` does not dispatch to named registry agents, and
nothing invokes the coordinator regardless.

| Agent | On the call path? | Role |
| --- | --- | --- |
| [`crisis-coordination-agent`](./agents/crisis-coordination-agent.md) | no — operator-run | Root orchestrator persona. Sequences the six stages and reports state. Cannot approve anything. Nothing in `src/` creates a session against it. |
| [`ingestion-agent`](./agents/ingestion-agent.md) | no — operator-run | Read-only collector; the live HITL proof in `scripts/verify-agents.mjs` runs against it. Ingest in the product itself is a plain `fetch` in `src/pipeline/ingest.js`. |
| [`triage-agent`](./agents/triage-agent.md) | **YES — the only one** | Tier-3 fallback classifier. The only LLM touchpoint in the system. Every decision carries quoted evidence and a written rationale. |
| [`escalation-drafting-agent`](./agents/escalation-drafting-agent.md) | no — operator-run | Prepares escalation packets. Empty tool list — it *cannot* send. Never names a destination or a recipient. |
| [`architecture-review-agent`](./agents/architecture-review-agent.md) | no — operator-run | Read-only auditor. Checks the codebase against the four hard rules with file-and-line evidence. |

**Skills: authored, not mounted.** Three skills are registered at
`/api/v1/settings/skills` and no agent attaches one, so they contribute **zero
tokens** to any turn this system runs. Skills mount into a sandbox; this
container's sandbox bootstrap needs PyPI and has no route to it (it creates the
sandbox, fails `pip install pydantic`, and retries in a loop), so attaching them
would make turns hang rather than improve them. They are real work and they do
measurably improve settlement resolution when their text is placed in context by
hand — and none of that is a capability this system exercises. See
`scripts/load-agents.mjs`, which refuses to attach them and prints why.

### Bright Data — ingestion
Powers the INGEST stage's live web collection: news outlets, social posts, and
official bulletins, including sources behind bot protection. Declared as an MCP
connector in the catalog and called directly by `src/pipeline/ingest.js`.
Connector failures surface as `degraded-source` incidents in the fail feed rather
than as missing rows. With no token, ingest falls back to the offline corpus and
the fail feed says so.

### Qodo — pull request review
Qodo reviews PRs on this repository. The four hard rules are the review criteria
that matter: a PR that introduces a dispatch-shaped field, routes ranking math
through a model, weakens the approver-name check, or swallows a failure is a
correctness bug in this project, not a style disagreement.

---

## Repository layout

```
src/
  server.js          Express: JSON API + static /web
  config.js          Every credential optional; missing keys degrade, never crash
  store.js           The single in-memory store + addIncident()
  pipeline/          ingest → triage → dedup → rank → checkpoint → failfeed
  data/
    gazetteer.json   32 settlements: id, district, lat/lon, population, hazard tier, aliases
    corridor.json    River-corridor adjacency graph used by Getis-Ord Gi*
web/                 Static dashboard. No build step.
agents/              The five TrueForge subagent system prompts
trueforge.yaml       TrueForge harness catalog
```

---

## License

MIT — see [`LICENSE`](LICENSE).

Third-party code vendored into this repository keeps its own licence: MapLibre GL
JS under `web/vendor/` is BSD-3-Clause.
