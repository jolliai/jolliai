# Topic KB Sub-project 1 — Data Model & Timeline Iterator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data layer (source refs, processed-ID set, topic index, topic-page store) and a deterministic time-ordered iterator over un-ingested sources for the topic-centric knowledge base.

**Architecture:** New `topics/`-prefixed artifacts persisted through the existing `StorageProvider` (dual-write), mirroring `CompiledStore`. A pure-ish iterator merges four source streams (summaries, plans, notes, user files), filters out already-processed IDs, and sorts old→new by epoch timestamp with a deterministic `(type, id)` tie-break. No LLM, no ingest content.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome (tabs, 120 col). CLI coverage floor: 97% stmt / 96% br / 97% fn / 97% line.

**Spec:** [Topic KB Sub-project 1](../specs/2026-06-02-topic-kb-01-data-model-timeline-design.md) · **Parent architecture:** [Topic-Centric KB](../specs/2026-06-02-topic-centric-knowledge-base-design.md)

---

## File structure

| File | Responsibility |
|---|---|
| `cli/src/core/TopicKBTypes.ts` | `SourceType`, `SourceRef`, `ProcessedSet`, `TopicIndexEntry`, `TopicIndex`, `TopicPage` interfaces |
| `cli/src/core/ProcessedSourceStore.ts` | read/write `topics/processed.json`; pure `hasProcessed` / `addProcessed` helpers |
| `cli/src/core/TopicIndexStore.ts` | read/write `topics/index.json` |
| `cli/src/core/TopicPageStore.ts` | read/write/list `topics/<slug>.json` |
| `cli/src/core/SourceTimeline.ts` | pure `compareSourceRefs`; `collectAllSourceRefs` + `listPendingSources` |
| `cli/src/core/*.test.ts` | colocated Vitest specs (repo convention) |

**Verified codebase facts (do not re-guess):**
- `resolveStorage(storage?, cwd?)` from `./SummaryStore.js` returns the passed provider or the active one. `CompiledStore` is the exact template.
- `StorageProvider` required methods: `readFile(path) → Promise<string|null>`, `writeFiles(files: FileWrite[], message: string) → Promise<void>`, `listFiles(prefix) → Promise<string[]>`, `exists() → Promise<boolean>`, `ensure() → Promise<void>`. `FileWrite = { path: string; content: string }` (from `../Types.js`).
- `getIndex(cwd?, storage?)` from `./SummaryStore.js` → `{ entries: SummaryIndexEntry[] } | null`. `SummaryIndexEntry` has `commitHash`, `commitDate`, `branch`, `parentCommitHash: string|null|undefined` (null/undefined = root).
- `loadPlansRegistry(cwd?)` from `./SessionTracker.js` → `PlansRegistry { plans: Record<string,PlanEntry>; notes?: Record<string,NoteEntry> }`. `PlanEntry` = `{ slug, title, updatedAt, branch, ... }`. `NoteEntry` = `{ id, title, updatedAt, branch, ... }`.
- `listUserKnowledge(cwd, branch?)` from `./MemoryBankScanner.js` → `UserKnowledgeFile[]` with `{ path, fingerprint, mtime, scope, branch? }`. With a `branch` it returns global+repo+that-branch; without, only global+repo.
- `createReadStorage(cwd)` from `./ReadStorageResolver.js` → a `StorageProvider` for reads.
- **Timestamps carry timezone offsets** (git `commitDate`). Compare via `Date.parse()` epoch, NOT string order.

---

## Task 1: Topic KB types

**Files:**
- Create: `cli/src/core/TopicKBTypes.ts`

- [ ] **Step 1: Write the type declarations**

