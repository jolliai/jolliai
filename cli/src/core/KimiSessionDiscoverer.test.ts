import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output during tests
beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

// Mock os.homedir to point ~ at a temp directory; preserve everything else
// (tmpdir/platform) so test setup + the real path helpers keep working.
const mockHomeDir = vi.fn<() => string>();
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => mockHomeDir() };
});

import { cwdFromState, discoverKimiSessions, isKimiInstalled, kimiCodeHome } from "./KimiSessionDiscoverer.js";

let homeDir: string;

beforeEach(async () => {
	homeDir = await mkdtemp(join(realTmpdir(), "kimi-home-"));
	mockHomeDir.mockReturnValue(homeDir);
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
});

interface SessionSpec {
	readonly workDirKey?: string;
	readonly sessionId?: string;
	/** Value written to state.json `workDir`. Omit to leave it out. */
	readonly workDir?: string;
	readonly title?: string;
	/** Raw state.json text override (for malformed-JSON cases). */
	readonly rawState?: string;
	/** When true, do NOT write agents/main/wire.jsonl at all. */
	readonly omitTranscript?: boolean;
	/** Milliseconds to subtract from "now" for the transcript mtime (staleness). */
	readonly ageMs?: number;
}

/** Lays down ~/.kimi-code/sessions/<workDirKey>/<sessionId>/{state.json,agents/main/wire.jsonl}. */
async function writeKimiSession(spec: SessionSpec): Promise<string> {
	const workDirKey = spec.workDirKey ?? "wd_repo_0123456789ab";
	const sessionId = spec.sessionId ?? "sess-1";
	const sessionDir = join(homeDir, ".kimi-code", "sessions", workDirKey, sessionId);
	await mkdir(sessionDir, { recursive: true });

	if (spec.rawState !== undefined) {
		await writeFile(join(sessionDir, "state.json"), spec.rawState, "utf-8");
	} else {
		const state: Record<string, unknown> = { createdAt: "2026-08-04T23:43:19.943Z" };
		if (spec.title) state.title = spec.title;
		if (spec.workDir) state.workDir = spec.workDir;
		await writeFile(join(sessionDir, "state.json"), JSON.stringify(state), "utf-8");
	}

	if (!spec.omitTranscript) {
		const transcriptPath = join(sessionDir, "agents", "main", "wire.jsonl");
		await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
		await writeFile(transcriptPath, '{"type":"metadata"}\n', "utf-8");
		if (spec.ageMs) {
			const when = new Date(Date.now() - spec.ageMs);
			await utimes(transcriptPath, when, when);
		}
	}
	return sessionDir;
}

