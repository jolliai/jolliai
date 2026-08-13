import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLAUDE_DISK_SCAN_WINDOW_MS,
	claudeProjectsRoot,
	claudeSessionsForRepo,
	scanClaudeSessionsOnDisk,
} from "./ClaudeSessionDiscoverer.js";

beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

let projectsRoot: string;
/** Fixed "now" so window assertions do not depend on wall-clock drift. */
const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const now = () => NOW;

beforeEach(async () => {
	projectsRoot = await mkdtemp(join(tmpdir(), "claude-projects-"));
});

afterEach(async () => {
	await rm(projectsRoot, { recursive: true, force: true });
});

const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

/** A conversation turn line — what the scan looks for. */
const turn = (cwd: string, at: string, role = "user"): string =>
	JSON.stringify({ type: role, cwd, timestamp: at, message: { role, content: "hi" } });

/** A line the scan must NOT treat as a turn: no `message.role`. */
const nonTurn = (cwd: string | undefined, at: string): string =>
	JSON.stringify({ type: "queue-operation", ...(cwd ? { cwd } : {}), timestamp: at, operation: "enqueue" });

async function writeTranscript(dir: string, sessionId: string, lines: ReadonlyArray<string>): Promise<string> {
	const dirPath = join(projectsRoot, dir);
	await mkdir(dirPath, { recursive: true });
	const filePath = join(dirPath, `${sessionId}.jsonl`);
	await writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
	return filePath;
}

/** Enough non-turn filler to push a byte offset past `bytes`. */
function filler(cwd: string, at: string, bytes: number): string[] {
	const one = nonTurn(cwd, at);
	return new Array(Math.ceil(bytes / (one.length + 1))).fill(one);
}