```typescript
/**
 * Topic KB — shared type declarations for the topic-centric knowledge base
 * (sub-project 1). Pure type module: no runtime behavior.
 */

/** The four source streams folded into the knowledge base. */
export type SourceType = "summary" | "plan" | "note" | "userfile";

/** A single ingestable source, identified stably and timestamped for ordering. */
export interface SourceRef {
	readonly type: SourceType;
	/** Stable identity: commit hash / plan slug / note id / `path@fingerprint`. */
	readonly id: string;
	/** ISO 8601; used for chronological ordering (parsed to epoch, may carry tz offset). */
	readonly timestamp: string;
}

/** High-water mark = the set of already-ingested source IDs, grouped by type. */
export interface ProcessedSet {
	readonly schemaVersion: 1;
	readonly processed: Record<SourceType, string[]>;
}

/** One entry in `topics/index.json`. Drives index-driven routing (sub-project 2). */
export interface TopicIndexEntry {
	readonly stableSlug: string;
	readonly title: string;
	readonly summary: string;
	readonly relatedBranches: string[];
	readonly sourceRefs: SourceRef[];
	readonly lastUpdatedAt: string;
}

/** `topics/index.json` shape. */
export interface TopicIndex {
	readonly schemaVersion: 1;
	readonly topics: TopicIndexEntry[];
}

/** Canonical topic page (`topics/<stableSlug>.json`). Content filled by sub-project 2. */
export interface TopicPage {
	readonly schemaVersion: 1;
	readonly stableSlug: string;
	readonly title: string;
	readonly content: string;
	readonly relatedBranches: string[];
	readonly sourceRefs: SourceRef[];
	readonly lastUpdatedAt: string;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:cli`
Expected: PASS (no new errors from this file). Pure type declarations have no runtime behavior to unit-test; downstream tasks exercise them.

- [ ] **Step 3: Commit**

```bash
git add cli/src/core/TopicKBTypes.ts
git commit -s -m "feat(topic-kb): add core data-model types"
```

---

## Task 2: ProcessedSourceStore

