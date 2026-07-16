# Local Agent CLI Generation Backend (Subscription OAuth) Design

> Date: 2026-07-16
> Status: Design confirmed, implementation plan pending
> Scope: CLI core (`LlmClient`) + VS Code Settings dropdown. IntelliJ deferred.

## 1. Background & Goal

Today all of jollimemory's LLM generation (summary / squash / plan-progress /
rank-context / ingest route+reconcile / knowledge graph) funnels through a single
choke point, `callLlm()` in [`cli/src/core/LlmClient.ts`](../../../cli/src/core/LlmClient.ts),
which has only two backends:

- **`callDirect`** — `@anthropic-ai/sdk`, `x-api-key` direct to `api.anthropic.com`
  (requires an Anthropic API key; billed).
- **`jolli-proxy`** — `fetch` to the Jolli backend gateway `/api/push/llm/complete`
  (uses an `sk-jol-` key).

Routing is done by `resolveLlmCredentialSource` (`LlmClient.ts:206`) plus the config
`aiProvider` field.

**Goal**: add a third backend — **hand the prompt to the locally-installed,
already-logged-in Claude Code CLI to run headless, riding the user's subscription
(Pro/Max) OAuth login to bypass API-key billing**. Positioned as a new, third
selectable provider; selecting it reveals a second dropdown for the specific local
agent tool (v1: Claude Code only; the abstraction reserves room for Codex / Cursor
and others).

Reference implementation: claude-mem (`/Users/flyer/jolli/code/claude-mem`) — it uses
Claude Code as a programmable headless runtime, but via the Agent SDK (see approach B
in the selection section below).

## 2. Non-goals (Out of scope)

- **IntelliJ (Kotlin side)** — separate project, handled later.
- **Codex / Cursor backends** — registration slot and interface only, no implementation.
- **Temperature control** — the `claude` CLI has no such flag, so `temperature:0` is unavailable.
- **Session reuse / streaming output / rate-limit quota snapshots** — approach B features, not done.
- **Automatic provider switching / silent fallback on failure** — explicitly not done (see §7).

## 3. Approach Selection: A (print-mode subprocess) vs B (Agent SDK `query()`)

Two ways to drive Claude Code headless. **A is chosen.** This section records the decision.

### 3.1 The two mechanisms

- **Approach A (chosen): print-mode subprocess.** Spawn the user's installed `claude`
  binary: `claude -p --output-format json --model … --system-prompt … --tools "" --permission-mode dontAsk --no-session-persistence`,
  feed the prompt via stdin, parse the result JSON and take `.result`. One-shot, no lingering state.
- **Approach B: Agent SDK `query()` (what claude-mem does).** Introduce
  `@anthropic-ai/claude-agent-sdk`, use streaming `query()` + hardened options +
  reusable session, reading the OAuth token from the keychain yourself to inject into an
  isolated env.

### 3.2 Trade-off comparison

| Dimension | A: `claude -p` print-mode | B: Agent SDK `query()` |
|---|---|---|
| New dependency | None (spawns the installed binary) | One heavy npm dependency |
| Auth | Rides the user's `claude` login; **never touches the keychain**; only needs to scrub `ANTHROPIC_API_KEY` from env | Isolated env; must **read the keychain OAuth token** itself to inject |
| Multi-tool generalization (the dropdown) | Naturally symmetric: each tool = its own CLI, one interface throughout | **Claude-only**; Codex/Cursor have no such SDK, so the abstraction splits |
| Determinism | No `--temperature` (loses `temperature:0`); mitigated by strict retry + `--json-schema` | Also no temperature |
| Structured output | Native `--json-schema`; graph benefits directly | Configured via SDK options, more roundabout |
| Latency/perf | Spawns a process per call (real ~5.6s) + re-pays the system-prompt cache-creation each time | Can reuse a session to amortize + fewer spawns (**B's only real advantage**) |
| Process/lifecycle complexity | One-shot, simple | SpawnFactory + process registry + concurrency gate + PID-reuse detection + reaping; an order of magnitude more complex |
| Observability | Only the final JSON's usage/cost | Streaming messages + rate-limit quota snapshots |
| Fit with current architecture | Excellent (`callLlm` is already a single choke point with one-shot semantics) | Streaming-session semantics don't match "one prompt, one result"; needs an adapter layer |
| Packaging | Zero dependency, sidesteps entirely | jollimemory's CLI is a multi-entry Vite lib published to npm; a heavy dependency burdens every `npm i -g` user |

### 3.3 Code-volume calibration

claude-mem maintains 6 substantial modules to run approach B; A needs only a small subset:

| claude-mem module | Responsibility | Needed by A? |
|---|---|---|
| `find-claude-executable.ts` | Binary discovery + capability probe | ✅ Both A and B |
| `oauth-token.ts` | Read token from keychain/CredMan/libsecret | ❌ A doesn't need it |
| `EnvManager.ts` | Isolated env + scrubbing + spawn-time token injection | A needs only a minimal version (scrub 3 env vars) |
| `hardened-options.ts` | Six-layer zero-tool lockdown of SDK options | ❌ A replaces it with two flags |
| `ClaudeProvider.ts` | `query()` + streaming generator + stream consumption | ❌ B-specific, the largest piece |
| `process-registry.ts` | SpawnFactory + registry + reaping | ❌ B-specific, the second largest |

**A actually needs**: 1 new backend module + reused binary discovery (shared A/B) + a minimal env scrub.

### 3.4 The three decisive reasons for A

1. **Zero dependency + no keychain access**: spawning the user's `claude` (in
   non-`--bare` mode) makes it read the keychain credentials that Claude Desktop keeps
   refreshing; claude-mem wrote the whole `oauth-token.ts` only because the Agent SDK's
   isolated env forces it to read the token itself. A saves that entire platform-specific
   credential-reading code.
