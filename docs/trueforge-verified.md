# TrueForge — what is actually verified, and how to reproduce it

Everything below was executed against a real TrueForge v0.1.4 instance and the response
recorded. Nothing here is inferred from documentation.

## The Windows problem (upstream bug)

`npx @truefoundry/trueforge@latest` **fails on Windows**:

```
Failed to start server: Only URLs with a scheme in: file, data, and node are supported
by the default ESM loader. On Windows, absolute paths must be valid file:// URLs.
Received protocol 'c:'
```

An absolute Windows path is passed to a dynamic `import()` without `pathToFileURL()`.
It also warns first:

```
Local sandbox fallback is unavailable
{"reason":"LocalSandboxProvider supports macOS and Linux only (got win32)"}
```

The sandbox warning is documented behaviour. The ESM crash is a hard stop — the server
never listens.

**Workaround used here:** run the published package inside a Linux container. No source
build, no compose, no Postgres/Redis.

```bash
docker run -d --name tforge -p 4000:4000 -e PORT=4000 -e HOST=0.0.0.0 \
  node:22-bookworm-slim sh -lc "npx -y @truefoundry/trueforge@latest"
```

Boots clean: 14 migrations apply, SQLite at `/root/.local/share/trueforge/db/db.sqlite`,
`Agent server listening on http://0.0.0.0:4000`. In-container the local sandbox is still
unavailable (`bwrap`, `socat`, `rg` not on PATH), which is fine — Signal Zero's agents run
`sandbox.enabled: false`.

## API surface (31 paths at `/api/v1`)

`/api/v1/openapi.json` serves the spec. `/api/v1/docs/json` does **not** exist — it returns
200 with an empty body, which looks like an empty API if you probe the wrong path.

The four that matter here:

| | |
|---|---|
| `POST /api/v1/settings/model-providers` | register a provider |
| `GET /api/v1/models` | list resolved `provider/model` names |
| `POST /api/v1/sessions` | create a session (inline spec or named agent) |
| `POST /api/v1/sessions/{id}/turns` | run a turn |

## Registering an OpenAI-compatible provider

`CustomModelProvider` requires `type`, `name`, `base_url`, `models`. Each model needs
`model_id` (the upstream id) and `name` (a local alias matching
`^[a-z](?:[a-z0-9._-]{0,62}[a-z0-9])$` — so `Qwen/Qwen3-...` is **not** a legal alias;
it goes in `model_id`).

```bash
curl -X POST http://localhost:4000/api/v1/settings/model-providers \
  -H "Content-Type: application/json" -d '{
  "manifest": {
    "type": "custom",
    "name": "nebius",
    "base_url": "https://api.tokenfactory.nebius.com/v1",
    "auth": { "api_key": "<key>" },
    "models": [{
      "model_id": "Qwen/Qwen3-30B-A3B-Instruct-2507",
      "name": "signal-zero-triage",
      "properties": {
        "context_length": 128000,
        "max_output_tokens": 16384,
        "reasoning_efforts": ["none"]
      }
    }]
  }
}'
```

→ `201`, and the response redacts the key (`"v1.-***REDACTED***-ugF"`). The model is then
addressable as **`nebius/signal-zero-triage`**.

## Running a turn

Session creation takes `{"agent": {"spec": {...}}}` — the spec is an `AgentSpec`:

```json
{"agent":{"spec":{
  "model":{"name":"nebius/signal-zero-triage","params":{"temperature":0,"max_tokens":256}},
  "instructions":"...",
  "config":{"iteration_limit":5,"sandbox":{"enabled":false},
            "generative_ui":{"enabled":false},"ask_user_questions":{"enabled":false}}
}}}
```

→ `201` with a session id.

**The turn body is the easy thing to get wrong.** The field is `input`, not `messages`:

```json
{"input":[{"type":"user.message","content":"..."}],"stream":false}
```

