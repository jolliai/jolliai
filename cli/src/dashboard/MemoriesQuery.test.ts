import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDashboardDb } from "./DashboardDb.js";
import type { DashboardScope } from "./DashboardModel.js";
import { MEMORIES_LIST_LIMIT } from "./DashboardModel.js";
import { buildMemories, buildMemoriesList, buildMemoryDetail, readContextDoc } from "./MemoriesQuery.js";
import { applyStatsEvents } from "./StatsWriter.js";

const ALL: DashboardScope = { kind: "all" };

async function seedRepo(dbPath: string, repoIdentity: string, repoName: string): Promise<void> {
	await applyStatsEvents(
		[
			{
				producerKind: "cli",
				event: { type: "repo.enabled", repoIdentity, repoName, worktreeRoot: `/w/${repoName}`, enabledAt: "t" },
			},
		],
		{ producerKind: "cli", dbPath },
	);
}

interface SeedMemoryOptions {
	readonly branch?: string;
	readonly ticketId?: string;
	readonly commitDateMs?: number;
	readonly jolliDocId?: number;
	readonly topics?: ReadonlyArray<{
		readonly title: string;
		readonly category?: string;
		readonly decisions?: string;
		readonly trigger?: string;
		readonly response?: string;
		readonly todo?: string;
		readonly filesAffected?: ReadonlyArray<string>;
	}>;
	readonly conversationTokenBreakdown?: { input: number; output: number; cached: number };
	readonly estimatedCostUsd?: number;
	readonly pricesAsOf?: string;
	readonly llm?: { model: string; inputTokens: number; outputTokens: number; cachedTokens?: number };
	readonly recap?: string;
	readonly references?: ReadonlyArray<{ source: string; nativeId: string; title: string; url?: string }>;
	readonly plans?: ReadonlyArray<{ slug: string; title: string; addedAt: string; updatedAt: string }>;
	readonly notes?: ReadonlyArray<{
		id: string;
		title: string;
		format: "markdown";
		addedAt: string;
		updatedAt: string;
	}>;
	readonly excludedContext?: ReadonlyArray<{
		kind: "plan" | "note" | "reference";
		key: string;
		title: string;
		reason: string;
	}>;
	readonly e2eTestGuide?: ReadonlyArray<{
		title: string;
		preconditions?: string;
		steps: ReadonlyArray<string>;
		expectedResults: ReadonlyArray<string>;
	}>;
}

/** Seeds one `memories` row (+ its `memory_topics`) with a hand-built summary payload. */
async function seedMemory(
	dbPath: string,
	repoIdentity: string,
	hash: string,
	message: string,
	opts: SeedMemoryOptions = {},
): Promise<void> {
	await withDashboardDb(
		(db) => {
			const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as {
				id: number;
			};
			const summary = {
				commitHash: hash,
				commitMessage: message,
				commitAuthor: "Ada Lovelace",
				...(opts.branch ? { branch: opts.branch } : {}),
				...(opts.ticketId ? { ticketId: opts.ticketId } : {}),
				...(opts.topics ? { topics: opts.topics } : {}),
				...(opts.conversationTokenBreakdown
					? { conversationTokenBreakdown: opts.conversationTokenBreakdown }
					: {}),
				...(opts.estimatedCostUsd != null ? { estimatedCostUsd: opts.estimatedCostUsd } : {}),
				...(opts.pricesAsOf ? { pricesAsOf: opts.pricesAsOf } : {}),
				...(opts.llm ? { llm: opts.llm } : {}),
				...(opts.recap ? { recap: opts.recap } : {}),
				...(opts.references ? { references: opts.references } : {}),
				...(opts.plans ? { plans: opts.plans } : {}),
				...(opts.notes ? { notes: opts.notes } : {}),
				...(opts.excludedContext ? { excludedContext: opts.excludedContext } : {}),
				...(opts.e2eTestGuide ? { e2eTestGuide: opts.e2eTestGuide } : {}),
				...(opts.jolliDocId != null ? { jolliDocId: opts.jolliDocId } : {}),
				diffStats: { filesChanged: 2, insertions: 10, deletions: 3 },
			};
			db.prepare(
				`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
				                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
				 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, ?)`,
			).run(repoId, hash, hash, JSON.stringify(summary), opts.commitDateMs ?? 1);
			(opts.topics ?? []).forEach((topic, pos) => {
				db.prepare(
					"INSERT INTO memory_topics (repo_id, commit_hash, pos, category, title) VALUES (?, ?, ?, ?, ?)",
				).run(repoId, hash, pos, topic.category ?? null, topic.title);
			});
		},
		{ dbPath },
	);
}

