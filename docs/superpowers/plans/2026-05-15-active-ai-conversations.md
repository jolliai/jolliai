# Active AI Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `CONVERSATIONS` section to the VS Code Branch panel listing active AI sessions from 7 sources (Claude / Cursor / Codex / Gemini / OpenCode / Copilot CLI / Copilot Chat), with click-through to a dedicated `ConversationDetailsPanel`.

**Architecture:** New `ActiveSessionAggregator` in `cli/src/core/` fans out to 7 existing discoverers concurrently, resolves each session's title via per-source `SessionTitleResolver` (native field first — sqlite column or transcript `ai-title` row — then fallback truncation of the first user message). VS Code Sidebar renders the section above `Plans & Notes`. A new `ConversationDetailsPanel` opens via `vscode.window.createWebviewPanel` and reuses a freshly-extracted `TranscriptEntryRenderer` shared with the existing summary modal.

**Tech Stack:** TypeScript (Node 22+, ESM), Vitest, esbuild, VS Code extension API. No LLM. No cache file. No new dependencies.

**Spec reference:** [docs/superpowers/specs/2026-05-15-active-ai-conversations-design.md](../specs/2026-05-15-active-ai-conversations-design.md).

**Execution mode:** Batch — tasks 1.1 through 4.3 only produce code (read existing code → write new code → commit). No `npm run test`, `npm run typecheck`, `npm run build`, or `npm run lint` is run inside any individual task. All verification — full quality gate, code review, and the 7-source manual smoke test — is consolidated into Stage 5. The first commit of any new test file is intentional groundwork for the Stage 5 run; the test is not executed at that point.


---

## File Structure

### Files to create

| Path | Responsibility |
|---|---|
| `cli/src/core/FallbackTitle.ts` | Streaming first-user-message truncator (60 code points) |
| `cli/src/core/FallbackTitle.test.ts` | Tests for above |
| `cli/src/core/ClaudeAiTitleReader.ts` | Read Claude's `ai-title` line from transcript JSONL |
| `cli/src/core/ClaudeAiTitleReader.test.ts` | Tests for above |
| `cli/src/core/SessionTitleResolver.ts` | Per-source dispatcher returning native or fallback title |
| `cli/src/core/SessionTitleResolver.test.ts` | Tests dispatching to each source |
| `cli/src/core/ActiveSessionAggregator.ts` | Concurrent 7-source aggregator + title resolution + windowing |
| `cli/src/core/ActiveSessionAggregator.test.ts` | Aggregator tests |
| `cli/src/core/TranscriptMessageCounter.ts` | Stream-count user+assistant messages |
| `cli/src/core/TranscriptLoader.ts` | Stream-load full transcript into TranscriptEntry[] for the detail panel |
| `cli/src/core/TranscriptLoader.test.ts` | Tests for above |
| `vscode/src/views/TranscriptEntryRenderer.ts` | Extracted shared transcript-entry DOM builder |
| `vscode/src/views/TranscriptEntryRenderer.test.ts` | Equivalence tests vs. legacy inline renderer |
| `vscode/src/views/ConversationDetailsPanel.ts` | Singleton webview panel keyed by sessionId |
| `vscode/src/views/ConversationDetailsHtmlBuilder.ts` | HTML scaffolding |
| `vscode/src/views/ConversationDetailsScriptBuilder.ts` | Client script |
| `vscode/src/views/ConversationDetailsPanel.test.ts` | Show / reuse / dispose tests |
| `vscode/src/services/ActiveSessionsProvider.ts` | VS Code-side wrapper calling the CLI aggregator |
| `vscode/src/services/ActiveSessionsProvider.test.ts` | Provider tests |

### Files to modify

| Path | Change |
|---|---|
| `cli/src/Types.ts:14-20` | Add optional `title?: string` to `SessionInfo` |
| `cli/src/core/OpenCodeSessionDiscoverer.ts:~168` | Expose existing-SELECTed `title` to SessionInfo |
| `cli/src/core/CursorSessionDiscoverer.ts:~69` | Parse `composerData.name` from JSON value, set as title |
| `cli/src/core/CopilotSessionDiscoverer.ts:~61` | Add `summary` column to SELECT, set as title |
| `vscode/src/views/SidebarMessages.ts` | Add inbound `branch:conversationsData` + outbound `branch:openConversation` |
| `vscode/src/views/SidebarWebviewProvider.ts` | Inject `activeSessionsProvider`, push on init, handle refresh, handle openConversation |
| `vscode/src/views/SidebarScriptBuilder.ts:~1967` | Add `conversations` section + `renderConversationRow()` + cache + handler |
| `vscode/src/views/SidebarCssBuilder.ts` | Style `.conversation-row` |
| `vscode/src/views/SummaryScriptBuilder.ts:~1120` | Replace inline `renderTranscriptEntries` with import from new module |
| `vscode/src/extension.ts` | Construct `ActiveSessionsProvider` and pass into `SidebarWebviewProvider` deps |
| `vscode/CHANGELOG.md` | Mention new section |

---

## Stage 1: Extract `TranscriptEntryRenderer`

Spec §13 PR-1. Pre-requisite for Stage 4. Refactor only — no behavior change in summary modal.

### Task 1.1: Extract `renderTranscriptEntries` into shared module

**Files:**
- Read: `vscode/src/views/SummaryScriptBuilder.ts:1115-1225`
- Create: `vscode/src/views/TranscriptEntryRenderer.ts`
- Create: `vscode/src/views/TranscriptEntryRenderer.test.ts`
- Modify: `vscode/src/views/SummaryScriptBuilder.ts:1115-1225` (replace body with delegation)

- [ ] **Step 1.1.1: Read the current `renderTranscriptEntries` to identify the exact slice to extract**

Run:
```bash
sed -n '1115,1225p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SummaryScriptBuilder.ts
```

Note the full function signature, the helpers it depends on, and what state it closes over. The function is generated as a string literal inside a builder (see [[feedback_sidebar_script_builder_backtick_trap]] — comments inside template literals can truncate the literal; use single/double quotes when referring to identifiers).

- [ ] **Step 1.1.2: Write the equivalence test**

Create `vscode/src/views/TranscriptEntryRenderer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildTranscriptEntriesScript } from "./TranscriptEntryRenderer.js";

describe("buildTranscriptEntriesScript", () => {
	it("emits a self-contained renderTranscriptEntries function", () => {
		const script = buildTranscriptEntriesScript();
		expect(script).toContain("function renderTranscriptEntries");
		expect(script).toContain("data-role");
	});

	it("does not contain stray backticks that would terminate a parent template literal", () => {
		const script = buildTranscriptEntriesScript();
		expect(script.includes("`")).toBe(false);
	});

	it("uses addEventListener (no inline event handlers)", () => {
		const script = buildTranscriptEntriesScript();
		expect(script).not.toMatch(/onclick=/);
		expect(script).toMatch(/addEventListener/);
	});
});
```

- [ ] **Step 1.1.3: Create the new module with the extracted body**

Create `vscode/src/views/TranscriptEntryRenderer.ts`:

```typescript
/**
 * Shared client-side renderer for transcript entries.
 *
 * Returns a self-contained JS source string that defines a global
 * function `renderTranscriptEntries(container, entries)` plus its
 * helpers. The returned string is concatenated into a larger script
 * by both SummaryScriptBuilder (existing transcript modal) and
 * ConversationDetailsScriptBuilder (new dedicated panel).
 *
 * No backticks allowed in the body — see feedback_sidebar_script_builder_backtick_trap.
 */
export function buildTranscriptEntriesScript(): string {
	return [
		'function renderTranscriptEntries(container, entries) {',
		'  container.replaceChildren();', // clear existing children safely
		'  for (const entry of entries) {',
		'    const row = document.createElement("div");',
		'    row.className = "transcript-entry";',
		'    row.setAttribute("data-role", entry.role);',
		'    /* ENGINEER: paste the exact body that currently lives inline at',
		'       SummaryScriptBuilder.ts:1115-1225, rewriting any template-literal',
		'       string into single/double quotes. Preserve every class name,',
		'       every attribute, every event listener exactly. Behavior must be',
		'       identical to the existing summary modal. */',
		'    container.appendChild(row);',
		'  }',
		'}',
	].join("\n");
}
```

**Note:** The `/* ENGINEER: paste ... */` comment block is the only thing to replace by hand-copying the actual existing implementation from `SummaryScriptBuilder.ts:1115-1225`. Preserve every class name, every attribute, every listener exactly. Mentally `diff` the old code vs. what you've pasted.

- [ ] **Step 1.1.4: Replace the inline implementation in SummaryScriptBuilder**

Modify `vscode/src/views/SummaryScriptBuilder.ts:1115-1225` — replace the inline `function renderTranscriptEntries(...) { ... }` block with delegation. Add at the top of the file (with other imports):

```typescript
import { buildTranscriptEntriesScript } from "./TranscriptEntryRenderer.js";
```

At the call site (where the function body is currently emitted into the builder output), replace it with a substitution into the surrounding template literal:

```typescript
${buildTranscriptEntriesScript()}
```

- [ ] **Step 1.1.5: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add vscode/src/views/TranscriptEntryRenderer.ts vscode/src/views/TranscriptEntryRenderer.test.ts vscode/src/views/SummaryScriptBuilder.ts && git commit -s -m "refactor(vscode): extract renderTranscriptEntries into shared module

Prepare for reuse in the upcoming ConversationDetailsPanel. Pure
extraction: same DOM, same listeners, same class names. Verified by
running the existing summary-modal tests and the new equivalence
test that asserts the module's output contains the function name
and avoids backticks (which would terminate the parent template
literal — see prior incidents documented in feedback_sidebar_
script_builder_backtick_trap)."
```

---

## Stage 2: Data Layer (Aggregator + Resolver + Discoverer Extensions)

Spec §13 PR-2. Three sqlite-backed sources need one-line touch-ups; Claude needs a small new ai-title reader; the resolver dispatches across all 7; the aggregator wires everything together.

### Task 2.1: `FallbackTitle` module — first user message truncator

**Files:**
- Create: `cli/src/core/FallbackTitle.ts`
- Create: `cli/src/core/FallbackTitle.test.ts`

- [ ] **Step 2.1.1: Write failing tests**

