// Signal Zero - TrueForge harness client for the ESCALATION DRAFTER.
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR
// ----------------
// Stage 5 (checkpoint) holds a settlement whose silence looks anomalous and
// waits for a NAMED human to decide. The thing that human actually reads - the
// title, the summary, the score walkthrough, the benign explanations, the list
// of what is not known - used to be assembled by string templating in
// src/pipeline/checkpoint.js. It is now DRAFTED by the registered TrueForge
// agent `signal-zero-escalation-drafter`, and the template survives only as the
// fallback for when the harness cannot produce an acceptable draft.
//
// THIS IS THE SECOND OF EXACTLY TWO LLM TOUCHPOINTS IN SIGNAL ZERO.
// The first is triage tier 3 (src/harness/trueforge.js). Neither of them is
// allowed anywhere near dedup scoring or ranking math, which stay deterministic
// (Fellegi-Sunter, Exponential TBE, Getis-Ord Gi*). This module drafts PROSE
// ABOUT numbers that were already computed; it never produces a number, never
// re-orders anything, and its output is dropped wholesale if a guardrail fires.
//
// WHY THIS IS A SEPARATE MODULE FROM trueforge.js
// -----------------------------------------------
// trueforge.js owns a process-wide singleton session bound to
// `signal-zero-triage-tier3`, plus that agent's per-pass telemetry. Two agents
// cannot share one cached session id. Rather than thread an agent parameter
// through a verified, working code path (triage tier 3: binding "named-agent",
// executedByHarness 6 / fallback 0), this module keeps its own session, its own
// telemetry and its own probe. The duplication is deliberate and bounded.
//
// THREE THINGS THIS MODULE REFUSES TO DO
// --------------------------------------
//  1. NO INLINE SPEC, EVER. trueforge.js degrades to `{"agent":{"spec":{...}}}`
//     when its named agent is missing. This module does NOT. The entire point of
//     routing the drafter through TrueForge is that its ~14k characters of
//     instructions - PREPARE NEVER SEND, NEVER NAME A DESTINATION, NEVER ASSERT
//     HARM, ALWAYS INCLUDE BENIGN EXPLANATIONS - live in the registry and can be
//     edited there without a redeploy. An inline spec would smuggle a second,
//     divergent copy of those rules into this repo and let the pipeline claim
//     the registered agent drafted something it did not. If the name is not on
//     the roster, we say so and use the deterministic template.
//  2. NO TOOLS. The registered agent has `mcp_servers: []` on purpose: a drafter
//     with no tool cannot send, page, post or notify anything, which is Hard
//     Rule 1 enforced by construction rather than by instruction. This module
//     never sends a spec, so it cannot widen that surface even by accident, and
//     assertNoTools() below fails the draft loudly if the registry ever grows
//     one.
//  3. NO HTTP-200-IS-SUCCESS. `createTurn` returns while the turn is still
//     running. Only `turn.done.state.status === "done"` with real text is a
//     draft. Everything else raises, and the caller falls back.
//
// LATENCY, HONESTLY
// -----------------
// A measured draft on this instance: 8,087 input + 940 output tokens, ~50s wall
// clock. That is the model, not the harness. Two consequences, both handled by
// the caller rather than hidden here: the per-turn budget is much larger than
// tier 3's (TRUEFORGE_DRAFT_TIMEOUT_MS, default 120s), and only the top
// TRUEFORGE_DRAFT_MAX_PER_PASS escalations are drafted in a single pass. The
// rest get the template and SAY they got the template.
// ---------------------------------------------------------------------------

import config from '../config.js';

const PROBE_TIMEOUT_MS = 2500;
const TERMINAL = new Set(['done', 'error', 'cancelled']);

/**
 * How the escalation text was produced. This is the vocabulary the API and the
 * UI use, so it is defined once, here.
 */
export const DRAFT_SOURCE = {
  HARNESS: 'harness-drafted', // the registered agent wrote it and it passed every guardrail
  TEMPLATE: 'template' // deterministic string templating in checkpoint.js
};

