# Local Agent Preference Across Onboarding Surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every surface that configures AI summarization prefer a locally installed agent CLI (Claude Code, Codex, Cursor, OpenCode) when one is available, and let the user choose which one.

**Architecture:** A new presence-only detection layer (`isPresent` → `listPresentLocalAgents`) answers "is this tool on disk?" with pure filesystem work in ~4 ms, while the expensive `--version` capability probe (measured 161–1772 ms per tool) is deferred to the moment a user commits to a specific tool. Three consumer surfaces are then updated — the VS Code onboarding card, `jolli enable` / the guided front door, and the Settings panel — plus a prerequisite repair of three health-check call sites that still hard-code `claude`.

**Tech Stack:** TypeScript (ESM), Node 22.5+, Vitest, Biome, VS Code webview (esbuild → CJS).

**Design spec:** [`docs/superpowers/specs/2026-07-28-vscode-onboarding-local-agent-design.md`](../specs/2026-07-28-vscode-onboarding-local-agent-design.md)

## Global Constraints

- **No per-task commits and no per-task `npm run all`.** Tasks contain test + implementation code only. The full gate and the commits happen once, in Task 11. Each task lists its targeted Vitest command as a *verification hint* (not a mandated step) so you can check your own work cheaply.
- **DCO sign-off on every commit** — `git commit -s`. CI rejects PRs without `Signed-off-by:`.
- **No `Co-Authored-By: Claude …` trailer and no `🤖 Generated with …` footer** in commit messages or PR descriptions.
- **CLI coverage floor:** 97% statements / 96% branches / 97% functions / 97% lines for `cli/src/`. New code must not regress it.
- **Biome:** tabs, 4-wide indent, 120 column limit. `noExplicitAny: error`, `noUnusedImports/Variables: error`. CI runs `biome check --error-on-warnings` — warnings fail.
- **Webview CSP forbids inline `style=` and inline event handlers.** Dynamic styling goes through CSS classes; events go through `addEventListener`.
- **Webview visibility toggles use the `.hidden` class**, never the HTML `hidden` attribute or `el.hidden = x` — author rules like `display: flex` beat the UA stylesheet and silently break the toggle.
- **No backticks inside builder template literals**, including in comments — a stray backtick truncates the entire returned literal. Use single or double quotes when quoting identifiers.
- **Tool ordering authority is `LOCAL_AGENT_TOOLS` key order** (Claude Code, Codex, Cursor, OpenCode) — *not* `BackendRegistry` order, which differs (Claude, Cursor, Codex, OpenCode).
- **Cross-package imports in `vscode/src/**` are intentional** (e.g. `../../../cli/src/core/localagent/DetectAgents.js`); they resolve at esbuild bundle time. Do not refactor them into package imports.
- **`v8 ignore` exemptions must use the block form** `/* v8 ignore start */` … `/* v8 ignore stop */`. The single-line `ignore next` form does not work in this repo.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `cli/src/core/localagent/BuiltinBackends.ts` | Self-registers the four backends; removes the hidden `LlmClient`-import coupling |
| `cli/src/core/localagent/DetectAgents.ts` | `listPresentLocalAgents()` (presence sweep) + `isLocalAgentUsable()` (single-tool probe) |
| `cli/src/core/localagent/DetectAgents.test.ts` | Tests for both |
| `cli/src/core/localagent/BuiltinBackends.test.ts` | Registry populated without importing `LlmClient` |

**Modified:**

| File | Change |
| --- | --- |
| `cli/src/core/localagent/ExecutableResolver.ts` | Add `isPresent(spec, opts)` — candidate enumeration without probing |
| `cli/src/core/localagent/Types.ts` | Add `isPresent()` to the `LocalAgentBackend` interface |
| `cli/src/core/localagent/{ClaudeCode,Codex,CursorAgent,OpenCode}Backend.ts` | Implement `isPresent()` |
| `cli/src/core/localagent/ClaudeExecutableResolver.ts` | Add `isClaudeCodePresent()`; delete `isClaudeCodeUsable()` in Task 4 |
| `cli/src/core/LlmClient.ts` | Import `BuiltinBackends.js` instead of registering inline |
| `cli/src/commands/GenerationFix.ts` | De-hardcode `claude` in `canGenerateNow()` and `promptLocalAgentFix()` |
| `cli/src/commands/GuidedFrontDoor.ts` | De-hardcode the "summaries via Claude Code" status line |
| `cli/src/commands/EnableCommand.ts` | Generalize auto-select; add multi-tool picker; filter menu choice 3 |
| `vscode/src/services/data/StatusDataService.ts`, `vscode/src/JolliMemoryBridge.ts` | Derive `usesLocalAgent` |
| `vscode/src/stores/StatusStore.ts` | Carry `usesLocalAgent` in the snapshot |
| `vscode/src/Extension.ts` | Extend `configured`; run detection under the barrier; add the select command |
| `vscode/src/views/SidebarMessages.ts` | `localAgents` on `init`; `localAgent:selectError` message |
| `vscode/src/views/SidebarWebviewProvider.ts` | Carry `localAgents`; add `notifyLocalAgentSelectError` |
| `vscode/src/views/SidebarHtmlBuilder.ts` | The card skeleton |
| `vscode/src/views/SidebarCssBuilder.ts` | Card / select / hint / error styles |
| `vscode/src/views/SidebarScriptBuilder.ts` | Populate the dropdown, wire the button, render errors |
| `vscode/src/views/SettingsHtmlBuilder.ts` | Availability status line under the Agent tool dropdown |
| `vscode/src/views/SettingsScriptBuilder.ts` | Probe on change/open; feed `hasErrors` |
| `vscode/src/views/SettingsWebviewPanel.ts` | Handle `probeLocalAgent`, reply with the result |

---

### Task 1: Presence check in the executable resolver

**Files:**
- Modify: `cli/src/core/localagent/ExecutableResolver.ts`
- Test: `cli/src/core/localagent/ExecutableResolver.test.ts`

**Interfaces:**
- Consumes: existing `discover(spec, platform, deps)`, `overrideCandidates(spec, path, platform)`, `ExecutableSpec`, `Candidate`.
- Produces: `isPresent(spec: ExecutableSpec, opts?: PresenceOpts): boolean` and `interface PresenceOpts { overridePath?: string; candidates?: () => readonly Candidate[]; platform?: NodeJS.Platform; exists?: (p: string) => boolean }`.

