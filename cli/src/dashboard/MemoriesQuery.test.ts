import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcriptRepairState } from "../core/TranscriptRepair.js";
import { withDashboardDb } from "./DashboardDb.js";
import type { DashboardScope } from "./DashboardModel.js";
import {
	buildMemories,
	buildMemoriesList,
	buildMemoriesPage,
	buildMemoryDetail,
	readContextDoc,
	readConversationEntries,
	readMemoryTranscriptRepairState,
} from "./MemoriesQuery.js";

// The predicate reads the machine-global `claude-owners.json` and stats every
// transcript it names, so a real call would answer differently on each developer's
// machine. Its own cases live in `TranscriptRepair.test.ts`; what these pin is the
// wiring around it. The `storage` provider the wiring hands it is a LAZY thunk the
// mocked predicate never resolves, so the real `createStorage` is never reached.
vi.mock("../core/TranscriptRepair.js", () => ({
	transcriptRepairState: vi.fn().mockResolvedValue("unrepairable"),
}));

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
	readonly llm?: {
		model: string;
		inputTokens: number;
		outputTokens: number;
		cachedTokens?: number;
		/** `LlmCredentialSource` — what the footer's `· via <provider>` is derived from. */
		source?: string;
	};
	readonly recap?: string;
	readonly references?: ReadonlyArray<{
		source: string;
		nativeId: string;
		title: string;
		url?: string;
		/** `ReferenceCommitRef.archivedKey` — absent on a hand-written fixture, present on a real archive. */
		archivedKey?: string;
		/** Newest query text of an `accumulateBody` source (context7, jollimemory). */
		latestQuery?: string;
	}>;
	readonly plans?: ReadonlyArray<{ slug: string; title: string; addedAt: string; updatedAt: string }>;
	/** `summary.skills` — the per-commit skill-usage snapshot. */
	readonly skills?: ReadonlyArray<{
		archivedKey: string;
		source: string;
		skill: string;
		entryPaths: ReadonlyArray<unknown>;
		invocationCount: number;
		firstUsedAt: string;
		lastUsedAt: string;
		usage?: { input: number; output: number; cached: number };
		detection?: "heuristic";
	}>;
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
	/** v5 `summary.transcripts` — the id ORDER the conversation list is built in. */
	readonly transcripts?: ReadonlyArray<string>;
	/** `summary.generatedAt` — when Jolli wrote this memory, which the footer stamps. */
	readonly generatedAt?: string;
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
				...(opts.skills ? { skills: opts.skills } : {}),
				...(opts.excludedContext ? { excludedContext: opts.excludedContext } : {}),
				...(opts.e2eTestGuide ? { e2eTestGuide: opts.e2eTestGuide } : {}),
				...(opts.jolliDocId != null ? { jolliDocId: opts.jolliDocId } : {}),
				...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
				...(opts.generatedAt != null ? { generatedAt: opts.generatedAt } : {}),
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
		/** `StoredSession.title` — the title the ARCHIVE recorded, absent on older memories. */
		readonly archivedTitle?: string;
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
									...(opts.archivedTitle ? { title: opts.archivedTitle } : {}),
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
			expect(list.vitals).toEqual({ memories: 2, topics: 1, repos: 1 });
		});

		// Two registered repos can share a display NAME — an upstream and its fork,
		// or two clones of the same project — and their commit hashes then overlap
		// by construction. `commitCategoryLabels` used to key its map by repo_name,
		// so in the all-repos scope one repo's category was painted onto the
		// other's memory. Keyed by repo_identity, each keeps its own.
		it("keeps category labels apart for two repos that share a display name", async () => {
			const hash = "d".repeat(40);
			await seedRepo(dbPath, "repo-upstream", "jolliai");
			await seedRepo(dbPath, "repo-fork", "jolliai");
			await seedMemory(dbPath, "repo-upstream", hash, "same hash, upstream", {
				commitDateMs: 2000,
				topics: [{ title: "t", category: "feature" }],
			});
			await seedMemory(dbPath, "repo-fork", hash, "same hash, fork", {
				commitDateMs: 1000,
				topics: [{ title: "t", category: "bugfix" }],
			});

			const list = await withDashboardDb((db) => buildMemoriesList(db, ALL), { dbPath });

			const byRepo = new Map(list.items.map((i) => [i.repoIdentity, i.category]));
			expect(byRepo.get("repo-upstream")).toBe("feature");
			expect(byRepo.get("repo-fork")).toBe("bugfix");
		});

		// The list used to be capped at 200 rows. It no longer is: a repo with more
		// history than that must still render every memory, not a "most recent" page.
		it("scopes to one repo and lists every memory past the old 200-row cap", async () => {
			const total = 205;
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedRepo(dbPath, "repo-2", "acme-web");
			await seedMemory(dbPath, "repo-2", "c".repeat(40), "other repo's commit", { commitDateMs: 1 });
			for (let n = 0; n < total; n++) {
				await seedMemory(dbPath, "repo-1", n.toString(16).padStart(40, "0"), `commit ${n}`, {
					commitDateMs: n + 100,
				});
			}

			const scoped = await withDashboardDb(
				(db) => buildMemoriesList(db, { kind: "repo", repoIdentities: ["repo-1"] }),
				{
					dbPath,
				},
			);
			expect(scoped.items).toHaveLength(total);
			expect(scoped.totalCount).toBe(total);
			expect(scoped.items.every((i) => i.repoIdentity === "repo-1")).toBe(true);
		});

		it("scopes to SEVERAL repos, and to no others", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedRepo(dbPath, "repo-2", "acme-web");
			await seedRepo(dbPath, "repo-3", "acme-docs");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "api commit", { commitDateMs: 1 });
			await seedMemory(dbPath, "repo-2", "b".repeat(40), "web commit", { commitDateMs: 2 });
			await seedMemory(dbPath, "repo-3", "c".repeat(40), "docs commit", { commitDateMs: 3 });

			const scoped = await withDashboardDb(
				(db) => buildMemoriesList(db, { kind: "repo", repoIdentities: ["repo-1", "repo-3"] }),
				{ dbPath },
			);
			expect(scoped.items.map((i) => i.repoIdentity).sort()).toEqual(["repo-1", "repo-3"]);
			expect(scoped.totalCount).toBe(2);
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

	describe("buildMemoriesPage", () => {
		/** Three memories, newest first: c > b > a. */
		async function seedThree(): Promise<void> {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "oldest", { commitDateMs: 1000 });
			await seedMemory(dbPath, "repo-1", "b".repeat(40), "middle", { commitDateMs: 2000 });
			await seedMemory(dbPath, "repo-1", "c".repeat(40), "newest", { commitDateMs: 3000 });
		}

		it("continues after the cursor's memory, and reports the whole reachable total", async () => {
			await seedThree();

			const page = await withDashboardDb(
				(db) => buildMemoriesPage(db, ALL, { repoIdentity: "repo-1", commitHash: "c".repeat(40) }),
				{ dbPath },
			);

			expect(page.items.map((i) => i.commitHash)).toEqual(["b".repeat(40), "a".repeat(40)]);
			// The total is the LIST's length, not the page's — it is what the client
			// compares its loaded count against to decide there is more to ask for.
			expect(page.totalCount).toBe(3);
			expect(page.cursorMissing).toBeUndefined();
		});

		it("starts at the top when no cursor is given", async () => {
			await seedThree();

			const page = await withDashboardDb((db) => buildMemoriesPage(db, ALL, undefined), { dbPath });

			expect(page.items.map((i) => i.commitHash)).toEqual(["c".repeat(40), "b".repeat(40), "a".repeat(40)]);
			expect(page.cursorMissing).toBeUndefined();
		});

		it("flags a cursor whose memory is gone and answers with the first page", async () => {
			// The rebase case: the reader's last-loaded memory dropped off every
			// branch mid-session. Answering an empty page would strand the tree;
			// restarting SILENTLY would return rows the client already holds, which
			// its dedupe drops — a "Load more" that does nothing however often it is
			// clicked. The flag is what lets the client re-seat itself.
			await seedThree();

			const page = await withDashboardDb(
				(db) => buildMemoriesPage(db, ALL, { repoIdentity: "repo-1", commitHash: "f".repeat(40) }),
				{ dbPath },
			);

			expect(page.cursorMissing).toBe(true);
			expect(page.items.map((i) => i.commitHash)).toEqual(["c".repeat(40), "b".repeat(40), "a".repeat(40)]);
		});

		it("does not treat an unreachable memory as a valid cursor", async () => {
			// Same row, two answers: the cursor names a memory that IS in the table
			// but which git no longer reaches, so it is not in the list being paged
			// and cannot be a position in it.
			await seedThree();
			const reachable = new Map([["repo-1", new Set(["a".repeat(40), "b".repeat(40)])]]);

			const page = await withDashboardDb(
				(db) => buildMemoriesPage(db, ALL, { repoIdentity: "repo-1", commitHash: "c".repeat(40) }, reachable),
				{ dbPath },
			);

			expect(page.cursorMissing).toBe(true);
			expect(page.items.map((i) => i.commitHash)).toEqual(["b".repeat(40), "a".repeat(40)]);
			expect(page.totalCount).toBe(2);
		});

		it("resolves a repo-NAME scope token, so paging a name-scoped page is not empty", async () => {
			// The `/api/memories` route hands this the raw `?repo=` token, and the
			// picker's common token is the repo NAME (`JD.repoToken` shortens to it
			// when unique), not the identity. Without resolving, the name matched no
			// identity, collapsed to the [-1] sentinel, and answered totalCount 0 +
			// cursorMissing, which the client renders as a wiped tree.
			await seedThree(); // repo_identity "repo-1", repo_name "acme-api"
			const byName: DashboardScope = { kind: "repo", repoIdentities: ["acme-api"] };

			const page = await withDashboardDb((db) => buildMemoriesPage(db, byName, undefined), { dbPath });

			expect(page.totalCount).toBe(3);
			expect(page.cursorMissing).toBeUndefined();
			expect(page.items.map((i) => i.commitHash)).toEqual(["c".repeat(40), "b".repeat(40), "a".repeat(40)]);
		});
	});

	describe("buildMemoryDetail", () => {
		it("returns undefined for an unknown hash", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, "f".repeat(40)), { dbPath });
			expect(detail).toBeUndefined();
		});

		it("returns undefined for an empty hash rather than matching an arbitrary row", async () => {
			// With the prefix predicate, `length("") = 0` would make
			// `substr(commit_hash, 1, 0) = ""` true for EVERY row — guarded explicitly.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: x");
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, ""), { dbPath });
			expect(detail).toBeUndefined();
		});

		it("resolves a SHORT hash prefix to the same memory as the full hash", async () => {
			// The wiki's source-commit links carry an 8-char hash, so /memories?hash=a742fa47
			// must open the same memory the full 40-char hash does.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = `a742fa47${"b".repeat(32)}`;
			await seedMemory(dbPath, "repo-1", hash, "feat: something", { branch: "main" });

			const short = await withDashboardDb((db) => buildMemoryDetail(db, ALL, "a742fa47"), { dbPath });
			const full = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(short?.commitHash).toBe(hash);
			expect(full?.commitHash).toBe(hash);
		});

		it("a SHORT hash opens the SAME rich detail (files + conversations) as the full hash", async () => {
			// Guards that the resolved row's FULL hash — not the short prefix — feeds
			// the downstream exact-match lookups (commit_files, transcripts). With the
			// short prefix, those miss and the detail silently degrades to a bare row:
			// no per-file line counts, no conversations.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = `a742fa47${"b".repeat(32)}`;
			await seedMemory(dbPath, "repo-1", hash, "feat: rich", { branch: "main" });
			await seedCommitFiles(dbPath, "repo-1", hash, [{ path: "src/a.ts", insertions: 10, deletions: 2 }]);
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "Session",
				messageCount: 4,
			});

			const short = await withDashboardDb((db) => buildMemoryDetail(db, ALL, "a742fa47"), { dbPath });
			const full = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			// Per-file line counts come ONLY from the hash-matched commit_files query;
			// a short-hash miss would fall back to (empty) topic filesAffected.
			expect(short?.files).toEqual([{ path: "src/a.ts", insertions: 10, deletions: 2 }]);
			expect(short?.files).toEqual(full?.files);
			expect(short?.conversations.length).toBeGreaterThan(0);
			expect(short?.conversations.length).toBe(full?.conversations.length);
		});

		it("resolves a short-hash prefix collision within ONE repo by a deterministic RULE (lexicographic hash)", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			// Seed the lexicographically-LARGER hash first, so a passing test proves the
			// ORDER BY commit_hash rule — not merely insertion/rowid order (which is what
			// `ORDER BY repo_id` alone left to the engine when repo_id ties within a repo).
			const h1 = `abcd1234${"1".repeat(32)}`; // lexicographically first
			const h2 = `abcd1234${"2".repeat(32)}`;
			await seedMemory(dbPath, "repo-1", h2, "second", { commitDateMs: 2 });
			await seedMemory(dbPath, "repo-1", h1, "first", { commitDateMs: 1 });

			// Both share prefix "abcd1234" in the SAME repo (same repo_id), so repo_id is
			// a tie; the full-hash tie-breaker must pick h1 — the lexicographically first —
			// regardless of insert order.
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, "abcd1234"), { dbPath });
			expect(detail?.commitHash).toBe(h1);
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
				total: 1700,
				input: 1000,
				output: 500,
				cached: 200,
				costUsd: 1.23,
				pricesAsOf: "2026-07-04",
			});
			expect(detail?.summarizedBy).toEqual({ model: "claude-haiku-4-5", tokens: 450 });
		});

		it("carries plans, notes and references as one ordered context list, and excludedContext with its reason — and treats absent as empty, not missing", async () => {
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
			// ONE ordered list, in the editor's Context-panel order: plans, notes,
			// references, skills. `contextKey` is what the Context dialog fetches the
			// body by — the plan slug, the note id, `<source>/<sanitized-key>` for a
			// reference. A reference with no archivedKey has no document, so it
			// carries no key and renders inert rather than as a button that 404s.
			expect(detail?.context).toEqual([
				{
					kind: "plan",
					title: "Rate limiting plan",
					contextKey: "rate-limit-plan",
					meta: "rate-limit-plan.md",
				},
				{ kind: "note", title: "A note", contextKey: "n1", meta: "n1.md" },
				{
					kind: "reference",
					// Leads with the nativeId: linear is a tracker whose key a reader recognizes.
					title: "ACME-1 — Add rate limiting",
					// The badge's letter and brand hue come from this — unconditional on a
					// reference row, including the keyless one below, which is precisely
					// the case whose `contextKey` prefix could not have stood in for it.
					source: "linear",
					meta: "ACME-1 (Linear)",
					url: "https://linear.app/x",
				},
				{ kind: "reference", title: "42 — PR #42", source: "github", meta: "42 (GitHub)" },
			]);
			expect(detail?.excluded).toEqual([{ title: "Unrelated ticket", reason: "different feature area" }]);

			const hash2 = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", hash2, "chore: y");
			const bare = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash2), { dbPath });
			expect(bare?.context).toEqual([]);
			expect(bare?.excluded).toEqual([]);
		});

		it("resolves a reference's context key from its archived key, drops it on an unsafe one, and falls back to the latest query for an accumulating source", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", {
				references: [
					// A real archive: the prefix is stripped and the remainder is path-safe.
					{
						source: "linear",
						nativeId: "ACME-9",
						title: "Rate limit followup",
						url: "https://linear.app/y",
						archivedKey: "linear:ACME-9-deadbeef",
					},
					// A path-unsafe nativeId behind the archived key — the catch branch.
					{ source: "linear", nativeId: "ACME-BAD", title: "broken key", archivedKey: "linear:../../etc" },
					// An accumulating source: leads with its title, not the nativeId, and
					// shows its newest query text instead of a `<nativeId> (Source)` meta.
					{
						source: "context7",
						nativeId: "lookup-1",
						title: "Context7 lookup",
						latestQuery: "how to use useEffect",
					},
					// Same source, no latestQuery at all — meta has nothing to show.
					{ source: "context7", nativeId: "lookup-2", title: "Context7 lookup 2" },
					// A legacy archived key with no `<source>:` prefix at all — used as-is
					// rather than stripped.
					{
						source: "linear",
						nativeId: "ACME-LEGACY",
						title: "old shape",
						archivedKey: "ACME-LEGACY-deadbeef",
					},
				],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			const [withKey, unsafeKey, withQuery, withoutQuery, noPrefix] = detail?.context ?? [];
			expect(noPrefix).toEqual({
				kind: "reference",
				title: "ACME-LEGACY — old shape",
				source: "linear",
				contextKey: "linear/ACME-LEGACY-deadbeef",
				meta: "ACME-LEGACY (Linear)",
			});
			expect(withKey).toEqual({
				kind: "reference",
				title: "ACME-9 — Rate limit followup",
				source: "linear",
				contextKey: "linear/ACME-9-deadbeef",
				meta: "ACME-9 (Linear)",
				url: "https://linear.app/y",
			});
			// The unsafe nativeId means no document to open — the badge still renders.
			expect(unsafeKey).toEqual({
				kind: "reference",
				title: "ACME-BAD — broken key",
				source: "linear",
				meta: "ACME-BAD (Linear)",
			});
			expect(withQuery).toEqual({
				kind: "reference",
				title: "Context7 lookup",
				source: "context7",
				meta: "how to use useEffect",
			});
			expect(withoutQuery).toEqual({ kind: "reference", title: "Context7 lookup 2", source: "context7" });
		});

		it("carries a synced JM-id in the detail payload when jolli_doc_id is set", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", { jolliDocId: 7 });
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.memoryRefId).toBe("JM-7");
			expect(detail?.synced).toBe(true);
		});

		it("carries a skills row, flagging inferred detection, when the commit used any", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", {
				skills: [
					{
						archivedKey: "claude:brainstorming-abcdefg",
						source: "claude",
						skill: "superpowers:brainstorming",
						entryPaths: [],
						invocationCount: 3,
						firstUsedAt: "t",
						lastUsedAt: "t",
						usage: { input: 100, output: 50, cached: 10 },
					},
					{
						archivedKey: "codex:review-abcdefg",
						source: "codex",
						skill: "review",
						entryPaths: [],
						invocationCount: 1,
						firstUsedAt: "t",
						lastUsedAt: "t",
						detection: "heuristic",
					},
				],
			});
			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			const skillsRow = detail?.context.find((row) => row.kind === "skills");
			expect(skillsRow).toMatchObject({ kind: "skills", title: "Skills used", contextKey: hash });
			expect(skillsRow?.meta).toContain("some inferred");
		});

		it("prefers the live sessions title but defaults a source-less archived session to claude", async () => {
			// The same default `buildConversations` gives an archived session with no
			// recorded source — `readConversationEntries` already covers this default
			// for the dialog; this pins it on the tree row too.
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
									{
										sessionId: "sess-nosource",
										entries: [{ role: "human", content: "hi" }],
									},
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
			expect(detail?.conversations[0]?.source).toBe("claude");
		});

		it("ignores a blank live session title, falling through to the next rung", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "sess-blank",
				title: "",
				messageCount: 1,
				entries: [{ role: "human", content: "restart the proxy" }],
			});
			// A live title that is present but blank must not win over the derived one.
			await withDashboardDb((db) => db.prepare("UPDATE sessions SET title = NULL").run(), { dbPath });

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations[0]?.title).toBe("restart the proxy");
		});

		it("skips one unreadable transcript blob without blanking the rest of the panel", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "sess-good",
				title: "readable",
				messageCount: 1,
			});
			await withDashboardDb(
				(db) => {
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
						id: number;
					};
					// Not deflated — inflateSync throws, which is exactly the "unreadable
					// blob" case one bad transcript file must not take the others down with.
					db.prepare(
						"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, 1)",
					).run(repoId, `${hash}-broken`, Buffer.from("not a valid zlib stream"));
					db.prepare(
						"INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)",
					).run(repoId, hash, `${hash}-broken`);
				},
				{ dbPath },
			);

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations).toHaveLength(1);
			expect(detail?.conversations[0]?.title).toBe("readable");
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
			// Exactly four fields: this row is serialized into the page, so anything
			// server-side on it would be in the payload. `toEqual` (not
			// `objectContaining`) is what pins that.
			expect(detail?.conversations).toEqual([
				{
					source: "claude",
					title: "Building the rate limiter",
					messageCount: 12,
					sessionId: "s1",
				},
			]);
			expect(detail?.activity).toEqual(
				expect.arrayContaining([
					{ label: "Read", kind: "builtin", calls: 22 },
					{ label: "linear", kind: "mcp", calls: 3 },
				]),
			);
			expect(detail?.activityUncoveredSources).toEqual([]);
		});

		it("counts one MCP server reached under two registrations as one activity row", async () => {
			// A Claude plugin's MCP entry is namespaced `plugin_<plugin>_<server>` by
			// the host; the same server registered in the repo's own `.mcp.json`
			// arrives bare. Jolli's own is registered BOTH ways on a normal install,
			// so without the fold this payload carries `jollimemory` twice — once
			// under each alias, each with half the calls. The MCPs card already
			// merges them; this is the same rule on the memory-detail payload.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "Recalling prior work",
				messageCount: 2,
				tools: [
					{ toolName: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 4 },
					{
						toolName: "plugin_jolli_jollimemory.recall",
						kind: "mcp",
						server: "plugin_jolli_jollimemory",
						calls: 6,
					},
				],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.activity).toEqual([{ label: "jollimemory", kind: "mcp", calls: 10 }]);
		});

		it("leaves a skill or builtin named like a plugin registration alone", async () => {
			// The fold is guarded on `kind = 'mcp'` for the same reason the MCPs
			// card's skill list keeps its raw column: `plugin_…` is an alias an MCP
			// host prepended, while a skill or builtin name is one somebody chose.
			// Renaming `plugin_manager_sync` to `sync` would silently merge it with
			// any unrelated skill of that name.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "Running skills",
				messageCount: 2,
				tools: [
					{ toolName: "plugin_manager_sync", kind: "skill", calls: 2 },
					{ toolName: "plugin_manager_probe", kind: "builtin", calls: 1 },
				],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.activity).toEqual(
				expect.arrayContaining([
					{ label: "plugin_manager_sync", kind: "skill", calls: 2 },
					{ label: "plugin_manager_probe", kind: "builtin", calls: 1 },
				]),
			);
		});

		it("orders conversations by the summary's transcripts[], not by query order", async () => {
			// The editor builds its list from `summary.transcripts`, so the two surfaces
			// disagreed on ORDER whenever SQLite handed the blobs back differently.
			// Seeded s1 first, then s2, and named in the opposite order.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", {
				transcripts: [`${hash}-s2`, `${hash}-s1`],
			});
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "first seeded",
				messageCount: 1,
			});
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s2",
				title: "second seeded",
				messageCount: 1,
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations.map((c) => c.sessionId)).toEqual(["s2", "s1"]);
		});

		it("keeps an unnamed transcript behind the named ones, in query order", async () => {
			// An id the summary does not name scores `rank.size`, and the sort is stable
			// — so it lands after everything named without disturbing its neighbours.
			// This is the pre-v5 / partially-listed case, not a corrupt one.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: y", { transcripts: [`${hash}-s3`] });
			for (const id of ["s1", "s2", "s3"]) {
				await seedLinkedSession(dbPath, "repo-1", hash, {
					source: "claude",
					sessionId: id,
					title: id,
					messageCount: 1,
				});
			}

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations.map((c) => c.sessionId)).toEqual(["s3", "s1", "s2"]);
		});

		it("keeps the FIRST rank for a transcript id repeated in summary.transcripts[]", async () => {
			// A squash that concatenated two summaries' transcripts[] arrays can repeat
			// a shared id — first occurrence wins, so a later repeat must not move it.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "c".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: z", {
				transcripts: [`${hash}-s2`, `${hash}-s1`, `${hash}-s2`],
			});
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "first",
				messageCount: 1,
			});
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s2",
				title: "second",
				messageCount: 1,
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations.map((c) => c.sessionId)).toEqual(["s2", "s1"]);
		});

		it("carries ONE conversation figure, with no transcript-file count beside it", async () => {
			// The pane prints `conversations.length` in three places — the section
			// header, the counts line and the footer's privacy note — so a SECOND
			// count on the payload is something a renderer can pick the wrong one
			// from. It briefly carried a transcript-FILE count for the note and did
			// exactly that: a real memory storing six sessions in two files rendered
			// "Conversations · 6" directly above "(2)". This fixture is that shape
			// inverted — one session sliced across three files — and the answer the
			// page needs is one, either way.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "one session, three slices",
				messageCount: 2,
				extraSliceHashes: ["b".repeat(40), "c".repeat(40)],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations).toHaveLength(1);
			expect(detail).not.toHaveProperty("transcriptCount");
		});

		it("carries the memory's OWN generation stamp, falling back to the commit date", async () => {
			// The footer prints this, so it has to be when Jolli wrote the memory —
			// the page's own `generatedAtMs` is "now" and would date every memory to
			// the current minute. `generatedAt` is persisted as an empty string on
			// some paths, which is the case the fallback exists for.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const stamped = "a".repeat(40);
			const blank = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", stamped, "feat: x", {
				generatedAt: "2026-08-14T03:22:00.000Z",
				commitDateMs: Date.parse("2026-08-14T03:00:00.000Z"),
			});
			await seedMemory(dbPath, "repo-1", blank, "feat: y", {
				generatedAt: "",
				commitDateMs: Date.parse("2026-07-02T09:15:00.000Z"),
			});

			const withStamp = await withDashboardDb((db) => buildMemoryDetail(db, ALL, stamped), { dbPath });
			const withoutStamp = await withDashboardDb((db) => buildMemoryDetail(db, ALL, blank), { dbPath });
			expect(withStamp?.generatedAtMs).toBe(Date.parse("2026-08-14T03:22:00.000Z"));
			expect(withoutStamp?.generatedAtMs).toBe(Date.parse("2026-07-02T09:15:00.000Z"));
		});

		it("attributes the provider off the summary, and omits it when none was recorded", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const attributed = "a".repeat(40);
			const legacy = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", attributed, "feat: x", {
				llm: { model: "claude-sonnet-5", inputTokens: 10, outputTokens: 5, source: "anthropic-config" },
			});
			// Written before `llm.source` existed. The footer omits the segment
			// rather than printing "via unknown", so the field has to stay absent
			// instead of falling back to a default label.
			await seedMemory(dbPath, "repo-1", legacy, "feat: y", {
				llm: { model: "claude-sonnet-5", inputTokens: 10, outputTokens: 5 },
			});

			const withSource = await withDashboardDb((db) => buildMemoryDetail(db, ALL, attributed), { dbPath });
			const withoutSource = await withDashboardDb((db) => buildMemoryDetail(db, ALL, legacy), { dbPath });
			expect(withSource?.provider).toBe("Anthropic");
			expect(withoutSource?.provider).toBeUndefined();
			// The provider is NOT read off `summarizedBy` — that one is the root's
			// own `llm` node and is present on both of these.
			expect(withoutSource?.summarizedBy).toBeDefined();
		});

		it("prefers the title the ARCHIVE recorded over the live sessions row", async () => {
			// The archived string is the full title ladder's answer as of this commit,
			// resolved while the transcript was still readable. The `sessions` row is a
			// different moment (whenever that session was last collected) and, for an
			// old memory or one that arrived on another machine, does not exist at all.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "claude",
				sessionId: "s1",
				title: "collected later, after the session moved on",
				archivedTitle: "Add the rate limiter",
				messageCount: 3,
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.conversations[0]?.title).toBe("Add the rate limiter");
		});

		it("falls back to the live row, then the archived first message, for a memory with no archived title", async () => {
			// Forward-only: every memory written before the field existed lands here,
			// and must read exactly as it did before.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const withRow = "a".repeat(40);
			const withoutRow = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", withRow, "feat: x");
			await seedMemory(dbPath, "repo-1", withoutRow, "feat: y");
			await seedLinkedSession(dbPath, "repo-1", withRow, {
				source: "claude",
				sessionId: "s1",
				title: "from the sessions row",
				messageCount: 2,
			});
			await seedLinkedSession(dbPath, "repo-1", withoutRow, {
				source: "claude",
				sessionId: "s2",
				title: "",
				messageCount: 1,
				entries: [{ role: "human", content: "restart the web backend" }],
			});

			const a = await withDashboardDb((db) => buildMemoryDetail(db, ALL, withRow), { dbPath });
			const b = await withDashboardDb((db) => buildMemoryDetail(db, ALL, withoutRow), { dbPath });
			expect(a?.conversations[0]?.title).toBe("from the sessions row");
			expect(b?.conversations[0]?.title).toBe("restart the web backend");
		});

		it("reports an uncovered source honestly instead of a fabricated zero-activity claim", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x");
			// The Cline VS Code extension cannot record tool calls (its tool results
			// are prose, not structure) — a linked session of its with no
			// session_tool_use rows must not read as "this memory used no tools".
			await seedLinkedSession(dbPath, "repo-1", hash, {
				source: "cline",
				sessionId: "s1",
				title: "Cline session",
				messageCount: 5,
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, hash), { dbPath });
			expect(detail?.activity).toEqual([]);
			expect(detail?.activityUncoveredSources).toEqual(["cline"]);
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
			expect(detail?.tokens).toEqual({ total: 1200, input: 800, output: 400, cached: 0 });
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
				{ source: "claude", title: "why is the proxy 504ing", messageCount: 2, sessionId: "s1" },
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
			expect(detail?.conversations).toEqual([
				{ source: "claude", title: "One conversation", messageCount: 3, sessionId: "s1" },
			]);
		});

		it("drops every zero-turn session — usage-only carrier and overlay-emptied shell alike", async () => {
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
									// Entry-less WITHOUT usage is an overlay-emptied shell ("Mark All
									// as Deleted") — a zero-turn `0 msgs` noise row, now hidden too.
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
			expect(detail?.conversations).toEqual([]);
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

		it("uses detailRepo (repo name) to disambiguate a short-hash prefix shared by two repos", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedRepo(dbPath, "repo-2", "acme-web");
			const h1 = `abcd1234${"1".repeat(32)}`;
			const h2 = `abcd1234${"2".repeat(32)}`;
			await seedMemory(dbPath, "repo-1", h1, "in api", { commitDateMs: 1 });
			await seedMemory(dbPath, "repo-2", h2, "in web", { commitDateMs: 2 });

			// The short prefix "abcd1234" matches BOTH repos; detailRepo picks one.
			const toWeb = await withDashboardDb((db) => buildMemories(db, ALL, "abcd1234", undefined, "acme-web"), {
				dbPath,
			});
			expect(toWeb.selected?.commitHash).toBe(h2);

			// Without detailRepo the pick is deterministic (lowest repo_id), proving
			// the disambiguation is what steered it to acme-web above.
			const ambiguous = await withDashboardDb((db) => buildMemories(db, ALL, "abcd1234"), { dbPath });
			expect(ambiguous.selected?.commitHash).toBe(h1);
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

		it("renders the skills doc from the summary for kind 'skills'", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "a".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "feat: x", {
				skills: [
					{
						archivedKey: "claude:brainstorming-abcdefg",
						source: "claude",
						skill: "superpowers:brainstorming",
						entryPaths: [],
						invocationCount: 2,
						firstUsedAt: "t",
						lastUsedAt: "t",
					},
				],
			});
			const doc = await withDashboardDb((db) => readContextDoc(db, "repo-1", "skills", hash), { dbPath });
			expect(doc?.kind).toBe("skills");
			expect(doc?.title).toBe(`Skills used — ${hash.substring(0, 8)}`);
			expect(doc?.bodyMd).toContain("superpowers:brainstorming");
		});

		it("returns undefined for 'skills' on an unknown commit", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const doc = await withDashboardDb((db) => readContextDoc(db, "repo-1", "skills", "f".repeat(40)), {
				dbPath,
			});
			expect(doc).toBeUndefined();
		});

		it("returns undefined for 'skills' on a commit that used none", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			const hash = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", hash, "chore: y");
			const doc = await withDashboardDb((db) => readContextDoc(db, "repo-1", "skills", hash), { dbPath });
			expect(doc).toBeUndefined();
		});
	});

	/**
	 * The Conversation viewer's read — the browser counterpart to the editor's
	 * read-only ConversationDetailsPanel.
	 */
	describe("readConversationEntries", () => {
		const read = (source: string, sessionId: string, hash = "a".repeat(40), repo = "repo-1") =>
			withDashboardDb((db) => readConversationEntries(db, repo, hash, source, sessionId), { dbPath });

		it("returns the archived turns for one session", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: rate limit");
			await seedLinkedSession(dbPath, "repo-1", "a".repeat(40), {
				source: "claude",
				sessionId: "sess-a",
				title: "live title",
				archivedTitle: "Add the rate limiter",
				messageCount: 2,
				entries: [
					{ role: "human", content: "add a limiter" },
					{ role: "assistant", content: "done" },
				],
			});

			const doc = await read("claude", "sess-a");
			expect(doc?.title).toBe("Add the rate limiter");
			expect(doc?.source).toBe("claude");
			expect(doc?.messageCount).toBe(2);
			expect(doc?.truncated).toBe(false);
			expect(doc?.entries).toEqual([
				{ role: "human", content: "add a limiter" },
				{ role: "assistant", content: "done" },
			]);
		});

		it("falls back to the live sessions title, exactly as the row does", async () => {
			// The middle rung of the row's three-step precedence, and the only one the
			// dialog can get wrong on its own: an archive written before titles were
			// stored has none, so dropping this rung renamed the conversation the
			// moment it was opened — the tree said "live title", the dialog said
			// "add a limiter".
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: rate limit");
			await seedLinkedSession(dbPath, "repo-1", "a".repeat(40), {
				source: "claude",
				sessionId: "sess-a",
				title: "live title",
				// No archivedTitle: the pre-title archive this rung exists for.
				messageCount: 2,
				entries: [
					{ role: "human", content: "add a limiter" },
					{ role: "assistant", content: "done" },
				],
			});

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, "a".repeat(40)), { dbPath });
			const doc = await read("claude", "sess-a");
			expect(doc?.title).toBe("live title");
			// Asserted against the row rather than against the literal: what this
			// protects is the two agreeing, not either one's own wording.
			expect(doc?.title).toBe(detail?.conversations[0]?.title);
		});

		it("derives a title from the turns when neither the archive nor sessions has one", async () => {
			// The last rung, and the one that used to answer for the middle one too.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: rate limit");
			await seedLinkedSession(dbPath, "repo-1", "a".repeat(40), {
				source: "claude",
				sessionId: "sess-a",
				title: "live title",
				messageCount: 2,
				entries: [
					{ role: "human", content: "add a limiter" },
					{ role: "assistant", content: "done" },
				],
			});
			// A blank live title is not a title — the same `.trim()` gate the row uses,
			// which is why this falls through rather than showing an empty heading.
			await withDashboardDb((db) => db.prepare("UPDATE sessions SET title = '  '").run(), { dbPath });

			const detail = await withDashboardDb((db) => buildMemoryDetail(db, ALL, "a".repeat(40)), { dbPath });
			const doc = await read("claude", "sess-a");
			expect(doc?.title).toBe("add a limiter");
			expect(doc?.title).toBe(detail?.conversations[0]?.title);
		});

		it("reassembles a session sliced across an amend chain", async () => {
			// The case `groupArchivedSessions` exists for: one session filed once per
			// commit in the chain, which used to render as N separate conversations.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: rate limit");
			await seedLinkedSession(dbPath, "repo-1", "a".repeat(40), {
				source: "claude",
				sessionId: "sess-a",
				title: "t",
				messageCount: 3,
				extraSliceHashes: ["b".repeat(40), "c".repeat(40)],
			});

			const doc = await read("claude", "sess-a");
			// One conversation, not three — and the empty slices contribute nothing.
			expect(doc?.entries).toHaveLength(3);
			expect(doc?.messageCount).toBe(3);
		});

		it("caps a very long conversation and says so", async () => {
			// A deliberate divergence from the editor, which reads the same archive
			// in-process. A silent prefix would read as the whole conversation.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: long");
			await seedLinkedSession(dbPath, "repo-1", "a".repeat(40), {
				source: "claude",
				sessionId: "sess-long",
				title: "t",
				messageCount: 450,
				entries: Array.from({ length: 450 }, (_, i) => ({
					role: (i % 2 === 0 ? "human" : "assistant") as "human" | "assistant",
					content: `turn ${i}`,
				})),
			});

			const doc = await read("claude", "sess-long");
			expect(doc?.entries).toHaveLength(400);
			// The FULL count, so the viewer can say what it is not showing.
			expect(doc?.messageCount).toBe(450);
			expect(doc?.truncated).toBe(true);
			// Dropped turns are readable from the two counts; nothing was CUT, and
			// saying otherwise is what made the viewer describe the wrong cap.
			expect(doc?.clippedEntries).toBe(0);
		});

		it("clips one enormous turn and flags it, rather than serving it whole", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: big turn");
			await seedLinkedSession(dbPath, "repo-1", "a".repeat(40), {
				source: "claude",
				sessionId: "sess-big",
				title: "t",
				messageCount: 3,
				entries: [
					{ role: "assistant", content: "x".repeat(25_000) },
					{ role: "human", content: "short" },
					{ role: "assistant", content: "y".repeat(25_000) },
				],
			});

			const doc = await read("claude", "sess-big");
			expect(doc?.entries[0]?.content).toHaveLength(20_000);
			expect(doc?.truncated).toBe(true);
			// The count, not just the flag. This cap leaves no trace in
			// `messageCount` / `entries.length` — both say 3 — so without it the
			// viewer can only phrase the OTHER cap, and announces "the first 3 of 3
			// turns" while 10,000 characters go unmentioned.
			expect(doc?.clippedEntries).toBe(2);
			expect(doc?.messageCount).toBe(doc?.entries.length);
		});

		it("resolves a source-less archived session through the claude default", async () => {
			// `archivedSessionKey` defaults a source-less stored session to "claude",
			// and the row carries that same defaulted value — so what the client sends
			// back IS the key. Re-deriving it would be a second place to drift.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: old memory");
			await seedLinkedSession(dbPath, "repo-1", "a".repeat(40), {
				source: "claude",
				sessionId: "sess-old",
				title: "t",
				messageCount: 1,
			});
			await withDashboardDb(
				(db) => {
					// An archive written before the source was recorded.
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
						id: number;
					};
					const blob = deflateSync(
						// One real turn so the session survives the zero-turn drop; the
						// point of the test is the source-less → "claude" key resolution.
						Buffer.from(
							JSON.stringify({
								sessions: [
									{
										sessionId: "sess-old",
										entries: [{ role: "human", content: "hi", timestamp: "2026-08-19T10:00:00Z" }],
									},
								],
							}),
						),
					);
					db.prepare("UPDATE transcripts SET sessions_blob = ? WHERE repo_id = ?").run(blob, repoId);
				},
				{ dbPath },
			);

			expect((await read("claude", "sess-old"))?.sessionId).toBe("sess-old");
		});

		it("returns undefined for an unknown repo, memory or session rather than throwing", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", "a".repeat(40), "feat: rate limit");
			await seedLinkedSession(dbPath, "repo-1", "a".repeat(40), {
				source: "claude",
				sessionId: "sess-a",
				title: "t",
				messageCount: 1,
			});

			expect(await read("claude", "sess-a", "a".repeat(40), "repo-2")).toBeUndefined();
			expect(await read("claude", "sess-a", "d".repeat(40))).toBeUndefined();
			expect(await read("claude", "nope")).toBeUndefined();
			// The source is half the key: the right session under the wrong agent is
			// not a match.
			expect(await read("codex", "sess-a")).toBeUndefined();
		});
	});

	/**
	 * The dashboard's half of the three-state memory-detail copy (spec §9).
	 *
	 * The predicate itself is covered by `TranscriptRepair.test.ts` and is stubbed
	 * here: it reads the machine-global Claude owners ledger, so a real call would
	 * make these cases answer differently on every developer's machine. What is
	 * under test is the WIRING — that a state is produced at all, that it is
	 * produced for the right repository, and that it reaches the payload the
	 * client reads. Without a producer the page falls through to the plainest
	 * sentence forever, and nothing else fails to say so.
	 */
	describe("readMemoryTranscriptRepairState", () => {
		const HASH = "a".repeat(40);

		beforeEach(() => {
			vi.mocked(transcriptRepairState).mockReset();
			vi.mocked(transcriptRepairState).mockResolvedValue("repairable");
		});

		it("answers the predicate's state for the selected memory", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", HASH, "feat: thing");

			const state = await withDashboardDb((db) => readMemoryTranscriptRepairState(db, ALL, HASH), { dbPath });

			expect(state).toBe("repairable");
		});

		it("asks about the OWNING repo's worktree, not the server's own cwd", async () => {
			// The dashboard is machine-global: the process cwd names the wrong
			// repository for every row but one, and the predicate resolves the
			// Claude owner ledger against the root it is handed.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", HASH, "feat: thing");

			await withDashboardDb((db) => readMemoryTranscriptRepairState(db, ALL, HASH), { dbPath });

			expect(transcriptRepairState).toHaveBeenCalledWith(
				expect.objectContaining({ commitHash: HASH }),
				"/w/acme-api",
				// `siblingSummaries` and `storage` are both LAZY providers (the repo-wide
				// sibling query and the per-worktree storage build both run only for a real
				// candidate, not on every detail open); the mocked predicate never invokes
				// them, so assert their shape rather than resolved values. `storage` being
				// threaded is what stops the machine-global dashboard from reading a
				// sibling's transcripts through the wrong repo's active storage.
				expect.objectContaining({
					siblingSummaries: expect.any(Function),
					storage: expect.any(Function),
				}),
			);
		});

		it("hands over the folded TREE, so an amended memory's children count", async () => {
			// An amend/squash keeps its transcripts on the folded children, and the
			// bare `memories.summary_json` row has `children` emptied — reading it
			// alone would report a fully-captured consolidation as having none.
			await seedRepo(dbPath, "repo-1", "acme-api");
			const superseded = "b".repeat(40);
			await seedMemory(dbPath, "repo-1", HASH, "feat: thing");
			await seedMemory(dbPath, "repo-1", superseded, "feat: thing", { transcripts: ["t-1"] });
			await withDashboardDb(
				(db) => {
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
						id: number;
					};
					db.prepare(
						"UPDATE memories SET parent_hash = ?, child_pos = 0, root_hash = ?, depth = 1 WHERE repo_id = ? AND commit_hash = ?",
					).run(HASH, HASH, repoId, superseded);
					// `assembleSummary` fills `children` in place and never inserts the
					// key, so the stored root has to carry the emptied array the import
					// leaves behind — which is exactly what a real amended memory has.
					db.prepare("UPDATE memories SET summary_json = ? WHERE repo_id = ? AND commit_hash = ?").run(
						JSON.stringify({ commitHash: HASH, commitMessage: "feat: thing", children: [] }),
						repoId,
						HASH,
					);
				},
				{ dbPath },
			);

			await withDashboardDb((db) => readMemoryTranscriptRepairState(db, ALL, HASH), { dbPath });

			const summary = vi.mocked(transcriptRepairState).mock.calls[0]?.[0] as {
				children?: ReadonlyArray<{ commitHash: string }>;
			};
			expect(summary.children?.map((c) => c.commitHash)).toEqual([superseded]);
		});

		it("falls back to the page scope for a stale detail-repo token", async () => {
			// Same rule the detail pane itself follows: a token that resolves to no
			// repo (removed, or renamed since the page rendered) must not narrow the
			// lookup to a filter matching nothing — the hash still identifies the
			// memory. The two must agree, or the page would word one memory's
			// verdict onto another's conversations.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", HASH, "feat: thing");

			const state = await withDashboardDb(
				(db) => readMemoryTranscriptRepairState(db, ALL, HASH, "repo-that-was-removed"),
				{ dbPath },
			);

			expect(state).toBe("repairable");
		});

		it("answers undefined for an unknown hash without asking the predicate", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");

			const state = await withDashboardDb((db) => readMemoryTranscriptRepairState(db, ALL, HASH), { dbPath });

			expect(state).toBeUndefined();
			expect(transcriptRepairState).not.toHaveBeenCalled();
		});

		it("answers undefined with no hash at all", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");

			const state = await withDashboardDb((db) => readMemoryTranscriptRepairState(db, ALL, undefined), {
				dbPath,
			});

			expect(state).toBeUndefined();
		});

		it("answers undefined rather than throwing when the predicate fails", async () => {
			// A wording detail must never take the memory detail page down with it,
			// and undefined is the plainest sentence — not the optimistic one.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", HASH, "feat: thing");
			vi.mocked(transcriptRepairState).mockRejectedValue(new Error("owners ledger unreadable"));

			const state = await withDashboardDb((db) => readMemoryTranscriptRepairState(db, ALL, HASH), { dbPath });

			expect(state).toBeUndefined();
		});

		it("attaches the state to the detail buildMemories selects", async () => {
			// The end of the wire: `memories.js` reads exactly this field.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", HASH, "feat: thing");

			const model = await withDashboardDb(
				(db) => buildMemories(db, ALL, HASH, undefined, undefined, "repaired"),
				{ dbPath },
			);

			expect(model.selected?.transcriptRepairState).toBe("repaired");
		});

		it("omits the field entirely when no state was computed", async () => {
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", HASH, "feat: thing");

			const model = await withDashboardDb((db) => buildMemories(db, ALL, HASH), { dbPath });

			expect(model.selected).toBeDefined();
			expect(model.selected).not.toHaveProperty("transcriptRepairState");
		});

		it("resolves the lazy sibling-summaries and storage providers when the predicate actually asks for them", async () => {
			// The predicate normally short-circuits before touching either provider
			// (every other case in this suite proves that). Here it deliberately
			// calls both, so the repo-wide sibling replay and the per-worktree
			// storage build actually run at least once.
			await seedRepo(dbPath, "repo-1", "acme-api");
			await seedMemory(dbPath, "repo-1", HASH, "feat: thing");
			// A sibling with no memory_transcripts rows — an empty candidate the
			// dedup-floor replay must fold in.
			const sibling = "c".repeat(40);
			await seedMemory(dbPath, "repo-1", sibling, "feat: sibling");
			vi.mocked(transcriptRepairState).mockImplementation(async (_summary, _worktreeRoot, providers) => {
				const siblings = (await providers?.siblingSummaries?.()) ?? [];
				await providers?.storage?.().catch(() => undefined);
				return siblings.length > 0 ? "repairable" : "unrepairable";
			});

			const state = await withDashboardDb((db) => readMemoryTranscriptRepairState(db, ALL, HASH), { dbPath });

			expect(state).toBe("repairable");
		});
	});
});
