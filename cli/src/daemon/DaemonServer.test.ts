import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_PROTOCOL } from "./DaemonProtocol.js";
import { computeWatchTargets, runDaemonServer } from "./DaemonServer.js";

describe("computeWatchTargets", () => {
	it("returns the queue and orphan-ref targets rooted at cwd (main checkout)", () => {
		const targets = computeWatchTargets("/repo", { gitCommonDir: join("/repo", ".git") });
		expect(targets.map((t) => ({ kind: t.kind, path: t.path, ensureDir: t.ensureDir }))).toEqual([
			{
				kind: "queue",
				path: join("/repo", ".jolli", "jollimemory", "git-op-queue"),
				ensureDir: true,
			},
			{
				kind: "orphan-ref",
				// The orphan branch is `jollimemory/summaries/v3`, so we watch its
				// direct parent to catch update-ref writes with a non-recursive fs.watch.
				path: join("/repo", ".git", "refs", "heads", "jollimemory", "summaries"),
				ensureDir: false,
			},
		]);
	});

	it("uses the shared git common dir on a linked worktree", () => {
		// `<cwd>/.git` is a file in a linked worktree, and refs live under the main
		// repo's `.git`. Callers pass the pre-resolved common dir here.
		const targets = computeWatchTargets("/main/worktrees/feature", {
			gitCommonDir: "/main/.git",
		});
		expect(targets.find((t) => t.kind === "orphan-ref")?.path).toBe(
			join("/main/.git", "refs", "heads", "jollimemory", "summaries"),
		);
		// Queue lives in the worktree, not the shared gitdir.
		expect(targets.find((t) => t.kind === "queue")?.path).toBe(
			join("/main/worktrees/feature", ".jolli", "jollimemory", "git-op-queue"),
		);
	});
});

describe("runDaemonServer", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "daemon-server-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("emits the ready notification and resolves when stdin closes", async () => {
		const stdout = new PassThrough();
		const stdin = new PassThrough();
		const chunks: string[] = [];
		stdout.on("data", (buf) => chunks.push(String(buf)));

		const done = runDaemonServer({ cwd: root, stdin, stdout, debounceMs: 10 });

		// End stdin to trigger shutdown once ready has been written.
		stdin.end();
		await done;

		expect(chunks.length).toBeGreaterThan(0);
		const ready = JSON.parse(chunks[0].trim());
		expect(ready).toEqual({
			jsonrpc: "2.0",
			method: "ready",
			params: { protocol: DAEMON_PROTOCOL, pid: expect.any(Number) },
		});
	});
});
