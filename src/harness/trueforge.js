// Signal Zero - TrueForge harness client.
// ---------------------------------------------------------------------------
// This is the ONLY place Signal Zero talks to the TrueForge agent harness, and
// the harness is used for exactly ONE thing: executing triage tier 3, the
// low-confidence fallback classification. Nothing else in the system reaches an
// LLM at all - dedup scoring (Fellegi-Sunter) and ranking (Exponential TBE +
// Getis-Ord Gi*) are deterministic by construction and stay that way.
//
// WHAT "THE HARNESS DOES THE WORK" MEANS HERE
// -------------------------------------------
// We bind a session to a NAMED agent in the TrueForge registry:
//
//     POST /api/v1/sessions  {"agent": {"name": "signal-zero-triage-tier3"}}
//
// Not an inline spec. The agent was registered by scripts/load-agents.mjs from
// agents/triage-agent.md, so its model, its ~13k-character instructions (the
// four hard rules included), its iteration limit, its tool surface and its
// approval policy all live INSIDE TrueForge. This process sends a user message
// and reads a turn back. If someone edits the agent in the TrueForge UI, this
// pipeline's behaviour changes without a redeploy - which is the actual test of
// whether the harness is doing the work or is a transport we POST through.
//
// The inline AgentSpec below still exists, but only as a DEGRADED binding for
// when the named agent is missing from the registry. When it runs, the incident
// feed says the roster was not used, and telemetry reports binding:"inline-spec"
// so nothing downstream can claim the registered agent executed anything.
//
// TWO THINGS THIS MODULE IS DELIBERATELY STRICT ABOUT
// ---------------------------------------------------
//  1. HTTP 200 IS NOT SUCCESS. `createTurn` returns as soon as the turn is
//     accepted, with `state.status: "running"`; execution continues in the
//     background and a malformed request fails INSIDE the run. So we poll
//     `getTurn` and only treat `state.status === "done"` with real output as a
//     harness execution. Anything else is an error and triggers the fallback.
//  2. NO CONTEXT BLEED BETWEEN REPORTS. Sessions are pooled and reused across a
//     run (they are the expensive object), but every turn is sent with
//     `previousTurnId: "none"` so each classification is a fresh root turn.
//     Chaining would let one report's answer condition the next one's, which is
//     unacceptable for a classifier whose output feeds an audit trail. This is
//     also why tier 3 is NOT batched into one prompt: several reports in one
//     turn is context bleed by construction, and one prompt-injected scraped
//     report would then be sitting in its neighbours' context window.
//
// WHY A POOL AND NOT ONE SESSION
// ------------------------------
// TrueForge SERIALIZES turns inside a single session. One cached session
// therefore made the session a silent serialization point: four independent
// classifications that share nothing queued behind each other. Measured against
// this instance with four identical small prompts:
//
//     one shared session, 4 concurrent turns   9470ms wall (turn #1 alone
//                                              reported 9470ms - it was queueing)
//     one session, 4 sequential turns          3920ms wall
//     four SEPARATE sessions, 4 concurrent     1310ms wall
//
// So the fix is more sessions, not fewer turns. The pool is bounded
// (TRUEFORGE_SESSION_POOL, default 4) because a session is a real server-side
// object and because the model provider behind TrueForge is the next bottleneck
// once the session stops being one. Isolation is unchanged: a pooled session is
// still only ever asked for root turns.
//
// The harness is NEVER load-bearing for the demo. If TrueForge is unreachable,
// the caller falls back to the pre-existing direct-fetch path and says so on the
// incident feed. Three separate incidents cover the three ways that happens, and
// the third one exists because the first two did not cover it:
//
//   1. UNREACHABLE AT PASS START - the pre-pass probe fails, one incident names
//      the base URL, the reason and the fallback path.
//   2. PER CLASSIFICATION - each fallback-executed report gets its own
//      "Tier-3 FELL BACK to a direct model fetch (harness: <error>)" line.
//   3. FAILED MID-PASS - the probe passed and the container died while the pass
//      was running, which is exactly what a chaos test does. One incident is
//      emitted on the FIRST failed turn naming the executor switch, plus a
//      per-pass roll-up counting how many classifications the harness did not
//      execute. Without (3) the only account of a mid-run outage was (2), which
//      is per-report, says nothing about the pass, and never runs at all when
//      the fallback's own output is then blocked by the output guardrail.
//
// See triage.js tier 3.
// ---------------------------------------------------------------------------

