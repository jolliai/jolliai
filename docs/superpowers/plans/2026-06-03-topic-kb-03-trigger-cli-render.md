# Topic KB Sub-project 3 — Trigger, CLI & Wiki Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Cut the auto-trigger over from per-branch compile+merge to a single repo-wide topic-KB ingest, reshape `jolli compile` to ingest/`--rebuild`, and render the visible `_wiki/` from topic pages on folder-capable storage.

**Architecture:** A new `IngestOperation` queue op (debounced per-cwd via `IngestTrigger`) drains the SP2 pipeline and rebuilds the wiki. Render is exposed as an optional `StorageProvider.renderTopicWiki?` so DualWrite delegates to FolderStorage and orphan-only is a no-op. Old branch-compile code stays present but unreferenced (removed in SP5).

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome (tabs, 120 col, `noExplicitAny: error`). CLI floor: 97/96/97/97.

**Spec:** [SP3](../specs/2026-06-03-topic-kb-03-trigger-cli-render-design.md) · **Builds on** SP1 + SP2 (`drainIngest`, `TopicPageStore`, `ProcessedSourceStore`, `TopicIndexStore`, `TopicKBTypes`).

---

## Verified facts (from investigation)

- `GitOperation = CommitGitOperation | CompileOperation | CompileMergeOperation` (Types.ts:149). `CompileMergeOperation` (Types.ts:202) is the closest shape to mirror: `{ type, triggeredBy, createdAt }`. Guards at Types.ts:209-216.
- `enqueueGitOperation(op, cwd?)` from `./SessionTracker.js` writes a queue file; returns boolean.
- `MergeTrigger.ts` is the cooldown template: `COOLDOWN_FILE`, `COOLDOWN_MS`, `isMergeWithinCooldown`, `markMergeTouched`, `enqueueCompileMergeOperation`, private `readCooldownState` + `atomicWriteFile`. Reuse verbatim shape.
- `QueueWorker.processQueueEntry(op, cwd, storage, force)` (QueueWorker.ts:436) routes `isCompileOperation`→`runCompileFromQueue` (L445), `isCompileMergeOperation`→`runCompileMergeFromQueue` (L454) as top-level `if`s before the commit `switch`. `runCompileFromQueue` (L530) fans out a merge at ~L549 via `enqueueCompileMergeOperation(cwd, "post-compile")` — REMOVE that fan-out is N/A (we add a new op, don't touch the old handler; the old handler just won't be enqueued anymore).
- `PostMergeHook.handlePostMerge` (PostMergeHook.ts:57) loops merged branches calling `enqueueCompileOperation(branch, "post-merge", cwd)` (~L90-92), then `launchWorker(cwd)` (L102).
- `ContextCompiler.ts:401` calls `triggerBackgroundCompile(branch, cwd, "recall-miss")` on cache miss.
- `BackgroundCompileTrigger.triggerBackgroundCompile(branch, cwd, reason)` (BackgroundCompileTrigger.ts:81) → `realDispatchCompile` (L135) → `enqueueCompileOperation` (L140) + `launchWorker` (L145), per-(cwd,branch) 5-min cooldown.
- `FolderStorage.generateWikiPages(mergedJson)` (FolderStorage.ts:1021): `wipeWikiArtifacts(wikiDir)` (L1091) → `buildWikiRenderContext()` (L1117) → `mkdirSync` → per topic `renderTopic(topic, merged, ctx)` + `atomicWrite(_wiki/topic--<slug>.md)` + `metadataManager.updateManifest({type:"wiki", fileId:"wiki-topic-<slug>", ...})` → `renderIndex(merged, ctx)` → `_wiki/_index.md`. `wikiDir = join(this.rootPath, "_wiki")`.
- `renderTopic(topic: CompiledTopic, merged: MergedKnowledge, ctx: WikiRenderContext): string` (WikiMarkdownBuilder.ts:53) uses only `merged.branches` + `merged.mergedAt` of `merged`. `renderIndex(merged, ctx)` also exists.
- `WikiRenderContext` (WikiMarkdownBuilder.ts:28): `{ repoName; resolveCommitVisiblePath; resolveBranchFolder; resolveCommitMessage }`.
- `StorageProvider` (StorageProvider.ts) has optional methods (`statFile?`, `deleteVisibleMarkdown?`, …) — add `renderTopicWiki?` the same way. `FolderStorage.writeFiles` triggers `generateWikiPages` when path matches `compiled/merged/*.json`.
- `CompileCommand.registerCompileCommand(program)` (CompileCommand.ts:46): `.command("compile").argument("[branches...]").option("--merge").option("--all").option("--force").option("--cwd <dir>", …, resolveProjectDir()).action(async (branches, options) => …)`. `loadConfig()` from `./SessionTracker.js`, `createStorage(cwd, cwd)` + `setActiveStorage` pattern at L85.
- `CompiledTopic` = `{ title; stableSlug; content; keyDecisions?; relatedBranches?; sourceCommits: string[] }`. `TopicPage` (SP1) = `{ schemaVersion; stableSlug; title; content; relatedBranches; sourceRefs; lastUpdatedAt }`.
- `drainIngest(cwd, config, opts?): Promise<{ batches; ingested }>` and `ingestPendingBatch` from `./IngestPipeline.js` (SP2). `listTopicPageSlugs`/`readTopicPage`/`saveTopicPage` from `./TopicPageStore.js`; `emptyProcessedSet`/`saveProcessedSet` from `./ProcessedSourceStore.js`; `emptyTopicIndex`/`saveTopicIndex` from `./TopicIndexStore.js`.

