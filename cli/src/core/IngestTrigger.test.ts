import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";

vi.mock("./SessionTracker.js", () => ({ enqueueGitOperation: vi.fn(async () => true) }));

import { enqueueIngestOperation, isIngestWithinCooldown, markIngestTouched } from "./IngestTrigger.js";
import { enqueueGitOperation } from "./SessionTracker.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ingest-trigger-"));
	vi.mocked(enqueueGitOperation).mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("IngestTrigger", () => {
	it("enqueues an ingest op when not in cooldown", async () => {
		const ok = await enqueueIngestOperation(dir, "post-merge");
		expect(ok).toBe(true);
		const op = vi.mocked(enqueueGitOperation).mock.calls[0]?.[0];
		expect(op).toMatchObject({ type: "ingest", triggeredBy: "post-merge" });
	});

	it("skips a second enqueue within the cooldown window", async () => {
		await enqueueIngestOperation(dir, "post-merge");
		vi.mocked(enqueueGitOperation).mockClear();
		const ok = await enqueueIngestOperation(dir, "recall-miss");
		expect(ok).toBe(false);
		expect(vi.mocked(enqueueGitOperation)).not.toHaveBeenCalled();
	});

	it("force bypasses the cooldown", async () => {
		await enqueueIngestOperation(dir, "post-merge");
		vi.mocked(enqueueGitOperation).mockClear();
		const ok = await enqueueIngestOperation(dir, "manual", { force: true });
		expect(ok).toBe(true);
	});

	it("markIngestTouched then isIngestWithinCooldown is true; far-future now is false", async () => {
		await markIngestTouched(dir);
		expect(await isIngestWithinCooldown(dir)).toBe(true);
		expect(await isIngestWithinCooldown(dir, Date.now() + 60 * 60 * 1000)).toBe(false);
	});

	it("treats an unparseable lastIngestedAt date as not-in-cooldown", async () => {
		// Mark first so the directory exists, then overwrite with a garbage timestamp.
		await markIngestTouched(dir);
		const file = join(getJolliMemoryDir(dir), "ingest-cooldown.json");
		writeFileSync(file, JSON.stringify({ lastIngestedAt: "not-a-date" }), "utf-8");
		expect(await isIngestWithinCooldown(dir)).toBe(false);
	});

	it("returns false when enqueue throws (error path)", async () => {
		vi.mocked(enqueueGitOperation).mockRejectedValueOnce(new Error("boom"));
		const ok = await enqueueIngestOperation(dir, "post-merge");
		expect(ok).toBe(false);
	});

	it("sets the cooldown only after a successful enqueue", async () => {
		const ok = await enqueueIngestOperation(dir, "post-merge");
		expect(ok).toBe(true);
		expect(await isIngestWithinCooldown(dir)).toBe(true);
	});

	it("does NOT burn the cooldown when the enqueue write fails (next trigger can recover)", async () => {
		vi.mocked(enqueueGitOperation).mockResolvedValueOnce(false);
		const ok = await enqueueIngestOperation(dir, "post-merge");
		expect(ok).toBe(false);
		// No op landed on disk, so the window must stay open for the next trigger.
		expect(await isIngestWithinCooldown(dir)).toBe(false);
	});

	it("does NOT burn the cooldown when the enqueue throws (next trigger can recover)", async () => {
		vi.mocked(enqueueGitOperation).mockRejectedValueOnce(new Error("boom"));
		const ok = await enqueueIngestOperation(dir, "post-merge");
		expect(ok).toBe(false);
		expect(await isIngestWithinCooldown(dir)).toBe(false);
	});

	it("ignores a non-object cooldown file (JSON array) and treats it as no cooldown", async () => {
		await markIngestTouched(dir);
		const file = join(getJolliMemoryDir(dir), "ingest-cooldown.json");
		writeFileSync(file, JSON.stringify(["unexpected"]), "utf-8");
		// Array parses but fails the object guard → empty state → not in cooldown.
		expect(await isIngestWithinCooldown(dir)).toBe(false);
	});
});
