import { describe, expect, it } from "vitest";
import type { CommitSummary, StoredTranscript } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { collectTranscriptSessionMeta } from "./TranscriptSessionMeta.js";

/**
 * Minimal StorageProvider that serves the given `transcripts/<id>.json` bodies
 * and nothing else, with NO `batchReadFiles` — exercises `readTranscriptsBatch`'s
 * per-path `readFile` fallback loop (the FolderStorage shape). `resolveStorage`
 * short-circuits on an injected provider, so no other method is reached — the
 * casts keep the fake to the surface actually exercised.
 */
function fakeStorage(files: Record<string, string>, opts?: { readonly throwOn?: string }): StorageProvider {
	return {
		readFile: async (path: string) => {
			if (opts?.throwOn === path) throw new Error("simulated read failure");
			return files[path] ?? null;
		},
	} as unknown as StorageProvider;
}

/**
 * Batch-capable fake — exercises `readTranscriptsBatch`'s `batchReadFiles`
 * branch (the OrphanBranchStorage/DualWriteStorage shape), which is the other
 * path live in production. Counts calls so a test can prove the read is ONE
 * round trip, not N.
 */
function fakeBatchStorage(
	files: Record<string, string>,
	opts?: { readonly throwAll?: boolean },
): StorageProvider & { readonly batchCalls: number[] } {
	const batchCalls: number[] = [];
	return {
		readFile: async (path: string) => files[path] ?? null,
		batchReadFiles: async (paths: ReadonlyArray<string>) => {
			batchCalls.push(paths.length);
			if (opts?.throwAll) throw new Error("simulated batch failure");
			const result = new Map<string, string | null>();
			for (const path of paths) result.set(path, files[path] ?? null);
			return result;
		},
		batchCalls,
	} as unknown as StorageProvider & { readonly batchCalls: number[] };
}

function transcriptJson(transcript: StoredTranscript): string {
	return JSON.stringify(transcript);
}

/** A v5 root: `transcripts` is authoritative, so no tree walk is needed. */
function rootWith(transcriptIds: ReadonlyArray<string>, children?: ReadonlyArray<CommitSummary>): CommitSummary {
	return {
		version: 5,
		commitHash: "a".repeat(40),
		commitMessage: "feat: something",
		commitAuthor: "Dev",
		commitDate: "2026-08-01T10:00:00.000Z",
		branch: "feature/x",
		generatedAt: "2026-08-01T10:05:00.000Z",
		transcripts: transcriptIds,
		...(children !== undefined && { children }),
	} as CommitSummary;
}

