# Confirm Global Skill-Instruction Writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `jolli enable` (and VS Code auto-enable) from silently writing Jolli's skill-preference block into machine-global AI instruction files (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`); ask the user first and remember the answer.

**Architecture:** A persisted tri-state switch `globalInstructions` in the **global** config (`~/.jolli/jollimemory/config.json`): `undefined` (undecided → skip), `"enabled"` (write), `"disabled"` (never write). `install()` reads the switch and, when undecided, calls an optional `confirmGlobalInstructions` callback (supplied only by the interactive CLI path); the callback's answer is persisted. VS Code drives its own activation-time notification that persists the switch and idempotently re-runs `install()`. Both surfaces share one benefit-led prompt string so the wording can never drift.

**Tech Stack:** TypeScript (ESM), Node 22.5+, Vitest, Biome (tabs, 120 col). VS Code extension host (CJS via esbuild, bundles `cli/src/**`).

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` trailer, no `🤖 Generated with …` footer. Only `Signed-off-by:` belongs in commit messages.
- **`npm run all` must pass before the final commit** (clean → build → lint → test).
- **CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines** (`cli/vite.config.ts`). VS Code floor: 97% statements / 97% branches. New code must keep both green; wrap genuinely un-testable interactive I/O in `/* v8 ignore start */ … /* v8 ignore stop */` (single-line `ignore next` does NOT work in this repo).
- **Biome:** tabs, 4-wide, 120-col; `noExplicitAny: error`, `noUnusedImports/Variables: error`, `useImportType: warn`. `biome check --error-on-warnings` — warnings fail CI.
- **Shared prompt string is the single source of truth.** The CLI prompt and the VS Code notification MUST both render `GLOBAL_INSTRUCTIONS_PROMPT` exported from `GlobalInstructionsInstaller.ts`. Do not inline a second copy.
- **Safe default:** when the switch is undecided and the surface cannot prompt (VS Code auto-enable, CLI `-y`, non-TTY, IntelliJ `--integrations-only`), do NOT write. Never remove an already-present block.

---

## File Structure

**CLI (`cli/src/`):**
- `Types.ts` — add the `globalInstructions?: "enabled" | "disabled"` config field. (Excluded from coverage.)
- `install/GlobalInstructionsInstaller.ts` — add `GLOBAL_INSTRUCTIONS_PROMPT`, the `GlobalInstructionsChoice` type, and the pure `resolveGlobalInstructionsDecision()` resolver. Keeps the write + host-gating in one place.
- `install/GlobalInstructionsInstaller.test.ts` — unit tests for the resolver + the constant.
- `install/Installer.ts` — replace the unconditional `installGlobalInstructions(...)` call (currently `Installer.ts:331-335`) with: read switch → resolve decision → persist if decided → write iff `decision.write`.
- `install/Installer.test.ts` — end-to-end tests over the three switch states.
- `commands/CliUtils.ts` — add pure `isAffirmative()` for `[Y/n]` parsing (default yes).
- `commands/CliUtils.test.ts` — unit tests for `isAffirmative()`.
- `commands/EnableCommand.ts` — pass a `confirmGlobalInstructions` callback when interactive and `!--yes`.

**VS Code (`vscode/src/`):**
- `services/GlobalInstructionsPrompt.ts` — `maybePromptGlobalInstructions(bridge)`: notification, config persistence, session-dismiss flag.
- `services/GlobalInstructionsPrompt.test.ts` — unit tests (Add / Never / dismiss / already-decided / session-suppress).
- `Extension.ts` — invoke `maybePromptGlobalInstructions(bridge)` after the activation enable / auto-install block.

---

## Task 1: Config field + shared prompt + decision resolver

**Files:**
- Modify: `cli/src/Types.ts` (add field to `JolliMemoryConfig`, after `claudeEnabled` at ~`Types.ts:938`)
- Modify: `cli/src/install/GlobalInstructionsInstaller.ts` (add exports)
- Test: `cli/src/install/GlobalInstructionsInstaller.test.ts`

**Interfaces:**
- Produces:
  - `JolliMemoryConfig.globalInstructions?: "enabled" | "disabled"` (`undefined` = undecided).
  - `GLOBAL_INSTRUCTIONS_PROMPT: string` — the shared benefit-led message body (no `[Y/n]` / buttons appended).
  - `type GlobalInstructionsChoice = "enabled" | "disabled" | undefined`
  - `interface GlobalInstructionsDecision { readonly write: boolean; readonly persist?: "enabled" | "disabled" }`
  - `resolveGlobalInstructionsDecision(current: GlobalInstructionsChoice, confirm?: () => Promise<boolean>): Promise<GlobalInstructionsDecision>`

- [ ] **Step 1: Add the config field**

In `cli/src/Types.ts`, immediately after the `claudeEnabled` line (~`Types.ts:938`) inside `interface JolliMemoryConfig`, add:

```ts
	/**
	 * Whether Jolli may write its skill-preference block into the machine-global
	 * AI instruction files (~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md,
	 * ~/.codex/AGENTS.md). `undefined` = not yet decided (default: skip until the
	 * user confirms via the CLI prompt or the VS Code notification).
	 */
	readonly globalInstructions?: "enabled" | "disabled";