**Files:**
- Create: `cli/src/core/ProcessedSourceStore.ts`
- Test: `cli/src/core/ProcessedSourceStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import {
	addProcessed,
	emptyProcessedSet,
	hasProcessed,
	readProcessedSet,
	saveProcessedSet,
} from "./ProcessedSourceStore.js";
import type { SourceRef } from "./TopicKBTypes.js";

function makeFakeStorage(initial: Record<string, string> = {}): StorageProvider {
	const files = new Map(Object.entries(initial));
	return {
		readFile: async (p: string) => files.get(p) ?? null,
		writeFiles: async (fws: FileWrite[]) => {
			for (const f of fws) files.set(f.path, f.content);
		},
		listFiles: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
		exists: async () => true,
		ensure: async () => {},
	};
}

const ref = (type: SourceRef["type"], id: string): SourceRef => ({ type, id, timestamp: "2026-01-01T00:00:00Z" });

describe("ProcessedSourceStore", () => {
	it("returns an empty set when the file is absent", async () => {
		const set = await readProcessedSet("/tmp/x", makeFakeStorage());
		expect(set).toEqual(emptyProcessedSet());
	});

	it("hasProcessed reflects membership by type+id", () => {
		const set = addProcessed(emptyProcessedSet(), [ref("summary", "abc"), ref("plan", "p1")]);
		expect(hasProcessed(set, ref("summary", "abc"))).toBe(true);
		expect(hasProcessed(set, ref("plan", "p1"))).toBe(true);
		expect(hasProcessed(set, ref("summary", "p1"))).toBe(false); // same id, wrong type
		expect(hasProcessed(set, ref("note", "abc"))).toBe(false);
	});

	it("addProcessed is idempotent and immutable", () => {
		const base = emptyProcessedSet();
		const once = addProcessed(base, [ref("summary", "abc")]);
		const twice = addProcessed(once, [ref("summary", "abc")]);
		expect(twice.processed.summary).toEqual(["abc"]);
		expect(base.processed.summary).toEqual([]); // original untouched
	});

	it("round-trips through save/read", async () => {
		const storage = makeFakeStorage();
		const set = addProcessed(emptyProcessedSet(), [ref("userfile", "a.md@deadbeef")]);
		await saveProcessedSet(set, "/tmp/x", storage);
		const back = await readProcessedSet("/tmp/x", storage);
		expect(back).toEqual(set);
	});

	it("normalizes a partial on-disk shape to all four buckets", async () => {
		const storage = makeFakeStorage({
			"topics/processed.json": JSON.stringify({ schemaVersion: 1, processed: { summary: ["x"] } }),
		});
		const set = await readProcessedSet("/tmp/x", storage);
		expect(set.processed).toEqual({ summary: ["x"], plan: [], note: [], userfile: [] });
	});

	it("returns empty on unparseable JSON", async () => {
		const storage = makeFakeStorage({ "topics/processed.json": "{not json" });
		const set = await readProcessedSet("/tmp/x", storage);
		expect(set).toEqual(emptyProcessedSet());
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/ProcessedSourceStore.test.ts`
Expected: FAIL — cannot resolve `./ProcessedSourceStore.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * ProcessedSourceStore — the topic KB high-water mark, stored as the set of
 * already-ingested source IDs (NOT a timestamp). Decouples "has this source
 * been processed" from "what is its logical time" so out-of-order sources are
 * never skipped. Path: `topics/processed.json`, written via the active
 * StorageProvider (dual-write), mirroring CompiledStore.
 */

import { createLogger } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { resolveStorage } from "./SummaryStore.js";
import type { ProcessedSet, SourceRef, SourceType } from "./TopicKBTypes.js";

const log = createLogger("ProcessedSourceStore");
const PROCESSED_PATH = "topics/processed.json";

/** A fresh set with all four buckets present. */
export function emptyProcessedSet(): ProcessedSet {
	return { schemaVersion: 1, processed: { summary: [], plan: [], note: [], userfile: [] } };
}

/** Reads `topics/processed.json`; missing or unparseable → empty set (never throws). */
export async function readProcessedSet(cwd?: string, storage?: StorageProvider): Promise<ProcessedSet> {
	const resolved = resolveStorage(storage, cwd);
	const raw = await resolved.readFile(PROCESSED_PATH);
	if (!raw) return emptyProcessedSet();
	try {
		const parsed = JSON.parse(raw) as Partial<ProcessedSet>;
		const p = parsed.processed ?? {};
		return {
			schemaVersion: 1,
			processed: {
				summary: p.summary ?? [],
				plan: p.plan ?? [],
				note: p.note ?? [],
				userfile: p.userfile ?? [],
			},
		};
	} catch {
		log.warn("Failed to parse %s — treating as empty", PROCESSED_PATH);
		return emptyProcessedSet();
	}
}

/** True when `ref` (by type+id) is already in the set. */
export function hasProcessed(set: ProcessedSet, ref: SourceRef): boolean {
	return set.processed[ref.type].includes(ref.id);
}

/** Returns a new set with `refs` added (idempotent, does not mutate `set`). */
export function addProcessed(set: ProcessedSet, refs: ReadonlyArray<SourceRef>): ProcessedSet {
	const next: Record<SourceType, string[]> = {
		summary: [...set.processed.summary],
		plan: [...set.processed.plan],
		note: [...set.processed.note],
		userfile: [...set.processed.userfile],
	};
	for (const ref of refs) {
		if (!next[ref.type].includes(ref.id)) next[ref.type].push(ref.id);
	}
	return { schemaVersion: 1, processed: next };
}

/** Persists the set via the active StorageProvider. */
export async function saveProcessedSet(set: ProcessedSet, cwd?: string, storage?: StorageProvider): Promise<void> {
	const resolved = resolveStorage(storage, cwd);
	const files: FileWrite[] = [{ path: PROCESSED_PATH, content: JSON.stringify(set, null, "\t") }];
	await resolved.writeFiles(files, "Update topic KB processed-source set");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/ProcessedSourceStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/ProcessedSourceStore.ts cli/src/core/ProcessedSourceStore.test.ts
git commit -s -m "feat(topic-kb): add processed-source high-water-mark store"
```

---

## Task 3: TopicIndexStore

