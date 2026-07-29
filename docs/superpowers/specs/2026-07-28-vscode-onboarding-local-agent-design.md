# VS Code onboarding: prefer a locally installed agent

**Date:** 2026-07-28
**Status:** Design approved, pending implementation plan

## Problem

The VS Code sidebar shows its onboarding panel — "Use your Anthropic API key" /
"Sign in to Jolli" — whenever the user has neither an Anthropic API key nor a
Jolli sign-in. It never considers a third, cheaper option the user may already
have: a locally installed agent CLI (Claude Code, Codex, Cursor, OpenCode) that
can generate summaries through the user's own subscription with no API key and
no account.

The CLI already prefers that option. On a truly fresh config,
[`EnableCommand.ts`](../../../cli/src/commands/EnableCommand.ts) probes
`isClaudeCodeUsable()` and silently pins `aiProvider: "local-agent"`, skipping
the provider menu entirely. VS Code never got the equivalent, so the two
surfaces disagree about what a first run looks like.

## Goals

- Add a third onboarding condition: show the API-key / sign-in panel only when
  the user *also* has no usable local agent.
- When local agents are present, surface them first as the recommended path and
  let the user pick which one.
- Keep the panel byte-identical to today when no local agent is present.

The same preference is applied consistently across all three surfaces that
choose a local agent:

- **Sidebar onboarding** (the trigger for this work) — new card, always asks.
- **CLI `jolli enable`** — generalize the Claude-only auto-select to all four
  tools, and ask when more than one is present.
- **Settings → AI Summary → Agent tool** — verify the picked tool is actually
  available, and refuse to save a configuration that cannot run.

Plus one prerequisite repair: three local-agent health checks still probe
`claude` regardless of which tool is configured. That is a live bug today, and
promoting non-Claude tools to a mainstream path makes it unavoidable. See
Component 8.

## Non-goals

- Detecting whether the user is *signed in* to the chosen tool. See
  "Presence, not usability" below.
- Auto-installing or offering to install a missing agent.

## One deliberate asymmetry

VS Code always shows the picker, even when exactly one agent is present; the CLI
auto-selects silently in that case. This is a decided difference, not an
oversight, and should not be "fixed" into consistency:

- The sidebar is a persistent surface the user is already looking at. Rendering
  a pre-selected dropdown costs nothing and makes the choice legible.
- `jolli enable` is a one-shot terminal command. An interactive prompt there is
  a stop-the-world event, so the zero-friction path — which the command already
  had for Claude Code — is worth preserving whenever there is nothing to
  actually decide.

Both surfaces ask the moment there is a real choice to make (two or more
present), and neither ever picks *between* tools on the user's behalf.

## Design

### Presence, not usability

Detection answers "is this tool on disk?", not "does this tool work?". Those are
separate questions with wildly different costs, and this repo has already split
them once: MCP host registration is gated on a pure-filesystem `isXPresent`,
while the SQLite-backed `isXInstalled` feeds only discovery and status.

The cost difference is measured, not assumed. On a machine with all four tools
installed, a full `discoverExecutable()` sweep costs **3384 ms**:

| Tool | `discoverExecutable()` | Result |
| --- | ---: | --- |
| claude-code | 794 ms | v2.1.220 |
| codex | 161 ms | codex-cli |
| cursor-agent | 656 ms | v2026.07.23 |
| opencode | 1772 ms | v1.18.5 |
| **Total** | **3384 ms** | |

On a machine with none installed the same sweep costs **4 ms** — `which -a`
returns nothing, `knownPaths` all miss, and not one probe subprocess is spawned.
All of the cost is the `--version` capability probe, none of it is the lookup.

Two consequences drive the design:

1. **The slow case is the well-equipped user, not the empty machine.** Blocking
   first paint on a full sweep would penalize exactly the users the feature is
   for, and leave the no-agent user — who gets nothing from it — unaffected.
2. **The probe's 10 s timeout is per *candidate*, not per tool.** `which -a`
   plus `knownPaths` yields 6 candidates on the reference machine (claude 2,
   codex 1, cursor 1, opencode 2), so the pathological ceiling is 60 s, not 40 s.

