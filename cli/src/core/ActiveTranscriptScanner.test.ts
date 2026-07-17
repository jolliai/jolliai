import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanActiveTranscripts } from "./ActiveTranscriptScanner.js";

const REPO = "/tmp/fake-repo";
const OTHER = "/tmp/other-repo";

interface LineOpts {
	session: string;
	cwd?: string;
	branch?: string;
	ts?: string;
	role?: "user" | "assistant";
	text?: string;
	tool?: string;
}

function line(o: LineOpts): string {
	const message =
		o.role === "assistant"
			? {
					role: "assistant",
					content: [
						{
							type: o.tool ? "tool_use" : "text",
							...(o.tool ? { name: o.tool, input: {} } : { text: o.text ?? "" }),
						},
					],
				}
			: { role: "user", content: o.text ?? "" };
	return JSON.stringify({
		sessionId: o.session,
		cwd: o.cwd ?? REPO,
		...(o.branch ? { gitBranch: o.branch } : {}),
		...(o.ts ? { timestamp: o.ts } : {}),
		message,
	});
}

describe("scanActiveTranscripts", () => {
	let projectsRoot: string;
	beforeEach(() => {
		projectsRoot = mkdtempSync(join(tmpdir(), "ats-"));
	});
	afterEach(() => rmSync(projectsRoot, { recursive: true, force: true }));

	function writeProject(dir: string, lines: string[]): void {
		const p = join(projectsRoot, dir);
		mkdirSync(p, { recursive: true });
		writeFileSync(join(p, `${dir}.jsonl`), lines.join("\n"));
	}

	it("projects a conversational session with metadata", async () => {
		writeProject("proj", [
			line({ session: "s1", branch: "main", ts: "2026-01-01T00:00:00Z", role: "user", text: "hi" }),
			line({ session: "s1", branch: "main", ts: "2026-01-01T00:01:00Z", role: "assistant", text: "hello" }),
			line({ session: "s1", branch: "feature/x", ts: "2026-01-01T00:02:00Z", role: "user", text: "more" }),
		]);
		const { sessions } = await scanActiveTranscripts([REPO], { projectsRoot });
		expect(sessions).toHaveLength(1);
		const s = sessions[0];
		expect(s.sessionId).toBe("s1");
		expect(s.source).toBe("claude");
		expect(s.gitBranch).toBe("feature/x"); // most-recent non-empty branch wins
		expect(s.firstActivity).toBe("2026-01-01T00:00:00Z");
		expect(s.lastActivity).toBe("2026-01-01T00:02:00Z");
		expect(s.entries.map((e) => e.role)).toEqual(["human", "assistant", "human"]);
		expect(s.humanTurns).toBe(2);
		expect(s.transcriptPath.endsWith(".jsonl")).toBe(true);
	});

	it("drops a session with only tool activity (no conversation)", async () => {
		writeProject("proj", [
			line({ session: "toolsonly", ts: "2026-01-01T00:00:00Z", role: "assistant", tool: "Read" }),
		]);
		const { sessions } = await scanActiveTranscripts([REPO], { projectsRoot });
		expect(sessions).toHaveLength(0);
	});

	it("scopes to the requested repo via cwd", async () => {
		writeProject("proj", [
			line({ session: "mine", cwd: REPO, ts: "2026-01-01T00:00:00Z", role: "user", text: "a" }),
			line({ session: "theirs", cwd: OTHER, ts: "2026-01-01T00:00:00Z", role: "user", text: "b" }),
		]);
		const { sessions } = await scanActiveTranscripts([REPO], { projectsRoot });
		expect(sessions.map((s) => s.sessionId)).toEqual(["mine"]);
	});

	it("sorts newest-active first and applies sinceMs relative to the newest session", async () => {
		writeProject("proj", [
			line({ session: "old", ts: "2026-01-01T00:00:00Z", role: "user", text: "old" }),
			line({ session: "recent", ts: "2026-01-10T00:00:00Z", role: "user", text: "recent" }),
		]);
		const all = await scanActiveTranscripts([REPO], { projectsRoot });
		expect(all.sessions.map((s) => s.sessionId)).toEqual(["recent", "old"]); // newest first

		// 2-day window off the newest (Jan 10) excludes the Jan 1 session.
		const windowed = await scanActiveTranscripts([REPO], { projectsRoot, sinceMs: 2 * 24 * 60 * 60 * 1000 });
		expect(windowed.sessions.map((s) => s.sessionId)).toEqual(["recent"]);
	});

	it("respects limit", async () => {
		writeProject("proj", [
			line({ session: "a", ts: "2026-01-01T00:00:00Z", role: "user", text: "a" }),
			line({ session: "b", ts: "2026-01-02T00:00:00Z", role: "user", text: "b" }),
			line({ session: "c", ts: "2026-01-03T00:00:00Z", role: "user", text: "c" }),
		]);
		const { sessions } = await scanActiveTranscripts([REPO], { projectsRoot, limit: 2 });
		expect(sessions.map((s) => s.sessionId)).toEqual(["c", "b"]);
	});

	it("empty repoRoots short-circuits", async () => {
		expect(await scanActiveTranscripts([], { projectsRoot })).toEqual({ sessions: [] });
	});

	it("dirFilter skips unmatched project dirs without changing results", async () => {
		// The repo's own dir plus an unrelated one whose transcript would be an
		// expensive parse. The filter accepts only the repo dir, but the result is
		// identical to an unfiltered scan because the cwd predicate already scopes.
		writeProject("repo-dir", [line({ session: "s1", ts: "2026-01-01T00:00:00Z", role: "user", text: "hi" })]);
		writeProject("unrelated-dir", [
			line({ session: "s2", cwd: OTHER, ts: "2026-01-02T00:00:00Z", role: "user", text: "other" }),
		]);

		const accepted: string[] = [];
		const { sessions } = await scanActiveTranscripts([REPO], {
			projectsRoot,
			dirFilter: (name) => {
				accepted.push(name);
				return name === "repo-dir";
			},
		});
		expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);
		// Both dirs were offered to the filter; only the accepted one was read.
		expect(accepted.sort()).toEqual(["repo-dir", "unrelated-dir"]);
	});

	it("omitting dirFilter keeps the whole-tree scan (regression guard)", async () => {
		writeProject("repo-dir", [line({ session: "s1", ts: "2026-01-01T00:00:00Z", role: "user", text: "hi" })]);
		const { sessions } = await scanActiveTranscripts([REPO], { projectsRoot });
		expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);
	});
});
