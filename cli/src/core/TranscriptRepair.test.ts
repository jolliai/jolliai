import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../Types.js";
import { recordClaudeOwners } from "./ClaudeOwnership.js";
import { resolveStateRoot } from "./GitOps.js";
import { createFolderStorageAtRoot } from "./StorageFactory.js";
import { getSummary, setActiveStorage, storeSummary } from "./SummaryStore.js";
import { repairSummaryTranscripts, transcriptRepairState } from "./TranscriptRepair.js";

// Identity by default: these fixtures are plain temp dirs, not git worktrees,
// and the real resolveStateRoot falls back to its input unchanged in that case
// anyway (see GitOps.ts's non-repo fallback). A `vi.fn` wrapper so one test
// below can override it to return a value DISTINCT from the raw cwd — without
// that, every test here builds its ledger key via the same call the predicate
// makes, so a mutant that dropped `resolveStateRoot(cwd)` from
// TranscriptRepair.ts (calling `claudeSessionsOwnedBy(cwd, globalDir)`
// directly) would pass unnoticed. Same pattern as QueueWorker.test.ts /
// StopHook.test.ts / GeminiAfterAgentHook.test.ts.
//
// `getTreeHash` / `getDiffStats` are ALSO stubbed here (not just
// `resolveStateRoot`): `repairSummaryTranscripts` writes through the real
// `storeSummary`, whose index-flattening step calls both unconditionally.
// Left real, each would shell out to `git` against a plain temp dir (not a
// git repo) — a real subprocess spawn per test, which is exactly what would
// force this file into `SLOW_TEST_FILES`. Stubbing them to the same values
// the real calls degrade to on a non-repo cwd (`null` / all-zero stats) keeps
// this file in the fast tier without changing what any assertion observes.
vi.mock("./GitOps.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./GitOps.js")>()),
	resolveStateRoot: vi.fn((cwd: string) => cwd),
	getTreeHash: vi.fn().mockResolvedValue(null),
	getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 }),
}));

// `storeSummary` also acquires `orphan-write.lock` via `acquireOrphanWriteLock`,
// which (through `resolveSharedLockDir`) runs `git rev-parse --git-common-dir`
// to find the lock directory — another real subprocess spawn on a non-repo
// temp dir. Stubbed to always-succeed/no-op for the same fast-tier reason as
// above. `withClaudeOwnersLock` (used by `recordClaudeOwners`) is untouched —
// it is a plain file lock with no git dependency.
vi.mock("./Locks.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./Locks.js")>()),
	acquireOrphanWriteLock: vi.fn().mockResolvedValue(true),
	releaseOrphanWriteLock: vi.fn().mockResolvedValue(undefined),
}));

let globalDir: string;
let repo: string;
let transcript: string;

const HASH = "a".repeat(40);
const EDGE = { firstSeenAt: "2026-08-17T10:00:00.000Z", firstSeenLine: 0, lastSeenAt: "2026-08-17T10:00:00.000Z" };

function summary(over: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 5,
		commitHash: "a".repeat(40),
		commitMessage: "x",
		commitAuthor: "a",
		commitDate: "2026-08-17T11:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T11:00:05.000Z",
		topics: [],
		...over,
	};
}

beforeEach(async () => {
	globalDir = await mkdtemp(join(tmpdir(), "jolli-rep-g-"));
	repo = await mkdtemp(join(tmpdir(), "jolli-rep-r-"));
	transcript = join(globalDir, "s.jsonl");
	// A single real user turn, not just a bare `{cwd, timestamp}` line: the
	// `transcriptRepairState` tests above only check that this file EXISTS
	// (`existsSync`), but `repairSummaryTranscripts` below actually parses it
	// via `readTranscript` — a line with no `message` object yields zero
	// entries under `parseTranscriptLine`, which would make every repair test
	// misreport `no-entries-in-window`.
	await writeFile(
		transcript,
		`${JSON.stringify({
			cwd: repo,
			timestamp: "2026-08-17T10:00:00.000Z",
			message: { role: "user", content: "hello" },
		})}\n`,
		"utf-8",
	);
	// Storage seam (see TranscriptRepair.test.ts's task brief): a real
	// FolderStorage rooted at the temp repo dir, set as the process-global
	// override so `getSummary`/`storeSummary` inside `repairSummaryTranscripts`
	// read/write it without needing a real git worktree or the orphan branch.
	setActiveStorage(createFolderStorageAtRoot(repo));
	// Baseline: a v5 summary with an empty transcript slice, exactly the shape
	// `jolli doctor --repair-transcripts` would find. Individual tests seed
	// their OWN summary at a distinct hash when they need a different shape
	// (e.g. no upper bound, already-present, or no summary at all).
	await storeSummary(summary({ transcripts: [] }), repo);
});

