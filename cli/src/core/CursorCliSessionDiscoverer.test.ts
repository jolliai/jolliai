import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURSOR_CLI_META_JSON, CURSOR_CLI_TRANSCRIPT_JSONL } from "../testUtils/cursorCliFixture.js";
import {
	discoverCursorCliSessions,
	isCursorCliInstalled,
	scanCursorCliSessions,
} from "./CursorCliSessionDiscoverer.js";

// hash dir name is md5(cwd) on a real install, but scan never recomputes it — it
// reads meta.json.cwd — so tests use arbitrary hash dir names on purpose.
async function writeChat(chatsDir: string, hash: string, uuid: string, meta: object): Promise<void> {
	const dir = join(chatsDir, hash, uuid);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "meta.json"), JSON.stringify(meta), "utf8");
}
async function writeTranscript(projectsDir: string, enc: string, uuid: string, jsonl: string): Promise<void> {
	const dir = join(projectsDir, enc, "agent-transcripts", uuid);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${uuid}.jsonl`), jsonl, "utf8");
}

describe("scanCursorCliSessions", () => {
	let chatsDir: string;
	let projectsDir: string;
	const project = "/Users/x/proj-a";
	const now = Date.now();
	beforeEach(async () => {
		const base = await mkdtemp(join(tmpdir(), "cursor-cli-disc-"));
		chatsDir = join(base, "chats");
		projectsDir = join(base, "projects");
		await mkdir(chatsDir, { recursive: true });
		await mkdir(projectsDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(join(chatsDir, ".."), { recursive: true, force: true });
	});

	it("returns empty (no error) when chats dir absent", async () => {
		const r = await scanCursorCliSessions(project, join(chatsDir, "nope"), projectsDir);
		expect(r).toEqual({ sessions: [] });
	});

	it("attributes by meta.cwd, sets source/title/updatedAt, resolves JSONL by uuid", async () => {
		await writeChat(chatsDir, "h1", "u1", { cwd: project, updatedAtMs: now, title: "Hello There" });
		const jsonl1 = '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n';
		await writeTranscript(projectsDir, "Users-x-proj-a", "u1", jsonl1);
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(1);
		expect(r.sessions[0]).toMatchObject({ sessionId: "u1", source: "cursor-cli", title: "Hello There" });
		expect(r.sessions[0].transcriptPath).toContain("u1.jsonl");
		expect(r.sessions[0].updatedAt).toBe(new Date(now).toISOString());
	});

	it("parses a real pinned cursor-agent meta.json + JSONL fixture end to end", async () => {
		const uuid = "6f2a9c3e-6b3c-4e7a-9b8a-1a2b3c4d5e6f";
		const fixtureProject = "/Users/example/proj"; // must match CURSOR_CLI_META_JSON.cwd verbatim
		const dir = join(chatsDir, "real-hash", uuid);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "meta.json"), CURSOR_CLI_META_JSON, "utf8");
		await writeTranscript(projectsDir, "example-proj", uuid, CURSOR_CLI_TRANSCRIPT_JSONL);

		const r = await scanCursorCliSessions(fixtureProject, chatsDir, projectsDir);

		expect(r.sessions).toHaveLength(1);
		expect(r.sessions[0]).toMatchObject({
			sessionId: uuid,
			title: "Hello There",
			updatedAt: new Date(1784631456880).toISOString(),
			source: "cursor-cli",
		});
	});

	it("does NOT attribute a session run from a repo subdirectory (exact-equality contract, like Devin)", async () => {
		await writeChat(chatsDir, "h2", "u2", { cwd: `${project}/vscode`, updatedAtMs: now });
		const jsonl2 = '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n';
		await writeTranscript(projectsDir, "Users-x-proj-a", "u2", jsonl2);
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(0);
	});

	it("skips stale sessions (updatedAtMs older than 48h)", async () => {
		await writeChat(chatsDir, "h3", "u3", { cwd: project, updatedAtMs: now - 49 * 60 * 60 * 1000 });
		await writeTranscript(projectsDir, "e", "u3", "{}\n");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(0);
	});

	it("falls back to createdAtMs when updatedAtMs missing; skips non-finite timestamp", async () => {
		await writeChat(chatsDir, "h4", "u4", { cwd: project, createdAtMs: now });
		await writeTranscript(projectsDir, "e", "u4", "{}\n");
		await writeChat(chatsDir, "h5", "u5", { cwd: project });
		await writeTranscript(projectsDir, "e", "u5", "{}\n");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["u4"]);
	});

	it("skips a matching chat whose transcript JSONL is absent", async () => {
		await writeChat(chatsDir, "h6", "u6", { cwd: project, updatedAtMs: now });
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(0);
	});

	it("skips a corrupt meta.json without sinking the scan", async () => {
		await writeChat(chatsDir, "h7", "u7", { cwd: project, updatedAtMs: now });
		await writeTranscript(projectsDir, "e", "u7", "{}\n");
		const bad = join(chatsDir, "h8", "u8");
		await mkdir(bad, { recursive: true });
		await writeFile(join(bad, "meta.json"), "{ not json", "utf8");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["u7"]);
	});

	it("returns a filesystem error when chats path is a file, not a dir", async () => {
		const filePath = join(projectsDir, "not-a-dir");
		await writeFile(filePath, "x", "utf8");
		const r = await scanCursorCliSessions(project, filePath, projectsDir);
		expect(r.error?.kind).toBe("fs");
	});

	it("discoverCursorCliSessions strips the error channel", async () => {
		// scanCursorCliSessions surfaces a real fs error when the chats path is a file, not a
		// dir (exercised deterministically here via the injectable chatsDir/projectsDir params).
		const filePath = join(projectsDir, "nd2");
		await writeFile(filePath, "x", "utf8");
		const scanned = await scanCursorCliSessions(project, filePath, projectsDir);
		expect(scanned.error?.kind).toBe("fs");

		// discoverCursorCliSessions (the QueueWorker wrapper) takes no dir-override params, so
		// it can't be pointed at `filePath` — it always resolves against the real machine's
		// ~/.cursor/chats. What we CAN assert deterministically is its documented contract: for
		// a project with no matching sessions it resolves to the plain (error-stripped) array.
		const sessions = await discoverCursorCliSessions("/nope-does-not-exist");
		expect(sessions).toEqual([]);
	});

	it("isCursorCliInstalled is false when chats dir missing", async () => {
		expect(await isCursorCliInstalled(join(chatsDir, "no-home"))).toBe(false);
	});

	it("treats a MISSING projects dir (ENOENT) as benign — empty, no error", async () => {
		await writeChat(chatsDir, "h9", "u9", { cwd: project, updatedAtMs: now });
		const r = await scanCursorCliSessions(project, chatsDir, join(projectsDir, "does-not-exist"));
		expect(r.sessions).toHaveLength(0);
		expect(r.error).toBeUndefined();
	});

	it("surfaces a whole-source fs error when the projects path is a non-ENOENT readdir failure", async () => {
		// A file where projects/ is expected (ENOTDIR) stands in for the real
		// whole-source failures — EACCES on projects/, or cursor-agent renaming it.
		// Must NOT be downgraded to a silent "0 sessions": the aggregator's
		// failedSources set and the status "Cursor" row rely on r.error to flag it.
		await writeChat(chatsDir, "h9b", "u9b", { cwd: project, updatedAtMs: now });
		const projFile = join(chatsDir, "..", "projects-as-file");
		await writeFile(projFile, "x", "utf8");
		const r = await scanCursorCliSessions(project, chatsDir, projFile);
		expect(r.error?.kind).toBe("fs");
		expect(r.sessions).toHaveLength(0);
	});

	it("skips a stray file sitting directly under chats/ (not a hash directory)", async () => {
		await writeChat(chatsDir, "h10", "u10", { cwd: project, updatedAtMs: now });
		await writeTranscript(projectsDir, "e", "u10", "{}\n");
		await writeFile(join(chatsDir, "stray-file"), "x", "utf8");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["u10"]);
	});

	it("keeps looking when a project bucket's candidate path is a directory, not a file", async () => {
		await writeChat(chatsDir, "h11", "u11", { cwd: project, updatedAtMs: now });
		// wrong bucket: same uuid segment exists but as a directory, not the jsonl file
		await mkdir(join(projectsDir, "wrong-bucket", "agent-transcripts", "u11", "u11.jsonl"), { recursive: true });
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(0);
	});

	it("reuses the resolved bucket for later sessions in the same repo (preferred-bucket hit)", async () => {
		await writeChat(chatsDir, "ha", "ua", { cwd: project, updatedAtMs: now });
		await writeChat(chatsDir, "hb", "ub", { cwd: project, updatedAtMs: now });
		// both sessions of one repo live in the SAME projects bucket: whichever is scanned
		// first pins it as preferred, the second resolves straight from the preferred bucket.
		await writeTranscript(projectsDir, "Users-x-proj-a", "ua", "{}\n");
		await writeTranscript(projectsDir, "Users-x-proj-a", "ub", "{}\n");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions.map((s) => s.sessionId).sort()).toEqual(["ua", "ub"]);
	});

	it("falls back to a full scan when a later session lives in a different bucket (preferred-bucket miss)", async () => {
		await writeChat(chatsDir, "hc", "uc", { cwd: project, updatedAtMs: now });
		await writeChat(chatsDir, "hd", "ud", { cwd: project, updatedAtMs: now });
		// same repo but transcripts split across two buckets: the first-scanned session pins its
		// bucket as preferred, the other misses that bucket and falls through the full loop.
		await writeTranscript(projectsDir, "bucket-one", "uc", "{}\n");
		await writeTranscript(projectsDir, "bucket-two", "ud", "{}\n");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions.map((s) => s.sessionId).sort()).toEqual(["uc", "ud"]);
	});
});
