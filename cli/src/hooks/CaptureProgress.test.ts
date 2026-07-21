import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import type { CaptureProgressEvent } from "./CaptureProgress.js";
import {
	AGENT_FEEDBACK_TIMEOUT_MS,
	acquireCaptureLock,
	captureLockPath,
	captureProgressDir,
	captureProgressPath,
	emitCaptureProgress,
	formatCaptureLine,
	isAgentSession,
	isCaptureWorkerDead,
	pruneStaleCaptureProgress,
	readCaptureEvents,
	releaseCaptureLock,
	runCommitFeedback,
	shouldShowCommitFeedback,
	watchCaptureProgress,
} from "./CaptureProgress.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = join(
		tmpdir(),
		`capprog-${process.pid}-${Math.floor(Date.now() % 1e9)}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(tempDir, { recursive: true });
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const HASH = "abc1234def567890";

describe("path helpers", () => {
	it("derive dir and per-hash file path", () => {
		expect(captureProgressDir(tempDir)).toBe(join(getJolliMemoryDir(tempDir), "capture-progress"));
		expect(captureProgressPath(tempDir, HASH)).toBe(
			join(getJolliMemoryDir(tempDir), "capture-progress", `${HASH}.ndjson`),
		);
	});

	it("derives the per-hash capture lock path under the progress dir", () => {
		const dir = captureProgressDir(tempDir);
		const p = captureLockPath(tempDir, HASH);
		expect(p.startsWith(dir)).toBe(true);
		expect(p.endsWith(".lock")).toBe(true);
	});
});

describe("isCaptureWorkerDead", () => {
	it("is false when no lock exists (worker not started or already released)", async () => {
		expect(await isCaptureWorkerDead(tempDir, HASH)).toBe(false);
	});

	it("is false when the lock owner is alive (this process)", async () => {
		mkdirSync(captureProgressDir(tempDir), { recursive: true });
		writeFileSync(captureLockPath(tempDir, HASH), String(process.pid), "utf-8");
		expect(await isCaptureWorkerDead(tempDir, HASH)).toBe(false);
	});

	it("is true when the lock owner PID is dead", async () => {
		mkdirSync(captureProgressDir(tempDir), { recursive: true });
		// PID 2^31-1 is effectively never a live process.
		writeFileSync(captureLockPath(tempDir, HASH), "2147483647", "utf-8");
		expect(await isCaptureWorkerDead(tempDir, HASH)).toBe(true);
	});

	it("is false when cwd is undefined", async () => {
		expect(await isCaptureWorkerDead(undefined, HASH)).toBe(false);
	});
});

describe("acquireCaptureLock / releaseCaptureLock", () => {
	it("acquire writes the current PID; release removes it", async () => {
		acquireCaptureLock(tempDir, HASH);
		const lock = captureLockPath(tempDir, HASH);
		expect(readFileSync(lock, "utf-8")).toBe(String(process.pid));
		// While held by a live PID the worker is NOT dead.
		expect(await isCaptureWorkerDead(tempDir, HASH)).toBe(false);
		await releaseCaptureLock(tempDir, HASH);
		expect(existsSync(lock)).toBe(false);
	});

	it("release never removes a lock owned by another PID", async () => {
		mkdirSync(captureProgressDir(tempDir), { recursive: true });
		writeFileSync(captureLockPath(tempDir, HASH), "2147483647", "utf-8");
		await releaseCaptureLock(tempDir, HASH);
		// Foreign lock untouched.
		expect(readFileSync(captureLockPath(tempDir, HASH), "utf-8")).toBe("2147483647");
	});

	it("is best-effort: no throw when cwd is undefined or dir is unwritable", () => {
		expect(() => acquireCaptureLock(undefined, HASH)).not.toThrow();
		expect(() => acquireCaptureLock(join(tempDir, "nope/impossible\0"), HASH)).not.toThrow();
	});
});

describe("isAgentSession", () => {
	it("detects agent-marker env vars", () => {
		expect(isAgentSession({ CLAUDECODE: "1" })).toBe(true);
		expect(isAgentSession({ AI_AGENT: "claude-code_x" })).toBe(true);
		expect(isAgentSession({ CURSOR_TRACE_ID: "abc" })).toBe(true);
		expect(isAgentSession({ GEMINI_CLI: "1" })).toBe(true);
		expect(isAgentSession({ OPENCODE: "true" })).toBe(true);
	});

	it("is false for empty / falsy / absent markers", () => {
		expect(isAgentSession({})).toBe(false);
		expect(isAgentSession({ CLAUDECODE: "" })).toBe(false);
		expect(isAgentSession({ CLAUDECODE: "0" })).toBe(false);
		expect(isAgentSession({ AI_AGENT: "false" })).toBe(false);
	});
});

describe("emitCaptureProgress + readCaptureEvents", () => {
	it("round-trips events including data and terminal flag", () => {
		emitCaptureProgress(tempDir, HASH, "start");
		emitCaptureProgress(tempDir, HASH, "diff", { data: { filesChanged: 3, insertions: 10, deletions: 2 } });
		emitCaptureProgress(tempDir, HASH, "end", { terminal: true });

		const events = readCaptureEvents(captureProgressPath(tempDir, HASH));
		expect(events.map((e) => e.step)).toEqual(["start", "diff", "end"]);
		expect(events[1].data).toEqual({ filesChanged: 3, insertions: 10, deletions: 2 });
		expect(events[2].terminal).toBe(true);
		expect(events[0].terminal).toBeUndefined();
		expect(typeof events[0].ts).toBe("number");
	});

	it("returns [] for a missing file", () => {
		expect(readCaptureEvents(captureProgressPath(tempDir, "nope"))).toEqual([]);
	});

	it("skips blank and torn/malformed lines", () => {
		const path = captureProgressPath(tempDir, HASH);
		mkdirSync(captureProgressDir(tempDir), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ step: "start", hash: HASH, ts: 1 })}\n\n{not json\n`, "utf-8");
		const events = readCaptureEvents(path);
		expect(events).toHaveLength(1);
		expect(events[0].step).toBe("start");
	});

	it("is best-effort: never throws when the dir path is unwritable", () => {
		// Occupy the capture-progress path with a FILE so mkdirSync throws.
		mkdirSync(getJolliMemoryDir(tempDir), { recursive: true });
		writeFileSync(captureProgressDir(tempDir), "i am a file, not a dir", "utf-8");
		expect(() => emitCaptureProgress(tempDir, HASH, "start")).not.toThrow();
	});
});