/** Only one binding is acceptable for this agent. See point 1 above. */
export const BINDING = { NAMED: 'named-agent' };

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let SdkCtor; // undefined = not attempted, null = unavailable
let sdkLoadError = null;
let client = null;
let sessionId = null;
let sessionCreatedAt = null;
let sessionAgentId = null;

let agentFacts = freshAgentFacts();

function freshAgentFacts() {
  return {
    name: config.TRUEFORGE_DRAFTER_AGENT,
    registered: null, // null = not probed
    id: null,
    model: null,
    iterationLimit: null,
    maxTokens: null,
    instructionChars: null,
    // Read off the registry, not asserted from this repo. A drafter that grew a
    // tool is a different, more dangerous agent and we refuse to run it.
    mcpServers: [],
    toolCount: 0
  };
}

let telemetry = freshTelemetry();

function freshTelemetry() {
  return {
    enabled: isEnabled(),
    baseUrl: config.TRUEFORGE_BASE_URL,
    agentName: config.TRUEFORGE_DRAFTER_AGENT,
    agentId: null,
    agentRegistered: null,
    binding: null,
    reachable: null,
    sessionId: null,
    sessionCreatedAt: null,
    maxPerPass: config.TRUEFORGE_DRAFT_MAX_PER_PASS,
    turns: [],
    // Counted outcomes. drafted + templated === escalations created this pass.
    drafted: 0,
    templated: 0,
    guardrailBlocked: 0,
    parseRejected: 0,
    turnFailed: 0,
    budgetSkipped: 0,
    injectionBlocked: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    rules: [],
    // Every non-harness outcome, with its reason, so "it fell back" is never a
    // bare number the UI has to editorialise.
    fallbacks: [],
    lastError: null,
    checkedAt: null
  };
}

/** Reset per-pass counters. Called once per pipeline pass, before stage 5. */
export function beginPass() {
  telemetry = freshTelemetry();
  return telemetry;
}

/** Live telemetry. Treat as read-only. */
export function getTelemetry() {
  return telemetry;
}

/** What the last probe read off the registry. Treat as read-only. */
export function getAgentFacts() {
  return agentFacts;
}

/**
 * Switched on in config? Says nothing about reachability. Drafting rides on
 * TRUEFORGE_ENABLED as well - turning the harness off must turn off everything
 * that claims to be harness-executed, not just tier 3.
 */
export function isEnabled() {
  return config.TRUEFORGE_ENABLED === true && config.TRUEFORGE_DRAFT_ENABLED === true;
}

/** How many drafts this pass is allowed to attempt. */
export function budgetPerPass() {
  const n = Number(config.TRUEFORGE_DRAFT_MAX_PER_PASS);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Have we already spent the pass budget? */
export function budgetExhausted() {
  return telemetry.drafted + telemetry.guardrailBlocked + telemetry.parseRejected +
    telemetry.turnFailed >= budgetPerPass();
}

// ---------------------------------------------------------------------------
// SDK loading. A missing dependency degrades to the template; it never crashes.
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

async function getClient() {
  if (client) return client;
  const Ctor = await loadSdk();
  if (!Ctor) throw new Error(`TrueForge SDK unavailable: ${sdkLoadError || 'unknown reason'}`);
  client = new Ctor({
    environment: config.TRUEFORGE_BASE_URL.replace(/\/+$/, ''),
    timeoutInSeconds: Math.ceil(config.TRUEFORGE_DRAFT_TIMEOUT_MS / 1000) + 10,
    maxRetries: 0 // a silent SDK retry would hide a real failure
  });
  return client;
}

// ---------------------------------------------------------------------------
// Reachability + registry inspection
// ---------------------------------------------------------------------------

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
    const found = rows.find((a) => a?.name === config.TRUEFORGE_DRAFTER_AGENT);
    if (!found) {
      agentFacts.registered = false;
      return agentFacts;
    }
    const m = found.manifest || {};
    const servers = Array.isArray(m.mcp_servers) ? m.mcp_servers : [];
    agentFacts.registered = true;
    agentFacts.id = found.id || null;
    agentFacts.model = m.model?.name || null;
    agentFacts.maxTokens = m.model?.params?.max_tokens ?? null;
    agentFacts.iterationLimit = m.config?.iteration_limit ?? null;
    agentFacts.instructionChars = typeof m.instructions === 'string' ? m.instructions.length : null;
    agentFacts.mcpServers = servers.map((s) => s?.name).filter(Boolean);
    agentFacts.toolCount = servers.reduce(
      (n, s) => n + (Array.isArray(s?.enable_tools) ? s.enable_tools.length : 0),
      0
    );
    return agentFacts;
  } catch {
    agentFacts.registered = false;
    return agentFacts;
  }
}