So onboarding detection is **presence-only**, and the capability probe moves to
the moment the user commits to a tool.

### Component 1 — `cli/src/core/localagent/`

**`BuiltinBackends.ts` (new).** The four `registerBackend(...)` calls move here
from [`LlmClient.ts`](../../../cli/src/core/LlmClient.ts) into a self-registering
module. Today the registry is populated as a side effect of importing
`LlmClient`; any other consumer calling `getBackend()` without that import
silently sees an empty registry. `LlmClient` and the detector both import this
module, making the coupling explicit and order-independent.

**`LocalAgentBackend.isPresent()` (new interface method).**

```ts
isPresent(overridePath?: string): boolean;
```

Each backend implements it in one line against its existing module-private
`*_SPEC`, via a new `isPresent(spec, opts)` helper in `ExecutableResolver.ts`
that mirrors `resolveExecutable`'s option and platform defaults but stops after
candidate enumeration. `ClaudeCodeBackend` delegates to a new
`isClaudeCodePresent()` exported from `ClaudeExecutableResolver.ts`, alongside
the existing `isClaudeCodeUsable()`.

**`DetectAgents.ts` (new).**

```ts
export interface DetectedAgent {
    readonly id: LocalAgentToolId;
    readonly label: string;   // from LOCAL_AGENT_TOOLS
}

export function listPresentLocalAgents(overridePath?: string): DetectedAgent[];
```

Iterates `LOCAL_AGENT_TOOLS` key order — Claude Code, Codex, Cursor, OpenCode —
and keeps the ones reporting present.

That map, **not** the backend registry, is the ordering authority. The
precedent is the Settings panel's own "Agent tool" dropdown, which the
onboarding dropdown must visually agree with: `LOCAL_AGENT_TOOL_OPTIONS` in
[`SettingsHtmlBuilder.ts:23`](../../../vscode/src/views/SettingsHtmlBuilder.ts)
is built by mapping straight over `Object.keys(LOCAL_AGENT_TOOLS)`. Deriving
onboarding from the same map means the two dropdowns cannot drift apart.

`BackendRegistry` is deliberately not used for this: it registers in a different
order (Claude, **Cursor**, **Codex**, OpenCode), and its own docstring already
designates `LOCAL_AGENT_TOOLS` as the source for UI and CLI tool lists. Pure filesystem work, no
subprocess, no timeout budget, no cache — measured at ~4 ms, which is cheaper
than any cache would be to maintain. Returns `[]` on a machine with nothing
installed.

No version string is carried: the dropdown shows labels only, and obtaining a
version requires the very probe this path exists to avoid.

### Component 2 — the `configured` gate

[`Extension.ts:1483`](../../../vscode/src/Extension.ts) currently computes:

```ts
const nextConfigured = snap.derived.signedIn || snap.derived.hasApiKey;
```

Choosing a local agent sets neither, so the onboarding panel would reappear on
every reload and the choice would never stick. Extend it:

```ts
const nextConfigured =
    snap.derived.signedIn || snap.derived.hasApiKey || snap.derived.usesLocalAgent;
```

`usesLocalAgent: config?.aiProvider === "local-agent"` is derived in
[`StatusDataService.ts`](../../../vscode/src/services/data/StatusDataService.ts)
and [`JolliMemoryBridge.ts`](../../../vscode/src/JolliMemoryBridge.ts) alongside
the existing `hasApiKey`.

Keyed on **config intent, not live presence**, on purpose. If the user later
uninstalls the agent, we must not silently drop them back into onboarding and
discard their choice — that failure belongs to `jolli doctor` and the generation
error path, both of which already handle it.

### Component 3 — detection under the activation barrier

`listPresentLocalAgents()` runs in the `.finally` block of `initialLoad()` in
[`Extension.ts:4048`](../../../vscode/src/Extension.ts), beside the existing
`computeColdStartSignals()` call — the same best-effort-under-the-barrier
pattern. The result is therefore settled before `resolveInitialStateReady()`
fires, so the first `init` message the webview receives already carries it and
the panel never reshuffles.

