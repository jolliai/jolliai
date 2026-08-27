/**
 * SotImport.test — the orphan-branch → SOT import, driven entirely by an
 * in-memory StorageProvider so no git subprocess ever runs.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StorageProvider } from "../core/StorageProvider.js";
import type { CommitSummary } from "../Types.js";
import { type DashboardDbHandle, withDashboardDb } from "./DashboardDb.js";
import type { RegisteredRepo } from "./RepoRegistry.js";
import { importRepoMemory, type SotImportResult } from "./SotImport.js";
import { REORDER_OFFSET } from "./SotSchema.js";

/** Map-backed StorageProvider: reads only, prefix listing, no batch API. */
class InMemoryStorage implements StorageProvider {
	readonly kind = "orphan-branch" as const;
	constructor(protected readonly files: Map<string, string>) {}
	async readFile(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	async writeFiles(): Promise<void> {
		throw new Error("the importer must never write to storage");
	}
	async listFiles(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
	}
	async exists(): Promise<boolean> {
		return true;
	}
	async ensure(): Promise<void> {}
}

let dir: string;
let dbPath: string;

const repo: RegisteredRepo = {
	repoIdentity: "https://github.com/jolliai/jolliai.git",
	repoName: "jolliai",
	worktreeRoot: "/w",
	enabledAt: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-sotimport-"));
	dbPath = join(dir, "dashboard.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * Full-length hashes on purpose: plan/note filenames carry an 8-char prefix
 * (`<slug>-<hash8>.md`) that is resolved back to a branch by prefix-matching the
 * summary index, so short fixture hashes would silently never match.
 */
const H = {
	root: `aaaa1111${"0".repeat(32)}`,
	mid: `bbbb2222${"0".repeat(32)}`,
	leaf: `cccc3333${"0".repeat(32)}`,
	other: `dddd4444${"0".repeat(32)}`,
} as const;

const summary = (hash: string, over: Partial<CommitSummary> = {}): CommitSummary =>
	({
		version: "5",
		commitHash: hash,
		commitMessage: `msg ${hash.slice(0, 4)}`,
		commitAuthor: "dev",
		commitDate: "2026-07-01T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-07-01T01:00:00.000Z",
		commitType: "commit",
		recap: `recap ${hash.slice(0, 4)}`,
		topics: [],
		...over,
	}) as CommitSummary;

/**
 * A fixture mirroring the real branch's shapes: an amend tree (root + two
 * children, one of them nested), a legacy node without `transcripts[]`,
 * transcripts keyed by UUID, all three doc kinds, plan progress with llm
 * metadata, the topic KB triple, and a commit alias.
 */
function fixture(overrides: Record<string, string> = {}): Map<string, string> {
	// The root embeds pruned copies of its children (as the real branch does);
	// the standalone files remain canonical.
	const leaf = summary(H.leaf, { commitType: "commit", transcripts: ["t-leaf"] });
	const mid = summary(H.mid, { commitType: "amend", transcripts: ["t-mid"], children: [leaf] });
	const other = summary(H.other, { commitType: "amend" }); // legacy: no transcripts[]
	const root = summary(H.root, {
		commitType: "squash",
		transcripts: ["t-root", "t-shared"],
		children: [mid, other],
		diffStats: { filesChanged: 2, insertions: 10, deletions: 1 },
		ticketId: "JOLLI-42",
	});

	const indexEntry = (hash: string, parent: string | null, branch: string) => ({
		commitHash: hash,
		parentCommitHash: parent,
		commitMessage: `msg ${hash.slice(0, 4)}`,
		commitDate: "2026-07-01T00:00:00.000Z",
		branch,
		generatedAt: "g",
	});

	const files = new Map<string, string>([
		[`summaries/${H.root}.json`, JSON.stringify(root)],
		[`summaries/${H.mid}.json`, JSON.stringify(mid)],
		[`summaries/${H.leaf}.json`, JSON.stringify(leaf)],
		[`summaries/${H.other}.json`, JSON.stringify(other)],
		[
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					indexEntry(H.root, null, "main"),
					indexEntry(H.mid, H.root, "feature"),
					indexEntry(H.leaf, H.mid, "feature"),
					indexEntry(H.other, H.root, "main"),
				],
				commitAliases: { oldsha: H.root, gonesha: "nosuchnode" },
			}),
		],
		["transcripts/t-root.json", JSON.stringify({ sessions: [{ sessionId: "s1", source: "claude", entries: [] }] })],
		// No `source` — StoredSession.source is optional for legacy data.
		["transcripts/t-shared.json", JSON.stringify({ sessions: [{ sessionId: "s2", entries: [] }] })],
		["transcripts/t-mid.json", JSON.stringify({ sessions: [] })],
		["transcripts/t-leaf.json", JSON.stringify({ sessions: [] })],
		["plans/my-plan-aaaa1111.md", "# My Plan\n\nSteps here.\n"],
		["notes/note-9f-bbbb2222.md", "# A Note\n\nBody.\n"],
		[
			"references/linear/JOLLI-1909-067f53c5.md",
			[
				"---",
				'source: "linear"',
				'nativeId: "JOLLI-1909"',
				'title: "References are not pushed"',
				'url: "https://linear.app/jolliai/issue/JOLLI-1909/x"',
				'referencedAt: "2026-07-10T06:15:09.171Z"',
				'sourceToolName: "mcp__claude_ai_Linear__get_issue"',
				"---",
				"",
				"The reference body.",
				"",
			].join("\n"),
		],
		[
			"plan-progress/my-plan-aaaa1111.json",
			JSON.stringify({
				version: 1,
				commitHash: H.root,
				commitMessage: "msg aaaa",
				commitDate: "2026-07-01T00:00:00.000Z",
				planSlug: "my-plan-aaaa1111",
				originalSlug: "my-plan",
				summary: "progressed",
				steps: [{ id: "1", description: "do it", status: "done", note: null }],
				llm: { model: "claude-haiku-4-5-20251001", inputTokens: 25808, outputTokens: 1293 },
			}),
		],
		[
			"topics/auth-login.json",
			JSON.stringify({
				schemaVersion: 1,
				stableSlug: "auth-login",
				title: "Auth Login",
				content: "## Overview\n\ncontent",
				relatedBranches: ["main"],
				sourceRefs: [
					{ type: "summary", id: H.root, timestamp: "2026-02-01T00:00:00.000Z", branch: "main" },
					{ type: "plan", id: "my-plan", timestamp: "2026-01-01T00:00:00.000Z" },
				],
				lastUpdatedAt: "2026-07-22T06:52:10.317Z",
			}),
		],
		[
			"topics/index.json",
			JSON.stringify({
				schemaVersion: 1,
				topics: [
					{
						stableSlug: "auth-login",
						title: "Auth Login",
						summary: "Login URLs carry a device label.",
						relatedBranches: ["main"],
						sourceRefs: [],
						lastUpdatedAt: "2026-07-22T06:52:10.317Z",
					},
				],
			}),
		],
		[
			"topics/processed.json",
			JSON.stringify({ schemaVersion: 1, processed: { summary: [H.root], plan: [], note: [], userfile: [] } }),
		],
	]);
	for (const [path, content] of Object.entries(overrides)) files.set(path, content);
	return files;
}

/** Runs the importer against `files`, returning the result plus a query helper. */
async function runImport(
	files: Map<string, string>,
	nowMs = 1_000,
	mode: "seed" | "catch-up" = "seed",
	protectNewerThanMs?: number,
): Promise<{ result: SotImportResult; query: <T>(sql: string, ...p: unknown[]) => Promise<T[]> }> {
	const result = await withDashboardDb(
		(db) =>
			importRepoMemory(db, {
				repo,
				storage: new InMemoryStorage(files),
				nowMs,
				mode,
				...(protectNewerThanMs !== undefined ? { protectNewerThanMs } : {}),
			}),
		{ dbPath },
	);
	const query = <T>(sql: string, ...p: unknown[]): Promise<T[]> =>
		withDashboardDb((db: DashboardDbHandle) => db.prepare(sql).all(...p) as T[], { dbPath });
	return { result, query };
}