**Why this matters:** `resolveExecutable` answers "is this usable?" by spawning `<bin> --version` for every candidate — measured at 3384 ms across four installed tools. `isPresent` answers the cheaper question "is this on disk?" by stopping after candidate enumeration: ~4 ms, zero subprocesses.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/core/localagent/ExecutableResolver.test.ts`:

```ts
describe("isPresent", () => {
	const SPEC = {
		binName: "faketool",
		knownPaths: () => [],
		probeArgs: ["--version"] as const,
	};

	it("returns true when candidates are discovered", () => {
		expect(
			isPresent(SPEC, { platform: "darwin", candidates: () => [{ file: "/usr/local/bin/faketool" }] }),
		).toBe(true);
	});

	it("spawns no subprocess — the whole point of the presence/usability split", () => {
		// SPEC.binName is fake, so if isPresent ever probed, this would attempt to
		// spawn a nonexistent binary. Assert on the module's real subprocess seam
		// so the guarantee is enforced rather than assumed.
		const spawnSpy = vi.spyOn(subprocess, "execFileSyncHidden");
		expect(
			isPresent(SPEC, { platform: "darwin", candidates: () => [{ file: "/usr/local/bin/faketool" }] }),
		).toBe(true);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("returns false when nothing is discovered", () => {
		expect(isPresent(SPEC, { platform: "darwin", candidates: () => [] })).toBe(false);
	});

	it("honors an override path that exists on disk", () => {
		expect(
			isPresent(SPEC, {
				platform: "darwin",
				overridePath: "/opt/custom/faketool",
				exists: (p) => p === "/opt/custom/faketool",
			}),
		).toBe(true);
	});

	it("rejects an override path that does not exist", () => {
		expect(
			isPresent(SPEC, {
				platform: "darwin",
				overridePath: "/opt/missing/faketool",
				exists: () => false,
			}),
		).toBe(false);
	});

	it("does not consult the resolution cache", () => {
		// isPresent must never seed or read the single-slot resolveExecutable
		// cache: a cheap presence answer must not mask a later real resolution.
		expect(isPresent(SPEC, { platform: "darwin", candidates: () => [{ file: "/a" }] })).toBe(true);
		expect(isPresent(SPEC, { platform: "darwin", candidates: () => [] })).toBe(false);
	});
});
```

Add `isPresent` to the existing import from `./ExecutableResolver.js`, plus
`import * as subprocess from "../../util/Subprocess.js";` and `vi` from `vitest`,
at the top of the test file.

- [ ] **Step 2: Implement**

In `cli/src/core/localagent/ExecutableResolver.ts`, add after the `discover` function:

```ts
/** Test seams and platform override for {@link isPresent}. */
export interface PresenceOpts {
	readonly overridePath?: string;
	readonly candidates?: () => readonly Candidate[];
	readonly platform?: NodeJS.Platform;
	readonly exists?: (path: string) => boolean;
}

/**
 * Cheap "is this tool on disk?" check — candidate enumeration only, with NO
 * capability probe.
 *
 * This is the presence half of the presence/usability split. {@link resolveExecutable}
 * spawns `<bin> --version` per candidate to pick the newest and prove the tool
 * accepts our flags; that costs a measured 161-1772 ms per tool and 3384 ms to
 * sweep all four. Presence is pure filesystem work (`which` plus `existsSync`)
 * and comes back in single-digit milliseconds, which is what makes a four-tool
 * sweep affordable on the VS Code activation path.
 *
 * Deliberately does NOT touch the module-level resolution cache: a presence
 * answer must never be mistaken for, or displace, a real resolution.
 *
 * A `true` result means "found something spawnable-looking". It does not mean
 * the binary runs, is a compatible version, or that the user is signed in.
 * Callers that need those guarantees must still call {@link resolveExecutable}.
 */
export function isPresent(spec: ExecutableSpec, opts: PresenceOpts = {}): boolean {
	const platform = opts.platform ?? process.platform;
	const exists = opts.exists ?? existsSync;
	if (opts.overridePath) {
		// An override names one specific file. overrideCandidates always returns
		// at least the verbatim path (so the probe can produce a useful error),
		// which would make presence trivially true — so check the filesystem here
		// instead of trusting the list's length.
		return overrideCandidates(spec, opts.overridePath, platform).list.some((c) => exists(c.file));
	}
	return (opts.candidates ?? (() => discover(spec, platform)))().length > 0;
}
```

**Verification hint:** `npm run test -w @jolli.ai/cli -- src/core/localagent/ExecutableResolver.test.ts`

---

### Task 2: `isPresent` on every backend + extract backend registration

**Files:**
- Create: `cli/src/core/localagent/BuiltinBackends.ts`
- Create: `cli/src/core/localagent/BuiltinBackends.test.ts`
- Modify: `cli/src/core/localagent/Types.ts` (the `LocalAgentBackend` interface)
- Modify: `cli/src/core/localagent/ClaudeExecutableResolver.ts`
- Modify: `cli/src/core/localagent/ClaudeCodeBackend.ts`, `CodexBackend.ts`, `CursorAgentBackend.ts`, `OpenCodeBackend.ts`
- Modify: `cli/src/core/LlmClient.ts:30-34`
- Test: each backend's existing `*.test.ts`

**Interfaces:**
- Consumes: `isPresent(spec, opts)` from Task 1.
- Produces: `LocalAgentBackend.isPresent(overridePath?: string): boolean` on all four backends; `isClaudeCodePresent(opts?: PresenceOpts): boolean`; module `BuiltinBackends.ts` whose import registers all four backends.

**Why this matters:** backends are registered as a side effect of importing `LlmClient` ([`LlmClient.ts:31-34`](../../../cli/src/core/LlmClient.ts)). Any other consumer calling `getBackend()` without that import silently sees an empty registry and throws "Unknown local agent tool". Task 3's detector is exactly such a consumer.

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/localagent/BuiltinBackends.test.ts`:

```ts
import { describe, expect, it } from "vitest";
// Importing this module MUST be sufficient to populate the registry — no
// LlmClient import anywhere in this file. That is the whole point of the test.
import "./BuiltinBackends.js";
import { getBackend } from "./BackendRegistry.js";

describe("BuiltinBackends", () => {
	it.each(["claude-code", "codex", "cursor-agent", "opencode"])(
		"registers %s without importing LlmClient",
		(id) => {
			expect(getBackend(id).id).toBe(id);
		},
	);
});
```

Append to `cli/src/core/localagent/CodexBackend.test.ts` (and mirror for the other three, changing the class, id, and binary name):

```ts
describe("CodexBackend.isPresent", () => {
	it("is false for an override path that does not exist", () => {
		expect(new CodexBackend().isPresent("/nonexistent/path/to/codex")).toBe(false);
	});

	it("delegates to the CODEX_SPEC discovery, not another tool's", () => {
		const spy = vi.spyOn(resolver, "isPresent").mockReturnValue(true);
		expect(new CodexBackend().isPresent()).toBe(true);
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ binName: "codex" }),
			{ overridePath: undefined },
		);
	});
});
```

Add `import * as resolver from "./ExecutableResolver.js";` to each backend test file.

> The first case asserts the negative deterministically — the path exists on no
> machine. The second is the one that actually matters: it pins each backend to
> *its own* spec, which is what a copy-paste error between the four
> near-identical implementations would break. A positive filesystem case is
> deliberately not asserted here; it would depend on the host having the tool
> installed. Real positive coverage lives in `ExecutableResolver.test.ts`
> (Task 1) and `DetectAgents.test.ts` (Task 3), which inject seams.

- [ ] **Step 2: Add `isPresent` to the interface**

In `cli/src/core/localagent/Types.ts`, inside `interface LocalAgentBackend`, after `discoverExecutable`:

```ts
	/**
	 * Cheap presence check — is this tool on disk? No capability probe, no
	 * subprocess. Used by onboarding surfaces that must decide what to OFFER
	 * before the user has committed to a tool; anything that must know the tool
	 * actually RUNS calls `discoverExecutable` instead.
	 */
	isPresent(overridePath?: string): boolean;
```

- [ ] **Step 3: Implement on each backend**

`cli/src/core/localagent/CodexBackend.ts` — add to the class, right after `discoverExecutable`:

```ts
	isPresent(overridePath?: string): boolean {
		return isPresent(CODEX_SPEC, { overridePath });
	}
```

Add `isPresent` to the existing `./ExecutableResolver.js` import in that file.

Repeat verbatim in `CursorAgentBackend.ts` with `CURSOR_SPEC` and `OpenCodeBackend.ts` with `OPENCODE_SPEC`.

For Claude, first add to `cli/src/core/localagent/ClaudeExecutableResolver.ts`:

```ts
/**
 * Presence-only counterpart of {@link resolveClaudeExecutable}: true when a
 * `claude` binary is discoverable, WITHOUT probing that it runs. Kept beside the
 * resolver so the Claude spec stays in one file.
 */
export function isClaudeCodePresent(opts: PresenceOpts = {}): boolean {
	return isPresent(CLAUDE_SPEC, opts);
}
```

importing `isPresent` and `type PresenceOpts` from `./ExecutableResolver.js`. Then in `ClaudeCodeBackend.ts`:

```ts
	isPresent(overridePath?: string): boolean {
		return isClaudeCodePresent({ overridePath });
	}
```

- [ ] **Step 4: Extract registration**

Create `cli/src/core/localagent/BuiltinBackends.ts`:

```ts
/**
 * Registers the four shipped local-agent backends.
 *
 * Importing this module for its side effect is the ONLY supported way to
 * populate the registry. It exists because registration used to live at module
 * scope in LlmClient, which made a populated registry an invisible consequence
 * of importing an unrelated module: any other consumer calling `getBackend()`
 * first saw an empty registry and threw "Unknown local agent tool". Both
 * LlmClient and DetectAgents import this instead.
 *
 * Registration order is irrelevant here — `registerBackend` keys by id, and the
 * ordering authority for anything user-facing is LOCAL_AGENT_TOOLS, not this
 * file.
 */
import { registerBackend } from "./BackendRegistry.js";
import { ClaudeCodeBackend } from "./ClaudeCodeBackend.js";
import { CodexBackend } from "./CodexBackend.js";
import { CursorAgentBackend } from "./CursorAgentBackend.js";
import { OpenCodeBackend } from "./OpenCodeBackend.js";

registerBackend(new ClaudeCodeBackend());
registerBackend(new CursorAgentBackend());
registerBackend(new CodexBackend());
registerBackend(new OpenCodeBackend());
```

In `cli/src/core/LlmClient.ts`, delete lines 31-34 and the four backend class imports, and replace them with:

```ts
import "./localagent/BuiltinBackends.js";
```

Keep the existing `getBackend` import — it is still used at line 473.

**Verification hint:** `npm run test -w @jolli.ai/cli -- src/core/localagent/`

---

### Task 3: `DetectAgents` — the presence sweep and the single-tool probe

**Files:**
- Create: `cli/src/core/localagent/DetectAgents.ts`
- Create: `cli/src/core/localagent/DetectAgents.test.ts`

**Interfaces:**
- Consumes: `getBackend` (BackendRegistry), `LOCAL_AGENT_TOOLS` / `localAgentToolLabel` (ToolMeta), `LocalAgentToolId` (Types), `BuiltinBackends.js` side effect from Task 2.
- Produces:
  - `interface DetectedAgent { readonly id: LocalAgentToolId; readonly label: string }`
  - `listPresentLocalAgents(overridePath?: string): DetectedAgent[]`
  - `isLocalAgentUsable(tool: LocalAgentToolId, opts?: { overridePath?: string }): Promise<boolean>`

**Why this matters:** this is the single seam every consumer surface uses, and the ordering authority lives here. `isLocalAgentUsable` is the registry-backed generalization of `isClaudeCodeUsable`, which Task 4 deletes.

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/localagent/DetectAgents.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import * as registry from "./BackendRegistry.js";
import { isLocalAgentUsable, listPresentLocalAgents } from "./DetectAgents.js";
import { LocalAgentSetupError } from "./Types.js";

/** Builds a fake backend whose presence and probe results are scripted. */
function fake(id: string, present: boolean, usable = true) {
	return {
		id,
		isPresent: () => present,
		discoverExecutable: () =>
			usable
				? Promise.resolve({ file: `/bin/${id}`, version: "1.0.0" })
				: Promise.reject(new LocalAgentSetupError(`No compatible ${id}`)),
		buildInvocation: () => {
			throw new Error("not used");
		},
		parseResult: () => {
			throw new Error("not used");
		},
	};
}

function stub(map: Record<string, boolean>) {
	vi.spyOn(registry, "getBackend").mockImplementation((id: string) => fake(id, map[id] ?? false) as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("listPresentLocalAgents", () => {
	it("returns all four in LOCAL_AGENT_TOOLS order when all are present", () => {
		stub({ "claude-code": true, codex: true, "cursor-agent": true, opencode: true });
		expect(listPresentLocalAgents().map((a) => a.id)).toEqual([
			"claude-code",
			"codex",
			"cursor-agent",
			"opencode",
		]);
	});

	it("uses LOCAL_AGENT_TOOLS order, NOT BackendRegistry order", () => {
		// BuiltinBackends registers Claude, Cursor, Codex, OpenCode. If this ever
		// starts reading the registry, Cursor would precede Codex and this fails.
		stub({ "claude-code": true, codex: true, "cursor-agent": true, opencode: true });
		const ids = listPresentLocalAgents().map((a) => a.id);
		expect(ids.indexOf("codex")).toBeLessThan(ids.indexOf("cursor-agent"));
	});

	it("returns only the present tools", () => {
		stub({ "claude-code": false, codex: true, "cursor-agent": false, opencode: true });
		expect(listPresentLocalAgents().map((a) => a.id)).toEqual(["codex", "opencode"]);
	});

	it("returns an empty array when nothing is present", () => {
		stub({});
		expect(listPresentLocalAgents()).toEqual([]);
	});

	it("carries the display label from LOCAL_AGENT_TOOLS", () => {
		stub({ "claude-code": true });
		expect(listPresentLocalAgents()[0]).toEqual({ id: "claude-code", label: "Claude Code" });
	});

	it("treats a throwing backend as absent rather than failing the sweep", () => {
		vi.spyOn(registry, "getBackend").mockImplementation((id: string) => {
			if (id === "codex") throw new Error("registry exploded");
			return fake(id, true) as never;
		});
		expect(listPresentLocalAgents().map((a) => a.id)).toEqual([
			"claude-code",
			"cursor-agent",
			"opencode",
		]);
	});
});

describe("isLocalAgentUsable", () => {
	it("is true when the tool resolves", async () => {
		vi.spyOn(registry, "getBackend").mockImplementation((id: string) => fake(id, true, true) as never);
		await expect(isLocalAgentUsable("codex")).resolves.toBe(true);
	});

	it("is false when the tool fails to resolve", async () => {
		vi.spyOn(registry, "getBackend").mockImplementation((id: string) => fake(id, true, false) as never);
		await expect(isLocalAgentUsable("codex")).resolves.toBe(false);
	});

	it("is false for an unknown tool id rather than throwing", async () => {
		vi.spyOn(registry, "getBackend").mockImplementation(() => {
			throw new LocalAgentSetupError("Unknown local agent tool");
		});
		await expect(isLocalAgentUsable("codex")).resolves.toBe(false);
	});
});
```

- [ ] **Step 2: Implement**

Create `cli/src/core/localagent/DetectAgents.ts`:

```ts
/**
 * Local-agent detection for onboarding surfaces.
 *
 * Two questions, deliberately separated by cost:
 *
 * - {@link listPresentLocalAgents} — "which tools are on disk?" Pure filesystem
 *   work, measured at ~4 ms for all four. Cheap enough to run on the VS Code
 *   activation path before first paint.
 * - {@link isLocalAgentUsable} — "does THIS tool actually run?" Spawns the
 *   capability probe; measured 161-1772 ms for a single tool. Called only once
 *   the user has committed to a specific tool.
 *
 * A full four-tool usability sweep costs 3384 ms on a machine with everything
 * installed, which is why onboarding never does one.
 */
import type { LocalAgentToolId } from "../../Types.js";
import { getBackend } from "./BackendRegistry.js";
// Side-effect import: populates the registry that getBackend reads.
import "./BuiltinBackends.js";
import { LOCAL_AGENT_TOOLS } from "./ToolMeta.js";

/** One locally-installed agent tool, as offered to the user. */
export interface DetectedAgent {
	readonly id: LocalAgentToolId;
	readonly label: string;
}

/** All tool ids in display order. LOCAL_AGENT_TOOLS is the ordering authority
 * for every user-facing list (the Settings dropdown already derives from it);
 * BackendRegistry registers in a different order and must not be used here. */
const TOOL_IDS = Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[];

/**
 * Tools present on this machine, in display order. Never throws: a backend that
 * blows up is reported absent, because a detection failure must degrade to
 * "offer fewer options", never to a broken onboarding panel.
 */
export function listPresentLocalAgents(overridePath?: string): DetectedAgent[] {
	const found: DetectedAgent[] = [];
	for (const id of TOOL_IDS) {
		try {
			if (getBackend(id).isPresent(overridePath)) {
				found.push({ id, label: LOCAL_AGENT_TOOLS[id].label });
			}
		} catch {
			// Absent. See the docstring — never fail the sweep for one tool.
		}
	}
	return found;
}

/**
 * True when `tool` resolves to a runnable binary that accepts the flags we pass.
 * The registry-backed generalization of the former `isClaudeCodeUsable`, and the
 * seam tests mock so they never shell out to a real agent CLI.
 *
 * Still says nothing about whether the user is SIGNED IN to that tool — there is
 * no uniform auth probe. That failure surfaces at generation time and is what
 * `localAgentToolLoginHint` exists for.
 */
export async function isLocalAgentUsable(
	tool: LocalAgentToolId,
	opts: { overridePath?: string } = {},
): Promise<boolean> {
	try {
		await getBackend(tool).discoverExecutable(opts.overridePath);
		return true;
	} catch {
		return false;
	}
}
```

**Verification hint:** `npm run test -w @jolli.ai/cli -- src/core/localagent/DetectAgents.test.ts`

---

### Task 4: De-hardcode the local-agent health checks

**Files:**
- Modify: `cli/src/commands/GenerationFix.ts:20,34,98-140`
- Modify: `cli/src/commands/GuidedFrontDoor.ts:197`
- Modify: `cli/src/commands/EnableCommand.ts:361`
- Modify: `cli/src/core/localagent/ClaudeExecutableResolver.ts` (delete `isClaudeCodeUsable`)
- Test: `cli/src/commands/GenerationFix.test.ts`, `cli/src/commands/GuidedFrontDoor.test.ts`, `cli/src/core/localagent/ClaudeExecutableResolver.test.ts`

**Interfaces:**
- Consumes: `isLocalAgentUsable(tool, opts)` from Task 3; `localAgentToolLabel` / `localAgentToolLoginHint` from `ToolMeta.js`.
- Produces: nothing new. This task only removes hard-coded `claude` assumptions.

**Why this matters — this is a live bug, not new scope.** `localAgentTool` is already settable to any of the four (menu choice 3, `jolli configure --set localAgentTool=codex`, the Settings dropdown), and generation honors it correctly at [`LlmClient.ts:473`](../../../cli/src/core/LlmClient.ts). But three health-check sites still probe `claude` unconditionally, so a Codex user with no Claude installed is told generation is broken and sent to repair a tool they never chose. The runtime is generic; only the diagnostics lie. [`DoctorCommand.ts:171`](../../../cli/src/commands/DoctorCommand.ts) already does this correctly and is the reference implementation.

`canGenerateNow` becomes async — check and update every caller.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/commands/GenerationFix.test.ts`:

```ts
describe("canGenerateNow — configured tool, not claude", () => {
	it("probes the configured tool, not claude", async () => {
		const spy = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		await canGenerateNow({ aiProvider: "local-agent", localAgentTool: "codex" });
		expect(spy).toHaveBeenCalledWith("codex", { overridePath: undefined });
	});

	it("reports usable for a Codex-only machine", async () => {
		vi.spyOn(detect, "isLocalAgentUsable").mockImplementation(async (t) => t === "codex");
		await expect(
			canGenerateNow({ aiProvider: "local-agent", localAgentTool: "codex" }),
		).resolves.toBe(true);
	});

	it("reports unusable when the configured tool is broken even if claude works", async () => {
		vi.spyOn(detect, "isLocalAgentUsable").mockImplementation(async (t) => t === "claude-code");
		await expect(
			canGenerateNow({ aiProvider: "local-agent", localAgentTool: "opencode" }),
		).resolves.toBe(false);
	});

	it("defaults to claude-code when localAgentTool is absent", async () => {
		const spy = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		await canGenerateNow({ aiProvider: "local-agent" });
		expect(spy).toHaveBeenCalledWith("claude-code", { overridePath: undefined });
	});
});
```

Add `import * as detect from "../core/localagent/DetectAgents.js";` to that test file.

Append to `cli/src/commands/GuidedFrontDoor.test.ts` a case asserting the status line names the configured tool:

```ts
it("names the configured local agent in the status line", async () => {
	// Arrange the front door with aiProvider local-agent + localAgentTool codex
	// using this file's existing harness, then assert on captured stdout:
	expect(output).toContain("summaries via Codex");
	expect(output).not.toContain("summaries via Claude Code");
});
```

- [ ] **Step 2: Rewrite `canGenerateNow`**

In `cli/src/commands/GenerationFix.ts`, replace the `isClaudeCodeUsable` import with `isLocalAgentUsable` from `../core/localagent/DetectAgents.js`, and replace the function:

```ts
/**
 * True when the current config can actually generate summaries right now. For
 * the local agent this PROBES the CONFIGURED tool's binary — the same one the
 * commit-time runtime resolves via getBackend(localAgentTool) — so it never
 * disagrees with what actually generates. It used to probe `claude`
 * unconditionally, which told Codex/Cursor/OpenCode users their generation was
 * broken and sent them to repair a tool they never selected.
 *
 * The `?? "claude-code"` default matches StatusTreeProvider and SummaryUtils,
 * and covers configs written before `localAgentTool` existed.
 */
export async function canGenerateNow(config: JolliMemoryConfig): Promise<boolean> {
	if (config.aiProvider === "local-agent") {
		return isLocalAgentUsable(config.localAgentTool ?? "claude-code", {
			overridePath: config.localAgentPath,
		});
	}
	return resolveLlmCredentialSource(config) !== null;
}
```

Update every caller to `await`. Find them with:

```bash
grep -rn "canGenerateNow" cli/src vscode/src --include='*.ts'
```

- [ ] **Step 3: Parameterize the R3 repair**

In `promptLocalAgentFix`, take the tool id, and replace all `claude`-specific copy. The three hard-coded strings at lines 105, 114, 135, 138 become:

```ts
	const label = localAgentToolLabel(tool);
	console.log(
		`\n  AI provider is set to Local Agent (${label}) but no usable binary was found — memories won't be generated.\n`,
	);
	// … choice 1 retry:
	if (await isLocalAgentUsable(tool, { overridePath: localAgentPath })) {
		console.log(`\n  ✓ ${label} is working now.`);
		return true;
	}
	console.log(`\n  Still no usable ${label}. ${localAgentToolLoginHint(tool)}`);
	console.log("  Fix it and run `jolli` again, or `jolli configure`.\n");
	return false;
```

and the skip message at line 114 becomes `` `\n  Skipped. Fix ${label} or run \`jolli configure\` later.\n` ``.

Update `promptGenerationFix` to pass `config.localAgentTool ?? "claude-code"` into it.

- [ ] **Step 4: Fix the front-door status line**

`cli/src/commands/GuidedFrontDoor.ts:197` — replace:

```ts
		const engine = canGenerate && config.aiProvider === "local-agent" ? " · summaries via Claude Code" : "";
```

with:

```ts
		const engine =
			canGenerate && config.aiProvider === "local-agent"
				? ` · summaries via ${localAgentToolLabel(config.localAgentTool ?? "claude-code")}`
				: "";
```

importing `localAgentToolLabel` from `../core/localagent/ToolMeta.js`.

- [ ] **Step 5: Generalize the stale hint and delete the dead helper**

`cli/src/commands/EnableCommand.ts:361` — replace the Claude-specific hint:

```ts
			console.log('    - Set "aiProvider": "local-agent" to drive a local agent CLI (no key)\n');
```

Delete `isClaudeCodeUsable` from `cli/src/core/localagent/ClaudeExecutableResolver.ts` (Task 5 removes its last caller — if `EnableCommand.ts:55` still references it at this point, leave the deletion to Task 5 and do it there instead). Migrate its tests in `ClaudeExecutableResolver.test.ts` to `isLocalAgentUsable("claude-code", …)` rather than deleting them — dropping them would read as a coverage pass while losing real assertions.

**Verification hint:** `npm run test -w @jolli.ai/cli -- src/commands/GenerationFix.test.ts src/commands/GuidedFrontDoor.test.ts`

---

### Task 5: `jolli enable` — generalized auto-select and multi-tool picker

**Files:**
- Modify: `cli/src/commands/EnableCommand.ts:40-160`
- Test: `cli/src/commands/EnableCommand.test.ts`

**Interfaces:**
- Consumes: `listPresentLocalAgents()`, `isLocalAgentUsable(tool, opts)` from Task 3; `localAgentToolLabel` from `ToolMeta.js`; existing `promptText`, `saveConfigScoped`.
- Produces: `autoSelectLocalAgent(configDir: string, tool: LocalAgentToolId): Promise<void>` replacing `autoSelectClaudeCode(configDir)`.

**Behavior table (fresh config only — `fresh` stays the existing guard, so an existing key or a deliberate provider choice is never second-guessed):**

| Present tools | Behavior |
| --- | --- |
| 0 | Fall through to the existing provider menu, unchanged |
| 1 | Probe it. Usable → auto-select silently. Not usable → fall through to the menu |
| 2+ | Prompt listing the present tools; probe the chosen one, then save |

The single-tool branch preserves today's exact semantics (presence *and* a passing probe before anything is written) — it is simply no longer hard-coded to Claude Code. VS Code deliberately differs by always showing its picker; see "One deliberate asymmetry" in the spec. Do not "align" them.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/commands/EnableCommand.test.ts`:

```ts
describe("promptSetup — local agent auto-select", () => {
	it("auto-selects silently when exactly one tool is present and usable", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "codex", label: "Codex" }]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		await promptSetup();
		expect(savedConfig).toMatchObject({ aiProvider: "local-agent", localAgentTool: "codex" });
		expect(promptText).not.toHaveBeenCalled();
	});

	it("falls through to the provider menu when the single present tool fails its probe", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "codex", label: "Codex" }]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(false);
		promptText.mockResolvedValue("4"); // Skip
		await promptSetup();
		expect(savedConfig).toBeUndefined();
		expect(output).toContain("How would you like to generate summaries?");
	});

	it("prompts when two or more tools are present", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValue("2");
		await promptSetup();
		expect(savedConfig).toMatchObject({ aiProvider: "local-agent", localAgentTool: "opencode" });
	});

	it("re-prompts when the chosen tool fails its probe, writing nothing", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		promptText.mockResolvedValueOnce("1").mockResolvedValueOnce("2");
		await promptSetup();
		expect(output).toContain("OpenCode");
		expect(savedConfig).toMatchObject({ localAgentTool: "opencode" });
	});

	it("shows the provider menu unchanged when no tool is present", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([]);
		promptText.mockResolvedValue("4");
		await promptSetup();
		expect(output).toContain("How would you like to generate summaries?");
	});
});

describe("menu choice 3 — explicit local agent", () => {
	it("lists only present tools", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "codex", label: "Codex" },
			{ id: "opencode", label: "OpenCode" },
		]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("1");
		await promptSetup();
		expect(output).toContain("1. Codex");
		expect(output).toContain("2. OpenCode");
		expect(output).not.toContain("Cursor");
	});

	it("falls back to all four with a note when none are present", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("1");
		await promptSetup();
		expect(output).toContain("None detected");
		expect(output).toContain("Cursor");
	});
});
```

Add `import * as detect from "../core/localagent/DetectAgents.js";` to that test file. Reuse the file's existing harness for `savedConfig`, `output`, and the `promptText` mock rather than inventing new ones.

- [ ] **Step 2: Replace the Claude-only fast path**

In `cli/src/commands/EnableCommand.ts`, replace the block at lines 47-58 with:

```ts
	// Zero-friction default: when nothing is configured yet AND local agent
	// tools are installed, generate summaries through the user's own
	// subscription (no API key, no sign-in). Probe ONLY on a truly fresh config
	// so an existing Anthropic key or a deliberate provider choice is never
	// second-guessed.
	//
	// Presence detection is filesystem-only (~4 ms for all four tools); the
	// expensive capability probe (161-1772 ms each) runs for at most ONE tool,
	// never as a sweep.
	//
	// Exactly one present → auto-select it silently, as this command has always
	// done for Claude Code. Two or more → there is a real choice to make, so ask.
	const fresh = !config.apiKey && !process.env.ANTHROPIC_API_KEY && config.aiProvider === undefined;
	if (fresh) {
		const present = listPresentLocalAgents(config.localAgentPath);
		if (present.length === 1) {
			const only = present[0];
			if (await isLocalAgentUsable(only.id, { overridePath: config.localAgentPath })) {
				await autoSelectLocalAgent(configDir, only.id);
				return;
			}
			// Present but not runnable — fall through to the menu rather than
			// pinning a provider that cannot generate.
		} else if (present.length > 1) {
			await handleLocalAgent(configDir, present);
			return;
		}
	}
```

- [ ] **Step 3: Generalize `autoSelectClaudeCode`**

Replace it wholesale:

```ts
/**
 * Auto-selects the Local Agent provider after exactly one working tool was
 * detected: summaries are generated by driving that tool through the user's own
 * subscription, so no jollimemory-held API key is stored. Reached only when the
 * tool already passed its capability probe, so it skips the picker and states
 * the detection plainly, pointing at how to change it.
 */
async function autoSelectLocalAgent(configDir: string, tool: LocalAgentToolId): Promise<void> {
	const label = localAgentToolLabel(tool);
	await saveConfigScoped(
		{ aiProvider: "local-agent", localAgentTool: tool } as Partial<JolliMemoryConfig>,
		configDir,
	);
	console.log(`\n  ✓ Detected ${label} — using your subscription to generate summaries, no API key.`);
	console.log(`  Summaries run through your local ${label} login.`);
	console.log("  Change this anytime: 'jolli auth login', or 'jolli configure --set aiProvider=jolli'.");
	console.log(`\n  Configuration saved to ${join(configDir, "config.json")}\n`);
}
```

- [ ] **Step 4: Rewrite `handleLocalAgent` to take a candidate list and probe before saving**

```ts
/**
 * Picks a local agent from a list and pins it as the provider. Summaries are
 * generated by driving the chosen CLI through its own subscription login, so no
 * jollimemory-held API key is stored.
 *
 * `candidates` is the detected list when any tool is present. When nothing is
 * detected we still offer all four with a note, because reaching here means the
 * user asked for a local agent explicitly and the command must not dead-end.
 *
 * The choice is capability-probed BEFORE it is written: this used to save any of
 * the four unprobed and defer verification to `jolli doctor`, which let a
 * known-broken configuration land in config.json.
 */
async function handleLocalAgent(configDir: string, candidates?: DetectedAgent[]): Promise<void> {
	const detected = candidates ?? listPresentLocalAgents();
	const none = detected.length === 0;
	const list: DetectedAgent[] = none
		? (Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[]).map((id) => ({
				id,
				label: localAgentToolLabel(id),
			}))
		: detected;

	for (;;) {
		console.log("\n  Which local agent CLI would you like to use?\n");
		if (none) console.log("    (None detected on this machine — pick one to configure anyway.)\n");
		list.forEach((a, i) => {
			console.log(`    ${i + 1}. ${a.label}`);
		});

		const answer = await promptText("\n  Choice [1]: ");
		const index = Number.parseInt(answer.trim() || "1", 10) - 1;
		const chosen = list[index] ?? list[0];

		if (await isLocalAgentUsable(chosen.id, { overridePath: undefined })) {
			await saveConfigScoped(
				{ aiProvider: "local-agent", localAgentTool: chosen.id } as Partial<JolliMemoryConfig>,
				configDir,
			);
			console.log(`\n  AI provider:       Local Agent (${chosen.label}) ✓`);
			console.log(`  No API key needed — summaries run through your local ${chosen.label} login.`);
			console.log(`  ${localAgentToolLoginHint(chosen.id)}`);
			console.log(`\n  Configuration saved to ${join(configDir, "config.json")}\n`);
			return;
		}

		console.log(`\n  ${chosen.label} isn't usable on this machine — nothing was saved.`);
		if (list.length === 1) {
			console.log("  Install it, then run 'jolli enable' again.\n");
			return;
		}
	}
}
```

Update the menu's `choice === "3"` branch to call `handleLocalAgent(configDir)` with no list, so it re-detects. Update imports: add `listPresentLocalAgents`, `isLocalAgentUsable`, `type DetectedAgent` from `../core/localagent/DetectAgents.js`, and `localAgentToolLoginHint` from `../core/localagent/ToolMeta.js`. Remove the now-unused `isClaudeCodeUsable` import and delete the function from `ClaudeExecutableResolver.ts` if Task 4 left it in place.

**Verification hint:** `npm run test -w @jolli.ai/cli -- src/commands/EnableCommand.test.ts`

---

### Task 6: VS Code — `usesLocalAgent` in the configured gate

**Files:**
- Modify: `vscode/src/services/data/StatusDataService.ts:16,39`
- Modify: `vscode/src/JolliMemoryBridge.ts:883`
- Modify: `vscode/src/stores/StatusStore.ts:81-82`
- Modify: `vscode/src/Extension.ts:1483`
- Test: `vscode/src/stores/StatusStore.test.ts`, `vscode/src/Extension.test.ts`

**Interfaces:**
- Consumes: existing `derived.signedIn` / `derived.hasApiKey` snapshot plumbing.
- Produces: `derived.usesLocalAgent: boolean` on the status snapshot.

**Why this matters:** without this, choosing a local agent sets neither `signedIn` nor `hasApiKey`, so `configured` stays false, the onboarding panel reappears on every reload, and the user's choice never sticks. Do this before Tasks 7-9 or the card will appear to do nothing.

- [ ] **Step 1: Write the failing tests**

```ts
describe("configured gate", () => {
	it("is configured when the provider is local-agent with no key and no sign-in", () => {
		const snap = buildSnapshot({ aiProvider: "local-agent" });
		expect(snap.derived.usesLocalAgent).toBe(true);
		expect(snap.derived.signedIn || snap.derived.hasApiKey || snap.derived.usesLocalAgent).toBe(true);
	});

	it("is not configured for anthropic with no key", () => {
		const snap = buildSnapshot({ aiProvider: "anthropic" });
		expect(snap.derived.usesLocalAgent).toBe(false);
	});

	it("stays configured after the agent binary disappears", () => {
		// usesLocalAgent is keyed on config INTENT, not live presence: losing the
		// binary must not silently discard the user's provider choice and dump
		// them back into onboarding.
		const snap = buildSnapshot({ aiProvider: "local-agent" });
		expect(snap.derived.usesLocalAgent).toBe(true);
	});
});
```

- [ ] **Step 2: Derive the flag**

`vscode/src/services/data/StatusDataService.ts` — add to the interface beside `hasApiKey`:

```ts
	readonly usesLocalAgent: boolean;
```

and to the object literal at line 39:

```ts
			usesLocalAgent: config?.aiProvider === "local-agent",
```

`vscode/src/JolliMemoryBridge.ts:883` — add beside `hasApiKey: !!config.apiKey,`:

```ts
			usesLocalAgent: config.aiProvider === "local-agent",
```

`vscode/src/stores/StatusStore.ts` — add `usesLocalAgent: false,` to the `EMPTY` derived block at line 81-82 and carry it through `rebuildSnapshot`.

- [ ] **Step 3: Extend the gate**

`vscode/src/Extension.ts:1483`:

```ts
			// A local-agent provider is self-sufficient — it drives the tool's own
			// login and holds no jollimemory credential — so it counts as
			// configured. Keyed on config intent, NOT live detection: if the user
			// later uninstalls the agent we must not silently drop them back into
			// onboarding and discard the choice. That failure belongs to
			// `jolli doctor` and the generation error path.
			const nextConfigured =
				snap.derived.signedIn || snap.derived.hasApiKey || snap.derived.usesLocalAgent;
```

**Verification hint:** `npm run test:vscode -- src/stores/StatusStore.test.ts`

---

### Task 7: VS Code — detection under the activation barrier

**Files:**
- Modify: `vscode/src/Extension.ts` (near line 895 for state, 4048 for the barrier)
- Modify: `vscode/src/views/SidebarMessages.ts:84`
- Modify: `vscode/src/views/SidebarWebviewProvider.ts`
- Test: `vscode/src/Extension.test.ts`

**Interfaces:**
- Consumes: `listPresentLocalAgents()` from Task 3; `currentConfigured` from Task 6.
- Produces: `localAgents?: DetectedAgent[]` on the `init` message payload.

- [ ] **Step 1: Write the failing test**

```ts
it("carries detected local agents on the first init message", async () => {
	vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "codex", label: "Codex" }]);
	await activateExtension();
	expect(firstInitMessage().localAgents).toEqual([{ id: "codex", label: "Codex" }]);
});

