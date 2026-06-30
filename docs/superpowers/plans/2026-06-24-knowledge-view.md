# PR4 — Knowledge View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PR1 Knowledge stub with an in-sidebar, repo-grouped wiki — Overview + a single Knowledge-graph entry + `repo → category → topic` tree — sourced from the compiled knowledge-graph artifact.

**Architecture:** The sidebar webview is built from template-literal strings (`SidebarHtmlBuilder`/`SidebarCssBuilder`/`SidebarScriptBuilder`), tested by asserting on the generated string + a `new Function(...)` parse smoke test. `renderKnowledge` becomes the wiki tree, fed eagerly by a new `kb:knowledgeData` message; the host builds it by reading each repo's **knowledge-graph artifact** (`readGraph` from `cli/src/graph/GraphArtifactStore.ts` → `KnowledgeGraph`), which already carries categories (name + description + counts), topics (title, `categoryId`, `commitCount`, `wikiFile`). The graph entry reuses `jollimemory.viewKnowledgeGraph`, Build/Rebuild reuses `jollimemory.compileNow`, and the repo filter reuses PR3's shared selector.

**Tech Stack:** TypeScript (ESM), esbuild (CJS host bundle), Vitest, Biome. VS Code webview, strict CSP.

> **Data-source refinement (vs spec):** the spec named the `TopicIndex` (`TopicPageStore`) as the source. `TopicIndexEntry` has **no category field and no category descriptions**, so it cannot drive the mockup's `repo → category → topic` tree. The compiled **knowledge-graph artifact** (`KnowledgeGraph` via `readGraph(rootDir)`) is the correct, richer source — it carries `categories: GraphCategory{ id, shortTitle, summary, topicCount, commitCount }` and `topics: GraphTopic{ slug, title, shortTitle, categoryId, commitCount, wikiFile }`. This plan uses the graph artifact; it is the same compiled knowledge the spec intended, distilled with the category grouping the spec's tree requires. This also resolves the spec's "category description if present" — it is `category.summary`.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` / `🤖 Generated with …` trailers.
- **`npm run all` must pass before commit** (clean → build → lint → test). The final task runs the full gate; **verify the real exit code (do not rely on a `| tail`-piped exit status — the pipe masks failures)**.
- **Biome:** tabs, 4-wide, 120-col; `noExplicitAny`, `noUnusedImports/Variables`, **`noNonNullAssertion`** are errors; warnings fail CI (`biome check --error-on-warnings`). Use `?.()` optional-call, never `dep!(...)`.
- **CSP — no inline style / no inline JS.** Visibility via the `.hidden` class, never the HTML `hidden` attribute or `el.hidden = X`. No inline `style=`.
- **Builder backtick trap:** the builders return one template literal each — never write a raw backtick inside a comment or string in the builder body (the `new Function(...)` parse smoke test guards the script builder).
- **No internal planning artifacts in code** (repo is going open-source): no `Task N`, person names, or TODO-placeholders in shipped comments.
- **Cross-package imports under `vscode/src/**` (e.g. `../../../cli/src/...`) are intentional** — resolved at esbuild bundle time. Don't refactor them.
- **Reuse, don't rebuild:** graph → `jollimemory.viewKnowledgeGraph` (existing); Build/Rebuild → `jollimemory.compileNow` (existing); repo filter → PR3's `#repo-filter` / `applyRepoFilterVisibility` / `kbRepoFilter`.
- **Frozen:** Current Branch view (PR2), Memory Bank view (PR3), the Tree (`renderFolders`), `KnowledgeGraphPanel`, `CompileCommand`, command ids / handler names, storage/hooks/sync. **Per-row Share, the editor-area full-wiki webview panes, and the token meter are deferred** (out of scope).

---