describe("importRepoMemory", () => {
	it("imports every path family and reports its counts", async () => {
		const { result } = await runImport(fixture());
		expect(result).toMatchObject({
			nodes: 4,
			updated: 4,
			aliases: 1, // the alias whose target has no node is skipped
			transcripts: 4,
			links: 4, // root 2 + mid 1 + leaf 1; the legacy node contributes none
			docs: 3,
			planProgress: 1,
			topics: 1,
		});
		expect(result.skipped).toBe(1); // 'gonesha' → unknown target
	});

	it("imports archived skills into the context table and reconciles them like any doc", async () => {
		// `skills/` was absent from the importer's families entirely, so a cut-over
		// repo's only copy of every archived skill stayed on the frozen branch — and
		// `pruneTable("context", …)` reconciles ALL kinds against `liveDocs`, so a
		// skill row would have been deleted by the very next seed pass.
		const files = fixture();
		files.set("skills/claude/superpowers-brainstorming-a1b2c3d4.md", "# Brainstorming\n\nBody.\n");
		const { result, query } = await runImport(files);

		expect(result.docs).toBe(4); // plan + note + reference + skill
		expect(await query("SELECT context_key, branch, source FROM context WHERE kind = 'skill'")).toEqual([
			{
				context_key: "claude/superpowers-brainstorming-a1b2c3d4",
				// Reference-only columns stay NULL; `<source>` lives in the key, exactly
				// as it does for a reference path.
				branch: null,
				source: null,
			},
		]);
	});

	it("registers the repo", async () => {
		const { query } = await runImport(fixture());
		expect(await query("SELECT repo_identity, repo_name FROM repos")).toEqual([
			{ repo_identity: repo.repoIdentity, repo_name: "jolliai" },
		]);
	});

	it("rebuilds the children tree as edges, positions, roots and depths", async () => {
		const { query } = await runImport(fixture());
		const rows = await query<{
			commit_hash: string;
			parent_hash: string | null;
			child_pos: number | null;
			root_hash: string;
			depth: number;
		}>("SELECT commit_hash, parent_hash, child_pos, root_hash, depth FROM memories ORDER BY depth, child_pos");
		expect(rows).toEqual([
			{ commit_hash: H.root, parent_hash: null, child_pos: null, root_hash: H.root, depth: 0 },
			{ commit_hash: H.mid, parent_hash: H.root, child_pos: 0, root_hash: H.root, depth: 1 },
			{ commit_hash: H.other, parent_hash: H.root, child_pos: 1, root_hash: H.root, depth: 1 },
			{ commit_hash: H.leaf, parent_hash: H.mid, child_pos: 0, root_hash: H.root, depth: 2 },
		]);
	});

	it("takes a child's position from its authoritative parent, not from a stale tree that also lists it", async () => {
		// A child hash can appear in more than one summary's `children[]` — an amend
		// or rebase leaves the superseded tree's array listing it too. Keying the
		// position map by the child alone made that last-writer-wins, and the winner
		// was whichever summary iteration reached last: here `stale` lists H.other at
		// index 0, so H.other took 0 while still carrying its index parent H.root —
		// colliding with H.mid, which legitimately holds slot 0, and failing the whole
		// batch on UNIQUE(repo_id, parent_hash, child_pos). Measured on a real branch,
		// where it made one repo permanently unimportable.
		const stale = `eeee5555${"0".repeat(32)}`; // sorts after H.root, so it is iterated last
		const files = fixture();
		files.set(`summaries/${stale}.json`, JSON.stringify(summary(stale, { children: [summary(H.other)] })));
		const index = JSON.parse(files.get("index.json") as string) as {
			entries: Array<Record<string, unknown>>;
		};
		index.entries.push({
			commitHash: stale,
			parentCommitHash: null,
			commitMessage: "msg eeee",
			commitDate: "2026-07-01T00:00:00.000Z",
			branch: "main",
			generatedAt: "g",
		});
		files.set("index.json", JSON.stringify(index));

		const { query } = await runImport(files);
		expect(
			await query("SELECT commit_hash, child_pos FROM memories WHERE parent_hash = ? ORDER BY child_pos", H.root),
		).toEqual([
			{ commit_hash: H.mid, child_pos: 0 },
			{ commit_hash: H.other, child_pos: 1 },
		]);
		// The stale listing is inert, not authoritative: it gives H.other no edge.
		expect(await query("SELECT commit_hash FROM memories WHERE parent_hash = ?", stale)).toEqual([]);
	});

	it("links a transcript listed twice in transcripts[] exactly once", async () => {
		// A squash that concatenates its children's arrays can name the same
		// transcript twice. `memory_transcripts`' PK makes the link a set, so the
		// repeat is not extra information — it was a PK violation that aborted the
		// batch, and since every retry re-read the same file, the repo could never
		// finish importing. Measured on a real branch.
		const files = fixture();
		files.set(
			`summaries/${H.other}.json`,
			JSON.stringify(summary(H.other, { commitType: "amend", transcripts: ["t-shared", "t-mid", "t-shared"] })),
		);
		const { result, query } = await runImport(files);

		expect(await query("SELECT transcript_id FROM memory_transcripts WHERE commit_hash = ?", H.other)).toEqual([
			{ transcript_id: "t-shared" },
			{ transcript_id: "t-mid" },
		]);
		expect(result.links).toBe(6); // root 2 + mid 1 + leaf 1 + other 2 (not 3)
	});

	it("empties children[] IN PLACE, preserving JSON key order", async () => {
		const { query } = await runImport(fixture());
		const [row] = await query<{ summary_json: string; ticket_id: string; files_changed: number }>(
			"SELECT summary_json, ticket_id, files_changed FROM memories WHERE commit_hash = ?",
			H.root,
		);
		const parsed = JSON.parse(row.summary_json) as Record<string, unknown>;
		// Emptied, not removed: reassembly replaces this value rather than appending
		// the key, so the key order of the stored JSON still matches the file's. A
		// stripped key would reassemble at the end and fail the byte comparison.
		expect(parsed.children).toEqual([]);
		expect(parsed.transcripts).toEqual(["t-root", "t-shared"]);
		expect(row.ticket_id).toBe("JOLLI-42");
		expect(row.files_changed).toBe(2);
	});

	it("links transcripts in array order and projects their sessions, source optional", async () => {
		const { query } = await runImport(fixture());
		expect(
			await query(
				"SELECT transcript_id FROM memory_transcripts WHERE commit_hash = ? ORDER BY transcript_id",
				H.root,
			),
		).toEqual([{ transcript_id: "t-root" }, { transcript_id: "t-shared" }]);
		expect(
			await query("SELECT transcript_id, source, session_id FROM transcript_sessions ORDER BY transcript_id"),
		).toEqual([
			{ transcript_id: "t-root", source: "claude", session_id: "s1" },
			{ transcript_id: "t-shared", source: null, session_id: "s2" },
		]);
	});

	it("skips a transcript reference with no backing file, keeping the rest", async () => {
		const files = fixture();
		files.delete("transcripts/t-shared.json");
		const { result, query } = await runImport(files);
		expect(await query("SELECT transcript_id FROM memory_transcripts WHERE commit_hash = ?", H.root)).toEqual([
			{ transcript_id: "t-root" },
		]);
		expect(result.skipped).toBe(2); // the dangling alias + this dangling link
	});

	it("imports all three doc kinds with their kind-specific columns", async () => {
		const { query } = await runImport(fixture());
		const docs = await query<Record<string, unknown>>(
			"SELECT kind, context_key, source, native_id, tool_name, original_slug, branch, title, url FROM context ORDER BY kind",
		);
		expect(docs).toEqual([
			{
				kind: "note",
				context_key: "note-9f-bbbb2222",
				source: null,
				native_id: null,
				tool_name: null,
				original_slug: null,
				branch: "feature",
				title: "A Note",
				url: null,
			},
			{
				kind: "plan",
				context_key: "my-plan-aaaa1111",
				source: null,
				native_id: null,
				tool_name: null,
				original_slug: "my-plan",
				branch: "main",
				title: "My Plan",
				url: null,
			},
			{
				kind: "reference",
				context_key: "linear/JOLLI-1909-067f53c5",
				source: "linear",
				native_id: "JOLLI-1909",
				tool_name: "mcp__claude_ai_Linear__get_issue",
				original_slug: null,
				branch: null,
				title: "References are not pushed",
				url: "https://linear.app/jolliai/issue/JOLLI-1909/x",
			},
		]);
	});

	it("stores a reference's complete file, frontmatter included", async () => {
		const { query } = await runImport(fixture());
		const [row] = await query<{ body_md: string }>("SELECT body_md FROM context WHERE kind = 'reference'");
		expect(row.body_md).toContain('nativeId: "JOLLI-1909"');
		expect(row.body_md).toContain("The reference body.");
	});

	it("stores plan progress as the canonical artifact, llm metadata intact", async () => {
		const { query } = await runImport(fixture());
		const [row] = await query<{ plan_slug: string; artifact_json: string }>(
			"SELECT plan_slug, artifact_json FROM plan_progress",
		);
		expect(row.plan_slug).toBe("my-plan-aaaa1111");
		// Read out of the artifact itself: plan_progress projects no columns, so
		// the JSON is both the record and the only place these fields exist.
		const artifact = JSON.parse(row.artifact_json) as {
			version: number;
			llm: { model: string; inputTokens: number };
		};
		expect(artifact.llm.model).toBe("claude-haiku-4-5-20251001");
		expect(artifact.version).toBe(1);
		expect(artifact.llm.inputTokens).toBe(25808);
	});

	it("skips plan progress whose plan is missing rather than failing the import", async () => {
		const files = fixture();
		files.delete("plans/my-plan-aaaa1111.md");
		const { result, query } = await runImport(files);
		expect(await query("SELECT plan_slug FROM plan_progress")).toEqual([]);
		expect(result.docs).toBe(2);
		expect(result.skipped).toBe(2); // dangling alias + orphaned progress
	});

	it("imports topic pages with the index's summary, ordered refs and the processed set", async () => {
		const { query } = await runImport(fixture());
		expect(await query("SELECT stable_slug, summary, payload_version FROM topic_pages")).toEqual([
			{ stable_slug: "auth-login", summary: "Login URLs carry a device label.", payload_version: 1 },
		]);
		expect(await query("SELECT pos, ref_type, ref_id, branch FROM topic_source_refs ORDER BY pos")).toEqual([
			{ pos: 0, ref_type: "summary", ref_id: H.root, branch: "main" },
			{ pos: 1, ref_type: "plan", ref_id: "my-plan", branch: null },
		]);
		expect(await query("SELECT source_type, source_id FROM topic_processed_sources")).toEqual([
			{ source_type: "summary", source_id: H.root },
		]);
	});

	it("records a completion marker in repo_state", async () => {
		const { query } = await runImport(fixture(), 4242);
		const [row] = await query<{ value: string }>("SELECT value FROM repo_state WHERE key = 'orphan-import'");
		expect(JSON.parse(row.value)).toMatchObject({ at: 4242, nodes: 4, docs: 3 });
	});

	it("is idempotent — a second run adds no rows and reports nothing updated", async () => {
		const files = fixture();
		await runImport(files);
		const { result, query } = await runImport(files, 2_000);

		expect(result.updated).toBe(0);
		expect(result.nodes).toBe(4); // upserted, not duplicated
		for (const [sql, expected] of [
			["SELECT COUNT(*) AS n FROM memories", 4],
			["SELECT COUNT(*) AS n FROM memories", 4],
			["SELECT COUNT(*) AS n FROM transcripts", 4],
			["SELECT COUNT(*) AS n FROM memory_transcripts", 4],
			["SELECT COUNT(*) AS n FROM context", 3],
			["SELECT COUNT(*) AS n FROM plan_progress", 1],
			["SELECT COUNT(*) AS n FROM topic_source_refs", 2],
		] as const) {
			expect((await query<{ n: number }>(sql))[0].n, sql).toBe(expected);
		}
	});

	it("rewrites the row in place when a summary's content changed", async () => {
		const files = fixture();
		await runImport(files);
		files.set(
			`summaries/${H.other}.json`,
			JSON.stringify(summary(H.other, { commitType: "amend", recap: "更新后的摘要正文" })),
		);

		const { result, query } = await runImport(files, 2_000);

		// One row per commit: the change is an UPDATE in place, so the count of
		// memories does not move and written_at_ms carries the new clock. There is
		// no revision to append and no history to read back.
		expect(result.updated).toBe(1);
		expect(await query("SELECT written_at_ms, recap FROM memories WHERE commit_hash = ?", H.other)).toEqual([
			{ written_at_ms: 2_000, recap: "更新后的摘要正文" },
		]);
		expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM memories"))[0].n).toBe(4);
	});

	it("re-imports a reshuffled children array without tripping the position constraint", async () => {
		const files = fixture();
		await runImport(files);

		// Same nodes, swapped order under the root — the importer must park
		// positions before rewriting them.
		const leaf = summary(H.leaf, { commitType: "commit", transcripts: ["t-leaf"] });
		const mid = summary(H.mid, { commitType: "amend", transcripts: ["t-mid"], children: [leaf] });
		const other = summary(H.other, { commitType: "amend" });
		files.set(
			`summaries/${H.root}.json`,
			JSON.stringify(
				summary(H.root, {
					commitType: "squash",
					transcripts: ["t-root", "t-shared"],
					children: [other, mid],
					diffStats: { filesChanged: 2, insertions: 10, deletions: 1 },
					ticketId: "JOLLI-42",
				}),
			),
		);

		const { query } = await runImport(files, 3_000);
		expect(
			await query("SELECT commit_hash, child_pos FROM memories WHERE parent_hash = ? ORDER BY child_pos", H.root),
		).toEqual([
			{ commit_hash: H.other, child_pos: 0 },
			{ commit_hash: H.mid, child_pos: 1 },
		]);
	});

	it("grounds a node whose parent has no summary file", async () => {
		const files = fixture();
		files.delete(`summaries/${H.mid}.json`); // the leaf's parent disappears
		const { query } = await runImport(files);
		expect(
			await query("SELECT parent_hash, child_pos, root_hash, depth FROM memories WHERE commit_hash = ?", H.leaf),
		).toEqual([{ parent_hash: null, child_pos: null, root_hash: H.leaf, depth: 0 }]);
	});

	it("cuts a two-node parent cycle instead of writing it back", async () => {
		// A corrupt index claiming root's parent is mid and mid's parent is root.
		// Written back verbatim this is a loop in memories: a child walk over
		// parent_hash never terminates and neither node's root_hash is reachable.
		const files = new Map<string, string>([
			[`summaries/${H.root}.json`, JSON.stringify(summary(H.root))],
			[`summaries/${H.mid}.json`, JSON.stringify(summary(H.mid))],
			[
				"index.json",
				JSON.stringify({
					version: 3,
					entries: [
						{ commitHash: H.root, parentCommitHash: H.mid, branch: "main" },
						{ commitHash: H.mid, parentCommitHash: H.root, branch: "main" },
					],
				}),
			],
		]);
		const { query } = await runImport(files);
		// The walk starts at the lexicographically first file (root) and closes the
		// loop on it, so root is the edge that gets cut.
		expect(await query("SELECT commit_hash, parent_hash, root_hash, depth FROM memories ORDER BY depth")).toEqual([
			{ commit_hash: H.root, parent_hash: null, root_hash: H.root, depth: 0 },
			{ commit_hash: H.mid, parent_hash: H.root, root_hash: H.root, depth: 1 },
		]);
	});

	it("cuts a self-parent edge", async () => {
		const files = fixture({
			"index.json": JSON.stringify({
				version: 3,
				entries: [{ commitHash: H.root, parentCommitHash: H.root, branch: "main" }],
			}),
		});
		const { query } = await runImport(files);
		expect(await query("SELECT parent_hash, depth FROM memories WHERE commit_hash = ?", H.root)).toEqual([
			{ parent_hash: null, depth: 0 },
		]);
	});

	it("skips malformed artifacts and imports the rest", async () => {
		const files = fixture({
			[`summaries/eeee5555${"0".repeat(32)}.json`]: "{ not json",
			"transcripts/t-bad.json": "{}", // no sessions array
			"references/linear/BROKEN-1.md": "no frontmatter here",
		});
		const { result, query } = await runImport(files);
		expect(result.nodes).toBe(4);
		expect(result.transcripts).toBe(4);
		expect(result.docs).toBe(3);
		expect(result.skipped).toBe(4); // alias + bad summary + bad transcript + bad reference
		expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM memories"))[0].n).toBe(4);
	});

	it("works on an empty orphan branch", async () => {
		const { result, query } = await runImport(new Map());
		expect(result).toMatchObject({ nodes: 0, updated: 0, docs: 0, topics: 0, skipped: 0 });
		expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM repos"))[0].n).toBe(1);
	});
});