it("skips detection entirely when already configured", async () => {
	const spy = vi.spyOn(detect, "listPresentLocalAgents");
	await activateExtension({ configured: true });
	expect(spy).not.toHaveBeenCalled();
});

it("degrades to an empty list when detection throws", async () => {
	vi.spyOn(detect, "listPresentLocalAgents").mockImplementation(() => {
		throw new Error("boom");
	});
	await activateExtension();
	expect(firstInitMessage().localAgents).toEqual([]);
});
```

- [ ] **Step 2: Add the state and the resolver**

In `vscode/src/Extension.ts`, beside `currentConfigured` (line ~895):

```ts
	// Local agent tools present on this machine, for the onboarding card. Empty
	// until resolved under the initialStateReady barrier, and left empty for
	// already-configured users (who never see the card).
	let currentLocalAgents: DetectedAgent[] = [];
```

Add the resolver next to `computeColdStartSignals`:

```ts
	/**
	 * Presence-only sweep of the local agent CLIs, for the onboarding card.
	 *
	 * Filesystem work only — measured at ~4 ms for all four tools — which is why
	 * it can sit on the activation path. The expensive capability probe
	 * (161-1772 ms per tool; 3384 ms to sweep all four) is deliberately NOT run
	 * here; it happens once, for the one tool the user picks.
	 *
	 * Skipped when already configured: those users never see the card.
	 * Best-effort — any failure leaves the list empty, which renders today's
	 * onboarding panel unchanged.
	 */
	const detectLocalAgents = (): void => {
		if (currentConfigured) return;
		try {
			currentLocalAgents = listPresentLocalAgents();
		} catch (err) {
			log.warn("detectLocalAgents", "Detection failed", { error: (err as Error).message });
			currentLocalAgents = [];
		}
	};
