// FAMILY D - HARNESS-LEVEL RESILIENCE
//
// The AgentBreak thesis: faults are inevitable, so what matters is what happens
// AFTER one. Every case here injects a REAL fault into a REAL dependency and
// then asks three questions of the system, in this order:
//
//   1. did it survive?          (the process must still be serving)
//   2. did it say so?           (a visible incident, in the system's own words)
//   3. did it stay honest?      (a fault must never be resolved into a guess -
//                                "we could not classify this" is the correct
//                                output, and it must be what actually appears)
//
// The faults are not simulated with mocks of our own code. They are injected at
// the wire: a stub TrueForge that returns HTML instead of JSON, a turn that is
// accepted and then dies, a turn that never terminates, a port with nothing
// behind it, and - once - the real container, stopped and restarted.
//
// D0 is the control. If a HEALTHY stub does not produce a real harness-executed
// classification, the stub is not a faithful double and nothing below it means
// anything, so D0 failing invalidates D1-D9 rather than just adding a red line.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Suite } from '../lib/runner.js';
import { runNode, runCmd, readJson, scratchPath, EVALS_DIR, ROOT } from '../lib/child.js';
import { startServer } from '../lib/server.js';
import { findDispatchKeys, findDispatchLanguage } from '../lib/guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAULT_PROBE = path.join(EVALS_DIR, 'probes', 'fault.mjs');
const EMPTY_PROBE = path.join(EVALS_DIR, 'probes', 'empty-ingest.mjs');

async function injectFault(mode, env = {}) {
  const out = scratchPath(`fault-${mode}.json`);
  const proc = await runNode(FAULT_PROBE, [out], {
    env: {
      FAULT_MODE: mode,
      TRUEFORGE_TIMEOUT_MS: '4000',
      TRUEFORGE_POLL_MS: '200',
      ...env
    },
    timeoutMs: 90000
  });
  return { proc, result: readJson(out, null) };
}

/** Did the system tell an operator, in the fail feed, that something broke? */
function incidentSaying(result, re) {
  return (result?.incidents || []).filter((i) => re.test(i.message));
}

