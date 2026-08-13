import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStat } = vi.hoisted(() => ({
	mockStat: vi.fn<typeof import("node:fs/promises").stat>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	mockStat.mockImplementation(original.stat);
	return {
		...original,
		stat: mockStat,
	};
});

// Suppress console output during tests
beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

// Mock os.homedir and os.platform to point to a temp directory.
// We must preserve tmpdir so our own test setup/teardown still works.
const mockHomeDir = vi.fn<() => string>();
const mockPlatform = vi.fn<() => string>();
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => mockHomeDir(), platform: () => mockPlatform() };
});

// The cwd match now runs through `normalizePathForCompare`, which reads
// `process.platform` directly (not os.platform()). Override it per-test so the
// case-sensitivity branch is deterministic regardless of host OS; restore in afterEach.
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
function setPlatform(os: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: os, configurable: true });
}

import {
	codexSessionsForRepo,
	discoverCodexSessions,
	isCodexInstalled,
	scanCodexSessionsOnDisk,
} from "./CodexSessionDiscoverer.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(realTmpdir(), "codex-discover-test-"));
	mockHomeDir.mockReturnValue(tempDir);
	mockPlatform.mockReturnValue("darwin");
	mockStat.mockClear();
});

afterEach(async () => {
	/* v8 ignore next -- the platform descriptor is always present on supported runtimes */
	if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
	await rm(tempDir, { recursive: true, force: true });
});

/** Creates a Codex-style session JSONL file with a session_meta first line. */
async function createCodexSession(
	dir: string,
	filename: string,
	cwd: string,
	sessionId: string,
	timestamp?: string,
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, filename);
	const meta = JSON.stringify({
		timestamp: timestamp ?? new Date().toISOString(),
		type: "session_meta",
		payload: { id: sessionId, cwd, originator: "Codex Desktop", cli_version: "0.108.0" },
	});
	const userMsg = JSON.stringify({
		timestamp: timestamp ?? new Date().toISOString(),
		type: "event_msg",
		payload: { type: "user_message", message: "Hello" },
	});
	await writeFile(filePath, `${meta}\n${userMsg}\n`, "utf-8");
	return filePath;
}