**Files:**
- Create: `cli/src/core/TopicIndexStore.ts`
- Test: `cli/src/core/TopicIndexStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { emptyTopicIndex, readTopicIndex, saveTopicIndex } from "./TopicIndexStore.js";
import type { TopicIndex } from "./TopicKBTypes.js";

function makeFakeStorage(initial: Record<string, string> = {}): StorageProvider {
	const files = new Map(Object.entries(initial));
	return {
		readFile: async (p: string) => files.get(p) ?? null,
		writeFiles: async (fws: FileWrite[]) => {
			for (const f of fws) files.set(f.path, f.content);
		},
		listFiles: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
		exists: async () => true,
		ensure: async () => {},
	};
}

const sampleIndex: TopicIndex = {
	schemaVersion: 1,
	topics: [
		{
			stableSlug: "auth-origin-allowlist",
			title: "Auth & origin allowlist",
			summary: "Origin allowlist validation.",
			relatedBranches: ["main"],
			sourceRefs: [{ type: "summary", id: "abc", timestamp: "2026-01-01T00:00:00Z" }],
			lastUpdatedAt: "2026-01-02T00:00:00Z",
		},
	],
};

describe("TopicIndexStore", () => {
	it("returns an empty index when the file is absent", async () => {
		const idx = await readTopicIndex("/tmp/x", makeFakeStorage());
		expect(idx).toEqual(emptyTopicIndex());
	});

	it("round-trips through save/read", async () => {
		const storage = makeFakeStorage();
		await saveTopicIndex(sampleIndex, "/tmp/x", storage);
		const back = await readTopicIndex("/tmp/x", storage);
		expect(back).toEqual(sampleIndex);
	});

	it("returns empty index on unparseable JSON", async () => {
		const storage = makeFakeStorage({ "topics/index.json": "nope" });
		const idx = await readTopicIndex("/tmp/x", storage);
		expect(idx).toEqual(emptyTopicIndex());
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/TopicIndexStore.test.ts`
Expected: FAIL — cannot resolve `./TopicIndexStore.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * TopicIndexStore — read/write `topics/index.json`, the routing index for the
 * topic KB. Persisted via the active StorageProvider (dual-write).
 */

import { createLogger } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { resolveStorage } from "./SummaryStore.js";
import type { TopicIndex } from "./TopicKBTypes.js";

const log = createLogger("TopicIndexStore");
const INDEX_PATH = "topics/index.json";

/** A fresh, empty index. */
export function emptyTopicIndex(): TopicIndex {
	return { schemaVersion: 1, topics: [] };
}

/** Reads `topics/index.json`; missing or unparseable → empty index (never throws). */
export async function readTopicIndex(cwd?: string, storage?: StorageProvider): Promise<TopicIndex> {
	const resolved = resolveStorage(storage, cwd);
	const raw = await resolved.readFile(INDEX_PATH);
	if (!raw) return emptyTopicIndex();
	try {
		const parsed = JSON.parse(raw) as TopicIndex;
		return { schemaVersion: 1, topics: parsed.topics ?? [] };
	} catch {
		log.warn("Failed to parse %s — treating as empty", INDEX_PATH);
		return emptyTopicIndex();
	}
}

/** Persists the index via the active StorageProvider. */
export async function saveTopicIndex(index: TopicIndex, cwd?: string, storage?: StorageProvider): Promise<void> {
	const resolved = resolveStorage(storage, cwd);
	const files: FileWrite[] = [{ path: INDEX_PATH, content: JSON.stringify(index, null, "\t") }];
	await resolved.writeFiles(files, `Update topic KB index (${index.topics.length} topics)`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/TopicIndexStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/TopicIndexStore.ts cli/src/core/TopicIndexStore.test.ts
git commit -s -m "feat(topic-kb): add topic index store"
```

---

## Task 4: TopicPageStore

**Files:**
- Create: `cli/src/core/TopicPageStore.ts`
- Test: `cli/src/core/TopicPageStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { listTopicPageSlugs, readTopicPage, saveTopicPage } from "./TopicPageStore.js";
import type { TopicPage } from "./TopicKBTypes.js";

function makeFakeStorage(initial: Record<string, string> = {}): StorageProvider {
	const files = new Map(Object.entries(initial));
	return {
		readFile: async (p: string) => files.get(p) ?? null,
		writeFiles: async (fws: FileWrite[]) => {
			for (const f of fws) files.set(f.path, f.content);
		},
		listFiles: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
		exists: async () => true,
		ensure: async () => {},
	};
}

const page: TopicPage = {
	schemaVersion: 1,
	stableSlug: "auth-origin-allowlist",
	title: "Auth & origin allowlist",
	content: "Body.",
	relatedBranches: ["main"],
	sourceRefs: [{ type: "summary", id: "abc", timestamp: "2026-01-01T00:00:00Z" }],
	lastUpdatedAt: "2026-01-02T00:00:00Z",
};

describe("TopicPageStore", () => {
	it("returns null for a missing page", async () => {
		expect(await readTopicPage("auth-origin-allowlist", "/tmp/x", makeFakeStorage())).toBeNull();
	});

	it("round-trips through save/read at topics/<slug>.json", async () => {
		const storage = makeFakeStorage();
		await saveTopicPage(page, "/tmp/x", storage);
		expect(await readTopicPage("auth-origin-allowlist", "/tmp/x", storage)).toEqual(page);
	});

	it("lists page slugs excluding index.json and processed.json", async () => {
		const storage = makeFakeStorage({
			"topics/index.json": "{}",
			"topics/processed.json": "{}",
			"topics/auth-origin-allowlist.json": "{}",
			"topics/storage-providers.json": "{}",
		});
		const slugs = await listTopicPageSlugs("/tmp/x", storage);
		expect(slugs.sort()).toEqual(["auth-origin-allowlist", "storage-providers"]);
	});

	it("returns null on unparseable page JSON", async () => {
		const storage = makeFakeStorage({ "topics/bad.json": "{nope" });
		expect(await readTopicPage("bad", "/tmp/x", storage)).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/TopicPageStore.test.ts`