describe("collectTranscriptSessionMeta", () => {
	it("sums messageCount and spans min→max across a session's slices in two artifacts", async () => {
		// The amend shape: one session archived into a base artifact and a delta artifact.
		const storage = fakeStorage({
			"transcripts/base.json": transcriptJson({
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [
							{ role: "human", content: "a", timestamp: "2026-08-01T10:00:00.000Z" },
							{ role: "assistant", content: "b", timestamp: "2026-08-01T10:10:00.000Z" },
						],
					},
				],
			}),
			"transcripts/delta.json": transcriptJson({
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [{ role: "human", content: "c", timestamp: "2026-08-01T09:00:00.000Z" }],
					},
				],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["base", "delta"]), "/repo", storage);

		expect(rows).toEqual([
			{
				sessionId: "s1",
				source: "claude",
				messageCount: 3,
				startedAt: "2026-08-01T09:00:00.000Z",
				endedAt: "2026-08-01T10:10:00.000Z",
			},
		]);
	});

	it("keeps sessions with the same id but different sources apart", async () => {
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [
					{ sessionId: "dup", source: "claude", entries: [{ role: "human", content: "a" }] },
					{ sessionId: "dup", source: "codex", entries: [{ role: "human", content: "b" }] },
				],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.source).sort()).toEqual(["claude", "codex"]);
	});

	it("defaults a missing source to claude", async () => {
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [{ sessionId: "s1", entries: [{ role: "human", content: "a" }] }],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows[0]?.source).toBe("claude");
	});

	it("omits both bounds when no entry carries a parseable timestamp", async () => {
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [
							{ role: "human", content: "a" },
							{ role: "assistant", content: "b", timestamp: "not a date" },
						],
					},
				],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows[0]).toEqual({ sessionId: "s1", source: "claude", messageCount: 2 });
		expect(rows[0]).not.toHaveProperty("startedAt");
		expect(rows[0]).not.toHaveProperty("endedAt");
	});

	it("returns an empty array when no artifact resolves", async () => {
		const rows = await collectTranscriptSessionMeta(rootWith(["missing"]), "/repo", fakeStorage({}));

		expect(rows).toEqual([]);
	});

	it("skips an unreadable artifact and still emits the readable ones", async () => {
		const storage = fakeStorage(
			{
				"transcripts/good.json": transcriptJson({
					sessions: [{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "a" }] }],
				}),
			},
			{ throwOn: "transcripts/bad.json" },
		);

		const rows = await collectTranscriptSessionMeta(rootWith(["bad", "good"]), "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s1", source: "claude", messageCount: 1 }]);
	});

	it("skips a session with no sessionId rather than emitting a keyless row", async () => {
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [
					{ sessionId: "", source: "claude", entries: [{ role: "human", content: "a" }] },
					{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "b" }] },
				],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s1", source: "claude", messageCount: 1 }]);
	});

	it("counts a repeated artifact id once, so messageCount is not doubled", async () => {
		// The pre-v5 fallback path can yield the same id twice; the dedupe guard is
		// what keeps the total equal to the de-duplicated entry count.
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "a" }] }],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1", "t1"]), "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s1", source: "claude", messageCount: 1 }]);
	});

	it("gathers ids listed on children, not only the root's index", async () => {
		const storage = fakeStorage({
			"transcripts/child.json": transcriptJson({
				sessions: [{ sessionId: "s-child", source: "claude", entries: [{ role: "human", content: "a" }] }],
			}),
		});
		const child = rootWith(["child"]);
		// A root whose own index is empty while a child still lists an id — the shape
		// `resolveTranscriptIdsForUsage` exists to handle.
		const root = { ...rootWith([]), children: [child] } as CommitSummary;

		const rows = await collectTranscriptSessionMeta(root, "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s-child", source: "claude", messageCount: 1 }]);
	});

	it("tolerates a transcript whose session carries no entries array", async () => {
		// `readTranscript` casts JSON.parse output, so the type is a promise, not a guarantee.
		const storage = fakeStorage({ "transcripts/t1.json": '{"sessions":[{"sessionId":"s1"}]}' });

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s1", source: "claude", messageCount: 0 }]);
	});

	it("reads every referenced artifact in a single batchReadFiles call, not one per artifact", async () => {
		// The perf fix this guards: a squash root can reference many artifacts, and
		// serial per-artifact `git show` subprocesses eat the pre-push hook's
		// budget. `readTranscriptsBatch` must fold them into one round trip.
		const storage = fakeBatchStorage({
			"transcripts/base.json": transcriptJson({
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [{ role: "human", content: "a", timestamp: "2026-08-01T10:00:00.000Z" }],
					},
				],
			}),
			"transcripts/delta.json": transcriptJson({
				sessions: [{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "b" }] }],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["base", "delta"]), "/repo", storage);

		expect(storage.batchCalls).toEqual([2]);
		expect(rows).toEqual([
			{
				sessionId: "s1",
				source: "claude",
				messageCount: 2,
				startedAt: "2026-08-01T10:00:00.000Z",
				endedAt: "2026-08-01T10:00:00.000Z",
			},
		]);
	});

	it("degrades to an empty array (not a throw) when the whole batch read fails", async () => {
		// A detached/pruned repo state, or the `git cat-file --batch` subprocess
		// itself erroring, must not block the push — same non-fatal contract as a
		// single unreadable artifact, just at the batch level.
		const storage = fakeBatchStorage({}, { throwAll: true });

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows).toEqual([]);
	});
});
