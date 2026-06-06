# Topic KB SP6 — Folder-driven plan/note + Multi-repo Compile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `jolli compile` and the VS Code **Build Knowledge Wiki** button compile every repo in the Memory Bank folder, by making plan/note sources folder-readable and adding a shared multi-repo sweep.

**Architecture:** Keep `drainIngest` as the single-repo ingest unit but make its plan/note + userfile source resolution key off the active folder storage's `kbRoot` (not the git `cwd`). Add a core `compileAllRepos` that discovers repo folders under `localFolder` (FS scan for `.jolli/index.json`) and runs the unit per repo with a folder-only storage. CLI and VS Code both call it; `QueueWorker` stays single-repo.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome (tabs, 120 col). CLI coverage floor: 97% stmt / 96% br / 97% fn / 97% line.

**Spec:** [`2026-06-04-topic-kb-06-folder-driven-multi-repo-compile-design.md`](../specs/2026-06-04-topic-kb-06-folder-driven-multi-repo-compile-design.md)

**Conventions:**
- Every commit uses `git commit -s` (DCO). No `Co-Authored-By` / no 🤖 footer.
- Run a single test: `npm run test -w @jolli.ai/cli -- <file> -t "<name>"`.
- Full gate before the final commit: `npm run all`.

**Shared names (keep identical across tasks):**
- `RepoTarget = { folder: string; kbRoot: string; repoIdentity?: string }`
- `discoverRepos(localFolder: string, excludeFolders: ReadonlyArray<string>): Promise<RepoTarget[]>`
- `CompileAllResult = { repos: Array<{ folder: string; repoIdentity?: string; ingested: number; batches: number; error?: string }>; totalIngested: number; failed: number }`
- `compileAllRepos(localFolder: string, config: LlmConfig, opts?: IngestOptions): Promise<CompileAllResult>`
- `FolderStorage.kbRoot` (getter)
- `createFolderStorageAtRoot(kbRoot: string): FolderStorage`
- `listUserKnowledgeFromRoot(kbRoot: string, branch?: string): Promise<ReadonlyArray<UserKnowledgeFile>>`
- `listFolderPlanNoteRefs(kbRoot: string): Promise<SourceRef[]>`
- `loadFolderPlanNoteContent(kbRoot: string, ref: SourceRef): Promise<string | null>`
- `loadFolderPlanNoteHeadline(kbRoot: string, ref: SourceRef): Promise<string>`
- `ManifestEntry.updatedAt?: string`
- `JolliConfig.compileExcludeFolders?: ReadonlyArray<string>`

---

## Task 1: Manifest carries `updatedAt`; FolderStorage stamps it on plan/note write

**Files:**
- Modify: `cli/src/core/KBTypes.ts` (ManifestEntry)
- Modify: `cli/src/core/FolderStorage.ts:815-852` (generatePlanMarkdown), `:892-...` (generateNoteMarkdown)
- Test: `cli/src/core/FolderStorage.test.ts`

`branch` is already persisted in `source.branch`; this task adds only the `updatedAt` ordering key. It is stamped at folder-write time (which coincides with the registry update that triggered the write), so it tracks the plan/note's logical update time and is stable across folder copies.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/FolderStorage.test.ts`:

```typescript
describe("plan/note manifest: updatedAt stamping", () => {
	it("records updatedAt + source.branch on a plan write", async () => {
		const { storage, root } = makeFolderStorage(); // existing helper in this file
		await storage.writeFiles([
			{ path: "plans/my-plan.md", content: "# Title\n\nbody", branch: "feature/x" },
		]);
		const manifest = JSON.parse(readFileSync(join(root, ".jolli", "manifest.json"), "utf-8"));
		const entry = manifest.files.find((f: { fileId: string }) => f.fileId === "plan:my-plan");
		expect(entry.source.branch).toBe("feature/x");
		expect(typeof entry.updatedAt).toBe("string");
		expect(Number.isNaN(Date.parse(entry.updatedAt))).toBe(false);
	});
});
```

If `makeFolderStorage` does not exist, mirror the construction already used at the top of `FolderStorage.test.ts` (search for `new FolderStorage(`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/FolderStorage.test.ts -t "records updatedAt"`
Expected: FAIL — `entry.updatedAt` is `undefined`.

- [ ] **Step 3: Implement**

In `cli/src/core/KBTypes.ts`, add to `ManifestEntry`:

```typescript
	readonly title?: string; // human-readable display name
	/** ISO 8601 last-write time. Ordering key for plan/note in the topic-KB timeline fold. */
	readonly updatedAt?: string;
```

In `cli/src/core/FolderStorage.ts`, in `generatePlanMarkdown`, extend the `updateManifest` call:

```typescript
		this.metadataManager.updateManifest({
			path: relativePath,
			fileId: `plan:${slug}`,
			type: "plan",
			fingerprint,
			source: branch ? { branch } : {},
			title: this.extractTitle(content) ?? slug,
			updatedAt: new Date().toISOString(),
		});
```

Do the same in `generateNoteMarkdown` (its `updateManifest` call uses `fileId: \`note:${id}\``, `type: "note"`) — add `updatedAt: new Date().toISOString()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/FolderStorage.test.ts -t "records updatedAt"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/KBTypes.ts cli/src/core/FolderStorage.ts cli/src/core/FolderStorage.test.ts
git commit -s -m "feat(topic-kb): stamp updatedAt on plan/note manifest entries"
```

---

## Task 2: `FolderStorage.kbRoot` getter

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (near the constructor, ~line 45)
- Test: `cli/src/core/FolderStorage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("exposes its root via kbRoot", () => {
	const storage = new FolderStorage("/tmp/mb/jolli", new MetadataManager("/tmp/mb/jolli/.jolli"));
	expect(storage.kbRoot).toBe("/tmp/mb/jolli");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/FolderStorage.test.ts -t "exposes its root"`
