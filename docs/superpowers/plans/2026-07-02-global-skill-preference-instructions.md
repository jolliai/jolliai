# Global Skill-Preference Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `jolli enable`, auto-write a "prefer jolli-pr / jolli-search / jolli-recall by default" standing instruction into each detected host's global instruction file (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`).

**Architecture:** A new fail-soft installer module (`GlobalInstructionsInstaller.ts`) upserts a marker-bracketed managed block into per-host global markdown files, mirroring `GitExclude.ts` exactly. `Installer.install()` calls it once, outside the worktree loop, gated per-host on the detection/enable flags it already computes. `uninstall()` is untouched — the global block is deliberately preserved (same policy as global-scope MCP registration).

**Tech Stack:** TypeScript (ESM), Node 22.5+, Vitest, Biome. No new dependencies.

## Global Constraints

Copied verbatim from the spec and repo critical rules — every task inherits these:

- **DCO sign-off on the (single, final) commit** — `git commit -s`. CI rejects commits without `Signed-off-by:`.
- **No `Co-Authored-By: Claude …` trailer and no "🤖 Generated with …" footer** in the commit message.
- **`npm run all` must pass before the commit** (clean → build → lint → test).
- **CLI coverage floor** — new code under `cli/src/` is held to 97% statements / 96% branches / 97% functions / 97% lines. The new module must be fully covered; use `/* v8 ignore start */ … /* v8 ignore stop */` **block** form for defensive-only branches (single-line `ignore next` does NOT work in this repo).
- **Biome** — tabs, 4-wide indent, 120-column limit, `noExplicitAny: error`, `useImportType: warn` (imports of types use `import type`). `biome check --error-on-warnings` runs in CI.
- **Block content is English.**
- **Marker scan is exact-line** — a stray marker-like substring elsewhere in the file must not be treated as a marker.
- **Fail-soft** — a read/write error on any target is logged and skipped; it must never throw out of `installGlobalInstructions` or break `jolli enable`.

## Commit / test cadence (user preference — overrides skill default)

Per the user's standing preference, do **NOT** run `npm run all` or commit per task. Each task below writes test + implementation code only. A single final task (Task 4) runs `npm run all` once and makes one commit. The failing-test-first ordering within tasks is preserved for TDD discipline, but there is no per-task "run the test" or "commit" step.

## Confirmed facts (verified on this machine, 2026-07-02)

- `~/.codex/AGENTS.md` already exists (empty) → Codex's global instruction file is `AGENTS.md`, **not** `instructions.md`. Resolved the spec's open verification item.
- `~/.claude/` exists (has `config.json`, no `CLAUDE.md`) → writing `~/.claude/CLAUDE.md` is the correct global-memory location for Claude Code.
- `~/.gemini/` absent on this machine → confirms the per-host gating is load-bearing (we must not create it when Gemini isn't present).

## File Structure

- **Create** `cli/src/install/GlobalInstructionsInstaller.ts` — the whole feature: block rendering, pure upsert, per-target I/O, and the public `installGlobalInstructions(hosts)` entry point. One cohesive responsibility (managing the global instruction blocks), small enough to hold in one file.
- **Create** `cli/src/install/GlobalInstructionsInstaller.test.ts` — unit tests, temp-`HOME` integration tests.
- **Modify** `cli/src/install/Installer.ts` — one guarded call in `install()`.

---

### Task 1: Pure block rendering + upsert core

**Files:**
- Create: `cli/src/install/GlobalInstructionsInstaller.ts`
- Test: `cli/src/install/GlobalInstructionsInstaller.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module besides `createLogger`).
- Produces:
  - `renderInstructionsBlock(): string` — marker-wrapped block, trailing `\n`.
  - `applyInstructionsBlock(existing: string, block: string): string` — pure upsert.
  - `const BLOCK_START = "<!-- >>> jolli memory instructions >>> -->"`, `const BLOCK_END = "<!-- <<< jolli memory instructions <<< -->"` (module-private).

- [ ] **Step 1: Write the failing tests for the pure functions**

Create `cli/src/install/GlobalInstructionsInstaller.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir };
});