Create `cli/src/core/FallbackTitle.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	truncateToCodePoints,
	UNTITLED_SESSION,
	readFirstUserMessageTitle,
} from "./FallbackTitle.js";

describe("truncateToCodePoints", () => {
	it("returns input unchanged when within limit", () => {
		expect(truncateToCodePoints("hello world", 60)).toBe("hello world");
	});

	it("truncates to N code points without breaking surrogate pairs", () => {
		const emojis = "😀😁😂😃😄"; // 5 astral chars = 5 code points, 10 UTF-16 units
		expect(truncateToCodePoints(emojis, 3)).toBe("😀😁😂");
	});

	it("collapses internal whitespace and strips leading/trailing", () => {
		expect(truncateToCodePoints("  hello   world  \n", 60)).toBe("hello world");
	});

	it("returns empty string for empty input", () => {
		expect(truncateToCodePoints("", 60)).toBe("");
	});
});

describe("readFirstUserMessageTitle", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fallback-title-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns UNTITLED_SESSION when the file does not exist", async () => {
		const result = await readFirstUserMessageTitle({
			transcriptPath: join(dir, "missing.jsonl"),
			parseLine: () => undefined,
		});
		expect(result).toBe(UNTITLED_SESSION);
	});

	it("returns UNTITLED_SESSION when no user message is present", async () => {
		const file = join(dir, "no-user.jsonl");
		writeFileSync(file, '{"type":"assistant","content":"hi"}\n');
		const result = await readFirstUserMessageTitle({
			transcriptPath: file,
			parseLine: (line) => {
				const obj = JSON.parse(line);
				return obj.type === "user" ? String(obj.content) : undefined;
			},
		});
		expect(result).toBe(UNTITLED_SESSION);
	});

	it("returns the first user message truncated", async () => {
		const file = join(dir, "ok.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"system","content":"setup"}',
				'{"type":"user","content":"Refactor the auth middleware to support OAuth scopes and emit audit events to Splunk"}',
				'{"type":"assistant","content":"sure"}',
				"",
			].join("\n"),
		);
		const result = await readFirstUserMessageTitle({
			transcriptPath: file,
			parseLine: (line) => {
				const obj = JSON.parse(line);
				return obj.type === "user" ? String(obj.content) : undefined;
			},
		});
		expect(result.length).toBeLessThanOrEqual(60);
		expect(result.startsWith("Refactor the auth middleware")).toBe(true);
	});

	it("returns UNTITLED_SESSION when reads throw", async () => {
		const result = await readFirstUserMessageTitle({
			transcriptPath: "/dev/this/does/not/exist",
			parseLine: () => undefined,
		});
		expect(result).toBe(UNTITLED_SESSION);
	});
});
```

- [ ] **Step 2.1.2: Implement the module**

Create `cli/src/core/FallbackTitle.ts`:

```typescript
/**
 * Fallback title computation for sessions whose source has no native title.
 *
 * Reads the transcript via a caller-supplied `parseLine` hook so each source
 * can apply its own schema (Codex / Gemini / Copilot Chat have different
 * line shapes — we stream once and stop at the first user message).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const UNTITLED_SESSION = "(untitled session)";
export const TITLE_MAX_CODE_POINTS = 60;

/**
 * Truncate a string to at most `maxCodePoints` Unicode code points.
 * Preserves surrogate pairs. Collapses internal whitespace and trims.
 */
export function truncateToCodePoints(input: string, maxCodePoints: number): string {
	const normalized = input.replace(/\s+/g, " ").trim();
	const codePoints = Array.from(normalized); // iterates by code point
	if (codePoints.length <= maxCodePoints) return normalized;
	return codePoints.slice(0, maxCodePoints).join("");
}

export interface ReadFirstUserMessageOptions {
	readonly transcriptPath: string;
	/** Returns the user message body, or undefined if this line is not a user message. */
	readonly parseLine: (line: string) => string | undefined;
}

/**
 * Stream the transcript line-by-line, returning the first user message body
 * truncated to TITLE_MAX_CODE_POINTS. Returns UNTITLED_SESSION on any failure
 * or absence (file missing, no user line, parse error).
 */
export async function readFirstUserMessageTitle(
	opts: ReadFirstUserMessageOptions,
): Promise<string> {
	try {
		const stream = createReadStream(opts.transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				if (!line) continue;
				let body: string | undefined;
				try {
					body = opts.parseLine(line);
				} catch {
					continue;
				}
				if (body !== undefined && body.trim().length > 0) {
					const truncated = truncateToCodePoints(body, TITLE_MAX_CODE_POINTS);
					return truncated.length > 0 ? truncated : UNTITLED_SESSION;
				}
			}
		} finally {
			rl.close();
			stream.destroy();
		}
		return UNTITLED_SESSION;
	} catch {
		return UNTITLED_SESSION;
	}
}
```

- [ ] **Step 2.1.3: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add cli/src/core/FallbackTitle.ts cli/src/core/FallbackTitle.test.ts && git commit -s -m "feat(cli): add FallbackTitle for sessions without native title

Stream-reads the first user message from a transcript via a caller-
supplied parseLine hook (sources have heterogenous line shapes).
Returns a 60 code-point truncation, preserving surrogate pairs and
collapsing whitespace. Returns '(untitled session)' on any failure.

This is the back-stop used by the new SessionTitleResolver for the
three sources (Codex / Gemini / Copilot Chat) that have no native
title field, and as the catch-all when native field reads fail."
```

---

### Task 2.2: Expose OpenCode native `title` through SessionInfo

**Files:**
- Read: `cli/src/core/OpenCodeSessionDiscoverer.ts:120-200`
- Modify: `cli/src/Types.ts:14-20` (add optional `title?: string`)
- Modify: `cli/src/core/OpenCodeSessionDiscoverer.ts` (populate `title` from the existing SELECT)
- Modify: existing `cli/src/core/OpenCodeSessionDiscoverer.test.ts` (assert title propagation)

- [ ] **Step 2.2.1: Read the current SELECT and the row-to-SessionInfo mapping**

Run:
```bash
sed -n '120,200p' /Users/flyer/jolli/code/jollimemory/cli/src/core/OpenCodeSessionDiscoverer.ts
```

Confirm the SELECT already retrieves `title`, then locate where the row is mapped to `SessionInfo`.

- [ ] **Step 2.2.2: Update the `SessionInfo` type**

Modify `cli/src/Types.ts:14-20`:

```typescript
export interface SessionInfo {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly updatedAt: string; // ISO 8601
	/** Which agent produced this session. Defaults to "claude" for backward compatibility. */
	readonly source?: TranscriptSource;
	/**
	 * Native title from the source's own session metadata, if present.
	 * Populated by discoverers that have cheap access to this field (e.g. sqlite columns).
	 * Empty string and missing both mean "no native title" — caller falls back to truncation.
	 */
	readonly title?: string;
}
```

- [ ] **Step 2.2.3: Add a failing test asserting title propagation**

Add a new `it()` block to the existing `cli/src/core/OpenCodeSessionDiscoverer.test.ts` (find the existing describe block; add inside it):

```typescript
it("propagates the title column to SessionInfo.title", async () => {
	// Use the existing test setup that mocks node:sqlite or seeds a temp DB.
	// Insert a row with title = "Refactor session storage layer", then call
	// scanOpenCodeSessions. Assert the returned SessionInfo has the same title.
	// [Engineer: locate the existing fixture builder in this file and pass
	//  title: "Refactor session storage layer" into the row factory. Then:]
	const result = await scanOpenCodeSessions(projectDir);
	expect(result.sessions[0].title).toBe("Refactor session storage layer");
});
```

- [ ] **Step 2.2.4: Update the row-to-SessionInfo mapper**

In `cli/src/core/OpenCodeSessionDiscoverer.ts` (search for where the SELECT result is converted to `SessionInfo`):

```typescript
return {
	sessionId: row.id,
	transcriptPath: /* existing computation */,
	updatedAt: new Date(row.time_updated * 1000).toISOString(),
	source: "opencode" as const,
	title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : undefined,
};
```

- [ ] **Step 2.2.5: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add cli/src/Types.ts cli/src/core/OpenCodeSessionDiscoverer.ts cli/src/core/OpenCodeSessionDiscoverer.test.ts && git commit -s -m "feat(cli): propagate OpenCode session.title through SessionInfo

OpenCode's sqlite session.title column was already in the SELECT
(line 168) but never made it into SessionInfo. Plumbing it through
costs nothing at query time and gives the upcoming Active AI
Conversations panel a native title for OpenCode sessions, no
extra IO required."
```

---

### Task 2.3: Expose Cursor `composerData.name` through SessionInfo

**Files:**
- Read: `cli/src/core/CursorSessionDiscoverer.ts` (the JSON-parse path that yields SessionInfo)
- Modify: `cli/src/core/CursorSessionDiscoverer.ts` (extract `name` from parsed JSON)
- Modify: existing `cli/src/core/CursorSessionDiscoverer.test.ts`

- [ ] **Step 2.3.1: Read the JSON parse code**

Run:
```bash
sed -n '60,180p' /Users/flyer/jolli/code/jollimemory/cli/src/core/CursorSessionDiscoverer.ts
```

Find where the `composerData` JSON value is `JSON.parse`-d and mapped to SessionInfo.

- [ ] **Step 2.3.2: Add failing tests**

Add to `cli/src/core/CursorSessionDiscoverer.test.ts`:

```typescript
it("populates SessionInfo.title from composerData.name when present", async () => {
	// [Engineer: insert into the existing test fixture a composerData JSON
	//  value with name: "Wire up dark mode toggle". Then:]
	const result = await scanCursorSessions(projectDir);
	expect(result.sessions[0].title).toBe("Wire up dark mode toggle");
});

it("leaves SessionInfo.title undefined when composerData.name is missing or empty", async () => {
	// [Engineer: fixture with composerData.name === "" and another fixture
	//  where the key is absent entirely.]
	const result = await scanCursorSessions(projectDir);
	for (const s of result.sessions) {
		expect(s.title).toBeUndefined();
	}
});
```

- [ ] **Step 2.3.3: Update the Cursor mapper**

In `CursorSessionDiscoverer.ts`, wherever the parsed `composerData` JSON is converted to a `SessionInfo` row, add:

```typescript
const nameRaw = typeof composerData?.name === "string" ? composerData.name.trim() : "";
const title = nameRaw.length > 0 ? nameRaw : undefined;

return {
	sessionId: /* existing */,
	transcriptPath: /* existing */,
	updatedAt: /* existing */,
	source: "cursor" as const,
	title,
};
```

- [ ] **Step 2.3.4: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add cli/src/core/CursorSessionDiscoverer.ts cli/src/core/CursorSessionDiscoverer.test.ts && git commit -s -m "feat(cli): propagate Cursor composerData.name as SessionInfo.title

The composerData JSON value in Cursor's globalStorage/state.vscdb
already contains a user-editable 'name' field. We already JSON.parse
this value to extract other metadata — picking up name in the same
pass is free. Empty / missing name leaves title undefined so the
caller can fall back to first-user-message truncation."
```

---

### Task 2.4: Expose Copilot CLI `sessions.summary` through SessionInfo

**Files:**
- Read: `cli/src/core/CopilotSessionDiscoverer.ts:30-100`
- Modify: `cli/src/core/CopilotSessionDiscoverer.ts` (add `summary` to SELECT and propagate)
- Modify: existing `cli/src/core/CopilotSessionDiscoverer.test.ts`

- [ ] **Step 2.4.1: Read the current SELECT**

Run:
```bash
sed -n '30,100p' /Users/flyer/jolli/code/jollimemory/cli/src/core/CopilotSessionDiscoverer.ts
```

Confirm SELECT does **not** currently include `summary`. Locate the SELECT string and the row mapper.

- [ ] **Step 2.4.2: Add failing tests**

Add to `cli/src/core/CopilotSessionDiscoverer.test.ts`:

```typescript
it("propagates the sessions.summary column to SessionInfo.title", async () => {
	// [Engineer: insert a fixture row with summary = "怎么测试copilot integration?". Then:]
	const result = await scanCopilotSessions(projectDir);
	expect(result.sessions[0].title).toBe("怎么测试copilot integration?");
});