2. **Supports the multi-tool dropdown**: the Agent SDK is Claude-only; with print-mode
   each tool = its own CLI, so the abstraction naturally extends to Codex/Cursor.
3. **Clean packaging**: jollimemory's CLI is a multi-entry lib published to npm; A
   introduces no runtime dependency.

Approach B's one advantage (session reuse to amortize overhead) yields little in
jollimemory's detached background-async setting — the user doesn't wait on the
QueueWorker, and each commit's several calls have independent prompts, so a shared
session risks context bleed rather than savings.

## 4. Architecture: where it plugs in

The only change point is the `LlmClient` choke point. `resolveLlmCredentialSource` gains
a return value `local-agent`; `callLlm` gains a third dispatch branch → `callLocalAgent()`.
**All 7 generation pipelines switch over automatically with no per-pipeline changes**,
because they all go through `callLlm` and `callLocalAgent` returns the same-shaped
`LlmResult`.

## 5. Components

New directory `cli/src/core/localagent/`:

```
LocalAgentBackend (interface)          # multi-tool abstraction; v1 registers one impl
  ├─ id: "claude-code"
  ├─ discoverExecutable(): Promise<ResolvedExe>
  ├─ buildInvocation(req): { file, args, stdin, env }
  └─ parseResult(stdout): LlmResult    # JSON -> { text, inputTokens, outputTokens, cachedTokens, costUsd }

ClaudeCodeBackend implements LocalAgentBackend   # v1's only impl
ClaudeExecutableResolver               # ported minimal version of claude-mem's discovery+probe
LocalAgentRunner                       # spawn + timeout watchdog + SIGTERM->SIGKILL + stderr tail
BackendRegistry                        # id -> backend; TODO registration slot for Codex/Cursor
```

### 5.1 `ClaudeCodeBackend.buildInvocation`

```
claude -p --output-format json
  --model <resolveModelId(model)>      # reuse the alias resolver at Summarizer.ts:43
  --system-prompt <system>             # replace the default system prompt, dropping the coding-assistant preamble
  --tools ""                           # disable all built-in tools (= claude-mem's tools:[])
  --permission-mode dontAsk
  --no-session-persistence
```

- Prompt via **stdin** (`--input-format text` default).
- **cwd = a fresh `mkdtemp` temp directory**: prevents `claude` from auto-discovering the
  repo's `CLAUDE.md` and folding it into the system prompt (which would pollute the summary
  and burn tokens); mirrors claude-mem's `cwd` jail.
- **Env scrub**: `ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL /
  CLAUDE_CODE_OAUTH_TOKEN / CLAUDECODE` — forces subscription OAuth. **Inject no
  credentials** (let `claude` read its own keychain).
- **Do not use `--bare`**: bare mode explicitly disables OAuth/keychain and only honors
  `ANTHROPIC_API_KEY`, the opposite of this feature.

### 5.2 Binary discovery (`ClaudeExecutableResolver`, ported minimal version)

Port the core of claude-mem's `find-claude-executable.ts`, trimmed to:

- Candidate enumeration: `which -a claude` (take all, to stop an older binary winning) +
  `~/.local/bin/claude` + `~/.claude/local/claude` (`existsSync`-gated) + optional
  `config.localAgentPath` override taking priority.
- **Capability probe**: use the **exact flags we will pass** — `--permission-mode dontAsk --version`
  (not a bare `--version`) — because an old CLI rejects `dontAsk` at flag-parse and exits;
  classify capable/incompatible/broken from that. Run via `execFile` (never a shell; injection guard).
- Pick the newest capable version; PATH order is only a tie-breaker.
- **Cache a successful resolution for 15 min; never cache failures** (so a CLI upgrade is
  re-probed on the next call).

Rationale: the QueueWorker is a silent background process, so an old CLI that rejects a new
flag would cause a "healthy worker, zero memory" hidden failure. This is the only part that
must be ported from claude-mem.

## 6. Data flow

```
config.json { aiProvider:"local-agent", localAgentTool:"claude-code" }
  -> resolveLlmCredentialSource() -> "local-agent"
  -> callLocalAgent(req)
      -> BackendRegistry.get("claude-code")
      -> discoverExecutable()            (skipped on cache hit)
      -> buildInvocation()
      -> LocalAgentRunner.run()          (spawn claude, stdin=prompt, scrubbed env, temp cwd)
      -> parseResult(stdout JSON)         -> { text, inputTokens, outputTokens, cachedTokens, costUsd }
  -> returned unchanged to Summarizer / GraphDistiller / IngestPipeline (contract unchanged)
```

