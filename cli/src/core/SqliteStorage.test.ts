/**
 * SqliteStorage read side — the path↔table mapping, seeded through the real
 * importer so the bytes tested are the bytes the pipeline actually stores.
 * The full-scale proof lives in the equivalence harness run against this
 * repo's orphan branch (312 summaries + 453 other files, zero failures); these
 * pin the mechanisms it relies on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDashboardDb } from "../dashboard/DashboardDb.js";
import type { RegisteredRepo } from "../dashboard/RepoRegistry.js";
import { importRepoMemory } from "../dashboard/SotImport.js";
import type { CommitSummary, FileWrite } from "../Types.js";
import { SqliteStorage } from "./SqliteStorage.js";
import type { StorageProvider } from "./StorageProvider.js";

let dir: string;
let dbPath: string;
let storage: SqliteStorage;

const alphaPage = {
	schemaVersion: 1,
	stableSlug: "alpha",
	title: "Alpha",
	content: "# A",
	relatedBranches: ["main"],
	sourceRefs: [
		{ type: "summary", id: "a".repeat(40), timestamp: "2026-07-01T00:00:00.000Z", branch: "main" },
		{ type: "plan", id: "my-plan", timestamp: "2026-07-02T00:00:00.000Z" },
	],
	lastUpdatedAt: "2026-07-03T00:00:00.000Z",
};
const alphaIndexEntry = {
	stableSlug: "alpha",
	title: "Alpha",
	summary: "About alpha",
	relatedBranches: ["main"],
	sourceRefs: alphaPage.sourceRefs,
	lastUpdatedAt: "2026-07-03T00:00:00.000Z",
};

const repo: RegisteredRepo = {
	repoIdentity: "https://example.com/acme/app.git",
	repoName: "app",
	worktreeRoot: "/w",
	enabledAt: "t",
} as RegisteredRepo;

class InMemoryStorage implements StorageProvider {
	constructor(private readonly files: Map<string, string>) {}
	async readFile(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	async batchReadFiles(paths: ReadonlyArray<string>): Promise<Map<string, string | null>> {
		return new Map(paths.map((p) => [p, this.files.get(p) ?? null]));
	}
	async writeFiles(_f: FileWrite[], _m: string): Promise<void> {}
	async listFiles(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((p) => p.startsWith(prefix));
	}
	async exists(): Promise<boolean> {
		return true;
	}
	async ensure(): Promise<void> {}
}

const summary = (hash: string, over: Partial<CommitSummary> = {}): CommitSummary =>
	({
		version: "5",
		commitHash: hash,
		commitMessage: `msg ${hash}`,
		commitDate: "2026-07-01T00:00:00.000Z",
		branch: "main",
		commitType: "commit",
		topics: [],
		children: [],
		...over,
	}) as CommitSummary;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "jolli-sqlite-storage-"));
	dbPath = join(dir, "jollimemory.db");
	const child = summary("c".repeat(40), {
		commitType: "amend",
		topics: [{ title: "Child topic" }],
	} as unknown as Partial<CommitSummary>);
	const second = summary("b".repeat(40), { commitType: "amend" });
	const root = summary("a".repeat(40), {
		children: [child, second],
		transcripts: ["t-1"],
		topics: [{ title: "Root topic", category: "feature" }],
		diffStats: { filesChanged: 1, insertions: 2, deletions: 3 },
	} as unknown as Partial<CommitSummary>);
	// A summary that never had a `children` key: assembly must not add one.
	const keyless = { ...summary("d".repeat(40)) } as Record<string, unknown>;
	delete keyless.children;
	const files = new Map<string, string>([
		[`summaries/${"d".repeat(40)}.json`, JSON.stringify(keyless, null, "\t")],
		[`summaries/${root.commitHash}.json`, JSON.stringify(root, null, "\t")],
		[`summaries/${child.commitHash}.json`, JSON.stringify(child, null, "\t")],
		[`summaries/${second.commitHash}.json`, JSON.stringify(second, null, "\t")],
		["transcripts/t-1.json", JSON.stringify({ sessions: [{ sessionId: "s1" }] }, null, "\t")],
		["plans/my-plan.md", "# my plan\nbody\n"],
		["notes/note-1.md", "note body"],
		[
			"references/linear/JOLLI-1.md",
			[
				"---",
				'source: "linear"',
				'nativeId: "JOLLI-1"',
				'title: "T"',
				'url: "https://linear.app/x"',
				'referencedAt: "2026-07-01T00:00:00.000Z"',
				'sourceToolName: "mcp"',
				"---",
				"",
				"body",
				"",
			].join("\n"),
		],
		["plan-progress/my-plan.json", JSON.stringify({ planSlug: "my-plan", version: 1 }, null, "\t")],
		[
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					{ commitHash: "a".repeat(40), parentCommitHash: null, treeHash: "1".repeat(40), branch: "main" },
					{
						commitHash: "c".repeat(40),
						parentCommitHash: "a".repeat(40),
						treeHash: "2".repeat(40),
						branch: "main",
					},
					{
						commitHash: "b".repeat(40),
						parentCommitHash: "a".repeat(40),
						treeHash: "3".repeat(40),
						branch: "main",
					},
					{ commitHash: "d".repeat(40), parentCommitHash: null, branch: "main" },
				],
				commitAliases: { ["f".repeat(40)]: "a".repeat(40) },
			}),
		],
		["topics/alpha.json", JSON.stringify(alphaPage, null, "\t")],
		[
			"topics/beta.json",
			JSON.stringify(
				{
					schemaVersion: 1,
					stableSlug: "beta",
					title: "Beta",
					content: "# B",
					relatedBranches: [],
					sourceRefs: [],
					lastUpdatedAt: "2026-07-03T00:00:00.000Z",
				},
				null,
				"\t",
			),
		],
		["topics/index.json", JSON.stringify({ schemaVersion: 1, topics: [{ ...alphaIndexEntry }] }, null, "\t")],
		[
			"topics/processed.json",
			JSON.stringify(
				{
					schemaVersion: 1,
					processed: { summary: ["a".repeat(40)], plan: ["my-plan"], note: [], userfile: [] },
				},
				null,
				"\t",
			),
		],
		["schema-v5-migration.json", '{\n\t"version": 1,\n\t"status": "completed"\n}'],
	]);
	await withDashboardDb(
		(db) => importRepoMemory(db, { repo, storage: new InMemoryStorage(files), nowMs: 1, mode: "seed" }),
		{ dbPath },
	);
	storage = new SqliteStorage(repo.repoIdentity, dbPath);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SqliteStorage reads", () => {
	it("reassembles a summary tree with children filled in place, tab-indented", async () => {
		const text = await storage.readFile(`summaries/${"a".repeat(40)}.json`);
		expect(text).not.toBeNull();
		const parsed = JSON.parse(text as string) as CommitSummary;
		expect(parsed.children?.[0]?.commitHash).toBe("c".repeat(40));
		// The serialization the orphan files use — byte fidelity depends on it.
		expect(text?.startsWith("{\n\t")).toBe(true);
	});

	it("serves every stored family verbatim and lists them all", async () => {
		expect(await storage.readFile("plans/my-plan.md")).toBe("# my plan\nbody\n");
		expect(await storage.readFile("notes/note-1.md")).toBe("note body");
		expect(await storage.readFile("references/linear/JOLLI-1.md")).toContain('nativeId: "JOLLI-1"');
		expect(await storage.readFile("plan-progress/my-plan.json")).toContain('"planSlug": "my-plan"');
		// Transcripts round-trip through the zlib blob.
		expect(JSON.parse((await storage.readFile("transcripts/t-1.json")) as string)).toEqual({
			sessions: [{ sessionId: "s1" }],
		});
		expect(await storage.listFiles("summaries/")).toHaveLength(4);
		expect(await storage.listFiles("references/")).toEqual(["references/linear/JOLLI-1.md"]);
	});

	it("answers null for absent files, not an error", async () => {
		expect(await storage.readFile("summaries/nope.json")).toBeNull();
		expect(await storage.readFile(`summaries/${"e".repeat(40)}.json`)).toBeNull();
		expect(await storage.readFile("transcripts/absent.json")).toBeNull();
		expect(await storage.readFile("plans/absent.md")).toBeNull();
		expect(await storage.readFile("plan-progress/absent.json")).toBeNull();
		expect(await storage.readFile("topics/absent.json")).toBeNull();
		expect(await storage.readFile("unknown-family.bin")).toBeNull();
	});

	it("synthesizes index.json from memories + commit_aliases", async () => {
		const idx = JSON.parse((await storage.readFile("index.json")) as string) as {
			version: number;
			entries: Record<string, unknown>[];
			commitAliases?: Record<string, string>;
		};
		expect(idx.version).toBe(3);
		expect(idx.entries).toHaveLength(4);
		const byHash = new Map(idx.entries.map((e) => [e.commitHash, e]));
		const root = byHash.get("a".repeat(40)) as Record<string, unknown>;
		expect(root.parentCommitHash).toBeNull();
		// treeHash was copied off the index entry at import — summary files never carry it.
		expect(root.treeHash).toBe("1".repeat(40));
		// Root topic + child topic, counted over the REASSEMBLED (fresh) tree.
		expect(root.topicCount).toBe(2);
		expect(root.diffStats).toEqual({ filesChanged: 1, insertions: 2, deletions: 3 });
		const child = byHash.get("c".repeat(40)) as Record<string, unknown>;
		expect(child.parentCommitHash).toBe("a".repeat(40));
		expect("topicCount" in child).toBe(false);
		// The d-root never had an index treeHash: the key must stay absent, and a
		// root without diffStats must not gain the key either.
		const keyless = byHash.get("d".repeat(40)) as Record<string, unknown>;
		expect("treeHash" in keyless).toBe(false);
		expect(keyless.topicCount).toBe(0);
		expect("diffStats" in keyless).toBe(false);
		expect(idx.commitAliases).toEqual({ ["f".repeat(40)]: "a".repeat(40) });
	});

	it("synthesizes catalog.json with one entry per root", async () => {
		const cat = JSON.parse((await storage.readFile("catalog.json")) as string) as {
			version: number;
			entries: { commitHash: string; topics?: { title: string }[] }[];
		};
		expect(cat.version).toBe(1);
		expect(cat.entries.map((e) => e.commitHash).sort()).toEqual(["a".repeat(40), "d".repeat(40)]);
		const root = cat.entries.find((e) => e.commitHash === "a".repeat(40));
		expect(root?.topics?.map((t) => t.title)).toContain("Root topic");
	});

	it("round-trips topic pages byte-exactly and rebuilds the topic index", async () => {
		expect(await storage.readFile("topics/alpha.json")).toBe(JSON.stringify(alphaPage, null, "\t"));
		const ti = JSON.parse((await storage.readFile("topics/index.json")) as string) as {
			topics: Record<string, unknown>[];
		};
		const bySlug = new Map(ti.topics.map((t) => [t.stableSlug, t]));
		expect(bySlug.get("alpha")).toEqual(alphaIndexEntry);
		// beta never appeared in the stored topic index, so it has no summary —
		// the synthesized entry must not grow the key.
		expect("summary" in (bySlug.get("beta") as object)).toBe(false);
	});

	it("rebuilds processed.json with all four keys and serves the v5 marker verbatim", async () => {
		expect(JSON.parse((await storage.readFile("topics/processed.json")) as string)).toEqual({
			schemaVersion: 1,
			processed: { summary: ["a".repeat(40)], plan: ["my-plan"], note: [], userfile: [] },
		});
		expect(await storage.readFile("schema-v5-migration.json")).toBe(
			'{\n\t"version": 1,\n\t"status": "completed"\n}',
		);
	});

	it("lists the synthesized paths alongside the stored ones", async () => {
		const topics = await storage.listFiles("topics/");
		expect(topics).toEqual(["topics/alpha.json", "topics/beta.json", "topics/index.json", "topics/processed.json"]);
		expect(await storage.listFiles("index.json")).toEqual(["index.json"]);
		expect(await storage.listFiles("catalog.json")).toEqual(["catalog.json"]);
		expect(await storage.listFiles("schema-v5-migration.json")).toEqual(["schema-v5-migration.json"]);
	});

	it("serves a batch over one connection, absent paths as null", async () => {
		const out = await storage.batchReadFiles(["plans/my-plan.md", "notes/absent.md", "transcripts/t-1.json"]);
		expect(out.get("plans/my-plan.md")).toBe("# my plan\nbody\n");
		expect(out.get("notes/absent.md")).toBeNull();
		expect(out.get("transcripts/t-1.json")).toContain("s1");
	});

	it("reads a child leaf directly and keeps its own empty children array", async () => {
		const text = await storage.readFile(`summaries/${"c".repeat(40)}.json`);
		const parsed = JSON.parse(text as string) as { commitHash: string; children: unknown[] };
		expect(parsed.children).toEqual([]);
		// A non-root is assembled from its SUBTREE, not from its root's whole
		// family: the sibling `b…` shares a root_hash with it and must not leak
		// in. That is also why the two shapes exist — see assembleMemoryTree.
		expect(parsed.commitHash).toBe("c".repeat(40));
		expect(text).not.toContain("b".repeat(40));
	});

	it("keeps siblings in child_pos order — the array order the parent file had", async () => {
		// The schema CHECK pins (parent_hash IS NULL) = (child_pos IS NULL), so a
		// child without a position cannot exist; ordering is always by real
		// positions. c-child was first in the fixture's children array, b second.
		const text = await storage.readFile(`summaries/${"a".repeat(40)}.json`);
		const kids = (JSON.parse(text as string) as CommitSummary).children ?? [];
		expect(kids.map((k) => k.commitHash)).toEqual(["c".repeat(40), "b".repeat(40)]);
	});

	it("never grows a children key on a summary that had none", async () => {
		// Byte fidelity: adding the key would append it at the end and move bytes.
		const text = await storage.readFile(`summaries/${"d".repeat(40)}.json`);
		expect(text).not.toBeNull();
		expect("children" in (JSON.parse(text as string) as object)).toBe(false);
	});

	it("accepts an empty write batch and still refuses ensure()", async () => {
		// The write path itself is SotWrite's suite; here just the wiring.
		await expect(storage.writeFiles([], "m")).resolves.toBeUndefined();
		await expect(storage.ensure()).rejects.toThrow(/migrations already/);
	});

	it("exists() reflects whether the repo is registered", async () => {
		expect(await storage.exists()).toBe(true);
		expect(await new SqliteStorage("https://example.com/other.git", dbPath).exists()).toBe(false);
	});
});

describe("phase E: search over the database", () => {
	it("signature has two segments and moves with either table", async () => {
		const before = await storage.searchSignatureParts();
		expect(before.memoriesCount).toBeGreaterThan(0);
		// A topic-page write moves ONLY the topic segment — the failure mode the
		// two-segment rule exists for (a memories-only watermark would freeze
		// topic search on old content).
		await storage.writeFiles(
			[
				{
					path: "topics/gamma.json",
					content: JSON.stringify({
						schemaVersion: 1,
						stableSlug: "gamma",
						title: "登录鉴权",
						content: "# 登录鉴权\n重试策略与退避设计",
						relatedBranches: ["main"],
						sourceRefs: [],
						lastUpdatedAt: "2026-08-04T01:00:00.000Z",
					}),
				},
			],
			"m",
		);
		const after = await storage.searchSignatureParts();
		expect(after.memoriesCount).toBe(before.memoriesCount);
		expect(after.memoriesNewestMs).toBe(before.memoriesNewestMs);
		expect(after.topicCount).toBe(before.topicCount + 1);
		expect(after.topicNewest).toBe("2026-08-04T01:00:00.000Z");
		const { computeSourceSignature } = await import("./SearchIndexSource.js");
		const signature = await computeSourceSignature(dir, storage);
		expect(signature).toContain("|sqlite|");
		expect(signature).toContain("2026-08-04T01:00:00.000Z");
	});

	it("Chinese bigram search still hits after the source moved to the database", async () => {
		// The tokenizer is untouched by phase E; this pins that the database-
		// backed docs (synthesized catalog/index/topics) kept CJK search alive.
		await storage.writeFiles(
			[
				{
					path: "topics/auth.json",
					content: JSON.stringify({
						schemaVersion: 1,
						stableSlug: "auth",
						title: "登录鉴权",
						content: "# 登录鉴权\n重试策略与指数退避的设计取舍",
						relatedBranches: ["main"],
						sourceRefs: [],
						lastUpdatedAt: "2026-08-04T02:00:00.000Z",
					}),
				},
			],
			"m",
		);
		const { collectSearchDocs } = await import("./SearchIndexSource.js");
		const docs = await collectSearchDocs(dir, storage);
		const topicDoc = docs.find((d) => d.id === "topic:auth");
		expect(topicDoc?.content).toContain("退避");
		// End-to-end through the real entry: SearchIndex.open collects docs and
		// the signature through THIS storage (both database-backed now).
		const { SearchIndex } = await import("./SearchIndex.js");
		const index = await SearchIndex.open(dir, storage);
		const hits = await index.search({ query: "退避" });
		expect(hits.map((h) => h.id)).toContain("topic:auth");
	});
});

describe("phase H: typed hot-path readers", () => {
	it("resolves aliases and hash prefixes without synthesizing the index", async () => {
		expect(await storage.lookupAlias("f".repeat(40))).toBe("a".repeat(40));
		expect(await storage.lookupAlias("9".repeat(40))).toBeNull();
		expect(await storage.findHashesByPrefix("aaaaaaaa")).toEqual(["a".repeat(40)]);
		expect((await storage.findHashesByPrefix("nope")).length).toBe(0);
	});

	it("treats a hash prefix as startsWith, not as a LIKE pattern", async () => {
		// `_` matches any single character and `%` matches everything, so an
		// unguarded LIKE answered questions the index backend answers with null
		// — and `%` came back as an AmbiguousHashError listing the whole table.
		expect(await storage.findHashesByPrefix("a_aaaaaa")).toEqual([]);
		expect(await storage.findHashesByPrefix("%")).toEqual([]);
		expect(await storage.findHashesByPrefix("AAAAAAAA")).toEqual([]);
		const { getSummary } = await import("./SummaryStore.js");
		expect(await getSummary("%", dir, storage)).toBeNull();
	});

	it("getSummary's fallback steps go through the typed readers", async () => {
		const { getSummary } = await import("./SummaryStore.js");
		// Full-sha alias: f... has no file; the alias row resolves it to a....
		const viaAlias = await getSummary("f".repeat(40), dir, storage);
		expect(viaAlias?.commitHash).toBe("a".repeat(40));
		// Abbreviated unique prefix.
		const viaPrefix = await getSummary("bbbbbbbb", dir, storage);
		expect(viaPrefix?.commitHash).toBe("b".repeat(40));
		// Ambiguous prefix throws, unknown returns null.
		await expect(getSummary("d", dir, storage)).resolves.toBeTruthy();
		expect(await getSummary("e".repeat(40), dir, storage)).toBeNull();
	});

	it("lists branch heads (roots only), optionally branch-scoped", async () => {
		const heads = await storage.listHeadEntries();
		expect(heads.map((h) => h.commitHash).sort()).toEqual(["a".repeat(40), "d".repeat(40)]);
		expect(heads.every((h) => h.parentCommitHash === null)).toBe(true);
		expect(heads.find((h) => h.commitHash === "a".repeat(40))?.treeHash).toBe("1".repeat(40));
		expect(await storage.listHeadEntries("no-such-branch")).toEqual([]);
	});

	it("serves topic titles, topic search rows and root summaries as typed rows", async () => {
		const titles = await storage.topicTitlesByHash();
		expect(titles.get("a".repeat(40))).toEqual(["Root topic"]);
		const topicRows = await storage.listTopicSearchRows();
		const alpha = topicRows.find((t) => t.stableSlug === "alpha");
		expect(alpha).toMatchObject({ title: "Alpha", content: "# A", relatedBranches: ["main"] });
		expect(alpha?.refTypes).toEqual(["summary", "plan"]);
		const roots = await storage.listRootSummaries();
		expect(roots.map((r) => r.commitHash).sort()).toEqual(["a".repeat(40), "d".repeat(40)]);
		expect(roots.find((r) => r.commitHash === "a".repeat(40))?.children).toHaveLength(2);
	});

	it("ambiguous prefixes throw and bare-bones summaries answer with empty strings", async () => {
		// Two hashes sharing a prefix — only reachable through the typed scan.
		const twin = (tail: string) => `${"ab".repeat(4)}${tail.repeat(32)}`;
		await storage.writeFiles(
			[
				{ path: `summaries/${twin("1")}.json`, content: `{"commitHash": "${twin("1")}"}` },
				{ path: `summaries/${twin("2")}.json`, content: `{"commitHash": "${twin("2")}"}` },
			],
			"m",
		);
		const { getSummary } = await import("./SummaryStore.js");
		await expect(getSummary("abababab", dir, storage)).rejects.toThrow(/[Aa]mbiguous/);
		// The bare summary has no branch/message/date/generatedAt: the head
		// listing degrades those to empty strings instead of nulls.
		const bare = (await storage.listHeadEntries()).find((h) => h.commitHash === twin("1"));
		expect(bare).toMatchObject({ commitMessage: "", branch: "", commitDate: "", generatedAt: "" });
		expect(bare?.treeHash).toBeUndefined();
		expect(bare?.commitType).toBeUndefined();
	});

	it("recall's branch catalog and task context ride the typed path", async () => {
		const { setActiveStorage } = await import("./SummaryStore.js");
		const { listBranchCatalog, compileTaskContext } = await import("./ContextCompiler.js");
		setActiveStorage(storage);
		try {
			const catalog = await listBranchCatalog(dir);
			const main = catalog.branches.find((b) => b.branch === "main");
			expect(main?.commitCount).toBe(2);
			expect(main?.topicTitles).toContain("Root topic");
			const context = await compileTaskContext({ branch: "main" }, dir);
			expect(context.branch).toBe("main");
		} finally {
			setActiveStorage(undefined);
		}
	});
});

describe("asSqliteStorage unwrapping", () => {
	it("unwraps the database backend from a dual-write pair — typed paths survive the renderer", async () => {
		const { asSqliteStorage } = await import("./SqliteStorage.js");
		const { DualWriteStorage } = await import("./DualWriteStorage.js");
		const shadow = {
			async readFile() {
				return null;
			},
			async writeFiles() {},
			async listFiles() {
				return [] as string[];
			},
			async exists() {
				return true;
			},
			async ensure() {},
		};
		const pair = new DualWriteStorage(storage, shadow);
		expect(asSqliteStorage(pair)).toBe(storage);
		expect(asSqliteStorage(storage)).toBe(storage);
		expect(asSqliteStorage(shadow)).toBeNull();
		expect(asSqliteStorage(undefined)).toBeNull();
		// End to end: the search signature fast path answers through the pair.
		const { computeSourceSignature } = await import("./SearchIndexSource.js");
		expect(await computeSourceSignature(dir, pair)).toContain("|sqlite|");
	});
});