---

## File structure

| File | Change |
|---|---|
| `cli/src/Types.ts` | + `IngestOperation`, `isIngestOperation`, extend `GitOperation` |
| `cli/src/core/IngestTrigger.ts` | new — cooldown + `enqueueIngestOperation` |
| `cli/src/core/WikiMarkdownBuilder.ts` | + `renderTopicImpl` core, `renderTopic` becomes wrapper, + `topicPageToCompiledTopic` |
| `cli/src/core/StorageProvider.ts` | + optional `renderTopicWiki?` |
| `cli/src/core/FolderStorage.ts` | + public `renderTopicWiki`; refactor `generateWikiPages` to share a render helper |
| `cli/src/core/DualWriteStorage.ts` | + delegate `renderTopicWiki` |
| `cli/src/core/TopicWikiRenderer.ts` | new — `renderTopicKBWiki(cwd, storage)` reads index-named pages + calls `storage.renderTopicWiki?` |
| `cli/src/hooks/QueueWorker.ts` | + dispatch `isIngestOperation` → `runIngestFromQueue` |
| `cli/src/hooks/PostMergeHook.ts` | replace per-branch compile enqueue with one ingest enqueue |
| `cli/src/core/BackgroundCompileTrigger.ts` | repoint recall-miss to enqueue ingest |
| `cli/src/commands/CompileCommand.ts` | reshape to `compile` + `--rebuild` |

---

## Task 1: IngestOperation type + guard

**Files:** Modify `cli/src/Types.ts`

- [ ] **Step 1: Add the interface + guard, extend the union**

After the `CompileMergeOperation` block (Types.ts ~L206) add:

```typescript
/**
 * Topic-KB ingest request (SP3). Repo-wide — no branch field, because the
 * topic KB is not organized by branch. One queued entry drains all pending
 * sources via `drainIngest`. `triggeredBy` is telemetry only.
 */
export interface IngestOperation {
	readonly type: "ingest";
	readonly triggeredBy: "post-merge" | "recall-miss" | "manual";
	readonly createdAt: string; // ISO 8601
}
```

Extend the union (Types.ts:149):

```typescript
export type GitOperation = CommitGitOperation | CompileOperation | CompileMergeOperation | IngestOperation;
```

Add the guard beside the others (~L216):

