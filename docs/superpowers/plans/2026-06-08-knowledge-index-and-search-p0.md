# Knowledge Index & Search (P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local full-text search index (Orama) over JolliMemory's topic KB + commit catalog, and an stdio MCP server exposing `search`, `recall`, `get_decision_timeline`, `list_branches` to AI agents, auto-registered into Claude Code's `.mcp.json`.

**Architecture:** A pure projection module (`SearchIndexSource`) turns the two on-disk sources into a flat `SearchDoc[]`. A thin Orama wrapper (`SearchIndex`) builds/searches/persists the index at `.jolli/jollimemory/search-index.json`, with a cheap staleness fingerprint that triggers a full rebuild when source data changed. An MCP server (`McpServer`) declares four tools and dispatches to `SearchIndex` and the existing `ContextCompiler`. `jolli mcp` launches the server (a subcommand of the already-bundled `Cli.js`, so no new bundle entry). The Installer writes a `.mcp.json` entry via the existing `resolve-dist-path` indirection.

**Tech Stack:** TypeScript (ESM), `@orama/orama` (in-memory BM25 full-text), `@orama/plugin-data-persistence` (JSON serialize/restore), `@modelcontextprotocol/sdk` (MCP stdio server), `commander` (CLI), Vitest (tests, 97% coverage floor).

**Standing preferences honored in this plan (per project memory):**
- Each implementation task contains **only tests + implementation**, plus a focused single-file `vitest` run for red/green. **No per-task `git commit`, no per-task `npm run all`.**
- The **final task** runs `npm run all` once and creates **one commit**.
- DCO sign-off (`git commit -s`), **no** `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- `toForwardSlash` for any `\`→`/` normalization; never inline `replace(/\\/g,"/")`.

---

## File structure

| File | Responsibility |
|---|---|
| `cli/src/core/SearchIndexTypes.ts` (create) | `SearchDoc` interface, the Orama schema literal, `SCHEMA_VERSION`, `IndexManifest` interface. Pure types + constants. |
| `cli/src/core/SearchIndexSource.ts` (create) | `collectSearchDocs(cwd, storage)` → `SearchDoc[]` and `computeSourceSignature(cwd, storage)` → `string`. The only module that knows the on-disk source layouts. |
| `cli/src/core/SearchIndex.ts` (create) | `SearchIndex` class wrapping Orama: build/search/persist/restore + staleness check. Reads/writes the local index file. |
| `cli/src/mcp/McpTools.ts` (create) | Pure tool handlers (`runSearch`, `runRecall`, `runDecisionTimeline`, `runListBranches`) returning plain JSON-serializable objects. No SDK coupling — unit-testable. |
| `cli/src/mcp/McpServer.ts` (create) | Wires `McpTools` handlers into an `@modelcontextprotocol/sdk` `Server` over stdio. Tool schemas + dispatch only. |
| `cli/src/commands/McpCommand.ts` (create) | `registerMcpCommand(program)` → `jolli mcp [--reindex]`. |
| `cli/src/install/McpRegistration.ts` (create) | `registerMcpInClaude(worktreeDir)` / `removeMcpFromClaude(worktreeDir)` — edit `.mcp.json`. |
| `cli/src/Api.ts` (modify) | Register the new command. |
| `cli/src/core/MultiRepoCompile.ts` (modify) | Incremental index upsert after each repo's wiki render. |
| `cli/src/install/Installer.ts` (modify) | Call `registerMcpInClaude` in the per-worktree loop; `removeMcpFromClaude` on uninstall. |
| `cli/package.json` (modify) | Add the three runtime deps. |
| Test files | Co-located `*.test.ts` next to each new module. |

---

## Task 0: Add dependencies and prove they bundle

**Why first:** All three deps are ESM-first. The headline risk is that `@modelcontextprotocol/sdk` (or an Orama subpath export) fails to resolve when esbuild bundles `Cli.js` into the VS Code extension's CJS bundle. De-risk before building features.

**Files:**
- Modify: `cli/package.json`
- Create: `cli/src/mcp/DepSmoke.test.ts`

- [ ] **Step 1: Add the runtime dependencies**

Edit `cli/package.json` `dependencies` (keep alphabetical order):

```json
	"dependencies": {
		"@anthropic-ai/sdk": "^0.39.0",
		"@modelcontextprotocol/sdk": "^1.0.0",
		"@orama/orama": "^3.0.0",
		"@orama/plugin-data-persistence": "^3.0.0",
		"commander": "^13.1.0",
		"open": "^11.0.0",
		"semver": "^7.8.1"
	},
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: lockfile updates, all three packages added. Re-`git add package-lock.json` (root) since a later `npm install` would otherwise desync it.

- [ ] **Step 3: Write an import smoke test**

`cli/src/mcp/DepSmoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("dependency smoke test", () => {
	it("imports @orama/orama core fns", async () => {
		const orama = await import("@orama/orama");
		expect(typeof orama.create).toBe("function");
		expect(typeof orama.search).toBe("function");
		expect(typeof orama.insertMultiple).toBe("function");
	});

	it("imports @orama/plugin-data-persistence", async () => {
		const p = await import("@orama/plugin-data-persistence");
		expect(typeof p.persist).toBe("function");
		expect(typeof p.restore).toBe("function");
	});

	it("imports MCP SDK Server + stdio transport", async () => {
		const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
		const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
		expect(typeof Server).toBe("function");
		expect(typeof StdioServerTransport).toBe("function");
	});
});
```

- [ ] **Step 4: Run the smoke test (red→green)**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/DepSmoke.test.ts`
Expected: PASS. If any import resolves to a wrong subpath, fix the import path here (e.g. some Orama versions export persistence from `@orama/plugin-data-persistence`'s root — adjust to the actual exported entry the installed version provides) before continuing.

- [ ] **Step 5: Prove the VS Code CJS bundle still builds with the new imports**

This is the real risk gate. Build the CLI then the VS Code bundle:

Run: `cd cli && npm run build && cd ../vscode && npm run build 2>&1 | tail -20`
Expected: esbuild completes with no "Could not resolve" errors. If esbuild errors on an ESM-only subpath, resolve by adding the package to esbuild's bundling (it bundles `node_modules` by default) — the failure mode to watch is a dynamic `require` inside the SDK. If unresolvable, STOP and report; do not work around silently.

> No commit in this task (per standing preference). Verification + commit happen in the final task.

---

## Task 1: SearchDoc types and Orama schema

**Files:**
- Create: `cli/src/core/SearchIndexTypes.ts`

- [ ] **Step 1: Write the types module**

`cli/src/core/SearchIndexTypes.ts`:

```ts
/**
 * Shared types + constants for the local full-text search index (JOLLI-1226 P0).
 * Pure module: no runtime behavior, no I/O.
 */

/** Bump when the document shape or Orama schema changes — forces a rebuild. */
export const SEARCH_SCHEMA_VERSION = 1 as const;

