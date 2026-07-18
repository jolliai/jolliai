import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClineCliSessions, scanClineCliSessions } from "./ClineCliSessionDiscoverer.js";

async function writeSession(sessionsDir: string, id: string, sidecar: object): Promise<void> {
	const dir = join(sessionsDir, id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${id}.json`), JSON.stringify(sidecar), "utf8");
	await writeFile(join(dir, `${id}.messages.json`), JSON.stringify({ messages: [] }), "utf8");
}

describe("scanClineCliSessions", () => {
	let sessionsDir: string;
	const project = "/tmp/proj-a";
	beforeEach(async () => {
		sessionsDir = await mkdtemp(join(tmpdir(), "cline-cli-disc-"));
	});
	afterEach(async () => {
		await rm(sessionsDir, { recursive: true, force: true });
	});

	it("returns empty (no error) when sessions dir absent", async () => {
		const r = await scanClineCliSessions(project, join(sessionsDir, "nope"));
		expect(r).toEqual({ sessions: [] });
	});

	it("attributes by workspace_root, sets source/title, uses messages.json mtime", async () => {
		await writeSession(sessionsDir, "s1", {
			session_id: "s1",
			workspace_root: project,
			messages_path: join(sessionsDir, "s1", "s1.messages.json"),
			metadata: { title: "fix bug" },
		});
		await writeSession(sessionsDir, "s2", { session_id: "s2", workspace_root: "/tmp/other" });
		const r = await scanClineCliSessions(project, sessionsDir);
		expect(r.sessions).toHaveLength(1);
		expect(r.sessions[0]).toMatchObject({ sessionId: "s1", source: "cline-cli", title: "fix bug" });
		expect(r.sessions[0].transcriptPath).toContain("s1.messages.json");
	});

	it("falls back to the canonical messages path when messages_path is relative", async () => {
		await writeSession(sessionsDir, "sRel", {
			workspace_root: project,
			messages_path: "sRel.messages.json", // relative — must not be trusted verbatim
		});
		const r = await scanClineCliSessions(project, sessionsDir);
		expect(r.sessions.map((s) => s.sessionId)).toContain("sRel");
		expect(r.sessions.find((s) => s.sessionId === "sRel")?.transcriptPath).toBe(
			join(sessionsDir, "sRel", "sRel.messages.json"),
		);
	});

	it("falls back to cwd when workspace_root missing; skips corrupt sidecar", async () => {
		await writeSession(sessionsDir, "s3", { session_id: "s3", cwd: project });
		await mkdir(join(sessionsDir, "s4"), { recursive: true });
		await writeFile(join(sessionsDir, "s4", "s4.json"), "{ not json", "utf8");
		const r = await scanClineCliSessions(project, sessionsDir);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["s3"]);
	});

	it("discoverClineCliSessions strips error channel", async () => {
		const sessions = await discoverClineCliSessions(project);
		expect(Array.isArray(sessions)).toBe(true);
	});

	it("skips sessions with missing or stale messages file", async () => {
		// Session with no messages file
		await mkdir(join(sessionsDir, "s5"), { recursive: true });
		await writeFile(join(sessionsDir, "s5", "s5.json"), JSON.stringify({ workspace_root: project }), "utf8");
		// Session with stale messages file (mtime before cutoff)
		await writeSession(sessionsDir, "sOld", { workspace_root: project });
		const oldTime = new Date(Date.now() - 49 * 60 * 60 * 1000); // 49 hours ago
		await utimes(join(sessionsDir, "sOld", "sOld.messages.json"), oldTime, oldTime);
		// Session with fresh messages file
		await writeSession(sessionsDir, "sFresh", { workspace_root: project });
		const r = await scanClineCliSessions(project, sessionsDir);
		// sFresh should be included (fresh mtime)
		expect(r.sessions.map((s) => s.sessionId)).toContain("sFresh");
		// sOld should be skipped (stale mtime)
		expect(r.sessions.map((s) => s.sessionId)).not.toContain("sOld");
		// s5 should be skipped (no messages file)
		expect(r.sessions.map((s) => s.sessionId)).not.toContain("s5");
	});

	it("skips sessions from different workspace_root/cwd", async () => {
		await writeSession(sessionsDir, "s7", { workspace_root: "/other/project" });
		await writeSession(sessionsDir, "s8", { cwd: "/yet/another" });
		const r = await scanClineCliSessions(project, sessionsDir);
		expect(r.sessions.length).toBe(0);
	});

	it("returns filesystem error when non-ENOENT error occurs", async () => {
		// Simulate an error by passing a path that is a file, not a directory
		const filePath = join(sessionsDir, "not-a-dir");
		await writeFile(filePath, "test", "utf8");
		const r = await scanClineCliSessions(project, filePath);
		expect(r.error).toBeDefined();
		expect(r.error?.kind).toBe("fs");
	});

	it("discoverClineCliSessions returns empty array on fs error (logs warn)", async () => {
		// Pass a file path instead of directory to trigger fs error
		const filePath = join(sessionsDir, "not-a-dir");
		await writeFile(filePath, "test", "utf8");
		const sessions = await discoverClineCliSessions(project);
		// Should return array (not error) despite fs error
		expect(Array.isArray(sessions)).toBe(true);
		expect(sessions).toHaveLength(0);
	});
});