```typescript
/** Narrows a {@link GitOperation} to an {@link IngestOperation}. */
export function isIngestOperation(op: GitOperation): op is IngestOperation {
	return op.type === "ingest";
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:cli`
Expected: PASS (new union member; existing switches that don't handle "ingest" still compile because they branch on guards/`op.type` strings, not exhaustive unions — verify no `never`-exhaustiveness error surfaces; if one does, it points to a switch that must add an ignore/handle for "ingest" — note it).

- [ ] **Step 3: Commit**

```bash
git add cli/src/Types.ts
git commit -s -m "feat(topic-kb): add IngestOperation queue type"
```

---

## Task 2: IngestTrigger (cooldown + enqueue)

**Files:** Create `cli/src/core/IngestTrigger.ts`, Test `cli/src/core/IngestTrigger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./SessionTracker.js", () => ({ enqueueGitOperation: vi.fn(async () => true) }));

import { enqueueGitOperation } from "./SessionTracker.js";
import { enqueueIngestOperation, isIngestWithinCooldown, markIngestTouched } from "./IngestTrigger.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ingest-trigger-"));
	vi.mocked(enqueueGitOperation).mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("IngestTrigger", () => {
	it("enqueues an ingest op when not in cooldown", async () => {
		const ok = await enqueueIngestOperation(dir, "post-merge");
		expect(ok).toBe(true);
		const op = vi.mocked(enqueueGitOperation).mock.calls[0]?.[0];
		expect(op).toMatchObject({ type: "ingest", triggeredBy: "post-merge" });
	});

	it("skips a second enqueue within the cooldown window", async () => {
		await enqueueIngestOperation(dir, "post-merge");
		vi.mocked(enqueueGitOperation).mockClear();
		const ok = await enqueueIngestOperation(dir, "recall-miss");
		expect(ok).toBe(false);
		expect(vi.mocked(enqueueGitOperation)).not.toHaveBeenCalled();
	});

	it("force bypasses the cooldown", async () => {
		await enqueueIngestOperation(dir, "post-merge");
		vi.mocked(enqueueGitOperation).mockClear();
		const ok = await enqueueIngestOperation(dir, "manual", { force: true });
		expect(ok).toBe(true);
	});

	it("markIngestTouched then isIngestWithinCooldown is true; far-future now is false", async () => {
		await markIngestTouched(dir);
		expect(await isIngestWithinCooldown(dir)).toBe(true);
		expect(await isIngestWithinCooldown(dir, Date.now() + 60 * 60 * 1000)).toBe(false);
	});
});
```

- [ ] **Step 2: Run — expect FAIL** (`cannot resolve ./IngestTrigger.js`)

Run: `npm run test -w @jolli.ai/cli -- src/core/IngestTrigger.test.ts`

- [ ] **Step 3: Implement** (mirror `MergeTrigger.ts` exactly, per-cwd, 5-min)

```typescript
/**
 * IngestTrigger — enqueues a repo-wide topic-KB ingest, debounced by a per-cwd
 * cooldown so a burst of merges/recalls collapses to one drain. Mirrors
 * MergeTrigger (cwd-level, not per-branch). State: `ingest-cooldown.json`.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import type { IngestOperation } from "../Types.js";
import { enqueueGitOperation } from "./SessionTracker.js";

const log = createLogger("IngestTrigger");

const COOLDOWN_FILE = "ingest-cooldown.json";
/** 5-minute per-cwd debounce; tune after dogfooding. */
const COOLDOWN_MS = 5 * 60 * 1000;

interface IngestCooldownState {
	readonly lastIngestedAt?: string; // ISO 8601
}

export async function isIngestWithinCooldown(cwd: string, now: number = Date.now()): Promise<boolean> {
	const state = await readCooldownState(cwd);
	if (!state.lastIngestedAt) return false;
	const lastMs = new Date(state.lastIngestedAt).getTime();
	if (Number.isNaN(lastMs)) return false;
	return now - lastMs < COOLDOWN_MS;
}

export async function markIngestTouched(cwd: string, now: number = Date.now()): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	const next: IngestCooldownState = { lastIngestedAt: new Date(now).toISOString() };
	await atomicWriteFile(join(dir, COOLDOWN_FILE), JSON.stringify(next, null, "\t"));
}

/**
 * Enqueues an {@link IngestOperation} unless within cooldown. Cooldown is
 * marked before enqueue so concurrent callers race to one entry. `force`
 * bypasses the cooldown.
 */
export async function enqueueIngestOperation(
	cwd: string,
	triggeredBy: IngestOperation["triggeredBy"],
	options?: { readonly force?: boolean },
): Promise<boolean> {
	try {
		if (!options?.force && (await isIngestWithinCooldown(cwd))) {
			log.debug("Ingest enqueue skipped (%s): within cooldown", triggeredBy);
			return false;
		}
		await markIngestTouched(cwd);
		const op: IngestOperation = { type: "ingest", triggeredBy, createdAt: new Date().toISOString() };
		return await enqueueGitOperation(op, cwd);
	} catch (err: unknown) {
		log.debug("Ingest enqueue failed (%s): %s", triggeredBy, (err as Error).message);
		return false;
	}
}

async function readCooldownState(cwd: string): Promise<IngestCooldownState> {
	try {
		const raw = await readFile(join(getJolliMemoryDir(cwd), COOLDOWN_FILE), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as IngestCooldownState;
		}
		return {};
	} catch {
		return {};
	}
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, content, "utf-8");
	try {
		await rename(tmp, filePath);
		/* v8 ignore start -- Windows EPERM/EACCES rename fallback (same as MergeTrigger). */
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") {
			await writeFile(filePath, content, "utf-8");
			await rm(tmp, { force: true });
		} else {
			throw err;
		}
	}
	/* v8 ignore stop */
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run test -w @jolli.ai/cli -- src/core/IngestTrigger.test.ts`

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/IngestTrigger.ts cli/src/core/IngestTrigger.test.ts
git commit -s -m "feat(topic-kb): add per-cwd ingest trigger with cooldown"
```

---

## Task 3: WikiMarkdownBuilder — shape-agnostic render core

**Files:** Modify `cli/src/core/WikiMarkdownBuilder.ts`, Test `cli/src/core/WikiMarkdownBuilder.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import type { CompiledTopic, MergedKnowledge } from "../Types.js";
import type { TopicPage } from "./TopicKBTypes.js";
import { renderTopic, renderTopicImpl, topicPageToCompiledTopic } from "./WikiMarkdownBuilder.js";

const ctx = {
	repoName: "Repo",
	resolveCommitVisiblePath: () => null,
	resolveBranchFolder: () => null,
	resolveCommitMessage: () => null,
};
const topic: CompiledTopic = {
	title: "Auth",
	stableSlug: "auth",
	content: "Body about auth.",
	sourceCommits: [],
};

describe("renderTopicImpl", () => {
	it("produces the same output as the legacy renderTopic wrapper", () => {
		const merged = { branches: ["main"], mergedAt: "2026-01-01T00:00:00Z", topics: [topic] } as MergedKnowledge;
		const viaWrapper = renderTopic(topic, merged, ctx);
		const viaImpl = renderTopicImpl(topic, ["main"], "2026-01-01T00:00:00Z", ctx);
		expect(viaImpl).toBe(viaWrapper);
	});
});

describe("topicPageToCompiledTopic", () => {
	it("maps page fields and keeps only commit-type source ids", () => {
		const page: TopicPage = {
			schemaVersion: 1,
			stableSlug: "auth",
			title: "Auth",
			content: "Body.",
			relatedBranches: ["main"],
			sourceRefs: [
				{ type: "summary", id: "abc123", timestamp: "2026-01-01T00:00:00Z" },
				{ type: "plan", id: "p1", timestamp: "2026-01-01T00:00:00Z" },
			],
			lastUpdatedAt: "2026-01-02T00:00:00Z",
		};
		const t = topicPageToCompiledTopic(page);
		expect(t.stableSlug).toBe("auth");
		expect(t.content).toBe("Body.");
		expect(t.relatedBranches).toEqual(["main"]);
		expect(t.sourceCommits).toEqual(["abc123"]); // only summary-type refs are commits
	});
});
```

- [ ] **Step 2: Run — expect FAIL** (`renderTopicImpl`/`topicPageToCompiledTopic` not exported)

- [ ] **Step 3: Implement**

In `WikiMarkdownBuilder.ts`, change `renderTopic` to delegate, and add the impl + adapter. Read the current `renderTopic` body (WikiMarkdownBuilder.ts:53-113) and move it into `renderTopicImpl`, replacing the two `merged.` reads with the new params:

```typescript
import type { TopicPage } from "./TopicKBTypes.js";
// ... existing imports ...

/** Legacy wrapper — branch-merge path (removed in SP5). Delegates to the
 *  shape-agnostic core. */
export function renderTopic(topic: CompiledTopic, merged: MergedKnowledge, ctx: WikiRenderContext): string {
	return renderTopicImpl(topic, merged.branches, merged.mergedAt, ctx);
}

/** Shape-agnostic topic render: takes branches + lastUpdatedAt directly instead
 *  of a MergedKnowledge container, so topic-KB pages can render without one. */
export function renderTopicImpl(
	topic: CompiledTopic,
	branches: ReadonlyArray<string>,
	lastUpdatedAt: string,
	ctx: WikiRenderContext,
): string {
	// <BODY: the exact current renderTopic body, with `merged.branches` → `branches`
	//  and `merged.mergedAt` → `lastUpdatedAt`. Everything else unchanged.>
}

/** Adapts a topic-KB page to the CompiledTopic shape the renderer expects.
 *  Only summary-type sourceRefs are commit hashes. */
export function topicPageToCompiledTopic(page: TopicPage): CompiledTopic {
	return {
		title: page.title,
		stableSlug: page.stableSlug,
		content: page.content,
		...(page.relatedBranches.length > 0 && { relatedBranches: [...page.relatedBranches] }),
		sourceCommits: page.sourceRefs.filter((r) => r.type === "summary").map((r) => r.id),
	};
}
```

> The implementer must move the *actual* current `renderTopic` body into `renderTopicImpl` verbatim (only the two field reads change). The golden test in Step 1 guarantees byte-identical output.

- [ ] **Step 4: Run — expect PASS** (`npm run test -w @jolli.ai/cli -- src/core/WikiMarkdownBuilder.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/WikiMarkdownBuilder.ts cli/src/core/WikiMarkdownBuilder.test.ts
git commit -s -m "refactor(topic-kb): extract shape-agnostic renderTopicImpl + page adapter"
```

---

## Task 4: (removed — no page deletion needed)

**Decision:** `--rebuild` does NOT delete topic page files, and there is no general
deletion primitive on `StorageProvider` (only markdown-specific `deleteVisibleMarkdown`
etc.). Instead:

- Render (Task 6) and recall (SP4) read the topic list from the **authoritative
  `index.json`**, not from `listTopicPageSlugs`. An orphaned `topics/<slug>.json`
  whose slug is not in the index is simply never read — harmless.
- `--rebuild` (Task 9) resets `processed.json` + `index.json` to empty. With an
  empty index, the route step proposes every topic as **new**, so reconcile gets
  `current = null` (clean rebuild) and `saveTopicPage` overwrites any same-slug
  file. Truly-orphaned old files linger inertly and are excluded by index-driven
  reads.

No `deleteAllTopicPages`, no new `StorageProvider` method. Skip to Task 5.

---

## Task 5: StorageProvider.renderTopicWiki + FolderStorage impl + DualWrite delegate

**Files:** Modify `StorageProvider.ts`, `FolderStorage.ts`, `DualWriteStorage.ts`; Test via `FolderStorage.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `cli/src/core/FolderStorage.test.ts`; follow the existing FolderStorage test setup — a temp rootPath + MetadataManager)