Sending `{"messages":[...]}` returns HTTP **200** and then fails *inside the stream* with
`Invalid prompt: messages must not be empty`. The HTTP status is not the result — the turn
status is. With `stream:true` (the default) you get SSE: `turn.created` → `model.message`
→ `turn.done`, and `turn.done.state.status` is where success or failure actually lives.

### Verified end to end

Input: `"Massive flash flood from Tibet devastates Nepal's Rasuwa district, sweeping away Timure bazaar"`

Result: `status: done`, `total_tokens: 683`, output **`"Timure"`** — correct, produced by
TrueForge's own execution loop calling our registered provider.

## Notes for this project

- `require_approval_for_tools` gates a **tool call** with Allow/Deny. It has no notion of a
  named approver, so Signal Zero's "nothing is actionable without a name" rule stays enforced
  server-side in `src/server.js` (HTTP 400 on a blank `approvedBy`). The two are complementary,
  not substitutes — do not claim the harness provides the named-approver guarantee.
- Attaching `skills` requires `sandbox.enabled: true`. Signal Zero attaches none - see the
  scorecard below for the measured reason, which is no longer the platform gate.
- **TRAP: `compaction.trigger` is silently dropped.** `trueforge.yaml` documents
  `compaction: {enabled, trigger: {type: input_tokens, value: 90000}}` as the schema. POST an
  agent with that shape and it is accepted - HTTP 200, no warning - and the manifest reads back
  as:

  ```
  "context_management": {"compaction":{"enabled":true},"large_tool_response":{"enabled":true}}
  ```

  The 90000 threshold is gone. Anyone following that shape gets compaction at the default
  threshold and is never told. Re-verified 2026-08-30 by POSTing it and reading the manifest
  back.

---

# Depth of integration — honest scorecard

TrueForge's own capability map (truefoundry.com/trueforge) versus what Signal Zero actually
exercises. Verified against the running instance, not read off the marketing diagram.

| Capability | Used | Evidence |
|---|---|---|
| **Model — bring your own** | ✅ | `nebius/signal-zero-triage` registered via `POST /settings/model-providers` → 201, key redacted |
| **Tools — any MCP server** | ✅ | `bright-data` registered → 201, `auth_status: authenticated`, **5 tools discovered**: `search_engine`, `scrape_as_markdown`, `search_engine_batch`, `scrape_batch`, `ask_brightdata_assistant` |
| **Tool Approval — human in the loop** | ✅ *demonstrated in `scripts/verify-agents.mjs`; NOT on the pipeline path* | Turn emitted `tool.approval_required`; resumed with `user.tool_approval {status:"allow"}`; harness then emitted `tool.response` and completed. **Be precise about this row.** It is true of the ingest agent driven by that script. In the shipping product the gate never arms: `signal-zero-triage-tier3` has `mcp_servers: []`, so there is no tool to gate, and a healthy `POST /api/run` reports `approvalGate: {armed:false, tools:[], fired:0, resolved:0}`. `src/harness/trueforge.js` refuses to report a gate the bound agent cannot have, and this row must not imply otherwise. |
| **Agent Runtime — sessions & turns** | ✅ | `POST /sessions` → 201; streaming turn: `turn.created → mcp.initialize → model.message.delta ×27 → tool.approval_required → tool.response → turn.done` |
| **Context — caching** | ✅ | `total_cache_read_tokens: 1728` of 2770 input on the resumed turn |
| **Observability — token accounting** | ✅ | Per-turn `metrics` on `turn.done` |
| Sandbox | ❌ | `/capabilities` now reports `sandbox.enabled: **true**` - the gate this doc previously cited has LIFTED. `GET /settings/sandbox-providers` → `"No sandbox provider configured"`, and the only provider type the API accepts is `daytona` (external, key-required). The built-in `LocalSandboxProvider` does run in this container (bwrap present) and **does** create a sandbox - then fails `pip install pydantic` (no PyPI route out of the container) and **retries in a loop**. So a sandbox-enabled turn hangs; it does not degrade. Not exercised. |
| Skills registry | ❌ (authored, not mounted) | `/capabilities` now reports `skill.enabled: **true**`, and **3 skills ARE registered** at `/settings/skills` (`disaster-source-credibility`, `nepal-settlement-resolution`, `no-dispatch-language`). **No agent attaches one**, because skills mount into the sandbox above. They contribute **zero tokens** to any turn this system runs. `scripts/load-agents.mjs` refuses to attach them and prints why. |
| Sub-agents | ❌ | Not exercised — ingest is one collector by design, for one auditable trail |
| Generative UI | ❌ | Deliberate: the console is our own static UI, not model-rendered |
| Code Mode / Deferred tools / Large-result offload | ❌ | Not exercised at this scale |
| Memory / persistent recall | ❌ | Pipeline state lives in our own store |

