#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Signal Zero — end-to-end proof that the registered roster actually runs.
//
// This does NOT re-derive the harness contract; it reproduces the flow that
// docs/trueforge-verified.md already established, but from a PERSISTENT NAMED
// AGENT instead of an inline AgentSpec. That distinction is the whole point:
//
//     {"agent":{"name":"signal-zero-triage-tier3"}}     <- named reference
//     {"agent":{"spec":{ ...500 lines of prompt... }}}  <- what we no longer do
//
// Two checks:
//
//   A. NAMED-REFERENCE TURN — create a session from `signal-zero-triage-tier3`
//      by name and run one real tier-3 classification end to end.
//
//   B. APPROVAL GATE — create a session from `signal-zero-ingest` by name, ask
//      for something that needs a tool, and prove the turn PAUSES at
//      `tool.approval_required`, then resume with an allow and show the
//      resulting `tool.response`.
//
// Two traps this script is built around, both from docs/trueforge-verified.md:
//   * The turn body field is `input`, not `messages`. A wrong body returns
//     HTTP 200 and fails INSIDE the run.
//   * HTTP 200 IS NOT SUCCESS. The result lives in `turn.state.status`. We poll
//     `GET /sessions/{id}/turns/{turn_id}` and only believe a terminal state.
//
// Usage:
//   node scripts/verify-agents.mjs             both checks
//   node scripts/verify-agents.mjs --only=a    named-reference turn only
//   node scripts/verify-agents.mjs --only=b    approval-gate proof only
//   TRUEFORGE_BASE_URL=... node scripts/verify-agents.mjs
// ---------------------------------------------------------------------------

const BASE = (process.env.TRUEFORGE_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'ab';
const POLL_MS = 2000;
const TIMEOUT_MS = 180000;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text for the error path */
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return json?.data ?? json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the turn reaches a terminal state. `done` may still be PAUSED. */
async function waitForTurn(sessionId, turnId) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const turn = await api('GET', `/api/v1/sessions/${sessionId}/turns/${turnId}`);
    const status = turn?.state?.status;
    if (status && status !== 'running') return turn;
    if (Date.now() > deadline)
      throw new Error(`turn ${turnId} still running after ${TIMEOUT_MS}ms`);
    await sleep(POLL_MS);
  }
}

async function sessionFromName(name) {
  // A NAMED reference. No spec, no instructions on the wire — TrueForge loads
  // the stored manifest, which is what makes this a persistent roster rather
  // than a prompt we keep re-pasting.
  const s = await api('POST', '/api/v1/sessions', { agent: { name } });
  return s.id;
}

async function runTurn(sessionId, input) {
  const turn = await api('POST', `/api/v1/sessions/${sessionId}/turns`, { input, stream: false });
  return waitForTurn(sessionId, turn.id);
}

function outputText(turn) {
  const c = turn?.state?.output?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => p.text ?? '').join('');
  return '';
}

function banner(t) {
  console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
}

