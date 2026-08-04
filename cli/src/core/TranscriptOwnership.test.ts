import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../Types.js";
import { CURRENT_SCHEMA_VERSION } from "../Types.js";
import { resolveTranscriptOwnership } from "./TranscriptOwnership.js";

const node = (over: Partial<CommitSummary> = {}): CommitSummary => ({
	version: CURRENT_SCHEMA_VERSION,
	commitHash: "a".repeat(40),
	commitMessage: "test commit",
	commitAuthor: "Tester",
	commitDate: "2026-07-29T00:00:00.000Z",
	branch: "feature/x",
	generatedAt: "2026-07-29T00:00:01.000Z",
	topics: [],
	...over,
});

describe("resolveTranscriptOwnership", () => {
	it("attributes an id to the deepest node that lists it, not the root index", () => {
		const child = node({ commitHash: "c".repeat(40), transcripts: ["t1"] });
		const root = node({ transcripts: ["t1", "t2"], children: [child] });

		const { ownerById, unresolved } = resolveTranscriptOwnership(root, new Set(["t1"]));

		expect(ownerById.get("t1")).toBe(child);
		expect(unresolved).toEqual([]);
	});

	it("attributes an id only the root lists to the root", () => {
		const child = node({ commitHash: "c".repeat(40), transcripts: ["t1"] });
		const root = node({ transcripts: ["t1", "t2"], children: [child] });

		const { ownerById } = resolveTranscriptOwnership(root, new Set(["t2"]));

		expect(ownerById.get("t2")).toBe(root);
	});

	it("ignores ids outside the requested set", () => {
		const root = node({ transcripts: ["t1", "t2"] });

		const { ownerById, unresolved } = resolveTranscriptOwnership(root, new Set(["t1"]));

		expect([...ownerById.keys()]).toEqual(["t1"]);
		expect(unresolved).toEqual([]);
	});

	it("resolves nothing, and walks nothing, for an empty id set", () => {
		const root = node({ transcripts: ["t1"], children: [node({ commitHash: "c".repeat(40) })] });

		const { ownerById, unresolved } = resolveTranscriptOwnership(root, new Set());

		expect(ownerById.size).toBe(0);
		expect(unresolved).toEqual([]);
	});

	it("reports an id nothing claims and no commit hash matches as unresolved", () => {
		const root = node({ transcripts: ["t1"] });

		const { ownerById, unresolved } = resolveTranscriptOwnership(root, new Set(["gone"]));

		expect(ownerById.has("gone")).toBe(false);
		expect(unresolved).toEqual(["gone"]);
	});

	it("reports sibling claimants as unresolved rather than picking one", () => {
		const left = node({ commitHash: "1".repeat(40), transcripts: ["t1"] });
		const right = node({ commitHash: "2".repeat(40), transcripts: ["t1"] });
		const root = node({ transcripts: ["t1"], children: [left, right] });

		const { ownerById, unresolved } = resolveTranscriptOwnership(root, new Set(["t1"]));

		expect(ownerById.has("t1")).toBe(false);
		expect(unresolved).toEqual(["t1"]);
	});

	it("attributes a v5-migrated id to the descendant whose commitHash matches it", () => {
		// SchemaV5Migration.upgradeOneSummary lists every descendant commit hash on the
		// ROOT and leaves the children without a `transcripts` field, so the root is the
		// sole claimant of ids whose sessions a child's own token fields cover.
		const childHash = "c".repeat(40);
		const child = node({ commitHash: childHash });
		const root = node({ transcripts: [childHash], children: [child] });

		const { ownerById, unresolved } = resolveTranscriptOwnership(root, new Set([childHash]));

		expect(ownerById.get(childHash)).toBe(child);
		expect(unresolved).toEqual([]);
	});

	it("prefers the claiming node itself when it is also the commitHash match", () => {
		const rootHash = "a".repeat(40);
		const child = node({ commitHash: "c".repeat(40) });
		const root = node({ commitHash: rootHash, transcripts: [rootHash], children: [child] });

		const { ownerById } = resolveTranscriptOwnership(root, new Set([rootHash]));

		expect(ownerById.get(rootHash)).toBe(root);
	});

	it("keeps the claiming node when the commitHash match sits outside its subtree", () => {
		// The claim is the stronger evidence: a stale id that happens to equal an
		// unrelated node's commit hash must not hand that node someone else's sessions.
		const otherHash = "b".repeat(40);
		const other = node({ commitHash: otherHash });
		const claimant = node({ commitHash: "c".repeat(40), transcripts: [otherHash] });
		const root = node({ transcripts: [otherHash], children: [other, claimant] });

		const { ownerById } = resolveTranscriptOwnership(root, new Set([otherHash]));

		expect(ownerById.get(otherHash)).toBe(claimant);
	});

	it("falls back to a unique commitHash match on a pre-v5 tree that lists nothing", () => {
		// Legacy v3/v4 data has no `transcripts` field anywhere; transcript files are
		// named after each commit's own hash, so the hash IS the ownership record.
		const childHash = "c".repeat(40);
		const child = node({ commitHash: childHash });
		const root = node({ children: [child] });

		const { ownerById, unresolved } = resolveTranscriptOwnership(root, new Set([childHash]));

		expect(ownerById.get(childHash)).toBe(child);
		expect(unresolved).toEqual([]);
	});
});