it("leaves title undefined when summary is null or empty string", async () => {
	const result = await scanCopilotSessions(projectDir);
	for (const s of result.sessions) {
		expect(s.title).toBeUndefined();
	}
});
```

- [ ] **Step 2.4.3: Update SELECT + mapper**

In `CopilotSessionDiscoverer.ts`, modify the SELECT to include `summary`:

```typescript
const SELECT_SQL = `
	SELECT id, cwd, repository, branch, host_type, summary, created_at, updated_at
	FROM sessions
	WHERE cwd = :cwd
	  AND updated_at >= :cutoff
	ORDER BY updated_at DESC
`;
```

And in the row mapper:

```typescript
return {
	sessionId: row.id,
	transcriptPath: /* existing */,
	updatedAt: /* existing */,
	source: "copilot" as const,
	title: typeof row.summary === "string" && row.summary.trim().length > 0 ? row.summary : undefined,
};
```

- [ ] **Step 2.4.4: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add cli/src/core/CopilotSessionDiscoverer.ts cli/src/core/CopilotSessionDiscoverer.test.ts && git commit -s -m "feat(cli): include sessions.summary in Copilot SELECT and SessionInfo

Copilot CLI auto-generates a per-session summary into sessions.summary.
Adding the column to the existing SELECT costs one extra column read
per row and lets the upcoming Active AI Conversations panel display
a meaningful title without falling back to first-message truncation."
```

---

### Task 2.5: Claude `ai-title` reader

Claude does not have a native title in SessionInfo yet (the existing detector only checks installation; `sessions.json` carries no titles). Reading the title requires scanning the transcript JSONL for the **last** `type: "ai-title"` line.

**Files:**
- Create: `cli/src/core/ClaudeAiTitleReader.ts`
- Create: `cli/src/core/ClaudeAiTitleReader.test.ts`

- [ ] **Step 2.5.1: Write failing tests**

Create `cli/src/core/ClaudeAiTitleReader.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeAiTitle } from "./ClaudeAiTitleReader.js";

describe("readClaudeAiTitle", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claude-aititle-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns undefined when the file does not exist", async () => {
		const result = await readClaudeAiTitle(join(dir, "missing.jsonl"));
		expect(result).toBeUndefined();
	});

	it("returns undefined when no ai-title line is present", async () => {
		const file = join(dir, "no-title.jsonl");
		writeFileSync(file, '{"type":"user","content":"hi"}\n{"type":"assistant","content":"hi"}\n');
		const result = await readClaudeAiTitle(file);
		expect(result).toBeUndefined();
	});

	it("returns the aiTitle from a single ai-title line", async () => {
		const file = join(dir, "single.jsonl");
		writeFileSync(file, '{"type":"ai-title","aiTitle":"Refactor session storage","sessionId":"s1"}\n');
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("Refactor session storage");
	});

	it("returns the LAST ai-title when multiple are present", async () => {
		const file = join(dir, "multi.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"ai-title","aiTitle":"Initial draft","sessionId":"s1"}',
				'{"type":"user","content":"keep going"}',
				'{"type":"ai-title","aiTitle":"Final scope","sessionId":"s1"}',
				"",
			].join("\n"),
		);
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("Final scope");
	});

	it("ignores malformed JSON lines without throwing", async () => {
		const file = join(dir, "malformed.jsonl");
		writeFileSync(
			file,
			[
				"not json",
				'{"type":"ai-title","aiTitle":"Real","sessionId":"s1"}',
				"also not json",
				"",
			].join("\n"),
		);
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("Real");
	});

	it("returns undefined when aiTitle is empty / non-string", async () => {
		const file = join(dir, "empty.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"ai-title","aiTitle":""}',
				'{"type":"ai-title","aiTitle":123}',
				"",
			].join("\n"),
		);
		const result = await readClaudeAiTitle(file);
		expect(result).toBeUndefined();
	});
});
```

- [ ] **Step 2.5.2: Implement the reader**

Create `cli/src/core/ClaudeAiTitleReader.ts`:

```typescript
/**
 * Read Claude Code's native session title from a transcript JSONL.
 *
 * Claude Code re-evaluates the session title continuously and appends a
 * new line of `{ type: "ai-title", aiTitle: "...", sessionId: "..." }`
 * every time. The last such line is the current title.
 *
 * Strategy: forward stream once, remember the most recent `aiTitle`.
 * For multi-MB transcripts this remains acceptable in practice; if
 * profiling later shows it's a bottleneck, reverse-chunk reads are an
 * obvious optimization (out of scope for MVP).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const AI_TITLE_FRAGMENT = '"type":"ai-title"';

export async function readClaudeAiTitle(transcriptPath: string): Promise<string | undefined> {
	let latest: string | undefined;
	try {
		const stream = createReadStream(transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				// Cheap pre-filter: ai-title lines almost always contain this fragment.
				// Avoids JSON.parse on every line.
				if (!line.includes(AI_TITLE_FRAGMENT)) continue;
				try {
					const obj = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
					if (obj.type !== "ai-title") continue;
					if (typeof obj.aiTitle === "string" && obj.aiTitle.length > 0) {
						latest = obj.aiTitle;
					}
				} catch {
					continue;
				}
			}
		} finally {
			rl.close();
			stream.destroy();
		}
	} catch {
		return undefined;
	}
	return latest;
}
```

- [ ] **Step 2.5.3: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add cli/src/core/ClaudeAiTitleReader.ts cli/src/core/ClaudeAiTitleReader.test.ts && git commit -s -m "feat(cli): read Claude's native ai-title from transcript JSONL

Claude Code appends one '{type:\"ai-title\",aiTitle:...}' line every
time it re-evaluates the session title. The last such line is the
current title. We stream forward once and remember the latest;
malformed lines, missing files, and non-string aiTitle values all
yield undefined so the caller can fall back to first-user-message
truncation. A cheap substring pre-filter avoids JSON.parse on every
transcript line."
```

---

### Task 2.6: `SessionTitleResolver` — per-source dispatcher

**Files:**
- Create: `cli/src/core/SessionTitleResolver.ts`
- Create: `cli/src/core/SessionTitleResolver.test.ts`

- [ ] **Step 2.6.1: Write failing tests**

Create `cli/src/core/SessionTitleResolver.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ClaudeAiTitleReader.js", () => ({
	readClaudeAiTitle: vi.fn(),
}));

vi.mock("./FallbackTitle.js", () => ({
	readFirstUserMessageTitle: vi.fn(),
	UNTITLED_SESSION: "(untitled session)",
	TITLE_MAX_CODE_POINTS: 60,
	truncateToCodePoints: (s: string) => s,
}));

import { readClaudeAiTitle } from "./ClaudeAiTitleReader.js";
import { readFirstUserMessageTitle } from "./FallbackTitle.js";
import { resolveSessionTitle } from "./SessionTitleResolver.js";

describe("resolveSessionTitle", () => {
	beforeEach(() => {
		vi.mocked(readClaudeAiTitle).mockReset();
		vi.mocked(readFirstUserMessageTitle).mockReset();
	});

	it("uses SessionInfo.title when present (opencode/cursor/copilot)", async () => {
		for (const source of ["opencode", "cursor", "copilot"] as const) {
			const result = await resolveSessionTitle({
				sessionId: "s1",
				transcriptPath: "/tmp/x",
				updatedAt: "2026-05-15T00:00:00Z",
				source,
				title: "native title here",
			});
			expect(result).toBe("native title here");
		}
		expect(readClaudeAiTitle).not.toHaveBeenCalled();
		expect(readFirstUserMessageTitle).not.toHaveBeenCalled();
	});

	it("for Claude, calls readClaudeAiTitle when SessionInfo has no title", async () => {
		vi.mocked(readClaudeAiTitle).mockResolvedValueOnce("from ai-title");
		const result = await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(result).toBe("from ai-title");
		expect(readClaudeAiTitle).toHaveBeenCalledWith("/tmp/x.jsonl");
	});

	it("falls back to first-user-message when Claude has no ai-title", async () => {
		vi.mocked(readClaudeAiTitle).mockResolvedValueOnce(undefined);
		vi.mocked(readFirstUserMessageTitle).mockResolvedValueOnce("first user msg");
		const result = await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(result).toBe("first user msg");
	});

	it("for codex/gemini/copilot-chat, always falls back to first-user-message", async () => {
		vi.mocked(readFirstUserMessageTitle).mockResolvedValue("truncated msg");
		for (const source of ["codex", "gemini", "copilot-chat"] as const) {
			const result = await resolveSessionTitle({
				sessionId: "s1",
				transcriptPath: "/tmp/x.jsonl",
				updatedAt: "2026-05-15T00:00:00Z",
				source,
			});
			expect(result).toBe("truncated msg");
		}
		expect(readClaudeAiTitle).not.toHaveBeenCalled();
	});

	it("returns UNTITLED_SESSION when all paths fail", async () => {
		vi.mocked(readClaudeAiTitle).mockRejectedValueOnce(new Error("boom"));
		vi.mocked(readFirstUserMessageTitle).mockResolvedValueOnce("(untitled session)");
		const result = await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(result).toBe("(untitled session)");
	});
});
```

- [ ] **Step 2.6.2: Implement the resolver**

Create `cli/src/core/SessionTitleResolver.ts`:

```typescript
/**
 * Resolve the display title for a single session.
 *
 * Priority:
 *   1. SessionInfo.title (already populated by discoverers for opencode/cursor/copilot)
 *   2. Source-specific native reader (currently only Claude's ai-title)
 *   3. First user message truncated to 60 code points
 *   4. "(untitled session)"
 *
 * Per-source parseLine functions live in this file (single source of truth
 * for transcript schemas — keeps the aggregator agnostic).
 */

import type { SessionInfo, TranscriptSource } from "../Types.js";
import { readClaudeAiTitle } from "./ClaudeAiTitleReader.js";
import {
	readFirstUserMessageTitle,
	truncateToCodePoints,
	TITLE_MAX_CODE_POINTS,
	UNTITLED_SESSION,
} from "./FallbackTitle.js";

/** Per-source line parser. Returns the user-message body, or undefined. */
const PARSE_LINE: Record<TranscriptSource, (line: string) => string | undefined> = {
	claude: parseClaudeUserLine,
	codex: parseCodexUserLine,
	gemini: parseGeminiUserLine,
	opencode: parseOpenCodeUserLine,
	cursor: parseCursorUserLine,
	copilot: parseCopilotUserLine,
	"copilot-chat": parseCopilotChatUserLine,
};