import config from '../config.js';

// Reachability probe: cheap, unauthenticated, and short. Deliberately a raw
// fetch rather than an SDK call - we want "is the container up" answered in
// well under a second, before we spend the session-creation round trip.
const PROBE_TIMEOUT_MS = 2500;

/** Terminal turn states. Everything else means "still running". */
const TERMINAL = new Set(['done', 'error', 'cancelled']);

/** How a session is bound to an agent. Only the first one is the roster. */
export const BINDING = {
  NAMED: 'named-agent', // {"agent":{"name":"signal-zero-triage-tier3"}}
  INLINE: 'inline-spec' // {"agent":{"spec":{...}}} - degraded, announced
};

// ---------------------------------------------------------------------------
// Module state. Scoped to the process; reset at the start of each pipeline pass
// by beginPass() so a container that came back up is noticed on the next run.
// ---------------------------------------------------------------------------

let SdkCtor; // undefined = not yet attempted, null = unavailable
let sdkLoadError = null;
let client = null;

/**
 * THE SESSION POOL.
 *
 * @typedef {object} PooledSession
 * @property {string}      id        TrueForge session id
 * @property {string}      createdAt ISO timestamp of the create call
 * @property {string}      binding   BINDING.NAMED | BINDING.INLINE, READ BACK off
 *                                   TrueForge's own response - never assumed from
 *                                   the request we sent
 * @property {string|null} agentId   TrueForge's immutable agent id, when named
 * @property {boolean}     busy      held by an in-flight turn
 * @property {boolean}     dead      evicted (404 / stale bind); never reused
 */

/** Live sessions, busy or free. Never longer than the configured cap. */
let pool = [];
/** Session creations in flight. They hold a pool slot so the cap is not raced. */
let pendingCreates = 0;
/** Acquirers parked because the pool is at its cap and every session is busy. */
let waiters = [];
/** Sessions created during THIS pass. Reset by beginPass(); reported honestly. */
let sessionsCreatedThisPass = 0;
/** Acquisitions THIS pass that reused a session the pool already had. */
let sessionsReusedThisPass = 0;
/** Monotonic dispatch counter, so telemetry.turns stays in DISPATCH order. */
let turnSeq = 0;

