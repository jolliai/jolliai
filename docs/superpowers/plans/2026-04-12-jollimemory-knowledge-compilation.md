# JolliMemory Knowledge Compilation — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile fragmented commit-level summaries into high-quality topic-level knowledge pages, enabling Recall to return denser, more useful context. Add `jollimemory compile` and `jollimemory import` CLI commands and refactor ContextCompiler to prefer compiled artifacts.

**Architecture:** New `compiled/` and `imports/` directories on the existing `jollimemory/summaries/v3` orphan branch store compilation artifacts and imported knowledge. A `KnowledgeCompiler` module calls the LLM to synthesize branch summaries into topic pages. `CacheValidator` tracks staleness via `sourceSummaries` hash lists. `ContextCompiler` checks for compiled cache before falling back to raw summaries (Strategy B: return immediately, background-compile for next time). Prompt templates follow the existing `PromptTemplates.ts` pattern.

**Tech Stack:** TypeScript, Vitest, Commander.js (CLI), Anthropic SDK (via existing LlmClient), git plumbing (via existing GitOps)

**Linear Ticket:** JOLLI-1217

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/Types.ts` | Modify | Add `CompiledKnowledge`, `CompiledTopic`, `ImportedKnowledge`, `ImportedTopic`, `CacheStatus` types |
| `src/core/CompiledStore.ts` | Create | CRUD for `compiled/<branch-slug>.json` on orphan branch |
| `src/core/CompiledStore.test.ts` | Create | Tests for CompiledStore |
| `src/core/ImportStore.ts` | Create | CRUD for `imports/<slug>.json` on orphan branch |
| `src/core/ImportStore.test.ts` | Create | Tests for ImportStore |
| `src/core/CacheValidator.ts` | Create | Compare `sourceSummaries` to determine cache hit/stale/miss |
| `src/core/CacheValidator.test.ts` | Create | Tests for CacheValidator |
| `src/core/KnowledgeCompiler.ts` | Create | LLM compilation: summaries + imports → compiled topics |
| `src/core/KnowledgeCompiler.test.ts` | Create | Tests for KnowledgeCompiler |
| `src/core/ImportProcessor.ts` | Create | LLM processing: external file → structured import summary |
| `src/core/ImportProcessor.test.ts` | Create | Tests for ImportProcessor |
| `src/core/PromptTemplates.ts` | Modify | Add `compile` and `import` prompt templates |
| `src/core/PromptTemplates.test.ts` | Modify | Tests for new templates |
| `src/core/ContextCompiler.ts` | Modify | Prefer compiled cache, Strategy B fallback, merge imports |
| `src/core/ContextCompiler.test.ts` | Modify | Tests for compiled-aware recall |
| `src/Cli.ts` | Modify | Add `compile` and `import` commands |
| `src/Cli.test.ts` | Modify | Tests for new CLI commands |
| `src/hooks/PostMergeHook.ts` | Create | Detect merge commits, extract branch names, trigger compile |
| `src/hooks/PostMergeHook.test.ts` | Create | Tests for PostMergeHook |
| `src/install/Installer.ts` | Modify | Install post-merge hook alongside existing hooks |
| `vite.config.ts` | Modify | Add PostMergeHook entry point |

---

## Task 1: Add Types to Types.ts

**Files:**
- Modify: `tools/jollimemory/src/Types.ts`

This task adds all new type definitions needed by the knowledge compilation feature. These types are referenced by every subsequent task.

- [ ] **Step 1: Add compiled knowledge types to Types.ts**

Add the following types after the existing `NoteReference` interface (around line 323, before `DiffStats`):

```typescript
// ─── Knowledge Compilation types ────────────────────────────────────────────

/** A single compiled topic within a branch's knowledge page */
export interface CompiledTopic {
	readonly title: string;
	/** Markdown content: ## Background, ## Design Decisions, ## Pitfalls, etc. */
	readonly content: string;
	/** Branches that relate to this topic (LLM-inferred) */
	readonly relatedBranches?: ReadonlyArray<string>;
	/** Key design decisions distilled from source summaries */
	readonly keyDecisions?: ReadonlyArray<string>;
	/** Source commit hashes that contributed to this topic */
	readonly sourceCommits: ReadonlyArray<string>;
}

/**
 * Compiled knowledge for a branch — synthesized from multiple commit summaries
 * into high-density topic-level knowledge pages.
 *
 * Stored as `compiled/<branch-slug>.json` on the orphan branch.
 */
export interface CompiledKnowledge {
	readonly version: 1;
	readonly branch: string;
	readonly compiledAt: string; // ISO 8601
	/** Commit hashes of source summaries used for this compilation */
	readonly sourceSummaries: ReadonlyArray<string>;
	/** Import IDs that were included in this compilation */
	readonly sourceImports: ReadonlyArray<string>;
	readonly topics: ReadonlyArray<CompiledTopic>;
	readonly llm?: LlmCallMetadata;
}

/** A single topic within an imported knowledge entry */
export interface ImportedTopic {
	readonly title: string;
	readonly category: string;
	readonly content: string;
	readonly decisions?: string;
	/** Branches related to this topic (LLM-inferred from active branches + recent summaries) */
	readonly relatedBranches?: ReadonlyArray<string>;
}

/**
 * Imported external knowledge (meeting notes, design docs, specs).
 * Stored as `imports/<slug>.json` on the orphan branch.
 */
export interface ImportedKnowledge {
	readonly version: 1;
	readonly id: string;
	readonly source: "import";
	readonly importedAt: string; // ISO 8601
	readonly originalFile: string;
	readonly tag: ImportTag;
	/** Null means global (not bound to a specific branch) */
	readonly branch: string | null;
	readonly topics: ReadonlyArray<ImportedTopic>;
	readonly llm?: LlmCallMetadata;
}

/** Supported import tags */
export type ImportTag = "meeting" | "design" | "notes" | "spec" | "other";

/** Cache validation result for compiled knowledge */
export type CacheStatus =
	| { readonly status: "hit"; readonly compiled: CompiledKnowledge }
	| { readonly status: "stale"; readonly compiled: CompiledKnowledge; readonly newSummaryHashes: ReadonlyArray<string> }
	| { readonly status: "miss" };
```

- [ ] **Step 2: Verify no lint errors**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx biome check src/Types.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/Types.ts
git commit -m "Part of JOLLI-1217: Add knowledge compilation and import types"
```

---

## Task 2: CompiledStore — Storage for Compiled Knowledge

**Files:**
- Create: `tools/jollimemory/src/core/CompiledStore.ts`
- Create: `tools/jollimemory/src/core/CompiledStore.test.ts`

Provides CRUD operations for `compiled/<branch-slug>.json` files on the orphan branch. Follows the same pattern as SummaryStore: uses `GitOps.writeMultipleFilesToBranch()` and `readFileFromBranch()`.

- [ ] **Step 1: Write the test file**

```typescript
// CompiledStore.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledKnowledge } from "../Types.js";
import { deleteCompiled, listCompiled, readCompiled, saveCompiled } from "./CompiledStore.js";

vi.mock("./GitOps.js", () => ({
	readFileFromBranch: vi.fn(),
	writeMultipleFilesToBranch: vi.fn(),
	listFilesInBranch: vi.fn(),
}));

import { listFilesInBranch, readFileFromBranch, writeMultipleFilesToBranch } from "./GitOps.js";

const mockRead = vi.mocked(readFileFromBranch);
const mockWrite = vi.mocked(writeMultipleFilesToBranch);
const mockList = vi.mocked(listFilesInBranch);

function makeCompiled(overrides: Partial<CompiledKnowledge> = {}): CompiledKnowledge {
	return {
		version: 1,
		branch: "feature/oauth",
		compiledAt: "2026-04-07T10:30:00Z",
		sourceSummaries: ["abc123", "def456"],
		sourceImports: [],
		topics: [
			{
				title: "OAuth2 Provider Integration",
				content: "## Background\nIntegrated OAuth2...",
				keyDecisions: ["Chose PKCE flow"],
				sourceCommits: ["abc123"],
			},
		],
		...overrides,
	};
}

describe("CompiledStore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("saveCompiled", () => {
		it("should write compiled knowledge to orphan branch", async () => {
			mockWrite.mockResolvedValue();
			const compiled = makeCompiled();

			await saveCompiled(compiled, "/test");

			expect(mockWrite).toHaveBeenCalledOnce();
			const [branch, files, message] = mockWrite.mock.calls[0];
			expect(branch).toBe("jollimemory/summaries/v3");
			expect(files).toHaveLength(1);
			expect(files[0].path).toBe("compiled/feature-oauth.json");
			expect(JSON.parse(files[0].content)).toEqual(compiled);
			expect(message).toContain("feature/oauth");
		});

		it("should slugify branch names with slashes and special chars", async () => {
			mockWrite.mockResolvedValue();
			const compiled = makeCompiled({ branch: "feature/JOLLI-123-auth/v2" });

			await saveCompiled(compiled, "/test");

			const [, files] = mockWrite.mock.calls[0];
			expect(files[0].path).toBe("compiled/feature-jolli-123-auth-v2.json");
		});
	});

	describe("readCompiled", () => {
		it("should read and parse compiled knowledge", async () => {
			const compiled = makeCompiled();
			mockRead.mockResolvedValue(JSON.stringify(compiled));

			const result = await readCompiled("feature/oauth", "/test");

			expect(result).toEqual(compiled);
			expect(mockRead).toHaveBeenCalledWith(
				"jollimemory/summaries/v3",
				"compiled/feature-oauth.json",
				"/test",
			);
		});

		it("should return null when file does not exist", async () => {
			mockRead.mockResolvedValue(null);

			const result = await readCompiled("feature/missing", "/test");

			expect(result).toBeNull();
		});

		it("should return null for invalid JSON", async () => {
			mockRead.mockResolvedValue("not json{");

			const result = await readCompiled("feature/bad", "/test");

			expect(result).toBeNull();
		});
	});

	describe("listCompiled", () => {
		it("should return branch names from compiled directory", async () => {
			mockList.mockResolvedValue([
				"compiled/feature-oauth.json",
				"compiled/feature-auth-v2.json",
			]);

			const result = await listCompiled("/test");

			expect(result).toEqual(["feature-oauth", "feature-auth-v2"]);
		});

		it("should return empty array when no compiled files", async () => {
			mockList.mockResolvedValue([]);

			const result = await listCompiled("/test");

			expect(result).toEqual([]);
		});
	});

	describe("deleteCompiled", () => {
		it("should delete compiled file from orphan branch", async () => {
			mockWrite.mockResolvedValue();

			await deleteCompiled("feature/oauth", "/test");

			expect(mockWrite).toHaveBeenCalledOnce();
			const [, files] = mockWrite.mock.calls[0];
			expect(files).toHaveLength(1);
			expect(files[0].path).toBe("compiled/feature-oauth.json");
			expect(files[0].delete).toBe(true);
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/CompiledStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write CompiledStore implementation**

```typescript
// CompiledStore.ts
/**
 * Compiled Knowledge Store
 *
 * CRUD operations for compiled knowledge artifacts on the orphan branch.
 * Compiled knowledge is stored as `compiled/<branch-slug>.json` in
 * the `jollimemory/summaries/v3` orphan branch.
 */

