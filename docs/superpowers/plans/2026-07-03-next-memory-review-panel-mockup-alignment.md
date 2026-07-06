# Next Memory review panel — mockup alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `NextMemoryPreviewPanel` (opened by the sidebar's "Review" button) from a static read-only three-list skeleton into a fully interactive editor-column mirror of the sidebar's Working Memory card, matching the `jollimemory-design` mockup's `#pane-working`.

**Architecture:** New `NextMemoryHtmlBuilder.ts` / `NextMemoryCssBuilder.ts` / `NextMemoryScriptBuilder.ts` builder trio (mirrors the existing `Summary*`/`Sidebar*` pattern), `enableScripts: true`. The panel receives the exact same `branch:conversationsData` / `branch:plansData` / `branch:changesData` payloads the sidebar already renders from, via a small broadcast fan-out added to `SidebarWebviewProvider.postMessage()`. It posts the exact same `branch:toggle*Selection` messages the sidebar posts, handled by widening `SidebarWebviewProvider.handleOutbound()` from `private` to callable-by-the-panel — no new selection state anywhere. Three genuinely new pieces of data (proposed title, token totals, staged diffstat) are computed host-side from existing, already-tested building blocks (`bridge.generateCommitMessage()`, `readTranscript()`, `getDiffStats()`'s sibling for staged changes) and pushed down as three new, panel-only message types.

**Tech Stack:** TypeScript (ESM in `cli`, esbuild→CJS in `vscode`), Vitest, Biome (tabs, 120 cols), VS Code webview API. Webview-side code is a template-literal JS string (no bundler inside the webview), matching `SidebarScriptBuilder.ts`'s existing pattern — DOM built via a small `el(tag, attrs, children)` helper duplicated into the new script (webview scripts are separate JS scopes; runtime `import` across them is not possible, so small leaf helpers are duplicated rather than shared).

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` / `🤖 Generated with …` trailers.
- **`npm run all` must pass before the final commit** (clean → build → lint → test). Per project convention, run it **once at the end** (Task 11), not per task — each task only writes code (test + implementation) and runs its own focused test file.
- **Do not regress CLI coverage** — code under `cli/src/` held to 97% stmts / 96% branches / 97% funcs / 97% lines. Tasks 1 and 3 add `cli/src` code and must include tests that keep this floor.
- **Webview CSP:** no inline `style=` / inline event handlers. Dynamic styles via CSS class; events via a single delegated click/change listener per panel. Show/hide via the `.hidden` class, never the HTML `hidden` attribute.
- **Builder backtick trap:** never put a backtick inside the `buildNextMemoryScript()` template literal (it truncates the whole literal). Quote identifiers in comments with single/double quotes.
- **Message contract parity:** the panel's outbound `branch:toggle*Selection` messages must be field-identical to the sidebar's — both feed the same host handler (`SidebarWebviewProvider.handleOutbound`). Task 7 includes a test that pins this.
- **Real fixtures for parser-adjacent tests:** the token-totals test (Task 3) uses realistic Claude transcript JSONL lines shaped like the ones already pinned in `cli/src/core/TranscriptReader.test.ts` (lines ~880-975) — not invented shapes.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `cli/src/core/GitOps.ts` | Git plumbing helpers | Add `getStagedDiffStats()` |
| `cli/src/core/ConversationTokenTotals.ts` | NEW — sums real per-conversation token usage across a set of active conversations | Create |
| `vscode/src/util/CommitMessageUtils.ts` | Commit-message text utilities | Export `TICKET_PATTERN`; add `findTicketInContext()` |
| `vscode/src/views/SidebarWebviewProvider.ts` | Sidebar host/webview bridge | Widen `handleOutbound` to callable-by-panel; add broadcast fan-out to `postMessage()`; delete `getNextMemorySelection()` |
| `vscode/src/views/NextMemoryCssBuilder.ts` | NEW — styles for the review panel | Create |
| `vscode/src/views/NextMemoryHtmlBuilder.ts` | NEW — document shell for the review panel | Create |
| `vscode/src/views/NextMemoryScriptBuilder.ts` | NEW — webview-side rendering + event wiring | Create |
| `vscode/src/views/NextMemoryPreviewPanel.ts` | Host class for the review panel webview | Rewrite |
| `vscode/src/Extension.ts` | Command registration | Update `jollimemory.reviewNextMemory`; add `jollimemory.regenerateNextMemoryTitle` |
| `vscode/package.json` | Command contributions | Declare `jollimemory.regenerateNextMemoryTitle` |

Test files: `GitOps.test.ts`, `ConversationTokenTotals.test.ts`, `CommitMessageUtils.test.ts`, `SidebarWebviewProvider.test.ts`, `NextMemoryCssBuilder.test.ts`, `NextMemoryHtmlBuilder.test.ts`, `NextMemoryScriptBuilder.test.ts`, `NextMemoryPreviewPanel.test.ts`.

---

## Task 1: Staged diffstat helper

**Files:**
- Modify: `cli/src/core/GitOps.ts:266-283` (next to the existing `getDiffStats`)
- Test: `cli/src/core/GitOps.test.ts`

**Interfaces:**
- Consumes: `execGit` (already imported in `GitOps.ts`), `DiffStats` from `../Types.js` (already imported).
- Produces: `export async function getStagedDiffStats(cwd?: string): Promise<DiffStats>` — used by Task 9.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/GitOps.test.ts` (find the existing `describe("getDiffStats"` block and add a sibling):

```ts
describe("getStagedDiffStats", () => {
	it("parses a staged diff summary line", async () => {
		execGitMock.mockResolvedValueOnce({
			stdout: " 2 files changed, 14 insertions(+), 3 deletions(-)\n",
			stderr: "",
			exitCode: 0,
		});
		const stats = await getStagedDiffStats("/repo");
		expect(stats).toEqual({ filesChanged: 2, insertions: 14, deletions: 3 });
		expect(execGitMock).toHaveBeenCalledWith(["diff", "--stat", "--cached"], "/repo");
	});

	it("returns zeros when nothing is staged", async () => {
		execGitMock.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
		const stats = await getStagedDiffStats("/repo");
		expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
	});
});
```

Check the top of `GitOps.test.ts` for how `execGit` is already mocked in that file (it is used by the existing `getDiffStats` tests) and reuse that exact mock variable name instead of `execGitMock` if it differs — match the file's existing convention.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/GitOps.test.ts -t "getStagedDiffStats"`
Expected: FAIL — `getStagedDiffStats is not a function` / not exported.

- [ ] **Step 3: Implement**

Add immediately after `getDiffStats` (`cli/src/core/GitOps.ts:283`):

```ts
/**
 * Gets diff statistics for the currently staged (index) changes.
 * Same parsing as {@link getDiffStats}, against `git diff --stat --cached`
 * instead of two refs — there is no second ref for a not-yet-committed diff.
 */
export async function getStagedDiffStats(cwd?: string): Promise<DiffStats> {
	const result = await execGit(["diff", "--stat", "--cached"], cwd);

	const lastLine = result.stdout.split("\n").filter((l) => l.trim().length > 0).pop() ?? "";
	const filesMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
	const insertMatch = lastLine.match(/(\d+)\s+insertions?/);
	const deleteMatch = lastLine.match(/(\d+)\s+deletions?/);

	return {
		filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
		insertions: insertMatch ? Number.parseInt(insertMatch[1], 10) : 0,
		deletions: deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/GitOps.test.ts -t "getStagedDiffStats"`
Expected: PASS

---

## Task 2: Ticket-detection helper for the Context selection

**Files:**
- Modify: `vscode/src/util/CommitMessageUtils.ts:9` (export the existing pattern), append a new exported function
- Test: `vscode/src/util/CommitMessageUtils.test.ts`

**Interfaces:**
- Consumes: `SerializedTreeItem` (`import type { SerializedTreeItem } from "../views/SidebarMessages.js"`) — fields used: `contextValue`, `isSelected`, `label`.
- Produces: `export function findTicketInContext(items: ReadonlyArray<SerializedTreeItem>): string | undefined` — used by Task 9.

- [ ] **Step 1: Write the failing test**

Add to `vscode/src/util/CommitMessageUtils.test.ts`:

```ts
describe("findTicketInContext", () => {
	it("returns the ticket from the first selected reference row", () => {
		const items = [
			{ id: "p1", label: "Sidebar redesign plan", contextValue: "plan", isSelected: true },
			{ id: "r1", label: "JOLLI-1620 · Sidebar UX redesign", contextValue: "reference", isSelected: true },
			{ id: "r2", label: "CX-482 · Density follow-ups", contextValue: "reference", isSelected: true },
		];
		expect(findTicketInContext(items as never)).toBe("JOLLI-1620");
	});

	it("skips excluded reference rows", () => {
		const items = [
			{ id: "r1", label: "JOLLI-1620 · Sidebar UX redesign", contextValue: "reference", isSelected: false },
			{ id: "r2", label: "CX-482 · Density follow-ups", contextValue: "reference", isSelected: true },
		];
		expect(findTicketInContext(items as never)).toBe("CX-482");
	});

	it("returns undefined when no selected reference has a ticket-shaped label", () => {
		const items = [
			{ id: "n1", label: "VS Code token mapping notes", contextValue: "note", isSelected: true },
			{ id: "r1", label: "Sidebar redesign spec: Notion", contextValue: "reference", isSelected: true },
		];
		expect(findTicketInContext(items as never)).toBeUndefined();
	});

	it("returns undefined for an empty list", () => {
		expect(findTicketInContext([])).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/util/CommitMessageUtils.test.ts -t "findTicketInContext"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `vscode/src/util/CommitMessageUtils.ts`, change the module-private pattern to exported (line 9):

```ts
/** Ticket pattern: matches Jira-style ticket IDs like "PROJ-123", "FEAT-42" (case-insensitive) */
export const TICKET_PATTERN = /[A-Z]+-\d+/i;
```

(Remove the old `const TICKET_PATTERN = ...` line it replaces; every other reference to `TICKET_PATTERN` in this file keeps working unchanged since the name is unchanged.)

Add at the end of the file:

```ts
/**
 * Finds a ticket identifier among the currently selected Context rows, for
 * the Next Memory review panel's "Detected ticket" line. Only looks at
 * reference rows (not plans/notes) and only at selected ones — this is a
 * lookup over already-curated context, not a new detection mechanism.
 */
export function findTicketInContext(
	items: ReadonlyArray<{ readonly label: string; readonly contextValue?: string; readonly isSelected?: boolean }>,
): string | undefined {
	for (const item of items) {
		if (item.contextValue !== "reference" || item.isSelected === false) continue;
		const match = TICKET_PATTERN.exec(item.label);
		if (match) return match[0].toUpperCase();
	}
	return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/util/CommitMessageUtils.test.ts -t "findTicketInContext"`
Expected: PASS

---

## Task 3: Conversation token totals helper

**Files:**
- Create: `cli/src/core/ConversationTokenTotals.ts`
- Test: `cli/src/core/ConversationTokenTotals.test.ts`

**Interfaces:**
- Consumes: `readTranscript` from `./TranscriptReader.js`, `ConversationTokenBreakdown` from `../Types.js`.
- Produces:
  ```ts
  export interface ConversationTokenEntry {
  	readonly source: string;
  	readonly transcriptPath: string;
  }
  export interface ConversationTokenTotalsResult extends ConversationTokenBreakdown {
  	readonly total: number;
  	readonly reportingCount: number;
  	readonly totalCount: number;
  }
  export async function sumConversationTokens(
  	entries: ReadonlyArray<ConversationTokenEntry>,
  ): Promise<ConversationTokenTotalsResult>
  ```
  Used by Task 9. Only `source === "claude"` entries are read (other sources have no usage in their JSONL); a failed read for one entry degrades that entry to zero rather than throwing.

- [ ] **Step 1: Write the failing test**

Create `cli/src/core/ConversationTokenTotals.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sumConversationTokens } from "./ConversationTokenTotals.js";

const tmpDirs: string[] = [];
afterEach(async () => {
	tmpDirs.length = 0;
});

async function writeClaudeTranscript(lines: ReadonlyArray<Record<string, unknown>>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "jolli-token-totals-"));
	tmpDirs.push(dir);
	const path = join(dir, "session.jsonl");
	await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
	return path;
}