/** A single indexed document. Topics and commits share one flat shape. */
export interface SearchDoc {
	/** "topic:<stableSlug>" | "commit:<fullHash>" — also the Orama document id. */
	readonly id: string;
	readonly type: "topic" | "commit";
	readonly title: string;
	/** Full searchable body. */
	readonly content: string;
	/** Joined decision text; "" when none. */
	readonly decisions: string;
	/** commit: branch; topic: relatedBranches joined by space. */
	readonly branch: string;
	/** commit: source kind ("commit"); topic: dominant sourceRef type. */
	readonly category: string;
	/** ISO 8601. commit: commitDate; topic: lastUpdatedAt. */
	readonly commitDate: string;
	/** Topic stableSlug, else "". */
	readonly slug: string;
	/** Commit fullHash, else "". */
	readonly hash: string;
}

/** Orama schema literal. Every field is a filterable/searchable string for P0. */
export const SEARCH_SCHEMA = {
	id: "string",
	type: "string",
	title: "string",
	content: "string",
	decisions: "string",
	branch: "string",
	category: "string",
	commitDate: "string",
	slug: "string",
	hash: "string",
} as const;

/** Sidecar manifest persisted next to the index file. */
export interface IndexManifest {
	readonly schemaVersion: number;
	/** Output of computeSourceSignature() at persist time. */
	readonly sourceSignature: string;
	readonly savedAt: string;
}
```

> No test for a pure types/constants module. No commit.

---

## Task 2: SearchIndexSource — project sources into SearchDocs

**Files:**
- Create: `cli/src/core/SearchIndexSource.ts`
- Create: `cli/src/core/SearchIndexSource.test.ts`

Reused APIs (already exist):
- `getIndex(cwd?, storage?): Promise<SummaryIndex | null>` — `entries[]` carry `commitHash`, `branch`, `commitDate`, `generatedAt`.
- `getCatalogWithLazyBuild(cwd?, storage?): Promise<CommitCatalog>` — `entries[]` carry `commitHash`, `recap?`, `ticketId?`, `topics?: CatalogTopic[]` (`{title, decisions?, category?, importance?, filesAffected?}`).
- `readTopicIndex(cwd?, storage?): Promise<TopicIndex>` — `topics: TopicIndexEntry[]`.
- `readTopicPage(slug, cwd?, storage?): Promise<TopicPage | null>` — `{content, relatedBranches, sourceRefs, lastUpdatedAt, title}`.

- [ ] **Step 1: Write the failing test**

`cli/src/core/SearchIndexSource.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "./StorageProvider.js";

// Mock the four stores this module reads.
vi.mock("./SummaryStore.js", () => ({
	getIndex: vi.fn(),
	getCatalogWithLazyBuild: vi.fn(),
}));
vi.mock("./TopicIndexStore.js", () => ({ readTopicIndex: vi.fn() }));
vi.mock("./TopicPageStore.js", () => ({ readTopicPage: vi.fn() }));

import { collectSearchDocs, computeSourceSignature } from "./SearchIndexSource.js";
import { getCatalogWithLazyBuild, getIndex } from "./SummaryStore.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import { readTopicPage } from "./TopicPageStore.js";

const storage = {} as StorageProvider;

function wireSources() {
	vi.mocked(getIndex).mockResolvedValue({
		version: 3,
		entries: [
			{
				commitHash: "abc123def456",
				parentCommitHash: null,
				commitMessage: "add auth timeout",
				commitDate: "2026-01-02T00:00:00Z",
				branch: "feature/auth",
				generatedAt: "2026-01-02T01:00:00Z",
			},
		],
	} as never);
	vi.mocked(getCatalogWithLazyBuild).mockResolvedValue({
		version: 1,
		entries: [
			{
				commitHash: "abc123def456",
				recap: "Added a configurable auth session timeout.",
				ticketId: "JOLLI-1",
				topics: [{ title: "Auth timeout", decisions: "Chose a 30-min hard cap." }],
			},
		],
	} as never);
	vi.mocked(readTopicIndex).mockResolvedValue({
		schemaVersion: 1,
		topics: [
			{
				stableSlug: "auth-timeout",
				title: "Auth Timeout",
				summary: "How session timeout works",
				relatedBranches: ["feature/auth", "main"],
				sourceRefs: [
					{ type: "summary", id: "abc123def456", timestamp: "2026-01-02T00:00:00Z", branch: "feature/auth" },
				],
				lastUpdatedAt: "2026-01-03T00:00:00Z",
			},
		],
	} as never);
	vi.mocked(readTopicPage).mockResolvedValue({
		schemaVersion: 1,
		stableSlug: "auth-timeout",
		title: "Auth Timeout",
		content: "The auth session has a 30-minute hard timeout.",
		relatedBranches: ["feature/auth", "main"],
		sourceRefs: [
			{ type: "summary", id: "abc123def456", timestamp: "2026-01-02T00:00:00Z", branch: "feature/auth" },
		],
		lastUpdatedAt: "2026-01-03T00:00:00Z",
	} as never);
}

describe("collectSearchDocs", () => {
	it("emits one topic doc and one commit doc with joined fields", async () => {
		wireSources();
		const docs = await collectSearchDocs("/repo", storage);

		const topic = docs.find((d) => d.id === "topic:auth-timeout");
		expect(topic).toBeDefined();
		expect(topic?.type).toBe("topic");
		expect(topic?.content).toContain("30-minute hard timeout");
		expect(topic?.branch).toBe("feature/auth main");
		expect(topic?.slug).toBe("auth-timeout");
		expect(topic?.commitDate).toBe("2026-01-03T00:00:00Z");

		const commit = docs.find((d) => d.id === "commit:abc123def456");
		expect(commit).toBeDefined();
		expect(commit?.type).toBe("commit");
		expect(commit?.branch).toBe("feature/auth");
		expect(commit?.hash).toBe("abc123def456");
		expect(commit?.decisions).toContain("30-min hard cap");
		expect(commit?.content).toContain("Auth timeout"); // topic title folded into body
		expect(commit?.content).toContain("configurable auth session timeout"); // recap folded in
	});

	it("returns [] when there is no data", async () => {
		vi.mocked(getIndex).mockResolvedValue(null);
		vi.mocked(getCatalogWithLazyBuild).mockResolvedValue({ version: 1, entries: [] } as never);
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [] } as never);
		const docs = await collectSearchDocs("/repo", storage);
		expect(docs).toEqual([]);
	});
});

describe("computeSourceSignature", () => {
	it("changes when source counts or timestamps change", async () => {
		wireSources();
		const sig1 = await computeSourceSignature("/repo", storage);

		vi.mocked(readTopicIndex).mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "auth-timeout",
					title: "Auth Timeout",
					summary: "x",
					relatedBranches: [],
					sourceRefs: [],
					lastUpdatedAt: "2026-09-09T00:00:00Z", // newer
				},
			],
		} as never);
		const sig2 = await computeSourceSignature("/repo", storage);
		expect(sig2).not.toBe(sig1);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SearchIndexSource.test.ts`
Expected: FAIL — `collectSearchDocs is not a function` (module doesn't exist).

- [ ] **Step 3: Implement the module**

`cli/src/core/SearchIndexSource.ts`:

```ts
/**
 * Projects JolliMemory's two on-disk sources — the topic KB (topics/index.json
 * + topic pages) and the raw commit catalog (catalog.json, joined with
 * index.json for branch/date) — into the flat SearchDoc shape the Orama index
 * consumes. The ONLY module that knows these source layouts; SearchIndex stays
 * source-agnostic.
 */