### Task 1: Knowledge-data message protocol

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts` — add the inbound member + three interfaces.
- Test: `vscode/src/views/SidebarMessages.test.ts`

**Interfaces:**
- Produces:
  - `interface KnowledgeTopic { readonly title: string; readonly stableSlug: string; readonly memoryCount: number; readonly wikiFile: string; }`
  - `interface KnowledgeCategory { readonly name: string; readonly description?: string; readonly topicCount: number; readonly memoryCount: number; readonly topics: ReadonlyArray<KnowledgeTopic>; }`
  - `interface KnowledgeRepo { readonly repoName: string; readonly memoryCount: number; readonly indexPath: string; readonly categories: ReadonlyArray<KnowledgeCategory>; }` (`indexPath` = the repo's `_wiki/_index.md` path for the Overview row)
  - Inbound: `{ readonly type: "kb:knowledgeData"; readonly repos: ReadonlyArray<KnowledgeRepo> }`

- [ ] **Step 1: Write the failing test**

Add to `vscode/src/views/SidebarMessages.test.ts`:

```ts
it("admits kb:knowledgeData inbound with repo/category/topic shape", () => {
	const repo: KnowledgeRepo = {
		repoName: "acme",
		memoryCount: 30,
		indexPath: "/kb/acme/_wiki/_index.md",
		categories: [
			{ name: "Storage", description: "where memories live", topicCount: 1, memoryCount: 8,
			  topics: [{ title: "Storage", stableSlug: "storage", memoryCount: 8, wikiFile: "/kb/acme/_wiki/topic--storage.md" }] },
		],
	};
	const msg: SidebarInboundMsg = { type: "kb:knowledgeData", repos: [repo] };
	expect(msg.type).toBe("kb:knowledgeData");
	expect(repo.categories[0].topics[0].wikiFile).toContain("topic--storage.md");
});
```

Import the types: `import type { KnowledgeRepo, SidebarInboundMsg } from "./SidebarMessages.js";`

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run typecheck -w vscode`
Expected: FAIL — `KnowledgeRepo` / `kb:knowledgeData` not found.

- [ ] **Step 3: Add the types**

In `vscode/src/views/SidebarMessages.ts` add the three interfaces (near the other exported interfaces) and the inbound union member:

```ts
export interface KnowledgeTopic {
	readonly title: string;
	readonly stableSlug: string;
	readonly memoryCount: number;
	readonly wikiFile: string;
}

export interface KnowledgeCategory {
	readonly name: string;
	readonly description?: string;
	readonly topicCount: number;
	readonly memoryCount: number;
	readonly topics: ReadonlyArray<KnowledgeTopic>;
}

export interface KnowledgeRepo {
	readonly repoName: string;
	readonly memoryCount: number;
	readonly indexPath: string;
	readonly categories: ReadonlyArray<KnowledgeCategory>;
}
```

Add to `SidebarInboundMsg`: `| { readonly type: "kb:knowledgeData"; readonly repos: ReadonlyArray<KnowledgeRepo> }`

- [ ] **Step 4: Run the test + typecheck to verify they pass**

Run: `npm run typecheck -w vscode && npm run test:vscode -- src/views/SidebarMessages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarMessages.ts vscode/src/views/SidebarMessages.test.ts
git commit -s -m "feat(vscode): add kb:knowledgeData message protocol"
```

---

### Task 2: Host knowledge builder (`kb:knowledgeData` from the graph artifact)