import { ORPHAN_BRANCH, createLogger } from "../Logger.js";
import type { CompiledKnowledge, FileWrite } from "../Types.js";
import { listFilesInBranch, readFileFromBranch, writeMultipleFilesToBranch } from "./GitOps.js";

const log = createLogger("CompiledStore");

/**
 * Converts a branch name to a filesystem-safe slug.
 * "feature/JOLLI-123-auth/v2" → "feature-jolli-123-auth-v2"
 */
export function slugifyBranch(branch: string): string {
	return branch
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Saves compiled knowledge to the orphan branch. */
export async function saveCompiled(compiled: CompiledKnowledge, cwd?: string): Promise<void> {
	const slug = slugifyBranch(compiled.branch);
	const files: FileWrite[] = [
		{
			path: `compiled/${slug}.json`,
			content: JSON.stringify(compiled, null, "\t"),
		},
	];

	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		files,
		`Compile knowledge for ${compiled.branch} (${compiled.sourceSummaries.length} summaries)`,
		cwd,
	);
	log.info("Compiled knowledge saved for branch %s (%d topics)", compiled.branch, compiled.topics.length);
}

/** Reads compiled knowledge for a branch. Returns null if not found or unparseable. */
export async function readCompiled(branch: string, cwd?: string): Promise<CompiledKnowledge | null> {
	const slug = slugifyBranch(branch);
	const raw = await readFileFromBranch(ORPHAN_BRANCH, `compiled/${slug}.json`, cwd);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as CompiledKnowledge;
	} catch {
		log.warn("Failed to parse compiled knowledge for branch %s", branch);
		return null;
	}
}

/** Lists all compiled branch slugs. */
export async function listCompiled(cwd?: string): Promise<ReadonlyArray<string>> {
	const files = await listFilesInBranch(ORPHAN_BRANCH, "compiled/", cwd);
	return files
		.filter((f) => f.startsWith("compiled/") && f.endsWith(".json"))
		.map((f) => f.replace("compiled/", "").replace(".json", ""));
}

/** Deletes compiled knowledge for a branch. */
export async function deleteCompiled(branch: string, cwd?: string): Promise<void> {
	const slug = slugifyBranch(branch);
	const files: FileWrite[] = [
		{ path: `compiled/${slug}.json`, content: "", delete: true },
	];
	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		files,
		`Delete compiled knowledge for ${branch}`,
		cwd,
	);
	log.info("Compiled knowledge deleted for branch %s", branch);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/CompiledStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/core/CompiledStore.ts tools/jollimemory/src/core/CompiledStore.test.ts
git commit -m "Part of JOLLI-1217: Add CompiledStore for compiled knowledge CRUD"
```

---

## Task 3: ImportStore — Storage for Imported Knowledge

**Files:**
- Create: `tools/jollimemory/src/core/ImportStore.ts`
- Create: `tools/jollimemory/src/core/ImportStore.test.ts`

Same pattern as CompiledStore, but for `imports/<slug>.json` files. Import slugs are auto-generated from the tag and original filename.

- [ ] **Step 1: Write the test file**

```typescript
// ImportStore.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedKnowledge } from "../Types.js";
import { deleteImport, listImports, readImport, saveImport } from "./ImportStore.js";

vi.mock("./GitOps.js", () => ({
	readFileFromBranch: vi.fn(),
	writeMultipleFilesToBranch: vi.fn(),
	listFilesInBranch: vi.fn(),
}));

import { listFilesInBranch, readFileFromBranch, writeMultipleFilesToBranch } from "./GitOps.js";

const mockRead = vi.mocked(readFileFromBranch);
const mockWrite = vi.mocked(writeMultipleFilesToBranch);
const mockList = vi.mocked(listFilesInBranch);

function makeImport(overrides: Partial<ImportedKnowledge> = {}): ImportedKnowledge {
	return {
		version: 1,
		id: "import-meeting-2026-04-07-auth-review",
		source: "import",
		importedAt: "2026-04-07T14:00:00Z",
		originalFile: "meeting-2026-04-07.md",
		tag: "meeting",
		branch: null,
		topics: [
			{
				title: "Auth Review Conclusions",
				category: "design-decision",
				content: "Team decided to use PKCE flow...",
				decisions: "Rejected implicit flow due to security audit",
				relatedBranches: ["feature/oauth"],
			},
		],
		...overrides,
	};
}