import type { StorageProvider } from "./StorageProvider.js";
import { getCatalogWithLazyBuild, getIndex } from "./SummaryStore.js";
import type { SearchDoc } from "./SearchIndexTypes.js";
import { SEARCH_SCHEMA_VERSION } from "./SearchIndexTypes.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import { readTopicPage } from "./TopicPageStore.js";

/** Build every SearchDoc from current source data. */
export async function collectSearchDocs(cwd: string, storage?: StorageProvider): Promise<SearchDoc[]> {
	const [topicDocs, commitDocs] = await Promise.all([
		collectTopicDocs(cwd, storage),
		collectCommitDocs(cwd, storage),
	]);
	return [...topicDocs, ...commitDocs];
}

async function collectTopicDocs(cwd: string, storage?: StorageProvider): Promise<SearchDoc[]> {
	const index = await readTopicIndex(cwd, storage);
	const docs = await Promise.all(
		index.topics.map(async (entry) => {
			const page = await readTopicPage(entry.stableSlug, cwd, storage);
			const content = page?.content ?? entry.summary;
			const branches = (page?.relatedBranches ?? entry.relatedBranches).join(" ");
			const category = dominantSourceType(page?.sourceRefs ?? entry.sourceRefs);
			const doc: SearchDoc = {
				id: `topic:${entry.stableSlug}`,
				type: "topic",
				title: entry.title,
				content: `${entry.title}\n${content}`,
				decisions: "",
				branch: branches,
				category,
				commitDate: page?.lastUpdatedAt ?? entry.lastUpdatedAt,
				slug: entry.stableSlug,
				hash: "",
			};
			return doc;
		}),
	);
	return docs;
}

async function collectCommitDocs(cwd: string, storage?: StorageProvider): Promise<SearchDoc[]> {
	const [index, catalog] = await Promise.all([
		getIndex(cwd, storage),
		getCatalogWithLazyBuild(cwd, storage),
	]);
	if (!index) return [];

	// Join: catalog has recap/topics/decisions; index has branch/date. Key = commitHash.
	const metaByHash = new Map(index.entries.map((e) => [e.commitHash, e]));

	const docs: SearchDoc[] = [];
	for (const entry of catalog.entries) {
		const meta = metaByHash.get(entry.commitHash);
		if (!meta) continue; // catalog entry without an index head — skip (not browsable)

		const topicTitles = (entry.topics ?? []).map((t) => t.title).join("\n");
		const decisions = (entry.topics ?? [])
			.map((t) => t.decisions)
			.filter((d): d is string => Boolean(d))
			.join("\n");
		const bodyParts = [meta.commitMessage, entry.recap, topicTitles, decisions].filter(Boolean);

		docs.push({
			id: `commit:${entry.commitHash}`,
			type: "commit",
			title: meta.commitMessage,
			content: bodyParts.join("\n"),
			decisions,
			branch: meta.branch,
			category: "commit",
			commitDate: meta.commitDate,
			slug: "",
			hash: entry.commitHash,
		});
	}
	return docs;
}