afterEach(() => {
	setActiveStorage(undefined);
});

describe("transcriptRepairState", () => {
	it("is present when the summary already references a transcript", async () => {
		expect(await transcriptRepairState(summary({ transcripts: ["t1"] }), repo, globalDir)).toBe("present");
	});

	it("is repaired when the marker is set", async () => {
		expect(
			await transcriptRepairState(
				summary({ transcripts: ["t1"], transcriptsRepairedAt: "2026-08-17T12:00:00.000Z" }),
				repo,
				globalDir,
			),
		).toBe("repaired");
	});

	it("is repairable when an owner edge and the transcript both exist", async () => {
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[resolveStateRoot(repo), EDGE]]) },
			globalDir,
		);
		expect(await transcriptRepairState(summary({ transcripts: [] }), repo, globalDir)).toBe("repairable");
	});

	it("is unrepairable when no owner edge proves this checkout", async () => {
		expect(await transcriptRepairState(summary({ transcripts: [] }), repo, globalDir)).toBe("unrepairable");
	});

	it("is unrepairable when the transcript file is gone", async () => {
		await recordClaudeOwners(
			{
				sessionId: "s",
				transcriptPath: join(globalDir, "vanished.jsonl"),
				edges: new Map([[resolveStateRoot(repo), EDGE]]),
			},
			globalDir,
		);
		expect(await transcriptRepairState(summary({ transcripts: [] }), repo, globalDir)).toBe("unrepairable");
	});

	it("is unrepairable when the owner window holds no turns, despite the transcript existing", async () => {
		// The exact over-promise the fix removes: a transcript file EXISTS, so the
		// old `existsSync`-only predicate said "repairable" — but the owner joined
		// past the file's only turn, so a real run reports no-entries-in-window and
		// repairs nothing. The state query must agree with the engine.
		await recordClaudeOwners(
			{
				sessionId: "s",
				transcriptPath: transcript,
				edges: new Map([[resolveStateRoot(repo), { ...EDGE, firstSeenLine: 99 }]]),
			},
			globalDir,
		);
		expect(await transcriptRepairState(summary({ transcripts: [] }), repo, globalDir)).toBe("unrepairable");
	});

	it("is unrepairable when the summary carries no upper bound, despite owner and transcript", async () => {
		// Owner and a live transcript both present, but no generatedAt/commitDate to
		// bound the window — the engine refuses with no-upper-bound, so the UI must
		// not say "repairable".
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[resolveStateRoot(repo), EDGE]]) },
			globalDir,
		);
		const state = await transcriptRepairState(
			summary({ transcripts: [], generatedAt: "", commitDate: "" }),
			repo,
			globalDir,
		);
		expect(state).toBe("unrepairable");
	});

	it("looks the ledger up under resolveStateRoot's return value, not the raw cwd", async () => {
		const anchoredRoot = "/anchored/repo/root";
		vi.mocked(resolveStateRoot).mockReturnValueOnce(anchoredRoot);
		await recordClaudeOwners(
			{ sessionId: "anchored-1", transcriptPath: transcript, edges: new Map([[anchoredRoot, EDGE]]) },
			globalDir,
		);

		const state = await transcriptRepairState(summary({ transcripts: [] }), repo, globalDir);

		expect(resolveStateRoot).toHaveBeenCalledWith(repo);
		expect(state).toBe("repairable");
	});
});