import {
	applyInstructionsBlock,
	installGlobalInstructions,
	renderInstructionsBlock,
} from "./GlobalInstructionsInstaller.js";

const START = "<!-- >>> jolli memory instructions >>> -->";
const END = "<!-- <<< jolli memory instructions <<< -->";

describe("renderInstructionsBlock", () => {
	it("wraps all three skill names in a marker block ending with a newline", () => {
		const block = renderInstructionsBlock();
		expect(block.startsWith(START)).toBe(true);
		expect(block.endsWith(`${END}\n`)).toBe(true);
		expect(block).toContain("jolli-pr");
		expect(block).toContain("jolli-search");
		expect(block).toContain("jolli-recall");
	});
});

describe("applyInstructionsBlock", () => {
	const block = renderInstructionsBlock();

	it("returns the block alone for empty input", () => {
		expect(applyInstructionsBlock("", block)).toBe(block);
	});

	it("appends the block after existing content with exactly one separating newline", () => {
		const result = applyInstructionsBlock("# My notes\n", block);
		expect(result).toBe(`# My notes\n${block}`);
	});

	it("adds a separating newline when existing content has no trailing newline", () => {
		const result = applyInstructionsBlock("# My notes", block);
		expect(result).toBe(`# My notes\n${block}`);
	});

	it("replaces an existing block in place, preserving surrounding content", () => {
		const stale = [START, "## Stale", END].join("\n");
		const existing = `# Top\n${stale}\n# Bottom\n`;
		const result = applyInstructionsBlock(existing, block);
		expect(result).toContain("# Top");
		expect(result).toContain("# Bottom");
		expect(result).toContain("jolli-recall");
		expect(result).not.toContain("## Stale");
	});

	it("is idempotent — applying twice changes nothing", () => {
		const once = applyInstructionsBlock("# Top\n", block);
		expect(applyInstructionsBlock(once, block)).toBe(once);
	});

	it("ignores a marker-like substring that is not on its own line", () => {
		const prose = `Here is a mention of ${START} inside a sentence.\n`;
		const result = applyInstructionsBlock(prose, block);
		// No exact-line marker → block is appended, prose left intact.
		expect(result).toBe(`${prose}${block}`);
	});
});
```

- [ ] **Step 2: Write the module to satisfy the pure-function tests**

Create `cli/src/install/GlobalInstructionsInstaller.ts`:

```ts
/**
 * Writes Jolli Memory's "prefer these skills by default" standing instruction
 * into each detected AI host's GLOBAL instruction file:
 *
 *   - Claude Code → ~/.claude/CLAUDE.md
 *   - Gemini CLI  → ~/.gemini/GEMINI.md
 *   - Codex       → ~/.codex/AGENTS.md
 *
 * The rule tells the host LLM to reach for the jolli-pr / jolli-search /
 * jolli-recall skills by default for PR creation / search / recall, instead of
 * leaving skill selection to chance.
 *
 * Managed-block strategy mirrors GitExclude.ts: a marker-bracketed section is
 * upserted, everything outside the markers is preserved verbatim, and the whole
 * operation is fail-soft — a broken or read-only global file never breaks
 * `jolli enable`.
 *
 * These files are machine-GLOBAL (one per host, shared by every repo), so
 * `jolli uninstall` deliberately does NOT remove the block — the same policy as
 * global-scope MCP registration.
 *
 * A global `AGENTS.md` is only read by Codex; Cursor / OpenCode / Copilot read
 * AGENTS.md at the project root, so they are intentionally out of reach here.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("GlobalInstructionsInstaller");

/**
 * Marker pair bracketing Jolli's managed block. Lines between the markers
 * belong to Jolli and may be rewritten on future installs; anything outside is
 * untouched. HTML comments so the block is invisible when the markdown renders.
 */