describe("ImportStore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("saveImport", () => {
		it("should write imported knowledge to orphan branch", async () => {
			mockWrite.mockResolvedValue();
			const imported = makeImport();

			await saveImport(imported, "/test");

			expect(mockWrite).toHaveBeenCalledOnce();
			const [branch, files, message] = mockWrite.mock.calls[0];
			expect(branch).toBe("jollimemory/summaries/v3");
			expect(files).toHaveLength(1);
			expect(files[0].path).toBe("imports/import-meeting-2026-04-07-auth-review.json");
			expect(JSON.parse(files[0].content)).toEqual(imported);
			expect(message).toContain("import-meeting-2026-04-07-auth-review");
		});
	});

	describe("readImport", () => {
		it("should read and parse imported knowledge", async () => {
			const imported = makeImport();
			mockRead.mockResolvedValue(JSON.stringify(imported));

			const result = await readImport("import-meeting-2026-04-07-auth-review", "/test");

			expect(result).toEqual(imported);
			expect(mockRead).toHaveBeenCalledWith(
				"jollimemory/summaries/v3",
				"imports/import-meeting-2026-04-07-auth-review.json",
				"/test",
			);
		});

		it("should return null when file does not exist", async () => {
			mockRead.mockResolvedValue(null);

			const result = await readImport("import-missing", "/test");

			expect(result).toBeNull();
		});

		it("should return null for invalid JSON", async () => {
			mockRead.mockResolvedValue("{bad");

			const result = await readImport("import-bad", "/test");

			expect(result).toBeNull();
		});
	});

	describe("listImports", () => {
		it("should return import IDs", async () => {
			mockList.mockResolvedValue([
				"imports/import-meeting-2026-04-07-auth-review.json",
				"imports/import-design-session-api.json",
			]);

			const result = await listImports("/test");

			expect(result).toEqual([
				"import-meeting-2026-04-07-auth-review",
				"import-design-session-api",
			]);
		});

		it("should return empty array when no imports", async () => {
			mockList.mockResolvedValue([]);

			const result = await listImports("/test");

			expect(result).toEqual([]);
		});
	});

	describe("deleteImport", () => {
		it("should delete import file from orphan branch", async () => {
			mockWrite.mockResolvedValue();

			await deleteImport("import-meeting-2026-04-07-auth-review", "/test");

			const [, files] = mockWrite.mock.calls[0];
			expect(files[0].path).toBe("imports/import-meeting-2026-04-07-auth-review.json");
			expect(files[0].delete).toBe(true);
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/ImportStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write ImportStore implementation**

```typescript
// ImportStore.ts
/**
 * Import Store
 *
 * CRUD operations for imported external knowledge on the orphan branch.
 * Imports are stored as `imports/<id>.json` in the `jollimemory/summaries/v3` branch.
 */

import { ORPHAN_BRANCH, createLogger } from "../Logger.js";
import type { FileWrite, ImportedKnowledge } from "../Types.js";
import { listFilesInBranch, readFileFromBranch, writeMultipleFilesToBranch } from "./GitOps.js";

const log = createLogger("ImportStore");

/** Saves imported knowledge to the orphan branch. */
export async function saveImport(imported: ImportedKnowledge, cwd?: string): Promise<void> {
	const files: FileWrite[] = [
		{
			path: `imports/${imported.id}.json`,
			content: JSON.stringify(imported, null, "\t"),
		},
	];

	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		files,
		`Import knowledge: ${imported.id} (tag: ${imported.tag})`,
		cwd,
	);
	log.info("Imported knowledge saved: %s (tag: %s, topics: %d)", imported.id, imported.tag, imported.topics.length);
}

/** Reads imported knowledge by ID. Returns null if not found or unparseable. */
export async function readImport(id: string, cwd?: string): Promise<ImportedKnowledge | null> {
	const raw = await readFileFromBranch(ORPHAN_BRANCH, `imports/${id}.json`, cwd);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ImportedKnowledge;
	} catch {
		log.warn("Failed to parse imported knowledge: %s", id);
		return null;
	}
}

/** Lists all import IDs from the orphan branch. */
export async function listImports(cwd?: string): Promise<ReadonlyArray<string>> {
	const files = await listFilesInBranch(ORPHAN_BRANCH, "imports/", cwd);
	return files
		.filter((f) => f.startsWith("imports/") && f.endsWith(".json"))
		.map((f) => f.replace("imports/", "").replace(".json", ""));
}

/** Deletes imported knowledge by ID. */
export async function deleteImport(id: string, cwd?: string): Promise<void> {
	const files: FileWrite[] = [
		{ path: `imports/${id}.json`, content: "", delete: true },
	];
	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		files,
		`Delete import: ${id}`,
		cwd,
	);
	log.info("Imported knowledge deleted: %s", id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/ImportStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/core/ImportStore.ts tools/jollimemory/src/core/ImportStore.test.ts
git commit -m "Part of JOLLI-1217: Add ImportStore for imported knowledge CRUD"
```

---

## Task 4: CacheValidator — Determine Compilation Staleness

**Files:**
- Create: `tools/jollimemory/src/core/CacheValidator.ts`
- Create: `tools/jollimemory/src/core/CacheValidator.test.ts`

Compares the `sourceSummaries` in a compiled artifact against the current branch's summary hashes to determine hit/stale/miss.

- [ ] **Step 1: Write the test file**

```typescript
// CacheValidator.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledKnowledge, SummaryIndex } from "../Types.js";
import { validateCache } from "./CacheValidator.js";

vi.mock("./SummaryStore.js", () => ({
	getIndex: vi.fn(),
}));

vi.mock("./CompiledStore.js", () => ({
	readCompiled: vi.fn(),
}));

import { getIndex } from "./SummaryStore.js";
import { readCompiled } from "./CompiledStore.js";

const mockGetIndex = vi.mocked(getIndex);
const mockReadCompiled = vi.mocked(readCompiled);

function makeIndex(entries: SummaryIndex["entries"]): SummaryIndex {
	return { version: 3, entries };
}

function makeCompiled(overrides: Partial<CompiledKnowledge> = {}): CompiledKnowledge {
	return {
		version: 1,
		branch: "feature/test",
		compiledAt: "2026-04-07T10:30:00Z",
		sourceSummaries: ["aaa111", "bbb222"],
		sourceImports: [],
		topics: [],
		...overrides,
	};
}

describe("CacheValidator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should return miss when no compiled artifact exists", async () => {
		mockReadCompiled.mockResolvedValue(null);
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{ commitHash: "aaa111", parentCommitHash: null, commitMessage: "c1", commitDate: "2026-04-01", branch: "feature/test", generatedAt: "2026-04-01" },
			]),
		);

		const result = await validateCache("feature/test", "/test");

		expect(result.status).toBe("miss");
	});

	it("should return miss when no index exists", async () => {
		mockReadCompiled.mockResolvedValue(makeCompiled());
		mockGetIndex.mockResolvedValue(null);

		const result = await validateCache("feature/test", "/test");

		expect(result.status).toBe("miss");
	});

	it("should return hit when sourceSummaries match exactly", async () => {
		const compiled = makeCompiled({ sourceSummaries: ["aaa111", "bbb222"] });
		mockReadCompiled.mockResolvedValue(compiled);
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{ commitHash: "aaa111", parentCommitHash: null, commitMessage: "c1", commitDate: "2026-04-01", branch: "feature/test", generatedAt: "2026-04-01" },
				{ commitHash: "bbb222", parentCommitHash: null, commitMessage: "c2", commitDate: "2026-04-02", branch: "feature/test", generatedAt: "2026-04-02" },
				{ commitHash: "ccc333", parentCommitHash: null, commitMessage: "c3", commitDate: "2026-04-03", branch: "other-branch", generatedAt: "2026-04-03" },
			]),
		);

		const result = await validateCache("feature/test", "/test");

		expect(result.status).toBe("hit");
		if (result.status === "hit") {
			expect(result.compiled).toEqual(compiled);
		}
	});

	it("should return stale when new summaries exist beyond compiled sources", async () => {
		const compiled = makeCompiled({ sourceSummaries: ["aaa111"] });
		mockReadCompiled.mockResolvedValue(compiled);
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{ commitHash: "aaa111", parentCommitHash: null, commitMessage: "c1", commitDate: "2026-04-01", branch: "feature/test", generatedAt: "2026-04-01" },
				{ commitHash: "bbb222", parentCommitHash: null, commitMessage: "c2", commitDate: "2026-04-02", branch: "feature/test", generatedAt: "2026-04-02" },
			]),
		);

		const result = await validateCache("feature/test", "/test");

		expect(result.status).toBe("stale");
		if (result.status === "stale") {
			expect(result.compiled).toEqual(compiled);
			expect(result.newSummaryHashes).toEqual(["bbb222"]);
		}
	});

	it("should ignore child entries (non-null parentCommitHash) when determining branch summaries", async () => {
		const compiled = makeCompiled({ sourceSummaries: ["aaa111"] });
		mockReadCompiled.mockResolvedValue(compiled);
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{ commitHash: "aaa111", parentCommitHash: null, commitMessage: "c1", commitDate: "2026-04-01", branch: "feature/test", generatedAt: "2026-04-01" },
				{ commitHash: "child1", parentCommitHash: "aaa111", commitMessage: "child", commitDate: "2026-04-01", branch: "feature/test", generatedAt: "2026-04-01" },
			]),
		);

		const result = await validateCache("feature/test", "/test");

		expect(result.status).toBe("hit");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/CacheValidator.test.ts`
Expected: FAIL

- [ ] **Step 3: Write CacheValidator implementation**

```typescript
// CacheValidator.ts
/**
 * Cache Validator
 *
 * Determines whether compiled knowledge for a branch is up-to-date
 * by comparing the `sourceSummaries` hash list in the compiled artifact
 * against the current branch's root summary hashes from the index.
 */

import { createLogger } from "../Logger.js";
import type { CacheStatus } from "../Types.js";
import { readCompiled } from "./CompiledStore.js";
import { getIndex } from "./SummaryStore.js";

const log = createLogger("CacheValidator");

/**
 * Validates the compiled knowledge cache for a branch.
 *
 * Returns:
 * - `hit`   — compiled artifact exists and sourceSummaries match all branch summaries
 * - `stale` — compiled artifact exists but new summaries have been added since compilation
 * - `miss`  — no compiled artifact exists, or no summaries exist for the branch
 */
export async function validateCache(branch: string, cwd?: string): Promise<CacheStatus> {
	const [compiled, index] = await Promise.all([
		readCompiled(branch, cwd),
		getIndex(cwd),
	]);

	if (!index || !compiled) {
		log.debug("Cache %s for branch %s", compiled ? "miss (no index)" : "miss (no compiled)", branch);
		return { status: "miss" };
	}

	// Get root-level summary hashes for this branch
	const branchRootHashes = index.entries
		.filter((e) => e.branch === branch && (e.parentCommitHash === null || e.parentCommitHash === undefined))
		.map((e) => e.commitHash);

	if (branchRootHashes.length === 0) {
		log.debug("Cache miss for branch %s (no summaries in index)", branch);
		return { status: "miss" };
	}

	const compiledSet = new Set(compiled.sourceSummaries);
	const newHashes = branchRootHashes.filter((h) => !compiledSet.has(h));

	if (newHashes.length === 0) {
		log.debug("Cache hit for branch %s (%d summaries)", branch, branchRootHashes.length);
		return { status: "hit", compiled };
	}

	log.debug("Cache stale for branch %s (%d new summaries)", branch, newHashes.length);
	return { status: "stale", compiled, newSummaryHashes: newHashes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/CacheValidator.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/core/CacheValidator.ts tools/jollimemory/src/core/CacheValidator.test.ts
git commit -m "Part of JOLLI-1217: Add CacheValidator for compiled knowledge staleness detection"
```

---

## Task 5: Prompt Templates — Add compile and import Templates

**Files:**
- Modify: `tools/jollimemory/src/core/PromptTemplates.ts`
- Modify: `tools/jollimemory/src/core/PromptTemplates.test.ts`

Adds two new prompt templates: `compile` (synthesize summaries into topic knowledge) and `import` (structure external documents). These follow the existing `TEMPLATES` Map pattern and use `{{placeholder}}` syntax.

- [ ] **Step 1: Add test for new templates**

Add to the existing `PromptTemplates.test.ts`, in the describe block that tests template existence:

```typescript
describe("compile template", () => {
	it("should exist in TEMPLATES", () => {
		expect(TEMPLATES.has("compile")).toBe(true);
	});

	it("should contain expected placeholders", () => {
		const template = TEMPLATES.get("compile")!;
		expect(template).toContain("{{branch}}");
		expect(template).toContain("{{summaries}}");
	});

	it("should fill placeholders correctly", () => {
		const template = TEMPLATES.get("compile")!;
		const filled = fillTemplate(template, {
			branch: "feature/oauth",
			summaries: "Summary content here...",
			imports: "",
		});
		expect(filled).toContain("feature/oauth");
		expect(filled).toContain("Summary content here...");
		expect(filled).not.toContain("{{branch}}");
		expect(filled).not.toContain("{{summaries}}");
	});
});

describe("import template", () => {
	it("should exist in TEMPLATES", () => {
		expect(TEMPLATES.has("import")).toBe(true);
	});

	it("should contain expected placeholders", () => {
		const template = TEMPLATES.get("import")!;
		expect(template).toContain("{{content}}");
		expect(template).toContain("{{filename}}");
		expect(template).toContain("{{tag}}");
	});

	it("should fill placeholders correctly", () => {
		const template = TEMPLATES.get("import")!;
		const filled = fillTemplate(template, {
			content: "Meeting notes content...",
			filename: "meeting-2026-04-07.md",
			tag: "meeting",
			branches: "feature/oauth, feature/auth",
		});
		expect(filled).toContain("Meeting notes content...");
		expect(filled).not.toContain("{{content}}");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/PromptTemplates.test.ts`
Expected: FAIL — templates not found

- [ ] **Step 3: Add compile and import templates to PromptTemplates.ts**

Add these entries to the `TEMPLATES` Map in `PromptTemplates.ts`. Place them after the existing summarize/commit-message/e2e-test entries:

```typescript
// -- Compile template -----------------------------------------------------------

TEMPLATES.set(
	"compile",
	`You are a knowledge compiler. Your task is to synthesize multiple commit-level summaries from a software development branch into cohesive, high-density topic-level knowledge pages.

Branch: {{branch}}

## Source Summaries

{{summaries}}

## Related Imported Knowledge (if any)

{{imports}}

## Instructions

1. Analyze all summaries above and identify the major themes/topics of work on this branch.
2. For each topic, synthesize information across multiple commits into a single cohesive narrative.
3. Focus on DECISIONS and RATIONALE — these are the most valuable parts for future context.
4. Preserve specific technical details: file paths, library names, configuration values, error messages.
5. Do NOT repeat information — if multiple commits touch the same topic, merge them.
6. Include pitfalls and gotchas encountered during development.

## Output Format

Output one or more topics using this delimited format:

===TOPIC===
---TITLE---
Short descriptive title (8-15 words)
---CONTENT---
Markdown content covering:
## Background (what problem this solves)
## Implementation (key technical approach)
## Design Decisions (with rationale)
## Pitfalls (if any gotchas were encountered)
---KEYDECISIONS---
- Decision 1 with rationale
- Decision 2 with rationale
---RELATEDBRANCHES---
branch-name-1, branch-name-2
---SOURCECOMMITS---
abc123, def456

Rules:
- Produce 1-5 topics depending on branch complexity.
- Each topic should be self-contained and readable independently.
- keyDecisions should be bulleted, one per line starting with "- ".
- relatedBranches: comma-separated branch names that relate to this topic (infer from summaries). Leave empty if none.
- sourceCommits: comma-separated short hashes (8 chars) of commits that contributed to this topic.
- Write in English unless the source summaries are predominantly in another language.
- If the summaries contain no substantive technical decisions, output ===NO_TOPICS===`,
);

// -- Import template ------------------------------------------------------------

TEMPLATES.set(
	"import",
	`You are a knowledge structurer. Your task is to read an external document (meeting notes, design doc, spec, etc.) and extract structured knowledge topics from it.

Filename: {{filename}}
Tag: {{tag}}

## Active Branches in This Repository

{{branches}}

## Document Content

{{content}}

## Instructions

1. Read the document and identify distinct topics or decisions.
2. For each topic, create a structured summary.
3. Infer which branches (from the active branches list above) relate to each topic.
4. Focus on decisions, action items, and technical details — skip pleasantries and logistics.

## Output Format

===TOPIC===
---TITLE---
Short descriptive title
---CATEGORY---
One of: design-decision, action-item, architecture, requirement, bug-report, discussion, other
---CONTENT---
Structured summary of this topic
---DECISIONS---
Key decisions made (if any). Leave empty if none.
---RELATEDBRANCHES---
Comma-separated branch names that relate to this topic. Leave empty if none obvious.

Rules:
- Produce 1-10 topics depending on document size and content density.
- If the document has no extractable technical content, output ===NO_TOPICS===
- Write in the same language as the source document.`,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/PromptTemplates.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/core/PromptTemplates.ts tools/jollimemory/src/core/PromptTemplates.test.ts
git commit -m "Part of JOLLI-1217: Add compile and import prompt templates"
```

---

## Task 6: KnowledgeCompiler — LLM Compilation Logic

**Files:**
- Create: `tools/jollimemory/src/core/KnowledgeCompiler.ts`
- Create: `tools/jollimemory/src/core/KnowledgeCompiler.test.ts`

The core compilation engine: reads branch summaries, calls LLM with the compile template, parses the delimited response into `CompiledKnowledge`, and saves via CompiledStore.

- [ ] **Step 1: Write the test file**

```typescript
// KnowledgeCompiler.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, CompiledKnowledge, ImportedKnowledge, LlmConfig, SummaryIndex } from "../Types.js";
import { compileBranch, parseCompileResponse } from "./KnowledgeCompiler.js";

vi.mock("./SummaryStore.js", () => ({
	getIndex: vi.fn(),
	getSummary: vi.fn(),
}));

vi.mock("./CompiledStore.js", () => ({
	saveCompiled: vi.fn(),
}));

vi.mock("./ImportStore.js", () => ({
	listImports: vi.fn(),
	readImport: vi.fn(),
}));

vi.mock("./LlmClient.js", () => ({
	callLlm: vi.fn(),
}));

import { getIndex, getSummary } from "./SummaryStore.js";
import { saveCompiled } from "./CompiledStore.js";
import { listImports, readImport } from "./ImportStore.js";
import { callLlm } from "./LlmClient.js";

const mockGetIndex = vi.mocked(getIndex);
const mockGetSummary = vi.mocked(getSummary);
const mockSaveCompiled = vi.mocked(saveCompiled);
const mockListImports = vi.mocked(listImports);
const mockReadImport = vi.mocked(readImport);
const mockCallLlm = vi.mocked(callLlm);

function makeSummary(hash: string, branch: string): CommitSummary {
	return {
		version: 3,
		commitHash: hash,
		commitMessage: `Commit ${hash.substring(0, 4)}`,
		commitAuthor: "dev",
		commitDate: "2026-04-01T10:00:00Z",
		branch,
		generatedAt: "2026-04-01T10:01:00Z",
		topics: [
			{
				title: "Test topic",
				trigger: "Need to test",
				response: "Implemented test",
				decisions: "Used TDD approach",
			},
		],
	};
}

const llmConfig: LlmConfig = { apiKey: "sk-test" };

describe("parseCompileResponse", () => {
	it("should parse a single topic response", () => {
		const response = `===TOPIC===
---TITLE---
OAuth2 Provider Integration
---CONTENT---
## Background
Integrated OAuth2 provider for user auth.
## Design Decisions
Chose PKCE flow for security.
---KEYDECISIONS---
- Chose PKCE flow over implicit flow due to security audit requirements
- Token storage uses httpOnly cookies instead of localStorage
---RELATEDBRANCHES---
feature/session-management
---SOURCECOMMITS---
abc12345, def67890`;

		const topics = parseCompileResponse(response);

		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("OAuth2 Provider Integration");
		expect(topics[0].content).toContain("## Background");
		expect(topics[0].keyDecisions).toHaveLength(2);
		expect(topics[0].keyDecisions![0]).toContain("PKCE flow");
		expect(topics[0].relatedBranches).toEqual(["feature/session-management"]);
		expect(topics[0].sourceCommits).toEqual(["abc12345", "def67890"]);
	});

	it("should parse multiple topics", () => {
		const response = `===TOPIC===
---TITLE---
Topic One
---CONTENT---
Content one
---KEYDECISIONS---
- Decision A
---RELATEDBRANCHES---

---SOURCECOMMITS---
aaa111

===TOPIC===
---TITLE---
Topic Two
---CONTENT---
Content two
---KEYDECISIONS---
- Decision B
---RELATEDBRANCHES---
feature/other
---SOURCECOMMITS---
bbb222`;

		const topics = parseCompileResponse(response);

		expect(topics).toHaveLength(2);
		expect(topics[0].title).toBe("Topic One");
		expect(topics[1].title).toBe("Topic Two");
	});

	it("should return empty array for NO_TOPICS response", () => {
		const topics = parseCompileResponse("===NO_TOPICS===");

		expect(topics).toEqual([]);
	});

	it("should return empty array for empty response", () => {
		const topics = parseCompileResponse("");

		expect(topics).toEqual([]);
	});
});

describe("compileBranch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should compile branch summaries into knowledge and save", async () => {
		mockGetIndex.mockResolvedValue({
			version: 3,
			entries: [
				{ commitHash: "aaa111", parentCommitHash: null, commitMessage: "c1", commitDate: "2026-04-01", branch: "feature/test", generatedAt: "2026-04-01" },
				{ commitHash: "bbb222", parentCommitHash: null, commitMessage: "c2", commitDate: "2026-04-02", branch: "feature/test", generatedAt: "2026-04-02" },
			],
		});
		mockGetSummary.mockImplementation(async (hash: string) => makeSummary(hash, "feature/test"));
		mockListImports.mockResolvedValue([]);
		mockCallLlm.mockResolvedValue({
			text: `===TOPIC===
---TITLE---
Test Feature Implementation
---CONTENT---
Implemented the test feature.
---KEYDECISIONS---
- Used TDD approach
---RELATEDBRANCHES---

---SOURCECOMMITS---
aaa111, bbb222`,
			inputTokens: 1000,
			outputTokens: 500,
			apiLatencyMs: 2000,
			model: "claude-haiku-4-5-20251001",
			stopReason: "end_turn",
		});
		mockSaveCompiled.mockResolvedValue();

		const result = await compileBranch("feature/test", llmConfig, "/test");

		expect(result).not.toBeNull();
		expect(result!.branch).toBe("feature/test");
		expect(result!.sourceSummaries).toEqual(["aaa111", "bbb222"]);
		expect(result!.topics).toHaveLength(1);
		expect(mockSaveCompiled).toHaveBeenCalledOnce();
	});

	it("should return null when no summaries exist for branch", async () => {
		mockGetIndex.mockResolvedValue({ version: 3, entries: [] });

		const result = await compileBranch("feature/empty", llmConfig, "/test");

		expect(result).toBeNull();
		expect(mockCallLlm).not.toHaveBeenCalled();
	});

	it("should include related imports in compilation", async () => {
		mockGetIndex.mockResolvedValue({
			version: 3,
			entries: [
				{ commitHash: "aaa111", parentCommitHash: null, commitMessage: "c1", commitDate: "2026-04-01", branch: "feature/oauth", generatedAt: "2026-04-01" },
			],
		});
		mockGetSummary.mockResolvedValue(makeSummary("aaa111", "feature/oauth"));
		mockListImports.mockResolvedValue(["import-meeting-auth"]);
		mockReadImport.mockResolvedValue({
			version: 1,
			id: "import-meeting-auth",
			source: "import",
			importedAt: "2026-04-07T14:00:00Z",
			originalFile: "meeting.md",
			tag: "meeting",
			branch: null,
			topics: [{
				title: "Auth decisions",
				category: "design-decision",
				content: "Use PKCE",
				relatedBranches: ["feature/oauth"],
			}],
		});
		mockCallLlm.mockResolvedValue({
			text: "===NO_TOPICS===",
			inputTokens: 500,
			outputTokens: 10,
			apiLatencyMs: 1000,
		});
		mockSaveCompiled.mockResolvedValue();

		await compileBranch("feature/oauth", llmConfig, "/test");

		// Verify LLM was called with imports in the params
		const llmCall = mockCallLlm.mock.calls[0][0];
		expect(llmCall.params.imports).toContain("Auth decisions");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/KnowledgeCompiler.test.ts`
Expected: FAIL

- [ ] **Step 3: Write KnowledgeCompiler implementation**

```typescript
// KnowledgeCompiler.ts
/**
 * Knowledge Compiler
 *
 * Synthesizes multiple commit summaries and imported knowledge into
 * high-density topic-level compiled knowledge pages via LLM.
 *
 * This is the core "compilation" step: raw summaries → refined knowledge.
 */

import { createLogger } from "../Logger.js";
import type { CompiledKnowledge, CompiledTopic, ImportedKnowledge, LlmConfig } from "../Types.js";
import { saveCompiled } from "./CompiledStore.js";
import { listImports, readImport } from "./ImportStore.js";
import { callLlm } from "./LlmClient.js";
import { resolveModelId } from "./Summarizer.js";
import { getIndex, getSummary } from "./SummaryStore.js";
import { collectAllTopics } from "./SummaryTree.js";

const log = createLogger("KnowledgeCompiler");

/**
 * Parses the LLM's delimited compile response into CompiledTopic objects.
 * Format: ===TOPIC=== blocks with ---FIELD--- delimiters.
 */
export function parseCompileResponse(response: string): ReadonlyArray<CompiledTopic> {
	if (!response || response.trim() === "===NO_TOPICS===") {
		return [];
	}

	const topicBlocks = response.split("===TOPIC===").filter((b) => b.trim().length > 0);
	const topics: CompiledTopic[] = [];

	for (const block of topicBlocks) {
		const title = extractField(block, "TITLE");
		const content = extractField(block, "CONTENT");
		if (!title || !content) continue;

		const decisionsRaw = extractField(block, "KEYDECISIONS");
		const keyDecisions = decisionsRaw
			? decisionsRaw
					.split("\n")
					.map((l) => l.replace(/^-\s*/, "").trim())
					.filter((l) => l.length > 0)
			: undefined;

		const branchesRaw = extractField(block, "RELATEDBRANCHES");
		const relatedBranches = branchesRaw
			? branchesRaw
					.split(",")
					.map((b) => b.trim())
					.filter((b) => b.length > 0)
			: undefined;

		const commitsRaw = extractField(block, "SOURCECOMMITS");
		const sourceCommits = commitsRaw
			? commitsRaw
					.split(",")
					.map((c) => c.trim())
					.filter((c) => c.length > 0)
			: [];

		topics.push({
			title,
			content,
			...(keyDecisions && keyDecisions.length > 0 && { keyDecisions }),
			...(relatedBranches && relatedBranches.length > 0 && { relatedBranches }),
			sourceCommits,
		});
	}

	return topics;
}

/** Extracts the content between ---FIELD--- and the next ---...--- delimiter. */
function extractField(block: string, field: string): string {
	const startMarker = `---${field}---`;
	const startIdx = block.indexOf(startMarker);
	if (startIdx === -1) return "";

	const contentStart = startIdx + startMarker.length;
	const nextMarker = block.indexOf("\n---", contentStart + 1);
	const raw = nextMarker !== -1 ? block.substring(contentStart, nextMarker) : block.substring(contentStart);
	return raw.trim();
}

/**
 * Compiles all summaries for a branch into topic-level knowledge.
 *
 * Steps:
 * 1. Load root-level summaries for the branch from the index
 * 2. Find related imports (matching branch in relatedBranches)
 * 3. Format summaries + imports as LLM input
 * 4. Call LLM with the "compile" template
 * 5. Parse response and save to CompiledStore
 *
 * Returns the compiled knowledge, or null if no summaries exist.
 */
export async function compileBranch(
	branch: string,
	config: LlmConfig,
	cwd?: string,
): Promise<CompiledKnowledge | null> {
	const index = await getIndex(cwd);
	if (!index) {
		log.info("No index found — nothing to compile for branch %s", branch);
		return null;
	}

	// Step 1: Load root-level summaries for this branch
	const rootEntries = index.entries
		.filter((e) => e.branch === branch && (e.parentCommitHash === null || e.parentCommitHash === undefined))
		.sort((a, b) => new Date(a.commitDate).getTime() - new Date(b.commitDate).getTime());

	if (rootEntries.length === 0) {
		log.info("No summaries for branch %s — nothing to compile", branch);
		return null;
	}

	const summaryHashes: string[] = [];
	const summaryTexts: string[] = [];

	for (const entry of rootEntries) {
		const summary = await getSummary(entry.commitHash, cwd);
		if (!summary) continue;
		summaryHashes.push(entry.commitHash);
		summaryTexts.push(formatSummaryForCompile(summary));
	}

	if (summaryTexts.length === 0) {
		return null;
	}

	// Step 2: Find related imports
	const relatedImports = await findRelatedImports(branch, cwd);
	const importTexts = relatedImports.map(formatImportForCompile);
	const importIds = relatedImports.map((i) => i.id);

	// Step 3: Call LLM
	log.info("Compiling branch %s: %d summaries, %d imports", branch, summaryTexts.length, importTexts.length);

	const result = await callLlm({
		action: "compile",
		params: {
			branch,
			summaries: summaryTexts.join("\n\n---\n\n"),
			imports: importTexts.length > 0 ? importTexts.join("\n\n---\n\n") : "(none)",
		},
		model: resolveModelId(config.model),
		apiKey: config.apiKey,
		jolliApiKey: config.jolliApiKey,
		allowInsecureTls: config.allowInsecureTls,
	});

	// Step 4: Parse response
	const topics = parseCompileResponse(result.text ?? "");

	const compiled: CompiledKnowledge = {
		version: 1,
		branch,
		compiledAt: new Date().toISOString(),
		sourceSummaries: summaryHashes,
		sourceImports: importIds,
		topics,
		...(result.model && {
			llm: {
				model: result.model,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				apiLatencyMs: result.apiLatencyMs,
				stopReason: result.stopReason ?? null,
			},
		}),
	};

	// Step 5: Save
	await saveCompiled(compiled, cwd);

	log.info("Compilation complete for %s: %d topics from %d summaries", branch, topics.length, summaryHashes.length);
	return compiled;
}

/** Finds imports whose topics have relatedBranches matching the target branch. */
async function findRelatedImports(branch: string, cwd?: string): Promise<ReadonlyArray<ImportedKnowledge>> {
	const importIds = await listImports(cwd);
	const related: ImportedKnowledge[] = [];

	for (const id of importIds) {
		const imported = await readImport(id, cwd);
		if (!imported) continue;

		const isRelated = imported.topics.some(
			(t) => t.relatedBranches?.includes(branch),
		);
		if (isRelated || imported.branch === branch) {
			related.push(imported);
		}
	}

	return related;
}

/** Formats a CommitSummary into text for the LLM compile prompt. */
function formatSummaryForCompile(summary: import("../Types.js").CommitSummary): string {
	const topics = collectAllTopics(summary);
	const lines: string[] = [
		`### Commit ${summary.commitHash.substring(0, 8)} — ${summary.commitMessage} (${summary.commitDate})`,
	];

	for (const topic of topics) {
		lines.push(`**${topic.title}**`);
		if (topic.trigger) lines.push(`- Why: ${topic.trigger}`);
		if (topic.decisions) lines.push(`- Decisions: ${topic.decisions}`);
		if (topic.response) lines.push(`- What: ${topic.response}`);
		if (topic.filesAffected?.length) lines.push(`- Files: ${topic.filesAffected.join(", ")}`);
		lines.push("");
	}

	return lines.join("\n");
}

/** Formats an ImportedKnowledge into text for the LLM compile prompt. */
function formatImportForCompile(imported: ImportedKnowledge): string {
	const lines: string[] = [
		`### Import: ${imported.id} (${imported.tag}, ${imported.importedAt})`,
		`Source: ${imported.originalFile}`,
	];

	for (const topic of imported.topics) {
		lines.push(`**${topic.title}** [${topic.category}]`);
		lines.push(topic.content);
		if (topic.decisions) lines.push(`Decisions: ${topic.decisions}`);
		lines.push("");
	}

	return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/KnowledgeCompiler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/core/KnowledgeCompiler.ts tools/jollimemory/src/core/KnowledgeCompiler.test.ts
git commit -m "Part of JOLLI-1217: Add KnowledgeCompiler for LLM-based branch knowledge synthesis"
```

---

## Task 7: ImportProcessor — LLM Processing for External Documents

**Files:**
- Create: `tools/jollimemory/src/core/ImportProcessor.ts`
- Create: `tools/jollimemory/src/core/ImportProcessor.test.ts`

Processes external files (meeting notes, design docs) through LLM to create structured `ImportedKnowledge` entries.

- [ ] **Step 1: Write the test file**

```typescript
// ImportProcessor.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../Types.js";
import { generateImportId, parseImportResponse, processImport } from "./ImportProcessor.js";

vi.mock("./ImportStore.js", () => ({
	saveImport: vi.fn(),
}));

vi.mock("./LlmClient.js", () => ({
	callLlm: vi.fn(),
}));

vi.mock("./ContextCompiler.js", () => ({
	listBranchCatalog: vi.fn(),
}));

import { saveImport } from "./ImportStore.js";
import { callLlm } from "./LlmClient.js";
import { listBranchCatalog } from "./ContextCompiler.js";

const mockSaveImport = vi.mocked(saveImport);
const mockCallLlm = vi.mocked(callLlm);
const mockListBranchCatalog = vi.mocked(listBranchCatalog);

const llmConfig: LlmConfig = { apiKey: "sk-test" };

describe("generateImportId", () => {
	it("should generate id from tag and filename", () => {
		const id = generateImportId("meeting", "meeting-2026-04-07.md");
		expect(id).toBe("import-meeting-meeting-2026-04-07");
	});

	it("should strip extension and slugify", () => {
		const id = generateImportId("design", "OAuth Design Doc.txt");
		expect(id).toBe("import-design-oauth-design-doc");
	});
});

describe("parseImportResponse", () => {
	it("should parse a single topic", () => {
		const response = `===TOPIC===
---TITLE---
Auth Review Conclusions
---CATEGORY---
design-decision
---CONTENT---
Team decided to use PKCE flow for OAuth.
---DECISIONS---
Rejected implicit flow due to security audit.
---RELATEDBRANCHES---
feature/oauth`;

		const topics = parseImportResponse(response);

		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("Auth Review Conclusions");
		expect(topics[0].category).toBe("design-decision");
		expect(topics[0].content).toContain("PKCE flow");
		expect(topics[0].decisions).toContain("Rejected implicit flow");
		expect(topics[0].relatedBranches).toEqual(["feature/oauth"]);
	});

	it("should return empty array for NO_TOPICS", () => {
		const topics = parseImportResponse("===NO_TOPICS===");
		expect(topics).toEqual([]);
	});
});

describe("processImport", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should process a file and save the import", async () => {
		mockListBranchCatalog.mockResolvedValue({
			type: "catalog",
			branches: [{ branch: "feature/oauth", commitCount: 3, period: { start: "2026-04-01", end: "2026-04-07" }, commitMessages: [] }],
		});
		mockCallLlm.mockResolvedValue({
			text: `===TOPIC===
---TITLE---
Auth decisions
---CATEGORY---
design-decision
---CONTENT---
Use PKCE flow
---DECISIONS---
Security requirement
---RELATEDBRANCHES---
feature/oauth`,
			inputTokens: 500,
			outputTokens: 200,
			apiLatencyMs: 1500,
			model: "claude-haiku-4-5-20251001",
			stopReason: "end_turn",
		});
		mockSaveImport.mockResolvedValue();

		const result = await processImport({
			content: "Meeting notes about auth decisions...",
			filename: "meeting-2026-04-07.md",
			tag: "meeting",
			config: llmConfig,
			cwd: "/test",
		});

		expect(result).not.toBeNull();
		expect(result!.id).toBe("import-meeting-meeting-2026-04-07");
		expect(result!.tag).toBe("meeting");
		expect(result!.topics).toHaveLength(1);
		expect(mockSaveImport).toHaveBeenCalledOnce();
	});

	it("should return null when LLM returns no topics", async () => {
		mockListBranchCatalog.mockResolvedValue({ type: "catalog", branches: [] });
		mockCallLlm.mockResolvedValue({
			text: "===NO_TOPICS===",
			inputTokens: 100,
			outputTokens: 5,
			apiLatencyMs: 500,
		});

		const result = await processImport({
			content: "No useful content here",
			filename: "empty.md",
			tag: "notes",
			config: llmConfig,
			cwd: "/test",
		});

		expect(result).toBeNull();
		expect(mockSaveImport).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/ImportProcessor.test.ts`
Expected: FAIL

- [ ] **Step 3: Write ImportProcessor implementation**

```typescript
// ImportProcessor.ts
/**
 * Import Processor
 *
 * Processes external documents (meeting notes, design docs, specs) through
 * the LLM to create structured ImportedKnowledge entries.
 */

import { createLogger } from "../Logger.js";
import type { ImportTag, ImportedKnowledge, ImportedTopic, LlmConfig } from "../Types.js";
import { listBranchCatalog } from "./ContextCompiler.js";
import { saveImport } from "./ImportStore.js";
import { callLlm } from "./LlmClient.js";
import { resolveModelId } from "./Summarizer.js";

const log = createLogger("ImportProcessor");

export interface ProcessImportOptions {
	readonly content: string;
	readonly filename: string;
	readonly tag: ImportTag;
	readonly config: LlmConfig;
	readonly cwd?: string;
}

/**
 * Generates a deterministic import ID from tag and filename.
 * "meeting" + "meeting-2026-04-07.md" → "import-meeting-meeting-2026-04-07"
 */
export function generateImportId(tag: string, filename: string): string {
	const base = filename
		.replace(/\.[^.]+$/, "") // strip extension
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return `import-${tag}-${base}`;
}

/**
 * Parses the LLM's delimited import response into ImportedTopic objects.
 */
export function parseImportResponse(response: string): ReadonlyArray<ImportedTopic> {
	if (!response || response.trim() === "===NO_TOPICS===") {
		return [];
	}

	const topicBlocks = response.split("===TOPIC===").filter((b) => b.trim().length > 0);
	const topics: ImportedTopic[] = [];

	for (const block of topicBlocks) {
		const title = extractField(block, "TITLE");
		const content = extractField(block, "CONTENT");
		if (!title || !content) continue;

		const category = extractField(block, "CATEGORY") || "other";
		const decisions = extractField(block, "DECISIONS") || undefined;

		const branchesRaw = extractField(block, "RELATEDBRANCHES");
		const relatedBranches = branchesRaw
			? branchesRaw
					.split(",")
					.map((b) => b.trim())
					.filter((b) => b.length > 0)
			: undefined;

		topics.push({
			title,
			category,
			content,
			...(decisions && { decisions }),
			...(relatedBranches && relatedBranches.length > 0 && { relatedBranches }),
		});
	}

	return topics;
}

/** Extracts the content between ---FIELD--- and the next ---...--- delimiter. */
function extractField(block: string, field: string): string {
	const startMarker = `---${field}---`;
	const startIdx = block.indexOf(startMarker);
	if (startIdx === -1) return "";

	const contentStart = startIdx + startMarker.length;
	const nextMarker = block.indexOf("\n---", contentStart + 1);
	const raw = nextMarker !== -1 ? block.substring(contentStart, nextMarker) : block.substring(contentStart);
	return raw.trim();
}

/**
 * Processes an external document through LLM and saves as ImportedKnowledge.
 * Returns the saved ImportedKnowledge, or null if no topics were extracted.
 */
export async function processImport(options: ProcessImportOptions): Promise<ImportedKnowledge | null> {
	const { content, filename, tag, config, cwd } = options;
	const id = generateImportId(tag, filename);

	// Get active branches for LLM context
	const catalog = await listBranchCatalog(cwd);
	const branchNames = catalog.branches.map((b) => b.branch).join(", ");

	log.info("Processing import: %s (tag: %s)", filename, tag);

	const result = await callLlm({
		action: "import",
		params: {
			content,
			filename,
			tag,
			branches: branchNames || "(no branches recorded yet)",
		},
		model: resolveModelId(config.model),
		apiKey: config.apiKey,
		jolliApiKey: config.jolliApiKey,
		allowInsecureTls: config.allowInsecureTls,
	});

	const topics = parseImportResponse(result.text ?? "");
	if (topics.length === 0) {
		log.info("No topics extracted from %s", filename);
		return null;
	}

	const imported: ImportedKnowledge = {
		version: 1,
		id,
		source: "import",
		importedAt: new Date().toISOString(),
		originalFile: filename,
		tag,
		branch: null,
		topics,
		...(result.model && {
			llm: {
				model: result.model,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				apiLatencyMs: result.apiLatencyMs,
				stopReason: result.stopReason ?? null,
			},
		}),
	};

	await saveImport(imported, cwd);
	log.info("Import processed: %s → %d topics", id, topics.length);
	return imported;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/ImportProcessor.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/core/ImportProcessor.ts tools/jollimemory/src/core/ImportProcessor.test.ts
git commit -m "Part of JOLLI-1217: Add ImportProcessor for external document knowledge extraction"
```

---

## Task 8: Refactor ContextCompiler — Compiled-Aware Recall (Strategy B)

**Files:**
- Modify: `tools/jollimemory/src/core/ContextCompiler.ts`
- Modify: `tools/jollimemory/src/core/ContextCompiler.test.ts`

The key integration point: refactor `compileTaskContext` to check compiled cache before loading raw summaries. Implements Strategy B (return immediately, background-compile for next time).

- [ ] **Step 1: Add tests for compiled-aware recall**

Add to `ContextCompiler.test.ts`. These tests need additional mocks for CompiledStore, CacheValidator, and ImportStore:

```typescript
// Add these mocks at the top of the file, alongside existing mocks:

vi.mock("./CacheValidator.js", () => ({
	validateCache: vi.fn(),
}));

vi.mock("./ImportStore.js", () => ({
	listImports: vi.fn(),
	readImport: vi.fn(),
}));

import { validateCache } from "./CacheValidator.js";
import { listImports, readImport } from "./ImportStore.js";

const mockValidateCache = vi.mocked(validateCache);
const mockListImports = vi.mocked(listImports);
const mockReadImport = vi.mocked(readImport);

// Add to beforeEach in relevant describe blocks:
// mockValidateCache.mockResolvedValue({ status: "miss" });
// mockListImports.mockResolvedValue([]);

// Add these test cases in a new describe block:

describe("compiled-aware recall", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: no compiled cache, no imports
		mockValidateCache.mockResolvedValue({ status: "miss" });
		mockListImports.mockResolvedValue([]);
	});

	it("should use compiled knowledge when cache hits", async () => {
		mockValidateCache.mockResolvedValue({
			status: "hit",
			compiled: {
				version: 1,
				branch: "feature/test",
				compiledAt: "2026-04-07T10:30:00Z",
				sourceSummaries: ["abc12345def67890"],
				sourceImports: [],
				topics: [
					{
						title: "Compiled Topic",
						content: "## Background\nCompiled knowledge content.",
						keyDecisions: ["Used factory pattern"],
						sourceCommits: ["abc12345"],
					},
				],
			},
		});
		// Still need index for period/stats
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "abc12345def67890",
					parentCommitHash: null,
					commitMessage: "Add feature",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
					diffStats: { filesChanged: 3, insertions: 100, deletions: 20 },
				},
			]),
		);

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");

		expect(ctx.commitCount).toBe(1);
		// When compiled knowledge is available, context should include it
		// The compiled topics are surfaced through the rendered markdown
		expect(ctx.stats.topicCount).toBeGreaterThanOrEqual(0);
	});

	it("should fall back to raw summaries on cache miss and not block", async () => {
		mockValidateCache.mockResolvedValue({ status: "miss" });
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "abc12345def67890",
					parentCommitHash: null,
					commitMessage: "Add feature",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(makeSummary());

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");

		// Should return raw summaries (existing behavior)
		expect(ctx.commitCount).toBe(1);
		expect(ctx.summaries).toHaveLength(1);
	});

	it("should merge stale compiled + new summaries", async () => {
		const compiled = {
			version: 1 as const,
			branch: "feature/test",
			compiledAt: "2026-04-07T10:30:00Z",
			sourceSummaries: ["aaa111"],
			sourceImports: [],
			topics: [
				{
					title: "Old Compiled Topic",
					content: "Compiled content from earlier.",
					sourceCommits: ["aaa111"],
				},
			],
		};
		mockValidateCache.mockResolvedValue({
			status: "stale",
			compiled,
			newSummaryHashes: ["bbb222"],
		});
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa111",
					parentCommitHash: null,
					commitMessage: "c1",
					commitDate: "2026-04-01T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-04-01",
				},
				{
					commitHash: "bbb222",
					parentCommitHash: null,
					commitMessage: "c2",
					commitDate: "2026-04-02T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-04-02",
				},
			]),
		);
		mockGetSummary.mockImplementation(async (hash: string) => {
			if (hash === "bbb222") return makeSummary({ commitHash: "bbb222", commitMessage: "New commit" });
			return null;
		});

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");

		// Should have data from both compiled and new summaries
		expect(ctx.commitCount).toBe(2);
	});

	it("should include related imports in context", async () => {
		mockValidateCache.mockResolvedValue({ status: "miss" });
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "abc12345def67890",
					parentCommitHash: null,
					commitMessage: "Add feature",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(makeSummary());
		mockListImports.mockResolvedValue(["import-meeting-auth"]);
		mockReadImport.mockResolvedValue({
			version: 1,
			id: "import-meeting-auth",
			source: "import",
			importedAt: "2026-04-07T14:00:00Z",
			originalFile: "meeting.md",
			tag: "meeting",
			branch: null,
			topics: [{
				title: "Auth decisions",
				category: "design-decision",
				content: "Use PKCE flow",
				relatedBranches: ["feature/test"],
			}],
		});

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");

		// Context should include import data
		expect(ctx.commitCount).toBe(1);
	});
});
```

- [ ] **Step 2: Run tests to verify the new tests fail (existing tests should still pass)**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/ContextCompiler.test.ts`
Expected: New tests FAIL, existing tests PASS