describe("sumConversationTokens", () => {
	it("sums usage across selected Claude conversations, ignoring cache_read", async () => {
		// Shape mirrors the real Claude Code transcript schema already pinned in
		// cli/src/core/TranscriptReader.test.ts (usage lives at message.usage).
		const claudePath = await writeClaudeTranscript([
			{
				timestamp: "2026-07-01T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 5000, output_tokens: 5 },
				},
			},
			{
				timestamp: "2026-07-01T00:01:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "more" }],
					usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5100, output_tokens: 10 },
				},
			},
		]);

		const result = await sumConversationTokens([{ source: "claude", transcriptPath: claudePath }]);

		// 100 + 20 + 5 + 50 + 0 + 10 = 185; cache_read_input_tokens is never summed
		// (see the parser comment in TranscriptParser.ts for why).
		expect(result).toEqual({
			input: 150,
			output: 15,
			cached: 20,
			total: 185,
			reportingCount: 1,
			totalCount: 1,
		});
	});

	it("reports non-Claude sources as non-reporting without reading a file", async () => {
		const result = await sumConversationTokens([{ source: "codex", transcriptPath: "/does/not/exist.jsonl" }]);
		expect(result).toEqual({ input: 0, output: 0, cached: 0, total: 0, reportingCount: 0, totalCount: 1 });
	});

	it("degrades a single unreadable Claude transcript to zero without throwing", async () => {
		const result = await sumConversationTokens([{ source: "claude", transcriptPath: "/does/not/exist.jsonl" }]);
		expect(result).toEqual({ input: 0, output: 0, cached: 0, total: 0, reportingCount: 0, totalCount: 1 });
	});

	it("returns all zeros for an empty entry list", async () => {
		expect(await sumConversationTokens([])).toEqual({
			input: 0,
			output: 0,
			cached: 0,
			total: 0,
			reportingCount: 0,
			totalCount: 0,
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/ConversationTokenTotals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cli/src/core/ConversationTokenTotals.ts`:

```ts
import { createLogger } from "../Logger.js";
import type { ConversationTokenBreakdown } from "../Types.js";
import { readTranscript } from "./TranscriptReader.js";

const log = createLogger("ConversationTokenTotals");

export interface ConversationTokenEntry {
	readonly source: string;
	readonly transcriptPath: string;
}

export interface ConversationTokenTotalsResult extends ConversationTokenBreakdown {
	readonly total: number;
	/** How many entries actually contributed a non-zero read (Claude only, read succeeded). */
	readonly reportingCount: number;
	readonly totalCount: number;
}

/**
 * Sums real per-conversation token usage for the Next Memory review panel's
 * token meter. Only Claude transcripts carry a `usage` field per turn (see
 * TranscriptParser.ts); other sources have no data to read, so they count
 * toward `totalCount` but never `reportingCount`. A read failure for one
 * entry (moved/deleted file, permission error) degrades that entry to zero
 * rather than failing the whole total — this is a best-effort meter, not a
 * billing figure.
 */
export async function sumConversationTokens(
	entries: ReadonlyArray<ConversationTokenEntry>,
): Promise<ConversationTokenTotalsResult> {
	let input = 0;
	let output = 0;
	let cached = 0;
	let reportingCount = 0;

	for (const entry of entries) {
		if (entry.source !== "claude") continue;
		try {
			const result = await readTranscript(entry.transcriptPath);
			if (result.usageBreakdown) {
				input += result.usageBreakdown.input;
				output += result.usageBreakdown.output;
				cached += result.usageBreakdown.cached;
				reportingCount++;
			}
		} catch (err) {
			log.warn("Failed to read transcript for token totals: %s", entry.transcriptPath, err);
		}
	}

	return { input, output, cached, total: input + output + cached, reportingCount, totalCount: entries.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/ConversationTokenTotals.test.ts`
Expected: PASS

Confirm `readTranscript`'s `usageBreakdown` is present on its result type even with no `beforeTimestamp` argument — it is (`cli/src/core/TranscriptReader.ts:159-161` sets it unconditionally). If the real `readTranscript` throws on a missing file (via its own `readFile` call at `TranscriptReader.ts:96-100`), the `try/catch` above already covers it.

---

## Task 4: Broadcast fan-out + callable `handleOutbound` on `SidebarWebviewProvider`

**Files:**
- Modify: `vscode/src/views/SidebarWebviewProvider.ts:546-549` (`postMessage`), `:634` (`handleOutbound` visibility)
- Test: `vscode/src/views/SidebarWebviewProvider.test.ts`

**Interfaces:**
- Produces: `registerBroadcastTarget(webview: vscode.Webview): void`, `unregisterBroadcastTarget(webview: vscode.Webview): void`, and `handleOutbound(raw: unknown): void` (was `private`, now callable) — all used by Task 9's `NextMemoryPreviewPanel`.
- Consumes: nothing new — `SidebarInboundMsg` / `SidebarOutboundMsg` already imported in this file.

- [ ] **Step 1: Write the failing test**

Add to `vscode/src/views/SidebarWebviewProvider.test.ts` (find the existing describe block structure and add a sibling `describe`):

```ts
describe("broadcast targets", () => {
	it("posts pushed messages to registered broadcast targets in addition to the sidebar view", async () => {
		const provider = makeProvider(); // use this file's existing provider-construction helper
		await provider.resolveWebviewView(makeFakeWebviewView(), {} as never, {} as never);

		const extraPosted: unknown[] = [];
		const extraWebview = { postMessage: (m: unknown) => { extraPosted.push(m); return Promise.resolve(true); } };
		provider.registerBroadcastTarget(extraWebview as never);

		provider.postMessage({ type: "branch:branchName", name: "main", detached: false });

		expect(extraPosted).toContainEqual({ type: "branch:branchName", name: "main", detached: false });
	});

	it("stops posting to a target after it is unregistered", () => {
		const provider = makeProvider();
		const extraPosted: unknown[] = [];
		const extraWebview = { postMessage: (m: unknown) => { extraPosted.push(m); return Promise.resolve(true); } };
		provider.registerBroadcastTarget(extraWebview as never);
		provider.unregisterBroadcastTarget(extraWebview as never);

		provider.postMessage({ type: "branch:branchName", name: "main", detached: false });

		expect(extraPosted).toEqual([]);
	});
});

describe("handleOutbound (callable from other panels)", () => {
	it("is callable directly and dispatches a toggle message to the matching applyXCheckbox dep", () => {
		const applyPlanCheckbox = vi.fn();
		const provider = makeProvider({ applyPlanCheckbox });
		provider.handleOutbound({ type: "branch:togglePlanSelection", planId: "p1", selected: false });
		expect(applyPlanCheckbox).toHaveBeenCalledWith("p1", false);
	});
});
```

Read the top of `SidebarWebviewProvider.test.ts` first to find the actual names of its provider-construction helper (`makeProvider` above is a placeholder name — use whatever helper/fixture the existing tests already use to construct a `SidebarWebviewProvider` with mock deps, and whatever helper constructs a fake `vscode.WebviewView` for `resolveWebviewView`) and match them exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts -t "broadcast targets"`
Expected: FAIL — `registerBroadcastTarget is not a function`.

- [ ] **Step 3: Implement**

At `vscode/src/views/SidebarWebviewProvider.ts:634`, remove `private` from `handleOutbound`:

```ts
	handleOutbound(raw: unknown): void {
```

Add a broadcast-target list as a class field near where `this.view` is declared, and rewrite `postMessage` (`vscode/src/views/SidebarWebviewProvider.ts:545-549`):

```ts
	private readonly broadcastTargets = new Set<vscode.Webview>();

	/**
	 * Lets a second webview (the Next Memory review panel) receive the same
	 * host→webview pushes the sidebar gets, so both surfaces render from one
	 * data stream and never drift. The panel registers on open, unregisters
	 * in its onDidDispose.
	 */
	registerBroadcastTarget(webview: vscode.Webview): void {
		this.broadcastTargets.add(webview);
	}

	unregisterBroadcastTarget(webview: vscode.Webview): void {
		this.broadcastTargets.delete(webview);
	}

	/** Send a message to the webview client. No-op when the view is not resolved. */
	postMessage(msg: SidebarInboundMsg): void {
		if (this.view) void this.view.webview.postMessage(msg);
		for (const target of this.broadcastTargets) {
			void target.postMessage(msg);
		}
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts -t "broadcast targets"`
Run: `npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts -t "handleOutbound"`
Expected: PASS

---

## Task 5: `NextMemoryCssBuilder.ts`

**Files:**
- Create: `vscode/src/views/NextMemoryCssBuilder.ts`
- Test: `vscode/src/views/NextMemoryCssBuilder.test.ts`

**Interfaces:**
- Produces: `export function buildNextMemoryCss(): string` — a plain CSS string, consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Create `vscode/src/views/NextMemoryCssBuilder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildNextMemoryCss } from "./NextMemoryCssBuilder.js";

describe("buildNextMemoryCss", () => {
	it("defines the panel/row/badge classes used by NextMemoryScriptBuilder", () => {
		const css = buildNextMemoryCss();
		for (const cls of [".panel", ".panel-header", ".row", ".r-main", ".r-title", ".r-meta", ".badge", ".kb-tag", ".excluded", ".row-excl", ".env-label", ".tmeter", ".tmeter-bar", ".meta-strip", ".local-chip"]) {
			expect(css).toContain(cls);
		}
	});

	it("marks excluded rows with a strikethrough, matching the sidebar's model", () => {
		const css = buildNextMemoryCss();
		expect(css).toMatch(/\.row\.excluded[^{]*\{[^}]*text-decoration:\s*line-through/);
	});

	it("hides .row-excl until hover, matching the sidebar's hover-reveal pattern", () => {
		const css = buildNextMemoryCss();
		expect(css).toMatch(/\.row-excl\s*\{[^}]*display:\s*none/);
	});

	it("contains no backtick (builder template-literal trap)", () => {
		expect(buildNextMemoryCss().includes("`")).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/NextMemoryCssBuilder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `vscode/src/views/NextMemoryCssBuilder.ts`:

```ts
/**
 * NextMemoryCssBuilder
 *
 * Styles for the Next Memory review panel — the editor-column mirror of the
 * sidebar's Working Memory card, mocked up as jollimemory-design's
 * `#pane-working`. Uses the same VS Code theme CSS variables as the other
 * webviews (SummaryCssBuilder / SidebarCssBuilder) for light/dark parity.
 */
export function buildNextMemoryCss(): string {
	return [
		"body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 16px 24px; line-height: 1.5; }",
		"h1 { font-size: 1.3em; margin: 0 0 8px; }",
		".meta-strip { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }",
		".meta-sep { opacity: 0.6; }",
		".local-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }",
		".muted { font-size: 12.5px; color: var(--vscode-descriptionForeground); margin: 4px 0 12px; }",
		".panel { border: 1px solid var(--vscode-widget-border); border-radius: 6px; margin: 0 0 12px; overflow: hidden; }",
		".panel-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border); }",
		".panel-title { flex: 1; }",
		".sec-count { opacity: 0.75; }",
		".row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; position: relative; }",
		".row + .row { border-top: 1px solid var(--vscode-widget-border); }",
		".row.excluded .r-title { text-decoration: line-through; }",
		".row.excluded { opacity: 0.55; }",
		".row.excluded:hover { opacity: 1; }",
		".row-check { flex-shrink: 0; }",
		".r-main { flex: 1; min-width: 0; }",
		".r-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
		".r-meta { flex-shrink: 0; font-size: 11.5px; color: var(--vscode-descriptionForeground); }",
		".badge { flex-shrink: 0; padding: 1px 6px; border-radius: 3px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }",
		".kb-tag { flex-shrink: 0; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; font-size: 10.5px; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }",
		".gs { flex-shrink: 0; font-size: 11px; font-weight: 600; }",
		".row-excl { display: none; margin-left: auto; }",
		".row:hover .row-excl { display: inline-flex; }",
		".panel-add { margin-left: auto; background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11.5px; }",
		".env-label { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }",
		".env-ai { padding: 0 4px; border-radius: 3px; background: var(--vscode-charts-blue); color: #fff; font-size: 10px; }",
		".env-title-text { font-size: 13px; margin-bottom: 6px; }",
		".env-grid { display: flex; gap: 14px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }",
		".env-panel-body { padding: 8px 10px; }",
		".tmeter { padding: 8px 10px; }",
		".tmeter-head { font-size: 12px; margin-bottom: 4px; }",
		".tmeter-total { font-weight: 600; }",
		".tmeter-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--vscode-widget-border); }",
		".seg-in { background: var(--vscode-charts-green); }",
		".seg-out { background: var(--vscode-charts-blue); }",
		".seg-cache { background: var(--vscode-charts-gray); }",
		".tmeter-legend { display: flex; gap: 12px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }",
		".lg-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; }",
		".privacy-note { font-size: 11.5px; display: flex; gap: 6px; color: var(--vscode-descriptionForeground); margin: 10px 0; }",
		".footer-note { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin: 8px 0; }",
		".btn { width: 100%; padding: 7px 10px; border: none; border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; }",
		".btn:disabled { opacity: 0.5; cursor: default; }",
		".btn.secondary { background: none; color: var(--vscode-textLink-foreground); width: auto; padding: 4px 6px; }",
		".empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 6px 10px; }",
		".hidden { display: none; }",
	].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/views/NextMemoryCssBuilder.test.ts`
Expected: PASS

---

## Task 6: `NextMemoryScriptBuilder.ts` — data model + row rendering

**Files:**
- Create: `vscode/src/views/NextMemoryScriptBuilder.ts`
- Test: `vscode/src/views/NextMemoryScriptBuilder.test.ts`

**Interfaces:**
- Produces: `export function buildNextMemoryScript(): string` — a JS-source string mounted into a `<script>` tag by Task 8. Listens for `branch:conversationsData` / `branch:plansData` / `branch:changesData` (payload shapes: `{type, items: ActiveConversationItem[], failedSources}` and `{type, items: SerializedTreeItem[]}` respectively — same shapes the sidebar already receives, see `vscode/src/views/SidebarMessages.ts:782-795`) plus three new panel-only messages: `preview:title` (`{type, title?: string, ticket?: string, error?: string}`), `preview:tokenStats` (`{type, input: number, output: number, cached: number, total: number, reportingCount: number, totalCount: number}`), `preview:diffstat` (`{type, insertions: number, deletions: number, filesChanged: number}`).

This task covers rendering only (pure functions building DOM from data already received). Event wiring (toggle/add/commit/regenerate) is Task 7.

- [ ] **Step 1: Write the failing test**

Create `vscode/src/views/NextMemoryScriptBuilder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildNextMemoryScript } from "./NextMemoryScriptBuilder.js";

describe("buildNextMemoryScript", () => {
	it("parses as valid JavaScript (smoke test)", () => {
		// Mirrors the SidebarScriptBuilder / SummaryScriptBuilder convention: a
		// `new Function` parse check catches syntax errors (e.g. an accidental
		// backtick truncating the template literal) that string assertions miss.
		expect(() => new Function(buildNextMemoryScript())).not.toThrow();
	});

	it("contains no backtick (builder template-literal trap)", () => {
		expect(buildNextMemoryScript().includes("`")).toBe(false);
	});

	it("listens for the same branch:*Data messages the sidebar renders from", () => {
		const js = buildNextMemoryScript();
		for (const type of ["branch:conversationsData", "branch:plansData", "branch:changesData"]) {
			expect(js).toContain(type);
		}
	});

	it("renders a conversation row with a source badge, title, and message count", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("'badge src-' + item.source");
		expect(js).toContain("item.messageCount) + ' msgs'");
	});

	it("renders excluded rows struck-through rather than omitting them", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("item.isSelected ? '' : ' excluded'");
	});

	it("renders context rows with a kb-tag badge keyed by contextValue", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("mem-ctx-badge");
	});

	it("renders file rows with the git-status letter", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("'gs gs-' + item.gitStatus");
	});

	it("handles preview:title including the failure-degraded state", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("preview:title");
		expect(js).toContain("Couldn't generate a title");
	});

	it("handles preview:tokenStats with a not-reported degradation note", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("preview:tokenStats");
	});

	it("handles preview:diffstat", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("preview:diffstat");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/NextMemoryScriptBuilder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `vscode/src/views/NextMemoryScriptBuilder.ts`:

```ts
/**
 * NextMemoryScriptBuilder
 *
 * Client-side script for the Next Memory review panel. A standalone JS
 * scope (no bundler inside a webview), so small leaf helpers (el, ctxBadge,
 * providerLabel) are duplicated here rather than imported from
 * SidebarScriptBuilder.ts's template-literal string — there is no runtime
 * module boundary to share across two separate <script> tags.
 *
 * Data model: this panel renders from the exact same branch:conversationsData
 * / branch:plansData / branch:changesData payloads the sidebar's Working
 * Memory card renders from (see SidebarWebviewProvider's broadcast fan-out),
 * so toggling a row here and toggling the same row in the sidebar always
 * agree — there is no second, panel-only selection state.
 */
export function buildNextMemoryScript(): string {
	return `
  const vscode = acquireVsCodeApi();
  let conversations = [];
  let contextItems = [];
  let files = [];

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'className') n.className = String(v);
        else if (k === 'text') n.textContent = String(v);
        else if (k === 'title') n.title = String(v);
        else n.setAttribute(k, String(v));
      }
    }
    if (children) {
      const list = Array.isArray(children) ? children : [children];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c == null) continue;
        if (typeof c === 'string') n.appendChild(document.createTextNode(c));
        else n.appendChild(c);
      }
    }
    return n;
  }

  function mount(id, node) {
    const host = document.getElementById(id);
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(node);
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

  // Exclude toggle: hover-revealed control mirroring the sidebar's row-excl
  // pattern. Posts the SAME branch:toggle*Selection message shape the
  // sidebar posts (see SidebarWebviewProvider.handleOutbound) — no new
  // selection state, one host handler for both surfaces.
  function excludeToggle(onToggle, selected) {
    const btn = el('button', {
      type: 'button',
      className: 'row-excl',
      title: selected ? 'Leave out of this memory' : 'Add back to this memory',
    }, [el('i', { className: 'codicon ' + (selected ? 'codicon-close' : 'codicon-add') })]);
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      onToggle(!selected);
    });
    return btn;
  }

  function ctxBadge(kind, source) {
    let letter = 'C';
    let badgeKind = kind || '';
    if (kind === 'plan') letter = 'P';
    else if (kind === 'note') letter = 'N';
    else if (kind === 'reference') {
      const s = source || '';
      badgeKind = s || 'reference';
      if (s === 'linear') letter = 'L';
      else if (s === 'jira') letter = 'J';
      else if (s === 'github') letter = 'G';
      else if (s === 'notion') letter = 'N';
      else letter = 'R';
    }
    return el('span', { className: 'kb-tag mem-ctx-badge mem-ctx-badge--' + badgeKind, text: letter });
  }

  function renderConversationRow(item) {
    const row = el('div', {
      className: 'row' + (item.isSelected ? '' : ' excluded'),
      'data-session-id': item.sessionId,
    }, [
      el('span', { className: 'badge src-' + item.source, text: providerLabel(item.source) }),
      el('div', { className: 'r-main' }, [el('div', { className: 'r-title', text: item.title || '(untitled)' })]),
      el('span', { className: 'r-meta', text: String(item.messageCount) + ' msgs' }),
    ]);
    row.appendChild(excludeToggle(function(selected) {
      vscode.postMessage({
        type: 'branch:toggleConversationSelection',
        source: item.source,
        sessionId: item.sessionId,
        selected: selected,
      });
    }, !!item.isSelected));
    return row;
  }

  function renderContextRow(item) {
    const row = el('div', { className: 'row' + (item.isSelected ? '' : ' excluded'), 'data-id': item.id });
    row.appendChild(ctxBadge(item.contextValue, item.iconKey));
    row.appendChild(el('div', { className: 'r-main' }, [el('div', { className: 'r-title', text: item.label })]));
    let toggleMsg;
    if (item.contextValue === 'plan') toggleMsg = { type: 'branch:togglePlanSelection', planId: item.id };
    else if (item.contextValue === 'note') toggleMsg = { type: 'branch:toggleNoteSelection', noteId: item.id };
    else toggleMsg = { type: 'branch:toggleReferenceSelection', mapKey: item.id };
    row.appendChild(excludeToggle(function(selected) {
      vscode.postMessage(Object.assign({}, toggleMsg, { selected: selected }));
    }, !!item.isSelected));
    return row;
  }

  function renderFileRow(item) {
    const row = el('div', { className: 'row' + (item.isSelected ? '' : ' excluded'), 'data-id': item.id });
    row.appendChild(el('div', { className: 'r-main' }, [el('div', { className: 'r-title', text: item.label })]));
    if (item.gitStatus) {
      row.appendChild(el('span', { className: 'gs gs-' + item.gitStatus, text: item.gitStatus }));
    }
    row.appendChild(excludeToggle(function(selected) {
      vscode.postMessage({ type: 'branch:toggleFileSelection', filePath: item.id, selected: selected });
    }, !!item.isSelected));
    return row;
  }

  function panel(title, count, rows, headerExtra) {
    const header = el('div', { className: 'panel-header' }, [
      el('span', { className: 'panel-title', text: title }),
      el('span', { className: 'sec-count', text: String(count) }),
    ]);
    if (headerExtra) header.appendChild(headerExtra);
    const body = rows.length
      ? rows
      : [el('div', { className: 'empty', text: 'Nothing here yet.' })];
    return el('div', { className: 'panel' }, [header].concat(body));
  }

  function addMenuButton() {
    const btn = el('button', { className: 'panel-add', type: 'button', text: '+ Add' });
    btn.addEventListener('click', function() {
      vscode.postMessage({ type: 'command', command: 'jollimemory.addPlan' });
    });
    return btn;
  }

  function renderConversations() {
    mount('conversations-panel', panel('Conversations', conversations.length, conversations.map(renderConversationRow)));
  }
  function renderContext() {
    mount('context-panel', panel('Context', contextItems.length, contextItems.map(renderContextRow), addMenuButton()));
  }
  function renderFiles() {
    mount('files-panel', panel('Files', files.length, files.map(renderFileRow)));
  }

  function renderTitlePanel(msg) {
    if (msg.error) {
      mount('title-panel', el('div', { className: 'panel env-panel-body' }, [
        el('div', { className: 'muted', text: "Couldn't generate a title — " + msg.error }),
        (function() {
          const btn = el('button', { className: 'btn secondary', type: 'button', text: 'Regenerate' });
          btn.addEventListener('click', function() {
            vscode.postMessage({ type: 'command', command: 'jollimemory.regenerateNextMemoryTitle' });
          });
          return btn;
        })(),
      ]));
      return;
    }
    const kids = [
      el('div', { className: 'env-label' }, [el('span', { text: 'Proposed title' }), el('span', { className: 'env-ai', text: 'AI' })]),
      el('div', { className: 'env-title-text', text: msg.title || '' }),
    ];
    if (msg.ticket) {
      kids.push(el('div', { className: 'env-grid' }, [el('span', { text: 'Detected ticket ' }), el('b', { text: msg.ticket })]));
    }
    const regenBtn = el('button', { className: 'btn secondary', type: 'button', text: 'Regenerate' });
    regenBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'command', command: 'jollimemory.regenerateNextMemoryTitle' });
    });
    kids.push(regenBtn);
    mount('title-panel', el('div', { className: 'panel env-panel-body' }, kids));
  }

  function renderTokenMeter(msg) {
    if (!msg.total && msg.reportingCount === 0) {
      mount('token-meter', el('div', { className: 'muted', text: msg.totalCount > 0 ? 'Token usage not reported for this selection.' : '' }));
      return;
    }
    const pct = function(n) { return msg.total ? Math.round((n / msg.total) * 100) : 0; };
    mount('token-meter', el('div', { className: 'tmeter' }, [
      el('div', { className: 'tmeter-head' }, [el('span', { className: 'tmeter-total', text: String(msg.total) + ' tokens' }), el('span', { text: ' · captured by this memory' })]),
      el('div', { className: 'tmeter-bar' }, [
        el('span', { className: 'seg-in', style: undefined, 'data-w': pct(msg.input) }),
        el('span', { className: 'seg-out', 'data-w': pct(msg.output) }),
        el('span', { className: 'seg-cache', 'data-w': pct(msg.cached) }),
      ]),
    ]));
  }

  function renderMetaStrip(msg) {
    const kids = [
      el('span', { className: 'local-chip', text: 'NOT COMMITTED' }),
    ];
    if (msg.filesChanged) {
      kids.push(el('span', { className: 'meta-sep', text: '·' }));
      kids.push(el('span', { text: '+' + msg.insertions + ' −' + msg.deletions + ' · ' + msg.filesChanged + ' files' }));
    }
    mount('meta-strip', el('div', {}, kids));
  }

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'branch:conversationsData':
        conversations = msg.items || [];
        renderConversations();
        return;
      case 'branch:plansData':
        contextItems = msg.items || [];
        renderContext();
        return;
      case 'branch:changesData':
        files = msg.items || [];
        renderFiles();
        return;
      case 'preview:title':
        renderTitlePanel(msg);
        return;
      case 'preview:tokenStats':
        renderTokenMeter(msg);
        return;
      case 'preview:diffstat':
        renderMetaStrip(msg);
        return;
      default:
        return;
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
}
```

Note: `'data-w': pct(msg.input)` above sets a data attribute, not an inline `style=` — the CSP-compliant width is applied by widening the segment CSS in `NextMemoryCssBuilder.ts` to `[data-w]` percentage buckets in Task 7 alongside the rest of the token-meter wiring, following the sanctioned bucketed-width-class pattern already used by the sidebar's own token bar (`SidebarScriptBuilder.ts`'s `renderTokenBar`) rather than an inline `style="width"` (CSP has no `unsafe-inline` for styles).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/views/NextMemoryScriptBuilder.test.ts`
Expected: PASS