export async function runFamilyD({ trueforgeUrl, port, dockerContainer, allowDocker }) {
  const suite = new Suite(
    'D. harness-level resilience',
    'Every case injects a real dependency fault and asserts what happened AFTER it: the process survives, the failure is visible in the fail feed, and nothing unresolved is quietly turned into a guess.'
  );

  // ==========================================================================
  // D0 - CONTROL. The fault harness must be able to produce a success.
  // ==========================================================================
  const control = await injectFault('healthy');
  const controlOk =
    control.result?.survived === true &&
    control.result.reports.some((r) => r.executor === 'trueforge-harness' && r.tier === 3);

  suite.check({
    id: 'D0',
    name: 'CONTROL: against a healthy TrueForge double, tier 3 really is executed by the harness - so every fault result below is a fault, not a broken test rig',
    pass: controlOk,
    severity: 'critical',
    evidence: {
      survived: control.result?.survived,
      executors: control.result?.reports.map((r) => ({
        id: r.id,
        tier: r.tier,
        executor: r.executor
      })),
      stubCalls: control.result?.stubCalls,
      exitCode: control.proc.code,
      stderr: control.proc.stderr.slice(-600)
    }
  });

  // D0b - the control must bind the way the PRODUCT binds. A double that only
  // ever exercises the inline-spec fallback tests a configuration nobody ships,
  // and every fault beneath it would be evidence about the wrong thing.
  suite.check({
    id: 'D0b',
    name: 'CONTROL BINDING: the healthy double is bound BY NAME to the registered agent (binding "named-agent", agent id read back off /api/v1/agents) - the fault cases below cover the binding the product actually ships, not an inline spec',
    pass:
      control.result?.telemetry?.binding === 'named-agent' &&
      control.result?.telemetry?.agentRegistered === true &&
      Boolean(control.result?.telemetry?.agentId) &&
      control.result?.stubCalls?.includes('GET /api/v1/agents'),
    severity: 'critical',
    evidence: {
      binding: control.result?.telemetry?.binding,
      agentRegistered: control.result?.telemetry?.agentRegistered,
      agentId: control.result?.telemetry?.agentId,
      registryProbed: control.result?.stubCalls?.includes('GET /api/v1/agents'),
      executors: control.result?.reports.map((r) => r.executor)
    }
  });

  // ==========================================================================
  // D1-D8 - one fault each
  // ==========================================================================
  const faults = [
    {
      id: 'D1',
      mode: 'dead-port',
      name: 'TrueForge is simply gone (nothing listening on the port)',
      incidentRe: /unreachable|FALLBACK|UNRESOLVED/i
    },
    {
      id: 'D2',
      mode: 'models-500',
      name: 'TrueForge answers, but its model registry returns HTTP 500',
      incidentRe: /HTTP 500|unreachable/i
    },
    {
      id: 'D3',
      mode: 'models-wrong-model',
      name: 'TrueForge is up but the model our AgentSpec names is not registered',
      incidentRe: /not registered|unreachable/i
    },
    {
      id: 'D4',
      mode: 'garbage-body',
      name: 'the turn endpoint returns HTML garbage instead of JSON',
      incidentRe: /FAILED|UNRESOLVED|createTurn/i
    },
    {
      id: 'D5',
      mode: 'turn-error-state',
      name: 'HTTP 201 accepted, then the turn dies inside the run (the failure that looks like success if you only read the status code)',
      incidentRe: /FAILED|UNRESOLVED|status "error"/i
    },
    {
      id: 'D6',
      mode: 'turn-never-finishes',
      name: 'the model never returns - the turn stays "running" forever',
      incidentRe: /FAILED|UNRESOLVED|still running/i,
      maxElapsedMs: 30000
    },
    {
      id: 'D7',
      mode: 'turn-done-no-output',
      name: 'the turn completes with status done but carries no model message',
      incidentRe: /FAILED|UNRESOLVED|no model message/i
    },
    {
      id: 'D8',
      mode: 'turn-prose-not-json',
      name: 'the model answers in prose instead of the JSON contract',
      incidentRe: /FAILED|UNRESOLVED/i
    },
    {
      id: 'D9',
      mode: 'session-404',
      name: 'the cached session is gone from under us (HTTP 404 on turn creation)',
      incidentRe: /FAILED|UNRESOLVED|createTurn/i
    },
    {
      id: 'D9a',
      mode: 'agents-500',
      name: 'the model registry is fine but the AGENT registry returns HTTP 500 - the named binding cannot be verified',
      // A registry we cannot read is not a registry that says "registered", so
      // the pass must announce a degraded binding rather than claim the roster.
      incidentRe: /NOT on the registry|INLINE|UNRESOLVED|FAILED/i,
      honestMode: 'no-named-claim'
    },
    {
      id: 'D9b',
      mode: 'agent-missing',
      name: 'TrueForge is healthy but our named agent has been deleted from the roster',
      incidentRe: /NOT on the registry|INLINE/i,
      honestMode: 'no-named-claim'
    },
    {
      id: 'D9c',
      mode: 'agent-deleted-midrun',
      name: 'the named agent is deleted from the registry BETWEEN turns - the chaos case the named binding itself introduces',
      incidentRe: /FAILED|UNRESOLVED|createTurn|404/i,
      // The first turn succeeds by design, so this mode is not asked to leave
      // everything unresolved - only to survive, to say what happened, and to
      // leave the turn it could not run genuinely unresolved.
      honestMode: 'partial-unresolved'
    }
  ];

  for (const f of faults) {
    const { proc, result } = await injectFault(f.mode);

    if (!result) {
      suite.check({
        id: f.id,
        name: f.name,
        pass: false,
        severity: 'critical',
        evidence: {
          note: 'the probe produced no output at all',
          exitCode: proc.code,
          stderr: proc.stderr.slice(-1200)
        }
      });
      continue;
    }

    const resolvedAnyway = result.reports.filter((r) => r.settlementId !== null);
    const incidents = incidentSaying(result, f.incidentRe);
    const bounded = f.maxElapsedMs ? result.elapsedMs <= f.maxElapsedMs : true;

    suite.check({
      id: `${f.id}.survive`,
      name: `${f.name} -> the pipeline stage SURVIVES the fault`,
      pass: result.survived === true && proc.code === 0,
      severity: 'critical',
      evidence: { survived: result.survived, threw: result.threw, exitCode: proc.code }
    });

    suite.check({
      id: `${f.id}.visible`,
      name: `${f.name} -> the failure is written to the fail feed where an operator can see it`,
      pass: incidents.length > 0,
      severity: 'critical',
      evidence: {
        matched: incidents.map((i) => i.message).slice(0, 3),
        allIncidents: (result.incidents || []).map((i) => `${i.kind}: ${i.message}`).slice(0, 6)
      }
    });

    // Two different faults, two different meanings of "honest".
    //
    //   A dead executor  -> nothing may be resolved at all.
    //   A dead ROSTER    -> the harness can still execute, on an INLINE spec, so
    //                       the honest property is that nothing CLAIMS the
    //                       registered agent ran. Asserting "all unresolved"
    //                       here would demand a hard failure where degrading is
    //                       the correct behaviour.
    const honest =
      f.honestMode === 'no-named-claim'
        ? {
            // The roster is unreadable, so NOTHING may claim the registered
            // agent ran. Both halves are load-bearing and both are checkable:
            // telemetry must not say "named-agent", and no classification may
            // carry the executor name reserved for a roster-bound turn.
            pass:
              result.telemetry?.binding !== 'named-agent' &&
              result.telemetry?.agentRegistered !== true &&
              result.reports.every((r) => r.executor !== 'trueforge-harness'),
            name: `${f.name} -> nothing claims the REGISTERED agent executed it: the binding degrades to an inline spec and telemetry says "inline-spec", not "named-agent"`,
            evidence: {
              binding: result.telemetry?.binding,
              agentRegistered: result.telemetry?.agentRegistered,
              executors: result.reports.map((r) => r.executor)
            }
          }
        : f.honestMode === 'partial-unresolved'
          ? {
              // The agent vanished mid-pass: the turn that ran before the deletion
              // is a real harness execution, the one after it is not a
              // classification at all and must be left unresolved rather than
              // completed from whatever the first turn happened to say.
              // Both halves are real: one turn MUST have executed through the
              // named binding (otherwise the fault was not mid-run and this mode
              // is testing nothing), and the turn after the deletion MUST be
              // unresolved with executor "none".
              pass:
                result.reports.some((r) => r.executor === 'trueforge-harness') &&
                result.reports.some((r) => r.executor === 'none' && r.settlementId === null),
              name: `${f.name} -> one turn really did execute through the named binding BEFORE the deletion, and the turn after it is left UNRESOLVED with executor "none" - a deleted agent does not get its classification completed from the previous turn`,
              evidence: {
                executors: result.reports.map((r) => ({
                  id: r.id,
                  executor: r.executor,
                  settlementId: r.settlementId
                })),
                binding: result.telemetry?.binding
              }
            }
          : {
              pass:
                resolvedAnyway.length === 0 &&
                result.reports.every(
                  (r) => r.executor === 'none' || r.executor === undefined || r.executor === null
                ),
              name: `${f.name} -> nothing is invented: a classification the harness could not make is left UNRESOLVED, not guessed`,
              evidence: {
                reports: result.reports.map((r) => ({
                  id: r.id,
                  settlementId: r.settlementId,
                  tier: r.tier,
                  executor: r.executor,
                  confidence: r.confidence
                }))
              }
            };

    suite.check({
      id: `${f.id}.honest`,
      name: honest.name,
      pass: honest.pass,
      severity: 'critical',
      evidence: {
        ...honest.evidence,
        reports: result.reports.map((r) => ({
          id: r.id,
          settlementId: r.settlementId,
          tier: r.tier,
          executor: r.executor,
          confidence: r.confidence
        }))
      }
    });

    if (f.maxElapsedMs) {
      suite.check({
        id: `${f.id}.bounded`,
        name: `${f.name} -> the wait is BOUNDED: the stage gives up inside its configured budget instead of hanging`,
        pass: bounded,
        severity: 'critical',
        evidence: {
          elapsedMs: result.elapsedMs,
          budgetMs: f.maxElapsedMs,
          configuredTimeoutMs: 4000
        }
      });
    }

    suite.metric(`${f.id}.elapsedMs`, result.elapsedMs);
  }

  // ==========================================================================
  // D10 - POISONED MODEL OUTPUT. The fault is not that the model failed; it is
  //       that the model SUCCEEDED and returned an attack.
  // ==========================================================================
  {
    const { result } = await injectFault('turn-injected-instructions');
    if (!result) {
      suite.check({
        id: 'D10',
        name: 'a compromised model returning a poisoned classification cannot smuggle a dispatch field or inflated confidence into the store',
        pass: false,
        severity: 'critical',
        evidence: { note: 'probe produced no output' }
      });
    } else {
      const emitted = result.reports.map((r) => r.triage);
      const keyHits = findDispatchKeys(emitted);
      const overConfident = result.reports.filter((r) => Number(r.confidence) > 0.7);

      // The ANSWER the system would publish, scanned with no exemptions at all.
      const answers = result.reports.map((r) => ({
        settlementId: r.settlementId,
        category: r.category,
        matchedOn: r.matchedOn,
        llmWhy: r.llmWhy,
        executor: r.executor
      }));
      const answerLangHits = findDispatchLanguage(answers);

      suite.check({
        id: 'D10.1',
        name: 'a poisoned model response carrying dispatch/assignedTo fields cannot get those FIELDS into the stored classification',
        pass: keyHits.length === 0,
        severity: 'critical',
        evidence: { hits: keyHits, storedTriage: emitted }
      });

      suite.check({
        id: 'D10.2',
        name: "the model's injected confidence of 0.99 does not survive - the stored confidence stays at or below the tier-3 ceiling of 0.7",
        pass: overConfident.length === 0,
        severity: 'critical',
        evidence: {
          confidences: result.reports.map((r) => ({ id: r.id, confidence: r.confidence }))
        }
      });

      suite.check({
        id: 'D10.3',
        name: 'no dispatch language from the poisoned response reaches the published ANSWER (category, matchedOn, the model\'s own "why") - scanned with no exemptions',
        pass: answerLangHits.length === 0,
        severity: 'critical',
        evidence: { hits: answerLangHits, answers }
      });

      // The poisoned response is DISCARDED, not repaired into something that
      // reads clean - which is the difference between a guardrail and a filter.
      const discarded = result.reports.every(
        (r) =>
          r.settlementId === null && r.executor === 'none' && r.triage?.guardrail?.blocked === true
      );
      suite.check({
        id: 'D10.4',
        name: 'the poisoned classification is DISCARDED and the report left unresolved - a model that returns an attack does not get a partial answer through',
        pass: discarded,
        severity: 'critical',
        evidence: {
          reports: result.reports.map((r) => ({
            id: r.id,
            settlementId: r.settlementId,
            executor: r.executor,
            guardrail: r.triage?.guardrail ?? null
          }))
        }
      });

      // Same quotation rule family C applies: the guardrail is allowed to quote
      // what it refused, but ONLY inside a record marked as a block.
      const quoteViolations = [];
      for (const inc of result.incidents || []) {
        const hits = findDispatchLanguage({ m: inc.message, d: inc.detail });
        const exempt =
          (inc.detail?.blocked === true && inc.detail?.component === 'guardrail') ||
          // An agent refusal names the rule it cited; a rule name is not an order.
          (inc.kind === 'agent-refusal' && inc.detail?.refused === true);
        if (hits.length && !exempt) {
          quoteViolations.push({
            message: inc.message.slice(0, 200),
            hits: hits.map((h) => h.pattern)
          });
        }
      }
      for (const r of result.reports) {
        const g = r.triage?.guardrail;
        if (!g) continue;
        const hits = findDispatchLanguage({ g });
        if (hits.length && g.blocked !== true) {
          quoteViolations.push({
            where: `report ${r.id} guardrail`,
            hits: hits.map((h) => h.pattern)
          });
        }
      }
      suite.check({
        id: 'D10.5',
        name: 'the refused payload is quoted back ONLY inside a guardrail block record - an operator can see what was blocked, and nowhere else carries the wording',
        pass: quoteViolations.length === 0,
        severity: 'critical',
        evidence: {
          violations: quoteViolations,
          blockRecordSummary: result.reports
            .map((r) => r.triage?.guardrail?.summary)
            .filter(Boolean)
        }
      });
    }
  }

  // ==========================================================================
  // D10b - A PRINCIPLED REFUSAL IS NOT A CRASH.
  //
  //   The agent citing a hard rule at an injected dispatch request is the best
  //   thing this system can do under attack. It used to be recorded exactly like
  //   a malformed response - JSON parse error, generic tier-3 failure - which
  //   made the strongest evidence of the guardrails working invisible.
  // ==========================================================================
  for (const [id, mode, shape] of [
    ['D10b', 'turn-prose-refusal', 'in prose'],
    ['D10c', 'turn-structured-refusal', 'inside the JSON contract']
  ]) {
    const { result } = await injectFault(mode);
    const refusals = (result?.incidents || []).filter((i) => i.kind === 'agent-refusal');
    const miscounted = (result?.incidents || []).filter(
      (i) => i.kind === 'llm-fallback' && /FAILED|not valid JSON/i.test(i.message)
    );

    suite.check({
      id: `${id}.1`,
      name: `an agent that REFUSES ${shape}, citing a hard rule, is recorded as a refusal - a distinct incident kind naming the rule - and not as a tier-3 failure`,
      pass:
        refusals.length > 0 &&
        refusals.every((i) => i.detail?.refused === true && Boolean(i.detail?.citedRule)) &&
        miscounted.length === 0,
      severity: 'critical',
      evidence: {
        refusalIncidents: refusals.map((i) => ({
          kind: i.kind,
          citedRule: i.detail?.citedRule,
          message: i.message.slice(0, 160)
        })),
        miscountedAsFailure: miscounted.map((i) => i.message.slice(0, 160)),
        allKinds: (result?.incidents || []).map((i) => i.kind)
      }
    });

    suite.check({
      id: `${id}.2`,
      name: `a refusal still leaves the report UNRESOLVED - refusing is not classifying, and the system must not fill the gap with a guess`,
      pass:
        result?.survived === true &&
        result.reports.every((r) => r.settlementId === null && r.executor === 'none'),
      severity: 'critical',
      evidence: {
        reports: result?.reports.map((r) => ({
          id: r.id,
          settlementId: r.settlementId,
          executor: r.executor
        }))
      }
    });
  }

  // ==========================================================================
  // D11 - EMPTY INGEST
  // ==========================================================================
  {
    const out = scratchPath('empty-ingest.json');
    const proc = await runNode(EMPTY_PROBE, [out], { timeoutMs: 60000 });
    const result = readJson(out, null);

    suite.check({
      id: 'D11.1',
      name: 'an ingest that returns zero reports does not break the pipeline - every downstream stage still runs',
      pass: result?.survived === true && result.stages.ranked > 0,
      severity: 'critical',
      evidence: {
        survived: result?.survived,
        threw: result?.threw,
        stages: result?.stages,
        exitCode: proc.code
      }
    });

    suite.check({
      id: 'D11.2',
      name: 'with zero reports every settlement is labelled cohort-cold-start, holds zero corroborations, and has a null last-report time',
      pass:
        result &&
        JSON.stringify(result.stages.coverageBases) === JSON.stringify(['cohort-cold-start']) &&
        result.stages.corroborationTotal === 0 &&
        result.stages.lastReportAtAllNull === true,
      severity: 'critical',
      evidence: {
        coverageBases: result?.stages.coverageBases,
        corroborationTotal: result?.stages.corroborationTotal,
        lastReportAtAllNull: result?.stages.lastReportAtAllNull
      }
    });

    suite.check({
      id: 'D11.3',
      name: 'with zero reports the rate is the stated prior ("prior" fit basis) and still inside its clamped bounds - no data invents no cadence',
      pass:
        result &&
        JSON.stringify(result.stages.fitBases) === JSON.stringify(['prior']) &&
        result.stages.lambdaRange[0] >= 1 / 72 - 1e-6 &&
        result.stages.lambdaRange[1] <= 1 / 2 + 1e-6,
      severity: 'critical',
      evidence: { fitBases: result?.stages.fitBases, lambdaRange: result?.stages.lambdaRange }
    });

    suite.check({
      id: 'D11.4',
      name: 'an empty ingest is announced in the fail feed as a cold start, not passed over in silence',
      pass: (result?.incidents || []).some((i) => i.kind === 'cold-start'),
      severity: 'major',
      evidence: {
        incidents: (result?.incidents || []).map((i) => `${i.kind}: ${i.message}`).slice(0, 4)
      }
    });
  }

  // ==========================================================================
  // D12 - SERVER LEVEL. Boot the real app against a dead TrueForge and prove it
  //       keeps serving, keeps ranking, and says what broke.
  // ==========================================================================
  {
    const deadPort = 4999;
    const server = await startServer({
      port,
      env: {
        TRUEFORGE_ENABLED: 'true',
        TRUEFORGE_BASE_URL: `http://127.0.0.1:${deadPort}`,
        TRUEFORGE_TIMEOUT_MS: '4000',
        OPENAI_API_KEY: '',
        USE_LIVE_SCRAPE: 'false'
      }
    });
    try {
      suite.check({
        id: 'D12.1',
        name: 'the app boots and serves with TrueForge pointed at a dead port - the harness is never load-bearing',
        pass: server.healthy,
        severity: 'critical',
        evidence: { healthy: server.healthy, stderr: server.log.stderr.slice(-800) }
      });

      if (server.healthy) {
        const run = await server.post('/api/run', {});
        const state = await server.waitForState({ timeoutMs: 90000 });
        const payload = state.json || {};

        suite.check({
          id: 'D12.2',
          name: 'a pipeline pass against a dead harness still returns HTTP 200 and still produces a full ranking',
          pass: run.status === 200 && (payload.settlements || []).length > 0,
          severity: 'critical',
          evidence: { runStatus: run.status, ranked: (payload.settlements || []).length }
        });

        const harnessIncidents = (payload.incidents || []).filter((i) =>
          /trueforge|harness/i.test(i.message)
        );
        suite.check({
          id: 'D12.3',
          name: 'the dead harness is reported as a visible incident naming TrueForge and the fallback path that ran instead',
          pass: harnessIncidents.length > 0,
          severity: 'critical',
          evidence: { incidents: harnessIncidents.map((i) => i.message).slice(0, 3) }
        });

        suite.check({
          id: 'D12.4',
          name: 'the harness is never described as "live" when it executed nothing',
          pass:
            payload.harness === null ||
            payload.harness.reachable !== true ||
            (payload.harness.executedByHarness ?? 0) === 0,
          severity: 'critical',
          evidence: { harness: payload.harness, sources: payload.sources }
        });

        // still serving AFTER the fault, which is the actual question
        const after = await server.get('/api/health');
        suite.check({
          id: 'D12.5',
          name: 'the process is still alive and answering after the fault',
          pass: after.status === 200 && server.alive(),
          severity: 'critical',
          evidence: { health: after.status, alive: server.alive(), exited: server.log.exited }
        });

        // --- D13 hostile HTTP -------------------------------------------------
        const hostile = [
          [
            'malformed JSON body',
            () => server.post('/api/checkpoint/nope/approve', undefined, { rawBody: '{not json' })
          ],
          ['deeply nested body', () => server.post('/api/run', JSON.parse(nest(120)))],
          ['unknown api route', () => server.get('/api/definitely-not-a-route')],
          ['path traversal', () => server.get('/../../package.json')],
          ['unknown demo failure kind', () => server.post('/api/demo/fail/not-a-kind', {})],
          ['missing settlement', () => server.get('/api/settlement/does-not-exist')],
          [
            'approve a missing item',
            () => server.post('/api/checkpoint/esc-nope/approve', { approvedBy: 'A' })
          ]
        ];
        const crashed = [];
        const statuses = [];
        for (const [label, fn] of hostile) {
          const res = await fn();
          statuses.push({ label, status: res.status });
          if (res.status === 0) crashed.push({ label, error: res.error });
        }
        const stillUp = await server.get('/api/health');
        suite.check({
          id: 'D13.1',
          name: 'seven malformed or hostile requests are answered with a status code, not a crash, and the server is still healthy afterwards',
          pass: crashed.length === 0 && stillUp.status === 200 && server.alive(),
          severity: 'critical',
          evidence: { statuses, crashed, healthAfter: stillUp.status }
        });

        // --- D14 concurrency ---------------------------------------------------
        const [a, b] = await Promise.all([
          server.post('/api/run', {}),
          server.post('/api/run', {})
        ]);
        const codes = [a.status, b.status].sort();
        suite.check({
          id: 'D14.1',
          name: 'two concurrent pipeline runs do not interleave: one runs, the other is refused with HTTP 409',
          pass: codes[0] === 200 && codes[1] === 409,
          severity: 'major',
          evidence: { statuses: [a.status, b.status], bodies: [a.json, b.json] }
        });

        const finalState = await server.get('/api/state');
        suite.check({
          id: 'D14.2',
          name: 'after every fault above, the served payload is still structurally intact and still free of dispatch-shaped fields',
          pass:
            (finalState.json?.settlements || []).length > 0 &&
            findDispatchKeys(finalState.json || {}).length === 0,
          severity: 'critical',
          evidence: {
            ranked: (finalState.json?.settlements || []).length,
            dispatchKeys: findDispatchKeys(finalState.json || {})
          }
        });
      }
    } finally {
      await server.stop();
    }
  }

  // ==========================================================================
  // D15 - THE REAL CONTAINER. Stop it, prove the app degrades, restart it, and
  //       prove the app notices the recovery without being restarted itself.
  //       Wrapped so the container is restored on ANY outcome.
  // ==========================================================================
  if (!allowDocker) {
    suite.skip({
      id: 'D15',
      name: 'stopping the real TrueForge container and restoring it',
      reason:
        'docker was not available or --no-docker was passed; the dead-port and stub variants ran instead, but the real container was NOT exercised',
      severity: 'major'
    });
  } else {
    let stopped = false;
    try {
      const before = await dockerRunning(dockerContainer);
      if (!before) {
        suite.skip({
          id: 'D15',
          name: 'stopping the real TrueForge container and restoring it',
          reason: `container "${dockerContainer}" was not running before the test, so there was nothing to stop`,
          severity: 'major'
        });
      } else {
        const stop = await docker(['stop', dockerContainer]);
        stopped = stop.code === 0;

        suite.check({
          id: 'D15.1',
          name: 'the real TrueForge container can be stopped (fault injected for real, not simulated)',
          pass: stopped,
          severity: 'major',
          evidence: { exitCode: stop.code, stderr: stop.stderr.slice(-300) }
        });

        // The harness must report it as unreachable and the stage must degrade.
        const downOut = scratchPath('fault-real-container-down.json');
        const downProc = await runNode(FAULT_PROBE, [downOut], {
          env: {
            FAULT_MODE: 'real',
            TRUEFORGE_BASE_URL: trueforgeUrl,
            TRUEFORGE_TIMEOUT_MS: '5000'
          },
          timeoutMs: 90000
        });
        const down = readJson(downOut, null);

        suite.check({
          id: 'D15.2',
          name: 'with the real container stopped, triage survives, reports the outage, and leaves the classification unresolved rather than guessing',
          pass:
            down?.survived === true &&
            down.reports.every((r) => r.settlementId === null) &&
            (down.incidents || []).some((i) => /TrueForge|harness/i.test(i.message)),
          severity: 'critical',
          evidence: {
            survived: down?.survived,
            reports: down?.reports.map((r) => ({
              id: r.id,
              settlementId: r.settlementId,
              executor: r.executor
            })),
            incidents: (down?.incidents || []).map((i) => i.message).slice(0, 3),
            exitCode: downProc.code
          }
        });
      }
    } catch (err) {
      suite.check({
        id: 'D15.2',
        name: 'with the real container stopped, triage degrades honestly',
        pass: false,
        severity: 'critical',
        evidence: { threw: String(err) }
      });
    } finally {
      if (stopped) {
        const start = await docker(['start', dockerContainer]);
        // Verify the restore actually took, and that TrueForge is answering
        // again - a test that leaves the environment broken is a worse outcome
        // than a test that never ran.
        let recovered = false;
        const deadline = Date.now() + 60000;
        let lastModels = null;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(`${trueforgeUrl}/api/v1/models`, {
              signal: AbortSignal.timeout(2000)
            });
            if (res.ok) {
              lastModels = await res.json();
              recovered = true;
              break;
            }
          } catch {
            /* still coming up */
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        suite.check({
          id: 'D15.3',
          name: 'RESTORE: the container is started again and TrueForge answers /api/v1/models with the registered model - the environment is left as it was found',
          pass: start.code === 0 && recovered,
          severity: 'critical',
          evidence: {
            startExit: start.code,
            recovered,
            models: (lastModels?.data || []).map((m) => m.name)
          }
        });

        // And the app must notice the recovery on the NEXT pass, without a restart.
        if (recovered) {
          const backOut = scratchPath('fault-real-container-back.json');
          await runNode(FAULT_PROBE, [backOut], {
            env: {
              FAULT_MODE: 'real',
              TRUEFORGE_BASE_URL: trueforgeUrl,
              TRUEFORGE_TIMEOUT_MS: '20000'
            },
            timeoutMs: 120000
          });
          const back = readJson(backOut, null);
          suite.check({
            id: 'D15.4',
            name: 'RECOVERY: the very next pass picks the harness back up on its own - the probe is re-armed each pass, so an operator restarting the container does not have to restart Signal Zero',
            pass:
              back?.telemetry?.reachable === true &&
              back.reports.some((r) => r.executor === 'trueforge-harness'),
            severity: 'major',
            evidence: {
              reachable: back?.telemetry?.reachable,
              executors: back?.reports.map((r) => ({
                id: r.id,
                executor: r.executor,
                tier: r.tier
              })),
              turns: back?.telemetry?.turns
            }
          });
        }
      }
    }
  }

  return { suite };
}

function nest(depth) {
  let s = '1';
  for (let i = 0; i < depth; i++) s = `{"a":${s}}`;
  return s;
}

async function docker(args) {
  return runCmd('docker', args, { timeoutMs: 90000, cwd: ROOT });
}

async function dockerRunning(name) {
  const res = await docker(['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
  return res.code === 0 && res.stdout.trim().split('\n').includes(name);
}
