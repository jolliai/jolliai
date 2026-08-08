import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlansDir } from "../core/PlanService.js";
import { getDashboardDbPath } from "../dashboard/DashboardDb.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import { DAEMON_PROTOCOL } from "./DaemonProtocol.js";
import { buildRefreshParams, computeWatchTargets, runDaemonServer } from "./DaemonServer.js";

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

	it("returns the five watch targets rooted at cwd (main checkout)", () => {
		const targets = computeWatchTargets("/repo", {
			gitCommonDir: join("/repo", ".git"),
			plansDir: "/home/u/.claude/plans",
			globalConfigDir: "/home/u/.jolli/jollimemory",
		});
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
			{
				kind: "memory-db",
				// Post-cutover the ref above stops moving and this is the only
				// file a stored memory touches. Machine-global: never auto-created.
				path: "/home/u/.jolli/jollimemory",
				ensureDir: false,
			},
			{
				kind: "working-context",
				path: join("/repo", ".jolli", "jollimemory"),
				ensureDir: true,
			},
			{
				kind: "claude-plans",
				// Machine-global and not ours: never auto-created.
				path: "/home/u/.claude/plans",
				ensureDir: false,
			},
		]);
	});

	it("defaults the plans dir to the CLI's own getPlansDir() when no override is given", () => {
		mockExec.mockReturnValueOnce("/repo/.git\n");
		const targets = computeWatchTargets("/repo");
		// Asserted against the shared helper rather than a second `~/.claude/plans`
		// literal — the path is the CLI's to own, and a copy here would keep
		// passing after the real one moved.
		expect(targets.find((t) => t.kind === "claude-plans")?.path).toBe(getPlansDir());
	});

	it("gates the working-context target to plans.json so the dir's noisy neighbours never trigger", () => {
		const filter = computeWatchTargets("/repo", { gitCommonDir: "/repo/.git" }).find(
			(t) => t.kind === "working-context",
		)?.filter;
		expect(filter).toBeDefined();
		expect(filter?.("plans.json")).toBe(true);
		// The three files that share this directory and are written constantly.
		expect(filter?.("debug.log")).toBe(false);
		expect(filter?.("sessions.json")).toBe(false);
		expect(filter?.("cursors.json")).toBe(false);
	});

	it("gates the memory-db target to the database and its WAL sidecars", () => {
		const target = computeWatchTargets("/repo", { gitCommonDir: "/repo/.git" }).find((t) => t.kind === "memory-db");
		expect(target?.filter?.("jollimemory.db")).toBe(true);
		// `-wal` is the file that actually moves per write; the main `.db` mtime
		// only changes at checkpoint, so gating it out would delay every push.
		expect(target?.filter?.("jollimemory.db-wal")).toBe(true);
		expect(target?.filter?.("jollimemory.db-shm")).toBe(true);
		// The machine-global dir's other residents, none of which mean "a memory
		// was stored" — `config.json` above all, rewritten on every settings save.
		expect(target?.filter?.("config.json")).toBe(false);
		expect(target?.filter?.("run-hook")).toBe(false);
		expect(target?.filter?.("agent-unsupported-flags.json")).toBe(false);
	});

	it("defaults the memory-db dir to the machine-global config dir when no override is given", () => {
		mockExec.mockReturnValueOnce("/repo/.git\n");
		const targets = computeWatchTargets("/repo");
		expect(targets.find((t) => t.kind === "memory-db")?.path).toBe(dirname(getDashboardDbPath()));
	});

	it("gates the claude-plans target to markdown and forwards the burst's filenames", () => {
		const target = computeWatchTargets("/repo", { gitCommonDir: "/repo/.git" }).find(
			(t) => t.kind === "claude-plans",
		);
		expect(target?.filter?.("my-plan.md")).toBe(true);
		expect(target?.filter?.("notes.txt")).toBe(false);
		// The only target that forwards names — see DaemonProtocol's `names`.
		expect(target?.forwardNames).toBe(true);
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

describe("buildRefreshParams", () => {
	const target = { kind: "queue", path: "/p", ensureDir: true } as const;

	it("omits `names` entirely for a target that does not forward them", () => {
		const params = buildRefreshParams(target, "/repo", new Set(["a.md"]));
		expect(params).toEqual({ kind: "queue", cwd: "/repo" });
		// Absent, not empty — a client must be able to tell "this kind never
		// carries names" from "this burst reported none".
		expect("names" in params).toBe(false);
	});

	it("forwards the burst's names sorted so the wire is deterministic", () => {
		const params = buildRefreshParams(
			{ kind: "claude-plans", path: "/p", ensureDir: false, forwardNames: true },
			"/repo",
			// Insertion order is platform event-delivery order, which varies run
			// to run; the emitted array must not.
			new Set(["c.md", "a.md", "b.md"]),
		);
		expect(params).toEqual({ kind: "claude-plans", cwd: "/repo", names: ["a.md", "b.md", "c.md"] });
	});

	it("forwards an empty array when the platform reported no filenames", () => {
		const params = buildRefreshParams(
			{ kind: "claude-plans", path: "/p", ensureDir: false, forwardNames: true },
			"/repo",
			new Set(),
		);
		expect(params.names).toEqual([]);
	});
});

describe("runDaemonServer", () => {
	let root: string;
	/**
	 * Scratch stand-in for the machine-global `~/.claude/plans/`. Every test
	 * passes it: without the override the daemon arms a real watcher on the
	 * developer's own plans dir, and a Claude Code session running alongside the
	 * suite would inject refresh lines into these assertions.
	 */
	let plansDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "daemon-server-"));
		plansDir = join(root, "claude-plans");
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

		const done = runDaemonServer({ cwd: root, stdin, stdout, plansDir, debounceMs: 10 });

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

		const done = runDaemonServer({ cwd: root, stdin, stdout, plansDir, debounceMs: 50 });

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

	it("emits claude-plans with the new plan's filename, and stays silent for a non-markdown sibling", async () => {
		mkdirSync(plansDir, { recursive: true });
		const stdout = new PassThrough();
		const stdin = new PassThrough();
		const chunks: string[] = [];
		stdout.on("data", (buf) => chunks.push(String(buf)));

		const done = runDaemonServer({ cwd: root, stdin, stdout, plansDir, debounceMs: 50 });
		await sleep(150);

		// The noise first: if the `.md` gate were missing this would produce its
		// own refresh, and the assertion below could not tell the two apart.
		writeFileSync(join(plansDir, "scratch.txt"), "ignored");
		writeFileSync(join(plansDir, "add-dark-mode.md"), "# Add dark mode");

		await vi.waitFor(
			() => {
				const refresh = chunks
					.join("")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
					.find((m) => m.method === "refresh" && m.params.kind === "claude-plans");
				expect(refresh).toBeTruthy();
				// Raw directory entry, not a slug — turning `<slug>.md` into a slug
				// is `plans-register-new`'s job, not the wire's.
				expect(refresh.params).toEqual({
					kind: "claude-plans",
					cwd: root,
					names: ["add-dark-mode.md"],
				});
			},
			{ timeout: 10_000, interval: 20 },
		);

		stdin.end();
		await done;
	});

	it("emits working-context for plans.json but not for the noisy files beside it", async () => {
		const stateDir = join(root, ".jolli", "jollimemory");
		const stdout = new PassThrough();
		const stdin = new PassThrough();
		const chunks: string[] = [];
		stdout.on("data", (buf) => chunks.push(String(buf)));

		// ensureDir=true on this target, so the dir exists right after start().
		const done = runDaemonServer({ cwd: root, stdin, stdout, plansDir, debounceMs: 50 });
		await sleep(150);

		// debug.log is the reason this target is gated at all — it is written many
		// times a second in a real session.
		writeFileSync(join(stateDir, "debug.log"), "noise\n");
		await sleep(200);
		const kindsAfterNoise = chunks
			.join("")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((m) => m.method === "refresh")
			.map((m) => m.params.kind);
		expect(kindsAfterNoise).not.toContain("working-context");

		writeFileSync(join(stateDir, "plans.json"), "{}");
		await vi.waitFor(
			() => {
				const refresh = chunks
					.join("")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
					.find((m) => m.method === "refresh" && m.params.kind === "working-context");
				expect(refresh).toBeTruthy();
				// This kind carries no names — the client re-reads plans.json.
				expect(refresh.params).toEqual({ kind: "working-context", cwd: root });
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
			const done = runDaemonServer({ cwd: root, stdin, stdout, plansDir, debounceMs: 10 });

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
			const done = runDaemonServer({ cwd: root, stdin, stdout, plansDir, debounceMs: 10 });

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
			const done = runDaemonServer({ cwd: root, plansDir });
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

		const done = runDaemonServer({ cwd: root, stdin, stdout, plansDir, debounceMs: 10 });
		(stdin as unknown as EventEmitter).emit("end");
		await done;
	});

	it("treats a stdin 'close' event as shutdown", async () => {
		const stdout = new PassThrough();
		const stdin = new PassThrough();
		const done = runDaemonServer({ cwd: root, stdin, stdout, plansDir, debounceMs: 10 });

		(stdin as unknown as EventEmitter).emit("close");
		await done;
	});
});

// A source-shape assertion, because nothing else can see this regress: a new static
// import here keeps the types correct, passes lint, and leaves every test green —
// the only thing that changes is the cold-start latency of `jolli ide-bridge`, which
// imports this module statically while deferring all of its own handler work behind
// `await import(...)` for exactly that reason. `getPlansDir` already leaked in once
// through `PlanService`, making SummaryStore → OrphanBranchStorage / GitOps, plus
// SessionTracker / ReferenceStore / Locks, eager for every such process (~4 ms of
// leaf-only imports vs ~28 ms measured under tsx). Keep this list on leaves.
describe("cold-start import graph", () => {
	it("statically imports only node builtins and leaf modules", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./DaemonServer.ts", import.meta.url), "utf-8");

		// Deliberately narrow: each entry's own transitive imports are node builtins
		// or other leaves. Widening this set is the decision the test exists to force
		// someone to make on purpose rather than by autocomplete.
		const ALLOWED_LEAF_MODULES = new Set([
			"../core/PlanPaths.js",
			"../Logger.js",
			"../util/Subprocess.js",
			"./DaemonNotifier.js",
			"./DaemonProtocol.js",
			"./DaemonWatcher.js",
		]);

		// Counted separately so a regex that fails to match a new import shape (a
		// side-effect `import "./x.js"`, say) fails loudly instead of passing on an
		// empty result.
		const importStatements = [...source.matchAll(/^import\b/gm)].length;
		const specifiers = [...source.matchAll(/^import\b[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
		expect(specifiers).toHaveLength(importStatements);

		const offenders = specifiers.filter((s) => !s.startsWith("node:") && !ALLOWED_LEAF_MODULES.has(s));
		expect(offenders).toEqual([]);
	});
});
