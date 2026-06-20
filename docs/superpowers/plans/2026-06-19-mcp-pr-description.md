# MCP `get_pr_description` Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose JolliMemory's PR-description rendering through an MCP tool (`get_pr_description`) so Claude Code can `gh pr create` with the same memory-derived title and body the VS Code extension produces, via a `jolli-pr` skill.

**Architecture:** Extract the PR-building logic that currently lives in `vscode/src/` down into `cli/src/core/` (the CLI cannot import from `vscode/`, only the reverse). The live VS Code versions are the source of truth; a stale orphan `buildPrMarkdown` in the CLI is deleted. Shared section helpers (`pushFooter`, `pushPlansAndNotesSection`) are parameterized so the CLI clipboard/folder output stays byte-for-byte unchanged while the PR path gets provider attribution + external references. A new MCP tool orchestrates: list branch commits → load summaries → pick title → build body → wrap markers. A skill wires the tool into `gh pr create`.

**Tech Stack:** TypeScript (ESM), Vitest, Biome (tabs, 120 col), `@modelcontextprotocol/sdk`, `gh` CLI.

## Global Constraints

- DCO sign-off on the final commit: `git commit -s`. No `Co-Authored-By: Claude …` trailer, no "🤖 Generated with …" footer.
- `npm run all` (clean → build → lint → test) must pass before commit — run ONCE at the end (Task 11), not per task.
- CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines for code under `cli/src/`.
- Biome: tabs, 4-wide, 120-column limit; `noExplicitAny: error`, `noUnusedImports/Variables: error`, `useImportType: warn`. `biome check --error-on-warnings` — warnings fail.
- Use `toForwardSlash` (`cli/src/core/PathUtils.ts`) for any `\`→`/` normalization; never inline-replace.
- Cross-package imports from `vscode/src/**` into `../../../cli/src/...` are intentional and resolve at esbuild bundle time — do not "clean up" into a package import.
- **Output-parity invariant:** the CLI clipboard builder `buildMarkdown` (consumed by `FolderStorage`, `SummaryExporter`, `jolli view`) must produce byte-identical output before and after this work. The PR path is the only consumer that gets references + provider attribution.
- **One-implementation invariant:** after this work, PR Markdown and the shared section helpers have exactly one implementation, in `cli/src/core/`. `vscode/` must not keep a copy.

---

## File Structure

**New CLI files:**
- `cli/src/core/MarkdownEscape.ts` — `escHtml`, `escMdLinkText`, `escMdUrl` (currently vscode-only).
- `cli/src/core/SummaryPrMarkdownBuilder.ts` — `buildPrMarkdown` + folding/escape/e2e/topic helpers (moved from vscode; replaces the deleted orphan).
- `cli/src/core/SummaryPrAggregateMarkdownBuilder.ts` — `buildAggregatedPrMarkdown` (moved from vscode).
- `cli/src/core/BranchCommitLister.ts` — `listBranchCommitHashes` + git helpers (`resolveHistoryBaseRef`, `refExists`, `findBranchCreationPoint`, `getCurrentUserName`) ported onto `GitOps.execGit`.
- `cli/src/core/PrDescription.ts` — `wrapWithMarkers` + markers, `loadBranchSummaries` (CLI port), `pickPrTitle`, `buildPrBodyMarkdown`, and the `buildPrDescription(cwd, opts)` orchestrator the MCP tool calls.
- Test files alongside each (`*.test.ts`), including the migrated PR-builder tests.

**Modified CLI files:**
- `cli/src/core/SummaryFormat.ts` — add provider-label helpers (`collectLlmSources`, `formatProviderLabel`, `PROVIDER_LABELS`).
- `cli/src/core/SummaryMarkdownBuilder.ts` — delete orphan `buildPrMarkdown` + its now-unused helpers; export + parameterize `pushFooter` / `pushPlansAndNotesSection`; export `pushRecapSection`; add `referencesBySourceOrder`.
- `cli/src/mcp/McpTools.ts` — add `runGetPrDescription`.
- `cli/src/mcp/McpServer.ts` — add tool definition + dispatch case.

**Modified VS Code files (rewire imports — no logic change):**
- `vscode/src/views/SummaryUtils.ts` — re-export the escape + provider-label helpers from CLI instead of defining them.
- `vscode/src/views/SummaryMarkdownBuilder.ts` — delete the superset helpers; import them from CLI; pass `{ includeReferences: true }` where it currently renders references so clipboard output is preserved.
- `vscode/src/views/SummaryWebviewPanel.ts` — import `buildPrMarkdown` / `buildAggregatedPrMarkdown` / `pickPrTitle` / `buildPrBodyMarkdown` from CLI; drop the now-removed local definitions.
- `vscode/src/services/PrCommentService.ts` — import `wrapWithMarkers` + marker constants from CLI.

**Deleted VS Code files:**
- `vscode/src/views/SummaryPrMarkdownBuilder.ts` (+ `.test.ts` → migrated to CLI)
- `vscode/src/views/SummaryPrAggregateMarkdownBuilder.ts` (+ `.test.ts` → migrated to CLI)

**New skill:**
- `<skills dir>/jolli-pr/SKILL.md` (alongside `jolli-recall` / `jolli-search`).

---

## Task 1: Move escape helpers to CLI `MarkdownEscape.ts`

**Files:**
- Create: `cli/src/core/MarkdownEscape.ts`
- Create: `cli/src/core/MarkdownEscape.test.ts`
- Modify: `vscode/src/views/SummaryUtils.ts` (re-export from CLI; remove local defs of `escHtml`/`escMdLinkText`/`escMdUrl`)

**Interfaces:**
- Produces: `escHtml(str: string): string`, `escMdLinkText(str: string): string`, `escMdUrl(str: string): string`

- [ ] **Step 1: Write the failing test** — `cli/src/core/MarkdownEscape.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { escHtml, escMdLinkText, escMdUrl } from "./MarkdownEscape.js";

describe("escHtml", () => {
	it("escapes &, <, >, \"", () => {
		expect(escHtml(`a & b < c > d "e"`)).toBe(`a &amp; b &lt; c &gt; d &quot;e&quot;`);
	});
});

describe("escMdLinkText", () => {
	it("backslash-escapes brackets and folds newlines", () => {
		expect(escMdLinkText("x](y)\nz")).toBe("x\\](y) z");
	});
});

describe("escMdUrl", () => {
	it("percent-encodes parens, whitespace, angle brackets, quote", () => {
		expect(escMdUrl(`http://h/a (b)<c>"d`)).toBe(`http://h/a%20%28b%29%3Cc%3E%22d`);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/MarkdownEscape.test.ts`
Expected: FAIL — cannot resolve `./MarkdownEscape.js`.

- [ ] **Step 3: Create `cli/src/core/MarkdownEscape.ts`** (verbatim from vscode `SummaryUtils.ts:128-175`)

```ts
/**
 * Markdown / HTML escaping helpers shared by the clipboard, webview, and PR
 * markdown builders. `escHtml` guards GitHub-flavored HTML tags; the `escMd*`
 * pair guards untrusted external-reference titles/URLs from breaking out of a
 * markdown link.
 */