Expected: FAIL — cannot resolve `./TopicPageStore.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * TopicPageStore — read/write/list canonical topic pages at
 * `topics/<stableSlug>.json`. Content is produced by sub-project 2; this module
 * only provides typed persistence. The rendered `_wiki/<slug>.md` layer is a
 * separate concern (FolderStorage / WikiMarkdownBuilder).
 */

import { createLogger } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { resolveStorage } from "./SummaryStore.js";
import type { TopicPage } from "./TopicKBTypes.js";

const log = createLogger("TopicPageStore");

/** Reserved file names under `topics/` that are NOT topic pages. */
const RESERVED = new Set(["index", "processed"]);

/** Reads a canonical topic page; missing or unparseable → null. */
export async function readTopicPage(
	slug: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<TopicPage | null> {
	const resolved = resolveStorage(storage, cwd);
	const raw = await resolved.readFile(`topics/${slug}.json`);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as TopicPage;
	} catch {
		log.warn("Failed to parse topic page %s", slug);
		return null;
	}
}

/** Persists a canonical topic page via the active StorageProvider. */
export async function saveTopicPage(page: TopicPage, cwd?: string, storage?: StorageProvider): Promise<void> {
	const resolved = resolveStorage(storage, cwd);
	const files: FileWrite[] = [
		{ path: `topics/${page.stableSlug}.json`, content: JSON.stringify(page, null, "\t") },
	];
	await resolved.writeFiles(files, `Update topic page ${page.stableSlug}`);
}

/** Lists all topic page slugs under `topics/`, excluding index.json / processed.json. */
export async function listTopicPageSlugs(cwd?: string, storage?: StorageProvider): Promise<ReadonlyArray<string>> {
	const resolved = resolveStorage(storage, cwd);
	const files = await resolved.listFiles("topics/");
	return files
		.filter((f) => f.startsWith("topics/") && f.endsWith(".json"))
		.map((f) => f.slice("topics/".length, -".json".length))
		.filter((slug) => slug.length > 0 && !slug.includes("/") && !RESERVED.has(slug));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/TopicPageStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/TopicPageStore.ts cli/src/core/TopicPageStore.test.ts
git commit -s -m "feat(topic-kb): add topic page store"
```

---

## Task 5: SourceTimeline — deterministic comparator

