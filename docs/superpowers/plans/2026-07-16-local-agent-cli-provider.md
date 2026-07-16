# Local Agent CLI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third `LlmClient` backend that drives the local Claude Code CLI headless (`claude -p --output-format json`) using the user's subscription OAuth login, avoiding Anthropic API-key billing.

**Architecture:** A new `local-agent` credential source routes `callLlm` to `callLocalAgent`, which resolves a pluggable `LocalAgentBackend` (v1: `ClaudeCodeBackend`), discovers the `claude` binary via a capability probe, spawns it in an isolated temp cwd with API-key env scrubbed (forcing subscription OAuth), and parses the JSON result envelope back into the unchanged `LlmCallResult` contract. All 7 generation pipelines (summarize / squash / plan-progress / rank-context / route / reconcile / graph-*) switch over automatically because they all funnel through `callLlm`.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, `node:child_process` (`execFile`/`spawn`), Biome (tabs, 120 col).

## Global Constraints

Copied verbatim from repo rules — every task implicitly includes these:

- **Coverage floor (CLI):** 97% statements / 96% branches / 97% functions / 97% lines. New code under `cli/src/` must not regress it.
- **Biome:** tabs, 4-wide, 120 column limit. `noExplicitAny: error`, `noUnusedImports/Variables: error`, `useImportType: warn`. `biome check --error-on-warnings` — warnings fail CI.
- **Path normalization:** use `toForwardSlash` from `cli/src/core/PathUtils.ts`; never inline `path.replace(/\\/g, "/")`.
- **No literal NUL in source:** write `\x00` escaped.
- **Commit discipline (reconciled for subagent-driven execution):** each task commits its own work with DCO sign-off (`git commit -s`) so it is an isolated, reviewable unit. Within a task run ONLY that task's own new test file(s) to confirm they pass — do NOT run the full `npm run all` per task. The full clean→build→lint→full-coverage gate runs exactly once, in the final task (Task 9).
- **Commit message:** DCO sign-off (`git commit -s`). No `Co-Authored-By: Claude …` / no `🤖 Generated with …`.
- **VS Code webview:** toggle visibility with the `.hidden` CSS class (never HTML `hidden` attr or `el.hidden=`); dynamic styles via CSS class; events via `addEventListener` (no inline `style=`/handlers — strict CSP drops them). Builders returning a single template literal must not contain backticks in comments.
- **`claude` invocation flags MUST stay in sync** between `ClaudeCodeBackend.buildInvocation` and `ClaudeExecutableResolver`'s capability probe.

## Contract facts (verified against current code)