```typescript
it("renderTopicWiki writes topic--<slug>.md + _index.md and wipes stale pages", async () => {
	// Arrange: a FolderStorage over a temp dir with a prior stale wiki page.
	// (Reuse this test file's existing helper that builds a FolderStorage.)
	const fs = makeFolderStorage(); // existing helper in this file
	mkdirSync(join(fs.rootPathForTest(), "_wiki"), { recursive: true });
	writeFileSync(join(fs.rootPathForTest(), "_wiki", "topic--stale.md"), "old");

	const page: TopicPage = {
		schemaVersion: 1, stableSlug: "auth", title: "Auth", content: "Body.",
		relatedBranches: ["main"], sourceRefs: [], lastUpdatedAt: "2026-01-01T00:00:00Z",
	};
	await fs.renderTopicWiki([page]);

	expect(existsSync(join(fs.rootPathForTest(), "_wiki", "topic--auth.md"))).toBe(true);
	expect(existsSync(join(fs.rootPathForTest(), "_wiki", "_index.md"))).toBe(true);
	expect(existsSync(join(fs.rootPathForTest(), "_wiki", "topic--stale.md"))).toBe(false); // wiped
});
```

> If `FolderStorage.test.ts` does not exist or lacks a builder helper, create the minimal temp-dir FolderStorage setup mirroring how other FolderStorage tests construct it (rootPath + `new MetadataManager(join(root, ".jolli"))`). Expose `rootPathForTest()` is illustrative — use the real constructor arg the test already has.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