**Files:**
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` — handle a knowledge-data request; add `pushKnowledgeData()` projecting each repo's graph artifact → `KnowledgeRepo[]`.
- Test: `vscode/src/views/SidebarWebviewProvider.test.ts`

**Interfaces:**
- Consumes (Task 1): `KnowledgeRepo` / `KnowledgeCategory` / `KnowledgeTopic`.
- Produces: provider method `pushKnowledgeData(): Promise<void>` posting `{ type: "kb:knowledgeData", repos }`.

**Sourcing (read the existing graph reader, don't reinvent):** the knowledge-graph artifact is read by `readGraph(rootDir)` from `cli/src/graph/GraphArtifactStore.ts`, returning `KnowledgeGraph | null` with `categories: GraphCategory[]` (`{ id, shortTitle, summary, topicCount, commitCount }`) and `topics: GraphTopic[]` (`{ slug, title, shortTitle, categoryId, commitCount, wikiFile }`). For each repo discoverable under the Memory Bank parent (reuse the SAME repo enumeration `selection:repos` / the Memory Bank tree already use — READ how `KnowledgeGraphPanel` / `openKnowledgeGraph` resolve a repo's graph to reuse the exact path/accessor), read its graph and project:
- `KnowledgeRepo.repoName` = repo name; `memoryCount` = sum of `category.commitCount` (or graph stats); `indexPath` = that repo's `_wiki/_index.md` absolute path.
- `categories`: one `KnowledgeCategory` per `GraphCategory` — `name` = `shortTitle`, `description` = `summary` (omit if empty), `topicCount` = `topicCount`, `memoryCount` = `commitCount`, `topics` = the `GraphTopic`s whose `categoryId` matches.
- `topics`: `title` = `title` (or `shortTitle`), `stableSlug` = `slug`, `memoryCount` = `commitCount`, `wikiFile` = `wikiFile` (the absolute `_wiki/topic--<slug>.md` path).
- A repo with **no graph artifact** (`readGraph` → null) contributes a `KnowledgeRepo` with empty `categories` (the client shows the `nowiki` CTA for it). Never throw.

Use the same storage/repo resolution the provider already uses for the Memory Bank tree / branch-memories paths. Add a host dep if needed (e.g. `readGraphForRepo(repoName, remoteUrl)`), optional on `SidebarWebviewDeps`, injected in the test and wired live in Task 5 — mirror the PR3 dep pattern.

- [ ] **Step 1: Write the failing test**

In `vscode/src/views/SidebarWebviewProvider.test.ts`, mirror an existing handled-message/data-push test (e.g. the PR3 `pushMemoryEvidence` or `kb:expandFolder` case). Inject a fake graph reader returning a small `KnowledgeGraph` (one category, one topic), trigger the knowledge-data request, and assert a `kb:knowledgeData` message is posted whose `repos[0].categories[0].topics[0]` carries the projected `title` / `stableSlug` / `memoryCount` / `wikiFile`. Add a second case: a repo whose graph reader returns `null` → its `KnowledgeRepo.categories` is `[]`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts`
Expected: FAIL — no knowledge-data handler / no `kb:knowledgeData` posted.

- [ ] **Step 3: Implement the handler + `pushKnowledgeData`**

Add the request handler (the client triggers it on entering the Knowledge view — wire the outbound trigger in Task 3; the host method is `pushKnowledgeData`) → read each repo's graph via the dep / `readGraph`, project to `KnowledgeRepo[]` per the sourcing notes, and `this.postMessage({ type: "kb:knowledgeData", repos })`. On a repo read error, contribute an empty-categories repo; never throw the whole push.

