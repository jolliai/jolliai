import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir as realTmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLevel } from "../Types.js";

/**
 * `realFs.stat` is the genuine `node:fs/promises.stat`, captured where the mock is installed.
 *
 * Deliberately NOT read back later with `mockStat.getMockImplementation()`. That returns
 * `onceMockImplementations[0] || mockImplementation` — the head of the ONE-SHOT QUEUE
 * whenever one is pending — so an unconsumed `mockResolvedValueOnce` would be captured as
 * if it were the real implementation, and a restore would then install it PERMANENTLY.
 * Every later case would see whatever that stub returns, i.e. no sessions at all, with the
 * failure landing nowhere near its cause. Captured here it is unconditionally the real one.
 *
 * Hoisted rather than a plain module-level `let` because the `vi.mock` factory below runs at
 * the SUT's import, before any module-level binding is initialised.
 */
const { mockStat, mockReaddir, realFs } = vi.hoisted(() => ({
	mockStat: vi.fn<typeof import("node:fs/promises").stat>(),
	mockReaddir: vi.fn<typeof import("node:fs/promises").readdir>(),
	realFs: {} as {
		stat?: typeof import("node:fs/promises").stat;
		readdir?: typeof import("node:fs/promises").readdir;
	},
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	realFs.stat = original.stat;
	realFs.readdir = original.readdir;
	mockStat.mockImplementation(original.stat);
	mockReaddir.mockImplementation(original.readdir);
	return {
		...original,
		stat: mockStat,
		readdir: mockReaddir,
	};
});

/**
 * The scan's log lines, captured through the real formatter.
 *
 * A directory that produced no sessions leaves nothing behind BUT a log line, so which line
 * it is — "not found" versus "not readable (EACCES)" — is the whole observable behaviour of
 * {@link logUnlistedDir} and has to be asserted rather than eyeballed. Rendered through
 * `formatLogMessage` because the errno arrives as a `%s`: a capture that stored the format
 * string would pass just as happily if the code were dropped, which is the regression this
 * exists to catch.
 */
const { logLines } = vi.hoisted(() => ({ logLines: [] as Array<{ level: string; text: string }> }));

vi.mock("../Logger.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../Logger.js")>();
	const record =
		(level: LogLevel, module: string) =>
		(message: string, ...args: unknown[]): void => {
			logLines.push({ level, text: original.formatLogMessage(level, module, message, args) });
		};
	return {
		...original,
		createLogger: (module: string) => ({
			debug: record("debug", module),
			info: record("info", module),
			warn: record("warn", module),
			error: record("error", module),
		}),
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
	resetCodexSessionMetaMemo,
	scanCodexSessionsOnDisk,
} from "./CodexSessionDiscoverer.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(realTmpdir(), "codex-discover-test-"));
	mockHomeDir.mockReturnValue(tempDir);
	mockPlatform.mockReturnValue("darwin");
	// `mockReset`, not `mockClear`: only reset drains the one-shot queue. `mockClear` resets
	// recorded CALLS and leaves both the implementation and any pending `…Once` stub in
	// place, so a stub its own case never consumed is served to the NEXT case's first `stat`
	// — one case's fault injection surfacing as an unrelated case seeing no sessions. Reset
	// drops the implementation too, hence the reinstall.
	mockStat.mockReset();
	mockReaddir.mockReset();
	if (realFs.stat !== undefined) mockStat.mockImplementation(realFs.stat);
	if (realFs.readdir !== undefined) mockReaddir.mockImplementation(realFs.readdir);
	logLines.length = 0;
	// Each case gets a fresh `mkdtemp`, so no path can survive into the next one and the
	// memo cannot actually leak here. Cleared anyway: the day someone reuses a fixture
	// path, the failure would be a case reading another case's session id, which is far
	// harder to recognise than a missing reset.
	resetCodexSessionMetaMemo();
});

afterEach(async () => {
	/* v8 ignore next -- the platform descriptor is always present on supported runtimes */
	if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
	await rm(tempDir, { recursive: true, force: true });
});

/**
 * Creates a Codex-style session JSONL file with a session_meta first line.
 *
 * The two time parameters are NOT interchangeable, and which one a test reaches for
 * is the point. `mtimeMs` sets the file's modification time, which is what the
 * discoverer dates a rollout by; `timestamp` only fills the first line's creation
 * stamp, which the discoverer deliberately ignores. So a test that wants an OLD
 * session must pass `mtimeMs` — passing `timestamp` alone leaves a file written just
 * now, i.e. a session that is current no matter what its first line claims.
 */