**Files:**
- Create: `cli/src/core/SourceTimeline.ts`
- Test: `cli/src/core/SourceTimeline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { compareSourceRefs } from "./SourceTimeline.js";
import type { SourceRef } from "./TopicKBTypes.js";

const r = (type: SourceRef["type"], id: string, timestamp: string): SourceRef => ({ type, id, timestamp });

describe("compareSourceRefs", () => {
	it("orders by epoch ascending, honoring timezone offsets", () => {
		// 2026-01-01T08:00:00+08:00 === 2026-01-01T00:00:00Z (same instant);
		// the +09:00 one is one hour EARLIER in epoch despite a later wall-clock string.
		const utc = r("summary", "a", "2026-01-01T00:00:00Z");
		const earlier = r("summary", "b", "2026-01-01T08:00:00+09:00"); // = 2025-12-31T23:00:00Z
		expect(compareSourceRefs(earlier, utc)).toBeLessThan(0);
		expect([utc, earlier].sort(compareSourceRefs).map((x) => x.id)).toEqual(["b", "a"]);
	});

	it("breaks equal-instant ties by type rank then id", () => {
		const t = "2026-01-01T00:00:00Z";
		const refs = [r("userfile", "z", t), r("summary", "b", t), r("summary", "a", t), r("note", "m", t)];
		expect(refs.sort(compareSourceRefs).map((x) => `${x.type}:${x.id}`)).toEqual([
			"summary:a",
			"summary:b",
			"note:m",
			"userfile:z",
		]);
	});

	it("sorts unparseable timestamps deterministically after valid ones", () => {
		const valid = r("summary", "a", "2026-01-01T00:00:00Z");
		const bad = r("summary", "b", "not-a-date");
		expect(compareSourceRefs(valid, bad)).toBeLessThan(0);
		expect(compareSourceRefs(bad, valid)).toBeGreaterThan(0);
		// two bad timestamps fall through to type/id tie-break
		const bad2 = r("plan", "a", "also-bad");
		expect(compareSourceRefs(bad, bad2)).toBeLessThan(0); // summary < plan
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceTimeline.test.ts`
Expected: FAIL — cannot resolve `./SourceTimeline.js` / `compareSourceRefs` undefined.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * SourceTimeline — turns the four heterogeneous source streams into one
 * deterministic, time-ordered list of not-yet-ingested SourceRefs. This is the
 * single source of truth for the time-fold's "old → new" ordering, so it is
 * isolated and pure-by-input: same disk snapshot + same processed set → same
 * ordered list.
 */

import type { SourceRef, SourceType } from "./TopicKBTypes.js";

/** Fixed tie-break rank for equal-instant sources (parent spec §3.2). */
const TYPE_RANK: Record<SourceType, number> = { summary: 0, plan: 1, note: 2, userfile: 3 };

/**
 * Total order over SourceRefs: epoch ascending, then (type rank, id) tie-break.
 * Timestamps are parsed to epoch (NOT compared as strings) so timezone offsets
 * order correctly. Unparseable timestamps sort after all valid ones, then fall
 * through to the deterministic type/id tie-break.
 */