**5 of ~13 capabilities genuinely exercised on the pipeline path**, and a 6th (tool approval)
demonstrated by a script but never armed by the product. Counting it as 6 without that
qualifier would be padding in one direction; the earlier version of this scorecard also
undercounted in the other, by calling the skills registry unavailable when three skills are in
fact registered and the platform gate has lifted. Both corrections are recorded here, not only
the flattering one.

The unused runtime features hang off the sandbox, and the sandbox is not a design decision
here - it is a measured environment failure (see the Sandbox row). Nothing in this system runs
model-written code, so nothing is lost; but "we have no use for it" and "it does not work here"
are different sentences and only the second one is true.

**One agent, not five.** Five agents are registered; exactly one - `signal-zero-triage-tier3` -
is reachable from `src/`. That is Hard Rule 3 doing its job (no LLM outside triage tier 3), not
a division of labour. README.md now marks the other four as operator-run rather than describing
a delegation no code path performs.

## The one that matters most

The approval gate is worth being precise about, because it is easy to overclaim:

- **TrueForge provides** the *pause*: a gated tool call stops the agent loop and waits
  (`tool.approval_required` → `user.tool_approval`). Selectors are `@all`, `@write`,
  `@destructive`, or literal tool names.
- **TrueForge does not provide** a *named approver*. There is no identity on the decision.
- **Signal Zero adds** that: `src/server.js` returns HTTP 400 when `approvedBy` is missing,
  null, empty or whitespace.

So the honest sentence is: *the harness stops the action, and our server refuses to let it
proceed without a name.* Two layers, complementary. Do not say TrueForge enforces the named
approver — it does not.

## Reproducing the HITL proof

```bash
# 1. session with the tool attached and gated
POST /api/v1/sessions
{"agent":{"spec":{
  "model":{"name":"nebius/signal-zero-triage","params":{"temperature":0,"max_tokens":700}},
  "instructions":"...",
  "mcp_servers":[{"name":"bright-data","enable_tools":["search_engine"],
                  "require_approval_for_tools":["@all"],"preload":true}],
  "config":{"iteration_limit":6,"sandbox":{"enabled":false}}
}}}

# 2. ask something that needs the tool -> stream stops at tool.approval_required
POST /api/v1/sessions/{id}/turns
{"input":[{"type":"user.message","content":"Search for: Trishuli flood Nepal Rasuwa August 2026"}],"stream":true}

# 3. resume with the decision (thread_id + tool_call_id come from that event)
POST /api/v1/sessions/{id}/turns
{"input":[{"type":"user.tool_approval","thread_id":"main",
           "tool_call_id":"chatcmpl-tool-...","approval":{"status":"allow"}}],"stream":true}
```

Observed output after allowing, from live Bright Data results:

> "A major flash flood struck Nepal's Rasuwa district on August 26, 2026, after a sudden surge
> of water entered the Bhote Koshi River from Tibet. The flood traveled down the Trishuli River,
> affecting Timure and Syabrubesi areas, with damage extending to Mugling."

`turn.done → status: done`, 2,857 tokens, 1,728 cache reads.