```

Call it in the existing `.finally` at line ~4057, before `resolveInitialStateReady()`:

```ts
	).finally(async () => {
		await computeColdStartSignals();
		detectLocalAgents();
		resolveInitialStateReady();
	});
```

- [ ] **Step 3: Put it on the wire**

`vscode/src/views/SidebarMessages.ts` — beside `configured?: boolean` at line 84:

```ts
	/**
	 * Local agent CLIs detected on this machine, in display order. Drives the
	 * onboarding panel's local-agent card: empty (or absent) means no card and a
	 * panel identical to the pre-feature one.
	 *
	 * Sent only on `init`. There is no change channel: the list matters only
	 * while the onboarding panel is up, detection runs once per window, and a
	 * user who installs an agent mid-panel can reload.
	 */
	readonly localAgents?: DetectedAgent[];
```

Add the `localAgent:selectError` variant beside `configured:changed` at line 941:

```ts
	| { readonly type: "localAgent:selectError"; readonly message: string }
```

In `vscode/src/views/SidebarWebviewProvider.ts`, thread `localAgents` into the `init` payload the same way `configured` is threaded, and add:

```ts
	/** Pushed only on the failure path of the onboarding local-agent selection. */
	notifyLocalAgentSelectError(message: string): void {
		void this.post({ type: "localAgent:selectError", message });
	}
