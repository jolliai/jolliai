import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClineSessions, scanClineSessions } from "./ClineSessionDiscoverer.js";

async function writeHistory(storageDir: string, entries: object[]): Promise<void> {
	const stateDir = join(storageDir, "state");
	await mkdir(stateDir, { recursive: true });
	await writeFile(join(stateDir, "taskHistory.json"), JSON.stringify(entries), "utf8");
}

describe("scanClineSessions", () => {
	let sd: string;
	const project = "/tmp/proj-a";
	beforeEach(async () => {
		sd = await mkdtemp(join(tmpdir(), "cline-ext-disc-"));
	});
	afterEach(async () => {
		await rm(sd, { recursive: true, force: true });
	});

	it("empty when no flavor has history (ENOENT ignored, no error)", async () => {
		const r = await scanClineSessions(project, [join(sd, "flavorX")]);
		expect(r).toEqual({ sessions: [] });
	});

	it("attributes by cwdOnTaskInitialization, sets source/title/transcriptPath", async () => {
		await writeHistory(sd, [
			{ id: "t1", ts: Date.now(), task: "查看分支", cwdOnTaskInitialization: project },
			{ id: "t2", ts: Date.now(), task: "other", cwdOnTaskInitialization: "/tmp/other" },
		]);
		const r = await scanClineSessions(project, [sd]);
		expect(r.sessions).toHaveLength(1);
		expect(r.sessions[0]).toMatchObject({ sessionId: "t1", source: "cline", title: "查看分支" });
		expect(r.sessions[0].transcriptPath).toBe(join(sd, "tasks", "t1", "api_conversation_history.json"));
	});

	it("merges across flavors; reports error on corrupt history", async () => {
		await writeHistory(sd, [{ id: "t1", ts: Date.now(), cwdOnTaskInitialization: project }]);
		const bad = await mkdtemp(join(tmpdir(), "cline-bad-"));
		await mkdir(join(bad, "state"), { recursive: true });
		await writeFile(join(bad, "state", "taskHistory.json"), "{ not array", "utf8");
		const r = await scanClineSessions(project, [sd, bad]);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["t1"]);
		expect(r.error?.kind).toBe("parse");
		await rm(bad, { recursive: true, force: true });
	});

	it("discoverClineSessions strips error channel", async () => {
		expect(Array.isArray(await discoverClineSessions(project))).toBe(true);
	});

	it("skips sessions older than 48h, and entries lacking a numeric ts", async () => {
		const now = Date.now();
		const oldTs = now - 49 * 60 * 60 * 1000; // 49 hours ago
		const recentTs = now - 24 * 60 * 60 * 1000; // 24 hours ago
		await writeHistory(sd, [
			{ id: "t1", ts: oldTs, task: "old", cwdOnTaskInitialization: project },
			{ id: "t2", ts: recentTs, task: "recent", cwdOnTaskInitialization: project },
			{ id: "t3", task: "no-ts", cwdOnTaskInitialization: project }, // missing ts → treated as stale
		]);
		const r = await scanClineSessions(project, [sd]);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["t2"]);
	});

	it("reports a fs-kind error (not parse) when the history path is unreadable", async () => {
		// Make taskHistory.json a directory so readFile fails with EISDIR on every
		// platform — a filesystem error, not a JSON SyntaxError. (Making `state` a
		// file instead yields ENOTDIR on POSIX but ENOENT on Windows, and ENOENT is
		// treated as "no history" — so that shape can't assert an fs error
		// cross-platform.)
		await mkdir(join(sd, "state", "taskHistory.json"), { recursive: true });
		const r = await scanClineSessions(project, [sd]);
		expect(r.sessions).toEqual([]);
		expect(r.error?.kind).toBe("fs");
	});
});
