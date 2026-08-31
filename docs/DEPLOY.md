# Deploying Signal Zero

Containerisation for **local and CI use**. Read [What this does NOT cover](#what-this-does-not-cover)
before you treat any of it as production. That section is the most important one on
the page and it is deliberately not at the bottom of a scroll.

---

## Quick start

```bash
docker compose up --build
```

That is the whole command. It brings up two services:

| Service    | Host port | What it is                                    |
| ---------- | --------- | --------------------------------------------- |
| `app`      | **3010**  | Express API + the vanilla-JS frontend          |
| `postgres` | **5545**  | Postgres 17, schema seeded from `db/migrations` |

Then:

- UI — <http://localhost:3010>
- Health — <http://localhost:3010/api/health>
- State — <http://localhost:3010/api/state>

Stop with `docker compose down`. Add `-v` to also destroy the database volume.

### Why those port numbers

They are not the defaults, on purpose. This machine already has containers bound to
the obvious ports, and a compose file that fights for a bound port fails with an error
about the port rather than about the conflict:

| Port | Already taken by                             |
| ---- | -------------------------------------------- |
| 3000 | a host-side `npm start` dev server            |
| 4000 | `tforge` — the already-running TrueForge       |
| 5432 | `betterday-postgres-1`                        |
| 5433 | `darkspot-core-postgres-1`                    |
| 5544 | **`sz-pg`** — the already-migrated Signal Zero DB |

So the stack uses **3010**, **5545**, and **4010** (harness profile).

### Two databases now exist. Know which one you are talking to.

This is the single most likely thing to confuse you.

- **`sz-pg` on 5544** — the pre-existing container. Already migrated. This is what
  `DATABASE_URL` in your host `.env` points at, and what host-side `npm start` and
  `npm test` use.
- **compose `postgres` on 5545** — brought up by this stack, in its own named volume
  `signal-zero_sz-compose-pgdata`, seeded on first boot from `db/migrations`.

They are separate databases with separate data. Nothing in this compose file touches
`sz-pg`, and the volume is named distinctly so `docker compose down -v` cannot destroy
the already-migrated one by accident.

---

## Profiles

The default `up` must be fast and must work, so everything heavy is opt-in.

| Profile         | Command                                      | Status                     |
| --------------- | -------------------------------------------- | -------------------------- |
| *(default)*     | `docker compose up`                           | app + postgres             |
| `harness`       | `docker compose --profile harness up`         | adds TrueForge on **4010** |
| `observability` | `docker compose --profile observability up`   | **starts nothing today**   |

### `harness` — TrueForge

Adds the agent runtime behind Signal Zero's two LLM touchpoints (triage tier 3 and the
escalation drafter). Opt-in because it `npx`-installs TrueForge on every start: tens of
seconds and a live network dependency. That is the difference between a ten-second
stack and a ninety-second one.

Two things it does **not** do by itself:

1. **It does not switch the app over to it.** Starting a container cannot rewrite
   another container's environment. Run it with `SZ_TRUEFORGE_ENABLED=true docker compose --profile harness up`.
2. **A fresh TrueForge has an empty agent registry.** Signal Zero binds sessions to
   agents *by name*. Until you run `node scripts/load-agents.mjs` against it, tier 3
   still runs through the harness but falls back to an inline `AgentSpec`, and the
   incident feed says so. It degrades honestly; it does not pretend the roster was used.

### `observability` — reserved, starts nothing

`docker compose --profile observability up` is currently a **no-op**, and that is a
choice rather than an oversight.

The obvious placeholder is a Prometheus scraping the app. That would be a lie in the
shape of infrastructure: `src/server.js` exposes `/api/health` and `/api/state` and
**no `/metrics` endpoint**, so the scrape would fail on every interval while a
green-looking "observability stack" sat in `docker ps`. A dashboard that reports
nothing is worse than an absent dashboard, because it answers "are we watching this?"
with a yes.

Wiring it up needs an instrumentation endpoint in `src/`. The profile name is reserved
so Phase 3 can fill in the commented stanza in `docker-compose.yml` without compose
surgery.

---

## Environment variables

Every value has a default in `src/config.js`, so the stack comes up with **no `.env` at
all** — missing credentials degrade the pipeline into offline/deterministic modes
rather than crashing it. That property is what makes CI able to run without a single
secret, and it is worth preserving.