- `LlmCredentialSource` = `"anthropic-config" | "anthropic-env" | "jolli-proxy"` at [`cli/src/Types.ts:254`](../../../cli/src/Types.ts#L254).
- `LlmCallResult` (return of `callLlm`) at [`cli/src/core/LlmClient.ts:255`](../../../cli/src/core/LlmClient.ts#L255):
  `{ text?: string; model?: string; inputTokens: number; outputTokens: number; cachedTokens: number; apiLatencyMs: number; stopReason?: string | null; source: LlmCredentialSource }`.
- `resolveModelId(alias)` exported from [`cli/src/core/Summarizer.ts:50`](../../../cli/src/core/Summarizer.ts#L50); aliases haiku/sonnet/opus, unknown passes through.
- Template fill: `TEMPLATES.get(action)`, `fillTemplate(tpl, params)`, `findUnfilledPlaceholders(tpl, params)` from [`cli/src/core/PromptTemplates.ts`](../../../cli/src/core/PromptTemplates.ts).
- `callLlm` dispatch switch at [`cli/src/core/LlmClient.ts:298`](../../../cli/src/core/LlmClient.ts#L298); `resolveLlmCredentialSource` at line 206; `LlmCredentials` interface at line 169; `LlmCallOptions extends LlmCredentials` at line 224.
- Real result envelope (smoke test, `claude` 2.1.210) — fixture source:
  `{ "type":"result","subtype":"success","is_error":false,"result":"<text>","total_cost_usd":0.0105,"session_id":"…","usage":{"input_tokens":10,"output_tokens":198,"cache_read_input_tokens":0,"cache_creation_input_tokens":4738} }`.

---

## Task 1: Config schema + `local-agent` credential routing

**Files:**
- Modify: `cli/src/Types.ts` (line 254 `LlmCredentialSource`; `JolliMemoryConfig` add fields; line 1044 `LlmConfig` Pick)
- Modify: `cli/src/core/LlmClient.ts` (line 169 `LlmCredentials`; line 206 `resolveLlmCredentialSource`)
- Test: `cli/src/core/LlmClient.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `LlmCredentialSource` now includes `"local-agent"`. `LlmCredentials` (and `LlmCallOptions`) gain `localAgentTool?: "claude-code"` and `localAgentPath?: string`, and `aiProvider` union gains `"local-agent"`. `resolveLlmCredentialSource(creds)` returns `"local-agent"` when `aiProvider === "local-agent"`.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/LlmClient.test.ts`:

```ts
import { resolveLlmCredentialSource } from "./LlmClient.js";

describe("resolveLlmCredentialSource — local-agent", () => {
	it("returns local-agent when aiProvider is local-agent, regardless of keys", () => {
		expect(resolveLlmCredentialSource({ aiProvider: "local-agent" })).toBe("local-agent");
		// A stray Anthropic key must NOT redirect away from the explicit choice.
		expect(resolveLlmCredentialSource({ aiProvider: "local-agent", apiKey: "sk-ant-x" })).toBe("local-agent");
	});

	it("does not pick local-agent by presence — only the explicit choice selects it", () => {
		// No aiProvider set → legacy precedence, never local-agent.
		expect(resolveLlmCredentialSource({ apiKey: "sk-ant-x" })).toBe("anthropic-config");
	});
});
```

- [ ] **Step 2: Implement**

In `cli/src/Types.ts`, extend the union (line 254):

```ts
export type LlmCredentialSource = "anthropic-config" | "anthropic-env" | "jolli-proxy" | "local-agent";
```

In `JolliMemoryConfig` (near `aiProvider`, line 1116), widen the union and add fields:

```ts
	readonly aiProvider?: "anthropic" | "jolli" | "local-agent";
	/**
	 * Which local Agent CLI tool to drive when `aiProvider` is "local-agent".
	 * v1 supports only Claude Code; the enum is reserved for future tools
	 * (Codex, Cursor). Ignored unless `aiProvider === "local-agent"`.
	 */
	readonly localAgentTool?: "claude-code";
	/** Optional explicit path to the local agent binary, overriding PATH discovery. */
	readonly localAgentPath?: string;
```

Extend the `LlmConfig` Pick (line 1044) so callers forward the new fields:

```ts
export type LlmConfig = Pick<
	JolliMemoryConfig,
	"apiKey" | "model" | "jolliApiKey" | "aiProvider" | "localAgentTool" | "localAgentPath"
>;
```

In `cli/src/core/LlmClient.ts` `LlmCredentials` (line 186), widen and add:

```ts
	readonly aiProvider?: "anthropic" | "jolli" | "local-agent";
	/** Which local agent tool to drive when aiProvider === "local-agent" (v1: "claude-code"). */
	readonly localAgentTool?: "claude-code";
	/** Optional explicit path to the local agent binary, overriding PATH discovery. */
	readonly localAgentPath?: string;
```

Update the `resolveLlmCredentialSource` param `Pick` (line 207) to include the new discriminant and add the branch (top of the function body, before the `aiProvider === "jolli"` check):

```ts
export function resolveLlmCredentialSource(
	credentials: Pick<LlmCredentials, "apiKey" | "jolliApiKey" | "aiProvider">,
): LlmCredentialSource | null {
	if (credentials.aiProvider === "local-agent") {
		// The local agent uses the tool's own login (subscription OAuth); no
		// jollimemory-held credential is required, so presence checks don't apply.
		return "local-agent";
	}
	if (credentials.aiProvider === "jolli") {
```

---

## Task 2: `LocalAgentBackend` interface + `BackendRegistry`

**Files:**
- Create: `cli/src/core/localagent/Types.ts`
- Create: `cli/src/core/localagent/BackendRegistry.ts`
- Test: `cli/src/core/localagent/BackendRegistry.test.ts`

**Interfaces:**
- Produces:
  - `interface ResolvedExecutable { file: string; version: string }`
  - `interface LocalAgentRequest { prompt: string; model: string; systemPrompt: string; maxTokens: number; timeoutMs?: number }`
  - `interface LocalAgentOutcome { text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; stopReason: string | null }`
  - `interface Invocation { file: string; args: string[]; stdin: string; env: NodeJS.ProcessEnv; cwd: string }`
  - `interface LocalAgentBackend { readonly id: string; discoverExecutable(overridePath?: string): Promise<ResolvedExecutable>; buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation; parseResult(stdout: string): LocalAgentOutcome }`
  - error classes `LocalAgentSetupError`, `LocalAgentAuthError`, `LocalAgentTransientError` (each `extends Error` with a `name`)
  - `getBackend(id: string): LocalAgentBackend` and `registerBackend(b: LocalAgentBackend): void`

- [ ] **Step 1: Write the failing test**

`cli/src/core/localagent/BackendRegistry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getBackend, registerBackend } from "./BackendRegistry.js";
import type { LocalAgentBackend } from "./Types.js";

const fake: LocalAgentBackend = {
	id: "fake-tool",
	discoverExecutable: async () => ({ file: "/x/claude", version: "9.9.9" }),
	buildInvocation: () => ({ file: "/x/claude", args: [], stdin: "", env: {}, cwd: "/tmp" }),
	parseResult: () => ({ text: "", inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, stopReason: null }),
};

describe("BackendRegistry", () => {
	it("returns a registered backend by id", () => {
		registerBackend(fake);
		expect(getBackend("fake-tool")).toBe(fake);
	});

	it("throws a setup error for an unknown tool id", () => {
		expect(() => getBackend("nope")).toThrowError(/unknown local agent tool/i);
	});
});
```

- [ ] **Step 2: Implement**

`cli/src/core/localagent/Types.ts`:

```ts
/** A resolved, capability-verified local agent executable. */
export interface ResolvedExecutable {
	readonly file: string;
	readonly version: string;
}

/** One completion request, already template-filled and model-resolved. */
export interface LocalAgentRequest {
	readonly prompt: string;
	readonly model: string;
	readonly systemPrompt: string;
	readonly maxTokens: number;
	readonly timeoutMs?: number;
}

/** Normalized result of one local-agent completion. */
export interface LocalAgentOutcome {
	readonly text: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedTokens: number;
	readonly costUsd: number;
	readonly stopReason: string | null;
}

/** A fully-specified child-process invocation. */
export interface Invocation {
	readonly file: string;
	readonly args: readonly string[];
	readonly stdin: string;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
}

export interface LocalAgentBackend {
	readonly id: string;
	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable>;
	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation;
	parseResult(stdout: string): LocalAgentOutcome;
}

/** Binary missing / too old / tool not installed — won't recover on retry. */
export class LocalAgentSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentSetupError";
	}
}

/** Not signed in to the tool's subscription — user must log in. */
export class LocalAgentAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentAuthError";
	}
}

/** Timeout / rate-limit / overloaded — safe to retry later. */
export class LocalAgentTransientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentTransientError";
	}
}
```

`cli/src/core/localagent/BackendRegistry.ts`:

```ts
import { type LocalAgentBackend, LocalAgentSetupError } from "./Types.js";

const registry = new Map<string, LocalAgentBackend>();

/** Registers (or replaces) a backend under its `id`. */
export function registerBackend(backend: LocalAgentBackend): void {
	registry.set(backend.id, backend);
}

/**
 * Returns the backend for `id`, or throws a setup error listing what is
 * available. v1 registers only "claude-code" (see ClaudeCodeBackend); the
 * registry is the extension point for future tools (Codex, Cursor).
 */
export function getBackend(id: string): LocalAgentBackend {
	const backend = registry.get(id);
	if (!backend) {
		const known = [...registry.keys()].join(", ") || "(none registered)";
		throw new LocalAgentSetupError(`Unknown local agent tool "${id}". Available: ${known}.`);
	}
	return backend;
}
```

---

## Task 3: `ClaudeCodeBackend.parseResult` (real-fixture JSON parsing)

**Files:**
- Create: `cli/src/core/localagent/ClaudeCodeBackend.ts` (parseResult first; buildInvocation added in Task 4)
- Create: `cli/src/core/localagent/fixtures/claude-print-success.json` (the real smoke-test envelope)
- Test: `cli/src/core/localagent/ClaudeCodeBackend.test.ts`

**Interfaces:**
- Consumes: `LocalAgentOutcome`, error classes from Task 2 Types.
- Produces: `class ClaudeCodeBackend implements LocalAgentBackend` with a working `parseResult(stdout): LocalAgentOutcome`. `discoverExecutable`/`buildInvocation` may throw `new Error("not implemented")` until later tasks — they are not exercised by this task's tests.

- [ ] **Step 1: Add the real fixture**

`cli/src/core/localagent/fixtures/claude-print-success.json` (captured from `claude` 2.1.210 — do not hand-edit the shape):

```json
{
	"type": "result",
	"subtype": "success",
	"is_error": false,
	"result": "PONG",
	"stop_reason": "end_turn",
	"session_id": "e550af2b-fef4-4dbc-9bf0-83ce285e4f77",
	"total_cost_usd": 0.010476,
	"usage": {
		"input_tokens": 10,
		"cache_creation_input_tokens": 4738,
		"cache_read_input_tokens": 0,
		"output_tokens": 198
	}
}
```

- [ ] **Step 2: Write the failing test**

`cli/src/core/localagent/ClaudeCodeBackend.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend } from "./ClaudeCodeBackend.js";
import { LocalAgentAuthError, LocalAgentTransientError } from "./Types.js";

const successFixture = readFileSync(
	fileURLToPath(new URL("./fixtures/claude-print-success.json", import.meta.url)),
	"utf8",
);
const backend = new ClaudeCodeBackend();

describe("ClaudeCodeBackend.parseResult", () => {
	it("maps the real success envelope to LocalAgentOutcome", () => {
		const out = backend.parseResult(successFixture);
		expect(out.text).toBe("PONG");
		expect(out.inputTokens).toBe(10);
		expect(out.outputTokens).toBe(198);
		// cachedTokens = cache_read + cache_creation.
		expect(out.cachedTokens).toBe(4738);
		expect(out.costUsd).toBeCloseTo(0.010476);
		expect(out.stopReason).toBe("end_turn");
	});

	it("throws auth error on is_error with a 401/403 api status", () => {
		const json = JSON.stringify({ type: "result", is_error: true, subtype: "error", api_error_status: 401, result: "Unauthorized" });
		expect(() => backend.parseResult(json)).toThrowError(LocalAgentAuthError);
	});

	it("throws transient error on is_error with a 429 api status", () => {
		const json = JSON.stringify({ type: "result", is_error: true, subtype: "error", api_error_status: 429, result: "rate limited" });
		expect(() => backend.parseResult(json)).toThrowError(LocalAgentTransientError);
	});

	it("throws on non-JSON stdout", () => {
		expect(() => backend.parseResult("not json at all")).toThrowError(/could not parse/i);
	});
});
```

- [ ] **Step 3: Implement `parseResult`**

`cli/src/core/localagent/ClaudeCodeBackend.ts`:

```ts
import {
	type Invocation,
	type LocalAgentBackend,
	LocalAgentAuthError,
	type LocalAgentOutcome,
	type LocalAgentRequest,
	LocalAgentSetupError,
	LocalAgentTransientError,
	type ResolvedExecutable,
} from "./Types.js";

/** Shape of the `--output-format json` result envelope we rely on. */
interface ClaudePrintEnvelope {
	is_error?: boolean;
	subtype?: string;
	api_error_status?: number | null;
	result?: string;
	stop_reason?: string | null;
	total_cost_usd?: number;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

export class ClaudeCodeBackend implements LocalAgentBackend {
	readonly id = "claude-code";

	discoverExecutable(_overridePath?: string): Promise<ResolvedExecutable> {
		throw new Error("not implemented"); // Task 5
	}

	buildInvocation(_exe: ResolvedExecutable, _req: LocalAgentRequest): Invocation {
		throw new Error("not implemented"); // Task 4
	}

	parseResult(stdout: string): LocalAgentOutcome {
		let env: ClaudePrintEnvelope;
		try {
			env = JSON.parse(stdout) as ClaudePrintEnvelope;
		} catch {
			throw new LocalAgentSetupError(
				`Could not parse Claude Code output as JSON (first 200 chars): ${stdout.slice(0, 200)}`,
			);
		}
		if (env.is_error) {
			const status = env.api_error_status ?? 0;
			const msg = `Claude Code returned an error (status ${status}): ${env.result ?? env.subtype ?? "unknown"}`;
			if (status === 401 || status === 403) throw new LocalAgentAuthError(msg);
			if (status === 429 || (status >= 500 && status < 600)) throw new LocalAgentTransientError(msg);
			throw new LocalAgentSetupError(msg);
		}
		const usage = env.usage ?? {};
		return {
			text: env.result ?? "",
			inputTokens: usage.input_tokens ?? 0,
			outputTokens: usage.output_tokens ?? 0,
			cachedTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
			costUsd: env.total_cost_usd ?? 0,
			stopReason: env.stop_reason ?? null,
		};
	}
}
```

---

## Task 4: `ClaudeCodeBackend.buildInvocation` (args + env scrub + temp cwd)

**Files:**
- Modify: `cli/src/core/localagent/ClaudeCodeBackend.ts` (replace the `buildInvocation` stub)
- Test: `cli/src/core/localagent/ClaudeCodeBackend.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `ResolvedExecutable`, `LocalAgentRequest`, `Invocation` from Task 2.
- Produces: working `buildInvocation` returning the exact `claude -p` arg vector, prompt on `stdin`, a fresh temp `cwd`, and an env with Anthropic/Claude credential vars scrubbed.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/localagent/ClaudeCodeBackend.test.ts`:

```ts
import { existsSync } from "node:fs";

describe("ClaudeCodeBackend.buildInvocation", () => {
	const exe = { file: "/usr/bin/claude", version: "2.1.210" };
	const req = { prompt: "PROMPT_BODY", model: "claude-haiku-4-5-20251001", systemPrompt: "SYS", maxTokens: 8192 };

	it("builds the headless print-mode arg vector with tools disabled", () => {
		const inv = backend.buildInvocation(exe, req);
		expect(inv.file).toBe("/usr/bin/claude");
		expect(inv.args).toEqual([
			"-p",
			"--output-format", "json",
			"--model", "claude-haiku-4-5-20251001",
			"--system-prompt", "SYS",
			"--tools", "",
			"--permission-mode", "dontAsk",
			"--no-session-persistence",
		]);
		expect(inv.stdin).toBe("PROMPT_BODY");
	});

	it("runs in a real, fresh temp cwd (no repo CLAUDE.md auto-discovery)", () => {
		const inv = backend.buildInvocation(exe, req);
		expect(existsSync(inv.cwd)).toBe(true);
		expect(inv.cwd).not.toBe(process.cwd());
	});

	it("scrubs Anthropic/Claude credential env vars so subscription OAuth is used", () => {
		const prev = { ...process.env };
		process.env.ANTHROPIC_API_KEY = "sk-ant-should-be-removed";
		process.env.ANTHROPIC_BASE_URL = "https://relay.example";
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale";
		process.env.CLAUDECODE = "1";
		try {
			const inv = backend.buildInvocation(exe, req);
			expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(inv.env.ANTHROPIC_BASE_URL).toBeUndefined();
			expect(inv.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect(inv.env.CLAUDECODE).toBeUndefined();
			// Non-credential env is preserved.
			expect(inv.env.PATH).toBe(process.env.PATH);
		} finally {
			process.env = prev;
		}
	});
});
```

- [ ] **Step 2: Implement**

At the top of `ClaudeCodeBackend.ts` add imports and the scrub list:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

```ts
/**
 * Env vars removed from the child so `claude` falls through to its own
 * keychain-stored subscription OAuth. A leaked ANTHROPIC_BASE_URL alone routes
 * `claude` to a third-party gateway with no creds; ANTHROPIC_API_KEY/AUTH_TOKEN
 * would bill the user's API instead of the subscription; a stale parent
 * CLAUDE_CODE_OAUTH_TOKEN or CLAUDECODE ("cannot launch inside another Claude
 * Code session") both break the spawn.
 */
const SCRUBBED_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDECODE",
] as const;
```

Replace the `buildInvocation` stub:

```ts
	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const key of SCRUBBED_ENV_VARS) delete env[key];
		// Fresh empty cwd: `claude` auto-discovers a CLAUDE.md from cwd and folds
		// it into the system prompt. Running in the repo would inject the repo's
		// CLAUDE.md — polluting the summary and burning tokens. An empty temp dir
		// is the clean isolation (mirrors claude-mem's cwd jail).
		const cwd = mkdtempSync(join(tmpdir(), "jolli-localagent-"));
		return {
			file: exe.file,
			args: [
				"-p",
				"--output-format", "json",
				"--model", req.model,
				"--system-prompt", req.systemPrompt,
				"--tools", "",
				"--permission-mode", "dontAsk",
				"--no-session-persistence",
			],
			stdin: req.prompt,
			env,
			cwd,
		};
	}
```

---

## Task 5: `ClaudeExecutableResolver` (discovery + capability probe)

**Files:**
- Create: `cli/src/core/localagent/ClaudeExecutableResolver.ts`
- Test: `cli/src/core/localagent/ClaudeExecutableResolver.test.ts`

**Interfaces:**
- Consumes: `ResolvedExecutable`, `LocalAgentSetupError` from Task 2.
- Produces: `resolveClaudeExecutable(opts: { overridePath?: string; probe?: ProbeFn; candidates?: () => string[]; now?: () => number }): ResolvedExecutable` where `type ProbeFn = (file: string) => { ok: boolean; version?: string }`. Injectable `probe`/`candidates`/`now` keep the test off the real binary. Newest capable wins; successful resolution cached 15 min; failure not cached. `ClaudeCodeBackend.discoverExecutable` (wired in Task 7) delegates here.

- [ ] **Step 1: Write the failing test**

`cli/src/core/localagent/ClaudeExecutableResolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveClaudeExecutable, __resetResolverCacheForTest } from "./ClaudeExecutableResolver.js";
import { LocalAgentSetupError } from "./Types.js";

describe("resolveClaudeExecutable", () => {
	it("picks the newest capable candidate", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/a/claude", "/b/claude"],
			probe: (f) => (f === "/a/claude" ? { ok: true, version: "2.0.0" } : { ok: true, version: "2.1.210" }),
			now: () => 1000,
		});
		expect(out).toEqual({ file: "/b/claude", version: "2.1.210" });
	});

	it("skips incompatible (probe not ok) candidates", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/old/claude", "/new/claude"],
			probe: (f) => (f === "/old/claude" ? { ok: false } : { ok: true, version: "2.1.210" }),
			now: () => 1000,
		});
		expect(out.file).toBe("/new/claude");
	});

	it("throws a setup error when nothing is capable", () => {
		__resetResolverCacheForTest();
		expect(() =>
			resolveClaudeExecutable({ candidates: () => ["/x/claude"], probe: () => ({ ok: false }), now: () => 1000 }),
		).toThrowError(LocalAgentSetupError);
	});

	it("honors an explicit override path and probes it", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			overridePath: "/custom/claude",
			candidates: () => [],
			probe: (f) => ({ ok: f === "/custom/claude", version: "2.1.210" }),
			now: () => 1000,
		});
		expect(out.file).toBe("/custom/claude");
	});

	it("caches a successful resolution for 15 minutes, not failures", () => {
		__resetResolverCacheForTest();
		let calls = 0;
		const probe = () => {
			calls++;
			return { ok: true, version: "2.1.210" };
		};
		resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 0 });
		resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 60_000 });
		expect(calls).toBe(1); // second call served from cache
	});
});
```

- [ ] **Step 2: Implement**

`cli/src/core/localagent/ClaudeExecutableResolver.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../Logger.js";
import { type ResolvedExecutable, LocalAgentSetupError } from "./Types.js";

const log = createLogger("ClaudeExecutableResolver");

/** Successful resolution cache TTL. Failures are never cached, so a fresh
 * install / upgrade is picked up on the next call without a worker restart. */
const RESOLUTION_CACHE_TTL_MS = 15 * 60_000;

/**
 * Probe with the ACTUAL flags every invocation passes — an old CLI rejects
 * `--permission-mode dontAsk` at parse time and exits non-zero, so a bare
 * `--version` would wrongly classify it capable. MUST stay in sync with
 * ClaudeCodeBackend.buildInvocation.
 */
const CAPABILITY_PROBE_ARGS = ["--permission-mode", "dontAsk", "--version"] as const;

export type ProbeFn = (file: string) => { ok: boolean; version?: string };

interface ResolveOpts {
	readonly overridePath?: string;
	readonly probe?: ProbeFn;
	readonly candidates?: () => string[];
	readonly now?: () => number;
}

let cached: { at: number; result: ResolvedExecutable } | null = null;

/** Test-only: clears the module-level resolution cache. */
export function __resetResolverCacheForTest(): void {
	cached = null;
}

/** Default candidate enumeration: `which -a claude` + known install locations. */
function defaultCandidates(): string[] {
	const found: string[] = [];
	try {
		const out = execFileSync("which", ["-a", "claude"], { encoding: "utf8" });
		for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) found.push(line);
	} catch {
		// `which` miss is not fatal — fall through to known locations.
	}
	for (const p of [join(homedir(), ".local/bin/claude"), join(homedir(), ".claude/local/claude")]) {
		if (existsSync(p)) found.push(p);
	}
	return [...new Set(found)];
}

/** Default probe: run the capability args via execFile (never shell). */
function defaultProbe(file: string): { ok: boolean; version?: string } {
	try {
		const out = execFileSync(file, [...CAPABILITY_PROBE_ARGS], { encoding: "utf8", timeout: 10_000 });
		const version = out.trim().split(/\s+/)[0];
		return { ok: Boolean(version), version };
	} catch {
		return { ok: false };
	}
}

/** Compares dotted version strings descending; missing/garbage sorts last. */
function versionRank(v: string | undefined): number[] {
	return (v ?? "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
}
function isNewer(a: string | undefined, b: string | undefined): boolean {
	const ra = versionRank(a);
	const rb = versionRank(b);
	for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
		const da = ra[i] ?? 0;
		const db = rb[i] ?? 0;
		if (da !== db) return da > db;
	}
	return false;
}

/**
 * Resolves the `claude` binary to use, verifying it accepts the flags we pass.
 * Newest capable wins; PATH order is only a tie-break (kept implicitly by
 * iterating candidates in order and using strict `isNewer`).
 */
export function resolveClaudeExecutable(opts: ResolveOpts = {}): ResolvedExecutable {
	const now = opts.now ?? Date.now;
	if (cached && now() - cached.at < RESOLUTION_CACHE_TTL_MS) return cached.result;

	const probe = opts.probe ?? defaultProbe;
	const list = opts.overridePath ? [opts.overridePath] : (opts.candidates ?? defaultCandidates)();

	let best: ResolvedExecutable | null = null;
	for (const file of list) {
		const r = probe(file);
		if (!r.ok) continue;
		if (!best || isNewer(r.version, best.version)) best = { file, version: r.version ?? "0" };
	}
	if (!best) {
		throw new LocalAgentSetupError(
			opts.overridePath
				? `Configured local agent path "${opts.overridePath}" is not a working Claude Code CLI.`
				: "No compatible Claude Code CLI found. Install/upgrade Claude Code, or switch the AI provider.",
		);
	}
	log.info("Resolved claude executable: %s (v%s)", best.file, best.version);
	cached = { at: now(), result: best };
	return best;
}
```

---

## Task 6: `LocalAgentRunner` (spawn + timeout + stderr tail)

**Files:**
- Create: `cli/src/core/localagent/LocalAgentRunner.ts`
- Test: `cli/src/core/localagent/LocalAgentRunner.test.ts`

**Interfaces:**
- Consumes: `Invocation` (Task 2), `LocalAgentTransientError` (Task 2).
- Produces: `runInvocation(inv: Invocation, opts?: { timeoutMs?: number; spawnImpl?: SpawnImpl }): Promise<string>` returning stdout on exit 0; throwing `LocalAgentTransientError` on timeout and `LocalAgentSetupError` on nonzero exit (with a 2KB stderr tail). `type SpawnImpl` matches `node:child_process` `spawn`. Default timeout 180_000 ms.

- [ ] **Step 1: Write the failing test**

`cli/src/core/localagent/LocalAgentRunner.test.ts` (uses a tiny fake `spawn` via `node:events`):

```ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runInvocation } from "./LocalAgentRunner.js";
import { LocalAgentSetupError, LocalAgentTransientError } from "./Types.js";

function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number | null; hang?: boolean }) {
	return () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			stdin: PassThrough & { end: (s: string) => void };
			kill: (sig?: string) => void;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = new PassThrough() as PassThrough & { end: (s: string) => void };
		child.kill = vi.fn();
		if (!opts.hang) {
			setImmediate(() => {
				if (opts.stdout) child.stdout.write(opts.stdout);
				if (opts.stderr) child.stderr.write(opts.stderr);
				child.stdout.end();
				child.stderr.end();
				child.emit("close", opts.code ?? 0);
			});
		}
		// biome-ignore lint/suspicious/noExplicitAny: test double for spawn's return
		return child as any;
	};
}

const inv = { file: "/x/claude", args: ["-p"], stdin: "PROMPT", env: {}, cwd: "/tmp" };

describe("runInvocation", () => {
	it("resolves stdout on a clean exit", async () => {
		const out = await runInvocation(inv, { spawnImpl: fakeSpawn({ stdout: '{"ok":true}', code: 0 }) });
		expect(out).toBe('{"ok":true}');
	});

	it("throws a setup error with a stderr tail on nonzero exit", async () => {
		await expect(
			runInvocation(inv, { spawnImpl: fakeSpawn({ stderr: "boom details", code: 1 }) }),
		).rejects.toThrowError(/boom details/);
	});

	it("throws a transient error on timeout and kills the child", async () => {
		await expect(
			runInvocation(inv, { timeoutMs: 20, spawnImpl: fakeSpawn({ hang: true }) }),
		).rejects.toThrowError(LocalAgentTransientError);
	});
});
```

- [ ] **Step 2: Implement**

`cli/src/core/localagent/LocalAgentRunner.ts`:

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { createLogger } from "../../Logger.js";
import { type Invocation, LocalAgentSetupError, LocalAgentTransientError } from "./Types.js";

const log = createLogger("LocalAgentRunner");

/** Default wall-clock budget, matching LlmClient's other paths (180s). */
const DEFAULT_TIMEOUT_MS = 180_000;
/** Keep the last 2KB of stderr so a nonzero exit logs WHY. */
const STDERR_TAIL_MAX_CHARS = 2048;

export type SpawnImpl = typeof nodeSpawn;

interface RunOpts {
	readonly timeoutMs?: number;
	readonly spawnImpl?: SpawnImpl;
}

/**
 * Spawns the invocation, feeds `stdin`, and resolves stdout on exit 0.
 * Timeout → SIGTERM then (after grace) SIGKILL → LocalAgentTransientError.
 * Nonzero exit → LocalAgentSetupError carrying the stderr tail.
 */
export function runInvocation(inv: Invocation, opts: RunOpts = {}): Promise<string> {
	const spawnImpl = opts.spawnImpl ?? nodeSpawn;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise<string>((resolve, reject) => {
		const child = spawnImpl(inv.file, [...inv.args], { cwd: inv.cwd, env: inv.env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000);
			reject(new LocalAgentTransientError(`Claude Code timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString("utf8");
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr = (stderr + c.toString("utf8")).slice(-STDERR_TAIL_MAX_CHARS);
		});
		child.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new LocalAgentSetupError(`Failed to spawn Claude Code (${inv.file}): ${err.message}`));
		});
		child.on("close", (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
			} else {
				log.warn("Claude Code exited %s; stderr tail: %s", code, stderr);
				reject(new LocalAgentSetupError(`Claude Code exited with code ${code}. ${stderr.trim()}`));
			}
		});

		child.stdin?.end(inv.stdin);
	});
}
```

---

## Task 7: Wire `callLocalAgent` into `LlmClient` + register the backend

**Files:**
- Modify: `cli/src/core/LlmClient.ts` (register backend + `callLocalAgent` + switch case)
- Modify: `cli/src/core/localagent/ClaudeCodeBackend.ts` (delegate `discoverExecutable` to the resolver)
- Test: `cli/src/core/LlmClient.test.ts` (add `callLlm` local-agent integration cases with injected backend)

**Interfaces:**
- Consumes: `getBackend`/`registerBackend` (Task 2), `ClaudeCodeBackend` (Tasks 3-4), `resolveClaudeExecutable` (Task 5), `runInvocation` (Task 6).
- Produces: `callLlm({ ..., aiProvider: "local-agent", localAgentTool: "claude-code" })` returns an `LlmCallResult` with `source: "local-agent"`. A module-level side-effect registers `new ClaudeCodeBackend()`. `callLocalAgent` accepts an optional injected `runInvocation` for tests via a new optional field on `LlmCallOptions`: `__localAgentRun?: typeof runInvocation` (double-underscore = test seam, not user config).

- [ ] **Step 1: Delegate discovery in ClaudeCodeBackend**

In `cli/src/core/localagent/ClaudeCodeBackend.ts`, replace the `discoverExecutable` stub:

```ts
import { resolveClaudeExecutable } from "./ClaudeExecutableResolver.js";
```

```ts
	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveClaudeExecutable({ overridePath }));
	}
```

- [ ] **Step 2: Write the failing test**

Add to `cli/src/core/LlmClient.test.ts`:

```ts
import { callLlm } from "./LlmClient.js";
import { registerBackend } from "./localagent/BackendRegistry.js";
import type { LocalAgentBackend } from "./localagent/Types.js";

describe("callLlm — local-agent", () => {
	it("routes to the claude-code backend and maps the outcome to LlmCallResult", async () => {
		const stub: LocalAgentBackend = {
			id: "claude-code",
			discoverExecutable: async () => ({ file: "/x/claude", version: "2.1.210" }),
			buildInvocation: () => ({ file: "/x/claude", args: [], stdin: "P", env: {}, cwd: "/tmp" }),
			parseResult: () => ({ text: "SUMMARY", inputTokens: 5, outputTokens: 9, cachedTokens: 4738, costUsd: 0.01, stopReason: "end_turn" }),
		};
		registerBackend(stub); // replaces the real claude-code backend for this test

		const result = await callLlm({
			action: "recap",
			params: { branch: "main", summaries: "x" },
			aiProvider: "local-agent",
			localAgentTool: "claude-code",
			// test seam: skip the real spawn, feed canned stdout the stub ignores
			__localAgentRun: async () => "ignored-by-stub",
		});

		expect(result.source).toBe("local-agent");
		expect(result.text).toBe("SUMMARY");
		expect(result.inputTokens).toBe(5);
		expect(result.outputTokens).toBe(9);
		expect(result.cachedTokens).toBe(4738);
	});
});
```

- [ ] **Step 3: Implement**

In `cli/src/core/LlmClient.ts`, add imports and register the backend at module load:

```ts
import { ClaudeCodeBackend } from "./localagent/ClaudeCodeBackend.js";
import { getBackend, registerBackend } from "./localagent/BackendRegistry.js";
import { runInvocation as defaultRunInvocation } from "./localagent/LocalAgentRunner.js";

// Register the v1 backend once at module load. The registry is the extension
// point for future tools (Codex, Cursor) — add a `registerBackend(...)` here.
registerBackend(new ClaudeCodeBackend());
```

Add the test seam to `LlmCallOptions` (after `timeoutMs`, line 251):

```ts
	/**
	 * Test-only override for the local-agent child-process runner. Double
	 * underscore marks it as a test seam, not a user-facing option; never set
	 * from config. Ignored outside the `local-agent` path.
	 */
	readonly __localAgentRun?: typeof defaultRunInvocation;
```

Add the switch case in `callLlm` (after the `jolli-proxy` case, before `default`):

```ts
		case "local-agent":
			return callLocalAgent(options, source);
```

Add the `callLocalAgent` function (near `callDirect`):

```ts
/**
 * Local-agent mode: drive a locally-installed agent CLI (v1: Claude Code)
 * headless, using the tool's own subscription login. Mirrors callDirect's
 * template-fill + model-resolution preamble, then delegates spawning to the
 * selected backend. On failure it throws (LocalAgent*Error) — NEVER falls back
 * to another provider, so the user is never silently billed on their API key.
 */
async function callLocalAgent(options: LlmCallOptions, source: LlmCredentialSource): Promise<LlmCallResult> {
	const entry = TEMPLATES.get(options.action);
	if (!entry) {
		throw new Error(`Unknown LLM action: "${options.action}". Available: ${[...TEMPLATES.keys()].join(", ")}`);
	}
	const missing = findUnfilledPlaceholders(entry.template, options.params);
	if (missing.length > 0) {
		log.warn("Local-agent call has unfilled placeholders for action=%s: %s", options.action, missing.join(", "));
	}
	const prompt = fillTemplate(entry.template, options.params);
	const model = resolveModelId(options.model);
	const maxTokens = options.maxTokens ?? 8192;

	const backend = getBackend(options.localAgentTool ?? "claude-code");
	const exe = await backend.discoverExecutable(options.localAgentPath);
	const invocation = backend.buildInvocation(exe, {
		prompt,
		model,
		systemPrompt: "You output only what the prompt asks for, with no preamble or commentary.",
		maxTokens,
		timeoutMs: options.timeoutMs,
	});

	const run = options.__localAgentRun ?? defaultRunInvocation;
	const startTime = Date.now();
	const stdout = await run(invocation, { timeoutMs: options.timeoutMs });
	const outcome = backend.parseResult(stdout);

	return {
		text: outcome.text,
		model,
		inputTokens: outcome.inputTokens,
		outputTokens: outcome.outputTokens,
		cachedTokens: outcome.cachedTokens,
		apiLatencyMs: Date.now() - startTime,
		stopReason: outcome.stopReason,
		source,
	};
}
```

---

## Task 7b: Recognize local-agent at the secondary-pipeline credential guards

**Added during execution** (user-approved): the spec's "all 7 pipelines switch over automatically" was optimistic — the ingest/wiki/compile pipelines gate on an ad-hoc credential-presence check that predates local-agent, so local-agent users would get commit summaries but not wiki/graph/compile.

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts:873` (ingest guard)
- Modify: `cli/src/hooks/PostMergeHook.ts:115` (compile-enqueue guard)
- Modify: `cli/src/commands/CompileCommand.ts:37` and `:190` (single-repo + sweep guards)
- Test: extend the existing `QueueWorker.test.ts` / `PostMergeHook.test.ts` / `CompileCommand.test.ts`

**Interfaces:**
- Consumes: `resolveLlmCredentialSource` (exported from `cli/src/core/LlmClient.ts`, Task 1) which already returns `"local-agent"` for the explicit choice.
- Produces: the four guards recognize a `local-agent` config as "provider configured".

All four sites currently share this exact pattern:

```ts
if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
	// skip / error
}
```

Replace each with the canonical resolver (DRY — reuses the one authoritative function instead of a fourth hand-rolled copy):

```ts
import { resolveLlmCredentialSource } from "../core/LlmClient.js"; // path per file
...
if (resolveLlmCredentialSource(config) === null) {
	// skip / error (unchanged body)
}
```

This is behavior-identical for legacy (no-`aiProvider`) configs and additionally: proceeds for `aiProvider === "local-agent"`, and fail-fasts (skips) when an explicit `aiProvider` has no matching credential (previously the guard passed then `callLlm` threw `LlmCredentialError` downstream — the new behavior is more consistent).

- [ ] **Step 1: Write/extend failing tests**

For each of `QueueWorker.test.ts`, `PostMergeHook.test.ts`, `CompileCommand.test.ts`, add a case that a `local-agent` config (`{ aiProvider: "local-agent" }`, no apiKey/jolliApiKey, `ANTHROPIC_API_KEY` unset in the test env) does NOT skip — i.e. the site proceeds to `drainIngest` / `enqueueIngestOperation` / the compile body. Mirror the existing "no API key → skips" test's structure in each file (find it first). Ensure `process.env.ANTHROPIC_API_KEY` is controlled (deleted) and restored in the test.

- [ ] **Step 2: Implement**

Apply the replacement at all four sites with the correct relative import path (`../core/LlmClient.js` from `hooks/` and `commands/`). Keep each guard's body (the skip/error/return) unchanged.

- [ ] **Step 3: Verify + commit**

Run only the three affected test files. Biome-clean. Commit with `git commit -s`.

---

## Task 8: VS Code Settings — third provider option + agent-tool sub-dropdown

**Files:**
- Modify: `vscode/src/views/SettingsHtmlBuilder.ts` (provider `<option>` ~line 67; new `data-card="local-agent"` panel ~line 148)
- Modify: `vscode/src/views/SettingsScriptBuilder.ts` (DOM ref ~29; `syncProviderCard` ~102-121; dirty tracking ~323/~348; payload ~446; loader ~558-562; change listener ~420)
- Modify: `vscode/src/views/SettingsWebviewPanel.ts` (`SettingsPayload` ~49; `SettingsMessage` applySettings arm ~86; `resolveProvider` ~432; `handleApplySettings` persist ~600; `postAuthState` ~532)
- Test: `vscode/src/views/SettingsHtmlBuilder.test.ts`, `SettingsScriptBuilder.test.ts`, `SettingsWebviewPanel.test.ts`

**Interfaces:**
- Consumes: `JolliMemoryConfig.aiProvider` / `localAgentTool` (Task 1).
- Produces: the "AI Summary" tab renders a third provider option `local-agent` and, when selected, reveals a `data-card="local-agent"` panel with a `#localAgentTool` `<select>` (one option `claude-code`). The choice round-trips through `applySettings` → `saveConfigScoped` and back through `settingsLoaded`.

> Note (backtick trap): every builder returns one template literal — keep all added comments/strings backtick-free.

- [ ] **Step 1: Write failing tests**

Add to `vscode/src/views/SettingsHtmlBuilder.test.ts` (mirror the existing provider-dropdown test at ~81-92):

```ts
it("renders the local-agent provider option and its card", () => {
	const html = buildSettingsHtml("nonce123");
	expect(html).toContain('value="local-agent"');
	expect(html).toContain('data-card="local-agent"');
	expect(html).toContain('id="localAgentTool"');
	expect(html).toContain('value="claude-code"');
});
```

Add to `vscode/src/views/SettingsScriptBuilder.test.ts` (mirror ~131-138 / ~173-178):

```ts
it("gates the local-agent card and round-trips the agent tool", () => {
	const script = buildSettingsScript();
	expect(script).toContain("provider === 'local-agent'");
	expect(script).toContain("localAgentTool: localAgentToolSelect.value");
	expect(script).toContain("localAgentToolSelect.value = msg.settings.localAgentTool");
});
```

Add to `vscode/src/views/SettingsWebviewPanel.test.ts` (mirror the applySettings handler test at ~667-721 using `setupWithLoadedConfig()`):

```ts
it("persists local-agent provider + tool to config", async () => {
	const { dispatch } = await setupWithLoadedConfig();
	dispatch({
		command: "applySettings",
		settings: { aiProvider: "local-agent", localAgentTool: "claude-code" },
		maskedApiKey: "",
		maskedJolliApiKey: "",
	});
	await flushPromises();
	expect(mockSaveConfigScoped).toHaveBeenCalledWith(
		expect.objectContaining({ aiProvider: "local-agent", localAgentTool: "claude-code" }),
		expect.any(String),
	);
});
```

- [ ] **Step 2: Implement — host types & persistence (`SettingsWebviewPanel.ts`)**

Widen `SettingsPayload.aiProvider` (~line 49) and add the tool field:

```ts
	readonly aiProvider: "anthropic" | "jolli" | "local-agent";
	readonly localAgentTool?: "claude-code";
```

Mirror the same two fields into the `applySettings` arm of the `SettingsMessage` union (~line 86).

Extend `resolveProvider` (~line 432) to honor the explicit choice:

```ts
	if (config.aiProvider === "anthropic" || config.aiProvider === "jolli" || config.aiProvider === "local-agent") {
		return config.aiProvider;
	}
```

In `handleApplySettings` (persist block ~line 600), add alongside `aiProvider: settings.aiProvider`:

```ts
		localAgentTool: settings.localAgentTool ?? "claude-code",
```

In `handleLoadSettings`'s `settingsLoaded` payload and `postAuthState` (~line 532), include `localAgentTool: config.localAgentTool ?? "claude-code"` next to the `aiProvider` field it already sends.

- [ ] **Step 3: Implement — HTML (`SettingsHtmlBuilder.ts`)**

Add the option in the provider `<select>` (~line 70, after the jolli option):

```html
<option value="local-agent">Local Agent (subscription)</option>
```

Add a new conditional card after the last `data-card` panel (~line 148). Keep the comment backtick-free:

```html
<!-- Shown only when provider is local-agent. Uses subscription OAuth of the chosen tool; no API key needed. -->
<div class="card-panel hidden" data-card="local-agent">
	<label class="settings-label" for="localAgentTool">Agent tool</label>
	<select id="localAgentTool">
		<option value="claude-code">Claude Code</option>
	</select>
	<p class="settings-hint">Uses your local Claude Code login (subscription). Sign in with the claude CLI if prompted.</p>
</div>
```

- [ ] **Step 4: Implement — script (`SettingsScriptBuilder.ts`)**

Add the DOM ref (~line 29, next to `aiProviderSelect`):

```js
var localAgentToolSelect = document.getElementById('localAgentTool');
```

Add the gating arm inside `syncProviderCard()` (~line 108, before the jolli branches):

```js
  else if (provider === 'local-agent') { which = 'local-agent'; }
```

Add a change listener (mirror the model select at ~line 420):

```js
localAgentToolSelect.addEventListener('change', function() { checkDirty(); clearSaveFeedback(); });
```

Include the field in `captureInitialState()` (~323), `checkDirty()` (~348), the `applySettings` payload (~446), and the `settingsLoaded` loader (~562):

```js
// captureInitialState — add to the captured object:
localAgentTool: localAgentToolSelect.value,
// checkDirty — add to the dirty comparison:
|| localAgentToolSelect.value !== initial.localAgentTool
// applySettings payload — add:
localAgentTool: localAgentToolSelect.value,
// settingsLoaded loader — add (default to claude-code):
localAgentToolSelect.value = msg.settings.localAgentTool || 'claude-code';
```

---

## Task 9: Final verification + single commit

**Files:** none (final verification only; Tasks 1-8 each committed their own work)

> This is the ONLY task that runs the full build/lint/test chain. Tasks 1-8 committed their own work per the reconciled commit discipline; any fixes this task needs are committed here.

- [ ] **Step 1: Run the full gate from the repo root**

Run: `npm run all`
Expected: clean → build → lint → test all pass; CLI coverage ≥ 97% statements / 96% branches / 97% functions / 97% lines. If coverage dips, add targeted tests for the uncovered branch (most likely the resolver's `defaultCandidates`/`defaultProbe` fallbacks or the runner's `error` handler) rather than lowering the floor. Commit any fix here with `git commit -s`.

- [ ] **Step 2: Verify behavior end-to-end (real binary)**

Run (with a Claude Code subscription logged in):

```bash
cd cli && npm run build && printf 'ANTHROPIC_API_KEY=%s\n' "" >/dev/null
JOLLI_TEST_PROVIDER=local-agent node -e "import('./dist/core/LlmClient.js').then(async m => { const r = await m.callLlm({ action:'recap', params:{branch:'main', summaries:'test'}, aiProvider:'local-agent', localAgentTool:'claude-code' }); console.log('source=',r.source,'tokens=',r.inputTokens,'+',r.outputTokens); })"
```

Expected: prints `source= local-agent tokens= <n> + <n>` — confirms the real `claude` binary was driven via subscription OAuth and the outcome mapped into `LlmCallResult`. (If not logged in: expect a `LocalAgentAuthError` — that is also a valid confirmation of the auth path.)

- [ ] **Step 3: Confirm the branch history is clean**

Run: `git log --oneline` and `git status`
Expected: Tasks 1-8 are each their own DCO-signed commit; working tree clean (or only this task's fix commit outstanding). No `Co-Authored-By: Claude …` / `🤖 Generated with …` in any message.

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- §3 A/B selection → recorded in the spec (design decision, no code).
- §4 architecture (callLlm dispatch) → Task 1 (routing) + Task 7 (dispatch/callLocalAgent).
- §5 components → Task 2 (interface/registry), Task 3 (parseResult), Task 4 (buildInvocation), Task 5 (resolver), Task 6 (runner).
- §6 data flow → Task 7 (end-to-end wiring).
- §7 no-silent-fallback error handling → Task 2 (error classes), Task 3 (auth/transient classification), Task 6 (timeout/exit), Task 7 (throws, never falls back).
- §8 config + UI → Task 1 (config schema) + Task 8 (VS Code UI).
- §9 token/cost semantics → Task 3 (mapping) + Task 7 (LlmCallResult population).
- §10 testing (DI + real fixture) → every task uses injected seams; Task 3 uses the real fixture.
- §2 out-of-scope (IntelliJ, Codex/Cursor, temperature, session reuse, no auto-fallback) → honored: registry stub only, no temperature flag, throws instead of falling back.

**Type consistency** — `LocalAgentBackend` / `ResolvedExecutable` / `LocalAgentRequest` / `LocalAgentOutcome` / `Invocation` defined once in Task 2 and used verbatim in Tasks 3-7. `LlmCallResult` fields populated in Task 7 match the verified shape at `LlmClient.ts:255`. `resolveModelId` / `TEMPLATES` / `fillTemplate` / `findUnfilledPlaceholders` referenced by their real exported names.

**Placeholder scan** — no TBD/TODO; every code step carries complete code. The registry's "future tools" note is a design extension point, not an unfinished step.