export function compareSourceRefs(a: SourceRef, b: SourceRef): number {
	const ta = Date.parse(a.timestamp);
	const tb = Date.parse(b.timestamp);
	const av = Number.isNaN(ta) ? null : ta;
	const bv = Number.isNaN(tb) ? null : tb;
	if (av !== null && bv !== null && av !== bv) return av - bv;
	if (av === null && bv !== null) return 1; // NaN after valid
	if (bv === null && av !== null) return -1;
	if (a.type !== b.type) return TYPE_RANK[a.type] - TYPE_RANK[b.type];
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceTimeline.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/SourceTimeline.ts cli/src/core/SourceTimeline.test.ts
git commit -s -m "feat(topic-kb): add deterministic source-ref comparator"
```

---

## Task 6: SourceTimeline — collect & listPendingSources

**Files:**
- Modify: `cli/src/core/SourceTimeline.ts`
- Modify: `cli/src/core/SourceTimeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `cli/src/core/SourceTimeline.test.ts` (add the imports at the top of the file alongside the existing ones):

```typescript
import { beforeEach, vi } from "vitest";
import { listPendingSources } from "./SourceTimeline.js";
import { emptyProcessedSet, addProcessed } from "./ProcessedSourceStore.js";

vi.mock("./SummaryStore.js", () => ({
	// resolveStorage is referenced by stores but not by listPendingSources directly;
	// getIndex is what the timeline calls.
	getIndex: vi.fn(),
	resolveStorage: vi.fn(),
}));
vi.mock("./SessionTracker.js", () => ({ loadPlansRegistry: vi.fn() }));
vi.mock("./MemoryBankScanner.js", () => ({ listUserKnowledge: vi.fn() }));
vi.mock("./ReadStorageResolver.js", () => ({ createReadStorage: vi.fn(async () => ({})) }));

import { getIndex } from "./SummaryStore.js";
import { loadPlansRegistry } from "./SessionTracker.js";
import { listUserKnowledge } from "./MemoryBankScanner.js";

describe("listPendingSources", () => {
	beforeEach(() => {
		vi.mocked(getIndex).mockReset();
		vi.mocked(loadPlansRegistry).mockReset();
		vi.mocked(listUserKnowledge).mockReset();
	});

	it("merges all four streams, filters processed, sorts old→new", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{ commitHash: "c2", commitDate: "2026-01-03T00:00:00Z", branch: "main", parentCommitHash: null },
				{ commitHash: "c1", commitDate: "2026-01-01T00:00:00Z", branch: "main", parentCommitHash: null },
				// child entry (non-root) must be ignored:
				{ commitHash: "c1a", commitDate: "2026-01-01T01:00:00Z", branch: "main", parentCommitHash: "c1" },
			],
		// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		} as any);
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: { "claude:p1": { slug: "p1", title: "P", updatedAt: "2026-01-02T00:00:00Z", branch: "main", commitHash: null, addedAt: "x", sourcePath: "x" } },
			notes: { n1: { id: "n1", title: "N", format: "markdown", updatedAt: "2026-01-04T00:00:00Z", branch: "main", commitHash: null, addedAt: "x" } },
		// biome-ignore lint/suspicious/noExplicitAny: minimal registry stub for test
		} as any);
		vi.mocked(listUserKnowledge).mockResolvedValue([
			// biome-ignore lint/suspicious/noExplicitAny: minimal user-file stub for test
			{ path: "u.md", fingerprint: "ff", mtime: "2026-01-05T00:00:00Z", scope: "repo" } as any,
		]);

		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		expect(pending.map((p) => `${p.type}:${p.id}`)).toEqual([
			"summary:c1", // 01-01
			"plan:p1", // 01-02
			"summary:c2", // 01-03
			"note:n1", // 01-04
			"userfile:u.md@ff", // 01-05
		]);
	});

	it("excludes already-processed refs", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		vi.mocked(getIndex).mockResolvedValue({ entries: [{ commitHash: "c1", commitDate: "2026-01-01T00:00:00Z", branch: "main", parentCommitHash: null }] } as any);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		vi.mocked(listUserKnowledge).mockResolvedValue([]);

		const processed = addProcessed(emptyProcessedSet(), [{ type: "summary", id: "c1", timestamp: "2026-01-01T00:00:00Z" }]);
		const pending = await listPendingSources("/tmp/x", processed);
		expect(pending).toEqual([]);
	});

	it("dedupes user files seen across multiple branches by path@fingerprint", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{ commitHash: "c1", commitDate: "2026-01-01T00:00:00Z", branch: "main", parentCommitHash: null },
				{ commitHash: "c2", commitDate: "2026-01-02T00:00:00Z", branch: "feat", parentCommitHash: null },
			],
		// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		} as any);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		// global file "g.md@aa" is returned for BOTH branch calls → must dedupe to one
		// biome-ignore lint/suspicious/noExplicitAny: minimal user-file stub for test
		vi.mocked(listUserKnowledge).mockResolvedValue([{ path: "g.md", fingerprint: "aa", mtime: "2026-01-03T00:00:00Z", scope: "global" } as any]);

		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		const userFiles = pending.filter((p) => p.type === "userfile");
		expect(userFiles).toEqual([{ type: "userfile", id: "g.md@aa", timestamp: "2026-01-03T00:00:00Z" }]);
		// listUserKnowledge was called once per distinct branch
		expect(vi.mocked(listUserKnowledge).mock.calls.length).toBe(2);
	});

	it("handles a missing index (null) without throwing", async () => {
		vi.mocked(getIndex).mockResolvedValue(null);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		vi.mocked(listUserKnowledge).mockResolvedValue([]);
		// No branches in index → one global/repo scan (branch undefined).
		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		expect(pending).toEqual([]);
		expect(vi.mocked(listUserKnowledge).mock.calls.length).toBe(1);
		expect(vi.mocked(listUserKnowledge).mock.calls[0][1]).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceTimeline.test.ts`
Expected: FAIL — `listPendingSources` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add these imports at the top of `cli/src/core/SourceTimeline.ts` (below the existing type import):

```typescript
import { listUserKnowledge } from "./MemoryBankScanner.js";
import { hasProcessed } from "./ProcessedSourceStore.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { loadPlansRegistry } from "./SessionTracker.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getIndex } from "./SummaryStore.js";
import type { ProcessedSet } from "./TopicKBTypes.js";
```

Append to `cli/src/core/SourceTimeline.ts`:

```typescript
/**
 * Enumerates every source across the four streams as SourceRefs. Root commit
 * summaries only (parentCommitHash null/undefined) — matching the existing
 * compile input contract. User files are scanned once per distinct branch (so
 * branch-scoped files are not silently dropped) plus once for global/repo when
 * the index is empty, then deduped by `path@fingerprint`.
 */
export async function collectAllSourceRefs(cwd: string, storage?: StorageProvider): Promise<SourceRef[]> {
	const readStorage = storage ?? (await createReadStorage(cwd));
	const refs: SourceRef[] = [];

	const index = await getIndex(cwd, readStorage);
	if (index) {
		for (const e of index.entries) {
			if (e.parentCommitHash === null || e.parentCommitHash === undefined) {
				refs.push({ type: "summary", id: e.commitHash, timestamp: e.commitDate });
			}
		}
	}

	const registry = await loadPlansRegistry(cwd);
	for (const p of Object.values(registry.plans)) {
		refs.push({ type: "plan", id: p.slug, timestamp: p.updatedAt });
	}
	for (const n of Object.values(registry.notes ?? {})) {
		refs.push({ type: "note", id: n.id, timestamp: n.updatedAt });
	}

	const branches = index ? [...new Set(index.entries.map((e) => e.branch))] : [];
	const branchList: Array<string | undefined> = branches.length > 0 ? branches : [undefined];
	const seenUserFiles = new Set<string>();
	for (const branch of branchList) {
		const files = await listUserKnowledge(cwd, branch);
		for (const f of files) {
			const id = `${f.path}@${f.fingerprint}`;
			if (seenUserFiles.has(id)) continue;
			seenUserFiles.add(id);
			refs.push({ type: "userfile", id, timestamp: f.mtime });
		}
	}

	return refs;
}

/**
 * Returns all not-yet-ingested sources sorted old → new. Deterministic for a
 * given disk snapshot + processed set — the single source of truth for the
 * time-fold ordering.
 */
export async function listPendingSources(
	cwd: string,
	processed: ProcessedSet,
	storage?: StorageProvider,
): Promise<ReadonlyArray<SourceRef>> {
	const all = await collectAllSourceRefs(cwd, storage);
	return all.filter((r) => !hasProcessed(processed, r)).sort(compareSourceRefs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceTimeline.test.ts`
Expected: PASS (all comparator + listPendingSources tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/SourceTimeline.ts cli/src/core/SourceTimeline.test.ts
git commit -s -m "feat(topic-kb): add unified source timeline iterator"
```

---

## Task 7: Full gate

- [ ] **Step 1: Run the full chain**

Run: `npm run all`
Expected: clean → build → lint → test all PASS. Coverage stays above the CLI floor (97% stmt / 96% br / 97% fn / 97% line); the new modules are small and fully covered by Tasks 2–6.

- [ ] **Step 2: If lint flags formatting**

Run: `npm run lint:fix` then re-run `npm run all`. Re-commit any formatting-only changes:

```bash
git add -A
git commit -s -m "style(topic-kb): biome formatting"
```

---

## Self-review notes

- **Spec coverage:** `SourceRef`/`ProcessedSet`/topic index/page schemas → Task 1; processed-ID set store → Task 2; topic index store → Task 3; topic page store → Task 4; deterministic ordering → Task 5; unified iterator (`listPendingSources`) + per-type mappers + dedupe → Task 6. All §3–§4 deliverables mapped. §7 test list covered by Tasks 2–6 (out-of-order, tie-break, processed-filter, empty, userfile-mtime-drives-position via the merge test, mixed-type interleaving).
- **Signature refinement vs spec:** spec wrote `listPendingSources(storage, processed)`; the real dependencies (`getIndex`/`loadPlansRegistry`/`listUserKnowledge`) need `cwd`, so the implemented signature is `listPendingSources(cwd, processed, storage?)`. Determinism property is unchanged. (Carry this note back into the spec if it is revised.)
- **Timestamp comparison:** spec §3.2 says "timestamp ascending"; implemented via `Date.parse` epoch (not string order) because git `commitDate` carries timezone offsets. Documented in code + Task 5 regression test.
- **No silent source drop:** user files are scanned per-distinct-branch and deduped, so branch-scoped Memory Bank files are included (not just global/repo) — honoring the project "no silent caps" principle.
- **Type consistency:** `ProcessedSet`, `SourceRef`, `TopicIndex`, `TopicPage` names + fields are used identically across Tasks 1–6. Store function naming is uniform (`read*`/`save*`/`empty*`/`list*`).