/** Seeds the activity-layer `commits`/`commit_files` rows a memory's files section reads. */
async function seedCommitFiles(
	dbPath: string,
	repoIdentity: string,
	hash: string,
	files: ReadonlyArray<{ path: string; insertions?: number; deletions?: number }>,
): Promise<void> {
	await withDashboardDb(
		(db) => {
			const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as {
				id: number;
			};
			db.prepare(
				`INSERT INTO commits (event_id, repo_id, hash, committed_at_ms)
				 VALUES (?, ?, ?, 1)`,
			).run(`commit:${repoIdentity}:${hash}`, repoId, hash);
			const { id: commitId } = db
				.prepare("SELECT id FROM commits WHERE repo_id = ? AND hash = ?")
				.get(repoId, hash) as {
				id: number;
			};
			files.forEach((f) => {
				db.prepare("INSERT INTO commit_files (commit_id, path, insertions, deletions) VALUES (?, ?, ?, ?)").run(
					commitId,
					f.path,
					f.insertions ?? null,
					f.deletions ?? null,
				);
			});
		},
		{ dbPath },
	);
}

/** Seeds one session (+ optional tool-use rows) and links it to a memory via transcripts. */
async function seedLinkedSession(
	dbPath: string,
	repoIdentity: string,
	hash: string,
	opts: {
		readonly source: string;
		readonly sessionId: string;
		readonly title: string;
		readonly messageCount: number;
		readonly tools?: ReadonlyArray<{
			toolName: string;
			kind: "builtin" | "mcp" | "skill";
			server?: string;
			calls: number;
		}>;
		/**
		 * The ARCHIVED turns, which is what a conversation row counts (the
		 * `sessions` row's `message_count` is the whole live session and keeps
		 * growing after the commit). Defaults to `messageCount` synthetic turns so
		 * existing cases keep asserting the number they always did.
		 */
		readonly entries?: ReadonlyArray<{ role: "human" | "assistant"; content: string }>;
		/** Extra transcript files this same session is sliced across (amend chain). */
		readonly extraSliceHashes?: ReadonlyArray<string>;
	},
): Promise<void> {
	await withDashboardDb(
		(db) => {
			const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as {
				id: number;
			};
			const eventId = `session:${repoIdentity}:${opts.source}:${opts.sessionId}`;
			db.prepare(
				`INSERT INTO sessions (event_id, repo_id, source, session_id, title, updated_at_ms, message_count)
				 VALUES (?, ?, ?, ?, ?, 1, ?)`,
			).run(eventId, repoId, opts.source, opts.sessionId, opts.title, opts.messageCount);
			(opts.tools ?? []).forEach((t) => {
				db.prepare(
					"INSERT INTO session_tool_use (session_event_id, tool_name, kind, server, calls) VALUES (?, ?, ?, ?, ?)",
				).run(eventId, t.toolName, t.kind, t.server ?? null, t.calls);
			});
			const entries =
				opts.entries ??
				Array.from({ length: opts.messageCount }, (_, i) => ({
					role: i % 2 === 0 ? ("human" as const) : ("assistant" as const),
					content: `turn ${i}`,
				}));
			// One transcript per slice, all naming the same session — the amend-chain
			// shape a memory really has. The blob is the deflated transcript FILE, the
			// same encoding `SqliteStorage` reads back.
			for (const sliceHash of [hash, ...(opts.extraSliceHashes ?? [])]) {
				const transcriptId = `${sliceHash}-${opts.sessionId}`;
				const blob = deflateSync(
					Buffer.from(
						JSON.stringify({
							sessions: [
								{
									sessionId: opts.sessionId,
									source: opts.source,
									entries: sliceHash === hash ? entries : [],
								},
							],
						}),
					),
				);
				db.prepare(
					"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, 1)",
				).run(repoId, transcriptId, blob);
				db.prepare("INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)").run(
					repoId,
					hash,
					transcriptId,
				);
				db.prepare(
					"INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)",
				).run(repoId, transcriptId, opts.sessionId, opts.source);
			}
		},
		{ dbPath },
	);
}