export function escHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Escapes text for safe use as Markdown link text `[…]`. Untrusted reference
 * titles come from external trackers (Jira/Linear/GitHub/Notion), so a title
 * like `x](http://evil)` must not break out of the link and inject a phishing
 * link. Backslash-escapes `\ [ ]` and folds newlines so the line stays intact.
 */
export function escMdLinkText(str: string): string {
	return str.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

/**
 * Escapes an untrusted URL for safe use inside a Markdown link target `(…)`.
 * Percent-encodes the structure-breaking characters (parens, whitespace,
 * angle brackets, quote) so a crafted URL cannot close the link early or be
 * reinterpreted as a link title. Scheme is already whitelisted upstream
 * (`^https?://` in the adapters), so this only guards the link structure.
 */
export function escMdUrl(str: string): string {
	return str.replace(/[()\s<>"]/g, (c) => {
		if (c === "(") return "%28";
		if (c === ")") return "%29";
		return encodeURIComponent(c);
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/MarkdownEscape.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `vscode/src/views/SummaryUtils.ts`** — delete the local `escHtml` / `escMdLinkText` / `escMdUrl` definitions (vscode `SummaryUtils.ts:128-175`, keeping `escAttr` which stays vscode-local), and re-export from CLI. Add to the existing core re-export block (near the top of the file):

```ts
export { escHtml, escMdLinkText, escMdUrl } from "../../../cli/src/core/MarkdownEscape.js";
```

Leave `escAttr` defined locally (no CLI consumer needs it).

---

## Task 2: Move provider-label helpers to CLI `SummaryFormat.ts`

**Files:**
- Modify: `cli/src/core/SummaryFormat.ts` (add helpers)
- Modify: `cli/src/core/SummaryFormat.test.ts` (add tests)
- Modify: `vscode/src/views/SummaryUtils.ts` (re-export `formatProviderLabel`, `collectLlmSources`)

**Interfaces:**
- Produces: `collectLlmSources(summary: CommitSummary): ReadonlyArray<LlmCredentialSource>`, `formatProviderLabel(summary: CommitSummary): string | undefined`

- [ ] **Step 1: Write the failing test** — append to `cli/src/core/SummaryFormat.test.ts`

```ts
import { formatProviderLabel } from "./SummaryFormat.js";

describe("formatProviderLabel", () => {
	it("returns undefined when no llm source", () => {
		expect(formatProviderLabel({ children: [] } as never)).toBeUndefined();
	});
	it("maps a single source to its label", () => {
		const s = { llm: { source: "anthropic-config" }, children: [] };
		expect(formatProviderLabel(s as never)).toBe("Anthropic");
	});
	it("prefixes mixed sources", () => {
		const s = {
			llm: { source: "anthropic-config" },
			children: [{ llm: { source: "jolli-proxy" }, children: [] }],
		};
		expect(formatProviderLabel(s as never)).toBe("mixed: Anthropic, Jolli proxy");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryFormat.test.ts -t "formatProviderLabel"`
Expected: FAIL — `formatProviderLabel` is not exported.

- [ ] **Step 3: Add helpers to `cli/src/core/SummaryFormat.ts`** (verbatim from vscode `SummaryUtils.ts:47-91`). Add the `LlmCredentialSource` type import to the existing type-import block:

```ts
import type { CommitSummary, LlmCredentialSource } from "../Types.js";

const PROVIDER_LABELS: Record<LlmCredentialSource, string> = {
	"anthropic-config": "Anthropic",
	"anthropic-env": "Anthropic (env)",
	"jolli-proxy": "Jolli proxy",
};

export function collectLlmSources(summary: CommitSummary): ReadonlyArray<LlmCredentialSource> {
	const seen = new Set<LlmCredentialSource>();
	const visit = (node: CommitSummary): void => {
		if (node.llm?.source) seen.add(node.llm.source);
		for (const child of node.children ?? []) visit(child);
	};
	visit(summary);
	return [...seen];
}

export function formatProviderLabel(summary: CommitSummary): string | undefined {
	const sources = collectLlmSources(summary);
	if (sources.length === 0) return undefined;
	if (sources.length === 1) return PROVIDER_LABELS[sources[0]];
	return `mixed: ${sources.map((s) => PROVIDER_LABELS[s]).join(", ")}`;
}
```

(If `CommitSummary` is already imported in `SummaryFormat.ts`, extend that import with `LlmCredentialSource` rather than adding a second import line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryFormat.test.ts -t "formatProviderLabel"`
Expected: PASS.

- [ ] **Step 5: Rewire `vscode/src/views/SummaryUtils.ts`** — delete local `PROVIDER_LABELS` / `collectLlmSources` / `formatProviderLabel` (vscode `SummaryUtils.ts:47-91`) and re-export from CLI:

```ts
export { collectLlmSources, formatProviderLabel } from "../../../cli/src/core/SummaryFormat.js";
```

Keep `formatActiveProviderLabel` and any other locally-defined helpers that the prompt did not move.

---

## Task 3: Parameterize + export shared section helpers in CLI `SummaryMarkdownBuilder.ts`

This brings the vscode superset behavior into the CLI helpers, gated so CLI `buildMarkdown` output is unchanged.

**Files:**
- Modify: `cli/src/core/SummaryMarkdownBuilder.ts`
- Modify: `cli/src/core/SummaryMarkdownBuilder.test.ts`

**Interfaces:**
- Produces (exported):
  - `pushFooter(lines: Array<string>, summary?: CommitSummary): void`
  - `pushRecapSection(lines: Array<string>, summary: CommitSummary): void`
  - `pushPlansAndNotesSection(lines: Array<string>, summary: CommitSummary, opts?: { includeReferences?: boolean }): void`
  - `referencesBySourceOrder(references: ReadonlyArray<ReferenceCommitRef>): ReadonlyArray<ReferenceCommitRef>`

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/SummaryMarkdownBuilder.test.ts`

```ts
import {
	pushFooter,
	pushPlansAndNotesSection,
	referencesBySourceOrder,
} from "./SummaryMarkdownBuilder.js";

describe("pushFooter provider attribution", () => {
	it("omits provider when no summary passed (clipboard parity)", () => {
		const lines: string[] = [];
		pushFooter(lines);
		expect(lines.join("\n")).not.toContain(" · via ");
	});
	it("appends provider when summary has llm source", () => {
		const lines: string[] = [];
		pushFooter(lines, { llm: { source: "anthropic-config" }, children: [] } as never);
		expect(lines.join("\n")).toContain("· via Anthropic*");
	});
});

describe("pushPlansAndNotesSection references gating", () => {
	const summary = {
		plans: [],
		notes: [],
		references: [{ source: "linear", nativeId: "ENG-1", title: "Fix", url: "https://l/ENG-1" }],
	} as never;
	it("omits references by default (clipboard parity)", () => {
		const lines: string[] = [];
		pushPlansAndNotesSection(lines, summary);
		expect(lines.join("\n")).toBe("");
	});
	it("renders references when includeReferences is true", () => {
		const lines: string[] = [];
		pushPlansAndNotesSection(lines, summary, { includeReferences: true });
		expect(lines.join("\n")).toContain("[ENG-1 — Fix](https://l/ENG-1)");
	});
});

describe("referencesBySourceOrder", () => {
	it("orders linear → jira → github → notion, stable within source", () => {
		const refs = [
			{ source: "github", nativeId: "g1" },
			{ source: "linear", nativeId: "l1" },
			{ source: "github", nativeId: "g2" },
		] as never;
		expect(referencesBySourceOrder(refs).map((r) => r.nativeId)).toEqual(["l1", "g1", "g2"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryMarkdownBuilder.test.ts -t "provider attribution"`
Expected: FAIL — `pushFooter` is not exported / takes no `summary`.

- [ ] **Step 3: Edit `cli/src/core/SummaryMarkdownBuilder.ts`**

3a. Extend the top imports to add the escape + provider helpers and the reference types:

```ts
import type { CommitSummary, E2eTestScenario, ReferenceCommitRef, SourceId } from "../Types.js";
import {
	collectSortedTopics,
	formatDate,
	formatFullDate,
	formatProviderLabel,
	getDisplayDate,
	padIndex,
	type TopicWithDate,
} from "./SummaryFormat.js";
import { escMdLinkText, escMdUrl } from "./MarkdownEscape.js";
import { aggregateTurns, formatDurationLabel, resolveDiffStats } from "./SummaryTree.js";
```

3b. Replace the current private `pushFooter` (lines 259-263) with the exported superset:

```ts
/**
 * Appends the standard "Generated by Jolli Memory" footer. When `summary`
 * carries provider attribution (`llm.source`) it is appended as
 * `· via <provider>`. Clipboard/folder callers pass no `summary`, preserving
 * the original two-segment footer. Exported so the PR builders reuse it.
 */
export function pushFooter(lines: Array<string>, summary?: CommitSummary): void {
	const generatedAt = formatFullDate(new Date().toISOString());
	const provider = summary ? formatProviderLabel(summary) : undefined;
	const tail = provider ? ` · via ${provider}` : "";
	lines.push("", "---", "", `*Generated by Jolli Memory · ${generatedAt}${tail}*`);
}
```

3c. Replace the current private `pushPlansAndNotesSection` (lines 119-139) with the exported, reference-gated superset:

```ts
const REFERENCE_SOURCE_ORDER: ReadonlyArray<SourceId> = ["linear", "jira", "github", "notion"];

/**
 * Returns references ordered by source (linear → jira → github → notion),
 * preserving within-source order, so the section reads deterministically
 * across regenerations.
 */
export function referencesBySourceOrder(
	references: ReadonlyArray<ReferenceCommitRef>,
): ReadonlyArray<ReferenceCommitRef> {
	const bySource = new Map<SourceId, Array<ReferenceCommitRef>>();
	for (const e of references) {
		const arr = bySource.get(e.source) ?? [];
		arr.push(e);
		bySource.set(e.source, arr);
	}
	const out: Array<ReferenceCommitRef> = [];
	for (const source of REFERENCE_SOURCE_ORDER) {
		const arr = bySource.get(source);
		if (arr) out.push(...arr);
	}
	return out;
}

/**
 * Appends a combined Plans & Notes section — title + URL for each item.
 * External references (Linear/Jira/GitHub/Notion) are rendered only when
 * `opts.includeReferences` is set — the PR path opts in; the clipboard/folder
 * path leaves it off so its output is unchanged. Exported so PR builders reuse it.
 */
export function pushPlansAndNotesSection(
	lines: Array<string>,
	summary: CommitSummary,
	opts?: { includeReferences?: boolean },
): void {
	const plans = summary.plans ?? [];
	const notes = summary.notes ?? [];
	const references: ReadonlyArray<ReferenceCommitRef> = opts?.includeReferences ? (summary.references ?? []) : [];
	const totalCount = plans.length + notes.length + references.length;
	if (totalCount === 0) {
		return;
	}
	const countLabel = totalCount > 1 ? ` (${totalCount})` : "";
	lines.push("", `## Plans & Notes${countLabel}`, "");

	for (const plan of plans) {
		const planUrl = plan.jolliPlanDocUrl;
		lines.push(
			planUrl ? `- [${escMdLinkText(plan.title)}](${escMdUrl(planUrl)})` : `- ${escMdLinkText(plan.title)}`,
		);
	}

	for (const note of notes) {
		const noteUrl = note.jolliNoteDocUrl;
		lines.push(
			noteUrl ? `- [${escMdLinkText(note.title)}](${escMdUrl(noteUrl)})` : `- ${escMdLinkText(note.title)}`,
		);
	}

	for (const e of referencesBySourceOrder(references)) {
		lines.push(`- [${escMdLinkText(e.nativeId)} — ${escMdLinkText(e.title)}](${escMdUrl(e.url)})`);
	}
}
```

> ⚠️ **Parity note:** the CLI clipboard path previously rendered plan/note titles WITHOUT `escMdLinkText`/`escMdUrl`. For titles/URLs containing none of the escaped characters (`\ [ ] ( ) whitespace < > "`) the output is identical. Step 5 verifies the folder/clipboard snapshot is unchanged; if a fixture title contains an escapable char, treat the escaped form as the new correct output and update that one fixture (escaping is a safety fix, not a regression).

3d. Change the private `pushRecapSection` (lines 108-117) to `export function pushRecapSection` (body unchanged).

3e. **Delete the orphan `buildPrMarkdown`** (lines 55-end of that function) and any helper that becomes unused after deletion. Verify with grep which of `pushPropertiesSection` / `pushE2eTestSection` / `pushSourceCommitsSection` are still referenced by `buildMarkdown`; delete only those referenced by nothing. Run after editing:

```bash
cd cli && npx biome check src/core/SummaryMarkdownBuilder.ts
```

Biome's `noUnusedVariables: error` will flag any helper left orphaned — delete exactly those.

- [ ] **Step 4: Update CLI `buildMarkdown` call sites if needed**

`buildMarkdown` must keep calling `pushFooter(lines)` (no summary) and `pushPlansAndNotesSection(lines, summary)` (no opts) so its output is unchanged. Confirm those two call sites inside `buildMarkdown` pass no extra args. No change expected — just verify.

- [ ] **Step 5: Run tests to verify pass + clipboard parity**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryMarkdownBuilder.test.ts`
Expected: PASS, including the pre-existing `buildMarkdown` snapshot/output tests (clipboard parity). If a plan/note-title test now shows escaped output, see the parity note in 3c.

---

## Task 4: Move `SummaryPrMarkdownBuilder` to CLI

**Files:**
- Create: `cli/src/core/SummaryPrMarkdownBuilder.ts`
- Create: `cli/src/core/SummaryPrMarkdownBuilder.test.ts` (migrated from vscode)
- Delete: `vscode/src/views/SummaryPrMarkdownBuilder.ts` + `vscode/src/views/SummaryPrMarkdownBuilder.test.ts`

**Interfaces:**
- Consumes: `pushFooter`, `pushPlansAndNotesSection`, `pushRecapSection` from `./SummaryMarkdownBuilder.js`; `collectSortedTopics`, `padIndex`, `TopicWithDate` from `./SummaryFormat.js`; `escHtml` from `./MarkdownEscape.js`.
- Produces (exported): `buildPrMarkdown(summary: CommitSummary): string`, `wrapInGithubDetails`, `escapeGithubWrapperTags`, `buildScenarioBodyLines`, `pushPrE2eTestSection`, `pushPrTopicBody`.

- [ ] **Step 1: Create `cli/src/core/SummaryPrMarkdownBuilder.ts`**

Copy the body of `vscode/src/views/SummaryPrMarkdownBuilder.ts` **verbatim** (it is reproduced in full in the brainstorming exploration; the canonical current source is that file). Change ONLY the three import statements at the top:

```ts
import type { CommitSummary, E2eTestScenario } from "../Types.js";
import {
	pushFooter,
	pushPlansAndNotesSection,
	pushRecapSection,
} from "./SummaryMarkdownBuilder.js";
import { escHtml } from "./MarkdownEscape.js";
import {
	collectSortedTopics,
	padIndex,
	type TopicWithDate,
} from "./SummaryFormat.js";
```

In `buildPrMarkdown`, the call `pushPlansAndNotesSection(lines, summary)` must become `pushPlansAndNotesSection(lines, summary, { includeReferences: true })` (PR path renders references). The `pushFooter(lines, summary)` call stays as-is (PR path passes summary → provider attribution). Everything else (the four exported folding helpers, `pushPrTopicsSection`, the 65000-char limit) is copied unchanged.

- [ ] **Step 2: Migrate the test** — copy `vscode/src/views/SummaryPrMarkdownBuilder.test.ts` to `cli/src/core/SummaryPrMarkdownBuilder.test.ts`, changing import paths from `./SummaryPrMarkdownBuilder.js` (same relative name, now in core) and any `../../../cli/src/...` type imports to `../Types.js`. Add one new assertion that a summary with a `references` entry now renders the reference bullet (since the PR path opts in):

```ts
it("renders external references in the PR plans/notes section", () => {
	const md = buildPrMarkdown({
		topics: [], plans: [], notes: [],
		references: [{ source: "linear", nativeId: "ENG-9", title: "Ship", url: "https://l/ENG-9" }],
	} as never);
	expect(md).toContain("[ENG-9 — Ship](https://l/ENG-9)");
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryPrMarkdownBuilder.test.ts`
Expected: PASS.

- [ ] **Step 4: Delete the vscode originals**

```bash
git rm vscode/src/views/SummaryPrMarkdownBuilder.ts vscode/src/views/SummaryPrMarkdownBuilder.test.ts
```

(Importers are rewired in Task 7.)

---

## Task 5: Move `SummaryPrAggregateMarkdownBuilder` to CLI

**Files:**
- Create: `cli/src/core/SummaryPrAggregateMarkdownBuilder.ts`
- Create: `cli/src/core/SummaryPrAggregateMarkdownBuilder.test.ts` (migrated)
- Delete: `vscode/src/views/SummaryPrAggregateMarkdownBuilder.ts` + `.test.ts`

**Interfaces:**
- Consumes: `pushFooter`, `pushPlansAndNotesSection` from `./SummaryMarkdownBuilder.js`; `buildScenarioBodyLines`, `escapeGithubWrapperTags`, `pushPrTopicBody`, `wrapInGithubDetails` from `./SummaryPrMarkdownBuilder.js`; `collectSortedTopics`, `padIndex`, `TopicWithDate` from `./SummaryFormat.js`; `escHtml` from `./MarkdownEscape.js`.
- Produces (exported): `buildAggregatedPrMarkdown(summaries: ReadonlyArray<CommitSummary>, missingCount: number): string`.

- [ ] **Step 1: Create `cli/src/core/SummaryPrAggregateMarkdownBuilder.ts`**

Copy `vscode/src/views/SummaryPrAggregateMarkdownBuilder.ts` **verbatim** (full current source reproduced in the exploration). Change ONLY the imports:

```ts
import type {
	CommitSummary,
	E2eTestScenario,
	NoteReference,
	PlanReference,
	ReferenceCommitRef,
} from "../Types.js";
import { pushFooter, pushPlansAndNotesSection } from "./SummaryMarkdownBuilder.js";
import {
	buildScenarioBodyLines,
	escapeGithubWrapperTags,
	pushPrTopicBody,
	wrapInGithubDetails,
} from "./SummaryPrMarkdownBuilder.js";
import { escHtml } from "./MarkdownEscape.js";
import { collectSortedTopics, padIndex, type TopicWithDate } from "./SummaryFormat.js";
```

In `pushMergedPlansAndNotes`, the call `pushPlansAndNotesSection(lines, { plans, notes, references } as unknown as CommitSummary)` must become `pushPlansAndNotesSection(lines, { plans, notes, references } as unknown as CommitSummary, { includeReferences: true })`. The `pushFooter(lines)` call (no summary — aggregate footer has no provider attribution) stays unchanged. Everything else copied verbatim.

- [ ] **Step 2: Migrate the test** — copy `vscode/src/views/SummaryPrAggregateMarkdownBuilder.test.ts` to `cli/src/core/SummaryPrAggregateMarkdownBuilder.test.ts`, fixing import paths (`../Types.js`, sibling `./SummaryPrAggregateMarkdownBuilder.js`).

- [ ] **Step 3: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryPrAggregateMarkdownBuilder.test.ts`
Expected: PASS.

- [ ] **Step 4: Delete the vscode originals**

```bash
git rm vscode/src/views/SummaryPrAggregateMarkdownBuilder.ts vscode/src/views/SummaryPrAggregateMarkdownBuilder.test.ts
```

---

## Task 6: CLI `BranchCommitLister` — port the git commit-set logic

Ports only what determines the commit SET (so PR output matches vscode): base resolution, merge-base, merged-mode, author filter, `git log` hashes. Push detection / alias scanning / diff stats are intentionally NOT ported — they only affect WebView per-commit badges, never the PR body.

**Files:**
- Create: `cli/src/core/BranchCommitLister.ts`
- Create: `cli/src/core/BranchCommitLister.test.ts`

**Interfaces:**
- Consumes: `execGit` from `./GitOps.js`.
- Produces (exported): `listBranchCommitHashes(cwd: string, mainBranch: string): Promise<{ hashes: ReadonlyArray<string>; isMerged: boolean }>` — hashes newest-first (matching vscode `listBranchCommits`).

- [ ] **Step 1: Write the failing test** — `cli/src/core/BranchCommitLister.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { listBranchCommitHashes } from "./BranchCommitLister.js";

// Integration-style: build a throwaway git repo in a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("listBranchCommitHashes", () => {
	it("returns commits on the branch since merge-base with main, newest-first", () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "-b", "feature");
			git(dir, "commit", "--allow-empty", "-q", "-m", "first");
			git(dir, "commit", "--allow-empty", "-q", "-m", "second");
			return listBranchCommitHashes(dir, "main").then((res) => {
				expect(res.isMerged).toBe(false);
				expect(res.hashes.length).toBe(2); // first + second, not base
				// newest-first: HEAD ("second") first
				expect(git(dir, "log", "-1", "--pretty=%H")).toBe(res.hashes[0]);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns empty for a branch with no commits past main", () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "-b", "feature");
			return listBranchCommitHashes(dir, "main").then((res) => {
				expect(res.hashes).toEqual([]);
				expect(res.isMerged).toBe(false);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/BranchCommitLister.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `cli/src/core/BranchCommitLister.ts`**

Ports the bridge logic (appendix items 1-8) onto `GitOps.execGit` (which returns `{ stdout, exitCode }` and never throws — so `tryExecGit(...).trim()` becomes `(await execGit(args, cwd)).stdout.trim()`).

```ts
/**
 * Enumerates the commit hashes on the current branch since its merge-base with
 * main — the exact commit SET the VS Code extension uses for PR aggregation
 * (`JolliMemoryBridge.listBranchCommits`), minus the WebView-only metadata
 * (push status, diff stats, tree-hash aliases). Hashes are returned
 * newest-first; the PR loader reverses them to chronological order.
 *
 * Base resolution prefers remote mainline refs (origin/upstream) over a stale
 * local main. When the branch is fully merged (merge-base == HEAD) it switches
 * to "merged mode": reflog creation point + `--author` filter, mirroring the
 * extension's read-only post-merge history view.
 */

import { execGit } from "./GitOps.js";

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string> {
	const r = await execGit(args, cwd);
	return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
	return (await git(cwd, ["rev-parse", "--verify", "--quiet", ref])).length > 0;
}

async function resolveHistoryBaseRef(cwd: string, mainBranch: string): Promise<string> {
	const candidates = [`origin/${mainBranch}`, `upstream/${mainBranch}`, mainBranch].filter((r) => r.length > 0);
	for (const ref of candidates) {
		if (await refExists(cwd, ref)) return ref;
	}
	return mainBranch;
}

async function findBranchCreationPoint(cwd: string, branch: string): Promise<string | undefined> {
	const reflog = await git(cwd, ["reflog", "show", branch, "--format=%H %gs"]);
	if (!reflog) return undefined;
	const lines = reflog.split("\n").filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes("branch: Created from")) return lines[i].split(" ")[0];
	}
	const oldest = lines[lines.length - 1];
	return oldest.split(" ")[0];
}

export async function listBranchCommitHashes(
	cwd: string,
	mainBranch: string,
): Promise<{ hashes: ReadonlyArray<string>; isMerged: boolean }> {
	const empty = { hashes: [] as ReadonlyArray<string>, isMerged: false };

	const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
	const baseRef = await resolveHistoryBaseRef(cwd, mainBranch);
	const headHash = await git(cwd, ["rev-parse", "HEAD"]);

	let mergeBase = await git(cwd, ["merge-base", "HEAD", baseRef]);
	if (!mergeBase) return empty;

	let isMerged = false;
	let authorFilter: string | undefined;
	if (mergeBase === headHash) {
		const creationPoint = await findBranchCreationPoint(cwd, branch);
		if (!creationPoint) return empty;
		authorFilter = await git(cwd, ["config", "user.name"]);
		if (!authorFilter) return empty;
		mergeBase = creationPoint;
		isMerged = true;
	}

	const logArgs = ["log", `${mergeBase}..HEAD`, "--pretty=format:%H%x00%s%x00%an%x00%ae%x00%aI%x00%x00"];
	if (authorFilter) logArgs.push(`--author=${authorFilter}`);

	const logOutput = await git(cwd, logArgs);
	if (!logOutput) return { hashes: [], isMerged: false };

	const hashes = logOutput
		.split("\0\0\n")
		.filter((e) => e.trim().length > 0)
		.map((entry) => entry.split("\0"))
		.filter((parts) => parts.length >= 5)
		.map((parts) => parts[0]);

	return { hashes, isMerged };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/BranchCommitLister.test.ts`
Expected: PASS.

> Note: these tests shell out to real `git`. If the repo's git-op tests are gated behind `safe.bareRepository`, prefix with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all` (see project memory on git-op test flakiness).

---

## Task 7: CLI `PrDescription` — markers, summary loader, title/body, orchestrator

**Files:**
- Create: `cli/src/core/PrDescription.ts`
- Create: `cli/src/core/PrDescription.test.ts`
- Modify: `vscode/src/services/PrCommentService.ts` (import `wrapWithMarkers` + markers from CLI)
- Modify: `vscode/src/views/SummaryWebviewPanel.ts` (import `buildPrMarkdown` / `buildAggregatedPrMarkdown` / `pickPrTitle` / `buildPrBodyMarkdown` from CLI; remove local defs)
- Modify: `vscode/src/views/SummaryMarkdownBuilder.ts` (import the now-CLI superset helpers; pass `{ includeReferences: true }` where it renders references)

**Interfaces:**
- Consumes: `listBranchCommitHashes` from `./BranchCommitLister.js`; `getSummary` from `./SummaryStore.js`; `getCurrentBranch` from `./GitOps.js`; `buildPrMarkdown` / `buildAggregatedPrMarkdown`.
- Produces (exported):
  - `wrapWithMarkers(markdown: string): string`, `MARKER_START`, `MARKER_END`
  - `pickPrTitle(currentSummary, summaries): string`
  - `buildPrBodyMarkdown(currentSummary, summaries, missingCount): string`
  - `loadBranchSummaries(cwd, mainBranch): Promise<{ summaries: ReadonlyArray<CommitSummary>; missingCount: number }>`
  - `buildPrDescription(cwd, opts): Promise<PrDescriptionResult>`

- [ ] **Step 1: Write the failing test** — `cli/src/core/PrDescription.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildPrBodyMarkdown, pickPrTitle, wrapWithMarkers } from "./PrDescription.js";

const s = (msg: string, extra: object = {}): never =>
	({ commitMessage: msg, topics: [], plans: [], notes: [], children: [], ...extra }) as never;

describe("pickPrTitle", () => {
	it("uses last summary message when 2+", () => {
		expect(pickPrTitle(s("clicked"), [s("a"), s("b")])).toBe("b");
	});
	it("uses the single summary message", () => {
		expect(pickPrTitle(s("clicked"), [s("only")])).toBe("only");
	});
	it("falls back to currentSummary when none", () => {
		expect(pickPrTitle(s("clicked"), [])).toBe("clicked");
	});
});

describe("buildPrBodyMarkdown", () => {
	it("appends missing footnote in single-summary mode", () => {
		const body = buildPrBodyMarkdown(s("c"), [s("one")], 2);
		expect(body).toContain("2 commit(s) without summary were skipped");
	});
	it("aggregates for 2+ summaries (no single-mode footnote)", () => {
		const body = buildPrBodyMarkdown(s("c"), [s("a"), s("b")], 0);
		expect(body).toContain("Commits in this PR (2)");
	});
});

describe("wrapWithMarkers", () => {
	it("wraps with start/end markers", () => {
		expect(wrapWithMarkers("X")).toBe(
			"<!-- jollimemory-summary-start -->\nX\n<!-- jollimemory-summary-end -->",
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/PrDescription.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `cli/src/core/PrDescription.ts`**

```ts
/**
 * PR description assembly — the CLI source of truth for the title + body the
 * VS Code extension and the `get_pr_description` MCP tool both produce.
 *
 * `buildPrDescription` mirrors the extension step-for-step:
 *   list branch commits → load summaries (track missing) → pick title →
 *   build body → optionally wrap in idempotent update markers.
 */

import { getCurrentBranch } from "./GitOps.js";
import { listBranchCommitHashes } from "./BranchCommitLister.js";
import { buildAggregatedPrMarkdown } from "./SummaryPrAggregateMarkdownBuilder.js";
import { buildPrMarkdown } from "./SummaryPrMarkdownBuilder.js";
import { getSummary } from "./SummaryStore.js";
import type { CommitSummary } from "../Types.js";

export const MARKER_START = "<!-- jollimemory-summary-start -->";
export const MARKER_END = "<!-- jollimemory-summary-end -->";

/** Wraps markdown content with start/end markers (idempotent PR updates). */
export function wrapWithMarkers(markdown: string): string {
	return `${MARKER_START}\n${markdown}\n${MARKER_END}`;
}

/**
 * Picks the commit message to use as the PR title, mirroring
 * `buildPrBodyMarkdown`'s three-tier selection so title and body share a source.
 */
export function pickPrTitle(currentSummary: CommitSummary, summaries: ReadonlyArray<CommitSummary>): string {
	if (summaries.length >= 2) return summaries[summaries.length - 1].commitMessage;
	if (summaries.length === 1) return summaries[0].commitMessage;
	return currentSummary.commitMessage;
}

export function buildPrBodyMarkdown(
	currentSummary: CommitSummary,
	summaries: ReadonlyArray<CommitSummary>,
	missingCount: number,
): string {
	if (summaries.length >= 2) return buildAggregatedPrMarkdown(summaries, missingCount);
	const source = summaries.length === 1 ? summaries[0] : currentSummary;
	const base = buildPrMarkdown(source);
	if (missingCount <= 0 || summaries.length === 0) return base;
	return `${base}\n\n> Note: ${missingCount} commit(s) without summary were skipped.`;
}

/**
 * Loads `CommitSummary` objects for `base..HEAD` in chronological order
 * (oldest first), tracking commits with no recorded summary. CLI analogue of
 * the vscode `BranchSummaryLoader` — reads through `getSummary` (active storage)
 * instead of the vscode bridge.
 */
export async function loadBranchSummaries(
	cwd: string,
	mainBranch: string,
): Promise<{ summaries: ReadonlyArray<CommitSummary>; missingCount: number }> {
	const { hashes } = await listBranchCommitHashes(cwd, mainBranch);
	if (hashes.length === 0) return { summaries: [], missingCount: 0 };

	// listBranchCommitHashes returns newest-first; reverse for chronological order.
	const chronological = hashes.slice().reverse();
	const settled = await Promise.allSettled(chronological.map((h) => getSummary(h, cwd)));

	const summaries: Array<CommitSummary> = [];
	let missingCount = 0;
	for (const r of settled) {
		if (r.status === "fulfilled" && r.value) {
			summaries.push(r.value);
		} else {
			missingCount++;
		}
	}
	return { summaries, missingCount };
}

export interface PrDescriptionResult {
	type: "pr_description";
	branch: string;
	baseBranch: string;
	title: string;
	body: string;
	commitCount: number;
	summaryCount: number;
	missingCount: number;
}

export interface BuildPrDescriptionOpts {
	branch?: string;
	baseBranch?: string;
	includeMarkers?: boolean;
}

/**
 * Orchestrates a full PR description for a branch. Throws when the branch has
 * no recorded summaries (the caller surfaces the message to the user).
 */
export async function buildPrDescription(cwd: string, opts: BuildPrDescriptionOpts): Promise<PrDescriptionResult> {
	const branch = opts.branch ?? (await getCurrentBranch(cwd));
	const baseBranch = opts.baseBranch ?? "main";
	const includeMarkers = opts.includeMarkers ?? true;

	const { summaries, missingCount } = await loadBranchSummaries(cwd, baseBranch);
	if (summaries.length === 0) {
		throw new Error(
			`No JolliMemory summaries found on branch "${branch}" (base "${baseBranch}"). Commit memory before creating a PR.`,
		);
	}

	// summaries are chronological (oldest first); HEAD is last → currentSummary.
	const currentSummary = summaries[summaries.length - 1];
	const title = pickPrTitle(currentSummary, summaries);
	const rawBody = buildPrBodyMarkdown(currentSummary, summaries, missingCount);
	const body = includeMarkers ? wrapWithMarkers(rawBody) : rawBody;

	return {
		type: "pr_description",
		branch,
		baseBranch,
		title,
		body,
		commitCount: summaries.length + missingCount,
		summaryCount: summaries.length,
		missingCount,
	};
}
```

> **Base branch default:** `"main"` is the orchestrator default. If the repo's configured main may be `master`, resolve it before calling (the MCP tool accepts `baseBranch`). A follow-up can read the configured value; `main` matches this repo and most modern repos.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/PrDescription.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `vscode/src/services/PrCommentService.ts`** — delete local `MARKER_START` / `MARKER_END` / `wrapWithMarkers` (appendix item 14) and import from CLI; keep `MARKER_PATTERN` + `replaceSummaryInBody` local:

```ts
import { MARKER_END, MARKER_START, wrapWithMarkers } from "../../../cli/src/core/PrDescription.js";
```

(`MARKER_PATTERN` references the two constants — keep its `const` definition local, now built from the imported `MARKER_START`/`MARKER_END` if convenient, or leave the literal regex unchanged.)

- [ ] **Step 6: Rewire `vscode/src/views/SummaryWebviewPanel.ts`**

- Replace the imports (appendix item 13):
  ```ts
  import { buildAggregatedPrMarkdown } from "../../../cli/src/core/SummaryPrAggregateMarkdownBuilder.js";
  import { buildPrMarkdown } from "../../../cli/src/core/SummaryPrMarkdownBuilder.js";
  import { buildPrBodyMarkdown, pickPrTitle, wrapWithMarkers } from "../../../cli/src/core/PrDescription.js";
  ```
  (Remove the `wrapWithMarkers` import from `PrCommentService.js`; remove the two vscode builder imports.)
- Delete the module-level `buildPrBodyMarkdown` (lines 318-330) and `pickPrTitle` (lines 332-351) definitions — they are now imported from CLI.
- Leave `loadBranchSummariesForPr` and the vscode `BranchSummaryLoader` as-is (they read through the bridge's lazy `StorageProvider`; the CLI `loadBranchSummaries` is the MCP-path analogue, not a replacement).

- [ ] **Step 7: Rewire `vscode/src/views/SummaryMarkdownBuilder.ts`** — delete the local `pushFooter` / `pushPlansAndNotesSection` / `pushRecapSection` / `referencesBySourceOrder` / `REFERENCE_SOURCE_ORDER` (appendix items 16-19) and import them from CLI:

```ts
import {
	pushFooter,
	pushPlansAndNotesSection,
	pushRecapSection,
} from "../../../cli/src/core/SummaryMarkdownBuilder.js";
```

In vscode `buildMarkdown`, where it currently calls `pushPlansAndNotesSection(lines, summary)` (vscode version always rendered references), change to `pushPlansAndNotesSection(lines, summary, { includeReferences: true })` so vscode clipboard output is preserved. The `pushFooter(lines, summary)` call already passes `summary` — unchanged.

---

## Task 8: Wire the `get_pr_description` MCP tool

**Files:**
- Modify: `cli/src/mcp/McpTools.ts`
- Modify: `cli/src/mcp/McpServer.ts`
- Modify: `cli/src/mcp/McpTools.test.ts`

**Interfaces:**
- Consumes: `buildPrDescription`, `PrDescriptionResult` from `../core/PrDescription.js`.
- Produces: `runGetPrDescription(cwd, args): Promise<PrDescriptionResult>`; a `get_pr_description` entry in `TOOL_DEFINITIONS` + a `dispatchTool` case.

- [ ] **Step 1: Write the failing test** — append to `cli/src/mcp/McpTools.test.ts`

```ts
import { runGetPrDescription } from "./McpTools.js";

describe("runGetPrDescription", () => {
	it("throws a clear error when the branch has no summaries", async () => {
		// Use the existing test harness pattern in this file to point at a repo
		// with no summaries on the current branch (mirror the runRecall tests'
		// fixture/cwd setup already present above).
		await expect(runGetPrDescription(emptyRepoCwd, {})).rejects.toThrow(/No JolliMemory summaries/);
	});
});
```

> Use the same fixture/cwd construction the existing `runRecall` / `runSearch` tests in this file already use (do not invent a new harness). If those tests build a temp repo + seed summaries, add one case that seeds two commits with summaries and asserts `result.summaryCount === 2`, `result.title` equals the HEAD commit message, and `result.body` contains the `MARKER_START` when `includeMarkers` defaults on.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpTools.test.ts -t "runGetPrDescription"`
Expected: FAIL — `runGetPrDescription` is not exported.

- [ ] **Step 3: Add `runGetPrDescription` to `cli/src/mcp/McpTools.ts`**

Add the import near the other core imports:

```ts
import { buildPrDescription, type PrDescriptionResult } from "../core/PrDescription.js";
```

Add the handler:

```ts
export interface GetPrDescriptionArgs {
	branch?: string;
	baseBranch?: string;
	includeMarkers?: boolean;
}

export async function runGetPrDescription(
	cwd: string,
	args: GetPrDescriptionArgs,
): Promise<PrDescriptionResult> {
	return buildPrDescription(cwd, {
		branch: args.branch,
		baseBranch: args.baseBranch,
		includeMarkers: args.includeMarkers,
	});
}
```

- [ ] **Step 4: Register the tool in `cli/src/mcp/McpServer.ts`**

Add the import:

```ts
import { runDecisionTimeline, runGetPrDescription, runListBranches, runRecall, runSearch } from "./McpTools.js";
```

Append to `TOOL_DEFINITIONS`:

```ts
	{
		name: "get_pr_description",
		description:
			"Build a GitHub PR title + description from this branch's JolliMemory commit summaries — the same memory-rich body the VS Code extension writes. Use before `gh pr create` so the PR embeds the curated memory instead of a diff-derived summary. Omit `branch` for the current branch.",
		inputSchema: {
			type: "object",
			properties: {
				branch: { type: "string", description: "Branch to describe; defaults to current." },
				baseBranch: { type: "string", description: "Base branch for the commit range; defaults to main." },
				includeMarkers: {
					type: "boolean",
					description: "Wrap body in update markers for idempotent PR edits (default true).",
				},
			},
		},
	},
```

Add the dispatch case:

```ts
		case "get_pr_description":
			return runGetPrDescription(cwd, args as { branch?: string; baseBranch?: string; includeMarkers?: boolean });
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/`
Expected: PASS (including `McpServer.test.ts` if it asserts the tool count/list — update that assertion to expect 5 tools).

---

## Task 9: Create the `jolli-pr` skill

**Files:**
- Create: `<skills dir>/jolli-pr/SKILL.md`

Locate the skills directory by finding where `jolli-recall` lives:

```bash
find / -name SKILL.md -path "*jolli-recall*" 2>/dev/null
```

Place `jolli-pr/SKILL.md` as a sibling.

- [ ] **Step 1: Create `jolli-pr/SKILL.md`**

```markdown
---
name: jolli-pr
description: Create a GitHub PR whose title and description come from JolliMemory's commit memory for the current branch (same body the VS Code extension produces). Use when the user wants to open a PR for the current branch and have the memory embedded, instead of a diff-derived description.
---

# Creating a PR with JolliMemory description

Use this when the user asks to open a PR for the current branch and wants the
JolliMemory-curated memory in the description.

## Steps

1. **Get the description from JolliMemory.** Call the MCP tool
   `mcp__jollimemory__get_pr_description` (no args → current branch). It returns
   `{ title, body, missingCount, summaryCount, commitCount }`.
   - If the call errors with "No JolliMemory summaries…", tell the user the
     branch has no committed memory yet and stop — do not hand-write a body.

2. **Report coverage.** If `missingCount > 0`, tell the user: "N of the
   branch's commits have no memory; a footnote noting the skipped commits is
   already in the description." Then continue.

3. **Push the branch if needed.** `git push -u origin <branch>`.

4. **Create the PR.** Write `body` to a temp file and run:
   `gh pr create --title "<title>" --body-file <tmpfile>`
   Use `--body-file` (not `--body`) so multi-line markdown and special
   characters survive shell quoting.

5. **Share the PR URL** that `gh` prints.

## Hard rules

- The title and body come from the tool. Do NOT rewrite the memory body from
  the diff — that defeats the purpose. You MAY adjust the title only if the
  user explicitly asks.
- Do not add a `Co-Authored-By: Claude` trailer or a "Generated with Claude"
  footer to the PR. (The body's own "Generated by Jolli Memory" footer is the
  product's signature and stays.)
```

- [ ] **Step 2: Verify the skill is discoverable** — confirm the directory placement matches `jolli-recall` (same parent dir, same `SKILL.md` filename + frontmatter shape).

---

## Task 10: Update CLAUDE.md auth/MCP notes

**Files:**
- Modify: `CLAUDE.md` (the MCP tool list under the architecture section, if one enumerates the tools)

- [ ] **Step 1:** Grep for where the four MCP tools are described:

```bash
grep -rn "get_decision_timeline\|list_branches" CLAUDE.md cli/DEVELOPMENT.md
```

- [ ] **Step 2:** If a doc enumerates the MCP tools, add `get_pr_description` to that list with a one-line description matching the tool definition. If no such enumeration exists, skip — do not invent a new doc section.

---

## Task 11: Verify + commit

**Files:** none (verification + commit only)

- [ ] **Step 1: Run the full gate**

```bash
npm run all
```

Expected: clean → build → lint → test all pass. CLI coverage stays ≥ 97/96/97/97.

- [ ] **Step 2: Triage coverage gaps.** If the new CLI files dip below threshold, add focused unit tests (prefer the builder/orchestrator branch cases: aggregate vs single, `includeMarkers` on/off, `missingCount > 0`, merged-mode in `BranchCommitLister`). Use `/* v8 ignore start */ … /* v8 ignore stop */` blocks (single-line `ignore next` does not work in this repo) only for genuinely unreachable branches.

- [ ] **Step 3: Verify VS Code didn't regress**

```bash
npm run test:vscode -- src/views/SummaryWebviewPanel.test.ts
npm run test:vscode -- src/services/PrCommentService.test.ts
```

Expected: PASS. These confirm the import rewiring (Tasks 4, 5, 7) preserved behavior.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -s -m "feat(cli): add get_pr_description MCP tool + jolli-pr skill

Extract PR-description building from vscode/ into cli/src/core/ (PR markdown
builders, shared section helpers parameterized for clipboard parity, branch
commit lister, PR orchestrator), delete the stale orphan buildPrMarkdown, and
expose it as the get_pr_description MCP tool plus a jolli-pr skill so Claude
Code creates PRs with the same memory the VS Code extension embeds.

Implements JOLLI-1799."
```

(No Claude co-author trailer / footer — DCO `Signed-off-by` only.)

---

## Self-Review

**Spec coverage:**
- Part 1 (extract to cli, delete orphan, one-implementation invariant) → Tasks 1-7.
- Part 2 (MCP tool, input/output shape, error on no summaries, markers) → Tasks 7-8.
- Part 3 (jolli-pr skill, title/body from tool, gh --body-file, no body rewrite) → Task 9.
- Testing & gates (97% floor, migrate builder tests, no vscode regression, `npm run all`, `git commit -s`) → Tasks 4-5 (test migration), 11.
- Spec open question (baseBranch resolution) → addressed: `baseBranch` arg + `main` default, flagged for follow-up.

**Type consistency:** `buildPrDescription` returns `PrDescriptionResult` (Task 7) consumed verbatim by `runGetPrDescription` (Task 8). `listBranchCommitHashes` returns `{ hashes, isMerged }` (Task 6) consumed by `loadBranchSummaries` (Task 7). `pickPrTitle` / `buildPrBodyMarkdown` signatures match between definition (Task 7) and the vscode call sites being rewired (Task 7 Step 6). Shared-helper signatures (`pushFooter(lines, summary?)`, `pushPlansAndNotesSection(lines, summary, opts?)`) match between definition (Task 3) and all call sites (Tasks 4, 5, 7).

**Parity risks documented:** clipboard/folder output unchanged is enforced by the gating defaults (Task 3) + the existing snapshot tests (Task 3 Step 5) + vscode regression run (Task 11 Step 3). The one possible diff (escaping of plan/note titles with special chars) is called out in Task 3 with resolution guidance.
