import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSyncHidden } from "../util/Subprocess.js";
import { DAEMON_PROTOCOL } from "./DaemonProtocol.js";
import { computeWatchTargets, runDaemonServer } from "./DaemonServer.js";

// Mock the git subprocess helper so we can control `git rev-parse --git-common-dir`
// output per-test. The default implementation delegates to the real function so
// unrelated callers (if any) keep working.
vi.mock("../util/Subprocess.js", async () => {
	const actual = await vi.importActual<typeof import("../util/Subprocess.js")>("../util/Subprocess.js");
	return { ...actual, execFileSyncHidden: vi.fn(actual.execFileSyncHidden) };
});

const mockExec = vi.mocked(execFileSyncHidden);

describe("computeWatchTargets", () => {
	beforeEach(() => {
		mockExec.mockReset();
	});

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

	it("resolves git-common-dir via subprocess when no override is provided (absolute path is used verbatim)", () => {
		mockExec.mockReturnValueOnce("/main/.git\n");
		const targets = computeWatchTargets("/main/worktrees/feature");
		expect(targets.find((t) => t.kind === "orphan-ref")?.path).toBe(
			join("/main/.git", "refs", "heads", "jollimemory", "summaries"),
		);
	});

	it("resolves git-common-dir via subprocess and joins a relative path against cwd", () => {
		mockExec.mockReturnValueOnce(".git\n");
		const targets = computeWatchTargets("/repo");
		expect(targets.find((t) => t.kind === "orphan-ref")?.path).toBe(
			join("/repo", ".git", "refs", "heads", "jollimemory", "summaries"),
		);
	});

	it("falls back to <cwd>/.git when git returns an empty line", () => {
		mockExec.mockReturnValueOnce("   \n");
		const targets = computeWatchTargets("/repo");
		expect(targets.find((t) => t.kind === "orphan-ref")?.path).toBe(
			join("/repo", ".git", "refs", "heads", "jollimemory", "summaries"),
		);
	});

	it("falls back to <cwd>/.git when git is not on PATH / cwd is not a repo", () => {
		mockExec.mockImplementationOnce(() => {
			throw new Error("git not found");
		});
		const targets = computeWatchTargets("/repo");
		expect(targets.find((t) => t.kind === "orphan-ref")?.path).toBe(
			join("/repo", ".git", "refs", "heads", "jollimemory", "summaries"),
		);
	});
});

describe("runDaemonServer", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "daemon-server-"));
		mockExec.mockReset();
		// Default to "not a git repo" so tests don't depend on the host's git.
		mockExec.mockImplementation(() => {
			throw new Error("mock: not a repo");
		});
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

	it("emits a refresh notification for the queue kind after a debounced burst", async () => {
		const stdout = new PassThrough();
		const stdin = new PassThrough();
		const chunks: string[] = [];
		stdout.on("data", (buf) => chunks.push(String(buf)));

		const done = runDaemonServer({ cwd: root, stdin, stdout, debounceMs: 50 });

		// The queue dir is ensureDir=true, so it exists right after start(). Give
		// fs.watch a beat to arm on all platforms before writing.
		await sleep(150);

		const queueDir = join(root, ".jolli", "jollimemory", "git-op-queue");
		writeFileSync(join(queueDir, "op-1.json"), "{}");
		writeFileSync(join(queueDir, "op-2.json"), "{}");

		await vi.waitFor(
			() => {
				const refresh = chunks
					.join("")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
					.find((m) => m.method === "refresh");
				expect(refresh).toBeTruthy();
				expect(refresh).toEqual({
					jsonrpc: "2.0",
					method: "refresh",
					params: { kind: "queue", cwd: root },
				});
			},
			{ timeout: 10_000, interval: 20 },
		);

		stdin.end();
		await done;
	});

	it("keeps polling silently while the retry target remains absent", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const stdout = new PassThrough();
			const stdin = new PassThrough();
			const done = runDaemonServer({ cwd: root, stdin, stdout, debounceMs: 10 });

			// Target still doesn't exist — advance a couple of intervals so the
			// retry callback runs, hits the `watcher.start() === false` path, and
			// leaves the timer armed.
			vi.advanceTimersByTime(5_000);
			vi.advanceTimersByTime(5_000);

			stdin.end();
			await done;
		} finally {
			vi.useRealTimers();
		}
	});

	it("polls to arm a watcher whose target is initially absent, then cleans the retry list once armed", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const stdout = new PassThrough();
			const stdin = new PassThrough();
			const done = runDaemonServer({ cwd: root, stdin, stdout, debounceMs: 10 });

			// The orphan-ref target (`.git/refs/heads/jollimemory/summaries`) doesn't
			// exist at startup, so a retry interval was armed. Create the dir now and
			// advance the fake interval so the retry callback runs and succeeds.
			mkdirSync(join(root, ".git", "refs", "heads", "jollimemory", "summaries"), {
				recursive: true,
			});
			// One retry tick is enough — the next start() will succeed and the
			// retry cleanup branch (clearInterval + splice from armRetries) runs.
			vi.advanceTimersByTime(5_000);

			stdin.end();
			await done;
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses process.stdin / process.stdout and the default debounce when no overrides are supplied", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stdinRef = process.stdin as unknown as EventEmitter;
		const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);

		try {
			const done = runDaemonServer({ cwd: root });
			// Fire 'end' on the real process.stdin so the daemon shuts down.
			stdinRef.emit("end");
			await done;

			// A `ready` notification was written to process.stdout.
			expect(writeSpy).toHaveBeenCalled();
			const firstLine = String(writeSpy.mock.calls[0]?.[0] ?? "");
			expect(firstLine).toContain('"method":"ready"');
			// And the daemon resumed the real stdin so 'end' could fire.
			expect(resumeSpy).toHaveBeenCalled();
		} finally {
			writeSpy.mockRestore();
			resumeSpy.mockRestore();
		}
	});

	it("skips the resume() call when stdin is not a Node ReadStream", async () => {
		const stdout = new PassThrough();
		// A bare EventEmitter has no `resume` method — the daemon should still arm
		// and shut down cleanly when we fire the `end` event.
		const stdin = new EventEmitter() as unknown as NodeJS.ReadableStream;

		const done = runDaemonServer({ cwd: root, stdin, stdout, debounceMs: 10 });
		(stdin as unknown as EventEmitter).emit("end");
		await done;
	});

	it("treats a stdin 'close' event as shutdown", async () => {
		const stdout = new PassThrough();
		const stdin = new PassThrough();
		const done = runDaemonServer({ cwd: root, stdin, stdout, debounceMs: 10 });

		(stdin as unknown as EventEmitter).emit("close");
		await done;
	});
});
