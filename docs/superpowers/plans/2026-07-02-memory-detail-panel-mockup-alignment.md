# Commit Memory detail panel — mockup alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the VS Code Commit Memory detail panel (`SummaryWebviewPanel` + its `Summary*Builder` trio) to the `pane-memory` / `pane-memory-local` mockup, and wire a real per-memory token breakdown from the transcript parsers.

**Architecture:** Presentation + wiring changes in the three `Summary*Builder` files (structure / CSS / script), preserving every existing element id and message handler. The token meter consumes the per-memory `conversationTokenBreakdown` that already exists on the branch base (`b0d3ca21`) — no CLI work. The Files panel reuses the existing `parseDiffNameStatus` + `git diff --name-status` pipeline already used by the Create PR pane. This branch was rebased onto `vscode-ui-redesign` so `b0d3ca21` is in its history.

**Tech Stack:** TypeScript (CLI = ESM, VS Code = esbuild→CJS), Vitest, Biome. Spec: [`docs/superpowers/specs/2026-07-02-memory-detail-panel-mockup-alignment-design.md`](../specs/2026-07-02-memory-detail-panel-mockup-alignment-design.md).

## Global Constraints

- **Commit cadence:** each task ends with its own commit (`git commit -s`, DCO sign-off). Inside each task: write the failing test, run only that focused test file to see red/green, write the implementation, then commit. **Do NOT run the full `npm run all` gate per task** — that runs once at the end (Task 12). After the final review is clean, the whole branch is **squashed into a single commit** (controller does this in Task 12).
- **No `Co-Authored-By: Claude …` trailer, no `🤖 Generated with …` footer** on any commit (per-task or squashed) — DCO `Signed-off-by:` only (added by `-s`).
- **CLI coverage floor:** 97% statements / 96% branches / 97% functions / 97% lines. New CLI code must be covered.
- **Strict webview CSP** — no inline `style=""`, no inline event handlers. Dynamic styles go through CSS classes or JS property writes (`el.style.width = …` after load); events via `addEventListener`. (Reference: `SummaryCssBuilder`/`SummaryScriptBuilder` already follow this.)
- **`toForwardSlash` for `\`→`/`** — never inline `path.replace(/\\/g,"/")`.
- **Preserve every existing element id + message handler.** New messages are additive only.
- **Builder tests are structural** (assert presence/order of classes + ids), not pixel/visual. CSS ports carry no test of their own beyond "the class is emitted".
- **Real fixtures only** for the Claude token-breakdown parser test — pin a real transcript line, never a hand-invented one.
- **Three `parseUsageTokens` / `parseDiffNameStatus` copies stay in lockstep** — extend the shared implementation, do not fork a new copy.
- **Mockup is the authority.** Verbatim target markup for each section is quoted from `jollimemory-design/vscode-interactive.html` (`pane-memory`, `pane-memory-local`).

---

## File structure

**CLI (data vertical) — NONE.** The per-memory token breakdown already exists on the
branch base (`b0d3ca21`): `ConversationTokenBreakdown { input, output, cached }` in
`cli/src/Types.ts` plus the per-summary `conversationTokenBreakdown?` field, its
`SummaryTree` aggregation, and the `QueueWorker` threading. No CLI files change in this
plan — Task 6 only consumes the existing field. (See the retired Tasks 1–3 note.)

**VS Code (presentation — Tasks 4–11):**
- `vscode/src/views/SummaryHtmlBuilder.ts` — the section builders.
- `vscode/src/views/SummaryCssBuilder.ts` — ported mockup classes.
- `vscode/src/views/SummaryScriptBuilder.ts` — toggles + bindings.
- `vscode/src/views/SummaryWebviewPanel.ts` — new additive inbound messages (`openFileDiff`, `conversationDetach` if absent) + Files-row plumbing.
- Tests alongside each (`*.test.ts`).

---

## Tasks 1–3: CLI token-breakdown vertical — RETIRED (already shipped on the branch base)

**Do not implement.** The per-memory token breakdown these tasks would have built
already exists on the branch this one was rebased onto — commit `b0d3ca21`
("Add token usage breakdown tracking for VS Code sidebar rendering"). It provides,
correctly and with tests:

- `ConversationTokenBreakdown = { readonly input: number; readonly output: number; readonly cached: number }`
  in `cli/src/Types.ts`. **Three fields, not four:** `cached` is `cache_creation_input_tokens`
  only. `cache_read_input_tokens` is EXCLUDED — it is a per-turn running total, so summing
  it across a slice re-counts the cached prefix and inflates the total ~10× (guarded by the
  `ClaudeTranscriptParser` "C6" regression test). The invariant is `input + output + cached === conversationTokens`.
- The optional per-summary field `conversationTokenBreakdown?: ConversationTokenBreakdown`
  on the summary node types (already aggregated across consolidation trees in `SummaryTree.ts`
  and threaded through `QueueWorker.ts`).

Task 6 (token meter) below CONSUMES `summary.conversationTokenBreakdown` directly. No CLI
work remains for this plan. (Original Tasks 1–3 — a 4-field `UsageBreakdown` with `cacheRead`
summed in — were wrong: they would have reintroduced the cache_read inflation bug and
duplicated `b0d3ca21`. Retired after the Task 1 implementer escalated the conflict.)

Execution starts at Task 4.


## Task 4: VS Code — ship bar → single Jolli card

**Files:**
- Modify: `vscode/src/views/SummaryHtmlBuilder.ts` — `buildShipBar` (lines 371–398)
- Modify: `vscode/src/views/SummaryCssBuilder.ts` — ship-card chip state classes
- Modify: `vscode/src/views/SummaryScriptBuilder.ts` — only if a binding referenced `#prCard`
- Test: `vscode/src/views/SummaryHtmlBuilder.test.ts`