/** InMemoryStorage plus the batch API — the path OrphanBranchStorage actually uses. */
class BatchingStorage extends InMemoryStorage {
	batchCalls = 0;
	async batchReadFiles(paths: ReadonlyArray<string>): Promise<Map<string, string | null>> {
		this.batchCalls++;
		const map = new Map<string, string | null>();
		for (const path of paths) map.set(path, await this.readFile(path));
		return map;
	}
}

/** Storage that lists a path it cannot read — a file removed between the two calls. */
class VanishingStorage extends InMemoryStorage {
	constructor(
		files: Map<string, string>,
		private readonly vanished: ReadonlySet<string>,
	) {
		super(files);
	}
	override async readFile(path: string): Promise<string | null> {
		if (this.vanished.has(path)) return null;
		return super.readFile(path);
	}
	override async listFiles(prefix: string): Promise<string[]> {
		const listed = await super.listFiles(prefix);
		return [...listed, ...[...this.vanished].filter((p) => p.startsWith(prefix))].sort();
	}
}

describe("importRepoMemory — read paths and sparse data", () => {
	it("uses the backend's batch API when it has one", async () => {
		const storage = new BatchingStorage(fixture());
		const result = await withDashboardDb((db) => importRepoMemory(db, { repo, storage, nowMs: 1 }), { dbPath });
		expect(result.nodes).toBe(4);
		// summaries, transcripts, plans, notes, references, plan-progress
		expect(storage.batchCalls).toBeGreaterThanOrEqual(6);
	});

	it("skips a listed file that cannot be read", async () => {
		const vanished = new Set([
			"plans/gone-aaaa1111.md",
			"notes/gone-bbbb2222.md",
			"references/linear/GONE-1.md",
			"plan-progress/gone-aaaa1111.json",
		]);
		const storage = new VanishingStorage(fixture(), vanished);
		const result = await withDashboardDb((db) => importRepoMemory(db, { repo, storage, nowMs: 1 }), { dbPath });
		// The real files still land; the unreadable ones are counted, not fatal.
		expect(result.docs).toBe(3);
		expect(result.planProgress).toBe(1);
		expect(result.skipped).toBe(1 + vanished.size); // dangling alias + four unreadable
	});

	it("imports a summary that the index does not list", async () => {
		// Hoisted children exist as files without an index entry; they must still
		// become nodes rather than being silently dropped.
		const extra = `eeee5555${"0".repeat(32)}`;
		const files = fixture();
		files.set(`summaries/${extra}.json`, JSON.stringify(summary(extra, { commitType: "commit" })));
		const { query } = await runImport(files);
		expect(await query("SELECT parent_hash, depth FROM memories WHERE commit_hash = ?", extra)).toEqual([
			{ parent_hash: null, depth: 0 },
		]);
	});

	it("falls back to first-seen time for an unparsable commit date, and says so", async () => {
		const files = fixture();
		files.set(`summaries/${H.other}.json`, JSON.stringify(summary(H.other, { commitDate: "not-a-date" })));
		const { query } = await runImport(files);
		// Not 0: a 1970 timestamp sorts the memory to the front of every by-date
		// view forever. The column is NOT NULL and derived from an optional field,
		// so the write module owns an explicit fallback instead of `|| 0`.
		expect(await query("SELECT commit_date_ms FROM memories WHERE commit_hash = ?", H.other)).toEqual([
			{ commit_date_ms: 1_000 }, // runImport's clock
		]);
	});

	it("skips a transcript session with no id", async () => {
		const files = fixture();
		files.set(
			"transcripts/t-root.json",
			JSON.stringify({
				sessions: [
					{ source: "claude", entries: [] },
					{ sessionId: "ok", entries: [] },
				],
			}),
		);
		const { result, query } = await runImport(files);
		expect(await query("SELECT session_id FROM transcript_sessions WHERE transcript_id = 't-root'")).toEqual([
			{ session_id: "ok" },
		]);
		expect(result.skipped).toBe(2); // dangling alias + the id-less session
	});

	it("leaves branch and original slug empty when a key carries no commit suffix", async () => {
		const files = fixture();
		files.delete("plans/my-plan-aaaa1111.md");
		files.delete("plan-progress/my-plan-aaaa1111.json");
		files.set("plans/no-suffix.md", "Body without a heading.\n");
		const { query } = await runImport(files);
		expect(
			await query("SELECT context_key, branch, original_slug, title FROM context WHERE kind = 'plan'"),
		).toEqual([{ context_key: "no-suffix", branch: null, original_slug: null, title: null }]);
	});

	it("leaves branch empty when the suffix matches no index entry", async () => {
		const files = fixture();
		files.set("notes/orphan-note-99999999.md", "# Orphan\n");
		const { query } = await runImport(files);
		expect(await query("SELECT branch FROM context WHERE context_key = 'orphan-note-99999999'")).toEqual([
			{ branch: null },
		]);
	});

	it("keeps a plan whose index entry records no branch", async () => {
		const files = fixture();
		const index = JSON.parse(files.get("index.json") as string) as {
			entries: Array<Record<string, unknown>>;
		};
		for (const entry of index.entries) if (entry.commitHash === H.root) entry.branch = undefined;
		files.set("index.json", JSON.stringify(index));
		const { query } = await runImport(files);
		expect(await query("SELECT branch, original_slug FROM context WHERE kind = 'plan'")).toEqual([
			{ branch: null, original_slug: "my-plan" },
		]);
	});

	it("imports a reference with no url", async () => {
		const files = fixture();
		files.set(
			"references/linear/NOURL-1.md",
			[
				"---",
				'source: "linear"',
				'nativeId: "NOURL-1"',
				'title: "No link"',
				'referencedAt: "2026-07-10T06:15:09.171Z"',
				'sourceToolName: "tool"',
				"---",
				"",
				"Body.",
				"",
			].join("\n"),
		);
		const { query } = await runImport(files);
		expect(await query("SELECT url FROM context WHERE native_id = 'NOURL-1'")).toEqual([{ url: null }]);
	});

	it("falls back to the filename when a progress artifact records no slug", async () => {
		const files = fixture();
		files.set(
			"plan-progress/my-plan-aaaa1111.json",
			JSON.stringify({ version: 1, summary: "no slug recorded", steps: [] }),
		);
		const { query } = await runImport(files);
		expect(await query("SELECT plan_slug FROM plan_progress")).toEqual([{ plan_slug: "my-plan-aaaa1111" }]);
	});

	it("skips a topic page that cannot be read", async () => {
		const files = fixture();
		files.set("topics/broken.json", "{ not json");
		const { result, query } = await runImport(files);
		expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM topic_pages"))[0].n).toBe(1);
		expect(result.skipped).toBe(2); // dangling alias + the broken page
	});

	it("keeps rows whose artifact is still listed but no longer parses", async () => {
		// The skip path must never double as a delete: one bad parse would
		// otherwise erase memory that is still on the branch.
		const files = fixture();
		await runImport(files);
		files.set(`summaries/${H.other}.json`, "{ not json");
		files.set("references/linear/JOLLI-1909-067f53c5.md", "frontmatter gone");
		files.set("topics/auth-login.json", "{ not json");

		const { result, query } = await runImport(files, 2_000);

		expect(result.pruned).toBe(0);
		for (const [sql, expected] of [
			["SELECT COUNT(*) AS n FROM memories", 4],
			["SELECT COUNT(*) AS n FROM context", 3],
			["SELECT COUNT(*) AS n FROM topic_pages", 1],
		] as const) {
			expect((await query<{ n: number }>(sql))[0].n, sql).toBe(expected);
		}
		// The last good content is still there, untouched.
		expect(await query("SELECT title FROM context WHERE kind = 'reference'")).toEqual([
			{ title: "References are not pushed" },
		]);
	});

	it("defaults a topic page's optional fields", async () => {
		const files = fixture();
		files.set(
			"topics/minimal.json",
			JSON.stringify({
				schemaVersion: 1,
				stableSlug: "minimal",
				title: "Minimal",
				content: "c",
				sourceRefs: [],
				lastUpdatedAt: "2026",
			}),
		);
		const { query } = await runImport(files);
		expect(
			await query("SELECT summary, related_branches_json FROM topic_pages WHERE stable_slug = 'minimal'"),
		).toEqual([{ summary: null, related_branches_json: "[]" }]);
	});
});