/**
 * THE TOOLLESSNESS CHECK.
 *
 * `mcp_servers: []` on the registered drafter is a load-bearing safety property,
 * not a configuration detail: an agent with no tool cannot send, page, post or
 * notify, so "PREPARE, NEVER SEND" is true by construction and not merely by
 * instruction. This repo does not control the registry - somebody could attach a
 * server in the TrueForge UI - so we read it back on every probe and REFUSE to
 * draft if it grew one. Refusing is the safe direction: the deterministic
 * template still produces a packet, and the incident feed says why the agent was
 * not used.
 *
 * @returns {string|null} refusal reason, or null when the agent is toolless
 */
export function assertNoTools(facts = agentFacts) {
  if (!facts || facts.registered !== true) return null;
  if (facts.mcpServers.length === 0 && facts.toolCount === 0) return null;
  return (
    `agent "${facts.name}" has grown a tool surface (mcp_servers: ` +
    `${JSON.stringify(facts.mcpServers)}, ${facts.toolCount} tools). The drafter is ` +
    'toolless by construction - a drafter that can call a tool can send something. ' +
    'Refusing to draft; the deterministic template is used instead.'
  );
}

/**
 * Is TrueForge up, is our model registered, and is the DRAFTER on the roster?
 *
 * Unlike trueforge.js's probe there is no `degraded` outcome. Named binding or
 * nothing - see point 1 in the header.
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function probe() {
  telemetry.checkedAt = new Date().toISOString();
  telemetry.enabled = isEnabled();

  if (!isEnabled()) {
    telemetry.reachable = false;
    const reason = config.TRUEFORGE_ENABLED
      ? 'escalation drafting disabled by TRUEFORGE_DRAFT_ENABLED'
      : 'harness disabled by TRUEFORGE_ENABLED';
    telemetry.lastError = reason;
    return { ok: false, reason };
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
    if (models.length && !models.includes(config.TRUEFORGE_MODEL)) {
      telemetry.reachable = false;
      telemetry.lastError =
        `model "${config.TRUEFORGE_MODEL}" not registered (have: ${models.join(', ')})`;
      return { ok: false, reason: telemetry.lastError };
    }

    const facts = await readAgentFacts(base);
    telemetry.reachable = true;
    telemetry.agentRegistered = facts.registered;
    telemetry.agentId = facts.id;

    if (!facts.registered) {
      const reason =
        `agent "${config.TRUEFORGE_DRAFTER_AGENT}" is not registered at ${base}/api/v1/agents ` +
        '(run `node scripts/load-agents.mjs`). No inline spec is used for drafting - the ' +
        "agent's instructions must come from the registry - so escalations use the template.";
      telemetry.lastError = reason;
      return { ok: false, reason };
    }

    const toolRefusal = assertNoTools(facts);
    if (toolRefusal) {
      telemetry.lastError = toolRefusal;
      return { ok: false, reason: toolRefusal };
    }

    // A cached session bound to an agent that has since changed id must not be
    // reused - drop it so the next draft rebinds cleanly.
    if (sessionId && sessionAgentId && facts.id !== sessionAgentId) dropSession();

    telemetry.lastError = null;
    return { ok: true, reason: null };
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
// Session lifecycle
// ---------------------------------------------------------------------------

function dropSession() {
  sessionId = null;
  sessionCreatedAt = null;
  sessionAgentId = null;
}

/** Force a rebind (e.g. after the roster is reloaded). */
export function resetSession() {
  dropSession();
}

/**
 * Create the drafting session, or reuse this process's existing one.
 *
 * ONLY `{"agent":{"name":"signal-zero-escalation-drafter"}}` crosses the wire.
 * The binding is then read BACK off TrueForge's response - `agent.type` must be
 * `"reference"` - rather than assumed from the request shape. If TrueForge ever
 * answered with an inline agent we would throw here rather than let a draft
 * claim the registry produced it.
 */