export async function resolveSessionTitle(session: SessionInfo): Promise<string> {
	// 1. Pre-populated native title (cheap path for opencode/cursor/copilot).
	if (typeof session.title === "string" && session.title.trim().length > 0) {
		return truncateToCodePoints(session.title, TITLE_MAX_CODE_POINTS);
	}

	const source: TranscriptSource = session.source ?? "claude";

	// 2. Source-specific native reader (Claude only for now).
	if (source === "claude") {
		try {
			const ai = await readClaudeAiTitle(session.transcriptPath);
			if (ai && ai.length > 0) {
				return truncateToCodePoints(ai, TITLE_MAX_CODE_POINTS);
			}
		} catch {
			// fall through to fallback
		}
	}

	// 3. Fallback: first user message, truncated.
	try {
		return await readFirstUserMessageTitle({
			transcriptPath: session.transcriptPath,
			parseLine: PARSE_LINE[source],
		});
	} catch {
		return UNTITLED_SESSION;
	}
}

// --- per-source line parsers ---

function parseClaudeUserLine(line: string): string | undefined {
	const obj = safeParse(line);
	if (!obj) return undefined;
	if (obj.type !== "user") return undefined;
	const message = (obj as { message?: { content?: unknown } }).message;
	const content = message?.content ?? (obj as { content?: unknown }).content;
	return stringifyContent(content);
}

function parseCodexUserLine(line: string): string | undefined {
	const obj = safeParse(line);
	if (!obj) return undefined;
	if (obj.role !== "user") return undefined;
	return stringifyContent((obj as { content?: unknown }).content);
}

function parseGeminiUserLine(line: string): string | undefined {
	const obj = safeParse(line);
	if (!obj) return undefined;
	if (obj.role !== "user") return undefined;
	const text = (obj as { text?: unknown }).text;
	if (typeof text === "string") return text;
	return stringifyContent((obj as { content?: unknown }).content);
}

function parseOpenCodeUserLine(_line: string): string | undefined {
	// OpenCode transcripts are sqlite-backed; this parser is never invoked
	// because OpenCode sessions always carry a SessionInfo.title from the
	// discoverer (Task 2.2). Defined for completeness.
	return undefined;
}

function parseCursorUserLine(_line: string): string | undefined {
	// Same as OpenCode: Cursor sessions carry SessionInfo.title (Task 2.3).
	return undefined;
}

function parseCopilotUserLine(_line: string): string | undefined {
	// Same as OpenCode: Copilot CLI sessions carry SessionInfo.title (Task 2.4).
	return undefined;
}

function parseCopilotChatUserLine(line: string): string | undefined {
	// Copilot Chat transcripts are JSONL patch documents. Heuristic: look
	// for a patch op whose 'value' carries a message body. Engineer:
	// validate against real Copilot Chat data when smoke-testing in Stage 5;
	// adjust if the discoverer's existing reader uses a different shape.
	const obj = safeParse(line);
	if (!obj) return undefined;
	const val = (obj as { value?: unknown }).value;
	if (val && typeof val === "object") {
		const message = (val as { message?: { text?: unknown } }).message;
		if (message && typeof message.text === "string") return message.text;
		const content = (val as { content?: unknown }).content;
		const text = stringifyContent(content);
		if (text) return text;
	}
	return undefined;
}

function safeParse(line: string): Record<string, unknown> | undefined {
	try {
		const v = JSON.parse(line) as unknown;
		return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function stringifyContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (typeof block === "string") parts.push(block);
			else if (block && typeof block === "object") {
				const text = (block as { text?: unknown }).text;
				if (typeof text === "string") parts.push(text);
			}
		}
		return parts.length > 0 ? parts.join(" ") : undefined;
	}
	return undefined;
}
```

- [ ] **Step 2.6.3: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add cli/src/core/SessionTitleResolver.ts cli/src/core/SessionTitleResolver.test.ts && git commit -s -m "feat(cli): add SessionTitleResolver dispatching to native or fallback

Single entry point that decides per-session whether to use the
already-populated SessionInfo.title (opencode/cursor/copilot), read
Claude's ai-title from the JSONL, or stream the first user message
and truncate. Per-source parseLine functions live alongside so the
aggregator doesn't need to know transcript schemas."
```

---

### Task 2.7: `TranscriptMessageCounter` + `ActiveSessionAggregator`

**Files:**
- Create: `cli/src/core/TranscriptMessageCounter.ts`
- Create: `cli/src/core/ActiveSessionAggregator.ts`
- Create: `cli/src/core/ActiveSessionAggregator.test.ts`

- [ ] **Step 2.7.1: Implement the message counter (small helper, no test required for MVP — covered indirectly by aggregator tests)**

Create `cli/src/core/TranscriptMessageCounter.ts`:

```typescript
/**
 * Count user + assistant messages in a transcript file.
 * Stream-reads, never loads the whole file. Returns 0 on any error.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SessionInfo, TranscriptSource } from "../Types.js";

const COUNTED_TYPES: Readonly<Record<TranscriptSource, ReadonlySet<string>>> = {
	claude: new Set(["user", "assistant"]),
	codex: new Set(["user", "assistant"]),
	gemini: new Set(["user", "assistant", "model"]),
	opencode: new Set(["user", "assistant"]),
	cursor: new Set(["user", "assistant"]),
	copilot: new Set(["user", "assistant"]),
	"copilot-chat": new Set(["user", "assistant"]),
};

export async function countTranscriptMessages(s: SessionInfo): Promise<number> {
	const wanted = COUNTED_TYPES[s.source ?? "claude"];
	let n = 0;
	try {
		const stream = createReadStream(s.transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				if (!line) continue;
				try {
					const obj = JSON.parse(line) as { type?: unknown; role?: unknown };
					const tag = typeof obj.type === "string" ? obj.type : typeof obj.role === "string" ? obj.role : undefined;
					if (tag && wanted.has(tag)) n++;
				} catch {
					// skip malformed lines
				}
			}
		} finally {
			rl.close();
			stream.destroy();
		}
		return n;
	} catch {
		return 0;
	}
}
```

- [ ] **Step 2.7.2: Write the aggregator tests (failing)**

Create `cli/src/core/ActiveSessionAggregator.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./CursorSessionDiscoverer.js", () => ({ scanCursorSessions: vi.fn() }));
vi.mock("./CodexSessionDiscoverer.js", () => ({ discoverCodexSessions: vi.fn() }));
vi.mock("./OpenCodeSessionDiscoverer.js", () => ({ scanOpenCodeSessions: vi.fn() }));
vi.mock("./CopilotSessionDiscoverer.js", () => ({ scanCopilotSessions: vi.fn() }));
vi.mock("./CopilotChatSessionDiscoverer.js", () => ({ scanCopilotChatSessions: vi.fn() }));
vi.mock("./SessionTitleResolver.js", () => ({
	resolveSessionTitle: vi.fn().mockImplementation(async (s) => s.title ?? "resolved:" + s.sessionId),
}));
vi.mock("./TranscriptMessageCounter.js", () => ({
	countTranscriptMessages: vi.fn().mockResolvedValue(0),
}));

import { scanCursorSessions } from "./CursorSessionDiscoverer.js";
import { discoverCodexSessions } from "./CodexSessionDiscoverer.js";
import { scanOpenCodeSessions } from "./OpenCodeSessionDiscoverer.js";
import { scanCopilotSessions } from "./CopilotSessionDiscoverer.js";
import { scanCopilotChatSessions } from "./CopilotChatSessionDiscoverer.js";
import { listActiveConversations } from "./ActiveSessionAggregator.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-05-15T12:00:00.000Z").getTime();

function iso(offsetMs: number) {
	return new Date(NOW + offsetMs).toISOString();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	for (const m of [scanCursorSessions, discoverCodexSessions, scanOpenCodeSessions, scanCopilotSessions, scanCopilotChatSessions]) {
		vi.mocked(m as any).mockReset();
		vi.mocked(m as any).mockResolvedValue({ sessions: [] });
	}
	vi.mocked(discoverCodexSessions).mockResolvedValue([]);
});

describe("listActiveConversations", () => {
	it("aggregates multiple sources concurrently", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce({
			sessions: [
				{ sessionId: "c1", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "cursor", title: "Cursor 1" },
			],
		} as any);
		vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce({
			sessions: [
				{ sessionId: "o1", transcriptPath: "/y", updatedAt: iso(-2 * HOUR), source: "opencode", title: "OC 1" },
			],
		} as any);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		const ids = items.map((i) => i.sessionId);
		expect(ids).toContain("c1");
		expect(ids).toContain("o1");
	});

	it("filters sessions older than windowMs", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce({
			sessions: [
				{ sessionId: "fresh", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "cursor" },
				{ sessionId: "old", transcriptPath: "/x", updatedAt: iso(-3 * DAY), source: "cursor" },
			],
		} as any);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["fresh"]);
	});

	it("sorts by updatedAt descending, tie-break by sessionId ascending", async () => {
		const sameTime = iso(-HOUR);
		vi.mocked(scanCursorSessions).mockResolvedValueOnce({
			sessions: [
				{ sessionId: "b", transcriptPath: "/", updatedAt: sameTime, source: "cursor" },
				{ sessionId: "a", transcriptPath: "/", updatedAt: sameTime, source: "cursor" },
				{ sessionId: "c", transcriptPath: "/", updatedAt: iso(-2 * HOUR), source: "cursor" },
			],
		} as any);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["a", "b", "c"]);
	});

	it("continues when one source throws", async () => {
		vi.mocked(scanCursorSessions).mockRejectedValueOnce(new Error("sqlite locked"));
		vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce({
			sessions: [{ sessionId: "ok", transcriptPath: "/", updatedAt: iso(-HOUR), source: "opencode" }],
		} as any);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["ok"]);
	});

	it("resolves titles for every returned item", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce({
			sessions: [{ sessionId: "c1", transcriptPath: "/", updatedAt: iso(-HOUR), source: "cursor", title: "Mine" }],
		} as any);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items[0].title).toBe("Mine");
	});

	it("returns numeric messageCount even when transcript unreadable", async () => {
		vi.mocked(discoverCodexSessions).mockResolvedValueOnce([
			{ sessionId: "x", transcriptPath: "/dev/null", updatedAt: iso(-HOUR), source: "codex" },
		]);
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		for (const i of items) expect(typeof i.messageCount).toBe("number");
	});
});
```

- [ ] **Step 2.7.3: Implement the aggregator**

Create `cli/src/core/ActiveSessionAggregator.ts`:

```typescript
/**
 * Aggregates active AI coding sessions across all 7 supported sources,
 * filters by recency window, resolves display titles, and returns a
 * sorted list ready for UI consumption.
 *
 * - Sessions older than `windowMs` (default 48h) are excluded.
 * - Sources fan out concurrently via Promise.allSettled — one failed
 *   source never blocks the others.
 * - Sort: updatedAt DESC, tie-break by sessionId ASC (stable order).
 * - No cache. No LLM. No background tasks.
 */

import type { SessionInfo, TranscriptSource } from "../Types.js";
import { resolveSessionTitle } from "./SessionTitleResolver.js";
import { countTranscriptMessages } from "./TranscriptMessageCounter.js";

export interface ActiveConversationItem {
	readonly sessionId: string;
	readonly source: TranscriptSource;
	readonly title: string;
	readonly messageCount: number;
	readonly updatedAt: string;
	readonly transcriptPath: string;
}

export interface ListActiveOptions {
	readonly cwd: string;
	readonly windowMs: number;
}

const DEFAULT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 48 hours

export async function listActiveConversations(
	opts: ListActiveOptions,
): Promise<readonly ActiveConversationItem[]> {
	const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
	const cutoff = Date.now() - windowMs;

	const all = await collectFromAllSources(opts.cwd);
	const fresh = all.filter((s) => Date.parse(s.updatedAt) >= cutoff);

	// Dedupe by sessionId, keeping the most-recently-updated entry.
	const byId = new Map<string, SessionInfo>();
	for (const s of fresh) {
		const existing = byId.get(s.sessionId);
		if (!existing || Date.parse(s.updatedAt) > Date.parse(existing.updatedAt)) {
			byId.set(s.sessionId, s);
		}
	}

	const items: ActiveConversationItem[] = await Promise.all(
		[...byId.values()].map(async (s) => ({
			sessionId: s.sessionId,
			source: s.source ?? "claude",
			title: await resolveSessionTitle(s),
			messageCount: await safeCount(s),
			updatedAt: s.updatedAt,
			transcriptPath: s.transcriptPath,
		})),
	);

	items.sort((a, b) => {
		const cmp = b.updatedAt.localeCompare(a.updatedAt);
		return cmp !== 0 ? cmp : a.sessionId.localeCompare(b.sessionId);
	});

	return items;
}

async function safeCount(s: SessionInfo): Promise<number> {
	try {
		return await countTranscriptMessages(s);
	} catch {
		return 0;
	}
}

async function collectFromAllSources(cwd: string): Promise<SessionInfo[]> {
	const results = await Promise.allSettled([
		loadClaudeAndGemini(cwd),
		loadCursor(cwd),
		loadCodex(cwd),
		loadOpenCode(cwd),
		loadCopilot(cwd),
		loadCopilotChat(cwd),
	]);

	const out: SessionInfo[] = [];
	for (const r of results) {
		if (r.status === "fulfilled") out.push(...r.value);
	}
	return out;
}

async function loadClaudeAndGemini(cwd: string): Promise<SessionInfo[]> {
	// Claude (and historically Gemini hook output) share the per-project
	// sessions.json registry written by StopHook / GeminiAfterAgentHook.
	// Engineer: search the codebase for the helper that reads this file
	// (try grep -r "sessions.json" cli/src/core | head). Replace the
	// require below with that helper's import. MVP fallback: return [].
	try {
		const mod = (await import("./SessionRegistry.js")) as {
			loadSessions?: (cwd: string) => Promise<SessionInfo[]>;
		};
		if (typeof mod.loadSessions === "function") return await mod.loadSessions(cwd);
	} catch {
		// SessionRegistry.ts may not exist — fall through.
	}
	return [];
}

async function loadCursor(cwd: string): Promise<SessionInfo[]> {
	try {
		const { scanCursorSessions } = await import("./CursorSessionDiscoverer.js");
		const r = await scanCursorSessions(cwd);
		return r.sessions;
	} catch {
		return [];
	}
}

async function loadCodex(cwd: string): Promise<SessionInfo[]> {
	try {
		const { discoverCodexSessions } = await import("./CodexSessionDiscoverer.js");
		return await discoverCodexSessions(cwd);
	} catch {
		return [];
	}
}

async function loadOpenCode(cwd: string): Promise<SessionInfo[]> {
	try {
		const { scanOpenCodeSessions } = await import("./OpenCodeSessionDiscoverer.js");
		const r = await scanOpenCodeSessions(cwd);
		return r.sessions;
	} catch {
		return [];
	}
}

async function loadCopilot(cwd: string): Promise<SessionInfo[]> {
	try {
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const r = await scanCopilotSessions(cwd);
		return r.sessions;
	} catch {
		return [];
	}
}

async function loadCopilotChat(cwd: string): Promise<SessionInfo[]> {
	try {
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const r = await scanCopilotChatSessions(cwd);
		return r.sessions;
	} catch {
		return [];
	}
}
```

- [ ] **Step 2.7.4: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add cli/src/core/TranscriptMessageCounter.ts cli/src/core/ActiveSessionAggregator.ts cli/src/core/ActiveSessionAggregator.test.ts && git commit -s -m "feat(cli): add ActiveSessionAggregator fanning out to 7 sources

Concurrent Promise.allSettled fan-out across the existing
discoverers + sessions.json registry. Filters by recency window,
dedupes by sessionId (keep newest), resolves title via
SessionTitleResolver, counts messages via TranscriptMessageCounter,
sorts updatedAt DESC with sessionId tiebreak. One failed source
never blocks the others. No cache, no LLM, no background tasks."
```

---

## Stage 3: Webview Protocol + Sidebar UI

Spec §13 PR-3. Wire the aggregator to the sidebar, render the CONVERSATIONS section, hook into existing refresh.

### Task 3.1: Extend `SidebarMessages` protocol

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts`

- [ ] **Step 3.1.1: Read the current shape**

Run:
```bash
sed -n '1,150p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SidebarMessages.ts
```

Identify the `SidebarInboundMsg` and `SidebarOutboundMsg` union types. Note how existing `branch:plansData` and similar entries are declared.

- [ ] **Step 3.1.2: Add the two new message variants**

In `vscode/src/views/SidebarMessages.ts`, find the inbound union (it lists `branch:plansData`, `branch:changesData`, etc.) and append:

```typescript
| {
	readonly type: "branch:conversationsData";
	readonly items: readonly ActiveConversationItem[];
}
```

Find the outbound union (it lists `branch:openSummary` or similar) and append:

```typescript
| {
	readonly type: "branch:openConversation";
	readonly sessionId: string;
	readonly source: TranscriptSource;
	readonly transcriptPath: string;
}
```

Add the necessary imports at the top of the file:

```typescript
import type { ActiveConversationItem } from "../../../cli/src/core/ActiveSessionAggregator.js";
import type { TranscriptSource } from "../../../cli/src/Types.js";
```

- [ ] **Step 3.1.3: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add vscode/src/views/SidebarMessages.ts && git commit -s -m "feat(vscode): add CONVERSATIONS section messages to Sidebar protocol

Inbound branch:conversationsData carries the items rendered in the
new CONVERSATIONS section. Outbound branch:openConversation is sent
when the user clicks a row, triggering the extension to open a
dedicated ConversationDetailsPanel."
```

---

### Task 3.2: `ActiveSessionsProvider` VS Code wrapper

**Files:**
- Create: `vscode/src/services/ActiveSessionsProvider.ts`
- Create: `vscode/src/services/ActiveSessionsProvider.test.ts`

- [ ] **Step 3.2.1: Write the failing tests**

Create `vscode/src/services/ActiveSessionsProvider.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../cli/src/core/ActiveSessionAggregator.js", () => ({
	listActiveConversations: vi.fn(),
}));

import { listActiveConversations } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { ActiveSessionsProvider } from "./ActiveSessionsProvider.js";