const BLOCK_START = "<!-- >>> jolli memory instructions >>> -->";
const BLOCK_END = "<!-- <<< jolli memory instructions <<< -->";

/** Which hosts to write the global instruction file for (per-host gated). */
export interface InstructionHosts {
	readonly claude: boolean;
	readonly gemini: boolean;
	readonly codex: boolean;
}

interface InstructionTarget {
	readonly host: keyof InstructionHosts;
	/** Path segments relative to the user's home dir. */
	readonly relPath: ReadonlyArray<string>;
}

const TARGETS: ReadonlyArray<InstructionTarget> = [
	{ host: "claude", relPath: [".claude", "CLAUDE.md"] },
	{ host: "gemini", relPath: [".gemini", "GEMINI.md"] },
	{ host: "codex", relPath: [".codex", "AGENTS.md"] },
];

/**
 * Renders the managed block including marker lines and a trailing newline.
 * Joined with `\n` (not the platform EOL) so the file reads identically for a
 * team sharing dotfiles across OSes.
 */
export function renderInstructionsBlock(): string {
	const lines = [
		BLOCK_START,
		"## Jolli Memory",
		"",
		"When Jolli Memory is enabled in a repository, prefer its skills by default:",
		"",
		"- **Creating a pull request** → use the `jolli-pr` skill (its description comes",
		"  from Jolli Memory's recorded commit history), unless the user explicitly asks",
		"  for another method.",
		"- **Searching prior work, decisions, or related commits** → use the",
		"  `jolli-search` skill.",
		"- **Recalling or resuming prior context on a branch** → use the `jolli-recall`",
		"  skill.",
		"",
		"If a skill is not available (Jolli Memory is not enabled in that repository),",
		"fall back to normal behavior.",
		BLOCK_END,
	];
	return `${lines.join("\n")}\n`;
}

/**
 * Replaces an existing managed block in `existing`, or appends one if none is
 * found. Preserves all other content verbatim. The scan matches the marker
 * lines exactly (line-oriented) so a stray marker substring inside prose does
 * not confuse the parser. The first matching marker pair wins.
 */