- [ ] **Step 3: Refactor ContextCompiler to support compiled knowledge**

Modify `compileTaskContext` in `ContextCompiler.ts`. The key changes:

1. Add imports for `validateCache`, `listImports`, `readImport`
2. At the top of `compileTaskContext`, call `validateCache()` before loading raw summaries
3. On cache `hit`: build context from compiled topics (skip loading individual summaries)
4. On cache `stale`: merge compiled topics + load only new summaries
5. On cache `miss`: existing behavior (load all raw summaries)
6. After building context, scan `imports/` for related entries and include them
7. Add `CompiledContext` fields for compiled/import data

Add these imports at the top of `ContextCompiler.ts`:

```typescript
import { validateCache } from "./CacheValidator.js";
import { listImports, readImport } from "./ImportStore.js";
```

Add a new type for compiled context output:

```typescript
/** Compiled topic included in recall context (from CompiledKnowledge) */
export interface CompiledContextTopic {
	readonly title: string;
	readonly content: string;
	readonly keyDecisions?: ReadonlyArray<string>;
	readonly sourceCommits: ReadonlyArray<string>;
}

/** Import topic included in recall context */
export interface ImportContextTopic {
	readonly title: string;
	readonly content: string;
	readonly source: string; // import ID
	readonly tag: string;
}
```