describe("scanClaudeSessionsOnDisk", () => {
	it("reads a small transcript whole and reports its last turn", async () => {
		await writeTranscript("-repo", "s1", [
			nonTurn(undefined, hoursAgo(5)),
			turn("/w/repo", hoursAgo(4)),
			turn("/w/repo", hoursAgo(3)),
			nonTurn("/w/repo", hoursAgo(1)),
		]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found).toHaveLength(1);
		// The LAST turn, not the last line — the trailing non-turn must not win.
		expect(found[0].updatedAt).toBe(hoursAgo(3));
		expect(found[0].sessionId).toBe("s1");
		expect(found[0].dirs).toEqual(["/w/repo"]);
	});

	it("takes the session id from the filename", async () => {
		await writeTranscript("-repo", "0d8ec8ca-792d-4385-b1a7-0e8b160c2ff3", [turn("/w/repo", hoursAgo(1))]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found[0].sessionId).toBe("0d8ec8ca-792d-4385-b1a7-0e8b160c2ff3");
	});

	it("finds the last turn in a large transcript via the tail read", async () => {
		await writeTranscript("-repo", "big", [
			turn("/w/repo", hoursAgo(9)),
			...filler("/w/repo", hoursAgo(8), 200 * 1024),
			turn("/w/repo", hoursAgo(2)),
			...filler("/w/repo", hoursAgo(1), 4 * 1024),
		]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found).toHaveLength(1);
		expect(found[0].updatedAt).toBe(hoursAgo(2));
	});

	it("escalates the tail window when the first slice holds no turn", async () => {
		// The only turn sits behind ~300 KB of filler, so the first 64 KB tail slice
		// cannot see it. Without escalation this session would be dropped entirely.
		await writeTranscript("-repo", "escalate", [
			...filler("/w/repo", hoursAgo(9), 32 * 1024),
			turn("/w/repo", hoursAgo(6)),
			...filler("/w/repo", hoursAgo(5), 300 * 1024),
		]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found).toHaveLength(1);
		expect(found[0].updatedAt).toBe(hoursAgo(6));
	});

	it("excludes a transcript that holds no conversation turn at all", async () => {
		await writeTranscript("-repo", "meta-only", [
			nonTurn("/w/repo", hoursAgo(2)),
			JSON.stringify({ type: "ai-title", aiTitle: "x", sessionId: "meta-only" }),
			JSON.stringify({ type: "summary", lastPrompt: "x", leafUuid: "y", sessionId: "meta-only" }),
		]);

		await expect(scanClaudeSessionsOnDisk({ projectsRoot, now })).resolves.toEqual([]);
	});

	it("excludes a large transcript with no turn even after reading the whole file", async () => {
		await writeTranscript("-repo", "big-meta-only", [...filler("/w/repo", hoursAgo(3), 300 * 1024)]);

		await expect(scanClaudeSessionsOnDisk({ projectsRoot, now })).resolves.toEqual([]);
	});

	it("excludes an empty file", async () => {
		const dirPath = join(projectsRoot, "-repo");
		await mkdir(dirPath, { recursive: true });
		await writeFile(join(dirPath, "empty.jsonl"), "", "utf-8");

		await expect(scanClaudeSessionsOnDisk({ projectsRoot, now })).resolves.toEqual([]);
	});

	it("keeps a session just inside the window and drops one just outside", async () => {
		const insideH = CLAUDE_DISK_SCAN_WINDOW_MS / 3_600_000 - 1;
		const outsideH = CLAUDE_DISK_SCAN_WINDOW_MS / 3_600_000 + 1;
		await writeTranscript("-a", "inside", [turn("/w/repo", hoursAgo(insideH))]);
		await writeTranscript("-b", "outside", [turn("/w/repo", hoursAgo(outsideH))]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found.map((s) => s.sessionId)).toEqual(["inside"]);
	});

	it("admits a session the 48 h window would have dropped", async () => {
		await writeTranscript("-repo", "three-days", [turn("/w/repo", hoursAgo(72))]);

		const narrow = await scanClaudeSessionsOnDisk({ projectsRoot, now, windowMs: 48 * 3_600_000 });
		const wide = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(narrow).toEqual([]);
		expect(wide.map((s) => s.sessionId)).toEqual(["three-days"]);
	});

	it("drops a turn whose timestamp cannot be parsed", async () => {
		await writeTranscript("-repo", "bad-ts", [
			JSON.stringify({ type: "user", cwd: "/w/repo", timestamp: "not-a-date", message: { role: "user" } }),
		]);

		await expect(scanClaudeSessionsOnDisk({ projectsRoot, now })).resolves.toEqual([]);
	});

	it("collects every distinct working directory, in first-seen order", async () => {
		await writeTranscript("-repo", "multi", [
			turn("/w/repo", hoursAgo(5)),
			turn("/w/repo/cli", hoursAgo(4)),
			turn("/w/other", hoursAgo(3)),
			turn("/w/repo", hoursAgo(2)),
		]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found[0].dirs).toEqual(["/w/repo", "/w/repo/cli", "/w/other"]);
	});

	it("ignores malformed lines and non-jsonl files rather than failing the scan", async () => {
		const dirPath = join(projectsRoot, "-repo");
		await mkdir(dirPath, { recursive: true });
		await writeFile(join(dirPath, "notes.txt"), "not a transcript", "utf-8");
		await writeTranscript("-repo", "s1", ["{ this is not json", turn("/w/repo", hoursAgo(1)), "}{"]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found.map((s) => s.sessionId)).toEqual(["s1"]);
	});

	it("keeps scanning when one transcript is unreadable", async () => {
		await writeTranscript("-a", "good", [turn("/w/repo", hoursAgo(1))]);
		// A directory named like a transcript: opening it as a file fails.
		await mkdir(join(projectsRoot, "-b", "broken.jsonl"), { recursive: true });

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found.map((s) => s.sessionId)).toEqual(["good"]);
	});

	it("returns nothing when the projects root does not exist", async () => {
		await expect(scanClaudeSessionsOnDisk({ projectsRoot: join(projectsRoot, "nope"), now })).resolves.toEqual([]);
	});

	it("returns nothing — but REPORTS it — when the root cannot be listed at all", async () => {
		// A missing tree is a machine without Claude installed and stays silent. A root
		// that exists and still cannot be listed is a real fault (here ENOTDIR, in the
		// field a permission problem), and the two must not degrade the same way: both
		// answer empty, only one says so.
		const notADirectory = join(projectsRoot, "a-file");
		await writeFile(notADirectory, "x", "utf-8");

		await expect(scanClaudeSessionsOnDisk({ projectsRoot: notADirectory, now })).resolves.toEqual([]);
	});

	it("defaults to the real projects root when none is injected", async () => {
		// The default every production caller takes. Asserted with a `now` far in the
		// FUTURE, which makes the result empty whatever that machine's tree holds: every
		// real transcript is then outside the window, and a machine without Claude
		// installed has no tree to walk in the first place. So this pins the default
		// without depending on the host — the one thing a test of a home-directory
		// default must not do.
		const farFuture = () => Date.parse("2099-01-01T00:00:00.000Z");

		await expect(scanClaudeSessionsOnDisk({ now: farFuture })).resolves.toEqual([]);
	});

	it("uses the real clock when no `now` is injected", async () => {
		// The default every production caller takes. A fixture written at the current
		// instant is inside the window on any clock, so this pins the default without
		// depending on wall-clock drift.
		await writeTranscript("-repo", "sNow", [turn("/w/repo", new Date().toISOString())]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot });

		expect(found.map((s) => s.sessionId)).toEqual(["sNow"]);
	});

	it("skips entries under the root that are not directories", async () => {
		await writeFile(join(projectsRoot, "stray-file"), "x", "utf-8");
		await writeTranscript("-repo", "s1", [turn("/w/repo", hoursAgo(1))]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found.map((s) => s.sessionId)).toEqual(["s1"]);
	});

	it("scans every project directory, not just the first", async () => {
		await writeTranscript("-one", "s1", [turn("/w/one", hoursAgo(1))]);
		await writeTranscript("-two", "s2", [turn("/w/two", hoursAgo(1))]);
		await writeTranscript("-three", "s3", [turn("/w/three", hoursAgo(1))]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found.map((s) => s.sessionId).sort()).toEqual(["s1", "s2", "s3"]);
	});

	it("keeps NO transcript content, however much it just parsed", async () => {
		// The scan reads the whole file to collect the directories a `cd` scattered
		// through it, and used to hand that parse to the collector so the transcript was
		// opened once per run. It no longer does: a run held every in-window transcript
		// resident at the same time, with nothing capping the total. The read is paid
		// again where it is needed instead — see `acceptFacts`.
		await writeTranscript("-repo", "rich", [
			JSON.stringify({ type: "ai-title", aiTitle: "The session title", sessionId: "rich" }),
			turn("/w/repo", hoursAgo(5)),
			turn("/w/repo", hoursAgo(4), "assistant"),
			turn("/w/repo", hoursAgo(3)),
		]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now });

		expect(found[0].complete).toBe(true);
		// The scanned record is the session's identity plus its directory evidence, and
		// nothing that scales with the transcript's size.
		expect(Object.keys(found[0]).sort()).toEqual(["complete", "dirs", "sessionId", "transcriptPath", "updatedAt"]);
	});

	it("honours a concurrency of 1", async () => {
		await writeTranscript("-a", "s1", [turn("/w/repo", hoursAgo(1))]);
		await writeTranscript("-b", "s2", [turn("/w/repo", hoursAgo(1))]);

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now, concurrency: 1 });

		expect(found.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
	});
});