Gated on `!currentConfigured`: configured users, the overwhelming majority of
activations, skip it entirely. At ~4 ms the gate is a formality rather than an
optimization, but it keeps the activation path honest.

The result rides on the existing `init` payload as
`localAgents?: DetectedAgent[]`. No `localAgents:changed` push message: the list
only matters while the panel is up, detection runs once, and a user who installs
an agent mid-session while sitting on the onboarding panel can reload the
window. Adding a change channel for that would be speculative.

Failure is swallowed to `[]` — a detection error degrades to today's panel, never
to a broken one.

### Component 4 — the card

A third card takes first position in the onboarding panel and inherits the
`RECOMMENDED` badge from the API-key card, which keeps its position and copy but
loses the badge:

```
Get started with Jolli Memory
─────────────────────────────────────────
┌ 🔑  Use your local agent tool  RECOMMENDED ┐
│ Use your local agent tool for AI            │
│ summarization. Memories are stored          │
│ locally only.                               │
└─────────────────────────────────────────────┘
  Make sure you're signed in to the tool.
  [ Claude Code                            ▾ ]
  [          Use Local Agent Tool            ]
                 ── OR ──
┌ 🔑  Use your Anthropic API key ┐
  [ Configure API Key ]
┌ ☁️  Sign in to Jolli ┐
  [ Sign In / Sign Up ]
```

Skeleton lives in
[`SidebarHtmlBuilder.ts`](../../../vscode/src/views/SidebarHtmlBuilder.ts);
the `<option>` list is populated by
[`SidebarScriptBuilder.ts`](../../../vscode/src/views/SidebarScriptBuilder.ts)
via DOM API, per the file's existing "skeleton contains no user-supplied data"
contract.

- Card, hint, `<select>` and button live in one container toggled by the
  `.hidden` class. `localAgents.length === 0` hides the container, leaves the
  `RECOMMENDED` badge on the API-key card, and yields a panel identical to
  today's.
- The `<select>` lists only present agents in `LOCAL_AGENT_TOOLS` order, first
  pre-selected. Labels come from the same map, so both the order and the wording
  match the Settings panel's "Agent tool" dropdown — the two are the same control
  in two places and must not read differently.
- The hint line — "Make sure you're signed in to the tool." — is permanent, not
  an error state. Presence detection cannot see auth, and the honest thing is to
  say so before the user commits rather than after generation fails.

Repo conventions that apply here and have each broken this webview before:
visibility toggles use the `.hidden` class, never the HTML `hidden` attribute or
`el.hidden`; no inline `style=` or inline event handlers (the webview CSP drops
both silently); and no backticks inside the builder's returned template literal,
including in comments.

### Component 5 — commit

The button posts `{ type: "onboardingSelectLocalAgent", tool }`. The handler in
`Extension.ts` mirrors the existing inline API-key save at
[`Extension.ts:3758`](../../../vscode/src/Extension.ts):

1. Validate `tool` against `LOCAL_AGENT_TOOLS` — webview input is untrusted.
2. Disable the button, label it `Checking…`.
3. `await getBackend(tool).discoverExecutable(config.localAgentPath)` — the real
   capability probe, for the selected tool only. Measured 161–1772 ms.
4. On success: `saveConfigScoped({ aiProvider: "local-agent", localAgentTool: tool })`
   → `statusStore.refresh()` → `configured` flips → main UI.
5. On `LocalAgentSetupError`: post the failure back, render it inline in the card
   ("Found Claude Code, but it didn't respond as expected. Try another tool."),
   re-enable the dropdown and button. Nothing is written to config.

This is where the 3384 ms of the old design goes: one probe of one tool, behind a
spinner the user asked for, instead of a full sweep blocking every first paint.
The tradeoff is that the dropdown can list a tool that turns out unusable — one
click and an honest error. The rejected alternative bought nothing in exchange
for the delay: it merely moved the same failure from the click to the first
summary generation.

### Component 6 — CLI `jolli enable`

[`EnableCommand.ts`](../../../cli/src/commands/EnableCommand.ts) today has a
Claude-Code-only fast path:

```ts
const fresh = !config.apiKey && !process.env.ANTHROPIC_API_KEY && config.aiProvider === undefined;
if (fresh && isClaudeCodeUsable({ overridePath: config.localAgentPath })) {
    await autoSelectClaudeCode(configDir);
    return;
}
```

Generalize it to all four tools while preserving its shape — `fresh` stays the
guard, so an existing key or a deliberate provider choice is still never
second-guessed:

| Present tools (fresh config) | Behavior |
| --- | --- |
| 0 | Fall through to the existing provider menu, unchanged |
| 1 | Probe it. Usable → auto-select silently, as today. Not usable → fall through to the menu |
| 2+ | New prompt listing the present tools; probe the chosen one, then save |

The single-tool branch keeps today's exact semantics (presence *and* a passing
probe before anything is written), just no longer hard-coded to Claude Code. The
probe is affordable here because at most one runs, and only on a fresh config —
the same condition that gates it today.

`autoSelectClaudeCode()` becomes `autoSelectLocalAgent(configDir, tool)`, with
its hard-coded "Detected Claude Code" copy parameterized off
`localAgentToolLabel(tool)`.

**Explicit menu choice 3** ("Use a local agent CLI") lists **only present
tools**, matching the sidebar dropdown. When none are present it falls back to
listing all four plus a one-line note that none were detected — the user asked
for a local agent explicitly, so the command must not dead-end. The chosen tool
is probed before saving; on failure the error prints and the picker repeats,
rather than saving a configuration known not to work.

This replaces `handleLocalAgent()`'s current behavior of saving any of the four
unprobed and deferring verification to `jolli doctor`.

### Component 7 — Settings → Agent tool availability

The dropdown keeps listing **all four** tools — this is the advanced surface and
filtering it would hide the tool a user is about to install. What changes is that
the selection is verified and an unusable configuration cannot be saved.

On panel open and on every `change` of `#localAgentTool`, the webview posts
`{ type: "probeLocalAgent", tool }`. The extension probes and replies with
`{ available, version?, error? }`, rendered under the dropdown:

```
  Agent tool
  [ Cursor                              ▾ ]
  ✗ Cursor not found on this machine.
    Install it, or pick another tool.
```

Probing is async and off the render path, so the panel never blocks. While a
probe is in flight the line reads `Checking…`.

**Blocking Apply.** [`SettingsScriptBuilder.ts:392`](../../../vscode/src/views/SettingsScriptBuilder.ts)
already gates the single global Apply button on a validation flag:

```js
applyBtn.disabled = !isDirty || hasErrors;
```

Agent-unavailability becomes one more input to `hasErrors` via the existing
`validateAll()` / `updateApplyBtn()` seam — no new gating mechanism.

**Scoped to when it matters.** "Apply Changes" saves *every* setting across all
tabs, so an unavailable agent tool must not block an unrelated Memory Bank path
edit. The error therefore only arms when `aiProvider === "local-agent"`, which
is exactly when `localAgentTool` is read at all — [`Types.ts:1162`](../../../cli/src/Types.ts)
already documents it as "Ignored unless `aiProvider === 'local-agent'`".
Switching the provider away from local-agent clears the error and re-enables
Apply.

**In-flight probes do not block.** `hasErrors` is armed only by a *confirmed*
unavailable result, never by the `Checking…` state. A slow probe must not make
Apply flicker to disabled.

### Component 8 — De-hardcode the local-agent health checks

This is a **pre-existing bug**, not new scope. It must ship with this work
because this work is what makes non-Claude tools a mainstream path.

`localAgentTool` has been settable to any of the four for some time — via menu
choice 3, `jolli configure --set localAgentTool=codex`, or the Settings
dropdown. Generation honors it correctly: [`LlmClient.ts:473`](../../../cli/src/core/LlmClient.ts)
resolves `getBackend(tool)` and drives whatever the user chose. But three
*health-check* call sites never got the memo and still probe `claude`
unconditionally:

| Site | Current | Effect when `localAgentTool !== "claude-code"` |
| --- | --- | --- |
| [`GenerationFix.ts:34`](../../../cli/src/commands/GenerationFix.ts) `canGenerateNow()` | `isClaudeCodeUsable(...)` | Probes the wrong binary. Codex user without Claude is told generation is broken; Claude-installed user with a broken OpenCode is told it is fine |
| [`GenerationFix.ts:134`](../../../cli/src/commands/GenerationFix.ts) `promptLocalAgentFix()` | `isClaudeCodeUsable(...)`, "Still no usable `claude`" | Sends the user to repair a tool they never selected |
| [`GuidedFrontDoor.ts:197`](../../../cli/src/commands/GuidedFrontDoor.ts) | `" · summaries via Claude Code"` | States the wrong tool outright |

The failure shape is worth naming: **the runtime is generic, the diagnostics are
hard-coded.** Summaries actually generate fine through Codex today — only the
pre-flight checks and their messaging lie, which is why this has gone unnoticed.

[`DoctorCommand.ts:171`](../../../cli/src/commands/DoctorCommand.ts) is already
correct — `getBackend(localAgentTool)` plus `localAgentToolLoginHint(...)` — and
serves as the reference implementation the other three are brought in line with.

**Changes:**

- Add `isLocalAgentUsable(tool, opts)` to `DetectAgents.ts` — the registry-backed
  generalization of `isClaudeCodeUsable`, and the new test-mocking seam.
- Point all three sites at it, resolving the tool as
  `config.localAgentTool ?? "claude-code"`. That default matches what
  `StatusTreeProvider` and `SummaryUtils` already use for configs written before
  the field existed.
- Replace hard-coded tool names in user-facing strings with
  `localAgentToolLabel(tool)`, and the repair hint with
  `localAgentToolLoginHint(tool)`.
- Delete `isClaudeCodeUsable` once its last caller is gone. Its tests move to
  `isLocalAgentUsable` with a `claude-code` argument, so the existing coverage is
  preserved rather than dropped.
- Generalize the stale hint at [`EnableCommand.ts:361`](../../../cli/src/commands/EnableCommand.ts)
  ("drive a local Claude Code CLI") to name the tool family, not Claude.

**Not touched:** `EnableCommand.ts:290` ("Claude Code hooks") refers to Claude
*agent hooks*, an unrelated subsystem that is correctly Claude-specific.

### Surface coverage

`GuidedFrontDoor` shares the setup path with `jolli enable` — it calls
`promptSetup()` directly — so Component 6 covers its onboarding branch with no
separate change. What it needs on its own is the Component 8 string fix. Full
list of surfaces that choose or validate a local agent, and where each is
handled:

| Surface | Handled by |
| --- | --- |
| Sidebar onboarding card | Components 1–5 |
| `jolli enable` → `promptSetup()` | Component 6 |
| `jolli` guided front door | Component 6 (shared `promptSetup`) + Component 8 |
| `promptGenerationFix()` R3 repair | Component 8 |
| Settings → Agent tool | Component 7 |
| `jolli doctor` | Already correct — no change |

## Error handling

| Condition | Behavior |
| --- | --- |
| Detection throws | Swallowed to `[]`; today's panel renders |
| Zero agents present | Card hidden; panel identical to today |
| Probe fails on click | Inline card error, config untouched, user can retry or pick another |
| Unknown `tool` in message | Rejected by the allow-list check; no write |
| Agent uninstalled after selection | `configured` stays true by design; surfaces via `jolli doctor` and the existing "llm-failed" placeholder + Regenerate path |
| CLI: single present tool fails its probe | Falls through to the provider menu; nothing written |
| CLI: chosen tool fails its probe | Error printed, picker repeats; nothing written |
| CLI: menu choice 3 with zero present | Lists all four with a "none detected" note rather than dead-ending |
| Settings: selected tool unavailable | Inline error, Apply disabled — but only while `aiProvider === "local-agent"` |
| Settings: probe still running | `Checking…`; Apply stays enabled (in-flight never arms `hasErrors`) |

## Testing

- `DetectAgents.test.ts` — all four present, none present, partial,
  `LOCAL_AGENT_TOOLS` order preserved (and specifically *not* backend-registry
  order, which differs), error swallowed to `[]`.