Expected: FAIL — `kbRoot` is not a property.

- [ ] **Step 3: Implement**

In `cli/src/core/FolderStorage.ts`, just after the constructor body, add:

```typescript
	/** The per-repo folder root (`<localFolder>/<repo>/`). Lets compile resolve
	 * the folder from the active storage instead of re-deriving it from a git cwd. */
	get kbRoot(): string {
		return this.rootPath;
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/FolderStorage.test.ts -t "exposes its root"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/FolderStorage.ts cli/src/core/FolderStorage.test.ts
git commit -s -m "feat(topic-kb): expose FolderStorage.kbRoot getter"
```

---

## Task 3: `FolderPlanNoteSource.ts` — read plan/note from the folder

**Files:**
- Create: `cli/src/core/FolderPlanNoteSource.ts`
- Test: `cli/src/core/FolderPlanNoteSource.test.ts`

Reads plan/note refs + content + headline from `<kbRoot>/.jolli/manifest.json` and `<kbRoot>/.jolli/plans|notes/<id>.md`. Timestamp: manifest `updatedAt`, else hidden-file mtime. Branch: `source.branch`, else reverse-derived from the visible path's first segment.

- [ ] **Step 1: Write the failing test**

Create `cli/src/core/FolderPlanNoteSource.test.ts`:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { listFolderPlanNoteRefs, loadFolderPlanNoteContent, loadFolderPlanNoteHeadline } from "./FolderPlanNoteSource.js";