describe("discoverKimiSessions", () => {
	it("returns [] when the Kimi sessions directory does not exist", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		expect(await discoverKimiSessions(repo)).toEqual([]);
		await rm(repo, { recursive: true, force: true });
	});

	it("discovers a session whose state.json workDir matches the repo", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		await writeKimiSession({ workDir: repo, title: "Fix the parser" });

		const sessions = await discoverKimiSessions(repo);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].source).toBe("kimi");
		expect(sessions[0].sessionId).toBe("sess-1");
		expect(sessions[0].title).toBe("Fix the parser");
		expect(sessions[0].transcriptPath).toContain(join("agents", "main", "wire.jsonl"));
		await rm(repo, { recursive: true, force: true });
	});

	it("omits the title when state.json has none", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		await writeKimiSession({ workDir: repo });
		const sessions = await discoverKimiSessions(repo);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].title).toBeUndefined();
		await rm(repo, { recursive: true, force: true });
	});

	it("attributes a session run from a subdirectory of the repo", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		const sub = join(repo, "packages", "foo");
		await mkdir(sub, { recursive: true });
		await writeKimiSession({ workDir: sub });

		const sessions = await discoverKimiSessions(repo);
		expect(sessions).toHaveLength(1);
		await rm(repo, { recursive: true, force: true });
	});

	it("does not attribute a session whose workDir is outside the repo", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		const other = await mkdtemp(join(realTmpdir(), "kimi-other-"));
		await writeKimiSession({ workDir: other });

		expect(await discoverKimiSessions(repo)).toEqual([]);
		await rm(repo, { recursive: true, force: true });
		await rm(other, { recursive: true, force: true });
	});

	it("skips a session whose state.json has no working directory", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		await writeKimiSession({ title: "no cwd here" });
		expect(await discoverKimiSessions(repo)).toEqual([]);
		await rm(repo, { recursive: true, force: true });
	});

	it("skips a session whose transcript is missing", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		await writeKimiSession({ workDir: repo, omitTranscript: true });
		expect(await discoverKimiSessions(repo)).toEqual([]);
		await rm(repo, { recursive: true, force: true });
	});

	it("skips a stale session (transcript older than 48h)", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		await writeKimiSession({ workDir: repo, ageMs: 49 * 60 * 60 * 1000 });
		expect(await discoverKimiSessions(repo)).toEqual([]);
		await rm(repo, { recursive: true, force: true });
	});

	it("ignores a non-directory entry in the sessions tree", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		await writeKimiSession({ workDir: repo });
		// A stray file directly under sessions/ — readdir on it as a dir fails, skipped.
		await writeFile(join(homeDir, ".kimi-code", "sessions", "stray.txt"), "x", "utf-8");
		const sessions = await discoverKimiSessions(repo);
		expect(sessions).toHaveLength(1);
		await rm(repo, { recursive: true, force: true });
	});

	it("skips a session with malformed state.json (no recoverable cwd)", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		await writeKimiSession({ rawState: "{ not json" });
		expect(await discoverKimiSessions(repo)).toEqual([]);
		await rm(repo, { recursive: true, force: true });
	});
});

describe("isKimiInstalled", () => {
	it("is false when ~/.kimi-code is absent", async () => {
		expect(await isKimiInstalled()).toBe(false);
	});

	it("is true when ~/.kimi-code exists", async () => {
		await mkdir(join(homeDir, ".kimi-code"), { recursive: true });
		expect(await isKimiInstalled()).toBe(true);
	});
});

describe("cwdFromState", () => {
	it("reads workDir, then the defensive aliases, and null otherwise", () => {
		expect(cwdFromState({ workDir: "/a/b" })).toBe("/a/b");
		expect(cwdFromState({ cwd: "/c" })).toBe("/c");
		expect(cwdFromState({ root: "/r" })).toBe("/r");
		expect(cwdFromState({ title: "no dir" })).toBeNull();
		expect(cwdFromState({ workDir: "" })).toBeNull();
		expect(cwdFromState(null)).toBeNull();
	});
});

describe("kimiCodeHome", () => {
	const saved = process.env.KIMI_CODE_HOME;
	afterEach(() => {
		if (saved === undefined) delete process.env.KIMI_CODE_HOME;
		else process.env.KIMI_CODE_HOME = saved;
	});

	it("defaults to ~/.kimi-code when KIMI_CODE_HOME is unset", () => {
		delete process.env.KIMI_CODE_HOME;
		expect(kimiCodeHome()).toBe(join(homeDir, ".kimi-code"));
	});

	it("honours KIMI_CODE_HOME when set", () => {
		process.env.KIMI_CODE_HOME = join(homeDir, "relocated-kimi");
		expect(kimiCodeHome()).toBe(join(homeDir, "relocated-kimi"));
	});

	it("discovers sessions under KIMI_CODE_HOME rather than ~/.kimi-code", async () => {
		const repo = await mkdtemp(join(realTmpdir(), "kimi-repo-"));
		const altHome = join(homeDir, "relocated-kimi");
		process.env.KIMI_CODE_HOME = altHome;
		const sessionDir = join(altHome, "sessions", "wd_x", "s1");
		await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
		await writeFile(join(sessionDir, "state.json"), JSON.stringify({ workDir: repo }), "utf-8");
		await writeFile(join(sessionDir, "agents", "main", "wire.jsonl"), '{"type":"metadata"}\n', "utf-8");
		expect(await discoverKimiSessions(repo)).toHaveLength(1);
		await rm(repo, { recursive: true, force: true });
	});
});