export function applyInstructionsBlock(existing: string, block: string): string {
	const lines = existing.split("\n");
	const startIdx = lines.indexOf(BLOCK_START);
	const endIdx = lines.indexOf(BLOCK_END);

	// `renderInstructionsBlock` always appends a trailing `\n`; strip it before
	// splitting so the spliced lines don't carry an empty trailing element.
	const newBlockLines = block.slice(0, -1).split("\n");

	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		const next = [...lines.slice(0, startIdx), ...newBlockLines, ...lines.slice(endIdx + 1)];
		return next.join("\n");
	}

	if (existing.length === 0) {
		return block;
	}
	const sep = existing.endsWith("\n") ? "" : "\n";
	return `${existing}${sep}${block}`;
}
```

Note: `installGlobalInstructions` (referenced by the test import) is added in Task 2. Task 1's pure-function tests pass once the two exported functions above exist; the import of the not-yet-defined `installGlobalInstructions` resolves to `undefined` but is not exercised until Task 2's tests run.

---

### Task 2: `installGlobalInstructions` — per-host, fail-soft file I/O

**Files:**
- Modify: `cli/src/install/GlobalInstructionsInstaller.ts` (append the I/O layer)
- Test: `cli/src/install/GlobalInstructionsInstaller.test.ts` (append integration tests)

**Interfaces:**
- Consumes: `renderInstructionsBlock`, `applyInstructionsBlock`, `TARGETS`, `homedir()`.
- Produces: `installGlobalInstructions(hosts: InstructionHosts): Promise<void>` — for each target whose `hosts[host]` is `true`, upsert the block into `join(homedir(), ...relPath)`. Never throws.

- [ ] **Step 1: Write the failing integration tests**

Append to `cli/src/install/GlobalInstructionsInstaller.test.ts`:

```ts
describe("installGlobalInstructions", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "jolli-global-instr-"));
		mockHomedir.mockReturnValue(home);
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("creates all enabled hosts' global instruction files", async () => {
		await installGlobalInstructions({ claude: true, gemini: true, codex: true });

		const claude = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		const gemini = await readFile(join(home, ".gemini", "GEMINI.md"), "utf-8");
		const codex = await readFile(join(home, ".codex", "AGENTS.md"), "utf-8");
		for (const content of [claude, gemini, codex]) {
			expect(content).toContain(START);
			expect(content).toContain("jolli-pr");
		}
	});

	it("does not create a file for a disabled host", async () => {
		await installGlobalInstructions({ claude: true, gemini: false, codex: false });

		expect(await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8")).toContain("jolli-pr");
		await expect(readFile(join(home, ".gemini", "GEMINI.md"), "utf-8")).rejects.toThrow();
		await expect(readFile(join(home, ".codex", "AGENTS.md"), "utf-8")).rejects.toThrow();
	});

	it("preserves pre-existing user content outside the block", async () => {
		await mkdir(join(home, ".claude"), { recursive: true });
		await writeFile(join(home, ".claude", "CLAUDE.md"), "# My global rules\n\nBe concise.\n", "utf-8");

		await installGlobalInstructions({ claude: true, gemini: false, codex: false });

		const content = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		expect(content).toContain("# My global rules");
		expect(content).toContain("Be concise.");
		expect(content).toContain("jolli-recall");
	});

	it("is idempotent — a second run does not change the file", async () => {
		await installGlobalInstructions({ claude: true, gemini: false, codex: false });
		const first = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		await installGlobalInstructions({ claude: true, gemini: false, codex: false });
		const second = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8");
		expect(second).toBe(first);
	});
});
```

- [ ] **Step 2: Append the I/O layer to the module**

Append to `cli/src/install/GlobalInstructionsInstaller.ts`:

```ts
/**
 * Upserts the managed block into a single absolute file path. Fail-soft: logs
 * and returns on any read/write error rather than throwing.
 */
async function upsertTarget(absPath: string, block: string): Promise<void> {
	let existing = "";
	try {
		existing = await readFile(absPath, "utf-8");
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		/* v8 ignore start -- defensive: non-ENOENT read errors (perm denied, EISDIR) */
		if (code !== "ENOENT") {
			log.warn("Failed to read %s: %s — skipping", absPath, (err as Error).message);
			return;
		}
		/* v8 ignore stop */
	}

	const updated = applyInstructionsBlock(existing, block);
	if (updated === existing) {
		return; // No change needed.
	}

	try {
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, updated, "utf-8");
		log.info("Updated %s with Jolli Memory instructions", absPath);
		/* v8 ignore start -- defensive: write failure on read-only fs / EPERM */
	} catch (err: unknown) {
		log.warn("Failed to write %s: %s", absPath, (err as Error).message);
	}
	/* v8 ignore stop */
}

/**
 * Writes the Jolli Memory instruction block into the global instruction file of
 * every host whose flag is `true`. Called once from `Installer.install()`,
 * outside the per-worktree loop, because these files are machine-global.
 */
