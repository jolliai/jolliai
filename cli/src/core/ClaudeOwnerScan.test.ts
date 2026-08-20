import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

import {
	backfillExecutingSessionOwnership,
	resolveClaudeTranscriptPath,
	scanOwnerEdges,
	scanOwnersWithCursor,
} from "./ClaudeOwnerScan.js";
import { claudeSessionsOwnedBy, loadClaudeOwners } from "./ClaudeOwnership.js";
import { loadExtractorCursorLine, saveExtractorCursor } from "./SessionTracker.js";

/** One transcript line carrying a cwd and a timestamp. */
function line(cwd: string, ts: string): string {
	return JSON.stringify({ cwd, timestamp: ts, message: { role: "user", content: "hi" } });
}

/** An assistant tool_use line: one `tool` call whose `input[key]` names a file. */
function toolLine(cwd: string, ts: string, tool: string, key: string, path: string): string {
	return JSON.stringify({
		cwd,
		timestamp: ts,
		message: { role: "assistant", content: [{ type: "tool_use", name: tool, input: { [key]: path } }] },
	});
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

	it("skips a RELATIVE cwd without even resolving it (it would anchor against the reader's own cwd)", () => {
		const always = vi.fn(() => "/root");
		const { edges } = scanOwnerEdges(
			[line(".", "2026-08-17T10:00:00.000Z"), line("/abs", "2026-08-17T10:01:00.000Z")],
			0,
			always,
		);
		expect(always).not.toHaveBeenCalledWith(".");
		expect([...edges.keys()]).toEqual(["/root"]);
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

describe("scanOwnerEdges — edited-file ownership", () => {
	it("records an edge for the worktree root of a file the session EDITED, on top of the cwd edge", () => {
		const lines = [toolLine("/repo/a", "2026-08-17T10:00:00.000Z", "Edit", "file_path", "/repo/b/src/x.ts")];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect([...edges.keys()].sort()).toEqual(["/repo/a", "/repo/b"]);
		expect(edges.get("/repo/b")?.firstSeenLine).toBe(0);
	});

	it("recognizes Write, MultiEdit, and NotebookEdit as authoring a file", () => {
		const cases: Array<[string, string, string]> = [
			["Write", "file_path", "/repo/b/w.ts"],
			["MultiEdit", "file_path", "/repo/b/m.ts"],
			["NotebookEdit", "notebook_path", "/repo/b/n.ipynb"],
		];
		for (const [tool, key, path] of cases) {
			const { edges } = scanOwnerEdges(
				[toolLine("/repo/a", "2026-08-17T10:00:00.000Z", tool, key, path)],
				0,
				roots,
			);
			expect(edges.has("/repo/b")).toBe(true);
		}
	});

	it("does NOT create an edge for a file that was only READ (read-only tools author nothing)", () => {
		for (const tool of ["Read", "Grep", "Glob", "Bash"]) {
			const { edges } = scanOwnerEdges(
				[toolLine("/repo/a", "2026-08-17T10:00:00.000Z", tool, "file_path", "/repo/b/x.ts")],
				0,
				roots,
			);
			expect([...edges.keys()]).toEqual(["/repo/a"]);
		}
	});

	it("resolves a relative edited path against the line cwd", () => {
		// join("/repo/a/sub", "../../b/x.ts") === "/repo/b/x.ts" → dirname "/repo/b"
		const lines = [toolLine("/repo/a/sub", "2026-08-17T10:00:00.000Z", "Edit", "file_path", "../../b/x.ts")];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect(edges.has("/repo/b")).toBe(true);
	});

	it("merges an edited-file edge into the cwd edge when they share a root", () => {
		const lines = [toolLine("/repo/a", "2026-08-17T10:00:00.000Z", "Edit", "file_path", "/repo/a/x.ts")];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect([...edges.keys()]).toEqual(["/repo/a"]);
		expect(edges.get("/repo/a")?.firstSeenLine).toBe(0);
	});

	it("stamps the EDITING line as firstSeenLine for the edited root", () => {
		const lines = [
			line("/repo/a", "2026-08-17T10:00:00.000Z"),
			toolLine("/repo/a", "2026-08-17T10:01:00.000Z", "Edit", "file_path", "/repo/b/x.ts"),
		];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect(edges.get("/repo/a")?.firstSeenLine).toBe(0);
		expect(edges.get("/repo/b")?.firstSeenLine).toBe(1);
	});

	it("ignores an edited path whose directory resolves to no worktree root", () => {
		const lines = [toolLine("/repo/a", "2026-08-17T10:00:00.000Z", "Edit", "file_path", "/tmp/scratch/x.ts")];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect([...edges.keys()]).toEqual(["/repo/a"]);
	});

	it("tolerates malformed content blocks and non-string paths without a spurious edge", () => {
		// content is an array of junk: a null block, a text block, a tool_use with no
		// name, an Edit with no input, and an Edit whose file_path is not a string.
		const lines = [
			JSON.stringify({
				cwd: "/repo/a",
				timestamp: "2026-08-17T10:00:00.000Z",
				message: {
					role: "assistant",
					content: [
						null,
						{ type: "text", text: "thinking" },
						{ type: "tool_use", input: { file_path: "/repo/b/x.ts" } },
						{ type: "tool_use", name: "Edit" },
						{ type: "tool_use", name: "Edit", input: { file_path: 42 } },
					],
				},
			}),
		];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect([...edges.keys()]).toEqual(["/repo/a"]);
	});
});

describe("resolveClaudeTranscriptPath", () => {
	it("finds <projectsDir>/<any>/<sessionId>.jsonl", async () => {
		const projects = await mkdtemp(join(tmpdir(), "jolli-proj-"));
		const proj = join(projects, "-Users-me-repo");
		await mkdir(proj);
		const transcript = join(proj, "sid-1.jsonl");
		await writeFile(transcript, "", "utf-8");
		expect(await resolveClaudeTranscriptPath("sid-1", projects)).toBe(transcript);
	});

	it("returns null when no project directory holds the session", async () => {
		const projects = await mkdtemp(join(tmpdir(), "jolli-proj2-"));
		await mkdir(join(projects, "-Users-me-repo"));
		expect(await resolveClaudeTranscriptPath("missing", projects)).toBeNull();
	});

	it("returns null when the projects directory does not exist", async () => {
		expect(await resolveClaudeTranscriptPath("sid", join(tmpdir(), "jolli-no-such-dir-xyz"))).toBeNull();
	});

	it("rejects an unsafe (traversal) session id before it can become a path segment", async () => {
		const projects = await mkdtemp(join(tmpdir(), "jolli-proj3-"));
		const proj = join(projects, "-Users-me-repo");
		await mkdir(proj);
		// A traversal id would escape `projects`; must be refused outright.
		expect(await resolveClaudeTranscriptPath("../../../etc/hosts", projects)).toBeNull();
	});

	it("returns null when the candidate exists but is not a regular file", async () => {
		const projects = await mkdtemp(join(tmpdir(), "jolli-proj4-"));
		const proj = join(projects, "-Users-me-repo");
		await mkdir(proj);
		// A directory (or fifo) named like the transcript must not be accepted and read.
		await mkdir(join(proj, "sid-dir.jsonl"));
		expect(await resolveClaudeTranscriptPath("sid-dir", projects)).toBeNull();
	});
});

describe("backfillExecutingSessionOwnership", () => {
	const NOW = "2026-08-17T10:00:00.000Z";
	/** An assistant Edit line: cwd=`cwd`, editing the absolute path `file`. */
	const editLine = (cwd: string, file: string) =>
		JSON.stringify({
			cwd,
			timestamp: NOW,
			message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: file } }] },
		});

	it("records an owner edge for a worktree the executing session EDITED but never cd'd into", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-exec-g-"));
		const worktreeB = await mkdtemp(join(tmpdir(), "jolli-exec-b-"));
		const transcript = join(global, "exec.jsonl");
		// Session sat in /elsewhere/A the whole time, but authored a file under B.
		await writeFile(transcript, `${editLine("/elsewhere/A", join(worktreeB, "x.ts"))}\n`, "utf-8");

		await backfillExecutingSessionOwnership("exec-1", worktreeB, global, async () => transcript);

		const owned = await claudeSessionsOwnedBy(worktreeB, global);
		expect(owned.map((o) => o.sessionId)).toEqual(["exec-1"]);
	});

	it("records NOTHING for B when the session neither entered nor authored under B", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-exec-g2-"));
		const worktreeB = await mkdtemp(join(tmpdir(), "jolli-exec-b2-"));
		const transcript = join(global, "exec2.jsonl");
		// cwd and edit are both under /elsewhere/A — no evidence for B.
		await writeFile(transcript, `${editLine("/elsewhere/A", "/elsewhere/A/x.ts")}\n`, "utf-8");

		await backfillExecutingSessionOwnership("exec-2", worktreeB, global, async () => transcript);

		expect(await claudeSessionsOwnedBy(worktreeB, global)).toEqual([]);
	});

	it("is a no-op when the executing session's transcript cannot be located", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-exec-g3-"));
		const worktreeB = await mkdtemp(join(tmpdir(), "jolli-exec-b3-"));
		await backfillExecutingSessionOwnership("gone", worktreeB, global, async () => null);
		expect(await loadClaudeOwners(global)).toEqual({ version: 1, sessions: {} });
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