```

- [ ] **Step 2: Write the failing resolver + constant tests**

Append to `cli/src/install/GlobalInstructionsInstaller.test.ts`. First extend the existing import from `./GlobalInstructionsInstaller.js` to also pull in `GLOBAL_INSTRUCTIONS_PROMPT` and `resolveGlobalInstructionsDecision`, then add:

```ts
describe("GLOBAL_INSTRUCTIONS_PROMPT", () => {
	it("leads with the benefit and names the target files", () => {
		expect(GLOBAL_INSTRUCTIONS_PROMPT).toContain("use Jolli's memory automatically");
		expect(GLOBAL_INSTRUCTIONS_PROMPT).toContain("~/.claude/CLAUDE.md");
		expect(GLOBAL_INSTRUCTIONS_PROMPT).not.toContain("[Y/n]");
	});
});

describe("resolveGlobalInstructionsDecision", () => {
	it("writes without prompting when already enabled", async () => {
		const confirm = vi.fn();
		expect(await resolveGlobalInstructionsDecision("enabled", confirm)).toEqual({ write: true });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("skips without prompting when already disabled", async () => {
		const confirm = vi.fn();
		expect(await resolveGlobalInstructionsDecision("disabled", confirm)).toEqual({ write: false });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("skips and stays undecided when undecided with no callback", async () => {
		expect(await resolveGlobalInstructionsDecision(undefined, undefined)).toEqual({ write: false });
	});

	it("persists enabled and writes when the callback agrees", async () => {
		expect(await resolveGlobalInstructionsDecision(undefined, async () => true)).toEqual({
			write: true,
			persist: "enabled",
		});
	});

	it("persists disabled and skips when the callback declines", async () => {
		expect(await resolveGlobalInstructionsDecision(undefined, async () => false)).toEqual({
			write: false,
			persist: "disabled",
		});
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/install/GlobalInstructionsInstaller.test.ts -t "resolveGlobalInstructionsDecision"`
Expected: FAIL — `GLOBAL_INSTRUCTIONS_PROMPT` / `resolveGlobalInstructionsDecision` not exported.

- [ ] **Step 4: Implement the constant, type, and resolver**

In `cli/src/install/GlobalInstructionsInstaller.ts`, after `renderInstructionsBlock()` (~line 92), add:

```ts
/**
 * Benefit-led confirmation message shown before Jolli writes its skill-preference
 * block into the machine-global AI instruction files. SINGLE SOURCE OF TRUTH — both
 * the CLI prompt (append `[Y/n]:`) and the VS Code notification (three buttons) render
 * this exact string, so the wording can never drift between surfaces.
 */
export const GLOBAL_INSTRUCTIONS_PROMPT =
	"Let your AI assistants use Jolli's memory automatically? This adds a small " +
	"skill-preference block to your global instruction files (~/.claude/CLAUDE.md, " +
	"~/.gemini/GEMINI.md, ~/.codex/AGENTS.md) so your AI reaches for Jolli when you " +
	"create PRs, search past decisions, or recall a branch's history — no need to ask each time.";

/** Persisted tri-state: `undefined` = undecided (default), else the user's choice. */
export type GlobalInstructionsChoice = "enabled" | "disabled" | undefined;

/**
 * Outcome of consulting the switch:
 *  - `write`   — write the block now.
 *  - `persist` — when present, the caller must persist this to the global config's
 *                `globalInstructions` field (set only when a fresh decision was made).
 */
export interface GlobalInstructionsDecision {
	readonly write: boolean;
	readonly persist?: "enabled" | "disabled";
}

/**
 * Resolves whether to write the global-instructions block from the current switch
 * value plus an optional confirm callback (supplied only by interactive surfaces):
 *  - `enabled`   → write, no persist.
 *  - `disabled`  → skip, no persist.
 *  - undecided + callback   → ask; persist + write per the answer.
 *  - undecided + no callback → skip, stay undecided (safe default for non-interactive).
 */
export async function resolveGlobalInstructionsDecision(
	current: GlobalInstructionsChoice,
	confirm?: () => Promise<boolean>,
): Promise<GlobalInstructionsDecision> {
	if (current === "enabled") return { write: true };
	if (current === "disabled") return { write: false };
	if (!confirm) return { write: false };
	const agreed = await confirm();
	return agreed ? { write: true, persist: "enabled" } : { write: false, persist: "disabled" };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/install/GlobalInstructionsInstaller.test.ts`
Expected: PASS (all resolver + constant tests green, existing render/apply tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add cli/src/Types.ts cli/src/install/GlobalInstructionsInstaller.ts cli/src/install/GlobalInstructionsInstaller.test.ts
git commit -s -m "feat(cli): add global-instructions switch, shared prompt, and decision resolver"
```

---

## Task 2: Gate the write inside `install()`

**Files:**
- Modify: `cli/src/install/Installer.ts` (imports near `Installer.ts:42`; call site `Installer.ts:331-335`; options type `Installer.ts:144`)
- Test: `cli/src/install/Installer.test.ts`

**Interfaces:**
- Consumes: `resolveGlobalInstructionsDecision`, `GlobalInstructionsChoice` (Task 1); `saveConfigScoped`, `getGlobalConfigDir` (`SessionTracker.ts`).
- Produces: `install()` options gain `confirmGlobalInstructions?: () => Promise<boolean>`. When undecided + no callback, the block is NOT written and no config is persisted.

- [ ] **Step 1: Write the failing end-to-end tests**

Add to the `describe("install", …)` block in `cli/src/install/Installer.test.ts`. These reuse the existing `tempDir` / `fakeHomeDir` fixtures (homedir is already mocked to `fakeHomeDir`, so `getGlobalConfigDir()` resolves under it):

```ts
it("does NOT write the global CLAUDE.md block when the switch is undecided and no callback is passed", async () => {
	const exists = (p: string) =>
		stat(p)
			.then(() => true)
			.catch(() => false);
	const result = await install(tempDir);
	expect(result.success).toBe(true);
	// Undecided (no globalInstructions in config) + no confirm callback → skip.
	expect(await exists(join(fakeHomeDir, ".claude", "CLAUDE.md"))).toBe(false);
});

it("writes the global block and persists 'enabled' when the confirm callback agrees", async () => {
	const result = await install(tempDir, { confirmGlobalInstructions: async () => true });
	expect(result.success).toBe(true);

	const block = await readFile(join(fakeHomeDir, ".claude", "CLAUDE.md"), "utf-8");
	expect(block).toContain("jolli-recall");

	const cfg = JSON.parse(await readFile(join(fakeHomeDir, ".jolli", "jollimemory", "config.json"), "utf-8"));
	expect(cfg.globalInstructions).toBe("enabled");
});

it("persists 'disabled' and skips the write when the confirm callback declines", async () => {
	const exists = (p: string) =>
		stat(p)
			.then(() => true)
			.catch(() => false);
	const result = await install(tempDir, { confirmGlobalInstructions: async () => false });
	expect(result.success).toBe(true);
	expect(await exists(join(fakeHomeDir, ".claude", "CLAUDE.md"))).toBe(false);

	const cfg = JSON.parse(await readFile(join(fakeHomeDir, ".jolli", "jollimemory", "config.json"), "utf-8"));
	expect(cfg.globalInstructions).toBe("disabled");
});

it("writes without prompting when the switch is already 'enabled'", async () => {
	const exists = (p: string) =>
		stat(p)
			.then(() => true)
			.catch(() => false);
	await mkdir(join(fakeHomeDir, ".jolli", "jollimemory"), { recursive: true });
	await writeFile(
		join(fakeHomeDir, ".jolli", "jollimemory", "config.json"),
		JSON.stringify({ globalInstructions: "enabled" }),
	);
	const confirm = vi.fn();
	const result = await install(tempDir, { confirmGlobalInstructions: confirm });
	expect(result.success).toBe(true);
	expect(confirm).not.toHaveBeenCalled();
	expect(await exists(join(fakeHomeDir, ".claude", "CLAUDE.md"))).toBe(true);
});
```

> If `stat` / `mkdir` / `writeFile` / `vi` are not already imported at the top of `Installer.test.ts`, add them to the existing `node:fs/promises` import and the `vitest` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts -t "global"`
Expected: FAIL — the current code writes the block unconditionally (undecided test fails: file exists) and `confirmGlobalInstructions` is not an accepted option.

- [ ] **Step 3: Extend the `install()` options type**

In `cli/src/install/Installer.ts`, change the options parameter at `Installer.ts:144`:

```ts
	options?: {
		source?: "vscode-extension" | "cli";
		integrationsOnly?: boolean;
		sourceTag?: string;
		confirmGlobalInstructions?: () => Promise<boolean>;
	},
```

- [ ] **Step 4: Add imports**

In `cli/src/install/Installer.ts`, add to the existing `SessionTracker.js` import group (near `Installer.ts:42`) so it includes `getGlobalConfigDir` and `saveConfigScoped`, and add to the `GlobalInstructionsInstaller.js` import (near `Installer.ts:84`) so it includes `resolveGlobalInstructionsDecision` alongside `installGlobalInstructions`:

```ts
import { installGlobalInstructions, resolveGlobalInstructionsDecision } from "./GlobalInstructionsInstaller.js";
```

- [ ] **Step 5: Replace the unconditional write with the gated decision**

In `cli/src/install/Installer.ts`, replace the call at `Installer.ts:331-335`:

```ts
		await installGlobalInstructions({
			claude: config.claudeEnabled !== false,
			gemini: geminiDetectedOnce && config.geminiEnabled !== false,
			codex: codexDetectedOnce && config.codexEnabled !== false,
		});
```

with:

```ts
		// Ask before writing into the user's machine-global instruction files.
		// Undecided + no callback (VS Code auto-enable / -y / IntelliJ) → skip and
		// stay undecided; the interactive CLI passes a callback, VS Code drives its
		// own notification. See GlobalInstructionsInstaller.resolveGlobalInstructionsDecision.
		const giDecision = await resolveGlobalInstructionsDecision(
			config.globalInstructions,
			options?.confirmGlobalInstructions,
		);
		if (giDecision.persist) {
			await saveConfigScoped({ globalInstructions: giDecision.persist }, getGlobalConfigDir());
		}
		if (giDecision.write) {
			await installGlobalInstructions({
				claude: config.claudeEnabled !== false,
				gemini: geminiDetectedOnce && config.geminiEnabled !== false,
				codex: codexDetectedOnce && config.codexEnabled !== false,
			});
		}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts -t "global"`
Expected: PASS (all four new tests green).

- [ ] **Step 7: Guard against pre-existing test breakage**

Run: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts`
Expected: PASS. Any prior test that asserted the block IS written after a plain `install(tempDir)` must be updated to pass `{ confirmGlobalInstructions: async () => true }` or seed `globalInstructions: "enabled"` — the block is no longer written by a bare `install()`.

- [ ] **Step 8: Commit**

```bash
git add cli/src/install/Installer.ts cli/src/install/Installer.test.ts
git commit -s -m "feat(cli): gate global-instructions write on the confirmation switch"
```

---

## Task 3: CLI `enable` confirmation prompt

**Files:**
- Modify: `cli/src/commands/CliUtils.ts` (add `isAffirmative`)
- Test: `cli/src/commands/CliUtils.test.ts`
- Modify: `cli/src/commands/EnableCommand.ts` (`EnableCommand.ts:144-148` install call; imports at `EnableCommand.ts:18` and `EnableCommand.ts:15`)

**Interfaces:**
- Consumes: `isInteractive`, `promptText` (`CliUtils.ts`); `GLOBAL_INSTRUCTIONS_PROMPT` (Task 1); `install()`'s `confirmGlobalInstructions` option (Task 2).
- Produces: `isAffirmative(answer: string): boolean` — `true` for empty (Enter), `"y"`, `"yes"` (case-insensitive, trimmed); `false` otherwise.

- [ ] **Step 1: Write the failing `isAffirmative` tests**

Append to `cli/src/commands/CliUtils.test.ts` (extend the existing import from `./CliUtils.js` to include `isAffirmative`):

```ts
describe("isAffirmative", () => {
	it("treats Enter (empty) as yes — the default", () => {
		expect(isAffirmative("")).toBe(true);
	});
	it.each(["y", "Y", "yes", "YES", " Yes "])("treats %j as yes", (input) => {
		expect(isAffirmative(input)).toBe(true);
	});
	it.each(["n", "no", "nope", "x"])("treats %j as no", (input) => {
		expect(isAffirmative(input)).toBe(false);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/commands/CliUtils.test.ts -t "isAffirmative"`
Expected: FAIL — `isAffirmative` not exported.

- [ ] **Step 3: Implement `isAffirmative`**

In `cli/src/commands/CliUtils.ts`, after `isInteractive()` (~`CliUtils.ts:176`), add:

```ts
/**
 * Parses a `[Y/n]` answer where the default (Enter → empty string) is YES.
 * Returns true for "", "y", "yes" (case-insensitive, trimmed); false otherwise.
 */
export function isAffirmative(answer: string): boolean {
	const a = answer.trim().toLowerCase();
	return a === "" || a === "y" || a === "yes";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/commands/CliUtils.test.ts -t "isAffirmative"`
Expected: PASS.

- [ ] **Step 5: Wire the callback into `enable`**

In `cli/src/commands/EnableCommand.ts`:

1. Extend the `CliUtils.js` import at `EnableCommand.ts:18` to include `isAffirmative`:

```ts
import { isAffirmative, isInteractive, promptText, resolveProjectDir } from "./CliUtils.js";
```

2. Add an import of the shared prompt near the `Installer.js` import (`EnableCommand.ts:15`):

```ts
import { GLOBAL_INSTRUCTIONS_PROMPT } from "../install/GlobalInstructionsInstaller.js";
```

3. Replace the `install()` call at `EnableCommand.ts:144-148`:

```ts
				const result = await install(options.cwd, {
					source: "cli",
					integrationsOnly: options.integrationsOnly,
					sourceTag: options.sourceTag,
				});
```

with a module-level helper (add it near the top of `EnableCommand.ts`, after the imports) plus the wired call. The helper isolates the un-runnable interactive I/O behind a clean `/* v8 ignore start/stop */` block:

```ts
/**
 * Confirms the global-instructions write on an interactive terminal. Wrapped in a
 * v8-ignore block because it calls promptText, which cannot run under Vitest's piped
 * (non-TTY) stdin; the yes/no parsing lives in the separately-tested isAffirmative.
 */
/* v8 ignore start -- interactive stdin prompt; not exercisable under piped test stdin */
async function confirmGlobalInstructionsInteractively(): Promise<boolean> {
	return isAffirmative(await promptText(`\n  ${GLOBAL_INSTRUCTIONS_PROMPT}\n  [Y/n]: `));
}
/* v8 ignore stop */
```

Then the install call at `EnableCommand.ts:144-148` becomes:

```ts
				const result = await install(options.cwd, {
					source: "cli",
					integrationsOnly: options.integrationsOnly,
					sourceTag: options.sourceTag,
					confirmGlobalInstructions:
						isInteractive() && !options.yes ? confirmGlobalInstructionsInteractively : undefined,
				});
```

> The v8-ignore wraps only the promptText-calling helper. The `isInteractive() && !options.yes ? … : undefined` ternary itself is still counted (Api.test drives the non-TTY `undefined` branch); `isAffirmative` is unit-tested in isolation. Run coverage in Step 6 and confirm no dip.

- [ ] **Step 6: Run build + lint + the affected suites**

Run: `npm run typecheck:cli && npm run lint && npm run test -w @jolli.ai/cli -- src/commands/CliUtils.test.ts src/Api.test.ts`
Expected: PASS, no Biome warnings.

- [ ] **Step 7: Commit**

```bash
git add cli/src/commands/CliUtils.ts cli/src/commands/CliUtils.test.ts cli/src/commands/EnableCommand.ts
git commit -s -m "feat(cli): prompt before writing global instructions on interactive enable"
```

---

## Task 4: VS Code activation notification

**Files:**
- Create: `vscode/src/services/GlobalInstructionsPrompt.ts`
- Test: `vscode/src/services/GlobalInstructionsPrompt.test.ts`
- Modify: `vscode/src/Extension.ts` (invoke after the enable / auto-install block, ~`Extension.ts:4010-4040`)

**Interfaces:**
- Consumes: `GLOBAL_INSTRUCTIONS_PROMPT` (`../../cli/src/install/GlobalInstructionsInstaller.js`); `loadConfig`, `saveConfig` (`../../cli/src/core/SessionTracker.js`); `vscode.window.showInformationMessage`; a bridge exposing `enable(): Promise<{ success: boolean; message: string }>`.
- Produces: `maybePromptGlobalInstructions(bridge: { enable: () => Promise<{ success: boolean; message: string }> }): Promise<void>` and `resetGlobalInstructionsSessionFlagForTests(): void` (test-only reset of the module-level session flag).

- [ ] **Step 1: Write the failing tests**

Create `vscode/src/services/GlobalInstructionsPrompt.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showInformationMessage = vi.fn();
vi.mock("vscode", () => ({ window: { showInformationMessage } }));

const loadConfig = vi.fn();
const saveConfig = vi.fn().mockResolvedValue(undefined);
vi.mock("../../cli/src/core/SessionTracker.js", () => ({ loadConfig, saveConfig }));

import { maybePromptGlobalInstructions, resetGlobalInstructionsSessionFlagForTests } from "./GlobalInstructionsPrompt.js";

function makeBridge() {
	return { enable: vi.fn().mockResolvedValue({ success: true, message: "ok" }) };
}

beforeEach(() => {
	vi.clearAllMocks();
	resetGlobalInstructionsSessionFlagForTests();
});
afterEach(() => vi.clearAllMocks());

describe("maybePromptGlobalInstructions", () => {
	it("does nothing when the switch is already decided", async () => {
		loadConfig.mockResolvedValue({ globalInstructions: "enabled" });
		await maybePromptGlobalInstructions(makeBridge());
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("persists 'enabled' and re-runs enable when the user clicks Add", async () => {
		loadConfig.mockResolvedValue({});
		showInformationMessage.mockResolvedValue("Add");
		const bridge = makeBridge();
		await maybePromptGlobalInstructions(bridge);
		expect(saveConfig).toHaveBeenCalledWith({ globalInstructions: "enabled" });
		expect(bridge.enable).toHaveBeenCalledOnce();
	});

	it("persists 'disabled' and does not re-run enable when the user clicks Never", async () => {
		loadConfig.mockResolvedValue({});
		showInformationMessage.mockResolvedValue("Never");
		const bridge = makeBridge();
		await maybePromptGlobalInstructions(bridge);
		expect(saveConfig).toHaveBeenCalledWith({ globalInstructions: "disabled" });
		expect(bridge.enable).not.toHaveBeenCalled();
	});

	it("stays undecided and suppresses re-prompt for the session on dismiss", async () => {
		loadConfig.mockResolvedValue({});
		showInformationMessage.mockResolvedValue(undefined); // dismissed / Not now
		const bridge = makeBridge();
		await maybePromptGlobalInstructions(bridge);
		expect(saveConfig).not.toHaveBeenCalled();

		// Second call in the same session must not prompt again.
		await maybePromptGlobalInstructions(bridge);
		expect(showInformationMessage).toHaveBeenCalledOnce();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/services/GlobalInstructionsPrompt.test.ts`
Expected: FAIL — module `./GlobalInstructionsPrompt.js` does not exist.

- [ ] **Step 3: Implement the service**

Create `vscode/src/services/GlobalInstructionsPrompt.ts`:

```ts
import * as vscode from "vscode";
import { GLOBAL_INSTRUCTIONS_PROMPT } from "../../cli/src/install/GlobalInstructionsInstaller.js";
import { loadConfig, saveConfig } from "../../cli/src/core/SessionTracker.js";

/**
 * True once the user has dismissed the notification (Not now / X / timeout) this
 * VS Code session. Keeps the switch undecided but suppresses re-prompting until the
 * window reloads. Module-level so it lives for the extension-host session.
 */
let dismissedThisSession = false;

/** Test-only: reset the session-dismiss flag between cases. */
export function resetGlobalInstructionsSessionFlagForTests(): void {
	dismissedThisSession = false;
}

/**
 * When the global-instructions switch is still undecided (and not dismissed this
 * session), show a benefit-led notification. On "Add" persist "enabled" and re-run
 * the idempotent enable so the block is written now; on "Never" persist "disabled";
 * on dismiss leave it undecided and suppress re-prompting for this session.
 *
 * Shares GLOBAL_INSTRUCTIONS_PROMPT with the CLI so the wording cannot drift.
 */
export async function maybePromptGlobalInstructions(bridge: {
	enable: () => Promise<{ success: boolean; message: string }>;
}): Promise<void> {
	if (dismissedThisSession) return;
	const cfg = await loadConfig();
	if (cfg.globalInstructions !== undefined) return;

	const ADD = "Add";
	const NEVER = "Never";
	const choice = await vscode.window.showInformationMessage(GLOBAL_INSTRUCTIONS_PROMPT, ADD, "Not now", NEVER);

	if (choice === ADD) {
		await saveConfig({ globalInstructions: "enabled" });
		await bridge.enable();
	} else if (choice === NEVER) {
		await saveConfig({ globalInstructions: "disabled" });
	} else {
		dismissedThisSession = true;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/services/GlobalInstructionsPrompt.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 5: Invoke it from activation**

In `vscode/src/Extension.ts`, add the import near the other service imports:

```ts
import { maybePromptGlobalInstructions } from "./services/GlobalInstructionsPrompt.js";
```

Then, immediately after the auto-enable / auto-install block that ends around `Extension.ts:4010-4040` (after `status`/`refresh` handling, still inside the same activation flow, when `status.enabled || just-enabled`), add:

```ts
			// If Jolli is enabled but the user has not yet decided whether to add the
			// skill-preference block to their global AI instructions, ask once (per
			// session). Fire-and-forget so activation never blocks on the dialog.
			void maybePromptGlobalInstructions(bridge);
```

> Place this so it runs whenever the project is enabled at activation (both the pre-enabled path and the just-auto-enabled path). It self-gates on `loadConfig()` and the session flag, so calling it unconditionally at the end of the enable/auto-install region is safe. Do NOT `await` it — activation must not hang on user input.

- [ ] **Step 6: Typecheck + build + lint the extension**

Run: `npm run build:cli && npm run typecheck -w vscode && npm run lint`
Expected: PASS (cli built first so the extension bundle resolves the new `GlobalInstructionsInstaller` exports), no Biome warnings.

- [ ] **Step 7: Commit**

```bash
git add vscode/src/services/GlobalInstructionsPrompt.ts vscode/src/services/GlobalInstructionsPrompt.test.ts vscode/src/Extension.ts
git commit -s -m "feat(vscode): notify before writing global instructions on activation"
```

---

## Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage ≥ 97/96/97/97, VS Code coverage ≥ 97/97.

- [ ] **Step 2: If git-op tests flake in isolation, re-run with the safe.bareRepository workaround**

Run (only if needed): `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npm run test:cli`
Expected: the git-op flakes clear; coverage verdict holds. (Environment-specific — not a regression.)

- [ ] **Step 3: Manual smoke — CLI declines**

Run in a throwaway git repo (with a fake `HOME` so you don't touch your real `~/.claude/CLAUDE.md`):
```bash
HOME=$(mktemp -d) npm run cli -- enable --cwd /path/to/throwaway-repo
```
Answer `n` at the global-instructions prompt.
Expected: no `~/.claude/CLAUDE.md` under the temp HOME; `config.json` there has `"globalInstructions": "disabled"`. Re-running `enable` does not re-prompt.

- [ ] **Step 4: Manual smoke — CLI accepts**

Repeat Step 3 with a fresh temp HOME and answer Enter (default Y).
Expected: `~/.claude/CLAUDE.md` (under temp HOME) contains the `jolli-recall` block; `config.json` has `"globalInstructions": "enabled"`.

- [ ] **Step 5: Final squash/cleanup commit if needed**

If any fix commits accumulated, ensure each is DCO-signed. No `Co-Authored-By: Claude` / `🤖` footer anywhere.

---

## Self-Review

**Spec coverage:**
- §1 tri-state config field → Task 1 Step 1. ✅
- §2 install() reads switch + optional callback, persists, safe default → Task 2. ✅
- §3 CLI interactive prompt, default Y, persisted, `-y`/non-TTY skips → Task 3. ✅
- §4 VS Code notification (Add/Not now/Never), idempotent re-run, session-dismiss → Task 4. ✅
- §4 shared message body, single constant → Task 1 (`GLOBAL_INSTRUCTIONS_PROMPT`), consumed by Tasks 3 & 4. ✅
- Edge: IntelliJ `--integrations-only` non-interactive → no callback → skip (falls out of Task 2's safe default; no new code). ✅
- Edge: refusal never deletes existing block → Task 2 only gates the write, never removes. ✅
- Testing floor 97% → Tasks 1–4 each ship tests; Task 5 runs `npm run all`. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✅

**Type consistency:** `GlobalInstructionsChoice` / `GlobalInstructionsDecision` / `resolveGlobalInstructionsDecision` (Task 1) match their use in Task 2. `confirmGlobalInstructions` option name identical in Tasks 2 & 3. `isAffirmative` signature identical in Tasks 1-test/3. `maybePromptGlobalInstructions(bridge)` shape matches the `bridge.enable()` return type used in Extension.ts. `GLOBAL_INSTRUCTIONS_PROMPT` imported from the same module (`install/GlobalInstructionsInstaller.js`) by CLI and VS Code. ✅
