# PR3 — Memory Bank View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-memory evidence nesting + time grouping to the Memory Bank **Timeline**, and a shared **repo selector** on the Memory Bank header — leaving the **Tree unchanged**.

**Architecture:** The sidebar webview is built from template-literal strings (`SidebarHtmlBuilder` / `SidebarCssBuilder` / `SidebarScriptBuilder`), tested by asserting on the generated string + a `new Function(...)` parse smoke test. The Timeline (`renderMemories`) gains expandable memory rows that lazily request a memory's evidence via a new `kb:expandMemory` → `kb:memoryEvidence` message pair; the host builds that evidence from the **same `SummaryStore` read the detail panel uses** (`getSummary(hash)` → project plans/notes/references/transcripts/files). A contextual repo selector replaces the breadcrumb on the Memory Bank view.

**Tech Stack:** TypeScript (ESM), esbuild (CJS host bundle), Vitest, Biome. VS Code webview, strict CSP.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` / `🤖 Generated with …` trailers.
- **`npm run all` must pass before commit** (clean → build → lint → test). Final task runs the full gate.
- **Biome:** tabs, 4-wide, 120-col; `noExplicitAny`, `noUnusedImports/Variables` are errors; warnings fail CI.
- **CSP — no inline style / no inline JS.** Visibility via the `.hidden` class, never the HTML `hidden` attribute or `el.hidden = X`. No inline `style=`.
- **Builder backtick trap:** the builders return one template literal each — never write a raw backtick inside a comment or string in the builder body (the `new Function(...)` parse smoke test guards the script builder).
- **`toForwardSlash` for `\`→`/` path normalization** ([cli/src/core/PathUtils.ts]) — never inline `path.replace(/\\/g,"/")`.
- **Cross-package imports under `vscode/src/**` (e.g. `../../../cli/src/...`) are intentional** — resolved at esbuild bundle time. Don't refactor them.
- **Tree is frozen:** no change to `renderFolders` / `KbFoldersService` / the on-disk `.md`-file tree, its diverged markers, Revert-to-System, or `kb:foldersData`/`kb:markDiverged`/`kb:clearDiverged`/`kb:foldersReset`. Evidence nesting is **Timeline-only**.
- **Per-row Share, token meter, and larger-view editor panes are out of scope** (deferred per the spec).

---

### Task 1: Memory-evidence message protocol

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts` — add the outbound + inbound members and a `MemoryEvidence` type.
- Test: `vscode/src/views/SidebarMessages.test.ts`

**Interfaces:**
- Produces:
  - `interface MemoryEvidenceItem { readonly kind: "conversation" | "plan" | "note" | "reference" | "file"; readonly id: string; readonly title: string; readonly source?: string; readonly transcriptPath?: string; readonly relativePath?: string; readonly statusCode?: string; }` — minimal display shape; `source`/`transcriptPath` populated for conversations, `relativePath`/`statusCode` for files (so an evidence row can dispatch the existing open command for its kind).
  - `interface MemoryEvidence { readonly conversations: ReadonlyArray<MemoryEvidenceItem>; readonly context: ReadonlyArray<MemoryEvidenceItem>; readonly files: ReadonlyArray<MemoryEvidenceItem>; }`
  - Outbound: `{ readonly type: "kb:expandMemory"; readonly commitHash: string }`
  - Inbound: `{ readonly type: "kb:memoryEvidence"; readonly commitHash: string; readonly evidence: MemoryEvidence }`

- [ ] **Step 1: Write the failing test**

Add to `vscode/src/views/SidebarMessages.test.ts`:

```ts
it("admits kb:expandMemory outbound and kb:memoryEvidence inbound", () => {
	const out: SidebarOutboundMsg = { type: "kb:expandMemory", commitHash: "abc1234" };
	const ev: MemoryEvidence = { conversations: [], context: [], files: [] };
	const inb: SidebarInboundMsg = { type: "kb:memoryEvidence", commitHash: "abc1234", evidence: ev };
	expect(out.type).toBe("kb:expandMemory");
	expect(inb.type).toBe("kb:memoryEvidence");
});
```

Ensure the test imports the types: `import type { MemoryEvidence, SidebarInboundMsg, SidebarOutboundMsg } from "./SidebarMessages.js";`

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run typecheck -w vscode`
Expected: FAIL — `kb:expandMemory` / `kb:memoryEvidence` / `MemoryEvidence` not assignable / not found.

- [ ] **Step 3: Add the types**

In `vscode/src/views/SidebarMessages.ts` add the two interfaces (near the other exported interfaces) and the union members:

```ts
export interface MemoryEvidenceItem {
	readonly kind: "conversation" | "plan" | "note" | "reference" | "file";
	readonly id: string;
	readonly title: string;
	readonly source?: string;
	readonly transcriptPath?: string;
	readonly relativePath?: string;
	readonly statusCode?: string;
}

export interface MemoryEvidence {
	readonly conversations: ReadonlyArray<MemoryEvidenceItem>;
	readonly context: ReadonlyArray<MemoryEvidenceItem>;
	readonly files: ReadonlyArray<MemoryEvidenceItem>;
}
```

Add to `SidebarOutboundMsg`: `| { readonly type: "kb:expandMemory"; readonly commitHash: string }`

Add to `SidebarInboundMsg`: `| { readonly type: "kb:memoryEvidence"; readonly commitHash: string; readonly evidence: MemoryEvidence }`

- [ ] **Step 4: Run the test + typecheck to verify they pass**

Run: `npm run typecheck -w vscode && npm run test:vscode -- src/views/SidebarMessages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarMessages.ts vscode/src/views/SidebarMessages.test.ts
git commit -s -m "feat(vscode): add kb:expandMemory / kb:memoryEvidence message protocol"
```

---

### Task 2: Host evidence builder (`kb:expandMemory` → `kb:memoryEvidence`)

**Files:**
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` — handle `kb:expandMemory`; add a `pushMemoryEvidence(commitHash)` that reads the summary and posts `kb:memoryEvidence`.
- Test: `vscode/src/views/SidebarWebviewProvider.test.ts`

**Interfaces:**
- Consumes (Task 1): `MemoryEvidence` / `MemoryEvidenceItem`; the inbound/outbound message types.
- Produces: provider method `pushMemoryEvidence(commitHash: string): Promise<void>` that posts `{ type: "kb:memoryEvidence", commitHash, evidence }`.

**Evidence sourcing (read the detail panel to reuse, do not invent a parallel data path):** `SummaryWebviewPanel.show(summary, …)` already turns a `CommitSummary` into the exact evidence the detail pane renders — conversations from the transcript set (`refreshTranscriptHashes`), context from `summary.plans` / `summary.notes` / `summary.references`, and files from the commit's source nodes. For the Timeline, project the **same** `CommitSummary` (obtained via `getSummary(commitHash)` from `../../../cli/src/core/SummaryStore.js`, through the active storage) into `MemoryEvidence`:
- `conversations`: one item per captured session/transcript on the summary (`kind:"conversation"`, `id` = the session id, `title` = the session title, `source` + `transcriptPath` populated so the row can open `ConversationDetailsPanel` exactly as the Branch view's `branch:openConversation` does — read how the detail pane / `ActiveSessionAggregator` carries `source`/`transcriptPath` and reuse it).
- `context`: `summary.plans` (`kind:"plan"`), `summary.notes` (`kind:"note"`), `summary.references` (`kind:"reference"`), each `id`/`title` projected for its existing open command.
- `files`: the commit's changed files (`kind:"file"`, `relativePath` + `statusCode`) from the same source the detail pane's Files panel uses.

Use the SAME storage/repo resolution the provider already uses for the foreign-readonly branch memories path (`selectedRepoName ?? currentRepoName`), so a memory from a foreign repo resolves against the right storage.

- [ ] **Step 1: Write the failing test**

In `vscode/src/views/SidebarWebviewProvider.test.ts`, mirror an existing handled-message test (e.g. the `branch:pin` or refresh case): construct the provider with the existing deps mock plus a fake summary source, send `{ type: "kb:expandMemory", commitHash: "abc1234" }`, and assert a `kb:memoryEvidence` message is posted carrying the projected `evidence` (conversations/context/files derived from the fake summary). Name the deps the provider already exposes for summary lookup; if none exists, add a `getSummaryByHash(commitHash)` dep to `SidebarWebviewDeps` and supply it (wired in Task 6 / Extension) — match how other per-project reads are injected.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts`
Expected: FAIL — no `kb:expandMemory` handler; no `kb:memoryEvidence` posted.

- [ ] **Step 3: Implement the handler + `pushMemoryEvidence`**

Add the `kb:expandMemory` case to the provider's `handleOutbound` dispatch → `void this.pushMemoryEvidence(msg.commitHash)`. Implement `pushMemoryEvidence` to read the summary (via the dep / `getSummary`), project it to `MemoryEvidence` per the sourcing notes above, and `this.postMessage({ type: "kb:memoryEvidence", commitHash, evidence })`. On a missing summary, post empty groups (`{ conversations: [], context: [], files: [] }`) — never throw.

(Implementer: read `SummaryWebviewPanel`'s `refresh*` methods + its `buildHtml` call site to reuse the exact projections for conversations/context/files; extract a shared helper if that keeps it DRY, but do not change the detail pane's behavior.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck -w vscode && npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarWebviewProvider.ts vscode/src/views/SidebarWebviewProvider.test.ts
git commit -s -m "feat(vscode): host builds per-memory evidence for the Timeline"
```

---

### Task 3: Timeline — expandable evidence rendering

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — `renderMemories` (`:1737`+); add `evidenceCache`, a `kb:memoryEvidence` inbound handler, a `renderMemoryEvidence` function, and per-row expand wiring.
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — evidence sub-group styling if needed.
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

**Interfaces:**
- Consumes (Task 1/2): outbound `kb:expandMemory`; inbound `kb:memoryEvidence` (`{ commitHash, evidence }`).
- Produces: Timeline memory rows carry a twirl; expanding lazily posts `kb:expandMemory` on cache-miss and renders the evidence sub-groups; evidence rows dispatch the existing per-kind open commands.

- [ ] **Step 1: Write the failing tests**

Add to `vscode/src/views/SidebarScriptBuilder.test.ts`:

```ts
it("handles kb:memoryEvidence and renders memory evidence in the Timeline", () => {
	const js = buildSidebarScript();
	expect(js).toContain("'kb:memoryEvidence'");
	expect(js).toContain("function renderMemoryEvidence");
});

it("lazily requests memory evidence on expand", () => {
	const js = buildSidebarScript();
	expect(js).toContain("type: 'kb:expandMemory'");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: FAIL — `kb:memoryEvidence`, `renderMemoryEvidence`, `kb:expandMemory` not present.

- [ ] **Step 3: Implement evidence cache + handler + rendering**

- Add module-scope `const evidenceCache = {};` (keyed by commitHash) near `memoriesState`.
- Add a per-memory expand state map (e.g. `memoriesExpanded`) mirroring the Branch view's `commitsExpanded` (persisted via `state`), so expansion survives re-render.
- In the inbound message handler, add a `kb:memoryEvidence` case: store `msg.evidence` into `evidenceCache[msg.commitHash]`; if on the Memory Bank Timeline, re-render so the expanded row shows its evidence.
- In `renderMemories`, give each memory row a leading twirl bound to toggle `memoriesExpanded[hash]`. When expanded: if `evidenceCache[hash]` is absent, post `{ type: 'kb:expandMemory', commitHash: hash }` and render a "Loading…" placeholder; when present, render `renderMemoryEvidence(evidence)`.
- `renderMemoryEvidence(evidence)` returns the three labelled sub-groups (Conversations / Context / Files), one row per `MemoryEvidenceItem`, each wired to its existing open path by `kind`: conversation → post the existing conversation-open message with `source`/`transcriptPath`/`id`/`title`; plan/note → the existing plan/note open; reference → reference open; file → diff open with `relativePath`/`statusCode`. Reuse the existing row-open helpers — do not add a parallel mechanism.
- Follow the lazy-protocol convention: trigger the `kb:expandMemory` request on every entry path that can show an already-expanded row (initial render, re-render after `kb:memoriesData`, mode switch) when the row is expanded and its evidence is a cache-miss.

(Implementer: realize the DOM against the test markers; reuse `timeAgo`, the icon/badge helpers, and the existing open-command dispatchers already in this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: PASS (incl. the `new Function(...)` parse smoke test).

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts
git commit -s -m "feat(vscode): expandable per-memory evidence in the Memory Bank Timeline"
```

---

### Task 4: Timeline — time grouping headers

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — `renderMemories` (`:1737`+); add a `timeGroupLabel(ts)` helper.
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — `.tl-group-label` styling.
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`, `vscode/src/views/SidebarCssBuilder.test.ts`

**Interfaces:**
- Produces: `timeGroupLabel(timestamp)` → one of `"Today"` / `"Yesterday"` / `"Earlier this week"` / `"Older"`; `renderMemories` emits a group-label node before the first memory of each new bucket.

- [ ] **Step 1: Write the failing tests**

Add to `vscode/src/views/SidebarScriptBuilder.test.ts`:

```ts
it("groups Timeline memories under relative-time labels", () => {
	const js = buildSidebarScript();
	expect(js).toContain("function timeGroupLabel");
	expect(js).toContain("Today");
	expect(js).toContain("Earlier this week");
});
```

Add to `vscode/src/views/SidebarCssBuilder.test.ts`:

```ts
it("styles Timeline time-group labels", () => {
	const css = buildSidebarCss();
	expect(css).toContain(".tl-group-label");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: FAIL — `timeGroupLabel` / `.tl-group-label` not present.

- [ ] **Step 3: Add the grouping helper + render labels + CSS**

In `SidebarScriptBuilder.ts`, add near `timeAgo`:

```js
  function timeGroupLabel(ts) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 86400000;
    if (ts >= startOfToday) return 'Today';
    if (ts >= startOfToday - dayMs) return 'Yesterday';
    if (ts >= startOfToday - 7 * dayMs) return 'Earlier this week';
    return 'Older';
  }
```

In `renderMemories`, while iterating `visibleItems`, track the last emitted label and push `el('div', { className: 'tl-group-label', text: label })` whenever the current item's `timeGroupLabel(m.timestamp)` differs from the previous. (Items arrive newest-first; do not re-sort.)

In `SidebarCssBuilder.ts` add:

```css
  /* Memory Bank Timeline — relative-time group headers. */
  .tl-group-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    padding: 8px 14px 2px;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts vscode/src/views/SidebarCssBuilder.test.ts
