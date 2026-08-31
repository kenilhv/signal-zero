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
//  2. NO CONTEXT BLEED BETWEEN REPORTS. The session is reused across a run (it
//     is the expensive object), but every turn is sent with
//     `previousTurnId: "none"` so each classification is a fresh root turn.
//     Chaining would let one report's answer condition the next one's, which is
//     unacceptable for a classifier whose output feeds an audit trail.
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
let sessionId = null;
let sessionCreatedAt = null;
let sessionBinding = null; // BINDING.NAMED | BINDING.INLINE
let sessionAgentId = null; // TrueForge's immutable agent id, when named

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
    sessionId: null,
    sessionCreatedAt: null,
    // { turnId, status, totalTokens, inputTokens, outputTokens, cacheReadTokens,
    //   latencyMs, approvalRequired }
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

    // A cached session bound to an agent that has since disappeared/changed id
    // must not be reused - drop it so the next turn rebinds cleanly.
    if (sessionId && sessionBinding === BINDING.NAMED && sessionAgentId && facts.id !== sessionAgentId) {
      dropSession();
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
 * Create the tier-3 session, or reuse the one this process already has.
 *
 * PREFERRED: bind BY NAME to the registered agent. The instructions argument is
 * then IGNORED - the agent's own instructions live in TrueForge, which is the
 * whole point. It is passed in only to build the degraded inline spec.
 *
 * @param {string} instructions fallback system prompt (inline binding only)
 * @returns {Promise<{sessionId, created, binding, agentId}>}
 */
export async function ensureSession(instructions) {
  if (sessionId) {
    telemetry.sessionId = sessionId;
    telemetry.binding = sessionBinding;
    telemetry.agentId = sessionAgentId;
    telemetry.sessionCreatedAt = sessionCreatedAt;
    return { sessionId, created: false, binding: sessionBinding, agentId: sessionAgentId };
  }

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
  // request shape was honoured.
  const boundType = body.agent?.type ?? null;
  sessionBinding = boundType === 'reference' ? BINDING.NAMED : BINDING.INLINE;
  sessionAgentId = body.agent?.id ?? null;
  sessionId = id;
  sessionCreatedAt = new Date().toISOString();

  telemetry.sessionId = id;
  telemetry.sessionCreatedAt = sessionCreatedAt;
  telemetry.binding = sessionBinding;
  telemetry.agentId = sessionAgentId;

  return { sessionId: id, created: true, binding: sessionBinding, agentId: sessionAgentId };
}

/** Forget the cached session (used when a turn proves the session is gone). */
function dropSession() {
  sessionId = null;
  sessionCreatedAt = null;
  sessionBinding = null;
  sessionAgentId = null;
}

/** Exposed so a caller can force a rebind (e.g. after the roster is reloaded). */
export function resetSession() {
  dropSession();
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
  const c = await getClient();
  const { sessionId: sid, created, binding, agentId } = await ensureSession(instructions);

  let turnRes;
  try {
    turnRes = await c.sessions.createTurn(sid, {
      input: [{ type: 'user.message', content: prompt }],
      // Fresh root turn: reuse the session, never the conversation.
      previousTurnId: 'none'
    });
  } catch (err) {
    // A 404 means our cached session id is stale (server restarted, session
    // deleted, agent deleted). Drop it so the next report re-binds instead of
    // failing every remaining classification for the same dead reason.
    if (err?.statusCode === 404) dropSession();
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
  telemetry.turns.push({
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
    sessionCreatedAt,
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