**Interfaces:**
- Consumes: `summary.jolliDocUrl` (synced?), existing `#pushJolliBtn` handler, `buildJolliRow`.
- Produces: a `.ship-bar` with exactly one `.ship-card#jolliCard`, no `#prCard`.

- [ ] **Step 1: Pre-flight — confirm `#prCard` removal is handler-safe**

Run: `grep -rn "prCard\|prSection\|#prSection\|createPr\|pushBranch" vscode/src/views/SummaryScriptBuilder.ts vscode/src/views/SummaryWebviewPanel.ts`
If any handler is reachable ONLY from the detail panel and still required, note it and hide `#prSection` with `.hidden` instead of deleting (preserve handler). Expectation: the Create PR flow lives in `CreatePrHtmlBuilder`'s pane, so removal is safe.

- [ ] **Step 2: Write the failing test**

```ts
it("ship bar renders a single Jolli card and no PR card", () => {
	const html = buildShipBar(makeSummary({ jolliDocUrl: "https://jolli.ai/x" }));
	expect(html).toContain('class="ship-card"');
	expect(html).not.toContain('id="prCard"');
	expect(html).toContain('codicon-arrow-swap');
	expect(html).toContain(">Jolli<"); // name, not "Jolli Memory"
	expect(html).toContain("Open in Jolli");
});

it("ship bar shows LOCAL chip + Push when not synced", () => {
	const html = buildShipBar(makeSummary({ jolliDocUrl: undefined }));
	expect(html).toContain("local-chip");
	expect(html).toContain("Push to Jolli");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "ship bar"`
Expected: FAIL — still emits `#prCard` / "Jolli Memory".

- [ ] **Step 4: Rewrite `buildShipBar`**

Target markup (from `pane-memory` / `pane-memory-local`), driven by `synced = !!summary.jolliDocUrl`:

```ts
function buildShipBar(summary: CommitSummary): string {
	const synced = !!summary.jolliDocUrl;
	const chip = synced
		? `<span class="ship-status is-ok"><span class="led"></span>SYNCED</span>`
		: `<span class="ship-status local-chip"><span class="led"></span>LOCAL</span>`;
	const sub = synced
		? `<div class="ship-sub">Auto-synced to your Jolli Space — kept up to date automatically.</div>`
		: `<div class="ship-sub">Not synced yet. Share once — updates then stay in sync automatically.</div>`;
	const action = synced
		? `<button class="action-btn" id="pushJolliBtn">Open in Jolli</button>`
		: `<button class="action-btn" id="pushJolliBtn">Push to Jolli</button>`;
	return `
<div class="ship-bar">
  <div class="ship-card" id="jolliCard">
    <div class="ship-head">
      <span class="ship-icon codicon codicon-arrow-swap"></span>
      <span class="ship-name">Jolli</span>
      ${chip}
    </div>
    ${sub}
    ${buildJolliRow(summary.jolliDocUrl, summary.commitMessage, summary.plans, summary.notes)}
    <div class="ship-actions">${action}</div>
  </div>