describe("pruneStaleCaptureProgress", () => {
	it("deletes files older than maxAge, keeps fresh ones, ignores non-ndjson", () => {
		const dir = captureProgressDir(tempDir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "old.ndjson"), "x", "utf-8");
		writeFileSync(join(dir, "fresh.ndjson"), "y", "utf-8");
		writeFileSync(join(dir, "keep.txt"), "z", "utf-8");
		const now = Date.now();
		// old.ndjson mtime is ~now; treat "now far in the future" so only it ages out
		// by making maxAge tiny and nowMs large relative to the fresh file we rewrite.
		// Simpler: rewrite fresh right before pruning and use a large nowMs offset.
		writeFileSync(join(dir, "fresh.ndjson"), "y2", "utf-8");
		pruneStaleCaptureProgress(tempDir, 5_000, now + 10_000);
		// With nowMs = now+10s and maxAge 5s, files touched at ~now are >5s stale → deleted.
		expect(readCaptureEvents(join(dir, "old.ndjson"))).toEqual([]);
		// keep.txt untouched (not ndjson)
		expect(() => readFileSync(join(dir, "keep.txt"), "utf-8")).not.toThrow();
	});

	it("keeps files newer than maxAge", () => {
		const dir = captureProgressDir(tempDir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "recent.ndjson"), "x", "utf-8");
		pruneStaleCaptureProgress(tempDir, 60_000, Date.now());
		expect(() => readFileSync(join(dir, "recent.ndjson"), "utf-8")).not.toThrow();
	});

	it("no-ops when the dir is missing", () => {
		expect(() => pruneStaleCaptureProgress(tempDir, 1000)).not.toThrow();
	});

	it("prunes a stale .lock left by a force-killed worker", () => {
		// acquireCaptureLock writes `<sha256>.lock` files into the same dir; a
		// force-killed worker never releases them and its hash is never re-run,
		// so without lock pruning the file lingers forever.
		const dir = captureProgressDir(tempDir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "abandoned.lock"), "pid", "utf-8");
		// nowMs 10s ahead with a 5s maxAge → the ~now lock is >5s stale → deleted.
		pruneStaleCaptureProgress(tempDir, 5_000, Date.now() + 10_000);
		expect(existsSync(join(dir, "abandoned.lock"))).toBe(false);
	});

	it("keeps a fresh .lock still held by a live worker", () => {
		const dir = captureProgressDir(tempDir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "held.lock"), "pid", "utf-8");
		// A live lock is refreshed well within maxAge, so a recent mtime is kept.
		pruneStaleCaptureProgress(tempDir, 60_000, Date.now());
		expect(existsSync(join(dir, "held.lock"))).toBe(true);
	});
});

