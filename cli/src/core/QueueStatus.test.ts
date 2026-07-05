import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";
import { getQueueStatus, waitForQueueDrained } from "./QueueStatus.js";

let tempDir: string;

async function queueDir(): Promise<string> {
	const dir = join(getJolliMemoryDir(tempDir), "git-op-queue");
	await mkdir(dir, { recursive: true });
	return dir;
}

async function writeSummaryEntry(name: string): Promise<string> {
	const dir = await queueDir();
	const path = join(dir, name);
	await writeFile(path, JSON.stringify({ type: "commit", commitHash: "a", createdAt: new Date().toISOString() }));
	return path;
}

beforeEach(async () => {
	tempDir = join(tmpdir(), `qstatus-${process.pid}-${Math.floor(Date.now() % 1e9)}`);
	await mkdir(tempDir, { recursive: true });
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("getQueueStatus", () => {
	it("reports drained on an empty queue with no worker", async () => {
		const s = await getQueueStatus(tempDir);
		expect(s).toMatchObject({ active: 0, workerBlocking: false, drained: true });
	});

	it("is not drained while a summary entry is queued", async () => {
		await writeSummaryEntry("1-a.json");
		const s = await getQueueStatus(tempDir);
		expect(s.active).toBe(1);
		expect(s.drained).toBe(false);
	});

	it("is drained when only an ingest entry is queued and no worker runs", async () => {
		const dir = await queueDir();
		await writeFile(
			join(dir, "1-ingest.json"),
			JSON.stringify({ type: "ingest", triggeredBy: "post-commit", createdAt: new Date().toISOString() }),
		);
		const s = await getQueueStatus(tempDir);
		expect(s.active).toBe(0);
		expect(s.ingestActive).toBe(1);
		expect(s.drained).toBe(true);
	});
});

describe("waitForQueueDrained", () => {
	it("returns not-drained after the timeout when work stays queued", async () => {
		await writeSummaryEntry("1-a.json");
		const r = await waitForQueueDrained(tempDir, { timeoutMs: 40, pollMs: 5 });
		expect(r.drained).toBe(false);
		expect(r.waitedMs).toBeGreaterThanOrEqual(40);
	});

	it("returns drained once the entry is removed mid-wait", async () => {
		const path = await writeSummaryEntry("1-a.json");
		setTimeout(() => void rm(path, { force: true }), 15);
		const r = await waitForQueueDrained(tempDir, { timeoutMs: 500, pollMs: 5 });
		expect(r.drained).toBe(true);
	});

	it("coerces a non-finite timeoutMs to the default instead of busy-looping (drained returns fast)", async () => {
		// A NaN timeout (e.g. an MCP client sending `timeoutMs: "abc"`) must not
		// spin: on a drained queue it returns immediately.
		const r = await waitForQueueDrained(tempDir, { timeoutMs: Number.NaN as number, pollMs: 5 });
		expect(r.drained).toBe(true);
	});

	it("coerces a non-finite pollMs so the loop still spaces its polls (no 0 ms spin)", async () => {
		// With a valid short timeout, a NaN pollMs would previously become
		// sleep(NaN)=0 and tight-loop; the guard falls back to the default poll and
		// the timeout still bounds the wait.
		await writeSummaryEntry("1-a.json");
		const r = await waitForQueueDrained(tempDir, { timeoutMs: 40, pollMs: Number.NaN as number });
		expect(r.drained).toBe(false);
		expect(r.waitedMs).toBeGreaterThanOrEqual(40);
	});
});