```

**Verification hint:** `npm run test:vscode -- src/Extension.test.ts`

---

### Task 8: VS Code — the onboarding card

**Files:**
- Modify: `vscode/src/views/SidebarHtmlBuilder.ts:98-119`
- Modify: `vscode/src/views/SidebarCssBuilder.ts`
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` (element refs ~246, init handler ~800)
- Test: `vscode/src/views/SidebarHtmlBuilder.test.ts`, `vscode/src/views/SidebarScriptBuilder.test.ts`

**Interfaces:**
- Consumes: `localAgents` from the `init` message (Task 7).
- Produces: DOM ids `onboarding-localagent-block`, `onboarding-localagent-select`, `onboarding-localagent-btn`, `onboarding-localagent-error`; CSS classes `ob-select`, `ob-hint`, `ob-error`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("onboarding local-agent card", () => {
	it("renders the block hidden by default", () => {
		const html = buildSidebarHtml("n", "c", "u", strings);
		expect(html).toContain('id="onboarding-localagent-block"');
		expect(html).toMatch(/onboarding-localagent-block[^>]*class="[^"]*hidden/);
	});

	it("uses the exact approved copy", () => {
		const html = buildSidebarHtml("n", "c", "u", strings);
		expect(html).toContain("Use your local agent tool");
		expect(html).toContain(
			"Use your local agent tool for AI summarization. Memories are stored locally only.",
		);
		expect(html).toContain("Use Local Agent Tool");
		expect(html).toContain("Make sure you're signed in to the tool.");
	});

	it("carries no inline style or inline handler (CSP)", () => {
		const html = buildSidebarHtml("n", "c", "u", strings);
		expect(html).not.toMatch(/<[^>]*\sstyle="/);
		expect(html).not.toMatch(/\son(click|change)=/);
	});
});
```

Script-builder tests (driven through the existing harness that dispatches an `init` message):

```ts
it("shows the card and moves the RECOMMENDED badge when agents are present", () => {
	postInit({ localAgents: [{ id: "codex", label: "Codex" }] });
	expect(el("onboarding-localagent-block").classList.contains("hidden")).toBe(false);
	expect(el("onboarding-apikey-card").querySelector(".ob-badge")).toBeNull();
});