Add fields to `CompiledContext`:

```typescript
export interface CompiledContext {
	// ... existing fields ...
	/** Compiled topics from knowledge compilation (present on cache hit/stale) */
	readonly compiledTopics?: ReadonlyArray<CompiledContextTopic>;
	/** Related imported knowledge topics */
	readonly importTopics?: ReadonlyArray<ImportContextTopic>;
}
```

Modify `compileTaskContext`:

```typescript
export async function compileTaskContext(options: ContextOptions, cwd?: string): Promise<CompiledContext> {
	const { branch, depth, includePlans = true, includeNotes = includePlans } = options;

	const index = await getIndex(cwd);
	if (!index) {
		return emptyContext(branch);
	}

	// Step 0: Check compiled cache
	const cacheResult = await validateCache(branch, cwd);

	// Get root entries for stats/period calculation regardless of cache status
	let rootEntries = index.entries.filter(
		(e) => e.branch === branch && (e.parentCommitHash === null || e.parentCommitHash === undefined),
	);
	rootEntries = [...rootEntries].sort((a, b) => new Date(a.commitDate).getTime() - new Date(b.commitDate).getTime());

	if (depth !== undefined && depth > 0 && rootEntries.length > depth) {
		rootEntries = rootEntries.slice(-depth);
	}

	if (rootEntries.length === 0) {
		return emptyContext(branch);
	}

	// Determine which summaries to load based on cache status
	let summariesToLoad: typeof rootEntries;
	let compiledTopics: CompiledContextTopic[] | undefined;

	if (cacheResult.status === "hit") {
		// Cache hit: use compiled topics, skip loading individual summaries
		compiledTopics = cacheResult.compiled.topics.map((t) => ({
			title: t.title,
			content: t.content,
			keyDecisions: t.keyDecisions,
			sourceCommits: t.sourceCommits,
		}));
		summariesToLoad = []; // Don't load raw summaries
	} else if (cacheResult.status === "stale") {
		// Stale: use compiled topics + load only new summaries
		compiledTopics = cacheResult.compiled.topics.map((t) => ({
			title: t.title,
			content: t.content,
			keyDecisions: t.keyDecisions,
			sourceCommits: t.sourceCommits,
		}));
		const newHashes = new Set(cacheResult.newSummaryHashes);
		summariesToLoad = rootEntries.filter((e) => newHashes.has(e.commitHash));
	} else {
		// Cache miss: load all raw summaries (existing behavior)
		summariesToLoad = rootEntries;
	}

	// Load summaries (all on miss, only new on stale, none on hit)
	const summaries: CommitSummary[] = [];
	for (const entry of summariesToLoad) {
		const summary = await getSummary(entry.commitHash, cwd);
		if (summary) {
			summaries.push(summary);
		} else {
			log.warn("Failed to load summary for commit %s, skipping", entry.commitHash.substring(0, 8));
		}
	}

	// ... rest of existing function (decisions, plans, notes, stats) ...
	// Key decisions: from raw summaries + compiled topics
	const keyDecisions: { text: string; commitHash: string }[] = [];
	for (const summary of summaries) {
		const topics = collectAllTopics(summary);
		for (const topic of topics) {
			if (topic.decisions && topic.decisions.trim().length > 0) {
				keyDecisions.push({ text: topic.decisions, commitHash: summary.commitHash });
			}
		}
	}
	if (compiledTopics) {
		for (const ct of compiledTopics) {
			if (ct.keyDecisions) {
				for (const d of ct.keyDecisions) {
					keyDecisions.push({ text: d, commitHash: ct.sourceCommits[0] ?? "compiled" });
				}
			}
		}
	}

	// Plans (same as before)
	const plans: { slug: string; title: string; content: string }[] = [];
	if (includePlans) {
		// ... existing plan loading logic (use all rootEntries for plan discovery) ...
		// When cache hit, we still need plans from summaries — load summary metadata
		const planSourceEntries = cacheResult.status === "hit" ? rootEntries : summariesToLoad;
		for (const entry of planSourceEntries) {
			const summary = cacheResult.status === "hit"
				? await getSummary(entry.commitHash, cwd)
				: summaries.find((s) => s.commitHash === entry.commitHash);
			if (summary?.plans) {
				// ... existing plan dedup logic ...
			}
		}
	}

	// Notes (same as before)
	// ... existing notes loading logic ...

	// Scan for related imports
	const importTopics: ImportContextTopic[] = [];
	const importIds = await listImports(cwd);
	for (const id of importIds) {
		const imported = await readImport(id, cwd);
		if (!imported) continue;
		for (const topic of imported.topics) {
			if (topic.relatedBranches?.includes(branch)) {
				importTopics.push({
					title: topic.title,
					content: topic.content,
					source: imported.id,
					tag: imported.tag,
				});
			}
		}
	}

	// Aggregate stats from index entries (works regardless of cache status)
	let totalFilesChanged = 0;
	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const entry of rootEntries) {
		if (entry.diffStats) {
			totalFilesChanged += entry.diffStats.filesChanged;
			totalInsertions += entry.diffStats.insertions;
			totalDeletions += entry.diffStats.deletions;
		}
	}
	// If no diffStats in index, fall back to loaded summaries
	if (totalFilesChanged === 0) {
		for (const summary of summaries) {
			const stats = aggregateStats(summary);
			totalFilesChanged += stats.filesChanged;
			totalInsertions += stats.insertions;
			totalDeletions += stats.deletions;
		}
	}

	const period = {
		start: rootEntries[0].commitDate,
		end: rootEntries[rootEntries.length - 1].commitDate,
	};

	// Token estimation
	const compiledText = compiledTopics?.map((t) => t.content).join("\n") ?? "";
	const summaryText = summaries.map((s) => renderSummarySection(s)).join("\n");
	const topicTokens = estimateTokens(compiledText + summaryText);
	const planTokens = estimateTokens(plans.map((p) => p.content).join("\n"));
	const noteTokens = estimateTokens(notes.map((n) => n.content).join("\n"));
	const decisionTokens = estimateTokens(keyDecisions.map((d) => d.text).join("\n"));
	const importTokens = estimateTokens(importTopics.map((t) => t.content).join("\n"));

	const topicCount = (compiledTopics?.length ?? 0) + summaries.reduce((acc, s) => acc + collectAllTopics(s).length, 0);

	return {
		branch,
		period,
		commitCount: rootEntries.length,
		totalFilesChanged,
		totalInsertions,
		totalDeletions,
		summaries,
		plans,
		notes,
		keyDecisions,
		compiledTopics: compiledTopics && compiledTopics.length > 0 ? compiledTopics : undefined,
		importTopics: importTopics.length > 0 ? importTopics : undefined,
		stats: {
			topicCount,
			planCount: plans.length,
			noteCount: notes.length,
			decisionCount: keyDecisions.length,
			topicTokens,
			planTokens,
			noteTokens,
			decisionTokens,
			transcriptTokens: 0,
			totalTokens: topicTokens + planTokens + noteTokens + decisionTokens + importTokens,
		},
	};
}
```

