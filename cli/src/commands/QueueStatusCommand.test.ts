import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as QueueStatusCore from "../core/QueueStatus.js";
import { getJolliMemoryDir } from "../Logger.js";
import { registerQueueStatusCommand } from "./QueueStatusCommand.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = join(tmpdir(), `qcmd-${process.pid}-${Math.floor(Date.now() % 1e9)}`);
	await mkdir(tempDir, { recursive: true });
	process.exitCode = 0;
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
	process.exitCode = 0;
});

async function run(args: string[]): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerQueueStatusCommand(program);
	await program.parseAsync(["node", "jolli", "queue-status", "--cwd", tempDir, ...args]);
	return logs.join("\n");
}

/** Runs the command capturing both stdout (console.log) and stderr (console.error). */
async function runCapturingErr(args: string[]): Promise<{ out: string; err: string }> {
	const logs: string[] = [];
	const errs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	vi.spyOn(console, "error").mockImplementation((m?: unknown) => void errs.push(String(m)));
	const program = new Command();
	registerQueueStatusCommand(program);
	await program.parseAsync(["node", "jolli", "queue-status", "--cwd", tempDir, ...args]);
	return { out: logs.join("\n"), err: errs.join("\n") };
}

describe("queue-status command", () => {
	it("prints drained JSON for an empty queue", async () => {
		const out = await run(["--format", "json"]);
		expect(JSON.parse(out)).toMatchObject({ active: 0, drained: true });
	});

	it("tags the success JSON with type:'status' and always includes waitedMs (no --wait)", async () => {
		const out = await run(["--format", "json"]);
		const parsed = JSON.parse(out);
		expect(parsed.type).toBe("status");
		expect(parsed.waitedMs).toBe(0);
	});

	it("prints not-drained JSON while a summary entry is queued", async () => {
		const dir = join(getJolliMemoryDir(tempDir), "git-op-queue");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "1-a.json"),
			JSON.stringify({ type: "commit", commitHash: "a", createdAt: new Date().toISOString() }),
		);
		const out = await run(["--format", "json"]);
		expect(JSON.parse(out)).toMatchObject({ active: 1, drained: false });
	});

	it("--wait returns waitedMs and drained on an empty queue", async () => {
		const out = await run(["--wait", "--timeout", "1", "--format", "json"]);
		const parsed = JSON.parse(out);
		expect(parsed.drained).toBe(true);
		expect(parsed).toHaveProperty("waitedMs");
	});

	it("prints a human-readable summary without --format json", async () => {
		const out = await run([]);
		expect(out).toMatch(/drained|generating|queue/i);
	});

	it("prints a human-readable 'still generating' summary when an entry is queued", async () => {
		const dir = join(getJolliMemoryDir(tempDir), "git-op-queue");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "1-a.json"),
			JSON.stringify({ type: "commit", commitHash: "a", createdAt: new Date().toISOString() }),
		);
		const out = await run([]);
		expect(out).toMatch(/still generating/i);
	});

	it("prints 'finishing the last memory summary' when the queue is empty but not yet drained", async () => {
		// Worker is blocking-busy wrapping up the final summary: active === 0 yet
		// drained === false. Only reachable in the default (non-json) format.
		vi.spyOn(QueueStatusCore, "getQueueStatus").mockResolvedValue({
			active: 0,
			ingestActive: 0,
			workerBusy: true,
			workerBlocking: true,
			drained: false,
			stale: 0,
		});
		const out = await run([]);
		expect(out).toMatch(/finishing the last memory summary/i);
	});

	it("prints a JSON error and sets exit code 1 when the core throws (--format json)", async () => {
		vi.spyOn(QueueStatusCore, "getQueueStatus").mockRejectedValue(new Error("boom"));
		const out = await run(["--format", "json"]);
		expect(JSON.parse(out)).toEqual({ type: "error", message: "boom" });
		expect(process.exitCode).toBe(1);
	});

	it("prints a human-readable error and sets exit code 1 when the core throws (no --format)", async () => {
		vi.spyOn(QueueStatusCore, "getQueueStatus").mockRejectedValue(new Error("boom"));
		const { err } = await runCapturingErr([]);
		expect(err).toMatch(/boom/);
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error throw in the JSON error path", async () => {
		vi.spyOn(QueueStatusCore, "getQueueStatus").mockRejectedValue("plain string failure");
		const out = await run(["--format", "json"]);
		expect(JSON.parse(out)).toEqual({ type: "error", message: "plain string failure" });
		expect(process.exitCode).toBe(1);
	});

	it("does not hang on an invalid --timeout with --wait (falls back to default)", async () => {
		// An empty queue would drain on the first poll regardless of timeout, so it
		// can't tell a working NaN guard apart from a deleted one. Spy on the core
		// so we can assert directly on what the command passed through: proving the
		// guard converted "abc" -> undefined (letting the 120s default apply)
		// instead of leaking NaN, which would make `waitedMs >= NaN` always false
		// and hang forever.
		const waitSpy = vi.spyOn(QueueStatusCore, "waitForQueueDrained").mockResolvedValue({
			active: 0,
			ingestActive: 0,
			workerBusy: false,
			workerBlocking: false,
			drained: true,
			stale: 0,
			waitedMs: 0,
		});
		const out = await run(["--wait", "--timeout", "abc", "--format", "json"]);
		const parsed = JSON.parse(out);
		expect(parsed.drained).toBe(true);
		expect(parsed).toHaveProperty("waitedMs");
		expect(waitSpy).toHaveBeenCalledWith(tempDir, { timeoutMs: undefined });
	});
});