## 7. Error handling — no silent fallback

Once dispatched to `local-agent`, the call **stays on that path only**, and a failure
**never silently falls back** to anthropic/jolli (aligning with the prior "prevent silent
fallback" decision and the no-silent-failure principle; a silent fallback would bill the
user's API without their knowledge, directly defeating the feature's purpose). On failure it
surfaces the error and **does not consume the queue entry**, leaving it for the QueueWorker
to retry later.

Error classification (a trimmed port of claude-mem's `classifyClaudeError`):

| Case | Detection | Handling |
|---|---|---|
| Binary missing/too old | discovery phase | `setup_required`: prompt to install/upgrade claude or switch provider; failure not cached |
| Not signed into subscription | JSON `is_error` + 401/403 | `auth_invalid`: prompt "run `claude` in a terminal to log in"; may write a stale marker for the UI |
| Subscription quota exhausted | `is_error` + 429 | `rate_limit`/`transient`: don't consume the queue entry, leave for retry |
| Timeout | runner watchdog | SIGTERM → (on timeout) SIGKILL, throw `transient` |
| JSON parse failure | parseResult | keep the 2KB stderr tail (ported) into debug.log, throw |

## 8. Config schema + VS Code UI

- [`cli/src/Types.ts`](../../../cli/src/Types.ts): widen `aiProvider` to
  `"jolli" | "anthropic" | "local-agent"`.
- Add `localAgentTool?: "claude-code"` (extensible enum, v1 has this one entry, reserves
  codex/cursor); optional `localAgentPath?: string` (equivalent to a `CLAUDE_CODE_PATH` override).
- **VS Code Settings webview**: add a third AI-provider option "Local Agent (subscription)";
  selecting it **reveals a linked second dropdown** `localAgentTool` (structure in place, v1
  shows only "Claude Code"). Follow the webview rules: toggle visibility with the `.hidden`
  class, no inline styles/handlers, dynamic styles via CSS class, no whole-tree reset for a
  single-row update.

## 9. Token / cost semantics under subscription

- Tokens map directly: `usage.input_tokens → inputTokens`, `output_tokens → outputTokens`,
  `cache_read_input_tokens → cachedTokens`.
- Verified on real hardware: **even on subscription, `total_cost_usd` is still reported**
  (a notional API-equivalent cost) → store it, tagged with the provider. UI semantics defined
  as "**subscription-included, marginal $0**; this is an equivalent reference cost." Cost-panel
  copy tweaks are deferred; v1 just stores the data correctly.
- Known overhead: even with `--system-prompt` + `--tools ""`, the real run still shows ~4.7k
  tokens of system scaffolding being cached; `--no-session-persistence` + a fresh spawn each
  time means **every call re-pays that cache-creation**. Accepted.

## 10. Testing strategy (holding the CLI 97% coverage floor)

- **Dependency injection**: `LocalAgentRunner`'s spawn and `ClaudeExecutableResolver`'s fs/exec
  are all injectable, so unit tests **never launch a real claude**.
- **Real fixture** (aligning with the "external parser must use a real fixture" lesson): the
  JSON envelope captured from the real-hardware smoke test is frozen as a fixture, testing
  `parseResult`'s success / `is_error` / malformed paths.
- Coverage points: invocation arg construction, env scrub, discovery-phase
  capable/incompatible/broken classification, error classification, no-fallback behavior.

## 11. Real-hardware verification record (2026-07-16, `claude` 2.1.210)

Smoke command (temp cwd, `ANTHROPIC_API_KEY` scrubbed):

```
printf 'Reply with exactly the word: PONG' | ANTHROPIC_API_KEY= claude -p \
  --output-format json --model claude-haiku-4-5-20251001 \
  --system-prompt "You output only what is asked, nothing else." \
  --tools "" --permission-mode dontAsk --no-session-persistence
```

Real return envelope (excerpt):

```json
{ "type":"result", "subtype":"success", "is_error":false,
  "result":"PONG",
  "total_cost_usd":0.010476,
  "usage":{ "input_tokens":10, "output_tokens":198,
            "cache_read_input_tokens":0, "cache_creation_input_tokens":4738 },
  "session_id":"…" }
```

Confirmed: `result` is the text output; usage fields map directly; cost is still reported
under subscription; one-shot ~5.6s.

## 12. Risks & trade-offs

- **No `temperature:0`**: determinism of summaries/graph drops, mitigated by the
  `summarize-strict` retry + `--json-schema` validation.
- **Per-call spawn latency ~5s + repeated cache-creation**: the QueueWorker is background-async
  and the user doesn't wait, so it's acceptable; if concurrency is needed, add a small gate (default 2).
- **Depends on `claude` CLI flag stability**: the capability probe guards against old versions;
  if flags change, update the probe args (kept in sync with `buildInvocation`).
- **cwd uses a temp directory**: trades away the repo's CLAUDE.md context for clean output — the
  right trade-off for jollimemory's summarization task (it wants conversation-record compression,
  not repo coding context).