**StorageProvider.ts** — add beside the other optional methods:

```typescript
	/**
	 * Renders the visible `_wiki/` layer from topic-KB pages (SP3). Folder-backed
	 * providers implement it; orphan-only leaves it undefined (render no-op).
	 */
	renderTopicWiki?(pages: ReadonlyArray<TopicPage>): Promise<void>;
```

(import `TopicPage` type at top of StorageProvider.ts.)

**FolderStorage.ts** — refactor `generateWikiPages` to share a core that renders an array of `{topic, branches, lastUpdatedAt}` rows, then add the public method. Add:

```typescript
/** SP3 — render the visible wiki from topic-KB pages. Full rebuild (wipe + rewrite),
 *  same disk/manifest contract as generateWikiPages. */
async renderTopicWiki(pages: ReadonlyArray<TopicPage>): Promise<void> {
	const wikiDir = join(this.rootPath, "_wiki");
	this.wipeWikiArtifacts(wikiDir);
	const ctx = this.buildWikiRenderContext();
	mkdirSync(wikiDir, { recursive: true });
	const compiled: CompiledTopic[] = [];
	for (const page of pages) {
		try {
			const topic = topicPageToCompiledTopic(page);
			compiled.push(topic);
			const relPath = `_wiki/topic--${topic.stableSlug}.md`;
			const md = renderTopicImpl(topic, page.relatedBranches, page.lastUpdatedAt, ctx);
			this.atomicWrite(join(this.rootPath, relPath), md);
			this.metadataManager.updateManifest({
				path: relPath,
				fileId: `wiki-topic-${topic.stableSlug}`,
				type: "wiki",
				fingerprint: MetadataManager.sha256(md),
				source: { generatedAt: page.lastUpdatedAt },
				title: topic.title,
			});
		} catch (e) {
			log.warn("renderTopicWiki: failed to render topic %s: %s", page.stableSlug, errMsg(e));
		}
	}
	// Index page: synthesize a minimal MergedKnowledge for renderIndex, or add a
	// renderIndexImpl(topics, repoName, ctx). Prefer a small renderIndexImpl in
	// WikiMarkdownBuilder mirroring renderIndex but taking topics + branches list.
	try {
		const indexMd = renderTopicKBIndex(compiled, ctx); // new helper in WikiMarkdownBuilder
		const indexRel = "_wiki/_index.md";
		this.atomicWrite(join(this.rootPath, indexRel), indexMd);
		this.metadataManager.updateManifest({
			path: indexRel, fileId: "wiki-index", type: "wiki",
			fingerprint: MetadataManager.sha256(indexMd),
			source: { generatedAt: new Date().toISOString() },
			title: `${ctx.repoName} Knowledge Wiki`,
		});
	} catch (e) {
		log.warn("renderTopicWiki: failed to render index: %s", errMsg(e));
	}
	log.info("Topic-KB wiki regenerated: %d topics under %s", pages.length, wikiDir);
}
```

Add `renderTopicKBIndex(topics, ctx)` to `WikiMarkdownBuilder.ts` by extracting `renderIndex`'s body to not require `MergedKnowledge` (mirror the renderTopicImpl refactor). If `renderIndex` only needs the topic list + repoName, this is a thin extraction.

**DualWriteStorage.ts** — delegate (follow how it delegates other optional methods like `deleteVisibleMarkdown`):

```typescript
async renderTopicWiki(pages: ReadonlyArray<TopicPage>): Promise<void> {
	await this.folder.renderTopicWiki?.(pages);
}
```