describe("importRepoMemory — prune (set reconciliation)", () => {
	/** Drops one artifact of every family from a already-imported fixture. */
	function withDeletions(files: Map<string, string>): Map<string, string> {
		files.delete(`summaries/${H.mid}.json`); // a node WITH a child
		files.delete("transcripts/t-root.json");
		files.delete("notes/note-9f-bbbb2222.md");
		files.delete("plans/my-plan-aaaa1111.md"); // its progress artifact stays
		files.delete("topics/auth-login.json");
		const index = JSON.parse(files.get("index.json") as string) as Record<string, unknown>;
		index.commitAliases = {};
		files.set("index.json", JSON.stringify(index));
		files.set(
			"topics/processed.json",
			JSON.stringify({ schemaVersion: 1, processed: { summary: [], plan: [], note: [], userfile: [] } }),
		);
		return files;
	}

	it("deletes the rows whose source artifact is gone", async () => {
		const files = fixture();
		await runImport(files);

		const { result, query } = await runImport(withDeletions(files), 2_000);

		// node + transcript + note + plan + topic page + processed ref + alias.
		// plan_progress is not counted here: the plan doc took it with it.
		expect(result.pruned).toBe(7);
		// H.mid alone is gone; the hashes sort aaaa < cccc < dddd.
		expect(await query("SELECT commit_hash FROM memories ORDER BY commit_hash")).toEqual([
			{ commit_hash: H.root },
			{ commit_hash: H.leaf },
			{ commit_hash: H.other },
		]);
		// The child of the deleted node was grounded first, so the self-referential
		// CASCADE could not take it along.
		expect(await query("SELECT parent_hash, depth FROM memories WHERE commit_hash = ?", H.leaf)).toEqual([
			{ parent_hash: null, depth: 0 },
		]);
		expect(await query("SELECT transcript_id FROM transcripts ORDER BY transcript_id")).toEqual([
			{ transcript_id: "t-leaf" },
			{ transcript_id: "t-mid" },
			{ transcript_id: "t-shared" },
		]);
		expect(await query("SELECT kind FROM context")).toEqual([{ kind: "reference" }]);
		for (const sql of [
			"SELECT COUNT(*) AS n FROM transcript_sessions WHERE transcript_id = 't-root'",
			"SELECT COUNT(*) AS n FROM plan_progress",
			"SELECT COUNT(*) AS n FROM topic_pages",
			"SELECT COUNT(*) AS n FROM topic_source_refs",
			"SELECT COUNT(*) AS n FROM topic_processed_sources",
			"SELECT COUNT(*) AS n FROM commit_aliases",
			`SELECT COUNT(*) AS n FROM memories WHERE commit_hash = '${H.mid}'`,
		]) {
			expect((await query<{ n: number }>(sql))[0].n, sql).toBe(0);
		}
		// The cascade reached the links too, without a trigger doing it: the
		// self-referencing foreign key takes the subtree and memory_transcripts
		// hangs off the node it belonged to.
		expect(
			(
				await query<{ n: number }>(
					`SELECT COUNT(*) AS n FROM memory_transcripts WHERE commit_hash = '${H.mid}'`,
				)
			)[0].n,
		).toBe(0);
	});

	it("skips the processed-sources prune when the file is unparsable, not deleting the mark", async () => {
		const files = fixture();
		await runImport(files);
		const before = await withDashboardDb(
			(db) => (db.prepare("SELECT COUNT(*) AS n FROM topic_processed_sources").get() as { n: number }).n,
			{ dbPath },
		);
		expect(before).toBeGreaterThan(0);
		// A truncated file must not read as "nothing is processed" — that would
		// wipe the topic KB's high-water mark and make every ingested source look
		// unprocessed again, silently.
		const damaged = fixture();
		damaged.set("topics/processed.json", "{ truncated");
		const { result, query } = await runImport(damaged, 2_000);
		expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM topic_processed_sources"))[0].n).toBe(before);
		expect(result.skipped).toBeGreaterThan(0);
	});

	it("converges — a further run over the same shrunken branch prunes nothing", async () => {
		const files = fixture();
		await runImport(files);
		const shrunk = withDeletions(files);
		await runImport(shrunk, 2_000);
		const { result } = await runImport(shrunk, 3_000);
		expect(result.pruned).toBe(0);
	});

	it("catch-up NEVER deletes — the only legal mode once a repo is fenced", async () => {
		// The post-fence gap-fill scenario: after the fence, new memories exist
		// only in SQLite, and to a reconciliation pass they look exactly like
		// "deleted from the branch". A catch-up over a shrunken branch must
		// therefore keep every row a seed would have pruned.
		const files = fixture();
		await runImport(files);
		const before = await withDashboardDb(
			(db) => (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n,
			{ dbPath },
		);
		const { result } = await runImport(withDeletions(files), 2_000, "catch-up");
		expect(result.pruned).toBe(0);
		const after = await withDashboardDb(
			(db) => (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n,
			{ dbPath },
		);
		expect(after).toBe(before);
	});

	it("repeated catch-up over the same gap stays importable and keeps the stored mount", async () => {
		// The reorder's phase 1 used to shift EVERY positioned row into the offset
		// region unconditionally, and phase 2 only settled the hashes this run
		// actually listed. A row catch-up deliberately keeps but cannot re-place —
		// `H.mid` here, whose summary file is gone — was therefore first torn out
		// of its tree, then left parked at 1·OFFSET, and the NEXT catch-up shifted
		// it to 2·OFFSET, tripping CHECK (child_pos < 2000000). Catch-up no longer
		// touches stored topology at all, so repeated passes must both stay
		// importable AND leave the row exactly where the stored tree mounted it.
		const files = fixture();
		await runImport(files);
		const shrunk = withDeletions(files);
		await runImport(shrunk, 2_000, "catch-up");
		await expect(runImport(shrunk, 3_000, "catch-up")).resolves.toBeDefined();
		const { query } = await runImport(shrunk, 4_000, "catch-up");
		// The offset region is empty at rest — a parked row would read as
		// "a run crashed mid-reorder" to inspection query 2.
		expect(await query<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE child_pos >= 1000000")).toEqual([
			{ n: 0 },
		]);
		// The kept row still hangs off its stored parent — this is the fenced-repo
		// contract: a row the branch has no file for is exactly what a post-fence
		// SQLite-only child looks like, and grounding it would tear the amend
		// history apart on every dashboard pass.
		const kept = await query<{ parent_hash: string | null; child_pos: number | null }>(
			"SELECT parent_hash, child_pos FROM memories WHERE commit_hash = ?",
			H.mid,
		);
		expect(kept).toEqual([{ parent_hash: H.root, child_pos: 0 }]);
	});

	it("defaults to catch-up, because the costs of a wrong guess are asymmetric", async () => {
		// A seed that should have been a catch-up deletes data permanently; a
		// catch-up that should have been a seed leaves stale rows a later seed
		// removes. The default must therefore be the recoverable mistake.
		const files = fixture();
		await runImport(files);
		const result = await withDashboardDb(
			(db) => importRepoMemory(db, { repo, storage: new InMemoryStorage(withDeletions(files)), nowMs: 2_000 }),
			{ dbPath },
		);
		expect(result.pruned).toBe(0);
	});

	it("keeps the alias map when index.json cannot be read", async () => {
		// A null index means "unreadable", not "no aliases" — it is the map's only
		// source, so pruning against an empty set would wipe it on a bad read.
		const files = fixture();
		await runImport(files);
		files.delete("index.json");

		const { result, query } = await runImport(files, 2_000);

		expect(result.pruned).toBe(0);
		expect(await query("SELECT old_hash FROM commit_aliases")).toEqual([{ old_hash: "oldsha" }]);
	});
});

describe("memory_topics — the summary's topics, one row per topic", () => {
	/** A summary carrying `n` topics, each with its own category. */
	const withTopics = (hash: string, topics: ReadonlyArray<Record<string, unknown>>): string =>
		JSON.stringify(summary(hash, { topics: topics as never }));

	it("projects each topic with its own category and array position", async () => {
		// The point of the table: category and importance belong to the TOPIC. A
		// commit spanning three categories has three rows, not one "dominant" value
		// — collapsing them by mode is what made `security` and `docs` disappear
		// from the old read model entirely.
		const files = fixture();
		files.set(
			`summaries/${H.root}.json`,
			withTopics(H.root, [
				{ title: "add the thing", category: "feature", importance: "major", decisions: "d1" },
				{ title: "fix the other", category: "bugfix", importance: "minor", decisions: "d2" },
				{ title: "harden it", category: "security", importance: "major", decisions: "d3" },
			]),
		);
		const { result, query } = await runImport(files);
		expect(result.commitTopics).toBe(3);
		expect(
			await query(
				"SELECT pos, category, importance, title FROM memory_topics WHERE commit_hash = ? ORDER BY pos",
				H.root,
			),
		).toEqual([
			{ pos: 0, category: "feature", importance: "major", title: "add the thing" },
			{ pos: 1, category: "bugfix", importance: "minor", title: "fix the other" },
			{ pos: 2, category: "security", importance: "major", title: "harden it" },
		]);
	});

	it("groups by category across commits, which is the query the table exists for", async () => {
		const files = fixture();
		files.set(
			`summaries/${H.root}.json`,
			withTopics(H.root, [
				{ title: "a", category: "bugfix", decisions: "d" },
				{ title: "b", category: "bugfix", decisions: "d" },
			]),
		);
		files.set(
			`summaries/${H.other}.json`,
			withTopics(H.other, [{ title: "c", category: "bugfix", decisions: "d" }]),
		);
		const { query } = await runImport(files);
		expect(
			await query(
				`SELECT category, COUNT(*) AS topics, COUNT(DISTINCT commit_hash) AS commits
				   FROM memory_topics WHERE category = 'bugfix' GROUP BY category`,
			),
		).toEqual([{ category: "bugfix", topics: 3, commits: 2 }]);
	});

	it("replaces the whole group, so a regenerated summary with fewer topics converges", async () => {
		// An upsert alone would leave the surplus rows behind forever, and `pos` is
		// part of the primary key so shifting positions in place would collide.
		const files = fixture();
		files.set(
			`summaries/${H.root}.json`,
			withTopics(H.root, [
				{ title: "one", category: "feature", decisions: "d" },
				{ title: "two", category: "bugfix", decisions: "d" },
				{ title: "three", category: "ux", decisions: "d" },
			]),
		);
		await runImport(files);
		files.set(
			`summaries/${H.root}.json`,
			withTopics(H.root, [{ title: "merged", category: "refactor", decisions: "d" }]),
		);
		const { query } = await runImport(files, 2_000);
		expect(await query("SELECT pos, category, title FROM memory_topics WHERE commit_hash = ?", H.root)).toEqual([
			{ pos: 0, category: "refactor", title: "merged" },
		]);
	});

	it("stores a topic with no category as NULL rather than inventing one", async () => {
		// The model is asked for a category but may omit it; NULL is the honest
		// answer and the pages already have a bucket for it.
		const files = fixture();
		files.set(`summaries/${H.root}.json`, withTopics(H.root, [{ title: "uncategorised work", decisions: "d" }]));
		const { query } = await runImport(files);
		expect(await query("SELECT category, importance FROM memory_topics WHERE commit_hash = ?", H.root)).toEqual([
			{ category: null, importance: null },
		]);
	});

	it("skips and counts a topic with no title instead of storing a blank", async () => {
		// title is NOT NULL: a topic with nothing to display is not groupable
		// either, and a blank would make every reader special-case it.
		const files = fixture();
		files.set(
			`summaries/${H.root}.json`,
			withTopics(H.root, [
				{ category: "feature", decisions: "d" },
				{ title: "real", category: "bugfix", decisions: "d" },
			]),
		);
		const { result, query } = await runImport(files);
		expect(result.commitTopics).toBe(1);
		expect(result.skipped).toBeGreaterThan(0);
		expect(await query("SELECT title, pos FROM memory_topics WHERE commit_hash = ?", H.root)).toEqual([
			// pos 1 is preserved: it is the array index, not a running counter, so the
			// surviving rows still point at their place in summary_json.
			{ title: "real", pos: 1 },
		]);
	});

	it("goes away with its memory", async () => {
		const files = fixture();
		files.set(`summaries/${H.mid}.json`, withTopics(H.mid, [{ title: "t", category: "feature", decisions: "d" }]));
		const { query } = await runImport(files);
		expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM memory_topics"))[0].n).toBeGreaterThan(0);
		// Removing the summary file makes the prune pass drop the memory row, and the
		// foreign key takes its topics with it — no trigger and no explicit delete.
		files.delete(`summaries/${H.mid}.json`);
		await runImport(files, 2_000);
		expect(
			(await query<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_topics WHERE commit_hash = '${H.mid}'`))[0].n,
		).toBe(0);
	});
});

describe("importRepoMemory — catch-up on a fenced repo (post-fence SQLite rows)", () => {
	/** Simulates the post-cutover live write path: a row that exists ONLY in SQLite. */
	const insertSqliteOnlyChild = (hash: string, parent: string, pos: number, atMs: number): Promise<unknown> =>
		withDashboardDb(
			(db) => {
				const parentRow = db
					.prepare("SELECT root_hash, depth, repo_id FROM memories WHERE commit_hash = ?")
					.get(parent) as { root_hash: string; depth: number; repo_id: number };
				return db
					.prepare(
						`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
						                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						parentRow.repo_id,
						hash,
						parent,
						pos,
						parentRow.root_hash,
						parentRow.depth + 1,
						JSON.stringify(summary(hash)),
						atMs,
						atMs,
						atMs,
					);
			},
			{ dbPath },
		);
	const fenceMs = 4_000;
	const postFence = `eeee5555${"0".repeat(32)}`;

	it("keeps a SQLite-only child mounted in its tree across repeated passes", async () => {
		// THE cutover data-corruption scenario: after the fence the QueueWorker
		// writes an amend child to SQLite only; the frozen branch has no file for
		// it. Every dashboard run replays a catch-up import from the frozen tip,
		// and each pass used to tear the child out of its tree (global shift +
		// settle-only-source + flatten) while leaving root_hash/depth pointing
		// into the tree it was torn from.
		const files = fixture();
		await runImport(files);
		await insertSqliteOnlyChild(postFence, H.leaf, 0, 5_000);
		const { query } = await runImport(files, 6_000, "catch-up", fenceMs);
		await runImport(files, 7_000, "catch-up", fenceMs);
		const rows = await query<{ parent_hash: string | null; root_hash: string; depth: number }>(
			"SELECT parent_hash, root_hash, depth FROM memories WHERE commit_hash = ?",
			postFence,
		);
		expect(rows).toEqual([{ parent_hash: H.leaf, root_hash: H.root, depth: 3 }]);
		// The whole repo stays inspection-clean: no grounded row carries another
		// tree's root_hash (what the rootTopology query reports as a write bug).
		expect(
			await query<{ n: number }>(
				"SELECT COUNT(*) AS n FROM memories WHERE parent_hash IS NULL AND (root_hash != commit_hash OR depth != 0)",
			),
		).toEqual([{ n: 0 }]);
	});

	it("never rolls protected content back to the frozen version", async () => {
		// A post-fence regeneration rewrote the summary body in SQLite; the frozen
		// branch still has the old body. Without protection every dashboard pass
		// would revert it — permanently, since the branch never moves again.
		const files = fixture();
		await runImport(files);
		await withDashboardDb(
			(db) =>
				db
					.prepare("UPDATE memories SET summary_json = ?, written_at_ms = ? WHERE commit_hash = ?")
					.run(
						JSON.stringify({ ...summary(H.root), commitMessage: "regenerated after fence" }),
						5_000,
						H.root,
					),
			{ dbPath },
		);
		const { query } = await runImport(files, 6_000, "catch-up", fenceMs);
		const [row] = await query<{ summary_json: string }>(
			"SELECT summary_json FROM memories WHERE commit_hash = ?",
			H.root,
		);
		expect(JSON.parse(row.summary_json).commitMessage).toBe("regenerated after fence");
		// Without the fence stamp the source wins — the pre-cutover contract.
		await runImport(files, 7_000, "catch-up");
		const [reverted] = await query<{ summary_json: string }>(
			"SELECT summary_json FROM memories WHERE commit_hash = ?",
			H.root,
		);
		expect(JSON.parse(reverted.summary_json).commitMessage).toBe(`msg ${H.root.slice(0, 4)}`);
	});

	it("protects post-fence transcripts, docs, plan progress and topic pages the same way", async () => {
		const files = fixture();
		await runImport(files);
		await withDashboardDb(
			(db) => {
				db.prepare("UPDATE transcripts SET written_at_ms = ? WHERE transcript_id = 't-root'").run(5_000);
				db.prepare("UPDATE context SET updated_at_ms = ?, body_md = 'post-fence body' WHERE kind = 'plan'").run(
					5_000,
				);
				db.prepare('UPDATE plan_progress SET updated_at_ms = ?, artifact_json = \'{"planSlug":"x"}\'').run(
					5_000,
				);
				db.prepare(
					"UPDATE topic_pages SET last_updated_at = '2026-07-02T00:00:00.000Z', title = 'newer'",
				).run();
			},
			{ dbPath },
		);
		// One protect stamp covers both clocks: the row stamps above (5_000) and
		// the topic page's payload ISO stamp (real epoch ms) are each >= 4_000.
		const { query } = await runImport(files, 6_000, "catch-up", fenceMs);
		expect(await query("SELECT body_md FROM context WHERE kind = 'plan'")).toEqual([
			{ body_md: "post-fence body" },
		]);
		expect(await query("SELECT artifact_json FROM plan_progress")).toEqual([{ artifact_json: '{"planSlug":"x"}' }]);
		expect(await query("SELECT title FROM topic_pages")).toEqual([{ title: "newer" }]);
		expect(await query("SELECT written_at_ms FROM transcripts WHERE transcript_id = 't-root'")).toEqual([
			{ written_at_ms: 5_000 },
		]);
	});

	it("stamps catch-up session_turns above the sync cursor, not at the fence", async () => {
		// `session_turns.recorded_at_ms` is the session-sync keyset cursor, NOT a
		// protect-guard column (nothing reads it to decide whether a source may win —
		// the transcript body's guard is `written_at_ms`). On a fenced repo the cursor
		// has already advanced to "now" via post-cutover live projections, so a catch-up
		// that re-projects turns at the `written_at_ms`-semantics `stampMs` (fence-1)
		// would land them BELOW that cursor, where the keyset scan pages straight over
		// them — a silent, permanent sync loss, the exact failure the backfill's own
		// `Math.max(now, max+1)` floor exists to prevent.
		const files = fixture({
			// Real entries: an empty `entries[]` projects zero rows, hiding the bug.
			"transcripts/t-root.json": JSON.stringify({
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [
							{ role: "human", timestamp: "2026-07-01T00:00:00.000Z" },
							{ role: "assistant", timestamp: "2026-07-01T00:01:00.000Z" },
						],
					},
				],
			}),
		});
		// Pre-fence import: writes the transcript at written_at_ms = 2_000 (< fence), so
		// the catch-up below is NOT protected away and actually re-projects it. The `s1`
		// sessions row does not exist yet, so no turns are written on this pass.
		await runImport(files, 2_000);
		await withDashboardDb(
			(db) => {
				const repoId = (db.prepare("SELECT id FROM repos").get() as { id: number }).id;
				// The row `projectSessionTurns` joins on to resolve s1 → event_id.
				db.prepare(
					"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES (?, ?, 'claude', 's1', ?)",
				).run("evt-s1", repoId, 2_000);
				// An already-advanced cursor: a live post-cutover projection at 9_000.
				db.prepare(
					"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES (?, ?, 'claude', 'live', ?)",
				).run("evt-live", repoId, 9_000);
				db.prepare(
					`INSERT INTO session_turns (session_event_id, slice_id, seq, role, ts_ms, kind, recorded_at_ms)
					 VALUES ('evt-live', 'live-slice', 0, 'human', 9000, 'turn', 9000)`,
				).run();
			},
			{ dbPath },
		);
		// Catch-up on the fenced repo: stampMs = min(6_000, fenceMs - 1) = 3_999.
		const { query } = await runImport(files, 6_000, "catch-up", fenceMs);
		const [row] = await query<{ lo: number | null; n: number }>(
			"SELECT MIN(recorded_at_ms) AS lo, COUNT(*) AS n FROM session_turns WHERE session_event_id = 'evt-s1'",
		);
		expect(row.n).toBe(2); // the projection actually ran
		// Every re-projected turn sits at or above the cursor it found (9_000), never
		// at the fence-derived 3_999.
		expect(row.lo).toBeGreaterThanOrEqual(9_000);
	});

	it("fills a genuinely missing node by mounting against the STORED tree", async () => {
		const files = fixture();
		await runImport(files);
		await withDashboardDb((db) => db.prepare("DELETE FROM memories WHERE commit_hash = ?").run(H.leaf), { dbPath });
		const { query } = await runImport(files, 6_000, "catch-up", fenceMs);
		expect(
			await query<{ parent_hash: string | null; root_hash: string; depth: number }>(
				"SELECT parent_hash, root_hash, depth FROM memories WHERE commit_hash = ?",
				H.leaf,
			),
		).toEqual([{ parent_hash: H.mid, root_hash: H.root, depth: 2 }]);
	});

	it("appends a gap-fill whose recorded slot a newer stored child took", async () => {
		const files = fixture();
		await runImport(files);
		await withDashboardDb((db) => db.prepare("DELETE FROM memories WHERE commit_hash = ?").run(H.leaf), { dbPath });
		// A post-fence child now occupies leaf's recorded position under mid.
		await insertSqliteOnlyChild(postFence, H.mid, 0, 5_000);
		const { query } = await runImport(files, 6_000, "catch-up", fenceMs);
		const rows = await query<{ commit_hash: string; child_pos: number }>(
			"SELECT commit_hash, child_pos FROM memories WHERE parent_hash = ? ORDER BY child_pos",
			H.mid,
		);
		expect(rows).toEqual([
			{ commit_hash: postFence, child_pos: 0 },
			{ commit_hash: H.leaf, child_pos: 1 },
		]);
	});

	it("heals rows the flattening importer damaged (stale root_hash/depth on grounded rows)", async () => {
		const files = fixture();
		await runImport(files);
		// What the pre-fix importer left behind: grounded edge, stale root/depth.
		await withDashboardDb(
			(db) =>
				db.prepare("UPDATE memories SET parent_hash = NULL, child_pos = NULL WHERE commit_hash = ?").run(H.mid),
			{ dbPath },
		);
		const { query } = await runImport(new Map(), 6_000, "catch-up");
		// mid is a self-consistent root again, and its kept child re-rooted onto it.
		expect(
			await query<{ root_hash: string; depth: number }>(
				"SELECT root_hash, depth FROM memories WHERE commit_hash = ?",
				H.mid,
			),
		).toEqual([{ root_hash: H.mid, depth: 0 }]);
		expect(
			await query<{ root_hash: string; depth: number }>(
				"SELECT root_hash, depth FROM memories WHERE commit_hash = ?",
				H.leaf,
			),
		).toEqual([{ root_hash: H.mid, depth: 1 }]);
	});

	it("un-shifts rows a crashed seed left parked in the offset region, keeping their edges", async () => {
		// The region must end up empty either way (inspection query 2 reads a
		// non-empty one as "crashed mid-reorder", and the next seed's shift is
		// bounded below REORDER_OFFSET). But catch-up empties it by UNDOING the
		// shift, not by grounding: seed phase 1 only ever ADDS to `child_pos`, so a
		// parked row still has a perfectly good parent edge, and catch-up never
		// re-mounts an existing row — grounding here flattened every amend/squash
		// chain into independent roots with no way back on a fenced repo.
		const files = fixture();
		await runImport(files);
		const before = await withDashboardDb(
			(db) => {
				const pos = (
					db.prepare("SELECT child_pos AS p FROM memories WHERE commit_hash = ?").get(H.leaf) as { p: number }
				).p;
				db.prepare("UPDATE memories SET child_pos = child_pos + 1000000 WHERE commit_hash = ?").run(H.leaf);
				return pos;
			},
			{ dbPath },
		);
		const { query } = await runImport(new Map(), 6_000, "catch-up");
		expect(await query<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE child_pos >= 1000000")).toEqual([
			{ n: 0 },
		]);
		expect(
			await query<{ parent_hash: string | null; root_hash: string; child_pos: number }>(
				"SELECT parent_hash, root_hash, child_pos FROM memories WHERE commit_hash = ?",
				H.leaf,
			),
		).toEqual([{ parent_hash: H.mid, root_hash: H.root, child_pos: before }]);
	});

	it("skips the seed prune when the repo was fenced mid-import", async () => {
		// The TOCTOU: the caller decided `seed` from a fence read taken before a
		// minutes-long import; the fence (here: the CAS's repo_state row) landed
		// mid-run. The prune must stand down — post-fence SQLite-only rows look
		// exactly like branch deletions to it.
		const files = fixture();
		await runImport(files);
		await withDashboardDb(
			(db) => {
				const repoId = (db.prepare("SELECT id FROM repos").get() as { id: number }).id;
				db.prepare("INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'cutover', '{}')").run(repoId);
			},
			{ dbPath },
		);
		files.delete(`summaries/${H.mid}.json`);
		const { result, query } = await runImport(files, 6_000, "seed");
		expect(result.pruned).toBe(0);
		expect(await query("SELECT 1 AS ok FROM memories WHERE commit_hash = ?", H.mid)).toEqual([{ ok: 1 }]);
	});
});