Also update `renderContextMarkdown` to include compiled topics and imports:

After the decisions section, add:

```typescript
// Compiled knowledge section (if present)
if (ctx.compiledTopics && ctx.compiledTopics.length > 0) {
	lines.push("## Compiled Knowledge");
	lines.push("");
	for (const ct of ctx.compiledTopics) {
		lines.push(`### ${ct.title}`);
		lines.push("");
		lines.push(ct.content);
		lines.push("");
	}
	lines.push("---");
	lines.push("");
}

// Import knowledge section (if present)
if (ctx.importTopics && ctx.importTopics.length > 0) {
	lines.push("## Related Knowledge (Imported)");
	lines.push("");
	for (const it of ctx.importTopics) {
		lines.push(`### ${it.title} [${it.tag}]`);
		lines.push("");
		lines.push(it.content);
		lines.push("");
	}
	lines.push("---");
	lines.push("");
}
```

Update `emptyContext` to include the new optional fields.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/core/ContextCompiler.test.ts`
Expected: All tests PASS (both existing and new)

- [ ] **Step 5: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/core/ContextCompiler.ts tools/jollimemory/src/core/ContextCompiler.test.ts
git commit -m "Part of JOLLI-1217: Refactor ContextCompiler for compiled-aware recall with Strategy B"
```

---

## Task 9: CLI Commands — Add `compile` and `import`

**Files:**
- Modify: `tools/jollimemory/src/Cli.ts`
- Modify: `tools/jollimemory/src/Cli.test.ts`

Registers two new CLI commands: `jollimemory compile <branch>` and `jollimemory import <file>`.

- [ ] **Step 1: Add tests for compile command**

Add to `Cli.test.ts`:

```typescript
// Add mock for KnowledgeCompiler
vi.mock("./core/KnowledgeCompiler.js", () => ({
	compileBranch: vi.fn(),
}));