(Use the actual inner-FolderStorage field name DualWriteStorage already uses.)

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/StorageProvider.ts cli/src/core/FolderStorage.ts cli/src/core/DualWriteStorage.ts cli/src/core/WikiMarkdownBuilder.ts cli/src/core/FolderStorage.test.ts
git commit -s -m "feat(topic-kb): render visible wiki from topic pages via storage provider"
```

---

## Task 6: TopicWikiRenderer — read pages + drive the provider

**Files:** Create `cli/src/core/TopicWikiRenderer.ts`, Test `cli/src/core/TopicWikiRenderer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("./TopicIndexStore.js", () => ({ readTopicIndex: vi.fn() }));
vi.mock("./TopicPageStore.js", () => ({ readTopicPage: vi.fn() }));

import { readTopicIndex } from "./TopicIndexStore.js";
import { readTopicPage } from "./TopicPageStore.js";
import { renderTopicKBWiki } from "./TopicWikiRenderer.js";
import type { StorageProvider } from "./StorageProvider.js";

const page = (slug: string) => ({ schemaVersion: 1 as const, stableSlug: slug, title: slug, content: "b", relatedBranches: [], sourceRefs: [], lastUpdatedAt: "2026-01-01T00:00:00Z" });
const idxEntry = (slug: string) => ({ stableSlug: slug, title: slug, summary: "s", relatedBranches: [], sourceRefs: [], lastUpdatedAt: "2026-01-01T00:00:00Z" });

describe("renderTopicKBWiki", () => {
	it("reads pages named by the authoritative index and calls storage.renderTopicWiki", async () => {
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [idxEntry("auth"), idxEntry("storage")] });
		vi.mocked(readTopicPage).mockImplementation(async (slug) => page(slug));
		const renderTopicWiki = vi.fn(async () => {});
		const storage = { renderTopicWiki } as unknown as StorageProvider;
		await renderTopicKBWiki("/tmp/x", storage);
		expect(renderTopicWiki).toHaveBeenCalledTimes(1);
		expect(renderTopicWiki.mock.calls[0][0].map((p: { stableSlug: string }) => p.stableSlug)).toEqual(["auth", "storage"]);
	});

	it("skips index entries whose page file is missing", async () => {
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [idxEntry("auth"), idxEntry("gone")] });
		vi.mocked(readTopicPage).mockImplementation(async (slug) => (slug === "gone" ? null : page(slug)));
		const renderTopicWiki = vi.fn(async () => {});
		await renderTopicKBWiki("/tmp/x", { renderTopicWiki } as unknown as StorageProvider);
		expect(renderTopicWiki.mock.calls[0][0].map((p: { stableSlug: string }) => p.stableSlug)).toEqual(["auth"]);
	});

	it("no-ops when the provider has no renderTopicWiki (orphan-only)", async () => {
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [idxEntry("auth")] });
		const storage = {} as StorageProvider; // no renderTopicWiki
		await expect(renderTopicKBWiki("/tmp/x", storage)).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
/**
 * TopicWikiRenderer — reads all topic pages and asks the active StorageProvider
 * to render the visible `_wiki/`. No-op on orphan-only storage (no
 * renderTopicWiki). Called after drainIngest (queue worker + `jolli compile`).
 */

import { createLogger } from "../Logger.js";
import type { StorageProvider } from "./StorageProvider.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import { readTopicPage } from "./TopicPageStore.js";
import type { TopicPage } from "./TopicKBTypes.js";

const log = createLogger("TopicWikiRenderer");

/**
 * Renders the visible wiki from the topic pages named by the authoritative
 * index (NOT a directory scan), so orphaned `topics/<slug>.json` files left by
 * a slug change or `--rebuild` are excluded. No-op on orphan-only storage.
 */
