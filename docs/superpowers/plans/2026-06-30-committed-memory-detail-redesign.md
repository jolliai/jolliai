# Committed Memory Detail Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the committed-memory row + expanded detail in the VS Code sidebar Timeline to match the mockup: hover icons (Pin / Copy Recall / Share), a `2h ago · hash · <tokens>` subline, a SHIPPED group with PR / E2E / Synced rows, and a new forward-only "conversation total tokens" metric captured at summary-generation time.

**Architecture:** Two deliverables. **(A) VS Code UI** — pure webview + host changes, no new persisted data except surfacing existing summary fields (`e2eTestGuide`, `jolliDocUrl`) plus a lazy `gh`-backed PR-status channel. **(B) Conversation token capture** — a forward-only CLI-core pipeline feature: per-source transcript parsers expose per-line usage, `readTranscript` accumulates it into `TranscriptReadResult.usageTokens`, `QueueWorker` sums it across the consumed slice, and it is stored as a new optional `CommitSummary.conversationTokens` field, then serialized onto the row and rendered in the subline.

**Tech Stack:** TypeScript (CLI ESM + VS Code esbuild CJS), Vitest, Biome. Kotlin (IntelliJ) only for backward-compatible type parity.

## Global Constraints

- DCO sign-off on every commit (`git commit -s`). No `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- `npm run all` must pass before commit (clean → build → lint → test).
- CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines (`cli/vite.config.ts`). New `cli/src/**` code must be tested.
- Biome: tabs, 120 columns, `noExplicitAny: error`, `noUnusedImports/Variables: error`.
- Use `toForwardSlash` for `\`→`/` path normalization; never inline.
- `SidebarScriptBuilder.buildSidebarScript()` body is ONE template literal — no backticks in comments inside it; quote identifiers with single/double quotes.
- VS Code webview CSP forbids inline `style=`/inline event handlers — dynamic styles via CSS class, events via `addEventListener`.
- Toggle visibility with the `.hidden` class, never the HTML `hidden` attribute.
- Token formula (user decision): `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`, summed over every assistant turn in the consumed slice.
- `conversationTokens` is **forward-only** — existing memories lack it; the subline omits the token segment when absent (never renders `0` or `NaN`).
- "Share this memory" is a **placeholder** this round (icon rendered, no behavior wired) — a separate PR implements it.

---

## File Structure

**Deliverable B (CLI core — token capture):**
- `cli/src/Types.ts` — add `TranscriptReadResult.usageTokens?: number`; add `CommitSummary.conversationTokens?: number`.
- `cli/src/core/TranscriptParser.ts` — extend `TranscriptParser` with optional `parseUsageTokens(line, lineNum): number`; implement in `ClaudeTranscriptParser` (others inherit the 0 default).
- `cli/src/core/TranscriptReader.ts` — `readTranscript` accumulates `usageTokens` across the slice it reads.
- `cli/src/hooks/QueueWorker.ts` — accumulate `conversationTokens` alongside `totalEntries`/`humanEntries`; thread into the summary build at each call site (normal / amend / squash / merge helpers).
- `cli/src/core/Summarizer.ts` — accept `conversationTokens` in build params and write it onto the summary; aggregate children's tokens for consolidated roots.
- `cli/src/core/SummaryTree.ts` — add `aggregateConversationTokens(node)` for display-side tree sums.
- `cli/src/core/Regenerator.ts`, `cli/src/core/SummaryMigration.ts` — carry `conversationTokens` through (preserve on regenerate, pass through on migration).
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/Types.kt` — add optional `conversationTokens` to the Kotlin `CommitSummary` for read parity (no pipeline change).

**Deliverable A (VS Code UI):**
- `vscode/src/views/SidebarMessages.ts` — add `conversationTokens?`, `e2eCount?` to the serialized commit item / `MemoryHover`; add `kb:requestPrStatus` (outbound) + `kb:prStatus` (inbound) message types.
- `vscode/src/providers/HistoryTreeProvider.ts` — `lookupSummary` returns `{ jolliDocUrl?, e2eCount?, conversationTokens? }`; serialize onto the row.
- `vscode/src/views/SidebarWebviewProvider.ts` — add `findOpenPrForBranch` dep; handle `kb:requestPrStatus` → post `kb:prStatus`.
- `vscode/src/Extension.ts` — wire `lookupSummary` to also return `e2eCount`/`conversationTokens`; wire `findOpenPrForBranch`.
- `vscode/src/views/SidebarScriptBuilder.ts` — hover-icon set (Pin / Copy Recall / Share); remove hover-card for memory rows; subline `2h ago · hash · tokens`; SHIPPED group (PR lazy / E2E / Synced); `formatTokens` reused.
- `vscode/src/views/SidebarCssBuilder.ts` — subline + SHIPPED + share-icon styles.
- Test files alongside each.

---

## PHASE B — Conversation token capture (do first; A's subline consumes it)

### Task B1: Types — `usageTokens` + `conversationTokens`

**Files:**
- Modify: `cli/src/Types.ts` (`TranscriptReadResult` ~line 64, `CommitSummary` ~line 318)
- Test: `cli/src/core/TranscriptReader.test.ts` (covered in B3), `cli/src/core/Summarizer.test.ts` (B5)

**Interfaces:**
- Produces: `TranscriptReadResult.usageTokens?: number`, `CommitSummary.conversationTokens?: number`.

- [ ] **Step 1: Add fields**

```ts
// TranscriptReadResult
export interface TranscriptReadResult {
	readonly entries: ReadonlyArray<TranscriptEntry>;
	readonly newCursor: TranscriptCursor;
	readonly totalLinesRead: number;
	/** Sum of per-turn token usage (input + cache_creation + cache_read + output)
	 *  over the slice read. 0 for sources whose parser does not expose usage. */
	readonly usageTokens?: number;
}