export async function ensureSession() {
  if (sessionId) {
    telemetry.sessionId = sessionId;
    telemetry.sessionCreatedAt = sessionCreatedAt;
    telemetry.binding = BINDING.NAMED;
    telemetry.agentId = sessionAgentId;
    return { sessionId, created: false, agentId: sessionAgentId };
  }

  const c = await getClient();
  const res = await c.sessions.create({ agent: { name: config.TRUEFORGE_DRAFTER_AGENT } });

  const body = res?.data ?? res ?? {};
  const id = body.id ?? null;
  if (!id) throw new Error('session created but the response carried no id');

  const boundType = body.agent?.type ?? null;
  if (boundType !== 'reference') {
    throw new Error(
      `session ${id} bound as "${boundType}", not "reference" - refusing to draft, because ` +
        'only a registry-resolved agent may write the text a human signs'
    );
  }

  sessionId = id;
  sessionCreatedAt = new Date().toISOString();
  sessionAgentId = body.agent?.id ?? null;

  telemetry.sessionId = id;
  telemetry.sessionCreatedAt = sessionCreatedAt;
  telemetry.binding = BINDING.NAMED;
  telemetry.agentId = sessionAgentId;

  return { sessionId: id, created: true, agentId: sessionAgentId };
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * FAULT INJECTION - off unless TRUEFORGE_DRAFT_CHAOS is set.
 *
 * There is no honest way to *reliably* make a well-instructed agent emit
 * dispatch language on demand: the registered drafter refuses, which is the
 * point of it. But "the guardrail blocks model text and the escalation falls
 * back to the template" is a claim about OUR enforcement path, not about the
 * model, and it has to be demonstrable on command or nobody should believe it.
 *
 * So this taints the model's returned text on the way out of the turn, BEFORE
 * the guardrail sees it, exactly as a compromised or jailbroken model would. The
 * injected span is recorded on the turn facts and copied into the incident, so a
 * blocked draft raised this way can never be mistaken for something the agent
 * actually wrote.
 *
 * Values: 'guardrail' (no-dispatch violation), 'certainty' (honest-unknown
 * violation), 'garbage' (unparseable output).
 */
function applyChaos(text) {
  const mode = String(config.TRUEFORGE_DRAFT_CHAOS || '').trim().toLowerCase();
  if (!mode) return { text, chaos: null };

  if (mode === 'garbage') {
    return { text: 'not json at all', chaos: { mode, injected: '(replaced output with non-JSON)' } };
  }

  const injected = mode === 'certainty'
    ? 'Haku is confirmed silent and no residents remain.'
    : 'Dispatch a rescue team to Haku immediately and deploy the district response unit.';

  // Splice into the summary so it lands inside the human-facing prose, which is
  // where a real jailbreak would put it - not appended after the JSON where a
  // lazy parser would drop it before the guardrail ever ran.
  const marker = '"summary": "';
  const at = text.indexOf(marker);
  const tainted = at === -1
    ? `${text}\n${injected}`
    : text.slice(0, at + marker.length) + injected + ' ' + text.slice(at + marker.length);

  return { text: tainted, chaos: { mode, injected } };
}

/**
 * Run ONE drafting turn and wait for a terminal state.
 *
 * Throws on anything that is not a completed turn carrying text - including the
 * accepted-then-failed turn that looks like success if you only read the HTTP
 * status.
 *
 * @param {string} prompt the user message describing one ranked settlement
 * @returns {Promise<object>} turn facts, all read off TrueForge's own response
 */
export async function runDraftTurn(prompt) {
  const startedAt = Date.now();
  const c = await getClient();
  const { sessionId: sid, created, agentId } = await ensureSession();

  let turnRes;
  try {
    turnRes = await c.sessions.createTurn(sid, {
      input: [{ type: 'user.message', content: prompt }],
      // Fresh root turn. Reuse the session, never the conversation: one
      // settlement's packet must not condition the next one's.
      previousTurnId: 'none'
    });
  } catch (err) {
    if (err?.statusCode === 404) dropSession();
    throw new Error(`createTurn failed: ${err?.message || err}`);
  }

  const turnId = turnRes?.data?.id ?? turnRes?.id ?? null;
  if (!turnId) throw new Error('turn accepted but the response carried no turn id');

  let state = turnRes?.data?.state ?? turnRes?.state ?? null;
  const deadline = startedAt + config.TRUEFORGE_DRAFT_TIMEOUT_MS;

  while (!TERMINAL.has(state?.status)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `turn ${turnId} still ${state?.status || 'running'} after ${config.TRUEFORGE_DRAFT_TIMEOUT_MS}ms`
      );
    }
    await sleep(config.TRUEFORGE_POLL_MS);
    const got = await c.sessions.getTurn(sid, turnId);
    state = (got?.data ?? got)?.state ?? null;
  }

  if (state.status !== 'done') {
    throw new Error(
      `turn ${turnId} finished with status "${state.status}"` +
        (state.message ? `: ${state.message}` : '')
    );
  }

  const raw = textOf(state.output);
  if (!raw) throw new Error(`turn ${turnId} completed with no model message`);

  const { text, chaos } = applyChaos(raw);

  const m = state.metrics || {};
  const totalTokens = Number(m.total_tokens ?? m.totalTokens) || 0;
  const inputTokens = Number(m.total_input_tokens ?? m.totalInputTokens) || 0;
  const outputTokens = Number(m.total_output_tokens ?? m.totalOutputTokens) || 0;
  const cacheReadTokens = Number(m.total_cache_read_tokens ?? m.totalCacheReadTokens) || 0;
  const latencyMs = Date.now() - startedAt;

  telemetry.totalTokens += totalTokens;
  telemetry.inputTokens += inputTokens;
  telemetry.outputTokens += outputTokens;
  telemetry.cacheReadTokens += cacheReadTokens;
  telemetry.turns.push({ turnId, status: 'done', totalTokens, latencyMs, chaos: chaos?.mode ?? null });
  telemetry.reachable = true;

  return {
    text,
    rawText: raw,
    chaos,
    sessionId: sid,
    sessionCreatedAt,
    sessionReused: !created,
    binding: BINDING.NAMED,
    agentName: config.TRUEFORGE_DRAFTER_AGENT,
    agentId,
    turnId,
    model: agentFacts.model || config.TRUEFORGE_MODEL,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    latencyMs
  };
}