describe("scanClaudeSessionsOnDisk — the already-recorded skip", () => {
	/**
	 * A transcript whose EARLY directory is visible only to a whole-file read: the
	 * first turn is in `/w/early`, then ~200 KB of filler, then the last turn in
	 * `/w/late`. A full read reports both; the tail read reports only `/w/late`.
	 */
	async function twoDirTranscript(sessionId = "skippable"): Promise<void> {
		await writeTranscript("-repo", sessionId, [
			turn("/w/early", hoursAgo(9)),
			...filler("/w/late", hoursAgo(8), 200 * 1024),
			turn("/w/late", hoursAgo(2)),
		]);
	}

	it("reads the whole file when nothing is recorded, reporting every directory", async () => {
		await twoDirTranscript();

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now, alreadyRecorded: () => false });

		expect(found[0].dirs).toEqual(["/w/early", "/w/late"]);
		expect(found[0].complete).toBe(true);
	});

	it("skips the whole-file read and falls back to the tail's own directories", async () => {
		// The saving this exists for: the session is still reported (so the run's count
		// of discovered conversations does not shrink on a converged pass) but the
		// expensive read never happens. `/w/early` is the accepted loss — it can only
		// matter to a repo that already holds this session at this instant.
		await twoDirTranscript();

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now, alreadyRecorded: () => true });

		expect(found).toHaveLength(1);
		expect(found[0].updatedAt).toBe(hoursAgo(2));
		expect(found[0].dirs).toEqual(["/w/late"]);
		expect(found[0].complete).toBe(false);
	});

	it("asks with the session id and the instant the tail found", async () => {
		await twoDirTranscript("abc123");
		const asked: Array<[string, string, number]> = [];

		await scanClaudeSessionsOnDisk({
			projectsRoot,
			now,
			alreadyRecorded: (source, sessionId, updatedAtMs) => {
				asked.push([source, sessionId, updatedAtMs]);
				return false;
			},
		});

		expect(asked).toEqual([["claude", "abc123", Date.parse(hoursAgo(2))]]);
	});

	it("does not ask about a transcript small enough to be read whole anyway", async () => {
		// Below the whole-file threshold the read the skip would avoid has already
		// happened, so asking could only cost a round trip and lose directories.
		await writeTranscript("-repo", "small", [turn("/w/early", hoursAgo(5)), turn("/w/late", hoursAgo(2))]);
		let asked = 0;

		const found = await scanClaudeSessionsOnDisk({
			projectsRoot,
			now,
			alreadyRecorded: () => {
				asked++;
				return true;
			},
		});

		expect(asked).toBe(0);
		expect(found[0].dirs).toEqual(["/w/early", "/w/late"]);
		expect(found[0].complete).toBe(true);
	});

	it("labels the cheap path's directory set as incomplete", async () => {
		// The tail is not the conversation, so `dirs` may be missing a directory the
		// session left earlier. `complete: false` is the honest label on that, and it is
		// the only thing distinguishing the two paths' output now that neither carries
		// any transcript content.
		await twoDirTranscript();

		const found = await scanClaudeSessionsOnDisk({ projectsRoot, now, alreadyRecorded: () => true });

		expect(found[0].complete).toBe(false);
	});

	it("does not ask about a transcript outside the window", async () => {
		// The window check comes first: a stale transcript is dropped either way, and
		// asking about one would report it as discovered when it is not.
		await writeTranscript("-repo", "stale", [
			turn("/w/repo", hoursAgo(400)),
			...filler("/w/repo", hoursAgo(400), 200 * 1024),
			turn("/w/repo", hoursAgo(400)),
		]);
		let asked = 0;

		const found = await scanClaudeSessionsOnDisk({
			projectsRoot,
			now,
			alreadyRecorded: () => {
				asked++;
				return true;
			},
		});

		expect(asked).toBe(0);
		expect(found).toEqual([]);
	});
});