// CommitSummary — near transcriptEntries / conversationTurns
/** Total conversation token consumption (input + cache_creation + cache_read +
 *  output across assistant turns) for the turns consumed into this commit.
 *  Forward-only: absent on memories generated before this field existed, and on
 *  sources whose transcript carries no usage. Consolidated roots aggregate children. */
readonly conversationTokens?: number;
```

- [ ] **Step 2: Typecheck** — `npm run typecheck:cli` → PASS (fields are optional, no callers break).

### Task B2: Claude parser exposes per-line usage

**Files:**
- Modify: `cli/src/core/TranscriptParser.ts`
- Test: `cli/src/core/TranscriptParser.test.ts`

**Interfaces:**
- Produces: `TranscriptParser.parseUsageTokens?(line: string, lineNum: number): number`; `ClaudeTranscriptParser` implements it.

- [ ] **Step 1: Write the failing test** (fixture from the real shape observed: `message.usage` with the four fields)

```ts
import { ClaudeTranscriptParser } from "./TranscriptParser.js";

describe("ClaudeTranscriptParser.parseUsageTokens", () => {
	const p = new ClaudeTranscriptParser();
	it("sums input + cache_creation + cache_read + output", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }],
				usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 5 } },
		});
		expect(p.parseUsageTokens(line, 1)).toBe(425);
	});
	it("returns 0 for human/user lines and malformed JSON", () => {
		expect(p.parseUsageTokens(JSON.stringify({ type: "user", message: { role: "user", content: "x" } }), 1)).toBe(0);
		expect(p.parseUsageTokens("{not json", 1)).toBe(0);
	});
});
```

- [ ] **Step 2: Run** — `npm run test -w @jolli.ai/cli -- src/core/TranscriptParser.test.ts` → FAIL (method undefined).

- [ ] **Step 3: Implement** — add to the `TranscriptParser` interface `parseUsageTokens?(line: string, lineNum: number): number;` and implement on `ClaudeTranscriptParser`:

```ts
parseUsageTokens(line: string): number {
	try {
		const o = JSON.parse(line) as { message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown> };
		const u = o.message?.usage ?? o.usage;
		if (!u || typeof u !== "object") return 0;
		const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
		return n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("output_tokens");
	} catch {
		return 0;
	}
}
```

- [ ] **Step 4: Run** → PASS.

### Task B3: `readTranscript` accumulates `usageTokens`

**Files:**
- Modify: `cli/src/core/TranscriptReader.ts` (`readTranscript`, ~line 83)
- Test: `cli/src/core/TranscriptReader.test.ts`

**Interfaces:**
- Consumes: `parser.parseUsageTokens` (B2).
- Produces: `readTranscript(...).usageTokens` summed over the lines it reads.

- [ ] **Step 1: Failing test** — read a 2-line Claude fixture (one assistant turn with usage 425, one human) and assert `result.usageTokens === 425`.

- [ ] **Step 2: Run** → FAIL (`usageTokens` undefined).

- [ ] **Step 3: Implement** — in the per-line loop, `usageTokens += parser.parseUsageTokens?.(line, lineNum) ?? 0;` and include `usageTokens` in the returned object.

- [ ] **Step 4: Run** → PASS.

### Task B4: QueueWorker sums `conversationTokens` across the consumed slice

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts` (read loop ~2944-2953; squash helper ~2843; pass-through at ~1597, ~1637, ~2245, ~2455, ~2484, ~2621, ~2180)
- Test: `cli/src/hooks/QueueWorker.test.ts`