it("keeps the card hidden and the badge in place when none are present", () => {
	postInit({ localAgents: [] });
	expect(el("onboarding-localagent-block").classList.contains("hidden")).toBe(true);
	expect(el("onboarding-apikey-card").querySelector(".ob-badge")).not.toBeNull();
});

it("populates options in order with the first pre-selected", () => {
	postInit({
		localAgents: [
			{ id: "codex", label: "Codex" },
			{ id: "opencode", label: "OpenCode" },
		],
	});
	const opts = [...el("onboarding-localagent-select").options];
	expect(opts.map((o) => o.value)).toEqual(["codex", "opencode"]);
	expect(el("onboarding-localagent-select").value).toBe("codex");
});
```

- [ ] **Step 2: Add the skeleton**

In `vscode/src/views/SidebarHtmlBuilder.ts`, insert immediately after the `<hr class="ob-divider" />` at line 97 and give the existing API-key `<section>` the id `onboarding-apikey-card`, moving its `<span class="ob-badge">RECOMMENDED</span>` into the new block:

```html
      <div class="ob-localagent hidden" id="onboarding-localagent-block">
        <section class="ob-card ob-card--recommended">
          <span class="ob-badge">RECOMMENDED</span>
          <div class="ob-card-row">
            <i class="codicon codicon-key ob-card-icon" aria-hidden="true"></i>
            <div class="ob-card-text">
              <h3 class="ob-card-title">Use your local agent tool</h3>
              <p class="ob-card-desc">Use your local agent tool for AI summarization. Memories are stored locally only.</p>
            </div>
          </div>
        </section>
        <p class="ob-hint">Make sure you're signed in to the tool.</p>
        <label class="ob-select-label" for="onboarding-localagent-select">Agent tool</label>
        <select class="ob-select" id="onboarding-localagent-select"></select>
        <p class="ob-error hidden" id="onboarding-localagent-error" role="alert"></p>
        <button type="button" id="onboarding-localagent-btn" class="ob-btn ob-btn--primary">Use Local Agent Tool</button>
        <div class="ob-or"><span>OR</span></div>
      </div>