describe("discoverCodexSessions", () => {
	it("discovers sessions matching project cwd", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await createCodexSession(dayDir, "rollout-test-abc123.jsonl", "/my/project", "sess-001");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("sess-001");
		expect(sessions[0].source).toBe("codex");
		expect(sessions[0].transcriptPath).toContain("rollout-test-abc123.jsonl");
	});

	it("skips sessions with different cwd", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await createCodexSession(dayDir, "rollout-other.jsonl", "/other/project", "sess-002");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	// JOLLI-2015: a session run from a subdirectory of the project (common in a
	// monorepo, `cd packages/foo && codex`) IS attributed to the repo via
	// prefix/containment matching — semantics shared with Devin/OpenCode/Copilot.
	it("discovers a session run in a subdirectory of the project (prefix match)", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await createCodexSession(dayDir, "rollout-sub.jsonl", "/my/project/packages/foo", "sess-sub");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-sub"]);
	});

	// A session living in a NESTED git repo / submodule inside the worktree belongs
	// to the inner repo's own post-commit, not this one — an intervening `.git`
	// excludes it. Uses a real temp dir so `.git` can exist on disk.
	it("does NOT discover a session inside a nested git repo under the project", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		const realRepo = await mkdtemp(join(realTmpdir(), "codex-nested-"));
		try {
			const nested = join(realRepo, "vendor", "lib");
			await mkdir(join(nested, ".git"), { recursive: true });
			await createCodexSession(dayDir, "rollout-nested.jsonl", nested, "sess-nested");

			const sessions = await discoverCodexSessions(realRepo);
			expect(sessions).toHaveLength(0);
		} finally {
			await rm(realRepo, { recursive: true, force: true });
		}
	});

	it("returns empty array when sessions directory does not exist", async () => {
		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("filters stale sessions (>48h)", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		const staleTimestamp = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
		await createCodexSession(dayDir, "rollout-stale.jsonl", "/my/project", "sess-stale", staleTimestamp);

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("discovers sessions from archived_sessions directory", async () => {
		const archivedDir = join(tempDir, ".codex", "archived_sessions");
		await createCodexSession(archivedDir, "rollout-archived.jsonl", "/my/project", "sess-archived");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("sess-archived");
	});

	it("handles corrupt JSONL files gracefully", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		await writeFile(join(dayDir, "rollout-corrupt.jsonl"), "not valid json\n", "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("handles empty JSONL files gracefully", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		await writeFile(join(dayDir, "rollout-empty.jsonl"), "", "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("skips non-jsonl files", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		await writeFile(join(dayDir, "notes.txt"), "not a session", "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("skips files where first line is not session_meta", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		const line = JSON.stringify({ timestamp: "2026-03-22T00:00:00Z", type: "event_msg", payload: {} });
		await writeFile(join(dayDir, "rollout-nometa.jsonl"), `${line}\n`, "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("handles session_meta with missing cwd or id", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		const line = JSON.stringify({
			timestamp: "2026-03-22T00:00:00Z",
			type: "session_meta",
			payload: { originator: "Codex" },
		});
		await writeFile(join(dayDir, "rollout-noid.jsonl"), `${line}\n`, "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("handles session_meta with a non-object payload", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		const line = JSON.stringify({
			timestamp: "2026-03-22T00:00:00Z",
			type: "session_meta",
			payload: null,
		});
		await writeFile(join(dayDir, "rollout-null-payload.jsonl"), `${line}\n`, "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("skips a session_meta row with an unparseable timestamp", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await createCodexSession(dayDir, "rollout-bad-time.jsonl", "/my/project", "sess-bad-time", "not-a-date");

		await expect(discoverCodexSessions("/my/project")).resolves.toEqual([]);
	});

	it("falls back to file mtime when session_meta has no timestamp", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		const filePath = join(dayDir, "rollout-notimestamp.jsonl");
		// session_meta without a timestamp field
		const meta = JSON.stringify({
			type: "session_meta",
			payload: { id: "sess-notime", cwd: "/my/project" },
		});
		await writeFile(filePath, `${meta}\n`, "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("sess-notime");
	});

	it("skips sessions without timestamp when file mtime lookup fails", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		const filePath = join(dayDir, "rollout-notimestamp-missing-mtime.jsonl");
		const meta = JSON.stringify({
			type: "session_meta",
			payload: { id: "sess-no-mtime", cwd: "/my/project" },
		});
		await writeFile(filePath, `${meta}\n`, "utf-8");
		mockStat.mockRejectedValueOnce(new Error("gone"));

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("only scans recent date directories (performance optimization)", async () => {
		// Create a session in a directory from 5 days ago — should NOT be scanned
		const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
		const year = String(oldDate.getFullYear());
		const month = String(oldDate.getMonth() + 1).padStart(2, "0");
		const day = String(oldDate.getDate()).padStart(2, "0");
		const oldDir = join(tempDir, ".codex", "sessions", year, month, day);

		// Even though the timestamp is fresh, the directory is old
		await createCodexSession(oldDir, "rollout-old-dir.jsonl", "/my/project", "sess-old-dir");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("skips year directories outside the recent window", async () => {
		const oldYear = String(new Date().getFullYear() - 1);
		const oldDir = join(tempDir, ".codex", "sessions", oldYear, "12", "31");

		await createCodexSession(oldDir, "rollout-old-year.jsonl", "/my/project", "sess-old-year");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("skips month paths that cannot be read as directories", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const yearDir = join(tempDir, ".codex", "sessions", year);

		await mkdir(yearDir, { recursive: true });
		await writeFile(join(yearDir, month), "not a directory", "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("skips year paths that cannot be read as directories", async () => {
		const year = String(new Date().getFullYear());
		const sessionsRoot = join(tempDir, ".codex", "sessions");

		await mkdir(sessionsRoot, { recursive: true });
		await writeFile(join(sessionsRoot, year), "not a directory", "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("skips day directories that do not match any recent date", async () => {
		// Place a session in the current year/month but a day far enough out to not be recent
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		// Pick a day that is guaranteed not to be recent: if today is >= 15, use "01"; otherwise use "28"
		const farDay = now.getDate() >= 15 ? "01" : "28";
		const farDayDir = join(tempDir, ".codex", "sessions", year, month, farDay);

		await createCodexSession(farDayDir, "rollout-far-day.jsonl", "/my/project", "sess-far-day");

		const sessions = await discoverCodexSessions("/my/project");
		// The session should be excluded because the day doesn't match the recent window
		expect(sessions.every((s) => s.sessionId !== "sess-far-day")).toBe(true);
	});

	it("skips month directories outside the recent window within the current year", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const currentMonth = now.getMonth() + 1;
		const oldMonthNumber = currentMonth >= 3 ? currentMonth - 2 : 12;
		const oldMonth = String(oldMonthNumber).padStart(2, "0");
		const oldDayDir = join(tempDir, ".codex", "sessions", year, oldMonth, "01");

		await createCodexSession(oldDayDir, "rollout-old-month.jsonl", "/my/project", "sess-old-month");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});
});

describe("Windows path case-insensitive matching", () => {
	it("matches cwd with different drive letter case on Windows", async () => {
		setPlatform("win32");

		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		// Codex stores lowercase drive letter in session_meta cwd
		await createCodexSession(dayDir, "rollout-win.jsonl", "/my/project", "sess-win");

		// Project dir uses uppercase — on real Windows path.resolve normalizes slashes
		// but not drive letter case. Here we simulate the mismatch with different cases.
		const sessions = await discoverCodexSessions("/MY/PROJECT");
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("sess-win");
	});

	it("does not match different paths case-insensitively on non-Windows", async () => {
		setPlatform("linux");

		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await createCodexSession(dayDir, "rollout-linux.jsonl", "/my/project", "sess-linux");

		const sessions = await discoverCodexSessions("/MY/PROJECT");
		expect(sessions).toHaveLength(0);
	});
});

describe("discoverCodexSessions — staleness window", () => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const SEVEN_DAYS_MS = 7 * DAY_MS;

	/**
	 * The `YYYY/MM/DD` directory Codex would have written a session `daysAgo` days
	 * back, built from LOCAL date parts — which is what the discoverer's own
	 * traversal uses, and what Codex itself stamps into these names (a real capture
	 * has `sessions/2026/08/11/rollout-2026-08-11T10-52-15-….jsonl` whose
	 * `session_meta.timestamp` is `2026-08-11T02:53:24Z`, i.e. 10:53 local at UTC+8).
	 */
	function dayDirFor(daysAgo: number): string {
		const d = new Date(Date.now() - daysAgo * DAY_MS);
		return join(
			tempDir,
			".codex",
			"sessions",
			String(d.getFullYear()),
			String(d.getMonth() + 1).padStart(2, "0"),
			String(d.getDate()).padStart(2, "0"),
		);
	}

	const isoDaysAgo = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY_MS).toISOString();

	it("finds a four-day-old session when given a seven-day window", async () => {
		// THIS is the test that pins the calendar-day traversal, not just the staleness
		// check. A session four days back lives in a `YYYY/MM/DD` directory that the
		// old hard-coded three-day range never entered, so it was unreachable no matter
		// what window was asked for — the parameter would have been purely decorative,
		// with no error and a plausible-looking empty result.
		await createCodexSession(dayDirFor(4), "rollout-old.jsonl", "/my/project", "sess-4d", isoDaysAgo(4));

		const sessions = await discoverCodexSessions("/my/project", SEVEN_DAYS_MS);

		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-4d"]);
	});

	it("does not find that session under the default 48-hour window", async () => {
		await createCodexSession(dayDirFor(4), "rollout-old.jsonl", "/my/project", "sess-4d", isoDaysAgo(4));

		await expect(discoverCodexSessions("/my/project")).resolves.toEqual([]);
	});

	it("reaches the oldest calendar day a seven-day window can touch", async () => {
		// `ceil(7d / 1d) + 1 = 8` directories: a window that ends mid-day reaches into
		// the eighth calendar day back. Six days is comfortably inside that.
		await createCodexSession(dayDirFor(6), "rollout-six.jsonl", "/my/project", "sess-6d", isoDaysAgo(6));

		const sessions = await discoverCodexSessions("/my/project", SEVEN_DAYS_MS);

		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-6d"]);
	});

	it("still rejects a session older than the widened window", async () => {
		// Nine days back: outside the window AND outside the directory range.
		await createCodexSession(dayDirFor(9), "rollout-ancient.jsonl", "/my/project", "sess-9d", isoDaysAgo(9));

		await expect(discoverCodexSessions("/my/project", SEVEN_DAYS_MS)).resolves.toEqual([]);
	});

	it("applies the window to archived sessions, which are not date-partitioned", async () => {
		// The archived half is a flat directory, so it needs no traversal change — only
		// the staleness value reaches it. Worth pinning so a later edit does not assume
		// the two halves work the same way.
		const archived = join(tempDir, ".codex", "archived_sessions");
		await createCodexSession(archived, "rollout-arch.jsonl", "/my/project", "sess-arch", isoDaysAgo(4));

		await expect(discoverCodexSessions("/my/project")).resolves.toEqual([]);
		const wide = await discoverCodexSessions("/my/project", SEVEN_DAYS_MS);
		expect(wide.map((s) => s.sessionId)).toEqual(["sess-arch"]);
	});
});

describe("scanCodexSessionsOnDisk / codexSessionsForRepo", () => {
	/** Today's date directory, where a fresh rollout would land. */
	function todayDir(): string {
		const d = new Date();
		return join(
			tempDir,
			".codex",
			"sessions",
			String(d.getFullYear()),
			String(d.getMonth() + 1).padStart(2, "0"),
			String(d.getDate()).padStart(2, "0"),
		);
	}

	it("scans machine-wide and carries each rollout's working directory", async () => {
		// Repo-agnostic on purpose: one scan serves every registered repo, instead of
		// re-reading the first line of every rollout once per repo.
		await createCodexSession(todayDir(), "a.jsonl", "/w/one", "sess-a");
		await createCodexSession(todayDir(), "b.jsonl", "/w/two", "sess-b");

		const scanned = await scanCodexSessionsOnDisk();

		expect(scanned.map((s) => s.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
		expect(scanned.find((s) => s.sessionId === "sess-a")?.dirs).toEqual(["/w/one"]);
	});

	it("narrows a scan to one repo, including a rollout started in a subdirectory", async () => {
		const repoRoot = await mkdtemp(join(realTmpdir(), "codex-repo-"));
		try {
			const scanned = [
				{
					sessionId: "root",
					transcriptPath: "/t/root.jsonl",
					updatedAt: "2026-08-13T00:00:00.000Z",
					dirs: [repoRoot],
				},
				{
					sessionId: "sub",
					transcriptPath: "/t/sub.jsonl",
					updatedAt: "2026-08-13T00:00:00.000Z",
					dirs: [join(repoRoot, "cli", "src")],
				},
				{
					sessionId: "elsewhere",
					transcriptPath: "/t/elsewhere.jsonl",
					updatedAt: "2026-08-13T00:00:00.000Z",
					dirs: ["/somewhere/else"],
				},
				{
					// A sibling sharing the repo's name prefix — a naive `startsWith` claims it.
					sessionId: "sibling",
					transcriptPath: "/t/sibling.jsonl",
					updatedAt: "2026-08-13T00:00:00.000Z",
					dirs: [`${repoRoot}-other`],
				},
			];

			const mine = codexSessionsForRepo(scanned, repoRoot);

			expect(mine.map((s) => s.sessionId).sort()).toEqual(["root", "sub"]);
			expect(mine[0].source).toBe("codex");
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("excludes a rollout that belongs to a nested repo inside this one", async () => {
		const repoRoot = await mkdtemp(join(realTmpdir(), "codex-repo-"));
		try {
			const nested = join(repoRoot, "vendor", "inner");
			await mkdir(join(nested, ".git"), { recursive: true });
			const scanned = [
				{ sessionId: "n", transcriptPath: "/t/n.jsonl", updatedAt: "2026-08-13T00:00:00.000Z", dirs: [nested] },
			];

			expect(codexSessionsForRepo(scanned, repoRoot)).toEqual([]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("gives the same answer as the wrapper that replaced it", async () => {
		// `discoverCodexSessions` is now scan-then-filter; the split must not have moved
		// any behaviour.
		await createCodexSession(todayDir(), "c.jsonl", "/my/project", "sess-c");

		const direct = await discoverCodexSessions("/my/project");
		const split = codexSessionsForRepo(await scanCodexSessionsOnDisk(), "/my/project");

		expect(split).toEqual(direct);
	});
});

describe("isCodexInstalled", () => {
	it("returns true when ~/.codex/ exists", async () => {
		await mkdir(join(tempDir, ".codex"), { recursive: true });
		expect(await isCodexInstalled()).toBe(true);
	});

	it("returns false when ~/.codex/ does not exist", async () => {
		expect(await isCodexInstalled()).toBe(false);
	});
});