**Interfaces:**
- Consumes: `result.usageTokens` (B3).
- Produces: `{ transcriptEntries, conversationTurns, conversationTokens }` stats object passed to the summary build.

- [ ] **Step 1: Failing test** — drive the read path with two Claude sessions (usage 425 + 1000) and assert the built summary has `conversationTokens === 1425`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — declare `let conversationTokens = 0;` next to `totalEntries`; in the read loop add `conversationTokens += result.usageTokens ?? 0;` (and in the squash helper at ~2843 sum `s` sessions' tokens if available, else 0). Add `conversationTokens` to every `{ transcriptEntries, conversationTurns }` stats object threaded into `buildCommitSummary`.

- [ ] **Step 4: Run** → PASS.

### Task B5: Summarizer writes + aggregates `conversationTokens`

**Files:**
- Modify: `cli/src/core/Summarizer.ts` (build params ~80/97, write ~264; consolidate aggregation ~1471)
- Test: `cli/src/core/Summarizer.test.ts`

**Interfaces:**
- Consumes: stats `conversationTokens` (B4).
- Produces: `CommitSummary.conversationTokens` on leaf + aggregated on consolidated root.

- [ ] **Step 1: Failing tests** — (a) leaf: build params with `conversationTokens: 1425` → summary carries it; (b) consolidate: root tokens = sum of two children (300 + 700 → 1000).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — add `readonly conversationTokens?: number;` to the build-params types; spread `...(params.conversationTokens !== undefined && { conversationTokens: params.conversationTokens })` into the summary (mirror the `conversationTurns` pattern at line 265). In the consolidate path, set `conversationTokens` to the sum of source summaries' tokens.

- [ ] **Step 4: Run** → PASS.

### Task B6: SummaryTree display-side aggregate + carry-through

**Files:**
- Modify: `cli/src/core/SummaryTree.ts` (add `aggregateConversationTokens`); `cli/src/core/Regenerator.ts` (preserve field); `cli/src/core/SummaryMigration.ts` (pass through both v3/v5 paths ~309/331)
- Test: `cli/src/core/SummaryTree.test.ts`

**Interfaces:**
- Produces: `aggregateConversationTokens(node: CommitSummary): number` = node's own (or 0) + recursive children sum.

- [ ] **Step 1: Failing test** — node with `conversationTokens: 100` and two children (200, 300) → `aggregateConversationTokens` returns 600.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — mirror `aggregateTurns` (line 67). Add `...(record.conversationTokens !== undefined && { conversationTokens: record.conversationTokens })` to both migration object builders and the Regenerator preserved-fields object.

- [ ] **Step 4: Run** → PASS, then `npm run test:cli` (full) → coverage holds.

### Task B7: Kotlin type parity (read-only)

**Files:**
- Modify: `intellij/src/main/kotlin/ai/jolli/jollimemory/core/Types.kt` (`CommitSummary`)

- [ ] **Step 1:** add `val conversationTokens: Int? = null` to the Kotlin `CommitSummary` data class so deserialization of new orphan-branch summaries does not drop the field on round-trip.
- [ ] **Step 2:** `cd intellij && ./gradlew compileKotlin` → PASS. (No IntelliJ UI change this round.)

---

## PHASE A — VS Code committed-memory UI

### Task A1: Serialize `e2eCount` + `conversationTokens` onto the row

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts` (`MemoryHover` + commit item); `vscode/src/providers/HistoryTreeProvider.ts` (`lookupSummary` return + `serializeNode`); `vscode/src/Extension.ts` (lookupSummary wiring)
- Test: `vscode/src/providers/HistoryTreeProvider.test.ts`

**Interfaces:**
- Produces: serialized commit item gains `e2eCount?: number`, `conversationTokens?: number`; `lookupSummary(hash) => { jolliDocUrl?, e2eCount?, conversationTokens? }`.

- [ ] **Step 1: Failing test** — `serializeNode` of a committed commit whose `lookupSummary` returns `{ e2eCount: 3, conversationTokens: 1_400_000 }` yields a row item with those fields.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — widen the `lookupSummary` type to `{ jolliDocUrl?: string; e2eCount?: number; conversationTokens?: number }`; in `serializeNode` spread the two new fields when present; in `Extension.ts` compute `e2eCount: s.e2eTestGuide?.length` and `conversationTokens: aggregateConversationTokens(s)`.
- [ ] **Step 4: Run** → PASS.

### Task A2: PR-status lazy channel

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts` (msg types); `vscode/src/views/SidebarWebviewProvider.ts` (dep + handler); `vscode/src/Extension.ts` (wire dep)
- Test: `vscode/src/views/SidebarWebviewProvider.test.ts`

**Interfaces:**
- Outbound (webview→host): `{ type: "kb:requestPrStatus"; branch: string }`.
- Inbound (host→webview): `{ type: "kb:prStatus"; branch: string; pr: { number: number; url: string } | null }`.
- Dep: `findOpenPrForBranch?: (branch: string) => Promise<{ number: number; url: string } | undefined>`.

- [ ] **Step 1: Failing test** — triggering `kb:requestPrStatus` with a wired `findOpenPrForBranch` returning `{number:214,url:"…"}` posts `kb:prStatus` with that pr; a rejecting dep posts `pr: null` (never throws).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — handler calls the dep (try/catch → null), posts `kb:prStatus`. `Extension.ts` wires `findOpenPrForBranch: (branch) => findOpenPrForBranch(bridge.cwd, branch)` (import from `PrCommentService`).
- [ ] **Step 4: Run** → PASS.

### Task A3: Hover icons (Pin / Copy Recall / Share) + remove memory hover-card

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` (inline-actions ~4269-4303; hover-card mouseover gate ~2776); `vscode/src/views/SidebarCssBuilder.ts` (share icon)
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

- [ ] **Step 1: Failing tests** — committed-memory row inline-actions contain `data-inline='pin'`, `data-inline='copy-recall'`, `data-inline='share'`; do NOT contain `data-inline='viewSummary'`; the branch-hover mouseover handler skips `commitWithMemory` rows (assert the guard expression present).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — replace the workspace-row `{Pin, View Memory}` action set with `{Pin, Copy Recall, Share}` (Share = `data-inline='share'`, codicon `codicon-link`/`codicon-export`, tooltip "Share this memory", click handler is a documented no-op placeholder). Foreign rows keep `{Copy Recall, Share}` (Pin suppressed). Gate `scheduleShowBranchHoverCard` to return early when the row's context is `commitWithMemory` (the subline + expanded detail replace the card). Add `.share-icon` CSS only if a new glyph needs sizing.
- [ ] **Step 4: Run** → PASS.

### Task A4: Row subline `2h ago · hash · tokens`

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` (`renderCommitRow` ~4197, after the title row); `vscode/src/views/SidebarCssBuilder.ts`
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

**Interfaces:**
- Consumes: `item.hover.relativeDate`, `item.hover.shortHash`, `item.conversationTokens` (A1); `formatTokens` (existing ~3351).

- [ ] **Step 1: Failing test** — committed row renders a `.mem-subline` with `relativeDate`, `shortHash`, and `formatTokens(conversationTokens)+' tokens'`; when `conversationTokens` is undefined the token segment is omitted (no `· undefined`, no ` tokens` with empty value).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — build a `.mem-subline` row of dot-separated `.mem-sub-seg` spans: relativeDate, shortHash (monospace), and — only when `typeof item.conversationTokens === 'number'` — `formatTokens(item.conversationTokens) + ' tokens'`. Add `.mem-subline`/`.mem-sub-seg`/separator CSS.
- [ ] **Step 4: Run** → PASS.

### Task A5: SHIPPED group — PR / E2E / Synced rows

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` (SHIPPED group ~4341-4376; add PR-status response handler + request trigger on expand); `vscode/src/views/SidebarCssBuilder.ts`
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

**Interfaces:**
- Consumes: `item.jolliDocUrl`, `item.e2eCount` (A1); `kb:requestPrStatus`/`kb:prStatus` (A2).

- [ ] **Step 1: Failing tests** —
  - SHIPPED renders a Synced row: when `jolliDocUrl` present → "Synced to Jolli — open article" + `SYNCED` badge + link; absent → "Not pushed — Push to Jolli" action.
  - E2E row renders only when `e2eCount > 0`: "E2E test guide — N scenarios".
  - On memory expand, the client posts `kb:requestPrStatus` with the branch, and the `kb:prStatus` handler injects a `PR #N — open` + `OPEN` badge row (or renders nothing on `pr: null`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — restructure `shippedGroup` to three conditional rows in order PR / E2E / Synced. PR row starts as a `Loading…`/absent placeholder and is filled by the `kb:prStatus` handler keyed by branch (reuse the evidence lazy-cache pattern: request once on expand, render on response). E2E row gated on `e2eCount`. Synced row reuses the existing jolliDocUrl branch. Add badge CSS (`.ship-badge--open`, reuse cloud-synced hue for SYNCED).
- [ ] **Step 4: Run** → PASS.

### Task A6: Full verification

- [ ] **Step 1:** `npm run all` → clean/build/lint/test all PASS; CLI coverage ≥ floor; vscode coverage holds.
- [ ] **Step 2:** Manual: `cd vscode && npm run deploy` + Reload Window; expand a committed memory → verify hover icons, subline, SHIPPED rows, and that file clicks open diffs (regression guard from prior fix).
- [ ] **Step 3:** Commit (`git commit -s`), no Claude trailers.

---

## Self-Review Notes

- **Spec coverage:** (1) hover icons → A3; (2) subline time/hash/tokens → A4 (tokens) + B1-B7 (data); (3) SHIPPED PR/E2E/Synced → A5 + A2 (PR) + A1 (e2e). ✔
- **Forward-only token:** B is the only source of `conversationTokens`; A4 omits the segment when absent — existing memories degrade cleanly. ✔
- **Type consistency:** `conversationTokens` used identically in Types (B1), Summarizer (B5), SummaryTree.`aggregateConversationTokens` (B6), serialize (A1), render (A4). `findOpenPrForBranch` return `{number,url}` matches A2 message + A5 render. ✔
- **Observed Reality (per integrating-external-systems):** Claude raw transcript `message.usage` confirmed on a live file (`input/cache_creation/cache_read/output`); archived `entries` and `StoredTranscript` do NOT carry usage; raw transcripts are trimmed/deleted post-commit → capture must happen at summary time (B4). Non-Claude sources: usage extraction not yet observed → their `parseUsageTokens` defaults to 0 (best-effort, documented), a follow-up per source.