export async function installGlobalInstructions(hosts: InstructionHosts): Promise<void> {
	const block = renderInstructionsBlock();
	const home = homedir();
	for (const target of TARGETS) {
		if (!hosts[target.host]) continue;
		await upsertTarget(join(home, ...target.relPath), block);
	}
}
```

---

### Task 3: Wire into `Installer.install()`

**Files:**
- Modify: `cli/src/install/Installer.ts` (import + one guarded call after `registerGlobalMcpHosts`)

**Interfaces:**
- Consumes: `installGlobalInstructions` (Task 2), plus the already-computed locals `codexDetectedOnce`, `geminiDetectedOnce`, and `config.claudeEnabled` / `config.geminiEnabled` / `config.codexEnabled`.
- Produces: nothing new — behavior wiring only.

- [ ] **Step 1: Add the import**

At the top of `cli/src/install/Installer.ts`, near the other `./` install imports (e.g. after the `SkillInstaller.js` import on line 91), add:

```ts
import { installGlobalInstructions } from "./GlobalInstructionsInstaller.js";
```

- [ ] **Step 2: Add the guarded call after `registerGlobalMcpHosts`**

In `install()`, immediately after the `registerGlobalMcpHosts({ … });` call (currently ending at line 288) and before the "Git hooks are shared…" comment, insert:

```ts
			// Prefer Jolli's skills by default: write a standing rule into each
			// detected host's GLOBAL instruction file. Machine-global (one per
			// host, shared by every repo) — mirrors registerGlobalMcpHosts above,
			// and like it, uninstall deliberately leaves the block in place.
			// Per-host gated: never create a host's file on a machine without it.
			await installGlobalInstructions({
				claude: config.claudeEnabled !== false,
				gemini: geminiDetectedOnce && config.geminiEnabled !== false,
				codex: codexDetectedOnce && config.codexEnabled !== false,
			});
```

Rationale for the gate expressions: `config.claudeEnabled` follows the same `!== false` default-on convention used for the Claude skill/hook; `codexEnabled`/`geminiEnabled` may still be `undefined` at this point (Codex auto-enable happens a few lines later), and `undefined !== false` is `true`, so a freshly-detected host is written on first enable — the intended behavior.

- [ ] **Step 3: Confirm `install()` still type-checks conceptually**

No new types cross the boundary; `installGlobalInstructions` returns `Promise<void>` and is awaited. Nothing consumes its result. (Actual `npm run typecheck` runs in Task 4.)

---

### Task 4: Verify and commit (single, final)

**Files:** none (verification + commit only).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage stays ≥ 97/96/97/97 with the new module fully covered.

If coverage flags an uncovered line in `GlobalInstructionsInstaller.ts`, it will be inside one of the two `/* v8 ignore start/stop */` defensive catch blocks — confirm the ignore markers are the **block** form (single-line `ignore next` does not work in this repo) and correctly bracket the whole defensive branch.

- [ ] **Step 2: Stage and commit (DCO, no AI co-author)**

```bash
git add cli/src/install/GlobalInstructionsInstaller.ts \
        cli/src/install/GlobalInstructionsInstaller.test.ts \
        cli/src/install/Installer.ts
git commit -s -m "feat(install): write global skill-preference instructions on enable

On jolli enable, upsert a managed block into each detected host's global
instruction file (~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md, ~/.codex/AGENTS.md)
telling the agent to prefer jolli-pr / jolli-search / jolli-recall by default.
Per-host gated; fail-soft; uninstall leaves the block in place (global scope,
like MCP registration)."
```

Expected: commit succeeds with a `Signed-off-by:` trailer and **no** `Co-Authored-By: Claude` / "Generated with Claude" footer.

---

## Self-Review

**1. Spec coverage:**
- Global cross-host files (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`) → `TARGETS` in Task 1/2. ✓
- Managed-block upsert mirroring GitExclude → `applyInstructionsBlock` Task 1. ✓
- Per-host detection gating → Task 3 gate expressions. ✓
- Fail-soft → `upsertTarget` catch blocks Task 2. ✓
- Uninstall untouched → no `uninstall()` edit anywhere in the plan (called out in Task 3 note and commit message). ✓
- English block content → `renderInstructionsBlock` Task 1. ✓
- Codex path verified (`AGENTS.md`) → Confirmed facts section. ✓
- Testing matrix (empty/append/replace/idempotent/stray-marker/host-gating/preserve-content) → Task 1 + Task 2 tests. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command shows expected output. ✓

**3. Type consistency:** `installGlobalInstructions(hosts: InstructionHosts)`, `InstructionHosts { claude; gemini; codex }`, `applyInstructionsBlock(existing, block)`, `renderInstructionsBlock()`, `BLOCK_START`/`BLOCK_END` marker strings — names/signatures identical across Task 1, 2, 3, and both test files. ✓