describe("shouldShowCommitFeedback", () => {
	const noEnv: Record<string, string | undefined> = {};

	it("explicit on/off from config wins over interactivity", () => {
		expect(shouldShowCommitFeedback("on", noEnv, false)).toBe(true);
		expect(shouldShowCommitFeedback("off", noEnv, true)).toBe(false);
	});

	it("auto shows on a TTY", () => {
		expect(shouldShowCommitFeedback("auto", noEnv, true)).toBe(true);
		expect(shouldShowCommitFeedback(undefined, noEnv, true)).toBe(true);
	});

	it("auto shows in an AI-agent session (CLAUDECODE / AI_AGENT)", () => {
		expect(shouldShowCommitFeedback("auto", { CLAUDECODE: "1" }, false)).toBe(true);
		expect(shouldShowCommitFeedback("auto", { AI_AGENT: "claude-code_x" }, undefined)).toBe(true);
	});

	it("auto stays silent with no TTY and no agent env", () => {
		expect(shouldShowCommitFeedback("auto", noEnv, false)).toBe(false);
		expect(shouldShowCommitFeedback("auto", { CLAUDECODE: "" }, undefined)).toBe(false);
		expect(shouldShowCommitFeedback("auto", { CLAUDECODE: "0" }, false)).toBe(false);
		expect(shouldShowCommitFeedback("auto", { AI_AGENT: "false" }, false)).toBe(false);
	});

	it("JOLLI_COMMIT_FEEDBACK env overrides config", () => {
		expect(shouldShowCommitFeedback("off", { JOLLI_COMMIT_FEEDBACK: "on" }, false)).toBe(true);
		expect(shouldShowCommitFeedback("on", { JOLLI_COMMIT_FEEDBACK: "off" }, true)).toBe(false);
		// invalid override value falls through to config
		expect(shouldShowCommitFeedback("on", { JOLLI_COMMIT_FEEDBACK: "maybe" }, false)).toBe(true);
		// auto override resolves via interactivity
		expect(shouldShowCommitFeedback("off", { JOLLI_COMMIT_FEEDBACK: "auto" }, true)).toBe(true);
	});
});

function ev(step: CaptureProgressEvent["step"], data?: CaptureProgressEvent["data"]): CaptureProgressEvent {
	return { step, hash: HASH, ts: 0, ...(data ? { data } : {}) };
}