```

The API-key card keeps its position and copy but loses `ob-card--recommended` and its badge; when `localAgents` is empty the script re-adds both (Step 4).

- [ ] **Step 3: Styles**

In `vscode/src/views/SidebarCssBuilder.ts`, add rules for `.ob-select`, `.ob-select-label`, `.ob-hint`, `.ob-error` using VS Code theme variables (`--vscode-dropdown-background`, `--vscode-dropdown-border`, `--vscode-dropdown-foreground`, `--vscode-descriptionForeground`, `--vscode-errorForeground`), matching the existing `.apikey-input` / `.apikey-error` rules in that file for sizing and spacing.

- [ ] **Step 4: Wire the script**

In `vscode/src/views/SidebarScriptBuilder.ts`, add element refs beside line 246, and render on `init`:

```js
  function applyLocalAgents(agents) {
    const list = Array.isArray(agents) ? agents : [];
    localAgentSelect.replaceChildren();
    if (list.length === 0) {
      // No agents: hide the block and restore the RECOMMENDED badge to the
      // API key card, so the panel is identical to the pre-feature one.
      localAgentBlock.classList.add('hidden');
      apikeyCard.classList.add('ob-card--recommended');
      apikeyBadge.classList.remove('hidden');
      return;
    }
    for (const a of list) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.label;
      localAgentSelect.appendChild(opt);
    }
    localAgentSelect.value = list[0].id;
    localAgentBlock.classList.remove('hidden');
    apikeyCard.classList.remove('ob-card--recommended');
    apikeyBadge.classList.add('hidden');
  }
```

Call `applyLocalAgents(msg.localAgents)` from the `init` handler.

**Verification hint:** `npm run test:vscode -- src/views/SidebarHtmlBuilder.test.ts src/views/SidebarScriptBuilder.test.ts`

---

### Task 9: VS Code — commit the selection

**Files:**
- Modify: `vscode/src/Extension.ts` (register beside `jollimemory.saveAnthropicApiKey` at line 3774)
- Modify: `vscode/src/views/SidebarScriptBuilder.ts`
- Test: `vscode/src/Extension.test.ts`, `vscode/src/views/SidebarScriptBuilder.test.ts`

**Interfaces:**
- Consumes: `isLocalAgentUsable(tool, opts)` (Task 3); `notifyLocalAgentSelectError` (Task 7); `LOCAL_AGENT_TOOLS` for validation.
- Produces: command `jollimemory.selectLocalAgentTool` taking one `string` argument.

- [ ] **Step 1: Write the failing tests**

```ts
describe("jollimemory.selectLocalAgentTool", () => {
	it("saves provider and tool when the probe passes", async () => {
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		await vscode.commands.executeCommand("jollimemory.selectLocalAgentTool", "codex");
		expect(savedConfig).toMatchObject({ aiProvider: "local-agent", localAgentTool: "codex" });
	});

	it("writes nothing and reports an error when the probe fails", async () => {
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(false);
		await vscode.commands.executeCommand("jollimemory.selectLocalAgentTool", "codex");
		expect(savedConfig).toBeUndefined();
		expect(notifyLocalAgentSelectError).toHaveBeenCalledWith(expect.stringContaining("Codex"));
	});

	it("rejects an unknown tool id without writing", async () => {
		await vscode.commands.executeCommand("jollimemory.selectLocalAgentTool", "evil-tool");
		expect(savedConfig).toBeUndefined();
		expect(notifyLocalAgentSelectError).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Register the command**

```ts
		// Onboarding local-agent selection — wired from the sidebar card's
		// "Use Local Agent Tool" button. Mirrors saveAnthropicApiKey: touches only
		// the provider fields, and a successful save flips configured=true via
		// statusStore.refresh, which retires the panel through the existing
		// configured:changed plumbing — no success ack needed.
		//
		// The capability probe runs HERE rather than during detection: the
		// onboarding sweep is presence-only (~4 ms) precisely so that the
		// expensive probe (161-1772 ms) is paid once, for the one tool the user
		// actually chose.
		vscode.commands.registerCommand(
			"jollimemory.selectLocalAgentTool",
			async (rawTool: unknown) => {
				log.info("cmd", "selectLocalAgentTool invoked");
				// Webview input is untrusted — allow-list against the tool registry.
				const tool =
					typeof rawTool === "string" && rawTool in LOCAL_AGENT_TOOLS
						? (rawTool as LocalAgentToolId)
						: null;
				if (!tool) {
					sidebarProvider.notifyLocalAgentSelectError("Unknown local agent tool.");
					return;
				}
				const label = localAgentToolLabel(tool);
				try {
					const cfg = await loadConfig();
					if (!(await isLocalAgentUsable(tool, { overridePath: cfg?.localAgentPath }))) {
						sidebarProvider.notifyLocalAgentSelectError(
							`Found ${label}, but it didn't respond as expected. Try another tool.`,
						);
						return;
					}
					await saveConfigScoped(
						{ aiProvider: "local-agent", localAgentTool: tool },
						getGlobalConfigDir(),
					);
					await statusStore.refresh();
				} catch (err) {
					const message =
						err instanceof Error ? err.message : `Failed to select ${label}.`;
					log.error("cmd", `selectLocalAgentTool failed: ${message}`);
					sidebarProvider.notifyLocalAgentSelectError(message);
				}
			},
		),
```

- [ ] **Step 3: Wire the button and the error**

In `vscode/src/views/SidebarScriptBuilder.ts`:

```js
  localAgentBtn.addEventListener('click', function() {
    const tool = localAgentSelect.value;
    if (!tool) return;
    localAgentBtn.disabled = true;
    localAgentSelect.disabled = true;
    localAgentBtn.textContent = 'Checking…';
    localAgentError.classList.add('hidden');
    localAgentError.textContent = '';
    vscode.postMessage({
      type: 'command',
      command: 'jollimemory.selectLocalAgentTool',
      args: [tool],
    });
  });
```

and in the message switch, beside `case 'apikey:saveError'`:

```js
      case 'localAgent:selectError':
        // Only restore the control if the onboarding panel is still up; a
        // success path that raced past us has already hidden it.
        if (!onboardingPanel.classList.contains('hidden')) {
          localAgentBtn.disabled = false;
          localAgentSelect.disabled = false;
          localAgentBtn.textContent = 'Use Local Agent Tool';
          localAgentError.textContent =
            typeof msg.message === 'string' && msg.message.length > 0
              ? msg.message
              : 'Could not use that tool.';
          localAgentError.classList.remove('hidden');
        }
        break;