// ---------------------------------------------------------------------------
// Counters. checkpoint.js owns the decisions; this module owns the tally.
// ---------------------------------------------------------------------------

/** A draft the agent produced and every guardrail accepted. */
export function countDrafted(settlementId) {
  telemetry.drafted += 1;
  void settlementId;
}

/**
 * An escalation that used the deterministic template, and WHY.
 * @param {string} outcome one of 'guardrail-blocked' | 'parse-rejected' |
 *   'turn-failed' | 'unreachable' | 'budget' | 'injection-blocked' | 'disabled'
 */
export function countTemplated(outcome, reason, settlementId = null, rules = []) {
  telemetry.templated += 1;
  if (outcome === 'guardrail-blocked') telemetry.guardrailBlocked += 1;
  else if (outcome === 'parse-rejected') telemetry.parseRejected += 1;
  else if (outcome === 'turn-failed') telemetry.turnFailed += 1;
  else if (outcome === 'budget') telemetry.budgetSkipped += 1;
  else if (outcome === 'injection-blocked') telemetry.injectionBlocked += 1;
  for (const r of rules) if (!telemetry.rules.includes(r)) telemetry.rules.push(r);
  telemetry.fallbacks.push({
    settlementId,
    outcome,
    reason: String(reason || '').slice(0, 300),
    rules,
    at: new Date().toISOString()
  });
}

export function noteError(reason) {
  telemetry.lastError = String(reason || '').slice(0, 300);
}

export default {
  DRAFT_SOURCE,
  BINDING,
  beginPass,
  getTelemetry,
  getAgentFacts,
  isEnabled,
  budgetPerPass,
  budgetExhausted,
  probe,
  assertNoTools,
  ensureSession,
  resetSession,
  runDraftTurn,
  countDrafted,
  countTemplated,
  noteError
};