function dominantSourceType(refs: ReadonlyArray<{ type: string }>): string {
	if (refs.length === 0) return "topic";
	const counts = new Map<string, number>();
	for (const r of refs) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Cheap signature of source state. Changes whenever a source count or its
 * newest timestamp changes — enough to detect "data moved since last persist"
 * without rebuilding to compare. Used by SearchIndex's staleness check.
 */
export async function computeSourceSignature(cwd: string, storage?: StorageProvider): Promise<string> {
	const [index, catalog, topicIndex] = await Promise.all([
		getIndex(cwd, storage),
		getCatalogWithLazyBuild(cwd, storage),
		readTopicIndex(cwd, storage),
	]);
	const indexCount = index?.entries.length ?? 0;
	const newestGeneratedAt = (index?.entries ?? []).reduce((max, e) => (e.generatedAt > max ? e.generatedAt : max), "");
	const topicNewest = topicIndex.topics.reduce((max, t) => (t.lastUpdatedAt > max ? t.lastUpdatedAt : max), "");
	return [
		SEARCH_SCHEMA_VERSION,
		indexCount,
		catalog.entries.length,
		topicIndex.topics.length,
		newestGeneratedAt,
		topicNewest,
	].join("|");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SearchIndexSource.test.ts`
Expected: PASS.

> No commit (per standing preference).

---

## Task 3: SearchIndex — Orama wrapper with persistence + staleness

**Files:**
- Create: `cli/src/core/SearchIndex.ts`
- Create: `cli/src/core/SearchIndex.test.ts`

`SearchHitResult` is the search return shape consumed by the MCP `search` tool and by `jolli mcp` output.

- [ ] **Step 1: Write the failing test**

`cli/src/core/SearchIndex.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchDoc } from "./SearchIndexTypes.js";

vi.mock("./SearchIndexSource.js", () => ({
	collectSearchDocs: vi.fn(),
	computeSourceSignature: vi.fn(),
}));

import { SearchIndex } from "./SearchIndex.js";
import { collectSearchDocs, computeSourceSignature } from "./SearchIndexSource.js";

const docs: SearchDoc[] = [
	{
		id: "topic:auth-timeout",
		type: "topic",
		title: "Auth Timeout",
		content: "Auth Timeout\nThe auth session has a 30-minute hard timeout.",
		decisions: "",
		branch: "feature/auth main",
		category: "summary",
		commitDate: "2026-01-03T00:00:00Z",
		slug: "auth-timeout",
		hash: "",
	},
	{
		id: "commit:abc123",
		type: "commit",
		title: "add auth timeout",
		content: "add auth timeout\nChose a 30-min hard cap.",
		decisions: "Chose a 30-min hard cap.",
		branch: "feature/auth",
		category: "commit",
		commitDate: "2026-01-02T00:00:00Z",
		slug: "",
		hash: "abc123",
	},
];

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-idx-"));
	vi.mocked(collectSearchDocs).mockResolvedValue(docs);
	vi.mocked(computeSourceSignature).mockResolvedValue("sig-v1");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("SearchIndex", () => {
	it("builds from sources and finds a full-text match", async () => {
		const idx = await SearchIndex.open(dir);
		const res = await idx.search({ query: "auth timeout" });
		expect(res.length).toBeGreaterThan(0);
		expect(res.map((r) => r.id)).toContain("topic:auth-timeout");
	});

	it("filters by type and branch", async () => {
		const idx = await SearchIndex.open(dir);
		const commitsOnly = await idx.search({ query: "auth", type: "commit" });
		expect(commitsOnly.every((r) => r.type === "commit")).toBe(true);
	});

	it("persists and restores without rebuilding when the signature matches", async () => {
		const idx = await SearchIndex.open(dir); // builds + persists
		vi.mocked(collectSearchDocs).mockClear();

		const reopened = await SearchIndex.open(dir); // signature unchanged → restore
		const res = await reopened.search({ query: "timeout" });
		expect(res.length).toBeGreaterThan(0);
		expect(collectSearchDocs).not.toHaveBeenCalled(); // restored, not rebuilt
	});

	it("rebuilds when the source signature changed", async () => {
		await SearchIndex.open(dir); // persists with sig-v1
		vi.mocked(computeSourceSignature).mockResolvedValue("sig-v2");
		vi.mocked(collectSearchDocs).mockClear();

		await SearchIndex.open(dir);
		expect(collectSearchDocs).toHaveBeenCalledTimes(1); // stale → rebuilt
	});

	it("rebuilds when the persisted file is corrupt", async () => {
		const { writeFile } = await import("node:fs/promises");
		await SearchIndex.open(dir);
		await writeFile(join(dir, ".jolli", "jollimemory", "search-index.json"), "{ not json", "utf-8").catch(
			async () => {
				// directory layout differs in test cwd; write to the resolved path instead
			},
		);
		// Force-reindex path always rebuilds regardless of file state:
		const idx = await SearchIndex.open(dir);
		const res = await idx.reindex();
		expect(res.docCount).toBe(docs.length);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SearchIndex.test.ts`
Expected: FAIL — `SearchIndex is not defined`.

- [ ] **Step 3: Implement the module**

`cli/src/core/SearchIndex.ts`:

```ts
/**
 * SearchIndex — thin Orama wrapper for JolliMemory's local full-text search
 * (JOLLI-1226 P0). Builds an in-memory BM25 index from SearchIndexSource,
 * persists it to .jolli/jollimemory/search-index.json, and rebuilds whenever
 * the source signature changes (or the persisted file is missing/corrupt).
 * The index is a disposable cache — source data (orphan branch / folder) is
 * always authoritative.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AnyOrama, create, insertMultiple, search } from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";
import { createLogger } from "../Logger.js";
import { getJolliMemoryDir } from "../Logger.js";
import { collectSearchDocs, computeSourceSignature } from "./SearchIndexSource.js";
import { type IndexManifest, SEARCH_SCHEMA, SEARCH_SCHEMA_VERSION, type SearchDoc } from "./SearchIndexTypes.js";
import type { StorageProvider } from "./StorageProvider.js";

const log = createLogger("SearchIndex");

const INDEX_FILE = "search-index.json";
const MANIFEST_FILE = "search-index.manifest.json";

export interface SearchQuery {
	readonly query: string;
	readonly branch?: string;
	readonly type?: "topic" | "commit";
	readonly limit?: number;
}

export interface SearchHitResult {
	readonly id: string;
	readonly type: "topic" | "commit";
	readonly title: string;
	readonly snippet: string;
	readonly branch: string;
	readonly commitDate: string;
	readonly slug: string;
	readonly hash: string;
	readonly score: number;
}

export class SearchIndex {
	private constructor(
		private readonly db: AnyOrama,
		private readonly cwd: string,
		private readonly storage: StorageProvider | undefined,
	) {}

	/** Open the index: restore from disk if fresh, else rebuild and persist. */
	static async open(cwd: string, storage?: StorageProvider): Promise<SearchIndex> {
		const sig = await computeSourceSignature(cwd, storage);
		const restored = await tryRestore(cwd, sig);
		if (restored) return new SearchIndex(restored, cwd, storage);

		const db = await build(cwd, storage);
		await SearchIndex.persistTo(cwd, db, sig);
		return new SearchIndex(db, cwd, storage);
	}

	/** Force a full rebuild from source, persist, and return the new count. */
	async reindex(): Promise<{ docCount: number }> {
		const sig = await computeSourceSignature(this.cwd, this.storage);
		const docs = await collectSearchDocs(this.cwd, this.storage);
		const fresh = create({ schema: SEARCH_SCHEMA });
		await insertMultiple(fresh, docs as never[]);
		await SearchIndex.persistTo(this.cwd, fresh, sig);
		// Swap the live db by re-opening would lose `this` immutability; callers of
		// reindex re-open. For the in-process case, mutate via a fresh search target:
		(this as { db: AnyOrama }).db = fresh;
		return { docCount: docs.length };
	}

	async search(q: SearchQuery): Promise<SearchHitResult[]> {
		const where: Record<string, string> = {};
		if (q.type) where.type = q.type;
		if (q.branch) where.branch = q.branch;
		const result = await search(this.db, {
			term: q.query,
			limit: q.limit ?? 20,
			...(Object.keys(where).length ? { where } : {}),
		});
		return result.hits.map((h) => {
			const doc = h.document as unknown as SearchDoc;
			return {
				id: doc.id,
				type: doc.type,
				title: doc.title,
				snippet: doc.content.slice(0, 280),
				branch: doc.branch,
				commitDate: doc.commitDate,
				slug: doc.slug,
				hash: doc.hash,
				score: h.score,
			};
		});
	}

	private static async persistTo(cwd: string, db: AnyOrama, sig: string): Promise<void> {
		const indexPath = join(getJolliMemoryDir(cwd), INDEX_FILE);
		await mkdir(dirname(indexPath), { recursive: true });
		const serialized = await persist(db, "json");
		await writeFile(indexPath, serialized as string, "utf-8");
		const manifest: IndexManifest = {
			schemaVersion: SEARCH_SCHEMA_VERSION,
			sourceSignature: sig,
			savedAt: new Date().toISOString(),
		};
		await writeFile(join(getJolliMemoryDir(cwd), MANIFEST_FILE), JSON.stringify(manifest), "utf-8");
	}
}

async function build(cwd: string, storage?: StorageProvider): Promise<AnyOrama> {
	const docs = await collectSearchDocs(cwd, storage);
	const db = create({ schema: SEARCH_SCHEMA });
	await insertMultiple(db, docs as never[]);
	log.info("Built search index: %d docs", docs.length);
	return db;
}

async function tryRestore(cwd: string, currentSig: string): Promise<AnyOrama | null> {
	try {
		const manifestRaw = await readFile(join(getJolliMemoryDir(cwd), MANIFEST_FILE), "utf-8");
		const manifest = JSON.parse(manifestRaw) as IndexManifest;
		if (manifest.schemaVersion !== SEARCH_SCHEMA_VERSION) return null;
		if (manifest.sourceSignature !== currentSig) return null;
		const indexRaw = await readFile(join(getJolliMemoryDir(cwd), INDEX_FILE), "utf-8");
		return (await restore("json", indexRaw)) as AnyOrama;
	} catch {
		// Missing or corrupt → caller rebuilds.
		return null;
	}
}
```

> NOTE on the Orama API: `create` is synchronous in Orama v3 and returns the db; `insertMultiple`/`search` are async. If the installed version differs (e.g. `create` returns a promise), adjust the `await` placement here — the Task 0 smoke test and these unit tests will catch a mismatch. Keep `as never[]` only if the strict schema-typed `insertMultiple` rejects the generic `SearchDoc[]`; prefer a typed Orama schema if it compiles cleanly under `noExplicitAny`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SearchIndex.test.ts`
Expected: PASS. If the corrupt-file test's path write is flaky, simplify it to delete the manifest file and assert `reindex()` still returns `docCount === docs.length`.

> No commit.

---

## Task 4: MCP tool handlers (pure, SDK-free)

**Files:**
- Create: `cli/src/mcp/McpTools.ts`
- Create: `cli/src/mcp/McpTools.test.ts`

Reused APIs:
- `compileTaskContext({ branch }, cwd): Promise<CompiledContext>` and `buildRecallPayload(ctx): RecallPayload`. **Note:** despite the name, `compileTaskContext` reads **raw `CommitSummary` records** from `index.json` (`CompiledContext.summaries` = "Raw, from orphan branch") — it does NOT read the topic KB. `runRecall` is therefore the exact same path the jolli-recall skill / `RecallCommand` use. "compile" here means "assemble raw summaries into context", unrelated to the topic-KB LLM-compiled artifacts.
- `listBranchCatalog(cwd): Promise<BranchCatalog>`.
- `readTopicPage(slug, cwd, storage): Promise<TopicPage | null>`.
- Current branch resolution: reuse the existing git helper. Find it with `grep -rn "getCurrentBranch\|currentBranch" cli/src/core/GitClient.ts` and import that; the test mocks it.

- [ ] **Step 1: Write the failing test**

`cli/src/mcp/McpTools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/SearchIndex.js", () => ({
	SearchIndex: { open: vi.fn() },
}));
vi.mock("../core/ContextCompiler.js", () => ({
	compileTaskContext: vi.fn(),
	buildRecallPayload: vi.fn(),
	listBranchCatalog: vi.fn(),
}));
vi.mock("../core/TopicPageStore.js", () => ({ readTopicPage: vi.fn() }));
vi.mock("../core/GitClient.js", () => ({ getCurrentBranch: vi.fn() }));

import { buildRecallPayload, compileTaskContext, listBranchCatalog } from "../core/ContextCompiler.js";
import { getCurrentBranch } from "../core/GitClient.js";
import { SearchIndex } from "../core/SearchIndex.js";
import { readTopicPage } from "../core/TopicPageStore.js";
import { runDecisionTimeline, runListBranches, runRecall, runSearch } from "./McpTools.js";

describe("runSearch", () => {
	it("delegates to SearchIndex.search and returns hits", async () => {
		const search = vi.fn().mockResolvedValue([{ id: "topic:x", type: "topic", title: "X", score: 1 }]);
		vi.mocked(SearchIndex.open).mockResolvedValue({ search } as never);
		const out = await runSearch("/repo", { query: "auth", limit: 5 });
		expect(search).toHaveBeenCalledWith({ query: "auth", limit: 5, branch: undefined, type: undefined });
		expect(out.hits).toHaveLength(1);
	});

	it("rejects an empty query with a structured error", async () => {
		await expect(runSearch("/repo", { query: "" })).rejects.toThrow(/query/i);
	});
});

describe("runRecall", () => {
	it("defaults to the current branch when none given", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("feature/auth");
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: "feature/auth" } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: "feature/auth" } as never);
		const out = await runRecall("/repo", {});
		expect(compileTaskContext).toHaveBeenCalledWith({ branch: "feature/auth" }, "/repo");
		expect(out.branch).toBe("feature/auth");
	});

	it("uses the explicit branch when provided", async () => {
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: "main" } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: "main" } as never);
		await runRecall("/repo", { branch: "main" });
		expect(compileTaskContext).toHaveBeenCalledWith({ branch: "main" }, "/repo");
	});
});

describe("runDecisionTimeline", () => {
	it("sorts a topic's sourceRefs chronologically", async () => {
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [
				{ type: "summary", id: "b", timestamp: "2026-02-01T00:00:00Z", branch: "x" },
				{ type: "summary", id: "a", timestamp: "2026-01-01T00:00:00Z", branch: "x" },
			],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		expect(out.timeline.map((t) => t.sourceId)).toEqual(["a", "b"]);
	});

	it("throws when the topic does not exist", async () => {
		vi.mocked(readTopicPage).mockResolvedValue(null);
		await expect(runDecisionTimeline("/repo", { slug: "missing" })).rejects.toThrow(/not found/i);
	});
});

describe("runListBranches", () => {
	it("returns the branch catalog", async () => {
		vi.mocked(listBranchCatalog).mockResolvedValue({ type: "catalog", branches: [{ branch: "main" }] } as never);
		const out = await runListBranches("/repo");
		expect(out.branches).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpTools.test.ts`
Expected: FAIL — handlers not defined.

- [ ] **Step 3: Implement the handlers**

First confirm the git helper name:

Run: `grep -rn "export.*getCurrentBranch\|export.*currentBranch" cli/src/core/GitClient.ts`
If the export is named differently, use that name in the import below and update the test mock to match.

`cli/src/mcp/McpTools.ts`:

```ts
/**
 * Pure MCP tool handlers (JOLLI-1226 P0). Each returns a plain
 * JSON-serializable object and throws a plain Error on bad input. No MCP SDK
 * coupling here so the handlers are unit-testable in isolation; McpServer.ts
 * adapts these into SDK tool responses.
 */

import { buildRecallPayload, compileTaskContext, listBranchCatalog } from "../core/ContextCompiler.js";
import type { BranchCatalog, RecallPayload } from "../core/ContextCompiler.js";
import { getCurrentBranch } from "../core/GitClient.js";
import { SearchIndex } from "../core/SearchIndex.js";
import type { SearchHitResult } from "../core/SearchIndex.js";
import { readTopicPage } from "../core/TopicPageStore.js";

export interface SearchArgs {
	query: string;
	branch?: string;
	type?: "topic" | "commit";
	limit?: number;
}

export async function runSearch(cwd: string, args: SearchArgs): Promise<{ hits: SearchHitResult[] }> {
	if (!args.query || !args.query.trim()) {
		throw new Error("`query` is required and must be non-empty");
	}
	const index = await SearchIndex.open(cwd);
	const hits = await index.search({
		query: args.query,
		branch: args.branch,
		type: args.type,
		limit: args.limit,
	});
	return { hits };
}

export async function runRecall(cwd: string, args: { branch?: string }): Promise<RecallPayload> {
	const branch = args.branch ?? (await getCurrentBranch(cwd));
	const ctx = await compileTaskContext({ branch }, cwd);
	return buildRecallPayload(ctx);
}

export interface TimelineEntry {
	timestamp: string;
	branch: string;
	sourceType: string;
	sourceId: string;
}

export async function runDecisionTimeline(
	cwd: string,
	args: { slug: string },
): Promise<{ slug: string; title: string; timeline: TimelineEntry[] }> {
	if (!args.slug || !args.slug.trim()) {
		throw new Error("`slug` is required");
	}
	const page = await readTopicPage(args.slug, cwd);
	if (!page) {
		throw new Error(`Topic not found: ${args.slug}`);
	}
	const timeline = [...page.sourceRefs]
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
		.map((r) => ({ timestamp: r.timestamp, branch: r.branch ?? "", sourceType: r.type, sourceId: r.id }));
	return { slug: args.slug, title: page.title, timeline };
}

export async function runListBranches(cwd: string): Promise<BranchCatalog> {
	return listBranchCatalog(cwd);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpTools.test.ts`
Expected: PASS.

> No commit.

---

## Task 5: McpServer — wire handlers into the SDK over stdio

**Files:**
- Create: `cli/src/mcp/McpServer.ts`
- Create: `cli/src/mcp/McpServer.test.ts`

The server itself is thin glue; the heavy logic is tested in Task 4. The test verifies the tool registry (names + that a call routes to the right handler) without spawning a real transport.

- [ ] **Step 1: Write the failing test**

`cli/src/mcp/McpServer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("./McpTools.js", () => ({
	runSearch: vi.fn().mockResolvedValue({ hits: [] }),
	runRecall: vi.fn().mockResolvedValue({ type: "recall" }),
	runDecisionTimeline: vi.fn().mockResolvedValue({ timeline: [] }),
	runListBranches: vi.fn().mockResolvedValue({ branches: [] }),
}));

import { TOOL_DEFINITIONS, dispatchTool } from "./McpServer.js";
import { runListBranches, runSearch } from "./McpTools.js";

describe("MCP tool registry", () => {
	it("declares exactly the four P0 tools", () => {
		expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(
			["get_decision_timeline", "list_branches", "recall", "search"].sort(),
		);
	});

	it("each tool has an inputSchema object", () => {
		for (const t of TOOL_DEFINITIONS) {
			expect(t.inputSchema.type).toBe("object");
		}
	});
});

describe("dispatchTool", () => {
	it("routes search to runSearch with parsed args", async () => {
		await dispatchTool("/repo", "search", { query: "auth" });
		expect(runSearch).toHaveBeenCalledWith("/repo", { query: "auth" });
	});

	it("routes list_branches (no args) to runListBranches", async () => {
		await dispatchTool("/repo", "list_branches", {});
		expect(runListBranches).toHaveBeenCalledWith("/repo");
	});

	it("throws on an unknown tool", async () => {
		await expect(dispatchTool("/repo", "nope", {})).rejects.toThrow(/unknown tool/i);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpServer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the server**

`cli/src/mcp/McpServer.ts`:

```ts
/**
 * McpServer — exposes JolliMemory's search + context tools to AI agents over an
 * stdio MCP transport (JOLLI-1226 P0). Pure glue: tool schemas + a dispatch
 * table over the McpTools handlers. `startMcpServer` is invoked by `jolli mcp`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "../Logger.js";
import { runDecisionTimeline, runListBranches, runRecall, runSearch } from "./McpTools.js";

const log = createLogger("McpServer");

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "search",
		description:
			"Full-text search over this repo's historical decisions and implementations (topics + commits). Use to check how a topic was handled before.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Natural-language or keyword query." },
				branch: { type: "string", description: "Optional: restrict to one branch." },
				type: { type: "string", enum: ["topic", "commit"], description: "Optional: restrict result kind." },
				limit: { type: "number", description: "Max hits (default 20)." },
			},
			required: ["query"],
		},
	},
	{
		name: "recall",
		description:
			"Recall the development context for a branch from raw commit summaries (decisions, plans, notes, commits) — the same data the jolli-recall skill uses, NOT the topic KB. Omit `branch` to recall the current branch.",
		inputSchema: {
			type: "object",
			properties: { branch: { type: "string", description: "Branch to recall; defaults to current." } },
		},
	},
	{
		name: "get_decision_timeline",
		description: "Chronological evolution of a topic — its source events ordered oldest-first.",
		inputSchema: {
			type: "object",
			properties: { slug: { type: "string", description: "Topic stableSlug." } },
			required: ["slug"],
		},
	},
	{
		name: "list_branches",
		description: "List all branches that have JolliMemory records, with their topic titles.",
		inputSchema: { type: "object", properties: {} },
	},
];

/** Route a validated tool call to its handler. Throws on unknown tool. */
export async function dispatchTool(cwd: string, name: string, args: Record<string, unknown>): Promise<unknown> {
	switch (name) {
		case "search":
			return runSearch(cwd, args as { query: string; branch?: string; type?: "topic" | "commit"; limit?: number });
		case "recall":
			return runRecall(cwd, args as { branch?: string });
		case "get_decision_timeline":
			return runDecisionTimeline(cwd, args as { slug: string });
		case "list_branches":
			return runListBranches(cwd);
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

/** Start the stdio MCP server. Resolves when the transport closes. */
export async function startMcpServer(cwd: string): Promise<void> {
	const server = new Server(
		{ name: "jollimemory", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		try {
			const result = await dispatchTool(cwd, name, args ?? {});
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn("Tool %s failed: %s", name, message);
			return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info("MCP server connected over stdio (cwd=%s)", cwd);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpServer.test.ts`
Expected: PASS. If the SDK's request-schema import path differs in the installed version, fix the import (the Task 0 smoke test established the SDK resolves; adjust the subpath to the actual `types.js` export).

> No commit.

---

## Task 6: `jolli mcp` command

**Files:**
- Create: `cli/src/commands/McpCommand.ts`
- Create: `cli/src/commands/McpCommand.test.ts`
- Modify: `cli/src/Api.ts`

- [ ] **Step 1: Write the failing test**

`cli/src/commands/McpCommand.test.ts`:

```ts
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("../mcp/McpServer.js", () => ({ startMcpServer: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../core/SearchIndex.js", () => ({ SearchIndex: { open: vi.fn() } }));

import { SearchIndex } from "../core/SearchIndex.js";
import { startMcpServer } from "../mcp/McpServer.js";
import { registerMcpCommand } from "./McpCommand.js";

describe("jolli mcp", () => {
	it("starts the stdio server by default", async () => {
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp"]);
		expect(startMcpServer).toHaveBeenCalledTimes(1);
	});

	it("--reindex rebuilds and does not start the server", async () => {
		const reindex = vi.fn().mockResolvedValue({ docCount: 3 });
		vi.mocked(SearchIndex.open).mockResolvedValue({ reindex } as never);
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp", "--reindex"]);
		expect(reindex).toHaveBeenCalledTimes(1);
		expect(startMcpServer).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/commands/McpCommand.test.ts`
Expected: FAIL — `registerMcpCommand` not defined.

- [ ] **Step 3: Implement the command**

`cli/src/commands/McpCommand.ts`:

```ts
/**
 * `jolli mcp` — starts the stdio MCP server for AI agents (JOLLI-1226 P0).
 * `jolli mcp --reindex` forces a full rebuild of the local search index and exits.
 */

import type { Command } from "commander";
import { SearchIndex } from "../core/SearchIndex.js";
import { startMcpServer } from "../mcp/McpServer.js";

export function registerMcpCommand(program: Command): void {
	program
		.command("mcp")
		.description("Start the JolliMemory MCP server (stdio) for AI agents")
		.option("--reindex", "Rebuild the local search index from source and exit")
		.action(async (options: { reindex?: boolean }) => {
			const cwd = process.cwd();
			if (options.reindex) {
				const index = await SearchIndex.open(cwd);
				const { docCount } = await index.reindex();
				process.stdout.write(`Reindexed ${docCount} document(s).\n`);
				return;
			}
			await startMcpServer(cwd);
		});
}
```

- [ ] **Step 4: Register in Api.ts**

In `cli/src/Api.ts`, add the import near the other command imports (alphabetical, after `registerMigrateCommand` import is fine):

```ts
import { registerMcpCommand } from "./commands/McpCommand.js";
```

And add the registration call alongside the others (near `registerSyncCommand(program);`):

```ts
	registerMcpCommand(program);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/commands/McpCommand.test.ts`
Expected: PASS.

> No commit.

---

## Task 7: Incremental upsert in compileAllRepos

**Files:**
- Modify: `cli/src/core/MultiRepoCompile.ts`
- Modify (extend existing test): `cli/src/core/MultiRepoCompile.test.ts` (create if absent)

The hook: after each repo's `renderTopicKBWiki`, open + reindex that repo's search index so the common path keeps the index warm. Failures are logged and swallowed (matches the file's per-repo isolation and the index's disposable nature).

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/MultiRepoCompile.test.ts` (mirror the existing mock setup in that file; if the file does not exist, create it mocking `discoverRepos`, `drainIngest`, `readTopicIndex`, `purgeTopicPagesExcept`, `renderTopicKBWiki`, `withVaultWriteLock`, `createFolderStorageAtRoot`, `getActiveStorage`/`setActiveStorage`, `deriveMemoryBankRoot`):

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../sync/VaultWriteLock.js", () => ({
	withVaultWriteLock: vi.fn(async (_root, _mode, fn) => ({ ran: true, value: await fn() })),
}));
vi.mock("../sync/SyncBootstrap.js", () => ({ deriveMemoryBankRoot: vi.fn(() => "/vault") }));
vi.mock("./MemoryBankRepoDiscovery.js", () => ({
	discoverRepos: vi.fn(async () => [{ folder: "r1", repoIdentity: "id1", kbRoot: "/vault/r1" }]),
}));
vi.mock("./StorageFactory.js", () => ({ createFolderStorageAtRoot: vi.fn(() => ({})) }));
vi.mock("./SummaryStore.js", () => ({ getActiveStorage: vi.fn(() => undefined), setActiveStorage: vi.fn() }));
vi.mock("./IngestPipeline.js", () => ({ drainIngest: vi.fn(async () => ({ batches: 1, ingested: 2 })) }));
vi.mock("./TopicIndexStore.js", () => ({ readTopicIndex: vi.fn(async () => ({ schemaVersion: 1, topics: [] })) }));
vi.mock("./TopicPageStore.js", () => ({ purgeTopicPagesExcept: vi.fn(async () => undefined) }));
vi.mock("./TopicWikiRenderer.js", () => ({ renderTopicKBWiki: vi.fn(async () => undefined) }));
vi.mock("./SearchIndex.js", () => ({ SearchIndex: { open: vi.fn() } }));

import { compileAllRepos } from "./MultiRepoCompile.js";
import { SearchIndex } from "./SearchIndex.js";

describe("compileAllRepos search index hook", () => {
	it("reindexes each repo after wiki render", async () => {
		const reindex = vi.fn().mockResolvedValue({ docCount: 5 });
		vi.mocked(SearchIndex.open).mockResolvedValue({ reindex } as never);
		const res = await compileAllRepos("/vault", {} as never);
		expect(res.totalIngested).toBe(2);
		expect(SearchIndex.open).toHaveBeenCalledWith("/vault/r1", expect.anything());
		expect(reindex).toHaveBeenCalledTimes(1);
	});

	it("swallows a reindex failure without failing the repo", async () => {
		vi.mocked(SearchIndex.open).mockRejectedValue(new Error("orama boom"));
		const res = await compileAllRepos("/vault", {} as never);
		expect(res.failed).toBe(0); // index failure is non-fatal
		expect(res.totalIngested).toBe(2);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/MultiRepoCompile.test.ts`
Expected: FAIL — `SearchIndex.open` never called.

- [ ] **Step 3: Add the hook**

In `cli/src/core/MultiRepoCompile.ts`, add the import:

```ts
import { SearchIndex } from "./SearchIndex.js";
```

Then inside the per-repo `try` block, immediately after `await renderTopicKBWiki(t.kbRoot, storage);`, add:

```ts
				// Keep the local search index warm so query-time rebuilds are rare.
				// Disposable cache: a failure here must never fail the compile.
				try {
					const idx = await SearchIndex.open(t.kbRoot, storage);
					await idx.reindex();
				} catch (idxErr) {
					log.warn(
						"Search index update failed for %s (non-fatal): %s",
						t.folder,
						idxErr instanceof Error ? idxErr.message : String(idxErr),
					);
				}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/MultiRepoCompile.test.ts`
Expected: PASS.

> No commit.

---

## Task 8: MCP auto-registration in `.mcp.json`

**Files:**
- Create: `cli/src/install/McpRegistration.ts`
- Create: `cli/src/install/McpRegistration.test.ts`
- Modify: `cli/src/install/Installer.ts`

The `.mcp.json` server entry must invoke the same dist-path-resolved `Cli.js` the hooks use, so version bumps don't break it. Find the resolve-dist-path helper the hooks already use:

Run: `grep -rn "resolve-dist-path\|resolveDistPath\|run-cli\|run-hook" cli/src/install/DispatchScripts.ts | head`

Use the existing global script (the `run-cli` entry script, or the `resolve-dist-path` indirection) as the command. The `.mcp.json` schema for Claude Code is `{ "mcpServers": { "<name>": { "command": "<cmd>", "args": ["..."] } } }`.

- [ ] **Step 1: Write the failing test**

`cli/src/install/McpRegistration.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerMcpInClaude, removeMcpFromClaude } from "./McpRegistration.js";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-mcp-reg-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("registerMcpInClaude", () => {
	it("creates .mcp.json with a jollimemory server entry", async () => {
		await registerMcpInClaude(dir);
		const raw = await readFile(join(dir, ".mcp.json"), "utf-8");
		const json = JSON.parse(raw);
		expect(json.mcpServers.jollimemory).toBeDefined();
		expect(Array.isArray(json.mcpServers.jollimemory.args)).toBe(true);
		expect(json.mcpServers.jollimemory.args).toContain("mcp");
	});

	it("preserves existing servers and is idempotent", async () => {
		await writeFile(
			join(dir, ".mcp.json"),
			JSON.stringify({ mcpServers: { other: { command: "x" } } }),
			"utf-8",
		);
		await registerMcpInClaude(dir);
		await registerMcpInClaude(dir); // second call must not duplicate or corrupt
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers.other).toBeDefined();
		expect(json.mcpServers.jollimemory).toBeDefined();
	});
});

describe("removeMcpFromClaude", () => {
	it("removes only the jollimemory entry", async () => {
		await writeFile(
			join(dir, ".mcp.json"),
			JSON.stringify({ mcpServers: { other: { command: "x" }, jollimemory: { command: "y" } } }),
			"utf-8",
		);
		await removeMcpFromClaude(dir);
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers.jollimemory).toBeUndefined();
		expect(json.mcpServers.other).toBeDefined();
	});

	it("no-ops when .mcp.json is absent", async () => {
		await expect(removeMcpFromClaude(dir)).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/install/McpRegistration.test.ts`
Expected: FAIL — module not defined.

- [ ] **Step 3: Implement the registration**

`cli/src/install/McpRegistration.ts`. Use the same global entry-script path the hooks resolve through. Replace `getRunCliScriptPath()` below with the actual helper found in Step 0's grep (e.g. the function that returns `~/.jolli/jollimemory/run-cli`); if hooks invoke `node "$(resolve-dist-path)/Cli.js"`, mirror that exact command form here.

```ts
/**
 * Auto-registration of the JolliMemory MCP server into a worktree's `.mcp.json`
 * (Claude Code project config), JOLLI-1226 P0. Idempotent; preserves other
 * servers. Uses the same global entry-script indirection as the git/agent hooks
 * so version bumps don't strand the registration.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { getGlobalConfigDir } from "../Logger.js";

const log = createLogger("McpRegistration");
const SERVER_KEY = "jollimemory";

interface McpConfig {
	mcpServers?: Record<string, { command: string; args?: string[] }>;
}

async function readMcpConfig(mcpPath: string): Promise<McpConfig> {
	try {
		return JSON.parse(await readFile(mcpPath, "utf-8")) as McpConfig;
	} catch {
		return {};
	}
}

/** Add (or refresh) the jollimemory server entry in <worktreeDir>/.mcp.json. */
export async function registerMcpInClaude(worktreeDir: string): Promise<void> {
	const mcpPath = join(worktreeDir, ".mcp.json");
	const config = await readMcpConfig(mcpPath);
	const servers = config.mcpServers ?? {};

	// `run-cli` is the global entry script that resolves the active dist path and
	// execs `node <dist>/Cli.js "$@"`. Passing `mcp` makes it start the server.
	const runCli = join(getGlobalConfigDir(), "run-cli");
	servers[SERVER_KEY] = { command: "sh", args: [runCli, "mcp"] };

	const next: McpConfig = { ...config, mcpServers: servers };
	await writeFile(mcpPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	log.info("Registered MCP server in %s", mcpPath);
}

/** Remove the jollimemory server entry; no-op if file or entry is absent. */
export async function removeMcpFromClaude(worktreeDir: string): Promise<void> {
	const mcpPath = join(worktreeDir, ".mcp.json");
	let config: McpConfig;
	try {
		config = JSON.parse(await readFile(mcpPath, "utf-8")) as McpConfig;
	} catch {
		return; // absent or unreadable → nothing to remove
	}
	if (!config.mcpServers?.[SERVER_KEY]) return;
	delete config.mcpServers[SERVER_KEY];
	await writeFile(mcpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	log.info("Removed MCP server from %s", mcpPath);
}
```

> Confirm `getGlobalConfigDir` is exported from `../Logger.js` (Step 0 grep earlier showed it referenced there). If it lives elsewhere, import from the correct module. Also confirm the global `run-cli` script exists and accepts a passthrough arg — if hooks instead call `run-hook`/`resolve-dist-path`, build the command to match (`{ command: "node", args: ["<resolved>/Cli.js", "mcp"] }` is an acceptable alternative if there is no `run-cli`).

- [ ] **Step 4: Wire into the Installer**

In `cli/src/install/Installer.ts`, add the import:

```ts
import { registerMcpInClaude, removeMcpFromClaude } from "./McpRegistration.js";
```

In the per-worktree install loop, immediately after `await installSessionStartHook(wt);` (inside the `if (config.claudeEnabled === false) continue;` gate, so it only runs when Claude is enabled), add:

```ts
				// Register the MCP server for AI agents (Claude Code project config).
				// Non-fatal: a failure here must not block hook installation.
				try {
					await registerMcpInClaude(wt);
				} catch (mcpErr) {
					log.warn("MCP registration failed in %s (non-fatal): %s", wt, (mcpErr as Error).message);
				}
```

In the uninstall path (the loop around line 494 that calls `removeClaudeHook(wt)`), add after that call:

```ts
			await removeMcpFromClaude(wt);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/install/McpRegistration.test.ts`
Expected: PASS.

> No commit. (Installer wiring is covered by McpRegistration unit tests + the existing Installer tests; if Installer tests assert on exact call sequences, update those expectations in this task.)

---

## Task 9: Docs, IntelliJ manual-setup note, and final verification + single commit

**Files:**
- Modify: `cli/DEVELOPMENT.md` (brief note on the index + `jolli mcp`)
- Modify: `intellij/DEVELOPMENT.md` (manual `.mcp.json` setup snippet, since IntelliJ auto-registration is deferred)
- All previously created/modified files

- [ ] **Step 1: Add a short DEVELOPMENT.md note (CLI)**

Append a subsection to `cli/DEVELOPMENT.md` describing: the local index at `.jolli/jollimemory/search-index.json` (disposable cache, rebuilt from source via staleness signature), `jolli mcp` (stdio server) and `jolli mcp --reindex`, and the four MCP tools.

- [ ] **Step 2: Add the IntelliJ manual-setup snippet**

In `intellij/DEVELOPMENT.md`, add a short note that IntelliJ does not auto-register the MCP server yet; users add it manually to `.mcp.json`:

```json
{ "mcpServers": { "jollimemory": { "command": "jolli", "args": ["mcp"] } } }
```

- [ ] **Step 3: Verify the CLAUDE.md "three implementations in lockstep" rule is untouched**

This change does not modify `parseJolliApiKey` / `assertJolliOriginAllowed`. Confirm with:

Run: `git diff --name-only | grep -i "JolliApiUtils" || echo "API key parser untouched ✓"`
Expected: `API key parser untouched ✓`

- [ ] **Step 4: Run the full gate once**

Run: `npm run all`
Expected: clean → build → lint → test all PASS, including the CLI coverage floor (97% statements / 96% branches / 97% functions / 97% lines). If coverage dips below the floor on any new module, add the missing-branch tests (e.g. the `dominantSourceType` empty-refs branch, `tryRestore` schema-version-mismatch branch, `dispatchTool` default branch) until it passes.

If the VS Code bundle is part of `npm run all`, it must also build clean (Task 0 already de-risked this).

- [ ] **Step 5: Stage and commit once (DCO sign-off, no AI co-author trailer)**

```bash
git add -A
git commit -s -m "feat: add local search index and MCP server (JOLLI-1226 P0)

Add an Orama full-text index over the topic KB + commit catalog, persisted
locally and rebuilt from source via a staleness signature. Expose search,
recall, get_decision_timeline, and list_branches over an stdio MCP server
(jolli mcp), auto-registered into Claude Code's .mcp.json by the installer."
```

Expected: commit succeeds with a `Signed-off-by:` trailer and **no** `Co-Authored-By: Claude` / `🤖 Generated with` lines.

---

## Self-review notes (author checklist — already applied)

- **Spec coverage:** SearchIndex (Tasks 1–3) ✓; MCP server + 4 tools (Tasks 4–6) ✓; dual-source indexing (Task 2) ✓; local persistence + staleness "both combined" (Task 3 + Task 7) ✓; auto-registration into `.mcp.json` (Task 8) ✓; dependency/bundle risk gated first (Task 0) ✓. Deferred items (embeddings, hybrid ranking, L0–L3, cross-branch, IntelliJ auto-register, QueueWorker changes) are explicitly out of scope and not tasked.
- **Type consistency:** `SearchDoc` fields (Task 1) match the projection (Task 2), the Orama hit mapping (Task 3 `SearchHitResult`), and the tool output (Tasks 4–5). `SearchIndex.open(cwd, storage?)` / `.search(SearchQuery)` / `.reindex()` signatures are used identically in Tasks 3, 4, 6, 7.
- **Placeholder scan:** No TBD/TODO. The only deliberate "confirm the exact name" steps are for pre-existing helpers (`getCurrentBranch`, `run-cli`/`resolve-dist-path`, `getGlobalConfigDir`) where the grep command and the fallback are both given — not placeholders for new code.
- **Standing preferences:** per-task commits removed; single `npm run all` + commit in Task 9; DCO sign-off, no AI co-author trailer.
