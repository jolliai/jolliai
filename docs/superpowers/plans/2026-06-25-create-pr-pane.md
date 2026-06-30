# Create PR Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a branch-level **Create PR** webview pane (`CreatePrWebviewPanel`) opened by a new `jollimemory.createPrForBranch` command, drafting the PR from the current branch's unmerged memories.

**Architecture:** A new editor-column webview panel modelled on `NoteEditorWebviewPanel` (singleton + nonce + HTML builder) and `SummaryWebviewPanel` (PR data assembly + `handleCreatePr`). Host-side data assembly reuses `loadBranchSummaries` (BranchSummaryLoader), `buildPrBodyMarkdown`/`pickPrTitle`/`wrapWithMarkers` (PrDescription), `getDiffStats` (GitOps), and `handleCreatePr` (PrCommentService). No new PR/git backend.

**Tech Stack:** TypeScript (ESM core bundled into the CJS VS Code extension via esbuild), Vitest + `@vitest/coverage-v8`, Biome (tabs, 120 cols), `vscode` webview API.

## Global Constraints

- DCO sign-off on every commit: `git commit -s`. No `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- `npm run all` (clean → build → lint → test) must pass before any commit; CI runs the same.
- vscode coverage threshold: **97%** statements/branches/functions/lines (`vscode/vitest.config.ts`). New code must not regress it.
- Biome: tabs, 4-wide, 120-col limit; `noExplicitAny: error`, `noUnusedImports/Variables: error`. `npm run lint` is `biome check --error-on-warnings` — warnings fail.
- Webview CSP: **no inline `style=`, no inline event handlers**. Dynamic styles via CSS class; positions via JS `element.style.*` writes (allowed); events via `addEventListener` / delegated handlers. Use a per-render `nonce` for the `<script>` (mirror `NoteEditorHtmlBuilder`).
- Path normalization: use `toForwardSlash` (PathUtils) for `\`→`/`; never inline `.replace(/\\/g,"/")`.
- Coverage exemptions use `/* v8 ignore start */ … /* v8 ignore stop */` blocks (single-line `ignore next` does not work here).
- Run a single vscode test: `npm run test:vscode -- <relativePath> -t "<name>"` (from repo root) or `node ./scripts/run-vitest.mjs run <path>` (from `vscode/`).

---

### Task 1: `loadBranchSummaries` is reused directly (no extraction needed)

`loadBranchSummaries(bridge, mainBranch)` already lives in the shared module `vscode/src/views/BranchSummaryLoader.ts` and is what `SummaryWebviewPanel.loadBranchSummariesForPr` delegates to. The new pane consumes it directly — **no extraction task required.** This task only verifies the contract the later tasks depend on.

**Files:**
- Read-only: `vscode/src/views/BranchSummaryLoader.ts`

**Interfaces:**
- Consumes: `loadBranchSummaries(bridge: JolliMemoryBridge, mainBranch: string): Promise<{ summaries: ReadonlyArray<CommitSummary>; missingCount: number }>`
- Produces: confirmation that `summaries[0]` is the most-recent (HEAD-nearest) branch memory and is the correct anchor for `pickPrTitle` / `buildPrBodyMarkdown`.

- [ ] **Step 1: Confirm the return shape and ordering**

Run: `sed -n '29,120p' vscode/src/views/BranchSummaryLoader.ts`
Expected: a function returning `{ summaries, missingCount }`; confirm `summaries` is ordered most-recent-first (HEAD → main). If ordering is oldest-first, the anchor in Task 4 becomes `summaries[summaries.length - 1]` — record which.

- [ ] **Step 2: No code change; no commit.** Proceed to Task 2.

---

### Task 2: `CreatePrData` assembler — pure host-side data shaping

A single pure-ish async function that turns the current branch into the view-model the panel renders. Isolating it from the panel class makes it unit-testable without the `vscode` webview surface.

**Files:**
- Create: `vscode/src/views/CreatePrData.ts`
- Test: `vscode/src/views/CreatePrData.test.ts`

**Interfaces:**
- Consumes: `loadBranchSummaries` (Task 1); `pickPrTitle`, `buildPrBodyMarkdown` from `../../../cli/src/core/PrDescription.js`; `getDiffStats` from `../../../cli/src/core/GitOps.js`; `JolliMemoryBridge` (`getCurrentBranch()`, `getMergeBase(mainBranch)` or existing diff helper).
- Produces:
```ts
export interface CreatePrFileRow { path: string; dir: string; status: string }
export interface CreatePrMemoryRow { hash: string; title: string; prNumber?: number }
export interface CreatePrViewModel {
	branch: string;
	mainBranch: string;
	memoryCount: number;       // summaries.length
	missingCount: number;
	insertions: number;
	deletions: number;
	filesChanged: number;
	title: string;             // pickPrTitle(anchor, summaries)
	bodyMarkdown: string;      // buildPrBodyMarkdown(anchor, summaries, missingCount) — RAW (no markers)
	memories: CreatePrMemoryRow[];
	files: CreatePrFileRow[];
	e2eScenarios: ReadonlyArray<E2eTestScenario>; // anchor.e2eTestGuide ?? []
}
export async function buildCreatePrViewModel(
	bridge: JolliMemoryBridge,
	mainBranch: string,
): Promise<CreatePrViewModel | { empty: true }>;
```
Returns `{ empty: true }` when the branch has no unmerged memories (`summaries.length === 0`).

- [ ] **Step 1: Write the failing test**

```ts
// vscode/src/views/CreatePrData.test.ts
import { describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../Types";
import { buildCreatePrViewModel } from "./CreatePrData";

function summary(hash: string, msg: string, extra: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 5, commitHash: hash, commitMessage: msg, commitAuthor: "Dev",
		commitDate: "2024-01-01T00:00:00Z", branch: "feature/x", generatedAt: "2024-01-01T00:01:00Z",
		transcripts: [], plans: [], notes: [], references: [], topics: [],
		...extra,
	} as CommitSummary;
}