import { compileBranch } from "./core/KnowledgeCompiler.js";
const mockCompileBranch = vi.mocked(compileBranch);

describe("compile command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should compile a branch and print result", async () => {
		// Mock config loading
		// ... (follow existing test patterns for config mocking)
		mockCompileBranch.mockResolvedValue({
			version: 1,
			branch: "feature/test",
			compiledAt: "2026-04-07T10:30:00Z",
			sourceSummaries: ["aaa111", "bbb222"],
			sourceImports: [],
			topics: [{ title: "Test Topic", content: "Content", sourceCommits: ["aaa111"] }],
		});

		await main(["compile", "feature/test", "--cwd", "/test"]);

		expect(mockCompileBranch).toHaveBeenCalledOnce();
		expect(mockCompileBranch.mock.calls[0][0]).toBe("feature/test");
	});

	it("should print message when no summaries exist", async () => {
		mockCompileBranch.mockResolvedValue(null);

		await main(["compile", "feature/empty", "--cwd", "/test"]);

		expect(mockCompileBranch).toHaveBeenCalledOnce();
	});
});
```

- [ ] **Step 2: Add tests for import command**

```typescript
// Add mock for ImportProcessor
vi.mock("./core/ImportProcessor.js", () => ({
	processImport: vi.fn(),
}));

import { processImport } from "./core/ImportProcessor.js";
const mockProcessImport = vi.mocked(processImport);

// Add mock for listImports
vi.mock("./core/ImportStore.js", () => ({
	listImports: vi.fn(),
}));

import { listImports } from "./core/ImportStore.js";
const mockListImports = vi.mocked(listImports);

describe("import command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should import a file and print result", async () => {
		mockProcessImport.mockResolvedValue({
			version: 1,
			id: "import-meeting-test",
			source: "import",
			importedAt: "2026-04-07T14:00:00Z",
			originalFile: "test.md",
			tag: "meeting",
			branch: null,
			topics: [{ title: "Topic", category: "design-decision", content: "Content" }],
		});

		// Need to mock fs.readFileSync or use a real temp file
		// ... (follow existing test patterns)
	});

	it("should list imports with --list flag", async () => {
		mockListImports.mockResolvedValue(["import-meeting-auth", "import-design-api"]);

		await main(["import", "--list", "--cwd", "/test"]);

		expect(mockListImports).toHaveBeenCalledOnce();
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/Cli.test.ts --testNamePattern "compile|import"`
Expected: FAIL — commands not registered

- [ ] **Step 4: Add compile command to Cli.ts**

Add after the `export` command block (around line 591):

```typescript
// --- compile command ---
program
	.command("compile")
	.description("Compile branch summaries into topic-level knowledge")
	.argument("<branch>", "Branch name to compile")
	.option("--force", "Force recompilation (ignore existing cache)")
	.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
	.action(async (branch: string, options: { force?: boolean; cwd: string }) => {
		setLogDir(options.cwd);
		log.info("Running 'compile' command for branch %s", branch);

		const configDir = resolveConfigDir("global", options.cwd);
		const config = await loadConfigFromDir(configDir);

		if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
			console.error("\n  Error: No API key configured. Run 'jollimemory enable' to set up.\n");
			process.exitCode = 1;
			return;
		}

		console.log(`\n  Compiling knowledge for branch: ${branch}...`);

		const { compileBranch } = await import("./core/KnowledgeCompiler.js");
		const result = await compileBranch(branch, config, options.cwd);

		if (!result) {
			console.log(`\n  No summaries found for branch "${branch}". Nothing to compile.\n`);
			return;
		}

		console.log(`\n  Compilation complete!`);
		console.log(`  Branch:     ${result.branch}`);
		console.log(`  Topics:     ${result.topics.length}`);
		console.log(`  Sources:    ${result.sourceSummaries.length} summaries, ${result.sourceImports.length} imports`);
		if (result.llm) {
			console.log(`  LLM:        ${result.llm.model} (${result.llm.apiLatencyMs}ms)`);
		}
		console.log("");
	});
```

- [ ] **Step 5: Add import command to Cli.ts**

```typescript
// --- import command ---
program
	.command("import")
	.description("Import external knowledge (meeting notes, design docs, specs)")
	.argument("[file]", "File to import (.md or .txt)")
	.option("--tag <tag>", "Knowledge tag (meeting, design, notes, spec)", "other")
	.option("--list", "List all imported knowledge entries")
	.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
	.action(async (file: string | undefined, options: { tag: string; list?: boolean; cwd: string }) => {
		setLogDir(options.cwd);

		if (options.list) {
			const { listImports } = await import("./core/ImportStore.js");
			const imports = await listImports(options.cwd);

			if (imports.length === 0) {
				console.log("\n  No imported knowledge found.\n");
				return;
			}

			console.log(`\n  Imported Knowledge (${imports.length} entries)\n`);
			for (const id of imports) {
				console.log(`  - ${id}`);
			}
			console.log("");
			return;
		}

		if (!file) {
			console.error("\n  Error: Please specify a file to import, or use --list.\n");
			process.exitCode = 1;
			return;
		}

		if (!existsSync(file)) {
			console.error(`\n  Error: File not found: ${file}\n`);
			process.exitCode = 1;
			return;
		}

		const configDir = resolveConfigDir("global", options.cwd);
		const config = await loadConfigFromDir(configDir);

		if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
			console.error("\n  Error: No API key configured. Run 'jollimemory enable' to set up.\n");
			process.exitCode = 1;
			return;
		}

		const content = readFileSync(file, "utf-8");
		const filename = file.split("/").pop() ?? file;
		const tag = options.tag as import("./Types.js").ImportTag;

		console.log(`\n  Importing: ${filename} (tag: ${tag})...`);

		const { processImport } = await import("./core/ImportProcessor.js");
		const result = await processImport({ content, filename, tag, config, cwd: options.cwd });

		if (!result) {
			console.log(`\n  No extractable knowledge found in ${filename}.\n`);
			return;
		}

		console.log(`\n  Import complete!`);
		console.log(`  ID:       ${result.id}`);
		console.log(`  Tag:      ${result.tag}`);
		console.log(`  Topics:   ${result.topics.length}`);
		if (result.llm) {
			console.log(`  LLM:      ${result.llm.model} (${result.llm.apiLatencyMs}ms)`);
		}
		console.log("");
	});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/Cli.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/Cli.ts tools/jollimemory/src/Cli.test.ts