/**
 * The vertical slice: memories migrate one at a time, in whole-tree batches,
 * with the resume cursor committing alongside the rows it certifies.
 *
 * These are the tests that justify the restructure. The equivalence evidence is
 * above (every pre-existing case still passes against the new driver); what
 * follows pins the properties the old whole-set passes could not have.
 */
describe("importRepoMemory — batched migration and resume", () => {
	/** `n` independent single-node trees — enough to cross the 200-node batch boundary. */
	function manyRoots(n: number): Map<string, string> {
		const files = new Map<string, string>();
		const entries: unknown[] = [];
		for (let i = 0; i < n; i++) {
			const hash = `${String(i).padStart(8, "0")}${"e".repeat(32)}`;
			files.set(`summaries/${hash}.json`, JSON.stringify(summary(hash)));
			entries.push({
				commitHash: hash,
				parentCommitHash: null,
				commitMessage: `msg ${i}`,
				commitDate: "2026-07-01T00:00:00.000Z",
				branch: "main",
				generatedAt: "g",
			});
		}
		files.set("index.json", JSON.stringify({ version: 3, entries, commitAliases: {} }));
		return files;
	}

	/** Storage that fails every read of `poison`, to cut a run off mid-import. */
	class FailingStorage extends InMemoryStorage {
		constructor(
			files: Map<string, string>,
			private readonly poison: string,
		) {
			super(files);
		}
		override async readFile(path: string): Promise<string | null> {
			if (path === this.poison) throw new Error("orphan read blew up");
			return super.readFile(path);
		}
	}

	const importWith = async (
		storage: StorageProvider,
		onProgress?: (p: { done: number; total?: number }) => void,
		mode: "seed" | "catch-up" = "seed",
	): Promise<SotImportResult> =>
		withDashboardDb(
			(db) =>
				importRepoMemory(db, {
					repo,
					storage,
					nowMs: 1_000,
					mode,
					...(onProgress ? { onProgress } : {}),
				}),
			{ dbPath },
		);

	const rows = <T>(sql: string, ...p: unknown[]): Promise<T[]> =>
		withDashboardDb((db: DashboardDbHandle) => db.prepare(sql).all(...p) as T[], { dbPath });

	const state = async (): Promise<Record<string, unknown>> => {
		const [row] = await rows<{ value: string }>("SELECT value FROM repo_state WHERE key = 'orphan-import'");
		return JSON.parse(row.value) as Record<string, unknown>;
	};

	it("fires one progress event per memory while the cursor advances per batch", async () => {
		const seen: Array<{ done: number; total?: number }> = [];
		await importWith(new InMemoryStorage(manyRoots(250)), (p) => seen.push({ ...p }));

		// One per memory — the whole point of slicing by commit.
		expect(seen).toHaveLength(250);
		expect(seen.map((p) => p.done)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
		expect(new Set(seen.map((p) => p.total))).toEqual(new Set([250]));
	});

	it("resumes from the cursor after a crash and lands on the same rows as one clean run", async () => {
		const files = manyRoots(250);
		const poisoned = `summaries/${String(200).padStart(8, "0")}${"e".repeat(32)}.json`;

		await expect(importWith(new FailingStorage(files, poisoned))).rejects.toThrow("orphan read blew up");
		// The first batch committed; the cursor and the failure both landed.
		expect(await state()).toMatchObject({
			state: "failed",
			cursor: { nextIndex: 200, phase1Done: true },
		});
		expect(await rows("SELECT commit_hash FROM memories")).toHaveLength(200);

		const seen: Array<{ done: number }> = [];
		await importWith(new InMemoryStorage(files), (p) => seen.push({ done: p.done }));
		// Picked up where it stopped rather than redoing the first 200.
		expect(seen[0].done).toBe(201);
		expect(seen).toHaveLength(50);

		const resumed = await rows<Record<string, unknown>>("SELECT * FROM memories ORDER BY commit_hash");
		// A clean single run into a fresh database must produce the identical set.
		rmSync(dbPath, { force: true });
		await importWith(new InMemoryStorage(files));
		const clean = await rows<Record<string, unknown>>("SELECT * FROM memories ORDER BY commit_hash");
		expect(resumed).toEqual(clean);
	});

	it("refuses to resume a cursor another MODE wrote, restarting instead", async () => {
		// The fingerprint describes the ORDERING, which is identical in both modes, so
		// it cannot carry this. A catch-up cursor resumed by a later seed skipped the
		// whole imported prefix — `seedPhase1`'s shift pushed those rows into the
		// offset region, the settle pass (which only walks what the seed visits) never
		// re-grounded them, and `groundOffsetResidue` NULLed their parent/pos, turning
		// every amend chain in the prefix into an independent root.
		const files = manyRoots(250);
		const poisoned = `summaries/${String(200).padStart(8, "0")}${"e".repeat(32)}.json`;

		await expect(importWith(new FailingStorage(files, poisoned), undefined, "catch-up")).rejects.toThrow();
		expect(await state()).toMatchObject({ cursor: { nextIndex: 200, mode: "catch-up" } });

		// A seed run must NOT trust that cursor: it starts over from position 1.
		const seen: Array<{ done: number }> = [];
		await importWith(new InMemoryStorage(files), (p) => seen.push({ done: p.done }), "seed");
		expect(seen[0].done).toBe(1);
		expect(seen).toHaveLength(250);

		// And every amend chain is still mounted, not orphaned into separate roots.
		const orphaned = await rows<{ n: number }>(
			"SELECT COUNT(*) AS n FROM memories WHERE child_pos IS NOT NULL AND parent_hash IS NULL",
		);
		expect(orphaned[0].n).toBe(0);
	});

	it("does not count a skipped summary as a migrated memory across a resume", async () => {
		// `nextIndex` advances past a body that will not parse; `nodes` does not.
		// Inheriting the position as a row count made the final "Migrated N
		// memories" overstate itself by one per corrupt file.
		const files = manyRoots(250);
		const bad = `${String(5).padStart(8, "0")}${"e".repeat(32)}`;
		files.set(`summaries/${bad}.json`, "{ not json");
		const poisoned = `summaries/${String(200).padStart(8, "0")}${"e".repeat(32)}.json`;
		await expect(importWith(new FailingStorage(files, poisoned))).rejects.toThrow();
		const cursor = (await state()).cursor as { nextIndex: number; nodes: number };
		expect(cursor.nextIndex).toBe(200);
		expect(cursor.nodes).toBe(199);

		await importWith(new InMemoryStorage(files));
		// 250 listed, one unparsable — 249 rows, and the receipt says so.
		expect(await rows("SELECT commit_hash FROM memories")).toHaveLength(249);
		expect((await state()).nodes).toBe(249);
	});

	it("discards the cursor when the summary set changed under it", async () => {
		const files = manyRoots(250);
		const poisoned = `summaries/${String(200).padStart(8, "0")}${"e".repeat(32)}.json`;
		await expect(importWith(new FailingStorage(files, poisoned))).rejects.toThrow();

		// A new memory reorders `ordered`, so the recorded index means something
		// else now. Starting over is the only safe reading.
		const extra = `${"f".repeat(8)}${"e".repeat(32)}`;
		files.set(`summaries/${extra}.json`, JSON.stringify(summary(extra)));
		const index = JSON.parse(files.get("index.json") as string) as { entries: unknown[] };
		index.entries.push({
			commitHash: extra,
			parentCommitHash: null,
			commitMessage: "extra",
			commitDate: "2026-07-01T00:00:00.000Z",
			branch: "main",
			generatedAt: "g",
		});
		files.set("index.json", JSON.stringify({ ...index, commitAliases: {} }));

		const seen: Array<{ done: number }> = [];
		await importWith(new InMemoryStorage(files), (p) => seen.push({ done: p.done }));
		expect(seen[0].done).toBe(1);
		expect(await rows("SELECT commit_hash FROM memories")).toHaveLength(251);
	});

	it("does not re-run the seed shift on resume, so child_pos never reaches 2x the offset", async () => {
		// Two runs over an amend tree: the second resumes with `phase1Done` set.
		// Re-shifting would push positions to 2·REORDER_OFFSET and trip
		// CHECK (child_pos < 2000000) — the residue check, not a hypothetical.
		const files = fixture();
		await runImport(files);
		const before = await rows<{ child_pos: number | null }>("SELECT child_pos FROM memories ORDER BY commit_hash");
		await runImport(files, 2_000);
		const after = await rows<{ child_pos: number | null }>("SELECT child_pos FROM memories ORDER BY commit_hash");
		expect(after).toEqual(before);
		for (const row of after) expect(row.child_pos ?? 0).toBeLessThan(REORDER_OFFSET);
	});

	it("still imports a transcript no summary references", async () => {
		// The old importer walked `transcripts/` as its own family. Slicing by
		// memory would drop an unreferenced file silently, which is a behaviour
		// change disguised as a refactor.
		const files = fixture();
		files.set(
			"transcripts/t-orphaned.json",
			JSON.stringify({ sessions: [{ sessionId: "s-orphan", entries: [] }] }),
		);
		await runImport(files);
		expect(await rows("SELECT transcript_id FROM transcripts WHERE transcript_id = 't-orphaned'")).toHaveLength(1);
		// Present, but linked to nothing — exactly its old shape.
		expect(await rows("SELECT 1 AS ok FROM memory_transcripts WHERE transcript_id = 't-orphaned'")).toEqual([]);
	});

	it("never links a transcript whose file exists but does not parse", async () => {
		// The file listing says it is there; only the parse says whether a row
		// will exist. Linking on the listing would fail the FK and take the whole
		// batch down.
		const files = fixture();
		files.set("transcripts/t-root.json", "{ not json");
		const { query } = await runImport(files);
		expect(await query("SELECT 1 AS ok FROM transcripts WHERE transcript_id = 't-root'")).toEqual([]);
		expect(await query("SELECT 1 AS ok FROM memory_transcripts WHERE transcript_id = 't-root'")).toEqual([]);
	});

	it("rolls the whole batch back when the progress callback throws", async () => {
		await expect(
			importWith(new InMemoryStorage(manyRoots(10)), () => {
				throw new Error("renderer exploded");
			}),
		).rejects.toThrow("renderer exploded");
		expect(await rows("SELECT commit_hash FROM memories")).toEqual([]);
	});

	it("restamps pid and startedAt on every run but keeps a matching cursor", async () => {
		const files = manyRoots(250);
		const poisoned = `summaries/${String(200).padStart(8, "0")}${"e".repeat(32)}.json`;
		await expect(importWith(new FailingStorage(files, poisoned))).rejects.toThrow();
		const crashed = await state();
		// Forge a dead pid and an ancient start, as a crashed run would leave behind.
		await withDashboardDb(
			(db) => {
				const repoId = (db.prepare("SELECT id FROM repos").get() as { id: number }).id;
				db.prepare("UPDATE repo_state SET value = ? WHERE repo_id = ? AND key = 'orphan-import'").run(
					JSON.stringify({ ...crashed, pid: 999_999, startedAt: 1 }),
					repoId,
				);
			},
			{ dbPath },
		);
		await importWith(new InMemoryStorage(files));
		const done = await state();
		expect(done).toMatchObject({ state: "done", pid: process.pid, startedAt: 1_000 });
		// Finished runs carry no cursor — a leftover one would make the next run
		// skip the repo entirely.
		expect(done.cursor).toBeUndefined();
	});

	it("falls back to a single unmetered pass when index.json cannot be read", async () => {
		const files = fixture();
		files.set("index.json", "{ broken");
		const seen: Array<{ done: number; total?: number }> = [];
		await withDashboardDb(
			(db) =>
				importRepoMemory(db, {
					repo,
					storage: new InMemoryStorage(files),
					nowMs: 1_000,
					mode: "seed",
					onProgress: (p) => seen.push({ ...p }),
				}),
			{ dbPath },
		);
		// No skeleton means no denominator and no cursor to resume from — but the
		// rows still land, which is the behaviour this importer always had.
		expect(seen.every((p) => p.total === undefined)).toBe(true);
		expect(await rows("SELECT commit_hash FROM memories")).toHaveLength(4);
		expect((await state()).cursor).toBeUndefined();
	});
});