git commit -s -m "feat(vscode): time-group headers in the Memory Bank Timeline"
```

---

### Task 5: Shared repo selector on the Memory Bank header

**Files:**
- Modify: `vscode/src/views/SidebarHtmlBuilder.ts` — add a `#repo-filter` selector element in the header (sibling of the breadcrumb).
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — selector styling + the view-driven show/hide rules.
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — show the repo filter (and hide the branch breadcrumb segment) when `activeTab === 'kb'`; populate it from `selection:repos`; filter the Timeline items by the picked repo (`All repos` = no filter).
- Test: `vscode/src/views/SidebarHtmlBuilder.test.ts`, `vscode/src/views/SidebarScriptBuilder.test.ts`, `vscode/src/views/SidebarCssBuilder.test.ts`

**Interfaces:**
- Consumes: the existing `selection:repos` inbound message + the breadcrumb dropdown (`breadcrumb-menu`) infrastructure.
- Produces: a `#repo-filter` "Showing: <repo>" control, visible on the Memory Bank view; a client `kbRepoFilter` state (`""` = All repos) that scopes the Timeline render.

- [ ] **Step 1: Write the failing tests**

`SidebarHtmlBuilder.test.ts`:

```ts
it("renders a repo filter selector for the Memory Bank header", () => {
	const html = buildSidebarHtml("n", "vscode-resource:", "https://example/codicon.css", SIDEBAR_EMPTY_STRINGS);
	expect(html).toContain('id="repo-filter"');
	expect(html).toContain("Showing");
});
```