async function createCodexSession(
	dir: string,
	filename: string,
	cwd: string,
	sessionId: string,
	timestamp?: string,
	mtimeMs?: number,
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
	if (mtimeMs !== undefined) {
		const seconds = mtimeMs / 1000;
		await utimes(filePath, seconds, seconds);
	}
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

		// Staleness is the FILE's age, not the first line's claim — see `createCodexSession`.
		const staleMtime = Date.now() - 49 * 60 * 60 * 1000;
		await createCodexSession(dayDir, "rollout-stale.jsonl", "/my/project", "sess-stale", undefined, staleMtime);

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

	it("dates a rollout by mtime and ignores session_meta.timestamp entirely", async () => {
		// The regression this pins: `session_meta.timestamp` is the CREATION instant and
		// never moves, so reading it made a resumed conversation report the same time
		// forever and the dashboard skipped it for good. An unusable value there must not
		// even be consulted now — a file written a moment ago is a current session.
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);
		const mtime = Date.now() - 60_000;

		await createCodexSession(dayDir, "rollout-bad-time.jsonl", "/my/project", "sess-bad-time", "not-a-date", mtime);

		const sessions = await discoverCodexSessions("/my/project");

		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-bad-time"]);
		expect(sessions[0].updatedAt).toBe(new Date(mtime).toISOString());
	});

	it("discovers a rollout whose session_meta carries no timestamp at all", async () => {
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

	it("skips a rollout whose mtime cannot be read", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		const filePath = join(dayDir, "rollout-missing-mtime.jsonl");
		const meta = JSON.stringify({
			type: "session_meta",
			payload: { id: "sess-no-mtime", cwd: "/my/project" },
		});
		await writeFile(filePath, `${meta}\n`, "utf-8");
		// The `stat` now happens BEFORE the first-line read, so this rejection lands on
		// the mtime lookup and the file is never opened at all.
		mockStat.mockRejectedValueOnce(new Error("gone"));

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toHaveLength(0);
	});

	it("finds a rollout in an old date directory when its mtime is recent", async () => {
		// The other half of the resumed-session fix. Codex names a directory for the day
		// the rollout was CREATED and never moves the file, so a conversation started five
		// days ago and continued this morning still lives under the old date. The
		// directory-name filter this replaced could not reach it at any window width.
		const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
		const year = String(oldDate.getFullYear());
		const month = String(oldDate.getMonth() + 1).padStart(2, "0");
		const day = String(oldDate.getDate()).padStart(2, "0");
		const oldDir = join(tempDir, ".codex", "sessions", year, month, day);

		await createCodexSession(oldDir, "rollout-resumed.jsonl", "/my/project", "sess-resumed");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-resumed"]);
	});

	it("still skips an old date directory whose rollout has not been touched", async () => {
		// Walking every directory is not the same as ignoring the window: the staleness
		// decision simply moved from the directory's NAME to the file's mtime.
		const oldYear = String(new Date().getFullYear() - 1);
		const oldDir = join(tempDir, ".codex", "sessions", oldYear, "12", "31");

		await createCodexSession(
			oldDir,
			"rollout-old-year.jsonl",
			"/my/project",
			"sess-old-year",
			undefined,
			Date.now() - 30 * 24 * 60 * 60 * 1000,
		);

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

	it("separates touched from untouched rollouts inside one old directory", async () => {
		// Both halves of the traversal in one case: the walk reaches a directory named for
		// a month that is long past, and the per-file mtime is what decides. Replaces two
		// cases that asserted the directory NAME excluded its contents — behaviour that
		// made a resumed conversation permanently invisible.
		const now = new Date();
		const year = String(now.getFullYear());
		const currentMonth = now.getMonth() + 1;
		const oldMonthNumber = currentMonth >= 3 ? currentMonth - 2 : 12;
		const oldMonth = String(oldMonthNumber).padStart(2, "0");
		const oldDayDir = join(tempDir, ".codex", "sessions", year, oldMonth, "01");

		await createCodexSession(oldDayDir, "rollout-resumed.jsonl", "/my/project", "sess-resumed");
		await createCodexSession(
			oldDayDir,
			"rollout-dormant.jsonl",
			"/my/project",
			"sess-dormant",
			undefined,
			Date.now() - 30 * 24 * 60 * 60 * 1000,
		);

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-resumed"]);
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
	 * back, built from LOCAL date parts — which is how Codex stamps these names (a real
	 * capture has `sessions/2026/08/11/rollout-2026-08-11T10-52-15-….jsonl` whose
	 * `session_meta.timestamp` is `2026-08-11T02:53:24Z`, i.e. 10:53 local at UTC+8).
	 *
	 * The directory no longer decides anything — the walk enters all of them — so this
	 * exists to keep the fixtures shaped like a real tree, and the AGE of a session in
	 * these cases comes from {@link msDaysAgo} instead.
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

	/** The mtime a rollout last appended to `daysAgo` days back would carry. */
	const msDaysAgo = (daysAgo: number): number => Date.now() - daysAgo * DAY_MS;

	it("finds a four-day-old session when given a seven-day window", async () => {
		await createCodexSession(dayDirFor(4), "rollout-old.jsonl", "/my/project", "sess-4d", undefined, msDaysAgo(4));

		const sessions = await discoverCodexSessions("/my/project", SEVEN_DAYS_MS);

		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-4d"]);
	});

	it("does not find that session under the default 48-hour window", async () => {
		await createCodexSession(dayDirFor(4), "rollout-old.jsonl", "/my/project", "sess-4d", undefined, msDaysAgo(4));

		await expect(discoverCodexSessions("/my/project")).resolves.toEqual([]);
	});

	it("reaches a session close to the far edge of a seven-day window", async () => {
		await createCodexSession(dayDirFor(6), "rollout-six.jsonl", "/my/project", "sess-6d", undefined, msDaysAgo(6));

		const sessions = await discoverCodexSessions("/my/project", SEVEN_DAYS_MS);

		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-6d"]);
	});

	it("still rejects a session older than the widened window", async () => {
		await createCodexSession(
			dayDirFor(9),
			"rollout-ancient.jsonl",
			"/my/project",
			"sess-9d",
			undefined,
			msDaysAgo(9),
		);

		await expect(discoverCodexSessions("/my/project", SEVEN_DAYS_MS)).resolves.toEqual([]);
	});

	it("applies the window to archived sessions, which are not date-partitioned", async () => {
		// The archived half is a flat directory rather than a date tree. Both halves now
		// gate on the same per-file mtime, and this pins that they agree.
		const archived = join(tempDir, ".codex", "archived_sessions");
		await createCodexSession(archived, "rollout-arch.jsonl", "/my/project", "sess-arch", undefined, msDaysAgo(4));

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

	it("walks every date directory and keeps the tree's order", async () => {
		// The walk is four bounded rounds (years, months, days, then every rollout in one
		// pool) rather than a serial round-trip per calendar day. Order is what pins that
		// the flattening is faithful: `mapWithConcurrency` writes back by index, so the
		// result must still read year → month → day → file exactly as the serial walk
		// produced it. Not cosmetic — the collector's event order decides which sessions
		// share an `applyBatches` batch.
		const base = join(tempDir, ".codex", "sessions");
		const dayDirs = [
			["2026", "07", "30"],
			["2026", "08", "01"],
			["2026", "08", "02"],
		];
		for (const [i, [y, m, d]] of dayDirs.entries()) {
			await createCodexSession(join(base, y as string, m as string, d as string), "a.jsonl", "/w", `s${i}a`);
			await createCodexSession(join(base, y as string, m as string, d as string), "b.jsonl", "/w", `s${i}b`);
		}

		const scanned = await scanCodexSessionsOnDisk();

		expect(scanned.map((s) => s.sessionId)).toEqual(["s0a", "s0b", "s1a", "s1b", "s2a", "s2b"]);
	});

	it("keeps scanning past a date directory it cannot read", async () => {
		// Each level contributes nothing rather than failing the level — the same
		// `continue` the serial walk did, and why a partially-permissioned tree still
		// yields the rest of its sessions.
		const base = join(tempDir, ".codex", "sessions");
		await mkdir(join(base, "2026", "08", "01"), { recursive: true });
		await createCodexSession(join(base, "2026", "08", "02"), "a.jsonl", "/w", "kept");
		// A FILE where a month directory is expected: `readdir` on it raises ENOTDIR.
		await writeFile(join(base, "2025"), "not a directory", "utf-8");

		const scanned = await scanCodexSessionsOnDisk();

		expect(scanned.map((s) => s.sessionId)).toEqual(["kept"]);
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

/**
 * The `session_meta` memo — see `SESSION_META_MEMO` in the discoverer.
 *
 * Every case here proves it by REWRITING the first line and watching which id comes
 * back, rather than by counting reads through a spy: what matters is whether the file
 * was opened, and a stale answer is the only observable that says it was not.
 */
describe("scanCodexSessionsOnDisk — the session_meta memo", () => {
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

	/** Replaces a rollout's whole content, optionally forcing its mtime afterwards. */
	async function rewrite(filePath: string, sessionId: string, mtimeMs?: number): Promise<void> {
		const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/my/project" } });
		await writeFile(filePath, `${meta}\n`, "utf-8");
		if (mtimeMs !== undefined) {
			const seconds = mtimeMs / 1000;
			await utimes(filePath, seconds, seconds);
		}
	}

	it("does not re-open a rollout whose first line it already read", async () => {
		const file = await createCodexSession(todayDir(), "rollout-memo.jsonl", "/my/project", "sess-first");
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-first"]);

		// A real append cannot change the first line, so this is not a scenario — it is
		// the only way to observe whether the file was opened a second time.
		await rewrite(file, "sess-rewritten");

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-first"]);
	});

	it("still reports the CURRENT mtime on a memo hit", async () => {
		// The half that must never be cached: `updatedAt` is what tells the back-fill a
		// conversation grew, so serving a remembered instant would re-open the exact data
		// loss the mtime scan was introduced to close.
		const file = await createCodexSession(todayDir(), "rollout-mtime.jsonl", "/my/project", "sess-grow");
		const first = (await scanCodexSessionsOnDisk())[0];

		const moved = Date.now() - 5_000;
		await utimes(file, moved / 1000, moved / 1000);
		const second = (await scanCodexSessionsOnDisk())[0];

		expect(second?.sessionId).toBe("sess-grow");
		expect(second?.updatedAt).toBe(new Date(moved).toISOString());
		expect(second?.updatedAt).not.toBe(first?.updatedAt);
	});

	it("reads again once the memo is cleared", async () => {
		const file = await createCodexSession(todayDir(), "rollout-cleared.jsonl", "/my/project", "sess-before");
		await scanCodexSessionsOnDisk();
		await rewrite(file, "sess-after");

		resetCodexSessionMetaMemo();

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-after"]);
	});

	it("forgets an entry whose file went BACKWARDS in time", async () => {
		// Appending only ever moves mtime forward, so an earlier mtime means a different
		// file now occupies this path — the one way a path's first line can change.
		const start = Date.now() - 60_000;
		const file = await createCodexSession(
			todayDir(),
			"rollout-replaced.jsonl",
			"/my/project",
			"sess-old",
			undefined,
			start,
		);
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-old"]);

		await rewrite(file, "sess-new", start - 30_000);

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-new"]);
	});

	it("never memoizes a rollout the window rejected", async () => {
		// The memo sits AFTER the staleness gate, so a stale file is not remembered — and
		// the moment it is touched it is read for real rather than served from an entry
		// that was never allowed to exist.
		const file = await createCodexSession(
			todayDir(),
			"rollout-stale-then-fresh.jsonl",
			"/my/project",
			"sess-stale",
			undefined,
			Date.now() - 49 * 60 * 60 * 1000,
		);
		expect(await scanCodexSessionsOnDisk()).toEqual([]);

		await rewrite(file, "sess-resumed");

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-resumed"]);
	});
});

describe("scanCodexSessionsOnDisk — the past-day listing memo", () => {
	/** A `YYYY/MM/DD` directory `days` before today, in LOCAL time as Codex names them. */
	function dayDir(days: number): string {
		const d = new Date();
		d.setDate(d.getDate() - days);
		return join(
			tempDir,
			".codex",
			"sessions",
			String(d.getFullYear()),
			String(d.getMonth() + 1).padStart(2, "0"),
			String(d.getDate()).padStart(2, "0"),
		);
	}

	it("does not re-list a past day directory it already listed", async () => {
		// Codex only ever creates a rollout under TODAY'S date, so a past day directory
		// cannot gain an entry — its files are still appended to, which is why the walk
		// cannot skip it, but the SET of files is fixed. Caching it is what removes the
		// ~730 `readdir` round trips a two-year user otherwise pays on every scan.
		//
		// THREE days back, not two, and that is about this test's own clock rather than about
		// the memo. The cutoff is the EARLIER of yesterday's local and UTC keys, so east of
		// UTC it lands two local days back for part of every day: at UTC+8, local 03:00 makes
		// yesterday 20260817 locally and 20260816 in UTC, the cutoff 20260816 — and
		// `dayDir(2)` is 20260816 too, so the directory is inside the volatile margin, is
		// never cached, and the second scan legitimately returns both sessions. Only the
		// assertion was wrong; the production margin is documented as "two or three per scan"
		// for exactly this reason. CI runs at UTC where the two keys always agree, so this
		// failed only on developer machines east of UTC before local 08:00. Three days back
		// is unconditionally safe: yesterday's two keys differ by at most one day, so the
		// cutoff can never reach further back than two.
		//
		// Writing a NEW file into that directory is not a scenario Codex produces; it is
		// the only way to observe whether the directory was listed a second time.
		const dir = dayDir(3);
		await createCodexSession(dir, "rollout-a.jsonl", "/my/project", "sess-a");
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-a"]);

		await createCodexSession(dir, "rollout-b.jsonl", "/my/project", "sess-b");

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-a"]);
	});

	it("never caches YESTERDAY'S directory, which the two clocks disagree about", async () => {
		// The cutoff is the earlier of yesterday's LOCAL and UTC keys, so yesterday is never
		// memoized. Two reachable failures need that margin, and neither is detectable from
		// inside the process: Codex may stamp the directory in UTC (no capture discriminates
		// — every sampled rollout was created at an hour where the two dates agree), in
		// which case a UTC+8 machine spends 00:00-08:00 local appending to a directory whose
		// name is already "yesterday" locally; and V8 caches the timezone until
		// `process.env.TZ` is assigned, so a daemon that travelled west computes a local key
		// up to a day ahead while the epoch-derived UTC key stays right.
		const dir = dayDir(1);
		await createCodexSession(dir, "rollout-first.jsonl", "/my/project", "sess-first");
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-first"]);

		await createCodexSession(dir, "rollout-second.jsonl", "/my/project", "sess-second");

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId).sort()).toEqual(["sess-first", "sess-second"]);
	});

	it("does not memoize a listing it never obtained", async () => {
		// `listDir` answers "unreadable" and "empty" differently for exactly this reason. A
		// failed `readdir` cached as `[]` makes every rollout under that date invisible for
		// the life of the process — silently, with no log line and no invalidator — and in
		// the resident daemon that is machine uptime. The uncached walk retried on the next
		// scan, and caching must not take that away.
		//
		// A FILE where the day directory belongs is the deterministic way to fail a
		// `readdir` (ENOTDIR) without chmod, which does nothing when the suite runs as root.
		const dir = dayDir(4);
		await mkdir(dirname(dir), { recursive: true });
		await writeFile(dir, "not a directory", "utf-8");

		expect(await scanCodexSessionsOnDisk()).toEqual([]);

		await rm(dir);
		await createCodexSession(dir, "rollout-late.jsonl", "/my/project", "sess-late");

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-late"]);
	});

	it("drops a memoized listing whose rollout was archived away", async () => {
		// A past day directory cannot GAIN an entry, but it can LOSE one: archiving is a
		// `rename` out of it. Without dropping the entry the listing keeps naming the
		// pre-archive path for the life of the process — one wasted `stat` and one debug line
		// per archived rollout per tick, 2,880 times a day.
		const dir = dayDir(5);
		const file = await createCodexSession(dir, "rollout-archived.jsonl", "/my/project", "sess-archived");
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-archived"]);

		await rm(file);
		// This scan stats a path the cached listing named and finds it gone, which is what
		// invalidates the entry.
		expect(await scanCodexSessionsOnDisk()).toEqual([]);

		await createCodexSession(dir, "rollout-next.jsonl", "/my/project", "sess-next");

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-next"]);
	});

	it("still notices a past rollout that GREW, which is the whole point of the walk", async () => {
		// The listing is cached; the per-file `stat` is not, and must not be — it is the
		// question this scan asks. A conversation created three weeks ago and resumed this
		// morning still lives under the old date.
		const file = await createCodexSession(
			dayDir(3),
			"rollout-resumed.jsonl",
			"/my/project",
			"sess-resumed",
			undefined,
			Date.now() - 49 * 60 * 60 * 1000,
		);
		expect(await scanCodexSessionsOnDisk()).toEqual([]);

		const touched = Date.now() - 1_000;
		await utimes(file, touched / 1000, touched / 1000);

		const found = await scanCodexSessionsOnDisk();
		expect(found.map((s) => s.sessionId)).toEqual(["sess-resumed"]);
		expect(found[0]?.updatedAt).toBe(new Date(touched).toISOString());
	});

	it("never caches TODAY'S directory, which is the only one that can gain a rollout", async () => {
		const dir = dayDir(0);
		await createCodexSession(dir, "rollout-first.jsonl", "/my/project", "sess-first");
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-first"]);

		await createCodexSession(dir, "rollout-second.jsonl", "/my/project", "sess-second");

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId).sort()).toEqual(["sess-first", "sess-second"]);
	});

	/** Makes one rollout's `stat` fail, leaving every other path on the real implementation. */
	function failStatFor(fileName: string, code?: string): void {
		mockStat.mockImplementation(async (target, ...rest) => {
			if (String(target).endsWith(fileName)) {
				throw Object.assign(new Error("stat refused"), code === undefined ? {} : { code });
			}
			// Keyed on the PATH rather than `…Once`, so the assertion does not depend on which
			// rollout the bounded fan-out happens to stat first.
			return realFs.stat?.(target, ...rest) as never;
		});
	}

	/**
	 * Ends a `failStatFor` override mid-case, which the cases below need for their own reasons:
	 * the scan AFTER the fault is what shows whether the listing survived it.
	 *
	 * Only the mid-case need is served here. An override that outlives its case is the outer
	 * `beforeEach`'s job — it reinstalls the real `stat` before every case in the file, so a
	 * case that throws before reaching this line cannot leave one behind either. A second
	 * restore in an `afterEach` of this block would be a second owner of that one fact.
	 */
	function restoreStat(): void {
		if (realFs.stat !== undefined) mockStat.mockImplementation(realFs.stat);
	}

	it("re-lists a cached day directory once one of its rollouts is gone", async () => {
		// The `missing` half of `MtimeProbe`, and the whole reason it is not folded into
		// `unreadable`: archiving a rollout is a `rename` out of its day directory, which is
		// the one way a memoized listing can be wrong. Nothing else invalidates it.
		const dir = dayDir(3);
		await createCodexSession(dir, "rollout-a.jsonl", "/my/project", "sess-a");
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-a"]);

		// Cached now, so a file added behind the listing's back stays invisible...
		await createCodexSession(dir, "rollout-b.jsonl", "/my/project", "sess-b");
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-a"]);

		// ...until a rollout the listing NAMED answers ENOENT, which drops the listing.
		failStatFor("rollout-a.jsonl", "ENOENT");
		await scanCodexSessionsOnDisk();
		restoreStat();

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
	});

	it("keeps a cached listing when a rollout is merely unreadable", async () => {
		// The other half, and the reason the distinction has to be made at all. An EACCES or
		// EMFILE says nothing about whether the file is still there, so spending the listing
		// over a transient fault would make the memo re-list on every hiccup — and would leave
		// the two answers indistinguishable at the one call site whose job is telling them
		// apart.
		const dir = dayDir(3);
		await createCodexSession(dir, "rollout-a.jsonl", "/my/project", "sess-a");
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-a"]);
		await createCodexSession(dir, "rollout-b.jsonl", "/my/project", "sess-b");

		// No `code`, so this cannot be read as "gone".
		failStatFor("rollout-a.jsonl");
		await scanCodexSessionsOnDisk();
		restoreStat();

		// `sess-b` is still unseen, which is the observable form of "the listing survived".
		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId)).toEqual(["sess-a"]);
	});

	it("treats a stat with no usable mtime as unreadable rather than throwing", async () => {
		// `fileStat.mtime.getTime()` is read INSIDE `statMtimeProbe`'s try for this shape. A
		// `Stats` whose `mtime` is absent is unreachable through real `node:fs` but is exactly
		// what a hand-built stub produces, and the `TypeError` escaped the fan-out — so ONE odd
		// file took down the scan of every rollout on the machine. Failing to read a file's
		// time is what `unreadable` means, so it belongs in the same answer as a failed `stat`.
		type StatResult = Awaited<ReturnType<typeof import("node:fs/promises").stat>>;
		const dir = dayDir(3);
		await createCodexSession(dir, "rollout-a.jsonl", "/my/project", "sess-a");
		mockStat.mockResolvedValueOnce({} as unknown as StatResult);

		await expect(scanCodexSessionsOnDisk()).resolves.toEqual([]);
	});

	it("lists again once the memo is cleared", async () => {
		// Three days back for the same clock reason as the caching case above, and here the
		// consequence is worse than a red test: this assertion holds whether or not the
		// directory was ever cached, so inside the volatile margin it would pass while
		// testing nothing at all.
		const dir = dayDir(3);
		await createCodexSession(dir, "rollout-one.jsonl", "/my/project", "sess-one");
		await scanCodexSessionsOnDisk();
		await createCodexSession(dir, "rollout-two.jsonl", "/my/project", "sess-two");

		// One reset clears BOTH memos — a test that forgot the listing would present as an
		// unrelated case mysteriously seeing no sessions.
		resetCodexSessionMetaMemo();

		expect((await scanCodexSessionsOnDisk()).map((s) => s.sessionId).sort()).toEqual(["sess-one", "sess-two"]);
	});
});

describe("scanCodexSessionsOnDisk — an unlisted directory says WHICH", () => {
	/**
	 * A directory that yields no rollouts leaves no other trace, so the log line is the
	 * whole observable difference between "you have never archived a conversation" and
	 * "this machine could not open the archive".
	 *
	 * Both were one line — `not readable` — while the `catch` behind `listDir` discarded the
	 * errno. That was wrong in the common direction: `archived_sessions/` does not exist on
	 * most machines, so the ordinary state was reported as a fault on every one of the
	 * resident daemon's 30-second ticks, while the genuinely interesting `EMFILE`/`EACCES`
	 * printed bytes identical to it and stayed indistinguishable afterwards.
	 */
	function archiveLines(): string[] {
		return logLines.filter((line) => line.text.includes("archived sessions directory")).map((line) => line.text);
	}

	it("reports an absent archive as absent", async () => {
		// Nothing creates `~/.codex/archived_sessions/` in this fixture, which is exactly the
		// state of a machine that has never archived a conversation — the majority case.
		await scanCodexSessionsOnDisk();

		expect(archiveLines()).toHaveLength(1);
		expect(archiveLines()[0]).toContain("not found");
		expect(archiveLines()[0]).not.toContain("not readable");
	});

	/** Fails `readdir` for one directory, leaving every other path on the real implementation. */
	function failReaddirFor(suffix: string, code: string): void {
		mockReaddir.mockImplementation(async (target, ...rest) => {
			// Keyed on the PATH rather than `…Once`: both halves of the scan call `readdir`,
			// and a one-shot stub would land on whichever ran first.
			if (String(target).endsWith(suffix)) throw Object.assign(new Error(code), { code });
			return realFs.readdir?.(target, ...rest) as never;
		});
	}

	it("names the errno when the archive genuinely cannot be read", async () => {
		failReaddirFor("archived_sessions", "EACCES");

		await scanCodexSessionsOnDisk();

		expect(archiveLines()).toHaveLength(1);
		// The code itself, not merely a different adjective: it is the only thing that
		// separates a transient EMFILE from a permission change after the fact.
		expect(archiveLines()[0]).toContain("not readable (EACCES)");
	});

	it("says the same about the sessions half, which shares the helper", async () => {
		// `sessions` and `archived_sessions` are two calls into one helper, so the wording
		// cannot drift between them the way it had — one said "not found" for the same `null`
		// the other called "not readable".
		failReaddirFor(join(".codex", "sessions"), "EMFILE");

		await scanCodexSessionsOnDisk();

		const sessionsLine = logLines.find((line) => line.text.includes("Codex sessions directory"));
		expect(sessionsLine?.text).toContain("not readable (EMFILE)");
	});
});