describe("formatCaptureLine", () => {
	it("start references the short hash", () => {
		expect(formatCaptureLine(ev("start"))).toBe("● Jolli Memory · capturing context for abc1234…");
	});

	it("diff: null when no files, singular/plural + delta variants", () => {
		expect(formatCaptureLine(ev("diff", { filesChanged: 0 }))).toBeNull();
		expect(formatCaptureLine(ev("diff", { filesChanged: 1 }))).toBe("  indexing 1 file changed");
		expect(formatCaptureLine(ev("diff", { filesChanged: 2, insertions: 5, deletions: 0 }))).toBe(
			"  indexing 2 files changed  (+5 −0)",
		);
		// both zero delta → no delta suffix
		expect(formatCaptureLine(ev("diff", { filesChanged: 2, insertions: 0, deletions: 0 }))).toBe(
			"  indexing 2 files changed",
		);
		// one-sided deltas exercise the `?? 0` fallback on the missing side
		expect(formatCaptureLine(ev("diff", { filesChanged: 1, deletions: 3 }))).toBe(
			"  indexing 1 file changed  (+0 −3)",
		);
		expect(formatCaptureLine(ev("diff", { filesChanged: 1, insertions: 7 }))).toBe(
			"  indexing 1 file changed  (+7 −0)",
		);
	});

	it("references: null when empty, otherwise #-prefixed tags", () => {
		expect(formatCaptureLine(ev("references"))).toBeNull();
		expect(formatCaptureLine(ev("references", { references: [] }))).toBeNull();
		expect(formatCaptureLine(ev("references", { references: ["auth-module", "#vector-db-init"] }))).toBe(
			"  found links to: #auth-module, #vector-db-init",
		);
	});

	it("static lines", () => {
		expect(formatCaptureLine(ev("analyzing"))).toBe("  analyzing semantic intent of the change…");
		expect(formatCaptureLine(ev("plan-progress"))).toBe("  evaluating plan progress…");
		expect(formatCaptureLine(ev("stored"))).toBe("✓ Jolli Memory updated");
		expect(formatCaptureLine(ev("skipped"))).toBe("  (no changes to capture)");
		expect(formatCaptureLine(ev("failed"))).toBe(
			"⚠ Jolli Memory: capture did not complete (see .jolli/jollimemory/debug.log)",
		);
		expect(formatCaptureLine(ev("end"))).toBeNull();
	});

	it("stored with authExpired shows sign-in guidance instead of the success line", () => {
		const line = formatCaptureLine(ev("stored", { topics: 0, authExpired: true }));
		expect(line).not.toBe("✓ Jolli Memory updated");
		expect(line).toContain("the Claude login used for local generation has expired");
		expect(line).toContain("claude auth login");
		expect(line).toContain("jolli configure --set aiProvider");
		// The SEPARATE-from-Desktop clarification must be present.
		expect(line).toContain("SEPARATE from Claude Desktop");
	});
});

const immediateSleep = () => Promise.resolve();