---

## Task 7: `NextMemoryScriptBuilder.ts` — Commit Memory / Regenerate wiring + message-contract test

**Files:**
- Modify: `vscode/src/views/NextMemoryScriptBuilder.ts` (append to the script string from Task 6)
- Test: `vscode/src/views/NextMemoryScriptBuilder.test.ts` (append)

**Interfaces:**
- Produces: a footer with a full-width Commit Memory button dispatching `{type: 'command', command: 'jollimemory.commitAI'}` — the exact command the sidebar's body "Commit Memory" button already dispatches (`SidebarScriptBuilder.ts:4727`), so no new host command is needed for the commit action itself. The button also disables while `worker:busy` (the same message already broadcast to the sidebar, and now reaching this panel too via Task 4's fan-out — no new host message needed here either), mirroring the sidebar body bar's `isWorkerBlocking()` gate (design spec §4/§5).

- [ ] **Step 1: Write the failing test**

Append to `vscode/src/views/NextMemoryScriptBuilder.test.ts`:

```ts
describe("footer + message contract parity", () => {
	it("renders a footer with the privacy note and a Commit Memory button", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("stay in your repo");
		expect(js).toContain("Commit Memory");
	});

	it("Commit Memory dispatches the exact same command the sidebar body button uses", () => {
		const js = buildNextMemoryScript();
		// Must match SidebarScriptBuilder.ts's body-commit dispatch verbatim —
		// both buttons must trigger the identical host command, not a lookalike.
		expect(js).toContain("command: 'jollimemory.commitAI'");
	});

	it("disables Commit Memory while worker:busy, mirroring the sidebar's isWorkerBlocking gate", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("'worker:busy'");
		expect(js).toContain("commitBtn.disabled = ");
	});

	it("posts branch:toggle* messages with the exact field names the sidebar posts", () => {
		const js = buildNextMemoryScript();
		// Pinned against SidebarScriptBuilder.ts's change-handler payloads
		// (source/sessionId/selected, planId/selected, noteId/selected,
		// mapKey/selected, filePath/selected) — both emitters feed the same
		// SidebarWebviewProvider.handleOutbound switch, so a field-name
		// mismatch here would silently no-op instead of erroring.
		expect(js).toContain("source: item.source");
		expect(js).toContain("sessionId: item.sessionId");
		expect(js).toContain("planId: item.id");
		expect(js).toContain("noteId: item.id");
		expect(js).toContain("mapKey: item.id");
		expect(js).toContain("filePath: item.id");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/NextMemoryScriptBuilder.test.ts -t "footer"`