// ---------------------------------------------------------------------------
// A. Named-reference turn on the tier-3 classifier.
// ---------------------------------------------------------------------------
async function checkNamedReference() {
  banner('A. NAMED-AGENT REFERENCE — signal-zero-triage-tier3');
  const agents = await api('GET', '/api/v1/agents');
  const agent = agents.find((a) => a.name === 'signal-zero-triage-tier3');
  if (!agent) throw new Error('signal-zero-triage-tier3 is not registered');
  console.log(`agent id      : ${agent.id}`);
  console.log(`instructions  : ${agent.manifest.instructions.length} chars (stored server-side)`);
  console.log(`tools         : ${JSON.stringify(agent.manifest.mcp_servers)}`);

  const sessionId = await sessionFromName('signal-zero-triage-tier3');
  console.log(`session id    : ${sessionId}   (created from {"agent":{"name":...}})`);

  // A genuine tier-3 residue item: tiers 1 and 2 cannot resolve "Syaphrubesi"
  // against the gazetteer's "Syabrubesi" with enough confidence, so it falls
  // through to the only LLM touchpoint in the system.
  const report = {
    id: 'r-verify-001',
    sourceType: 'news',
    sourceName: 'Kathmandu Post',
    url: 'https://kathmandupost.com/example-verify',
    title: 'Bridge at Syaphrubesi swept away as Bhote Koshi surges',
    text:
      'The suspension bridge linking Syaphrubesi to the north bank was swept away ' +
      'early on Wednesday as the Bhote Koshi rose several metres. Residents said ' +
      'the bazaar area was inundated. Contact with settlements upstream has not ' +
      'been re-established.',
    publishedAt: '2026-08-26T04:15:00Z'
  };

  // THE SAME PROMPT SHAPE THE PIPELINE SENDS. Without the candidate shortlist
  // this script was asking the agent a question triage never asks - no ids to
  // choose from - and the agent duly invented one. A verification that does not
  // reproduce the real request verifies nothing about the real path.
  const SHORTLIST = [
    'np-rasuwa-syabrubesi (Syabrubesi, Rasuwa)',
    'np-rasuwa-timure (Timure, Rasuwa)',
    'np-rasuwa-haku (Haku, Rasuwa)',
    'np-nuwakot-betrawati (Betrawati, Nuwakot)'
  ];
  const offeredIds = SHORTLIST.map((s) => s.split(' ')[0]);

  const turn = await runTurn(sessionId, [
    {
      type: 'user.message',
      content:
        'Classify this single low-confidence report as tier 3. Return only your ' +
        'JSON output contract.\n\n' +
        `REPORT ID: ${report.id}\n` +
        `SOURCE: ${report.sourceName} (${report.sourceType})\n` +
        `TITLE: ${report.title}\n` +
        `TEXT: ${report.text}\n\n` +
        `CANDIDATE SETTLEMENTS (or null if none apply):\n${SHORTLIST.join('\n')}`
    }
  ]);

  console.log(`turn id       : ${turn.id}`);
  console.log(`turn status   : ${turn.state.status}`);
  console.log(`metrics       : ${JSON.stringify(turn.state.metrics || {})}`);
  const raw = outputText(turn).trim();
  console.log('\n--- OUTPUT ---');
  console.log(raw);

  // ------------------------------------------------------------------------
  // VALIDATE THE ANSWER, NOT ONLY THE TRANSPORT.
  //
  // This check used to assert nothing beyond `status: "done"`, and it shipped a
  // hallucination as its success artifact: the agent answered
  // `"settlementId": "syaphrubesi"` and asserted, in its own rationale, that
  // that id "is present in the gazetteer" - it is not; the real id is
  // `np-rasuwa-syabrubesi`. parseTier3's allowlist would have clamped it to
  // null in the pipeline, so the system was never at risk, but a verification
  // script that would pass against a model hallucinating every field is not a
  // verification script. It now asserts what the pipeline asserts: the id is
  // one of the ones we OFFERED, or null.
  // ------------------------------------------------------------------------
  const parsed = (() => {
    try {
      return JSON.parse(
        raw
          .replace(/^\s*```(?:json)?/i, '')
          .replace(/```\s*$/, '')
          .trim()
      );
    } catch {
      return null;
    }
  })();
  const firstClassification = Array.isArray(parsed?.classifications)
    ? parsed.classifications[0]
    : parsed;
  const settlementId = firstClassification?.settlementId ?? null;
  const accepted = settlementId === null || offeredIds.includes(settlementId);

  console.log('\n--- OUTPUT VALIDATION ---');
  console.log(`parsed JSON   : ${parsed ? 'yes' : 'NO - unparseable'}`);
  console.log(`settlementId  : ${JSON.stringify(settlementId)}`);
  console.log(`offered       : ${offeredIds.join(', ')}`);
  console.log(
    `accepted      : ${accepted ? 'yes (offered, or null - the honest abstain)' : 'NO - NOT ON THE OFFERED SHORTLIST'}`
  );

  if (!parsed) {
    throw new Error(
      'check A: the agent did not return parseable JSON - transport worked, the contract did not'
    );
  }
  if (!accepted) {
    throw new Error(
      `check A: the agent returned settlementId "${settlementId}", which was never offered. ` +
        'parseTier3 would clamp this to null in the pipeline, but a verification script must FAIL on it rather than print it as proof.'
    );
  }

  return { sessionId, turnId: turn.id, status: turn.state.status, settlementId, validated: true };
}