export async function renderTopicKBWiki(cwd: string, storage: StorageProvider): Promise<void> {
	if (!storage.renderTopicWiki) {
		log.debug("Active storage has no renderTopicWiki — skipping visible wiki render");
		return;
	}
	const index = await readTopicIndex(cwd, storage);
	const pages: TopicPage[] = [];
	for (const entry of index.topics) {
		const page = await readTopicPage(entry.stableSlug, cwd, storage);
		if (page) pages.push(page);
	}
	await storage.renderTopicWiki(pages);
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/TopicWikiRenderer.ts cli/src/core/TopicWikiRenderer.test.ts
git commit -s -m "feat(topic-kb): add topic-KB wiki render driver"
```

---

## Task 7: QueueWorker — dispatch ingest

**Files:** Modify `cli/src/hooks/QueueWorker.ts`, Test `cli/src/hooks/QueueWorker.test.ts` (append)

- [ ] **Step 1: Write the failing test** (mock the pipeline + renderer; assert an `ingest` op drains)

```typescript
// In QueueWorker.test.ts, add a test that feeds a queue entry { type:"ingest", ... }
// and asserts runIngestFromQueue path calls drainIngest. Follow the file's existing
// pattern for invoking the worker on a synthetic queue entry. Mock:
//   vi.mock("../core/IngestPipeline.js", () => ({ drainIngest: vi.fn(async () => ({ batches: 1, ingested: 2 })) }));
//   vi.mock("../core/TopicWikiRenderer.js", () => ({ renderTopicKBWiki: vi.fn(async () => {}) }));
// Assert drainIngest + renderTopicKBWiki were called once for an ingest entry.
```

> Match the existing QueueWorker.test.ts harness for enqueuing a synthetic entry and draining. The assertion: ingest op → `drainIngest` called, `renderTopicKBWiki` called.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

In `QueueWorker.ts`, import the guard + handlers, and add a dispatch branch in `processQueueEntry` beside the compile ones (~L454):

```typescript
import { isIngestOperation } from "../Types.js";
// ...
	if (isIngestOperation(op)) {
		log.info("Processing queue entry: type=ingest triggeredBy=%s", op.triggeredBy);
		await runIngestFromQueue(op, cwd);
		return;
	}
```

Add the handler (mirror `runCompileFromQueue`'s config-load + silent-skip, ~L530):

```typescript
async function runIngestFromQueue(op: IngestOperation, cwd: string): Promise<void> {
	const { drainIngest } = await import("../core/IngestPipeline.js");
	const { renderTopicKBWiki } = await import("../core/TopicWikiRenderer.js");
	const llmConfig = await loadConfig();
	if (!llmConfig.apiKey && !llmConfig.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
		log.info("No API key configured — skipping ingest (%s)", op.triggeredBy);
		return;
	}
	const result = await drainIngest(cwd, llmConfig);
	log.info("Ingest drained: %d batches, %d sources (%s)", result.batches, result.ingested, op.triggeredBy);
	if (result.ingested > 0) {
		const storage = getActiveStorageForCwd(cwd); // use the worker's existing storage handle (processQueueEntry receives `storage`)
		await renderTopicKBWiki(cwd, storage);
	}
}
```

> The worker already has a `storage: StorageProvider` in `processQueueEntry`. Thread it into `runIngestFromQueue(op, cwd, storage)` rather than re-resolving. Match the existing import style (`loadConfig`, lazy `import()`).

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts
git commit -s -m "feat(topic-kb): drain ingest + render wiki from the queue worker"
```

---

## Task 8: Repoint triggers (PostMergeHook + recall-miss)

**Files:** Modify `cli/src/hooks/PostMergeHook.ts`, `cli/src/core/BackgroundCompileTrigger.ts`; Tests alongside.

- [ ] **Step 1: Write the failing tests**

PostMergeHook test: a merge with N merged branches enqueues exactly ONE ingest op (not N compile ops). Mock `enqueueIngestOperation` + the old `enqueueCompileOperation`; assert ingest called once, compile not called. Follow the existing PostMergeHook.test.ts harness.

BackgroundCompileTrigger test: `triggerBackgroundCompile(... "recall-miss")` enqueues an ingest op (assert via mocked `enqueueIngestOperation`). Follow existing BackgroundCompileTrigger.test.ts.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

**PostMergeHook.ts** (~L90-92): replace the per-branch loop body:

```typescript
// was: for (const branch of mergedBranches) await enqueueCompileOperation(branch, "post-merge", cwd);
import { enqueueIngestOperation } from "../core/IngestTrigger.js";
// ...
if (mergedBranches.length > 0) {
	await enqueueIngestOperation(cwd, "post-merge");
}
```

(Keep the merged-branch detection that gates whether to enqueue at all; just collapse N enqueues to one.)

**BackgroundCompileTrigger.ts** — repoint the dispatch body (`realDispatchCompile`, ~L135-146) to enqueue ingest instead of compile, keeping the `triggerBackgroundCompile(branch, cwd, reason)` signature stable so `ContextCompiler.ts:401` is untouched:

```typescript
// inside realDispatchCompile, replace:
//   enqueued = await enqueueCompileOperation(branch, reason, cwd);
import { enqueueIngestOperation } from "./IngestTrigger.js";
// ...
const enqueued = await enqueueIngestOperation(cwd, reason === "recall-miss" ? "recall-miss" : "post-merge");
```

> The per-(cwd,branch) cooldown inside BackgroundCompileTrigger now double-debounces with IngestTrigger's per-cwd cooldown — harmless (both just suppress redundant enqueues). Note for SP5 cleanup: BackgroundCompileTrigger's branch arg is now vestigial.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cli/src/hooks/PostMergeHook.ts cli/src/hooks/PostMergeHook.test.ts cli/src/core/BackgroundCompileTrigger.ts cli/src/core/BackgroundCompileTrigger.test.ts
git commit -s -m "feat(topic-kb): repoint post-merge and recall-miss triggers to ingest"
```

---

## Task 9: Reshape `jolli compile` CLI

**Files:** Modify `cli/src/commands/CompileCommand.ts`, Test `cli/src/commands/CompileCommand.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Assert: `compile` (no args) calls drainIngest + renderTopicKBWiki.
//         `compile --rebuild` resets stores (saveProcessedSet(empty), saveTopicIndex(empty))
//          THEN drains THEN renders.
//         No-API-key path prints error + sets exitCode=1.
// Mock IngestPipeline.drainIngest, TopicWikiRenderer.renderTopicKBWiki, the stores,
// loadConfig, createStorage/setActiveStorage. Follow existing CompileCommand.test.ts harness.
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — rewrite the command registration + action

```typescript
type CompileOptions = { rebuild?: boolean; cwd: string };

export function registerCompileCommand(program: Command): void {
	program
		.command("compile")
		.description("Ingest pending development sources into the topic knowledge base")
		.option("--rebuild", "Discard the knowledge base and replay every source from scratch")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: CompileOptions) => {
			setLogDir(options.cwd);
			const config = await loadConfig();
			if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
				console.error("\n  Error: No API key configured. Run 'jolli enable' to set up.\n");
				process.exitCode = 1;
				return;
			}
			const storage = await createStorage(options.cwd, options.cwd);
			setActiveStorage(storage);

			if (options.rebuild) {
				// Reset the watermark + index only. An empty index makes route treat
				// every topic as new, so reconcile rebuilds pages from scratch
				// (current=null) and overwrites same-slug files; index-driven render
				// excludes any orphaned old page files. No page deletion needed.
				console.log("\n  Rebuilding knowledge base from scratch...");
				await saveProcessedSet(emptyProcessedSet(), options.cwd);
				await saveTopicIndex(emptyTopicIndex(), options.cwd);
			} else {
				console.log("\n  Ingesting pending sources into the knowledge base...");
			}

			const { batches, ingested } = await drainIngest(options.cwd, config);
			await renderTopicKBWiki(options.cwd, storage);
			console.log(`\n  Done: ${ingested} source(s) folded in ${batches} batch(es). Wiki rebuilt.\n`);
		});
}
```

Add imports: `drainIngest` (`../core/IngestPipeline.js`), `renderTopicKBWiki` (`../core/TopicWikiRenderer.js`), `saveProcessedSet`/`emptyProcessedSet` (`../core/ProcessedSourceStore.js`), `saveTopicIndex`/`emptyTopicIndex` (`../core/TopicIndexStore.js`). Remove the now-unused branch-compile imports (`compileBranches`, `mergeBranches`, `mergeBranchesHierarchical`, `listCompiledWithMtime`, `listBranchCatalog`, `markMergeTouched`, `createReadStorage`) and the `runCompileAll`/`runForceMerge` helpers.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/CompileCommand.ts cli/src/commands/CompileCommand.test.ts
git commit -s -m "feat(topic-kb): reshape jolli compile to ingest + --rebuild"
```

---

## Task 10: Full gate

- [ ] **Step 1: Run `npm run all`.** Expect green except the known pre-existing `GitClient.test.ts` flaky (and possibly its concurrency-flaky neighbors `GitExclude`/`SyncBootstrap`). If `sync/`/`install/` tests fail, re-run them in isolation (`npx vitest run src/sync/GitClient.test.ts src/sync/SyncBootstrap.test.ts src/install/GitExclude.test.ts`) to confirm they pass alone (flaky, not regression). All topic-KB + hook + command tests must pass; coverage above floor.

- [ ] **Step 2: If lint flags formatting:** `npm run lint:fix`, re-run, commit `style(topic-kb): biome formatting`.

---

## Self-review notes

- **Spec coverage:** §4.1 IngestOperation → Task 1; §4.2 IngestTrigger → Task 2; §4.1 worker dispatch + drain + render → Task 7; §4.3 repoint → Task 8; §5 CLI → Task 9; §6.1 renderTopicImpl + adapter → Task 3; §6.2 renderTopicWiki provider method → Task 5; §6.3 render-after-drain driver → Task 6. Task 4 removed (the spec's `deleteAllTopicPages` need is eliminated by index-driven reads + reset-index rebuild — see Task 4 note).
- **Cutover:** old branch-compile/merge ops are no longer enqueued (PostMergeHook + recall-miss repointed, fan-out gone), but their handlers/types remain (SP5 deletes). A pre-upgrade queued compile op still drains via the old handler — backward-safe.
- **Open items flagged for the implementer (not placeholders — decisions to finalize against real code):** (a) the StorageProvider deletion primitive for `deleteAllTopicPages` (Task 4 Step 3 — add `deleteFiles?` if none exists); (b) moving the exact `renderTopic`/`renderIndex` bodies into the `*Impl` forms (Task 3/5 — golden test guards equivalence); (c) threading the worker's existing `storage` handle into `runIngestFromQueue` (Task 7). Each names exactly what to read and decide.
- **Type consistency:** `IngestOperation.triggeredBy` union matches the enqueue call sites ("post-merge"/"recall-miss"/"manual"). `topicPageToCompiledTopic` only emits summary-type ids as `sourceCommits`.