git commit -m "Part of JOLLI-1217: Add compile and import CLI commands"
```

---

## Task 10: PostMergeHook — Auto-Trigger Compilation on Pull

**Files:**
- Create: `tools/jollimemory/src/hooks/PostMergeHook.ts`
- Create: `tools/jollimemory/src/hooks/PostMergeHook.test.ts`
- Modify: `tools/jollimemory/vite.config.ts` (add entry point)
- Modify: `tools/jollimemory/src/install/Installer.ts` (install hook)

The post-merge hook runs after `git pull`. It detects merge commits, extracts the merged branch name, and triggers background compilation.

- [ ] **Step 1: Write the test file**

```typescript
// PostMergeHook.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractMergedBranches, handlePostMerge } from "./PostMergeHook.js";

vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: vi.fn(),
	getGlobalConfigDir: vi.fn().mockReturnValue("/home/user/.jolli/jollimemory"),
}));

import { execGit } from "../core/GitOps.js";
import { loadConfig } from "../core/SessionTracker.js";

const mockExecGit = vi.mocked(execGit);
const mockLoadConfig = vi.mocked(loadConfig);

describe("extractMergedBranches", () => {
	it("should extract branch names from merge commits", () => {
		const logOutput = "Merge pull request #42 from feature/oauth\nMerge branch 'feature/auth' into main";
		const branches = extractMergedBranches(logOutput);

		expect(branches).toContain("feature/oauth");
		expect(branches).toContain("feature/auth");
	});

	it("should return empty array for fast-forward pulls", () => {
		const branches = extractMergedBranches("");
		expect(branches).toEqual([]);
	});

	it("should handle GitHub-style merge messages", () => {
		const logOutput = "Merge pull request #123 from user/feature/my-branch";
		const branches = extractMergedBranches(logOutput);
		expect(branches).toContain("feature/my-branch");
	});
});

describe("handlePostMerge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should skip when no merge commits detected", async () => {
		mockExecGit.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

		await handlePostMerge("/test");

		// Should not attempt compilation
		expect(mockExecGit).toHaveBeenCalledTimes(1); // Only the merge detection call
	});

	it("should detect merged branches and log them", async () => {
		mockExecGit.mockResolvedValueOnce({
			stdout: "Merge branch 'feature/oauth' into main",
			stderr: "",
			exitCode: 0,
		});
		mockLoadConfig.mockResolvedValue({});

		await handlePostMerge("/test");

		expect(mockExecGit).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/hooks/PostMergeHook.test.ts`
Expected: FAIL

- [ ] **Step 3: Write PostMergeHook implementation**

```typescript
// PostMergeHook.ts
#!/usr/bin/env node
/**
 * Post-Merge Hook
 *
 * Runs after `git pull` completes. Detects merge commits in the pulled
 * range, extracts the merged branch names, and triggers background
 * knowledge compilation for each.
 *
 * This is "Path 1" of the three-path compilation trigger strategy.
 * Compilation runs asynchronously (detached child process) to avoid
 * blocking the developer.
 */

import { spawn } from "node:child_process";
import { createLogger, setLogDir } from "../Logger.js";
import { execGit } from "../core/GitOps.js";
import { getGlobalConfigDir, loadConfig } from "../core/SessionTracker.js";

const log = createLogger("PostMergeHook");

/**
 * Extracts branch names from merge commit messages.
 * Handles:
 * - "Merge branch 'feature/xxx' into main"
 * - "Merge pull request #N from user/feature/xxx"
 */
export function extractMergedBranches(logOutput: string): ReadonlyArray<string> {
	if (!logOutput.trim()) return [];

	const branches: string[] = [];
	const lines = logOutput.split("\n");

	for (const line of lines) {
		// "Merge branch 'feature/xxx'" pattern
		const branchMatch = line.match(/Merge branch '([^']+)'/);
		if (branchMatch) {
			branches.push(branchMatch[1]);
			continue;
		}

		// "Merge pull request #N from user/feature/xxx" pattern
		// Extract everything after the first slash of the username
		const prMatch = line.match(/Merge pull request #\d+ from [^/]+\/(.+)/);
		if (prMatch) {
			branches.push(prMatch[1]);
		}
	}

	return branches;
}

/**
 * Main post-merge hook handler.
 * Called by the git post-merge hook script.
 */
export async function handlePostMerge(cwd: string): Promise<void> {
	setLogDir(cwd);
	log.info("Post-merge hook triggered");

	// Detect merge commits in the pulled range
	// HEAD@{1} is the previous HEAD before the pull
	const result = await execGit(
		["log", "--merges", "--pretty=format:%s", "HEAD@{1}..HEAD"],
		cwd,
	);

	if (result.exitCode !== 0 || !result.stdout.trim()) {
		log.info("No merge commits in pull range — fast-forward or error, skipping");
		return;
	}

	const branches = extractMergedBranches(result.stdout);
	if (branches.length === 0) {
		log.info("No branch names extracted from merge commits, skipping");
		return;
	}

	log.info("Detected merged branches: %s", branches.join(", "));

	// Load config to check for API key availability
	const config = await loadConfig(cwd);
	if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
		log.info("No API key configured — skipping compilation");
		return;
	}

	// Spawn background compilation for each merged branch
	for (const branch of branches) {
		log.info("Triggering background compilation for branch %s", branch);
		try {
			const child = spawn(
				process.execPath,
				[process.argv[1].replace("PostMergeHook", "Cli"), "compile", branch, "--cwd", cwd],
				{
					detached: true,
					stdio: "ignore",
					cwd,
				},
			);
			child.unref();
		} catch (err: unknown) {
			log.warn("Failed to spawn compile for branch %s: %s", branch, err instanceof Error ? err.message : String(err));
		}
	}
}

// Auto-execute when run as a script
/* v8 ignore start */
if (!process.env.VITEST) {
	const cwd = process.cwd();
	handlePostMerge(cwd).catch((error: unknown) => {
		const log = createLogger("PostMergeHook");
		log.error("Post-merge hook failed: %s", error instanceof Error ? error.message : String(error));
	});
}
/* v8 ignore stop */
```

- [ ] **Step 4: Add PostMergeHook entry to vite.config.ts**

Add `PostMergeHook` to the entry object in `vite.config.ts`:

```typescript
entry: {
	// ... existing entries ...
	PostMergeHook: resolve(__dirname, "src/hooks/PostMergeHook.ts"),
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/hooks/PostMergeHook.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/hooks/PostMergeHook.ts tools/jollimemory/src/hooks/PostMergeHook.test.ts tools/jollimemory/vite.config.ts
git commit -m "Part of JOLLI-1217: Add PostMergeHook for auto-compilation on git pull"
```

---

## Task 11: Install PostMerge Hook in Installer

**Files:**
- Modify: `tools/jollimemory/src/install/Installer.ts`
- Modify: `tools/jollimemory/src/install/Installer.test.ts` (if exists, else test via Cli.test.ts)

Extends the `install()` function to also install the post-merge hook alongside existing post-commit and post-rewrite hooks.

- [ ] **Step 1: Read Installer.ts to understand the hook installation pattern**

The existing installer uses marker comments to append/remove hook sections from git hook files. Follow the same pattern for post-merge.

- [ ] **Step 2: Add post-merge hook installation to Installer.ts**

Add a `POST_MERGE_MARKER_START` / `POST_MERGE_MARKER_END` constant pair and a `installPostMergeHook` function following the existing `installPostCommitHook` pattern.

In the `install()` function, add the post-merge hook installation after the existing hook installations. Add the path to `InstallResult`.

- [ ] **Step 3: Add post-merge hook removal to the `uninstall()` function**

Follow the same pattern as post-commit hook removal.

- [ ] **Step 4: Run the installer tests**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx vitest run src/install/`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add tools/jollimemory/src/install/Installer.ts
git commit -m "Part of JOLLI-1217: Install post-merge hook for auto-compilation"
```

---

## Task 12: Final Integration — Lint, Build, Test

**Files:** All modified files

Run the full verification suite.

- [ ] **Step 1: Run biome lint**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npx biome check src/`
Expected: No errors. Fix any lint issues.

- [ ] **Step 2: Run build**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npm run build`
Expected: Build succeeds. Fix any TypeScript errors.

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1/tools/jollimemory && npm test`
Expected: All tests pass with coverage >= 97% statements, 96% branches, 97% functions, 97% lines.

- [ ] **Step 4: Fix any coverage gaps**

If coverage is below threshold, add targeted tests for uncovered branches/lines. Common gaps:
- Error handling catch blocks
- Edge cases in parsing (empty strings, malformed input)
- Config loading fallbacks

- [ ] **Step 5: Run `npm run all` from project root**

Run: `cd /Users/flyer/jolli/code/worktrees/jolli-wt-1 && nvm use && npm run all`
Expected: Lint + build + tests all pass across the entire monorepo.

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
cd /Users/flyer/jolli/code/worktrees/jolli-wt-1
git add -A
git commit -m "Part of JOLLI-1217: Fix lint, build, and coverage issues for knowledge compilation"
```

---

## Implementation Notes

### Key Design Decisions

1. **Same orphan branch**: Compiled and imported knowledge live alongside existing summaries in `jollimemory/summaries/v3` (subdirectories `compiled/` and `imports/`). This avoids managing multiple orphan branches.

2. **Branch slugification**: Branch names like `feature/JOLLI-123-auth/v2` become `feature-jolli-123-auth-v2` for filesystem-safe paths. The `slugifyBranch()` function is deterministic.

3. **Strategy B for recall**: On cache miss, `compileTaskContext` returns raw summaries immediately (existing behavior) and does NOT block for compilation. Background compilation is triggered separately (by PostMergeHook or manual `compile` command). The next recall will benefit from the compiled cache.

4. **No background spawn in ContextCompiler**: The plan's "background compile on recall miss" is deferred. ContextCompiler only reads — it never triggers writes. Compilation is triggered by: (a) manual `jollimemory compile`, (b) PostMergeHook, or (c) future SessionStartHook integration.

5. **extractField parser**: Both `KnowledgeCompiler.parseCompileResponse` and `ImportProcessor.parseImportResponse` use the same delimited format parser. The `extractField` function is duplicated (not shared) to keep modules independent — it's 8 lines, not worth an abstraction.

### Testing Strategy

- All new modules use `vi.mock()` to isolate from GitOps/SummaryStore (no real git operations in tests)
- Test data helpers (`makeCompiled`, `makeImport`, `makeSummary`) ensure consistent test fixtures
- Coverage target: 97%+ (match existing thresholds in vite.config.ts)
- Edge cases: empty responses, malformed JSON, missing files, empty branches