describe("claudeProjectsRoot", () => {
	it("points at the Claude transcript tree under the home directory", () => {
		expect(claudeProjectsRoot().endsWith(join(".claude", "projects"))).toBe(true);
	});
});

describe("claudeSessionsForRepo", () => {
	let repoRoot: string;

	beforeEach(async () => {
		repoRoot = await mkdtemp(join(tmpdir(), "claude-repo-"));
	});

	afterEach(async () => {
		await rm(repoRoot, { recursive: true, force: true });
	});

	// `complete: true` throughout: narrowing does not read the flag, and the honest
	// default for a hand-built fixture is the whole-file read every non-skipped
	// transcript actually gets.
	const scanned = (dirs: ReadonlyArray<string>, sessionId = "s1") => [
		{ sessionId, transcriptPath: `/t/${sessionId}.jsonl`, updatedAt: hoursAgo(1), dirs, complete: true },
	];

	it("claims a session whose working directory is the repo root", () => {
		const mine = claudeSessionsForRepo(scanned([repoRoot]), repoRoot);

		expect(mine).toHaveLength(1);
		expect(mine[0].source).toBe("claude");
		expect(mine[0].sessionId).toBe("s1");
	});

	it("claims a session started in a subdirectory of the repo", () => {
		const mine = claudeSessionsForRepo(scanned([join(repoRoot, "cli", "src")]), repoRoot);

		expect(mine).toHaveLength(1);
	});

	it("does NOT claim a sibling directory that merely shares the repo's name prefix", () => {
		// `<repo>-figma-mcp` is a prefix match on the raw string but a different repo.
		// A naive `startsWith` would claim it; `sessionDirBelongsToRepo` must not.
		const mine = claudeSessionsForRepo(scanned([`${repoRoot}-figma-mcp`]), repoRoot);

		expect(mine).toEqual([]);
	});

	it("does not claim an unrelated directory", () => {
		const mine = claudeSessionsForRepo(scanned(["/somewhere/else"]), repoRoot);

		expect(mine).toEqual([]);
	});

	it("claims a session when ANY of its directories matches", () => {
		const mine = claudeSessionsForRepo(scanned(["/unrelated", join(repoRoot, "cli"), "/also-unrelated"]), repoRoot);

		expect(mine).toHaveLength(1);
	});

	it("filters rather than partitions — two repos may each claim the same session", async () => {
		const otherRoot = await mkdtemp(join(tmpdir(), "claude-repo2-"));
		try {
			const session = scanned([repoRoot, otherRoot]);

			expect(claudeSessionsForRepo(session, repoRoot)).toHaveLength(1);
			expect(claudeSessionsForRepo(session, otherRoot)).toHaveLength(1);
		} finally {
			await rm(otherRoot, { recursive: true, force: true });
		}
	});

	it("excludes a session that belongs to a nested repo inside this one", async () => {
		const nested = join(repoRoot, "vendor", "inner");
		await mkdir(join(nested, ".git"), { recursive: true });

		const mine = claudeSessionsForRepo(scanned([join(nested, "src")]), repoRoot);

		expect(mine).toEqual([]);
	});

	it("drops a session with no working directory at all", () => {
		expect(claudeSessionsForRepo(scanned([]), repoRoot)).toEqual([]);
	});

	it("carries the last-turn instant through as updatedAt and drops dirs", () => {
		const mine = claudeSessionsForRepo(scanned([repoRoot]), repoRoot);

		expect(mine[0].updatedAt).toBe(hoursAgo(1));
		expect("dirs" in mine[0]).toBe(false);
	});
});