</div>`;
}
```

Keep `#pushJolliBtn` (the existing handler switches on synced state to open vs push — verify the handler still branches correctly; if the old label drove behavior, switch the handler to branch on `summary.jolliDocUrl`/a data attribute instead of button text).

- [ ] **Step 5: Add CSS for chip states**

In `SummaryCssBuilder.ts` add `.ship-status.local-chip` (warn tone) styling if not present, and confirm `.ship-status.is-ok` exists. Port colors from the mockup's `.local-chip` / `.is-ok` rules.

- [ ] **Step 6: Run to verify green**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "ship bar"`
Expected: PASS.

---

## Task 5: VS Code — meta strip + `.mem-details` reshape

**Files:**
- Modify: `SummaryHtmlBuilder.ts` — `buildHeader` (lines 289–359)
- Modify: `SummaryCssBuilder.ts` — `.meta-strip` Share/Export buttons, dotted `Details`, `.mem-details`/`.md-row`
- Modify: `SummaryScriptBuilder.ts` — Details toggle (keep `#detailsToggle`), Export menu binding
- Test: `SummaryHtmlBuilder.test.ts`

**Interfaces:**
- Consumes: `summary.commitHash`, `summary.branch`, display date, `summary.commitAuthor`, `summary.llm` ({model, inputTokens, outputTokens}), `transcriptHashSet.size`, `summary.plans/notes/references`, `summary.filesAffected`.
- Produces: meta strip `hash · branch · time · Details · [Share][Export]`; `#propTable` id retained, content = 4 `.md-row`.

- [ ] **Step 1: Write the failing test**

```ts
it("meta strip carries Share and Export and drops author/changes inline", () => {
	const html = buildHeader(makeSummary(), 3, 10, 2, false);
	expect(html).toContain("meta-share");
	expect(html).toContain("meta-export");
	expect(html).toContain("details-toggle"); // dotted Details toggle kept
});

it("details table keeps #propTable id and shows the four mem-details rows", () => {
	const html = buildHeader(makeSummary({ llm: { model: "claude-sonnet-4-6", inputTokens: 1500, outputTokens: 600 } }), 3, 10, 2, false);
	expect(html).toContain('id="propTable"');
	expect(html).toContain("Summary by");
	expect(html).toContain("Linked");
	expect(html).not.toContain(">Duration<");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "meta strip|details table"`
Expected: FAIL.

- [ ] **Step 3: Rewrite the meta strip + details table in `buildHeader`**

Target meta strip: `hash · branch · time · Details(dotted) · Share · Export`. Move author/date/changes out. Keep `#detailsToggle` (restyle to dotted). Replace the old `.header-actions` split button with an Export button whose menu holds Copy Markdown / Save as Markdown File (retain those ids: `#copyMdBtn`, `#downloadMdBtn`). Retain `#regenerateSummaryBtn` (foreign-omitted) inside the Export menu.

Details table (keep `id="propTable"`, class `.mem-details`, rows `.md-row > .md-k + .md-v`):
- **Commit**: `${shortHash}` + existing `.hash-copy` button (keep `data-hash`).
- **Author**: `${escHtml(summary.commitAuthor)} · ${formatFullDate(getDisplayDate(summary))}`.
- **Summary by**: `${summary.llm?.model ?? "—"}` + `<span class="tok-bd">· ${fmt(summary.llm ? summary.llm.inputTokens + summary.llm.outputTokens : 0)} tokens to write this summary</span>` (omit the span when no `llm`).
- **Linked**: `${convCount} conversation(s) · ${ctxCount} context · ${fileCount} file(s)` where convCount = `transcriptHashSet?.size ?? 0` (thread it into `buildHeader`), ctxCount = plans+notes+references length, fileCount = `summary.filesAffected?.length ?? totalFiles`.

Update the `buildHtml` call site (line 155) to pass `transcriptHashSet` into `buildHeader`.

- [ ] **Step 4: CSS + script**

CSS: `.meta-share`/`.meta-export` buttons, dotted `.details-toggle`, `.mem-details`/`.md-row`/`.md-k`/`.md-v`/`.tok-bd`. Script: keep the `#detailsToggle` → `#propTable` `.hidden`/`aria-expanded` toggle (verify the toggle still targets `#propTable`); wire the Export menu open/close via `addEventListener`.