// ---------------------------------------------------------------------------
// B. Approval gate on the ingest agent.
// ---------------------------------------------------------------------------
async function checkApprovalGate() {
  banner('B. APPROVAL GATE — signal-zero-ingest (bright-data, @all gated)');
  const sessionId = await sessionFromName('signal-zero-ingest');
  console.log(`session id    : ${sessionId}   (created from {"agent":{"name":...}})`);

  const first = await runTurn(sessionId, [
    {
      type: 'user.message',
      content:
        'Collect what the live web reports about the 26 August 2026 Trishuli / ' +
        'Bhote Koshi flood in Rasuwa district, Nepal. Use search_engine with the ' +
        'query: Trishuli flood Nepal Rasuwa August 2026.'
    }
  ]);

  console.log(`turn 1 id     : ${first.id}`);
  console.log(`turn 1 status : ${first.state.status}`);

  if (approvalsOf(first).length === 0) {
    console.log('\nNO APPROVAL EVENT — the gate did not fire. Output was:');
    console.log(outputText(first).trim().slice(0, 1200));
    throw new Error('expected tool.approval_required and did not get it');
  }

  // IMPORTANT: `state.status: "done"` does NOT mean the work finished — a turn
  // that stopped at an approval gate is also "done", with the pending decision
  // in `state.required_actions`. One allow is therefore not a completed run:
  // this agent searches, then wants to scrape what it found, and each of those
  // calls hits the `@all` gate separately. We drive every gate to a decision so
  // the "final output" we print is genuinely final and not a paused blank.
  // Headroom above the ingest agent's declared 6-call collection budget, so we
  // observe the agent STOPPING on its own rather than us capping it.
  const MAX_APPROVALS = 12;
  let turn = first;
  let turnNo = 1;
  const approved = [];

  while (approvalsOf(turn).length > 0 && approved.length < MAX_APPROVALS) {
    const ev = approvalsOf(turn)[0];
    const call = ev.tool_calls[0];
    const gated = await describeToolCall(sessionId, call.id);

    console.log(
      `\n--- tool.approval_required #${approved.length + 1} (turn ${turnNo} is PAUSED) ---`
    );
    console.log(`turn id       : ${turn.id}`);
    console.log(`turn status   : ${turn.state.status}   <- "done" here means PAUSED, not finished`);
    console.log(`thread_id     : ${ev.thread_id}`);
    console.log(`tool_call_id  : ${call.id}`);
    console.log(`gated tool    : ${gated.name}`);
    if (gated.args) console.log(`arguments     : ${gated.args.slice(0, 300)}`);
    console.log('resuming with : {"approval":{"status":"allow"}}');

    approved.push({ toolCallId: call.id, tool: gated.name });
    turnNo += 1;
    turn = await runTurn(sessionId, [
      {
        type: 'user.tool_approval',
        thread_id: ev.thread_id,
        tool_call_id: call.id,
        approval: { status: 'allow' }
      }
    ]);
  }

  console.log(`\nfinal turn id : ${turn.id}`);
  console.log(`final status  : ${turn.state.status}`);
  console.log(`pending gates : ${approvalsOf(turn).length}`);
  console.log(`metrics       : ${JSON.stringify(turn.state.metrics || {})}`);

  const events = await orderedEvents(sessionId);
  const responses = events.filter((e) => e.type === 'tool.response');
  console.log(`\ntool.response events: ${responses.length}`);
  for (const r of responses) {
    console.log(`  tool_call_id: ${r.tool_call_id}`);
    console.log(
      `  content (first 400 chars): ${String(r.content).slice(0, 400).replace(/\s+/g, ' ')}`
    );
  }

  console.log('\n--- FINAL OUTPUT ---');
  console.log(outputText(turn).trim().slice(0, 4000) || '(empty)');

  console.log('\n--- EVENT SEQUENCE (oldest first) ---');
  console.log(events.map((e) => e.type).join(' -> '));

  return {
    sessionId,
    pausedTurnId: first.id,
    finalTurnId: turn.id,
    approvalsFired: approved.length,
    approvedCalls: approved,
    status: turn.state.status,
    pendingGatesAtEnd: approvalsOf(turn).length,
    toolResponses: responses.length
  };
}

function approvalsOf(turn) {
  return (turn?.state?.required_actions || []).filter((a) => a.type === 'tool.approval_required');
}

/** Session events come back newest-first; sort by the monotonic ULID event id. */
async function orderedEvents(sessionId) {
  const items = await api('GET', `/api/v1/sessions/${sessionId}/events`);
  return items.map((i) => i.event).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Read the gated call out of the `model.message` that requested it, so we show
 * the tool TrueForge actually paused on rather than asserting it from the
 * prompt we sent.
 */
async function describeToolCall(sessionId, toolCallId) {
  const events = await orderedEvents(sessionId);
  for (const e of events) {
    if (e.type !== 'model.message' || !Array.isArray(e.tool_calls)) continue;
    for (const tc of e.tool_calls) {
      if (tc.id !== toolCallId) continue;
      const args = tc.tool?.arguments ?? tc.function?.arguments;
      return {
        name: tc.tool?.name || tc.function?.name || '(unknown)',
        args: args ? (typeof args === 'string' ? args : JSON.stringify(args)) : null
      };
    }
  }
  return { name: '(not found in events)', args: null };
}

async function main() {
  console.log(`TrueForge: ${BASE}`);
  const out = {};
  if (ONLY.includes('a')) out.namedReference = await checkNamedReference();
  if (ONLY.includes('b')) out.approvalGate = await checkApprovalGate();
  banner('SUMMARY');
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(`\nVERIFY FAILED: ${err.message}`);
  process.exitCode = 1;
});