Expected: FAIL — no footer content yet.

- [ ] **Step 3: Implement**

In `vscode/src/views/NextMemoryScriptBuilder.ts`, add a module-level `let commitBtn;` next to the other `let` data-model declarations from Task 6 (alongside `conversations`/`contextItems`/`files`), then add a `renderFooter()` function (append inside the template literal, before the closing `window.addEventListener` block from Task 7 — insert just above the `window.addEventListener('message', ...)` line):

```js
  let commitBtn = null;

  function renderFooter() {
    commitBtn = el('button', { className: 'btn', type: 'button' }, [
      el('i', { className: 'codicon codicon-sparkle' }),
      el('span', { text: 'Commit Memory' }),
    ]);
    commitBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'command', command: 'jollimemory.commitAI' });
    });
    mount('footer', el('div', {}, [
      el('p', { className: 'privacy-note', text: '🔒 Full conversation transcripts stay in your repo — never included in shared exports.' }),
      commitBtn,
    ]));
  }
  renderFooter();
```

Then add a `case 'worker:busy':` branch to the `window.addEventListener('message', ...)` switch statement from Task 6 (add it alongside the existing `case 'branch:conversationsData':` etc. cases, inside the same switch):

```js
      case 'worker:busy':
        if (commitBtn) commitBtn.disabled = !!msg.busy;
        return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/views/NextMemoryScriptBuilder.test.ts`