- [ ] **Step 5: Run to verify green**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "meta strip|details table"`
Expected: PASS.

---

## Task 6: VS Code — token meter (`buildTokenMeter`)

**Files:**
- Modify: `SummaryHtmlBuilder.ts` — new `buildTokenMeter(summary)`, inserted in `buildHtml` between `buildHeader` and `buildShipBar` (after line 155)
- Modify: `SummaryCssBuilder.ts` — `.tmeter*`, `.seg-*`, `.tok-help*`, `.tmeter.na`
- Modify: `SummaryScriptBuilder.ts` — `?` help pin toggle; set segment widths from `data-pct` after load
- Test: `SummaryHtmlBuilder.test.ts`

**Interfaces:**
- Consumes: `summary.conversationTokens` and the EXISTING `summary.conversationTokenBreakdown: ConversationTokenBreakdown` (`{ input, output, cached }` — 3 fields, `cached` = cache_creation only, cache_read excluded; shipped in `b0d3ca21`, see the retired Tasks 1–3 note). Invariant: `input + output + cached === conversationTokens`. Import the `ConversationTokenBreakdown` type from the CLI types — do NOT invent a `UsageBreakdown`.
- Produces: `buildTokenMeter(summary: CommitSummary): string`.

- [ ] **Step 1: Write the failing test**

```ts
it("token meter shows total + segmented bar when a breakdown exists", () => {
	const html = buildTokenMeter(makeSummary({
		conversationTokens: 1443000,
		conversationTokenBreakdown: { input: 96000, output: 47000, cached: 1300000 },
	}));
	expect(html).toContain("tmeter");
	expect(html).toContain("seg-in");
	expect(html).toContain("seg-out");
	expect(html).toContain("seg-cache");
	expect(html).toContain("tmeter-legend");
	expect(html).not.toContain("tmeter na");
});