describe("watchCaptureProgress", () => {
	it("delivers events in order across polls and stops on terminal", async () => {
		const polls: CaptureProgressEvent[][] = [
			[],
			[ev("start")],
			[ev("start"), ev("diff", { filesChanged: 1 })],
			[ev("start"), ev("diff", { filesChanged: 1 }), { ...ev("end"), terminal: true }],
		];
		let i = 0;
		const seen: string[] = [];
		const res = await watchCaptureProgress(tempDir, HASH, {
			onEvent: (e) => seen.push(e.step),
			sleep: immediateSleep,
			readEvents: () => polls[Math.min(i++, polls.length - 1)],
			now: () => 0,
		});
		expect(seen).toEqual(["start", "diff", "end"]); // no duplicates despite re-reads
		expect(res).toEqual({ ended: "terminal", count: 3 });
	});

	it("returns without terminal when the timeout elapses", async () => {
		let t = 0;
		const res = await watchCaptureProgress(tempDir, HASH, {
			onEvent: () => {},
			sleep: immediateSleep,
			readEvents: () => [ev("start")],
			workerDead: () => Promise.resolve(false),
			timeoutMs: 2,
			now: () => t++,
		});
		expect(res.ended).toBe("timeout");
		expect(res.count).toBe(1); // "start" delivered once, then timed out
	});

	it("stops early (without terminal) when the worker is detected dead", async () => {
		const res = await watchCaptureProgress(tempDir, HASH, {
			onEvent: () => {},
			sleep: immediateSleep,
			readEvents: () => [ev("start")],
			workerDead: () => Promise.resolve(true),
			timeoutMs: 1_000_000,
			now: () => 0,
		});
		expect(res.ended).toBe("worker-dead");
		expect(res.count).toBe(1); // "start" delivered, then bailed on dead worker
	});

	it("uses real file + default readers when none injected", async () => {
		emitCaptureProgress(tempDir, HASH, "start");
		emitCaptureProgress(tempDir, HASH, "end", { terminal: true });
		const seen: string[] = [];
		const res = await watchCaptureProgress(tempDir, HASH, {
			onEvent: (e) => seen.push(e.step),
			pollMs: 1,
		});
		expect(seen).toEqual(["start", "end"]);
		expect(res.ended).toBe("terminal");
	});

	it("uses the default sleep between polls when none is injected", async () => {
		let call = 0;
		const res = await watchCaptureProgress(tempDir, HASH, {
			onEvent: () => {},
			// first poll: nothing yet; second poll: terminal → forces one real sleep(1)
			readEvents: () => (call++ === 0 ? [] : [{ ...ev("end"), terminal: true }]),
			pollMs: 1,
			now: () => 0,
		});
		expect(res.ended).toBe("terminal");
	});
});

function fakeConfig(commitFeedback?: JolliMemoryConfig["commitFeedback"]): () => Promise<JolliMemoryConfig> {
	return () => Promise.resolve(commitFeedback ? { commitFeedback } : {});
}

