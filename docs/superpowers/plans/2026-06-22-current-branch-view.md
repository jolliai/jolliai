# PR2 — Current Branch View + Detail-Pane Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the PR1 `Current Branch` view with the mockup's structure (Pinned / Current Memory / Committed Memories) and redesign the Memory detail panel, folding in feedback ①b (one Conversations section, no duplicate Private Transcripts drawer).

**Architecture:** Three phases. **A** regroups the sidebar `renderBranch` output (presentation only — selection state stays in `CommitSelectionStore`). **B** adds a net-new per-branch `PinStore` + a Pinned section + pin/unpin actions + message plumbing. **C** restructures the detail panel (`SummaryHtmlBuilder`) to surface a top Conversations section and remove the bottom "All Conversations" private drawer. Sidebar/detail builders are tested by asserting on the generated string + a `new Function(...)` parse smoke test (the established pattern); `PinStore` gets normal unit tests.

**Tech Stack:** TypeScript (ESM), esbuild (CJS host bundle), Vitest, Biome. VS Code webview, strict CSP. Node 22.5+ (cli), Node 18 target tolerated by the vscode bundle.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` / `🤖 Generated with …` trailers.
- **`npm run all` must pass before commit** (clean → build → lint → test). Phase D runs the full gate; earlier tasks may run scoped commands shown in their steps.
- **Biome:** tabs, 4-wide, 120-col; `noExplicitAny`, `noUnusedImports/Variables` are errors; warnings fail CI.
- **CLI coverage floor (97% statements / 96% branches / 97% functions / 97% lines)** applies to `cli/src` — `PinStore` (Task B1) MUST keep coverage above it. The vscode workspace has no such gate but its tests must pass.
- **CSP — no inline style / no inline JS.** Visibility via the `.hidden` class, never the HTML `hidden` attribute or `el.hidden = X`. No inline `style=`; no inline event handlers in webview HTML.
- **Builder backtick trap:** `SidebarScriptBuilder` / `SidebarCssBuilder` / `SummaryHtmlBuilder` / `SummaryCssBuilder` each return one big template literal — never write a raw backtick inside a comment or string in the builder body (corrupts the literal; the `new Function(...)` parse smoke test guards the script builders).
- **`toForwardSlash` for `\`→`/` path normalization** ([cli/src/core/PathUtils.ts]) — never inline `path.replace(/\\/g,"/")`.
- **Cross-package imports under `vscode/src/**` (e.g. `../../../cli/src/...`) are intentional** — resolved at esbuild bundle time. Don't refactor them.
- **Selection model is frozen:** the Current Memory regroup must NOT change `CommitSelectionStore` or any `toggle*Selection` wire message — it is a presentation regroup only.
- **Share behavior is frozen / deferred** to a dedicated Share PR — do not add, remove, or change any Share affordance.

---

## Phase A — Current Branch sidebar regroup

### Task A1: Regroup renderBranch into Pinned / Current Memory / Committed Memories

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — `renderBranch` (`:2510-2564`), `renderSection` (`:2596`+), section-title strings.
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — add a `.memory-group` / `.subsection` style block (group header + indented sub-sections).
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`, `vscode/src/views/SidebarCssBuilder.test.ts`.

**Interfaces:**
- Consumes: existing `branchData.conversations` / `.plans` / `.changes` / `.commits`; existing `renderConversationRow` / `renderPlanRow` / `renderChangeRow` / `renderCommitRow`; existing `renderSection({id,title,items,emptyText,...})` and `renderSectionActions(id)`.
- Produces: a `renderBranch` that emits a **Pinned** placeholder section (filled in Task B3), a **Current Memory** group header containing three sub-sections (`conversations` / `plans` / `changes`), and a **Committed Memories** section (the existing `commits` section, retitled). Section ids stay `conversations` / `plans` / `changes` / `commits` (collapse-state + selection keys depend on them). Adds a new pinned section id `pinned`.

- [ ] **Step 1: Write the failing tests**

Add to `vscode/src/views/SidebarScriptBuilder.test.ts`:

```ts
it("renders the Current Memory group and Committed Memories sections", () => {
	const js = buildSidebarScript();
	// Current Memory groups Conversations / Context / Files under one header.
	expect(js).toContain("Current Memory");
	expect(js).toContain("Committed Memories");
	// The internal section ids are unchanged (selection + collapse keys).
	expect(js).toContain("id: 'conversations'");
	expect(js).toContain("id: 'changes'");
	expect(js).toContain("id: 'commits'");
});

it("labels the Current Memory sub-sections Conversations / Context / Files", () => {
	const js = buildSidebarScript();
	expect(js).toContain("Conversations");
	expect(js).toContain("Context");
	expect(js).toContain("Files");
});
```

Add to `vscode/src/views/SidebarCssBuilder.test.ts`:

```ts
it("styles the Current Memory group and its sub-sections", () => {
	const css = buildSidebarCss();
	expect(css).toContain(".memory-group");
	expect(css).toContain(".subsection");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: FAIL — "Current Memory" / "Committed Memories" / ".memory-group" not present.

- [ ] **Step 3: Restructure `renderBranch`**

Rework `renderBranch` so that, in non-foreign mode, the three existing workspace-local sections render under a **Current Memory** group with sub-section titles, and the commits section is titled **Committed Memories**. Keep the section descriptor ids unchanged. Concretely, retitle and regroup:

- Conversations sub-section: descriptor `{ id: 'conversations', title: 'Conversations', subsection: true, … }` (was title `'CONVERSATIONS'`).
- Context sub-section: `{ id: 'plans', title: 'Context', subsection: true, … }` (was `'Plans & Notes'`).
- Files sub-section: `{ id: 'changes', title: 'Files', subsection: true, … }` (was `'Changes'`).
- Committed Memories: `{ id: 'commits', title: 'Committed Memories', … }` (was `'Memories'`).

Wrap the three sub-sections in a group container so they read as one "Current Memory" block. Add a group renderer alongside `renderSection`, e.g.:

```js
  function renderMemoryGroup(subSections) {
    const header = el('div', { className: 'memory-group-header' }, [
      el('span', { className: 'section-title', text: 'Current Memory' }),
    ]);
    const body = el('div', { className: 'memory-group-body' }, subSections.map(renderSection));
    return el('div', { className: 'memory-group', 'data-group': 'current-memory' }, [header, body]);
  }
```

Then in `renderBranch`, in the `!foreign` branch, build the three sub-section descriptors (with `subsection: true`), render them via `renderMemoryGroup([...])`, and mount: a Pinned placeholder (Task B3 fills it — for now render an empty section with id `pinned`, title `Pinned`), then the memory group, then the Committed Memories section. Foreign mode is unchanged except the commits title becomes "Committed Memories". `renderSection` should add the `subsection` class to a descriptor flagged `subsection: true` so the CSS can indent it.

(Implementer: realize the exact DOM against the test markers above; preserve `renderSectionActions`, collapse handling via `isCollapsed(s.id)`, and the foreign-mode banner on the commits section.)

- [ ] **Step 4: Add the CSS**

In `vscode/src/views/SidebarCssBuilder.ts`, add (e.g. after the section rules):

```css
  /* Current Memory group — wraps the Conversations / Context / Files
     sub-sections under one heading so they read as the next memory's draft. */
  .memory-group { display: flex; flex-direction: column; }
  .memory-group-header { padding: 6px 8px 2px; font-weight: 600; opacity: 0.85; }
  .memory-group-body { display: flex; flex-direction: column; }
  .subsection .section-title { font-size: 11px; opacity: 0.8; padding-left: 6px; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts vscode/src/views/SidebarCssBuilder.test.ts
git commit -s -m "feat(vscode): regroup Current Branch into Current Memory + Committed Memories"
```

---

## Phase B — Pinned subsystem

### Task B1: PinStore (cli)

**Files:**
- Create: `cli/src/core/PinStore.ts`
- Test: `cli/src/core/PinStore.test.ts`

**Interfaces:**
- Produces:
  - `type PinKind = "conversation" | "plan" | "note" | "memory"`
  - `interface PinEntry { readonly kind: PinKind; readonly id: string; readonly title: string; readonly pinnedAt: number; }`
  - `function pinGroupKey(repoName: string, branchName: string): string` → `` `${repoName}::${branchName}` ``
  - `async function listPins(projectDir: string, repoName: string, branchName: string): Promise<PinEntry[]>`
  - `async function addPin(projectDir: string, repoName: string, branchName: string, entry: PinEntry): Promise<void>` (idempotent on `(kind,id)`; newest `pinnedAt` wins)
  - `async function removePin(projectDir: string, repoName: string, branchName: string, kind: PinKind, id: string): Promise<void>`
  - File: `<projectDir>/.jolli/jollimemory/pins.json`, shape `{ version: 1, groups: { "<repo>::<branch>": PinEntry[] } }`.

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/PinStore.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addPin, listPins, pinGroupKey, removePin } from "./PinStore.js";

describe("PinStore", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pinstore-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("composes the group key as repo::branch", () => {
		expect(pinGroupKey("acme", "main")).toBe("acme::main");
	});

	it("returns [] when no pins file exists", async () => {
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});

	it("adds, lists, and scopes pins per repo::branch", async () => {
		await addPin(dir, "acme", "main", { kind: "memory", id: "abc123", title: "Fix bug", pinnedAt: 1 });
		await addPin(dir, "acme", "feat", { kind: "plan", id: "p1", title: "Plan", pinnedAt: 2 });
		const main = await listPins(dir, "acme", "main");
		expect(main).toHaveLength(1);
		expect(main[0]).toMatchObject({ kind: "memory", id: "abc123" });
		expect(await listPins(dir, "acme", "feat")).toHaveLength(1);
		expect(await listPins(dir, "other", "main")).toEqual([]);
	});

	it("is idempotent on (kind,id) — re-adding updates in place", async () => {
		await addPin(dir, "acme", "main", { kind: "memory", id: "x", title: "old", pinnedAt: 1 });
		await addPin(dir, "acme", "main", { kind: "memory", id: "x", title: "new", pinnedAt: 5 });
		const pins = await listPins(dir, "acme", "main");
		expect(pins).toHaveLength(1);
		expect(pins[0].title).toBe("new");
	});

	it("removes a pin by (kind,id)", async () => {
		await addPin(dir, "acme", "main", { kind: "note", id: "n1", title: "N", pinnedAt: 1 });
		await removePin(dir, "acme", "main", "note", "n1");
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});

	it("removing a missing pin is a no-op", async () => {
		await removePin(dir, "acme", "main", "note", "nope");
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});

	it("tolerates a corrupt pins file by treating it as empty", async () => {
		await addPin(dir, "acme", "main", { kind: "plan", id: "p", title: "P", pinnedAt: 1 });
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(dir, ".jolli", "jollimemory", "pins.json"), "{ not json", "utf8");
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/core/PinStore.test.ts`
Expected: FAIL — module `./PinStore.js` not found.

- [ ] **Step 3: Implement `PinStore`**

Create `cli/src/core/PinStore.ts`, mirroring `CommitSelectionStore`'s per-project-file + atomic-write pattern:

```ts
/**
 * PinStore — per-branch "pinned" items for the Current Branch view.
 *
 * Persists to `<projectDir>/.jolli/jollimemory/pins.json`, grouped by
 * `<repoName>::<branchName>`. A pin is a lightweight reference to an existing
 * artifact (conversation / plan / note / committed memory) the user wants kept
 * at the top of the Current Branch view; the id reuses that artifact's stable
 * identifier (conversationKey / plan slug / note id / commit hash).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent, JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";

const log = createLogger("PinStore");
const PINS_FILE = "pins.json";
const PINS_VERSION = 1 as const;

export type PinKind = "conversation" | "plan" | "note" | "memory";

export interface PinEntry {
	readonly kind: PinKind;
	readonly id: string;
	readonly title: string;
	readonly pinnedAt: number;
}

interface PersistedShape {
	readonly version: typeof PINS_VERSION;
	readonly groups: Record<string, PinEntry[]>;
}

export function pinGroupKey(repoName: string, branchName: string): string {
	return `${repoName}::${branchName}`;
}

function pinsPath(projectDir: string): string {
	return join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, PINS_FILE);
}

async function readAll(projectDir: string): Promise<PersistedShape> {
	try {
		const raw = await readFile(pinsPath(projectDir), "utf8");
		const parsed = JSON.parse(raw) as PersistedShape;
		if (!parsed || typeof parsed !== "object" || typeof parsed.groups !== "object" || parsed.groups === null) {
			return { version: PINS_VERSION, groups: {} };
		}
		return { version: PINS_VERSION, groups: parsed.groups };
	} catch (err) {
		if (!isEnoent(err)) log.warn(`pins.json unreadable, treating as empty: ${errMsg(err)}`);
		return { version: PINS_VERSION, groups: {} };
	}
}

async function writeAll(projectDir: string, data: PersistedShape): Promise<void> {
	const path = pinsPath(projectDir);
	await mkdir(join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rename(tmp, path);
}

export async function listPins(projectDir: string, repoName: string, branchName: string): Promise<PinEntry[]> {
	const all = await readAll(projectDir);
	return all.groups[pinGroupKey(repoName, branchName)] ?? [];
}

export async function addPin(
	projectDir: string,
	repoName: string,
	branchName: string,
	entry: PinEntry,
): Promise<void> {
	const all = await readAll(projectDir);
	const key = pinGroupKey(repoName, branchName);
	const list = (all.groups[key] ?? []).filter((p) => !(p.kind === entry.kind && p.id === entry.id));
	list.push(entry);
	all.groups[key] = list;
	await writeAll(projectDir, all);
}

export async function removePin(
	projectDir: string,
	repoName: string,
	branchName: string,
	kind: PinKind,
	id: string,
): Promise<void> {
	const all = await readAll(projectDir);
	const key = pinGroupKey(repoName, branchName);
	const existing = all.groups[key];
	if (!existing) return;
	all.groups[key] = existing.filter((p) => !(p.kind === kind && p.id === id));
	await writeAll(projectDir, all);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/PinStore.test.ts`
Expected: PASS (all 7 cases). Confirm the file's coverage is ≥ the floor (the tests above exercise every branch incl. the corrupt-file path and the missing-remove no-op).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/PinStore.ts cli/src/core/PinStore.test.ts
git commit -s -m "feat(cli): add per-branch PinStore for the Current Branch view"
```

### Task B2: Pin message protocol + host wiring

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts` — add outbound `branch:pin` / `branch:unpin`, inbound `branch:pinsData`.
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` — handle `branch:pin` / `branch:unpin` (call `addPin`/`removePin`, then re-push), add a `pushPins()` that posts `branch:pinsData` for the active repo+branch; call it from init and after pin/unpin and on branch switch / refresh(branch).
- Test: `vscode/src/views/SidebarMessages.test.ts`, `vscode/src/views/SidebarWebviewProvider.test.ts`.

**Interfaces:**
- Consumes (Task B1): `addPin` / `removePin` / `listPins` / `PinEntry` / `PinKind` from `../../../cli/src/core/PinStore.js`.
- Produces:
  - Outbound: `{ type: "branch:pin"; kind: PinKind; id: string; title: string }`, `{ type: "branch:unpin"; kind: PinKind; id: string }`.
  - Inbound: `{ type: "branch:pinsData"; items: ReadonlyArray<PinEntry> }`.
  - Provider method `pushPins(): Promise<void>` posting `branch:pinsData` for the active repo+branch.

- [ ] **Step 1: Write the failing tests**

In `vscode/src/views/SidebarMessages.test.ts`:

```ts
it("admits branch:pin / branch:unpin outbound and branch:pinsData inbound", () => {
	const pin: SidebarOutboundMsg = { type: "branch:pin", kind: "memory", id: "h", title: "T" };
	const unpin: SidebarOutboundMsg = { type: "branch:unpin", kind: "memory", id: "h" };
	const data: SidebarInboundMsg = { type: "branch:pinsData", items: [] };
	expect(pin.type).toBe("branch:pin");
	expect(unpin.type).toBe("branch:unpin");
	expect(data.type).toBe("branch:pinsData");
});
```

Ensure the test imports `SidebarInboundMsg` alongside the existing type imports. In `vscode/src/views/SidebarWebviewProvider.test.ts`, add a case asserting that an incoming `branch:pin` message routes to `addPin` and triggers a `branch:pinsData` post (follow the file's existing harness for faking the bridge / capturing `postMessage`; mirror an existing handled-message test such as the refresh or toggle-selection case).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck -w vscode && npm run test:vscode -- src/views/SidebarMessages.test.ts`
Expected: FAIL — `branch:pin` not assignable; provider test fails (no handler).

- [ ] **Step 3: Add the message types**

In `vscode/src/views/SidebarMessages.ts`, import the pin types and add the union members:

```ts
import type { PinEntry, PinKind } from "../../../cli/src/core/PinStore.js";
```

Add to `SidebarOutboundMsg`:

```ts
	| { readonly type: "branch:pin"; readonly kind: PinKind; readonly id: string; readonly title: string }
	| { readonly type: "branch:unpin"; readonly kind: PinKind; readonly id: string }
```

Add to `SidebarInboundMsg`:

```ts
	| { readonly type: "branch:pinsData"; readonly items: ReadonlyArray<PinEntry> }
```

- [ ] **Step 4: Wire the host handler + push**

In `vscode/src/views/SidebarWebviewProvider.ts`: import `addPin`, `removePin`, `listPins` from `../../../cli/src/core/PinStore.js`; in the `onDidReceiveMessage` dispatch (the `handleOutbound` switch), handle `branch:pin` (call `addPin(projectDir, repo, branch, { ...msg, pinnedAt: Date.now() })` then `await this.pushPins()`) and `branch:unpin` (call `removePin(...)` then `pushPins()`). Add:

```ts
	private async pushPins(): Promise<void> {
		const repo = this.deps.getActiveRepoName();
		const branch = this.deps.getActiveBranchName();
		const items = await listPins(this.deps.projectDir, repo, branch);
		this.postMessage({ type: "branch:pinsData", items });
	}
```

Resolve `projectDir` / active repo+branch via the same accessors the provider already uses for the breadcrumb selection and the other per-project stores (follow how `handleRefresh` / `getInitialState` obtain repo+branch). Call `pushPins()` from the ready/init path, after each pin/unpin, on branch switch (`selection:set`), and from `handleRefresh` for the `branch` and `all` scopes.

(Implementer: match the provider's existing dependency-accessor names; if an accessor for projectDir / active repo / active branch does not already exist, reuse the one the breadcrumb + branchMemories code already uses — do not invent a new dependency shape.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck -w vscode && npm run test:vscode -- src/views/SidebarMessages.test.ts src/views/SidebarWebviewProvider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vscode/src/views/SidebarMessages.ts vscode/src/views/SidebarWebviewProvider.ts vscode/src/views/SidebarMessages.test.ts vscode/src/views/SidebarWebviewProvider.test.ts
git commit -s -m "feat(vscode): pin/unpin message protocol + host wiring"
```

### Task B3: Render the Pinned section + pin/unpin actions

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — store `pinsData`, render the `pinned` section, add pin/unpin to the row context menus + hover actions, handle `branch:pinsData`.
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — `.pinned-row` styling if needed.
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`.

**Interfaces:**
- Consumes (Task A1): the `pinned` placeholder section in `renderBranch`. (Task B2): inbound `branch:pinsData`; outbound `branch:pin` / `branch:unpin`.
- Produces: a populated Pinned section; `branch:pin` / `branch:unpin` posts from row actions.

- [ ] **Step 1: Write the failing tests**

Add to `vscode/src/views/SidebarScriptBuilder.test.ts`:

```ts
it("handles branch:pinsData and renders a Pinned section", () => {
	const js = buildSidebarScript();
	expect(js).toContain("'branch:pinsData'");
	expect(js).toContain("function renderPinned");
});

it("wires pin / unpin row actions", () => {
	const js = buildSidebarScript();
	expect(js).toContain("type: 'branch:pin'");
	expect(js).toContain("type: 'branch:unpin'");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: FAIL — `branch:pinsData` / `renderPinned` / `branch:pin` not present.

- [ ] **Step 3: Implement Pinned rendering + actions**

- Add a module-scope `let pinsData = [];` near the other branch data caches.
- Add a `branch:pinsData` case to the inbound message handler: store `msg.items` into `pinsData`, then if `state.activeTab === 'branch'` call `renderBranch()`.
- Add `function renderPinned()` returning the section body: for each pin in `pinsData`, render a row (icon by `kind`, label = `title`) wired to open its target (conversation → `branch:openConversation` is keyed by session — for pins use a generic open via the existing per-kind open messages: memory → `branch:openCommit` with `hash: id`; plan → `branch:openPlan` with `planId: id`; note → `branch:openNote` with `noteId: id`; conversation → reuse the conversation-open path) and an inline Unpin (✕) button posting `{ type: 'branch:unpin', kind, id }`.
- In `renderBranch`, replace the Pinned placeholder (Task A1) with the real Pinned section built from `renderPinned()` (render the section only when `pinsData.length > 0`, or always with an empty-state line — match the other sections' empty handling).
- Add a **Pin** item to the existing right-click context menu for conversation / plan / note / commit rows that posts `{ type: 'branch:pin', kind, id, title }` (derive `kind`/`id`/`title` from the row's dataset, mirroring how the menu already reads `data-*` for the other actions). Hide Pin/Unpin in foreign-readonly mode (consistent with the other foreign-suppressed actions).

(Implementer: realize against the test markers; reuse the existing context-menu infrastructure and row dataset conventions rather than adding a parallel mechanism.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: PASS (incl. the existing `new Function(...)` parse smoke test).

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts
git commit -s -m "feat(vscode): render Pinned section + pin/unpin row actions"
```

---

## Phase C — Detail panel redesign (①b)

### Task C1: Promote Conversations to a top-level section; remove the private drawer

**Files:**
- Modify: `vscode/src/views/SummaryHtmlBuilder.ts` — `buildHtml` body order (`:154-160`), the `buildPrivateDrawer` (`:468`) / `buildAllConversationsSection` functions.
- Modify: `vscode/src/views/SummaryCssBuilder.ts` — remove the `Private Zone` styles (`:94`+), add `.conversations-section` styling if needed.
- Test: `vscode/src/views/SummaryHtmlBuilder.test.ts`.

**Interfaces:**
- Consumes: existing `buildAllConversationsSection(transcriptHashSet, isForeign)` content (transcript rows + Open/View transcript action).
- Produces: a regular **Conversations** section in the main flow (no PRIVATE drawer wrapper), positioned above the Attachments/Context panel; the `private-drawer` / "PRIVATE" markup is gone.

- [ ] **Step 1: Write the failing tests**

In `vscode/src/views/SummaryHtmlBuilder.test.ts` (follow the file's existing `buildHtml(...)` invocation harness for the fixture summary):

```ts
it("renders a top-level Conversations section and no private drawer", () => {
	const html = buildHtml(/* existing fixture args used by neighboring tests */);
	expect(html).toContain("Conversations");
	// 1b: the demoted bottom 'All Conversations' PRIVATE drawer is gone.
	expect(html).not.toContain('id="privateDrawer"');
	expect(html).not.toContain("PRIVATE");
});
```

(Use the exact `buildHtml(...)` call the adjacent tests use — copy their fixture setup.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:vscode -- src/views/SummaryHtmlBuilder.test.ts`
Expected: FAIL — `id="privateDrawer"` / `PRIVATE` still present.

- [ ] **Step 3: Promote the section + drop the drawer**

- Rename/repurpose `buildPrivateDrawer` into a plain section builder (e.g. `buildConversationsSection(transcriptHashSet, isForeign)`) that returns the conversations list **without** the `private-drawer` / `private-head` / PRIVATE-badge / lock chrome — a normal `<div class="section conversations-section">` with a "Conversations" title, reusing `buildAllConversationsSection`'s row + Open-transcript content.
- In `buildHtml`, move the conversations section **above** `buildAttachmentsPanel` and drop the old bottom call. The body order becomes:

```
${buildHeader(...)}
${buildShipBar(summary)}
${buildMemoryPanel(summary, { readOnly })}
${buildE2ePanel(summary)}
${buildConversationsSection(transcriptHashSet, !!opts.foreignRepoName)}
${buildAttachmentsPanel(summary, sourceNodes, planTranslateSet, noteTranslateSet, referenceTranslateSet)}
${buildFooter(summary)}
```

- In `vscode/src/views/SummaryCssBuilder.ts`, remove the `Private Zone (All Conversations)` rule block (the `.private-drawer` / `.private-head` / `.private-badge` / `.private-lock` / `.private-title` / `.private-count` / `.private-body` selectors) and add minimal `.conversations-section` styling if the section needs it.

(Implementer: preserve the transcript Open/View action and the per-session rows; only the PRIVATE drawer chrome and its bottom placement go away. Keep the `data-foreign-safe` / foreign-readonly behavior the section already had.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:vscode -- src/views/SummaryHtmlBuilder.test.ts`
Expected: PASS. If other tests in the file asserted on the private drawer markup, update them to the new section (do not weaken them).

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SummaryHtmlBuilder.ts vscode/src/views/SummaryCssBuilder.ts vscode/src/views/SummaryHtmlBuilder.test.ts
git commit -s -m "feat(vscode): promote Conversations to a section, remove private drawer (1b)"
```

---

## Phase D — Gate + smoke

### Task D1: Full build/lint/test gate + manual smoke

**Files:** none up front (verification + any test fixups).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: PASS across cli + vscode. The CLI suite may show the PRE-EXISTING, unrelated `safe.bareRepository` / worktree-isolation failure documented in project memory — that is not caused by this PR; to get a clean CLI run prefix with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npm run all`. Confirm `PinStore.ts` keeps cli coverage above the floor. Update (don't weaken) any test that asserted the old branch section titles ("CONVERSATIONS" / "Plans & Notes" / "Changes" / "Memories") or the private drawer.

- [ ] **Step 2: Manual smoke (best-effort)**

```bash
cd vscode && npm run deploy
```
Reload Window. Verify: the Current Branch view shows **Pinned**, a **Current Memory** group (Conversations / Context / Files with working include checkboxes), and **Committed Memories** (with squash selection). Right-click a conversation / plan / memory → **Pin**; it appears in Pinned; the ✕ unpins it; pins persist across reload and are scoped to the branch. Open a committed memory → the detail panel shows a **Conversations** section (Show opens the transcript) and **no** bottom "All Conversations / PRIVATE" drawer. If the GUI can't be driven here, say so and rely on the gate + a static check of the generated strings.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -s -m "test(vscode): align Current Branch + detail-panel tests with the redesign"
```
(If the gate was clean with no fixups, make no commit and say so.)

---

## Self-Review

**1. Spec coverage:** §2 Current Branch regroup → Task A1. §3 Pinned (PinStore / actions / messages / rendering) → Tasks B1, B2, B3. §4 detail-panel redesign + ①b → Task C1. §6 testing (string-assertion pattern, PinStore unit tests + coverage) → embedded in each task + Task D1. ② reuse / ①a / ①c non-tasks → noted in the plan header and not implemented (correct). Share frozen → Global Constraints + no task touches it. No spec requirement is unaddressed.

**2. Placeholder scan:** No `TBD`/`TODO`. The UI-rendering tasks (A1, B3, C1) specify the exact test-contract markers + the structural approach + real-code anchors rather than full verbatim DOM — appropriate for webview builders whose tests assert on generated strings; each names the concrete markers the implementer must produce. `PinStore` (B1) and the message types (B2) carry complete verbatim code.

**3. Type consistency:** `PinKind` / `PinEntry` / `pinGroupKey` / `listPins` / `addPin` / `removePin` are defined in B1 and consumed by B2 (message types) and the provider under the same names. The message types `branch:pin` / `branch:unpin` / `branch:pinsData` defined in B2 are consumed by B3 under the same strings. Section ids (`conversations` / `plans` / `changes` / `commits` / `pinned`) are consistent between A1 and B3. The detail-panel `buildConversationsSection` introduced in C1 replaces `buildPrivateDrawer` consistently in `buildHtml`.