Expected: PASS (all tests in this file, both from Task 6 and Task 7)

---

## Task 8: `NextMemoryHtmlBuilder.ts`

**Files:**
- Create: `vscode/src/views/NextMemoryHtmlBuilder.ts`
- Test: `vscode/src/views/NextMemoryHtmlBuilder.test.ts`

**Interfaces:**
- Consumes: `buildNextMemoryCss` from `./NextMemoryCssBuilder.js` (Task 5), `buildNextMemoryScript` from `./NextMemoryScriptBuilder.js` (Tasks 6-7 — both already built and tested by the time this task runs).
- Produces: `export function buildNextMemoryHtml(nonce: string, cspSource: string, codiconCssUri: string): string`.

- [ ] **Step 1: Write the failing test**

Create `vscode/src/views/NextMemoryHtmlBuilder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildNextMemoryHtml } from "./NextMemoryHtmlBuilder.js";

describe("buildNextMemoryHtml", () => {
	it("includes a nonce-based CSP with no unsafe-inline", () => {
		const html = buildNextMemoryHtml("abc123", "vscode-webview://x", "https://x/codicon.css");
		expect(html).toContain("Content-Security-Policy");
		expect(html).toContain("nonce-abc123");
		expect(html).not.toContain("unsafe-inline");
	});

	it("mounts the CSS and script with the same nonce", () => {
		const html = buildNextMemoryHtml("abc123", "vscode-webview://x", "https://x/codicon.css");
		expect(html).toContain('<style nonce="abc123">');
		expect(html).toContain('<script nonce="abc123">');
	});

	it("links the codicon stylesheet", () => {
		const html = buildNextMemoryHtml("abc123", "vscode-webview://x", "https://x/codicon.css");
		expect(html).toContain("https://x/codicon.css");
	});

	it("provides mount points for the panels the script builder renders into", () => {
		const html = buildNextMemoryHtml("abc123", "vscode-webview://x", "https://x/codicon.css");
		for (const id of ["#root", "#meta-strip", "#title-panel", "#token-meter", "#conversations-panel", "#context-panel", "#files-panel", "#footer"]) {
			expect(html).toContain(id.slice(1));
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/NextMemoryHtmlBuilder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `vscode/src/views/NextMemoryHtmlBuilder.ts`:

```ts
/**
 * NextMemoryHtmlBuilder
 *
 * Document shell for the Next Memory review panel. Mount points are filled
 * in by NextMemoryScriptBuilder's client-side render calls (same pattern as
 * SidebarHtmlBuilder / SummaryHtmlBuilder: server renders an empty shell,
 * client fills it once data arrives over postMessage).
 */