/** The configured pool cap, floored at 1 - a pool of zero cannot run anything. */
function poolCap() {
  const n = Number(config.TRUEFORGE_SESSION_POOL);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * What the LAST probe learned about the registered agent. Facts read off
 * TrueForge's own manifest - never asserted from this repo's expectations.
 */
let agentFacts = freshAgentFacts();

function freshAgentFacts() {
  return {
    name: config.TRUEFORGE_AGENT,
    registered: null, // null = not probed
    id: null,
    model: null,
    iterationLimit: null,
    // Approval gating, read off the agent's own mcp_servers block. An agent with
    // no tools cannot have a gate fire, and we say that rather than implying a
    // gate we do not have. See docs/trueforge-verified.md - TrueForge's approval
    // gate is NOT Signal Zero's named-approver rule.
    approvalGate: { armed: false, tools: [], selectors: [] },
    toolCount: 0
  };
}

/** Per-pass telemetry. Everything the UI is allowed to claim comes from here. */
let telemetry = freshTelemetry();

function freshTelemetry() {
  return {
    enabled: config.TRUEFORGE_ENABLED,
    baseUrl: config.TRUEFORGE_BASE_URL,
    model: config.TRUEFORGE_MODEL,
    transport: 'sdk:@truefoundry/trueforge-sdk',
    agentName: config.TRUEFORGE_AGENT,
    agentId: null,
    agentRegistered: null, // null = not probed this pass
    binding: null, // set when a session exists
    reachable: null, // null = not probed this pass
    // The FIRST session this pass acquired, kept for compatibility with every
    // reader that predates the pool. `sessionIds` is the complete list.
    sessionId: null,
    sessionCreatedAt: null,
    sessionIds: [],
    // The pool, described only in facts it can prove: the configured cap, how
    // many sessions were actually CREATED this pass (0 on a pass that reused
    // everything), how many acquisitions reused one, and how many sessions are
    // live right now. It does NOT claim a parallelism it did not achieve - the
    // per-turn latencies in `turns` are the evidence for that.
    pool: { maxSize: poolCap(), created: 0, reused: 0, live: 0 },
    // { seq, sessionId, turnId, status, totalTokens, inputTokens, outputTokens,
    //   cacheReadTokens, latencyMs, approvalRequired }
    // Ordered by `seq` (dispatch order), NOT by completion order, so the same
    // input produces the same telemetry however the turns happen to interleave.
    turns: [],
    executedTurns: 0,
    fallbackClassifications: 0,
    unresolved: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    // Counted, not assumed: `armed` comes from the bound agent's manifest,
    // `fired` from turns that actually stopped for an approval decision.
    approvalGate: { armed: false, tools: [], fired: 0, resolved: 0 },
    // Guardrail enforcement, filled in by triage via countGuardrail().
    guardrail: { inputBlocked: 0, outputBlocked: 0, advisory: 0, rules: [] },
    lastError: null,
    checkedAt: null
  };
}

/**
 * Start a new pipeline pass. Clears per-pass counters and re-arms the
 * reachability probe (an operator restarting the container mid-demo should not
 * have to restart Signal Zero).
 */
export function beginPass() {
  telemetry = freshTelemetry();
  sessionsCreatedThisPass = 0;
  sessionsReusedThisPass = 0;
  turnSeq = 0;
  // The pool OUTLIVES a pass - that is the point of it - so `live` has to be
  // read off the pool itself. Left to the fresh defaults it would report zero
  // sessions on a pass that acquired none, which is a different and untrue
  // statement from "this pass created none".
  syncPoolTelemetry();
  // NOTE: the cached session/binding are deliberately NOT copied in. Telemetry
  // describes THIS pass. A session id carried over from a pass that ran turns,
  // reported next to executedTurns:0 on a pass where the container was down,
  // would read as evidence of an execution that did not happen. ensureSession()
  // fills these in the moment a turn actually uses the session - reused or new.
  return telemetry;
}

/** The live telemetry object. Safe to read; treat as read-only. */
export function getTelemetry() {
  return telemetry;
}

/** What the last probe read off the registry. Safe to read; read-only. */
export function getAgentFacts() {
  return agentFacts;
}

/** True when the harness is switched on in config. Says nothing about reachability. */
export function isEnabled() {
  return config.TRUEFORGE_ENABLED === true;
}

// ---------------------------------------------------------------------------
// SDK loading. Dynamic + guarded: a missing or broken dependency must degrade
// into the fallback path, never crash the server on boot.
// ---------------------------------------------------------------------------

async function loadSdk() {
  if (SdkCtor !== undefined) return SdkCtor;
  try {
    const mod = await import('@truefoundry/trueforge-sdk');
    SdkCtor = typeof mod.TrueForge === 'function' ? mod.TrueForge : null;
    if (!SdkCtor) sdkLoadError = 'module loaded but exported no TrueForge client';
  } catch (err) {
    SdkCtor = null;
    sdkLoadError = String(err && err.message ? err.message : err);
  }
  return SdkCtor;
}

// ---------------------------------------------------------------------------
// Reachability + registry inspection
// ---------------------------------------------------------------------------

/**
 * Read the named agent out of the registry and record what it actually says.
 * A missing agent is NOT an error here - it is a degraded binding, reported as
 * such - because a chaos test that deletes the agent should produce a visible,
 * specific incident rather than a dead pipeline.
 */
async function readAgentFacts(base) {
  agentFacts = freshAgentFacts();
  try {
    const res = await fetch(`${base}/api/v1/agents`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!res.ok) {
      agentFacts.registered = false;
      return agentFacts;
    }
    const json = await res.json();
    const rows = Array.isArray(json?.data) ? json.data : [];
    const found = rows.find((a) => a?.name === config.TRUEFORGE_AGENT);
    if (!found) {
      agentFacts.registered = false;
      return agentFacts;
    }
    const m = found.manifest || {};
    const servers = Array.isArray(m.mcp_servers) ? m.mcp_servers : [];
    const gatedTools = [];
    const selectors = [];
    for (const s of servers) {
      const sel = Array.isArray(s?.require_approval_for_tools) ? s.require_approval_for_tools : [];
      if (!sel.length) continue;
      selectors.push(...sel);
      const enabled = Array.isArray(s?.enable_tools) ? s.enable_tools : ['@all'];
      for (const t of enabled) gatedTools.push(`${s.name}:${t}`);
    }
    agentFacts.registered = true;
    agentFacts.id = found.id || null;
    agentFacts.model = m.model?.name || null;
    agentFacts.iterationLimit = m.config?.iteration_limit ?? null;
    agentFacts.toolCount = servers.reduce(
      (n, s) => n + (Array.isArray(s?.enable_tools) ? s.enable_tools.length : 0),
      0
    );
    agentFacts.approvalGate = {
      armed: gatedTools.length > 0,
      tools: gatedTools,
      selectors: [...new Set(selectors)]
    };
    return agentFacts;
  } catch {
    agentFacts.registered = false;
    return agentFacts;
  }
}

/**
 * Is a TrueForge server answering at TRUEFORGE_BASE_URL, with the model our
 * agent names and the agent itself registered?
 *
 * @returns {Promise<{ok, reason, models?, agentRegistered?, degraded?}>}
 *   `ok` means a harness turn can be attempted. `degraded` means it can be
 *   attempted but NOT through the registered roster.
 */
export async function probe() {
  telemetry.checkedAt = new Date().toISOString();

  if (!isEnabled()) {
    telemetry.reachable = false;
    telemetry.lastError = 'disabled by TRUEFORGE_ENABLED';
    return { ok: false, reason: 'disabled by TRUEFORGE_ENABLED' };
  }

  const base = config.TRUEFORGE_BASE_URL.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/v1/models`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!res.ok) {
      telemetry.reachable = false;
      telemetry.lastError = `models probe HTTP ${res.status}`;
      return { ok: false, reason: `HTTP ${res.status} from ${base}/api/v1/models` };
    }
    const json = await res.json();
    const models = Array.isArray(json?.data) ? json.data.map((m) => m?.name).filter(Boolean) : [];

    // Reachable but the model our agent names is not registered: the session
    // would be created and then every turn would fail. Say that now, precisely,
    // rather than letting it surface as a mystery turn error per report.
    if (models.length && !models.includes(config.TRUEFORGE_MODEL)) {
      telemetry.reachable = false;
      telemetry.lastError = `model "${config.TRUEFORGE_MODEL}" not registered (have: ${models.join(', ')})`;
      return { ok: false, reason: telemetry.lastError, models };
    }

    // The server is up. Now: is our NAMED agent on the roster?
    const facts = await readAgentFacts(base);
    telemetry.reachable = true;
    telemetry.agentRegistered = facts.registered;
    telemetry.agentId = facts.id;
    telemetry.approvalGate = {
      ...telemetry.approvalGate,
      armed: facts.approvalGate.armed,
      tools: facts.approvalGate.tools
    };

    if (!facts.registered) {
      // A named session would 404. We can still execute through the harness
      // with an inline spec, but that is a DIFFERENT, weaker claim.
      const reason =
        `agent "${config.TRUEFORGE_AGENT}" is not registered at ${base}/api/v1/agents ` +
        '(run `node scripts/load-agents.mjs`)';
      telemetry.lastError = reason;
      return { ok: true, degraded: true, reason, models, agentRegistered: false };
    }

    // A pooled session bound to an agent that has since disappeared/changed id
    // must not be reused - evict it so the next turn rebinds cleanly. Only the
    // stale ones go: a session bound to the agent that is still there is fine.
    for (const s of [...pool]) {
      if (s.binding === BINDING.NAMED && s.agentId && facts.id !== s.agentId) evictSession(s);
    }

    telemetry.lastError = null;
    return { ok: true, degraded: false, reason: null, models, agentRegistered: true };
  } catch (err) {
    const reason = err?.name === 'TimeoutError'
      ? `no response within ${PROBE_TIMEOUT_MS}ms`
      : String(err && err.message ? err.message : err);
    telemetry.reachable = false;
    telemetry.lastError = reason;
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------------------
// The DEGRADED inline AgentSpec. Used only when the named agent is absent from
// the registry. It is the triage-agent contract reduced to what tier 3 needs:
// text in, JSON classification out, no tools, no sandbox, no subagents, no
// generative UI. `mcpServers: []` is not decoration - a classifier with no tools
// cannot take an action, so there is nothing for require_approval_for_tools to
// gate. Signal Zero's named-approver rule is a separate, stricter guarantee
// enforced in src/server.js; the two are not substitutes for one another.
// ---------------------------------------------------------------------------

/**
 * @param {string} instructions System prompt for the classifier.
 * @returns {object} AgentSpec (SDK camelCase form)
 */
export function buildTriageAgentSpec(instructions) {
  return {
    model: {
      name: config.TRUEFORGE_MODEL,
      params: { temperature: 0, maxTokens: 512 }
    },
    instructions,
    mcpServers: [],
    skills: [],
    responseFormat: { type: 'json_object' },
    config: {
      iterationLimit: 3, // one classification; no reason to loop
      sandbox: { enabled: false },
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: false },
      askUserQuestions: { enabled: false }
    }
  };
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function getClient() {
  if (client) return client;
  const Ctor = await loadSdk();
  if (!Ctor) throw new Error(`TrueForge SDK unavailable: ${sdkLoadError || 'unknown reason'}`);
  client = new Ctor({
    environment: config.TRUEFORGE_BASE_URL.replace(/\/+$/, ''),
    timeoutInSeconds: Math.ceil(config.TRUEFORGE_TIMEOUT_MS / 1000),
    maxRetries: 0 // we own retry policy; a silent SDK retry would hide a real failure
  });
  return client;
}

/**
 * Create ONE new TrueForge session.
 *
 * PREFERRED: bind BY NAME to the registered agent. The instructions argument is
 * then IGNORED - the agent's own instructions live in TrueForge, which is the
 * whole point. It is passed in only to build the degraded inline spec.
 *
 * @param {string} instructions fallback system prompt (inline binding only)
 * @returns {Promise<PooledSession>}
 */
async function createSession(instructions) {
  const c = await getClient();
  const useNamed = agentFacts.registered !== false;

  let res;
  if (useNamed) {
    // THE POINT OF THE INTEGRATION: no spec crosses the wire. TrueForge resolves
    // the live agent - model, instructions, limits, tool policy - on every turn.
    res = await c.sessions.create({ agent: { name: config.TRUEFORGE_AGENT } });
  } else {
    res = await c.sessions.create({ agent: { spec: buildTriageAgentSpec(instructions) } });
  }

  const body = res?.data ?? res ?? {};
  const id = body.id ?? null;
  if (!id) throw new Error('session created but the response carried no id');

  // Read the binding back off TrueForge's own response rather than assuming the
  // request shape was honoured. Per session, because per session is where the
  // answer can differ.
  const boundType = body.agent?.type ?? null;
  return {
    id,
    createdAt: new Date().toISOString(),
    binding: boundType === 'reference' ? BINDING.NAMED : BINDING.INLINE,
    agentId: body.agent?.id ?? null,
    busy: false,
    dead: false
  };
}

/** Keep the pool counters in telemetry current. Facts only. */
function syncPoolTelemetry() {
  telemetry.pool = {
    maxSize: poolCap(),
    created: sessionsCreatedThisPass,
    reused: sessionsReusedThisPass,
    live: pool.length
  };
}

/**
 * Record an acquired session in this pass's telemetry.
 *
 * `sessionId`/`binding`/`agentId` are kept populated for every reader that
 * predates the pool. The binding is only ever allowed to get WEAKER within a
 * pass: if any session in the pool bound to an inline spec, this pass does not
 * get to claim the registered agent ran it because a different session happened
 * to bind by name.
 */
function noteAcquired(session) {
  if (!telemetry.sessionId) {
    telemetry.sessionId = session.id;
    telemetry.sessionCreatedAt = session.createdAt;
  }
  if (!telemetry.sessionIds.includes(session.id)) telemetry.sessionIds.push(session.id);
  if (telemetry.binding === null || session.binding === BINDING.INLINE) {
    telemetry.binding = session.binding;
    telemetry.agentId = session.agentId;
  }
  syncPoolTelemetry();
}

/** The first session that is neither busy nor evicted, marked busy. */
function takeFreeSession() {
  const s = pool.find((x) => !x.busy && !x.dead);
  if (s) s.busy = true;
  return s || null;
}

/**
 * Wake every parked acquirer. They re-check the pool and either take a free
 * session, create one in a slot that just opened, or park again. Waking all of
 * them (rather than one) is what makes a lost wakeup impossible; the pool is
 * small, so the re-check costs nothing.
 */
function wakeWaiters() {
  const parked = waiters;
  waiters = [];
  for (const resolve of parked) resolve();
}

/**
 * Take a session out of the pool for good. Used when a turn PROVES the session
 * is gone (404) and when the agent it was bound to changed underneath us.
 *
 * Only that session goes. The whole point of evicting one is that a dead
 * session must not poison every later turn, which is exactly what a single
 * shared session did.
 */
function evictSession(session) {
  if (!session) return;
  session.dead = true;
  const i = pool.indexOf(session);
  if (i >= 0) pool.splice(i, 1);
  syncPoolTelemetry();
  wakeWaiters(); // a slot just opened; somebody may be parked on it
}

/**
 * Acquire a session for ONE turn. The caller MUST release it.
 *
 * Reuse a free one; else create one if the pool is below its cap; else park
 * until a release or an eviction frees capacity.
 *
 * @param {string} instructions fallback system prompt (inline binding only)
 * @returns {Promise<{session: PooledSession, created: boolean}>}
 */
async function acquireSession(instructions) {
  for (;;) {
    const free = takeFreeSession();
    if (free) {
      sessionsReusedThisPass += 1;
      noteAcquired(free);
      return { session: free, created: false };
    }

    // `pendingCreates` holds a slot for a create that has not landed yet, so N
    // concurrent acquirers on an empty pool create N sessions, not N * cap.
    if (pool.length + pendingCreates < poolCap()) {
      pendingCreates += 1;
      let session;
      try {
        session = await createSession(instructions);
      } finally {
        pendingCreates -= 1;
        // A failed create released a slot. Whoever is parked can try again.
        if (!session) wakeWaiters();
      }
      session.busy = true;
      pool.push(session);
      sessionsCreatedThisPass += 1;
      noteAcquired(session);
      return { session, created: true };
    }

    await new Promise((resolve) => waiters.push(resolve));
  }
}

/**
 * Hand a session back.
 * @param {PooledSession} session
 * @param {{evict?: boolean}} [opts] evict:true removes it instead of reusing it
 */
function releaseSession(session, { evict = false } = {}) {
  if (!session) return;
  session.busy = false;
  if (evict || session.dead) {
    evictSession(session);
    return;
  }
  syncPoolTelemetry();
  wakeWaiters();
}

/**
 * Make sure a session exists and report what it is bound to.
 *
 * Kept as the module's public session entry point. It acquires from the pool
 * and immediately releases, so it never holds a slot: callers that just want to
 * know "is there a session, and is it bound by name" get an answer without
 * starving a turn.
 *
 * @param {string} instructions fallback system prompt (inline binding only)
 * @returns {Promise<{sessionId, created, binding, agentId}>}
 */
export async function ensureSession(instructions) {
  const { session, created } = await acquireSession(instructions);
  releaseSession(session);
  return {
    sessionId: session.id,
    created,
    binding: session.binding,
    agentId: session.agentId
  };
}

/**
 * Exposed so a caller can force a FULL rebind (e.g. after the roster is
 * reloaded). Every session goes, including ones a turn is still holding: those
 * are marked dead, so the in-flight turn finishes on the session it already has
 * and the session is dropped on release rather than handed to anyone else.
 */
export function resetSession() {
  for (const s of pool) s.dead = true;
  pool = [];
  syncPoolTelemetry();
  wakeWaiters();
}

/** Pull plain text out of a model.message, which may be a string or content parts. */
function textOf(output) {
  const content = output?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  return '';
}

/**
 * Did this turn stop for a human approval decision? TrueForge parks that in
 * `state.requiredActions`. We only count what is actually there - the tier-3
 * agent has no tools, so the honest answer for it is zero, every time.
 */
function approvalActionsOf(state) {
  const actions = Array.isArray(state?.requiredActions) ? state.requiredActions : [];
  return actions.filter((a) => String(a?.type || '').includes('approval'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * File a completed turn into telemetry.turns IN DISPATCH ORDER.
 *
 * Turns now overlap, so completion order depends on how the model happened to
 * schedule them - which would make the same input produce a differently ordered
 * telemetry array on every run. Insert by `seq` instead: identical input, an
 * identical list, whatever order the answers came back in.
 */
function recordTurn(record) {
  let i = telemetry.turns.length;
  while (i > 0 && telemetry.turns[i - 1].seq > record.seq) i -= 1;
  telemetry.turns.splice(i, 0, record);
}

/**
 * Run ONE classification turn through TrueForge and wait for it to reach a
 * terminal state.
 *
 * Throws on anything that is not a completed turn with text output - including
 * a turn that was accepted with HTTP 201 and then failed while running, which
 * is the failure mode that looks like success if you only read the status code.
 *
 * @param {string} instructions fallback system prompt (inline binding only)
 * @param {string} prompt       the user message for this report
 * @returns {Promise<object>} turn facts, all read off TrueForge's response
 */
export async function runTurn(instructions, prompt) {
  const startedAt = Date.now();
  const seq = ++turnSeq;
  const c = await getClient();
  // One session, held for this turn only, returned in the `finally` below. The
  // deadline starts BEFORE the acquire on purpose: a create is a real round trip
  // and charging it to the turn keeps the budget a wall-clock promise rather
  // than a model-time one. Callers must not run more turns at once than the pool
  // can hold, or the surplus would burn its budget parked in the queue.
  const { session, created } = await acquireSession(instructions);
  const sid = session.id;
  const binding = session.binding;
  const agentId = session.agentId;
  let evict = false;
  try {
    return await executeTurn({ c, session, sid, created, binding, agentId, prompt, startedAt, seq,
      markEvict: () => { evict = true; } });
  } finally {
    releaseSession(session, { evict });
  }
}

/** The body of one turn. Split out so `runTurn` owns acquire/release only. */
async function executeTurn({ c, session, sid, created, binding, agentId, prompt, startedAt, seq, markEvict }) {
  let turnRes;
  try {
    turnRes = await c.sessions.createTurn(sid, {
      input: [{ type: 'user.message', content: prompt }],
      // Fresh root turn: reuse the session, never the conversation.
      previousTurnId: 'none'
    });
  } catch (err) {
    // A 404 means THIS session id is stale (server restarted, session deleted,
    // agent deleted). Evict that one session so the next report re-binds instead
    // of failing every remaining classification for the same dead reason - and
    // so a single dead session cannot poison the rest of the pool.
    if (err?.statusCode === 404) markEvict();
    throw new Error(`createTurn failed: ${err?.message || err}`);
  }

  const turnId = turnRes?.data?.id ?? turnRes?.id ?? null;
  if (!turnId) throw new Error('turn accepted but the response carried no turn id');

  // --- poll to a terminal state -------------------------------------------
  // The HTTP status told us the turn was ACCEPTED. state.status tells us
  // whether it WORKED. Only the second one is the result.
  let state = turnRes?.data?.state ?? turnRes?.state ?? null;
  const deadline = startedAt + config.TRUEFORGE_TIMEOUT_MS;
  let approvalSeen = 0;

  while (!TERMINAL.has(state?.status)) {
    if (Date.now() >= deadline) {
      throw new Error(`turn ${turnId} still ${state?.status || 'running'} after ${config.TRUEFORGE_TIMEOUT_MS}ms`);
    }
    // A turn parked on an approval decision will never advance on its own. The
    // tier-3 agent has no tools so this cannot happen today; if the roster ever
    // gives it one, this is where it becomes visible instead of a timeout.
    approvalSeen += approvalActionsOf(state).length;
    await sleep(config.TRUEFORGE_POLL_MS);
    const got = await c.sessions.getTurn(sid, turnId);
    state = (got?.data ?? got)?.state ?? null;
  }

  approvalSeen += approvalActionsOf(state).length;

  if (state.status !== 'done') {
    throw new Error(
      `turn ${turnId} finished with status "${state.status}"` +
        (state.message ? `: ${state.message}` : '')
    );
  }

  const text = textOf(state.output);
  if (!text) {
    // `done` with a null output is a real TrueForge outcome (e.g. a turn that
    // ended paused). It is not a classification, so it is not a success.
    throw new Error(`turn ${turnId} completed with no model message`);
  }

  const m = state.metrics || {};
  const totalTokens = Number(m.totalTokens) || 0;
  const inputTokens = Number(m.totalInputTokens) || 0;
  const outputTokens = Number(m.totalOutputTokens) || 0;
  const cacheReadTokens = Number(m.totalCacheReadTokens) || 0;
  const latencyMs = Date.now() - startedAt;

  telemetry.executedTurns += 1;
  telemetry.totalTokens += totalTokens;
  telemetry.inputTokens += inputTokens;
  telemetry.outputTokens += outputTokens;
  telemetry.cacheReadTokens += cacheReadTokens;
  telemetry.approvalGate.fired += approvalSeen;
  recordTurn({
    seq,
    sessionId: sid,
    turnId,
    status: 'done',
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    latencyMs,
    approvalRequired: approvalSeen > 0
  });
  telemetry.reachable = true;

  return {
    text,
    sessionId: sid,
    sessionCreatedAt: session.createdAt,
    sessionReused: !created,
    binding,
    agentName: binding === BINDING.NAMED ? config.TRUEFORGE_AGENT : null,
    agentId,
    turnId,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    latencyMs,
    approvalRequired: approvalSeen > 0
  };
}

/** Count a classification that had to use the non-harness path. */
export function countFallback() {
  telemetry.fallbackClassifications += 1;
}

/** Count a classification that neither path could produce. */
export function countUnresolved() {
  telemetry.unresolved += 1;
}

/**
 * Count a guardrail verdict so /api/state can show enforcement as a number, not
 * only as prose in the incident feed.
 * @param {'input'|'output'} phase
 * @param {boolean} blocked
 * @param {string[]} rules
 */
export function countGuardrail(phase, blocked, rules = []) {
  if (blocked) {
    if (phase === 'input') telemetry.guardrail.inputBlocked += 1;
    else telemetry.guardrail.outputBlocked += 1;
  } else {
    telemetry.guardrail.advisory += 1;
  }
  for (const r of rules) if (!telemetry.guardrail.rules.includes(r)) telemetry.guardrail.rules.push(r);
}

/** Record the reason the harness could not be used, for the incident feed. */
export function noteError(reason) {
  telemetry.lastError = String(reason || '').slice(0, 300);
}

export default {
  BINDING,
  beginPass,
  getTelemetry,
  getAgentFacts,
  isEnabled,
  probe,
  ensureSession,
  resetSession,
  runTurn,
  buildTriageAgentSpec,
  countFallback,
  countUnresolved,
  countGuardrail,
  noteError
};