- Ordering-parity test — the onboarding `<option>` sequence equals the Settings
  panel's `LOCAL_AGENT_TOOL_OPTIONS` sequence, filtered to present tools. Guards
  the one invariant a future reorder would silently break.
- `BuiltinBackends.test.ts` — registry is populated without importing
  `LlmClient`.
- `ExecutableResolver.test.ts` — `isPresent` returns true/false without spawning
  a probe (assert the probe seam is never called).
- Per-backend tests — `isPresent` delegates to the right `*_SPEC`.
- `Extension` tests — extended `configured` predicate across all four
  combinations; `onboardingSelectLocalAgent` happy path, probe-failure path, and
  unknown-tool rejection.
- `SidebarHtmlBuilder` / `SidebarScriptBuilder` tests — card visibility and
  `RECOMMENDED` badge placement at 0 vs N agents; `<option>` list contents and
  order.

- `EnableCommand.test.ts` — fresh config with 0 / 1 / 2+ present tools; the
  single-tool probe-fails path falls through to the menu; the multi-tool picker
  probes before saving and repeats on failure; menu choice 3 lists only present
  tools, and falls back to all four when none are present. Existing Claude-Code
  auto-select tests must keep passing unchanged — that path is being generalized,
  not replaced.
- `SettingsWebviewPanel` / `SettingsScriptBuilder` tests — `probeLocalAgent`
  round-trip; Apply disabled on a confirmed-unavailable tool; Apply **not**
  disabled while a probe is in flight; Apply **not** disabled when the same tool
  is unavailable but `aiProvider !== "local-agent"`; switching provider away
  clears the error.

- `GenerationFix.test.ts` — `canGenerateNow()` probes the **configured** tool,
  not `claude`: a Codex-configured machine with no Claude reports usable, and a
  Claude-installed machine with a broken configured tool reports unusable. R3
  repair names the configured tool in every message.
- `GuidedFrontDoor.test.ts` — the status line reads "summaries via Codex" when
  Codex is configured.
- Regression test for the missing-`localAgentTool` config (`aiProvider:
  "local-agent"` with no tool set) defaulting to `claude-code` across all three
  repaired sites.

CLI coverage floor is 97% statements / 96% branches; `DetectAgents.ts`, the
`isPresent` additions, the rewritten `EnableCommand` branches, and the
`isLocalAgentUsable` migration all need full branch coverage. The
`isClaudeCodeUsable` tests are migrated, not deleted — dropping them would show
as a coverage pass while losing real assertions.

## Rejected alternatives

**Full `discoverExecutable()` sweep before first paint.** Verifies every
dropdown entry, but costs a measured 3384 ms of blocked first paint for
four-tool users and does not actually prevent the failure it appears to prevent —
presence plus a working `--version` still says nothing about auth, which is the
realistic failure. Rejected on measurement.

**Sweep with a tightened per-probe timeout.** A budget low enough to matter
(~1.5 s) would cut off OpenCode at its measured 1772 ms and report a
perfectly good install as absent. Rejected: a false negative is worse than a
slow true positive.

**Parallel sweep.** The resolver is built on `execFileSync`; concurrency would
require child processes and a serialization protocol for a problem that
presence-only detection dissolves at ~4 ms.

**Listing all four tools with undetected ones greyed out.** More discoverable,
but adds dead rows to a first-run screen. Rejected in favor of listing only what
works.

**Auto-selecting silently when exactly one agent is present — in the sidebar.**
Fastest, but the user never learns a choice was made on their behalf, and the
sidebar is a persistent surface where showing the choice is nearly free. Rejected
for VS Code only: the CLI *does* auto-select in that case, deliberately. See
"One deliberate asymmetry" above.

**Filtering the Settings dropdown to present tools.** Considered and rejected in
favor of checking availability instead. Filtering would hide the tool a user is
about to install and give no explanation for its absence; an inline "not found"
line on a still-visible option says strictly more. The save-blocking rule
delivers the same guarantee filtering would have — no unusable configuration
gets persisted — without hiding anything.

**Caching the detection result.** At ~4 ms there is nothing to amortize, and a
cache would need invalidating when the user installs a tool.