describe("runCommitFeedback", () => {
	it("writes nothing when the gate is off", async () => {
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("off"),
			env: {},
			isTTY: true,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start"), { ...ev("end"), terminal: true }],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual([]);
	});

	it("prints the lifecycle and no closing line once stored", async () => {
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [
				ev("start"),
				ev("diff", { filesChanged: 2, insertions: 4, deletions: 1 }),
				ev("references", { references: ["auth-module"] }),
				ev("analyzing"),
				ev("stored", { topics: 3 }),
				{ ...ev("end"), terminal: true },
			],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual([
			"● Jolli Memory · capturing context for abc1234…",
			"  indexing 2 files changed  (+4 −1)",
			"  found links to: #auth-module",
			"  analyzing semantic intent of the change…",
			"✓ Jolli Memory updated",
		]);
	});

	it("prints a background-continues closing line when the watch ends without storing", async () => {
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start"), { ...ev("end"), terminal: true }],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual([
			"● Jolli Memory · capturing context for abc1234…",
			"  analysis continues in the background…",
		]);
	});

	it("reports a completed squash/rebase capture (start → stored → end), not the background fallback", async () => {
		// Mirrors the exact stream the squash / rebase-pick / rebase-squash handlers
		// now produce via processQueueEntry: a non-terminal `stored` followed by the
		// terminal `end`. Regression guard for the "background…" fallback firing
		// after a successful consolidation.
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start"), ev("stored", { topics: 2 }), { ...ev("end"), terminal: true }],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual(["● Jolli Memory · capturing context for abc1234…", "✓ Jolli Memory updated"]);
		expect(lines).not.toContain("  analysis continues in the background…");
	});

	it("reports a skipped squash/rebase capture (start → terminal skipped), not the background fallback", async () => {
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start"), { ...ev("skipped"), terminal: true }],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual(["● Jolli Memory · capturing context for abc1234…", "  (no changes to capture)"]);
		expect(lines).not.toContain("  analysis continues in the background…");
	});

	it("does not print a closing line when the commit was skipped", async () => {
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start"), { ...ev("skipped"), terminal: true }],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual(["● Jolli Memory · capturing context for abc1234…", "  (no changes to capture)"]);
	});

	it("prints the failed notice and not the background line when capture fails", async () => {
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start"), ev("failed"), { ...ev("end"), terminal: true }],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual([
			"● Jolli Memory · capturing context for abc1234…",
			"⚠ Jolli Memory: capture did not complete (see .jolli/jollimemory/debug.log)",
		]);
		expect(lines).not.toContain("  analysis continues in the background…");
	});

	it("reports an interrupted capture when the worker is detected dead", async () => {
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start")], // never emits a terminal event
			workerDead: () => Promise.resolve(true),
			timeoutMs: 1_000_000, // would otherwise block; the dead-worker probe bails first
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual([
			"● Jolli Memory · capturing context for abc1234…",
			"⚠ Jolli Memory: capture was interrupted before finishing (see .jolli/jollimemory/debug.log)",
		]);
		expect(lines).not.toContain("  analysis continues in the background…");
	});

	it("treats a failing loadConfig as auto mode (silent without interactivity)", async () => {
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: () => Promise.reject(new Error("boom")),
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start"), { ...ev("end"), terminal: true }],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual([]); // auto + not interactive → gate closed
	});

	it("defaults loadConfig from disk (empty → auto → gated off when non-interactive)", async () => {
		const lines: string[] = [];
		// loadConfigFn omitted → real loadConfig (no global config in this temp env → {}).
		await runCommitFeedback(tempDir, HASH, {
			env: {},
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start"), { ...ev("end"), terminal: true }],
			sleep: immediateSleep,
			now: () => 0,
		});
		expect(lines).toEqual([]);
	});

	it("defaults env/isTTY/write when omitted (writes via process.stdout)", async () => {
		const original = process.stdout.write;
		const captured: string[] = [];
		process.stdout.write = ((chunk: unknown): boolean => {
			captured.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			// mode "on" opens the gate regardless of the defaulted env/isTTY.
			await runCommitFeedback(tempDir, HASH, {
				loadConfigFn: fakeConfig("on"),
				readEvents: () => [ev("start"), { ...ev("end"), terminal: true }],
				sleep: immediateSleep,
				now: () => 0,
			});
		} finally {
			process.stdout.write = original;
		}
		const written = captured.join("");
		expect(written).toContain("● Jolli Memory · capturing context for abc1234…");
		expect(written).toContain("analysis continues in the background…");
	});

	it("agent sessions time out at AGENT_FEEDBACK_TIMEOUT_MS (not the 90s default)", async () => {
		// Simulate a worker that emits "start" then goes silent (LLM still
		// running). The clock jumps past the agent ceiling on the second poll.
		let t = 0;
		const lines: string[] = [];
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: { CLAUDECODE: "1" },
			isTTY: false,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start")],
			workerDead: () => Promise.resolve(false),
			sleep: immediateSleep,
			now: () => (t++ === 0 ? 0 : AGENT_FEEDBACK_TIMEOUT_MS),
		});
		expect(lines).toEqual([
			"● Jolli Memory · capturing context for abc1234…",
			"  analysis continues in the background…",
		]);
	});

	it("non-agent sessions keep the full DEFAULT timeout window", async () => {
		// Same silent worker, but the clock only passes AGENT_FEEDBACK_TIMEOUT_MS
		// — a TTY watch must still be running (no timeout line yet). It ends at
		// the 90s default instead.
		const lines: string[] = [];
		let polls = 0;
		await runCommitFeedback(tempDir, HASH, {
			loadConfigFn: fakeConfig("on"),
			env: {},
			isTTY: true,
			write: (l) => lines.push(l),
			readEvents: () => [ev("start")],
			workerDead: () => Promise.resolve(false),
			sleep: immediateSleep,
			// First 3 polls within the agent window, 4th exceeds 90s.
			now: () => [0, 5_000, AGENT_FEEDBACK_TIMEOUT_MS, 90_000][Math.min(polls++, 3)],
		});
		// Timed out only at the full default — the agent-window polls did NOT end it.
		expect(polls).toBe(4);
		expect(lines).toContain("  analysis continues in the background…");
	});
});
