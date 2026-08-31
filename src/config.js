// Signal Zero - configuration.
// Every value has a sensible default so `npm install && npm start` works with
// NO .env file present at all. Missing credentials degrade the pipeline into
// offline / deterministic modes rather than crashing it.

import dotenv from 'dotenv';

dotenv.config();

function str(name, fallback = '') {
  const v = process.env[name];
  if (v === undefined || v === null) return fallback;
  const trimmed = String(v).trim();
  return trimmed === '' ? fallback : trimmed;
}

function bool(name, fallback = false) {
  const v = str(name, '');
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(name, fallback) {
  const n = Number.parseInt(str(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export const PORT = int('PORT', 3000);

// Bright Data powers the INGEST stage. Empty token => offline corpus.
export const BRIGHTDATA_API_TOKEN = str('BRIGHTDATA_API_TOKEN', '');

// LLM credentials. Used ONLY by triage tier 3 (low-confidence fallback).
// Never by dedup scoring, never by ranking - those stay deterministic.
export const OPENAI_API_KEY = str('OPENAI_API_KEY', '');
export const OPENAI_BASE_URL = str('OPENAI_BASE_URL', 'https://api.openai.com/v1');
export const OPENAI_MODEL = str('OPENAI_MODEL', 'gpt-4o-mini');

// TrueForge agent harness. Triage tier 3 - the one and only LLM touchpoint in
// Signal Zero - is executed as a TrueForge session turn rather than as a raw
// call to a model endpoint. The harness owns the agent loop; we read the result
// out of the turn it ran.
//
// Nothing here is load-bearing. If the harness is switched off or unreachable,
// tier 3 falls back to the direct OPENAI_* fetch below and writes a visible
// incident saying the fallback ran. See src/harness/trueforge.js.
export const TRUEFORGE_ENABLED = bool('TRUEFORGE_ENABLED', true);
export const TRUEFORGE_BASE_URL = str('TRUEFORGE_BASE_URL', 'http://localhost:4000');
// Must be a `provider/model` name registered in that TrueForge instance
// (GET /api/v1/models lists them). Not our OPENAI_MODEL: the harness resolves
// the model through its own stored provider credentials.
export const TRUEFORGE_MODEL = str('TRUEFORGE_MODEL', 'nebius/signal-zero-triage');
// The NAMED agent in the TrueForge registry that executes triage tier 3.
// scripts/load-agents.mjs registers it from agents/triage-agent.md, so the model,
// instructions, iteration limit, tool surface and approval policy all live in
// TrueForge - not in this repo. We bind a session to it BY NAME
// (`{"agent":{"name":"..."}}`), which is what makes the harness the thing doing
// the work rather than a transport we happen to POST through.
// If the name is not registered, tier 3 degrades to an inline AgentSpec and says
// so on the incident feed; it never silently pretends the roster was used.
export const TRUEFORGE_AGENT = str('TRUEFORGE_AGENT', 'signal-zero-triage-tier3');
// Wall-clock budget for one classification turn, poll included.
//
// This is a PER-TURN deadline, and turns now run concurrently, so it is not a
// budget for the stage: four turns that each take 13s cost 13s of wall clock,
// not 52s. Measured against this instance on the real ~8.3k-token prompt, a
// completed turn takes 6.8-13.1s, so 15s leaves roughly 2s of headroom over the
// slowest one observed. It is deliberately NOT raised to cover the cold-cache
// turns that overrun it: a turn that cannot answer inside the budget is one the
// direct-fetch fallback (~0.8s on Qwen3-30B-A3B) answers sooner, and raising
// the deadline would buy a slower answer, not a better one. Concurrency makes
// an overrun cheaper - it is now paid in parallel with the other turns - which
// is a reason to leave the deadline alone, not to loosen it.
export const TRUEFORGE_TIMEOUT_MS = int('TRUEFORGE_TIMEOUT_MS', 15000);
export const TRUEFORGE_POLL_MS = int('TRUEFORGE_POLL_MS', 350);
// How many TrueForge SESSIONS tier 3 may hold open at once.
//
// TrueForge serializes turns inside a single session, so one shared session was
// a silent serialization point: independent classifications queued behind each
// other. Measured with 4 identical small prompts against the tier-3 agent -
// shared session/4 concurrent 9470ms, sequential 3920ms, 4 SEPARATE sessions
// 1310ms. Sessions parallelise; a session does not.
//
// 4 because: tier 3 is hard-capped at 6 classifications per pass (MAX_LLM_CALLS
// in src/pipeline/triage.js), so a bigger pool cannot be used on a normal pass;
// a session is a real server-side object and the model provider behind TrueForge
// is the next bottleneck once the session stops being one, so this is bounded
// rather than "one per report"; and 4 is the width the benchmark above actually
// measured rather than one extrapolated from it.
export const TRUEFORGE_SESSION_POOL = int('TRUEFORGE_SESSION_POOL', 4);
// How many tier-3 classifications may be in flight at once. Clamped to the pool
// size at the call site: a turn that has to queue for a session would burn its
// TRUEFORGE_TIMEOUT_MS budget parked in that queue, which is a timeout the model
// never earned.
export const TRUEFORGE_TIER3_CONCURRENCY = int('TRUEFORGE_TIER3_CONCURRENCY', 4);

// --- ESCALATION DRAFTER (the second and last LLM touchpoint) ---------------
// Stage 5 holds an anomalously silent settlement for a NAMED human. The packet
// that human reads is DRAFTED by this registered agent, bound BY NAME - never as
// an inline spec, because the whole point is that its instructions (PREPARE
// NEVER SEND, NEVER NAME A DESTINATION, NEVER ASSERT HARM) live in the TrueForge
// registry. Every draft is run through src/guardrails/ before it is accepted; a
// violation blocks it and the deterministic template in checkpoint.js is used
// instead, with a visible incident. See src/harness/escalation-drafter.js.
export const TRUEFORGE_DRAFTER_AGENT = str('TRUEFORGE_DRAFTER_AGENT', 'signal-zero-escalation-drafter');
// Independent kill switch. TRUEFORGE_ENABLED=false disables this too.
export const TRUEFORGE_DRAFT_ENABLED = bool('TRUEFORGE_DRAFT_ENABLED', true);
// Much larger than tier 3's: a measured packet is ~940 output tokens and takes
// roughly 50s on this model. 15s would time out every single time.
export const TRUEFORGE_DRAFT_TIMEOUT_MS = int('TRUEFORGE_DRAFT_TIMEOUT_MS', 120000);
// How many escalations one pass may draft. Bounded because each is a ~50s turn
// and a pass that raises 8 escalations must not take seven minutes. Escalations
// beyond the budget get the template and SAY SO in their provenance; the next
// pass drafts the ones that are still undrafted.
export const TRUEFORGE_DRAFT_MAX_PER_PASS = int('TRUEFORGE_DRAFT_MAX_PER_PASS', 2);
// FAULT INJECTION for demonstrating the guardrail block path. Empty = off.
// 'guardrail' | 'certainty' | 'garbage'. Taints the model's returned text before
// the guardrail runs, and the injected span is recorded on the incident so a
// blocked draft raised this way is never mistaken for something the agent wrote.
export const TRUEFORGE_DRAFT_CHAOS = str('TRUEFORGE_DRAFT_CHAOS', '');

// Live scraping only makes sense when we actually have a Bright Data token.
export const USE_LIVE_SCRAPE = bool('USE_LIVE_SCRAPE', false) && BRIGHTDATA_API_TOKEN !== '';

export const config = {
  PORT,
  BRIGHTDATA_API_TOKEN,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
  TRUEFORGE_ENABLED,
  TRUEFORGE_BASE_URL,
  TRUEFORGE_MODEL,
  TRUEFORGE_AGENT,
  TRUEFORGE_TIMEOUT_MS,
  TRUEFORGE_POLL_MS,
  TRUEFORGE_SESSION_POOL,
  TRUEFORGE_TIER3_CONCURRENCY,
  TRUEFORGE_DRAFTER_AGENT,
  TRUEFORGE_DRAFT_ENABLED,
  TRUEFORGE_DRAFT_TIMEOUT_MS,
  TRUEFORGE_DRAFT_MAX_PER_PASS,
  TRUEFORGE_DRAFT_CHAOS,
  USE_LIVE_SCRAPE
};

export default config;