### Set by compose (topology — do not expect `.env` to win)

| Variable              | Value in the container                                | Why compose owns it                                                       |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `PORT`                | `3000`                                                 | Container-internal. The 3010 mapping is on the host side.                 |
| `DATABASE_URL`        | `postgres://signalzero:signalzero@postgres:5432/signalzero` | `.env` points at `localhost:5544`, which inside the compose network is nothing. |
| `TRUEFORGE_BASE_URL`  | `http://trueforge:4000`                                | Same reason — `localhost:4000` resolves to nothing in-container.          |

> **Honest status on `DATABASE_URL`:** as of this commit **nothing in `src/` reads it.**
> `pg` is in `package.json` and the schema is in `db/migrations`, but the running app
> still uses the in-memory `src/store.js`. The variable is wired so the Phase 2 store
> swap needs no compose change. It is *not* evidence that the app persists anything yet.

### Compose-scoped switches (`SZ_` prefix)

| Variable                | Default | Effect                              |
| ----------------------- | ------- | ----------------------------------- |
| `SZ_USE_LIVE_SCRAPE`    | `false` | Bright Data live ingest             |
| `SZ_TRUEFORGE_ENABLED`  | `false` | Route the LLM touchpoints via TrueForge |

**Why the prefix, and it is not cosmetic.** Compose auto-loads `./.env` to resolve
`${...}` substitutions. Writing `USE_LIVE_SCRAPE: ${USE_LIVE_SCRAPE:-false}` therefore
did *not* default to false — `.env` sets `USE_LIVE_SCRAPE=true` for host-side use, so
the default `docker compose up` came up **live-scraping**: slow, network-dependent, and
spending Bright Data credit nobody asked it to spend. The `:-false` looked like a safe
default while being dead code. This shipped and was caught by reading the container's
boot log, which said `live scrape: ON`.

A compose-scoped name cannot collide with the host's own keys, so the containerised
default is deterministic regardless of `.env`. Opt in explicitly:

```bash
SZ_USE_LIVE_SCRAPE=true docker compose up
```

### Credentials (runtime only, never in an image)

The `app` service loads `.env` via `env_file` with `required: false`. This injects
credentials into the **running container** and leaves nothing in the image — which is
categorically different from a build layer, and is the correct place for the keys that
`.dockerignore` keeps *out* of the build.

Relevant keys, all documented in `.env.example`: `BRIGHTDATA_API_TOKEN`,
`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`, and the `TRUEFORGE_*` family.

---

## How the image keeps `.env` out

`.env` holds live Bright Data and model-provider credentials. A secret baked into a
layer cannot be un-shipped: `docker history` reads it back even if a later layer
deletes the file. So there are **two independent defences**:

1. **`.dockerignore`** excludes `.env` from the build context. Written before any
   Dockerfile existed — read its header.
2. **The Dockerfile never runs `COPY . .`.** Every `COPY` names an explicit path. A
   secret can only enter a layer if someone adds a line naming it.

Defence 2 is the load-bearing one. Defence 1 makes the context smaller; it is not what
makes the image safe.

Verify at any time:

```bash
docker build -t signal-zero:local .
docker history --no-trunc signal-zero:local | grep -i env
docker run --rm --entrypoint sh signal-zero:local -c 'ls -a /app | grep -c "^\.env$" || true'   # expect 0
```