function makeBridge(over: Partial<Record<string, unknown>> = {}) {
	return {
		getCurrentBranch: vi.fn().mockResolvedValue("feature/x"),
		// getDiffStats is called against the merge-base; stub the bridge helper the
		// assembler uses. If the assembler calls GitOps.getDiffStats directly with
		// bridge.getCwd(), stub getCwd + spy GitOps instead (see Step 3).
		getMergeBaseWithMain: vi.fn().mockResolvedValue("base123"),
		getCwd: vi.fn().mockReturnValue("/repo"),
		...over,
	} as unknown as import("../JolliMemoryBridge").JolliMemoryBridge;
}

describe("buildCreatePrViewModel", () => {
	it("returns { empty: true } when no unmerged memories exist", async () => {
		vi.doMock("./BranchSummaryLoader", () => ({
			loadBranchSummaries: vi.fn().mockResolvedValue({ summaries: [], missingCount: 0 }),
		}));
		const { buildCreatePrViewModel: fn } = await import("./CreatePrData");
		const vm = await fn(makeBridge(), "main");
		expect(vm).toEqual({ empty: true });
	});

	it("assembles title/body/memories/files/e2e from branch summaries", async () => {
		const anchor = summary("aaa1111", "feat: redesign sidebar", {
			e2eTestGuide: [{ title: "Smoke", steps: ["open"], expectedResults: ["ok"] }],
		});
		const older = summary("bbb2222", "fix: bug");
		vi.doMock("./BranchSummaryLoader", () => ({
			loadBranchSummaries: vi.fn().mockResolvedValue({ summaries: [anchor, older], missingCount: 1 }),
		}));
		const { buildCreatePrViewModel: fn } = await import("./CreatePrData");
		const vm = await fn(makeBridge(), "main");
		if ("empty" in vm) throw new Error("expected a view model");
		expect(vm.branch).toBe("feature/x");
		expect(vm.memoryCount).toBe(2);
		expect(vm.missingCount).toBe(1);
		expect(vm.memories.map((m) => m.hash)).toEqual(["aaa1111", "bbb2222"]);
		expect(vm.title.length).toBeGreaterThan(0);
		expect(vm.bodyMarkdown).toContain("feat");
		expect(vm.e2eScenarios).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./scripts/run-vitest.mjs run src/views/CreatePrData.test.ts` (from `vscode/`)
Expected: FAIL — `buildCreatePrViewModel` not found.

- [ ] **Step 3: Write the implementation**

```ts
// vscode/src/views/CreatePrData.ts
import { getDiffStats } from "../../../cli/src/core/GitOps.js";
import { buildPrBodyMarkdown, pickPrTitle } from "../../../cli/src/core/PrDescription.js";
import type { CommitSummary, E2eTestScenario } from "../Types.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { loadBranchSummaries } from "./BranchSummaryLoader.js";

export interface CreatePrFileRow { path: string; dir: string; status: string }
export interface CreatePrMemoryRow { hash: string; title: string; prNumber?: number }
export interface CreatePrViewModel {
	branch: string;
	mainBranch: string;
	memoryCount: number;
	missingCount: number;
	insertions: number;
	deletions: number;
	filesChanged: number;
	title: string;
	bodyMarkdown: string;
	memories: CreatePrMemoryRow[];
	files: CreatePrFileRow[];
	e2eScenarios: ReadonlyArray<E2eTestScenario>;
}

export async function buildCreatePrViewModel(
	bridge: JolliMemoryBridge,
	mainBranch: string,
): Promise<CreatePrViewModel | { empty: true }> {
	const { summaries, missingCount } = await loadBranchSummaries(bridge, mainBranch);
	if (summaries.length === 0) return { empty: true };
	const anchor = summaries[0]; // most-recent (confirm ordering in Task 1)
	const branch = anchor.branch || (await bridge.getCurrentBranch());
	const cwd = bridge.getCwd();
	const base = await bridge.getMergeBaseWithMain(mainBranch);
	const stats = await getDiffStats(base, "HEAD", cwd);
	const memories: CreatePrMemoryRow[] = summaries.map((s) => ({
		hash: s.commitHash,
		title: s.commitMessage.split("\n")[0],
		...(s.prNumber ? { prNumber: s.prNumber } : {}),
	}));
	const files: CreatePrFileRow[] = await bridge.getBranchChangedFiles(base);
	return {
		branch,
		mainBranch,
		memoryCount: summaries.length,
		missingCount,
		insertions: stats.insertions,
		deletions: stats.deletions,
		filesChanged: stats.filesChanged,
		title: pickPrTitle(anchor, summaries),
		bodyMarkdown: buildPrBodyMarkdown(anchor, summaries, missingCount),
		memories,
		files,
		e2eScenarios: anchor.e2eTestGuide ?? [],
	};
}
```

> **Implementer note:** `bridge.getMergeBaseWithMain`, `bridge.getBranchChangedFiles`, `bridge.getCwd`, and `summary.prNumber` may not exist verbatim. Before writing, grep `JolliMemoryBridge.ts` for an existing merge-base / changed-files / cwd accessor and the `CommitSummary` PR-number field; reuse the real names. If a merge-base helper is absent, add a thin one to the bridge that runs `git merge-base <mainBranch> HEAD` via the existing GitClient, with its own unit test. Keep the assembler's signature above unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./scripts/run-vitest.mjs run src/views/CreatePrData.test.ts`
Expected: PASS (both cases). Add a third case if a new bridge helper was introduced.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/CreatePrData.ts vscode/src/views/CreatePrData.test.ts
git commit -s -m "feat(vscode): Create PR pane data assembler"
```

---

### Task 3: Create PR pane HTML/CSS builder

Pure string builders for the pane's markup and styles, following the `NoteEditorHtmlBuilder` pattern (nonce-gated script, no inline styles). Splitting the builder out keeps it unit-testable and the panel class thin.

**Files:**
- Create: `vscode/src/views/CreatePrHtmlBuilder.ts`
- Test: `vscode/src/views/CreatePrHtmlBuilder.test.ts`

**Interfaces:**
- Consumes: `CreatePrViewModel` (Task 2), a `nonce: string`.
- Produces: `buildCreatePrHtml(vm: CreatePrViewModel, nonce: string): string` — a full `<!DOCTYPE html>` document with: an `<h1>Create Pull Request</h1>`, a `.meta-strip`, a Title panel, a Body panel (rendered markdown), a "Memories included" panel with one `.row[data-hash]` per memory, an "E2E Test Guide" panel rendered only when `vm.e2eScenarios.length > 0`, a "Files changed" panel with one `.row[data-path]` per file, and an actions row with buttons `#cmd-create-pr`, `#cmd-edit`, `#cmd-copy-body`. Includes a `<script nonce>` that `addEventListener`s those buttons + rows and `postMessage`s `{ command: 'createPr' | 'edit' | 'copyBody' }` / `{ command: 'openMemory', hash }` / `{ command: 'openDiff', path }`.

- [ ] **Step 1: Write the failing test**

```ts
// vscode/src/views/CreatePrHtmlBuilder.test.ts
import { describe, expect, it } from "vitest";
import type { CreatePrViewModel } from "./CreatePrData";
import { buildCreatePrHtml } from "./CreatePrHtmlBuilder";

const vm: CreatePrViewModel = {
	branch: "feature/x", mainBranch: "main", memoryCount: 2, missingCount: 0,
	insertions: 184, deletions: 37, filesChanged: 5,
	title: "feat: redesign", bodyMarkdown: "**Summary**\n\nDoes things.",
	memories: [{ hash: "aaa1111", title: "Redesign" }, { hash: "bbb2222", title: "Fix" }],
	files: [{ path: "vscode/src/a.ts", dir: "vscode/src", status: "M" }],
	e2eScenarios: [],
};

describe("buildCreatePrHtml", () => {
	it("renders meta strip, title, memories and files; omits empty E2E", () => {
		const html = buildCreatePrHtml(vm, "NONCE");
		expect(html).toContain("Create Pull Request");
		expect(html).toContain("feature/x");
		expect(html).toContain("main");
		expect(html).toContain("+184");
		expect(html).toContain("−37"); // −37
		expect(html).toContain('data-hash="aaa1111"');
		expect(html).toContain('data-path="vscode/src/a.ts"');
		expect(html).not.toContain("E2E Test Guide");
		expect(html).toContain('nonce="NONCE"');
	});

	it("renders the E2E panel when scenarios are present", () => {
		const html = buildCreatePrHtml({ ...vm, e2eScenarios: [{ title: "Smoke", steps: ["s"], expectedResults: ["e"] }] }, "N");
		expect(html).toContain("E2E Test Guide");
		expect(html).toContain("Smoke");
	});

	it("escapes HTML in titles to prevent injection", () => {
		const html = buildCreatePrHtml({ ...vm, title: "<img src=x onerror=1>" }, "N");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./scripts/run-vitest.mjs run src/views/CreatePrHtmlBuilder.test.ts`
Expected: FAIL — `buildCreatePrHtml` not found.

- [ ] **Step 3: Write the implementation**

Mirror `NoteEditorHtmlBuilder.ts` for the document skeleton, CSP `<meta>`, and `nonce` placement. Use an `escapeHtml` helper (reuse the existing one — grep `vscode/src/views` for `escapeHtml`/`escapeHtmlAttr`; if absent, add a 3-line local one with a test). Render markdown with the existing markdown renderer used by the summary panes (grep for `renderMarkdown`/`md-mock`); if none is reusable, render `bodyMarkdown` inside a `<pre class="md-raw">` and note it for a follow-up. Concrete structure (abbreviated — fill every section, no placeholders):

```ts
// vscode/src/views/CreatePrHtmlBuilder.ts
import type { CreatePrViewModel } from "./CreatePrData.js";

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function buildCreatePrHtml(vm: CreatePrViewModel, nonce: string): string {
	const metaStrip =
		`<div class="meta-strip"><span class="meta-branch">${esc(vm.branch)}</span>` +
		`<span class="meta-sep">→</span><span class="meta-branch">${esc(vm.mainBranch)}</span>` +
		`<span class="meta-sep">·</span><span>drafted from ${vm.memoryCount} memor${vm.memoryCount === 1 ? "y" : "ies"}</span>` +
		`<span class="meta-sep">·</span><span class="ship-status">+${vm.insertions} −${vm.deletions} · ${vm.filesChanged} file${vm.filesChanged === 1 ? "" : "s"}</span></div>`;
	const memRows = vm.memories.map((m) =>
		`<div class="row" data-hash="${esc(m.hash)}"><span class="mem-ico">▤</span>` +
		`<div class="r-main"><div class="r-title">${esc(m.title)}</div>` +
		`<div class="r-sub"><span class="meta-hash">${esc(m.hash.slice(0, 8))}</span>${m.prNumber ? ` · PR #${m.prNumber}` : ""}</div></div></div>`).join("");
	const fileRows = vm.files.map((f) =>
		`<div class="row" data-path="${esc(f.path)}"><div class="r-main">` +
		`<div class="r-title fname-${esc(f.status)}">${esc(f.path.split("/").pop() ?? f.path)}</div>` +
		`<div class="r-sub">${esc(f.dir)}</div></div><span class="gs gs-${esc(f.status)}">${esc(f.status)}</span></div>`).join("");
	const e2e = vm.e2eScenarios.length === 0 ? "" :
		`<div class="panel"><div class="panel-header"><span class="panel-title">E2E Test Guide</span>` +
		`<span class="ship-status is-ok">${vm.e2eScenarios.length} SCENARIO${vm.e2eScenarios.length === 1 ? "" : "S"}</span></div>` +
		`<div class="md-mock">${vm.e2eScenarios.map((s) =>
			`<p><b>${esc(s.title)}</b></p>` +
			`<ol>${s.steps.map((st) => `<li>${esc(st)}</li>`).join("")}</ol>` +
			`<p><i>Expect:</i> ${s.expectedResults.map(esc).join("; ")}</p>`).join("")}</div></div>`;
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>/* mirror NoteEditor/Summary panel base styles; .pane,.panel,.row,.meta-strip,.btn,.gs-* */</style>
</head><body><div class="pane" id="pane-pr">
<h1>Create Pull Request</h1>
${metaStrip}
<div class="panel"><div class="panel-header"><span class="panel-title">Title</span></div><p>${esc(vm.title)}</p></div>
<div class="panel"><div class="panel-header"><span class="panel-title">Body — drafted from this branch’s memories</span></div><pre class="md-raw">${esc(vm.bodyMarkdown)}</pre></div>
<div class="panel"><div class="panel-header"><span class="panel-title">Memories included</span><span class="sec-count">${vm.memoryCount}</span></div>${memRows}</div>
${e2e}
<div class="panel"><div class="panel-header"><span class="panel-title">Files changed</span><span class="sec-count">${vm.filesChanged}</span></div>${fileRows}</div>
<div class="actions">
<button class="btn" id="cmd-create-pr"><span class="codicon codicon-git-pull-request"></span> Create PR</button>
<button class="btn secondary" id="cmd-edit">Edit</button>
<button class="btn secondary" id="cmd-copy-body">Copy body</button>
</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('cmd-create-pr').addEventListener('click', () => vscode.postMessage({ command: 'createPr' }));
document.getElementById('cmd-edit').addEventListener('click', () => vscode.postMessage({ command: 'edit' }));
document.getElementById('cmd-copy-body').addEventListener('click', () => vscode.postMessage({ command: 'copyBody' }));
document.querySelectorAll('.row[data-hash]').forEach((r) => r.addEventListener('click', () => vscode.postMessage({ command: 'openMemory', hash: r.getAttribute('data-hash') })));
document.querySelectorAll('.row[data-path]').forEach((r) => r.addEventListener('click', () => vscode.postMessage({ command: 'openDiff', path: r.getAttribute('data-path') })));
</script></body></html>`;
}
```

> **Implementer note:** fill the `<style>` block by copying the relevant `.pane/.panel/.row/.meta-strip/.btn/.gs-*` rules from the existing summary-panel CSS builder (grep `SummaryCssBuilder`/`SummaryHtmlBuilder`) so the pane matches the redesign visually. The CSP `style-src 'unsafe-inline'` here matches the existing panels' policy — confirm against `NoteEditorHtmlBuilder` and copy its exact CSP string.

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./scripts/run-vitest.mjs run src/views/CreatePrHtmlBuilder.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/CreatePrHtmlBuilder.ts vscode/src/views/CreatePrHtmlBuilder.test.ts
git commit -s -m "feat(vscode): Create PR pane HTML builder"
```

---

### Task 4: `CreatePrWebviewPanel` class + message handling

The panel class: singleton, builds the view model, renders HTML, and handles the three actions. Modelled on `NoteEditorWebviewPanel` (lifecycle) and `SummaryWebviewPanel` (PR actions + guards).

**Files:**
- Create: `vscode/src/views/CreatePrWebviewPanel.ts`
- Test: `vscode/src/views/CreatePrWebviewPanel.test.ts`

**Interfaces:**
- Consumes: `buildCreatePrViewModel` (Task 2), `buildCreatePrHtml` (Task 3), `handleCreatePr` from `../services/PrCommentService.js`, `wrapWithMarkers` from `../../../cli/src/core/PrDescription.js`, `isWorkerBlockingBusy` (existing util), `JolliMemoryBridge`.
- Produces: `CreatePrWebviewPanel.show(extensionUri: vscode.Uri, workspaceRoot: string, bridge: JolliMemoryBridge, mainBranch: string): Promise<void>` and `CreatePrWebviewPanel.dispose()` (test reset).

- [ ] **Step 1: Write the failing test**

```ts
// vscode/src/views/CreatePrWebviewPanel.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<{ html: string; onMsg: (m: unknown) => void; reveal: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
vi.mock("vscode", () => ({
	ViewColumn: { One: 1, Active: -1 },
	Uri: { file: (p: string) => ({ fsPath: p }) },
	env: { clipboard: { writeText: vi.fn() } },
	window: {
		createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
		showInformationMessage: vi.fn(),
		createWebviewPanel: vi.fn(() => {
			const rec = {
				html: "", reveal: vi.fn(), dispose: vi.fn(), onMsg: (_: unknown) => {},
				webview: { html: "", postMessage: vi.fn(), onDidReceiveMessage: (cb: (m: unknown) => void) => { rec.onMsg = cb; return { dispose() {} }; } },
				onDidDispose: (_cb: () => void) => ({ dispose() {} }),
			};
			created.push(rec as never);
			return rec;
		}),
	},
}));

const handleCreatePr = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/PrCommentService.js", () => ({ handleCreatePr }));
vi.mock("./CreatePrData", () => ({
	buildCreatePrViewModel: vi.fn().mockResolvedValue({
		branch: "feature/x", mainBranch: "main", memoryCount: 1, missingCount: 0,
		insertions: 1, deletions: 0, filesChanged: 1, title: "feat: x", bodyMarkdown: "B",
		memories: [{ hash: "h", title: "t" }], files: [], e2eScenarios: [],
	}),
}));

import { CreatePrWebviewPanel } from "./CreatePrWebviewPanel";

const bridge = { getCurrentBranch: vi.fn().mockResolvedValue("feature/x"), getCwd: () => "/repo" } as never;

beforeEach(() => { created.length = 0; CreatePrWebviewPanel.dispose(); vi.clearAllMocks(); });

describe("CreatePrWebviewPanel", () => {
	it("opens a panel and renders the Create PR HTML", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created).toHaveLength(1);
		expect(created[0].webview.html).toContain("Create Pull Request");
	});

	it("createPr message routes to handleCreatePr with title+wrapped body", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "createPr" });
		await Promise.resolve(); await Promise.resolve();
		expect(handleCreatePr).toHaveBeenCalledTimes(1);
		expect(handleCreatePr.mock.calls[0][0]).toBe("feat: x"); // title
	});

	it("copyBody writes the wrapped markdown to the clipboard", async () => {
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "copyBody" });
		await Promise.resolve();
		expect((vscode.env.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
	});

	it("is a singleton — second show reveals, not re-creates", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created).toHaveLength(1);
		expect(created[0].reveal).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./scripts/run-vitest.mjs run src/views/CreatePrWebviewPanel.test.ts`
Expected: FAIL — module/class not found.

- [ ] **Step 3: Write the implementation**

```ts
// vscode/src/views/CreatePrWebviewPanel.ts
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { wrapWithMarkers } from "../../../cli/src/core/PrDescription.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { handleCreatePr } from "../services/PrCommentService.js";
import { log } from "../util/Logger.js";
import { buildCreatePrViewModel, type CreatePrViewModel } from "./CreatePrData.js";
import { buildCreatePrHtml } from "./CreatePrHtmlBuilder.js";

type Msg =
	| { command: "createPr" }
	| { command: "edit" }
	| { command: "copyBody" }
	| { command: "openMemory"; hash: string }
	| { command: "openDiff"; path: string };

export class CreatePrWebviewPanel {
	private static current: CreatePrWebviewPanel | undefined;
	private vm: CreatePrViewModel | undefined;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly bridge: JolliMemoryBridge,
		private readonly workspaceRoot: string,
	) {
		this.panel.onDidDispose(() => { CreatePrWebviewPanel.current = undefined; });
		this.panel.webview.onDidReceiveMessage((m: Msg) => { void this.handle(m); });
	}

	static async show(
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		bridge: JolliMemoryBridge,
		mainBranch: string,
	): Promise<void> {
		const result = await buildCreatePrViewModel(bridge, mainBranch);
		if ("empty" in result) {
			await vscode.window.showInformationMessage("No committed memories on this branch yet — nothing to open a PR from.");
			return;
		}
		if (CreatePrWebviewPanel.current) {
			CreatePrWebviewPanel.current.render(result);
			CreatePrWebviewPanel.current.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			"jollimemory.createPr",
			`Create PR — ${result.branch}`,
			vscode.ViewColumn.One,
			{ enableScripts: true, localResourceRoots: [extensionUri], retainContextWhenHidden: true },
		);
		const self = new CreatePrWebviewPanel(panel, bridge, workspaceRoot);
		CreatePrWebviewPanel.current = self;
		self.render(result);
	}

	static dispose(): void {
		CreatePrWebviewPanel.current?.panel.dispose();
		CreatePrWebviewPanel.current = undefined;
	}

	private render(vm: CreatePrViewModel): void {
		this.vm = vm;
		this.panel.webview.html = buildCreatePrHtml(vm, randomBytes(16).toString("hex"));
	}

	private async handle(m: Msg): Promise<void> {
		if (!this.vm) return;
		const post = (msg: Record<string, unknown>): void => { void this.panel.webview.postMessage(msg); };
		switch (m.command) {
			case "createPr":
				await handleCreatePr(this.vm.title, wrapWithMarkers(this.vm.bodyMarkdown), this.workspaceRoot, post, this.vm.branch);
				return;
			case "copyBody":
				await vscode.env.clipboard.writeText(wrapWithMarkers(this.vm.bodyMarkdown));
				await vscode.window.showInformationMessage("PR body copied to clipboard.");
				return;
			case "edit":
				// Reveal the editable title/body form (reuses the PrCommentService
				// create-form interaction). Implemented in Task 5.
				post({ command: "prShowCreateForm", title: this.vm.title, body: wrapWithMarkers(this.vm.bodyMarkdown) });
				return;
			case "openMemory":
				await vscode.commands.executeCommand("jollimemory.viewMemorySummary", m.hash);
				return;
			case "openDiff":
				await this.bridge.openBranchFileDiff(m.path, this.vm.branch).catch((e: unknown) =>
					log.warn("CreatePrPanel", `openDiff failed: ${e instanceof Error ? e.message : String(e)}`));
				return;
		}
	}
}
```

> **Implementer note:** `bridge.openBranchFileDiff` may not exist — grep the bridge for the existing changed-file diff opener used by the Files sub-section / commit-file rows and reuse it; adjust the call to its real signature. The `edit` form (`prShowCreateForm` + an editable textarea that posts `createPr` with edited title/body) is finished in Task 5; for now the panel posts the message and the create button still works with the unedited body.

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./scripts/run-vitest.mjs run src/views/CreatePrWebviewPanel.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/CreatePrWebviewPanel.ts vscode/src/views/CreatePrWebviewPanel.test.ts
git commit -s -m "feat(vscode): CreatePrWebviewPanel with create/copy/open actions"
```

---

### Task 5: Edit form (editable title + body) in the pane

Adds the read-first → editable transition: `Edit` swaps the Title/Body panels for inputs and a "Create with these" button that posts `createPr` carrying the edited values. Reuses the `PrCommentService` create-form markup/CSS if shareable; otherwise a minimal inline form.

**Files:**
- Modify: `vscode/src/views/CreatePrHtmlBuilder.ts` (add a hidden `.edit-form` with `#prTitleInput` + `#prBodyInput` + `#cmd-create-edited`; script toggles `.hidden`)
- Modify: `vscode/src/views/CreatePrWebviewPanel.ts` (`handle` accepts `{ command: "createPr", title?, body? }` and uses the edited values when present)
- Test: extend `CreatePrWebviewPanel.test.ts` + `CreatePrHtmlBuilder.test.ts`

**Interfaces:**
- Consumes: existing Task 3/4 outputs.
- Produces: `createPr` message optionally carrying `{ title, body }`; when present, `handleCreatePr` is called with the edited (already-wrapped or to-be-wrapped) values.

- [ ] **Step 1: Write the failing test**

```ts
// add to CreatePrWebviewPanel.test.ts
it("createPr with edited title/body overrides the drafted values", async () => {
	await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
	created[0].onMsg({ command: "createPr", title: "edited title", body: "edited body" });
	await Promise.resolve(); await Promise.resolve();
	expect(handleCreatePr.mock.calls[0][0]).toBe("edited title");
	expect(handleCreatePr.mock.calls[0][1]).toContain("edited body");
});
```
```ts
// add to CreatePrHtmlBuilder.test.ts
it("includes a hidden edit form with title and body inputs", () => {
	const html = buildCreatePrHtml(vm, "N");
	expect(html).toContain('id="prTitleInput"');
	expect(html).toContain('id="prBodyInput"');
	expect(html).toContain("edit-form hidden");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node ./scripts/run-vitest.mjs run src/views/CreatePrWebviewPanel.test.ts src/views/CreatePrHtmlBuilder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `CreatePrHtmlBuilder.ts`, add after the actions row:
```html
<div class="edit-form hidden" id="edit-form">
<input id="prTitleInput" class="pr-input" />
<textarea id="prBodyInput" class="pr-textarea" rows="12"></textarea>
<button class="btn" id="cmd-create-edited"><span class="codicon codicon-git-pull-request"></span> Create with these</button>
</div>
```
and in the `<script nonce>`:
```js
document.getElementById('cmd-edit').addEventListener('click', () => {
  document.getElementById('prTitleInput').value = ${JSON.stringify(/* set in builder */ "")};
  document.getElementById('edit-form').classList.remove('hidden');
});
document.getElementById('cmd-create-edited').addEventListener('click', () => vscode.postMessage({
  command: 'createPr',
  title: document.getElementById('prTitleInput').value,
  body: document.getElementById('prBodyInput').value,
}));
```
(Prefill the inputs server-side via `value="${esc(vm.title)}"` and the textarea's text content `${esc(vm.bodyMarkdown)}`.)

In `CreatePrWebviewPanel.ts`, change the `createPr` case:
```ts
case "createPr": {
	const title = m.title && m.title.trim() ? m.title : this.vm.title;
	const body = m.body && m.body.trim() ? wrapWithMarkers(m.body) : wrapWithMarkers(this.vm.bodyMarkdown);
	await handleCreatePr(title, body, this.workspaceRoot, post, this.vm.branch);
	return;
}
```
(Update the `Msg` type's `createPr` variant to `{ command: "createPr"; title?: string; body?: string }`.)

- [ ] **Step 4: Run to verify pass**

Run: `node ./scripts/run-vitest.mjs run src/views/CreatePrWebviewPanel.test.ts src/views/CreatePrHtmlBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/CreatePrHtmlBuilder.ts vscode/src/views/CreatePrWebviewPanel.ts vscode/src/views/CreatePrHtmlBuilder.test.ts vscode/src/views/CreatePrWebviewPanel.test.ts
git commit -s -m "feat(vscode): editable title/body in Create PR pane"
```

---

### Task 6: Register `jollimemory.createPrForBranch` command

Wires the panel to a command id (the command-bar PR button in Plan 2 will invoke this).

**Files:**
- Modify: `vscode/src/Extension.ts` (register the command near `viewMemorySummary`)
- Modify: `vscode/package.json` (`contributes.commands` entry, if other jollimemory commands are declared there — grep first; many are registered without a contributes entry)
- Test: `vscode/src/Extension.*.test.ts` if command registration is unit-tested, else covered via the panel test.

**Interfaces:**
- Consumes: `CreatePrWebviewPanel.show`, `commitsStore.getMainBranch()`, `bridge`, `workspaceRoot`, `context.extensionUri`.
- Produces: command id `jollimemory.createPrForBranch`.

- [ ] **Step 1: Write the implementation (registration)**

```ts
// vscode/src/Extension.ts — alongside viewMemorySummary registration
vscode.commands.registerCommand("jollimemory.createPrForBranch", async () => {
	await CreatePrWebviewPanel.show(
		context.extensionUri,
		workspaceRoot,
		bridge,
		commitsStore.getMainBranch(),
	);
}),
```
Add the import: `import { CreatePrWebviewPanel } from "./views/CreatePrWebviewPanel.js";`

- [ ] **Step 2: Verify build + lint**

Run (from repo root): `npm run build:cli && npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Manual smoke (built artifact)**

`cd vscode && npm run build` → in VS Code run **Developer: Reload Window**, open Command Palette → "createPrForBranch" (or trigger via the temporary keybinding) on a branch with ≥1 memory; confirm the pane opens and Create PR pushes + runs `gh`.

- [ ] **Step 4: Commit**

```bash
git add vscode/src/Extension.ts vscode/package.json
git commit -s -m "feat(vscode): register jollimemory.createPrForBranch command"
```

---

### Task 7: Full gate + coverage

- [ ] **Step 1: Run the full chain**

Run (repo root): `npm run all`
Expected: clean → build → lint → test all pass; vscode coverage ≥ 97% on all four metrics.

- [ ] **Step 2: If coverage dipped**, add focused tests for the uncovered branches (e.g. the `empty` path, `edit` with blank inputs, `openDiff` rejection). Re-run.

- [ ] **Step 3: Commit any coverage tests**

```bash
git add vscode/src/views/CreatePr*.test.ts
git commit -s -m "test(vscode): cover Create PR pane edge cases"
```

---

## Self-Review

**Spec coverage (§ from `2026-06-25-…-design.md`):**
- §6.1 data assembly → Task 2. §6.2 sections (Title/Body/Memories/E2E/Files) → Task 3. §6.3 actions (Create PR/Edit/Copy body) → Tasks 4–5. §6.4 cross-branch + worker-busy guards → **handled inside `handleCreatePr`** (already guards cross-branch via `summaryBranch`); worker-busy guard is in `SummaryWebviewPanel` not `handleCreatePr` — **gap:** add an `isWorkerBlockingBusy(workspaceRoot)` check in the panel's `createPr` case before calling `handleCreatePr`, with a toast, mirroring `SummaryWebviewPanel.handleWorkerBusyOrContinue`. (Add as a step in Task 4/5.)
- §5.4 `createPrForBranch` → Task 6.
- "Create PR & Share" deferral → respected (single `Create PR` button; no sync).

**Placeholder scan:** Implementer notes flag the three real-name lookups (`getMergeBaseWithMain`/`getBranchChangedFiles`/`openBranchFileDiff`/`prNumber`) that must be reconciled with the bridge before coding — these are explicit verification steps, not silent placeholders.

**Type consistency:** `CreatePrViewModel` fields are identical across Tasks 2–4. `handleCreatePr(title, body, cwd, postMessage, summaryBranch)` matches `PrCommentService` signature. `wrapWithMarkers` applied once at send time.

**Added task from gap:** worker-busy guard — fold into Task 4 Step 3 (and its test) rather than a new task.