describe("ActiveSessionsProvider", () => {
	it("returns aggregator output verbatim", async () => {
		const items = [
			{
				sessionId: "x",
				source: "claude" as const,
				title: "T",
				messageCount: 1,
				updatedAt: "2026-05-15T00:00:00Z",
				transcriptPath: "/x",
			},
		];
		vi.mocked(listActiveConversations).mockResolvedValueOnce(items);

		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		const result = await p.list();
		expect(result).toEqual(items);
		expect(listActiveConversations).toHaveBeenCalledWith({
			cwd: "/proj",
			windowMs: 2 * 24 * 60 * 60 * 1000,
		});
	});

	it("returns an empty list when there is no workspace", async () => {
		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => undefined });
		const result = await p.list();
		expect(result).toEqual([]);
		expect(listActiveConversations).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 3.2.2: Implement the provider**

Create `vscode/src/services/ActiveSessionsProvider.ts`:

```typescript
import type { ActiveConversationItem } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { listActiveConversations } from "../../../cli/src/core/ActiveSessionAggregator.js";

export interface ActiveSessionsDeps {
	/** Returns the absolute path of the current workspace root, or undefined. */
	readonly getWorkspaceCwd: () => string | undefined;
}

const WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 48h, per spec §3

/**
 * Thin VS Code-side wrapper around the CLI aggregator. Exists so
 * SidebarWebviewProvider has a single typed dependency to mock in
 * tests and a single seam to swap implementations.
 */
export class ActiveSessionsProvider {
	constructor(private readonly deps: ActiveSessionsDeps) {}

	async list(): Promise<readonly ActiveConversationItem[]> {
		const cwd = this.deps.getWorkspaceCwd();
		if (!cwd) return [];
		try {
			return await listActiveConversations({ cwd, windowMs: WINDOW_MS });
		} catch {
			return [];
		}
	}
}
```

- [ ] **Step 3.2.3: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add vscode/src/services/ActiveSessionsProvider.ts vscode/src/services/ActiveSessionsProvider.test.ts && git commit -s -m "feat(vscode): add ActiveSessionsProvider wrapping CLI aggregator

Single seam for SidebarWebviewProvider to depend on. Window is fixed
at 48h per spec §3. Returns empty list when no workspace is open,
swallows aggregator errors (worst case: empty CONVERSATIONS section)."
```

---

### Task 3.3: Wire provider + pushConversations + refresh fan-out

**Files:**
- Read: `vscode/src/views/SidebarWebviewProvider.ts:1-300`
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` (inject, push, refresh)
- Modify: `vscode/src/extension.ts` (pass the new provider)

- [ ] **Step 3.3.1: Read the dependency-injection surface**

Run:
```bash
sed -n '1,100p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SidebarWebviewProvider.ts
sed -n '195,290p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SidebarWebviewProvider.ts
sed -n '395,420p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SidebarWebviewProvider.ts
```

Confirm:
- The `SidebarWebviewDeps` interface — where `plansProvider` is declared.
- The `handleReady()` location — where `pushPlans()` is called.
- The `handleRefresh()` location — where `case "refresh"` lives.

- [ ] **Step 3.3.2: Add `activeSessionsProvider` to the deps interface**

In `vscode/src/views/SidebarWebviewProvider.ts`, modify `SidebarWebviewDeps`:

```typescript
import type { ActiveSessionsProvider } from "../services/ActiveSessionsProvider.js";

export interface SidebarWebviewDeps {
	// ... existing fields ...
	readonly activeSessionsProvider?: ActiveSessionsProvider;
}
```

- [ ] **Step 3.3.3: Add the `pushConversations()` method**

Model after `pushPlans()`:

```typescript
private async pushConversations(): Promise<void> {
	if (!this.deps.activeSessionsProvider) return;
	try {
		const items = await this.deps.activeSessionsProvider.list();
		this.postMessage({ type: "branch:conversationsData", items });
	} catch {
		// Already swallowed inside the provider; double-guard.
		this.postMessage({ type: "branch:conversationsData", items: [] });
	}
}
```

- [ ] **Step 3.3.4: Call from `handleReady()` and from `handleRefresh()`**

In `handleReady()`, after `this.pushPlans();` (or equivalent existing pushes):

```typescript
void this.pushConversations();
```

In `handleRefresh()`, find the `branch` scope branch (where `pushPlans()` etc. are called) and append:

```typescript
void this.pushConversations();
```

- [ ] **Step 3.3.5: Wire the dependency at construction**

Search for where `SidebarWebviewProvider` is constructed:

```bash
grep -rn "new SidebarWebviewProvider" /Users/flyer/jolli/code/jollimemory/vscode/src/ | head
```

Likely `vscode/src/extension.ts`. Add:

```typescript
import { ActiveSessionsProvider } from "./services/ActiveSessionsProvider.js";

// ... inside activate(), when constructing the sidebar provider ...
const activeSessionsProvider = new ActiveSessionsProvider({
	getWorkspaceCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
});

const sidebar = new SidebarWebviewProvider({
	// ... existing deps ...
	activeSessionsProvider,
});
```

- [ ] **Step 3.3.6: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add vscode/src/views/SidebarWebviewProvider.ts vscode/src/extension.ts && git commit -s -m "feat(vscode): wire ActiveSessionsProvider into SidebarWebviewProvider

Pushes branch:conversationsData on handleReady() and on every
handleRefresh() for the 'branch' scope — the latter is the only
update path for the 5 no-hook sources (Codex/OpenCode/Cursor/
Copilot CLI/Copilot Chat). Provider is optional in deps so the
sidebar still constructs in tests that don't care about
conversations."
```

---

### Task 3.4: Render CONVERSATIONS section in webview

**Files:**
- Read: `vscode/src/views/SidebarScriptBuilder.ts:1960-2200`
- Read: `vscode/src/views/SidebarScriptBuilder.ts:770-790`
- Modify: `vscode/src/views/SidebarScriptBuilder.ts`
- Modify: `vscode/src/views/SidebarCssBuilder.ts`

- [ ] **Step 3.4.1: Read the section assembly site**

Run:
```bash
sed -n '1960,2080p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SidebarScriptBuilder.ts
sed -n '2150,2210p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SidebarScriptBuilder.ts
sed -n '770,795p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SidebarScriptBuilder.ts
```

Note: `branchData` is the global state object holding cached arrays per section.

- [ ] **Step 3.4.2: Extend the in-page `branchData` cache**

In the JS string body of `SidebarScriptBuilder.ts`, find the `branchData` initial declaration (near the top of the client script) and add `conversations: []`:

```javascript
const branchData = {
	plans: [],
	changes: [],
	commits: [],
	conversations: [],  // NEW
};
```

- [ ] **Step 3.4.3: Add the inbound message handler**

Find the `case 'branch:plansData':` branch (around line 771-783) and add a sibling case after it:

```javascript
case 'branch:conversationsData':
	branchData.conversations = msg.items.slice();
	if (state.activeTab === 'branch') renderBranch();
	break;
```

- [ ] **Step 3.4.4: Push the conversations section in `renderBranch()`**

Find where sections are pushed in `renderBranch()` (around line 1970-1990). Insert the new section **before** the `plans` push, and only when not in foreign mode:

```javascript
if (!foreign) {
	sections.push({
		id: 'conversations',
		title: 'CONVERSATIONS',
		items: branchData.conversations,
		emptyText: 'No active AI conversations in the last 2 days.',
	});
	sections.push({ id: 'plans', /* existing... */ });
	sections.push({ id: 'changes', /* existing... */ });
}
sections.push({ id: 'commits', /* existing... */ });
```

- [ ] **Step 3.4.5: Wire `renderConversationRow` into `renderSection`'s dispatch**

Find the row-renderer dispatch in `renderSection()` (around line 2030-2050) — it likely looks like `const rowFn = s.id === 'plans' ? renderPlanRow : ...`. Add a branch:

```javascript
const rowFn = s.id === 'plans' ? renderPlanRow
	: s.id === 'conversations' ? renderConversationRow
	: /* ...existing fallthrough... */;
```

- [ ] **Step 3.4.6: Implement `renderConversationRow`**

Add after `renderPlanRow` (around line 2200):

```javascript
function renderConversationRow(item) {
	const root = el('div', {
		className: 'tree-node conversation-row',
		'data-session-id': item.sessionId,
		'data-source': item.source,
	}, [
		el('span', { className: 'icon' }, [el('i', { className: 'codicon codicon-comment-discussion' })]),
		el('span', { className: 'label', text: item.title }),
		el('span', { className: 'badge transcript-source-' + item.source, text: providerLabel(item.source) }),
		el('span', { className: 'count', text: String(item.messageCount) }),
		el('span', { className: 'time', text: formatRelativeTime(item.updatedAt) }),
	]);

	root.addEventListener('click', () => {
		vscode.postMessage({
			type: 'branch:openConversation',
			sessionId: item.sessionId,
			source: item.source,
			transcriptPath: item.transcriptPath,
		});
	});

	return root;
}

function providerLabel(source) {
	switch (source) {
		case 'claude': return 'Claude';
		case 'cursor': return 'Cursor';
		case 'codex': return 'Codex';
		case 'gemini': return 'Gemini';
		case 'opencode': return 'OpenCode';
		case 'copilot': return 'Copilot';
		case 'copilot-chat': return 'Copilot Chat';
		default: return source;
	}
}
```

(If `formatRelativeTime` is not in scope, search for it in `SummaryScriptBuilder.ts` — if it lives there and not at module scope, duplicate the one-liner; spec §2.2 calls duplicating a tiny formatter acceptable.)

- [ ] **Step 3.4.7: Style the row**

Find the section CSS builder (likely `vscode/src/views/SidebarCssBuilder.ts`). Add:

```css
.conversation-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 8px;
}
.conversation-row .label {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.conversation-row .badge {
	font-size: 11px;
	padding: 1px 6px;
	border-radius: 4px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
}
.conversation-row .count,
.conversation-row .time {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
}
```

Reuse existing `.transcript-source-claude` / `.transcript-source-cursor` / etc. classes for per-provider badge color — they already exist for the summary modal.

- [ ] **Step 3.4.8: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarCssBuilder.ts && git commit -s -m "feat(vscode): render CONVERSATIONS section in Branch tab

Inserts the new section above PLANS & NOTES, with a comment-bubble
icon, provider badge (reusing existing transcript-source-* CSS
classes from the summary modal), message count, and relative time.
Hidden in foreign-mode views. Click posts branch:openConversation
to the extension. Section header carries no buttons — refresh
piggybacks on the Branch tab's existing toolbar Refresh button."
```

---

## Stage 4: `ConversationDetailsPanel`

Spec §13 PR-4. New webview panel reusing `TranscriptEntryRenderer` from Stage 1.

### Task 4.1: Panel singleton skeleton

**Files:**
- Read: `vscode/src/views/SettingsWebviewPanel.ts` (structural reference)
- Create: `vscode/src/views/ConversationDetailsPanel.ts`
- Create: `vscode/src/views/ConversationDetailsHtmlBuilder.ts` (stub for this task)
- Create: `vscode/src/views/ConversationDetailsPanel.test.ts`

- [ ] **Step 4.1.1: Read `SettingsWebviewPanel.ts` as the structural reference**

Run:
```bash
sed -n '1,180p' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SettingsWebviewPanel.ts
```

Note: static `currentPanel`, constructor signature, `show()` factory, dispose, message handling.

- [ ] **Step 4.1.2: Write the failing tests**

Create `vscode/src/views/ConversationDetailsPanel.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
	const panels: any[] = [];
	const createWebviewPanel = vi.fn(() => {
		const p = {
			webview: {
				html: "",
				onDidReceiveMessage: vi.fn(),
				postMessage: vi.fn(),
			},
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			dispose: vi.fn(() => {
				p.disposed = true;
			}),
			disposed: false,
		};
		panels.push(p);
		return p;
	});
	return {
		ViewColumn: { Active: 1, One: 1 },
		window: { createWebviewPanel },
		Uri: { file: (p: string) => ({ fsPath: p }) },
		__panels: panels,
		__createWebviewPanel: createWebviewPanel,
	};
});

import * as vscode from "vscode";
import { ConversationDetailsPanel } from "./ConversationDetailsPanel.js";

describe("ConversationDetailsPanel", () => {
	beforeEach(() => {
		(vscode as any).__panels.length = 0;
		ConversationDetailsPanel.disposeAll();
	});

	it("opens a new panel for an unseen sessionId", () => {
		ConversationDetailsPanel.show({
			extensionUri: vscode.Uri.file("/ext"),
			sessionId: "s1",
			source: "claude",
			transcriptPath: "/tmp/s1.jsonl",
		});
		expect((vscode as any).__createWebviewPanel).toHaveBeenCalledTimes(1);
	});

	it("reveals (does not recreate) for the same sessionId", () => {
		const args = {
			extensionUri: vscode.Uri.file("/ext"),
			sessionId: "s1",
			source: "claude" as const,
			transcriptPath: "/tmp/s1.jsonl",
		};
		ConversationDetailsPanel.show(args);
		ConversationDetailsPanel.show(args);
		expect((vscode as any).__createWebviewPanel).toHaveBeenCalledTimes(1);
		expect((vscode as any).__panels[0].reveal).toHaveBeenCalledTimes(1);
	});

	it("opens distinct panels for different sessionIds", () => {
		ConversationDetailsPanel.show({
			extensionUri: vscode.Uri.file("/ext"),
			sessionId: "s1",
			source: "claude",
			transcriptPath: "/a",
		});
		ConversationDetailsPanel.show({
			extensionUri: vscode.Uri.file("/ext"),
			sessionId: "s2",
			source: "claude",
			transcriptPath: "/b",
		});
		expect((vscode as any).__createWebviewPanel).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 4.1.3: Implement the panel + stub HtmlBuilder**

Create `vscode/src/views/ConversationDetailsHtmlBuilder.ts` (stub — replaced in Task 4.2):

```typescript
export interface BuildHtmlOptions {
	readonly nonce: string;
	readonly sessionId: string;
	readonly source: string;
	readonly transcriptPath: string;
}

export function buildConversationDetailsHtml(_opts: BuildHtmlOptions): string {
	// Stub — see Task 4.2 for the real implementation.
	return "<html><body><p>Loading conversation…</p></body></html>";
}
```

Create `vscode/src/views/ConversationDetailsPanel.ts`:

```typescript
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { TranscriptSource } from "../../../cli/src/Types.js";
import { buildConversationDetailsHtml } from "./ConversationDetailsHtmlBuilder.js";

export interface ShowOptions {
	readonly extensionUri: vscode.Uri;
	readonly sessionId: string;
	readonly source: TranscriptSource;
	readonly transcriptPath: string;
}

export class ConversationDetailsPanel {
	private static readonly panels = new Map<string, ConversationDetailsPanel>();
	private readonly panel: vscode.WebviewPanel;
	private readonly sessionId: string;

	private constructor(opts: ShowOptions) {
		this.sessionId = opts.sessionId;
		this.panel = vscode.window.createWebviewPanel(
			"jollimemory.conversationDetails",
			"Conversation: " + opts.sessionId.slice(0, 8),
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [opts.extensionUri],
				retainContextWhenHidden: true,
			},
		);
		const nonce = randomBytes(16).toString("hex");
		this.panel.webview.html = buildConversationDetailsHtml({
			nonce,
			sessionId: opts.sessionId,
			source: opts.source,
			transcriptPath: opts.transcriptPath,
		});
		this.panel.onDidDispose(() => {
			ConversationDetailsPanel.panels.delete(this.sessionId);
		});
	}

	static show(opts: ShowOptions): void {
		const existing = ConversationDetailsPanel.panels.get(opts.sessionId);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		const created = new ConversationDetailsPanel(opts);
		ConversationDetailsPanel.panels.set(opts.sessionId, created);
	}

	static disposeAll(): void {
		for (const p of ConversationDetailsPanel.panels.values()) {
			p.panel.dispose();
		}
		ConversationDetailsPanel.panels.clear();
	}
}
```

- [ ] **Step 4.1.4: Commit (skeleton only — body lands in next task)**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add vscode/src/views/ConversationDetailsPanel.ts vscode/src/views/ConversationDetailsPanel.test.ts vscode/src/views/ConversationDetailsHtmlBuilder.ts && git commit -s -m "feat(vscode): add ConversationDetailsPanel singleton skeleton

createWebviewPanel-based panel keyed by sessionId. show() reveals
the existing instance or creates a new one; disposeAll() is a
test-only convenience. HTML body is a stub — Task 4.2 replaces it
with the real implementation that streams the full transcript via
the shared TranscriptEntryRenderer."
```

---

### Task 4.2: Real HTML + Script + transcript loading

**Files:**
- Modify: `vscode/src/views/ConversationDetailsHtmlBuilder.ts`
- Create: `vscode/src/views/ConversationDetailsScriptBuilder.ts`
- Modify: `vscode/src/views/ConversationDetailsPanel.ts` (add `onDidReceiveMessage`)
- Create: `cli/src/core/TranscriptLoader.ts`
- Create: `cli/src/core/TranscriptLoader.test.ts`

- [ ] **Step 4.2.1: Write the TranscriptLoader test**

Create `cli/src/core/TranscriptLoader.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTranscript } from "./TranscriptLoader.js";

describe("loadTranscript", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "transcript-loader-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loads claude JSONL into TranscriptEntry array (user/assistant)", async () => {
		const file = join(dir, "claude.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"user","message":{"content":"hi"}}',
				'{"type":"assistant","message":{"content":"hello"}}',
				'{"type":"ai-title","aiTitle":"chat"}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("human");
		expect(result[0].content).toBe("hi");
		expect(result[1].role).toBe("assistant");
	});

	it("returns empty array when the file is missing", async () => {
		const result = await loadTranscript({ source: "claude", transcriptPath: join(dir, "missing.jsonl") });
		expect(result).toEqual([]);
	});

	it("skips malformed lines", async () => {
		const file = join(dir, "bad.jsonl");
		writeFileSync(file, 'not json\n{"type":"user","message":{"content":"x"}}\n');
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result).toHaveLength(1);
	});
});
```

- [ ] **Step 4.2.2: Implement `TranscriptLoader`**

Create `cli/src/core/TranscriptLoader.ts`:

```typescript
/**
 * Stream-load a transcript into an array of TranscriptEntry objects.
 * Dispatches to per-source parsers. Returns [] on any IO error.
 *
 * Only used by ConversationDetailsPanel — the aggregator never loads
 * the full transcript.
 *
 * TODO (out of MVP): sqlite-backed sources (opencode/cursor/copilot)
 * need separate readers that query their session tables; for MVP the
 * panel for those sources will render an empty body.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { TranscriptEntry, TranscriptSource } from "../Types.js";

export interface LoadOptions {
	readonly source: TranscriptSource;
	readonly transcriptPath: string;
}

export async function loadTranscript(opts: LoadOptions): Promise<TranscriptEntry[]> {
	const entries: TranscriptEntry[] = [];
	try {
		const stream = createReadStream(opts.transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		const parse = PARSERS[opts.source];
		try {
			for await (const line of rl) {
				if (!line) continue;
				try {
					const entry = parse(line);
					if (entry) entries.push(entry);
				} catch {
					// skip
				}
			}
		} finally {
			rl.close();
			stream.destroy();
		}
		return entries;
	} catch {
		return [];
	}
}

const PARSERS: Record<TranscriptSource, (line: string) => TranscriptEntry | undefined> = {
	claude: parseClaude,
	codex: parseCodex,
	gemini: parseGemini,
	opencode: parseOpenCode,
	cursor: parseCursor,
	copilot: parseCopilot,
	"copilot-chat": parseCopilotChat,
};

function parseClaude(line: string): TranscriptEntry | undefined {
	const obj = JSON.parse(line) as { type?: string; message?: { content?: unknown }; timestamp?: string };
	if (obj.type !== "user" && obj.type !== "assistant") return undefined;
	const content = stringify(obj.message?.content);
	if (!content) return undefined;
	return {
		role: obj.type === "user" ? "human" : "assistant",
		content,
		timestamp: obj.timestamp,
	};
}

function parseCodex(line: string): TranscriptEntry | undefined {
	const obj = JSON.parse(line) as { role?: string; content?: unknown; timestamp?: string };
	if (obj.role !== "user" && obj.role !== "assistant") return undefined;
	const content = stringify(obj.content);
	if (!content) return undefined;
	return { role: obj.role === "user" ? "human" : "assistant", content, timestamp: obj.timestamp };
}

function parseGemini(line: string): TranscriptEntry | undefined {
	const obj = JSON.parse(line) as { role?: string; text?: unknown; timestamp?: string };
	if (obj.role !== "user" && obj.role !== "model") return undefined;
	const content = typeof obj.text === "string" ? obj.text : undefined;
	if (!content) return undefined;
	return { role: obj.role === "user" ? "human" : "assistant", content, timestamp: obj.timestamp };
}

function parseOpenCode(_line: string): TranscriptEntry | undefined {
	// TODO: sqlite-backed; out of MVP scope.
	return undefined;
}

function parseCursor(_line: string): TranscriptEntry | undefined {
	// TODO: sqlite-backed; out of MVP scope.
	return undefined;
}

function parseCopilot(_line: string): TranscriptEntry | undefined {
	// TODO: sqlite-backed; out of MVP scope.
	return undefined;
}

function parseCopilotChat(line: string): TranscriptEntry | undefined {
	const obj = JSON.parse(line) as { value?: { message?: { text?: unknown; role?: unknown } } };
	const m = obj.value?.message;
	if (!m || typeof m.text !== "string") return undefined;
	const role = m.role === "user" ? "human" : m.role === "assistant" ? "assistant" : undefined;
	if (!role) return undefined;
	return { role, content: m.text };
}

function stringify(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (typeof block === "string") parts.push(block);
			else if (block && typeof block === "object") {
				const t = (block as { text?: unknown }).text;
				if (typeof t === "string") parts.push(t);
			}
		}
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	return undefined;
}
```

- [ ] **Step 4.2.3: Replace the HtmlBuilder stub with the real body**

Modify `vscode/src/views/ConversationDetailsHtmlBuilder.ts`:

```typescript
import { buildConversationDetailsScript } from "./ConversationDetailsScriptBuilder.js";

export interface BuildHtmlOptions {
	readonly nonce: string;
	readonly sessionId: string;
	readonly source: string;
	readonly transcriptPath: string;
}

export function buildConversationDetailsHtml(opts: BuildHtmlOptions): string {
	const csp = [
		"default-src 'none'",
		"img-src 'self' data:",
		"style-src 'unsafe-inline'", // engineer: tighten to nonce once base styles are extracted
		"script-src 'nonce-" + opts.nonce + "'",
	].join("; ");

	const initJson = JSON.stringify({
		sessionId: opts.sessionId,
		source: opts.source,
		transcriptPath: opts.transcriptPath,
	});

	return [
		"<!DOCTYPE html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="UTF-8">',
		'<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
		"<style>",
		"body { font-family: var(--vscode-font-family); padding: 16px; }",
		".header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }",
		".badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }",
		".transcript-entry { margin-bottom: 12px; }",
		".transcript-entry[data-role=human] { color: var(--vscode-foreground); }",
		".transcript-entry[data-role=assistant] { color: var(--vscode-descriptionForeground); }",
		"</style>",
		"</head>",
		"<body>",
		'<div class="header">',
		'<span class="title" id="title">Loading…</span>',
		'<span class="badge" id="badge"></span>',
		"</div>",
		'<div id="entries"></div>',
		'<script nonce="' + opts.nonce + '">',
		"const INIT = " + initJson + ";",
		buildConversationDetailsScript(),
		"</script>",
		"</body>",
		"</html>",
	].join("\n");
}
```

- [ ] **Step 4.2.4: Implement the ScriptBuilder**

Create `vscode/src/views/ConversationDetailsScriptBuilder.ts`:

```typescript
import { buildTranscriptEntriesScript } from "./TranscriptEntryRenderer.js";

export function buildConversationDetailsScript(): string {
	return [
		"const vscode = acquireVsCodeApi();",
		"",
		buildTranscriptEntriesScript(),
		"",
		// init
		"document.getElementById('title').textContent = 'Conversation ' + INIT.sessionId.slice(0, 8);",
		"document.getElementById('badge').textContent = INIT.source;",
		"vscode.postMessage({ type: 'requestTranscript', sessionId: INIT.sessionId, source: INIT.source, transcriptPath: INIT.transcriptPath });",
		"",
		// message handling
		"window.addEventListener('message', function(event) {",
		"  const msg = event.data;",
		"  if (msg && msg.type === 'transcriptLoaded') {",
		"    renderTranscriptEntries(document.getElementById('entries'), msg.entries);",
		"  }",
		"});",
	].join("\n");
}
```

- [ ] **Step 4.2.5: Wire `onDidReceiveMessage` in the panel**

Modify `vscode/src/views/ConversationDetailsPanel.ts`. Add the following just after the `onDidDispose` hookup in the constructor:

```typescript
this.panel.webview.onDidReceiveMessage(async (raw) => {
	if (raw && raw.type === "requestTranscript") {
		const { loadTranscript } = await import("../../../cli/src/core/TranscriptLoader.js");
		const entries = await loadTranscript({
			source: raw.source,
			transcriptPath: raw.transcriptPath,
		});
		this.panel.webview.postMessage({ type: "transcriptLoaded", entries });
	}
});
```

- [ ] **Step 4.2.6: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add cli/src/core/TranscriptLoader.ts cli/src/core/TranscriptLoader.test.ts vscode/src/views/ConversationDetailsHtmlBuilder.ts vscode/src/views/ConversationDetailsScriptBuilder.ts vscode/src/views/ConversationDetailsPanel.ts && git commit -s -m "feat: load and render transcripts in ConversationDetailsPanel

CLI-side TranscriptLoader dispatches to per-source JSONL parsers
for Claude/Codex/Gemini/Copilot Chat; sqlite-backed sources are
TODO (panel will render an empty body for those — list rows still
show correct titles from SessionInfo.title). ScriptBuilder reuses
the shared TranscriptEntryRenderer extracted in Stage 1. HTML is
CSP-strict with a nonce; the panel's onDidReceiveMessage handles
the requestTranscript -> transcriptLoaded round-trip."
```

---

### Task 4.3: Route `branch:openConversation` to the panel

**Files:**
- Modify: `vscode/src/views/SidebarWebviewProvider.ts`

- [ ] **Step 4.3.1: Find the existing outbound message dispatcher**

Run:
```bash
grep -n 'openSummary\|onDidReceiveMessage\|case "branch:' /Users/flyer/jolli/code/jollimemory/vscode/src/views/SidebarWebviewProvider.ts | head -20
```

Locate the switch / dispatch over inbound (from webview's PoV; outbound from webview = inbound to extension) message types.

- [ ] **Step 4.3.2: Add a case for `branch:openConversation`**

In the message dispatcher in `SidebarWebviewProvider.ts`, add:

```typescript
case "branch:openConversation": {
	const { ConversationDetailsPanel } = await import("./ConversationDetailsPanel.js");
	ConversationDetailsPanel.show({
		extensionUri: this.extensionUri,
		sessionId: msg.sessionId,
		source: msg.source,
		transcriptPath: msg.transcriptPath,
	});
	return;
}
```

(If `this.extensionUri` isn't already on the provider, plumb it through `SidebarWebviewDeps` the same way other panel paths receive it. Search for `extensionUri` in the file to see if it's already a member.)

- [ ] **Step 4.3.3: Commit**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add vscode/src/views/SidebarWebviewProvider.ts && git commit -s -m "feat(vscode): open ConversationDetailsPanel on row click

Wires the branch:openConversation outbound message from the
CONVERSATIONS section to the panel's show() factory. Same sessionId
reveals the existing panel; new sessionId opens a fresh one."
```

---

## Stage 5: End-to-End Verification + Docs

Spec §13 PR-5.

### Task 5.1: Final code review with code-reviewer subagent

This is the **only** review pass in the whole plan. Tasks 1.1 through 4.3 produce code without running test/typecheck/build/lint, by design — those all run once here, plus a structured code review.

**Files:** review-only (no edits in this step; fixes land in a follow-up commit if needed).

- [ ] **Step 5.1.1: Dispatch the code-reviewer subagent over the branch diff**

Spawn `pr-review-toolkit:code-reviewer` (or whichever review agent the repo prefers) against the full diff of `feature/active-conversations` vs `main`. Brief it to focus on:

- Adherence to CLAUDE.md: DCO `Signed-off-by:` on every commit, no Claude co-author / robot footer, tabs / 120-column.
- Cross-package import paths in `vscode/src/**` resolving to `../../../cli/src/core/*.js` (esbuild bundle-time imports — should not be rewritten).
- Silent failures: every empty `catch {}` block in the new files should be deliberate fail-open behavior, with the reason either in a code comment or in the commit message. Flag any that look like swallowed bugs.
- `noExplicitAny` is a project-wide error level. Review `as any` casts in test files for whether they can be tightened (test files allow it but minimizing helps maintainability).
- New files under `cli/src/`: every one should have a co-located `*.test.ts`. Coverage thresholds (97/96/97/97) will be verified in Step 5.2.1 below; the agent should flag any new file that lacks tests so we fix it before the gate runs.

- [ ] **Step 5.1.2: Address review findings, then commit fixes**

Apply non-trivial findings as additional commits on this branch (do NOT amend existing per-task commits — project policy is new commits, never amend). Batch trivial nits (typos, alignment) into a single follow-up.

```bash
git add -p && git commit -s -m "fix: address code review findings

[summarize the substantive fixes]"
```

If the review finds nothing actionable, skip this step.

---

### Task 5.2: Run the full chain end-to-end manually

**Files:**
- Update: `vscode/CHANGELOG.md`

- [ ] **Step 5.2.1: Run the full quality gate**

Run:
```bash
cd /Users/flyer/jolli/code/jollimemory && npm run all
```

Expected: clean → build → lint → test all green. CLI coverage thresholds (97/96/97/97) maintained.

- [ ] **Step 5.2.2: Install the VSIX in a real VS Code window**

Run:
```bash
cd /Users/flyer/jolli/code/jollimemory/vscode && npm run deploy
```

Then in VS Code: **Developer: Reload Window**.

- [ ] **Step 5.2.3: Smoke test each source**

For each of the 7 sources, produce or already have an active session and verify the row appears in CONVERSATIONS:

- [ ] Claude: open a Claude Code session in this workspace, send one message.
- [ ] Cursor: open Cursor Composer with a name set, send one message.
- [ ] Codex: run a codex CLI session.
- [ ] Gemini: run a gemini CLI session.
- [ ] OpenCode: open an OpenCode session.
- [ ] Copilot CLI: run a `gh copilot` session.
- [ ] Copilot Chat: open VS Code Copilot Chat and send one message.

For each row, confirm:
- Title is correct (native or fallback truncate).
- Provider badge shows the right label.
- Message count is non-zero.
- Relative time is plausible.

- [ ] **Step 5.2.4: Click each row**

Each click should open `ConversationDetailsPanel` (or reveal the existing one). Transcript entries render for JSONL sources (Claude / Codex / Gemini / Copilot Chat). For sqlite-backed sources (OpenCode / Cursor / Copilot CLI), the body will be empty — this is the tracked MVP gap noted in Task 4.2.3.

- [ ] **Step 5.2.5: Test refresh**

Click the Branch tab's existing Refresh icon. Verify CONVERSATIONS list rescans (try removing a session externally first to see it disappear after refresh).

- [ ] **Step 5.2.6: Test foreign mode**

Switch the Branch tab to view a foreign repo/branch. Verify CONVERSATIONS section is hidden (along with PLANS & NOTES).

- [ ] **Step 5.2.7: Test empty state**

Use a project with no recent activity. Verify the empty-state text `No active AI conversations in the last 2 days.` displays.

- [ ] **Step 5.2.8: Update CHANGELOG**

Add to `vscode/CHANGELOG.md` under an Unreleased heading:

```markdown
## [Unreleased]

### Added
- New **CONVERSATIONS** section in the Branch panel: lists active AI sessions from Claude, Cursor, Codex, Gemini, OpenCode, Copilot CLI, and Copilot Chat over the last 48 hours, sorted newest first. Click a row to open a dedicated panel with the full transcript.
```

- [ ] **Step 5.2.9: Commit CHANGELOG**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add vscode/CHANGELOG.md && git commit -s -m "docs(vscode): mention CONVERSATIONS section in CHANGELOG"
```

- [ ] **Step 5.2.10: Open the PR**

Run from the feature branch:

```bash
cd /Users/flyer/jolli/code/jollimemory && gh pr create --title "feat(vscode): active AI conversations panel" --body "$(cat <<'EOF'
## Summary
- New CONVERSATIONS section in the Branch tab listing active AI sessions from all 7 supported sources (48h window, no item cap).
- Native title pulled from each source's own metadata (Claude ai-title row, OpenCode sqlite session.title, Cursor composerData.name, Copilot CLI sessions.summary); falls back to first-user-message truncated to 60 code points for Codex / Gemini / Copilot Chat.
- New ConversationDetailsPanel reuses the freshly-extracted TranscriptEntryRenderer (shared with the existing summary modal).

## Intentionally unchanged
- intellij/ (IntelliJ port deferred — see spec §14)
- parseJolliApiKey / assertJolliOriginAllowed three mirrored implementations (no auth touch points)
- LLM client / squash worker (this feature does not call the LLM)

## Test plan
- [x] npm run all passes
- [x] CLI coverage thresholds maintained (97/96/97/97)
- [x] Manual smoke test on all 7 sources
- [x] Refresh button rescans
- [x] Foreign-mode hides the section
- [x] Empty state copy shows when no sessions
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:**
- §2.1 section header CONVERSATIONS, no toolbar buttons — Task 3.4.4 + 3.4.7 ✓
- §2.2 row layout — Task 3.4.6 ✓
- §2.4 empty state — Task 3.4.4 (`emptyText`) ✓
- §2.5 foreign mode hidden — Task 3.4.4 (`if (!foreign)`) ✓
- §3 48h window / no cap / sort — Task 2.7.3 ✓
- §4 ActiveConversationItem / aggregator — Task 2.7 ✓
- §5.1-5.5 native-first / fallback / failure — Tasks 2.1, 2.2, 2.3, 2.4, 2.5, 2.6 ✓
- §6 ConversationDetailsPanel — Tasks 4.1, 4.2, 4.3 ✓
- §7 message protocol — Task 3.1 ✓
- §8 tests — every Task includes its own ✓
- §13 PR sequence — Stages map 1-to-1 to PR-1 through PR-5 ✓

**Known acceptable gaps for MVP (tracked as TODOs):**
- OpenCode / Cursor / Copilot CLI **transcript** loading (`TranscriptLoader.parseOpenCode/parseCursor/parseCopilot`) is intentionally a no-op for MVP because those sources are sqlite-backed. Their list rows still work because titles come from sqlite columns in the discoverer step (Tasks 2.2 / 2.3 / 2.4). The detail panel will render an empty body for these three; documented in commit message for Task 4.2.6 and as inline TODO comments in `TranscriptLoader.ts`.

**Placeholder scan:** Each step contains real code or real commands. The HtmlBuilder stub in Step 4.1.3 is immediately replaced by Step 4.2.3 — acceptable as a transient skeleton, not an open-ended TBD.

**Type consistency:** `ActiveConversationItem` is defined in Step 2.7.3 and consumed identically in Steps 3.1.2, 3.2.2, 3.4.6. `ShowOptions` for the panel is defined in Step 4.1.3 and used in Step 4.3.2. `SessionInfo.title` becomes optional in Step 2.2.2 and is read in Steps 2.6.2, 2.7.3. `TranscriptEntry` already exists in `cli/src/Types.ts:30-34` and is used by Steps 4.2.2 + 1.1.3.