```

**Verification hint:** `npm run test:vscode -- src/Extension.test.ts src/views/SidebarScriptBuilder.test.ts`

---

### Task 10: Settings — Agent tool availability check

**Files:**
- Modify: `vscode/src/views/SettingsHtmlBuilder.ts:163-170`
- Modify: `vscode/src/views/SettingsScriptBuilder.ts` (refs ~30, validation ~358-393, listener ~435, message switch ~582)
- Modify: `vscode/src/views/SettingsWebviewPanel.ts`
- Test: `vscode/src/views/SettingsScriptBuilder.test.ts`, `vscode/src/views/SettingsWebviewPanel.test.ts`

**Interfaces:**
- Consumes: `isLocalAgentUsable(tool, opts)` (Task 3); the existing `hasErrors` / `validateAll()` / `updateApplyBtn()` seam.
- Produces: webview→host `{ type: "probeLocalAgent", tool: string }`; host→webview `{ type: "localAgentProbeResult", tool: string, available: boolean }`.

**The dropdown keeps listing all four** — this is the advanced surface and filtering would hide the tool a user is about to install. What changes is that the selection is verified and an unusable configuration cannot be saved.

**Two rules that are easy to get wrong:**
1. **Scope the block.** "Apply Changes" is one global button ([`SettingsHtmlBuilder.ts:293`](../../../vscode/src/views/SettingsHtmlBuilder.ts)) that saves every setting across all tabs. An unavailable agent tool must not block an unrelated Memory Bank path edit — so the error only arms when `aiProvider === "local-agent"`, which is exactly when `localAgentTool` is read at all ([`Types.ts:1162`](../../../cli/src/Types.ts): "Ignored unless `aiProvider === 'local-agent'`").
2. **In-flight probes never arm `hasErrors`.** Only a confirmed-unavailable result does, or a slow probe makes Apply flicker to disabled.

- [ ] **Step 1: Write the failing tests**

```ts
describe("Settings agent tool availability", () => {
	it("disables Apply when the selected tool is unavailable and provider is local-agent", () => {
		setProvider("local-agent");
		selectTool("cursor-agent");
		receive({ type: "localAgentProbeResult", tool: "cursor-agent", available: false });
		expect(applyBtn.disabled).toBe(true);
		expect(el("localAgentStatus").textContent).toContain("not found");
	});

	it("does NOT disable Apply while the probe is in flight", () => {
		setProvider("local-agent");
		selectTool("cursor-agent"); // probe dispatched, no reply yet
		expect(applyBtn.disabled).toBe(false);
		expect(el("localAgentStatus").textContent).toContain("Checking");
	});

	it("does NOT disable Apply when the provider is not local-agent", () => {
		setProvider("anthropic");
		selectTool("cursor-agent");
		receive({ type: "localAgentProbeResult", tool: "cursor-agent", available: false });
		expect(applyBtn.disabled).toBe(false);
	});

	it("clears the error when the provider switches away from local-agent", () => {
		setProvider("local-agent");
		selectTool("cursor-agent");
		receive({ type: "localAgentProbeResult", tool: "cursor-agent", available: false });
		setProvider("jolli");
		expect(applyBtn.disabled).toBe(false);
	});

	it("ignores a stale reply for a tool that is no longer selected", () => {
		setProvider("local-agent");
		selectTool("cursor-agent");
		selectTool("codex");
		receive({ type: "localAgentProbeResult", tool: "cursor-agent", available: false });
		expect(applyBtn.disabled).toBe(false);
	});
});
```

- [ ] **Step 2: Add the status line**

`vscode/src/views/SettingsHtmlBuilder.ts`, inside the `data-card="local-agent"` panel, between the `<select>` and the existing `.section-hint`:

```html
        <p class="local-agent-status" id="localAgentStatus"></p>
```

- [ ] **Step 3: Handle the probe in the panel host**

In `vscode/src/views/SettingsWebviewPanel.ts`, in the webview message switch:

```ts
			case "probeLocalAgent": {
				const raw = (msg as { tool?: unknown }).tool;
				const tool =
					typeof raw === "string" && raw in LOCAL_AGENT_TOOLS ? (raw as LocalAgentToolId) : null;
				if (!tool) return;
				const cfg = await loadConfig();
				const available = await isLocalAgentUsable(tool, { overridePath: cfg?.localAgentPath });
				void panel.webview.postMessage({ type: "localAgentProbeResult", tool, available });
				return;
			}
```

- [ ] **Step 4: Wire validation in the script**

In `vscode/src/views/SettingsScriptBuilder.ts`:

```js
  // Availability of the currently-selected agent tool. null = unknown / probe
  // in flight. Only a confirmed false arms hasErrors, so a slow probe never
  // flickers Apply to disabled.
  var localAgentAvailable = null;
  var localAgentProbeTool = null;

  function probeLocalAgent() {
    var tool = localAgentToolSelect.value;
    localAgentProbeTool = tool;
    localAgentAvailable = null;
    localAgentStatus.textContent = 'Checking…';
    localAgentStatus.classList.remove('error');
    updateApplyBtn();
    vscode.postMessage({ type: 'probeLocalAgent', tool: tool });
  }

  // Only meaningful when the provider actually reads localAgentTool. Apply is a
  // single global button saving every tab, so an unusable agent tool must not
  // block an unrelated Memory Bank edit.
  function localAgentBlocks() {
    return aiProviderSelect.value === 'local-agent' && localAgentAvailable === false;
  }
```

Add `|| localAgentBlocks()` to the `hasErrors` computation inside `validateAll()`, call `probeLocalAgent()` from the `localAgentToolSelect` change listener at line ~435 and on panel open, add a `change` listener on `aiProviderSelect` that calls `updateApplyBtn()` (and `probeLocalAgent()` when switching *to* local-agent), and handle the reply in the message switch:

```js
      case 'localAgentProbeResult':
        // Ignore a stale reply for a tool the user has already moved off.
        if (msg.tool !== localAgentProbeTool) break;
        localAgentAvailable = !!msg.available;
        localAgentStatus.textContent = msg.available
          ? ''
          : localAgentToolSelect.options[localAgentToolSelect.selectedIndex].textContent +
            ' not found on this machine. Install it, or pick another tool.';
        localAgentStatus.classList.toggle('error', !msg.available);
        updateApplyBtn();
        break;
```

Add a `.local-agent-status` / `.local-agent-status.error` rule to `SettingsCssBuilder.ts` using `--vscode-descriptionForeground` and `--vscode-errorForeground`.

**Verification hint:** `npm run test:vscode -- src/views/SettingsScriptBuilder.test.ts src/views/SettingsWebviewPanel.test.ts`

---

### Task 11: Full gate and commits

**Files:** none — verification and version control only.

- [ ] **Step 1: Lint and auto-fix**

```bash
npm run lint:fix
npm run lint
```

Expected: clean. Biome runs with `--error-on-warnings`, so warnings fail CI.

- [ ] **Step 2: Run the full gate**

```bash
npm run all
```

Expected: clean → build → lint → test all pass. CLI coverage must hold at ≥97% statements / ≥96% branches / ≥97% functions / ≥97% lines.

If a coverage line fails, add the missing test — do **not** add a `v8 ignore` to paper over it. If an exemption is genuinely warranted, use the block form `/* v8 ignore start */` … `/* v8 ignore stop */`; the single-line `ignore next` form does not work in this repo.

- [ ] **Step 3: Verify no forbidden trailers will be introduced**

Commit messages must carry `Signed-off-by:` and must **not** carry `Co-Authored-By: Claude …` or a `🤖 Generated with …` footer.

- [ ] **Step 4: Commit in three logical commits**

```bash
git add cli/src/core/localagent/
git commit -s -m "Add presence-only local agent detection

Split 'is this tool on disk?' from 'does it run?'. A full four-tool
capability sweep costs 3384ms; presence detection costs 4ms, which is what
makes it affordable on the VS Code activation path.

Also extracts backend registration out of LlmClient so the registry is no
longer populated as a side effect of importing an unrelated module."

git add cli/src/commands/
git commit -s -m "Probe the configured local agent, not always Claude Code

canGenerateNow, the R3 repair prompt, and the guided front door's status
line all probed 'claude' regardless of localAgentTool, so a Codex user was
told generation was broken and sent to repair a tool they never selected.
Generation itself already honored the setting; only the diagnostics did not.

Also generalizes 'jolli enable' auto-select to all four tools: one present
tool is auto-selected as before, two or more now prompt."

git add vscode/src/
git commit -s -m "Offer installed local agents during VS Code onboarding

The onboarding panel showed only the API key and Jolli sign-in paths even
when the user already had an agent CLI installed. It now leads with a
local agent card listing the detected tools, and Settings refuses to save
an agent tool that is not available."
```

- [ ] **Step 5: Confirm the tree is clean**

```bash
git status --short
git log --oneline -3
git log -1 --format='%B' | grep -c 'Signed-off-by:'
```

Expected: empty status, three new commits, sign-off present.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Presence, not usability | 1, 3 |
| Component 1 — detection layer | 1, 2, 3 |
| Component 2 — `configured` gate | 6 |
| Component 3 — activation barrier | 7 |
| Component 4 — the card | 8 |
| Component 5 — commit | 9 |
| Component 6 — CLI `jolli enable` | 5 |
| Component 7 — Settings availability | 10 |
| Component 8 — de-hardcode health checks | 4 |
| Surface coverage table | 4, 5 (`jolli doctor` correctly untouched) |
| Error handling table | 3 (swallow), 5 (probe failures), 9 (validation), 10 (scope + in-flight) |
| Testing section | every task, plus the gate in 11 |

**Type consistency:** `DetectedAgent { id, label }` is defined in Task 3 and consumed unchanged in Tasks 5, 7, 8. `isLocalAgentUsable(tool, opts)` is async everywhere (Tasks 3, 4, 5, 9, 10) — which is why Task 4 makes `canGenerateNow` async and calls out updating its callers. `isPresent` exists at two levels with different shapes by design: `isPresent(spec, opts)` on the resolver (Task 1) and `isPresent(overridePath?)` on the backend interface (Task 2).

**Known follow-up, deliberately out of scope:** IntelliJ has its own copy of the provider-selection UI and is untouched here. It shares `config.json`, so a local-agent choice made in the CLI or VS Code is honored by it — but IntelliJ offers no local-agent picker of its own.