import { buildNextMemoryCss } from "./NextMemoryCssBuilder.js";
import { buildNextMemoryScript } from "./NextMemoryScriptBuilder.js";

export function buildNextMemoryHtml(nonce: string, cspSource: string, codiconCssUri: string): string {
	const csp =
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
		`style-src 'nonce-${nonce}' ${cspSource}; script-src 'nonce-${nonce}'; font-src ${cspSource}; img-src data:;" />`;

	return [
		"<!doctype html>",
		"<html><head>",
		'<meta charset="utf-8">',
		csp,
		`<link rel="stylesheet" href="${codiconCssUri}">`,
		`<style nonce="${nonce}">${buildNextMemoryCss()}</style>`,
		"</head><body>",
		'<div id="root">',
		'<h1>Working Memory</h1>',
		'<div class="meta-strip" id="meta-strip"></div>',
		'<p class="muted">The full memory your next commit will save: your final review. Everything here is included; leave out an item with the ✕ on hover, or add one back with +. Nothing is committed until you choose Commit Memory below.</p>',
		'<div id="title-panel"></div>',
		'<div id="token-meter"></div>',
		'<div id="conversations-panel"></div>',
		'<div id="context-panel"></div>',
		'<div id="files-panel"></div>',
		'<div id="footer"></div>',
		"</div>",
		`<script nonce="${nonce}">${buildNextMemoryScript()}</script>`,
		"</body></html>",
	].join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/views/NextMemoryHtmlBuilder.test.ts`
Expected: PASS

---

## Task 9: Rewrite `NextMemoryPreviewPanel.ts`

**Files:**
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` (add two small snapshot accessors, next to `getNextMemorySelection` before Task 10 deletes it)
- Rewrite: `vscode/src/views/NextMemoryPreviewPanel.ts`
- Test: `vscode/src/views/SidebarWebviewProvider.test.ts` (append), rewrite `vscode/src/views/NextMemoryPreviewPanel.test.ts`

**Interfaces:**
- Consumes: `buildNextMemoryHtml` (Task 8), `registerBroadcastTarget`/`unregisterBroadcastTarget`/`handleOutbound` on `SidebarWebviewProvider` (Task 4), `getStagedDiffStats` (Task 1), `findTicketInContext` (Task 2), `sumConversationTokens` (Task 3), `bridge.generateCommitMessage()` (existing, `JolliMemoryBridge.ts:842`).
- Produces:
  - Two new public methods on `SidebarWebviewProvider`: `getPlansSnapshot(): ReadonlyArray<SerializedTreeItem>` and `getConversationsSnapshot(): ReadonlyArray<ActiveConversationItem>` — thin wrappers around the exact same provider calls `pushPlans`/`pushConversations` already make, so the panel can compute ticket/token data from the same source without a second data path.
  - `NextMemoryPreviewPanel.show(extensionUri, workspaceRoot, bridge, sidebarProvider): Promise<void>` — new signature, used by Task 10. The old `NextMemorySelection` type, `buildNextMemoryHtml` export (the old static-HTML one), and the panel's `enableScripts: false` construction are all removed.

- [ ] **Step 1: Write the failing test**

Replace the full contents of `vscode/src/views/NextMemoryPreviewPanel.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const { createWebviewPanel, postMessage } = vi.hoisted(() => {
	const postMessage = vi.fn();
	const createWebviewPanel = vi.fn(() => {
		const panel = {
			webview: { html: "", postMessage, onDidReceiveMessage: vi.fn(), asWebviewUri: (u: unknown) => u, cspSource: "vscode-webview://x" },
			reveal: vi.fn(),
			onDispose: () => {},
			onDidDispose(cb: () => void) {
				panel.onDispose = cb;
				return { dispose() {} };
			},
		};
		return panel;
	});
	return { createWebviewPanel, postMessage };
});

vi.mock("vscode", () => ({
	ViewColumn: { Active: -1 },
	window: { createWebviewPanel },
	Uri: { joinPath: (...parts: unknown[]) => parts.join("/") },
}));

import { NextMemoryPreviewPanel } from "./NextMemoryPreviewPanel.js";

function makeSidebarProvider(overrides: Record<string, unknown> = {}) {
	return {
		registerBroadcastTarget: vi.fn(),
		unregisterBroadcastTarget: vi.fn(),
		handleOutbound: vi.fn(),
		// Default to empty snapshots so tests that don't care about ticket/token
		// data (e.g. "creates a scripts-enabled webview panel") don't have to
		// stub these out just to avoid pushProposedTitle/pushTokenStats throwing
		// on an undefined method.
		getPlansSnapshot: vi.fn().mockReturnValue([]),
		getConversationsSnapshot: vi.fn().mockResolvedValue([]),
		...overrides,
	};
}

function makeBridge(overrides: Record<string, unknown> = {}) {
	return {
		generateCommitMessage: vi.fn().mockResolvedValue("feat: example"),
		...overrides,
	};
}

describe("NextMemoryPreviewPanel.show", () => {
	it("creates a scripts-enabled webview panel", async () => {
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, makeSidebarProvider() as never);
		expect(createWebviewPanel).toHaveBeenCalledWith(
			"jollimemory.nextMemoryPreview",
			"Working Memory",
			-1,
			expect.objectContaining({ enableScripts: true }),
		);
	});

	it("registers itself as a broadcast target on open and unregisters on dispose", async () => {
		const sidebarProvider = makeSidebarProvider();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, sidebarProvider as never);
		expect(sidebarProvider.registerBroadcastTarget).toHaveBeenCalledTimes(1);

		const panelInstance = createWebviewPanel.mock.results[createWebviewPanel.mock.results.length - 1].value;
		panelInstance.onDispose();
		expect(sidebarProvider.unregisterBroadcastTarget).toHaveBeenCalledTimes(1);
	});

	it("posts preview:title with the generated commit message on open", async () => {
		postMessage.mockClear();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, makeSidebarProvider() as never);
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title", title: "feat: example" }));
	});

	it("posts a degraded preview:title when generateCommitMessage throws", async () => {
		postMessage.mockClear();
		const bridge = makeBridge({ generateCommitMessage: vi.fn().mockRejectedValue(new Error("no API key")) });
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", bridge as never, makeSidebarProvider() as never);
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title", error: "no API key" }));
	});

	it("merges a detected ticket from the plans snapshot into preview:title", async () => {
		postMessage.mockClear();
		const sidebarProvider = makeSidebarProvider({
			getPlansSnapshot: vi.fn().mockReturnValue([
				{ id: "r1", label: "JOLLI-1620 · Sidebar UX redesign", contextValue: "reference", isSelected: true },
			]),
		});
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, sidebarProvider as never);
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title", title: "feat: example", ticket: "JOLLI-1620" }));
	});

	it("posts preview:tokenStats computed from the conversations snapshot", async () => {
		postMessage.mockClear();
		const sidebarProvider = makeSidebarProvider({
			getConversationsSnapshot: vi.fn().mockReturnValue([
				{ source: "codex", transcriptPath: "/x.jsonl", sessionId: "s1", isSelected: true },
			]),
		});
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, sidebarProvider as never);
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "preview:tokenStats", input: 0, output: 0, cached: 0, total: 0, reportingCount: 0, totalCount: 1 }),
		);
	});
});
```

Also append to `vscode/src/views/SidebarWebviewProvider.test.ts` (reuse this file's existing provider-construction helper, same as Task 4's tests):

```ts
describe("snapshot accessors", () => {
	it("getPlansSnapshot returns the plans provider's serialized items", () => {
		const items = [{ id: "p1", label: "Plan A", contextValue: "plan", isSelected: true }];
		const provider = makeProvider({ plansProvider: { serialize: () => items, onDidChangeTreeData: () => ({ dispose() {} }) } });
		expect(provider.getPlansSnapshot()).toEqual(items);
	});

	it("getPlansSnapshot returns an empty array when there is no plans provider", () => {
		const provider = makeProvider({ plansProvider: undefined });
		expect(provider.getPlansSnapshot()).toEqual([]);
	});

	it("getConversationsSnapshot returns the active sessions provider's items", async () => {
		const items = [{ source: "claude", sessionId: "s1", title: "t", messageCount: 1, updatedAt: "2026-01-01", transcriptPath: "/x", isEdited: false, isSelected: true }];
		const provider = makeProvider({
			activeSessionsProvider: { listWithDiagnostics: async () => ({ items, failedSources: [] }) },
		});
		expect(await provider.getConversationsSnapshot()).toEqual(items);
	});

	it("getConversationsSnapshot returns an empty array when there is no active sessions provider", async () => {
		const provider = makeProvider({ activeSessionsProvider: undefined });
		expect(await provider.getConversationsSnapshot()).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/NextMemoryPreviewPanel.test.ts`
Expected: FAIL — old `show()` signature / old exports don't match.

- [ ] **Step 3: Add the two snapshot accessors to `SidebarWebviewProvider`**

Add these two public methods to `vscode/src/views/SidebarWebviewProvider.ts`, directly above the `getNextMemorySelection` method that Task 10 deletes (so they're easy to find and remove the old method next to):

```ts
	/** Synchronous snapshot of the current Context selection (plans/notes/references), for the Next Memory review panel's ticket detection. Same source `pushPlans()` already reads. */
	getPlansSnapshot(): ReadonlyArray<SerializedTreeItem> {
		return this.deps.plansProvider?.serialize() ?? [];
	}

	/** Snapshot of the current active-conversation list, for the Next Memory review panel's token meter. Same source `pushConversations()` already reads. */
	async getConversationsSnapshot(): Promise<ReadonlyArray<ActiveConversationItem>> {
		if (!this.deps.activeSessionsProvider) return [];
		const { items } = await this.deps.activeSessionsProvider.listWithDiagnostics();
		return items;
	}
```

Confirm `ActiveConversationItem` is already imported in this file (it is — `SidebarMessages.ts:11` re-exports it and this file already uses it via the conversations data types); add the import if the type checker flags it missing.

- [ ] **Step 4: Replace the full contents of `vscode/src/views/NextMemoryPreviewPanel.ts`**

```ts
import * as vscode from "vscode";
import { getStagedDiffStats } from "../../../cli/src/core/GitOps.js";
import type { ActiveConversationItem } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { sumConversationTokens } from "../../../cli/src/core/ConversationTokenTotals.js";
import { findTicketInContext } from "../util/CommitMessageUtils.js";
import { buildNextMemoryHtml } from "./NextMemoryHtmlBuilder.js";
import type { SerializedTreeItem } from "./SidebarMessages.js";

interface Bridge {
	generateCommitMessage(): Promise<string>;
}

interface SidebarBroadcastHost {
	registerBroadcastTarget(webview: vscode.Webview): void;
	unregisterBroadcastTarget(webview: vscode.Webview): void;
	handleOutbound(raw: unknown): void;
	getPlansSnapshot(): ReadonlyArray<SerializedTreeItem>;
	getConversationsSnapshot(): Promise<ReadonlyArray<ActiveConversationItem>>;
}

let currentPanel: vscode.WebviewPanel | undefined;

function makeNonce(): string {
	let text = "";
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
	return text;
}

export class NextMemoryPreviewPanel {
	private constructor() {
		// Singleton — use NextMemoryPreviewPanel.show() instead.
	}

	static async show(
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		bridge: Bridge,
		sidebarProvider: SidebarBroadcastHost,
	): Promise<void> {
		if (!currentPanel) {
			const nonce = makeNonce();
			currentPanel = vscode.window.createWebviewPanel(
				"jollimemory.nextMemoryPreview",
				"Working Memory",
				vscode.ViewColumn.Active,
				{ enableScripts: true },
			);
			const codiconCssUri = currentPanel.webview.asWebviewUri(
				vscode.Uri.joinPath(extensionUri, "assets", "codicons", "codicon.css"),
			);
			currentPanel.webview.html = buildNextMemoryHtml(nonce, currentPanel.webview.cspSource, codiconCssUri.toString());
			currentPanel.webview.onDidReceiveMessage((msg: unknown) => {
				const m = msg as { type?: string; command?: string };
				if (m?.type === "command" && m.command === "jollimemory.regenerateNextMemoryTitle") {
					void NextMemoryPreviewPanel.pushProposedTitle(bridge, sidebarProvider);
					return;
				}
				// Every other message (branch:toggle*Selection, the reused
				// jollimemory.commitAI / addPlan / addMarkdownNote / addTextSnippet
				// command dispatches) is handled identically to the sidebar's own
				// webview — same host state, same handler, called directly since
				// both run in this one extension host process.
				sidebarProvider.handleOutbound(msg);
			});
			sidebarProvider.registerBroadcastTarget(currentPanel.webview);
			currentPanel.onDidDispose(() => {
				sidebarProvider.unregisterBroadcastTarget(currentPanel!.webview);
				currentPanel = undefined;
			});
		}
		currentPanel.reveal(vscode.ViewColumn.Active);

		await Promise.all([
			NextMemoryPreviewPanel.pushProposedTitle(bridge, sidebarProvider),
			NextMemoryPreviewPanel.pushDiffstat(workspaceRoot),
			NextMemoryPreviewPanel.pushTokenStats(sidebarProvider),
		]);
	}

	private static async pushProposedTitle(bridge: Bridge, sidebarProvider: SidebarBroadcastHost): Promise<void> {
		if (!currentPanel) return;
		const ticket = findTicketInContext(sidebarProvider.getPlansSnapshot());
		try {
			const title = await bridge.generateCommitMessage();
			void currentPanel.webview.postMessage({ type: "preview:title", title, ...(ticket ? { ticket } : {}) });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void currentPanel.webview.postMessage({ type: "preview:title", error: message });
		}
	}

	private static async pushDiffstat(workspaceRoot: string): Promise<void> {
		if (!currentPanel) return;
		const stats = await getStagedDiffStats(workspaceRoot);
		void currentPanel.webview.postMessage({ type: "preview:diffstat", ...stats });
	}

	private static async pushTokenStats(sidebarProvider: SidebarBroadcastHost): Promise<void> {
		if (!currentPanel) return;
		const conversations = await sidebarProvider.getConversationsSnapshot();
		const totals = await sumConversationTokens(
			conversations
				.filter((c) => c.isSelected)
				.map((c) => ({ source: c.source, transcriptPath: c.transcriptPath })),
		);
		void currentPanel.webview.postMessage({ type: "preview:tokenStats", ...totals });
	}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:vscode -- src/views/NextMemoryPreviewPanel.test.ts`
Expected: PASS

---

## Task 10: Wire `Extension.ts`, remove `getNextMemorySelection`, add the Regenerate command

**Files:**
- Modify: `vscode/src/Extension.ts:3221-3225` (the `jollimemory.reviewNextMemory` registration), add a new command registration for `jollimemory.regenerateNextMemoryTitle`
- Modify: `vscode/src/views/SidebarWebviewProvider.ts:1924-1963` (delete `getNextMemorySelection`)
- Modify: `vscode/package.json` (declare the new command)
- Test: update any test in `Extension.test.ts` / `SidebarWebviewProvider.test.ts` that references `getNextMemorySelection`

**Interfaces:**
- Consumes: `NextMemoryPreviewPanel.show` (Task 9's new signature), `bridge` (already in scope in `Extension.ts` at this point, per its use two lines above at `CreatePrWebviewPanel.show(..., bridge, ...)`), `sidebarProvider` (already in scope, constructed earlier in `activate()`).

- [ ] **Step 1: Write the failing test**

Search `vscode/src/views/SidebarWebviewProvider.test.ts` for `getNextMemorySelection` and delete that describe/it block entirely (it tests a method this task removes). Search `vscode/src/Extension.test.ts` for `reviewNextMemory` and update any assertion that checks the old `getNextMemorySelection()` call path to instead assert `NextMemoryPreviewPanel.show` is invoked with `(extensionUri, workspaceRoot, bridge, sidebarProvider)` — match whatever mocking convention that test file already uses for other `*WebviewPanel.show` command registrations (e.g. how it already tests `jollimemory.createPrForBranch` calling `CreatePrWebviewPanel.show`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/Extension.test.ts -t "reviewNextMemory"`
Expected: FAIL — still calls the old signature.

- [ ] **Step 3: Implement**

In `vscode/src/Extension.ts`, replace lines 3221-3225:

```ts
		// Preview the items that will be included in the next memory for this branch.
		vscode.commands.registerCommand("jollimemory.reviewNextMemory", async () => {
			const selection = await sidebarProvider.getNextMemorySelection();
			NextMemoryPreviewPanel.show(selection);
		}),
```

with:

```ts
		// Open the full-page review of the working (uncommitted) memory draft.
		vscode.commands.registerCommand("jollimemory.reviewNextMemory", async () => {
			await NextMemoryPreviewPanel.show(context.extensionUri, workspaceRoot, bridge, sidebarProvider);
		}),

		// Re-run the AI title draft shown in the review panel's Proposed title panel.
		vscode.commands.registerCommand("jollimemory.regenerateNextMemoryTitle", async () => {
			await NextMemoryPreviewPanel.show(context.extensionUri, workspaceRoot, bridge, sidebarProvider);
		}),
```

Check the exact local variable names for `workspaceRoot` / `bridge` already in scope at this point in `activate()` (they're used two command registrations above, at `jollimemory.createPrForBranch`) and match them exactly — do not introduce new variable names.

In `vscode/src/views/SidebarWebviewProvider.ts`, delete the entire `getNextMemorySelection` method (lines 1924-1963, from `public async getNextMemorySelection(): Promise<{` through its closing `}`).

In `vscode/package.json`, find the `contributes.commands` array entry for `"jollimemory.reviewNextMemory"` and add a sibling entry immediately after it:

```json
		{
			"command": "jollimemory.regenerateNextMemoryTitle",
			"title": "Jolli Memory: Regenerate Next Memory Title"
		}
```

Match the exact formatting (indentation, trailing comma placement) of the surrounding entries in that array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/Extension.test.ts -t "reviewNextMemory"`
Run: `npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts`
Expected: PASS

---

## Task 11: Final verification and commit

- [ ] **Step 1: Run the full workspace check**

Run: `npm run all`
Expected: clean → build → lint → test all pass, including the CLI coverage floor (97%/96%/97%/97% on `cli/src/`) for the new `GitOps.getStagedDiffStats` and `ConversationTokenTotals.sumConversationTokens` code from Tasks 1 and 3.

- [ ] **Step 2: Fix any lint/type/coverage fallout**

If Biome flags anything, run `npm run lint:fix` and re-check. If CLI coverage is short, add the missing branch/line assertions to `GitOps.test.ts` or `ConversationTokenTotals.test.ts` rather than weakening the threshold.

- [ ] **Step 3: Commit**

```bash
git add cli/src/core/GitOps.ts cli/src/core/GitOps.test.ts \
  cli/src/core/ConversationTokenTotals.ts cli/src/core/ConversationTokenTotals.test.ts \
  vscode/src/util/CommitMessageUtils.ts vscode/src/util/CommitMessageUtils.test.ts \
  vscode/src/views/SidebarWebviewProvider.ts vscode/src/views/SidebarWebviewProvider.test.ts \
  vscode/src/views/NextMemoryCssBuilder.ts vscode/src/views/NextMemoryCssBuilder.test.ts \
  vscode/src/views/NextMemoryHtmlBuilder.ts vscode/src/views/NextMemoryHtmlBuilder.test.ts \
  vscode/src/views/NextMemoryScriptBuilder.ts vscode/src/views/NextMemoryScriptBuilder.test.ts \
  vscode/src/views/NextMemoryPreviewPanel.ts vscode/src/views/NextMemoryPreviewPanel.test.ts \
  vscode/src/Extension.ts vscode/src/Extension.test.ts vscode/package.json

git commit -s -m "Rebuild Next Memory review panel to match the Working Memory mockup

Replaces the static, read-only three-list skeleton with a fully
interactive editor-column mirror of the sidebar's Working Memory card:
proposed AI title, real token totals, staged diffstat, and live
two-way sync with the sidebar's own selection state."
```

Expected: `git status` clean afterward.
