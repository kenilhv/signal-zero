# syntax=docker/dockerfile:1
#
# Signal Zero — runtime image.
#
# Read .dockerignore first: it was written BEFORE this file, deliberately, because
# `.env` in the working tree holds live Bright Data and model-provider credentials.
#
# TWO INDEPENDENT DEFENCES keep that file out of the image, because .dockerignore
# alone is one `git checkout` away from being edited by someone who does not know
# why it exists:
#
#   1. .dockerignore excludes .env from the build context.
#   2. This file NEVER runs `COPY . .`. Every COPY below names an explicit path.
#      A secret can only enter an image layer if someone adds a line naming it.
#
# Defence 2 is the load-bearing one. Defence 1 makes the context smaller and the
# build faster; it is not what makes the image safe. A layer that has already
# shipped cannot be un-shipped by deleting the file in a later layer — `docker
# history` still reads it back — so the only reliable fix is never copying it.
#
# Verify after ANY change here (both must come back clean):
#   docker history --no-trunc signal-zero:local | grep -i env
#   docker run --rm --entrypoint sh signal-zero:local -c 'ls -a /app | grep -c "^\.env$" || true'

# ---------------------------------------------------------------------------
# Base image — DIGEST PINNED.
# ---------------------------------------------------------------------------
# `node:24-alpine` is a moving tag: it points at a different image every few days,
# so a build that passed CI on Tuesday can ship different userland on Thursday and
# nothing in the repo records the change. The digest below is the multi-arch
# manifest-list digest the tag resolved to at pin time, so it still builds on both
# arm64 and amd64 while naming exactly one set of bytes.
#
#   pinned:   node:24-alpine  ->  Node 24.20.0
#   resolved: 2026-08-30  (docker pull node:24-alpine; docker image inspect --format '{{index .RepoDigests 0}}')
#
# To bump: re-pull the tag, re-read the digest, change it HERE in one place, and
# let CI rebuild. The tag is kept alongside the digest as documentation of intent —
# Docker ignores it and resolves the digest.
ARG NODE_IMAGE=node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps

WORKDIR /app

# Only the two lockfile inputs, so this layer is cached until dependencies
# actually change — editing src/ does not trigger a reinstall.
COPY package.json package-lock.json ./

# `npm ci` (not `npm install`): it installs strictly from package-lock.json and
# FAILS if the lockfile and package.json disagree, rather than silently resolving
# a different tree than the one that was tested. --omit=dev drops Biome, which has
# no business in a runtime image.
#
# This runs in the deps stage rather than the runtime stage on purpose: both
# stages are the SAME pinned base image, so the installed tree is byte-identical
# either way, but doing it here keeps npm's cache and metadata out of the shipped
# layers. The runtime stage below receives exactly this tree and nothing else.
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# --- production dependencies ------------------------------------------------
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# --- application code -------------------------------------------------------
# Explicit paths only. Note what is NOT here: no .env, no test/, no evals/,
# no docs/, no .git/, no agents/ or skills/ — none of it is read at runtime.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src/  ./src/
COPY --chown=node:node web/  ./web/

# The schema ships with the image so the running container can always show the
# migration it expects. Nothing in the image applies it — compose seeds a fresh
# database volume via the Postgres entrypoint. See docs/DEPLOY.md.
COPY --chown=node:node db/   ./db/

# --- non-root ---------------------------------------------------------------
# The `node` user (uid/gid 1000) ships in the official image; creating another
# would be redundant. Everything above is already chowned to it, and nothing at
# runtime writes outside the container's tmpfs.
USER node

EXPOSE 3000

# --- healthcheck ------------------------------------------------------------
# Hits the real GET /api/health that src/server.js already serves.
#
# Uses node's built-in global fetch rather than curl or wget: alpine ships
# neither curl nor a wget that speaks HTTP well, and installing a package to ask
# a question the runtime can already answer adds attack surface for nothing.
#
# 127.0.0.1 rather than localhost — on a dual-stack container `localhost` can
# resolve to ::1 first while Express listens on 0.0.0.0, producing a health
# failure that is pure DNS and has nothing to do with the app.
#
# start-period covers boot: the server binds the port and serves /api/health
# immediately, then runs its first ingest pass in the background, so the check
# goes green well before the pipeline finishes. That is correct — this probes
# liveness of the HTTP surface, not completion of a pipeline pass.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)throw new Error('status '+r.status);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"

# Exec form: node is PID 1 and receives signals directly rather than being
# wrapped by a shell that swallows them. src/server.js installs no SIGTERM
# handler, so compose sets `init: true` to get a reaper that forwards and
# reaps properly — see docker-compose.yml.
CMD ["node", "src/server.js"]