(Implementer: read `KnowledgeGraphPanel` / `openKnowledgeGraph` + `GraphArtifactStore.readGraph` to reuse the exact per-repo graph resolution; extract a shared helper only if DRY without changing the graph panel's behavior. No `!` non-null assertions — use `?.`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck -w vscode && npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarWebviewProvider.ts vscode/src/views/SidebarWebviewProvider.test.ts
git commit -s -m "feat(vscode): host builds knowledge tree from the graph artifact"
```

---

### Task 3: Knowledge view — header, Overview, graph entry, repo→category→topic tree, empty state

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — replace `renderKnowledge` (`:1433`); store `knowledgeData`; handle `kb:knowledgeData`; trigger `pushKnowledgeData` on entering the view; extend `applyRepoFilterVisibility` to the knowledge view.
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — knowledge tree / entry-row styling.
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`, `vscode/src/views/SidebarCssBuilder.test.ts`

**Interfaces:**
- Consumes (Task 1/2): inbound `kb:knowledgeData` (`{ repos }`); the existing `jollimemory.viewKnowledgeGraph` / `jollimemory.compileNow` commands; PR3's `applyRepoFilterVisibility` / `kbRepoFilter`.
- Produces: a populated Knowledge view; an outbound knowledge-data request on entry.

- [ ] **Step 1: Write the failing tests**

Add to `vscode/src/views/SidebarScriptBuilder.test.ts`:

```ts
it("renders the Knowledge view: Overview + graph entry + repo/category/topic tree", () => {
	const js = buildSidebarScript();
	expect(js).toContain("'kb:knowledgeData'");
	expect(js).toContain("function renderKnowledge");
	expect(js).toContain("Overview");
	// single graph entry reuses the existing command (not a graph-list mode)
	expect(js).toContain("jollimemory.viewKnowledgeGraph");
	// no leftover stub
	expect(js).not.toContain("Knowledge wiki — coming soon.");
});

it("shows a Build CTA when a repo has no compiled wiki, and Rebuild reuses compileNow", () => {
	const js = buildSidebarScript();
	expect(js).toContain("jollimemory.compileNow");
	expect(js).toContain("Build Knowledge Wiki");
});
```

Add to `vscode/src/views/SidebarCssBuilder.test.ts`:

```ts
it("styles the Knowledge wiki tree and entry rows", () => {
	const css = buildSidebarCss();
	expect(css).toContain(".kn-entry");
	expect(css).toContain(".kn-cat");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: FAIL — markers / `.kn-entry` not present; the stub string still there.

- [ ] **Step 3: Implement the view**

- Add module-scope `let knowledgeData = { repos: [] };` near the other view state.
- Add a `kb:knowledgeData` inbound case: store `msg.repos`; if `state.activeTab === 'knowledge'`, call `renderKnowledge()`.
- On entering the Knowledge view (in `switchTab('knowledge')` and the init/ready path that lands on it), post `{ type: 'refresh', scope: 'knowledge' }`-style request OR a dedicated outbound; the host's `pushKnowledgeData` answers. (Reuse the existing refresh scope plumbing — `scope: state.activeTab` already covers `'knowledge'`; have `handleRefresh('knowledge')` / ready call `pushKnowledgeData`.)
- Extend `applyRepoFilterVisibility` (PR3): change `const isKb = state.activeTab === 'kb';` to also include `'knowledge'` so the "Showing: <repo>" filter shows (and the branch segment hides) on the Knowledge view too.
- Replace `renderKnowledge()` to render, into `tabContents.knowledge`:
  - a header line "Built from N memories" (N = sum across shown repos) + a Rebuild icon-button dispatching `jollimemory.compileNow`;
  - an **Overview** entry row (`.kn-entry`) → open the active repo's `indexPath` via the existing open-file command;
  - a **Knowledge graph** entry row (`.kn-entry`) → `{ type: 'command', command: 'jollimemory.viewKnowledgeGraph', args: [repoName] }` (single entry — ④a);
  - the **tree**: for each repo (filtered by `kbRepoFilter` when set), a repo node → `.kn-cat` category nodes (name + counts + optional description) → topic rows (title + memoryCount) that open `topic.wikiFile` via the existing open-file command;
  - when a repo has empty `categories`, render the **`nowiki`** empty state for it: a "Build Knowledge Wiki" button dispatching `jollimemory.compileNow`.
- Category/repo expansion state is per-session (mirror the Memory Bank tree's collapse pattern). Reuse the existing open-file command the Memory Bank tree uses for `.md` files (read `renderFolders`' file-open path) — do not invent a new open mechanism.
- Add `.kn-entry` / `.kn-cat` (+ topic row) CSS to `SidebarCssBuilder.ts`, mirroring the existing tree/section rhythm.

(Implementer: realize the DOM against the test markers; reuse `el`/`clear`/icon helpers, the breadcrumb/repo-filter infra, and the existing command-dispatch + open-file paths.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: PASS (incl. the `new Function(...)` parse smoke test).

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts vscode/src/views/SidebarCssBuilder.test.ts
git commit -s -m "feat(vscode): in-sidebar repo-grouped Knowledge wiki + single graph entry"
```

---

### Task 4: Knowledge search filter

**Files:**
- Modify: `vscode/src/views/SidebarHtmlBuilder.ts` — add the "Search topics & decisions…" input to the knowledge header (or render it from the script — match where the Memory Bank search lives).
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — a `knowledgeQuery` state that filters the rendered tree by topic/category title.
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

**Interfaces:**
- Consumes (Task 3): `knowledgeData` + `renderKnowledge`.
- Produces: client-side filtering of the Knowledge tree by query.

- [ ] **Step 1: Write the failing test**

Add to `vscode/src/views/SidebarScriptBuilder.test.ts`:

```ts
it("filters the Knowledge tree by a search query", () => {
	const js = buildSidebarScript();
	expect(js).toContain("knowledgeQuery");
	expect(js).toContain("Search topics");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: FAIL — `knowledgeQuery` / "Search topics" not present.

- [ ] **Step 3: Implement the search filter**

Add a `let knowledgeQuery = '';` state and a "Search topics & decisions…" input rendered in the Knowledge header (place it the way the Memory Bank `mb-search` is placed). On input, set `knowledgeQuery` (lower-cased) and re-render. In `renderKnowledge`, when `knowledgeQuery` is non-empty, keep only topics whose `title` (or category `name`) contains the query, drop categories left with no matching topics, and drop repos left empty (but never hide the search box itself). Clearing the box restores the full tree.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarHtmlBuilder.ts vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts
git commit -s -m "feat(vscode): client-side search filter for the Knowledge wiki"
```

---

### Task 5: Wire the graph-read dep + full gate + smoke

**Files:**
- Modify: `vscode/src/Extension.ts` — inject the graph-read dep (if Task 2 added one) into the LIVE `SidebarWebviewProvider`.
- Test: `vscode/src/Extension.test.ts` + full suite.

- [ ] **Step 1: Wire the dep into the live provider**

If Task 2 added a graph-read dep (e.g. `readGraphForRepo`) to `SidebarWebviewDeps`, pass it at the MAIN `new SidebarWebviewProvider({...})` in `Extension.ts` (the live sidebar, not the degraded one), sourcing it from the same per-repo graph resolution `openKnowledgeGraph` / `KnowledgeGraphPanel` use (`readGraph` against the repo's kbRoot via `createStorageForRepo` for foreign repos, else the workspace). Add an assertion in `Extension.test.ts` (next to the existing dep guards) that the live deps include it, so a missing wiring can't silently regress.

- [ ] **Step 2: Run the full gate**

Run: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npm run all` and **check the real exit code** (write to a file + `echo $?`; do NOT judge success from a `| tail` pipe, which masks the exit status). Expected: exit 0 across cli + vscode. The CLI `safe.bareRepository` flake is the documented env issue cleared by the prefix. Update (don't weaken) any test that asserted the old Knowledge stub ("coming soon").

- [ ] **Step 3: Manual smoke (best-effort)**

```bash
cd vscode && npm run deploy
```
Reload Window → **Knowledge** view: header shows "Built from N memories" + Rebuild + the "Showing: <repo>" filter; **Overview** opens `_wiki/_index.md`; **Knowledge graph** opens the existing graph panel; the `repo → category → topic` tree renders (categories with counts/descriptions, topics opening their `_wiki/topic--<slug>.md`); a repo with no compiled wiki shows the **Build Knowledge Wiki** CTA; search filters the tree. If the GUI can't be driven here, say so and statically confirm the generated strings.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -s -m "test(vscode): wire knowledge graph dep + align tests with the Knowledge view"
```
(If `npm run all` was clean with no fixups and no wiring was needed, make no commit and say so.)

---

## Self-Review

**1. Spec coverage:** §1 repo-grouped wiki + ④a single graph entry + ④b repo grouping → Tasks 2-3. §1 Build/Rebuild reuse → Task 3 (compileNow). §1 repo filter on Knowledge → Task 3 (applyRepoFilterVisibility extension). §2 Overview/graph/tree/nowiki/search → Tasks 3-4. §3 data (graph artifact, eager push) → Tasks 1-2 + Task 5 wiring. §3 category description-if-present → Task 2 (`category.summary`, omit if empty). §4 testing → embedded + Task 5. Deferred items (full-wiki panes / Share / token meter) → not implemented (correct). The spec's "TopicIndex" source is refined to the graph artifact (documented at top) — same compiled knowledge, with the categories the tree needs.

**2. Placeholder scan:** No `TBD`/`TODO`. Message types (Task 1), the data-source projection mapping (Task 2), and the search filter (Task 4) carry concrete shapes/markers; the host builder (Task 2) and the view renderer (Task 3) are specified by interface/message contract + test-contract markers + exact source anchors (`readGraph`/`GraphSchema` fields, `viewKnowledgeGraph`/`compileNow`, PR3 repo filter) rather than full verbatim DOM/host code — appropriate for integration against large existing files; each names the concrete fields and the existing code to reuse.

**3. Type consistency:** `KnowledgeRepo`/`KnowledgeCategory`/`KnowledgeTopic` (Task 1) are consumed by the host builder (Task 2) and renderer (Task 3) under the same names/fields. `kb:knowledgeData` string matches across Tasks 1-3. `knowledgeData` / `knowledgeQuery` state introduced and used consistently (Tasks 3-4). The graph-read dep added in Task 2 is wired in Task 5 under the same name. `applyRepoFilterVisibility` / `kbRepoFilter` reused from PR3 under their existing names.