`grep -i env` matches the literal word, so it will show the base image's `ENV
NODE_VERSION` lines and `process.env.PORT` inside the HEALTHCHECK. Those are not
secrets. The meaningful check is the second command, plus the CI job below.

**CI plants a decoy.** A runner has no `.env`, so "no `.env` in the image" would pass
there even if the Dockerfile said `COPY . .` — green and worthless, with the failure
only appearing on a laptop that *has* credentials. So the `docker` job writes a decoy
`.env` with a unique canary, rebuilds, and hunts for that exact string in the
filesystem, the history, and every **decompressed** layer blob.

The decompression matters: `docker save` writes layers as gzip, so a plain `grep -r`
reports "clean" for a leaking image. The first version of that check did exactly that
and passed against a deliberately-leaking `COPY . .` build. It was fixed and then
re-verified against that same known-bad image, which it now correctly fails.

---

## The image itself

- **Base pinned by digest**, not tag: `node:24-alpine@sha256:e67514e5…` (Node 24.20.0).
  `24-alpine` moves every few days; a digest names exactly one set of bytes. Postgres
  is pinned the same way. To bump: re-pull, re-read the digest, change it in one place.
- **Multi-stage.** `npm ci --omit=dev` runs in a `deps` stage off the *same* pinned
  base, so the tree is byte-identical to installing in the runtime stage while keeping
  npm's cache out of the shipped layers.
- **Non-root.** Runs as the image's built-in `node` user (uid 1000).
- **HEALTHCHECK** hits the real `GET /api/health` using Node's built-in `fetch` —
  alpine ships no curl, and installing a package to ask a question the runtime can
  already answer is attack surface for nothing.
- **`init: true`** in compose. `src/server.js` installs no `SIGTERM` handler, so as
  PID 1 it would ignore `docker compose stop` until the grace period expired and it got
  `SIGKILL`ed. tini forwards the signal. Cheaper than editing `src/`.

Image size is ~300 MB, dominated by the base image and `maplibre-gl`.

---

## Schema seeding is not migration

`db/migrations` is mounted read-only into the Postgres entrypoint directory. Postgres
runs `*.sql` there in filename order — **only when the data volume is empty**, i.e. on
first boot or after `docker compose down -v`.

It is a **seeder, not a migration runner.** Adding `002_something.sql` will *not* apply
it to a volume that already exists. There is no migration runner in this repo yet.
Until there is, applying a new migration to a live database is a manual `psql` step.

---

## CI

The `docker` job in `.github/workflows/ci.yml` makes three claims and proves each,
because they fail independently:

1. **It builds** — catches syntax, a bad digest, a lockfile drifted out of sync with
   `package.json` (`npm ci` fails loudly where `npm install` would paper over it).
2. **It boots** — catches what a build cannot: a runtime file `.dockerignore` excluded,
   a permission error from `USER node`, a bad `CMD`. A green build with a crash-looping
   container is the normal way this breaks. The job asserts on the `/api/health`
   *payload*, not just a 200, because that route is a liveness probe that answers 200
   even when the pipeline is broken.
3. **It has no `.env`** — the decoy-canary regression test described above.

It then brings the compose stack up with `--wait`, which returns non-zero unless every
service reaches healthy, so the `service_healthy` gate is asserted rather than assumed.

No new third-party actions were introduced: `ubuntu-latest` ships Docker and Compose,
and `actions/checkout` is already pinned to a commit SHA. The job declares
`permissions: contents: read` and pushes nothing to any registry.

---

## What this does NOT cover

Stated plainly, because a container is routinely mistaken for a deployment.

- **No live deployment.** Nothing here provisions a host, a registry, a domain, or an
  orchestrator. There is no published image — it is built locally and in CI, then
  discarded. `docker compose` is a local development tool, not a production runtime.
- **No TLS.** Everything is plain HTTP on localhost. No certificates, no termination,
  no HSTS. Do not expose port 3010 beyond your machine.
- **No authentication and no authorisation.** The API is completely open. Anyone who
  can reach the port can `POST /api/run` and can approve or reject checkpoint items.
  **Hard rule 2 is a data-integrity rule, not a security control**: the database
  requires `approved_by` to be present and non-blank, so a decision cannot be recorded
  anonymously — but nothing *authenticates* that name. Any string is accepted. It is an
  audit trail, not an identity system, and it should not be mistaken for one.
- **Secrets are plain environment variables.** No secret manager, no encryption at
  rest, no rotation. Adequate for a laptop; not for a shared host.
- **Trivial database credentials.** `signalzero:signalzero`, hard-coded in the compose
  file. Fine for a disposable local volume, unacceptable anywhere else.
- **No backups and no restore procedure.** `docker compose down -v` destroys the
  compose database irreversibly.
- **No resource limits.** No CPU or memory caps on any service.
- **No image signing, SBOM, or vulnerability scanning.** Base images are digest-pinned,
  which fixes *which* bytes you get — it says nothing about whether those bytes have
  known CVEs, and pinning means you do not pick up upstream patches until someone bumps
  the digest by hand. That trade is deliberate: reproducibility now, at the cost of a
  recurring manual bump.
- **No horizontal scaling.** The app holds state in memory (`src/store.js`), so a
  second replica would serve different rankings. This stack runs exactly one.
- **The `observability` profile starts nothing** (see above).
- **Postgres is running but unused by the app** (see `DATABASE_URL` above).