describe("repairSummaryTranscripts", () => {
	it("repairs an empty summary when transcript, owner edge and upper bound all exist", async () => {
		// transcript holds one turn at 10:00; summary.generatedAt is 11:00:05.
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		const out = await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir });
		expect(out).toMatchObject({ repaired: true, reason: "repaired" });
		const stored = await getSummary(HASH, repo);
		expect(stored?.transcripts).toHaveLength(1);
		expect(stored?.transcriptsRepairedAt).toBeTruthy();
	});

	it("is idempotent — a second run reports already-present and writes nothing", async () => {
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir });
		const before = await getSummary(HASH, repo);
		const out = await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir });
		expect(out.reason).toBe("already-present");
		expect((await getSummary(HASH, repo))?.transcripts).toEqual(before?.transcripts);
	});

	it("refuses when the transcript file is gone", async () => {
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: join(globalDir, "gone.jsonl"), edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		expect((await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir })).reason).toBe(
			"transcript-missing",
		);
	});

	it("refuses when no owner edge proves this checkout", async () => {
		expect((await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir })).reason).toBe("no-owner-proof");
	});

	it("refuses when the bounded window yields no entries", async () => {
		// Owner edge seeded past every line in the file.
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, { ...EDGE, firstSeenLine: 99 }]]) },
			globalDir,
		);
		expect((await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir })).reason).toBe(
			"no-entries-in-window",
		);
	});

	it("skips a session whose transcript read throws, and still repairs from the others", async () => {
		// A directory passes the `existsSync` liveness filter but `readFile`
		// throws EISDIR on it — a genuine read fault distinct from the vanished-
		// file case above. Proves a broken owner is skipped (not left to crash
		// the whole repair) while a healthy owner's entries still land.
		await recordClaudeOwners(
			{ sessionId: "broken", transcriptPath: globalDir, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		await recordClaudeOwners(
			{ sessionId: "good", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		const out = await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir });
		expect(out).toMatchObject({ repaired: true, reason: "repaired", entries: 1 });
	});

	it("writes nothing when apply is false", async () => {
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		const out = await repairSummaryTranscripts(HASH, repo, { globalDir });
		expect(out.repaired).toBe(true);
		expect((await getSummary(HASH, repo))?.transcripts ?? []).toHaveLength(0);
	});

	it("stores a resolved session title alongside the repaired entries", async () => {
		// resolveArchivedTitle falls back to the first human turn's content
		// ("hello", from the beforeEach transcript) when there is no ai-title
		// row — proves the engine resolves and PERSISTS a title rather than
		// hand-building a StoredSession with the field left off entirely.
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir });
		const stored = await getSummary(HASH, repo);
		const id = stored?.transcripts?.[0];
		expect(id).toBeTruthy();
		const storage = createFolderStorageAtRoot(repo);
		const raw = await storage.readFile(`transcripts/${id}.json`);
		const data = JSON.parse(raw ?? "{}") as { sessions: ReadonlyArray<{ title?: string }> };
		expect(data.sessions[0]?.title).toBe("hello");
	});

	it("prefers generatedAt over commitDate as the upper bound", async () => {
		// commitDate is set BEFORE the transcript's one entry (10:00); generatedAt
		// is AFTER it (11:00:05, same as the default fixture). The entry sits
		// strictly between the two, so this is the one case that tells the two
		// possible orderings apart: `before = generatedAt || commitDate` (correct)
		// includes the entry, while the swapped `commitDate || generatedAt` cuts
		// the window off at 09:00 and silently drops it — reporting
		// "no-entries-in-window" instead of a successful repair. Asserting on
		// `entries: 1` (not just `repaired: true`) is what makes the two orders
		// actually disagree here.
		const boundHash = "e".repeat(40);
		await storeSummary(
			summary({ commitHash: boundHash, transcripts: [], commitDate: "2026-08-17T09:00:00.000Z" }),
			repo,
		);
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		const out = await repairSummaryTranscripts(boundHash, repo, { apply: true, globalDir });
		expect(out).toMatchObject({ reason: "repaired", entries: 1 });
	});

	it("refuses when the summary carries no capture timestamp to bound the window", async () => {
		// Falls back to `commitDate` only when `generatedAt` is absent; forcing
		// BOTH empty is the only way to reach "no-upper-bound" itself, rather
		// than exercising the (already-covered) generatedAt-preferred path. No
		// owner is recorded, so if the upper-bound check were ever skipped or
		// reordered after the owner check, this would report "no-owner-proof"
		// instead — which is exactly the mutant this test exists to catch.
		const noBoundHash = "b".repeat(40);
		await storeSummary(
			summary({ commitHash: noBoundHash, transcripts: [], generatedAt: "", commitDate: "" }),
			repo,
		);
		const out = await repairSummaryTranscripts(noBoundHash, repo, { apply: true, globalDir });
		expect(out.reason).toBe("no-upper-bound");
	});

	it("refuses when no summary exists for the commit at all", async () => {
		// Distinct from "no owner edge recorded" (both report "no-owner-proof",
		// but via different branches: this one never even reaches the owner
		// lookup because `getSummary` itself returns null).
		const missingHash = "c".repeat(40);
		const out = await repairSummaryTranscripts(missingHash, repo, { apply: true, globalDir });
		expect(out.reason).toBe("no-owner-proof");
	});

	it("is already-present when the summary already lists a transcript, with no repaired marker set", async () => {
		// Distinct from the idempotency test: that one proves a SECOND run of
		// THIS engine is a no-op via `transcriptsRepairedAt`. This one proves a
		// summary that was captured live (transcripts non-empty from the start,
		// never touched by repair) is also refused — the other half of the
		// `transcriptsRepairedAt !== undefined || getTranscriptIds(...).length > 0`
		// condition.
		const presentHash = "d".repeat(40);
		await storeSummary(summary({ commitHash: presentHash, transcripts: ["existing-id"] }), repo);
		const out = await repairSummaryTranscripts(presentHash, repo, { apply: true, globalDir });
		expect(out.reason).toBe("already-present");
	});
});