describe("MemoriesQuery", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-memq-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("buildMemoriesList", () => {
		it("lists memories newest first, across repos, with category/ticket/synced set from real columns", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: add rate limiter", {
				commitDateMs: 2000,
				ticketId: "ACME-1",
				jolliDocId: 42,
				branch: "develop",
				topics: [{ title: "t1", category: "feature" }],
			});
			await seedMemory(dbPath, "repo-1", "b".repeat(40), "fix: token refresh race", {
				commitDateMs: 1000,
			});

			const list = await withDashboardDb((db) => buildMemoriesList(db, ALL), { dbPath });

			expect(list.items.map((i) => i.commitHash)).toEqual(["a".repeat(40), "b".repeat(40)]);
			const newest = list.items[0];
			expect(newest.shortHash).toBe("a".repeat(7));
			expect(newest.memoryRefId).toBe("JM-42");
			expect(newest.title).toBe("feat: add rate limiter");
			expect(newest.ticketId).toBe("ACME-1");
			expect(newest.category).toBe("feature");
			expect(newest.branch).toBe("develop");
			expect(newest.synced).toBe(true);
			expect(list.items[1].synced).toBe(false);
			expect(list.items[1].memoryRefId).toBeUndefined();
			expect(list.items[1].category).toBeUndefined();
			expect(list.totalCount).toBe(2);
			expect(list.truncated).toBe(false);
			expect(list.vitals).toEqual({ memories: 2, topics: 1, repos: 1 });
		});

		it("scopes to one repo and truncates past MEMORIES_LIST_LIMIT", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedRepo(dbPath, "repo-2", "acme-web");
			await seedMemory(dbPath, "repo-2", "c".repeat(40), "other repo's commit", { commitDateMs: 1 });
			for (let n = 0; n < MEMORIES_LIST_LIMIT + 5; n++) {
				await seedMemory(dbPath, "repo-1", n.toString(16).padStart(40, "0"), `commit ${n}`, {
					commitDateMs: n + 100,
				});
			}

			const scoped = await withDashboardDb(
				(db) => buildMemoriesList(db, { kind: "repo", repoIdentity: "repo-1" }),
				{
					dbPath,
				},
			);
			expect(scoped.items).toHaveLength(MEMORIES_LIST_LIMIT);
			expect(scoped.truncated).toBe(true);
			expect(scoped.totalCount).toBe(MEMORIES_LIST_LIMIT + 5);
			expect(scoped.items.every((i) => i.repoIdentity === "repo-1")).toBe(true);
		});

		it("shows only the root (current generation) of an amended/squashed memory tree", async () => {
			// Mirrors how SummaryStore's migrateOneToOneLocked / mergeManyToOneLocked
			// actually write the tree: the NEW commit becomes the file's top node
			// (parent_hash NULL in the DB) and the superseded OLD commit is nested
			// under it as a child (parent_hash = the new hash). "Current" is
			// therefore identified by `parent_hash IS NULL`, not by "has no children".
			await seedRepo(dbPath, "repo-1", "acme-api");
			const superseded = "a".repeat(40);
			const current = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", superseded, "initial implementation", { commitDateMs: 1000 });
			await seedMemory(dbPath, "repo-1", current, "initial implementation", { commitDateMs: 2000 });
			await withDashboardDb(
				(db) => {
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
						id: number;
					};
					db.prepare(
						"UPDATE memories SET parent_hash = ?, child_pos = 0, root_hash = ?, depth = 1 WHERE repo_id = ? AND commit_hash = ?",
					).run(current, current, repoId, superseded);
				},
				{ dbPath },
			);

			const list = await withDashboardDb((db) => buildMemoriesList(db, ALL), { dbPath });
			expect(list.items.map((item) => item.commitHash)).toEqual([current]);
			expect(list.totalCount).toBe(1);
		});
	});

	describe("buildMemoryDetail", () => {
		it("returns undefined for an unknown hash", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, "f".repeat(40)), { dbPath });
			expect(detail).toBeUndefined();
		});

		it("splits a topic's decisions prose into bullets, and falls back to one bullet for a plain sentence", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: add rate limiter", {
				branch: "main",
				topics: [
					{
						title: "Rate limiter",
						category: "feature",
						trigger: "API was getting hammered",
						response: "Added a token-bucket limiter",
						decisions: "- **Chose token bucket**: simplest to reason about\n- Reject over quota with 429",
						todo: "Add per-tenant limits",
						filesAffected: ["src/limiter.ts"],
					},
					{
						title: "Docs",
						trigger: "Needed a README section",
						response: "Wrote one",
						decisions: "Just documented the existing behaviour.",
					},
				],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.topics).toHaveLength(2);
			expect(detail?.topics[0].decisions).toEqual([
				"Chose token bucket: simplest to reason about",
				"Reject over quota with 429",
			]);
			expect(detail?.topics[0].files).toEqual(["src/limiter.ts"]);
			expect(detail?.topics[0].todo).toBe("Add per-tenant limits");
			expect(detail?.topics[1].decisions).toEqual(["Just documented the existing behaviour."]);
			expect(detail?.branch).toBe("main");
			expect(detail?.author).toBe("Ada Lovelace");
		});

		it("omits the token meter when conversationTokenBreakdown is absent, rather than rendering a zero bar", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "chore: bump deps");
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.tokens).toBeUndefined();
		});

		it("carries the token breakdown, cost and summarizer info when present", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", {
				conversationTokenBreakdown: { input: 1000, output: 500, cached: 200 },
				estimatedCostUsd: 1.23,
				pricesAsOf: "2026-07-04",
				llm: { model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 100, cachedTokens: 50 },
			});
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.tokens).toEqual({
				input: 1000,
				output: 500,
				cached: 200,
				costUsd: 1.23,
				pricesAsOf: "2026-07-04",
			});
			expect(detail?.summarizedBy).toEqual({ model: "claude-haiku-4-5", tokens: 450 });
		});

		it("carries references, plans/notes as context, and excludedContext with its reason — and treats absent as empty, not missing", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", {
				ticketId: "ACME-1",
				recap: "Added a token-bucket rate limiter with per-tenant overrides.",
				references: [
					{ source: "linear", nativeId: "ACME-1", title: "Add rate limiting", url: "https://linear.app/x" },
					{ source: "github", nativeId: "42", title: "PR #42" },
				],
				plans: [{ slug: "rate-limit-plan", title: "Rate limiting plan", addedAt: "t", updatedAt: "t" }],
				notes: [{ id: "n1", title: "A note", format: "markdown", addedAt: "t", updatedAt: "t" }],
				excludedContext: [
					{
						kind: "reference",
						key: "linear:OTHER-1",
						title: "Unrelated ticket",
						reason: "different feature area",
					},
				],
			});
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.ticketId).toBe("ACME-1");
			expect(detail?.recap).toBe("Added a token-bucket rate limiter with per-tenant overrides.");
			expect(detail?.references).toEqual([
				{ source: "linear", nativeId: "ACME-1", title: "Add rate limiting", url: "https://linear.app/x" },
				{ source: "github", nativeId: "42", title: "PR #42" },
			]);
			// `contextKey` is the plan slug / note id — what the Context dialog
			// fetches the body by.
			expect(detail?.context).toEqual([
				{ kind: "plan", title: "Rate limiting plan", contextKey: "rate-limit-plan" },
				{ kind: "note", title: "A note", contextKey: "n1" },
			]);
			expect(detail?.excluded).toEqual([{ title: "Unrelated ticket", reason: "different feature area" }]);

			const hash2 = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", hash2, "chore: y");
			const bare = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash2), { dbPath });
			expect(bare?.references).toEqual([]);
			expect(bare?.context).toEqual([]);
			expect(bare?.excluded).toEqual([]);
		});

		it("joins linked sessions into conversations and their tool calls into activity", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "Building the rate limiter",
				messageCount: 12,
				tools: [
					{ toolName: "Read", kind: "builtin", calls: 22 },
					{ toolName: "search_issues", kind: "mcp", server: "linear", calls: 3 },
				],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations).toEqual([
				{ source: "claude", title: "Building the rate limiter", messageCount: 12 },
			]);
			expect(detail?.activity).toEqual(
				expect.arrayContaining([
					{ label: "Read", kind: "builtin", calls: 22 },
					{ label: "linear", kind: "mcp", calls: 3 },
				]),
			);
			expect(detail?.activityUncoveredSources).toEqual([]);
		});

		it("reports an uncovered source honestly instead of a fabricated zero-activity claim", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			// codex cannot record tool calls today — a linked codex session with no
			// session_tool_use rows must not read as "this memory used no tools".
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "codex",
				sessionId: "s1",
				title: "Codex session",
				messageCount: 5,
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.activity).toEqual([]);
			expect(detail?.activityUncoveredSources).toEqual(["codex"]);
		});

		it("reads per-file diffs from commit_files, and e2e scenarios verbatim", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", {
				e2eTestGuide: [
					{
						title: "Rate limiter kicks in",
						steps: ["Send 100 requests fast"],
						expectedResults: ["429 after quota"],
					},
					{
						title: "Limiter resets after the window",
						preconditions: "Quota was exhausted in the previous scenario",
						steps: ["Wait for the window to roll over", "Send one more request"],
						expectedResults: ["200 OK"],
					},
				],
			});
			await seedCommitFiles(dbPath, "repo-1", hash, [
				{ path: "src/limiter.ts", insertions: 40, deletions: 2 },
				{ path: "src/limiter.test.ts", insertions: 60 },
				{ path: "src/limiter.md", deletions: 1 },
			]);

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.files).toEqual([
				{ path: "src/limiter.md", deletions: 1 },
				{ path: "src/limiter.test.ts", insertions: 60 },
				{ path: "src/limiter.ts", insertions: 40, deletions: 2 },
			]);
			expect(detail?.e2e).toEqual([
				{
					title: "Rate limiter kicks in",
					steps: ["Send 100 requests fast"],
					expectedResults: ["429 after quota"],
				},
				{
					title: "Limiter resets after the window",
					preconditions: "Quota was exhausted in the previous scenario",
					steps: ["Wait for the window to roll over", "Send one more request"],
					expectedResults: ["200 OK"],
				},
			]);
		});

		it("carries a token breakdown without a cost/pricing stamp, and summarizer tokens without a cached count", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", {
				conversationTokenBreakdown: { input: 800, output: 400, cached: 0 },
				llm: { model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 100 },
			});
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.tokens).toEqual({ input: 800, output: 400, cached: 0 });
			expect(detail?.summarizedBy).toEqual({ model: "claude-haiku-4-5", tokens: 400 });
		});

		it("falls back to an empty title and omits branch/author/diff-size when the summary carries none of them", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await withDashboardDb(
				(db) => {
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
						id: number;
					};
					db.prepare(
						`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
						                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
						 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, ?)`,
					).run(repoId, hash, hash, JSON.stringify({ commitHash: hash }), 1);
				},
				{ dbPath },
			);

			const list = await withDashboardDb((db) => buildMemoriesList(db, ALL), { dbPath });
			expect(list.items[0].title).toBe("");
			expect(list.items[0].branch).toBeUndefined();

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.title).toBe("");
			expect(detail?.branch).toBeUndefined();
			expect(detail?.author).toBeUndefined();
			expect(detail?.filesChanged).toBeUndefined();
			expect(detail?.insertions).toBeUndefined();
			expect(detail?.deletions).toBeUndefined();
		});

		it("falls back to the first archived user turn when the source recorded no title", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "",
				messageCount: 0,
				entries: [
					{ role: "human", content: "why is the proxy 504ing" },
					{ role: "assistant", content: "..." },
				],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			// `resolveSessionTitle`'s step 3, which is what the editor lands on for an
			// archived session (no stored title, no live transcript to read).
			expect(detail?.conversations).toEqual([
				{ source: "claude", title: "why is the proxy 504ing", messageCount: 2 },
			]);
		});

		it("shows an amend chain's shared session ONCE, with its slices merged", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			// Three transcript files, one session — what a three-commit amend chain
			// files. The join this replaced had no DISTINCT and rendered it 3 times.
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "One conversation",
				messageCount: 3,
				extraSliceHashes: ["b".repeat(40), "c".repeat(40)],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations).toEqual([{ source: "claude", title: "One conversation", messageCount: 3 }]);
		});

		it("drops a usage-only carrier session, the way the editor's conversation list does", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await withDashboardDb(
				(db) => {
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
						id: number;
					};
					const blob = deflateSync(
						Buffer.from(
							JSON.stringify({
								sessions: [
									// A carrier: no turns, but a recorded usage so `detach` has a
									// subtrahend. Not a conversation.
									{
										sessionId: "carrier",
										source: "claude",
										entries: [],
										usage: { input: 1, output: 2, cached: 0 },
									},
									// Entry-less WITHOUT usage is legacy data and stays visible.
									{ sessionId: "legacy", source: "claude", entries: [] },
								],
							}),
						),
					);
					db.prepare(
						"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, 1)",
					).run(repoId, `${hash}-t`, blob);
					db.prepare(
						"INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)",
					).run(repoId, hash, `${hash}-t`);
				},
				{ dbPath },
			);

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations).toEqual([{ source: "claude", title: "(untitled session)", messageCount: 0 }]);
		});
	});

	describe("buildMemories", () => {
		it("returns just the list when no hash is given", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: x", { commitDateMs: 1 });
			const model = await withDashboardDb((db) => buildMemories(db, ALL, undefined), { dbPath });
			expect(model.items).toHaveLength(1);
			expect(model.selected).toBeUndefined();
		});

		it("attaches selected detail when hash resolves, and omits it when the hash does not resolve", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", { commitDateMs: 1 });

			const withSelection = await withDashboardDb((db) => buildMemories(db, ALL, hash), { dbPath });
			expect(withSelection.selected?.commitHash).toBe(hash);

			const withUnknownHash = await withDashboardDb((db) => buildMemories(db, ALL, "z".repeat(40)), { dbPath });
			expect(withUnknownHash.selected).toBeUndefined();
			expect(withUnknownHash.items).toHaveLength(1);
		});
	});
	describe("readContextDoc", () => {
		async function seedContextDoc(
			kind: "plan" | "note",
			contextKey: string,
			title: string,
			body: string,
		): Promise<void> {
			await withDashboardDb(
				(db) => {
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
						id: number;
					};
					db.prepare(
						`INSERT INTO context (repo_id, kind, context_key, title, body_md, created_at_ms)
						 VALUES (?, ?, ?, ?, ?, 1)`,
					).run(repoId, kind, contextKey, title, body);
				},
				{ dbPath },
			);
		}

		it("returns the document body by repo identity, kind and key", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedContextDoc("plan", "rate-limit-plan", "Rate limiting plan", "# Rate limiting plan\n\nStep one.");
			const doc = await withDashboardDb((db) => readContextDoc(db, "repo-1", "plan", "rate-limit-plan"), {
				dbPath,
			});
			expect(doc).toEqual({
				kind: "plan",
				title: "Rate limiting plan",
				bodyMd: "# Rate limiting plan\n\nStep one.",
			});
		});

		it("falls back to the key for a titleless row", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedContextDoc("note", "n1", "", "body");
			await withDashboardDb(
				(db) => db.prepare("UPDATE context SET title = NULL WHERE context_key = 'n1'").run(),
				{ dbPath },
			);
			const doc = await withDashboardDb((db) => readContextDoc(db, "repo-1", "note", "n1"), { dbPath });
			expect(doc).toEqual({ kind: "note", title: "n1", bodyMd: "body" });
		});

		it("accepts a unique repo NAME as the repo token, like every other route", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedContextDoc("plan", "p1", "P", "body");
			const doc = await withDashboardDb((db) => readContextDoc(db, "acme-api", "plan", "p1"), { dbPath });
			expect(doc?.bodyMd).toBe("body");
		});

		it("returns undefined for an unknown repo, kind or key rather than throwing", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedContextDoc("plan", "p1", "P", "body");
			const wrongRepo = await withDashboardDb((db) => readContextDoc(db, "repo-2", "plan", "p1"), { dbPath });
			const wrongKind = await withDashboardDb((db) => readContextDoc(db, "repo-1", "note", "p1"), { dbPath });
			const wrongKey = await withDashboardDb((db) => readContextDoc(db, "repo-1", "plan", "nope"), { dbPath });
			expect([wrongRepo, wrongKind, wrongKey]).toEqual([undefined, undefined, undefined]);
		});
	});
});