`SidebarCssBuilder.test.ts`:

```ts
it("styles the repo filter and scopes it to the Memory Bank view", () => {
	const css = buildSidebarCss();
	expect(css).toContain(".repo-filter");
});
```

`SidebarScriptBuilder.test.ts`:

```ts
it("scopes the Timeline by the repo filter and shows it on the Memory Bank view", () => {
	const js = buildSidebarScript();
	expect(js).toContain("repo-filter");
	expect(js).toContain("kbRepoFilter");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarHtmlBuilder.test.ts src/views/SidebarCssBuilder.test.ts src/views/SidebarScriptBuilder.test.ts`
Expected: FAIL — `#repo-filter` / `.repo-filter` / `kbRepoFilter` not present.

- [ ] **Step 3: Add the selector markup**

In `SidebarHtmlBuilder.ts`, add a repo-filter control in the header region (sibling of `#breadcrumb`), hidden by default:

```html
    <div class="repo-filter hidden" id="repo-filter">
      <span class="repo-filter-label">Showing</span>
      <button class="breadcrumb-seg" type="button" id="repo-filter-btn" aria-haspopup="menu" aria-expanded="false">
        <span class="breadcrumb-seg-label" id="repo-filter-value">All repos</span>
        <i class="codicon codicon-chevron-down breadcrumb-seg-chevron" aria-hidden="true"></i>
      </button>
    </div>
```