function makeKb(): string {
	const root = join(tmpdir(), `fpns-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, ".jolli", "plans"), { recursive: true });
	mkdirSync(join(root, ".jolli", "notes"), { recursive: true });
	const manifest = {
		version: 1,
		files: [
			{ path: "feature-x/plan--p1.md", fileId: "plan:p1", type: "plan", fingerprint: "f1", source: { branch: "feature/x" }, title: "Plan One", updatedAt: "2026-06-01T00:00:00.000Z" },
			{ path: "main/note--n1.md", fileId: "note:n1", type: "note", fingerprint: "f2", source: {}, title: "Note One" }, // no updatedAt -> mtime fallback
			{ path: "main/topic--t.md", fileId: "wiki-topic-t", type: "wiki", fingerprint: "f3", source: {} }, // ignored
		],
	};
	writeFileSync(join(root, ".jolli", "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(root, ".jolli", "plans", "p1.md"), "---\ntype: plan\nslug: p1\n---\n\nplan body");
	writeFileSync(join(root, ".jolli", "notes", "n1.md"), "---\ntype: note\nid: n1\n---\n\nnote body");
	return root;
}

let roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; });

describe("FolderPlanNoteSource", () => {
	it("enumerates plan + note refs (not wiki), prefers manifest updatedAt", async () => {
		const root = makeKb(); roots.push(root);
		const refs = await listFolderPlanNoteRefs(root);
		const types = refs.map((r) => r.type).sort();
		expect(types).toEqual(["note", "plan"]);
		const plan = refs.find((r) => r.id === "p1");
		expect(plan?.timestamp).toBe("2026-06-01T00:00:00.000Z");
		const note = refs.find((r) => r.id === "n1");
		expect(Number.isNaN(Date.parse(note?.timestamp ?? "x"))).toBe(false); // mtime fallback is a valid date
	});

	it("loads plan/note content from hidden md", async () => {
		const root = makeKb(); roots.push(root);
		expect(await loadFolderPlanNoteContent(root, { type: "plan", id: "p1", timestamp: "" })).toContain("plan body");
		expect(await loadFolderPlanNoteContent(root, { type: "note", id: "n1", timestamp: "" })).toContain("note body");
		expect(await loadFolderPlanNoteContent(root, { type: "plan", id: "missing", timestamp: "" })).toBeNull();
	});

	it("headline carries type, branch, title", async () => {
		const root = makeKb(); roots.push(root);
		const h = await loadFolderPlanNoteHeadline(root, { type: "plan", id: "p1", timestamp: "2026-06-01T00:00:00.000Z" });
		expect(h).toContain("plan");
		expect(h).toContain("feature/x");
		expect(h).toContain("Plan One");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/FolderPlanNoteSource.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cli/src/core/FolderPlanNoteSource.ts`:

```typescript
/**
 * FolderPlanNoteSource — reads plan/note compile sources straight from the
 * Memory Bank folder (`<kbRoot>/.jolli/manifest.json` + `plans|notes/<id>.md`),
 * so compile no longer needs the working repo's plans.json registry. Used for
 * folder/dual-write storage; orphan-only mode keeps the registry path.
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { MetadataManager } from "./MetadataManager.js";
import type { ManifestEntry } from "./KBTypes.js";
import type { SourceRef, SourceType } from "./TopicKBTypes.js";

const log = createLogger("FolderPlanNoteSource");

interface PlanNoteMeta {
	readonly type: "plan" | "note";
	readonly id: string;
	readonly title: string;
	readonly branch: string;
	readonly timestamp: string;
}

/** fileId shapes: `plan:<slug>` / `note:<id>`. */
function idFromFileId(fileId: string): string {
	const colon = fileId.indexOf(":");
	return colon === -1 ? fileId : fileId.slice(colon + 1);
}

function hiddenPath(kbRoot: string, type: "plan" | "note", id: string): string {
	const dir = type === "plan" ? "plans" : "notes";
	return join(kbRoot, ".jolli", dir, `${id}.md`);
}

/** mtime fallback when the manifest entry predates updatedAt stamping. */
function mtimeOrEmpty(path: string): string {
	try {
		return statSync(path).mtime.toISOString();
	} catch {
		return "";
	}
}

/** Reverse-derive branch from the visible path's first segment (e.g. `feature-x/plan--p1.md`). */
function branchFromPath(meta: MetadataManager, path: string): string {
	const seg = path.split("/")[0] ?? "";
	return meta.resolveBranchForFolder?.(seg) ?? seg;
}

function readMeta(kbRoot: string): PlanNoteMeta[] {
	const meta = new MetadataManager(join(kbRoot, ".jolli"));
	let entries: ManifestEntry[];
	try {
		entries = meta.readManifest().files;
	} catch (err) {
		log.warn("Cannot read manifest at %s: %s", kbRoot, (err as Error).message);
		return [];
	}
	const out: PlanNoteMeta[] = [];
	for (const e of entries) {
		if (e.type !== "plan" && e.type !== "note") continue;
		const id = idFromFileId(e.fileId);
		const branch = e.source?.branch ?? branchFromPath(meta, e.path);
		const timestamp = e.updatedAt ?? mtimeOrEmpty(hiddenPath(kbRoot, e.type, id));
		out.push({ type: e.type, id, title: e.title ?? id, branch, timestamp });
	}
	return out;
}

export async function listFolderPlanNoteRefs(kbRoot: string): Promise<SourceRef[]> {
	return readMeta(kbRoot).map((m) => ({ type: m.type as SourceType, id: m.id, timestamp: m.timestamp }));
}

export async function loadFolderPlanNoteContent(kbRoot: string, ref: SourceRef): Promise<string | null> {
	if (ref.type !== "plan" && ref.type !== "note") return null;
	try {
		return await readFile(hiddenPath(kbRoot, ref.type, ref.id), "utf-8");
	} catch {
		return null; // vanished source -> drops from the fold
	}
}

export async function loadFolderPlanNoteHeadline(kbRoot: string, ref: SourceRef): Promise<string> {
	const m = readMeta(kbRoot).find((x) => x.type === ref.type && x.id === ref.id);
	return `(${ref.type}, ${m?.branch ?? "?"}, ${ref.timestamp}) ${m?.title ?? ref.id}`;
}
```

NOTE: `MetadataManager.resolveBranchForFolder` may not exist. Check `MemoryBankScanner.resolveBranchFolder` for the existing forward mapping (branch → folder via `branches.json`). If no reverse helper exists, implement the reverse inline here by reading `branches.json` through `MetadataManager`, or accept the raw folder segment (the `?? seg` fallback already does this). Keep it to the segment fallback if a reverse helper is not readily available — branch is display-only in the headline.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/FolderPlanNoteSource.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/FolderPlanNoteSource.ts cli/src/core/FolderPlanNoteSource.test.ts
git commit -s -m "feat(topic-kb): add FolderPlanNoteSource (plan/note from Memory Bank folder)"
```

---

## Task 4: `listUserKnowledgeFromRoot(kbRoot, branch?)`

**Files:**
- Modify: `cli/src/core/MemoryBankScanner.ts` (extract body from `listUserKnowledge`)
- Test: `cli/src/core/MemoryBankScanner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/MemoryBankScanner.test.ts` (reuse the fixture pattern already in that file — a temp localFolder with `<repo>/.jolli/manifest.json` and a top-level user `.md`):

```typescript
it("listUserKnowledgeFromRoot reads a kbRoot directly without cwd", async () => {
	const { kbRoot } = makeKbWithUserFile(); // mirror existing fixture helper
	const files = await listUserKnowledgeFromRoot(kbRoot);
	expect(files.some((f) => f.scope === "repo")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/MemoryBankScanner.test.ts -t "listUserKnowledgeFromRoot"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `cli/src/core/MemoryBankScanner.ts`, rename the current body of `listUserKnowledge` into a new exported function that takes `kbRoot`, and make `listUserKnowledge` resolve `kbRoot` then delegate:

```typescript
export async function listUserKnowledge(cwd: string, branch?: string): Promise<ReadonlyArray<UserKnowledgeFile>> {
	const kbRoot = await tryResolveKBRoot(cwd);
	if (!kbRoot) return [];
	return listUserKnowledgeFromRoot(kbRoot, branch);
}

export async function listUserKnowledgeFromRoot(kbRoot: string, branch?: string): Promise<ReadonlyArray<UserKnowledgeFile>> {
	if (!existsSync(kbRoot)) {
		log.debug("Memory Bank kbRoot not present: %s", kbRoot);
		return [];
	}
	// ... move the existing body that started after the old `if (!existsSync(kbRoot))`
	//     (localFolderRoot, metadata, manifestPaths, the three collectMarkdown calls, return results) here verbatim ...
}
```

Move the existing logic (localFolderRoot/metadata/manifestPaths/global+repo+branch `collectMarkdown` calls/`return results`) into `listUserKnowledgeFromRoot` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/MemoryBankScanner.test.ts -t "listUserKnowledgeFromRoot"`
Expected: PASS. Also run the full file to confirm no regression: `npm run test -w @jolli.ai/cli -- src/core/MemoryBankScanner.test.ts`

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/MemoryBankScanner.ts cli/src/core/MemoryBankScanner.test.ts
git commit -s -m "refactor(topic-kb): add listUserKnowledgeFromRoot(kbRoot) variant"
```

---

## Task 5: SourceTimeline — mode-aware plan/note + userfile enumeration

**Files:**
- Modify: `cli/src/core/SourceTimeline.ts:51-86` (collectAllSourceRefs)
- Test: `cli/src/core/SourceTimeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that passes a real `FolderStorage` (over a fixture kbRoot containing manifest plan/note + index.json) and asserts plan/note refs come from the folder, not `loadPlansRegistry`:

```typescript
it("uses folder plan/note when storage is FolderStorage", async () => {
	const kbRoot = makeKbWithPlanNoteAndIndex(); // fixture: .jolli/manifest.json (1 plan), .jolli/plans/p1.md, .jolli/index.json (>=1 entry)
	const storage = new FolderStorage(kbRoot, new MetadataManager(join(kbRoot, ".jolli")));
	const refs = await collectAllSourceRefs("/nonexistent-cwd", storage);
	expect(refs.some((r) => r.type === "plan" && r.id === "p1")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceTimeline.test.ts -t "uses folder plan/note"`
Expected: FAIL — refs has no folder plan (current code reads `loadPlansRegistry("/nonexistent-cwd")` → empty).

- [ ] **Step 3: Implement**

In `cli/src/core/SourceTimeline.ts`, import `FolderStorage` and `listFolderPlanNoteRefs`, `listUserKnowledgeFromRoot`, and branch the plan/note + userfile collection:

```typescript
import { FolderStorage } from "./FolderStorage.js";
import { listFolderPlanNoteRefs } from "./FolderPlanNoteSource.js";
import { listUserKnowledge, listUserKnowledgeFromRoot } from "./MemoryBankScanner.js";

export async function collectAllSourceRefs(cwd: string, storage?: StorageProvider): Promise<SourceRef[]> {
	const readStorage = storage ?? (await createReadStorage(cwd));
	const kbRoot = readStorage instanceof FolderStorage ? readStorage.kbRoot : null;
	const refs: SourceRef[] = [];

	const index = await getIndex(cwd, readStorage);
	if (index) {
		for (const e of index.entries) {
			if (e.parentCommitHash === null || e.parentCommitHash === undefined) {
				refs.push({ type: "summary", id: e.commitHash, timestamp: e.commitDate });
			}
		}
	}

	if (kbRoot) {
		refs.push(...(await listFolderPlanNoteRefs(kbRoot)));
	} else {
		const registry = await loadPlansRegistry(cwd);
		for (const p of Object.values(registry.plans)) refs.push({ type: "plan", id: p.slug, timestamp: p.updatedAt });
		for (const n of Object.values(registry.notes ?? {})) refs.push({ type: "note", id: n.id, timestamp: n.updatedAt });
	}

	const branches = index ? [...new Set(index.entries.map((e) => e.branch))] : [];
	const branchList: Array<string | undefined> = branches.length > 0 ? branches : [undefined];
	const seenUserFiles = new Set<string>();
	for (const branch of branchList) {
		const files = kbRoot ? await listUserKnowledgeFromRoot(kbRoot, branch) : await listUserKnowledge(cwd, branch);
		for (const f of files) {
			const id = `${f.path}@${f.fingerprint}`;
			if (seenUserFiles.has(id)) continue;
			seenUserFiles.add(id);
			refs.push({ type: "userfile", id, timestamp: f.mtime });
		}
	}

	return refs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceTimeline.test.ts`
Expected: PASS (new test + existing tests still green — orphan/no-folder path unchanged).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/SourceTimeline.ts cli/src/core/SourceTimeline.test.ts
git commit -s -m "feat(topic-kb): collectAllSourceRefs reads plan/note/userfile from folder"
```

---

## Task 6: SourceContent — mode-aware content + headline

**Files:**
- Modify: `cli/src/core/SourceContent.ts` (loadSourceContent, loadSourceHeadline — add optional `storage` param)
- Test: `cli/src/core/SourceContent.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("loads plan content from folder when given a FolderStorage", async () => {
	const kbRoot = makeKbWithPlanNote(); // .jolli/manifest.json + .jolli/plans/p1.md
	const storage = new FolderStorage(kbRoot, new MetadataManager(join(kbRoot, ".jolli")));
	const body = await loadSourceContent({ type: "plan", id: "p1", timestamp: "" }, "/nonexistent-cwd", storage);
	expect(body).toContain("plan body");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceContent.test.ts -t "loads plan content from folder"`
Expected: FAIL — `loadSourceContent` takes only `(ref, cwd)` / reads registry.

- [ ] **Step 3: Implement**

In `cli/src/core/SourceContent.ts`, add the optional `storage` arg and branch plan/note/userfile to the folder loaders when it is a FolderStorage:

```typescript
import { FolderStorage } from "./FolderStorage.js";
import { loadFolderPlanNoteContent, loadFolderPlanNoteHeadline } from "./FolderPlanNoteSource.js";
import { listUserKnowledge, listUserKnowledgeFromRoot } from "./MemoryBankScanner.js";

export async function loadSourceContent(ref: SourceRef, cwd: string, storage?: StorageProvider): Promise<string | null> {
	const kbRoot = storage instanceof FolderStorage ? storage.kbRoot : null;
	switch (ref.type) {
		case "summary": {
			const summary = await getSummary(ref.id, cwd);
			return summary ? formatSummaryForCompile(summary) : null;
		}
		case "plan":
		case "note": {
			if (kbRoot) return loadFolderPlanNoteContent(kbRoot, ref);
			// orphan-only fallback: existing registry + sourcePath path (unchanged)
			const registry = await loadPlansRegistry(cwd);
			if (ref.type === "plan") {
				const entry = Object.values(registry.plans).find((p) => p.slug === ref.id);
				return entry ? readTextOrNull(entry.sourcePath) : null;
			}
			const note = Object.values(registry.notes ?? {}).find((n) => n.id === ref.id);
			return note?.sourcePath ? readTextOrNull(note.sourcePath) : null;
		}
		case "userfile": {
			const { path, fingerprint } = splitUserfileId(ref.id);
			const files = kbRoot ? await listUserKnowledgeFromRoot(kbRoot) : await listUserKnowledge(cwd);
			const match = files.find((f) => f.path === path && f.fingerprint === fingerprint);
			return match ? match.content : null;
		}
	}
}
```

Apply the same `kbRoot` branch to `loadSourceHeadline`: for `plan`/`note`, `if (kbRoot) return loadFolderPlanNoteHeadline(kbRoot, ref);` before the registry lookup; `userfile` and `summary` headlines are unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceContent.test.ts`
Expected: PASS (new test + existing orphan-path tests green).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/SourceContent.ts cli/src/core/SourceContent.test.ts
git commit -s -m "feat(topic-kb): loadSourceContent/Headline read plan/note from folder storage"
```

---

## Task 7: IngestPipeline — thread the read storage through the batch

**Files:**
- Modify: `cli/src/core/IngestPipeline.ts` (ingestPendingBatch, drainIngest, IngestOptions)
- Test: `cli/src/core/IngestPipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test (the existing suite mocks `callLlm`) that runs `drainIngest` with `opts.readStorage` = a FolderStorage over a fixture kbRoot holding a plan, and asserts the plan body reached reconcile:

```typescript
it("drains a folder plan via opts.readStorage without a real cwd", async () => {
	const kbRoot = makeKbWithOnePlanAndEmptyIndex();
	const storage = new FolderStorage(kbRoot, new MetadataManager(join(kbRoot, ".jolli")));
	setActiveStorage(storage);
	// mock callLlm route -> assign the plan to topic "t"; reconcile -> page content
	const { ingested } = await drainIngest(kbRoot, fakeConfig, { readStorage: storage });
	expect(ingested).toBeGreaterThan(0);
});
```

Follow the existing mock setup at the top of `IngestPipeline.test.ts` for `callLlm` route/reconcile responses.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/IngestPipeline.test.ts -t "drains a folder plan"`
Expected: FAIL — `IngestOptions` has no `readStorage`; sources collected via cwd are empty.

- [ ] **Step 3: Implement**

In `cli/src/core/IngestPipeline.ts`:

```typescript
// extend the options type (find the existing `interface IngestOptions`)
	readStorage?: StorageProvider;
```

In `ingestPendingBatch`, resolve the read storage once and thread it:

```typescript
	const readStorage = opts?.readStorage ?? (await createReadStorage(cwd));
	const processed = await readProcessedSet(cwd);
	const pending = await listPendingSources(cwd, processed, readStorage);
	...
	const headlines = await Promise.all(batch.map((r) => loadSourceHeadline(r, cwd, readStorage)));
	...
		const body = await loadSourceContent(ref, cwd, readStorage);
```

Add `import { createReadStorage } from "./ReadStorageResolver.js";` and `import type { StorageProvider } from "./StorageProvider.js";` if not present. In `drainIngest`, pass `opts` straight through to `ingestPendingBatch` (already does) — no signature change beyond `IngestOptions`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/IngestPipeline.test.ts`
Expected: PASS (new test + existing tests green — when `opts.readStorage` is absent, behavior is identical to before).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/IngestPipeline.ts cli/src/core/IngestPipeline.test.ts
git commit -s -m "feat(topic-kb): thread read storage through ingest batch"
```

---

## Task 8: `createFolderStorageAtRoot(kbRoot)`

**Files:**
- Modify: `cli/src/core/StorageFactory.ts`
- Test: `cli/src/core/StorageFactory.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("createFolderStorageAtRoot builds a FolderStorage at the exact root", () => {
	const s = createFolderStorageAtRoot("/tmp/mb/jolli");
	expect(s).toBeInstanceOf(FolderStorage);
	expect(s.kbRoot).toBe("/tmp/mb/jolli");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/StorageFactory.test.ts -t "createFolderStorageAtRoot"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `cli/src/core/StorageFactory.ts`:

```typescript
/**
 * Builds a folder-only FolderStorage at an explicit kbRoot — for the multi-repo
 * compile sweep, where the target repo has no git working tree (only its
 * `<localFolder>/<repo>/` folder). No orphan side: swept repos write folder-only.
 */
export function createFolderStorageAtRoot(kbRoot: string): FolderStorage {
	return new FolderStorage(kbRoot, new MetadataManager(join(kbRoot, ".jolli")));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/StorageFactory.test.ts -t "createFolderStorageAtRoot"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/StorageFactory.ts cli/src/core/StorageFactory.test.ts
git commit -s -m "feat(topic-kb): add createFolderStorageAtRoot for folder-only targets"
```

---

## Task 9: `MemoryBankRepoDiscovery.ts` — discover repos under localFolder

**Files:**
- Create: `cli/src/core/MemoryBankRepoDiscovery.ts`
- Modify: `cli/src/Types.ts` (JolliConfig — add `compileExcludeFolders?`)
- Test: `cli/src/core/MemoryBankRepoDiscovery.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";

function makeLocalFolder(): string {
	const root = join(tmpdir(), `mbrd-${Math.random().toString(36).slice(2)}`);
	for (const repo of ["jolli", "jolliai", "temp"]) {
		mkdirSync(join(root, repo, ".jolli"), { recursive: true });
		writeFileSync(join(root, repo, ".jolli", "index.json"), JSON.stringify({ schemaVersion: 5, entries: [] }));
	}
	mkdirSync(join(root, "not-a-repo"), { recursive: true }); // no .jolli/index.json
	mkdirSync(join(root, ".jolli"), { recursive: true });
	writeFileSync(join(root, ".jolli", "repos.json"), JSON.stringify({ version: 1, mappings: [{ repoIdentity: "https://github.com/jolliai/jolliai", folder: "jolliai" }] }));
	return root;
}

let roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; });

describe("discoverRepos", () => {
	it("finds dirs with .jolli/index.json, excludes by name, labels via repos.json, sorted", async () => {
		const root = makeLocalFolder(); roots.push(root);
		const repos = await discoverRepos(root, ["temp"]);
		expect(repos.map((r) => r.folder)).toEqual(["jolli", "jolliai"]); // temp excluded, not-a-repo skipped, sorted
		expect(repos.find((r) => r.folder === "jolliai")?.repoIdentity).toBe("https://github.com/jolliai/jolliai");
		expect(repos.find((r) => r.folder === "jolli")?.repoIdentity).toBeUndefined();
		expect(repos[0].kbRoot).toBe(join(root, "jolli"));
	});

	it("empty/missing localFolder -> []", async () => {
		expect(await discoverRepos(join(tmpdir(), "does-not-exist-xyz"), [])).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/MemoryBankRepoDiscovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add to `JolliConfig` in `cli/src/Types.ts` (near `excludePatterns`):

```typescript
	/** Folder names (under localFolder) to skip during multi-repo `jolli compile`. Exact name or glob. Default: none. */
	readonly compileExcludeFolders?: ReadonlyArray<string>;
```

Create `cli/src/core/MemoryBankRepoDiscovery.ts`:

```typescript
/**
 * MemoryBankRepoDiscovery — enumerates compile targets under the Memory Bank
 * root. Source of truth is the filesystem (a child dir with `.jolli/index.json`
 * has compilable data); `repos.json` is consulted only to label a target with
 * its repoIdentity. `repos.json` is NOT the discovery source — it is the sync
 * engine's map and is incomplete for local-only repos.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("MemoryBankRepoDiscovery");

export interface RepoTarget {
	readonly folder: string;
	readonly kbRoot: string;
	readonly repoIdentity?: string;
}

/** Minimal glob: exact match, or `*` wildcards. */
function matchesAny(name: string, patterns: ReadonlyArray<string>): boolean {
	return patterns.some((p) => {
		if (!p.includes("*")) return p === name;
		const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		return re.test(name);
	});
}

function readRepoIdentities(localFolder: string): Map<string, string> {
	const out = new Map<string, string>();
	const p = join(localFolder, ".jolli", "repos.json");
	try {
		const json = JSON.parse(readFileSync(p, "utf-8")) as { mappings?: Array<{ repoIdentity: string; folder: string }> };
		for (const m of json.mappings ?? []) out.set(m.folder, m.repoIdentity);
	} catch {
		/* no repos.json — labels stay undefined */
	}
	return out;
}

export async function discoverRepos(localFolder: string, excludeFolders: ReadonlyArray<string>): Promise<RepoTarget[]> {
	if (!existsSync(localFolder)) return [];
	const identities = readRepoIdentities(localFolder);
	const targets: RepoTarget[] = [];
	for (const entry of readdirSync(localFolder, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (matchesAny(entry.name, excludeFolders)) continue;
		const kbRoot = join(localFolder, entry.name);
		if (!existsSync(join(kbRoot, ".jolli", "index.json"))) continue;
		targets.push({ folder: entry.name, kbRoot, repoIdentity: identities.get(entry.name) });
	}
	targets.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
	log.info("Discovered %d repo target(s) under %s", targets.length, localFolder);
	return targets;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/MemoryBankRepoDiscovery.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/MemoryBankRepoDiscovery.ts cli/src/Types.ts cli/src/core/MemoryBankRepoDiscovery.test.ts
git commit -s -m "feat(topic-kb): add MemoryBankRepoDiscovery + compileExcludeFolders config"
```

---

## Task 10: `MultiRepoCompile.ts` — `compileAllRepos`

**Files:**
- Create: `cli/src/core/MultiRepoCompile.ts`
- Test: `cli/src/core/MultiRepoCompile.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
// mock the heavy deps so the test is unit-level
vi.mock("./IngestPipeline.js", () => ({
	drainIngest: vi.fn(async (cwd: string) => {
		if (cwd.endsWith("boom")) throw new Error("kaboom");
		return { batches: 1, ingested: 2 };
	}),
}));
vi.mock("./TopicWikiRenderer.js", () => ({ renderTopicKBWiki: vi.fn(async () => {}) }));
vi.mock("./MemoryBankRepoDiscovery.js", () => ({
	discoverRepos: vi.fn(async () => [
		{ folder: "jolli", kbRoot: "/mb/jolli" },
		{ folder: "boom", kbRoot: "/mb/boom" },
	]),
}));
import { compileAllRepos } from "./MultiRepoCompile.js";

describe("compileAllRepos", () => {
	it("compiles each repo, isolates failures, aggregates", async () => {
		const res = await compileAllRepos("/mb", { model: "haiku" } as never);
		expect(res.totalIngested).toBe(2); // jolli ok (2), boom failed (0)
		expect(res.failed).toBe(1);
		expect(res.repos.find((r) => r.folder === "boom")?.error).toContain("kaboom");
		expect(res.repos.find((r) => r.folder === "jolli")?.ingested).toBe(2);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/MultiRepoCompile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cli/src/core/MultiRepoCompile.ts`:

```typescript
/**
 * MultiRepoCompile — runs the single-repo ingest unit over every repo in the
 * Memory Bank folder. Shared by `jolli compile` (no --cwd) and the VS Code
 * "Build Knowledge Wiki" button. Swept repos use folder-only storage (no orphan
 * working tree). Per-repo failures are isolated and reported, never swallowed.
 */

import { createLogger } from "../Logger.js";
import type { LlmConfig } from "./LlmClient.js"; // adjust import to wherever LlmConfig lives (see drainIngest's signature)
import { drainIngest, type IngestOptions } from "./IngestPipeline.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import { createFolderStorageAtRoot } from "./StorageFactory.js";
import { setActiveStorage } from "./SummaryStore.js";
import { renderTopicKBWiki } from "./TopicWikiRenderer.js";

const log = createLogger("MultiRepoCompile");

export interface CompileAllRepoResult {
	readonly folder: string;
	readonly repoIdentity?: string;
	readonly ingested: number;
	readonly batches: number;
	readonly error?: string;
}

export interface CompileAllResult {
	readonly repos: CompileAllRepoResult[];
	readonly totalIngested: number;
	readonly failed: number;
}

export async function compileAllRepos(
	localFolder: string,
	config: LlmConfig,
	opts?: Pick<IngestOptions, "batchSize">,
): Promise<CompileAllResult> {
	const excludeFolders = (config as { compileExcludeFolders?: ReadonlyArray<string> }).compileExcludeFolders ?? [];
	const targets = await discoverRepos(localFolder, excludeFolders);
	const repos: CompileAllRepoResult[] = [];
	let totalIngested = 0;
	let failed = 0;

	for (const t of targets) {
		try {
			const storage = createFolderStorageAtRoot(t.kbRoot);
			setActiveStorage(storage);
			const { batches, ingested } = await drainIngest(t.kbRoot, config, { ...opts, readStorage: storage });
			await renderTopicKBWiki(t.kbRoot, storage);
			totalIngested += ingested;
			repos.push({ folder: t.folder, repoIdentity: t.repoIdentity, ingested, batches });
			log.info("Compiled %s: %d source(s)", t.folder, ingested);
		} catch (err) {
			failed++;
			const message = err instanceof Error ? err.message : String(err);
			repos.push({ folder: t.folder, repoIdentity: t.repoIdentity, ingested: 0, batches: 0, error: message });
			log.error("Compile failed for %s: %s", t.folder, message);
		}
	}
	return { repos, totalIngested, failed };
}
```

NOTE: Match the `LlmConfig` import to the exact type `drainIngest` already takes (see `IngestPipeline.ts`'s import). If `IngestOptions` is not exported, export it from `IngestPipeline.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/MultiRepoCompile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/MultiRepoCompile.ts cli/src/core/MultiRepoCompile.test.ts
git commit -s -m "feat(topic-kb): add compileAllRepos multi-repo sweep"
```

---

## Task 11: CLI `compile` — default sweep, `--cwd` single

**Files:**
- Modify: `cli/src/commands/CompileCommand.ts`
- Test: `cli/src/commands/CompileCommand.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

The CLI command test mocks `compileAllRepos` and asserts the no-`--cwd` path calls it. Mirror the existing command-test pattern (mock the core fns, build the commander program, invoke the action). Minimal assertion:

```typescript
it("bare compile sweeps all repos", async () => {
	const sweep = vi.fn(async () => ({ repos: [{ folder: "jolli", ingested: 3, batches: 1 }], totalIngested: 3, failed: 0 }));
	// vi.mock MultiRepoCompile -> compileAllRepos = sweep; loadConfig -> { apiKey:"x", localFolder:"/mb" }
	await runCompileAction({}); // helper that invokes the registered action with no --cwd-derived single flag
	expect(sweep).toHaveBeenCalledWith("/mb", expect.anything(), expect.anything());
});
```

If there is no existing command-test harness, test the behavior at the seam instead: extract the action body decision into a small exported helper and unit-test that helper. Keep the assertion: no explicit single-repo target → `compileAllRepos`; explicit `--cwd <dir>` → single-repo `drainIngest` path.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/commands/CompileCommand.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Rewrite the action in `cli/src/commands/CompileCommand.ts`. Treat presence of an explicit `--cwd` as the single-repo intent (commander gives the default repo root otherwise; add a sentinel by reading `process.argv` for `--cwd`, or add a separate `--repo <dir>` option). Simplest: add an explicit boolean — detect whether the user passed `--cwd` by making its default `undefined` and resolving the repo root only in the single branch:

```typescript
type CompileOptions = { rebuild?: boolean; cwd?: string };

// ...registration: keep --rebuild; change --cwd default to undefined
		.option("--cwd <dir>", "Compile a single repo at this directory (default: sweep all Memory Bank repos)")
		.action(async (options: CompileOptions) => {
			const config = await loadConfig();
			if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
				console.error("\n  Error: No API key configured. Run 'jolli enable' to set up.\n");
				process.exitCode = 1;
				return;
			}

			if (options.cwd) {
				// single-repo (dual-write): unchanged behavior
				setLogDir(options.cwd);
				const storage = await createStorage(options.cwd, options.cwd);
				setActiveStorage(storage);
				if (options.rebuild) {
					await saveProcessedSet(emptyProcessedSet(), options.cwd);
					await saveTopicIndex(emptyTopicIndex(), options.cwd);
				}
				const { batches, ingested } = await drainIngest(options.cwd, config);
				await renderTopicKBWiki(options.cwd, storage);
				console.log(`\n  Done: ${ingested} source(s) folded in ${batches} batch(es). Wiki rebuilt.\n`);
				return;
			}

			// default: sweep all repos under the Memory Bank folder
			const localFolder = config.localFolder;
			if (!localFolder) {
				console.error("\n  Error: No Memory Bank folder configured (localFolder). Set one in Settings.\n");
				process.exitCode = 1;
				return;
			}
			console.log("\n  Ingesting pending sources across all Memory Bank repos...");
			const { compileAllRepos } = await import("../core/MultiRepoCompile.js");
			const result = await compileAllRepos(localFolder, config);
			for (const r of result.repos) {
				console.log(r.error ? `    ✗ ${r.folder}: ${r.error}` : `    ✓ ${r.folder}: ${r.ingested} source(s)`);
			}
			console.log(`\n  Done: ${result.totalIngested} source(s) across ${result.repos.length} repo(s)${result.failed ? `, ${result.failed} failed` : ""}.\n`);
			if (result.failed > 0) process.exitCode = 1;
		});
```

Note: `--rebuild` in sweep mode is per-repo reset — if needed, thread a `rebuild` flag into `compileAllRepos` that resets each repo's processed+index before `drainIngest`. For this iteration `--rebuild` is supported only with `--cwd`; in sweep mode print a hint that `--rebuild` requires `--cwd`. (Document this; do not silently ignore.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/commands/CompileCommand.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/CompileCommand.ts cli/src/commands/CompileCommand.test.ts
git commit -s -m "feat(topic-kb): jolli compile sweeps all repos by default (--cwd for single)"
```

---

## Task 12: VS Code `compileNow` — sweep all repos

**Files:**
- Modify: `vscode/src/CompileCommand.ts`
- Test: `vscode/src/CompileCommand.test.ts` (create if absent; mirror existing vscode command tests)

- [ ] **Step 1: Write the failing test**

```typescript
it("compileNow sweeps all repos via compileAllRepos", async () => {
	// mock loadConfig -> { apiKey:"x", localFolder:"/mb" }; mock compileAllRepos -> { repos:[...], totalIngested:5, failed:0 }
	// register command with a fake sidebarProvider, invoke it, assert compileAllRepos called with "/mb"
	expect(compileAllRepos).toHaveBeenCalledWith("/mb", expect.anything());
	expect(sidebarProvider.refreshKnowledgeBaseFolders).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/CompileCommand.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `vscode/src/CompileCommand.ts`, replace the single-repo body with a sweep. Drop the per-repo `createStorage(cwd, cwd)` + `drainIngest(cwd)`; call the shared core:

```typescript
		const { loadConfig } = await import("../../cli/src/core/SessionTracker.js");
		const config = await loadConfig();
		if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
			await vscode.window.showInformationMessage(
				"Building the knowledge wiki needs an API key. Open Settings → Memory Bank to sign in or configure a key, then try again.",
			);
			return;
		}
		if (!config.localFolder) {
			await vscode.window.showInformationMessage("No Memory Bank folder configured. Set one in Settings → Memory Bank.");
			return;
		}
		const { compileAllRepos } = await import("../../cli/src/core/MultiRepoCompile.js");
		try {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "Jolli Memory: Building knowledge wiki…", cancellable: false },
				async () => compileAllRepos(config.localFolder as string, config),
			);
			const msg = `Knowledge wiki updated: ${result.totalIngested} source(s) across ${result.repos.length} repo(s)` +
				(result.failed ? ` (${result.failed} failed)` : "");
			await vscode.window.showInformationMessage(msg);
		} catch (err) {
			await vscode.window.showErrorMessage(`Knowledge wiki build failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		sidebarProvider.refreshKnowledgeBaseFolders();
```

The `cwd` field in `CompileCommandOpts` is no longer used by the body; keep the field for interface stability (or remove it and update the caller in `Extension.ts` — verify the call site).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/CompileCommand.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add vscode/src/CompileCommand.ts vscode/src/CompileCommand.test.ts
git commit -s -m "feat(topic-kb): VS Code Build Knowledge Wiki sweeps all repos"
```

---

## Task 13: Full gate + coverage

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage ≥ 97/96/97/97.

- [ ] **Step 2: If coverage dipped**, add targeted tests for the uncovered branches (most likely: orphan-only fallback in SourceContent/SourceTimeline; `matchesAny` glob branch; `discoverRepos` empty path; `compileAllRepos` failure branch). Re-run `npm run all`.

- [ ] **Step 3: Manual smoke (real data)**

```bash
cd cli && npm run build && npm install -g .
cd /Users/flyer/jolli/code/jolli && jolli compile --cwd /Users/flyer/jolli/code/jolli   # single repo: jolli now gets a wiki
jolli compile   # sweep: jolli + jolliai both compiled
```
Expected: `~/Documents/memorybank/jolli/_wiki/` now populated; sweep summary lists both `jolli` and `jolliai`.

- [ ] **Step 4: Commit any coverage top-ups**

```bash
git add -A
git commit -s -m "test(topic-kb): cover SP6 folder-driven multi-repo compile branches"
```

---

## Self-review notes (addressed)

- **Spec coverage:** §4.1 → Task 3; §4.2 → Tasks 5–6; §4.3 → Task 4; §5 → Task 1; §6.1 → Task 9; §6.2 → Tasks 8+10; §6.3 → Task 7; §6.4 → Tasks 11–12; testing §8 → per-task tests + Task 13.
- **Type consistency:** `kbRoot` getter (Task 2) consumed in Tasks 5/6/8; `readStorage` option (Task 7) consumed in Task 10; `RepoTarget`/`CompileAllResult` defined Tasks 9/10 and used in 11/12; `compileExcludeFolders` defined Task 9, read Task 10.
- **Known verify-on-implement points (flagged inline):** `MetadataManager` reverse branch helper (Task 3 — segment fallback is acceptable), exact `LlmConfig`/`IngestOptions` exports (Tasks 7/10), existence of command-test harnesses (Tasks 11/12), `MetadataManager`/fixture helper names in existing test files (Tasks 1/4/5/6).
