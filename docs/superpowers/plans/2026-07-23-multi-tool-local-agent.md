# Multi-Tool Local Agent Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex, Cursor CLI, and OpenCode as `local-agent` provider backends so memory / wiki / graph generation can run through a locally-installed headless CLI agent, alongside the existing Claude Code backend.

**Architecture:** Extend the existing pluggable `LocalAgentBackend` registry (JOLLI-1937). Reuse `LocalAgentRunner` and the backend interface unchanged. Add one parameterized executable resolver, a dependency-free per-tool metadata table, three new backend classes (each owning its own headless argv + result parser), and thread a per-tool identity through config, footer attribution, CLI flows, and the VS Code UI. Generation pipelines are provider-agnostic and need no changes.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome. CLI workspace `@jolli.ai/cli`. VS Code extension bundles `cli/src/**` via esbuild.

**Design doc:** [`docs/superpowers/specs/2026-07-23-multi-tool-local-agent-design.md`](../specs/2026-07-23-multi-tool-local-agent-design.md)

## Global Constraints

- **DCO sign-off on the (single) commit** — `git commit -s`. No `Co-Authored-By: Claude …` trailer, no "🤖 Generated with …" footer.
- **Deferred commit discipline (OVERRIDES the skill's per-task commit default).** Tasks 1–10 write code (tests + implementation) and run only their own targeted tests. Do NOT run `npm run all` and do NOT `git commit` per task. Task 11 is the single `npm run all` + one commit for the whole feature. This is an explicit standing user preference.
- **CLI coverage floor:** 97% statements / 96% branches / 97% functions / 97% lines (`cli/vite.config.ts`). New code must not regress it. Unreachable branches use `/* v8 ignore start */ … /* v8 ignore stop */` **block** form (single-line `ignore next` does NOT work here).
- **Path normalization:** use `toForwardSlash` from `cli/src/core/PathUtils.ts`; never inline `path.replace(/\\/g, "/")`.
- **Worktree-aware:** no assumptions of a single working tree.
- **Biome:** tabs, 4-wide, 120 columns. `noExplicitAny: error`, `noUnusedImports/Variables: error`. `biome check --error-on-warnings` — warnings fail.
- **VS Code webview CSP:** no inline `style=""`, no inline event handlers. Dynamic styling via CSS class; events via `addEventListener`. Toggle visibility via `.hidden` class, not the HTML `hidden` attribute.
- **Parser fixtures come from real captures (Task 1), never hand-authored.** Parser code and its fixture must not both originate from imagination.

---

## File Structure

**Create:**
- `scripts/probe-local-agents.mjs` — one-shot fixture capture script (user-run).
- `cli/src/core/localagent/ToolMeta.ts` — dependency-free per-tool metadata table (`LocalAgentToolId`, display names, login hints, resolver specs, scrub-env lists). Single source of truth consumed by footer, doctor, UI, and resolvers.
- `cli/src/core/localagent/ExecutableResolver.ts` — parameterized `resolveExecutable(spec, opts)` generalized out of `ClaudeExecutableResolver`.
- `cli/src/core/localagent/CursorAgentBackend.ts` — `id="cursor-agent"`.
- `cli/src/core/localagent/CodexBackend.ts` — `id="codex"`.
- `cli/src/core/localagent/OpenCodeBackend.ts` — `id="opencode"`.
- `cli/src/core/localagent/__fixtures__/{cursor-agent,codex,opencode}/` — captured outputs.
- Test files colocated as `*.test.ts` next to each new module.

**Modify:**
- `cli/src/core/localagent/ClaudeExecutableResolver.ts` — becomes a thin wrapper over `resolveExecutable`.
- `cli/src/core/localagent/BackendRegistry.ts` — add `listBackends()`.
- `cli/src/core/LlmClient.ts:26-27` (register 3 backends), `:196-200` (widen local `localAgentTool` type, add `localAgentModel`), `:249,266-267` (thread `localAgentModel`), `:457-458` (effective-model resolution), `:485-494` (persist `localAgentTool` on metadata).
- `cli/src/Types.ts:271` (no change to `LlmCredentialSource`), `:295` (add `localAgentTool?` to `LlmCallMetadata`), `:1072,1175,1177` (widen config `localAgentTool`, add `localAgentModel`), plus a new exported `LocalAgentToolId` type.
- `cli/src/core/SummaryFormat.ts:126-167` — `formatProviderLabel` renders `Local agent - <tool label>`.
- `cli/src/commands/EnableCommand.ts`, `ConfigureCommand.ts`, `GuidedFrontDoor.ts`, `AuthCommand.ts` (doctor) — surface tool selection + per-tool login hints.
- `vscode/src/views/SettingsHtmlBuilder.ts`, `vscode/src/providers/StatusTreeProvider.ts` — 4-option dropdown + status label.

---

## Task 1: Probe script + fixture capture (CHECKPOINT)

**Files:**
- Create: `scripts/probe-local-agents.mjs`
- Produces: `cli/src/core/localagent/__fixtures__/{cursor-agent,codex,opencode}/{help.txt,success.json,meta.json}`

**Interfaces:**
- Produces: real captured stdout/stderr/exitCode per tool, consumed by the parser tasks (6–8).

This task has no unit test — its deliverable is real fixture files on disk, and it ends in a human checkpoint.

- [ ] **Step 1: Write the probe script**

```js
// scripts/probe-local-agents.mjs
// One-shot: capture REAL headless output from each local-agent tool into
// fixtures the parser tasks are written against. Run manually:  node scripts/probe-local-agents.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "src", "core", "localagent", "__fixtures__");

// A fixed prompt that forces a small STRICT-JSON answer — mirrors what the
// summarize/graph prompts demand, so the fixture also proves JSON-compliance.
const PROMPT = 'Respond with ONLY this JSON and nothing else: {"ok":true,"n":42}';

const TOOLS = [
	{ id: "cursor-agent", bin: "cursor-agent", help: ["--help"], run: ["-p", "--output-format", "json", PROMPT] },
	{ id: "codex", bin: "codex", help: ["exec", "--help"], run: ["exec", "--json", PROMPT] },
	{ id: "opencode", bin: "opencode", help: ["run", "--help"], run: ["run", PROMPT] },
];

for (const t of TOOLS) {
	const dir = join(FIX, t.id);
	mkdirSync(dir, { recursive: true });
	const cwd = mkdtempSync(join(tmpdir(), "jolli-probe-"));
	const help = spawnSync(t.bin, t.help, { encoding: "utf8" });
	writeFileSync(join(dir, "help.txt"), (help.stdout ?? "") + "\n---STDERR---\n" + (help.stderr ?? ""));
	const run = spawnSync(t.bin, t.run, { cwd, encoding: "utf8", timeout: 120000 });
	writeFileSync(join(dir, "success.json"), run.stdout ?? "");
	writeFileSync(
		join(dir, "meta.json"),
		JSON.stringify({ id: t.id, status: run.status, signal: run.signal, stderrTail: (run.stderr ?? "").slice(-2000) }, null, 2),
	);
	console.log(`[${t.id}] exit=${run.status} stdoutBytes=${(run.stdout ?? "").length}`);
}
console.log("Done. Inspect cli/src/core/localagent/__fixtures__/*/success.json");
```

- [ ] **Step 2: Ask the user to run it locally and report exit codes**

The user runs `node scripts/probe-local-agents.mjs` on a machine where all three tools are installed and logged in. This is a **hard checkpoint**: do not write the parser tasks' final field names until the fixtures exist. If a tool is missing/not-logged-in, its `meta.json` records that and its parser is written from documented shapes + reconciled later.

- [ ] **Step 3: Inspect fixtures and record observed shapes**

Read each `success.json` + `help.txt`. In this plan file (or a scratch note), write the confirmed answers to every 🔍 in the design: Cursor prompt-passing (arg vs stdin) + system-prompt flag; Codex final-message event `type` + usage event; OpenCode json flag + model flag + login command. Tasks 6–8 use these confirmed values.

---

## Task 2: Tool metadata table

**Files:**
- Create: `cli/src/core/localagent/ToolMeta.ts`, `cli/src/core/localagent/ToolMeta.test.ts`
- Modify: `cli/src/Types.ts` (add `LocalAgentToolId` export near line 271)

**Interfaces:**
- Produces: `type LocalAgentToolId = "claude-code" | "codex" | "cursor-agent" | "opencode"` (in Types.ts); `LOCAL_AGENT_TOOLS: Record<LocalAgentToolId, LocalAgentToolMeta>` and `localAgentToolLabel(id)` (in ToolMeta.ts).
- Consumed by: footer (Task 5), CLI/doctor (Task 9), UI (Task 10), resolvers (Task 3/6–8).

- [ ] **Step 1: Add the shared id type to Types.ts**

In `cli/src/Types.ts`, immediately after the `LlmCredentialSource` definition (line 271), add:

```ts
/** Which local-agent CLI tool drives generation when aiProvider === "local-agent". */
export type LocalAgentToolId = "claude-code" | "codex" | "cursor-agent" | "opencode";
```

- [ ] **Step 2: Write the failing test**

```ts
// cli/src/core/localagent/ToolMeta.test.ts
import { describe, expect, it } from "vitest";
import { LOCAL_AGENT_TOOLS, localAgentToolLabel } from "./ToolMeta.js";

describe("ToolMeta", () => {
	it("labels every tool with the footer display name", () => {
		expect(localAgentToolLabel("claude-code")).toBe("Claude Code");
		expect(localAgentToolLabel("codex")).toBe("Codex");
		expect(localAgentToolLabel("cursor-agent")).toBe("Cursor");
		expect(localAgentToolLabel("opencode")).toBe("OpenCode");
	});

	it("carries a login hint for every tool", () => {
		for (const id of Object.keys(LOCAL_AGENT_TOOLS) as (keyof typeof LOCAL_AGENT_TOOLS)[]) {
			expect(LOCAL_AGENT_TOOLS[id].loginHint.length).toBeGreaterThan(0);
		}
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/ToolMeta.test.ts`
Expected: FAIL — cannot resolve `./ToolMeta.js`.

- [ ] **Step 4: Write ToolMeta.ts**

```ts
// cli/src/core/localagent/ToolMeta.ts
import type { LocalAgentToolId } from "../../Types.js";

export interface LocalAgentToolMeta {
	/** Footer / UI display name, e.g. "Cursor" → footer "Local agent - Cursor". */
	readonly label: string;
	/** Actionable sign-in guidance shown by doctor when auth is missing. */
	readonly loginHint: string;
}

export const LOCAL_AGENT_TOOLS: Record<LocalAgentToolId, LocalAgentToolMeta> = {
	"claude-code": { label: "Claude Code", loginHint: "Run `claude` once and sign in to your subscription." },
	codex: { label: "Codex", loginHint: "Run `codex login` to sign in with your ChatGPT plan." },
	"cursor-agent": { label: "Cursor", loginHint: "Run `cursor-agent login` to sign in to Cursor." },
	opencode: { label: "OpenCode", loginHint: "Run `opencode auth login` to connect a provider." },
};

export function localAgentToolLabel(id: LocalAgentToolId): string {
	return LOCAL_AGENT_TOOLS[id].label;
}
```

> Reconcile the three `loginHint` command names against the `help.txt` captured in Task 1 before finalizing.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/ToolMeta.test.ts`
Expected: PASS.

---

## Task 3: Generalize the executable resolver

**Files:**
- Create: `cli/src/core/localagent/ExecutableResolver.ts`, `cli/src/core/localagent/ExecutableResolver.test.ts`
- Modify: `cli/src/core/localagent/ClaudeExecutableResolver.ts` (becomes a thin wrapper)

**Interfaces:**
- Produces: `interface ExecutableSpec { binName: string; knownPaths: (home: string, platform: NodeJS.Platform) => string[]; probeArgs: readonly string[] }` and `resolveExecutable(spec: ExecutableSpec, opts?: ResolveOpts): ResolvedExecutable`.
- Consumes: `ResolvedExecutable`, `LocalAgentSetupError` from `./Types.js`.
- Note: `ResolveOpts` keeps the existing test seams (`overridePath`, `probe`, `candidates`, `now`, `platform`).

- [ ] **Step 1: Write the failing test**

```ts
// cli/src/core/localagent/ExecutableResolver.test.ts
import { describe, expect, it } from "vitest";
import { __resetResolverCacheForTest, resolveExecutable } from "./ExecutableResolver.js";
import { LocalAgentSetupError } from "./Types.js";

const spec = { binName: "codex", knownPaths: () => [], probeArgs: ["--version"] as const };

describe("resolveExecutable", () => {
	it("picks the newest capable candidate", () => {
		__resetResolverCacheForTest();
		const r = resolveExecutable(spec, {
			candidates: () => ["/a/codex", "/b/codex"],
			probe: (f) => ({ ok: true, version: f === "/b/codex" ? "2.0.0" : "1.0.0" }),
			now: () => 1,
		});
		expect(r).toEqual({ file: "/b/codex", version: "2.0.0" });
	});

	it("caches per (binName + overridePath) so a different tool never reuses another's result", () => {
		__resetResolverCacheForTest();
		let calls = 0;
		const probe = () => { calls++; return { ok: true, version: "1.0.0" }; };
		resolveExecutable({ ...spec, binName: "codex" }, { candidates: () => ["/x"], probe, now: () => 1 });
		resolveExecutable({ ...spec, binName: "cursor-agent" }, { candidates: () => ["/y"], probe, now: () => 1 });
		expect(calls).toBe(2); // NOT served from a binName-blind cache
	});

	it("throws a setup error naming the tool when nothing is capable", () => {
		__resetResolverCacheForTest();
		expect(() => resolveExecutable(spec, { candidates: () => ["/a"], probe: () => ({ ok: false }), now: () => 1 }))
			.toThrow(LocalAgentSetupError);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/ExecutableResolver.test.ts`
Expected: FAIL — cannot resolve `./ExecutableResolver.js`.

- [ ] **Step 3: Write ExecutableResolver.ts**

Move the generic machinery from `ClaudeExecutableResolver.ts` verbatim (`toLines`, `isNewer`, `versionRank`, POSIX `which -a` / win32 `where` + `.exe` filter discovery), parameterizing the three tool-specific bits and making the cache key composite:

```ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "../../Logger.js";
import { execFileSyncHidden } from "../../util/Subprocess.js";
import { LocalAgentSetupError, type ResolvedExecutable } from "./Types.js";

const log = createLogger("ExecutableResolver");
const RESOLUTION_CACHE_TTL_MS = 15 * 60_000;

export interface ExecutableSpec {
	readonly binName: string;
	readonly knownPaths: (home: string, platform: NodeJS.Platform) => string[];
	readonly probeArgs: readonly string[];
}
export type ProbeFn = (file: string) => { ok: boolean; version?: string };
interface ResolveOpts {
	readonly overridePath?: string;
	readonly probe?: ProbeFn;
	readonly candidates?: () => string[];
	readonly now?: () => number;
	readonly platform?: NodeJS.Platform;
}

// Cache keyed by binName + overridePath. binName MUST be in the key: a long-lived
// worker draining multiple repos, or two tools resolved back-to-back, would
// otherwise serve one tool's binary for another (codex → cursor cross-talk).
let cached: { at: number; key: string; result: ResolvedExecutable } | null = null;
export function __resetResolverCacheForTest(): void { cached = null; }

function toLines(out: string): string[] {
	return out.split("\n").map((l) => l.trim()).filter(Boolean);
}
function versionRank(v: string | undefined): number[] {
	return (v ?? "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
}
function isNewer(a: string | undefined, b: string | undefined): boolean {
	const ra = versionRank(a); const rb = versionRank(b);
	for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
		const da = ra[i] ?? 0; const db = rb[i] ?? 0;
		if (da !== db) return da > db;
	}
	return false;
}
function discover(spec: ExecutableSpec, platform: NodeJS.Platform): string[] {
	const found: string[] = [];
	const finder = platform === "win32" ? "where" : "which";
	const args = platform === "win32" ? [spec.binName] : ["-a", spec.binName];
	try {
		found.push(...toLines(execFileSyncHidden(finder, args, { encoding: "utf8" })));
	} catch {
		// finder miss is not fatal — fall through to known locations
	}
	found.push(...spec.knownPaths(homedir(), platform).filter((p) => existsSync(p)));
	const unique = [...new Set(found)];
	// See ClaudeExecutableResolver CVE-2024-27980 note: no-shell spawn rejects
	// .cmd/.bat and won't PATHEXT-resolve extensionless shims, so on win32 keep
	// only .exe candidates.
	return platform === "win32" ? unique.filter((f) => f.toLowerCase().endsWith(".exe")) : unique;
}
function defaultProbe(file: string, probeArgs: readonly string[]): { ok: boolean; version?: string } {
	try {
		const out = execFileSyncHidden(file, [...probeArgs], { encoding: "utf8", timeout: 10_000 });
		const version = out.trim().split(/\s+/)[0];
		return { ok: Boolean(version), version };
	} catch {
		return { ok: false };
	}
}

export function resolveExecutable(spec: ExecutableSpec, opts: ResolveOpts = {}): ResolvedExecutable {
	const now = opts.now ?? Date.now;
	const cacheKey = `${spec.binName} ${opts.overridePath ?? ""}`;
	if (cached && cached.key === cacheKey && now() - cached.at < RESOLUTION_CACHE_TTL_MS) return cached.result;

	const probe = opts.probe ?? ((f: string) => defaultProbe(f, spec.probeArgs));
	const platform = opts.platform ?? process.platform;
	const list = opts.overridePath ? [opts.overridePath] : (opts.candidates ?? (() => discover(spec, platform)))();

	let best: ResolvedExecutable | null = null;
	for (const file of list) {
		const r = probe(file);
		if (!r.ok) continue;
		if (!best || isNewer(r.version, best.version)) best = { file, version: r.version ?? "0" };
	}
	if (!best) {
		throw new LocalAgentSetupError(
			opts.overridePath
				? `Configured local agent path "${opts.overridePath}" is not a working ${spec.binName} CLI.`
				: `No compatible ${spec.binName} CLI found. Install/upgrade it, or switch the AI provider.`,
		);
	}
	log.info("Resolved %s executable: %s (v%s)", spec.binName, best.file, best.version);
	cached = { at: now(), key: cacheKey, result: best };
	return best;
}
```

> NUL (` `) as the composite-key separator is written escaped, never as a literal byte (see repo rule: literal NUL makes git treat `.ts` as binary).

- [ ] **Step 4: Refactor ClaudeExecutableResolver into a wrapper**

Replace the body of `cli/src/core/localagent/ClaudeExecutableResolver.ts` so it delegates, keeping the exported `resolveClaudeExecutable` / `__resetResolverCacheForTest` / `ProbeFn` names its tests use:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { __resetResolverCacheForTest as reset, type ProbeFn, resolveExecutable } from "./ExecutableResolver.js";
import type { ResolvedExecutable } from "./Types.js";

export type { ProbeFn };
export const __resetResolverCacheForTest = reset;

const CLAUDE_SPEC = {
	binName: "claude",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32"
			? [join(home, ".local/bin/claude.exe"), join(home, ".claude/local/claude.exe")]
			: [join(home, ".local/bin/claude"), join(home, ".claude/local/claude")],
	// MUST stay in sync with ClaudeCodeBackend.buildInvocation flags.
	probeArgs: ["--permission-mode", "dontAsk", "--version"] as const,
} as const;

interface ResolveOpts {
	readonly overridePath?: string;
	readonly probe?: ProbeFn;
	readonly candidates?: () => string[];
	readonly now?: () => number;
	readonly platform?: NodeJS.Platform;
}
export function resolveClaudeExecutable(opts: ResolveOpts = {}): ResolvedExecutable {
	return resolveExecutable(CLAUDE_SPEC, opts);
}
```

- [ ] **Step 5: Run both resolver test suites to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/ExecutableResolver.test.ts src/core/localagent/ClaudeExecutableResolver.test.ts`
Expected: PASS (the existing Claude tests are the regression guard for the refactor; note that `homedir()` is now used inside `discover`, so any existing test that stubbed `homedir` still applies through the same candidate seam).

---

## Task 4: Widen config + registry list + effective model

**Files:**
- Modify: `cli/src/Types.ts:1072,1175,1177`; `cli/src/core/LlmClient.ts:196-200,249,266-267,457-458`; `cli/src/core/localagent/BackendRegistry.ts`
- Test: `cli/src/core/localagent/BackendRegistry.test.ts` (add case), `cli/src/core/LlmClient.test.ts` (add case)

**Interfaces:**
- Produces: config `localAgentTool?: LocalAgentToolId`, `localAgentModel?: string`; registry `listBackends(): LocalAgentBackend[]`; effective-model rule (empty string ⇒ tool default).
- Consumes: `LocalAgentToolId` (Task 2).

- [ ] **Step 1: Widen the config + local dispatcher types**

`cli/src/Types.ts:1175` — change `readonly localAgentTool?: "claude-code";` to `readonly localAgentTool?: LocalAgentToolId;` and add below `localAgentPath` (line 1177):

```ts
	/** Optional explicit model string passed to the local agent tool. Empty/absent ⇒ the tool's own default model. Ignored for claude-code (uses the action's alias). */
	readonly localAgentModel?: string;
```

`cli/src/core/LlmClient.ts:198` — change the local `readonly localAgentTool?: "claude-code";` to `readonly localAgentTool?: LocalAgentToolId;`, and add `readonly localAgentModel?: string;` after `localAgentPath` (line 200). Import `LocalAgentToolId` from `../Types.js`.

`cli/src/core/LlmClient.ts:249,266-267` — add `localAgentModel` to the `llmCredentials` Pick key list and the returned object:
```ts
// line ~249 key union: add "localAgentModel"
// line ~267 add:
		localAgentModel: config.localAgentModel,
```

- [ ] **Step 2: Add the failing registry test**

```ts
// in cli/src/core/localagent/BackendRegistry.test.ts
it("listBackends returns every registered backend", () => {
	const before = listBackends().length;
	registerBackend({ id: "test-x", displayName: "X", discoverExecutable: async () => ({ file: "x", version: "1" }), buildInvocation: () => ({ file: "x", args: [], stdin: "", env: {}, cwd: "/tmp" }), parseResult: () => ({ text: "", inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, stopReason: null }) });
	expect(listBackends().length).toBe(before + 1);
});
```
(Import `listBackends` alongside the existing imports.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/BackendRegistry.test.ts`
Expected: FAIL — `listBackends` is not exported.

- [ ] **Step 4: Add `listBackends` to the registry**

In `cli/src/core/localagent/BackendRegistry.ts`, add:
```ts
/** All registered backends, in registration order — drives UI tool lists. */
export function listBackends(): LocalAgentBackend[] {
	return [...registry.values()];
}
```

- [ ] **Step 5: Add the effective-model rule in callLocalAgent**

`cli/src/core/LlmClient.ts` around line 457, replace the model passed into the request so non-claude tools use `localAgentModel` (empty ⇒ tool default), while claude-code keeps the resolved alias:
```ts
	const tool = options.localAgentTool ?? "claude-code";
	const backend = getBackend(tool);
	const exe = await backend.discoverExecutable(options.localAgentPath);
	const effectiveModel = tool === "claude-code" ? model : (options.localAgentModel ?? "");
	const invocation = backend.buildInvocation(exe, { prompt, model: effectiveModel, systemPrompt });
```
(Reuse the existing `model` variable already resolved above for claude-code; only the request's `model` field changes.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/BackendRegistry.test.ts src/core/LlmClient.test.ts`
Expected: PASS.

---

## Task 5: Footer attribution — `Local agent - <tool>`

**Files:**
- Modify: `cli/src/Types.ts:295` (add `localAgentTool?` to `LlmCallMetadata`); `cli/src/core/LlmClient.ts:485-494`; `cli/src/core/SummaryFormat.ts:126-167`
- Test: `cli/src/core/SummaryFormat.test.ts` (add cases)

**Interfaces:**
- Consumes: `LlmCallMetadata.localAgentTool` persisted at generation time; `localAgentToolLabel` (Task 2).
- Produces: footer strings `"Local agent - Cursor"` etc.

- [ ] **Step 1: Persist the tool on call metadata**

`cli/src/Types.ts:295` — after `readonly source?: LlmCredentialSource;` add:
```ts
	/** For source === "local-agent": which tool produced it, for footer attribution. Absent on older summaries. */
	readonly localAgentTool?: LocalAgentToolId;
```
`cli/src/core/LlmClient.ts:485-494` — add to the returned metadata object:
```ts
			source,
			localAgentTool: tool,
```
(`tool` is in scope from Task 4 Step 5.)

- [ ] **Step 2: Write the failing test**

```ts
// in cli/src/core/SummaryFormat.test.ts
it("renders the specific local-agent tool in the footer", () => {
	const summary = { llm: { model: "m", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: null, source: "local-agent", localAgentTool: "cursor-agent" }, children: [] } as unknown as CommitSummary;
	expect(formatProviderLabel(summary)).toBe("Local agent - Cursor");
});
it("falls back to bare 'Local agent' when the tool is absent (old summary)", () => {
	const summary = { llm: { model: "m", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: null, source: "local-agent" }, children: [] } as unknown as CommitSummary;
	expect(formatProviderLabel(summary)).toBe("Local agent");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryFormat.test.ts -t "local-agent tool"`
Expected: FAIL — returns `"Local agent"`, not `"Local agent - Cursor"`.

- [ ] **Step 4: Rework `formatProviderLabel` to be node-aware**

In `cli/src/core/SummaryFormat.ts`, import the label helper and collect per-node labels instead of bare sources:
```ts
import { localAgentToolLabel } from "./localagent/ToolMeta.js";
```
Replace `collectLlmSources`/`formatProviderLabel` usage in the label path with a label collector (keep `collectLlmSources` if other callers use it — grep first; if unused elsewhere, replace it):
```ts
function nodeLabel(llm: NonNullable<CommitSummary["llm"]>): string {
	if (llm.source === "local-agent") {
		return llm.localAgentTool ? `Local agent - ${localAgentToolLabel(llm.localAgentTool)}` : "Local agent";
	}
	return PROVIDER_LABELS[llm.source ?? "anthropic-config"];
}

export function formatProviderLabel(summary: CommitSummary): string | undefined {
	const labels = new Set<string>();
	const visit = (n: CommitSummary): void => {
		if (n.llm?.source) labels.add(nodeLabel(n.llm));
		for (const c of n.children ?? []) visit(c);
	};
	visit(summary);
	const list = [...labels];
	if (list.length === 0) return undefined;
	if (list.length === 1) return list[0];
	return `mixed: ${list.join(", ")}`;
}
```
> `ToolMeta.ts` is dependency-free (no `@anthropic-ai/sdk`), so importing it into `SummaryFormat` does not pull the heavy LLM graph — this is why the labels live in `ToolMeta`, not the backend classes.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryFormat.test.ts`
Expected: PASS (including the pre-existing non-local-agent footer cases — regression guard).

---

## Task 6: CursorAgentBackend

**Files:**
- Create: `cli/src/core/localagent/CursorAgentBackend.ts`, `cli/src/core/localagent/CursorAgentBackend.test.ts`
- Modify: `cli/src/core/LlmClient.ts:27` (register)

**Interfaces:**
- Consumes: `resolveExecutable` (Task 3), `LocalAgentRunner`, error taxonomy.
- Produces: `class CursorAgentBackend implements LocalAgentBackend { id = "cursor-agent" }`.

- [ ] **Step 1: Reconcile against the Task 1 fixture**

Open `cli/src/core/localagent/__fixtures__/cursor-agent/success.json` + `help.txt`. Confirm: envelope keys (`type`,`subtype`,`is_error`,`result`); whether the prompt is a positional arg (used above) or needs stdin; whether a `--system`/system-prompt flag exists. Correct the code below to match the capture before finalizing.

- [ ] **Step 2: Write the failing test (fixture-driven)**

```ts
// cli/src/core/localagent/CursorAgentBackend.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CursorAgentBackend } from "./CursorAgentBackend.js";
import { LocalAgentAuthError } from "./Types.js";

const fixture = readFileSync(join(__dirname, "__fixtures__/cursor-agent/success.json"), "utf8");
const b = new CursorAgentBackend();

describe("CursorAgentBackend", () => {
	it("parses the real success envelope into text", () => {
		const out = b.parseResult(fixture);
		expect(out.text).toContain("42"); // the JSON the probe prompt forced
		expect(out.costUsd).toBe(0); // cursor exposes no cost in headless json
	});
	it("scrubs CURSOR_API_KEY and denies repo cwd pollution", () => {
		const inv = b.buildInvocation({ file: "cursor-agent", version: "1" }, { prompt: "hi", model: "", systemPrompt: "sys" });
		expect(inv.env.CURSOR_API_KEY).toBeUndefined();
		expect(inv.cwd).toContain("jolli-localagent-");
	});
	it("classifies an is_error auth envelope", () => {
		expect(() => b.parseResult(JSON.stringify({ type: "result", is_error: true, subtype: "not_logged_in", result: "please log in" })))
			.toThrow(LocalAgentAuthError);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/CursorAgentBackend.test.ts`
Expected: FAIL — cannot resolve `./CursorAgentBackend.js`.

- [ ] **Step 4: Write CursorAgentBackend.ts**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { LOCAL_AGENT_TMP_PREFIX } from "./ClaudeCodeBackend.js";
import { resolveExecutable } from "./ExecutableResolver.js";
import {
	type Invocation,
	LocalAgentAuthError,
	type LocalAgentBackend,
	type LocalAgentOutcome,
	type LocalAgentRequest,
	LocalAgentSetupError,
	type ResolvedExecutable,
} from "./Types.js";

interface CursorEnvelope { type?: string; subtype?: string; is_error?: boolean; result?: string; }

const CURSOR_SPEC = {
	binName: "cursor-agent",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32" ? [join(home, ".local/bin/cursor-agent.exe")] : [join(home, ".local/bin/cursor-agent")],
	probeArgs: ["--version"] as const,
} as const;

export class CursorAgentBackend implements LocalAgentBackend {
	readonly id = "cursor-agent";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(CURSOR_SPEC, { overridePath }));
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.CURSOR_API_KEY; // force subscription login
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		const cwd = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
		// cursor-agent has no separate system-prompt flag in headless mode, so the
		// system prompt is prepended to the user prompt. (Confirm against Task 1 help.txt.)
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = ["-p", "--output-format", "json", ...(req.model ? ["--model", req.model] : []), prompt];
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		let env: CursorEnvelope;
		try {
			env = JSON.parse(stdout) as CursorEnvelope;
		} catch {
			throw new LocalAgentSetupError(`Could not parse Cursor output as JSON (first 200 chars): ${stdout.slice(0, 200)}`);
		}
		if (env.is_error) {
			const detail = env.result ?? env.subtype ?? "unknown";
			const msg = `Cursor returned an error: ${detail}`;
			if (/log ?in|logged in|unauthori|authenticat|not_logged_in/i.test(detail) || /auth/i.test(env.subtype ?? "")) {
				throw new LocalAgentAuthError(msg);
			}
			throw new LocalAgentSetupError(msg);
		}
		return { text: env.result ?? "", inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, stopReason: env.subtype ?? null };
	}
}
```

- [ ] **Step 5: Register it**

`cli/src/core/LlmClient.ts` after line 27:
```ts
registerBackend(new CursorAgentBackend());
```
(Add the import at the top alongside `ClaudeCodeBackend`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/CursorAgentBackend.test.ts`
Expected: PASS.

---

## Task 7: CodexBackend (JSONL event stream)

**Files:**
- Create: `cli/src/core/localagent/CodexBackend.ts`, `cli/src/core/localagent/CodexBackend.test.ts`
- Modify: `cli/src/core/LlmClient.ts:27` (register)

**Interfaces:**
- Produces: `class CodexBackend implements LocalAgentBackend { id = "codex" }`.

- [ ] **Step 1: Reconcile against the Task 1 fixture**

Open `__fixtures__/codex/success.json`. Codex `--json` emits **JSONL** (one event per line). Identify: (a) the event carrying the final assistant text — likely `type: "item.completed"` with an `assistant`/`agent_message` item, or `type: "turn.completed"`; (b) the usage/token event. Set `FINAL_EVENT_TYPES` and the text/usage field paths below to the real names before finalizing.

- [ ] **Step 2: Write the failing test (fixture-driven)**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "./CodexBackend.js";

const fixture = readFileSync(join(__dirname, "__fixtures__/codex/success.json"), "utf8");
const b = new CodexBackend();

describe("CodexBackend", () => {
	it("extracts the final assistant message from the JSONL stream", () => {
		const out = b.parseResult(fixture);
		expect(out.text).toContain("42");
	});
	it("scrubs OPENAI_API_KEY", () => {
		const inv = b.buildInvocation({ file: "codex", version: "1" }, { prompt: "hi", model: "", systemPrompt: "sys" });
		expect(inv.env.OPENAI_API_KEY).toBeUndefined();
	});
	it("ignores non-JSON lines without throwing", () => {
		expect(() => b.parseResult('not json\n{"type":"turn.completed"}\n')).not.toThrow();
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/CodexBackend.test.ts`
Expected: FAIL — cannot resolve `./CodexBackend.js`.

- [ ] **Step 4: Write CodexBackend.ts**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { LOCAL_AGENT_TMP_PREFIX } from "./ClaudeCodeBackend.js";
import { resolveExecutable } from "./ExecutableResolver.js";
import {
	type Invocation, LocalAgentAuthError, type LocalAgentBackend, type LocalAgentOutcome,
	type LocalAgentRequest, LocalAgentSetupError, type ResolvedExecutable,
} from "./Types.js";

// Event `type` names that carry the final assistant text. CONFIRM against the
// Task 1 fixture — these are the documented candidates.
const FINAL_TEXT_EVENTS = ["item.completed", "agent_message", "turn.completed"];

const CODEX_SPEC = {
	binName: "codex",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32" ? [join(home, ".local/bin/codex.exe")] : [join(home, ".local/bin/codex")],
	probeArgs: ["--version"] as const,
} as const;

export class CodexBackend implements LocalAgentBackend {
	readonly id = "codex";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(CODEX_SPEC, { overridePath }));
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.OPENAI_API_KEY;
		delete env.OPENAI_BASE_URL; // confirm needed against Task 1
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		const cwd = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = [
			"exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", cwd,
			...(req.model ? ["--model", req.model] : []), prompt,
		];
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		let text = "";
		let inputTokens = 0, outputTokens = 0, cachedTokens = 0;
		let sawEvent = false;
		for (const line of stdout.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let ev: Record<string, unknown>;
			try { ev = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
			sawEvent = true;
			const type = String(ev.type ?? "");
			if (/error/i.test(type) && /auth|login|unauthor/i.test(JSON.stringify(ev))) {
				throw new LocalAgentAuthError(`Codex auth error: ${JSON.stringify(ev).slice(0, 200)}`);
			}
			// Confirm the exact text path against the fixture; this walks the common shapes.
			if (FINAL_TEXT_EVENTS.includes(type)) {
				const t = extractText(ev);
				if (t) text = t;
			}
			const usage = (ev.usage ?? (ev as { info?: { usage?: unknown } }).info?.usage) as
				| { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | undefined;
			if (usage) {
				inputTokens = usage.input_tokens ?? inputTokens;
				outputTokens = usage.output_tokens ?? outputTokens;
				cachedTokens = usage.cached_input_tokens ?? cachedTokens;
			}
		}
		if (!sawEvent) throw new LocalAgentSetupError(`Codex produced no JSONL events (first 200 chars): ${stdout.slice(0, 200)}`);
		return { text, inputTokens, outputTokens, cachedTokens, costUsd: 0, stopReason: null };
	}
}

function extractText(ev: Record<string, unknown>): string {
	// Common shapes: ev.text, ev.message, ev.item.text, ev.item.content[].text
	if (typeof ev.text === "string") return ev.text;
	if (typeof ev.message === "string") return ev.message;
	const item = ev.item as { text?: string; content?: Array<{ text?: string }> } | undefined;
	if (item?.text) return item.text;
	if (item?.content) return item.content.map((c) => c.text ?? "").join("");
	return "";
}
```

- [ ] **Step 5: Register it**

`cli/src/core/LlmClient.ts` after line 27: `registerBackend(new CodexBackend());` (+ import).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/CodexBackend.test.ts`
Expected: PASS. If the fixture reveals a different event/text shape, adjust `FINAL_TEXT_EVENTS`/`extractText` until the real-fixture test is green.

---

## Task 8: OpenCodeBackend (BYOK, plain stdout)

**Files:**
- Create: `cli/src/core/localagent/OpenCodeBackend.ts`, `cli/src/core/localagent/OpenCodeBackend.test.ts`
- Modify: `cli/src/core/LlmClient.ts:27` (register)

**Interfaces:**
- Produces: `class OpenCodeBackend implements LocalAgentBackend { id = "opencode" }`.

- [ ] **Step 1: Reconcile against the Task 1 fixture**

Open `__fixtures__/opencode/success.json` + `help.txt`. Confirm: whether `opencode run` has a structured-output flag (if yes, prefer it); the `--model` syntax (`provider/model`); how an auth failure surfaces (exit code + stderr). Do NOT scrub env — OpenCode is BYOK.

- [ ] **Step 2: Write the failing test (fixture-driven)**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenCodeBackend } from "./OpenCodeBackend.js";

const fixture = readFileSync(join(__dirname, "__fixtures__/opencode/success.json"), "utf8");
const b = new OpenCodeBackend();

describe("OpenCodeBackend", () => {
	it("returns the assistant text from stdout", () => {
		expect(b.parseResult(fixture).text).toContain("42");
	});
	it("does NOT scrub provider credentials (BYOK)", () => {
		process.env.OPENCODE_TEST_KEY = "x";
		const inv = b.buildInvocation({ file: "opencode", version: "1" }, { prompt: "hi", model: "", systemPrompt: "sys" });
		expect(inv.env.OPENCODE_TEST_KEY).toBe("x");
		delete process.env.OPENCODE_TEST_KEY;
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/OpenCodeBackend.test.ts`
Expected: FAIL — cannot resolve `./OpenCodeBackend.js`.

- [ ] **Step 4: Write OpenCodeBackend.ts**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { LOCAL_AGENT_TMP_PREFIX } from "./ClaudeCodeBackend.js";
import { resolveExecutable } from "./ExecutableResolver.js";
import {
	type Invocation, type LocalAgentBackend, type LocalAgentOutcome,
	type LocalAgentRequest, LocalAgentSetupError, type ResolvedExecutable,
} from "./Types.js";

const OPENCODE_SPEC = {
	binName: "opencode",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32" ? [join(home, ".local/bin/opencode.exe")] : [join(home, ".local/bin/opencode")],
	probeArgs: ["--version"] as const,
} as const;

export class OpenCodeBackend implements LocalAgentBackend {
	readonly id = "opencode";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(OPENCODE_SPEC, { overridePath }));
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		// BYOK: do NOT scrub provider credentials — OpenCode uses its own stored auth.
		const env: NodeJS.ProcessEnv = { ...process.env };
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		const cwd = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = ["run", ...(req.model ? ["--model", req.model] : []), prompt];
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		const text = stdout.trim();
		if (!text) throw new LocalAgentSetupError("OpenCode produced no output.");
		// No cost/token accounting in plain-run mode. If Task 1 shows a --json flag,
		// prefer it in buildInvocation and parse structured usage here instead.
		return { text, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, stopReason: null };
	}
}
```

- [ ] **Step 5: Register it**

`cli/src/core/LlmClient.ts` after line 27: `registerBackend(new OpenCodeBackend());` (+ import).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/localagent/OpenCodeBackend.test.ts`
Expected: PASS.

---

## Task 9: CLI wiring (enable / configure / doctor)

**Files:**
- Modify: `cli/src/commands/EnableCommand.ts`, `cli/src/commands/ConfigureCommand.ts`, `cli/src/commands/AuthCommand.ts` (doctor), `cli/src/commands/GuidedFrontDoor.ts`
- Test: the matching `*.test.ts` for each command

**Interfaces:**
- Consumes: `listBackends()` (Task 4), `LOCAL_AGENT_TOOLS`/`localAgentToolLabel` (Task 2).

- [ ] **Step 1: Reconcile login commands**

Confirm `LOCAL_AGENT_TOOLS[*].loginHint` command names against Task 1 `help.txt` (`codex login`, `cursor-agent login`, `opencode auth login`).

- [ ] **Step 2: Write failing tests**

For `EnableCommand.test.ts` — assert that selecting the local-agent option then choosing "Codex" persists `{ aiProvider: "local-agent", localAgentTool: "codex" }`:
```ts
it("persists the chosen local-agent tool", async () => {
	// drive the interactive menu picking local-agent → Codex (follow the file's existing prompt-stub pattern)
	// then:
	expect(savedConfig.aiProvider).toBe("local-agent");
	expect(savedConfig.localAgentTool).toBe("codex");
});
```
For `ConfigureCommand.test.ts` — `configure --set aiProvider=local-agent --set localAgentTool=cursor-agent --set localAgentModel=""` is accepted and stored (assert the parser doesn't reject the keys).
For `AuthCommand.test.ts` (doctor) — when `localAgentTool="opencode"` and not logged in, the diagnostic message contains the OpenCode login hint.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/commands/EnableCommand.test.ts src/commands/ConfigureCommand.test.ts src/commands/AuthCommand.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

- `EnableCommand.ts`: where the local-agent option is handled (Claude added it as a top-level menu item), add a second-level prompt iterating `listBackends()` (label via `localAgentToolLabel(b.id)`), storing the chosen `id` as `localAgentTool`. Keep the early-return that skips the Anthropic key prompt.
- `ConfigureCommand.ts`: add `localAgentTool` and `localAgentModel` to the accepted `--set` keys / validation (mirror `localAgentPath`). `localAgentTool` must validate against the `LocalAgentToolId` union.
- `AuthCommand.ts` (doctor): where the local-agent login check lives, read `config.localAgentTool ?? "claude-code"` and surface `LOCAL_AGENT_TOOLS[tool].loginHint` in the remediation message.
- `GuidedFrontDoor.ts`: same tool selection as EnableCommand for the guided path (follow its existing local-agent branch).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/commands/EnableCommand.test.ts src/commands/ConfigureCommand.test.ts src/commands/AuthCommand.test.ts`
Expected: PASS.

---

## Task 10: VS Code UI wiring

**Files:**
- Modify: `vscode/src/views/SettingsHtmlBuilder.ts`, `vscode/src/providers/StatusTreeProvider.ts`
- Test: `vscode/src/views/SettingsHtmlBuilder.test.ts`, `vscode/src/providers/StatusTreeProvider.test.ts`

**Interfaces:**
- Consumes: `listBackends()` / `LOCAL_AGENT_TOOLS` (bundled from `cli/src/**`).

- [ ] **Step 1: Write failing tests**

`SettingsHtmlBuilder.test.ts` — the rendered agent-tool `<select>` contains all four `<option>`s (`claude-code`, `codex`, `cursor-agent`, `opencode`) with their display labels.
`StatusTreeProvider.test.ts` — when `aiProvider="local-agent"` and `localAgentTool="codex"`, the status row label reads "Local agent - Codex".

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vscode -- src/views/SettingsHtmlBuilder.test.ts src/providers/StatusTreeProvider.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `SettingsHtmlBuilder.ts`: the existing single-option agent-tool dropdown becomes a loop over the four tools (source the list from `LOCAL_AGENT_TOOLS`). Respect the CSP rules — no inline `style`/handlers; wire the `change` handler via the existing `addEventListener` message-passing pattern used by the other provider controls. Reuse the existing provider-card layout.
- `StatusTreeProvider.ts`: the local-agent status row label uses `Local agent - ${localAgentToolLabel(tool)}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vscode -- src/views/SettingsHtmlBuilder.test.ts src/providers/StatusTreeProvider.test.ts`
Expected: PASS.

---

## Task 11: Full verification + single commit

**Files:** none (verification + commit only).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage ≥ 97/96/97/97. Fix any lint (Biome tabs/120col/`useImportType`) or coverage gaps (add `/* v8 ignore start/stop */` blocks only for genuinely unreachable branches) until green.

- [ ] **Step 2: Stage and commit once (DCO, no AI co-author)**

```bash
git add cli/ vscode/ scripts/probe-local-agents.mjs
git commit -s -m "feat: add Codex, Cursor, and OpenCode local-agent backends

Implements three additional headless CLI backends behind the existing
local-agent provider registry: Cursor (single JSON envelope), Codex
(JSONL event stream), and OpenCode (BYOK, plain stdout). Adds a
parameterized executable resolver, a dependency-free tool-metadata table,
per-tool auth posture (scrub credentials for Codex/Cursor, pass-through
for OpenCode), per-tool footer attribution (Local agent - <tool>), and
surfaces the choice in the CLI enable/configure/doctor flows and the VS
Code settings dropdown and status row. Parsers are verified against real
captured fixtures."
```

> Do NOT stage `cli/src/core/localagent/__fixtures__/` out — the fixtures ARE part of the test suite and must be committed. Verify they contain no secrets before committing (the probe prompt is benign; check `meta.json` stderrTail for leaked tokens and redact if present).

---

## Self-Review

**Spec coverage:**
- §3 auth posture → Tasks 6 (scrub CURSOR_API_KEY), 7 (scrub OPENAI_API_KEY), 8 (no scrub). ✅
- §4.1 reuse runner/interface → all backend tasks reuse `LocalAgentRunner` via `callLocalAgent`; no runner changes. ✅
- §4.2 generalized resolver + composite cache key → Task 3. ✅
- §4.3 new files → Tasks 2,3,6,7,8. ✅
- §5 per-tool invocation/parser → Tasks 6,7,8, each gated on Task 1 fixtures. ✅
- §6 model handling → Task 4 Step 5 (effective model; empty ⇒ tool default) + each backend's `req.model ? --model : omit`. ✅
- §7 probe script → Task 1. ✅
- §8 wiring (enum, footer, CLI, doctor, VS Code) → Tasks 4,5,9,10. ✅
- §9 testing (coverage floor, v8 blocks, platform, deferred commit) → Global Constraints + Task 11. ✅
- §10 risks → mitigated by Task 1 checkpoint before parser finalization. ✅

**Placeholder scan:** The 🔍 items are confined to Task 1's checkpoint output and the "reconcile against fixture" opening step of Tasks 6–8; baseline code is complete and runnable, corrected against real captures — not left as TODO. No `TBD`/`implement later` steps.

**Type consistency:** `LocalAgentToolId` defined once (Types.ts, Task 2) and reused in config (Task 4), metadata (Task 2), and `LlmCallMetadata` (Task 5). Backend ids (`"cursor-agent"`,`"codex"`,`"opencode"`) match the `LOCAL_AGENT_TOOLS` keys and the resolver `binName`s. `resolveExecutable(spec, opts)` signature is consistent across Tasks 3,6,7,8. `LOCAL_AGENT_TMP_PREFIX` imported from `ClaudeCodeBackend.ts` in all three new backends (matches the existing export).