- [ ] **Step 4: Add the CSS**

In `SidebarCssBuilder.ts`:

```css
  /* Memory Bank repo filter ("Showing: <repo>") — replaces the branch
     breadcrumb segment on the Memory Bank / Knowledge views. */
  .repo-filter { display: inline-flex; align-items: center; gap: 5px; padding: 2px 4px 2px 6px; min-width: 0; flex: 1 1 auto; }
  .repo-filter-label { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
```

- [ ] **Step 5: Wire the selector in the script**

In `SidebarScriptBuilder.ts`:
- Add `let kbRepoFilter = '';` (empty = All repos) near the KB state.
- Add a `#repo-filter` / `#repo-filter-btn` / `#repo-filter-value` ref set.
- On entering the Memory Bank view (`switchTab('kb')` / `applyEnabled`), show `#repo-filter` and hide the breadcrumb's branch segment; on other views hide `#repo-filter` and restore the breadcrumb. Use the `.hidden` class only.
- Clicking `#repo-filter-btn` opens the existing breadcrumb dropdown populated from `repoChoices` (the `selection:repos` data the breadcrumb already caches), plus an "All repos" entry; picking one sets `kbRepoFilter`, updates `#repo-filter-value`, and re-renders.
- In `renderMemories`, when `kbRepoFilter` is non-empty, filter `visibleItems` to `m.repoName === kbRepoFilter` before grouping/rendering.