it("token meter renders the na state when usage is unreported", () => {
	const html = buildTokenMeter(makeSummary({ conversationTokens: undefined }));
	expect(html).toContain("tmeter na");
	expect(html).toContain("Task usage not reported");
	expect(html).not.toContain("tmeter-bar");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "token meter"`
Expected: FAIL — `buildTokenMeter` not defined.

- [ ] **Step 3: Implement `buildTokenMeter`**

```ts
import type { ConversationTokenBreakdown } from "../../../cli/src/Types.js"; // resolves at esbuild bundle time

/** Rough cache-aware $ estimate at Sonnet pricing. `cached` (= cache_creation) is
 *  priced at the cache-write rate; input/output at their standard rates. See spec §4.2. */
function estimateCost(b: ConversationTokenBreakdown | undefined, total: number): string { /* simple per-token constants */ }

function buildTokenMeter(summary: CommitSummary): string {
	const total = summary.conversationTokens ?? 0;
	if (total <= 0) {
		return `
<div class="tmeter na">
  <div class="tmeter-head"><span class="tmeter-total">Task usage not reported</span>
    <span class="tok-help-wrap"><button class="tok-help" type="button">?</button>
      <span class="tok-pop">No session on this memory reports token usage, so there's nothing to total.</span></span>
  </div>
</div>`;
	}
	const b = summary.conversationTokenBreakdown; // { input, output, cached } | undefined
	const pct = (n: number) => Math.round((n / total) * 100);
	const bar = b
		? `<div class="tmeter-bar">
    <span class="seg-in" data-pct="${pct(b.input)}"></span>
    <span class="seg-out" data-pct="${pct(b.output)}"></span>
    <span class="seg-cache" data-pct="${pct(b.cached)}"></span>
  </div>
  <div class="tmeter-legend">
    <span><i class="lg-dot seg-in"></i>${fmt(b.input)} input</span>
    <span><i class="lg-dot seg-out"></i>${fmt(b.output)} output</span>
    <span><i class="lg-dot seg-cache"></i>${fmt(b.cached)} cached</span>
  </div>`
		: `<div class="tmeter-bar"><span class="seg-in" data-pct="100"></span></div>`; // total-only degrade
	return `
<div class="tmeter">
  <div class="tmeter-head"><span class="tmeter-total">${fmt(total)}</span> tokens · <span class="tmeter-cost">${estimateCost(b, total)}</span> · this task
    <span class="tok-help-wrap"><button class="tok-help" type="button">?</button>
      <span class="tok-pop">Counts input + output + cache-creation across sessions (cache reads are excluded — they double-count). The ≈$ cost is a cache-aware estimate at Sonnet pricing; actual cost varies by model.</span></span>
  </div>
  ${bar}
</div>`;
}
```

The `{ input, output, cached }` invariant is `input + output + cached === conversationTokens`, so the three segments sum to 100%. Add a `fmt(n)` helper (e.g. `1.4M` / `96k`) if none exists in this file. Insert `${buildTokenMeter(summary)}` in `buildHtml` after `buildHeader(...)`.

- [ ] **Step 4: CSS + script**

CSS: `.tmeter`, `.tmeter.na`, `.tmeter-head`, `.tmeter-bar`, `.seg-in/.seg-out/.seg-cache` (colors from mockup — `seg-in`≈charts-green, `seg-out`≈orange, `seg-cache`≈muted), `.tmeter-legend`, `.lg-dot`, `.tok-help-wrap`/`.tok-help`/`.tok-pop` (popover hidden until `.pinned`). Segment widths: **do not** inline `style="width"` (CSP). Script: after load, `document.querySelectorAll('.tmeter-bar [data-pct]').forEach(el => el.style.width = el.dataset.pct + '%')`; and `.tok-help` click toggles `.pinned` on `.tok-help-wrap` via `addEventListener`.

- [ ] **Step 5: Run to verify green**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "token meter"`
Expected: PASS.

---

## Task 7: VS Code — Conversations inline rows

**Files:**
- Modify: `SummaryHtmlBuilder.ts` — rewrite `buildConversationsSection` (lines 482–493); it must now receive the conversation list (source + title + msg count + session id), not just the hash set. Thread that data from the model in `buildHtml`.
- Modify: `SummaryCssBuilder.ts` — `.badge.src-*`, inline `.row`, `.r-meta.hide-on-hover`, `.conv-resume`
- Modify: `SummaryScriptBuilder.ts` — detach / Show / Continue bindings
- Modify: `SummaryWebviewPanel.ts` — add `conversationDetach` inbound message if none exists
- Test: `SummaryHtmlBuilder.test.ts`, `SummaryScriptBuilder.test.ts` / panel test

**Interfaces:**
- Consumes: the panel's existing conversation metadata (per-source label, per-session turn count, session id) — the same data `buildAllConversationsSection` used for the modal.
- Produces: `.panel` "Conversations" with inline `.row` per conversation; `conversationDetach` message `{ commitHash, sessionId }` (only if not already handled).

- [ ] **Step 1: Write the failing test**

```ts
it("conversations render as inline rows, not a modal private-zone", () => {
	const html = buildConversationsSection(convFixture()); // [{source:'claude', title, msgs:38, sessionId}]
	expect(html).toContain('class="badge src-claude"');
	expect(html).toContain("38 msgs");
	expect(html).toContain('class="row"');
	expect(html).not.toContain("private-zone");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "inline rows"`
Expected: FAIL — still emits `private-zone` / modal.

- [ ] **Step 3: Rewrite `buildConversationsSection`**

Target markup (from `pane-memory`), one `.row` per conversation:

```html
<div class="panel">
  <div class="panel-header"><span class="panel-title">Conversations</span><span class="sec-count">${n}</span></div>
  <!-- per conversation: -->
  <div class="row" data-session="${sessionId}" data-hash="${hash}">
    <span class="badge src-${source}">${sourceLabel}</span>
    <div class="r-main"><div class="r-title">${title}</div></div>
    <span class="r-meta hide-on-hover">${msgs} msgs</span>
    <span class="r-actions"><button class="icon-btn danger conv-detach" title="Detach from this memory"><span class="codicon codicon-trash"></span></button></span>
  </div>
</div>
```

The row's ONLY action is detach — **no Show/Continue `.conv-resume` buttons** (dropped per product decision). Drop the `.private-zone` / manage-modal markup. Change the function signature to take the conversation list; update the `buildHtml` call site to pass it (derive from the same model field the modal used). Keep the transcript privacy note OUT of here — it moves to the footer (Task 10).

- [ ] **Step 4: Bindings + message**

Script: bind `.conv-detach` click → post `{ command: 'conversationDetach', hash, sessionId }`; on ack, remove the row in place (no full rebuild — mirror the sidebar's precise in-place removal). Panel: add the `conversationDetach` handler only if the modal's detach used a different message — reuse the existing detach logic. (No Show/Continue bindings — those actions are removed.)

- [ ] **Step 5: Run to verify green**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "inline rows"`
Expected: PASS.

---

## Task 8: VS Code — Context flat panel + drop Source Commits

**Files:**
- Modify: `SummaryHtmlBuilder.ts` — `buildAttachmentsPanel` → `buildContextPanel` (lines 441–480+); remove `buildSourceCommits`/`#sourceCard` from the panel
- Modify: `SummaryCssBuilder.ts` — `.kb-tag.t-plan/.t-ref`, flat `.row` in Context
- Modify: `SummaryScriptBuilder.ts` — `+ Add` menu binding (reuse add-plan/add-note); verify no orphaned `#sourceCard` collapse handler remains
- Test: `SummaryHtmlBuilder.test.ts`

**Interfaces:**
- Consumes: `summary.plans`, `summary.notes`, `summary.references`.
- Produces: `.panel` "Context" (flat rows, `+ Add`, count chip); no `.attach-card`, no Source Commits.

- [ ] **Step 1: Write the failing test**

```ts
it("context panel is flat rows with kb-tags and no collapsible cards or source commits", () => {
	const html = buildContextPanel(makeSummary({ plans: [plan()], references: [linearRef()] }), []);
	expect(html).toContain('class="panel"');
	expect(html).toContain("Context");
	expect(html).toContain("kb-tag t-plan");
	expect(html).toContain("kb-tag t-ref");
	expect(html).toContain("+ Add");
	expect(html).not.toContain("attach-card");
	expect(html).not.toContain("Source Commits");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "context panel"`
Expected: FAIL.

- [ ] **Step 3: Rewrite as `buildContextPanel`**

Flat panel; keep the inner `#plansAndNotesSection` id (so `plansAndNotesUpdated` in-place refresh still works), re-parented into the Context panel. Rows per item:
- plan: `<span class="kb-tag t-plan">P</span>` + title + Edit/Remove `.icon-btn`.
- reference: `<span class="kb-tag t-ref">${L/G/J/N}</span>` + title + sub (source) + Open-in-browser/Remove.
Header: `<span class="panel-title">Context</span><span class="sec-count">${n}</span><button class="panel-add" ...>+ Add</button>`.
Delete the `sourceCard` branch and the `buildSourceCommits(sourceNodes)` call from this panel. Drop the now-unused `sourceNodes` param if nothing else in the panel uses it (leave `collectSortedTopics`'s `sourceNodes` in `buildHtml` if other code needs it).

- [ ] **Step 4: Script**

Bind `.panel-add` → the existing add-plan/add-note menu (`#menu-add` / `toggleMenu`). Remove any `data-collapse="sourceCard"` handler now orphaned. Verify `plansAndNotesUpdated` still finds `#plansAndNotesSection`.

- [ ] **Step 5: Run to verify green**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "context panel"`
Expected: PASS.

---

## Task 9: VS Code — Files panel (per-file status + diff + off-branch)

**Files:**
- Modify: `SummaryHtmlBuilder.ts` — new `buildFilesPanel(fileRows, opts)`, inserted in `buildHtml` after the Context panel
- Modify: `SummaryWebviewPanel.ts` — compute file rows (reuse `parseDiffNameStatus`) + branch-reachability check; add `openFileDiff` inbound message
- Modify: `SummaryCssBuilder.ts` — `.gs.gs-M/A/D`, `.fname-*`, `.is-unresolvable`, `.files-offbranch-hint`
- Modify: `SummaryScriptBuilder.ts` — file-row click → `openFileDiff`
- Test: `SummaryHtmlBuilder.test.ts`, `SummaryWebviewPanel.test.ts`

**Interfaces:**
- Consumes: shared `parseDiffNameStatus` (`CreatePrData` / `JolliMemoryBridge` — extend the shared one) → `{ path, dir, status }[]`; `summary.branch`; reachability.
- Produces: `buildFilesPanel(rows: {path:string;dir:string;status:string}[], opts: { offBranch: boolean; branch: string }): string`; `openFileDiff` message `{ path, commitHash }`.

- [ ] **Step 1: Write the failing test (builder)**

```ts
it("files panel renders per-file rows with status badges", () => {
	const html = buildFilesPanel(
		[{ path: "vscode/src/views/SummaryHtmlBuilder.ts", dir: "vscode/src/views", status: "M" }],
		{ offBranch: false, branch: "feature/x" });
	expect(html).toContain("Files");
	expect(html).toContain("fname-M");
	expect(html).toContain('class="gs gs-M"');
	expect(html).not.toContain("is-unresolvable");
});

it("files panel shows off-branch hint when diffs are unresolvable", () => {
	const html = buildFilesPanel(
		[{ path: "cli/src/core/CodexDiscovery.ts", dir: "cli/src/core", status: "M" }],
		{ offBranch: true, branch: "feature/jolli-1703" });
	expect(html).toContain("is-unresolvable");
	expect(html).toContain("files-offbranch-hint");
	expect(html).toContain("feature/jolli-1703");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "files panel"`
Expected: FAIL — `buildFilesPanel` not defined.

- [ ] **Step 3: Implement `buildFilesPanel`**

Reuse the Create PR row shape:

```ts
function buildFilesPanel(rows: FileRow[], opts: { offBranch: boolean; branch: string }): string {
	if (rows.length === 0) return "";
	const rowHtml = rows.map((f) => {
		const fname = f.path.split("/").pop() ?? f.path;
		const cls = opts.offBranch ? "row is-unresolvable" : "row";
		const click = opts.offBranch ? "" : ` data-path="${escAttr(f.path)}"`;
		return `<div class="${cls}"${click}${opts.offBranch ? ' title="Diffs open only on the checked-out branch"' : ""}>` +
			`<div class="r-main"><div class="r-title fname-${escHtml(f.status)}">${escHtml(fname)}</div>` +
			`<div class="r-sub">${escHtml(f.dir)}</div></div>` +
			`<span class="gs gs-${escHtml(f.status)}">${escHtml(f.status)}</span></div>`;
	}).join("");
	const hint = opts.offBranch
		? `<p class="muted files-offbranch-hint"><span>Diffs open only on the checked-out branch. Check out <code>${escHtml(opts.branch)}</code> to view these changes.</span></p>`
		: "";
	return `
<div class="panel">
  <div class="panel-header"><span class="panel-title">Files</span><span class="sec-count">${rows.length}</span></div>
  ${rowHtml}${hint}
</div>`;
}
```

- [ ] **Step 4: Host wiring in `SummaryWebviewPanel.ts`**

Compute `rows` via the shared `parseDiffNameStatus` over `git diff --name-status <commit>^ <commit>` (guard root commits) for the memory's commit; set `offBranch = true` when the commit isn't reachable on the checked-out branch or the panel is in foreign mode (reuse the existing foreign flag / a `git merge-base --is-ancestor` check). Pass `rows` + `opts` into `buildFilesPanel` (embed at build time, or post via a `files:rows` message if computed async — if async, render a Loading placeholder and fill on message, using the polling helper in the test). Add the `openFileDiff` inbound handler: open the file's diff at the commit via the existing VS Code diff command plumbing.

- [ ] **Step 5: Write + run the panel message test**

```ts
it("openFileDiff opens a diff for the given path and commit", async () => {
	// post { command: 'openFileDiff', path, commitHash }; assert the diff command was invoked.
});
```

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts SummaryWebviewPanel.test.ts -t "files panel|openFileDiff"`
Expected: PASS.

- [ ] **Step 6: CSS + click binding**

CSS: `.gs`/`.gs-M`/`.gs-A`/`.gs-D` (git decoration colors), `.fname-M/A/D`, `.is-unresolvable` (dimmed, no pointer), `.files-offbranch-hint`. Script: bind `.panel .row[data-path]` click → post `openFileDiff` with `dataset.path` + the commit hash.

---

## Task 10: VS Code — footer privacy note (kept above attribution)

**Files:**
- Modify: `SummaryHtmlBuilder.ts` — `buildFooter` (near line 161's target)
- Modify: `SummaryCssBuilder.ts` — `.muted` privacy line
- Test: `SummaryHtmlBuilder.test.ts`

**Interfaces:**
- Consumes: linked conversation count (`transcriptHashSet?.size`).
- Produces: privacy note ABOVE the retained attribution footer.

- [ ] **Step 1: Write the failing test**

```ts
it("footer shows the transcript privacy note and keeps the attribution", () => {
	const html = buildFooter(makeSummary(), 2); // 2 = conversation count
	expect(html).toContain("stay in your repo");
	expect(html).toContain("Generated by Jolli Memory"); // attribution kept
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "privacy note"`
Expected: FAIL.

- [ ] **Step 3: Add the privacy note above the attribution**

Thread the conversation count into `buildFooter`. Emit above the existing attribution block:

```html
<p class="muted transcript-privacy"><span aria-hidden="true">🔒</span> Full conversation transcripts (${n}) stay in your repo — never included in shared exports.</p>
```

Keep the existing `.page-footer` attribution line unchanged (per spec §4.7 decision). Update the `buildHtml` call site to pass the count.

- [ ] **Step 4: Run to verify green**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "privacy note"`
Expected: PASS.

---

## Task 11: VS Code — full-panel snapshot alignment + foreign/stale states

**Files:**
- Test: `SummaryHtmlBuilder.test.ts` (whole-`buildHtml` structural test), existing foreign/stale tests
- Modify: any builder as needed to keep foreign-readonly / stale-rewritten correct

**Interfaces:** consumes all prior tasks.

- [ ] **Step 1: Write a whole-panel order test**

```ts
it("full panel renders sections in mockup order", () => {
	const html = buildHtml(makeSummary({ jolliDocUrl: "https://jolli.ai/x", conversationTokens: 143000 }), { transcriptHashSet: new Set(["a"]) });
	const order = ["page-title", "meta-strip", "tmeter", "propTable", "ship-bar", "memoryPanel", "e2ePanel", "Conversations", "Context", "Files", "transcript-privacy"];
	let last = -1;
	for (const marker of order) { const i = html.indexOf(marker); expect(i, marker).toBeGreaterThan(last); last = i; }
});
```

- [ ] **Step 2: Run to verify it fails, then fix ordering**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "mockup order"`
Adjust the `buildHtml` assembly order (line 152–162) until PASS.

- [ ] **Step 3: Verify foreign-readonly + stale tests still pass**

Run: `npm run test:vscode -- SummaryHtmlBuilder.test.ts -t "foreign|stale|readonly"`
Expected: PASS (fix any `data-foreign-safe` gaps on new controls — e.g. `.conv-detach`, `.panel-add`, Export items must carry the same gating the old destructive controls did).

---

## Task 12: Full verification + squash to one commit

**Files:** all of the above. Runs AFTER the final whole-branch review is clean.

- [ ] **Step 1: Biome autofix**

Run: `npm run lint:fix`

- [ ] **Step 2: Full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage ≥ 97/96/97/97.
If coverage dips on new CLI code, add focused tests (e.g. the total-only degrade path, the `na` state, migration carry-through) — use `/* v8 ignore start/stop */` blocks (not single-line `ignore next`) only for genuinely unreachable arms.

- [ ] **Step 3: Squash the per-task commits into one (signed)**

Squash the branch's task commits (and the spec/plan doc adds) into a single commit against the branch base (`git merge-base main HEAD`):

```bash
git reset --soft "$(git merge-base main HEAD)"
git commit -s -m "feat(vscode): align Commit Memory detail panel to mockup

Single Jolli ship card (PR card removed), per-memory token meter backed
by a new conversationTokenBreakdown captured from Claude transcripts,
inline Conversations rows, flat Context panel (Source Commits removed),
and a new Files panel with per-file status + off-branch handling."
```

(No `Co-Authored-By: Claude` trailer, no `🤖 Generated with` footer — DCO `Signed-off-by:` only. `reset --soft` keeps the working tree; only history collapses. Controller runs this — get user confirmation before the reset, per the destructive-git rule.)

---

## Self-review notes

- **Spec coverage:** §4.1→T4, §4.2→T6, §4.3→T7, §4.4→T9, §4.5→T8, §4.6→T5, §4.7→T10, §5 (data layer already on `b0d3ca21`; consumed by T6), §6 states→T11, §7 testing→every task + T12. All spec sections map to a task.
- **Type consistency:** `ConversationTokenBreakdown` (`{ input, output, cached }`, existing — `b0d3ca21`) is consumed unchanged by `buildTokenMeter` (Task 6); no new breakdown type is introduced. `FileRow`/`{path,dir,status}` is the single shape shared by `parseDiffNameStatus` and `buildFilesPanel` (Task 9). `#propTable` id is retained (Task 5), consumed by the Details toggle. `#pushJolliBtn` retained (Task 4).
- **Convention:** no per-task commit / no per-task `npm run all` (Global Constraints); consolidated in Task 12.
