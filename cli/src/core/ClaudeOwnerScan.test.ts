import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveWorktreeRootOrNull } from "./GitOps.js";

vi.mock("./GitOps.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./GitOps.js")>()),
	// `defaultResolveRoot` resolves through the null-returning variant so a
	// non-git cwd never becomes an owner root. Identity here so the temp-dir
	// fixtures below (not real git worktrees) resolve to themselves.
	resolveWorktreeRootOrNull: vi.fn((cwd: string) => cwd),
}));

import { scanOwnerEdges, scanOwnersWithCursor } from "./ClaudeOwnerScan.js";
import { loadClaudeOwners } from "./ClaudeOwnership.js";
import { loadExtractorCursorLine, saveExtractorCursor } from "./SessionTracker.js";

/** One transcript line carrying a cwd and a timestamp. */
function line(cwd: string, ts: string): string {
	return JSON.stringify({ cwd, timestamp: ts, message: { role: "user", content: "hi" } });
}

// Identity roots: each cwd's first path segment pair is its "worktree root".
const roots = (cwd: string): string | null => (cwd.startsWith("/repo/") ? `/repo/${cwd.split("/")[2]}` : null);

describe("scanOwnerEdges", () => {
	it("records one edge per distinct worktree root", () => {
		const lines = [
			line("/repo/a", "2026-08-17T10:00:00.000Z"),
			line("/repo/b/sub", "2026-08-17T10:01:00.000Z"),
			line("/repo/a/deep", "2026-08-17T10:02:00.000Z"),
		];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect([...edges.keys()].sort()).toEqual(["/repo/a", "/repo/b"]);
		expect(edges.get("/repo/a")?.firstSeenLine).toBe(0);
		expect(edges.get("/repo/b")?.firstSeenLine).toBe(1);
	});

	it("keeps the FIRST line of a root and the LAST timestamp/cwd", () => {
		const lines = [line("/repo/a", "2026-08-17T10:00:00.000Z"), line("/repo/a/sub", "2026-08-17T10:09:00.000Z")];
		const edge = scanOwnerEdges(lines, 0, roots).edges.get("/repo/a");
		expect(edge?.firstSeenLine).toBe(0);
		expect(edge?.firstSeenAt).toBe("2026-08-17T10:00:00.000Z");
		expect(edge?.firstSeenCwd).toBe("/repo/a");
		expect(edge?.lastSeenAt).toBe("2026-08-17T10:09:00.000Z");
		expect(edge?.lastSeenCwd).toBe("/repo/a/sub");
	});

	it("numbers lines against the WHOLE file, not the scanned window", () => {
		const lines = [
			line("/repo/a", "2026-08-17T10:00:00.000Z"),
			line("/repo/a", "2026-08-17T10:01:00.000Z"),
			line("/repo/b", "2026-08-17T10:02:00.000Z"),
		];
		const { edges, lastLine } = scanOwnerEdges(lines, 2, roots);
		expect([...edges.keys()]).toEqual(["/repo/b"]);
		expect(edges.get("/repo/b")?.firstSeenLine).toBe(2);
		expect(lastLine).toBe(3);
	});

	it("returns the line count as lastLine so the caller can advance its mark", () => {
		expect(scanOwnerEdges([line("/repo/a", "2026-08-17T10:00:00.000Z")], 0, roots).lastLine).toBe(1);
	});

	it("skips lines with no cwd, an empty cwd, or unparseable JSON", () => {
		const lines = [
			"not json",
			"{ this looks like json but is not",
			JSON.stringify({ timestamp: "2026-08-17T10:00:00.000Z" }),
			JSON.stringify({ cwd: "", timestamp: "2026-08-17T10:00:00.000Z" }),
			line("/repo/a", "2026-08-17T10:03:00.000Z"),
		];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect([...edges.keys()]).toEqual(["/repo/a"]);
		expect(edges.get("/repo/a")?.firstSeenLine).toBe(4);
	});

	it("skips a cwd that resolves to no worktree root", () => {
		const { edges } = scanOwnerEdges([line("/tmp/scratch", "2026-08-17T10:00:00.000Z")], 0, roots);
		expect(edges.size).toBe(0);
	});

	it("falls back to a caller-supplied instant when a line carries no timestamp", () => {
		const lines = [JSON.stringify({ cwd: "/repo/a" })];
		const edge = scanOwnerEdges(lines, 0, roots, () => "2026-08-17T12:00:00.000Z").edges.get("/repo/a");
		expect(edge?.firstSeenAt).toBe("2026-08-17T12:00:00.000Z");
	});

	it("falls back to the default clock when neither a timestamp nor a `now` override is given", () => {
		const lines = [JSON.stringify({ cwd: "/repo/a" })];
		const edge = scanOwnerEdges(lines, 0, roots).edges.get("/repo/a");
		// Real wall-clock ISO string — assert shape, not an exact value.
		expect(edge?.firstSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("reuses a cached root resolution for a repeated cwd", () => {
		const resolveRootSpy = vi.fn(roots);
		const lines = [line("/repo/a", "2026-08-17T10:00:00.000Z"), line("/repo/a", "2026-08-17T10:01:00.000Z")];
		scanOwnerEdges(lines, 0, resolveRootSpy);
		expect(resolveRootSpy).toHaveBeenCalledTimes(1);
	});

	it("returns no edges for an empty window", () => {
		const { edges, lastLine } = scanOwnerEdges([], 0, roots);
		expect(edges.size).toBe(0);
		expect(lastLine).toBe(0);
	});

	// The brief's tests above all supply `roots` explicitly, so none of them ever
	// exercise `defaultResolveRoot` — the parameter's own default value. These
	// three cover it directly, including the catch path no other test reaches.
	describe("default resolver (no resolveRoot argument supplied)", () => {
		it("uses resolveWorktreeRootOrNull when the caller supplies no resolver", () => {
			vi.mocked(resolveWorktreeRootOrNull).mockReturnValueOnce("/mocked/root");
			const { edges } = scanOwnerEdges([line("/whatever", "2026-08-17T10:00:00.000Z")], 0);
			expect([...edges.keys()]).toEqual(["/mocked/root"]);
		});

		it("treats a null resolved root (non-git cwd) as no owner", () => {
			vi.mocked(resolveWorktreeRootOrNull).mockReturnValueOnce(null);
			const { edges } = scanOwnerEdges([line("/whatever", "2026-08-17T10:00:00.000Z")], 0);
			expect(edges.size).toBe(0);
		});

		it("swallows a throwing resolver and treats the line as ownerless", () => {
			vi.mocked(resolveWorktreeRootOrNull).mockImplementationOnce(() => {
				throw new Error("boom");
			});
			const { edges } = scanOwnerEdges([line("/whatever", "2026-08-17T10:00:00.000Z")], 0);
			expect(edges.size).toBe(0);
		});
	});
});

describe("scanOwnersWithCursor", () => {
	it("records edges and advances only the owners mark", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-owners-g-"));
		const repo = await mkdtemp(join(tmpdir(), "jolli-owners-r-"));
		const transcript = join(global, "s1.jsonl");
		await writeFile(
			transcript,
			`${JSON.stringify({ cwd: repo, timestamp: "2026-08-17T10:00:00.000Z" })}\n`,
			"utf-8",
		);

		await scanOwnersWithCursor(transcript, "s1", repo, global);

		const ledger = await loadClaudeOwners(global);
		expect(Object.keys(ledger.sessions)).toEqual(["claude:s1"]);
		expect(await loadExtractorCursorLine(transcript, "owners", repo)).toBe(1);
		expect(await loadExtractorCursorLine(transcript, "plans", repo)).toBe(0);
	});

	it("re-scans nothing once the mark has passed the file", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-owners-g2-"));
		const repo = await mkdtemp(join(tmpdir(), "jolli-owners-r2-"));
		const transcript = join(global, "s2.jsonl");
		await writeFile(
			transcript,
			`${JSON.stringify({ cwd: repo, timestamp: "2026-08-17T10:00:00.000Z" })}\n`,
			"utf-8",
		);
		await saveExtractorCursor(transcript, "owners", 1, repo);

		await scanOwnersWithCursor(transcript, "s2", repo, global);

		expect(await loadClaudeOwners(global)).toEqual({ version: 1, sessions: {} });
	});

	it("never throws when the transcript is missing", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-owners-g3-"));
		const repo = await mkdtemp(join(tmpdir(), "jolli-owners-r3-"));
		await expect(scanOwnersWithCursor(join(repo, "gone.jsonl"), "s3", repo, global)).resolves.toBeUndefined();
	});

	it("does NOT advance the owners mark when the ledger write was not durable", async () => {
		// A best-effort (unlocked) write can be clobbered by a concurrent peer, so
		// advancing past these lines would strand the dropped edge forever. The
		// injected recorder reports `false` (undurable); the cursor must stay at 0
		// so the next Stop hook re-scans and re-emits.
		const global = await mkdtemp(join(tmpdir(), "jolli-owners-g4-"));
		const repo = await mkdtemp(join(tmpdir(), "jolli-owners-r4-"));
		const transcript = join(global, "s4.jsonl");
		await writeFile(
			transcript,
			`${JSON.stringify({ cwd: repo, timestamp: "2026-08-17T10:00:00.000Z" })}\n`,
			"utf-8",
		);

		const undurable = vi.fn(async () => false);
		await scanOwnersWithCursor(transcript, "s4", repo, global, undurable);

		expect(undurable).toHaveBeenCalledOnce();
		expect(await loadExtractorCursorLine(transcript, "owners", repo)).toBe(0);
	});
});