(Implementer: reuse `showBreadcrumbMenu` / `repoChoices` / `selection:repos`; do not add a second repo-enumeration path.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarHtmlBuilder.test.ts src/views/SidebarCssBuilder.test.ts src/views/SidebarScriptBuilder.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add vscode/src/views/SidebarHtmlBuilder.ts vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarHtmlBuilder.test.ts vscode/src/views/SidebarCssBuilder.test.ts vscode/src/views/SidebarScriptBuilder.test.ts
git commit -s -m "feat(vscode): shared repo filter on the Memory Bank header"
```

---

### Task 6: Wire the summary dep + full gate + smoke

**Files:**
- Modify: `vscode/src/Extension.ts` — inject the summary-lookup dep into the live `SidebarWebviewProvider` (if Task 2 added one to `SidebarWebviewDeps`).
- Test: `vscode/src/Extension.test.ts` (guard the wiring) + full suite.

- [ ] **Step 1: Wire the dep into the live provider**

If Task 2 added a `getSummaryByHash` (or similar) dep to `SidebarWebviewDeps`, pass it at the MAIN `new SidebarWebviewProvider({...})` instantiation in `Extension.ts` (the live sidebar, not the degraded one), sourcing it from `getSummary` (`../../cli/src/core/SummaryStore.js`) bound to the active storage — mirror how the other per-project store deps are injected. Add an assertion in `Extension.test.ts` (next to the existing `pinStore` dep assertion) that the live deps include it, so a missing wiring can't regress silently.

- [ ] **Step 2: Run the full gate**

Run: `npm run all`
Expected: PASS across cli + vscode. The CLI suite may show the PRE-EXISTING, unrelated `safe.bareRepository` / worktree-isolation failure documented in project memory — prefix with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npm run all` to clear it. Update (don't weaken) any test that asserted the old Memory Bank header (breadcrumb-only) if it now conflicts with the repo filter.

- [ ] **Step 3: Manual smoke (best-effort)**

```bash
cd vscode && npm run deploy
```
Reload Window. Verify on the **Memory Bank** view: the header shows **Showing: All repos** (not the branch breadcrumb); the **Tree** is unchanged (file tree, diverged markers, revert still work); the **Timeline** groups memories under Today/Yesterday/Earlier-this-week, and expanding a memory shows its **Conversations / Context / Files** (a conversation row opens the transcript, a file row opens the diff). Picking a specific repo filters the Timeline. If the GUI can't be driven here, say so and statically confirm the generated strings.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -s -m "test(vscode): wire summary dep + align Memory Bank tests with the redesign"
```
(If `npm run all` was clean with no fixups and no dep wiring was needed, make no commit and say so.)

---

## Self-Review

**1. Spec coverage:** §2 Tree-unchanged → enforced by the Global Constraints + no task touches `renderFolders`. §3 Timeline evidence nesting → Tasks 1-3. §3 time grouping → Task 4. §4 repo selector → Task 5. §5 data/messages (kb:expandMemory/kb:memoryEvidence, SummaryStore source) → Tasks 1-2 + Task 6 wiring. §6 testing pattern → embedded per task + Task 6. Deferred items (token meter / larger panes / Share) → not implemented (correct). No spec requirement unaddressed.

**2. Placeholder scan:** No `TBD`/`TODO`. The host-evidence (Task 2) and rendering (Task 3) tasks are specified by message/interface contract + test-contract markers + exact source anchors (the detail-pane `refresh*` projections) rather than full verbatim DOM/host code — appropriate for an integration task against a large existing file; each names the concrete shape and the existing code to reuse. Message types (Task 1), the time-group helper (Task 4), and the selector markup/CSS (Task 5) carry complete verbatim code.

**3. Type consistency:** `MemoryEvidence` / `MemoryEvidenceItem` (Task 1) are consumed by the host builder (Task 2) and the renderer (Task 3) under the same names/fields. `kb:expandMemory` / `kb:memoryEvidence` strings match across Tasks 1-3. `kbRepoFilter` (Task 5) and `evidenceCache` / `memoriesExpanded` (Task 3) are introduced and used consistently. The summary-lookup dep added in Task 2 is wired in Task 6 under the same name.
